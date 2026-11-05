import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {runNodeTests,testRunnerOptions,discoverTestFiles,terminateOwnedTestTree} from '../scripts/run-node-tests.mjs';
function assertTerminated(pid){
 let gone=false;
 try{process.kill(pid,0)}catch(error){if(error.code==='ESRCH')gone=true;else throw error;}
 if(!gone&&process.platform==='linux'){
  // Container PID 1 may defer reaping, but a zombie has exited with no handles.
  assert.match(fs.readFileSync('/proc/'+pid+'/stat','utf8'),/\) Z /);
 }else assert.equal(gone,true,'the owned descendant must have terminated before the runner returns');
}

test('CI discovers exactly the same test files and rejects disabled or unbounded runner limits',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'signal-ci-discovery-'));
 try{
  fs.mkdirSync(path.join(root,'tests'));
  for(const name of ['z.test.mjs','a.test.mjs','fixture.mjs'])fs.writeFileSync(path.join(root,'tests',name),'');
  assert.deepEqual(discoverTestFiles(root),['tests/a.test.mjs','tests/z.test.mjs']);
  assert.deepEqual(testRunnerOptions(),{concurrency:2,fileTimeoutMs:120000,outputDir:null,files:[]});
  for(const args of [['--file-timeout-ms','0'],['--file-timeout-ms','120001'],['--file-timeout-ms','NaN'],['--concurrency','0'],['--concurrency','5'],['--unknown','x'],['--file']])
   assert.throws(()=>testRunnerOptions(args),/INVALID_TEST_RUNNER_OPTIONS/);
 }finally{fs.rmSync(root,{recursive:true,force:true,maxRetries:8,retryDelay:100})}
});

test('Windows timeout terminates the complete owned tree before separately killing a worker could orphan it',async()=>{
 const commands=[],signals=[],child={pid:12345,exitCode:null,signalCode:null,kill:signal=>signals.push(signal)};
 await terminateOwnedTestTree(child,{platform:'win32',execFileFn:async(...args)=>commands.push(args)});
 assert.deepEqual(commands,[['taskkill',['/PID','12345','/T','/F'],{windowsHide:true,timeout:5000,killSignal:'SIGKILL'}]]);
 assert.deepEqual(signals,[]);
 await assert.rejects(terminateOwnedTestTree(child,{platform:'win32',execFileFn:async()=>{throw Object.assign(Error('denied'),{code:'EPERM'})}}),{code:'EPERM'});
});

test('completed bodies with leaked handles fail the file deadline; pending Promises and assertion errors do not hide remaining files',{timeout:25000},async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'signal-ci-lifecycle-')),events=[],tests=path.join(root,'tests'),out=path.join(root,'results');
 fs.mkdirSync(tests);
 const bodyDone=path.join(root,'body-finished'),pidFile=path.join(root,'descendant.pid');
 const source={
  'a-pass':"import test from 'node:test';test('first passes',()=>{});",
  'b-fail':"import test from 'node:test';import assert from 'node:assert/strict';test('real assertion failure',()=>assert.equal(1,2));",
  'c-pending':"import test from 'node:test';test('promise cannot resolve without active resources',{timeout:100},()=>new Promise(()=>{}));",
  'd-leaked':`import test from 'node:test';import fs from 'node:fs';test('body passes but timer leaks',()=>{fs.writeFileSync(${JSON.stringify(bodyDone)},'finished');setInterval(()=>{},1000)});`,
  'e-last':"import test from 'node:test';test('later file still executes',()=>{});",
  'f-descendant':`import test from 'node:test';import fs from 'node:fs';import {spawn} from 'node:child_process';test('owned descendant keeps pipes open',()=>{const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit'});fs.writeFileSync(${JSON.stringify(pidFile)},String(c.pid));});`
 };
 for(const [name,code] of Object.entries(source))fs.writeFileSync(path.join(tests,name+'.test.mjs'),code);
 try{
  const result=await runNodeTests({root,outputDir:out,concurrency:2,fileTimeoutMs:5000,heartbeatMs:200,print:value=>events.push(value)});
  assert.equal(result.passed,false);assert.equal(result.totalFiles,6);assert.equal(result.completedFiles,6);
  const rows=new Map(result.results.map(row=>[path.basename(row.file),row]));
  assert.equal(rows.get('a-pass.test.mjs').status,'PASS');assert.equal(rows.get('e-last.test.mjs').status,'PASS');
  assert.equal(rows.get('b-fail.test.mjs').failureCode,'TEST_PROCESS_FAILED');
  assert.equal(rows.get('c-pending.test.mjs').status,'FAIL');assert.ok(rows.get('c-pending.test.mjs').cancelled>0,JSON.stringify(rows.get('c-pending.test.mjs')));
  for(const file of ['d-leaked.test.mjs','f-descendant.test.mjs']){
   const row=rows.get(file);assert.equal(row.failureCode,'FILE_TIMEOUT');assert.equal(row.status,'FAIL');
   assert.equal(row.processClosed,true);assert.equal(row.cleanupError,null);
   assert.ok(row.durationMs<12000);
  }
  assert.equal(fs.readFileSync(bodyDone,'utf8'),'finished','the leaked handle must not turn a completed test body into CI success');
  assertTerminated(Number(fs.readFileSync(pidFile,'utf8')));
  assert.ok(events.some(value=>value.startsWith('[TEST ACTIVE]')));assert.equal(events.filter(value=>value.startsWith('[TEST START]')).length,6);
  assert.equal(JSON.parse(fs.readFileSync(path.join(out,'summary.json'))).failedFiles,4);
  assert.equal(JSON.parse(fs.readFileSync(path.join(out,'progress.json'))).active.length,0);
  for(const row of result.results)assert.ok(fs.statSync(path.join(out,row.log)).size>0);
 }finally{fs.rmSync(root,{recursive:true,force:true,maxRetries:8,retryDelay:100})}
});

