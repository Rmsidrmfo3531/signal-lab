import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {spawn} from 'node:child_process';
import {killAcknowledgedJournalWriter} from './helpers/journal_writer.mjs';

function fixture(onKill){
 const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();
 child.exitCode=null;child.signalCode=null;child.pid=123;child.signals=[];
 child.kill=signal=>{child.signals.push(signal);onKill?.(child,signal);return true};
 return child;
}
const close=child=>{child.exitCode=1;child.stdout.end();child.stderr.end();child.emit('close',1,null)};

test('durable ACK followed by a missing close fails within its own bounded shutdown instead of awaiting forever',async()=>{
 const child=fixture(),task=killAcknowledgedJournalWriter(child,{timeoutMs:100,graceMs:10,killMs:10});
 child.stdout.write('DURABLE_ACK\n');
 await assert.rejects(task,{code:'CHILD_CLOSE_TIMEOUT'});
 assert.equal(child.signals[0],'SIGKILL');assert.equal(child.stdout.listenerCount('data'),0);assert.equal(child.stderr.listenerCount('data'),0);
});

test('split ACK and both pipes drain until close, and cleanup does not manufacture an acknowledged write',async()=>{
 const child=fixture(value=>queueMicrotask(()=>close(value))),task=killAcknowledgedJournalWriter(child,{timeoutMs:100,graceMs:20,killMs:20});
 child.stderr.write('synthetic stderr '.repeat(10000));child.stdout.write('DURABLE_');child.stdout.write('ACK\r\n');
 await task;assert.equal(child.signals[0],'SIGKILL');
 assert.equal(child.stdout.listenerCount('data'),0);assert.equal(child.stderr.listenerCount('data'),0);
 const failed=fixture(value=>queueMicrotask(()=>close(value)));
 await assert.rejects(killAcknowledgedJournalWriter(failed,{timeoutMs:10,graceMs:20,killMs:20}),{code:'JOURNAL_WRITER_ACK_TIMEOUT'});
});

test('an early exit and test cancellation both settle the ACK promise and reap the tracked child',async()=>{
 const child=fixture(),early=killAcknowledgedJournalWriter(child,{timeoutMs:100,graceMs:20,killMs:20});
 close(child);await assert.rejects(early,{code:'JOURNAL_WRITER_EARLY_CLOSE'});
 const controller=new AbortController(),cancelled=fixture(value=>queueMicrotask(()=>close(value)));
 const task=killAcknowledgedJournalWriter(cancelled,{signal:controller.signal,timeoutMs:100,graceMs:20,killMs:20});
 const reason=Object.assign(Error('synthetic test cancelled'),{code:'FIXTURE_CANCELLED'});controller.abort(reason);
 await assert.rejects(task,{code:'FIXTURE_CANCELLED'});assert.equal(cancelled.exitCode,1);
});

test('actual child with a full stderr stream closes before the durable ACK crash fixture returns',{timeout:10000},async(t)=>{
 const source="process.stderr.write('x'.repeat(256*1024),()=>{console.log('DURABLE_ACK');setInterval(()=>{},1000)});";
 const child=spawn(process.execPath,['-e',source],{stdio:['ignore','pipe','pipe'],windowsHide:true});let closed=false;
 child.once('close',()=>{closed=true});
 await killAcknowledgedJournalWriter(child,{signal:t.signal});assert.equal(closed,true);
});
