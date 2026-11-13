// Short-term / long-term label for a trade (user request 2026-11-13: "단기 매매면 단기, 장기 매매면 장기").
// From the 1-year backtest of the testnet rule (research/pattern_stats.mjs, median holding time):
//   breakouts (box top, ascending triangle) close in about 1 day (19-30 h)   -> 단기
//   reversal / trend-change shorts (dead cross, MACD dead + divergence, RSI divergence,
//   trend-line break) take about 4 days (91-104 h)                           -> 장기
// Patterns without backtest data follow their family: breakout -> 단기, reversal/divergence -> 장기.
export const HORIZON_THRESHOLD_HOURS=48;
const SHORT_TERM=['박스권 상단 돌파','상승삼각형 돌파','볼린저 수축 후 상단 돌파','상승삼각 거래량'];
export function tradeHorizon(pattern){
 const p=String(pattern||'');if(!p)return null;
 if(SHORT_TERM.some(x=>p.startsWith(x))||/돌파/.test(p))return {code:'SHORT_TERM',label:'단기',hint:'보통 1일 안팎 보유'};
 return {code:'LONG_TERM',label:'장기',hint:'보통 3~5일 보유'};
}
