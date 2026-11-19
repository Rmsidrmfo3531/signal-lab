// Zone-based scale-in plan (paper only).
// The first entry is 1 unit; each further add sits on the next volume zone (HVN)
// against the position and doubles the size: 1, 1, 2, 4, 8, ... units. maxAdds (5-10, default 10)
// caps how many adds the plan may use.
// The stop sits just beyond the last zone used. Cross margin: the whole balance backs
// the position, so the plan drops the farthest adds until
//   - the margin of every entry fits in the balance, and
//   - the stop is reached clearly before the cross-margin liquidation price, and
//   - the loss at the stop with every add filled stays within maxLossPct of the balance.
import {roundDecimalToStep} from './decimal_grid.mjs';

export const DCA_UNITS=Object.freeze([1,1,2,4,8,16,32,64,128,256,512]);
// Profile settings for the deeper zone window (15m candles over `days`, finer bins, smaller peaks kept).
export const DCA_DEEP_PROFILE=days=>({candles:Math.min(1500,Math.round(days*96)),minCandles:96,targetBins:240,hvnMinFractionOfPoc:.05});
// Zone window per scalp timeframe. A 1m scalp lives at most 24 minutes, so 14-day zones only push
// its stop far away (first paper trade: JCTUSDT stop 37% below entry) and are never reached: it
// uses the 3-day zones. 5m / 15m keep the configured window.
export const dcaZoneDaysFor=(interval,zoneDays)=>interval==='1m'?3:zoneDays;
// 1H split buys stop adding after 7 (HOURLY_MAX_ADDS, 5-10). 180-day / 12-symbol replay, $400:
// 10 adds +$1079, first half -$59, max drawdown -$181, worst trade -24.6 % of the balance;
// 7 adds +$1150, first half +$12, max drawdown -$134, worst trade -12.7 % (without the single best
// trade: 7 -> +$532, 8 -> +$504, 10 -> +$461, 6 -> +$348).
export const HOURLY_MAX_ADDS_DEFAULT=7;
// 0 = no adds (entry only, stop beyond the first zone); user request 2026-11-13.
export const DCA_MAX_ADDS_RANGE=Object.freeze({min:0,max:10});
export const clampZoneDays=v=>{const n=Math.round(Number(v));return Number.isFinite(n)&&v!==''&&v!=null?Math.max(3,Math.min(15,n)):DCA_DEFAULTS.zoneDays};
export const clampMaxAdds=(v,fallback=DCA_DEFAULTS.maxAdds)=>{const n=Math.round(Number(v));return Number.isFinite(n)&&v!==''&&v!=null?Math.max(DCA_MAX_ADDS_RANGE.min,Math.min(DCA_MAX_ADDS_RANGE.max,n)):fallback};
// maxLossPct: loss at the stop with every add filled may not exceed this share of the balance.
export const DCA_DEFAULTS=Object.freeze({leverage:10,unitPct:.19,maintenanceRate:.005,stopAtr:.25,minSpacingAtr:.5,liquidationBufferPct:1,maxLossPct:30,maxAdds:10,zoneDays:14});
const positive=x=>typeof x==='number'&&Number.isFinite(x)&&x>0;

/** Cross-margin liquidation price for one position backed by `balance`. */
export function crossLiquidationPrice({direction,quantity,cost,balance,maintenanceRate=DCA_DEFAULTS.maintenanceRate}){
 if(!positive(quantity)||!positive(cost)||!(balance>0))return null;
 const x=direction==='LONG'?(cost-balance)/(quantity*(1-maintenanceRate)):(balance+cost)/(quantity*(1+maintenanceRate));
 return x>0?x:null; // LONG with more balance than cost: no liquidation price above zero
}

