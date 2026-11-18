// Dashboard: 실계좌·카피 / 테스트넷 / 뉴스 / 매매일지 only (user request 2026-11-17).
// The removed 대시보드·차트 and 알림·시스템 pages' server features (scanner, Telegram notices,
// notification settings) keep running on the server; this page no longer renders them.
import {notifyOn} from './notify_settings.js';
import {NEWS_PER_PAGE,paginateNews,clipNewsText,pageWindow} from "/news_pagination.js";
const $=id=>document.getElementById(id);
let gitUpdate=false; // set once /api/update says this server updates from GitHub
const app={market:[],marketMap:new Map(),status:null,news:[],newsMeta:null,newsPage:1,expandedNewsId:null,stream:null,journal:[],journalSummary:null};
const escapeHtml=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmt=(x)=>{const v=Number(x);if(!Number.isFinite(v)||v<=0)return '—';if(v>=1000)return v.toLocaleString('en-US',{maximumFractionDigits:2});if(v>=1)return v.toLocaleString('en-US',{maximumFractionDigits:4});if(v>=.01)return v.toFixed(5);return v>=.0001?v.toFixed(7):v.toFixed(Math.min(14,Math.max(8,Math.ceil(-Math.log10(v))+5))).replace(/0+$/,'').replace(/\.$/,'')};
const clock=t=>t?new Date(t).toLocaleTimeString('ko-KR',{timeZone:'Asia/Seoul',hour12:false,hour:'2-digit',minute:'2-digit',second:'2-digit'}):'—';
const dateClock=t=>t?new Date(t).toLocaleString('ko-KR',{timeZone:'Asia/Seoul',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}):'—';
function toast(message,error=false){const node=document.createElement('div');node.className='toast'+(error?' error':'');node.textContent=message;$('toastHolder').prepend(node);setTimeout(()=>node.remove(),6000)}
async function json(url,options){const res=await fetch(url,{cache:'no-store',...options});const data=await res.json().catch(()=>({}));if(!res.ok)throw Error(data.error||`HTTP ${res.status}`);return data}
function banner(title,detail){$('errorTitle').textContent=title;$('errorDetail').textContent=detail;$('connectBanner').classList.remove('hidden')}
function clearBanner(){$('connectBanner').classList.add('hidden')}
function setAppVersion(info){
 const version=info?.displayVersion||(info?.version?'v'+info.version:'');
 const label=$('appVersion');
 if(!label||!version)return;
 label.textContent=version;label.hidden=false;
}
// Update state goes to the topbar update button's tooltip.
function updateStatusText(info){
 const el=$('updateButton');if(!el||gitUpdate)return;
 const current=$('appVersion')?.textContent;
 const state=info?.state||'unconfigured';
 const labels={unconfigured:'자동 업데이트 비활성 — 배포 서버 URL 미설정',checking:'새 버전 확인 중',current:'최신 버전 사용 중',staged:'새 버전 준비됨 — 서버를 재시작하면 설치',error:'업데이트 확인 오류'};
 el.title=(current?current+' · ':'')+(labels[state]||info?.message||'상태 확인 중')+(state==='staged'&&info?.version?' · 대상 '+info.version:'')+(state==='error'&&info?.message?' · '+info.message:'');
}
function setStatus(s){app.status=s;
 setAppVersion(s);
 if(s.update)updateStatusText(s.update);
 const tickerFresh=s.ws==='connected'&&s.lastTickerAt&&Date.now()-s.lastTickerAt<90000;
 const alive=Boolean(tickerFresh&&Date.now()-s.lastTickerAt<30000);
 $('socketStatus').innerHTML=`<i class="dot ${alive?'green':s.rest==='connected'?'amber':'red'}"></i><span>${alive?'실시간 연결':s.rest==='connected'?'주기 조회':'연결 대기'}</span>`;
 if(s.storage?.healthy===false)banner('기록 저장 실패 · 확인 필요',s.storage.error||'기록이 디스크에 저장되지 않았습니다. 데이터 경로와 저장 공간을 확인하세요.');
 else if(s.error && (!s.activeCount||s.rest==='offline'))banner('시장 데이터 접속 오류',s.error+' · 서버에서 자동 재시도 중입니다.');
 else if(s.rest==='connected')clearBanner();
 if(s.newsChecked && !app.newsMeta)loadNews();
}
// Binance listings feed the journal's symbol list.
function applyMarket({markets}){
 if(!Array.isArray(markets))return;
 app.marketMap=new Map(markets.map(m=>[m.symbol,{...m}]));
 app.market=markets.map(m=>app.marketMap.get(m.symbol));
 updateJournalSymbols();
}
// Article body: fetched from the publisher when an item is opened, translated to Korean.
const newsBodies=new Map();
function newsBodyHTML(id){
 const b=newsBodies.get(id);
 if(!b)return '<p class="news-body-wait">본문을 불러오는 중입니다…</p>';
 if(!b.ok)return `<p class="news-body-wait">본문을 가져오지 못했습니다 (${escapeHtml(b.error||'오류')}). 아래 원문 링크에서 확인해 주세요.</p>`;
 const ko=b.paragraphsKo,en=b.paragraphs||[];
 return (ko||en).map(p=>`<p>${escapeHtml(p)}</p>`).join('')+(ko?`<details class="news-original"><summary>영문 원문 보기</summary>${en.map(p=>`<p>${escapeHtml(p)}</p>`).join('')}</details>`:'<p class="news-body-wait">번역을 하지 못해 영문으로 표시합니다.</p>');
}
async function loadNewsBody(id){
 if(!id||newsBodies.has(id))return;
 newsBodies.set(id,null);
 let b;try{const r=await fetch('/api/news/detail?id='+encodeURIComponent(id),{cache:'no-store'});b=await r.json()}catch{b={ok:false,error:'연결 실패'}}
 newsBodies.set(id,b);while(newsBodies.size>60)newsBodies.delete(newsBodies.keys().next().value);
 const host=document.querySelector(`[data-news-body="${CSS.escape(id)}"]`);if(host)host.innerHTML=newsBodyHTML(id);
}
if(typeof document!=='undefined')document.addEventListener('toggle',e=>{const d=e.target;if(d?.classList?.contains('news-entry')&&d.open)void loadNewsBody(d.dataset.newsId)},true);
// Local manual trade journal - no exchange credentials or automatic execution.
function updateJournalSymbols(){
 const el=$('journalSymbol');if(!el)return;
 const previous=el.value;el.innerHTML=app.market.map(m=>`<option value="${escapeHtml(m.symbol)}">${escapeHtml(m.symbol)}</option>`).join('');
 el.value=app.marketMap.has(previous)?previous:app.marketMap.has('BTCUSDT')?'BTCUSDT':app.market[0]?.symbol||'';
}
function journalFormData(){
 return {symbol:$('journalSymbol').value,side:$('journalSide').value,entry:$('journalEntry').value,stop:$('journalStop').value,notional:$('journalNotional').value,leverage:$('journalLeverage').value,fees:$('journalFees').value,funding:$('journalFunding').value,exit:$('journalExit').value,note:$('journalNote').value};
}
function calcJournalPreview(){
 const x=journalFormData(),entry=Number(x.entry),stop=Number(x.stop),notional=Number(x.notional),leverage=Number(x.leverage),fees=Number(x.fees)||0,exit=x.exit?Number(x.exit):null;
 const box=$('journalPreview');
 if(!entry||!stop||!notional||!leverage){box.className='journal-preview';box.textContent='진입가·손절가·명목금액·레버리지를 입력하면 계획 손실을 계산합니다.';return}
 const stopValid=x.side==='LONG'?stop<entry:stop>entry;
 if(!stopValid){box.className='journal-preview warn';box.textContent='손절가는 롱일 때 진입가 아래, 숏일 때 진입가 위여야 합니다.';return}
 const loss=notional*Math.abs(entry-stop)/entry+fees, margin=notional/leverage;
 const pnl=exit?(x.side==='LONG'?1:-1)*notional*(exit-entry)/entry-fees-(Number(x.funding)||0):null;
 box.className='journal-preview';
 box.textContent=`계획상 손절 손실 ${loss.toFixed(2)} · 초기 증거금 약 ${margin.toFixed(2)}${pnl!=null?' · 입력 청산가 기준 실현손익 $'+pnl.toFixed(2):''} · 계좌 자산 가정 없음. 실제 슬리피지·청산 위험은 별도입니다.`;
}
// Automatic journal entries from live trades: result, likely reasons, what to change next.
const OUTCOME_KO={PROFIT:'수익',LOSS:'손절',BREAKEVEN:'본절',UNKNOWN:'확인 불가'};
function autoJournalHTML(t){
 const v=t.review||{},pnl=Number(t.realizedPnLUSD),cls=pnl>0?'journal-pnl-positive':pnl<0?'journal-pnl-negative':'';
 const list=a=>a?.length?`<ul>${a.map(x=>`<li>${escapeHtml(x)}</li>`).join('')}</ul>`:'';
 return `<div class="journal-record journal-auto"><div class="journal-record-title"><span>${escapeHtml(t.symbol)} · ${t.side==='LONG'?'롱':'숏'} · ${escapeHtml(v.pattern||'')}</span><span class="${cls}">${OUTCOME_KO[v.outcome]||''} ${Number.isFinite(pnl)?(pnl>=0?'+':'−')+'$'+Math.abs(pnl).toFixed(2):'—'}${t.realizedSource==='ESTIMATE'?' 추정':''}</span></div>
 <p class="journal-facts">진입 ${fmt(t.entry)} · 평균 ${fmt(t.averageEntry)} · 손절 ${fmt(t.stop)} · ${escapeHtml(t.leverage)}배 · 추매 ${escapeHtml(v.addsFilled??0)}/${escapeHtml(v.addsMax??0)}회${v.holdHours!=null?` · 보유 ${escapeHtml(v.holdHours)}시간`:''}${v.score!=null?` · 점수 ${escapeHtml(v.score)}`:''}</p>
 <div class="journal-review"><b>원인 분석</b>${list(v.reasons)}${v.next?.length?`<b>다음 개선</b>${list(v.next)}`:''}</div>
 <small>${dateClock(t.closedAt)} KST 마감 · 자동 기록 (테스트넷)</small><div class="journal-record-actions"><button data-delete="${escapeHtml(t.id)}">삭제</button></div></div>`;
}
function insightsHTML(rows){
 if(!rows?.length)return '<p class="empty-small">실매매 거래가 쌓이면 패턴별 결과와 개선 방향을 여기에 정리합니다.</p>';
 return `<table class="venues-table"><thead><tr><th>패턴</th><th>거래</th><th>승률</th><th>누적 손익</th><th>개선 방향</th></tr></thead><tbody>${rows.map(r=>`<tr><td>${escapeHtml(r.pattern)}</td><td>${r.trades}</td><td>${r.winRatePct}%</td><td class="${r.netUSD>0?'positive':r.netUSD<0?'negative':''}">${r.netUSD>=0?'+':'−'}$${Math.abs(r.netUSD).toFixed(2)}</td><td>${r.suggestions.length?r.suggestions.map(escapeHtml).join('<br>'):r.trades<5?'5건 이상 쌓이면 판단':'유지'}</td></tr>`).join('')}</tbody></table>`;
}
function renderJournal(){
 const j=app.journalSummary||{};const cur=v=>'$'+Number(v||0).toFixed(2);const signed=v=>Number(v||0)>0?'positive':Number(v||0)<0?'negative':'';
 $('journalToday').textContent=cur(j.todayPnL);$('journalToday').className=signed(j.todayPnL);
 $('journalWeek').textContent=cur(j.weekPnL);$('journalWeek').className=signed(j.weekPnL);
 $('journalTotal').textContent=cur(j.totalPnL)+' / '+(j.winRate==null?'승률 —':(100*j.winRate).toFixed(1)+'%');$('journalTotal').className=signed(j.totalPnL);
 $('journalOpenRisk').textContent=cur(j.stopRiskOpen)+' ('+(j.open||0)+'건)';
 $('journalInsights')&&($('journalInsights').innerHTML=insightsHTML(app.journalInsights));
 $('journalList').innerHTML=app.journal.length?app.journal.slice(0,50).map(t=>t.source==='LIVE_AUTO'?autoJournalHTML(t):`<div class="journal-record"><div class="journal-record-title"><span>${escapeHtml(t.symbol)} · ${t.side}</span><span class="${t.realizedPnLUSD>0?'journal-pnl-positive':t.realizedPnLUSD<0?'journal-pnl-negative':''}">${t.status==='OPEN'?'진행 중':cur(t.realizedPnLUSD)}</span></div><p>진입 ${fmt(t.entry)} · 손절 ${fmt(t.stop)} · ${t.status==='CLOSED'?'청산 '+fmt(t.exit)+' · ':''}명목 ${cur(t.notional)} · ${t.leverage}x<br>계획 손절 ${cur(t.stopRiskUSD)} · 기록된 비용 ${cur(t.fees)} · 펀딩 ${cur(t.funding)}</p><small>${dateClock(t.createdAt)} KST · ${escapeHtml(t.note||'메모 없음')}</small><div class="journal-record-actions">${t.status==='OPEN'?`<button data-close="${escapeHtml(t.id)}">청산 기록</button>`:''}<button data-delete="${escapeHtml(t.id)}">삭제</button></div></div>`).join(''):'<div class="empty-small">저장된 거래 기록이 없습니다. 실매매 거래는 자동으로 기록되며 수동으로도 입력할 수 있습니다.</div>';
 document.querySelectorAll('#journalList [data-close]').forEach(b=>b.addEventListener('click',()=>{closingTradeId=b.dataset.close;$('closeTradePrice').value='';$('closeTradeFee').value='0';$('closeTradeFunding').value='0';$('closeTradeError').textContent='';$('closeTradeDialog').showModal()}));
 document.querySelectorAll('#journalList [data-delete]').forEach(b=>b.addEventListener('click',async()=>{if(!confirm('이 수동 거래 기록을 삭제할까요?'))return;try{await json('/api/journal/delete',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:b.dataset.delete})});await loadJournal();toast('삭제 완료')}catch(e){toast('삭제 실패: '+e.message,true)}}));
 calcJournalPreview();
}
async function loadJournal(){try{const data=await json('/api/journal');app.journal=data.entries||[];app.journalSummary=data.summary;app.journalInsights=data.insights||[];renderJournal()}catch(e){toast('매매일지 조회 실패: '+e.message,true)}}
let closingTradeId='';
async function saveJournal(e){e.preventDefault();if(!app.marketMap.has($('journalSymbol').value)){toast('상장 목록이 확인되지 않았습니다.',true);return}try{const body=journalFormData();await json('/api/journal',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});$('journalForm').reset();await loadJournal();toast('수동 매매 기록 저장 완료')}catch(e){toast('저장 실패: '+e.message,true)}}
async function closeJournalTrade(){try{await json('/api/journal/close',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:closingTradeId,exit:$('closeTradePrice').value,fees:$('closeTradeFee').value,funding:$('closeTradeFunding').value})});$('closeTradeDialog').close();await loadJournal();toast('수동 청산 기록 완료')}catch(e){$('closeTradeError').textContent=e.message}}
let audioContext;
function ping(){try{audioContext??=new(window.AudioContext||window.webkitAudioContext)();const osc=audioContext.createOscillator(),g=audioContext.createGain();osc.frequency.value=880;g.gain.setValueAtTime(.0001,audioContext.currentTime);g.gain.exponentialRampToValueAtTime(.12,audioContext.currentTime+.02);g.gain.exponentialRampToValueAtTime(.0001,audioContext.currentTime+.35);osc.connect(g);g.connect(audioContext.destination);osc.start();osc.stop(audioContext.currentTime+.38)}catch{}}
function renderNews(){
 const type=$('newsFilter').value,query=$('newsSearch').value.trim().toLowerCase();
 const rows=app.news.filter(n=>{
  if(type==='market'&&n.impact!=='high')return false;
  if((type==='risk'||type==='opportunity')&&n.tone!==type)return false;
  if(query&&!(n.title+' '+n.summary+' '+n.detail+' '+(n.displayTitle??n.titleKo??'')+' '+(n.displaySummary??n.summaryKo??'')+' '+(n.symbols||[]).join(' ')).toLowerCase().includes(query))return false;
  return true;
 });
 const p=paginateNews(rows,app.newsPage,NEWS_PER_PAGE);
 app.newsPage=p.page;
 $('newsList').innerHTML=p.items.length?p.items.map(n=>{
  const safeLink=(()=>{try{const u=new URL(n.link);return ['https:','http:'].includes(u.protocol)?escapeHtml(u.href):''}catch{return ''}})();
  const toneLabel=n.tone==='risk'?'악재 가능성':n.tone==='opportunity'?'호재 가능성':'방향 미확정';
  const translationStatus=n.translation?.status??n.translationStatus??'UNAVAILABLE',translated=['COMPLETE','PARTIAL','TRANSLATED','translated'].includes(translationStatus),translationLabel=translationStatus==='PARTIAL'?'부분 한국어 번역 · 미완료 원문':translated?'한국어 자동번역 · 정확성 미검증':translationStatus==='NOT_REQUIRED'?'원문 한국어':'원문 · 번역 '+translationStatus;
  const title=n.displayTitle??n.titleKo??n.translatedTitle??n.translation?.title??n.title,summary=n.displaySummary??n.summaryKo??n.translatedSummary??n.translation?.summary??n.summary,providedDetail=n.displayDetail??n.detailKo??n.translatedDetail??n.translation?.detail??n.detail;
  const short=clipNewsText(summary||providedDetail||'',180);
  const detail=String(providedDetail||summary||'').trim();
  const sourceText=detail?escapeHtml(detail):'이 기사에 대해 RSS에서 제공하는 본문 설명이 없습니다. 아래 원문을 확인해주세요.';
  const summaryText=short?escapeHtml(short):'제공처 요약 없음 · 기사 원문에서 상세 내용을 확인하세요.';
  const detailLink=safeLink?`<a class="news-detail-link" href="${safeLink}" target="_blank" rel="noopener noreferrer">기사 원문 전체 보기 ↗</a>`:'';
  return `<details class="news-entry" data-news-id="${escapeHtml(n.id)}" ${app.expandedNewsId===n.id?'open':''}>
    <summary class="news-entry-head"><span class="news-main"><span class="news-title">${escapeHtml(title)}</span><span class="news-summary">${summaryText}</span><span class="news-meta"><span class="news-tag ${escapeHtml(n.tone)}">${toneLabel}</span><span>${escapeHtml(n.source)}</span>${translated&&translationStatus!=='PARTIAL'?'':`<span class="news-translation-state">${escapeHtml(translationLabel)}</span>`}<span>${dateClock(n.published)} KST</span>${n.impact==='high'?'<span>주요 키워드</span>':''}${n.symbols?.length?`<span>${escapeHtml(n.symbols.join(', '))}</span>`:''}</span></span><span class="news-open-hint">상세 보기 <span aria-hidden="true">⌄</span></span></summary>
    <div class="news-detail"><div class="news-detail-heading">기사 본문 · 한국어 번역 (앞부분 발췌)</div><div class="news-body" data-news-body="${escapeHtml(n.id)}">${newsBodyHTML(n.id)}</div><details class="news-original"><summary>RSS 요약</summary><p>${sourceText}</p></details><details class="news-original"><summary>원문 제목·요약·제공 발췌</summary><strong>${escapeHtml(n.original?.title??n.originalTitle??n.title)}</strong><p>${escapeHtml(n.original?.summary??n.originalSummary??n.summary??'')}</p><p>${escapeHtml(n.original?.detail??n.originalDetail??n.detail??'')}</p></details>${n.translation?.errorCode||n.translation?.error?`<p class="news-translation-error">번역 상태: ${escapeHtml(n.translation.errorCode??n.translation.error)}</p>`:''}<div class="news-detail-foot"><span>원문·번역은 제공처 RSS 발췌 범위만 표시합니다. 번역 오류는 원문으로 표시하며 가격 전망이나 사건 원인을 만들지 않습니다.</span>${detailLink}</div></div>
   </details>`;
 }).join(''):'<div class="empty-small" style="padding:24px">필터에 해당하는 기사가 없거나 RSS 수신이 지연되고 있습니다.</div>';
 const m=app.newsMeta||{};
 $('newsStatus').textContent=`${m.status==='connected'?'RSS 수신 정상':m.status==='partial'?'일부 소스만 연결':m.status==='offline'?'뉴스 조회 실패':'연결 확인 중'} · ${m.sourceCount||0}개 출처 · ${app.news.length}개 기사 · 마지막 확인 ${dateClock(m.checked)} KST${m.translation?.total?` · 한국어 번역 ${m.translation.done}/${m.translation.total}건${m.translation.done<m.translation.total&&m.translation.error?` (번역 실패: ${m.translation.error})`:''}`:''}`;
 $('newsPageCount').textContent=p.total?`${p.start+1}–${p.end} / ${p.total}개 기사 · 한 페이지 5개`:'0개 기사';
 $('newsPrev').disabled=p.page<=1;
 $('newsNext').disabled=p.page>=p.pages;
 $('newsPageNumbers').innerHTML=pageWindow(p.page,p.pages).map(num=>`<button type="button" data-news-page="${num}" class="${num===p.page?'active':''}" aria-label="뉴스 ${num}페이지" ${num===p.page?'aria-current="page"':''}>${num}</button>`).join('');
}
function applyNews(data){app.news=Array.isArray(data.articles)?data.articles:[];app.newsMeta=data;renderNews()}
async function loadNews(){try{applyNews(await json('/api/news'));void loadMarketCommentary()}catch(e){app.newsMeta={status:'offline',error:e.message};renderNews()}}
async function loadMarketCommentary(){
 const host=$('marketCommentary');if(!host)return;
 try{const data=await json('/api/market-commentary');const lines=Array.isArray(data.lines)?data.lines:data.summary?[data.summary]:[];host.textContent=lines.length?lines.join(' ')+' · '+dateClock(data.asOf??data.checkedAt)+' KST':'실측 시장 시황 자료 부족 · 원인·전망을 추정하지 않습니다.'}catch{host.textContent='실측 시장 시황 조회 미완료 · 가격 전망이나 원인을 추정하지 않습니다.'}
}
// Live (testnet) trade notices as Chrome / system notifications and an on-page toast.
function liveNotice(n){
 if(!n?.text||!notifyOn('liveScreen'))return;
 const [title,...rest]=String(n.text).split('\n'),body=rest.join('\n');
 toast(title);
 if('Notification' in window&&Notification.permission==='granted'){
  try{const x=new Notification(title,{body,tag:'live-'+(n.symbol||'')+'-'+(n.type||''),renotify:true,requireInteraction:/문제|긴급/.test(title)});x.onclick=()=>{window.focus();location.hash='#live';x.close()}}catch{}
 }
 if(notifyOn('sound'))try{ping()}catch{}
}
function connectEvents(){let es=new EventSource('/events');app.stream=es;
 es.addEventListener('status',e=>{try{setStatus(JSON.parse(e.data))}catch{}});
 es.addEventListener('market',e=>{try{applyMarket(JSON.parse(e.data))}catch{}});
 es.addEventListener('news',e=>{try{applyNews(JSON.parse(e.data))}catch{}});
 es.addEventListener('live-notice',e=>{try{liveNotice(JSON.parse(e.data))}catch{}});
 es.addEventListener('journal',()=>loadJournal());
 es.addEventListener('update',e=>{try{updateStatusText(JSON.parse(e.data))}catch{}});
 es.onerror=()=>{if(es.readyState===EventSource.CLOSED)banner('서버 연결 종료','Node.js 서버를 다시 실행하세요.');$('socketStatus').innerHTML='<i class="dot red"></i><span>서버 재접속</span>'};
}
async function loadAll(){
 const [st,market]=await Promise.allSettled([json('/api/status'),json('/api/market')]);
 if(st.status==='fulfilled')setStatus(st.value);
 if(market.status==='fulfilled')applyMarket(market.value);
 await Promise.allSettled([loadNews(),loadJournal()]);
}
$('journalForm').addEventListener('submit',saveJournal);
$('journalForm').addEventListener('input',calcJournalPreview);
$('journalReset').addEventListener('click',()=>{$('journalForm').reset();calcJournalPreview()});
$('closeTradeSave').addEventListener('click',closeJournalTrade);
$('notificationButton').addEventListener('click',async()=>{
 if(!('Notification' in window)){toast('이 브라우저는 알림 기능을 지원하지 않습니다.',true);return}
 const r=await Notification.requestPermission();$('notificationButton').textContent=r==='granted'?'✓ 브라우저 알림 ON':'♧ 알림 권한 확인';toast(r==='granted'?'브라우저를 열어 둔 상태에서 실매매·카피 알림을 받습니다.':'알림 권한이 허용되지 않았습니다.',r!=='granted');if(r==='granted')ping();
});
// Cloud server: one tap fetches the GitHub version, lists the changes, applies and restarts.
fetch('/api/update',{cache:'no-store'}).then(r=>r.json()).then(u=>{setAppVersion(u);gitUpdate=u.git===true;if(gitUpdate){$('updateButton').textContent='↻ 업데이트';$('updateButton').title='GitHub 최신 버전을 확인하고 적용합니다'}}).catch(()=>{});
// Update progress: a centred popup with a 0.1 % progress bar fed by the server's own steps
// (/api/update/git/progress); while the server restarts the bar keeps moving until it is back.
function updateModal(){
 let m=document.getElementById('updateModal');
 if(!m){m=document.createElement('div');m.id='updateModal';m.className='update-modal';m.setAttribute('role','dialog');m.setAttribute('aria-modal','true');
  m.innerHTML='<div class="update-card"><b class="update-title"></b><div class="update-bar"><i></i></div><div class="update-row"><span class="update-label"></span><strong class="update-pct"></strong></div><p class="update-note"></p><button type="button" class="outline-btn update-close" hidden>확인</button></div>';
  document.body.appendChild(m);m.querySelector('.update-close').addEventListener('click',()=>m.remove())}
 return m;
}
function setUpdate({title,label,pct,note,done=false,error=false}){
 const m=updateModal();m.classList.toggle('error',error);m.classList.toggle('done',done);
 if(title!==undefined)m.querySelector('.update-title').textContent=title;
 if(label!==undefined)m.querySelector('.update-label').textContent=label;
 if(pct!==undefined){const v=Math.max(0,Math.min(100,pct));m.querySelector('.update-bar i').style.width=v.toFixed(1)+'%';m.querySelector('.update-pct').textContent=v.toFixed(1)+'%'}
 if(note!==undefined)m.querySelector('.update-note').textContent=note;
 m.querySelector('.update-close').hidden=!(done||error);
}
// After the reload: the completion popup (centre, slightly above the middle).
// Automatic update (2026-11-16): when the server comes back as a new process (new bootId) the page reloads by
// itself, and says so in a small notice that goes away.
{let boot=null,told=false;
 try{if(sessionStorage.getItem('autoReloaded')){sessionStorage.removeItem('autoReloaded');setTimeout(()=>toast('🔄 새 버전이 적용되어 화면을 새로고침했습니다'),300)}}catch{}
 setInterval(async()=>{try{const u=await (await fetch('/api/update',{cache:'no-store'})).json();
  if(boot&&u.bootId&&u.bootId!==boot){try{sessionStorage.setItem('autoReloaded','1')}catch{}location.reload();return}boot=u.bootId||boot;
  if(!told&&!document.getElementById('updateModal')){const j=await (await fetch('/api/update/git/progress',{cache:'no-store'})).json();if(j?.active&&j.source==='auto'){told=true;toast('🔄 자동 업데이트 중입니다. 끝나면 화면이 저절로 새로고침됩니다.')}}
 }catch{}},10000);}
