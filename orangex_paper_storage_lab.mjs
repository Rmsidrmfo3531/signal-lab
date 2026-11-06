// SYNTHETIC storage-layout experiment only. Never imported by the running app.
// This is NOT a general ledger backend or a user-data migration implementation.
// Immutable closed-history segments and a small active-state WAL are compared
// with the unchanged Snapshot/Journal. Synthetic sequential IDs are mandatory;
// arbitrary historical/user identifiers require a separate durable index design.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash,randomBytes} from 'node:crypto';
import {buildSyntheticStorageLedger} from './scripts/check-orangex-storage-performance.mjs';
import {auditOrangeXPaperAccounting} from './orangex_paper_performance.mjs';
import {rollbackDurableAppend} from './durable_append_recovery.mjs';

const KIND='ORANGEX_SYNTHETIC_SEGMENTED_STORAGE_LAB',VERSION=1,INTERVAL=28800000,MAX=50000;
const HASH=/^[a-f0-9]{64}$/;const SAFE=/^(?:segment-\d{5}|active-\d+-[a-f0-9]{12}|genesis-active)\.json$/;
const digest=value=>createHash('sha256').update(value).digest('hex');
const json=value=>JSON.stringify(value);
const bytes=value=>Buffer.from(json(value)+'\n');
const clone=value=>structuredClone(value);
const failure=code=>Object.assign(Error(code),{code});
const appendFailure=(error,stage)=>({stage,code:typeof error?.code==='string'?error.code:'SCALE_APPEND_FAILED',syscall:typeof error?.syscall==='string'?error.syscall:null});
const ensure=(condition,code)=>{if(!condition)throw failure(code)};
const integer=(value,min,max)=>Number.isSafeInteger(value)&&value>=min&&value<=max;
const inside=(candidate,parent)=>{const relative=path.relative(parent,candidate);return relative!==''&&relative!=='..'&&!relative.startsWith('..'+path.sep)&&!path.isAbsolute(relative)};
export function storageScaleFixture(tradeCount){
 ensure(integer(tradeCount,1,MAX),'SCALE_INVALID_TRADE_COUNT');
 const seed=buildSyntheticStorageLedger(1),template=seed.closed[0];
 ensure(seed.executionMode==='SYNTHETIC_TEST'&&template.dataSource==='SYNTHETIC_FIXTURE','SCALE_SYNTHETIC_ONLY');
 const active=clone(seed);active.closed=[];active.seen={};active.fundingSeen={};active.events=[];active.rejections=[];
 const row=index=>{
  ensure(integer(index,0,tradeCount-1),'SCALE_INVALID_ROW');const p=clone(template),offset=index*2*INTERVAL;
  p.key=`storage-history-${String(index).padStart(5,'0')}`;
  for(const key of ['openedAt','lastPriceAt','markPriceAt','closedAt'])p[key]+=offset;
  for(const part of [...p.entryParts,...p.exitParts])part.at+=offset;
  for(const part of p.fundingParts){part.at+=offset;part.id=`storage-funding-${String(index).padStart(5,'0')}`}
  return p;
 };
 const last=row(tradeCount-1);active.updatedAt=last.closedAt;active.connection={connected:true,at:last.closedAt};
 active.lastMarkets[template.instrumentName].timestamp=last.closedAt;active.lastMarkets[template.instrumentName].markPriceAt=last.closedAt;
 return {tradeCount,active,row,rows:function*(){for(let index=0;index<tradeCount;index++)yield row(index)}};
}
export function materializeStorageScaleFixture(fixture){
 const state=clone(fixture.active);
 for(const p of fixture.rows()){state.closed.push(p);state.seen[p.key]=p.openedAt-1;for(const part of p.fundingParts)state.fundingSeen[part.id]=part.at}
 return state;
}
function checkIdentity(p,index){
 ensure(p?.executionMode==='SYNTHETIC_TEST'&&p.dataSource==='SYNTHETIC_FIXTURE'&&p.key===`storage-history-${String(index).padStart(5,'0')}`&&
  Array.isArray(p.fundingParts)&&p.fundingParts.length===1&&p.fundingParts[0].id===`storage-funding-${String(index).padStart(5,'0')}`,
 'SCALE_SYNTHETIC_ID_SEQUENCE_MISMATCH');
}
export function auditStorageScaleRows(rows,active,{startIndex=0}={}){
 const state=clone(active);state.closed=[];state.seen={};state.fundingSeen={};let index=startIndex;
 for(const p of rows){checkIdentity(p,index++);state.closed.push(p);state.seen[p.key]=p.openedAt-1;
  for(const part of p.fundingParts)state.fundingSeen[part.id]=part.at}
 const audit=auditOrangeXPaperAccounting(state,{now:Math.max(active.updatedAt,state.closed.at(-1)?.closedAt??0)});
 ensure(audit.valid&&audit.complete,'SCALE_ACCOUNTING_AUDIT_FAILED');
 return {count:state.closed.length,realizedPnLUSD:state.closed.reduce((sum,p)=>sum+p.realizedPnLUSD,0)};
}
export function summarizeStorageScaleState(state,{segmentRows=1000}={}){
 const hash=createHash('sha256');let checked=0,realizedPnLUSD=0;
 for(let offset=0;offset<state.closed.length;offset+=segmentRows){
  const rows=state.closed.slice(offset,offset+segmentRows),audit=auditStorageScaleRows(rows,{...state,closed:[],seen:{},fundingSeen:{}},{startIndex:offset});
  checked+=audit.count;realizedPnLUSD+=audit.realizedPnLUSD;
  for(const p of rows){hash.update(json(p)+'\n');ensure(state.seen[p.key]===p.openedAt-1,'SCALE_SIGNAL_ID_LOST');
   for(const part of p.fundingParts)ensure(state.fundingSeen[part.id]===part.at,'SCALE_FUNDING_ID_LOST')}
 }
 ensure(Object.keys(state.seen).length===checked&&Object.keys(state.fundingSeen).length===checked,'SCALE_ID_COUNT_MISMATCH');
 return {historySHA256:hash.digest('hex'),tradeCount:checked,signalCount:checked,fundingCount:checked,realizedPnLUSD,
  accountingValid:true,accountingComplete:true,syntheticSequentialIdentityVerified:true,updatedAt:state.updatedAt};
}

