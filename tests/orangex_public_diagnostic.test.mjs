import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {classifyCurl,curlPublicProbe,diagnoseOrangeXPublic,observeBook,publicProbeURL} from '../scripts/diagnose-orangex-public.mjs';

const NOW=1793100000000;
const book={bids:[[100,1],[99,2]],asks:[[101,2],[102,1]],timestamp:NOW};
const ok=(kind,result)=>({kind,category:'OK',responseSource:'UNCONFIRMED',exitCode:0,proxyConnectStatus:200,httpStatus:200,
 body:kind==='docs'?'/public/get_order_book /public/get_instruments /public/tickers':JSON.stringify({result})});
const fixture=(mutate=()=>{})=>(async(kind,name)=>{
 let result=kind==='instruments'?['BTC','ETH','SOL'].map(asset=>({instrument_name:`${asset}-USDT-PERPETUAL`,is_active:true,
  base_currency:asset,quote_currency:'USDT',contract_size:1,min_trade_amount:0.01,min_qty:0.001,min_order_amount:0.001,
  qty_step:0.0001,min_notional:5,tick_size:0.01,maker_fee:0,taker_fee:0.0005})):
  kind==='tickers'?[{instrument_name:name,mark_price:100.5,timestamp:NOW}]:
  {...book,instrument_name:name};
 mutate(kind,result);return ok(kind,result);
});

test('public diagnostic allows only fixed HTTPS GET probes and safe contract names',()=>{
 assert.equal(publicProbeURL('instruments'),'https://api.orangex.com/api/v1/public/get_instruments?currency=BTC');
 assert.equal(publicProbeURL('tickers','BTC-USDT-PERPETUAL'),'https://api.orangex.com/api/v1/public/tickers?instrument_name=BTC-USDT-PERPETUAL');
 assert.throws(()=>publicProbeURL('tickers'),/INVALID_PUBLIC_INSTRUMENT/);
 assert.throws(()=>publicProbeURL('instruments',undefined,{currency:'USDT&token=secret'}),/INVALID_PUBLIC_CURRENCY/);
 assert.match(publicProbeURL('book','BTC-USDT-PERPETUAL'),/instrument_name=BTC-USDT-PERPETUAL&depth=20$/);
 for(const key of ['auth','orders','cancel','https://example.com'])assert.throws(()=>publicProbeURL(key),/PUBLIC_ENDPOINT_NOT_ALLOWED/);
 for(const value of ['BTC-USDT-PERPETUAL&token=secret','../../private/buy','BTCUSDT'])assert.throws(()=>publicProbeURL('book',value),/INVALID_PUBLIC_INSTRUMENT/);
});

test('proxy CONNECT refusal is distinct from an origin HTTP error',()=>{
 assert.deepEqual(classifyCurl({exitCode:56,proxyConnectStatus:403}),{category:'PROXY_CONNECT_REJECTED',responseSource:'PROXY'});
 assert.deepEqual(classifyCurl({exitCode:0,proxyConnectStatus:200,httpStatus:403}),{category:'HTTP',responseSource:'UNCONFIRMED'});
});

test('curl diagnostics distinguish DNS, proxy DNS, TLS, timeout, redirects and missing curl',()=>{
 for(const [exitCode,category] of [[5,'PROXY_DNS'],[6,'DNS'],[35,'TLS'],[60,'TLS'],[28,'TIMEOUT'],[7,'NETWORK'],[63,'RESPONSE_TOO_LARGE']]){
  assert.equal(classifyCurl({exitCode}).category,category);
 }
 assert.equal(classifyCurl({exitCode:0,httpStatus:301}).category,'REDIRECT_NOT_FOLLOWED');
 assert.equal(classifyCurl({processError:'ENOENT'}).category,'CURL_NOT_FOUND');
 assert.equal(classifyCurl({processError:'PROCESS_TIMEOUT'}).category,'TIMEOUT');
});

