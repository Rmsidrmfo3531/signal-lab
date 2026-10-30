// Offline public-observation review only. No transport, credentials or stores.
import {evaluateOrangeXReadiness} from './orangex_readiness.mjs';

const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const array=value=>Array.isArray(value)?value:[];
const number=value=>typeof value==='number'&&Number.isFinite(value)?value:null;
const stamp=value=>{const n=typeof value==='string'?Date.parse(value):value;return Number.isSafeInteger(n)&&n>=1e12&&n<8640000000000000?n:null};
const ASSETS=['BTC','ETH','SOL'],CURRENCIES=['BTC','ETH','SPOT','PERPETUAL','USDT'];
const ACTIVE_FLAGS=['orderSubmissionEnabled','ordersSubmitted','liveOrdersEnabled','realDataAutoEntryEnabled','paperAutoEntryEnabled','paperEnabled'];
const synthetic=value=>plain(value)&&(value.syntheticTest===true||value.executionMode==='SYNTHETIC_TEST'||
 ['SYNTHETIC_TEST','SYNTHETIC_FIXTURE','MOCK','MOCK_RESPONSE','SYNTHETIC'].includes(value.dataSource));
const historical=value=>plain(value)&&(value.executionMode==='HISTORICAL_REPLAY'||value.runKind==='BACKTEST'||
 ['HISTORICAL_REPLAY','HISTORICAL_SNAPSHOT','HISTORICAL_PUBLIC_OBSERVATION','BACKTEST'].includes(value.dataSource));
const NUMERIC_FIELDS=['contract_size','min_trade_amount','min_qty','min_order_amount','min_order_size','min_notional',
 'lot_size','qty_step','quantity_step','quantity_increment','tick_size','maker_commission','taker_commission','maker_fee','taker_fee',
 'maker_fee_rate','taker_fee_rate','maker','taker'];
const TEXT_FIELDS=['base_currency','quote_currency','settlement_currency','kind','settlement_period'];
const safePath=(value,key)=>typeof value==='string'&&value.length<256&&
 new RegExp('^(?:currency=(?:BTC|ETH|SPOT|PERPETUAL|USDT):)?result(?:\\[[0-9]+\\]|\\.(?:instruments|tickers|data))*\\.'+key+'$').test(value)?value:null;

/** Preserve restrictive inner AND outer tags. A wrapper cannot relabel a replay
 * as a current public observation. Neither this nor a digest authenticates origin. */
export function normalizeOrangeXEvidence(input){
 if(!plain(input)||!['ORANGEX_PUBLIC_DIAGNOSTIC','ORANGEX_WINDOWS_ONECLICK'].includes(input.kind))throw Error('INVALID_PUBLIC_DIAGNOSTIC');
 const nested=input.kind==='ORANGEX_WINDOWS_ONECLICK'?input.diagnostic:input;
 if(!plain(nested)||nested.kind!=='ORANGEX_PUBLIC_DIAGNOSTIC')throw Error('INVALID_PUBLIC_DIAGNOSTIC');
 const samples=[input,nested,...array(nested.markets).flatMap(row=>[row,row?.book,row?.fundingObservation,row?.binanceObservation,row?.binanceComparison])],
  isSynthetic=samples.some(synthetic),isHistorical=samples.some(historical),
  unsafeMode=[input,nested].some(value=>Object.hasOwn(value,'mode')&&value.mode!=='READ_ONLY'),
  flags=Object.fromEntries(ACTIVE_FLAGS.map(key=>[key,input[key]===true||nested[key]===true?true:nested[key]]));
 return {...nested,...flags,mode:unsafeMode?'UNSAFE_CONTEXT':nested.mode,dataSource:isSynthetic?'SYNTHETIC_TEST':isHistorical?'HISTORICAL_REPLAY':input.dataSource??nested.dataSource,
  syntheticTest:isSynthetic,...(isHistorical?{executionMode:'HISTORICAL_REPLAY'}:{})};
}

function rawFields(fields){
 const result={};if(!plain(fields))return result;
 for(const key of NUMERIC_FIELDS){const field=fields[key];if(plain(field)&&number(field.value)!==null)
  result[key]={value:field.value,source:safePath(field.source,key),interpretation:'RAW_VALUE_ONLY'};}
 for(const key of TEXT_FIELDS){const field=fields[key];if(plain(field)&&typeof field.value==='string'&&/^[A-Za-z0-9_-]{1,32}$/.test(field.value))
  result[key]={value:field.value,source:safePath(field.source,key),interpretation:'EXCHANGE_MEANING_UNVERIFIED'};}
 return result;
}

