// High-impact macroeconomic indicator calendar bar on the main dashboard.
// Renders a 1-row next-event countdown strip + expandable Korean schedule of crypto-moving releases.

const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const kstTime=t=>t?new Date(t).toLocaleTimeString('ko-KR',{timeZone:'Asia/Seoul',hour12:false,hour:'2-digit',minute:'2-digit'}):'—';

function renderEventRow(ev,isRecent=false){
 const tierCls=ev.tier==='CRITICAL'?'critical':'high';
 const tierIcon=ev.tier==='CRITICAL'?'🔥':'🔴';
 const imminentCls=!isRecent&&ev.isImminent?' imminent':'';
 const metrics=[];
 if(ev.actual)metrics.push(`<span>실제 <b>${esc(ev.actual)}</b></span>`);
 if(ev.forecast)metrics.push(`<span>예상 <b>${esc(ev.forecast)}</b></span>`);
 if(ev.previous)metrics.push(`<span>이전 <b>${esc(ev.previous)}</b></span>`);
 return `
  <div class="econ-row${imminentCls}${isRecent?' recent':''}">
   <div class="econ-row-left">
    <span class="econ-tier ${tierCls}">${tierIcon} ${esc(ev.tierLabelKo||'강력')}</span>
    <div class="econ-title-wrap">
     <div class="econ-title">${esc(ev.flag||'🌐')} <b>${esc(ev.titleKo)}</b>${ev.title&&ev.title!==ev.titleKo?` <small class="econ-orig">${esc(ev.title)}</small>`:''}</div>
     ${ev.hintKo?`<div class="econ-hint">${esc(ev.hintKo)}</div>`:''}
    </div>
   </div>
   <div class="econ-row-right">
    <div class="econ-time"><b>${esc(ev.kstDateLabel)} ${esc(ev.kstTimeLabel)}</b> <span class="econ-cd${imminentCls}">${esc(ev.countdownKo)}</span></div>
    ${metrics.length?`<div class="econ-vals">${metrics.join(' · ')}</div>`:''}
   </div>
  </div>`;
}

export function renderEconomicCalendarHTML(d){
 if(!d){
  return `<summary class="econ-summary"><span class="econ-badge neutral">📅 주요 경제지표</span><span class="econ-pills"><span class="econ-pill">고영향 거시지표 일정 불러오는 중…</span></span><span class="econ-chevron">일정 ▾</span></summary>`;
 }
 const next=d.nextEvent||null;
 const upcoming=Array.isArray(d.upcoming)?d.upcoming:[];
 const recent=Array.isArray(d.recent)?d.recent:[];

 let badgeCls='neutral',badgeTxt='📅 주요 경제지표';
 if(next?.isImminent){badgeCls='imminent';badgeTxt='⚠️ 지표 발표 임박'}
 else if(next?.tier==='CRITICAL'){badgeCls='critical';badgeTxt='🔥 초강력 경제지표'}
 else if(next){badgeCls='high';badgeTxt='🔴 주요 경제지표'}

 const pills=[];
 if(next){
  const fc=next.forecast?` · 예상 <b>${esc(next.forecast)}</b>`:'';
  pills.push(`<span class="econ-pill econ-next${next.isImminent?' imminent':''}">${esc(next.flag||'')} <b>${esc(next.titleKo)}</b> · ${esc(next.kstDateLabel)} ${esc(next.kstTimeLabel)} KST · <em class="econ-cd-inline">${esc(next.countdownKo)}</em>${fc}</span>`);
  const extra=upcoming.length>1?`+${upcoming.length-1}건 더`:'1건 예정';
  const crit=d.criticalCount>0?` · 초강력 ${d.criticalCount}`:'';
  pills.push(`<span class="econ-pill">예정 ${upcoming.length}건${crit}</span>`);
  if(upcoming.length>1){
   const second=upcoming[1];
   pills.push(`<span class="econ-pill econ-sub">다음: ${esc(second.flag||'')} ${esc(second.titleKo)} (${esc(second.kstDateLabel)} ${esc(second.kstTimeLabel)})</span>`);
  }else if(extra){
   // keep single upcoming compact
  }
 }else if(d.error){
  pills.push(`<span class="econ-pill">경제지표 일정 일시 조회 지연 (${esc(d.error)})</span>`);
 }else{
  pills.push(`<span class="econ-pill">이번 주 남은 고영향 경제지표 일정이 없습니다</span>`);
 }

 const errNote=d.error?`<span class="econ-err">캘린더 조회 참고: ${esc(d.error)}${upcoming.length?' (마지막 캐시 일정 표시 중)':''}</span>`:'';
 const upcomingHtml=upcoming.length
  ?`<div class="econ-list">${upcoming.map(ev=>renderEventRow(ev,false)).join('')}</div>`
  :`<div class="econ-empty">현재 표시할 예정 고영향 경제지표(미국 CPI·PCE·FOMC·고용 및 주요국 금리)가 없습니다.</div>`;

 const recentHtml=recent.length?`
  <div class="econ-recent-wrap">
   <div class="econ-subhead">최근 24시간 발표 완료 (${recent.length}건)</div>
   <div class="econ-list">${recent.map(ev=>renderEventRow(ev,true)).join('')}</div>
  </div>`:'';

 return `
  <summary class="econ-summary">
   <span class="econ-badge ${badgeCls}">${badgeTxt}</span>
   <span class="econ-pills">${pills.join('')}</span>
   <span class="econ-chevron">일정 ▾</span>
  </summary>
  <div class="econ-body">
   <div class="econ-top-row">
    <p class="econ-desc">미국 FOMC·CPI·PCE·비농업고용 등 코인 시장 파급력이 큰 고영향 지표만 선별해 한국시간(KST)으로 표시합니다. 발표 전후 15~30분은 급격한 위아래 휩소(청산) 변동성에 유의하세요.</p>
    <div class="econ-actions"><small>${kstTime(d.updatedAt)} KST</small><button type="button" class="outline-btn small" data-econ-refresh="1">↻ 갱신</button></div>
   </div>
   ${errNote}
   ${upcomingHtml}
   ${recentHtml}
  </div>`;
}

if(typeof document!=='undefined'&&typeof window!=='undefined'){
 const host=document.getElementById('econCalendarBar');
 if(host){
  let busy=false;
  const load=async(force=false)=>{
   if(busy)return;
   busy=true;
   try{
    const r=await fetch('/api/economic-calendar'+(force?'?force=1':''),{cache:'no-store',signal:AbortSignal.timeout(15000)});
    if(!r.ok)return;
    const data=await r.json().catch(()=>null);
    if(data)host.innerHTML=renderEconomicCalendarHTML(data);
   }catch{}
   finally{
    busy=false;
    const b=host.querySelector('[data-econ-refresh]');
    if(b)b.disabled=false;
   }
  };
  host.addEventListener('click',e=>{
   const btn=e.target.closest?.('[data-econ-refresh]');
   if(!btn)return;
   e.preventDefault();e.stopPropagation();
   btn.disabled=true;
   void load(true);
  });
  void load(false);
  setInterval(()=>{if(!document.hidden)void load(false)},60000);
 }
}
