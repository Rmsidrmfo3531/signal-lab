import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter,once} from 'node:events';
import {spawn} from 'node:child_process';
import {trackChild,stopChild} from './helpers/child_process.mjs';
function childFixture(onKill=()=>{}){
 const child=new EventEmitter();child.exitCode=null;child.signalCode=null;child.pid=123;
 child.kill=signal=>{onKill(signal,child);return true};return trackChild(child);
}
function closed(child,signal='SIGTERM'){child.signalCode=signal;child.emit('close',null,signal)}
test('cleanup observes a signal-terminated child that closed before the finally block',async()=>{
 let kills=0;const child=childFixture(()=>{kills++});closed(child);
 await stopChild(child,{graceMs:10,killMs:10});assert.equal(kills,0);
});
test('an exit event cannot authorize deleting a sandbox before child stdio closes',async()=>{
 const signals=[];const child=childFixture((signal,value)=>{
  signals.push(signal);value.signalCode=signal;value.emit('exit',null,signal);
  setTimeout(()=>closed(value,signal),30);
 });
 let finished=false;const stopping=stopChild(child,{graceMs:100,killMs:100}).then(()=>{finished=true});
 await new Promise(resolve=>setTimeout(resolve,5));assert.equal(finished,false);
 await stopping;assert.equal(finished,true);assert.deepEqual(signals,['SIGTERM']);
});
test('ignored graceful termination escalates and waits for forced close',async()=>{
 const signals=[];const child=childFixture((signal,value)=>{signals.push(signal);if(signal==='SIGKILL')closed(value,signal)});
 await stopChild(child,{graceMs:5,killMs:20});assert.deepEqual(signals,['SIGTERM','SIGKILL']);
});
test('a child that never closes fails within a bounded deadline instead of hanging the test runner',async()=>{
 const signals=[];const child=childFixture(signal=>signals.push(signal));
 await assert.rejects(stopChild(child,{graceMs:5,killMs:5}),{code:'CHILD_CLOSE_TIMEOUT'});
 assert.deepEqual(signals,['SIGTERM','SIGKILL']);
});
test('Windows notification cleanup kills the owned tree before its parent PID disappears',async()=>{
 const signals=[];const child=childFixture(signal=>signals.push(signal));let command;
 await stopChild(child,{platform:'win32',killTree:true,graceMs:10,killMs:10,execFileFn:async(...args)=>{command=args;closed(child)}});
 assert.deepEqual(command,['taskkill',['/PID','123','/T','/F'],{windowsHide:true,timeout:5000}]);assert.deepEqual(signals,[]);
});
test('untracked children and disabled or unbounded shutdown deadlines are rejected',async()=>{
 await assert.rejects(stopChild(new EventEmitter()),/tracked immediately/);
 for(const value of [0,-1,Infinity,NaN,30001])await assert.rejects(stopChild(childFixture(),{graceMs:value}),/deadline/);
});
test('an actual child already terminated by a signal is reaped before cleanup returns',{timeout:5000},async()=>{
 const child=trackChild(spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}));
 try{
  const close=once(child,'close');child.kill('SIGTERM');await close;
  await stopChild(child,{graceMs:20,killMs:20});
 }finally{await stopChild(child)}
});
