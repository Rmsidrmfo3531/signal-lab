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

test('/api/venues returns BingX and Gate.io public quotes read-only, with listing and tradability per venue',{timeout:40000},async(t)=>{
 const port=await freePort(),sandbox=await fs.mkdtemp(path.join(os.tmpdir(),'venues-server-'));
 await fs.cp(project,sandbox,{recursive:true,filter:src=>!['.env','.git','node_modules','.updates','store.json','scanner_diagnostics.txt'].includes(path.basename(src))});
 const child=trackChild(spawn(process.execPath,['--import','./tests/mock_runtime.mjs','server.mjs'],{
  cwd:sandbox,env:{...process.env,SIGNAL_LAB_DATA_DIR:path.join(sandbox,'persistent-data'),PORT:String(port),HOST:'127.0.0.1',AUTO_UPDATE:'false',
   UPDATE_MANIFEST_URL:'',TELEGRAM_NEWS_ALERTS:'false',TELEGRAM_BOT_TOKEN:'',TELEGRAM_CHAT_ID:'',TWELVE_DATA_API_KEY:''},stdio:'pipe'}));
 let logs='';child.stdout.on('data',d=>logs+=d);child.stderr.on('data',d=>logs+=d);
 const base=`http://127.0.0.1:${port}`,request=(target,options={})=>fetchLocal(base+target,{timeoutMs:20000,...options,signal:t.signal});
 try{
  let ready=false;
  for(let i=0;i<100&&!ready;i++){t.signal.throwIfAborted();await nap(80);try{const r=await request('/api/status');await r.arrayBuffer();ready=r.ok}catch{}}
  assert.ok(ready,logs);
  // The Binance reference price exists once the first market listing has loaded.
  for(let i=0;i<100;i++){const s=await(await request('/api/status')).json();if(s.binancePerps>0&&s.rest==='connected')break;await nap(100)}
  const response=await request('/api/venues?symbols=BTCUSDT,ETHUSDT,SOLUSDT');
  const data=await response.json();assert.equal(response.status,200,JSON.stringify(data));
  assert.equal(data.mode,'PUBLIC_READ_ONLY');assert.equal(data.ordersEnabled,false);assert.equal(data.accountAccess,false);assert.equal(data.chartReference,'BINANCE');
  assert.deepEqual(data.rows.map(r=>r.symbol),['BTCUSDT','ETHUSDT','SOLUSDT']);
  const [btc,,sol]=data.rows;
  assert.equal(btc.venues.BINGX.book.ok,true);assert.equal(btc.venues.BINGX.book.bid,80999.5);assert.equal(btc.venues.BINGX.book.ask,81000.5,'lowest ask even if listed later');
  assert.equal(btc.venues.GATEIO.book.ok,true);assert.equal(btc.venues.GATEIO.contract.quantityUnit,'CONTRACT');
  assert.equal(typeof btc.crossVenueMidBps,'number');assert.equal(typeof btc.binanceChartPrice,'number','Binance chart price as reference');
  assert.equal(sol.venues.BINGX.contract.tradable,false);assert.deepEqual(sol.venues.BINGX.contract.reasons,['VENUE_API_TRADING_DISABLED']);
  assert.equal(sol.venues.GATEIO.error,'NOT_LISTED');
  assert.equal(data.venues.BINGX.state,'connected');assert.equal(data.venues.GATEIO.state,'connected');


  const post=await request('/api/venues',{method:'POST',headers:{'content-type':'application/json'},body:'{}'});
  assert.equal(post.status,405);await post.arrayBuffer();
  const bad=await request('/api/venues?symbols=../../x');assert.equal(bad.status,400);await bad.arrayBuffer();
  const cross=await request('/api/venues',{headers:{'sec-fetch-site':'cross-site'}});assert.equal(cross.status,403);await cross.arrayBuffer();
  const removed=await request('/api/orangex');assert.notEqual(removed.status,200);await removed.arrayBuffer();
 }finally{await stopChild(child);await fs.rm(sandbox,{recursive:true,force:true,maxRetries:8,retryDelay:100})}
});
