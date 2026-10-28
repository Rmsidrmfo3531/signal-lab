import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {OrangeXPaperStore,validateOrangeXPaperState} from '../orangex_paper_store.mjs';

const NOW=Date.parse('2026-10-28T01:00:00.123Z');
const state=(patch={})=>({schemaVersion:1,settings:{capital:1000},contracts:{},pending:[],open:[],closed:[],seen:{},fundingSeen:{},events:[],rejections:[],...patch});
function sandbox(run){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'orangex-paper-store-')),directory=path.join(root,'orangex-paper'),stores=[];
 const create=(options={})=>{const store=new OrangeXPaperStore({directory,now:()=>NOW,...options});stores.push(store);return store};
 try{return run({root,directory,create})}finally{
  for(const store of stores)try{store.close()}catch{}
  fs.rmSync(root,{recursive:true,force:true,maxRetries:8,retryDelay:100});
 }
}
const failure=code=>Object.assign(new Error('injected filesystem failure'),{code});

test('construction and absent reads never create a PAPER directory, lock or reset records',()=>sandbox(({directory,create})=>{
 const store=create();assert.equal(store.read(),null);assert.equal(store.backup(),null);
 assert.equal(store.status().exists,false);assert.equal(store.status().writerLocked,false);assert.equal(fs.existsSync(directory),false);
 store.close();assert.equal(fs.existsSync(directory),false);
}));

test('atomic separate envelope round trips fractional PNL and resumes without touching legacy settings or backup bytes',()=>sandbox(({root,directory,create})=>{
 const sentinel=Buffer.from('personal-records\r\nkeep-exactly');
 for(const file of ['store.json','.env','pnl.json'])fs.writeFileSync(path.join(root,file),sentinel);
 fs.mkdirSync(path.join(root,'backups'));fs.writeFileSync(path.join(root,'backups','store-existing.json'),sentinel);
 const initial=state({open:[{id:'position',qtyRemaining:.375,feesUSD:.123}],closed:[{realizedPnLUSD:-12.375}]});
 const store=create();assert.deepEqual(store.write(initial),initial);
 const disk=JSON.parse(fs.readFileSync(store.file,'utf8'));assert.equal(disk.kind,'ORANGEX_PAPER_OFFLINE');assert.equal(disk.version,1);assert.deepEqual(disk.state,initial);
 const read=store.read();read.closed[0].realizedPnLUSD=999;assert.equal(store.read().closed[0].realizedPnLUSD,-12.375);
 assert.equal(store.status().lastSavedAt,NOW);store.close();
 const restarted=create();assert.deepEqual(restarted.read(),initial);assert.equal(restarted.status().writerLocked,false);
 for(const file of ['store.json','.env','pnl.json','backups/store-existing.json'])assert.ok(fs.readFileSync(path.join(root,file)).equals(sentinel));
 assert.deepEqual(fs.readdirSync(directory),['orangex-paper.json']);
}));

test('unknown versions, malformed collections and non-JSON values cannot initialize or overwrite a store',()=>sandbox(({directory,create})=>{
 const store=create();
 for(const invalid of [null,[],state({schemaVersion:2}),state({open:null}),state({seen:[]}),state({settings:null}),state({contracts:[]}),state({extra:NaN}),state({extra:undefined}),state({extra:()=>1})])
  assert.throws(()=>store.write(invalid),{code:'ORANGEX_PAPER_INVALID_STORE'});
 assert.equal(fs.existsSync(directory),false);
 store.write(state());const original=fs.readFileSync(store.file);
 assert.throws(()=>store.write(state({closed:'bad'})),{code:'ORANGEX_PAPER_INVALID_STORE'});
 assert.ok(fs.readFileSync(store.file).equals(original));
 const circular=state();circular.extra=circular;assert.throws(()=>validateOrangeXPaperState(circular),{code:'ORANGEX_PAPER_INVALID_STORE'});
}));

test('corrupt existing records fail loudly on read and ordinary save without replacement',()=>sandbox(({directory,create})=>{
 fs.mkdirSync(directory);const file=path.join(directory,'orangex-paper.json'),bytes=Buffer.from('{broken-original');fs.writeFileSync(file,bytes);
 const store=create();assert.throws(()=>store.read(),{code:'ORANGEX_PAPER_INVALID_STORE'});
 assert.throws(()=>store.write(state()),{code:'ORANGEX_PAPER_INVALID_STORE'});
 assert.equal(store.status().healthy,false);assert.equal(store.status().lastError,'ORANGEX_PAPER_INVALID_STORE');assert.ok(fs.readFileSync(file).equals(bytes));
}));