test('Windows transport uses curl.exe without shell, curlrc, authentication or redirect bypass',async()=>{
 let invocation;
 const spawnProcess=(command,args,options)=>{
  invocation={command,args,options};const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();
  queueMicrotask(()=>{child.stdout.write('{"result":[]}\n__SIGNALLAB_CURL_STATUS__200,200');child.stderr.write('sensitive-proxy-error');child.emit('close',0)});
  return child;
 };
 const result=await curlPublicProbe('instruments',undefined,{platform:'win32',spawnProcess});
 assert.equal(invocation.command,'curl.exe');assert.equal(invocation.args[0],'--disable');assert.equal(invocation.options.shell,false);
 assert.equal(invocation.args[invocation.args.indexOf('--request')+1],'GET');
 for(const forbidden of ['--location','--insecure','--noproxy','--proxy','--user','--netrc','--data'])assert.ok(!invocation.args.includes(forbidden));
 assert.equal(Object.hasOwn(invocation.options,'env'),false,'proxy and CA environment is inherited');
 assert.equal(result.proxyConnectStatus,200);assert.equal(result.httpStatus,200);assert.equal(result.category,'OK');
 assert.equal(JSON.stringify(result).includes('sensitive-proxy-error'),false);
});

test('missing curl is reported without leaking local exception content',async()=>{
 const spawnProcess=()=>{
  const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();
  queueMicrotask(()=>{child.emit('error',Object.assign(new Error('secret-path'),{code:'ENOENT'}));child.emit('close',-2)});return child;
 };
 const result=await curlPublicProbe('docs',undefined,{spawnProcess});
 assert.equal(result.category,'CURL_NOT_FOUND');assert.equal(JSON.stringify(result).includes('secret-path'),false);
});

test('book observation computes actual best bid/ask and never turns midpoint into Mark Price',()=>{
 const result=observeBook(book,NOW);
 assert.equal(result.bid,100);assert.equal(result.ask,101);assert.equal(result.spread,1);
 assert.equal(result.spreadBps,1/100.5*10000);assert.equal(result.markPrice,null);assert.equal(result.fresh,true);
 assert.equal(result.bookIntegrity.valid,true);
 const unsorted=observeBook({...book,bids:[[99,2],[100,1]],asks:[[102,1],[101,2]]},NOW);
 assert.equal(unsorted.bid,100);assert.equal(unsorted.ask,101);assert.equal(unsorted.bookIntegrity.valid,false);
 assert.ok(unsorted.bookIntegrity.issues.includes('BOOK_UNSORTED'));
 assert.equal(observeBook({...book,timestamp:NOW-90001},NOW).fresh,false);
 assert.equal(observeBook({...book,timestamp:NOW+6000},NOW).fresh,false);
 assert.equal(observeBook({...book,timestamp:NOW/1000},NOW).fresh,null);
 assert.equal(observeBook({...book,bids:[[102,1]]},NOW),null);
 assert.equal(observeBook({...book,asks:[[101,0]]},NOW),null);
 assert.equal(observeBook({...book,bids:Array.from({length:1001},()=>[100,1])},NOW),null);
});

test('successful fixtures record listing, exact contract fields and Mark sources without asserting verified units',async()=>{
 const report=await diagnoseOrangeXPublic({probe:fixture(),now:()=>NOW});
 assert.equal(report.exitCode,0);assert.equal(report.requests.length,10);assert.equal(report.markets.length,3);
 assert.equal(report.officialSpecificationVerified,false);assert.equal(report.mode,'READ_ONLY');
 assert.equal(report.accountChecked,false);assert.equal(report.ordersSubmitted,false);
 for(const row of report.markets){
  assert.equal(row.listingObserved,true);assert.equal(row.active,true);assert.equal(row.orderSubmissionEnabled,false);
  assert.equal(row.contractFields.min_order_amount.value,0.001);assert.equal(row.contractFields.min_notional.value,5);
  assert.equal(row.contractFields.min_trade_amount.value,0.01);assert.equal(row.contractFields.min_qty.value,0.001);
  assert.equal(row.contractFields.qty_step.value,0.0001);assert.equal(row.quantityIncrementVerified,false);
  assert.equal(row.contractFields.maker_fee.value,0);assert.equal(row.contractFields.maker_fee.units,'UNVERIFIED');
  assert.equal(row.minimumOrderQuantityVerified,false);assert.equal(row.feeUnitsVerified,false);
  assert.equal(row.markPrice,100.5);assert.match(row.markPriceSource,/result\[\d\]\.mark_price/);
  assert.equal(row.markPriceTimestamp,NOW);assert.equal(row.markPriceAgeMs,0);assert.equal(row.markPriceFresh,true);
 }
 assert.ok(report.requests.every(row=>row.method==='GET'&&!row.parameterSpecificationVerified));
});

