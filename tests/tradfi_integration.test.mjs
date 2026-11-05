import {fetchLocal} from './helpers/http_request.mjs';
import {trackChild,stopChild} from './helpers/child_process.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import net from 'node:net';
import {once} from 'node:events';
import path from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import fs from 'node:fs/promises';
import os from 'node:os';
const project=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
async function freePort(){const s=net.createServer();s.listen(0,'127.0.0.1');await once(s,'listening');const port=s.address().port;await new Promise(r=>s.close(r));return port}
const nap=ms=>new Promise(r=>setTimeout(r,ms));
test('Disabled TradFi API preserves old open/pending/closed records, settings and backups without provider connections',{timeout:20000},async(t)=>{
 const request=(input,options={})=>fetchLocal(input,{...options,signal:t.signal});
 const port=await freePort(),sandbox=await fs.mkdtemp(path.join(os.tmpdir(),'tradfi-disabled-test-'));
 await fs.cp(project,sandbox,{recursive:true,filter:src=>!['.env','.git','node_modules','.updates','store.json','scanner_diagnostics.txt'].includes(path.basename(src))});
 const data=path.join(sandbox,'persistent-data');await fs.mkdir(data);
 const now=Date.now();
 const historical={market:'TRADFI',symbol:'XAU-SWAP',direction:'LONG',managementVersion:'LEGACY_R_MULTIPLES',
  pattern:'preserved fixture',barAt:now-3600000,entryFill:4000,entry:4000,stop:3900,targets:[4200,4300,4400],
  notionalUSD:250,qty:.0625,qtyRemaining:.0625,openedAt:now-600000,lastPriceAt:now-600000,markPrice:4000,
  realizedPnLUSD:0,realizedGrossUSD:0,feesUSD:0,closeParts:[]};
 const pending={...historical,key:'historical-pending',createdAt:now-86400000,expiresAt:now-60000};
 const closed={...historical,key:'historical-closed',closedAt:now-600000,realizedPnLUSD:12.34,qtyRemaining:0};
 const old={paper:{pending:[pending],open:[{...historical,key:'historical-open'}],closed:[closed],skipped:[],seen:{}},
  watchlist:[],journal:[{id:'preserve-journal',symbol:'XAU-SWAP',pnl:12.34}],tradfiSeen:{'old-dedup':now},
  paperSettings:{TP1_MOVE_STOP_TO_BREAKEVEN:false},customLegacyField:{retained:true}};
 await fs.writeFile(path.join(data,'store.json'),JSON.stringify(old));
 const envContents='TRADFI_REFRESH_MS=1000\nTWELVE_DATA_API_KEY=fixture-not-a-real-key\n';
 await fs.writeFile(path.join(data,'.env'),envContents);
 const requestLog=path.join(sandbox,'unexpected-provider-requests.jsonl');
 const guard=path.join(sandbox,'tests','disabled-tradfi-guard.mjs');
 await fs.writeFile(guard,`import './mock_runtime.mjs';\nimport fs from 'node:fs';\nconst previous=globalThis.fetch;\nglobalThis.fetch=(input,options)=>{const url=String(input),host=new URL(url).hostname;if(!['fapi.binance.com','api.telegram.org','decrypt.co','www.coindesk.com','cointelegraph.com','search.cnbc.com','www.cnbc.com'].includes(host)){fs.appendFileSync(${JSON.stringify(requestLog)},JSON.stringify({host})+'\\n');throw Error('Unexpected provider request')}return previous(input,options)};\n`);
 let child;
 try{
  const launch=()=>{
   const processHandle=trackChild(spawn(process.execPath,['--import',pathToFileURL(guard).href,'server.mjs'],{cwd:sandbox,env:{...process.env,
    SIGNAL_LAB_DATA_DIR:data,PORT:String(port),HOST:'127.0.0.1',AUTO_UPDATE:'false',TELEGRAM_BOT_TOKEN:'',TELEGRAM_CHAT_ID:'',
    TELEGRAM_NEWS_ALERTS:'false',ORANGEX_ENABLED:'false',ORANGEX_MODE:'READ_ONLY',SIGNAL_LAB_OPEN_BROWSER:'0'},stdio:'pipe'}));
   let logs='';processHandle.stdout.on('data',d=>logs+=d);processHandle.stderr.on('data',d=>logs+=d);return {processHandle,logs:()=>logs};
  };
  for(let pass=0;pass<2;pass++){
   const launched=launch();child=launched.processHandle;
   let doc;
   for(let i=0;i<100;i++){
    t.signal.throwIfAborted();
    await nap(60);try{doc=await(await request(`http://127.0.0.1:${port}/api/tradfi`)).json()}catch{}
    if(doc?.status==='disabled')break;
   }
   assert.equal(doc?.status,'disabled',launched.logs());assert.equal(doc.enabled,false);assert.equal(doc.provider,null);
   assert.equal(doc.paperEntryEnabled,false);assert.deepEqual(doc.swaps,[]);assert.deepEqual(doc.patterns,[]);
   assert.deepEqual(doc.retainedRecords,{open:1,pending:1,closed:1});
   const refresh=await request(`http://127.0.0.1:${port}/api/tradfi/refresh`,{method:'POST'});
   assert.equal(refresh.status,409);const rejected=await refresh.json();assert.equal(rejected.accepted,false);
   assert.equal(rejected.reasonCode,'TRADFI_PROVIDER_UNAVAILABLE');
   // Longer than the removed initial TradFi scheduler delay, then explicitly
   // verify timeout processing cannot discard the disabled pending record.
   await nap(pass===0?2700:100);
   const paper=await(await request(`http://127.0.0.1:${port}/api/paper`)).json();
   assert.deepEqual(paper.open,[old.paper.open[0]]);assert.deepEqual(paper.pending,[pending]);assert.deepEqual(paper.closed,[closed]);
   assert.equal(paper.monitor.tradfiStatus,'disabled');assert.equal(paper.monitor.state,'DELAYED');
   await stopChild(child);child=null;
   const stored=JSON.parse(await fs.readFile(path.join(data,'store.json'),'utf8'));
   assert.deepEqual(stored.paper,old.paper);assert.deepEqual(stored.journal,old.journal);
   assert.deepEqual(stored.tradfiSeen,old.tradfiSeen);assert.deepEqual(stored.paperSettings,old.paperSettings);
   assert.deepEqual(stored.customLegacyField,old.customLegacyField);assert.equal(await fs.readFile(path.join(data,'.env'),'utf8'),envContents);
  }
  let unexpected='';try{unexpected=await fs.readFile(requestLog,'utf8')}catch(error){if(error.code!=='ENOENT')throw error}assert.equal(unexpected,'','unexpected provider requests: '+unexpected);
  const backups=(await fs.readdir(data)).filter(x=>x.includes('backup'));
  assert.ok(backups.length>0,'existing startup backup behavior remains available');
 }finally{if(child)await stopChild(child);await fs.rm(sandbox,{recursive:true,force:true,maxRetries:8,retryDelay:100})}
});
