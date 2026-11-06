// Seeded-history storage experiments only. No network, .env or application store.
// The journal backend is opt-in and is never substituted into the running app.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {isDeepStrictEqual} from 'node:util';
import {OrangeXPaperEngine} from '../orangex_paper.mjs';
import {OrangeXPaperStore} from '../orangex_paper_store.mjs';
import {OrangeXPaperJournal} from '../orangex_paper_journal.mjs';
import {auditOrangeXPaperAccounting} from '../orangex_paper_performance.mjs';
import {traceStorageStage,traceStorageIO,createStorageWorkerScratch,storageWorkerEnvironment,storageWorkerBase,readStorageWorkerTrace,removeStorageWorkerScratch,runStorageWorkerSync,parseStorageWorkerResult} from './storage-worker.mjs';

const START=Date.parse('2026-01-01T00:00:01Z'),INTERVAL=28800000,NAME='BTC-USDT-PERPETUAL';
const SETTINGS={capitalUSD:1e9,leverage:3,maxRiskUSD:6,dailyLossLimitUSD:1000000,maxPositions:2,
 maxPositionNotionalUSD:500,maxTotalNotionalUSD:1000,maxQuoteAgeMs:90000,maxSignalAgeMs:7200000,
 entryTimeoutMs:1200000,maxSpreadBps:30,maxSlippageBps:100,killSwitch:false};
const CONTRACT={instrumentName:NAME,symbol:'BTCUSDT',source:'SYNTHETIC_FIXTURE',quantityUnit:'CONTRACT',
 contractSizeBase:1,minQty:.001,qtyStep:.001,minNotional:1,priceTick:.01,makerRate:.0002,takerRate:.0006,
 feeUnit:'FRACTION',fundingRate:.0001,fundingIntervalMs:INTERVAL,unitsVerifiedForSimulation:true};
const BACKENDS=new Set(['snapshot','journal']);
const PATTERNS=new Set(['heartbeat','append_trade']);
const book=(at,bid=99.99,ask=100.01)=>({instrumentName:NAME,dataSource:'SYNTHETIC_FIXTURE',timestamp:at,
 markPrice:(bid+ask)/2,markPriceAt:at,bids:[[bid,100000]],asks:[[ask,100000]]});
function ordered(value){
 if(Array.isArray(value))return value.map(ordered);
 if(value!==null&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(key=>[key,ordered(value[key])]));
 return value;
}
const hash=state=>createHash('sha256').update(JSON.stringify(ordered(state))).digest('hex');
const ensure=(condition,code)=>{if(!condition)throw Error(code)};
const integer=(value,min,max)=>Number.isSafeInteger(value)&&value>=min&&value<=max;
const round=value=>Math.round(value*1000)/1000;
const implementationDigests=()=>Object.fromEntries([
 ['engine','../orangex_paper.mjs'],['snapshotStore','../orangex_paper_store.mjs'],
 ['experimentalJournal','../orangex_paper_journal.mjs'],['benchmark','./check-orangex-storage-performance.mjs'],['workerLifecycle','./storage-worker.mjs']
].map(([key,relative])=>[key,createHash('sha256').update(fs.readFileSync(new URL(relative,import.meta.url))).digest('hex')]));

/** Build large histories in O(N), from a genuine engine-generated funded trade.
 * This is not N independent market or strategy discoveries. Every history item
 * remains a labelled synthetic template with a unique signal/funding identity.
 */
