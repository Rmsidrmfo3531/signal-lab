// Automatic trade journal for finished live (testnet) trades: what happened, the likely reason,
// and what to look at next. Rule-based on the facts the executor recorded (fills, stops, timing,
// trend context). Suggestions are hypotheses to verify with a backtest, never applied by themselves.
const H=3600000,fin=v=>v!==null&&v!==undefined&&v!==''&&Number.isFinite(Number(v));
const TREND_KO={up:'상승',down:'하락',range:'횡보'};
export const patternOf=r=>r.signal?.pattern||String(r.signalKey||'').split(':')[3]||'알 수 없음';

/** One closed live record → journal facts, reasons and next steps. */
export function reviewTrade(r){
 const net=fin(r.realized?.netUSD)?Number(r.realized.netUSD):null,adds=Array.isArray(r.adds)?r.adds:[];
 const filled=adds.filter(a=>a.filled).length,hold=r.closedAt&&r.createdAt?(r.closedAt-r.createdAt)/H:null;
 const types=new Set((r.events||[]).map(e=>e.type)),tp1=r.breakevenMoved||types.has('STOP_TO_BREAKEVEN');
 const dir=r.direction,btc=r.signal?.btcTrend??null,t4=r.signal?.trend4h??null,score=r.signal?.score??null;
 const against=t=>t&&(dir==='LONG'&&t==='down'||dir==='SHORT'&&t==='up');
 const outcome=net===null?'UNKNOWN':net>0?'PROFIT':tp1&&net>-0.5?'BREAKEVEN':'LOSS';
 const reasons=[],next=[];
 if(outcome==='PROFIT'){
  reasons.push(tp1?'1차 목표가 체결된 뒤 손절을 본절로 올려 수익을 지켰습니다.':'목표가에 도달해 수익으로 마감했습니다.');
  if(filled)reasons.push(`추매 ${filled}회로 평균 진입가가 유리해진 뒤 반등해 수익이 났습니다.`);
  if(hold!==null&&hold<6)reasons.push('짧은 시간 안에 방향이 맞았습니다 (진입 타이밍 양호).');
 }else if(outcome==='BREAKEVEN'){
  reasons.push('1차 목표 뒤 가격이 되돌아와 본절 근처에서 마감했습니다.');
  next.push('1차 목표 이후 남은 물량의 2차 목표가 너무 먼지 확인합니다 (매물대 간격).');
 }else if(outcome==='LOSS'){
  if(filled&&filled===adds.length)reasons.push(`추매 ${filled}회가 모두 체결된 뒤 손절됐습니다. 매물대(지지·저항)가 버티지 못하고 추세가 이어졌습니다.`);
  else if(filled)reasons.push(`추매 ${filled}회 체결 뒤 손절됐습니다.`);
  if(hold!==null&&hold<2&&!filled)reasons.push('진입 직후 곧바로 반대로 움직였습니다 (돌파 실패 또는 늦은 진입 가능성).');
  if(hold!==null&&hold>72)reasons.push(`${Math.round(hold/24)}일 넘게 끌다가 손절됐습니다.`);
  if(against(btc))reasons.push(`BTC 4시간 추세(${TREND_KO[btc]})와 반대 방향 진입이었습니다.`);
  if(against(t4))reasons.push(`해당 코인 4시간 추세(${TREND_KO[t4]})와 반대 방향 진입이었습니다.`);
  if(!reasons.length)reasons.push('손절가에 닿아 마감했습니다. 기록된 사실만으로는 뚜렷한 원인을 특정하지 못했습니다.');
  if(filled&&filled===adds.length)next.push('추매 최대 횟수나 추매 간격(매물대 선택)을 줄이는 방안을 백테스트로 비교합니다.');
  if(hold!==null&&hold<2&&!filled)next.push('진입 조건에 확정봉 이후 되돌림 확인(재시험)을 더하는 방안을 검토합니다.');
  if(against(btc)||against(t4))next.push('추세와 반대 방향 진입을 막는 조건을 이 패턴에 적용하는 방안을 검토합니다.');
  if(hold!==null&&hold>72)next.push('최대 보유 기간을 두는 방안을 백테스트로 비교합니다.');
  if(score!==null&&score<85)next.push(`점수 ${score}점 진입이었습니다. 이 패턴의 최소 점수를 올리는 방안을 검토합니다.`);
 }else reasons.push('거래소 정산을 확인하지 못해 결과를 판단할 수 없습니다.');
 return {outcome,netUSD:net,pattern:patternOf(r),score,btcTrend:btc,trend4h:t4,addsFilled:filled,addsMax:adds.length,holdHours:hold===null?null:Math.round(hold*10)/10,tp1,reasons,next};
}

/** Per-pattern results and the changes worth testing (5+ trades only). */
export function patternInsights(reviews){
 const by=new Map();
 for(const v of reviews){if(v.netUSD===null)continue;const s=by.get(v.pattern)||{pattern:v.pattern,trades:0,wins:0,netUSD:0,fullAddStops:0,quickStops:0,againstTrend:0};
  s.trades++;if(v.netUSD>0)s.wins++;s.netUSD+=v.netUSD;
  if(v.outcome==='LOSS'&&v.addsMax&&v.addsFilled===v.addsMax)s.fullAddStops++;
  if(v.outcome==='LOSS'&&v.holdHours!==null&&v.holdHours<2&&!v.addsFilled)s.quickStops++;
  if(v.outcome==='LOSS'&&v.reasons.some(x=>x.includes('반대 방향')))s.againstTrend++;by.set(v.pattern,s)}
 return [...by.values()].map(s=>{const out={...s,netUSD:Math.round(s.netUSD*100)/100,winRatePct:Math.round(s.wins/s.trades*1000)/10,suggestions:[]};
  if(s.trades>=5&&out.netUSD<0)out.suggestions.push('누적 손실 패턴입니다. 1년 백테스트로 다시 확인한 뒤 거래 중지를 검토합니다.');
  if(s.trades>=5&&s.fullAddStops/s.trades>=0.3)out.suggestions.push('추매를 모두 채우고 손절되는 비율이 높습니다. 추매 횟수 축소를 검토합니다.');
  if(s.trades>=5&&s.quickStops/s.trades>=0.3)out.suggestions.push('진입 직후 손절이 잦습니다. 진입 확인 조건 강화를 검토합니다.');
  if(s.trades>=5&&s.againstTrend/s.trades>=0.3)out.suggestions.push('추세 반대 진입 손절이 잦습니다. 추세 필터 적용을 검토합니다.');
  return out}).sort((a,b)=>a.netUSD-b.netUSD);
}

/** Journal entry for a closed, settled live record (fits the existing journal list and summary). */
export function journalEntryFor(r){
 const v=reviewTrade(r),entry=Number(r.firstEntryPrice??r.plannedEntry)||null;
 return {id:'live-'+String(r.signalKey).replace(/[^\w:.-]/g,'').slice(-80),source:'LIVE_AUTO',liveKey:r.signalKey,mode:r.mode,symbol:r.symbol,side:r.direction,
  entry,averageEntry:Number(r.position?.entryPrice)||entry,stop:Number(r.stop)||null,exit:null,notional:null,leverage:Number(r.leverage)||null,fees:Number(r.realized?.feeUSD)||0,funding:Number(r.realized?.fundingUSD)||0,
  status:'CLOSED',createdAt:r.createdAt,closedAt:r.closedAt,stopRiskUSD:Number(r.plannedRiskUSD)||0,realizedPnLUSD:v.netUSD,realizedSource:r.realized?.source??null,
  note:[v.pattern,...v.reasons].join(' · ').slice(0,300),review:v};
}