export function planZoneDca({direction,entry,atr,zones=[],balanceUSD,leverage=DCA_DEFAULTS.leverage,unitPct=DCA_DEFAULTS.unitPct,
 tickSize,quantityStep,minQuantity=0,minNotional=0,takerRate=.0006,units=DCA_UNITS,settings={}}={}){
 const s={...DCA_DEFAULTS,...settings},dir=direction==='LONG'?1:-1,reasons=[];
 if(!['LONG','SHORT'].includes(direction)||!positive(entry)||!positive(atr))reasons.push('DCA_INPUT_INVALID');
 if(!positive(balanceUSD))reasons.push('DCA_BALANCE_INVALID');
 if(!(leverage>=1&&leverage<=125))reasons.push('DCA_LEVERAGE_INVALID');
 if(!(unitPct>0&&unitPct<=100))reasons.push('DCA_UNIT_PCT_INVALID');
 if(!positive(tickSize)||!positive(quantityStep))reasons.push('DCA_GRID_INVALID');
 if(reasons.length)return {ok:false,reasons};
 // One unit: balance x unitPct margin at the leverage, on the lot step. Its smallest
 // take-profit part (25 %) must still be a valid order on its own.
 const unitNotional=balanceUSD*unitPct/100*leverage;
 let unitQty;try{unitQty=Number(roundDecimalToStep(unitNotional/entry,quantityStep,'DOWN'))}catch{unitQty=0}
 let smallest=0;try{smallest=Number(roundDecimalToStep(unitQty*.25+quantityStep*1e-6,quantityStep,'DOWN'))}catch{}
 if(!positive(unitQty)||unitQty<minQuantity||unitQty*entry<minNotional||!(smallest>=Math.max(minQuantity,quantityStep)))return {ok:false,reasons:['DCA_UNIT_BELOW_MINIMUM_ORDER'],unitNotional};
 // Zones against the position, nearest first, at least minSpacing apart (and from the entry).
 const spacing=s.minSpacingAtr*atr,edge=z=>dir===1?z.priceHigh:z.priceLow,far=z=>dir===1?z.priceLow:z.priceHigh;
 const against=zones.filter(z=>positive(z?.priceLow)&&positive(z?.priceHigh)&&dir*(entry-edge(z))>=spacing)
  .sort((a,b)=>dir*(edge(b)-edge(a)));
 const picked=[];
 const addCap=Math.min(units.length-1,clampMaxAdds(s.maxAdds));
 // With 0 adds one zone is still picked: the stop goes beyond it.
 for(const z of against){if(picked.length>=Math.max(1,addCap))break;if(picked.length&&dir*(edge(picked.at(-1))-edge(z))<spacing)continue;picked.push(z)}
 const round=(p,mode)=>{if(!positive(p))return 0;try{return Number(roundDecimalToStep(p,tickSize,mode))}catch{return 0}};
 const build=count=>{
  const levels=picked.slice(0,count).map((z,i)=>({price:round(edge(z),dir===1?'DOWN':'UP'),units:units[i+1],quantity:Number((units[i+1]*unitQty).toFixed(12)),zone:{priceLow:z.priceLow,priceHigh:z.priceHigh,volume:z.peakVolume??z.volume}}));
  // Stop: beyond the last zone used (or beyond the first zone if there is no add yet).
  const stopZone=count?picked[count-1]:picked[0];
  if(!stopZone)return null;
  const stop=round(far(stopZone)-dir*s.stopAtr*atr,dir===1?'DOWN':'UP');
  if(!positive(stop)||dir*(entry-stop)<=0||levels.some((l,i)=>!positive(l.price)||dir*(entry-l.price)<=0||(i>0&&dir*(levels[i-1].price-l.price)<=0)||dir*(l.price-stop)<=0))return null;
  const fills=[{price:entry,quantity:unitQty},...levels];
  const quantity=fills.reduce((a,f)=>a+f.quantity,0),cost=fills.reduce((a,f)=>a+f.quantity*f.price,0);
  const margin=fills.reduce((a,f)=>a+f.quantity*f.price/leverage,0);
  const fees=cost*takerRate+quantity*stop*takerRate;
  const maxLossUSD=dir*(cost-quantity*stop)+fees;
  const liquidationPrice=crossLiquidationPrice({direction,quantity,cost,balance:balanceUSD,maintenanceRate:s.maintenanceRate});
  const safe=liquidationPrice===null||dir*(stop-liquidationPrice*(1+dir*s.liquidationBufferPct/100))>0;
  return {levels,stop,quantity,cost,averageEntry:cost/quantity,marginUSD:margin,maxLossUSD,maxLossPct:maxLossUSD/balanceUSD*100,liquidationPrice,
   fits:margin<=balanceUSD&&maxLossUSD<=balanceUSD*s.maxLossPct/100&&safe,
   limits:{marginFits:margin<=balanceUSD,lossWithinCap:maxLossUSD<=balanceUSD*s.maxLossPct/100,stopBeforeLiquidation:safe}};
 };
 if(!picked.length)return {ok:false,reasons:['DCA_NO_VOLUME_ZONE_AGAINST_ENTRY']};
 let plan=null,count=Math.min(picked.length,addCap);
 for(;count>=0;count--){plan=build(count);if(plan?.fits)break}
 if(!plan?.fits)return {ok:false,reasons:['DCA_LOSS_OR_LIQUIDATION_LIMIT'],unitQty};
 return {ok:true,direction,entry,unitQty,unitNotional:unitQty*entry,leverage,unitPct,balanceUSD,
  adds:plan.levels,addsDropped:Math.min(picked.length,addCap)-count,stop:plan.stop,
  full:{quantity:plan.quantity,averageEntry:plan.averageEntry,marginUSD:plan.marginUSD,maxLossUSD:plan.maxLossUSD,maxLossPct:plan.maxLossPct,liquidationPrice:plan.liquidationPrice},
  maxAdds:addCap,marginMode:'CROSS',maintenanceRate:s.maintenanceRate,maxLossPctCap:s.maxLossPct,method:'HVN_ZONES_1_1_2_4',calculationOnly:true};
}

