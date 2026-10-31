import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {evaluateOrangeXReadiness} from '../orangex_readiness.mjs';

const NOW=Date.parse('2026-10-29T03:00:00Z');
const ASSETS=['BTC','ETH','SOL'];
const doc='https://openapi-docs.orangex.com/';
const proof=extra=>({status:'VERIFIED',officialDocumentURL:doc,reviewedAt:NOW-100,...extra});
const raw=(value)=>({value,units:'UNVERIFIED'});
const observed=(asset)=>({asset,instrumentName:asset+'-USDT-PERPETUAL',actualInstrumentName:asset+'-USDT-PERPETUAL',
 listingObserved:true,active:true,listingConflict:false,listingDomainEligible:true,listingSourceCurrency:'BTC',
 contractFields:{contract_size:raw(1),min_qty:raw(.001),min_trade_amount:raw(.001),qty_step:raw(.001),min_notional:raw(10),
  tick_size:raw(.1),maker_commission:raw(.0002),taker_commission:raw(.0006),base_currency:raw('USDT'),quote_currency:raw(asset),kind:raw('perpetual')},
 book:{bids:[[100,.002],[99.9,.003]],asks:[[100.1,.004],[100.2,.005]],timestamp:NOW-500},
 markPrice:100.05,markPriceTimestamp:NOW-600,
 fundingObservation:{rate:.0001,intervalMs:28800000,settlementAnchorAt:Date.parse('2026-10-29T00:00:00Z'),observedAt:NOW-1000},
 binanceObservation:{symbol:asset+'USDT',price:100.04,timestamp:NOW-550,dataSource:'BINANCE_PUBLIC_API'}});
const marketProof=asset=>({
 listing:proof({instrumentName:asset+'-USDT-PERPETUAL',active:true,kind:'PERPETUAL',tradingArea:'BTC'}),
 contractSize:proof({rawField:'contract_size',value:1,unit:'BASE_PER_CONTRACT'}),
 quantityUnit:proof({value:'CONTRACT'}),
 minimumQuantity:proof({rawField:'min_qty',value:.001,unit:'CONTRACT',meaning:'MINIMUM_ORDER_QUANTITY'}),
 quantityIncrement:proof({rawField:'qty_step',value:.001,unit:'CONTRACT',meaning:'ORDER_QUANTITY_INCREMENT'}),
 minNotional:proof({rawField:'min_notional',value:10,unit:'USDT'}),priceTick:proof({rawField:'tick_size',value:.1,unit:'USDT'}),
 fees:proof({makerField:'maker_commission',takerField:'taker_commission',makerRaw:.0002,takerRaw:.0006,unit:'FRACTION'}),
 funding:proof({rate:.0001,intervalMs:28800000,settlementAnchorAt:Date.parse('2026-10-29T00:00:00Z'),rateUnit:'FRACTION',positiveRateMeaning:'LONG_PAYS_SHORT'}),
 timestampUnits:proof({book:'MILLISECONDS',mark:'MILLISECONDS'}),
 binanceMapping:proof({instrumentName:asset+'-USDT-PERPETUAL',binanceSymbol:asset+'USDT',baseAsset:asset,quoteAsset:'USDT',settlementAsset:'USDT',
  contractType:'LINEAR_PERPETUAL',contractSizeBase:1,exchangeCurrencyDefinitions:{base_currency:'SETTLEMENT_ASSET',quote_currency:'UNDERLYING_ASSET'}})
});
function syntheticEvidence(){
 return {kind:'ORANGEX_PUBLIC_DIAGNOSTIC',mode:'READ_ONLY',dataSource:'SYNTHETIC_TEST',syntheticTest:true,markets:ASSETS.map(observed),
  sourceEvidenceSHA256:'a'.repeat(64),operationalVerification:{schemaVersion:1,
   provenance:proof({responseOrigin:'ORANGEX',observationType:'PUBLIC_API',observedAt:NOW-1000,sourceEvidenceSHA256:'a'.repeat(64)}),
   markets:Object.fromEntries(ASSETS.map(asset=>[asset+'-USDT-PERPETUAL',marketProof(asset)]))}};
}
const evaluate=input=>evaluateOrangeXReadiness(input,{now:NOW});
const check=(result,id,asset='BTC')=>result.markets.find(row=>row.asset===asset).checks.find(row=>row.id===id);

