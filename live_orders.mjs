// Live order planning: pure functions that turn a final, venue-checked signal into
// the exact exchange requests (entry + protective stop + three reduce-only targets),
// plus the pre-trade checks. No network, no keys.
import {createHash} from 'node:crypto';
import {roundDecimalToStep,multiplyDecimal} from './decimal_grid.mjs';

export const LIVE_MODES=Object.freeze(['OFF','TESTNET','LIVE']);
export const LIVE_CONFIRM_PHRASE='REAL_MONEY';
const FRACTIONS=[.4,.35,.25];
const positive=x=>typeof x==='number'&&Number.isFinite(x)&&x>0;

export function liveConfig(env=process.env){
 const mode=LIVE_MODES.includes(String(env.LIVE_TRADING_MODE||'OFF').toUpperCase())?String(env.LIVE_TRADING_MODE||'OFF').toUpperCase():'OFF';
 const num=(key,def,min,max)=>{const v=Number(env[key]);return Number.isFinite(v)&&v>=min&&v<=max?v:def};
 return {mode,liveConfirmed:env.LIVE_TRADING_CONFIRM===LIVE_CONFIRM_PHRASE,
  venues:String(env.LIVE_VENUES||'BINGX,GATEIO').split(',').map(x=>x.trim().toUpperCase()).filter(x=>['BINGX','GATEIO'].includes(x)),
  maxRiskUSD:num('LIVE_MAX_RISK_USD',2,0.1,100),dailyMaxRiskUSD:num('LIVE_DAILY_MAX_RISK_USD',6,0.1,500),maxOpen:num('LIVE_MAX_OPEN_POSITIONS',1,1,5)};
}

/** Deterministic client order id from the signal key: the same signal can never be sent twice. */
export function liveClientId(signalKey){return 'sl'+createHash('sha256').update(String(signalKey)).digest('hex').slice(0,24)}

/** Live quantity: the paper plan scaled down to the live risk cap, kept on the
 * 20-lot grid so 40/35/25% splits stay whole lots/contracts. */
export function liveQuantity({quantity,estimatedStopLossUSD,maxRiskUSD,contract}){
 if(!positive(quantity)||!positive(estimatedStopLossUSD)||!positive(maxRiskUSD)||!contract)return null;
 const step=contract.quantityUnit==='CONTRACT'?contract.contractSizeBase:contract.quantityStep;
 // 1e-9 absorbs binary rounding (0.6*(2/6)=0.19999...) without materially raising risk.
 const grid=multiplyDecimal(step,'20'),scaled=quantity*Math.min(1,maxRiskUSD/estimatedStopLossUSD)*(1+1e-9);
 let base;try{base=Number(roundDecimalToStep(scaled,grid,'DOWN'))}catch{return null}
 if(!(base>0)||base<Number(contract.minQuantityBase||0))return null;
 const parts=FRACTIONS.map(f=>Number(roundDecimalToStep(base*f+Number(step)*1e-6,step,'DOWN')));
 parts[2]=Number((base-parts[0]-parts[1]).toFixed(12));
 const riskUSD=Math.min(estimatedStopLossUSD*base/quantity,maxRiskUSD);
 if(contract.quantityUnit==='CONTRACT'){
  const size=Number(contract.contractSizeBase),contracts=Math.round(base/size);
  return {base,riskUSD,unit:'CONTRACT',total:contracts,parts:parts.map(p=>Math.round(p/size))};
 }
 return {base,riskUSD,unit:'BASE_ASSET',total:base,parts};
}

/** BingX one-way mode requests. The entry carries an attached STOP_MARKET so the
 * position is protected from the moment it exists. */
export function bingxOrders({symbol,direction,stop,targets,qty,clientOrderId}){
 const open=direction==='LONG'?'BUY':'SELL',close=direction==='LONG'?'SELL':'BUY';
 return {
  entry:{symbol,side:open,positionSide:'BOTH',type:'MARKET',quantity:String(qty.total),clientOrderId,
   stopLoss:JSON.stringify({type:'STOP_MARKET',stopPrice:Number(stop),workingType:'MARK_PRICE'})},
  stop:quantity=>({symbol,side:close,positionSide:'BOTH',type:'STOP_MARKET',quantity:String(quantity),stopPrice:String(stop),reduceOnly:'true',workingType:'MARK_PRICE'}),
  targets:targets.map((price,i)=>({symbol,side:close,positionSide:'BOTH',type:'TAKE_PROFIT_MARKET',quantity:String(qty.parts[i]),stopPrice:String(price),reduceOnly:'true',workingType:'MARK_PRICE'})),
  emergencyClose:quantity=>({symbol,side:close,positionSide:'BOTH',type:'MARKET',quantity:String(quantity),reduceOnly:'true'}),
  breakeven:(price,quantity)=>({symbol,side:close,positionSide:'BOTH',type:'STOP_MARKET',quantity:String(quantity),stopPrice:String(price),reduceOnly:'true',workingType:'MARK_PRICE'})
 };
}

