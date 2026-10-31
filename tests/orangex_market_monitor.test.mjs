import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {OrangeXMarketMonitor,diagnoseOrangeXContinuous,normalizeOrangeXMonitorBook,normalizeOrangeXMonitorMark,
 orangeXMonitorProbe,binanceMonitorProbe,binanceMonitorURL} from '../orangex_market_monitor.mjs';
import {continuousOptions} from '../scripts/diagnose-orangex-continuous.mjs';

// All market values and costs in this file are protocol fixtures, never exchange
// specifications or actual observations. No network or application data is used.
const START=Date.parse('2026-10-31T00:59:19.246Z'),NAME='BTC-USDT-PERPETUAL';
const ok=result=>({category:'OK',httpStatus:200,processClosed:true,responseSource:'UNCONFIRMED',body:JSON.stringify({result})});
const depth=(name,at,patch={})=>({instrument_name:name,bids:[[100,2],[99.9,3]],asks:[[100.1,4],[100.2,5]],timestamp:String(at),...patch});
const b=(at,patch={})=>normalizeOrangeXMonitorBook(ok(depth(NAME,at,patch)),NAME);
const m=(at,patch={})=>normalizeOrangeXMonitorMark(ok([{instrument_name:NAME,mark_price:100.05,timestamp:String(at),...patch}]),NAME);
const monitor=options=>new OrangeXMarketMonitor({dataSource:'SYNTHETIC_TEST',...options});
function fixture({oldMark=false,malformed=false}={}){
 let wall=START,mono=0;const calls=[];
 const advance=ms=>{wall+=ms;mono+=ms};
 return {calls,now:()=>wall,monotonicNow:()=>mono,delay:async ms=>advance(ms),dataSource:'SYNTHETIC_TEST',
  orangexProbe:async(kind,name)=>{calls.push(['ORANGEX',kind,name]);advance(5);
   const result=kind==='book'?depth(name,wall-24000,malformed?{asks:[[100.1,1],[100.1,2]]}:{}):
    [{instrument_name:name,mark_price:100.05,timestamp:wall-(oldMark?90001:24000)}];
   return {...ok(result),httpDateMs:Math.floor(wall/1000)*1000,httpAgeSeconds:20,cacheObservation:{maxAgeSeconds:30},curlDurationMs:4,curlTimeToFirstByteMs:3};
  },
  binanceProbe:async(kind,symbol)=>{calls.push(['BINANCE',kind,symbol]);advance(5);
   const result=kind==='contracts'?{symbols:['BTC','ETH','SOL'].map(asset=>({symbol:asset+'USDT',baseAsset:asset,quoteAsset:'USDT',marginAsset:'USDT',contractType:'PERPETUAL',status:'TRADING',unknown_secret:'unit-test-no-export'}))}:
    kind==='time'?{serverTime:wall+100}:{symbol,bidPrice:'100',askPrice:'100.1',time:wall};
   return {category:'OK',httpStatus:200,processClosed:true,body:JSON.stringify(result)};
  }};
}

test('capture facts remain immutable after independent current quote and Mark eligibility expires',()=>{
 const subject=monitor({stallAfterMs:90000}),sample=subject.record({asset:'BTC',capturedAt:START,book:b(START-24000),mark:m(START-24500)});
 assert.equal(sample.atCapture.status,'PASS');const original=JSON.stringify(sample);
 const late=subject.snapshot({now:START+90001}).markets[0];
 assert.equal(late.atCapture.status,'PASS');assert.equal(late.currentEligibility.status,'FAIL');
 assert.ok(late.currentEligibility.reasons.includes('BOOK_SOURCE_CLOCK_STALE'));assert.ok(late.currentEligibility.reasons.includes('MARK_SOURCE_CLOCK_STALE'));
 assert.equal(JSON.stringify(subject.snapshot({now:START}).observations[0]),original);
 assert.equal(late.currentEligibility.entryEligible,false);
});

