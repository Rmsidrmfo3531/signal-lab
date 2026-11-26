// Compact read-only Mini HUD for Signal Lab:
//   1) BTC real-time price & 24h change
//   2) BingX real-account (LIVE) open positions only (symbol, LONG/SHORT, unrealized PnL $ & ROE %)
//   3) Dominance (BTC.D, USDT.D, flow regime: 알트장 / 비트독주 / 현금대피)
// Works inside both Chrome/Edge Always-on-Top Document Picture-in-Picture and standalone /mini popup windows.
// Strictly read-only: NEVER sends orders or mutates server state.

const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fin=v=>v!==null&&v!==undefined&&v!==''&&Number.isFinite(Number(v));
const shortSym=s=>String(s||'').replace(/-?USDT$/i,'');

function fmtBtcPrice(v){
 if(!fin(v)||Number(v)<=0)return '—';
 const n=Number(v);
 return `$${n.toLocaleString('en-US',{minimumFractionDigits:n>=1000?1:2,maximumFractionDigits:n>=1000?1:4})}`;
}

function fmtPx(v){
 if(!fin(v)||Number(v)<=0)return '—';
 const n=Number(v);
 const maxD=n>=1000?1:n>=10?2:n>=1?3:n>=0.01?4:6;
 return n.toLocaleString('en-US',{maximumFractionDigits:maxD});
}

function fmtSignedUsd(v){
 if(!fin(v))return '—';
 const n=Number(v);
 return `${n>=0?'+':'−'}$${Math.abs(n).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})}`;
}

function fmtUsd(v){
 if(!fin(v))return '—';
 return `$${Number(v).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})}`;
}

function fmtSignedPct(v,digits=2){
 if(!fin(v))return '—';
 const n=Number(v);
 return `${n>=0?'+':''}${n.toFixed(digits)}%`;
}

function fmtDeltaPp(v){
 if(!fin(v))return '';
 const n=Number(v);
 return `${n>=0?'+':''}${n.toFixed(2)}%p`;
}

function fmtShare(v){
 if(!fin(v))return '—';
 return `${Number(v).toFixed(1)}%`;
}

function kstClock(ts){
 return ts?new Date(ts).toLocaleTimeString('ko-KR',{timeZone:'Asia/Seoul',hour12:false,hour:'2-digit',minute:'2-digit',second:'2-digit'}):'--:--:--';
}

/** Extract BTC current price and 24h change from /api/market (falling back to /api/market-dominance breadth). */
export function extractMiniBtc(marketPayload,domPayload=null,prev=null){
 const rows=Array.isArray(marketPayload?.markets)?marketPayload.markets:[];
 const btc=rows.find(x=>String(x?.symbol||'').toUpperCase()==='BTCUSDT')||null;
 const price=fin(btc?.price)&&Number(btc.price)>0?Number(btc.price):(fin(prev?.price)?prev.price:null);
 const changePct=fin(btc?.change)
  ?Number(btc.change)
  :(fin(btc?.priceChangePercent)
   ?Number(btc.priceChangePercent)
   :(fin(domPayload?.breadth?.btcPct24h)
    ?Number(domPayload.breadth.btcPct24h)
    :(fin(prev?.changePct)?prev.changePct:null)));
 const at=fin(btc?.priceAt)?Number(btc.priceAt):(fin(marketPayload?.at)?Number(marketPayload.at):(prev?.at||null));
 return {price,changePct,at};
}

