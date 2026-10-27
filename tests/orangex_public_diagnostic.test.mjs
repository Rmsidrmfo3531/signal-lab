import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {classifyCurl,curlPublicProbe,diagnoseOrangeXPublic,observeBook,publicProbeURL} from '../scripts/diagnose-orangex-public.mjs';

const NOW=1793100000000;
const book={bids:[[99,2],[100,1]],asks:[[102,1],[101,2]],timestamp:NOW};
const ok=(kind,result)=>({kind,category:'OK',responseSource:'UNCONFIRMED',exitCode:0,proxyConnectStatus:200,httpStatus:200,
 body:kind==='docs'?'/public/get_order_book /public/get_instruments /public/tickers':JSON.stringify({result})});
const fixture=(mutate=()=>{})=>(async(kind,name)=>{
 let result=kind==='instruments'?['BTC','ETH','SOL'].map(asset=>({instrument_name:`${asset}-USDT-PERPETUAL`,is_active:true,
  base_currency:asset,quote_currency:'USDT',contract_size:1,min_order_amount:0.001,min_notional:5,tick_size:0.01,maker_fee:0,taker_fee:0.0005})):
  kind==='tickers'?['BTC','ETH','SOL'].map(asset=>({instrument_name:`${asset}-USDT-PERPETUAL`,mark_price:100.5})):
  {...book,instrument_name:name};
 mutate(kind,result);return ok(kind,result);
});

test('public diagnostic allows only fixed HTTPS GET probes and safe contract names',()=>{
 assert.equal(publicProbeURL('instruments'),'https://api.orangex.com/api/v1/public/get_instruments');
 assert.equal(publicProbeURL('tickers'),'https://api.orangex.com/api/v1/public/tickers');
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
 assert.equal(observeBook({...book,timestamp:NOW-90001},NOW).fresh,false);
 assert.equal(observeBook({...book,timestamp:NOW+6000},NOW).fresh,false);
 assert.equal(observeBook({...book,timestamp:NOW/1000},NOW).fresh,null);
 assert.equal(observeBook({...book,bids:[[102,1]]},NOW),null);
 assert.equal(observeBook({...book,asks:[[101,0]]},NOW),null);
 assert.equal(observeBook({...book,bids:Array.from({length:1001},()=>[100,1])},NOW),null);
});

test('successful fixtures record listing, exact contract fields and Mark sources without asserting verified units',async()=>{
 const report=await diagnoseOrangeXPublic({probe:fixture(),now:()=>NOW});
 assert.equal(report.exitCode,0);assert.equal(report.requests.length,6);assert.equal(report.markets.length,3);
 assert.equal(report.officialSpecificationVerified,false);assert.equal(report.mode,'READ_ONLY');
 assert.equal(report.accountChecked,false);assert.equal(report.ordersSubmitted,false);
 for(const row of report.markets){
  assert.equal(row.listingObserved,true);assert.equal(row.active,true);assert.equal(row.orderSubmissionEnabled,false);
  assert.equal(row.contractFields.min_order_amount.value,0.001);assert.equal(row.contractFields.min_notional.value,5);
  assert.equal(row.contractFields.maker_fee.value,0);assert.equal(row.contractFields.maker_fee.units,'UNVERIFIED');
  assert.equal(row.minimumOrderQuantityVerified,false);assert.equal(row.feeUnitsVerified,false);
  assert.equal(row.markPrice,100.5);assert.match(row.markPriceSource,/result\[\d\]\.mark_price/);
  assert.equal(row.markPriceTimestamp,null);assert.equal(row.markPriceAgeMs,null);assert.equal(row.markPriceFresh,null);
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
 assert.equal(report.exitCode,2);assert.equal(report.requests.length,6);
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