test('fresh books never refresh a stale Mark clock and missing clocks remain unverified rather than invented',()=>{
 const subject=monitor();subject.record({asset:'BTC',capturedAt:START,book:b(START),mark:m(START-90001)});
 const latest=subject.snapshot({now:START}).markets[0];assert.equal(latest.atCapture.bookClock.status,'PASS');assert.equal(latest.atCapture.markClock.status,'FAIL');
 const missing=monitor();missing.record({asset:'BTC',capturedAt:START,book:b(START),mark:m(START,{timestamp:null})});
 assert.equal(missing.snapshot({now:START}).markets[0].currentEligibility.markClock.status,'UNVERIFIED');
 assert.equal(m(START).mark.explicitMarkTimestampField,false);assert.equal(m(START).mark.timestampMeaningVerified,false);
 assert.equal(m(START).mark.timestampInterpretation,'GENERIC_OR_LAST_TRADE_TIMESTAMP_POSSIBLE');
 assert.equal(m(START,{mark_timestamp:START-50}).mark.timestampSource,'result.mark_timestamp');
});

test('a few repeated source timestamps are recorded without causal guesses, and a stopped source is blocked before the age limit',()=>{
 const subject=monitor({stallAfterMs:30000}),clock=START-24000;
 subject.record({asset:'BTC',capturedAt:START,book:b(clock),mark:m(clock)});
 const repeated=subject.record({asset:'BTC',capturedAt:START+1000,book:b(clock),mark:m(clock)});
 assert.equal(repeated.atCapture.status,'PASS');assert.equal(repeated.progress.book.reason,'REPEATED_SOURCE_TIMESTAMP_OBSERVED');
 const stopped=subject.snapshot({now:START+30000}).markets[0].currentEligibility;
 assert.equal(stopped.bookClock.status,'PASS');assert.equal(stopped.markClock.status,'PASS');assert.equal(stopped.status,'FAIL');
 assert.ok(stopped.reasons.includes('BOOK_SOURCE_TIMESTAMP_NOT_PROGRESSING'));assert.equal(stopped.entryEligible,false);
});

test('source timestamp regression, future time and local wall clock regression are independent failures',()=>{
 const subject=monitor();subject.record({asset:'BTC',capturedAt:START,book:b(START-100),mark:m(START-100)});
 const rewind=subject.record({asset:'BTC',capturedAt:START+10,book:b(START-101),mark:m(START-101)});
 assert.ok(rewind.atCapture.reasons.includes('BOOK_SOURCE_TIMESTAMP_REGRESSION'));
 const future=monitor().record({asset:'BTC',capturedAt:START,book:b(START+1),mark:m(START)});
 assert.ok(future.atCapture.reasons.includes('BOOK_SOURCE_CLOCK_IN_FUTURE'));
 const local=subject.record({asset:'BTC',capturedAt:START-1,book:b(START-50),mark:m(START-50)});
 assert.equal(local.localClockRegression,true);assert.ok(local.atCapture.reasons.includes('LOCAL_WALL_CLOCK_REGRESSION'));
});

test('direct sample callers cannot hide failed transport or unconfirmed cleanup behind positive books and Marks',()=>{
 for(const request of [{processClosed:false,category:'OK',httpStatus:200},{category:'TIMEOUT',httpStatus:200},
  {category:'OK',httpStatus:503},{category:'OK',httpStatus:null}]){
  const sample=monitor().record({asset:'BTC',capturedAt:START,book:b(START),mark:m(START),requests:[request]});
  assert.equal(sample.atCapture.status,'FAIL');assert.ok(sample.atCapture.reasons.includes('REQUEST_TRANSPORT_OR_HTTP_NOT_SUCCESSFUL'));
 }
});