test('empty listing never confirms candidate names and absent fees/minimum quantity stay absent',async()=>{
 const report=await diagnoseOrangeXPublic({probe:async(kind,name)=>ok(kind,kind==='instruments'||kind==='tickers'?[]:{...book,instrument_name:name}),now:()=>NOW});
 for(const row of report.markets){
  assert.equal(row.listingObserved,false);assert.equal(row.active,null);assert.equal(row.contractNameSource,'SDK_CANDIDATE_ONLY');
  assert.deepEqual(row.contractFields,{});assert.equal(row.markPrice,null);
 }
});

test('a malformed book or mismatched contract is a schema failure rather than observed data',async()=>{
 const report=await diagnoseOrangeXPublic({probe:fixture((kind,result)=>{if(kind==='book')result.instrument_name='WRONG-USDT-PERPETUAL'}),now:()=>NOW});
 assert.equal(report.exitCode,1);assert.equal(report.status,'INCOMPLETE');
 assert.equal(report.requests.filter(row=>row.category==='SCHEMA').length,3);assert.ok(report.markets.every(row=>row.book===null));
});

test('unsupported list schema and API errors do not imply confirmed delisting or emit raw bodies',async()=>{
 const probe=async(kind,name)=>kind==='instruments'?ok(kind,{unexpected:'private-token'}):kind==='tickers'?
  {...ok(kind,[]),body:JSON.stringify({error:{message:'private-token'}})}:ok(kind,{...book,instrument_name:name});
 const report=await diagnoseOrangeXPublic({probe,now:()=>NOW});
 assert.equal(report.exitCode,1);assert.equal(report.requests.find(row=>row.kind==='instruments').category,'SCHEMA');
 assert.equal(report.requests.find(row=>row.kind==='tickers').category,'API');assert.equal(JSON.stringify(report).includes('private-token'),false);
 assert.ok(report.markets.every(row=>row.listingObserved===false));
});

test('proxy failure report preserves layer-specific evidence without inventing any prices',async()=>{
 const report=await diagnoseOrangeXPublic({probe:async()=>({category:'PROXY_CONNECT_REJECTED',responseSource:'PROXY',exitCode:56,proxyConnectStatus:403,httpStatus:null,body:''}),now:()=>NOW});
 assert.equal(report.exitCode,2);assert.equal(report.requests.length,10);
 assert.ok(report.requests.every(row=>row.proxyConnectStatus===403&&row.httpStatus===null));
 assert.ok(report.markets.every(row=>!row.listingObserved&&row.book===null&&row.markPrice===null));
});

test('stale, future or undated books preserve observations but fail freshness completion',async()=>{
 for(const timestamp of [NOW-90001,NOW+5001,null,NOW/1000]){
  const report=await diagnoseOrangeXPublic({probe:fixture((kind,result)=>{if(kind==='book')result.timestamp=timestamp}),now:()=>NOW});
  assert.equal(report.exitCode,1);assert.equal(report.status,'INCOMPLETE');
  assert.equal(report.requests.filter(row=>row.category==='FRESHNESS').length,3);
  assert.ok(report.markets.every(row=>row.book.bid===100&&row.book.fresh!==true));
 }
});

