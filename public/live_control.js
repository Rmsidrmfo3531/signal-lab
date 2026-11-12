// 실매매 (live / testnet) screen. Calls only this server's /api/live endpoints; no keys are ever
// sent or shown here. Orders change only on an explicit click (activate, kill, stop/TP edit).
import {priceFmt} from './price_format.js';

const LABEL={BINGX:'BingX',GATEIO:'Gate.io'};
const MODE={OFF:{badge:'OFF',text:'주문 없음',title:'실매매 (꺼짐)',cls:'off'},TESTNET:{badge:'TESTNET',text:'모의 자금',title:'실매매 (테스트넷)',cls:'testnet'},
 LIVE:{badge:'LIVE',text:'실제 돈',title:'실매매 (실거래)',cls:'live'}};
export const modeInfo=mode=>MODE[mode]||{badge:String(mode||'?'),text:'확인 필요',title:'실매매',cls:'off'};
const LIVE_STATUS={SUBMITTING:'주문 접수 중',OPEN:'보유 중',CLOSED:'종료',FAILED:'주문 실패',UNKNOWN:'확인 필요'};
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fin=v=>v!==null&&v!==undefined&&v!==''&&Number.isFinite(Number(v));
const qtyFmt=v=>fin(v)?Number(v).toLocaleString('en-US',{maximumFractionDigits:8}):'—';
const usd=v=>fin(v)?`${Number(v)>=0?'+':'−'}$${Math.abs(Number(v)).toFixed(2)}`:'—';
const money=v=>fin(v)?'$'+Number(v).toLocaleString('en-US',{maximumFractionDigits:2,minimumFractionDigits:2}):'—';
const pnlClass=v=>!fin(v)?'':Number(v)>=0?'paper-profit':'paper-loss';
const time=at=>at?new Date(at).toLocaleString('ko-KR',{timeZone:'Asia/Seoul',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}):'—';
const clock=at=>at?new Date(at).toLocaleTimeString('ko-KR',{timeZone:'Asia/Seoul',hour:'2-digit',minute:'2-digit'}):'—';
const side=d=>d==='LONG'?'<span class="paper-long">롱</span>':d==='SHORT'?'<span class="paper-short">숏</span>':esc(d);

/** Status box lines (label, value). */
export function liveRows(s){
 const L=s.limits||{},b=s.balance;
 const balance=!b?'—':b.error?`조회 실패 (${b.error})`:fin(b.usd)?`${money(b.usd)} ${LABEL[b.venue]||b.venue||''} 순자산${b.capUSD?` · 계산은 최대 $${b.capUSD}까지`:''}${b.at?` · ${clock(b.at)} 확인`:''}`:'조회 중';
 return [['상태',(s.armed?'활성화됨 · 신호가 오면 주문':'비활성 · 주문 안 함')+(s.killSwitch?' · 긴급 정지 중':'')],
  ['거래소',(s.venues||[]).map(v=>LABEL[v]||v).join(' · ')||'—'],['잔고',balance],
  ['API 키',['BINGX','GATEIO'].map(v=>`${LABEL[v]} ${s.credentialsConfigured?.[v]?'설정됨':'없음'}`).join(' · ')],
  ...(L.sizing==='BALANCE'?[['수량',`잔고${L.balanceCapUSD?`(최대 $${L.balanceCapUSD})`:''} × ${L.unitPct}% × 배율, 매물대 분할 추매`],['손실 한도',`1회 잔고 ${L.maxLossPct}% · 하루 ${L.dailyMaxLossPct}%`]]
   :[['손실 한도',`1회 $${L.maxRiskUSD} · 하루 $${L.dailyMaxRiskUSD}`]]),
  ['동시 포지션',`${L.maxOpen??'—'}개${L.maxPerDirection?` (롱·숏 각 ${L.maxPerDirection}개)`:''}`]];
}