export class OrangeXSyntheticSegmentedStorageLab{
 #io;#manifest=null;#active=null;#seq=0;#hash=null;#ids=new Map();#loaded=false;#lease=null;#uncertain=false;#closed=false;#logBytes=0;#logDigest=null;#lastAppendFailure=null;
 constructor({directory,io=fs,segmentRows=1000}={}){
  ensure(typeof directory==='string'&&integer(segmentRows,1,1000),'SCALE_INVALID_CONFIG');
  this.#io=io;this.segmentRows=segmentRows;const requested=path.resolve(directory);this.#ancestors(requested);
  // Resolve existing 8.3/long-name aliases, after rejecting actual symlink
  // ancestors. New descendants are retained without requiring they exist.
  let ancestor=requested;const missing=[];
  while(!fs.existsSync(ancestor)){missing.unshift(path.basename(ancestor));const parent=path.dirname(ancestor);ensure(parent!==ancestor,'SCALE_UNSAFE_PATH');ancestor=parent}
  this.directory=path.join(fs.realpathSync(ancestor),...missing);
  ensure(inside(this.directory,fs.realpathSync(os.tmpdir())),'SCALE_TEMP_ONLY');this.#ancestors(this.directory);
 }
 #ancestors(directory){
  const absolute=path.resolve(directory),root=path.parse(absolute).root;let current=root;
  for(const name of absolute.slice(root.length).split(path.sep).filter(Boolean)){current=path.join(current,name);
   let stat;try{stat=this.#io.lstatSync(current)}catch(error){if(error.code!=='ENOENT')throw error}
   ensure(!stat||stat.isDirectory()&&!stat.isSymbolicLink(),'SCALE_UNSAFE_PATH')}
 }
 #assert(){ensure(!this.#closed,'SCALE_CLOSED');if(this.#uncertain)throw Object.assign(failure('SCALE_COMMIT_UNCERTAIN'),
  this.#lastAppendFailure?{rollback:clone(this.#lastAppendFailure.rollback),appendFailure:clone(this.#lastAppendFailure)}:{})}
 #read(name,limit=16*1024*1024){
  ensure(name==='manifest.json'||name==='delta.jsonl'||name==='writer.lock'||SAFE.test(name),'SCALE_UNSAFE_FILE');
  this.#ancestors(this.directory);const file=path.join(this.directory,name),stat=this.#io.lstatSync(file);
  ensure(stat.isFile()&&!stat.isSymbolicLink()&&stat.nlink===1&&stat.size<=limit,'SCALE_UNSAFE_FILE');
  const fd=this.#io.openSync(file,this.#io.constants.O_RDONLY|(this.#io.constants.O_NOFOLLOW??0));
  try{const opened=this.#io.fstatSync(fd);ensure(opened.isFile()&&opened.nlink===1&&opened.size<=limit,'SCALE_UNSAFE_FILE');
   const value=this.#io.readFileSync(fd);ensure(value.length<=limit,'SCALE_SIZE_LIMIT');return value}
  finally{this.#io.closeSync(fd)}
 }
 #parse(value){try{return JSON.parse(value.toString('utf8'))}catch{throw failure('SCALE_INVALID_JSON')}}
 #syncDir(directory){let fd;try{fd=this.#io.openSync(directory,this.#io.constants.O_RDONLY);this.#io.fsyncSync(fd)}
  catch(error){if(process.platform!=='win32'||!['EACCES','EPERM','EINVAL','EISDIR','ENOTSUP'].includes(error.code))throw error}
  finally{if(fd!==undefined)this.#io.closeSync(fd)}}
 #writeNew(file,data){const fd=this.#io.openSync(file,this.#io.constants.O_WRONLY|this.#io.constants.O_CREAT|this.#io.constants.O_EXCL|(this.#io.constants.O_NOFOLLOW??0),0o600);
  try{this.#io.writeFileSync(fd,data);this.#io.fsyncSync(fd)}finally{this.#io.closeSync(fd)}}
 #publish(manifest){
  const body=bytes(manifest),wrapper=bytes({kind:KIND,version:VERSION,contentSHA256:digest(body),manifest}),
   temp=path.join(this.directory,'manifest.tmp-'+randomBytes(6).toString('hex'));
  this.#writeNew(temp,wrapper);this.#syncDir(this.directory);
  // Persist a freshly created experiment directory and each temporary parent
  // entry too. fsyncing only the child does not persist its parent's link.
  const temporary=fs.realpathSync(os.tmpdir());let parent=path.dirname(this.directory);
  for(;;){this.#syncDir(parent);if(parent===temporary)break;const next=path.dirname(parent);ensure(next!==parent,'SCALE_TEMP_ONLY');parent=next}
  try{this.#io.renameSync(temp,path.join(this.directory,'manifest.json'));this.#syncDir(this.directory)}
  catch(error){this.#uncertain=true;throw failure('SCALE_COMMIT_UNCERTAIN')}
 }
 #acquire(){
  this.#assert();const file=path.join(this.directory,'writer.lock');
  if(this.#lease){ensure(this.#read('writer.lock',4096).equals(this.#lease),'SCALE_LOCK_LOST');return false}
  const lease=bytes({kind:KIND,pid:process.pid,nonce:randomBytes(16).toString('hex')});
  for(let attempt=0;attempt<2;attempt++)try{this.#writeNew(file,lease);this.#lease=lease;return true}catch(error){
   if(error.code!=='EEXIST')throw error;const prior=this.#read('writer.lock',4096),lock=this.#parse(prior);
   ensure(lock.kind===KIND&&integer(lock.pid,1,Number.MAX_SAFE_INTEGER),'SCALE_LOCKED');let absent=false;
   try{process.kill(lock.pid,0)}catch(cause){absent=cause.code==='ESRCH'}
   ensure(absent&&!attempt&&this.#read('writer.lock',4096).equals(prior),'SCALE_LOCKED');this.#io.unlinkSync(file)
  }throw failure('SCALE_LOCKED');
 }
 initialize(fixture){
  this.#assert();ensure(fixture?.active?.executionMode==='SYNTHETIC_TEST'&&integer(fixture.tradeCount,1,MAX)&&typeof fixture.rows==='function','SCALE_SYNTHETIC_ONLY');
  this.#ancestors(this.directory);if(!this.#io.existsSync(this.directory))this.#io.mkdirSync(this.directory,{recursive:true,mode:0o700});
  ensure(this.#io.readdirSync(this.directory).length===0,'SCALE_DIRECTORY_NOT_EMPTY');this.#acquire();
  const segments=[],history=createHash('sha256');let batch=[],index=0,realizedPnLUSD=0;
  const flush=()=>{
   if(!batch.length)return;const start=index-batch.length,audit=auditStorageScaleRows(batch,fixture.active,{startIndex:start}),
    file=`segment-${String(segments.length).padStart(5,'0')}.json`,data=bytes({kind:KIND,version:VERSION,startIndex:start,closed:batch});
   this.#writeNew(path.join(this.directory,file),data);segments.push({file,sha256:digest(data),startIndex:start,count:batch.length,bytes:data.length});
   realizedPnLUSD+=audit.realizedPnLUSD;batch=[];
  };
  for(const row of fixture.rows()){checkIdentity(row,index++);history.update(json(row)+'\n');batch.push(row);if(batch.length===this.segmentRows)flush()}
  flush();ensure(index===fixture.tradeCount,'SCALE_TRADE_COUNT_MISMATCH');
  const active=clone(fixture.active);ensure(active.closed.length===0&&Object.keys(active.seen).length===0&&Object.keys(active.fundingSeen).length===0,'SCALE_ACTIVE_HISTORY_FORBIDDEN');
  const initial=bytes({active,seq:0,hash:digest(bytes({active,historySHA256:history.copy().digest('hex')})),ids:[]});
  this.#writeNew(path.join(this.directory,'genesis-active.json'),initial);this.#writeNew(path.join(this.directory,'delta.jsonl'),Buffer.alloc(0));
  const manifest={executionMode:'SYNTHETIC_TEST',tradeCount:index,segments,historySHA256:history.digest('hex'),realizedPnLUSD,
   genesis:{file:'genesis-active.json',sha256:digest(initial)},checkpoint:{file:'genesis-active.json',sha256:digest(initial)}};
  this.#publish(manifest);this.#loaded=false;return this.summary();
 }
 #load(){
  this.#assert();const wrapped=this.#parse(this.#read('manifest.json',1024*1024)),m=wrapped?.manifest;
  ensure(wrapped.kind===KIND&&wrapped.version===VERSION&&wrapped.contentSHA256===digest(bytes(m))&&m?.executionMode==='SYNTHETIC_TEST'&&integer(m.tradeCount,1,MAX)&&
   Array.isArray(m.segments)&&m.segments.length>0&&m.segments.length<=MAX&&HASH.test(m.historySHA256),'SCALE_MANIFEST_INVALID');
  const history=createHash('sha256');let count=0,realizedPnLUSD=0;const files=new Set();
  const genesisBytes=this.#read(m.genesis?.file),cpBytes=this.#read(m.checkpoint?.file);
  ensure(digest(genesisBytes)===m.genesis.sha256&&digest(cpBytes)===m.checkpoint.sha256,'SCALE_CHECKPOINT_HASH_MISMATCH');
  const genesis=this.#parse(genesisBytes),cp=this.#parse(cpBytes);
  ensure(genesis.seq===0&&genesis.active?.executionMode==='SYNTHETIC_TEST'&&genesis.hash===digest(bytes({active:genesis.active,historySHA256:m.historySHA256}))&&
   cp.active?.executionMode==='SYNTHETIC_TEST'&&integer(cp.seq,0,100000)&&HASH.test(cp.hash)&&Array.isArray(cp.ids),'SCALE_CHECKPOINT_INVALID');
  for(const segment of m.segments){
   ensure(/^segment-\d{5}\.json$/.test(segment.file)&&!files.has(segment.file)&&segment.startIndex===count&&integer(segment.count,1,1000),'SCALE_SEGMENT_SEQUENCE_INVALID');files.add(segment.file);
   const data=this.#read(segment.file);ensure(digest(data)===segment.sha256&&data.length===segment.bytes,'SCALE_SEGMENT_HASH_MISMATCH');
   const parsed=this.#parse(data);ensure(parsed.kind===KIND&&parsed.version===VERSION&&parsed.startIndex===count&&Array.isArray(parsed.closed)&&parsed.closed.length===segment.count,'SCALE_SEGMENT_INVALID');
   const audit=auditStorageScaleRows(parsed.closed,cp.active,{startIndex:count});realizedPnLUSD+=audit.realizedPnLUSD;
   for(const row of parsed.closed)history.update(json(row)+'\n');count+=parsed.closed.length;
  }
  ensure(count===m.tradeCount&&history.digest('hex')===m.historySHA256,'SCALE_HISTORY_HASH_MISMATCH');
  ensure(Math.abs(realizedPnLUSD-m.realizedPnLUSD)<=1e-8*Math.max(1,count),'SCALE_ACCOUNTING_TOTAL_MISMATCH');
  const log=this.#read('delta.jsonl',8*1024*1024);ensure(log.length===0||log.at(-1)===10,'SCALE_PARTIAL_TAIL');
  let seq=0,hash=genesis.hash,active=clone(genesis.active),boundary=cp.seq===0&&cp.hash===hash&&json(cp.active)===json(active)&&cp.ids.length===0;const ids=new Map();
  for(const line of log.toString('utf8').split('\n').filter(Boolean)){
   const row=this.#parse(Buffer.from(line));
   ensure(row!==null&&typeof row==='object'&&!Array.isArray(row)&&Object.keys(row).length===5&&['seq','previousHash','id','updatedAt','hash'].every(key=>Object.hasOwn(row,key)),'SCALE_DELTA_INVALID');
   const content={seq:row.seq,previousHash:row.previousHash,id:row.id,updatedAt:row.updatedAt};
   ensure(row.seq===seq+1&&row.previousHash===hash&&HASH.test(row.hash)&&row.hash===digest(bytes(content))&&typeof row.id==='string'&&/^[A-Za-z0-9:_-]{1,100}$/.test(row.id)&&!ids.has(row.id)&&
    Number.isSafeInteger(row.updatedAt)&&row.updatedAt>active.updatedAt,'SCALE_DELTA_INVALID');
   ids.set(row.id,digest(bytes({id:row.id,updatedAt:row.updatedAt})));seq=row.seq;hash=row.hash;active.updatedAt=row.updatedAt;active.connection={connected:true,at:row.updatedAt};
   if(seq===cp.seq){ensure(hash===cp.hash&&json(active)===json(cp.active)&&json([...ids])===json(cp.ids),'SCALE_CHECKPOINT_PREFIX_MISMATCH');boundary=true}
  }
  ensure(boundary&&seq>=cp.seq,'SCALE_CHECKPOINT_PREFIX_MISSING');
  this.#manifest=m;this.#active=active;this.#seq=seq;this.#hash=hash;this.#ids=ids;this.#loaded=true;this.#logBytes=log.length;this.#logDigest=createHash('sha256').update(log);
  return {historySHA256:m.historySHA256,tradeCount:count,signalCount:count,fundingCount:count,realizedPnLUSD,
   accountingValid:true,accountingComplete:true,syntheticSequentialIdentityVerified:true,updatedAt:active.updatedAt,seq,
   activeBytes:Buffer.byteLength(json(active)),closedRowsRetainedInActiveMemory:0,fullArchiveVerification:true};
 }
 summary(){return this.#load()}
 heartbeat({id,updatedAt}={}){
  this.#assert();ensure(typeof id==='string'&&/^[A-Za-z0-9:_-]{1,100}$/.test(id)&&Number.isSafeInteger(updatedAt),'SCALE_INVALID_DELTA');
  const acquired=this.#acquire();if(acquired||!this.#loaded)this.#load();const content=digest(bytes({id,updatedAt}));
  if(this.#ids.has(id)){ensure(this.#ids.get(id)===content,'SCALE_TRANSACTION_ID_CONFLICT');return {seq:this.#seq,duplicate:true}}
  ensure(updatedAt>this.#active.updatedAt,'SCALE_TIME_ORDER');const payload={seq:this.#seq+1,previousHash:this.#hash,id,updatedAt},hash=digest(bytes(payload)),line=bytes({...payload,hash});
  ensure(this.#logBytes+line.length<=8*1024*1024,'SCALE_DELTA_LIMIT');const file=path.join(this.directory,'delta.jsonl');let fd,opened,writeStarted=false,stage='append-open';
  try{
   fd=this.#io.openSync(file,this.#io.constants.O_WRONLY|this.#io.constants.O_APPEND|(this.#io.constants.O_NOFOLLOW??0));
   stage='append-open-stat';opened=this.#io.fstatSync(fd,{bigint:true});ensure(opened.isFile()&&opened.nlink===1n&&opened.size===BigInt(this.#logBytes)&&typeof opened.dev==='bigint'&&typeof opened.ino==='bigint','SCALE_LOG_CHANGED');let offset=0;
   while(offset<line.length){stage='append-write';writeStarted=true;const n=this.#io.writeSync(fd,line,offset,line.length-offset,null);ensure(Number.isInteger(n)&&n>0,'SCALE_SHORT_WRITE');offset+=n}
   stage='append-fsync';this.#io.fsyncSync(fd);stage='append-commit-stat';ensure(this.#io.fstatSync(fd).size===this.#logBytes+line.length,'SCALE_LOG_CHANGED');
   // close may release the descriptor before reporting an error. Transfer
   // ownership first so an ambiguous close is never retried on a reused fd.
   stage='append-close';const closing=fd;fd=undefined;this.#io.closeSync(closing);stage='append-memory-commit';
   this.#seq++;this.#hash=hash;this.#logBytes+=line.length;this.#logDigest.update(line);this.#lastAppendFailure=null;this.#ids.set(id,content);
   this.#active.updatedAt=updatedAt;this.#active.connection={connected:true,at:updatedAt};return {seq:this.#seq,duplicate:false};
  }catch(error){
   this.#lastAppendFailure={original:appendFailure(error,stage),rollback:{required:writeStarted,verified:!writeStarted}};
   if(fd===undefined&&writeStarted){this.#uncertain=true;this.#lastAppendFailure.rollback={required:true,verified:false,...appendFailure(error,stage)}}
   if(fd!==undefined){const appendFd=fd;fd=undefined;
    if(writeStarted)try{
     // An append-only Windows handle can reject ftruncate. Reopen without
     // append permissions only after preserving its identity and trusted WAL
     // hash; retry requires a fully proved, flushed and closed rollback.
     this.#lastAppendFailure.rollback=rollbackDurableAppend({io:this.#io,file,appendFd,openedStat:opened,
      committedBytes:this.#logBytes,recordBytes:line,prefixHash:this.#logDigest.copy().digest('hex')});
    }catch(rollbackError){this.#uncertain=true;this.#lastAppendFailure.rollback=rollbackError.rollback??{verified:false,...appendFailure(rollbackError,'rollback-unknown')}}
    else try{this.#io.closeSync(appendFd)}catch(closeError){this.#uncertain=true;this.#lastAppendFailure.rollback={verified:false,...appendFailure(closeError,'append-close-before-write')}}
   }
   if(this.#uncertain)throw Object.assign(failure('SCALE_COMMIT_UNCERTAIN'),{cause:error,rollback:clone(this.#lastAppendFailure.rollback),appendFailure:clone(this.#lastAppendFailure)});
   throw error;
  }
 }
 checkpoint(){
  this.#assert();this.#acquire();this.#load();const file=`active-${this.#seq}-${randomBytes(6).toString('hex')}.json`,data=bytes({active:this.#active,seq:this.#seq,hash:this.#hash,ids:[...this.#ids]});
  ensure(data.length<=1024*1024,'SCALE_ACTIVE_CHECKPOINT_LIMIT');this.#writeNew(path.join(this.directory,file),data);
  this.#publish({...this.#manifest,checkpoint:{file,sha256:digest(data)}});this.#loaded=false;return file;
 }
 #copyRequired(target){
  this.summary();const m=this.#manifest,names=['manifest.json','delta.jsonl',m.genesis.file,m.checkpoint.file,...m.segments.map(x=>x.file)];
  this.#io.mkdirSync(target,{recursive:false,mode:0o700});
  for(const name of new Set(names)){
   const data=this.#read(name,name==='delta.jsonl'?8*1024*1024:16*1024*1024);this.#writeNew(path.join(target,name),data);
   ensure(digest(this.#io.readFileSync(path.join(target,name)))===digest(data),'SCALE_COPY_MISMATCH');
  }this.#syncDir(target);this.#syncDir(path.dirname(target));
 }
 backup(){this.#assert();this.#acquire();const name='backup-'+randomBytes(12).toString('hex');this.#copyRequired(path.join(this.directory,name));return name}
 restoreBackup(name){
  this.#assert();ensure(typeof name==='string'&&/^backup-[a-f0-9]{24}$/.test(name),'SCALE_INVALID_BACKUP');
  const source=new OrangeXSyntheticSegmentedStorageLab({directory:path.join(this.directory,name),io:this.#io,segmentRows:this.segmentRows});source.summary();
  const target=path.join(this.directory,'restored-'+randomBytes(12).toString('hex'));source.#copyRequired(target);source.close();
  const restored=new OrangeXSyntheticSegmentedStorageLab({directory:target,io:this.#io,segmentRows:this.segmentRows});restored.summary();return restored;
 }
 close(){if(this.#closed)return;if(this.#lease){ensure(this.#read('writer.lock',4096).equals(this.#lease),'SCALE_LOCK_LOST');this.#io.unlinkSync(path.join(this.directory,'writer.lock'));this.#lease=null}this.#closed=true}
}