test('complete hypothetical reviewed fields remain synthetic and never permit operational activation',()=>{
 const input=syntheticEvidence(),before=structuredClone(input),result=evaluate(input);
 assert.equal(result.status,'NOT_READY');assert.equal(result.checks.find(row=>row.id==='SOURCE_PROVENANCE').status,'FAIL');
 assert.ok(result.markets.every(row=>row.status==='NOT_READY'));
 assert.ok(result.markets.every(row=>row.checks.every(item=>item.status==='PASS')),'the synthetic protocol exercises all individual reviewed checks');
 assert.equal(result.activationAllowed,false);assert.equal(result.realDataAutoEntryEnabled,false);assert.equal(result.liveOrdersEnabled,false);
 assert.equal(result.orderSubmissionEnabled,false);assert.equal(result.mode,'READ_ONLY');assert.equal(result.scope,'MARKET_DATA_PRECONDITIONS_ONLY');
 assert.deepEqual(input,before);assert.equal(result.summary.PASS+result.summary.FAIL+result.summary.UNVERIFIED,result.summary.total);
});

test('the actual latest Windows summary remains NOT_READY despite eight HTTP 200 and historical fresh flags',()=>{
 const url=new URL('./fixtures/orangex/windows-public-diagnostic-20261027-usdt-mark-depth.json',import.meta.url),text=fs.readFileSync(url,'utf8'),input=JSON.parse(text);
 const result=evaluate(input);assert.equal(result.status,'NOT_READY');
 assert.equal(result.checks.find(row=>row.id==='SOURCE_PROVENANCE').status,'UNVERIFIED');
 assert.equal(check(result,'CONTRACT_NAME').status,'UNVERIFIED');assert.equal(check(result,'LISTING_ACTIVE').status,'UNVERIFIED');
 for(const id of ['CONTRACT_SIZE','QUANTITY_UNIT','MINIMUM_QUANTITY','QUANTITY_INCREMENT','FEE_UNITS','FUNDING','BINANCE_MAPPING'])
  assert.equal(check(result,id).status,'UNVERIFIED',id);
 assert.equal(check(result,'BOOK_FRESHNESS').status,'FAIL');assert.equal(check(result,'MARK_FRESHNESS').status,'FAIL');
 assert.equal(check(result,'BOOK_INTEGRITY','ETH').status,'FAIL');assert.equal(fs.readFileSync(url,'utf8'),text);
 assert.equal(input.requests.filter(row=>row.httpStatus===200).length,8);
});

test('the older six-response observation cannot supply missing Mark or official quantity and fee meanings',()=>{
 const input=JSON.parse(fs.readFileSync(new URL('./fixtures/orangex/windows-public-diagnostic-20261027.json',import.meta.url),'utf8')),
  result=evaluateOrangeXReadiness(input,{now:Math.max(...input.markets.map(row=>row.book.timestamp+row.book.ageMs))});
 assert.equal(result.status,'NOT_READY');assert.equal(check(result,'MARK_FRESHNESS').status,'UNVERIFIED');
 assert.equal(check(result,'MINIMUM_QUANTITY').status,'UNVERIFIED');assert.equal(check(result,'QUANTITY_INCREMENT').status,'UNVERIFIED');
 assert.equal(check(result,'FEE_UNITS').status,'UNVERIFIED');assert.equal(check(result,'CONTRACT_NAME').status,'UNVERIFIED');
});

test('raw minimum trade amount is not substituted for min_qty or an order quantity increment',()=>{
 const input=syntheticEvidence();delete input.operationalVerification;
 for(const row of input.markets){delete row.contractFields.min_qty;delete row.contractFields.qty_step;row.minimumOrderQuantityVerified=true;row.quantityIncrementVerified=true;row.feeUnitsVerified=true}
 const result=evaluate(input);
 assert.equal(check(result,'MINIMUM_QUANTITY').status,'UNVERIFIED');assert.equal(check(result,'QUANTITY_INCREMENT').status,'UNVERIFIED');
 assert.equal(check(result,'MINIMUM_QUANTITY').observed.minTradeAmount,.001);assert.equal(check(result,'MINIMUM_QUANTITY').observed.minQty,null);
 assert.equal(check(result,'FEE_UNITS').observed.makerRaw,.0002);assert.equal(check(result,'FEE_UNITS').observed.takerRaw,.0006);
 assert.equal(check(result,'FEE_UNITS').status,'UNVERIFIED');
});

