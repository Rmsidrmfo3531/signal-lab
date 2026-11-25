// High-impact macroeconomic indicator calendar bar on the main dashboard.
// Features a live 1-second countdown before release and immediate actual-vs-forecast results upon print.

const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const kstTime=t=>t?new Date(t).toLocaleTimeString('ko-KR',{timeZone:'Asia/Seoul',hour12:false,hour:'2-digit',minute:'2-digit'}):'—';

export function formatClientCountdown(at,now=Date.now(),{hasActual=false,expectsActual=true}={}){
 if(hasActual)return '발표 완료';
 const diffMs=Number(at)-Number(now);
 if(diffMs<=0){
  const agoMin=Math.floor(Math.abs(diffMs)/60000);
  if(agoMin<15)return expectsActual?'발표 완료 · 결과 수집 중':'진행 중 · 변동성 유의';
  if(agoMin<60)return `${agoMin}분 전 발표`;
  return `${Math.floor(agoMin/60)}시간 전 발표`;
 }
 if(diffMs<24*3600000){
  const totalSec=Math.max(0,Math.ceil(diffMs/1000));
  const h=Math.floor(totalSec/3600);
  const m=Math.floor((totalSec%3600)/60);
  const s=totalSec%60;
  const p2=n=>String(n).padStart(2,'0');
  return h>0?`T-${p2(h)}:${p2(m)}:${p2(s)}`:`T-${p2(m)}:${p2(s)}`;
 }
 const hrs=Math.floor(diffMs/3600000);
 const days=Math.floor(hrs/24);
 const remHr=hrs%24;
 return remHr>0?`${days}일 ${remHr}시간 후`:`${days}일 후`;
}

function surpriseChip(ev){
 if(!ev?.surprise)return '';
 const dir=String(ev.surprise.direction||'').toLowerCase();
 const delta=ev.surprise.deltaText&&ev.surprise.deltaText!=='0'?` ${ev.surprise.deltaText}`:'';
 return `<span class="econ-surprise ${esc(dir)}">${esc(ev.surprise.labelKo)}${esc(delta)}</span>`;
}