test('direct sample and price-comparison callers cannot combine different instruments',()=>{
 const eth='ETH-USDT-PERPETUAL',wrongBook=normalizeOrangeXMonitorBook(ok(depth(eth,START)),eth),
  wrongMark=normalizeOrangeXMonitorMark(ok([{instrument_name:eth,mark_price:100.05,timestamp:START}]),eth);
 const mismatch=monitor().record({asset:'BTC',capturedAt:START,book:wrongBook,mark:wrongMark});
 assert.equal(mismatch.atCapture.marketDataEligible,false);assert.ok(mismatch.atCapture.reasons.includes('BOOK_INSTRUMENT_MISMATCH'));
 assert.ok(mismatch.atCapture.reasons.includes('MARK_INSTRUMENT_MISMATCH'));
 const subject=monitor();subject.record({asset:'BTC',capturedAt:START,book:b(START),mark:m(START),binance:{
  contract:{symbol:'BTCUSDT',baseAsset:'BTC',quoteAsset:'USDT',marginAsset:'USDT',contractType:'PERPETUAL',status:'TRADING'},
  book:{symbol:'ETHUSDT',bid:100,ask:100.1,timestamp:START}}});
 const comparison=subject.snapshot({now:START}).markets[0].binanceComparison;
 assert.equal(comparison.reason,'PRICE_COMPARISON_INSTRUMENT_MISMATCH');assert.equal(comparison.gapBps,null);assert.equal(comparison.mappingVerified,false);
});

test('duplicate, reordered, crossed and unknown extra-column books cannot become eligible after normalization',()=>{
 for(const patch of [{bids:[[99.9,1],[100,1]]},{asks:[[100.1,1],[100.1,2]]},{asks:[[99,1]]},{bids:[[100,1,'unknown']]}]){
  const book=b(START,patch);assert.equal(book.status,'FAIL');
  const sample=monitor().record({asset:'BTC',capturedAt:START,book,mark:m(START)});assert.equal(sample.atCapture.marketDataEligible,false);
 }
 assert.equal(normalizeOrangeXMonitorBook(ok(depth('ETH-USDT-PERPETUAL',START)),NAME).status,'FAIL');
 assert.equal(normalizeOrangeXMonitorMark(ok([{instrument_name:NAME,mark_price:100}]),NAME).mark.timestamp,null);
});

test('bounded synthetic continuous samples measure HTTP and data qualification separately without claiming trading readiness',async()=>{
 const state=fixture(),report=await diagnoseOrangeXContinuous({...state,rounds:3,intervalMs:2000});
 assert.equal(report.syntheticTest,true);assert.equal(report.actualRequestsRun,false);assert.equal(report.success.issued,31);
 assert.equal(report.success.httpSuccessRate,1);assert.equal(report.success.captureQualifiedRate,1);
 assert.equal(report.completedRounds,3);assert.equal(report.monitor.observations.length,9);assert.equal(report.monitor.marketDataStatus,'PASS');
 assert.equal(report.exitCode,0);assert.equal(report.operationalReadiness,'NOT_READY');assert.equal(report.realDataAutoEntryEnabled,false);assert.equal(report.liveOrdersEnabled,false);
 assert.ok(report.requests.every(row=>row.durationMs===5&&row.clockStatus==='PASS'));
 assert.equal(report.causeAssessment.positiveHttpAgeObserved,true);assert.equal(report.causeAssessment.cacheAbsenceVerified,false);
 assert.equal(report.monitor.markets[0].binanceComparison.status,'OBSERVATION_ONLY');assert.equal(report.monitor.markets[0].binanceComparison.mappingVerified,false);
 assert.equal(report.rounds[0].binanceClockObservation.appliesToOrangeXClock,false);
 assert.doesNotMatch(JSON.stringify(report),/unit-test-no-export/);
});

test('HTTP200 success can coexist with invalid depth and stale Mark, so it does not become a successful data diagnostic',async()=>{
 const report=await diagnoseOrangeXContinuous({...fixture({oldMark:true,malformed:true}),rounds:2});
 assert.equal(report.success.httpSuccessRate,1);assert.equal(report.success.captureQualifiedRate,0);assert.equal(report.exitCode,1);
 assert.equal(report.monitor.marketDataStatus,'FAIL');assert.equal(report.monitor.markets[0].currentEligibility.entryEligible,false);
});

