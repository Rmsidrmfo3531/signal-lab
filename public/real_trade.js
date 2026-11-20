// Exchange-style manual trading panel for the BingX real account (#real).
// Mounted in its own DOM container (#realTradePanel) so the 3-second #realCopy refresh never wipes user inputs.
import {displaySymbol} from './symbol_display.js';

const esc=s=>String(s??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
const fin=v=>v!==null&&v!==''&&Number.isFinite(Number(v));
const fmtPx=v=>fin(v)&&Number(v)>0?String(+Number(v).toPrecision(6)):'—';
const fmtUsd=v=>fin(v)?`$${Number(v).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}`:'—';
const fmtQty=v=>fin(v)&&Number(v)>0?String(+Number(v).toPrecision(6)):'—';

const DEFAULT_QUICK_SYMS=['BTCUSDT','ETHUSDT','SOLUSDT'];
const LEVERAGE_PRESETS=[3,5,10,20,50];
const PCT_PRESETS=[10,25,50,75];

const ORDER_TYPE_KO={LIMIT:'지정가',MARKET:'시장가',STOP_MARKET:'손절(SL)',TAKE_PROFIT_MARKET:'익절(TP)',STOP:'스탑 지정가',TAKE_PROFIT:'익절 지정가'};

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
 const warn=!(cleanQty>0)||cleanQty<minQ?`최소 수량(${fmtQty(minQ)}) 미만`
  :minN>0&&notionalUSD<minN?`최소 주문 금액($${minN}) 미만`
  :avail!==null&&marginUSD>avail*0.98?`가용 증거금(${fmtUsd(avail)}) 초과`:null;
 return {qty:cleanQty,coinQty:cleanQty,execPrice,notionalUSD,marginUSD,warn};
}

