import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
 createStorageWorkerScratch,storageWorkerEnvironment,storageWorkerBase,
 traceStorageStage,traceStorageIO,readStorageWorkerTrace,removeStorageWorkerScratch,runStorageWorkerSync
} from '../scripts/storage-worker.mjs';

function withEnvironment(values,run){
 const previous=new Map(Object.keys(values).map(key=>[key,process.env[key]]));
 for(const [key,value] of Object.entries(values)){
  if(value===undefined)delete process.env[key];else process.env[key]=value;
 }
 try{return run()}finally{for(const [key,value] of previous){if(value===undefined)delete process.env[key];else process.env[key]=value;}}
}

test('storage diagnostics cannot append to settings, unrelated paths or hard-linked files',()=>{
 const scratch=createStorageWorkerScratch('performance');
 try{
  const settings=path.join(scratch.directory,'.env');fs.writeFileSync(settings,'preserved settings bytes');
  assert.equal(withEnvironment({SIGNAL_LAB_TEST_TRACE_FILE:settings,SIGNAL_LAB_STORAGE_WORKER_TRACE_FILE:undefined},()=>
   traceStorageStage('synthetic','phase:must-not-write')),false);
  assert.equal(fs.readFileSync(settings,'utf8'),'preserved settings bytes');
  const nested=path.join(scratch.directory,'nested');fs.mkdirSync(nested);
  const unrelated=path.join(nested,'unrelated.trace.jsonl');fs.writeFileSync(unrelated,'preserved nested bytes');
  assert.equal(withEnvironment({SIGNAL_LAB_TEST_TRACE_FILE:unrelated,SIGNAL_LAB_STORAGE_WORKER_TRACE_FILE:undefined},()=>
   traceStorageStage('synthetic','phase:must-not-write')),false);
  assert.equal(fs.readFileSync(unrelated,'utf8'),'preserved nested bytes');
  const linked=path.join(scratch.directory,'linked.trace.jsonl');fs.linkSync(scratch.traceFile,linked);
  assert.equal(withEnvironment({SIGNAL_LAB_TEST_TRACE_FILE:linked,SIGNAL_LAB_STORAGE_WORKER_TRACE_FILE:undefined},()=>
   traceStorageStage('synthetic','phase:hardlink-must-not-write')),false);
  assert.equal(fs.readFileSync(scratch.traceFile,'utf8'),'');
 }finally{removeStorageWorkerScratch(scratch)}
});

test('I/O trace quota remains bounded without discarding a later storage phase',()=>{
 const scratch=createStorageWorkerScratch('scale');
 try{
  assert.equal(readStorageWorkerTrace(scratch).status,'NO_WORKER_PROGRESS');
  withEnvironment({SIGNAL_LAB_TEST_TRACE_FILE:scratch.traceFile,SIGNAL_LAB_STORAGE_WORKER_TRACE_FILE:scratch.traceFile},()=>{
   for(let index=0;index<700;index++)traceStorageStage('synthetic','io:record',{index});
   assert.equal(traceStorageStage('synthetic','phase:after-io'),true);
  });
  const progress=readStorageWorkerTrace(scratch);
  assert.equal(progress.status,'OBSERVED');assert.equal(progress.records.filter(row=>row.stage==='io:record').length,512);
  assert.equal(progress.truncated,true);assert.equal(progress.lastPhase.stage,'phase:after-io');
  assert.equal(progress.lastOperation.index,511);assert.ok(progress.records.length<=516);
  assert.ok(fs.statSync(scratch.traceFile).size<256*1024);
 }finally{removeStorageWorkerScratch(scratch)}
});

