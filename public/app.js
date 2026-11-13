import {notifyOn} from './notify_settings.js';
import { tradingViewTicker, tradingViewInterval, tradingViewChartUrl, tradingViewAccess } from "/tradingview.js";
import {NEWS_PER_PAGE,paginateNews,clipNewsText,pageWindow} from "/news_pagination.js";
import {tradePlan,entryTiming} from "/trade_plan.js";
import {SCAN_PAGE_SIZE,paginateScan,scanPageWindow} from "/scan_pagination.js";
import {latestDirectionPattern} from "/directional_entries.js";
const $=id=>document.getElementById(id);
const initialSymbol=new URLSearchParams(window.location.search).get('symbol')?.toUpperCase()||'';
const rememberedSymbol=localStorage.getItem('sl-symbol');
const defaultChartSymbol=tradingViewTicker(initialSymbol)?initialSymbol:(tradingViewTicker(rememberedSymbol)?rememberedSymbol:'BTCUSDT');
const app={chartMode:'tradingview',tvLoadedKey:'',symbol:defaultChartSymbol, interval:'1h', market:[],marketMap:new Map(),watchlist:['BTCUSDT','ETHUSDT','SOLUSDT'],
 status:null,analysis:null,signals:[],patterns:[],watch:[],recent:[],alerts:[],news:[],newsMeta:null,newsPage:1,expandedNewsId:null,signalPage:1,recentPage:1,candles:[],dataSeries:{},chartLoading:false,stream:null,lastSocketEvent:0,hover:-1,journal:[],journalSummary:null};
const escapeHtml=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmt=(x)=>{const v=Number(x);if(!Number.isFinite(v)||v<=0)return '—';if(v>=1000)return v.toLocaleString('en-US',{maximumFractionDigits:2});if(v>=1)return v.toLocaleString('en-US',{maximumFractionDigits:4});if(v>=.01)return v.toFixed(5);return v>=.0001?v.toFixed(7):v.toFixed(Math.min(14,Math.max(8,Math.ceil(-Math.log10(v))+5))).replace(/0+$/,'').replace(/\.$/,'')};
const compact=v=>Number.isFinite(Number(v))?new Intl.NumberFormat('ko-KR',{notation:'compact',maximumFractionDigits:1}).format(Number(v)):'—';
const money=v=>'$'+fmt(v);
const pct=x=>(Number(x)>=0?'+':'')+Number(x||0).toFixed(2)+'%';
const clock=t=>t?new Date(t).toLocaleTimeString('ko-KR',{timeZone:'Asia/Seoul',hour12:false,hour:'2-digit',minute:'2-digit',second:'2-digit'}):'—';
const dateClock=t=>t?new Date(t).toLocaleString('ko-KR',{timeZone:'Asia/Seoul',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}):'—';

// Crypto analysis uses only verified Binance USDT perpetual listings.
function externalLinks(symbol){
 const m=app.marketMap.get(symbol);
 if(!m||!/^([A-Z0-9]+)USDT$/.test(symbol)||m.symbol!==m.baseAsset+'USDT')return null;
 return {binance:`https://www.binance.com/en/futures/${encodeURIComponent(symbol)}`};
}
function linkButtons(symbol){const links=externalLinks(symbol);if(!links)return '<span class="link-disabled">Binance 상장 검증 대기</span>';
 const tvUrl=tradingViewChartUrl(symbol,app.interval);
 return `${tvUrl?`<a class="trade-link neutral" href="${tvUrl}" target="_blank" rel="noopener noreferrer">TradingView ↗</a>`:''}<a class="trade-link neutral" href="${links.binance}" target="_blank" rel="noopener noreferrer">Binance 선물 ↗</a>`;
}
function focusSignal(symbol){
 if(!app.marketMap.has(symbol)){toast('해당 종목이 현재 Binance 거래 가능 목록에 없습니다. 다시 조회해 주세요.',true);return}
 selectSymbol(symbol);window.location.hash='#overview';window.setTimeout(()=>document.getElementById('chartPanel')?.scrollIntoView({behavior:'smooth'}),0);
}
function signalToast(alert){
 const holder=$('toastHolder'),node=document.createElement('div');node.className='toast signal-toast';
 node.innerHTML=`<strong>${escapeHtml(alert.symbol)} ${escapeHtml(alert.direction)} 감지</strong><div>${escapeHtml(alert.pattern)} · 진입 ${fmt(alert.entry)} · 손절 ${fmt(alert.stop)}</div><div>1차 40% ${fmt(alert.target1)} · 2차 35% ${fmt(alert.target2)} · 3차 25% ${fmt(alert.target3)}</div><button type="button" class="signal-toast-btn">사이트 차트 보기 ↗</button> ${linkButtons(alert.symbol)}`;
 node.querySelector('button').addEventListener('click',()=>{focusSignal(alert.symbol);node.remove()});
 holder.prepend(node);setTimeout(()=>node.remove(),14000);
}

