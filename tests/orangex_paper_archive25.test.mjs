import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {OrangeXPaperReplayStore} from '../orangex_paper_replay_store.mjs';
import {OrangeXPaperStore} from '../orangex_paper_store.mjs';
import {OrangeXPaperService} from '../orangex_paper_service.mjs';
import {replayReport,replayOptions} from '../scripts/orangex-paper-replay.mjs';
import {runOrangeXPaperScenario} from '../scripts/orangex-paper-offline.mjs';
import {syntheticReplayInput} from './fixtures/orangex_paper_replay.mjs';
import {paperScenario} from './fixtures/orangex_paper_scenario.mjs';

test('reading absent replay archives creates no files or locks',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'orangex-replay-absent-'));
 try{const store=new OrangeXPaperReplayStore({directory:path.join(root,'replays')});
  assert.equal(store.read(),null);assert.equal(store.snapshot().status,'UNOBSERVED');assert.deepEqual(await fs.readdir(root),[]);
 }finally{await fs.rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:100})}
});

test('BACKTEST results are saved separately and never merge with FORWARD_PAPER PNL or overwrite an experiment',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'orangex-replay-isolation-')),directory=path.join(root,'replays');
 try{
  const forward=runOrangeXPaperScenario(paperScenario(),{directory:path.join(root,'orangex-paper')}),
   original=await fs.readFile(path.join(root,'orangex-paper','orangex-paper.json'),'utf8');
  const result=replayReport(syntheticReplayInput({complete:true}),{directory}),store=new OrangeXPaperReplayStore({directory});
  assert.equal(result.runKind,'BACKTEST');assert.equal(result.performance.runKind,'BACKTEST');assert.equal(result.accountingAudit.valid,true);
  assert.equal(result.snapshot.closed.length,1);assert.equal(forward.snapshot.closed.length,2);
  assert.deepEqual(store.read(),result);assert.equal(store.snapshot().status,'OBSERVED');
  assert.equal(store.snapshot().result.analyses,undefined,'dashboard response is bounded without deleting the archived analyses');
  assert.throws(()=>store.write(result),/ALREADY_EXISTS/);assert.deepEqual(store.read(),result);
  assert.equal(await fs.readFile(path.join(root,'orangex-paper','orangex-paper.json'),'utf8'),original);
  assert.deepEqual((await fs.readdir(directory)).sort(),['orangex-replay.json']);
 }finally{await fs.rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:100})}
});

test('historical candle-only analysis remains without fills, PNL or a forward ledger',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'orangex-historical-'));
 try{
  const input=syntheticReplayInput();input.executionMode='HISTORICAL_REPLAY';input.dataSource='USER_SUPPLIED_HISTORICAL';input.markets=[];
  const result=replayReport(input,{directory:path.join(root,'replays')});
  assert.equal(result.snapshot,null);assert.equal(result.performance,null);assert.equal(result.summary.trades,0);
  assert.equal(result.fillAccuracy,'UNVERIFIED_NO_HISTORICAL_DEPTH');assert.equal(result.realDataAutoEntryEnabled,false);
  assert.deepEqual(await fs.readdir(root),['replays']);
  const store=new OrangeXPaperReplayStore({directory:path.join(root,'another')});
  assert.throws(()=>store.write({...result,snapshot:{closed:[{}]}}),/HISTORICAL_FILLS_DISABLED/);
 }finally{await fs.rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:100})}
});

test('corrupt and linked replay files are preserved instead of becoming zero-result archives',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'orangex-replay-corrupt-')),directory=path.join(root,'replays');await fs.mkdir(directory);
 try{
  const store=new OrangeXPaperReplayStore({directory}),file=path.join(directory,'orangex-replay.json');await fs.writeFile(file,'original corrupt report');
  assert.equal(store.snapshot().status,'ERROR');assert.equal(store.snapshot().result,null);
  assert.throws(()=>store.write(replayReport(syntheticReplayInput())),/ALREADY_EXISTS/);
  assert.equal(await fs.readFile(file,'utf8'),'original corrupt report');
  await fs.unlink(file);const sentinel=path.join(root,'store.json');await fs.writeFile(sentinel,'existing PNL');await fs.link(sentinel,file);
  assert.throws(()=>store.read(),/UNSAFE_REPLAY_FILE/);assert.throws(()=>store.write(replayReport(syntheticReplayInput())),/UNSAFE_REPLAY_FILE/);
  assert.equal(await fs.readFile(sentinel,'utf8'),'existing PNL');
 }finally{await fs.rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:100})}
});

