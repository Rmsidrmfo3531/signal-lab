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
test('synthetic markets: rising/falling breakouts, retests and a 90-point setup reach the final signal; weak/range markets do not',{timeout:30000},async()=>{
 const app=await sandbox({scenarios:{BTCUSDT:'breakout-long'},prices:{BTCUSDT:ENTRY},emit:true});
 try{
  await app.start();
  const matrix=[
   ['breakout-long','LONG',90,'박스권 상단 돌파'],
   ['breakout-short','SHORT',90,'박스권 하단 이탈'],
   ['retest-long','LONG',90,'돌파 후 지지 재확인'],
   ['retest-short','SHORT',90,'이탈 후 저항 재확인'],
   ['bonus-missing-long','LONG',90,'박스권 상단 돌파'],
   ['weak-volume',null,85],['illiquid-hour','LONG',90,'박스권 상단 돌파'],['range',null,null]
  ];
  for(const [scenario,direction,score,pattern] of matrix){
   await app.write({scenarios:{BTCUSDT:scenario},prices:{BTCUSDT:scenario==='range'?100:ENTRY}});
   await nap(90);
   const analyzed=await app.get('/api/analyze?symbol=BTCUSDT');
   assert.equal(analyzed.score,score,scenario+' technical score');
   if(direction){
    assert.equal(analyzed.pattern,pattern,scenario+' pattern');
    assert.equal(analyzed.technicalQualified,true,scenario+' technical gate');
    assert.equal(analyzed.execution.eligible,true,scenario+' venue gate '+JSON.stringify({execution:analyzed.execution,targetPlan:analyzed.targetPlan}));
   }
   const results=await app.get('/api/results');
   const funnel=await app.get('/api/scan/diagnostics');
   assert.equal(results.signals.length,direction?1:0,scenario+' final signal: '+JSON.stringify(analyzed));
   assert.equal(funnel.ready,results.signals.length,scenario+' diagnostics match the final list');
   assert.equal(funnel.patternCount,scenario==='range'?0:1,scenario+' pattern count');
   assert.equal(funnel.technicalPassed,direction?1:0,scenario+' technical pass count');
   assert.equal(funnel.venuePassed,direction?1:0,scenario+' venue pass count');
   if(direction)assert.equal(results.signals[0].direction,direction,scenario);
  }
  const requests=(await fs.readFile(app.requests,'utf8')).trim().split('\n').map(JSON.parse);
  assert.ok(requests.some(r=>r.interval==='1h'));assert.ok(requests.some(r=>r.interval==='4h'));
  // Signals use closed 1H/4H candles only; 15m candles are read solely for the volume-profile targets.
  assert.ok(requests.filter(r=>r.interval).every(r=>['1h','4h','1d','15m'].includes(r.interval)),'no other candle intervals');
  assert.ok(requests.some(r=>r.interval==='15m'),'volume profile reads 15m candles');
  // Order-book reads (Gate.io /order_book) are market data; any order placement path is forbidden.
  assert.ok(requests.every(r=>!/\/orders?(?:\/|$)|\/trade\/order/.test(r.path)),'no exchange order endpoint');
  assert.ok(requests.some(r=>r.host==='open-api.bingx.com')&&requests.some(r=>r.host==='api.gateio.ws'),'execution venues quoted');
 }finally{await app.close()}
});

