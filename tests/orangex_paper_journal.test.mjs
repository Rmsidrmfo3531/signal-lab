import nodeTest from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
import {OrangeXPaperJournal} from '../orangex_paper_journal.mjs';
import {killAcknowledgedJournalWriter} from './helpers/journal_writer.mjs';
import {traceStorageStage} from '../scripts/storage-worker.mjs';

let currentTest=null,ioBudget=96;
const tracedMethods=new Set(['initialize','append','checkpoint','backup','restoreBackup','close']);
const trace=(stage,details={})=>{
 traceStorageStage('journal-test',stage,{test:currentTest,...details});
 // The sidecar is read live by CI even while spawnSync blocks this process.
 // stderr remains useful for running this file directly without the CI runner.
 if(!stage.startsWith('io.'))fs.writeSync(2,'[STORAGE_PHASE] '+JSON.stringify({at:new Date().toISOString(),pid:process.pid,
  scope:'journal-test',stage,test:currentTest,...details})+'\n');
};
function test(name,options,run){
 if(typeof options==='function'){run=options;options={};}
 return nodeTest(name,options,async(t)=>{
  currentTest=name;trace('test.begin');
  try{return await run(t)}catch(error){trace('test.failed',{code:error.code??error.name});throw error}
  finally{trace('test.end');currentTest=null}
 });
}
function tracedIO(target=fs){
 const directories=new Map();let testBudget=12;
 const emit=(stage,details)=>{if(ioBudget>0&&testBudget>0){ioBudget--;testBudget--;trace('io.'+stage,details)}};
 return new Proxy(target,{get(io,key){
  const fn=Reflect.get(io,key);if(typeof fn!=='function')return fn;
  if(key==='mkdirSync')return(file,...args)=>{
   emit('mkdir.begin',{requested:String(file),customIO:target!==fs});
   try{const first=fn.call(io,file,...args);emit('mkdir.end',{requested:String(file),returnedFirst:first??null,customIO:target!==fs});return first}
   catch(error){emit('mkdir.failed',{requested:String(file),code:error.code??error.name});throw error}
  };
  if(key==='openSync')return(file,...args)=>{
   const directory=typeof file==='string'&&fs.existsSync(file)&&fs.statSync(file).isDirectory();
   if(directory)emit('directory-open.begin',{directory:file});
   try{const fd=fn.call(io,file,...args);if(directory){directories.set(fd,file);emit('directory-open.end',{directory:file,fd});}return fd}
   catch(error){if(directory)emit('directory-open.failed',{directory:file,code:error.code??error.name});throw error}
  };
  if(key==='fsyncSync'||key==='closeSync')return(fd,...args)=>{
   const directory=directories.get(fd);if(directory)emit(key+'.begin',{directory,fd});
   try{const result=fn.call(io,fd,...args);if(directory)emit(key+'.end',{directory,fd});return result}
   catch(error){if(directory)emit(key+'.failed',{directory,fd,code:error.code??error.name});throw error}
   finally{if(key==='closeSync')directories.delete(fd)}
  };
  return fn;
 }});
}

// Storage fixtures only. These are not exchange orders, balances or fees.
const NOW=Date.parse('2026-10-29T00:00:00Z');
const state=(extra={})=>({schemaVersion:1,settings:{capitalUSD:1000},contracts:{},pending:[],open:[],closed:[],seen:{},fundingSeen:{},events:[],rejections:[],...extra});
const fill={id:'fill:one',ops:[{op:'append',path:['closed'],value:{key:'trade:one',quantity:1.25,realizedPnLUSD:2.5}},
 {op:'set',path:['seen','signal:one'],value:NOW}]};
const funding={id:'funding:one',ops:[{op:'set',path:['fundingSeen','period:one'],value:NOW},
 {op:'set',path:['closed','0','realizedPnLUSD'],value:2.375}]};