/** Extract ONLY BingX real-account (LIVE) open positions from /api/copy. Never includes testnet positions. */
export function extractMiniRealPositions(copyPayload){
 if(!copyPayload||typeof copyPayload!=='object'){
  return {ready:false,mode:null,equity:null,available:null,positions:[],totalUnrealized:null,error:null};
 }
 const mode=String(copyPayload.mode||'OFF').toUpperCase();
 const rawList=Array.isArray(copyPayload.venuePositions)?copyPayload.venuePositions:[];
 const positions=rawList
  .filter(p=>p&&typeof p==='object'&&fin(p.size)&&Number(p.size)>0)
  .map(p=>{
   const unrealized=fin(p.unrealized)?Number(p.unrealized):null;
   const roePct=fin(p.roePct)?Number(p.roePct):null;
   const avg=fin(p.avg)?Number(p.avg):null;
   const mark=fin(p.mark)?Number(p.mark):null;
   const leverage=fin(p.leverage)?Number(p.leverage):null;
   const dir=String(p.direction||'').toUpperCase()==='SHORT'?'SHORT':'LONG';
   const origin=p.origin==='copy'?'카피':p.origin==='scalp'?'단타':'수동';
   return {
    symbol:String(p.symbol||p.venueSymbol||'').replace(/-/g,'').toUpperCase(),
    direction:dir,
    leverage,
    avg,
    mark,
    size:Number(p.size),
    unrealized,
    roePct,
    origin,
   };
  })
  .sort((a,b)=>Math.abs(b.unrealized??0)-Math.abs(a.unrealized??0));
 const pnls=positions.map(p=>p.unrealized).filter(v=>v!==null);
 const totalUnrealized=pnls.length?pnls.reduce((s,v)=>s+v,0):null;
 return {
  ready:true,
  mode,
  equity:fin(copyPayload.funds?.equity)?Number(copyPayload.funds.equity):null,
  available:fin(copyPayload.funds?.available)?Number(copyPayload.funds.available):null,
  positions,
  totalUnrealized,
  error:copyPayload.venuePositionsError?String(copyPayload.venuePositionsError):null,
 };
}

/** Extract BTC.D, USDT.D, and concise capital-flow regime (알트장 / 비트독주 / 현금대피) from /api/market-dominance. */
export function extractMiniDominance(domPayload){
 if(!domPayload||!domPayload.ok){
  return {ok:false,btcDomPct:null,btcDomDelta:null,usdtDomPct:null,usdtDomDelta:null,altDomPct:null,altBeatBtcPct:null,regimeLabel:'도미넌스 조회 중',regimeEmoji:'⏳',regimeTone:'neutral',phaseKo:'',cashFlight:false};
 }
 const g=domPayload.global||null;
 const del=domPayload.deltas||null;
 const b=domPayload.breadth||null;
 const usdtDomDelta=fin(del?.usdtDomDelta)?Number(del.usdtDomDelta):null;
 const btcPct24h=fin(b?.btcPct24h)?Number(b.btcPct24h):null;
 // Detect cash-flight (현금대피): USDT dominance rising while BTC is falling.
 const cashFlight=Boolean(
  (usdtDomDelta!==null&&usdtDomDelta>=0.15&&(btcPct24h===null||btcPct24h<0))
  ||(usdtDomDelta!==null&&usdtDomDelta>0&&btcPct24h!==null&&btcPct24h<=-1.5)
 );
 const regimeLabel=cashFlight?'현금 대피 (USDT 유입)':String(domPayload.labelKo||'중립 · 혼조');
 const regimeEmoji=cashFlight?'🛡️':String(domPayload.emoji||'⚪');
 const regimeTone=cashFlight?'cash':String(domPayload.tone||'neutral');
 return {
  ok:true,
  btcDomPct:fin(g?.btcDomPct)?Number(g.btcDomPct):null,
  btcDomDelta:fin(del?.btcDomDelta)?Number(del.btcDomDelta):null,
  usdtDomPct:fin(g?.usdtDomPct)?Number(g.usdtDomPct):null,
  usdtDomDelta,
  altDomPct:fin(g?.altDomPct)?Number(g.altDomPct):null,
  altBeatBtcPct:fin(b?.altBeatBtcPct)?Number(b.altBeatBtcPct):null,
  regimeLabel,
  regimeEmoji,
  regimeTone,
  phaseKo:String(domPayload.phaseKo||''),
  cashFlight,
 };
}

