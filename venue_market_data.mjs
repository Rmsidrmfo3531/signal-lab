// Venue-neutral public market data: contract rules and top of book for the
// execution venues (BingX, Gate.io). Pure functions only: no network, no keys,
// no orders. Binance stays the chart/analysis reference and is only compared here.
import {roundDecimalToStep,multiplyDecimal} from './decimal_grid.mjs';

export const VENUES=Object.freeze(['BINGX','GATEIO']);
export const VENUE_LABELS=Object.freeze({BINGX:'BingX',GATEIO:'Gate.io'});
export const MAX_BOOK_AGE_MS=15000;
const SYMBOL=/^[A-Z0-9]{1,20}USDT$/;
const positive=value=>typeof value==='number'&&Number.isFinite(value)&&value>0;
const num=value=>typeof value==='number'?value:typeof value==='string'&&value.trim()!==''?Number(value):NaN;
const text=value=>typeof value==='string'?value:typeof value==='number'&&Number.isFinite(value)?String(value):'';

/** Canonical symbol used across the app (BTCUSDT) -> venue instrument names. */
export function venueSymbol(venue,symbol){
 if(!SYMBOL.test(symbol??''))throw Error('INVALID_SYMBOL');
 const base=symbol.slice(0,-4);
 if(venue==='BINGX')return base+'-USDT';
 if(venue==='GATEIO')return base+'_USDT';
 throw Error('UNKNOWN_VENUE');
}
export function canonicalSymbol(venue,name){
 const match=venue==='BINGX'?/^([A-Z0-9]{1,20})-USDT$/.exec(name??''):venue==='GATEIO'?/^([A-Z0-9]{1,20})_USDT$/.exec(name??''):null;
 return match?match[1]+'USDT':null;
}
const stepFromPlaces=places=>{
 const n=num(places);
 if(!Number.isSafeInteger(n)||n<0||n>12)return null;
 return n===0?'1':'0.'+'0'.repeat(n-1)+'1';
};

/** BingX USDT-M perpetual contract (GET /openApi/swap/v2/quote/contracts).
 * Quantity is in the base asset; status 1 plus apiStateOpen/apiStateClose "true" = tradable via API. */
export function normalizeBingXContract(raw){
 const symbol=canonicalSymbol('BINGX',raw?.symbol);
 if(!symbol||raw?.currency!=='USDT')return null;
 const tickSize=stepFromPlaces(raw.pricePrecision),quantityStep=stepFromPlaces(raw.quantityPrecision);
 const minQuantity=num(raw.tradeMinQuantity),minNotional=num(raw.tradeMinUSDT);
 const reasons=[];
 if(String(raw.status)!=='1')reasons.push('VENUE_STATUS_INACTIVE');
 if(String(raw.apiStateOpen)!=='true'||String(raw.apiStateClose)!=='true')reasons.push('VENUE_API_TRADING_DISABLED');
 if(!tickSize||!quantityStep)reasons.push('VENUE_PRECISION_INVALID');
 if(!positive(minQuantity))reasons.push('VENUE_MIN_QUANTITY_INVALID');
 return {venue:'BINGX',symbol,venueSymbol:raw.symbol,baseAsset:symbol.slice(0,-4),quoteAsset:'USDT',
  tickSize,quantityStep,quantityUnit:'BASE_ASSET',contractSizeBase:'1',minQuantityBase:positive(minQuantity)?text(raw.tradeMinQuantity):null,
  minNotionalUSDT:positive(minNotional)?minNotional:null,
  takerFeeRate:Number.isFinite(num(raw.takerFeeRate))?num(raw.takerFeeRate):null,makerFeeRate:Number.isFinite(num(raw.makerFeeRate))?num(raw.makerFeeRate):null,
  tradable:reasons.length===0,reasons};
}

/** Gate.io USDT-settled perpetual contract (GET /futures/usdt/contracts).
 * Orders are counted in contracts; one contract = quanto_multiplier base asset. */