const injected=code=>Object.assign(Error('injected filesystem error'),{code});
function sandbox(run){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'orangex-journal-')),directory=path.join(root,'experiment'),stores=[];
 const create=(options={})=>{
  trace('journal.construct',{directory});
  const journal=new OrangeXPaperJournal({directory,now:()=>NOW,...options,io:tracedIO(options.io??fs)});stores.push(journal);
  return new Proxy(journal,{get(target,key){const fn=Reflect.get(target,key);if(typeof fn!=='function')return fn;
   if(!tracedMethods.has(key))return fn.bind(target);
   return(...args)=>{trace('journal.'+String(key)+'.begin');try{const result=fn.apply(target,args);trace('journal.'+String(key)+'.end');return result}
    catch(error){trace('journal.'+String(key)+'.failed',{code:error.code??error.name});throw error}}
  }});
 };
 try{return run({root,directory,create})}finally{
  trace('sandbox.close.begin');for(const journal of stores)try{journal.close()}catch{}trace('sandbox.close.end');
  trace('sandbox.remove.begin',{directory:root});fs.rmSync(root,{recursive:true,force:true,maxRetries:8,retryDelay:100});trace('sandbox.remove.end',{directory:root});
 }
}
const files=directory=>fs.readdirSync(directory).sort();

// Real file data/fsyncs, virtual directory handles: a bad ancestry walk fails
// deterministically instead of hanging a test or syncing the filesystem root.
function directoryTraceIO(returnFirst){
 const directories=new Map(),syncs=[],mkdirReturns=[];let next=-100000,opens=0;
 const io=new Proxy(fs,{get(target,key){
  if(key==='mkdirSync')return(file,...args)=>{const first=fs.mkdirSync(file,...args),returned=returnFirst(first);
   mkdirReturns.push({requested:String(file),actualFirst:first,returned});return returned};
  if(key==='openSync')return(file,...args)=>{
   if(fs.existsSync(file)&&fs.statSync(file).isDirectory()){
    if(++opens>100)throw Object.assign(Error('unbounded directory ancestry traversal'),{code:'TEST_DIRECTORY_WALK_UNBOUNDED'});
    const fd=next--;directories.set(fd,String(file));return fd;
   }
   return fs.openSync(file,...args);
  };
  if(key==='fsyncSync')return fd=>{if(directories.has(fd)){syncs.push(directories.get(fd));return}return fs.fsyncSync(fd)};
  if(key==='closeSync')return fd=>{if(directories.delete(fd))return;return fs.closeSync(fd)};
  return Reflect.get(target,key);
 }});
 return {io,syncs,mkdirReturns};
}

test('recursive mkdir return casing or alias spelling cannot cause an unbounded directory-fsync walk',()=>sandbox(({root,directory,create})=>{
 const trace=directoryTraceIO(first=>typeof first==='string'?first.toUpperCase()+'-returned-alias':first),journal=create({io:trace.io});
 journal.initialize(state());journal.append(fill);journal.append(funding);
 const before=journal.read(),backup=journal.backup();journal.append({id:'after-backup',ops:[{op:'set',path:['updatedAt'],value:NOW+1}]});
 assert.deepEqual(journal.restoreBackup(backup),before);assert.deepEqual(journal.read(),before);
 assert.equal(journal.append(fill).duplicate,true);assert.equal(journal.append(funding).duplicate,true);
 assert.equal(journal.read().closed[0].realizedPnLUSD,2.375);
 assert.deepEqual(trace.syncs.slice(0,2),[directory,root],'leaf and existing parent still synchronize before publication');
 assert.ok(trace.mkdirReturns.some(row=>typeof row.returned==='string'&&row.returned!==row.actualFirst));
 assert.ok(trace.syncs.every(file=>file===root||file.startsWith(root+path.sep)),'do not wander above the first existing parent');
}));

test('new directory entries are synchronized even if recursive mkdir returns no first-created path',()=>sandbox(({root,directory,create})=>{
 const trace=directoryTraceIO(()=>undefined),journal=create({io:trace.io});journal.initialize(state());journal.append(fill);
 assert.deepEqual(trace.syncs.slice(0,2),[directory,root]);
 const backup=journal.backup();assert.equal(journal.restoreBackup(backup).closed[0].realizedPnLUSD,2.5);
}));

