import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {marketSeries,ENTRY} from './fixtures/pipeline_market.mjs';
const project=fileURLToPath(new URL('../',import.meta.url));
const market=base=>({symbol:base+'USDT',baseAsset:base,quoteAsset:'USDT',contractType:'PERPETUAL',status:'TRADING'});

async function check(mode){
 // Exercise file-URL encoding on every CLI check, including Windows drive paths.
 const sandbox=await fs.mkdtemp(path.join(os.tmpdir(),'signal-public-data-한글 # % + '));
 try{
  const series=marketSeries('breakout-long');
  const rows={exchangeInfo:{symbols:[market('BTC'),market('ETH')]},tickers:[{symbol:'BTCUSDT',lastPrice:String(ENTRY),quoteVolume:'100000000'},{symbol:'ETHUSDT',lastPrice:'100',quoteVolume:'100000000'}],
   stats:{listings:[{ticker:'BTC-PERP',contract_type:'perpetual',mark_price:String(ENTRY)},{ticker:'ETH-PERP',contract_type:'perpetual',mark_price:'100'}]},h1:series.h1,h4:series.h4};
  const preload=path.join(sandbox,'mock.mjs');
  await fs.writeFile(preload,`
   const mode=${JSON.stringify(mode)},rows=${JSON.stringify(rows)};
   globalThis.fetch=async(input,options)=>{
    if(options?.method!=='GET')throw Error('Only public read-only GET is allowed');
    const url=new URL(input);
    if(mode==='network')throw Object.assign(Error('synthetic network failure'),{cause:{code:'EAI_AGAIN'}});
    if(mode==='json')return new Response('invalid JSON');
    let data;
    if(url.pathname.endsWith('exchangeInfo'))data=mode==='bad-schema'?{symbols:'not-an-array'}:mode==='empty'?{symbols:[]}:rows.exchangeInfo;
    else if(url.pathname.endsWith('24hr'))data=mode==='missing-btc'?rows.tickers.filter(row=>row.symbol!=='BTCUSDT'):rows.tickers;
    else if(url.pathname.endsWith('klines'))data=url.searchParams.get('interval')==='1h'?rows.h1:rows.h4;
    else if(url.pathname==='/metadata/v2/stats')data=rows.stats;
    else throw Error('Unexpected endpoint');
    return new Response(JSON.stringify(data),{headers:{'content-type':'application/json'}});
   };
  `);
  const env={PATH:process.env.PATH};
  if(process.env.SystemRoot)env.SystemRoot=process.env.SystemRoot;
  const result=spawnSync(process.execPath,['--import',pathToFileURL(preload).href,'scripts/check-market-data.mjs'],{cwd:project,env,encoding:'utf8',timeout:5000});
  assert.equal(result.error,undefined);assert.equal(result.stderr,'','validation errors must be reported as structured results, not an uncaught stack');
  return {code:result.status,report:JSON.parse(result.stdout)};
 }finally{await fs.rm(sandbox,{recursive:true,force:true})}
}

test('public market smoke reports a valid synthetic response separately from real connectivity',async()=>{
 const {code,report}=await check('valid');assert.equal(code,0);assert.equal(report.status,'passed');assert.equal(report.validationPassed,true);
});
for(const mode of ['bad-schema','empty','json','missing-btc'])test(`public market smoke returns data failure 1 for ${mode}`,async()=>{
 const {code,report}=await check(mode);assert.equal(code,1);assert.equal(report.status,'failed');assert.equal(report.validationPassed,false);
});
test('public market smoke reserves blocked 2 for unavailable transport',async()=>{
 const {code,report}=await check('network');assert.equal(code,2);assert.equal(report.status,'blocked');assert.equal(report.validationPassed,false);
 assert.ok(report.checks.every(row=>row.failureType==='transport'&&row.errorCode==='EAI_AGAIN'));
});
