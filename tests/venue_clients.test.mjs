import test from 'node:test';
import assert from 'node:assert/strict';
import {BingXMarketData,BINGX_HOSTS,spacedQueue} from '../bingx_market.mjs';
import {GateMarketData,GATEIO_HOST} from '../gateio_market.mjs';
import {VenueQuoteService,parseVenueSymbols,MAX_VENUE_SYMBOLS} from '../venue_service.mjs';
import {normalizeBook} from '../venue_market_data.mjs';

const json=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}});
const NOW=Date.parse('2026-11-10T12:00:00Z');
function recorder(handler){const calls=[];const fetcher=async(url,options)=>{calls.push({url:String(url),options});return handler(String(url),options)};return {calls,fetcher}}

test('BingX client calls only documented public GET paths on the official host, without credentials',async()=>{
 const {calls,fetcher}=recorder(url=>url.includes('/contracts')?json({code:0,msg:'',data:[{symbol:'BTC-USDT',currency:'USDT',asset:'BTC',pricePrecision:1,quantityPrecision:4,tradeMinQuantity:0.0001,tradeMinUSDT:2,status:1,apiStateOpen:'true',apiStateClose:'true'}]})
  :json({code:0,msg:'',data:{T:NOW,bids:[['1','1']],asks:[['1.1','1']]}}));
 const client=new BingXMarketData({fetcher,now:()=>NOW,minIntervalMs:0});
 const contracts=await client.loadContracts();assert.equal(contracts.get('BTCUSDT').tickSize,'0.1');
 await client.loadContracts();assert.equal(calls.length,2,'contracts (+ one clock sync) are cached');
 const book=await client.book('BTCUSDT');assert.equal(book.ok,true);
 assert.deepEqual(calls.map(c=>new URL(c.url).origin+new URL(c.url).pathname),[BINGX_HOSTS[0]+'/openApi/swap/v2/quote/contracts',BINGX_HOSTS[0]+'/openApi/swap/v2/server/time',BINGX_HOSTS[0]+'/openApi/swap/v2/quote/depth']);
 assert.equal(new URL(calls[2].url).searchParams.get('symbol'),'BTC-USDT');
 for(const c of calls){assert.equal(c.options.method,'GET');assert.equal(c.options.redirect,'error');
  assert.ok(!Object.keys(c.options.headers).some(h=>/key|sign|auth/i.test(h)),'no credential headers');assert.equal(c.options.body,undefined)}
});

test('BingX falls back to .pro only on network failure, never on a business error',async()=>{
 const net=recorder(url=>{if(url.startsWith(BINGX_HOSTS[0]))throw TypeError('fetch failed');return json({code:0,data:{T:NOW,bids:[['1','1']],asks:[['2','1']]}})});
 assert.equal((await new BingXMarketData({fetcher:net.fetcher,now:()=>NOW,minIntervalMs:0}).book('BTCUSDT')).ok,true);
 assert.deepEqual(net.calls.map(c=>new URL(c.url).origin),BINGX_HOSTS);
 const biz=recorder(()=>json({code:100410,msg:'rate limited'}));
 await assert.rejects(new BingXMarketData({fetcher:biz.fetcher,now:()=>NOW,minIntervalMs:0}).book('BTCUSDT'),e=>e.code==='VENUE_ERROR_100410');
 assert.equal(biz.calls.length,1,'business error is not retried on the fallback host');
 const down=recorder(()=>{throw TypeError('fetch failed')});
 await assert.rejects(new BingXMarketData({fetcher:down.fetcher,now:()=>NOW,minIntervalMs:0}).book('BTCUSDT'),e=>e.code==='NETWORK_UNREACHABLE');
});

test('BingX requests are spaced at least the documented 1 request/s',async()=>{
 let clock=0;const waits=[];const queue=spacedQueue(1100,{now:()=>clock,sleep:async ms=>{waits.push(ms);clock+=ms}});
 const starts=[];await Promise.all([1,2,3].map(()=>queue(async()=>{starts.push(clock)})));
 assert.deepEqual(starts,[0,1100,2200]);
 const failing=spacedQueue(10,{now:()=>clock,sleep:async ms=>{clock+=ms}});
 await assert.rejects(failing(async()=>{throw Error('x')}));assert.equal(await failing(async()=>'next'),'next','a failure does not block the queue');
});

test('Gate.io client uses the USDT futures public paths and reports HTTP errors with the venue label',async()=>{
 const {calls,fetcher}=recorder(url=>url.includes('/contracts')?json([{name:'ETH_USDT',type:'direct',quanto_multiplier:'0.01',order_price_round:'0.05',order_size_min:1,status:'trading',in_delisting:false}])
  :json({current:NOW/1000,asks:[{p:'10.1',s:3}],bids:[{p:'10',s:2}]}));
 const client=new GateMarketData({fetcher,now:()=>NOW,minIntervalMs:0});
 assert.equal((await client.loadContracts()).get('ETHUSDT').contractSizeBase,'0.01');
 assert.equal((await client.book('ETHUSDT')).ok,true);
 assert.deepEqual(calls.map(c=>{const u=new URL(c.url);return u.origin+u.pathname}),[GATEIO_HOST+'/api/v4/futures/usdt/contracts',GATEIO_HOST+'/api/v4/spot/time',GATEIO_HOST+'/api/v4/futures/usdt/order_book']);
 assert.equal(new URL(calls[2].url).searchParams.get('contract'),'ETH_USDT');assert.ok(calls.every(c=>c.options.method==='GET'));
 const bad=new GateMarketData({fetcher:async()=>json({label:'INVALID_CONTRACT'},400),now:()=>NOW,minIntervalMs:0});
 await assert.rejects(bad.book('ETHUSDT'),e=>e.code==='HTTP_400'&&/INVALID_CONTRACT/.test(e.message));
});