test('CLI requires explicit input and keeps run mode provenance and immutable archive policy',async()=>{
 assert.deepEqual(replayOptions(['--input','a.json','--output-dir','new']),{inputFile:'a.json',directory:'new'});
 for(const args of [[],['--mode','LIVE'],['--input','a','--input','b']])assert.throws(()=>replayOptions(args));
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'orangex-replay-cli-')),inputFile=path.join(root,'input.json'),directory=path.join(root,'replays');
 try{
  await fs.writeFile(inputFile,JSON.stringify(syntheticReplayInput({complete:true})));
  const args=[fileURLToPath(new URL('../scripts/orangex-paper-replay.mjs',import.meta.url)),'--input',inputFile,'--output-dir',directory],
   env={PATH:process.env.PATH,...(process.env.SystemRoot?{SystemRoot:process.env.SystemRoot}:{})},
   first=spawnSync(process.execPath,args,{encoding:'utf8',env,timeout:15000,killSignal:'SIGKILL'});
  assert.equal(first.error,undefined);assert.equal(first.status,0,first.stderr);const value=JSON.parse(first.stdout);assert.equal(value.runKind,'BACKTEST');
  assert.equal(value.snapshot.executionMode,'SYNTHETIC_TEST');assert.equal(value.performance.realMarketPerformanceVerified,false);
  const original=await fs.readFile(path.join(directory,'orangex-replay.json'),'utf8');
  const repeated=spawnSync(process.execPath,args,{encoding:'utf8',env,timeout:15000,killSignal:'SIGKILL'});
  assert.equal(repeated.error,undefined);assert.equal(repeated.status,1);
  assert.equal(await fs.readFile(path.join(directory,'orangex-replay.json'),'utf8'),original);
 }finally{await fs.rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:100})}
});

test('consistent-looking tampered fees fail independent audit and block further writes without destroying the ledger',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'orangex-audit-mismatch-')),directory=path.join(root,'orangex-paper');
 try{
  runOrangeXPaperScenario(paperScenario(),{directory});const store=new OrangeXPaperStore({directory});
  try{const state=store.read(),p=state.closed[0];p.entryParts[0].feeUSD+=1;p.feesUSD+=1;p.realizedPnLUSD-=1;store.write(state)}finally{store.close()}
  const file=path.join(directory,'orangex-paper.json'),before=await fs.readFile(file,'utf8'),service=new OrangeXPaperService({directory,writable:true});
  try{assert.equal(service.snapshot().performance.audit.valid,false);assert.equal(service.snapshot().performance.metrics.netPnLUSD,null);
   assert.throws(()=>service.configure({killSwitch:true}),/ACCOUNTING_MISMATCH/);assert.equal(await fs.readFile(file,'utf8'),before);
  }finally{service.close()}
 }finally{await fs.rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:100})}
});

test('forward CLI cannot relabel historical or live data as synthetic fills and contexts remain immutable',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'orangex-context-off-')),directory=path.join(root,'orangex-paper');
 try{
  for(const executionMode of ['HISTORICAL_REPLAY','LIVE_MARKET_PAPER']){
   assert.throws(()=>runOrangeXPaperScenario({...paperScenario(),executionMode},{directory}),/FORWARD_CONTEXT_REQUIRED/);
   const service=new OrangeXPaperService({directory,executionMode,writable:true});
   try{assert.throws(()=>service.configure({capitalUSD:10000}),/CONTEXT_READ_ONLY/);assert.throws(()=>{service.executionMode='SYNTHETIC_TEST'},TypeError)}finally{service.close()}
  }
  assert.throws(()=>runOrangeXPaperScenario({...paperScenario(),runKind:'BACKTEST'},{directory}),/FORWARD_CONTEXT_REQUIRED/);
  assert.deepEqual(await fs.readdir(root),[]);
 }finally{await fs.rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:100})}
});

test('mixed archive context is rejected without reclassifying backtest statistics or replacing a valid report',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'orangex-replay-context-'));
 try{
  const result=replayReport(syntheticReplayInput({complete:true})),store=new OrangeXPaperReplayStore({directory:root});
  for(const patch of [{snapshot:{...result.snapshot,runKind:'FORWARD_PAPER'}},{snapshot:{...result.snapshot,executionMode:'LIVE_MARKET_PAPER'}},
   {performance:{...result.performance,runKind:'FORWARD_PAPER'}}])assert.throws(()=>store.write({...result,...patch}),/CONTEXT_MISMATCH/);
  assert.deepEqual(await fs.readdir(root),[]);
  store.write(result);const file=path.join(root,'orangex-replay.json'),wrapper=JSON.parse(await fs.readFile(file,'utf8'));
  wrapper.result.snapshot.runKind='FORWARD_PAPER';await fs.writeFile(file,JSON.stringify(wrapper));
  assert.equal(store.snapshot().status,'ERROR');assert.equal(store.snapshot().result,null);
 }finally{await fs.rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:100})}
});
