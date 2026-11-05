import test from 'node:test';
import assert from 'node:assert/strict';
import {analyze} from '../research/legacy_v58/engine.mjs';
import {evaluateSignal} from '../signal_pipeline.mjs';
import {marketSeries,ENTRY} from './fixtures/pipeline_market.mjs';
import {normalizeOrangeXPaperSignal,alignOrangeXPaperSignal} from '../orangex_paper_signal.mjs';
import {OrangeXPaperEngine} from '../orangex_paper.mjs';

// Synthetic candles exercise the retained pre-Issue6 strategy for record compatibility.
// The production single-score/profile strategy has separate management tests.
// No live exchange response, authentication or user records are used here.
function nativeFixture(scenario='breakout-long'){
 const at=Date.now(),series=marketSeries(scenario,at),row=analyze('BTCUSDT',series.h1,series.h4,[],ENTRY,{quoteVolume:1e8});
 const now=Date.now(),quote={bid:ENTRY-.005,ask:ENTRY+.005};
 const decision=evaluateSignal(row,{verified:true,venueConnected:true,listing:{markPrice:ENTRY,quoteUpdatedAt:now,
  quote1k:quote,quoteBase:quote},price:ENTRY,priceAt:now,statsReceivedAt:now,now});
 return {series,row:{...row,decision,qualified:decision.ready,strategyVersion:'LEGACY_V58',managementVersion:'LEGACY_R_MULTIPLES'},now,
  options:{now,source:'SYNTHETIC_FIXTURE',instrumentName:'BTC-USDT-PERPETUAL'}};
}

test('preserved legacy scanner produces approved synthetic 1H/4H LONG and SHORT signals for existing PAPER records',()=>{
 for(const [scenario,direction,score]of [['breakout-long','LONG',100],['breakout-short','SHORT',100],
  ['retest-long','LONG',100],['retest-short','SHORT',100],['bonus-missing-long','LONG',90]]){
  const {row,options}=nativeFixture(scenario);
  assert.equal(row.decision.ready,true,scenario);assert.equal(row.direction,direction);assert.equal(row.score,score);
  const normalized=normalizeOrangeXPaperSignal(row,options);
  assert.equal(normalized.ok,true,scenario+': '+normalized.reasons.join(','));
  assert.equal(normalized.signal.direction,direction);assert.equal(normalized.signal.timeframe,'1h');
  assert.equal(normalized.signal.trendTimeframe,'4h');assert.equal(normalized.signal.confirmed,true);
  assert.equal(normalized.signal.trendConfirmed,true);assert.equal(normalized.signal.confirmationEvidence.trendClosedAt,null);
  assert.deepEqual(normalized.signal.targets,[row.target1,row.target2,row.target3]);
  assert.equal(normalized.signal.scoreMeaning,'RULE_COMPLETENESS_NOT_WIN_PROBABILITY');
  assert.equal(normalized.signal.realDataAutoEntryEnabled,false);assert.equal(normalized.signal.liveOrdersEnabled,false);
 }
});

test('weak volume, insufficient hourly liquidity and range cases never become normalized final PAPER signals',()=>{
 for(const scenario of ['weak-volume','illiquid-hour','range']){
  const {row,options}=nativeFixture(scenario),result=normalizeOrangeXPaperSignal(row,options);
  assert.equal(row.decision.ready,false,scenario);assert.equal(result.ok,false,scenario);
  assert.ok(result.reasons.includes('FINAL_SIGNAL_NOT_APPROVED'));
 }
});

test('score, confirmation flags or a stale prior approval cannot replace mandatory closed-candle evidence',()=>{
 const {row,options}=nativeFixture();
 const mutations=[
  {patternConfirmed:false},{patternInvalidated:true},{patternTimeframe:'4h'},{timeframe:'1d'},{trendTimeframe:'1h'},
  {dataValidation:{valid:false}},{scannedAt:options.now-21*60000},{patternConfirmedAt:options.now+1},
  {patternConfirmedAt:options.now-2*3600000-1},{trend:'down'},
  {quality:{...row.quality,checks:[]}},{quality:{...row.quality,validUntil:options.now-1}},
  {quality:{...row.quality,checks:row.quality.checks.map(check=>check.key==='fresh'?{...check,passed:false}:check)}},
  {quality:{...row.quality,checks:[...row.quality.checks,row.quality.checks.find(check=>check.key==='4hAligned')]}},
  {decision:{...row.decision,ready:false}},{decision:{...row.decision,execution:{eligible:false}}},
  {decision:undefined},{technicalQualified:false},{score:89},{stop:row.entry+1},{target1:row.entry-1},
  {targets:[]},{targets:null},{target3:null}
 ];
 for(const patch of mutations){
  const result=normalizeOrangeXPaperSignal({...row,...patch},options);assert.equal(result.ok,false,JSON.stringify(patch));
 }
});

