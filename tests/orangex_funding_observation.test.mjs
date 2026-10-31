import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {orangeXFundingURL,orangeXFundingProbe,normalizeOrangeXFundingObservation} from '../orangex_funding_observation.mjs';

// All response rows here are synthetic protocol fixtures, never live rates.
const NOW=Date.parse('2026-10-31T00:59:19.246Z');
const row=asset=>({instrument_name:asset+'-USDT-PERPETUAL',funding_rate:'-0.0001',next_funding_rate:'0.0002',next_funding_rate_timestamp:1793433600});
const ok=body=>({category:'OK',httpStatus:200,processClosed:true,body:JSON.stringify(body)});
const options={receivedAt:NOW,dataSource:'SYNTHETIC_TEST'};
const all=()=>['BTC','ETH','SOL'].map(row);

test('funding transport uses one fixed PUBLIC GET and preserves proxy/CA and process cleanup without authentication',async()=>{
 let invocation;
 const spawnProcess=(command,args,configuration)=>{
  invocation={command,args,configuration};const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();
  queueMicrotask(()=>{child.stdout.write('{"result":[]}\n__SIGNALLAB_CURL_STATUS__200,200');child.stderr.write('private-proxy-detail');child.emit('close',0)});return child;
 };
 const observed=await orangeXFundingProbe({spawnProcess,platform:'win32',targetURL:'https://evil.invalid/private'});
 assert.equal(orangeXFundingURL(),'https://api.orangex.com/api/v1/public/coin_gecko_contracts');
 assert.equal(invocation.args[invocation.args.indexOf('--url')+1],orangeXFundingURL());assert.equal(invocation.command,'curl.exe');
 assert.equal(invocation.args[0],'--disable');assert.equal(invocation.args[invocation.args.indexOf('--request')+1],'GET');
 assert.equal(invocation.configuration.shell,false);assert.equal(Object.hasOwn(invocation.configuration,'env'),false);
 for(const flag of ['--user','--netrc','--data','--location','--insecure','--noproxy','--proxy'])assert.ok(!invocation.args.includes(flag));
 assert.equal(observed.processClosed,true);assert.equal(observed.url,orangeXFundingURL());assert.doesNotMatch(JSON.stringify(observed),/private-proxy-detail|evil\.invalid/);
});

test('matched raw current/forecast rates are distinct and never become a schedule, unit or realized funding',()=>{
 const result=normalizeOrangeXFundingObservation(ok({result:all()}),options);
 assert.equal(result.observationStatus,'PASS');assert.equal(result.syntheticTest,true);assert.equal(result.status,'NOT_READY');
 for(const item of result.markets){
  assert.equal(item.matchedBy,'instrument_name');assert.equal(item.fields.funding_rate.value,'-0.0001');
  assert.equal(item.fields.next_funding_rate.value,'0.0002');assert.equal(item.fields.next_funding_rate_timestamp.value,1793433600);
  assert.equal(item.fields.next_funding_rate_timestamp.type,'NUMBER');assert.equal(item.actualScheduleVerified,false);
  assert.equal(item.actualFundingEstimate,null);assert.equal(item.nextRateIsRealizedFunding,false);assert.equal(item.entryEligible,false);
 }
 assert.equal(result.activationAllowed,false);assert.equal(result.paperAutoEntryEnabled,false);assert.equal(result.liveOrdersEnabled,false);
 assert.equal(result.rateUnit,'UNVERIFIED');assert.equal(result.fundingHistoryRecovery,'UNVERIFIED');
});

test('numeric zero is preserved as an observed raw rate but a missing rate is not filled with zero',()=>{
 const rows=all();rows[0].funding_rate=0;delete rows[1].funding_rate;
 const result=normalizeOrangeXFundingObservation(ok(rows),options);
 assert.equal(result.markets[0].fields.funding_rate.value,0);assert.equal(result.markets[0].fields.funding_rate.observationStatus,'PASS');
 assert.equal(result.markets[1].fields.funding_rate.present,false);assert.equal(result.markets[1].fields.funding_rate.value,null);
 assert.equal(result.observationStatus,'UNVERIFIED');assert.equal(result.markets[1].actualFundingEstimate,null);
});

test('ticker identifiers and partial symbol names are not guessed into exact OrangeX contract mappings',()=>{
 const rows=all().map(({instrument_name,...fields})=>({...fields,ticker_id:instrument_name.replace('-USDT-PERPETUAL','_USDT'),symbol:instrument_name.replaceAll('-','')}));
 const result=normalizeOrangeXFundingObservation(ok({result:rows}),options);
 assert.equal(result.observationStatus,'UNVERIFIED');assert.ok(result.markets.every(item=>item.exactMatches===0&&item.matchedBy===null));
 assert.deepEqual(result.schema.knownFields.ticker_id,['STRING']);assert.doesNotMatch(JSON.stringify(result),/BTC_USDT/);
});

