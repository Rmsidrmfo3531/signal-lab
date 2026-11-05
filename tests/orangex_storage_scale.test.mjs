import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {storageScaleFixture,materializeStorageScaleFixture,summarizeStorageScaleState,OrangeXSyntheticSegmentedStorageLab} from '../orangex_paper_storage_lab.mjs';
import {buildSyntheticStorageLedger} from '../scripts/check-orangex-storage-performance.mjs';
import {runOrangeXStorageScaleComparison,storageScaleOptions} from '../scripts/check-orangex-storage-scale.mjs';

const sha=value=>createHash('sha256').update(value).digest('hex');
const encoded=value=>Buffer.from(JSON.stringify(value)+'\n');
const injected=code=>Object.assign(Error('injected synthetic storage failure'),{code});
function sandbox(run){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'orangex-scale-test-')),directory=path.join(root,'experiment'),stores=[];
 const create=(options={})=>{const store=new OrangeXSyntheticSegmentedStorageLab({directory,segmentRows:3,...options});stores.push(store);return store};
 try{return run({root,directory,create})}finally{for(const store of stores)try{store.close()}catch{}fs.rmSync(root,{recursive:true,force:true,maxRetries:8,retryDelay:100})}
}
function editManifest(directory,edit){
 const file=path.join(directory,'manifest.json'),wrapper=JSON.parse(fs.readFileSync(file));edit(wrapper.manifest);
 wrapper.contentSHA256=sha(encoded(wrapper.manifest));fs.writeFileSync(file,encoded(wrapper));
}

test('scale fixture reaches row 50,000 without changing old benchmark limits or allocating its full history',()=>{
 const fixture=storageScaleFixture(50000),last=fixture.row(49999);
 assert.equal(last.key,'storage-history-49999');assert.equal(last.fundingParts[0].id,'storage-funding-49999');
 assert.equal(fixture.active.closed.length,0);assert.deepEqual(fixture.active.seen,{});assert.deepEqual(fixture.active.fundingSeen,{});
 assert.throws(()=>buildSyntheticStorageLedger(20001),/INVALID_STORAGE_TRADE_COUNT/);
 for(const value of [0,50001,Infinity])assert.throws(()=>storageScaleFixture(value));
 const state=materializeStorageScaleFixture(storageScaleFixture(9)),summary=summarizeStorageScaleState(state,{segmentRows:3});
 assert.equal(summary.tradeCount,9);assert.equal(summary.accountingValid,true);assert.equal(summary.signalCount,9);assert.equal(summary.fundingCount,9);
});

test('immutable synthetic history, IDs and small active checkpoint survive heartbeat retry, restart and own backup restoration',()=>sandbox(({root,directory,create})=>{
 const fixture=storageScaleFixture(9),expected=summarizeStorageScaleState(materializeStorageScaleFixture(fixture)),store=create();
 fs.writeFileSync(path.join(root,'legacy-PNL.json'),'preserve existing PNL');
 const initial=store.initialize(fixture);assert.equal(initial.historySHA256,expected.historySHA256);
 assert.equal(initial.closedRowsRetainedInActiveMemory,0);assert.equal(initial.fullArchiveVerification,true);
 const files=fs.readdirSync(directory).filter(name=>name.startsWith('segment-')),before=Object.fromEntries(files.map(name=>[name,fs.readFileSync(path.join(directory,name))]));
 const delta={id:'heartbeat-1',updatedAt:fixture.active.updatedAt+1};assert.equal(store.heartbeat(delta).seq,1);assert.equal(store.heartbeat(delta).duplicate,true);
 assert.throws(()=>store.heartbeat({...delta,updatedAt:delta.updatedAt+1}),/TRANSACTION_ID_CONFLICT/);
 const checkpoint=store.checkpoint();assert.ok(fs.statSync(path.join(directory,checkpoint)).size<8192);
 const backup=store.backup();store.close();
 const next=create();assert.equal(next.summary().updatedAt,delta.updatedAt);assert.equal(next.heartbeat(delta).duplicate,true);
 const restored=next.restoreBackup(backup);try{const actual=restored.summary();assert.equal(actual.historySHA256,expected.historySHA256);
  assert.equal(actual.tradeCount,9);assert.equal(actual.updatedAt,delta.updatedAt);assert.equal(actual.accountingValid,true);assert.equal(restored.heartbeat(delta).duplicate,true);
 }finally{restored.close()}
 for(const name of files)assert.ok(fs.readFileSync(path.join(directory,name)).equals(before[name]));
 assert.equal(fs.readFileSync(path.join(root,'legacy-PNL.json'),'utf8'),'preserve existing PNL');
}));

