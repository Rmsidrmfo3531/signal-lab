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
async function freePort(){const s=net.createServer();s.listen(0,'127.0.0.1');await once(s,'listening');const p=s.address().port;await new Promise(r=>s.close(r));return p}
const nap=ms=>new Promise(r=>setTimeout(r,ms));

test('real-time ticker, confirmed kline event, auto scan and manual scan work end to end', {timeout:12000},async()=>{
 const port=await freePort();
 // Integration tests must never modify the user's real store.json or .env.
 const sandbox=await fs.mkdtemp(path.join(os.tmpdir(),'signal-lab-test-'));
 await fs.cp(project,sandbox,{recursive:true,filter:src=>path.basename(src)!=='.env'});
 const child=spawn(process.execPath,['--import','./tests/mock_realtime.mjs','server.mjs'],{
  cwd:sandbox,env:{...process.env,SIGNAL_LAB_DATA_DIR:path.join(sandbox,'persistent-data'),PORT:String(port),HOST:'127.0.0.1',AUTO_UPDATE:'false',TELEGRAM_NEWS_ALERTS:'false'},stdio:'pipe'});
 let logs='';child.stdout.on('data',d=>logs+=String(d));child.stderr.on('data',d=>logs+=String(d));
 try{
   let info;
   for(let tries=0;tries<85;tries++){
     await nap(100);
     try{const r=await fetch(`http://127.0.0.1:${port}/api/status`);info=await r.json()}catch{}
     if(info?.lastTickerCount>0&&info?.lastLiveDataAt>0&&info?.liveAnalyzed>0&&info?.scanSuccess>0)break;
   }
   assert.ok(info?.activeCount===4,logs);
   assert.ok(info?.lastTickerAt>0,'actual ticker data must be received');
   assert.equal(info.ws,'connected');
   assert.ok(info?.lastLiveDataAt>0,'actual kline stream must be received');
   assert.ok(info?.liveSubscribeAcks>0,'subscription must be acknowledged');
   assert.ok(info?.liveAnalyzed>0,'closed kline must trigger analysis');
   assert.ok(info?.scanSuccess>0,'background scan must complete');
   assert.equal(info?.intervalMs,60000,'one minute fallback scanning by default');
   const result=await fetch(`http://127.0.0.1:${port}/api/scan`,{method:'POST'});
   assert.equal(result.status,202);
   assert.equal((await result.json()).accepted,true);
   const page=await (await fetch(`http://127.0.0.1:${port}/`)).text();
   assert.match(page,/id="runScanNow"/);
   assert.match(page,/id="sysLiveHealth"/);
   assert.doesNotMatch(page,/id="scanRecentList"/);
   assert.match(page,/id="diagReasons"/);
   assert.doesNotMatch(page,/id="structureList"/);
   assert.doesNotMatch(page,/id="historyList"/);
   const funnel=await(await fetch(`http://127.0.0.1:${port}/api/scan/diagnostics`)).json();
   assert.ok(funnel.uniqueAnalyzed>=2);
   assert.ok(funnel.scannedSinceBoot>=funnel.uniqueAnalyzed);
   const results=await(await fetch(`http://127.0.0.1:${port}/api/results`)).json();
   assert.ok(results.recent.length>=2);
   assert.ok(Array.isArray(results.structures),'observation-only structures must be published');
   assert.ok(Array.isArray(results.history),'historical closed-bar patterns must be published');
   assert.deepEqual(results.structures,[],'retired structures are not rendered as main candidates');
   assert.deepEqual(results.history,[],'retired historical patterns are not rendered as main candidates');
   assert.ok(results.recent.every(x=>x.symbol));
   const invalidShortBar=await fetch(`http://127.0.0.1:${port}/api/klines?symbol=BTCUSDT&interval=15m`);
   assert.equal(invalidShortBar.status,400,'sub-hour interval is disabled');
   for(const timeframe of ['1h','4h','1d']){
     const allowed=await fetch(`http://127.0.0.1:${port}/api/klines?symbol=BTCUSDT&interval=${timeframe}`);
     assert.equal(allowed.status,200,`${timeframe} chart must remain available`);
   }
   const markets=await(await fetch(`http://127.0.0.1:${port}/api/market`)).json();
   assert.deepEqual(markets.markets.map(m=>m.symbol),['BTCUSDT','ETHUSDT','SOLUSDT','1000PEPEUSDT']);
 } finally{const closed=once(child,'close');child.kill('SIGTERM');let timer;try{await Promise.race([closed,new Promise(r=>timer=setTimeout(r,2500))])}finally{clearTimeout(timer)}if(child.exitCode===null){child.kill('SIGKILL');await closed}await fs.rm(sandbox,{recursive:true,force:true,maxRetries:8,retryDelay:100})}
});
