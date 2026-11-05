import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {compareIssue6Strategies,summarizeStrategyTrades} from '../strategy_validation.mjs';
import {compareIssue6File,strategyComparisonOptions} from '../scripts/compare-issue6-strategies.mjs';
import {marketSeries} from './fixtures/pipeline_market.mjs';

const NOW=Date.parse('2026-11-04T12:00:00Z'),HOUR=3600000,END=NOW-1000;
const data=()=>{const {h1,h4}=marketSeries('breakout-long',NOW);return {symbol:'BTCUSDT',dataSource:'SYNTHETIC_TEST',h1,h4,
 cutoffs:Array.from({length:8},(_,index)=>END-(7-index)*HOUR),split:{trainFraction:.5,walkForwardFolds:2}}};
const metricContext={strategy:'LEGACY_V58',dataSource:'SYNTHETIC_TEST',startAt:NOW-HOUR,endAt:NOW,initialCapitalUSD:100};
const trade=(id,gross,patch={})=>({id,strategy:'LEGACY_V58',dataSource:'SYNTHETIC_TEST',pnlBasis:'REFERENCE_GROSS_MINUS_INDEPENDENT_COSTS',
 openedAt:NOW-3000,closedAt:NOW-2000,grossReferencePnLUSD:gross,feesUSD:1,slippageUSD:1,spreadUSD:.5,fundingUSD:.5,plannedRiskUSD:6,...patch});

test('same completed prefixes compare the bundled old score with the new score without claiming simulated fills or improved returns',()=>{
 const input=data(),before=structuredClone(input),result=compareIssue6Strategies(input),last=result.decisions.at(-1);
 assert.equal(result.decisions.length,8);assert.deepEqual(input,before);
 assert.equal(last.legacy.score,100);assert.equal(last.current.score,90);
 assert.equal(last.legacy.technicalQualified,true);assert.equal(last.current.technicalQualified,true);
 assert.equal(last.current.executableSignalApproved,false);assert.equal(result.policy.currentThreshold,90);
 assert.equal(Object.values(result.policy.currentWeights).reduce((a,b)=>a+b,0),100);
 assert.equal(result.policy.weightsFrozen,true);assert.equal(result.policy.trainingPerformed,false);
 assert.equal(result.full.baseline.technicalSignalCount,1);assert.equal(result.full.issue6.technicalSignalCount,1);
 for(const metrics of Object.values(result.full.metrics)){
  assert.equal(metrics.status,'UNVERIFIED');assert.equal(metrics.winRate,null);assert.equal(metrics.netPnLUSD,null);
  assert.equal(metrics.feesUSD,null);assert.equal(metrics.maxDrawdownUSD,null);
 }
 assert.equal(result.performanceImprovement,'UNVERIFIED');assert.equal(result.executionLedgerGenerated,false);
 assert.equal(result.liveOrdersEnabled,false);assert.equal(result.realDataAutoEntryEnabled,false);
 assert.ok(result.limitations.includes('SYNTHETIC_RESULTS_ARE_NOT_REAL_EXCHANGE_RETURNS'));
});

test('future OHLC and trade tails cannot alter an earlier immutable decision prefix',()=>{
 const input=data(),before=compareIssue6Strategies(input),future=structuredClone(input);
 future.h1.push([NOW+HOUR,'1','999999','0','NaN','999999999',NOW+2*HOUR-1,'999999999']);
 future.h4.push([NOW+4*HOUR,'1','999999','0','NaN','999999999',NOW+8*HOUR-1,'999999999']);
 future.aggTrades=[{a:900,p:'not-a-price',q:'not-a-quantity',T:NOW+HOUR}];
 const after=compareIssue6Strategies(future);
 assert.deepEqual(after.decisions,before.decisions);
 for(const row of after.decisions){assert.ok(row.lastClosed1hAt<row.cutoff);assert.ok(row.lastClosed4hAt<row.cutoff);assert.ok(row.earliestModelEntryAt>row.cutoff)}
});

