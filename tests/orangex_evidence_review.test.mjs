import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {normalizeOrangeXEvidence,reviewOrangeXEvidence} from '../orangex_evidence_review.mjs';
import {evaluateOrangeXReadiness} from '../orangex_readiness.mjs';
import {reviewOrangeXEvidenceFile,evidenceReviewOptions} from '../scripts/review-orangex-evidence.mjs';
import {checkOrangeXReadinessFile} from '../scripts/check-orangex-readiness.mjs';

const NOW=Date.parse('2026-10-29T04:00:00Z');
const load=name=>JSON.parse(fs.readFileSync(new URL('./fixtures/orangex/'+name,import.meta.url),'utf8'));
const latest=()=>load('windows-public-diagnostic-20261027-usdt-mark-depth.json');
const older=()=>load('windows-public-diagnostic-20261027.json');
const check=(report,id,asset='BTC')=>report.markets.find(row=>row.asset===asset).checks.find(row=>row.id===id);
function sandbox(run){
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'orangex-evidence27-'));
 try{return run(directory)}finally{fs.rmSync(directory,{recursive:true,force:true,maxRetries:8,retryDelay:100})}
}

test('user-provided eight-response history remains separate from a new real connection and never supplies missing contract fields',()=>{
 const input=latest(),before=structuredClone(input),report=reviewOrangeXEvidence(input,{now:NOW});
 assert.equal(report.http200Count,8);assert.equal(report.status,'NOT_READY');
 assert.equal(report.sourceClass,'HISTORICAL_OR_UNDATED_USER_REPORTED_PUBLIC_OBSERVATION');
 assert.equal(report.evidenceForm,'NORMALIZED_OBSERVATIONS_NOT_RAW_HTTP');
 assert.equal(report.atReportedCompletion,null);assert.equal(report.completionClockStatus,'UNVERIFIED_COMPLETION_CLOCK_MISSING');
 assert.ok(report.markets.every(row=>Object.keys(row.contractFields).length===0&&row.listingObserved===false&&row.active===null));
 assert.ok(report.markets.every(row=>check(report,'BOOK_FRESHNESS',row.asset).status==='FAIL'&&check(report,'MARK_FRESHNESS',row.asset).status==='FAIL'));
 assert.equal(check(report,'BOOK_INTEGRITY','ETH').status,'FAIL');
 assert.deepEqual(report.current.summary,{PASS:4,FAIL:7,UNVERIFIED:43,total:54});assert.deepEqual(input,before);
 assert.equal(report.activationAllowed,false);assert.equal(report.realDataAutoEntryEnabled,false);assert.equal(report.paperAutoEntryEnabled,false);
});

test('older scalar quotes retain independent time observations without inventing depth, Mark, min_qty or quantity increments',()=>{
 const input=older(),row=input.markets[0],capture=row.book.timestamp+row.book.ageMs;
 // A supplied evaluation clock is test metadata, not an inferred exchange clock.
 const report=evaluateOrangeXReadiness(input,{now:capture+1000});
 assert.equal(check(report,'BOOK_FRESHNESS').status,'PASS');
 assert.equal(check(report,'BOOK_INTEGRITY').status,'UNVERIFIED');assert.equal(check(report,'MARK_FRESHNESS').status,'UNVERIFIED');
 const audit=reviewOrangeXEvidence(input,{now:NOW});
 assert.equal(audit.markets[0].book.bid,79743.2);assert.equal(audit.markets[0].book.bidLevels,null);
 assert.equal(audit.markets[0].markPrice,null);assert.equal(audit.markets[0].contractFields.min_trade_amount.value,.001);
 assert.equal(audit.markets[0].contractFields.min_qty,undefined);assert.equal(audit.markets[0].contractFields.qty_step,undefined);
 assert.equal(audit.markets[0].contractFields.maker_commission.value,.0002);
 assert.equal(audit.markets[0].contractFields.maker_commission.interpretation,'RAW_VALUE_ONLY');
 assert.equal(check(audit,'FEE_UNITS').status,'UNVERIFIED');assert.equal(audit.http200Count,6);
});