function toast(message,error=false){const node=document.createElement('div');node.className='toast'+(error?' error':'');node.textContent=message;$('toastHolder').prepend(node);setTimeout(()=>node.remove(),6000)}
async function json(url,options){const res=await fetch(url,{cache:'no-store',...options});const data=await res.json().catch(()=>({}));if(!res.ok)throw Error(data.error||`HTTP ${res.status}`);return data}
function banner(title,detail){$('errorTitle').textContent=title;$('errorDetail').textContent=detail;$('connectBanner').classList.remove('hidden')}
function clearBanner(){$('connectBanner').classList.add('hidden')}
function updateStatusText(info){
 const el=$('updateStatus');if(!el)return;
 const current='5.8.0';
 const state=info?.state||'unconfigured';
 const labels={unconfigured:'자동 업데이트 비활성 — 배포 서버 URL 미설정',checking:'새 버전 확인 중',current:'최신 버전 사용 중',staged:'새 버전 준비됨 — 서버를 재시작하면 설치',error:'업데이트 확인 오류'};
 el.textContent='v'+current+' · '+(labels[state]||info?.message||'상태 확인 중')+(state==='staged'&&info?.version?' · 대상 '+info.version:'');
 el.classList.toggle('warn',state==='error'||state==='staged');
 if(state==='error'&&info?.message)el.title=info.message;
}
function renderScanDiagnostics(f){
 if(!f)return;
 const vals={diagUnique:f.uniqueAnalyzed,diagNoPattern:f.noPattern,diagPattern:f.patternCount,diagTechnicalPassed:f.technicalPassed,diagQuality:f.quality,diagVenuePassed:f.venuePassed,diagVenue:f.venue,diagEntry:f.entry,diagReady:f.ready};
 for(const [id,value] of Object.entries(vals)){const el=$(id);if(el)el.textContent=Number(value||0).toLocaleString('ko-KR')+'종';}
 const el=$('diagReasons');if(el){
   const reasons=(f.topReasons||[]).slice(0,5);
   // Detail behind the generic TP_PROFILE_UNAVAILABLE (plain text only, never HTML).
   const planBlocks=Array.isArray(f.targetPlan?.blocked)?f.targetPlan.blocked.slice(0,3):[];
   el.textContent=(reasons.length?'주요 보류 사유: '+reasons.map(x=>`${x.reason} ${x.count}종`).join(' · '):'패턴 미발견 또는 진단 자료 집계 중')+
    (planBlocks.length?' | 매물대 목표가 보류 상세: '+planBlocks.map(x=>`${x.reason} ${x.count}종`).join(' · '):'');
 }
}
function renderScorePolicy(policy){
 const node=$('scorePolicyStatus');if(!node)return;
 const value=policy?.finalMinScore;
 if(typeof value!=='number'||!Number.isFinite(value)||value<0||value>100){node.textContent='최종 신호 점수 기준: 설정 조회 미완료 · 실전 성능 미검증 · 실거래 승인 아님';return}
 const origin=policy.source==='CONFIGURED'?'환경설정':policy.source==='DEFAULT'?'기본 설정':'서버 설정';
 node.textContent=`최종 신호 점수 기준: ${value}/100 (${origin}) · 실전 성능 미검증 (UNVERIFIED) · 점수는 승률이 아니며 실거래 승인 아님`;
}
function setStatus(s){const previousVenue=app.status?.rest;app.status=s;renderScanDiagnostics(s.scanFunnel);renderScorePolicy(s.scorePolicy);
 if(s.update)updateStatusText({...s.update,version:'5.8.0'});
 $('sysWS').textContent=s.ws==='connected'?'정상 연결':s.ws==='connecting'?'연결 중':'끊김 / 재접속';
 $('sysREST').textContent=s.rest==='connected'?'연결됨':s.rest==='connecting'?'연결 중':'접속 실패';
 const liveFresh=s.liveWS==='connected'&&s.lastLiveDataAt&&Date.now()-s.lastLiveDataAt<90000;
 const tickerFresh=s.ws==='connected'&&s.lastTickerAt&&Date.now()-s.lastTickerAt<90000;
 $('sysScan').textContent=(liveFresh?'봉 스트림 실제 수신 확인':'봉 스트림 연결/수신 대기')+' · '+(Number.isFinite(s.intervalMs)?Math.round(s.intervalMs/60000)+'분 간격 REST 보완':'REST 보완 주기 미확인');
 $('sysScanHealth').textContent=(s.scanSuccess??0)+'건 성공 / '+(s.scanFailed??0)+'건 실패';
 $('sysScanErrors').textContent=(s.lastScanFailures||[]).slice(0,2).join(' | ')||'기록된 오류 없음';
 $('sysScanErrors').className='health-note';
 $('sysQuoteAge').textContent=s.lastTickerAt?Math.round((Date.now()-s.lastTickerAt)/1000)+'초 전 · '+(s.lastTickerCount||0)+'틱 수신':'실시간 틱 미수신';

 $('sysNewsAge').textContent=s.newsChecked?Math.round((Date.now()-s.newsChecked)/1000)+'초 전':'조회 전';
 const storageEl=$('sysStorage');if(storageEl){storageEl.textContent=s.storage?.healthy===false?'저장 실패 · 모의매매 일시 중지':s.storage?.lastSavedAt?'정상 · '+clock(s.storage.lastSavedAt):'확인 중';storageEl.classList.toggle('negative',s.storage?.healthy===false);}
 $('sysTG').textContent=s.telegramConfigured?'서버 설정 완료':'설정 필요';
 $('metricContracts').textContent=Number.isFinite(s.activeCount)?String(s.activeCount):'—';
 $('metricScanned').textContent=s.scannedTotal||0;
 $('metricLastScan').textContent=s.scanning?'분석 진행 중':(Math.max(s.lastLiveTrigger||0,s.lastScan||0))?clock(Math.max(s.lastLiveTrigger||0,s.lastScan||0)):'대기';
 $('coverageFoot').textContent=(s.cycleScanned||0)+'개 / 이번 순환 · 구독 대상 '+(s.liveWatched||0)+'개';
 $('scanProgress').textContent=s.scanning?'⟳ 실제 분석 중 · 이번 순환 '+(s.cycleScanned||0)+'개 검사':liveFresh?'● 봉 마감·선별 가격 이벤트 분석 · '+(s.liveAnalyzed||0)+'건':s.marketError?'⚠ Binance 종목 조회 재시도 중':'⏳ Binance 데이터 수신 대기';
 $('scanFoot').textContent=(liveFresh?'실시간 봉 이벤트 정상':'실시간 봉 수신 대기')+' · 최근 스캔 성공 '+(s.scanSuccess||0)+'건 / 실패 '+(s.scanFailed||0)+'건';
 const alive=Boolean(tickerFresh&&Date.now()-s.lastTickerAt<30000);
 $('socketStatus').innerHTML=`<i class="dot ${alive?'green':s.rest==='connected'?'amber':'red'}"></i><span>${alive?'실시간 연결':s.rest==='connected'?'주기 조회':'연결 대기'}</span>`;
 $('sysLiveHealth').textContent=liveFresh?Math.round((Date.now()-s.lastLiveDataAt)/1000)+'초 전 · 이벤트 분석 '+(s.liveAnalyzed||0)+'건':(s.liveLastError||'시세 구독 후 실제 봉 데이터 수신 대기');
 $('sysSubscriptions').textContent=(s.liveSubscribeAcks||0)+'개 ACK / '+(s.liveSubscribeErrors||0)+'개 오류';
 if(s.storage?.healthy===false)banner('기록 저장 실패 · 모의매매 확인 필요',s.storage.error||'기록이 디스크에 저장되지 않았습니다. 데이터 경로와 저장 공간을 확인하세요.');
 else if(s.error && (!s.activeCount||s.rest==='offline'))banner('시장 데이터 접속 오류',s.error+' · 서버에서 자동 재시도 중입니다.');
 else if(s.rest==='connected')clearBanner();
 app.watchlist=s.watchlist||app.watchlist;
 if(s.newsChecked && !app.newsMeta)loadNews();
 $('execLimits').textContent=`거래소 호가 스프레드 ≤${s.executionLimits?.maxSpreadBps??'미확인'}bp · 호가 나이 ≤${s.executionLimits?.maxQuoteAgeSeconds??'미확인'}초 · 모의 손실 한도 ${Number.isFinite(s.executionLimits?.maxRiskUSD)?money(s.executionLimits.maxRiskUSD):'미확인'} · 보류 신호 ${s.blockedSignals??'미확인'}건`;
 $('sysMarketUniverse').textContent=s.rest==='connected'?'Binance USDT 무기한 거래 대상 확인':'Binance 종목 조회 대기';
 $('matchVerified').textContent=(s.activeCount||0)+'종목 · TRADING / USDT / PERPETUAL · '+dateClock(s.lastMarketListings)+' KST';
 if(previousVenue!==s.rest){renderAnalysis();renderSignals();renderRecentCoverage()}
}
function setExecutionView(x){
 const e=$('executionVerdict');
 if(!x){e.className='execution-banner blocked';e.textContent='현재 공개 호가 확인 불가 · 신호 알림 제한';['execBidAsk','execSpread','execCost','execVenue','execMark','execFunding','execFundingTime','execQuoteTime'].forEach(id=>$(id).textContent='—');return}
 e.className='execution-banner '+(x.eligible?'good':'blocked');
 e.textContent=x.eligible?`✓ ${({BINGX:'BingX',GATEIO:'Gate.io'})[x.executionVenue]||'거래소'} 호가·모의 위험 계산 통과 · 주문 승인 아님`:'⚠ 진입 보류: '+(x.reasons?.join(' · ')||'데이터 미확인');
 $('execBidAsk').textContent=fmt(x.bid)+' / '+fmt(x.ask);
 $('execQuoteTime').textContent=x.quoteUpdatedAt?'호가 기준 '+dateClock(x.quoteUpdatedAt)+' KST · '+Math.round(x.quoteAgeSeconds||0)+'초 경과':'호가 갱신 시각 없음';
 $('execSpread').textContent=x.spreadBps==null?'—':(x.spreadBps.toFixed(2)+' bp');
 $('execCost').textContent=Number.isFinite(x.estimatedStopLossUSD)?'가정 손절손실 '+money(x.estimatedStopLossUSD)+' / 한도 '+(Number.isFinite(x.maxRiskUSD)?money(x.maxRiskUSD):'미확인'):'모의 손절 위험 산출 미확인';
 $('execVenue').textContent=Number.isFinite(x.slippageBps)?x.slippageBps.toFixed(2)+' bp':'미확인';
 $('execMark').textContent=Number.isFinite(x.quantity)?'모의 수량 '+fmt(x.quantity)+' · 명목 '+(Number.isFinite(x.notional)?money(x.notional):'미확인'):'유효한 모의 진입 수량 미확인';
 $('execFunding').textContent=Number.isFinite(x.costAssumptions?.takerRate)?'모의 Taker '+(x.costAssumptions.takerRate*10000).toFixed(2)+' bp 가정':'비용 가정 미확인';
 $('execFundingTime').textContent='실제 계정 요율·펀딩 정산 미검증 · 비용 가정은 실측 정산이 아님';
}
async function loadExecution(){
 const symbol=app.symbol;if(!symbol||!app.marketMap.has(symbol)){setExecutionView(null);return}
 const side=$('executionSide').value,amount=$('executionSize').value;
 try{const result=await json(`/api/execution?symbol=${encodeURIComponent(symbol)}&side=${side}&size=${amount}`);
  if(symbol!==app.symbol||side!==$('executionSide').value||amount!==$('executionSize').value)return;
  setExecutionView(result);
 }catch(e){if(symbol===app.symbol){setExecutionView(null);$('executionVerdict').textContent='호가 조회 실패: '+e.message}}
}
function selectedPrice(){return app.marketMap.get(app.symbol)?.price||app.analysis?.price||0}
function mergeMarketQuote(row,previous){
 // Metadata snapshots can arrive after a newer price event. Preserve its original
 // timestamp, including when it has become stale; a refresh must not make it fresh.
 const incomingAt=Number(row.priceAt)||0,previousAt=Number(previous?.priceAt)||0;
 if(previousAt>incomingAt&&Number.isFinite(previous?.price)&&previous.price>0){
  return {...row,price:previous.price,priceAt:previousAt,priceSource:previous.priceSource};
 }
 return {...row};
}
function applyMarket({markets,research=[],watchlist}){
 if(!Array.isArray(markets))return;
 const previous=app.marketMap;
 // Binance listings define this view independently of TradFi exchange metadata.
 app.marketMap=new Map(markets.map(m=>[m.symbol,{...mergeMarketQuote(m,previous.get(m.symbol)),researchOnly:false}]));
 app.market=markets.map(m=>app.marketMap.get(m.symbol));
 updateJournalSymbols();
 if(watchlist)app.watchlist=watchlist.filter(x=>markets.some(m=>m.symbol===x));
 // Viewing a public TradingView chart does NOT require exchange listing verification.
 // Preserve the selected chart symbol while market metadata is loading or offline.
 // The order links, analysis, scanner and alerts remain restricted to verified matches.
 app.signals=app.signals.filter(x=>app.marketMap.has(x.symbol));
 app.patterns=app.patterns.filter(x=>app.marketMap.has(x.symbol));
 app.watch=app.watch.filter(x=>app.marketMap.has(x.symbol));
 app.alerts=app.alerts.filter(x=>app.marketMap.has(x.symbol));
 if(!app.marketMap.has(app.symbol)){app.analysis=null;renderAnalysis();}
 renderPair();renderSignals();renderRecentCoverage();renderAlerts();renderMatched();loadExecution();renderTradingView();
}
function renderPair(){
 const base=app.symbol.replace('USDT',''),m=app.marketMap.get(app.symbol)||{};
 $('pairName').textContent=app.symbol||'BTCUSDT';
 $('assetLogo').textContent=base==='BTC'?'₿':base==='ETH'?'Ξ':base==='SOL'?'◎':base?base.slice(0,2):'—';
 $('assetLogo').style.background=base==='BTC'?'#db9b39':base==='ETH'?'#8299ca':base==='SOL'?'#7d78b4':'#41799c';
 $('pairPrice').textContent=fmt(m.price);$('pairChange').textContent='24H '+(m.price?pct(m.change||0):'—');
 $('pairChange').className='change '+(Number(m.change)>0?'positive':Number(m.change)<0?'negative':'neutral');
 $('pairCompare').textContent=app.marketMap.has(app.symbol)?'Binance USDT 무기한 차트 · 실제 주문 없음':'TradingView 차트 열람 가능 · Binance 상장 데이터 확인 대기';
 $('pairTradeLinks').innerHTML=linkButtons(app.symbol);
}
let matchedPage=0;
function renderMatched(){
 const query=($('marketSearch').value||'').trim().toUpperCase();
 const arr=app.market.filter(x=>!query||x.symbol.includes(query)||x.baseAsset.includes(query));
 const size=25,pages=Math.max(1,Math.ceil(arr.length/size));matchedPage=Math.min(matchedPage,pages-1);
 const list=arr.slice(matchedPage*size,(matchedPage+1)*size);
 $('matchedCount').textContent=`${arr.length} / ${app.market.length} 종목`;
 $('matchPage').textContent=arr.length?`${matchedPage+1} / ${pages}`:'0 / 0';
 $('matchPrev').disabled=matchedPage<=0;$('matchNext').disabled=matchedPage>=pages-1;
 $('matchedBody').innerHTML=list.length?list.map(m=>{
  return `<tr><td>${escapeHtml(m.baseAsset)}</td><td class="monospace">${escapeHtml(m.symbol)}</td><td class="monospace">${escapeHtml(m.contractType||'PERPETUAL')}</td><td class="monospace">${fmt(m.price)}</td><td class="monospace">${escapeHtml(m.status||'TRADING')}</td><td class="monospace">${compact(m.quoteVolume)}</td><td><div class="action-stack"><button class="table-link" data-pair="${escapeHtml(m.symbol)}">내 차트 ↗</button>${linkButtons(m.symbol)}</div></td></tr>`
 }).join(''):'<tr><td colspan="7" class="table-empty">Binance 거래 가능 목록이 없거나 공식 API 검증이 진행 중입니다. 미검증 종목은 표시하지 않습니다.</td></tr>';
 document.querySelectorAll('[data-pair]').forEach(btn=>btn.addEventListener('click',()=>{selectSymbol(btn.dataset.pair);document.getElementById('overview').scrollIntoView({behavior:'smooth'})}));
}
function levelRows(levelArr,side){return levelArr?.length?levelArr.map((p,i)=>`<div class="level-row ${side==='res'?'res':''}"><strong>${fmt(p.price)}</strong><span>${escapeHtml(p.source||'1h')} · ${i===0?'가장 가까움':'추가 레벨'}</span></div>`).join(''):'<div class="empty-small">확인된 피벗 구간 없음</div>'}
function volumeTargetHTML(row,{compact=false}={}){
 const plan=row?.targetPlan,evidence=plan?.profileEvidence;
 if(plan?.ok!==true||!Array.isArray(plan.targets)||plan.targets.length!==3||!evidence)return '<span class="target-unavailable">TP_PROFILE_UNAVAILABLE · 유효한 실제 체결 매물대 3개 검증 전 진입 보류</span>';
 const source=evidence.dataSource==='SYNTHETIC_TEST'?'합성 테스트':evidence.dataSource==='REAL_BINANCE_AGG_TRADES'?'Binance 실제 aggTrades':evidence.dataSource==='BINANCE_KLINES_15M'?'Binance 15분봉 3일 거래량 분포(근사)':'자료 출처 미검증';
 const coverage=Number.isFinite(evidence.coverage?.ratio)?(evidence.coverage.ratio*100).toFixed(1)+'%':'미확인';
 const rr=Number.isFinite(plan.estimatedNetRR)?plan.estimatedNetRR.toFixed(2)+'R':'미검증';
 const targets=plan.targets.map((price,i)=>{const part=plan.parts?.[i],ratio=Number.isFinite(part?.fraction)?(part.fraction*100).toFixed(0)+'%':'비율 미확인';return `<div class="tp-line"><b>TP${i+1} ${fmt(price)}</b><span>${ratio} 청산${Number.isFinite(part?.quantity)?' · 수량 '+fmt(part.quantity):''}</span>${!compact&&part?.zone?`<small>매물대 ${fmt(part.zone.priceLow)} ~ ${fmt(part.zone.priceHigh)} 직전</small>`:part?.source==='R_MULTIPLE'?`<small>매물대 없음 · ${escapeHtml(part.rMultiple)}R 지점</small>`:''}</div>`}).join('');
 return `<div class="tp-list volume-targets">${targets}<small>예상 TP1 순손익비 ${rr} · 체결·비용 가정</small><details class="volume-evidence"><summary>매물대 계산 근거</summary><p>${escapeHtml(source)} · ${dateClock(evidence.windowStart)} ~ ${dateClock(evidence.windowEnd)} KST<br>커버리지 ${coverage} · ${Number.isFinite(evidence.candles)?'15분봉 '+escapeHtml(evidence.candles)+'개':'체결 '+escapeHtml(evidence.uniqueTrades??evidence.tradeCount??'미확인')+'건'} · 갱신 ${dateClock(evidence.generatedAt??evidence.receivedAt)} KST</p><p>POC ${fmt(evidence.poc?.price)} · Value Area ${fmt(evidence.valueArea?.low)} ~ ${fmt(evidence.valueArea?.high)}<br>HVN ${(evidence.hvn||[]).map(zone=>fmt(zone.price)).join(' / ')||'미확인'}</p><small>${evidence.dataSource==='BINANCE_KLINES_15M'?'15분봉 거래량을 고가~저가에 고르게 나눈 근사치입니다.':'1H 봉 거래량을 가격별 체결량으로 바꾸지 않습니다.'} 기존 거래의 TP/SL은 변경하지 않습니다.</small></details></div>`;
}
function renderAnalysis(){
// Score factor values: short readable numbers, objects as "이름 값" pairs (never [object Object]).
const FACTOR_KO={adx:'ADX',plusDI:'+DI',minusDI:'-DI',histogram:'히스토그램',previousHistogram:'직전',ratio:'거래량 배수',requiredRatio:'기준',atr:'ATR',priceFraction:'가격 대비',bodyFraction:'몸통 비율',closePosition:'종가 위치',pattern:'패턴',directionConfirmed:'방향 확인'};
function factorNum(v){const x=Number(v);if(!Number.isFinite(x))return String(v);const a=Math.abs(x);return a>=1000?x.toFixed(1):a>=1?String(+x.toFixed(2)):String(+x.toPrecision(3))}
function factorValue(v){
 if(v===null||v===undefined||v==='')return '미확인';
 if(typeof v==='number'||(/^-?\d+(\.\d+)?(e-?\d+)?$/i.test(String(v))&&typeof v!=='boolean'))return factorNum(v);
 if(typeof v==='boolean')return v?'예':'아니오';
 if(typeof v==='object')return Object.entries(v).filter(([,x])=>x!==null&&x!==undefined&&typeof x!=='object').slice(0,3)
  .map(([k,x])=>`${FACTOR_KO[k]||k} ${typeof x==='boolean'?(x?'예':'아니오'):typeof x==='number'?factorNum(x):x}`).join(' · ')||'—';
 return String(v);
}
const a=app.analysis;
 if(!a||a.status==='insufficient'){$('analysisTag').textContent='평가 불가 · 데이터 확인';$('analysisTrend').textContent='—';$('supports').innerHTML='<div class="empty-small">마감된 1H·4H 데이터 부족</div>';$('resistances').innerHTML='<div class="empty-small">4H EMA200에 250~300개 확정봉 권장</div>';$('currentCandidate').innerHTML='<div class="empty-small">종합점수 평가 불가 · 값을 0점이나 100점으로 대체하지 않습니다.</div>';return}
 $('analysisTrend').textContent=a.trend==='up'?'▲ 상승 추세':a.trend==='down'?'▼ 하락 추세':'━ 중립 / 횡보';$('analysisTrend').className=a.trend==='up'?'positive':a.trend==='down'?'negative':'';
 $('supports').innerHTML=levelRows(a.supports,'sup');$('resistances').innerHTML=levelRows(a.resistances,'res');
 $('volRatio').textContent=Number.isFinite(a.volumeRatio)?a.volumeRatio.toFixed(2)+'x':'미확인';$('atrValue').textContent=fmt(a.atr);
 const ready=currentReadySignals().some(x=>x.symbol===a.symbol&&x.time===a.time&&x.pattern===a.pattern),market=app.marketMap.get(a.symbol),
  timing=entryTiming(a,{price:market?.price,priceAt:market?.priceAt,venueReady:ready}),technical=a.technicalValidation?.passed??a.quality?.passed,
  score=Number.isFinite(a.score)?a.score+'/100':'평가 불가',checks=a.scoreBreakdown??a.quality?.checks??[],
  reasons=a.technicalValidation?.reasons??a.quality?.failed??[];
 $('analysisTag').textContent=ready&&timing.actionable?'최종 검증 통과 · 실제 주문 OFF':technical?'기술 검증 완료 · 최종 진입 별도':'기술 검증 미완료';
 const breakdown=Array.isArray(checks)?checks:Object.values(checks);
 const qualityInfo=`<div class="quality-checks"><h4>단일 종합점수 ${escapeHtml(score)} · 기술 판정 별도</h4>${breakdown.map(c=>`<div class="quality-row"><span class="${c.passed?'quality-ok':'quality-bonus'}">${c.passed?'✓':'○'}</span><span>${escapeHtml(c.label||c.key)} · ${Number.isFinite(c.earned)?c.earned:Number.isFinite(c.points)?c.points:'평가 불가'}/${escapeHtml(c.weight??'—')}점</span><small>${escapeHtml(factorValue(c.value??c.reason))}</small></div>`).join('')}<small>4H EMA200 15 · EMA100 5 · 1H EMA20 10 · 패턴·확정 강도 25 · ADX/DMI 15 · RSI 10 · MACD 5 · 패턴별 거래량 10 · ATR 5. 점수는 승률이 아닙니다.</small></div>`;
 const validation=`<div class="signal-check ${technical?'':'blocked'}">기술 검증 ${technical?'완료':'미완료'}<small>${escapeHtml(reasons.join(' · ')||'기술 결과와 호가·위험·매물대 목표·현재 진입 조건을 별도로 확인합니다.')}</small></div>`;
 const execution=a.execution?`<div class="signal-check ${a.execution.eligible?'':'blocked'}">거래소 호가·위험 ${a.execution.eligible?'검증 통과':'검증 보류'}<small>${escapeHtml(a.execution.reasons?.join(' · ')||'실제 거래소 주문 승인은 별도이며 현재 OFF입니다.')}</small></div>`:'';
 $('currentCandidate').innerHTML=`<div class="signal-heading">${a.direction?`<span class="dir ${a.direction==='LONG'?'long':'short'}">${escapeHtml(a.direction)}</span>`:''}<span class="subtle-tag">종합 ${escapeHtml(score)} · 승률 아님</span></div><div class="signal-pattern">${escapeHtml(a.pattern||'확정 패턴 없음')}</div><div class="signal-comment">선택 종목의 지표 상세입니다. 메인 신호 목록에는 최종 검증 통과 결과만 표시합니다.</div>${qualityInfo}${validation}${a.entry?`<div class="signal-grid"><div><span>패턴 기준 진입가</span><strong>${fmt(a.entry)}</strong></div><div><span>손절 무효화</span><strong>${fmt(a.stop)}</strong></div></div>`:''}${volumeTargetHTML(a)}${execution}`;
}
function scanPagination(hostId,infoId,paged,onPage){
 const host=$(hostId),info=$(infoId);if(!host)return;
 if(info)info.textContent=paged.total?`${paged.total}건 중 ${paged.start+1}~${paged.end}건 · ${paged.page}/${paged.pages}페이지`:'0건 · 1/1페이지';
 const buttons=[{label:'이전',page:paged.page-1,disabled:paged.page===1},...scanPageWindow(paged.page,paged.pages).map(n=>({label:String(n),page:n,selected:n===paged.page})),{label:'다음',page:paged.page+1,disabled:paged.page===paged.pages}];
 host.innerHTML=buttons.map(b=>`<button type="button" data-scan-page="${b.page}" ${b.disabled?'disabled':''} ${b.selected?'aria-current="page"':''} class="${b.selected?'active':''}" aria-label="${b.label==='이전'||b.label==='다음'?b.label+' 페이지':b.label+' 페이지'}">${b.label}</button>`).join('');
 host.querySelectorAll('button:not(:disabled)').forEach(b=>b.addEventListener('click',()=>onPage(Number(b.dataset.scanPage))));
}
function renderRecentCoverage(){} // Scan detail remains available in diagnostics; no candidate list is rendered.

