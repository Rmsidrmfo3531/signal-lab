// External signal alert inbox & manual-order helper bar on the main dashboard.
// NEVER executes automatic orders: parses pasted text or opt-in secret-authenticated official webhooks,
// delivers browser/sound/Telegram alerts, and prefills the #real BingX manual order ticket for user confirmation.

const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const kstClock=t=>t?new Date(t).toLocaleTimeString('ko-KR',{timeZone:'Asia/Seoul',hour12:false,hour:'2-digit',minute:'2-digit',second:'2-digit'}):'—';
const kstShort=t=>t?new Date(t).toLocaleString('ko-KR',{timeZone:'Asia/Seoul',hour12:false,month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}):'—';

export function buildPrefillDetail(item){
 if(!item||!item.symbol||!item.side)return null;
 return {
  symbol:item.symbol,
  side:item.side,
  orderType:item.orderType||(item.entryPrice?'LIMIT':'MARKET'),
  limitPrice:item.entryPrice??null,
  tpPrice:item.tpPrice??null,
  slPrice:item.slPrice??null,
  leverage:item.leverage??null,
  marginMode:item.marginMode??null,
  note:`🔔 [${item.source||'외부 신호'}] ${item.symbol} ${item.side==='LONG'?'롱':'숏'} 수동 확인 (자동 주문 없음)`,
 };
}

function fmtPrice(v){
 const n=Number(v);
 if(!Number.isFinite(n)||n<=0)return '—';
 return n>=1000?n.toLocaleString('en-US',{maximumFractionDigits:2}):String(n);
}

function renderParamsChips(p){
 const chips=[];
 const sideCls=p.side==='LONG'?'long':'short';
 const sideKo=p.side==='LONG'?'🟢 롱 (LONG)':'🔴 숏 (SHORT)';
 chips.push(`<span class="ext-chip sym">${esc(p.symbol)}</span>`);
 chips.push(`<span class="ext-chip ${sideCls}">${sideKo}</span>`);
 if(p.entryPrice){
  const rangeTxt=Array.isArray(p.entryRange)&&p.entryRange.length===2?` (${fmtPrice(p.entryRange[0])}~${fmtPrice(p.entryRange[1])})`:'';
  chips.push(`<span class="ext-chip">지정가 <b>${esc(fmtPrice(p.entryPrice))}</b>${esc(rangeTxt)}</span>`);
 }else{
  chips.push(`<span class="ext-chip">시장가 (MARKET)</span>`);
 }
 if(p.tpTargets?.length){
  const dist=p.tpDistPct!=null?` (${p.tpDistPct>0?'+':''}${p.tpDistPct}%)`:'';
  chips.push(`<span class="ext-chip tp">TP <b>${esc(p.tpTargets.map(fmtPrice).join(' / '))}</b>${esc(dist)}</span>`);
 }
 if(p.slPrice){
  const dist=p.slDistPct!=null?` (${p.slDistPct>0?'+':''}${p.slDistPct}%)`:'';
  chips.push(`<span class="ext-chip sl">SL <b>${esc(fmtPrice(p.slPrice))}</b>${esc(dist)}</span>`);
 }
 if(p.riskReward){
  chips.push(`<span class="ext-chip rr">손익비 <b>1:${esc(p.riskReward)}</b></span>`);
 }
 if(p.leverage){
  chips.push(`<span class="ext-chip">${esc(p.leverage)}x</span>`);
 }
 if(p.marginMode){
  chips.push(`<span class="ext-chip">${p.marginMode==='ISOLATED'?'격리':'교차'}</span>`);
 }
 return chips.join('');
}

export function renderExternalSignalPreviewHTML(parsed){
 if(!parsed)return `<div class="ext-preview-empty">예시: <code>BTCUSDT 롱 진입 95,200 손절 94,300 익절 97,500 10배 교차</code> 또는 공부방·텔레그램 신호 문구를 그대로 붙여넣으세요.</div>`;
 if(!parsed.valid){
  return `<div class="ext-preview-err">⚠️ ${esc(parsed.error||'종목과 방향(롱/숏)을 인식하지 못했습니다.')}</div>`;
 }
 const warnHtml=parsed.warnings?.length
  ?`<div class="ext-warns">${parsed.warnings.map(w=>`<span class="ext-warn">⚠️ ${esc(w)}</span>`).join('')}</div>`
  :'';
 return `<div class="ext-preview-ok"><div class="ext-chips">${renderParamsChips(parsed)}</div>${warnHtml}</div>`;
}

