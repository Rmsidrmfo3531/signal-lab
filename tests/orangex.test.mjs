import test from 'node:test';
import assert from 'node:assert/strict';
import {OrangeXReadOnlyAdapter,OrangeXError} from '../orangex.mjs';

const T=Date.parse('2026-10-27T08:00:00Z'),BTC='BTC-USDT-PERPETUAL';
const envelope=(result,extra={})=>new Response(JSON.stringify({jsonrpc:'2.0',result,...extra}),{status:200,headers:{'content-type':'application/json'}});
const depth=(extra={})=>({instrument_name:BTC,bids:[['100','2'],['99','3']],asks:[['102','4'],['101','5']],timestamp:T,version:12,...extra});
const adapter=options=>new OrangeXReadOnlyAdapter({enabled:true,instruments:[BTC],now:()=>T,minIntervalMs:0,maxRetries:0,...options});
const code=(expected)=>error=>error instanceof OrangeXError&&error.code===expected;
const verifiedAuth={officialSpecVerified:true,authVerified:true}; // Injected mock contract; never an environment setting.

test('default adapter performs no requests and exposes only READ_ONLY disabled status',async()=>{
 let calls=0;const client=new OrangeXReadOnlyAdapter({fetcher:()=>{calls++;throw Error('unexpected')}});
 const status=await client.snapshot({refresh:true});
 assert.equal(calls,0);assert.equal(status.enabled,false);assert.equal(status.mode,'READ_ONLY');
 assert.equal(status.account,null);assert.equal(status.orderSubmissionEnabled,false);assert.equal(status.automation.canEnable,false);
 assert.equal(status.verification.officialSpec,'UNVERIFIED');assert.equal(status.verification.sourceOwnership,'UNVERIFIED');
 assert.equal(status.verification.liveConnection,'UNTESTED');
 assert.equal(status.dataSource,'UNOBSERVED','an idle disabled adapter has not observed any public response');
});

for(const mode of ['PAPER','LIVE','live',''])test(`unsupported mode ${JSON.stringify(mode)} is rejected before transport`,()=>{
 let calls=0;assert.throws(()=>new OrangeXReadOnlyAdapter({enabled:true,mode,fetcher:()=>{calls++}}),code('MODE_NOT_ALLOWED'));
 assert.equal(calls,0);
});

test('credentials do not bypass the official authentication specification gate',async()=>{
 let calls=0;const client=adapter({clientId:'fixture-client',clientSecret:'fixture-secret',fetcher:()=>{calls++}});
 await assert.rejects(client.authenticate(),code('SPEC_UNVERIFIED'));
 await assert.rejects(client.refreshAuthentication(),code('SPEC_UNVERIFIED'));
 const status=client.getStatus();assert.equal(status.authentication.configured,true);assert.equal(status.authentication.authenticated,false);
 assert.equal(status.capabilities.oauth,false);assert.equal(calls,0);
 assert.doesNotMatch(JSON.stringify(client),/fixture-client|fixture-secret/);
});

test('unverified account, instruments, positions, orders and trades never issue a guessed request',async()=>{
 let calls=0;const client=adapter({fetcher:()=>{calls++}});
 for(const method of ['listInstruments','readAccount','getPositions','getOpenOrders','getTrades'])
  await assert.rejects(client[method](),error=>['SPEC_UNVERIFIED','UNSUPPORTED_OPERATION'].includes(error.code));
 assert.equal(calls,0);
 assert.equal(client.submitOrder,undefined);assert.equal(client.withdraw,undefined);assert.equal(client.cancelOrder,undefined);
});

