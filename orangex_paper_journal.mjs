// Experimental storage only. It is never selected by the application server and
// never imports, converts or removes a legacy PAPER store. A journal transaction
// is one fsynced line; incomplete/tampered lines are errors, not truncated data.
import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomBytes} from 'node:crypto';
import {validateOrangeXPaperState} from './orangex_paper_store.mjs';

const KIND='ORANGEX_PAPER_JOURNAL_EXPERIMENT',VERSION=1;
const FORBIDDEN=new Set(['__proto__','prototype','constructor']);
const ROOTS=new Set(['settings','contracts','pending','open','closed','seen','fundingSeen','events','rejections','lastMarkets','connection','updatedAt']);
const ARRAYS=new Set(['pending','open','closed','events','rejections']);
const OBJECTS=new Set(['settings','contracts','seen','fundingSeen','lastMarkets','connection']);
const ID=/^[A-Za-z0-9:_./-]{1,240}$/;
const HASH=/^[a-f0-9]{64}$/;
const SNAP=/^checkpoint-\d+-[a-f0-9]{12}\.json$/;
const GEN=/^(?:genesis|restored-genesis-[a-f0-9]{12})\.json$/;
const LOG=/^(?:journal|restored-journal-[a-f0-9]{12})\.jsonl$/;
const BACKUP=/^(?:backup|recovery)-\d{13}-[a-f0-9]{12}$/;
const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&
 [Object.prototype,null].includes(Object.getPrototypeOf(value));
const clone=value=>structuredClone(value);
const digest=value=>createHash('sha256').update(value).digest('hex');
const problem=code=>Object.assign(Error(code),{code});
function json(value,parents=new Set()){
 if(value===null||typeof value==='string'||typeof value==='boolean')return;
 if(typeof value==='number'&&Number.isFinite(value))return;
 if(!Array.isArray(value)&&!plain(value)||parents.has(value))throw problem('JOURNAL_NON_JSON_VALUE');
 if(Array.isArray(value)&&(Object.keys(value).length!==value.length||Object.keys(value).some(key=>!/^(0|[1-9]\d*)$/.test(key)||Number(key)>=value.length)))throw problem('JOURNAL_NON_JSON_VALUE');
 parents.add(value);
 for(const [key,item]of Object.entries(value)){if(FORBIDDEN.has(key))throw problem('JOURNAL_UNSAFE_KEY');json(item,parents)}
 parents.delete(value);
}
function canonical(value){
 if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
 if(plain(value))return '{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonical(value[key])).join(',')+'}';
 return JSON.stringify(value);
}
function stateCheck(value){validateOrangeXPaperState(value);json(value);return value}
function transaction(input){
 if(!plain(input)||!ID.test(input.id)||!Array.isArray(input.ops)||!input.ops.length||input.ops.length>10000||
  input.expectedSeq!==undefined&&(!Number.isSafeInteger(input.expectedSeq)||input.expectedSeq<0))throw problem('JOURNAL_INVALID_TRANSACTION');
 const ops=input.ops.map(value=>{
  if(!plain(value)||!['set','append','delete'].includes(value.op)||!Array.isArray(value.path)||!value.path.length||value.path.length>32||
   value.path.some(key=>typeof key!=='string'||!key.length||key.length>512||FORBIDDEN.has(key))||!ROOTS.has(value.path[0]))throw problem('JOURNAL_INVALID_OPERATION');
  if(value.op==='delete'&&value.path.length===1||value.op==='set'&&value.path.length===1&&value.path[0]==='closed')throw problem('JOURNAL_HISTORY_REPLACEMENT_FORBIDDEN');
  if(value.op!=='delete')json(value.value);
  return {op:value.op,path:[...value.path],...(value.op==='delete'?{}:{value:clone(value.value)})};
 });
 return {id:input.id,ops,...(input.expectedSeq===undefined?{}:{expectedSeq:input.expectedSeq})};
}