export function modeBadgeHTML(s){
 const m=modeInfo(s.mode);
 const state=s.killSwitch?'<b class="live-flag kill">긴급 정지 중</b>':s.mode==='OFF'?'<b class="live-flag">주문 안 함</b>':s.armed?'<b class="live-flag armed">활성화됨</b>':'<b class="live-flag">비활성</b>';
 return `<div class="live-mode ${m.cls}"><strong>${esc(m.badge)}</strong><span>${esc(m.text)}</span></div>${state}`;
}

function levelsEditor(p){
 if(p.status!=='OPEN')return '';
 const pf=priceFmt(p),plain=v=>fin(v)?pf(v).replace(/,/g,''):'';
 return `<details class="paper-levels" data-live-levels-key="${esc(p.signalKey)}"><summary>손절·TP 직접 수정</summary>
  <form data-live-levels="${esc(p.signalKey)}"><label>손절 <input name="stop" inputmode="decimal" value="${esc(plain(p.stop))}"></label>
  ${[0,1,2].map(i=>`<label>TP${i+1} <input name="tp${i}" inputmode="decimal" value="${esc(plain(p.targets?.[i]))}" ${i===0&&p.targetsFilled?.tp1?'disabled title="이미 체결됨"':''}></label>`).join('')}
  <button type="submit">적용</button><small data-levels-msg>현재가로 검사한 뒤 거래소 주문을 바꿉니다 (새 손절을 먼저 넣고 옛 손절을 취소).</small></form></details>`;
}

/** One open live position as a multi-line card. */
export function positionCardHTML(p){
 const pf=priceFmt(p),u=p.unrealized,q=p.quantity||{};
 const qty=`${qtyFmt(q.base)} ${esc(p.asset)}${q.unit==='CONTRACT'&&fin(q.venue)?` (${qtyFmt(q.venue)}계약)`:''}`;
 const pending=p.adds?.pending||[];
 const addsLine=pending.length?pending.map(a=>`${a.n}차 ${pf(a.price)} · ${qtyFmt(a.qty)} ${esc(p.asset)}`).join(' / '):'없음';
 const curNote=p.currentPriceSource==='EXCHANGE'?'거래소 표시가':p.currentPriceSource==='VENUE_BOOK'?'거래소 호가 중간값':'시세 대기';
 const pnl=u?`<b class="${pnlClass(u.usd)}">${usd(u.usd)}${fin(u.pct)?` (${Number(u.pct)>=0?'+':''}${Number(u.pct).toFixed(2)}%)`:''}</b><small>${u.source==='EXCHANGE'?'거래소 계산':'추정 (평균가·현재가)'}${fin(u.pct)?' · 증거금 대비':''}</small>`:'<b>—</b><small>시세 대기</small>';
 const ev=p.lastEvent?`${esc(p.lastEvent.label)}${p.lastEvent.reason?' · '+esc(p.lastEvent.reason):''} · ${time(p.lastEvent.at)}`:'—';
 return `<article class="paper-trade live-position${p.status==='UNKNOWN'?' live-warn':''}">
 <header><b>${esc(p.symbol)}</b>${side(p.direction)}<span>${fin(p.leverage)?esc(p.leverage)+'배 교차':'배율 —'} · ${esc(LABEL[p.venue]||p.venue)}</span><span class="live-state s-${esc(p.status)}">${esc(p.statusKo||LIVE_STATUS[p.status]||p.status)}</span></header>
 <div class="paper-trade-values live-values">
  <span>첫 진입가<b>${pf(p.firstEntryPrice)}</b></span>
  <span>평균 진입가<b>${pf(p.averageEntryPrice)}</b></span>
  <span>현재가<b>${pf(p.currentPrice)}</b><small>${curNote}</small></span>
  <span>수량<b>${qty}</b></span>
  <span>미실현 손익${pnl}</span>
  <span>추매<b>${esc(p.adds?.filled??0)}차 / 최대 ${esc(p.adds?.max??0)}차</b>${p.adds?.skipped?`<small>주문 못 낸 추매 ${esc(p.adds.skipped)}건</small>`:''}</span>
  <span>손절가<b>${pf(p.stop)}</b>${p.breakevenMoved?'<small>TP1 체결 후 본절 이동</small>':''}</span>
  <span>TP1 · TP2 · TP3<b>${(p.targets||[]).map(pf).join(' · ')||'—'}</b>${p.targetsFilled?.tp1?'<small>TP1 체결됨</small>':''}</span>
 </div>
 <p class="live-line"><span>대기 중인 추매 주문</span>${addsLine}</p>
 <p class="live-line"><span>최근 처리</span>${ev}</p>
 ${p.status==='UNKNOWN'?'<p class="live-line live-warn-text">주문 결과를 확인하지 못했습니다. 거래소 앱에서 포지션·주문을 직접 확인한 뒤 긴급 정지를 해제하세요.</p>':''}
 ${levelsEditor(p)}
</article>`;
}

