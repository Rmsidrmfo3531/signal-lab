// Test-only directory cleanup. Process/stdio/log closure is a prerequisite,
// and transient Windows locks are retried asynchronously so pending handle-close
// callbacks can run. A live process or persistent lock remains a test failure.
import fs from 'node:fs/promises';
import {setTimeout as pause} from 'node:timers/promises';
import {waitForProcessTermination} from './process_termination.mjs';

const transient=new Set(['EBUSY','ENOTEMPTY','EPERM','EMFILE','ENFILE']);
export async function removeOwnedTestDirectory(directory,{workerCleanup=[],ownedPids=[],
 remove=target=>fs.rm(target,{recursive:true,force:true,maxRetries:0}),
 confirm=waitForProcessTermination,delay=pause}={}){
 if(workerCleanup.some(row=>!row.processClosed||!row.stdoutClosed||!row.stderrClosed||!row.logClosed||row.cleanupError))
  throw Object.assign(Error('Owned worker or stream cleanup is unconfirmed; directory retained'),{code:'TEST_WORKER_CLEANUP_UNCONFIRMED'});
 const pids=[...new Set([...ownedPids,...workerCleanup.map(row=>row.pid)].filter(pid=>pid!==null&&pid!==undefined))];
 // Match the previous fs.rmSync maxRetries:8 / retryDelay:100 budget. Unlike
 // synchronous retry, await lets child/pipe/fs close callbacks release locks.
 for(let attempt=0;attempt<=8;attempt++){
  for(const pid of pids){
   const proof=await confirm(pid);
   if(!proof?.terminated||!['EXITED','Z'].includes(proof.state))
    throw Object.assign(Error('Owned process has not terminated; directory retained'),{code:'TEST_WORKER_CLEANUP_UNCONFIRMED',pid});
  }
  try{await remove(directory);return {removed:true,attempts:attempt+1,ownedProcessesConfirmed:pids.length}}
  catch(error){
   if(!transient.has(error.code)||attempt===8){error.cleanupAttempts=attempt+1;throw error}
   await delay((attempt+1)*100);
  }
 }
}
