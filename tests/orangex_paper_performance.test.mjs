import test from 'node:test';
import assert from 'node:assert/strict';
import {auditOrangeXPaperAccounting,analyzeOrangeXPaperPerformance} from '../orangex_paper_performance.mjs';

// Hand-calculated synthetic ledgers. Values are not OrangeX contract or fee facts.
const START=Date.parse('2026-01-31T14:59:00Z');
const clone=value=>structuredClone(value);
const approx=(actual,expected)=>assert.ok(Math.abs(actual-expected)<1e-7,`${actual} vs ${expected}`);
function trade({key='long-btc',direction='LONG',asset='BTC',entry=100,exit=110,quantity=2,factor=1,
 openedAt=START,closedAt=START+30000,metadata=true}={}){
 const dir=direction==='LONG'?1:-1,rate=.001,
  contract={instrumentName:`${asset}-USDT-PERPETUAL`,symbol:asset+'USDT',source:'SYNTHETIC_FIXTURE',unitsVerifiedForSimulation:true,quantityUnit:'CONTRACT',contractSizeBase:factor,
   feeUnit:'FRACTION',makerRate:.0005,takerRate:rate,fundingRate:.0001,fundingIntervalMs:28800000};
 const entryPart={quantity,price:entry,at:openedAt,feeUSD:quantity*entry*factor*rate,liquidity:'TAKER'},
  exitPart={type:'CLOSE',quantity,price:exit,at:closedAt,feeUSD:quantity*exit*factor*rate,grossUSD:dir*(exit-entry)*quantity*factor};
 if(metadata)for(const [part,orderSign]of [[entryPart,dir],[exitPart,-dir]]){
  part.referencePrice=part.price-orderSign*.2;part.marketMidPrice=part.price-orderSign*.5;
  part.slippageUSD=.2*quantity*factor;part.spreadCostUSD=.3*quantity*factor;
 }
 const fees=entryPart.feeUSD+exitPart.feeUSD;
 return {key,instrumentName:`${asset}-USDT-PERPETUAL`,symbol:asset+'USDT',direction,contract,dataSource:'SYNTHETIC_FIXTURE',
  quantityOriginal:quantity,quantityRemaining:0,entryPrice:entry,stop:entry-dir*10,targets:[20,30,40].map(delta=>entry+dir*delta),
  plannedRiskUSD:20,openedAt,closedAt,entryParts:[entryPart],exitParts:[exitPart],fundingParts:[],
  feesUSD:fees,fundingUSD:0,realizedGrossUSD:exitPart.grossUSD,realizedPnLUSD:exitPart.grossUSD-fees};
}
const state=(closed=[],open=[],extra={})=>({schemaVersion:1,executionMode:'SYNTHETIC_TEST',runKind:'FORWARD_PAPER',
 settings:{capitalUSD:1000},closed,open,...extra});

test('independent audit recomputes contract-size fees, gross and net rather than trusting a coherent but wrong ledger',()=>{
 const value=trade({factor:2}),input=state([value]),audit=auditOrangeXPaperAccounting(input,{now:START+30000});
 assert.equal(audit.valid,true);assert.equal(audit.complete,true);approx(audit.totals.grossPnLUSD,40);
 approx(audit.totals.feesUSD,.84);approx(audit.totals.netPnLUSD,39.16);
 const wrong=clone(input);wrong.closed[0].entryParts[0].feeUSD+=1;wrong.closed[0].feesUSD+=1;wrong.closed[0].realizedPnLUSD-=1;
 const result=auditOrangeXPaperAccounting(wrong,{now:START+30000});assert.equal(result.valid,false);
 assert.ok(result.issues.some(row=>row.code==='FEE_MISMATCH'));assert.equal(result.totals,null);
 const grossWrong=clone(input);grossWrong.closed[0].exitParts[0].grossUSD+=100;grossWrong.closed[0].realizedGrossUSD+=100;grossWrong.closed[0].realizedPnLUSD+=100;
 assert.ok(auditOrangeXPaperAccounting(grossWrong,{now:START+30000}).issues.some(row=>row.code==='GROSS_MISMATCH'));
});

