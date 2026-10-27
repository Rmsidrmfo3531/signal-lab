// Standalone public diagnostics: no .env, application server, account API or store.
// curl keeps the user's proxy/CA policy; --disable prevents a curlrc from adding
// authentication, redirects, uploads or other requests. No response body is logged.
import {spawn} from 'node:child_process';
import {pathToFileURL} from 'node:url';

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

export function publicProbeURL(kind,instrumentName){
 if(kind==='docs')return 'https://openapi-docs.orangex.com/';
 const paths={instruments:'/public/get_instruments',tickers:'/public/tickers',book:'/public/get_order_book'};
 if(!Object.hasOwn(paths,kind))throw new Error('PUBLIC_ENDPOINT_NOT_ALLOWED');
 const url=new URL(API+paths[kind]);
 if(kind==='book'){
  if(typeof instrumentName!=='string'||!NAME.test(instrumentName))throw new Error('INVALID_PUBLIC_INSTRUMENT');
  url.searchParams.set('instrument_name',instrumentName);url.searchParams.set('depth','20');
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
export function curlPublicProbe(kind,instrumentName,{spawnProcess=spawn,platform=process.platform}={}){
 const url=publicProbeURL(kind,instrumentName);
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
 for(const key of ['instruments','tickers','data','bids','asks','timestamp','instrument_name','mark_price']){
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
 for(const key of ['contract_size','min_trade_amount','min_order_amount','min_order_size','min_notional',
  'lot_size','qty_step','tick_size','maker_commission','taker_commission','maker_fee','taker_fee']){
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
 if(bid>ask)return null;
 const clock=observedClock(result.timestamp,now);
 return {bid,ask,spread:ask-bid,spreadBps:(ask-bid)/((bid+ask)/2)*10000,
  timestamp:clock.timestamp,timestampSource:clock.timestamp===null?null:'result.timestamp',timestampUnits:clock.units,
  ageMs:clock.ageMs,fresh:clock.fresh,
  markPrice:positive(result.mark_price),markPriceSource:positive(result.mark_price)===null?null:'result.mark_price'};
}

export async function diagnoseOrangeXPublic({probe=curlPublicProbe,now=()=>Date.now()}={}){
 const checkedAt=new Date(now()).toISOString(),requests=[];
 const run=async(kind,name)=>{
  const raw=await probe(kind,name),decoded=decode({...raw,kind});
  requests.push({kind,instrumentName:name??null,url:publicProbeURL(kind,name),method:'GET',
   parameterSpecificationVerified:false,status:decoded.status,...decoded.diagnostic,
   ...(decoded.schemaObservation?{schemaObservation:decoded.schemaObservation}:{}),
   ...(decoded.endpointNamesPresent?{endpointNamesPresent:decoded.endpointNamesPresent}:{})});
  return decoded;
 };
 const docs=await run('docs'),instruments=await run('instruments'),tickers=await run('tickers');
 const instrumentRows=rows(instruments.result,'instruments'),tickerRows=rows(tickers.result,'tickers');
 for(const [kind,result,list] of [['instruments',instruments,instrumentRows],['tickers',tickers,tickerRows]]){
  if(result.status==='OBSERVED'&&!list){
   const request=requests.find(item=>item.kind===kind);request.status='FAILED';request.category='SCHEMA';
  }
 }
 const markets=[];
 for(const asset of ASSETS){
  const seen=new Set(),matches=[];
  for(const [index,row] of (instrumentRows?.items??[]).entries()){
   if(!plain(row)||typeof row.instrument_name!=='string'||!NAME.test(row.instrument_name)||
    !row.instrument_name.startsWith(asset+'-')||seen.has(row.instrument_name))continue;
   seen.add(row.instrument_name);matches.push({row,path:`${instrumentRows.path}[${index}]`});
  }
  // Bounded public diagnostic, never a full exchange crawler.
  const candidates=matches.length?matches.slice(0,3):[{row:null,path:null}];
  for(const {row,path} of candidates){
   const instrumentName=row?.instrument_name??`${asset}-USDT-PERPETUAL`,book=await run('book',instrumentName);
   const nameMatches=book.result?.instrument_name===undefined||book.result.instrument_name===instrumentName;
   const observation=book.status==='OBSERVED'&&nameMatches?observeBook(book.result,now()):null;
   if(book.status==='OBSERVED'&&!observation){const request=requests.at(-1);request.status='FAILED';request.category='SCHEMA'}
   if(observation&&observation.fresh!==true){const request=requests.at(-1);request.status='FAILED';request.category='FRESHNESS'}
   const tickerIndex=tickerRows?.items.findIndex(item=>plain(item)&&item.instrument_name===instrumentName)??-1;
   const ticker=tickerIndex>=0?tickerRows.items[tickerIndex]:null,tickerPath=tickerIndex>=0?`${tickerRows.path}[${tickerIndex}]`:null;
   const tickerMark=positive(ticker?.mark_price),bookMark=observation?.markPrice??null;
   const markPrice=tickerMark??bookMark,markClock=observedClock(tickerMark!==null?ticker.timestamp:observation?.timestamp,now());
   markets.push({asset,instrumentName,contractNameSource:row?`${path}.instrument_name`:'SDK_CANDIDATE_ONLY',
    listingObserved:row!==null,active:typeof row?.is_active==='boolean'?row.is_active:null,
    additionalContractsOmitted:Math.max(0,matches.length-3),
    officialSpecificationVerified:false,orderSubmissionEnabled:false,contractFields:row?fields(row,path):{},
    tickerFields:ticker?fields(ticker,tickerPath):{},book:observation,
    markPrice,markPriceSource:tickerMark!==null?`${tickerPath}.mark_price`:observation?.markPriceSource??null,
    markPriceTimestamp:markPrice!==null?markClock.timestamp:null,
    markPriceTimestampSource:markPrice===null||markClock.timestamp===null?null:tickerMark!==null?`${tickerPath}.timestamp`:'result.timestamp',
    markPriceTimestampUnits:markPrice!==null?markClock.units:null,
    markPriceAgeMs:markPrice!==null?markClock.ageMs:null,markPriceFresh:markPrice!==null?markClock.fresh:null,
    minimumOrderQuantityVerified:false,feeUnitsVerified:false});
  }
 }
 const failures=requests.filter(item=>item.status==='FAILED'),transport=failures.some(item=>
  ['PROXY_CONNECT_REJECTED','PROXY_DNS','DNS','TLS','TIMEOUT','NETWORK','CURL_NOT_FOUND'].includes(item.category));
 return {kind:'ORANGEX_PUBLIC_DIAGNOSTIC',mode:'READ_ONLY',checkedAt,status:failures.length?'INCOMPLETE':'PUBLIC_RESPONSES_OBSERVED',
  exitCode:failures.length?(transport?2:1):0,officialSpecificationVerified:false,
  accountChecked:false,ordersSubmitted:false,requests,markets,
  note:'공개 GET 진단만 수행합니다. 응답 필드 관측과 공식 명세·단위 확인은 다릅니다. 상장 목록에 없거나 조회 실패한 계약을 상장 폐지로 단정하지 않습니다. 가격 중간값을 Mark Price로 대체하지 않습니다.'};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 if(process.argv.length!==2){console.error('사용법: node scripts/diagnose-orangex-public.mjs');process.exitCode=1}
 else{const report=await diagnoseOrangeXPublic();console.log(JSON.stringify(report,null,2));process.exitCode=report.exitCode}
}
