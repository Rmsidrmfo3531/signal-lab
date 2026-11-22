// 실매매 (live / testnet) screen. Calls only this server's /api/live endpoints; no keys are ever
// sent or shown here. Order actions require an explicit user action.
import {priceFmt} from './price_format.js';
import {displaySymbol} from './symbol_display.js';
import {createRealTradeController} from './real_trade.js';

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
const symText=v=>displaySymbol(v);
const symTag=(v,cls='')=>{const raw=String(v??''),d=displaySymbol(raw);return `<b${cls?` class="${cls}"`:''}${d&&d!==raw?` title="${esc(raw)}"`:''}>${esc(d)}</b>`};
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
 const balance=!b?'—':b.error?`조회 실패 (${b.error})`:fin(b.usd)?`${money(b.usd)} ${LABEL[b.venue]||b.venue||''} 순자산${b.capUSD?` · 계산은 최대 $${b.capUSD}까지`:''}`:'조회 중';
 const showBalance=!(s.testnet?.budget?.accountEquityUSD!==undefined&&(!b||b.venue==='BINGX'));
 // One place per fact (user 2026-11-18): the on/off state is on the 활성화 button, the time in the header (liveUpdated).
 const account=[['거래소',(s.venues||[]).map(v=>LABEL[v]||v).join(' · ')||'—'],...(showBalance?[['잔고',balance]]:[]),
  ['API 키',['BINGX','GATEIO'].map(v=>`${LABEL[v]} ${s.credentialsConfigured?.[v]?'설정됨':'없음'}`).join(' · ')]];
 if(s.testnet?.scalpOnly)return [...account,['전략','5분봉 되돌림 단타']];
 return [...account,
  ...(L.strategyProfile?[['전략',L.strategyProfile==='HYBRID'?`HYBRID · 위험 한도로 수량 역산 · 추매 1·1·2·4(최대 ${L.hybridMaxAdds}회) 매물대`:'CURRENT (기존 규칙)']]:[]),
  ...(L.riskProfile?[['위험 프로필',L.riskProfile==='GROWTH'?`수익형(거래당 ${L.maxLossPct??3}% · ${s.testnet?'신호 자체 ':''}열린 위험·하루 ${L.dailyMaxLossPct??9}%)`:L.riskProfile==='CONSERVATIVE'?'보수(거래당 1% · 하루 3%)':'기존(승인 전 실거래 값)']]:[]),
  ...(s.testnet?.budget?[['테스트넷 공동 한도',`신호+단타 하루 손실·열린 위험 ${s.testnet.budget.dailyLossPct}% · 증거금 ${s.testnet.budget.marginCapPct}% · 거래당 위험은 신호 ${L.maxLossPct??3}% · 단타 ${s.scalp?.settings?.riskPct??0.5}%`]]:[]),
  ...(L.sizing==='BALANCE'?[['수량',L.strategyProfile==='HYBRID'?`추매까지 모두 체결 후 손절 시 손실 = 잔고의 ${L.maxLossPct}%가 되도록 첫 수량 역산 · 포지션마다 같은 크기(잔고의 ${L.marginUsePct??25}% 이내)`:`잔고${L.balanceCapUSD?`(최대 $${L.balanceCapUSD})`:''} × ${L.unitPct}% × 배율 · 포지션마다 같은 크기(잔고의 ${L.marginUsePct??25}% 이내), 매물대 분할 추매`],...(L.riskProfile?[]:[['손실 한도',`1회 잔고 ${L.maxLossPct}% · 하루 ${L.dailyMaxLossPct}%`]])]
   :[['손실 한도',`1회 $${L.maxRiskUSD} · 하루 $${L.dailyMaxRiskUSD}`]]),
  ['동시 포지션',L.maxOpen>0?`${L.maxOpen}개${L.maxPerDirection?` (롱·숏 각 ${L.maxPerDirection}개)`:''}`:'개수 제한 없음 (손실 합계 한도로 관리)']];
}

