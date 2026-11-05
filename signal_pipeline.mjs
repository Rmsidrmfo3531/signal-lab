import {STRICT_MIN_SCORE} from './quality.mjs';
import {riskSizedEstimate} from './execution.mjs';
import {entryTiming} from './public/trade_plan.js';
import {estimateBinanceExecution} from './binance_execution.mjs';

// One current decision for diagnostics, screen, alerts and simulated entries.
// Public venue quotes are indicative; this module never submits an order.
export function evaluateSignal(row,{analysisVenue='VARIATIONAL_LEGACY',market,book,verified=false,venueConnected=false,listing,price,priceAt,statsReceivedAt,
 now=Date.now(),limits,maxAnalysisAgeMs=20*60000}={}){
 if(analysisVenue==='BINANCE')return evaluateBinanceSignal(row,{market,book,verified,venueConnected,price,priceAt,now,limits,maxAnalysisAgeMs});
 const pattern=Boolean(row?.patternConfirmed&&row.pattern);
 const technicalReasons=pattern?(row.quality?.failed||[]).slice():['확정 패턴 없음'];
 const fresh=Number.isFinite(row?.quality?.validUntil)&&now<=row.quality.validUntil;
 if(pattern&&!fresh)technicalReasons.push('확정 1H·4H 봉 신선도 만료 또는 재검증 필요');
 const technical=pattern&&fresh&&row.technicalQualified===true&&row.quality?.passed===true&&row.score>=STRICT_MIN_SCORE;
 if(pattern&&row.score<STRICT_MIN_SCORE)technicalReasons.push(`기술 점수 ${STRICT_MIN_SCORE}점 미만`);
 const execution=pattern&&row.entry&&row.stop?riskSizedEstimate({signal:row,listing,binancePrice:price,
  binancePriceAt:priceAt,statsReceivedAt,now,limits}):{eligible:false,reasons:['진입가·손절가 없음']};
 if(!verified||!venueConnected)execution.reasons.unshift('Variational 공통상장 검증 대기');
 if(!Number.isFinite(execution.estimatedNetRR)||execution.estimatedNetRR<1.8)
  execution.reasons.push('거래비용 반영 후 1차 목표 손익비 1.8 미만/검증 불가');
 execution.eligible=execution.eligible&&verified&&venueConnected&&Number.isFinite(execution.estimatedNetRR)&&execution.estimatedNetRR>=1.8;
 const venue=technical&&execution.eligible;
 const timing=pattern?entryTiming({...row,qualified:true,execution:{eligible:true}},
  {price,priceAt,now,venueReady:true}):{actionable:false,code:'no-pattern',label:'확정 패턴 없음'};
 const entryReasons=[];
 if(!Number.isFinite(row?.scannedAt)||row.scannedAt>now+60000||now-row.scannedAt>maxAnalysisAgeMs)
  entryReasons.push('최근 20분 이내 재분석 필요');
 if(!timing.actionable)entryReasons.push(timing.label);
 const ready=Boolean(venue&&entryReasons.length===0);
 const stage=!pattern?'noPattern':!technical?'quality':!venue?'venue':!ready?'entry':'ready';
 return {pattern,technical,venue,ready,stage,execution,timing,technicalReasons,entryReasons,
  reasons:stage==='quality'?technicalReasons:stage==='venue'?execution.reasons:stage==='entry'?entryReasons:stage==='noPattern'?['확정 패턴 없음']:[],checkedAt:now};
}

export function evaluateBinanceSignal(row,{market,book,verified=false,venueConnected=false,price,priceAt,now=Date.now(),limits={},maxAnalysisAgeMs=20*60000}={}){
 const pattern=Boolean(row?.patternConfirmed&&row.pattern),technicalReasons=[...(row?.quality?.failed||[])],
  scorePassed=Number.isFinite(row?.score)&&row.score>=STRICT_MIN_SCORE,
  validationPassed=row?.technicalValidation?.passed===true,
  fresh=Number.isFinite(row?.quality?.validUntil)&&now<=row.quality.validUntil;
 if(!fresh)technicalReasons.push('확정 1H·4H 봉 신선도 만료 또는 재검증 필요');
 if(!scorePassed)technicalReasons.push(Number.isFinite(row?.score)?`종합점수 ${STRICT_MIN_SCORE}점 미만`:'종합점수 평가 불가');
 const technical=pattern&&validationPassed&&scorePassed&&fresh;
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
  const friction=(costs.spreadBps/2+costs.slippageBps)/10000,entry=execution.entryBasis*(1+sign*friction),
   stop=row.stop*(1-sign*friction),target=plan.targets[0]*(1-sign*friction),funding=entry*Math.abs(costs.fundingRate),
   risk=sign*(entry-stop)+(entry+stop)*costs.takerRate+funding,
   reward=sign*(target-entry)-(entry+target)*costs.takerRate-funding;
  if(risk>0&&Number.isFinite(reward))currentNetRR=reward/risk;
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
  tradeApproval:false,orangeXApproval:false,analysisVenue:'BINANCE',reasons:stage==='noPattern'?['확정 패턴 없음']:stage==='quality'?technicalReasons:
   stage==='venue'?execution.reasons:stage==='entry'?entryReasons:[],checkedAt:now};
}