test('segment corruption and partial WAL are rejected and preserved instead of truncated or initialized empty',()=>sandbox(({directory,create})=>{
 const store=create();store.initialize(storageScaleFixture(6));store.close();const segment=path.join(directory,'segment-00000.json'),original=fs.readFileSync(segment);
 fs.appendFileSync(segment,'tamper');const damaged=fs.readFileSync(segment);assert.throws(()=>create().summary(),/SEGMENT_HASH_MISMATCH/);assert.ok(fs.readFileSync(segment).equals(damaged));
 fs.writeFileSync(segment,original);const log=path.join(directory,'delta.jsonl');fs.appendFileSync(log,'{"partial":');const partial=fs.readFileSync(log);
 assert.throws(()=>create().summary(),/PARTIAL_TAIL/);assert.ok(fs.readFileSync(log).equals(partial));
}));

test('unhashed extra WAL fields are rejected instead of silently accepted as verified archive history',()=>sandbox(({directory,create})=>{
 const fixture=storageScaleFixture(3),store=create();store.initialize(fixture);store.heartbeat({id:'record',updatedAt:fixture.active.updatedAt+1});store.close();
 const file=path.join(directory,'delta.jsonl'),record=JSON.parse(fs.readFileSync(file));record.extra='unverified injected data';fs.writeFileSync(file,encoded(record));
 assert.throws(()=>create().summary(),/DELTA_INVALID/);
}));

test('a cross-segment duplicated trade or funding identity cannot pass merely by recomputing file and manifest hashes',()=>sandbox(({directory,create})=>{
 const store=create();store.initialize(storageScaleFixture(6));store.close();
 const first=JSON.parse(fs.readFileSync(path.join(directory,'segment-00000.json'))),file=path.join(directory,'segment-00001.json'),second=JSON.parse(fs.readFileSync(file));
 second.closed[0].fundingParts[0].id=first.closed[0].fundingParts[0].id;const data=encoded(second);fs.writeFileSync(file,data);
 editManifest(directory,m=>{m.segments[1].sha256=sha(data);m.segments[1].bytes=data.length});
 assert.throws(()=>create().summary(),/SYNTHETIC_ID_SEQUENCE_MISMATCH/);
}));

test('missing or duplicated segments and path traversal in a manifest cannot become a successful restart',()=>sandbox(({directory,create})=>{
 const store=create();store.initialize(storageScaleFixture(6));store.close();const manifest=fs.readFileSync(path.join(directory,'manifest.json'));
 editManifest(directory,m=>{m.segments[1]=m.segments[0]});assert.throws(()=>create().summary(),/SEGMENT_SEQUENCE_INVALID/);
 fs.writeFileSync(path.join(directory,'manifest.json'),manifest);editManifest(directory,m=>{m.segments[1].file='../legacy-PNL.json'});
 assert.throws(()=>create().summary(),/SEGMENT_SEQUENCE_INVALID/);
 fs.writeFileSync(path.join(directory,'manifest.json'),manifest);fs.unlinkSync(path.join(directory,'segment-00001.json'));
 assert.throws(()=>create().summary(),{code:'ENOENT'});
}));

