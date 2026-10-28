import test from 'node:test';
import assert from 'node:assert/strict';
import {OrangeXReadOnlyAdapter} from '../orangex.mjs';
import {DOCUMENTED_LISTING_CURRENCIES,listingDomainInfo,normalizeListingCurrencies,reconcileOrangeXListing,orangeXMarketReadiness,orangeXBookIntegrity} from '../orangex_listing_domains.mjs';

// All protocol examples in this file are synthetic regression fixtures, never
// the separately preserved real Windows JSON or independently verified exchange data.
const NOW=Date.parse('2026-10-27T08:00:00Z');
const NAMES=['BTC','ETH','SOL'].map(asset=>asset+'-USDT-PERPETUAL');
const response=result=>Response.json({jsonrpc:'2.0',result});
const raw=(instrument_name,extra={})=>({instrument_name,is_active:true,min_qty:.001,min_trade_amount:.01,min_notional:10,
 tick_size:.1,contract_size:1,maker_commission:.0002,taker_commission:.0006,base_currency:'USDT',quote_currency:instrument_name.split('-')[0],...extra});
const fields=(value=.1)=>({tick_size:{value,source:'result[0].tick_size',units:'UNVERIFIED'}});
const discovery=(currency,patch={})=>({currency,status:'OBSERVED',items:[{instrument_name:NAMES[0],is_active:true,fields:fields()}],...patch});
const current=(extra={})=>({instrumentName:NAMES[0],bookObserved:true,bid:100,ask:100.1,priceAt:NOW,markPrice:100.05,markPriceAt:NOW,
 fresh:true,markPriceFresh:true,listingObserved:true,active:true,listingDomainEligible:true,listingConflict:false,...extra});
function adapter({domains={BTC:NAMES.map(name=>raw(name)),ETH:[],SPOT:[]},now=()=>NOW,listingCurrencies,listingCurrency,
 tickerTime=NOW,onRequest=()=>{}}={}){
 const options={enabled:true,includePublicDetails:true,instruments:NAMES,minIntervalMs:0,maxRetries:0,now,fetcher:async(url,options)=>{
  const query=new URL(url);onRequest(query,options);
  if(query.pathname.endsWith('/get_instruments')){
   const value=domains[query.searchParams.get('currency')];if(value instanceof Response)return value;
   return response(value??[]);
  }
  const instrument_name=query.searchParams.get('instrument_name');
  if(query.pathname.endsWith('/tickers'))return response({instrument_name,mark_price:100.05,timestamp:tickerTime});
  if(query.pathname.endsWith('/get_order_book'))return response({instrument_name,bids:[[100,2]],asks:[[100.1,3]],timestamp:NOW});
  assert.fail('private or unexpected endpoint');
 }};
 if(listingCurrencies!==undefined)options.listingCurrencies=listingCurrencies;
 if(listingCurrency!==undefined)options.listingCurrency=listingCurrency;
 return new OrangeXReadOnlyAdapter(options);
}

test('currency catalog distinguishes documented trading-area examples from experimental and legacy candidates',()=>{
 assert.deepEqual(DOCUMENTED_LISTING_CURRENCIES,['BTC','ETH','SPOT']);
 assert.deepEqual(normalizeListingCurrencies(),['BTC','ETH','SPOT']);
 assert.equal(listingDomainInfo('SPOT').documentedExample,true);assert.equal(listingDomainInfo('SPOT').perpetualDomainCandidate,false);
 assert.equal(listingDomainInfo('PERPETUAL').classification,'UNVERIFIED_CANDIDATE');
 assert.equal(listingDomainInfo('USDT').classification,'LEGACY_UNSUPPORTED');
 assert.equal(listingDomainInfo('USD'),null);assert.deepEqual(normalizeListingCurrencies(['BTC','BTC','ETH']),['BTC','ETH']);
 for(const values of [null,[],['SOL'],['btc'],['BTC&token=secret'],['BTC','ETH','SPOT','PERPETUAL','USDT','BTC']])
  assert.throws(()=>normalizeListingCurrencies(values),/INVALID_LISTING_CURRENCIES/);
});

test('default detailed discovery queries BTC, ETH and SPOT explicitly without treating USDT settlement text as an area',async()=>{
 const requests=[],client=adapter({domains:{BTC:[raw(NAMES[0]),raw(NAMES[2])],ETH:[raw(NAMES[1])],SPOT:[{instrument_name:'BTC-USDT-SPOT',is_active:true}]},
  onRequest:(url,options)=>requests.push({url,options})});
 const status=await client.refresh();
 assert.deepEqual(requests.filter(row=>row.url.pathname.endsWith('/get_instruments')).map(row=>row.url.searchParams.get('currency')),['BTC','ETH','SPOT']);
 assert.equal(requests.length,9);assert.ok(requests.every(row=>row.options.method==='GET'&&!row.options.body&&!('authorization' in row.options.headers)));
 assert.equal(status.listingDiscovery.length,3);assert.deepEqual(status.listingDiscovery.map(row=>row.httpStatus),[200,200,200]);
 assert.deepEqual(status.markets.map(row=>row.listingMatches[0].currency),['BTC','ETH','BTC']);
 assert.ok(status.markets.every(row=>row.listingObserved&&row.active===true&&row.listingDomainEligible));
 assert.equal(status.marketReadiness.publicDataReady,true);assert.equal(status.marketReadiness.tradingReady,false);
 assert.equal(status.marketReadiness.paperReady,false);assert.equal(status.orderSubmissionEnabled,false);
 for(const market of status.markets){
  assert.equal(market.contractFields.min_qty.value,.001);assert.equal(market.contractFields.min_trade_amount.value,.01);
  assert.equal(market.contractFields.base_currency.value,'USDT');assert.equal(market.contractFields.maker_commission.units,'UNVERIFIED');
  assert.equal(market.contractFields.min_qty.sourceCurrency,market.listingMatches[0].currency);
  assert.equal(market.qtyStep,null);assert.equal(market.fees.makerBps,null);
 }
});

