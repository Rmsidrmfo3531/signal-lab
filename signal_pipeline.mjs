import {STRICT_MIN_SCORE} from './quality.mjs';
import {riskSizedEstimate} from './execution.mjs';
import {entryTiming} from './public/trade_plan.js';

// One current decision for diagnostics, screen, alerts and simulated entries.
// Public venue quotes are indicative; this module never submits an order.
export function evaluateSignal(row,{verified=false,venueConnected=false,listing,price,priceAt,statsReceivedAt,
 now=Date.now(),limits,maxAnalysisAgeMs=20*60000}={}){
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