test('the first proxy policy denial stops before other assets, retries or Binance expansion',async()=>{
 let calls=0;
 const report=await diagnoseOrangeXContinuous({...fixture(),orangexProbe:async()=>{calls++;return {category:'PROXY_CONNECT_REJECTED',httpStatus:null,proxyConnectStatus:403,processClosed:true,body:''}}});
 assert.equal(calls,1);assert.equal(report.success.issued,1);assert.equal(report.completedRounds,0);assert.equal(report.exitCode,2);
 assert.equal(report.halted.reason,'PROXY_CONNECT_REJECTED');assert.equal(report.success.allScheduledRequestsCompleted,false);
 assert.equal(report.monitor.observations.length,0);assert.equal(report.monitor.marketDataStatus,'UNVERIFIED');
});

test('unconfirmed process cleanup and the fixed runtime budget stop subsequent scheduled requests',async()=>{
 const unreaped=await diagnoseOrangeXContinuous({...fixture(),orangexProbe:async()=>({...ok([]),processClosed:false})});
 assert.equal(unreaped.success.issued,1);assert.equal(unreaped.halted.reason,'PROCESS_CLEANUP_UNCONFIRMED');
 const bounded=await diagnoseOrangeXContinuous({...fixture(),rounds:12,intervalMs:30000});
 assert.equal(bounded.halted.reason,'RUN_TIME_LIMIT');assert.equal(bounded.requestWindowLimitMs,180000);
 assert.ok(bounded.success.issued<bounded.maximumPlannedRequests);assert.equal(bounded.success.allScheduledRequestsCompleted,false);
 assert.equal(bounded.exitCode,2);
});

test('real observation labels cannot conceal injected probes or synthetic clocks',async()=>{
 for(const options of [{orangexProbe:async()=>{}},{binanceProbe:async()=>{}},{now:()=>START},{monotonicNow:()=>1},{delay:async()=>{}}])
  await assert.rejects(diagnoseOrangeXContinuous(options),/MOCK_INJECTION_REQUIRES_SYNTHETIC_TEST/);
});

test('synthetic mode cannot default to real network transports and replay labels cannot become real observations',async()=>{
 await assert.rejects(diagnoseOrangeXContinuous({dataSource:'SYNTHETIC_TEST'}),/SYNTHETIC_PROBES_REQUIRED/);
 await assert.rejects(diagnoseOrangeXContinuous({dataSource:'SYNTHETIC_TEST',orangexProbe:async()=>ok([])}),/SYNTHETIC_PROBES_REQUIRED/);
 for(const dataSource of ['HISTORICAL_REPLAY','MOCK_RESPONSE','UNKNOWN'])
  assert.throws(()=>new OrangeXMarketMonitor({dataSource}),/INVALID_MONITOR_SOURCE/);
});

test('an explicit HTTP451 access restriction stops without retry or other exchange expansion',async()=>{
 let calls=0;
 const report=await diagnoseOrangeXContinuous({...fixture(),orangexProbe:async()=>{calls++;return {category:'HTTP',httpStatus:451,processClosed:true,body:''}}});
 assert.equal(calls,1);assert.equal(report.halted.httpStatus,451);assert.equal(report.halted.reason,'HTTP');
 assert.equal(report.completedRounds,0);assert.equal(report.actualRequestsRun,false);assert.equal(report.exitCode,2);
});

test('optional public funding keeps raw forecasts separate and never activates settlement or defaults to a real synthetic probe',async()=>{
 await assert.rejects(diagnoseOrangeXContinuous({...fixture(),includeFunding:true}),/SYNTHETIC_PROBES_REQUIRED/);
 const state=fixture();let fundingCalls=0;
 const report=await diagnoseOrangeXContinuous({...state,rounds:2,includeBinance:false,includeFunding:true,
  fundingProbe:async()=>{fundingCalls++;return ok(['BTC','ETH','SOL'].map(asset=>({instrument_name:asset+'-USDT-PERPETUAL',
   funding_rate:0.0001,next_funding_rate:0.0002,next_funding_rate_timestamp:START+3600000})))}});
 assert.equal(fundingCalls,2);assert.equal(report.success.issued,14);assert.equal(report.actualRequestsRun,false);
 assert.deepEqual(continuousOptions(['--funding','--without-binance']),{includeFunding:true,includeBinance:false});
 for(const round of report.rounds){
  assert.equal(round.fundingObservation.observationStatus,'PASS');assert.equal(round.fundingObservation.status,'NOT_READY');
  for(const market of round.fundingObservation.markets){assert.equal(market.actualScheduleVerified,false);assert.equal(market.nextRateIsRealizedFunding,false);assert.equal(market.actualFundingEstimate,null)}
 }
 assert.equal(report.realDataAutoEntryEnabled,false);assert.equal(report.operationalReadiness,'NOT_READY');
});

