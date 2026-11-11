// Second half of the pipeline integration tests (split to keep each file under the 60 s limit).
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import net from 'node:net';
import {once} from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {ENTRY} from './fixtures/pipeline_market.mjs';
import {PaperEngine} from '../paper.mjs';
import {trackChild,stopChild} from './helpers/child_process.mjs';
import {fetchLocal} from './helpers/http_request.mjs';
import {sandbox,until,nap} from './helpers/pipeline_sandbox.mjs';
test('Binance public discovery outage blocks new entries and recovers without another provider intersection',{timeout:15000},async()=>{
 const app=await sandbox({scenarios:{BTCUSDT:'breakout-long'},prices:{BTCUSDT:ENTRY},emit:false,binanceOffline:true});
 try{
  await app.start();await until(()=>app.get('/api/status'),s=>s.rest==='offline'&&!s.scanning);
  assert.equal((await app.get('/api/status')).activeCount,0);
  assert.deepEqual((await app.get('/api/results')).signals,[]);assert.equal((await app.get('/api/paper')).pendingCount,0);
  await app.write({binanceOffline:false,emit:true});
  const scan=await fetchLocal(app.base+'/api/scan',{method:'POST'});assert.equal(scan.status,202);await scan.arrayBuffer();
  await until(()=>app.get('/api/status'),s=>s.activeCount===1&&s.rest==='connected'&&!s.scanning);
  const analyzed=await app.get('/api/analyze?symbol=BTCUSDT');assert.equal(analyzed.qualified,true);
  assert.equal(analyzed.decision.analysisVenue,'BINANCE');assert.equal(analyzed.decision.tradeApproval,false);
  assert.equal((await app.get('/api/results')).signals.length,1,'no secondary exchange exists to gate Binance evidence');
 }finally{await app.close()}
});

test('restored open positions remain price-monitored outside both the verified list and the top-45 research list',{timeout:12000},async()=>{
 const symbols=['BTCUSDT',...Array.from({length:45},(_,i)=>'HIGH'+i+'USDT'),'LOWUSDT'];
 const scenarios=Object.fromEntries(symbols.map(symbol=>[symbol,'breakout-long']));
 const prices=Object.fromEntries(symbols.map(symbol=>[symbol,95]));
 const app=await sandbox({scenarios,prices,emit:true,unlisted:symbols.filter(symbol=>symbol!=='BTCUSDT')});
 try{
  let at=Date.now()-10000;
  const seed=new PaperEngine({}, {now:()=>at});
  for(const symbol of ['BTCUSDT','LOWUSDT']){
   assert.equal(seed.register({managementVersion:'LEGACY_R_MULTIPLES',symbol,direction:'LONG',pattern:'restored-open-fixture',entry:100,stop:98,patternConfirmedAt:at-60000},{quoteEligible:true}),true);
   at+=1000;seed.onPrice('CRYPTO',symbol,100,at);
  }
  assert.equal(seed.store.open.length,2);
  await fs.mkdir(app.data,{recursive:true});
  await fs.writeFile(path.join(app.data,'store.json'),JSON.stringify({paper:seed.store,watchlist:[],journal:[],alerts:[],seen:{},newsSeen:{},paperNotify:{enabled:false,history:[]}}));
  await app.start();
  const market=await app.get('/api/market');assert.deepEqual(market.markets.map(row=>row.symbol),['BTCUSDT']);
  const paper=await until(()=>app.get('/api/paper'),p=>p.closedCount===2&&p.openCount===0,{label:'both restored positions must stop despite LOW being excluded from discovery'});
  assert.deepEqual(new Set(paper.closed.map(row=>row.symbol)),new Set(['BTCUSDT','LOWUSDT']));
  assert.ok(paper.closed.every(row=>row.closeReason==='STOP'&&row.realizedPnLUSD<0));
  assert.ok(paper.closed.every(row=>row.closeParts.at(-1).reference===95));
 }finally{await app.close()}
});

