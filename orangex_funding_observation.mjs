// PUBLIC funding observation only. Never a settlement ledger, account query,
// forecast-to-cash conversion, schedule inference or execution approval.
import {spawn} from 'node:child_process';
import {curlPublicProbe} from './scripts/diagnose-orangex-public.mjs';

const ENDPOINT='https://api.orangex.com/api/v1/public/coin_gecko_contracts';
const ASSETS=Object.freeze(['BTC','ETH','SOL']);
const FIELDS=Object.freeze(['funding_rate','next_funding_rate','next_funding_rate_timestamp']);
const CATEGORIES=new Set(['OK','PROXY_CONNECT_REJECTED','PROXY_DNS','DNS','TLS','TIMEOUT','NETWORK','HTTP','SCHEMA','API',
 'CURL_NOT_FOUND','RESPONSE_TOO_LARGE','REDIRECT_NOT_FOLLOWED','PROCESS_CLEANUP_UNCONFIRMED']);
const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const stamp=value=>Number.isSafeInteger(value)&&value>=1e12&&value<8640000000000000;
const type=value=>value===undefined?'MISSING':value===null?'NULL':Array.isArray(value)?'ARRAY':typeof value==='object'?'OBJECT':
 typeof value==='number'?'NUMBER':typeof value==='string'?'STRING':typeof value==='boolean'?'BOOLEAN':'UNRECOGNIZED';
const context={mode:'READ_ONLY',activationAllowed:false,realDataAutoEntryEnabled:false,paperAutoEntryEnabled:false,
 liveOrdersEnabled:false,ordersSubmitted:false,accountChecked:false};

export function orangeXFundingURL(){return ENDPOINT}

/** Reuses bounded curl transport, proxy/CA inheritance and close-before-return
 * handling. Neither arbitrary URLs nor credentials are accepted. */
export async function orangeXFundingProbe({spawnProcess=spawn,platform=process.platform}={}){
 const wrapped=(command,args,options)=>{
  const next=[...args],index=next.indexOf('--url');if(index<0)throw Error('PUBLIC_FUNDING_URL_UNAVAILABLE');
  next[index+1]=ENDPOINT;return spawnProcess(command,next,options);
 };
 const probe=await curlPublicProbe('docs',undefined,{spawnProcess:wrapped,platform});
 return {...probe,kind:'funding',url:ENDPOINT};
}

function observedField(row,key,index){
 const present=Object.hasOwn(row,key),value=row[key],numeric=typeof value==='number'&&Number.isFinite(value)||
  typeof value==='string'&&value.length<=64&&/^[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?$/.test(value)&&Number.isFinite(Number(value)),
  isoTimestamp=key==='next_funding_rate_timestamp'&&typeof value==='string'&&value.length<=40&&
   /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)&&Number.isFinite(Date.parse(value)),
  valid=present&&(numeric&&(key!=='next_funding_rate_timestamp'||Number(value)>0)||isoTimestamp);
 return {present,type:type(value),value:valid?value:null,source:present?`rows[${index}].${key}`:null,
  observationStatus:!present?'UNVERIFIED':valid?'PASS':'FAIL',
  interpretation:key==='funding_rate'?'CURRENT_RATE_RAW_UNIT_UNVERIFIED':key==='next_funding_rate'?
   'FORECAST_RATE_NEVER_REALIZED_SETTLEMENT':'RAW_NEXT_FUNDING_TIME_UNIT_AND_MEANING_UNVERIFIED'};
}

/** Only explicit instrument_name matches are associated with a contract.
 * ticker_id/symbol naming conventions are observed as types, never guessed.
 * Direct arrays and {result:[...]} are candidate observed shapes, not claims
 * that the independently unretrieved official response schema is verified. */