test('a missing filesystem root fails before mkdir instead of walking the same root forever',()=>sandbox(({directory,create})=>{
 let creates=0;
 const io=new Proxy(fs,{get(target,key){
  if(key==='lstatSync')return()=>{throw Object.assign(Error('injected missing filesystem ancestry'),{code:'ENOENT'})};
  if(key==='mkdirSync')return()=>{creates++;throw Error('mkdir must not run without an existing ancestor')};
  return Reflect.get(target,key);
 }});
 assert.throws(()=>create({io}).initialize(state()),{code:'JOURNAL_UNSAFE_PATH'});
 assert.equal(creates,0);assert.equal(fs.existsSync(directory),false);
}));

test('experimental journal is opt-in and absent reads/backups never initialize or modify legacy records',()=>sandbox(({root,directory,create})=>{
 const journal=create();assert.equal(journal.read(),null);assert.equal(journal.backup(),null);assert.equal(fs.existsSync(directory),false);
 assert.equal(journal.status().experimental,true);assert.equal(journal.status().productionSelected,false);
 assert.throws(()=>journal.append(fill),/NOT_INITIALIZED/);assert.equal(fs.existsSync(directory),false);
 fs.mkdirSync(directory);fs.writeFileSync(path.join(directory,'store.json'),'legacy PNL');fs.writeFileSync(path.join(directory,'.env'),'legacy settings');
 assert.throws(()=>journal.initialize(state()),/DIRECTORY_NOT_EMPTY/);assert.throws(()=>journal.read(),/UNINITIALIZED_ARTIFACTS/);
 assert.equal(fs.readFileSync(path.join(directory,'store.json'),'utf8'),'legacy PNL');assert.deepEqual(files(directory),['.env','store.json']);
}));

test('small fsynced delta transactions preserve fill and funding identities through checkpoint and restart',()=>sandbox(({directory,create})=>{
 const journal=create();journal.initialize(state());assert.equal(journal.append(fill).seq,1);assert.equal(journal.append(funding).seq,2);
 const expected=journal.read();assert.equal(expected.closed[0].realizedPnLUSD,2.375);assert.equal(expected.fundingSeen['period:one'],NOW);
 const log=fs.readFileSync(path.join(directory,'journal.jsonl'),'utf8');assert.equal(log.trim().split('\n').length,2);
 assert.ok(log.length<1500);assert.doesNotMatch(log,/'capitalUSD'|"state":/);
 journal.checkpoint();const logBefore=fs.readFileSync(path.join(directory,'journal.jsonl'));journal.close();
 const recovered=create();assert.deepEqual(recovered.read(),expected);assert.equal(recovered.inspect().transactionCount,2);
 assert.equal(recovered.append(fill).duplicate,true);assert.equal(recovered.append(funding).duplicate,true);
 assert.ok(fs.readFileSync(path.join(directory,'journal.jsonl')).equals(logBefore));
 const copy=recovered.read();copy.closed[0].realizedPnLUSD=999;assert.equal(recovered.read().closed[0].realizedPnLUSD,2.375);
}));

test('a cached reader acquires the active restored generation before acknowledging a new durable transaction',()=>sandbox(({create})=>{
 const original=create();original.initialize(state());original.append(fill);const backup=original.backup();original.append(funding);original.close();
 const cached=create();assert.equal(cached.read().closed[0].realizedPnLUSD,2.375);
 const restorer=create();restorer.restoreBackup(backup);restorer.close();
 const afterRestore={id:'after-restore',ops:[{op:'set',path:['updatedAt'],value:NOW+1}]};
 assert.equal(cached.append(afterRestore).duplicate,false);assert.equal(cached.inspect().seq,2);
 assert.equal(cached.read().updatedAt,NOW+1,'ACK must target the current manifest generation');
 assert.equal(cached.append(funding).duplicate,false,'the restored generation has not charged funding');
 assert.equal(cached.inspect().seq,3);assert.equal(cached.read().closed[0].realizedPnLUSD,2.375);
 cached.close();const resumed=create();assert.equal(resumed.read().closed[0].realizedPnLUSD,2.375);
 assert.equal(resumed.read().updatedAt,NOW+1);assert.equal(resumed.append(afterRestore).duplicate,true);
 assert.equal(resumed.append(funding).duplicate,true);assert.equal(resumed.inspect().seq,3);
}));