test('duplicate exact contracts, invalid numeric fields and API errors fail without retaining arbitrary values',()=>{
 const duplicate=normalizeOrangeXFundingObservation(ok({result:[...all(),row('BTC')]}),options);
 assert.equal(duplicate.observationStatus,'FAIL');assert.equal(duplicate.markets[0].reason,'DUPLICATE_EXACT_INSTRUMENT');
 assert.deepEqual(duplicate.markets[0].fields,{});
 const rows=all();rows[0].funding_rate='private-token-do-not-export';rows[1].next_funding_rate_timestamp=0;
 const invalid=normalizeOrangeXFundingObservation(ok({result:rows}),options);
 assert.equal(invalid.observationStatus,'FAIL');assert.doesNotMatch(JSON.stringify(invalid),/private-token-do-not-export/);
 const error=normalizeOrangeXFundingObservation(ok({error:{message:'private-api-detail'},result:all()}),options);
 assert.equal(error.observationStatus,'FAIL');assert.equal(error.reason,'API_ERROR');assert.doesNotMatch(JSON.stringify(error),/private-api-detail/);
});

test('HTTP200 is insufficient with unknown schema, absent process closure or an unclosed process',()=>{
 const schema=normalizeOrangeXFundingObservation(ok({result:{contracts:all(),unknown_secret:'hidden'}}),options);
 assert.equal(schema.observationStatus,'UNVERIFIED');assert.equal(schema.reason,'RESPONSE_SCHEMA_UNVERIFIED');
 assert.doesNotMatch(JSON.stringify(schema),/unknown_secret|hidden/);
 const missingClose=normalizeOrangeXFundingObservation({...ok(all()),processClosed:undefined},options);
 assert.equal(missingClose.observationStatus,'UNVERIFIED');assert.ok(missingClose.markets.every(item=>item.exactMatches===0));
 const notClosed=normalizeOrangeXFundingObservation({...ok(all()),processClosed:false},options);
 assert.equal(notClosed.observationStatus,'FAIL');assert.equal(notClosed.reason,'PROCESS_TERMINATION_UNCONFIRMED');
});

test('transport policy failure remains distinct from exchange HTTP and never manufactures funding rows',()=>{
 const result=normalizeOrangeXFundingObservation({category:'PROXY_CONNECT_REJECTED',httpStatus:null,proxyConnectStatus:403,processClosed:true,body:'private-transport-data'},options);
 assert.equal(result.transport.category,'PROXY_CONNECT_REJECTED');assert.equal(result.transport.httpStatus,null);
 assert.equal(result.observationStatus,'UNVERIFIED');assert.ok(result.markets.every(item=>Object.keys(item.fields).length===0));
 assert.doesNotMatch(JSON.stringify(result),/private-transport-data/);
});

test('next timestamps of either apparent magnitude are preserved without deducing eight-hour intervals or current freshness',()=>{
 const rows=all();rows[0].next_funding_rate_timestamp='1793433600000';rows[1].next_funding_rate_timestamp='1793433600';
 rows[2].next_funding_rate_timestamp='2026-10-31T08:00:00Z';
 const result=normalizeOrangeXFundingObservation(ok({result:rows}),options);
 assert.equal(result.markets[0].fields.next_funding_rate_timestamp.value,'1793433600000');
 assert.equal(result.markets[1].fields.next_funding_rate_timestamp.value,'1793433600');
 assert.equal(result.markets[2].fields.next_funding_rate_timestamp.value,'2026-10-31T08:00:00Z');
 assert.equal(result.markets[0].nextTimestampMeaningVerified,false);assert.equal(result.markets[0].currentFundingSourceTimestampObserved,false);
 assert.equal(result.markets[0].actualScheduleVerified,false);assert.equal(result.schema.responseSchemaOfficiallyVerified,false);
 assert.throws(()=>normalizeOrangeXFundingObservation(ok(all()),{...options,receivedAt:0}),/OPTIONS/);
 assert.throws(()=>normalizeOrangeXFundingObservation(ok(all()),{...options,dataSource:'HISTORICAL_REPLAY'}),/OPTIONS/);
});

test('synthetic and replay transport labels cannot be promoted to real observations by default options',()=>{
 for(const tag of [{syntheticTest:true},{dataSource:'SYNTHETIC_FIXTURE'},{dataSource:'MOCK'},{executionMode:'SYNTHETIC_TEST'}]){
  const result=normalizeOrangeXFundingObservation({...ok(all()),...tag},{receivedAt:NOW});
  assert.equal(result.dataSource,'SYNTHETIC_TEST');assert.equal(result.syntheticTest,true);assert.equal(result.status,'NOT_READY');
 }
 for(const tag of [{executionMode:'HISTORICAL_REPLAY'},{runKind:'BACKTEST'},{dataSource:'HISTORICAL_PUBLIC_OBSERVATION'}]){
  const result=normalizeOrangeXFundingObservation({...ok(all()),...tag},{receivedAt:NOW});
  assert.equal(result.dataSource,'HISTORICAL_REPLAY');assert.equal(result.status,'NOT_READY');
 }
});