export function normalizeOrangeXFundingObservation(probe,{receivedAt=Date.now(),dataSource='USER_REPORTED_PUBLIC_API_OBSERVATIONS'}={}){
 if(!stamp(receivedAt)||!['USER_REPORTED_PUBLIC_API_OBSERVATIONS','SYNTHETIC_TEST'].includes(dataSource))throw Error('INVALID_FUNDING_OBSERVATION_OPTIONS');
 const synthetic=dataSource==='SYNTHETIC_TEST'||probe?.syntheticTest===true||probe?.executionMode==='SYNTHETIC_TEST'||
  ['SYNTHETIC_TEST','SYNTHETIC_FIXTURE','MOCK','MOCK_RESPONSE','SYNTHETIC'].includes(probe?.dataSource),
  historical=probe?.executionMode==='HISTORICAL_REPLAY'||probe?.runKind==='BACKTEST'||
   ['HISTORICAL_REPLAY','HISTORICAL_SNAPSHOT','HISTORICAL_PUBLIC_OBSERVATION','BACKTEST'].includes(probe?.dataSource),
  source=synthetic?'SYNTHETIC_TEST':historical?'HISTORICAL_REPLAY':dataSource;
 const transport={category:CATEGORIES.has(probe?.category)?probe.category:'NETWORK',
  httpStatus:Number.isInteger(probe?.httpStatus)&&probe.httpStatus>=100&&probe.httpStatus<=599?probe.httpStatus:null,
  proxyConnectStatus:Number.isInteger(probe?.proxyConnectStatus)&&probe.proxyConnectStatus>=100&&probe.proxyConnectStatus<=599?probe.proxyConnectStatus:null,
  processClosed:typeof probe?.processClosed==='boolean'?probe.processClosed:null};
 let rows=null,reason='TRANSPORT_NOT_CONFIRMED',observationStatus='UNVERIFIED',envelopeType='UNOBSERVED',rowsPath=null;
 if(transport.processClosed===false){reason='PROCESS_TERMINATION_UNCONFIRMED';observationStatus='FAIL'}
 else if(transport.category==='OK'&&transport.httpStatus!==null&&(transport.httpStatus<200||transport.httpStatus>=300)){
  reason='HTTP_NOT_SUCCESSFUL';observationStatus='FAIL';
 }else if(transport.category==='OK'&&transport.httpStatus>=200&&transport.httpStatus<300&&transport.processClosed===true){
  let body;
  try{body=JSON.parse(probe.body);envelopeType=type(body)}catch{reason='RESPONSE_NOT_JSON';observationStatus='FAIL'}
  if(plain(body)&&body.error){reason='API_ERROR';observationStatus='FAIL'}
  else if(Array.isArray(body)){rows=body;rowsPath='response'}
  else if(plain(body)&&Array.isArray(body.result)){rows=body.result;rowsPath='result'}
  else if(body!==undefined){reason='RESPONSE_SCHEMA_UNVERIFIED'}
  if(rows&&rows.length>10000){rows=null;reason='RESPONSE_ROW_LIMIT';observationStatus='FAIL'}
 }
 const markets=ASSETS.map(asset=>{
  const instrumentName=asset+'-USDT-PERPETUAL',matches=rows===null?[]:rows.map((row,index)=>({row,index}))
   .filter(({row})=>plain(row)&&row.instrument_name===instrumentName),matched=matches.length===1?matches[0]:null,
   fields=matched?Object.fromEntries(FIELDS.map(key=>[key,observedField(matched.row,key,matched.index)])):{};
  const status=matches.length>1?'FAIL':matched?Object.values(fields).some(field=>field.observationStatus==='FAIL')?'FAIL':
   Object.values(fields).every(field=>field.observationStatus==='PASS')?'PASS':'UNVERIFIED':'UNVERIFIED';
  return {asset,instrumentName,exactMatches:matches.length,matchedBy:matched?'instrument_name':null,
   observationStatus:status,reason:matches.length>1?'DUPLICATE_EXACT_INSTRUMENT':matched?
    status==='PASS'?'EXACT_RAW_FIELDS_OBSERVED':status==='FAIL'?'INVALID_RAW_FUNDING_FIELD':'RAW_FUNDING_FIELDS_MISSING':'EXACT_INSTRUMENT_UNOBSERVED',
   fields,fundingUnitVerified:false,actualScheduleVerified:false,nextTimestampMeaningVerified:false,
   realizedSettlementHistoryVerified:false,currentFundingSourceTimestampObserved:false,
   actualFundingEstimate:null,nextRateIsRealizedFunding:false,entryEligible:false};
 });
 if(rows!==null){
  observationStatus=markets.some(row=>row.observationStatus==='FAIL')?'FAIL':markets.every(row=>row.observationStatus==='PASS')?'PASS':'UNVERIFIED';
  reason=observationStatus==='PASS'?'RAW_MATCHED_FUNDING_OBSERVATIONS_ONLY':observationStatus==='FAIL'?'INVALID_OR_DUPLICATE_MATCHED_ROWS':'CONTRACT_MAPPING_OR_FIELDS_UNVERIFIED';
 }
 const knownFields=Object.fromEntries(['instrument_name','ticker_id','symbol',...FIELDS].map(key=>[key,
  [...new Set((rows??[]).filter(plain).map(row=>type(row[key])))].sort()]));
 return {kind:'ORANGEX_PUBLIC_FUNDING_OBSERVATION',...context,dataSource:source,syntheticTest:synthetic,
  receivedAt,receivedAtMeaning:'LOCAL_RESPONSE_RECEIPT_NOT_EXCHANGE_FUNDING_TIMESTAMP',endpoint:ENDPOINT,
  status:'NOT_READY',observationStatus,reason,transport,
  schema:{envelopeType,rowsPath,rowCount:rows?.length??null,knownFields,responseSchemaOfficiallyVerified:false},markets,
  rawHttpBodiesIncluded:false,rateUnit:'UNVERIFIED',symbolSchedule:'UNVERIFIED',fundingHistoryRecovery:'UNVERIFIED',
  limitations:['EXACT_INSTRUMENT_NAME_ONLY_NO_TICKER_ID_GUESSING','CURRENT_RATE_AND_NEXT_FORECAST_ARE_DIFFERENT_FIELDS',
   'NEXT_TIMESTAMP_UNIT_AND_SETTLEMENT_MEANING_UNVERIFIED','ONE_NEXT_TIMESTAMP_DOES_NOT_PROVE_AN_INTERVAL',
   'NO_EIGHT_HOUR_DEFAULT_FOR_BTC_ETH_SOL','NO_REALIZED_OR_ACCOUNT_FUNDING_LEDGER'],
  note:'공개 요율 원필드 관측만 보존합니다. 예상 요율·다음 시각을 실제 정산·고정 주기·현재 계정 비용으로 바꾸지 않습니다.'};
}