test('out-of-sample and expanding walk-forward folds never train on their own future test window',()=>{
 const result=compareIssue6Strategies(data());
 assert.equal(result.inSample.decisionCount,4);assert.equal(result.outOfSample.decisionCount,4);
 assert.ok(result.inSample.endAt<result.outOfSample.startAt);assert.equal(result.walkForward.length,2);
 for(const fold of result.walkForward){assert.ok(fold.training.endAt<fold.test.startAt);
  assert.equal(fold.parametersChangedUsingTestData,false);assert.equal(fold.trainingPerformed,false)}
 assert.equal(result.policy.thresholdCalibratedFromFuture,false);
 const explicit=compareIssue6Strategies({...data(),split:{inSampleEndAt:END-4*HOUR,trainFraction:.9,walkForwardFolds:2}});
 assert.equal(explicit.inSample.decisionCount,4,'explicit chronological boundary wins over descriptive fraction');
});

test('independent fee, slippage, spread and funding costs produce net PNL, profit factor and drawdown from an explicit model ledger',()=>{
 const rows=[trade('profit',10),trade('loss',-4,{closedAt:NOW-1000,slippageUSD:.5,fundingUSD:0})],metrics=summarizeStrategyTrades(rows,metricContext);
 assert.equal(metrics.status,'CALCULATED_FROM_SUPPLIED_SIMULATED_LEDGER');assert.equal(metrics.trades,2);
 assert.equal(metrics.winRate,.5);assert.equal(metrics.netPnLUSD,1);assert.ok(Math.abs(metrics.profitFactor-7/6)<1e-12);
 assert.equal(metrics.feesUSD,2);assert.equal(metrics.slippageUSD,1.5);assert.equal(metrics.spreadUSD,1);assert.equal(metrics.fundingUSD,.5);
 assert.equal(metrics.maxDrawdownUSD,6);assert.ok(Math.abs(metrics.maxDrawdownPercent-6/107*100)<1e-12);
 assert.equal(metrics.expectancyUSD,.5);assert.ok(Math.abs(metrics.averageRealizedR-1/12)<1e-12);
 assert.equal(metrics.actualExchangePerformanceVerified,false);assert.equal(metrics.sampleStatus,'INSUFFICIENT_SAMPLE');
});

test('unknown costs, mismatched PNL, duplicate IDs and an already-filled gross basis never become zero-cost valid performance',()=>{
 for(const mutate of [rows=>{delete rows[0].fundingUSD},rows=>{rows[0].feesUSD=null},rows=>{rows[0].netPnLUSD=999},
  rows=>{rows.push({...rows[0]})},rows=>{rows[0].pnlBasis='ALREADY_FILLED_GROSS'},rows=>{rows[0].dataSource='LIVE_MARKET_PAPER'}]){
  const rows=[trade('p',10)];mutate(rows);const result=summarizeStrategyTrades(rows,metricContext);
  assert.equal(result.status,'UNVERIFIED');assert.equal(result.netPnLUSD,null);assert.equal(result.profitFactor,null);
 }
 const future=[trade('future',100,{closedAt:NOW+HOUR})];
 assert.equal(summarizeStrategyTrades(future,metricContext).netPnLUSD,null,'a future close cannot count as training-period profit');
});

test('a no-loss model has undefined profit factor rather than JSON Infinity and missing capital leaves percentage drawdown unknown',()=>{
 const metrics=summarizeStrategyTrades([trade('p',10)],{...metricContext,initialCapitalUSD:undefined});
 assert.equal(metrics.profitFactor,null);assert.equal(metrics.profitFactorStatus,'UNDEFINED_NO_LOSS');
 assert.equal(metrics.maxDrawdownUSD,0);assert.equal(metrics.maxDrawdownPercent,null);
 assert.equal(JSON.stringify(metrics).includes('Infinity'),false);
});

