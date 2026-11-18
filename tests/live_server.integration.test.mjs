import {fetchLocal} from './helpers/http_request.mjs';
import {trackChild,stopChild} from './helpers/child_process.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import net from 'node:net';
import {once} from 'node:events';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import fs from 'node:fs/promises';
import os from 'node:os';
const project=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
async function freePort(){const socket=net.createServer();socket.listen(0,'127.0.0.1');await once(socket,'listening');const port=socket.address().port;await new Promise(resolve=>socket.close(resolve));return port}
const nap=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const SECRETS=['bingxKEYvalue0123456789abcdef','bingxSECRETvalue0123456789abcdef','gateKEYvalue0123456789abcdef','gateSECRETvalue0123456789abcdef'];

async function boot(t,extraEnv){
 const port=await freePort(),sandbox=await fs.mkdtemp(path.join(os.tmpdir(),'live-server-'));
 await fs.cp(project,sandbox,{recursive:true,filter:src=>!['.env','.git','node_modules','.updates','store.json','scanner_diagnostics.txt'].includes(path.basename(src))});
 const env={...process.env,SIGNAL_LAB_DATA_DIR:path.join(sandbox,'data'),PORT:String(port),HOST:'127.0.0.1',AUTO_UPDATE:'false',UPDATE_MANIFEST_URL:'',
  TELEGRAM_NEWS_ALERTS:'false',TELEGRAM_BOT_TOKEN:'',TELEGRAM_CHAT_ID:'',TWELVE_DATA_API_KEY:'',...extraEnv};
 const child=trackChild(spawn(process.execPath,['--import','./tests/mock_runtime.mjs','server.mjs'],{cwd:sandbox,env,stdio:'pipe'}));
 let logs='';child.stdout.on('data',d=>logs+=d);child.stderr.on('data',d=>logs+=d);
 const base=`http://127.0.0.1:${port}`,request=(target,options={})=>fetchLocal(base+target,{...options,signal:t.signal});
 let ready=false;for(let i=0;i<100&&!ready;i++){await nap(80);try{const r=await request('/api/status');await r.arrayBuffer();ready=r.ok}catch{}}
 assert.ok(ready,logs);
 return {request,base,logs:()=>logs,async close(){await stopChild(child);await fs.rm(sandbox,{recursive:true,force:true,maxRetries:8,retryDelay:100})}};
}
const post=(app,target,body,headers={})=>app.request(target,{method:'POST',headers:{'content-type':'application/json',origin:app.base,'sec-fetch-site':'same-origin',...headers},body:JSON.stringify(body)});

test('live control: OFF by default; testnet needs an explicit arm; secrets never leave the server',{timeout:40000},async(t)=>{
 const off=await boot(t,{});
 try{
  const s=await(await off.request('/api/live')).json();
  assert.equal(s.mode,'OFF');assert.equal(s.armed,false);assert.deepEqual(s.credentialsConfigured,{BINGX:false,GATEIO:false});
  const arm=await post(off,'/api/live/arm',{confirm:'ARM'});assert.equal(arm.status,409);assert.equal((await arm.json()).error,'LIVE_MODE_OFF');
 }finally{await off.close()}

 const app=await boot(t,{LIVE_TRADING_MODE:'TESTNET',TESTNET_SIGNAL_ENTRIES:'on',BINGX_API_KEY:SECRETS[0],BINGX_API_SECRET:SECRETS[1],GATEIO_API_KEY:SECRETS[2],GATEIO_API_SECRET:SECRETS[3]});
 try{
  const first=await app.request('/api/live'),text=await first.text(),s=JSON.parse(text);
  assert.equal(s.mode,'TESTNET');assert.deepEqual(s.credentialsConfigured,{BINGX:true,GATEIO:true});assert.equal(s.armed,false,'never armed at start');
  for(const secret of SECRETS)assert.ok(!text.includes(secret),'status never contains a key');
  const statusText=await(await app.request('/api/status')).text();for(const secret of SECRETS)assert.ok(!statusText.includes(secret));
  assert.equal(JSON.parse(statusText).live.mode,'TESTNET');

  const forged=await post(app,'/api/live/arm',{confirm:'ARM'},{origin:'https://attacker.example','sec-fetch-site':'cross-site'});
  assert.equal(forged.status,403,'another website cannot arm live trading');await forged.arrayBuffer();
  const noConfirm=await post(app,'/api/live/arm',{});assert.equal(noConfirm.status,400);await noConfirm.arrayBuffer();
  const armed=await(await post(app,'/api/live/arm',{confirm:'ARM'})).json();assert.equal(armed.armed,true);
  const killed=await(await post(app,'/api/live/kill',{})).json();assert.equal(killed.killSwitch,true);assert.equal(killed.armed,false);
  const rearm=await post(app,'/api/live/arm',{confirm:'ARM'});assert.equal(rearm.status,409);await rearm.arrayBuffer();
  const reset=await post(app,'/api/live/reset-kill',{});assert.equal(reset.status,400);await reset.arrayBuffer();
  assert.equal((await(await post(app,'/api/live/reset-kill',{confirm:'RESET'})).json()).killSwitch,false);
  for(const secret of SECRETS)assert.ok(!app.logs().includes(secret),'server output never contains a key');
 }finally{await app.close()}

 const live=await boot(t,{LIVE_TRADING_MODE:'LIVE'});
 try{const r=await post(live,'/api/live/arm',{confirm:'ARM'});assert.equal(r.status,409);assert.equal((await r.json()).error,'LIVE_CONFIRM_MISSING')}
 finally{await live.close()}
});