test('public book uses fixed HTTPS read endpoint and normalizes data without approving an instrument',async()=>{
 let request;const client=adapter({fetcher:async(url,options)=>{request={url:new URL(url),options};return envelope(depth({unknown_secret:'fixture-never-public'}))}});
 const result=await client.getOrderBook(BTC);
 assert.equal(request.url.origin,'https://api.orangex.com');assert.equal(request.url.pathname,'/api/v1/public/get_order_book');
 assert.equal(request.url.searchParams.get('instrument_name'),BTC);assert.equal(request.url.searchParams.get('depth'),'20');
 assert.equal(request.options.method,'GET');assert.equal(request.options.redirect,'error');assert.equal(request.options.headers.authorization,undefined);
 assert.equal(result.bid,100);assert.equal(result.ask,101);assert.ok(result.spreadBps>0);assert.equal(result.priceAt,T);assert.equal(result.fresh,true);
 assert.equal(result.tradable,false);assert.equal(result.instrumentVerified,false);assert.equal(result.markPrice,null);
 assert.equal(result.minQty,null);assert.equal(result.qtyStep,null);assert.equal(result.priceTick,null);
 assert.equal(result.bookIntegrity.valid,false,'unsorted source depth stays observable but cannot approve readiness');
 assert.deepEqual(result.asks,[[102,4],[101,5]],'preserve original sequence rather than silently repairing it');
 assert.ok(result.bookIntegrity.issues.includes('BOOK_UNSORTED'));
 assert.doesNotMatch(JSON.stringify(result),/fixture-never-public/);
});

test('quote timestamps are never manufactured from receipt time or undocumented units',async()=>{
 for(const timestamp of [undefined,T-100000,T+6000,Math.floor(T/1000),'not-a-time']){
  const client=adapter({fetcher:async()=>envelope(depth({timestamp}))});
  const book=await client.getOrderBook(BTC);assert.equal(book.fresh,false,String(timestamp));
  if(timestamp===undefined||typeof timestamp==='string'||timestamp<1e12)assert.equal(book.priceAt,null);
 }
});

test('a different quote asset is not silently mapped into the Binance USDT market',async()=>{
 const name='BTC-USDC-PERPETUAL',client=adapter({instruments:[name],fetcher:async()=>envelope(depth({instrument_name:name}))});
 const result=await client.getOrderBook(name);assert.equal(result.symbol,'BTCUSDC');assert.equal(result.tradable,false);
});

test('malformed, crossed and mismatched order books fail rather than producing a price',async()=>{
 for(const patch of [{bids:[]},{asks:null},{bids:[['-1','2']]},{asks:[['101','0']]},{bids:[['103','1']]},
  {bids:[[true,'2']]},{bids:[['100',true]]},{asks:[[' ',2]]},{asks:[[[],2]]},
  {bids:[['new','100','1']]},{instrument_name:'ETH-USDT-PERPETUAL'}]){
  const client=adapter({fetcher:async()=>envelope(depth(patch))});
  await assert.rejects(client.getOrderBook(BTC),code('INVALID_RESPONSE'));
 }
});

test('enabled snapshots refresh initially and after TTL while cached data is reused in between',async()=>{
 let now=T,calls=0;const client=adapter({now:()=>now,fetcher:async()=>{calls++;return envelope(depth({timestamp:now}))}});
 await client.snapshot();assert.equal(calls,1);
 now+=29999;await client.snapshot();assert.equal(calls,1);
 now++;await client.snapshot();assert.equal(calls,2);
 now+=100000;assert.equal(client.getStatus().markets[0].fresh,false,'cached freshness is reevaluated even without a request');
 await client.snapshot();assert.equal(calls,3);assert.equal(client.getStatus().markets[0].fresh,true);
});

test('oversized declared and streamed response bodies are rejected with safe errors',async()=>{
 const oversized='x'.repeat(2*1024*1024+1);
 for(const fetcher of [async()=>new Response('{}',{headers:{'content-length':'99999999'}}),async()=>new Response(oversized),
  async()=>({ok:true,status:200,json:async()=>({result:{payload:oversized}})})]){
  const client=adapter({fetcher});await assert.rejects(client.getOrderBook(BTC),code('INVALID_RESPONSE'));
 }
});

test('unconfigured instruments and path injection are rejected without network access',async()=>{
 let calls=0;const client=adapter({fetcher:()=>{calls++}});
 for(const name of ['../private/buy','https://other.test','BTCUSDT','ETH-USDT-PERPETUAL'])
  await assert.rejects(client.getOrderBook(name),code('INVALID_INSTRUMENT'));
 await assert.rejects(client.getOrderBook(BTC,{depth:1000}),code('INVALID_INSTRUMENT'));assert.equal(calls,0);
});

