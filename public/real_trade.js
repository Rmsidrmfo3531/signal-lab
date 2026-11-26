// Exchange-style manual trading terminal for the BingX real account (#real):
//  - BingX-style large searchable & sortable market selector dropdown (all BingX Futures + TradFi)
//  - Interactive Canvas 2D candlestick chart with live entry/liq/open-order/draft overlays & click-to-trade
//  - Full order ticket (Cross/Isolated, Leverage, Market/Limit, Margin/Notional/Coin/%, TP/SL, Open Orders)
// Mounted in its own DOM container (#realTradePanel) so the 3-second #realCopy refresh never wipes inputs or canvas.
import {displaySymbol} from './symbol_display.js';
import {createRealTradeChart} from './real_trade_chart.js';

const esc=s=>String(s??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
const fin=v=>v!==null&&v!==''&&Number.isFinite(Number(v));
const fmtPx=v=>fin(v)&&Number(v)>0?String(+Number(v).toPrecision(6)):'—';
const fmtUsd=v=>fin(v)?`$${Number(v).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}`:'—';
const fmtQty=v=>fin(v)&&Number(v)>0?String(+Number(v).toPrecision(6)):'—';
const fmtCompact=v=>{
 const n=Number(v);
 if(!Number.isFinite(n)||n<=0)return '—';
 if(n>=1e9)return (n/1e9).toFixed(2)+'B';
 if(n>=1e6)return (n/1e6).toFixed(2)+'M';
 if(n>=1e3)return (n/1e3).toFixed(1)+'K';
 return n.toFixed(0);
};
const fmtPct=v=>fin(v)?`${Number(v)>=0?'+':''}${Number(v).toFixed(2)}%`:'—';

const LEVERAGE_PRESETS=[3,5,10,20,50];
const PCT_PRESETS=[10,25,50,75];
const CHART_INTERVALS=['1m','5m','15m','1h','4h','1d'];
const FAV_KEY='signal_lab_bingx_favs_v1';
const ORDER_TYPE_KO={LIMIT:'지정가',MARKET:'시장가',STOP_MARKET:'손절(SL)',TAKE_PROFIT_MARKET:'익절(TP)',STOP:'스탑 지정가',TAKE_PROFIT:'익절 지정가'};

function loadFavs(){
 try{
  const raw=globalThis.localStorage?.getItem(FAV_KEY);
  const arr=raw?JSON.parse(raw):null;
  if(Array.isArray(arr)&&arr.length)return new Set(arr.map(x=>String(x).toUpperCase()));
 }catch{}
 return new Set(['BTCUSDT','ETHUSDT','SOLUSDT']);
}
function saveFavs(set){
 try{globalThis.localStorage?.setItem(FAV_KEY,JSON.stringify([...set]))}catch{}
}

/** Pure filter & sort helper for the BingX market selector dropdown (exported for unit tests). */
export function filterSortMarkets(markets=[],{query='',tab='ALL',sortBy='volume',sortDir='desc',favorites=new Set()}={}){
 const q=String(query||'').trim().toUpperCase().replace(/[^A-Z0-9]/g,'');
 let list=(Array.isArray(markets)?markets:[]).filter(m=>{
  const disp=String(m.displaySymbol||m.symbol||'').toUpperCase();
  if(tab==='FAV'&&!favorites.has(disp))return false;
  if(tab==='FUTURES'&&m.category!=='FUTURES')return false;
  if(tab==='TRADFI'&&m.category!=='TRADFI')return false;
  if(tab==='HELD'&&!(m.holding?.length>0))return false;
  if(q&&!disp.includes(q)&&!String(m.symbol||'').toUpperCase().includes(q))return false;
  return true;
 });
 const dir=sortDir==='asc'?1:-1;
 list=[...list].sort((a,b)=>{
  if(sortBy==='name')return dir*String(a.displaySymbol||'').localeCompare(String(b.displaySymbol||''));
  if(sortBy==='price')return dir*((Number(a.lastPrice)||0)-(Number(b.lastPrice)||0));
  if(sortBy==='change')return dir*((Number(a.changePct)||-9999)-(Number(b.changePct)||-9999));
  return dir*((Number(a.quoteVolume)||0)-(Number(b.quoteVolume)||0));
 });
 return list;
}

export function computeOrderPreview(st){
 const info=st.info;
 const lev=Math.max(1,Math.min(125,Math.round(Number(st.leverage)||0)));
 const amt=Number(st.amount);
 const execPrice=st.orderType==='LIMIT'?Number(st.limitPrice):Number(info?.price);
 if(!(amt>0)||!(execPrice>0)||!(lev>=1))return null;
 const rawQty=st.amountMode==='MARGIN_USDT'?(amt*lev/execPrice):st.amountMode==='NOTIONAL_USDT'?(amt/execPrice):amt;
 const step=Number(info?.quantityStep);
 const qty=step>0?Math.floor((rawQty+1e-12)/step)*step:rawQty;
 const cleanQty=qty>0?Number(qty.toFixed(8)):0;
 const notionalUSD=cleanQty*execPrice;
 const marginUSD=notionalUSD/lev;
 const minN=Number(info?.minNotionalUSDT)||0;
 const minQ=Number(info?.minQuantityBase)||0;
 const avail=fin(st.availableUSD)?Number(st.availableUSD):null;
 const eq=fin(st.equityUSD)?Number(st.equityUSD):avail;
 const sf=st.safety||null;
 const safeMaxLev=sf?.manualMaxLeverage>0?Number(sf.manualMaxLeverage):null;
 const safeMaxMargin=sf?.manualMaxMarginPct>0&&eq>0?eq*Number(sf.manualMaxMarginPct)/100:null;
 const warn=sf?.tripped?`일일 손실 차단 발동 중 (신규 진입 불가)`
  :safeMaxLev&&lev>safeMaxLev?`수동 안전 레버리지 상한(${safeMaxLev}배) 초과`
  :!(cleanQty>0)||cleanQty<minQ?`최소 수량(${fmtQty(minQ)}) 미만`
  :minN>0&&notionalUSD<minN?`최소 주문 금액($${minN}) 미만`
  :safeMaxMargin&&marginUSD>safeMaxMargin+0.01?`단일 증거금 안전 한도(${fmtUsd(safeMaxMargin)} · ${sf.manualMaxMarginPct}%) 초과`
  :avail!==null&&marginUSD>avail*0.98?`가용 증거금(${fmtUsd(avail)}) 초과`:null;
 const makerEntry=(st.orderType==='LIMIT'&&st.postOnly===true)||(st.orderType==='MARKET'&&st.makerFirst===true);
 const entryRate=makerEntry?0.0002:0.0005;
 const rtRate=entryRate+0.0005;
 const estRoundTripFeeUSD=+(notionalUSD*rtRate).toFixed(4);
 const breakevenMovePct=+(rtRate*100).toFixed(3);
 const breakevenRoePct=+(rtRate*lev*100).toFixed(2);
 return {qty:cleanQty,coinQty:cleanQty,execPrice,notionalUSD,marginUSD,warn,makerEntry,estRoundTripFeeUSD,breakevenMovePct,breakevenRoePct};
}

export function marketDropdownRowsHTML(st){
 const rows=filterSortMarkets(st.markets,{
  query:st.marketQuery,tab:st.marketTab,sortBy:st.marketSortBy,sortDir:st.marketSortDir,favorites:st.favorites,
 });
 if(!rows.length){
  const msg=st.loadingMarkets?'BingX 전 종목을 불러오는 중…':st.marketsError?`종목 목록 조회 실패: ${st.marketsError}`:'조건에 맞는 종목이 없습니다.';
  return `<p class="empty-small rt-dd-empty">${esc(msg)}</p>`;
 }
 const curDisp=displaySymbol(st.symbol);
 return rows.slice(0,250).map(m=>{
  const isFav=st.favorites?.has?.(m.displaySymbol);
  const isCur=curDisp===m.displaySymbol;
  const chgCls=fin(m.changePct)?(Number(m.changePct)>=0?'paper-profit':'paper-loss'):'muted';
  const badge=m.holding?.length?'<span class="rt-dd-badge held">보유</span>':m.category==='TRADFI'?'<span class="rt-dd-badge tradfi">TradFi</span>':'';
  return `<div class="rt-dd-row${isCur?' is-current':''}" data-rt-pick-sym="${esc(m.symbol)}" data-rt-pick-disp="${esc(m.displaySymbol)}">
   <button type="button" class="rt-star${isFav?' is-fav':''}" data-rt-fav="${esc(m.displaySymbol)}" aria-label="즐겨찾기">${isFav?'★':'☆'}</button>
   <div class="rt-dd-pair"><b>${esc(m.displaySymbol)}${badge}</b><small>${fmtCompact(m.quoteVolume)} USDT</small></div>
   <div class="rt-dd-px">${fmtPx(m.lastPrice)}</div>
   <div class="rt-dd-chg ${chgCls}">${fmtPct(m.changePct)}</div>
  </div>`;
 }).join('');
}

function marketDropdownHTML(st){
 if(!st.dropdownOpen)return '';
 const arrow=k=>st.marketSortBy===k?(st.marketSortDir==='asc'?' ▲':' ▼'):' ↕';
 const tabs=[['FAV','★ 즐겨찾기'],['ALL','전체'],['FUTURES','선물'],['TRADFI','TradFi'],['HELD','보유중']];
 return `<div class="rt-dd" data-rt-dropdown>
  <div class="rt-dd-search-wrap">
   <input type="text" class="rt-dd-search" data-rt-dd-search value="${esc(st.marketQuery)}" placeholder="🔍 종목 검색 (BTC, ETH, AKE, SNDK, GOLD…)" autocomplete="off" aria-label="BingX 종목 검색">
   <button type="button" class="rt-dd-close" data-rt-dd-close aria-label="닫기">✕</button>
  </div>
  <div class="rt-dd-tabs">${tabs.map(([k,lbl])=>`<button type="button" class="${st.marketTab===k?'is-current':''}" data-rt-dd-tab="${k}">${lbl}</button>`).join('')}</div>
  <div class="rt-dd-head">
   <span></span>
   <span class="rt-dd-sort-pair"><button type="button" data-rt-dd-sort="name">종목${arrow('name')}</button> / <button type="button" data-rt-dd-sort="volume">거래량${arrow('volume')}</button></span>
   <button type="button" class="num" data-rt-dd-sort="price">현재가${arrow('price')}</button>
   <button type="button" class="num" data-rt-dd-sort="change">24h 변동%${arrow('change')}</button>
  </div>
  <div class="rt-dd-list" data-rt-dd-list>${marketDropdownRowsHTML(st)}</div>
  <div class="rt-dd-foot"><span data-rt-dd-count>BingX 무기한 선물 전체 ${esc(st.markets?.length||0)}종목</span><button type="button" class="rt-link-btn" data-rt-refresh-markets>↻ 시세 새로고침</button></div>
 </div>`;
}

export function realTradePanelHTML(st){
 const info=st.info;
 const symDisp=displaySymbol(info?.symbol||st.symbol||'BTCUSDT');
 const curMarket=(st.markets||[]).find(m=>m.displaySymbol===symDisp)||null;
 const livePrice=info?.price??curMarket?.lastPrice??null;
 const chgPct=curMarket?.changePct??null;
 const chgCls=fin(chgPct)?(Number(chgPct)>=0?'paper-profit':'paper-loss'):'';
 const isFav=st.favorites?.has?.(symDisp);
 const avail=fin(st.availableUSD)?Number(st.availableUSD):null;
 const maxLev=info?.maxLeverage?.long||info?.maxLeverage?.short||125;
 const preview=computeOrderPreview(st);
 const submitDisabled=st.busy||st.loadingInfo||!info||info.symbol!==st.symbol;
 const symPositions=(st.heldPositions||[]).filter(p=>displaySymbol(p.symbol)===symDisp);
 const copyHold=info?.copyHolding?.length
  ?`<p class="rt-copy-warn">⚠️ 카피 매매 보유 중 (${info.copyHolding.map(h=>`${h.direction==='LONG'?'롱':'숏'} ${h.qty} · ${h.leverage}배`).join(', ')}) — 수동 추가 주문 가능</p>`:'';
 const amtPlaceholder=st.amountMode==='MARGIN_USDT'?'증거금 USDT (예: 50)':st.amountMode==='NOTIONAL_USDT'?'주문 금액 USDT (예: 500)':'코인 수량 (예: 2000)';
 const amtUnit=st.amountMode==='COIN'?symDisp.replace(/USDT$/,''):'USDT';
 const previewHtml=preview
  ?`<div class="rt-preview${preview.warn?' is-warn':''}">
     <span>예상 수량 <b>${esc(fmtQty(preview.coinQty))}</b></span>
     <span>명목가치 <b>${fmtUsd(preview.notionalUSD)}</b></span>
     <span>필요 증거금 <b>${fmtUsd(preview.marginUSD)}</b></span>
     <span title="${preview.makerEntry?'메이커 진입(0.02%)+시장가 청산(0.05%) 기준':'시장가 진입(0.05%)+시장가 청산(0.05%) 기준'}">왕복 수수료 <b>$${esc(preview.estRoundTripFeeUSD.toFixed(2))}</b> <small>(본전 +${esc(preview.breakevenMovePct)}% · ROE +${esc(preview.breakevenRoePct)}%)</small></span>
     ${preview.warn?`<span class="rt-prev-warn">⚠ ${esc(preview.warn)}</span>`:''}
    </div>`
  :`<div class="rt-preview muted">수량 또는 금액을 입력하면 예상 증거금·수수료가 자동 계산됩니다.</div>`;
 const orders=Array.isArray(st.openOrders)?st.openOrders:[];
 const ordersHtml=orders.length
  ?`<ul class="rt-orders-list">${orders.map(o=>{
    const dir=o.positionSide==='LONG'||(o.positionSide==='BOTH'&&o.side==='BUY')?'LONG':'SHORT';
    const pxTxt=o.stopPrice&&o.price?`${fmtPx(o.price)} (트리거 ${fmtPx(o.stopPrice)})`:fmtPx(o.stopPrice||o.price);
    return `<li>
     <span class="rt-o-sym"><b>${esc(o.displaySymbol)}</b> <small class="${dir==='LONG'?'pos':'neg'}">${o.side==='BUY'?'매수':'매도'}${o.positionSide&&o.positionSide!=='BOTH'?`(${o.positionSide==='LONG'?'롱':'숏'})`:''}</small></span>
     <span class="rt-o-meta">${esc(ORDER_TYPE_KO[o.type]||o.type)} · 가격 <b>${pxTxt}</b> · 수량 <b>${fmtQty(o.origQty)}</b></span>
     <button type="button" class="vp-act-btn danger" data-rt-cancel-order="${esc(o.orderId)}" data-rt-cancel-sym="${esc(o.venueSymbol)}">취소</button>
    </li>`;
   }).join('')}</ul>`
  :`<p class="empty-small">${st.loadingOrders?'미체결 주문 조회 중…':'열린 미체결 주문이 없습니다.'}</p>`;

 const clickBar=fin(st.selectedPrice)
  ?`<div class="rt-chart-actionbar">
     <span class="rt-ca-px">차트 선택가 <b>${fmtPx(st.selectedPrice)}</b></span>
     <button type="button" class="rt-ca-btn" data-rt-ca="SET_LIMIT">지정가 넣기</button>
     <button type="button" class="rt-ca-btn" data-rt-ca="SET_TP">TP 설정</button>
     <button type="button" class="rt-ca-btn" data-rt-ca="SET_SL">SL 설정</button>
     <button type="button" class="rt-ca-btn long" data-rt-ca="LIMIT_LONG">⚡ 롱 지정가</button>
     <button type="button" class="rt-ca-btn short" data-rt-ca="LIMIT_SHORT">⚡ 숏 지정가</button>
     <button type="button" class="rt-ca-btn" data-rt-ca="CLEAR" aria-label="선택 취소">✕</button>
    </div>`
  :`<div class="rt-chart-hint">💡 차트에서 원하는 가격을 클릭하면 지정가·TP·SL 설정 또는 바로 롱/숏 지정가 주문을 넣을 수 있습니다. (휠: 확대/축소 · 드래그: 이동)</div>`;

 const posPills=symPositions.length
  ?`<div class="rt-chart-posbar">${symPositions.map(p=>`<span class="rt-pos-pill ${p.direction==='LONG'?'is-long':'is-short'}">${p.origin==='copy'?'[카피] ':'[수동] '}${p.direction==='LONG'?'롱':'숏'} 진입 <b>${fmtPx(p.avg)}</b> · 수량 ${fmtQty(p.size)} · <b class="${Number(p.unrealized)>=0?'paper-profit':'paper-loss'}">${fin(p.unrealized)?`${Number(p.unrealized)>=0?'+':'-'}$${Math.abs(Number(p.unrealized)).toFixed(2)}`:'—'} (${fmtPct(p.roePct)})</b></span>`).join('')}</div>`
  :'';

 return `<details class="rt-fold"${st.open?' open':''}>
  <summary data-rt-toggle><b>⚡ 거래소 차트 · 수동 매매</b> <small>${esc(symDisp)} ${fmtPx(livePrice)} · 전 종목 드롭다운 · 차트 직접 주문 · 미체결 ${orders.length}건 · 가용 ${fmtUsd(avail)}</small></summary>
  <div class="rt-terminal">
   <div class="rt-topbar">
    <div class="rt-pair-anchor">
     <button type="button" class="rt-pair-btn" data-rt-dd-toggle aria-expanded="${st.dropdownOpen?'true':'false'}">
      <span class="rt-pair-name">${esc(symDisp)}</span><span class="rt-pair-caret">${st.dropdownOpen?'▲':'▼'}</span>
     </button>
     <button type="button" class="rt-star big${isFav?' is-fav':''}" data-rt-fav="${esc(symDisp)}" title="즐겨찾기">${isFav?'★':'☆'}</button>
     ${marketDropdownHTML(st)}
    </div>
    <div class="rt-ticker-main">
     <strong class="rt-last-px ${chgCls}">${fmtPx(livePrice)}</strong>
     <span class="rt-last-chg ${chgCls}">${fmtPct(chgPct)}</span>
    </div>
    <div class="rt-ticker-stats">
     <span>24h 거래대금 <b>${fmtCompact(curMarket?.quoteVolume)}</b></span>
     <span>24h 고 / 저 <b>${fmtPx(curMarket?.high24h)} / ${fmtPx(curMarket?.low24h)}</b></span>
     <span>최소 주문 <b>${info?.minNotionalUSDT?`$${esc(info.minNotionalUSDT)}`:'—'}</b></span>
     <span>최대 배율 <b>${esc(maxLev)}x</b></span>
     <span>가용 <b>${fmtUsd(avail)}</b></span>
    </div>
   </div>
   ${copyHold}
   ${st.infoError?`<p class="rt-status-msg err">${esc(st.infoError)}</p>`:''}
   <div class="rt-grid">
    <div class="rt-chart-col">
     <div class="rt-chart-box">
      <div class="rt-chart-toolbar">
       <div class="rt-tf-btns">${CHART_INTERVALS.map(tf=>`<button type="button" class="${st.interval===tf?'is-current':''}" data-rt-tf="${tf}">${tf}</button>`).join('')}</div>
       <div class="rt-chart-tools">
        <button type="button" class="rt-tool-btn${st.showEma?' is-current':''}" data-rt-ema>EMA 20/50</button>
        <button type="button" class="rt-tool-btn" data-rt-chart-latest title="최신 봉으로 이동">▶ 최신</button>
        <button type="button" class="rt-tool-btn" data-rt-refresh-chart title="차트 새로고침">↻</button>
       </div>
      </div>
      ${posPills}
      <div class="rt-canvas-wrap"><canvas class="rt-canvas" data-rt-canvas></canvas></div>
      <div data-rt-clickbar-slot>${clickBar}</div>
     </div>
     <div class="rt-orders">
      <div class="rt-orders-head"><b>미체결 주문 (${orders.length}건)</b><button type="button" class="outline-btn small" data-rt-refresh-orders${st.loadingOrders?' disabled':''}>↻ 새로고침</button></div>
      ${ordersHtml}
     </div>
    </div>
    <div class="rt-ticket">
     <div class="rt-row-2">
      <div class="rt-group">
       <span class="rt-lbl">마진 모드</span>
       <div class="rt-seg">
        <button type="button" class="${st.marginMode==='CROSSED'?'is-current':''}" data-rt-margin="CROSSED">교차</button>
        <button type="button" class="${st.marginMode==='ISOLATED'?'is-current':''}" data-rt-margin="ISOLATED">격리</button>
       </div>
      </div>
      <div class="rt-group">
       <span class="rt-lbl">레버리지 (배)</span>
       <div class="rt-lev-wrap">
        <input type="number" data-rt-leverage min="1" max="${esc(maxLev)}" step="1" value="${esc(st.leverage)}" aria-label="레버리지">
        <div class="rt-mini-btns">${LEVERAGE_PRESETS.filter(x=>x<=maxLev).map(x=>`<button type="button" class="${Number(st.leverage)===x?'is-current':''}" data-rt-lev-preset="${x}">${x}x</button>`).join('')}</div>
       </div>
      </div>
     </div>
     <div class="rt-row-2">
      <div class="rt-group">
       <span class="rt-lbl">주문 방식</span>
       <div class="rt-seg">
        <button type="button" class="${st.orderType==='MARKET'?'is-current':''}" data-rt-otype="MARKET">시장가</button>
        <button type="button" class="${st.orderType==='LIMIT'?'is-current':''}" data-rt-otype="LIMIT">지정가</button>
        ${st.orderType==='MARKET'?`<button type="button" class="${st.makerFirst?'is-current':''}" data-rt-maker title="지정가(PostOnly 0.02%)로 2.5초 먼저 체결 시도 후 미체결 잔량만 시장가(0.05%) 체결">⚡ 메이커 우선</button>`:`<button type="button" class="${st.postOnly?'is-current':''}" data-rt-post-only title="Post-Only(메이커 전용): 호가에 걸릴 때만 0.02% 수수료로 체결되고 즉시 테이커 체결이면 자동 취소">🛡 Post-Only</button>`}
       </div>
      </div>
      <div class="rt-group">
       <span class="rt-lbl">지정가 (USDT)${st.orderType==='LIMIT'&&livePrice?` <button type="button" class="rt-link-btn" data-rt-fill-price>현재가</button>`:''}</span>
       <input type="number" step="any" data-rt-limit-price value="${esc(st.limitPrice)}" placeholder="${st.orderType==='MARKET'?(st.makerFirst?'메이커 0.02% 우선 (2.5초 후 시장가)':'시장가 체결'):(st.postOnly?'Post-Only 지정가 (0.02% 메이커)':'지정가 입력')}"${st.orderType==='MARKET'?' disabled':''} aria-label="지정가 가격">
      </div>
     </div>
     <div class="rt-group">
      <div class="rt-amt-head">
       <span class="rt-lbl">주문 단위</span>
       <div class="rt-seg">
        <button type="button" class="${st.amountMode==='MARGIN_USDT'?'is-current':''}" data-rt-amode="MARGIN_USDT">증거금</button>
        <button type="button" class="${st.amountMode==='NOTIONAL_USDT'?'is-current':''}" data-rt-amode="NOTIONAL_USDT">주문금액</button>
        <button type="button" class="${st.amountMode==='COIN'?'is-current':''}" data-rt-amode="COIN">수량</button>
       </div>
      </div>
      <div class="rt-amt-input-row">
       <input type="number" step="any" min="0" data-rt-amount value="${esc(st.amount)}" placeholder="${esc(amtPlaceholder)}" aria-label="주문 수량 또는 금액">
       <span class="rt-unit">${esc(amtUnit)}</span>
      </div>
      <div class="rt-mini-btns rt-pct-row">${PCT_PRESETS.map(p=>`<button type="button" data-rt-pct="${p}" title="가용 증거금의 ${p}%">${p}%</button>`).join('')}</div>
     </div>
     <div class="rt-row-2">
      <label class="rt-group"><span class="rt-lbl">익절가 TP (선택)</span><input type="number" step="any" min="0" data-rt-tp value="${esc(st.tpPrice)}" placeholder="비우면 설정 안 함"></label>
      <div class="rt-group">
       <span class="rt-lbl">손절가 SL ${st.slRoePct?`(자동 −${st.slRoePct}% ROE)`:'(선택)'}</span>
       <input type="number" step="any" min="0" data-rt-sl value="${esc(st.slPrice)}" placeholder="${st.slRoePct?`주문 시 −${st.slRoePct}% ROE 자동 계산`:'비우면 손절 없음'}">
       <div class="rt-mini-btns">${[0,10,15,25].map(r=>`<button type="button" class="${(r===0&&!st.slRoePct&&!st.slPrice)||(r>0&&st.slRoePct===r)?'is-current':''}" data-rt-sl-roe="${r}">${r===0?'없음':`-${r}%`}</button>`).join('')}</div>
      </div>
     </div>
     ${Number(st.leverage)>20?`<p class="rt-copy-warn">⚠️ ${esc(st.leverage)}배 고배율은 최근 수동 손실이 집중된 구간입니다 (20배 이하 권장).</p>`:''}
     ${!st.slPrice&&!st.slRoePct?`<p class="rt-hint-sl">💡 손절가(SL) 미설정 상태입니다. 위 <b>-15%</b> 버튼을 누르면 롱·숏 방향에 맞춰 손절이 자동 부착됩니다.</p>`:''}
     ${previewHtml}
     <div class="rt-submit-row">
      <button type="button" class="rt-btn-long" data-rt-submit="LONG"${submitDisabled?' disabled':''}>🟢 롱 / 매수${st.orderType==='LIMIT'?(st.postOnly?' (Post-Only)':' (지정가)'):st.makerFirst?' (메이커 우선)':' (시장가)'}</button>
      <button type="button" class="rt-btn-short" data-rt-submit="SHORT"${submitDisabled?' disabled':''}>🔴 숏 / 매도${st.orderType==='LIMIT'?(st.postOnly?' (Post-Only)':' (지정가)'):st.makerFirst?' (메이커 우선)':' (시장가)'}</button>
     </div>
     <div class="rt-status-msg${st.msgErr?' err':''}" role="status">${esc(st.msg||'')}</div>
    </div>
   </div>
  </div>
 </details>`;
}

export function createRealTradeController(mountEl,{onOrderDone=()=>{}}={}){
 if(!mountEl)return null;
 const state={
  open:false,
  visible:false,
  symbol:'BTCUSDT',
  marginMode:'CROSSED',
  leverage:10,
  orderType:'MARKET',
  makerFirst:true,
  postOnly:true,
  limitPrice:'',
  amountMode:'MARGIN_USDT',
  amount:'',
  tpPrice:'',
  slPrice:'',
  slRoePct:null,
  availableUSD:null,
  heldPositions:[],
  info:null,
  infoError:'',
  loadingInfo:false,
  openOrders:[],
  loadingOrders:false,
  // BingX full market dropdown
  markets:[],
  loadingMarkets:false,
  marketsError:'',
  dropdownOpen:false,
  marketQuery:'',
  marketTab:'ALL',
  marketSortBy:'volume',
  marketSortDir:'desc',
  favorites:loadFavs(),
  // Interactive chart
  interval:'15m',
  candles:[],
  showEma:true,
  selectedPrice:null,
  busy:false,
  msg:'',
  msgErr:false,
 };

 let chartInst=null;
 let chartCanvas=null;

 let infoRevision=0;
 let chartRequest=0,lastChartApplied=0;
 const symDisplay=()=>displaySymbol(state.symbol);

 const pushChartData=()=>{
  if(!chartInst)return;
  const disp=symDisplay();
  const symPos=(state.heldPositions||[]).filter(p=>displaySymbol(p.symbol)===disp);
  const symOrders=(state.openOrders||[]).filter(o=>o.displaySymbol===disp);
  const curMarket=(state.markets||[]).find(m=>m.displaySymbol===disp);
  chartInst.setData({
   candles:state.candles,
   interval:state.interval,
   tickSize:state.info?.tickSize??curMarket?.tickSize??null,
   livePrice:state.info?.price??curMarket?.lastPrice??null,
   positions:symPos,
   orders:symOrders,
   draft:{
    orderType:state.orderType,
    limitPrice:state.limitPrice!==''?Number(state.limitPrice):null,
    tpPrice:state.tpPrice!==''?Number(state.tpPrice):null,
    slPrice:state.slPrice!==''?Number(state.slPrice):null,
   },
   showEma:state.showEma,
   selectedPrice:state.selectedPrice,
  });
 };

 const renderClickBarOnly=()=>{
  const slot=mountEl.querySelector('[data-rt-clickbar-slot]');
  if(!slot)return;
  if(fin(state.selectedPrice)){
   slot.innerHTML=`<div class="rt-chart-actionbar">
     <span class="rt-ca-px">차트 선택가 <b>${fmtPx(state.selectedPrice)}</b></span>
     <button type="button" class="rt-ca-btn" data-rt-ca="SET_LIMIT">지정가 넣기</button>
     <button type="button" class="rt-ca-btn" data-rt-ca="SET_TP">TP 설정</button>
     <button type="button" class="rt-ca-btn" data-rt-ca="SET_SL">SL 설정</button>
     <button type="button" class="rt-ca-btn long" data-rt-ca="LIMIT_LONG">⚡ 롱 지정가</button>
     <button type="button" class="rt-ca-btn short" data-rt-ca="LIMIT_SHORT">⚡ 숏 지정가</button>
     <button type="button" class="rt-ca-btn" data-rt-ca="CLEAR" aria-label="선택 취소">✕</button>
    </div>`;
  }else{
   slot.innerHTML='<div class="rt-chart-hint">💡 차트에서 원하는 가격을 클릭하면 지정가·TP·SL 설정 또는 바로 롱/숏 지정가 주문을 넣을 수 있습니다. (휠: 확대/축소 · 드래그: 이동)</div>';
  }
 };

 const mountChart=()=>{
  const c=mountEl.querySelector('[data-rt-canvas]');
  if(!c)return;
  if(chartCanvas===c&&chartInst){pushChartData();return}
  chartInst?.destroy();
  chartCanvas=c;
  chartInst=createRealTradeChart(c,{
   onSelectPrice:px=>{
    state.selectedPrice=px;
    renderClickBarOnly();
   },
  });
  pushChartData();
 };

 const render=()=>{
  mountEl.hidden=!state.visible;
  if(!state.visible)return;
  const activeSearch=mountEl.querySelector('[data-rt-dd-search]')===document.activeElement;
  const selStart=activeSearch?document.activeElement.selectionStart:null;
  mountEl.innerHTML=realTradePanelHTML(state);
  mountChart();
  if(activeSearch){
   const inp=mountEl.querySelector('[data-rt-dd-search]');
   if(inp){inp.focus();if(selStart!=null)inp.setSelectionRange(selStart,selStart)}
  }
 };

 const updatePreviewOnly=()=>{
  const box=mountEl.querySelector('.rt-preview');
  if(box){
   const p=computeOrderPreview(state);
   if(!p){box.className='rt-preview muted';box.innerHTML='수량 또는 금액을 입력하면 예상 증거금·수수료가 자동 계산됩니다.'}
   else{
    box.className=`rt-preview${p.warn?' is-warn':''}`;
    box.innerHTML=`<span>예상 수량 <b>${esc(fmtQty(p.coinQty))}</b></span><span>명목가치 <b>${fmtUsd(p.notionalUSD)}</b></span><span>필요 증거금 <b>${fmtUsd(p.marginUSD)}</b></span><span title="${p.makerEntry?'메이커 진입(0.02%)+시장가 청산(0.05%) 기준':'시장가 진입(0.05%)+시장가 청산(0.05%) 기준'}">왕복 수수료 <b>$${esc(p.estRoundTripFeeUSD.toFixed(2))}</b> <small>(본전 +${esc(p.breakevenMovePct)}% · ROE +${esc(p.breakevenRoePct)}%)</small></span>${p.warn?`<span class="rt-prev-warn">⚠ ${esc(p.warn)}</span>`:''}`;
   }
  }
  pushChartData();
 };

 const fetchMarkets=async()=>{
  if(state.loadingMarkets)return;
  state.loadingMarkets=true;state.marketsError='';
  try{
   const r=await fetch('/api/real/trade/markets',{cache:'no-store'});
   const d=await r.json().catch(()=>({}));
   if(!r.ok)throw Error(d.message||d.error||`HTTP ${r.status}`);
   if(Array.isArray(d.markets))state.markets=d.markets;
  }catch(e){
   state.marketsError=e.message;
  }finally{
   state.loadingMarkets=false;
   const ddList=mountEl.querySelector('[data-rt-dd-list]');
   const ddCount=mountEl.querySelector('[data-rt-dd-count]');
   if(ddList)ddList.innerHTML=marketDropdownRowsHTML(state);
   if(ddCount)ddCount.textContent=`BingX 무기한 선물 전체 ${state.markets.length}종목`;
   if(!ddList&&state.open&&!mountEl.contains(document.activeElement))render();
  }
 };

 const fetchKlines=async({silent=false}={})=>{
  const sym=state.symbol,interval=state.interval,revision=infoRevision,request=++chartRequest;
  if(!sym)return;
  try{
   const r=await fetch(`/api/real/trade/klines?symbol=${encodeURIComponent(sym)}&interval=${encodeURIComponent(interval)}&limit=160`,{cache:'no-store'});
   const d=await r.json().catch(()=>({}));
   if(revision!==infoRevision||sym!==state.symbol||interval!==state.interval||request<lastChartApplied)return;
   if(r.ok&&Array.isArray(d.candles)){
    lastChartApplied=request;
    state.candles=d.candles;
    if(d.candles.length&&state.info&&!fin(state.info.price))state.info.price=d.candles.at(-1)[4];
    pushChartData();
   }
  }catch{}
  if(!silent&&!chartInst)render();
 };

 const fetchInfo=async(symOverride=null)=>{
  const raw=String(symOverride??state.symbol).trim().toUpperCase().replace(/[^A-Z0-9]/g,'');
  const requested=raw.endsWith('USDT')?raw:raw+'USDT';
  const revision=++infoRevision;
  state.symbol=requested;
  state.info=null;state.loadingInfo=true;state.infoError='';render();
  try{
   const r=await fetch(`/api/real/trade/info?symbol=${encodeURIComponent(requested)}`,{cache:'no-store'});
   const d=await r.json().catch(()=>({}));
   if(revision!==infoRevision)return;
   if(!r.ok)throw Error(d.message||d.error||`HTTP ${r.status}`);
   // The server may resolve an alias to its tradable BingX contract.
   if(!d.symbol||(d.requestedSymbol??d.symbol)!==requested)throw Error('선택한 종목과 조회된 종목이 다릅니다.');
   state.info=d;
   state.symbol=d.symbol;
   if(fin(d.availableUSD))state.availableUSD=Number(d.availableUSD);
   const maxL=d.maxLeverage?.long||d.maxLeverage?.short||125;
   if(Number(state.leverage)>maxL)state.leverage=maxL;
   if(state.orderType==='LIMIT'&&!state.limitPrice&&d.price)state.limitPrice=String(d.price);
  }catch(e){
   if(revision===infoRevision){state.info=null;state.infoError=e.message}
  }finally{
   if(revision===infoRevision){
    state.loadingInfo=false;render();
    if(state.info)void fetchKlines({silent:true});
   }
  }
 };

 const fetchOrders=async()=>{
  state.loadingOrders=true;
  try{
   const r=await fetch('/api/real/trade/open-orders',{cache:'no-store'});
   const d=await r.json().catch(()=>({}));
   if(!r.ok)throw Error(d.message||d.error||`HTTP ${r.status}`);
   state.openOrders=Array.isArray(d.orders)?d.orders:[];
  }catch(e){
   state.msg=`미체결 조회 실패: ${e.message}`;state.msgErr=true;
  }finally{
   state.loadingOrders=false;
   if(state.open&&!mountEl.contains(document.activeElement))render();
   else pushChartData();
  }
 };

 const submitOrder=async(side,{overrideType=null,overridePrice=null}={})=>{
  if(state.busy)return;
  const symbol=state.symbol,revision=infoRevision;
  if(state.loadingInfo||state.info?.symbol!==symbol){
   state.msg='선택한 종목의 거래 정보를 먼저 확인하세요.';state.msgErr=true;render();return;
  }
  const orderType=overrideType||state.orderType;
  const limitPrice=overridePrice!=null?String(overridePrice):state.limitPrice;
  const p=computeOrderPreview({...state,orderType,limitPrice});
  if(!state.amount||!(Number(state.amount)>0)){
   state.msg='먼저 주문 수량 또는 금액을 입력하세요.';state.msgErr=true;render();
   mountEl.querySelector('[data-rt-amount]')?.focus();
   return;
  }
  if(p?.warn){state.msg=p.warn;state.msgErr=true;render();return}
  const symDisp=symDisplay();
  const sideKo=side==='LONG'?'롱(매수)':'숏(매도)';
  const typeKo=orderType==='LIMIT'?`지정가 ${limitPrice} USDT`:`시장가 (약 ${fmtPx(state.info?.price)} USDT)`;
  const copyWarn=state.info?.copyHolding?.length?`\n⚠️ 현재 카피 포지션 보유 중(${state.info.copyHolding.map(h=>`${h.direction==='LONG'?'롱':'숏'} ${h.qty}`).join(', ')}) — 수동 추가 주문으로 들어갑니다.\n`:'';
  const tpSl=[state.tpPrice?`TP ${state.tpPrice}`:null,state.slPrice?`SL ${state.slPrice}`:null].filter(Boolean).join(' · ');
  const confirmMsg=`⚠️ BingX 실계좌 주문 확인${copyWarn}\n종목: ${symDisp}\n방향: ${sideKo}\n방식: ${typeKo}\n배율: ${state.leverage}배 (${state.marginMode==='ISOLATED'?'격리':'교차'})\n예상 수량: ${p?fmtQty(p.coinQty):state.amount} (필요 증거금 약 ${p?fmtUsd(p.marginUSD):'—'})${tpSl?`\nTP/SL: ${tpSl}`:''}\n\n실제 자금으로 주문을 전송할까요?`;
  const curMarket=(state.markets||[]).find(m=>m.displaySymbol===symDisplay());
  const basePx=orderType==='LIMIT'?Number(limitPrice):(state.info?.price??curMarket?.lastPrice??null);
  let resolvedSl=state.slPrice!==''?Number(state.slPrice):null;
  if(resolvedSl==null&&state.slRoePct>0&&basePx>0&&Number(state.leverage)>0){
   const dir=side==='LONG'?1:-1;
   const raw=basePx*(1-dir*(state.slRoePct/100)/Number(state.leverage));
   const tk=Number(state.info?.tickSize);
   if(raw>0){
    if(Number.isFinite(tk)&&tk>0){
     const dec=(String(state.info.tickSize).split('.')[1]||'').length;
     const stepped=dir>0?Math.floor(raw/tk)*tk:Math.ceil(raw/tk)*tk;
     resolvedSl=Number(stepped.toFixed(Math.min(8,dec)));
    }else resolvedSl=Number(raw.toPrecision(6));
   }
  }
  const useMaker=orderType==='MARKET'&&state.makerFirst===true;
  const usePostOnly=orderType==='LIMIT'&&state.postOnly===true;
  if(!window.confirm(confirmMsg+(resolvedSl!=null&&state.slPrice===''?`\n자동 손절(−${state.slRoePct}% ROE): ${resolvedSl} USDT`:'')+(useMaker?'\n방식: 메이커(0.02%) 지정가 2.5초 우선 → 미체결 잔량 시장가':usePostOnly?'\n방식: Post-Only 지정가 (0.02% 메이커 보장 · 즉시 체결 시 자동 취소)':'')))return;
  state.busy=true;state.msg='주문 전송 중…';state.msgErr=false;render();
  try{
   const r=await fetch('/api/real/trade/order',{
    method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({
     confirm:'REAL_MANUAL_ORDER',
     symbol,
     side,
     orderType,
     makerFirst:useMaker,
     postOnly:usePostOnly,
     amountMode:state.amountMode,
     amount:Number(state.amount),
     price:orderType==='LIMIT'?Number(limitPrice):null,
     leverage:Number(state.leverage),
     marginMode:state.marginMode,
     tpPrice:state.tpPrice!==''?Number(state.tpPrice):null,
     slPrice:resolvedSl,
    }),
   });
   const d=await r.json().catch(()=>({}));
   if(!r.ok)throw Error(d.message||d.error||`HTTP ${r.status}`);
   // A new draft may already be open when the submitted order is acknowledged.
   if(revision===infoRevision){
    state.msg=`✅ 주문 완료: ${d.summary||symDisp}`;state.msgErr=false;
    state.amount='';state.tpPrice='';state.slPrice='';state.selectedPrice=null;
    await Promise.all([fetchOrders(),fetchInfo(symbol)]);
   }else await fetchOrders();
   onOrderDone();
  }catch(e){
   state.msg=`❌ 주문 실패: ${e.message}`;state.msgErr=true;
  }finally{state.busy=false;render()}
 };

 // Periodic 5s live chart + open-orders (every 10s) refresh while panel is expanded
 let rtTick=0;
 setInterval(()=>{
  if(!state.visible||!state.open||document.hidden)return;
  rtTick++;
  void fetchKlines({silent:true});
  if(rtTick%2===0&&!state.loadingOrders)void fetchOrders();
  if(state.dropdownOpen)void fetchMarkets();
 },5000);

 mountEl.addEventListener('input',e=>{
  const t=e.target;
  if(t.matches('[data-rt-dd-search]')){
   state.marketQuery=t.value;
   const ddList=mountEl.querySelector('[data-rt-dd-list]');
   if(ddList)ddList.innerHTML=marketDropdownRowsHTML(state);
   return;
  }
  if(t.matches('[data-rt-leverage]')){state.leverage=Number(t.value)||1;updatePreviewOnly();return}
  if(t.matches('[data-rt-limit-price]')){state.limitPrice=t.value;updatePreviewOnly();return}
  if(t.matches('[data-rt-amount]')){state.amount=t.value;updatePreviewOnly();return}
  if(t.matches('[data-rt-tp]')){state.tpPrice=t.value;pushChartData();return}
  if(t.matches('[data-rt-sl]')){state.slPrice=t.value;if(t.value!=='')state.slRoePct=null;pushChartData();return}
 });

 mountEl.addEventListener('click',e=>{
  if(e.target.closest('[data-rt-toggle]')){
   state.open=!e.target.closest('details')?.open;
   if(state.open){
    if(!state.markets.length)void fetchMarkets();
    if(!state.info)void fetchInfo(state.symbol);
    else void fetchKlines({silent:true});
    void fetchOrders();
    setTimeout(()=>mountChart(),30);
   }
   return;
  }
  // Favorite star toggle (works inside dropdown and top bar)
  const favBtn=e.target.closest('[data-rt-fav]');
  if(favBtn){
   e.stopPropagation();
   const sym=favBtn.dataset.rtFav;
   if(state.favorites.has(sym))state.favorites.delete(sym);
   else state.favorites.add(sym);
   saveFavs(state.favorites);
   render();
   return;
  }
  if(e.target.closest('[data-rt-dd-toggle]')){
   e.stopPropagation();
   state.dropdownOpen=!state.dropdownOpen;
   if(state.dropdownOpen&&!state.markets.length)void fetchMarkets();
   render();
   if(state.dropdownOpen)mountEl.querySelector('[data-rt-dd-search]')?.focus();
   return;
  }
  if(e.target.closest('[data-rt-dd-close]')){e.stopPropagation();state.dropdownOpen=false;render();return}
  const ddTab=e.target.closest('[data-rt-dd-tab]');
  if(ddTab){e.stopPropagation();state.marketTab=ddTab.dataset.rtDdTab;render();return}
  const ddSort=e.target.closest('[data-rt-dd-sort]');
  if(ddSort){
   e.stopPropagation();
   const k=ddSort.dataset.rtDdSort;
   if(state.marketSortBy===k)state.marketSortDir=state.marketSortDir==='desc'?'asc':'desc';
   else{state.marketSortBy=k;state.marketSortDir=k==='name'?'asc':'desc'}
   render();return;
  }
  if(e.target.closest('[data-rt-refresh-markets]')){e.stopPropagation();void fetchMarkets();return}
  const pick=e.target.closest('[data-rt-pick-sym]');
  if(pick){
   e.stopPropagation();
   state.dropdownOpen=false;
   state.limitPrice='';state.selectedPrice=null;state.candles=[];
   void fetchInfo(pick.dataset.rtPickSym);
   return;
  }
  if(e.target.closest('[data-rt-dropdown]')){e.stopPropagation();return}
  // Chart controls
  const tfBtn=e.target.closest('[data-rt-tf]');
  if(tfBtn){
   state.interval=tfBtn.dataset.rtTf;
   render();
   void fetchKlines({silent:true});
   return;
  }
  if(e.target.closest('[data-rt-ema]')){state.showEma=!state.showEma;render();return}
  if(e.target.closest('[data-rt-chart-latest]')){chartInst?.resetPan();return}
  if(e.target.closest('[data-rt-refresh-chart]')){void fetchKlines({silent:true});return}
  // Chart click-to-trade action bar
  const ca=e.target.closest('[data-rt-ca]');
  if(ca){
   const act=ca.dataset.rtCa,px=state.selectedPrice;
   if(act==='CLEAR'){state.selectedPrice=null;chartInst?.clearSelection();renderClickBarOnly();return}
   if(act==='SET_LIMIT'&&fin(px)){state.orderType='LIMIT';state.limitPrice=String(px);render();return}
   if(act==='SET_TP'&&fin(px)){state.tpPrice=String(px);render();return}
   if(act==='SET_SL'&&fin(px)){state.slPrice=String(px);state.slRoePct=null;render();return}
   if(act==='LIMIT_LONG'&&fin(px)){state.orderType='LIMIT';state.limitPrice=String(px);void submitOrder('LONG',{overrideType:'LIMIT',overridePrice:px});return}
   if(act==='LIMIT_SHORT'&&fin(px)){state.orderType='LIMIT';state.limitPrice=String(px);void submitOrder('SHORT',{overrideType:'LIMIT',overridePrice:px});return}
  }
  // Ticket controls
  const mm=e.target.closest('[data-rt-margin]');
  if(mm){state.marginMode=mm.dataset.rtMargin;render();return}
  const lp=e.target.closest('[data-rt-lev-preset]');
  if(lp){state.leverage=Number(lp.dataset.rtLevPreset);render();return}
  const ot=e.target.closest('[data-rt-otype]');
  if(ot){
   state.orderType=ot.dataset.rtOtype;
   if(state.orderType==='LIMIT'&&!state.limitPrice&&state.info?.price)state.limitPrice=String(state.info.price);
   render();return;
  }
  if(e.target.closest('[data-rt-maker]')){
   state.makerFirst=!state.makerFirst;
   render();return;
  }
  if(e.target.closest('[data-rt-post-only]')){
   state.postOnly=!state.postOnly;
   render();return;
  }
  const slRoe=e.target.closest('[data-rt-sl-roe]');
  if(slRoe){
   const v=Number(slRoe.dataset.rtSlRoe);
   state.slRoePct=v>0?v:null;
   state.slPrice='';
   render();return;
  }
  if(e.target.closest('[data-rt-fill-price]')){
   const p=state.info?.price??(state.markets||[]).find(m=>m.displaySymbol===symDisplay())?.lastPrice;
   if(p){state.limitPrice=String(p);render()}
   return;
  }
  const am=e.target.closest('[data-rt-amode]');
  if(am){state.amountMode=am.dataset.rtAmode;render();return}
  const pct=e.target.closest('[data-rt-pct]');
  if(pct){
   const avail=Number(state.availableUSD);
   const p=Number(pct.dataset.rtPct)/100;
   const lev=Math.max(1,Number(state.leverage)||1);
   const execPx=state.orderType==='LIMIT'?Number(state.limitPrice):Number(state.info?.price);
   if(!(avail>0)){state.msg='가용 증거금을 먼저 확인하세요';state.msgErr=true;render();return}
   const marginTarget=avail*p;
   if(state.amountMode==='MARGIN_USDT')state.amount=marginTarget.toFixed(2);
   else if(state.amountMode==='NOTIONAL_USDT')state.amount=(marginTarget*lev).toFixed(2);
   else if(execPx>0){
    const step=Number(state.info?.quantityStep)||0;
    const raw=marginTarget*lev/execPx;
    const q=step>0?Math.floor(raw/step)*step:raw;
    state.amount=String(+q.toPrecision(6));
   }
   render();return;
  }
  const sub=e.target.closest('[data-rt-submit]');
  if(sub){void submitOrder(sub.dataset.rtSubmit);return}
  if(e.target.closest('[data-rt-refresh-orders]')){void fetchOrders();return}
  const cancel=e.target.closest('[data-rt-cancel-order]');
  if(cancel){
   const oid=cancel.dataset.rtCancelOrder,vs=cancel.dataset.rtCancelSym;
   if(!window.confirm(`${displaySymbol(vs.replace(/[-_]/g,''))} 미체결 주문을 취소할까요?`))return;
   state.busy=true;state.msg='주문 취소 중…';state.msgErr=false;render();
   fetch('/api/real/trade/cancel-order',{
    method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({confirm:'REAL_MANUAL_CANCEL',symbol:vs,orderId:oid}),
   }).then(async r=>{
    const d=await r.json().catch(()=>({}));
    if(!r.ok)throw Error(d.message||d.error||`HTTP ${r.status}`);
    state.msg=`✅ ${d.summary||'주문 취소 완료'}`;state.msgErr=false;
    await fetchOrders();onOrderDone();
   }).catch(err=>{state.msg=`❌ 취소 실패: ${err.message}`;state.msgErr=true}).finally(()=>{state.busy=false;render()});
  }
 });

 // Close market dropdown on genuine outside click (ignore nodes detached by render()) or Escape key
 document.addEventListener('click',e=>{
  if(!state.dropdownOpen)return;
  if(e.target&&e.target.isConnected===false)return;
  if(!mountEl.querySelector('.rt-pair-anchor')?.contains(e.target)){
   state.dropdownOpen=false;
   render();
  }
 });
 document.addEventListener('keydown',e=>{
  if(e.key==='Escape'&&state.dropdownOpen){state.dropdownOpen=false;render()}
 });

 return {
  syncContext({visible,availableUSD,equityUSD,heldPositions,safety}){
   const changedVis=state.visible!==Boolean(visible);
   state.visible=Boolean(visible);
   if(fin(availableUSD))state.availableUSD=Number(availableUSD);
   if(fin(equityUSD))state.equityUSD=Number(equityUSD);
   if(safety!==undefined)state.safety=safety;
   if(Array.isArray(heldPositions))state.heldPositions=heldPositions;
   if(!state.visible){mountEl.hidden=true;return}
   if(changedVis||!mountEl.innerHTML){render();return}
   // Live-update chart position overlays & header balance without disturbing active form inputs!
   const curPos=(state.heldPositions||[]).find(p=>displaySymbol(p.symbol)===symDisplay());
   if(curPos?.mark&&state.info)state.info.price=curPos.mark;
   pushChartData();
   if(!mountEl.contains(document.activeElement)){
    const sum=mountEl.querySelector('.rt-fold > summary small');
    if(sum)sum.textContent=`${symDisplay()} ${fmtPx(state.info?.price)} · 전 종목 드롭다운 · 차트 직접 주문 · 미체결 ${state.openOrders.length}건 · 가용 ${fmtUsd(state.availableUSD)}`;
   }
  },
  prefill({symbol,side,leverage,marginMode,orderType,limitPrice,tpPrice,slPrice,note}={}){
   if(!state.visible)return;
   state.open=true;state.dropdownOpen=false;
   if(symbol)state.symbol=symbol;
   const normSide=String(side||'').toUpperCase();
   state.suggestedSide=['LONG','SHORT'].includes(normSide)?normSide:null;
   if(Number(leverage)>=1)state.leverage=Math.round(Number(leverage));
   if(['CROSSED','ISOLATED'].includes(String(marginMode||'').toUpperCase()))state.marginMode=String(marginMode).toUpperCase();
   const normType=String(orderType||'').toUpperCase();
   if(['MARKET','LIMIT'].includes(normType))state.orderType=normType;
   const lp=Number(limitPrice);
   if(Number.isFinite(lp)&&lp>0){
    state.orderType='LIMIT';
    state.limitPrice=String(+lp.toPrecision(6));
    state.selectedPrice=lp;
   }else{
    state.limitPrice='';state.selectedPrice=null;
   }
   const tp=Number(tpPrice);
   state.tpPrice=Number.isFinite(tp)&&tp>0?String(+tp.toPrecision(6)):'';
   const sl=Number(slPrice);
   state.slPrice=Number.isFinite(sl)&&sl>0?String(+sl.toPrecision(6)):'';
   state.slRoePct=null;
   state.candles=[];
   state.msg=note?String(note):(state.suggestedSide?`📌 ${state.suggestedSide==='LONG'?'롱':'숏'} 방향 지정가 입력됨`:'');state.msgErr=false;
   void fetchInfo(state.symbol);
   if(!state.markets.length)void fetchMarkets();
   void fetchOrders();
   mountEl.scrollIntoView?.({behavior:'smooth',block:'nearest'});
  },
 };
}
