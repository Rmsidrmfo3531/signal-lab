// Live order planning: pure functions that turn a final, venue-checked signal into
// the exact exchange requests (entry + protective stop + three reduce-only targets),
// plus the pre-trade checks. No network, no keys.
import {createHash} from 'node:crypto';
import {roundDecimalToStep,multiplyDecimal} from './decimal_grid.mjs';
import {evenPositions} from './paper.mjs';
import {positionSideFor,forMode} from './bingx_position_mode.mjs';
import {planZoneDca,planProfile,clampMaxAdds,DCA_DEFAULTS,HOURLY_MAX_ADDS_DEFAULT} from './dca_plan.mjs';
import {testnetDailyLossPct} from './testnet_budget.mjs';

export const LIVE_MODES=Object.freeze(['OFF','TESTNET','LIVE']);
export const LIVE_CONFIRM_PHRASE='REAL_MONEY';
// The signal strategy stays off the real account (user 2026-11-14: test it on the testnet, real money
// only for copy trading). LIVE also needs SIGNAL_LIVE_UNLOCK=REAL_MONEY_SIGNALS, which only the user
// adds after a new approval; without it LIVE places no signal orders and cannot be armed.
export const SIGNAL_LIVE_UNLOCK_PHRASE='REAL_MONEY_SIGNALS';
const FRACTIONS=[.4,.35,.25];
const positive=x=>typeof x==='number'&&Number.isFinite(x)&&x>0;

// Risk profile (user request 2026-11-13, after the trade-log review):
//  CONSERVATIVE — 1 % of the balance per trade (loss at the stop with every add filled), 3 % a day,
//                 4 open positions (2 per direction); adds are dropped until the plan fits.
//  CURRENT      — the earlier values (30 % per trade, 60 % a day, no position count limit).
//  GROWTH       — 3 % per trade, 9 % open risk / day, 8 positions (4 per direction): about the top
//                 return of the HYBRID grid (research/hybrid_grid.mjs, +49 % vs +51 % median a year) with
//                 a smaller drawdown (17.6 % vs 25.5 %); user approved 2026-11-13. Worst trade about 5 %.
// TESTNET and OFF use GROWTH; LIVE keeps CURRENT until the user approves the change.
// LIVE_RISK_PROFILE=CURRENT|CONSERVATIVE|GROWTH overrides; the profile wins over DCA_MAX_LOSS_PCT and
// LIVE_DAILY_MAX_LOSS_PCT unless they are stricter; LIVE_MAX_OPEN_POSITIONS may only lower the count.
export const RISK_PROFILES=Object.freeze({CONSERVATIVE:Object.freeze({maxLossPct:1,dailyMaxLossPct:3,maxOpen:4,maxPerDirection:2}),
 GROWTH:Object.freeze({maxLossPct:3,dailyMaxLossPct:9,maxOpen:8,maxPerDirection:4})});
