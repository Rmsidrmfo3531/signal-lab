import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {spawn} from 'node:child_process';
import {checkCurlEnvironment,runOrangeXWindowsDiagnostic} from '../scripts/diagnose-orangex-windows.mjs';
import {classifyCurl,curlPublicProbe,diagnoseOrangeXPublic,observeBook} from '../scripts/diagnose-orangex-public.mjs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// These are controlled process faults and generated public responses. No curl
// request, actual Windows process or exchange API is used by this file.
const NOW=Date.parse('2026-10-29T03:00:00Z');
const trailer='\n__SIGNALLAB_CURL_STATUS__200,200';
function fakeChild({onKill=()=>{}}={}){
 const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();
 child.kill=signal=>{onKill(signal,child);return true};child.unref=()=>{};return child;
}
const end=(child,code)=>{child.stdout.end();child.stderr.end();child.emit('close',code)};

test('environment timeout is never overwritten by a successful exit code or version banner',async()=>{
 const signals=[];
 const result=await checkCurlEnvironment({timeoutMs:5,killGraceMs:5,spawnProcess:()=>{
  const child=fakeChild({onKill:(signal,value)=>{signals.push(signal);end(value,0)}});
  queueMicrotask(()=>child.stdout.write('curl 8.14.1\n'));return child;
 }});
 assert.deepEqual(signals,['SIGTERM']);assert.equal(result.available,false);assert.equal(result.version,null);
 assert.equal(result.processClosed,true);assert.equal(result.errorCode,'CURL_CHECK_TIMEOUT');
});

test('ignored graceful termination escalates to SIGKILL and environment checking waits for close',async()=>{
 const signals=[];let closed=false;
 const result=await checkCurlEnvironment({platform:'win32',timeoutMs:5,killGraceMs:5,spawnProcess:()=>{
  const child=fakeChild({onKill:(signal,value)=>{signals.push(signal);if(signal==='SIGKILL')setTimeout(()=>{closed=true;end(value,null)},5)}});
  queueMicrotask(()=>child.stdout.write('curl 8.14.1\n'));return child;
 }});
 assert.deepEqual(signals,['SIGTERM','SIGKILL']);assert.equal(closed,true);assert.equal(result.processClosed,true);
 assert.equal(result.available,false);assert.equal(result.errorCode,'CURL_CHECK_TIMEOUT');
});

test('public curl timeout remains TIMEOUT even when terminated process exits zero with HTTP200 trailer',async()=>{
 let closed=false;
 const result=await curlPublicProbe('docs',undefined,{processTimeoutMs:5,killGraceMs:5,spawnProcess:()=>{
  const child=fakeChild({onKill:(_signal,value)=>{closed=true;end(value,0)}});
  queueMicrotask(()=>child.stdout.write('synthetic document'+trailer));return child;
 }});
 assert.equal(closed,true);assert.equal(result.exitCode,0);assert.equal(result.httpStatus,200);
 assert.equal(result.processClosed,true);assert.equal(result.processError,'PROCESS_TIMEOUT');assert.equal(result.category,'TIMEOUT');
 assert.equal(classifyCurl({exitCode:0,httpStatus:200,processError:'SPAWN_ERROR'}).category,'NETWORK');
});

test('unconfirmed child cleanup is bounded, discards untrusted body and stops subsequent public GETs',async()=>{
 const signals=[];
 const result=await curlPublicProbe('docs',undefined,{processTimeoutMs:5,killGraceMs:5,spawnProcess:()=>{
  const child=fakeChild({onKill:signal=>signals.push(signal)});
  queueMicrotask(()=>child.stdout.write('never-export-this-body'+trailer));return child;
 }});
 assert.deepEqual(signals,['SIGTERM','SIGKILL']);assert.equal(result.processClosed,false);
 assert.equal(result.processError,'PROCESS_TERMINATION_UNCONFIRMED');assert.equal(result.category,'TIMEOUT');assert.equal(result.body,'');
 let requests=0;
 const report=await diagnoseOrangeXPublic({now:()=>NOW,probe:async()=>{requests++;return result}});
 assert.equal(requests,1);assert.equal(report.exitCode,2);assert.equal(report.requests[0].requestIssued,true);
 assert.equal(report.requests[0].processError,'PROCESS_TERMINATION_UNCONFIRMED');
 assert.ok(report.requests.slice(1).every(row=>row.status==='NOT_RUN'&&row.requestIssued===false&&row.processClosed===false));
 assert.doesNotMatch(JSON.stringify(report),/never-export-this-body/);
});

