import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluateSignal} from '../signal_pipeline.mjs';
import {describeScanFunnel} from '../scan_diagnostics.mjs';
import {analyze} from '../engine.mjs';
import {marketSeries,ENTRY} from './fixtures/pipeline_market.mjs';
import {syntheticFinalSignalContext,syntheticBinanceContext} from './fixtures/binance_signal.mjs';
const now=Date.now(),fixture=()=>syntheticFinalSignalContext(now);
test('configured score cutoff and mandatory technical validation are independent',()=>{
 const {row,context}=fixture();assert.equal(evaluateSignal(row,context).ready,true);
 row.score=95;row.quality.failed=['확정 1시간 거래량 부족'];row.technicalValidation.passed=false;
 assert.equal(evaluateSignal(row,context).stage,'quality');
});
test('current execution quote and analysis expiry agree with funnel despite cached signal status',()=>{
 for(const change of ['chase','stale','analysis-expired','target-hit']){
  const {row,context}=fixture();
  if(change==='chase'||change==='target-hit'){
   const quote=change==='chase'?100.5:106;context.book={T:now,bids:[[quote-.01,1000]],asks:[[quote+.01,1000]]};
  }
  if(change==='stale')context.priceAt=now-100000;
  if(change==='analysis-expired')row.scannedAt=now-21*60000;
  const assess=r=>evaluateSignal(r,context),decision=assess(row);
  assert.equal(decision.ready,false,change);assert.ok(decision.reasons.length,change);
  const funnel=describeScanFunnel(new Map([[row.symbol,row]]),{activeSymbols:[row.symbol],now,assess});
  assert.equal(funnel.ready,0,change);assert.equal(funnel.technicalPassed,1,change);
  assert.equal(funnel.quality+funnel.venue+funnel.entry+funnel.ready,1,change);
 }
});
test('Binance listing and current cost-adjusted reward remain mandatory independently of score',()=>{
 const {row,context}=fixture();row.score=100;
 assert.equal(evaluateSignal(row,{...context,verified:false}).stage,'venue');
 assert.equal(evaluateSignal(row,{...context,venueConnected:false}).stage,'venue');
 row.targetPlan.targets=[100.5,101,101.5];row.target1=100.5;
 const decision=evaluateSignal(row,context);assert.equal(decision.ready,false);assert.match(decision.reasons.join(' '),/손익비/);
});
test('mandatory closed-candle freshness expires independently of the next scan',()=>{
 const series=marketSeries('breakout-long',now-70*60000),row=analyze('BTCUSDT',series.h1,series.h4,[],ENTRY,{quoteVolume:1e8});
 assert.equal(row.technicalQualified,true,'the 70-minute-old completed candle initially passes');
 const later=now+10*60000,decision=evaluateSignal(row,syntheticBinanceContext(row.symbol,ENTRY,later));
 assert.equal(decision.stage,'quality');assert.equal(decision.ready,false);assert.match(decision.reasons.join(' '),/신선도/);
});

test('removed single-price listing schema cannot replace Binance contract and depth evidence',()=>{
 const {row,context}=fixture(),oldContext={verified:true,venueConnected:true,price:100,priceAt:now,now,
  listing:{markPrice:100,quoteUpdatedAt:now,quote1k:{bid:99.995,ask:100.005}}};
 const decision=evaluateSignal(row,oldContext);assert.equal(decision.ready,false);
 assert.ok(decision.execution.reasons.includes('BINANCE_CONTRACT_UNVERIFIED'));
 assert.ok(decision.execution.reasons.includes('BOOK_DEPTH_INVALID'));
 assert.equal(evaluateSignal(row,context).ready,true);
});