test('closed-trade performance, realized R, payoff and period grouping use independent cost-inclusive amounts',()=>{
 const a=trade(),b=trade({key:'short-eth',direction:'SHORT',asset:'ETH',openedAt:START+120000,closedAt:START+180000}),
  value=state([b,a]),result=analyzeOrangeXPaperPerformance(value,{now:START+180000});
 assert.equal(result.audit.valid,true);assert.equal(result.metrics.totalTrades,2);approx(result.metrics.winRatePct,50);
 approx(result.metrics.grossPnLUSD,0);approx(result.metrics.feesUSD,.84);approx(result.metrics.netPnLUSD,-.84);
 approx(result.metrics.expectancyUSD,-.42);approx(result.metrics.averageRealizedR,-.021);
 approx(result.metrics.averagePlannedRR,2.85);approx(result.metrics.profitFactor,19.58/20.42);
 approx(result.metrics.averageWinLossRatio,19.58/20.42);approx(result.metrics.averageHoldingMs,45000);
 assert.equal(result.metrics.currentLossStreak,1);assert.equal(result.metrics.maxLossStreak,1);
 assert.equal(result.directions.LONG.totalTrades,1);approx(result.directions.LONG.netPnLUSD,19.58);
 assert.equal(result.directions.SHORT.totalTrades,1);approx(result.assets.ETH.netPnLUSD,-20.42);
 assert.equal(result.assets.BTC.totalTrades,1);assert.equal(result.assets.SOL.totalTrades,0);assert.equal(result.assets.SOL.winRatePct,null);
 assert.deepEqual(result.periods.daily.map(row=>row.period),['2026-01-31','2026-02-01']);
 approx(result.periods.daily[0].pnlUSD,19.58);approx(result.periods.daily[1].pnlUSD,-20.42);
 assert.deepEqual(result.periods.monthly.map(row=>row.period),['2026-01','2026-02']);
 assert.deepEqual(result.periods.weekly.map(row=>row.period),['2026-W05']);
 assert.equal(result.sample.sufficient,false);assert.ok(result.sample.reasons.includes('INSUFFICIENT_SAMPLE'));
 assert.equal(result.sample.strategyValidated,false);assert.equal(result.realMarketPerformanceVerified,false);
});

test('slippage and spread attribution are not subtracted twice from actual-fill gross PNL',()=>{
 const result=analyzeOrangeXPaperPerformance(state([trade()]),{now:START+30000}),m=result.metrics;
 approx(m.grossPnLUSD,20);approx(m.frictionlessPnLUSD,22);approx(m.slippageUSD,.8);approx(m.spreadCostUSD,1.2);
 approx(m.feesUSD,.42);approx(m.netPnLUSD,19.58);
 approx(m.frictionlessPnLUSD-m.slippageUSD-m.spreadCostUSD-m.feesUSD-m.fundingUSD,m.netPnLUSD);
 assert.equal(result.definitions.slippage,'DEPTH_COST_VS_SAME_SIDE_REFERENCE_ALREADY_EMBEDDED_IN_ACTUAL_FILL_PNL');
 const old=analyzeOrangeXPaperPerformance(state([trade({metadata:false})]),{now:START+30000});
 assert.equal(old.audit.valid,true);assert.equal(old.audit.complete,true);assert.equal(old.audit.slippageComplete,false);
 approx(old.metrics.netPnLUSD,19.58);assert.equal(old.metrics.slippageUSD,null);assert.equal(old.metrics.frictionlessPnLUSD,null);
 assert.ok(old.sample.reasons.includes('SLIPPAGE_UNVERIFIED'));
});

