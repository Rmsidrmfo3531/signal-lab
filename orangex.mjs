/** Phase 1: HTTP-only, read-only OrangeX observations.
 * No order, cancellation, leverage, transfer or withdrawal transport exists here.
 * The public protocol reference is a GitHub SDK, not a verified official spec.
 */
const API='https://api.orangex.com/api/v1';
const AUTH='/public/auth',BOOK='/public/get_order_book',INSTRUMENTS='/public/get_instruments',TICKERS='/public/tickers';
const MAX_RESPONSE_BYTES=2*1024*1024;
const REFERENCE='https://github.com/OrangeX-Global/orangex-api-python/tree/b6aece329906fa651249bc919a5ec6391abd881e';
const MESSAGES=Object.freeze({
 DISABLED:'OrangeX 조회 연결이 꺼져 있습니다.',MODE_NOT_ALLOWED:'이번 단계에서는 READ_ONLY 모드만 허용합니다.',
 SPEC_UNVERIFIED:'공식 인증·계좌 조회 명세가 확인되지 않아 요청을 차단했습니다.',
 CREDENTIALS_MISSING:'OrangeX 조회 인증 정보가 설정되지 않았습니다.',
 INVALID_CONFIG:'OrangeX 조회 설정이 유효하지 않습니다.',INVALID_INSTRUMENT:'조회 요청 종목 이름이 유효하지 않습니다.',
 UNSUPPORTED_OPERATION:'공식 명세를 확인하지 못한 조회 기능입니다.',
 NETWORK_ERROR:'OrangeX 연결에 실패했습니다.',REQUEST_TIMEOUT:'OrangeX 조회 시간이 초과됐습니다.',
 HTTP_ERROR:'OrangeX 조회 경로에서 HTTP 오류 응답을 받았습니다.',RATE_LIMITED:'조회 요청 제한 응답 또는 대기 상태입니다.',
 REDIRECT_BLOCKED:'OrangeX의 다른 주소로 이동하는 응답을 차단했습니다.',
 INVALID_RESPONSE:'OrangeX 조회 응답 구조가 유효하지 않습니다.',API_ERROR:'OrangeX가 API 오류를 반환했습니다.',
 AUTH_FAILED:'OrangeX 인증 요청을 완료하지 못했습니다.',TOKEN_RESPONSE_INVALID:'OrangeX 인증 응답이 유효하지 않습니다.'
});
const number=value=>{
 if(typeof value!=='number'&&typeof value!=='string'||typeof value==='string'&&!value.trim())return null;
 const parsed=Number(value);return Number.isFinite(parsed)?parsed:null;
};
const positive=value=>{const n=number(value);return n!==null&&n>0?n:null};
const instrument=value=>typeof value==='string'&&/^[A-Z0-9]{2,20}-[A-Z0-9]{2,12}-PERPETUAL$/.test(value);
const currency=value=>typeof value==='string'&&/^[A-Z0-9]{2,20}$/.test(value);
const publicInstrument=value=>typeof value==='string'&&/^[A-Z0-9][A-Z0-9_-]{1,79}$/.test(value);
const NUMERIC_FIELDS=Object.freeze(['min_trade_amount','min_qty','min_notional','tick_size','contract_size','qty_step','quantity_increment',
 'quantity_step','min_order_amount','min_order_size','maker_commission','taker_commission','maker_fee','taker_fee','maker','taker','maker_fee_rate','taker_fee_rate']);