test('HTTP and provider error text is discarded from public errors',async()=>{
 const sensitive='fixture-secret fixture-access-token https://private.example';
 for(const fetcher of [async()=>{throw Error(sensitive)},async()=>new Response(sensitive,{status:401}),
  async()=>envelope(null,{error:{code:999,message:sensitive}}),async()=>new Response(sensitive,{status:200})]){
  const client=adapter({fetcher});const status=await client.refresh();
  assert.equal(status.connected,false);assert.equal(status.errors.length,1);
  assert.equal(status.dataSource,'UNOBSERVED','failed requests without validated observations are not a real public-data observation');
  assert.equal(status.verification.liveConnection,'FAILED','an unsuccessful query alone does not prove a proxy policy block');
  assert.doesNotMatch(JSON.stringify(status),/fixture-secret|fixture-access-token|private\.example/);
 }
});

test('DNS diagnostics retain only recognized cause codes without fabricating an HTTP response',async()=>{
 for(const causeCode of ['EAI_AGAIN','ENOTFOUND']){
  const client=adapter({fetcher:async()=>{throw new TypeError('fixture-private-network-message',{cause:{code:causeCode}})}});
  const status=await client.refresh(),error=status.errors[0];
  assert.equal(error.code,'NETWORK_ERROR');assert.equal(error.category,'DNS');assert.equal(error.transportCode,causeCode);
  assert.equal(error.httpStatus,null);assert.equal(error.responseSource,'UNCONFIRMED');
  assert.doesNotMatch(JSON.stringify(status),/fixture-private-network-message/);
 }
});

test('TLS diagnostic codes remain distinct from DNS and generic transport errors',async()=>{
 for(const causeCode of ['CERT_HAS_EXPIRED','ERR_TLS_CERT_ALTNAME_INVALID','UNABLE_TO_VERIFY_LEAF_SIGNATURE']){
  const client=adapter({fetcher:async()=>{throw new TypeError('fixture-private-cert-message',{cause:{cause:{code:causeCode}}})}});
  const error=(await client.refresh()).errors[0];
  assert.equal(error.code,'NETWORK_ERROR');assert.equal(error.category,'TLS');assert.equal(error.transportCode,causeCode);
  assert.equal(error.httpStatus,null);assert.equal(error.responseSource,'UNCONFIRMED');
 }
});

test('HTTP diagnostic status never labels a 403 response as proven OrangeX or proxy output',async()=>{
 for(const statusCode of [403,429,503]){
  const client=adapter({fetcher:async()=>new Response('fixture-private-http-body',{status:statusCode,headers:{server:'fixture-server'}})});
  const status=await client.refresh(),error=status.errors[0];
  assert.equal(error.category,'HTTP');assert.equal(error.httpStatus,statusCode);
  assert.equal(error.transportCode,null);assert.equal(error.responseSource,'UNCONFIRMED');
  assert.doesNotMatch(JSON.stringify(status),/fixture-private-http-body|fixture-server/);
 }
});

test('schema and API errors preserve the observed HTTP status independently of transport diagnostics',async()=>{
 for(const fetcher of [async()=>new Response('fixture-invalid-json',{status:200}),async()=>envelope(depth({bids:[]}))]){
  const error=(await adapter({fetcher}).refresh()).errors[0];
  assert.equal(error.code,'INVALID_RESPONSE');assert.equal(error.category,'SCHEMA');assert.equal(error.httpStatus,200);
  assert.equal(error.transportCode,null);assert.equal(error.responseSource,'UNCONFIRMED');
 }
 const error=(await adapter({fetcher:async()=>envelope(null,{error:{code:10000,message:'fixture-private-api-message'}})}).refresh()).errors[0];
 assert.equal(error.code,'API_ERROR');assert.equal(error.category,'API');assert.equal(error.httpStatus,200);
 assert.doesNotMatch(JSON.stringify(error),/fixture-private-api-message|10000/);
});

test('a transport failure while reading a response body is not misreported as malformed JSON',async()=>{
 const client=adapter({fetcher:async()=>({ok:true,status:200,json:async()=>{throw new TypeError('fixture-private-body-error',{cause:{code:'ECONNRESET'}})}})});
 const error=(await client.refresh()).errors[0];
 assert.equal(error.code,'NETWORK_ERROR');assert.equal(error.category,'NETWORK');assert.equal(error.transportCode,'ECONNRESET');
 assert.equal(error.httpStatus,200);assert.equal(error.responseSource,'UNCONFIRMED');
});

