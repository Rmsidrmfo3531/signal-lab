import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {resolveDataDir,prepareData,atomicWriteStore,readStore,backupStore,restoreStore,importLegacy,acquireDataLock,isLocked} from '../persistence.mjs';
const work=()=>fs.mkdtempSync(path.join(os.tmpdir(),'signal-persist-'));
const cli=fileURLToPath(new URL('../data-cli.mjs',import.meta.url));
const restoreCLI=(dir,backup)=>{const child=spawnSync(process.execPath,[cli,'restore',backup],{env:{PATH:process.env.PATH,SIGNAL_LAB_DATA_DIR:dir},encoding:'utf8',timeout:15000,killSignal:'SIGKILL'});assert.equal(child.error,undefined);return child};
const fixture=(id='p1')=>({journal:[{id:'manual'}],paper:{pending:[],open:[{key:id,entryFill:100}],closed:[{key:'old',realizedPnLUSD:7.5}],skipped:[],seen:{x:42}},alerts:[{id:'a'}],watchlist:['BTCUSDT']});
test('Windows user data directory is stable across extracted version paths',()=>{
 const a=resolveDataDir({platform:'win32',home:'C:\\Users\\tester',env:{LOCALAPPDATA:'C:\\Users\\tester\\AppData\\Local'}});
 const b=resolveDataDir({platform:'win32',home:'C:\\Users\\tester',env:{LOCALAPPDATA:'C:\\Users\\tester\\AppData\\Local'}});
 assert.equal(a,b);assert.match(a,/SignalLab$/);
});
test('first migration then newer app version sees same paper PNL and settings',()=>{
 const sandbox=work();try{
  const v1=path.join(sandbox,'v5.1'),v2=path.join(sandbox,'v5.2'),dir=path.join(sandbox,'shared');
  fs.mkdirSync(v1);fs.mkdirSync(v2);
  fs.writeFileSync(path.join(v1,'store.json'),JSON.stringify(fixture()));
  fs.writeFileSync(path.join(v1,'.env'),'TELEGRAM_CHAT_ID=123456');
  const a=prepareData(v1,{env:{SIGNAL_LAB_DATA_DIR:dir}});
  assert.equal(a.migratedStore,true);assert.equal(a.migratedEnv,true);
  const b=prepareData(v2,{env:{SIGNAL_LAB_DATA_DIR:dir}});
  assert.equal(b.migratedStore,false);
  assert.equal(readStore(b.storePath).paper.closed[0].realizedPnLUSD,7.5);
  assert.equal(readStore(b.storePath).paper.open[0].key,'p1');
  assert.match(fs.readFileSync(b.envPath,'utf8'),/TELEGRAM_CHAT_ID=123456/);
  const record=readStore(b.storePath);record.paper.closed.push({key:'new',realizedPnLUSD:-2});
  atomicWriteStore(b.storePath,record);
  assert.equal(readStore(a.storePath).paper.closed.length,2);
 }finally{fs.rmSync(sandbox,{recursive:true,force:true})}
});
test('backup and restore preserve pending/open/closed and crash-corrupted file cannot be silently reset',()=>{
 const sandbox=work();try{
  const file=path.join(sandbox,'store.json');atomicWriteStore(file,fixture());
  const backup=backupStore(file);assert.ok(fs.existsSync(backup));
  fs.writeFileSync(file,'bad JSON');
  assert.throws(()=>readStore(file),/자동으로 초기화하지 않습니다/);
  atomicWriteStore(file,readStore(backup));
  assert.equal(readStore(file).paper.open.length,1);
 }finally{fs.rmSync(sandbox,{recursive:true,force:true})}
});
test('shared records remain authoritative when unused legacy copy is corrupted',()=>{
 const sandbox=work();try{
  const dir=path.join(sandbox,'shared'),app=path.join(sandbox,'release');fs.mkdirSync(dir);fs.mkdirSync(app);
  const current=path.join(dir,'store.json');atomicWriteStore(current,fixture('shared-position'));
  const before=fs.readFileSync(current);fs.writeFileSync(path.join(app,'store.json'),'damaged unused legacy');
  const prepared=prepareData(app,{env:{SIGNAL_LAB_DATA_DIR:dir}});
  assert.equal(prepared.migratedStore,false);assert.ok(fs.readFileSync(current).equals(before));
  assert.equal(readStore(current).paper.open[0].key,'shared-position');
 }finally{fs.rmSync(sandbox,{recursive:true,force:true})}
});
test('corrupt authoritative shared records are never replaced by a legacy copy',()=>{
 const sandbox=work();try{
  const dir=path.join(sandbox,'shared'),app=path.join(sandbox,'release');fs.mkdirSync(dir);fs.mkdirSync(app);
  const current=path.join(dir,'store.json');fs.writeFileSync(current,'damaged shared record');
  atomicWriteStore(path.join(app,'store.json'),fixture('legacy'));
  assert.throws(()=>prepareData(app,{env:{SIGNAL_LAB_DATA_DIR:dir}}),/자동으로 초기화하지 않습니다/);
  assert.equal(fs.readFileSync(current,'utf8'),'damaged shared record');
 }finally{fs.rmSync(sandbox,{recursive:true,force:true})}
});
test('restore CLI recovers corrupt current JSON and preserves its exact original bytes',()=>{
 const sandbox=work();try{
  const dir=path.join(sandbox,'shared');fs.mkdirSync(dir);
  const current=path.join(dir,'store.json'),backup=path.join(sandbox,'good-backup.json');
  const record=fixture('continued-position');record.paper.pending.push({key:'pending'});atomicWriteStore(backup,record);
  const damaged=Buffer.from([0xef,0xbb,0xbf,0x7b,0x00,0xff,0x0a]);fs.writeFileSync(current,damaged);
  const result=restoreCLI(dir,backup);assert.equal(result.status,0,result.stderr);
  assert.deepEqual(readStore(current),record);assert.deepEqual(readStore(backup),record);
  const recovered=fs.readdirSync(path.join(dir,'recovery'));assert.equal(recovered.length,1);
  assert.ok(fs.readFileSync(path.join(dir,'recovery',recovered[0])).equals(damaged));
  assert.equal(isLocked(dir),false);
 }finally{fs.rmSync(sandbox,{recursive:true,force:true})}
});
test('restore CLI rejects an invalid backup without changing current records',()=>{
 const sandbox=work();try{
  const current=path.join(sandbox,'store.json'),backup=path.join(sandbox,'bad-backup.json');
  atomicWriteStore(current,fixture());const before=fs.readFileSync(current);fs.writeFileSync(backup,'bad backup');
  const result=restoreCLI(sandbox,backup);assert.equal(result.status,1);
  assert.ok(fs.readFileSync(current).equals(before));assert.equal(fs.existsSync(path.join(sandbox,'recovery')),false);
  assert.equal(isLocked(sandbox),false);
 }finally{fs.rmSync(sandbox,{recursive:true,force:true})}
});
test('restore CLI keeps the running-server lock and never overwrites its records',()=>{
 const sandbox=work();let release;try{
  const current=path.join(sandbox,'store.json'),backup=path.join(sandbox,'good-backup.json');
  atomicWriteStore(current,fixture('running'));atomicWriteStore(backup,fixture('incoming'));release=acquireDataLock(sandbox);
  const before=fs.readFileSync(current),result=restoreCLI(sandbox,backup);
  assert.equal(result.status,1);assert.match(result.stderr,/서버를 종료/);
  assert.ok(fs.readFileSync(current).equals(before));assert.equal(isLocked(sandbox),true);
 }finally{release?.();fs.rmSync(sandbox,{recursive:true,force:true})}
});
test('restoring over healthy data first backs up every existing record',()=>{
 const sandbox=work();try{
  const current=path.join(sandbox,'store.json'),backup=path.join(sandbox,'incoming.json');
  const old=fixture('old-open'),incoming=fixture('new-open');atomicWriteStore(current,old);atomicWriteStore(backup,incoming);
  const result=restoreStore(backup,sandbox);
  assert.deepEqual(readStore(result.previous),old);assert.deepEqual(readStore(current),incoming);
  assert.equal(result.preservedCorrupt,null);assert.equal(isLocked(sandbox),false);
 }finally{fs.rmSync(sandbox,{recursive:true,force:true})}
});
test('failed restore swap preserves corrupt bytes, reports the failure, and releases its lock',()=>{
 const sandbox=work(),originalRename=fs.renameSync;try{
  const current=path.join(sandbox,'store.json'),backup=path.join(sandbox,'incoming.json');
  atomicWriteStore(backup,fixture());fs.writeFileSync(current,'damaged-current');
  fs.renameSync=(from,to)=>{if(to===current)throw Object.assign(Error('simulated disk failure'),{code:'EIO'});return originalRename(from,to)};
  assert.throws(()=>restoreStore(backup,sandbox),/simulated disk failure/);
  assert.equal(fs.readFileSync(current,'utf8'),'damaged-current');
  const preserved=fs.readdirSync(path.join(sandbox,'recovery'));assert.equal(preserved.length,1);
  assert.equal(fs.readFileSync(path.join(sandbox,'recovery',preserved[0]),'utf8'),'damaged-current');
  assert.equal(isLocked(sandbox),false);assert.equal(fs.readdirSync(sandbox).some(n=>n.includes('.tmp-')),false);
 }finally{fs.renameSync=originalRename;fs.rmSync(sandbox,{recursive:true,force:true})}
});
test('explicit legacy import backs up existing empty shared store, blocks overwrite of existing paper trades',()=>{
 const sandbox=work();try{
  const old=path.join(sandbox,'old'),dir=path.join(sandbox,'shared');fs.mkdirSync(old);fs.mkdirSync(dir);
  fs.writeFileSync(path.join(old,'store.json'),JSON.stringify(fixture('legacy')));
  atomicWriteStore(path.join(dir,'store.json'),{watchlist:['SOLUSDT'],paper:{open:[],closed:[],pending:[]}});
  const result=importLegacy(old,dir);assert.ok(result.backup);assert.ok(fs.existsSync(result.backup));
  assert.equal(result.recordCounts.paperOpen,1);
  assert.throws(()=>importLegacy(old,dir),/덮어쓰지 않았습니다/);
  assert.equal(readStore(path.join(dir,'store.json')).paper.open[0].key,'legacy');
 }finally{fs.rmSync(sandbox,{recursive:true,force:true})}
});
test('single writer lock prevents two versions modifying the same store',()=>{
 const sandbox=work();try{
  const release=acquireDataLock(sandbox);assert.equal(isLocked(sandbox),true);
  assert.throws(()=>acquireDataLock(sandbox),/다른 Signal Lab/);
  release();assert.equal(isLocked(sandbox),false);
 }finally{fs.rmSync(sandbox,{recursive:true,force:true})}
});


