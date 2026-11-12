// Paper execution on the actual trading venues (BingX, Gate.io). Binance supplies
// the chart analysis only; sizing, entry basis and fills use the venue contract
// rules and the venue order book. Pure functions: no network, no keys, no orders.
import {estimateBinanceExecution,BINANCE_PAPER_ASSUMPTIONS} from './binance_execution.mjs';
import {roundDecimalToStep,multiplyDecimal} from './decimal_grid.mjs';
import {VENUES} from './venue_market_data.mjs';

const positive=value=>typeof value==='number'&&Number.isFinite(value)&&value>0;

export function parsePaperVenues(value){
 const list=String(value??'').split(',').map(x=>x.trim().toUpperCase()).filter(x=>VENUES.includes(x));
 return list.length?[...new Set(list)]:[...VENUES];
}

/** Venue contract + book in the shape the verified sizing model expects.
 * Sizes are converted to base asset (Gate.io contracts x quanto_multiplier). */
export function venueSizingInputs(contract,book){
 if(!contract||!book?.levels)return null;
 const toBase=contract.quantityUnit==='CONTRACT'?size=>size*Number(contract.contractSizeBase):size=>size;
 const levels=rows=>rows.map(([price,size])=>[String(price),String(toBase(size))]);
 // Gate.io has no minimum order value; its minimum is order_size_min contracts.
 const minNotional=positive(contract.minNotionalUSDT)?contract.minNotionalUSDT:
  positive(Number(contract.minQuantityBase))&&positive(book.ask)?Number(contract.minQuantityBase)*book.ask:NaN;
 return {
  market:{symbol:contract.symbol,status:contract.tradable?'TRADING':'BREAK',contractType:'PERPETUAL',quoteAsset:'USDT',
   filters:{PRICE_FILTER:{tickSize:contract.tickSize},LOT_SIZE:{stepSize:contract.quantityStep,minQty:contract.minQuantityBase},
    MIN_NOTIONAL:{notional:String(minNotional)}}},
  book:{T:book.sourceTime,bids:levels(book.levels.bids),asks:levels(book.levels.asks)}
 };
}

/** Venue fee assumption: never below the conservative paper default. */
export function venueCosts(contract,spreadBps){
 const taker=Math.max(BINANCE_PAPER_ASSUMPTIONS.takerRate,positive(contract?.takerFeeRate)?contract.takerFeeRate:0);
 const maker=Math.max(BINANCE_PAPER_ASSUMPTIONS.makerRate,positive(contract?.makerFeeRate)?contract.makerFeeRate:0);
 return {makerRate:maker,takerRate:taker,slippageBps:BINANCE_PAPER_ASSUMPTIONS.slippageBps,spreadBps,
  fundingRate:BINANCE_PAPER_ASSUMPTIONS.fundingReserveRate,assumption:'EXPLICIT_PAPER_ASSUMPTIONS'};
}

/** Stop on the venue tick, rounded away from entry (never tighter than the chart stop). */
export function venueStop(stop,direction,tickSize){
 return Number(roundDecimalToStep(stop,tickSize,direction==='LONG'?'DOWN':'UP'));
}

/** Evaluate each tradable venue and pick the one with the better executable entry.
 * venues: {BINGX:{contract,book},GATEIO:{contract,book}} */
export function selectExecutionVenue({signal,venues={},allowed=VENUES,now=Date.now(),maxRiskUSD=6,maxNotionalUSD}={}){
 const candidates=[];
 for(const venue of allowed){
  const entry=venues[venue],reasons=[];
  if(!entry?.contract){candidates.push({venue,eligible:false,reasons:['VENUE_NOT_LISTED']});continue}
  if(!entry.contract.tradable){candidates.push({venue,eligible:false,reasons:entry.contract.reasons?.length?entry.contract.reasons:['VENUE_NOT_TRADABLE']});continue}
  if(!entry.book?.ok){candidates.push({venue,eligible:false,reasons:entry.book?.reasons?.length?entry.book.reasons:['VENUE_BOOK_UNAVAILABLE']});continue}
  const inputs=venueSizingInputs(entry.contract,entry.book);
  const stop=venueStop(signal.stop,signal.direction,entry.contract.tickSize);
  const estimate=estimateBinanceExecution({signal:{...signal,stop},book:inputs.book,market:inputs.market,now,maxRiskUSD,...(maxNotionalUSD?{maxNotionalUSD}:{})});
  reasons.push(...estimate.reasons);
  candidates.push({venue,eligible:estimate.eligible,reasons,estimate,stop,inputs});
 }
 const eligible=candidates.filter(c=>c.eligible),sign=signal?.direction==='SHORT'?-1:1;
 // Better = lower entry for LONG, higher for SHORT; ties keep the listed order.
 const chosen=eligible.reduce((best,c)=>!best||sign*(c.estimate.entryBasis-best.estimate.entryBasis)<0?c:best,null);
 return {chosen,candidates:candidates.map(({venue,eligible,reasons,estimate})=>({venue,eligible,reasons,entryBasis:estimate?.entryBasis??null}))};
}

/** Venue order size for display: base quantity for BingX, whole contracts for Gate.io. */
/** Live order on another venue than the paper one: when the paper venue has no live keys (or is
 * not enabled), the same signal goes to the first venue in `alternatives` that is enabled, has
 * keys and lists the coin. Stop and targets move onto that venue's tick grid: the stop away from
 * the entry (never tighter), the targets toward the entry (never further). Null: no venue fits. */
export function routeLiveSignal(row,{enabled=[],credentials={}}={}){
 const ok=v=>enabled.includes(v)&&credentials[v]===true;
 if(!row||ok(row.executionVenue))return row;
 const alt=(row.liveAlternatives||[]).find(a=>ok(a.venue)&&a.venueSymbol&&a.venueContract&&positive(Number(a.venueContract.tickSize)));
 if(!alt)return row;
 const tick=String(alt.venueContract.tickSize),dir=row.direction==='LONG'?1:-1;
 const targets=(row.targets||[]).map(t=>Number(roundDecimalToStep(t,tick,dir===1?'DOWN':'UP')));
 return {...row,executionVenue:alt.venue,venueSymbol:alt.venueSymbol,venueContract:alt.venueContract,stop:venueStop(row.rawStop??row.stop,row.direction,alt.venueContract.tickSize),
  targets,liveRoutedFrom:row.executionVenue};
}

export function venueOrderQuantity(contract,baseQuantity){
 if(!contract||!positive(baseQuantity))return null;
 if(contract.quantityUnit!=='CONTRACT')return {quantity:String(baseQuantity),unit:'BASE_ASSET'};
 const step=contract.contractStep||'1',contracts=roundDecimalToStep(baseQuantity/Number(contract.contractSizeBase)*(1+1e-9),step,'DOWN');
 return {quantity:contracts,unit:'CONTRACT',baseQuantity:Number(multiplyDecimal(contracts,contract.contractSizeBase))};
}