export function buildSyntheticStorageLedger(tradeCount){
 if(!integer(tradeCount,1,20000))throw Error('INVALID_STORAGE_TRADE_COUNT');
 let clock=START;
 const engine=new OrangeXPaperEngine({}, {now:()=>clock,settings:SETTINGS,contracts:[CONTRACT],
  executionMode:'SYNTHETIC_TEST',runKind:'FORWARD_PAPER'});
 ensure(engine.register({key:'storage-template',symbol:'BTCUSDT',instrumentName:NAME,direction:'LONG',entry:100,stop:98,
  timeframe:'1h',trendTimeframe:'4h',confirmed:true,trendConfirmed:true,patternConfirmedAt:clock-1},
  {dataSource:'SYNTHETIC_FIXTURE'}),'STORAGE_TEMPLATE_SIGNAL_REJECTED');
 clock++;engine.onMarket(book(clock));ensure(engine.exportState().open.length===1,'STORAGE_TEMPLATE_ENTRY_FAILED');
 clock=Math.ceil(clock/INTERVAL)*INTERVAL;
 ensure(engine.applyFunding({id:'storage-template-funding',instrumentName:NAME,dataSource:'SYNTHETIC_FIXTURE',at:clock,
  rate:.0001,markPrice:100}),'STORAGE_TEMPLATE_FUNDING_FAILED');
 clock++;engine.onMarket(book(clock,101,101.01));ensure(engine.closePosition('storage-template'),'STORAGE_TEMPLATE_CLOSE_FAILED');
 const seed=engine.exportState(),template=seed.closed[0];
 ensure(template&&template.fundingParts.length===1,'STORAGE_TEMPLATE_INCOMPLETE');
 seed.closed=[];seed.seen={};seed.fundingSeen={};seed.events=[];seed.rejections=[];
 for(let index=0;index<tradeCount;index++){
  const p=structuredClone(template),offset=index*2*INTERVAL;
  p.key=`storage-history-${String(index).padStart(5,'0')}`;
  for(const key of ['openedAt','lastPriceAt','markPriceAt','closedAt'])p[key]+=offset;
  for(const part of [...p.entryParts,...p.exitParts])part.at+=offset;
  for(const part of p.fundingParts){part.at+=offset;part.id=`storage-funding-${String(index).padStart(5,'0')}`;seed.fundingSeen[part.id]=part.at}
  seed.closed.push(p);seed.seen[p.key]=p.openedAt-1;
 }
 const last=seed.closed.at(-1);seed.updatedAt=last.closedAt;seed.connection={connected:true,at:last.closedAt};
 seed.lastMarkets={[NAME]:book(last.closedAt,101,101.01)};
 const audit=auditOrangeXPaperAccounting(seed,{now:last.closedAt});
 ensure(audit.valid&&audit.complete,'STORAGE_SYNTHETIC_HISTORY_AUDIT_FAILED');return seed;
}

function instrumentedIO(){
 const counters={logicalBytesWritten:0,writeCalls:0,copyCalls:0,fsyncCalls:0};
 const io=Object.create(fs);
 io.writeFileSync=(file,data,...args)=>{
  const result=fs.writeFileSync(file,data,...args);
  counters.logicalBytesWritten+=Buffer.isBuffer(data)?data.length:Buffer.byteLength(String(data));counters.writeCalls++;return result;
 };
 io.writeSync=(...args)=>{
  const written=fs.writeSync(...args);counters.logicalBytesWritten+=written;counters.writeCalls++;return written;
 };
 io.fsyncSync=(...args)=>{const result=fs.fsyncSync(...args);counters.fsyncCalls++;return result};
 io.copyFileSync=(source,target,...args)=>{
  const result=fs.copyFileSync(source,target,...args);counters.logicalBytesWritten+=fs.statSync(target).size;counters.copyCalls++;return result;
 };
 return {io,counters};
}
function directoryBytes(directory){
 let total=0,files=0;
 for(const entry of fs.readdirSync(directory,{withFileTypes:true})){
  const target=path.join(directory,entry.name);
  if(entry.isDirectory()){const nested=directoryBytes(target);total+=nested.bytes;files+=nested.files}
  else if(entry.isFile()){total+=fs.statSync(target).size;files++}
 }
 return {bytes:total,files};
}
function mutations(seed,count,pattern){
 if(pattern==='append_trade'){
  let prior=seed.closed.at(-1);
  return Array.from({length:count},(_,index)=>{
   const p=structuredClone(prior),number=seed.closed.length+index;
   p.key=`storage-history-${String(number).padStart(5,'0')}`;
   for(const key of ['openedAt','lastPriceAt','markPriceAt','closedAt'])p[key]+=2*INTERVAL;
   for(const part of [...p.entryParts,...p.exitParts])part.at+=2*INTERVAL;
   for(const part of p.fundingParts){part.at+=2*INTERVAL;part.id=`storage-funding-${String(number).padStart(5,'0')}`}
   prior=p;
   return {id:`storage-bench-append-${index}`,ops:[
    {op:'append',path:['closed'],value:p},
    {op:'set',path:['seen',p.key],value:p.openedAt-1},
    {op:'set',path:['fundingSeen',p.fundingParts[0].id],value:p.fundingParts[0].at},
    {op:'set',path:['lastMarkets',NAME],value:book(p.closedAt,101,101.01)},
    {op:'set',path:['updatedAt'],value:p.closedAt},
    {op:'set',path:['connection'],value:{connected:true,at:p.closedAt}}
   ]};
  });
 }
 return Array.from({length:count},(_,index)=>({id:`storage-bench-heartbeat-${index}`,ops:[
  {op:'set',path:['updatedAt'],value:seed.updatedAt+index+1},
  {op:'set',path:['connection'],value:{connected:true,at:seed.updatedAt+index+1}}
 ]}));
}
function applyBenchmarkTransaction(state,transaction){
 for(const op of transaction.ops){
  if(op.op==='append')state[op.path[0]].push(structuredClone(op.value));
  else if(op.path.length===1)state[op.path[0]]=structuredClone(op.value);
  else state[op.path[0]][op.path[1]]=structuredClone(op.value);
 }
}

