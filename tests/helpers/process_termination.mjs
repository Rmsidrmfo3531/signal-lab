// Test-only process-state confirmation. Sending a signal or closing an inherited
// pipe can precede the kernel's final process-state transition.
import fs from 'node:fs';
import {performance} from 'node:perf_hooks';
import {setTimeout as pause} from 'node:timers/promises';

export function processTerminationState(pid,{platform=process.platform,
 probe=(value,signal)=>process.kill(value,signal),readStat=file=>fs.readFileSync(file,'utf8')}={}){
 if(!Number.isSafeInteger(pid)||pid<=0)throw new RangeError('Invalid owned process PID');
 const absent=()=>{
  try{probe(pid,0);return false}catch(error){if(error.code==='ESRCH')return true;throw error;}
 };
 if(absent())return {terminated:true,state:'EXITED'};
 if(platform!=='linux')return {terminated:false,state:'RUNNING'};
 let stat;
 try{stat=readStat('/proc/'+pid+'/stat')}
 catch(error){
  // The PID can disappear between the successful signal-0 probe and /proc read.
  // A missing /proc entry alone does not prove termination: check the PID again.
  if(error.code!=='ENOENT')throw error;
  return absent()?{terminated:true,state:'EXITED'}:{terminated:false,state:'PROC_ENTRY_NOT_READY'};
 }
 const match=/^\d+ \(.*\) ([A-Z])(?: |$)/s.exec(String(stat));
 if(!match)throw Object.assign(Error('Invalid owned process state record'),{code:'PROCESS_STAT_INVALID'});
 // A container's PID 1 may defer reaping; Z has exited and owns no open handles.
 // R, S and every other live/transitional state still require confirmation.
 return {terminated:match[1]==='Z',state:match[1]};
}

export async function waitForProcessTermination(pid,{timeoutMs=1000,pollIntervalMs=20,...options}={}){
 if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>5000||
  !Number.isSafeInteger(pollIntervalMs)||pollIntervalMs<1||pollIntervalMs>1000)
  throw new RangeError('Invalid process termination confirmation deadline');
 const started=performance.now(),deadline=started+timeoutMs;let attempts=0,last;
 for(;;){
  last=processTerminationState(pid,options);attempts++;
  const now=performance.now();
  if(last.terminated)return {...last,attempts,elapsedMs:now-started};
  if(now>=deadline){
   const error=Error(`Owned process ${pid} has not terminated; last observed state ${last.state}`);
   Object.assign(error,{code:'PROCESS_TERMINATION_TIMEOUT',pid,lastState:last.state,attempts,elapsedMs:now-started});throw error;
  }
  // The timer is referenced and bounded by the remaining monotonic deadline.
  // Already terminated processes return immediately; this is no fixed sleep.
  await pause(Math.min(pollIntervalMs,deadline-now));
 }
}
