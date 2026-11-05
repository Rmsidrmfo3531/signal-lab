// Test-only crash fixture. A durable ACK is not permission to leave a child or
// its stdio handles alive; unsuccessful shutdown must reject rather than await
// a `close` event forever (including after the test's own timeout fires).
import {trackChild,stopChild} from './child_process.mjs';

export async function killAcknowledgedJournalWriter(child,{timeoutMs=5000,graceMs=1000,killMs=1000,signal}={}){
 if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>5000)throw RangeError('Invalid journal writer ACK deadline');
 trackChild(child);
 let text='',stderr='',timer,resolveAck,rejectAck;
 const fail=(code,message)=>Object.assign(Error(message+(stderr?' · '+stderr.slice(-2048):'')),{code});
 const ack=new Promise((resolve,reject)=>{resolveAck=resolve;rejectAck=reject});
 const onData=chunk=>{
  text+=String(chunk);
  if(text.length>65536){rejectAck(fail('JOURNAL_WRITER_ACK_INVALID','Journal writer ACK output exceeded its limit'));return;}
  if(text.split(/\r?\n/).slice(0,-1).includes('DURABLE_ACK'))resolveAck();
 };
 const onStderr=chunk=>{stderr=(stderr+String(chunk)).slice(-8192)};
 const onError=error=>rejectAck(error);
 const onClose=()=>rejectAck(fail('JOURNAL_WRITER_EARLY_CLOSE','Journal writer exited before durable ACK'));
 const onAbort=()=>rejectAck(signal.reason??fail('JOURNAL_WRITER_ABORTED','Journal writer test aborted'));
 child.stdout.on('data',onData);child.stderr.on('data',onStderr);
 child.once('error',onError);child.once('close',onClose);
 signal?.addEventListener('abort',onAbort,{once:true});
 timer=setTimeout(()=>rejectAck(fail('JOURNAL_WRITER_ACK_TIMEOUT','Journal writer durable ACK timed out')),timeoutMs);
 let originalError;
 try{
  if(signal?.aborted)onAbort();
  await ack;
  // Keep the crash semantics: do not let the journal release its PID lock.
  if(!child.kill('SIGKILL'))throw fail('JOURNAL_WRITER_KILL_FAILED','Journal writer could not be abruptly terminated after durable ACK');
 }catch(error){originalError=error;throw error}
 finally{
  clearTimeout(timer);signal?.removeEventListener('abort',onAbort);
  child.removeListener('error',onError);child.removeListener('close',onClose);
  // Continue draining both pipes until `close`, so a full stderr pipe cannot
  // obstruct child termination or retain a Windows filesystem handle.
  try{await stopChild(child,{graceMs,killMs})}
  catch(error){if(originalError&&!error.cause)error.cause=originalError;throw error}
  finally{child.stdout.removeListener('data',onData);child.stderr.removeListener('data',onStderr)}
 }
}
