import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import {resolveDataDir,prepareData,atomicWriteStore,readStore,backupStore,importLegacy,acquireDataLock,isLocked} from '../persistence.mjs';
const work=()=>fs.mkdtempSync(path.join(os.tmpdir(),'signal-persist-'));
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
