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

test('Windows append-only truncate restrictions use a separately writable WAL recovery handle before permitting retry',()=>sandbox(({directory,create})=>{
 let fail=false,partial=false,appendTruncates=0,recoveryTruncates=0;const handles=new Map(),trace=[];
 const io=new Proxy(fs,{get(target,key){
  if(key==='openSync')return(file,flags,...args)=>{const fd=fs.openSync(file,flags,...args);if(path.basename(String(file))==='delta.jsonl')handles.set(fd,flags);return fd};
  if(key==='closeSync')return fd=>{fs.closeSync(fd);handles.delete(fd)};
  if(key==='writeSync')return(fd,buffer,offset,length,position)=>{
   if(fail&&(handles.get(fd)&fs.constants.O_APPEND)){if(!partial){partial=true;return fs.writeSync(fd,buffer,offset,Math.min(17,length),position)}throw injected('ENOSPC')}
   return fs.writeSync(fd,buffer,offset,length,position);
  };
  if(key==='ftruncateSync')return(fd,size)=>{
   const flags=handles.get(fd);if(flags&fs.constants.O_APPEND){appendTruncates++;throw Object.assign(injected('EPERM'),{syscall:'ftruncate'})}
   assert.equal(flags&fs.constants.O_RDWR,fs.constants.O_RDWR);assert.equal(flags&(fs.constants.O_APPEND|fs.constants.O_TRUNC|fs.constants.O_CREAT),0);
   recoveryTruncates++;trace.push('truncate');return fs.ftruncateSync(fd,size);
  };
  if(key==='fsyncSync')return fd=>{if(fail&&handles.has(fd)&&!(handles.get(fd)&fs.constants.O_APPEND))trace.push('recovery-sync');return fs.fsyncSync(fd)};
  return Reflect.get(target,key);
 }});
 const fixture=storageScaleFixture(3),store=create({io});store.initialize(fixture);
 store.heartbeat({id:'committed-prefix',updatedAt:fixture.active.updatedAt+1});
 const file=path.join(directory,'delta.jsonl'),before=fs.readFileSync(file),delta={id:'windows-retry',updatedAt:fixture.active.updatedAt+2};
 fail=true;assert.throws(()=>store.heartbeat(delta),{code:'ENOSPC'});
 assert.equal(appendTruncates,0);assert.equal(recoveryTruncates,1);assert.deepEqual(trace,['truncate','recovery-sync']);
 assert.ok(fs.readFileSync(file).equals(before));assert.equal(handles.size,0);
 fail=false;assert.equal(store.summary().seq,1);assert.equal(store.heartbeat(delta).seq,2);store.checkpoint();store.close();
 const restarted=create();assert.equal(restarted.summary().seq,2);assert.equal(restarted.heartbeat(delta).duplicate,true);
 assert.equal(restarted.summary().updatedAt,delta.updatedAt);assert.equal(handles.size,0);
}));

