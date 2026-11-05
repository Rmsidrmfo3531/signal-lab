// Test-only owned-process cleanup. Register at spawn time so a fast close cannot
// be lost, and wait for `close` (including stdio), never just the `exit` event.
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const run=promisify(execFile),owned=new WeakMap();
export function trackChild(child){
 if(!child||typeof child.once!=='function')throw new TypeError('A spawned child process is required');
 if(owned.has(child))return child;
 const state={didClose:false,error:null};
 state.closed=new Promise(resolve=>child.once('close',(code,signal)=>{state.didClose=true;resolve({code,signal})}));
 child.once('error',error=>{state.error=error});
 owned.set(child,state);return child;
}
function deadline(value){
 if(!Number.isSafeInteger(value)||value<1||value>30000)throw new RangeError('Invalid owned-child shutdown deadline');
 return value;
}
async function closesWithin(state,ms){
 if(state.didClose)return true;
 let timer;
 try{return await Promise.race([state.closed.then(()=>true),new Promise(resolve=>{timer=setTimeout(()=>resolve(false),ms)})])}
 finally{clearTimeout(timer)}
}
export async function stopChild(child,{graceMs=2500,killMs=5000,killTree=false,platform=process.platform,
 execFileFn=run}={}){
 if(!child)return;
 deadline(graceMs);deadline(killMs);
 const state=owned.get(child);
 if(!state)throw Error('Child must be tracked immediately after spawn');
 if(state.didClose)return;
 const running=()=>child.exitCode===null&&child.signalCode===null;
 let treeError;
 if(running()){
  if(platform==='win32'&&killTree){
   // Kill the owned tree while the server PID exists: terminating Node first
   // can orphan its notification PowerShell process and retain the sandbox cwd.
   try{await execFileFn('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,timeout:5000})}
   catch(error){if(running())treeError=error}
  }else child.kill('SIGTERM');
 }
 if(!await closesWithin(state,graceMs)){
  if(running())child.kill('SIGKILL');
  if(!await closesWithin(state,killMs)){
   const error=Error('Owned child did not close its process and stdio handles after shutdown');
   error.code='CHILD_CLOSE_TIMEOUT';if(state.error)error.cause=state.error;throw error;
  }
 }
 if(treeError){const error=Error('Could not terminate the owned Windows notification process tree');error.code='CHILD_TREE_TERMINATION_FAILED';error.cause=treeError;throw error}
}