test('conflicting transaction IDs, sequence conflicts and a partially invalid batch do not publish any mutation',()=>sandbox(({create})=>{
 const journal=create();journal.initialize(state());journal.append(fill);const before=journal.read(),head=journal.inspect();
 assert.throws(()=>journal.append({...fill,ops:[{op:'set',path:['updatedAt'],value:9}]}),/TRANSACTION_ID_CONFLICT/);
 assert.throws(()=>journal.append({id:'stale',expectedSeq:0,ops:[{op:'set',path:['updatedAt'],value:9}]}),/SEQUENCE_CONFLICT/);
 assert.throws(()=>journal.append({id:'bad-batch',ops:[{op:'set',path:['updatedAt'],value:9},{op:'set',path:['missing','field'],value:1}]}),/INVALID_OPERATION/);
 assert.throws(()=>journal.append({id:'later-bad',ops:[{op:'append',path:['events'],value:{type:'first'}},{op:'set',path:['open','0','qty'],value:1}]}),/PATH_MISSING/);
 assert.deepEqual(journal.read(),before);assert.deepEqual(journal.inspect(),head);
}));

test('a duplicated funding business key under a different transport ID cannot charge the position again',()=>sandbox(({create})=>{
 const journal=create();journal.initialize(state());journal.append(fill);journal.append(funding);const before=journal.read(),head=journal.inspect();
 assert.throws(()=>journal.append({id:'funding:reconnect-new-transport-id',ops:[
  {op:'set',path:['closed','0','realizedPnLUSD'],value:2.25},
  {op:'set',path:['fundingSeen','period:one'],value:NOW}
 ]}),/IDEMPOTENCY_CONFLICT/);
 assert.throws(()=>journal.append({id:'funding:map-replace',ops:[
  {op:'set',path:['fundingSeen'],value:{'period:one':NOW}},{op:'set',path:['closed','0','realizedPnLUSD'],value:2.25}
 ]}),/IDEMPOTENCY_ROOT_IMMUTABLE/);
 assert.deepEqual(journal.read(),before);assert.deepEqual(journal.inspect(),head);
}));

test('unsafe keys and attempts to erase idempotency/history identifiers fail without losing recorded identities',()=>sandbox(({create})=>{
 const journal=create();journal.initialize(state());journal.append(fill);journal.append(funding);const before=journal.read();
 for(const tx of [
  {id:'proto',ops:[{op:'set',path:['settings','__proto__'],value:{polluted:true}}]},
  {id:'value-proto',ops:[{op:'set',path:['settings','test'],value:JSON.parse('{"__proto__":{"polluted":true}}')}]},
  {id:'erase-seen',ops:[{op:'set',path:['seen'],value:{}}]},
  {id:'erase-funding',ops:[{op:'delete',path:['fundingSeen','period:one']}]},
  {id:'replace-history',ops:[{op:'set',path:['closed'],value:[]}]},
  {id:'replace-identity',ops:[{op:'set',path:['closed','0','key'],value:'different'}]},
  {id:'duplicate-key',ops:[{op:'append',path:['closed'],value:{key:'trade:one'}}]}
 ])assert.throws(()=>journal.append(tx));
 assert.equal({}.polluted,undefined);assert.deepEqual(journal.read(),before);
}));