// ---------------------------------------------------------------------------------------------
// Strategy profiles for research comparison (stage 3, 2026-11-13). planZoneDca above stays the
// CURRENT live rule and is not changed by anything below.
//  CURRENT        — planZoneDca: unit = balance x unitPct x leverage, adds 1·1·2·4… at volume zones,
//                   adds dropped until the full loss fits maxLossPct.
//  HYBRID         — the first quantity is worked back from the risk limit: the loss at the stop
//                   with every add filled = balance x riskPct. Add count, size schedule and spacing
//                   (volume zone / fixed % / ATR) are options; 0 adds = one entry at the pattern stop.
//  TRADER_REPLICA — comparison only. Rules read from the trader's Telegram log (2026-06-21 ~ 11-11):
//                   adds double the position (confirmed); spacing from the entry 1.8 / 3.6 / 6.9 /
//                   9.7 / 13.9 / 17.4 / 18.4 % (ASSUMED: medians of the log); take profit about
//                   0.56 % above the average for the whole position (ASSUMED); no stop seen in the log
//                   (ASSUMED: none; only the account liquidation ends a losing trade); first margin
//                   ASSUMED 1 % of the balance at 20x (median leverage in the log).
export const STRATEGY_PROFILES=Object.freeze(['CURRENT','HYBRID','TRADER_REPLICA']);
export const SIZE_SCHEDULES=Object.freeze({
 DOUBLE:Object.freeze([1,1,2,4,8,16,32,64,128,256,512]), // 1·1·2·4·8 = 16 units with 4 adds
 FIXED:Object.freeze([1,1,1,1,1,1,1,1,1,1,1]),
 GENTLE:Object.freeze([1,1,1.5,2,2.5,3,3.5,4,4.5,5,5.5])});
export const TRADER_REPLICA_ASSUMPTIONS=Object.freeze({spacingFromEntryPct:Object.freeze([1.8,3.6,6.9,9.7,13.9,17.4,18.4]),takeProfitFromAveragePct:.56,
 firstMarginPct:1,leverage:20,stop:null,source:'TELEGRAM_LOG_MEDIANS_ASSUMED'});