test('explicit 1H and 4H source close times are checked but never manufactured from the 1H clock',()=>{
 const {series,row,options}=nativeFixture(),proof={patternTimeframe:'1h',trendTimeframe:'4h',
  patternClosedAt:row.patternConfirmedAt,trendClosedAt:Number(series.h4.at(-1)[6])};
 const good=normalizeOrangeXPaperSignal(row,{...options,confirmationEvidence:proof});
 assert.equal(good.ok,true);assert.equal(good.signal.confirmationEvidence.trendClosedAt,proof.trendClosedAt);
 for(const patch of [{trendTimeframe:'1d'},{trendClosedAt:options.now+1},{patternClosedAt:row.patternConfirmedAt-1},
  {trendClosedAt:options.now-255*60000-1},{trendClosedAt:null}])
  assert.equal(normalizeOrangeXPaperSignal(row,{...options,confirmationEvidence:{...proof,...patch}}).ok,false);
});

test('the instrument mapping and data provenance are explicit and no input is mutated',()=>{
 const {row,options}=nativeFixture(),before=structuredClone(row);
 const a=normalizeOrangeXPaperSignal(row,options),b=normalizeOrangeXPaperSignal(row,options);
 assert.equal(a.signal.key,b.signal.key);assert.deepEqual(row,before);
 assert.equal(normalizeOrangeXPaperSignal(row,{...options,instrumentName:undefined}).ok,false);
 assert.equal(normalizeOrangeXPaperSignal(row,{...options,instrumentName:'ETH-USDT-PERPETUAL'}).ok,false);
 assert.equal(normalizeOrangeXPaperSignal(row,{...options,source:'UNOBSERVED'}).ok,false);
 for(const source of ['SIGNAL_LAB_SCANNER','REAL_PUBLIC_READ_ONLY','WINDOWS_DIAGNOSTIC_REPLAY']){
  const result=normalizeOrangeXPaperSignal(row,{...options,source});
  assert.equal(result.ok,true);assert.equal(result.signal.signalSource,source);assert.equal(result.signal.realDataAutoEntryEnabled,false);
 }
});

test('bad clock or malformed payload is rejected without printing input-derived diagnostics',()=>{
 assert.equal(normalizeOrangeXPaperSignal(null).ok,false);
 const {row,options}=nativeFixture();
 for(const patch of [{now:NaN},{now:-1},{maxSignalAgeMs:0},{maxAnalysisAgeMs:Infinity}])
  assert.equal(normalizeOrangeXPaperSignal(row,{...options,...patch}).ok,false);
 const result=normalizeOrangeXPaperSignal({access_token:'synthetic-secret'});
 assert.equal(result.ok,false);assert.doesNotMatch(JSON.stringify(result),/synthetic-secret/);
});

const syntheticContract=()=>({instrumentName:'BTC-USDT-PERPETUAL',symbol:'BTCUSDT',source:'SYNTHETIC_FIXTURE',
 quantityUnit:'CONTRACT',contractSizeBase:1,minQty:.001,qtyStep:.001,minNotional:1,priceTick:.01,
 makerRate:.0002,takerRate:.0006,feeUnit:'FRACTION',fundingRate:.0001,fundingIntervalMs:8*3600000,unitsVerifiedForSimulation:true});
const syntheticSettings=()=>({capitalUSD:10000,leverage:3,maxRiskUSD:6,dailyLossLimitUSD:18,maxPositions:2,
 maxPositionNotionalUSD:500,maxTotalNotionalUSD:1500,maxQuoteAgeMs:90000,maxSignalAgeMs:7200000,
 entryTimeoutMs:1200000,maxSpreadBps:30,maxSlippageBps:100,killSwitch:false});