export class OrangeXPaperJournal{
 #io;#now;#lease=null;#closed=false;#loaded=false;#uncertain=false;#state=null;#manifest=null;
 #seq=0;#hash=null;#ids=new Map();#closedKeys=new Set();#logBytes=0;#logMtime=null;#lastError=null;#lastRestoreBackup=null;
 #stateBytes=0;#counts=new WeakMap();
 constructor({directory,now=()=>Date.now(),io=fs,maxRecordBytes=8*1024*1024,maxStateBytes=128*1024*1024,maxJournalBytes=512*1024*1024}={}){
  if(typeof directory!=='string'||!directory.trim()||directory.includes('\0')||typeof now!=='function'||
   ![maxRecordBytes,maxStateBytes,maxJournalBytes].every(value=>Number.isSafeInteger(value)&&value>0))throw problem('JOURNAL_INVALID_CONFIG');
  this.directory=path.resolve(directory);if(this.directory===path.parse(this.directory).root)throw problem('JOURNAL_UNSAFE_PATH');
  this.maxRecordBytes=maxRecordBytes;this.maxStateBytes=maxStateBytes;this.maxJournalBytes=maxJournalBytes;
  this.manifestFile=path.join(this.directory,'journal-manifest.json');this.lockFile=path.join(this.directory,'journal.lock');
  this.backupDirectory=path.join(this.directory,'backups');this.#io=io;this.#now=now;this.#ancestors(this.directory);
 }
 #assert(){if(this.#closed)throw problem('JOURNAL_CLOSED');if(this.#uncertain)throw problem('JOURNAL_COMMIT_UNCERTAIN')}
 #stat(file){try{return this.#io.lstatSync(file)}catch(error){if(error.code==='ENOENT')return null;throw error}}
 #ancestors(directory){
  const resolved=path.resolve(directory),root=path.parse(resolved).root;let current=root;
  for(const segment of resolved.slice(root.length).split(path.sep).filter(Boolean)){
   current=path.join(current,segment);const stat=this.#stat(current);if(stat&&(stat.isSymbolicLink()||!stat.isDirectory()))throw problem('JOURNAL_UNSAFE_PATH');
  }
 }
 #regular(file,{missing=false,limit=this.maxStateBytes}={}){
  this.#ancestors(path.dirname(file));const stat=this.#stat(file);
  if(!stat){if(missing)return null;throw problem('JOURNAL_FILE_MISSING')}
  if(stat.isSymbolicLink()||!stat.isFile()||stat.nlink!==1)throw problem('JOURNAL_UNSAFE_PATH');
  if(stat.size>limit)throw problem('JOURNAL_SIZE_LIMIT');return stat;
 }
 #bytes(file,{missing=false,limit=this.maxStateBytes}={}){
  if(!this.#regular(file,{missing,limit}))return null;
  const fd=this.#io.openSync(file,this.#io.constants.O_RDONLY|(this.#io.constants.O_NOFOLLOW??0));
  try{const stat=this.#io.fstatSync(fd);if(!stat.isFile()||stat.nlink!==1||stat.size>limit)throw problem('JOURNAL_UNSAFE_PATH');
   const bytes=this.#io.readFileSync(fd);if(bytes.length>limit)throw problem('JOURNAL_SIZE_LIMIT');return bytes;
  }finally{this.#io.closeSync(fd)}
 }
 #fileHash(file,limit){
  this.#regular(file,{limit});const fd=this.#io.openSync(file,this.#io.constants.O_RDONLY|(this.#io.constants.O_NOFOLLOW??0)),hash=createHash('sha256'),chunk=Buffer.allocUnsafe(65536);
  try{let size=0,read;while((read=this.#io.readSync(fd,chunk,0,chunk.length,null))>0){size+=read;if(size>limit)throw problem('JOURNAL_SIZE_LIMIT');hash.update(chunk.subarray(0,read))}return hash.digest('hex')}
  finally{this.#io.closeSync(fd)}
 }
 #parse(bytes){try{return JSON.parse(bytes.toString('utf8'))}catch{throw problem('JOURNAL_INVALID_JSON')}}
 #syncDir(directory){
  let fd;try{fd=this.#io.openSync(directory,this.#io.constants.O_RDONLY);this.#io.fsyncSync(fd)}catch(error){
   if(process.platform!=='win32'||!['EACCES','EPERM','EINVAL','EISDIR','ENOTSUP'].includes(error.code))throw error;
  }finally{if(fd!==undefined)this.#io.closeSync(fd)}
 }
 #directory(directory){
  this.#ancestors(directory);
  // Capture a finite chain before creating it. Windows may return a differently
  // cased/aliased path from recursive mkdir; comparing that string while walking
  // parents can otherwise get stuck forever at a drive root.
  const missing=[];let current=path.resolve(directory);
  while(!this.#stat(current)){
   missing.push(current);const parent=path.dirname(current);
   if(parent===current)throw problem('JOURNAL_UNSAFE_PATH');
   current=parent;
  }
  this.#io.mkdirSync(directory,{recursive:true,mode:0o700});this.#ancestors(directory);
  // Persist every newly created entry and its parent in the same leaf-first
  // order; a concurrent creator can only cause an additional safe sync.
  // Windows' documented directory-fsync limitations remain in #syncDir.
  for(const created of missing){this.#syncDir(created);this.#syncDir(path.dirname(created))}
 }
 #writeNew(file,bytes){
  const fd=this.#io.openSync(file,this.#io.constants.O_WRONLY|this.#io.constants.O_CREAT|this.#io.constants.O_EXCL|(this.#io.constants.O_NOFOLLOW??0),0o600);
  try{this.#io.writeFileSync(fd,bytes);this.#io.fsyncSync(fd)}finally{this.#io.closeSync(fd)}
 }
 #manifestWrite(value){
  const bytes=Buffer.from(JSON.stringify(value)+'\n'),prior=this.#bytes(this.manifestFile,{missing:true,limit:1024*1024}),
   nonce=randomBytes(6).toString('hex'),temp=path.join(this.directory,'manifest.tmp-'+nonce),rollback=path.join(this.directory,'manifest.rollback-'+nonce);
  let replaced=false,keep=false;
  try{
   this.#writeNew(temp,bytes);if(prior)this.#writeNew(rollback,prior);
   this.#io.renameSync(temp,this.manifestFile);replaced=true;this.#syncDir(this.directory);
  }catch(error){
   if(replaced)try{if(prior)this.#io.renameSync(rollback,this.manifestFile);else this.#io.unlinkSync(this.manifestFile);this.#syncDir(this.directory)}catch{keep=true;this.#uncertain=true;throw problem('JOURNAL_COMMIT_UNCERTAIN')}
   throw error;
  }finally{
   for(const file of [temp,...(keep?[]:[rollback])])try{this.#io.unlinkSync(file)}catch(error){if(error.code!=='ENOENT')throw error}
  }
 }
 #acquire(){
  this.#assert();
  if(this.#lease){if(!this.#bytes(this.lockFile,{missing:true,limit:4096})?.equals(this.#lease))throw problem('JOURNAL_LOCK_LOST');return}
  this.#directory(this.directory);const lease=Buffer.from(JSON.stringify({kind:KIND,pid:process.pid,nonce:randomBytes(16).toString('hex')}));
  for(let attempt=0;attempt<2;attempt++)try{this.#writeNew(this.lockFile,lease);this.#lease=lease;return}catch(error){
   if(error.code!=='EEXIST')throw error;const previous=this.#bytes(this.lockFile,{limit:4096}),value=this.#parse(previous);
   if(value?.kind!==KIND||!Number.isSafeInteger(value.pid)||value.pid<=0||typeof value.nonce!=='string')throw problem('JOURNAL_LOCKED');
   let absent=false;try{process.kill(value.pid,0)}catch(cause){absent=cause.code==='ESRCH'}
   if(!absent||attempt||!this.#bytes(this.lockFile,{limit:4096}).equals(previous))throw problem('JOURNAL_LOCKED');this.#io.unlinkSync(this.lockFile);
  }
  throw problem('JOURNAL_LOCKED');
 }
 #index(){
  this.#closedKeys=new Set();for(const row of this.#state.closed){
   if(plain(row)&&typeof row.key==='string'){if(this.#closedKeys.has(row.key))throw problem('JOURNAL_DUPLICATE_TRADE');this.#closedKeys.add(row.key)}
  }
 }
 #jsonBytes(value){return Buffer.byteLength(JSON.stringify(value))}
 #count(value){let count=this.#counts.get(value);if(count===undefined){count=Object.keys(value).length;this.#counts.set(value,count)}return count}
 #budget(delta){
  const bytes=this.#stateBytes+delta;if(bytes>this.maxStateBytes||bytes<0)throw problem('JOURNAL_STATE_TOO_LARGE');this.#stateBytes=bytes;
 }
 #apply(ops){
  const undo=[],initialBytes=this.#stateBytes;
  try{for(const item of ops){
   let parent=this.#state;for(const key of item.path.slice(0,-1)){
    if(!plain(parent)&&!Array.isArray(parent)||!Object.hasOwn(parent,key))throw problem('JOURNAL_PATH_MISSING');parent=parent[key];
   }
   const key=item.path.at(-1);
   if(!plain(parent)&&!Array.isArray(parent))throw problem('JOURNAL_INVALID_TARGET');
   if(Array.isArray(parent)&&(!/^(0|[1-9]\d*)$/.test(key)||Number(key)>=parent.length||item.op==='delete'))throw problem('JOURNAL_INVALID_ARRAY_PATH');
   if(item.op==='append'){
    if(!Object.hasOwn(parent,key)||!Array.isArray(parent[key]))throw problem('JOURNAL_APPEND_TARGET_NOT_ARRAY');
    const target=parent[key],closed=item.path.length===1&&key==='closed',tradeKey=closed&&plain(item.value)?item.value.key:undefined;
    if(closed&&(typeof tradeKey!=='string'||!ID.test(tradeKey)||this.#closedKeys.has(tradeKey)))throw problem('JOURNAL_DUPLICATE_TRADE');
    this.#budget(this.#jsonBytes(item.value)+(target.length?1:0));
    const length=target.length;target.push(clone(item.value));if(closed)this.#closedKeys.add(tradeKey);
    undo.push(()=>{target.length=length;if(closed)this.#closedKeys.delete(tradeKey)});
   }else{
    if(item.path.length===1&&((ARRAYS.has(key)&&!Array.isArray(item.value))||(OBJECTS.has(key)&&!plain(item.value))))throw problem('JOURNAL_ROOT_STRUCTURE');
    const had=Object.hasOwn(parent,key),prior=parent[key];
    if(item.path[0]==='closed'&&(item.path.length===2&&(!plain(item.value)||item.value.key!==prior?.key)||
     item.path.length===3&&key==='key'&&(item.op==='delete'||item.value!==prior)))throw problem('JOURNAL_TRADE_IDENTITY_IMMUTABLE');
    // A duplicate message with a fresh transport transaction ID must not charge
    // funding twice. Already recorded business keys reject the whole batch;
    // retries with the original transaction ID are handled before any mutation.
    if(item.path.length===1&&['seen','fundingSeen'].includes(key))throw problem('JOURNAL_IDEMPOTENCY_ROOT_IMMUTABLE');
    if(item.path.length===2&&['seen','fundingSeen'].includes(item.path[0])&&had)throw problem('JOURNAL_IDEMPOTENCY_CONFLICT');
    const object=!Array.isArray(parent),count=object?this.#count(parent):parent.length,
     keyBytes=object?this.#jsonBytes(key)+1:0,
     delta=item.op==='delete'?(had?-(this.#jsonBytes(prior)+keyBytes+(count>1?1:0)):0):
      had?this.#jsonBytes(item.value)-this.#jsonBytes(prior):this.#jsonBytes(item.value)+keyBytes+(count?1:0);
    this.#budget(delta);
    if(item.op==='delete')delete parent[key];else parent[key]=clone(item.value);
    if(object&&(!had&&item.op==='set'||had&&item.op==='delete'))this.#counts.set(parent,count+(item.op==='delete'?-1:1));
    undo.push(()=>{if(had)parent[key]=prior;else delete parent[key];if(object)this.#counts.set(parent,count)});
   }
  }}catch(error){for(const revert of undo.reverse())revert();this.#stateBytes=initialBytes;throw error}
  return ()=>{for(const revert of undo.reverse())revert();this.#stateBytes=initialBytes};
 }
 #scan(file,onRecord){
  this.#regular(file,{limit:this.maxJournalBytes});const fd=this.#io.openSync(file,this.#io.constants.O_RDONLY|(this.#io.constants.O_NOFOLLOW??0)),chunk=Buffer.allocUnsafe(65536);
  let carry=Buffer.alloc(0),total=0;
  try{let read;while((read=this.#io.readSync(fd,chunk,0,chunk.length,null))>0){
   total+=read;if(total>this.maxJournalBytes)throw problem('JOURNAL_SIZE_LIMIT');
   const block=carry.length?Buffer.concat([carry,chunk.subarray(0,read)]):Buffer.from(chunk.subarray(0,read));let start=0,index;
   while((index=block.indexOf(10,start))!==-1){if(index-start>this.maxRecordBytes)throw problem('JOURNAL_RECORD_TOO_LARGE');
    if(index===start)throw problem('JOURNAL_EMPTY_RECORD');onRecord(this.#parse(block.subarray(start,index)));start=index+1;
   }
   carry=Buffer.from(block.subarray(start));if(carry.length>this.maxRecordBytes)throw problem('JOURNAL_RECORD_TOO_LARGE');
  }
  if(carry.length)throw problem('JOURNAL_PARTIAL_TAIL');return total;
  }finally{this.#io.closeSync(fd)}
 }
 #load(){
  this.#loaded=false;
  const manifestBytes=this.#bytes(this.manifestFile,{missing:true,limit:1024*1024});
  if(manifestBytes===null){
   const entries=this.#stat(this.directory)?this.#io.readdirSync(this.directory):[];
   if(entries.some(name=>name!=='journal.lock'))throw problem('JOURNAL_UNINITIALIZED_ARTIFACTS');
   this.#state=null;this.#stateBytes=0;this.#counts=new WeakMap();this.#loaded=true;return null;
  }
  const m=this.#parse(manifestBytes);
  if(m?.kind!==KIND||m.version!==VERSION||!GEN.test(m.genesis?.file)||!HASH.test(m.genesis?.fileHash)||!HASH.test(m.genesis?.stateHash)||!LOG.test(m.journal))throw problem('JOURNAL_INVALID_MANIFEST');
  if(this.#fileHash(path.join(this.directory,m.genesis.file),this.maxStateBytes)!==m.genesis.fileHash)throw problem('JOURNAL_GENESIS_HASH_MISMATCH');
  let checkpoint=null;
  if(m.checkpoint!==null){
   const c=m.checkpoint;if(!plain(c)||!SNAP.test(c.file)||!HASH.test(c.fileHash)||!HASH.test(c.hash)||!Number.isSafeInteger(c.seq)||c.seq<0)throw problem('JOURNAL_INVALID_CHECKPOINT');
   const bytes=this.#bytes(path.join(this.directory,c.file));if(digest(bytes)!==c.fileHash)throw problem('JOURNAL_CHECKPOINT_HASH_MISMATCH');checkpoint=this.#parse(bytes);
   if(checkpoint?.kind!=='ORANGEX_JOURNAL_CHECKPOINT'||checkpoint.version!==VERSION||checkpoint.seq!==c.seq||checkpoint.hash!==c.hash||
    !Array.isArray(checkpoint.ids)||digest(JSON.stringify(checkpoint.state))!==checkpoint.stateHash)throw problem('JOURNAL_INVALID_CHECKPOINT');
   stateCheck(checkpoint.state);this.#state=checkpoint.state;
  }else{
   const genesis=this.#parse(this.#bytes(path.join(this.directory,m.genesis.file)));
   if(genesis?.kind!=='ORANGEX_JOURNAL_GENESIS'||genesis.version!==VERSION||digest(JSON.stringify(genesis.state))!==m.genesis.stateHash)throw problem('JOURNAL_GENESIS_HASH_MISMATCH');
   stateCheck(genesis.state);this.#state=genesis.state;
  }
  this.#index();this.#stateBytes=this.#jsonBytes(this.#state);this.#counts=new WeakMap();
  if(this.#stateBytes>this.maxStateBytes)throw problem('JOURNAL_STATE_TOO_LARGE');
  let seq=0,head=m.genesis.stateHash;const ids=new Map();let checkpointSeen=!checkpoint;
  const bytes=this.#scan(path.join(this.directory,m.journal),record=>{
   if(!plain(record)||Object.keys(record).sort().join(',')!==['kind','version','seq','previousHash','id','ops','hash'].sort().join(','))throw problem('JOURNAL_INVALID_RECORD');
   if(!Array.isArray(record.ops)||record.ops.some(op=>!plain(op)||Object.keys(op).sort().join(',')!==
    (op.op==='delete'?['op','path']:['op','path','value']).sort().join(',')))throw problem('JOURNAL_INVALID_RECORD');
   if(record?.kind!=='ORANGEX_JOURNAL_TRANSACTION'||record.version!==VERSION||record.seq!==seq+1||record.previousHash!==head||!HASH.test(record.hash))throw problem('JOURNAL_CHAIN_BROKEN');
   const tx=transaction(record),payload={kind:record.kind,version:record.version,seq:record.seq,previousHash:record.previousHash,id:tx.id,ops:tx.ops};
   if(digest(canonical(payload))!==record.hash)throw problem('JOURNAL_HASH_MISMATCH');
   const content=digest(canonical({id:tx.id,ops:tx.ops}));if(ids.has(tx.id))throw problem('JOURNAL_DUPLICATE_TRANSACTION');ids.set(tx.id,content);
   seq=record.seq;head=record.hash;
   if(checkpoint&&seq===checkpoint.seq){
    if(head!==checkpoint.hash||canonical([...ids])!==canonical(checkpoint.ids))throw problem('JOURNAL_CHECKPOINT_ANCHOR_MISMATCH');checkpointSeen=true;
   }
   if(!checkpoint||seq>checkpoint.seq)this.#apply(tx.ops);
  });
  if(checkpoint&&checkpoint.seq===0){if(checkpoint.hash!==m.genesis.stateHash||checkpoint.ids.length)throw problem('JOURNAL_CHECKPOINT_ANCHOR_MISMATCH');checkpointSeen=true}
  if(!checkpointSeen)throw problem('JOURNAL_CHECKPOINT_AHEAD_OF_LOG');
  this.#manifest=m;this.#seq=seq;this.#hash=head;this.#ids=ids;this.#logBytes=bytes;this.#logMtime=this.#regular(path.join(this.directory,m.journal),{limit:this.maxJournalBytes}).mtimeMs;this.#loaded=true;
  return this.#state;
 }
 initialize(state){
  this.#assert();stateCheck(state);const stateBytes=Buffer.from(JSON.stringify(state));if(stateBytes.length>this.maxStateBytes)throw problem('JOURNAL_STATE_TOO_LARGE');
  const entries=this.#stat(this.directory)?this.#io.readdirSync(this.directory):[];if(entries.length)throw problem('JOURNAL_DIRECTORY_NOT_EMPTY');
  this.#acquire();const stateHash=digest(stateBytes),genesis=Buffer.from(JSON.stringify({kind:'ORANGEX_JOURNAL_GENESIS',version:VERSION,state})+'\n');
  if(genesis.length>this.maxStateBytes)throw problem('JOURNAL_STATE_TOO_LARGE');
  try{
   this.#writeNew(path.join(this.directory,'genesis.json'),genesis);this.#writeNew(path.join(this.directory,'journal.jsonl'),Buffer.alloc(0));
   const manifest={kind:KIND,version:VERSION,genesis:{file:'genesis.json',fileHash:digest(genesis),stateHash},journal:'journal.jsonl',checkpoint:null};
   this.#manifestWrite(manifest);this.#manifest=manifest;this.#state=clone(state);this.#seq=0;this.#hash=stateHash;this.#ids=new Map();this.#index();this.#logBytes=0;
   this.#stateBytes=stateBytes.length;this.#counts=new WeakMap();
   this.#logMtime=this.#regular(path.join(this.directory,'journal.jsonl'),{limit:this.maxJournalBytes}).mtimeMs;this.#loaded=true;return {seq:0,hash:stateHash};
  }catch(error){this.#lastError=error.code??'JOURNAL_INITIALIZE_FAILED';throw error}
 }
 append(input){
  this.#assert();const tx=transaction(input),content=digest(canonical({id:tx.id,ops:tx.ops}));
  if(!this.#loaded)this.#load();if(this.#state===null)throw problem('JOURNAL_NOT_INITIALIZED');
  // A read-only instance can cache a generation before another writer restores
  // a backup. Its old log can remain unchanged even though the active manifest
  // now points elsewhere. Refresh once under every newly acquired writer lease
  // before choosing the log or checking transport/business idempotency keys.
  const acquiredNow=this.#lease===null;this.#acquire();if(acquiredNow)this.#load();
  const file=path.join(this.directory,this.#manifest.journal),stat=this.#regular(file,{limit:this.maxJournalBytes});
  if(stat.size!==this.#logBytes||stat.mtimeMs!==this.#logMtime)this.#load();
  if(this.#ids.has(tx.id)){if(this.#ids.get(tx.id)!==content)throw problem('JOURNAL_TRANSACTION_ID_CONFLICT');return {seq:this.#seq,hash:this.#hash,duplicate:true}}
  if(tx.expectedSeq!==undefined&&tx.expectedSeq!==this.#seq)throw problem('JOURNAL_SEQUENCE_CONFLICT');
  const payload={kind:'ORANGEX_JOURNAL_TRANSACTION',version:VERSION,seq:this.#seq+1,previousHash:this.#hash,id:tx.id,ops:tx.ops},hash=digest(canonical(payload)),bytes=Buffer.from(JSON.stringify({...payload,hash})+'\n');
  if(bytes.length>this.maxRecordBytes||this.#logBytes+bytes.length>this.maxJournalBytes)throw problem('JOURNAL_SIZE_LIMIT');
  const undo=this.#apply(tx.ops);let fd=null;
  try{
   fd=this.#io.openSync(file,this.#io.constants.O_WRONLY|this.#io.constants.O_APPEND|(this.#io.constants.O_NOFOLLOW??0));
   const opened=this.#io.fstatSync(fd);if(!opened.isFile()||opened.nlink!==1||opened.size!==this.#logBytes)throw problem('JOURNAL_LOG_CHANGED');
   let offset=0;while(offset<bytes.length){const wrote=this.#io.writeSync(fd,bytes,offset,bytes.length-offset,null);if(!Number.isInteger(wrote)||wrote<=0)throw problem('JOURNAL_SHORT_WRITE');offset+=wrote}
   this.#io.fsyncSync(fd);const committed=this.#io.fstatSync(fd);if(committed.size!==this.#logBytes+bytes.length)throw problem('JOURNAL_LOG_CHANGED');
   this.#io.closeSync(fd);fd=null;
   this.#seq=payload.seq;this.#hash=hash;this.#ids.set(tx.id,content);this.#logBytes+=bytes.length;this.#logMtime=committed.mtimeMs;this.#lastError=null;
   return {seq:this.#seq,hash,duplicate:false};
  }catch(error){
   undo();if(fd!==null){try{this.#io.ftruncateSync(fd,this.#logBytes);this.#io.fsyncSync(fd);this.#io.closeSync(fd);fd=null}catch{this.#uncertain=true;try{this.#io.closeSync(fd)}catch{}fd=null}}
   this.#lastError=this.#uncertain?'JOURNAL_COMMIT_UNCERTAIN':error.code??'JOURNAL_APPEND_FAILED';
   if(this.#uncertain)throw problem('JOURNAL_COMMIT_UNCERTAIN');throw error;
  }
 }
 read(){this.#assert();try{const value=this.#load();this.#lastError=null;return value===null?null:clone(value)}catch(error){this.#lastError=error.code??'JOURNAL_READ_FAILED';throw error}}
 inspect(){this.#assert();if(!this.#loaded)this.#load();return {seq:this.#seq,hash:this.#hash,transactionCount:this.#ids.size,stateBytes:this.#stateBytes}}
 checkpoint(){
  this.#assert();if(this.#load()===null)throw problem('JOURNAL_NOT_INITIALIZED');this.#acquire();this.#load();
  const stateHash=digest(JSON.stringify(this.#state)),name=`checkpoint-${this.#seq}-${randomBytes(6).toString('hex')}.json`,
   bytes=Buffer.from(JSON.stringify({kind:'ORANGEX_JOURNAL_CHECKPOINT',version:VERSION,seq:this.#seq,hash:this.#hash,stateHash,state:this.#state,ids:[...this.#ids]})+'\n');
  if(bytes.length>this.maxStateBytes)throw problem('JOURNAL_STATE_TOO_LARGE');
  this.#writeNew(path.join(this.directory,name),bytes);const next={...this.#manifest,checkpoint:{file:name,fileHash:digest(bytes),seq:this.#seq,hash:this.#hash}};
  this.#manifestWrite(next);this.#manifest=next;return name;
 }
 #copyFile(source,target){
  this.#regular(source,{limit:this.maxJournalBytes});this.#io.copyFileSync(source,target,this.#io.constants.COPYFILE_EXCL);
  const fd=this.#io.openSync(target,this.#io.constants.O_RDONLY);try{this.#io.fsyncSync(fd)}finally{this.#io.closeSync(fd)}
 }
 #backupName(prefix){return `${prefix}-${String(Math.trunc(this.#now())).padStart(13,'0')}-${randomBytes(6).toString('hex')}`}
 backup(){
  this.#assert();if(this.#load()===null)return null;this.#acquire();this.#load();
  const name=this.#backupName('backup'),directory=path.join(this.backupDirectory,name);this.#directory(directory);
  for(const file of ['journal-manifest.json',this.#manifest.genesis.file,this.#manifest.journal,...(this.#manifest.checkpoint?[this.#manifest.checkpoint.file]:[])])this.#copyFile(path.join(this.directory,file),path.join(directory,file));
  const check=new OrangeXPaperJournal({directory,now:this.#now,io:this.#io,maxRecordBytes:this.maxRecordBytes,maxStateBytes:this.maxStateBytes,maxJournalBytes:this.maxJournalBytes});try{check.read()}finally{check.close()}
  this.#syncDir(directory);this.#syncDir(this.backupDirectory);this.#syncDir(this.directory);return name;
 }
 restoreBackup(name){
  if(this.#closed)throw problem('JOURNAL_CLOSED');if(typeof name!=='string'||!BACKUP.test(name)||!name.startsWith('backup-'))throw problem('JOURNAL_INVALID_BACKUP');
  const directory=path.join(this.backupDirectory,name),source=new OrangeXPaperJournal({directory,now:this.#now,io:this.#io,maxRecordBytes:this.maxRecordBytes,maxStateBytes:this.maxStateBytes,maxJournalBytes:this.maxJournalBytes});
  let state,m;try{state=source.read();if(state===null)throw problem('JOURNAL_INVALID_BACKUP');m=source.#manifest}finally{source.close()}
  const uncertain=this.#uncertain;this.#uncertain=false;try{this.#acquire()}catch(error){this.#uncertain=uncertain;throw error}
  try{
   const recovery=this.#backupName('recovery'),preserved=path.join(this.backupDirectory,recovery);this.#directory(preserved);
   for(const file of this.#io.readdirSync(this.directory).filter(file=>file==='journal-manifest.json'||GEN.test(file)||LOG.test(file)||SNAP.test(file)))this.#copyFile(path.join(this.directory,file),path.join(preserved,file));
   this.#syncDir(preserved);this.#syncDir(this.backupDirectory);this.#syncDir(this.directory);
   const nonce=randomBytes(6).toString('hex'),genesis=`restored-genesis-${nonce}.json`,journal=`restored-journal-${nonce}.jsonl`,
    cp=m.checkpoint?`checkpoint-${m.checkpoint.seq}-${randomBytes(6).toString('hex')}.json`:null;
   this.#copyFile(path.join(directory,m.genesis.file),path.join(this.directory,genesis));this.#copyFile(path.join(directory,m.journal),path.join(this.directory,journal));
   if(cp)this.#copyFile(path.join(directory,m.checkpoint.file),path.join(this.directory,cp));
   this.#manifestWrite({...m,genesis:{...m.genesis,file:genesis},journal,checkpoint:cp?{...m.checkpoint,file:cp}:null});
   this.#loaded=false;this.#load();this.#uncertain=false;this.#lastError=null;this.#lastRestoreBackup=recovery;return clone(state);
  }catch(error){this.#uncertain=true;this.#lastError='JOURNAL_RESTORE_FAILED';throw error}
 }
 status(){
  let exists=false,healthy=!this.#uncertain,error=this.#lastError;
  try{exists=this.#regular(this.manifestFile,{missing:true,limit:1024*1024})!==null}catch(cause){healthy=false;error=cause.code??'JOURNAL_READ_FAILED'}
  return {experimental:true,productionSelected:false,exists,healthy:healthy&&this.#lastError===null,integrityVerified:this.#loaded&&this.#lastError===null&&!this.#uncertain,writerLocked:this.#lease!==null,uncertain:this.#uncertain,
   lastError:error,seq:this.#seq,transactionCount:this.#ids.size,lastRestoreBackup:this.#lastRestoreBackup};
 }
 close(){
  if(this.#closed)return;if(this.#lease){const bytes=this.#bytes(this.lockFile,{missing:true,limit:4096});if(bytes?.equals(this.#lease))this.#io.unlinkSync(this.lockFile);this.#lease=null}this.#closed=true;
 }
}
