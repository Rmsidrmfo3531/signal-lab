// Compact BTC vs Altcoin Dominance & Relative Strength bar on the main dashboard.
// Renders a 1-row summary strip (always visible across tabs) + expandable breakdown card.

const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmtPct=(v,sign=true)=>{const n=Number(v);if(v==null||!Number.isFinite(n))return '—';return `${sign&&n>0?'+':''}${n.toFixed(2)}%`};
const fmtShare=v=>{const n=Number(v);return v==null||!Number.isFinite(n)?'—':`${n.toFixed(1)}%`};
const fmtDelta=v=>{const n=Number(v);if(v==null||!Number.isFinite(n))return '';return `${n>=0?'+':''}${n.toFixed(2)}%p`};
const fmtTril=v=>{const n=Number(v);if(v==null||!Number.isFinite(n)||n<=0)return '—';if(n>=1e12)return `$${(n/1e12).toFixed(2)}T`;if(n>=1e9)return `$${(n/1e9).toFixed(1)}B`;return `$${n.toLocaleString('en-US')}`};
const kstTime=t=>t?new Date(t).toLocaleTimeString('ko-KR',{timeZone:'Asia/Seoul',hour12:false,hour:'2-digit',minute:'2-digit'}):'—';
const clsPct=v=>{const n=Number(v);if(v==null||!Number.isFinite(n))return '';return n>0?'positive':n<0?'negative':''};
const shortSym=s=>String(s||'').replace(/USDT$/,'');