test('worker environments keep only runtime selectors and refuse mismatched temporary roots',()=>{
 const scratch=createStorageWorkerScratch('performance');
 try{
  withEnvironment({TELEGRAM_BOT_TOKEN:'synthetic-not-a-real-token',ORANGEX_CLIENT_SECRET:'synthetic-not-a-real-secret',
   SIGNAL_LAB_DATA_DIR:path.join(scratch.directory,'must-not-be-forwarded'),SIGNAL_LAB_TEST_TRACE_FILE:undefined},()=>{
   const env=storageWorkerEnvironment(scratch);
   assert.equal(env.TELEGRAM_BOT_TOKEN,undefined);assert.equal(env.ORANGEX_CLIENT_SECRET,undefined);
   assert.equal(env.SIGNAL_LAB_DATA_DIR,undefined);assert.equal(env.SIGNAL_LAB_STORAGE_WORKER_ROOT,scratch.directory);
   assert.equal(env.SIGNAL_LAB_STORAGE_WORKER_TRACE_FILE,scratch.traceFile);
   assert.ok(Object.keys(env).every(key=>['PATH','SystemRoot','TEMP','TMP','TMPDIR',
    'SIGNAL_LAB_STORAGE_WORKER_ROOT','SIGNAL_LAB_STORAGE_WORKER_TRACE_FILE'].includes(key)));
   withEnvironment(env,()=>{
    assert.equal(storageWorkerBase('performance'),scratch.directory);
    assert.throws(()=>storageWorkerBase('scale'),/INVALID_STORAGE_WORKER_ROOT/);
   });
  });
  assert.throws(()=>createStorageWorkerScratch('production'),/INVALID_STORAGE_WORKER_KIND/);
 }finally{removeStorageWorkerScratch(scratch)}
});

test('instrumented fsync retains the actual I/O error and records the last attempted operation',()=>{
 const scratch=createStorageWorkerScratch('scale');
 try{
  const expected=Object.assign(Error('synthetic fsync failure'),{code:'EIO'}),raw=Object.create(fs);
  raw.fsyncSync=()=>{throw expected};
  withEnvironment({SIGNAL_LAB_TEST_TRACE_FILE:scratch.traceFile,SIGNAL_LAB_STORAGE_WORKER_TRACE_FILE:undefined},()=>{
   const io=traceStorageIO(raw,'synthetic-io'),file=path.join(scratch.directory,'data.json'),fd=io.openSync(file,'wx');
   try{assert.throws(()=>io.fsyncSync(fd),error=>error===expected)}finally{io.closeSync(fd)}
  });
  const progress=readStorageWorkerTrace(scratch),failure=progress.records.find(row=>row.stage==='io:fsyncSync:error');
  assert.equal(failure.errorCode,'EIO');assert.equal(failure.target,path.join(scratch.directory,'data.json'));
  assert.equal(progress.lastOperation.stage,'io:closeSync:end');
 }finally{removeStorageWorkerScratch(scratch)}
});

test('a timed-out real storage child is killed and reaped while preserving its last phase',{timeout:10000},()=>{
 const scratch=createStorageWorkerScratch('performance'),moduleURL=new URL('../scripts/storage-worker.mjs',import.meta.url).href;
 try{
  const source=`import {traceStorageStage} from ${JSON.stringify(moduleURL)};
   traceStorageStage('synthetic-child','phase:blocked',{backend:'journal'});
   console.log(JSON.stringify({pid:process.pid}));setInterval(()=>{},1000);`;
  const started=Date.now(),child=runStorageWorkerSync(process.execPath,['--input-type=module','-e',source],
   {env:storageWorkerEnvironment(scratch),timeoutMs:3000});
  assert.equal(child.error?.code,'ETIMEDOUT');assert.notEqual(child.status,0);
  assert.ok(Date.now()-started<8000,'timeout must also bound process termination');
  const pid=JSON.parse(child.stdout).pid;assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});
  const progress=readStorageWorkerTrace(scratch);
  assert.equal(progress.status,'OBSERVED');assert.equal(progress.lastPhase.stage,'phase:blocked');
  assert.equal(progress.lastPhase.backend,'journal');
 }finally{removeStorageWorkerScratch(scratch);assert.equal(fs.existsSync(scratch.directory),false)}
});

test('worker deadlines cannot be disabled or silently expanded by invalid arguments',()=>{
 for(const timeoutMs of [0,-1,NaN,Infinity,300001])assert.throws(()=>runStorageWorkerSync(process.execPath,[],{timeoutMs}),/INVALID_STORAGE_WORKER_OPTIONS/);
});
