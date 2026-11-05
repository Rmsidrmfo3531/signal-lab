// Offline storage diagnostics and owned-worker lifecycle only. No application
// store, credential file or network transport is accessed by this module.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {performance} from 'node:perf_hooks';

const TRACE_LIMITS=Object.freeze({io:512,phase:2048}),MAX_TRACE_BYTES=4*1024*1024,counts=new Map(),started=performance.now();
const prefix=/^(?:signal-ci-trace-|orangex-(?:performance|scale)-parent-)/;
function ownedDirectory(directory){
 const stat=fs.lstatSync(directory);
 if(!stat.isDirectory()||stat.isSymbolicLink())throw Error('UNSAFE_STORAGE_DIAGNOSTIC_DIRECTORY');
 const real=fs.realpathSync(directory),temporary=fs.realpathSync(os.tmpdir());
 if(path.relative(temporary,path.dirname(real))!==''||!prefix.test(path.basename(real)))throw Error('UNSAFE_STORAGE_DIAGNOSTIC_DIRECTORY');
 return real;
}
function validTrace(file){
 if(typeof file!=='string'||!file||!file.endsWith('.trace.jsonl'))return null;
 const parent=ownedDirectory(path.dirname(file)),target=path.join(parent,path.basename(file)),stat=fs.lstatSync(target);
 if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||stat.size>MAX_TRACE_BYTES)throw Error('UNSAFE_STORAGE_DIAGNOSTIC_FILE');
 return target;
}
export function traceStorageStage(scope,stage,details={}){
 const record={scope,stage,pid:process.pid,at:new Date().toISOString(),elapsedMs:Math.round(performance.now()-started),...details};
 const category=/^io[:.]/.test(stage)?'io':'phase';
 let written=false;
 for(const input of new Set([process.env.SIGNAL_LAB_TEST_TRACE_FILE,process.env.SIGNAL_LAB_STORAGE_WORKER_TRACE_FILE])){
  if(!input)continue;
  // Once a category is capped, repeated storage operations must not keep
  // performing lstat/realpath/open calls merely to discard diagnostic records.
  const prior=counts.get(input);
  if(prior?.limited.has(category))continue;
  try{
   const file=validTrace(input);if(!file)continue;
   const count=prior??counts.get(file)??{io:0,phase:0,limited:new Set()},limit=TRACE_LIMITS[category],limited=count[category]>=limit;
   if(limited&&count.limited.has(category))continue;
   const item=limited?{scope:'storage.diagnostics',stage:'trace:limit',pid:process.pid,at:new Date().toISOString(),category,limit}:record;
   const fd=fs.openSync(file,fs.constants.O_WRONLY|fs.constants.O_APPEND|(fs.constants.O_NOFOLLOW??0));
   try{
    const stat=fs.fstatSync(fd);if(!stat.isFile()||stat.nlink!==1||stat.size>MAX_TRACE_BYTES)throw Error('UNSAFE_STORAGE_DIAGNOSTIC_FILE');
    fs.writeSync(fd,JSON.stringify(item)+'\n');
    if(limited)count.limited.add(category);else count[category]++;
    counts.set(file,count);counts.set(input,count);written=true;
   }finally{fs.closeSync(fd)}
  }catch{
   // Diagnostics are never allowed to overwrite arbitrary files or to turn
   // an unverified diagnostic into a successful storage acknowledgement.
   // A missing trace remains explicit in readStorageWorkerTrace().
  }
 }
 return written;
}
export function createStorageWorkerScratch(kind){
 if(!['performance','scale'].includes(kind))throw Error('INVALID_STORAGE_WORKER_KIND');
 const directory=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'orangex-'+kind+'-parent-'));
 const traceFile=path.join(directory,'progress.trace.jsonl');fs.writeFileSync(traceFile,'',{flag:'wx',mode:0o600});
 return {directory,traceFile};
}
export function storageWorkerEnvironment(scratch){
 const directory=ownedDirectory(scratch.directory),traceFile=validTrace(scratch.traceFile),env={PATH:process.env.PATH};
 for(const key of ['SystemRoot','TEMP','TMP','TMPDIR'])if(typeof process.env[key]==='string')env[key]=process.env[key];
 env.SIGNAL_LAB_STORAGE_WORKER_ROOT=directory;env.SIGNAL_LAB_STORAGE_WORKER_TRACE_FILE=traceFile;
 if(process.env.SIGNAL_LAB_TEST_TRACE_FILE){try{env.SIGNAL_LAB_TEST_TRACE_FILE=validTrace(process.env.SIGNAL_LAB_TEST_TRACE_FILE)}catch{}}
 return env;
}
export function storageWorkerBase(kind){
 const root=process.env.SIGNAL_LAB_STORAGE_WORKER_ROOT;
 if(root){
  const real=ownedDirectory(root);
  if(!path.basename(real).startsWith('orangex-'+kind+'-parent-'))throw Error('INVALID_STORAGE_WORKER_ROOT');
  return real;
 }
 return fs.realpathSync(os.tmpdir());
}
export function readStorageWorkerTrace(scratch){
 try{
  const file=validTrace(scratch.traceFile),rows=fs.readFileSync(file,'utf8').trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));
  const phase=[...rows].reverse().find(row=>row.stage?.startsWith('phase:'))??null;
  const operation=[...rows].reverse().find(row=>row.stage?.startsWith('io:'))??null;
  return {status:rows.length?'OBSERVED':'NO_WORKER_PROGRESS',records:rows,lastPhase:phase,lastOperation:operation,
   truncated:rows.some(row=>row.stage==='trace:limit'),traceLimits:TRACE_LIMITS};
 }catch(error){return {status:'UNAVAILABLE',records:[],lastPhase:null,lastOperation:null,errorCode:error.code??error.message};}
}
export function removeStorageWorkerScratch(scratch){
 const directory=ownedDirectory(scratch.directory);
 fs.rmSync(directory,{recursive:true,force:true,maxRetries:8,retryDelay:100});
 if(fs.existsSync(directory))throw Error('STORAGE_WORKER_TEMP_CLEANUP_FAILED');
}
export function runStorageWorkerSync(nodePath,args,{env,timeoutMs,maxBuffer=8*1024*1024}={}){
 if(typeof nodePath!=='string'||!Array.isArray(args)||!Number.isSafeInteger(timeoutMs)||timeoutMs<100||timeoutMs>300000)throw Error('INVALID_STORAGE_WORKER_OPTIONS');
 return spawnSync(nodePath,args,{env,encoding:'utf8',windowsHide:true,timeout:timeoutMs,killSignal:'SIGKILL',maxBuffer});
}
export function traceStorageIO(io,scope){
 const traced=Object.create(io),descriptors=new Map();
 for(const method of ['mkdirSync','openSync','fsyncSync','closeSync','renameSync','unlinkSync']){
  traced[method]=(...args)=>{
   const target=['fsyncSync','closeSync'].includes(method)?descriptors.get(args[0])??null:String(args[0]);
   traceStorageStage(scope,'io:'+method+':begin',{target,...(method==='renameSync'?{destination:String(args[1])}:{})});
   try{
    const result=io[method](...args);
    if(method==='openSync')descriptors.set(result,target);
    if(method==='closeSync')descriptors.delete(args[0]);
    traceStorageStage(scope,'io:'+method+':end',{target,...(method==='mkdirSync'?{firstCreatedDirectory:result??null}:{})});return result;
   }catch(error){traceStorageStage(scope,'io:'+method+':error',{target,errorCode:error.code??error.name});throw error;}
  };
 }
 return traced;
}