/** Rows behind "규칙 보기" (rules); the rest stay visible. */
export const LIVE_RULE_KEYS=Object.freeze(['전략','위험 프로필','테스트넷 공동 한도','수량','손실 한도','동시 포지션']);
/** Header: the mode once (TESTNET 모의 자금 / LIVE 실제 돈 / OFF), plus 긴급 정지 when on. On / off is the 활성화 button's. */
export function modeBadgeHTML(s){
 const m=modeInfo(s.mode);
 return `<span class="live-mode ${m.cls}"><strong>${esc(m.badge)}</strong><span>${esc(m.text)}</span></span>${s.killSwitch?'<b class="live-flag kill">긴급 정지 중</b>':''}`;
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
function positionMetricsHTML(p){
 const pf=priceFmt(p),u=p.unrealized,q=p.quantity||{};
 const qty=`${qtyFmt(q.base)} ${esc(p.asset)}${q.unit==='CONTRACT'&&fin(q.venue)?` (${qtyFmt(q.venue)}계약)`:''}`;
 const curNote=p.currentPriceSource==='EXCHANGE'?'거래소 표시가':p.currentPriceSource==='VENUE_BOOK'?'거래소 호가 중간값':p.currentPriceSource==='VENUE_TICKER'?'거래소 최근 체결가':'시세 대기';
 const pnl=u?`<b class="${pnlClass(u.usd)}">${usd(u.usd)}${fin(u.pct)?` (${Number(u.pct)>=0?'+':''}${Number(u.pct).toFixed(2)}%)`:''}</b><small>${u.source==='EXCHANGE'?'거래소 계산':'추정 (평균가·현재가)'}${fin(u.pct)?' · 증거금 대비':''}</small>`:'<b>—</b><small>시세 대기</small>';
 return `<span>첫 진입가<b>${pf(p.firstEntryPrice)}</b></span>
  <span>평균 진입가<b>${pf(p.averageEntryPrice)}</b></span>
  <span>현재가<b>${pf(p.currentPrice)}</b><small>${curNote}</small></span>
  <span>수량<b>${qty}</b></span>
  <span>미실현 손익${pnl}</span>
  <span>증거금<b>${p.margin?'$'+Number(p.margin.usd).toFixed(2):'—'}</b><small>${p.margin?.source==='EXCHANGE'?'거래소':p.margin?'추정 (평균가×수량÷배율)':''}</small></span>
  <span>실현 손익<b class="${p.realizedOpen?pnlClass(p.realizedOpen.usd):''}">${p.realizedOpen?usd(p.realizedOpen.usd):'—'}</b><small>${p.realizedOpen?'부분 익절·수수료 포함':'거래소 값 없음'}</small></span>
  <span>추매<b>${esc(p.adds?.filled??0)}차 / ${p.adds?.repeat?'한도 내 반복':`최대 ${esc(p.adds?.max??0)}차`}</b>${p.adds?.skipped?`<small>주문 못 낸 추매 ${esc(p.adds.skipped)}건</small>`:''}</span>`;
}
function testnetCloseButton(strategy,key,p){
 const busy=testnetCloseBusy.has(strategy+'|'+key);
 return `<div class="tn-close-actions"><button type="button" class="outline-btn small danger-btn" data-testnet-close="${esc(key)}" data-strategy="${strategy}" data-symbol="${esc(p.symbol)}" data-direction="${esc(p.direction)}"${busy?' disabled':''}>${busy?'청산 확인 중…':'전량 청산'}</button></div>`;
}
export function positionCardHTML(p,{badge='',allowClose=false}={}){
 const pf=priceFmt(p),pending=p.adds?.pending||[];
 const addsLine=pending.length?`<span class="add-chips">${pending.map(a=>`<span class="add-chip"><i>${a.n}차</i>${pf(a.price)}<small>${qtyFmt(a.qty)}</small></span>`).join('')}</span>`:'없음';
 const ev=p.lastEvent?`${esc(p.lastEvent.label)}${p.lastEvent.reason?' · '+esc(p.lastEvent.reasonKo||p.lastEvent.reason):''} · ${time(p.lastEvent.at)}`:'—';
 return `<article class="paper-trade live-position${p.status==='UNKNOWN'?' live-warn':''}">
 <header><b>${esc(p.symbol)}</b>${badge}${side(p.direction)}${horizonTag(p)}<span>${fin(p.leverage)?esc(p.leverage)+'배 교차':'배율 —'} · ${esc(LABEL[p.venue]||p.venue)}</span><span class="live-state s-${esc(p.status)}">${esc(p.statusKo||LIVE_STATUS[p.status]||p.status)}</span></header>
 <div class="paper-trade-values live-values">
  ${positionMetricsHTML(p)}
  <span>손절가<b>${pf(p.stop)}</b>${p.breakevenMoved?'<small>TP1 체결 후 본절 이동</small>':''}</span>
  <span class="tp-cell">TP1 · TP2 · TP3<b>${(p.targets||[]).map(pf).join(' · ')||'—'}</b>${p.targetsFilled?.tp1?'<small>TP1 체결됨</small>':''}</span>
 </div>
 <p class="live-line"><span>대기 중인 추매 주문</span>${addsLine}</p>
 <p class="live-line"><span>최근 처리</span>${ev}</p>
 ${p.status==='UNKNOWN'?'<p class="live-line live-warn-text">주문 결과를 확인하지 못했습니다. 거래소 앱에서 포지션·주문을 직접 확인한 뒤 긴급 정지를 해제하세요.</p>':''}
 ${levelsEditor(p)}
 ${allowClose&&p.status==='OPEN'&&p.mode==='TESTNET'&&p.test!==true&&p.signalKey?testnetCloseButton('signal',p.signalKey,p):''}
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
 COPY_AUDIT_UNAVAILABLE:'최신 거래소 포지션 조회가 없어 신규 주문 보류',COPY_AUDIT_BLOCKED:'거래소 대조 확인 필요 · 진입·추매 보류',COPY_ORDERS_UNREADABLE:'거래소 미체결 주문 조회 실패',COPY_OPEN_ORDERS_EXIST:'거래소에 같은 종목의 미체결 주문이 있음',
 MONITOR_RESTART_SNAPSHOT:'채널 재시작 직후 기존 포지션 재알림',LIVE_DISARMED:'실매매 비활성',COPY_DISARMED:'카피 비활성',ENTRY_INTERRUPTED:'주문 준비 중 거래가 정지됨',UPDATING:'업데이트 중',KILL_SWITCH:'긴급 정지 중',NOT_TESTNET:'테스트넷 아님',NO_BINGX_CONTRACT:'BingX에 없는 종목',
 NOT_COPIED:'따라 들어가지 않은 포지션',OUR_COPY_CLOSED:'우리가 먼저 정리한 포지션 (손실 한도·보호 손절 등, 트레이더 청산 전까지 다시 안 들어감)',COPY_CLOSED_EXTERNALLY:'거래소에서 수동 청산이 확인된 포지션 — 트레이더 추매·진입은 다시 따라감',EXTERNAL_UNCONFIRMED:'바깥 청산인지 확인 불가로 다시 따라가지 않음',CLOSING:'청산 중인 포지션(추매 안 함)',LIQUIDATION:'강제청산 — 다시 따라가지 않음',ADL:'자동 감축(ADL) 청산 — 다시 따라가지 않음',STOP_OR_EXTERNAL:'거래소에서 사라짐(외부 청산 또는 보호 손절)',POSITION_GONE:'거래소에 포지션 없음',STALE_MESSAGE:'순서가 늦게 도착한 옛 메시지',QUANTITY_INVALID:'수량 계산 불가',NO_BALANCE:'잔고 조회 실패',HTTP_429:'요청 과다(잠시 후 재시도)',COPY_MARGIN_CAP:'카피 전체 증거금 한도',MIN_ORDER_TOO_LARGE:'거래소 최소 주문이 증거금 5달러 초과',PRICE_MISMATCH:'거래소 가격 불일치',PRICE_UNVERIFIED:'거래소 가격 확인 실패',VENUE_ERROR_101400:'거래소 주문 조건 미달(최소 주문 수량·금액 등)',QUANTITY_UNIT_UNCLEAR:'알림 수량 단위 불명',COPY_LOSS_LIMIT:'카피 손실 한도로 정지',LOSS_CAP_REACHED:'손실 한도 도달',NO_STOP:'보호 손절 실패로 청산',SYMBOL_BLOCKED:'제외 목록(블랙리스트) 종목',SYMBOL_NOT_ALLOWED:'허용 목록(화이트리스트) 외 종목',SYMBOL_MARGIN_CAP:'종목당 최대 증거금 한도 초과',COPY_COOLDOWN:'자동 쿨다운(휴식) 중',UPDATE_DEFERRED_EXPIRED:'업데이트 대기 시간 초과',UPDATE_DEFERRED_DRIFT:'업데이트 재시작 후 가격 이탈 초과'};
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
// Real account (user 2026-11-17 23:19 "보유중과 거래소 전체 포지션을 합쳐줘"): one "보유 중" list from the exchange's
// own positions; copy rows also show the copy record's adds and holding time, manual rows the 수동 badge. Copy records
// the exchange doesn't show (yet) are listed under it as "거래소 확인 중".
// Only the table scrolls horizontally; controls, headings and totals stay fixed.
// tabindex makes the overflow region keyboard-scrollable on desktop.
const scrollCopyTable=(table,label)=>`<div class="copy-table-scroll" role="region" aria-label="${esc(label)}" tabindex="0">${table}</div>`;
export function venuePositionsHTML(c,copyOpen=[]){
 if(!c||c.mode!=='LIVE'||!('venuePositions' in c||c.venuePositionsError))return '';
 const list=Array.isArray(c.venuePositions)?c.venuePositions:null,manual=(list||[]).filter(p=>p.origin!=='copy');
 const money=v=>!fin(v)?'—':`${Number(v)>=0?'+':'−'}$${Math.abs(Number(v)).toFixed(2)}`,usdv=v=>!fin(v)?'—':`$${Number(v).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}`;
 const cls=v=>!fin(v)?'':Number(v)>0?'paper-profit':Number(v)<0?'paper-loss':'',px=v=>fin(v)&&Number(v)>0?esc(+Number(v).toPrecision(6)):'—';
 const pct=v=>!fin(v)?'—':`${Number(v)>=0?'+':'−'}${Math.abs(Number(v)).toFixed(1)}%`,mm=p=>p.marginMode==='ISOLATED'?'격리':'교차';
 const badge=p=>p.origin==='copy'?'<span class="vp-badge copy">카피</span>':'<span class="vp-badge manual">수동</span>';
 const sum=a=>a.reduce((t,p)=>t+(Number(p.unrealized)||0),0);
 const hhmm=t=>t?new Date(t).toLocaleTimeString('ko-KR',{hour12:false}):'';
 const fail=c.venuePositionsError?`<span class="vp-fail" title="${esc(c.venuePositionsError)}">갱신 실패${list&&c.venuePositionsAt?` · ${hhmm(c.venuePositionsAt)} 목록`:''}</span>`:'';
 const keyOf=(sym,dir)=>displaySymbol(String(sym||'').replace(/[-_]/g,'').toUpperCase())+'|'+dir;
 const rec=new Map(copyOpen.map(p=>[keyOf(p.symbol,p.direction),p])),seen=new Set();
 const info=p=>{if(p.origin!=='copy')return null;const r=rec.get(keyOf(p.symbol,p.direction));if(r)seen.add(r);return r};
 const partialCount=r=>r?.reduces!=null&&Number.isSafeInteger(Number(r.reduces))&&Number(r.reduces)>=0?esc(r.reduces)+'회':'—';
 const heldTxt=r=>{if(!r?.openedAt)return '—';const m=Math.max(0,Math.round((Date.now()-r.openedAt)/60000));return m<60?`${m}분`:m<1440?`${Math.floor(m/60)}시간 ${m%60}분`:`${Math.floor(m/1440)}일 ${Math.floor(m%1440/60)}시간`};
 const head=`<h5 class="copy-sub">보유 중 <small>${list?`${list.length}개 · 카피 ${list.length-manual.length}개 · 수동 ${manual.length}개`:'조회 전'}</small>${fail}</h5>`;
 if(!list)return head+'<p class="empty-small">거래소 포지션을 아직 읽지 못했습니다.</p>';
 if(!list.length&&!copyOpen.length)return head+'<p class="empty-small">보유 중인 포지션이 없습니다. 채널에 새 진입 알림이 오면 따라 들어갑니다.</p>';
 const totals=`<p class="copy-stamp vp-total">미실현 합계 <b class="${cls(sum(list))}">${money(sum(list))}</b> · 수동만 <b class="${cls(sum(manual))}">${manual.length?money(sum(manual)):'—'}</b></p>`;
 const tr=c.trailing||null;
 const trInfo=p=>{
  if(!tr?.enabled)return null;
  const isCopy=p.origin==='copy';
  if((isCopy&&!tr.applyToCopy)||(!isCopy&&!tr.applyToManual))return null;
  const disp=symText(p.symbol),excluded=(tr.excludedSymbols||[]).includes(disp);
  const st=tr.tracked?.[keyOf(p.symbol,p.direction)]||null;
  return {disp,excluded,st};
 };
 const trBadge=p=>{
  const info=trInfo(p);if(!info)return '';
  if(info.excluded)return '<span class="vp-badge" title="자동 트레일링 제외 종목">트레일 제외</span>';
  if(info.st?.partialTaken&&fin(info.st?.peakRoePct))return `<span class="vp-badge copy" title="50% 부분 익절 완료 · 잔여 50% 트레일링 중">50%확정·고점 +${Number(info.st.peakRoePct).toFixed(1)}%</span>`;
  if(fin(info.st?.peakRoePct))return `<span class="vp-badge copy" title="고점 대비 ${esc(tr.trailPullbackRatio)}% 되돌림 시 자동 익절">트레일 고점 +${Number(info.st.peakRoePct).toFixed(1)}%</span>`;
  return '';
 };
 const stopBadge=p=>{
  if(fin(p.stop))return `<span class="vp-badge" title="거래소 손절 주문 설정됨">🛡 손절 ${px(p.stop)}</span>`;
  if(p.origin!=='copy'&&p.stopChecked===true)return '<span class="vp-badge warn" title="손절 주문이 없습니다. 아래 버튼으로 즉시 설정할 수 있습니다.">⚠ 손절 없음</span>';
  return '';
 };
 const posActions=p=>{
  const inProfit=fin(p.unrealized)&&Number(p.unrealized)>0,sym=esc(p.symbol),dir=esc(p.direction),sz=esc(qtyFmt(p.size)),lev=esc(p.leverage||''),mmMode=esc(p.marginMode||'CROSSED');
  const info=trInfo(p);
  const slBtn=p.origin!=='copy'&&!fin(p.stop)?`<button type="button" class="vp-act-btn warn" data-pos-action="SET_STOP_LOSS" data-pos-sl-roe="15" data-pos-symbol="${sym}" data-pos-dir="${dir}" data-pos-size="${sz}" title="현재 포지션에 −15% ROE 손절(STOP_MARKET) 즉시 설정">🛡 -15% 손절</button>`:'';
  const trBtn=info?`<button type="button" class="vp-act-btn" data-trail-toggle="${esc(info.disp)}" title="${info.excluded?'이 종목을 자동 트레일링 대상에 다시 포함':'이 종목을 자동 트레일링에서 제외'}">${info.excluded?'트레일 포함':'트레일 제외'}</button>`:'';
  return `<div class="vp-actions"><button type="button" class="vp-act-btn trade" data-trade-fill data-pos-symbol="${sym}" data-pos-lev="${lev}" data-pos-mm="${mmMode}" title="이 종목을 수동 주문 패널에 불러오기">주문/추매</button><button type="button" class="vp-act-btn" data-pos-action="CLOSE_HALF" data-pos-symbol="${sym}" data-pos-dir="${dir}" data-pos-size="${sz}" title="보유 수량의 50% 시장가 부분 청산">50% 청산</button><button type="button" class="vp-act-btn danger" data-pos-action="CLOSE_ALL" data-pos-symbol="${sym}" data-pos-dir="${dir}" data-pos-size="${sz}" title="해당 포지션 전량 시장가 청산">전량</button><button type="button" class="vp-act-btn" data-pos-action="BREAKEVEN_STOP" data-pos-symbol="${sym}" data-pos-dir="${dir}" data-pos-size="${sz}"${inProfit?'':' disabled'} title="${inProfit?'평균 진입가에 본전 스탑 설정':'수익 구간에서만 본전 스탑 가능'}">본전 스탑</button>${slBtn}${trBtn}</div>`;
 };
 const row=p=>{const r=info(p);return `<li class="${p.origin==='copy'?'':'vp-manual'}">${symTag(p.symbol)}${badge(p)}${stopBadge(p)}${trBadge(p)}${side(p.direction)}<span>${esc(p.leverage??'—')}배 ${mm(p)}</span><span>수량 ${esc(qtyFmt(p.size))} · 평단 ${px(p.avg)}</span><span class="muted">현재 ${px(p.mark)} · 증거금 ${usdv(p.margin)}${p.liquidation?` · 청산 ${px(p.liquidation)}`:''}${r?` · 추매 ${esc(r.adds||0)}회 · 부분청산 ${partialCount(r)} · ${heldTxt(r)}`:''}</span><b class="${cls(p.unrealized)} end">${money(p.unrealized)} <small>${pct(p.roePct)}</small></b>${posActions(p)}</li>`};

 const table=`<table class="copy-table vp-table vp-two-row only-desk">
  <colgroup><col style="width:26%"><col style="width:12%"><col style="width:12%"><col style="width:17%"><col style="width:18%"><col style="width:15%"></colgroup>
  <thead><tr><th>종목·구분</th><th>방향</th><th>배율</th><th class="num">수량</th><th class="num">평단</th><th class="num">현재가</th></tr></thead>
  <tbody>${list.map(p=>{
   const r=info(p),manual=p.origin==='copy'?'':' vp-manual';
   return `<tr class="vp-primary${manual}">
    <td class="vp-symbol-cell" rowspan="2">${symTag(p.symbol,'vp-symbol')} ${badge(p)} ${stopBadge(p)} ${trBadge(p)}${posActions(p)}</td>
    <td>${side(p.direction)}</td>
    <td>${esc(p.leverage??'—')}배 <small class="muted">${mm(p)}</small></td>
    <td class="num">${esc(qtyFmt(p.size))}</td><td class="num">${px(p.avg)}</td><td class="num">${px(p.mark)}</td>
   </tr><tr class="vp-secondary${manual}">
    <td><small>증거금</small><b>${usdv(p.margin)}</b></td>
    <td><small title="부분청산은 실제 수량을 줄인 횟수이며 익절 여부와는 별개입니다.">추매 · 부분청산</small><b>${r?esc(r.adds||0)+'회':'—'} · ${partialCount(r)}</b></td>
    <td class="num"><small>보유</small><b>${r?heldTxt(r):'—'}</b></td>
    <td class="num"><small>미실현 · 수익률</small><b class="${cls(p.unrealized)}">${money(p.unrealized)} <span class="vp-roe ${cls(p.roePct)}">(${pct(p.roePct)})</span></b></td>
    <td class="num"><small>청산가</small><b>${px(p.liquidation)}</b></td>
   </tr>`;
  }).join('')}</tbody></table>`;
 const body=`<ul class="copy-list only-mob">${list.map(row).join('')}</ul>`+scrollCopyTable(table,'실계좌 보유 포지션'); // fills `seen`
 const pending=copyOpen.filter(r=>!seen.has(r));
 const pend=pending.length?`<p class="copy-stamp">거래소 확인 중인 카피 기록 ${pending.length}개: ${pending.map(r=>`${symTag(r.symbol)} ${side(r.direction)}`).join(' · ')}</p>`:'';
 return head+(list.length?totals:'')+body+pend;
}

// Recent closes: 10 at a time with page buttons (user 2026-11-17 "10건으로 해주고 페이지 형식으로").
let copyPage=0,failPage=0,failOpen=false,controlsOpen=false,alertsOpen=false,trailingOpen=false,safetyOpen=false,analyticsOpen=false,analyticsTab='symbol',lastCopy=null,realTradeCtrl=null;
export function setFailOpen(v){failOpen=!!v}
export function setControlsOpen(v){controlsOpen=!!v}
export function setAlertsOpen(v){alertsOpen=!!v}
export function setTrailingOpen(v){trailingOpen=!!v}
export function setSafetyOpen(v){safetyOpen=!!v}
export function setAnalyticsOpen(v){analyticsOpen=!!v}
export function setAnalyticsTab(t){if(['symbol','hour','leverage'].includes(t))analyticsTab=t}
export const COPY_PAGE_SIZE=10;
export function setCopyPage(p){copyPage=Math.max(0,p|0)}
export function setCopyFailPage(p){failPage=Math.max(0,p|0)}

export function analyticsHTML(a){
 if(!a||!((a.summary?.trades||0)>0||(a.curve?.length||0)>0||(a.costs?.tradesWithCost||0)>0))return '';
 const s=a.summary||{},curve=a.curve||[],costs=a.costs||null;
 const mny=v=>!fin(v)?'—':`${Number(v)>=0?'+':'−'}$${Math.abs(Number(v)).toFixed(2)}`;
 const cl=v=>!fin(v)?'':Number(v)>0?'paper-profit':Number(v)<0?'paper-loss':'';
 const mddVal=fin(s.maxDrawdownUSD)&&Number(s.maxDrawdownUSD)>0?`−$${Number(s.maxDrawdownUSD).toFixed(2)}${fin(s.maxDrawdownPct)?` (${Number(s.maxDrawdownPct).toFixed(1)}%)`:''}`:'$0.00';
 const summaryBar=`<div class="an-summary">
  <span>최대 낙폭 (MDD)<b class="${Number(s.maxDrawdownUSD)>0?'paper-loss':''}">${mddVal}</b></span>
  <span>기대값 (평균)<b class="${cl(s.avgUSD)}">${mny(s.avgUSD)}</b></span>
  <span>평균 익절 / 손절<b><i class="paper-profit">${mny(s.avgWinUSD)}</i> / <i class="paper-loss">${mny(s.avgLossUSD)}</i></b></span>
  <span>최대 연승 / 연패<b>${esc(s.maxWinStreak||0)}연승 / ${esc(s.maxLossStreak||0)}연패</b></span>
 </div>`;
 const costsBox=(()=>{
  if(!costs)return '';
  const warn=costs.feeTurnedLoss||(fin(costs.feeDrainPct)&&Number(costs.feeDrainPct)>=40);
  const ratioTxt=costs.feeTurnedLoss?'수수료로 손실 전환':fin(costs.feeDrainPct)?`수익의 ${Number(costs.feeDrainPct).toFixed(1)}% 소모`:'';
  const leaks=Array.isArray(costs.topFeeLeaks)&&costs.topFeeLeaks.length
   ?`<div class="an-cost-leaks"><small>수수료 누수 Top:</small> ${costs.topFeeLeaks.map(x=>`<span class="an-leak-chip${x.feeTurnedLoss?' is-warn':''}"><b>${esc(symText(x.symbol))}</b> 매매 ${mny(x.pnlUSD)} · 비용 <i class="paper-loss">${mny(x.costUSD)}</i> → <b class="${cl(x.netUSD)}">${mny(x.netUSD)}</b></span>`).join('')}</div>`:'';
  return `<div class="an-costs${warn?' is-warn':''}">
   <div class="an-costs-head"><b>수수료 · 펀딩비 비중</b><small>${costs.source==='EXCHANGE'?'거래소 자금내역 기준':'원장 체결 기준'}${ratioTxt?` · <em>${esc(ratioTxt)}</em>`:''}</small></div>
   <div class="an-summary">
    <span>매매 손익 (비용 전)<b class="${cl(costs.realizedPnlUSD)}">${mny(costs.realizedPnlUSD)}</b></span>
    <span>거래 수수료<b class="${cl(costs.feeUSD)}">${mny(costs.feeUSD)}</b></span>
    <span>펀딩비<b class="${cl(costs.fundingUSD)}">${mny(costs.fundingUSD)}</b></span>
    <span>최종 순손익<b class="${cl(costs.netUSD)}">${mny(costs.netUSD)}</b></span>
   </div>${leaks}</div>`;
 })();
 const svg=(()=>{
  if(!curve.length)return '';
  const allVals=[0,...curve.flatMap(p=>[Number(p.totalUSD)||0,Number(p.copyUSD)||0,Number(p.manualUSD)||0])];
  const low=Math.min(...allVals),high=Math.max(...allVals),left=52,right=352,top=10,bottom=88;
  const y=v=>high===low?(top+bottom)/2:bottom-(v-low)/(high-low)*(bottom-top);
  const x=i=>left+(right-left)*i/curve.length;
  const pathFor=fn=>'M '+left+','+y(0).toFixed(1)+' '+curve.map((p,i)=>`L ${x(i+1).toFixed(1)},${y(fn(p)).toFixed(1)}`).join(' ');
  const labels=high===low?[0]:[high,low];
  return `<figure class="an-chart"><figcaption><span>누적 손익 곡선 (일별)</span><span class="an-legend"><i class="leg-tot">전체</i><i class="leg-copy">카피</i><i class="leg-man">수동</i></span></figcaption>
   <svg viewBox="0 0 360 108" role="img" aria-label="실계좌 누적 손익 및 카피 수동 비교 곡선">
    <line x1="${left}" y1="${y(0).toFixed(1)}" x2="${right}" y2="${y(0).toFixed(1)}" class="cal-chart-zero"/>
    ${labels.map(v=>`<text x="48" y="${(y(v)+3).toFixed(1)}" text-anchor="end">${esc(calAmt(v))}</text>`).join('')}
    <path class="an-line-copy" d="${pathFor(p=>Number(p.copyUSD)||0)}"/>
    <path class="an-line-man" d="${pathFor(p=>Number(p.manualUSD)||0)}"/>
    <path class="an-line-tot" d="${pathFor(p=>Number(p.totalUSD)||0)}"/>
    <text x="${left}" y="103">${esc(shortDay(curve[0].day))}</text><text x="${right}" y="103" text-anchor="end">${esc(shortDay(curve.at(-1).day))}</text>
   </svg></figure>`;
 })();
 const tab=analyticsTab;
 const tabs=`<div class="an-tabs"><button type="button" class="outline-btn small${tab==='symbol'?' is-current':''}" data-analytics-tab="symbol">종목별</button><button type="button" class="outline-btn small${tab==='hour'?' is-current':''}" data-analytics-tab="hour">시간대별 (KST)</button><button type="button" class="outline-btn small${tab==='leverage'?' is-current':''}" data-analytics-tab="leverage">레버리지별</button></div>`;
 const rows=tab==='symbol'?(a.bySymbol||[]).slice(0,15).map(r=>({name:symText(r.symbol),...r})):tab==='hour'?(a.byHourKst||[]).map(r=>({name:r.label,...r})):(a.byLeverage||[]).map(r=>({name:r.label,...r}));
 const showFee=tab==='symbol'&&rows.some(r=>fin(r.feeUSD));
 const table=rows.length?`<div class="copy-table-scroll an-scroll" role="region" aria-label="성과 분석표" tabindex="0"><table class="copy-table analytics-table"><thead><tr><th>${tab==='symbol'?'종목':tab==='hour'?'시간대 (KST)':'레버리지'}</th><th class="num">거래</th><th class="num">승률</th><th class="num">PF</th><th class="num">평균</th>${showFee?'<th class="num">수수료</th>':''}<th class="num">누적 손익</th></tr></thead><tbody>${rows.map(r=>`<tr class="${r.trades?'':'muted'}"><td><b>${esc(r.name)}</b></td><td class="num">${esc(r.trades)}건</td><td class="num">${r.winRatePct!=null?esc(r.winRatePct)+'%':'—'}</td><td class="num">${r.profitFactor!=null?esc(r.profitFactor):r.trades&&r.netUSD>0?'∞':'—'}</td><td class="num ${cl(r.avgUSD)}">${mny(r.avgUSD)}</td>${showFee?`<td class="num ${cl(r.feeUSD)}">${fin(r.feeUSD)?mny(r.feeUSD):'—'}</td>`:''}<td class="num"><b class="${cl(r.netUSD)}">${r.trades?mny(r.netUSD):'—'}</b></td></tr>`).join('')}</tbody></table></div>`:'<p class="empty-small">집계할 정산 거래가 아직 없습니다.</p>';
 return `<details class="copy-analytics-fold"${analyticsOpen?' open':''}><summary data-analytics-toggle><b>성과 분석 · 수익 곡선 · MDD</b> <small>MDD ${mddVal}${fin(s.avgUSD)?` · 평균 ${mny(s.avgUSD)}`:''}${costs&&fin(costs.totalCostUSD)?` · 비용 ${mny(costs.totalCostUSD)}`:''}</small></summary><div class="an-body">${summaryBar}${costsBox}${svg}${tabs}${table}</div></details>`;
}
// Copy and manual closes together (user 2026-11-17 "수동 매매도 누적 수익·기록은 똑같이, 수동인지만 표시"): manual trades
// on the real account (manual_ledger.mjs) are listed and counted like copy trades, marked 수동. Page totals only:
// the copy loss limit, margin limits and copy decisions are computed on the server from the copy ledger alone.
export function mergedCloses(c){
 const copy=(c?.closed||[]).map(x=>x.origin==='manual'?x:{...x,origin:'copy'}),manual=(c?.manual?.closed||[]).map(x=>({...x,origin:'manual'}));
 return [...copy,...manual].sort((a,b)=>(Number(b.closedAt)||0)-(Number(a.closedAt)||0));
}
/** Totals of the closes the page counts: every copy close (as before) and every settled manual close (a manual close
 * still PENDING has no result yet). {all, copy, manual}: n, wins, net, gross, loss; plus pending manual closes. */
const confirmedCopyResult=x=>['EXCHANGE','EXCHANGE_FILLS'].includes(x.netSource)&&fin(x.netUSD)&&String(x.netUSD).trim()!=='';
export function copyStats(c,{confirmedOnly=false}={}){
 const one=list=>{
  const known=list.filter(x=>confirmedOnly?confirmedCopyResult(x):!['PENDING','UNKNOWN'].includes(x.netSource)&&x.netUSD!=null&&String(x.netUSD).trim()!==''&&fin(x.netUSD));
  const values=known.map(x=>Number(x.netUSD)),wins=values.filter(x=>x>0),losses=values.filter(x=>x<0);
  const sum=rows=>rows.reduce((a,x)=>a+x,0),confirmed=known.filter(x=>['EXCHANGE','EXCHANGE_FILLS'].includes(x.netSource)).map(x=>Number(x.netUSD));
  const settled=confirmed.length;
  const pending=list.filter(x=>x.netSource==='PENDING').length;
  return {n:known.length,wins:wins.length,net:sum(values),gross:sum(wins),loss:-sum(losses),
   settled,confirmedNet:sum(confirmed),confirmedWins:confirmed.filter(x=>x>0).length,estimated:known.length-settled,pending,unknown:list.length-known.length-pending};
 };
 const all=mergedCloses(c),copy=one(all.filter(x=>x.origin!=='manual')),manual=one(all.filter(x=>x.origin==='manual')),totals=one(all);
 return {all:totals,copy,manual,pending:totals.pending};
}
// Monthly BingX P&L in KST, with Monday-first weeks.
const KST_MS=9*3600000;
export const kstDate=t=>new Date(t+KST_MS).toISOString().slice(0,10);
const shortDay=date=>`${Number(date.slice(5,7))}/${Number(date.slice(8))}`;
const ymShift=(ym,n)=>{const [y,m]=ym.split('-').map(Number);return new Date(Date.UTC(y,m-1+n,1)).toISOString().slice(0,7)};
let calMonth=null;
export function setCalMonth(ym){calMonth=typeof ym==='string'&&/^\d{4}-(0[1-9]|1[0-2])$/.test(ym)?ym:null}
export function calendarWeeks(byDay,ym){
 const [y,m]=ym.split('-').map(Number),first=new Date(Date.UTC(y,m-1,1));
 const cells=Array((first.getUTCDay()+6)%7).fill(null),days=new Date(Date.UTC(y,m,0)).getUTCDate();
 for(let day=1;day<=days;day++){
  const date=`${ym}-${String(day).padStart(2,'0')}`,value=byDay?.[date];
  cells.push({date,day,value:fin(value)?Number(value):null});
 }
 while(cells.length%7)cells.push(null);
 return Array.from({length:cells.length/7},(_,i)=>cells.slice(i*7,i*7+7));
}
// Compact amounts for a phone cell. The full amount goes in the cell title.
const calAmt=v=>{const a=Math.abs(v),s=v>0?'+':v<0?'−':'';return s+'$'+(a<9.995?a.toFixed(2):a<99.95?a.toFixed(1):a<999.5?Math.round(a).toString():(a/1000).toFixed(1)+'k')};
const hhmm=t=>new Date(Number(t)+KST_MS).toISOString().slice(11,16);
function pnlCurve(points,label){
 const net=points.at(-1)?.total;
 const figureStart=`<figure class="cal-chart"><figcaption><span>${label}</span><strong class="${fin(net)?pnlClass(net):''}">${fin(net)?esc(usd(net)):'—'}</strong></figcaption>`;
 if(!points.length)return figureStart+'</figure>';
 const values=[0,...points.map(p=>p.total)],low=Math.min(...values),high=Math.max(...values);
 const left=52,right=296,top=10,bottom=78;
 const y=v=>high===low?(top+bottom)/2:bottom-(v-low)/(high-low)*(bottom-top);
 const coords=values.map((v,i)=>({x:left+(right-left)*i/points.length,y:y(v)}));
 const fmt=x=>x.toFixed(2);
 let curve=`M ${left},${fmt(y(0))}`;
 for(let i=1;i<coords.length;i++){
  const a=coords[i-1],b=coords[i],third=(b.x-a.x)/3;
  // Horizontal tangents at the observed dates keep the curve between consecutive values.
  curve+=` C ${fmt(a.x+third)},${fmt(a.y)} ${fmt(b.x-third)},${fmt(b.y)} ${fmt(b.x)},${fmt(b.y)}`;
 }
 const labels=high===low?[0]:[high,low];
 const last=coords.at(-1);
 return figureStart+`<svg viewBox="0 0 300 100" role="img" aria-label="날짜별 누적 손익 곡선" data-pnl-chart>
 <line x1="${left}" y1="${fmt(y(0))}" x2="${right}" y2="${fmt(y(0))}" class="cal-chart-zero"/>
 ${labels.map(v=>`<text x="48" y="${fmt(y(v)+3)}" text-anchor="end">${esc(calAmt(v))}</text>`).join('')}
 <path class="cal-chart-line" d="${curve}"/>
 <circle class="cal-chart-last" cx="${fmt(last.x)}" cy="${fmt(last.y)}" r="2.6"/>
 ${points.map((p,i)=>`<circle class="cal-chart-point" cx="${fmt(coords[i+1].x)}" cy="${fmt(coords[i+1].y)}" r="5"><title>${p.date} · 일별 ${esc(usd(p.value??0))} · 누적 ${esc(usd(p.total))}</title></circle>`).join('')}
 <text x="${left}" y="97">${shortDay(points[0].date)}</text><text x="${right}" y="97" text-anchor="end">${shortDay(points.at(-1).date)}</text>
 </svg></figure>`;
}
export function pnlCalendarHTML(daily,{now=Date.now()}={}){
 if(!daily||typeof daily!=='object')return '';
 const today=kstDate(now),currentMonth=today.slice(0,7),resetDay=fin(daily.resetAt)?kstDate(Number(daily.resetAt)):null;
 const loaded=fin(daily.at),sinceDay=fin(daily.since)?kstDate(Number(daily.since)):null,lastDay=loaded?kstDate(Number(daily.at)):null;
 const earliest=fin(daily.availableSince)?kstDate(Number(daily.availableSince)):resetDay;
 const floor=(earliest??sinceDay)?.slice(0,7)??ymShift(currentMonth,-1);
 const ym=calMonth&&calMonth<currentMonth?(calMonth<floor?floor:calMonth):currentMonth;
 const [year,month]=ym.split('-').map(Number);
 const covered=date=>loaded&&(!sinceDay||date>=sinceDay)&&(!resetDay||date>=resetDay)&&date<=today&&date<=lastDay;
 const byDay=daily.byDay&&typeof daily.byDay==='object'?daily.byDay:{};
 const weeks=calendarWeeks(byDay,ym),days=weeks.flat().filter(Boolean);
 const dates=days.filter(c=>covered(c.date));
 const required=days.filter(c=>c.date<=today&&(!earliest||c.date>=earliest));
 const complete=required.length>0&&required.every(c=>covered(c.date));
 const values=dates.filter(c=>c.value!==null);
 const wins=values.filter(c=>c.value>0).length,losses=values.filter(c=>c.value<0).length;
 const best=values.reduce((a,c)=>c.value>0&&(!a||c.value>a.value)?c:a,null);
 const worst=values.reduce((a,c)=>c.value<0&&(!a||c.value<a.value)?c:a,null);
 const maxAbs=Math.max(best?.value??0,Math.abs(worst?.value??0));
 let total=0;
 const points=dates.map(c=>({...c,total:total=Math.round((total+(c.value??0))*1e4)/1e4}));
 const tint=v=>!v||!maxAbs?'':` style="background:rgba(${v>0?'66,206,172':'241,113,134'},${(0.1+0.45*Math.abs(v)/maxAbs).toFixed(2)})"`;
 const cell=c=>{
  if(!c)return '<span class="cal-cell cal-pad"></span>';
  const known=covered(c.date),v=known?c.value:null;
  const cls=['cal-cell',c.date===today?'cal-today':'',known?'':'cal-off',v>0?'cal-up':v<0?'cal-down':''].filter(Boolean).join(' ');
  const title=`${c.date}${v!==null?' '+usd(v):known?' · 거래 없음':resetDay&&c.date<resetDay?' · 초기화 이전':c.date<=today?' · 조회 전':''}`;
  return `<span class="${cls}" title="${esc(title)}"${tint(v)}><b>${c.day===1?shortDay(c.date):c.day}</b>${v!==null?`<i class="${v?pnlClass(v):''}">${esc(calAmt(v))}</i>`:''}</span>`;
 };
 const errorCode=/^[A-Z0-9_]{1,40}$/.test(daily.error||'')?daily.error:null;
 const errorLabel={NO_CLIENT:'실계좌 연결 설정 확인',HTTP_429:'거래소 요청 한도 초과',BAD_INCOME_RESPONSE:'손익 응답 형식 오류'}[errorCode]||errorCode;
 const state=daily.error?`<span class="cal-err" title="${esc(daily.error)}">갱신 실패 · ${loaded?esc(hhmm(daily.at))+' 기준':'불러온 기록 없음'}${errorLabel?' · '+esc(errorLabel):''}</span>`
  :loaded?`<span class="muted">${esc(hhmm(daily.at))} 기준 · 5분마다 갱신</span>`:'<span class="muted">불러오는 중…</span>';
 const day=x=>x?`${shortDay(x.date)} <b class="${pnlClass(x.value)}">${esc(usd(x.value))}</b>`:'—';
 const foot=`<div class="cal-sum"><span>수익일 <b class="paper-profit">${wins}</b></span><span>손실일 <b class="paper-loss">${losses}</b></span>
 <span>최고 ${day(best)}</span><span>최저 ${day(worst)}</span></div>`+(loaded&&!complete&&points.length?`<p class="cal-note">조회된 기간 ${points[0].date} ~ ${points.at(-1).date}</p>`:'');
 const resetNote=resetDay?`<p class="cal-note">집계 시작 ${resetDay} ${hhmm(daily.resetAt)} KST</p>`:'';
 const label=complete?`${month}월 누적 PNL`:'조회된 기간 누적 PNL';
 return `<section class="pnl-cal" aria-label="월별 손익"><h5 class="copy-sub">일별 손익 <small>거래소 기준 · 카피+수동</small></h5>
 <div class="cal-head"><button type="button" class="outline-btn small" data-cal-month="-1" aria-label="이전 달"${ym<=floor?' disabled':''}>‹</button><strong>${year}년 ${month}월</strong><button type="button" class="outline-btn small" data-cal-month="1" aria-label="다음 달"${ym>=currentMonth?' disabled':''}>›</button></div>
 <div class="cal-grid" data-cal-ym="${ym}">${'월화수목금토일'.split('').map((d,i)=>`<span class="cal-dow${i>4?' cal-we':''}">${d}</span>`).join('')}${weeks.flat().map(cell).join('')}</div>${foot}${pnlCurve(points,label)}${resetNote}<p class="cal-state">${state}</p></section>`;
}
const SETTLEMENT_STATES={CONFIRMED:'정산 확인',WAITING:'체결 내역 대기',NO_ORDER_IDS:'연결할 주문 ID 없음',ORDER_LINK_MISSING:'주문 ID 연결 실패',
 MIXED_WITH_COPY:'같은 종목의 카피 거래와 정산 내역 겹침',MIXED_WITH_MANUAL:'같은 종목의 수동 거래와 정산 내역 겹침',
 ENTRY_HISTORY_UNVERIFIED:'시작 전 진입 체결 확인 필요',POSITION_SIDE_UNVERIFIED:'체결의 롱·숏 방향 확인 필요',TRADE_LINK_UNVERIFIED:'체결 내역과 해당 거래를 연결하지 못함',
 FILL_PENDING:'체결 내역 대기',QUANTITY_MISMATCH:'진입·청산 체결 수량 불일치',INCOMPLETE_FILLS:'체결 손익·수수료 내역 불충분',
 HISTORY_WINDOW_EXPIRED:'정산 조회 기간 경과',LOOKUP_UNAVAILABLE:'체결 조회 미설정',LOOKUP_FAILED:'거래소 정산 조회 실패',
 MISSING_TIMESTAMPS:'거래 시각 기록 부족',ORDER_LIMIT:'자동 정산 주문 수 한도 초과'};
const auditTime=t=>t?new Date(t).toLocaleTimeString('ko-KR',{timeZone:'Asia/Seoul',hour12:false}):'';

export function copyHTML(c){
 lastCopy=c;
 if(!c)return '';
 const money=v=>v==null||!Number.isFinite(Number(v))?'—':`${v>=0?'+':'−'}$${Math.abs(v).toFixed(2)}`,usd=v=>v==null||!Number.isFinite(Number(v))?'—':`$${Number(v).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}`;
 const cls=v=>v>0?'paper-profit':v<0?'paper-loss':'';
 const when=t=>t?new Date(t).toLocaleString('ko-KR',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit',hour12:false}):'';
 const held=(a,b)=>{const h=(b-a)/3600000;return !(h>=0)?'':h<1?Math.max(1,Math.round(h*60))+'분':h<48?(+h.toFixed(1))+'시간':(+(h/24).toFixed(1))+'일'};
 const isLive=c.mode==='LIVE',open=c.positions||[],closed=mergedCloses(c),st=copyStats(c,{confirmedOnly:isLive}),net=st.all.net,wins=st.all.wins,counted=st.all.n;
 const closedTotal=(c.closedTotal??(c.closed||[]).length)+(c.manual?(c.manual.closedTotal??(c.manual.closed||[]).length):0);
 const pages=Math.max(1,Math.ceil(closed.length/COPY_PAGE_SIZE)),page=Math.min(copyPage,pages-1),shown=closed.slice(page*COPY_PAGE_SIZE,page*COPY_PAGE_SIZE+COPY_PAGE_SIZE);
 const pager=pages>1?`<div class="copy-pager"><button type="button" class="outline-btn small" data-copy-page="-1"${page===0?' disabled':''}>‹ 이전</button><span class="muted">${page+1} / ${pages}쪽</span><button type="button" class="outline-btn small" data-copy-page="1"${page>=pages-1?' disabled':''}>다음 ›</button></div>`:'';
 const gross=st.all.gross,loss=st.all.loss;
 const unreal=open.reduce((a,p)=>a+(Number(p.unrealized)||0),0);
 // One place per fact (user 2026-11-18 "실계좌 카피 부분에 활성화됨 부분이 2개"): the real account shows its mode chip,
 // the on/off state and the switch on one line; a stop by the loss limit is the 정지 line below (with its button).
 // A testnet copy follows the testnet switch above it, so it shows no state of its own (only 카피 꺼짐).
 const on=isLive?Boolean(c.armed&&c.enabled&&!c.killed):Boolean(c.enabled&&c.followArmed&&!c.killed);
 const state=c.killed?'':!c.enabled?'<b class="copy-state off">○ 카피 꺼짐</b>':on?'<b class="copy-state on">● 활성화됨</b>':'<b class="copy-state off">○ 비활성</b>';
 const modeLine=isLive?`<div class="copy-mode live ${on?'on':''}"><span class="copy-chip">실계좌</span>${state}
  ${c.enabled&&!c.killed?(c.armed?'<button type="button" class="outline-btn small" data-copy-disarm>비활성화하기</button>':'<button type="button" class="outline-btn small danger-btn" data-copy-arm>활성화하기</button>'):''}<span class="copy-msg" data-copy-msg></span></div>`
  :!c.enabled?`<div class="copy-mode">${state}</div>`:'';
 const kill=c.killed?`<p class="live-warn-text">카피 손실 한도(잔고 ${esc(c.ledgerLossPct)}%)에 닿아 모두 청산하고 멈췄습니다. <button type="button" class="outline-btn small" data-copy-resume>카피 다시 시작</button></p>`:'';
 const ctrl=c.controls||null;
 const cooldownBanner=ctrl?.cooldownActive?`<p class="live-warn-text">⏸ 자동 쿨다운 중 (${esc(ctrl.cooldownReason||'손실 제한')} · ${esc(ctrl.cooldownLeftMin)}분 남음) <button type="button" class="outline-btn small" data-copy-clear-cooldown>쿨다운 해제</button></p>`:'';
 const controlsPanel=isLive&&ctrl?(()=>{
  const tb=Number(c.traderBalanceUSD)||20000;
  const curSizing=c.sizing||'BALANCE_RATIO';
  const basisVal=isLive?(fin(c.funds?.available)?Number(c.funds.available):Number(c.funds?.equity)):Number(c.funds?.equity);
  const ratioPct=curSizing==='BALANCE_RATIO'&&basisVal>0&&tb>0?(basisVal/tb*100).toFixed(1):null;
  const sizingModes=[['BALANCE_RATIO','잔고 비례 (자동)'],['MIN_ORDER','최소 주문'],['FIRST_1USD','$1 고정']];
  const sizingBtns=sizingModes.map(([m,lbl])=>`<button type="button" class="outline-btn small${curSizing===m?' is-current':''}" data-copy-sizing="${m}">${lbl}</button>`).join('');
  const sizingSummary=curSizing==='BALANCE_RATIO'?(ratioPct?`잔고 비례 ${ratioPct}% (기준 $${Number(tb).toLocaleString()})`:`잔고 비례 · 기준 $${Number(tb).toLocaleString()}`):curSizing==='MIN_ORDER'?'최소 주문':'$1 고정';
  const presets=[[40000,'0.5배 ($40k)'],[20000,'1배 ($20k)'],[13333,'1.5배 ($13.3k)'],[10000,'2배 ($10k)']];
  const presetBtns=presets.map(([v,lbl])=>`<button type="button" class="outline-btn small${Math.abs(tb-v)<=5?' is-current':''}" data-copy-tb="${v}">${lbl}</button>`).join('');
  const isAllow=ctrl.filterMode==='ALLOWLIST',symList=isAllow?(ctrl.allowedSymbols||[]):(ctrl.blockedSymbols||[]);
  const chips=symList.length?symList.map(s=>`<span class="ctrl-chip">${esc(symText(s))}<button type="button" data-copy-sym-remove="${esc(s)}" data-copy-sym-kind="${isAllow?'allowed':'blocked'}" aria-label="${esc(symText(s))} 제거">×</button></span>`).join(''):`<span class="muted">${isAllow?'등록된 허용 종목 없음 (전체 차단)':'제외된 종목 없음'}</span>`;
  return `<details class="copy-controls-fold"${controlsOpen?' open':''}><summary data-controls-toggle>카피 비중 · 위험 제어 <small>${sizingSummary}${ctrl.maxSymbolMarginPct>0?` · 종목한도 ${ctrl.maxSymbolMarginPct}%`:''}${ctrl.maxLeverage?` · 최대 ${ctrl.maxLeverage}배`:''}</small></summary>
   <div class="copy-ctrl-body">
    <div class="ctrl-row"><span class="ctrl-label">수량 방식</span><div class="ctrl-presets">${sizingBtns}</div></div>
    <div class="ctrl-row"><span class="ctrl-label">비중 프리셋</span><div class="ctrl-presets">${presetBtns}</div></div>
    <form class="ctrl-form" data-copy-controls-form>
     <label>기준 잔고 ($) <input name="traderBalanceUSD" type="number" min="1000" max="1000000" step="1000" value="${esc(tb)}"></label>
     <label>종목당 최대 증거금 (%) <input name="maxSymbolMarginPct" type="number" min="0" max="100" step="1" value="${esc(ctrl.maxSymbolMarginPct??0)}" title="0 = 제한 없음"></label>
     <label>최대 레버리지 (배) <input name="maxLeverage" type="number" min="0" max="125" step="1" value="${esc(ctrl.maxLeverage??0)}" title="0 = 기본(125배)"></label>
     <label>연속 손실 쿨다운 (회) <input name="cooldownLosses" type="number" min="0" max="20" step="1" value="${esc(ctrl.cooldownLosses??0)}" title="0 = 꺼짐"></label>
     <label>당일 손실 쿨다운 (%) <input name="cooldownDailyLossPct" type="number" min="0" max="50" step="0.5" value="${esc(ctrl.cooldownDailyLossPct??0)}" title="0 = 꺼짐"></label>
     <label>쿨다운 시간 (분) <input name="cooldownMinutes" type="number" min="5" max="1440" step="5" value="${esc(ctrl.cooldownMinutes??120)}"></label>
     <button type="submit" class="outline-btn small">설정 저장</button>
    </form>
    <div class="ctrl-filter">
     <div class="ctrl-filter-head">
      <span class="ctrl-label">종목 필터</span>
      <button type="button" class="outline-btn small${!isAllow?' is-current':''}" data-copy-filter-mode="BLOCKLIST">제외 목록</button>
      <button type="button" class="outline-btn small${isAllow?' is-current':''}" data-copy-filter-mode="ALLOWLIST">허용 목록</button>
     </div>
     <div class="ctrl-chips">${chips}</div>
     <div class="ctrl-sym-add">
      <input type="text" data-copy-sym-input placeholder="예: SNDK 또는 BTCUSDT" maxlength="30" aria-label="종목 입력">
      <button type="button" class="outline-btn small" data-copy-sym-add="${isAllow?'allowed':'blocked'}">${isAllow?'허용 추가':'제외 추가'}</button>
     </div>
    </div>
    <span class="copy-msg" data-copy-ctrl-msg></span>
   </div></details>`;
 })():'';
 const al=c.accountAlerts||null;
 const alertsPanel=isLive&&al?`<details class="copy-controls-fold"${alertsOpen?' open':''}><summary data-alerts-toggle>텔레그램 알림 · 위험 경보 <small>${al.riskAlerts?'위험ON':'위험OFF'} · ${al.remoteCommands?'명령어ON':'명령어OFF'}</small></summary>
  <div class="copy-ctrl-body">
   <form class="ctrl-form" data-account-alerts-form>
    <label class="ctrl-check"><input name="riskAlerts" type="checkbox"${al.riskAlerts?' checked':''}> 통합 위험 경보 (카피+수동)</label>
    <label class="ctrl-check"><input name="roiAlerts" type="checkbox"${al.roiAlerts?' checked':''}> 포지션 수익률/손실률 도달</label>
    <label class="ctrl-check"><input name="positionSummaryAlerts" type="checkbox"${al.positionSummaryAlerts!==false?' checked':''}> 진행 중 포지션 손익 정기 알림</label>
    <label class="ctrl-check"><input name="dailyReport" type="checkbox"${al.dailyReport?' checked':''}> 일일 마감 리포트 (00:00 KST)</label>
    <label class="ctrl-check"><input name="skipAlerts" type="checkbox"${al.skipAlerts?' checked':''}> 카피 진입 실패·스킵 알림</label>
    <label class="ctrl-check"><input name="remoteCommands" type="checkbox"${al.remoteCommands?' checked':''}> 봇 원격 명령 (/status /pos /pause /close)</label>
    <label>포지션 알림 주기 (분) <input name="positionSummaryIntervalMin" type="number" min="1" max="1440" step="1" value="${esc(al.positionSummaryIntervalMin??5)}"></label>
    <label>증거금 경보 (%, 쉼표) <input name="marginWarnPcts" type="text" value="${esc((al.marginWarnPcts||[]).join(', '))}"></label>
    <label>합산 손실 경보 (%, 쉼표) <input name="lossWarnPcts" type="text" value="${esc((al.lossWarnPcts||[]).join(', '))}"></label>
    <label>수익률 알림 (%, 쉼표) <input name="profitRoiPcts" type="text" value="${esc((al.profitRoiPcts||[]).join(', '))}"></label>
    <label>손실률 알림 (%, 쉼표) <input name="lossRoiPcts" type="text" value="${esc((al.lossRoiPcts||[]).join(', '))}"></label>
    <div class="ctrl-btn-row">
     <button type="submit" class="outline-btn small">알림 저장</button>
     <button type="button" class="outline-btn small" data-send-position-summary>지금 포지션 알림 발송</button>
     <button type="button" class="outline-btn small" data-send-daily-report>지금 리포트 발송</button>
    </div>
   </form>
   <span class="copy-msg" data-account-alerts-msg></span>
  </div></details>`:'';
 const tr=c.trailing||null;
 const trailingPanel=isLive&&tr?`<details class="copy-controls-fold"${trailingOpen?' open':''}><summary data-trailing-toggle>자동 트레일링 익절 (실계좌) <small>${tr.enabled?`ON · ${tr.applyToManual?'수동':''}${tr.applyToManual&&tr.applyToCopy?'+':''}${tr.applyToCopy?'카피':''} · 순ROE +${esc(tr.partialLockRoePct)}%`:'OFF (기본 꺼짐)'}</small></summary>
  <div class="copy-ctrl-body">
   <form class="ctrl-form" data-real-trailing-form>
    <label class="ctrl-check"><input name="enabled" type="checkbox"${tr.enabled?' checked':''}> <b>자동 트레일링 익절 활성화</b> (실계좌 자동 청산 · 수수료 반영 순 ROE)</label>
    <label class="ctrl-check"><input name="applyToManual" type="checkbox"${tr.applyToManual!==false?' checked':''}> 수동 포지션 적용</label>
    <label class="ctrl-check"><input name="applyToCopy" type="checkbox"${tr.applyToCopy?' checked':''}> 카피 포지션 적용 (기본 OFF 권장)</label>
    <label class="ctrl-check"><input name="autoBreakeven" type="checkbox"${tr.autoBreakeven!==false?' checked':''}> 50% 확정 후 잔여 물량 본전 스탑 자동 설정</label>
    <label class="ctrl-check"><input name="skipTradfi" type="checkbox"${tr.skipTradfi!==false?' checked':''}> TradFi·주식 종목 자동 제외 (얇은 호가 보호)</label>
    <label>부분 익절 순 ROE (%) <input name="partialLockRoePct" type="number" min="2" max="200" step="0.5" value="${esc(tr.partialLockRoePct??8)}"></label>
    <label>부분 청산 비율 (0=끄기, 50=절반) <input name="partialClosePct" type="number" min="0" max="100" step="50" value="${esc(tr.partialClosePct??50)}"></label>
    <label>트레일링 시작 순 ROE (%) <input name="trailActivateRoePct" type="number" min="2" max="200" step="0.5" value="${esc(tr.trailActivateRoePct??8)}"></label>
    <label>고점 대비 되돌림 (%) <input name="trailPullbackRatio" type="number" min="5" max="70" step="1" value="${esc(tr.trailPullbackRatio??25)}"></label>
    <label>최소 확정 순 ROE (%) <input name="minLockRoePct" type="number" min="0.5" max="50" step="0.5" value="${esc(tr.minLockRoePct??2)}"></label>
    <label>제외 종목 (쉼표) <input name="excludedSymbols" type="text" placeholder="예: BTC, ETH" value="${esc((tr.excludedSymbols||[]).join(', '))}"></label>
    <div class="ctrl-btn-row"><button type="submit" class="outline-btn small">트레일링 저장</button></div>
   </form>
   <span class="copy-msg" data-real-trailing-msg></span>
  </div></details>`:'';
 const sf=c.safety||null;
 const safetyBanner=isLive&&sf?.tripped?`<p class="live-warn-text">🚨 일일 손실 차단 발동 (${esc(sf.trippedReason||`-${sf.dailyLossLimitPct}%`)}) — 오늘 신규 카피·수동 진입 중단 <button type="button" class="outline-btn small" data-safety-unlock>오늘 차단 해제</button></p>`:'';
 const safetyPanel=isLive&&sf?`<details class="copy-controls-fold"${safetyOpen?' open':''}><summary data-safety-toggle>계좌 안전 가드 · 서킷 브레이커 <small>${sf.dailyLossLimitPct>0?`일일한도 -${esc(sf.dailyLossLimitPct)}%`:'일일차단 OFF'} · 수동 최대 ${sf.manualMaxLeverage>0?`${esc(sf.manualMaxLeverage)}배`:'제한없음'} · 증거금 ${sf.manualMaxMarginPct>0?`${esc(sf.manualMaxMarginPct)}%`:'제한없음'}</small></summary>
  <div class="copy-ctrl-body">
   <form class="ctrl-form" data-real-safety-form>
    <label>통합 일일 손실 차단 (%, 0=꺼짐) <input name="dailyLossLimitPct" type="number" min="0" max="50" step="0.5" value="${esc(sf.dailyLossLimitPct??8)}" title="당일 거래소 실현 + 현재 미실현 합산 손실이 잔고의 이 비율에 닿으면 신규 진입 자동 중단"></label>
    <label>수동 최대 레버리지 (배, 0=제한없음) <input name="manualMaxLeverage" type="number" min="0" max="125" step="1" value="${esc(sf.manualMaxLeverage??20)}" title="고배율(50~80배) 수동 진입 사고 방지"></label>
    <label>수동 단일 증거금 한도 (%, 0=제한없음) <input name="manualMaxMarginPct" type="number" min="0" max="100" step="1" value="${esc(sf.manualMaxMarginPct??15)}" title="단일 수동 주문 증거금이 잔고의 이 비율을 넘으면 차단"></label>
    <div class="ctrl-btn-row">
     <button type="submit" class="outline-btn small">안전 가드 저장</button>
     <button type="button" class="outline-btn small" data-safety-preset title="계좌 안전 가드(일일 -8%, 수동 최대 20배, 증거금 15%) + 카피 제어(최대 20배, 종목한도 15%, 3연패·-6% 쿨다운) 일괄 적용">🛡️ 권장 안전 프리셋 일괄 적용</button>
    </div>
   </form>
   <span class="copy-msg" data-real-safety-msg></span>
  </div></details>`:'';
 const f=c.funds,stat=(k,v,extra='')=>`<span>${k}<b ${extra}>${v}</b></span>`;
 // With the exchange list (real account), 보유 / 미실현 count every position, copy and manual alike.
 const vpList=c.mode==='LIVE'&&Array.isArray(c.venuePositions)?c.venuePositions:null,vpUnreal=(vpList||[]).reduce((t,p)=>t+(Number(p.unrealized)||0),0);
 // 보유 N개 is the list heading's; with the exchange list its 미실현 합계 line has the unrealized total; a testnet copy's
 // balance is the testnet account's, shown once in the status box above.
 const liveBasis=fin(f?.available)?Number(f.available):Number(f?.equity);
 const liveRatioVal=isLive&&c.sizing==='BALANCE_RATIO'&&liveBasis>0&&Number(c.traderBalanceUSD)>0?`${(liveBasis/Number(c.traderBalanceUSD)*100).toFixed(1)}%`:null;
 const dailyVals=isLive&&c.daily?.at&&c.daily?.byDay&&typeof c.daily.byDay==='object'?Object.values(c.daily.byDay).map(Number).filter(Number.isFinite):[];
 const exNet=dailyVals.length?Math.round(dailyVals.reduce((s,v)=>s+v,0)*1e4)/1e4:null;
 const unsettledCount=isLive?closed.filter(x=>!confirmedCopyResult(x)&&x.netSource!=='PENDING').length:0;
 const displayNet=exNet!=null?exNet:(counted?net:null);
 const netTitle=exNet!=null?' title="BingX 거래소 기준 실현 손익 + 수수료 + 펀딩 합계 (미확정 원장 왜곡 없음)"':'';
 const stats=`<div class="copy-stats">${isLive?stat('잔고',usd(f?.equity)):''}${stat('사용 가능',usd(f?.available))}${liveRatioVal?stat('카피 비율',liveRatioVal):''}${vpList?'':stat('미실현',money(open.length?unreal:null),`class="${cls(unreal)}"`)}
  ${stat(isLive?'정산 확인':'종료',counted+'건')}${stat('승률',counted?Math.round(wins/counted*100)+'%':'—')}${stat('PF',loss>0?(gross/loss).toFixed(2):counted?'∞':'—')}${stat(exNet!=null?'누적 손익 (거래소)':'누적 손익',money(displayNet),`class="${cls(displayNet)}"${netTitle}`)}</div>`+
  (c.manual?`<p class="copy-split">카피 <b class="${cls(st.copy.net)}">${money(st.copy.n?st.copy.net:null)}</b> (${st.copy.n}건) · 수동 <b class="${cls(st.manual.net)}">${money(st.manual.n?st.manual.net:null)}</b> (${st.manual.n}건)${st.pending?` · <span class="muted">정산 중 ${st.pending}건</span>`:''}${exNet!=null&&unsettledCount>0?` · <span class="muted">원장 미확정 ${unsettledCount}건 제외</span>`:''}</p>`:'')+
  (!isLive&&(st.all.n||st.all.unknown)?`<p class="copy-rules muted">거래소 확인 ${st.all.settled}건 · 추정 ${st.all.estimated}건${st.all.unknown?` · 손익 미확인 ${st.all.unknown}건`:''}</p>`:'');
 const sizingBasis=isLive?'내 가용 증거금':'내 잔고';
 const rules=`<details class="copy-rules-fold"><summary>규칙 보기</summary><p class="copy-rules">수량 ${c.sizing==='BALANCE_RATIO'?`트레이더 수량 × ${sizingBasis} ÷ $${Number(c.traderBalanceUSD).toLocaleString()} (최소 주문 미달 시 트레이더 1배 수량·추매 1배)`:c.sizing==='MIN_ORDER'?`첫 증거금 $${esc(c.firstMarginUSD??0)} (거래소 최소 주문보다 작으면 최소 주문), 추매는 트레이더 비율`:`첫 증거금 $${esc(c.marginUSD)}`} · 추매 최대 ${esc(c.maxAdds??10)}회 · 손절 ${c.stops?`포지션당 잔고 ${esc(c.maxLossPct)}%`:'없음(트레이더 청산만)'} · 한도 증거금 ${esc(c.maxTotalMarginPct)}%·손실 ${esc(c.ledgerLossPct)}%</p></details>`;
 const row=p=>`<li>${symTag(p.symbol)}${p.closing?'<small>청산 중</small>':''}${side(p.direction)}<span>${esc(p.leverage)}배</span><span>수량 ${esc(p.qty)}${p.avg?` · 평단 ${esc(p.avg)}`:''}</span><span>추매 ${esc(p.adds||0)}회 · 부분청산 ${p.reduces==null?'—':esc(p.reduces)+'회'}</span><span class="muted">${held(p.openedAt,Date.now())}째</span>${p.unrealized!=null?`<b class="${cls(p.unrealized)} end">${money(p.unrealized)}</b>`:''}</li>`;
 // Manual closes: the yellow 수동 badge; the result is BingX's own (income) unless marked 추정 / 정산 중.
 const isMan=x=>x.origin==='manual',manBadge=x=>isMan(x)?'<span class="vp-badge manual">수동</span>':'';
 const SRC={MIXED_WITH_COPY:'추정 · 같은 코인 카피와 겹쳐 거래소 내역을 나눌 수 없음',MIXED_WITH_MANUAL:'추정 · 같은 코인 수동 포지션과 겹침',
   ESTIMATE:'추정 · 거래소 내역 없음',ESTIMATE_BEFORE_FEES:'수수료 반영 전 추정'};
 const result=x=>isLive&&!confirmedCopyResult(x)?'<span class="muted">정산 미확정</span>':x.netSource==='PENDING'?`<span class="muted" title="거래소 손익 내역을 기다리는 중${fin(x.estimateUSD)?` · 추정 ${money(Number(x.estimateUSD))}`:''}">정산 중</span>`
  :x.netUSD==null?'<span class="muted">확인 불가</span>':`${money(x.netUSD)}${SRC[x.netSource]?` <small class="muted" title="${esc(SRC[x.netSource])}">추정</small>`:''}`;
 const settlement=x=>{const s=x.settlement,state=s?.state??(confirmedCopyResult(x)?'CONFIRMED':SETTLEMENT_STATES[x.netSource]?x.netSource:'WAITING'),label=SETTLEMENT_STATES[state];
  return isLive&&label?`<small class="muted"${s?.error?` title="${esc(s.error)}"`:''}>${esc(label)}${s?.checkedAt?` · ${esc(when(s.checkedAt))} 조회`:''}</small>`:''};
 const manualMemo=x=>{
  if(!isMan(x)||!x.id)return '';
  const tags=Array.isArray(x.tags)?x.tags:[];
  const chips=tags.map(t=>`<span class="trade-tag">#${esc(t)}</span>`).join('');
  const note=x.note?`<span class="trade-note">${esc(x.note)}</span>`:'';
  const btn=`<button type="button" class="note-edit-btn" data-manual-note-id="${esc(x.id)}" data-manual-note="${esc(x.note||'')}" data-manual-tags="${esc(tags.join(', '))}">${x.note||tags.length?'수정':'메모'}</button>`;
  return `<div class="trade-memo-line">${chips}${note}${btn}</div>`;
 };
 const done=x=>`<li class="${isMan(x)?'vp-manual':''}"><span class="muted">${when(x.closedAt)}</span>${symTag(x.symbol)}${manBadge(x)}${side(x.direction)}<span>추매 ${esc(x.adds||0)}회</span><span class="muted">${held(x.openedAt,x.closedAt)}</span>${x.theirPnlUSD!=null?`<small>트레이더 ${money(x.theirPnlUSD)}</small>`:''}${settlement(x)}<b class="${cls(x.netUSD)} end">${result(x)}</b>${manualMemo(x)}</li>`;
 // Entry failures and skips under the closes (user 2026-11-17 "코인 종목 / 롱,숏 / 진입 실패 이유"), 10 per page.
 const notesAll=(c.events||[]).filter(e=>['SKIPPED','ADD_SKIPPED','ERROR','STOP_NOT_SET','LATE_ENTRY'].includes(e.type));
 // Collapsed by default, 5 per page (user 2026-11-18 "진입 실패·건너뜀 부분 너무 차지하는 비율이 크다").
 const FP=5,fPages=Math.max(1,Math.ceil(notesAll.length/FP)),fPage=Math.min(failPage,fPages-1),notes=notesAll.slice(fPage*FP,fPage*FP+FP);
 const failPager=fPages>1?`<div class="copy-pager"><button type="button" class="outline-btn small" data-copy-fail-page="-1"${fPage===0?' disabled':''}>‹ 이전</button><span class="muted">${fPage+1} / ${fPages}쪽</span><button type="button" class="outline-btn small" data-copy-fail-page="1"${fPage>=fPages-1?' disabled':''}>다음 ›</button></div>`:'';
 const why=e=>`${esc(e.type==='LATE_ENTRY'?'늦은 진입 시도 (진입 알림을 놓친 포지션의 추매)':COPY_WHY[e.reason]||e.reason||e.type)}${e.type==='ADD_SKIPPED'?' (추매)':''}${e.detail?` <small>${esc(e.detail)}</small>`:''}${notCopiedWhy(e,when,c.events||[])}`;
 // Desktop (user 2026-11-14: the web view felt like a phone): the same data as tables with more columns;
 // phones keep the compact lists. CSS shows one or the other (.only-desk / .only-mob).
 const margin=p=>p.qty>0&&p.avg>0&&p.leverage>0?p.qty*p.avg/p.leverage:null,roe=p=>{const m=margin(p);return m&&p.unrealized!=null?p.unrealized/m*100:null};
 const pctText=v=>v==null?'—':`${v>=0?'+':'−'}${Math.abs(v).toFixed(1)}%`;
 const openTable=`<table class="copy-table only-desk"><thead><tr><th>종목</th><th>방향</th><th>배율</th><th class="num">수량</th><th class="num">평단</th><th class="num">현재가</th><th class="num">증거금</th><th class="num">추매 / 부분청산</th><th>보유</th><th class="num">미실현</th><th class="num">수익률</th></tr></thead><tbody>${open.map(p=>`<tr><td>${symTag(p.symbol)}${p.closing?' <small>청산 중</small>':''}</td><td>${side(p.direction)}</td><td>${esc(p.leverage)}배</td><td class="num">${esc(p.qty)}</td><td class="num">${esc(p.avg??'—')}</td><td class="num">${esc(p.mark?+Number(p.mark).toPrecision(6):'—')}</td><td class="num">${usd(margin(p))}</td><td class="num">${esc(p.adds||0)}회 / ${p.reduces==null?'—':esc(p.reduces)+'회'}</td><td class="muted">${held(p.openedAt,Date.now())}</td><td class="num"><b class="${cls(p.unrealized)}">${money(p.unrealized)}</b></td><td class="num ${cls(roe(p))}">${pctText(roe(p))}</td></tr>`).join('')}</tbody></table>`;
 const closedTable=`<table class="copy-table only-desk"><thead><tr><th>종료</th><th>종목</th><th>방향</th><th class="num">추매</th><th>보유 시간</th><th class="num">트레이더 손익</th><th class="num">내 손익</th>${isLive?'<th>정산 상태</th>':''}</tr></thead><tbody>${shown.map(x=>`<tr class="${isMan(x)?'vp-manual':''}"><td class="muted">${when(x.closedAt)}</td><td>${symTag(x.symbol)} ${manBadge(x)}${manualMemo(x)}</td><td>${side(x.direction)}</td><td class="num">${esc(x.adds||0)}회</td><td class="muted">${held(x.openedAt,x.closedAt)}</td><td class="num">${x.theirPnlUSD!=null?money(x.theirPnlUSD):'—'}</td><td class="num"><b class="${cls(x.netUSD)}">${result(x)}</b></td>${isLive?`<td>${settlement(x)||'—'}</td>`:''}</tr>`).join('')}</tbody></table>`;
 // One time stamp per panel: the real-account page's (3 s refresh); the testnet page has its header time.
 const fresh=open.map(p=>p.markAt).filter(Boolean),updated=Math.max(f?.at||0,Number(c.venuePositionsAt)||0,...fresh);
 const deferredNote=c.deferredEntries>0?`<p class="copy-stamp">⏳ 업데이트 대기 중인 카피 신호 ${esc(c.deferredEntries)}건 (재시작 직후 처리)</p>`:'';
 const stamp=isLive&&updated>0?`<p class="copy-stamp">${new Date(updated).toLocaleTimeString('ko-KR',{hour12:false})} 기준 · 3초마다 갱신</p>`:'';
 const side_=`<div class="copy-side">${modeLine}${kill}${cooldownBanner}${safetyBanner}${deferredNote}${stats}${safetyPanel}${controlsPanel}${alertsPanel}${trailingPanel}${isLive&&c.daily?pnlCalendarHTML(c.daily):''}${rules}${stamp}</div>`;
 const merged=c.mode==='LIVE'&&('venuePositions' in c||c.venuePositionsError);
 const main=`<div class="copy-main">`+(merged?venuePositionsHTML(c,open):`<h5 class="copy-sub">보유 중 <small>${open.length}개</small></h5>`+(open.length?`<ul class="copy-list only-mob">${open.map(row).join('')}</ul>${scrollCopyTable(openTable,'보유 포지션')}`:`<p class="empty-small">따라 들어간 포지션이 없습니다. 채널에 새 진입 알림이 오면 들어갑니다.</p>`))+
  (c.analytics?analyticsHTML(c.analytics):'')+
  (closed.length?`<div class="copy-sub-row"><h5 class="copy-sub">최근 종료 <small>전체 ${esc(closedTotal)}건</small></h5>${isLive?'<a class="outline-btn small copy-export-btn" href="/api/copy/export" download>CSV 내보내기</a>':''}</div><ul class="copy-list only-mob">${shown.map(done).join('')}</ul>${scrollCopyTable(closedTable,'최근 종료 거래')}${pager}`:'')+
  (notes.length?`<details class="fail-box"${failOpen?' open':''}><summary data-fail-toggle><b>진입 실패·건너뜀</b> <small>전체 ${notesAll.length}건 · 최근 24시간 ${notesAll.filter(e=>Date.now()-e.at<864e5).length}건</small></summary><ul class="copy-list muted only-mob">${notes.map(e=>`<li><span class="muted">${when(e.at)}</span>${e.symbol?symTag(e.symbol):'<b></b>'} ${e.direction?side(e.direction):''} · ${why(e)}</li>`).join('')}</ul><div class="copy-table-scroll" role="region" aria-label="진입 실패 및 건너뜀" tabindex="0"><table class="copy-table only-desk"><thead><tr><th>시각</th><th>종목</th><th>방향</th><th>이유</th></tr></thead><tbody>${notes.map(e=>`<tr><td class="muted">${when(e.at)}</td><td>${e.symbol?symTag(e.symbol):'<b>—</b>'}</td><td>${e.direction?side(e.direction):'—'}</td><td>${why(e)}</td></tr>`).join('')}</tbody></table></div>${failPager}</details>`:'')+'</div>';
 return `<div class="copy-layout">${side_}${main}</div>`;
}