test('field and unit proofs must match observations and cannot borrow minimum quantities as increments',()=>{
 for(const mutate of [
  input=>{input.operationalVerification.markets['BTC-USDT-PERPETUAL'].contractSize.value=2},
  input=>{input.operationalVerification.markets['BTC-USDT-PERPETUAL'].quantityUnit.value='UNVERIFIED'},
  input=>{input.operationalVerification.markets['BTC-USDT-PERPETUAL'].minimumQuantity.value=.01},
  input=>{input.operationalVerification.markets['BTC-USDT-PERPETUAL'].quantityIncrement.rawField='min_qty'},
  input=>{input.markets[0].contractFields.quantity_step=raw(.01)},
  input=>{input.operationalVerification.markets['BTC-USDT-PERPETUAL'].fees.unit='UNVERIFIED'},
  input=>{input.operationalVerification.markets['BTC-USDT-PERPETUAL'].fees.takerRaw=6}
 ]){const input=syntheticEvidence();mutate(input);const result=evaluate(input);assert.ok(result.markets[0].checks.some(row=>row.status!=='PASS'))}
 const input=syntheticEvidence();delete input.operationalVerification.markets['BTC-USDT-PERPETUAL'].quantityUnit;
 assert.equal(check(evaluate(input),'MINIMUM_QUANTITY').status,'UNVERIFIED','minimum unit cannot become undefined==undefined proof');
});

test('reviewed min_trade_amount is an increment while min_qty remains the independent minimum quantity',()=>{
 const input=syntheticEvidence(),row=input.markets[0],p=input.operationalVerification.markets[row.instrumentName];
 delete row.contractFields.qty_step;row.contractFields.min_qty=raw(1);row.contractFields.min_trade_amount=raw(.1);
 row.book.bids=[[100,1.2],[99.9,1.3]];row.book.asks=[[100.1,1.4],[100.2,1.5]];
 p.minimumQuantity=proof({rawField:'min_qty',value:1,unit:'CONTRACT',meaning:'MINIMUM_ORDER_QUANTITY'});
 p.quantityIncrement=proof({rawField:'min_trade_amount',value:.1,unit:'CONTRACT',meaning:'ORDER_QUANTITY_INCREMENT'});
 let result=evaluate(input);assert.equal(check(result,'MINIMUM_QUANTITY').status,'PASS');
 assert.equal(check(result,'QUANTITY_INCREMENT').status,'PASS');assert.equal(check(result,'QUANTITY_PRECISION').status,'PASS');
 assert.equal(result.status,'NOT_READY','hypothetical synthetic proof never authorizes real execution');
 p.minimumQuantity=proof({rawField:'min_trade_amount',value:.1,unit:'CONTRACT',meaning:'MINIMUM_ORDER_QUANTITY'});
 assert.equal(check(evaluate(input),'MINIMUM_QUANTITY').status,'FAIL');
 p.minimumQuantity=proof({rawField:'min_qty',value:1,unit:'CONTRACT',meaning:'MINIMUM_ORDER_QUANTITY'});
 row.contractFields.qty_step=raw(1);assert.equal(check(evaluate(input),'QUANTITY_INCREMENT').status,'UNVERIFIED','conflicting candidate grids require reviewed unit correspondence');
 delete row.contractFields.qty_step;delete p.quantityIncrement;
 assert.equal(check(evaluate(input),'QUANTITY_INCREMENT').status,'UNVERIFIED','documentation excerpt alone is not an automatically injected unit review');
});

