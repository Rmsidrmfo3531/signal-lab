/** Phase 1: HTTP-only, read-only OrangeX observations.
 * No order, cancellation, leverage, transfer or withdrawal transport exists here.
 * The public protocol reference is a GitHub SDK, not a verified official spec.
 */
const API='https://api.orangex.com/api/v1';
const AUTH='/public/auth',BOOK='/public/get_order_book';
const MAX_RESPONSE_BYTES=2*1024*1024;
const REFERENCE='https://github.com/OrangeX-Global/orangex-api-python/tree/b6aece329906fa651249bc919a5ec6391abd881e';
const MESSAGES=Object.freeze({
 DISABLED:'OrangeX 조회 연결이 꺼져 있습니다.',MODE_NOT_ALLOWED:'이번 단계에서는 READ_ONLY 모드만 허용합니다.',
 SPEC_UNVERIFIED:'공식 인증·계좌 조회 명세가 확인되지 않아 요청을 차단했습니다.',
 CREDENTIALS_MISSING:'OrangeX 조회 인증 정보가 설정되지 않았습니다.',
 INVALID_CONFIG:'OrangeX 조회 설정이 유효하지 않습니다.',INVALID_INSTRUMENT:'조회 요청 종목 이름이 유효하지 않습니다.',
 UNSUPPORTED_OPERATION:'공식 명세를 확인하지 못한 조회 기능입니다.',
 NETWORK_ERROR:'OrangeX 연결에 실패했습니다.',REQUEST_TIMEOUT:'OrangeX 조회 시간이 초과됐습니다.',
 HTTP_ERROR:'OrangeX 서버가 조회 요청을 거부했습니다.',RATE_LIMITED:'OrangeX 조회 요청 제한에 도달했습니다.',
 REDIRECT_BLOCKED:'OrangeX의 다른 주소로 이동하는 응답을 차단했습니다.',
 INVALID_RESPONSE:'OrangeX 조회 응답 구조가 유효하지 않습니다.',API_ERROR:'OrangeX가 API 오류를 반환했습니다.',
 AUTH_FAILED:'OrangeX 인증에 실패했습니다.',TOKEN_RESPONSE_INVALID:'OrangeX 인증 응답이 유효하지 않습니다.'
});
const number=value=>{
 if(typeof value!=='number'&&typeof value!=='string'||typeof value==='string'&&!value.trim())return null;
 const parsed=Number(value);return Number.isFinite(parsed)?parsed:null;
};
const positive=value=>{const n=number(value);return n!==null&&n>0?n:null};
const instrument=value=>typeof value==='string'&&/^[A-Z0-9]{2,20}-[A-Z0-9]{2,12}-PERPETUAL$/.test(value);
const safeClone=value=>structuredClone(value);

export class OrangeXError extends Error {
 constructor(code){super(MESSAGES[code]||MESSAGES.INVALID_RESPONSE);this.name='OrangeXError';this.code=Object.hasOwn(MESSAGES,code)?code:'INVALID_RESPONSE'}
}

/** Credentials remain private memory. contract is dependency injection for a
 * subsequently verified implementation or isolated tests, never an env switch.
 */
