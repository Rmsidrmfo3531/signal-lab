import test from 'node:test';
import assert from 'node:assert/strict';
import {analyze} from '../research/legacy_v58/engine.mjs';
import {runOrangeXPaperReplay} from '../orangex_paper_replay.mjs';
import {marketSeries,ENTRY} from './fixtures/pipeline_market.mjs';
import {REPLAY_NOW,syntheticReplayBook,syntheticReplayInput} from './fixtures/orangex_paper_replay.mjs';

// The explicitly selected legacy scanner consumes synthetic candles. These tests
// preserve old replay behavior without enabling fixed-R targets in Issue6.
// Nothing in these examples
// represents observed exchange depth, actual historical profitability or fills.
const HOUR=3600000,NOW=REPLAY_NOW,AT=NOW-1000;
const clone=value=>structuredClone(value);
const book=syntheticReplayBook;
const fixture=(scenario='breakout-long')=>syntheticReplayInput({scenario});

test('explicit legacy closed 1H/4H replay preserves synthetic LONG targets and SHORT stop outcomes in BACKTEST',()=>{
 for(const [scenario,direction]of [['breakout-long','LONG'],['breakout-short','SHORT']]){
  const input=fixture(scenario);
  input.markets.push(...(direction==='LONG'?[book(AT+2,107,107.01),book(AT+3,110,110.01),book(AT+4,112,112.01)]:[book(AT+4,105,105.01)]));
  input.endAt=AT+4;
  const result=runOrangeXPaperReplay(input);
  assert.equal(result.runKind,'BACKTEST');assert.equal(result.executionMode,'SYNTHETIC_TEST');
  assert.equal(result.strategyVersion,'LEGACY_V58');
  assert.equal(result.fillAccuracy,'SYNTHETIC_MODEL_ONLY');assert.equal(result.summary.analysisCount,1);
  assert.equal(result.summary.finalApproved,1);assert.equal(result.summary.entries,1);assert.equal(result.summary.trades,1);
  assert.equal(result.snapshot.closed[0].direction,direction);
  assert.equal(result.snapshot.runKind,'BACKTEST');assert.equal(result.snapshot.executionMode,'SYNTHETIC_TEST');
  assert.ok(direction==='LONG'?result.snapshot.closed[0].realizedPnLUSD>0:result.snapshot.closed[0].realizedPnLUSD<0);
  assert.equal(result.signals[0].signalDetectedAt,AT);assert.equal(result.signals[0].entryEligibleAt,AT);
  assert.equal(result.signals[0].entryAcceptedAt,AT);assert.equal(result.signals[0].firstFillAt,AT+1);
  assert.equal(result.analyses[0].entryAccepted,false,'decision history is not mutated by future executions');
  assert.equal(result.realDataAutoEntryEnabled,false);assert.equal(result.liveOrdersEnabled,false);
 }
});

test('default Issue6 replay retains EMA200 warmup and never silently falls back to legacy fixed-R targets',()=>{
 const input=fixture();delete input.strategyVersion;
 const result=runOrangeXPaperReplay(input);
 assert.equal(result.strategyVersion,'ISSUE6-100-V1');
 assert.ok(result.analyses[0].h4Count>=250,'the default strategy receives enough closed 4H history');
 assert.equal(result.summary.entries,0);assert.equal(result.snapshot.pending.length,0);
 assert.equal(result.snapshot.open.length,0);assert.equal(result.snapshot.closed.length,0);
 assert.ok(result.analyses.every(row=>row.targets===null||row.targets.every(value=>value===null)),
  'without trade-volume profile evidence no target price is invented');
 const unknown=fixture();unknown.strategyVersion='UNREVIEWED_STRATEGY';
 assert.throws(()=>runOrangeXPaperReplay(unknown),/INVALID_REPLAY_STRATEGY/);
});