// A small notice that goes away by itself (user 2026-11-16: no close button to press).
try{const d=JSON.parse(sessionStorage.getItem('updateDone')||'null');if(d){sessionStorage.removeItem('updateDone');
 const on=[d.rearmCopy&&'카피',d.rearm&&'신호 전략',d.rearmScalp&&'되돌림 단타'].filter(Boolean);
 setTimeout(()=>toast(`✅ 업데이트 완료 (${d.from} → ${d.to})`+(on.length?` · ${on.join('·')} 다시 켜짐`:'')),300)}}catch{}
async function runGitUpdate(b){
 const check=await json('/api/update/git');
 if(check.state==='current'){toast(`이미 최신 버전입니다 (${check.current})`);return}
 if(check.state!=='available'){setUpdate({title:'업데이트를 확인하지 못했습니다',label:'',pct:0,note:check.message||'',error:true});return}
 const list=check.changes.map(c=>'· '+c.subject).join('\n');
 if(!confirm(`새 버전 ${check.changes.length}건을 적용하고 서버를 재시작합니다.\n\n${list}\n\n재시작 후 카피(실계좌 포함)·신호 전략(테스트넷)·되돌림 단타가 모두 자동으로 켜집니다.`))return;
 let shown=0,target=1,label='업데이트 시작',down=false,applied=null,finished=false,restartAt=0;
 setUpdate({title:'업데이트 중',label,pct:0,note:'창을 닫지 말고 잠시 기다려 주세요. 보통 30초~1분 걸립니다.'});
 // Smooth 0.1 % steps toward the latest known progress.
 const anim=setInterval(()=>{if(shown<target){shown=Math.min(target,shown+Math.max(0.1,(target-shown)*0.08));setUpdate({pct:shown,label})}},100);
 // "주문 처리 중" (an order or position check running) is not a failure: tried again every 5 s for 2 minutes.
 const send=async()=>{for(let i=0;;i++){const r=await fetch('/api/update/git',{method:'POST',cache:'no-store',headers:{'Content-Type':'application/json'},body:JSON.stringify({confirm:'UPDATE'})});
   const x=await r.json().catch(()=>({}));if(r.ok&&x.ok)return x;
   if((x.error==='ORDER_IN_PROGRESS'||x.error==='UPDATE_IN_PROGRESS')&&i<24){label='진행 중인 주문 작업이 끝나기를 기다리는 중';await new Promise(w=>setTimeout(w,5000));continue}
   throw Error(x.message||x.error||'HTTP '+r.status)}};
 const post=send().then(x=>{applied=x}).catch(e=>{finished=true;clearInterval(anim);setUpdate({title:'업데이트 실패',label:e.message,pct:shown,note:'서버는 이전 버전으로 계속 동작합니다. 실매매 화면에서 활성화 상태를 확인해 주세요.',error:true})});
 // Up to 5 minutes for the restart; the page reloads by itself either way (user 2026-11-16).
 for(let i=0;i<1200&&!finished;i++){
  await new Promise(r=>setTimeout(r,250));
  try{
   const r=await fetch('/api/update/git/progress',{cache:'no-store'});
   if(!r.ok)throw Error('down');
   const p=await r.json();
   if(down){ // back after the restart
    finished=true;target=100;label='완료';await new Promise(r=>setTimeout(r,600));clearInterval(anim);setUpdate({pct:100,label:'완료'});
    try{sessionStorage.setItem('updateDone',JSON.stringify({from:applied?.from||check.current,to:applied?.to||check.latest,rearm:applied?.rearm===true,rearmCopy:applied?.rearmCopy===true,rearmScalp:applied?.rearmScalp===true}))}catch{}
    location.reload();return;
   }
   if(p.active){target=Math.max(target,p.pct);label=p.label||label}
  }catch{
   if(!applied&&!down){continue} // the POST is still running
   if(!down){down=true;restartAt=Date.now();label='서버 재시작 중'}
   // While the server restarts: creep toward 99.9 %.
   const t=(Date.now()-restartAt)/1000;target=Math.max(target,92+7.9*(1-Math.exp(-t/20)));
  }
 }
 await post.catch(()=>{});
 if(!finished&&applied){clearInterval(anim);location.reload()}
}
$('updateButton').addEventListener('click',async()=>{const b=$('updateButton');b.disabled=true;
 if(gitUpdate){try{await runGitUpdate(b)}catch(e){setUpdate({title:'업데이트 실패',label:e.message,pct:0,note:'',error:true})}finally{b.disabled=false}return}
 try{const x=await json('/api/update/check',{method:'POST'});updateStatusText(x);toast(x.message||'업데이트 확인 완료',x.state==='error')}catch(e){toast('업데이트 확인 실패: '+e.message,true)}finally{b.disabled=false}});
