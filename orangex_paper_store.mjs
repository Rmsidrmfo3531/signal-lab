// Separate, synchronous storage for offline OrangeX PAPER only. Constructor and
// read operations never create a directory, initialize a record or take a lock.
import fs from 'node:fs';
import path from 'node:path';
import {randomBytes} from 'node:crypto';

const KIND='ORANGEX_PAPER_OFFLINE',VERSION=1,MAX_BYTES=16*1024*1024;
const STATE_ARRAYS=['pending','open','closed','events','rejections'];
const STATE_OBJECTS=['settings','contracts','seen','fundingSeen'];
const BACKUP=/^orangex-paper-(?:before-restore-|recovery-)?\d{4}-\d{2}-\d{2}T\d{6}Z-\d{3}-[a-f0-9]{12}\.json$/;
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&
 (Object.getPrototypeOf(value)===Object.prototype||Object.getPrototypeOf(value)===null);
function problem(code,message){const error=new Error(message);error.code=code;return error}
const unsafe=()=>problem('ORANGEX_PAPER_UNSAFE_PATH','OrangeX PAPER 저장 경로 또는 파일이 안전하지 않습니다.');
const corrupt=()=>problem('ORANGEX_PAPER_INVALID_STORE','OrangeX PAPER 기록 구조가 잘못됐습니다. 기존 기록을 초기화하지 않습니다.');

function jsonValue(value,ancestors=new Set()){
 if(value===null||typeof value==='string'||typeof value==='boolean')return;
 if(typeof value==='number'&&Number.isFinite(value))return;
 if(!Array.isArray(value)&&!object(value)||ancestors.has(value))throw corrupt();
 ancestors.add(value);
 for(const item of Object.values(value))jsonValue(item,ancestors);
 ancestors.delete(value);
}
export function validateOrangeXPaperState(state){
 if(!object(state)||state.schemaVersion!==VERSION||STATE_ARRAYS.some(key=>!Array.isArray(state[key]))||
  STATE_OBJECTS.some(key=>!object(state[key])))throw corrupt();
 jsonValue(state);return state;
}
function encode(state){
 validateOrangeXPaperState(state);
 const bytes=Buffer.from(JSON.stringify({kind:KIND,version:VERSION,state},null,2)+'\n','utf8');
 if(bytes.length>MAX_BYTES)throw problem('ORANGEX_PAPER_STORE_TOO_LARGE','OrangeX PAPER 기록 크기 제한을 초과했습니다.');
 return bytes;
}
function decode(bytes){
 let envelope;try{envelope=JSON.parse(bytes.toString('utf8'))}catch{throw corrupt()}
 if(!object(envelope)||envelope.kind!==KIND||envelope.version!==VERSION||!Object.hasOwn(envelope,'state'))throw corrupt();
 return validateOrangeXPaperState(envelope.state);
}

