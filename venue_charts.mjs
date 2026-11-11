// Chart data from the execution venues (Gate.io, BingX) for coins Binance does not list.
// Rows are converted to the Binance kline layout the engine reads:
// [openTime, open, high, low, close, baseVolume, closeTime, quoteVolume].
// Stocks, ETFs, indexes and commodities are excluded: only coins are added.
export const VENUE_INTERVAL_MS=Object.freeze({'15m':900000,'1h':3600000,'4h':14400000});
// BingX lists stocks/commodities with an NC prefix; for Gate.io these are known non-coin tickers.
export const NON_CRYPTO_BASES=new Set(['XAU','XAG','XPT','XPD','CL','BZ','NG','COPPER','COPP','UKOIL','USOIL','US30','US100','US500','US400','DXI','VXI','SPCX',
 'NVDA','INTC','AMD','AAPL','TSLA','AMZN','MSFT','META','GOOGL','GOOG','NFLX','ORCL','AVGO','PLTR','MSTR','COIN','HOOD','CRCL','NBIS','CRWV','AAOI','AXTI',
 'MU','MUU','TSM','ARM','SMCI','BABA','GME','AMC','QQQ','SPY','IWM','TQQQ','SQQQ','SOXL','SOXS','SAMSUNG','SKHYNIX','SKHY','KORU','SNDK','CXMT','ZHIPU',
 'OPENAI','SNXX','CIRCLE','RDDT','UBER','SHOP','SNOW','IBM','DIS','JPM','BAC','V','MA','WMT','KO','PEP','NKE','XOM','CVX','LLY','UNH','HYUNDAI','LG','KRX',
 'ANTHROPIC','SPACEX','XIAOMI','TENCENT','NIO','LI','XPEV','BIDU','JD','PDD','EWJ','EWY','FXI','GLD','SLV','USO','TLT','UVXY','VIX']);
export const isCoinSymbol=symbol=>{const base=String(symbol).replace(/USDT$/,'');return /^[A-Z0-9]{1,20}$/.test(base)&&!/^NC/.test(base)&&!NON_CRYPTO_BASES.has(base)};

const n=v=>Number(v);
/** Gate.io /futures/usdt/candlesticks rows ({t seconds,o,h,l,c,v contracts,sum quote}) -> Binance layout. */
export function gateKlineRows(data,interval,{multiplier=1}={}){
 const ms=VENUE_INTERVAL_MS[interval];if(!ms||!Array.isArray(data))return null;
 const rows=data.map(k=>{const open=n(k.t)*1000,close=n(k.c),quote=n(k.sum),base=Number.isFinite(quote)&&close>0?quote/close:n(k.v)*n(multiplier);
  return [open,n(k.o),n(k.h),n(k.l),close,base,open+ms-1,Number.isFinite(quote)?quote:base*close]});
 return rows.every(r=>r.every(Number.isFinite))?rows.sort((a,b)=>a[0]-b[0]):null;
}
/** BingX /swap/v3/quote/klines rows ({open,close,high,low,volume base,time ms}) -> Binance layout. */
export function bingxKlineRows(data,interval){
 const ms=VENUE_INTERVAL_MS[interval];if(!ms||!Array.isArray(data))return null;
 const rows=data.map(k=>{const open=n(k.time),close=n(k.close),base=n(k.volume);return [open,n(k.open),n(k.high),n(k.low),close,base,open+ms-1,base*close]});
 return rows.every(r=>r.every(Number.isFinite))?rows.sort((a,b)=>a[0]-b[0]):null;
}
/** 24h quote volume by symbol (BTCUSDT form) from Gate.io and BingX tickers. */
export function venueVolumes({gateTickers=[],bingxTickers=[]}={}){
 const out=new Map(),put=(symbol,venue,volume,price)=>{if(!Number.isFinite(volume))return;const old=out.get(symbol);
  if(!old||volume>old.quoteVolume)out.set(symbol,{symbol,venue,quoteVolume:volume,price:Number.isFinite(price)?price:old?.price??null})};
 for(const t of Array.isArray(gateTickers)?gateTickers:[])put(String(t.contract).replace('_',''),'GATEIO',n(t.volume_24h_quote),n(t.last));
 for(const t of Array.isArray(bingxTickers)?bingxTickers:[])put(String(t.symbol).replace('-',''),'BINGX',n(t.quoteVolume),n(t.lastPrice));
 return out;
}
/**
 * Coins listed on Gate.io / BingX (tradable) but not on Binance, with enough volume.
 * minVolume: a number, or null to use referenceRatio x the smallest volume among the reference symbols.
 */
export function selectVenueOnlyCoins({binanceSymbols,contracts,volumes,minVolume=null,references=[],referenceRatio=1,fallbackMinVolume=5e6}){
 const binance=new Set(binanceSymbols),tradable=new Map();
 for(const [venue,map] of Object.entries(contracts))for(const [symbol,c] of map??[])if(c?.tradable)tradable.set(symbol,[...(tradable.get(symbol)??[]),venue]);
 const refVolumes=references.map(s=>volumes.get(s)?.quoteVolume).filter(v=>Number.isFinite(v)&&v>0);
 const threshold=Number.isFinite(minVolume)?minVolume:refVolumes.length?Math.min(...refVolumes)*referenceRatio:fallbackMinVolume;
 const coins=[...tradable.keys()].filter(s=>!binance.has(s)&&isCoinSymbol(s))
  .map(symbol=>({symbol,venues:tradable.get(symbol),quoteVolume:volumes.get(symbol)?.quoteVolume??0,price:volumes.get(symbol)?.price??null}))
  .filter(x=>x.quoteVolume>=threshold).sort((a,b)=>b.quoteVolume-a.quoteVolume||a.symbol.localeCompare(b.symbol));
 return {coins,threshold,thresholdSource:Number.isFinite(minVolume)?'SETTING':refVolumes.length?'REFERENCE':'FALLBACK'};
}