test('an unreaped environment check prevents all public requests and only then writes an explicit incomplete summary',async()=>{
 const tempRoot=await fs.mkdtemp(path.join(os.tmpdir(),'orangex-process-cleanup-'));let requests=0;
 try{
  const result=await runOrangeXWindowsDiagnostic({dataSource:'SYNTHETIC_TEST',tempRoot,now:()=>NOW,
   runtime:{nodeVersion:'24.19.0',platform:'win32',arch:'x64'},
   curlCheck:()=>checkCurlEnvironment({timeoutMs:5,killGraceMs:5,spawnProcess:()=>fakeChild()}),
   probe:async()=>{requests++;throw Error('public probe must not run')}});
  assert.equal(requests,0);assert.equal(result.exitCode,2);assert.equal(result.report.actualRequestsRun,false);
  assert.equal(result.report.environment.curl.processClosed,false);assert.equal(result.report.environment.curl.errorCode,'CURL_TERMINATION_UNCONFIRMED');
  assert.equal(result.report.readiness.status,'NOT_READY');assert.equal(result.report.diagnostic.errorCode,'CURL_TERMINATION_UNCONFIRMED');
  assert.equal(JSON.parse(await fs.readFile(result.file,'utf8')).status,'DIAGNOSTIC_INCOMPLETE');
 }finally{await fs.rm(tempRoot,{recursive:true,force:true,maxRetries:8,retryDelay:100})}
});

test('controlled local children are actually closed before both timeout results resolve',{timeout:10000},async()=>{
 const children=[];
 const spawnProcess=(_command,_args,options)=>{
  const source="process.on('SIGTERM',()=>{});console.log('curl 8.14.1');console.log('synthetic'+"+JSON.stringify(trailer)+");setInterval(()=>{},1000);";
  const child=spawn(process.execPath,['--input-type=module','-e',source],{...options,env:{PATH:process.env.PATH,
   ...(process.env.SystemRoot?{SystemRoot:process.env.SystemRoot}:{})}});
  const row={child,closed:false};children.push(row);child.once('close',()=>{row.closed=true});return child;
 };
 try{
  const environment=await checkCurlEnvironment({spawnProcess,timeoutMs:250,killGraceMs:1000});
  assert.equal(environment.available,false);assert.equal(environment.processClosed,true);assert.equal(environment.errorCode,'CURL_CHECK_TIMEOUT');
  assert.equal(children[0].closed,true);
  const publicResult=await curlPublicProbe('docs',undefined,{spawnProcess,processTimeoutMs:250,killGraceMs:1000});
  assert.equal(publicResult.category,'TIMEOUT');assert.equal(publicResult.processClosed,true);assert.equal(children[1].closed,true);
 }finally{
  for(const row of children)if(!row.closed){row.child.kill('SIGKILL');await new Promise(resolve=>row.child.once('close',resolve))}
 }
});

test('unknown order-book columns are rejected instead of silently trimmed into valid two-column depth',async()=>{
 const book={instrument_name:'BTC-USDT-PERPETUAL',timestamp:NOW,bids:[[100,1,'unknown']],asks:[[101,1]]};
 assert.equal(observeBook(book,NOW),null);
 assert.equal(observeBook({...book,bids:[[100,1]],asks:[[101,1,{unknown:true}]]},NOW),null);
 const report=await diagnoseOrangeXPublic({now:()=>NOW,probe:async(kind,name)=>({category:'OK',responseSource:'UNCONFIRMED',exitCode:0,httpStatus:200,
  body:kind==='docs'?'/public/get_order_book':JSON.stringify({result:kind==='instruments'?[]:kind==='tickers'?[{instrument_name:name,mark_price:100,timestamp:NOW}]:{...book,instrument_name:name}})})});
 assert.equal(report.exitCode,1);assert.equal(report.requests.filter(row=>row.kind==='book'&&row.category==='SCHEMA').length,3);
 assert.equal(report.checkedAt,new Date(NOW).toISOString());assert.equal(report.completedAt,new Date(NOW).toISOString());
 assert.ok(report.markets.every(row=>row.book===null));assert.equal(report.ready,false);
});

test('process safety deadlines cannot be disabled with zero, non-finite or unbounded caller options',()=>{
 for(const timeoutMs of [0,-1,NaN,Infinity,30001]){
  assert.throws(()=>checkCurlEnvironment({timeoutMs}),/INVALID_CURL_CHECK_TIMEOUT/);
  assert.throws(()=>curlPublicProbe('docs',undefined,{processTimeoutMs:timeoutMs}),/INVALID_PUBLIC_PROCESS_TIMEOUT/);
 }
 for(const killGraceMs of [0,Infinity,5001]){
  assert.throws(()=>checkCurlEnvironment({killGraceMs}),/INVALID_CURL_CHECK_TIMEOUT/);
  assert.throws(()=>curlPublicProbe('docs',undefined,{killGraceMs}),/INVALID_PUBLIC_PROCESS_TIMEOUT/);
 }
});
