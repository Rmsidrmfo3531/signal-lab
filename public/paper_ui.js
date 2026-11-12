import {notifyOn} from './notify_settings.js';
// PC/mobile paper dashboard. Only an explicit click changes settings or a position's stop/TP;
// a stop/TP change also moves the linked live order when live trading is on.
const find=id=>document.getElementById(id);
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmt=value=>value!==null&&value!==undefined&&value!==''&&Number.isFinite(Number(value))?Number(value).toLocaleString('en-US',{maximumFractionDigits:8}):'—';
const usd=value=>value!==null&&value!==undefined&&value!==''&&Number.isFinite(Number(value))?`${Number(value)>=0?'+':''}$${Number(value).toFixed(2)}`:'—';
const time=at=>at?new Date(at).toLocaleString('ko-KR',{timeZone:'Asia/Seoul',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}):'—';
const resultClass=n=>Number(n)>=0?'paper-profit':'paper-loss';
const paperEventLabel=e=>e.type==='OPEN'?'가상 진입':'가상 CLOSE';
const providerUnavailable=row=>row.market==='TRADFI';
const frozenPaperCaption='공급자 없음 · 기록 보존 · 자동처리 중지';
const timeGap=(value,limit)=>!(Number.isFinite(Number(value))&&Date.now()-Number(value)<limit);
// Execution venue of a paper record; records before the venue switch used Binance prices.
const PAPER_VENUE_LABELS={BINGX:'BingX',GATEIO:'Gate.io'};
// Manual stop/TP editor. Filled targets are locked; the server validates and rounds to the tick.
const LEVEL_REASONS={STOP_ALREADY_CROSSED:'손절가가 이미 현재가를 넘었습니다',STOP_INVALID:'손절가 숫자 오류',STOP_BEYOND_TARGET:'손절가가 목표가보다 바깥에 있습니다',
 MANUAL_STOP_EXCEEDS_RISK_LIMIT:'실주문 1회 손실 한도를 넘는 손절폭입니다',LIVE_STOP_NOT_PLACED:'거래소에 새 손절 주문을 넣지 못했습니다(기존 손절 유지)',
 POSITION_NOT_FOUND:'포지션이 이미 종료되었습니다',SYMBOL_BUSY:'거래소 주문 처리 중입니다. 잠시 후 다시 시도하세요',LIVE_POSITION_FLAT:'거래소 포지션이 이미 없습니다'};
const levelReason=r=>LEVEL_REASONS[r]||(/^TP(\d)_ALREADY_FILLED$/.test(r)?r[2]+'차 목표는 이미 체결되어 바꿀 수 없습니다':/^TP(\d)_NOT_BEYOND_PRICE$/.test(r)?r[2]+'차 목표가 현재가보다 수익 방향에 있어야 합니다':
 /^TP(\d)_NOT_BEYOND_ENTRY$/.test(r)?r[2]+'차 목표가 진입가보다 수익 방향에 있어야 합니다':/^TP(\d)_ORDER$/.test(r)?r[2]+'차 목표 순서가 맞지 않습니다':r);
function filledTargets(t){const q=t.targetQuantities,f=(t.closeParts||[]).filter(x=>x.type==='TARGET');
 return [0,1,2].map(i=>q?f.filter(x=>x.targetNumber===i+1).reduce((a,x)=>a+x.qty,0)>=q[i]*(1-1e-9):f.some(x=>x.targetNumber===i+1))}
