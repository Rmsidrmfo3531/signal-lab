/** Transparent scan funnel: counts independent contracts, NOT repeated scan attempts.
 * A chart pattern may be visible as research, but only an independently validated
 * actionable setup may produce alerts, paper positions, or order links.
 */
export function describeScanFunnel(analyses, {activeSymbols=[],researchSymbols=[],now=Date.now(),maxAgeMs=2*60*60_000,assess}={}) {
 const verified=new Set(activeSymbols),research=new Set(researchSymbols);
 const all=[...analyses.values()].filter(x=>x?.symbol&&(verified.has(x.symbol)||research.has(x.symbol))&&Number.isFinite(x.scannedAt)&&now-x.scannedAt<=maxAgeMs);
 const reasons=new Map(),categories={noPattern:0,quality:0,venue:0,entry:0,ready:0};
 const add=(reason)=>{if(!reason)return;reasons.set(reason,(reasons.get(reason)||0)+1)};
 const recentPatterns=[];let technicalPassed=0,venuePassed=0;
 for(const row of all){
  if(assess){
   const decision=assess(row);
   if(decision.pattern)recentPatterns.push(row);
   if(decision.technical)technicalPassed++;
   if(decision.venue)venuePassed++;
   categories[decision.stage]++;
   if(!decision.ready)decision.reasons.forEach(add);
   continue;
  }
  if(!row.patternConfirmed||!row.pattern){categories.noPattern++;continue}
  recentPatterns.push(row);
  if(!row.quality?.passed){categories.quality++;(row.quality?.failed||['기술 평가 미확인']).forEach(add);continue}
  technicalPassed++;
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
 return {uniqueAnalyzed:all.length,verifiedContracts:verified.size,researchContracts:research.size,patternCount:recentPatterns.length,technicalPassed,venuePassed, ...categories,topReasons,
   explanation:'중복 스캔을 제외한 최근 분석 종목별 집계. 신규 주문 신호는 모든 필수 검증에 통과해야만 표시됩니다.'};
}