export function liveConfig(env=process.env){
 const base=liveConfigBase(env),asked=String(env.LIVE_RISK_PROFILE||'').toUpperCase();
 const riskProfile=['CURRENT','CONSERVATIVE','GROWTH'].includes(asked)?asked:base.mode==='LIVE'?'CURRENT':'GROWTH';
 // Strategy profile (stage 5, 2026-11-13): TESTNET / OFF trade HYBRID — the first quantity worked
 // back from the risk limit (loss at the stop with every add filled = maxLossPct of the balance),
 // adds 1·1·2·4 (3 adds) at volume zones — the best profile of the train / validation backtest.
 // LIVE keeps CURRENT until the user approves. LIVE_STRATEGY_PROFILE=CURRENT|HYBRID overrides;
 // LIVE_HYBRID_MAX_ADDS (0-10, default 3).
 const askedStrategy=String(env.LIVE_STRATEGY_PROFILE||'').toUpperCase();
 const strategyProfile=['CURRENT','HYBRID'].includes(askedStrategy)?askedStrategy:base.mode==='LIVE'?'CURRENT':'HYBRID';
 const hybridMaxAdds=clampMaxAdds(env.LIVE_HYBRID_MAX_ADDS,3);
 base.strategyProfile=strategyProfile;base.hybridMaxAdds=hybridMaxAdds;
 if(!(RISK_PROFILES[riskProfile]&&base.sizing==='BALANCE'))return {...base,riskProfile};
 // An explicit LIVE_MAX_OPEN_POSITIONS=N (N > 0) still sets the count; otherwise the profile's 4.
 // The profile is a ceiling: a stricter single value (e.g. LIVE_DAILY_MAX_LOSS_PCT=2) is kept.
 // TESTNET + GROWTH (user 2026-11-17 18:11 "하루 손실을 늘리면 되지 너무 적잖아"): the daily / open-risk % is the shared
 // testnet budget with the reversal scalp, TESTNET_DAILY_LOSS_PCT (default 15, testnet_budget.mjs) instead of 9.
 // OFF and LIVE keep their values; a stricter LIVE_DAILY_MAX_LOSS_PCT is still kept.
 const P=base.mode==='TESTNET'&&riskProfile==='GROWTH'?{...RISK_PROFILES.GROWTH,dailyMaxLossPct:testnetDailyLossPct(env)}:RISK_PROFILES[riskProfile],count=base.maxOpen>0?{maxOpen:Math.min(base.maxOpen,P.maxOpen),maxPerDirection:Math.min(base.maxPerDirection,P.maxPerDirection)}:{maxOpen:P.maxOpen,maxPerDirection:P.maxPerDirection};
 return {...base,maxLossPct:Math.min(base.maxLossPct,P.maxLossPct),dailyMaxLossPct:Math.min(base.dailyMaxLossPct,P.dailyMaxLossPct),...count,riskProfile};
}
function liveConfigBase(env){
 const mode=LIVE_MODES.includes(String(env.LIVE_TRADING_MODE||'OFF').toUpperCase())?String(env.LIVE_TRADING_MODE||'OFF').toUpperCase():'OFF';
 const num=(key,def,min,max)=>{const v=Number(env[key]);return Number.isFinite(v)&&v>=min&&v<=max?v:def};
 return {mode,liveConfirmed:env.LIVE_TRADING_CONFIRM===LIVE_CONFIRM_PHRASE&&env.SIGNAL_LIVE_UNLOCK===SIGNAL_LIVE_UNLOCK_PHRASE,signalLiveLocked:env.SIGNAL_LIVE_UNLOCK!==SIGNAL_LIVE_UNLOCK_PHRASE,
  venues:String(env.LIVE_VENUES||'BINGX').split(',').map(x=>x.trim().toUpperCase()).filter(x=>['BINGX','GATEIO'].includes(x)),
  maxRiskUSD:num('LIVE_MAX_RISK_USD',2,0.1,100),dailyMaxRiskUSD:num('LIVE_DAILY_MAX_RISK_USD',6,0.1,500),// Position count (user, 2026-11-13): no count limit by default — the open-risk cap (all open
  // positions' worst losses within the daily loss limit) bounds exposure. LIVE_MAX_OPEN_POSITIONS=N
  // brings back N positions, half per direction.
  ...(()=>{const n=Number(env.LIVE_MAX_OPEN_POSITIONS);const on=env.LIVE_MAX_OPEN_POSITIONS!==undefined&&env.LIVE_MAX_OPEN_POSITIONS!==''&&n>0;
   // RISK_USD sizing has no open-risk cap: it keeps the old 4 positions (2 per direction).
   const riskUsd=String(env.LIVE_SIZING||'').toUpperCase()==='RISK_USD';
   return on?{maxOpen:evenPositions(n,4,20),maxPerDirection:evenPositions(n,4,20)/2}:riskUsd?{maxOpen:4,maxPerDirection:2}:{maxOpen:0,maxPerDirection:0}})(),
  // BALANCE (default): the account balance is read before every entry and the position is
  // sized like the paper one (unit = balance x DCA_UNIT_PCT x leverage, adds 1, 2, 4 ... units
  // at volume zones, stop beyond the last add). RISK_USD: the old fixed LIVE_MAX_RISK_USD sizing.
  sizing:String(env.LIVE_SIZING||'BALANCE').toUpperCase()==='RISK_USD'?'RISK_USD':'BALANCE',
  unitPct:num('DCA_UNIT_PCT',DCA_DEFAULTS.unitPct,.01,10),maxLossPct:num('DCA_MAX_LOSS_PCT',DCA_DEFAULTS.maxLossPct,1,95),maxAdds:clampMaxAdds(env.HOURLY_MAX_ADDS,HOURLY_MAX_ADDS_DEFAULT),
  dailyMaxLossPct:num('LIVE_DAILY_MAX_LOSS_PCT',60,1,100),
  // Size from at most this much of the account (0 = the whole balance). Lets a testnet with 100,000
  // virtual USDT trade like the real $400 account, or a live account use only part of its funds.
  balanceCapUSD:num('LIVE_BALANCE_CAP_USD',0,0,10000000),
  // Optional first-entry margin floor: at least this much margin per unit; 0 = off (default, user 2026-11-13).
  minUnitMarginUSD:num('LIVE_MIN_UNIT_MARGIN_USD',0,0,1000),
  // A new position (entry + all its resting adds) uses at most this share of the equity; every position
  // gets the same size (user 2026-11-13); one that does not fit in the free margin is skipped.
  marginUsePct:num('LIVE_MARGIN_USE_PCT',25,1,100)};
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
 if(parts.some(p=>!(p>0)))return null;
 const riskUSD=Math.min(estimatedStopLossUSD*base/quantity,maxRiskUSD);
 if(contract.quantityUnit==='CONTRACT'){
  const size=Number(contract.contractSizeBase),contracts=Math.round(base/size),cParts=parts.map(p=>Math.round(p/size));
  if(cParts.some(p=>!(p>0)))return null;
  return {base,riskUSD,unit:'CONTRACT',total:contracts,parts:cParts};
 }
 return {base,riskUSD,unit:'BASE_ASSET',total:base,parts};
}

