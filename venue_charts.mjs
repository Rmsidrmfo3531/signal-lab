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

// ---- Market cap screen (CoinGecko /coins/markets pages) ----------------------------------
// Coins are matched by ticker AND price (within 25%), because many tiny coins share a ticker
// with a known one. A coin that is not found (outside the fetched top list) has no market cap.
export const MCAP_PRICE_TOLERANCE=.25;
/** CoinGecko /coins/markets pages -> Map(TICKER -> [{id, marketCap, price}]). */
export function parseMarketCaps(pages){
 const out=new Map();
 for(const page of pages)for(const c of Array.isArray(page)?page:[]){
  const sym=String(c?.symbol||'').toUpperCase(),cap=Number(c?.market_cap),price=Number(c?.current_price);
  if(!/^[A-Z0-9]{1,20}$/.test(sym)||!(cap>0)||!(price>0))continue;
  out.set(sym,[...(out.get(sym)??[]),{id:String(c.id),marketCap:cap,price}]);
 }
 return out;
}
/** Market cap of a venue symbol (e.g. 1000XUSDT trades X x1000), or null when no ticker+price match. */
export function marketCapFor(symbol,price,caps){
 let base=String(symbol).replace(/USDT$/,''),mult=1;const m=/^(1000000|10000|1000|1M)([A-Z].*)$/.exec(base);
 if(m&&!caps.has(base)){base=m[2];mult=m[1]==='1M'?1e6:Number(m[1])}
 const unit=Number(price)/mult;if(!(unit>0))return null;
 const hits=(caps.get(base)??[]).filter(c=>Math.abs(c.price/unit-1)<=MCAP_PRICE_TOLERANCE).sort((a,b)=>b.marketCap-a.marketCap);
 return hits[0]??null;
}
/**
 * Drop coins whose market cap makes no sense for trading: not found / below minMarketCap, or a
 * 24h perp volume more than maxVolumeToCap times the market cap (wash-traded or near-empty float).
 */
export function screenByMarketCap(coins,caps,{minMarketCap=10e6,maxVolumeToCap=5}={}){
 const kept=[],dropped=[];
 for(const c of coins){
  const hit=marketCapFor(c.symbol,c.price,caps),cap=hit?.marketCap??null;
  const reason=!hit?'MCAP_UNKNOWN':cap<minMarketCap?'MCAP_TOO_SMALL':c.quoteVolume>maxVolumeToCap*cap?'VOLUME_TO_MCAP_TOO_HIGH':null;
  (reason?dropped:kept).push({...c,marketCap:cap,coingeckoId:hit?.id??null,...(reason?{reason}:{})});
 }
 return {kept,dropped};
}
