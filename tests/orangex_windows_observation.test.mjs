import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {publicCheckReport} from '../scripts/check-orangex-readonly.mjs';
import {publicProbeURL} from '../scripts/diagnose-orangex-public.mjs';
import {orangeXContractDetails,orangeXView} from '../public/orangex.js';

// User-provided Windows diagnostic observations, not synthetic exchange responses.
// This file contains no original HTTP response bodies or order-book quantities.
const fixtureURL=new URL('./fixtures/orangex/windows-public-diagnostic-20261027.json',import.meta.url);
const originalText=fs.readFileSync(fixtureURL,'utf8');
const diagnostic=JSON.parse(originalText);
const instruments=diagnostic.markets.map(row=>row.instrumentName);
const sourceTimes=[1793077844447,1793077844585,1793077844731];
const captureStart=Date.parse(diagnostic.checkedAt);

// Display-only shape conversion. It never adds missing depth, units, Mark or a
// successful live connection. Captured freshness remains historical evidence.
const replayRows=()=>diagnostic.markets.map(row=>({
 symbol:row.asset,instrumentName:row.instrumentName,actualInstrumentName:row.instrumentName,
 listingObserved:row.listingObserved,active:row.active,listingStatus:'OBSERVED_ACTIVE',
 bid:row.book.bid,ask:row.book.ask,spreadBps:row.book.spreadBps,priceAt:row.book.timestamp,
 fresh:false,markPrice:row.markPrice,markPriceAt:row.markPriceTimestamp,markPriceFresh:false,
 contractFields:structuredClone(row.contractFields),tradable:false,instrumentVerified:false,
 minQty:null,qtyStep:null,priceTick:null
}));

test('the original Windows evidence records exactly six public HTTP 200 reads without source or official verification',()=>{
 assert.equal(diagnostic.kind,'ORANGEX_PUBLIC_DIAGNOSTIC');assert.equal(diagnostic.mode,'READ_ONLY');
 assert.equal(diagnostic.exitCode,0);assert.equal(diagnostic.status,'PUBLIC_RESPONSES_OBSERVED');
 assert.equal(diagnostic.officialSpecificationVerified,false);assert.equal(diagnostic.accountChecked,false);assert.equal(diagnostic.ordersSubmitted,false);
 assert.deepEqual(diagnostic.requests.map(row=>row.kind),['docs','instruments','tickers','book','book','book']);
 for(const row of diagnostic.requests){
  assert.equal(row.method,'GET');assert.equal(row.httpStatus,200);assert.equal(row.status,'OBSERVED');
  assert.equal(row.responseSource,'UNCONFIRMED');assert.equal(row.parameterSpecificationVerified,false);
 }
 // These were successful legacy probes. They do not prove parameters optional.
 assert.equal(new URL(diagnostic.requests[1].url).search,'');
 assert.equal(new URL(diagnostic.requests[2].url).search,'');
 assert.equal(new URL(publicProbeURL('instruments')).searchParams.get('currency'),'USDT');
 assert.equal(new URL(publicProbeURL('tickers',instruments[0])).searchParams.get('instrument_name'),instruments[0]);
});

test('actual listed names, minimum raw values and commission observations remain distinct and unit-unverified',()=>{
 assert.deepEqual(instruments,['BTC-USDT-PERPETUAL','ETH-USDT-PERPETUAL','SOL-USDT-PERPETUAL']);
 const values=[[.001,10,.1],[.01,10,.01],[.1,100,.01]];
 diagnostic.markets.forEach((row,index)=>{
  assert.equal(row.listingObserved,true);assert.equal(row.active,true);
  assert.match(row.contractNameSource,/^result\[(17|31|66)\]\.instrument_name$/);
  for(const [key,value] of [['min_trade_amount',values[index][0]],['min_notional',values[index][1]],['tick_size',values[index][2]],
   ['maker_commission',.0002],['taker_commission',.0006]]){
   assert.equal(row.contractFields[key].value,value);assert.equal(row.contractFields[key].units,'UNVERIFIED');
  }
  assert.equal(row.contractFields.base_currency.value,'USDT');assert.equal(row.contractFields.quote_currency.value,row.asset);
  assert.equal(row.contractFields.kind.value,'perpetual');assert.equal(row.feeUnitsVerified,false);
  assert.equal(row.minimumOrderQuantityVerified,false);assert.equal(row.orderSubmissionEnabled,false);
 });
});

test('captured best prices agree with the observed tick grid without inventing depth or quantity precision',()=>{
 const expected=[[79743.2,79743.3,.1],[2311.98,2311.99,.01],[100.05,100.06,.01]];
 diagnostic.markets.forEach((row,index)=>{
  const {bid,ask,spread,spreadBps}=row.book,tick=row.contractFields.tick_size.value;
  assert.equal(bid,expected[index][0]);assert.equal(ask,expected[index][1]);assert.ok(bid<ask);
  for(const price of [bid,ask])assert.ok(Math.abs(price/tick-Math.round(price/tick))<1e-8);
  assert.ok(Math.abs((ask-bid)-expected[index][2])<1e-10);
  assert.ok(Math.abs(spread-(ask-bid))<1e-12);
  assert.ok(Math.abs(spreadBps-(ask-bid)/((ask+bid)/2)*10000)<1e-12);
  assert.equal(Object.hasOwn(row.book,'bids'),false);assert.equal(Object.hasOwn(row.book,'asks'),false);
 });
});