test('mid-line ENOSPC rolls back bytes before ACK, then one retry remains idempotent after checkpoint and restart',()=>sandbox(({directory,create})=>{
 let fail=false,partial=false;const io=new Proxy(fs,{get(target,key){
  if(key==='writeSync')return(fd,buffer,offset,length,position)=>{if(fail){if(!partial){partial=true;return fs.writeSync(fd,buffer,offset,Math.min(17,length),position)}throw injected('ENOSPC')}return fs.writeSync(fd,buffer,offset,length,position)};
  return Reflect.get(target,key);
 }});
 const fixture=storageScaleFixture(6),store=create({io});store.initialize(fixture);const file=path.join(directory,'delta.jsonl'),before=fs.readFileSync(file),delta={id:'retry-one',updatedAt:fixture.active.updatedAt+1};
 fail=true;assert.throws(()=>store.heartbeat(delta),{code:'ENOSPC'});assert.ok(fs.readFileSync(file).equals(before));
 fail=false;assert.equal(store.summary().seq,0);assert.equal(store.heartbeat(delta).seq,1);store.checkpoint();store.close();
 const restarted=create();assert.equal(restarted.summary().seq,1);assert.equal(restarted.heartbeat(delta).duplicate,true);
 assert.equal(restarted.summary().updatedAt,delta.updatedAt);
}));

test('uncertain WAL sync and rollback freeze writes rather than acknowledging an unverified mutation',()=>sandbox(({create})=>{
 let fail=false;const io=new Proxy(fs,{get(target,key){
  if(key==='fsyncSync')return fd=>{if(fail)throw injected('EIO');return fs.fsyncSync(fd)};
  if(key==='ftruncateSync')return(fd,size)=>{if(fail)throw injected('ENOSPC');return fs.ftruncateSync(fd,size)};
  return Reflect.get(target,key);
 }});
 const fixture=storageScaleFixture(3),store=create({io});store.initialize(fixture);fail=true;
 assert.throws(()=>store.heartbeat({id:'uncertain',updatedAt:fixture.active.updatedAt+1}),/COMMIT_UNCERTAIN/);fail=false;
 assert.throws(()=>store.heartbeat({id:'must-stay-blocked',updatedAt:fixture.active.updatedAt+2}),/COMMIT_UNCERTAIN/);
}));

test('a substituted hard-linked delta cannot modify an unrelated temporary file or receive a successful ACK',()=>sandbox(({root,directory,create})=>{
 const fixture=storageScaleFixture(3),store=create();store.initialize(fixture);
 const delta=path.join(directory,'delta.jsonl'),unrelated=path.join(root,'unrelated-synthetic-only.json');fs.writeFileSync(unrelated,'must not append or truncate');
 fs.unlinkSync(delta);fs.linkSync(unrelated,delta);
 assert.throws(()=>store.heartbeat({id:'hardlink-must-fail',updatedAt:fixture.active.updatedAt+1}),/SCALE_LOG_CHANGED/);
 assert.equal(fs.readFileSync(unrelated,'utf8'),'must not append or truncate');assert.equal(fs.statSync(delta).size,Buffer.byteLength('must not append or truncate'));
}));

test('initial manifest publication synchronizes temporary parent directory entries as well as data files',()=>sandbox(({root,create})=>{
 const directories=new Set(),descriptors=new Map(),trace=[];let virtual=-1000;
 const io=new Proxy(fs,{get(target,key){
  if(key==='openSync')return(file,...args)=>{const directory=fs.existsSync(file)&&fs.statSync(file).isDirectory(),fd=directory?virtual--:fs.openSync(file,...args);
   if(directory)directories.add(fd);descriptors.set(fd,String(file));return fd};
  if(key==='closeSync')return fd=>{descriptors.delete(fd);if(directories.delete(fd))return;return fs.closeSync(fd)};
  if(key==='fsyncSync')return fd=>{trace.push('sync:'+descriptors.get(fd));if(directories.has(fd))return;return fs.fsyncSync(fd)};
  if(key==='renameSync')return(source,target)=>{if(path.basename(target)==='manifest.json')trace.push('publish');return fs.renameSync(source,target)};
  return Reflect.get(target,key);
 }});
 create({io}).initialize(storageScaleFixture(3));const published=trace.indexOf('publish');
 assert.ok(trace.indexOf('sync:'+fs.realpathSync(root))>=0);assert.ok(trace.indexOf('sync:'+fs.realpathSync(root))<published);
 assert.ok(trace.indexOf('sync:'+fs.realpathSync(os.tmpdir()))<published);
}));