export function renderExternalSignalSummaryHTML(inbox){
 const items=Array.isArray(inbox?.items)?inbox.items:[];
 const unread=Number(inbox?.unreadCount)||items.filter(x=>x.status==='NEW').length;
 const latest=items.find(x=>x.status==='NEW')||items[0]||null;
 const badgeCls=unread>0?'unread':'neutral';
 const badgeTxt=unread>0?`🔔 외부 신호 대기 ${unread}건`:'📥 외부 신호 · 수동 매매 도우미';
 const pills=[];
 if(latest){
  const dirKo=latest.side==='LONG'?'🟢 롱':'🔴 숏';
  const pxKo=latest.entryPrice?`지정가 ${fmtPrice(latest.entryPrice)}`:'시장가';
  const extras=[latest.slPrice?`SL ${fmtPrice(latest.slPrice)}`:'',latest.tpPrice?`TP ${fmtPrice(latest.tpPrice)}`:'',latest.leverage?`${latest.leverage}x`:''].filter(Boolean).join(' · ');
  pills.push(`<span class="ext-pill latest ${latest.side==='LONG'?'long':'short'}"><b>${esc(latest.symbol)}</b> ${dirKo} · ${esc(pxKo)}${extras?` · ${esc(extras)}`:''}</span>`);
  pills.push(`<span class="ext-pill ext-meta">${esc(latest.source||'외부 신호')} · ${esc(kstClock(latest.receivedAt))}</span>`);
  pills.push(`<button type="button" class="ext-quick-pill-btn" data-ext-prefill="${esc(latest.id)}">⚡ 주문창 채우기</button>`);
 }else{
  pills.push(`<span class="ext-pill">신호 문구 붙여넣기 · 공식 웹훅 수신 → 텔레그램·브라우저 알림 &amp; 수동 주문창 1클릭 입력 (자동 주문 없음)</span>`);
 }
 const whTag=inbox?.webhookConfigured
  ?`<span class="ext-pill wh-on">웹훅 활성</span>`
  :`<span class="ext-pill wh-off">붙여넣기 모드</span>`;
 return `<span class="ext-badge ${badgeCls}">${badgeTxt}</span><span class="ext-pills">${pills.join('')}${whTag}</span><span class="ext-chevron">열기 ▾</span>`;
}

export function renderExternalSignalListHTML(items){
 const list=Array.isArray(items)?items:[];
 if(!list.length){
  return `<div class="ext-empty">수신된 외부 신호가 없습니다. 위 입력창에 신호를 붙여넣거나 공식 웹훅을 연결하면 실시간 브라우저·사운드·텔레그램 알림과 수동 주문창 입력이 동작합니다.</div>`;
 }
 return list.slice(0,20).map(item=>{
  const statusCls=item.status==='NEW'?'is-new':item.status==='LOADED'?'is-loaded':'is-dismissed';
  const statusTxt=item.status==='NEW'?'대기 중':item.status==='LOADED'?'주문창 입력됨':'확인 완료';
  const chTxt=item.channel==='webhook'?'공식 웹훅':'직접 등록';
  const warnHtml=item.warnings?.length
   ?`<div class="ext-warns">${item.warnings.map(w=>`<span class="ext-warn">⚠️ ${esc(w)}</span>`).join('')}</div>`
   :'';
  const rawHtml=item.rawText?`<div class="ext-raw">${esc(item.rawText)}</div>`:'';
  return `
   <article class="ext-card ${statusCls}" data-ext-id="${esc(item.id)}">
    <div class="ext-card-top">
     <div class="ext-card-meta">
      <span class="ext-status-tag ${statusCls}">${statusTxt}</span>
      <span class="ext-src-tag">${esc(item.source||'외부 신호')}</span>
      <span class="ext-ch-tag">${chTxt}</span>
      <small class="ext-time">${esc(kstShort(item.receivedAt))} KST</small>
     </div>
     <div class="ext-card-actions">
      <button type="button" class="outline-btn small ext-fill-btn" data-ext-prefill="${esc(item.id)}">⚡ 주문창 채우기</button>
      ${item.status!=='DISMISSED'?`<button type="button" class="outline-btn small" data-ext-dismiss="${esc(item.id)}">확인</button>`:''}
     </div>
    </div>
    <div class="ext-chips">${renderParamsChips(item)}</div>
    ${warnHtml}
    ${rawHtml}
   </article>`;
 }).join('');
}