test('more than 500 historical closed simulations are never discarded on reload',async()=>{
 const {PaperEngine}=await import('../paper.mjs');
 const initial={pending:[],open:[],closed:Array.from({length:650},(_,i)=>({key:'t'+i,realizedPnLUSD:1,feesUSD:0,closedAt:Date.now()-1000000+i*100})),skipped:[],seen:{}};
 const engine=new PaperEngine(initial);
 assert.equal(engine.snapshot().closedCount,650);
 assert.equal(engine.snapshot().netRealizedUSD,650);
 assert.equal(engine.snapshot().closed.length,200,'small UI page only');
});
test('store data is flushed to disk before the atomic rename replaces store.json',()=>{
 // rename() alone is atomic but not durable: after a power cut the new file can be
 // empty. The temporary file must be fsynced first, then the directory where possible.
 const sandbox=work(),file=path.join(sandbox,'store.json'),events=[],names=new Map();
 const original={openSync:fs.openSync,fsyncSync:fs.fsyncSync,renameSync:fs.renameSync,closeSync:fs.closeSync};
 fs.openSync=(target,...rest)=>{const fd=original.openSync(target,...rest);names.set(fd,String(target));return fd};
 fs.closeSync=fd=>{names.delete(fd);return original.closeSync(fd)};
 fs.fsyncSync=fd=>{events.push(['fsync',names.get(fd)]);return original.fsyncSync(fd)};
 fs.renameSync=(from,to)=>{events.push(['rename',String(from),String(to)]);return original.renameSync(from,to)};
 try{
  atomicWriteStore(file,fixture('durable'));
 }finally{Object.assign(fs,original)}
 try{
  const rename=events.findIndex(([kind])=>kind==='rename');
  assert.ok(rename>=0,'store was replaced by rename');
  const temp=events[rename][1];
  assert.ok(events.slice(0,rename).some(([kind,name])=>kind==='fsync'&&name===temp),'temporary file fsynced before rename');
  assert.equal(readStore(file).paper.open[0].key,'durable');
  assert.deepEqual(fs.readdirSync(sandbox),['store.json'],'no temporary file left behind');
 }finally{fs.rmSync(sandbox,{recursive:true,force:true})}
});

