/** Transparent scan funnel: counts independent contracts, NOT repeated scan attempts.
 * A chart pattern may be visible as research, but only an independently validated
 * actionable setup may produce alerts, paper positions, or order links.
 */
// Why a technically qualified setup has no usable volume-profile target plan.
// The final screen only shows the generic TP_PROFILE_UNAVAILABLE; these are the
// recorded causes (profile collection first, then target planning).
function targetPlanReasons(row){
 const plan=row?.targetPlan;
 if(!plan||typeof plan!=='object')
  return [(row?.venueExecution??row?.binanceExecution)?.eligible===false?'EXECUTION_ESTIMATE_NOT_ELIGIBLE':'TARGET_PLAN_NOT_EVALUATED'];
 const strings=list=>Array.isArray(list)?list.filter(x=>typeof x==='string'&&x):[];
 const profile=strings(plan.profileReasons),planning=strings(plan.reasons);
 // VOLUME_PROFILE_NOT_AVAILABLE only wraps the collector's own reason.
 const detail=[...profile,...planning.filter(x=>!(profile.length&&x==='VOLUME_PROFILE_NOT_AVAILABLE'))];
 return detail.length?[...new Set(detail)]:['TARGET_PLAN_REASON_UNRECORDED'];
}
export function describeScanFunnel(analyses, {activeSymbols=[],researchSymbols=[],now=Date.now(),maxAgeMs=2*60*60_000,assess}={}) {
 const verified=new Set(activeSymbols),research=new Set(researchSymbols);
 const all=[...analyses.values()].filter(x=>x?.symbol&&(verified.has(x.symbol)||research.has(x.symbol))&&Number.isFinite(x.scannedAt)&&now-x.scannedAt<=maxAgeMs);
 const reasons=new Map(),categories={noPattern:0,quality:0,venue:0,entry:0,ready:0};
 const add=(reason)=>{if(!reason)return;reasons.set(reason,(reasons.get(reason)||0)+1)};
 const planBlocks=new Map(),plan={technicalCandidates:0,ready:0};
 const notePlan=row=>{
  plan.technicalCandidates++;
  if(row.targetPlan?.ok===true){plan.ready++;return}
  for(const reason of targetPlanReasons(row))planBlocks.set(reason,(planBlocks.get(reason)||0)+1);
 };
 const recentPatterns=[];let technicalPassed=0,venuePassed=0;
 for(const row of all){
  if(assess){
   const decision=assess(row);
   if(decision.pattern)recentPatterns.push(row);
   if(decision.technical){technicalPassed++;notePlan(row)}
   if(decision.venue)venuePassed++;
   categories[decision.stage]++;
   if(!decision.ready)decision.reasons.forEach(add);
   continue;
  }
  if(!row.patternConfirmed||!row.pattern){categories.noPattern++;continue}
  recentPatterns.push(row);
  if(!row.quality?.passed){categories.quality++;(row.quality?.failed||['기술 평가 미확인']).forEach(add);continue}
  technicalPassed++;notePlan(row);
  if(!verified.has(row.symbol)||row.execution?.eligible!==true){
   categories.venue++;
   if(!verified.has(row.symbol))add('Binance USDT 무기한 선물 상장 검증 대기');
   else (row.execution?.reasons?.length?row.execution.reasons:['Binance 호가·위험 검증 미통과']).forEach(add);
   continue;
  }
  venuePassed++;
  if(row.status==='signal'&&row.qualified===true){categories.ready++}else{categories.entry++;add('진입가 이탈·최소 손익비·신호 유효기간 재확인')}
 }
 const topReasons=[...reasons.entries()].sort((a,b)=>b[1]-a[1]).slice(0,8).map(([reason,count])=>({reason,count}));
 const blocked=[...planBlocks.entries()].sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0])).slice(0,8).map(([reason,count])=>({reason,count}));
 return {uniqueAnalyzed:all.length,verifiedContracts:verified.size,researchContracts:research.size,patternCount:recentPatterns.length,technicalPassed,venuePassed, ...categories,topReasons,
   targetPlan:{...plan,blocked,explanation:'기술 검증을 통과한 종목 중 매물대 목표가 계획이 준비된 수와, 준비되지 않은 세부 사유입니다.'},
   explanation:'중복 스캔을 제외한 최근 분석 종목별 집계. 신규 주문 신호는 모든 필수 검증에 통과해야만 표시됩니다.'};
}
