import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {setImmediate as yieldTurn} from 'node:timers/promises';
import {removeOwnedTestDirectory} from './helpers/owned_directory.mjs';
import {trackChild,stopChild} from './helpers/child_process.mjs';
import {waitForProcessTermination} from './helpers/process_termination.mjs';

const sandbox=()=>fs.mkdtempSync(path.join(os.tmpdir(),'signal-owned-cleanup-'));
const busy=()=>Object.assign(Error('injected transient Windows directory lock'),{code:'EBUSY',syscall:'rmdir'});
const closed={pid:123,processClosed:true,stdoutClosed:true,stderrClosed:true,logClosed:true,cleanupError:null};

test('directory removal waits for deferred file-close callbacks instead of blocking them during EBUSY retry',async()=>{
 const directory=sandbox(),fd=fs.openSync(path.join(directory,'held.log'),'wx');let released=false,attempts=0,confirmations=0;
 const releasing=setImmediate(()=>{fs.closeSync(fd);released=true});
 try{
  const result=await removeOwnedTestDirectory(directory,{workerCleanup:[closed],
   confirm:async pid=>{assert.equal(pid,123);confirmations++;return {terminated:true,state:'EXITED'}},
   remove:async target=>{attempts++;if(!released)throw busy();await fs.promises.rm(target,{recursive:true,force:true})},
   delay:async ms=>{assert.equal(ms,100);await yieldTurn()}});
  assert.equal(released,true);assert.equal(attempts,2);assert.equal(confirmations,2);
  assert.deepEqual(result,{removed:true,attempts:2,ownedProcessesConfirmed:1});assert.equal(fs.existsSync(directory),false);
 }finally{clearImmediate(releasing);if(!released)fs.closeSync(fd);await fs.promises.rm(directory,{recursive:true,force:true})}
});

test('persistent EBUSY and non-transient errors remain failures with the same bounded retry budget',async()=>{
 for(const code of ['EBUSY','EACCES']){
  const directory=sandbox(),error=Object.assign(Error('injected permanent lock'),{code,syscall:'rmdir'});let attempts=0,delays=[];
  try{
   await assert.rejects(removeOwnedTestDirectory(directory,{remove:async()=>{attempts++;throw error},delay:async ms=>{delays.push(ms)}}),cause=>cause===error);
   assert.equal(attempts,code==='EBUSY'?9:1);assert.deepEqual(delays,code==='EBUSY'?[100,200,300,400,500,600,700,800]:[]);
   assert.equal(error.cleanupAttempts,attempts);assert.equal(fs.existsSync(directory),true);
  }finally{await fs.promises.rm(directory,{recursive:true,force:true})}
 }
});

test('unconfirmed process, pipe or log closure prevents deletion before any filesystem retry',async()=>{
 for(const field of ['processClosed','stdoutClosed','stderrClosed','logClosed','cleanupError']){
  let removals=0,confirmations=0;
  await assert.rejects(removeOwnedTestDirectory('must-remain',{workerCleanup:[{...closed,[field]:field==='cleanupError'?'EPERM':false}],
   remove:async()=>{removals++},confirm:async()=>{confirmations++}}),{code:'TEST_WORKER_CLEANUP_UNCONFIRMED'});
  assert.equal(removals,0);assert.equal(confirmations,0);
 }
 let removals=0;
 await assert.rejects(removeOwnedTestDirectory('must-remain',{ownedPids:[123],remove:async()=>{removals++},
  confirm:async()=>({terminated:false,state:'RUNNING'})}),{code:'TEST_WORKER_CLEANUP_UNCONFIRMED'});
 assert.equal(removals,0);
});

test('an actual live owned worker blocks directory deletion until process and stdio really close',{timeout:5000},async()=>{
 const directory=sandbox(),child=trackChild(spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:['ignore','pipe','pipe'],windowsHide:true}));
 try{
  await assert.rejects(removeOwnedTestDirectory(directory,{ownedPids:[child.pid],
   confirm:pid=>waitForProcessTermination(pid,{timeoutMs:50,pollIntervalMs:5})}),{code:'PROCESS_TERMINATION_TIMEOUT'});
  assert.equal(fs.existsSync(directory),true);
  await stopChild(child,{graceMs:500,killMs:500});
  assert.equal(child.stdout.closed,true);assert.equal(child.stderr.closed,true);
  await removeOwnedTestDirectory(directory,{ownedPids:[child.pid]});assert.equal(fs.existsSync(directory),false);
 }finally{await stopChild(child,{graceMs:500,killMs:500});await fs.promises.rm(directory,{recursive:true,force:true})}
});
