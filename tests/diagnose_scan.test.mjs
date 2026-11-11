import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath,pathToFileURL} from 'node:url';

const project=fileURLToPath(new URL('../',import.meta.url));
test('scanner diagnostic uses only localhost and Binance GET while preserving settings and PNL bytes',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'signal-scan-diagnostic-'));
 try{
  const settings='PORT=34567\nTELEGRAM_BOT_TOKEN=synthetic-secret-must-not-be-reported\n';
  const pnl='{"paper":{"closed":[{"symbol":"XAU","market":"TRADFI","realizedPnLUSD":12.34}]},"journal":[{"note":"preserve"}]}\n';
  await fs.writeFile(path.join(dir,'.env'),settings);await fs.writeFile(path.join(dir,'store.json'),pnl);
  const preload=path.join(dir,'mock.mjs'),audit=path.join(dir,'requests.json');
  await fs.writeFile(preload,`
   import fs from 'node:fs';
   const requests=[];
   globalThis.fetch=async(input,options={})=>{
    const url=new URL(input),method=options.method??'GET';
    if(method!=='GET')throw Error('Unexpected write request');
    requests.push({url:url.href,method});fs.writeFileSync(${JSON.stringify(audit)},JSON.stringify(requests));
    if(url.href==='http://127.0.0.1:34567/api/status')return Response.json({version:'synthetic',scanMode:'BINANCE',researchCount:3,activeCount:3,cycle:1,scanSuccess:2,scanFailed:0,ws:true,liveWS:true});
    if(url.href==='http://127.0.0.1:34567/api/scan/universe')return Response.json({count:2,binance:1,venueOnly:1,rows:[{symbol:'BTCUSDT',chart:'BINANCE',quoteVolume:1e9,marketCap:1e12,analyzed:true,pattern:null,score:80},{symbol:'AKEUSDT',chart:'GATEIO',quoteVolume:2e6,marketCap:4e7,analyzed:false}]});
    if(url.href==='https://fapi.binance.com/fapi/v1/exchangeInfo')return Response.json({symbols:[{symbol:'BTCUSDT'}]});
    throw Error('Unexpected public data destination');
   };
  `);
  const env={PATH:process.env.PATH,SIGNAL_LAB_DATA_DIR:dir,SIGNAL_LAB_REPORT_DIR:dir};if(process.env.SystemRoot)env.SystemRoot=process.env.SystemRoot;
  const run=spawnSync(process.execPath,['--import',pathToFileURL(preload).href,'diagnose_scan.mjs'],{cwd:project,env,encoding:'utf8',timeout:30000});
  assert.equal(run.error,undefined);assert.equal(run.status,0);assert.equal(run.stderr,'');
  assert.deepEqual(JSON.parse(await fs.readFile(audit,'utf8')),[{url:'http://127.0.0.1:34567/api/status',method:'GET'},{url:'http://127.0.0.1:34567/api/scan/universe',method:'GET'},{url:'https://fapi.binance.com/fapi/v1/exchangeInfo',method:'GET'}]);
  const csv=await fs.readFile(path.join(dir,'scan_universe.csv'),'utf8');assert.match(csv,/AKEUSDT,GATEIO,2000000,40000000/);assert.match(csv,/BTCUSDT,BINANCE/);
  assert.equal(await fs.readFile(path.join(dir,'.env'),'utf8'),settings);assert.equal(await fs.readFile(path.join(dir,'store.json'),'utf8'),pnl);
  const report=await fs.readFile(path.join(dir,'scanner_diagnostics.txt'),'utf8');
  assert.match(report,/Binance PERP 3/);assert.match(report,/Binance 선물: HTTP 200/);
  assert.doesNotMatch(report+run.stdout,/synthetic-secret-must-not-be-reported|realizedPnLUSD|preserve/);
 }finally{await fs.rm(dir,{recursive:true,force:true,maxRetries:8,retryDelay:50})}
});
