// Public observations only. No account API, credentials, stores or mode changes.
import {performance} from 'node:perf_hooks';
import {spawn} from 'node:child_process';
import {curlPublicProbe} from './scripts/diagnose-orangex-public.mjs';
import {orangeXBookIntegrity} from './orangex_listing_domains.mjs';
import {orangeXFundingProbe,normalizeOrangeXFundingObservation} from './orangex_funding_observation.mjs';

const ASSETS=Object.freeze(['BTC','ETH','SOL']);
const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const numeric=value=>typeof value==='number'&&Number.isFinite(value)?value:typeof value==='string'&&value.trim()&&/^[-+]?\d+(?:\.\d+)?$/.test(value)?Number(value):null;
const positive=value=>{const n=numeric(value);return n!==null&&Number.isFinite(n)&&n>0?n:null};
const stamp=value=>{const n=numeric(value);return Number.isSafeInteger(n)&&n>=1e12&&n<8640000000000000?n:null};
const integer=(value,min,max)=>Number.isSafeInteger(value)&&value>=min&&value<=max;
const fail=code=>Object.assign(Error(code),{code});
const STATES=new Set(['OK','PROXY_CONNECT_REJECTED','PROXY_DNS','DNS','TLS','TIMEOUT','NETWORK','HTTP','SCHEMA','API','CURL_NOT_FOUND','RESPONSE_TOO_LARGE','REDIRECT_NOT_FOLLOWED','PROCESS_CLEANUP_UNCONFIRMED']);
const HALT=new Set(['PROXY_CONNECT_REJECTED','PROXY_DNS','DNS','TLS','TIMEOUT','NETWORK','CURL_NOT_FOUND','PROCESS_CLEANUP_UNCONFIRMED']);
const safeCategory=value=>STATES.has(value)?value:'NETWORK';
const copy=value=>structuredClone(value);
const sourceTag=value=>value==='SYNTHETIC_TEST'?'SYNTHETIC_TEST':'USER_REPORTED_PUBLIC_API_OBSERVATIONS';
const context={mode:'READ_ONLY',activationAllowed:false,realDataAutoEntryEnabled:false,paperAutoEntryEnabled:false,liveOrdersEnabled:false,ordersSubmitted:false,accountChecked:false};
const TIMING='\n__SIGNALLAB_MONITOR_TIMING__';
/** Fixed OrangeX public transport with allowlisted response-header/timing
 * observations. Full headers can contain private proxy information and are
 * discarded; Date is never treated as an authenticated exchange time. */
