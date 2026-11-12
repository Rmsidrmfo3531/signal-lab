import {seededEMA,evaluateIndicators} from './indicators.mjs';
import {FINAL_MIN_SCORE as STRICT_MIN_SCORE,getSignalScorePolicy,scoreGatePassed,TREND_GATE_PATTERNS,TREND_GATE_MIN_SCORE} from './signal_policy.mjs';
export {FINAL_MIN_SCORE as STRICT_MIN_SCORE} from './signal_policy.mjs';

/** Issue #6: one 100-point evidence score, never a probability or permission. */
export const WATCH_MIN_SCORE=80;
export const MIN_CLOSED_4H_BARS=250;
export const SCORE_VERSION='ISSUE6-100-V1';
export const SCORE_WEIGHTS=Object.freeze({ema2004h:15,ema1004h:5,ema201h:10,patternCandle:25,adxDmi:15,rsi:10,macd:5,patternVolume:10,atrVolatility:5});
export const SCORE_POLICY=Object.freeze({minimumClosed4h:250,recommendedClosed4h:300,
 maximum1hAgeMs:75*60000,maximum4hAgeMs:255*60000,maximumChaseFraction:.004,maximumChaseATR:.45,
 maximumATRPriceFraction:.08,breakoutVolumeRatio:1.6,sweepVolumeRatio:1.4,retestOrPullbackVolumeRatio:1.2,
 adxFull:25,adxPartial:20,rsiLong:[50,70],rsiShort:[30,50],atrFullRange:[.0015,.05],
 thresholdStatus:'PROPOSED_NOT_BACKTEST_CALIBRATED',scoreIsWinProbability:false});
const finite=Number.isFinite;
const closeAt=(bar,ms)=>finite(bar?.closeTime)?bar.closeTime:finite(bar?.time)?bar.time+ms-1:null;
const validBars=(bars,min)=>Array.isArray(bars)&&bars.length>=min&&bars.every(bar=>bar&&bar.closed!==false&&
 [bar.open,bar.high,bar.low,bar.close,bar.volume].every(finite)&&Math.min(bar.open,bar.high,bar.low,bar.close)>0&&bar.volume>=0&&
 bar.high>=Math.max(bar.open,bar.close)&&bar.low<=Math.min(bar.open,bar.close));
const statusCheck=(key,label,passed,details)=>({key,label,passed,status:passed?'PASS':'FAIL',details});
const volumeThreshold=pattern=>/재확인|눌림목|반등/.test(pattern)?1.2:/스윕/.test(pattern)?1.4:1.6;