test('synthetic end to end: LONG three profile targets with breakeven/restart, then SHORT stop and durable PNL/OPEN/CLOSE events',{timeout:30000},async()=>{
 const app=await sandbox({scenarios:{BTCUSDT:'breakout-long'},prices:{BTCUSDT:ENTRY},emit:true});
 try{
  await app.start();await app.get('/api/analyze?symbol=BTCUSDT');
  const results=await app.get('/api/results');assert.equal(results.signals.length,1);assert.equal(results.signals[0].direction,'LONG');
  let paper=await until(()=>app.get('/api/paper'),p=>p.openCount===1,{label:'fresh final LONG must open a profile-managed paper position'});
  const long=paper.open[0];assert.equal(long.direction,'LONG');assert.equal(long.executionVenue,'BINGX','tie on price keeps the first configured venue');assert.equal(long.venueSymbol,'BTC-USDT');assert.equal(long.managementVersion,'VOLUME_PROFILE_V1');
  assert.ok(long.entryFill>ENTRY,'long fill includes spread and slippage');assert.ok(long.feesUSD>0);
  assert.ok(long.targetPlan?.profileEvidence,'the entry preserves the supplied 15m-candle profile evidence');
  // Manual stop/TP edit through the API: a wrong-side stop is refused, a tighter stop is stored and survives.
  const post=async body=>{const r=await fetchLocal(app.base+'/api/paper/levels',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});return {status:r.status,body:await r.json()}};
  const refused=await post({key:long.key,stop:long.entryFill+5});assert.equal(refused.status,400);assert.deepEqual(refused.body.reasons,['STOP_ALREADY_CROSSED']);
  const tighter=Number((long.stop+0.5).toFixed(2)),edited=await post({key:long.key,stop:tighter,targets:long.targets});
  assert.equal(edited.status,200,JSON.stringify(edited.body));assert.equal(edited.body.changed,true);assert.equal(edited.body.live.live,false,'live trading is off');
  assert.equal((await app.get('/api/paper')).open[0].stop,tighter);
  const scalp=await app.get('/api/scalp');assert.equal(scalp.enabled,true);assert.equal(scalp.mode,'PAPER_ONLY','scalp mode never trades live');
  await app.write({prices:{BTCUSDT:long.targets[0]+.02}});
  paper=await until(()=>app.get('/api/paper'),p=>p.open[0]?.exitedPct===40);
  const partial=paper.open[0];assert.equal(partial.closeParts.length,1);assert.equal(partial.closeParts[0].targetNumber,1);
  assert.ok(Math.abs(partial.qtyRemaining/partial.originalQty-.6)<1e-10);assert.equal(partial.stop,partial.entryFill);
  let notices=await app.get('/api/paper/notifications');assert.equal(notices.history.filter(e=>e.type==='OPEN').length,1);
  assert.equal(notices.history.filter(e=>e.type==='CLOSE').length,0,'partial targets do not send final CLOSE');
  await app.stop();await app.start();paper=await app.get('/api/paper');
  const restored=paper.open.find(p=>p.key===long.key);assert.equal(restored.exitedPct,40);assert.equal(restored.entryFill,long.entryFill);
  assert.equal(restored.qtyRemaining,partial.qtyRemaining);assert.equal(restored.realizedPnLUSD,partial.realizedPnLUSD);
  await app.write({prices:{BTCUSDT:long.targets[1]+.02}});
  paper=await until(()=>app.get('/api/paper'),p=>p.open[0]?.exitedPct===75);
  assert.deepEqual(paper.open[0].closeParts.map(p=>p.targetNumber),[1,2]);
  await app.write({prices:{BTCUSDT:long.targets[2]+.02}});
  paper=await until(()=>app.get('/api/paper'),p=>p.closed.some(x=>x.key===long.key));
  const closedLong=paper.closed.find(x=>x.key===long.key);assert.equal(closedLong.closeReason,'ALL_TARGETS');assert.equal(closedLong.qtyRemaining,0);
  assert.deepEqual(closedLong.closeParts.map(p=>p.targetNumber),[1,2,3]);assert.ok(closedLong.realizedPnLUSD>0);
  assert.ok(Math.abs(closedLong.realizedGrossUSD-closedLong.feesUSD-closedLong.realizedPnLUSD)<1e-7);
  // A separate market regime uses BTC's own down-trending 4H context. An ETH
  // short must not borrow a bullish BTC context merely to satisfy this test.
  await app.write({scenarios:{BTCUSDT:'breakout-short'},prices:{BTCUSDT:ENTRY}});await nap(90);
  const shortAnalysis=await app.get('/api/analyze?symbol=BTCUSDT');assert.equal(shortAnalysis.direction,'SHORT');assert.equal(shortAnalysis.qualified,true);
  paper=await until(()=>app.get('/api/paper'),p=>p.openCount===1);const short=paper.open[0];assert.equal(short.direction,'SHORT');assert.ok(short.entryFill<ENTRY);
  await app.write({prices:{BTCUSDT:short.initialStop+.5}});
  paper=await until(()=>app.get('/api/paper'),p=>p.closedCount===2&&p.openCount===0);
  const closedShort=paper.closed.find(x=>x.key===short.key);assert.equal(closedShort.closeReason,'STOP');assert.ok(closedShort.realizedPnLUSD<0);
  assert.equal(closedShort.closeParts[0].type,'STOP');assert.ok(closedShort.feesUSD>short.feesUSD);
  assert.ok(Math.abs(paper.netRealizedUSD-closedLong.realizedPnLUSD-closedShort.realizedPnLUSD)<1e-7);
  notices=await app.get('/api/paper/notifications');assert.equal(notices.history.filter(e=>e.type==='OPEN').length,2);assert.equal(notices.history.filter(e=>e.type==='CLOSE').length,2);
  for(const row of paper.closed)assert.equal(notices.history.find(e=>e.type==='CLOSE'&&e.key===row.key).realizedPnLUSD,row.realizedPnLUSD);
  const stored=JSON.parse(await fs.readFile(path.join(app.data,'store.json'),'utf8'));assert.equal(stored.paper.closed.length,2);assert.equal(stored.paper.open.length,0);
  const pnl=paper.netRealizedUSD,historyLength=notices.history.length;await app.stop();await app.start();paper=await app.get('/api/paper');notices=await app.get('/api/paper/notifications');
  assert.equal(paper.closedCount,2);assert.equal(paper.netRealizedUSD,pnl);assert.equal(notices.history.length,historyLength,'restart must not replay trade notifications');
 }finally{await app.close()}
});