test('explicit cancellation stops active processes, preserves partial reports and never starts queued files',{timeout:10000},async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'signal-ci-cancel-')),controller=new AbortController();
 fs.mkdirSync(path.join(root,'tests'));
 fs.writeFileSync(path.join(root,'tests','a-active.test.mjs'),"import test from 'node:test';test('active process',()=>{setInterval(()=>{},1000)});");
 fs.writeFileSync(path.join(root,'tests','z-queued.test.mjs'),"throw Error('must not start after cancellation');");
 const timer=setTimeout(()=>controller.abort(),500);
 try{
  const result=await runNodeTests({root,outputDir:path.join(root,'logs'),concurrency:1,fileTimeoutMs:5000,signal:controller.signal,print:()=>{}});
  assert.equal(result.passed,false);assert.equal(result.aborted,true);assert.equal(result.completedFiles,1);
  assert.deepEqual(result.pendingFiles,['tests/z-queued.test.mjs']);
  assert.equal(result.results[0].failureCode,'RUN_ABORTED');assert.equal(result.results[0].processClosed,true);
  assert.equal(result.results[0].cleanupError,null);
 }finally{clearTimeout(timer);fs.rmSync(root,{recursive:true,force:true,maxRetries:8,retryDelay:100})}
});

test('cancellation from the last PASS callback cannot publish a successful run',{timeout:10000},async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'signal-ci-late-cancel-')),controller=new AbortController();
 fs.mkdirSync(path.join(root,'tests'));
 fs.writeFileSync(path.join(root,'tests','pass.test.mjs'),"import test from 'node:test';test('body succeeds',()=>{});");
 try{
  const result=await runNodeTests({root,outputDir:path.join(root,'logs'),signal:controller.signal,
   print:value=>{if(value.startsWith('[TEST PASS]'))controller.abort();}});
  assert.equal(result.results[0].status,'PASS');assert.equal(result.completedFiles,1);
  assert.equal(result.passed,false);assert.equal(result.aborted,true);
  const stored=JSON.parse(fs.readFileSync(path.join(root,'logs','summary.json')));
  assert.equal(stored.passed,false);assert.equal(stored.aborted,true);
 }finally{fs.rmSync(root,{recursive:true,force:true,maxRetries:8,retryDelay:100})}
});

test('START, completion and progress-report failures cannot strand active workers',{timeout:20000},async()=>{
 for(const mode of ['START_PRINT','FINISH_PRINT','PROGRESS_FAILURE']){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'signal-ci-report-failure-')),tests=path.join(root,'tests'),out=path.join(root,'logs'),
   pidFile=path.join(root,'active.pid'),progressFile=path.join(out,'progress.json'),injected=Error('injected reporting failure');
  fs.mkdirSync(tests);
  fs.writeFileSync(path.join(tests,'a-active.test.mjs'),`import test from 'node:test';import fs from 'node:fs';test('active sibling',()=>{fs.writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1000)});`);
  if(mode!=='START_PRINT')fs.writeFileSync(path.join(tests,'b-finished.test.mjs'),`import test from 'node:test';import fs from 'node:fs';test('finishing sibling',async()=>{
   for(let n=0;n<150&&!fs.existsSync(${JSON.stringify(pidFile)});n++)await new Promise(resolve=>setTimeout(resolve,20));
   if(!fs.existsSync(${JSON.stringify(pidFile)}))throw Error('active sibling did not start');
   ${mode==='PROGRESS_FAILURE'?`fs.unlinkSync(${JSON.stringify(progressFile)});fs.mkdirSync(${JSON.stringify(progressFile)});`:''}
  });`);
  try{
   await assert.rejects(runNodeTests({root,outputDir:out,concurrency:2,fileTimeoutMs:6000,print:value=>{
    if(mode==='START_PRINT'&&value.startsWith('[TEST START]'))throw injected;
    if(mode==='FINISH_PRINT'&&value.startsWith('[TEST PASS]')&&value.includes('b-finished.test.mjs'))throw injected;
   }}),error=>mode==='PROGRESS_FAILURE'?error.path===progressFile:error===injected);
   if(mode==='START_PRINT'){
    await new Promise(resolve=>setTimeout(resolve,200));
    assert.equal(fs.existsSync(pidFile),false,'a failing START callback must run before spawning a process');
   }else{
    assertTerminated(Number(fs.readFileSync(pidFile,'utf8')));
   }
  }finally{fs.rmSync(root,{recursive:true,force:true,maxRetries:8,retryDelay:100})}
 }
});