/** Testnet reversal scalps (scalp_executor.mjs) on their own: on/off, the switch, stats, open / closed tables, skip reasons.
 * Shown when the signal strategy is not on the testnet (LIVE mode, review M3); on the testnet one shared screen replaces it. */
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
 const rules=`<p class="copy-rules">거래 방향 ${sides.length?sides.map(d=>SK[d]).join('·'):'없음'} · 5분봉 급락(롱)·급등(숏) ${esc(S.minMovePct)}% 이상${S.zoneSignals?` (또는 ${esc(S.zoneMinMovePct)}% 이상 + 극값이 4H/1D 매물대 ±${esc(S.zoneTouchPct)}% 안 = 매물대 반전)`:''} · 거래량 ${esc(S.climaxVolume)}배 · 반전 캔들 확인 뒤 진입 · 목표 ${(S.retracements||[]).map(r=>+(r*100).toFixed(1)+'%').join('/')} 되돌림 (40/35/25%) · ${scalpExitRule(S)} · ${S.trendMode==='on'?'4시간 추세 반대 제외(하락 중 롱·상승 중 숏)':S.trendMode==='off'?'4시간 추세 미사용':'4시간 추세 기록만(진입 막지 않음)'} · 거래당 위험 잔고 ${esc(S.riskPct)}% · ${esc(S.leverage)}배 교차 · 하루 손실 ${esc(S.dailyLossPct)}%에서 정지 · 진입가와 ${esc(S.maxDriftPct)}%${S.driftMovePct>0?`(유리한 쪽은 급변 폭의 ${esc(S.driftMovePct)}%까지)`:''}${S.stopKeepPct>0?`(더 좋은 가격은 손절 거리 ${esc(S.stopKeepPct)}% 이상 남으면 진입)`:''} 넘게 벌어지면 건너뜀${s.universe?.count?` · 대상 ${esc(s.universe.count)}종목`:''}${s.lastScan?.at?` · 마지막 검사 ${when(s.lastScan.at)} (${esc(s.lastScan.checked)}종목${s.lastScan.failed>0?`, 실패 ${esc(s.lastScan.failed)}`:''}${s.lastScan.error?`, 오류 ${esc(s.lastScan.error)}`:''})`:''}</p>`;
 const row=p=>`<li><b>${esc(p.symbol)}</b>${scalpBadge(p.kind)}${side(p.direction||'LONG')}<span>${esc(p.leverage)}배</span><span>진입 ${px(p.avg)} · 손절 ${px(p.stop)}${p.breakevenMoved?' (본전)':''}</span><span class="muted">${held(p.openedAt||p.createdAt,Date.now())}째</span>${p.unrealized!=null?`<b class="${cls(p.unrealized)} end">${money(p.unrealized)}</b>`:''}</li>`;
 // Closed trades (the newest 20; the stats above cover every trade): side, entry / exit time, hold, reason, R, PnL, MFE / MAE.
 const rTxt=v=>fin(v)?`${Number(v)>=0?'+':'−'}${Math.abs(Number(v)).toFixed(2)}R`:'—',ex=x=>fin(x.mfeR)||fin(x.maeR)?`${rTxt(x.mfeR)} / ${rTxt(x.maeR)}`:'—';
 const done=x=>`<li><span class="muted">${when(x.closedAt)}</span><b>${esc(x.symbol)}</b>${scalpBadge(x.kind)}${side(x.direction||'LONG')}<span>${esc(x.closeReasonKo||x.closeReason)}</span><span class="muted">${held(x.openedAt||x.createdAt,x.closedAt)}</span><span>${tnLeverage(x.leverage)}</span>${x.margin?`<small>증거금 ${tnScalpMargin(x.margin)}</small>`:''}<span class="${cls(x.rMultiple)}">${rTxt(x.rMultiple)}</span><small class="muted">최대 ${ex(x)}</small><b class="${cls(x.netUSD)} end">${money(x.netUSD)}${x.netSource==='EXCHANGE'?'':' <small>추정</small>'}</b></li>`;
 const tgt=p=>(p.targets||[]).map((t,i)=>p.parts?.[i]>0?`<span class="${p.tpDone?.[i]?'paper-profit':''}">${px(t)}</span>`:null).filter(Boolean).join(' / ');
 const openTable=`<table class="copy-table only-desk"><thead><tr><th>종목</th><th>방향</th><th>배율</th><th class="num">수량</th><th class="num">진입</th><th class="num">현재가</th><th class="num">손절</th><th>목표</th><th>보유</th><th class="num">위험</th><th class="num">미실현</th></tr></thead><tbody>${open.map(p=>`<tr><td><b>${esc(p.symbol)}</b> ${scalpBadge(p.kind)}${p.status!=='OPEN'?` <small class="paper-loss">${esc(p.status)}</small>`:''}</td><td>${side(p.direction||'LONG')}</td><td>${esc(p.leverage)}배</td><td class="num">${esc(p.size||p.qty)}</td><td class="num">${px(p.avg)}</td><td class="num">${px(p.mark)}</td><td class="num">${px(p.stop)}${p.breakevenMoved?' <small>본전</small>':''}</td><td>${tgt(p)}</td><td class="muted">${held(p.openedAt||p.createdAt,Date.now())}</td><td class="num">${usdv(p.riskUSD)}</td><td class="num"><b class="${cls(p.unrealized)}">${money(p.unrealized)}</b></td></tr>`).join('')}</tbody></table>`;
 const closedTable=`<table class="copy-table only-desk"><thead><tr><th>종목</th><th>방향</th><th>진입</th><th>종료</th><th>보유</th><th>배율</th><th class="num">증거금</th><th>사유</th><th class="num">목표 도달</th><th class="num">R</th><th class="num">최대 이익/손실(R)</th><th class="num">손익</th></tr></thead><tbody>${closed.slice(0,20).map(x=>`<tr><td><b>${esc(x.symbol)}</b> ${scalpBadge(x.kind)}</td><td>${side(x.direction||'LONG')}</td><td class="muted">${when(x.openedAt||x.createdAt)}</td><td class="muted">${when(x.closedAt)}</td><td class="muted">${held(x.openedAt||x.createdAt,x.closedAt)}</td><td>${tnLeverage(x.leverage)}</td><td class="num">${tnScalpMargin(x.margin)}</td><td>${esc(x.closeReasonKo||x.closeReason)}</td><td class="num">${esc(x.tpHits??0)}개</td><td class="num ${cls(x.rMultiple)}">${rTxt(x.rMultiple)}</td><td class="num">${ex(x)}</td><td class="num"><b class="${cls(x.netUSD)}">${money(x.netUSD)}</b>${x.netSource==='EXCHANGE'?'':' <small>추정</small>'}</td></tr>`).join('')}</tbody></table>`;
 const counts=(s.skipCounts||[]).slice(0,8),skips=(s.skips||[]).slice(0,10);
 const skipBox=counts.length?`<h5 class="copy-sub">진입 안 한 이유</h5><p class="copy-rules">${counts.map(c=>`${esc(c.label)} ${esc(c.count)}회`).join(' · ')}</p><ul class="copy-list muted">${skips.map(x=>`<li><span class="muted">${when(x.at)}</span>${esc(x.symbol||'')}${x.direction?` <b class="${x.direction==='LONG'?'pos':'neg'}">${x.direction==='LONG'?'롱(급락 후 반등)':'숏(급등 후 되돌림)'}</b>`:''}${x.movePct!=null?` <small>${esc(Number(x.movePct).toFixed(1))}% 움직임</small>`:''} · ${esc(x.label||x.reason)}${skipDetail(x)}</li>`).join('')}</ul>`:'';
 const side_=`<div class="copy-side">${modeLine}${stats}${bySide}${rules}</div>`;
 const main=`<div class="copy-main"><h5 class="copy-sub">보유 중 <small>${open.length}개</small></h5>`+(open.length?`<ul class="copy-list only-mob">${open.map(row).join('')}</ul>${scrollCopyTable(openTable,'보유 포지션')}`:`<p class="empty-small">보유 중인 단타가 없습니다.${s.armed?' 5분봉 마감마다 급락 후 반등·급등 후 되돌림을 찾습니다.':''}</p>`)+
  (closed.length?`<h5 class="copy-sub">최근 종료 <small>최근 ${Math.min(20,closed.length)}건 · 전체 기록은 단타 기록 파일</small></h5><ul class="copy-list only-mob">${closed.slice(0,20).map(done).join('')}</ul>${scrollCopyTable(closedTable,'최근 종료 거래')}`:'')+skipBox+'</div>';
 return `<div class="copy-layout">${side_}${main}</div>`;
}
let scalpActionBusy=false;
function bindScalpButtons(el){
 if(!el||el.dataset.bound)return;el.dataset.bound='1';
 el.addEventListener('click',async e=>{
  const arm=e.target.closest('[data-scalp-arm]'),disarm=e.target.closest('[data-scalp-disarm]'),btn=arm||disarm;if(!btn||scalpActionBusy)return;
  if(arm&&!window.confirm('되돌림 단타(테스트넷)를 켭니다. 5분봉이 마감될 때마다 급락 후 반등 롱·급등 후 되돌림 숏을 BingX 테스트넷에 주문합니다. 켤까요?'))return;
  scalpActionBusy=true;
  const msg=el.querySelector('[data-scalp-msg]');btn.disabled=true;btn.textContent=arm?'켜는 중…':'끄는 중…';
  const KO={KILL_SWITCH_ON:'긴급 정지 중',DAILY_LOSS_LIMIT:'오늘 하루 손실 한도에 닿음',CREDENTIALS_MISSING:'BingX API 키 없음',SCALP_MODE_OFF:'꺼짐 설정',LIVE_REFUSED:'테스트넷 전용',UPDATING:'업데이트 중',UPDATE_IN_PROGRESS:'업데이트 중'};
  try{const r=await fetch(arm?'/api/scalp/arm':'/api/scalp/disarm',{method:'POST',cache:'no-store',headers:{'Content-Type':'application/json'},body:JSON.stringify(arm?{confirm:'SCALP_ARM'}:{})}),d=await r.json().catch(()=>({}));
   if(!r.ok)throw Error(KO[d.error]||d.error||'HTTP '+r.status);if(msg)msg.textContent=d.armed?'✓ 켜졌습니다':'✓ 꺼졌습니다'}
  catch(err){if(msg){msg.textContent='실패: '+err.message;msg.classList.add('err')}}
  finally{scalpActionBusy=false}
  document.getElementById('liveRefresh')?.click()})}