test('oversized or non-JSON venue responses are refused',async()=>{
 const huge=new Response('x'.repeat(10),{headers:{'content-length':'999999999'}});
 await assert.rejects(new GateMarketData({fetcher:async()=>huge,now:()=>NOW,minIntervalMs:0}).loadContracts(),e=>e.code==='RESPONSE_TOO_LARGE');
 await assert.rejects(new GateMarketData({fetcher:async()=>new Response('<html>'),now:()=>NOW,minIntervalMs:0}).loadContracts(),e=>e.code==='RESPONSE_NOT_JSON');
});

test('quote service: one venue failing still returns the other, unlisted symbols are labelled, books are cached briefly',async()=>{
 let now=NOW,bookCalls=0;
 const okBook=venue=>({venue,ok:true,reasons:[],bid:100,ask:100.1,mid:100.05,spreadBps:10,ageMs:0});
 const clients={
  BINGX:{contractsAt:NOW,async loadContracts(){return new Map([['BTCUSDT',{symbol:'BTCUSDT',tradable:true}]])},async book(){bookCalls++;return okBook('BINGX')}},
  GATEIO:{contractsAt:0,async loadContracts(){const e=Error('down');e.code='NETWORK_UNREACHABLE';throw e},async book(){throw Error('unreachable')}}};
 const service=new VenueQuoteService({clients,now:()=>now});
 const first=await service.snapshot(['BTCUSDT','ETHUSDT'],{binancePrice:()=>100});
 assert.equal(first.ordersEnabled,false);assert.equal(first.apiKeysUsed,false);assert.equal(first.chartReference,'BINANCE');
 assert.equal(first.rows[0].venues.BINGX.book.ok,true);assert.equal(first.rows[0].venues.GATEIO.error,'NETWORK_UNREACHABLE');
 assert.equal(first.rows[1].venues.BINGX.error,'NOT_LISTED');assert.equal(first.venues.GATEIO.state,'error');
 await service.snapshot(['BTCUSDT']);assert.equal(bookCalls,1,'cached within 5 s');
 now+=6000;await service.snapshot(['BTCUSDT']);assert.equal(bookCalls,2);
 assert.deepEqual(parseVenueSymbols('btcusdt, ETHUSDT,bad!,BTCUSDT'),['BTCUSDT','ETHUSDT']);
 assert.equal(parseVenueSymbols(Array.from({length:10},(_,i)=>`C${i}USDT`).join(',')).length,MAX_VENUE_SYMBOLS);
 assert.deepEqual(parseVenueSymbols('',['SOLUSDT']),['SOLUSDT']);
});

test('venue clock: the offset is measured from server time and book ages are judged on the local clock',async()=>{
 // PC clock 8 s ahead of the venue (as observed on a user PC): venue time = local - 8000.
 let local=NOW;const skew=-8000;
 const fetcher=async url=>{
  if(url.includes('/server/time'))return json({code:0,data:{serverTime:local+skew}});
  if(url.includes('/contracts'))return json({code:0,data:[{symbol:'BTC-USDT',currency:'USDT',asset:'BTC',pricePrecision:1,quantityPrecision:4,tradeMinQuantity:0.0001,tradeMinUSDT:2,status:1,apiStateOpen:'true',apiStateClose:'true'}]});
  return json({code:0,data:{T:local+skew-300,bids:[['1','1']],asks:[['1.1','1']]}});
 };
 const client=new BingXMarketData({fetcher,now:()=>local,minIntervalMs:0});
 await client.loadContracts();assert.equal(client.clockOffsetMs,-8000);
 const book=await client.book('BTCUSDT');assert.equal(book.ageMs,300,'0.3 s old, not 8.3 s');assert.equal(book.sourceTime,local-300,'local time base');
 local+=10000;const late=normalizeBook('BINGX',{T:local+skew-300,bids:[['1','1']],asks:[['1.1','1']]},{receivedAt:local,now:local,clockOffsetMs:client.clockOffsetMs});
 assert.equal(late.ok,true);
 const unsynced=normalizeBook('BINGX',{T:local+skew-300,bids:[['1','1']],asks:[['1.1','1']]},{receivedAt:local,now:local+8000});
 assert.deepEqual(unsynced.reasons,['BOOK_STALE'],'without the offset an 8 s skew plus delay looks stale');
 const gate=new GateMarketData({fetcher:async url=>url.includes('/spot/time')?json({server_time:local+2500}):json([{name:'BTC_USDT',type:'direct',quanto_multiplier:'0.0001',order_price_round:'0.1',order_size_min:1,status:'trading',in_delisting:false}]),now:()=>local,minIntervalMs:0});
 await gate.loadContracts();assert.equal(gate.clockOffsetMs,2500);
 const failing=new GateMarketData({fetcher:async url=>{if(url.includes('/spot/time'))throw TypeError('fetch failed');return json([{name:'BTC_USDT',type:'direct',quanto_multiplier:'0.0001',order_price_round:'0.1',order_size_min:1,status:'trading'}])},now:()=>local,minIntervalMs:0});
 await failing.loadContracts();assert.equal(failing.clockOffsetMs,0,'a failed time sync never blocks contracts');
});
