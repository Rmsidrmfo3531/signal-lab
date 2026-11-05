import {parsePerpExecution} from './execution.mjs';
const KNOWN_TRADFI_BASES=new Set(['XAU','XAG','US100','US500','US30','US400','DXI','UKOIL','USOIL','VXI','SPCX','CL','COPP']);
// Canonical crypto universe: Binance USDT perpetuals only. Variational remains
// an independent TradFi/read-only feature and cannot gate this universe.
export function binancePerpetualMarkets(info,tickers){
 if(!Array.isArray(info?.symbols)||!Array.isArray(tickers))throw Error('Binance market response invalid');
 const listed=info.symbols.filter(x=>x?.contractType==='PERPETUAL'&&x.status==='TRADING'&&x.quoteAsset==='USDT'&&
  typeof x.baseAsset==='string'&&/^[A-Z0-9]+$/.test(x.baseAsset)&&x.symbol===x.baseAsset+'USDT'&&!KNOWN_TRADFI_BASES.has(x.baseAsset));
 const bySymbol=new Map(listed.map(x=>[x.symbol,x]));
 const markets=tickers.filter(x=>bySymbol.has(x?.symbol)).map(x=>{
  const item=bySymbol.get(x.symbol),filters=Object.fromEntries((Array.isArray(item.filters)?item.filters:[]).filter(f=>f&&typeof f.filterType==='string').map(f=>[f.filterType,{...f}]));
  return {symbol:x.symbol,baseAsset:item.baseAsset,quoteAsset:'USDT',marginAsset:item.marginAsset??null,contractType:'PERPETUAL',status:'TRADING',filters,
   price:Number(x.lastPrice),priceAt:Number.isFinite(Number(x.closeTime))&&Number(x.closeTime)>0?Number(x.closeTime):null,
   change:Number(x.priceChangePercent),quoteVolume:Number(x.quoteVolume),high:Number(x.highPrice),low:Number(x.lowPrice),dataSource:'BINANCE_USDT_PERPETUAL'};
 }).filter(x=>Number.isFinite(x.price)&&x.price>0&&Number.isFinite(x.quoteVolume)&&x.quoteVolume>=0).sort((a,b)=>b.quoteVolume-a.quoteVolume||a.symbol.localeCompare(b.symbol));
 return {markets,binancePerps:listed.length};
}
/** Match only identical crypto PERP underlyings between two public exchange listings.
 * Never use ticker aliases (1000PEPE vs PEPE, BTC vs WBTC) or SWAP products.
 */
export function extractVariationalPerps(payload) {
  if (!payload || !Array.isArray(payload.listings)) throw Error('Variational v2 API: listings array missing');
  const markets=new Map(),ambiguous=new Set();
  for (const x of payload.listings) {
    if (!x || x.contract_type!=='perpetual' || typeof x.ticker!=='string') continue;
    const match=/^([A-Z0-9]+)-PERP$/.exec(x.ticker);
    if (!match) continue;
    const base=match[1];
    // v2 API may list an asset several times; only unambiguous ticker mapping is used.
    if (ambiguous.has(base)) continue;
    if (markets.has(base)) { markets.delete(base); ambiguous.add(base); continue; }
    const mark=Number(x.mark_price);
    markets.set(base, {
      ticker:x.ticker,name:String(x.name||''),
      markPrice:Number.isFinite(mark)&&mark>0?mark:null,
      volume24h:Number(x.volume_24h)||0,
      baseSpreadBps:Number.isFinite(Number(x.base_spread_bps))?Number(x.base_spread_bps):null,
      ...parsePerpExecution(x),
    });
  }
  return markets;
}

export function intersectPerpetualMarkets(binanceInfo, binanceTicker, variationalPayload) {
  if(!binanceInfo || !Array.isArray(binanceInfo.symbols) || !Array.isArray(binanceTicker)) throw Error('Binance market response invalid');
  const variational=extractVariationalPerps(variationalPayload);
  const listed=binanceInfo.symbols.filter(x =>
    x.contractType==='PERPETUAL' && x.quoteAsset==='USDT' &&
    x.status==='TRADING' && typeof x.baseAsset==='string' && !KNOWN_TRADFI_BASES.has(x.baseAsset) &&
    /^[A-Z0-9]+$/.test(x.baseAsset) && x.symbol===x.baseAsset+'USDT' &&
    variational.has(x.baseAsset));
  const bySymbol=new Map(listed.map(x=>[x.symbol,x]));
  const markets=binanceTicker.filter(x=>bySymbol.has(x.symbol)).map(x=>{
    const listing=bySymbol.get(x.symbol);
    return {
      symbol:x.symbol,baseAsset:listing.baseAsset,
      price:Number(x.lastPrice),change:Number(x.priceChangePercent),quoteVolume:Number(x.quoteVolume),
      high:Number(x.highPrice),low:Number(x.lowPrice),variational:variational.get(listing.baseAsset)
    };
  }).filter(x=>Number.isFinite(x.price) && x.price>0).sort((a,b)=>b.quoteVolume-a.quoteVolume);
  return {markets,binancePerps:binanceInfo.symbols.filter(x=>x.contractType==='PERPETUAL'&&x.quoteAsset==='USDT'&&x.status==='TRADING').length,variationalPerps:variational.size};
}
