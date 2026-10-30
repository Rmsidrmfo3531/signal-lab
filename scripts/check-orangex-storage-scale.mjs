// Offline, bounded storage-layout experiment. No .env, server or production path.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {spawnSync} from 'node:child_process';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {OrangeXPaperStore} from '../orangex_paper_store.mjs';
import {OrangeXPaperJournal} from '../orangex_paper_journal.mjs';
import {OrangeXSyntheticSegmentedStorageLab,storageScaleFixture,materializeStorageScaleFixture,summarizeStorageScaleState} from '../orangex_paper_storage_lab.mjs';

const BACKENDS=['snapshot','journal','segmented_lab'];
const validInt=(value,min,max)=>Number.isSafeInteger(value)&&value>=min&&value<=max;
const fail=code=>Object.assign(Error(code),{code});
const ensure=(value,code)=>{if(!value)throw fail(code)};
const round=value=>Math.round(value*1000)/1000;
function implementation(){return Object.fromEntries(['../orangex_paper_store.mjs','../orangex_paper_journal.mjs','../orangex_paper_storage_lab.mjs','./check-orangex-storage-scale.mjs',
 '../orangex_paper.mjs','../orangex_paper_performance.mjs','./check-orangex-storage-performance.mjs'].map(relative=>[relative,createHash('sha256').update(fs.readFileSync(new URL(relative,import.meta.url))).digest('hex')]))}
