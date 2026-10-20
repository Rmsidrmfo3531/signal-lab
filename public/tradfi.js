import {tradingViewInterval} from './tradingview.js';
const $=id=>document.getElementById(id);
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const price=x=>x==null||!Number.isFinite(Number(x))?'—':Number(x).toLocaleString('en-US',{maximumFractionDigits:4});
const money=x=>x==null||!Number.isFinite(Number(x))?'—':(x>=0?'+':'−')+'$'+Math.abs(Number(x)).toFixed(3);
const dt=t=>t?new Date(t).toLocaleTimeString('ko-KR',{timeZone:'Asia/Seoul',hour:'2-digit',minute:'2-digit',second:'2-digit'}):'—';
const formatNumber=x=>x==null?'—':Number(x).toLocaleString('en-US',{maximumFractionDigits:0});
let snapshot=null, selected='XAU-SWAP',mode='all',term='',bar='1h',lastChartKey='';
function renderChart(){
 const host=$('tradfiChart');if(!host)return;
 const item=snapshot?.swaps?.find(x=>x.ticker===selected);
 $('tradfiChartTitle').textContent=item?`${item.base} · ${item.name}`:'TradFi TradingView 차트';
 const url=item?.chartSymbol?`https://www.tradingview.com/chart/?symbol=${encodeURIComponent(item.chartSymbol)}&interval=${encodeURIComponent(tradingViewInterval(bar))}`:null;
 $('tradfiTvOut').href=url||'https://www.tradingview.com/chart/';
 $('tradfiTvOut').setAttribute('aria-disabled',url?'false':'true');
 const key=`${selected}|${bar}|${item?.chartSymbol||''}`;
 if(lastChartKey===key)return;
 lastChartKey=key;host.innerHTML='';
 if(!item?.chartSymbol){host.innerHTML='<div class="tradfi-placeholder">이 SWAP의 TradingView 참조 심볼이 확인되지 않았습니다. Variational 시장 목록에서 상품을 확인하세요.</div>';return}
 const container=document.createElement('div');container.className='tradingview-widget-container';container.style.cssText='height:100%;width:100%';
 const widget=document.createElement('div');widget.className='tradingview-widget-container__widget';widget.style.cssText='height:calc(100% - 30px);width:100%';container.append(widget);
 const brand=document.createElement('div');brand.className='tradingview-widget-copyright';brand.style.cssText='font-size:11px;text-align:right;padding:5px 9px';
 const a=document.createElement('a');a.href=url;a.rel='noopener noreferrer';a.target='_blank';a.textContent=`${item.chartSymbol} · TradingView (참조 자산, Variational 호가 아님) ↗`;brand.append(a);container.append(brand);
 const script=document.createElement('script');script.src='https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js';script.async=true;
 script.textContent=JSON.stringify({autosize:true,symbol:item.chartSymbol,interval:tradingViewInterval(bar),timezone:'Etc/UTC',theme:'dark',style:'1',locale:'kr',allow_symbol_change:true,hide_top_toolbar:false,hide_side_toolbar:false,save_image:true,withdateranges:true});
 container.append(script);host.append(container);
}
function card(item){
 const q=item.quote||{},quoteState=q.eligible?'호가 최신':'호가 보류';
 const rateLong=item.longRate==null?'—':(item.longRate*100).toFixed(4)+'%';
 const rateShort=item.shortRate==null?'—':(item.shortRate*100).toFixed(4)+'%';
 const fLabel=item.type==='SWAP'?'SWAP 펀딩 (1일)':'PERP 펀딩 (현재 구간)';
 const trade=item.tradeUrl&&q.eligible?`<a href="${esc(item.tradeUrl)}" target="_blank" rel="noopener noreferrer" class="tf-btn tf-order">Variational 주문창 ↗</a>`:`<a href="${esc(item.marketsUrl)}" target="_blank" rel="noopener noreferrer" class="tf-btn">Variational 시장 확인 ↗</a>`;
 return `<article class="tf-card ${selected===item.ticker?'selected':''}">
   <div class="tf-title"><div><span class="tf-category">${esc(item.category)}</span> <strong>${esc(item.base)}</strong><small>${esc(item.name)}</small></div><span class="tf-state ${q.eligible?'tf-fresh':'tf-stale'}">${quoteState}</span></div>
   <div class="tf-grid"><div><span>Variational Mark</span><strong>${price(item.markPrice)}</strong></div><div><span>24H 거래량</span><strong>$${formatNumber(item.volume24h)}</strong></div><div><span>참고 Bid / Ask</span><strong>${price(item.bid)} / ${price(item.ask)}</strong></div><div><span>스프레드</span><strong>${item.spreadBps==null?'—':item.spreadBps.toFixed(2)+' bp'}</strong></div></div>
   <p class="tf-funding">${fLabel}: 롱 ${rateLong} · 숏 ${rateShort} <span>($1,000 명목 기준 예상 롱 ${money(item.fundingExampleLongUSD)}, 숏 ${money(item.fundingExampleShortUSD)})</span></p>
   <div class="tf-foot"><small>호가 ${dt(item.quoteUpdatedAt)} KST · ${q.eligible?'참고 호가 검증 통과':esc((q.reasons||[]).join(', '))}</small><div><button type="button" class="tf-btn" data-tfchart="${esc(item.ticker)}">차트 보기</button>${trade}</div></div>
 </article>`;
}
function patternCard(p){
 const row=snapshot?.swaps?.find(x=>x.ticker===p.ticker);
 if(!row)return '';
 return `<article class="tf-pattern"><div class="tf-title"><strong>${esc(p.ticker)} · ${esc(p.direction)}</strong><span class="tf-state tf-stale">검증된 확정봉 · 체결 미확정</span></div><p>${esc(p.pattern)}</p>
 <div class="tf-grid"><div><span>진입 참조</span><strong>${price(p.entry)}</strong></div><div><span>손절 참조</span><strong>${price(p.stop)}</strong></div><div><span>1차 40%</span><strong>${price(p.targets?.[0])}</strong></div><div><span>2차 35% / 3차 25%</span><strong>${price(p.targets?.[1])} / ${price(p.targets?.[2])}</strong></div></div>
 <p class="tf-note">마지막 확정봉 ${dt(p.lastBarAt)} KST · Twelve Data 참조 시세 기준 · Variational 실제 체결가·슬리피지 별도 확인</p>
 <button class="tf-btn" type="button" data-tfchart="${esc(p.ticker)}">TradingView 확인 ↗</button></article>`;
}
function render(){
 if(!snapshot)return;
 const last=snapshot.updatedAt;const total=snapshot.swaps?.length||0;
 $('tradfiStatus').textContent=snapshot.status==='connected'?`Variational TradFi ${total}개 · API 확인 ${dt(last)} KST · 60초마다 갱신`:`Variational SWAP API 연결 실패: ${snapshot.error||'연결 대기'}`;
 const feedState=!snapshot.feedStatus||snapshot.feedStatus==='unconfigured'?'외부 OHLC 미설정 — 자동 TradFi 확정 신호 없음':
 `${snapshot.feedStatus==='connected'?'OHLC 검사 완료':snapshot.feedStatus==='checking'?'OHLC 분석 중':'OHLC 검사 일부 실패'} · 마지막 ${dt(snapshot.feedUpdatedAt)} · ${snapshot.feedError||'정상'} · ${snapshot.scanIntervalMinutes||15}분 주기`;
 $('tradfiFeed').textContent=feedState;
 const items=(snapshot.swaps||[]).filter(x=>(mode==='all'||x.category===mode)&&(!term||x.ticker.includes(term)||x.base.includes(term)||x.name.toUpperCase().includes(term)));
 $('tradfiCount').textContent=`${items.length}개 표시 / 전체 ${total}개`;
 $('tradfiList').innerHTML=items.length?items.map(card).join(''):'<div class="tradfi-placeholder">검증된 TradFi 상품이 없거나 선택한 검색 조건과 일치하는 시장이 없습니다.</div>';
 const patterns=(snapshot.patterns||[]).filter(p=>snapshot.swaps.some(x=>x.ticker===p.ticker));
 $('tradfiSignals').innerHTML=patterns.length?patterns.map(patternCard).join(''):'<p class="tf-note">현재 확인된 TradFi 확정 기술 패턴이 없습니다. Twelve Data API 키가 없거나, 참조 캔들·시장 운영 상태·호가·패턴 조건을 모두 통과한 종목이 없으면 신호가 표시되지 않습니다.</p>';
 renderChart();
}
export async function refreshTradFi(){
 try{const resp=await fetch('/api/tradfi',{cache:'no-store'});if(!resp.ok)throw Error('HTTP '+resp.status);snapshot=await resp.json();
   if(!(snapshot.swaps||[]).some(x=>x.ticker===selected))selected=snapshot.swaps?.find(x=>x.base==='XAU')?.ticker||snapshot.swaps?.[0]?.ticker||'XAU-SWAP';
   render();
 }catch(e){$('tradfiStatus').textContent='TradFi 조회 실패: '+e.message}
}
export function initTradFi(){
 $('tradfiCategory').addEventListener('change',e=>{mode=e.target.value;render()});
 $('tradfiSearch').addEventListener('input',e=>{term=e.target.value.trim().toUpperCase();render()});
 $('tradfiRefresh').addEventListener('click',refreshTradFi);
 $('tradfiBar').addEventListener('change',e=>{bar=e.target.value;renderChart()});
 $('tradfiList').addEventListener('click',e=>{const btn=e.target.closest('[data-tfchart]');if(!btn)return;selected=btn.dataset.tfchart;lastChartKey='';render();$('tradfiChartPanel').scrollIntoView({behavior:'smooth',block:'center'})});
 $('tradfiSignals').addEventListener('click',e=>{const btn=e.target.closest('[data-tfchart]');if(!btn)return;selected=btn.dataset.tfchart;lastChartKey='';render();$('tradfiChartPanel').scrollIntoView({behavior:'smooth',block:'center'})});
 refreshTradFi();setInterval(refreshTradFi,60000);
 const events=new EventSource('/events');events.addEventListener('tradfi',e=>{try{snapshot=JSON.parse(e.data);render()}catch{}});
 events.addEventListener('tradfi-alert',e=>{
   try{const p=JSON.parse(e.data),row=snapshot?.swaps?.find(x=>x.ticker===p.ticker);
     if('Notification' in window&&Notification.permission==='granted'){
       const n=new Notification(`[TradFi 확정봉] ${p.ticker} ${p.direction}`,{
         body:`${p.pattern} | 참조 진입 ${price(p.entry)}, 손절 ${price(p.stop)} · 실제 체결 확인 필요`,tag:`tradfi-${p.ticker}-${p.lastBarAt}`});
       n.onclick=()=>{window.focus();$('tradfi').scrollIntoView({behavior:'smooth'});if(row){selected=row.ticker;lastChartKey='';render()}n.close()};
     }
   }catch{}
 });
}