const STRING_FIELDS=Object.freeze(['base_currency','quote_currency','settlement_currency','kind','settlement_period']);
const stamp=value=>{const at=positive(value);return at!==null&&at>=1e12&&at<=8640000000000000?at:null};
const freshAt=(at,now,age)=>at!==null&&at<=now+5000&&now-at<=age;
function gridMatch(values,step){
 if(!positive(step))return 'UNVERIFIED';
 return values.every(value=>{
  const units=value/step,nearest=Math.round(units);
  return Number.isSafeInteger(nearest)&&Math.abs(value-nearest*step)<=Math.max(Number.EPSILON*Math.abs(value)*8,step*1e-9);
 })?'MATCH':'MISMATCH';
}
const safeClone=value=>structuredClone(value);
// Preserve only known diagnostic identifiers, never arbitrary provider values.
// A numeric HTTP status alone does not establish whether a proxy or OrangeX
// produced it; callers must keep that distinction explicitly unconfirmed.
const DNS_CODES=new Set(['EAI_AGAIN','EAI_FAIL','ENOTFOUND']);
const TLS_CODES=new Set(['CERT_HAS_EXPIRED','CERT_NOT_YET_VALID','DEPTH_ZERO_SELF_SIGNED_CERT',
 'SELF_SIGNED_CERT_IN_CHAIN','UNABLE_TO_VERIFY_LEAF_SIGNATURE','UNABLE_TO_GET_ISSUER_CERT',
 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY','ERR_TLS_CERT_ALTNAME_INVALID','ERR_TLS_CERT_SIGNATURE_ALGORITHM_UNSUPPORTED',
 'ERR_SSL_WRONG_VERSION_NUMBER','ERR_SSL_SSLV3_ALERT_HANDSHAKE_FAILURE']);
const TIMEOUT_CODES=new Set(['ETIMEDOUT','ESOCKETTIMEDOUT','UND_ERR_CONNECT_TIMEOUT','UND_ERR_HEADERS_TIMEOUT','UND_ERR_BODY_TIMEOUT']);
const TRANSPORT_CODES=new Set([...DNS_CODES,...TLS_CODES,...TIMEOUT_CODES,'ECONNRESET','ECONNREFUSED','ECONNABORTED',
 'ENETUNREACH','EHOSTUNREACH','EPIPE','EPROTO','UND_ERR_SOCKET']);
const HTTP_STATUS=value=>typeof value==='number'&&Number.isInteger(value)&&value>=100&&value<=599?value:null;
function transportCode(error){
 const seen=new Set();
 try{for(let current=error,depth=0;current&&typeof current==='object'&&depth<5&&!seen.has(current);depth++){
   seen.add(current);
   if(TRANSPORT_CODES.has(current.code))return current.code;
   current=current.cause;
  }}catch{return null}
 return null;
}
function category(code,causeCode){
 if(DNS_CODES.has(causeCode))return 'DNS';
 if(TLS_CODES.has(causeCode))return 'TLS';
 if(TIMEOUT_CODES.has(causeCode)||code==='REQUEST_TIMEOUT')return 'TIMEOUT';
 if(['INVALID_RESPONSE','TOKEN_RESPONSE_INVALID'].includes(code))return 'SCHEMA';
 if(['HTTP_ERROR','RATE_LIMITED','REDIRECT_BLOCKED'].includes(code))return 'HTTP';
 if(code==='API_ERROR')return 'API';
 if(code==='AUTH_FAILED')return 'AUTH';
 return code==='NETWORK_ERROR'?'NETWORK':'CONFIGURATION';
}

export class OrangeXError extends Error {
 constructor(code,diagnostics={}){
  const safeCode=Object.hasOwn(MESSAGES,code)?code:'INVALID_RESPONSE';
  super(MESSAGES[safeCode]);this.name='OrangeXError';this.code=safeCode;
  this.transportCode=TRANSPORT_CODES.has(diagnostics?.transportCode)?diagnostics.transportCode:null;
  this.httpStatus=HTTP_STATUS(diagnostics?.httpStatus);
  this.category=category(safeCode,this.transportCode);this.responseSource='UNCONFIRMED';
 }
}

/** Credentials remain private memory. contract is dependency injection for a
 * subsequently verified implementation or isolated tests, never an env switch.
 */
