// Signed REST clients for live/testnet futures trading on BingX and Gate.io.
// Secrets live only inside these objects: they are never returned, logged or
// included in error messages. Hosts are fixed per mode; nothing else is reachable.
import {createHmac,createHash} from 'node:crypto';
import {readLimitedJSON,VenueHttpError} from './bingx_market.mjs';

export const LIVE_HOSTS=Object.freeze({
 BINGX:{LIVE:'https://open-api.bingx.com',TESTNET:'https://open-api-vst.bingx.com'},
 // Gate.io TestNet (official APIv4 docs): api-testnet.gateapi.io; the old fx-api-testnet host is retired.
 GATEIO:{LIVE:'https://api.gateio.ws',TESTNET:'https://api-testnet.gateapi.io'}
});
const clean=message=>String(message??'').replace(/[A-Za-z0-9]{24,}/g,'[redacted]').slice(0,200);

// ---- BingX ---------------------------------------------------------------------
/** Official procedure: all params sorted by key (ASCII), joined unencoded as
 * key=value&..., HMAC-SHA256 with the secret, lowercase hex. */
export function bingxSignatureString(params){
 return Object.keys(params).sort().map(key=>`${key}=${params[key]}`).join('&');
}
export function bingxSign(params,secret){return createHmac('sha256',secret).update(bingxSignatureString(params)).digest('hex')}
/** URL query: values with [ or { are percent-encoded; the signature uses raw values. */
function bingxQuery(params,signature){
 const raw=bingxSignatureString(params),needs=/[[{]/.test(raw);
 const parts=Object.keys(params).sort().map(key=>`${key}=${needs?encodeURIComponent(String(params[key])):params[key]}`);
 return parts.join('&')+'&signature='+signature;
}

export class BingXTradeClient{
 constructor({apiKey,secret,mode='TESTNET',fetcher=globalThis.fetch,now=Date.now,timeoutMs=10000,recvWindow=5000}={}){
  if(!['LIVE','TESTNET'].includes(mode))throw Error('LIVE_MODE_INVALID');
  if(!apiKey||!secret)throw Error('LIVE_CREDENTIALS_MISSING');
  const host=LIVE_HOSTS.BINGX[mode];
  // Keep the secret in a closure, not on the instance.
  // BingX limits request rates per key: signed calls go out one at a time with a small gap, and an
  // HTTP 429 pauses every call for the time the venue asks (Retry-After, else 10 s). A read (GET)
  // is tried once more after the pause; an order refused with 429 (not taken) is sent again up to twice.
  let chain=Promise.resolve(),last=0,cooldownUntil=0;
  // Gap between signed calls: BINGX_MIN_INTERVAL_MS, else 250 ms (0 with an injected test transport).
  const envGap=process.env.BINGX_MIN_INTERVAL_MS,gapMs=envGap!==undefined&&envGap!==''&&Number(envGap)>=0?Number(envGap):fetcher===globalThis.fetch?250:0;
  const sleep=ms=>ms>0?new Promise(r=>setTimeout(r,ms)):Promise.resolve();
  // A read (GET) waits out a 429 pause before it joins the queue, so it never holds the queue;
  // an order (POST) inside the queue waits at most 3 s of a pause, so a stop or an emergency close
  // is not held back. If the venue still refuses, the caller sees HTTP_429 and handles it.
  const slot=maxPause=>{const p=chain.then(async()=>{await sleep(Math.max(Math.min(cooldownUntil-Date.now(),maxPause),last+gapMs-Date.now()));last=Date.now()});chain=p.catch(()=>{});return p};
  this.request=async(method,path,params={},retried=false)=>{
   if(method==='GET')while(cooldownUntil>Date.now())await sleep(cooldownUntil-Date.now());
   await slot(method==='GET'?0:3000);
   const signed={...params,recvWindow,timestamp:now()};
   const url=`${host}${path}?${bingxQuery(signed,bingxSign(signed,secret))}`;
   let response;
   try{response=await fetcher(url,{method,redirect:'error',signal:AbortSignal.timeout(timeoutMs),headers:{'X-BX-APIKEY':apiKey,Accept:'application/json'}})}
   catch(error){throw new VenueHttpError('NETWORK_UNREACHABLE',clean(error?.message))}
   if(response.status===429){ // checked before the body: a 429 page is often not JSON
    const after=Number(response.headers?.get?.('retry-after'));cooldownUntil=Date.now()+(after>0&&after<120?after*1000:10000);
    if(method==='GET'&&!retried)return this.request(method,path,params,true);
    // A 429 means the venue did not take the order, so an order (often a stop or an emergency
    // close) is sent again up to twice, each time after the pause (at most 10 s of it).
    const tries=Number(retried)||0;
    if(method!=='GET'&&tries<2){await sleep(Math.min(cooldownUntil-Date.now(),10000));return this.request(method,path,params,tries+1)}
    let msg='';try{msg=(await readLimitedJSON(response,200_000))?.msg}catch{}
    throw new VenueHttpError('HTTP_429',clean(msg));
   }
   const body=await readLimitedJSON(response,2_000_000,{bigIds:true});
   if(!response.ok)throw new VenueHttpError('HTTP_'+response.status,clean(body?.msg));
   if(body?.code!==0)throw new VenueHttpError('VENUE_ERROR_'+String(body?.code??'UNKNOWN').slice(0,12),clean(body?.msg));
   return body.data;
  };
  this.mode=mode;this.venue='BINGX';
 }
 positionMode(){return this.request('GET','/openApi/swap/v1/positionSide/dual')}
 balance(){return this.request('GET','/openApi/swap/v3/user/balance')}
 positions(symbol){return this.request('GET','/openApi/swap/v2/user/positions',symbol?{symbol}:{})}
 /** Fund flow (read only): realized PnL, trading fees and funding rows, for the closed-trade result. */
 income({symbol,startTime,endTime,limit=1000}={}){return this.request('GET','/openApi/swap/v2/user/income',Object.fromEntries(Object.entries({symbol,startTime,endTime,limit}).filter(([,v])=>v!==undefined&&v!==null&&v!=='')))}
 marginType(symbol){return this.request('GET','/openApi/swap/v2/trade/marginType',{symbol})}
 setMarginType(symbol,marginType){return this.request('POST','/openApi/swap/v2/trade/marginType',{symbol,marginType})}
 leverage(symbol){return this.request('GET','/openApi/swap/v2/trade/leverage',{symbol})}
 setLeverage(symbol,side,leverage){return this.request('POST','/openApi/swap/v2/trade/leverage',{symbol,side,leverage})}
 placeOrder(params){return this.request('POST','/openApi/swap/v2/trade/order',params)}
 testOrder(params){return this.request('POST','/openApi/swap/v2/trade/order/test',params)}
 openOrders(symbol){return this.request('GET','/openApi/swap/v2/trade/openOrders',{symbol})}
 getOrder(symbol,{orderId,clientOrderId}){return this.request('GET','/openApi/swap/v2/trade/order',{symbol,...(orderId?{orderId}:{clientOrderId})})}
 cancelOrder(symbol,orderId){return this.request('DELETE','/openApi/swap/v2/trade/order',{symbol,orderId})}
}

// ---- Gate.io -------------------------------------------------------------------
/** Official SDK (gen_sign): METHOD\nPATH\nQUERY\nhex(SHA512(body))\nTIMESTAMP,
 * HMAC-SHA512 with the secret, hex. Headers KEY, Timestamp, SIGN. */
export function gateSignatureString({method,path,query='',body='',timestamp}){
 return `${method}\n${path}\n${query}\n${createHash('sha512').update(body).digest('hex')}\n${timestamp}`;
}
export function gateSign(parts,secret){return createHmac('sha512',secret).update(gateSignatureString(parts)).digest('hex')}

export class GateTradeClient{
 constructor({apiKey,secret,mode='TESTNET',fetcher=globalThis.fetch,now=Date.now,timeoutMs=10000}={}){
  if(!['LIVE','TESTNET'].includes(mode))throw Error('LIVE_MODE_INVALID');
  if(!apiKey||!secret)throw Error('LIVE_CREDENTIALS_MISSING');
  const host=LIVE_HOSTS.GATEIO[mode];
  this.request=async(method,path,{query={},body}={})=>{
   const fullPath='/api/v4'+path,search=new URLSearchParams(query).toString(),payload=body===undefined?'':JSON.stringify(body);
   const timestamp=String(Math.floor(now()/1000));
   const SIGN=gateSign({method,path:fullPath,query:decodeURIComponent(search.replace(/\+/g,' ')),body:payload,timestamp},secret);
   let response;
   try{response=await fetcher(host+fullPath+(search?'?'+search:''),{method,redirect:'error',signal:AbortSignal.timeout(timeoutMs),
    headers:{KEY:apiKey,Timestamp:timestamp,SIGN,Accept:'application/json',...(payload?{'Content-Type':'application/json'}:{})},...(payload?{body:payload}:{})})}
   catch(error){throw new VenueHttpError('NETWORK_UNREACHABLE',clean(error?.message))}
   const data=response.status===204?null:await readLimitedJSON(response,2_000_000);
   if(!response.ok)throw new VenueHttpError('HTTP_'+response.status,clean(data?.label??data?.message));
   return data;
  };
  this.mode=mode;this.venue='GATEIO';
 }
 account(){return this.request('GET','/futures/usdt/accounts')}
 position(contract){return this.request('GET','/futures/usdt/positions/'+encodeURIComponent(contract))}
 /** Cross margin: leverage=0 with cross_leverage_limit = the cross leverage. */
 setCrossLeverage(contract,leverage){return this.request('POST','/futures/usdt/positions/'+encodeURIComponent(contract)+'/leverage',{query:{leverage:'0',cross_leverage_limit:String(leverage)}})}
 placeOrder(order){return this.request('POST','/futures/usdt/orders',{body:order})}
 getOrder(id){return this.request('GET','/futures/usdt/orders/'+encodeURIComponent(id))}
 cancelOrder(id){return this.request('DELETE','/futures/usdt/orders/'+encodeURIComponent(id))}
 placeTrigger(order){return this.request('POST','/futures/usdt/price_orders',{body:order})}
 cancelTrigger(id){return this.request('DELETE','/futures/usdt/price_orders/'+encodeURIComponent(id))}
}