/** Render the complete read-only Mini HUD HTML. */
export function renderMiniHudHTML(state,{standalone=false}={}){
 const btc=state?.btc||{price:null,changePct:null,at:null};
 const real=state?.real||{ready:false,mode:null,equity:null,available:null,positions:[],totalUnrealized:null,error:null};
 const dom=state?.dom||{ok:false,btcDomPct:null,btcDomDelta:null,usdtDomPct:null,usdtDomDelta:null,regimeLabel:'도미넌스 조회 중',regimeEmoji:'⏳',regimeTone:'neutral',phaseKo:''};
 const connected=state?.connected!==false;
 const clockTxt=kstClock(state?.now||Date.now());

 const btcCls=fin(btc.changePct)?(Number(btc.changePct)>=0?'pos':'neg'):'neutral';
 const totalCls=fin(real.totalUnrealized)?(Number(real.totalUnrealized)>=0?'pos':'neg'):'';
 const posCount=real.positions.length;

 let posBody='';
 if(!real.ready){
  posBody=`<div class="mh-empty">실계좌 포지션 불러오는 중…</div>`;
 }else if(real.mode!=='LIVE'){
  posBody=`<div class="mh-empty">실계좌(BingX LIVE)가 연결되어 있지 않습니다.</div>`;
 }else if(!posCount){
  posBody=`<div class="mh-empty">보유 중인 실계좌 포지션이 없습니다.</div>`;
 }else{
  posBody=`<div class="mh-pos-list">${real.positions.map(p=>{
   const sideCls=p.direction==='SHORT'?'short':'long';
   const sideKo=p.direction==='SHORT'?'숏':'롱';
   const pnlCls=fin(p.unrealized)?(p.unrealized>=0?'pos':'neg'):'';
   const roeTxt=fin(p.roePct)?`(${fmtSignedPct(p.roePct,1)})`:'';
   return `
    <div class="mh-pos-row">
     <div class="mh-pos-top">
      <div class="mh-pos-left">
       <span class="mh-sym">${esc(shortSym(p.symbol))}</span>
       <span class="mh-side ${sideCls}">${sideKo}</span>
       ${p.leverage?`<span class="mh-lev">${esc(p.leverage)}x</span>`:''}
       <span class="mh-origin">${esc(p.origin)}</span>
      </div>
      <div class="mh-pos-pnl mh-val ${pnlCls}">${esc(fmtSignedUsd(p.unrealized))}${roeTxt?`<small>${esc(roeTxt)}</small>`:''}</div>
     </div>
     <div class="mh-pos-sub">
      <span>평단 ${esc(fmtPx(p.avg))}</span>
      <span>마크 ${esc(fmtPx(p.mark))}</span>
     </div>
    </div>`;
  }).join('')}</div>`;
 }

 const realErrHtml=real.error?`<div class="mh-err">⚠️ 실계좌 조회 참고: ${esc(real.error)}</div>`:'';
 const btcDomDeltaCls=fin(dom.btcDomDelta)?(dom.btcDomDelta>0?'neg':'pos'):'';
 const usdtDomDeltaCls=fin(dom.usdtDomDelta)?(dom.usdtDomDelta>0?'neg':'pos'):'';

 return `
  <div class="mh-root">
   <header class="mh-head">
    <div class="mh-brand">
     <i class="mh-dot ${connected?'live':'off'}" title="${connected?'실시간 연결됨':'재연결 중'}"></i>
     <span>SIGNAL LAB</span>
    </div>
    <div class="mh-head-tools">
     <span class="mh-clock" data-mh-clock="1">${esc(clockTxt)}</span>
     <button type="button" class="mh-btn" data-mh-refresh="1" title="지금 새로고침">↻</button>
     ${standalone?'<a class="mh-btn" href="/#real" target="_blank" rel="noopener noreferrer" title="전체 대시보드 열기">↗</a>':''}
    </div>
   </header>

   <section class="mh-card" aria-label="BTC 시세">
    <div class="mh-card-head">
     <span class="mh-card-title">BTC / USDT</span>
     <span>바이낸스 선물 · 24h</span>
    </div>
    <div class="mh-btc-row">
     <strong class="mh-btc-price" data-mh-btc-price="1">${esc(fmtBtcPrice(btc.price))}</strong>
     <span class="mh-pill ${btcCls}">${esc(fmtSignedPct(btc.changePct,2))}</span>
    </div>
   </section>

   <section class="mh-card" aria-label="실계좌 보유 포지션">
    <div class="mh-card-head">
     <span class="mh-card-title">실계좌 포지션 · ${posCount}개</span>
     <span class="mh-pos-total ${totalCls}">${real.totalUnrealized!==null?esc(fmtSignedUsd(real.totalUnrealized)):(real.equity!==null?`잔고 ${esc(fmtUsd(real.equity))}`:'BingX 실계좌')}</span>
    </div>
    ${realErrHtml}
    ${posBody}
    ${real.equity!==null?`<div class="mh-foot"><span>총 자산 ${esc(fmtUsd(real.equity))}</span><span>가용 ${esc(fmtUsd(real.available))}</span></div>`:''}
   </section>

   <section class="mh-card" aria-label="도미넌스 및 자금 흐름">
    <div class="mh-card-head">
     <span class="mh-card-title">도미넌스 · 자금 흐름</span>
     <span class="mh-pill ${esc(dom.regimeTone)}">${esc(dom.regimeEmoji)} ${esc(dom.regimeLabel)}</span>
    </div>
    <div class="mh-dom-grid">
     <div class="mh-dom-box">
      <span class="mh-dom-k">BTC.D</span>
      <div class="mh-dom-v"><span>${esc(fmtShare(dom.btcDomPct))}</span>${dom.btcDomDelta!==null?`<small class="mh-delta ${btcDomDeltaCls}">${esc(fmtDeltaPp(dom.btcDomDelta))}</small>`:''}</div>
     </div>
     <div class="mh-dom-box">
      <span class="mh-dom-k">USDT.D</span>
      <div class="mh-dom-v"><span>${esc(fmtShare(dom.usdtDomPct))}</span>${dom.usdtDomDelta!==null?`<small class="mh-delta ${usdtDomDeltaCls}">${esc(fmtDeltaPp(dom.usdtDomDelta))}</small>`:''}</div>
     </div>
    </div>
    ${dom.phaseKo||dom.altBeatBtcPct!==null?`<div class="mh-phase"><span>${esc(dom.phaseKo||'')}</span>${dom.altBeatBtcPct!==null?`<span>알트 승률 ${esc(dom.altBeatBtcPct)}%</span>`:''}</div>`:''}
   </section>
  </div>`;
}

