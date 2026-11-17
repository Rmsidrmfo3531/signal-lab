// 실매매 (live / testnet) screen. Calls only this server's /api/live endpoints; no keys are ever
// sent or shown here. Orders change only on an explicit click (activate, kill, stop/TP edit).
import {priceFmt} from './price_format.js';

const LABEL={BINGX:'BingX',GATEIO:'Gate.io'};
const MODE={OFF:{badge:'OFF',text:'주문 없음',title:'실매매 (꺼짐)',cls:'off'},TESTNET:{badge:'TESTNET',text:'모의 자금',title:'실매매 (테스트넷)',cls:'testnet'},
 LIVE:{badge:'LIVE',text:'실제 돈',title:'실매매 (실거래)',cls:'live'}};
export const modeInfo=mode=>MODE[mode]||{badge:String(mode||'?'),text:'확인 필요',title:'실매매',cls:'off'};
const LIVE_STATUS={SUBMITTING:'주문 접수 중',OPEN:'보유 중',CLOSED:'종료',FAILED:'주문 실패',UNKNOWN:'확인 필요'};
const HZ_CLASS={ULTRA_SHORT:'ultra',SHORT_TERM:'short',MID_TERM:'mid',LONG_TERM:'long'};
const holdText=h=>h<1?Math.max(1,Math.round(h*60))+'분':h<48?(+h.toFixed(1))+'시간':(+(h/24).toFixed(1))+'일';
// Open position: the expected tier (and how long it has been held); closed trade: the actual tier.
const horizonTag=x=>{const closed=x?.actualHorizon,t=closed||x?.horizon;if(!t)return '';
 const held=!closed&&x.createdAt>0?(Date.now()-x.createdAt)/3600000:null;
 const title=closed?`실제 보유 ${holdText(x.holdHours)} · ${t.range}${x.horizon?` (예상 ${x.horizon.label})`:''}`:`예상 ${t.label} · ${t.hint||t.range}${x.pattern?' · '+x.pattern:''}`;
 return `<span class="horizon-tag h-${HZ_CLASS[t.code]||'mid'}" title="${esc(title)}">${esc(closed?t.label:t.label+' 예상')}${held!==null?` · ${holdText(held)}째`:''}${closed&&Number.isFinite(x.holdHours)?` · ${holdText(x.holdHours)}`:''}</span>`};
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
  ...(L.strategyProfile?[['전략',L.strategyProfile==='HYBRID'?`HYBRID · 위험 한도로 수량 역산 · 추매 1·1·2·4(최대 ${L.hybridMaxAdds}회) 매물대`:'CURRENT (기존 규칙)']]:[]),
  ...(L.riskProfile?[['위험 프로필',L.riskProfile==='GROWTH'?'수익형(거래당 3% · 열린 위험·하루 9% · 동시 8개)':L.riskProfile==='CONSERVATIVE'?'보수(거래당 1% · 하루 3% · 동시 4개)':'기존(승인 전 실거래 값)']]:[]),
  ...(L.sizing==='BALANCE'?[['수량',L.strategyProfile==='HYBRID'?`추매까지 모두 체결 후 손절 시 손실 = 잔고의 ${L.maxLossPct}%가 되도록 첫 수량 역산 · 포지션마다 같은 크기(잔고의 ${L.marginUsePct??25}% 이내)`:`잔고${L.balanceCapUSD?`(최대 $${L.balanceCapUSD})`:''} × ${L.unitPct}% × 배율 · 포지션마다 같은 크기(잔고의 ${L.marginUsePct??25}% 이내), 매물대 분할 추매`],['손실 한도',`1회 잔고 ${L.maxLossPct}% · 하루 ${L.dailyMaxLossPct}%`]]
   :[['손실 한도',`1회 $${L.maxRiskUSD} · 하루 $${L.dailyMaxRiskUSD}`]]),
  ['동시 포지션',L.maxOpen>0?`${L.maxOpen}개${L.maxPerDirection?` (롱·숏 각 ${L.maxPerDirection}개)`:''}`:'개수 제한 없음 (손실 합계 한도로 관리)']];
}