test('partial tail and altered chain records are preserved and rejected instead of silently truncated',()=>sandbox(({directory,create})=>{
 let journal=create();journal.initialize(state());journal.append(fill);journal.close();
 const logFile=path.join(directory,'journal.jsonl'),original=fs.readFileSync(logFile);
 fs.appendFileSync(logFile,'{"incomplete":');const damaged=fs.readFileSync(logFile);journal=create();
 assert.throws(()=>journal.read(),/PARTIAL_TAIL/);assert.equal(journal.status().healthy,false);assert.throws(()=>journal.append(funding),/PARTIAL_TAIL/);
 assert.ok(fs.readFileSync(logFile).equals(damaged));journal.close();
 const record=JSON.parse(original.toString('utf8'));record.ops[0].value.quantity=999;fs.writeFileSync(logFile,JSON.stringify(record)+'\n');
 journal=create();assert.throws(()=>journal.read(),/HASH_MISMATCH/);journal.close();
 const extra=JSON.parse(original.toString('utf8'));extra.ignoredExtra='tamper';fs.writeFileSync(logFile,JSON.stringify(extra)+'\n');
 assert.throws(()=>create().read(),/INVALID_RECORD/);
 delete extra.ignoredExtra;extra.ops[0].ignoredExtra='tamper';fs.writeFileSync(logFile,JSON.stringify(extra)+'\n');assert.throws(()=>create().read(),/INVALID_RECORD/);
}));

test('mid-record ENOSPC rolls back bytes and memory before acknowledgement and permits a safe single retry',()=>sandbox(({directory,create})=>{
 let fail=false,partial=false;
 const io=new Proxy(fs,{get(target,key){
  if(key==='writeSync')return (fd,buffer,offset,length,position)=>{
   if(fail){if(!partial){partial=true;return fs.writeSync(fd,buffer,offset,Math.min(23,length),position)}throw injected('ENOSPC')}
   return fs.writeSync(fd,buffer,offset,length,position);
  };return Reflect.get(target,key);
 }});
 const journal=create({io});journal.initialize(state());journal.append(fill);const before=journal.read(),logFile=path.join(directory,'journal.jsonl'),bytes=fs.readFileSync(logFile);
 fail=true;assert.throws(()=>journal.append(funding),{code:'ENOSPC'});assert.ok(fs.readFileSync(logFile).equals(bytes));
 fail=false;assert.deepEqual(journal.read(),before);assert.equal(journal.inspect().seq,1);assert.equal(journal.append(funding).seq,2);
 assert.equal(journal.append(funding).duplicate,true);assert.equal(journal.read().closed[0].realizedPnLUSD,2.375);
}));

test('an uncertain append freezes writes until explicit own-backup recovery while preserving damaged original bytes',()=>sandbox(({directory,create})=>{
 let fail=false;
 const io=new Proxy(fs,{get(target,key){
  if(key==='fsyncSync')return fd=>{if(fail)throw injected('EIO');return fs.fsyncSync(fd)};
  if(key==='ftruncateSync')return (fd,size)=>{if(fail)throw injected('EIO');return fs.ftruncateSync(fd,size)};
  return Reflect.get(target,key);
 }});
 const journal=create({io});journal.initialize(state());journal.append(fill);const backup=journal.backup();
 fail=true;assert.throws(()=>journal.append(funding),/COMMIT_UNCERTAIN/);assert.equal(journal.status().uncertain,true);
 assert.throws(()=>journal.append({id:'blocked',ops:[{op:'set',path:['updatedAt'],value:2}]}),/COMMIT_UNCERTAIN/);
 const raw=fs.readFileSync(path.join(directory,'journal.jsonl'));fail=false;
 const restored=journal.restoreBackup(backup);assert.equal(restored.closed[0].realizedPnLUSD,2.5);assert.equal(journal.status().healthy,true);
 const preserved=path.join(directory,'backups',journal.status().lastRestoreBackup,'journal.jsonl');assert.ok(fs.readFileSync(preserved).equals(raw));
 assert.equal(journal.append(fill).duplicate,true);assert.equal(journal.append(funding).seq,2);assert.equal(journal.read().closed[0].realizedPnLUSD,2.375);
}));

