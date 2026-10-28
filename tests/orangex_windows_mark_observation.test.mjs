import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {orangeXBookIntegrity,orangeXMarketReadiness} from '../orangex_listing_domains.mjs';

// Actual diagnostic summary pasted by the user after running it on Windows.
// Whitespace/key layout was normalized when preserving the JSON. This is not a
// synthetic exchange response, an original HTTP body or independent source proof.
const fixtureURL=new URL('./fixtures/orangex/windows-public-diagnostic-20261027-usdt-mark-depth.json',import.meta.url);
const originalText=fs.readFileSync(fixtureURL,'utf8');
const evidence=JSON.parse(originalText);
const captureEvaluation=Math.max(...evidence.markets.flatMap(row=>[
 row.book.timestamp+row.book.ageMs,row.markPriceTimestamp+row.markPriceAgeMs
]));
const replayRows=()=>evidence.markets.map(row=>({
 instrumentName:row.instrumentName,listingObserved:row.listingObserved,active:row.active,
 listingDomainEligible:false,listingConflict:false,contractFields:structuredClone(row.contractFields),
 bookObserved:true,bid:row.book.bid,ask:row.book.ask,priceAt:row.book.timestamp,fresh:true,
 bids:structuredClone(row.book.bids),asks:structuredClone(row.book.asks),
 bookIntegrity:orangeXBookIntegrity(row.book),
 markPrice:row.markPrice,markPriceAt:row.markPriceTimestamp,markPriceFresh:true
}));

test('latest actual Windows summary preserves eight HTTP 200 GETs and the legacy successful exit without claiming verification',()=>{
 assert.equal(evidence.kind,'ORANGEX_PUBLIC_DIAGNOSTIC');assert.equal(evidence.mode,'READ_ONLY');
 assert.equal(evidence.checkedAt,'2026-10-27T12:37:02.419Z');assert.equal(evidence.currency,'USDT');
 assert.equal(evidence.exitCode,0);assert.equal(evidence.status,'PUBLIC_RESPONSES_OBSERVED');
 assert.equal(evidence.officialSpecificationVerified,false);assert.equal(evidence.accountChecked,false);assert.equal(evidence.ordersSubmitted,false);
 assert.deepEqual(evidence.requests.map(row=>row.kind),['docs','instruments','tickers','book','tickers','book','tickers','book']);
 for(const row of evidence.requests){
  assert.equal(row.httpStatus,200);assert.equal(row.method,'GET');assert.equal(row.status,'OBSERVED');
  assert.equal(row.responseSource,'UNCONFIRMED');assert.equal(row.parameterSpecificationVerified,false);
 }
 const listingRequest=evidence.requests.find(row=>row.kind==='instruments');
 assert.equal(new URL(listingRequest.url).searchParams.get('currency'),'USDT');
 assert.equal(listingRequest.schemaObservation.resultType,'ARRAY');
 assert.equal(Object.hasOwn(listingRequest,'instrumentCount'),false,'the summary does not reveal whether the array was empty or merely unmatched');
});

test('all three latest contracts remain unlisted observations without importing older minimums, ticks or fees',()=>{
 const previous=JSON.parse(fs.readFileSync(new URL('./fixtures/orangex/windows-public-diagnostic-20261027.json',import.meta.url),'utf8'));
 assert.deepEqual(evidence.markets.map(row=>row.instrumentName),['BTC-USDT-PERPETUAL','ETH-USDT-PERPETUAL','SOL-USDT-PERPETUAL']);
 evidence.markets.forEach((row,index)=>{
  assert.equal(previous.markets[index].listingObserved,true);assert.ok(Object.keys(previous.markets[index].contractFields).length>0);
  assert.equal(row.contractNameSource,'SDK_CANDIDATE_ONLY');assert.equal(row.listingObserved,false);assert.equal(row.active,null);
  assert.deepEqual(row.contractFields,{});assert.deepEqual(row.tickerFields,{});
  for(const key of ['min_qty','min_trade_amount','min_notional','tick_size','contract_size','qty_step','quantity_step','maker_commission','taker_commission'])
   assert.equal(Object.hasOwn(row.contractFields,key),false);
  assert.deepEqual(row.precisionObservations,{priceTick:null,quantityCandidates:[]});
  assert.equal(row.minimumOrderQuantityVerified,false);assert.equal(row.quantityIncrementVerified,false);assert.equal(row.feeUnitsVerified,false);
  assert.equal(row.orderSubmissionEnabled,false);
 });
});

