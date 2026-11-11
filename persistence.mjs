// Durable user data: application code can be replaced without overwriting trades.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomBytes} from 'node:crypto';

export function resolveDataDir({env=process.env,platform=process.platform,home=os.homedir()}={}){
 const override=env.SIGNAL_LAB_DATA_DIR?.trim();
 if(override)return path.resolve(override);
 if(platform==='win32')return path.join(env.LOCALAPPDATA||path.join(home,'AppData','Local'),'SignalLab');
 return path.join(home,'.signal-lab');
}
const stamp=()=>new Date().toISOString().replace(/[:.]/g,'-');
function isObject(x){return x!==null&&typeof x==='object'&&!Array.isArray(x)}
function invalidStore(message){const error=new Error(message);error.code='SIGNAL_LAB_INVALID_STORE';return error}
export function readStore(file){
 if(!fs.existsSync(file))return null;
 // Do not reset records to defaults if a user file is invalid/corrupted.
 const content=fs.readFileSync(file,'utf8');
 let record;try{record=JSON.parse(content)}catch(e){throw invalidStore('기록 파일 JSON 오류: '+file+' (자동으로 초기화하지 않습니다): '+e.message)}
 if(!isObject(record)||record.paper!==undefined&&!isObject(record.paper)||record.journal!==undefined&&!Array.isArray(record.journal))throw invalidStore('기록 파일 구조 오류: '+file);
 return record;
}
function copyExclusive(source,target){
 if(!fs.existsSync(source)||fs.existsSync(target))return false;
 fs.copyFileSync(source,target,fs.constants.COPYFILE_EXCL);return true;
}
export function prepareData(root,{env=process.env,platform=process.platform,home=os.homedir()}={}){
 const dir=resolveDataDir({env,platform,home});
 fs.mkdirSync(dir,{recursive:true,mode:0o700});
 const storePath=path.join(dir,'store.json'),envPath=path.join(dir,'.env');
 const legacyStore=path.join(root,'store.json'),legacyEnv=path.join(root,'.env');
 // A shared store is authoritative. Inspect the release's legacy copy only
 // when it will actually be migrated; an unused damaged copy must not block it.
 if(!fs.existsSync(storePath)&&fs.existsSync(legacyStore))readStore(legacyStore);
 const migratedStore=copyExclusive(legacyStore,storePath);
 const migratedEnv=copyExclusive(legacyEnv,envPath);
 if(fs.existsSync(storePath))readStore(storePath);
 return {dir,storePath,envPath,migratedStore,migratedEnv};
}
// rename() only swaps a directory entry. Without flushing the new file first, a
// power cut or OS crash shortly after a save can leave store.json empty or
// truncated even though the swap itself was atomic. The handle is opened for
// writing because Windows refuses to flush a read-only handle.
function writeFlushed(file,text){
 const fd=fs.openSync(file,'wx',0o600);
 let failure;
 try{fs.writeFileSync(fd,text,'utf8');fs.fsyncSync(fd)}catch(error){failure=error}
 try{fs.closeSync(fd)}catch(error){failure??=error}
 if(failure)throw failure;
}
// Persist the rename itself where the platform allows it. Windows and some
// network/container file systems expose no directory flush; the file data is
// already flushed, so only those "not supported" answers are ignored.
const DIRECTORY_SYNC_UNSUPPORTED=new Set(['EPERM','EACCES','EINVAL','EISDIR','ENOTSUP','EBADF']);
function flushDirectory(directory){
 let fd;
 try{fd=fs.openSync(directory,'r');fs.fsyncSync(fd)}
 catch(error){if(!DIRECTORY_SYNC_UNSUPPORTED.has(error?.code))throw error}
 finally{if(fd!==undefined)try{fs.closeSync(fd)}catch{}}
}
export function atomicWriteStore(storePath,value){
 if(!isObject(value))throw Error('저장할 기록 구조가 올바르지 않습니다');
 const tmp=storePath+'.tmp-'+process.pid+'-'+randomBytes(5).toString('hex');
 try{
  writeFlushed(tmp,JSON.stringify(value,null,2));
  // Validate BEFORE swapping in to avoid replacing a recoverable file with invalid data.
  readStore(tmp);
  fs.renameSync(tmp,storePath);
  flushDirectory(path.dirname(storePath));
 }finally{try{fs.rmSync(tmp,{force:true})}catch{}}
}
export function backupStore(storePath,{maxBackups=30}={}){
 if(!fs.existsSync(storePath))return null;
 readStore(storePath);
 const backupDir=path.join(path.dirname(storePath),'backups');fs.mkdirSync(backupDir,{recursive:true,mode:0o700});
 const target=path.join(backupDir,`store-${stamp()}-${randomBytes(3).toString('hex')}.json`);
 fs.copyFileSync(storePath,target,fs.constants.COPYFILE_EXCL);
 // Never touch personal data in other directories. Keep latest N backups.
 const files=fs.readdirSync(backupDir).filter(x=>/^store-.*\.json$/.test(x)).sort().reverse();
 for(const file of files.slice(Math.max(1,maxBackups)))fs.rmSync(path.join(backupDir,file),{force:true});
 return target;
}
export function restoreStore(sourcePath,dir){
 const source=path.resolve(sourcePath),record=readStore(source);
 if(!record)throw Error('백업 파일을 찾지 못했습니다.');
 fs.mkdirSync(dir,{recursive:true,mode:0o700});
 // Hold the same exclusive lock as the server during preservation and restore.
 const release=acquireDataLock(dir);
 try{
  const storePath=path.join(dir,'store.json');let previous=null,preservedCorrupt=null;
  if(fs.existsSync(storePath)){
   let damaged=false;
   try{readStore(storePath)}catch(e){if(e.code!=='SIGNAL_LAB_INVALID_STORE')throw e;damaged=true}
   if(damaged){
    // Preserve the original bytes, even when they cannot be parsed as JSON.
    // Recovery copies have no automatic retention limit: never delete them here.
    const recoveryDir=path.join(dir,'recovery');fs.mkdirSync(recoveryDir,{recursive:true,mode:0o700});
    preservedCorrupt=path.join(recoveryDir,`store-corrupt-${stamp()}-${randomBytes(3).toString('hex')}.json`);
    fs.copyFileSync(storePath,preservedCorrupt,fs.constants.COPYFILE_EXCL);
    if(!fs.readFileSync(preservedCorrupt).equals(fs.readFileSync(storePath)))throw Error('손상 기록 보존 확인 실패. 복원을 중단했습니다.');
   }else previous=backupStore(storePath);
  }
  atomicWriteStore(storePath,record);
  return {storePath,previous,preservedCorrupt};
 }finally{release()}
}
export function hasTradeRecords(store){
 return Boolean((store?.journal?.length||0)||(store?.alerts?.length||0)||(store?.paper?.open?.length||0)||(store?.paper?.pending?.length||0)||(store?.paper?.closed?.length||0)||(store?.paper?.skipped?.length||0));
}
export function importLegacy(sourcePath,dir,{replace=false}={}){
 const source=path.resolve(sourcePath);
 const srcFile=fs.statSync(source).isDirectory()?path.join(source,'store.json'):source;
 const incoming=readStore(srcFile);if(!incoming)throw Error('이전 기록 파일 store.json을 찾지 못했습니다: '+srcFile);
 fs.mkdirSync(dir,{recursive:true,mode:0o700});
 const dst=path.join(dir,'store.json');const existing=readStore(dst);
 if(existing&&hasTradeRecords(existing)&&!replace)throw Error('공용 폴더에 이미 거래·신호 기록이 있습니다. 덮어쓰지 않았습니다. 백업 후 별도로 복원하세요.');
 const backup=existing?backupStore(dst):null;
 atomicWriteStore(dst,incoming);
 const srcEnv=path.join(path.dirname(srcFile),'.env');const migratedEnv=copyExclusive(srcEnv,path.join(dir,'.env'));
 return {dataDir:dir,backup,imported:srcFile,migratedEnv,recordCounts:{paperOpen:incoming.paper?.open?.length||0,paperClosed:incoming.paper?.closed?.length||0,paperPending:incoming.paper?.pending?.length||0,journal:incoming.journal?.length||0,alerts:incoming.alerts?.length||0}};
}