async function monitorCurlProbe(kind,instrumentName,{spawnProcess=spawn,platform=process.platform,targetURL}={}){
 const wrapped=(command,args,options)=>{
  const next=[...args],index=next.indexOf('--write-out');
  if(index<0)throw fail('MONITOR_TIMING_UNAVAILABLE');
  next[index+1]=TIMING+'%{time_total},%{time_starttransfer}'+next[index+1];
  next.unshift('--dump-header','-');
  // curl --disable must remain first to prevent a curlrc from adding options.
  next.splice(next.indexOf('--disable'),1);next.unshift('--disable');
  if(targetURL!==undefined)next[next.indexOf('--url')+1]=targetURL;
  return spawnProcess(command,next,options);
 };
 const raw=await curlPublicProbe(kind,instrumentName,{spawnProcess:wrapped,platform});
 let body=raw.body,lastHeaders=null,headerBlocks=0;
 while(/^HTTP\/\d(?:\.\d)?\s+\d{3}[^\r\n]*\r?\n/.test(body)){
  const end=/\r?\n\r?\n/.exec(body);if(!end)break;
  const block=body.slice(0,end.index).split(/\r?\n/);body=body.slice(end.index+end[0].length);headerBlocks++;
  const status=Number(/^HTTP\/\d(?:\.\d)?\s+(\d{3})/.exec(block[0])?.[1]);
  lastHeaders={status,date:null,age:null,cacheControl:null};
  for(const line of block.slice(1)){
   const split=line.indexOf(':');if(split<0)continue;const key=line.slice(0,split).trim().toLowerCase(),value=line.slice(split+1).trim();
   if(key==='date'){const parsed=Date.parse(value);lastHeaders.date=stamp(parsed)}
   if(key==='age'&&/^\d{1,10}$/.test(value))lastHeaders.age=Number(value);
   if(key==='cache-control'){
    const flag=name=>new RegExp('(?:^|,)\\s*'+name+'\\s*(?:,|$)','i').test(value),age=name=>{const m=new RegExp('(?:^|,)\\s*'+name+'=(\\d{1,10})\\s*(?:,|$)','i').exec(value);return m?Number(m[1]):null};
    lastHeaders.cacheControl={noCache:flag('no-cache'),noStore:flag('no-store'),public:flag('public'),private:flag('private'),
     maxAgeSeconds:age('max-age'),sharedMaxAgeSeconds:age('s-maxage')};
   }
  }
 }
 const timingIndex=body.lastIndexOf(TIMING);let curlDurationMs=null,curlTimeToFirstByteMs=null;
 if(timingIndex>=0){const timing=/^(\d+(?:\.\d+)?),(\d+(?:\.\d+)?)$/.exec(body.slice(timingIndex+TIMING.length).trim());
  if(timing){curlDurationMs=Number(timing[1])*1000;curlTimeToFirstByteMs=Number(timing[2])*1000;body=body.slice(0,timingIndex)}}
 const permitted=raw.category==='OK'&&lastHeaders?.status===raw.httpStatus;
 return {...raw,...(targetURL?{url:targetURL}:{}),body,httpDateMs:permitted?lastHeaders.date:null,httpAgeSeconds:permitted?lastHeaders.age:null,
  cacheObservation:permitted?lastHeaders.cacheControl:null,httpHeaderObservation:permitted?'UNCONFIRMED_EDGE_OR_ORIGIN':'UNAVAILABLE',
  responseHeaderBlocksObserved:headerBlocks,curlDurationMs,curlTimeToFirstByteMs};
}
export function orangeXMonitorProbe(kind,instrumentName,{spawnProcess=spawn,platform=process.platform}={}){return monitorCurlProbe(kind,instrumentName,{spawnProcess,platform})}
function envelope(probe){
 if(probe?.category!=='OK')return {status:'UNVERIFIED',reason:safeCategory(probe?.category),result:null};
 if(!Number.isInteger(probe.httpStatus)||probe.httpStatus<200||probe.httpStatus>=300)return {status:probe.httpStatus===null?'UNVERIFIED':'FAIL',reason:'HTTP_STATUS_NOT_SUCCESSFUL',result:null};
 let value;try{value=JSON.parse(probe.body)}catch{return {status:'FAIL',reason:'SCHEMA',result:null}}
 if(!plain(value)||value.error||value.result===undefined||value.result===null)return {status:'FAIL',reason:value?.error?'API':'SCHEMA',result:null};
 return {status:'PASS',reason:'OBSERVED',result:value.result};
}
export function normalizeOrangeXMonitorBook(probe,instrumentName){
 const decoded=envelope(probe);if(decoded.status!=='PASS')return {...decoded,book:null};
 const raw=decoded.result;
 if(!plain(raw)||raw.instrument_name!==instrumentName||!Array.isArray(raw.bids)||!Array.isArray(raw.asks)||raw.bids.length>1000||raw.asks.length>1000)
  return {status:'FAIL',reason:'BOOK_SCHEMA_OR_INSTRUMENT_MISMATCH',book:null};
 const convert=levels=>levels.map(row=>Array.isArray(row)&&row.length===2?[positive(row[0]),positive(row[1])]:null);
 const bids=convert(raw.bids),asks=convert(raw.asks),integrity=orangeXBookIntegrity({bids,asks});
 const crossed=positive(bids[0]?.[0])!==null&&positive(asks[0]?.[0])!==null&&bids[0][0]>=asks[0][0];
 return {status:integrity.valid&&!crossed?'PASS':'FAIL',reason:crossed?'BOOK_CROSSED':integrity.valid?'OBSERVED_DEPTH_VALID':'BOOK_INTEGRITY_FAILED',
  book:{instrumentName,bids,asks,timestamp:stamp(raw.timestamp),timestampSource:'result.timestamp',timestampUnits:'UNVERIFIED',timestampMeaningVerified:false,
   rawTimestamp:typeof raw.timestamp==='string'&&/^\d{10,17}$/.test(raw.timestamp)?raw.timestamp:numberOrNull(raw.timestamp),integrity,crossed}};
}
const numberOrNull=value=>typeof value==='number'&&Number.isFinite(value)?value:null;
export function normalizeOrangeXMonitorMark(probe,instrumentName){
 const decoded=envelope(probe);if(decoded.status!=='PASS')return {...decoded,mark:null};
 const result=decoded.result,rows=Array.isArray(result)?result:Array.isArray(result?.tickers)?result.tickers:plain(result)?[result]:[],
  matches=rows.filter(row=>plain(row)&&row.instrument_name===instrumentName);
 if(matches.length!==1||positive(matches[0].mark_price)===null)return {status:'FAIL',reason:'MARK_SCHEMA_OR_INSTRUMENT_MISMATCH',mark:null};
 const row=matches[0],field=Object.hasOwn(row,'mark_timestamp')?'mark_timestamp':'timestamp';
 return {status:'PASS',reason:'OBSERVED_MARK',mark:{instrumentName,price:positive(row.mark_price),timestamp:stamp(row[field]),timestampSource:'result.'+field,
  timestampUnits:'UNVERIFIED',timestampMeaningVerified:false,explicitMarkTimestampField:field==='mark_timestamp',timestampFieldPresent:Object.hasOwn(row,field),
  timestampInterpretation:field==='mark_timestamp'?'FIELD_NAMED_MARK_TIMESTAMP_NOT_OFFICIALLY_VERIFIED':'GENERIC_OR_LAST_TRADE_TIMESTAMP_POSSIBLE',
  rawTimestamp:typeof row[field]==='string'&&/^\d{10,17}$/.test(row[field])?row[field]:numberOrNull(row[field])}};
}
function clockStatus(at,now,maxAgeMs){
 if(at===null||at===undefined)return {status:'UNVERIFIED',reason:'SOURCE_CLOCK_UNOBSERVED',timestamp:null,localAgeMs:null};
 if(stamp(at)===null)return {status:'FAIL',reason:'SOURCE_CLOCK_INVALID',timestamp:null,localAgeMs:null};
 const age=now-at;
 return {status:age<0||age>maxAgeMs?'FAIL':'PASS',reason:age<0?'SOURCE_CLOCK_IN_FUTURE':age>maxAgeMs?'SOURCE_CLOCK_STALE':'SOURCE_CLOCK_WITHIN_LOCAL_AGE_LIMIT',timestamp:at,localAgeMs:age};
}