export class OrangeXReadOnlyAdapter {
 #fetch;#clock;#sleep;#clientId;#clientSecret;#token=null;#refreshToken=null;#expiresAt=0;
 #authPending=null;#refreshPending=null;#id=0;#lastRequestAt=0;#cooldownUntil=0;#snapshot;#contract;
 constructor({enabled=false,mode='READ_ONLY',clientId='',clientSecret='',
  instruments=['BTC-USDT-PERPETUAL','ETH-USDT-PERPETUAL','SOL-USDT-PERPETUAL'],
  fetcher=globalThis.fetch,now=()=>Date.now(),sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms)),
  timeoutMs=8000,maxRetries=1,minIntervalMs=100,maxQuoteAgeMs=90000,refreshIntervalMs=30000,contract=null}={}){
  if(mode!=='READ_ONLY')throw new OrangeXError('MODE_NOT_ALLOWED');
  if(typeof enabled!=='boolean'||typeof fetcher!=='function'||typeof now!=='function'||typeof sleep!=='function'||
   !Array.isArray(instruments)||!instruments.length||instruments.length>10||!instruments.every(instrument)||
   !Number.isInteger(timeoutMs)||timeoutMs<100||timeoutMs>30000||!Number.isInteger(maxRetries)||maxRetries<0||maxRetries>2||
   !Number.isInteger(minIntervalMs)||minIntervalMs<0||minIntervalMs>5000||!Number.isInteger(maxQuoteAgeMs)||maxQuoteAgeMs<1000||
   !Number.isInteger(refreshIntervalMs)||refreshIntervalMs<1000||refreshIntervalMs>3600000||
   typeof clientId!=='string'||typeof clientSecret!=='string')throw new OrangeXError('INVALID_CONFIG');
  this.enabled=enabled;this.mode='READ_ONLY';this.instruments=Object.freeze([...new Set(instruments)]);
  this.timeoutMs=timeoutMs;this.maxRetries=maxRetries;this.minIntervalMs=minIntervalMs;this.maxQuoteAgeMs=maxQuoteAgeMs;
  this.refreshIntervalMs=refreshIntervalMs;
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
  for(const market of snapshot.markets)market.fresh=market.priceAt!==null&&market.priceAt<=now+5000&&now-market.priceAt<=this.maxQuoteAgeMs;
  return {enabled:this.enabled,mode:'READ_ONLY',...snapshot,accountStatus:this.#clientId&&this.#clientSecret?'unverified':'not_configured',account:null,
   authentication:this.#authentication(),rateLimit:{blocked:now<this.#cooldownUntil,retryAfterAt:Number.isFinite(this.#cooldownUntil)&&this.#cooldownUntil>now?this.#cooldownUntil:null},
   capabilities:{marketData:true,accountRead:false,instruments:false,positions:false,openOrders:false,trades:false,
    oauth:this.#contract.authVerified,oauthImplemented:true,orderSubmission:false,websocket:false},
   automation:{enabled:false,canEnable:false,killSwitch:'NOT_IMPLEMENTED',reason:'1단계 조회 전용'},
   verification:{officialSpec:this.#contract.authVerified?'VERIFIED_FOR_INJECTED_AUTH_CONTRACT':'UNVERIFIED',
    protocolReference:'SDK_SOURCE_ONLY',reference:REFERENCE,sourceOwnership:'UNVERIFIED',
    liveConnection:this.#snapshot.checkedAt===null?'UNTESTED':this.#snapshot.connected?'CONNECTED':this.enabled?'BLOCKED':'UNTESTED'},
   warnings:['조회 프로토콜은 공개 SDK 소스 참조이며 공식 문서·실제 응답 검증을 대체하지 않습니다.',
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
  if(!((path===BOOK&&method==='GET'&&!auth)||(path===AUTH&&auth&&['GET','POST'].includes(method))))throw new OrangeXError('UNSUPPORTED_OPERATION');
  const requestId=String(++this.#id),url=new URL(API+path),headers={accept:'application/json'};
  let body;
  if(method==='GET')for(const [key,value] of Object.entries(params))url.searchParams.set(key,String(value));
  else{headers['content-type']='application/json';body=JSON.stringify({jsonrpc:'2.0',id:requestId,method:path,params})}
  const attempts=auth?0:this.maxRetries;
  for(let attempt=0;attempt<=attempts;attempt++){
   const wait=this.minIntervalMs-(this.#clock()-this.#lastRequestAt);if(wait>0)await this.#sleep(wait);
   this.#lastRequestAt=this.#clock();
   const controller=new AbortController();let timer;
   try{
    const timedOut=new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new OrangeXError('REQUEST_TIMEOUT'))},this.timeoutMs)});
    const response=await Promise.race([this.#fetch(url.href,{method,headers,body,redirect:'error',signal:controller.signal}),timedOut]);
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
    catch(error){if(error instanceof OrangeXError)throw error;throw new OrangeXError(controller.signal.aborted?'REQUEST_TIMEOUT':'INVALID_RESPONSE')}
    if(!envelope||typeof envelope!=='object'||Array.isArray(envelope)||envelope.error)throw new OrangeXError(envelope?.error?'API_ERROR':'INVALID_RESPONSE');
    if(envelope.jsonrpc!==undefined&&envelope.jsonrpc!=='2.0')throw new OrangeXError('INVALID_RESPONSE');
    if(method==='POST'&&String(envelope.id)!==requestId)throw new OrangeXError('INVALID_RESPONSE');
    if(!Object.hasOwn(envelope,'result')||!envelope.result||typeof envelope.result!=='object')throw new OrangeXError('INVALID_RESPONSE');
    return envelope.result;
   }catch(error){
    if(error instanceof OrangeXError)throw error;
    // Never reuse the provider's exception text: it can contain an auth URL,
    // response body, client secret, access token or refresh token.
    throw new OrangeXError(controller.signal.aborted?'REQUEST_TIMEOUT':'NETWORK_ERROR');
   }finally{clearTimeout(timer)}
  }
 }
 #commitToken(result){
  const lifetime=positive(result?.expires_in),token=result?.access_token,refresh=result?.refresh_token;
  const validToken=value=>typeof value==='string'&&value.length>0&&value.length<=16384&&!/[\s\u0000-\u001f\u007f]/.test(value);
  if(!validToken(token)||!lifetime||!Number.isFinite(lifetime*1000)||
   refresh!==undefined&&refresh!==null&&!validToken(refresh))throw new OrangeXError('TOKEN_RESPONSE_INVALID');
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
  if(result.instrument_name!==undefined&&result.instrument_name!==instrumentName)throw new OrangeXError('INVALID_RESPONSE');
  const levels=rows=>{
   if(!Array.isArray(rows)||!rows.length||rows.length>10000)throw new OrangeXError('INVALID_RESPONSE');
   return rows.map(row=>{
    if(!Array.isArray(row)||row.length!==2||!positive(row[0])||!positive(row[1]))throw new OrangeXError('INVALID_RESPONSE');
    return [Number(row[0]),Number(row[1])];
   });
  };
  const bids=levels(result.bids).sort((a,b)=>b[0]-a[0]),asks=levels(result.asks).sort((a,b)=>a[0]-b[0]);
  const bid=bids[0][0],ask=asks[0][0];if(bid>=ask)throw new OrangeXError('INVALID_RESPONSE');
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
 async listInstruments(){throw new OrangeXError('UNSUPPORTED_OPERATION')}
 async readAccount(){throw new OrangeXError('SPEC_UNVERIFIED')}
 async getPositions(){throw new OrangeXError('SPEC_UNVERIFIED')}
 async getOpenOrders(){throw new OrangeXError('SPEC_UNVERIFIED')}
 async getTrades(){throw new OrangeXError('SPEC_UNVERIFIED')}
 async refresh(){
  if(!this.enabled)return this.getStatus();
  if(this.#refreshPending)return this.#refreshPending;
  this.#refreshPending=(async()=>{
   const markets=[],errors=[];
   for(const requested of this.instruments){
    try{markets.push(await this.getOrderBook(requested))}
    catch(error){const safe=error instanceof OrangeXError?error:new OrangeXError('NETWORK_ERROR');errors.push({code:safe.code,message:safe.message,at:this.#clock(),instrumentName:requested})}
   }
   this.#snapshot={connected:markets.length>0,checkedAt:this.#clock(),marketStatus:markets.length===this.instruments.length?'connected':markets.length?'partial':'offline',markets,errors};
   return this.getStatus();
  })();
  try{return await this.#refreshPending}finally{this.#refreshPending=null}
 }
}
