import {fetchLocal} from './helpers/http_request.mjs';
import {trackChild,stopChild} from './helpers/child_process.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
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
function statusFor(port,host){
 return new Promise((resolve,reject)=>{
  const req=http.request({host:'127.0.0.1',port,path:'/api/status',headers:{host},timeout:4000},res=>{res.resume();res.on('end',()=>resolve(res.statusCode))});
  req.on('timeout',()=>req.destroy(Error('LOCAL_REQUEST_TIMEOUT')));req.on('error',reject);req.end();
 });
}

test('.env values edited with trailing blanks (Windows Notepad, CRLF) still start the server as typed',{timeout:30000},async(t)=>{
 const port=await freePort(),sandbox=await fs.mkdtemp(path.join(os.tmpdir(),'env-file-'));
 await fs.cp(project,sandbox,{recursive:true,filter:src=>!['.env','.git','node_modules','.updates','store.json','scanner_diagnostics.txt'].includes(path.basename(src))});
 const data=path.join(sandbox,'persistent-data');await fs.mkdir(data,{recursive:true});
 // Before trimming, "HOST=127.0.0.1   " made listen() fail with ENOTFOUND and the
 // quoted ALLOWED_HOSTS kept its closing quote.
 await fs.writeFile(path.join(data,'.env'),`HOST=127.0.0.1   \r\nPORT=${port}  \r\nALLOWED_HOSTS="signal.lan"  \r\n`);
 const env={...process.env,SIGNAL_LAB_DATA_DIR:data,AUTO_UPDATE:'false',UPDATE_MANIFEST_URL:'',TELEGRAM_NEWS_ALERTS:'false',TELEGRAM_BOT_TOKEN:'',TELEGRAM_CHAT_ID:'',TWELVE_DATA_API_KEY:''};
 for(const key of ['HOST','PORT','ALLOWED_HOSTS'])delete env[key];
 const child=trackChild(spawn(process.execPath,['--import','./tests/mock_runtime.mjs','server.mjs'],{cwd:sandbox,env,stdio:'pipe'}));
 let logs='';child.stdout.on('data',d=>logs+=d);child.stderr.on('data',d=>logs+=d);
 try{
  let ready=false;
  for(let i=0;i<100&&!ready;i++){t.signal.throwIfAborted();await nap(80);
   try{const response=await fetchLocal(`http://127.0.0.1:${port}/api/status`,{signal:t.signal});await response.arrayBuffer();ready=response.ok}catch{}}
  assert.ok(ready,logs);
  assert.equal(await statusFor(port,`signal.lan:${port}`),200,'quoted ALLOWED_HOSTS value is used without its quotes');
  assert.equal(await statusFor(port,`other.lan:${port}`),403);
 }finally{await stopChild(child);await fs.rm(sandbox,{recursive:true,force:true,maxRetries:8,retryDelay:100})}
});

test('shared records + per-PC settings: the shared .env seeds this PC once, PCs and conflict copies are reported',{timeout:30000},async(t)=>{
 const port=await freePort(),sandbox=await fs.mkdtemp(path.join(os.tmpdir(),'env-shared-'));
 await fs.cp(project,sandbox,{recursive:true,filter:src=>!['.env','.git','node_modules','.updates','store.json','scanner_diagnostics.txt'].includes(path.basename(src))});
 const shared=path.join(sandbox,'OneDrive','SignalLabData'),local=path.join(sandbox,'LocalAppData','SignalLab');await fs.mkdir(shared,{recursive:true});
 await fs.writeFile(path.join(shared,'.env'),`HOST=127.0.0.1\r\nPORT=${port}\r\n`);
 await fs.writeFile(path.join(shared,'pcs.json'),JSON.stringify({hosts:{'OTHER-PC':{firstAt:1,lastAt:2,starts:1}}}));
 await fs.writeFile(path.join(shared,'store-OTHER-PC.json'),'{}');
 const env={...process.env,SIGNAL_LAB_DATA_DIR:shared,SIGNAL_LAB_ENV_DIR:local,AUTO_UPDATE:'false',UPDATE_MANIFEST_URL:'',TELEGRAM_NEWS_ALERTS:'false',TELEGRAM_BOT_TOKEN:'',TELEGRAM_CHAT_ID:'',TWELVE_DATA_API_KEY:''};
 for(const key of ['HOST','PORT','ALLOWED_HOSTS'])delete env[key];
 const child=trackChild(spawn(process.execPath,['--import','./tests/mock_runtime.mjs','server.mjs'],{cwd:sandbox,env,stdio:'pipe'}));
 let logs='';child.stdout.on('data',d=>logs+=d);child.stderr.on('data',d=>logs+=d);
 try{
  let status=null;
  for(let i=0;i<100&&!status;i++){t.signal.throwIfAborted();await nap(80);
   try{const response=await fetchLocal(`http://127.0.0.1:${port}/api/status`,{signal:t.signal});if(response.ok)status=await response.json();else await response.arrayBuffer()}catch{}}
  assert.ok(status,'server listens on the PORT from the seeded local .env\n'+logs);
  assert.equal(await fs.readFile(path.join(local,'.env'),'utf8'),`HOST=127.0.0.1\r\nPORT=${port}\r\n`);
  assert.equal(status.sharedData.separateEnv,true);assert.equal(status.sharedData.sharedEnvLeft,true);
  assert.deepEqual(status.sharedData.conflicts,['store-OTHER-PC.json']);
  assert.deepEqual(status.sharedData.pcs.map(p=>[p.host,p.current]),[[os.hostname(),true],['OTHER-PC',false]]);
  assert.match(logs,/공유\(OneDrive\) 폴더에 \.env가 남아 있습니다/);assert.match(logs,/OneDrive 충돌 사본 발견 → store-OTHER-PC\.json/);
 }finally{await stopChild(child);await fs.rm(sandbox,{recursive:true,force:true,maxRetries:8,retryDelay:100})}
});
