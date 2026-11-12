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
export const scoreGatePassed=(score,pattern)=>Number.isFinite(score)&&(score>=FINAL_MIN_SCORE||TREND_GATE_PATTERNS.includes(pattern));
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
