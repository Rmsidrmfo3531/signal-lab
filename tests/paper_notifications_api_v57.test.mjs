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
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function port(){const server=net.createServer();server.listen(0,'127.0.0.1');await once(server,'listening');const p=server.address().port;await new Promise(r=>server.close(r));return p}
test('paper notification API: get/toggle/test/store history without synthetic position creation', {timeout:17000},async()=>{
 const sandbox=await fs.mkdtemp(path.join(os.tmpdir(),'paper-notice-'));const p=await port();
 await fs.cp(project,sandbox,{recursive:true,filter:src=>path.basename(src)!=='.env'});
 const dataDir=path.join(sandbox,'userdata');
 let child;
 const launch=()=>{child=spawn(process.execPath,['--import','./tests/mock_runtime.mjs','server.mjs'],{cwd:sandbox,env:{...process.env,PORT:String(p),HOST:'127.0.0.1',SIGNAL_LAB_DATA_DIR:dataDir,AUTO_UPDATE:'false',TELEGRAM_NEWS_ALERTS:'false'},stdio:'ignore'})};
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
  child.kill('SIGTERM');await sleep(180);
  launch();let restored;
  for(let i=0;i<80;i++){await sleep(70);try{restored=await get('/api/paper/notifications');if(restored)break}catch{}}
  assert.equal(restored.enabled,false,'persisted preference should survive restart');
 }finally{child?.kill('SIGTERM');await sleep(150);if(child?.exitCode===null)child?.kill('SIGKILL');await fs.rm(sandbox,{recursive:true,force:true})}
});