export function modeBadgeHTML(s){
 const m=modeInfo(s.mode);
 const state=s.killSwitch?'<b class="live-flag kill">긴급 정지 중</b>':s.mode==='OFF'?'<b class="live-flag">주문 안 함</b>':s.armed?'<b class="live-flag armed">활성화됨</b>':'<b class="live-flag">비활성</b>';
 return `<span class="live-mode ${m.cls}"><strong>${esc(m.badge)}</strong><span>${esc(m.text)}</span></span>${state}`;
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
 const addsLine=pending.length?`<span class="add-chips">${pending.map(a=>`<span class="add-chip"><i>${a.n}차</i>${pf(a.price)}<small>${qtyFmt(a.qty)}</small></span>`).join('')}</span>`:'없음';
 const curNote=p.currentPriceSource==='EXCHANGE'?'거래소 표시가':p.currentPriceSource==='VENUE_BOOK'?'거래소 호가 중간값':'시세 대기';
 const pnl=u?`<b class="${pnlClass(u.usd)}">${usd(u.usd)}${fin(u.pct)?` (${Number(u.pct)>=0?'+':''}${Number(u.pct).toFixed(2)}%)`:''}</b><small>${u.source==='EXCHANGE'?'거래소 계산':'추정 (평균가·현재가)'}${fin(u.pct)?' · 증거금 대비':''}</small>`:'<b>—</b><small>시세 대기</small>';
 const ev=p.lastEvent?`${esc(p.lastEvent.label)}${p.lastEvent.reason?' · '+esc(p.lastEvent.reasonKo||p.lastEvent.reason):''} · ${time(p.lastEvent.at)}`:'—';
 return `<article class="paper-trade live-position${p.status==='UNKNOWN'?' live-warn':''}">
 <header><b>${esc(p.symbol)}</b>${side(p.direction)}${horizonTag(p)}<span>${fin(p.leverage)?esc(p.leverage)+'배 교차':'배율 —'} · ${esc(LABEL[p.venue]||p.venue)}</span><span class="live-state s-${esc(p.status)}">${esc(p.statusKo||LIVE_STATUS[p.status]||p.status)}</span></header>
 <div class="paper-trade-values live-values">
  <span>첫 진입가<b>${pf(p.firstEntryPrice)}</b></span>
  <span>평균 진입가<b>${pf(p.averageEntryPrice)}</b></span>
  <span>현재가<b>${pf(p.currentPrice)}</b><small>${curNote}</small></span>
  <span>수량<b>${qty}</b></span>
  <span>미실현 손익${pnl}</span>
  <span>증거금<b>${p.margin?'$'+Number(p.margin.usd).toFixed(2):'—'}</b><small>${p.margin?.source==='EXCHANGE'?'거래소':p.margin?'추정 (평균가×수량÷배율)':''}</small></span>
  <span>실현 손익<b class="${p.realizedOpen?pnlClass(p.realizedOpen.usd):''}">${p.realizedOpen?usd(p.realizedOpen.usd):'—'}</b><small>${p.realizedOpen?'부분 익절·수수료 포함':'거래소 값 없음'}</small></span>
  <span>추매<b>${esc(p.adds?.filled??0)}차 / 최대 ${esc(p.adds?.max??0)}차</b>${p.adds?.skipped?`<small>주문 못 낸 추매 ${esc(p.adds.skipped)}건</small>`:''}</span>
  <span>손절가<b>${pf(p.stop)}</b>${p.breakevenMoved?'<small>TP1 체결 후 본절 이동</small>':''}</span>
  <span class="tp-cell">TP1 · TP2 · TP3<b>${(p.targets||[]).map(pf).join(' · ')||'—'}</b>${p.targetsFilled?.tp1?'<small>TP1 체결됨</small>':''}</span>
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
 <header><b>${esc(c.symbol)}</b>${side(c.direction)}${horizonTag(c)}<span>${fin(c.leverage)?esc(c.leverage)+'배':''} · ${esc(LABEL[c.venue]||c.venue)}</span>${c.test?'<span class="live-state">시험 주문 (합계 제외)</span>':''}<span>${esc(c.closeReasonKo)}</span></header>
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
 return records.map(r=>`<tr><td>${time(r.createdAt)}</td><td>${esc(LABEL[r.venue]||r.venue)}</td><td>${esc(r.symbol)}</td><td>${side(r.direction)}</td><td>${esc(r.quantity?.total??'—')} ${r.quantity?.unit==='CONTRACT'?'계약':''}</td><td>$${Number(r.plannedRiskUSD||0).toFixed(2)}</td><td>${esc(LIVE_STATUS[r.status]||r.status)}${r.test?' · 시험':''}</td><td>${r.lastEventKo?esc(r.lastEventKo):r.lastEvent?esc(r.lastEvent.type):'—'}${r.deletable?` <button type="button" class="ghost small" data-live-delete="${esc(r.signalKey)}">삭제</button>`:''}</td></tr>`).join('');
}

const SERIOUS_KO={ENTRY_OUTCOME_UNKNOWN:'진입 결과 불명',STATUS_UNKNOWN:'확인 필요 상태',STOP_FAILED:'손절 주문 실패',TARGET_FAILED:'목표 주문 실패',CANCEL_FAILED:'주문 취소 실패',EMERGENCY_CLOSED:'긴급 청산',LATE_ADD_CLOSE_FAILED:'청산 뒤 추매 정리 실패',RESTART_WHILE_SUBMITTING:'주문 중 서버 재시작'};
/** Real-money readiness checklist (measured on testnet trades under the current rules). */
// Skip details in words (2026-11-16: 'up' after the 4H reason was unclear).
const TREND_KO={up:'4시간 상승 추세',down:'4시간 하락 추세',flat:'4시간 횡보',LONG:'롱',SHORT:'숏'};
function skipDetail(x){if(!x.detail)return '';const d=String(x.detail);return ` <small>(${esc(TREND_KO[d]||d)})</small>`}
/** Copy-trading ledger (copy_executor.mjs): open copies, recent closes, recent skips/problems. */
const COPY_WHY={BINGX_HEDGE_MODE:'BingX 양방향(헤지) 모드라 건너뜀 — 이전 버전 기록(지금은 헤지 모드도 지원)',BINGX_POSITION_MODE_UNKNOWN:'BingX 포지션 모드(단방향/헤지) 확인 실패',VENUE_POSITION_EXISTS:'거래소에 같은 코인 포지션이 이미 있음(수동 매매 등) — 합쳐지지 않게 건너뜀',MARGIN_SHORT:'여유 증거금 부족',SYMBOL_BUSY:'같은 종목 보유 중',SYMBOL_HELD_BY_SIGNAL_STRATEGY:'신호 전략이 같은 종목 보유 중',OPPOSITE_COPY_OPEN:'반대 방향 보유 중',
 MONITOR_RESTART_SNAPSHOT:'채널 재시작 직후 기존 포지션 재알림',LIVE_DISARMED:'실매매 비활성',KILL_SWITCH:'긴급 정지 중',NOT_TESTNET:'테스트넷 아님',NO_BINGX_CONTRACT:'BingX에 없는 종목',
 NOT_COPIED:'따라 들어가지 않은 포지션',OUR_COPY_CLOSED:'우리가 먼저 정리한 포지션 (손실 한도·보호 손절 등, 트레이더 청산 전까지 다시 안 들어감)',COPY_CLOSED_EXTERNALLY:'거래소에서 수동 청산이 확인된 포지션 — 트레이더 추매·진입은 다시 따라감',EXTERNAL_UNCONFIRMED:'바깥 청산인지 확인 불가로 다시 따라가지 않음',CLOSING:'청산 중인 포지션(추매 안 함)',LIQUIDATION:'강제청산 — 다시 따라가지 않음',ADL:'자동 감축(ADL) 청산 — 다시 따라가지 않음',STOP_OR_EXTERNAL:'거래소에서 사라짐(외부 청산 또는 보호 손절)',POSITION_GONE:'거래소에 포지션 없음',STALE_MESSAGE:'순서가 늦게 도착한 옛 메시지',QUANTITY_INVALID:'수량 계산 불가',NO_BALANCE:'잔고 조회 실패',HTTP_429:'요청 과다(잠시 후 재시도)',COPY_MARGIN_CAP:'카피 전체 증거금 한도',MIN_ORDER_TOO_LARGE:'거래소 최소 주문이 증거금 5달러 초과',PRICE_MISMATCH:'거래소 가격 불일치',PRICE_UNVERIFIED:'거래소 가격 확인 실패',VENUE_ERROR_101400:'거래소 주문 조건 미달(최소 주문 수량·금액 등)',QUANTITY_UNIT_UNCLEAR:'알림 수량 단위 불명',COPY_LOSS_LIMIT:'카피 손실 한도로 정지',LOSS_CAP_REACHED:'손실 한도 도달',NO_STOP:'보호 손절 실패로 청산'};
// The cause behind "따라 들어가지 않은 포지션" (user 2026-11-14): the skipped entry, our earlier close, or no entry card.
function notCopiedWhy(e,when,all=[]){
 if(e.reason!=='NOT_COPIED'&&e.type!=='LATE_ENTRY')return '';
 // Records from before the server kept a cause: the last skip / failed entry of the same symbol before it.
 if(!e.cause){const i=all.indexOf(e),prior=all.slice(i+1).find(x=>x.symbol===e.symbol&&(x.type==='OPENED'||(x.type==='SKIPPED'&&x.reason!=='NOT_COPIED')||(x.type==='ERROR'&&(x.entry||x.kind==='OPEN'||/진입/.test(x.detail||'')))));
  if(prior&&prior.type!=='OPENED')e={...e,cause:prior.reason||prior.type,causeAt:prior.at,causeDetail:prior.detail??null}}
 const card=e.from!=null&&e.to!=null?`트레이더 수량 ${esc(e.from)} → ${esc(e.to)} · `:'';
 const why=e.cause==='NO_ENTRY_RECEIVED'?'카피에 진입 알림이 도착한 적 없음 (카피 시작·서버 재시작 전에 열렸거나 수신 실패)'
  :e.cause==='OUR_COPY_CLOSED'?`우리 카피는 ${when(e.causeAt)}에 먼저 종료됨 (${esc(COPY_WHY[e.causeDetail]||e.causeDetail||'')})`
  :e.cause==='COPY_CLOSED_EXTERNALLY'?`우리 카피는 ${when(e.causeAt)}에 거래소에서 수동 청산(확인됨)으로 바깥 청산됨 (${esc(COPY_WHY[e.causeDetail]||e.causeDetail||'')}) — 우리 손절·한도 청산이 아니라 ${e.type==='LATE_ENTRY'?'트레이더 추매에 다시 따라 들어감':'축소는 따라가지 않음'}`
  :e.cause?`처음 진입을 ${when(e.causeAt)}에 건너뜀: ${esc(COPY_WHY[e.cause]||e.cause)}${e.causeDetail?` (${esc(e.causeDetail)})`:''}`:'';
 return why?`<br><small class="copy-why">${card}${why}</small>`:'';
}

// Every open position on the BingX real account (user 2026-11-17 "내가 수동으로 잡은 포지션도 실시간 현황으로"),
// read-only: 카피 = an open copy-ledger position of the same symbol and direction, 수동 = anything else.
export function venuePositionsHTML(c){
 if(!c||c.mode!=='LIVE'||!('venuePositions' in c||c.venuePositionsError))return '';
 const list=Array.isArray(c.venuePositions)?c.venuePositions:null,manual=(list||[]).filter(p=>p.origin!=='copy');
 const money=v=>!fin(v)?'—':`${Number(v)>=0?'+':'−'}$${Math.abs(Number(v)).toFixed(2)}`,usdv=v=>!fin(v)?'—':`$${Number(v).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}`;
 const cls=v=>!fin(v)?'':Number(v)>0?'paper-profit':Number(v)<0?'paper-loss':'',px=v=>fin(v)&&Number(v)>0?esc(+Number(v).toPrecision(6)):'—';
 const pct=v=>!fin(v)?'—':`${Number(v)>=0?'+':'−'}${Math.abs(Number(v)).toFixed(1)}%`,mm=p=>p.marginMode==='ISOLATED'?'격리':'교차';
 const badge=p=>p.origin==='copy'?'<span class="vp-badge copy">카피</span>':'<span class="vp-badge manual">수동</span>';
 const sum=a=>a.reduce((t,p)=>t+(Number(p.unrealized)||0),0);
 const hhmm=t=>t?new Date(t).toLocaleTimeString('ko-KR',{hour12:false}):'';
 const fail=c.venuePositionsError?`<span class="vp-fail" title="${esc(c.venuePositionsError)}">갱신 실패${list&&c.venuePositionsAt?` · ${hhmm(c.venuePositionsAt)} 목록`:''}</span>`:'';
 const head=`<h5 class="copy-sub">거래소 전체 포지션 <small>${list?`${list.length}개 · 수동 ${manual.length}개`:'조회 전'}</small>${fail}</h5>`;
 if(!list)return head+'<p class="empty-small">거래소 포지션을 아직 읽지 못했습니다.</p>';
 if(!list.length)return head+'<p class="empty-small">거래소에 열린 포지션이 없습니다.</p>';
 const totals=`<p class="copy-stamp vp-total">미실현 합계 <b class="${cls(sum(list))}">${money(sum(list))}</b> · 수동만 <b class="${cls(sum(manual))}">${manual.length?money(sum(manual)):'—'}</b>${c.venuePositionsAt?` · ${hhmm(c.venuePositionsAt)} 거래소 기준 · 조회 전용(주문 없음)`:''}</p>`;
 const row=p=>`<li class="${p.origin==='copy'?'':'vp-manual'}"><b>${esc(p.symbol)}</b>${badge(p)}${side(p.direction)}<span>${esc(p.leverage??'—')}배 ${mm(p)}</span><span>수량 ${esc(qtyFmt(p.size))} · 평단 ${px(p.avg)}</span><span class="muted">현재 ${px(p.mark)} · 증거금 ${usdv(p.margin)}${p.liquidation?` · 청산 ${px(p.liquidation)}`:''}</span><b class="${cls(p.unrealized)} end">${money(p.unrealized)} <small>${pct(p.roePct)}</small></b></li>`;
 const table=`<table class="copy-table vp-table only-desk"><thead><tr><th>종목</th><th>구분</th><th>방향</th><th>배율</th><th class="num">수량</th><th class="num">평단</th><th class="num">현재가</th><th class="num">증거금</th><th class="num">미실현</th><th class="num">수익률</th><th class="num">청산가</th></tr></thead><tbody>${list.map(p=>`<tr class="${p.origin==='copy'?'':'vp-manual'}"><td><b>${esc(p.symbol)}</b></td><td>${badge(p)}</td><td>${side(p.direction)}</td><td>${esc(p.leverage??'—')}배 <small class="muted">${mm(p)}</small></td><td class="num">${esc(qtyFmt(p.size))}</td><td class="num">${px(p.avg)}</td><td class="num">${px(p.mark)}</td><td class="num">${usdv(p.margin)}</td><td class="num"><b class="${cls(p.unrealized)}">${money(p.unrealized)}</b></td><td class="num ${cls(p.roePct)}">${pct(p.roePct)}</td><td class="num">${px(p.liquidation)}</td></tr>`).join('')}</tbody></table>`;
 return head+totals+`<ul class="copy-list only-mob">${list.map(row).join('')}</ul>`+table;
}

// Recent closes: 10 at a time with page buttons (user 2026-11-17 "10건으로 해주고 페이지 형식으로").
let copyPage=0,failPage=0,lastCopy=null;
export const COPY_PAGE_SIZE=10;
export function setCopyPage(p){copyPage=Math.max(0,p|0)}
export function setCopyFailPage(p){failPage=Math.max(0,p|0)}
// Copy and manual closes together (user 2026-11-17 "수동 매매도 누적 수익·기록은 똑같이, 수동인지만 표시"): manual trades
// on the real account (manual_ledger.mjs) are listed and counted like copy trades, marked 수동. Page totals only:
// the copy loss limit, margin limits and copy decisions are computed on the server from the copy ledger alone.
export function mergedCloses(c){
 const copy=(c?.closed||[]).map(x=>x.origin==='manual'?x:{...x,origin:'copy'}),manual=(c?.manual?.closed||[]).map(x=>({...x,origin:'manual'}));
 return [...copy,...manual].sort((a,b)=>(Number(b.closedAt)||0)-(Number(a.closedAt)||0));
}
/** Totals of the closes the page counts: every copy close (as before) and every settled manual close (a manual close
 * still PENDING has no result yet). {all, copy, manual}: n, wins, net, gross, loss; plus pending manual closes. */
export function copyStats(c){
 const one=list=>{const net=list.reduce((a,x)=>a+(Number(x.netUSD)||0),0),wins=list.filter(x=>x.netUSD>0).length;
  return {n:list.length,wins,net,gross:list.filter(x=>x.netUSD>0).reduce((a,x)=>a+x.netUSD,0),loss:-list.filter(x=>x.netUSD<0).reduce((a,x)=>a+x.netUSD,0)}};
 const all=mergedCloses(c),copy=all.filter(x=>x.origin!=='manual'),manualAll=all.filter(x=>x.origin==='manual'),manual=manualAll.filter(x=>x.netUSD!=null&&fin(x.netUSD));
 return {all:one([...copy,...manual]),copy:one(copy),manual:one(manual),pending:manualAll.filter(x=>x.netSource==='PENDING').length};
}
export function copyHTML(c){
 lastCopy=c;
 if(!c)return '';
 const money=v=>v==null||!Number.isFinite(Number(v))?'—':`${v>=0?'+':'−'}$${Math.abs(v).toFixed(2)}`,usd=v=>v==null||!Number.isFinite(Number(v))?'—':`$${Number(v).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}`;
 const cls=v=>v>0?'paper-profit':v<0?'paper-loss':'';
 const when=t=>t?new Date(t).toLocaleString('ko-KR',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit',hour12:false}):'';
 const held=(a,b)=>{const h=(b-a)/3600000;return !(h>=0)?'':h<1?Math.max(1,Math.round(h*60))+'분':h<48?(+h.toFixed(1))+'시간':(+(h/24).toFixed(1))+'일'};
 const open=c.positions||[],closed=mergedCloses(c),st=copyStats(c),net=st.all.net,wins=st.all.wins,counted=st.all.n;
 const closedTotal=(c.closedTotal??(c.closed||[]).length)+(c.manual?(c.manual.closedTotal??(c.manual.closed||[]).length):0);
 const pages=Math.max(1,Math.ceil(closed.length/COPY_PAGE_SIZE)),page=Math.min(copyPage,pages-1),shown=closed.slice(page*COPY_PAGE_SIZE,page*COPY_PAGE_SIZE+COPY_PAGE_SIZE);
 const pager=pages>1?`<div class="copy-pager"><button type="button" class="outline-btn small" data-copy-page="-1"${page===0?' disabled':''}>‹ 이전</button><span class="muted">${page+1} / ${pages}쪽</span><button type="button" class="outline-btn small" data-copy-page="1"${page>=pages-1?' disabled':''}>다음 ›</button></div>`:'';
 const gross=st.all.gross,loss=st.all.loss;
 const unreal=open.reduce((a,p)=>a+(Number(p.unrealized)||0),0),isLive=c.mode==='LIVE';
 // Mode line: which account, on/off, the switch.
 // Mode line: which account, a clear ON/OFF state, and the switch.
 const on=isLive?Boolean(c.armed&&c.enabled&&!c.killed):Boolean(c.enabled&&c.followArmed&&!c.killed);
 const state=c.killed?'<b class="copy-state kill">■ 정지됨 (손실 한도)</b>':on?'<b class="copy-state on">● 활성화됨</b>':'<b class="copy-state off">○ 비활성</b>';
 const detail=!c.enabled?'카피 꺼짐':isLive?(on?'실제 돈으로 주문합니다':'주문하지 않습니다 · 서버 재시작 후 항상 비활성'):(on?'테스트넷 활성화 상태를 따라 주문합니다':'테스트넷 페이지에서 활성화해야 주문합니다');
 const modeLine=`<div class="copy-mode ${isLive?'live':''} ${on?'on':''}"><span class="copy-chip">${isLive?'실계좌':'테스트넷'}</span>${state}<span>${detail}</span>
  ${isLive&&c.enabled&&!c.killed?(c.armed?'<button type="button" class="outline-btn small" data-copy-disarm>비활성화하기</button>':'<button type="button" class="outline-btn small danger-btn" data-copy-arm>활성화하기</button>'):''}<span class="copy-msg" data-copy-msg></span></div>`;
 const kill=c.killed?`<p class="live-warn-text">카피 손실 한도(잔고 ${esc(c.ledgerLossPct)}%)에 닿아 모두 청산하고 멈췄습니다. <button type="button" class="outline-btn small" data-copy-resume>카피 다시 시작</button></p>`:'';
 const f=c.funds,stat=(k,v,extra='')=>`<span>${k}<b ${extra}>${v}</b></span>`;
 const stats=`<div class="copy-stats">${stat(isLive?'실계좌 잔고':'잔고',usd(f?.equity))}${stat('사용 가능',usd(f?.available))}${stat('보유',open.length+'개')}${stat('미실현',money(open.length?unreal:null),`class="${cls(unreal)}"`)}
  ${stat('종료',counted+'건')}${stat('승률',counted?Math.round(wins/counted*100)+'%':'—')}${stat('PF',loss>0?(gross/loss).toFixed(2):counted?'∞':'—')}${stat('누적 손익',money(counted?net:null),`class="${cls(net)}"`)}</div>`+
  (c.manual?`<p class="copy-split">카피 <b class="${cls(st.copy.net)}">${money(st.copy.net)}</b> (${st.copy.n}건) · 수동 <b class="${cls(st.manual.net)}">${money(st.manual.net)}</b> (${st.manual.n}건)${st.pending?` · <span class="muted">정산 중 ${st.pending}건</span>`:''}</p>`:'');
 const rules=`<p class="copy-rules">수량 ${c.sizing==='BALANCE_RATIO'?`트레이더 × 내 잔고 ÷ $${Number(c.traderBalanceUSD).toLocaleString()}`:c.sizing==='MIN_ORDER'?`첫 증거금 $${esc(c.firstMarginUSD??0)} (거래소 최소 주문보다 작으면 최소 주문), 추매는 트레이더 비율`:`첫 증거금 $${esc(c.marginUSD)}`} · 추매 최대 ${esc(c.maxAdds??10)}회 · 손절 ${c.stops?`포지션당 잔고 ${esc(c.maxLossPct)}%`:'없음(트레이더 청산만)'} · 한도 증거금 ${esc(c.maxTotalMarginPct)}%·손실 ${esc(c.ledgerLossPct)}% · 손익은 수수료 전 추정${f?.at?` · 잔고 ${when(f.at)} 확인`:''}</p>`;
 const row=p=>`<li><b>${esc(p.symbol)}</b>${side(p.direction)}<span>${esc(p.leverage)}배</span><span>수량 ${esc(p.qty)}${p.avg?` · 평단 ${esc(p.avg)}`:''}</span><span>추매 ${esc(p.adds||0)}회</span><span class="muted">${held(p.openedAt,Date.now())}째</span>${p.unrealized!=null?`<b class="${cls(p.unrealized)} end">${money(p.unrealized)}</b>`:''}</li>`;
 // Manual closes: the yellow 수동 badge; the result is BingX's own (income) unless marked 추정 / 정산 중.
 const isMan=x=>x.origin==='manual',manBadge=x=>isMan(x)?'<span class="vp-badge manual">수동</span>':'';
 const SRC={MIXED_WITH_COPY:'추정 · 같은 코인 카피와 겹쳐 거래소 내역을 나눌 수 없음',MIXED_WITH_MANUAL:'추정 · 같은 코인 수동 포지션과 겹침',ESTIMATE:'추정 · 거래소 내역 없음'};
 const result=x=>isMan(x)&&x.netSource==='PENDING'?`<span class="muted" title="거래소 손익 내역을 기다리는 중${fin(x.estimateUSD)?` · 추정 ${money(Number(x.estimateUSD))}`:''}">정산 중</span>`
  :`${money(x.netUSD)}${isMan(x)&&SRC[x.netSource]?` <small class="muted" title="${esc(SRC[x.netSource])}">추정</small>`:''}`;
 const done=x=>`<li class="${isMan(x)?'vp-manual':''}"><span class="muted">${when(x.closedAt)}</span><b>${esc(x.symbol)}</b>${manBadge(x)}${side(x.direction)}<span>추매 ${esc(x.adds||0)}회</span><span class="muted">${held(x.openedAt,x.closedAt)}</span>${x.theirPnlUSD!=null?`<small>트레이더 ${money(x.theirPnlUSD)}</small>`:''}<b class="${cls(x.netUSD)} end">${result(x)}</b></li>`;
 // Entry failures and skips under the closes (user 2026-11-17 "코인 종목 / 롱,숏 / 진입 실패 이유"), 10 per page.
 const notesAll=(c.events||[]).filter(e=>['SKIPPED','ADD_SKIPPED','ERROR','STOP_NOT_SET','LATE_ENTRY'].includes(e.type));
 const fPages=Math.max(1,Math.ceil(notesAll.length/COPY_PAGE_SIZE)),fPage=Math.min(failPage,fPages-1),notes=notesAll.slice(fPage*COPY_PAGE_SIZE,fPage*COPY_PAGE_SIZE+COPY_PAGE_SIZE);
 const failPager=fPages>1?`<div class="copy-pager"><button type="button" class="outline-btn small" data-copy-fail-page="-1"${fPage===0?' disabled':''}>‹ 이전</button><span class="muted">${fPage+1} / ${fPages}쪽</span><button type="button" class="outline-btn small" data-copy-fail-page="1"${fPage>=fPages-1?' disabled':''}>다음 ›</button></div>`:'';
 const why=e=>`${esc(e.type==='LATE_ENTRY'?'늦은 진입 시도 (진입 알림을 놓친 포지션의 추매)':COPY_WHY[e.reason]||e.reason||e.type)}${e.type==='ADD_SKIPPED'?' (추매)':''}${e.detail?` <small>${esc(e.detail)}</small>`:''}${notCopiedWhy(e,when,c.events||[])}`;
 // Desktop (user 2026-11-14: the web view felt like a phone): the same data as tables with more columns;
 // phones keep the compact lists. CSS shows one or the other (.only-desk / .only-mob).
 const margin=p=>p.qty>0&&p.avg>0&&p.leverage>0?p.qty*p.avg/p.leverage:null,roe=p=>{const m=margin(p);return m&&p.unrealized!=null?p.unrealized/m*100:null};
 const pctText=v=>v==null?'—':`${v>=0?'+':'−'}${Math.abs(v).toFixed(1)}%`;
 const openTable=`<table class="copy-table only-desk"><thead><tr><th>종목</th><th>방향</th><th>배율</th><th class="num">수량</th><th class="num">평단</th><th class="num">현재가</th><th class="num">증거금</th><th class="num">추매</th><th>보유</th><th class="num">미실현</th><th class="num">수익률</th></tr></thead><tbody>${open.map(p=>`<tr><td><b>${esc(p.symbol)}</b></td><td>${side(p.direction)}</td><td>${esc(p.leverage)}배</td><td class="num">${esc(p.qty)}</td><td class="num">${esc(p.avg??'—')}</td><td class="num">${esc(p.mark?+Number(p.mark).toPrecision(6):'—')}</td><td class="num">${usd(margin(p))}</td><td class="num">${esc(p.adds||0)}회</td><td class="muted">${held(p.openedAt,Date.now())}</td><td class="num"><b class="${cls(p.unrealized)}">${money(p.unrealized)}</b></td><td class="num ${cls(roe(p))}">${pctText(roe(p))}</td></tr>`).join('')}</tbody></table>`;
 const closedTable=`<table class="copy-table only-desk"><thead><tr><th>종료</th><th>종목</th><th>방향</th><th class="num">추매</th><th>보유 시간</th><th class="num">트레이더 손익</th><th class="num">내 손익</th></tr></thead><tbody>${shown.map(x=>`<tr class="${isMan(x)?'vp-manual':''}"><td class="muted">${when(x.closedAt)}</td><td><b>${esc(x.symbol)}</b> ${manBadge(x)}</td><td>${side(x.direction)}</td><td class="num">${esc(x.adds||0)}회</td><td class="muted">${held(x.openedAt,x.closedAt)}</td><td class="num">${x.theirPnlUSD!=null?money(x.theirPnlUSD):'—'}</td><td class="num"><b class="${cls(x.netUSD)}">${result(x)}</b></td></tr>`).join('')}</tbody></table>`;
 const fresh=open.map(p=>p.markAt).filter(Boolean),updated=Math.max(f?.at||0,...fresh);
 const stamp=updated>0?`<p class="copy-stamp">손익·잔고 ${new Date(updated).toLocaleTimeString('ko-KR',{hour12:false})} 기준 · 3초마다 갱신</p>`:'';
 const side_=`<div class="copy-side">${modeLine}${kill}${stats}${rules}${stamp}</div>`;
 const main=`<div class="copy-main"><h5 class="copy-sub">보유 중 <small>${open.length}개</small></h5>`+(open.length?`<ul class="copy-list only-mob">${open.map(row).join('')}</ul>${openTable}`:`<p class="empty-small">따라 들어간 포지션이 없습니다. 채널에 새 진입 알림이 오면 들어갑니다.</p>`)+
  venuePositionsHTML(c)+
  (closed.length?`<h5 class="copy-sub">최근 종료 <small>전체 ${esc(closedTotal)}건${c.manual?` · 수동 ${esc(c.manual.closedTotal??0)}건`:''}</small></h5><ul class="copy-list only-mob">${shown.map(done).join('')}</ul>${closedTable}${pager}`:'')+
  (notes.length?`<h5 class="copy-sub">진입 실패·건너뜀 <small>전체 ${notesAll.length}건</small></h5><ul class="copy-list muted only-mob">${notes.map(e=>`<li><span class="muted">${when(e.at)}</span><b>${esc(e.symbol||'')}</b> ${e.direction?side(e.direction):''} · ${why(e)}</li>`).join('')}</ul><table class="copy-table only-desk"><thead><tr><th>시각</th><th>종목</th><th>방향</th><th>이유</th></tr></thead><tbody>${notes.map(e=>`<tr><td class="muted">${when(e.at)}</td><td><b>${esc(e.symbol||'—')}</b></td><td>${e.direction?side(e.direction):'—'}</td><td>${why(e)}</td></tr>`).join('')}</tbody></table>${failPager}`:'')+'</div>';
 return `<div class="copy-layout">${side_}${main}</div>`;
}

/** Testnet reversal scalps (scalp_executor.mjs): on/off, the switch, stats, open / closed tables, skip reasons. */
export function scalpHTML(s){
 if(!s)return '';
 const money=v=>v==null||!Number.isFinite(Number(v))?'—':`${v>=0?'+':'−'}$${Math.abs(v).toFixed(2)}`,usdv=v=>v==null||!Number.isFinite(Number(v))?'—':`$${Number(v).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}`;
 const cls=v=>v>0?'paper-profit':v<0?'paper-loss':'',px=v=>fin(v)?esc(+Number(v).toPrecision(6)):'—';
 const when=t=>t?new Date(t).toLocaleString('ko-KR',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit',hour12:false}):'';
 const held=(a,b)=>{const m=(b-a)/60000;return !(m>=0)?'':m<90?Math.max(1,Math.round(m))+'분':(+(m/60).toFixed(1))+'시간'};
 const open=s.positions||[],closed=s.closed||[],st=s.stats||{},S=s.settings||{},f=s.funds;
 const on=Boolean(s.armed&&!s.blocked),canArm=s.mode==='TESTNET'&&s.credentials&&!s.armed;
 const state=s.dailyStop&&s.blocked==='DAILY_LOSS_LIMIT'?'<b class="copy-state kill">■ 오늘 정지 (하루 손실 한도)</b>':s.armed?'<b class="copy-state on">● 켜짐</b>':'<b class="copy-state off">○ 꺼짐</b>';
 const detail=s.mode!=='TESTNET'?(s.refused==='LIVE_REFUSED'?'실계좌 모드는 거부됨 — 테스트넷 전용':'SCALP_EXEC_MODE=OFF'):!s.credentials?'BingX API 키 없음':s.armed?(s.blocked?esc(s.blockedKo||s.blocked):'5분봉 마감마다 검사 · 테스트넷 주문'):'켜기를 눌러야 주문합니다 · 서버 재시작 후 항상 꺼짐';
 const btn=s.armed?'<button type="button" class="outline-btn small" data-scalp-disarm>끄기</button>':canArm?'<button type="button" class="outline-btn small" data-scalp-arm>켜기</button>':'';
 const modeLine=`<div class="copy-mode ${on?'on':''}"><span class="copy-chip">테스트넷</span>${state}<span>${detail}</span>${btn}<span class="copy-msg" data-scalp-msg></span></div>`;
 const unreal=open.reduce((a,p)=>a+(Number(p.unrealized)||0),0),stat=(k,v,extra='')=>`<span>${k}<b ${extra}>${v}</b></span>`;
 const stats=`<div class="copy-stats">${stat('잔고',usdv(f?.equity))}${stat('보유',open.length+(S.maxOpen>0?'/'+S.maxOpen:'')+'개')}${stat('미실현',money(open.length?unreal:null),`class="${cls(unreal)}"`)}${stat('오늘 손익',money(st.todayNetUSD),`class="${cls(st.todayNetUSD)}"`)}
  ${stat('종료',(st.trades||0)+'건')}${stat('승률',st.winRatePct!=null?st.winRatePct+'%':'—')}${stat('PF',st.profitFactor!=null?st.profitFactor:st.trades?'∞':'—')}${stat('누적 손익',money(st.trades?st.netUSD:null),`class="${cls(st.netUSD)}"`)}</div>`;
 // Per side (user 2026-11-16: shorts added): trades, win rate, PF, net for 롱 and 숏 apart.
 const sides=S.sides||['LONG','SHORT'],SK={LONG:'롱',SHORT:'숏'};
 const bySide=`<div class="copy-stats">${['LONG','SHORT'].map(d=>{const b=st.bySide?.[d]||{};return stat(`${SK[d]}${sides.includes(d)?'':' (꺼짐)'}`,`${b.trades||0}건 · ${b.winRatePct!=null?b.winRatePct+'%':'—'} · PF ${b.profitFactor!=null?b.profitFactor:b.trades?'∞':'—'}`)+stat(`${SK[d]} 손익`,money(b.trades?b.netUSD:null),`class="${cls(b.netUSD)}"`)}).join('')}</div>`;
 const rules=`<p class="copy-rules">거래 방향 ${sides.length?sides.map(d=>SK[d]).join('·'):'없음'} · 5분봉 급락(롱)·급등(숏) ${esc(S.minMovePct)}% 이상 · 거래량 ${esc(S.climaxVolume)}배 · 반전 캔들 확인 뒤 진입 · 목표 ${(S.retracements||[]).map(r=>+(r*100).toFixed(1)+'%').join('/')} 되돌림 (40/35/25%) · 손절 저점(숏은 고점) 너머 ATR×${esc(S.stopAtr)} · 1차 목표 뒤 본전 · 최대 ${esc(S.maxHoldMin)}분 보유 · ${S.trendMode==='on'?'4시간 추세 반대 제외(하락 중 롱·상승 중 숏)':S.trendMode==='off'?'4시간 추세 미사용':'4시간 추세 기록만(진입 막지 않음)'} · 거래당 위험 잔고 ${esc(S.riskPct)}% · ${esc(S.leverage)}배 교차 · 하루 손실 ${esc(S.dailyLossPct)}%에서 정지 · 진입가와 ${esc(S.maxDriftPct)}%${S.driftMovePct>0?`(유리한 쪽은 급변 폭의 ${esc(S.driftMovePct)}%까지)`:''}${S.stopKeepPct>0?`(더 좋은 가격은 손절 거리 ${esc(S.stopKeepPct)}% 이상 남으면 진입)`:''} 넘게 벌어지면 건너뜀${s.universe?.count?` · 대상 ${esc(s.universe.count)}종목`:''}${s.lastScan?.at?` · 마지막 검사 ${when(s.lastScan.at)} (${esc(s.lastScan.checked)}종목)`:''}</p>`;
 const row=p=>`<li><b>${esc(p.symbol)}</b>${side(p.direction||'LONG')}<span>${esc(p.leverage)}배</span><span>진입 ${px(p.avg)} · 손절 ${px(p.stop)}${p.breakevenMoved?' (본전)':''}</span><span class="muted">${held(p.openedAt||p.createdAt,Date.now())}째</span>${p.unrealized!=null?`<b class="${cls(p.unrealized)} end">${money(p.unrealized)}</b>`:''}</li>`;
 // Closed trades (the newest 20; the stats above cover every trade): side, entry / exit time, hold, reason, R, PnL, MFE / MAE.
 const rTxt=v=>fin(v)?`${Number(v)>=0?'+':'−'}${Math.abs(Number(v)).toFixed(2)}R`:'—',ex=x=>fin(x.mfeR)||fin(x.maeR)?`${rTxt(x.mfeR)} / ${rTxt(x.maeR)}`:'—';
 const done=x=>`<li><span class="muted">${when(x.closedAt)}</span><b>${esc(x.symbol)}</b>${side(x.direction||'LONG')}<span>${esc(x.closeReasonKo||x.closeReason)}</span><span class="muted">${held(x.openedAt||x.createdAt,x.closedAt)}</span><span class="${cls(x.rMultiple)}">${rTxt(x.rMultiple)}</span><small class="muted">최대 ${ex(x)}</small><b class="${cls(x.netUSD)} end">${money(x.netUSD)}${x.netSource==='EXCHANGE'?'':' <small>추정</small>'}</b></li>`;
 const tgt=p=>(p.targets||[]).map((t,i)=>p.parts?.[i]>0?`<span class="${p.tpDone?.[i]?'paper-profit':''}">${px(t)}</span>`:null).filter(Boolean).join(' / ');
 const openTable=`<table class="copy-table only-desk"><thead><tr><th>종목</th><th>방향</th><th>배율</th><th class="num">수량</th><th class="num">진입</th><th class="num">현재가</th><th class="num">손절</th><th>목표</th><th>보유</th><th class="num">위험</th><th class="num">미실현</th></tr></thead><tbody>${open.map(p=>`<tr><td><b>${esc(p.symbol)}</b>${p.status!=='OPEN'?` <small class="paper-loss">${esc(p.status)}</small>`:''}</td><td>${side(p.direction||'LONG')}</td><td>${esc(p.leverage)}배</td><td class="num">${esc(p.size||p.qty)}</td><td class="num">${px(p.avg)}</td><td class="num">${px(p.mark)}</td><td class="num">${px(p.stop)}${p.breakevenMoved?' <small>본전</small>':''}</td><td>${tgt(p)}</td><td class="muted">${held(p.openedAt||p.createdAt,Date.now())}</td><td class="num">${usdv(p.riskUSD)}</td><td class="num"><b class="${cls(p.unrealized)}">${money(p.unrealized)}</b></td></tr>`).join('')}</tbody></table>`;
 const closedTable=`<table class="copy-table only-desk"><thead><tr><th>종목</th><th>방향</th><th>진입</th><th>종료</th><th>보유</th><th>사유</th><th class="num">목표 도달</th><th class="num">R</th><th class="num">최대 이익/손실(R)</th><th class="num">손익</th></tr></thead><tbody>${closed.slice(0,20).map(x=>`<tr><td><b>${esc(x.symbol)}</b></td><td>${side(x.direction||'LONG')}</td><td class="muted">${when(x.openedAt||x.createdAt)}</td><td class="muted">${when(x.closedAt)}</td><td class="muted">${held(x.openedAt||x.createdAt,x.closedAt)}</td><td>${esc(x.closeReasonKo||x.closeReason)}</td><td class="num">${esc(x.tpHits??0)}개</td><td class="num ${cls(x.rMultiple)}">${rTxt(x.rMultiple)}</td><td class="num">${ex(x)}</td><td class="num"><b class="${cls(x.netUSD)}">${money(x.netUSD)}</b>${x.netSource==='EXCHANGE'?'':' <small>추정</small>'}</td></tr>`).join('')}</tbody></table>`;
 const counts=(s.skipCounts||[]).slice(0,8),skips=(s.skips||[]).slice(0,10);
 const skipBox=counts.length?`<h5 class="copy-sub">진입 안 한 이유</h5><p class="copy-rules">${counts.map(c=>`${esc(c.label)} ${esc(c.count)}회`).join(' · ')}</p><ul class="copy-list muted">${skips.map(x=>`<li><span class="muted">${when(x.at)}</span>${esc(x.symbol||'')}${x.direction?` <b class="${x.direction==='LONG'?'pos':'neg'}">${x.direction==='LONG'?'롱(급락 후 반등)':'숏(급등 후 되돌림)'}</b>`:''}${x.movePct!=null?` <small>${esc(Number(x.movePct).toFixed(1))}% 움직임</small>`:''} · ${esc(x.label||x.reason)}${skipDetail(x)}</li>`).join('')}</ul>`:'';
 const side_=`<div class="copy-side">${modeLine}${stats}${bySide}${rules}</div>`;
 const main=`<div class="copy-main"><h5 class="copy-sub">보유 중 <small>${open.length}개</small></h5>`+(open.length?`<ul class="copy-list only-mob">${open.map(row).join('')}</ul>${openTable}`:`<p class="empty-small">보유 중인 단타가 없습니다.${s.armed?' 5분봉 마감마다 급락 후 반등·급등 후 되돌림을 찾습니다.':''}</p>`)+
  (closed.length?`<h5 class="copy-sub">최근 종료 <small>최근 ${Math.min(20,closed.length)}건 · 전체 기록은 단타 기록 파일</small></h5><ul class="copy-list only-mob">${closed.slice(0,20).map(done).join('')}</ul>${closedTable}`:'')+skipBox+'</div>';
 return `<div class="copy-layout">${side_}${main}</div>`;
}
function bindScalpButtons(el){
 if(!el||el.dataset.bound)return;el.dataset.bound='1';
 el.addEventListener('click',async e=>{
  const arm=e.target.closest('[data-scalp-arm]'),disarm=e.target.closest('[data-scalp-disarm]'),btn=arm||disarm;if(!btn)return;
  if(arm&&!window.confirm('되돌림 단타(테스트넷)를 켭니다. 5분봉이 마감될 때마다 급락 후 반등 롱·급등 후 되돌림 숏을 BingX 테스트넷에 주문합니다. 켤까요?'))return;
  const msg=el.querySelector('[data-scalp-msg]');btn.disabled=true;btn.textContent=arm?'켜는 중…':'끄는 중…';
  const KO={KILL_SWITCH_ON:'긴급 정지 중',DAILY_LOSS_LIMIT:'오늘 하루 손실 한도에 닿음',CREDENTIALS_MISSING:'BingX API 키 없음',SCALP_MODE_OFF:'꺼짐 설정',LIVE_REFUSED:'테스트넷 전용',UPDATING:'업데이트 중'};
  try{const r=await fetch(arm?'/api/scalp/arm':'/api/scalp/disarm',{method:'POST',cache:'no-store',headers:{'Content-Type':'application/json'},body:JSON.stringify(arm?{confirm:'SCALP_ARM'}:{})}),d=await r.json().catch(()=>({}));
   if(!r.ok)throw Error(KO[d.error]||d.error||'HTTP '+r.status);if(msg)msg.textContent=d.armed?'✓ 켜졌습니다':'✓ 꺼졌습니다'}
  catch(err){if(msg){msg.textContent='실패: '+err.message;msg.classList.add('err')}}
  document.getElementById('liveRefresh')?.click()})}

export function readinessHTML(r,positions){
 if(!r)return '';
 const pct=v=>v===null||v===undefined?'—':v+'%';
 // Open positions: the unrealized result from the position cards (venue figure when fresh), summed.
 const open=positions||[],uv=open.map(p=>p.unrealizedUSD).filter(x=>x!=null),u=uv.length?Math.round(uv.reduce((a,b)=>a+b,0)*100)/100:null;
 const total=Math.round(((r.netUSD||0)+(u||0))*100)/100,money=v=>`${v>=0?'+':'−'}$${Math.abs(v).toFixed(2)}`,cls=v=>v>0?'paper-profit':v<0?'paper-loss':'';
 const hold=h=>h==null?'—':h<24?h.toFixed(1)+'시간':(h/24).toFixed(1)+'일';
 return `<div class="readiness-head"><b>${r.ready?'✅ 실매매 전환 기준 충족':'실매매 전환 점검'}</b><small>${r.ready?'실제 돈 전환은 설정 파일을 직접 바꿔야 합니다 · 작은 금액부터':'테스트넷 결과로 매일 자동 점검 · 기준을 모두 채우면 텔레그램으로 알려 드립니다'}</small></div>
 <div class="readiness-stats"><span>거래<b>${esc(r.settled)}건</b></span><span>승률<b>${pct(r.winRatePct)}</b></span><span>실현 누적<b class="${cls(r.netUSD)}">${money(r.netUSD)}</b></span><span>미실현 합계<b class="${cls(u)}">${u==null?'—':money(u)}</b><small>진행 중 ${open.length}건</small></span><span>실현+미실현<b class="${cls(total)}">${money(total)}</b></span><span>최대 손실 구간<b>${pct(r.drawdownPct)}</b></span><span>평균 보유<b>${hold(r.avgHoldHours)}</b><small>진행 중 평균 ${hold(r.openAvgHoldHours)}</small></span><span>운영<b>${esc(r.days)}일</b></span></div>
 <ul class="readiness-checks" aria-label="전환 기준 ${r.checks.filter(c=>c.ok).length}/${r.checks.length} 충족">${r.checks.map(c=>`<li class="${c.ok?'ok':'todo'}"><i>${c.ok?'✓':'○'}</i><span>${esc(c.label)}</span><b>${esc(c.value)}</b></li>`).join('')}</ul>
 ${r.serious?.length?`<p class="live-warn-text">주문 문제: ${r.serious.map(s=>esc(s.symbol+' '+(SERIOUS_KO[s.type]||s.type))).join(', ')}</p>`:''}`;
}

function bindCopyButtons(el){
 if(!el||el.dataset.bound)return;el.dataset.bound='1';
 const call=async(btn,path,body,busy)=>{
  const msg=el.querySelector('[data-copy-msg]');btn.disabled=true;btn.textContent=busy;
  try{const r=await fetch(path,{method:'POST',cache:'no-store',headers:{'Content-Type':'application/json'},body:JSON.stringify(body||{})}),d=await r.json().catch(()=>({}));
   if(!r.ok)throw Error(d.error||'HTTP '+r.status);
   if(msg)msg.textContent=d.armed===true?'✓ 활성화됐습니다':d.armed===false?'✓ 비활성화됐습니다':'✓ 완료'}
  catch(e){if(msg){msg.textContent='실패: '+e.message;msg.classList.add('err')}}
  document.getElementById('liveRefresh')?.click()};
 el.addEventListener('click',e=>{
  const resume=e.target.closest('[data-copy-resume]'),disarm=e.target.closest('[data-copy-disarm]'),arm=e.target.closest('[data-copy-arm]');
  const fp=e.target.closest('[data-copy-fail-page]');
 if(fp){setCopyFailPage(failPage+Number(fp.dataset.copyFailPage));const box=fp.closest('#realCopy,#liveCopy');if(box&&lastCopy)box.innerHTML=copyHTML(lastCopy);return}
 const pg=e.target.closest('[data-copy-page]');
 if(pg){setCopyPage(copyPage+Number(pg.dataset.copyPage));const box=pg.closest('#realCopy,#liveCopy');if(box&&lastCopy)box.innerHTML=copyHTML(lastCopy);pg.blur?.();return}
 if(resume)return call(resume,'/api/copy/resume',{confirm:'COPY_RESUME'},'다시 시작하는 중…');
  if(disarm)return call(disarm,'/api/copy/disarm',null,'끄는 중…');
  if(arm&&window.confirm('실계좌(실제 돈)로 카피 매매를 켭니다. 손절 없이 트레이더 청산만 따라가며, 카피 전체 손실이 잔고의 50%에 닿으면 모두 청산합니다. 켤까요?'))return call(arm,'/api/copy/arm',{confirm:'COPY_ARM'},'켜는 중…')})}

function render(o){
 const $=id=>document.getElementById(id),m=modeInfo(o.mode);
 if($('liveReadiness')){$('liveReadiness').hidden=!o.readiness;$('liveReadiness').innerHTML=readinessHTML(o.readiness,(o.positions||[]).map(p=>({symbol:p.symbol,direction:p.direction,unrealizedUSD:p.unrealized?.usd??null})))}
 for(const [id,text] of [['liveHeading',m.title],['navLiveLabel',o.mode==='LIVE'?'실매매':'테스트넷']])if($(id))$(id).textContent=text;
 if($('navLiveMode'))$('navLiveMode').textContent=m.badge;
 if($('liveModeBadge'))$('liveModeBadge').innerHTML=modeBadgeHTML(o);
 const status=$('liveStatus');
 if(status){status.replaceChildren(...liveRows(o).map(([k,v])=>{const row=document.createElement('div'),dt=document.createElement('span'),dd=document.createElement('b');
  row.className='kv-row';dt.textContent=k;dd.textContent=v;row.append(dt,dd);return row}));status.classList.toggle('warn',Boolean(o.killSwitch||o.mode==='LIVE'))}
 if($('liveTest'))$('liveTest').hidden=o.mode!=='TESTNET';
 // The button for the current state is shown as selected and cannot be pressed again.
 const armedNow=Boolean(o.armed&&o.mode!=='OFF');
 if($('liveArm')){$('liveArm').disabled=armedNow||o.mode==='OFF';$('liveArm').textContent=armedNow?'● 활성화됨':'활성화';$('liveArm').classList.toggle('is-current',armedNow)}
 if($('liveDisarm')){$('liveDisarm').disabled=!armedNow;$('liveDisarm').textContent=armedNow?'비활성화':'○ 비활성';$('liveDisarm').classList.toggle('is-current',!armedNow)}
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
 // Real-money copy has its own page (실계좌); the testnet page keeps only testnet copies.
 const copy=o.copy,real=copy?.mode==='LIVE';
 for(const id of ['liveCopy','realCopy'])bindCopyButtons($(id));
 if($('liveCopySection')){$('liveCopySection').hidden=!copy||real;if(copy&&!real&&$('liveCopy'))$('liveCopy').innerHTML=copyHTML({...copy,followArmed:Boolean(o.armed&&!o.killSwitch)})}
 if($('realCopy'))$('realCopy').innerHTML=real?copyHTML(copy):'<p class="empty-small">실계좌 카피가 설정되어 있지 않습니다. 서버 <code>.env</code>에 <code>COPY_MODE=LIVE</code>와 확인 문구를 직접 넣어야 이 화면에서 켤 수 있습니다.</p>';
 const realBadge=!real?'설정 안 됨':!copy.enabled?'꺼짐':copy.killed?'손실 한도 정지':copy.armed?'● 활성화됨':'○ 비활성';
 if($('navRealMode'))$('navRealMode').textContent=!real?'—':copy.armed&&!copy.killed?'ON':'OFF';
 if($('realModeBadge'))$('realModeBadge').innerHTML=`<span class="live-flag ${real&&copy.killed?'kill':real&&copy.armed?'armed':''}">실계좌 카피 · ${esc(realBadge)}</span>`;
 bindScalpButtons($('liveScalp'));
 if($('liveScalpSection')){$('liveScalpSection').hidden=!o.scalp;if(o.scalp&&$('liveScalp'))$('liveScalp').innerHTML=scalpHTML(o.scalp)}
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
const DELETE_REASONS={ACTIVE:'보유 중이거나 확인이 필요한 거래는 삭제할 수 없습니다',TODAY_COUNTS_FOR_DAILY_RISK:'오늘 종료된 거래는 하루 손실 한도 계산에 쓰여 내일부터 삭제할 수 있습니다',NOT_FOUND:'이미 삭제된 기록입니다',SAFETY_RECORD:'긴급 정지를 일으킨 기록이라 남겨 둡니다'};
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
 // The 실계좌 page (#real) shows the same data (user 2026-11-16: its positions did not refresh, only #live counted).
 const visible=()=>['live','real'].some(id=>$(id)&&!$(id).hidden);
 const tick=()=>{if(visible())load().catch(fail)};
 setInterval(tick,10000);setTimeout(()=>load().catch(fail),400);
 // 실계좌 page: the copy panel alone every 3 s (prices cached 3 s on the server, balance 15 s), while visible.
 let fastBusy=false;
 setInterval(async()=>{const el=$('realCopy');if(!el||$('real')?.hidden||document.hidden||fastBusy)return;fastBusy=true;
  try{const r=await fetch('/api/copy',{cache:'no-store'});if(r.ok){const c=await r.json();if(c?.mode==='LIVE'&&!el.contains(document.activeElement))el.innerHTML=copyHTML(c)}}catch{}finally{fastBusy=false}},3000);window.addEventListener('hashchange',()=>setTimeout(tick,60));
}