export function renderChannelWatchHTML(cw){
 if(!cw||!cw.enabled)return '';
 const channels=Array.isArray(cw.channels)?cw.channels:[];
 const posts=Array.isArray(cw.posts)?cw.posts:[];
 const chChips=channels.map(c=>{
  const safeChUrl=/^https:\/\/t\.me\/[A-Za-z0-9_]+$/.test(c.url||'')?c.url:'';
  const err=c.lastError?` · ⚠️ ${esc(c.lastError)}`:'';
  const filt=c.filteredCount>0?` · 비매매 ${c.filteredCount}건 제외`:'';
  const ts=c.lastCheckedAt?` · ${esc(kstClock(c.lastCheckedAt))} 확인`:'';
  const label=`@${esc(c.handle)}${c.title&&c.title!==c.handle?` (${esc(c.title)})`:''}`;
  return `<span class="ext-ch-pill">${safeChUrl?`<a href="${esc(safeChUrl)}" target="_blank" rel="noopener noreferrer">${label} ↗</a>`:label}<small>${ts}${filt}${err}</small></span>`;
 }).join('');
 const cards=posts.length?posts.slice(0,15).map(p=>{
  const sideCls=p.side==='LONG'?'long':p.side==='SHORT'?'short':'';
  const sideKo=p.side==='LONG'?'🟢 롱 (LONG)':p.side==='SHORT'?'🔴 숏 (SHORT)':'';
  const canFill=Boolean(/^[A-Z0-9]{2,14}USDT$/.test(String(p.symbol||''))&&['LONG','SHORT'].includes(p.side)&&!['CLOSE','LIQUIDATION','REDUCE'].includes(p.action));
  const safePostUrl=/^https:\/\/t\.me\/[A-Za-z0-9_]+\/\d+$/.test(p.url||'')?p.url:'';
  const chips=[];
  chips.push(`<span class="ext-chip">${esc(p.emoji||'📌')} <b>${esc(p.actionKo||'매매')}</b></span>`);
  if(p.symbol)chips.push(`<span class="ext-chip sym">${esc(p.symbol)}</span>`);
  if(sideKo)chips.push(`<span class="ext-chip ${sideCls}">${sideKo}</span>`);
  if(p.entryPrice)chips.push(`<span class="ext-chip">평단 <b>${esc(fmtPrice(p.entryPrice))}</b></span>`);
  if(p.markPrice)chips.push(`<span class="ext-chip">마크 <b>${esc(fmtPrice(p.markPrice))}</b></span>`);
  if(p.liqPrice)chips.push(`<span class="ext-chip sl">청산가 <b>${esc(fmtPrice(p.liqPrice))}</b></span>`);
  if(p.leverage)chips.push(`<span class="ext-chip">${esc(p.leverage)}x</span>`);
  if(p.marginMode)chips.push(`<span class="ext-chip">${p.marginMode==='ISOLATED'?'격리':'교차'}</span>`);
  if(p.pnlText)chips.push(`<span class="ext-chip rr">${esc(p.pnlText)}</span>`);
  return `
   <article class="ext-card ext-ch-card">
    <div class="ext-card-top">
     <div class="ext-card-meta">
      <span class="ext-src-tag">@${esc(p.channel)} #${esc(p.postNum)}</span>
      <small class="ext-time">${esc(kstShort(p.publishedAt||p.receivedAt))} KST</small>
      ${p.bootstrapped?'<span class="ext-ch-tag">최근 기록</span>':'<span class="ext-status-tag is-new">실시간 알림</span>'}
     </div>
     <div class="ext-card-actions">
      ${canFill?`<button type="button" class="outline-btn small ext-fill-btn" data-ext-ch-prefill="${esc(p.id)}">⚡ 주문창 채우기</button>`:''}
      ${safePostUrl?`<a class="outline-btn small ext-link-btn" href="${esc(safePostUrl)}" target="_blank" rel="noopener noreferrer">원문 ↗</a>`:''}
     </div>
    </div>
    <div class="ext-chips">${chips.join('')}</div>
    <div class="ext-ko-body">${esc(p.translatedText||p.text||'')}</div>
    <details class="ext-orig-fold"><summary>중국어 원문 보기</summary><div class="ext-raw">${esc(p.text||'')}</div></details>
   </article>`;
 }).join(''):`<div class="ext-empty">아직 수집된 매매 게시글이 없습니다. 30초마다 자동 확인하며 광고·비매매·무포지션 글은 자동 제외됩니다.</div>`;
 return `
  <div class="ext-channel-wrap">
   <div class="ext-inbox-head">
    <span class="ext-subhead">📡 텔레그램 공개 채널 한국어 번역 알림 (매매 글만 · 자동 주문 없음)</span>
    <div class="ext-inbox-tools">
     <button type="button" class="outline-btn small" data-ext-ch-refresh="1">↻ 지금 확인</button>
    </div>
   </div>
   <div class="ext-ch-pills">${chChips}</div>
   <div class="ext-list">${cards}</div>
  </div>`;
}

