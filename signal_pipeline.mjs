import {STRICT_MIN_SCORE} from './quality.mjs';
import {scoreGatePassed,TREND_GATE_PATTERNS,TREND_GATE_MIN_SCORE,btcLongBlocked} from './signal_policy.mjs';
import {entryTiming} from './public/trade_plan.js';
import {estimateBinanceExecution,netRewardRisk} from './binance_execution.mjs';

// One Binance-only decision for diagnostics, screen, alerts and simulated entries.
// Analysis approval never authorizes an exchange order.
export function evaluateSignal(row,context={}){
 return evaluateBinanceSignal(row,context);
}

export function evaluateBinanceSignal(row,{market,book,verified=false,venueConnected=false,price,priceAt,now=Date.now(),limits={},maxAnalysisAgeMs=20*60000}={}){
 const pattern=Boolean(row?.patternConfirmed&&row.pattern),technicalReasons=[...(row?.quality?.failed||[])],
  scorePassed=Number.isFinite(row?.score)&&scoreGatePassed(row.score,row?.pattern),
  validationPassed=row?.technicalValidation?.passed===true,
  fresh=Number.isFinite(row?.quality?.validUntil)&&now<=row.quality.validUntil;
 if(!fresh)technicalReasons.push('확정 1H·4H 봉 신선도 만료 또는 재검증 필요');
 if(!scorePassed)technicalReasons.push(Number.isFinite(row?.score)?`종합점수 ${TREND_GATE_PATTERNS.includes(row?.pattern)?TREND_GATE_MIN_SCORE+'점 미만(추세 패턴)':STRICT_MIN_SCORE+'점 미만'}`:'종합점수 평가 불가');
 // Only patterns that held up in the 180-day backtest trade (limits.allowedPatterns; null = all).
 const patternAllowed=!Array.isArray(limits.allowedPatterns)||limits.allowedPatterns.includes(row?.pattern);
 if(pattern&&!patternAllowed)technicalReasons.push('백테스트 검증 패턴 아님(SIGNAL_PATTERNS)');
 // LONG only while BTC's 4H trend is up (limits.btcLongFilter 'up'; 'off' or unset = no filter).
 const btcBlocked=btcLongBlocked(row,limits.btcLongFilter);
 if(pattern&&btcBlocked)technicalReasons.push('BTC 4H 상승 추세 아님(롱 진입 제한)');
 const technical=pattern&&validationPassed&&scorePassed&&fresh&&patternAllowed&&!btcBlocked;
 const execution=estimateBinanceExecution({signal:row,market,book,now,maxRiskUSD:limits.maxRiskUSD??6});
 if(!verified||!venueConnected)execution.reasons.push('Binance TRADING USDT 무기한 선물·연결 검증 필요');
 const plan=row?.targetPlan,profileReceipt=plan?.profileEvidence?.receivedAt,profileWindowEnd=plan?.profileEvidence?.windowEnd;
 if(plan?.ok!==true||!Array.isArray(plan?.targets)||plan.targets.length!==3)execution.reasons.push('TP_PROFILE_UNAVAILABLE');
 else if([profileReceipt,profileWindowEnd].some(at=>!Number.isFinite(at)||at>now||now-at>90000)||profileWindowEnd>profileReceipt)
  execution.reasons.push('TP_PROFILE_UNAVAILABLE: 매물대 자료 만료 또는 시각 정합성 오류');
 const quantity=plan?.quantity,costs=plan?.costAssumptions,sign=row?.direction==='LONG'?1:-1;
 let currentNetRR=null;
 if(Number.isFinite(execution.quantity)&&Number.isFinite(quantity)&&quantity>execution.quantity+1e-10)
  execution.reasons.push('현재 호가 기준 매물대 계획 수량이 최대 손실 허용 수량 초과');
 if(Number.isFinite(execution.entryBasis)&&Array.isArray(plan?.targets)&&costs&&
  ['takerRate','spreadBps','slippageBps','fundingRate'].every(key=>Number.isFinite(costs[key]))){
  const liveCosts=Number.isFinite(execution.spreadBps)?{...costs,spreadBps:Math.max(costs.spreadBps,execution.spreadBps)}:costs;
  currentNetRR=netRewardRisk({direction:row.direction,entry:execution.entryBasis,stop:row.stop,target:plan.targets[0],costs:liveCosts});
 }
 if(!Number.isFinite(currentNetRR)||currentNetRR<1.8)execution.reasons.push('매물대 TP1 현재 비용 가정 반영 손익비 1.8 미만/평가 불가');
 execution.estimatedNetRR=currentNetRR;
 execution.eligible=execution.eligible&&execution.reasons.length===0;
 const venue=technical&&execution.eligible,timing=pattern?entryTiming({...row,entry:row.referenceEntry??row.entry,qualified:true,execution:{eligible:true}},
  {price:execution.executablePrice,priceAt:execution.quoteUpdatedAt,now,venueReady:true}):{actionable:false,code:'no-pattern',label:'확정 패턴 없음'},entryReasons=[];
 if(!Number.isFinite(price)||price<=0||!Number.isFinite(priceAt)||priceAt>now||now-priceAt>90000)entryReasons.push('Binance 독립 시세 시각 확인 필요');
 if(!Number.isFinite(row?.scannedAt)||row.scannedAt>now||now-row.scannedAt>maxAnalysisAgeMs)entryReasons.push('최근 20분 이내 재분석 필요');
 if(!timing.actionable)entryReasons.push(timing.label);
 const ready=Boolean(venue&&entryReasons.length===0),stage=!pattern?'noPattern':!technical?'quality':!venue?'venue':!ready?'entry':'ready';
 return {pattern,scorePassed,validationPassed,technical,venue,ready,stage,execution,timing,technicalReasons,entryReasons,
  tradeApproval:false,analysisVenue:'BINANCE',reasons:stage==='noPattern'?['확정 패턴 없음']:stage==='quality'?technicalReasons:
   stage==='venue'?execution.reasons:stage==='entry'?entryReasons:[],checkedAt:now};
}
