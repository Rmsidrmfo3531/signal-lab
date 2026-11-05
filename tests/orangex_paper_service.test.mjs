import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {OrangeXPaperService} from '../orangex_paper_service.mjs';
import {OrangeXPaperStore} from '../orangex_paper_store.mjs';
import {runOrangeXPaperScenario,offlineOptions} from '../scripts/orangex-paper-offline.mjs';
import {nativePaperSignal,syntheticSettings,syntheticContract,syntheticBook,paperScenario} from './fixtures/orangex_paper_scenario.mjs';

test('offline native scanner LONG profit and SHORT stop loss persist independently through CLOSE and restart',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'orangex-paper-native-')),directory=path.join(root,'orangex-paper');
 const sentinel=path.join(root,'store.json'),backup=path.join(root,'backups','keep.json');
 await fs.mkdir(path.dirname(backup));await fs.writeFile(sentinel,'existing Signal Lab PNL');await fs.writeFile(backup,'keep existing backup');
 try{
  const scenario=paperScenario(),result=runOrangeXPaperScenario(scenario,{directory});
  const snapshot=result.snapshot;assert.equal(snapshot.closed.length,2);assert.equal(snapshot.open.length,0);
  assert.ok(snapshot.closed[0].realizedPnLUSD>0);assert.ok(snapshot.closed[1].realizedPnLUSD<0);
  assert.deepEqual(snapshot.closed[0].exitParts.map(part=>part.type),['TP1','TP2','TP3']);
  assert.equal(snapshot.closed[1].closeReason,'STOP');assert.equal(snapshot.summary.feesUSD>0,true);
  const persisted=new OrangeXPaperStore({directory});
  try{
   assert.ok(snapshot.closed.every(position=>position.recovered===false),'this view was generated before restarting the engine');
   const stored=persisted.read().closed;
   assert.ok(stored.every(position=>!Object.hasOwn(position,'recovered')),'recovery is a view flag, not a stored accounting mutation');
   assert.deepEqual(stored,snapshot.closed.map(({unrealizedPnLUSD,valuationStale,fundingComplete,settlementStatus,netPnLComplete,recovered,...position})=>position));
  }
  finally{persisted.close()}
  const restored=new OrangeXPaperService({directory,now:()=>scenario.events.at(-1).at});
  try{
   assert.equal(restored.snapshot().closed.length,2);assert.equal(restored.snapshot().summary.realizedPnLUSD,snapshot.summary.realizedPnLUSD);
   assert.equal(restored.snapshot().realDataAutoEntryEnabled,false);assert.equal(restored.snapshot().storage.readOnly,true);
  }finally{restored.close()}
  assert.throws(()=>runOrangeXPaperScenario(scenario,{directory}),/ALREADY_EXIST/);
  assert.equal(await fs.readFile(sentinel,'utf8'),'existing Signal Lab PNL');assert.equal(await fs.readFile(backup,'utf8'),'keep existing backup');
 }finally{await fs.rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:100})}
});

test('actual scanner input is observable but never opens or writes an OrangeX PAPER store',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'orangex-paper-real-block-')),directory=path.join(root,'orangex-paper');
 const service=new OrangeXPaperService({directory});
 try{
  const row=nativePaperSignal(),outcome=service.observeSignal(row,{instrumentName:syntheticContract.instrumentName});
  assert.equal(outcome.accepted,false);assert.equal(outcome.normalization.ok,true);
  assert.equal(service.snapshot().recordStatus,'UNCONFIGURED');assert.equal(service.snapshot().pending.length,0);
  assert.equal(service.snapshot().rejections[0].reason,'REAL_DATA_AUTO_ENTRY_DISABLED');
  assert.throws(()=>service.configure(syntheticSettings),/WRITER_UNAVAILABLE/);
  assert.equal((await fs.readdir(root)).length,0);
 }finally{service.close();await fs.rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:100})}
});

