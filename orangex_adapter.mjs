/** OrangeX read-only protocol adapter and non-executable preflight intents.
 * Official semantics must be reviewed per product; a numeric contract_size is
 * not a quantity-unit proof. No write RPC, cancellation or leverage API exists.
 */
import {createHmac,randomBytes,createHash} from 'node:crypto';
import {orangeXBookIntegrity} from './orangex_listing_domains.mjs';
import {roundOrangeXDecimal} from './orangex_contract_validation.mjs';
import {isVolumeStepAligned,splitVolumeQuantity} from './volume_profile.mjs';
import {FINAL_MIN_SCORE} from './signal_policy.mjs';
export const ORANGEX_API='https://api.orangex.com/api/v1';
const READ_METHODS=new Set(['/private/get_positions','/private/get_order_state']);
const PUBLIC_METHODS=new Set(['/public/auth','/public/get_order_book','/public/get_instruments','/public/tickers','/public/coin_gecko_contracts']);
const positive=value=>{const valid=typeof value==='number'||typeof value==='string'&&/^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value);
 const n=valid?Number(value):NaN;return Number.isFinite(n)&&n>0?n:NaN};
const finite=value=>typeof value==='number'&&Number.isFinite(value);
const stamp=value=>Number.isSafeInteger(value)&&value>=1e12;
const near=(a,b)=>Number.isFinite(a)&&Number.isFinite(b)&&Math.abs(a-b)<=Math.max(1e-10,Math.abs(a)*1e-10);
const verified=value=>value?.status==='VERIFIED'||value?.status==='MOCK_VALIDATED'&&value?.dataSource==='SYNTHETIC_TEST';
export function orangeXInstrument(symbol){
 const m=/^([A-Z0-9]{2,24})USDT$/.exec(String(symbol||''));if(!m)throw Error('OrangeX: unsupported Binance USDT symbol');
 return m[1]+'-USDT-PERPETUAL';
}
export function verifiedOrangeXInstrument(symbol,instruments){
 const name=orangeXInstrument(symbol);
 if(!Array.isArray(instruments)||instruments.filter(x=>x?.instrument_name===name&&x?.is_active===true&&['perpetual','PERPETUAL'].includes(x?.kind)).length!==1)
  throw Error('OrangeX: active exact perpetual contract not verified');
 return name;
}
export function examineOrangeXBook(data,{now=Date.now(),maxAgeMs=10000,maxSpreadBps=15}={}){
 data=data?.result??data;
 if(!stamp(now)||!Number.isInteger(maxAgeMs)||maxAgeMs<1||maxAgeMs>90000||!finite(maxSpreadBps)||maxSpreadBps<=0||maxSpreadBps>100)throw Error('OrangeX: invalid book policy');
 const normalize=rows=>Array.isArray(rows)?rows.map(row=>Array.isArray(row)&&row.length===2?row.map(positive):null):null,
  bids=normalize(data?.bids),asks=normalize(data?.asks),integrity=orangeXBookIntegrity({bids,asks},{requestedDepth:1000}),
  bid=bids?.[0]?.[0],ask=asks?.[0]?.[0],timestamp=Number(data?.timestamp);
 if(!integrity.valid||!Number.isFinite(bid)||!Number.isFinite(ask)||bid>=ask)throw Error('OrangeX: invalid, duplicate or crossed book');
 if(!stamp(timestamp)||timestamp>now||now-timestamp>maxAgeMs)throw Error('OrangeX: stale book');
 const spreadBps=(ask-bid)/(bid+(ask-bid)/2)*10000;if(spreadBps>maxSpreadBps)throw Error('OrangeX: spread too wide');
 return {bid,ask,bidSize:bids[0][1],askSize:asks[0][1],spreadBps,timestamp,bids,asks,instrumentName:data.instrument_name??null};
}
/** This is a read-only intent description, never an API order payload.
 * contractVerification/capabilities are supplied review declarations; mocks are
 * explicitly tagged. Their presence cannot activate a client or LIVE transport.
 */