for(const scenario of [
 {name:'open',stage:'recovery-open',code:'EACCES'},
 {name:'identity',stage:'identity-before',code:'DURABLE_ROLLBACK_IDENTITY_CHANGED'},
 {name:'prefix',stage:'prefix-before',code:'DURABLE_ROLLBACK_PREFIX_MISMATCH'},
 {name:'tail',stage:'tail-before',code:'DURABLE_ROLLBACK_TAIL_MISMATCH'},
 {name:'truncate',stage:'truncate',code:'EPERM'},
 {name:'sync',stage:'sync',code:'EIO'},
 {name:'length',stage:'identity-after',code:'DURABLE_ROLLBACK_LENGTH_MISMATCH'},
 {name:'close',stage:'recovery-close',code:'EIO'},
])test(`unverified ${scenario.name} rollback preserves its cause and permanently freezes the synthetic WAL`,()=>sandbox(({directory,create})=>{
 let fail=false,partial=false,file,committedBytes;const handles=new Map();
 const tamper=offset=>{const fd=fs.openSync(file,'r+');try{fs.writeSync(fd,Buffer.from('!'),0,1,offset)}finally{fs.closeSync(fd)}};
 const io=new Proxy(fs,{get(target,key){
  if(key==='openSync')return(targetFile,flags,...args)=>{
   const wal=path.basename(String(targetFile))==='delta.jsonl',recovery=fail&&wal&&Boolean(flags&fs.constants.O_RDWR)&&!(flags&fs.constants.O_APPEND);
   if(recovery&&scenario.name==='open')throw Object.assign(injected('EACCES'),{syscall:'open'});
   const fd=fs.openSync(targetFile,flags,...args);if(wal)handles.set(fd,{flags,recovery});return fd;
  };
  if(key==='closeSync')return fd=>{const recovery=handles.get(fd)?.recovery;fs.closeSync(fd);handles.delete(fd);
   if(fail&&recovery&&scenario.name==='close')throw Object.assign(injected('EIO'),{syscall:'close'});
  };
  if(key==='fstatSync')return fd=>{const stat=fs.fstatSync(fd);
   if(fail&&handles.get(fd)?.recovery&&scenario.name==='identity')return Object.assign(Object.create(Object.getPrototypeOf(stat)),stat,{ino:Number(stat.ino)+1});
   return stat;
  };
  if(key==='writeSync')return(fd,buffer,offset,length,position)=>{
   if(fail&&(handles.get(fd)?.flags&fs.constants.O_APPEND)){
    if(!partial){partial=true;const wrote=fs.writeSync(fd,buffer,offset,Math.min(17,length),position);
     if(scenario.name==='prefix')tamper(0);if(scenario.name==='tail')tamper(committedBytes);return wrote;
    }throw Object.assign(injected('ENOSPC'),{syscall:'write'});
   }return fs.writeSync(fd,buffer,offset,length,position);
  };
  if(key==='ftruncateSync')return(fd,size)=>{
   if(fail&&handles.get(fd)?.recovery){if(scenario.name==='truncate')throw Object.assign(injected('EPERM'),{syscall:'ftruncate'});if(scenario.name==='length')return}
   return fs.ftruncateSync(fd,size);
  };
  if(key==='fsyncSync')return fd=>{if(fail&&handles.get(fd)?.recovery&&scenario.name==='sync')throw Object.assign(injected('EIO'),{syscall:'fsync'});return fs.fsyncSync(fd)};
  return Reflect.get(target,key);
 }});
 const fixture=storageScaleFixture(3),store=create({io});store.initialize(fixture);store.heartbeat({id:'prior-committed',updatedAt:fixture.active.updatedAt+1});
 file=path.join(directory,'delta.jsonl');committedBytes=fs.statSync(file).size;
 let caught;fail=true;assert.throws(()=>store.heartbeat({id:'must-not-ack',updatedAt:fixture.active.updatedAt+2}),error=>{
  caught=error;assert.equal(error.code,'SCALE_COMMIT_UNCERTAIN');assert.equal(error.cause.code,'ENOSPC');
  assert.equal(error.appendFailure.original.stage,'append-write');assert.equal(error.appendFailure.original.syscall,'write');
  assert.equal(error.rollback.verified,false);assert.equal(error.rollback.stage,scenario.stage);assert.equal(error.rollback.code,scenario.code);return true;
 });
 assert.equal(handles.size,0);const after=fs.readFileSync(file);fail=false;
 assert.throws(()=>store.heartbeat({id:'cannot-bypass-freeze',updatedAt:fixture.active.updatedAt+3}),error=>{
  assert.equal(error.code,'SCALE_COMMIT_UNCERTAIN');assert.deepEqual(error.rollback,caught.rollback);assert.deepEqual(error.appendFailure,caught.appendFailure);return true;
 });
 assert.ok(fs.readFileSync(file).equals(after));assert.equal(handles.size,0);
}));

test('an append close that releases its handle then errors is never retried or truncated and remains recoverable without a duplicate ACK',()=>sandbox(({directory,create})=>{
 let fail=false,appendCloseCalls=0,truncates=0;const appendHandles=new Set();
 const io=new Proxy(fs,{get(target,key){
  if(key==='openSync')return(file,flags,...args)=>{const fd=fs.openSync(file,flags,...args);if(path.basename(String(file))==='delta.jsonl'&&(flags&fs.constants.O_APPEND))appendHandles.add(fd);return fd};
  if(key==='closeSync')return fd=>{if(fail&&appendHandles.has(fd)){appendCloseCalls++;fs.closeSync(fd);appendHandles.delete(fd);throw Object.assign(injected('EIO'),{syscall:'close'})}fs.closeSync(fd);appendHandles.delete(fd)};
  if(key==='ftruncateSync')return(fd,size)=>{truncates++;return fs.ftruncateSync(fd,size)};
  return Reflect.get(target,key);
 }});
 const fixture=storageScaleFixture(3),store=create({io});store.initialize(fixture);const delta={id:'closed-but-unacknowledged',updatedAt:fixture.active.updatedAt+1};
 fail=true;assert.throws(()=>store.heartbeat(delta),error=>{
  assert.equal(error.code,'SCALE_COMMIT_UNCERTAIN');assert.equal(error.cause.code,'EIO');assert.equal(error.appendFailure.original.stage,'append-close');assert.equal(error.rollback.verified,false);return true;
 });
 assert.equal(appendCloseCalls,1);assert.equal(truncates,0);assert.equal(appendHandles.size,0);
 const bytes=fs.readFileSync(path.join(directory,'delta.jsonl'));assert.equal(JSON.parse(bytes).id,delta.id);
 fail=false;assert.throws(()=>store.heartbeat(delta),{code:'SCALE_COMMIT_UNCERTAIN'});assert.equal(appendCloseCalls,1);assert.equal(truncates,0);
 store.close();const restarted=create();assert.equal(restarted.summary().seq,1);assert.equal(restarted.heartbeat(delta).duplicate,true);
 assert.ok(fs.readFileSync(path.join(directory,'delta.jsonl')).equals(bytes));
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
