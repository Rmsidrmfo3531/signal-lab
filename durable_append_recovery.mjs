// Failure-path recovery only: append handles can lack FILE_WRITE_DATA on Windows.
// Reopen without O_APPEND, and acknowledge rollback only after durable byte-level
// proof. This helper owns appendFd, including when it throws.
import {createHash} from 'node:crypto';

const CHUNK_BYTES=64*1024;
const fault=code=>Object.assign(new Error(code),{code});
const ensure=(value,code)=>{if(!value)throw fault(code)};
const regular=stat=>stat?.isFile()&&!stat.isSymbolicLink()&&Number(stat.nlink)===1&&Number.isSafeInteger(stat.size)&&stat.size>=0;
const identity=(left,right)=>String(left.dev)===String(right.dev)&&String(left.ino)===String(right.ino);
const details=error=>({code:typeof error?.code==='string'?error.code:'UNKNOWN',syscall:typeof error?.syscall==='string'?error.syscall:null});

function prefixSHA256(io,fd,length){
 const hash=createHash('sha256'),chunk=Buffer.allocUnsafe(CHUNK_BYTES);let offset=0;
 while(offset<length){
  const wanted=Math.min(chunk.length,length-offset),read=io.readSync(fd,chunk,0,wanted,offset);
  ensure(Number.isInteger(read)&&read>0&&read<=wanted,'DURABLE_ROLLBACK_SHORT_READ');
  hash.update(chunk.subarray(0,read));offset+=read;
 }
 return hash.digest('hex');
}

function verifyTail(io,fd,committedBytes,tailBytes,recordBytes){
 const chunk=Buffer.allocUnsafe(Math.min(CHUNK_BYTES,Math.max(1,tailBytes)));let offset=0;
 while(offset<tailBytes){
  const wanted=Math.min(chunk.length,tailBytes-offset),read=io.readSync(fd,chunk,0,wanted,committedBytes+offset);
  ensure(Number.isInteger(read)&&read>0&&read<=wanted,'DURABLE_ROLLBACK_SHORT_READ');
  ensure(chunk.subarray(0,read).equals(recordBytes.subarray(offset,offset+read)),'DURABLE_ROLLBACK_TAIL_MISMATCH');offset+=read;
 }
}

export function rollbackDurableAppend({io,file,appendFd,openedStat,committedBytes,recordBytes,prefixHash}){
 let fd=null,stage='append-close';
 const proof={verified:false,committedBytes,bytesBefore:null,bytesAfter:null,appendClosed:false,recoveryOpened:false,recoveryClosed:false,
  identityVerified:false,prefixVerifiedBefore:false,tailVerified:false,truncateCompleted:false,syncCompleted:false,prefixVerifiedAfter:false};
 try{
  // A failed close is ambiguous. Never retry it: the descriptor may have been
  // released already, and retrying could close an unrelated reused descriptor.
  io.closeSync(appendFd);proof.appendClosed=true;
  stage='validate-input';
  ensure(typeof file==='string'&&Number.isSafeInteger(committedBytes)&&committedBytes>=0&&Buffer.isBuffer(recordBytes)&&
   recordBytes.length>0&&Number.isSafeInteger(committedBytes+recordBytes.length)&&typeof prefixHash==='string'&&/^[a-f0-9]{64}$/.test(prefixHash)&&
   regular(openedStat)&&openedStat.size===committedBytes,'DURABLE_ROLLBACK_INVALID_INPUT');
  stage='recovery-open';
  fd=io.openSync(file,io.constants.O_RDWR|(io.constants.O_NOFOLLOW??0));proof.recoveryOpened=true;
  const verifyIdentity=()=>{
   const actual=io.fstatSync(fd),entry=io.lstatSync(file);
   ensure(regular(actual)&&regular(entry)&&identity(actual,openedStat)&&identity(entry,openedStat)&&actual.size===entry.size,'DURABLE_ROLLBACK_IDENTITY_CHANGED');
   return actual;
  };
  stage='identity-before';const before=verifyIdentity();proof.bytesBefore=before.size;
  ensure(before.size>=committedBytes&&before.size<=committedBytes+recordBytes.length,'DURABLE_ROLLBACK_SIZE_CHANGED');proof.identityVerified=true;
  stage='prefix-before';ensure(prefixSHA256(io,fd,committedBytes)===prefixHash,'DURABLE_ROLLBACK_PREFIX_MISMATCH');proof.prefixVerifiedBefore=true;
  stage='tail-before';verifyTail(io,fd,committedBytes,before.size-committedBytes,recordBytes);proof.tailVerified=true;
  stage='identity-before-truncate';const checked=verifyIdentity();
  ensure(checked.size===before.size&&checked.mtimeMs===before.mtimeMs&&checked.ctimeMs===before.ctimeMs,'DURABLE_ROLLBACK_FILE_CHANGED');
  stage='truncate';io.ftruncateSync(fd,committedBytes);proof.truncateCompleted=true;
  stage='sync';io.fsyncSync(fd);proof.syncCompleted=true;
  stage='identity-after';const after=verifyIdentity();proof.bytesAfter=after.size;
  ensure(after.size===committedBytes,'DURABLE_ROLLBACK_LENGTH_MISMATCH');
  stage='prefix-after';ensure(prefixSHA256(io,fd,committedBytes)===prefixHash,'DURABLE_ROLLBACK_PREFIX_MISMATCH');proof.prefixVerifiedAfter=true;
  stage='identity-final';const final=verifyIdentity();
  ensure(final.size===committedBytes&&final.mtimeMs===after.mtimeMs&&final.ctimeMs===after.ctimeMs,'DURABLE_ROLLBACK_FILE_CHANGED');
  stage='recovery-close';const closing=fd;fd=null;io.closeSync(closing);proof.recoveryClosed=true;
  return {...proof,verified:true,stage:'complete',code:null,syscall:null};
 }catch(cause){
  const cleanupErrors=[];
  if(fd!==null){const closing=fd;fd=null;try{io.closeSync(closing);proof.recoveryClosed=true}catch(error){cleanupErrors.push({stage:'recovery-cleanup-close',...details(error)})}}
  const rollback={...proof,stage,...details(cause),cleanupErrors};
  throw Object.assign(new Error('Durable append rollback is unverified',{cause}),{code:'DURABLE_ROLLBACK_UNCERTAIN',rollback});
 }
}