test('only an as-of complete trade-volume snapshot with explicit units and costs can create a new management calculation',()=>{
 const input=data(),start=END-60001,end=END-1;
 input.profileSnapshots=[{symbol:'BTCUSDT',windowStart:start,windowEnd:end,receivedAt:end,tickSize:.01,bucketTicks:1,
  coverage:{complete:true,truncated:false,fromTime:start,toTime:end,pages:1},
  trades:Array.from({length:42},(_,i)=>({a:i,p:String([109,110,110.01,119,120,120.01,129,130,130.01,131][i%10]),
   q:String(i%10===1?20:i%10===4?30:i%10===7?15:1),T:start+Math.floor(i*60000/41)}))}];
 input.planningParameters={quantity:.2,tickSize:.01,quantityStep:.001,minQuantity:.001,minNotional:1,contractSizeBase:1,
  quantityUnit:'BASE_ASSET',notionalCurrency:'USDT',unitsVerified:true,maxRiskUSD:6,
  costs:{makerRate:.0002,takerRate:.0006,slippageBps:1,spreadBps:1,fundingRate:.0001,assumption:'SYNTHETIC_TEST'}};
 const result=compareIssue6Strategies(input),management=result.decisions.at(-1).management;
 assert.equal(management.status,'MODEL_PLAN_CALCULATED',JSON.stringify(management));assert.equal(management.plan.targets.length,3);
 assert.equal(result.full.newManagementPlans,1);assert.equal(management.plan.executionApproved,false);
 const future=structuredClone(input);future.profileSnapshots[0].receivedAt=END+1;
 assert.equal(compareIssue6Strategies(future).decisions.at(-1).management.plan,null,'future receipt cannot backdate a profile');
 const missing=structuredClone(input);delete missing.profileSnapshots[0].coverage;
 assert.equal(compareIssue6Strategies(missing).decisions.at(-1).management.plan,null);
 const otherSymbol=structuredClone(input);otherSymbol.profileSnapshots[0].symbol='ETHUSDT';
 assert.equal(compareIssue6Strategies(otherSymbol).decisions.at(-1).management.plan,null,'profile wrapper cannot silently relabel another instrument');
 const mixedTrade=structuredClone(input);mixedTrade.profileSnapshots[0].trades[0].symbol='ETHUSDT';
 assert.equal(compareIssue6Strategies(mixedTrade).decisions.at(-1).management.reason,'PROFILE_TRADE_INSTRUMENT_MISMATCH');
 assert.equal(result.full.metrics.ISSUE6_VOLUME.netPnLUSD,null,'a target calculation is not a completed execution ledger');
});

test('insufficient EMA history remains unavailable, sources cannot be promoted, and work is bounded',()=>{
 const input=data();input.h4=input.h4.slice(-100);const result=compareIssue6Strategies(input);
 assert.equal(result.full.issue6.evaluable,0);assert.equal(result.full.issue6.technicalSignalCount,null);
 assert.equal(result.decisions.at(-1).current.score,null);
 for(const patch of [{dataSource:'LIVE_MARKET_PAPER'},{cutoffs:[0]},{cutoffs:[END],split:{trainFraction:1}},
  {cutoffs:[END],split:{walkForwardFolds:21}}])assert.throws(()=>compareIssue6Strategies({...data(),...patch}));
 assert.throws(()=>compareIssue6Strategies(data(),{maxCutoffs:2}),/TOO_MANY_CUTOFFS/);
 const tainted=data();tainted.dataSource='HISTORICAL_REPLAY';tainted.h1[0]={time:END,closeTime:END+1,dataSource:'SYNTHETIC_TEST'};
 assert.throws(()=>compareIssue6Strategies(tainted),/SYNTHETIC_INPUT/);
 const snapshotTaint=data();snapshotTaint.dataSource='HISTORICAL_REPLAY';snapshotTaint.profileSnapshots=[{dataSource:'SYNTHETIC_TEST'}];
 assert.throws(()=>compareIssue6Strategies(snapshotTaint),/SYNTHETIC_INPUT/);
});

test('file review is offline, preserves its input digest and never returns arbitrary input fields',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'signal-strategy-compare-'));
 try{const file=path.join(dir,'past candles.json'),input={...data(),private_key:'never-output-fixture'},bytes=JSON.stringify(input);
  fs.writeFileSync(file,bytes);const result=compareIssue6File(file);
  assert.equal(result.sourceSHA256,createHash('sha256').update(bytes).digest('hex'));
  assert.equal(fs.readFileSync(file,'utf8'),bytes);assert.equal(result.inputUnchanged,true);
  assert.doesNotMatch(JSON.stringify(result),/never-output-fixture/);
  assert.deepEqual(strategyComparisonOptions(['--input',file]),{file});
  assert.throws(()=>strategyComparisonOptions(['--mode','LIVE']));
 }finally{fs.rmSync(dir,{recursive:true,force:true})}
});
