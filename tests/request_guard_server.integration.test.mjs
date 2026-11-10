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
// Node's fetch always rewrites Host, so a DNS-rebinding Host header needs node:http.
function rawRequest({port,method='GET',path:target='/',headers={},body,timeoutMs=4000}){
 return new Promise((resolve,reject)=>{
  const req=http.request({host:'127.0.0.1',port,method,path:target,headers,timeout:timeoutMs},res=>{
   let data='';res.setEncoding('utf8');res.on('data',chunk=>data+=chunk);
   res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:data}));
  });
  req.on('timeout',()=>req.destroy(Error('LOCAL_REQUEST_TIMEOUT')));req.on('error',reject);
  if(body!==undefined)req.write(body);req.end();
 });
}

test('local server refuses rebinding hosts and cross-site writes, and reports malformed bodies as client errors',{timeout:30000},async(t)=>{
 const port=await freePort(),sandbox=await fs.mkdtemp(path.join(os.tmpdir(),'request-guard-'));
 await fs.cp(project,sandbox,{recursive:true,filter:src=>!['.env','.git','node_modules','.updates','store.json','scanner_diagnostics.txt'].includes(path.basename(src))});
 const child=trackChild(spawn(process.execPath,['--import','./tests/mock_runtime.mjs','server.mjs'],{
  cwd:sandbox,env:{...process.env,SIGNAL_LAB_DATA_DIR:path.join(sandbox,'persistent-data'),PORT:String(port),HOST:'127.0.0.1',AUTO_UPDATE:'false',
   UPDATE_MANIFEST_URL:'',TELEGRAM_NEWS_ALERTS:'false',TELEGRAM_BOT_TOKEN:'',TELEGRAM_CHAT_ID:'',TWELVE_DATA_API_KEY:'',ALLOWED_HOSTS:''},stdio:'pipe'}));
 let logs='';child.stdout.on('data',d=>logs+=d);child.stderr.on('data',d=>logs+=d);
 const base=`http://127.0.0.1:${port}`,sameOrigin={origin:base,'sec-fetch-site':'same-origin'};
 const request=(target,options={})=>fetchLocal(base+target,{...options,signal:t.signal});
 const setting=async()=>(await(await request('/api/paper/notifications')).json()).enabled;
 try{
  let ready=false;
  for(let i=0;i<100&&!ready;i++){t.signal.throwIfAborted();await nap(80);try{ready=(await request('/api/status')).ok}catch{}}
  assert.ok(ready,logs);
  assert.equal(await setting(),true);

  // DNS rebinding: the page's own name reaches 127.0.0.1, but Host still carries it.
  const rebound=await rawRequest({port,path:'/api/paper',headers:{host:`attacker.example:${port}`}});
  assert.equal(rebound.status,403);assert.equal(JSON.parse(rebound.body).error,'HOST_NOT_ALLOWED');
  assert.equal((await rawRequest({port,path:'/api/status',headers:{host:`localhost:${port}`}})).status,200);

  // Cross-site "simple" POST needs no CORS preflight: it must be refused and change nothing.
  const forged=await request('/api/paper/notifications/settings',{method:'POST',headers:{origin:'https://attacker.example','content-type':'text/plain'},body:JSON.stringify({enabled:false})});
  assert.equal(forged.status,403);assert.equal((await forged.json()).error,'CROSS_SITE_REQUEST_BLOCKED');
  assert.equal(await setting(),true,'cross-site request changed a setting');
  const crossRead=await request('/api/journal',{headers:{'sec-fetch-site':'cross-site'}});
  assert.equal(crossRead.status,403);await crossRead.arrayBuffer();

  // The dashboard's own requests (same origin) and non-browser clients still work.
  const own=await request('/api/paper/notifications/settings',{method:'POST',headers:{...sameOrigin,'content-type':'application/json'},body:JSON.stringify({enabled:false})});
  assert.equal(own.status,200,await own.clone().text());assert.equal((await own.json()).enabled,false);
  assert.equal(await setting(),false);

  // Malformed input is the caller's error (4xx), not an upstream failure (502).
  for(const [body,status] of [['not json',400],['[]',400],['null',400],['x'.repeat(40000),413]]){
   const bad=await rawRequest({port,method:'POST',path:'/api/paper/notifications/settings',
    headers:{host:`127.0.0.1:${port}`,...sameOrigin,'content-type':'application/json','content-length':Buffer.byteLength(body)},body});
   assert.equal(bad.status,status,`${body.slice(0,12)} -> ${bad.status} ${bad.body}`);
  }
  assert.equal(await setting(),false,'rejected bodies left the setting untouched');

  // Pages and API responses refuse framing and MIME sniffing.
  for(const target of ['/','/api/status']){
   const page=await request(target);await page.arrayBuffer();
   assert.equal(page.headers.get('x-frame-options'),'DENY',target);
   assert.equal(page.headers.get('x-content-type-options'),'nosniff',target);
  }
  assert.ok((await request('/api/status')).ok,'server keeps serving after refused and malformed requests');
 }finally{await stopChild(child);await fs.rm(sandbox,{recursive:true,force:true,maxRetries:8,retryDelay:100})}
});