test('detection, entry eligibility and source fill times remain distinct even when an old book is received later',()=>{
 const input=fixture();input.entry={latencyMs:10};input.markets=[book(AT),book(AT+11,102.19,102.21,{timestamp:AT+5,markPriceAt:AT+5}),book(AT+12)];input.endAt=AT+12;
 const result=runOrangeXPaperReplay(input),signal=result.signals[0];
 assert.equal(signal.signalDetectedAt,AT);assert.equal(signal.entryEligibleAt,AT+10);assert.equal(signal.entryAcceptedAt,AT+10);
 assert.equal(signal.firstFillAt,AT+12);assert.equal(result.snapshot.open.length,1);
 assert.equal(result.snapshot.open[0].entryParts.length,1,'late receipt cannot make an earlier source quote executable');
});

test('equal-time disconnection or cancellation takes precedence over an otherwise executable book',()=>{
 const key=runOrangeXPaperReplay(fixture()).signals[0].signalKey;
 for(const control of [{type:'CONNECTION',connected:false},{type:'CANCEL',key},{type:'CLOSE',key}]){
  const input=fixture();input.events=[{at:AT+1,...control}];
  const result=runOrangeXPaperReplay(input);
  assert.equal(result.equalTimePolicy,'CONTROLS_BEFORE_MARKETS_BEFORE_CANDLE_ANALYSIS');
  assert.equal(result.snapshot.open.length,0);assert.equal(result.snapshot.closed.length,0);
  assert.equal(result.snapshot.pending.length,0);
  assert.equal(result.signals[0].firstFillAt,null);
 }
});

test('future OHLC or venue tails cannot alter an earlier immutable decision prefix or its executed entry',()=>{
 const input=fixture(),prefix=runOrangeXPaperReplay(input),future=clone(input),last=clone(input.h1.at(-1));
 last[0]=Number(last[0])+HOUR;last[6]=Number(last[6])+HOUR;
 last[1]='102.2';last[2]='500';last[3]='1';last[4]='450';last[5]='999999999';
 future.h1.push(last);future.metadata.push({at:AT+HOUR,quoteVolume:9e14});
 future.venueSnapshots.push({...clone(future.venueSnapshots[0]),at:AT+HOUR,price:9000,priceAt:AT+HOUR,statsReceivedAt:AT+HOUR,
  listing:{...clone(future.venueSnapshots[0].listing),quoteUpdatedAt:AT+HOUR}});
 future.endAt=AT+HOUR;
 const full=runOrangeXPaperReplay(future);
 assert.deepEqual(full.analyses.filter(row=>row.at<=input.endAt),prefix.analyses);
 assert.deepEqual(full.snapshot.open[0].entryParts,prefix.snapshot.open[0].entryParts);
 const hidden=clone(future);hidden.endAt=input.endAt;
 assert.deepEqual(runOrangeXPaperReplay(hidden).snapshot,prefix.snapshot,'future tail is not consumed before the replay boundary');
});

test('unfinished candles stay invisible until their explicit availability time and exact 4H clocks are not invented',()=>{
 const input=fixture(),last=clone(input.h1.at(-1));last[0]+=HOUR;last[6]+=HOUR;input.h1.push({row:last,availableAt:AT+HOUR+60000});
 input.endAt=AT+HOUR+59999;
 const result=runOrangeXPaperReplay(input);assert.equal(result.summary.analysisCount,1);assert.equal(result.analyses[0].h1Count,150);
 assert.equal(result.analyses[0].last1hCloseAt,AT-1);assert.equal(result.analyses[0].last4hCloseAt,AT-1);
 const invalid=fixture();invalid.h1[0]={row:invalid.h1[0],availableAt:Number(invalid.h1[0][6])};
 assert.throws(()=>runOrangeXPaperReplay(invalid),/AVAILABLE_BEFORE_CLOSE/);
});