$('dismissError').addEventListener('click',clearBanner);
$('newsFilter').addEventListener('change',()=>{app.newsPage=1;app.expandedNewsId=null;renderNews()});
$('newsSearch').addEventListener('input',()=>{app.newsPage=1;app.expandedNewsId=null;renderNews()});
$('newsRefresh').addEventListener('click',loadNews);
$('newsPrev').addEventListener('click',()=>{app.newsPage-=1;app.expandedNewsId=null;renderNews()});
$('newsNext').addEventListener('click',()=>{app.newsPage+=1;app.expandedNewsId=null;renderNews()});
$('newsPageNumbers').addEventListener('click',e=>{const btn=e.target.closest('button[data-news-page]');if(!btn)return;app.newsPage=Number(btn.dataset.newsPage);app.expandedNewsId=null;renderNews()});
$('newsList').addEventListener('toggle',e=>{if(!e.target.matches?.('details[data-news-id]')||!e.target.isConnected)return;if(e.target.open)app.expandedNewsId=e.target.dataset.newsId;else if(app.expandedNewsId===e.target.dataset.newsId)app.expandedNewsId=null},true);
$('menuButton').addEventListener('click',()=>{$('sidebar').classList.toggle('open')});document.querySelectorAll('.navlink').forEach(a=>a.addEventListener('click',()=>{$('sidebar').classList.remove('open');document.querySelectorAll('.navlink').forEach(x=>x.classList.toggle('active',x===a))}));
setInterval(()=>{$('clock').textContent=clock(Date.now())+' KST';if(app.status)setStatus(app.status)},1000);
setInterval(loadJournal,60000);setInterval(loadNews,90000);setInterval(async()=>{try{const st=await json('/api/status');const changed=st.lastMarketListings!==app.status?.lastMarketListings;setStatus(st);if(!app.market.length||changed)applyMarket(await json('/api/market'))}catch{}},18000);
if('Notification' in window&&Notification.permission==='granted')$('notificationButton').textContent='✓ 브라우저 알림 ON';
connectEvents();loadAll();