function directoryBytes(directory){let bytes=0,files=0;for(const entry of fs.readdirSync(directory,{withFileTypes:true})){
 const full=path.join(directory,entry.name);if(entry.isDirectory()){const nested=directoryBytes(full);bytes+=nested.bytes;files+=nested.files}else if(entry.isFile()){bytes+=fs.statSync(full).size;files++}}
 return {bytes,files};
}
function trackedIO(){
 const io=Object.create(fs),counter={logicalBytesWritten:0,writeCalls:0,copyCalls:0,fsyncCalls:0};
 io.writeFileSync=(file,data,...args)=>{const result=fs.writeFileSync(file,data,...args);counter.logicalBytesWritten+=Buffer.byteLength(data);counter.writeCalls++;return result};
 io.writeSync=(...args)=>{const result=fs.writeSync(...args);counter.logicalBytesWritten+=result;counter.writeCalls++;return result};
 io.fsyncSync=(...args)=>{const result=fs.fsyncSync(...args);counter.fsyncCalls++;return result};
 io.copyFileSync=(source,target,...args)=>{const result=fs.copyFileSync(source,target,...args);counter.logicalBytesWritten+=fs.statSync(target).size;counter.copyCalls++;return result};
 return {io,counter};
}
function equivalent(actual,expected){
 for(const key of ['historySHA256','tradeCount','signalCount','fundingCount','updatedAt'])ensure(actual[key]===expected[key],'SCALE_RESTORED_'+key.toUpperCase()+'_MISMATCH');
 ensure(actual.accountingValid&&actual.accountingComplete,'SCALE_ACCOUNTING_INCOMPLETE');
 ensure(Math.abs(actual.realizedPnLUSD-expected.realizedPnLUSD)<=1e-8*Math.max(1,expected.tradeCount),'SCALE_PNL_MISMATCH');
}
export function runOrangeXStorageScaleCase({tradeCount=1000,backend='snapshot',mutations=5,segmentRows=1000}={}){
 ensure(validInt(tradeCount,1,50000)&&BACKENDS.includes(backend)&&validInt(mutations,1,10)&&validInt(segmentRows,1,1000),'SCALE_INVALID_OPTIONS');
 const scratch=process.env.ORANGEX_STORAGE_SCALE_SCRATCH_ROOT;
 const base=scratch&&path.basename(scratch).startsWith('orangex-scale-parent-')&&path.dirname(path.resolve(scratch))===fs.realpathSync(os.tmpdir())?scratch:fs.realpathSync(os.tmpdir());
 const directory=fs.mkdtempSync(path.join(base,'orangex-scale-')),{io,counter}=trackedIO(),at=performance.now(),cpu=process.cpuUsage(),metrics={},samples=[];
 let store,restoredStore,phase='fixture',heapPeak=0,rssPeak=0;
 const sample=label=>{const m=process.memoryUsage();heapPeak=Math.max(heapPeak,m.heapUsed);rssPeak=Math.max(rssPeak,m.rss);samples.push({phase:label,heapUsedBytes:m.heapUsed,rssBytes:m.rss})};
 const timed=(name,fn)=>{const begin=performance.now(),start=process.cpuUsage();try{return fn()}finally{const used=process.cpuUsage(start);metrics[name]={durationMs:round(performance.now()-begin),cpuUserMicros:used.user,cpuSystemMicros:used.system};sample(name)}};
 const common={kind:'ORANGEX_STORAGE_SCALE_CASE',executionMode:'SYNTHETIC_TEST',dataSource:'SYNTHETIC_FIXTURE',backend,tradeCount,mutations,segmentRows,
  implementation:implementation(),productionBackendConnected:false,userDataMigrationRun:false,actualOrangeXRequestsRun:false,
  scope:'SYNTHETIC_SEQUENTIAL_ID_HISTORY_AND_HEARTBEATS_NOT_TRADING_ENGINE_OR_GENERAL_ARCHIVE_BACKEND'};
 sample('start');
 try{
  const fixture=storageScaleFixture(tradeCount),expected=timed('streamExpectedHistory',()=>{
   const hash=createHash('sha256');let pnl=0;for(const row of fixture.rows()){hash.update(JSON.stringify(row)+'\n');pnl+=row.realizedPnLUSD}
   return {historySHA256:hash.digest('hex'),tradeCount,signalCount:tradeCount,fundingCount:tradeCount,realizedPnLUSD:pnl,updatedAt:fixture.active.updatedAt+mutations};
  });
  phase='initialize';
  const initial={...expected,updatedAt:fixture.active.updatedAt};
  const transactions=Array.from({length:mutations},(_,index)=>({id:'scale-heartbeat-'+index,updatedAt:fixture.active.updatedAt+index+1}));
  if(backend==='segmented_lab'){
   store=new OrangeXSyntheticSegmentedStorageLab({directory,io,segmentRows});
   timed('initializeStorage',()=>equivalent(store.initialize(fixture),initial));
  }else{
   let state=timed('materializeHistory',()=>materializeStorageScaleFixture(fixture));
   store=backend==='snapshot'?new OrangeXPaperStore({directory,io}):new OrangeXPaperJournal({directory,io});
   timed('initializeStorage',()=>backend==='snapshot'?store.write(state):store.initialize(state));state=null;
  }
  if(typeof globalThis.gc==='function')globalThis.gc();sample('after-initialization-gc');
  const before={...counter};phase='mutations';
  timed('storageMutations',()=>{
   if(backend==='snapshot'){
    const state=store.read();for(const tx of transactions){state.updatedAt=tx.updatedAt;state.connection={connected:true,at:tx.updatedAt};store.write(state)}
   }else for(const tx of transactions){
    if(backend==='journal')store.append({id:tx.id,ops:[{op:'set',path:['updatedAt'],value:tx.updatedAt},{op:'set',path:['connection'],value:{connected:true,at:tx.updatedAt}}]});
    else store.heartbeat(tx);
   }
  });
  const mutationWrites=Object.fromEntries(Object.keys(counter).map(key=>[key,counter[key]-before[key]]));
  const summarize=instance=>backend==='segmented_lab'?instance.summary():summarizeStorageScaleState(instance.read(),{segmentRows});
  timed('verifyAfterMutations',()=>equivalent(summarize(store),expected));
  phase='checkpoint';if(backend!=='snapshot')timed('checkpoint',()=>store.checkpoint());
  store.close();store=null;phase='restart';
  timed('restartAndFullIntegrityRead',()=>{
   store=backend==='snapshot'?new OrangeXPaperStore({directory,io}):backend==='journal'?new OrangeXPaperJournal({directory,io}):new OrangeXSyntheticSegmentedStorageLab({directory,io,segmentRows});
   equivalent(summarize(store),expected);
  });
  phase='backup';const backup=timed('backup',()=>store.backup());
  phase='restore';timed('restoreAndFullIntegrityRead',()=>{
   if(backend==='segmented_lab'){restoredStore=store.restoreBackup(backup);equivalent(restoredStore.summary(),expected)}
   else{store.restoreBackup(backup);equivalent(summarize(store),expected)}
  });
  const target=restoredStore??store;phase='idempotency';
  timed('idempotencyCheck',()=>{
   if(backend==='journal')ensure(target.append({id:transactions[0].id,ops:[{op:'set',path:['updatedAt'],value:transactions[0].updatedAt},{op:'set',path:['connection'],value:{connected:true,at:transactions[0].updatedAt}}]}).duplicate,'SCALE_DUPLICATE_DELTA_ACCEPTED');
   if(backend==='segmented_lab')ensure(target.heartbeat(transactions[0]).duplicate,'SCALE_DUPLICATE_DELTA_ACCEPTED');
   equivalent(summarize(target),expected);
  });
  const actual=timed('finalFullIntegrityRead',()=>summarize(target));equivalent(actual,expected);
  const used=process.cpuUsage(cpu);return {...common,status:'PASS',expected,actual,metrics,storage:{...directoryBytes(directory),...counter,mutationWrites},
   memory:{sampledPeakHeapUsedBytes:heapPeak,sampledPeakRssBytes:rssPeak,maxRssKiB:process.resourceUsage().maxRSS,controlledGcAvailable:typeof globalThis.gc==='function',samples},
   total:{durationMs:round(performance.now()-at),cpuUserMicros:used.user,cpuSystemMicros:used.system},
   checks:{sameHistoryDigest:true,accountingValid:true,allTradeSignalFundingIdsPreserved:true,fullIntegrityRestart:true,backupAndRestoreVerified:true,
    transportIdempotency:backend==='snapshot'?'NO_TRANSPORT_TRANSACTION_API_STATE_IDENTITIES_VERIFIED':'PASS'},
   limitations:backend==='segmented_lab'?['SYNTHETIC_SEQUENTIAL_IDS_ONLY_NOT_ARBITRARY_USER_LEDGER','HEARTBEAT_WAL_ONLY_NO_CLOSED_TRADE_APPEND_ENGINE_ADAPTER',
    'SEGMENT_AUDIT_AND_FULL_ARCHIVE_READ_INCLUDED','IMMUTABLE_ARCHIVES_NOT_PRUNED','RETAINED_DELTA_IDS_AND_WAL_STILL_GROW','NO_WINDOWS_POWER_FAILURE_VALIDATION']:[]};
 }catch(error){
  const code=typeof error.code==='string'?error.code:typeof error.message==='string'&&/^[A-Z0-9_]+$/.test(error.message)?error.message:'SCALE_INVARIANT_OR_IO_FAILURE';
  const capacity=['ORANGEX_PAPER_STORE_TOO_LARGE','JOURNAL_STATE_TOO_LARGE','JOURNAL_SIZE_LIMIT'].includes(code);
  return {...common,status:capacity?'CAPACITY_LIMIT':'FAILED',failure:{phase,code},metrics,storage:{...directoryBytes(directory),...counter},
   memory:{sampledPeakHeapUsedBytes:heapPeak,sampledPeakRssBytes:rssPeak,maxRssKiB:process.resourceUsage().maxRSS,samples},
   checks:{noUserDataTouched:true,noAutomaticTruncation:true,durableComparisonAvailable:false}};
 }finally{restoredStore?.close();store?.close();fs.rmSync(directory,{recursive:true,force:true,maxRetries:8,retryDelay:100})}
}
export function storageScaleOptions(args=[]){
 const options={tradeCounts:[1000,10000,50000],heapMiB:1024,timeoutMs:180000,mutations:5,segmentRows:1000};const seen=new Set();
 for(let index=0;index<args.length;index+=2){
  const key=args[index],value=args[index+1];ensure(typeof value==='string'&&!seen.has(key),'SCALE_INVALID_OPTIONS');seen.add(key);
  if(key==='--trades'){
   const values=value.split(',').map(Number);ensure(values.length>=1&&values.length<=3&&new Set(values).size===values.length&&values.every(n=>validInt(n,1,50000)),'SCALE_INVALID_OPTIONS');options.tradeCounts=values;
  }else if(key==='--heap-mib'){ensure(validInt(Number(value),256,2048),'SCALE_INVALID_OPTIONS');options.heapMiB=Number(value)}
  else if(key==='--timeout-ms'){ensure(validInt(Number(value),1000,300000),'SCALE_INVALID_OPTIONS');options.timeoutMs=Number(value)}
  else if(key==='--mutations'){ensure(validInt(Number(value),1,10),'SCALE_INVALID_OPTIONS');options.mutations=Number(value)}
  else if(key==='--segment-rows'){ensure(validInt(Number(value),1,1000),'SCALE_INVALID_OPTIONS');options.segmentRows=Number(value)}
  else throw fail('SCALE_INVALID_OPTIONS');
 }
 return options;
}
export function runOrangeXStorageScaleComparison({tradeCounts=[1000,10000,50000],heapMiB=1024,timeoutMs=180000,mutations=5,segmentRows=1000,nodePath=process.execPath}={}){
 ensure(Array.isArray(tradeCounts)&&tradeCounts.length>=1&&tradeCounts.length<=3&&new Set(tradeCounts).size===tradeCounts.length&&tradeCounts.every(n=>validInt(n,1,50000))&&
  validInt(heapMiB,256,2048)&&validInt(timeoutMs,1000,300000)&&validInt(mutations,1,10)&&validInt(segmentRows,1,1000)&&typeof nodePath==='string','SCALE_INVALID_OPTIONS');
 const results=[];
 for(const tradeCount of tradeCounts)for(const backend of BACKENDS){
  const env={PATH:process.env.PATH};for(const key of ['SystemRoot','TEMP','TMP','TMPDIR'])if(typeof process.env[key]==='string')env[key]=process.env[key];
  const parentScratch=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'orangex-scale-parent-'));env.ORANGEX_STORAGE_SCALE_SCRATCH_ROOT=parentScratch;
  const started=performance.now(),resultIndex=results.length;
  try{const child=spawnSync(nodePath,['--expose-gc','--max-old-space-size='+heapMiB,fileURLToPath(import.meta.url),'--worker',backend,String(tradeCount),String(mutations),String(segmentRows)],
   {env,encoding:'utf8',windowsHide:true,timeout:timeoutMs,maxBuffer:8*1024*1024});
   let row;try{row=JSON.parse(child.stdout)}catch{}
   if(child.status===0&&row?.kind==='ORANGEX_STORAGE_SCALE_CASE')results.push(row);
   else{
   const memory=/heap out of memory|reached heap limit|allocation failed/i.test(child.stderr??''),timeout=child.error?.code==='ETIMEDOUT';
   results.push({kind:'ORANGEX_STORAGE_SCALE_CASE',executionMode:'SYNTHETIC_TEST',dataSource:'SYNTHETIC_FIXTURE',backend,tradeCount,mutations,segmentRows,
    implementation:implementation(),status:memory?'MEMORY_LIMIT':timeout?'TIMEOUT':'WORKER_FAILED',failure:{code:memory?'NODE_HEAP_LIMIT':timeout?'WORKER_TIME_LIMIT':'WORKER_EXIT_OR_INVALID_OUTPUT',exitCode:child.status,signal:child.signal??null,heapMiB,timeoutMs},
    measurementsUnavailable:true,elapsedMs:round(performance.now()-started),partialTemporaryStorage:directoryBytes(parentScratch),productionBackendConnected:false,userDataMigrationRun:false,actualOrangeXRequestsRun:false});
   }
  }finally{fs.rmSync(parentScratch,{recursive:true,force:true,maxRetries:8,retryDelay:100});ensure(!fs.existsSync(parentScratch),'SCALE_TEMP_CLEANUP_FAILED');
   if(results[resultIndex])results[resultIndex].temporaryRootCleanupVerified=true}
 }
 const checks=tradeCounts.map(tradeCount=>{const rows=results.filter(r=>r.tradeCount===tradeCount),passed=rows.filter(r=>r.status==='PASS');
  return {tradeCount,statuses:Object.fromEntries(rows.map(r=>[r.backend,r.status])),sameHistoryAmongCompleted:passed.length?new Set(passed.map(r=>r.actual.historySHA256)).size===1:null,
   allThreeDurablyCompleted:passed.length===3};});
 const implementationConsistent=new Set(results.map(row=>JSON.stringify(row.implementation))).size===1;
 const invariantFailure=results.some(r=>['FAILED','WORKER_FAILED'].includes(r.status))||checks.some(r=>r.sameHistoryAmongCompleted===false)||!implementationConsistent;
 return {kind:'ORANGEX_STORAGE_SCALE_COMPARISON',executionMode:'SYNTHETIC_TEST',dataSource:'SYNTHETIC_FIXTURE',nodeVersion:process.version,platform:process.platform,
  status:invariantFailure?'FAILED':results.every(r=>r.status==='PASS')?'PASS':'COMPLETED_WITH_LIMITS',tradeCounts,heapMiB,timeoutMs,mutations,segmentRows,implementationConsistent,
  actualOrangeXRequestsRun:false,existingUserRecordsTouched:false,productionStorageChanged:false,userDataMigrationRun:false,allTemporaryRootsCleaned:results.every(row=>row.temporaryRootCleanupVerified===true),
  measurementDefinitions:{restart:'NEW_INSTANCE_AND_FULL_HISTORY_INTEGRITY_AND_ACCOUNTING_VERIFICATION',restore:'OWN_BACKUP_RESTORE_AND_FULL_HISTORY_INTEGRITY_AND_ACCOUNTING_VERIFICATION',
   memory:'ISOLATED_WORKER_STAGE_SAMPLES_AND_PROCESS_MAXRSS','writeBytes':'LOGICAL_APPLICATION_PAYLOAD_NOT_PHYSICAL_DISK_IO',failedWorker:'NO_RESOURCE_METRICS_FABRICATED_IF_WORKER_DID_NOT_RETURN'},
  limitations:['SYNTHETIC_SEQUENTIAL_HISTORY_TEMPLATE_NOT_REAL_EXCHANGE_TRADES','STORAGE_ONLY_HEARTBEATS_NOT_END_TO_END_ENGINE_SPEED',
   'SEGMENTED_MODEL_NOT_A_GENERAL_USER_LEDGER_BACKEND','NO_AUTOMATIC_PRODUCTION_MIGRATION','LIMIT_FAILURE_IS_NOT_A_PERFORMANCE_WIN','REAL_WINDOWS_NOT_RUN_BY_LINUX_WORKERS'],results,checks};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 try{const args=process.argv.slice(2);let report;
  if(args[0]==='--worker'&&args.length===5)report=runOrangeXStorageScaleCase({backend:args[1],tradeCount:Number(args[2]),mutations:Number(args[3]),segmentRows:Number(args[4])});
  else report=runOrangeXStorageScaleComparison(storageScaleOptions(args));
  console.log(JSON.stringify(report,null,2));if(report.status==='FAILED'||report.status==='WORKER_FAILED')process.exitCode=1;
 }catch{console.error('합성 저장 확장 검사 실패. 사용자 기록·설정·저장 방식은 변경하지 않습니다.');process.exitCode=1}
}