test('historical candles or a single historical snapshot never generate virtual trades or historical fill claims',()=>{
 for(const depth of [false,true]){
  const input=fixture();input.executionMode='HISTORICAL_REPLAY';input.dataSource='USER_SUPPLIED_HISTORICAL';
  input.markets=depth?[book(AT,102.19,102.21,{dataSource:'REAL_PUBLIC_READ_ONLY'})]:[];
  const result=runOrangeXPaperReplay(input);
  assert.equal(result.snapshot,null);assert.equal(result.summary.trades,0);assert.equal(result.summary.entries,0);
  assert.equal(result.fillAccuracy,depth?'UNVERIFIED_HISTORICAL_DEPTH_NOT_EXECUTED':'UNVERIFIED_NO_HISTORICAL_DEPTH');
  assert.equal(result.runKind,'BACKTEST');assert.equal(result.realDataAutoEntryEnabled,false);
  assert.ok(result.assumptions.includes('HISTORICAL_ANALYSIS_ONLY_NO_FILLS'));
 }
 const diagnostic={kind:'ORANGEX_PUBLIC_DIAGNOSTIC',checkedAt:new Date(NOW).toISOString(),markets:[book(AT)]};
 assert.throws(()=>runOrangeXPaperReplay(diagnostic),/INVALID_REPLAY_INPUT/);
 const candleOnly=fixture();candleOnly.markets=[];
 const result=runOrangeXPaperReplay(candleOnly);assert.equal(result.fillAccuracy,'UNVERIFIED_NO_HISTORICAL_DEPTH');assert.equal(result.summary.trades,0);
});

test('a stale selected Mark cannot borrow a fresh venue timestamp or enter on the next fresh book',()=>{
 for(const patch of [{markPriceAt:AT-120000},{timestamp:AT-120000,markPriceAt:AT-120000}]){
  const input=fixture();Object.assign(input.markets[0],patch);
  const result=runOrangeXPaperReplay(input),decision=result.analyses[0];
  assert.equal(decision.analysisPriceAt,AT-120000);assert.equal(decision.priceSource,'MARKET_MARK_PRICE');
  assert.equal(decision.priceSourceFresh,false);assert.equal(decision.finalApproved,false);
  assert.equal(result.summary.entries,0);assert.equal(result.snapshot.open.length,0);
  assert.equal(result.signals[0].firstFillAt,null);
 }
});

test('an explicit venue fallback uses only its own price clock while a candle-only fallback cannot approve execution',()=>{
 const valid=fixture();valid.markets=[];
 let decision=runOrangeXPaperReplay(valid).analyses[0];
 assert.equal(decision.priceSource,'EXPLICIT_VENUE_PRICE');assert.equal(decision.analysisPrice,ENTRY);
 assert.equal(decision.analysisPriceAt,AT);assert.equal(decision.finalApproved,true);
 const stale=clone(valid);stale.venueSnapshots[0].priceAt=AT-120000;
 decision=runOrangeXPaperReplay(stale).analyses[0];assert.equal(decision.priceSourceFresh,false);assert.equal(decision.finalApproved,false);
 const candle=clone(valid);delete candle.venueSnapshots[0].price;
 decision=runOrangeXPaperReplay(candle).analyses[0];assert.equal(decision.priceSource,'CANDLE_CLOSE_ANALYSIS_ONLY');
 assert.equal(decision.analysisPriceAt,null);assert.equal(decision.priceSourceFresh,false);assert.equal(decision.finalApproved,false);
});

test('historical analysis requires declared provenance and never relabels synthetic candles as observed market history',()=>{
 const missing=fixture();missing.executionMode='HISTORICAL_REPLAY';delete missing.dataSource;
 assert.throws(()=>runOrangeXPaperReplay(missing),/HISTORICAL_SOURCE_REQUIRED/);
 const synthetic=fixture();synthetic.executionMode='HISTORICAL_REPLAY';
 const result=runOrangeXPaperReplay(synthetic);
 assert.equal(result.dataSource,'SYNTHETIC_FIXTURE');assert.equal(result.originalDataSource,'SYNTHETIC_FIXTURE');
 assert.equal(result.provenance,'SYNTHETIC_DATA');assert.equal(result.sourceOriginVerified,false);assert.equal(result.snapshot,null);
 const historical=fixture();historical.executionMode='HISTORICAL_REPLAY';historical.dataSource='USER_SUPPLIED_HISTORICAL';
 const observed=runOrangeXPaperReplay(historical);
 assert.equal(observed.dataSource,'USER_SUPPLIED_HISTORICAL_UNVERIFIED_ORIGIN');
 assert.equal(observed.originalDataSource,'USER_SUPPLIED_HISTORICAL');assert.equal(observed.sourceOriginVerified,false);
 const wrongContext=fixture();wrongContext.runKind='FORWARD_PAPER';assert.throws(()=>runOrangeXPaperReplay(wrongContext),/INVALID_REPLAY_CONTEXT/);
});