test('unrecognized diagnostic fields and sensitive error codes are discarded rather than echoed',async()=>{
 const sensitive='fixture-secret-never-public';
 const client=adapter({fetcher:async()=>{throw Object.assign(Error(sensitive),{code:sensitive,cause:{code:sensitive},
  httpStatus:403,responseSource:'ORIGIN',category:'TLS',headers:{authorization:sensitive}})}});
 const status=await client.refresh(),error=status.errors[0];
 assert.equal(error.category,'NETWORK');assert.equal(error.transportCode,null);assert.equal(error.httpStatus,null);
 assert.equal(error.responseSource,'UNCONFIRMED');assert.doesNotMatch(JSON.stringify(status),new RegExp(sensitive));
 const typed=new OrangeXError('NETWORK_ERROR',{transportCode:sensitive,httpStatus:'403',responseSource:'ORIGIN',category:'TLS',extra:sensitive});
 assert.equal(typed.transportCode,null);assert.equal(typed.httpStatus,null);assert.equal(typed.category,'NETWORK');
 assert.equal(typed.responseSource,'UNCONFIRMED');assert.doesNotMatch(JSON.stringify(typed),new RegExp(sensitive));
});

test('timeouts bound both connection and JSON body reads',async()=>{
 for(const fetcher of [()=>new Promise(()=>{}),async()=>({ok:true,status:200,json:()=>new Promise(()=>{})})]){
  const client=adapter({fetcher,timeoutMs:100});
  await assert.rejects(client.getOrderBook(BTC),error=>code('REQUEST_TIMEOUT')(error)&&error.category==='TIMEOUT'&&error.responseSource==='UNCONFIRMED');
 }
});

test('public retries remain bounded and respect short provider cooldowns',async()=>{
 let calls=0;const waits=[];
 const client=adapter({maxRetries:2,sleep:async ms=>{waits.push(ms)},fetcher:async()=>{
  calls++;return calls===1?new Response('',{status:429,headers:{'retry-after':'2'}}):calls===2?new Response('',{status:503}):envelope(depth());
 }});
 assert.equal((await client.getOrderBook(BTC)).bid,100);assert.equal(calls,3);assert.deepEqual(waits,[2000,400]);
 calls=0;const failed=adapter({maxRetries:1,sleep:async()=>{},fetcher:async()=>{calls++;return new Response('',{status:429})}});
 await assert.rejects(failed.getOrderBook(BTC),code('RATE_LIMITED'));assert.equal(calls,2);
});

test('long Retry-After values defer queries instead of sending an early retry',async()=>{
 let calls=0,now=T;const waits=[];
 const client=adapter({now:()=>now,maxRetries:2,sleep:async ms=>{waits.push(ms)},fetcher:async()=>{
  calls++;return calls===1?new Response('',{status:429,headers:{'retry-after':'60'}}):envelope(depth({timestamp:now}));
 }});
 await assert.rejects(client.getOrderBook(BTC),code('RATE_LIMITED'));assert.equal(calls,1);assert.deepEqual(waits,[]);
 assert.equal(client.getStatus().rateLimit.retryAfterAt,T+60000);
 now+=59999;await assert.rejects(client.getOrderBook(BTC),code('RATE_LIMITED'));assert.equal(calls,1);
 now++;assert.equal((await client.getOrderBook(BTC)).fresh,true);assert.equal(calls,2);
});

test('redirects are blocked instead of forwarding a read or authentication request',async()=>{
 const client=adapter({fetcher:async()=>new Response('',{status:302,headers:{location:'https://other.example'}})});
 await assert.rejects(client.getOrderBook(BTC),code('REDIRECT_BLOCKED'));
});

test('concurrent snapshot refreshes share one public request and never authenticate automatically',async()=>{
 let calls=0;const client=adapter({clientId:'fixture-client',clientSecret:'fixture-secret',fetcher:async()=>{calls++;await new Promise(r=>setTimeout(r,10));return envelope(depth())}});
 const results=await Promise.all([client.refresh(),client.snapshot({refresh:true}),client.refresh()]);
 assert.equal(calls,1);assert.ok(results.every(status=>status.marketStatus==='connected'));
 assert.equal(results[0].authentication.authenticated,false);assert.equal(results[0].accountStatus,'unverified');
 assert.equal(results[0].account,null);
});