function currentReadySignals(now=Date.now()){
 if(app.status?.rest!=='connected')return [];
 return app.signals.filter(signal=>{
  const market=app.marketMap.get(signal?.symbol);
  const targets=signal.targetPlan?.targets,validTargets=Array.isArray(targets)&&targets.length===3&&targets.every((price,i)=>Number.isFinite(price)&&price>0&&(signal.direction==='LONG'?price>(i?targets[i-1]:signal.entry):price<(i?targets[i-1]:signal.entry)));
  return Boolean(market)&&!market.researchOnly&&validTargets&&signal.qualified===true&&Number.isFinite(signal.score)&&
   signal.patternConfirmed===true&&(signal.technicalValidation?.passed??signal.quality?.passed)===true&&
   signal.execution?.eligible===true&&signal.targetPlan?.ok===true&&signal.targetPlan.targets?.length===3&&
   entryTiming(signal,{price:market.price,priceAt:market.priceAt,now,venueReady:true}).actionable;
 });
}
// Direction cards contain only the same currently validated final signals.
function directionalEntryRows(){return currentReadySignals()}

function directionalEntryStatus(row,approved){
 if(!row)return '확정 패턴 없음';
 const m=app.marketMap.get(row.symbol);
 const p=Number(m?.price);
 if(row.patternInvalidated||Number.isFinite(p)&&p>0&&(row.direction==='LONG'?p<=row.stop:p>=row.stop))return '손절 무효화 · 진입 금지';
 const isReady=approved.some(x=>x.symbol===row.symbol&&x.direction===row.direction&&x.pattern===row.pattern&&x.patternConfirmedAt===row.patternConfirmedAt&&x.entry===row.entry);
 if(isReady)return '현재 진입 검증 통과 · 실제 호가 별도 확인';
 if(row.quality?.passed===false)return '기술 조건 미달 · 진입 금지';
 if(row.execution?.eligible===false)return '호가·비용 검증 보류';
 return '진입 시점·가격 확인 대기';
}
function directionReferenceHTML(row,direction,approved,{selected=false}={}){
 const tag=direction==='LONG'?'long':'short';
 if(!row)return `<div class="direction-entry-box ${tag}"><span class="dir ${tag}">${direction}</span><strong>—</strong><small>최근 2시간 이내 유효한 확정 패턴 없음</small></div>`;
 const stage=directionalEntryStatus(row,approved),ready=stage.startsWith('현재 진입');
 const market=app.marketMap.get(row.symbol);
 const time=entryTiming(row,{price:market?.price,priceAt:market?.priceAt,venueReady:ready});
 return `<div class="direction-entry-box ${tag}"><div class="direction-entry-caption"><span class="dir ${tag}">${direction}</span><b>${escapeHtml(row.symbol)}</b></div><strong class="direction-entry-value">${fmt(row.entry)}</strong><small>차트 기준 진입가 (실제 주문가 아님)</small><span class="direction-entry-stage ${ready?'entry-safe':''}">${escapeHtml(stage)}</span><p>손절 ${fmt(row.stop)} · 1차 목표 ${fmt(row.target1)}</p>${time?.zoneLow>0&&time?.zoneHigh>0?`<p>관찰 진입 구간 ${fmt(time.zoneLow)} ~ ${fmt(time.zoneHigh)}</p>`:''}<small>${escapeHtml(row.pattern||'')} · 1H 확정 ${dateClock(row.patternConfirmedAt)} KST</small>${selected?'':`<button type="button" class="table-link" data-direction-symbol="${escapeHtml(row.symbol)}">차트 확인 ↗</button>`}</div>`;
}
function renderDirectionalEntries(){
 const global=$('directionEntryBoard'),single=$('pairDirectionEntries');
 if(!global&&!single)return;
 const now=Date.now(),rows=directionalEntryRows(),approved=currentReadySignals(now);
 if(global){
  global.innerHTML=['LONG','SHORT'].map(dir=>directionReferenceHTML(latestDirectionPattern(rows,dir,{now}),dir,approved)).join('');
  global.querySelectorAll('button[data-direction-symbol]').forEach(b=>b.addEventListener('click',()=>focusSignal(b.dataset.directionSymbol)));
 }
 if(single){
  single.innerHTML=['LONG','SHORT'].map(dir=>{
   const pattern=latestDirectionPattern(rows,dir,{now,symbol:app.symbol});
   if(pattern)return directionReferenceHTML(pattern,dir,approved,{selected:true});
   return `<div class="direction-entry-box ${dir==='LONG'?'long':'short'}"><span class="dir ${dir==='LONG'?'long':'short'}">${dir}</span><strong>최종 신호 없음</strong><small>점수·기술·호가·매물대 목표·현재 진입 조건 검증 대기</small></div>`;
  }).join('');
 }
}
function results(){return currentReadySignals()}
function renderSignals(){
 const filter=$('signalFilter').value,approved=currentReadySignals();
 let data=approved;
 if(filter==='LONG'||filter==='SHORT')data=data.filter(x=>x.direction===filter);
 data=[...data].sort((a,b)=>b.score-a.score||(b.patternConfirmedAt||0)-(a.patternConfirmedAt||0)||a.symbol.localeCompare(b.symbol,'en'));
 $('metricSignals').textContent=approved.length;
 $('navSignalCount').textContent=approved.length;
 $('signalFoot').textContent=`현재 최종 검증 통과 ${approved.length}건 · 실제 주문 OFF`;
 const paged=paginateScan(data,app.signalPage,SCAN_PAGE_SIZE);app.signalPage=paged.page;
 scanPagination('scanPageControls','scanPageInfo',paged,page=>{app.signalPage=page;renderSignals()});
 $('signalsBody').innerHTML=paged.items.length?paged.items.map(a=>{
  const market=app.marketMap.get(a.symbol),timing=entryTiming(a,{price:market.price,priceAt:market.priceAt,venueReady:true});
  const change=market.change??a.priceChangePercent??0;
  return `<tr><td><strong>${escapeHtml(a.symbol)}</strong><small class="signal-score">종합 ${a.score}/100 · 승률 아님</small></td><td class="monospace">${fmt(market.price)}</td><td class="monospace ${change>=0?'positive':'negative'}">${pct(change)}</td><td><span class="dir ${a.direction==='LONG'?'long':'short'}">${a.direction}</span><strong class="signal-pattern-name">${escapeHtml(a.pattern)}</strong><small>1H 확정 ${dateClock(a.patternConfirmedAt)} KST</small></td><td><span class="pattern-label pattern-ready">최종 검증 통과</span><small>기술·호가·위험·매물대 목표 확인<br>실제 주문 승인은 별도</small></td><td><div class="entry-price-ref"><strong>${fmt(a.entry)}</strong><small>손절 ${fmt(a.stop)}</small></div></td><td><div class="entry-timing entry-now"><strong>${escapeHtml(timing.label)}</strong><div>${fmt(timing.zoneLow)} ~ ${fmt(timing.zoneHigh)}</div><small>${escapeHtml(timing.detail)}</small></div></td><td>${volumeTargetHTML(a,{compact:true})}</td><td class="monospace">${fmt(a.supports?.[0]?.price)} / ${fmt(a.resistances?.[0]?.price)}</td><td class="monospace">${clock(a.scannedAt)}</td><td><div class="action-stack"><button class="table-link" data-symbol="${escapeHtml(a.symbol)}">차트·지표 상세 ↗</button><button class="table-link" data-journal="${escapeHtml(a.symbol)}">매매일지에 입력 ↗</button>${linkButtons(a.symbol)}</div></td></tr>`;
 }).join(''):'<tr><td colspan="11" class="table-empty">현재 모든 최종 검증을 통과한 신호가 없습니다. 미달·평가 불가 사유는 스캔 진단에서 확인하세요. Telegram은 동일한 최종 검증 신호만 발송하며 관찰·뉴스 발송은 OFF입니다.</td></tr>';
 document.querySelectorAll('#signalsBody button[data-symbol]').forEach(b=>b.addEventListener('click',()=>focusSignal(b.dataset.symbol)));
 document.querySelectorAll('#signalsBody button[data-journal]').forEach(b=>b.addEventListener('click',()=>fillJournalFromSignal(b.dataset.journal)));
 $('scanSummary').textContent=`최종 검증 ${approved.length}종 · 점수 내림차순 → 최신 확정봉 → 종목명 · Telegram은 동일한 최종 검증 신호만 발송`;
 renderDirectionalEntries();
}