export class OrangeXPaperStore{
 #io;#now;#lease=null;#closed=false;#lastSavedAt=null;#lastError=null;#lastRestoreBackup=null;#uncertain=false;
 constructor({directory,now=()=>Date.now(),io=fs}={}){
  if(typeof directory!=='string'||!directory.trim()||directory.includes('\0')||typeof now!=='function')throw unsafe();
  this.directory=path.resolve(directory);if(this.directory===path.parse(this.directory).root)throw unsafe();
  this.file=path.join(this.directory,'orangex-paper.json');this.backupDirectory=path.join(this.directory,'backups');
  this.lockFile=path.join(this.directory,'orangex-paper.lock');this.#io=io;this.#now=now;
  this.#ancestors(this.directory);
 }
 #assertOpen(){if(this.#closed)throw problem('ORANGEX_PAPER_STORE_CLOSED','OrangeX PAPER 저장소가 닫혔습니다.')}
 #lstat(file){try{return this.#io.lstatSync(file)}catch(error){if(error.code==='ENOENT')return null;throw error}}
 #ancestors(directory){
  const resolved=path.resolve(directory),parsed=path.parse(resolved);let current=parsed.root;
  for(const segment of resolved.slice(parsed.root.length).split(path.sep).filter(Boolean)){
   current=path.join(current,segment);const stat=this.#lstat(current);
   if(stat&&(stat.isSymbolicLink()||!stat.isDirectory()))throw unsafe();
  }
 }
 #regular(file,{missing=false}={}){
  this.#ancestors(path.dirname(file));const stat=this.#lstat(file);
  if(!stat){if(missing)return null;throw problem('ORANGEX_PAPER_NOT_FOUND','OrangeX PAPER 파일을 찾지 못했습니다.')}
  if(stat.isSymbolicLink()||!stat.isFile()||stat.nlink!==1)throw unsafe();
  if(stat.size>MAX_BYTES)throw problem('ORANGEX_PAPER_STORE_TOO_LARGE','OrangeX PAPER 기록 크기 제한을 초과했습니다.');
  return stat;
 }
 #readBytes(file,{missing=false}={}){
  if(!this.#regular(file,{missing}))return null;
  const flags=this.#io.constants.O_RDONLY|(this.#io.constants.O_NOFOLLOW??0),fd=this.#io.openSync(file,flags);
  try{
   const stat=this.#io.fstatSync(fd);if(!stat.isFile()||stat.nlink!==1||stat.size>MAX_BYTES)throw unsafe();
   const bytes=this.#io.readFileSync(fd);if(bytes.length>MAX_BYTES)throw corrupt();return bytes;
  }finally{this.#io.closeSync(fd)}
 }
 read(){this.#assertOpen();const bytes=this.#readBytes(this.file,{missing:true});return bytes===null?null:structuredClone(decode(bytes))}
 #directory(directory){this.#ancestors(directory);this.#io.mkdirSync(directory,{recursive:true,mode:0o700});this.#ancestors(directory)}
 #writeBytes(file,bytes){
  const flags=this.#io.constants.O_WRONLY|this.#io.constants.O_CREAT|this.#io.constants.O_EXCL|(this.#io.constants.O_NOFOLLOW??0);
  const fd=this.#io.openSync(file,flags,0o600);
  let failure;
  try{this.#io.writeFileSync(fd,bytes);this.#io.fsyncSync(fd)}catch(error){failure=error}
  try{this.#io.closeSync(fd)}catch(error){failure??=error}
  if(failure){try{this.#io.unlinkSync(file)}catch{}throw failure}
 }
 #syncDirectory(directory){
  let fd;try{fd=this.#io.openSync(directory,this.#io.constants.O_RDONLY);this.#io.fsyncSync(fd)}
  catch(error){
   // Windows does not expose a directory fsync handle. File data has already
   // been fsynced; unrelated filesystem failures still propagate.
   if(process.platform!=='win32'||!['EPERM','EACCES','EINVAL','EISDIR','ENOTSUP'].includes(error.code))throw error;
  }finally{if(fd!==undefined)this.#io.closeSync(fd)}
 }
 acquire(){
  this.#assertOpen();
  if(this.#lease){
   const current=this.#readBytes(this.lockFile,{missing:true});
   if(!current?.equals(this.#lease))throw problem('ORANGEX_PAPER_LOCKED','OrangeX PAPER 저장 잠금 소유권을 잃었습니다.');
   return;
  }
  this.#directory(this.directory);
  const payload=Buffer.from(JSON.stringify({kind:KIND,pid:process.pid,nonce:randomBytes(16).toString('hex'),startedAt:this.#now()}));
  for(let attempt=0;attempt<2;attempt++){
   try{this.#writeBytes(this.lockFile,payload);this.#lease=payload;return}
   catch(error){
    if(error.code!=='EEXIST')throw error;
    const previous=this.#readBytes(this.lockFile);let lock;
    try{lock=JSON.parse(previous.toString('utf8'))}catch{throw problem('ORANGEX_PAPER_LOCKED','OrangeX PAPER 잠금 상태를 확인할 수 없습니다.')}
    if(lock.kind!==KIND||!Number.isSafeInteger(lock.pid)||lock.pid<=0||typeof lock.nonce!=='string')
     throw problem('ORANGEX_PAPER_LOCKED','OrangeX PAPER 잠금 상태를 확인할 수 없습니다.');
    let absent=false;try{process.kill(lock.pid,0)}catch(cause){absent=cause.code==='ESRCH'}
    if(!absent||attempt>0)throw problem('ORANGEX_PAPER_LOCKED','다른 프로세스가 OrangeX PAPER 기록을 사용 중입니다.');
    if(!this.#readBytes(this.lockFile).equals(previous))throw problem('ORANGEX_PAPER_LOCKED','OrangeX PAPER 잠금이 변경됐습니다.');
    this.#io.unlinkSync(this.lockFile);
   }
  }
  throw problem('ORANGEX_PAPER_LOCKED','OrangeX PAPER 잠금을 확보하지 못했습니다.');
 }
 #atomic(bytes,{allowCorrupt=false}={}){
  // Refuse an ordinary save over corrupt or unrecognized existing records.
  const previous=this.#readBytes(this.file,{missing:true});if(previous!==null&&!allowCorrupt)decode(previous);
  const nonce=`${process.pid}-${randomBytes(12).toString('hex')}`,
   temp=path.join(this.directory,`orangex-paper.tmp-${nonce}`),rollback=path.join(this.directory,`orangex-paper.rollback-${nonce}`);
  let replaced=false,keepRollback=false;
  try{
   this.#writeBytes(temp,bytes);decode(this.#readBytes(temp));
   // A prepared previous image allows an atomic rollback if the directory
   // durability check fails AFTER replacement. It is never a user-data reset.
   if(previous!==null)this.#writeBytes(rollback,previous);
   this.#ancestors(this.directory);this.#regular(this.file,{missing:true});
   this.#io.renameSync(temp,this.file);replaced=true;this.#syncDirectory(this.directory);
  }catch(error){
   if(replaced){
    try{
     if(previous===null)this.#io.unlinkSync(this.file);else this.#io.renameSync(rollback,this.file);
     this.#syncDirectory(this.directory);
    }catch{
     // Preserve a recoverable previous image if the filesystem cannot roll
     // back. Never report this ambiguous outcome as a successful save.
     keepRollback=true;
     const uncertain=problem('ORANGEX_PAPER_COMMIT_UNCERTAIN','OrangeX PAPER 저장 후 복구 상태를 확인할 수 없습니다. 파일 보존 상태를 확인해야 합니다.');
     uncertain.cause=error;throw uncertain;
    }
   }
   throw error;
  }finally{
   if(this.#lstat(temp))this.#io.unlinkSync(temp);
   if(!keepRollback&&this.#lstat(rollback))this.#io.unlinkSync(rollback);
  }
 }
 write(state){
  this.#assertOpen();if(this.#uncertain)throw problem('ORANGEX_PAPER_COMMIT_UNCERTAIN','OrangeX PAPER 저장 상태 확인 전에는 새 저장을 허용하지 않습니다.');
  const bytes=encode(state);
  try{this.acquire();this.#atomic(bytes);this.#lastSavedAt=this.#now();this.#lastError=null;return structuredClone(state)}
  catch(error){this.#lastError=error.code??'ORANGEX_PAPER_WRITE_FAILED';if(error.code==='ORANGEX_PAPER_COMMIT_UNCERTAIN')this.#uncertain=true;throw error}
 }
 save(state){return this.write(state)}
 #name(prefix=''){
  const at=new Date(this.#now());if(!Number.isFinite(at.getTime()))throw corrupt();
  const stamp=at.toISOString().replace(/:/g,'').replace(/\.(\d{3})Z$/,'Z-$1');
  return `orangex-paper-${prefix}${stamp}-${randomBytes(6).toString('hex')}.json`;
 }
 #copyBackup(bytes,prefix=''){
  this.#directory(this.backupDirectory);const name=this.#name(prefix),target=path.join(this.backupDirectory,name);
  this.#writeBytes(target,bytes);if(!this.#readBytes(target).equals(bytes))throw problem('ORANGEX_PAPER_BACKUP_FAILED','OrangeX PAPER 백업 검증에 실패했습니다.');
  this.#syncDirectory(this.backupDirectory);return name;
 }
 backup(){
  this.#assertOpen();const bytes=this.#readBytes(this.file,{missing:true});if(bytes===null)return null;
  decode(bytes);this.acquire();const lockedBytes=this.#readBytes(this.file);decode(lockedBytes);return this.#copyBackup(lockedBytes);
 }
 restoreBackup(name){
  this.#assertOpen();if(typeof name!=='string'||!BACKUP.test(name)||path.basename(name)!==name)throw unsafe();
  const source=path.join(this.backupDirectory,name),bytes=this.#readBytes(source),state=decode(bytes);
  this.acquire();const current=this.#readBytes(this.file,{missing:true});
  let preserved=null;
  if(current!==null){let prefix='before-restore-';try{decode(current)}catch{prefix='recovery-'}preserved=this.#copyBackup(current,prefix)}
  try{this.#atomic(bytes,{allowCorrupt:true});this.#lastSavedAt=this.#now();this.#lastError=null;this.#uncertain=false;this.#lastRestoreBackup=preserved;return structuredClone(state)}
  catch(error){this.#lastError=error.code??'ORANGEX_PAPER_RESTORE_FAILED';throw error}
 }
 status(){
  let exists=false,healthy=true,error=null;
  try{exists=this.#regular(this.file,{missing:true})!==null;if(exists)decode(this.#readBytes(this.file))}catch(cause){healthy=false;error=cause.code??'ORANGEX_PAPER_READ_FAILED'}
  return {exists,healthy:healthy&&!this.#uncertain,writerLocked:this.#lease!==null,closed:this.#closed,lastSavedAt:this.#lastSavedAt,lastError:this.#lastError??error,lastRestoreBackup:this.#lastRestoreBackup};
 }
 snapshot(){return this.status()}
 close(){
  if(this.#closed)return;
  if(this.#lease){
   const bytes=this.#readBytes(this.lockFile,{missing:true});
   if(bytes?.equals(this.#lease))this.#io.unlinkSync(this.lockFile);
   this.#lease=null;
  }
  this.#closed=true;
 }
}
