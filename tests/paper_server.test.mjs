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
test('simulated execution HTTP API, CSV route, shared PC/mobile pane, persisted history after restart', {timeout:16000},async(t)=>{
 const request=(input,options={})=>fetchLocal(input,{...options,signal:t.signal});
 const port=await freePort(),sandbox=await fs.mkdtemp(path.join(os.tmpdir(),'paper-server-'));
 await fs.cp(project,sandbox,{recursive:true,filter:src=>!['.env','.git','node_modules','.updates','store.json','scanner_diagnostics.txt'].includes(path.basename(src))});
 const fixture={market:'CRYPTO',symbol:'BTCUSDT',direction:'LONG',pattern:'test fixture only',barAt:Date.now()-60000,
  openedAt:Date.now()-40000,closedAt:Date.now()-10000,entryFill:100,stop:98,notionalUSD:250,
  realizedGrossUSD:7,realizedPnLUSD:6.7,feesUSD:0.3,closeReason:'ALL_TARGETS',closeParts:[],quoteGaps:0};
 const store={watchlist:[],seen:{},alerts:[],newsSeen:{},journal:[],paper:{pending:[],open:[],closed:[fixture],skipped:[],seen:{}}};
 await fs.writeFile(path.join(sandbox,'store.json'),JSON.stringify(store));
 const child=trackChild(spawn(process.execPath,['--import','./tests/mock_runtime.mjs','server.mjs'],{
  cwd:sandbox,env:{...process.env,SIGNAL_LAB_DATA_DIR:path.join(sandbox,'persistent-data'),PORT:String(port),HOST:'127.0.0.1',AUTO_UPDATE:'false',TELEGRAM_NEWS_ALERTS:'false',TWELVE_DATA_API_KEY:''},stdio:'pipe'}));
 let logs='';child.stdout.on('data',d=>logs+=d);child.stderr.on('data',d=>logs+=d);
 try{
  let result;
  for(let i=0;i<80;i++){
   t.signal.throwIfAborted();
   await nap(80);try{result=await(await request(`http://127.0.0.1:${port}/api/paper`)).json()}catch{}
   if(result?.mode==='SIMULATION_ONLY')break;
  }
  assert.equal(result?.mode,'SIMULATION_ONLY',logs);assert.equal(result.closedCount,1);
  assert.ok(['OFFLINE','WAITING','WATCHING','TRACKING','DELAYED'].includes(result.monitor?.state));
  assert.equal(typeof result.monitor?.priceTickCount,'number');
  assert.equal(result.monitor?.openedCountSession,0); // persisted PNL is not a new live fill
  assert.equal(result.monitor?.closedCountSession,0);
  const storage=await(await request(`http://127.0.0.1:${port}/api/storage`)).json();
  assert.equal(storage.persistent,true);assert.equal(storage.paperClosed,1);
  assert.ok((await fs.readFile(path.join(sandbox,'persistent-data','store.json'),'utf8')).includes('test fixture only'));
  assert.equal(result.netRealizedUSD,6.7,'automatic simulation history is persisted');
  assert.equal(result.startingBalance,null,'paper PNL must not invent an initial account deposit');
  assert.equal(result.indicativeEquityUSD,null,'paper PNL is not a live account balance');
  assert.equal(result.totalMarkedPnLUSD,6.7,'the original historical profit remains the PNL total');
  assert.equal(result.paperNotionalUSD,500);assert.equal(result.winRatePct,100);
  const csv=await(await request(`http://127.0.0.1:${port}/api/paper/export`)).text();
  assert.match(csv,/BTCUSDT/);assert.match(csv,/realizedPnLUSD/);
  const html=await(await request(`http://127.0.0.1:${port}/`)).text();
  assert.match(html,/id="paper"/);assert.match(html,/id="paperMonitorMode"/);assert.match(html,/id="scanPageControls"/);assert.ok(html.indexOf('id="scanner"')<html.indexOf('id="paper"'));
  assert.ok(html.indexOf('id="paper"')>0&&!html.includes('id="tradfi"'));
  assert.match(html,/href="#paper"/);
  const ui=await(await request(`http://127.0.0.1:${port}/paper_ui.js`)).text();assert.match(ui,/api\/paper/);
  const css=await(await request(`http://127.0.0.1:${port}/styles.css`)).text();assert.match(css,/max-width:660px/);
 }finally{await stopChild(child);await fs.rm(sandbox,{recursive:true,force:true,maxRetries:8,retryDelay:100})}
});
