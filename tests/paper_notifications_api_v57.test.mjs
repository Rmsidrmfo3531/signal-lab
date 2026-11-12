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
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function port(){const server=net.createServer();server.listen(0,'127.0.0.1');await once(server,'listening');const p=server.address().port;await new Promise(r=>server.close(r));return p}
test('paper notification API: get/toggle/test/store history without synthetic position creation', {timeout:30000},async(t)=>{
 const request=(input,options={})=>fetchLocal(input,{...options,signal:t.signal});
 const sandbox=await fs.mkdtemp(path.join(os.tmpdir(),'paper-notice-'));const p=await port();
 await fs.cp(project,sandbox,{recursive:true,filter:src=>!['.env','.git','node_modules','.updates','store.json','scanner_diagnostics.txt'].includes(path.basename(src))});
 const dataDir=path.join(sandbox,'userdata');
 let child,didClose=true;
 const launch=()=>{
  assert.equal(didClose,true,'the previous server must close its stdio handles before restart');
  didClose=false;
  child=trackChild(spawn(process.execPath,['--import','./tests/mock_runtime.mjs','server.mjs'],{cwd:sandbox,env:{...process.env,PORT:String(p),HOST:'127.0.0.1',SIGNAL_LAB_DATA_DIR:dataDir,AUTO_UPDATE:'false',TELEGRAM_NEWS_ALERTS:'false'},stdio:'ignore'}));
  child.once('close',()=>{didClose=true});
 };
 const base=`http://127.0.0.1:${p}`;
 const get=async(url)=>{const r=await request(base+url);return r.json()};
 const post=async(url,body)=>{const r=await request(base+url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});return {status:r.status,body:await r.json()}};
 try{
  launch();let ok=false;
  for(let i=0;i<80;i++){t.signal.throwIfAborted();await sleep(70);try{const r=await get('/api/paper/notifications');if(r.enabled===true){ok=true;break}}catch{}}
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
  const html=await (await request(base+'/')).text();assert.match(html,/paperNoticeToggle/);assert.match(html,/paperNoticeHistory/);
  const js=await (await request(base+'/paper_ui.js')).text();assert.match(js,/paper-event/);
  // 알림 설정: one endpoint for every server-side switch; the page offers all of them.
  let all=await get('/api/notifications/settings');
  assert.equal(all.telegramSignals,true,'final-signal Telegram stays on by default');assert.equal(all.telegramPaper,false);assert.equal(all.windowsPaper,true);
  assert.equal((await post('/api/notifications/settings',{telegramSignals:'off'})).status,400);
  all=(await post('/api/notifications/settings',{telegramSignals:false,telegramPaper:true})).body;
  assert.equal(all.telegramSignals,false);assert.equal(all.telegramPaper,true);
  assert.equal((await get('/api/paper/notifications')).telegram.enabled,true,'paper page sees the same switch');
  assert.match(html,/id="notifySettings"/);const panel=await (await request(base+'/notify_settings.js')).text();
  for(const key of ['telegramSignals','telegramPaper','windowsPaper','signalScreen','paperScreen','sound'])assert.match(panel,new RegExp(key));
  await post('/api/paper/notifications/settings',{enabled:false});
  await stopChild(child,{killTree:true});
  launch();let restored;
  for(let i=0;i<80;i++){t.signal.throwIfAborted();await sleep(70);try{restored=await get('/api/paper/notifications');if(restored)break}catch{}}
  assert.equal(restored.enabled,false,'persisted preference should survive restart');
  const kept=await get('/api/notifications/settings');assert.equal(kept.telegramSignals,false);assert.equal(kept.telegramPaper,true);
 }finally{
  await stopChild(child,{killTree:true});
  // Windows may briefly retain filesystem handles after the owned process tree
  // exits. Retry only a bounded number of times; never hide a cleanup failure.
  await fs.rm(sandbox,{recursive:true,force:true,maxRetries:10,retryDelay:100});
 }
});
