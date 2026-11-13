// Holding-period labels (user 2026-11-13): 초단기 / 단기 / 중기 / 장기.
//   초단기  minutes ~ 1 h      단기  1 ~ 12 h      중기  12 h ~ 3 days      장기  3 days or more
// Expected label at entry = the pattern's median holding time in the 1-year backtest of the testnet
// rule (research/pattern_stats.mjs): box-top breakout 19 h, ascending triangle 30 h -> 중기;
// dead-cross / MACD dead / divergence / trend-line-break shorts 91-104 h -> 장기. The 5m reversal
// scalp (paper only) -> 초단기. Patterns without data follow their family (breakout 중기, reversal 장기).
// A closed trade is labelled by its actual holding time.
export const HORIZON_TIERS=Object.freeze([
 Object.freeze({code:'ULTRA_SHORT',label:'초단기',range:'수 분~1시간',maxHours:1}),
 Object.freeze({code:'SHORT_TERM',label:'단기',range:'1~12시간',maxHours:12}),
 Object.freeze({code:'MID_TERM',label:'중기',range:'12시간~3일',maxHours:72}),
 Object.freeze({code:'LONG_TERM',label:'장기',range:'3일 이상',maxHours:Infinity})]);
export const PATTERN_MEDIAN_HOLD_HOURS=Object.freeze({'박스권 상단 돌파':19,'상승삼각형 돌파':30,'5/20 데드크로스 숏':104,'MACD 데드+하락다이버전스 숏':91,
 '상승 추세선 이탈 숏':101,'RSI 하락 다이버전스':100});
const withHint=(t,extra)=>t&&({...t,hint:extra});
/** The tier of a holding time in hours. */
export function holdTier(hours){
 if(!(Number.isFinite(hours)&&hours>=0))return null;
 return HORIZON_TIERS.find(t=>hours<t.maxHours)??HORIZON_TIERS.at(-1);
}
/** Expected tier for a signal pattern (strategy 'SCALP' = the 5m reversal scalp). */
export function tradeHorizon(pattern,{strategy}={}){
 if(strategy==='SCALP'||/스캘프|scalp/i.test(String(pattern||'')))return withHint(HORIZON_TIERS[0],'보통 수 분~1시간 보유');
 const p=String(pattern||'');if(!p)return null;
 const known=PATTERN_MEDIAN_HOLD_HOURS[p];
 const hours=known??(/돌파/.test(p)?24:96);
 const t=holdTier(hours);
 return withHint(t,`${known?'백테스트 보유 중앙 ':'같은 계열 기준 약 '}${hours<48?hours+'시간':Math.round(hours/24)+'일'} · ${t.range}`);
}