test('pending entries recheck the current venue quote before the first simulated fill',{timeout:12000},async()=>{
 const app=await sandbox({scenarios:{BTCUSDT:'breakout-long'},prices:{BTCUSDT:ENTRY},emit:true,pauseWhenPending:true,restPriceFresh:false});
 try{
  await app.start();
  await app.get('/api/analyze?symbol=BTCUSDT');
  const before=await until(()=>app.get('/api/paper'),p=>p.pendingCount===1&&p.openCount===0);
  const registeredAt=before.pending[0].signalAt;
  await app.write({clockOffsetMs:181000,pauseWhenPending:false});
  await until(()=>app.get('/api/status'),s=>s.lastTickerAt>=registeredAt+181000,{label:'a fresh post-expiry tick must be processed'});
  const paper=await app.get('/api/paper'),results=await app.get('/api/results'),funnel=await app.get('/api/scan/diagnostics');
  assert.equal(paper.pendingCount,1,'the still-valid pending signal waits for renewed venue approval');
  assert.equal(paper.openCount,0,'a new tick alone cannot turn a stale venue quote into a fill');
  assert.equal(results.signals.length,0);assert.equal(funnel.technicalPassed,1);assert.equal(funnel.venuePassed,0);
  assert.ok(results.recent[0].execution.reasons.some(reason=>/STALE|만료/.test(reason)));
  assert.equal((await app.get('/api/paper/notifications')).history.length,0,'no OPEN event for a rejected fill');
 }finally{await app.close()}
});

test('the first fresh ticker promotes an already analyzed setup and opens it without another scan',{timeout:12000},async()=>{
 const app=await sandbox({scenarios:{BTCUSDT:'breakout-long'},prices:{BTCUSDT:ENTRY},emit:false,restPriceFresh:false});
 try{
  await app.start();
  const analyzed=await app.get('/api/analyze?symbol=BTCUSDT');
  assert.equal(analyzed.patternConfirmed,true);assert.equal(analyzed.technicalQualified,true);
  assert.equal(analyzed.qualified,false,'before a Binance tick the setup is not actionable');
  const before=await app.get('/api/paper');assert.equal(before.pendingCount,0);assert.equal(before.openCount,0);
  await app.write({emit:true});
  // No manual analyze, candle-close trigger, or periodic scan is requested here.
  const paper=await until(()=>app.get('/api/paper'),p=>p.openCount===1,{label:'a newly fresh analyzed setup must reach its first forward-only fill'});
  const signals=await app.get('/api/results'),funnel=await app.get('/api/scan/diagnostics');
  assert.equal(signals.signals.length,1);assert.equal(funnel.ready,1);
  assert.equal(signals.alerts.length,1,'the promoted setup publishes exactly one signal alert');
  assert.equal(paper.open[0].direction,'LONG');assert.ok(paper.open[0].openedAt>paper.open[0].signalAt,'registration and fill require separate observations');
  const notices=await app.get('/api/paper/notifications');
  assert.equal(notices.history.filter(row=>row.type==='OPEN').length,1);
  await nap(180);
  assert.equal((await app.get('/api/paper')).openCount,1);
  assert.equal((await app.get('/api/paper/notifications')).history.filter(row=>row.type==='OPEN').length,1,'later ticks must not replay OPEN');
  assert.equal((await app.get('/api/results')).alerts.length,1,'later ticks must not replay the signal alert');
 }finally{await app.close()}
});

test('default pattern list: a range breakdown SHORT is detected but not traded, the range breakout LONG still is',{timeout:30000},async()=>{
 const app=await sandbox({scenarios:{BTCUSDT:'breakout-short'},prices:{BTCUSDT:ENTRY},signalPatterns:''});
 try{
  await app.start();const analyzed=await app.get('/api/analyze?symbol=BTCUSDT');
  assert.equal(analyzed.patternConfirmed,true,'the pattern itself is still recognised');
  assert.equal((await app.get('/api/results')).signals.length,0,'not in the backtest-validated list');
  assert.ok(JSON.stringify(analyzed).includes('SIGNAL_PATTERNS'),'the reason names the setting');
  await app.write({scenarios:{BTCUSDT:'breakout-long'},prices:{BTCUSDT:ENTRY}});await app.get('/api/analyze?symbol=BTCUSDT');
  assert.equal((await app.get('/api/results')).signals.length,1,'range breakout LONG passes');
 }finally{await app.close()}
});