test('cash-flow MDD includes entry costs and open partial exits, not just completed-trade order',()=>{
 const a=trade(),b=trade({key:'short-eth',direction:'SHORT',asset:'ETH',openedAt:START+120000,closedAt:START+180000}),
  result=analyzeOrangeXPaperPerformance(state([b,a]),{now:START+180000});
 approx(result.metrics.maxDrawdownUSD,20.42);approx(result.metrics.maxDrawdownPct,20.42/1019.58*100);
 const partial=trade({key:'partial'});delete partial.closedAt;
 partial.quantityRemaining=1.2;const part=partial.exitParts[0];part.quantity=.8;part.feeUSD=.088;part.grossUSD=8;
 part.slippageUSD=.16;part.spreadCostUSD=.24;partial.feesUSD=.288;partial.realizedGrossUSD=8;partial.realizedPnLUSD=7.712;
 const open=analyzeOrangeXPaperPerformance(state([],[partial]),{now:START+30000});
 assert.equal(open.audit.valid,true);assert.equal(open.metrics.totalTrades,0);approx(open.metrics.maxDrawdownUSD,.2);
 approx(open.audit.totals.netPnLUSD,7.712);assert.equal(open.definitions.population,'CLOSED_TRADES');
});

test('missing funding leaves valid accounted totals but incomplete net performance, and scheduled funding is independently checked',()=>{
 const openedAt=Date.parse('2026-10-28T07:59:00Z'),closedAt=openedAt+120000,at=Date.parse('2026-10-28T08:00:00Z'),
  value=trade({openedAt,closedAt}),missing=analyzeOrangeXPaperPerformance(state([value]),{now:closedAt});
 assert.equal(missing.audit.valid,true);assert.equal(missing.audit.complete,false);
 assert.equal(missing.metrics.netPnLUSD,null);assert.equal(missing.metrics.fundingUSD,null);assert.equal(missing.metrics.profitFactor,null);
 assert.equal(missing.metrics.maxDrawdownUSD,null);assert.equal(missing.periods.daily[0].pnlUSD,null);
 value.fundingParts.push({id:'funding-1',at,rate:.0001,markPrice:100,quantity:2,amountUSD:.02});
 value.fundingUSD=.02;value.realizedPnLUSD-=.02;
 const complete=analyzeOrangeXPaperPerformance(state([value]),{now:closedAt});assert.equal(complete.audit.complete,true);
 approx(complete.metrics.netPnLUSD,19.56);approx(complete.metrics.fundingUSD,.02);
 const wrong=clone(value);wrong.fundingParts[0].quantity=1;
 assert.ok(auditOrangeXPaperAccounting(state([wrong]),{now:closedAt}).issues.some(row=>row.code==='FUNDING_MISMATCH'));
 const duplicate=clone(value);duplicate.fundingParts.push({...duplicate.fundingParts[0],id:'funding-2'});
 assert.ok(auditOrangeXPaperAccounting(state([duplicate]),{now:closedAt}).issues.some(row=>row.code==='FUNDING_PART_INVALID'));
});

test('SHORT positive funding and LONG negative funding are credits rather than clamped costs',()=>{
 const openedAt=Date.parse('2026-10-28T07:59:00Z'),closedAt=openedAt+120000,at=Date.parse('2026-10-28T08:00:00Z');
 for(const [direction,rate]of [['SHORT',.0001],['LONG',-.0001]]){
  const value=trade({direction,openedAt,closedAt});value.fundingParts=[{id:'signed',at,rate,markPrice:100,quantity:2,amountUSD:-.02}];
  value.fundingUSD=-.02;value.realizedPnLUSD+=.02;
  const audit=auditOrangeXPaperAccounting(state([value]),{now:closedAt});assert.equal(audit.valid,true);assert.equal(audit.complete,true);
  approx(audit.totals.fundingUSD,-.02);
 }
});

test('audit rejects missing units, duplicated identities, future fills, unknown fee rates and invalid cost references',()=>{
 const mutations=[p=>{p.contract.contractSizeBase=null},p=>{p.contract.takerRate=null},p=>{p.contract.feeUnit='UNVERIFIED'},
  p=>{p.exitParts[0].at=START+60000},p=>{p.quantityRemaining=1},p=>{p.entryParts[0].referencePrice=101},
  p=>{p.entryParts[0].slippageUSD=999}];
 for(const mutate of mutations){
  const p=trade();mutate(p);const result=analyzeOrangeXPaperPerformance(state([p]),{now:START+30000});
  assert.equal(result.audit.valid,false);assert.equal(result.metrics.netPnLUSD,null);assert.equal(result.sample.strategyValidated,false);
 }
 const twice=auditOrangeXPaperAccounting(state([trade(),trade()]),{now:START+30000});
 assert.equal(twice.valid,false);assert.ok(twice.issues.some(row=>row.code==='DUPLICATE_TRADE_KEY'));
});