test('funding collection is never expanded after the initial OrangeX policy denial',async()=>{
 let fundingCalls=0;
 const report=await diagnoseOrangeXContinuous({...fixture(),includeFunding:true,orangexProbe:async()=>({category:'PROXY_CONNECT_REJECTED',httpStatus:null,processClosed:true,body:''}),
  fundingProbe:async()=>{fundingCalls++;throw Error('not allowed')}});
 assert.equal(fundingCalls,0);assert.equal(report.success.issued,1);assert.equal(report.exitCode,2);
 assert.equal(report.rounds[0].fundingObservation,null);
});

test('selected funding HTTP, schema or contract mapping failures cannot become diagnostic success',async()=>{
 for(const fundingProbe of [async()=>({category:'HTTP',httpStatus:503,processClosed:true,body:''}),
  async()=>({category:'OK',httpStatus:200,processClosed:true,body:'not-json'}),
  async()=>ok([{ticker_id:'BTC_USDT',funding_rate:0.0001,next_funding_rate:0.0002,next_funding_rate_timestamp:START+3600000}])]){
  const result=await diagnoseOrangeXContinuous({...fixture(),includeBinance:false,includeFunding:true,fundingProbe,rounds:2});
  assert.equal(result.monitor.marketDataStatus,'PASS','valid captured books remain valid observations');
  assert.equal(result.success.fundingObservationsCompleted,false);assert.equal(result.exitCode,1);
  assert.equal(result.status,'INCOMPLETE');assert.equal(result.realDataAutoEntryEnabled,false);
 }
});

test('selected Binance server-time schema failures cannot become complete continuous observations',async()=>{
 const state=fixture(),original=state.binanceProbe;
 const report=await diagnoseOrangeXContinuous({...state,rounds:2,binanceProbe:async(kind,symbol)=>
  kind==='time'?{category:'OK',httpStatus:200,processClosed:true,body:'{}'}:original(kind,symbol)});
 assert.equal(report.success.httpSuccessRate,1);assert.equal(report.monitor.marketDataStatus,'PASS');
 assert.equal(report.success.binanceObservationsCompleted,false);assert.equal(report.exitCode,1);
 assert.equal(report.rounds[0].binanceClockObservation,null);assert.equal(report.realDataAutoEntryEnabled,false);
});

test('fixed public transports preserve curl proxy/CA policy and extract only safe Date, Age, cache directives and timings',async()=>{
 let invocation;
 const spawnProcess=(command,args,options)=>{
  invocation={command,args,options};const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();
  queueMicrotask(()=>{child.stdout.write('HTTP/1.1 200 Connection established\r\nProxy-Secret: do-not-export\r\n\r\nHTTP/2 200\r\nDate: Sat, 31 Oct 2026 00:59:19 GMT\r\nAge: 23\r\nCache-Control: public, max-age=30, secret=do-not-export\r\nX-Secret: do-not-export\r\n\r\n{"result":[]}\n__SIGNALLAB_MONITOR_TIMING__0.125,0.075\n__SIGNALLAB_CURL_STATUS__200,200');
   child.stderr.write('do-not-export');child.emit('close',0)});return child;
 };
 const result=await orangeXMonitorProbe('tickers',NAME,{platform:'win32',spawnProcess,targetURL:'https://evil.invalid/private'});
 assert.equal(invocation.command,'curl.exe');assert.equal(invocation.args[0],'--disable');assert.equal(invocation.options.shell,false);
 assert.equal(invocation.args[invocation.args.indexOf('--url')+1],'https://api.orangex.com/api/v1/public/tickers?instrument_name='+NAME);
 assert.equal(Object.hasOwn(invocation.options,'env'),false);assert.equal(result.body,'{"result":[]}');assert.equal(result.httpAgeSeconds,23);
 assert.equal(result.httpDateMs,Date.parse('2026-10-31T00:59:19Z'));assert.equal(result.curlDurationMs,125);assert.equal(result.curlTimeToFirstByteMs,75);
 assert.deepEqual(result.cacheObservation,{noCache:false,noStore:false,public:true,private:false,maxAgeSeconds:30,sharedMaxAgeSeconds:null});
 assert.doesNotMatch(JSON.stringify(result),/do-not-export/);
 await binanceMonitorProbe('book','BTCUSDT',{platform:'win32',spawnProcess});
 assert.equal(invocation.args[invocation.args.indexOf('--url')+1],'https://fapi.binance.com/fapi/v1/ticker/bookTicker?symbol=BTCUSDT');
 for(const forbidden of ['--insecure','--noproxy','--proxy','--user','--netrc','--location','--data'])assert.ok(!invocation.args.includes(forbidden));
 assert.throws(()=>binanceMonitorURL('orders','BTCUSDT'),/NOT_ALLOWED/);assert.throws(()=>binanceMonitorURL('book','BTCUSDT&key=x'),/NOT_ALLOWED/);
});