function realizedHTML(r){
 if(!r||r.source==='PENDING')return '<b>—</b><small>거래소 정산 확인 중</small>';
 if(r.source==='UNKNOWN'||!fin(r.netUSD))return '<b>—</b><small>확인 불가 (거래소 기록 없음)</small>';
 if(r.source==='EXCHANGE')return `<b class="${pnlClass(r.netUSD)}">${usd(r.netUSD)}</b><small>거래소 정산 · 손익 ${usd(r.pnlUSD)} · 수수료 ${usd(r.feeUSD)}${fin(r.fundingUSD)&&Number(r.fundingUSD)!==0?' · 펀딩 '+usd(r.fundingUSD):''}</small>`;
 return `<b class="${pnlClass(r.netUSD)}">${usd(r.netUSD)} 추정</b><small>추정 · 시세 기준 청산가 · 수수료 ${fin(r.takerRate)?(r.takerRate*100).toFixed(2)+'% 가정':'가정'} · 펀딩 미반영</small>`;
}
/** One closed live trade. */
export function closedCardHTML(c){
 const pf=priceFmt(c);
 return `<article class="paper-trade live-closed">
 <header><b>${esc(c.symbol)}</b>${side(c.direction)}<span>${fin(c.leverage)?esc(c.leverage)+'배':''} · ${esc(LABEL[c.venue]||c.venue)}</span>${c.test?'<span class="live-state">시험 주문 (합계 제외)</span>':''}<span>${esc(c.closeReasonKo)}</span></header>
 <div class="paper-trade-values">
  <span>진입 → 종료<b>${time(c.createdAt)} → ${time(c.closedAt)}</b></span>
  <span>평균 진입가<b>${pf(c.averageEntryPrice)}</b></span>
  <span>추매<b>${esc(c.adds?.filled??0)}차 / 최대 ${esc(c.adds?.max??0)}차</b></span>
  <span>실현 손익 (수수료 반영)${realizedHTML(c.realized)}</span>
 </div>
 ${c.deletable?`<button type="button" class="ghost small" data-live-delete="${esc(c.signalKey)}">기록 삭제</button>`:''}
</article>`;
}

export function summaryHTML(m){
 const s=m||{};
 return `<div><span>종료 거래</span><strong>${esc(s.trades??0)}건</strong></div>
 <div><span>승률</span><strong>${fin(s.winRatePct)?Number(s.winRatePct).toFixed(1)+'%':'—'}</strong><small>${esc(s.wins??0)}승 ${esc(s.losses??0)}패</small></div>
 <div><span>누적 실현 손익 (수수료 반영)</span><strong class="${pnlClass(s.netUSD)}">${usd(s.netUSD)}</strong></div>
 <div><span>계산 근거</span><strong>${esc(s.settled??0)}건</strong><small>${s.estimated?`추정 ${esc(s.estimated)}건 포함`:'거래소 정산 기준'}${s.pending?` · 정산 대기 ${esc(s.pending)}건`:''}${s.unknown?` · 확인 불가 ${esc(s.unknown)}건`:''}</small></div>`;
}