test('injected verified auth contract caches credentials and refreshes once without exposing tokens',async()=>{
 let now=T,calls=0,release;const requests=[];
 const client=adapter({now:()=>now,contract:verifiedAuth,clientId:'fixture-client',clientSecret:'fixture-secret',fetcher:async(url,options)=>{
  calls++;requests.push({url:new URL(url),options});
  if(calls===1)await new Promise(resolve=>{release=resolve});
  return envelope({access_token:'fixture-access-token-'+calls,refresh_token:'fixture-refresh-token-'+calls,expires_in:10},
   options.method==='POST'?{id:JSON.parse(options.body).id}:{});
 }});
 const pending=client.authenticate(),same=client.authenticate();await new Promise(r=>setImmediate(r));release();
 const statuses=await Promise.all([pending,same]);assert.equal(calls,1);assert.equal(statuses[0].authenticated,true);
 assert.equal(requests[0].options.method,'GET');assert.equal(requests[0].url.searchParams.get('grant_type'),'client_credentials');
 assert.equal(requests[0].url.searchParams.get('client_secret'),'fixture-secret');
 await client.authenticate();assert.equal(calls,1);
 now+=11000;await Promise.all([client.authenticate(),client.authenticate()]);assert.equal(calls,2);
 const refresh=JSON.parse(requests[1].options.body);assert.equal(requests[1].options.method,'POST');
 assert.equal(refresh.method,'/public/auth');assert.equal(refresh.params.grant_type,'refresh_token');
 assert.equal(refresh.params.refresh_token,'fixture-refresh-token-1');
 assert.equal(client.getStatus().authentication.expiresAt,now+10000);
 assert.doesNotMatch(JSON.stringify([client,statuses]),/fixture-client|fixture-secret|fixture-access-token|fixture-refresh-token/);
 assert.equal(client.getStatus().orderSubmissionEnabled,false);
});

test('failed authentication is not retried and never falls through into private or order APIs',async()=>{
 let calls=0;const client=adapter({contract:verifiedAuth,clientId:'fixture-client',clientSecret:'fixture-secret',maxRetries:2,
  fetcher:async()=>{calls++;return new Response('fixture-access-token',{status:401})}});
 await assert.rejects(client.authenticate(),code('AUTH_FAILED'));assert.equal(calls,1);
 assert.equal(client.getStatus().authentication.authenticated,false);
});

test('malformed token lifetimes and refresh response IDs are rejected without retaining authentication',async()=>{
 for(const result of [{access_token:'fixture-access',expires_in:0},{access_token:'',expires_in:60},{access_token:' ',expires_in:60},
  {access_token:'fixture-access',expires_in:60,refresh_token:{}},{access_token:'fixture-access',expires_in:60,refresh_token:'bad\nheader'}]){
  const client=adapter({contract:verifiedAuth,clientId:'fixture-client',clientSecret:'fixture-secret',fetcher:async()=>envelope(result)});
  await assert.rejects(client.authenticate(),code('TOKEN_RESPONSE_INVALID'));assert.equal(client.getStatus().authentication.authenticated,false);
 }
 let calls=0;const client=adapter({contract:verifiedAuth,clientId:'fixture-client',clientSecret:'fixture-secret',fetcher:async()=>{
  calls++;return envelope({access_token:'fixture-access',refresh_token:'fixture-refresh',expires_in:60},calls===1?{}:{id:'wrong'});
 }});
 await client.authenticate();await assert.rejects(client.refreshAuthentication(),code('INVALID_RESPONSE'));
 assert.equal(client.getStatus().authentication.authenticated,false);assert.equal(calls,2);
});

// Synthetic protocol examples only. They are not the unavailable Windows JSON,
// independently authenticated OrangeX responses, or verified contract semantics.
const observedListing=(patch={})=>({instrument_name:BTC,is_active:true,base_currency:'BTC',quote_currency:'USDT',
 min_trade_amount:.1,min_qty:.01,min_notional:5,tick_size:.01,contract_size:1,maker_commission:0,taker_commission:.05,...patch});