export function normalizeGateContract(raw){
 const symbol=canonicalSymbol('GATEIO',raw?.name);
 if(!symbol)return null;
 // enable_decimal contracts accept fractional contract sizes; their size step is
 // order_size_min (as ccxt does). Integer contracts step by one contract.
 const decimalSizes=raw.enable_decimal===true||raw.enable_decimal==='true';
 const multiplier=text(raw.quanto_multiplier),tickSize=text(raw.order_price_round),minContracts=text(raw.order_size_min);
 const reasons=[];
 if(raw.status!==undefined&&raw.status!=='trading')reasons.push('VENUE_STATUS_INACTIVE');
 if(raw.in_delisting===true)reasons.push('VENUE_DELISTING');
 if(raw.type!==undefined&&raw.type!=='direct')reasons.push('VENUE_CONTRACT_NOT_LINEAR');
 if(!positive(num(multiplier))||!positive(num(tickSize)))reasons.push('VENUE_PRECISION_INVALID');
 if(!positive(num(minContracts)))reasons.push('VENUE_MIN_QUANTITY_INVALID');
 let minQuantityBase=null;
 try{if(!reasons.includes('VENUE_PRECISION_INVALID')&&positive(num(minContracts)))minQuantityBase=multiplyDecimal(minContracts,multiplier)}catch{reasons.push('VENUE_PRECISION_INVALID')}
 return {venue:'GATEIO',symbol,venueSymbol:raw.name,baseAsset:symbol.slice(0,-4),quoteAsset:'USDT',
  tickSize:positive(num(tickSize))?tickSize:null,quantityUnit:'CONTRACT',decimalSizes,
  contractStep:decimalSizes&&positive(num(minContracts))?minContracts:'1',
  quantityStep:positive(num(multiplier))?(()=>{try{return decimalSizes&&positive(num(minContracts))?multiplyDecimal(minContracts,multiplier):multiplier}catch{return null}})():null,
  contractSizeBase:positive(num(multiplier))?multiplier:null,minContracts:positive(num(minContracts))?num(minContracts):null,minQuantityBase,
  minNotionalUSDT:null,markPrice:positive(num(raw.mark_price))?num(raw.mark_price):null,tradable:reasons.length===0,reasons};
}

const level=(price,size)=>{const p=num(price),s=num(size);return positive(p)&&Number.isFinite(s)&&s>=0?[p,s]:null};
/** Top of book from a venue depth response, validated and time-stamped. */
/** clockOffsetMs = venue clock - local clock (measured from the venue's server time).
 * Source times are converted to the local clock so every freshness check downstream
 * stays correct on a PC whose clock is a few seconds off. */
