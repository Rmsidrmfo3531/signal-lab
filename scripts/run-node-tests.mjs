// Offline CI orchestration only. The deadline covers the entire test process,
// including leaked handles after test bodies finish; a timeout is always failure.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {StringDecoder} from 'node:string_decoder';

const exec=promisify(execFile),PROJECT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const integer=(value,min,max)=>Number.isSafeInteger(value)&&value>=min&&value<=max;
const stamp=()=>new Date().toISOString();
const emptyCounts=()=>({tests:0,pass:0,fail:0,cancelled:0,skipped:0,todo:0});
async function boundedWait(promise,ms){
 let timer;
 try{return await Promise.race([promise,new Promise(resolve=>{timer=setTimeout(()=>resolve(false),ms)})])}
 finally{clearTimeout(timer)}
}

export function testRunnerOptions(args=[]){
 const options={concurrency:2,fileTimeoutMs:120000,outputDir:null,files:[]},seen=new Set();
 for(let index=0;index<args.length;index+=2){
  const flag=args[index],value=args[index+1];
  if(!value||!['--concurrency','--file-timeout-ms','--output-dir','--file'].includes(flag)||flag!=='--file'&&seen.has(flag))
   throw Error('INVALID_TEST_RUNNER_OPTIONS');
  seen.add(flag);
  if(flag==='--concurrency')options.concurrency=Number(value);
  if(flag==='--file-timeout-ms')options.fileTimeoutMs=Number(value);
  if(flag==='--output-dir')options.outputDir=value;
  if(flag==='--file')options.files.push(value);
 }
 if(!integer(options.concurrency,1,4)||!integer(options.fileTimeoutMs,500,120000))throw Error('INVALID_TEST_RUNNER_OPTIONS');
 return options;
}

export function discoverTestFiles(root=PROJECT){
 return fs.readdirSync(path.join(root,'tests'),{withFileTypes:true}).filter(item=>item.isFile()&&item.name.endsWith('.test.mjs'))
  .map(item=>'tests/'+item.name).sort();
}