const publicFetcher=({listing=observedListing(),ticker={instrument_name:BTC,mark_price:100.4,timestamp:T},book=depth(),onRequest=()=>{}}={})=>async(url,options)=>{
 const parsed=new URL(url);onRequest(parsed,options);
 if(parsed.pathname.endsWith('/get_instruments'))return envelope([listing]);
 if(parsed.pathname.endsWith('/tickers'))return envelope(ticker);
 if(parsed.pathname.endsWith('/get_order_book'))return envelope(book);
 assert.fail('unexpected endpoint');
};

test('public metadata requires explicit currency and each ticker requires an exact configured instrument',async()=>{
 const calls=[],client=adapter({fetcher:publicFetcher({onRequest:(url,options)=>calls.push({url,options})})});
 for(const value of [undefined,'','usdt','../private/buy','USDT&token=secret'])
  await assert.rejects(client.getPublicInstruments(value),code('INVALID_CONFIG'));
 for(const value of [undefined,'','BTCUSDT','ETH-USDT-PERPETUAL','BTC-USDT-PERPETUAL&token=secret'])
  await assert.rejects(client.getPublicTickers(value),code('INVALID_INSTRUMENT'));
 assert.equal(calls.length,0);
 const listing=await client.getPublicInstruments('USDT'),ticker=await client.getPublicTickers(BTC);
 assert.equal(calls.length,2);assert.equal(calls[0].url.searchParams.get('currency'),'USDT');
 assert.equal(calls[1].url.searchParams.get('instrument_name'),BTC);
 assert.ok(calls.every(({options})=>options.method==='GET'&&!options.body&&!('authorization' in options.headers)));
 assert.equal(listing.currencyMeaningVerified,false);assert.equal(ticker.officialSpecificationVerified,false);
});

test('detailed refresh keeps all minimum, contract and fee fields separate without guessing their units',async()=>{
 const requests=[],client=adapter({includePublicDetails:true,fetcher:publicFetcher({listing:observedListing({
  base_currency:'USDT',quote_currency:'BTC',quantity_increment:.5,maker:.001,taker:.002,unknown_secret:'synthetic-hidden'}),
  onRequest:url=>requests.push(url)})});
 const status=await client.refresh(),market=status.markets[0];
 assert.equal(requests.length,5);assert.equal(status.includePublicDetails,true);assert.equal(status.listingCurrency,'BTC');
 assert.deepEqual(status.listingCurrencies,['BTC','ETH','SPOT']);
 assert.deepEqual(requests.filter(url=>url.pathname.endsWith('/get_instruments')).map(url=>url.searchParams.get('currency')),['BTC','ETH','SPOT']);
 assert.equal(status.listingCurrencyVerified,false);assert.equal(status.dataSource,'REAL_PUBLIC_READ_ONLY');
 assert.equal(status.verification.protocolReference,'USER_REPORTED_PARAMETERS_AND_SDK_REFERENCE');
 assert.equal(market.listingObserved,true);assert.equal(market.active,true);assert.equal(market.actualInstrumentName,BTC);
 assert.equal(market.listingStatus,'OBSERVED_ACTIVE');assert.equal(market.contractFields.min_trade_amount.value,.1);
 assert.equal(market.contractFields.min_qty.value,.01);assert.equal(market.contractFields.min_notional.value,5);
 assert.equal(market.contractFields.quantity_increment.value,.5);assert.equal(market.contractFields.tick_size.value,.01);
 assert.equal(market.contractFields.base_currency.value,'USDT');assert.equal(market.contractFields.quote_currency.value,'BTC');
 assert.equal(market.currencyDefinitionsVerified,false);assert.equal(market.symbolMappingVerified,false);
 assert.equal(market.contractFields.maker_commission.value,0);assert.equal(market.contractFields.maker_commission.units,'UNVERIFIED');
 assert.equal(market.contractFields.maker.value,.001);assert.equal(market.contractFields.taker.value,.002);
 assert.deepEqual(market.fees,{units:'UNVERIFIED',makerBps:null,takerBps:null});
 assert.equal(market.minQty,null);assert.equal(market.qtyStep,null);assert.equal(market.priceTick,null);
 assert.equal(market.tradable,false);assert.equal(market.instrumentVerified,false);assert.equal(status.orderSubmissionEnabled,false);
 assert.equal(status.verification.officialSpec,'UNVERIFIED');assert.doesNotMatch(JSON.stringify(status),/synthetic-hidden|unknown_secret/);
});

