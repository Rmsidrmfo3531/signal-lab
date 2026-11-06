import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {processTerminationState,waitForProcessTermination} from './helpers/process_termination.mjs';
import {trackChild,stopChild} from './helpers/child_process.mjs';

const missing=()=>Object.assign(Error('process absent'),{code:'ESRCH'});
const stat=state=>`123 (fixture process) ${state} 1 1 1`;

test('termination confirmation rechecks transient running and sleeping states until the process has exited',async()=>{
 const states=['R','S','Z'];let reads=0;
 const result=await waitForProcessTermination(123,{platform:'linux',timeoutMs:200,pollIntervalMs:5,
  probe:(pid,signal)=>{assert.equal(pid,123);assert.equal(signal,0)},
  readStat:()=>stat(states[Math.min(reads++,states.length-1)])});
 assert.equal(result.terminated,true);assert.equal(result.state,'Z');assert.equal(result.attempts,3);assert.equal(reads,3);
});

test('missing proc entries are verified against PID liveness again instead of treated as automatic success',async()=>{
 let probes=0;
 const result=processTerminationState(123,{platform:'linux',probe:()=>{if(++probes===2)throw missing()},
  readStat:()=>{throw Object.assign(Error('process disappeared between reads'),{code:'ENOENT'})}});
 assert.equal(probes,2);assert.deepEqual(result,{terminated:true,state:'EXITED'});
 const stillAlive=processTerminationState(123,{platform:'linux',probe:()=>{},
  readStat:()=>{throw Object.assign(Error('entry missing'),{code:'ENOENT'})}});
 assert.deepEqual(stillAlive,{terminated:false,state:'PROC_ENTRY_NOT_READY'});
 await assert.rejects(waitForProcessTermination(123,{platform:'linux',timeoutMs:20,pollIntervalMs:5,
  probe:()=>{},readStat:()=>stat('R')}),error=>error.code==='PROCESS_TERMINATION_TIMEOUT'&&error.lastState==='R');
});

test('permissions, malformed states and disabled deadlines cannot manufacture a terminated process',async()=>{
 const denied=Object.assign(Error('permission denied'),{code:'EPERM'});
 assert.throws(()=>processTerminationState(123,{probe:()=>{throw denied}}),error=>error===denied);
 assert.throws(()=>processTerminationState(123,{platform:'linux',probe:()=>{},readStat:()=>''}),{code:'PROCESS_STAT_INVALID'});
 assert.deepEqual(processTerminationState(123,{platform:'win32',probe:()=>{}}),{terminated:false,state:'RUNNING'});
 assert.deepEqual(processTerminationState(123,{platform:'win32',probe:()=>{throw missing()}}),{terminated:true,state:'EXITED'});
 for(const timeoutMs of [0,-1,Infinity,NaN,5001])await assert.rejects(waitForProcessTermination(123,{timeoutMs}),/deadline/);
});

test('an actual live child fails the confirmation deadline and only succeeds after termination',{timeout:5000},async()=>{
 const child=trackChild(spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true}));
 try{
  await assert.rejects(waitForProcessTermination(child.pid,{timeoutMs:80,pollIntervalMs:10}),
   error=>error.code==='PROCESS_TERMINATION_TIMEOUT'&&error.attempts>=1&&!['EXITED','Z'].includes(error.lastState));
  assert.equal(child.kill('SIGKILL'),true);
  const result=await waitForProcessTermination(child.pid,{timeoutMs:1000,pollIntervalMs:10});
  assert.equal(result.terminated,true);assert.ok(['EXITED','Z'].includes(result.state));
 }finally{await stopChild(child,{graceMs:500,killMs:500})}
});