function renderEventRow(ev,isRecent=false){
 const tierCls=ev.tier==='CRITICAL'?'critical':'high';
 const tierIcon=ev.tier==='CRITICAL'?'🔥':'🔴';
 const hasActual=Boolean(ev.actual);
 const imminentCls=!isRecent&&!hasActual&&ev.isImminent?' imminent':'';
 const releasedCls=hasActual&&ev.isJustReleased?' released':'';
 const metrics=[];
 if(hasActual)metrics.push(`<span class="econ-actual">실제 <b>${esc(ev.actual)}</b></span>`);
 if(ev.forecast)metrics.push(`<span>예상 <b>${esc(ev.forecast)}</b></span>`);
 if(ev.previous)metrics.push(`<span>이전 <b>${esc(ev.previous)}</b></span>`);
 const surp=surpriseChip(ev);
 const cdAttrs=!hasActual?` data-econ-cd="1" data-econ-at="${Number(ev.at)||0}" data-econ-expects="${ev.expectsActual===false?'0':'1'}"`:'';
 return `
  <div class="econ-row${imminentCls}${releasedCls}${isRecent&&!ev.isJustReleased?' recent':''}">
   <div class="econ-row-left">
    <span class="econ-tier ${tierCls}">${tierIcon} ${esc(ev.tierLabelKo||'강력')}</span>
    <div class="econ-title-wrap">
     <div class="econ-title">${esc(ev.flag||'🌐')} <b>${esc(ev.titleKo)}</b>${ev.title&&ev.title!==ev.titleKo?` <small class="econ-orig">${esc(ev.title)}</small>`:''}</div>
     ${ev.hintKo?`<div class="econ-hint">${esc(ev.hintKo)}</div>`:''}
    </div>
   </div>
   <div class="econ-row-right">
    <div class="econ-time"><b>${esc(ev.kstDateLabel)} ${esc(ev.kstTimeLabel)}</b> <span class="econ-cd${imminentCls}${hasActual?' done':''}"${cdAttrs}>${esc(ev.countdownKo)}</span></div>
    ${metrics.length||surp?`<div class="econ-vals">${metrics.join(' · ')}${surp?` ${surp}`:''}</div>`:''}
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
 const justReleased=Array.isArray(d.justReleased)?d.justReleased:[];
 const latestResult=justReleased[0]||null;

 let badgeCls='neutral',badgeTxt='📅 주요 경제지표';
 if(next?.isAwaitingResult){badgeCls='imminent';badgeTxt='⏳ 지표 결과 수집 중'}
 else if(latestResult){badgeCls='released';badgeTxt='📢 지표 발표 결과'}
 else if(next?.isImminent){badgeCls='imminent';badgeTxt='⚠️ 지표 발표 임박'}
 else if(next?.tier==='CRITICAL'){badgeCls='critical';badgeTxt='🔥 초강력 경제지표'}
 else if(next){badgeCls='high';badgeTxt='🔴 주요 경제지표'}

 const pills=[];
 if(latestResult){
  const fc=latestResult.forecast?` (예상 ${esc(latestResult.forecast)})`:'';
  const surp=surpriseChip(latestResult);
  pills.push(`<span class="econ-pill econ-result">${esc(latestResult.flag||'')} <b>${esc(latestResult.titleKo)}</b> · <span class="econ-actual">실제 <b>${esc(latestResult.actual)}</b></span>${fc}${surp?` ${surp}`:''}</span>`);
 }
 if(next){
  const fc=next.forecast?` · 예상 <b>${esc(next.forecast)}</b>`:'';
  const cdAttrs=` data-econ-cd="1" data-econ-at="${Number(next.at)||0}" data-econ-expects="${next.expectsActual===false?'0':'1'}"`;
  pills.push(`<span class="econ-pill econ-next${next.isImminent?' imminent':''}">${esc(next.flag||'')} <b>${esc(next.titleKo)}</b> · ${esc(next.kstDateLabel)} ${esc(next.kstTimeLabel)} KST · <em class="econ-cd-inline"${cdAttrs}>${esc(next.countdownKo)}</em>${fc}</span>`);
  const crit=d.criticalCount>0?` · 초강력 ${d.criticalCount}`:'';
  pills.push(`<span class="econ-pill">예정 ${upcoming.length}건${crit}</span>`);
  if(!latestResult&&upcoming.length>1){
   const second=upcoming[1];
   pills.push(`<span class="econ-pill econ-sub">다음: ${esc(second.flag||'')} ${esc(second.titleKo)} (${esc(second.kstDateLabel)} ${esc(second.kstTimeLabel)})</span>`);
  }
 }else if(!latestResult&&d.error){
  pills.push(`<span class="econ-pill">경제지표 일정 일시 조회 지연 (${esc(d.error)})</span>`);
 }else if(!latestResult){
  pills.push(`<span class="econ-pill">이번 주 남은 고영향 경제지표 일정이 없습니다</span>`);
 }

 const errNote=d.error?`<span class="econ-err">캘린더 조회 참고: ${esc(d.error)}${upcoming.length||recent.length?' (마지막 캐시 일정 표시 중)':''}</span>`:'';
 const justReleasedHtml=justReleased.length?`
  <div class="econ-just-wrap">
   <div class="econ-subhead released">📢 방금 발표된 고영향 지표 결과 (${justReleased.length}건)</div>
   <div class="econ-list">${justReleased.map(ev=>renderEventRow(ev,false)).join('')}</div>
  </div>`:'';

 const upcomingHtml=upcoming.length
  ?`<div class="econ-list">${upcoming.map(ev=>renderEventRow(ev,false)).join('')}</div>`
  :`<div class="econ-empty">현재 표시할 예정 고영향 경제지표(미국 CPI·PCE·FOMC·고용 및 주요국 금리)가 없습니다.</div>`;

 const olderRecent=recent.filter(ev=>!ev.isJustReleased);
 const recentHtml=olderRecent.length?`
  <div class="econ-recent-wrap">
   <div class="econ-subhead">최근 24시간 발표 완료 (${olderRecent.length}건)</div>
   <div class="econ-list">${olderRecent.map(ev=>renderEventRow(ev,true)).join('')}</div>
  </div>`:'';

 return `
  <summary class="econ-summary">
   <span class="econ-badge ${badgeCls}">${badgeTxt}</span>
   <span class="econ-pills">${pills.join('')}</span>
   <span class="econ-chevron">일정 ▾</span>
  </summary>
  <div class="econ-body">
   <div class="econ-top-row">
    <p class="econ-desc">미국 FOMC·CPI·PCE·비농업고용 등 코인 시장 파급력이 큰 고영향 지표만 선별해 한국시간(KST)으로 표시합니다. 발표 전 실시간 카운트다운과 발표 직후 실제 결과(예상치 대비 상회·부합·하회)를 자동 반영합니다.</p>
    <div class="econ-actions"><small>${esc(d.source||'')} · ${kstTime(d.updatedAt)} KST</small><button type="button" class="outline-btn small" data-econ-refresh="1">↻ 갱신</button></div>
   </div>
   ${errNote}
   ${justReleasedHtml}
   ${upcomingHtml}
   ${recentHtml}
  </div>`;
}

if(typeof document!=='undefined'&&typeof window!=='undefined'){
 const host=document.getElementById('econCalendarBar');
 if(host){
  let busy=false;
  let lastData=null;
  let clockOffsetMs=0;
  let lastFastFetchAt=0;

  const applyData=data=>{
   if(!data)return;
   lastData=data;
   if(Number.isFinite(Number(data.serverNow)))clockOffsetMs=Number(data.serverNow)-Date.now();
   host.innerHTML=renderEconomicCalendarHTML(data);
  };

  const load=async(force=false)=>{
   if(busy)return;
   busy=true;
   try{
    const r=await fetch('/api/economic-calendar'+(force?'?force=1':''),{cache:'no-store',signal:AbortSignal.timeout(15000)});
    if(!r.ok)return;
    const data=await r.json().catch(()=>null);
    if(data)applyData(data);
   }catch{}
   finally{
    busy=false;
    const b=host.querySelector('[data-econ-refresh]');
    if(b)b.disabled=false;
   }
  };

  const tickCountdowns=()=>{
   if(document.hidden||!lastData)return;
   const now=Date.now()+clockOffsetMs;
   let needsFastRefresh=Boolean(lastData.releaseWatch);
   for(const el of host.querySelectorAll('[data-econ-cd]')){
    const at=Number(el.getAttribute('data-econ-at'));
    if(!Number.isFinite(at)||at<=0)continue;
    const expects=el.getAttribute('data-econ-expects')!=='0';
    el.textContent=formatClientCountdown(at,now,{hasActual:false,expectsActual:expects});
    const diffMs=at-now;
    if(expects&&diffMs<=15000&&diffMs>=-15*60000)needsFastRefresh=true;
   }
   if(needsFastRefresh&&now-lastFastFetchAt>=15000){
    lastFastFetchAt=now;
    void load(false);
   }
  };

  host.addEventListener('click',e=>{
   const btn=e.target.closest?.('[data-econ-refresh]');
   if(!btn)return;
   e.preventDefault();e.stopPropagation();
   btn.disabled=true;
   void load(true);
  });

  window.addEventListener('signal-lab:econ-calendar',e=>{
   if(e?.detail)applyData(e.detail);
  });

  void load(false);
  setInterval(tickCountdowns,1000);
  setInterval(()=>{if(!document.hidden)void load(false)},60000);
 }
}
