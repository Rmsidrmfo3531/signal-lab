// Is the strategy ready for real money? Measured on TESTNET trades taken under the current rules
// (since LIVE_READINESS_SINCE). The criteria were agreed with the user on 2026-11-12/13:
// at least 30 closed trades over at least 14 days, net result above zero after fees, the worst
// drop of the running result within 30% of the trading balance, and no serious order problem.
// This only reports; switching to real money stays a manual change by the user.
export const READINESS_DEFAULTS=Object.freeze({since:Date.parse('2026-11-12T14:00:00Z'),minTrades:30,minDays:14,maxDrawdownPct:30,balanceUSD:400});
// Order problems that would lose money or leave a position unprotected with real funds.
export const SERIOUS_EVENTS=Object.freeze(['ENTRY_OUTCOME_UNKNOWN','STOP_FAILED','TARGET_FAILED','CANCEL_FAILED','EMERGENCY_CLOSED',
 'LATE_ADD_CLOSE_FAILED','RESTART_WHILE_SUBMITTING']);
const DAY=86400000,fin=v=>v!==null&&v!==undefined&&v!==''&&Number.isFinite(Number(v));

export function liveReadiness(records=[],{mode='TESTNET',now=Date.now(),since=READINESS_DEFAULTS.since,minTrades=READINESS_DEFAULTS.minTrades,
 minDays=READINESS_DEFAULTS.minDays,maxDrawdownPct=READINESS_DEFAULTS.maxDrawdownPct,balanceUSD}={}){
 const mine=records.filter(r=>r&&r.test!==true&&r.mode===mode&&(r.createdAt||0)>=since);
 // Drawdown is measured against the balance the orders were sized from (median of the trades'
 // recorded sizing balance), unless one is given; 400 USD when nothing is recorded.
 if(!(balanceUSD>0)){const b=mine.map(r=>Number(r.balanceUSD)).filter(x=>x>0).sort((a,c)=>a-c);balanceUSD=b.length?b[Math.floor(b.length/2)]:READINESS_DEFAULTS.balanceUSD}
 const closed=mine.filter(r=>r.status==='CLOSED').sort((a,b)=>(a.closedAt||0)-(b.closedAt||0));
 const settled=closed.filter(r=>fin(r.realized?.netUSD));
 let run=0,peak=0,maxDD=0,wins=0;
 for(const r of settled){const x=Number(r.realized.netUSD);run+=x;if(x>0)wins++;peak=Math.max(peak,run);maxDD=Math.max(maxDD,peak-run)}
 const first=mine.reduce((m,r)=>Math.min(m,r.createdAt||Infinity),Infinity);
 const days=Number.isFinite(first)?(now-first)/DAY:0;
 const serious=[];
 for(const r of mine){for(const e of r.events||[])if(SERIOUS_EVENTS.includes(e.type))serious.push({symbol:r.symbol,type:e.type,reason:e.reason??null,at:e.at??null});
  if(r.status==='UNKNOWN')serious.push({symbol:r.symbol,type:'STATUS_UNKNOWN',reason:null,at:r.createdAt??null})}
 const reconcileErrors=mine.reduce((n,r)=>n+(r.events||[]).filter(e=>e.type==='RECONCILE_ERROR').length,0);
 const ddPct=balanceUSD>0?maxDD/balanceUSD*100:null,net=Math.round(run*100)/100;
 const checks=[
  {key:'trades',label:`청산된 거래 ${minTrades}건 이상`,value:`${closed.length}건 (정산 확인 ${settled.length}건)`,ok:settled.length>=minTrades},
  {key:'days',label:`${minDays}일 이상 운영`,value:`${days.toFixed(1)}일`,ok:days>=minDays},
  {key:'net',label:'수수료 뺀 누적 손익 플러스',value:`${net>=0?'+':'−'}$${Math.abs(net).toFixed(2)}`,ok:settled.length>0&&net>0},
  {key:'drawdown',label:`최대 손실 구간 잔고의 ${maxDrawdownPct}% 이내`,value:ddPct===null?'—':`−$${maxDD.toFixed(2)} (${ddPct.toFixed(1)}%)`,ok:ddPct!==null&&ddPct<=maxDrawdownPct},
  {key:'errors',label:'심각한 주문 문제 0건',value:`${serious.length}건`,ok:serious.length===0}];
 return {mode,since,at:now,balanceUSD,ready:checks.every(c=>c.ok),checks,trades:closed.length,settled:settled.length,wins,
  winRatePct:settled.length?Math.round(wins/settled.length*1000)/10:null,netUSD:net,maxDrawdownUSD:Math.round(maxDD*100)/100,
  drawdownPct:ddPct===null?null:Math.round(ddPct*10)/10,days:Math.round(days*10)/10,open:mine.filter(r=>r.status==='OPEN').length,
  serious:serious.slice(-10),reconcileErrors};
}

/** Short daily Telegram text (no keys, no account numbers). */
export function readinessText(r){
 const head=r.ready?'✅ 실매매 전환 기준을 모두 충족했습니다':'📊 테스트넷 실매매 점검';
 return [head,`거래 ${r.settled}건 · 승률 ${r.winRatePct??'—'}% · 누적 ${r.netUSD>=0?'+':'−'}$${Math.abs(r.netUSD).toFixed(2)} · 최대 손실 구간 ${r.drawdownPct??'—'}%`,
  `운영 ${r.days}일 · 보유 ${r.open}건 · 심각한 주문 문제 ${r.serious.length}건${r.reconcileErrors?` · 일시적 확인 오류 ${r.reconcileErrors}회`:''}`,
  ...r.checks.map(c=>`${c.ok?'✓':'·'} ${c.label}: ${c.value}`),
  r.ready?'실제 돈 전환은 설정 파일을 직접 바꿔야 합니다. 작은 금액부터 시작하세요.':''].filter(Boolean).join('\n');
}
