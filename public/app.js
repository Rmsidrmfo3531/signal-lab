// Dashboard: 실계좌·카피 / 테스트넷 / 뉴스 only (user request 2026-11-17; 매매일지 tab removed 2026-11-20).
// The server still records and serves /api/journal* data; this page no longer renders it.
// The removed 대시보드·차트 and 알림·시스템 pages' server features (scanner, Telegram notices,
// notification settings) keep running on the server; this page no longer renders them.
import {notifyOn} from './notify_settings.js';
import {NEWS_PER_PAGE,paginateNews,clipNewsText,pageWindow,featureNews} from "/news_pagination.js";
import {formatUpdateSchedule} from './update_schedule.js';
const $=id=>document.getElementById(id);
let gitUpdate=false; // set once /api/update says this server updates from GitHub
const app={market:[],marketMap:new Map(),status:null,news:[],newsMeta:null,newsPage:1,expandedNewsId:null,stream:null};
const escapeHtml=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmt=(x)=>{const v=Number(x);if(!Number.isFinite(v)||v<=0)return '—';if(v>=1000)return v.toLocaleString('en-US',{maximumFractionDigits:2});if(v>=1)return v.toLocaleString('en-US',{maximumFractionDigits:4});if(v>=.01)return v.toFixed(5);return v>=.0001?v.toFixed(7):v.toFixed(Math.min(14,Math.max(8,Math.ceil(-Math.log10(v))+5))).replace(/0+$/,'').replace(/\.$/,'')};
const clock=t=>t?new Date(t).toLocaleTimeString('ko-KR',{timeZone:'Asia/Seoul',hour12:false,hour:'2-digit',minute:'2-digit',second:'2-digit'}):'—';
const dateClock=t=>t?new Date(t).toLocaleString('ko-KR',{timeZone:'Asia/Seoul',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}):'—';
function toast(message,error=false){const node=document.createElement('div');node.className='toast'+(error?' error':'');node.textContent=message;$('toastHolder').prepend(node);setTimeout(()=>node.remove(),6000)}
async function json(url,options){const res=await fetch(url,{cache:'no-store',...options});const data=await res.json().catch(()=>({}));if(!res.ok)throw Error(data.error||`HTTP ${res.status}`);return data}
function banner(title,detail){$('errorTitle').textContent=title;$('errorDetail').textContent=detail;$('connectBanner').classList.remove('hidden')}
function clearBanner(){$('connectBanner').classList.add('hidden')}
const appVersionText=info=>info?.displayVersion||(info?.version?'v'+info.version:'');
function setAppVersion(info){
 const version=appVersionText(info);
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
// Binance listings (kept for the status refresh check below).
function applyMarket({markets}){
 if(!Array.isArray(markets))return;
 app.marketMap=new Map(markets.map(m=>[m.symbol,{...m}]));
 app.market=markets.map(m=>app.marketMap.get(m.symbol));
}
// Article body: fetched from the publisher when an item is opened, translated to Korean.
const newsBodies=new Map();
function newsBodyHTML(id){
 const b=newsBodies.get(id);
 if(!b)return '<p class="news-body-wait">본문을 불러오는 중입니다…</p>';
 if(!b.ok)return `<p class="news-body-wait">본문을 가져오지 못했습니다.</p><button type="button" class="outline-btn small" data-news-retry="${escapeHtml(id)}">다시 시도</button>`;
 const ko=b.paragraphsKo,en=b.paragraphs||[];
 return (ko&&b.translationProvider==='OPENAI'?'<p class="news-translation-state">한국어 AI 번역</p>':'')+(ko||en).map(p=>`<p>${escapeHtml(p)}</p>`).join('')+(ko?`<details class="news-original"><summary>영문 원문 보기</summary>${en.map(p=>`<p>${escapeHtml(p)}</p>`).join('')}</details>`:'<p class="news-body-wait">번역을 하지 못해 영문으로 표시합니다.</p>');
}
async function loadNewsBody(id,{retry=false}={}){
 const cached=newsBodies.get(id);
 if(!id||cached===null||cached?.ok||cached&&!retry)return;
 newsBodies.set(id,null);
 const render=()=>{const host=document.querySelector(`[data-news-body="${CSS.escape(id)}"]`);if(host)host.innerHTML=newsBodyHTML(id)};
 render();
 let b;try{const r=await fetch('/api/news/detail?id='+encodeURIComponent(id),{cache:'no-store',signal:AbortSignal.timeout(25000)});b=await r.json()}catch{b={ok:false,error:'연결 실패'}}
 if(!b||typeof b!=='object')b={ok:false,error:'응답 오류'};
 newsBodies.set(id,b);while(newsBodies.size>60)newsBodies.delete(newsBodies.keys().next().value);
 render();
}
if(typeof document!=='undefined')document.addEventListener('toggle',e=>{const d=e.target;if(d?.classList?.contains('news-entry')&&d.open)void loadNewsBody(d.dataset.newsId)},true);
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
 const first=type==='all'&&!query?featureNews(rows):{items:rows,featured:new Map()};
 const p=paginateNews(first.items,app.newsPage,NEWS_PER_PAGE);
 app.newsPage=p.page;
 $('newsList').innerHTML=p.items.length?p.items.map(n=>{
  const sources=first.featured.get(n.id);
  const feature=sources?`<span>주요 뉴스</span>${sources.length>1?`<span>${escapeHtml(sources.join(' · '))}</span>`:''}`:'';
  const safeLink=(()=>{try{const u=new URL(n.link);return ['https:','http:'].includes(u.protocol)?escapeHtml(u.href):''}catch{return ''}})();
  const toneLabel=n.tone==='risk'?'악재 가능성':n.tone==='opportunity'?'호재 가능성':'방향 미확정';
  const translationStatus=n.translation?.status??n.translationStatus??'UNAVAILABLE',translated=['COMPLETE','PARTIAL','TRANSLATED','translated'].includes(translationStatus),ai=n.translation?.provider==='OPENAI',translationLabel=translationStatus==='PARTIAL'?(ai?'일부 AI 번역':'일부 한국어 번역'):translated?(ai?'한국어 AI 번역':'한국어 자동번역'):translationStatus==='NOT_REQUIRED'?'원문 한국어':'원문 · 번역 '+translationStatus;
  const title=n.displayTitle??n.titleKo??n.translatedTitle??n.translation?.title??n.title,summary=n.displaySummary??n.summaryKo??n.translatedSummary??n.translation?.summary??n.summary,providedDetail=n.displayDetail??n.detailKo??n.translatedDetail??n.translation?.detail??n.detail;
  const short=clipNewsText(summary||providedDetail||'',180);
  const detail=String(providedDetail||summary||'').trim();
  const sourceText=detail?escapeHtml(detail):'이 기사에 대해 RSS에서 제공하는 본문 설명이 없습니다. 아래 원문을 확인해주세요.';
  const summaryText=short?escapeHtml(short):'제공처 요약 없음 · 기사 원문에서 상세 내용을 확인하세요.';
  const detailLink=safeLink?`<a class="news-detail-link" href="${safeLink}" target="_blank" rel="noopener noreferrer">기사 원문 전체 보기 ↗</a>`:'';
  return `<details class="news-entry" data-news-id="${escapeHtml(n.id)}" ${app.expandedNewsId===n.id?'open':''}>
    <summary class="news-entry-head"><span class="news-main"><span class="news-title">${escapeHtml(title)}</span><span class="news-summary">${summaryText}</span><span class="news-meta">${feature}<span class="news-tag ${escapeHtml(n.tone)}">${toneLabel}</span>${sources?.length>1?'':`<span>${escapeHtml(n.source)}</span>`}${translated&&!ai&&translationStatus!=='PARTIAL'?'':`<span class="news-translation-state">${escapeHtml(translationLabel)}</span>`}<span>${dateClock(n.published)} KST</span>${!sources&&n.impact==='high'?'<span>주요 키워드</span>':''}${n.symbols?.length?`<span>${escapeHtml(n.symbols.join(', '))}</span>`:''}</span></span><span class="news-open-hint">상세 보기 <span aria-hidden="true">⌄</span></span></summary>
    <div class="news-detail"><div class="news-detail-heading">기사 본문 발췌</div><div class="news-body" data-news-body="${escapeHtml(n.id)}">${newsBodyHTML(n.id)}</div><details class="news-original"><summary>RSS 요약</summary><p>${sourceText}</p></details><details class="news-original"><summary>원문 제목·요약·제공 발췌</summary><strong>${escapeHtml(n.original?.title??n.originalTitle??n.title)}</strong><p>${escapeHtml(n.original?.summary??n.originalSummary??n.summary??'')}</p><p>${escapeHtml(n.original?.detail??n.originalDetail??n.detail??'')}</p></details>${n.translation?.errorCode||n.translation?.error?`<p class="news-translation-error">번역 상태: ${escapeHtml(n.translation.errorCode??n.translation.error)}</p>`:''}<div class="news-detail-foot"><span>원문·번역은 제공처 RSS 발췌 범위만 표시합니다. 번역 오류는 원문으로 표시하며 가격 전망이나 사건 원인을 만들지 않습니다.</span>${detailLink}</div></div>
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
let newsLoading=false;
async function loadNews(){if(newsLoading)return;newsLoading=true;try{applyNews(await json('/api/news'))}catch(e){app.newsMeta={status:'offline',error:e.message};renderNews()}finally{newsLoading=false}}
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
 es.addEventListener('update',e=>{try{updateStatusText(JSON.parse(e.data))}catch{}});
 es.addEventListener('update-progress',e=>{try{handleUpdateProgressEvent(JSON.parse(e.data))}catch{}});
 es.addEventListener('update-schedule',e=>{try{const d=JSON.parse(e.data);scheduledUpdate=d?.scheduled||null;renderUpdateSchedule()}catch{}});
 es.addEventListener('economic-calendar',e=>{try{window.dispatchEvent(new CustomEvent('signal-lab:econ-calendar',{detail:JSON.parse(e.data)}))}catch{}});
 es.onerror=()=>{if(es.readyState===EventSource.CLOSED)banner('서버 연결 종료','Node.js 서버를 다시 실행하세요.');$('socketStatus').innerHTML='<i class="dot red"></i><span>서버 재접속</span>'};
}
async function loadAll(){
 const [st,market]=await Promise.allSettled([json('/api/status'),json('/api/market')]);
 if(st.status==='fulfilled')setStatus(st.value);
 if(market.status==='fulfilled')applyMarket(market.value);
 await Promise.allSettled([loadNews()]);
}
$('notificationButton').addEventListener('click',async()=>{
 if(!('Notification' in window)){toast('이 브라우저는 알림 기능을 지원하지 않습니다.',true);return}
 const r=await Notification.requestPermission();$('notificationButton').textContent=r==='granted'?'✓ 브라우저 알림 ON':'♧ 알림 권한 확인';toast(r==='granted'?'브라우저를 열어 둔 상태에서 실매매·카피 알림을 받습니다.':'알림 권한이 허용되지 않았습니다.',r!=='granted');if(r==='granted')ping();
});
// Cloud server: one tap fetches the GitHub version, lists the changes, applies and restarts.
let updateBoot=null,manualUpdate=false,activeUpdateWatch=false,pushUpdateProgress=null,scheduledUpdate=null;
const updateTime=new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Seoul',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
function renderUpdateSchedule(){
 const box=$('updateScheduleBanner');if(!box)return;
 if(!scheduledUpdate||activeUpdateWatch||manualUpdate){box.classList.add('hidden');return}
 const info=formatUpdateSchedule(scheduledUpdate,Date.now());
 if(!info){box.classList.add('hidden');return}
 $('updateScheduleTitle').textContent=info.title;
 $('updateScheduleDetail').textContent=info.detail;
 box.classList.remove('hidden');
}
function setUpdateButtonBusy(busy,{source='button',pct=null}={}){
 const b=$('updateButton');if(!b)return;
 if(busy){
  b.disabled=true;
  const prefix=source==='auto'?'↻ 자동 업데이트':'↻ 업데이트';
  b.textContent=Number.isFinite(pct)&&pct>0?`${prefix} ${Math.floor(pct)}%`:`${prefix} 중…`;
  b.title='업데이트가 진행 중입니다. 중복 실행 방지를 위해 완료될 때까지 버튼이 잠깁니다.';
 }else{
  b.disabled=false;
  b.textContent=gitUpdate?'↻ 업데이트':'↻ 업데이트 확인';
  b.title=gitUpdate?'GitHub 최신 버전을 확인하고 적용합니다':'신뢰할 수 있는 업데이트 서버를 설정해야 작동합니다';
 }
}
function showCompletedUpdate(info){
 let done=null,auto=false;
 try{done=JSON.parse(sessionStorage.getItem('updateDone')||'null');
  auto=Boolean(sessionStorage.getItem('autoReloaded'));
  sessionStorage.removeItem('updateDone');sessionStorage.removeItem('autoReloaded');
 }catch{}
 if(!done&&!auto)return;
 const version=appVersionText(info)||done?.toDisplayVersion,at=Number(done?.appliedAt||info?.bootId);
 const runtime=info?.runtime;
 const state=runtime?[`카피 ${runtime.copy?'켜짐':'꺼짐'}`,`신호 전략 ${runtime.signal?'켜짐':'꺼짐'}`,`되돌림 단타 ${runtime.scalp?'켜짐':'꺼짐'}`].join(' · '):'';
 const versionLine=version?(done?.fromDisplayVersion&&done.fromDisplayVersion!==version?done.fromDisplayVersion+' → ':'')+version:'';
 const message=['✅ 업데이트 완료',versionLine,at>0&&Number.isFinite(at)?'서버 적용 '+updateTime.format(at)+' KST':'',state].filter(Boolean).join(' · ');
 toast(message);
}
json('/api/update').then(u=>{
 updateBoot=u;setAppVersion(u);gitUpdate=u.git===true;
 scheduledUpdate=u.scheduledUpdate||null;renderUpdateSchedule();
 if(gitUpdate&&!activeUpdateWatch&&!manualUpdate){$('updateButton').textContent='↻ 업데이트';$('updateButton').title='GitHub 최신 버전을 확인하고 적용합니다'}
 showCompletedUpdate(u);
 if(u.updating&&u.updateJob&&!manualUpdate&&!activeUpdateWatch)void trackRunningUpdate({...u.updateJob,bootId:u.bootId});
}).catch(()=>showCompletedUpdate(null));
// Update progress: a centred popup with a 0.1 % progress bar fed by the server's own steps
// (SSE update-progress + /api/update/git/progress); while the server restarts the bar keeps moving until it is back.
function updateModal(){
 let m=document.getElementById('updateModal');
 if(!m){m=document.createElement('div');m.id='updateModal';m.className='update-modal';m.setAttribute('role','dialog');m.setAttribute('aria-modal','true');
  m.innerHTML='<div class="update-card"><b class="update-title"></b><p class="update-version" hidden></p><div class="update-bar"><i></i></div><div class="update-row"><span class="update-label"></span><strong class="update-pct"></strong></div><p class="update-note"></p><button type="button" class="outline-btn update-close" hidden>확인</button></div>';
  document.body.appendChild(m);m.querySelector('.update-close').addEventListener('click',()=>m.remove())}
 return m;
}
function setUpdate({title,version,label,pct,note,done=false,error=false}){
 const m=updateModal();m.classList.toggle('error',error);m.classList.toggle('done',done);
 if(title!==undefined)m.querySelector('.update-title').textContent=title;
 if(version!==undefined){const v=m.querySelector('.update-version');v.textContent=version;v.hidden=!version}
 if(label!==undefined)m.querySelector('.update-label').textContent=label;
 if(pct!==undefined){const v=Math.max(0,Math.min(100,pct));m.querySelector('.update-bar i').style.width=v.toFixed(1)+'%';m.querySelector('.update-pct').textContent=v.toFixed(1)+'%'}
 if(note!==undefined)m.querySelector('.update-note').textContent=note;
 m.querySelector('.update-close').hidden=!(done||error);
}
function handleUpdateProgressEvent(p){
 if(!p||typeof p!=='object')return;
 if(pushUpdateProgress)pushUpdateProgress(p);
 else if(p.active&&!manualUpdate&&!activeUpdateWatch)void trackRunningUpdate(p);
}
// Track an already-running auto (or other-tab) update with live progress bar and locked manual button.
async function trackRunningUpdate(initial={}){
 if(activeUpdateWatch||manualUpdate)return;
 activeUpdateWatch=true;
 renderUpdateSchedule();
 const source=initial.source||'auto';
 const originalBoot=initial.bootId||updateBoot?.bootId||null;
 let from=initial.fromDisplayVersion||appVersionText(updateBoot)||$('appVersion')?.textContent||'';
 let to=initial.toDisplayVersion||'';
 let shown=Math.max(0,Number(initial.pct)||0),target=Math.max(2,shown);
 let label=initial.label||(source==='auto'?'자동 업데이트 진행 중':'업데이트 진행 중');
 let down=false,finished=false,restartAt=0,terminalJob=null;
 const versionText=()=>[from,to&&to!==from?to:''].filter(Boolean).join(' → ');
 const title=source==='auto'?'자동 업데이트 중':'업데이트 중';
 const note='업데이트가 진행 중입니다. 중복 실행 방지를 위해 수동 업데이트가 잠기며, 완료 후 화면이 자동으로 새로고침됩니다.';
 setUpdateButtonBusy(true,{source,pct:shown});
 setUpdate({title,version:versionText(),label,pct:shown,note});
 const applySnap=p=>{
  if(!p||typeof p!=='object')return;
  if(p.fromDisplayVersion&&!from)from=p.fromDisplayVersion;
  if(p.toDisplayVersion&&p.toDisplayVersion!==to){to=p.toDisplayVersion;setUpdate({version:versionText()})}
  if(p.active){
   target=Math.max(target,Number(p.pct)||0);
   if(p.label)label=p.label;
  }else if(!down&&(!originalBoot||!p.bootId||p.bootId===originalBoot)){
   terminalJob=p;
  }
 };
 pushUpdateProgress=applySnap;
 const anim=setInterval(()=>{
  if(shown<target){shown=Math.min(target,shown+Math.max(0.1,(target-shown)*0.12))}
  setUpdate({pct:shown,label});
  setUpdateButtonBusy(true,{source,pct:shown});
 },100);
 try{
  for(let i=0;i<1400&&!finished;i++){
   await new Promise(r=>setTimeout(r,250));
   try{
    const r=await fetch('/api/update/git/progress',{cache:'no-store'});
    if(!r.ok)throw Error('down');
    const p=await r.json();
    const restarted=originalBoot&&p.bootId?originalBoot!==p.bootId:down;
    if(restarted){
     finished=true;target=100;label='완료';
     await new Promise(r=>setTimeout(r,600));
     clearInterval(anim);setUpdate({pct:100,label:'완료',done:true});
     const running=appVersionText(p);
     try{sessionStorage.setItem('updateDone',JSON.stringify({fromDisplayVersion:from||null,toDisplayVersion:running||to||null,appliedAt:p.bootId||null,auto:source==='auto'}))}catch{}
     location.reload();return;
    }
    applySnap(p);
    if(!p.active&&!down){
     const ended=terminalJob||p;
     finished=true;clearInterval(anim);
     if(ended.state==='postponed'){
      document.getElementById('updateModal')?.remove();
      toast('⏳ 진행 중인 주문이 끝나는 대로 새 버전으로 자동 재시작됩니다.');
     }else if(ended.error||(ended.state&&!['current','applied'].includes(ended.state))){
      setUpdate({title:source==='auto'?'자동 업데이트 중단':'업데이트 중단',label:ended.error||ended.label||ended.state,pct:shown,note:'서버는 이전 버전으로 계속 동작합니다.',error:true});
     }else{
      document.getElementById('updateModal')?.remove();
     }
     return;
    }
   }catch{
    if(!down){down=true;restartAt=Date.now();label='서버 재시작 중'}
    const t=(Date.now()-restartAt)/1000;target=Math.max(target,92+7.9*(1-Math.exp(-t/20)));
   }
  }
 }finally{
  clearInterval(anim);
  if(pushUpdateProgress===applySnap)pushUpdateProgress=null;
  activeUpdateWatch=false;
  if(!finished)document.getElementById('updateModal')?.remove();
  setUpdateButtonBusy(false);
  renderUpdateSchedule();
 }
}
// After an automatic update, reload and use the running server's version for the completion toast.
setInterval(async()=>{if(manualUpdate||activeUpdateWatch)return;try{
 const u=await json('/api/update');
 if(manualUpdate||activeUpdateWatch)return;
 if(updateBoot?.bootId&&u.bootId&&u.bootId!==updateBoot.bootId){
  if(appVersionText(u)!==appVersionText(updateBoot))try{sessionStorage.setItem('autoReloaded','1')}catch{}
  location.reload();return;
 }
 if(u.bootId)updateBoot=u;
 scheduledUpdate=u.scheduledUpdate||null;renderUpdateSchedule();
 if(u.updating&&u.updateJob){void trackRunningUpdate({...u.updateJob,bootId:u.bootId});return}
 const job=await json('/api/update/git/progress');
 if(job?.active&&!manualUpdate&&!activeUpdateWatch)void trackRunningUpdate(job);
}catch{}},5000);
async function runGitUpdate(){
 if(activeUpdateWatch||manualUpdate)return;
 const check=await json('/api/update/git');
 if(check.state==='updating'){await trackRunningUpdate(check);return}
 if('scheduledUpdate' in check){scheduledUpdate=check.scheduledUpdate||null;renderUpdateSchedule()}
 const from=check.currentDisplayVersion||appVersionText(updateBoot)||$('appVersion')?.textContent;
 const to=check.latestDisplayVersion;
 if(check.state==='current'){toast(['최신 버전 사용 중',from].filter(Boolean).join(' · '));return}
 if(check.state!=='available'){setUpdate({title:'업데이트를 확인하지 못했습니다',version:from||'',label:'',pct:0,note:check.message||'',error:true});return}
 const list=check.changes.map(c=>'· '+c.subject).join('\n');
 const versionLine=[from,to].filter(Boolean).join(' → ');
 if(!confirm(`새 버전을 적용하고 서버를 재시작합니다.\n${versionLine?versionLine+'\n':''}\n${list}\n\n재시작 후 카피(실계좌 포함)·신호 전략(테스트넷)·되돌림 단타가 모두 자동으로 켜집니다.`))return;
 manualUpdate=true;
 renderUpdateSchedule();
 let shown=0,target=1,label='업데이트 시작',down=false,applied=null,finished=false,restartAt=0,joinedExisting=false;
 setUpdateButtonBusy(true,{source:'button',pct:0});
 setUpdate({title:'업데이트 중',version:versionLine,label,pct:0,note:'창을 닫지 말고 잠시 기다려 주세요. 보통 30초~1분 걸립니다.'});
 const feedSnap=p=>{if(p?.active){target=Math.max(target,Number(p.pct)||0);if(p.label)label=p.label}};
 pushUpdateProgress=feedSnap;
 // Smooth 0.1 % steps toward the latest known progress.
 const anim=setInterval(()=>{if(shown<target){shown=Math.min(target,shown+Math.max(0.1,(target-shown)*0.08));setUpdate({pct:shown,label});setUpdateButtonBusy(true,{source:'button',pct:shown})}},100);
 // "주문 처리 중" (an order or position check running) is not a failure: tried again every 5 s for 2 minutes.
 const send=async()=>{for(let i=0;;i++){const r=await fetch('/api/update/git',{method:'POST',cache:'no-store',headers:{'Content-Type':'application/json'},body:JSON.stringify({confirm:'UPDATE'})});
   const x=await r.json().catch(()=>({}));if(r.ok&&x.ok)return x;
   // If an auto-update started in the exact moment confirm was clicked, attach smoothly instead of erroring.
   if(x.error==='UPDATE_IN_PROGRESS'){joinedExisting=true;return {ok:true,joinedExisting:true,fromDisplayVersion:from,toDisplayVersion:to}}
   if(x.error==='ORDER_IN_PROGRESS'&&i<24){label='진행 중인 주문 작업이 끝나기를 기다리는 중';await new Promise(w=>setTimeout(w,5000));continue}
   throw Error(x.message||x.error||'HTTP '+r.status)}};
 const post=send().then(x=>{applied=x}).catch(e=>{finished=true;clearInterval(anim);setUpdate({title:'업데이트 실패',label:e.message,pct:shown,note:'서버는 이전 버전으로 계속 동작합니다. 실매매 화면에서 활성화 상태를 확인해 주세요.',error:true})});
 // Up to 5 minutes for the restart; the page reloads by itself either way (user 2026-11-16).
 try{
  for(let i=0;i<1200&&!finished;i++){
   await new Promise(r=>setTimeout(r,250));
   try{
    const r=await fetch('/api/update/git/progress',{cache:'no-store'});
    if(!r.ok)throw Error('down');
    const p=await r.json();
    const originalBoot=check.bootId||updateBoot?.bootId;
    const restarted=originalBoot&&p.bootId?originalBoot!==p.bootId:down;
    const expected=applied?.toDisplayVersion||to,running=appVersionText(p);
    if(restarted&&(applied||joinedExisting)&&(!expected||!running||expected===running)){
     finished=true;target=100;label='완료';await new Promise(r=>setTimeout(r,600));clearInterval(anim);setUpdate({pct:100,label:'완료',done:true});
     try{sessionStorage.setItem('updateDone',JSON.stringify({fromDisplayVersion:applied?.fromDisplayVersion||from,
      toDisplayVersion:running||expected,appliedAt:p.bootId||null,
      rearm:applied?.rearm===true,rearmCopy:applied?.rearmCopy===true,rearmScalp:applied?.rearmScalp===true}))}catch{}
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
 }finally{
  clearInterval(anim);
  if(pushUpdateProgress===feedSnap)pushUpdateProgress=null;
 }
}
$('updateNowButton')?.addEventListener('click',()=>$('updateButton')?.click());
$('updateButton').addEventListener('click',async()=>{if(activeUpdateWatch||manualUpdate)return;const b=$('updateButton');b.disabled=true;
 if(gitUpdate){try{await runGitUpdate()}catch(e){setUpdate({title:'업데이트 실패',label:e.message,pct:0,note:'',error:true})}finally{manualUpdate=false;if(!activeUpdateWatch)setUpdateButtonBusy(false);renderUpdateSchedule()}return}
 try{const x=await json('/api/update/check',{method:'POST'});updateStatusText(x);toast(x.message||'업데이트 확인 완료',x.state==='error')}catch(e){toast('업데이트 확인 실패: '+e.message,true)}finally{b.disabled=false}});
$('dismissError').addEventListener('click',clearBanner);
$('newsFilter').addEventListener('change',()=>{app.newsPage=1;app.expandedNewsId=null;renderNews()});
$('newsSearch').addEventListener('input',()=>{app.newsPage=1;app.expandedNewsId=null;renderNews()});
$('newsRefresh').addEventListener('click',loadNews);
$('newsPrev').addEventListener('click',()=>{app.newsPage-=1;app.expandedNewsId=null;renderNews()});
$('newsNext').addEventListener('click',()=>{app.newsPage+=1;app.expandedNewsId=null;renderNews()});
$('newsPageNumbers').addEventListener('click',e=>{const btn=e.target.closest('button[data-news-page]');if(!btn)return;app.newsPage=Number(btn.dataset.newsPage);app.expandedNewsId=null;renderNews()});
$('newsList').addEventListener('toggle',e=>{if(!e.target.matches?.('details[data-news-id]')||!e.target.isConnected)return;if(e.target.open)app.expandedNewsId=e.target.dataset.newsId;else if(app.expandedNewsId===e.target.dataset.newsId)app.expandedNewsId=null},true);
$('newsList').addEventListener('click',e=>{const button=e.target.closest?.('[data-news-retry]');if(button)void loadNewsBody(button.dataset.newsRetry,{retry:true})});
$('menuButton').addEventListener('click',()=>{$('sidebar').classList.toggle('open')});document.querySelectorAll('.navlink').forEach(a=>a.addEventListener('click',()=>{$('sidebar').classList.remove('open');document.querySelectorAll('.navlink').forEach(x=>x.classList.toggle('active',x===a))}));
setInterval(()=>{$('clock').textContent=clock(Date.now())+' KST';if(app.status)setStatus(app.status);if(scheduledUpdate)renderUpdateSchedule()},1000);
setInterval(loadNews,90000);setInterval(async()=>{try{const st=await json('/api/status');const changed=st.lastMarketListings!==app.status?.lastMarketListings;setStatus(st);if(!app.market.length||changed)applyMarket(await json('/api/market'))}catch{}},18000);
if('Notification' in window&&Notification.permission==='granted')$('notificationButton').textContent='✓ 브라우저 알림 ON';
connectEvents();loadAll();
