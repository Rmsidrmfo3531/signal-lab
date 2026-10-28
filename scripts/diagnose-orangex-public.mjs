// Standalone public diagnostics: no .env, application server, account API or store.
// curl keeps the user's proxy/CA policy; --disable prevents a curlrc from adding
// authentication, redirects, uploads or other requests. No response body is logged.
import {spawn} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {DOCUMENTED_LISTING_CURRENCIES,listingDomainInfo,normalizeListingCurrencies,
 reconcileOrangeXListing,orangeXMarketReadiness,orangeXBookIntegrity} from '../orangex_listing_domains.mjs';

const API='https://api.orangex.com/api/v1';
const LIMIT=2*1024*1024;
const MARKER='\n__SIGNALLAB_CURL_STATUS__';
const ASSETS=Object.freeze(['BTC','ETH','SOL']);
const NAME=/^(BTC|ETH|SOL)-[A-Z0-9]{2,12}-PERPETUAL$/;
const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const numeric=value=>{
 if(!['number','string'].includes(typeof value)||typeof value==='string'&&!value.trim())return null;
 const n=Number(value);return Number.isFinite(n)?n:null;
};
const positive=value=>{const n=numeric(value);return n!==null&&n>0?n:null};
const http=value=>/^\d{3}$/.test(String(value))&&Number(value)>=100&&Number(value)<=599?Number(value):null;
function observedClock(value,now){
 const timestamp=numeric(value),milliseconds=timestamp!==null&&timestamp>=946684800000&&timestamp<4102444800000;
 return {timestamp,units:milliseconds?'MILLISECONDS_BY_MAGNITUDE_UNVERIFIED':'UNVERIFIED',
  ageMs:milliseconds?now-timestamp:null,fresh:milliseconds?timestamp<=now+5000&&now-timestamp<=90000:null};
}

export function publicProbeURL(kind,instrumentName,{currency='BTC'}={}){
 if(kind==='docs')return 'https://openapi-docs.orangex.com/';
 const paths={instruments:'/public/get_instruments',tickers:'/public/tickers',book:'/public/get_order_book'};
 if(!Object.hasOwn(paths,kind))throw new Error('PUBLIC_ENDPOINT_NOT_ALLOWED');
 const url=new URL(API+paths[kind]);
 if(kind==='instruments'){
  if(!listingDomainInfo(currency))throw new Error('INVALID_PUBLIC_CURRENCY');
  url.searchParams.set('currency',currency);
 }
 if(kind==='book'||kind==='tickers'){
  if(typeof instrumentName!=='string'||!NAME.test(instrumentName))throw new Error('INVALID_PUBLIC_INSTRUMENT');
  url.searchParams.set('instrument_name',instrumentName);if(kind==='book')url.searchParams.set('depth','20');
 }
 return url.href;
}

export function classifyCurl({exitCode,proxyConnectStatus=null,httpStatus=null,processError=null,tooLarge=false}={}){
 if(proxyConnectStatus!==null&&proxyConnectStatus>=300)return {category:'PROXY_CONNECT_REJECTED',responseSource:'PROXY'};
 if(tooLarge||exitCode===63)return {category:'RESPONSE_TOO_LARGE',responseSource:'UNCONFIRMED'};
 if(processError==='ENOENT')return {category:'CURL_NOT_FOUND',responseSource:'LOCAL'};
 if([5,6].includes(exitCode))return {category:exitCode===5?'PROXY_DNS':'DNS',responseSource:'UNCONFIRMED'};
 if([35,51,53,54,58,59,60,64,66,77,80,82,83,90,91].includes(exitCode))return {category:'TLS',responseSource:'UNCONFIRMED'};
 if(exitCode===28||processError==='PROCESS_TIMEOUT')return {category:'TIMEOUT',responseSource:'UNCONFIRMED'};
 if(exitCode!==0)return {category:'NETWORK',responseSource:'UNCONFIRMED'};
 if(httpStatus===null)return {category:'NETWORK',responseSource:'UNCONFIRMED'};
 if(httpStatus>=300&&httpStatus<400)return {category:'REDIRECT_NOT_FOLLOWED',responseSource:'UNCONFIRMED'};
 if(httpStatus<200||httpStatus>=300)return {category:'HTTP',responseSource:'UNCONFIRMED'};
 return {category:'OK',responseSource:'UNCONFIRMED'};
}

