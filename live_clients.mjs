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

// A local refusal is distinct from an unknown exchange response: the caller may release its reservation.
function checkOrderDispatch(beforeSend){
 const reason=beforeSend?.();
 if(reason)throw Object.assign(Error(reason),{code:'ENTRY_NOT_SENT',reason});
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
  this.request=async(method,path,params={},retried=false,beforeSend)=>{
   if(method==='GET')while(cooldownUntil>Date.now())await sleep(cooldownUntil-Date.now());
   await slot(method==='GET'?0:3000);
   checkOrderDispatch(beforeSend);
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
    if(method!=='GET'&&tries<2){await sleep(Math.min(cooldownUntil-Date.now(),10000));return this.request(method,path,params,tries+1,beforeSend)}
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
 async income({symbol,startTime,endTime,limit=1000}={}){
  const rows=await this.request('GET','/openApi/swap/v2/user/income',defined({symbol,startTime,endTime,limit}));
  return rows===null?[]:rows; // An explicit null on a successful empty window; a missing data field stays invalid.
 }
 marginType(symbol){return this.request('GET','/openApi/swap/v2/trade/marginType',{symbol})}
 setMarginType(symbol,marginType){return this.request('POST','/openApi/swap/v2/trade/marginType',{symbol,marginType})}
 leverage(symbol){return this.request('GET','/openApi/swap/v2/trade/leverage',{symbol})}
 setLeverage(symbol,side,leverage){return this.request('POST','/openApi/swap/v2/trade/leverage',{symbol,side,leverage})}
 placeOrder(params,{beforeSend}={}){return this.request('POST','/openApi/swap/v2/trade/order',params,false,beforeSend)}
 testOrder(params){return this.request('POST','/openApi/swap/v2/trade/order/test',params)}
 openOrders(symbol){return this.request('GET','/openApi/swap/v2/trade/openOrders',symbol?{symbol}:{})}
 getOrder(symbol,{orderId,clientOrderId}){return this.request('GET','/openApi/swap/v2/trade/order',{symbol,...(orderId?{orderId}:{clientOrderId})})}
 cancelOrder(symbol,orderId){return this.request('DELETE','/openApi/swap/v2/trade/order',{symbol,orderId})}
 // Read only (copy: why a position vanished, review 2026-11-17): liquidation / ADL orders, and the order history.
 forceOrders({symbol,autoCloseType,startTime,endTime,limit=50}={}){return this.request('GET','/openApi/swap/v2/trade/forceOrders',defined({symbol,autoCloseType,startTime,endTime,limit}))}
 allOrders({symbol,startTime,endTime,limit=500}={}){return this.request('GET','/openApi/swap/v2/trade/allOrders',defined({symbol,startTime,endTime,limit}))}
 /** USDT fills across symbols, or for one exact order (read only). */
 fillOrders({startTs,endTs,orderId}){
  return this.request('GET','/openApi/swap/v2/trade/allFillOrders',defined({tradingUnit:'COIN',currency:'USDT',startTs,endTs,orderId}));
 }
 async fillHistory({symbol,startTs,endTs}){
  const rows=[],pageSize=100;
  for(let pageIndex=1;pageIndex<=4;pageIndex++){
   const data=await this.request('GET','/openApi/swap/v2/trade/fillHistory',{symbol,startTs,endTs,pageIndex,pageSize,currency:'USDT'});
   if(data===null||data?.fill_orders===null||data?.fillOrders===null)return rows;
   const page=data?.fill_orders??data?.fillOrders??(Array.isArray(data)?data:null);
   if(!Array.isArray(page))throw Error('UNEXPECTED_FILL_HISTORY');
   rows.push(...page);
   if(page.length<pageSize)return rows;
  }
  throw Error('INCOMPLETE_FILL_HISTORY');
 }
}
const defined=o=>Object.fromEntries(Object.entries(o).filter(([,v])=>v!==undefined&&v!==null&&v!==''));

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
  this.request=async(method,path,{query={},body,beforeSend}={})=>{
   checkOrderDispatch(beforeSend);
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
 placeOrder(order,{beforeSend}={}){return this.request('POST','/futures/usdt/orders',{body:order,beforeSend})}
 getOrder(id){return this.request('GET','/futures/usdt/orders/'+encodeURIComponent(id))}
 cancelOrder(id){return this.request('DELETE','/futures/usdt/orders/'+encodeURIComponent(id))}
 placeTrigger(order){return this.request('POST','/futures/usdt/price_orders',{body:order})}
 cancelTrigger(id){return this.request('DELETE','/futures/usdt/price_orders/'+encodeURIComponent(id))}
}

// BingX read-only execution receipts. Missing quantity or costs never become zero.
const number=v=>v==null||String(v).trim()===''||!Number.isFinite(Number(v))?null:Number(v);
const id=v=>v==null||String(v).trim()===''?null:String(v);
const fillTime=row=>{
 for(const value of [row?.time,row?.tradeTime,row?.filledTm,row?.filledTime]){
  const numeric=number(value);
  if(numeric>0)return numeric>=1e9&&numeric<1e11?numeric*1000:numeric;
  if(typeof value==='string'&&/(?:Z|[+-]\d{2}:?\d{2})$/i.test(value)){const at=Date.parse(value);if(at>0)return at}
 }
 return null;
};
const fillQty=row=>number(row?.qty??row?.filledQty??row?.volume);
const fillPnl=row=>number(row?.realizedPnl??row?.realizedPnL??row?.profit);
const fillFee=row=>number(row?.fee??row?.commission);
const qtyEqual=(a,b)=>Math.abs(a-b)<=Math.max(1e-12,Math.max(a,b)*1e-8);

function fillRows(response){
 if(response===null||response?.fill_orders===null||response?.fillOrders===null)return [];
 const rows=Array.isArray(response)?response:response?.fill_orders??response?.fillOrders;
 if(!Array.isArray(rows))throw Error('UNEXPECTED_FILL_HISTORY');
 return rows;
}

export function executionFills(response){
 const rows=fillRows(response),seenRaw=new Map();
 const fills=new Map();
 for(const x of rows){
  const orderId=id(x?.orderId??x?.orderID);
  const symbol=x?.symbol,side=String(x?.side??'').toUpperCase(),positionSide=String(x?.positionSide??'').toUpperCase();
  const qty=fillQty(x),price=number(x?.price??x?.tradePrice),at=fillTime(x),fee=fillFee(x);
  if(!orderId||typeof symbol!=='string'||!symbol||!['BUY','SELL'].includes(side)||!(qty>0)||!(price>0)||!(at>0))throw Error('UNEXPECTED_FILL_ROW');
  let tradeId=id(x?.tradeId??x?.fillId);
  if(!tradeId){const fingerprint=[orderId,at,qty,price,fee].join(':');const ordinal=(seenRaw.get(fingerprint)??0)+1;seenRaw.set(fingerprint,ordinal);tradeId=`fill:${fingerprint}:${ordinal}`}
  fills.set(`${symbol}|${tradeId}`,{tradeId,orderId,symbol,side,positionSide,qty,price,at,
   pnl:fillPnl(x),fee,wholeOrderQty:x.wholeOrderQty??null});
 }
 return [...fills.values()].sort((a,b)=>a.at-b.at||a.tradeId.length-b.tradeId.length||a.tradeId.localeCompare(b.tradeId));
}

/** Some fill responses omit direction, fill IDs or P&L. Order-level P&L is usable only for the entire order. */
export async function confirmedBingxFills(client,response,{symbol=null,orders=null}={}){
 const groups=new Map();
 for(const row of fillRows(response)){
  const orderId=id(row?.orderId??row?.orderID);
  if(orders&&!orders.has(orderId))continue;
  if(!orderId)throw Error('UNEXPECTED_FILL_ROW');
  const group=groups.get(orderId)??[];group.push({...row,orderId,symbol:row.symbol??symbol});groups.set(orderId,group);
 }
 const complete=[];
 for(const [orderId,rows] of groups){
  const known=orders?.get(orderId),venueSymbol=rows[0].symbol;
  if(!venueSymbol||rows.some(r=>r.symbol!==venueSymbol))throw Error('UNEXPECTED_FILL_ROW');
  const missingSide=rows.some(r=>!r.side),missingPnl=rows.some(r=>fillPnl(r)===null),missingFee=rows.some(r=>fillFee(r)===null);
  let order=known?.order??null;
  if(!order&&(missingSide&&!known?.side||missingPnl||missingFee)&&typeof client?.getOrder==='function')try{
   const data=await client.getOrder(venueSymbol,{orderId});order=data?.order??data;
  }catch{}
  if(String(order?.orderId??order?.orderID)!==orderId||order?.symbol!==venueSymbol)order=null;
  const side=String(order?.side??known?.side??'').toUpperCase();
  if(side&&rows.some(r=>r.side&&String(r.side).toUpperCase()!==side))throw Error('FILL_ORDER_SIDE_MISMATCH');
  for(const row of rows){row.side=row.side||side;row.positionSide=row.positionSide||order?.positionSide}
  const executed=number(order?.executedQty),qty=rows.reduce((sum,r)=>sum+(fillQty(r)??0),0);
  if(executed>0&&qtyEqual(executed,qty)&&['FILLED','CANCELED','CANCELLED','EXPIRED'].includes(String(order?.status).toUpperCase())){
   const pnl=fillPnl(order),fee=fillFee(order),usePnl=missingPnl&&pnl!==null,useFee=missingFee&&fee!==null;
   if(usePnl||useFee){
    const last=rows.reduce((a,b)=>fillTime(a)>fillTime(b)?a:b);
    for(const row of rows){if(usePnl)row.realizedPnl=row===last?pnl:0;if(useFee)row.fee=row===last?fee:0;row.wholeOrderQty=executed}
   }
  }
  complete.push(...rows);
 }
 return executionFills(complete);
}

export function completeBingxOrders(fills){
 const whole=new Map();
 for(const f of fills)if(f.wholeOrderQty!=null)whole.set(f.orderId,f.wholeOrderQty);
 for(const [id,qty] of whole){
  const first=fills.findIndex(f=>f.orderId===id),last=fills.findLastIndex(f=>f.orderId===id),span=fills.slice(first,last+1);
  if(span.some(f=>f.orderId!==id)||!qtyEqual(span.reduce((sum,f)=>sum+f.qty,0),qty))return false;
 }
 return true;
}

export function summarizeBalancedFills(fills,direction){
 if(!completeBingxOrders(fills))return null;
 const side=direction==='SHORT'?'SELL':'BUY';
 let openQty=0,closeQty=0,entryValue=0,pnlUSD=0,feeUSD=0;
 for(const fill of fills){
  if(fill.fee===null||fill.side!==side&&fill.pnl===null)return null;
  if(fill.side===side){openQty+=fill.qty;entryValue+=fill.qty*fill.price}
  else{closeQty+=fill.qty}
  if(closeQty>openQty+Math.max(1e-9,openQty*1e-8))return null;
  pnlUSD+=fill.pnl??0;feeUSD+=fill.fee;
 }
 if(!(openQty>0&&closeQty>0)||Math.abs(openQty-closeQty)>Math.max(1e-9,openQty*1e-8))return null;
 const round=x=>+x.toFixed(8);
 return {qty:openQty,avg:entryValue/openQty,pnlUSD:round(pnlUSD),feeUSD:round(feeUSD),netUSD:round(pnlUSD+feeUSD)};
}