export async function terminateOwnedTestTree(child,{platform=process.platform,execFileFn=exec,killGroup=process.kill}={}){
 if(!integer(child.pid,1,Number.MAX_SAFE_INTEGER))return;
 if(platform==='win32'){
  // Kill the tree while its owning Node test runner still exists. Do not kill
  // Node first and leave worker/server descendants retaining file handles.
  try{await execFileFn('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,timeout:5000,killSignal:'SIGKILL'})}
  catch(error){if(child.exitCode===null&&child.signalCode===null)throw error}
 }else{
  try{killGroup(-child.pid,'SIGKILL')}catch(error){if(error.code!=='ESRCH')throw error}
 }
}

async function runFile(file,index,options,onStart,onFinish){
 const startedAt=stamp(),start=performance.now(),counts=emptyCounts(),logName=String(index+1).padStart(3,'0')+'-'+path.basename(file)+'.tap',
  traceName=logName.replace(/\.tap$/,'.trace.jsonl'),traceFile=path.join(options.traceRoot,traceName),
  row={file,startedAt,log:logName,trace:traceName,status:'RUNNING'};
 // Reporting can fail (for example ENOSPC). Do it before acquiring a process
 // or stream handle, so a failed START cannot strand an untracked worker.
 onStart(row);
 fs.writeFileSync(traceFile,'',{flag:'wx',mode:0o600});
 const logFile=path.join(options.outputDir,logName),log=fs.createWriteStream(logFile,{flags:'wx'});
 let logError=null,spawnError=null,tail='',line='',timedOut=false,aborted=false,cleanupError=null,closed=false,deadline,onAbort,
  traceOffset=0,tracePending='',traceRecords=0,lastStoragePhase=null,traceTimer,traceCaptureError=null;
 const summaryFields=new Set(),traceDecoder=new StringDecoder('utf8');
 log.on('error',error=>{logError=error});
 // A sidecar remains observable even when a test or spawnSync worker blocks its
 // own event loop and the native test reporter buffers all stdout/stderr.
 const env={...options.env,SIGNAL_LAB_TEST_TRACE_FILE:traceFile};
 const relayTrace=()=>{
  const stat=fs.lstatSync(traceFile);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||stat.size>8*1024*1024||stat.size<traceOffset)throw Error('TEST_TRACE_INVALID_OR_OVERSIZED');
  if(stat.size===traceOffset)return;
  const buffer=Buffer.alloc(stat.size-traceOffset),fd=fs.openSync(traceFile,'r');let read;
  try{read=fs.readSync(fd,buffer,0,buffer.length,traceOffset)}finally{fs.closeSync(fd)}
  traceOffset+=read;tracePending+=traceDecoder.write(buffer.subarray(0,read));
  let at;
  while((at=tracePending.indexOf('\n'))!==-1){
   const line=tracePending.slice(0,at);tracePending=tracePending.slice(at+1);
   if(!line.trim())continue;
   let record;try{record=JSON.parse(line)}catch{throw Error('TEST_TRACE_INVALID_JSON')}
   if(!record||typeof record!=='object'||Array.isArray(record)||typeof record.stage!=='string'||record.stage.length>240)
    throw Error('TEST_TRACE_INVALID_RECORD');
   traceRecords++;
   // Show only stage metadata, never arbitrary record fields or file contents.
   const visible=Object.fromEntries(['at','pid','scope','stage','elapsedMs','backend','tradeCount','operation','test','code','requested','returned',
    'returnedFirst','directory','target','destination','firstCreatedDirectory','errorCode','customIO','fd','truncated']
    .filter(key=>['string','number','boolean'].includes(typeof record[key])).map(key=>[key,record[key]]));
   lastStoragePhase=visible;
   options.print(`[STORAGE PHASE] ${file} ${JSON.stringify(visible)}`);
  }
 };
 // A nested native test runner must bootstrap its own IPC context.
 for(const key of ['NODE_TEST_CONTEXT','NODE_CHANNEL_FD','NODE_UNIQUE_ID'])delete env[key];
 const testTimeoutMs=Math.max(60000,Math.min(options.fileTimeoutMs,115000));
 const child=spawn(options.nodePath,['--test','--test-reporter=tap',`--test-timeout=${testTimeoutMs}`,file],{
  cwd:options.root,env,windowsHide:true,detached:process.platform!=='win32',stdio:['ignore','pipe','pipe']});
 const ended=new Promise(resolve=>child.once('close',(code,signal)=>{closed=true;resolve({code,signal})}));
 child.once('error',error=>{spawnError=error});
 child.stdout.pipe(log,{end:false});child.stderr.pipe(log,{end:false});
 child.stdout.on('data',chunk=>{
  line+=String(chunk);let at;
  while((at=line.indexOf('\n'))!==-1){
   const value=line.slice(0,at).trimEnd();line=line.slice(at+1);
   const match=/^# (tests|pass|fail|cancelled|skipped|todo) (\d+)$/.exec(value);
   if(match){counts[match[1]]=Number(match[2]);summaryFields.add(match[1]);}
  }
  if(line.length>8192)line=line.slice(-8192);
 });
 const remember=chunk=>{tail=(tail+String(chunk)).slice(-4096)};
 child.stdout.on('data',remember);child.stderr.on('data',remember);
 let outcome;
 try{
  const traceFailure=new Promise((resolve,reject)=>{
   traceTimer=setInterval(()=>{try{relayTrace()}catch(error){reject(error)}},1000);
  });
  const limit=new Promise(resolve=>{deadline=setTimeout(()=>resolve(null),options.fileTimeoutMs)});
  const cancellation=new Promise(resolve=>{
   onAbort=()=>{aborted=true;resolve(null)};
   if(options.signal?.aborted)onAbort();else options.signal?.addEventListener('abort',onAbort,{once:true});
  });
  outcome=await Promise.race([ended,limit,cancellation,traceFailure]);clearTimeout(deadline);
  if(outcome===null){
   timedOut=!aborted;options.print(`[TEST ${aborted?'ABORT':'TIMEOUT'}] ${file}: terminating its owned process tree`);
   try{await terminateOwnedTestTree(child)}catch(error){cleanupError=error.code??error.name;}
   outcome=await boundedWait(ended,5000);
   if(outcome===false){cleanupError??='PROCESS_CLOSE_UNCONFIRMED';outcome={code:null,signal:null};}
  }
 }catch(error){
  // A failing diagnostic callback must not bypass the process cleanup path.
  if(!closed){
   try{await terminateOwnedTestTree(child)}catch(cause){cleanupError=cause.code??cause.name;}
   if(!await boundedWait(ended,5000))cleanupError??='PROCESS_CLOSE_UNCONFIRMED';
  }
  if(cleanupError)error.cleanupError=cleanupError;
  throw error;
 }finally{
  clearTimeout(deadline);
  clearInterval(traceTimer);
  options.signal?.removeEventListener('abort',onAbort);
  try{
   relayTrace();tracePending+=traceDecoder.end();fs.copyFileSync(traceFile,path.join(options.outputDir,traceName));
   if(tracePending.trim())throw Error('TEST_TRACE_PARTIAL_RECORD');
  }
  catch(error){traceCaptureError=error.code??error.message}
  // Do not let broken pipes obscure a failing, unconfirmed process cleanup.
  if(!closed){child.stdout.destroy();child.stderr.destroy();child.unref();}
  log.end();await new Promise(resolve=>{if(log.closed)return resolve();log.once('close',resolve)});
  options.onWorkerCleanup({file,pid:child.pid??null,processClosed:closed,stdoutClosed:child.stdout.closed,
   stderrClosed:child.stderr.closed,logClosed:log.closed,cleanupError});
 }
 const failureCode=aborted?'RUN_ABORTED':timedOut?'FILE_TIMEOUT':spawnError?'SPAWN_ERROR':logError?'LOG_WRITE_FAILED':traceCaptureError?'TRACE_CAPTURE_FAILED':
  outcome.code!==0?'TEST_PROCESS_FAILED':summaryFields.size!==6||counts.tests<1?'INCOMPLETE_TEST_SUMMARY':
   counts.fail||counts.cancelled||counts.skipped||counts.todo||counts.pass!==counts.tests?'TESTS_NOT_ALL_PASSED':null;
 const result={...row,status:failureCode||cleanupError?'FAIL':'PASS',completedAt:stamp(),durationMs:Math.round(performance.now()-start),
  exitCode:outcome.code,signal:outcome.signal,timedOut,aborted,processClosed:closed,failureCode,cleanupError,
  traceRecords,lastStoragePhase,traceCaptureError,...counts};
 onFinish(result);
 options.print(`[TEST ${result.status}] ${file} ${result.durationMs}ms (${counts.pass}/${counts.tests})${failureCode?' '+failureCode:''} log=${logName}`);
 if(result.status==='FAIL')options.print(tail);
 return result;
}

export async function runNodeTests({root=PROJECT,files,concurrency=2,fileTimeoutMs=120000,outputDir,nodePath=process.execPath,
 env=process.env,print=console.log,heartbeatMs=15000,signal}={}){
 root=path.resolve(root);files=files?.length?[...files]:discoverTestFiles(root);
 if(!integer(concurrency,1,4)||!integer(fileTimeoutMs,500,120000)||!integer(heartbeatMs,100,30000)||files.length===0||new Set(files).size!==files.length)
  throw Error('INVALID_TEST_RUNNER_OPTIONS');
 for(const file of files)if(!/^tests\/[A-Za-z0-9_.-]+\.test\.mjs$/.test(file)||!fs.statSync(path.join(root,file)).isFile())throw Error('INVALID_TEST_FILE');
 outputDir=path.resolve(outputDir??fs.mkdtempSync(path.join(os.tmpdir(),'signal-node-tests-')));
 fs.mkdirSync(outputDir,{recursive:true});
 if(fs.readdirSync(outputDir).length)throw Error('TEST_OUTPUT_DIRECTORY_NOT_EMPTY');
 const traceRoot=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'signal-ci-trace-'));
 const cancellation=new AbortController(),combinedSignal=signal?AbortSignal.any([signal,cancellation.signal]):cancellation.signal,
  startedAt=stamp(),running=new Map(),results=[],workerCleanup=[],settings={root,concurrency,fileTimeoutMs,outputDir,traceRoot,nodePath,env,print,signal:combinedSignal,
   onWorkerCleanup:row=>workerCleanup.push(row)};
 let cursor=0,fatalError=null;
 const fail=error=>{fatalError??=error;cancellation.abort();};
 const progress=()=>fs.writeFileSync(path.join(outputDir,'progress.json'),JSON.stringify({startedAt,updatedAt:stamp(),
  totalFiles:files.length,completedFiles:results.length,active:[...running.values()],pending:files.slice(cursor)},null,2)+'\n');
 const heartbeat=setInterval(()=>{
  try{print(`[TEST ACTIVE] ${stamp()} ${[...running.values()].map(row=>row.file+' ('+Math.round((Date.now()-Date.parse(row.startedAt))/1000)+'s)').join(', ')}`)}catch(error){fail(error);}
 },heartbeatMs);
 const worker=async()=>{
  try{
   while(cursor<files.length&&!combinedSignal.aborted){
    const index=cursor++,file=files[index];
    await runFile(file,index,settings,row=>{running.set(file,row);progress();print(`[TEST START] ${row.startedAt} ${file}`)},row=>{
     running.delete(file);results.push(row);progress();
    });
   }
  }catch(error){fail(error);throw error;}
 };
 try{
  progress();
  // A reporter/storage failure aborts other active workers; await their owned
  // tree cleanup before surfacing the original failure to the CLI.
  await Promise.allSettled(Array.from({length:Math.min(concurrency,files.length)},worker));
  if(fatalError)throw fatalError;
 }catch(error){
  // Preserve the original reporting failure while recording whether every
  // owned process, pipe and log actually closed before a caller removes cwd.
  fatalError??=error;error.workerCleanup=workerCleanup;throw error;
 }finally{
  clearInterval(heartbeat);
  if(workerCleanup.some(row=>!row.processClosed||!row.stdoutClosed||!row.stderrClosed||!row.logClosed||row.cleanupError)){
   const error=fatalError??Object.assign(Error('Owned worker cleanup is unconfirmed; traces retained'),{code:'TEST_WORKER_CLEANUP_UNCONFIRMED'});
   error.workerCleanup=workerCleanup;error.traceDirectoryRetained=traceRoot;throw error;
  }
  // Yield during transient Windows lock retry so pending native close callbacks
  // can run. The retry count/delay are unchanged; a persistent lock still fails.
  try{await fs.promises.rm(traceRoot,{recursive:true,force:true,maxRetries:8,retryDelay:100})}
  catch(error){
   if(!fatalError)throw error;
   fatalError.traceCleanupError={code:error.code??error.name,syscall:error.syscall??null};
   fatalError.traceDirectoryRetained=traceRoot;throw fatalError;
  }
 }
 const counts=results.reduce((sum,row)=>{for(const key of Object.keys(sum))sum[key]+=row[key];return sum},emptyCounts()),
  passed=!combinedSignal.aborted&&results.length===files.length&&results.every(row=>row.status==='PASS'),summary={kind:'NODE_TEST_FILE_RESULTS',
   passed,aborted:combinedSignal.aborted,pendingFiles:files.slice(cursor),startedAt,completedAt:stamp(),runtime:process.version,platform:process.platform,concurrency,fileTimeoutMs,
   totalFiles:files.length,completedFiles:results.length,failedFiles:results.filter(row=>row.status!=='PASS').length,...counts,
   workerCleanup,results:results.sort((a,b)=>a.file.localeCompare(b.file))};
 fs.writeFileSync(path.join(outputDir,'summary.json'),JSON.stringify(summary,null,2)+'\n');
 print(`[TEST SUMMARY] ${passed?'PASS':'FAIL'}: ${counts.pass}/${counts.tests} tests; ${summary.failedFiles}/${files.length} failed files; reports=${outputDir}`);
 return summary;
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const controller=new AbortController(),abort=()=>controller.abort();
 process.once('SIGINT',abort);process.once('SIGTERM',abort);
 try{const result=await runNodeTests({...testRunnerOptions(process.argv.slice(2)),signal:controller.signal});process.exitCode=result.passed?0:1}
 catch(error){console.error('Node test runner failed:',error.code??error.message);process.exitCode=1;}
 finally{process.removeListener('SIGINT',abort);process.removeListener('SIGTERM',abort);}
}