export function realTradePanelHTML(st){
 const info=st.info;
 const sym=st.symbol||'BTCUSDT';
 const avail=fin(st.availableUSD)?Number(st.availableUSD):null;
 const heldSyms=[...new Set((st.heldPositions||[]).map(p=>displaySymbol(p.symbol)).filter(Boolean))];
 const quickSyms=[...new Set([...heldSyms,...DEFAULT_QUICK_SYMS])].slice(0,8);
 const maxLev=info?.maxLeverage?.long||info?.maxLeverage?.short||125;
 const preview=computeOrderPreview(st);
 const copyHold=info?.copyHolding?.length
  ?`<p class="rt-copy-warn">⚠️ 카피 매매 보유 중 (${info.copyHolding.map(h=>`${h.direction==='LONG'?'롱':'숏'} ${h.qty} · ${h.leverage}배`).join(', ')}) — 수동 추가 주문 가능</p>`:'';
 const specLine=info
  ?`<div class="rt-spec"><span>현재가 <b>${fmtPx(info.price)}</b> USDT</span><span>최소 주문 <b>${info.minNotionalUSDT?`$${esc(info.minNotionalUSDT)}`:'—'}</b>${info.minQuantityBase?` / ${esc(info.minQuantityBase)}`:''}</span><span>최대 <b>${esc(maxLev)}배</b></span><span>가용 <b>${fmtUsd(avail)}</b></span></div>`
  :`<div class="rt-spec muted">${st.loadingInfo?'종목 정보 조회 중…':st.infoError?`<span class="err">${esc(st.infoError)}</span>`:`가용 증거금 <b>${fmtUsd(avail)}</b> · 종목을 입력하고 조회하세요`}</div>`;
 const amtPlaceholder=st.amountMode==='MARGIN_USDT'?'증거금 USDT (예: 50)':st.amountMode==='NOTIONAL_USDT'?'주문 금액 USDT (예: 500)':'코인 수량 (예: 2000)';
 const amtUnit=st.amountMode==='COIN'?displaySymbol(sym).replace(/USDT$/,''):'USDT';
 const previewHtml=preview
  ?`<div class="rt-preview${preview.warn?' is-warn':''}">
     <span>예상 수량 <b>${esc(fmtQty(preview.coinQty))}</b></span>
     <span>명목가치 <b>${fmtUsd(preview.notionalUSD)}</b></span>
     <span>필요 증거금 <b>${fmtUsd(preview.marginUSD)}</b></span>
     ${preview.warn?`<span class="rt-prev-warn">⚠ ${esc(preview.warn)}</span>`:''}
    </div>`
  :`<div class="rt-preview muted">수량 또는 금액을 입력하면 예상 증거금이 자동 계산됩니다.</div>`;
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

 return `<details class="rt-fold"${st.open?' open':''}>
  <summary data-rt-toggle><b>⚡ 수동 매매 · 거래소 주문</b> <small>시장가·지정가 · 증거금/금액/수량 · TP/SL · 미체결 ${orders.length}건 · 가용 ${fmtUsd(avail)}</small></summary>
  <div class="rt-body">
   <div class="rt-ticket">
    <div class="rt-sym-bar">
     <input type="text" class="rt-sym-input" data-rt-symbol value="${esc(sym)}" placeholder="종목 (예: BTC, AKE, SNDK)" maxlength="30" aria-label="주문 종목">
     <button type="button" class="outline-btn small" data-rt-lookup>시세 조회</button>
     <div class="rt-quick-syms">${quickSyms.map(s=>`<button type="button" class="rt-chip${displaySymbol(sym)===s?' is-current':''}" data-rt-pick-sym="${esc(s)}">${esc(s.replace(/USDT$/,''))}</button>`).join('')}</div>
    </div>
    ${specLine}
    ${copyHold}
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
      </div>
     </div>
     <div class="rt-group">
      <span class="rt-lbl">지정가 (USDT)${st.orderType==='LIMIT'&&info?.price?` <button type="button" class="rt-link-btn" data-rt-fill-price>현재가 채우기</button>`:''}</span>
      <input type="number" step="any" data-rt-limit-price value="${esc(st.limitPrice)}" placeholder="${st.orderType==='MARKET'?'시장가 체결':'지정가 입력'}"${st.orderType==='MARKET'?' disabled':''} aria-label="지정가 가격">
     </div>
    </div>
    <div class="rt-group">
     <div class="rt-amt-head">
      <span class="rt-lbl">주문 단위</span>
      <div class="rt-seg">
       <button type="button" class="${st.amountMode==='MARGIN_USDT'?'is-current':''}" data-rt-amode="MARGIN_USDT">증거금 (USDT)</button>
       <button type="button" class="${st.amountMode==='NOTIONAL_USDT'?'is-current':''}" data-rt-amode="NOTIONAL_USDT">주문금액 (USDT)</button>
       <button type="button" class="${st.amountMode==='COIN'?'is-current':''}" data-rt-amode="COIN">코인 수량</button>
      </div>
     </div>
     <div class="rt-amt-input-row">
      <input type="number" step="any" min="0" data-rt-amount value="${esc(st.amount)}" placeholder="${esc(amtPlaceholder)}" aria-label="주문 수량 또는 금액">
      <span class="rt-unit">${esc(amtUnit)}</span>
      <div class="rt-mini-btns">${PCT_PRESETS.map(p=>`<button type="button" data-rt-pct="${p}" title="가용 증거금의 ${p}%">${p}%</button>`).join('')}</div>
     </div>
    </div>
    <div class="rt-row-2">
     <label class="rt-group"><span class="rt-lbl">익절가 TP (선택)</span><input type="number" step="any" min="0" data-rt-tp value="${esc(st.tpPrice)}" placeholder="비우면 설정 안 함"></label>
     <label class="rt-group"><span class="rt-lbl">손절가 SL (선택)</span><input type="number" step="any" min="0" data-rt-sl value="${esc(st.slPrice)}" placeholder="비우면 설정 안 함"></label>
    </div>
    ${previewHtml}
    <div class="rt-submit-row">
     <button type="button" class="rt-btn-long" data-rt-submit="LONG"${st.busy?' disabled':''}>🟢 롱 / 매수${st.orderType==='LIMIT'?' (지정가)':' (시장가)'}</button>
     <button type="button" class="rt-btn-short" data-rt-submit="SHORT"${st.busy?' disabled':''}>🔴 숏 / 매도${st.orderType==='LIMIT'?' (지정가)':' (시장가)'}</button>
    </div>
    <div class="rt-status-msg${st.msgErr?' err':''}" role="status">${esc(st.msg||'')}</div>
   </div>
   <div class="rt-orders">
    <div class="rt-orders-head"><b>미체결 주문 (${orders.length}건)</b><button type="button" class="outline-btn small" data-rt-refresh-orders${st.loadingOrders?' disabled':''}>↻ 새로고침</button></div>
    ${ordersHtml}
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
  limitPrice:'',
  amountMode:'MARGIN_USDT',
  amount:'',
  tpPrice:'',
  slPrice:'',
  availableUSD:null,
  heldPositions:[],
  info:null,
  infoError:'',
  loadingInfo:false,
  openOrders:[],
  loadingOrders:false,
  busy:false,
  msg:'',
  msgErr:false,
 };

 const render=()=>{
  mountEl.hidden=!state.visible;
  if(!state.visible)return;
  mountEl.innerHTML=realTradePanelHTML(state);
 };

 const updatePreviewOnly=()=>{
  const box=mountEl.querySelector('.rt-preview');
  if(!box)return;
  const p=computeOrderPreview(state);
  if(!p){box.className='rt-preview muted';box.innerHTML='수량 또는 금액을 입력하면 예상 증거금이 자동 계산됩니다.';return}
  box.className=`rt-preview${p.warn?' is-warn':''}`;
  box.innerHTML=`<span>예상 수량 <b>${esc(fmtQty(p.coinQty))}</b></span><span>명목가치 <b>${fmtUsd(p.notionalUSD)}</b></span><span>필요 증거금 <b>${fmtUsd(p.marginUSD)}</b></span>${p.warn?`<span class="rt-prev-warn">⚠ ${esc(p.warn)}</span>`:''}`;
 };

 const fetchInfo=async(symOverride=null)=>{
  const raw=(symOverride??state.symbol??'').trim().toUpperCase();
  if(!raw)return;
  state.symbol=raw.endsWith('USDT')?raw:`${raw.replace(/[^A-Z0-9]/g,'')}USDT`;
  state.loadingInfo=true;state.infoError='';render();
  try{
   const r=await fetch(`/api/real/trade/info?symbol=${encodeURIComponent(state.symbol)}`,{cache:'no-store'});
   const d=await r.json().catch(()=>({}));
   if(!r.ok)throw Error(d.message||d.error||`HTTP ${r.status}`);
   state.info=d;
   state.symbol=d.displaySymbol||d.symbol||state.symbol;
   if(fin(d.availableUSD))state.availableUSD=Number(d.availableUSD);
   const maxL=d.maxLeverage?.long||d.maxLeverage?.short||125;
   if(Number(state.leverage)>maxL)state.leverage=maxL;
   if(state.orderType==='LIMIT'&&!state.limitPrice&&d.price)state.limitPrice=String(d.price);
  }catch(e){
   state.info=null;state.infoError=e.message;
  }finally{state.loadingInfo=false;render()}
 };

 const fetchOrders=async()=>{
  state.loadingOrders=true;render();
  try{
   const r=await fetch('/api/real/trade/open-orders',{cache:'no-store'});
   const d=await r.json().catch(()=>({}));
   if(!r.ok)throw Error(d.message||d.error||`HTTP ${r.status}`);
   state.openOrders=Array.isArray(d.orders)?d.orders:[];
  }catch(e){
   state.msg=`미체결 조회 실패: ${e.message}`;state.msgErr=true;
  }finally{state.loadingOrders=false;render()}
 };

 const submitOrder=async side=>{
  const p=computeOrderPreview(state);
  if(p?.warn){state.msg=p.warn;state.msgErr=true;render();return}
  const symDisp=displaySymbol(state.info?.symbol||state.symbol);
  const sideKo=side==='LONG'?'롱(매수)':'숏(매도)';
  const typeKo=state.orderType==='LIMIT'?`지정가 ${state.limitPrice} USDT`:`시장가 (약 ${fmtPx(state.info?.price)} USDT)`;
  const copyWarn=state.info?.copyHolding?.length?`\n⚠️ 현재 카피 포지션 보유 중(${state.info.copyHolding.map(h=>`${h.direction==='LONG'?'롱':'숏'} ${h.qty}`).join(', ')}) — 수동 추가 주문으로 들어갑니다.\n`:'';
  const tpSl=[state.tpPrice?`TP ${state.tpPrice}`:null,state.slPrice?`SL ${state.slPrice}`:null].filter(Boolean).join(' · ');
  const confirmMsg=`⚠️ BingX 실계좌 주문 확인${copyWarn}\n종목: ${symDisp}\n방향: ${sideKo}\n방식: ${typeKo}\n배율: ${state.leverage}배 (${state.marginMode==='ISOLATED'?'격리':'교차'})\n예상 수량: ${p?fmtQty(p.coinQty):state.amount} (필요 증거금 약 ${p?fmtUsd(p.marginUSD):'—'})${tpSl?`\nTP/SL: ${tpSl}`:''}\n\n실제 자금으로 주문을 전송할까요?`;
  if(!window.confirm(confirmMsg))return;
  state.busy=true;state.msg='주문 전송 중…';state.msgErr=false;render();
  try{
   const r=await fetch('/api/real/trade/order',{
    method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({
     confirm:'REAL_MANUAL_ORDER',
     symbol:state.info?.symbol||state.symbol,
     side,
     orderType:state.orderType,
     amountMode:state.amountMode,
     amount:Number(state.amount),
     price:state.orderType==='LIMIT'?Number(state.limitPrice):null,
     leverage:Number(state.leverage),
     marginMode:state.marginMode,
     tpPrice:state.tpPrice!==''?Number(state.tpPrice):null,
     slPrice:state.slPrice!==''?Number(state.slPrice):null,
    }),
   });
   const d=await r.json().catch(()=>({}));
   if(!r.ok)throw Error(d.message||d.error||`HTTP ${r.status}`);
   state.msg=`✅ 주문 완료: ${d.summary||symDisp}`;state.msgErr=false;
   state.amount='';state.tpPrice='';state.slPrice='';
   await Promise.all([fetchOrders(),fetchInfo(state.symbol)]);
   onOrderDone();
  }catch(e){
   state.msg=`❌ 주문 실패: ${e.message}`;state.msgErr=true;
  }finally{state.busy=false;render()}
 };

 mountEl.addEventListener('input',e=>{
  const t=e.target;
  if(t.matches('[data-rt-symbol]')){state.symbol=t.value.toUpperCase();return}
  if(t.matches('[data-rt-leverage]')){state.leverage=Number(t.value)||1;updatePreviewOnly();return}
  if(t.matches('[data-rt-limit-price]')){state.limitPrice=t.value;updatePreviewOnly();return}
  if(t.matches('[data-rt-amount]')){state.amount=t.value;updatePreviewOnly();return}
  if(t.matches('[data-rt-tp]')){state.tpPrice=t.value;return}
  if(t.matches('[data-rt-sl]')){state.slPrice=t.value;return}
 });
 mountEl.addEventListener('keydown',e=>{
  if(e.key==='Enter'&&e.target.matches('[data-rt-symbol]')){e.preventDefault();void fetchInfo(e.target.value)}
 });
 mountEl.addEventListener('click',e=>{
  if(e.target.closest('[data-rt-toggle]')){
   state.open=!e.target.closest('details')?.open;
   if(state.open){if(!state.info)void fetchInfo(state.symbol);void fetchOrders()}
   return;
  }
  const pick=e.target.closest('[data-rt-pick-sym]');
  if(pick){state.limitPrice='';void fetchInfo(pick.dataset.rtPickSym);return}
  if(e.target.closest('[data-rt-lookup]')){state.limitPrice='';void fetchInfo(state.symbol);return}
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
  if(e.target.closest('[data-rt-fill-price]')){
   if(state.info?.price){state.limitPrice=String(state.info.price);render()}
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

 return {
  syncContext({visible,availableUSD,heldPositions}){
   const changedVis=state.visible!==Boolean(visible);
   state.visible=Boolean(visible);
   if(fin(availableUSD))state.availableUSD=Number(availableUSD);
   if(Array.isArray(heldPositions))state.heldPositions=heldPositions;
   if(!state.visible){mountEl.hidden=true;return}
   if(changedVis||!mountEl.innerHTML){render();return}
   // Update only summary/balance without disturbing active form inputs.
   if(!mountEl.contains(document.activeElement)){
    const sum=mountEl.querySelector('.rt-fold > summary small');
    if(sum)sum.textContent=`시장가·지정가 · 증거금/금액/수량 · TP/SL · 미체결 ${state.openOrders.length}건 · 가용 ${fmtUsd(state.availableUSD)}`;
   }
  },
  prefill({symbol,leverage,marginMode}={}){
   if(!state.visible)return;
   state.open=true;
   if(symbol)state.symbol=displaySymbol(symbol);
   if(Number(leverage)>=1)state.leverage=Math.round(Number(leverage));
   if(['CROSSED','ISOLATED'].includes(String(marginMode||'').toUpperCase()))state.marginMode=String(marginMode).toUpperCase();
   state.limitPrice='';
   state.msg='';state.msgErr=false;
   render();
   void fetchInfo(state.symbol);
   void fetchOrders();
   mountEl.scrollIntoView?.({behavior:'smooth',block:'nearest'});
  },
 };
}