export function reviewOrangeXEvidence(input,{now=Date.now(),sourceSHA256=null}={}){
 const normalized=normalizeOrangeXEvidence(input),current=evaluateOrangeXReadiness(normalized,{now}),completed=stamp(input.completedAt??normalized.completedAt),
  reportedStart=stamp(input.checkedAt??normalized.checkedAt),chronologyValid=completed===null||reportedStart===null||completed>=reportedStart,
  completedUsable=completed!==null&&completed<=now&&chronologyValid,
  sourceClass=synthetic(normalized)?'SYNTHETIC_TEST':historical(normalized)?'HISTORICAL_REPLAY':
   completedUsable&&now-completed<=90000?'RECENT_USER_REPORTED_PUBLIC_OBSERVATION':'HISTORICAL_OR_UNDATED_USER_REPORTED_PUBLIC_OBSERVATION';
 const requests=array(normalized.requests).slice(0,100).map(row=>({
  kind:['docs','instruments','tickers','book'].includes(row?.kind)?row.kind:'UNRECOGNIZED',
  instrumentName:ASSETS.some(asset=>row?.instrumentName===asset+'-USDT-PERPETUAL')?row.instrumentName:null,
  currency:CURRENCIES.includes(row?.currency)?row.currency:null,
  httpStatus:Number.isInteger(row?.httpStatus)&&row.httpStatus>=100&&row.httpStatus<=599?row.httpStatus:null,
  category:['OK','PROXY_CONNECT_REJECTED','PROXY_DNS','DNS','TLS','TIMEOUT','NETWORK','HTTP','SCHEMA','API','CURL_NOT_FOUND',
   'RESPONSE_TOO_LARGE','REDIRECT_NOT_FOLLOWED','FRESHNESS','PROCESS_CLEANUP_UNCONFIRMED'].includes(row?.category)?row.category:'UNVERIFIED',
  requestIssued:typeof row?.requestIssued==='boolean'?row.requestIssued:null,
  processClosed:typeof row?.processClosed==='boolean'?row.processClosed:null,
  proxyConnectStatus:Number.isInteger(row?.proxyConnectStatus)&&row.proxyConnectStatus>=100&&row.proxyConnectStatus<=599?row.proxyConnectStatus:null
 }));
 const markets=ASSETS.map(asset=>{
  const instrumentName=asset+'-USDT-PERPETUAL',matches=array(normalized.markets).filter(row=>row?.instrumentName===instrumentName),row=matches.length===1?matches[0]:{},book=plain(row.book)?row.book:row;
  const first=value=>Array.isArray(value?.[0])&&value[0].length===2?value[0].map(number):null;
  return {asset,instrumentName,matchingObservations:matches.length,listingObserved:row.listingObserved===true,
   active:typeof row.active==='boolean'?row.active:null,listingSourceCurrency:CURRENCIES.includes(row.listingSourceCurrency)?row.listingSourceCurrency:null,
   contractNameEvidence:row.listingObserved===true?'OBSERVED_LISTING_CLAIM_REQUIRES_REVIEW':'REQUEST_CANDIDATE_ONLY',
   contractFields:rawFields(row.contractFields),book:{bid:number(book.bid??row.bid),ask:number(book.ask??row.ask),
    firstBid:first(book.bids),firstAsk:first(book.asks),bidLevels:Array.isArray(book.bids)?book.bids.length:null,
    askLevels:Array.isArray(book.asks)?book.asks.length:null,timestamp:stamp(book.timestamp??row.priceAt)},
   markPrice:number(row.markPrice),markTimestamp:stamp(row.markPriceTimestamp??row.markPriceAt),
   checks:current.markets.find(market=>market.asset===asset).checks};
 });
 return {kind:'ORANGEX_PUBLIC_EVIDENCE_REVIEW',mode:'READ_ONLY',sourceClass,
  sourceSHA256:typeof sourceSHA256==='string'&&/^[a-f0-9]{64}$/.test(sourceSHA256)?sourceSHA256:null,
  sourceAuthentication:'UNVERIFIED_REPORTING_DIGEST_IS_NOT_ORIGIN_PROOF',
  evidenceForm:input.rawHttpBodiesIncluded===true?'RAW_HTTP_DECLARATION_REQUIRES_SEPARATE_REVIEW':'NORMALIZED_OBSERVATIONS_NOT_RAW_HTTP',
  reportedStartAt:reportedStart,reportedCompletedAt:completed,checkedAt:now,
  atReportedCompletion:completedUsable?evaluateOrangeXReadiness(normalized,{now:completed}):null,
  completionClockStatus:completedUsable?'USER_REPORTED_NOT_INDEPENDENTLY_VERIFIED':!chronologyValid?'FAIL_COMPLETION_BEFORE_START':
   completed!==null?'FAIL_FUTURE_COMPLETION':'UNVERIFIED_COMPLETION_CLOCK_MISSING',
  requests,requestCount:array(normalized.requests).length,requestsTruncated:array(normalized.requests).length>100,
  http200Count:requests.filter(row=>row.httpStatus===200).length,markets,current,status:current.status,
  activationAllowed:false,realDataAutoEntryEnabled:false,paperAutoEntryEnabled:false,liveOrdersEnabled:false,
  note:'오프라인 자료 검토입니다. 새 API 접속·실시간 검증·공식 단위 인증이 아닙니다. 원값을 환산하거나 다른 파일로 누락을 채우지 않습니다.'};
}
