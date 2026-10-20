import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluateSignal} from '../signal_pipeline.mjs';
import {describeScanFunnel} from '../scan_diagnostics.mjs';
import {analyze} from '../engine.mjs';
import {marketSeries,ENTRY} from './fixtures/pipeline_market.mjs';
const now=Date.now();
function fixture(){
 const row={symbol:'BTCUSDT',pattern:'돌파',patternConfirmed:true,technicalQualified:true,score:90,
  quality:{passed:true,failed:[],validUntil:now+60000},direction:'LONG',entry:100,stop:98,target1:104,atr:2,
  time:now-3600000,patternConfirmedAt:now-1000,scannedAt:now,status:'signal',qualified:true};
 const quote={bid:99.995,ask:100.005};
 const context={verified:true,venueConnected:true,listing:{markPrice:100,quoteUpdatedAt:now,quote1k:quote,quoteBase:quote},
  price:100,priceAt:now,statsReceivedAt:now,now};
 return {row,context};
}
test('final approval accepts 90 with all mandatory checks, but rejects a 95 with a failed mandatory check',()=>{
 const {row,context}=fixture();assert.equal(evaluateSignal(row,context).ready,true);
 row.score=95;row.quality={passed:false,failed:['확정 1시간 거래대금 부족']};row.technicalQualified=false;
 assert.equal(evaluateSignal(row,context).stage,'quality');
});
test('current entry and analysis expiry checks agree with funnel even when cached status still says signal',()=>{
 for(const change of ['chase','stale','analysis-expired','target-hit']){
  const {row,context}=fixture();
  if(change==='chase')context.price=100.5;
  if(change==='stale')context.priceAt=now-100000;
  if(change==='analysis-expired')row.scannedAt=now-21*60000;
  if(change==='target-hit')context.price=104;
  const assess=r=>evaluateSignal(r,context),decision=assess(row);
  assert.equal(decision.ready,false,change);assert.ok(decision.reasons.length,change);
  const funnel=describeScanFunnel(new Map([[row.symbol,row]]),{activeSymbols:[row.symbol],variational:'connected',now,assess});
  assert.equal(funnel.ready,0,change);assert.equal(funnel.technicalPassed,1,change);
  assert.equal(funnel.quality+funnel.venue+funnel.entry+funnel.ready,1,change);
 }
});
test('verified listing and sufficient cost-adjusted reward remain mandatory independently of score',()=>{
 const {row,context}=fixture();row.score=100;
 assert.equal(evaluateSignal(row,{...context,verified:false}).stage,'venue');
 assert.equal(evaluateSignal(row,{...context,venueConnected:false}).stage,'venue');
 row.target1=100.5;
 const decision=evaluateSignal(row,context);
 assert.equal(decision.ready,false);assert.match(decision.reasons.join(' '),/손익비/);
});
test('mandatory candle freshness is reevaluated without waiting for the next scan',()=>{
 const {context}=fixture(),series=marketSeries('breakout-long',now-70*60000);
 const row=analyze('BTCUSDT',series.h1,series.h4,[],ENTRY,{quoteVolume:1e8});
 assert.equal(row.technicalQualified,true,'the 70-minute-old completed candle initially passes');
 const later=now+10*60000,quote={bid:ENTRY-.005,ask:ENTRY+.005};
 const decision=evaluateSignal(row,{...context,now:later,priceAt:later,statsReceivedAt:later,
  price:ENTRY,listing:{...context.listing,quoteBase:quote,quote1k:quote,markPrice:ENTRY,quoteUpdatedAt:later}});
 assert.equal(decision.stage,'quality');assert.equal(decision.ready,false);
 assert.match(decision.reasons.join(' '),/신선도/);
});