test('the source timestamps and ages describe collection-time freshness rather than a current live quote',()=>{
 assert.equal(new Date(captureStart+9*3600000).toISOString(),'2026-10-27T14:10:44.056Z');
 const localTimes=['2026-10-27T14:10:44.447Z','2026-10-27T14:10:44.585Z','2026-10-27T14:10:44.731Z'];
 diagnostic.markets.forEach((row,index)=>{
  assert.equal(row.book.timestamp,sourceTimes[index]);assert.equal(row.book.ageMs,[199,200,198][index]);
  assert.equal(row.book.fresh,true);assert.ok(row.book.timestamp>captureStart,'legacy checkedAt is the run start');
  assert.equal(new Date(row.book.timestamp+9*3600000).toISOString(),localTimes[index]);
  assert.equal(row.book.timestampUnits,'MILLISECONDS_BY_MAGNITUDE_UNVERIFIED');
 });
 for(const row of diagnostic.requests.filter(row=>row.kind==='book'))assert.equal(row.schemaObservation.knownResultFields.timestamp,'STRING');
 // The current replay has no fresh connection, irrespective of the old flags.
 assert.ok(replayRows().every(row=>row.fresh===false));
});

test('missing minimum quantity, contract size, increments and per-contract Mark stay genuinely absent',()=>{
 assert.equal(diagnostic.requests.some(row=>row.kind==='tickers'&&row.instrumentName!==null),false);
 for(const row of diagnostic.markets){
  assert.deepEqual(row.tickerFields,{});
  for(const key of ['min_qty','contract_size','qty_step','quantity_step','quantity_increment'])assert.equal(Object.hasOwn(row.contractFields,key),false);
  for(const key of ['markPrice','markPriceSource','markPriceTimestamp','markPriceTimestampSource','markPriceTimestampUnits','markPriceAgeMs','markPriceFresh'])
   assert.equal(row[key],null);
  assert.equal(row.book.markPrice,null);assert.equal(row.book.markPriceSource,null);
 }
});

test('the historical success does not satisfy the newer per-contract Mark requirements and the fixture is not mutated',()=>{
 const captureRows=replayRows().map((row,index)=>({...row,bookObserved:true,fresh:diagnostic.markets[index].book.fresh}));
 const report=publicCheckReport({markets:captureRows,errors:[],checkedAt:captureStart,includePublicDetails:true},instruments);
 assert.equal(report.exitCode,1);assert.equal(report.status,'market_validation_failed');
 assert.ok(report.requests.every(row=>row.bookStatus==='OBSERVED'&&row.markPrice===null&&!row.markPriceFresh));
 assert.equal(report.officialSpecificationVerified,false);assert.equal(report.ordersSubmitted,false);
 assert.equal(diagnostic.exitCode,0,'new requirements must not rewrite the original result');
 assert.equal(JSON.stringify(JSON.parse(originalText)),JSON.stringify(diagnostic));
 assert.equal(fs.readFileSync(fixtureURL,'utf8'),originalText);
});

test('displaying real Windows observations remains a historical replay with unknown Mark, units and account PNL',()=>{
 const markets=replayRows(),payload={mode:'READ_ONLY',enabled:false,connected:false,account:null,
  dataSource:'WINDOWS_DIAGNOSTIC_REPLAY',verification:{officialSpec:'UNVERIFIED',liveConnection:'UNTESTED'},markets};
 const view=orangeXView(payload),details=orangeXContractDetails(markets,{dataSource:payload.dataSource,now:captureStart+86400000});
 assert.equal(view.connected,false);assert.equal(view.hasAccount,false);assert.match(view.metrics,/Windows 진단 재생 · 현재 실시간 응답 아님/);
 assert.match(view.markets,/시세 만료\/미확인/);assert.doesNotMatch(view.markets,/>거래 가능</);
 assert.match(details,/<dt>base_currency<\/dt><dd>USDT/);assert.match(details,/<dt>quote_currency<\/dt><dd>BTC/);
 assert.match(details,/<dt>min_trade_amount<\/dt><dd>0\.001/);assert.match(details,/<dt>min_notional<\/dt><dd>100<small>/);
 for(const key of ['min_qty','contract_size','qty_step'])assert.match(details,new RegExp(`<dt>${key}</dt><dd>미관측`));
 assert.match(details,/Mark 미확인/);assert.match(details,/수수료|Maker·Taker/);
 assert.match(details,/단위가 확인되지 않아 %·bp·예상 비용으로 환산하지 않습니다/);
 assert.doesNotMatch(view.pnl,/\$0/);assert.ok(markets.every(row=>!Object.hasOwn(row,'bids')&&!Object.hasOwn(row,'asks')));
 assert.equal(fs.readFileSync(fixtureURL,'utf8'),originalText);
});
