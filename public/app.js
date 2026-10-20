import { tradingViewTicker, tradingViewInterval, tradingViewChartUrl, tradingViewAccess } from "/tradingview.js";
import {NEWS_PER_PAGE,paginateNews,clipNewsText,pageWindow} from "/news_pagination.js";
import {tradePlan,entryTiming} from "/trade_plan.js";
import {SCAN_PAGE_SIZE,paginateScan,scanPageWindow} from "/scan_pagination.js";
const $=id=>document.getElementById(id);
const initialSymbol=new URLSearchParams(window.location.search).get('symbol')?.toUpperCase()||'';
const rememberedSymbol=localStorage.getItem('sl-symbol');
const defaultChartSymbol=tradingViewTicker(initialSymbol)?initialSymbol:(tradingViewTicker(rememberedSymbol)?rememberedSymbol:'BTCUSDT');
const app={chartMode:'tradingview',tvLoadedKey:'',symbol:defaultChartSymbol, interval:'1h', market:[],marketMap:new Map(),watchlist:['BTCUSDT','ETHUSDT','SOLUSDT'],
 status:null,analysis:null,signals:[],patterns:[],watch:[],recent:[],structures:[],history:[],structurePage:1,historyPage:1,alerts:[],news:[],newsMeta:null,newsPage:1,expandedNewsId:null,signalPage:1,recentPage:1,candles:[],dataSeries:{},chartLoading:false,stream:null,showWatch:false,lastSocketEvent:0,hover:-1,journal:[],journalSummary:null};
const escapeHtml=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmt=(x)=>{const v=Number(x);if(!Number.isFinite(v)||v<=0)return '—';if(v>=1000)return v.toLocaleString('en-US',{maximumFractionDigits:2});if(v>=1)return v.toLocaleString('en-US',{maximumFractionDigits:4});if(v>=.01)return v.toFixed(5);return v>=.0001?v.toFixed(7):v.toFixed(Math.min(14,Math.max(8,Math.ceil(-Math.log10(v))+5))).replace(/0+$/,'').replace(/\.$/,'')};
const compact=v=>Number.isFinite(Number(v))?new Intl.NumberFormat('ko-KR',{notation:'compact',maximumFractionDigits:1}).format(Number(v)):'—';
const money=v=>'$'+fmt(v);
const pct=x=>(Number(x)>=0?'+':'')+Number(x||0).toFixed(2)+'%';
const clock=t=>t?new Date(t).toLocaleTimeString('ko-KR',{timeZone:'Asia/Seoul',hour12:false,hour:'2-digit',minute:'2-digit',second:'2-digit'}):'—';
const dateClock=t=>t?new Date(t).toLocaleString('ko-KR',{timeZone:'Asia/Seoul',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}):'—';

