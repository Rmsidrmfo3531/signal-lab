import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn,execFile} from 'node:child_process';
import net from 'node:net';
import {once} from 'node:events';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import fs from 'node:fs/promises';
import os from 'node:os';
import {promisify} from 'node:util';
const project=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const run=promisify(execFile);
function track(child){
 const owned={child,didClose:false,error:null};
 // Capture close at spawn time, before a fast failure or shutdown can emit it.
 // exit alone does not prove that the process's stdio handles have closed.
 owned.closed=new Promise(resolve=>child.once('close',(code,signal)=>{owned.didClose=true;resolve({code,signal})}));
 child.once('error',error=>{owned.error=error});
 return owned;
}
async function closedWithin(owned,ms){
 let timer;
 try{return await Promise.race([owned.closed.then(()=>true),new Promise(resolve=>{timer=setTimeout(()=>resolve(false),ms)})])}
 finally{clearTimeout(timer)}
}
async function stop(owned){
 if(!owned)return;
 const child=owned.child;
 if(owned.didClose){await owned.closed;return}
 const running=()=>child.exitCode===null&&child.signalCode===null;
 let treeFailure;
 if(running()){
  if(process.platform==='win32'){
   // The real notifier starts detached PowerShell with this sandbox as cwd.
   // Kill the owned tree while its server PID still exists; killing Node first
   // would orphan PowerShell and leave the temporary directory locked for 8s.
   try{await run('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,timeout:5000})}
   catch(error){if(running())treeFailure=error}
  }else child.kill('SIGTERM');
 }
 if(!await closedWithin(owned,2500)){
  if(running())child.kill('SIGKILL');
  if(!await closedWithin(owned,5000))throw Error('Owned notification-test server did not close after shutdown');
 }
 if(treeFailure)throw Error('Could not terminate the owned Windows notification process tree: '+treeFailure.message);
}
async function port(){const server=net.createServer();server.listen(0,'127.0.0.1');await once(server,'listening');const p=server.address().port;await new Promise(r=>server.close(r));return p}
test('paper notification API: get/toggle/test/store history without synthetic position creation', {timeout:30000},async()=>{
 const sandbox=await fs.mkdtemp(path.join(os.tmpdir(),'paper-notice-'));const p=await port();
 await fs.cp(project,sandbox,{recursive:true,filter:src=>path.basename(src)!=='.env'});
 const dataDir=path.join(sandbox,'userdata');
 let owned;
 const launch=()=>{
  assert.ok(!owned||owned.didClose,'the previous server must completely close before restart');
  owned=track(spawn(process.execPath,['--import','./tests/mock_runtime.mjs','server.mjs'],{cwd:sandbox,env:{...process.env,PORT:String(p),HOST:'127.0.0.1',SIGNAL_LAB_DATA_DIR:dataDir,AUTO_UPDATE:'false',TELEGRAM_NEWS_ALERTS:'false'},stdio:'ignore'}));
 };
 const base=`http://127.0.0.1:${p}`;
 const get=async(url)=>{const r=await fetch(base+url);return r.json()};
 const post=async(url,body)=>{const r=await fetch(base+url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});return {status:r.status,body:await r.json()}};
 try{
  launch();let ok=false;
  for(let i=0;i<80;i++){await sleep(70);try{const r=await get('/api/paper/notifications');if(r.enabled===true){ok=true;break}}catch{}}
  assert.equal(ok,true,'server failed to start');
  let prefs=await get('/api/paper/notifications');assert.deepEqual(prefs.history,[]);
  assert.equal((await post('/api/paper/notifications/settings',{enabled:'no'})).status,400);
  assert.equal((await post('/api/paper/notifications/settings',{enabled:false})).status,200);
  assert.equal((await post('/api/paper/notifications/test',{})).status,409);
  assert.equal((await post('/api/paper/notifications/settings',{enabled:true})).status,200);
  const testNotice=await post('/api/paper/notifications/test',{});
  assert.equal(testNotice.status,200);assert.equal(testNotice.body.event.test,true);
  assert.equal(testNotice.body.delivery.queued,process.platform==='win32');
  const closeTest=await post('/api/paper/notifications/test',{type:'CLOSE'});
  assert.equal(closeTest.status,200);assert.equal(closeTest.body.event.type,'CLOSE');
  assert.equal(closeTest.body.event.realizedPnLUSD,3.52);
  prefs=await get('/api/paper/notifications');assert.deepEqual(prefs.history,[],'test must not fabricate a trade');
  assert.equal((await get('/api/paper')).closedCount,0);
  const html=await (await fetch(base+'/')).text();assert.match(html,/paperNoticeToggle/);assert.match(html,/paperNoticeHistory/);
  const js=await (await fetch(base+'/paper_ui.js')).text();assert.match(js,/paper-event/);
  await post('/api/paper/notifications/settings',{enabled:false});
  await stop(owned);assert.equal(owned.didClose,true,'restart must wait for the original server handles to close');
  launch();let restored;
  for(let i=0;i<80;i++){await sleep(70);try{restored=await get('/api/paper/notifications');if(restored)break}catch{}}
  assert.equal(restored.enabled,false,'persisted preference should survive restart');
 }finally{
  await stop(owned);
  // Windows may briefly retain filesystem handles after the owned process tree
  // exits. Retry only a bounded number of times; never hide a cleanup failure.
  await fs.rm(sandbox,{recursive:true,force:true,maxRetries:10,retryDelay:100});
 }
});