test('synthetic Binance book rejection keeps a discovered 90-point pattern out of final signals and paper entries',{timeout:12000},async()=>{
 const app=await sandbox({scenarios:{BTCUSDT:'breakout-long'},prices:{BTCUSDT:ENTRY},emit:true,invalidQuote:true});
 try{
  await app.start();const analyzed=await app.get('/api/analyze?symbol=BTCUSDT');
  assert.equal(analyzed.patternConfirmed,true);assert.equal(analyzed.score,90);assert.equal(analyzed.technicalQualified,true);
  assert.equal(analyzed.execution.eligible,false);
  const results=await app.get('/api/results'),funnel=await app.get('/api/scan/diagnostics'),paper=await app.get('/api/paper');
  assert.equal(funnel.patternCount,1);assert.equal(funnel.technicalPassed,1);assert.equal(funnel.venuePassed,0);assert.equal(funnel.ready,0);
  assert.equal(results.signals.length,0);assert.equal(paper.pendingCount,0);assert.equal(paper.openCount,0);
 }finally{await app.close()}
});

test('a valid 90-point setup without three supplied volume-profile targets stays out of final signals and paper entries',{timeout:12000},async()=>{
 const app=await sandbox({scenarios:{BTCUSDT:'breakout-long'},prices:{BTCUSDT:ENTRY},emit:true,profileUnavailable:true});
 try{
  await app.start();const analyzed=await app.get('/api/analyze?symbol=BTCUSDT');
  assert.equal(analyzed.score,90);assert.equal(analyzed.technicalQualified,true);
  assert.equal(analyzed.targetPlan.ok,false);assert.equal(analyzed.targetPlan.code,'TP_PROFILE_UNAVAILABLE');
  assert.deepEqual(analyzed.targetPlan.targets,[],'no automatic R-multiple target replacement');
  assert.equal(analyzed.qualified,false);
  const results=await app.get('/api/results'),paper=await app.get('/api/paper');
  assert.deepEqual(results.signals,[]);assert.deepEqual(results.patterns,[]);assert.deepEqual(results.watch,[]);
  assert.equal(paper.pendingCount,0);assert.equal(paper.openCount,0);
 }finally{await app.close()}
});

test('an existing data-directory score setting raises the final gate while disclosing unverified performance',{timeout:15000},async()=>{
 const app=await sandbox({scenarios:{BTCUSDT:'breakout-long'},prices:{BTCUSDT:ENTRY},emit:true});
 const envContent='SIGNAL_FINAL_MIN_SCORE=95\n';
 await fs.writeFile(path.join(app.data,'.env'),envContent);
 try{
  await app.start();
  const status=await app.get('/api/status');
  assert.equal(status.scorePolicy.finalMinScore,95);assert.equal(status.scorePolicy.source,'CONFIGURED');
  assert.equal(status.scorePolicy.performanceValidation,'UNVERIFIED');assert.equal(status.scorePolicy.liveApproval,false);
  const row=await app.get('/api/analyze?symbol=BTCUSDT');
  assert.equal(row.score,90);assert.equal(row.scorePolicy.finalMinScore,95);assert.equal(row.qualified,false);
  assert.equal(row.quality.thresholdPassed,false);assert.equal(row.quality.validationPassed,true);
  const results=await app.get('/api/results');assert.deepEqual(results.signals,[]);assert.equal(results.scorePolicy.finalMinScore,95);
  const paper=await app.get('/api/paper');assert.equal(paper.pendingCount,0);assert.equal(paper.openCount,0);
  await app.stop();assert.equal(await fs.readFile(path.join(app.data,'.env'),'utf8'),envContent);
 }finally{await app.close()}
});