// Prevent two simultaneously running versions from overwriting the same trade log.
// A lock written on another PC (shared OneDrive/Drive folder) cannot be checked by PID: it
// counts as held while its heartbeat is newer than LOCK_STALE_MS. The holder rewrites it every 30 s.
export const LOCK_STALE_MS=3*60000;
export function isLocked(dir,{host=os.hostname(),now=Date.now()}={}){
 const file=path.join(dir,'server.lock');
 if(!fs.existsSync(file))return false;
 let data;try{data=JSON.parse(fs.readFileSync(file,'utf8'))}catch{return true}
 if(typeof data.host==='string'&&data.host!==host){
  const beat=Date.parse(data.heartbeatAt||data.startedAt);
  return !Number.isFinite(beat)||now-beat<LOCK_STALE_MS;
 }
 if(!Number.isSafeInteger(data.pid)||data.pid<=0)return true;
 try{process.kill(data.pid,0);return true}catch(e){return e.code!=='ESRCH'}
}
/** Returns release(); release.heartbeat() refreshes the lock's heartbeat (call every 30 s). */
export function acquireDataLock(dir){
 const file=path.join(dir,'server.lock'),nonce=randomBytes(8).toString('hex'),host=os.hostname();
 const body=()=>JSON.stringify({pid:process.pid,host,startedAt,heartbeatAt:new Date().toISOString(),nonce});
 const startedAt=new Date().toISOString();let payload=body();
 for(let attempt=0;attempt<2;attempt++){
  try{fs.writeFileSync(file,payload,{flag:'wx',mode:0o600});break}
  catch(e){
   if(e.code!=='EEXIST'||isLocked(dir)){
    let other='';try{const d=JSON.parse(fs.readFileSync(file,'utf8'));if(d.host&&d.host!==host)other=` (다른 PC "${d.host}"에서 실행 중 — 그 PC의 서버를 먼저 끄고 동기화가 끝난 뒤 3분 후 다시 실행하세요)`}catch{}
    throw Error('다른 Signal Lab이 같은 기록 폴더를 사용 중이거나 잠금 파일 상태를 확인할 수 없습니다. 이전 서버를 종료한 후 다시 실행하세요.'+other);
   }
   fs.rmSync(file,{force:true});if(attempt===1)throw Error('서버 잠금 확보 실패');
  }
 }
 const ours=()=>{try{return JSON.parse(fs.readFileSync(file,'utf8')).nonce===nonce}catch{return false}};
 const release=()=>{try{if(ours())fs.rmSync(file,{force:true})}catch{}};
 release.heartbeat=()=>{try{if(!ours())return false;payload=body();const tmp=file+'.'+nonce+'.tmp';fs.writeFileSync(tmp,payload,{mode:0o600});fs.renameSync(tmp,file);return true}catch{return false}};
 return release;
}