test('a lock from another PC (shared OneDrive folder) holds while its heartbeat is fresh',()=>{
 const sandbox=work();try{
  const lock=path.join(sandbox,'server.lock'),now=Date.now();
  fs.writeFileSync(lock,JSON.stringify({pid:999999,host:'other-pc',startedAt:new Date(now-3600000).toISOString(),heartbeatAt:new Date(now-30000).toISOString(),nonce:'x'}));
  assert.equal(isLocked(sandbox,{host:'this-pc',now}),true,'fresh heartbeat from another PC');
  assert.throws(()=>acquireDataLock(sandbox),/other-pc/);
  assert.equal(isLocked(sandbox,{host:'this-pc',now:now+4*60000}),false,'stale after 3 minutes without heartbeat');
  fs.writeFileSync(lock,JSON.stringify({pid:999999,host:'other-pc',startedAt:new Date(now-3600000).toISOString(),heartbeatAt:new Date(now-10*60000).toISOString(),nonce:'x'}));
  const release=acquireDataLock(sandbox),first=JSON.parse(fs.readFileSync(lock,'utf8'));
  assert.equal(first.host,os.hostname());assert.equal(release.heartbeat(),true);
  assert.ok(Date.parse(JSON.parse(fs.readFileSync(lock,'utf8')).heartbeatAt)>=Date.parse(first.heartbeatAt));
  release();assert.equal(fs.existsSync(lock),false);
 }finally{fs.rmSync(sandbox,{recursive:true,force:true})}
});