test('final plan keeps original scanner prices and safely aligns LONG and SHORT to an explicit synthetic tick',()=>{
 for(const scenario of ['breakout-long','breakout-short']){
  const {row,options}=nativeFixture(scenario),normal=normalizeOrangeXPaperSignal(row,options).signal;
  const before=structuredClone(normal),contract=syntheticContract(),aligned=alignOrangeXPaperSignal(normal,contract);
  assert.equal(aligned.ok,true,aligned.reasons.join(','));assert.deepEqual(normal,before);
  assert.deepEqual(aligned.sourcePrices,{entry:row.entry,stop:row.stop,targets:[row.target1,row.target2,row.target3]});
  assert.equal(aligned.signal.sourcePrices.stop,row.stop);
  assert.match(aligned.signal.key,/^ORANGEX_PAPER:[a-f0-9]{64}$/);
  assert.match(aligned.signal.sourceSignalKey,new RegExp(row.pattern));
  const plan=aligned.signal,dir=row.direction==='LONG'?1:-1;
  assert.ok(dir*(plan.entry-row.entry)>=-1e-10);assert.ok(dir*(plan.stop-row.stop)<=1e-10);
  assert.ok(Math.abs(plan.stop-row.stop)<contract.priceTick+1e-10);
  for(const [index,price]of plan.targets.entries())assert.ok(dir*(price-aligned.sourcePrices.targets[index])>=-1e-10);
  assert.equal(plan.priceAlignment.riskMustBeRecalculated,true);
 }
});

test('no missing tick, real-source manifest or collapsed grid plan is silently replaced with a guessed execution rule',()=>{
 const {row,options}=nativeFixture(),normal=normalizeOrangeXPaperSignal(row,options).signal;
 for(const patch of [{priceTick:null},{priceTick:0},{priceTick:NaN},{source:'REAL_PUBLIC_READ_ONLY'},
  {unitsVerifiedForSimulation:false},{symbol:'ETHUSDT'},{priceTick:1000},{priceTick:1e-20}])
  assert.equal(alignOrangeXPaperSignal(normal,{...syntheticContract(),...patch}).ok,false,JSON.stringify(patch));
 assert.equal(alignOrangeXPaperSignal({...normal,dataSource:'SIGNAL_LAB_SCANNER'},syntheticContract()).ok,false);
 assert.equal(alignOrangeXPaperSignal({...normal,targets:[]},syntheticContract()).ok,false);
});

test('native confirmed LONG reaches aligned targets and CLOSE, while native SHORT records its actual-depth stop loss',()=>{
 for(const [scenario,direction]of [['breakout-long','LONG'],['breakout-short','SHORT']]){
  const {row,options}=nativeFixture(scenario),contract=syntheticContract();
  const normalized=normalizeOrangeXPaperSignal(row,options);assert.equal(normalized.ok,true);
  const aligned=alignOrangeXPaperSignal(normalized.signal,contract);assert.equal(aligned.ok,true);
  let clock=options.now;
  const engine=new OrangeXPaperEngine({}, {now:()=>clock,settings:syntheticSettings(),contracts:[contract]});
  assert.equal(engine.register(aligned.signal,{dataSource:'SYNTHETIC_FIXTURE'}),true);
  const tick=(bid,ask)=>{
   clock++;
   engine.onMarket({instrumentName:contract.instrumentName,dataSource:'SYNTHETIC_FIXTURE',bids:[[bid,1000]],asks:[[ask,1000]],
    timestamp:clock,markPrice:(bid+ask)/2,markPriceAt:clock});
  };
  tick(aligned.signal.entry,aligned.signal.entry+contract.priceTick);
  const opened=engine.snapshot().open[0];assert.ok(opened,JSON.stringify(engine.snapshot().rejections));
  assert.equal(opened.direction,direction);assert.ok(opened.plannedRiskUSD<=6+1e-8,'wider rounded stop is re-sized inside the risk budget');
  if(direction==='LONG')for(const target of opened.targets)tick(target,target+contract.priceTick);
  else tick(opened.stop-contract.priceTick,opened.stop);
  const snapshot=engine.snapshot();assert.equal(snapshot.open.length,0);assert.equal(snapshot.closed.length,1);
  const closed=snapshot.closed[0];assert.equal(closed.key,aligned.signal.key);assert.ok(closed.feesUSD>0);
  if(direction==='LONG'){
   assert.deepEqual(closed.exitParts.map(part=>part.type),['TP1','TP2','TP3']);assert.ok(closed.realizedPnLUSD>0);
   for(const [index,weight]of [.4,.35,.25].entries())assert.ok(Math.abs(closed.exitParts[index].quantity-opened.quantityOriginal*weight)<1e-8);
  }else{
   assert.equal(closed.exitParts[0].type,'STOP');assert.ok(closed.realizedPnLUSD<0);
  }
  const restored=new OrangeXPaperEngine(engine.exportState(),{now:()=>clock});
  assert.equal(restored.snapshot().closed[0].realizedPnLUSD,closed.realizedPnLUSD,'CLOSE PNL survives engine state recovery');
  assert.equal(snapshot.realDataEntryEnabled,false);
 }
});