test('checkpoints verify their own bytes and their exact journal prefix rather than skipping corrupted history',()=>sandbox(({directory,create})=>{
 const journal=create();journal.initialize(state());journal.append(fill);const cp=journal.checkpoint();journal.append(funding);journal.close();
 const logFile=path.join(directory,'journal.jsonl'),original=fs.readFileSync(logFile,'utf8');
 fs.writeFileSync(logFile,original.replace('trade:one','trade:two'));assert.throws(()=>create().read(),/HASH_MISMATCH/);
 fs.writeFileSync(logFile,original);const cpFile=path.join(directory,cp),wrapper=JSON.parse(fs.readFileSync(cpFile,'utf8'));wrapper.state.closed[0].quantity=999;fs.writeFileSync(cpFile,JSON.stringify(wrapper));
 assert.throws(()=>create().read(),/CHECKPOINT_HASH_MISMATCH/);
}));

test('own backup restore never prunes previous data and refuses foreign paths, links or malformed backup names',()=>sandbox(({root,directory,create})=>{
 const journal=create();journal.initialize(state());journal.append(fill);const first=journal.read(),backup=journal.backup();journal.append(funding);
 assert.deepEqual(journal.restoreBackup(backup),first);assert.equal(journal.read().fundingSeen['period:one'],undefined);
 for(const name of ['../store.json',path.join(root,'store.json'),'backup-123','..\\store.json','recovery-1793232000000-123456abcdef'])assert.throws(()=>journal.restoreBackup(name),/INVALID_BACKUP/);
 assert.ok(files(path.join(directory,'backups')).some(name=>name.startsWith('recovery-')));
 const legacy=path.join(root,'legacy');fs.mkdirSync(legacy);fs.writeFileSync(path.join(legacy,'store.json'),'keep');const linked=path.join(root,'linked');fs.symlinkSync(legacy,linked,'junction');
 assert.throws(()=>new OrangeXPaperJournal({directory:linked}),/UNSAFE_PATH/);
}));

test('backup and recovery directory entries are synchronized before acknowledgement or restore manifest publication',()=>sandbox(({create})=>{
 const descriptors=new Map(),directoryHandles=new Set(),trace=[];let nextDirectoryHandle=-1000;
 const io=new Proxy(fs,{get(target,key){
  // Virtual directory handles exercise the fsync ordering contract on Windows
  // too, where opening a directory for fsync can be unsupported. Real data-file
  // writes/handles/fsyncs still reach the underlying filesystem.
  if(key==='openSync')return (file,...args)=>{
   const directory=fs.existsSync(file)&&fs.statSync(file).isDirectory(),fd=directory?nextDirectoryHandle--:fs.openSync(file,...args);
   if(directory)directoryHandles.add(fd);descriptors.set(fd,String(file));return fd;
  };
  if(key==='closeSync')return fd=>{descriptors.delete(fd);if(directoryHandles.delete(fd))return;return fs.closeSync(fd)};
  if(key==='fsyncSync')return fd=>{trace.push('sync:'+path.basename(descriptors.get(fd)??''));if(directoryHandles.has(fd))return;return fs.fsyncSync(fd)};
  if(key==='copyFileSync')return (source,target,...args)=>{trace.push('copy:'+path.basename(path.dirname(target)));return fs.copyFileSync(source,target,...args)};
  if(key==='renameSync')return (source,target)=>{if(path.basename(target)==='journal-manifest.json')trace.push('publish');return fs.renameSync(source,target)};
  return Reflect.get(target,key);
 }});
 const journal=create({io});journal.initialize(state());journal.append(fill);trace.length=0;
 const backup=journal.backup();assert.ok(trace.includes('sync:'+backup));assert.ok(trace.lastIndexOf('sync:backups')>trace.lastIndexOf('copy:'+backup));
 for(const file of ['journal-manifest.json','genesis.json','journal.jsonl'])assert.ok(trace.includes('sync:'+file),'backup data-file fsync: '+file);
 journal.append(funding);trace.length=0;journal.restoreBackup(backup);
 const recovery=journal.status().lastRestoreBackup,lastCopy=trace.lastIndexOf('copy:'+recovery),published=trace.indexOf('publish');
 assert.ok(lastCopy>=0);assert.ok(trace.indexOf('sync:'+recovery,lastCopy)>lastCopy);
 assert.ok(trace.indexOf('sync:backups',lastCopy)>lastCopy);assert.ok(trace.indexOf('sync:'+recovery,lastCopy)<published);
 assert.ok(trace.indexOf('sync:backups',lastCopy)<published);
}));

