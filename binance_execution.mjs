import {roundOrangeXDecimal} from './orangex_contract_validation.mjs';
const positive=x=>typeof x==='number'&&Number.isFinite(x)&&x>0;
const finite=x=>typeof x==='number'&&Number.isFinite(x);
export const BINANCE_PAPER_ASSUMPTIONS=Object.freeze({takerRate:.0006,makerRate:.0002,slippageBps:5,fundingReserveRate:.0003,
 basis:'EXPLICIT_CONSERVATIVE_PAPER_SCENARIO_NOT_ACCOUNT_FEES_OR_FUNDING_OBSERVATION'});
// Public book sizing only. Passing this review never authorizes OrangeX or an
// account order. Quote/contract values come from Binance exchangeInfo/depth.
export function estimateBinanceExecution({signal,book,market,now=Date.now(),maxRiskUSD=6,maxNotionalUSD=1500,
 maxAgeMs=15000,maxSpreadBps=20,assumptions=BINANCE_PAPER_ASSUMPTIONS}={}){
 const reasons=[],side=signal?.direction,sign=side==='LONG'?1:-1,sourceTime=Number(book?.T??book?.E),
  bids=Array.isArray(book?.bids)?book.bids.map(x=>x.map(Number)):[],asks=Array.isArray(book?.asks)?book.asks.map(x=>x.map(Number)):[],
  bid=bids[0]?.[0],ask=asks[0]?.[0],filters=market?.filters??{},step=Number(filters.LOT_SIZE?.stepSize),minQuantity=Number(filters.LOT_SIZE?.minQty),
  tickSize=Number(filters.PRICE_FILTER?.tickSize),minNotional=Number(filters.MIN_NOTIONAL?.notional??filters.NOTIONAL?.minNotional),
  values=[assumptions?.takerRate,assumptions?.makerRate,assumptions?.slippageBps,assumptions?.fundingReserveRate];
 if(!['LONG','SHORT'].includes(side)||!positive(signal?.entry)||!positive(signal?.stop)||sign*(signal.entry-signal.stop)<=0)reasons.push('PROTECTIVE_STOP_INVALID');
 if(![maxRiskUSD,maxNotionalUSD,maxAgeMs].every(positive)||!finite(maxSpreadBps)||maxSpreadBps<0||maxAgeMs>90000)reasons.push('EXECUTION_LIMIT_INVALID');
 if(values.some(x=>!finite(x)||x<0)||!assumptions?.basis)reasons.push('COST_ASSUMPTION_UNVERIFIED');
 if(market?.symbol!==signal?.symbol||market?.status!=='TRADING'||market?.contractType!=='PERPETUAL'||market?.quoteAsset!=='USDT')reasons.push('BINANCE_CONTRACT_UNVERIFIED');
 if(![step,minQuantity,tickSize,minNotional].every(positive))reasons.push('BINANCE_ORDER_FILTERS_UNVERIFIED');
 for(const [rows,ascending] of [[bids,false],[asks,true]]){
  if(!rows.length||rows.length>1000||rows.some((x,i)=>x.length!==2||!x.every(positive)||i&&(ascending?x[0]<=rows[i-1][0]:x[0]>=rows[i-1][0])))reasons.push('BOOK_DEPTH_INVALID');
 }
 if(!positive(bid)||!positive(ask)||bid>=ask)reasons.push('BOOK_CROSSED_OR_MISSING');
 if(!positive(sourceTime)||sourceTime>now||now-sourceTime>maxAgeMs)reasons.push('BOOK_CLOCK_INVALID_OR_STALE');
 const spreadBps=positive(bid)&&positive(ask)?(ask-bid)/(bid+(ask-bid)/2)*10000:null;
 if(spreadBps!==null&&spreadBps>maxSpreadBps)reasons.push('SPREAD_LIMIT');
 const quote=side==='LONG'?ask:bid;
 if(positive(quote)&&positive(signal?.stop)&&sign*(quote-signal.stop)<=0)reasons.push('PROTECTIVE_STOP_INVALID_AT_CURRENT_BOOK');
 const originalEntry=signal?.referenceEntry??signal?.entry,allowance=positive(signal?.atr)?Math.min(originalEntry*.004,signal.atr*.45):originalEntry*.004;
 if(positive(quote)&&positive(originalEntry)&&Math.abs(quote-originalEntry)>allowance)reasons.push('EXECUTABLE_BOOK_OUTSIDE_ENTRY_ZONE');
 let quantity=null,notional=null,entryBasis=null,estimatedStopLossUSD=null,slippageBps=null;
 if(!reasons.length){
  const worstEntry=Number(roundOrangeXDecimal(quote*(1+sign*assumptions.slippageBps/10000),tickSize,sign===1?'UP':'DOWN')),worstStop=signal.stop*(1-sign*assumptions.slippageBps/10000),
   perUnit=sign*(worstEntry-worstStop)+(worstEntry+worstStop)*Math.max(assumptions.takerRate,assumptions.makerRate)+worstEntry*assumptions.fundingReserveRate;
  if(!(perUnit>0))reasons.push('RISK_MODEL_INVALID');
  else{
   // Twenty lot steps let the 40/35/25% split land on the lot grid. The grid is
   // built in exact decimal arithmetic: step*20 in binary floating point is not
   // always a multiple of step (0.07*20 === 1.4000000000000001).
   const splitGrid=roundOrangeXDecimal(step*20.5,step,'DOWN');
   quantity=Number(roundOrangeXDecimal(Math.min(maxRiskUSD/perUnit,maxNotionalUSD/worstEntry),splitGrid,'DOWN'));
   if(!positive(quantity)||quantity<minQuantity||quantity*quote<minNotional)reasons.push('RISK_CAP_BELOW_MINIMUM_ORDER');
   let remaining=quantity,cost=0;
   for(const [price,size]of side==='LONG'?asks:bids){const take=Math.min(remaining,size);cost+=take*price;remaining-=take;if(remaining<=1e-12)break}
   if(remaining>Math.max(1e-12,quantity*1e-12))reasons.push('BOOK_DEPTH_INSUFFICIENT');
   else if(positive(quantity)){
    const average=cost/quantity;entryBasis=Number(roundOrangeXDecimal(average,tickSize,sign===1?'UP':'DOWN'));slippageBps=Math.max(0,sign*(average-quote)/quote*10000);
    if(slippageBps>assumptions.slippageBps)reasons.push('SLIPPAGE_LIMIT');
    estimatedStopLossUSD=quantity*perUnit;notional=quantity*entryBasis;
    if(estimatedStopLossUSD>maxRiskUSD+1e-8)reasons.push('MAX_LOSS_EXCEEDED');
   }
  }
 }
 return {eligible:reasons.length===0,reasons:[...new Set(reasons)],side,quantity,notional,entryBasis,executablePrice:positive(quote)?quote:null,bid:positive(bid)?bid:null,ask:positive(ask)?ask:null,
  spreadBps,slippageBps,estimatedStopLossUSD,maxRiskUSD,tickSize:positive(tickSize)?tickSize:null,quantityStep:positive(step)?step:null,
  minQuantity:positive(minQuantity)?minQuantity:null,minNotional:positive(minNotional)?minNotional:null,contractSizeBase:1,quantityUnit:'BASE_ASSET',
  quoteUpdatedAt:positive(sourceTime)?sourceTime:null,quoteAgeSeconds:positive(sourceTime)?(now-sourceTime)/1000:null,
  costAssumptions:{...assumptions,fundingStatus:'ASSUMED_RESERVE_NOT_ACTUAL_SETTLEMENT'},dataFrom:'BINANCE_PUBLIC_DEPTH',
  actualAccountFeesVerified:false,orangeXContractVerified:false,tradeApproval:false,ordersSubmitted:false,checkedAt:now};
}