/** Gate.io single-position mode requests (sizes in contracts, signed by side). */
export function gateOrders({contract,direction,stop,targets,qty,clientOrderId}){
 const sign=direction==='LONG'?1:-1,closeType=direction==='LONG'?'close-long-position':'close-short-position',
  planType=direction==='LONG'?'plan-close-long-position':'plan-close-short-position';
 const stopRule=direction==='LONG'?2:1,targetRule=direction==='LONG'?1:2; // 1: price >= trigger, 2: price <= trigger
 const stopAt=price=>({initial:{contract,size:0,price:'0',tif:'ioc',close:true},trigger:{strategy_type:0,price_type:1,price:String(price),rule:stopRule},order_type:closeType});
 return {
  entry:{contract,size:sign*qty.total,price:'0',tif:'ioc',text:'t-'+clientOrderId},
  stop:()=>stopAt(stop),
  targets:targets.map((price,i)=>({initial:{contract,size:-sign*qty.parts[i],price:'0',tif:'ioc',reduce_only:true},
   trigger:{strategy_type:0,price_type:1,price:String(price),rule:targetRule},order_type:planType})),
  emergencyClose:()=>({contract,size:0,price:'0',tif:'ioc',close:true}),
  breakeven:price=>stopAt(price)
 };
}

/** Everything that must hold before a live entry is sent. Returns reasons (empty = go). */
export function preflight({config,armed,killSwitch,credentials,row,records,now=Date.now(),qty}){
 const reasons=[],venue=row?.executionVenue,day=new Date(now+9*3600000).toISOString().slice(0,10);
 if(config.mode==='OFF')reasons.push('LIVE_MODE_OFF');
 if(config.mode==='LIVE'&&!config.liveConfirmed)reasons.push('LIVE_CONFIRM_MISSING');
 if(!armed)reasons.push('NOT_ARMED');
 if(killSwitch)reasons.push('KILL_SWITCH_ON');
 if(!config.venues.includes(venue))reasons.push('VENUE_NOT_ENABLED_FOR_LIVE');
 else if(!credentials?.[venue])reasons.push('CREDENTIALS_MISSING');
 if(row?.decision?.ready!==true)reasons.push('SIGNAL_NOT_READY');
 if(!Array.isArray(row?.targets)||row.targets.length!==3||!positive(row?.stop))reasons.push('PLAN_INCOMPLETE');
 const active=records.filter(r=>['SUBMITTING','OPEN','UNKNOWN'].includes(r.status));
 if(active.some(r=>r.status==='UNKNOWN'))reasons.push('UNRESOLVED_ORDER_STATE');
 if(active.length>=config.maxOpen)reasons.push('MAX_OPEN_POSITIONS');
 if(active.some(r=>r.symbol===row?.symbol))reasons.push('SYMBOL_ALREADY_ACTIVE');
 if(!qty)reasons.push('QUANTITY_BELOW_MINIMUM_AT_LIVE_RISK');
 // Fractional Gate.io contract sizes are not yet verified against the venue: no live order.
 // Decimal contracts sized in whole contracts (order_size_min 0 fallback) are safe to send.
 const vc=row?.venueContract;
 if(venue==='GATEIO'&&vc?.decimalSizes===true&&!(vc.decimalStepFallback===true&&vc.contractStep==='1'))reasons.push('GATEIO_DECIMAL_SIZE_UNVERIFIED');
 const todayRisk=records.filter(r=>r.day===day&&r.status!=='FAILED').reduce((s,r)=>s+(r.plannedRiskUSD||0),0);
 if(qty&&todayRisk+qty.riskUSD>config.dailyMaxRiskUSD+1e-9)reasons.push('DAILY_RISK_LIMIT');
 return {ok:reasons.length===0,reasons,day,todayRiskUSD:todayRisk};
}