test('unfilled limits, partial fills and entry timeout use explicit future depth instead of candle high/low',()=>{
 const unfilled=fixture();unfilled.entry={orderType:'LIMIT',limitPrice:102};
 unfilled.markets.push(book(AT+1200001));unfilled.endAt=AT+1200001;
 let result=runOrangeXPaperReplay(unfilled);
 assert.equal(result.summary.trades,0);assert.equal(result.snapshot.open.length,0);assert.equal(result.snapshot.pending.length,0);
 assert.ok(result.snapshot.events.some(event=>event.type==='ENTRY_EXPIRED'));
 const partial=fixture();partial.entry={orderType:'LIMIT',limitPrice:102};
 partial.markets.push(book(AT+2,101.99,102,{asks:[[102,.2]]}));partial.endAt=AT+2;
 result=runOrangeXPaperReplay(partial);assert.equal(result.snapshot.open.length,1);assert.equal(result.snapshot.pending.length,1);
 assert.ok(result.snapshot.open[0].quantityOriginal<=.2+1e-10);assert.equal(result.snapshot.open[0].entryPrice,102);
 assert.equal(result.signals[0].firstFillAt,AT+2);assert.ok(result.signals[0].filledQuantity<=.2+1e-10);
});

test('excessive registration latency expires the existing final approval rather than replaying stale confirmation',()=>{
 const input=fixture();input.entry={latencyMs:20*60000+1};input.endAt=AT+20*60000+2;input.markets.push(book(input.endAt));
 const result=runOrangeXPaperReplay(input);assert.equal(result.summary.entries,0);assert.equal(result.snapshot.open.length,0);
 assert.ok(result.signals[0].reasons.includes('REPLAY_SIGNAL_EXPIRED_BEFORE_ENTRY'));
});

test('real-data provenance, future quote clocks, duplicate candle times and unsupported live modes fail closed',()=>{
 const changes=[
  input=>{input.executionMode='LIVE_MARKET_PAPER'},input=>{delete input.dataSource},
  input=>{input.markets[0].dataSource='REAL_PUBLIC_READ_ONLY'},input=>{input.markets[0].timestamp=AT+1},
  input=>{input.markets[0].markPriceAt=AT+1},input=>{input.venueSnapshots[0].priceAt=AT+1},
  input=>{input.venueSnapshots[0].listing.quoteUpdatedAt=AT+1},input=>{input.h1.push(clone(input.h1[0]))},
  input=>{const duplicate=clone(input.h1[0]);duplicate[0]=String(duplicate[0]);input.h1.push(duplicate)},
  input=>{input.markets.reverse()}
 ];
 for(const change of changes){const input=fixture();change(input);assert.throws(()=>runOrangeXPaperReplay(input));}
});

test('an explicit analysis clock reuses existing native strategy without replacing global Date or changing defaults',()=>{
 const series=marketSeries('breakout-long',NOW),before=Date.now();
 const old=analyze('BTCUSDT',series.h1,series.h4,[],ENTRY,{now:NOW,quoteVolume:1e8});
 assert.equal(old.patternConfirmed,true);assert.equal(old.scannedAt,NOW);assert.equal(old.quality.checkedAt,NOW);
 assert.ok(Date.now()>=before,'global Date remains untouched');
 assert.throws(()=>analyze('BTCUSDT',series.h1,series.h4,[],ENTRY,{now:NaN}),/INVALID_ANALYSIS_CLOCK/);
 const input=fixture(),original=clone(input),progress=[];
 runOrangeXPaperReplay(input,{progressEvery:1,onProgress:row=>progress.push(row)});
 assert.deepEqual(input,original);assert.ok(progress.length>0);assert.ok(progress.every(row=>row.at<=input.endAt));
});