/** Venue quantity grid in base units: BingX lots, Gate.io whole contracts. */
function venueGrid(c){
 if(c.quantityUnit==='CONTRACT')return {step:Number(multiplyDecimal(c.contractSizeBase,c.contractStep&&c.contractStep!=='0'?c.contractStep:'1')),contract:Number(c.contractSizeBase)};
 return {step:Number(c.quantityStep),contract:null};
}
/** 40/35/25 % of a venue quantity, each on the venue grid; the last part takes the rest. */
export function splitParts(total,c){
 const g=venueGrid(c),unit=g.contract?1:g.step,n=Math.round(total/unit+1e-9),a=Math.floor(n*.4),b=Math.floor(n*.35);
 return [a,b,n-a-b].map(k=>g.contract?k:Number((k*unit).toFixed(12)));
}
const venueQty=(base,c)=>{const g=venueGrid(c);return g.contract?Math.round(base/g.contract):Number(base.toFixed(12))};
/** Live split-buy plan from the account balance (BALANCE sizing), the same rule as the paper
 * 1H positions: first entry 1 unit, adds of 1, 2, 4 ... units at the volume zones (15m, then
 * 1h / 4h), stop beyond the last add, worst loss <= maxLossPct of the balance. No zone that
 * fits: one unit with the pattern stop. Quantities are in venue units (lots / contracts). */
export function liveSplitPlan({row,balanceUSD,leverage,sizeScale=1,config}){
 const c=row?.venueContract,inp=row?.paperAddInputs,entry=Number(row?.entry);
 if(!c||!positive(balanceUSD)||!positive(entry)||!positive(leverage))return null;
 const g=venueGrid(c),tick=Number(c.tickSize),minBase=Number(c.minQuantityBase)||0,minNotional=Number(c.minNotionalUSDT)||0;
 if(!positive(g.step)||!positive(tick))return null;
 // Unit margin = balance × unitPct × sizeScale, never below the margin floor (user, 2026-11-13).
 // The per-trade worst-loss cap below and the open-risk cap in the executor still bound it.
 const floorPct=positive(config.minUnitMarginUSD)?config.minUnitMarginUSD/balanceUSD*100:0;
 const unitPct=Math.min(100,Math.max(config.unitPct*sizeScale,floorPct));
 if(config.strategyProfile==='HYBRID')return hybridSplitPlan({row,c,g,tick,minBase,entry,inp,balanceUSD,leverage,sizeScale,config});
 for(const set of inp?.zoneSets||[]){
  const d=planZoneDca({direction:row.direction,entry,atr:inp.atr,zones:set.zones,balanceUSD,leverage,unitPct,tickSize:tick,quantityStep:g.step,
   minQuantity:minBase,minNotional,takerRate:inp.takerRate,settings:{maxLossPct:config.maxLossPct,maxAdds:config.maxAdds}});
  if(!d.ok||!d.adds.length)continue;
  const total=venueQty(d.unitQty,c),parts=splitParts(total,c);if(!(total>0)||parts.some(p=>!(p>0)))continue;
  return {stop:d.stop,zoneSource:set.label,riskUSD:d.full.maxLossUSD,leverage,
   qty:{base:d.unitQty,riskUSD:d.full.maxLossUSD,unit:g.contract?'CONTRACT':'BASE_ASSET',total,parts},
   adds:d.adds.map(a=>({price:a.price,units:a.units,qty:venueQty(a.quantity??a.units*d.unitQty,c),orderId:null,filled:false}))};
 }
 // No zone fits: one unit, pattern stop.
 let base;try{base=Number(roundDecimalToStep(balanceUSD*unitPct/100*leverage/entry,g.step,'DOWN'))}catch{return null}
 const stop=Number(row.stop);if(!(base>0)||base<minBase||(minNotional>0&&base*entry<minNotional)||!positive(stop))return null;
 const total=venueQty(base,c),parts=splitParts(total,c),risk=base*Math.abs(entry-stop);
 if(!(total>0)||parts.some(p=>!(p>0))||risk>balanceUSD*config.maxLossPct/100)return null;
 return {stop,zoneSource:null,riskUSD:risk,leverage,qty:{base,riskUSD:risk,unit:g.contract?'CONTRACT':'BASE_ASSET',total,parts},adds:[]};
}

