/** OrangeX adapter (preflight only). No live order writes are exposed.
 * Official API: https://openapi-docs.orangex.com/
 */
import {createHmac,randomBytes,createHash} from 'node:crypto';
export const ORANGEX_API='https://api.orangex.com/api/v1';
const READ_METHODS=new Set(['/private/get_positions','/private/get_order_state']);
const positive=x=>{const n=Number(x);return Number.isFinite(n)&&n>0?n:NaN};
export function orangeXInstrument(symbol){
 const m=/^([A-Z0-9]+)USDT$/.exec(String(symbol||''));
 if(!m)throw Error('OrangeX: unsupported Binance USDT symbol');
 return m[1]+'-USDT-PERPETUAL';
}
export function verifiedOrangeXInstrument(symbol,instruments){
 const name=orangeXInstrument(symbol);
 if(!Array.isArray(instruments)||!instruments.some(x=>x?.instrument_name===name&&x?.is_active===true&&x?.kind==='perpetual'))
  throw Error('OrangeX: active perpetual contract not verified');
 return name;
}
export function examineOrangeXBook(data,{now=Date.now(),maxAgeMs=10000,maxSpreadBps=15}={}){
 data=data?.result??data;
 const bid=positive(data?.bids?.[0]?.[0]),ask=positive(data?.asks?.[0]?.[0]);
 const bidSize=positive(data?.bids?.[0]?.[1]),askSize=positive(data?.asks?.[0]?.[1]),timestamp=Number(data?.timestamp);
 if(![bid,ask,bidSize,askSize].every(Number.isFinite)||bid>=ask)throw Error('OrangeX: missing or crossed book');
 if(!Number.isFinite(timestamp)||timestamp<=0||timestamp>now+1000||now-timestamp>maxAgeMs)throw Error('OrangeX: stale book');
 const spreadBps=10000*(ask-bid)/((ask+bid)/2);
 if(spreadBps>maxSpreadBps)throw Error('OrangeX: spread too wide');
 return {bid,ask,bidSize,askSize,spreadBps,timestamp};
}
export function makeOrangeXOrderPlan({signal,binancePrice,binancePriceAt,orangexBook,instruments,
 now=Date.now(),maxPriceAgeMs=15000,maxBasisBps=30,maxNotionalUSDT=100,maxRiskUSDT=2,maxSlippageBps=10}={}){
 if(signal?.score!==100||signal?.technicalQualified!==true||signal?.status!=='signal'||signal?.qualified!==true)
  throw Error('OrangeX: only fully qualified final signals may be planned');
 if(!['LONG','SHORT'].includes(signal.direction))throw Error('OrangeX: invalid direction');
 const confirmed=Number(signal.patternConfirmedAt);
 if(!Number.isFinite(confirmed)||confirmed<=0||confirmed>now||now-confirmed>75*60000)
  throw Error('OrangeX: stale or unconfirmed candle');
 const price=positive(binancePrice),priceAt=Number(binancePriceAt);
 if(!Number.isFinite(price)||!Number.isFinite(priceAt)||priceAt>now||now-priceAt>maxPriceAgeMs)
  throw Error('OrangeX: stale Binance price');
 const instrument_name=verifiedOrangeXInstrument(signal.symbol,instruments);
 const book=examineOrangeXBook(orangexBook,{now}),quote=signal.direction==='LONG'?book.ask:book.bid;
 const basisBps=10000*Math.abs(quote-price)/price;
 if(basisBps>maxBasisBps)throw Error('OrangeX: cross-exchange basis too wide');
 const stop=positive(signal.stop),target=positive(signal.target1);
 if(!Number.isFinite(stop)||!Number.isFinite(target)||!(signal.direction==='LONG'?stop<quote&&target>quote:stop>quote&&target<quote))
  throw Error('OrangeX: stop and target invalid at current quote');
 const limit=positive(maxNotionalUSDT),risk=positive(maxRiskUSDT);
 if(!Number.isFinite(limit)||!Number.isFinite(risk)||limit>100||risk>2)throw Error('OrangeX: preview caps exceeded');
 if(!Number.isFinite(maxSlippageBps)||maxSlippageBps<0||maxSlippageBps>10)throw Error('OrangeX: bad slippage limit');
 const buffer=quote*maxSlippageBps/10000,notional=Math.min(limit,risk/((Math.abs(quote-stop)+buffer)/quote));
 const qty=notional/quote;
 if((signal.direction==='LONG'?book.askSize:book.bidSize)<qty)throw Error('OrangeX: insufficient best-level depth');
 const inst=instruments.find(x=>x.instrument_name===instrument_name);
 if(positive(inst.contract_size)!==1)throw Error('OrangeX: contract unit conversion must be verified');
 const step=positive(inst.min_trade_amount),minQty=positive(inst.min_qty),tick=positive(inst.tick_size);
 if(![step,minQty,tick].every(Number.isFinite))throw Error('OrangeX: unknown contract increments');
 const amount=Number((Math.floor(qty/step)*step).toPrecision(12));
 if(amount<minQty)throw Error('OrangeX: below minimum quantity');
 const rawLimit=signal.direction==='LONG'?quote+buffer:quote-buffer;
 const limitPrice=Number(((signal.direction==='LONG'?Math.ceil(rawLimit/tick):Math.floor(rawLimit/tick))*tick).toPrecision(12));
 const key=[signal.symbol,signal.direction,signal.pattern,signal.time].join('|');
 const custom_order_id='sl_'+createHash('sha256').update(key).digest('hex').slice(0,28);
 return {previewOnly:true,instrument_name,basisBps,spreadBps:book.spreadBps,notionalUSDT:amount*quote,
  method:signal.direction==='LONG'?'/private/buy':'/private/sell',
  params:{instrument_name,amount:String(amount),type:'limit',price:String(limitPrice),
    time_in_force:'immediate_or_cancel',position_side:'BOTH',reduce_only:false,post_only:false,
    stop_loss_price:String(stop),stop_loss_type:1,custom_order_id},
  warning:'PREVIEW ONLY: NOT submitted. Position mode, leverage, protective orders and order fill must be verified before live trading.'};
}
export function orangeXSignature({clientId,clientSecret,timestamp,nonce}){
 if(!clientId||!clientSecret||!timestamp||!nonce)throw Error('OrangeX: missing auth input');
 return createHmac('sha256',clientSecret).update(clientId+'\n'+timestamp+'\n'+nonce+'\n').digest('hex');
}
export class OrangeXClient {
 constructor({clientId='',clientSecret='',transport=fetch,clock=Date.now}={}){
  this.clientId=clientId;this.clientSecret=clientSecret;this.transport=transport;this.clock=clock;
  this.token=null;this.expiresAt=0;
 }
 async rpc(method,params={},token=null){
  if(!/^\/(?:public|private)\/[a-z_]+$/.test(method))throw Error('OrangeX: bad RPC method');
  if(method.startsWith('/private/')&&!READ_METHODS.has(method))throw Error('OrangeX: live write requests are disabled');
  if(method.startsWith('/private/')&&!token)throw Error('OrangeX: auth required');
  const headers={'Content-Type':'application/json'};
  if(token)headers.Authorization='Bearer '+token;
  const response=await this.transport(ORANGEX_API,{method:'POST',headers,body:JSON.stringify({jsonrpc:'2.0',id:String(this.clock()),method,params}),signal:AbortSignal.timeout(10000)});
  if(!response.ok)throw Error('OrangeX API HTTP '+response.status);
  const body=await response.json();
  if(body?.error)throw Error('OrangeX RPC error '+String(body.error.code??'unknown'));
  if(!Object.prototype.hasOwnProperty.call(body||{},'result'))throw Error('OrangeX: invalid JSON-RPC response');
  return body.result;
 }
 async authenticate(){
  if(!this.clientId||!this.clientSecret)throw Error('OrangeX: missing API credentials');
  const timestamp=String(this.clock()),nonce=randomBytes(16).toString('hex');
  const signature=orangeXSignature({clientId:this.clientId,clientSecret:this.clientSecret,timestamp,nonce});
  const data=await this.rpc('/public/auth',{grant_type:'client_signature',client_id:this.clientId,timestamp,nonce,signature,scope:'trade:read'});
  if(!data?.access_token||!Number.isFinite(Number(data.expires_in))||!String(data.scope||'').includes('trade:read'))
   throw Error('OrangeX: read-only trading permission unavailable');
  this.token=data.access_token;this.expiresAt=this.clock()+Number(data.expires_in)*1000-30000;
  return {authenticated:true,scope:data.scope,expiresAt:this.expiresAt};
 }
 async read(method,params={}){
  if(!this.token||this.clock()>=this.expiresAt)await this.authenticate();
  return this.rpc(method,params,this.token);
 }
 async orderBook(instrument_name){
  if(!/^[A-Z0-9]+-USDT-PERPETUAL$/.test(String(instrument_name)))throw Error('OrangeX: invalid perp contract');
  return this.rpc('/public/get_order_book',{instrument_name,depth:5});
 }
 async instruments(){return this.rpc('/public/get_instruments',{currency:'PERPETUAL',kind:'perpetual'})}
 async positions(){return this.read('/private/get_positions',{currency:'PERPETUAL',kind:'perpetual'})}
 async orderState(id){
  if(!/^\d+$/.test(String(id)))throw Error('OrangeX: invalid order id');
  return this.read('/private/get_order_state',{order_id:String(id)});
 }
}
