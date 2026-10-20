// TradingView public Advanced Real-Time Chart widget symbol mapping.
// Binance USDT-M perpetual contracts normally use the .P suffix on TradingView.
// Some newly listed or nonstandard contracts may not yet exist on TradingView.
export const tradingViewTicker = (symbol) =>
  /^[A-Z0-9]{2,25}USDT$/.test(String(symbol||'')) ? `BINANCE:${symbol}.P` : null;
export const tradingViewInterval = (interval) =>
  ({'1h':'60','4h':'240','1d':'D'})[interval] || '60';
export const tradingViewChartUrl = (symbol,interval='1h') => {
  const ticker = tradingViewTicker(symbol);
  return ticker ? `https://www.tradingview.com/chart/?symbol=${encodeURIComponent(ticker)}&interval=${encodeURIComponent(tradingViewInterval(interval))}` : null;
};

// Chart viewing and trade verification are intentionally independent.
export const tradingViewAccess = (symbol, interval='1h', commonPerpVerified=false) => {
  const chartUrl=tradingViewChartUrl(symbol,interval);
  return {canView:Boolean(chartUrl),canOpenVariational:Boolean(chartUrl)&&commonPerpVerified===true,chartUrl};
};