// Only build official URLs for Binance × Variational matches actually verified in /api/market.
function externalLinks(symbol){
 const m=app.marketMap.get(symbol);
 if(app.status?.variational!=='connected'||!m||!m.variational||!/^([A-Z0-9]+)USDT$/.test(symbol)||m.symbol!==m.baseAsset+'USDT'||m.variational.ticker!==m.baseAsset+'-PERP')return null;
 return {binance:`https://www.binance.com/en/futures/${encodeURIComponent(symbol)}`,variational:`https://omni.variational.io/perpetual/${encodeURIComponent(m.baseAsset)}`};
}
function linkButtons(symbol){const links=externalLinks(symbol);if(!links)return '<span class="link-disabled">상장 검증 대기</span>';
 const tvUrl=tradingViewChartUrl(symbol,app.interval);
 return `<a class="trade-link" href="${links.variational}" target="_blank" rel="noopener noreferrer" title="Variational 종목 화면 (주문은 직접 확인)">Variational ↗</a>${tvUrl?`<a class="trade-link neutral" href="${tvUrl}" target="_blank" rel="noopener noreferrer" title="TradingView 바이낸스 무기한 선물 차트">TradingView ↗</a>`:''}<a class="trade-link neutral" href="${links.binance}" target="_blank" rel="noopener noreferrer" title="Binance 선물 차트">Binance ↗</a>`;
}
function focusSignal(symbol){
 if(!app.marketMap.has(symbol)){toast('해당 종목이 현재 공통 상장 목록에 없습니다. 다시 조회해 주세요.',true);return}
 selectSymbol(symbol);document.getElementById('overview').scrollIntoView({behavior:'smooth'});
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
 const vals={diagUnique:f.uniqueAnalyzed,diagNoPattern:f.noPattern,diagPattern:f.patternCount,diagQuality:f.quality,diagVenue:f.venue,diagEntry:f.entry,diagReady:f.ready};
 for(const [id,value] of Object.entries(vals)){const el=$(id);if(el)el.textContent=Number(value||0).toLocaleString('ko-KR')+'종';}
 const el=$('diagReasons');if(el){
   const reasons=(f.topReasons||[]).slice(0,5);
   el.textContent=reasons.length?'주요 보류 사유: '+reasons.map(x=>`${x.reason} ${x.count}종`).join(' · '):'패턴 미발견 또는 진단 자료 집계 중';
 }
}
function setStatus(s){app.status=s;renderScanDiagnostics(s.scanFunnel);
 if(s.update)updateStatusText({...s.update,version:'5.8.0'});
 $('sysWS').textContent=s.ws==='connected'?'정상 연결':s.ws==='connecting'?'연결 중':'끊김 / 재접속';
 $('sysREST').textContent=s.rest==='connected'?'연결됨':s.rest==='connecting'?'연결 중':'접속 실패';
 const liveFresh=s.liveWS==='connected'&&s.lastLiveDataAt&&Date.now()-s.lastLiveDataAt<90000;
 const tickerFresh=s.ws==='connected'&&s.lastTickerAt&&Date.now()-s.lastTickerAt<90000;
 $('sysScan').textContent=(liveFresh?'봉 스트림 실제 수신 확인':'봉 스트림 연결/수신 대기')+' · '+Math.round(s.intervalMs/60000)+'분 간격 보완';
 $('sysScanHealth').textContent=(s.scanSuccess??0)+'건 성공 / '+(s.scanFailed??0)+'건 실패';
 $('sysScanErrors').textContent=(s.lastScanFailures||[]).slice(0,2).join(' | ')||'기록된 오류 없음';
 $('sysScanErrors').className='health-note';
 $('sysQuoteAge').textContent=s.lastTickerAt?Math.round((Date.now()-s.lastTickerAt)/1000)+'초 전 · '+(s.lastTickerCount||0)+'틱 수신':'실시간 틱 미수신';
 $('sysQuoteVAR').textContent=s.lastVariational?Math.round((Date.now()-s.lastVariational)/1000)+'초 전':'조회 전';
 $('sysNewsAge').textContent=s.newsChecked?Math.round((Date.now()-s.newsChecked)/1000)+'초 전':'조회 전';
 $('sysTG').textContent=s.telegramConfigured?'서버 설정 완료':'설정 필요';
 $('metricContracts').textContent=s.variational==='connected'?String(s.activeCount):s.researchCount?String(s.researchCount)+' (분석 전용)':'—';
 $('metricScanned').textContent=s.scannedTotal||0;
 $('metricLastScan').textContent=s.scanning?'분석 진행 중':(Math.max(s.lastLiveTrigger||0,s.lastScan||0))?clock(Math.max(s.lastLiveTrigger||0,s.lastScan||0)):'대기';
 $('coverageFoot').textContent=s.cycleScanned+'개 / 이번 순환 · 구독 대상 '+(s.liveWatched||0)+'개';
 $('scanProgress').textContent=s.scanning?'⟳ 실제 분석 중 · '+s.cycleScanned+'개 검사':s.scanMode==='research-only'?'◉ Binance 기술 스캔 중 · Variational 검증 대기(주문 불가)':s.scanMode==='verified-stale'?'◉ 기술 스캔 중 · 공통 상장 재검증 대기(주문 불가)':liveFresh?'● 봉 시세 실시간 수신 · 이벤트 분석 '+(s.liveAnalyzed||0)+'건':s.marketError?'⚠ 종목 조회 재시도 중':'⏳ 봉 스트림 수신 대기 · 자동 스캔 활성';
 $('scanFoot').textContent=(liveFresh?'실시간 봉 이벤트 정상':'실시간 봉 수신 대기')+' · 최근 스캔 성공 '+(s.scanSuccess||0)+'건 / 실패 '+(s.scanFailed||0)+'건' + (s.scanMode==='research-only'?' · 매매 시그널 보류':'');
 const alive=Boolean(tickerFresh&&Date.now()-s.lastTickerAt<30000);
 $('socketStatus').innerHTML=`<i class="dot ${alive?'green':s.rest==='connected'?'amber':'red'}"></i><span>${alive?'LIVE STREAM':s.rest==='connected'?'REST ONLY':'연결 대기'}</span>`;
 $('sysLiveHealth').textContent=liveFresh?Math.round((Date.now()-s.lastLiveDataAt)/1000)+'초 전 · 이벤트 분석 '+(s.liveAnalyzed||0)+'건':(s.liveLastError||'시세 구독 후 실제 봉 데이터 수신 대기');
 $('sysSubscriptions').textContent=(s.liveSubscribeAcks||0)+'개 ACK / '+(s.liveSubscribeErrors||0)+'개 오류';
 if(s.variational==='offline')banner('Variational 상장 목록 검증 실패',s.error||'공식 API 접속 불가 · 공통 종목 및 신호를 숨깁니다.');
 else if(s.error && (!s.activeCount||s.rest==='offline'))banner('시장 데이터 접속 오류',s.error+' · 서버에서 자동 재시도 중입니다.');
 else if(s.rest==='connected'&&s.variational==='connected')clearBanner();
 app.watchlist=s.watchlist||app.watchlist;
 if(s.newsChecked && !app.newsMeta)loadNews();
 $('execLimits').textContent=`허용 스프레드 ≤${s.executionLimits?.maxSpreadBps??20}bp · 불리한 가격차 ≤${s.executionLimits?.maxAdverseVenueBps??35}bp · 호가 나이 ≤${s.executionLimits?.maxQuoteAgeSeconds??180}초 · 보류 신호 ${s.blockedSignals||0}건`;
 $('sysVAR').textContent=s.variational==='connected'?'공통 종목 검증 완료':s.researchCount?'검증 대기 · 기술분석만 '+s.researchCount+'종':'검증 실패 / 재시도';
 $('matchVerified').textContent=s.variational==='connected'?(s.activeCount+'종목 교집합 확인 · '+dateClock(s.lastVariational)+' KST'):'Variational 공통 상장 정보 확인 대기 · 미검증 종목 숨김';
}
function setExecutionView(x){
 const e=$('executionVerdict');
 if(!x){e.className='execution-banner blocked';e.textContent='현재 공개 호가 확인 불가 · 신호 알림 제한';['execBidAsk','execSpread','execCost','execVenue','execMark','execFunding','execFundingTime','execQuoteTime'].forEach(id=>$(id).textContent='—');return}
 e.className='execution-banner '+(x.eligible?'good':'blocked');
 e.textContent=x.eligible?'✓ 참고 호가 필터 통과 · 주문 실행 전 실제 호가 필수 확인':'⚠ 진입 보류: '+(x.reasons?.join(' · ')||'데이터 미확인');
 $('execBidAsk').textContent=fmt(x.bid)+' / '+fmt(x.ask);
 $('execQuoteTime').textContent=x.quoteUpdatedAt?'호가 기준 '+dateClock(x.quoteUpdatedAt)+' KST · '+Math.round(x.quoteAgeSeconds||0)+'초 경과':'호가 갱신 시각 없음';
 $('execSpread').textContent=x.spreadBps==null?'—':(x.spreadBps.toFixed(2)+' bp');
 $('execCost').textContent=x.spreadCostUSD==null?'실거래 비용 산출 불가':'명목 '+money(x.notional)+' 기준 가정 왕복 '+money(x.spreadCostUSD);
 $('execVenue').textContent=x.adverseVenueBps==null?'—':x.adverseVenueBps.toFixed(1)+' bp';
 $('execMark').textContent=x.markVsBinanceBps==null?'가격 비교 불가':'Mark / Binance 차이 '+x.markVsBinanceBps.toFixed(1)+' bp';
 $('execFunding').textContent=x.fundingOneIntervalUSD==null?'—':(x.fundingOneIntervalUSD>=0?'-'+money(x.fundingOneIntervalUSD):'+'+money(-x.fundingOneIntervalUSD));
 $('execFundingTime').textContent=x.fundingIntervalRate==null?'공개 펀딩 데이터 없음':`현재 구간 ${((x.fundingIntervalSeconds||0)/3600).toFixed(0)}시간 · ${((x.fundingIntervalRate||0)*100).toFixed(4)}%/회 (변동 가능)`;
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
function applyMarket({markets,research=[],watchlist}){
 if(!Array.isArray(markets))return;
 const before=app.symbol;
 app.market=markets;
 // Research-only Binance markets are shown as non-tradable observations when
 // Variational metadata is unavailable. They can NEVER create order links.
 app.marketMap=new Map([...research.filter(x=>!markets.some(m=>m.symbol===x.symbol)).map(m=>[m.symbol,{...m,researchOnly:true}]),...markets.map(m=>[m.symbol,{...m,researchOnly:false}])]);
 updateJournalSymbols();
 if(watchlist)app.watchlist=watchlist.filter(x=>markets.some(m=>m.symbol===x));
 // Viewing a public TradingView chart does NOT require exchange listing verification.
 // Preserve the selected chart symbol while market metadata is loading or offline.
 // The order links, analysis, scanner and alerts remain restricted to verified matches.
 app.signals=app.signals.filter(x=>app.marketMap.has(x.symbol));
 app.patterns=app.patterns.filter(x=>app.marketMap.has(x.symbol));
 app.watch=app.watch.filter(x=>app.marketMap.has(x.symbol));
 app.alerts=app.alerts.filter(x=>app.marketMap.has(x.symbol));
 if(app.symbol!==before){app.analysis=null;app.candles=[];
   if(app.marketMap.has(app.symbol)){loadChart();loadAnalysis()}
   else renderAnalysis();
 }
 renderWatch();renderPair();renderSignals();renderRecentCoverage();renderAlerts();renderMatched();loadExecution();renderTradingView();
}
function renderWatch(){
 const symbols=app.watchlist.filter(x=>app.marketMap.has(x));
 $('watchlist').innerHTML=symbols.length?symbols.map(symbol=>{
  const m=app.marketMap.get(symbol),change=Number(m.change)||0,base=m.baseAsset;
  return `<button class="watchrow ${app.symbol===symbol?'selected':''}" data-symbol="${escapeHtml(symbol)}"><span class="watch-logo">${escapeHtml(base.slice(0,2))}</span><span class="watch-info">${escapeHtml(base)}<small>${escapeHtml(m.variational.ticker)} · BINANCE ${escapeHtml(symbol)}</small></span><span class="watch-change ${change>=0?'positive':'negative'}">${pct(change)}</span></button>`;
 }).join(''):'<div class="tiny-muted">공통 상장 종목 확인 전이거나 등록된 관심 종목이 없습니다.</div>';
 document.querySelectorAll('.watchrow').forEach(b=>b.addEventListener('click',()=>selectSymbol(b.dataset.symbol)));
}
function renderPair(){
 const base=app.symbol.replace('USDT',''),m=app.marketMap.get(app.symbol)||{};
 $('pairName').textContent=app.symbol||'BTCUSDT';
 $('assetLogo').textContent=base==='BTC'?'₿':base==='ETH'?'Ξ':base==='SOL'?'◎':base?base.slice(0,2):'—';
 $('assetLogo').style.background=base==='BTC'?'#db9b39':base==='ETH'?'#8299ca':base==='SOL'?'#7d78b4':'#41799c';
 $('pairPrice').textContent=fmt(m.price);$('pairChange').textContent='24H '+(m.price?pct(m.change||0):'—');
 $('pairChange').className='change '+(Number(m.change)>0?'positive':Number(m.change)<0?'negative':'neutral');
 const v=m.variational;
 $('pairCompare').textContent=v?`VARIATIONAL ${v.ticker} · MARK ${fmt(v.markPrice)} USDC · ${dateClock(app.status?.lastVariational)} KST (주기적 갱신)`:'TradingView 차트 열람 가능 · Variational 공통 PERP 미검증 (주문 신호 차단)';
 $('pairTradeLinks').innerHTML=linkButtons(app.symbol);
}
let matchedPage=0;
function renderMatched(){
 const query=($('marketSearch').value||'').trim().toUpperCase();
 const arr=app.market.filter(x=>!query||x.symbol.includes(query)||x.baseAsset.includes(query)||x.variational?.ticker.includes(query));
 const size=25,pages=Math.max(1,Math.ceil(arr.length/size));matchedPage=Math.min(matchedPage,pages-1);
 const list=arr.slice(matchedPage*size,(matchedPage+1)*size);
 $('matchedCount').textContent=`${arr.length} / ${app.market.length} 종목`;
 $('matchPage').textContent=arr.length?`${matchedPage+1} / ${pages}`:'0 / 0';
 $('matchPrev').disabled=matchedPage<=0;$('matchNext').disabled=matchedPage>=pages-1;
 $('matchedBody').innerHTML=list.length?list.map(m=>{
  const v=m.variational||{};
  return `<tr><td>${escapeHtml(m.baseAsset)}</td><td class="monospace">${escapeHtml(m.symbol)}</td><td class="monospace">${escapeHtml(v.ticker||'')}</td><td class="monospace">${fmt(m.price)}</td><td class="monospace">${fmt(v.markPrice)}</td><td class="monospace">${compact(m.quoteVolume)}</td><td><div class="action-stack"><button class="table-link" data-pair="${escapeHtml(m.symbol)}">내 차트 ↗</button>${linkButtons(m.symbol)}</div></td></tr>`
 }).join(''):'<tr><td colspan="7" class="table-empty">공통 상장 종목이 없거나 공식 API 검증이 진행 중입니다. 미검증 종목은 표시하지 않습니다.</td></tr>';
 document.querySelectorAll('[data-pair]').forEach(btn=>btn.addEventListener('click',()=>{selectSymbol(btn.dataset.pair);document.getElementById('overview').scrollIntoView({behavior:'smooth'})}));
}
function levelRows(levelArr,side){return levelArr?.length?levelArr.map((p,i)=>`<div class="level-row ${side==='res'?'res':''}"><strong>${fmt(p.price)}</strong><span>${escapeHtml(p.source||'1h')} · ${i===0?'가장 가까움':'추가 레벨'}</span></div>`).join(''):'<div class="empty-small">확인된 피벗 구간 없음</div>'}
function renderAnalysis(){const a=app.analysis;
 if(!a||a.status==='insufficient'){$('analysisTag').textContent='분석 대기';$('analysisTrend').textContent='—';$('supports').innerHTML='<div class="empty-small">분석할 봉 데이터 부족</div>';$('resistances').innerHTML='<div class="empty-small">분석할 봉 데이터 부족</div>';$('currentCandidate').innerHTML='<div class="empty-small">분석된 유효 진입 지점이 없습니다.</div>';return}
 $('analysisTag').textContent=a.status==='signal'?'확정 패턴 · 매매 검증 통과':a.patternConfirmed?'차트 패턴 확정 · 진입 보류':a.status==='watch'?'패턴 조건 관찰 중':'대기 / 확인 중';
 $('analysisTrend').textContent=a.trend==='up'?'▲ 상승 추세':a.trend==='down'?'▼ 하락 추세':'━ 중립 / 횡보';$('analysisTrend').className=a.trend==='up'?'positive':a.trend==='down'?'negative':'';
 $('supports').innerHTML=levelRows(a.supports,'sup');$('resistances').innerHTML=levelRows(a.resistances,'res');
 $('volRatio').textContent=a.volumeRatio?.toFixed(2)+'x';$('atrValue').textContent=fmt(a.atr);
 const ready=app.signals.some(x=>x.symbol===a.symbol&&x.time===a.time&&x.pattern===a.pattern);
 const currentMarket=app.marketMap.get(a.symbol);
 const plan=tradePlan(a);
 const timing=entryTiming(a,{price:currentMarket?.price,priceAt:currentMarket?.priceAt,venueReady:ready});
 const vx=a.execution;
 const qualityInfo=a.quality?.checks?.length?`<div class="quality-checks"><h4>엄격 검증 체크리스트 · 승률 예측이 아님</h4>${a.quality.checks.map(c=>`<div class="quality-row"><span class="${c.passed?'quality-ok':'quality-bad'}">${c.passed?'✓':'✕'}</span><span>${escapeHtml(c.label)}</span><small>${escapeHtml(String(c.value??''))}</small></div>`).join('')}</div>`:'';
 const execInfo=vx?`<div class="signal-check ${vx.eligible?'':'blocked'}">${vx.eligible?'Variational 공개 호가 검증 통과':'Variational 비용/신선도 검증 보류'}<small>${escapeHtml(vx.reasons?.join(' · ')||'상세는 체결비용 검증 패널 참고')} · 추정 왕복 비용 ${vx.spreadCostUSD==null?'미확인':money(vx.spreadCostUSD)} · 명목 ${money(vx.notional)} · 펀딩 별도</small></div>`:'';
 const tps=plan?`<div class="tradeplan-box"><strong class="tradeplan-label">3단계 분할 익절 · 가상 계획</strong><div class="tp-columns">${plan.targets.filter(Boolean).map(t=>`<div class="tp-target"><span>${t.name} (${t.multiple}R) · ${t.reducePct}% 청산</span><strong>${fmt(t.price)}</strong><small>가격 변화 +${t.movePct.toFixed(2)}% ${t.estimatedPartProfitUSD!=null?' · 해당 물량 예상 +'+money(t.estimatedPartProfitUSD):''}</small><small>남은 물량 ${t.remainingPct}%</small></div>`).join('')}</div><p class="tradeplan-caution">전량 각 목표 체결을 가정한 총 이론수익 ${plan.projectedGrossUSD!=null?'+'+money(plan.projectedGrossUSD):'금액 미확인'} · 가중 손익비 ${plan.weightedR.toFixed(2)}R · 모든 비용·슬리피지·펀딩 제외. 1차 익절 뒤 나머지 손절 조정은 자동 수행하지 않습니다.</p></div>`:'';
 const timingBlock=plan?`<div class="timing-card ${timing.actionable?'timing-ready':'timing-wait'}"><div class="timing-title">진입 시점 체크 <strong>${escapeHtml(timing.label)}</strong></div><p>${escapeHtml(timing.detail)}</p><p><b>${escapeHtml(a.direction)} 관찰 가격 구간: ${fmt(timing.zoneLow)} ~ ${fmt(timing.zoneHigh)}</b></p><p class="timing-condition">확정 1시간봉 + 4시간봉 추세 + 최신 시세 + Variational 호가/비용을 확인해야 합니다. 신규 진입은 추격하지 않고 구간 재접근을 관찰합니다.</p></div>`:'';
 $('currentCandidate').innerHTML=a.pattern?`<div class="signal-heading"><span class="dir ${a.direction==='LONG'?'long':'short'}">${a.direction}</span><span class="subtle-tag">규칙 충족 ${a.score}/100 (승률 아님)</span></div><div class="signal-pattern">${escapeHtml(a.pattern)} ${ready?'· 진입 검증 통과':a.patternConfirmed?'· 차트 확정 / 매매 보류':'· 추가 확인 필요'}</div><div class="signal-comment">${escapeHtml(a.reason)} · 차트 기준 진입가를 실제 Variational 확정 주문 가격으로 오해하지 마세요.</div><div class="signal-grid"><div><span>진입 기준가</span><strong>${fmt(a.entry)}</strong></div><div><span>손절 무효화</span><strong>${fmt(a.stop)}</strong></div><div><span>손절 거리 (가격 기준)</span><strong>${plan?plan.riskPct.toFixed(2)+'%':'—'}</strong></div><div><span>계획 명목 포지션</span><strong>${money(a.risk?.nominal)}</strong></div></div>${qualityInfo}${timingBlock}${tps}${execInfo}`:'<div class="empty-small">현재 확정된 진입 신호 없음. 1H 구조·4H 추세·거래량·2R 목표를 함께 검사 중입니다.</div>';
}
function scanPagination(hostId,infoId,paged,onPage){
 const host=$(hostId),info=$(infoId);if(!host)return;
 if(info)info.textContent=paged.total?`${paged.total}건 중 ${paged.start+1}~${paged.end}건 · ${paged.page}/${paged.pages}페이지`:'0건 · 1/1페이지';
 const buttons=[{label:'이전',page:paged.page-1,disabled:paged.page===1},...scanPageWindow(paged.page,paged.pages).map(n=>({label:String(n),page:n,selected:n===paged.page})),{label:'다음',page:paged.page+1,disabled:paged.page===paged.pages}];
 host.innerHTML=buttons.map(b=>`<button type="button" data-scan-page="${b.page}" ${b.disabled?'disabled':''} ${b.selected?'aria-current="page"':''} class="${b.selected?'active':''}" aria-label="${b.label==='이전'||b.label==='다음'?b.label+' 페이지':b.label+' 페이지'}">${b.label}</button>`).join('');
 host.querySelectorAll('button:not(:disabled)').forEach(b=>b.addEventListener('click',()=>onPage(Number(b.dataset.scanPage))));
}
function renderRecentCoverage(){
 const host=$('scanRecentList');if(!host)return;
 const paged=paginateScan((app.recent||[]).slice(0,24),app.recentPage);
 app.recentPage=paged.page;
 const rows=paged.items;
 scanPagination('scanRecentPager','scanRecentPageInfo',paged,page=>{app.recentPage=page;renderRecentCoverage()});
 host.innerHTML=rows.length?rows.map(x=>{
  const market=app.marketMap.get(x.symbol)||{};
  const verified=Boolean(market.variational)&&app.status?.variational==='connected';
  const stage=x.status==='insufficient'?'캔들 부족':!x.pattern?'분석 완료 · 패턴 없음':!x.quality?.passed?'패턴 발견 · 기술조건 미달':!verified?'패턴 발견 · Variational 미검증':x.status==='signal'&&x.qualified?'최종 진입 검증 통과':'패턴 발견 · 호가/진입 보류';
  return `<button type="button" class="scan-recent-item" data-recent-symbol="${escapeHtml(x.symbol)}"><strong>${escapeHtml(x.symbol)}</strong><span>${escapeHtml(stage)}</span><small>기술 점수 ${Number(x.score||0)} · ${clock(x.scannedAt)} · ${verified?'공통 상장':'주문 검증 전'}</small></button>`;
 }).join(''):'<div class="empty-small">아직 분석된 종목 없음. 스캔 성공 건수와 API 연결을 확인하세요.</div>';
 host.querySelectorAll('button[data-recent-symbol]').forEach(b=>b.addEventListener('click',()=>{selectSymbol(b.dataset.recentSymbol);document.getElementById('chartPanel').scrollIntoView({behavior:'smooth'})}));
}
function renderObservations(){
 const displays=[{items:app.structures,page:'structurePage',list:'structureList',pager:'structurePager',info:'structurePageInfo',historic:false},
  {items:app.history,page:'historyPage',list:'historyList',pager:'historyPager',info:'historyPageInfo',historic:true}];
 for(const g of displays){
  const paged=paginateScan(g.items,g.page===undefined?1:app[g.page]);app[g.page]=paged.page;
  scanPagination(g.pager,g.info,paged,page=>{app[g.page]=page;renderObservations()});
  const host=$(g.list);if(!host)continue;
  host.innerHTML=paged.items.length?paged.items.map(x=>{
   const symbol=escapeHtml(x.symbol||'');const direction=x.direction==='LONG'?'LONG':'SHORT';
   const title=g.historic?x.pattern:x.kind;
   const mark=g.historic?x.confirmedAt:x.observedAt;
   const quote=g.historic?'당시 확정가 '+fmt(x.entry):'기준가격 '+fmt(x.referencePrice)+' · 최근 봉 '+fmt(x.close);
   const tv=/^[A-Z0-9]{3,25}$/.test(x.symbol||'')?`<a href="https://www.tradingview.com/chart/?symbol=BINANCE%3A${encodeURIComponent(x.symbol)}.P" target="_blank" rel="noopener noreferrer">TradingView 차트 ↗</a>`:'';
   return `<div class="scan-observation-item"><div><span class="dir ${direction==='LONG'?'long':'short'}">${direction} 관찰</span> <strong>${symbol} · ${escapeHtml(title)}</strong><small>${dateClock(mark)} KST · ${quote}</small><p>${escapeHtml(x.detail||'')}</p></div><div>${tv}<em>매매/알림 불가</em></div></div>`;
  }).join(''):`<div class="empty-small">${g.historic?'최근 24시간의 해당 확정 패턴 기록이 없습니다.':'현재 1시간봉이 지정한 주요 가격구간에 접근한 관찰 후보가 없습니다.'} 데이터 수신과 고유 종목 검사 건수를 확인하세요.</div>`;
 }
}
function results(){return app.showWatch?app.watch:app.patterns}
function renderSignals(){
 const filter=$('signalFilter').value;
 let data=filter==='watch'?app.watch:filter==='ready'?app.signals:results();
 if(filter==='LONG'||filter==='SHORT')data=data.filter(x=>x.direction===filter);
 data=data.filter(x=>x?.symbol&&app.marketMap.has(x.symbol)).sort((a,b)=>(b.patternConfirmedAt||0)-(a.patternConfirmedAt||0)||(b.score||0)-(a.score||0));
 $('metricSignals').textContent=app.patterns.length;
 $('navSignalCount').textContent=app.patterns.length;
 $('signalFoot').textContent=`확정 ${app.patterns.length}건 중 주문 검증 통과 ${app.signals.length}건`;
 const paged=paginateScan(data,app.signalPage,SCAN_PAGE_SIZE);
 app.signalPage=paged.page;
 scanPagination('scanPageControls','scanPageInfo',paged,page=>{app.signalPage=page;renderSignals()});
 $('signalsBody').innerHTML=data.length?paged.items.map(a=>{
   const change=app.marketMap.get(a.symbol)?.change??a.priceChangePercent??0;
   const mPrice=app.marketMap.get(a.symbol)?.price||a.price;
   const latest=browserAlertState(a);
   const invalidated=a.patternInvalidated||(a.direction==='LONG'?mPrice<=a.stop:mPrice>=a.stop);
   const ready=!invalidated&&latest.cls==='live'&&app.signals.some(s=>s.symbol===a.symbol&&s.pattern===a.pattern&&s.time===a.time);
   const expiredOrHit=['유효기간 경과','1차 목표 구간 도달','손절 무효화'].includes(latest.text);
   const unverified=!app.marketMap.get(a.symbol)?.variational || app.status?.variational!=='connected';
   const label=unverified?'⚠ Binance 패턴 관찰 · Variational 주문 검증 전':invalidated?'✕ 손절 무효화 · 진입 금지':ready?'● 진입 검증 통과':expiredOrHit?'✕ '+latest.text:a.patternConfirmed?(a.technicalQualified===false?'◆ 패턴 발견 · 기술 조건 미달':'◆ 패턴 확인 · 거래 검증 보류'):'○ 패턴 관찰 중';
   const cls=unverified||invalidated||expiredOrHit?'pattern-invalid':ready?'pattern-ready':a.patternConfirmed?'pattern-held':'pattern-watch';
   const qualityProblems=(a.quality?.failed||[]).join(' · ');
   const venueProblems=(a.execution?.reasons||[]).slice(0,2).join(' · ');
   const detail=a.patternConfirmed?`1H 마감 ${dateClock(a.patternConfirmedAt)} KST · 손절 ${fmt(a.stop)}${qualityProblems?' · 기술 미달: '+escapeHtml(qualityProblems):venueProblems?' · 호가 보류: '+escapeHtml(venueProblems):''}`:escapeHtml(a.reason||'');
   const plan=tradePlan(a);
   const onMarket=app.marketMap.get(a.symbol);
   const timing=entryTiming(a,{price:onMarket?.price,priceAt:onMarket?.priceAt,venueReady:ready});
   const tpCell=plan?`<div class="tp-list">${plan.targets.filter(Boolean).map(t=>`<div class="tp-line"><b>${t.name} ${fmt(t.price)}</b><span>${t.reducePct}% 청산 · +${t.movePct.toFixed(2)}%</span></div>`).join('')}<small>비용 제외 · 총 ${plan.weightedR.toFixed(2)}R (전량 목표 도달 가정)</small></div>`:'<span class="quiet">계산 불가</span>';
   return `<tr><td>${escapeHtml(a.symbol)}</td><td class="monospace">${fmt(onMarket?.price||a.price)}</td><td class="monospace ${change>=0?'positive':'negative'}">${pct(change)}</td><td><span class="dir ${a.direction==='LONG'?'long':'short'}">${a.direction}</span><strong style="display:block;color:#cfdeef;margin-top:6px;font-size:11px">${escapeHtml(a.pattern)}</strong><span class="pattern-detail">${detail}</span></td><td><span class="pattern-label ${cls}">${label}</span><div style="font-size:10px;color:#849cb2;margin-top:6px">규칙 충족 ${a.score||0}/100 · 승률 아님 · 거래량 ${Number(a.volumeRatio||0).toFixed(2)}x</div></td><td><div class="entry-timing ${timing.actionable?'entry-now':'entry-wait'}"><strong>${escapeHtml(timing.label)}</strong>${plan?`<div class="monospace">${fmt(timing.zoneLow)} ~ ${fmt(timing.zoneHigh)}</div>`:''}<small>${escapeHtml(timing.detail)}</small></div></td><td>${tpCell}</td><td class="monospace" style="font-size:10px">${fmt(a.supports?.[0]?.price)} / ${fmt(a.resistances?.[0]?.price)}</td><td class="monospace" style="font-size:10px">${clock(a.scannedAt)}</td><td><div class="action-stack"><button class="table-link" data-symbol="${escapeHtml(a.symbol)}">진입·익절 상세 ↗</button><button class="table-link" data-journal="${escapeHtml(a.symbol)}">매매일지에 입력 ↗</button>${linkButtons(a.symbol)}</div></td></tr>`;
 }).join(''):`<tr><td colspan="10" class="table-empty">${filter==='watch'?'현재 발견된 패턴 중 검증이 보류된 종목 없음':filter==='ready'?'현재 1시간 확정·4시간 추세·Variational 비용 검증까지 통과한 진입 후보 없음':'최근 2시간 내 확인된 1시간봉 패턴이 없습니다. 위의 스캔 진단에서 고유 종목 수와 단계별 탈락 건수를 확인하세요.'}</td></tr>`;
 document.querySelectorAll('#signalsBody button[data-symbol]').forEach(b=>b.addEventListener('click',()=>focusSignal(b.dataset.symbol)));
 document.querySelectorAll('#signalsBody button[data-journal]').forEach(b=>b.addEventListener('click',()=>fillJournalFromSignal(b.dataset.journal)));
 $('scanSummary').textContent=`${app.status?.scanMode==='research-only'?'Binance 기술 스캔 중 · Variational 검증 전 주문 금지 · ':''}패턴 발견 ${app.patterns.length}종 · 최종 진입 검증 ${app.signals.length}종 · 관찰 후보 ${app.watch.length}종 · 기술 조건 미달 ${app.status?.scanFunnel?.quality??'—'}종`; 
 $('showWatchButton').textContent=app.showWatch?'확정 패턴으로 돌아가기 →':'진입 검증 통과만 보기 →';
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
function renderAlerts(){const alerts=(app.alerts||[]).filter(x=>app.marketMap.has(x.symbol));$('alertCount').textContent=alerts.length+'건';$('alertsList').innerHTML=alerts.length?alerts.slice(0,30).map(a=>{
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
 const warn=loss>6||loss>12-(app.journalSummary?.stopRiskOpen||0);
 box.className='journal-preview'+(warn?' warn':'');
 box.textContent=`계획상 손절 손실 $${loss.toFixed(2)} · 초기 증거금 약 $${margin.toFixed(2)} · 계좌 대비 ${(loss/1000*100).toFixed(2)}%${pnl!=null?' · 입력 청산가 기준 실현손익 $'+pnl.toFixed(2):''}${warn?' · ⚠ $6/거래 또는 열린 포지션 합산 $12 위험 한도 초과':''}. 실제 슬리피지·청산 위험은 별도입니다.`;
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
 const danger=j.dayExceeded||j.weekExceeded||j.stopRiskOpen>12;
 $('journalRiskBanner').className='journal-risk-banner'+(danger?' warn':'');
 $('journalRiskBanner').textContent=danger?'⚠ 직접 입력한 기록 기준 위험 예산 초과: '+(j.dayExceeded?'오늘 실현손실 $15 이상 · ':'')+(j.weekExceeded?'이번 주 실현손실 $40 이상 · ':'')+(j.stopRiskOpen>12?'열린 포지션 합산 계획 위험 $12 초과 · ':'')+'신규 진입 전 확인하세요. 자동매매 차단 기능은 아닙니다.':'기록상 오늘 -$15 / 주간 -$40 / 동시 계획 위험 $12를 기준으로 경고합니다. 누락 거래·미실현손익은 제외됩니다.';
 $('journalList').innerHTML=app.journal.length?app.journal.slice(0,50).map(t=>`<div class="journal-record"><div class="journal-record-title"><span>${escapeHtml(t.symbol)} · ${t.side}</span><span class="${t.realizedPnLUSD>0?'journal-pnl-positive':t.realizedPnLUSD<0?'journal-pnl-negative':''}">${t.status==='OPEN'?'진행 중':cur(t.realizedPnLUSD)}</span></div><p>진입 ${fmt(t.entry)} · 손절 ${fmt(t.stop)} · ${t.status==='CLOSED'?'청산 '+fmt(t.exit)+' · ':''}명목 ${cur(t.notional)} · ${t.leverage}x<br>계획 손절 ${cur(t.stopRiskUSD)} · 기록된 비용 ${cur(t.fees)} · 펀딩 ${cur(t.funding)}</p><small>${dateClock(t.createdAt)} KST · ${escapeHtml(t.note||'메모 없음')}</small><div class="journal-record-actions">${t.status==='OPEN'?`<button data-close="${escapeHtml(t.id)}">청산 기록</button>`:''}<button data-delete="${escapeHtml(t.id)}">삭제</button></div></div>`).join(''):'<div class="empty-small">저장된 거래 기록이 없습니다. 수동으로 입력하거나 시그널에서 ‘매매일지에 입력’을 사용하세요.</div>';
 document.querySelectorAll('#journalList [data-close]').forEach(b=>b.addEventListener('click',()=>{closingTradeId=b.dataset.close;$('closeTradePrice').value='';$('closeTradeFee').value='0';$('closeTradeFunding').value='0';$('closeTradeError').textContent='';$('closeTradeDialog').showModal()}));
 document.querySelectorAll('#journalList [data-delete]').forEach(b=>b.addEventListener('click',async()=>{if(!confirm('이 수동 거래 기록을 삭제할까요?'))return;try{await json('/api/journal/delete',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:b.dataset.delete})});await loadJournal();toast('삭제 완료')}catch(e){toast('삭제 실패: '+e.message,true)}}));
 calcJournalPreview();
}
async function loadJournal(){try{const data=await json('/api/journal');app.journal=data.entries||[];app.journalSummary=data.summary;renderJournal()}catch(e){toast('매매일지 조회 실패: '+e.message,true)}}
let closingTradeId='';
async function saveJournal(e){e.preventDefault();if(!app.marketMap.has($('journalSymbol').value)){toast('상장 목록이 확인되지 않았습니다.',true);return}try{const body=journalFormData();await json('/api/journal',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});$('journalForm').reset();await loadJournal();toast('수동 매매 기록 저장 완료')}catch(e){toast('저장 실패: '+e.message,true)}}
async function closeJournalTrade(){try{await json('/api/journal/close',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:closingTradeId,exit:$('closeTradePrice').value,fees:$('closeTradeFee').value,funding:$('closeTradeFunding').value})});$('closeTradeDialog').close();await loadJournal();toast('수동 청산 기록 완료')}catch(e){$('closeTradeError').textContent=e.message}}
// Public TradingView chart is independent of Variational/Binance overlap verification.
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
 const access=tradingViewAccess(symbol,app.interval,verified);
 const url=access.chartUrl;
 // Viewing a chart is safe while validation is pending; trading is not.
 for(const id of ['tvExternalLink','tvFallbackLink']){
   const node=$(id);node.href=url||'https://www.tradingview.com/chart/';node.setAttribute('aria-disabled',url?'false':'true');
 }
 $('chartAccessStatus').textContent=verified?'✓ 공통 PERP 검증 완료 · Variational 주문창 이동 가능':'차트 조회 전용 · Variational 공통 상장 검증 전 (주문/신호 보류)';
 $('chartAccessStatus').classList.toggle('verified',verified);
 $('tvSymbolInput').value=symbol;
 if(!tvMode){app.tvLoadedKey='';tvHost.replaceChildren();if(verified)loadChart();else{
   $('chartOverlay').classList.remove('hidden');
   $('chartOverlay').textContent='자체 분석 차트는 공통 PERP 검증 이후 이용할 수 있습니다. TradingView 모드에서는 지금 차트를 볼 수 있습니다.';
 }return}
 $('chartOverlay').classList.add('hidden');
 $('chartUpdated').textContent=verified?'TRADINGVIEW · BINANCE PERP · 공통 검증 완료':'TRADINGVIEW · BINANCE PERP · 차트 전용';
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
 renderTradingView();renderPair();renderWatch();renderAnalysis();renderNews();loadExecution();
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
 if(!symbol||!app.marketMap.has(symbol)){toast('Variational·Binance 공통 PERP가 아닌 종목입니다.',true);return}
 app.symbol=symbol;localStorage.setItem('sl-symbol',symbol);renderTradingView();renderNews();history.replaceState(null,'',`${location.pathname}?symbol=${encodeURIComponent(symbol)}${location.hash}`);app.analysis=null;renderPair();renderWatch();renderAnalysis();loadExecution();
 await Promise.allSettled([loadChart(),loadAnalysis()]);
}
async function loadAnalysis(){const symbol=app.symbol;if(!symbol||!app.marketMap.has(symbol))return;try{const result=await json('/api/analyze?symbol='+encodeURIComponent(symbol));if(app.symbol!==symbol)return;app.analysis=result;renderAnalysis();drawChart()}catch(e){if(app.symbol===symbol){toast('분석 실패: '+e.message,true);$('analysisTag').textContent='연결 오류'}}}
function parseRows(rows){return (rows||[]).map(r=>({time:Number(r[0]),open:Number(r[1]),high:Number(r[2]),low:Number(r[3]),close:Number(r[4]),volume:Number(r[5]),closed:Number(r[6])<Date.now()})).filter(x=>[x.time,x.open,x.high,x.low,x.close].every(Number.isFinite)).sort((a,b)=>a.time-b.time)}
async function loadChart(){if(app.chartMode!=='basic')return;const symbol=app.symbol,interval=app.interval;if(!symbol||!app.marketMap.has(symbol))return;app.chartLoading=true;$('chartOverlay').classList.remove('hidden');$('chartOverlay').textContent='실제 캔들 데이터를 불러오는 중…';
 try{const data=await json(`/api/klines?symbol=${encodeURIComponent(symbol)}&interval=${interval}`);if(app.symbol!==symbol||app.interval!==interval)return;app.candles=parseRows(data.rows);$('chartOverlay').classList.add('hidden');$('chartUpdated').textContent='BINANCE · '+clock(Date.now())+' KST';drawChart()}
 catch(e){if(symbol===app.symbol&&interval===app.interval){app.candles=[];$('chartOverlay').textContent='캔들 데이터 연결 실패: '+e.message;toast('차트 데이터 오류: '+e.message,true)}}
 finally{app.chartLoading=false}
}
function ema(arr,period){let v=arr[0]||0,coef=2/(period+1);return arr.map(c=>(v=coef*c+(1-coef)*v))}
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
 if($('showEMA').checked){const closes=c.map(x=>x.close);[[20,'#5ca7f8'],[50,'#efb66d']].forEach(([n,color])=>{const seq=ema(closes,n);ctx.beginPath();ctx.strokeStyle=color;ctx.lineWidth=1.35;seq.forEach((p,i)=>{const x=chartL+(i+.5)*candleWidth;if(i===0)ctx.moveTo(x,y(p));else ctx.lineTo(x,y(p))});ctx.stroke()})}
 const market=selectedPrice();if(market>lo&&market<hi){ctx.beginPath();ctx.setLineDash([2,4]);ctx.strokeStyle='#8cb9e5';ctx.moveTo(chartL,y(market));ctx.lineTo(chartR,y(market));ctx.stroke();ctx.setLineDash([]);ctx.fillStyle='#1d5374';ctx.fillRect(chartR,y(market)-10,75,18);ctx.fillStyle='#d5eeff';ctx.fillText(fmt(market),chartR+6,y(market)+3)}
 if(app.hover>=0&&app.hover<c.length){const idx=app.hover,X=chartL+(idx+.5)*candleWidth;ctx.strokeStyle='#7893aa';ctx.setLineDash([3,3]);ctx.beginPath();ctx.moveTo(X,chartT);ctx.lineTo(X,chartB);ctx.stroke();ctx.setLineDash([])}
 app.chartGeom={left:chartL,right:chartR,step:candleWidth,len:c.length,candles:c};
}
function onQuote(arr){let selectedChanged=false;for(const [symbol,price] of arr){const q=app.marketMap.get(symbol);if(q){q.price=Number(price);q.priceAt=Date.now();if(symbol===app.symbol)selectedChanged=true}}
 if(selectedChanged){renderPair();drawChart();if(Date.now()-(app.lastTimingRender||0)>5000){renderAnalysis();app.lastTimingRender=Date.now()}}
 const now=Date.now();if(now-(app.lastWatchRender||0)>6000){renderWatch();renderSignals();renderAlerts();app.lastWatchRender=now}
}
let audioContext;
function ping(){try{audioContext??=new(window.AudioContext||window.webkitAudioContext)();const osc=audioContext.createOscillator(),g=audioContext.createGain();osc.frequency.value=880;g.gain.setValueAtTime(.0001,audioContext.currentTime);g.gain.exponentialRampToValueAtTime(.12,audioContext.currentTime+.02);g.gain.exponentialRampToValueAtTime(.0001,audioContext.currentTime+.35);osc.connect(g);g.connect(audioContext.destination);osc.start();osc.stop(audioContext.currentTime+.38)}catch{}}
function notify(alert,{test=false}={}){if(!app.marketMap.has(alert.symbol))return;signalToast(alert);ping();
 if('Notification' in window&&Notification.permission==='granted'){try{const n=new Notification(`${test?'[테스트 알림] ':''}${alert.symbol} ${alert.direction} · ${alert.pattern}`,{body:`진입 ${fmt(alert.entry)} / 손절 ${fmt(alert.stop)} / 목표 ${fmt(alert.target1)} | 클릭하면 Variational 거래 화면`,tag:alert.id||alert.symbol});n.onclick=()=>{window.focus();const url=externalLinks(alert.symbol)?.variational;if(url)window.open(url,'_blank','noopener,noreferrer');else focusSignal(alert.symbol);n.close()}}catch{}}
}
function renderNews(){
 const type=$('newsFilter').value,query=$('newsSearch').value.trim().toLowerCase(),coin=app.symbol.replace(/USDT$/,'');
 const rows=app.news.filter(n=>{
  if(type==='coin'&&!n.symbols?.includes(coin))return false;
  if(type==='tradfi'&&!n.symbols?.some(s=>['XAU','XAG','US100','US500','US30','DXI','UKOIL','USOIL'].includes(s))&&!/CNBC/.test(n.source))return false;
  if(type==='market'&&n.impact!=='high')return false;
  if((type==='risk'||type==='opportunity')&&n.tone!==type)return false;
  if(query&&!(n.title+' '+n.summary+' '+n.detail+' '+(n.symbols||[]).join(' ')).toLowerCase().includes(query))return false;
  return true;
 });
 const p=paginateNews(rows,app.newsPage,NEWS_PER_PAGE);
 app.newsPage=p.page;
 $('newsList').innerHTML=p.items.length?p.items.map(n=>{
  const safeLink=(()=>{try{const u=new URL(n.link);return ['https:','http:'].includes(u.protocol)?escapeHtml(u.href):''}catch{return ''}})();
  const toneLabel=n.tone==='risk'?'악재 가능성':n.tone==='opportunity'?'호재 가능성':'방향 미확정';
  const short=clipNewsText(n.summary||n.detail||'',180);
  const detail=String(n.detail||n.summary||'').trim();
  const sourceText=detail?escapeHtml(detail):'이 기사에 대해 RSS에서 제공하는 본문 설명이 없습니다. 아래 원문을 확인해주세요.';
  const summaryText=short?escapeHtml(short):'제공처 요약 없음 · 기사 원문에서 상세 내용을 확인하세요.';
  const detailLink=safeLink?`<a class="news-detail-link" href="${safeLink}" target="_blank" rel="noopener noreferrer">기사 원문 전체 보기 ↗</a>`:'';
  return `<details class="news-entry" data-news-id="${escapeHtml(n.id)}" ${app.expandedNewsId===n.id?'open':''}>
    <summary class="news-entry-head"><span class="news-main"><span class="news-title">${escapeHtml(n.title)}</span><span class="news-summary">${summaryText}</span><span class="news-meta"><span class="news-tag ${escapeHtml(n.tone)}">${toneLabel}</span><span>${escapeHtml(n.source)}</span><span>${dateClock(n.published)} KST</span>${n.impact==='high'?'<span>주요 키워드</span>':''}${n.symbols?.length?`<span>${escapeHtml(n.symbols.join(', '))}</span>`:''}</span></span><span class="news-open-hint">상세 보기 <span aria-hidden="true">⌄</span></span></summary>
    <div class="news-detail"><div class="news-detail-heading">제공처 RSS 기사 설명 · 발췌</div><p>${sourceText}</p><div class="news-detail-foot"><span>기사 내용은 제공처가 제공한 범위만 표시합니다. 전문은 원문에서 확인하세요. 호재·악재 분류는 자동 추정입니다.</span>${detailLink}</div></div>
   </details>`;
 }).join(''):'<div class="empty-small" style="padding:24px">필터에 해당하는 기사가 없거나 RSS 수신이 지연되고 있습니다.</div>';
 const m=app.newsMeta||{};
 $('newsStatus').textContent=`${m.status==='connected'?'RSS 수신 정상':m.status==='partial'?'일부 소스만 연결':m.status==='offline'?'뉴스 조회 실패':'연결 확인 중'} · ${m.sourceCount||0}개 출처 · ${app.news.length}개 기사 · 마지막 확인 ${dateClock(m.checked)} KST · 분류는 제목 기반 추정`;
 $('newsPageCount').textContent=p.total?`${p.start+1}–${p.end} / ${p.total}개 기사 · 한 페이지 5개`:'0개 기사';
 $('newsPrev').disabled=p.page<=1;
 $('newsNext').disabled=p.page>=p.pages;
 $('newsPageNumbers').innerHTML=pageWindow(p.page,p.pages).map(num=>`<button type="button" data-news-page="${num}" class="${num===p.page?'active':''}" aria-label="뉴스 ${num}페이지" ${num===p.page?'aria-current="page"':''}>${num}</button>`).join('');
}
function applyNews(data){app.news=Array.isArray(data.articles)?data.articles:[];app.newsMeta=data;renderNews()}
async function loadNews(){try{applyNews(await json('/api/news'))}catch(e){app.newsMeta={status:'offline',error:e.message};renderNews()}}
function newsNotify(article){
 const holder=$('toastHolder'),node=document.createElement('div');node.className='toast signal-toast';
 node.innerHTML=`<strong>📰 중요 기사 후보 · ${escapeHtml(article.source)}</strong><div>${escapeHtml(article.title)}</div><small>보도 원문 확인 전에는 사실·가격 영향을 확정할 수 없습니다.</small><div style="margin-top:8px"><a class="trade-link neutral" href="${escapeHtml(article.link)}" target="_blank" rel="noopener noreferrer">기사 원문 ↗</a></div>`;
 holder.prepend(node);setTimeout(()=>node.remove(),18000);
 if('Notification' in window&&Notification.permission==='granted')try{
  const n=new Notification(`📰 [중요 기사 후보] ${article.source}`,{body:article.title,tag:'news-'+article.id});n.onclick=()=>{window.open(article.link,'_blank','noopener,noreferrer');n.close()};
 }catch{}
}
function connectEvents(){let es=new EventSource('/events');app.stream=es;
 es.addEventListener('status',e=>{try{setStatus(JSON.parse(e.data))}catch{}});
 es.addEventListener('market',e=>{try{applyMarket(JSON.parse(e.data))}catch{}});
 es.addEventListener('quotes',e=>{try{const p=JSON.parse(e.data);app.lastSocketEvent=Date.now();onQuote(p.data||[])}catch{}});
 es.addEventListener('scan',e=>{try{const x=JSON.parse(e.data);setStatus(x.status);app.signals=x.signals||[];app.patterns=x.patterns||[];app.watch=x.watch||[];if(x.recent)app.recent=x.recent;app.structures=x.structures||[];app.history=x.history||[];renderObservations();renderSignals();renderRecentCoverage();json('/api/market').then(applyMarket).catch(()=>{});const found=app.signals.find(x=>x.symbol===app.symbol);if(found){app.analysis=found;renderAnalysis();drawChart()}else if(!app.analysis||app.analysis.status==='insufficient'){loadAnalysis()} }catch{}});
 es.addEventListener('execution',e=>{try{const payload=JSON.parse(e.data);for(const item of payload.items||[]){const q=app.marketMap.get(item.symbol);if(q)q.variational=item.variational;}renderPair();renderMatched();loadExecution()}catch{}});
 es.addEventListener('alert',e=>{try{const a=JSON.parse(e.data);app.alerts.unshift(a);app.alerts=app.alerts.slice(0,60);renderAlerts();notify(a);loadResults()}catch{}});
 es.addEventListener('live',e=>{try{const d=JSON.parse(e.data);if(d.signals)app.signals=d.signals;if(d.patterns)app.patterns=d.patterns;if(d.watch)app.watch=d.watch;renderSignals();if(d.symbol===app.symbol){loadAnalysis();if(d.reason?.includes('close'))loadChart()}}catch{}});
 es.addEventListener('news',e=>{try{applyNews(JSON.parse(e.data))}catch{}});
 es.addEventListener('news-alert',e=>{try{newsNotify(JSON.parse(e.data))}catch{}});
 es.addEventListener('journal',()=>loadJournal());
 es.addEventListener('update',e=>{try{updateStatusText({...JSON.parse(e.data),version:'5.8.0'})}catch{}});
 es.onerror=()=>{if(es.readyState===EventSource.CLOSED)banner('서버 연결 종료','Node.js 서버를 다시 실행하세요.');$('socketStatus').innerHTML='<i class="dot red"></i><span>서버 재접속</span>'};
}
async function loadResults(){try{const data=await json('/api/results');app.signals=(data.signals||[]).filter(x=>app.marketMap.has(x.symbol));app.patterns=(data.patterns||[]).filter(x=>app.marketMap.has(x.symbol));app.watch=(data.watch||[]).filter(x=>app.marketMap.has(x.symbol));app.recent=(data.recent||[]).filter(x=>app.marketMap.has(x.symbol));app.structures=data.structures||[];app.history=data.history||[];renderObservations();app.alerts=(data.alerts||[]).filter(x=>app.marketMap.has(x.symbol));renderSignals();renderRecentCoverage();renderAlerts();const found=(data.recent||[]).find(x=>x.symbol===app.symbol);if(found){app.analysis=found;renderAnalysis()}}catch(e){console.warn('Results:',e.message)}}
async function loadAll(){
 // Failure to fetch Variational metadata must NEVER hide the public TV chart.
 const [st,market]=await Promise.allSettled([json('/api/status'),json('/api/market')]);
 if(st.status==='fulfilled')setStatus(st.value);
 if(market.status==='fulfilled')applyMarket(market.value);
 if(st.status==='rejected'||market.status==='rejected')banner('시장 데이터 검증 대기','TradingView 차트는 이용 가능합니다. 매매 신호와 주문 링크는 검증 전 차단됩니다. Node.js 서버 및 API 연결을 확인하세요.');
 await Promise.allSettled([loadResults(),loadNews(),loadJournal(),...(app.marketMap.has(app.symbol)?[loadChart(),loadAnalysis(),loadExecution()]:[])]);
}
async function addWatch(){const sym=$('watchInput').value.toUpperCase().trim();if(!app.marketMap.has(sym)){$('watchError').textContent='Variational·바이낸스 공통 PERP 종목만 추가할 수 있습니다.';return}
 try{const res=await json('/api/watchlist',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({symbols:[...app.watchlist,sym]})});app.watchlist=res.watchlist;renderWatch();$('watchDialog').close();selectSymbol(sym)}catch(e){$('watchError').textContent=e.message}}