test('actual per-contract Mark and best quotes retain their independent timestamps and historical age flags',()=>{
 const expected=[
  [80205.3,80205.4,1793104606846,16944,80205.3,1793104606391,17400],
  [2326.27,2326.28,1793104607142,16933,2326.27,1793104606623,17452],
  [100.61,100.62,1793104607385,16930,100.6,1793104606389,17926]
 ];
 evidence.markets.forEach((row,index)=>{
  const [bid,ask,bookAt,bookAge,mark,markAt,markAge]=expected[index];
  assert.equal(row.book.bid,bid);assert.equal(row.book.ask,ask);assert.equal(row.book.timestamp,bookAt);assert.equal(row.book.ageMs,bookAge);
  assert.equal(row.markPrice,mark);assert.equal(row.markPriceTimestamp,markAt);assert.equal(row.markPriceAgeMs,markAge);
  assert.equal(row.book.fresh,true);assert.equal(row.markPriceFresh,true);assert.notEqual(bookAt,markAt);
  assert.equal(row.markPriceSource,'result[0].mark_price');assert.equal(row.markPriceTimestampSource,'result[0].timestamp');
  assert.equal(row.book.markPrice,null);assert.equal(row.book.markPriceSource,null);
  assert.equal(row.markPriceTimestampUnits,'MILLISECONDS_BY_MAGNITUDE_UNVERIFIED');
  assert.equal(row.book.timestampUnits,'MILLISECONDS_BY_MAGNITUDE_UNVERIFIED');
  assert.ok(evidence.requests.some(request=>request.kind==='tickers'&&request.instrumentName===row.instrumentName));
 });
 assert.notEqual(evidence.markets[2].markPrice,(evidence.markets[2].book.bid+evidence.markets[2].book.ask)/2,'Mark is not synthesized from midpoint');
});

test('ETH depth preserves the supplied 22 asks and repeated out-of-order levels instead of silently repairing them',()=>{
 const [btc,eth,sol]=evidence.markets;
 assert.deepEqual(evidence.markets.map(row=>[row.book.bids.length,row.book.asks.length]),[[20,20],[20,22],[20,20]]);
 assert.deepEqual(eth.book.asks.slice(7,11),[[2326.35,7.15],[2326.36,1.43],[2326.35,7.15],[2326.36,1.43]]);
 const integrity=orangeXBookIntegrity(eth.book);
 assert.equal(integrity.valid,false);assert.equal(integrity.bidLevels,20);assert.equal(integrity.askLevels,22);
 assert.ok(integrity.issues.includes('BOOK_DUPLICATE_PRICE'));assert.ok(integrity.issues.includes('BOOK_UNSORTED'));
 assert.ok(integrity.issues.includes('BOOK_DEPTH_EXCEEDED'));
 assert.equal(orangeXBookIntegrity(btc.book).valid,true);assert.equal(orangeXBookIntegrity(sol.book).valid,true);
 assert.equal(eth.book.asks.length,22,'validation must not mutate the observed book');
});

test('all successful HTTP responses and capture-fresh Marks cannot satisfy listing or PAPER readiness',()=>{
 const rows=replayRows(),readiness=orangeXMarketReadiness(rows,{now:captureEvaluation});
 assert.equal(readiness.publicDataReady,false);assert.equal(readiness.ready,false);assert.equal(readiness.tradingReady,false);assert.equal(readiness.paperReady,false);
 assert.ok(readiness.publicDataReasons.includes('LISTING_UNOBSERVED'));assert.ok(readiness.publicDataReasons.includes('LISTING_ACTIVE_UNKNOWN'));
 assert.ok(readiness.publicDataReasons.includes('LISTING_DOMAIN_UNVERIFIED'));
 assert.ok(readiness.markets.every(row=>!row.reasons.includes('MARK_STALE')&&!row.reasons.includes('BOOK_STALE')));
 const eth=readiness.markets.find(row=>row.instrumentName==='ETH-USDT-PERPETUAL');
 assert.ok(eth.reasons.includes('BOOK_DUPLICATE_PRICE'));assert.ok(eth.reasons.includes('BOOK_UNSORTED'));
 assert.equal(evidence.exitCode,0,'new validation does not rewrite the historical diagnostic result');
 assert.equal(fs.readFileSync(fixtureURL,'utf8'),originalText);
});

test('historical fresh flags cannot keep either book or Mark ready after its own source clock expires',()=>{
 const rows=replayRows(),later=captureEvaluation+90001;
 const readiness=orangeXMarketReadiness(rows,{now:later});
 assert.equal(readiness.publicDataReady,false);
 for(const row of readiness.markets){assert.ok(row.reasons.includes('BOOK_STALE'));assert.ok(row.reasons.includes('MARK_STALE'))}
 assert.ok(evidence.markets.every(row=>row.book.fresh&&row.markPriceFresh),'original historical observations remain unchanged');
 assert.equal(fs.readFileSync(fixtureURL,'utf8'),originalText);
});