test('future is a derivative category rather than automatic evidence of a perpetual contract',()=>{
 const input=syntheticEvidence(),row=input.markets[0],p=input.operationalVerification.markets[row.instrumentName];
 row.contractFields.kind=raw('future');
 assert.equal(check(evaluate(input),'LISTING_ACTIVE').status,'UNVERIFIED');
 p.listing.kindClassification='future';p.listing.perpetualRoleEvidence={rawField:'settlement_period',value:'perpetual'};
 row.contractFields.settlement_period=raw('perpetual');
 assert.equal(check(evaluate(input),'LISTING_ACTIVE').status,'PASS');
 row.contractFields.settlement_period=raw('month');assert.equal(check(evaluate(input),'LISTING_ACTIVE').status,'FAIL');
 row.contractFields.settlement_period=raw('perpetual');row.listingDomainEligible=false;
 assert.equal(check(evaluate(input),'LISTING_ACTIVE').status,'UNVERIFIED','a kind proof does not approve an unverified trading area');
 row.listingDomainEligible=true;row.actualInstrumentName=null;
 assert.equal(check(evaluate(input),'LISTING_ACTIVE').status,'UNVERIFIED','the generic category cannot promote a requested-name candidate');
});

test('independent source times expire separately and are never refreshed by a boolean or the other quote clock',()=>{
 const input=syntheticEvidence();input.markets[0].book.timestamp=NOW-90001;input.markets[0].book.fresh=true;
 let result=evaluate(input);assert.equal(check(result,'BOOK_FRESHNESS').status,'FAIL');assert.equal(check(result,'MARK_FRESHNESS').status,'PASS');
 input.markets[0].book.timestamp=NOW-1;input.markets[0].markPriceTimestamp=NOW+1;input.markets[0].markPriceFresh=true;
 result=evaluate(input);assert.equal(check(result,'MARK_FRESHNESS').status,'FAIL');assert.equal(check(result,'BOOK_FRESHNESS').status,'PASS');
 delete input.markets[0].markPriceTimestamp;result=evaluate(input);assert.equal(check(result,'MARK_FRESHNESS').status,'UNVERIFIED');
});

test('flat runtime market snapshots and nested diagnostic books use the same observed source clocks',()=>{
 const nested=syntheticEvidence(),flat=structuredClone(nested);
 for(const row of flat.markets){row.bids=row.book.bids;row.asks=row.book.asks;row.priceAt=row.book.timestamp;row.markPriceAt=row.markPriceTimestamp;delete row.book;delete row.markPriceTimestamp}
 const a=evaluate(nested),b=evaluate(flat);assert.deepEqual(b.markets,a.markets);
});

test('invalid depth, crossed prices, precision mismatches and inactive listings fail without repairing observations',()=>{
 for(const [id,mutate]of [
  ['BOOK_INTEGRITY',row=>{row.book.asks.push([100.1,.004])}],
  ['BOOK_INTEGRITY',row=>{row.book.asks=[[100.2,.005],[100.1,.004]]}],
  ['BOOK_INTEGRITY',row=>{row.book.asks=[[99.9,.005]]}],
  ['BOOK_INTEGRITY',row=>{row.book.bids=[[100,-.001]]}],
  ['PRICE_PRECISION',row=>{row.book.asks[0][0]=100.15}],
  ['QUANTITY_PRECISION',row=>{row.book.asks[0][1]=.0045}],
  ['LISTING_ACTIVE',row=>{row.active=false}],
  ['LISTING_ACTIVE',row=>{row.listingConflict=true}],
  ['LISTING_ACTIVE',row=>{row.contractFields.kind=raw('spot')}]
 ]){
  const input=syntheticEvidence();mutate(input.markets[0]);const before=structuredClone(input);
  assert.equal(check(evaluate(input),id).status,'FAIL',id);assert.deepEqual(input,before);
 }
});

test('funding requires fresh observations and reviewed schedule, rate unit and sign rather than fee defaults',()=>{
 const input=syntheticEvidence();delete input.markets[0].fundingObservation;
 assert.equal(check(evaluate(input),'FUNDING').status,'UNVERIFIED');
 input.markets[0].fundingObservation=observed('BTC').fundingObservation;
 input.operationalVerification.markets['BTC-USDT-PERPETUAL'].funding.positiveRateMeaning='UNVERIFIED';
 assert.equal(check(evaluate(input),'FUNDING').status,'FAIL');
 input.operationalVerification.markets['BTC-USDT-PERPETUAL'].funding=marketProof('BTC').funding;
 input.markets[0].fundingObservation.observedAt=NOW-90001;assert.equal(check(evaluate(input),'FUNDING').status,'FAIL');
});