test('restart resumes a live synthetic position and closes only on a fresh forward book after a gap',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'orangex-paper-resume-')),directory=path.join(root,'orangex-paper');
 let now=Date.now()+10;let service=new OrangeXPaperService({directory,now:()=>now,writable:true});
 try{
  service.configure(syntheticSettings);service.setContract(syntheticContract);
  const signal=nativePaperSignal();now=Math.max(now,Date.now()+1);
  assert.equal(service.submitSignal(signal,{dataSource:'SYNTHETIC_FIXTURE'}),true);
  now+=10;service.onMarket(syntheticBook(now,102.19,102.2));assert.equal(service.snapshot().open.length,1);service.close();
  now+=120000;service=new OrangeXPaperService({directory,now:()=>now,writable:true});
  assert.equal(service.snapshot().open.length,1);assert.equal(service.snapshot().summary.valuationStale,true);
  service.onMarket(syntheticBook(now-120000,90));assert.equal(service.snapshot().closed.length,0);
  now++;service.onMarket(syntheticBook(now,90));assert.equal(service.snapshot().open.length,0);
  assert.equal(service.snapshot().closed[0].exitParts[0].price,90);assert.equal(service.snapshot().closed[0].closeReason,'STOP');
 }finally{service.close();await fs.rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:100})}
});

test('unavailable or corrupted OrangeX records are preserved and never reinitialized by a dashboard read',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'orangex-paper-corrupt-')),file=path.join(root,'orangex-paper.json');
 await fs.writeFile(file,'invalid original record');const service=new OrangeXPaperService({directory:root});
 try{const s=service.snapshot();assert.equal(s.recordsUnavailable,true);assert.equal(s.summary,null);assert.equal(s.storage.healthy,false);
  assert.equal(await fs.readFile(file,'utf8'),'invalid original record');assert.deepEqual(await fs.readdir(root),['orangex-paper.json']);
 }finally{service.close();await fs.rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:100})}
});

test('offline CLI options require an explicit scenario and separate data directory, and actual-data events are refused',()=>{
 assert.deepEqual(offlineOptions(['--scenario','fixture.json','--data-dir','temporary/orangex-paper']),{resume:false,scenarioFile:'fixture.json',directory:'temporary/orangex-paper'});
 for(const args of [[],['--data-dir','somewhere'],['--mode','LIVE'],['--scenario','a','--data-dir','b','--resume','--resume']])
  assert.throws(()=>offlineOptions(args));
 const scenario=paperScenario();scenario.events[1].market.dataSource='REAL_PUBLIC_READ_ONLY';
 assert.throws(()=>runOrangeXPaperScenario(scenario,{directory:'/tmp/unused-orangex-paper'}),/ACTUAL_DATA_INPUT_DISABLED/);
});

test('standalone offline CLI writes only its explicit directory and refuses implicit overwrite without loading application settings',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'orangex-paper-cli-')),scenarioFile=path.join(root,'synthetic.json'),directory=path.join(root,'orangex-paper');
 await fs.writeFile(scenarioFile,JSON.stringify(paperScenario()));
 const run=()=>spawnSync(process.execPath,[fileURLToPath(new URL('../scripts/orangex-paper-offline.mjs',import.meta.url)),
  '--scenario',scenarioFile,'--data-dir',directory],{encoding:'utf8',timeout:15000,killSignal:'SIGKILL',env:{PATH:process.env.PATH,...(process.env.SystemRoot?{SystemRoot:process.env.SystemRoot}:{})}});
 try{
  const first=run();assert.equal(first.error,undefined);assert.equal(first.status,0,first.stderr);const result=JSON.parse(first.stdout);
  assert.equal(result.snapshot.closed.length,2);assert.equal(result.mode,'PAPER_OFFLINE');
  assert.equal(result.realDataAutoEntryEnabled,false);assert.equal(result.liveOrdersEnabled,false);
  const file=path.join(directory,'orangex-paper.json'),before=await fs.readFile(file,'utf8');
  const repeated=run();assert.equal(repeated.error,undefined);assert.equal(repeated.status,1);assert.equal(await fs.readFile(file,'utf8'),before);
  assert.equal((await fs.readdir(directory)).includes('orangex-paper.lock'),false,'writer lock handle is released after exit');
 }finally{await fs.rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:100})}
});