export function skippedHTML(list){
 if(!list?.length)return '<li>없음</li>';
 return list.slice(0,12).map(x=>`<li><b>${clock(x.at)} ${esc(x.symbol||'')}</b> ${esc((x.reasonsKo?.length?x.reasonsKo:x.reasons||[]).join(' · '))}</li>`).join('');
}

const LEVEL_REASONS={STOP_ALREADY_CROSSED:'손절가가 이미 현재가를 넘었습니다',STOP_INVALID:'손절가 숫자 오류',STOP_BEYOND_TARGET:'손절가가 목표가보다 바깥에 있습니다',
 MANUAL_STOP_EXCEEDS_RISK_LIMIT:'1회 손실 한도를 넘는 손절폭입니다',LIVE_STOP_NOT_PLACED:'거래소에 새 손절 주문을 넣지 못했습니다(기존 손절 유지)',
 POSITION_NOT_FOUND:'포지션이 이미 종료되었습니다',SYMBOL_BUSY:'거래소 주문 처리 중입니다. 잠시 후 다시 시도하세요',LIVE_POSITION_FLAT:'거래소 포지션이 이미 없습니다',
 PRICE_UNAVAILABLE:'현재가를 아직 받지 못했습니다. 잠시 후 다시 시도하세요',LIVE_MODE_OFF:'실매매가 꺼져 있습니다'};
export const levelReason=r=>LEVEL_REASONS[r]||(/^TP(\d)_ALREADY_FILLED$/.test(r)?`TP${r[2]}은 이미 체결되어 바꿀 수 없습니다`:/^TP(\d)_NOT_BEYOND_PRICE$/.test(r)?`TP${r[2]}이 현재가보다 수익 방향에 있어야 합니다`:
 /^TP(\d)_NOT_BEYOND_ENTRY$/.test(r)?`TP${r[2]}이 평균 진입가보다 수익 방향에 있어야 합니다`:/^TP(\d)_ORDER$/.test(r)?`TP${r[2]} 순서가 맞지 않습니다`:r);

function recordsRows(records){
 if(!records?.length)return '<tr><td colspan="8">주문 기록 없음</td></tr>';
 return records.map(r=>`<tr><td>${time(r.createdAt)}</td><td>${esc(LABEL[r.venue]||r.venue)}</td><td>${esc(r.symbol)}</td><td>${esc(r.direction)}</td><td>${esc(r.quantity?.total??'—')} ${r.quantity?.unit==='CONTRACT'?'계약':''}</td><td>$${Number(r.plannedRiskUSD||0).toFixed(2)}</td><td>${esc(LIVE_STATUS[r.status]||r.status)}${r.test?' · 시험':''}</td><td>${r.lastEvent?esc(r.lastEvent.type+(r.lastEvent.reason?' · '+r.lastEvent.reason:'')):'—'}${r.deletable?` <button type="button" class="ghost small" data-live-delete="${esc(r.signalKey)}">삭제</button>`:''}</td></tr>`).join('');
}

