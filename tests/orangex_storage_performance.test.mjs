import test from 'node:test';
import assert from 'node:assert/strict';
import {OrangeXPaperEngine} from '../orangex_paper.mjs';
import {auditOrangeXPaperAccounting} from '../orangex_paper_performance.mjs';
import {buildSyntheticStorageLedger,runOrangeXStorageComparison,storagePerformanceOptions} from '../scripts/check-orangex-storage-performance.mjs';

test('seeded storage histories preserve real engine accounting and signal/funding replay identities',()=>{
 const state=buildSyntheticStorageLedger(64),now=state.updatedAt+1,
  audit=auditOrangeXPaperAccounting(state,{now});
 assert.equal(audit.valid,true);assert.equal(audit.complete,true);
 assert.equal(state.closed.length,64);assert.equal(new Set(state.closed.map(row=>row.key)).size,64);
 assert.equal(Object.keys(state.seen).length,64);assert.equal(Object.keys(state.fundingSeen).length,64);
 const restored=new OrangeXPaperEngine(state,{now:()=>now}),first=state.closed[0],funding=first.fundingParts[0];
 assert.equal(restored.register({key:first.key,instrumentName:first.instrumentName,symbol:first.symbol,direction:'LONG',entry:100,stop:98,
  timeframe:'1h',trendTimeframe:'4h',confirmed:true,trendConfirmed:true,patternConfirmedAt:now-1},
  {dataSource:'SYNTHETIC_FIXTURE'}),false);
 assert.equal(restored.snapshot().rejections.at(-1).reason,'DUPLICATE_SIGNAL');
 assert.equal(restored.applyFunding({id:funding.id,instrumentName:first.instrumentName,dataSource:'SYNTHETIC_FIXTURE',
  at:funding.at,rate:funding.rate,markPrice:funding.markPrice}),false);
 assert.deepEqual(restored.exportState().closed,state.closed,'duplicate funding must not change saved accounting');
});

test('isolated paired storage cases compare identical histories and restore every record and identity',()=>{
 const report=runOrangeXStorageComparison({tradeCounts:[12,32],mutations:2,workerTimeoutMs:20000});
 assert.equal(report.executionMode,'SYNTHETIC_TEST');assert.equal(report.productionStorageChanged,false);
 assert.equal(report.existingUserRecordsTouched,false);assert.equal(report.actualOrangeXRequestsRun,false);
 assert.equal(report.results.length,4);assert.equal(report.allTemporaryRootsCleaned,true);
 for(const pair of report.comparablePairs){
  assert.equal(pair.identicalSeed,true);assert.equal(pair.bothDurablyCompleted,true);
  const rows=report.results.filter(row=>row.tradeCount===pair.tradeCount),snapshot=rows.find(row=>row.backend==='snapshot'),journal=rows.find(row=>row.backend==='journal');
  assert.equal(snapshot.seededHistory.finalHash,journal.seededHistory.finalHash);
  for(const result of rows){
   assert.equal(result.status,'PASS',JSON.stringify({failure:result.failure,diagnostics:result.diagnostics}));
   assert.equal(result.diagnostics.status,'OBSERVED');assert.equal(result.diagnostics.lastPhase.stage,'phase:cleanup:end');assert.equal(result.temporaryRootCleanupVerified,true);
   for(const value of Object.values(result.checks))assert.equal(value,true);
   assert.ok(result.metrics.restartRead.durationMs>=0);assert.ok(result.metrics.backup.durationMs>=0);assert.ok(result.metrics.restoreBackup.durationMs>=0);
   assert.ok(result.storage.fsyncCalls>0);assert.ok(result.storage.logicalBytesWritten>0);
   assert.ok(result.memory.maxRssKiB>0);assert.equal(result.memory.controlledGcAvailable,true);
  }
  assert.ok(journal.storage.mutationWrites.logicalBytesWritten<snapshot.storage.mutationWrites.logicalBytesWritten,
   'small durable journal mutations must not rewrite the full closed-trade history');
 }
});

test('performance options cannot select a production store, mode or implicit migration',()=>{
 assert.deepEqual(storagePerformanceOptions(),{tradeCounts:[1000,10000,10001],mutations:5,mutationPattern:'heartbeat'});
 assert.deepEqual(storagePerformanceOptions(['--trades','15,25','--mutations','2']),{tradeCounts:[15,25],mutations:2,mutationPattern:'heartbeat'});
 for(const args of [['--data-dir','existing'],['--mode','LIVE'],['--trades','0'],['--trades','10,10'],
  ['--mutations','0'],['--trades','20001'],['--migrate'],['--trades','10','--trades','20']])
  assert.throws(()=>storagePerformanceOptions(args),/INVALID_STORAGE_BENCHMARK_OPTIONS/);
 for(const workerTimeoutMs of [0,NaN,Infinity,180001])
  assert.throws(()=>runOrangeXStorageComparison({tradeCounts:[1],workerTimeoutMs}),/INVALID_STORAGE_BENCHMARK_OPTIONS/);
});

test('appended closed trades preserve matching funding and signal identities through both storage backends',()=>{
 const report=runOrangeXStorageComparison({tradeCounts:[16],mutations:3,mutationPattern:'append_trade',workerTimeoutMs:20000});
 assert.equal(report.status,'PASS');assert.equal(report.mutationPattern,'append_trade');assert.equal(report.comparablePairs[0].identicalSeed,true);
 const [snapshot,journal]=report.results;
 assert.equal(snapshot.finalTradeCount,19);assert.equal(journal.finalTradeCount,19);
 assert.equal(snapshot.seededHistory.finalHash,journal.seededHistory.finalHash);
 for(const result of report.results){
  assert.equal(result.checks.historyPreserved,true);assert.equal(result.checks.appendedTradesPreserved,true);
  assert.equal(result.checks.signalIdentityPersisted,true);assert.equal(result.checks.fundingIdentityPersisted,true);
  assert.equal(result.checks.independentAccountingValid,true);assert.equal(result.checks.independentAccountingComplete,true);
 }
});