/** HYBRID: the risk limit sets the size (see planProfile); adds 1·1·2·4… at the first zone set that
 * gives a plan; no zone set -> one entry at the pattern stop, sized the same way. */
function hybridSplitPlan({row,c,g,tick,minBase,entry,inp,balanceUSD,leverage,sizeScale,config}){
 const common={profile:'HYBRID',direction:row.direction,entry,atr:inp?.atr,signalStop:Number(row.stop),balanceUSD,leverage,tickSize:tick,quantityStep:g.step,
  minQuantity:minBase,minNotional:Number(c.minNotionalUSDT)||0,takerRate:inp?.takerRate??.0006,riskPct:config.maxLossPct*sizeScale,schedule:'DOUBLE',spacing:'ZONE'};
 // Each take-profit part (40/35/25 %) must be a valid order on its own (as planZoneDca checks):
 // a plan whose parts would round to 0 or below the minimum is not used.
 const minPart=g.contract?1:Math.max(g.step,minBase);
 const build=(d,label)=>{const total=venueQty(d.entryQty,c);if(!(total>0))return null;
  if(splitParts(total,c).some(p=>!(p>=minPart-1e-12)))return null;
  return {stop:d.stop,zoneSource:label,riskUSD:d.fullLossUSD,leverage,strategyProfile:'HYBRID',
   qty:{base:d.entryQty,riskUSD:d.fullLossUSD,unit:g.contract?'CONTRACT':'BASE_ASSET',total,parts:splitParts(total,c)},
   adds:d.adds.map(a=>({price:a.price,units:Math.round(a.quantity/d.unitQty),qty:venueQty(a.quantity,c),orderId:null,filled:false})).filter(a=>a.qty>0)}};
 if(config.hybridMaxAdds>0&&positive(inp?.atr))for(const set of inp?.zoneSets||[]){
  const d=planProfile({...common,zones:set.zones,maxAdds:config.hybridMaxAdds});
  if(d.ok&&d.adds.length){const out=build(d,set.label);if(out)return out}
 }
 const d=planProfile({...common,atr:positive(inp?.atr)?inp.atr:Math.abs(entry-Number(row.stop))||1,zones:[],maxAdds:0});
 return d.ok?build(d,null):null;
}

/** BingX requests. The entry carries an attached STOP_MARKET so the position is protected from the moment it
 * exists. hedge (the account's mode when the position was opened, bingx_position_mode.mjs): false (default)
 * = one-way, positionSide BOTH with reduce-only exits, unchanged; true = positionSide LONG / SHORT of the
 * position on every order and no reduceOnly (BingX refuses it in hedge mode). */