test('failed atomic replacement preserves committed records and reports failure instead of successful save',()=>sandbox(({create})=>{
 const initial=create();initial.write(state({closed:[{pnl:7.25}]}));const before=fs.readFileSync(initial.file);initial.close();
 const store=create({io:{...fs,renameSync(){throw failure('EIO')}}});
 assert.throws(()=>store.write(state({closed:[{pnl:88}]})),{code:'EIO'});
 assert.ok(fs.readFileSync(store.file).equals(before));assert.equal(store.status().lastSavedAt,null);assert.equal(store.status().lastError,'EIO');
 assert.ok(fs.readdirSync(store.directory).every(name=>!name.includes('.tmp-')));
}));

test('data fsync failure removes only owned temporary files and never leaves a false writer lock',()=>sandbox(({directory,create})=>{
 const store=create({io:{...fs,fsyncSync(){throw failure('ENOSPC')}}});
 assert.throws(()=>store.write(state()),{code:'ENOSPC'});
 assert.equal(fs.existsSync(store.file),false);assert.equal(fs.existsSync(store.lockFile),false);
 assert.deepEqual(fs.readdirSync(directory),[]);assert.equal(store.status().writerLocked,false);
}));

test('directory fsync failure after replacement atomically restores the previous committed state',()=>sandbox(({create})=>{
 const initial=create();initial.write(state({closed:[{pnl:19.5}]}));const before=fs.readFileSync(initial.file);initial.close();
 let count=0;
 const store=create({io:{...fs,fsyncSync(fd){count++;if(count===4)throw failure('EIO');return fs.fsyncSync(fd)}}});
 // fsync order: lock, new data, previous image, directory after replacement.
 assert.throws(()=>store.write(state({closed:[{pnl:-88}]})),{code:'EIO'});
 assert.ok(fs.readFileSync(store.file).equals(before));assert.equal(store.read().closed[0].pnl,19.5);
 assert.ok(fs.readdirSync(store.directory).every(name=>!name.includes('.tmp-')&&!name.includes('.rollback-')));
 assert.equal(store.status().lastSavedAt,null);assert.equal(store.status().lastError,'EIO');
}));

test('uncertain commit never reports success and retains a recovery image while blocking later automatic writes',()=>sandbox(({create})=>{
 const initial=create();initial.write(state({closed:[{pnl:5.125}]}));const backup=initial.backup(),before=fs.readFileSync(initial.file);initial.close();
 let syncs=0,renames=0;
 const store=create({io:{...fs,fsyncSync(fd){if(++syncs===4)throw failure('EIO');return fs.fsyncSync(fd)},
  renameSync(from,to){if(++renames===2)throw failure('EIO');return fs.renameSync(from,to)}}});
 assert.throws(()=>store.write(state({closed:[{pnl:99}]})),{code:'ORANGEX_PAPER_COMMIT_UNCERTAIN'});
 assert.equal(store.status().healthy,false);assert.equal(store.status().lastSavedAt,null);
 const recovery=fs.readdirSync(store.directory).find(name=>name.includes('.rollback-'));assert.ok(recovery);
 assert.ok(fs.readFileSync(path.join(store.directory,recovery)).equals(before));
 assert.throws(()=>store.write(state()),{code:'ORANGEX_PAPER_COMMIT_UNCERTAIN'});
 assert.equal(store.restoreBackup(backup).closed[0].pnl,5.125);assert.equal(store.status().healthy,true);
 assert.ok(fs.readFileSync(path.join(store.directory,recovery)).equals(before),'uncertain recovery bytes are not silently deleted');
}));

test('only one writer can hold the dedicated lock and closure releases all file handles',()=>sandbox(({create})=>{
 const first=create(),second=create();first.write(state({events:[{id:'first'}]}));
 assert.throws(()=>second.write(state({events:[{id:'second'}]})),{code:'ORANGEX_PAPER_LOCKED'});
 assert.equal(second.read().events[0].id,'first');first.close();
 assert.equal(fs.existsSync(first.lockFile),false);second.write(state({events:[{id:'second'}]}));assert.equal(second.read().events[0].id,'second');
 second.close();assert.equal(fs.existsSync(second.lockFile),false);
 assert.throws(()=>second.write(state()),{code:'ORANGEX_PAPER_STORE_CLOSED'});
}));