test('Windows unsupported directory fsync is explicit and unrelated I/O errors still fail closed',()=>{
 const moduleURL=new URL('../orangex_paper_journal.mjs',import.meta.url).href;
 const traceURL=new URL('../scripts/storage-worker.mjs',import.meta.url).href;
 const source=`import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {OrangeXPaperJournal} from ${JSON.stringify(moduleURL)};
import {traceStorageStage} from ${JSON.stringify(traceURL)};
const trace=(stage,details={})=>traceStorageStage('journal-fsync-child',stage,details);
trace('child.begin');Object.defineProperty(process,'platform',{value:'win32'});const root=fs.mkdtempSync(path.join(os.tmpdir(),'orangex-windows-sync-'));const accepted=[];let refused=false;
try{for(const code of ['EACCES','EPERM','EINVAL','EISDIR','ENOTSUP','ENOSPC']){const directory=path.join(root,code);let j;trace('case.begin',{code});const io=new Proxy(fs,{get(target,key){
if(key==='mkdirSync')return(file,...args)=>{trace('mkdir.begin',{code,requested:String(file)});const first=fs.mkdirSync(file,...args);trace('mkdir.end',{code,requested:String(file),returnedFirst:first??null});return first};
if(key==='openSync')return(file,...args)=>{if(fs.existsSync(file)&&fs.statSync(file).isDirectory()){trace('directory.open.failed',{code,directory:String(file)});throw Object.assign(Error('injected directory fsync error'),{code})}return fs.openSync(file,...args)};
return Reflect.get(target,key)}});
try{trace('initialize.begin',{code});j=new OrangeXPaperJournal({directory,io});j.initialize(${JSON.stringify(state())});trace('initialize.end',{code});
trace('append.begin',{code});j.append(${JSON.stringify(fill)});trace('append.end',{code});trace('backup.begin',{code});const backup=j.backup();trace('backup.end',{code});
trace('restore.begin',{code});j.restoreBackup(backup);trace('restore.end',{code});if(j.read().closed.length!==1)throw Error('lost trade');accepted.push(code)}
catch(error){trace('case.error',{code,errorCode:error.code??error.name});if(code!=='ENOSPC'||error.code!=='ENOSPC')throw error;refused=true}
finally{trace('close.begin',{code});j?.close();trace('close.end',{code});trace('case.end',{code})}}
console.log(JSON.stringify({accepted,refused}));trace('child.end')}
finally{trace('cleanup.begin');fs.rmSync(root,{recursive:true,force:true,maxRetries:8,retryDelay:100});trace('cleanup.end')}`;
 const env={PATH:process.env.PATH,...(process.env.SystemRoot?{SystemRoot:process.env.SystemRoot}:{})};
 // Keep the same OS temp directory selectors; only the parent-owned diagnostic
 // selector is forwarded beyond those. No account or user-store settings.
 for(const key of ['TEMP','TMP','TMPDIR','SIGNAL_LAB_TEST_TRACE_FILE'])if(typeof process.env[key]==='string')env[key]=process.env[key];
 trace('spawnSync.begin',{case:'windows-directory-fsync',timeoutMs:10000});
 const child=spawnSync(process.execPath,['--input-type=module','-e',source],{encoding:'utf8',timeout:10000,killSignal:'SIGKILL',windowsHide:true,
  env});
 trace('spawnSync.end',{case:'windows-directory-fsync',exitCode:child.status,signal:child.signal??null,errorCode:child.error?.code??null});
 assert.equal(child.error,undefined,child.error?.message);assert.equal(child.status,0,child.stderr);assert.deepEqual(JSON.parse(child.stdout),{accepted:['EACCES','EPERM','EINVAL','EISDIR','ENOTSUP'],refused:true});
});