test('readiness rejects a positive funding payer opposite to the confirmed general rule',()=>{
 const input=syntheticEvidence(),funding=input.operationalVerification.markets['BTC-USDT-PERPETUAL'].funding;
 assert.equal(check(evaluate(input),'FUNDING').status,'PASS');
 funding.positiveRateMeaning='SHORT_PAYS_LONG';
 assert.equal(check(evaluate(input),'FUNDING').status,'FAIL');
 funding.positiveRateMeaning='LONG_PAYS_SHORT';
 assert.equal(check(evaluate(input),'FUNDING').status,'PASS');
 assert.equal(evaluate(input).activationAllowed,false);
});

test('exchange currency field meanings and Binance source freshness are explicit and never flipped by their names',()=>{
 const input=syntheticEvidence();assert.equal(check(evaluate(input),'BINANCE_MAPPING').status,'PASS');
 input.operationalVerification.markets['BTC-USDT-PERPETUAL'].binanceMapping.exchangeCurrencyDefinitions={base_currency:'UNDERLYING_ASSET',quote_currency:'QUOTE_ASSET'};
 assert.equal(check(evaluate(input),'BINANCE_MAPPING').status,'FAIL');
 input.operationalVerification.markets['BTC-USDT-PERPETUAL'].binanceMapping=marketProof('BTC').binanceMapping;
 input.markets[0].binanceObservation.timestamp=NOW-90001;assert.equal(check(evaluate(input),'BINANCE_MAPPING').status,'FAIL');
 input.markets[0].binanceObservation=observed('BTC').binanceObservation;delete input.markets[0].binanceObservation.dataSource;
 assert.equal(check(evaluate(input),'BINANCE_MAPPING').status,'UNVERIFIED');
});

test('claimed source, review headers and credential-like arbitrary fields do not bypass verification or leak into reports',()=>{
 const input=syntheticEvidence();input.syntheticTest=false;input.dataSource='REAL_PUBLIC_OBSERVATION_SUMMARY';delete input.operationalVerification.provenance;
 input.requests=[{httpStatus:200,responseSource:'UNCONFIRMED'}];input.apiKey='fixture-secret-never-render';
 let result=evaluate(input);assert.equal(result.status,'NOT_READY');assert.equal(result.checks.find(row=>row.id==='SOURCE_PROVENANCE').status,'UNVERIFIED');
 input.operationalVerification.provenance=proof({responseOrigin:'ORANGEX',observationType:'PUBLIC_API',observedAt:NOW-1000,sourceEvidenceSHA256:'b'.repeat(64)});
 assert.equal(evaluate(input).checks.find(row=>row.id==='SOURCE_PROVENANCE').status,'FAIL');
 input.operationalVerification.provenance.sourceEvidenceSHA256='a'.repeat(64);input.markets[0].book.dataSource='SYNTHETIC_FIXTURE';
 assert.equal(evaluate(input).checks.find(row=>row.id==='SOURCE_PROVENANCE').status,'FAIL','nested mock cannot be promoted by top-level source');
 delete input.markets[0].book.dataSource;input.operationalVerification.markets['BTC-USDT-PERPETUAL'].contractSize.officialDocumentURL='https://secret@example.com/?token=fixture-secret-never-render';
 result=evaluate(input);assert.equal(check(result,'CONTRACT_SIZE').status,'FAIL');assert.doesNotMatch(JSON.stringify(result),/fixture-secret-never-render|secret@example/);
 for(const flag of ['ordersSubmitted','orderSubmissionEnabled','realDataAutoEntryEnabled','paperAutoEntryEnabled','liveOrdersEnabled','paperEnabled']){
  const unsafe=syntheticEvidence();unsafe[flag]=true;assert.equal(evaluate(unsafe).checks.find(row=>row.id==='READ_ONLY_CONTEXT').status,'FAIL');
 }
});

test('malformed evidence and duplicate contract observations remain NOT_READY without throwing or manufacturing records',()=>{
 for(const value of [null,[],{}, {mode:'READ_ONLY',markets:null}])assert.equal(evaluate(value).status,'NOT_READY');
 const input=syntheticEvidence();input.markets.push(structuredClone(input.markets[0]));
 assert.equal(check(evaluate(input),'CONTRACT_NAME').status,'FAIL');
 for(const options of [{now:NaN},{now:0},{now:NOW,maxQuoteAgeMs:90001}])assert.throws(()=>evaluateOrangeXReadiness({},options),/INVALID_READINESS_OPTIONS/);
});