/** Add prices against the position: 'ZONE' (volume zones), 'PCT' (every spacingPct %), 'ATR' (every spacingAtr ATR). */
export function addPrices({direction,entry,atr,zones=[],spacing='ZONE',count,spacingPct=2,spacingAtr=1.5,minSpacingAtr=DCA_DEFAULTS.minSpacingAtr}){
 const dir=direction==='LONG'?1:-1;
 if(count<=0)return [];
 if(spacing==='PCT')return Array.from({length:count},(_,i)=>({price:entry*(1-dir*spacingPct/100*(i+1))}));
 if(spacing==='ATR')return Array.from({length:count},(_,i)=>({price:entry-dir*spacingAtr*atr*(i+1)}));
 const gap=minSpacingAtr*atr,edge=z=>dir===1?z.priceHigh:z.priceLow,far=z=>dir===1?z.priceLow:z.priceHigh,out=[];
 for(const z of zones.filter(z=>positive(z?.priceLow)&&positive(z?.priceHigh)&&dir*(entry-edge(z))>=gap).sort((a,b)=>dir*(edge(b)-edge(a)))){
  if(out.length>=count)break;if(out.length&&dir*(out.at(-1).price-edge(z))<gap)continue;out.push({price:edge(z),farEdge:far(z)});
 }
 return out;
}

/**
 * Research plan for one signal under a profile. Returns {ok, unitQty, entryQty, adds:[{price,quantity}], stop,
 * fullLossUSD, marginUSD, targetsFromAveragePct?} or {ok:false, reasons}. Quantities in base asset.
 *  signalStop: the pattern stop (used with 0 adds). riskPct: account risk limit for HYBRID (default 1).
 */