/** Stores bounded observations separately from the latest eligibility view.
 * Timestamp repetition is evidence of no source-clock progress, not evidence
 * that low volume, cache, server fault or PC offset caused it. */
export class OrangeXMarketMonitor{
 #latest=new Map();#history=[];#progress=new Map();
 constructor({maxQuoteAgeMs=90000,stallAfterMs=30000,dataSource='USER_REPORTED_PUBLIC_API_OBSERVATIONS',maxSamples=36}={}){
  if(!integer(maxQuoteAgeMs,1,90000)||!integer(stallAfterMs,1,90000)||!integer(maxSamples,3,144))throw fail('INVALID_MONITOR_OPTIONS');
  if(!['USER_REPORTED_PUBLIC_API_OBSERVATIONS','SYNTHETIC_TEST'].includes(dataSource))throw fail('INVALID_MONITOR_SOURCE');
  this.maxQuoteAgeMs=maxQuoteAgeMs;this.stallAfterMs=stallAfterMs;this.maxSamples=maxSamples;this.dataSource=sourceTag(dataSource);
 }
 #stream(asset,kind,at,capturedAt){
  const key=asset+':'+kind,prior=this.#progress.get(key);
  if(stamp(at)===null)return {status:'UNVERIFIED',reason:'SOURCE_CLOCK_UNOBSERVED',repeatedObservations:0,lastProgressAt:null};
  if(prior&&at<prior.timestamp)return {status:'FAIL',reason:'SOURCE_TIMESTAMP_REGRESSION',repeatedObservations:prior.repeated,lastProgressAt:prior.progressAt};
  const next=!prior||at>prior.timestamp?{timestamp:at,progressAt:capturedAt,repeated:0}:{...prior,repeated:prior.repeated+1};
  this.#progress.set(key,next);
  return {status:capturedAt-next.progressAt>=this.stallAfterMs?'FAIL':'PASS',
   reason:capturedAt-next.progressAt>=this.stallAfterMs?'SOURCE_TIMESTAMP_NOT_PROGRESSING':next.repeated?'REPEATED_SOURCE_TIMESTAMP_OBSERVED':'SOURCE_TIMESTAMP_ADVANCED',
   repeatedObservations:next.repeated,lastProgressAt:next.progressAt};
 }
 record({asset,capturedAt,book,mark,binance=null,requests=[]}={}){
  if(!ASSETS.includes(asset)||stamp(capturedAt)===null)throw fail('INVALID_MONITOR_SAMPLE');
  const name=asset+'-USDT-PERPETUAL',bookInput=book??{status:'UNVERIFIED',reason:'BOOK_UNOBSERVED',book:null},
   markInput=mark??{status:'UNVERIFIED',reason:'MARK_UNOBSERVED',mark:null},
   b=bookInput.book&&bookInput.book.instrumentName!==name?{...bookInput,status:'FAIL',reason:'BOOK_INSTRUMENT_MISMATCH'}:bookInput,
   m=markInput.mark&&markInput.mark.instrumentName!==name?{...markInput,status:'FAIL',reason:'MARK_INSTRUMENT_MISMATCH'}:markInput;
  const prior=this.#latest.get(asset),sample={asset,instrumentName:asset+'-USDT-PERPETUAL',capturedAt,dataSource:this.dataSource,book:copy(b),mark:copy(m),binance:copy(binance),requests:copy(requests),
   localClockRegression:prior!==undefined&&capturedAt<prior.capturedAt,
   progress:{book:this.#stream(asset,'book',b.status==='PASS'?b.book?.timestamp:null,capturedAt),mark:this.#stream(asset,'mark',m.status==='PASS'?m.mark?.timestamp:null,capturedAt)}};
  sample.atCapture=this.#evaluate(sample,capturedAt);this.#latest.set(asset,sample);this.#history.push(copy(sample));
  if(this.#history.length>this.maxSamples)this.#history.splice(0,this.#history.length-this.maxSamples);return copy(sample);
 }
 #evaluate(sample,now){
  const reasons=[];const bookClock=clockStatus(sample.book.book?.timestamp,now,this.maxQuoteAgeMs),markClock=clockStatus(sample.mark.mark?.timestamp,now,this.maxQuoteAgeMs);
  let failed=[sample.book,sample.mark,bookClock,markClock].some(row=>row.status==='FAIL');
  if(now<sample.capturedAt||sample.localClockRegression||sample.requests.some(row=>row.clockStatus==='FAIL'))failed=true;
  if(sample.requests.some(row=>row.processClosed===false||typeof row.category==='string'&&row.category!=='OK'||
   Object.hasOwn(row,'httpStatus')&&(!Number.isInteger(row.httpStatus)||row.httpStatus<200||row.httpStatus>=300))){
   reasons.push('REQUEST_TRANSPORT_OR_HTTP_NOT_SUCCESSFUL');failed=true;
  }
  if(now<sample.capturedAt||sample.localClockRegression)reasons.push('LOCAL_WALL_CLOCK_REGRESSION');
  if(sample.requests.some(row=>row.clockStatus==='FAIL'))reasons.push('REQUEST_CLOCK_MEASUREMENT_INVALID');
  if(sample.book.status!=='PASS')reasons.push(sample.book.reason);if(sample.mark.status!=='PASS')reasons.push(sample.mark.reason);
  for(const [kind,clock]of [['BOOK',bookClock],['MARK',markClock]]){
   if(clock.status!=='PASS')reasons.push(kind+'_'+clock.reason);
   const progress=sample.progress[kind.toLowerCase()];if(progress.status==='FAIL'){reasons.push(kind+'_'+progress.reason);failed=true}
   else if(progress.lastProgressAt!==null&&now-progress.lastProgressAt>=this.stallAfterMs){reasons.push(kind+'_SOURCE_TIMESTAMP_NOT_PROGRESSING');failed=true}
  }
  return {status:failed?'FAIL':reasons.length?'UNVERIFIED':'PASS',marketDataEligible:reasons.length===0,reasons:[...new Set(reasons)],bookClock,markClock,
   contractUnitsVerified:false,feesVerified:false,fundingVerified:false,entryEligible:false};
 }
 snapshot({now=Date.now()}={}){
  if(stamp(now)===null)throw fail('INVALID_MONITOR_CLOCK');
  const markets=ASSETS.map(asset=>{const sample=this.#latest.get(asset);return sample?{...copy(sample),currentEligibility:this.#evaluate(sample,now),binanceComparison:compareMonitorBinance(sample,{now,maxQuoteAgeMs:this.maxQuoteAgeMs})}:
   {asset,instrumentName:asset+'-USDT-PERPETUAL',atCapture:null,currentEligibility:{status:'UNVERIFIED',marketDataEligible:false,reasons:['MARKET_UNOBSERVED'],entryEligible:false},binanceComparison:{status:'UNVERIFIED',mappingVerified:false}}});
  return {kind:'ORANGEX_MARKET_MONITOR',...context,status:'NOT_READY',dataSource:this.dataSource,checkedAt:now,maxQuoteAgeMs:this.maxQuoteAgeMs,stallAfterMs:this.stallAfterMs,
   marketDataStatus:markets.every(row=>row.currentEligibility.status==='PASS')?'PASS':markets.some(row=>row.currentEligibility.status==='FAIL')?'FAIL':'UNVERIFIED',markets,observations:copy(this.#history),
   note:'수집 당시 관측은 보존하고 현재 적격성을 별도 재평가합니다. 원 시각의 반복·역행 원인은 미검증입니다. 계약·비용 검증이나 PAPER 승인이 아닙니다.'};
 }
}

export function compareMonitorBinance(sample,{now=Date.now(),maxQuoteAgeMs=90000}={}){
 const reference=sample.binance,asset=sample.asset,book=sample.book.book;
 if(!reference?.book||!reference?.contract||!book)return {status:'UNVERIFIED',reason:'BINANCE_REFERENCE_OR_CONTRACT_UNOBSERVED',mappingVerified:false};
 if(book.instrumentName!==asset+'-USDT-PERPETUAL'||reference.book.symbol!==asset+'USDT'||sample.book.status!=='PASS')
  return {status:'UNVERIFIED',reason:'PRICE_COMPARISON_INSTRUMENT_MISMATCH',mappingVerified:false,orangeXMid:null,binanceMid:null,gapBps:null};
 const contract=reference.contract,required=contract.symbol===asset+'USDT'&&contract.baseAsset===asset&&contract.quoteAsset==='USDT'&&contract.marginAsset==='USDT'&&contract.contractType==='PERPETUAL'&&contract.status==='TRADING',
  clock=clockStatus(reference.book.timestamp,now,maxQuoteAgeMs),oxClock=clockStatus(book.timestamp,now,maxQuoteAgeMs),b=reference.book;
 const valid=reference.requestClockValid!==false&&positive(b.bid)!==null&&positive(b.ask)!==null&&b.bid<b.ask&&positive(book.bids?.[0]?.[0])!==null&&positive(book.asks?.[0]?.[0])!==null;
 const pricesAvailable=valid&&required&&clock.status==='PASS'&&oxClock.status==='PASS';
 const oxMid=valid?(book.bids[0][0]+book.asks[0][0])/2:null,binanceMid=valid?(b.bid+b.ask)/2:null;
 return {status:pricesAvailable?'OBSERVATION_ONLY':'UNVERIFIED',reason:!required?'BINANCE_CONTRACT_NOT_CONFIRMED':!pricesAvailable?'REFERENCE_CLOCK_OR_BOOK_INVALID':'FRESH_PRICE_COMPARISON_ONLY',
  referenceSymbol:asset+'USDT',binanceContractObserved:required,binanceClock:clock,orangeXClock:oxClock,referencePriceType:'BOOK_MIDPOINT',
  orangeXMid:pricesAvailable?oxMid:null,binanceMid:pricesAvailable?binanceMid:null,gapBps:pricesAvailable?(oxMid-binanceMid)/binanceMid*10000:null,
  mappingVerified:false,orangeXContractSizeAndSettlementVerified:false,orderSubmissionEnabled:false};
}

const BINANCE='https://fapi.binance.com';
export function binanceMonitorURL(kind,symbol){
 if(kind==='contracts')return BINANCE+'/fapi/v1/exchangeInfo';
 if(kind==='time')return BINANCE+'/fapi/v1/time';
 if(kind==='book'&&ASSETS.some(asset=>symbol===asset+'USDT'))return BINANCE+'/fapi/v1/ticker/bookTicker?symbol='+symbol;
 throw fail('BINANCE_PUBLIC_ENDPOINT_NOT_ALLOWED');
}
// Reuse curl's existing process cleanup, inherited proxy and CA policy. Only
// these three fixed Binance PUBLIC GET URLs can replace the internal base URL.
export function binanceMonitorProbe(kind,symbol,{spawnProcess=spawn,platform=process.platform}={}){
 return monitorCurlProbe('docs',undefined,{spawnProcess,platform,targetURL:binanceMonitorURL(kind,symbol)});
}
function binanceResult(probe){if(probe?.category!=='OK'||!Number.isInteger(probe.httpStatus)||probe.httpStatus<200||probe.httpStatus>=300)return null;try{return JSON.parse(probe.body)}catch{return null}}
function normalizeBinanceContract(probe,asset){
 const value=binanceResult(probe),rows=Array.isArray(value?.symbols)?value.symbols:[],matches=rows.filter(row=>row?.symbol===asset+'USDT');if(matches.length!==1)return null;
 const row=matches[0],safe={};for(const key of ['symbol','baseAsset','quoteAsset','marginAsset','contractType','status'])safe[key]=typeof row[key]==='string'&&/^[A-Z0-9_]{1,24}$/.test(row[key])?row[key]:null;return safe;
}
function normalizeBinanceBook(probe,asset){const row=binanceResult(probe);return plain(row)&&row.symbol===asset+'USDT'&&positive(row.bidPrice)!==null&&positive(row.askPrice)!==null?
 {symbol:row.symbol,bid:positive(row.bidPrice),ask:positive(row.askPrice),timestamp:stamp(row.time),timestampSource:'time'}:null}

export async function diagnoseOrangeXContinuous(options={}){
 const {rounds=3,intervalMs=2000,maxQuoteAgeMs=90000,stallAfterMs=30000,includeBinance=true,includeFunding=false,
 dataSource='USER_REPORTED_PUBLIC_API_OBSERVATIONS',orangexProbe,binanceProbe,fundingProbe,now=()=>Date.now(),monotonicNow=()=>performance.now(),delay=ms=>new Promise(resolve=>setTimeout(resolve,ms))}=options;
 if(!integer(rounds,2,12)||!integer(intervalMs,0,30000)||!integer(maxQuoteAgeMs,1,90000)||!integer(stallAfterMs,1,90000)||typeof includeBinance!=='boolean'||typeof includeFunding!=='boolean')throw fail('INVALID_CONTINUOUS_OPTIONS');
 if(!['USER_REPORTED_PUBLIC_API_OBSERVATIONS','SYNTHETIC_TEST'].includes(dataSource))throw fail('INVALID_MONITOR_SOURCE');
 if(dataSource!=='SYNTHETIC_TEST'&&['orangexProbe','binanceProbe','fundingProbe','now','monotonicNow','delay'].some(key=>Object.hasOwn(options,key)))throw fail('MOCK_INJECTION_REQUIRES_SYNTHETIC_TEST');
 if(dataSource==='SYNTHETIC_TEST'&&(typeof orangexProbe!=='function'||includeBinance&&typeof binanceProbe!=='function'||includeFunding&&typeof fundingProbe!=='function'))throw fail('SYNTHETIC_PROBES_REQUIRED');
 const oxProbe=orangexProbe??orangeXMonitorProbe,bnProbe=binanceProbe??binanceMonitorProbe,fpProbe=fundingProbe??orangeXFundingProbe,monitor=new OrangeXMarketMonitor({maxQuoteAgeMs,stallAfterMs,dataSource,maxSamples:rounds*3}),
  startedAt=now(),startedMono=monotonicNow(),requests=[],roundReports=[];let halted=null,contractProbe=null;
 const request=async(exchange,kind,instrumentName)=>{
  if(halted)return null;
  if(monotonicNow()-startedMono>=180000){halted={reason:'RUN_TIME_LIMIT',httpStatus:null,afterRequest:requests.length};return null}
  const at=now(),mono=monotonicNow();let raw;
  try{raw=await(exchange==='ORANGEX'?(kind==='funding'?fpProbe():oxProbe(kind,instrumentName)):bnProbe(kind,instrumentName))}catch{raw={category:'NETWORK',httpStatus:null,body:''}}
  const ended=now(),duration=monotonicNow()-mono,category=safeCategory(raw?.category);
  const row={exchange,kind,instrumentName:instrumentName??null,startedAt:at,endedAt:ended,durationMs:Number.isFinite(duration)&&duration>=0?duration:null,
   clockStatus:stamp(at)!==null&&stamp(ended)!==null&&ended>=at&&Number.isFinite(duration)&&duration>=0?'PASS':'FAIL',
   httpStatus:Number.isInteger(raw?.httpStatus)?raw.httpStatus:null,category,processClosed:typeof raw?.processClosed==='boolean'?raw.processClosed:null,
   httpDateMs:stamp(raw?.httpDateMs),httpAgeSeconds:integer(raw?.httpAgeSeconds,0,9999999999)?raw.httpAgeSeconds:null,
   cacheObservation:plain(raw?.cacheObservation)?{noCache:raw.cacheObservation.noCache===true,noStore:raw.cacheObservation.noStore===true,
    public:raw.cacheObservation.public===true,private:raw.cacheObservation.private===true,maxAgeSeconds:integer(raw.cacheObservation.maxAgeSeconds,0,9999999999)?raw.cacheObservation.maxAgeSeconds:null,
    sharedMaxAgeSeconds:integer(raw.cacheObservation.sharedMaxAgeSeconds,0,9999999999)?raw.cacheObservation.sharedMaxAgeSeconds:null}:null,
   curlDurationMs:typeof raw?.curlDurationMs==='number'&&Number.isFinite(raw.curlDurationMs)&&raw.curlDurationMs>=0?raw.curlDurationMs:null,
   curlTimeToFirstByteMs:typeof raw?.curlTimeToFirstByteMs==='number'&&Number.isFinite(raw.curlTimeToFirstByteMs)&&raw.curlTimeToFirstByteMs>=0?raw.curlTimeToFirstByteMs:null,
   sourceResponseAuthentication:'UNVERIFIED'};
  row.serverDateClockObservation=row.httpDateMs===null?null:{status:row.clockStatus==='PASS'?'OBSERVATION_ONLY':'FAIL',
   reason:row.clockStatus==='PASS'?'UNCERTAIN_EDGE_OR_CACHED_DATE':'LOCAL_REQUEST_CLOCK_INVALID',
   serverMinusLocalMidpointMs:row.clockStatus==='PASS'?row.httpDateMs+500-(at+ended)/2:null,
   uncertaintyMs:(row.durationMs??Math.max(0,ended-at))/2+1000,authority:'UNVERIFIED_EDGE_OR_CACHED_RESPONSE',
   positiveAgeHeaderObserved:row.httpAgeSeconds!==null&&row.httpAgeSeconds>0,usedToCorrectSourceEligibility:false};
  requests.push(row);
  if(HALT.has(category)||raw?.processClosed===false||[401,403,429,451].includes(row.httpStatus))halted={reason:raw?.processClosed===false?'PROCESS_CLEANUP_UNCONFIRMED':category,httpStatus:row.httpStatus,afterRequest:requests.length};
  return {raw,row};
 };
 for(let round=0;round<rounds&&!halted;round++){
  const roundStarted=now(),samples=[];let clockProbe=null,fundingObservation=null;
  // Exchange/proxy policy failures stop before any further asset or Binance
  // expansion. A blocked first OrangeX GET is never retried automatically.
  for(const asset of ASSETS){
   if(halted)break;const name=asset+'-USDT-PERPETUAL',ticker=await request('ORANGEX','tickers',name);if(halted)break;
   const book=await request('ORANGEX','book',name);if(halted)break;
   const normalizedBook=normalizeOrangeXMonitorBook(book.raw,name),normalizedMark=normalizeOrangeXMonitorMark(ticker.raw,name);
   samples.push({asset,book:normalizedBook,mark:normalizedMark,requests:[ticker.row,book.row]});
  }
  if(!halted&&includeFunding){
   const funding=await request('ORANGEX','funding');
   if(funding)fundingObservation=normalizeOrangeXFundingObservation(funding.raw,{receivedAt:funding.row.endedAt,dataSource});
  }
  if(!halted&&includeBinance){
   if(!contractProbe)contractProbe=await request('BINANCE','contracts');
   if(!halted)clockProbe=await request('BINANCE','time');
   for(const sample of samples){if(halted)break;const reference=await request('BINANCE','book',sample.asset+'USDT');if(!reference)break;
    sample.binance={contract:normalizeBinanceContract(contractProbe?.raw,sample.asset),book:normalizeBinanceBook(reference.raw,sample.asset),requestClockValid:reference.row.clockStatus==='PASS'};
   }
  }
  const completed=now();
  for(const sample of samples)monitor.record({...sample,capturedAt:completed});
  const time=binanceResult(clockProbe?.raw),serverTime=stamp(time?.serverTime),clockValid=clockProbe?.row.clockStatus==='PASS',clockObservation=serverTime!==null&&clockProbe?{
   status:clockValid?'OBSERVATION_ONLY':'FAIL',exchange:'BINANCE',serverTime,localMidpointMs:clockValid?(clockProbe.row.startedAt+clockProbe.row.endedAt)/2:null,
   serverMinusLocalMidpointMs:clockValid?serverTime-(clockProbe.row.startedAt+clockProbe.row.endedAt)/2:null,
   requestDurationMs:clockProbe.row.durationMs,networkAsymmetryAndServerProcessingUnverified:true,
   appliesToOrangeXClock:false}:null;
  roundReports.push({round:round+1,startedAt:roundStarted,completedAt:completed,samplesRecorded:samples.length,scheduleCompleted:!halted&&samples.length===3,binanceClockObservation:clockObservation,fundingObservation});
  if(!halted&&round+1<rounds)await delay(Math.max(0,Math.min(intervalMs,180000-(monotonicNow()-startedMono))));
 }
 const completedAt=now(),monotonicDuration=monotonicNow()-startedMono,snapshot=monitor.snapshot({now:completedAt}),issued=requests.length,success=requests.filter(row=>row.httpStatus!==null&&row.httpStatus>=200&&row.httpStatus<300).length,
  byEndpoint=[];
 for(const key of [...new Set(requests.map(row=>row.exchange+':'+row.kind))]){const rows=requests.filter(row=>row.exchange+':'+row.kind===key),durations=rows.map(row=>row.durationMs).filter(value=>value!==null);byEndpoint.push({endpoint:key,issued:rows.length,http2xx:rows.filter(row=>row.httpStatus>=200&&row.httpStatus<300).length,
  durationMs:durations.length?{min:Math.min(...durations),max:Math.max(...durations),mean:durations.reduce((a,b)=>a+b,0)/durations.length}:null})}
 const allRequestsSuccessful=requests.every(row=>row.category==='OK'&&row.httpStatus>=200&&row.httpStatus<300&&row.processClosed===true&&row.clockStatus==='PASS'),
  allCaptureSamplesQualified=snapshot.observations.length===rounds*3&&snapshot.observations.every(sample=>sample.atCapture.status==='PASS'),
  fundingObservationsCompleted=!includeFunding||roundReports.length===rounds&&roundReports.every(round=>round.fundingObservation?.observationStatus==='PASS'),
  binanceObservationsCompleted=!includeBinance||roundReports.length===rounds&&roundReports.every(round=>round.binanceClockObservation?.status==='OBSERVATION_ONLY')&&snapshot.observations.length===rounds*3&&snapshot.observations.every(sample=>
   compareMonitorBinance(sample,{now:sample.capturedAt,maxQuoteAgeMs}).status==='OBSERVATION_ONLY'),
  complete=!halted&&roundReports.length===rounds&&snapshot.marketDataStatus==='PASS'&&allRequestsSuccessful&&allCaptureSamplesQualified&&fundingObservationsCompleted&&binanceObservationsCompleted;
 return {kind:'ORANGEX_CONTINUOUS_PUBLIC_DIAGNOSTIC',...context,dataSource:sourceTag(dataSource),syntheticTest:dataSource==='SYNTHETIC_TEST',
  actualRequestsRun:dataSource!=='SYNTHETIC_TEST'&&issued>0,rawHttpBodiesIncluded:false,evidenceForm:'ALLOWLISTED_TIMED_PUBLIC_OBSERVATIONS_NOT_RAW_HTTP',
  checkedAt:new Date(startedAt).toISOString(),completedAt:new Date(completedAt).toISOString(),status:complete?'READ_ONLY_OBSERVATIONS_COMPLETED':'INCOMPLETE',
  exitCode:halted?2:complete?0:1,operationalReadiness:'NOT_READY',requestedRounds:rounds,attemptedRounds:roundReports.length,completedRounds:roundReports.filter(row=>row.scheduleCompleted).length,intervalMs,
  observationDurationMs:Number.isFinite(monotonicDuration)&&monotonicDuration>=0?monotonicDuration:null,wallClockElapsedMs:completedAt-startedAt,
  localClockStatus:completedAt>=startedAt?'PASS':'FAIL',sufficientDurationForStallPolicy:monotonicDuration>=stallAfterMs,
  success:{issued,http2xx:success,httpSuccessRate:issued?success/issued:null,allScheduledRequestsCompleted:!halted&&roundReports.length===rounds,
   allRequestsSuccessful,allCaptureSamplesQualified,fundingObservationsCompleted,binanceObservationsCompleted,
   marketSamples:snapshot.observations.length,captureQualifiedSamples:snapshot.observations.filter(row=>row.atCapture.status==='PASS').length,
   captureQualifiedRate:snapshot.observations.length?snapshot.observations.filter(row=>row.atCapture.status==='PASS').length/snapshot.observations.length:null},
  requestWindowLimitMs:180000,requestWindowLimitSemantics:'LATEST_NEW_REQUEST_START_TIME_NOT_TOTAL_PROCESS_DEADLINE',
  maximumPlannedRequests:rounds*(6+(includeBinance?4:0)+(includeFunding?1:0))+(includeBinance?1:0),
  halted,requests,byEndpoint,rounds:roundReports,monitor:snapshot,
  causeAssessment:{requestDuration:'MEASURED_LOCAL_MONOTONIC_DURATION',orangeXServerClockOffset:'UNVERIFIED_DATE_HEADER_IS_ONLY_EDGE_OR_CACHE_OBSERVATION',
   positiveHttpAgeObserved:requests.some(row=>row.exchange==='ORANGEX'&&row.httpAgeSeconds!==null&&row.httpAgeSeconds>0),
   cacheAbsenceVerified:false,httpDateNeverAppliedToSourceEligibility:true,
   orangeXTimestampMeaning:'UNVERIFIED',lowVolumeOrCacheCause:'UNVERIFIED',frozenSourceClock:'OBSERVED_PROGRESS_ONLY_NOT_CAUSAL_DIAGNOSIS',
   binanceClockEstimate:'SEPARATE_OBSERVATION_NEVER_APPLIED_TO_ORANGEX'},
  limitations:['FINITE_PUBLIC_OBSERVATION_WINDOW_NOT_LONG_TERM_OPERATION','CONTRACT_UNITS_FEES_FUNDING_AND_ORANGEX_SETTLEMENT_UNVERIFIED',
   'HTTP_SUCCESS_IS_SEPARATE_FROM_VALID_FRESH_MARKET_DATA','LOCAL_AGE_REQUIRES_CLOCK_AND_TIMESTAMP_MEANING_REVIEW','NO_LIVE_OR_PAPER_ENTRY_PERMISSION']};
}
