const KNOWN_TRADFI_BASES=new Set(['XAU','XAG','US100','US500','US30','US400','DXI','UKOIL','USOIL','VXI','SPCX','CL','COPP']);
// Canonical crypto universe: Binance TRADING USDT perpetuals only.
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
