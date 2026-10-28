// A replay report is an immutable experiment archive, never a forward ledger.
// Reading an absent archive creates neither files nor directories.
import fs from 'node:fs';
import path from 'node:path';
import {randomBytes} from 'node:crypto';
const LIMIT=24*1024*1024,FILE='orangex-replay.json';
const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
function problem(code){const error=Error(code);error.code=code;return error}
function ancestors(directory){
 const resolved=path.resolve(directory),root=path.parse(resolved).root;let current=root;
 for(const segment of resolved.slice(root.length).split(path.sep).filter(Boolean)){
  current=path.join(current,segment);let stat;
  try{stat=fs.lstatSync(current)}catch(error){if(error.code==='ENOENT')continue;throw error}
  if(stat.isSymbolicLink()||!stat.isDirectory())throw problem('UNSAFE_REPLAY_DIRECTORY');
 }
}
function regular(file,{missing=false}={}){
 ancestors(path.dirname(file));let stat;
 try{stat=fs.lstatSync(file)}catch(error){if(error.code==='ENOENT'&&missing)return null;throw error}
 if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||stat.size>LIMIT)throw problem('UNSAFE_REPLAY_FILE');return stat;
}
function validate(result){
 if(!plain(result)||result.kind!=='ORANGEX_PAPER_REPLAY_RESULT'||result.runKind!=='BACKTEST'||
  !['SYNTHETIC_TEST','HISTORICAL_REPLAY'].includes(result.executionMode)||result.realDataAutoEntryEnabled!==false||result.liveOrdersEnabled!==false||
  !Array.isArray(result.analyses)||!Array.isArray(result.signals)||!plain(result.summary))throw problem('INVALID_REPLAY_ARCHIVE');
 if(result.executionMode==='HISTORICAL_REPLAY'&&(result.snapshot!==null||result.summary.trades!==0))throw problem('HISTORICAL_FILLS_DISABLED');
 if(result.executionMode==='SYNTHETIC_TEST'&&result.dataSource!=='SYNTHETIC_FIXTURE'||
  result.executionMode==='HISTORICAL_REPLAY'&&!['SYNTHETIC_FIXTURE','USER_SUPPLIED_HISTORICAL_UNVERIFIED_ORIGIN'].includes(result.dataSource))throw problem('REPLAY_SOURCE_UNVERIFIED');
 if(result.executionMode==='SYNTHETIC_TEST'&&(!plain(result.snapshot)||result.snapshot.executionMode!=='SYNTHETIC_TEST'||result.snapshot.runKind!=='BACKTEST'))throw problem('REPLAY_CONTEXT_MISMATCH');
 if(result.performance!=null&&(!plain(result.performance)||result.performance.executionMode!==result.executionMode||result.performance.runKind!=='BACKTEST'))throw problem('REPLAY_CONTEXT_MISMATCH');
 return result;
}
export class OrangeXPaperReplayStore{
 constructor({directory}={}){
  if(typeof directory!=='string'||!directory.trim()||directory.includes('\0'))throw problem('INVALID_REPLAY_DIRECTORY');
  this.directory=path.resolve(directory);if(this.directory===path.parse(this.directory).root)throw problem('INVALID_REPLAY_DIRECTORY');
  ancestors(this.directory);this.file=path.join(this.directory,FILE);
 }
 read(){
  if(!regular(this.file,{missing:true}))return null;
  const fd=fs.openSync(this.file,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW??0));let bytes;
  try{const stat=fs.fstatSync(fd);if(!stat.isFile()||stat.nlink!==1||stat.size>LIMIT)throw problem('UNSAFE_REPLAY_FILE');bytes=fs.readFileSync(fd)}finally{fs.closeSync(fd)}
  if(bytes.length>LIMIT)throw problem('REPLAY_ARCHIVE_TOO_LARGE');
  let wrapper;try{wrapper=JSON.parse(bytes.toString('utf8'))}catch{throw problem('INVALID_REPLAY_ARCHIVE')}
  if(wrapper?.kind!=='ORANGEX_PAPER_REPLAY_ARCHIVE'||wrapper?.version!==1)throw problem('INVALID_REPLAY_ARCHIVE');
  return validate(wrapper.result);
 }
 write(result){
  validate(result);
  const bytes=Buffer.from(JSON.stringify({kind:'ORANGEX_PAPER_REPLAY_ARCHIVE',version:1,result},null,2)+'\n');
  if(bytes.length>LIMIT)throw problem('REPLAY_ARCHIVE_TOO_LARGE');
  ancestors(this.directory);fs.mkdirSync(this.directory,{recursive:true,mode:0o700});ancestors(this.directory);
  const lock=path.join(this.directory,'orangex-replay.lock'),temp=path.join(this.directory,`orangex-replay.tmp-${process.pid}-${randomBytes(6).toString('hex')}`);
  let lease=null,fd=null;
  try{
   lease=fs.openSync(lock,'wx',0o600);
   if(regular(this.file,{missing:true}))throw problem('REPLAY_ARCHIVE_ALREADY_EXISTS');
   fd=fs.openSync(temp,'wx',0o600);fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);fs.closeSync(fd);fd=null;
   if(regular(this.file,{missing:true}))throw problem('REPLAY_ARCHIVE_ALREADY_EXISTS');
   fs.renameSync(temp,this.file);return this.read();
  }finally{
   if(fd!==null)fs.closeSync(fd);
   try{fs.unlinkSync(temp)}catch(error){if(error.code!=='ENOENT')throw error}
   if(lease!==null){fs.closeSync(lease);fs.unlinkSync(lock)}
  }
 }
 snapshot(){
  try{const stored=this.read(),result=stored?Object.fromEntries(['kind','executionMode','runKind','dataSource','originalDataSource','provenance','sourceOriginVerified','startAt','endAt','fillAccuracy','candleOnly','summary','performance','assumptions'].filter(key=>Object.hasOwn(stored,key)).map(key=>[key,stored[key]])):null;
   if(result){result.signals=stored.signals.slice(-100);result.signalsOmitted=Math.max(0,stored.signals.length-100)}
   return {kind:'ORANGEX_PAPER_REPLAY_VIEW',runKind:'BACKTEST',status:result?'OBSERVED':'UNOBSERVED',
   executionMode:result?.executionMode??null,realDataAutoEntryEnabled:false,liveOrdersEnabled:false,result}}
  catch{return {kind:'ORANGEX_PAPER_REPLAY_VIEW',runKind:'BACKTEST',status:'ERROR',executionMode:null,realDataAutoEntryEnabled:false,liveOrdersEnabled:false,result:null,errorCode:'REPLAY_ARCHIVE_UNAVAILABLE'}}
 }
}
