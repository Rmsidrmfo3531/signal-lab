import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {runOrangeXWindowsDiagnostic,checkCurlEnvironment} from '../scripts/diagnose-orangex-windows.mjs';

const NOW=Date.parse('2026-10-29T03:00:00Z');
const runtime={nodeVersion:'22.23.3',platform:'win32',arch:'x64'};
const curlCheck=async()=>({available:true,version:'8.14.1',errorCode:'NONE'});
const options=tempRoot=>({tempRoot,now:()=>NOW,dataSource:'SYNTHETIC_TEST',runtime,curlCheck});
const ok=(kind,result)=>({category:'OK',responseSource:'UNCONFIRMED',exitCode:0,proxyConnectStatus:null,httpStatus:200,
 body:kind==='docs'?'/public/get_instruments /public/tickers /public/get_order_book':JSON.stringify({result})});
const probe=(seen=[])=>async(kind,name,{currency})=>{
 seen.push({kind,name,currency});
 if(kind==='instruments')return ok(kind,currency==='BTC'?['BTC','ETH','SOL'].map(asset=>({instrument_name:`${asset}-USDT-PERPETUAL`,is_active:true,
  min_qty:.001,min_trade_amount:.01,min_notional:10,tick_size:.01,contract_size:1,qty_step:.001,
  maker_commission:.0002,taker_commission:.0006,unknown_secret:'synthetic-never-export'})):[]);
 if(kind==='tickers')return ok(kind,[{instrument_name:name,mark_price:100.005,timestamp:NOW}]);
 return ok(kind,{instrument_name:name,bids:[[100,1]],asks:[[100.01,2]],timestamp:NOW,unknown_secret:'synthetic-never-export'});
};
async function sandbox(run){
 const tempRoot=await fs.mkdtemp(path.join(os.tmpdir(),'orangex oneclick test '));
 try{return await run(tempRoot)}finally{await fs.rm(tempRoot,{recursive:true,force:true,maxRetries:8,retryDelay:100})}
}

test('one-click synthetic diagnostic saves complete allowed observations and NOT_READY to an exclusive temporary JSON without changing existing PNL',()=>sandbox(async tempRoot=>{
 const old=path.join(tempRoot,'legacy');await fs.mkdir(old);await fs.writeFile(path.join(old,'store.json'),'old PNL');await fs.writeFile(path.join(old,'.env'),'old settings');
 const seen=[],result=await runOrangeXWindowsDiagnostic({...options(tempRoot),probe:probe(seen)});
 assert.equal(result.exitCode,0);assert.equal(result.report.kind,'ORANGEX_WINDOWS_ONECLICK');
 assert.equal(result.report.dataSource,'SYNTHETIC_TEST');assert.equal(result.report.syntheticTest,true);
 assert.equal(result.report.actualRequestsRun,false);assert.equal(result.report.rawHttpBodiesIncluded,false);
 assert.equal(result.report.evidenceForm,'ALLOWLISTED_SUMMARY_NOT_RAW_RESPONSE');assert.equal(result.report.readiness.status,'NOT_READY');
 assert.equal(result.report.realDataAutoEntryEnabled,false);assert.equal(result.report.paperAutoEntryEnabled,false);assert.equal(result.report.ordersSubmitted,false);
 assert.equal(result.report.environment.nodeSupported,true);assert.equal(result.report.environment.nodeVersion,'22.23.3');
 assert.equal(result.report.environment.platform,'win32');assert.equal(result.report.environment.curl.version,'8.14.1');
 assert.deepEqual(seen.filter(row=>row.kind==='instruments').map(row=>row.currency),['BTC','ETH','SPOT','PERPETUAL']);
 assert.equal(seen.length,11);assert.equal(result.report.diagnostic.markets.length,3);
 for(const row of result.report.diagnostic.markets){
  assert.equal(row.contractFields.min_qty.value,.001);assert.equal(row.contractFields.min_trade_amount.value,.01);
  assert.equal(row.contractFields.qty_step.value,.001);assert.equal(row.contractFields.contract_size.value,1);
  assert.equal(row.contractFields.maker_commission.value,.0002);assert.equal(row.contractFields.taker_commission.value,.0006);
  assert.equal(row.contractFields.maker_commission.units,'UNVERIFIED');assert.equal(row.book.bookIntegrity.valid,true);
  assert.equal(row.markPriceFresh,true);assert.equal(row.book.fresh,true);
 }
 assert.equal(path.dirname(result.file),path.join(tempRoot,'SignalLab-OrangeX-Diagnostics'));
 assert.deepEqual(JSON.parse(await fs.readFile(result.file,'utf8')),result.report);assert.doesNotMatch(await fs.readFile(result.file,'utf8'),/synthetic-never-export/);
 const another=await runOrangeXWindowsDiagnostic({...options(tempRoot),probe:probe()});assert.notEqual(another.file,result.file);
 assert.deepEqual((await fs.readdir(path.dirname(result.file))).sort(),[path.basename(result.file),path.basename(another.file)].sort());
 assert.equal(await fs.readFile(path.join(old,'store.json'),'utf8'),'old PNL');assert.equal(await fs.readFile(path.join(old,'.env'),'utf8'),'old settings');
}));