// Exported transport accepts only fixed public probes, never a caller-supplied URL.
export function curlPublicProbe(kind,instrumentName,{spawnProcess=spawn,platform=process.platform,currency='BTC'}={}){
 const url=publicProbeURL(kind,instrumentName,{currency});
 const args=['--disable','--silent','--show-error','--request','GET','--proto','=https',
  '--connect-timeout','6','--max-time','12','--max-filesize',String(LIMIT),
  '--header','Accept: application/json','--write-out',MARKER+'%{http_connect},%{http_code}',
  '--url',url];
 return new Promise(resolve=>{
  let child,timer,chunks=[],size=0,tooLarge=false,processError=null,done=false;
  const finish=code=>{
   if(done)return;done=true;clearTimeout(timer);
   const output=Buffer.concat(chunks).toString('utf8'),index=output.lastIndexOf(MARKER);
   const trailer=index<0?[]:output.slice(index+MARKER.length).trim().split(',');
   const proxyConnectStatus=http(trailer[0]),httpStatus=http(trailer[1]);
   const exitCode=Number.isInteger(code)?code:null;
   resolve({kind,url,exitCode,proxyConnectStatus,httpStatus,processError,tooLarge,
    ...classifyCurl({exitCode,proxyConnectStatus,httpStatus,processError,tooLarge}),
    body:index<0?'':output.slice(0,index)});
  };
  try{
   child=spawnProcess(platform==='win32'?'curl.exe':'curl',args,{shell:false,windowsHide:true,stdio:['ignore','pipe','pipe']});
   child.stdout.on('data',chunk=>{
    size+=chunk.length;
    if(size>LIMIT+4096){tooLarge=true;child.kill();return}
    chunks.push(Buffer.from(chunk));
   });
   // Drain stderr without recording it: proxy URLs/errors may contain secrets.
   child.stderr.on('data',()=>{});
   child.on('error',error=>{processError=error?.code==='ENOENT'?'ENOENT':'SPAWN_ERROR'});
   child.on('close',finish);
   timer=setTimeout(()=>{processError='PROCESS_TIMEOUT';child.kill();},15000);
  }catch{processError='SPAWN_ERROR';finish(null)}
 });
}

function decode(probe){
 const diagnostic={category:probe.category,responseSource:probe.responseSource,exitCode:probe.exitCode,
  proxyConnectStatus:probe.proxyConnectStatus??null,httpStatus:probe.httpStatus??null};
 if(probe.category!=='OK')return {status:'FAILED',diagnostic};
 if(probe.kind==='docs')return {status:'OBSERVED',diagnostic,endpointNamesPresent:
  Object.fromEntries(['/public/get_order_book','/public/get_instruments','/public/tickers'].map(path=>[path,probe.body.includes(path)]))};
 let envelope;try{envelope=JSON.parse(probe.body)}catch{return {status:'FAILED',diagnostic:{...diagnostic,category:'SCHEMA'},schemaObservation:{bodyFormat:'NOT_JSON'}}}
 const type=value=>value===null?'NULL':Array.isArray(value)?'ARRAY':typeof value==='object'?'OBJECT':typeof value==='string'?'STRING':
  typeof value==='number'?'NUMBER':typeof value==='boolean'?'BOOLEAN':'MISSING';
 const result=plain(envelope)?envelope.result:undefined,knownResultFields={};
 for(const key of ['instruments','tickers','data','bids','asks','timestamp','mark_timestamp','instrument_name','mark_price']){
  if(plain(result)&&Object.hasOwn(result,key))knownResultFields[key]=type(result[key]);
 }
 // Closed key names and types only: no arbitrary field names, values or bodies.
 const schemaObservation={envelopeType:type(envelope),resultType:type(result),knownResultFields};
 if(!plain(envelope)||envelope.error||!Object.hasOwn(envelope,'result')||!envelope.result||typeof envelope.result!=='object'){
  return {status:'FAILED',diagnostic:{...diagnostic,category:envelope?.error?'API':'SCHEMA'},schemaObservation};
 }
 return {status:'OBSERVED',diagnostic,result:envelope.result,schemaObservation};
}