export function bingxOrders({symbol,direction,stop,targets,qty,clientOrderId,hedge=false}){
 const open=direction==='LONG'?'BUY':'SELL',close=direction==='LONG'?'SELL':'BUY',positionSide=positionSideFor({hedge,direction});
 const m=params=>forMode(params,hedge);
 return {
  entry:{symbol,side:open,positionSide,type:'MARKET',quantity:String(qty.total),clientOrderId,
   stopLoss:JSON.stringify({type:'STOP_MARKET',stopPrice:Number(stop),workingType:'MARK_PRICE'})},
  stop:quantity=>m({symbol,side:close,positionSide,type:'STOP_MARKET',quantity:String(quantity),stopPrice:String(stop),reduceOnly:'true',workingType:'MARK_PRICE'}),
  targets:targets.map((price,i)=>m({symbol,side:close,positionSide,type:'TAKE_PROFIT_MARKET',quantity:String(qty.parts[i]),stopPrice:String(price),reduceOnly:'true',workingType:'MARK_PRICE'})),
  emergencyClose:quantity=>m({symbol,side:close,positionSide,type:'MARKET',quantity:String(quantity),reduceOnly:'true'}),
  breakeven:(price,quantity)=>m({symbol,side:close,positionSide,type:'STOP_MARKET',quantity:String(quantity),stopPrice:String(price),reduceOnly:'true',workingType:'MARK_PRICE'}),
  // Split buys: resting limit adds, and a stop that closes the whole position whatever its size.
  add:(price,quantity,id)=>({symbol,side:open,positionSide,type:'LIMIT',price:String(price),quantity:String(quantity),timeInForce:'GTC',clientOrderId:id}),
  wholeStop:(price,quantity)=>({symbol,side:close,positionSide,type:'STOP_MARKET',quantity:String(quantity),stopPrice:String(price),closePosition:'true',workingType:'MARK_PRICE'})
 };
}

/** A response to a close order is not a position snapshot. Poll without submitting another order. */
export async function waitForFlat(readPosition,sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms))){
 for(let attempt=0;attempt<4;attempt++){
  if(attempt)await sleep(500);
  const position=await readPosition().catch(()=>null);
  if(position?.size===0)return position;
 }
 return null;
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
  breakeven:price=>stopAt(price),
  add:(price,contracts,id)=>({contract,size:sign*contracts,price:String(price),tif:'gtc',text:'t-'+id})
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
 // Coins not on Binance were never part of the validated backtest: testnet only.
 if(config.mode==='LIVE'&&row?.venueOnly)reasons.push('VENUE_ONLY_TESTNET_ONLY');
 else if(!credentials?.[venue])reasons.push('CREDENTIALS_MISSING');
 if(row?.decision?.ready!==true)reasons.push('SIGNAL_NOT_READY');
 // Orders are built per side (positionSide LONG / SHORT in hedge mode): nothing else is ever sent.
 if(row?.direction!=='LONG'&&row?.direction!=='SHORT')reasons.push('DIRECTION_INVALID');
 if(!Array.isArray(row?.targets)||row.targets.length!==3||!positive(row?.stop))reasons.push('PLAN_INCOMPLETE');
 const active=records.filter(r=>['SUBMITTING','OPEN','UNKNOWN'].includes(r.status));
 if(active.some(r=>r.status==='UNKNOWN'))reasons.push('UNRESOLVED_ORDER_STATE');
 if(config.maxOpen>0&&active.length>=config.maxOpen)reasons.push('MAX_OPEN_POSITIONS');
 // Long / short split: half of the even maximum on each side.
 if(config.maxPerDirection>0&&active.filter(r=>r.direction===row?.direction).length>=config.maxPerDirection)reasons.push('MAX_SAME_DIRECTION_POSITIONS');
 if(active.some(r=>r.symbol===row?.symbol))reasons.push('SYMBOL_ALREADY_ACTIVE');
 if(!qty)reasons.push('QUANTITY_BELOW_MINIMUM_AT_LIVE_RISK');
 // Fractional Gate.io contract sizes are not yet verified against the venue: no live order.
 // Decimal contracts sized in whole contracts (order_size_min 0 fallback) are safe to send.
 const vc=row?.venueContract;
 if(venue==='GATEIO'&&vc?.decimalSizes===true&&!(vc.decimalStepFallback===true&&vc.contractStep==='1'))reasons.push('GATEIO_DECIMAL_SIZE_UNVERIFIED');
 const todayRisk=records.filter(r=>r.day===day&&r.status!=='FAILED'&&!r.test).reduce((s,r)=>s+(r.plannedRiskUSD||0),0);
 if(qty&&todayRisk+qty.riskUSD>config.dailyMaxRiskUSD+1e-9)reasons.push('DAILY_RISK_LIMIT');
 return {ok:reasons.length===0,reasons,day,todayRiskUSD:todayRisk};
}