test('ten thousand retained records do not require a full-history journal record for a small state update',()=>sandbox(({directory,create})=>{
 const initial=state({closed:Array.from({length:10001},(_,index)=>({key:'synthetic-'+index,quantity:.125,realizedPnLUSD:index%2?-.25:.5}))});
 const journal=create();journal.initialize(initial);journal.append({id:'small',ops:[{op:'set',path:['updatedAt'],value:NOW}]});
 assert.ok(fs.statSync(path.join(directory,'journal.jsonl')).size<512);assert.equal(journal.read().closed.length,10001);
 journal.checkpoint();journal.close();const resumed=create();assert.equal(resumed.read().updatedAt,NOW);assert.equal(resumed.read().closed.length,10001);
}));

test('the live state budget is enforced before durable ACK and exact byte accounting survives edits, rollback and replay',()=>sandbox(({directory,create})=>{
 const journal=create({maxStateBytes:8192});journal.initialize(state());const file=path.join(directory,'journal.jsonl');
 const check=()=>assert.equal(journal.inspect().stateBytes,Buffer.byteLength(JSON.stringify(journal.read())));
 journal.append({id:'unicode',ops:[{op:'set',path:['settings','한글'],value:'크기 ✅'},
  {op:'append',path:['events'],value:{type:'size',value:'quoted "text"'}}]});check();
 const before=journal.read(),bytes=fs.readFileSync(file),head=journal.inspect();
 assert.throws(()=>journal.append({id:'oversized',ops:[{op:'set',path:['updatedAt'],value:NOW},
  {op:'set',path:['settings','large'],value:'x'.repeat(20000)}]}),/STATE_TOO_LARGE/);
 assert.deepEqual(journal.read(),before);assert.ok(fs.readFileSync(file).equals(bytes));assert.deepEqual(journal.inspect(),head);
 journal.append({id:'shrink',ops:[{op:'delete',path:['settings','한글']},{op:'set',path:['events','0'],value:{type:'smaller'}}]});check();
 journal.close();const recovered=create({maxStateBytes:8192});assert.equal(recovered.read().events[0].type,'smaller');
 assert.equal(recovered.inspect().stateBytes,Buffer.byteLength(JSON.stringify(recovered.read())));recovered.checkpoint();
}));

test('a killed writer after durable ACK recovers its PID lock and does not apply acknowledged fill or funding again',{timeout:10000},async(t)=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'orangex-journal-kill-')),directory=path.join(root,'experiment'),moduleURL=new URL('../orangex_paper_journal.mjs',import.meta.url).href;
 const source=`import {OrangeXPaperJournal} from ${JSON.stringify(moduleURL)};const j=new OrangeXPaperJournal({directory:process.argv[1]});j.initialize(${JSON.stringify(state())});j.append(${JSON.stringify(fill)});j.append(${JSON.stringify(funding)});console.log('DURABLE_ACK');setInterval(()=>{},1000);`;
 const child=spawn(process.execPath,['--input-type=module','-e',source,directory],{stdio:['ignore','pipe','pipe'],windowsHide:true});let journal;
 try{
  trace('writer.ack-kill-close.begin',{childPid:child.pid});
  await killAcknowledgedJournalWriter(child,{signal:t.signal});
  trace('writer.ack-kill-close.end',{childPid:child.pid});
  trace('writer.recovery.begin');
  journal=new OrangeXPaperJournal({directory});assert.equal(journal.read().closed[0].realizedPnLUSD,2.375);
  assert.equal(journal.append(fill).duplicate,true);assert.equal(journal.append(funding).duplicate,true);assert.equal(journal.inspect().seq,2);assert.equal(journal.read().closed.length,1);
  trace('writer.recovery.end');
 }finally{trace('writer.cleanup.begin');journal?.close();fs.rmSync(root,{recursive:true,force:true,maxRetries:8,retryDelay:100});trace('writer.cleanup.end')}
});