test('server Date is only an uncertain edge/cache observation and never corrects an old source clock into eligibility',async()=>{
 const state=fixture({oldMark:true}),report=await diagnoseOrangeXContinuous({...state,rounds:2,includeBinance:false});
 assert.equal(report.requests[0].serverDateClockObservation.usedToCorrectSourceEligibility,false);
 assert.ok(report.requests[0].serverDateClockObservation.uncertaintyMs>=1000);
 assert.equal(report.requests[0].serverDateClockObservation.positiveAgeHeaderObserved,true);
 assert.equal(report.monitor.markets[0].atCapture.markClock.status,'FAIL');assert.equal(report.exitCode,1);
});

test('local wall clock regression nulls HTTP Date and Binance server-time offset estimates',async()=>{
 let wall=START,mono=0;
 const report=await diagnoseOrangeXContinuous({dataSource:'SYNTHETIC_TEST',rounds:2,intervalMs:0,now:()=>wall,monotonicNow:()=>mono,delay:async()=>{},
  orangexProbe:async(kind,name)=>{wall+=5;mono+=5;return {...ok(kind==='book'?depth(name,wall-24000):[{instrument_name:name,mark_price:100.05,timestamp:wall-24000}]),httpDateMs:wall}},
  binanceProbe:async(kind,symbol)=>{mono+=5;wall+=kind==='time'?-1000:5;return {category:'OK',httpStatus:200,httpDateMs:wall,
   body:JSON.stringify(kind==='time'?{serverTime:START}:kind==='contracts'?{symbols:[]}:{symbol,bidPrice:'100',askPrice:'100.1',time:wall})}}});
 const row=report.requests.find(row=>row.exchange==='BINANCE'&&row.kind==='time');assert.equal(row.clockStatus,'FAIL');
 assert.equal(row.serverDateClockObservation.status,'FAIL');assert.equal(row.serverDateClockObservation.serverMinusLocalMidpointMs,null);
 assert.equal(report.rounds[0].binanceClockObservation.status,'FAIL');assert.equal(report.rounds[0].binanceClockObservation.serverMinusLocalMidpointMs,null);
 assert.equal(report.localClockStatus,'FAIL');assert.ok(report.observationDurationMs>=0);
});

test('public CLI bounds cannot disable age/stall policies or request private endpoints and large windows remain bounded',()=>{
 assert.deepEqual(continuousOptions(['--rounds','6','--interval-ms','5000','--without-binance']),{rounds:6,intervalMs:5000,includeBinance:false});
 for(const args of [['--mode','LIVE'],['--rounds','1'],['--rounds','13'],['--interval-ms','30001'],['--max-age-ms','90001'],['--stall-ms','0'],['--url','https://example.com'],['--rounds','2','--rounds','2']])assert.throws(()=>continuousOptions(args));
 for(const config of [{maxQuoteAgeMs:90001},{stallAfterMs:0},{maxSamples:145}])assert.throws(()=>monitor(config));
});
