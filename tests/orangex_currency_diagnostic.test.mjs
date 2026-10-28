import test from 'node:test';
import assert from 'node:assert/strict';
import {diagnoseOrangeXPublic,publicProbeURL} from '../scripts/diagnose-orangex-public.mjs';
import {currencyComparisonOptions} from '../scripts/diagnose-orangex-currencies.mjs';

// Synthetic protocol cases only. Actual Windows evidence is kept in separate fixtures.
const NOW=Date.parse('2026-10-27T12:00:00Z');
const assets=['BTC','ETH','SOL'];
const names=assets.map(asset=>asset+'-USDT-PERPETUAL');
const entry=(asset,patch={})=>({instrument_name:asset+'-USDT-PERPETUAL',is_active:true,kind:'perpetual',
 min_trade_amount:.01,min_qty:.001,min_notional:10,tick_size:.01,contract_size:1,qty_step:.001,
 maker_commission:.0002,taker_commission:.0006,base_currency:'USDT',quote_currency:asset,...patch});
const ok=(kind,result)=>({category:'OK',responseSource:'UNCONFIRMED',exitCode:0,proxyConnectStatus:null,httpStatus:200,
 body:kind==='docs'?'/public/get_instruments /public/tickers /public/get_order_book':JSON.stringify({result})});
const depth=(name,at=NOW)=>({instrument_name:name,timestamp:String(at),
 bids:Array.from({length:20},(_,index)=>[100-index*.01,1]),asks:Array.from({length:20},(_,index)=>[100.01+index*.01,1])});
const probeFor=(domainRows,options={})=>async(kind,name,{currency}={})=>{
 if(kind==='instruments')return ok(kind,domainRows[currency]??[]);
 if(kind==='tickers')return ok(kind,{instrument_name:name,mark_price:100.005,timestamp:options.now?.()??NOW});
 if(kind==='book')return ok(kind,depth(name,options.now?.()??NOW));
 return ok(kind,[]);
};

test('currency comparison only includes documented defaults and separately opted-in unverified or legacy candidates',()=>{
 assert.deepEqual(currencyComparisonOptions(),{currencies:['BTC','ETH','SPOT'],comparisonMode:true});
 assert.deepEqual(currencyComparisonOptions(['--include-unverified','--include-legacy']).currencies,['BTC','ETH','SPOT','PERPETUAL','USDT']);
 for(const args of [['--currency=USDT'],['--mode=LIVE'],['https://example.com'],['--include-legacy','--include-legacy']])
  assert.throws(()=>currencyComparisonOptions(args),/INVALID_CURRENCY_COMPARISON_OPTIONS/);
 assert.throws(()=>publicProbeURL('instruments',undefined,{currency:'SOL'}),/INVALID_PUBLIC_CURRENCY/);
 assert.equal(new URL(publicProbeURL('instruments')).searchParams.get('currency'),'BTC');
});