export function gradeSetup({direction,h1,h4,atr1h,volumeRatio,entry,stop,price=entry,pattern,patternConfirmed=true,
 btcContext,symbol='BTCUSDT',now=Date.now()}={}){
 const last=h1?.at(-1),four=h4?.at(-1),lastCloseAt=closeAt(last,3600000),fourCloseAt=closeAt(four,14400000),
  fresh1h=finite(lastCloseAt)&&lastCloseAt<=now&&now-lastCloseAt<=SCORE_POLICY.maximum1hAgeMs,
  fresh4h=finite(fourCloseAt)&&fourCloseAt<=now&&now-fourCloseAt<=SCORE_POLICY.maximum4hAgeMs,
  hasData=['LONG','SHORT'].includes(direction)&&validBars(h1,65)&&validBars(h4,MIN_CLOSED_4H_BARS)&&
   h1.every(bar=>closeAt(bar,3600000)<=now)&&h4.every(bar=>closeAt(bar,14400000)<=now),
  readings=hasData?evaluateIndicators(h1,direction):{valid:false,values:{}},long=direction==='LONG',
  e200=hasData?seededEMA(h4.map(c=>c.close),200).at(-1):null,
  e100=hasData?seededEMA(h4.map(c=>c.close),100).at(-1):null,
  e20=hasData?seededEMA(h1.map(c=>c.close),20).at(-1):null,
  ready=hasData&&readings.valid&&[e200,e100,e20].every(finite),values=readings.values,
  range=last?last.high-last.low:0,body=range>0?Math.abs(last.close-last.open)/range:0,
  finish=range>0?(long?(last.close-last.low)/range:(last.high-last.close)/range):0,
  directedCandle=Boolean(last&&(long?last.close>last.open:last.close<last.open)),
  confirmed=patternConfirmed===true&&typeof pattern==='string'&&pattern.length>0,
  strong=directedCandle&&body>=.42&&finish>=.68,partial=directedCandle&&body>=.25&&finish>=.60,
  ratio=finite(volumeRatio)?volumeRatio:null,volumeRequired=volumeThreshold(pattern||''),
  effectiveATR=finite(atr1h)&&atr1h>0?atr1h:values.atr,atrFraction=last&&effectiveATR>0?effectiveATR/last.close:null,
  directional=(value,ma)=>long?value>ma:value<ma,
  alignedDMI=ready&&(long?values.plusDI>values.minusDI:values.minusDI>values.plusDI),
  rsi=values.rsi,hist=values.macdHistogram,previousHist=values.previousMacdHistogram,
  improving=ready&&(long?hist>previousHist:hist<previousHist),
  checks=ready?[
   {key:'ema2004h',label:'4H EMA200',weight:15,earned:directional(four.close,e200)?15:0,value:e200},
   {key:'ema1004h',label:'4H EMA100',weight:5,earned:directional(four.close,e100)?5:0,value:e100},
   {key:'ema201h',label:'1H EMA20',weight:10,earned:directional(last.close,e20)?10:0,value:e20},
   {key:'patternCandle',label:'1H 확정 패턴·확정봉 강도',weight:25,earned:confirmed?(strong?25:partial?20:15):0,
    value:{pattern:confirmed?pattern:null,bodyFraction:body,closePosition:finish,directionConfirmed:directedCandle}},
   {key:'adxDmi',label:'ADX/DMI(14)',weight:15,earned:alignedDMI?(values.adx>=25?15:values.adx>=20?10:values.adx>=15?5:0):0,
    value:{adx:values.adx,plusDI:values.plusDI,minusDI:values.minusDI}},
   {key:'rsi',label:'RSI(14)',weight:10,earned:long?(rsi>=50&&rsi<=70?10:rsi>=45&&rsi<=80?5:0):
    (rsi>=30&&rsi<=50?10:rsi>=20&&rsi<=55?5:0),value:rsi},
   {key:'macd',label:'MACD(12,26,9)',weight:5,earned:(long?hist>0:hist<0)?(improving?5:3):0,value:{histogram:hist,previousHistogram:previousHist}},
   {key:'patternVolume',label:'패턴별 거래량 확증',weight:10,earned:ratio>=volumeRequired?10:ratio>=1?5:0,
    value:{ratio,requiredRatio:volumeRequired,pattern:pattern||null}},
   {key:'atrVolatility',label:'ATR(14) 변동성',weight:5,earned:atrFraction>=.0015&&atrFraction<=.05?5:
    atrFraction>=.001&&atrFraction<=.08?3:0,value:{atr:effectiveATR,priceFraction:atrFraction}}
  ].map(check=>({...check,passed:check.earned===check.weight,required:false})):[],
  score=ready?checks.reduce((sum,check)=>sum+check.earned,0):null,
  stopValid=finite(entry)&&finite(stop)&&entry>0&&stop>0&&(long?stop<entry:stop>entry),
  quoteValid=finite(price)&&price>0,
  chase=quoteValid&&stopValid&&effectiveATR>0&&Math.abs(price-entry)<=Math.min(entry*.004,effectiveATR*.45),
  stopNotInvalidated=quoteValid&&stopValid&&(long?price>stop:price<stop),
  btcRequired=symbol!=='BTCUSDT',btcObserved=!btcRequired||btcContext?.status==='VERIFIED',
  btcAligned=!btcRequired||btcObserved&&['up','down','range'].includes(btcContext.trend)&&
   (btcContext.trend==='range'||(long?btcContext.trend==='up':btcContext.trend==='down')),
  validationChecks=[
   statusCheck('scoreData','확정봉·EMA200 산출 이력',ready,{closed4h:h4?.length||0,minimumClosed4h:250}),
   statusCheck('confirmedPattern','1H 가격 패턴 확정',confirmed,{pattern:pattern||null}),
   statusCheck('fresh1h','확정 1시간봉 75분 이내',fresh1h,{closeAt:lastCloseAt}),
   statusCheck('fresh4h','확정 4시간봉 255분 이내',fresh4h,{closeAt:fourCloseAt}),
   statusCheck('stopValid','방향과 가격이 유효한 손절',stopValid&&stopNotInvalidated,{entry,stop,price}),
   statusCheck('chase','추격 진입 방지: 0.4%·0.45 ATR 이내',chase,{price,entry}),
   statusCheck('atrRisk','ATR 산출 가능·가격 대비 8% 이내',finite(atrFraction)&&atrFraction>0&&atrFraction<=.08,{atrFraction}),
   statusCheck('confirmedActivity','확정봉 체결 거래량 존재',Boolean(last&&last.volume>0),{volume:last?.volume??null}),
   {...statusCheck('btc4h','BTC 4H 시장 환경 대응',btcObserved&&btcAligned,{required:btcRequired,context:btcContext??null}),
    status:!btcObserved?'UNVERIFIED':btcAligned?'PASS':'FAIL'}
  ],failed=validationChecks.filter(check=>!check.passed).map(check=>check.label),thresholdPassed=finite(score)&&scoreGatePassed(score,pattern),
  validationPassed=failed.length===0;
 return {score,scoreVersion:SCORE_VERSION,minimumScore:STRICT_MIN_SCORE,scorePolicy:getSignalScorePolicy(),passed:validationPassed&&thresholdPassed,
  validationPassed,thresholdPassed,checkedAt:now,validUntil:finite(lastCloseAt)&&finite(fourCloseAt)?
   Math.min(lastCloseAt+75*60000,fourCloseAt+255*60000):null,
  failed:[...failed,...(!ready?['평가불가: 지표 또는 4H 이력 부족']:!thresholdPassed?[TREND_GATE_PATTERNS.includes(pattern)?'종합점수 '+TREND_GATE_MIN_SCORE+'점 미만(추세 패턴)':'종합점수 '+STRICT_MIN_SCORE+'점 미만']:[])],
  missingBonus:[],checks,validationChecks,rule:SCORE_VERSION,
  technicalValidation:{passed:validationPassed,reasons:failed,checks:validationChecks},
  indicators:{...readings,score,checks,scoreVersion:SCORE_VERSION},policy:SCORE_POLICY,
  scoreMeaning:'Issue #6 단일 100점 조건 충족도. 승률·주문 승인 아님',evaluationStatus:ready?'EVALUATED':'UNAVAILABLE'};
}
