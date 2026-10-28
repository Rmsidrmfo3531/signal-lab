import test from 'node:test';
import assert from 'node:assert/strict';
import {runOrangeXPaperEndurance,enduranceOptions} from '../scripts/check-orangex-paper-endurance.mjs';

test('compressed seven and thirty synthetic days preserve every trade and ledger through daily durable restarts',()=>{
 for(const days of [7,30]){
  const result=runOrangeXPaperEndurance({days});
  assert.equal(result.executionMode,'SYNTHETIC_TEST');assert.equal(result.runKind,'FORWARD_PAPER');
  assert.equal(result.dataSource,'SYNTHETIC_FIXTURE');assert.equal(result.actualMarketPerformance,false);
  assert.equal(result.realDataAutoEntryEnabled,false);assert.equal(result.liveOrdersEnabled,false);
  assert.equal(result.workload.closedTrades,days*4);assert.equal(result.workload.signals,days*4);
  assert.equal(result.workload.durableRestarts,days);assert.equal(result.workload.durabilityMode,'DAILY_CHECKPOINT');
  assert.equal(result.dailySamples.length,days);assert.equal(result.audit.valid,true);assert.equal(result.audit.complete,true);
  assert.equal(result.ledger.quantityConserved,true);assert.equal(result.ledger.duplicateTradeKeys,false);
  assert.equal(result.ledger.durableStateMatchesMemory,true);assert.equal(result.ledger.retainedClosedTrades,days*4);
  assert.ok(result.timing.durationMs>0);assert.ok(result.timing.marketMessagesPerSecond>0);
  assert.ok(result.memory.sampledPeakHeapUsedBytes>=result.memory.startHeapUsedBytes);
  assert.ok(result.memory.sampledPeakRssBytes>=result.memory.startRssBytes);
  assert.ok(result.memory.sampleCount>=result.workload.marketMessages);
  assert.ok(result.dailySamples.every((row,index)=>row.virtualDay===index+1&&row.closedTrades===(index+1)*4&&row.openPositions===0&&row.pendingOrders===0));
  for(const count of Object.values(result.faults))assert.ok(count>0);
  assert.ok(result.limitations.includes('GENERATED_SIGNALS_NOT_STRATEGY_BACKTEST'));
  assert.ok(result.limitations.includes('MEMORY_CAN_GROW_WITH_PRESERVED_TRADE_HISTORY'));
 }
});

test('every-event durability is measured separately from the daily checkpoint workload',()=>{
 const result=runOrangeXPaperEndurance({days:1,ticksPerDay:4,signalEveryTicks:1,saveEveryEvent:true});
 assert.equal(result.workload.durabilityMode,'EVERY_EVENT');assert.equal(result.workload.closedTrades,4);
 assert.ok(result.workload.durableWrites>=result.workload.committedMutations);
 assert.equal(result.audit.valid,true);assert.equal(result.audit.complete,true);
 assert.ok(!result.limitations.includes('DURABLE_DAILY_CHECKPOINTS_NOT_EVERY_EVENT_DURABILITY'));
});

test('endurance CLI is fixed to synthetic seven/thirty day workloads and rejects arbitrary switches',()=>{
 assert.deepEqual(enduranceOptions(),{days:[7,30],saveEveryEvent:false});
 assert.deepEqual(enduranceOptions(['--days','30','--save-every-event']),{days:[30],saveEveryEvent:true});
 for(const args of [['--mode','LIVE'],['--days','1'],['--days','7','--days','30'],['https://api.orangex.com'],['--save-every-event','--save-every-event']])
  assert.throws(()=>enduranceOptions(args));
 for(const options of [{days:0},{days:31},{ticksPerDay:0},{ticksPerDay:7},{signalEveryTicks:0},{saveEveryEvent:'true'}])
  assert.throws(()=>runOrangeXPaperEndurance(options));
});