test('lost lock ownership blocks subsequent saves and close never removes another owner lock',()=>sandbox(({create})=>{
 const store=create();store.write(state());const altered=JSON.stringify({kind:'ORANGEX_PAPER_OFFLINE',pid:process.pid,nonce:'other-owner'});
 fs.writeFileSync(store.lockFile,altered);
 assert.throws(()=>store.write(state({events:[{id:'must-not-save'}]})),{code:'ORANGEX_PAPER_LOCKED'});
 assert.deepEqual(store.read().events,[]);store.close();assert.equal(fs.readFileSync(store.lockFile,'utf8'),altered);
}));

test('malformed locks are not deleted while a demonstrably exited process lock is safely recovered',()=>sandbox(({directory,create})=>{
 fs.mkdirSync(directory);const file=path.join(directory,'orangex-paper.lock');fs.writeFileSync(file,'broken-lock');
 const store=create();assert.throws(()=>store.write(state()),{code:'ORANGEX_PAPER_LOCKED'});assert.equal(fs.readFileSync(file,'utf8'),'broken-lock');
 const child=spawnSync(process.execPath,['-e','process.stdout.write(String(process.pid))'],{encoding:'utf8',windowsHide:true});assert.equal(child.status,0);
 fs.writeFileSync(file,JSON.stringify({kind:'ORANGEX_PAPER_OFFLINE',pid:Number(child.stdout),nonce:'exited-process'}));
 store.write(state({events:[{id:'recovered'}]}));assert.equal(store.read().events[0].id,'recovered');
}));

test('explicit backup and restore preserve the previous valid state without pruning old backups',()=>sandbox(({create})=>{
 const store=create(),first=state({closed:[{id:'first',pnl:12.5}]}),second=state({closed:[{id:'second',pnl:-3.25}]});
 store.write(first);const name=store.backup();assert.match(name,/^orangex-paper-/);assert.equal(path.basename(name),name);
 store.write(second);assert.deepEqual(store.restoreBackup(name),first);assert.deepEqual(store.read(),first);
 const preserved=store.status().lastRestoreBackup;assert.match(preserved,/^orangex-paper-before-restore-/);
 assert.deepEqual(JSON.parse(fs.readFileSync(path.join(store.backupDirectory,preserved),'utf8')).state,second);
 assert.equal(fs.readdirSync(store.backupDirectory).length,2);
}));

test('explicit recovery preserves corrupt original bytes before restoring a validated own backup',()=>sandbox(({create})=>{
 const store=create();store.write(state({closed:[{id:'recover-me'}]}));const name=store.backup();const corrupt=Buffer.from('{exact-broken\r\n');fs.writeFileSync(store.file,corrupt);
 assert.throws(()=>store.read(),{code:'ORANGEX_PAPER_INVALID_STORE'});
 assert.equal(store.restoreBackup(name).closed[0].id,'recover-me');const preserved=store.status().lastRestoreBackup;
 assert.match(preserved,/^orangex-paper-recovery-/);assert.ok(fs.readFileSync(path.join(store.backupDirectory,preserved)).equals(corrupt));
}));

test('backup traversal, foreign store paths and corrupt backups cannot alter committed PNL',()=>sandbox(({root,create})=>{
 const store=create();store.write(state({closed:[{pnl:4.25}]}));const before=fs.readFileSync(store.file),name=store.backup();
 for(const invalid of ['../store.json',path.join(root,'store.json'),'store.json','..\\store.json','orangex-paper.json',name+'/../../store.json'])
  assert.throws(()=>store.restoreBackup(invalid),{code:'ORANGEX_PAPER_UNSAFE_PATH'});
 fs.writeFileSync(path.join(store.backupDirectory,name),'{}');assert.throws(()=>store.restoreBackup(name),{code:'ORANGEX_PAPER_INVALID_STORE'});
 assert.ok(fs.readFileSync(store.file).equals(before));
}));

test('directory links and hard-linked store files cannot redirect writes into legacy records',()=>sandbox(({root,directory,create})=>{
 const legacy=path.join(root,'legacy');fs.mkdirSync(legacy);const sentinel=path.join(legacy,'store.json');fs.writeFileSync(sentinel,'legacy-pnl-preserved');
 fs.symlinkSync(legacy,directory,'junction');assert.throws(()=>create(),{code:'ORANGEX_PAPER_UNSAFE_PATH'});fs.unlinkSync(directory);
 fs.mkdirSync(directory);fs.linkSync(sentinel,path.join(directory,'orangex-paper.json'));
 const store=create();assert.throws(()=>store.read(),{code:'ORANGEX_PAPER_UNSAFE_PATH'});assert.throws(()=>store.write(state()),{code:'ORANGEX_PAPER_UNSAFE_PATH'});
 assert.equal(fs.readFileSync(sentinel,'utf8'),'legacy-pnl-preserved');
}));