test('HTTP 200 with fresh books and Mark but empty USDT listing is not market or trading readiness',async()=>{
 const client=adapter({listingCurrency:'USDT',domains:{USDT:[]}}),status=await client.refresh();
 assert.equal(status.connected,true);assert.equal(status.marketStatus,'connected','transport status is separate from readiness');
 assert.equal(status.errors.length,0);assert.ok(status.markets.every(row=>!row.listingObserved&&row.active===null&&Object.keys(row.contractFields).length===0));
 assert.equal(status.marketReadiness.publicDataReady,false);assert.equal(status.marketReadiness.ready,false);
 assert.ok(status.marketReadiness.publicDataReasons.includes('LISTING_UNOBSERVED'));
 assert.ok(status.warnings.some(message=>message.includes('LEGACY_LISTING_CURRENCY_UNSUPPORTED')));
 assert.equal(status.automation.enabled,false);
});

test('even an exact perpetual-looking match in SPOT, PERPETUAL or legacy USDT does not approve a futures domain',async()=>{
 for(const currency of ['SPOT','PERPETUAL','USDT']){
  const client=adapter({listingCurrencies:[currency],domains:{[currency]:NAMES.map(name=>raw(name))}}),status=await client.refresh();
  assert.ok(status.markets.every(row=>row.listingObserved&&row.active===true&&!row.listingDomainEligible));
  assert.equal(status.marketReadiness.publicDataReady,false);assert.ok(status.marketReadiness.publicDataReasons.includes('LISTING_DOMAIN_UNVERIFIED'));
  assert.equal(status.marketReadiness.paperReady,false);assert.equal(status.orderSubmissionEnabled,false);
 }
});

test('same-name observations preserve domain provenance while contradictory active flags or fields block selection',()=>{
 const same=reconcileOrangeXListing(NAMES[0],[discovery('BTC'),discovery('ETH')]);
 assert.equal(same.listingObserved,true);assert.equal(same.listingConflict,false);assert.equal(same.listingMatches.length,2);
 assert.deepEqual(same.listingMatches.map(row=>row.currency),['BTC','ETH']);assert.equal(same.listingDomainEligible,true);
 for(const item of [{instrument_name:NAMES[0],is_active:false,fields:fields()},
  {instrument_name:NAMES[0],is_active:true,fields:fields(.01)}]){
  const conflict=reconcileOrangeXListing(NAMES[0],[discovery('BTC'),discovery('ETH',{items:[item]})]);
  assert.equal(conflict.listingConflict,true);assert.equal(conflict.active,null);assert.equal(conflict.listingDomainEligible,false);
  assert.equal(conflict.listingStatus,'OBSERVED_CONFLICT');assert.equal(conflict.contractFields.tick_size.value,.1);
 }
 const missing=reconcileOrangeXListing(NAMES[0],[discovery('BTC',{items:[{instrument_name:'BTC-USDT-SPOT',is_active:true,fields:{}}]})]);
 assert.equal(missing.listingObserved,false);assert.equal(missing.active,null);
});

test('missing fields in a different area are not silently filled into the selected contract',()=>{
 const a={instrument_name:NAMES[0],is_active:true,fields:fields()},b={...a,fields:{...fields(),min_qty:{value:.001,units:'UNVERIFIED',source:'result[3].min_qty'}}};
 const result=reconcileOrangeXListing(NAMES[0],[discovery('BTC',{items:[a]}),discovery('ETH',{items:[b]})]);
 assert.equal(result.listingConflict,false);assert.equal(Object.hasOwn(result.contractFields,'min_qty'),false);
 assert.equal(result.listingMatches[1].contractFields.min_qty.value,.001);
});