function dcaCaption(t){
 const d=t.dca;if(!d||!Array.isArray(d.adds))return '';
 const next=d.adds.find(a=>!a.filled),full=d.full||{};
 return `<small class="paper-management-mode">매물대 분할 ${d.filledAdds||0}/${d.adds.length}회 추가${next?` · 다음 ${fmt(next.price)} (${esc(next.units)}단위)`:''} · 손절(매물대) ${fmt(t.stop)} · 교차 ${esc(d.leverage)}배 · 전부 체결 후 손절 시 손실 약 $${Number.isFinite(full.maxLossUSD)?full.maxLossUSD.toFixed(2):"—"} (잔고 ${Number.isFinite(full.maxLossPct)?full.maxLossPct.toFixed(1):'—'}%)${Number.isFinite(full.liquidationPrice)?' · 추정 청산가 '+fmt(full.liquidationPrice):''}</small>`;
}
function levelsEditor(t){
 if(providerUnavailable(t))return '';const filled=filledTargets(t);
 return `<details class="paper-levels" data-levels-key="${esc(t.key)}"><summary>손절·TP 직접 수정</summary>
  <form data-levels-form="${esc(t.key)}"><label>손절 <input name="stop" inputmode="decimal" value="${esc(t.stop)}"></label>
  ${[0,1,2].map(i=>`<label>${i+1}차 TP <input name="tp${i}" inputmode="decimal" value="${esc(t.targets?.[i])}" ${filled[i]?'disabled title="이미 체결됨"':''}></label>`).join('')}
  <button type="submit">적용</button><small data-levels-msg>현재가 기준으로 검사하고 거래소 가격 단위로 맞춥니다. 실주문이 켜져 있으면 거래소 주문도 함께 바뀝니다.</small></form></details>`;
}
function captureLevelDrafts(){const drafts=new Map();if(typeof document.querySelectorAll!=='function')return drafts;document.querySelectorAll('[data-levels-key]').forEach(d=>{
 const form=d.querySelector('form'),values={};form?.querySelectorAll('input').forEach(i=>{values[i.name]=i.value});
 drafts.set(d.dataset.levelsKey,{open:d.open,values,focus:document.activeElement?.closest?.('[data-levels-key]')===d?document.activeElement.name:null})});return drafts}
function restoreLevelDrafts(drafts){if(typeof document.querySelectorAll!=='function')return;document.querySelectorAll('[data-levels-key]').forEach(d=>{const draft=drafts.get(d.dataset.levelsKey);if(!draft?.open)return;
 d.open=true;d.querySelectorAll('input').forEach(i=>{if(!i.disabled&&draft.values[i.name]!==undefined)i.value=draft.values[i.name]});if(draft.focus)d.querySelector(`input[name="${draft.focus}"]`)?.focus()})}
