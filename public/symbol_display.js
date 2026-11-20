// Clean display names for BingX TradFi / stock / pre-IPO / index / commodity / FX perpetual codes.
// Examples:
//   NCSKANTHROPIC2USDUSDT  -> ANTHROPICUSDT
//   NCSKANTHROPIC2USD-USDT -> ANTHROPICUSDT
//   NCSKSNDK2USDUSDT       -> SNDKUSDT
//   NCSKAAPL2USD-USDT      -> AAPLUSDT
//   NCSISP5002USDUSDT      -> SP500USDT
//   NCCOGOLD2USDUSDT       -> GOLDUSDT
//   NCFXEURUSD-USDT        -> EURUSDT
//   BTCUSDT                -> BTCUSDT (unchanged)
// Used for UI display, Telegram notices, analytics grouping, and operator command matching;
// raw venueSymbol values remain untouched for signed BingX API orders.

const BINGX_TRADFI_RE=/^NC(?:SK|SI|CO|FX|S)([A-Z0-9]+?)2?USD-?(USDT)$/i;

export function displaySymbol(symbol){
 const raw=String(symbol??'').trim();
 if(!raw)return '';
 const m=BINGX_TRADFI_RE.exec(raw);
 return m?(m[1]+m[2]).toUpperCase():raw;
}
