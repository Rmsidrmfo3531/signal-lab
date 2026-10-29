import test from 'node:test';
import assert from 'node:assert/strict';
import {runOrangeXOperationalStress,operationalStressOptions} from '../scripts/check-orangex-operational-stress.mjs';

// Deliberately generated engine workload and declared synthetic costs. These
// checks do not represent observed exchange specifications or strategy returns.
const near=(actual,expected)=>assert.ok(Math.abs(actual-expected)<1e-8,`${actual} vs ${expected}`);

test('high-frequency ordering faults preserve one fill and durable seen state while valid equal-time sequences advance',()=>{
 const result=runOrangeXOperationalStress({messages:250,holdingDays:7}),phase=result.highFrequency;
 assert.equal(result.executionMode,'SYNTHETIC_TEST');assert.equal(result.runKind,'FORWARD_PAPER');
 assert.equal(result.actualOrangeXRequestsRun,false);assert.equal(result.apiKeysUsed,false);
 assert.equal(result.realDataAutoEntryEnabled,false);assert.equal(result.liveOrdersEnabled,false);
 assert.equal(result.signalSource,'GENERATED_ENGINE_STRESS_NOT_STRATEGY_BACKTEST');
 assert.equal(phase.inputMessages,250);assert.ok(phase.deliveredMarketMessages>phase.inputMessages);
 assert.equal(phase.entryFillCount,1);assert.equal(phase.closedTrades,1);assert.equal(phase.duplicateFill,false);
 assert.equal(phase.seenSignalPersisted,true);assert.equal(phase.audit.valid,true);assert.equal(phase.audit.complete,true);
 for(const count of Object.values(phase.faults))assert.ok(count>0,'every advertised fault must actually be exercised');
 assert.ok(phase.durationMs>0);assert.ok(phase.cpuUserMs>=0);assert.ok(phase.cpuSystemMs>=0);
 assert.ok(phase.memory.samples>=phase.deliveredMarketMessages);assert.ok(phase.memory.sampledPeakHeapUsedBytes>=phase.memory.startHeapUsedBytes);
 assert.ok(phase.ledgerBytes>0);assert.equal(phase.durabilityMode,'MIDPOINT_AND_FINAL_CHECKPOINTS');
 assert.ok(result.limitations.includes('HIGH_FREQUENCY_DURABILITY_USES_MIDPOINT_AND_FINAL_CHECKPOINTS'));
});

test('a seven-day open position accrues all 21 funding settlements and closes only at its unchanged time limit',()=>{
 const result=runOrangeXOperationalStress({messages:20,holdingDays:7}),phase=result.longHeld;
 assert.equal(phase.holdingDays,7);assert.equal(phase.fundingEvents,21);assert.equal(phase.closeReason,'TIME_LIMIT');
 assert.equal(phase.configuredMaxHoldingMs,7*86400000);
 assert.ok(phase.virtualClosedAt-phase.virtualOpenedAt>=phase.configuredMaxHoldingMs);
 near(phase.fundingUSD,phase.expectedFundingUSD);
 assert.equal(phase.missingFundingBlocked,true);assert.equal(phase.staleMarkBlocked,true);assert.equal(phase.stalePortfolioBlocked,true);
 assert.equal(phase.fundingIdsPersisted,true);assert.equal(phase.duplicateFundingCharge,false);
 assert.ok(phase.durableRestarts>=7);assert.equal(phase.audit.valid,true);assert.equal(phase.audit.complete,true);
});

test('a thirty-day data outage never invents a timely exit and recovers with current-depth gap loss and complete funding',()=>{
 const result=runOrangeXOperationalStress({messages:20,holdingDays:30}),phase=result.longHeld;
 assert.equal(phase.configuredMaxHoldingMs,7*86400000,'the experiment does not relax the production holding limit');
 assert.equal(phase.model,'THIRTY_DAY_MARKET_DATA_OUTAGE_THEN_FIRST_FRESH_GAP_STOP');
 assert.ok(phase.virtualClosedAt-phase.virtualOpenedAt>phase.configuredMaxHoldingMs);
 assert.equal(phase.closeReason,'STOP');assert.equal(phase.fundingEvents,90);near(phase.fundingUSD,phase.expectedFundingUSD);
 assert.equal(phase.missingFundingBlocked,true);assert.equal(phase.staleMarkBlocked,true);assert.equal(phase.duplicateFill,false);
 assert.ok(phase.gapStopExceeded.realizedLossUSD>phase.gapStopExceeded.plannedRiskUSD);
 near(phase.gapStopExceeded.overrunUSD,phase.gapStopExceeded.realizedLossUSD-phase.gapStopExceeded.plannedRiskUSD);
 assert.equal(phase.fundingIdsPersisted,true);assert.equal(phase.duplicateFundingCharge,false);
 assert.equal(phase.audit.valid,true);assert.equal(phase.audit.complete,true);
});

test('every-message durable writes are identified separately from checkpoint timing',()=>{
 const result=runOrangeXOperationalStress({messages:10,holdingDays:7,saveEveryMessage:true});
 assert.equal(result.highFrequency.durabilityMode,'EVERY_MUTATION');
 assert.ok(result.highFrequency.durableWrites>=result.highFrequency.committedMutations);
 assert.equal(result.highFrequency.audit.valid,true);
 assert.ok(!result.limitations.includes('HIGH_FREQUENCY_DURABILITY_USES_MIDPOINT_AND_FINAL_CHECKPOINTS'));
});

test('operational stress CLI cannot activate another mode or access a caller-provided market endpoint',()=>{
 assert.deepEqual(operationalStressOptions(),{messages:10000,holdingDays:[7,30],saveEveryMessage:false});
 assert.deepEqual(operationalStressOptions(['--messages','1000','--holding-days','30','--save-every-message']),
  {messages:1000,holdingDays:[30],saveEveryMessage:true});
 for(const args of [['--mode','LIVE'],['https://api.orangex.com'],['--messages','0'],['--messages','1e4'],
  ['--messages','200001'],['--holding-days','14'],['--messages','10','--messages','20'],['--save-every-message','--save-every-message']])
  assert.throws(()=>operationalStressOptions(args));
 for(const options of [{messages:0},{messages:200001},{messages:NaN},{holdingDays:1},{saveEveryMessage:'true'}])
  assert.throws(()=>runOrangeXOperationalStress(options));
});