test('proxy denial is saved as transport failure rather than an exchange HTTP response or fabricated prices',()=>sandbox(async tempRoot=>{
 const result=await runOrangeXWindowsDiagnostic({...options(tempRoot),probe:async()=>({category:'PROXY_CONNECT_REJECTED',responseSource:'PROXY',exitCode:56,proxyConnectStatus:403,httpStatus:null,body:''})});
 assert.equal(result.exitCode,2);assert.equal(result.report.status,'DIAGNOSTIC_INCOMPLETE');assert.equal(result.report.readiness.status,'NOT_READY');
 assert.ok(result.report.diagnostic.requests.every(row=>row.category==='PROXY_CONNECT_REJECTED'&&row.proxyConnectStatus===403&&row.httpStatus===null));
 assert.ok(result.report.diagnostic.markets.every(row=>row.book===null&&row.markPrice===null));
 assert.equal(JSON.parse(await fs.readFile(result.file,'utf8')).exitCode,2);
}));

test('unsupported Node and missing curl create environment JSON without issuing public requests',()=>sandbox(async tempRoot=>{
 let requests=0,curlChecks=0;
 const old=await runOrangeXWindowsDiagnostic({...options(tempRoot),runtime:{...runtime,nodeVersion:'20.19.0'},
  curlCheck:async()=>{curlChecks++;return {available:true}},probe:async()=>{requests++;throw Error('unexpected')}});
 assert.equal(requests,0);assert.equal(curlChecks,0);assert.equal(old.exitCode,2);
 assert.equal(old.report.environment.nodeVersion,'20.19.0');assert.equal(old.report.environment.nodeSupported,false);
 assert.equal(old.report.diagnostic.errorCode,'NODE_22_REQUIRED');
 const missing=await runOrangeXWindowsDiagnostic({...options(tempRoot),curlCheck:async()=>({available:false,errorCode:'CURL_NOT_FOUND'}),
  probe:async()=>{requests++;throw Error('unexpected')}});
 assert.equal(requests,0);assert.equal(missing.exitCode,2);assert.equal(missing.report.diagnostic.errorCode,'CURL_NOT_FOUND');
 assert.equal(missing.report.readiness.status,'NOT_READY');assert.equal((await fs.readdir(path.dirname(missing.file))).length,2);
}));

test('test probe or injected runtime cannot be labeled as real exchange observations',async()=>{
 await assert.rejects(runOrangeXWindowsDiagnostic({probe:probe()}),/MOCK_INJECTION_REQUIRES_SYNTHETIC_TEST/);
 await assert.rejects(runOrangeXWindowsDiagnostic({runtime}),/MOCK_INJECTION_REQUIRES_SYNTHETIC_TEST/);
 await assert.rejects(runOrangeXWindowsDiagnostic({dataSource:'RAW_HTTP_BODY'}),/INVALID_ONECLICK_OPTIONS/);
});

test('temporary directory redirection into a protected user-data directory is refused before creating an output folder',()=>sandbox(async tempRoot=>{
 const legacy=path.join(tempRoot,'SignalLab');await fs.mkdir(legacy);await fs.writeFile(path.join(legacy,'store.json'),'must survive');
 const redirect=path.join(tempRoot,'temporary-junction');await fs.symlink(legacy,redirect,'junction');
 await assert.rejects(runOrangeXWindowsDiagnostic({...options(redirect),protectedDirectories:[legacy],probe:probe()}),/USER_DATA_PATH_FORBIDDEN/);
 assert.deepEqual(await fs.readdir(legacy),['store.json']);assert.equal(await fs.readFile(path.join(legacy,'store.json'),'utf8'),'must survive');
}));

test('curl environment checking waits for child close and never returns stderr, executable paths or arbitrary banners',async()=>{
 let invocation,closed=false;
 const spawnProcess=(command,args,options)=>{
  invocation={command,args,options};const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();
  queueMicrotask(()=>{child.stdout.write('curl 8.14.1 (private-host) private-path');child.stderr.write('secret-proxy-error');
   child.stdout.end();child.stderr.end();closed=true;child.emit('close',0)});return child;
 };
 const observed=await checkCurlEnvironment({spawnProcess,platform:'win32'});
 assert.equal(closed,true);assert.deepEqual(invocation.args,['--disable','--version']);assert.equal(invocation.command,'curl.exe');assert.equal(invocation.options.shell,false);
 assert.deepEqual(observed,{executable:'curl.exe',available:true,version:'8.14.1',errorCode:'NONE'});
 assert.doesNotMatch(JSON.stringify(observed),/private|secret/);
});

test('ZIP launcher never requires Git, PowerShell, an API key or an application startup and preserves exit status',async()=>{
 const batch=await fs.readFile(new URL('../diagnose_orangex.bat',import.meta.url),'utf8');
 assert.match(batch,/pushd "%~dp0"/);assert.match(batch,/DisableDelayedExpansion/);assert.match(batch,/where node\.exe/);
 assert.match(batch,/scripts\\diagnose-orangex-windows\.mjs/);assert.match(batch,/NODE_22_REQUIRED/);
 assert.match(batch,/SignalLab-OrangeX-Diagnostics/);assert.match(batch,/set "SIGNAL_LAB_DIAG_EXIT=%ERRORLEVEL%"/);
 assert.doesNotMatch(batch,/powershell|git (?:pull|clone|fetch)|npm (?:start|install)|server\.mjs|--insecure|LOCALAPPDATA[\\/]/i);
 assert.match(batch,/"rawHttpBodiesIncluded":false/);assert.match(batch,/"realDataAutoEntryEnabled":false/);
});