/** Each worker isolates GC and peak-memory accounting for one backend/history.
 * Scope is storage, not a production-engine migration: the standalone core
 * transaction measurement still includes its unchanged full-state clones.
 */
export function runOrangeXStorageCase({tradeCount=1000,backend='snapshot',mutations:mutationCount=5,mutationPattern='heartbeat'}={}){
 if(!integer(tradeCount,1,20000)||!BACKENDS.has(backend)||!integer(mutationCount,1,25)||!PATTERNS.has(mutationPattern))throw Error('INVALID_STORAGE_BENCHMARK_OPTIONS');
 const scope='storage.performance.'+backend+'.'+tradeCount;
 traceStorageStage(scope,'phase:worker:begin',{backend,tradeCount});
 const directory=fs.mkdtempSync(path.join(storageWorkerBase('performance'),'orangex-storage-performance-')),
  instrumented=instrumentedIO(),io=traceStorageIO(instrumented.io,scope),counters=instrumented.counters,cpuStart=process.cpuUsage(),started=performance.now();
 let store=null,peakHeap=0,peakRss=0,phase='build',lastMemory;
 const implementation=implementationDigests();
 const memorySamples=[];
 const sample=label=>{
  const memory=process.memoryUsage();peakHeap=Math.max(peakHeap,memory.heapUsed);peakRss=Math.max(peakRss,memory.rss);
  memorySamples.push({phase:label,heapUsedBytes:memory.heapUsed,rssBytes:memory.rss});lastMemory=memory;return memory;
 };
 const baseline=sample('worker-start'),metrics={},checks={};
 const timed=(name,fn)=>{
  const cpu=process.cpuUsage(),at=performance.now();let value;
  traceStorageStage(scope,'phase:'+name+':begin',{backend,tradeCount});
  try{value=fn();return value}finally{const used=process.cpuUsage(cpu);metrics[name]={durationMs:round(performance.now()-at),cpuUserMicros:used.user,cpuSystemMicros:used.system};sample(name);traceStorageStage(scope,'phase:'+name+':end',{backend,tradeCount,durationMs:metrics[name].durationMs})}
 };
 try{
  let seed=timed('generateSyntheticHistory',()=>buildSyntheticStorageLedger(tradeCount));
  const initialHash=hash(seed),seedBytes=Buffer.byteLength(JSON.stringify(seed)),ops=mutations(seed,mutationCount,mutationPattern);
  const expected=structuredClone(seed);for(const transaction of ops)applyBenchmarkTransaction(expected,transaction);
  const expectedHash=hash(expected);
  // Same standalone costs in both workers; they are not attributed to journal
  // storage improvements or silently removed from an end-to-end claim.
  let encoded;
  timed('fullStateClone',()=>{for(let i=0;i<mutationCount;i++){const value=structuredClone(seed);ensure(value.closed.length===tradeCount,'CLONE_LOST_HISTORY')}});
  timed('fullStateSerialize',()=>{for(let i=0;i<mutationCount;i++)encoded=JSON.stringify({kind:'ORANGEX_PAPER_OFFLINE',version:1,state:seed},null,2)});
  const fullSnapshotBytes=Buffer.byteLength(encoded);encoded=null;
  timed('coreReconstructWithoutDisk',()=>{const e=new OrangeXPaperEngine(seed,{now:()=>seed.updatedAt+1});ensure(e.store.closed.length===tradeCount,'CORE_RESTART_LOST_HISTORY')});
  timed('coreMutationWithoutDisk',()=>{
   let clock=seed.updatedAt;
   const e=new OrangeXPaperEngine(seed,{now:()=>clock,onChange:candidate=>ensure(candidate.closed.length===tradeCount,'CORE_MUTATION_LOST_HISTORY')});
   for(let index=0;index<mutationCount;index++){clock++;e.onMarket(book(clock,101,101.01))}
  });
  if(typeof globalThis.gc==='function')globalThis.gc();sample('after-controlled-gc');
  const beforeStorage={...counters};
  phase='initialize';
  store=backend==='snapshot'?new OrangeXPaperStore({directory,io,now:()=>expected.updatedAt}):
   new OrangeXPaperJournal({directory,io,now:()=>expected.updatedAt});
  try{timed('initializeStorage',()=>backend==='snapshot'?store.write(seed):store.initialize(seed))}
  catch(error){
   if(backend!=='snapshot'||error.code!=='ORANGEX_PAPER_STORE_TOO_LARGE')throw error;
   const cpu=process.cpuUsage(cpuStart),disk=directoryBytes(directory);
   return {kind:'ORANGEX_STORAGE_PERFORMANCE_CASE',executionMode:'SYNTHETIC_TEST',backend,tradeCount,mutationCount,mutationPattern,implementation,
    status:'CAPACITY_LIMIT',failure:{phase,code:error.code,existingSnapshotLimitBytes:16*1024*1024},
    scope:'SEEDED_HISTORY_STEADY_STATE_MUTATIONS_NOT_STRATEGY_TRADES',productionBackendChanged:false,
    seededHistory:{compactBytes:seedBytes,formattedSnapshotBytes:fullSnapshotBytes,initialHash},metrics,
    storage:{...disk,...counters,logicalBytesDefinition:'SUCCESSFUL_APPLICATION_WRITE_PAYLOAD_BYTES_NOT_PHYSICAL_BLOCK_IO'},
    memory:{startHeapUsedBytes:baseline.heapUsed,endHeapUsedBytes:lastMemory.heapUsed,sampledPeakHeapUsedBytes:peakHeap,
     startRssBytes:baseline.rss,endRssBytes:lastMemory.rss,sampledPeakRssBytes:peakRss,maxRssKiB:process.resourceUsage().maxRSS,
     controlledGcAvailable:typeof globalThis.gc==='function',samples:memorySamples},
    total:{durationMs:round(performance.now()-started),cpuUserMicros:cpu.user,cpuSystemMicros:cpu.system},
    checks:{baselineLimitPreserved:true,noDataReset:true,durableMutationComparisonAvailable:false}};
  }
  const initializedCounters={...counters};
  phase='mutations';
  timed('storageMutations',()=>{
   if(backend==='snapshot'){
    const current=structuredClone(seed);
    for(const transaction of ops){applyBenchmarkTransaction(current,transaction);store.write(current)}
   }else for(const transaction of ops)store.append(transaction);
  });
  const mutationCounters={logicalBytesWritten:counters.logicalBytesWritten-initializedCounters.logicalBytesWritten,
   writeCalls:counters.writeCalls-initializedCounters.writeCalls,copyCalls:counters.copyCalls-initializedCounters.copyCalls,
   fsyncCalls:counters.fsyncCalls-initializedCounters.fsyncCalls};
  timed('verifyReadAfterMutations',()=>{const state=store.read();ensure(hash(state)===expectedHash,'STORAGE_MUTATION_HASH_MISMATCH')});
  const checkpointName=backend==='journal'?timed('checkpoint',()=>store.checkpoint()):null;
  phase='restart';store.close();store=null;
  let restarted;
  timed('restartRead',()=>{
   store=backend==='snapshot'?new OrangeXPaperStore({directory,io}):new OrangeXPaperJournal({directory,io});
   restarted=store.read();
  });
  ensure(hash(restarted)===expectedHash,'STORAGE_RESTART_HASH_MISMATCH');restarted=null;
  phase='backup';const backup=timed('backup',()=>store.backup());
  timed('restoreBackup',()=>{store.restoreBackup(backup);ensure(hash(store.read())===expectedHash,'STORAGE_RESTORE_HASH_MISMATCH')});
  const restored=store.read(),first=restored.closed[0],last=restored.closed.at(-1);
  checks.signalIdentityPersisted=restored.seen[first.key]===expected.seen[first.key]&&restored.seen[last.key]===expected.seen[last.key];
  checks.fundingIdentityPersisted=restored.fundingSeen[first.fundingParts[0].id]===expected.fundingSeen[first.fundingParts[0].id]&&
   restored.fundingSeen[last.fundingParts[0].id]===expected.fundingSeen[last.fundingParts[0].id];
  checks.historyPreserved=restored.closed.length===expected.closed.length&&isDeepStrictEqual(restored.closed.slice(0,tradeCount),seed.closed);
  checks.appendedTradesPreserved=isDeepStrictEqual(restored.closed.slice(tradeCount),expected.closed.slice(tradeCount));
  checks.restartAndRestoreHashesMatch=hash(restored)===expectedHash;
  const audit=timed('independentAccountingAudit',()=>auditOrangeXPaperAccounting(restored,{now:restored.updatedAt}));
  ensure(audit.valid&&audit.complete,'STORAGE_RESTORED_ACCOUNTING_AUDIT_FAILED');
  checks.independentAccountingValid=audit.valid;checks.independentAccountingComplete=audit.complete;
  ensure(Object.values(checks).every(Boolean),'STORAGE_IDENTITY_OR_HISTORY_LOST');
  const disk=directoryBytes(directory),cpu=process.cpuUsage(cpuStart);
  return {kind:'ORANGEX_STORAGE_PERFORMANCE_CASE',executionMode:'SYNTHETIC_TEST',backend,tradeCount,mutationCount,mutationPattern,implementation,finalTradeCount:restored.closed.length,
   status:'PASS',scope:'SEEDED_HISTORY_STEADY_STATE_MUTATIONS_NOT_STRATEGY_TRADES',productionBackendChanged:false,
   seededHistory:{compactBytes:seedBytes,formattedSnapshotBytes:fullSnapshotBytes,initialHash,finalHash:expectedHash},metrics,
   storage:{...disk,...counters,initializeLogicalBytes:initializedCounters.logicalBytesWritten-beforeStorage.logicalBytesWritten,
    mutationWrites:mutationCounters,checkpointCreated:Boolean(checkpointName),
    logicalBytesDefinition:'SUCCESSFUL_APPLICATION_WRITE_PAYLOAD_BYTES_NOT_PHYSICAL_BLOCK_IO'},
   memory:{startHeapUsedBytes:baseline.heapUsed,endHeapUsedBytes:lastMemory.heapUsed,sampledPeakHeapUsedBytes:peakHeap,
    startRssBytes:baseline.rss,endRssBytes:lastMemory.rss,sampledPeakRssBytes:peakRss,maxRssKiB:process.resourceUsage().maxRSS,
    controlledGcAvailable:typeof globalThis.gc==='function',samples:memorySamples},
   total:{durationMs:round(performance.now()-started),cpuUserMicros:cpu.user,cpuSystemMicros:cpu.system},checks};
 }catch(error){
  return {kind:'ORANGEX_STORAGE_PERFORMANCE_CASE',executionMode:'SYNTHETIC_TEST',backend,tradeCount,mutationCount,mutationPattern,implementation,
   status:'FAILED',failure:{phase,code:typeof error.code==='string'?error.code:
    typeof error.message==='string'&&/^[A-Z0-9_]+$/.test(error.message)?error.message:'BENCHMARK_INVARIANT_OR_IO_FAILURE'},
   scope:'SEEDED_HISTORY_STEADY_STATE_MUTATIONS_NOT_STRATEGY_TRADES',productionBackendChanged:false,metrics};
 }finally{traceStorageStage(scope,'phase:cleanup:begin',{backend,tradeCount,directory});if(store)store.close();fs.rmSync(directory,{recursive:true,force:true,maxRetries:8,retryDelay:100});traceStorageStage(scope,'phase:cleanup:end',{backend,tradeCount,directory})}
}

