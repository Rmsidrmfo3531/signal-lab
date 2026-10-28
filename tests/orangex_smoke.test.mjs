import test from 'node:test';
import assert from 'node:assert/strict';
import {publicCheckReport} from '../scripts/check-orangex-readonly.mjs';

const names=['BTC','ETH','SOL'].map(base=>base+'-USDT-PERPETUAL');
const books=()=>names.map(instrumentName=>({instrumentName,bid:99,ask:101,spreadBps:200,priceAt:1000,fresh:true,tradable:false}));
const error=(instrumentName,category,httpStatus=null)=>({instrumentName,category,code:category==='HTTP'?'HTTP_ERROR':'NETWORK_ERROR',
 message:'safe fixed diagnostic',httpStatus,transportCode:category==='DNS'?'ENOTFOUND':null,responseSource:'UNCONFIRMED'});
const report=(markets,errors=[])=>publicCheckReport({markets,errors,checkedAt:1001},names);

test('public check records all three observed books without claiming verified listings or authentication',()=>{
 const result=report(books());assert.equal(result.status,'observed');assert.equal(result.exitCode,0);
 assert.equal(result.requests.length,3);assert.deepEqual(result.requests.map(row=>row.symbol),['BTC','ETH','SOL']);
 assert.ok(result.requests.every(row=>row.listingStatus==='UNVERIFIED'&&row.bookStatus==='OBSERVED'));
 assert.equal(result.accountChecked,false);assert.equal(result.ordersSubmitted,false);assert.equal(result.officialSpecificationVerified,false);
 assert.equal(result.marketReadiness.publicDataReady,false,'book-only legacy observation is not market readiness');
 assert.ok(result.marketReadiness.blockingReasons.includes('READINESS_UNVERIFIED'));
});
test('HTTP 403 is reported with an unknown response source instead of claiming a proxy policy denial',()=>{
 const result=report([],names.map(name=>error(name,'HTTP',403)));
 assert.equal(result.status,'http_error');assert.equal(result.exitCode,1);
 assert.ok(result.requests.every(row=>row.diagnostic.httpStatus===403&&row.diagnostic.responseSource==='UNCONFIRMED'));
 assert.ok(result.requests.every(row=>row.bid===null&&row.priceAt===null&&row.listingStatus==='UNVERIFIED'));
});
test('DNS and TLS errors retain transport classification and use connection failure code 2',()=>{
 for(const category of ['DNS','TLS','TIMEOUT','NETWORK']){
  const result=report([],names.map(name=>error(name,category)));
  assert.equal(result.status,'transport_error');assert.equal(result.exitCode,2);
  assert.ok(result.errors.every(row=>row.category===category));
 }
});
test('a partial public response never hides a failed contract or returns a successful exit code',()=>{
 const result=report(books().slice(0,2),[error(names[2],'DNS')]);
 assert.equal(result.status,'partial');assert.equal(result.exitCode,2);assert.equal(result.observed.length,2);
 assert.equal(result.requests[2].bookStatus,'FAILED');assert.equal(result.requests[2].diagnostic.transportCode,'ENOTFOUND');
});
test('schema failures and stale timestamps are data failures rather than network policy blocks',()=>{
 const malformed=report([],names.map(name=>error(name,'SCHEMA',200)));
 assert.equal(malformed.status,'schema_error');assert.equal(malformed.exitCode,1);
 const stale=report(books().map(book=>({...book,fresh:false,priceAt:null})));
 assert.equal(stale.status,'stale_data');assert.equal(stale.exitCode,1);
 assert.ok(stale.requests.every(row=>row.bookStatus==='STALE_OR_UNDATED'&&row.priceAt===null));
});

test('detailed public smoke requires observed active listings and independently fresh ticker Mark in addition to books',()=>{
 const markets=books().map(row=>({...row,bookObserved:true,listingObserved:true,listingStatus:'OBSERVED_ACTIVE',active:true,
  markPrice:100,markPriceAt:1000,markPriceFresh:true}));
 const run=(rows,errors=[])=>publicCheckReport({markets:rows,errors,checkedAt:1001,includePublicDetails:true,listingCurrency:'USDT'},names);
 assert.equal(run(markets).exitCode,0);assert.equal(run(markets).officialSpecificationVerified,false);
 for(const patch of [{active:null},{listingObserved:false},{markPriceFresh:false},{bookObserved:false,bid:null,ask:null}]){
  const result=run(markets.map((row,index)=>index===0?{...row,...patch}:row));assert.notEqual(result.exitCode,0);
 }
 assert.notEqual(run(markets,[{...error(names[0],'HTTP',400),endpoint:'ticker'}]).exitCode,0);
});