test('an active documented whole row is preferred over an earlier unknown active flag without merging metadata',()=>{
 const a={instrument_name:NAMES[0],fields:{...fields(),min_notional:{value:10,units:'UNVERIFIED',source:'BTC-only-field'}}},
  b={instrument_name:NAMES[0],is_active:true,fields:{tick_size:{value:.1,source:'ETH-row.tick_size',units:'UNVERIFIED'},
   min_qty:{value:.001,units:'UNVERIFIED',source:'ETH-row.min_qty'}}};
 const result=reconcileOrangeXListing(NAMES[0],[discovery('BTC',{items:[a]}),discovery('ETH',{items:[b]})]);
 assert.equal(result.listingConflict,false);assert.equal(result.active,true);assert.equal(result.listingDomainEligible,true);
 assert.equal(result.listingSourceCurrency,'ETH');
 assert.equal(result.contractFields.tick_size.source,'ETH-row.tick_size');assert.equal(result.contractFields.min_qty.source,'ETH-row.min_qty');
 assert.equal(Object.hasOwn(result.contractFields,'min_notional'),false,'fields from the earlier unknown-status row must not be merged');
 assert.equal(result.listingMatches[0].contractFields.min_notional.source,'BTC-only-field');
 assert.equal(result.listingMatches[1].active,true);
});

test('invalid depth cannot become ready through sorting, duplicate size aggregation or truncation',async()=>{
 const bids=[[100,2],[99,3]],asks=[[100.1,1],[100.2,2],[100.1,1]],bookIntegrity=orangeXBookIntegrity({bids,asks});
 assert.equal(bookIntegrity.valid,false);assert.equal(bookIntegrity.askLevels,3);
 assert.ok(bookIntegrity.issues.includes('BOOK_DUPLICATE_PRICE'));assert.ok(bookIntegrity.issues.includes('BOOK_UNSORTED'));
 const result=orangeXMarketReadiness([current({bids,asks,bookIntegrity})],{now:NOW});
 assert.equal(result.publicDataReady,false);assert.ok(result.publicDataReasons.includes('BOOK_INTEGRITY_FAILED'));
 assert.equal(orangeXBookIntegrity({bids,asks:[[100.1,1],[100.2,2]]}).valid,true);
 assert.ok(orangeXBookIntegrity({bids,asks:Array.from({length:21},(_,i)=>[101+i,1])}).issues.includes('BOOK_DEPTH_EXCEEDED'));
 const client=adapter();client.getOrderBook=async()=>({bids,asks,bookIntegrity,bid:100,ask:100.1,priceAt:NOW,fresh:true});
 const status=await client.refresh();assert.equal(status.marketReadiness.publicDataReady,false);
 assert.ok(status.marketReadiness.publicDataReasons.includes('BOOK_DUPLICATE_PRICE'));
 assert.equal(status.orderSubmissionEnabled,false);
});

test('cached readiness independently expires source book and Mark clocks without changing historical observations',async()=>{
 let now=NOW;const client=adapter({now:()=>now,tickerTime:NOW-10000});
 const captured=await client.refresh();assert.equal(captured.marketReadiness.publicDataReady,true);
 now+=80001;const oldMark=client.getStatus();assert.equal(oldMark.markets[0].fresh,true);assert.equal(oldMark.markets[0].markPriceFresh,false);
 assert.equal(oldMark.marketReadiness.publicDataReady,false);assert.ok(oldMark.marketReadiness.publicDataReasons.includes('MARK_STALE'));
 now+=10000;const staleBoth=client.getStatus();assert.ok(staleBoth.marketReadiness.publicDataReasons.includes('BOOK_STALE'));
 assert.equal(captured.markets[0].markPriceFresh,true,'later status must not restate the already returned capture');
});

test('domain HTTP failures are separately scoped and do not discard a successful listed market',async()=>{
 const client=adapter({domains:{BTC:NAMES.map(name=>raw(name)),ETH:new Response('private-error',{status:403}),SPOT:[]}}),status=await client.refresh();
 assert.equal(status.errors.length,1);assert.equal(status.errors[0].listingCurrency,'ETH');assert.equal(status.errors[0].httpStatus,403);
 assert.equal(status.listingDiscovery[1].status,'FAILED');assert.equal(status.listingDiscovery[1].httpStatus,403);
 assert.equal(status.listingDiscovery[1].count,null);assert.equal(status.marketStatus,'partial');
 assert.ok(status.markets.every(row=>row.listingObserved));assert.doesNotMatch(JSON.stringify(status),/private-error/);
});

test('readiness keeps transport, public validation and PAPER authorization separate for missing and mismatched observations',()=>{
 assert.equal(orangeXMarketReadiness([current()],{now:NOW}).publicDataReady,true);
 for(const patch of [{listingObserved:false},{active:null},{active:false},{listingConflict:true},{listingDomainEligible:false},
  {priceAt:NOW-90001},{markPriceAt:NOW-90001},{markPrice:null},{bid:101},
  {precision:{priceGrid:'MISMATCH'}},{precision:{quantityGrid:'MISMATCH'}}]){
  const result=orangeXMarketReadiness([current(patch)],{now:NOW});assert.equal(result.publicDataReady,false);
  assert.equal(result.ready,false);assert.equal(result.tradingReady,false);assert.equal(result.paperReady,false);
 }
 const missing=orangeXMarketReadiness([],{now:NOW});assert.ok(missing.publicDataReasons.includes('PUBLIC_MARKETS_UNOBSERVED'));
 assert.equal(orangeXMarketReadiness([current()],{now:NOW,expectedInstruments:NAMES}).publicDataReady,false);
});