/** Mount live Mini HUD into any container element (Document PiP window or standalone /mini page). */
export function mountMiniHud(rootEl,{doc=document,win=window,standalone=false}={}){
 if(!rootEl)return ()=>{};
 const origin=win.location?.origin&&win.location.origin!=='null'?win.location.origin:window.location.origin;
 const state={
  btc:{price:null,changePct:null,at:null},
  real:{ready:false,mode:null,equity:null,available:null,positions:[],totalUnrealized:null,error:null},
  dom:{ok:false,btcDomPct:null,btcDomDelta:null,usdtDomPct:null,usdtDomDelta:null,regimeLabel:'도미넌스 조회 중',regimeEmoji:'⏳',regimeTone:'neutral',phaseKo:''},
  connected:true,
  now:Date.now(),
 };
 let destroyed=false;
 let es=null;
 let marketRaw=null;
 let domRaw=null;
 let copyBusy=false;

 const render=()=>{
  if(destroyed)return;
  state.now=Date.now();
  rootEl.innerHTML=renderMiniHudHTML(state,{standalone});
 };

 const updateClockOnly=()=>{
  if(destroyed)return;
  const el=rootEl.querySelector?.('[data-mh-clock]');
  if(el)el.textContent=kstClock(Date.now());
 };

 const fetchJson=async path=>{
  const r=await fetch(origin+path,{cache:'no-store',credentials:'same-origin',signal:AbortSignal.timeout(10000)});
  if(!r.ok)throw Error(`HTTP_${r.status}`);
  return await r.json();
 };

 const loadMarket=async()=>{
  try{
   marketRaw=await fetchJson('/api/market');
   state.btc=extractMiniBtc(marketRaw,domRaw,state.btc);
   state.connected=true;
   render();
  }catch{
   state.connected=false;
   render();
  }
 };

 const loadCopy=async()=>{
  if(copyBusy||destroyed)return;
  copyBusy=true;
  try{
   const d=await fetchJson('/api/copy');
   state.real=extractMiniRealPositions(d);
   state.connected=true;
   render();
  }catch{
   // Keep last good positions on brief hiccup
  }finally{copyBusy=false}
 };

 const loadDom=async()=>{
  try{
   domRaw=await fetchJson('/api/market-dominance');
   state.dom=extractMiniDominance(domRaw);
   state.btc=extractMiniBtc(marketRaw,domRaw,state.btc);
   render();
  }catch{}
 };

 const refreshAll=()=>Promise.allSettled([loadMarket(),loadCopy(),loadDom()]);

 const onClick=e=>{
  if(e.target?.closest?.('[data-mh-refresh]')){
   e.preventDefault();
   void refreshAll();
  }
 };
 rootEl.addEventListener('click',onClick);

 try{
  es=new EventSource(origin+'/events');
  es.addEventListener('quotes',e=>{
   if(destroyed)return;
   try{
    const payload=JSON.parse(e.data);
    const list=Array.isArray(payload?.data)?payload.data:[];
    const tick=list.find(x=>Array.isArray(x)&&x[0]==='BTCUSDT');
    if(tick&&fin(tick[1])&&Number(tick[1])>0){
     state.btc={...state.btc,price:Number(tick[1]),at:Number(tick[2])||Date.now()};
     state.connected=true;
     const pxEl=rootEl.querySelector?.('[data-mh-btc-price]');
     if(pxEl)pxEl.textContent=fmtBtcPrice(state.btc.price);
    }
   }catch{}
  });
  es.addEventListener('market',e=>{
   if(destroyed)return;
   try{
    marketRaw=JSON.parse(e.data);
    state.btc=extractMiniBtc(marketRaw,domRaw,state.btc);
    state.connected=true;
    render();
   }catch{}
  });
  es.onerror=()=>{
   if(destroyed)return;
   state.connected=false;
   render();
  };
 }catch{}

 const clockTimer=setInterval(updateClockOnly,1000);
 const copyTimer=setInterval(()=>{
  if(standalone&&doc.visibilityState==='hidden')return;
  void loadCopy();
 },3000);
 const marketTimer=setInterval(()=>{
  if(standalone&&doc.visibilityState==='hidden')return;
  void loadMarket();
 },30000);
 const domTimer=setInterval(()=>{
  if(standalone&&doc.visibilityState==='hidden')return;
  void loadDom();
 },60000);

 render();
 void refreshAll();

 return ()=>{
  if(destroyed)return;
  destroyed=true;
  clearInterval(clockTimer);
  clearInterval(copyTimer);
  clearInterval(marketTimer);
  clearInterval(domTimer);
  rootEl.removeEventListener('click',onClick);
  try{es?.close()}catch{}
 };
}

if(typeof document!=='undefined'&&typeof window!=='undefined'){
 const standaloneRoot=document.getElementById('miniHudApp');
 if(standaloneRoot){
  const destroy=mountMiniHud(standaloneRoot,{doc:document,win:window,standalone:true});
  window.addEventListener('beforeunload',()=>destroy(),{once:true});
 }
}