export function renderExternalSignalBarHTML(inbox,{parsed=null,webhookOrigin=''}={}){
 const items=Array.isArray(inbox?.items)?inbox.items:[];
 const webhookConfigured=Boolean(inbox?.webhookConfigured);
 const endpoint=(webhookOrigin||'')+(inbox?.webhookPath||'/api/external-signals/webhook');
 const curlExample=`curl -X POST "${endpoint}" \\\n  -H "Content-Type: application/json" \\\n  -H "X-Webhook-Secret: <설정한_시크릿>" \\\n  -d '{"source":"깡이스터디","text":"BTCUSDT 롱 진입 95200 손절 94300 익절 97500 10배 교차"}'`;
 return `
  <summary class="ext-summary" data-ext-summary-slot="1">${renderExternalSignalSummaryHTML(inbox)}</summary>
  <div class="ext-body">
   <div class="ext-top-note">
    <p><b>자동 주문 없음 · 수동 확인 전용:</b> 공부방(<code>ggang-study.fly.dev</code>)·텔레그램·카톡 등에서 받은 신호 문구를 붙여넣거나 공식 웹훅으로 수신하면 종목·방향·진입가·손절(SL)·익절(TP)·배율을 자동 파싱해 <b>브라우저/사운드 + 텔레그램 알림</b>을 띄우고, 버튼 한 번으로 <b>실계좌 BingX 수동 주문창</b>에 채워 넣습니다.</p>
   </div>
   <div class="ext-compose">
    <div class="ext-compose-row">
     <input type="text" class="ext-src-input" data-ext-source="1" placeholder="출처 이름 (예: 깡이스터디, 텔레그램방)" value="공부방·외부 신호" maxlength="40" aria-label="신호 출처">
     <label class="ext-chk"><input type="checkbox" data-ext-tg="1" checked> 텔레그램 알림도 함께 받기</label>
    </div>
    <textarea class="ext-textarea" data-ext-input="1" rows="3" placeholder="예) [깡이스터디] BTCUSDT 롱 진입 95,200 손절 94,300 익절 97,500 10배 교차&#10;또는 SOL 매수 205~208 SL 198 TP1 218 TP2 225 5x 격리" aria-label="외부 신호 문구 입력"></textarea>
    <div class="ext-preview" data-ext-preview-slot="1">${renderExternalSignalPreviewHTML(parsed)}</div>
    <div class="ext-compose-actions">
     <button type="button" class="outline-btn small ext-fill-btn" data-ext-quick-fill="1">⚡ 바로 수동 주문창 채우기</button>
     <button type="button" class="outline-btn small" data-ext-ingest="1">🔔 알림함 등록 · 알림 발송</button>
     <button type="button" class="outline-btn small" data-ext-clear-input="1">입력 지우기</button>
     <span class="ext-feedback" data-ext-feedback="1" role="status" aria-live="polite"></span>
    </div>
   </div>
   <div data-ext-channel-slot="1">${renderChannelWatchHTML(inbox?.channelWatch)}</div>
   <div class="ext-inbox-wrap">
    <div class="ext-inbox-head">
     <span class="ext-subhead">최근 외부 신호 알림함 (<b data-ext-count="1">${items.length}</b>건)</span>
     <div class="ext-inbox-tools">
      <button type="button" class="outline-btn small" data-ext-refresh="1">↻ 새로고침</button>
      <button type="button" class="outline-btn small" data-ext-clear="1">비우기</button>
     </div>
    </div>
    <div class="ext-list" data-ext-list-slot="1">${renderExternalSignalListHTML(items)}</div>
   </div>
   <details class="ext-guide">
    <summary>공식 웹훅 / 텔레그램 연동 방법 <span class="ext-wh-pill ${webhookConfigured?'on':'off'}" data-ext-webhook-badge="1">${webhookConfigured?'웹훅 활성':'미설정'}</span></summary>
    <div class="ext-guide-body">
     <p>1. 외부 사이트(<code>ggang-study.fly.dev</code> 등)가 <b>공식 웹훅 전송</b>이나 <b>본인 텔레그램 봇/포워더</b>를 지원할 때만 연결하세요. 로그인 우회나 무단 크롤링은 수행하지 않습니다.</p>
     <p>2. Signal Lab 데이터 폴더의 <code>.env</code>에 <code>EXTERNAL_SIGNAL_WEBHOOK_SECRET=원하는_긴_비밀키</code>를 추가하고 서버를 재시작하면 아래 엔드포인트가 활성화됩니다.</p>
     <p>3. 공개 텔레그램 채널 번역 감시 대상은 <code>.env</code>의 <code>WATCH_TELEGRAM_CHANNELS</code>로 변경·추가할 수 있습니다 (기본값: <code>aoying999</code>, 끄기: <code>off</code>).</p>
     <pre class="ext-code"><code>${esc(curlExample)}</code></pre>
    </div>
   </details>
  </div>`;
}