export function storagePerformanceOptions(args=[]){
 const options={tradeCounts:[1000,10000,10001],mutations:5,mutationPattern:'heartbeat'};
 let counts=false,mutationsSet=false,patternSet=false;
 for(let index=0;index<args.length;index++){
  if(args[index]==='--trades'&&!counts&&typeof args[index+1]==='string'){
   const values=args[++index].split(',').map(Number);
   if(!values.length||values.length>4||values.some(n=>!integer(n,1,20000))||new Set(values).size!==values.length)throw Error('INVALID_STORAGE_BENCHMARK_OPTIONS');
   options.tradeCounts=values;counts=true;continue;
  }
  if(args[index]==='--mutations'&&!mutationsSet&&integer(Number(args[index+1]),1,25)){
   options.mutations=Number(args[++index]);mutationsSet=true;continue;
  }
  if(args[index]==='--pattern'&&!patternSet&&PATTERNS.has(args[index+1])){options.mutationPattern=args[++index];patternSet=true;continue}
  throw Error('INVALID_STORAGE_BENCHMARK_OPTIONS');
 }
 return options;
}
export function runOrangeXStorageComparison({tradeCounts=[1000,10000,10001],mutations:mutationCount=5,mutationPattern='heartbeat',nodePath=process.execPath,workerTimeoutMs=180000}={}){
 if(!Array.isArray(tradeCounts)||!tradeCounts.length||tradeCounts.length>4||tradeCounts.some(n=>!integer(n,1,20000))||
  new Set(tradeCounts).size!==tradeCounts.length||!integer(mutationCount,1,25)||!PATTERNS.has(mutationPattern)||typeof nodePath!=='string'||!integer(workerTimeoutMs,1000,180000))throw Error('INVALID_STORAGE_BENCHMARK_OPTIONS');
 const results=[];
 for(const tradeCount of tradeCounts)for(const backend of BACKENDS){
  const scratch=createStorageWorkerScratch('performance'),workerEnv=storageWorkerEnvironment(scratch),at=performance.now();
  traceStorageStage('storage.performance.parent','phase:spawn:begin',{backend,tradeCount,timeoutMs:workerTimeoutMs});
  let row;
  try{
   const child=runStorageWorkerSync(nodePath,['--expose-gc',fileURLToPath(import.meta.url),'--worker',backend,String(tradeCount),String(mutationCount),mutationPattern],
    {timeoutMs:workerTimeoutMs,env:workerEnv});
   const value=parseStorageWorkerResult(child,{kind:'ORANGEX_STORAGE_PERFORMANCE_CASE',backend,tradeCount,mutationCount,mutationPattern});
   if(value)row=value;
   else{
    const timeout=child.error?.code==='ETIMEDOUT';
    row={kind:'ORANGEX_STORAGE_PERFORMANCE_CASE',executionMode:'SYNTHETIC_TEST',backend,tradeCount,mutationCount,mutationPattern,implementation:implementationDigests(),
     status:timeout?'TIMEOUT':'WORKER_FAILED',failure:{code:timeout?'WORKER_TIME_LIMIT':'WORKER_EXIT_OR_INVALID_OUTPUT',exitCode:child.status,signal:child.signal??null,timeoutMs:workerTimeoutMs,errorCode:child.error?.code??null},
     measurementsUnavailable:true,productionBackendChanged:false};
   }
   row.workerElapsedMs=round(performance.now()-at);row.diagnostics=readStorageWorkerTrace(scratch);
   traceStorageStage('storage.performance.parent','phase:spawn:end',{backend,tradeCount,status:row.status,elapsedMs:row.workerElapsedMs,lastPhase:row.diagnostics.lastPhase?.stage??null});
   results.push(row);
  }finally{
   traceStorageStage('storage.performance.parent','phase:parentCleanup:begin',{backend,tradeCount,directory:scratch.directory});
   removeStorageWorkerScratch(scratch);if(row)row.temporaryRootCleanupVerified=true;
   traceStorageStage('storage.performance.parent','phase:parentCleanup:end',{backend,tradeCount});
  }
 }
 const implementationConsistent=new Set(results.map(row=>JSON.stringify(row.implementation))).size===1;
 return {kind:'ORANGEX_STORAGE_PERFORMANCE_COMPARISON',executionMode:'SYNTHETIC_TEST',nodeVersion:process.version,
  status:results.some(row=>['FAILED','TIMEOUT','WORKER_FAILED'].includes(row.status))?'FAILED':!implementationConsistent?'INCONSISTENT_IMPLEMENTATION':results.some(row=>row.status==='CAPACITY_LIMIT')?'COMPLETED_WITH_CAPACITY_LIMIT':'PASS',
  platform:process.platform,architecture:process.arch,tradeCounts,mutationCount,mutationPattern,workerTimeoutMs,allTemporaryRootsCleaned:results.every(row=>row.temporaryRootCleanupVerified===true),diagnosticTracingIncludedInWallTime:true,actualOrangeXRequestsRun:false,
  existingUserRecordsTouched:false,productionStorageChanged:false,implementationConsistent,results,
  capacityLimits:results.filter(row=>row.status==='CAPACITY_LIMIT').map(row=>({backend:row.backend,tradeCount:row.tradeCount,code:row.failure.code})),
  comparablePairs:tradeCounts.map(tradeCount=>{
   const [snapshot,journal]=results.filter(result=>result.tradeCount===tradeCount);
   return {tradeCount,identicalSeed:snapshot.seededHistory?.initialHash===journal.seededHistory?.initialHash,
    identicalImplementation:JSON.stringify(snapshot.implementation)===JSON.stringify(journal.implementation),
    bothDurablyCompleted:snapshot.status==='PASS'&&journal.status==='PASS',
    snapshotStatus:snapshot.status,journalStatus:journal.status};
  }),measurementDefinitions:{coreMutationWithoutDisk:'CONSTRUCT_ONE_ENGINE_AND_APPLY_N_FRESH_NO_POSITION_BOOKS_WITH_EXISTING_FULL_STATE_CALLBACK',
   fullStateClone:'N_STRUCTURED_CLONE_OPERATIONS',fullStateSerialize:'N_CURRENT_FORMAT_PRETTY_JSON_SERIALIZATIONS',
   restartRead:'NEW_STORAGE_INSTANCE_AND_READ_INCLUDING_BACKEND_INTEGRITY_CHECKS_AND_RETURNED_STATE_CLONE',
   restoreBackup:'RESTORE_THEN_READ_AND_VERIFY_CANONICAL_STATE_HASH',memory:'ISOLATED_PROCESS_SAMPLED_HEAP_RSS_AND_PROCESS_RESOURCE_USAGE_MAXRSS',
   logicalBytesWritten:'SUCCESSFUL_APPLICATION_WRITE_PAYLOAD_BYTES_NOT_PHYSICAL_BLOCKS'},
  limitations:['SEEDED_HISTORY_NOT_TEN_THOUSAND_REALTIME_STRATEGY_FILLS','DELTA_STORAGE_API_NOT_PRODUCTION_ENGINE_MIGRATION',
   'CORE_FULL_STATE_TRANSACTION_CLONES_MEASURED_SEPARATELY_AND_UNCHANGED','WORKERS_ISOLATED_AND_CONTROLLED_GC_USED_IF_AVAILABLE',
   'APPLICATION_PAYLOAD_BYTES_ARE_NOT_PHYSICAL_DISK_WRITE_AMPLIFICATION','BASELINE_CAPACITY_FAILURE_IS_NOT_A_PERFORMANCE_WIN',
   'FINITE_STEADY_STATE_WORKLOAD_NOT_UNBOUNDED_UPTIME_OR_LEAK_PROOF']};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 try{
  const args=process.argv.slice(2);let result;
  if(args[0]==='--worker'&&args.length===5)result=runOrangeXStorageCase({backend:args[1],tradeCount:Number(args[2]),mutations:Number(args[3]),mutationPattern:args[4]});
  else result=runOrangeXStorageComparison(storagePerformanceOptions(args));
  console.log(JSON.stringify(result,null,2));
  if(['FAILED','INCONSISTENT_IMPLEMENTATION'].includes(result.status)||result.results?.some(row=>row.status==='FAILED'))process.exitCode=1;
 }catch{
  console.error('합성 저장 성능 검사 실패. 기존 사용자 기록과 저장 방식은 변경하지 않습니다.');
  console.error('사용법: node scripts/check-orangex-storage-performance.mjs [--trades 1000,10000,10001] [--mutations 5] [--pattern heartbeat|append_trade]');
  process.exitCode=1;
 }
}
