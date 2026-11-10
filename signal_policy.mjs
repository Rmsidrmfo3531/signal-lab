// A configurable research threshold is not evidence of profitability or permission to trade.
export const DEFAULT_FINAL_MIN_SCORE=90;
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