test('outer current labels cannot erase synthetic or historical evidence tags',()=>{
 for(const tag of [{dataSource:'HISTORICAL_REPLAY'},{executionMode:'HISTORICAL_REPLAY'},{runKind:'BACKTEST'}]){
  const report=reviewOrangeXEvidence({kind:'ORANGEX_WINDOWS_ONECLICK',dataSource:'REAL_PUBLIC_OBSERVATION_SUMMARY',diagnostic:{...latest(),...tag}},{now:NOW});
  assert.equal(report.sourceClass,'HISTORICAL_REPLAY');assert.equal(report.status,'NOT_READY');
  assert.equal(report.current.checks.find(row=>row.id==='SOURCE_PROVENANCE').reason,'HISTORICAL_REPLAY_CANNOT_VERIFY_CURRENT_OPERATIONAL_READINESS');
 }
 for(const [outer,inner]of [[{syntheticTest:true},{}],[{},{dataSource:'SYNTHETIC_FIXTURE'}],[{},{executionMode:'SYNTHETIC_TEST'}]]){
  const input={kind:'ORANGEX_WINDOWS_ONECLICK',dataSource:'REAL_PUBLIC_OBSERVATION_SUMMARY',...outer,diagnostic:{...latest(),...inner}};
  assert.equal(reviewOrangeXEvidence(input,{now:NOW}).sourceClass,'SYNTHETIC_TEST');
  assert.equal(evaluateOrangeXReadiness(normalizeOrangeXEvidence(input),{now:NOW}).checks.find(row=>row.id==='SOURCE_PROVENANCE').status,'FAIL');
  assert.equal(normalizeOrangeXEvidence(input).dataSource,'SYNTHETIC_TEST');
 }
});

test('wrapper source taint remains restrictive when the existing readiness file command is used',()=>sandbox(directory=>{
 const file=path.join(directory,'public.json'),input={kind:'ORANGEX_WINDOWS_ONECLICK',dataSource:'REAL_PUBLIC_OBSERVATION_SUMMARY',
  diagnostic:{...latest(),dataSource:'HISTORICAL_REPLAY'}};
 fs.writeFileSync(file,JSON.stringify(input));const before=fs.readFileSync(file),result=checkOrangeXReadinessFile(file,{now:NOW});
 assert.equal(result.checks.find(row=>row.id==='SOURCE_PROVENANCE').status,'FAIL');
 assert.equal(result.checks.find(row=>row.id==='SOURCE_PROVENANCE').reason,'HISTORICAL_REPLAY_CANNOT_VERIFY_CURRENT_OPERATIONAL_READINESS');
 assert.ok(fs.readFileSync(file).equals(before));assert.deepEqual(fs.readdirSync(directory),['public.json']);
}));

test('outer mode or activation contradictions cannot be hidden by a nested READ_ONLY diagnostic',()=>{
 for(const outer of [{mode:'LIVE'},{mode:'PAPER'},...['orderSubmissionEnabled','ordersSubmitted','liveOrdersEnabled',
  'realDataAutoEntryEnabled','paperAutoEntryEnabled','paperEnabled'].map(key=>({[key]:true}))]){
  const report=reviewOrangeXEvidence({kind:'ORANGEX_WINDOWS_ONECLICK',...outer,diagnostic:latest()},{now:NOW});
  assert.equal(report.current.checks.find(row=>row.id==='READ_ONLY_CONTEXT').status,'FAIL');
  assert.equal(report.status,'NOT_READY');assert.equal(report.activationAllowed,false);
 }
 for(const location of ['fundingObservation','binanceObservation','binanceComparison']){
  const input=latest();input.markets[0][location]={dataSource:'SYNTHETIC_FIXTURE'};
  assert.equal(reviewOrangeXEvidence(input,{now:NOW}).sourceClass,'SYNTHETIC_TEST');
  assert.equal(evaluateOrangeXReadiness(input,{now:NOW}).checks.find(row=>row.id==='SOURCE_PROVENANCE').status,'FAIL');
  input.markets[0][location]={executionMode:'HISTORICAL_REPLAY'};
  assert.equal(reviewOrangeXEvidence(input,{now:NOW}).sourceClass,'HISTORICAL_REPLAY');
  assert.equal(evaluateOrangeXReadiness(input,{now:NOW}).checks.find(row=>row.id==='SOURCE_PROVENANCE').status,'FAIL');
 }
});

