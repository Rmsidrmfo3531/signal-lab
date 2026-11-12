// A configurable research threshold is not evidence of profitability or permission to trade.
export const DEFAULT_FINAL_MIN_SCORE=90;
// User-approved exception (2026-11-12) to the "never relax the score threshold" rule, for these
// patterns only: study-material detectors (blog PDFs, video lessons) that trade only WITH the 4H
// trend and skip the 90-point score. In the 180-day / 12-symbol replay the score picked their worst
// entries; with '4H trend agrees' instead, fixed risk went from +$292 (3 base patterns) to +$483
// (first 90 days -$59 -> -$16, last 90 days +$351 -> +$499); split book +$974 -> +$956. The engine raises them only when the 4H trend agrees (never against it),
// and they keep their pattern stop with no zone adds (with adds the same replay lost money).
// Every other pattern still needs SIGNAL_FINAL_MIN_SCORE (90).
export const TREND_GATE_PATTERNS=Object.freeze(['MACD 데드+하락다이버전스 숏','거래량 다이버전스+음봉3 숏','RSI 하락 다이버전스','상승삼각형 돌파','볼린저 수축 후 상단 돌파','상승삼각 거래량수렴 돌파 롱']);
// Floor for the approved patterns (user, 2026-11-12, after a 65-point entry). Same 180-day replay,
// split book (the paper/live rule): +$956 -> +$1079, PF 1.94 -> 2.36, max drawdown -$220 -> -$181;
// these patterns alone at 75+: PF 1.43 -> 1.61 with 96 of 167 trades. Fixed-risk book: +$483 -> +$313.
export const TREND_GATE_MIN_SCORE=75;
// Tightening (2026-11-12, 1-year / 30-symbol replay, split book, $400): these two lost money and are
// no longer traded (still detected and shown). Total +$1871 -> +$2033, first half -$493 -> -$368,
// second half +$2364 -> +$2401, max drawdown -$940 -> -$827.
export const DISABLED_PATTERNS=Object.freeze(['볼린저 수축 후 상단 돌파','거래량 다이버전스+음봉3 숏']);
// Patterns that trade by default (server SIGNAL_PATTERNS default and the backtest default).
export const DEFAULT_TRADE_PATTERNS=Object.freeze(['박스권 상단 돌파','상승 추세선 이탈 숏','5/20 데드크로스 숏',...TREND_GATE_PATTERNS].filter(p=>!DISABLED_PATTERNS.includes(p)));
// Tightening (same replay, with the two patterns above dropped): LONG only while BTC's 4H trend is
// up (EMA100 > EMA200 and close > EMA200). First half -$368 -> -$216, second half +$2401 -> +$2329,
// total +$2033 -> +$2112, max drawdown -$827 -> -$748. Unknown BTC trend blocks longs (fail closed).
export const btcLongBlocked=(row,mode)=>mode==='up'&&row?.direction==='LONG'&&row?.btcContext?.trend!=='up';
export const scoreGatePassed=(score,pattern)=>Number.isFinite(score)&&(score>=FINAL_MIN_SCORE||TREND_GATE_PATTERNS.includes(pattern)&&score>=TREND_GATE_MIN_SCORE);
export function resolveSignalScorePolicy(env={}){
 const raw=env.SIGNAL_FINAL_MIN_SCORE;
 const configured=raw!==undefined&&raw!==null&&String(raw).trim()!=='';
 const value=configured&&/^\d+$/.test(String(raw).trim())?Number(raw):configured?NaN:DEFAULT_FINAL_MIN_SCORE;
 if(!Number.isInteger(value)||value<DEFAULT_FINAL_MIN_SCORE||value>100)
  throw Error('SIGNAL_FINAL_MIN_SCORE는 90~100의 정수여야 합니다. 검증되지 않은 기준 완화는 허용하지 않습니다.');
 return Object.freeze({finalMinScore:value,defaultFinalMinScore:DEFAULT_FINAL_MIN_SCORE,
  setting:'SIGNAL_FINAL_MIN_SCORE',source:configured?'CONFIGURED':'DEFAULT',allowedRange:[90,100],
  validationStatus:'UNVERIFIED',thresholdStatus:'PROPOSED_NOT_BACKTEST_CALIBRATED',
  performanceValidation:'UNVERIFIED',outOfSampleValidation:'UNVERIFIED',walkForwardValidation:'UNVERIFIED',
  scoreIsWinProbability:false,liveApproval:false,
  explanation:'최종 신호의 제안 기준입니다. 합성 기능 검사만 수행했으며 실전 성능·승률·수익 개선은 미검증입니다.'});
}
let policy=resolveSignalScorePolicy(process.env);
export let FINAL_MIN_SCORE=policy.finalMinScore;
// Called after the server loads the existing, preserved Windows .env file.
export function configureSignalScorePolicy(env=process.env){
 const next=resolveSignalScorePolicy(env);policy=next;FINAL_MIN_SCORE=next.finalMinScore;return next;
}
export function getSignalScorePolicy(){return policy;}