export class OrangeXReadOnlyAdapter {
 #fetch;#clock;#sleep;#clientId;#clientSecret;#token=null;#refreshToken=null;#expiresAt=0;
 #authPending=null;#refreshPending=null;#id=0;#lastRequestAt=0;#cooldownUntil=0;#snapshot;#contract;#responseStatuses=new WeakMap();
 constructor({enabled=false,mode='READ_ONLY',clientId='',clientSecret='',
  instruments=['BTC-USDT-PERPETUAL','ETH-USDT-PERPETUAL','SOL-USDT-PERPETUAL'],
  includePublicDetails=false,listingCurrency='USDT',
  fetcher=globalThis.fetch,now=()=>Date.now(),sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms)),
  timeoutMs=8000,maxRetries=1,minIntervalMs=100,maxQuoteAgeMs=90000,refreshIntervalMs=30000,contract=null}={}){
  if(mode!=='READ_ONLY')throw new OrangeXError('MODE_NOT_ALLOWED');
  if(typeof enabled!=='boolean'||typeof fetcher!=='function'||typeof now!=='function'||typeof sleep!=='function'||
   !Array.isArray(instruments)||!instruments.length||instruments.length>10||!instruments.every(instrument)||
   !Number.isInteger(timeoutMs)||timeoutMs<100||timeoutMs>30000||!Number.isInteger(maxRetries)||maxRetries<0||maxRetries>2||
   !Number.isInteger(minIntervalMs)||minIntervalMs<0||minIntervalMs>5000||!Number.isInteger(maxQuoteAgeMs)||maxQuoteAgeMs<1000||
   !Number.isInteger(refreshIntervalMs)||refreshIntervalMs<1000||refreshIntervalMs>3600000||
   typeof clientId!=='string'||typeof clientSecret!=='string'||typeof includePublicDetails!=='boolean'||!currency(listingCurrency))throw new OrangeXError('INVALID_CONFIG');
  this.enabled=enabled;this.mode='READ_ONLY';this.instruments=Object.freeze([...new Set(instruments)]);
  this.timeoutMs=timeoutMs;this.maxRetries=maxRetries;this.minIntervalMs=minIntervalMs;this.maxQuoteAgeMs=maxQuoteAgeMs;
  this.refreshIntervalMs=refreshIntervalMs;
  this.includePublicDetails=includePublicDetails;this.listingCurrency=listingCurrency;
  this.#fetch=fetcher;this.#clock=now;this.#sleep=sleep;this.#clientId=clientId;this.#clientSecret=clientSecret;
  this.#contract=Object.freeze({authVerified:contract?.officialSpecVerified===true&&contract?.authVerified===true});
  this.#snapshot={connected:false,checkedAt:null,marketStatus:enabled?'unverified':'disabled',markets:[],errors:[]};
 }
 #requireEnabled(){if(!this.enabled)throw new OrangeXError('DISABLED')}
 #requireAuthContract(){this.#requireEnabled();if(!this.#contract.authVerified)throw new OrangeXError('SPEC_UNVERIFIED')}
 #authentication(){return {configured:Boolean(this.#clientId&&this.#clientSecret),
  authenticated:Boolean(this.#token&&this.#clock()<this.#expiresAt),expiresAt:this.#expiresAt||null,
  specificationVerified:this.#contract.authVerified}}
 getStatus(){
  const snapshot=safeClone(this.#snapshot),now=this.#clock();
  for(const market of snapshot.markets){
   market.fresh=freshAt(market.priceAt,now,this.maxQuoteAgeMs);
   if(Object.hasOwn(market,'markPriceAt'))market.markPriceFresh=market.markPrice!==null&&freshAt(market.markPriceAt,now,this.maxQuoteAgeMs);
  }
  return {enabled:this.enabled,mode:'READ_ONLY',...snapshot,accountStatus:this.#clientId&&this.#clientSecret?'unverified':'not_configured',account:null,
   authentication:this.#authentication(),rateLimit:{blocked:now<this.#cooldownUntil,retryAfterAt:Number.isFinite(this.#cooldownUntil)&&this.#cooldownUntil>now?this.#cooldownUntil:null},
   listingCurrency:this.listingCurrency,listingCurrencyVerified:false,includePublicDetails:this.includePublicDetails,publicDetailsEnabled:this.includePublicDetails,
   dataSource:snapshot.markets.some(market=>market.bookObserved===true||positive(market.bid)&&positive(market.ask)&&market.ask>market.bid||
    market.listingObserved===true||positive(market.markPrice))?'REAL_PUBLIC_READ_ONLY':'UNOBSERVED',
   capabilities:{marketData:true,publicInstruments:true,publicTickers:true,accountRead:false,instruments:false,positions:false,openOrders:false,trades:false,
    oauth:this.#contract.authVerified,oauthImplemented:true,orderSubmission:false,websocket:false},
   automation:{enabled:false,canEnable:false,killSwitch:'NOT_IMPLEMENTED',reason:'1단계 조회 전용'},
   verification:{officialSpec:this.#contract.authVerified?'VERIFIED_FOR_INJECTED_AUTH_CONTRACT':'UNVERIFIED',
    protocolReference:this.includePublicDetails?'USER_REPORTED_PARAMETERS_AND_SDK_REFERENCE':'SDK_SOURCE_ONLY',reference:REFERENCE,sourceOwnership:'UNVERIFIED',
    liveConnection:this.#snapshot.checkedAt===null?'UNTESTED':this.#snapshot.connected?'CONNECTED':'FAILED'},
   warnings:[this.includePublicDetails?'공개 경로·필수 매개변수는 사용자 확인 자료를 반영했으며 응답 필드·단위의 공식 검증을 대체하지 않습니다.':
    '조회 프로토콜은 공개 SDK 소스 참조이며 공식 문서·실제 응답 검증을 대체하지 않습니다.',
    '조회 후보의 공통 상장·최소 주문량·가격 단위·수수료·펀딩·보호 주문은 미검증이며 거래 가능으로 승인하지 않습니다.'],
   orderSubmissionEnabled:false};
 }
 toJSON(){return this.getStatus()}
 async snapshot({refresh=false}={}){
  const expired=this.#snapshot.checkedAt===null||this.#clock()-this.#snapshot.checkedAt>=this.refreshIntervalMs;
  return this.enabled&&(refresh||expired)?this.refresh():this.getStatus();
 }
 async #readJSON(response){
  const declared=number(response.headers?.get?.('content-length'));
  if(declared!==null&&declared>MAX_RESPONSE_BYTES){await response.body?.cancel?.();throw new OrangeXError('INVALID_RESPONSE')}
  if(response.body?.getReader){
   const reader=response.body.getReader(),chunks=[];let size=0;
   try{
    while(true){
     const part=await reader.read();if(part.done)break;
     size+=part.value.byteLength;
     if(size>MAX_RESPONSE_BYTES){await reader.cancel();throw new OrangeXError('INVALID_RESPONSE')}
     chunks.push(part.value);
    }
    const bytes=new Uint8Array(size);let offset=0;
    for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength}
    return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
   }finally{reader.releaseLock()}
  }
  // Small dependency-injected response doubles may expose only json(). Their
  // serialized size is still checked; the enclosing request timeout remains active.
  const parsed=await response.json();
  if(Buffer.byteLength(JSON.stringify(parsed))>MAX_RESPONSE_BYTES)throw new OrangeXError('INVALID_RESPONSE');
  return parsed;
 }
 #retryAfter(response,attempt){
  const value=response.headers?.get?.('retry-after');
  const seconds=value===null||value===undefined?null:number(value);
  const date=typeof value==='string'?Date.parse(value):NaN;
  return Math.max(0,seconds!==null?seconds*1000:Number.isFinite(date)?date-this.#clock():200*2**attempt);
 }
 async #request(path,{params={},method='GET',auth=false}={}){
  this.#requireEnabled();
  if(this.#clock()<this.#cooldownUntil)throw new OrangeXError('RATE_LIMITED');
  // This closed allowlist is separate from caller input. No generic API method
  // or provider path is accepted through the public interface.
  if(!(([BOOK,INSTRUMENTS,TICKERS].includes(path)&&method==='GET'&&!auth)||(path===AUTH&&auth&&['GET','POST'].includes(method))))throw new OrangeXError('UNSUPPORTED_OPERATION');
  const requestId=String(++this.#id),url=new URL(API+path),headers={accept:'application/json'};
  let body;
  if(method==='GET')for(const [key,value] of Object.entries(params))url.searchParams.set(key,String(value));
  else{headers['content-type']='application/json';body=JSON.stringify({jsonrpc:'2.0',id:requestId,method:path,params})}
  const attempts=auth?0:this.maxRetries;
  for(let attempt=0;attempt<=attempts;attempt++){
   const wait=this.minIntervalMs-(this.#clock()-this.#lastRequestAt);if(wait>0)await this.#sleep(wait);
   this.#lastRequestAt=this.#clock();
   const controller=new AbortController();let timer,responseStatus=null;
   try{
    const timedOut=new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new OrangeXError('REQUEST_TIMEOUT'))},this.timeoutMs)});
    const response=await Promise.race([this.#fetch(url.href,{method,headers,body,redirect:'error',signal:controller.signal}),timedOut]);
    responseStatus=HTTP_STATUS(response?.status);
    if(response?.redirected||response?.status>=300&&response.status<400)throw new OrangeXError('REDIRECT_BLOCKED');
    if(response?.status===429||response?.status>=500){
     const retryAfter=this.#retryAfter(response,attempt);
     this.#cooldownUntil=Math.max(this.#cooldownUntil,this.#clock()+retryAfter);
     await Promise.race([response.body?.cancel?.(),timedOut]);
     // A bounded request must not shorten the provider's cooldown. Long waits
     // are deferred to a later caller; they never become an early retry.
     if(retryAfter>5000)throw new OrangeXError('RATE_LIMITED');
     if(attempt<attempts){
      clearTimeout(timer);
      await this.#sleep(retryAfter);continue;
     }
     throw new OrangeXError(response.status===429?'RATE_LIMITED':'HTTP_ERROR');
    }
    if(!response?.ok){await Promise.race([response?.body?.cancel?.(),timedOut]);throw new OrangeXError(auth?'AUTH_FAILED':'HTTP_ERROR')}
    let envelope;
    try{envelope=await Promise.race([this.#readJSON(response),timedOut])}
    catch(error){
     if(error instanceof OrangeXError)throw error;
     const causeCode=transportCode(error);
     throw new OrangeXError(controller.signal.aborted?'REQUEST_TIMEOUT':causeCode?'NETWORK_ERROR':'INVALID_RESPONSE',
      {transportCode:causeCode});
    }
    if(!envelope||typeof envelope!=='object'||Array.isArray(envelope)||envelope.error)throw new OrangeXError(envelope?.error?'API_ERROR':'INVALID_RESPONSE');
    if(envelope.jsonrpc!==undefined&&envelope.jsonrpc!=='2.0')throw new OrangeXError('INVALID_RESPONSE');
    if(method==='POST'&&String(envelope.id)!==requestId)throw new OrangeXError('INVALID_RESPONSE');
    if(!Object.hasOwn(envelope,'result')||!envelope.result||typeof envelope.result!=='object')throw new OrangeXError('INVALID_RESPONSE');
    this.#responseStatuses.set(envelope.result,responseStatus);
    return envelope.result;
   }catch(error){
    if(error instanceof OrangeXError){
     if(error.httpStatus===null&&responseStatus!==null)throw new OrangeXError(error.code,{httpStatus:responseStatus,transportCode:error.transportCode});
     throw error;
    }
    // Never reuse the provider's exception text: it can contain an auth URL,
    // response body, client secret, access token or refresh token.
    throw new OrangeXError(controller.signal.aborted?'REQUEST_TIMEOUT':'NETWORK_ERROR',
     {httpStatus:responseStatus,transportCode:transportCode(error)});
   }finally{clearTimeout(timer)}
  }
 }
 #commitToken(result){
  const lifetime=positive(result?.expires_in),token=result?.access_token,refresh=result?.refresh_token;
  const validToken=value=>typeof value==='string'&&value.length>0&&value.length<=16384&&!/[\s\u0000-\u001f\u007f]/.test(value);
  if(!validToken(token)||!lifetime||!Number.isFinite(lifetime*1000)||
   refresh!==undefined&&refresh!==null&&!validToken(refresh))throw new OrangeXError('TOKEN_RESPONSE_INVALID',{httpStatus:this.#responseStatuses.get(result)});
  const expiresAt=this.#clock()+lifetime*1000;
  if(!Number.isFinite(expiresAt))throw new OrangeXError('TOKEN_RESPONSE_INVALID');
  this.#token=token;this.#expiresAt=expiresAt;
  if(typeof refresh==='string')this.#refreshToken=refresh;
  return this.#authentication();
 }
 async authenticate(){
  this.#requireAuthContract();
  if(!this.#clientId||!this.#clientSecret)throw new OrangeXError('CREDENTIALS_MISSING');
  if(this.#authPending)return this.#authPending;
  if(this.#token&&this.#clock()<this.#expiresAt-5000)return this.#authentication();
  this.#authPending=(async()=>{
   try{
    const result=this.#refreshToken?await this.#request(AUTH,{auth:true,method:'POST',params:{grant_type:'refresh_token',refresh_token:this.#refreshToken}}):
     await this.#request(AUTH,{auth:true,params:{grant_type:'client_credentials',client_id:this.#clientId,client_secret:this.#clientSecret}});
    return this.#commitToken(result);
   }catch(error){this.#token=null;this.#refreshToken=null;this.#expiresAt=0;throw error}
  })();
  try{return await this.#authPending}finally{this.#authPending=null}
 }
 async refreshAuthentication(){
  this.#requireAuthContract();
  if(!this.#refreshToken)throw new OrangeXError('AUTH_FAILED');
  if(this.#authPending)return this.#authPending;
  this.#authPending=(async()=>{
   try{return this.#commitToken(await this.#request(AUTH,{auth:true,method:'POST',params:{grant_type:'refresh_token',refresh_token:this.#refreshToken}}))}
   catch(error){this.#token=null;this.#refreshToken=null;this.#expiresAt=0;throw error}
  })();
  try{return await this.#authPending}finally{this.#authPending=null}
 }
 async getOrderBook(instrumentName,{depth=20}={}){
  if(!instrument(instrumentName)||!this.instruments.includes(instrumentName)||!Number.isInteger(depth)||depth<1||depth>20)throw new OrangeXError('INVALID_INSTRUMENT');
  const result=await this.#request(BOOK,{params:{instrument_name:instrumentName,depth}});
  const schemaError=()=>new OrangeXError('INVALID_RESPONSE',{httpStatus:this.#responseStatuses.get(result)});
  if(result.instrument_name!==undefined&&result.instrument_name!==instrumentName)throw schemaError();
  const levels=rows=>{
   if(!Array.isArray(rows)||!rows.length||rows.length>10000)throw schemaError();
   return rows.map(row=>{
    if(!Array.isArray(row)||row.length!==2||!positive(row[0])||!positive(row[1]))throw schemaError();
    return [Number(row[0]),Number(row[1])];
   });
  };
  const bids=levels(result.bids).sort((a,b)=>b[0]-a[0]),asks=levels(result.asks).sort((a,b)=>a[0]-b[0]);
  const bid=bids[0][0],ask=asks[0][0];if(bid>=ask)throw schemaError();
  // The SDK consumes timestamp directly; no undocumented seconds-to-ms guess.
  const suppliedAt=positive(result.timestamp),now=this.#clock();
  const priceAt=suppliedAt!==null&&suppliedAt>=1e12?suppliedAt:null;
  const fresh=priceAt!==null&&priceAt<=now+5000&&now-priceAt<=this.maxQuoteAgeMs;
  const [base,quote]=instrumentName.split('-');
  return {symbol:base+quote,instrumentName,tradable:false,instrumentVerified:false,
   bid,ask,midPrice:(bid+ask)/2,markPrice:null,spreadBps:(ask-bid)/((ask+bid)/2)*10000,
   priceAt,receivedAt:now,fresh,bids,asks,version:number(result.version),minQty:null,qtyStep:null,priceTick:null,
   verification:'SDK_PROTOCOL_REFERENCE_ONLY',orderSubmissionEnabled:false};
 }
 async getPublicInstruments(requestCurrency){
  if(!currency(requestCurrency))throw new OrangeXError('INVALID_CONFIG');
  const result=await this.#request(INSTRUMENTS,{params:{currency:requestCurrency}});
  const rows=Array.isArray(result)?result:Array.isArray(result.instruments)?result.instruments:null;
  if(!rows||rows.length>10000)throw new OrangeXError('INVALID_RESPONSE',{httpStatus:this.#responseStatuses.get(result)});
  const seen=new Set(),items=[];
  for(let index=0;index<rows.length;index++){
   const item=rows[index];
   if(!item||typeof item!=='object'||Array.isArray(item)||!publicInstrument(item.instrument_name)||seen.has(item.instrument_name))
    throw new OrangeXError('INVALID_RESPONSE',{httpStatus:this.#responseStatuses.get(result)});
   seen.add(item.instrument_name);const row={instrument_name:item.instrument_name,fields:{}};
   if(typeof item.is_active==='boolean')row.is_active=item.is_active;
   const source=Array.isArray(result)?`result[${index}]`:`result.instruments[${index}]`;
   for(const key of NUMERIC_FIELDS){
    const value=number(item[key]);if(value!==null)row.fields[key]={value,units:'UNVERIFIED',source:`${source}.${key}`};
   }
   for(const key of STRING_FIELDS){
    const value=item[key];if(typeof value==='string'&&/^[A-Za-z0-9_-]{1,32}$/.test(value))
     row.fields[key]={value,units:'UNVERIFIED',source:`${source}.${key}`};
   }
   items.push(row);
  }
  return {currency:requestCurrency,currencyMeaningVerified:false,observedAt:this.#clock(),officialSpecificationVerified:false,items};
 }
 async getPublicTickers(instrumentName){
  if(!instrument(instrumentName)||!this.instruments.includes(instrumentName))throw new OrangeXError('INVALID_INSTRUMENT');
  const result=await this.#request(TICKERS,{params:{instrument_name:instrumentName}});
  const rows=Array.isArray(result)?result:Array.isArray(result.tickers)?result.tickers:[result];
  const item=rows.length===1?rows[0]:null;
  if(!item||typeof item!=='object'||Array.isArray(item)||item.instrument_name!==instrumentName)
   throw new OrangeXError('INVALID_RESPONSE',{httpStatus:this.#responseStatuses.get(result)});
  const source=Array.isArray(result)?'result[0]':Array.isArray(result.tickers)?'result.tickers[0]':'result';
  const markPrice=positive(item.mark_price),hasMarkTimestamp=Object.hasOwn(item,'mark_timestamp'),
   markPriceAt=markPrice===null?null:stamp(hasMarkTimestamp?item.mark_timestamp:item.timestamp),now=this.#clock();
  return {instrumentName,observedAt:now,officialSpecificationVerified:false,markPrice,markPriceAt,
   markPriceFresh:markPrice!==null&&freshAt(markPriceAt,now,this.maxQuoteAgeMs),
   markPriceSource:markPrice===null?null:`${source}.mark_price`,
   markPriceAtSource:markPriceAt===null?null:`${source}.${hasMarkTimestamp?'mark_timestamp':'timestamp'}`,
   tickerAt:stamp(item.timestamp),timestampUnits:'MILLISECONDS_CANDIDATE_UNVERIFIED'};
 }
 async listInstruments(){throw new OrangeXError('UNSUPPORTED_OPERATION')}
 async readAccount(){throw new OrangeXError('SPEC_UNVERIFIED')}
 async getPositions(){throw new OrangeXError('SPEC_UNVERIFIED')}
 async getOpenOrders(){throw new OrangeXError('SPEC_UNVERIFIED')}
 async getTrades(){throw new OrangeXError('SPEC_UNVERIFIED')}
 async refresh(){
  if(!this.enabled)return this.getStatus();
  if(this.#refreshPending)return this.#refreshPending;
  this.#refreshPending=(async()=>{
   const markets=[],errors=[];let listings=null,booksObserved=0;
   const fail=(error,endpoint,instrumentName)=>{
    const safe=error instanceof OrangeXError?error:new OrangeXError('NETWORK_ERROR');errors.push({code:safe.code,message:safe.message,
     category:safe.category,httpStatus:safe.httpStatus,transportCode:safe.transportCode,responseSource:safe.responseSource,
     at:this.#clock(),endpoint,...(instrumentName?{instrumentName}:{})});
   };
   if(this.includePublicDetails)try{listings=await this.getPublicInstruments(this.listingCurrency)}catch(error){fail(error,'instruments')}
   for(const requested of this.instruments){
    let book=null,ticker=null;
    try{book=await this.getOrderBook(requested);booksObserved++}catch(error){fail(error,'book',requested)}
    if(!this.includePublicDetails){if(book)markets.push(book);continue}
    try{ticker=await this.getPublicTickers(requested)}catch(error){fail(error,'ticker',requested)}
    const listed=listings?.items.find(item=>item.instrument_name===requested),contractFields=listed?.fields??{};
    const priceStep=positive(contractFields.tick_size?.value),explicitStep=positive(contractFields.qty_step?.value),
     increment=positive(contractFields.quantity_increment?.value),
     quantityStep=explicitStep!==null&&increment!==null&&explicitStep!==increment?null:explicitStep??increment,
     quantityBasis=quantityStep===null?null:explicitStep!==null?'qty_step':'quantity_increment';
    markets.push({...book,symbol:requested.split('-').slice(0,2).join(''),instrumentName:requested,
     bookObserved:book!==null,bid:book?.bid??null,ask:book?.ask??null,midPrice:book?.midPrice??null,
     priceAt:book?.priceAt??null,fresh:book?.fresh??false,spreadBps:book?.spreadBps??null,
     listingObserved:listed!==undefined,active:typeof listed?.is_active==='boolean'?listed.is_active:null,
     listingStatus:listed?.is_active===true?'OBSERVED_ACTIVE':listed?.is_active===false?'OBSERVED_INACTIVE':listed?'OBSERVED_STATUS_UNKNOWN':'UNOBSERVED',
     actualInstrumentName:listed?.instrument_name??null,contractFields,currencyDefinitionsVerified:false,symbolMappingVerified:false,
     markPrice:ticker?.markPrice??null,markPriceAt:ticker?.markPriceAt??null,markPriceFresh:ticker?.markPriceFresh??false,
     markPriceSource:ticker?.markPriceSource??null,markPriceAtSource:ticker?.markPriceAtSource??null,tickerAt:ticker?.tickerAt??null,
     precision:{priceGrid:book?gridMatch([...book.bids,...book.asks].map(level=>level[0]),priceStep):'UNVERIFIED',
      quantityGrid:book?gridMatch([...book.bids,...book.asks].map(level=>level[1]),quantityStep):'UNVERIFIED',
      priceBasis:priceStep===null?null:'tick_size',quantityBasis,unitsVerified:false},
     fees:{units:'UNVERIFIED',makerBps:null,takerBps:null},
     tradable:false,instrumentVerified:false,minQty:null,qtyStep:null,priceTick:null,orderSubmissionEnabled:false});
   }
   this.#snapshot={connected:booksObserved>0,checkedAt:this.#clock(),marketStatus:booksObserved===this.instruments.length&&!errors.length?'connected':booksObserved?'partial':'offline',markets,errors};
   return this.getStatus();
  })();
  try{return await this.#refreshPending}finally{this.#refreshPending=null}
 }
}