export function renderDominanceHTML(d){
 if(!d||!d.ok){
  return `<summary class="dom-summary"><span class="dom-badge neutral">⏳ 시장 주도권 조회 중</span><span class="dom-pills"><span class="dom-pill">BTC.D · 알트 도미넌스 불러오는 중…</span></span><span class="dom-chevron">상세 ▾</span></summary>`;
 }
 const g=d.global,b=d.breadth,del=d.deltas;
 const tone=esc(d.tone||'neutral');
 const deltaLabel=del?(del.is24h?'24h':`${del.windowHours}h`):'';

 const summaryPills=[];
 if(g){
  summaryPills.push(`<span class="dom-pill dom-btc">BTC.D <b>${fmtShare(g.btcDomPct)}</b>${del?.btcDomDelta!=null?` <small class="${clsPct(-del.btcDomDelta)}">${fmtDelta(del.btcDomDelta)}</small>`:''}</span>`);
  summaryPills.push(`<span class="dom-pill dom-eth">ETH.D <b>${fmtShare(g.ethDomPct)}</b></span>`);
  if(g.solDomPct!=null)summaryPills.push(`<span class="dom-pill dom-sol">SOL.D <b>${fmtShare(g.solDomPct)}</b>${del?.solDomDelta!=null?` <small class="${clsPct(del.solDomDelta)}">${fmtDelta(del.solDomDelta)}</small>`:''}</span>`);
  if(g.usdtDomPct!=null)summaryPills.push(`<span class="dom-pill dom-usdt">USDT.D <b>${fmtShare(g.usdtDomPct)}</b>${del?.usdtDomDelta!=null?` <small class="${clsPct(-del.usdtDomDelta)}">${fmtDelta(del.usdtDomDelta)}</small>`:''}</span>`);
  summaryPills.push(`<span class="dom-pill dom-alt">알트.D <b>${fmtShare(g.altDomPct)}</b></span>`);
 }
 if(b){
  summaryPills.push(`<span class="dom-pill">BTC <b class="${clsPct(b.btcPct24h)}">${fmtPct(b.btcPct24h)}</b> vs 알트중앙 <b class="${clsPct(b.altMedianPct24h)}">${fmtPct(b.altMedianPct24h)}</b></span>`);
  summaryPills.push(`<span class="dom-pill">알트 승률 <b>${b.altBeatBtcPct}%</b></span>`);
 }

 const otherAltPct=g?(g.otherAltDomPct??Math.max(0,g.altDomPct-(g.solDomPct??0))):0;
 const otherStablePct=g?(g.otherStableDomPct??Math.max(0,g.stableDomPct-(g.usdtDomPct??0))):0;
 const stackBar=g?`
  <div class="dom-stack-wrap">
   <div class="dom-stack-head"><span>시가총액 도미넌스 비중${g.totalMcapUSD?` · 전체 ${fmtTril(g.totalMcapUSD)}`:''}${g.mcapChange24hPct!=null?` (<span class="${clsPct(g.mcapChange24hPct)}">${fmtPct(g.mcapChange24hPct)}</span>)`:''}</span><small>CoinGecko 글로벌</small></div>
   <div class="dom-stack" role="img" aria-label="BTC ${g.btcDomPct}%, ETH ${g.ethDomPct}%, ${g.solDomPct!=null?`SOL ${g.solDomPct}%, `:''}기타 알트 ${otherAltPct.toFixed(1)}%, ${g.usdtDomPct!=null?`USDT ${g.usdtDomPct}%, `:''}기타 스테이블 ${otherStablePct.toFixed(1)}%">
    <i class="seg-btc" style="width:${g.btcDomPct}%" title="BTC.D ${g.btcDomPct}%"></i>
    <i class="seg-eth" style="width:${g.ethDomPct}%" title="ETH.D ${g.ethDomPct}%"></i>
    ${g.solDomPct!=null?`<i class="seg-sol" style="width:${g.solDomPct}%" title="SOL.D ${g.solDomPct}%"></i>`:''}
    <i class="seg-alt" style="width:${otherAltPct}%" title="기타 알트 ${otherAltPct.toFixed(2)}%"></i>
    ${g.usdtDomPct!=null?`<i class="seg-usdt" style="width:${g.usdtDomPct}%" title="USDT.D ${g.usdtDomPct}%"></i>`:''}
    ${otherStablePct>0?`<i class="seg-stable" style="width:${otherStablePct}%" title="기타 스테이블 ${otherStablePct.toFixed(2)}%"></i>`:''}
   </div>
   <div class="dom-legend">
    <span><em class="seg-btc"></em>BTC ${fmtShare(g.btcDomPct)}</span>
    <span><em class="seg-eth"></em>ETH ${fmtShare(g.ethDomPct)}</span>
    ${g.solDomPct!=null?`<span><em class="seg-sol"></em>SOL ${fmtShare(g.solDomPct)}</span>`:''}
    <span><em class="seg-alt"></em>기타 알트 ${fmtShare(otherAltPct)}</span>
    ${g.usdtDomPct!=null?`<span><em class="seg-usdt"></em>USDT ${fmtShare(g.usdtDomPct)}</span>`:''}
    ${otherStablePct>0?`<span><em class="seg-stable"></em>기타 스테이블 ${fmtShare(otherStablePct)}</span>`:''}
   </div>
  </div>`:'';

 const gauge=d.score!=null?`
  <div class="dom-gauge-wrap">
   <div class="dom-gauge-head"><span>BTC 강세</span><b>주도권 지수 ${d.score>0?'+':''}${d.score}</b><span>알트 강세</span></div>
   <div class="dom-gauge-track"><div class="dom-gauge-mid"></div><div class="dom-gauge-dot ${tone}" style="left:${Math.max(2,Math.min(98,d.gaugePct))}%"></div></div>
  </div>`:'';

 const cards=`
  <div class="dom-cards">
   <div class="dom-card">
    <span class="dom-k">BTC 도미넌스 (BTC.D)</span>
    <strong class="dom-v">${g?fmtShare(g.btcDomPct):'—'}</strong>
    <small>${del?.btcDomDelta!=null?`${deltaLabel} ${fmtDelta(del.btcDomDelta)} · `:''}BTC 24h <span class="${clsPct(b?.btcPct24h)}">${fmtPct(b?.btcPct24h)}</span></small>
   </div>
   <div class="dom-card">
    <span class="dom-k">ETH 도미넌스 (ETH.D)</span>
    <strong class="dom-v">${g?fmtShare(g.ethDomPct):'—'}</strong>
    <small>ETH 24h <span class="${clsPct(b?.ethPct24h)}">${fmtPct(b?.ethPct24h)}</span> · ETH/BTC <span class="${clsPct(b?.ethBtcPct24h)}">${fmtPct(b?.ethBtcPct24h)}</span></small>
   </div>
   <div class="dom-card">
    <span class="dom-k">SOL 도미넌스 (SOL.D)</span>
    <strong class="dom-v">${g?.solDomPct!=null?fmtShare(g.solDomPct):'—'}</strong>
    <small>${del?.solDomDelta!=null?`${deltaLabel} ${fmtDelta(del.solDomDelta)} · `:''}SOL 24h <span class="${clsPct(b?.solPct24h)}">${fmtPct(b?.solPct24h)}</span> · SOL/BTC <span class="${clsPct(b?.solBtcPct24h)}">${fmtPct(b?.solBtcPct24h)}</span></small>
   </div>
   <div class="dom-card">
    <span class="dom-k">USDT 도미넌스 (USDT.D)</span>
    <strong class="dom-v">${g?.usdtDomPct!=null?fmtShare(g.usdtDomPct):'—'}</strong>
    <small>${del?.usdtDomDelta!=null?`${deltaLabel} <span class="${clsPct(-del.usdtDomDelta)}">${fmtDelta(del.usdtDomDelta)}</span> · `:''}전체 스테이블 ${g?fmtShare(g.stableDomPct):'—'}</small>
   </div>
   <div class="dom-card">
    <span class="dom-k">순수 알트 (OTHERS.D)</span>
    <strong class="dom-v">${g?fmtShare(g.altDomPct):'—'}</strong>
    <small>중앙값 <span class="${clsPct(b?.altMedianPct24h)}">${fmtPct(b?.altMedianPct24h)}</span> · ${b?`BTC 상회 ${b.altBeatBtcPct}% (${b.sampleCount}종)`:'대기'}</small>
   </div>
  </div>`;

 const movers=b&&(b.topAlts?.length||b.bottomAlts?.length)?`
  <div class="dom-movers">
   ${b.topAlts?.length?`<span>강세 알트: ${b.topAlts.map(x=>`<b class="positive">${esc(shortSym(x.symbol))} ${fmtPct(x.pct)}</b>`).join(' · ')}</span>`:''}
   ${b.bottomAlts?.length?`<span>약세 알트: ${b.bottomAlts.map(x=>`<b class="negative">${esc(shortSym(x.symbol))} ${fmtPct(x.pct)}</b>`).join(' · ')}</span>`:''}
  </div>`:'';

 const errNote=d.globalError?`<span class="dom-err">도미넌스 조회 참고: ${esc(d.globalError)} (바이낸스 실시간 상대강도 기준 표시 중)</span>`:'';

 return `
  <summary class="dom-summary">
   <span class="dom-badge ${tone}">${esc(d.emoji||'')} ${esc(d.labelKo)}</span>
   ${d.phaseKo?`<span class="dom-phase">${esc(d.phaseKo)}</span>`:''}
   <span class="dom-pills">${summaryPills.join('')}</span>
   <span class="dom-chevron">상세 ▾</span>
  </summary>
  <div class="dom-body">
   <div class="dom-top-row">
    <p class="dom-explain">${esc(d.summaryKo)}</p>
    <div class="dom-actions"><small>${kstTime(d.updatedAt)} KST</small><button type="button" class="outline-btn small" data-dom-refresh="1">↻ 갱신</button></div>
   </div>
   ${errNote}
   ${stackBar}
   ${gauge}
   ${cards}
   ${movers}
  </div>`;
}