function render(o){
 const $=id=>document.getElementById(id),m=modeInfo(o.mode);
 for(const [id,text] of [['liveHeading',m.title],['navLiveLabel',m.title]])if($(id))$(id).textContent=text;
 if($('navLiveMode'))$('navLiveMode').textContent=m.badge;
 if($('liveModeBadge'))$('liveModeBadge').innerHTML=modeBadgeHTML(o);
 const status=$('liveStatus');
 if(status){status.replaceChildren(...liveRows(o).map(([k,v])=>{const row=document.createElement('div'),dt=document.createElement('span'),dd=document.createElement('b');
  row.className='kv-row';dt.textContent=k;dd.textContent=v;row.append(dt,dd);return row}));status.classList.toggle('warn',Boolean(o.killSwitch||o.mode==='LIVE'))}
 if($('liveTest'))$('liveTest').hidden=o.mode!=='TESTNET';
 if($('livePaperNote'))$('livePaperNote').hidden=!o.paperTrading;
 const box=$('livePositions');
 if(box){
  // Keep an open stop/TP editor (and what was typed) across the periodic refresh.
  const drafts=new Map();box.querySelectorAll('[data-live-levels-key]').forEach(d=>{if(d.open){const v={};d.querySelectorAll('input').forEach(i=>{v[i.name]=i.value});drafts.set(d.dataset.liveLevelsKey,v)}});
  box.innerHTML=o.positions?.length?o.positions.map(positionCardHTML).join(''):`<p class="empty-small">${o.mode==='OFF'?'실매매가 꺼져 있습니다.':o.armed?'보유 중인 포지션이 없습니다. 최종 신호를 기다리는 중입니다.':'보유 중인 포지션이 없습니다. “활성화”를 눌러야 신호에 주문이 나갑니다.'}</p>`;
  box.querySelectorAll('[data-live-levels-key]').forEach(d=>{const v=drafts.get(d.dataset.liveLevelsKey);if(!v)return;d.open=true;d.querySelectorAll('input').forEach(i=>{if(!i.disabled&&v[i.name]!==undefined)i.value=v[i.name]})});
 }
 if($('livePositionCount'))$('livePositionCount').textContent=`${o.positions?.length||0}개`;
 if($('liveSummary'))$('liveSummary').innerHTML=summaryHTML(o.summary);
 if($('liveClosed'))$('liveClosed').innerHTML=o.closed?.length?o.closed.map(closedCardHTML).join(''):'<p class="empty-small">아직 종료된 실매매 거래가 없습니다.</p>';
 if($('liveSkipped'))$('liveSkipped').innerHTML=skippedHTML(o.skipped);
 if($('liveRecords'))$('liveRecords').innerHTML=recordsRows(o.records);
 if($('liveUpdated'))$('liveUpdated').textContent=`${clock(o.at)} 갱신`;
}

if(typeof document!=='undefined'&&document.getElementById('liveControl')){
 const $=id=>document.getElementById(id);
 let mode='OFF';
 const fail=e=>{const s=$('liveError');if(s){s.hidden=false;s.textContent='실매매 요청 실패: '+e.message}};
 const load=async()=>{const r=await fetch('/api/live/overview',{cache:'no-store'}),d=await r.json();if(!r.ok)throw Error(d.error||'HTTP '+r.status);mode=d.mode;if($('liveError'))$('liveError').hidden=true;render(d);return d};
 const post=async(path,body)=>{const r=await fetch(path,{method:'POST',cache:'no-store',headers:{'Content-Type':'application/json'},body:JSON.stringify(body||{})}),d=await r.json();if(!r.ok)throw Error(d.error||(d.reasons||[]).join(', ')||'HTTP '+r.status);await load();return d};
 $('liveRefresh')?.addEventListener('click',()=>load().catch(fail));
 $('liveArm')?.addEventListener('click',()=>{
  const text=mode==='LIVE'?'실거래(실제 돈)를 활성화합니다. 다음 최종 신호부터 거래소에 실제 돈으로 주문이 나갑니다. 계속할까요?':'테스트넷(모의 자금) 주문을 활성화합니다. 다음 최종 신호부터 테스트넷 거래소에 주문이 나갑니다. 계속할까요?';
  if(confirm(text))post('/api/live/arm',{confirm:'ARM'}).catch(fail)});
 $('liveDisarm')?.addEventListener('click',()=>post('/api/live/disarm').catch(fail));
 $('liveKill')?.addEventListener('click',()=>post('/api/live/kill').catch(fail));
 $('liveResetKill')?.addEventListener('click',()=>{if(confirm('긴급 정지를 해제합니다. 거래소 계정 상태를 먼저 확인하셨나요?'))post('/api/live/reset-kill',{confirm:'RESET'}).catch(fail)});
 $('liveTest')?.addEventListener('click',async()=>{
  if(!confirm('BingX 테스트넷에서 DOGE 소액 롱(잔고 최대 $400 기준, 10배)을 실제 신호와 같은 순서로 주문하고 5초 뒤 청산합니다. 먼저 "활성화"가 되어 있어야 합니다. 진행할까요?'))return;
  const s=$('liveTestResult');if(!s)return;s.hidden=false;s.textContent='시험 주문 진행 중… (10~20초)';
  try{const r=await fetch('/api/live/test-order',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({confirm:'TEST'})}),d=await r.json();
   await load().catch(()=>{});
   if(!r.ok){s.textContent='시험 주문 불가: '+(d.error||'HTTP '+r.status);return}
   const head=d.ok?'시험 주문 성공: 진입 → 보호 주문 → 청산까지 정상':'시험 주문 결과: '+(d.status||'')+' '+(d.reasons||[]).join(', ');
   s.replaceChildren(Object.assign(document.createElement('b'),{textContent:head}),...(d.events||[]).map(e=>Object.assign(document.createElement('div'),{textContent:`· ${e.type}${e.reason?' — '+e.reason:''}`})));
  }catch(e){s.textContent='시험 주문 요청 실패: '+e.message}
 });