export function planProfile({profile='HYBRID',direction,entry,atr,zones=[],signalStop,balanceUSD,leverage=DCA_DEFAULTS.leverage,tickSize,quantityStep,minQuantity=0,minNotional=0,takerRate=.0006,
 riskPct=1,maxAdds=4,schedule='DOUBLE',spacing='ZONE',spacingPct=2,spacingAtr=1.5,stopAtr=DCA_DEFAULTS.stopAtr,unitPct=DCA_DEFAULTS.unitPct,maxLossPct=DCA_DEFAULTS.maxLossPct,maxMarginPct=100}={}){
 const dir=direction==='LONG'?1:-1;
 if(!['LONG','SHORT'].includes(direction)||!positive(entry)||!positive(atr)||!positive(balanceUSD)||!positive(tickSize)||!positive(quantityStep))return {ok:false,reasons:['PROFILE_INPUT_INVALID']};
 const roundQty=q=>{try{return Number(roundDecimalToStep(q,quantityStep,'DOWN'))}catch{return 0}};
 const roundPx=(p,mode)=>{if(!positive(p))return 0;try{return Number(roundDecimalToStep(p,tickSize,mode))}catch{return 0}};
 const tooSmall=q=>!positive(q)||q<minQuantity||q*entry<minNotional;
 if(profile==='CURRENT'){
  const d=planZoneDca({direction,entry,atr,zones,balanceUSD,leverage,unitPct,tickSize,quantityStep,minQuantity,minNotional,takerRate,settings:{maxLossPct,maxAdds}});
  if(!d.ok)return d;
  return {ok:true,profile,unitQty:d.unitQty,entryQty:d.unitQty,adds:d.adds.map(a=>({price:a.price,quantity:a.quantity})),stop:d.stop,fullLossUSD:d.full.maxLossUSD,marginUSD:d.full.marginUSD};
 }
 if(profile==='TRADER_REPLICA'){
  const A=TRADER_REPLICA_ASSUMPTIONS,units=SIZE_SCHEDULES.DOUBLE;
  const unitQty=roundQty(balanceUSD*A.firstMarginPct/100*A.leverage/entry);if(tooSmall(unitQty))return {ok:false,reasons:['PROFILE_UNIT_BELOW_MINIMUM_ORDER']};
  const adds=A.spacingFromEntryPct.slice(0,Math.max(0,maxAdds)).map((pct,i)=>({price:roundPx(entry*(1-dir*pct/100),dir===1?'DOWN':'UP'),quantity:roundQty(units[i+1]*unitQty)})).filter(a=>positive(a.price)&&positive(a.quantity));
  // No stop: a price far beyond any add (the engine's account liquidation ends it first).
  const stop=dir===1?roundPx(entry*.01,'DOWN')||tickSize:roundPx(entry*100,'UP');
  const qty=unitQty+adds.reduce((s,a)=>s+a.quantity,0),cost=unitQty*entry+adds.reduce((s,a)=>s+a.quantity*a.price,0);
  return {ok:true,profile,unitQty,entryQty:unitQty,adds,stop,fullLossUSD:null,marginUSD:cost/A.leverage,leverage:A.leverage,targetsFromAveragePct:[A.takeProfitFromAveragePct],assumed:true,quantity:qty};
 }
 if(profile!=='HYBRID')return {ok:false,reasons:['PROFILE_UNKNOWN']};
 const units=SIZE_SCHEDULES[schedule];if(!units)return {ok:false,reasons:['PROFILE_SCHEDULE_UNKNOWN']};
 const count=Math.max(0,Math.min(Math.round(maxAdds),units.length-1));
 const prices=addPrices({direction,entry,atr,zones,spacing,count,spacingPct,spacingAtr});
 if(count>0&&!prices.length)return {ok:false,reasons:['PROFILE_NO_ADD_LEVEL']};
 let stop;
 if(!prices.length){if(!positive(signalStop)||dir*(entry-signalStop)<=0)return {ok:false,reasons:['PROFILE_STOP_INVALID']};stop=signalStop}
 else{const last=prices.at(-1),beyond=last.farEdge??last.price;stop=roundPx(beyond-dir*stopAtr*atr,dir===1?'DOWN':'UP')}
 if(!positive(stop)||dir*(entry-stop)<=0)return {ok:false,reasons:['PROFILE_STOP_INVALID']};
 const levels=prices.map((p,i)=>({price:roundPx(p.price,dir===1?'DOWN':'UP'),units:units[i+1]}));
 if(levels.some((l,i)=>!positive(l.price)||dir*(entry-l.price)<=0||(i>0&&dir*(levels[i-1].price-l.price)<=0)||dir*(l.price-stop)<=0))return {ok:false,reasons:['PROFILE_STOP_INVALID']};
 // Loss per one unit of quantity with everything filled, fees at entry and stop included.
 const fills=[{price:entry,units:units[0]},...levels];
 const perUnit=fills.reduce((s,f)=>s+f.units*(dir*(f.price-stop)+(f.price+stop)*takerRate),0);
 if(!(perUnit>0))return {ok:false,reasons:['PROFILE_STOP_INVALID']};
 const riskUSD=balanceUSD*riskPct/100;
 let unitQty=roundQty(riskUSD/perUnit);
 // Margin with every add filled must fit the share of the balance allowed.
 const notionalPerUnit=fills.reduce((s,f)=>s+f.units*f.price,0);
 if(unitQty*notionalPerUnit/leverage>balanceUSD*maxMarginPct/100)unitQty=roundQty(balanceUSD*maxMarginPct/100*leverage/notionalPerUnit);
 if(tooSmall(unitQty))return {ok:false,reasons:['PROFILE_UNIT_BELOW_MINIMUM_ORDER'],riskUSD,perUnit};
 const adds=levels.map(l=>({price:l.price,quantity:roundQty(l.units*unitQty)})).filter(a=>a.quantity>0);
 const fullLossUSD=unitQty*units[0]*(dir*(entry-stop)+(entry+stop)*takerRate)+adds.reduce((s,a)=>s+a.quantity*(dir*(a.price-stop)+(a.price+stop)*takerRate),0);
 return {ok:true,profile,unitQty,entryQty:unitQty*units[0],adds,stop,fullLossUSD,marginUSD:(unitQty*entry+adds.reduce((s,a)=>s+a.quantity*a.price,0))/leverage,riskUSD};
}
