import {fetchLocal} from './helpers/http_request.mjs';
import {trackChild,stopChild} from './helpers/child_process.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';

const project=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const nap=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function freePort(){
 const server=net.createServer();server.listen(0,'127.0.0.1');await once(server,'listening');
 const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port;
}


test('disk failure returns HTTP 503, rolls back settings, exposes unhealthy storage, and recovers without losing records',{timeout:15000},async(t)=>{
 const request=(input,options={})=>fetchLocal(input,{...options,signal:t.signal});
 const sandbox=await fs.mkdtemp(path.join(os.tmpdir(),'signal-storage-http-'));
 const app=path.join(sandbox,'app'),dataDir=path.join(sandbox,'isolated-data');
 const flag=path.join(sandbox,'fail-store'),control=path.join(sandbox,'market-control.json');
 let child;
 try{
  // Copy source files by an explicit selection, never .env, store.json, .git or user directories.
  await fs.mkdir(path.join(app,'tests','fixtures'),{recursive:true});await fs.mkdir(path.join(app,'public'));await fs.mkdir(dataDir);
  const sources=(await fs.readdir(project)).filter(name=>name.endsWith('.mjs')||name==='package.json');
  await Promise.all(sources.map(name=>fs.copyFile(path.join(project,name),path.join(app,name))));
  for(const name of ['trade_plan.js','symbol_display.js','scalp_reasons.js'])await fs.copyFile(path.join(project,'public',name),path.join(app,'public',name));
  for(const name of ['mock_pipeline.mjs','mock_storage_failure.mjs'])await fs.copyFile(path.join(project,'tests',name),path.join(app,'tests',name));
  await fs.copyFile(path.join(project,'tests','fixtures','pipeline_market.mjs'),path.join(app,'tests','fixtures','pipeline_market.mjs'));
  const oldTrade={key:'historical-pnl-must-survive',realizedPnLUSD:12.5,feesUSD:.5,closedAt:Date.now()-86400000};
  await fs.writeFile(path.join(dataDir,'store.json'),JSON.stringify({paper:{pending:[],open:[],closed:[oldTrade],skipped:[],seen:{}},paperNotify:{enabled:true,history:[]},journal:[],alerts:[],watchlist:[],seen:{},newsSeen:{}}));
  await fs.writeFile(control,JSON.stringify({scenarios:{BTCUSDT:'range'},emit:false}));
  const port=await freePort(),base='http://127.0.0.1:'+port;
  child=trackChild(spawn(process.execPath,['--import','./tests/mock_storage_failure.mjs','server.mjs'],{
   cwd:app,env:{PATH:process.env.PATH,PORT:String(port),HOST:'127.0.0.1',SIGNAL_LAB_DATA_DIR:dataDir,
    SIGNAL_LAB_TEST_CONTROL:control,SIGNAL_LAB_TEST_STORAGE_FAIL_FLAG:flag,AUTO_UPDATE:'false',TELEGRAM_NEWS_ALERTS:'false',
    TELEGRAM_BOT_TOKEN:'',TELEGRAM_CHAT_ID:'',TWELVE_DATA_API_KEY:'',...(process.env.SystemRoot?{SystemRoot:process.env.SystemRoot}:{})},stdio:['ignore','ignore','pipe']
  }));
  let errors='';child.stderr.on('data',chunk=>{errors=(errors+String(chunk)).slice(-4000)});
  const get=async route=>{const response=await request(base+route);assert.equal(response.status,200,route);return response.json()};
  const post=async body=>{const response=await request(base+'/api/paper/notifications/settings',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});return {status:response.status,body:await response.json()}};
  let ready=false;
  for(let i=0;i<100;i++){t.signal.throwIfAborted();try{if((await get('/api/paper/notifications')).enabled===true){ready=true;break}}catch{}await nap(50)}
  assert.equal(ready,true,'isolated server must start before injecting the disk failure: '+errors);
  const disk=()=>fs.readFile(path.join(dataDir,'store.json'),'utf8').then(JSON.parse);
  const initial=await disk();assert.equal(initial.paperNotify.enabled,true);assert.equal((await get('/api/storage')).healthy,true);

  await fs.writeFile(flag,'fail');
  const failed=await post({enabled:false});assert.equal(failed.status,503);assert.match(failed.body.error,/저장 실패/);
  assert.equal((await get('/api/paper/notifications')).enabled,true,'failed change must roll back in memory');
  assert.equal((await disk()).paperNotify.enabled,true,'failed change must leave disk untouched');
  const unhealthy=await get('/api/storage');assert.equal(unhealthy.persistent,false);assert.equal(unhealthy.healthy,false);
  assert.equal((await get('/api/status')).storage.healthy,false);assert.equal((await get('/api/paper')).storage.healthy,false);
  assert.deepEqual((await disk()).paper.closed,initial.paper.closed,'historical PNL must survive the failed save');

  await fs.rm(flag);
  assert.equal((await post({enabled:false})).status,200);
  assert.equal((await get('/api/paper/notifications')).enabled,false);assert.equal((await disk()).paperNotify.enabled,false);
  const healthy=await get('/api/storage');assert.equal(healthy.healthy,true);assert.equal(healthy.persistent,true);assert.equal(healthy.error,'');
  assert.equal((await get('/api/status')).storage.healthy,true);
  assert.deepEqual((await disk()).paper.closed,initial.paper.closed);
 }finally{await stopChild(child);await fs.rm(sandbox,{recursive:true,force:true,maxRetries:8,retryDelay:100})}
});