const DELETE_REASONS={ACTIVE:'보유 중이거나 확인이 필요한 거래는 삭제할 수 없습니다',TODAY_COUNTS_FOR_DAILY_RISK:'오늘 종료된 거래는 하루 손실 한도 계산에 쓰여 내일부터 삭제할 수 있습니다',NOT_FOUND:'이미 삭제된 기록입니다'};
 document.addEventListener('click',async e=>{
  const b=e.target.closest?.('[data-live-delete]');if(!b)return;
  if(!confirm('이 기록을 삭제합니다. 되돌릴 수 없습니다. 계속할까요?'))return;
  try{const r=await fetch('/api/live/delete',{method:'POST',cache:'no-store',headers:{'Content-Type':'application/json'},body:JSON.stringify({key:b.dataset.liveDelete})}),d=await r.json();
   if(!r.ok)throw Error(DELETE_REASONS[d.reason]||d.reason||'HTTP '+r.status);await load()}catch(err){fail(err)}
 });
 document.addEventListener('submit',async e=>{
  const form=e.target.closest?.('form[data-live-levels]');if(!form)return;e.preventDefault();
  const msg=form.querySelector('[data-levels-msg]'),button=form.querySelector('button'),val=n=>{const i=form.querySelector(`input[name="${n}"]`);return i&&!i.disabled&&i.value.trim()!==''?Number(i.value.trim()):null};
  if(!confirm('거래소의 손절·목표 주문을 바꿉니다. 계속할까요?'))return;
  button.disabled=true;msg.textContent='거래소 주문 변경 중…';
  try{const r=await fetch('/api/live/levels',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({key:form.dataset.liveLevels,stop:val('stop'),targets:[val('tp0'),val('tp1'),val('tp2')]})}),d=await r.json();
   if(!r.ok||d.ok===false){msg.textContent='변경 안 됨: '+(d.reasons||[d.error]).filter(Boolean).map(levelReason).join(' · ');return}
   msg.textContent=d.changed===false?'바뀐 값이 없습니다':'적용됨'+(d.errors?.length?' (일부 실패: '+d.errors.join(', ')+')':'');
   form.closest('details').open=false;await load();
  }catch(err){msg.textContent='요청 실패: '+err.message}
  finally{button.disabled=false}
 });
 const visible=()=>!$('live')?.hidden;
 const tick=()=>{if(visible())load().catch(fail)};
 setInterval(tick,10000);setTimeout(()=>load().catch(fail),400);window.addEventListener('hashchange',()=>setTimeout(tick,60));
}