test('provided start and fresh booleans do not become a completion clock or refresh independent market timestamps',()=>{
 const input=latest();input.checkedAt=new Date(NOW).toISOString();
 for(const market of input.markets){market.book.fresh=true;market.markPriceFresh=true;market.book.ageMs=0;market.markPriceAgeMs=0}
 const noCompletion=reviewOrangeXEvidence(input,{now:NOW});assert.equal(noCompletion.atReportedCompletion,null);
 assert.equal(check(noCompletion,'BOOK_FRESHNESS').status,'FAIL');assert.equal(check(noCompletion,'MARK_FRESHNESS').status,'FAIL');
 const future=reviewOrangeXEvidence({...input,completedAt:new Date(NOW+1000).toISOString()},{now:NOW});
 assert.equal(future.atReportedCompletion,null);assert.equal(future.completionClockStatus,'FAIL_FUTURE_COMPLETION');
 const reversed=reviewOrangeXEvidence({...input,completedAt:new Date(NOW-100).toISOString()},{now:NOW});
 assert.equal(reversed.atReportedCompletion,null);assert.equal(reversed.completionClockStatus,'FAIL_COMPLETION_BEFORE_START');
 const completed=reviewOrangeXEvidence({...input,checkedAt:new Date(NOW-200).toISOString(),completedAt:new Date(NOW-100).toISOString()},{now:NOW});
 assert.equal(completed.atReportedCompletion.checkedAt,NOW-100);assert.equal(completed.status,'NOT_READY');
 assert.equal(check(completed,'BOOK_FRESHNESS').status,'FAIL');
});

test('audit output includes only allowlisted public raw values and never exports arbitrary request strings, provider tokens or proofs',()=>{
 const input=older(),secret='unit-test-private-token';input.access_token=secret;input.requests[0].url='https://example.invalid/?token='+secret;
 input.requests[0].category=secret;input.operationalVerification={arbitrary:secret};
 input.markets[0].contractFields.unknown_secret={value:secret};input.markets[0].contractFields.tick_size.source=secret;
 input.markets[0].contractFields.min_trade_amount.source='currency=BTC:result[17].min_trade_amount';
 const report=reviewOrangeXEvidence(input,{now:NOW}),serialized=JSON.stringify(report);
 assert.doesNotMatch(serialized,new RegExp(secret));assert.equal(report.markets[0].contractFields.tick_size.source,null);
 assert.equal(report.markets[0].contractFields.tick_size.value,.1);assert.equal(report.requests[0].category,'UNVERIFIED');
 assert.equal(report.markets[0].contractFields.min_trade_amount.source,'currency=BTC:result[17].min_trade_amount');
 assert.equal(report.sourceAuthentication,'UNVERIFIED_REPORTING_DIGEST_IS_NOT_ORIGIN_PROOF');
});

test('file audit hashes exact BOM bytes, returns NOT_READY and preserves input and neighboring PNL and settings',()=>sandbox(directory=>{
 const file=path.join(directory,'public.json'),bytes=Buffer.from('\uFEFF'+JSON.stringify(latest()));fs.writeFileSync(file,bytes);
 fs.writeFileSync(path.join(directory,'store.json'),'existing PNL');fs.writeFileSync(path.join(directory,'.env'),'existing settings');
 const report=reviewOrangeXEvidenceFile(file,{now:NOW});assert.equal(report.sourceSHA256,createHash('sha256').update(bytes).digest('hex'));
 const command=fileURLToPath(new URL('../scripts/review-orangex-evidence.mjs',import.meta.url));
 const child=spawnSync(process.execPath,[command,'--input',file],{encoding:'utf8',env:{PATH:process.env.PATH,...(process.env.SystemRoot?{SystemRoot:process.env.SystemRoot}:{})}});
 assert.equal(child.status,1);assert.equal(JSON.parse(child.stdout).status,'NOT_READY');assert.equal(child.stderr,'');
 assert.ok(fs.readFileSync(file).equals(bytes));assert.equal(fs.readFileSync(path.join(directory,'store.json'),'utf8'),'existing PNL');
 assert.equal(fs.readFileSync(path.join(directory,'.env'),'utf8'),'existing settings');assert.equal(fs.readdirSync(directory).length,3);
}));

test('malformed, private and oversized files fail without printing their contents or altering evidence',()=>sandbox(directory=>{
 const file=path.join(directory,'invalid.json'),secret='unit-test-not-public-data';fs.writeFileSync(file,JSON.stringify({access_token:secret}));
 assert.throws(()=>reviewOrangeXEvidenceFile(file),/INVALID_PUBLIC_DIAGNOSTIC/);
 for(const args of [[],['--input'],['--input','x','--enable'],['--live','x']])assert.throws(()=>evidenceReviewOptions(args));
 fs.writeFileSync(file,'x'.repeat(4*1024*1024+1));assert.throws(()=>reviewOrangeXEvidenceFile(file),/INVALID_PUBLIC_JSON_FILE/);
 assert.equal(fs.statSync(file).size,4*1024*1024+1);assert.deepEqual(fs.readdirSync(directory),['invalid.json']);
}));