if(typeof document!=='undefined'&&typeof window!=='undefined'){
 const host=document.getElementById('externalSignalBar');
 if(host){
  let inbox={ok:true,webhookConfigured:false,webhookPath:'/api/external-signals/webhook',unreadCount:0,totalCount:0,items:[],channelWatch:null};
  let lastParsed=null;
  let parseTimer=null;
  let mounted=false;
  let lastSyncedAt=0;

  const setFeedback=(msg,isErr=false)=>{
   const el=host.querySelector('[data-ext-feedback]');
   if(!el)return;
   el.textContent=msg||'';
   el.classList.toggle('err',Boolean(isErr));
  };

  const prefillManualOrder=item=>{
   const detail=buildPrefillDetail(item);
   if(!detail){
    setFeedback('종목과 방향(롱/숏)을 먼저 인식해야 주문창에 채울 수 있습니다.',true);
    return false;
   }
   window.__signalLabPendingRealOrder=detail;
   if(location.hash!=='#real')location.hash='#real';
   window.dispatchEvent(new CustomEvent('signal-lab:prefill-real-trade',{detail}));
   setFeedback(`✅ ${detail.symbol} ${detail.side==='LONG'?'롱':'숏'} 수동 주문창 입력 완료 (자동 주문 없음 — 확인 후 직접 주문)`);
   return true;
  };

  const syncNavBadge=()=>{
   const navBadge=document.getElementById('navExtBadge');
   if(!navBadge)return;
   const unread=Number(inbox?.unreadCount)||0;
   const chErrors=(inbox?.channelWatch?.channels||[]).filter(c=>c.lastError);
   if(unread>0){
    navBadge.textContent=`대기 ${unread}`;
    navBadge.className='navright tone-warn';
   }else if(chErrors.length>0){
    navBadge.textContent='연결오류';
    navBadge.className='navright tone-warn';
   }else if(inbox?.channelWatch?.enabled){
    navBadge.textContent='감시중';
    navBadge.className='navright tone-pos';
   }else if(inbox?.webhookConfigured){
    navBadge.textContent='웹훅';
    navBadge.className='navright tone-pos';
   }else{
    navBadge.textContent='수동';
    navBadge.className='navright';
   }
  };

  const syncDom=()=>{
   if(!mounted){
    host.innerHTML=renderExternalSignalBarHTML(inbox,{parsed:lastParsed,webhookOrigin:location.origin});
    mounted=true;
    syncNavBadge();
    return;
   }
   const sumEl=host.querySelector('[data-ext-summary-slot]');
   if(sumEl)sumEl.innerHTML=renderExternalSignalSummaryHTML(inbox);
   const chEl=host.querySelector('[data-ext-channel-slot]');
   if(chEl)chEl.innerHTML=renderChannelWatchHTML(inbox.channelWatch);
   const listEl=host.querySelector('[data-ext-list-slot]');
   if(listEl)listEl.innerHTML=renderExternalSignalListHTML(inbox.items);
   const cntEl=host.querySelector('[data-ext-count]');
   if(cntEl)cntEl.textContent=String(inbox.items?.length||0);
   const whEl=host.querySelector('[data-ext-webhook-badge]');
   if(whEl){
    whEl.textContent=inbox.webhookConfigured?'웹훅 활성':'미설정';
    whEl.classList.toggle('on',Boolean(inbox.webhookConfigured));
    whEl.classList.toggle('off',!inbox.webhookConfigured);
   }
   syncNavBadge();
  };

  const updatePreview=parsed=>{
   lastParsed=parsed;
   const el=host.querySelector('[data-ext-preview-slot]');
   if(el)el.innerHTML=renderExternalSignalPreviewHTML(parsed);
  };

  const parseDraft=async()=>{
   const text=host.querySelector('[data-ext-input]')?.value?.trim()||'';
   const source=host.querySelector('[data-ext-source]')?.value?.trim()||'공부방·외부 신호';
   if(!text){updatePreview(null);return null}
   try{
    const r=await fetch('/api/external-signals/parse',{
     method:'POST',
     headers:{'Content-Type':'application/json'},
     body:JSON.stringify({text,source}),
     signal:AbortSignal.timeout(8000),
    });
    const d=await r.json().catch(()=>null);
    if(d?.parsed){updatePreview(d.parsed);return d.parsed}
   }catch{}
   return null;
  };

  const loadInbox=async()=>{
   try{
    const r=await fetch('/api/external-signals',{cache:'no-store',signal:AbortSignal.timeout(10000)});
    if(!r.ok)return;
    const d=await r.json().catch(()=>null);
    if(d&&Array.isArray(d.items)){inbox=d;lastSyncedAt=Date.now();syncDom()}
   }catch{}
  };

  const setItemStatus=async(id,status)=>{
   try{
    const r=await fetch('/api/external-signals/status',{
     method:'POST',
     headers:{'Content-Type':'application/json'},
     body:JSON.stringify({id,status}),
    });
    const d=await r.json().catch(()=>null);
    if(d?.inbox){inbox=d.inbox;lastSyncedAt=Date.now();syncDom()}
   }catch{}
  };

  host.addEventListener('input',e=>{
   if(!e.target.matches?.('[data-ext-input],[data-ext-source]'))return;
   clearTimeout(parseTimer);
   parseTimer=setTimeout(()=>void parseDraft(),180);
  });

  host.addEventListener('click',async e=>{
   const prefillBtn=e.target.closest?.('[data-ext-prefill]');
   if(prefillBtn){
    e.preventDefault();e.stopPropagation();
    const id=prefillBtn.getAttribute('data-ext-prefill');
    const item=(inbox.items||[]).find(x=>x.id===id);
    if(item&&prefillManualOrder(item))void setItemStatus(id,'LOADED');
    return;
   }
   const chPrefillBtn=e.target.closest?.('[data-ext-ch-prefill]');
   if(chPrefillBtn){
    e.preventDefault();e.stopPropagation();
    const id=chPrefillBtn.getAttribute('data-ext-ch-prefill');
    const post=(inbox.channelWatch?.posts||[]).find(x=>x.id===id);
    if(post){
     prefillManualOrder({
      symbol:post.symbol,
      side:post.side,
      orderType:'MARKET',
      entryPrice:null,
      leverage:post.leverage&&post.leverage>=1&&post.leverage<=125?Math.round(post.leverage):null,
      marginMode:post.marginMode||null,
      source:`@${post.channel}`,
     });
    }
    return;
   }
   const chRefreshBtn=e.target.closest?.('[data-ext-ch-refresh]');
   if(chRefreshBtn){
    e.preventDefault();
    chRefreshBtn.disabled=true;
    setFeedback('공개 채널 최신 매매 글 확인 중…');
    try{
     const r=await fetch('/api/external-signals/channels/refresh',{method:'POST'});
     const d=await r.json().catch(()=>null);
     if(d?.inbox){inbox=d.inbox;lastSyncedAt=Date.now();syncDom()}
     const chErrs=(d?.inbox?.channelWatch?.channels||[]).filter(c=>c.lastError);
     if(chErrs.length){
      setFeedback(`⚠️ 채널 확인 실패: ${chErrs.map(c=>`@${c.handle} (${c.lastError})`).join(', ')}`,true);
     }else{
      setFeedback(d?.newCount>0?`🔔 새 매매 글 ${d.newCount}건을 번역해 알림 발송했습니다.`:'최신 매매 글 확인 완료 (새 글 없음).');
     }
    }catch(err){
     setFeedback('채널 확인 오류: '+(err?.message||err),true);
    }finally{chRefreshBtn.disabled=false}
    return;
   }
   const dismissBtn=e.target.closest?.('[data-ext-dismiss]');
   if(dismissBtn){
    e.preventDefault();e.stopPropagation();
    const id=dismissBtn.getAttribute('data-ext-dismiss');
    if(id)void setItemStatus(id,'DISMISSED');
    return;
   }
   if(e.target.closest?.('[data-ext-quick-fill]')){
    e.preventDefault();
    const parsed=await parseDraft();
    if(!parsed||!parsed.valid){
     setFeedback(parsed?.error||'먼저 신호 문구를 입력하세요 (예: BTCUSDT 롱 진입 95200 손절 94300)',true);
     return;
    }
    prefillManualOrder(parsed);
    return;
   }
   if(e.target.closest?.('[data-ext-ingest]')){
    e.preventDefault();
    const inputEl=host.querySelector('[data-ext-input]');
    const text=inputEl?.value?.trim()||'';
    const source=host.querySelector('[data-ext-source]')?.value?.trim()||'공부방·외부 신호';
    const notifyTelegram=host.querySelector('[data-ext-tg]')?.checked!==false;
    if(!text){setFeedback('먼저 신호 문구를 붙여넣으세요.',true);return}
    setFeedback('알림 등록 중…');
    try{
     const r=await fetch('/api/external-signals/ingest',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({text,source,notifyTelegram}),
     });
     const d=await r.json().catch(()=>null);
     if(!r.ok||!d?.ok){
      if(d?.parsed)updatePreview(d.parsed);
      setFeedback(d?.error||'신호 인식에 실패했습니다.',true);
      return;
     }
     if(d.inbox){inbox=d.inbox;lastSyncedAt=Date.now();syncDom()}
     if(inputEl)inputEl.value='';
     updatePreview(null);
     setFeedback(d.duplicate?'최근 1분 내 동일 신호가 이미 등록되어 있습니다.':'🔔 알림함에 등록하고 브라우저·텔레그램 알림을 발송했습니다.');
    }catch(err){
     setFeedback('신호 등록 오류: '+(err?.message||err),true);
    }
    return;
   }
   if(e.target.closest?.('[data-ext-clear-input]')){
    e.preventDefault();
    const inputEl=host.querySelector('[data-ext-input]');
    if(inputEl)inputEl.value='';
    updatePreview(null);
    setFeedback('');
    return;
   }
   if(e.target.closest?.('[data-ext-refresh]')){
    e.preventDefault();
    void loadInbox();
    return;
   }
   if(e.target.closest?.('[data-ext-clear]')){
    e.preventDefault();
    try{
     const r=await fetch('/api/external-signals/status',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({clear:true}),
     });
     const d=await r.json().catch(()=>null);
     if(d&&Array.isArray(d.items)){inbox=d;lastSyncedAt=Date.now();syncDom();setFeedback('외부 신호 알림함을 비웠습니다.')}
    }catch{}
   }
  });

  window.addEventListener('signal-lab:external-signal',e=>{
   const nextInbox=e?.detail?.inbox;
   if(nextInbox&&Array.isArray(nextInbox.items)){
    inbox=nextInbox;
    lastSyncedAt=Date.now();
    syncDom();
   }else{
    void loadInbox();
   }
  });

  window.addEventListener('hashchange',()=>{
   if(location.hash==='#signals')void loadInbox();
  });
  document.addEventListener('visibilitychange',()=>{
   if(document.visibilityState==='visible'&&Date.now()-lastSyncedAt>15000)void loadInbox();
  });
  setInterval(()=>{
   if(document.visibilityState!=='visible')return;
   const staleMs=location.hash==='#signals'?25000:60000;
   if(Date.now()-lastSyncedAt>staleMs)void loadInbox();
  },15000);

  syncDom();
  void loadInbox();
 }
}