test('book and ticker clocks are independent and a midpoint never supplies a missing Mark',async()=>{
 for(const timestamp of [undefined,null,T-90001,T+5001,T/1000]){
  const client=adapter({includePublicDetails:true,fetcher:publicFetcher({ticker:{instrument_name:BTC,mark_price:100.4,timestamp}})});
  const market=(await client.refresh()).markets[0];assert.equal(market.fresh,true);assert.equal(market.markPrice,100.4);
  assert.equal(market.markPriceFresh,false);assert.notEqual(market.markPriceAt,market.priceAt);
 }
 const noMark=adapter({includePublicDetails:true,fetcher:publicFetcher({ticker:{instrument_name:BTC,timestamp:T}})});
 const market=(await noMark.refresh()).markets[0];assert.equal(market.midPrice,100.5);assert.equal(market.markPrice,null);
 assert.equal(market.markPriceAt,null);assert.equal(market.markPriceFresh,false);
});

test('explicit invalid or stale Mark clocks cannot fall back to an otherwise fresh ticker timestamp',async()=>{
 for(const mark_timestamp of [undefined,null,'invalid',false,[],T/1000,T-90001]){
  const client=adapter({fetcher:publicFetcher({ticker:{instrument_name:BTC,mark_price:100.4,timestamp:T,mark_timestamp}})});
  // JSON omits undefined, so exercise that absence separately below.
  const ticker=await client.getPublicTickers(BTC);
  assert.equal(ticker.markPriceFresh,mark_timestamp===undefined);
  if(mark_timestamp!==undefined)assert.notEqual(ticker.markPriceAt,T);
 }
 const client=adapter({fetcher:publicFetcher({ticker:{instrument_name:BTC,mark_price:'100.4',timestamp:T,mark_timestamp:T-1000}})});
 const result=await client.getPublicTickers(BTC);assert.equal(result.markPriceFresh,true);assert.equal(result.markPriceAt,T-1000);
 assert.equal(result.markPriceAtSource,'result.mark_timestamp');
});

test('cached Mark and book freshness are reevaluated separately after their original clocks age',async()=>{
 let now=T;const client=adapter({includePublicDetails:true,now:()=>now,
  fetcher:publicFetcher({ticker:{instrument_name:BTC,mark_price:100.4,timestamp:T-10000}})});
 await client.refresh();now+=80001;const market=client.getStatus().markets[0];
 assert.equal(market.fresh,true);assert.equal(market.markPriceFresh,false);
});

test('observed precision checks explicit price/quantity increments and never uses a minimum as an increment',async()=>{
 const inspect=async listing=>(await adapter({includePublicDetails:true,fetcher:publicFetcher({listing})}).refresh()).markets[0].precision;
 const noStep=await inspect(observedListing());assert.equal(noStep.priceGrid,'MATCH');assert.equal(noStep.quantityGrid,'UNVERIFIED');
 assert.equal(noStep.quantityBasis,null);assert.equal(noStep.unitsVerified,false);
 const exact=await inspect(observedListing({qty_step:.5}));assert.equal(exact.quantityGrid,'MATCH');assert.equal(exact.quantityBasis,'qty_step');
 const explicitQuantityStep=await inspect(observedListing({quantity_step:.5}));assert.equal(explicitQuantityStep.quantityGrid,'MATCH');assert.equal(explicitQuantityStep.quantityBasis,'quantity_step');
 const wrong=await inspect(observedListing({tick_size:.3,quantity_increment:.3}));assert.equal(wrong.priceGrid,'MISMATCH');assert.equal(wrong.quantityGrid,'MISMATCH');
 const conflict=await inspect(observedListing({qty_step:.5,quantity_increment:.3}));assert.equal(conflict.quantityGrid,'UNVERIFIED');
 const otherConflict=await inspect(observedListing({qty_step:.5,quantity_step:.3}));assert.equal(otherConflict.quantityGrid,'UNVERIFIED');
});