test('execution context is never mixed, and even a sufficient synthetic sample does not verify market profitability',()=>{
 const a=trade(),input=state([a]),before=clone(input),result=analyzeOrangeXPaperPerformance(input,{now:START+30000,minSampleSize:1});
 assert.equal(result.sample.sufficient,true);assert.equal(result.sample.strategyValidated,false);assert.deepEqual(input,before);
 const backtest=analyzeOrangeXPaperPerformance(state([a],[],{runKind:'BACKTEST'}),{now:START+30000});
 assert.equal(backtest.runKind,'BACKTEST');assert.equal(backtest.executionMode,'SYNTHETIC_TEST');
 const mixed=clone(a);mixed.runKind='BACKTEST';
 assert.ok(auditOrangeXPaperAccounting(state([mixed]),{now:START+30000}).issues.some(row=>row.code==='MIXED_EXECUTION_CONTEXT'));
 for(const executionMode of ['HISTORICAL_REPLAY','LIVE_MARKET_PAPER']){
  const invalid=analyzeOrangeXPaperPerformance(state([a],[],{executionMode}),{now:START+30000});
  assert.equal(invalid.audit.valid,false);assert.equal(invalid.metrics.netPnLUSD,null);assert.equal(invalid.sample.sufficient,false);
 }
});

test('consecutive net losses include fees, reset on a win, and preserve the maximum sequence',()=>{
 const records=[trade({key:'loss1',exit:99,closedAt:START+1000}),trade({key:'loss2',exit:100,openedAt:START+2000,closedAt:START+3000}),
  trade({key:'win',exit:101,openedAt:START+4000,closedAt:START+5000}),trade({key:'loss3',exit:99,openedAt:START+6000,closedAt:START+7000})];
 const m=analyzeOrangeXPaperPerformance(state(records),{now:START+7000}).metrics;
 assert.equal(m.maxLossStreak,2);assert.equal(m.currentLossStreak,1);assert.equal(m.losingTrades,3);assert.equal(m.winningTrades,1);
});

test('same-millisecond closes preserve ledger order instead of inventing a key-sorted loss sequence',()=>{
 const records=[trade({key:'z-loss1',exit:99}),trade({key:'a-loss2',exit:99}),trade({key:'m-win',exit:110})],
  result=analyzeOrangeXPaperPerformance(state(records),{now:START+30000});
 assert.equal(result.metrics.maxLossStreak,2);assert.equal(result.metrics.currentLossStreak,0);
 const wrong=trade();wrong.symbol='ETHUSDT';
 assert.ok(auditOrangeXPaperAccounting(state([wrong]),{now:START+30000}).issues.some(row=>row.code==='CONTRACT_MAPPING_MISMATCH'));
});

test('ISO weeks use Korean day boundaries and unknown capital keeps percentage MDD undefined',()=>{
 const openedAt=Date.parse('2026-01-04T14:59:30Z'),closedAt=openedAt+60000,
  result=analyzeOrangeXPaperPerformance(state([trade({openedAt,closedAt})],[],{settings:{capitalUSD:null}}),{now:closedAt});
 assert.deepEqual(result.periods.weekly.map(row=>row.period),['2026-W01','2026-W02']);
 assert.deepEqual(result.periods.daily.map(row=>row.period),['2026-01-04','2026-01-05']);
 assert.equal(result.metrics.maxDrawdownPct,null);approx(result.metrics.maxDrawdownUSD,.2);
});

test('malformed state does not turn unavailable records into a successful empty financial report',()=>{
 for(const input of [null,{},state([],[],{closed:null}),state([],[],{executionMode:'UNKNOWN'})]){
  const result=analyzeOrangeXPaperPerformance(input,{now:START+30000});assert.equal(result.audit.valid,false);
  assert.equal(result.metrics.netPnLUSD,null);assert.equal(result.metrics.feesUSD,null);assert.equal(result.metrics.winRatePct,null);
 }
});