if(typeof document!=='undefined'&&typeof window!=='undefined'){
 const host=document.getElementById('dominanceBar');
 if(host){
  let busy=false;
  const load=async(force=false)=>{
   if(busy)return;
   busy=true;
   try{
    const r=await fetch('/api/market-dominance'+(force?'?force=1':''),{cache:'no-store',signal:AbortSignal.timeout(15000)});
    if(!r.ok)return;
    const data=await r.json().catch(()=>null);
    if(data){
     host.innerHTML=renderDominanceHTML(data);
     const navBadge=document.getElementById('navDomBadge');
     if(navBadge){
      const btcPct=data.global?.btcDomPct;
      navBadge.textContent=btcPct!=null?`${Number(btcPct).toFixed(1)}%`:(data.tone==='alt'||data.tone==='alt-strong'?'알트↑':data.tone==='btc'||data.tone==='btc-strong'?'BTC↑':'중립');
      navBadge.className='navright'+(data.tone==='alt'||data.tone==='alt-strong'?' tone-pos':data.tone==='btc'||data.tone==='btc-strong'?' tone-warn':'');
     }
    }
   }catch{}
   finally{
    busy=false;
    const b=host.querySelector('[data-dom-refresh]');
    if(b)b.disabled=false;
   }
  };
  host.addEventListener('click',e=>{
   const btn=e.target.closest?.('[data-dom-refresh]');
   if(!btn)return;
   e.preventDefault();e.stopPropagation();
   btn.disabled=true;
   void load(true);
  });
  void load(false);
  setInterval(()=>{if(!document.hidden)void load(false)},60000);
 }
}