export function normalizeBook(venue,raw,{receivedAt=Date.now(),now=Date.now(),maxAgeMs=MAX_BOOK_AGE_MS,clockOffsetMs=0}={}){
 const reasons=[];let bids=[],asks=[],sourceTime=null;
 if(venue==='BINGX'){
  bids=(Array.isArray(raw?.bids)?raw.bids:[]).map(x=>Array.isArray(x)?level(x[0],x[1]):null);
  asks=(Array.isArray(raw?.asks)?raw.asks:[]).map(x=>Array.isArray(x)?level(x[0],x[1]):null);
  sourceTime=num(raw?.T??raw?.ts);
 }else if(venue==='GATEIO'){
  bids=(Array.isArray(raw?.bids)?raw.bids:[]).map(x=>level(x?.p,x?.s));
  asks=(Array.isArray(raw?.asks)?raw.asks:[]).map(x=>level(x?.p,x?.s));
  // Futures order books report `current` in seconds (fractional); accept milliseconds too.
  const current=num(raw?.current);sourceTime=Number.isFinite(current)?(current<1e12?Math.round(current*1000):current):NaN;
 }else throw Error('UNKNOWN_VENUE');
 if(bids.some(x=>!x)||asks.some(x=>!x)||!bids.length||!asks.length)reasons.push('BOOK_MISSING_OR_MALFORMED');
 // Best bid = highest, best ask = lowest, whatever order the venue returns.
 const bid=bids.filter(Boolean).reduce((best,x)=>!best||x[0]>best[0]?x:best,null),ask=asks.filter(Boolean).reduce((best,x)=>!best||x[0]<best[0]?x:best,null);
 if(bid&&ask&&bid[0]>=ask[0])reasons.push('BOOK_CROSSED');
 if(positive(sourceTime)&&Number.isFinite(clockOffsetMs))sourceTime-=clockOffsetMs;
 if(!positive(sourceTime))reasons.push('BOOK_TIME_MISSING');
 else if(sourceTime>receivedAt+2000||now-sourceTime>maxAgeMs)reasons.push('BOOK_STALE');
 const mid=bid&&ask?(bid[0]+ask[0])/2:null;
 // Depth levels kept best-first in the venue's own size unit (Gate.io: contracts;
 // BingX linear swap: base asset, as parsed by ccxt; BingX docs do not name the unit).
 const sorted=(rows,dir)=>rows.filter(Boolean).sort((a,b)=>dir*(a[0]-b[0])).slice(0,20);
 return {venue,ok:reasons.length===0,reasons,bid:bid?.[0]??null,ask:ask?.[0]??null,mid,
  spreadBps:mid&&bid&&ask?(ask[0]-bid[0])/mid*10000:null,sourceTime:positive(sourceTime)?sourceTime:null,receivedAt,
  ageMs:positive(sourceTime)?Math.max(0,now-sourceTime):null,
  levels:{bids:sorted(bids,-1),asks:sorted(asks,1),sizeUnit:venue==='GATEIO'?'CONTRACT':'BASE_ASSET'}};
}

const bps=(a,b)=>positive(a)&&positive(b)?(a-b)/b*10000:null;
/** One comparison row: both venues against each other and against the Binance chart price. */
export function compareVenues(symbol,{bingx,gateio,binancePrice}={}){
 const books={BINGX:bingx?.book,GATEIO:gateio?.book},usable=VENUES.filter(v=>books[v]?.ok&&positive(books[v].mid));
 const row={symbol,venues:{},crossVenueMidBps:null,cheapestAsk:null,richestBid:null,binanceChartPrice:positive(binancePrice)?binancePrice:null};
 for(const venue of VENUES){
  const entry=venue==='BINGX'?bingx:gateio;
  row.venues[venue]={contract:entry?.contract??null,book:entry?.book??null,error:entry?.error??null,
   vsBinanceBps:entry?.book?.ok?bps(entry.book.mid,binancePrice):null};
 }
 if(usable.length===2)row.crossVenueMidBps=bps(books.BINGX.mid,books.GATEIO.mid);
 if(usable.length){
  row.cheapestAsk=usable.reduce((a,b)=>books[b].ask<books[a].ask?b:a);
  row.richestBid=usable.reduce((a,b)=>books[b].bid>books[a].bid?b:a);
 }
 return row;
}

/** Round a base-asset quantity to a venue's order grid (base or contracts). Display/planning only. */
export function venueQuantity(contract,baseQuantity){
 if(!contract?.tradable||!positive(baseQuantity))return null;
 if(contract.quantityUnit==='BASE_ASSET'){const q=roundDecimalToStep(baseQuantity,contract.quantityStep,'DOWN');return {orderQuantity:q,unit:'BASE_ASSET',baseQuantity:Number(q)}}
 // Whole contracts, or multiples of order_size_min for decimal-size contracts.
 const contracts=roundDecimalToStep(baseQuantity/Number(contract.contractSizeBase)*(1+1e-9),contract.contractStep||'1','DOWN');
 return {orderQuantity:contracts,unit:'CONTRACT',baseQuantity:Number(multiplyDecimal(contracts,contract.contractSizeBase))};
}