function rows(result,key){
 if(Array.isArray(result))return {items:result,path:'result'};
 if(plain(result)&&Array.isArray(result[key]))return {items:result[key],path:`result.${key}`};
 return null;
}

function fields(row,path){
 const output={};
 for(const key of ['contract_size','min_trade_amount','min_qty','min_order_amount','min_order_size','min_notional',
  'lot_size','qty_step','quantity_step','quantity_increment','tick_size','maker_commission','taker_commission','maker_fee','taker_fee',
  'maker_fee_rate','taker_fee_rate','maker','taker']){
  const value=numeric(row?.[key]);
  if(value!==null)output[key]={value,source:`${path}.${key}`,units:'UNVERIFIED'};
 }
 for(const key of ['base_currency','quote_currency','settlement_currency','kind','settlement_period']){
  const value=row?.[key];
  if(typeof value==='string'&&/^[A-Za-z0-9_-]{1,32}$/.test(value))output[key]={value,source:`${path}.${key}`,meaning:'UNVERIFIED'};
 }
 return output;
}

export function observeBook(result,now=Date.now()){
 if(!plain(result)||!Array.isArray(result.bids)||!Array.isArray(result.asks)||!result.bids.length||!result.asks.length||
  result.bids.length>1000||result.asks.length>1000)return null;
 const side=levels=>levels.every(level=>Array.isArray(level)&&level.length>=2&&positive(level[0])!==null&&positive(level[1])!==null);
 if(!side(result.bids)||!side(result.asks))return null;
 const bid=result.bids.reduce((best,level)=>Math.max(best,Number(level[0])),-Infinity),
  ask=result.asks.reduce((best,level)=>Math.min(best,Number(level[0])),Infinity);
 if(bid>=ask)return null;
 const clock=observedClock(result.timestamp,now);
 return {bid,ask,spread:ask-bid,spreadBps:(ask-bid)/((bid+ask)/2)*10000,
  bids:result.bids.map(row=>[Number(row[0]),Number(row[1])]),
  asks:result.asks.map(row=>[Number(row[0]),Number(row[1])]),
  bookIntegrity:orangeXBookIntegrity({bids:result.bids.map(row=>[Number(row[0]),Number(row[1])]),
   asks:result.asks.map(row=>[Number(row[0]),Number(row[1])])}),
  timestamp:clock.timestamp,timestampSource:clock.timestamp===null?null:'result.timestamp',timestampUnits:clock.units,
  ageMs:clock.ageMs,fresh:clock.fresh,
  markPrice:positive(result.mark_price),markPriceSource:positive(result.mark_price)===null?null:'result.mark_price'};
}