test('documented domain queries find exact contracts with domain provenance and separate empty versus unrelated results',async()=>{
 const calls=[],probe=probeFor({BTC:[entry('BTC'),entry('SOL')],ETH:[entry('ETH')],SPOT:[{instrument_name:'BTC-USDT-SPOT',is_active:true}]});
 const report=await diagnoseOrangeXPublic({probe:async(kind,name,options)=>{calls.push({kind,name,...options});return probe(kind,name,options)},now:()=>NOW});
 assert.equal(report.exitCode,0);assert.equal(report.publicDataReady,true);assert.equal(report.http200Count,10);
 assert.deepEqual(calls.filter(row=>row.kind==='instruments').map(row=>row.currency),['BTC','ETH','SPOT']);
 assert.deepEqual(report.listingDiscovery.map(row=>row.outcome),['TARGET_MATCHES','TARGET_MATCHES','NO_TARGET_MATCHES']);
 assert.equal(report.listingDiscovery[2].instrumentCount,1);assert.equal(report.listingDiscovery[2].targetMatchCount,0);
 assert.deepEqual(report.markets.map(row=>row.instrumentName),names);
 for(const market of report.markets){
  assert.equal(market.listingObserved,true);assert.equal(market.active,true);assert.equal(market.listingDomainEligible,true);
  assert.match(market.contractNameSource,/^currency=(BTC|ETH):result\[/);
  assert.equal(market.contractFields.min_qty.value,.001);assert.equal(market.contractFields.min_trade_amount.value,.01);
  assert.equal(market.contractFields.contract_size.value,1);assert.equal(market.feeUnitsVerified,false);
  assert.equal(market.contractFields.maker_commission.value,.0002);assert.equal(market.contractFields.taker_commission.value,.0006);
 }
 assert.equal(report.ready,false);assert.equal(report.tradingReady,false);assert.equal(report.paperReady,false);assert.equal(report.paperEnabled,false);
 assert.ok(report.marketReadiness.blockingReasons.includes('FEES_UNVERIFIED'));
});

test('eight HTTP 200 legacy requests with fresh Mark and twenty-level books cannot pass missing listing verification',async()=>{
 const report=await diagnoseOrangeXPublic({currency:'USDT',probe:probeFor({USDT:[]}),now:()=>NOW});
 assert.equal(report.requests.length,8);assert.equal(report.http200Count,8);
 assert.ok(report.requests.every(row=>row.httpStatus===200&&row.status==='OBSERVED'));
 assert.equal(report.exitCode,1);assert.equal(report.status,'INCOMPLETE');assert.equal(report.publicDataReady,false);
 assert.equal(report.listingDiscovery[0].outcome,'EMPTY_RESPONSE');
 assert.equal(report.listingDiscovery[0].candidate.classification,'LEGACY_UNSUPPORTED');
 for(const market of report.markets){
  assert.equal(market.listingObserved,false);assert.equal(market.active,null);assert.deepEqual(market.contractFields,{});
  assert.equal(market.markPriceFresh,true);assert.equal(market.book.fresh,true);
  assert.equal(market.book.bids.length,20);assert.equal(market.book.asks.length,20);
  assert.ok(market.validation.reasons.includes('LISTING_UNOBSERVED'));
 }
 assert.equal(report.paperReady,false);assert.equal(report.ordersSubmitted,false);
});

test('SPOT, PERPETUAL and USDT observations remain candidates rather than approved perpetual domains',async()=>{
 for(const currency of ['SPOT','PERPETUAL','USDT']){
  const report=await diagnoseOrangeXPublic({currency,probe:probeFor({[currency]:assets.map(asset=>entry(asset))}),now:()=>NOW});
  assert.equal(report.exitCode,1);assert.equal(report.publicDataReady,false);
  assert.ok(report.markets.every(row=>row.listingObserved&&row.active===true&&!row.listingDomainEligible));
  assert.ok(report.marketReadiness.publicDataReasons.includes('LISTING_DOMAIN_UNVERIFIED'));
 }
 const report=await diagnoseOrangeXPublic({...currencyComparisonOptions(['--include-unverified','--include-legacy']),
  probe:probeFor({PERPETUAL:assets.map(asset=>entry(asset))}),now:()=>NOW});
 assert.equal(report.requests.length,12);assert.equal(report.listingDiscovery.length,5);assert.equal(report.exitCode,1);
 assert.deepEqual(report.listingDiscovery.map(row=>row.candidate.classification),
  ['DOCUMENTED_EXAMPLE','DOCUMENTED_EXAMPLE','DOCUMENTED_EXAMPLE','UNVERIFIED_CANDIDATE','LEGACY_UNSUPPORTED']);
});

test('conflicting active states or contract fields across domain responses are not silently merged',async()=>{
 for(const patch of [{is_active:false},{min_qty:.02}]){
  const report=await diagnoseOrangeXPublic({probe:probeFor({BTC:assets.map(asset=>entry(asset)),ETH:[entry('BTC',patch)]}),now:()=>NOW});
  const btc=report.markets.find(row=>row.asset==='BTC');
  assert.equal(btc.listingObserved,true);assert.equal(btc.listingConflict,true);assert.equal(btc.active,null);
  assert.equal(report.exitCode,1);assert.ok(btc.validation.reasons.includes('LISTING_CONFLICT'));
  assert.equal(btc.listingMatches.length,2);assert.equal(btc.contractFields.min_qty.value,.001);
 }
});

test('large duplicate listing arrays stay bounded and conflicting duplicates remain blocked',async()=>{
 const rows=Array.from({length:5000},()=>entry('BTC')).concat([entry('BTC',{min_qty:.002}),entry('ETH'),entry('SOL')]);
 const report=await diagnoseOrangeXPublic({probe:probeFor({BTC:rows}),now:()=>NOW});
 assert.equal(report.markets.length,3);assert.equal(report.requests.length,10);
 assert.equal(report.listingDiscovery[0].targetMatches.length,4);
 assert.equal(report.listingDiscovery[0].duplicateRowsOmitted,4999);
 assert.deepEqual(report.listingDiscovery[0].duplicateConflictInstruments,['BTC-USDT-PERPETUAL']);
 assert.equal(report.markets[0].listingConflict,true);assert.equal(report.exitCode,1);
});

test('completion-time checks expire earlier books and Marks independently of the final current instrument',async()=>{
 let clock=NOW;
 const source=probeFor({BTC:assets.map(asset=>entry(asset))},{now:()=>clock});
 const report=await diagnoseOrangeXPublic({probe:async(kind,name,options)=>{
  if(kind==='tickers'&&name==='SOL-USDT-PERPETUAL')clock=NOW+90001;
  return source(kind,name,options);
 },now:()=>clock});
 assert.equal(report.exitCode,1);assert.equal(report.publicDataReady,false);
 assert.equal(report.checkedAt,new Date(NOW).toISOString());assert.equal(report.completedAt,new Date(clock).toISOString());
 for(const market of report.markets.slice(0,2)){
  assert.equal(market.book.fresh,false);assert.equal(market.markPriceFresh,false);
  assert.ok(market.validation.reasons.includes('BOOK_STALE'));assert.ok(market.validation.reasons.includes('MARK_STALE'));
 }
 assert.equal(report.markets[2].book.fresh,true);assert.equal(report.markets[2].markPriceFresh,true);
});

test('later active whole observations determine contract provenance without filling earlier fields',async()=>{
 for(const sameDomain of [false,true]){
  const first=entry('BTC',{is_active:undefined,min_notional:77}),last=entry('BTC',{min_notional:undefined,min_qty:.002});
  // Keep overlapping values consistent; these rows differ only in completeness.
  delete first.min_qty;
  const domains=sameDomain?{BTC:[first,last,entry('ETH'),entry('SOL')]}:
   {BTC:[first,entry('ETH'),entry('SOL')],ETH:[last]};
  const report=await diagnoseOrangeXPublic({probe:probeFor(domains),now:()=>NOW}),btc=report.markets.find(row=>row.asset==='BTC');
  assert.equal(report.exitCode,0);assert.equal(btc.active,true);assert.equal(btc.listingConflict,false);
  assert.equal(btc.listingSourceCurrency,sameDomain?'BTC':'ETH');
  assert.match(btc.contractNameSource,sameDomain?/currency=BTC:result\[1\]/:/currency=ETH:result\[0\]/);
  assert.equal(btc.contractFields.min_qty.value,.002);assert.equal(Object.hasOwn(btc.contractFields,'min_notional'),false);
 }
});

test('bounded discovery includes the actual USDT target even if three alternate contracts precede it',async()=>{
 const variants=['USDC','USD','EUR'].map(quote=>entry('BTC',{instrument_name:`BTC-${quote}-PERPETUAL`}));
 const report=await diagnoseOrangeXPublic({probe:probeFor({BTC:[...variants,...assets.map(asset=>entry(asset))]}),now:()=>NOW});
 assert.equal(report.markets[0].instrumentName,names[0]);
 assert.equal(report.markets.filter(row=>row.asset==='BTC').length,3);
 assert.equal(report.markets[0].additionalContractsOmitted,1);
 assert.equal(report.markets[0].listingObserved,true);
});