test('listing duplicates and large contract lists produce bounded unique public book requests',async()=>{
 const requested=[];
 const probe=async(kind,name)=>{
  if(kind==='instruments')return ok(kind,Array.from({length:100},(_,i)=>({instrument_name:`BTC-Q${i}-PERPETUAL`}))
   .concat(Array.from({length:100},()=>({instrument_name:'BTC-Q0-PERPETUAL'}))));
  if(kind==='tickers')return ok(kind,[]);
  if(kind==='book')requested.push(name);
  return ok(kind,{...book,instrument_name:name});
 };
 const report=await diagnoseOrangeXPublic({probe,now:()=>NOW});
 assert.equal(requested.length,5);assert.equal(new Set(requested).size,5);
 assert.equal(report.markets.filter(row=>row.asset==='BTC').length,3);
 assert.equal(report.markets[0].additionalContractsOmitted,97);
});

test('ticker Mark timestamp and freshness are independent from the latest book',async()=>{
 for(const [timestamp,expectedFresh] of [[NOW,true],[NOW-90001,false],[NOW+5001,false],[null,null],[NOW/1000,null]]){
  const report=await diagnoseOrangeXPublic({probe:fixture((kind,result)=>{if(kind==='tickers')for(const row of result)row.timestamp=timestamp}),now:()=>NOW});
  for(const row of report.markets){
   assert.equal(row.book.fresh,true);assert.equal(row.markPrice,100.5);assert.equal(row.markPriceTimestamp,timestamp);
   assert.equal(row.markPriceFresh,expectedFresh);
   assert.equal(row.markPriceAgeMs,expectedFresh===null?null:NOW-timestamp);
   if(timestamp!==null)assert.match(row.markPriceTimestampSource,/result\[\d\]\.timestamp/);
  }
 }
});

test('unsupported result.data schema exposes only closed type hints without arbitrary keys or values',async()=>{
 const probe=async(kind,name)=>kind==='instruments'?ok(kind,{data:[{instrument_name:'BTC-USDT-PERPETUAL',secret_key:'sensitive-value'}],
  arbitrary_secret_key:'other-sensitive-value'}):kind==='tickers'?ok(kind,[]):ok(kind,{...book,instrument_name:name});
 const report=await diagnoseOrangeXPublic({probe,now:()=>NOW}),request=report.requests.find(row=>row.kind==='instruments');
 assert.equal(request.status,'FAILED');assert.equal(request.category,'SCHEMA');
 assert.deepEqual(request.schemaObservation,{envelopeType:'OBJECT',resultType:'OBJECT',knownResultFields:{data:'ARRAY'}});
 const output=JSON.stringify(report);
 for(const text of ['secret_key','sensitive-value','arbitrary_secret_key','other-sensitive-value'])assert.equal(output.includes(text),false);
 assert.equal(report.officialSpecificationVerified,false);
});

test('public diagnostic supplies mandatory parameters and gets each contract ticker independently',async()=>{
 const calls=[],base=fixture();
 const report=await diagnoseOrangeXPublic({probe:async(kind,name,options)=>{
  calls.push({kind,name,url:publicProbeURL(kind,name,options)});return base(kind,name);
 },now:()=>NOW});
 assert.equal(report.exitCode,0);assert.equal(calls.length,10);
 assert.deepEqual(calls.filter(row=>row.kind==='tickers').map(row=>row.name),['BTC','ETH','SOL'].map(asset=>`${asset}-USDT-PERPETUAL`));
 assert.equal(calls.find(row=>row.kind==='instruments').url,'https://api.orangex.com/api/v1/public/get_instruments?currency=BTC');
 assert.ok(calls.filter(row=>row.kind==='tickers').every(row=>new URL(row.url).searchParams.get('instrument_name')===row.name));
 assert.equal(report.currencyMeaning,'TRADING_DOMAIN');assert.deepEqual(report.currencies,['BTC','ETH','SPOT']);assert.ok(report.requests.every(row=>!row.parameterSpecificationVerified));
});

