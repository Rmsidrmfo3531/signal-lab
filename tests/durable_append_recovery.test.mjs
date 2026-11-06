import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {rollbackDurableAppend} from '../durable_append_recovery.mjs';

const injected=(code,syscall)=>Object.assign(new Error(`injected ${code}`),{code,syscall});
const hash=value=>createHash('sha256').update(value).digest('hex');
function fixture(run){
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'signal-lab-durable-rollback-')),file=path.join(directory,'journal.jsonl');
 const prefix=Buffer.from('committed history remains byte-for-byte unchanged\n'.repeat(2500));
 const recordBytes=Buffer.from(JSON.stringify({id:'attempted',seq:2,payload:'partial append must not receive ACK'})+'\n');
 const handles=new Map(),calls=[];
 const io=new Proxy(fs,{get(target,key){
  if(key==='openSync')return(...args)=>{const fd=fs.openSync(...args);handles.set(fd,args[1]);calls.push(['open',fd,args[1]]);return fd};
  if(key==='closeSync')return fd=>{calls.push(['close',fd]);fs.closeSync(fd);handles.delete(fd)};
  if(key==='ftruncateSync')return(fd,length)=>{calls.push(['truncate',fd,length]);if(handles.get(fd)&fs.constants.O_APPEND)throw injected('EPERM','ftruncate');return fs.ftruncateSync(fd,length)};
  if(key==='fsyncSync')return fd=>{calls.push(['sync',fd]);return fs.fsyncSync(fd)};
  return Reflect.get(target,key);
 }});
 fs.writeFileSync(file,prefix);const appendFd=io.openSync(file,fs.constants.O_WRONLY|fs.constants.O_APPEND),openedStat=fs.fstatSync(appendFd);
 fs.writeSync(appendFd,recordBytes,0,23,null);
 const input={io,file,appendFd,openedStat,committedBytes:prefix.length,recordBytes,prefixHash:hash(prefix)};
 const override=handlers=>new Proxy(io,{get(target,key){return Object.hasOwn(handlers,key)?handlers[key]:Reflect.get(target,key)}});
 try{return run({input,io,override,file,prefix,handles,calls})}
 finally{for(const fd of handles.keys())try{fs.closeSync(fd)}catch{}fs.rmSync(directory,{recursive:true,force:true,maxRetries:10,retryDelay:20})}
}
function uncertain(run,{stage,code,syscall}={}){
 let error;try{run()}catch(cause){error=cause}
 assert.equal(error?.code,'DURABLE_ROLLBACK_UNCERTAIN');assert.equal(error.rollback.verified,false);
 if(stage)assert.equal(error.rollback.stage,stage);
 if(code){assert.equal(error.rollback.code,code);assert.equal(error.cause.code,code)}
 if(syscall)assert.equal(error.rollback.syscall,syscall);
 return error;
}

test('Windows append-only truncate EPERM is recovered with a separate writable non-append handle and durable prefix proof',()=>fixture(({input,io,file,prefix,handles,calls})=>{
 assert.throws(()=>io.ftruncateSync(input.appendFd,input.committedBytes),{code:'EPERM'});
 calls.length=0;const proof=rollbackDurableAppend(input);
 assert.equal(proof.verified,true);assert.equal(proof.bytesBefore,prefix.length+23);assert.equal(proof.bytesAfter,prefix.length);
 for(const flag of ['appendClosed','recoveryClosed','identityVerified','prefixVerifiedBefore','tailVerified','truncateCompleted','syncCompleted','prefixVerifiedAfter'])assert.equal(proof[flag],true,flag);
 const opening=calls.find(call=>call[0]==='open');assert.equal(opening[2]&fs.constants.O_APPEND,0);assert.equal(opening[2]&fs.constants.O_RDWR,fs.constants.O_RDWR);
 assert.equal(opening[2]&(fs.constants.O_TRUNC|fs.constants.O_CREAT),0);assert.equal(calls[0][0],'close');
 assert.ok(calls.findIndex(call=>call[0]==='sync')>calls.findIndex(call=>call[0]==='truncate'));
 assert.equal(calls.at(-1)[0],'close');assert.equal(handles.size,0);assert.deepEqual(fs.readFileSync(file),prefix);
}));

test('a fully appended record whose commit was not acknowledged can be durably removed without losing existing history',()=>fixture(({input,file,prefix})=>{
 fs.appendFileSync(file,input.recordBytes.subarray(23));const proof=rollbackDurableAppend(input);
 assert.equal(proof.verified,true);assert.equal(proof.bytesBefore,prefix.length+input.recordBytes.length);assert.deepEqual(fs.readFileSync(file),prefix);
}));

test('a configured record larger than eight MiB is streamed and safely rolled back without an arbitrary recovery-only limit',()=>fixture(({input,file,prefix})=>{
 input.recordBytes=Buffer.alloc(8*1024*1024+1,0x78);fs.truncateSync(file,prefix.length);fs.appendFileSync(file,input.recordBytes);
 const proof=rollbackDurableAppend(input);assert.equal(proof.verified,true);
 assert.equal(proof.bytesBefore,prefix.length+input.recordBytes.length);assert.deepEqual(fs.readFileSync(file),prefix);
}));

test('reopen, truncate and fsync errors retain the actual rollback phase and errno and never claim verified recovery',()=>{
 for(const [method,stage,code,syscall]of [['openSync','recovery-open','EACCES','open'],['ftruncateSync','truncate','ENOSPC','ftruncate'],['fsyncSync','sync','EIO','fsync']])fixture(({input,override,handles})=>{
  input.io=override({[method]:()=>{throw injected(code,syscall)}});
  const error=uncertain(()=>rollbackDurableAppend(input),{stage,code,syscall});assert.equal(error.rollback.appendClosed,true);assert.equal(handles.size,0);
 });
});

