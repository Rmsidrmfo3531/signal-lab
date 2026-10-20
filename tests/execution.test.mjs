import test from 'node:test';
import assert from 'node:assert/strict';
import {parsePerpExecution,executionEstimate,riskSizedEstimate} from '../execution.mjs';
const T=Date.now();
const listing=(changes={})=>parsePerpExecution({ticker:'BTC-PERP',contract_type:'perpetual',mark_price:'81000',volume_24h:'100000000',open_interest:{long_open_interest:'10000',short_open_interest:'9000'},funding:{last:{interval_rate:'0.00008'},next:{interval_rate:'0.0001'},interval_seconds:28800,next_timestamp:Math.floor(T/1000)+28000},quotes:{updated_at:new Date(T-10_000).toISOString(),base:{bid:'80997',ask:'81003'},size_1k:{bid:'80996',ask:'81004'}},...changes});
const make=(v,more={})=>executionEstimate({listing:v,side:'LONG',notional:1000,binancePrice:81001,binancePriceAt:T-10000,statsReceivedAt:T-1000,now:T,...more});
test('public indicative quote and funding parsing; rate in per-interval units',()=>{const v=listing();assert.equal(v.quote1k.ask,81004);assert.equal(v.fundingIntervalRate,.0001);assert.equal(v.fundingIntervalSeconds,28800);assert.ok(v.quoteUpdatedAt<T)});
test('eligible: clear current two-sided quote with inexpensive spread',()=>{const x=make(listing());assert.equal(x.eligible,true);assert.ok(x.spreadBps>0);assert.ok(x.spreadCostUSD>0);assert.equal(x.fundingOneIntervalUSD,.1)});
test('funding is direction dependent',()=>{const v=listing();const l=make(v),s=make(v,{side:'SHORT'});assert.equal(l.fundingOneIntervalUSD,-s.fundingOneIntervalUSD);assert.equal(s.fundingOneIntervalUSD,-.1)});
test('strict fail closed if stale quote, missing timestamp, or missing bid',()=>{const old=listing({quotes:{updated_at:new Date(T-700_000).toISOString(),size_1k:{bid:'80996',ask:'81004'}}});assert.equal(make(old).eligible,false);const missing=listing({quotes:{size_1k:{bid:'80996',ask:'81004'}}});assert.equal(make(missing).eligible,false);const noAsk=listing({quotes:{updated_at:new Date(T).toISOString(),size_1k:{bid:'80996'}}});assert.equal(make(noAsk).eligible,false)});
test('price mismatch and spread blocks alerts',()=>{assert.equal(make(listing({quotes:{updated_at:new Date(T).toISOString(),size_1k:{bid:'80000',ask:'82000'}}})).eligible,false);assert.equal(make(listing(),{binancePrice:80000}).eligible,false)});
test('notional outside API sample band blocked',()=>{const v=listing();assert.equal(make(v,{notional:200}).eligible,false);assert.equal(make(v,{notional:2000}).eligible,false)});
test('missing funding is unknown, never silently displayed as zero',()=>{const x=make(listing({funding:null}));assert.equal(x.fundingOneIntervalUSD,null);assert.equal(x.fundingIntervalRate,null)});
test('trade risk sized to quote spread and stop distance',()=>{const r=riskSizedEstimate({signal:{entry:81000,stop:80595,target1:81810,direction:'LONG'},listing:listing(),binancePrice:81001,binancePriceAt:T,statsReceivedAt:T,now:T});assert.ok(r.notional>0&&r.notional<=1500);assert.ok(r.estimatedStopLossUSD<=6.001)});
test('must have Binance symbol-specific recent updates',()=>{const x=make(listing(),{binancePriceAt:T-300000});assert.equal(x.eligible,false);assert.ok(x.reasons.join(' ').includes('Binance'))});
test('invalid execution limits fail closed instead of disabling freshness and risk guards',()=>{
 const stale=listing({quotes:{updated_at:new Date(T-700_000).toISOString(),size_1k:{bid:'80996',ask:'81004'}}});
 const malformedAge=make(stale,{limits:{maxQuoteAgeSeconds:Number('invalid')}});
 assert.equal(malformedAge.eligible,false,'a mistyped age setting must not approve an old venue quote');
 assert.match(malformedAge.reasons.join(' '),/설정 오류: maxQuoteAgeSeconds/);
 for(const limits of [{maxFeedAgeSeconds:NaN},{maxSpreadBps:Infinity},{maxAdverseVenueBps:undefined},{maxRoundTripBps:-1},{riskUSD:0}]){
  const result=make(listing(),{limits});
  assert.equal(result.eligible,false,JSON.stringify(limits));assert.match(result.reasons.join(' '),/설정 오류/);
 }
 assert.equal(make(listing(),{limits:{maxQuoteAgeSeconds:180,maxSpreadBps:20}}).eligible,true,'valid user settings remain unchanged');
});
test('future quote, Binance and receipt timestamps fail closed',()=>{
 for(const field of ['quote','binance','stats']){
  const v=listing(),extra={};
  if(field==='quote')v.quoteUpdatedAt=T+86400000;
  if(field==='binance')extra.binancePriceAt=T+86400000;
  if(field==='stats')extra.statsReceivedAt=T+86400000;
  const result=make(v,extra);assert.equal(result.eligible,false);assert.match(result.reasons.join(' '),/미래/);
 }
});
test('risk and reward use the directional venue quote rather than an optimistic chart entry',()=>{
 const quote={bid:100.339966,ask:100.35},signal={direction:'LONG',entry:100,stop:99,target1:102};
 const result=riskSizedEstimate({signal,listing:{markPrice:100,quoteUpdatedAt:T,quote1k:quote,quoteBase:quote},binancePrice:100,binancePriceAt:T,statsReceivedAt:T,now:T});
 assert.equal(result.entryBasis,quote.ask);
 assert.ok(result.notional*(quote.ask-signal.stop)/quote.ask<=6);
 assert.ok(result.estimatedNetRR<1.8);
});