test('unobserved, inactive and unknown listing status are distinct and never approve an instrument',async()=>{
 const inactive=adapter({includePublicDetails:true,fetcher:publicFetcher({listing:observedListing({is_active:false})})});
 const inactiveMarket=(await inactive.refresh()).markets[0];assert.equal(inactiveMarket.listingObserved,true);assert.equal(inactiveMarket.active,false);
 assert.equal(inactiveMarket.listingStatus,'OBSERVED_INACTIVE');assert.equal(inactiveMarket.tradable,false);
 const unknown=adapter({includePublicDetails:true,fetcher:publicFetcher({listing:observedListing({is_active:'true'})})});
 const unknownMarket=(await unknown.refresh()).markets[0];assert.equal(unknownMarket.listingObserved,true);assert.equal(unknownMarket.active,null);
 assert.equal(unknownMarket.listingStatus,'OBSERVED_STATUS_UNKNOWN');
 const missing=adapter({includePublicDetails:true,fetcher:publicFetcher({listing:observedListing({instrument_name:'ETH-USDT-PERPETUAL'})})});
 const missingMarket=(await missing.refresh()).markets[0];assert.equal(missingMarket.listingObserved,false);assert.equal(missingMarket.active,null);
 assert.equal(missingMarket.listingStatus,'UNOBSERVED');assert.equal(missingMarket.actualInstrumentName,null);
});

test('per-instrument ticker mismatches and ambiguous collections fail closed without retaining a Mark',async()=>{
 for(const ticker of [{instrument_name:'ETH-USDT-PERPETUAL',mark_price:100.4,timestamp:T},
  {mark_price:100.4,timestamp:T},[{instrument_name:BTC,mark_price:100.4,timestamp:T},{instrument_name:BTC,mark_price:100.5,timestamp:T}]]){
  const client=adapter({includePublicDetails:true,fetcher:publicFetcher({ticker})}),status=await client.refresh();
  assert.equal(status.connected,true);assert.equal(status.marketStatus,'partial');assert.equal(status.markets[0].markPrice,null);
  assert.equal(status.errors.length,1);assert.equal(status.errors[0].endpoint,'ticker');assert.equal(status.errors[0].httpStatus,200);
 }
});

test('listing, ticker and book failures remain separate while successful observations survive',async()=>{
 for(const failed of ['get_instruments','tickers','get_order_book']){
  const base=publicFetcher(),client=adapter({includePublicDetails:true,fetcher:async(url,options)=>
   new URL(url).pathname.endsWith('/'+failed)?new Response('synthetic-private-provider-body',{status:403}):base(url,options)});
  const status=await client.refresh(),market=status.markets[0];assert.equal(status.errors.length,failed==='get_instruments'?3:1);
  if(failed==='get_instruments')assert.deepEqual(status.errors.map(error=>error.listingCurrency),['BTC','ETH','SPOT']);
  assert.equal(status.errors[0].endpoint,failed==='get_instruments'?'instruments':failed==='tickers'?'ticker':'book');
  assert.equal(status.errors[0].httpStatus,403);assert.equal(status.errors[0].responseSource,'UNCONFIRMED');
  assert.equal(status.dataSource,'REAL_PUBLIC_READ_ONLY','successful book/listing/Mark observations survive a different endpoint failure');
  assert.equal(market.bookObserved,failed!=='get_order_book');assert.equal(market.listingObserved,failed!=='get_instruments');
  assert.equal(market.markPrice,failed==='tickers'?null:100.4);
  if(failed==='get_order_book'){assert.equal(market.bid,null);assert.equal(market.fresh,false);assert.equal(status.connected,false)}
  else assert.equal(market.bid,100);
  assert.doesNotMatch(JSON.stringify(status),/synthetic-private-provider-body/);
 }
});

test('metadata schema errors never turn duplicate or unknown responses into verified empty listings',async()=>{
 for(const rows of [[observedListing(),observedListing()],{data:[observedListing()]},[{instrument_name:'invalid name'}]]){
  const client=adapter({fetcher:async()=>envelope(rows)});await assert.rejects(client.getPublicInstruments('USDT'),code('INVALID_RESPONSE'));
 }
 for(const includePublicDetails of ['true',1,null])assert.throws(()=>adapter({includePublicDetails}),code('INVALID_CONFIG'));
 for(const listingCurrency of ['',null,'usdt','../auth'])assert.throws(()=>adapter({listingCurrency}),code('INVALID_CONFIG'));
});
