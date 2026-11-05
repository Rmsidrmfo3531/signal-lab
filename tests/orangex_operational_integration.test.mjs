import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {evaluateOrangeXReadiness} from '../orangex_readiness.mjs';
import {checkOrangeXReadinessFile,readinessOptions} from '../scripts/check-orangex-readiness.mjs';
import {orangeXOperationalView,renderOrangeXOperational} from '../public/orangex_operational.js';
import {orangeXPaperView} from '../public/orangex_paper.js';
import {OrangeXPaperStore} from '../orangex_paper_store.mjs';
import {paperScenario} from './fixtures/orangex_paper_scenario.mjs';
import {runOrangeXPaperScenario} from '../scripts/orangex-paper-offline.mjs';

const fixture=new URL('./fixtures/orangex/windows-public-diagnostic-20261027-usdt-mark-depth.json',import.meta.url);

test('original Windows observations remain NOT_READY with independent freshness and corrupted depth displayed separately',async()=>{
 const original=await fs.readFile(fixture,'utf8'),input=JSON.parse(original),
  capture=Math.max(...input.markets.flatMap(row=>[row.book.timestamp+row.book.ageMs,row.markPriceTimestamp+row.markPriceAgeMs]));
 const report=evaluateOrangeXReadiness(input,{now:capture}),view=orangeXOperationalView(report);
 assert.equal(report.status,'NOT_READY');assert.equal(report.activationAllowed,false);assert.equal(report.realDataAutoEntryEnabled,false);
 assert.equal(report.liveOrdersEnabled,false);assert.match(view.status,/NOT_READY/);assert.match(view.status,/READ_ONLY/);
 assert.match(view.checks,/BTC/);assert.match(view.checks,/ETH/);assert.match(view.checks,/SOL/);assert.match(view.checks,/UNVERIFIED/);assert.match(view.checks,/FAIL/);
 assert.equal(report.markets.find(row=>row.asset==='ETH').checks.find(row=>row.id==='BOOK_INTEGRITY').status,'FAIL');
 const expired=evaluateOrangeXReadiness(input,{now:capture+90001});
 assert.ok(expired.markets.every(row=>row.checks.filter(check=>['BOOK_FRESHNESS','MARK_FRESHNESS'].includes(check.id)).every(check=>check.status==='FAIL')));
 assert.equal(await fs.readFile(fixture,'utf8'),original);
});

test('a malformed READY claim and arbitrary provider values cannot become ready labels or browser secrets',()=>{
 const secret='unit-test-provider-token';
 const view=orangeXOperationalView({kind:'ORANGEX_OPERATIONAL_READINESS',status:'READY',checks:[{id:'EVIDENCE_FORMAT',status:'PASS',reason:secret}],
  markets:[{asset:secret,checks:[{id:secret,status:secret,observed:{access_token:secret}}]}]});
 assert.match(view.status,/NOT_READY/);assert.doesNotMatch(view.checks,new RegExp(secret));
 const nodes=new Map([['orangexOperationalStatus',{textContent:''}],['orangexOperationalChecks',{innerHTML:''}]]);
 renderOrangeXOperational(evaluateOrangeXReadiness({mode:'READ_ONLY',markets:[]}),{root:{getElementById:id=>nodes.get(id)}});
 assert.match(nodes.get('orangexOperationalStatus').textContent,/자동 진입 OFF/);
 assert.match(nodes.get('orangexOperationalChecks').innerHTML,/수수료 단위/);
});

test('offline one-click JSON recheck preserves synthetic provenance and never changes files or application settings',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'orangex-readiness-file-')),file=path.join(root,'summary.json');
 try{
  const diagnostic=JSON.parse(await fs.readFile(fixture,'utf8'));
  await fs.writeFile(file,JSON.stringify({kind:'ORANGEX_WINDOWS_ONECLICK',dataSource:'SYNTHETIC_TEST',syntheticTest:true,diagnostic}));
  const before=await fs.readFile(file,'utf8'),report=checkOrangeXReadinessFile(file);
  assert.equal(report.status,'NOT_READY');assert.equal(report.checks.find(row=>row.id==='SOURCE_PROVENANCE').status,'FAIL');
  const child=spawnSync(process.execPath,[fileURLToPath(new URL('../scripts/check-orangex-readiness.mjs',import.meta.url)),'--input',file],
   {encoding:'utf8',timeout:15000,killSignal:'SIGKILL',env:{PATH:process.env.PATH,...(process.env.SystemRoot?{SystemRoot:process.env.SystemRoot}:{})}});
  assert.equal(child.error,undefined);assert.equal(child.status,1);assert.equal(JSON.parse(child.stdout).status,'NOT_READY');
  assert.equal(await fs.readFile(file,'utf8'),before);assert.deepEqual(await fs.readdir(root),['summary.json']);
  for(const inner of [{...diagnostic,syntheticTest:true,dataSource:'REAL_PUBLIC_OBSERVATION_SUMMARY'},
   {...diagnostic,dataSource:'SYNTHETIC_FIXTURE'}]){
   await fs.writeFile(file,JSON.stringify({kind:'ORANGEX_WINDOWS_ONECLICK',dataSource:'REAL_PUBLIC_OBSERVATION_SUMMARY',syntheticTest:false,diagnostic:inner}));
   assert.equal(checkOrangeXReadinessFile(file).checks.find(row=>row.id==='SOURCE_PROVENANCE').status,'FAIL','an outer label cannot erase an inner synthetic marker');
  }
  for(const args of [[],['--input'],['--input','x','--enable']])assert.throws(()=>readinessOptions(args));
 }finally{await fs.rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:100})}
});

test('production snapshot capacity is reported without selecting the experimental journal or rewriting existing PNL',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'orangex-storage-capacity-')),directory=path.join(root,'orangex-paper');
 try{
  runOrangeXPaperScenario(paperScenario(),{directory});const store=new OrangeXPaperStore({directory});
  try{const before=await fs.readFile(store.file,'utf8'),status=store.status();
   assert.equal(status.fileSizeBytes,Buffer.byteLength(before));assert.equal(status.maxStoreBytes,16*1024*1024);assert.equal(status.nearCapacity,false);
   assert.equal(await fs.readFile(store.file,'utf8'),before);
   const view=orangeXPaperView({dataSource:'SYNTHETIC_FIXTURE',settings:{capitalUSD:10000},storage:{status:'READ_ONLY',healthy:true,
    fileSizeBytes:14*1024*1024,maxStoreBytes:16*1024*1024,nearCapacity:true}});
   assert.match(view.storage,/14\.00 \/ 16\.00MiB/);assert.match(view.storage,/용량 주의/);assert.match(view.storage,/자동 삭제 없음/);
  }finally{store.close()}
  assert.ok((await fs.readdir(directory)).every(name=>!name.startsWith('journal')));
 }finally{await fs.rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:100})}
});