function paperVenueBadge(t){const label=PAPER_VENUE_LABELS[t?.executionVenue];return `<small class="paper-venue">${label?esc(label)+' 호가':'Binance 시세(이전 기록)'}</small>`}
// Leverage shown on a position: the stored one, else (positions opened by an older version) the
// same rule the server uses now, from the stored score and market cap, marked as recalculated.
const MCAP_STEPS=[50e6,100e6,200e6,500e6,1e9,2e9,5e9,10e9,30e9,100e9];
function positionLeverage(t){
 if(Number(t?.leverage)>0)return {value:Number(t.leverage),estimated:false};
 const score=Number(t?.score);if(!Number.isFinite(score))return null;
 const cap=Number(t?.marketCap),capPts=cap>0?MCAP_STEPS.filter(x=>cap>=x).length:0;
 return {value:Math.max(10,Math.min(30,10+Math.max(0,Math.min(10,Math.floor(score-90+1e-9)))+capPts)),estimated:true};
}
function reasonLine(t){
 const r=Array.isArray(t?.entryReasons)?t.entryReasons:[];
 return `<p class="pos-reasons"><span>진입 이유</span>${esc(t.pattern||'')}${r.length?' · '+r.map(x=>esc(x)).join(' · '):Number.isFinite(t?.score)?'':' · 이전 기록(세부 근거 없음)'}</p>`;
}
function targets(row){return (row.targets||[]).map((p,i)=>`<span>${i+1}차 ${fmt(p)} / ${[40,35,25][i]}%</span>`).join(' · ')}
function paperManagementCaption(row){
 const management=row.managementVersion??row.management?.version;
 if(management!=='VOLUME_PROFILE_V1')return '기존 기록 · 저장된 TP/SL 보존';
 const moved=row.breakevenMovedAt??row.beMovedAt??row.management?.breakevenMovedAt;
 const basis=row.breakevenMode==='COST_COVERED'?' · 비용 보전 가정 (무손실 보장 아님)':row.breakevenMode==='ENTRY_FILL'||row.breakevenMode==='ENTRY'?' · 평균 진입체결가 기준':'';
 const kind=/^SCALP_REVERSAL_(1M|5M|15M)$/.test(row.strategy||'')?`${({SCALP_REVERSAL_1M:'1분',SCALP_REVERSAL_5M:'5분',SCALP_REVERSAL_15M:'15분'})[row.strategy]} 단타 되돌림 TP(50·62·79%)${Number.isFinite(row.maxHoldMs)?' · '+Math.round(row.maxHoldMs/60000)+'분 시간 청산':''}`:'실제 체결량 매물대 TP';
 return kind+' · '+(moved?'TP1 목표 물량 체결 완료 후 본절 이동 확인':row.moveStopToBreakeven===false||row.tp1MoveStopToBreakeven===false?'본절 이동 OFF':'TP1 목표 물량 체결 완료 확인 전 · 손절 유지')+basis;
}
let lastBreakevenSetting=null,lastBreakevenMode=null,paperManagementSaving=false;
function renderPaperManagementSetting(settings){
 const control=find('paperBreakevenToggle'),modeControl=find('paperBreakevenMode'),status=find('paperBreakevenStatus');if(!control||!status)return;
 const value=settings?.TP1_MOVE_STOP_TO_BREAKEVEN??settings?.tp1MoveStopToBreakeven,mode=settings?.TP1_BREAKEVEN_MODE,
  knownMode=['ENTRY_FILL','COST_COVERED'].includes(mode);
 if(modeControl){modeControl.disabled=paperManagementSaving||!knownMode;if(knownMode)modeControl.value=mode}
 lastBreakevenMode=knownMode?mode:null;
 if(typeof value!=='boolean'){control.disabled=true;status.textContent='신규 포지션 설정 조회 미완료 · 기존 TP/SL 보존';return}
 lastBreakevenSetting=value;control.checked=value;control.disabled=paperManagementSaving;
 const basis=mode==='COST_COVERED'?'비용 보전 가정 · 실제 무손실 보장 아님':mode==='ENTRY_FILL'?'평균 진입체결가':'본절 기준 조회 미완료';
 status.textContent=(value?'신규 포지션 본절 이동 ON · TP1 40% 체결 완료 후':'신규 포지션 본절 이동 OFF')+' · '+basis+' · 기존 TP/SL 보존';
}
const breakevenControl=find('paperBreakevenToggle');
const breakevenModeControl=find('paperBreakevenMode');
async function savePaperManagementSetting(update){
 if(paperManagementSaving)return;
 paperManagementSaving=true;if(breakevenControl)breakevenControl.disabled=true;if(breakevenModeControl)breakevenModeControl.disabled=true;
 let failure=null;
 try{const response=await fetch('/api/paper/settings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(update)});
  const body=await response.json();if(!response.ok)throw Error(body.error||'설정 저장 실패');
  renderPaperManagementSetting(body.settings??body);await loadPaper();
 }catch(error){failure=error.message}
 finally{paperManagementSaving=false;renderPaperManagementSetting({TP1_MOVE_STOP_TO_BREAKEVEN:lastBreakevenSetting,TP1_BREAKEVEN_MODE:lastBreakevenMode});if(failure)find('paperBreakevenStatus').textContent='설정 변경 실패 · '+failure}
}
breakevenControl?.addEventListener('change',async()=>{
 if(typeof lastBreakevenSetting!=='boolean'||paperManagementSaving)return;
 const enabled=breakevenControl.checked;await savePaperManagementSetting({TP1_MOVE_STOP_TO_BREAKEVEN:enabled});
});
breakevenModeControl?.addEventListener('change',async()=>{
 const mode=breakevenModeControl.value;if(!['ENTRY_FILL','COST_COVERED'].includes(mode)||lastBreakevenMode===null||paperManagementSaving)return;
 await savePaperManagementSetting({TP1_BREAKEVEN_MODE:mode});
});

async function submitLevels(form){
 const key=form.dataset.levelsForm,msg=form.querySelector('[data-levels-msg]'),button=form.querySelector('button');
 const value=name=>{const i=form.querySelector(`input[name="${name}"]`);return !i||i.disabled||i.value.trim()===''?null:Number(i.value)};
 const body={key,stop:value('stop'),targets:[value('tp0'),value('tp1'),value('tp2')]};
 if([body.stop,...body.targets].some(v=>v!==null&&!(Number.isFinite(v)&&v>0))){msg.textContent='가격은 0보다 큰 숫자로 입력하세요.';return}
 button.disabled=true;msg.textContent='적용 중…';
 try{const resp=await fetch('/api/paper/levels',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const data=await resp.json().catch(()=>({}));
  if(!resp.ok||!data.ok){msg.textContent='적용 안 됨: '+(data.reasons||['HTTP_'+resp.status]).map(levelReason).join(' · ');return}
  const live=data.live?.live?(data.live.errors?.length?' · 거래소 일부 실패: '+data.live.errors.join(', '):' · 거래소 주문도 변경됨'):'';
  msg.textContent=data.changed?`적용됨: 손절 ${fmt(data.levels.stop)} · TP ${data.levels.targets.map(fmt).join(' / ')}${live}`:'바뀐 값이 없습니다.';
  form.closest('details').open=false;loadPaper();
 }catch(e){msg.textContent='적용 실패: '+e.message}finally{button.disabled=false}
}
find('paperOpen')?.addEventListener('submit',e=>{const form=e.target.closest?.('[data-levels-form]');if(!form)return;e.preventDefault();submitLevels(form)});
function renderMonitor(payload){
 const m=payload.monitor;
 if(!m){find('paperMonitorTitle').textContent='● 모의매매 상태 정보를 받지 못했습니다';return}
 const classes={TRACKING:'paper-ok',WATCHING:'paper-ok',WAITING:'paper-warn',DELAYED:'paper-warn',OFFLINE:'paper-down'};
 const cls=classes[m.state]||'paper-warn';
 const root=document.querySelector('.paper-monitor'),badge=find('paperLiveIndicator');
 root.classList.remove('paper-ok','paper-warn','paper-down');root.classList.add(cls);
 badge.classList.remove('paper-ok','paper-warn','paper-down');badge.classList.add(cls);
 badge.textContent=`● ${m.state==='TRACKING'?'가상 포지션 추적 중':m.state==='WATCHING'?'자동 신호 감시 중':m.state==='DELAYED'?'시세 지연':'진입 조건 확인 중'}`;
 find('paperMonitorTitle').textContent='● '+m.label;
 find('paperMonitorChecked').textContent='서버 확인 '+time(m.checkedAt)+' KST';
 find('paperMonitorMode').textContent=`진행 ${payload.openCount} · 대기 ${payload.pendingCount} · 종료 ${payload.closedCount}`;
 find('paperMonitorQuotes').textContent=`시세 ${m.cryptoQuotesFresh?'수신 정상':'지연/미수신'}`;
 find('paperMonitorTrades').textContent=`접수 ${Number.isFinite(m.acceptedSignals)?m.acceptedSignals:'미확인'}건 / 진입 ${Number.isFinite(m.openedCountSession)?m.openedCountSession:'미확인'}건 · 시세 확인 ${Number.isFinite(m.priceTickCount)?m.priceTickCount:'미확인'}회`;
 find('paperMonitorEvent').textContent=m.lastPositionEventAt?time(m.lastPositionEventAt):'이번 실행 중 신규 거래 없음';
 find('paperMonitorReason').textContent=m.reason+' · 실거래 주문 없음 · 접수/진입 횟수는 현재 서버 실행 이후 기준';
 find('paperOpenHeading').textContent=`현재 가상 포지션 ${payload.openCount}건 · 신규 진입 대기 ${payload.pendingCount}건`;
 find('paperClosedHeading').textContent=`가상 청산 완료 기록 · 총 ${payload.closedCount}건 (최신 200건 표시, 수수료 공제)`;
}
function render(payload){
 if(!payload||payload.mode!=='SIMULATION_ONLY')return;
 renderPaperManagementSetting(payload.settings);
 renderMonitor(payload);
 const summaries=[
  `${payload.closedCount}건`,
  `<span class="${resultClass(payload.netRealizedUSD)}">${usd(payload.netRealizedUSD)}</span>`,
  payload.winRatePct===null?'자료 부족':`${payload.winRatePct.toFixed(1)}%`,
  `<span class="${resultClass(payload.unrealizedUSD)}">${usd(payload.unrealizedUSD)}</span>`,
  `$${Number(payload.maxClosedTradeDrawdownUSD||0).toFixed(2)}`
 ];
 // Per-strategy table: compare each group with its backtest separately.
 const groups=(payload.breakdown||[]).filter(g=>g.trades>0);
 const breakdownBox=find('paperBreakdown');
 if(breakdownBox)breakdownBox.innerHTML=groups.length?`<table><caption>전략별 성과 (종료 거래)</caption><thead><tr><th>전략</th><th>건수</th><th>승률</th><th>손익</th><th>PF</th><th>평균 R</th></tr></thead><tbody>`+
  groups.map(g=>`<tr><td>${esc(g.label)}</td><td>${g.trades}</td><td>${g.winRatePct==null?'—':g.winRatePct.toFixed(0)+'%'}</td><td class="${resultClass(g.netUSD)}">${usd(g.netUSD)}</td><td>${g.profitFactor==null?'—':Number(g.profitFactor).toFixed(2)}</td><td>${g.averageR==null?'—':(g.averageR>=0?'+':'')+Number(g.averageR).toFixed(2)+'R'}</td></tr>`).join('')+'</tbody></table>'
  :'<p class="empty-small">전략별 성과: 아직 종료된 거래가 없습니다.</p>';
 find('paperMetrics').innerHTML=summaries.map((x,i)=>`<div><span>${['종료 거래','누적 실현 PNL','승률 (종료)','평가 손익 (참고)','종료 거래 낙폭'][i]}</span><strong>${x}</strong></div>`).join('');
 find('paperStatus').textContent=`시작자금·계좌잔고 가정 없음 · ${payload.newPositionSizing==='VALIDATED_PROFILE_QUANTITY'?'신규 거래는 검증된 매물대·위험 수량 사용 / 구버전 명목 기록 보존':'구버전 모의 기준 명목 $'+fmt(payload.paperNotionalUSD)} · 누적 평가손익 ${usd(payload.totalMarkedPnLUSD)} · 진행 ${payload.openCount}건 · 진입 대기 ${payload.pendingCount}건 · 오늘 ${usd(payload.dailyPnLUSD)} · 이번 주 ${usd(payload.weeklyPnLUSD)} · ${payload.assumptions}`;
 const open=[...(payload.open||[])];
 const cards=open.map(t=>{
  const frozen=providerUnavailable(t),stale=frozen||timeGap(t.lastPriceAt,90000);
  const dir=t.direction==='LONG'?1:-1,gain=t.qtyRemaining*dir*(t.markPrice-t.entryFill);
  const lev=positionLeverage(t),margin=lev?t.qtyRemaining*t.entryFill/lev.value:null,roe=margin>0?gain/margin*100:null;
  const liq=lev?t.entryFill*(1-dir*(1/lev.value-.005)):null;
  const base=esc(String(t.symbol||'').replace(/USDT$/,''));
  const rows=t.closeParts?.map(p=>`<small>${p.type==='STOP'?'손절':p.type==='TIME'?'시간 청산':p.targetNumber+'차 익절'} ${fmt(p.fill)} · ${usd(p.profitUSD-p.feeUSD)}</small>`).join('')||'';
  const cell=(label,value,cls='')=>`<div class="pos-cell ${cls}"><span>${label}</span><b>${value}</b></div>`;
  return `<article class="paper-trade paper-position"><header class="position-head">
    <strong class="pos-symbol">${esc(t.symbol)}</strong><span class="pos-side ${t.direction==='LONG'?'paper-long':'paper-short'}">${t.direction==='LONG'?'롱':'숏'}</span>
    <span class="pos-lev" title="${lev?.estimated?'예전 버전에서 열린 포지션: 점수로 다시 계산한 배율':'배율'}">${lev?lev.value+'X'+(lev.estimated?'*':''):'배율 미설정'}</span>
    <span class="pos-venue">${esc(PAPER_VENUE_LABELS[t.executionVenue]||'Binance 시세(이전 기록)')}</span>
    ${Number.isFinite(t.score)?`<span class="pos-score">${esc(t.score)}점</span>`:''}
    <span class="pos-meta">${esc(t.pattern)} · ${time(t.openedAt)} 진입 · ${frozen?frozenPaperCaption:'진행 중'}</span></header>
   <div class="position-grid">
    ${cell('수량',`${fmt(t.qtyRemaining)} ${base}${t.originalQty&&t.originalQty!==t.qtyRemaining?` <small>/ 처음 ${fmt(t.originalQty)}</small>`:''}`)}
    ${cell(frozen?'마지막 저장 시세 평가 (현재 평가 아님)':'미실현 손익',`<span class="${resultClass(gain)}">${usd(gain)}${roe!=null?` (${roe>=0?'+':''}${roe.toFixed(2)}%)`:''}</span>${frozen?' <small>최신 시세 미검증</small>':stale?' <small>시세 지연</small>':''}`)}
    ${cell('증거금',margin!=null?'$'+margin.toFixed(2):'—')}
    ${cell('진입가',fmt(t.entryFill))}
    ${cell('현재가',fmt(t.markPrice))}
    ${cell('예상 청산가 <small>격리 가정</small>',liq!=null&&liq>0?fmt(liq):'—')}
    ${cell('손절',fmt(t.stop))}
    ${cell('명목금액','$'+(t.qtyRemaining*t.entryFill).toFixed(2))}
   </div>
   ${reasonLine(t)}
   <p class="paper-targets">${targets(t)}</p><small class="paper-management-mode">${esc(paperManagementCaption(t))} · 분할익절 ${t.exitedPct||0}% · 수수료 등 $${fmt(t.feesUSD)}</small>
   <div class="paper-partials">${rows||''}${frozen?'<small>'+frozenPaperCaption+' · 저장된 TP/SL을 실행하거나 변경하지 않습니다.</small>':!rows?'<small>첫 익절 또는 손절 대기 중</small>':''}</div>${t.manualLevels?'<small class="paper-management-mode">손절·TP 직접 수정됨</small>':''}${dcaCaption(t)}${levelsEditor(t)}</article>`;
 });
 const pending=(payload.pending||[]).map(t=>{
  const frozen=providerUnavailable(t);
  return `<article class="paper-trade paper-pending"><header><strong>${esc(t.symbol)} ${paperVenueBadge(t)} ${esc(t.direction)}</strong><span>${frozen?frozenPaperCaption:'첫 신규 시세 대기'}</span></header><p>${esc(t.pattern)} · ${time(t.signalAt)} 접수 · ${frozen?'기록된 유효기한 ':' '}${time(t.expiresAt)}${frozen?'':' 만료'}</p>${frozen?`<p>진입·만료 처리를 중지하고 기존 대기 기록을 보존합니다. 최신 시세 미검증.</p><p>기록된 진입 ${fmt(t.entry)} · 손절 ${fmt(t.stop)}</p><p class="paper-targets">${targets(t)}</p>`:`<p>과거 캔들 가격에서 소급 진입하지 않습니다.</p><p>손절 ${fmt(t.stop)} · <span class="paper-targets">${targets(t)}</span></p>${dcaCaption(t)}${levelsEditor(t)}`}${Number.isFinite(t.score)||t.entryReasons?.length?reasonLine(t):''}</article>`;
 });
 const drafts=captureLevelDrafts();
 find('paperOpen').innerHTML=[...pending,...cards].join('')||'<p class="empty-small">현재 열린 가상 포지션이 없습니다. 새 시그널 이후 자동 기록합니다.</p>';
 restoreLevelDrafts(drafts);
 find('paperClosed').innerHTML=(payload.closed||[]).map(t=>{
  const parts=(t.closeParts||[]).map(p=>`<small>${p.type==='STOP'?'잔여 손절':p.type==='TIME'?'시간 청산':p.targetNumber+'차 익절'} · ${time(p.at)} · ${fmt(p.fill)} · ${usd(p.profitUSD-p.feeUSD)}</small>`).join('');
  return `<article class="paper-trade"><header><strong>${esc(t.symbol)} ${paperVenueBadge(t)} <span class="${t.direction==='LONG'?'paper-long':'paper-short'}">${t.direction}</span></strong><strong class="${resultClass(t.realizedPnLUSD)}">${usd(t.realizedPnLUSD)}</strong></header><p>${esc(t.market)} · ${esc(t.pattern)}${providerUnavailable(t)?' · '+frozenPaperCaption:''}</p><div class="paper-trade-values"><span>진입 <b>${fmt(t.entryFill)}</b></span><span>종료 <b>${time(t.closedAt)}</b></span><span>명목 <b>$${fmt(t.notionalUSD)}</b></span><span>총 수수료 <b>$${fmt(t.feesUSD)}</b></span></div><p>종료 사유: ${esc(t.closeReason)}${t.quoteGaps?' · 가격 수신 공백 '+t.quoteGaps+'회':''}</p><div class="paper-partials">${parts}</div></article>`;
 }).join('')||'<p class="empty-small">아직 자동으로 종료된 거래가 없습니다. 거래 내역은 앞으로 발생하는 신호부터 누적됩니다.</p>';
 find('paperSkipped').innerHTML=(payload.skipped||[]).map(t=>`<p>${time(t.at)} · ${esc(t.key)}<br><small>${esc(t.reason)}</small></p>`).join('')||'생략된 신호 없음';
}
let active=false;
async function loadPaper(){if(active)return;active=true;try{const resp=await fetch('/api/paper',{cache:'no-store'});if(!resp.ok)throw Error('HTTP '+resp.status);render(await resp.json())}catch(e){find('paperStatus').textContent='모의매매 조회 불가 · '+String(e.message);find('paperMonitorTitle').textContent='● 서버 연결 또는 조회 오류 · 자동 추적 확인 불가';find('paperLiveIndicator').textContent='● 모의매매 연결 확인 필요'}finally{active=false}}
find('paperRefresh').addEventListener('click',loadPaper);
const live=new EventSource('/events');live.addEventListener('paper',loadPaper);
live.addEventListener('status',()=>{});
// Poll is a failover for browsers that suspend background EventSource and for mark-to-market changes.
setInterval(loadPaper,12000);
loadPaper();

// PC/mobile share the same saved event history and toggle. Native notifications
// are generated by the Windows Node server, even if this browser is closed.
let lastPaperNoticeStatus=null;
function renderPaperNotices(data){
  if(!data)return;
  lastPaperNoticeStatus=data;
  find('paperNoticeToggle').textContent=data.enabled?'🔔 Windows 알림 켜짐':'🔕 Windows 알림 꺼짐';
  find('paperNoticeToggle').setAttribute('aria-pressed',data.enabled?'true':'false');
  const tg=data.telegram||{},tgButton=find('paperTelegramToggle');
  if(tgButton){
    tgButton.textContent=!tg.configured?'📱 텔레그램 미설정':tg.enabled?'📱 텔레그램 모의 알림 켜짐':'📵 텔레그램 모의 알림 꺼짐';
    tgButton.setAttribute('aria-pressed',tg.enabled?'true':'false');tgButton.disabled=!tg.configured||tg.forced===true;
    tgButton.title=!tg.configured?'.env에 TELEGRAM_BOT_TOKEN과 TELEGRAM_CHAT_ID가 있어야 합니다':tg.forced?'PAPER_TELEGRAM 설정으로 고정됨':'모의 진입·청산을 휴대폰 텔레그램으로도 받습니다';
  }
  find('paperNoticeStatus').textContent=data.windowsSupported
    ? (data.enabled?'PC Windows 알림 활성화 · 방해 금지 설정에 따라 표시되지 않을 수 있음':'Windows 알림 비활성화')
    : '현재 서버는 Windows가 아닙니다. 이력 표시만 지원합니다.';
  if(data.enabled&&data.lastDelivery&&!data.lastDelivery.ok)find('paperNoticeStatus').textContent=deliveryText(data.lastDelivery);
  find('paperNoticeHistory').innerHTML=(data.history||[]).map(e=>
    `<div><strong>${esc(e.symbol)} · ${esc(e.direction)} · ${paperEventLabel(e)}</strong>`+
    `<small>${time(e.at)} KST · ${e.type==='OPEN'?'모의 진입 '+fmt(e.entryFill):'모의 종료 '+esc(e.closeReason)+' · 총 PNL '+usd(e.realizedPnLUSD)} · 실제 주문 없음</small></div>`
  ).join('')||'아직 발생한 자동 가상 진입·종료 알림이 없습니다.';
}
async function loadPaperNotices(){
  try{const r=await fetch('/api/paper/notifications',{cache:'no-store'});if(!r.ok)throw Error('HTTP '+r.status);renderPaperNotices(await r.json());}
  catch(e){find('paperNoticeStatus').textContent='알림 설정 조회 실패 · '+e.message;}
}
find('paperTelegramToggle')?.addEventListener('click',async()=>{
  if(!lastPaperNoticeStatus?.telegram?.configured)return;
  const value=!lastPaperNoticeStatus.telegram.enabled;
  try{const r=await fetch('/api/paper/notifications/settings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({telegram:value})});
    if(!r.ok)throw Error((await r.json()).error||'텔레그램 설정 변경 실패');await loadPaperNotices();}
  catch(e){find('paperNoticeStatus').textContent=e.message;}
});
find('paperNoticeToggle').addEventListener('click',async()=>{
  if(!lastPaperNoticeStatus)return;
  const value=!lastPaperNoticeStatus.enabled;
  try{const r=await fetch('/api/paper/notifications/settings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({enabled:value})});
    if(!r.ok)throw Error((await r.json()).error||'알림 설정 변경 실패');await loadPaperNotices();}
  catch(e){find('paperNoticeStatus').textContent=e.message;}
});
// Second channel that does not depend on Windows notification settings: a browser
// notification (localhost may show them once allowed) plus a short sound, while this page is open.
function browserNotice(title,body,{test=false}={}){
  if(!test&&!notifyOn('paperScreen'))return;
  if(notifyOn('sound'))try{
    const ctx=new (window.AudioContext||window.webkitAudioContext)(),o=ctx.createOscillator(),g=ctx.createGain();
    o.frequency.value=880;g.gain.value=.08;o.connect(g);g.connect(ctx.destination);o.start();o.stop(ctx.currentTime+.18);
  }catch{}
  try{if('Notification' in window&&Notification.permission==='granted')new Notification(title,{body,tag:'signal-lab-paper-'+Date.now()});}catch{}
}
async function ensureBrowserNoticePermission(){
  try{if('Notification' in window&&Notification.permission==='default')await Notification.requestPermission();}catch{}
  return 'Notification' in window?Notification.permission:'unsupported';
}
const deliveryText=d=>!d?'':d.ok?(d.method==='TOAST'?'Windows 알림 표시됨(알림 센터에 \'Windows PowerShell\'로 표시)':'Windows 트레이 풍선 알림 표시됨')
  :'Windows 알림 실패: '+(d.error||'원인 미상')+' → 설정 > 시스템 > 알림에서 알림과 \'Windows PowerShell\'을 켜고, 방해 금지(집중 지원)를 끄세요.';
async function testPaperNotice(type){
  const button=find(type==='CLOSE'?'paperNoticeTestClose':'paperNoticeTest');button.disabled=true;
  const permission=await ensureBrowserNoticePermission();
  try{const r=await fetch('/api/paper/notifications/test',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({type})});const data=await r.json();
    if(!r.ok)throw Error(data.error||'알림 테스트 실패');
    browserNotice(type==='CLOSE'?'[SIM 테스트] BTCUSDT LONG CLOSE':'[SIM 테스트] BTCUSDT LONG 진입','모의 테스트 알림 · 실제 주문 없음',{test:true});
    find('paperNoticeStatus').textContent=(data.delivery.queued?'Windows에 표시 요청함. 결과 확인 중…':data.delivery.reason)+
      (permission==='granted'?' · 브라우저 알림 보냄':permission==='denied'?' · 브라우저 알림 차단됨(주소창 자물쇠 → 알림 허용)':'')+
      (data.telegram?.queued?' · 텔레그램 보냄':'');
  }catch(e){find('paperNoticeStatus').textContent='알림 테스트 오류: '+e.message}
  finally{button.disabled=false}
}
live.addEventListener('paper-notify-result',e=>{try{find('paperNoticeStatus').textContent=deliveryText(JSON.parse(e.data))}catch{}});
find('paperNoticeTest').addEventListener('click',()=>testPaperNotice('OPEN'));
find('paperNoticeTestClose').addEventListener('click',()=>testPaperNotice('CLOSE'));
let paperLiveTimer;
live.addEventListener('paper-event',e=>{
  try{const item=JSON.parse(e.data);
    const box=find('paperNoticeLive');box.hidden=false;
    box.textContent=`🔔 ${item.symbol} ${item.direction} ${paperEventLabel(item)} · `+(item.type==='OPEN'?`진입 ${fmt(item.entryFill)}`:`최종 PNL ${usd(item.realizedPnLUSD)}`)+' · 모의 거래';
    clearTimeout(paperLiveTimer);paperLiveTimer=setTimeout(()=>box.hidden=true,10000);
    browserNotice(`[SIM] ${item.symbol} ${item.direction} ${item.type==='OPEN'?'진입':'CLOSE'}`,box.textContent);
    void loadPaperNotices();
  }catch{}
});
live.addEventListener('paper-notify-settings',loadPaperNotices);
setInterval(loadPaperNotices,20000);
loadPaperNotices();