test('ticker Mark is never borrowed from a book, another contract or a fallback clock',async()=>{
 for(const mode of ['missing-mark','wrong-contract','invalid-mark-clock','old-mark-clock']){
  const report=await diagnoseOrangeXPublic({probe:fixture((kind,result)=>{
   if(kind==='book'){result.mark_price=101;result.mark_timestamp=NOW}
   if(kind==='tickers')for(const row of result){
    if(mode==='missing-mark')delete row.mark_price;
    if(mode==='wrong-contract')row.instrument_name='WRONG-USDT-PERPETUAL';
    if(mode==='invalid-mark-clock')row.mark_timestamp=null;
    if(mode==='old-mark-clock')row.mark_timestamp=NOW-90001;
   }
  }),now:()=>NOW});
  assert.equal(report.exitCode,1);assert.equal(report.requests.filter(row=>row.kind==='tickers'&&row.status==='FAILED').length,3);
  for(const market of report.markets){
   assert.equal(market.book.fresh,true);
   if(['missing-mark','wrong-contract'].includes(mode)){assert.equal(market.markPrice,null);assert.equal(market.markPriceSource,null)}
   else{assert.equal(market.markPrice,100.5);assert.notEqual(market.markPriceFresh,true)}
  }
 }
});

test('raw order limits and currency names stay separate from unit semantics and precision observations',async()=>{
 const report=await diagnoseOrangeXPublic({probe:fixture((kind,result)=>{
  if(kind==='instruments')for(const row of result){
   row.base_currency='USDT';row.quote_currency='BTC';row.quantity_increment=.3;row.quantity_step=.0002;
   row.maker=.02;row.taker=.05;row.maker_fee_rate=.0002;row.taker_fee_rate=.0005;
  }
 }),now:()=>NOW});
 assert.equal(report.exitCode,0);
 for(const market of report.markets){
  assert.equal(market.contractFields.min_trade_amount.value,.01);assert.equal(market.contractFields.min_qty.value,.001);
  assert.equal(market.contractFields.qty_step.value,.0001);assert.equal(market.contractFields.quantity_increment.value,.3);
  assert.equal(market.contractFields.quantity_step.value,.0002);
  for(const [field,value] of [['maker',.02],['taker',.05],['maker_fee_rate',.0002],['taker_fee_rate',.0005]]){
   assert.equal(market.contractFields[field].value,value);assert.equal(market.contractFields[field].units,'UNVERIFIED');
  }
  assert.equal(market.contractFields.base_currency.value,'USDT');assert.equal(market.contractFields.quote_currency.value,'BTC');
  assert.equal(market.contractFields.base_currency.meaning,'UNVERIFIED');assert.equal(market.feeUnitsVerified,false);
  assert.equal(market.precisionObservations.priceTick.allObservedLevelsAligned,true);
  assert.deepEqual(market.precisionObservations.quantityCandidates.map(row=>[row.field,row.allObservedLevelsAligned]),[['qty_step',true],['quantity_step',true],['quantity_increment',false]]);
  assert.ok(market.precisionObservations.quantityCandidates.every(row=>row.unitsVerified===false));
  assert.equal(market.book.bids.length,2);assert.equal(market.book.asks.length,2);
 }
});

test('per-instrument ticker object responses preserve exact Mark source while remaining schema-unverified',async()=>{
 const base=fixture();const report=await diagnoseOrangeXPublic({probe:async(kind,name)=>kind==='tickers'?
  ok(kind,{instrument_name:name,mark_price:100.5,timestamp:NOW,mark_timestamp:NOW-1000}):base(kind,name),now:()=>NOW});
 assert.equal(report.exitCode,0);
 for(const market of report.markets){
  assert.equal(market.markPriceSource,'result.mark_price');assert.equal(market.markPriceTimestampSource,'result.mark_timestamp');
  assert.equal(market.markPriceAgeMs,1000);assert.equal(market.officialSpecificationVerified,false);
 }
});