test('an ambiguous append close stops before reopening and is never retried',()=>fixture(({input,io,override,calls,file})=>{
 const before=fs.readFileSync(file);let closes=0;
 input.io=override({closeSync:fd=>{closes++;io.closeSync(fd);throw injected('EIO','close')}});
 uncertain(()=>rollbackDurableAppend(input),{stage:'append-close',code:'EIO',syscall:'close'});
 assert.equal(closes,1);assert.equal(calls.filter(call=>call[0]==='open').length,1);assert.deepEqual(fs.readFileSync(file),before);
}));

test('a final close failure freezes recovery even after truncate and fsync and does not retry a potentially reused descriptor',()=>fixture(({input,io,override,handles})=>{
 let closes=0;input.io=override({closeSync:fd=>{closes++;io.closeSync(fd);if(closes===2)throw injected('EBUSY','close')}});
 const error=uncertain(()=>rollbackDurableAppend(input),{stage:'recovery-close',code:'EBUSY',syscall:'close'});
 assert.equal(error.rollback.truncateCompleted,true);assert.equal(error.rollback.syncCompleted,true);assert.equal(error.rollback.recoveryClosed,false);
 assert.equal(closes,2);assert.equal(handles.size,0);
}));

test('changed pathname identity, symlink or hardlink is refused before any truncation',()=>{
 for(const change of [stat=>({...stat,ino:stat.ino+1,isFile:()=>true,isSymbolicLink:()=>false}),stat=>({...stat,isFile:()=>true,isSymbolicLink:()=>true}),stat=>({...stat,nlink:2,isFile:()=>true,isSymbolicLink:()=>false})])fixture(({input,io,override,calls,file})=>{
  const before=fs.readFileSync(file);input.io=override({lstatSync:target=>change(io.lstatSync(target))});
  uncertain(()=>rollbackDurableAppend(input),{stage:'identity-before',code:'DURABLE_ROLLBACK_IDENTITY_CHANGED'});
  assert.equal(calls.some(call=>call[0]==='truncate'),false);assert.deepEqual(fs.readFileSync(file),before);
 });
});

test('changed committed prefix, foreign tail and out-of-range lengths preserve suspect bytes and refuse destructive rollback',()=>{
 for(const [damage,stage,code]of [
  [({file})=>{const fd=fs.openSync(file,'r+');try{fs.writeSync(fd,Buffer.from('X'),0,1,0)}finally{fs.closeSync(fd)}},'prefix-before','DURABLE_ROLLBACK_PREFIX_MISMATCH'],
  [({file,input})=>{const fd=fs.openSync(file,'r+');try{fs.writeSync(fd,Buffer.from('X'),0,1,input.committedBytes)}finally{fs.closeSync(fd)}},'tail-before','DURABLE_ROLLBACK_TAIL_MISMATCH'],
  [({file,input})=>fs.appendFileSync(file,Buffer.alloc(input.recordBytes.length)), 'identity-before','DURABLE_ROLLBACK_SIZE_CHANGED'],
  [({file,input})=>fs.truncateSync(file,input.committedBytes-1),'identity-before','DURABLE_ROLLBACK_SIZE_CHANGED']
 ])fixture(context=>{
  damage(context);const before=fs.readFileSync(context.file);uncertain(()=>rollbackDurableAppend(context.input),{stage,code});
  assert.equal(context.calls.some(call=>call[0]==='truncate'),false);assert.deepEqual(fs.readFileSync(context.file),before);
 });
});

test('a no-op truncate and a prefix damaged during truncate fail the independent post-sync verification',()=>{
 for(const damagePrefix of [false,true])fixture(({input,io,override,file})=>{
  input.io=override({ftruncateSync:(fd,length)=>{if(damagePrefix){io.ftruncateSync(fd,length);fs.writeSync(fd,Buffer.from('X'),0,1,0)}}});
  const error=uncertain(()=>rollbackDurableAppend(input),damagePrefix?{stage:'prefix-after',code:'DURABLE_ROLLBACK_PREFIX_MISMATCH'}:{stage:'identity-after',code:'DURABLE_ROLLBACK_LENGTH_MISMATCH'});
  assert.equal(error.rollback.syncCompleted,true);assert.equal(error.rollback.recoveryClosed,true);
 });
});

test('cleanup close failures preserve the original rollback error instead of masking it',()=>fixture(({input,io,override})=>{
 let closes=0;input.io=override({fsyncSync:()=>{throw injected('EIO','fsync')},closeSync:fd=>{closes++;io.closeSync(fd);if(closes===2)throw injected('EBUSY','close')}});
 const error=uncertain(()=>rollbackDurableAppend(input),{stage:'sync',code:'EIO',syscall:'fsync'});
 assert.deepEqual(error.rollback.cleanupErrors,[{stage:'recovery-cleanup-close',code:'EBUSY',syscall:'close'}]);
}));

test('a short committed-prefix read is not treated as an empty or valid prefix',()=>fixture(({input,override,calls})=>{
 input.io=override({readSync:()=>0});uncertain(()=>rollbackDurableAppend(input),{stage:'prefix-before',code:'DURABLE_ROLLBACK_SHORT_READ'});
 assert.equal(calls.some(call=>call[0]==='truncate'),false);
}));