$('journalForm').addEventListener('submit',saveJournal);
$('journalForm').addEventListener('input',calcJournalPreview);
$('journalReset').addEventListener('click',()=>{$('journalForm').reset();calcJournalPreview()});
$('closeTradeSave').addEventListener('click',closeJournalTrade);
$('addWatch').addEventListener('click',()=>{$('watchInput').value='';$('watchError').textContent='';$('watchDialog').showModal()});$('saveWatch').addEventListener('click',addWatch);
$('watchInput').addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();addWatch()}});
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
$('scanButton').addEventListener('click',async e=>{e.currentTarget.disabled=true;e.currentTarget.textContent='분석 중…';try{await loadAnalysis();toast(app.symbol+' 선택 종목 최신 분석 완료')}finally{e.currentTarget.disabled=false;e.currentTarget.textContent='✦ 선택 종목 분석'}});
$('refreshButton').addEventListener('click',()=>loadAll());
$('runScanNow').addEventListener('click',async()=>{const b=$('runScanNow');b.disabled=true;b.textContent='스캔 요청 중…';try{const x=await json('/api/scan',{method:'POST'});toast(x.accepted?'전체 보완 스캔을 시작했습니다. 처리 건수는 자동 갱신됩니다.':'이미 자동 스캔이 진행 중입니다.');}catch(e){toast('스캔 요청 실패: '+e.message,true)}finally{b.disabled=false;b.textContent='↻ 지금 스캔'}});
$('updateButton').addEventListener('click',async()=>{const b=$('updateButton');b.disabled=true;try{const x=await json('/api/update/check',{method:'POST'});updateStatusText({...x,version:'5.8.0'});toast(x.message||'업데이트 확인 완료',x.state==='error')}catch(e){toast('업데이트 확인 실패: '+e.message,true)}finally{b.disabled=false}});
 $('executionSide').addEventListener('change',loadExecution);$('executionSize').addEventListener('change',loadExecution);$('executionRefresh').addEventListener('click',loadExecution);$('dismissError').addEventListener('click',clearBanner);
$('showWatchButton').addEventListener('click',()=>{app.showWatch=!app.showWatch;$('signalFilter').value=app.showWatch?'ready':'all';app.signalPage=1;renderSignals()});
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
$('signalFilter').addEventListener('change',()=>{app.showWatch=false;app.signalPage=1;renderSignals()});
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
setInterval(loadExecution,30000);setInterval(loadJournal,60000);setInterval(loadChart,35000);setInterval(loadResults,65000);setInterval(loadNews,90000);setInterval(async()=>{try{const st=await json('/api/status');const changed=st.lastVariational!==app.status?.lastVariational;setStatus(st);if(st.ws!=='connected'||!app.market.length||changed){const m=await json('/api/market');applyMarket(m)}}catch{}},18000);
if('Notification' in window&&Notification.permission==='granted')$('notificationButton').textContent='✓ 브라우저 알림 ON';
// Mount TradingView immediately, before waiting for either exchange API.
renderPair();renderTradingView();connectEvents();loadAll();