test('segmented layout is synthetic/temp/empty-only and cannot overwrite or import existing records',()=>sandbox(({root,directory,create})=>{
 const fixture=storageScaleFixture(3);fs.mkdirSync(directory);fs.writeFileSync(path.join(directory,'store.json'),'legacy');
 assert.throws(()=>create().initialize(fixture),/DIRECTORY_NOT_EMPTY/);assert.equal(fs.readFileSync(path.join(directory,'store.json'),'utf8'),'legacy');
 assert.throws(()=>new OrangeXSyntheticSegmentedStorageLab({directory:path.join(path.parse(os.tmpdir()).root,'not-an-os-temp-experiment')}),/TEMP_ONLY/);
 const another=new OrangeXSyntheticSegmentedStorageLab({directory:path.join(root,'another')});
 try{assert.throws(()=>another.initialize({...fixture,active:{...fixture.active,executionMode:'LIVE_MARKET_PAPER'}}),/SYNTHETIC_ONLY/)}finally{another.close()}
 assert.throws(()=>create().restoreBackup('../store.json'),/INVALID_BACKUP/);
}));

test('isolated same-workload workers preserve equal accounting across unchanged Snapshot, Journal and segmented lab',()=>{
 const report=runOrangeXStorageScaleComparison({tradeCounts:[9],mutations:2,segmentRows:3,heapMiB:256,timeoutMs:20000});
 assert.equal(report.status,'PASS',JSON.stringify(report.results.map(row=>row.failure)));assert.equal(report.results.length,3);
 assert.equal(report.implementationConsistent,true);assert.equal(report.checks[0].sameHistoryAmongCompleted,true);assert.equal(report.checks[0].allThreeDurablyCompleted,true);
 for(const row of report.results){assert.equal(row.status,'PASS');assert.equal(row.actual.tradeCount,9);assert.equal(row.checks.allTradeSignalFundingIdsPreserved,true);
  assert.equal(row.checks.backupAndRestoreVerified,true);assert.equal(row.actual.accountingValid,true);assert.ok(row.metrics.restartAndFullIntegrityRead.durationMs>=0);
  assert.equal(row.diagnostics.status,'OBSERVED');assert.equal(row.diagnostics.lastPhase.stage,'phase:cleanup:end');
  assert.equal(row.temporaryRootCleanupVerified,true);assert.ok(row.workerElapsedMs>=0)}
 assert.equal(report.actualOrangeXRequestsRun,false);assert.equal(report.productionStorageChanged,false);assert.equal(report.userDataMigrationRun,false);assert.equal(report.allTemporaryRootsCleaned,true);
 const archive=report.results.find(row=>row.backend==='segmented_lab');assert.equal(archive.actual.closedRowsRetainedInActiveMemory,0);
 assert.ok(archive.limitations.includes('HEARTBEAT_WAL_ONLY_NO_CLOSED_TRADE_APPEND_ENGINE_ADAPTER'));
});

test('scale CLI cannot select a production path, network endpoint, trading mode or silent unbounded budget',()=>{
 assert.deepEqual(storageScaleOptions(),{tradeCounts:[1000,10000,50000],heapMiB:1024,timeoutMs:180000,mutations:5,segmentRows:1000});
 for(const args of [['--data-dir','old'],['--mode','LIVE'],['--trades','50001'],['--heap-mib','99999'],['--timeout-ms','0'],['--trades','5,5'],['--trades','5','--trades','6'],['https://api.orangex.com','x']])
  assert.throws(()=>storageScaleOptions(args),/SCALE_INVALID_OPTIONS/);
});