function browserAlertState(a){
 const p=app.marketMap.get(a.symbol)?.price;const pAt=app.marketMap.get(a.symbol)?.priceAt;
 const now=Date.now(),confirmed=Number(a.patternConfirmedAt||((a.time||0)+3600000));
 if(now-confirmed>2*3600000)return {text:'유효기간 경과',cls:''};
 if(!Number.isFinite(p)||!Number.isFinite(pAt)||now-pAt>90000)return {text:'시세 재확인 필요',cls:''};
 if(a.direction==='LONG'&&p<=a.stop||a.direction==='SHORT'&&p>=a.stop)return {text:'손절 무효화',cls:''};
 if(a.direction==='LONG'&&p>=a.target1||a.direction==='SHORT'&&p<=a.target1)return {text:'1차 목표 구간 도달',cls:''};
 const limit=Math.max(.006,(a.atr||0)/a.entry*.65);
 if(Math.abs(p-a.entry)/a.entry>limit)return {text:'진입가 이탈 · 추격 주의',cls:''};
 return {text:'최근 조건 유지 · 주문가 재확인',cls:'live'};
}
function renderAlerts(){const alerts=(app.alerts||[]).filter(x=>app.marketMap.has(x.symbol)&&x.kind!=='WATCH'&&x.alertType!=='WATCH'&&x.observationOnly!==true);$('alertCount').textContent=alerts.length+'건';$('alertsList').innerHTML=alerts.length?alerts.slice(0,30).map(a=>{
 const life=browserAlertState(a);
 return `<div class="alert-item"><div class="alert-icon">⌁</div><div class="alert-content"><strong>${escapeHtml(a.symbol)} · <span class="${a.direction==='LONG'?'positive':'negative'}">${a.direction}</span> · ${escapeHtml(a.pattern)}</strong><p>발생 당시 진입 ${fmt(a.entry)} · 손절 ${fmt(a.stop)} · 목표 ${fmt(a.target1)}</p><span class="lifecycle-flag ${life.cls}">${life.text}</span><br><small>${dateClock(a.scannedAt)} KST · ${a.score}/100 · 과거 알림은 신규 주문 신호가 아닙니다</small></div><div class="alert-actions"><button data-symbol="${escapeHtml(a.symbol)}">내 차트 ↗</button><button data-journal="${escapeHtml(a.symbol)}">매매 기록 ↗</button>${linkButtons(a.symbol)}</div></div>`
 }).join(''):'<div class="empty-state">아직 발생한 시그널 알림이 없습니다.<small>조건이 충족되면 서버에 기록됩니다.</small></div>';
 document.querySelectorAll('.alert-item button[data-symbol]').forEach(b=>b.addEventListener('click',()=>focusSignal(b.dataset.symbol)));
 document.querySelectorAll('.alert-item button[data-journal]').forEach(b=>b.addEventListener('click',()=>fillJournalFromSignal(b.dataset.journal)));
}
// Local manual trade journal - no exchange credentials or automatic execution.
function updateJournalSymbols(){
 const el=$('journalSymbol');if(!el)return;
 const previous=el.value;el.innerHTML=app.market.map(m=>`<option value="${escapeHtml(m.symbol)}">${escapeHtml(m.symbol)}</option>`).join('');
 el.value=app.marketMap.has(previous)?previous:app.marketMap.has(app.symbol)?app.symbol:app.market[0]?.symbol||'';
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
function fillJournalFromSignal(symbol){
 const a=[...app.signals,...app.patterns,...app.alerts].find(x=>x.symbol===symbol)||app.analysis;
 if(!app.marketMap.has(symbol)){toast('현재 공통 상장 확인된 종목이 아닙니다.',true);return}
 $('journalSymbol').value=symbol;
 if(a?.symbol===symbol){$('journalSide').value=a.direction||'LONG';$('journalEntry').value=a.entry||'';$('journalStop').value=a.stop||'';$('journalNotional').value=a.risk?.nominal||500;$('journalLeverage').value=a.risk?.leverage|| (symbol.startsWith('BTC')?20:symbol.startsWith('ETH')?10:symbol.startsWith('SOL')?10:3);$('journalNote').value='차트 패턴 참고: '+(a.pattern||'');}
 $('journalExit').value='';calcJournalPreview();$('journal').scrollIntoView({behavior:'smooth'});toast('참고값만 입력했습니다. 실제 체결·손절 가격을 확인하고 저장하세요.');
}
function renderJournal(){
 const j=app.journalSummary||{};const cur=v=>'$'+Number(v||0).toFixed(2);const signed=v=>Number(v||0)>0?'positive':Number(v||0)<0?'negative':'';
 $('journalToday').textContent=cur(j.todayPnL);$('journalToday').className=signed(j.todayPnL);
 $('journalWeek').textContent=cur(j.weekPnL);$('journalWeek').className=signed(j.weekPnL);
 $('journalTotal').textContent=cur(j.totalPnL)+' / '+(j.winRate==null?'승률 —':(100*j.winRate).toFixed(1)+'%');$('journalTotal').className=signed(j.totalPnL);
 $('journalOpenRisk').textContent=cur(j.stopRiskOpen)+' ('+(j.open||0)+'건)';
 $('journalRiskBanner').className='journal-risk-banner';
 $('journalRiskBanner').textContent=`계좌 자산 가정 없음 · 열린 포지션 ${j.open||0}건 계획손절 합계 ${cur(j.stopRiskOpen)} · 오늘 ${cur(j.todayPnL)} / 이번 주 ${cur(j.weekPnL)} (기록 참고용). 실제 청산 위험과 누락 거래는 별도입니다.`;
 $('journalList').innerHTML=app.journal.length?app.journal.slice(0,50).map(t=>`<div class="journal-record"><div class="journal-record-title"><span>${escapeHtml(t.symbol)} · ${t.side}</span><span class="${t.realizedPnLUSD>0?'journal-pnl-positive':t.realizedPnLUSD<0?'journal-pnl-negative':''}">${t.status==='OPEN'?'진행 중':cur(t.realizedPnLUSD)}</span></div><p>진입 ${fmt(t.entry)} · 손절 ${fmt(t.stop)} · ${t.status==='CLOSED'?'청산 '+fmt(t.exit)+' · ':''}명목 ${cur(t.notional)} · ${t.leverage}x<br>계획 손절 ${cur(t.stopRiskUSD)} · 기록된 비용 ${cur(t.fees)} · 펀딩 ${cur(t.funding)}</p><small>${dateClock(t.createdAt)} KST · ${escapeHtml(t.note||'메모 없음')}</small><div class="journal-record-actions">${t.status==='OPEN'?`<button data-close="${escapeHtml(t.id)}">청산 기록</button>`:''}<button data-delete="${escapeHtml(t.id)}">삭제</button></div></div>`).join(''):'<div class="empty-small">저장된 거래 기록이 없습니다. 수동으로 입력하거나 시그널에서 ‘매매일지에 입력’을 사용하세요.</div>';
 document.querySelectorAll('#journalList [data-close]').forEach(b=>b.addEventListener('click',()=>{closingTradeId=b.dataset.close;$('closeTradePrice').value='';$('closeTradeFee').value='0';$('closeTradeFunding').value='0';$('closeTradeError').textContent='';$('closeTradeDialog').showModal()}));
 document.querySelectorAll('#journalList [data-delete]').forEach(b=>b.addEventListener('click',async()=>{if(!confirm('이 수동 거래 기록을 삭제할까요?'))return;try{await json('/api/journal/delete',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:b.dataset.delete})});await loadJournal();toast('삭제 완료')}catch(e){toast('삭제 실패: '+e.message,true)}}));
 calcJournalPreview();
}
async function loadJournal(){try{const data=await json('/api/journal');app.journal=data.entries||[];app.journalSummary=data.summary;renderJournal()}catch(e){toast('매매일지 조회 실패: '+e.message,true)}}
let closingTradeId='';
async function saveJournal(e){e.preventDefault();if(!app.marketMap.has($('journalSymbol').value)){toast('상장 목록이 확인되지 않았습니다.',true);return}try{const body=journalFormData();await json('/api/journal',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});$('journalForm').reset();await loadJournal();toast('수동 매매 기록 저장 완료')}catch(e){toast('저장 실패: '+e.message,true)}}
async function closeJournalTrade(){try{await json('/api/journal/close',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:closingTradeId,exit:$('closeTradePrice').value,fees:$('closeTradeFee').value,funding:$('closeTradeFunding').value})});$('closeTradeDialog').close();await loadJournal();toast('수동 청산 기록 완료')}catch(e){$('closeTradeError').textContent=e.message}}
// Public TradingView chart access is independent of Binance listing verification.
// No simulated price data is displayed. Matching verification STILL gates trade links,
// automated analysis and entry alerts (fail closed on network/API failure).
function renderTradingView(){
 const tvHost=$('tradingviewWidget'),tvWrap=$('chartWrap');
 const tvMode=app.chartMode==='tradingview';
 $('tvModeButton').classList.toggle('active',tvMode);
 $('basicModeButton').classList.toggle('active',!tvMode);
 $('basicChartOptions').classList.toggle('hidden',tvMode);
 $('chart').classList.toggle('hidden',tvMode);
 tvHost.classList.toggle('hidden',!tvMode);
 tvWrap.classList.toggle('tradingview-active',tvMode);
 document.querySelectorAll('.legend-basic').forEach(n=>n.classList.toggle('hidden',tvMode));
 const symbol=tradingViewTicker(app.symbol)?app.symbol:'BTCUSDT';
 const verified=Boolean(externalLinks(symbol));
 const access=tradingViewAccess(symbol,app.interval);
 const url=access.chartUrl;
 // Viewing a chart is safe while validation is pending; trading is not.
 for(const id of ['tvExternalLink','tvFallbackLink']){
   const node=$(id);node.href=url||'https://www.tradingview.com/chart/';node.setAttribute('aria-disabled',url?'false':'true');
 }
 $('chartAccessStatus').textContent=verified?'✓ Binance TRADING USDT 무기한 상장 확인 · 실제 주문 OFF':'차트 조회 전용 · Binance 상장 확인 전 (신호 보류)';
 $('chartAccessStatus').classList.toggle('verified',verified);
 $('tvSymbolInput').value=symbol;
 if(!tvMode){app.tvLoadedKey='';tvHost.replaceChildren();if(verified)loadChart();else{
   $('chartOverlay').classList.remove('hidden');
   $('chartOverlay').textContent='자체 분석 차트는 Binance 상장 확인 이후 이용할 수 있습니다. TradingView 모드에서는 지금 차트를 볼 수 있습니다.';
 }return}
 $('chartOverlay').classList.add('hidden');
 $('chartUpdated').textContent=verified?'TRADINGVIEW · BINANCE PERP · 상장 확인 완료':'TRADINGVIEW · BINANCE PERP · 차트 전용';
 const key=`${symbol}|${app.interval}`;
 if(app.tvLoadedKey===key)return;
 app.tvLoadedKey=key;
 tvHost.replaceChildren();
 const widgetSymbol=tradingViewTicker(symbol);
 if(!widgetSymbol)return;
 const container=document.createElement('div');container.className='tradingview-widget-container tv-widget';
 const widget=document.createElement('div');widget.className='tradingview-widget-container__widget tv-widget-content';
 const branding=document.createElement('div');branding.className='tradingview-widget-copyright tv-attribution';
 const official=document.createElement('a');official.href=url;official.target='_blank';official.rel='noopener noreferrer';
 official.textContent=`${symbol} · Binance Perpetual Chart by TradingView ↗`;
 branding.append(official);
 const script=document.createElement('script');
 script.async=true;script.type='text/javascript';
 script.src='https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js';
 script.textContent=JSON.stringify({autosize:true,symbol:widgetSymbol,interval:tradingViewInterval(app.interval),
   timezone:'Asia/Seoul',theme:'dark',style:'1',locale:'kr',backgroundColor:'#0d1723',
   gridColor:'rgba(95,117,148,0.10)',hide_side_toolbar:false,hide_top_toolbar:false,
   allow_symbol_change:true,save_image:true,withdateranges:true,hide_volume:false,
   details:false,calendar:false,hotlist:false,support_host:'https://www.tradingview.com'});
 script.addEventListener('error',()=>{if(app.tvLoadedKey===key){const msg=document.createElement('div');msg.className='tv-load-warning';msg.textContent='TradingView 위젯을 불러오지 못했습니다. 아래 새 탭 링크 또는 자체 차트를 이용하세요.';tvHost.append(msg)}});
 container.append(widget,branding,script);tvHost.append(container);
}
function viewChartOnly(raw){
 const symbol=String(raw||'').trim().toUpperCase();
 if(!tradingViewTicker(symbol)){
   toast('바이낸스 USDT-M 선물 형식으로 입력하세요. 예: BTCUSDT, SOLUSDT',true);
   return false;
 }
 app.symbol=symbol;
 app.analysis=null;
 app.candles=[];
 localStorage.setItem('sl-symbol',symbol);
 history.replaceState(null,'',`${location.pathname}?symbol=${encodeURIComponent(symbol)}${location.hash}`);
 app.chartMode='tradingview';
 renderTradingView();renderPair();renderAnalysis();renderNews();loadExecution();
 if(app.marketMap.has(symbol))loadAnalysis();
 else setExecutionView(null);
 return true;
}
function switchChartMode(mode){
 if(mode===app.chartMode)return;
 app.chartMode=mode;
 if(mode==='tradingview'){$('chartOverlay').classList.add('hidden')}
 renderTradingView();
 if(mode==='basic')requestAnimationFrame(drawChart);
}
function toggleChartWide(){
 const isWide=$('workGrid').classList.toggle('chart-wide');
 $('chartWideButton').textContent=isWide?'↔ 원래 크기':'↔ 넓게';
 $('chartWideButton').setAttribute('aria-pressed',String(isWide));
 requestAnimationFrame(drawChart);
}
async function toggleChartFullscreen(){
 const panel=$('chartPanel');
 try{if(document.fullscreenElement)await document.exitFullscreen();else if(panel.requestFullscreen)await panel.requestFullscreen();else toast('이 브라우저는 전체화면을 지원하지 않습니다.',true)}
 catch{toast('전체화면 전환이 차단되었습니다. 넓게 보기를 사용하세요.',true)}
}
async function selectSymbol(symbol){
 if(!symbol||!app.marketMap.has(symbol)){toast('Binance 거래 가능 USDT 무기한 선물이 아닙니다.',true);return}
 app.symbol=symbol;localStorage.setItem('sl-symbol',symbol);renderTradingView();renderNews();history.replaceState(null,'',`${location.pathname}?symbol=${encodeURIComponent(symbol)}${location.hash}`);app.analysis=null;renderPair();renderAnalysis();renderDirectionalEntries();loadExecution();
 await Promise.allSettled([loadChart(),loadAnalysis()]);
}
async function loadAnalysis(){const symbol=app.symbol;if(!symbol||!app.marketMap.has(symbol))return;try{const result=await json('/api/analyze?symbol='+encodeURIComponent(symbol));if(app.symbol!==symbol)return;app.analysis=result;renderAnalysis();renderDirectionalEntries();drawChart()}catch(e){if(app.symbol===symbol){toast('분석 실패: '+e.message,true);$('analysisTag').textContent='연결 오류'}}}
function parseRows(rows){return (rows||[]).map(r=>({time:Number(r[0]),open:Number(r[1]),high:Number(r[2]),low:Number(r[3]),close:Number(r[4]),volume:Number(r[5]),closed:Number(r[6])<Date.now()})).filter(x=>[x.time,x.open,x.high,x.low,x.close].every(Number.isFinite)).sort((a,b)=>a.time-b.time)}
async function loadChart(){if(app.chartMode!=='basic')return;const symbol=app.symbol,interval=app.interval;if(!symbol||!app.marketMap.has(symbol))return;app.chartLoading=true;$('chartOverlay').classList.remove('hidden');$('chartOverlay').textContent='실제 캔들 데이터를 불러오는 중…';
 try{const data=await json(`/api/klines?symbol=${encodeURIComponent(symbol)}&interval=${interval}`);if(app.symbol!==symbol||app.interval!==interval)return;app.candles=parseRows(data.rows);$('chartOverlay').classList.add('hidden');$('chartUpdated').textContent='BINANCE · '+clock(Date.now())+' KST';drawChart()}
 catch(e){if(symbol===app.symbol&&interval===app.interval){app.candles=[];$('chartOverlay').textContent='캔들 데이터 연결 실패: '+e.message;toast('차트 데이터 오류: '+e.message,true)}}
 finally{app.chartLoading=false}
}
// Plot only a fully seeded EMA from completed history. The visible 95 bars
// are a viewport, never a substitute for the EMA100/200 warmup history.
function ema(arr,period){
 const out=Array(arr.length).fill(null);if(arr.length<period)return out;
 let value=arr.slice(0,period).reduce((sum,x)=>sum+x,0)/period;out[period-1]=value;
 const coefficient=2/(period+1);for(let i=period;i<arr.length;i++){value+=(arr[i]-value)*coefficient;out[i]=value}return out;
}
function chartEMA(candles,period){
 const completed=candles.filter(bar=>bar.closed===true),values=ema(completed.map(bar=>bar.close),period);
 const byTime=new Map(completed.map((bar,index)=>[bar.time,values[index]]));
 return candles.map(bar=>byTime.get(bar.time)??null);
}
function drawChart(){if(app.chartMode!=='basic')return;const canvas=$('chart'),frame=canvas.parentElement;const rect=frame.getBoundingClientRect(),w=rect.width,h=rect.height,dpr=Math.max(1,window.devicePixelRatio||1);
 if(w<5||h<5)return;canvas.width=Math.round(w*dpr);canvas.height=Math.round(h*dpr);const ctx=canvas.getContext('2d');ctx.scale(dpr,dpr);ctx.clearRect(0,0,w,h);
 const bg='#0d1723',ink='#7f96ab',green='#42cba5',red='#f07486',grid='#233449';
 ctx.fillStyle=bg;ctx.fillRect(0,0,w,h);
 const c=app.candles.slice(-95);if(!c.length){ctx.fillStyle=ink;ctx.font='12px sans-serif';ctx.textAlign='center';ctx.fillText('실제 캔들 데이터 연결 대기',w/2,h/2);return}
 const chartL=14,chartR=w-76,chartT=23,chartB=h-65,volBase=h-28,volHeight=33;
 const overlayLevels=app.analysis?[...(app.analysis.supports||[]),...(app.analysis.resistances||[])].map(x=>x.price):[];
 const minC=Math.min(...c.map(x=>x.low)),maxC=Math.max(...c.map(x=>x.high)),span=Math.max(1e-12,maxC-minC);const lo=minC-span*.10,hi=maxC+span*.12;
 const y=p=>chartB-(p-lo)/(hi-lo)*(chartB-chartT);const candleWidth=(chartR-chartL)/c.length;
 ctx.strokeStyle=grid;ctx.fillStyle=ink;ctx.font='10px monospace';ctx.textAlign='left';ctx.lineWidth=.8;
 for(let i=0;i<=5;i++){const price=hi-(hi-lo)*i/5,Y=y(price);ctx.beginPath();ctx.moveTo(chartL,Y);ctx.lineTo(chartR,Y);ctx.stroke();ctx.fillText(fmt(price),chartR+8,Y+3)}
 for(let i=0;i<6;i++){const idx=Math.min(c.length-1,Math.floor(i*(c.length-1)/5)),X=chartL+(idx+.5)*candleWidth;ctx.beginPath();ctx.moveTo(X,chartT);ctx.lineTo(X,chartB);ctx.stroke();const d=new Date(c[idx].time);ctx.fillText(d.toLocaleString('ko-KR',{timeZone:'Asia/Seoul',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}),Math.min(chartR-76,X),h-6)}
 if($('showSR').checked){
   overlayLevels.forEach((p,i)=>{if(p<lo||p>hi)return;const isSupport=i<(app.analysis?.supports?.length||0);ctx.beginPath();ctx.strokeStyle=isSupport?'#42ceac88':'#f1718688';ctx.setLineDash([5,5]);ctx.moveTo(chartL,y(p));ctx.lineTo(chartR,y(p));ctx.stroke();ctx.setLineDash([]);ctx.fillStyle=isSupport?green:red;ctx.fillText(fmt(p),chartR+8,y(p)-5)})
 }
 const maxVolume=Math.max(...c.map(x=>x.volume),1);
 c.forEach((v,i)=>{const x=chartL+(i+.5)*candleWidth,up=v.close>=v.open;ctx.strokeStyle=up?green:red;ctx.fillStyle=up?'#42ceac99':'#f1718699';ctx.lineWidth=1;
   ctx.beginPath();ctx.moveTo(x,y(v.high));ctx.lineTo(x,y(v.low));ctx.stroke();const a=y(v.open),b=y(v.close);ctx.fillRect(x-Math.max(1,candleWidth*.32),Math.min(a,b),Math.max(1.5,candleWidth*.64),Math.max(1,Math.abs(b-a)));
   ctx.fillStyle=up?'#42ceac44':'#f1718644';const vheight=(v.volume/maxVolume)*volHeight;ctx.fillRect(x-candleWidth*.32,volBase-vheight,candleWidth*.64,vheight)
 });
 if($('showEMA').checked){[[20,'#5ca7f8'],[100,'#efb66d'],[200,'#a58cff']].forEach(([n,color])=>{const seq=chartEMA(app.candles,n).slice(-95);ctx.beginPath();ctx.strokeStyle=color;ctx.lineWidth=1.35;let connected=false;seq.forEach((p,i)=>{if(!Number.isFinite(p)){connected=false;return}const x=chartL+(i+.5)*candleWidth;if(!connected)ctx.moveTo(x,y(p));else ctx.lineTo(x,y(p));connected=true});ctx.stroke()})}
 const market=selectedPrice();if(market>lo&&market<hi){ctx.beginPath();ctx.setLineDash([2,4]);ctx.strokeStyle='#8cb9e5';ctx.moveTo(chartL,y(market));ctx.lineTo(chartR,y(market));ctx.stroke();ctx.setLineDash([]);ctx.fillStyle='#1d5374';ctx.fillRect(chartR,y(market)-10,75,18);ctx.fillStyle='#d5eeff';ctx.fillText(fmt(market),chartR+6,y(market)+3)}
 if(app.hover>=0&&app.hover<c.length){const idx=app.hover,X=chartL+(idx+.5)*candleWidth;ctx.strokeStyle='#7893aa';ctx.setLineDash([3,3]);ctx.beginPath();ctx.moveTo(X,chartT);ctx.lineTo(X,chartB);ctx.stroke();ctx.setLineDash([])}
 app.chartGeom={left:chartL,right:chartR,step:candleWidth,len:c.length,candles:c};
}
function onQuote(arr){let selectedChanged=false;for(const [symbol,price,priceAt] of arr){const q=app.marketMap.get(symbol);const at=priceAt===undefined?Date.now():Number(priceAt);if(q&&Number.isFinite(Number(price))&&Number(price)>0&&Number.isFinite(at)&&at>0&&at<=Date.now()+60000&&at>=Number(q.priceAt||0)){q.price=Number(price);q.priceAt=at;if(symbol===app.symbol)selectedChanged=true}}
 if(selectedChanged){renderPair();drawChart();if(Date.now()-(app.lastTimingRender||0)>5000){renderAnalysis();app.lastTimingRender=Date.now()}}
 const now=Date.now();if(now-(app.lastWatchRender||0)>6000){renderSignals();renderAlerts();app.lastWatchRender=now}
}
let audioContext;
function ping(){try{audioContext??=new(window.AudioContext||window.webkitAudioContext)();const osc=audioContext.createOscillator(),g=audioContext.createGain();osc.frequency.value=880;g.gain.setValueAtTime(.0001,audioContext.currentTime);g.gain.exponentialRampToValueAtTime(.12,audioContext.currentTime+.02);g.gain.exponentialRampToValueAtTime(.0001,audioContext.currentTime+.35);osc.connect(g);g.connect(audioContext.destination);osc.start();osc.stop(audioContext.currentTime+.38)}catch{}}
function notify(alert,{test=false}={}){if(!app.marketMap.has(alert.symbol)||alert.kind==='WATCH'||alert.alertType==='WATCH'||alert.observationOnly===true)return;if(!test&&!notifyOn('signalScreen'))return;signalToast(alert);if(notifyOn('sound'))ping();
 if('Notification' in window&&Notification.permission==='granted'){try{const n=new Notification(`${test?'[테스트 알림] ':''}${alert.symbol} ${alert.direction} · ${alert.pattern}`,{body:`진입 ${fmt(alert.entry)} / 손절 ${fmt(alert.stop)} / 목표 ${fmt(alert.target1)} | 클릭하면 Binance 선물 차트`,tag:alert.id||alert.symbol});n.onclick=()=>{window.focus();const url=externalLinks(alert.symbol)?.binance;if(url)window.open(url,'_blank','noopener,noreferrer');else focusSignal(alert.symbol);n.close()}}catch{}}
}
function renderNews(){
 const type=$('newsFilter').value,query=$('newsSearch').value.trim().toLowerCase(),coin=app.symbol.replace(/USDT$/,'');
 const rows=app.news.filter(n=>{
  if(type==='coin'&&!n.symbols?.includes(coin))return false;
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
    <summary class="news-entry-head"><span class="news-main"><span class="news-title">${escapeHtml(title)}</span><span class="news-summary">${summaryText}</span><span class="news-meta"><span class="news-tag ${escapeHtml(n.tone)}">${toneLabel}</span><span>${escapeHtml(n.source)}</span><span class="news-translation-state">${escapeHtml(translationLabel)}</span><span>${dateClock(n.published)} KST</span>${n.impact==='high'?'<span>주요 키워드</span>':''}${n.symbols?.length?`<span>${escapeHtml(n.symbols.join(', '))}</span>`:''}</span></span><span class="news-open-hint">상세 보기 <span aria-hidden="true">⌄</span></span></summary>
    <div class="news-detail"><div class="news-detail-heading">제공처 RSS 기사 설명 · 발췌</div><p>${sourceText}</p><details class="news-original"><summary>원문 제목·요약·제공 발췌</summary><strong>${escapeHtml(n.original?.title??n.originalTitle??n.title)}</strong><p>${escapeHtml(n.original?.summary??n.originalSummary??n.summary??'')}</p><p>${escapeHtml(n.original?.detail??n.originalDetail??n.detail??'')}</p></details>${n.translation?.errorCode||n.translation?.error?`<p class="news-translation-error">번역 상태: ${escapeHtml(n.translation.errorCode??n.translation.error)}</p>`:''}<div class="news-detail-foot"><span>원문·번역은 제공처 RSS 발췌 범위만 표시합니다. 번역 오류는 원문으로 표시하며 가격 전망이나 사건 원인을 만들지 않습니다.</span>${detailLink}</div></div>
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
function connectEvents(){let es=new EventSource('/events');app.stream=es;
 es.addEventListener('status',e=>{try{setStatus(JSON.parse(e.data))}catch{}});
 es.addEventListener('market',e=>{try{applyMarket(JSON.parse(e.data))}catch{}});
 es.addEventListener('quotes',e=>{try{const p=JSON.parse(e.data);app.lastSocketEvent=Date.now();onQuote(p.data||[])}catch{}});
 es.addEventListener('scan',e=>{try{const x=JSON.parse(e.data);setStatus(x.status);app.signals=x.signals||[];app.patterns=x.patterns||[];app.watch=x.watch||[];if(x.recent)app.recent=x.recent;renderSignals();renderRecentCoverage();json('/api/market').then(applyMarket).catch(()=>{});refreshSelectedAnalysis(x,{reloadMissing:true});drawChart() }catch{}});
 es.addEventListener('alert',e=>{try{const a=JSON.parse(e.data);if(a.kind==='WATCH'||a.alertType==='WATCH'||a.observationOnly===true)return;app.alerts.unshift(a);app.alerts=app.alerts.slice(0,60);renderAlerts();notify(a);loadResults()}catch{}});
 es.addEventListener('live',e=>{try{const d=JSON.parse(e.data);if(d.signals)app.signals=d.signals;if(d.patterns)app.patterns=d.patterns;if(d.watch)app.watch=d.watch;renderSignals();if(d.symbol===app.symbol){loadAnalysis();if(d.reason?.includes('close'))loadChart()}}catch{}});
 es.addEventListener('news',e=>{try{applyNews(JSON.parse(e.data))}catch{}});
 
 es.addEventListener('journal',()=>loadJournal());
 es.addEventListener('update',e=>{try{updateStatusText({...JSON.parse(e.data),version:'5.8.0'})}catch{}});
 es.onerror=()=>{if(es.readyState===EventSource.CLOSED)banner('서버 연결 종료','Node.js 서버를 다시 실행하세요.');$('socketStatus').innerHTML='<i class="dot red"></i><span>서버 재접속</span>'};
}
function refreshSelectedAnalysis(data,{reloadMissing=false}={}){
 const candidates=[...(data.signals||[]),...(data.recent||[]),...(data.patterns||[]),...(data.watch||[])];
 const found=candidates.find(x=>x.symbol===app.symbol);
 app.analysis=found||null;
 renderAnalysis();
 if(!found&&reloadMissing&&app.marketMap.has(app.symbol))void loadAnalysis();
}
async function loadResults(){try{const data=await json('/api/results');app.signals=(data.signals||[]).filter(x=>app.marketMap.has(x.symbol));app.patterns=(data.patterns||[]).filter(x=>app.marketMap.has(x.symbol));app.watch=(data.watch||[]).filter(x=>app.marketMap.has(x.symbol));app.recent=(data.recent||[]).filter(x=>app.marketMap.has(x.symbol));app.alerts=(data.alerts||[]).filter(x=>app.marketMap.has(x.symbol));renderSignals();renderRecentCoverage();renderAlerts();refreshSelectedAnalysis(data)}catch(e){console.warn('Results:',e.message)}}
async function loadAll(){
 // Market metadata failures must never hide the public chart viewer.
 const [st,market]=await Promise.allSettled([json('/api/status'),json('/api/market')]);
 if(st.status==='fulfilled')setStatus(st.value);
 if(market.status==='fulfilled')applyMarket(market.value);
 if(st.status==='rejected'||market.status==='rejected')banner('시장 데이터 검증 대기','TradingView 차트는 이용 가능합니다. 매매 신호와 주문 링크는 검증 전 차단됩니다. Node.js 서버 및 API 연결을 확인하세요.');
 await Promise.allSettled([loadResults(),loadNews(),loadJournal(),...(app.marketMap.has(app.symbol)?[loadChart(),loadAnalysis(),loadExecution()]:[])]);
}
$('journalForm').addEventListener('submit',saveJournal);
$('journalForm').addEventListener('input',calcJournalPreview);
$('journalReset').addEventListener('click',()=>{$('journalForm').reset();calcJournalPreview()});
$('closeTradeSave').addEventListener('click',closeJournalTrade);
$('notificationButton').addEventListener('click',async()=>{
 if(!('Notification' in window)){toast('이 브라우저는 알림 기능을 지원하지 않습니다.',true);return}
 const r=await Notification.requestPermission();$('notificationButton').textContent=r==='granted'?'✓ 브라우저 알림 ON':'♧ 알림 권한 확인';toast(r==='granted'?'브라우저를 열어 둔 상태에서 신호 알림을 받습니다.':'알림 권한이 허용되지 않았습니다.',r!=='granted');if(r==='granted')ping();
});
$('testNotificationButton').addEventListener('click',()=>{
 const symbol=app.marketMap.has(app.symbol)?app.symbol:app.market[0]?.symbol;
 if(!symbol){toast('공통 상장 종목 조회 후 알림을 테스트할 수 있습니다.',true);return}
 const price=app.marketMap.get(symbol)?.price||0;
 notify({id:'signal-lab-local-test',symbol,direction:'LONG',pattern:'테스트용 예시 — 실제 신호 아님',entry:price,stop:price*.99,target1:price*1.02},{test:true});
 if(!('Notification' in window)||Notification.permission!=='granted')toast('브라우저 시스템 알림을 받으려면 먼저 ‘알림 켜기’를 눌러 허용하세요.',true);
});
$('scanButton').addEventListener('click',async e=>{const button=e.currentTarget;button.disabled=true;button.textContent='분석 중…';try{await loadAnalysis();toast(app.symbol+' 선택 종목 최신 분석 완료')}finally{button.disabled=false;button.textContent='✦ 선택 종목 분석'}});
$('refreshButton').addEventListener('click',()=>loadAll());
$('runScanNow').addEventListener('click',async()=>{const b=$('runScanNow');b.disabled=true;b.textContent='스캔 요청 중…';try{const x=await json('/api/scan',{method:'POST'});toast(x.accepted?'전체 보완 스캔을 시작했습니다. 처리 건수는 자동 갱신됩니다.':'이미 자동 스캔이 진행 중입니다.');}catch(e){toast('스캔 요청 실패: '+e.message,true)}finally{b.disabled=false;b.textContent='↻ 지금 스캔'}});
// Cloud server: one tap fetches the GitHub version, lists the changes, applies and restarts.
let gitUpdate=false;
fetch('/api/update',{cache:'no-store'}).then(r=>r.json()).then(u=>{gitUpdate=u.git===true;if(gitUpdate){$('updateButton').textContent='↻ 업데이트';$('updateButton').title='GitHub 최신 버전을 확인하고 적용합니다';const el=$('updateStatus');if(el)el.textContent='클라우드 서버 · 업데이트 버튼으로 최신 버전 적용'}}).catch(()=>{});
async function waitForRestart(){
 const el=$('updateStatus');let down=false;
 for(let i=0;i<60;i++){await new Promise(r=>setTimeout(r,3000));
  try{const r=await fetch('/api/update',{cache:'no-store'});if(r.ok&&down){location.reload();return}if(!r.ok)down=true}catch{down=true}
  if(el)el.textContent=down?'서버 재시작 중… 곧 새로고침됩니다':'적용 중…';
 }
 location.reload();
}
async function runGitUpdate(b){
 const check=await json('/api/update/git');
 if(check.state==='current'){toast('이미 최신 버전입니다 ('+check.current+')');return}
 if(check.state!=='available'){toast(check.message||'업데이트를 확인하지 못했습니다',true);return}
 const list=check.changes.map(c=>'· '+c.subject).join('\n');
 if(!confirm(`새 버전 ${check.changes.length}건을 적용하고 서버를 재시작합니다.\n\n${list}\n\n재시작 후 실매매는 비활성으로 시작합니다. 실매매 화면에서 활성화를 다시 눌러 주세요.`))return;
 const r=await fetch('/api/update/git',{method:'POST',cache:'no-store',headers:{'Content-Type':'application/json'},body:JSON.stringify({confirm:'UPDATE'})}),x=await r.json().catch(()=>({}));
 if(!r.ok||!x.ok)throw Error(x.message||x.error||'HTTP '+r.status);
 toast(`업데이트 적용 (${x.from} → ${x.to}) · 서버 재시작 중`);b.textContent='재시작 중…';await waitForRestart();
}
$('updateButton').addEventListener('click',async()=>{const b=$('updateButton');b.disabled=true;
 if(gitUpdate){try{await runGitUpdate(b)}catch(e){toast('업데이트 실패: '+e.message,true)}finally{b.disabled=false}return}
 try{const x=await json('/api/update/check',{method:'POST'});updateStatusText({...x,version:'5.8.0'});toast(x.message||'업데이트 확인 완료',x.state==='error')}catch(e){toast('업데이트 확인 실패: '+e.message,true)}finally{b.disabled=false}});
 $('executionSide').addEventListener('change',loadExecution);$('executionSize').addEventListener('change',loadExecution);$('executionRefresh').addEventListener('click',loadExecution);$('dismissError').addEventListener('click',clearBanner);
$('newsFilter').addEventListener('change',()=>{app.newsPage=1;app.expandedNewsId=null;renderNews()});
$('newsSearch').addEventListener('input',()=>{app.newsPage=1;app.expandedNewsId=null;renderNews()});
$('newsRefresh').addEventListener('click',loadNews);
$('newsPrev').addEventListener('click',()=>{app.newsPage-=1;app.expandedNewsId=null;renderNews()});
$('newsNext').addEventListener('click',()=>{app.newsPage+=1;app.expandedNewsId=null;renderNews()});
$('newsPageNumbers').addEventListener('click',e=>{const btn=e.target.closest('button[data-news-page]');if(!btn)return;app.newsPage=Number(btn.dataset.newsPage);app.expandedNewsId=null;renderNews()});
$('newsList').addEventListener('toggle',e=>{if(!e.target.matches?.('details[data-news-id]')||!e.target.isConnected)return;if(e.target.open)app.expandedNewsId=e.target.dataset.newsId;else if(app.expandedNewsId===e.target.dataset.newsId)app.expandedNewsId=null},true);
$('marketSearch').addEventListener('input',()=>{matchedPage=0;renderMatched()});
$('matchPrev').addEventListener('click',()=>{matchedPage=Math.max(0,matchedPage-1);renderMatched()});
$('matchNext').addEventListener('click',()=>{matchedPage+=1;renderMatched()});
$('signalFilter').addEventListener('change',()=>{app.signalPage=1;renderSignals()});
document.querySelectorAll('button[data-time]').forEach(b=>b.addEventListener('click',()=>{app.interval=b.dataset.time;app.hover=-1;document.querySelectorAll('button[data-time]').forEach(x=>x.classList.toggle('active',x===b));if(app.chartMode==='tradingview')renderTradingView();else loadChart()}));
$('tvGoButton').addEventListener('click',()=>viewChartOnly($('tvSymbolInput').value));
$('tvSymbolInput').addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();viewChartOnly(e.currentTarget.value)}});
$('tvModeButton').addEventListener('click',()=>switchChartMode('tradingview'));
$('basicModeButton').addEventListener('click',()=>switchChartMode('basic'));
$('chartWideButton').addEventListener('click',toggleChartWide);
$('chartFullscreenButton').addEventListener('click',toggleChartFullscreen);
document.addEventListener('fullscreenchange',()=>{$('chartFullscreenButton').textContent=document.fullscreenElement?'⛶ 닫기':'⛶ 전체화면';requestAnimationFrame(drawChart)});
$('showEMA').addEventListener('change',drawChart);$('showSR').addEventListener('change',drawChart);
$('menuButton').addEventListener('click',()=>{$('sidebar').classList.toggle('open')});document.querySelectorAll('.navlink').forEach(a=>a.addEventListener('click',()=>{$('sidebar').classList.remove('open');document.querySelectorAll('.navlink').forEach(x=>x.classList.toggle('active',x===a))}));
const canvas=$('chart');canvas.addEventListener('mousemove',e=>{const p=app.chartGeom;if(!p)return;const x=e.clientX-canvas.getBoundingClientRect().left;app.hover=Math.max(0,Math.min(p.len-1,Math.floor((x-p.left)/p.step)));const c=p.candles[app.hover];if(c){$('chartTooltip').innerHTML=`${dateClock(c.time)} KST<br>O ${fmt(c.open)} &nbsp; H ${fmt(c.high)}<br>L ${fmt(c.low)} &nbsp; C ${fmt(c.close)}<br>Vol ${compact(c.volume)}`;$('chartTooltip').style.left=Math.min(canvas.clientWidth-155,Math.max(8,x+18))+'px';$('chartTooltip').style.top='15px';$('chartTooltip').classList.remove('hidden')}drawChart()});canvas.addEventListener('mouseleave',()=>{app.hover=-1;$('chartTooltip').classList.add('hidden');drawChart()});
window.addEventListener('resize',drawChart);setInterval(()=>{$('clock').textContent=clock(Date.now())+' KST';if(app.status){setStatus(app.status);if(app.status.ws==='connected'&&Date.now()-Math.max(app.status.lastMarket,app.lastSocketEvent)>90000)banner('실시간 시세 지연','90초 이상 실시간 가격 업데이트가 없습니다. 신호의 최신성을 신뢰하지 마세요.')}},1000);
setInterval(loadExecution,30000);setInterval(loadJournal,60000);setInterval(loadChart,35000);setInterval(loadResults,65000);setInterval(loadNews,90000);setInterval(async()=>{try{const st=await json('/api/status');const changed=st.lastMarketListings!==app.status?.lastMarketListings;setStatus(st);if(st.ws!=='connected'||!app.market.length||changed){const m=await json('/api/market');applyMarket(m)}}catch{}},18000);
// A stalled feed must not leave a green entry badge on screen indefinitely.
setInterval(()=>{const now=Date.now();if(now-(app.lastWatchRender||0)>=5000){renderSignals();renderRecentCoverage();renderAlerts();app.lastWatchRender=now}if(now-(app.lastTimingRender||0)>=5000){renderAnalysis();app.lastTimingRender=now}},1000);
if('Notification' in window&&Notification.permission==='granted')$('notificationButton').textContent='✓ 브라우저 알림 ON';
// Mount TradingView immediately, before waiting for either exchange API.
renderPair();renderTradingView();connectEvents();loadAll();