// ---- One testnet screen (user 2026-11-17 "단타랑 원래 쓰던 테스트넷이랑 합쳐서 진행하자 따로 보는 게 더 복잡"): the signal
// strategy and the reversal scalp share one switch, one budget line, one 보유 중 list and one 종료된 거래 list (badges 신호 / 단타).
const tnMoney=v=>v==null||!fin(v)?'—':`${Number(v)>=0?'+':'−'}$${Math.abs(Number(v)).toFixed(2)}`,tnUsd=v=>v==null||!fin(v)?'—':`$${Number(v).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})}`;
const tnCls=v=>!fin(v)?'':Number(v)>0?'paper-profit':Number(v)<0?'paper-loss':'';
const tnWhen=t=>t?new Date(t).toLocaleString('ko-KR',{timeZone:'Asia/Seoul',month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit',hour12:false}):'';
const tnHeld=(a,b)=>{const m=(b-a)/60000;return !(m>=0)?'':m<90?Math.max(1,Math.round(m))+'분':m<48*60?(+(m/60).toFixed(1))+'시간':(+(m/1440).toFixed(1))+'일'};
export const TN_BADGE={signal:'<span class="vp-badge tn-signal">신호</span>',scalp:'<span class="vp-badge tn-scalp">단타·급변</span>',
 scalpZone:'<span class="vp-badge tn-scalp tn-scalp-zone">단타·매물대</span>'};
// Scalp badge by kind (user 2026-11-17 23:12): 단타·급변 = the 5 % move rule (MOVE_REVERSAL, older records too),
// 단타·매물대 = 매물대 반전 (ZONE_REVERSAL, 2.5 % at a 4H / 1D volume zone).
export function scalpBadge(kind){return kind==='ZONE_REVERSAL'?TN_BADGE.scalpZone:TN_BADGE.scalp}

/** Proportional display scale for legacy uncapped VST items when a testnet capital cap (default $3,000) is active. */
export function tnScaleOf(item,budget){
 const cap=Number(budget?.capitalCapUSD);
 if(!(cap>0))return 1;
 if(fin(item?.capitalBasisUSD)&&Number(item.capitalBasisUSD)>0&&Number(item.capitalBasisUSD)<=cap*1.5)return 1;
 const ds=Number(budget?.displayScale);
 const base=Number.isFinite(ds)&&ds>0&&ds<1?ds:1;
 // Account VST equity may be at or slightly above cap (e.g. $3,002 vs $3,000 -> ds=0.9993), while legacy oversized VST trades remain in history.
 const r=Number(item?.initialRiskUSD??item?.riskUSD)||0;
 const m=Number(item?.initialMarginUSD??item?.margin?.initialUSD??item?.marginUSD)||0;
 if(m*base>cap*0.18||r*base>cap*0.05){
  const implied=Math.max(r>0?r/0.005:0,m>0?m/0.05:0,100000);
  return +(Math.min(base,cap/implied)).toFixed(6);
 }
 return base;
}

/** Status line: on / off and today's shared budget: "오늘 손실 −$x / 한도 $y (15%) · 열린 위험 $z". */
export function testnetBudgetHTML(t){
 if(!t)return '';
 // The mode is the header's, on / off and 긴급 정지 the buttons' (user 2026-11-18: one place per fact); this line keeps
 // what only it has: a stop for today, a part-on switch (which strategy is on) and the shared budget.
 const b=t.budget||{},state=b.stopped?'<b class="copy-state kill">■ 오늘 정지 (하루 손실 한도)</b> <button type="button" class="outline-btn small" data-testnet-clear-stop>오늘 정지 해제</button>':t.partial?'<b class="copy-state on">◐ 일부 활성화</b>':'';
 const who=t.partial?[t.signal?`신호 ${t.signal.armed?'●':'○'}`:null,t.scalp?`단타 ${t.scalp.armed?'●':'○'}`:null].filter(Boolean).join(' · '):'';
 const loss=Number(b.lossUSD)>0?`−$${Number(b.lossUSD).toFixed(2)}`:'$0.00';
 const capped=fin(b.equityUSD)&&fin(b.accountEquityUSD)&&b.accountEquityUSD>b.equityUSD;
 const scaledNote=capped&&fin(b.displayScale)&&Number(b.displayScale)<1?` · 기준 자본 ${tnUsd(b.equityUSD)} (VST 비례 환산)`:capped?` · 한도 기준 ${tnUsd(b.equityUSD)}`:'';
 const balance=fin(b.equityUSD)?`${fin(b.accountEquityUSD)?`BingX 순자산 ${tnUsd(b.accountEquityUSD)}`:`기준 순자산 ${tnUsd(b.equityUSD)}`}${scaledNote}${b.balanceAt?` · ${esc(auditTime(b.balanceAt))} KST`:''}`:'';
 const budgetError=b.balanceError==='BALANCE_STALE'?'현재 순자산 갱신 지연':b.balanceError?'현재 순자산 조회 실패':'';
 return `${state}${who?`<span class="tn-who">${esc(who)}</span>`:''}<span class="tn-budget-nums">공동 한도 · 오늘 손실 <b class="${Number(b.lossUSD)>0?'paper-loss':''}">${loss}</b> / 한도 <b>${fin(b.limitUSD)?tnUsd(b.limitUSD):'잔고 확인 중'}</b> (${esc(b.dailyLossPct??'—')}%) · 열린 위험 <b>${tnUsd(b.openRiskUSD)}</b>${fin(b.marginUSD)?` · 증거금 ${tnUsd(b.marginUSD)} / ${fin(b.marginCapUSD)?tnUsd(b.marginCapUSD):'—'} (${esc(b.marginCapPct??'—')}%)`:''}</span>${balance?`<small class="tn-who">${balance}</small>`:''}${budgetError?`<small class="live-warn-text">${budgetError}</small>`:''}${t.scalpError?`<small class="muted">단타 켜지 않음: ${esc(t.scalpError)}</small>`:''}`;
}

const SCALP_SCAN_PAUSE_KO=Object.freeze({
 UNRESOLVED_ORDER_STATE:'미확인 주문 확인 중 (다음 5분봉 자동 재개)',
 RATE_LIMIT_COOLDOWN:'요청 과다로 잠시 대기',
 DAILY_LOSS_LIMIT:'하루 손실 한도 도달',
 KILL_SWITCH:'긴급 정지 중',
 UPDATING:'업데이트 중',
});
/** Always-visible 5m scalp scan heartbeat bar on the testnet screen so the operator can verify scan health at a glance. */
export function scalpScanStatusHTML(s,{now=Date.now()}={}){
 if(!s||s.mode!=='TESTNET'||!s.credentials)return '';
 const ls=s.lastScan,total=Number(s.universe?.count)||0;
 const pauseKo=ls?.error?SCALP_SCAN_PAUSE_KO[ls.error]||null:null;
 const scanSummary=()=>{
  if(!ls?.at)return '';
  const ageMin=Math.max(0,Math.floor((now-Number(ls.at))/60000));
  const ageTxt=ageMin===0?'방금':ageMin<60?`${ageMin}분 전`:`${Math.floor(ageMin/60)}시간 ${ageMin%60}분 전`;
  const checked=Number(ls.checked)||0,denom=total||checked;
  const detected=(Number(ls.signals)||0)+(Number(ls.zoneSignals)||0),entered=Number(ls.entered)||0;
  const failPart=ls.failed>0?` · <span class="live-warn-text">조회 실패 ${esc(ls.failed)}건${ls.lastFailure?` (${esc(ls.lastFailure)})`:''}</span>`:'';
  const errPart=ls.error?pauseKo?` · <small class="muted">직전 보류: ${esc(pauseKo)}</small>`:` · <span class="live-warn-text">오류: ${esc(ls.error)}</span>`:'';
  const rlPart=ls.rateLimited>0?` · <small class="muted">속도제한 재시도 ${esc(ls.rateLimited)}회</small>`:'';
  return `<span class="tn-budget-nums">마지막 스캔 <b>${esc(tnWhen(ls.at))}</b> (${esc(ageTxt)}) · 검사 <b>${esc(checked)}${denom?`/${esc(denom)}`:''}종목</b> · 감지 ${esc(detected)}건 · 진입 ${esc(entered)}건${failPart}${errPart}${rlPart}</span>`;
 };
 if(!s.armed){
  return `<b class="copy-state off">○ 단타 5분 스캔 꺼짐</b>${ls?.at?scanSummary():'<span class="tn-who">활성화하면 5분봉 마감마다 자동 검사합니다</span>'}`;
 }
 if(s.scanning){
  return `<b class="copy-state on">● 5분봉 스캔 진행 중…</b>${total?`<span class="tn-who">대상 ${esc(total)}종목</span>`:''}${scanSummary()}`;
 }
 if(s.blocked){
  return `<b class="copy-state kill">■ 단타 진입 중지 (${esc(s.blockedKo||s.blocked)})</b>${scanSummary()}`;
 }
 if(!ls?.at){
  return `<b class="copy-state on">● 5분봉 스캔 대기 중</b><span class="tn-who">다음 5분봉 마감 직후 첫 검사를 실행합니다</span>`;
 }
 const ageMin=Math.max(0,Math.floor((now-Number(ls.at))/60000));
 const stale=ageMin>=8,hasErr=(Boolean(ls.error)&&!pauseKo)||(ls.failed>0&&!(ls.checked>0));
 const badge=hasErr?'<b class="copy-state kill">⚠ 단타 스캔 오류</b>':stale?`<b class="copy-state kill">⚠ 단타 스캔 지연 (${esc(ageMin)}분 전)</b>`:'<b class="copy-state on">● 5분봉 정상 감시 중</b>';
 return `${badge}${scanSummary()}`;
}

/** One open scalp position as a card next to the signal cards (badge 단타). */
export function scalpPositionCardHTML(p,{allowClose=false,budget=null}={}){
 const px=v=>fin(v)?esc(+Number(v).toPrecision(6)):'—';
 const tgt=(p.targets||[]).map((t,i)=>p.parts?.[i]>0?`<i class="tn-tp${p.tpDone?.[i]?' paper-profit':''}">${px(t)}</i>`:null).filter(Boolean).join(' · ')||'—'; // <i>: the card styles every <span> as a cell
 const sc=tnScaleOf(p,budget);
 const rawDetails=p.details??{firstEntryPrice:p.scaleIn?.initialEntry??p.avg,averageEntryPrice:p.avg,currentPrice:p.mark,
  currentPriceSource:fin(p.mark)?'VENUE_TICKER':null,asset:String(p.symbol||'').replace(/USDT$/,''),
  quantity:{base:p.size},unrealized:fin(p.unrealized)?{usd:p.unrealized,source:'ESTIMATE'}:null,tickSize:p.tickSize};
 const details=sc<1?{
  ...rawDetails,
  unrealized:rawDetails.unrealized&&fin(rawDetails.unrealized.usd)?{...rawDetails.unrealized,usd:Number(rawDetails.unrealized.usd)*sc}:rawDetails.unrealized,
  margin:rawDetails.margin&&fin(rawDetails.margin.usd)?{...rawDetails.margin,usd:Number(rawDetails.margin.usd)*sc}:rawDetails.margin,
  realizedOpen:rawDetails.realizedOpen&&fin(rawDetails.realizedOpen.usd)?{...rawDetails.realizedOpen,usd:Number(rawDetails.realizedOpen.usd)*sc}:rawDetails.realizedOpen,
 }:rawDetails;
 const riskVal=fin(p.riskUSD)?Number(p.riskUSD)*sc:p.riskUSD;
 const scaleBadge=sc<1?`<span class="vp-badge" title="기존 VST 포지션을 기준 자본(${tnUsd(budget?.capitalCapUSD)})에 비례 환산해 표시 (신규 매매는 1:1)">비례환산</span>`:'';
 const scoreBadge=fin(p.scalpScore?.score)?`<span class="vp-badge" title="${esc(p.scalpScore.summary||'')}">${esc(p.scalpScore.score)}점 ${esc(p.scalpScore.grade||'')}급${Number(p.scalpScore.sizeMult)>1?` · ${esc(p.scalpScore.sizeMult)}x`:''}</span>`:'';
 return `<article class="paper-trade live-position tn-scalp-card${p.status&&p.status!=='OPEN'?' live-warn':''}">
 <header><b>${esc(p.symbol)}</b>${scalpBadge(p.kind)}${scoreBadge}${scaleBadge}${side(p.direction||'LONG')}<span>${fin(p.leverage)?esc(p.leverage)+'배 교차':'배율 —'} · BingX</span><span class="live-state s-${esc(p.status||'OPEN')}">${esc(p.status==='OPEN'||!p.status?'보유 중':p.status)}</span></header>
 <div class="paper-trade-values live-values">
  ${positionMetricsHTML(details)}
  ${p.stopLossEnabled===false?'<span>자동 손절<b>없음</b></span>':`<span>손절가<b>${px(p.stop)}</b>${p.breakevenMoved?'<small>1차 목표 뒤 본전</small>':''}</span>`}
  <span class="tp-cell">목표<b>${tgt}</b></span>
  <span>${p.stopLossEnabled===false?'한도 계산 위험':'위험'}<b>${tnUsd(riskVal)}</b></span>
  <span>보유<b>${tnHeld(p.openedAt||p.createdAt,Date.now())}째</b>${p.stopLossEnabled===false?'':'<small>최대 2시간</small>'}</span>
 </div>${p.kind==='ZONE_REVERSAL'&&p.zone?.tf?`<p class="copy-rules tn-zone">매물대 반전 · ${esc(String(p.zone.tf).toUpperCase())} 매물대 ${px(p.zone.low)}~${px(p.zone.high)}${fin(p.zone.sharePct)?` · 거래량 ${esc(Number(p.zone.sharePct).toFixed(1))}% · ${esc(p.zone.rank)}위`:''}${fin(p.zone.distPct)&&p.zone.distPct>0?` · ${esc(Number(p.zone.distPct).toFixed(2))}% 거리`:''}</p>`:''}
 ${allowClose&&p.status==='OPEN'&&p.size>0&&p.id?testnetCloseButton('scalp',p.id,p):''}
 </article>`;
}

/** Signal closes (liveClosedView rows) and scalp closes in one list, newest first. */
export function testnetCloses(o){
 // Only the testnet's own signal trades, tests left out (the testnetStats filter, review L3).
 const sig=(o?.testnet?.scalpOnly?[]:o?.closed||[]).filter(c=>c.mode==='TESTNET'&&c.test!==true).map(c=>({kind:'signal',key:c.signalKey,symbol:c.symbol,direction:c.direction,openedAt:c.createdAt,closedAt:c.closedAt,reason:c.closeReasonKo||c.closeReason,
  netUSD:c.realized?.netUSD??null,source:c.realized?.source||'PENDING',test:c.test===true,deletable:c.deletable===true}));
 const sc=(o?.scalp?.closed||[]).map(x=>({kind:'scalp',scalpKind:x.kind||'MOVE_REVERSAL',key:x.id,symbol:x.symbol,direction:x.direction||'LONG',openedAt:x.openedAt||x.createdAt,closedAt:x.closedAt,reason:x.closeReasonKo||x.closeReason,
  netUSD:x.netUSD??null,source:x.netSource==='EXCHANGE'?'EXCHANGE':'ESTIMATE',r:x.rMultiple??null,leverage:x.leverage,margin:x.margin,capitalBasisUSD:x.capitalBasisUSD??null,initialRiskUSD:x.initialRiskUSD??x.riskUSD??null,initialMarginUSD:x.initialMarginUSD??x.margin?.initialUSD??x.marginUSD??null}));
 return [...sig,...sc].sort((a,b)=>(Number(b.closedAt)||0)-(Number(a.closedAt)||0));
}
let tnPage=0,lastTestnet=null;
const tnLeverage=v=>fin(v)&&Number(v)>0?`${esc(v)}배`:'—';
function tnScalpMargin(m){
 if(!fin(m?.initialUSD)&&!fin(m?.totalUSD))return '—';
 return `첫 ${tnUsd(m?.initialUSD)} · 누적 ${tnUsd(m?.totalUSD)}`;
}
export const TESTNET_PAGE_SIZE=10;
export function setTestnetPage(p){tnPage=Math.max(0,p|0)}
const tnResult=x=>x.source==='PENDING'?'<span class="muted">정산 중</span>':x.source==='UNKNOWN'||!fin(x.netUSD)?'<span class="muted">확인 불가</span>':`${tnMoney(x.netUSD)}${x.source==='ESTIMATE'?' <small class="muted">추정</small>':''}`;
/** The merged 종료된 거래 list, 10 per page (the copy page's pager), desktop table / phone list. */
export function testnetClosedHTML(o){
 lastTestnet=o;
 const budget=o?.testnet?.budget??null;
 const all=testnetCloses(o).map(x=>{
  const sc=tnScaleOf(x,budget);
  if(!(sc<1))return x;
  const m=x.margin?{
   initialUSD:fin(x.margin.initialUSD)?Number(x.margin.initialUSD)*sc:x.margin.initialUSD,
   addedUSD:fin(x.margin.addedUSD)?Number(x.margin.addedUSD)*sc:x.margin.addedUSD,
   totalUSD:fin(x.margin.totalUSD)?Number(x.margin.totalUSD)*sc:x.margin.totalUSD,
  }:x.margin;
  return {...x,netUSD:fin(x.netUSD)?Number(x.netUSD)*sc:x.netUSD,margin:m};
 });
 if(!all.length)return '<p class="empty-small">아직 종료된 테스트넷 거래가 없습니다.</p>';
 const pages=Math.max(1,Math.ceil(all.length/TESTNET_PAGE_SIZE)),page=Math.min(tnPage,pages-1),shown=all.slice(page*TESTNET_PAGE_SIZE,page*TESTNET_PAGE_SIZE+TESTNET_PAGE_SIZE);
 const pager=pages>1?`<div class="copy-pager"><button type="button" class="outline-btn small" data-tn-page="-1"${page===0?' disabled':''}>‹ 이전</button><span class="muted">${page+1} / ${pages}쪽</span><button type="button" class="outline-btn small" data-tn-page="1"${page>=pages-1?' disabled':''}>다음 ›</button></div>`:'';
 const del=x=>x.kind==='signal'&&x.deletable?` <button type="button" class="ghost small" data-live-delete="${esc(x.key)}">삭제</button>`:'';
 const tag=x=>`${x.kind==='scalp'?scalpBadge(x.scalpKind):TN_BADGE[x.kind]}${x.test?' <small class="muted">시험(합계 제외)</small>':''}`;
 const li=x=>`<li class="tn-${x.kind}"><span class="muted">${tnWhen(x.closedAt)}</span><b>${esc(x.symbol)}</b>${tag(x)}${side(x.direction)}<span>${esc(x.reason||'')}</span><span class="muted">${tnHeld(x.openedAt,x.closedAt)}</span>${x.kind==='scalp'?`<span>${tnLeverage(x.leverage)}</span><small>증거금 ${tnScalpMargin(x.margin)}</small>`:''}<b class="${tnCls(x.netUSD)} end">${tnResult(x)}</b>${del(x)}</li>`;
 const table=`<table class="copy-table only-desk"><thead><tr><th>종료</th><th>구분</th><th>종목</th><th>방향</th><th>보유</th><th>배율</th><th class="num">증거금</th><th>사유</th><th class="num">손익</th></tr></thead><tbody>${shown.map(x=>`<tr class="tn-${x.kind}"><td class="muted">${tnWhen(x.closedAt)}</td><td>${tag(x)}</td><td><b>${esc(x.symbol)}</b></td><td>${side(x.direction)}</td><td class="muted">${tnHeld(x.openedAt,x.closedAt)}</td><td>${tnLeverage(x.leverage)}</td><td class="num">${tnScalpMargin(x.margin)}</td><td class="tn-reason">${esc(x.reason||'')}</td><td class="num"><b class="${tnCls(x.netUSD)}">${tnResult(x)}</b>${del(x)}</td></tr>`).join('')}</tbody></table>`;
 return `<ul class="copy-list only-mob">${shown.map(li).join('')}</ul>${scrollCopyTable(table,'테스트넷 종료 거래')}${pager}`;
}
/** Totals over both strategies (server testnetStats) and the 신호 / 단타 breakdown line. */
export function testnetSummaryHTML(st,{scalpOnly=false,open=[],budget=null}={}){
 const a=st?.all||{},s=st?.signal||{},c=st?.scalp||{};
 const priced=open.filter(p=>fin(p?.usd));
 const unrealized=priced.length?priced.reduce((total,p)=>total+Number(p.usd),0):open.length?null:0;
 const coverage=priced.length<open.length?`확인 ${priced.length}/${open.length}건`:`보유 ${open.length}건`;
 const profitSource=priced.some(p=>p.source==='ESTIMATE')?' · 추정 포함':'';
 const scaledCap=fin(budget?.capitalCapUSD)&&Number(budget.capitalCapUSD)>0&&fin(budget?.displayScale)&&Number(budget.displayScale)<1?`<small>기준 자본 ${tnUsd(budget.capitalCapUSD)} 비례 환산</small>`:'';
 return `<div><span>누적 실현 손익 (수수료 반영)</span><strong class="${tnCls(a.netUSD)}">${a.trades?tnMoney(a.netUSD):'—'}</strong>${scaledCap}</div>
 <div><span>미실현 손익 합계</span><strong class="${tnCls(unrealized)}">${unrealized===0?'$0.00':tnMoney(unrealized)}</strong><small>${coverage}${profitSource}</small></div>
 <div><span>거래</span><strong>${esc(a.trades??0)}건</strong><small>${esc(a.wins??0)}승 ${esc((a.trades??0)-(a.wins??0))}패</small></div>
 <div><span>승률</span><strong>${fin(a.winRatePct)?Number(a.winRatePct).toFixed(1)+'%':'—'}</strong></div>
 <div><span>PF</span><strong>${fin(a.profitFactor)?Number(a.profitFactor).toFixed(2):a.trades?'∞':'—'}</strong></div>
 ${scalpOnly?'':`<p class="copy-split tn-split">신호 <b class="${tnCls(s.netUSD)}">${tnMoney(s.netUSD??0)}</b> (${esc(s.trades??0)}건) · 단타 <b class="${tnCls(c.netUSD)}">${tnMoney(c.netUSD??0)}</b> (${esc(c.trades??0)}건)</p>`}`;
}

let scalpSimOpen=false,scalpSimCustomized=false,lastScalpSim=null,lastScalpSimParams={days:7,minMovePct:5,trendMode:'off',zoneSignals:true,minNetRR:0,sides:'LONG,SHORT'};
export function setScalpSimOpen(v){scalpSimOpen=!!v}
export function resetScalpSimParams(){scalpSimCustomized=false;lastScalpSim=null}
const SIM_REASON_KO={AGAINST_4H_TREND:'4H 역추세',TP1_NET_RR_BELOW_MINIMUM:'손익비 미달',SIDE_OFF:'방향 꺼짐',SHORT_NOT_TRADED:'숏 꺼짐',ZONE_NOT_TOUCHED:'매물대 미도달'};
export function scalpSimResultHTML(d){
 if(!d)return '';
 const b=d.baseline||{},sim=d.simulated||{},sig=d.signalSummary||{};
 const pf=x=>x?.profitFactor!=null?esc(x.profitFactor):x?.trades&&x.netUSD>0?'∞':'—';
 const wr=x=>x?.winRatePct!=null?esc(x.winRatePct)+'%':'—';
 const unlockedList=Object.entries(sim.unlockedByReason||{}).map(([k,v])=>`${esc(SIM_REASON_KO[k]||k)} ${esc(v)}건`).join(' · ');
 const summary=`<div class="an-summary">
  <span>기존 실제 종료 (${esc(d.window?.days??7)}일)<b>${esc(b.trades??0)}건 · 승률 ${wr(b)} · PF ${pf(b)}</b><small class="${tnCls(b.netUSD)}">${tnMoney(b.netUSD)}</small></span>
  <span>조건 적용 후 거래<b>${esc(sim.trades??0)}건 · 승률 ${wr(sim)} · PF ${pf(sim)}</b><small class="${tnCls(sim.netUSD)}">${tnMoney(sim.netUSD)} (제외 ${esc(sim.removedTrades??0)}건 · ${tnMoney(sim.removedNetUSD)})</small></span>
  <span>새로 통과할 후보 신호<b>+${esc(sim.unlockedSignals??0)}건</b><small>${unlockedList||'추가 해제 없음'}</small></span>
  <span>분석 신호 / 진입<b>${esc(sig.totalSignals??0)}건 / 진입 ${esc(sig.originalEntered??0)}건</b><small>미진입 ${esc(sig.stillBlocked??0)}건 유지</small></span>
 </div>`;
 const presets=Array.isArray(d.presets)&&d.presets.length?`<div class="copy-table-scroll an-scroll" role="region" aria-label="단타 조건 프리셋 비교" tabindex="0"><table class="copy-table analytics-table"><thead><tr><th>조건 프리셋</th><th class="num">거래</th><th class="num">승률</th><th class="num">PF</th><th class="num">누적 손익</th><th class="num">제외 손익</th><th class="num">추가 후보</th></tr></thead><tbody>${d.presets.map(p=>`<tr><td><b>${esc(p.label)}</b></td><td class="num">${esc(p.trades)}건</td><td class="num">${wr(p)}</td><td class="num">${pf(p)}</td><td class="num"><b class="${tnCls(p.netUSD)}">${p.trades?tnMoney(p.netUSD):'—'}</b></td><td class="num ${tnCls(p.removedNetUSD)}">${p.removedTrades?tnMoney(p.removedNetUSD):'—'}</td><td class="num">+${esc(p.unlockedSignals??0)}건</td></tr>`).join('')}</tbody></table></div>`:'';
 return summary+presets;
}

/** The scalp's own details, collapsed under "단타 신호·건너뜀": rules, 롱 / 숏 totals, last scan, skip reasons, journal. */
function scalpExitRule(S){
 const protection=S.stopLossEnabled===false?`자동 손절·시간 만료 청산 없음${S.repeatedScaleIn?' · 점진 확대 추매(1R→2R→3.5R→5R · 1x/1x/1.5x/2x · 최대 4회 · IOC 0.35~0.8% · 4H 역추세 50% · BTC 급변 방어)':''}`:`손절 저점(숏은 고점) 너머 ATR×${esc(S.stopAtr)} · 1차 목표 뒤 본전 · 최대 ${esc(S.maxHoldMin)}분 보유`;
 const roe=Number(S.minProfitRoePct),fallbackMin=S.earlyTakeProfitMin??15;
 return protection+(S.profitHoldTargetMin?(roe>0?` · ${esc(S.profitHoldTargetMin)}분 내 익절 목표 · 5초 주기 점검으로 순수익률(ROE) +${esc(roe)}% 도달 시 50% 확정 + 잔여 50% 트레일링 · 추매 포지션은 +6% 50% 확정 후 30% 트레일링(24시간+3회 추매 시 +2.5% 회전, 5% 미만 먼지 자동 정리) · 비추매 ${esc(fallbackMin)}분 경과 시 비용 충당 익절`:` · ${esc(S.profitHoldTargetMin)}분 내 익절 목표 · 조기 전량 익절은 진입 ${esc(fallbackMin)}분부터 · 예상 비용을 넘기는 가격에서 지정가 청산`):
  S.earlyTakeProfitMin?` · ${esc(S.earlyTakeProfitMin)}분 경과 후 예상 비용을 충당하는 가격에 지정가 익절`:'');
}

export function scalpDetailsHTML(s){
 if(!s)return '';
 const st=s.stats||{},S=s.settings||{},SK={LONG:'롱',SHORT:'숏'},sides=S.sides||['LONG','SHORT'],stat=(k,v,extra='')=>`<span>${k}<b ${extra}>${v}</b></span>`;
 const mode=s.mode!=='TESTNET'?(s.refused==='LIVE_REFUSED'?'실계좌 모드는 거부됨 — 테스트넷 전용':'SCALP_EXEC_MODE=OFF'):!s.credentials?'BingX API 키 없음':s.armed&&s.blocked?`지금 진입 안 함: ${esc(s.blockedKo||s.blocked)}`:''; // on / off: the testnet switch
 const bySide=`<div class="copy-stats">${['LONG','SHORT'].map(d=>{const b=st.bySide?.[d]||{};return stat(`${SK[d]}${sides.includes(d)?'':' (꺼짐)'}`,`${b.trades||0}건 · ${b.winRatePct!=null?b.winRatePct+'%':'—'} · PF ${b.profitFactor!=null?b.profitFactor:b.trades?'∞':'—'}`)+stat(`${SK[d]} 손익`,tnMoney(b.trades?b.netUSD:null),`class="${tnCls(b.netUSD)}"`)}).join('')}</div>`;
 const noStop=S.stopLossEnabled===false;
 const exitRule=scalpExitRule(S);
 const recheck=S.reversalRecheckMin?` · 가격·손익비로 건너뛴 반전은 ${esc(S.reversalRecheckMin)}분 동안 재확인`:'';
 const scoreRule=Number(S.minScore)>0?` · 100점 신호 점수 ${esc(S.minScore)}점 이상 진입${Number(S.highScoreSizeMult)>1&&Number(S.highScore)>0?` (${esc(S.highScore)}점+ 비중 ${esc(S.highScoreSizeMult)}배)`:''}`:'';
 const rules=`<p class="copy-rules">${mode?`상태 ${mode} · `:''}거래 방향 ${sides.length?sides.map(d=>SK[d]).join('·'):'없음'} · 5분봉 급락(롱)·급등(숏) ${esc(S.minMovePct)}% 이상${S.zoneSignals?` (또는 ${esc(S.zoneMinMovePct)}% 이상 + 극값이 4H/1D 매물대 ±${esc(S.zoneTouchPct)}% 안 = 매물대 반전)`:''} · 거래량 ${esc(S.climaxVolume)}배 · 반전 캔들 확인 뒤 진입${scoreRule} · 목표 ${(S.retracements||[]).map(r=>+(r*100).toFixed(1)+'%').join('/')} 되돌림 (40/35/25%) · ${exitRule} · ${S.trendMode==='on'?'4시간 추세 반대 제외(하락 중 롱·상승 중 숏)':S.trendMode==='off'?'4시간 추세 미사용':'4시간 추세 기록만(진입 막지 않음)'} · ${noStop?'진입 규모 계산 위험':'거래당 위험'} 잔고 ${esc(S.riskPct)}% · ${esc(S.leverage)}배 교차 · 하루 손실 ${esc(S.dailyLossPct)}%${S.sharedBudget?'(신호 전략과 공동)':''}에서 새 주문 정지 · 진입가와 ${esc(S.maxDriftPct)}%${S.driftMovePct>0?`(유리한 쪽은 급변 폭의 ${esc(S.driftMovePct)}%까지)`:''}${S.stopKeepPct>0?`(더 좋은 가격은 ${noStop?'기준':'손절'} 거리 ${esc(S.stopKeepPct)}% 이상 남으면 진입)`:''} 넘게 벌어지면 건너뜀${s.universe?.count?` · 대상 ${esc(s.universe.count)}종목`:''}${s.lastScan?.at?` · 마지막 검사 ${tnWhen(s.lastScan.at)} (${esc(s.lastScan.checked)}종목${s.lastScan.failed>0?`, 실패 ${esc(s.lastScan.failed)}`:''}${s.lastScan.error?`, 오류 ${esc(s.lastScan.error)}`:''})`:''}</p>`;
 const counts=(s.skipCounts||[]).slice(0,8),skips=(s.skips||[]).slice(0,10);
 const KK={MOVE_REVERSAL:'급변 5%',ZONE_REVERSAL:'매물대 반전'};
 const byKind=`<div class="copy-stats tn-kind-stats">${['MOVE_REVERSAL','ZONE_REVERSAL'].map(k=>{const b=st.byKind?.[k]||{};return stat(`${KK[k]}${k==='ZONE_REVERSAL'&&S.zoneSignals===false?' (꺼짐)':''}`,`${b.trades||0}건 · ${b.winRatePct!=null?b.winRatePct+'%':'—'} · PF ${b.profitFactor!=null?b.profitFactor:b.trades?'∞':'—'}`)+stat(`${KK[k]} 손익`,tnMoney(b.trades?b.netUSD:null),`class="${tnCls(b.netUSD)}"`)}).join('')}</div>`;
 const skipBox=counts.length?`<h5 class="copy-sub">진입 안 한 이유</h5><p class="copy-rules">${counts.map(c=>`${esc(c.label)} ${esc(c.count)}회`).join(' · ')}</p><ul class="copy-list muted">${skips.map(x=>`<li><span class="muted">${tnWhen(x.at)}</span>${esc(x.symbol||'')}${x.kind==='ZONE_REVERSAL'?' <small>매물대 후보</small>':''}${x.direction?` <b class="${x.direction==='LONG'?'pos':'neg'}">${x.direction==='LONG'?'롱(급락 후 반등)':'숏(급등 후 되돌림)'}</b>`:''}${x.movePct!=null?` <small>${esc(Number(x.movePct).toFixed(1))}% 움직임</small>`:''} · ${esc(x.label||x.reason)}${skipDetail(x)}</li>`).join('')}</ul>`:'<p class="empty-small">건너뛴 신호가 없습니다.</p>';
 const journal=`<p class="copy-rules">전체 기록: <a href="/api/scalp/journal?limit=200" target="_blank" rel="noopener">단타 거래 기록</a> · <a href="/api/scalp/journal?kind=signals&amp;limit=200" target="_blank" rel="noopener">감지된 신호</a> (JSON)</p>`;
 const experiment=S.repeatedScaleIn&&st.repeatedScaleIn?`<p class="copy-rules">반복 추매 실험 종료 ${esc(st.repeatedScaleIn.closed)}건 · 추매 ${esc(st.repeatedScaleIn.adds)}회</p>`:st.scaleIn&&S.scaleIn?`<p class="copy-rules">추매 실험 종료 ${esc(st.scaleIn.closed)}건 · 추매 체결 ${esc(st.scaleIn.filled)}건</p>`:'';
 const sp=scalpSimCustomized?lastScalpSimParams:{
  days:7,
  minMovePct:fin(S.minMovePct)?Number(S.minMovePct):5,
  trendMode:S.trendMode==='on'?'on':'off',
  zoneSignals:S.zoneSignals!==false,
  minNetRR:noStop?0:(fin(S.minNetRR)?Number(S.minNetRR):1),
  sides:Array.isArray(S.sides)&&S.sides.length?S.sides.join(','):'LONG,SHORT',
 };
 const simBox=`<details class="copy-analytics-fold scalp-sim-fold"${scalpSimOpen?' open':''}><summary data-scalp-sim-toggle><b>단타 조건 시뮬레이터 (What-If)</b> <small>최근 신호·거래 기반 조건 비교 · 주문 없음</small></summary>
  <div class="an-body">
   <form class="ctrl-form sim-form" data-scalp-sim-form>
    <label>분석 기간 (일) <input name="days" type="number" min="1" max="30" step="1" value="${esc(sp.days)}"></label>
    <label>최소 급변 (%) <input name="minMovePct" type="number" min="2.5" max="15" step="0.5" value="${esc(sp.minMovePct)}"></label>
    <label>4H 추세 필터 <select name="trendMode"><option value="on"${sp.trendMode==='on'?' selected':''}>ON (역추세 제외)</option><option value="off"${sp.trendMode==='off'?' selected':''}>OFF (모두 허용)</option></select></label>
    <label>매물대 반전 <select name="zoneSignals"><option value="true"${sp.zoneSignals?' selected':''}>ON (2.5%+매물대)</option><option value="false"${!sp.zoneSignals?' selected':''}>OFF (급변만)</option></select></label>
    <label>최소 손익비 (RR) <input name="minNetRR" type="number" min="0" max="3" step="0.1" value="${esc(sp.minNetRR)}" title="0 = 제한 없음"></label>
    <label>방향 <select name="sides"><option value="LONG,SHORT"${sp.sides==='LONG,SHORT'?' selected':''}>롱 + 숏</option><option value="LONG"${sp.sides==='LONG'?' selected':''}>롱만</option><option value="SHORT"${sp.sides==='SHORT'?' selected':''}>숏만</option></select></label>
    <button type="submit" class="outline-btn small">시뮬레이션 실행</button>
   </form>
   <div data-scalp-sim-out>${lastScalpSim?scalpSimResultHTML(lastScalpSim):'<p class="empty-small">시뮬레이션 실행 버튼을 누르면 최근 신호와 종료 거래로 조건별 차이를 계산합니다.</p>'}</div>
  </div></details>`;
 return byKind+bySide+rules.replace('</p>',`${recheck}</p>`)+experiment+skipBox+simBox+journal;
}
function bindTestnetPager(el){
 if(!el||el.dataset.tnBound)return;el.dataset.tnBound='1';
 el.addEventListener('click',e=>{const pg=e.target.closest('[data-tn-page]');if(!pg)return;setTestnetPage(tnPage+Number(pg.dataset.tnPage));if(lastTestnet)el.innerHTML=testnetClosedHTML(lastTestnet)})}

export function readinessHTML(r,positions){
 if(!r)return '';
 const pct=v=>v===null||v===undefined?'—':v+'%';
 // Open positions: the unrealized result from the position cards (venue figure when fresh), summed.
 const open=positions||[],uv=open.map(p=>p.unrealizedUSD).filter(x=>x!=null),u=uv.length?Math.round(uv.reduce((a,b)=>a+b,0)*100)/100:null;
 const total=Math.round(((r.netUSD||0)+(u||0))*100)/100,money=v=>`${v>=0?'+':'−'}$${Math.abs(v).toFixed(2)}`,cls=v=>v>0?'paper-profit':v<0?'paper-loss':'';
 const hold=h=>h==null?'—':h<24?h.toFixed(1)+'시간':(h/24).toFixed(1)+'일';
 // Figures the checklist below already shows (trades, net, drawdown, days) appear there only (user 2026-11-18).
 const has=k=>(r.checks||[]).some(c=>c.key===k);
 return `<div class="readiness-head"><b>${r.ready?'✅ 실매매 전환 기준 충족':'실매매 전환 점검'}</b><small>${r.ready?'실제 돈 전환은 설정 파일을 직접 바꿔야 합니다 · 작은 금액부터':'테스트넷 결과로 매일 자동 점검 · 기준을 모두 채우면 텔레그램으로 알려 드립니다'}</small></div>
 <div class="readiness-stats">${has('trades')?'':`<span>거래<b>${esc(r.settled)}건</b></span>`}<span>승률<b>${pct(r.winRatePct)}</b></span>${has('net')?'':`<span>실현 누적<b class="${cls(r.netUSD)}">${money(r.netUSD)}</b></span>`}<span>미실현 합계<b class="${cls(u)}">${u==null?'—':money(u)}</b><small>진행 중 ${open.length}건</small></span><span>실현+미실현<b class="${cls(total)}">${money(total)}</b></span>${has('drawdown')?'':`<span>최대 손실 구간<b>${pct(r.drawdownPct)}</b></span>`}<span>평균 보유<b>${hold(r.avgHoldHours)}</b><small>진행 중 평균 ${hold(r.openAvgHoldHours)}</small></span>${has('days')?'':`<span>운영<b>${esc(r.days)}일</b></span>`}</div>
 <ul class="readiness-checks" aria-label="전환 기준 ${r.checks.filter(c=>c.ok).length}/${r.checks.length} 충족">${r.checks.map(c=>`<li class="${c.ok?'ok':'todo'}"><i>${c.ok?'✓':'○'}</i><span>${esc(c.label)}</span><b>${esc(c.value)}</b></li>`).join('')}</ul>
 ${r.serious?.length?`<p class="live-warn-text">주문 문제: ${r.serious.map(s=>esc(s.symbol+' '+(SERIOUS_KO[s.type]||s.type))).join(', ')}</p>`:''}`;
}

let copyActionBusy=false,liveActionBusy=false,liveTestBusy=false;
const liveLevelsBusy=new Set(),liveDeleteBusy=new Set(),testnetCloseBusy=new Set();

function bindCopyButtons(el){
 if(!el||el.dataset.bound)return;el.dataset.bound='1';
 const call=async(btn,path,body,busy,msgSel='[data-copy-msg]')=>{
  if(copyActionBusy)return;
  copyActionBusy=true;
  const msg=el.querySelector(msgSel)||el.querySelector('[data-copy-msg]');
  const origText=btn?.textContent;
  if(btn){btn.disabled=true;if(busy)btn.textContent=busy}
  try{const r=await fetch(path,{method:'POST',cache:'no-store',headers:{'Content-Type':'application/json'},body:JSON.stringify(body||{})}),d=await r.json().catch(()=>({}));
   if(!r.ok)throw Error(d.message||d.error||'HTTP '+r.status);
   if(msg){msg.classList.remove('err');msg.textContent=d.summary?'✓ '+d.summary:d.armed===true?'✓ 활성화됐습니다':d.armed===false?'✓ 비활성화됐습니다':'✓ 저장됨'}}
  catch(e){if(msg){msg.textContent='실패: '+e.message;msg.classList.add('err')}}
  finally{copyActionBusy=false;if(btn&&origText!=null){btn.disabled=false;btn.textContent=origText}}
  document.getElementById('liveRefresh')?.click()};
 el.addEventListener('submit',e=>{
  const safetyForm=e.target.closest('[data-real-safety-form]');
  if(safetyForm){
   e.preventDefault();
   const numv=n=>Number(safetyForm.elements.namedItem(n)?.value);
   const body={
    dailyLossLimitPct:numv('dailyLossLimitPct'),
    manualMaxLeverage:numv('manualMaxLeverage'),
    manualMaxMarginPct:numv('manualMaxMarginPct'),
   };
   return call(safetyForm.querySelector('button[type="submit"]'),'/api/real/safety',body,'저장 중…','[data-real-safety-msg]');
  }
  const trailingForm=e.target.closest('[data-real-trailing-form]');
  if(trailingForm){
   e.preventDefault();
   const ck=n=>Boolean(trailingForm.elements.namedItem(n)?.checked);
   const numv=n=>Number(trailingForm.elements.namedItem(n)?.value);
   const enabled=ck('enabled');
   if(enabled&&!lastCopy?.trailing?.enabled){
    if(!window.confirm('⚠️ 실계좌 자동 트레일링 익절을 켭니다.\n설정한 순 ROE 도달 시 50% 부분 익절·본전 스탑·고점 대비 트레일링 청산 주문이 자동으로 실행됩니다. 계속할까요?'))return;
   }
   const body={
    enabled,
    applyToManual:ck('applyToManual'),
    applyToCopy:ck('applyToCopy'),
    autoBreakeven:ck('autoBreakeven'),
    skipTradfi:ck('skipTradfi'),
    partialLockRoePct:numv('partialLockRoePct'),
    partialClosePct:numv('partialClosePct'),
    trailActivateRoePct:numv('trailActivateRoePct'),
    trailPullbackRatio:numv('trailPullbackRatio'),
    minLockRoePct:numv('minLockRoePct'),
    excludedSymbols:String(trailingForm.elements.namedItem('excludedSymbols')?.value||''),
   };
   return call(trailingForm.querySelector('button[type="submit"]'),'/api/real/trailing',body,'저장 중…','[data-real-trailing-msg]');
  }
  const alertsForm=e.target.closest('[data-account-alerts-form]');
  if(alertsForm){
   e.preventDefault();
   const ck=n=>Boolean(alertsForm.elements.namedItem(n)?.checked);
   const list=n=>String(alertsForm.elements.namedItem(n)?.value||'').split(/[,\s]+/).map(Number).filter(Number.isFinite);
   const body={
    riskAlerts:ck('riskAlerts'),roiAlerts:ck('roiAlerts'),positionSummaryAlerts:ck('positionSummaryAlerts'),
    dailyReport:ck('dailyReport'),skipAlerts:ck('skipAlerts'),remoteCommands:ck('remoteCommands'),
    positionSummaryIntervalMin:Number(alertsForm.elements.namedItem('positionSummaryIntervalMin')?.value)||5,
    marginWarnPcts:list('marginWarnPcts'),lossWarnPcts:list('lossWarnPcts'),
    profitRoiPcts:list('profitRoiPcts'),lossRoiPcts:list('lossRoiPcts'),
   };
   return call(alertsForm.querySelector('button[type="submit"]'),'/api/account/alerts',body,'저장 중…','[data-account-alerts-msg]');
  }
  const form=e.target.closest('[data-copy-controls-form]');
  if(!form)return;
  e.preventDefault();
  const val=n=>form.elements.namedItem(n)?.value;
  const body={
   traderBalanceUSD:Number(val('traderBalanceUSD')),
   maxSymbolMarginPct:Number(val('maxSymbolMarginPct')),
   maxLeverage:Number(val('maxLeverage'))||null,
   cooldownLosses:Number(val('cooldownLosses')),
   cooldownDailyLossPct:Number(val('cooldownDailyLossPct')),
   cooldownMinutes:Number(val('cooldownMinutes')),
  };
  return call(form.querySelector('button[type="submit"]'),'/api/copy/controls',body,'저장 중…','[data-copy-ctrl-msg]');
 });
 el.addEventListener('click',e=>{
  const resume=e.target.closest('[data-copy-resume]'),disarm=e.target.closest('[data-copy-disarm]'),arm=e.target.closest('[data-copy-arm]');
  // Keep fold panels open/closed across the 3 s re-render.
  if(e.target.closest('[data-fail-toggle]')){failOpen=!e.target.closest('details')?.open;}
  if(e.target.closest('[data-controls-toggle]')){controlsOpen=!e.target.closest('details')?.open;}
  if(e.target.closest('[data-alerts-toggle]')){alertsOpen=!e.target.closest('details')?.open;}
  if(e.target.closest('[data-trailing-toggle]')){trailingOpen=!e.target.closest('details')?.open;}
  if(e.target.closest('[data-safety-toggle]')){safetyOpen=!e.target.closest('details')?.open;}
  if(e.target.closest('[data-analytics-toggle]')){analyticsOpen=!e.target.closest('details')?.open;}
  const safetyPreset=e.target.closest('[data-safety-preset]');
  if(safetyPreset){
   if(!window.confirm('실계좌 권장 안전 프리셋을 일괄 적용할까요?\n· 통합 일일 손실 차단 -8%\n· 수동/카피 최대 레버리지 20배\n· 종목당·단일 증거금 한도 15%\n· 카피 3연패 또는 당일 -6% 쿨다운(2시간)'))return;
   return call(safetyPreset,'/api/real/safety',{applyPreset:true},'적용 중…','[data-real-safety-msg]');
  }
  const safetyUnlock=e.target.closest('[data-safety-unlock]');
  if(safetyUnlock){
   if(!window.confirm('오늘 일일 손실 차단을 해제할까요? 해제 시 오늘 남은 시간 동안 신규 카피·수동 진입이 다시 허용됩니다.'))return;
   return call(safetyUnlock,'/api/real/safety',{unlockToday:true},'해제 중…','[data-real-safety-msg]');
  }
  const trailBtn=e.target.closest('[data-trail-toggle]');
  if(trailBtn){
   return call(trailBtn,'/api/real/trailing',{toggleExcludeSymbol:trailBtn.dataset.trailToggle},'처리 중…','[data-real-trailing-msg]');
  }
  const anTab=e.target.closest('[data-analytics-tab]');
  if(anTab){
   setAnalyticsTab(anTab.dataset.analyticsTab);
   const box=anTab.closest('#realCopy,#liveCopy');if(box&&lastCopy)box.innerHTML=copyHTML(lastCopy);
   return;
  }
  const tradeFill=e.target.closest('[data-trade-fill]');
  if(tradeFill){
   realTradeCtrl?.prefill({symbol:tradeFill.dataset.posSymbol,leverage:tradeFill.dataset.posLev,marginMode:tradeFill.dataset.posMm});
   return;
  }
  const posAct=e.target.closest('[data-pos-action]');
  if(posAct){
   const action=posAct.dataset.posAction,symbol=posAct.dataset.posSymbol,direction=posAct.dataset.posDir,size=posAct.dataset.posSize||'';
   const lossRoePct=posAct.dataset.posSlRoe?Number(posAct.dataset.posSlRoe):null;
   const symDisp=symText(symbol),dirKo=direction==='LONG'?'롱':'숏';
   const desc=action==='CLOSE_HALF'?`${symDisp} ${dirKo} 포지션(${size})의 50%를 시장가 부분 청산합니다`
    :action==='CLOSE_ALL'?`${symDisp} ${dirKo} 포지션(${size})을 전량 시장가 청산합니다`
    :action==='SET_STOP_LOSS'?`${symDisp} ${dirKo} 포지션에 −${lossRoePct||15}% ROE 손절(STOP_MARKET)을 설정합니다`
    :`${symDisp} ${dirKo} 포지션 평균 진입가에 본전 스탑(STOP_MARKET)을 설정합니다`;
   if(!window.confirm(`⚠️ 실계좌 주문 확인\n${desc}.\n계속할까요?`))return;
   return call(posAct,'/api/real/position-action',{confirm:'REAL_POSITION_ACTION',symbol,direction,action,...(lossRoePct?{lossRoePct}:{})},'처리 중…');
  }
  const noteBtn=e.target.closest('[data-manual-note-id]');
  if(noteBtn){
   const id=noteBtn.dataset.manualNoteId,curNote=noteBtn.dataset.manualNote||'',curTags=noteBtn.dataset.manualTags||'';
   const nextNote=window.prompt('수동 거래 한 줄 메모 (비우면 삭제, 최대 200자):',curNote);
   if(nextNote===null)return;
   const nextTags=window.prompt('태그를 쉼표로 구분해 입력 (예: 추세추종, 물타기, 손절준수, 뇌동매매, 뉴스매매 · 최대 5개):',curTags);
   if(nextTags===null)return;
   const tags=nextTags.split(/[,#\s]+/).map(s=>s.trim()).filter(Boolean);
   return call(noteBtn,'/api/manual/note',{id,note:nextNote,tags},'저장 중…');
  }
  const sendPos=e.target.closest('[data-send-position-summary]');
  if(sendPos)return call(sendPos,'/api/account/alerts/position-summary',{},'발송 중…','[data-account-alerts-msg]');
  const sendRep=e.target.closest('[data-send-daily-report]');
  if(sendRep)return call(sendRep,'/api/account/alerts/daily-report',{},'발송 중…','[data-account-alerts-msg]');
  const clearCd=e.target.closest('[data-copy-clear-cooldown]');
  if(clearCd)return call(clearCd,'/api/copy/controls',{clearCooldown:true},'해제 중…');
  const szBtn=e.target.closest('[data-copy-sizing]');
  if(szBtn)return call(szBtn,'/api/copy/controls',{sizing:szBtn.dataset.copySizing},'적용 중…','[data-copy-ctrl-msg]');
  const tbBtn=e.target.closest('[data-copy-tb]');
  if(tbBtn)return call(tbBtn,'/api/copy/controls',{sizing:'BALANCE_RATIO',traderBalanceUSD:Number(tbBtn.dataset.copyTb)},'적용 중…','[data-copy-ctrl-msg]');
  const fmBtn=e.target.closest('[data-copy-filter-mode]');
  if(fmBtn)return call(fmBtn,'/api/copy/controls',{filterMode:fmBtn.dataset.copyFilterMode},'변경 중…','[data-copy-ctrl-msg]');
  const rmBtn=e.target.closest('[data-copy-sym-remove]');
  if(rmBtn){
   const key=rmBtn.dataset.copySymKind==='allowed'?'removeAllowed':'removeBlocked';
   return call(rmBtn,'/api/copy/controls',{[key]:rmBtn.dataset.copySymRemove},'…','[data-copy-ctrl-msg]');
  }
  const addBtn=e.target.closest('[data-copy-sym-add]');
  if(addBtn){
   const input=el.querySelector('[data-copy-sym-input]');
   const raw=input?.value?.trim();if(!raw)return;
   const key=addBtn.dataset.copySymAdd==='allowed'?'addAllowed':'addBlocked';
   return call(addBtn,'/api/copy/controls',{[key]:raw},'추가 중…','[data-copy-ctrl-msg]');
  }
  const fp=e.target.closest('[data-copy-fail-page]');
  if(fp){setCopyFailPage(failPage+Number(fp.dataset.copyFailPage));const box=fp.closest('#realCopy,#liveCopy');if(box&&lastCopy)box.innerHTML=copyHTML(lastCopy);return}
  const cm=e.target.closest('[data-cal-month]');
  if(cm){
   const cur=cm.closest('.pnl-cal')?.querySelector('[data-cal-ym]')?.dataset.calYm;
   if(cur){const next=ymShift(cur,Number(cm.dataset.calMonth));setCalMonth(next>=kstDate(Date.now()).slice(0,7)?null:next)}
   const box=cm.closest('#realCopy,#liveCopy');if(box&&lastCopy)box.innerHTML=copyHTML(lastCopy);
   return;
  }
  const pg=e.target.closest('[data-copy-page]');
  if(pg){setCopyPage(copyPage+Number(pg.dataset.copyPage));const box=pg.closest('#realCopy,#liveCopy');if(box&&lastCopy)box.innerHTML=copyHTML(lastCopy);pg.blur?.();return}
  if(resume)return call(resume,'/api/copy/resume',{confirm:'COPY_RESUME'},'다시 시작하는 중…');
  if(disarm)return call(disarm,'/api/copy/disarm',null,'끄는 중…');
  if(arm&&window.confirm('실계좌(실제 돈)로 카피 매매를 켭니다. 손절 없이 트레이더 청산만 따라가며, 카피 전체 손실이 잔고의 50%에 닿으면 모두 청산합니다. 켤까요?'))return call(arm,'/api/copy/arm',{confirm:'COPY_ARM'},'켜는 중…')})}

let testnetBudgetAt=0,testnetBudgetPolling=false;
function renderTestnetBudget(el,t){
 if(!el||t?.budget?.at<testnetBudgetAt)return;
 testnetBudgetAt=t?.budget?.at??0;testnetBudgetPolling=t?.budget?.accountEquityUSD!==undefined;
 el.hidden=!t;if(t)el.innerHTML=testnetBudgetHTML(t);
}
function render(o){
 const $=id=>document.getElementById(id),m=modeInfo(o.mode),tn=o.testnet||null,scalpOnly=tn?.scalpOnly===true;
 if($('liveModeDetails'))$('liveModeDetails').hidden=Boolean(tn);
 if($('liveReadiness')){$('liveReadiness').hidden=scalpOnly||!o.readiness;$('liveReadiness').innerHTML=scalpOnly?'':readinessHTML(o.readiness,(o.positions||[]).map(p=>({symbol:p.symbol,direction:p.direction,unrealizedUSD:p.unrealized?.usd??null})))}
 for(const [id,text] of [['liveHeading',m.title],['navLiveLabel',o.mode==='LIVE'?'실매매':scalpOnly?'테스트넷 단타':'테스트넷']])if($(id))$(id).textContent=text;
 if($('navLiveMode'))$('navLiveMode').textContent=m.badge;
 // One testnet switch (signal + scalp, user 2026-11-17): the page shows the combined state; LIVE keeps the signal's own.
 const on=tn?tn.armed===true:Boolean(o.armed&&o.mode!=='OFF'),some=tn?Boolean(tn.armed||tn.partial):on,canArm=tn?Boolean(tn.signal||tn.scalp):o.mode!=='OFF';
 if($('liveModeBadge'))$('liveModeBadge').innerHTML=modeBadgeHTML(tn?{...o,mode:o.mode==='OFF'&&tn.scalp?'TESTNET':o.mode,armed:on}:o);
 renderTestnetBudget($('testnetBudget'),tn);
 const budgetEdit=$('testnetBudgetEdit'),budgetForm=$('testnetBudgetForm');
 if(budgetEdit&&budgetForm){
  budgetEdit.hidden=!tn?.budget||!canArm;
  if(tn?.budget&&!budgetEdit.open){
   for(const key of ['dailyLossPct','marginCapPct'])budgetForm.elements.namedItem(key).value=tn.budget[key]??'';
   const capEl=budgetForm.elements.namedItem('capitalCapUSD');
   if(capEl)capEl.value=tn.budget.capitalCapUSD??0;
  }
 }
 const scanEl=$('scalpScanStatus');
 if(scanEl){const scanHtml=tn&&o.scalp?scalpScanStatusHTML(o.scalp):'';scanEl.hidden=!scanHtml;if(scanHtml)scanEl.innerHTML=scanHtml}
 const status=$('liveStatus'),rows=liveRows(o),kv=([k,v])=>{const row=document.createElement('div'),dt=document.createElement('span'),dd=document.createElement('b');
  row.className='kv-row';dt.textContent=k;dd.textContent=v;row.append(dt,dd);return row};
 // Account facts stay visible; the rules sit behind "규칙 보기".
 if(status){status.replaceChildren(...rows.filter(([k])=>!LIVE_RULE_KEYS.includes(k)).map(kv));status.classList.toggle('warn',Boolean(o.killSwitch||o.mode==='LIVE'))}
 if($('liveRules'))$('liveRules').replaceChildren(...rows.filter(([k])=>LIVE_RULE_KEYS.includes(k)).map(kv));
 if($('liveTest')){$('liveTest').hidden=o.mode!=='TESTNET'||scalpOnly;$('liveTest').disabled=liveTestBusy}
 if($('liveSignalDescription'))$('liveSignalDescription').hidden=scalpOnly;
 if($('livePaperExplain'))$('livePaperExplain').hidden=scalpOnly||!o.paperTrading;
 // The button for the current state is shown as selected and cannot be pressed again.
 if($('liveArm')){$('liveArm').disabled=liveActionBusy||on||!canArm;$('liveArm').textContent=on?'● 활성화됨':'활성화';$('liveArm').classList.toggle('is-current',on)}
 if($('liveDisarm')){$('liveDisarm').disabled=liveActionBusy||!some;$('liveDisarm').textContent=some?'비활성화':'○ 비활성';$('liveDisarm').classList.toggle('is-current',!some)}
 if($('liveKill'))$('liveKill').disabled=liveActionBusy;
 if($('liveResetKill'))$('liveResetKill').disabled=liveActionBusy;
 if($('livePaperNote'))$('livePaperNote').hidden=!o.paperTrading;
 const box=$('livePositions');
 if(box&&!liveLevelsBusy.size){
  // Keep an open stop/TP editor (and what was typed) across the periodic refresh.
  const drafts=new Map();box.querySelectorAll('[data-live-levels-key]').forEach(d=>{if(d.open){const v={};d.querySelectorAll('input').forEach(i=>{v[i.name]=i.value});drafts.set(d.dataset.liveLevelsKey,v)}});
  // Testnet: the signal strategy's cards (badge 신호, stop/TP editor) and the scalp's (badge 단타) in one list.
  const scalpOpen=tn?(o.scalp?.positions||[]):[],signalCards=(o.positions||[]).map(p=>positionCardHTML(p,tn?{badge:scalpOnly?'<span class="vp-badge">기존 신호</span>':TN_BADGE.signal,allowClose:true}:{}));
  const scalpCards=scalpOpen.map(p=>scalpPositionCardHTML(p,{allowClose:true,budget:tn?.budget??null})),cards=scalpOnly?[...scalpCards,...signalCards]:[...signalCards,...scalpCards];
  box.innerHTML=cards.length?cards.join(''):`<p class="empty-small">${o.mode==='OFF'&&!tn?.scalp?'실매매가 꺼져 있습니다.':on||some?`보유 중인 포지션이 없습니다. ${scalpOnly?'단타':'신호·단타'} 진입을 기다리는 중입니다.`:'보유 중인 포지션이 없습니다. “활성화”를 눌러야 주문이 나갑니다.'}</p>`;
  box.querySelectorAll('[data-live-levels-key]').forEach(d=>{const v=drafts.get(d.dataset.liveLevelsKey);if(!v)return;d.open=true;d.querySelectorAll('input').forEach(i=>{if(!i.disabled&&v[i.name]!==undefined)i.value=v[i.name]})});
 }
 const nSig=o.positions?.length||0,nSc=tn?(o.scalp?.positions||[]).length:0;
 if($('livePositionCount'))$('livePositionCount').textContent=tn?(scalpOnly?`단타 ${nSc}개${nSig?` · 기존 신호 ${nSig}개`:''}`:`${nSig+nSc}개 · 신호 ${nSig} · 단타 ${nSc}`):`${nSig}개`;
 const pnlSummary=$('liveSummary'),testnetSummary=$('testnetSummary'),testnetSummarySection=$('testnetSummarySection');
 if(pnlSummary){pnlSummary.hidden=Boolean(tn);if(!tn)pnlSummary.innerHTML=summaryHTML(o.summary)}
 if(testnetSummarySection)testnetSummarySection.hidden=!tn;
 if(tn&&testnetSummary){
  const signal=(o.positions||[]).filter(p=>p.mode==='TESTNET'&&p.test!==true&&(p.status==='OPEN'||p.quantity?.source==='EXCHANGE'));
  const scalp=(o.scalp?.positions||[]).filter(p=>p.size>0);
  const open=[...signal.map(p=>p.unrealized),...scalp.map(p=>{
   const u=p.details?p.details.unrealized:fin(p.unrealized)?{usd:p.unrealized,source:'ESTIMATE'}:null;
   if(!u||!fin(u.usd))return u;
   const sc=tnScaleOf(p,tn.budget);
   return sc<1?{...u,usd:Number(u.usd)*sc}:u;
  })];
  testnetSummary.innerHTML=testnetSummaryHTML(tn.stats,{scalpOnly,open,budget:tn.budget});
 }
 // Real-money copy has its own page (실계좌); the testnet page keeps only testnet copies.
 const copy=o.copy,real=copy?.mode==='LIVE';
 for(const id of ['liveCopy','realCopy'])bindCopyButtons($(id));
 if(!realTradeCtrl&&$('realTradePanel'))realTradeCtrl=createRealTradeController($('realTradePanel'),{onOrderDone:()=>$('liveRefresh')?.click()});
 realTradeCtrl?.syncContext({visible:real,availableUSD:copy?.funds?.available??null,equityUSD:copy?.funds?.equity??null,heldPositions:copy?.venuePositions??[],safety:copy?.safety??null});
 if($('liveCopySection')){$('liveCopySection').hidden=!copy||real||scalpOnly;if(copy&&!real&&!scalpOnly&&$('liveCopy')&&!copyActionBusy)$('liveCopy').innerHTML=copyHTML({...copy,followArmed:Boolean(o.armed&&!o.killSwitch)})}
 if($('realCopy')&&!copyActionBusy)$('realCopy').innerHTML=real?copyHTML(copy):'<p class="empty-small">실계좌 카피가 설정되어 있지 않습니다. 서버 <code>.env</code>에 <code>COPY_MODE=LIVE</code>와 확인 문구를 직접 넣어야 이 화면에서 켤 수 있습니다.</p>';
 // The sidebar ON / OFF is a navigation hint; the page itself shows the state once, next to its button.
 if($('navRealMode'))$('navRealMode').textContent=!real?'—':copy.armed&&!copy.killed?'ON':'OFF';
 // Testnet: the scalp's own details (rules, skips, journal), collapsed; its switch is the one testnet switch above.
 // Signal strategy not on the testnet (LIVE): the scalp keeps its own panel and buttons as before (review M3).
 if($('liveScalpSection')){$('liveScalpSection').hidden=!(tn&&o.scalp);if(tn&&o.scalp&&$('liveScalp')&&!$('liveScalp').contains(document.activeElement))$('liveScalp').innerHTML=scalpDetailsHTML(o.scalp)}
 bindScalpButtons($('liveScalpOwn'));
 if($('liveScalpPanel')){$('liveScalpPanel').hidden=Boolean(tn)||!o.scalp;if(!tn&&o.scalp&&$('liveScalpOwn')&&!scalpActionBusy)$('liveScalpOwn').innerHTML=scalpHTML(o.scalp)}
 const closedBox=$('liveClosed');
 if(closedBox&&!liveDeleteBusy.size){closedBox.classList.toggle('tn-closed',Boolean(tn));
  if(tn){bindTestnetPager(closedBox);closedBox.innerHTML=testnetClosedHTML(o)}
  else closedBox.innerHTML=o.closed?.length?o.closed.map(closedCardHTML).join(''):'<p class="empty-small">아직 종료된 실매매 거래가 없습니다.</p>'}
 for(const [id,markup] of [['liveSkipped',()=>skippedHTML(o.skipped)],['liveRecords',()=>recordsRows(o.records)]]){
  const panel=$(id);if(!panel)continue;
  panel.closest('details')?.toggleAttribute('hidden',scalpOnly);panel.innerHTML=scalpOnly?'':markup();
 }
 if($('liveUpdated'))$('liveUpdated').textContent=`${clock(o.at)} 갱신`;
}

if(typeof document!=='undefined'&&document.getElementById('liveControl')){
 const $=id=>document.getElementById(id);
 let mode='OFF',loadPending=null;
 const fail=e=>{const s=$('liveError');if(s){s.hidden=false;s.textContent='실매매 요청 실패: '+e.message}};
 const load=()=>{
  if(loadPending)return loadPending;
  loadPending=(async()=>{
   const r=await fetch('/api/live/overview',{cache:'no-store',signal:AbortSignal.timeout(15000)}),d=await r.json().catch(()=>({}));
   if(!r.ok)throw Error(d.error||'HTTP '+r.status);
   mode=d.mode;if($('liveError'))$('liveError').hidden=true;render(d);return d;
  })().finally(()=>{loadPending=null});
  return loadPending;
 };
 const setLiveButtonsBusy=busy=>{for(const id of ['liveArm','liveDisarm','liveKill','liveResetKill']){const b=$(id);if(b)b.disabled=busy}};
 $('livePositions')?.addEventListener('click',async e=>{
  const button=e.target.closest?.('[data-testnet-close]');
  if(!button)return;
  const {testnetClose:key,strategy,symbol,direction}=button.dataset,id=strategy+'|'+key;
  if(testnetCloseBusy.has(id))return;
  const position=`${symbol} ${direction==='SHORT'?'숏':'롱'}`;
  if(!confirm(`테스트넷 ${position} 포지션을 시장가로 전량 청산할까요?`))return;
  const message=$('testnetCloseResult');
  const tell=(text,error=false)=>{if(message){message.hidden=false;message.classList.toggle('live-warn-text',error);message.textContent=text}};
  testnetCloseBusy.add(id);button.disabled=true;button.textContent='청산 확인 중…';tell(position+' 청산 확인 중…');
  try{
   const r=await fetch('/api/live/testnet-close',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({strategy,key,confirm:'CLOSE_TESTNET'})});
   const result=await r.json().catch(()=>({}));
   if(!r.ok||result.ok!==true)throw Error(result.error||'CLOSE_UNCONFIRMED');
   tell(position+(result.alreadyFlat?' 이미 청산됨':' 전량 청산 완료')+(result.cleanupPending?' · 남은 주문 취소 확인 필요':''),result.cleanupPending);
  }catch(error){
   const reason={SYMBOL_BUSY:'주문 처리 중입니다. 잠시 후 다시 시도하세요',POSITION_NOT_FOUND:'이미 종료된 포지션입니다',
    ADD_CANCEL_UNCONFIRMED:'대기 추매 주문의 취소를 확인하지 못했습니다',CLOSE_UNCONFIRMED:'거래소 잔량이 0인지 확인하지 못했습니다',
    POSITION_MODE_CHANGED:'거래소 포지션 모드가 변경됐습니다',POSITION_SIDE_MISMATCH:'거래소 포지션 방향이 달라졌습니다'}[error.message];
   tell(`${position} · ${reason||'청산 결과 확인 필요 ('+error.message+')'}`,true);
  }finally{
   testnetCloseBusy.delete(id);button.disabled=false;button.textContent='전량 청산';
   await load().catch(()=>{});
  }
 });
 const post=async(path,body,{lockLive=true}={})=>{
  if(lockLive){if(liveActionBusy)return;liveActionBusy=true;setLiveButtonsBusy(true)}
  try{
   const r=await fetch(path,{method:'POST',cache:'no-store',headers:{'Content-Type':'application/json'},body:JSON.stringify(body||{})}),d=await r.json().catch(()=>({}));
   if(!r.ok)throw Error(d.error||(d.reasons||[]).join(', ')||'HTTP '+r.status);
   if(lockLive)liveActionBusy=false;
   await load();return d;
  }finally{if(lockLive){liveActionBusy=false;load().catch(()=>{})}}
 };
 $('liveRefresh')?.addEventListener('click',()=>load().catch(fail));
 $('liveArm')?.addEventListener('click',()=>{
  if(liveActionBusy)return;
  const text=mode==='LIVE'?'실거래(실제 돈)를 활성화합니다. 다음 최종 신호부터 거래소에 실제 돈으로 주문이 나갑니다. 계속할까요?':'테스트넷(모의 자금)의 신호 전략과 되돌림 단타를 함께 활성화합니다. 다음 최종 신호·5분봉 단타 신호부터 BingX 테스트넷에 주문이 나갑니다(하루 손실 한도는 둘이 공동). 계속할까요?';
  if(confirm(text))post('/api/live/arm',{confirm:'ARM'}).catch(fail)});
 $('liveDisarm')?.addEventListener('click',()=>{if(!liveActionBusy)post('/api/live/disarm').catch(fail)});
 $('testnetBudget')?.addEventListener('click',async e=>{
  const btn=e.target.closest?.('[data-testnet-clear-stop]');
  if(!btn||btn.disabled)return;
  if(!confirm('오늘 테스트넷 하루 손실 정지를 해제하고 5분봉 단타 스캔을 즉시 재개할까요?'))return;
  btn.disabled=true;btn.textContent='해제 중…';
  try{await post('/api/live/testnet-budget',{clearStop:true},{lockLive:false})}
  catch(err){fail(err)}
  finally{btn.disabled=false}
 });
 $('testnetResetPnl')?.addEventListener('click',async e=>{
  const btn=e.currentTarget;
  if(!btn||btn.disabled)return;
  if(!confirm('테스트넷 누적 실현 손익(종료 거래 기록)과 오늘 하루 손실 정지를 초기화할까요?\n\n보유 중인 포지션과 실계좌 기록은 그대로 유지되며, 5분봉 단타 스캔이 즉시 정상 재개됩니다.'))return;
  const label=btn.textContent;
  btn.disabled=true;btn.textContent='초기화 중…';
  try{await post('/api/live/testnet-reset-pnl',{confirm:'RESET_TESTNET_PNL'},{lockLive:false})}
  catch(err){fail(err)}
  finally{btn.disabled=false;btn.textContent=label}
 });
 $('testnetBudgetForm')?.addEventListener('submit',async e=>{
  e.preventDefault();const form=e.currentTarget,btn=form.querySelector('button'),msg=$('testnetBudgetMessage');
  if(btn.disabled)return;
  btn.disabled=true;msg.textContent='저장 중…';
  try{
   const capEl=form.elements.namedItem('capitalCapUSD');
   const capRaw=capEl&&capEl.value!==''?capEl.valueAsNumber:undefined;
   const payload={
    dailyLossPct:form.elements.namedItem('dailyLossPct').valueAsNumber,
    marginCapPct:form.elements.namedItem('marginCapPct').valueAsNumber,
    ...(capRaw!==undefined&&Number.isFinite(capRaw)?{capitalCapUSD:capRaw}:{}),
   };
   const {budget}=await post('/api/live/testnet-budget',payload,{lockLive:false});
   msg.textContent=budget.stopped?'저장됨 · 오늘 거래 정지 상태':'저장됨';
  }catch(err){msg.textContent=err.message==='INVALID_TESTNET_BUDGET'?'하루 손실 1~100%, 증거금 1~100%, 기준 자본 $100 이상(0=전체)을 입력하세요.':'공동 한도 변경 결과를 확인하지 못했습니다.'}
  finally{btn.disabled=false}
 });
 $('liveKill')?.addEventListener('click',()=>{if(!liveActionBusy)post('/api/live/kill').catch(fail)});
 $('liveResetKill')?.addEventListener('click',()=>{if(!liveActionBusy&&confirm('긴급 정지를 해제합니다. 거래소 계정 상태를 먼저 확인하셨나요?'))post('/api/live/reset-kill',{confirm:'RESET'}).catch(fail)});
 $('liveTest')?.addEventListener('click',async()=>{
  if(liveTestBusy)return;
  if(!confirm('BingX 테스트넷에서 DOGE 소액 롱(잔고 최대 $400 기준, 10배)을 실제 신호와 같은 순서로 주문하고 5초 뒤 청산합니다. 먼저 "활성화"가 되어 있어야 합니다. 진행할까요?'))return;
  const s=$('liveTestResult'),btn=$('liveTest');if(!s)return;
  liveTestBusy=true;if(btn)btn.disabled=true;
  s.hidden=false;s.textContent='시험 주문 진행 중… (10~20초)';
  try{const r=await fetch('/api/live/test-order',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({confirm:'TEST'})}),d=await r.json().catch(()=>({}));
   if(!r.ok){s.textContent='시험 주문 불가: '+(d.error||'HTTP '+r.status);return}
   const head=d.ok?'시험 주문 성공: 진입 → 보호 주문 → 청산까지 정상':'시험 주문 결과: '+(d.status||'')+' '+(d.reasons||[]).join(', ');
   s.replaceChildren(Object.assign(document.createElement('b'),{textContent:head}),...(d.events||[]).map(e=>Object.assign(document.createElement('div'),{textContent:`· ${e.type}${e.reason?' — '+e.reason:''}`})));
  }catch(e){s.textContent='시험 주문 요청 실패: '+e.message}
  finally{liveTestBusy=false;if(btn)btn.disabled=false;await load().catch(()=>{})}
 });
const DELETE_REASONS={ACTIVE:'보유 중이거나 확인이 필요한 거래는 삭제할 수 없습니다',TODAY_COUNTS_FOR_DAILY_RISK:'오늘 종료된 거래는 하루 손실 한도 계산에 쓰여 내일부터 삭제할 수 있습니다',NOT_FOUND:'이미 삭제된 기록입니다',SAFETY_RECORD:'긴급 정지를 일으킨 기록이라 남겨 둡니다'};
 document.addEventListener('click',async e=>{
  if(e.target.closest?.('[data-scalp-sim-toggle]')){scalpSimOpen=!e.target.closest('details')?.open;return}
  const b=e.target.closest?.('[data-live-delete]');if(!b)return;
  const key=b.dataset.liveDelete;if(!key||liveDeleteBusy.has(key))return;
  if(!confirm('이 기록을 삭제합니다. 되돌릴 수 없습니다. 계속할까요?'))return;
  liveDeleteBusy.add(key);b.disabled=true;
  try{const r=await fetch('/api/live/delete',{method:'POST',cache:'no-store',headers:{'Content-Type':'application/json'},body:JSON.stringify({key})}),d=await r.json().catch(()=>({}));
   if(!r.ok)throw Error(DELETE_REASONS[d.reason]||d.reason||'HTTP '+r.status)}catch(err){fail(err)}
  finally{liveDeleteBusy.delete(key);await load().catch(()=>{})}
 });
 document.addEventListener('submit',async e=>{
  const simForm=e.target.closest?.('form[data-scalp-sim-form]');
  if(simForm){
   e.preventDefault();
   const btn=simForm.querySelector('button[type="submit"]'),out=simForm.closest('details')?.querySelector('[data-scalp-sim-out]');
   const val=n=>simForm.elements.namedItem(n)?.value??'';
   const p={days:val('days')||'7',minMovePct:val('minMovePct')||'5',trendMode:val('trendMode')||'off',zoneSignals:val('zoneSignals')||'true',minNetRR:val('minNetRR')||'0',sides:val('sides')||'LONG,SHORT'};
   scalpSimCustomized=true;
   lastScalpSimParams={days:Number(p.days)||7,minMovePct:Number(p.minMovePct)||5,trendMode:p.trendMode,zoneSignals:p.zoneSignals!=='false',minNetRR:Number(p.minNetRR)||0,sides:p.sides};
   if(btn){btn.disabled=true;btn.textContent='계산 중…'}
   if(out)out.innerHTML='<p class="empty-small">최근 신호와 거래 기록을 분석하는 중…</p>';
   try{
    const r=await fetch('/api/scalp/simulate?'+new URLSearchParams(p).toString(),{cache:'no-store',signal:AbortSignal.timeout(15000)}),d=await r.json().catch(()=>({}));
    if(!r.ok)throw Error(d.message||d.error||'HTTP '+r.status);
    lastScalpSim=d;
    if(out)out.innerHTML=scalpSimResultHTML(d);
   }catch(err){if(out)out.innerHTML=`<p class="live-warn-text">시뮬레이션 실패: ${esc(err.message)}</p>`}
   finally{if(btn){btn.disabled=false;btn.textContent='시뮬레이션 실행'}}
   return;
  }
  const form=e.target.closest?.('form[data-live-levels]');if(!form)return;e.preventDefault();
  const key=form.dataset.liveLevels;if(!key||liveLevelsBusy.has(key))return;
  const msg=form.querySelector('[data-levels-msg]'),button=form.querySelector('button'),val=n=>{const i=form.querySelector(`input[name="${n}"]`);return i&&!i.disabled&&i.value.trim()!==''?Number(i.value.trim()):null};
  if(!confirm('거래소의 손절·목표 주문을 바꿉니다. 계속할까요?'))return;
  liveLevelsBusy.add(key);button.disabled=true;msg.textContent='거래소 주문 변경 중…';
  try{const r=await fetch('/api/live/levels',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({key,stop:val('stop'),targets:[val('tp0'),val('tp1'),val('tp2')]})}),d=await r.json().catch(()=>({}));
   if(!r.ok||d.ok===false){msg.textContent='변경 안 됨: '+(d.reasons||[d.error]).filter(Boolean).map(levelReason).join(' · ');return}
   msg.textContent=d.changed===false?'바뀐 값이 없습니다':'적용됨'+(d.errors?.length?' (일부 실패: '+d.errors.join(', ')+')':'');
   form.closest('details').open=false;
  }catch(err){msg.textContent='요청 실패: '+err.message}
  finally{liveLevelsBusy.delete(key);button.disabled=false;await load().catch(()=>{})}
 });
 // The 실계좌 page (#real) shows the same data (user 2026-11-16: its positions did not refresh, only #live counted).
 const visible=()=>['live','real'].some(id=>$(id)&&!$(id).hidden);
 const tick=()=>{if(visible())load().catch(fail)};
 setInterval(tick,10000);setTimeout(()=>load().catch(fail),400);
 let budgetBusy=false;
 const refreshBudget=async()=>{
  if(!testnetBudgetPolling||$('live')?.hidden||document.hidden||budgetBusy)return;
  budgetBusy=true;
  try{const r=await fetch('/api/live/testnet-budget',{cache:'no-store',signal:AbortSignal.timeout(12000)});if(r.ok)renderTestnetBudget($('testnetBudget'),await r.json())}
  catch{}finally{budgetBusy=false}
 };
 setInterval(refreshBudget,3000);
 document.addEventListener('visibilitychange',refreshBudget);
 // 실계좌 page: the copy panel alone every 3 s (prices cached 3 s on the server, balance 15 s), while visible.
 let fastBusy=false;
 setInterval(async()=>{const el=$('realCopy');if(!el||$('real')?.hidden||document.hidden||fastBusy||copyActionBusy)return;fastBusy=true;
  try{const r=await fetch('/api/copy',{cache:'no-store',signal:AbortSignal.timeout(12000)});if(r.ok){const c=await r.json().catch(()=>null);if(c?.mode==='LIVE'){realTradeCtrl?.syncContext({visible:true,availableUSD:c.funds?.available??null,heldPositions:c.venuePositions??[]});if(!copyActionBusy&&!el.contains(document.activeElement))el.innerHTML=copyHTML(c)}}}catch{}finally{fastBusy=false}},3000);
 window.addEventListener('hashchange',()=>setTimeout(()=>{tick();void refreshBudget()},60));
}