export async function diagnoseOrangeXPublic({probe=curlPublicProbe,now=()=>Date.now(),currencies,
 currency,comparisonMode=false}={}){
 // A singular currency is accepted only as an explicit compatibility override.
 // It never supplies a hidden USDT default.
 const requestedCurrencies=normalizeListingCurrencies(currencies??(currency===undefined?DOCUMENTED_LISTING_CURRENCIES:[currency]));
 const checkedAt=new Date(now()).toISOString(),requests=[],discoveries=[];
 const run=async(kind,name,domain=requestedCurrencies[0])=>{
  const raw=await probe(kind,name,{currency:domain}),decoded=decode({...raw,kind});
  requests.push({kind,instrumentName:name??null,url:publicProbeURL(kind,name,{currency:domain}),method:'GET',
   ...(kind==='instruments'?{currency:domain,currencyMeaning:'TRADING_DOMAIN',candidate:listingDomainInfo(domain)}:{}),
   parameterNamesSource:'USER_PROVIDED_OFFICIAL_DOCUMENTATION',parameterSpecificationVerified:false,status:decoded.status,...decoded.diagnostic,
   ...(decoded.schemaObservation?{schemaObservation:decoded.schemaObservation}:{}),
   ...(decoded.endpointNamesPresent?{endpointNamesPresent:decoded.endpointNamesPresent}:{})});
  return decoded;
 };
 await run('docs');
 for(const domain of requestedCurrencies){
  const instruments=await run('instruments',undefined,domain),instrumentRows=rows(instruments.result,'instruments'),request=requests.at(-1);
  if(instruments.status==='OBSERVED'&&(!instrumentRows||instrumentRows.items.length>10000)){request.status='FAILED';request.category='SCHEMA'}
  const grouped=new Map(),duplicateConflicts=new Set();
  if(instrumentRows&&request.status==='OBSERVED')for(const [index,row]of instrumentRows.items.entries()){
   if(!plain(row)||typeof row.instrument_name!=='string'||!NAME.test(row.instrument_name))continue;
   const path=`currency=${domain}:${instrumentRows.path}[${index}]`;
   const item={instrument_name:row.instrument_name,...(typeof row.is_active==='boolean'?{is_active:row.is_active}:{}),
    fields:fields(row,path),nameSource:`${path}.instrument_name`};
   let group=grouped.get(row.instrument_name);
   if(!group){group={rows:[],values:new Map(),active:new Set(),count:0};grouped.set(row.instrument_name,group)}
   group.count++;
   if(typeof item.is_active==='boolean')group.active.add(item.is_active);
   if(group.active.size>1)duplicateConflicts.add(row.instrument_name);
   for(const [key,field]of Object.entries(item.fields)){
    if(group.values.has(key)&&!Object.is(group.values.get(key),field.value))duplicateConflicts.add(row.instrument_name);
    else if(!group.values.has(key))group.values.set(key,field.value);
   }
   // Keep a bounded sample of actual rows, not thousands of repeated rows for
   // the quadratic cross-domain reconciliation. Conflicts remain explicit.
   if(!group.rows.length||duplicateConflicts.has(row.instrument_name)&&group.rows.length<2)group.rows.push(item);
   else if(!duplicateConflicts.has(row.instrument_name)&&group.rows[0].is_active!==true&&item.is_active===true)group.rows[0]=item;
  }
  const items=[...grouped.values()].flatMap(group=>group.rows);
  discoveries.push({currency:domain,status:request.status==='OBSERVED'?'OBSERVED':'FAILED',items,
   instrumentCount:instrumentRows?.items.length??null,httpStatus:request.httpStatus,category:request.category,
   duplicateRowsOmitted:[...grouped.values()].reduce((sum,group)=>sum+group.count-group.rows.length,0),
   duplicateConflictInstruments:[...duplicateConflicts],
   schemaObservation:request.schemaObservation??null});
 }
 const markets=[];
 for(const asset of ASSETS){
  const names=[...new Set(discoveries.flatMap(discovery=>discovery.items.map(item=>item.instrument_name))
   .filter(name=>name.startsWith(asset+'-')))];
  // At most three contracts per asset, never an unrestricted exchange crawler.
  const primary=`${asset}-USDT-PERPETUAL`;
  const selected=names.length?[...names.filter(name=>name===primary),...names.filter(name=>name!==primary)].slice(0,3):[primary];
  for(const instrumentName of selected){
   const listing=reconcileOrangeXListing(instrumentName,discoveries);
   if(discoveries.some(discovery=>discovery.duplicateConflictInstruments.includes(instrumentName))){
    listing.listingConflict=true;listing.active=null;listing.listingDomainEligible=false;listing.listingStatus='OBSERVED_CONFLICT';
   }
   const matches=discoveries.flatMap(discovery=>discovery.items.filter(item=>item.instrument_name===instrumentName)
    .map(item=>({currency:discovery.currency,item})));
   const preferred=matches.find(match=>match.currency===listing.listingSourceCurrency&&
    (typeof match.item.is_active==='boolean'?match.item.is_active:null)===listing.active)??
    matches.find(match=>match.currency===listing.listingSourceCurrency)??matches[0];
   const tickers=await run('tickers',instrumentName),tickerRequest=requests.at(-1),tickerRows=rows(tickers.result,'tickers')??
    (plain(tickers.result)&&typeof tickers.result.instrument_name==='string'?{items:[tickers.result],path:'result'}:null);
   const tickerMatches=(tickerRows?.items??[]).map((item,index)=>({item,index})).filter(({item})=>plain(item)&&item.instrument_name===instrumentName);
   const ticker=tickerMatches.length===1?tickerMatches[0].item:null,
    tickerPath=ticker?tickerRows.path==='result'&&plain(tickers.result)?'result':`${tickerRows.path}[${tickerMatches[0].index}]`:null;
   if(tickers.status==='OBSERVED'&&!ticker){tickerRequest.status='FAILED';tickerRequest.category='SCHEMA'}
   const book=await run('book',instrumentName),bookRequest=requests.at(-1);
   const nameMatches=book.result?.instrument_name===undefined||book.result.instrument_name===instrumentName;
   const observation=book.status==='OBSERVED'&&nameMatches?observeBook(book.result,now()):null;
   if(book.status==='OBSERVED'&&!observation){bookRequest.status='FAILED';bookRequest.category='SCHEMA'}
   const markPrice=positive(ticker?.mark_price),hasMarkTimestamp=ticker!==null&&Object.hasOwn(ticker,'mark_timestamp'),
    markClock=observedClock(hasMarkTimestamp?ticker.mark_timestamp:ticker?.timestamp,now());
   if(tickers.status==='OBSERVED'&&ticker&&markPrice===null){tickerRequest.status='FAILED';tickerRequest.category='SCHEMA'}
   const contractFields=listing.contractFields??{},levels=book.result&&observation?[...book.result.bids,...book.result.asks]:[],
    alignment=(value,step)=>{
     const count=value/step,tolerance=Math.min(1e-6,Math.max(1,Math.abs(count))*Number.EPSILON*8);
     return Number.isSafeInteger(Math.round(count))&&Math.abs(count-Math.round(count))<=tolerance;
    };
   const tick=positive(contractFields.tick_size?.value),quantityCandidates=['qty_step','quantity_step','quantity_increment']
    .filter(key=>positive(contractFields[key]?.value)!==null).map(key=>({field:key,value:Number(contractFields[key].value),
     allObservedLevelsAligned:levels.length?levels.every(level=>alignment(Number(level[1]),Number(contractFields[key].value))):null,unitsVerified:false}));
   markets.push({asset,instrumentName,contractNameSource:preferred?.item.nameSource??'SDK_CANDIDATE_ONLY',...listing,
    additionalContractsOmitted:Math.max(0,names.length-3),officialSpecificationVerified:false,orderSubmissionEnabled:false,
    tickerFields:ticker?fields(ticker,tickerPath):{},book:observation,
    markPrice,markPriceSource:markPrice!==null?`${tickerPath}.mark_price`:null,
    markPriceTimestamp:markPrice!==null?markClock.timestamp:null,
    markPriceTimestampSource:markPrice===null||markClock.timestamp===null?null:`${tickerPath}.${hasMarkTimestamp?'mark_timestamp':'timestamp'}`,
    markPriceTimestampUnits:markPrice!==null?markClock.units:null,markPriceAgeMs:markPrice!==null?markClock.ageMs:null,
    markPriceFresh:markPrice!==null?markClock.fresh:null,
    precisionObservations:{priceTick:tick===null?null:{field:'tick_size',value:tick,
     allObservedLevelsAligned:levels.length?levels.every(level=>alignment(Number(level[0]),tick)):null,unitsVerified:false},quantityCandidates},
    minimumOrderQuantityVerified:false,quantityIncrementVerified:false,feeUnitsVerified:false});
  }
 }
 // Reevaluate clocks at completion. A quote that was fresh before later domain
 // requests must not remain fresh just because an old boolean was recorded.
 const completed=now();
 for(const market of markets){
  if(market.book){
   const clock=observedClock(market.book.timestamp,completed);
   market.book.ageMs=clock.ageMs;market.book.fresh=clock.fresh;
   if(clock.fresh!==true){const request=requests.find(item=>item.kind==='book'&&item.instrumentName===market.instrumentName);
    if(request?.status==='OBSERVED'){request.status='FAILED';request.category='FRESHNESS'}}
  }
  const markClock=observedClock(market.markPriceTimestamp,completed);
  market.markPriceAgeMs=market.markPrice===null?null:markClock.ageMs;market.markPriceFresh=market.markPrice===null?null:markClock.fresh;
  if(market.markPrice!==null&&markClock.fresh!==true){const request=requests.find(item=>item.kind==='tickers'&&item.instrumentName===market.instrumentName);
   if(request?.status==='OBSERVED'){request.status='FAILED';request.category='FRESHNESS'}}
 }
 const marketReadiness=orangeXMarketReadiness(markets.map(market=>{
  const price=market.precisionObservations.priceTick,quantities=market.precisionObservations.quantityCandidates,
   distinctSteps=new Set(quantities.map(candidate=>candidate.value));
  return {...market,bookIntegrity:market.book?.bookIntegrity,bookObserved:market.book!==null,bid:market.book?.bid??null,ask:market.book?.ask??null,
   priceAt:market.book?.timestamp??null,fresh:market.book?.fresh===true,markPriceAt:market.markPriceTimestamp,
   precision:{priceGrid:price?.allObservedLevelsAligned===false?'MISMATCH':price?.allObservedLevelsAligned===true?'MATCH':'UNVERIFIED',
    quantityGrid:distinctSteps.size===1?(quantities[0].allObservedLevelsAligned===false?'MISMATCH':
     quantities[0].allObservedLevelsAligned===true?'MATCH':'UNVERIFIED'):'UNVERIFIED'}};
 }),{now:completed,expectedInstruments:markets.map(market=>market.instrumentName),publicDetailsEnabled:true});
 for(const market of markets)market.validation=marketReadiness.markets.find(row=>row.instrumentName===market.instrumentName)??null;
 const failures=requests.filter(item=>item.status==='FAILED'),transport=failures.some(item=>
  ['PROXY_CONNECT_REJECTED','PROXY_DNS','DNS','TLS','TIMEOUT','NETWORK','CURL_NOT_FOUND'].includes(item.category));
 const complete=failures.length===0&&marketReadiness.publicDataReady===true;
 const listingDiscovery=discoveries.map(({items,...discovery})=>({...discovery,candidate:listingDomainInfo(discovery.currency),
  outcome:discovery.status==='FAILED'?'REQUEST_FAILED':discovery.instrumentCount===0?'EMPTY_RESPONSE':items.length?'TARGET_MATCHES':'NO_TARGET_MATCHES',
  targetMatchCount:new Set(items.map(item=>item.instrument_name)).size,targetObservationCount:items.length+discovery.duplicateRowsOmitted,
  targetMatches:items.slice(0,30).map(item=>({instrumentName:item.instrument_name,
   active:typeof item.is_active==='boolean'?item.is_active:null,contractFields:item.fields,contractNameSource:item.nameSource})),
  targetMatchesOmitted:Math.max(0,items.length-30)}));
 return {kind:'ORANGEX_PUBLIC_DIAGNOSTIC',mode:'READ_ONLY',checkedAt,completedAt:new Date(completed).toISOString(),
  currencies:requestedCurrencies,currency:requestedCurrencies.length===1?requestedCurrencies[0]:null,currencyMeaning:'TRADING_DOMAIN',
  documentationSource:'USER_PROVIDED_OFFICIAL_ENUM_EXAMPLES',comparisonMode,
  status:complete?'PUBLIC_RESPONSES_OBSERVED':'INCOMPLETE',exitCode:complete?0:transport?2:1,
  httpResponsesObserved:requests.filter(item=>item.httpStatus!==null).length,
  http200Count:requests.filter(item=>item.httpStatus===200).length,listingDiscovery,marketReadiness,
  publicDataReady:marketReadiness.publicDataReady,ready:false,tradingReady:false,paperReady:false,paperEnabled:false,
  officialSpecificationVerified:false,accountChecked:false,ordersSubmitted:false,requests,markets,
  note:'currency는 거래 영역입니다. 기본 조회는 사용자 제공 문서 예시 BTC·ETH·SPOT이며 PERPETUAL은 별도 미검증 후보, USDT는 과거 잘못된 기본값 비교용입니다. HTTP 200·시세 수신만으로 상장·거래 준비를 승인하지 않습니다. Mark와 호가의 원 시각을 완료 시점에 각각 확인하며 단위·수수료는 미검증이고 PAPER는 OFF입니다.'};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 if(process.argv.length!==2){console.error('사용법: node scripts/diagnose-orangex-public.mjs');process.exitCode=1}
 else{const report=await diagnoseOrangeXPublic();console.log(JSON.stringify(report,null,2));process.exitCode=report.exitCode}
}