export function makeOrangeXOrderPlan({signal,binancePrice,binancePriceAt,orangexBook,instruments,contractVerification,
 executionCapabilities,tradeApproval,costAssumptions,now=Date.now(),minimumScore=FINAL_MIN_SCORE,maxPriceAgeMs=15000,maxBasisBps=30,
 maxNotionalUSDT=100,maxRiskUSDT=2,maxSlippageBps=10}={}){
 if(!Number.isInteger(minimumScore)||minimumScore<FINAL_MIN_SCORE||minimumScore>100||signal?.scoreVersion!=='ISSUE6-100-V1'||
  !finite(signal?.score)||signal.score<minimumScore||signal.score>100||signal.technicalQualified!==true||signal?.technicalValidation?.passed!==true||
  signal.status!=='signal'||signal.qualified!==true)throw Error('OrangeX: qualified canonical score and independent technical validation required');
 if(!['LONG','SHORT'].includes(signal.direction)||signal.patternConfirmed!==true||signal.patternTimeframe!=='1h'||
  !stamp(signal.patternConfirmedAt)||signal.patternConfirmedAt>now||now-signal.patternConfirmedAt>75*60000)
  throw Error('OrangeX: stale or unconfirmed direction/candle');
 if(tradeApproval?.approved!==true||!verified(tradeApproval))throw Error('OrangeX: separate trade approval is unverified');
 if(!['protectiveStop','safeStopReplace','reduceOnly'].every(key=>verified(executionCapabilities?.[key])))throw Error('OrangeX: protective stop, safe replacement and reduce-only are unverified');
 if(!Number.isSafeInteger(maxPriceAgeMs)||maxPriceAgeMs<1||maxPriceAgeMs>90000)throw Error('OrangeX: invalid price age policy');
 const price=positive(binancePrice),priceAt=Number(binancePriceAt);
 if(!Number.isFinite(price)||!stamp(priceAt)||priceAt>now||now-priceAt>maxPriceAgeMs)throw Error('OrangeX: stale Binance price');
 const instrumentName=verifiedOrangeXInstrument(signal.symbol,instruments),inst=instruments.find(x=>x.instrument_name===instrumentName),proof=contractVerification;
 if(!verified(proof)||proof.instrumentName!==instrumentName||proof.binanceSymbol!==signal.symbol||
  !['BASE_ASSET','CONTRACT'].includes(proof.quantityUnit)||proof.bookQuantityUnit!==proof.quantityUnit||proof.amountMode!=='DEFAULT_QUANTITY'||
  proof.minNotionalCurrency!=='USDT'||proof.priceCurrency!=='USDT'||proof.settlementCurrency!=='USDT'||proof.contractType!=='LINEAR_PERPETUAL'||
  !Number.isFinite(positive(inst.contract_size))||!near(proof.contractSizeBase,positive(inst.contract_size)))
  throw Error('OrangeX: contract size, amount, book quantity and notional units are unverified');
 const book=examineOrangeXBook(orangexBook,{now}),quote=signal.direction==='LONG'?book.ask:book.bid;
 if(book.instrumentName!==instrumentName)throw Error('OrangeX: book instrument mismatch or missing');
 const basisBps=10000*Math.abs(quote-price)/price;if(!finite(maxBasisBps)||maxBasisBps<=0||basisBps>maxBasisBps)throw Error('OrangeX: cross-exchange basis too wide');
 const stop=positive(signal.stop),targets=signal.targetPlan?.targets;
 if(signal.managementVersion!=='VOLUME_PROFILE_V1'||signal.targetPlan?.ok!==true||!Array.isArray(targets)||targets.length!==3||
  !Number.isFinite(stop)||!targets.every((target,i)=>Number.isFinite(target)&&target>0&&(signal.direction==='LONG'?target>(i?targets[i-1]:quote):target<(i?targets[i-1]:quote)))||
  !(signal.direction==='LONG'?stop<quote:stop>quote))throw Error('OrangeX: verified volume-profile targets and stop are required');
 const fees=costAssumptions;
 if(!fees||!['STANDARD_SCHEDULE_ASSUMPTION','VERIFIED_ACCOUNT_RATE','SYNTHETIC_TEST'].includes(fees.source)||
  !['makerRate','takerRate','fundingReserveFraction'].every(key=>finite(fees[key])&&fees[key]>=0)||fees.makerRate>.01||fees.takerRate>.01||fees.fundingReserveFraction>.1)
  throw Error('OrangeX: explicit fee and funding assumptions required');
 if(fees.source==='STANDARD_SCHEDULE_ASSUMPTION'&&(!near(fees.makerRate,.0002)||!near(fees.takerRate,.0006)))
  throw Error('OrangeX: standard fee assumption does not match the documented schedule');
 if(fees.source==='VERIFIED_ACCOUNT_RATE'&&(!verified(fees.accountRateVerification)||fees.accountRateVerification.rateUnit!=='FRACTION'||
  !near(fees.accountRateVerification.makerRate,fees.makerRate)||!near(fees.accountRateVerification.takerRate,fees.takerRate)))
  throw Error('OrangeX: effective account rates require separate reviewed evidence');
 const limit=positive(maxNotionalUSDT),risk=positive(maxRiskUSDT),step=positive(inst.min_trade_amount),minQty=positive(inst.min_qty),tick=positive(inst.tick_size),minNotional=positive(inst.min_notional);
 if(![limit,risk,step,minQty,tick,minNotional].every(Number.isFinite)||limit>100||risk>2||!finite(maxSlippageBps)||maxSlippageBps<0||maxSlippageBps>10)throw Error('OrangeX: invalid increments or preview risk caps');
 if(![stop,...targets,...book.bids.map(row=>row[0]),...book.asks.map(row=>row[0])].every(price=>isVolumeStepAligned(price,tick))||
  ![...book.bids,...book.asks].every(row=>isVolumeStepAligned(row[1],step)))throw Error('OrangeX: price or visible quantity grid mismatch');
 const sign=signal.direction==='LONG'?1:-1,unitBase=proof.quantityUnit==='CONTRACT'?proof.contractSizeBase:1,buffer=quote*maxSlippageBps/10000,
  rawLimit=quote+sign*buffer,limitPrice=Number(roundOrangeXDecimal(rawLimit,tick,sign===1?'DOWN':'UP')),
  stopFill=stop-sign*buffer,
  perUnitRisk=unitBase*(sign*(limitPrice-stopFill)+(limitPrice+stopFill)*Math.max(fees.makerRate,fees.takerRate)+limitPrice*fees.fundingReserveFraction),
  amount=Number(roundOrangeXDecimal(Math.min(limit/(Math.max(limitPrice,quote)*unitBase),risk/perUnitRisk),step*20,'DOWN'));
 if(!(perUnitRisk>0)||!positive(stopFill)||!(signal.direction==='LONG'?limitPrice>=quote:limitPrice<=quote))throw Error('OrangeX: risk-safe limit price unavailable');
 if(!(amount>=minQty)||amount*quote*unitBase<minNotional)throw Error('OrangeX: below minimum quantity or notional without risk-safe rounding');
 if((signal.direction==='LONG'?book.askSize:book.bidSize)<amount)throw Error('OrangeX: insufficient best-level depth');
 const parts=splitVolumeQuantity(amount,step).map((quantity,i)=>({price:targets[i],fraction:[.4,.35,.25][i],quantity}));
 if(parts.some(part=>part.quantity<minQty||part.quantity*part.price*unitBase<minNotional))throw Error('OrangeX: split exits do not meet minimum quantity/notional');
  const feeRate=Math.max(fees.makerRate,fees.takerRate),netRewardPerUnit=unitBase*((signal.direction==='LONG'?targets[0]-quote:quote-targets[0])-2*buffer-(quote+targets[0])*feeRate-quote*fees.fundingReserveFraction),
   estimatedNetRR=netRewardPerUnit/perUnitRisk;
  if(!Number.isFinite(estimatedNetRR)||estimatedNetRR<1.8)throw Error('OrangeX: net reward/risk is below the independent minimum');
  const plannedRiskUSDT=amount*perUnitRisk;
 if(plannedRiskUSDT>risk+1e-8)throw Error('OrangeX: risk cap exceeded');
  return {previewOnly:true,mode:'READ_ONLY',instrumentName,basisBps,spreadBps:book.spreadBps,notionalUSDT:amount*quote*unitBase,plannedRiskUSDT,estimatedNetRR,
  intent:{side:signal.direction==='LONG'?'BUY':'SELL',type:'LIMIT',amount,quantityUnit:proof.quantityUnit,limitPrice,stop,targets:parts,
   clientReference:'sl_'+createHash('sha256').update([signal.symbol,signal.direction,signal.pattern,signal.patternConfirmedAt].join('|')).digest('hex').slice(0,28)},
  capabilitiesAreMockEvidence:['protectiveStop','safeStopReplace','reduceOnly'].some(key=>executionCapabilities[key].status==='MOCK_VALIDATED'),
  actualAccountRateVerified:fees.source==='VERIFIED_ACCOUNT_RATE',costAssumptions:{source:fees.source,makerRate:fees.makerRate,takerRate:fees.takerRate,fundingReserveFraction:fees.fundingReserveFraction},transportAllowed:false,activationAllowed:false,liveOrdersEnabled:false,
  warning:'READ_ONLY intent only; official order fields, account rules, leverage, protective replacement and actual fills remain separately verified. Never submitted.'};
}
export function orangeXSignature({clientId,clientSecret,timestamp,nonce}){
 if(!clientId||!clientSecret||!timestamp||!nonce)throw Error('OrangeX: missing auth input');
 return createHmac('sha256',clientSecret).update(clientId+'\n'+timestamp+'\n'+nonce+'\n').digest('hex');
}
export class OrangeXClient {
 #clientId;#clientSecret;#token=null;#expiresAt=0;#authContract;#rpcContract;
 constructor({clientId='',clientSecret='',transport=fetch,clock=Date.now,contractVerification=null}={}){
  this.#clientId=clientId;this.#clientSecret=clientSecret;this.transport=transport;this.clock=clock;
  this.#authContract=contractVerification?.officialSpecVerified===true&&contractVerification?.readAuthVerified===true;
  this.#rpcContract=contractVerification?.jsonRpcSpecificationVerified===true;
 }
 getStatus(){return {mode:'READ_ONLY',credentialsConfigured:Boolean(this.#clientId&&this.#clientSecret),authenticated:Boolean(this.#token&&this.clock()<this.#expiresAt),
  expiresAt:this.#expiresAt||null,authenticationSpecificationVerified:this.#authContract,jsonRpcSpecificationVerified:this.#rpcContract,liveOrdersEnabled:false,writeMethodsAvailable:false}}
 toJSON(){return this.getStatus()}
 async rpc(method,params={},token=null){
  if(method.startsWith('/private/')&&!READ_METHODS.has(method))throw Error('OrangeX: live write requests are disabled');
  if(!PUBLIC_METHODS.has(method)&&!READ_METHODS.has(method))throw Error('OrangeX: unsupported read-only RPC method');
  if(!this.#rpcContract)throw Error('OrangeX: JSON-RPC specification is unverified; use the independently reviewed public GET adapter');
  if(method.startsWith('/private/')&&(!this.#authContract||!token))throw Error('OrangeX: verified read authentication required');
  if(method==='/public/auth'&&!this.#authContract)throw Error('OrangeX: authentication specification is unverified');
  if(method==='/public/auth'&&params.scope!=='trade:read')throw Error('OrangeX: only read permission may be requested');
  const headers={'Content-Type':'application/json'};if(token)headers.Authorization='Bearer '+token;
  const response=await this.transport(ORANGEX_API,{method:'POST',headers,body:JSON.stringify({jsonrpc:'2.0',id:String(this.clock()),method,params}),signal:AbortSignal.timeout(10000)});
  if(!response.ok)throw Error('OrangeX API HTTP '+response.status);
  const body=await response.json();if(body?.error)throw Error('OrangeX RPC error');
  if(!Object.prototype.hasOwnProperty.call(body||{},'result'))throw Error('OrangeX: invalid JSON-RPC response');return body.result;
 }
 async authenticate(){
  if(!this.#authContract)throw Error('OrangeX: authentication specification is unverified');
  if(!this.#clientId||!this.#clientSecret)throw Error('OrangeX: missing API credentials');
  const timestamp=String(this.clock()),nonce=randomBytes(16).toString('hex'),signature=orangeXSignature({clientId:this.#clientId,clientSecret:this.#clientSecret,timestamp,nonce}),
   data=await this.rpc('/public/auth',{grant_type:'client_signature',client_id:this.#clientId,timestamp,nonce,signature,scope:'trade:read'});
  if(!data?.access_token||!Number.isFinite(Number(data.expires_in))||Number(data.expires_in)<=30||!String(data.scope||'').split(/\s+/).includes('trade:read'))throw Error('OrangeX: read-only permission unavailable');
  this.#token=data.access_token;this.#expiresAt=this.clock()+Number(data.expires_in)*1000-30000;return this.getStatus();
 }
 async read(method,params={}){
  if(!READ_METHODS.has(method))throw Error('OrangeX: live write requests are disabled');
  if(!this.#token||this.clock()>=this.#expiresAt)await this.authenticate();return this.rpc(method,params,this.#token);
 }
 async orderBook(instrument_name){
  if(!/^[A-Z0-9]{2,24}-USDT-PERPETUAL$/.test(String(instrument_name)))throw Error('OrangeX: invalid perp contract');
  return this.rpc('/public/get_order_book',{instrument_name,depth:5});
 }
 async instruments(){return this.rpc('/public/get_instruments',{currency:'PERPETUAL',kind:'perpetual'})}
 async positions(){return this.read('/private/get_positions',{currency:'PERPETUAL',kind:'perpetual'})}
 async orderState(id){if(!/^\d+$/.test(String(id)))throw Error('OrangeX: invalid order id');return this.read('/private/get_order_state',{order_id:String(id)})}
}
