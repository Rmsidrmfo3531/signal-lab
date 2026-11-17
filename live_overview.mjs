import {tradeHorizon,holdTier} from './trade_horizon.mjs';
// Read-only view of the live / testnet executor for the 실매매 screen: open positions as cards,
// closed trades with their realized result, a summary and the recent skip reasons in Korean.
// Pure functions: no network, no keys, no order changes. Numbers the venue did not give are
// either marked as estimates (source ESTIMATE) or left empty; nothing is made up.

export const LIVE_ACTIVE_STATUSES=Object.freeze(['SUBMITTING','OPEN','UNKNOWN']);
export const LIVE_STATUS_KO=Object.freeze({SUBMITTING:'주문 접수 중',OPEN:'보유 중',UNKNOWN:'확인 필요 (거래소에서 직접 확인)',CLOSED:'종료',FAILED:'주문 실패'});
export const LIVE_REASON_KO=Object.freeze({OPEN_RISK_LIMIT:'열린 포지션 최대 손실 합계 한도',DAILY_LOSS_LIMIT:'테스트넷 하루 손실 한도 도달 (신호+단타)',TESTNET_MARGIN_CAP:'테스트넷 공동 증거금 한도 (신호+단타)',TESTNET_BUDGET_UNAVAILABLE:'공동 위험 한도 계산 실패',NO_BALANCE:'잔고 조회 실패',MARGIN_SHORT:'여유 증거금 부족',SYMBOL_HELD_BY_COPY:'카피·단타가 같은 종목 보유 중',
 LIVE_MODE_OFF:'실매매 꺼짐',LIVE_CONFIRM_MISSING:'실거래 확인 문구 없음 · 신호 전략은 실계좌 제외(테스트넷 전용)',NOT_ARMED:'활성화 안 됨',KILL_SWITCH_ON:'긴급 정지 중',
 VENUE_NOT_ENABLED_FOR_LIVE:'실매매 거래소가 아님',VENUE_ONLY_TESTNET_ONLY:'바이낸스 미상장 코인 (테스트넷 전용)',CREDENTIALS_MISSING:'API 키 없음',
 SIGNAL_NOT_READY:'신호 조건 미충족',PLAN_INCOMPLETE:'손절·목표 계획 불완전',UNRESOLVED_ORDER_STATE:'확인이 필요한 주문이 있음',
 MAX_OPEN_POSITIONS:'동시 포지션 최대',MAX_SAME_DIRECTION_POSITIONS:'같은 방향 포지션 최대',SYMBOL_ALREADY_ACTIVE:'이미 보유 중인 종목',
 QUANTITY_BELOW_MINIMUM_AT_LIVE_RISK:'최소 주문 수량 미달',GATEIO_DECIMAL_SIZE_UNVERIFIED:'Gate.io 소수 계약 미검증',DAILY_RISK_LIMIT:'하루 손실 한도 도달',
 BALANCE_UNAVAILABLE:'잔고 조회 실패',BALANCE_EMPTY:'잔고 없음',DUPLICATE_SIGNAL:'이미 주문한 신호',SYMBOL_BUSY:'주문 처리 중',SIGNAL_IN_FLIGHT:'같은 신호 처리 중',RETRY_WAIT:'재시도 대기'});
export const LIVE_CLOSE_KO=Object.freeze({POSITION_FLAT:'거래소에서 청산됨 (익절·손절)',EMERGENCY_NO_STOP:'손절 주문 실패로 긴급 청산',LATE_ADD_AFTER_FLAT:'청산 뒤 체결된 추매를 긴급 청산',TEST_CLOSE:'시험 주문 청산'});
export const LIVE_EVENT_KO=Object.freeze({
 MARGIN_SET:'교차 마진·배율 설정',LEVERAGE_CAPPED:'거래소 최대 배율로 낮춤',ENTRY_SENT:'진입 주문 체결',ENTRY_FILLED:'진입 체결',STOP_CONFIRMED:'손절 주문 확인',STOP_PLACED:'손절 주문 등록',
 STOP_WHOLE_POSITION:'전체 물량 손절 등록',PROTECTED:'손절·목표 주문 완료',ADDS_PLACED:'추매 주문 등록',ADD_FILLED:'추매 체결',ADDS_CANCELLED:'남은 추매 취소',
 STOP_TO_BREAKEVEN:'손절을 본절로 이동',BREAKEVEN_SKIPPED_STOP_ALREADY_BETTER:'손절이 이미 본절보다 유리',CLOSED:'포지션 종료',SETTLED:'거래소 정산 확인',
 MANUAL_STOP:'손절 직접 수정',MANUAL_TARGET:'목표 직접 수정',TARGET_FAILED:'목표 주문 실패',STOP_FAILED:'손절 주문 실패',EMERGENCY_CLOSED:'긴급 청산',
 RECONCILE_ERROR:'거래소 확인 오류',ENTRY_REJECTED:'진입 거절',REJECTED:'주문 거절',ENTRY_OUTCOME_UNKNOWN:'진입 결과 불명',RESTART_WHILE_SUBMITTING:'주문 중 서버 재시작',
 TEST_CLOSED:'시험 주문 청산',SETTLE_READ_FAILED:'정산 조회 실패',ERROR:'오류',ORDER_ALREADY_GONE:'거래소가 이미 정리한 주문',PROTECTION_RECOVERED:'재시작 후 손절 보호 복구',RECOVERY_NO_POSITION:'재시작 후 확인: 포지션 없음',RECOVERY_ERROR:'재시작 후 보호 복구 오류',UNPROTECTED_AFTER_RESTART:'재시작 시 손절 미확인 포지션',RESTART_WHILE_SUBMITTING:'주문 중 서버 재시작',CANCELLED_BY_EXACT_ID:'주문 취소 (정확한 번호로)',
 CANCEL_FAILED:'주문 취소 실패',TEST_CLOSE_DEFERRED:'시험 청산 대기',TEST_CLOSE_INCOMPLETE:'시험 청산 미완료',LATE_ADD_CLOSED:'청산 뒤 체결된 추매 정리',LATE_ADD_CLOSE_FAILED:'청산 뒤 추매 정리 실패'});
/** A venue / internal reason code in short Korean (VENUE_ERROR_109400 -> 거래소 오류 109400). */
export function liveCodeKo(code){
 const t=String(code??'');if(!t)return '';
 const m=/^VENUE_ERROR_(\w+)$/.exec(t);if(m)return '거래소 오류 '+m[1];
 return LIVE_REASON_KO[t]||LIVE_EVENT_KO[t]||({NETWORK_UNREACHABLE:'네트워크 연결 실패',TIMEOUT:'응답 시간 초과',POSITION_CHECK_FAILED:'포지션 확인 실패'})[t]||t;
}

const num=v=>{if(v===null||v===undefined||v==='')return null;const x=Number(v);return Number.isFinite(x)?x:null};
const pos=v=>{const x=num(v);return x!==null&&x>0?x:null};
const round=(x,d=4)=>x===null?null:Math.round(x*10**d)/10**d;
export function liveReasonKo(code){
 const text=String(code??'');
 if(text.startsWith('KILL_SWITCH:'))return '긴급 정지: '+text.slice(12);
 return LIVE_REASON_KO[text]||text;
}
const baseQty=(record,qty)=>qty===null?null:record.venueContract?.quantityUnit==='CONTRACT'?(pos(record.venueContract.contractSizeBase)?qty*Number(record.venueContract.contractSizeBase):null):qty;
const asset=symbol=>String(symbol||'').replace(/USDT$/,'');
function lastEvent(record){
 const e=record.lastEvent??record.events?.at(-1);if(!e)return null;
 return {type:e.type,label:LIVE_EVENT_KO[e.type]||e.type,reason:e.reason??null,reasonKo:e.reason?liveCodeKo(e.reason):null,at:e.at??null};
}
const FRESH_MS=90000;

/** One open (or pending / unknown) live position. price: the venue's public mid price, if fresh. */
export function livePositionView(record,{price=null,now=Date.now()}={}){
 const dir=record.direction==='LONG'?1:-1,p=record.position,fresh=p&&Number.isFinite(p.at)&&now-p.at<FRESH_MS;
 const size=p&&p.size>0?p.size:pos(record.quantity?.total),base=baseQty(record,size);
 const avg=pos(p?.entryPrice)??pos(record.firstEntryPrice),leverage=pos(record.leverage);
 const current=fresh&&pos(p.markPrice)?pos(p.markPrice):pos(price);
 const currentSource=fresh&&pos(p.markPrice)?(p.markSource||'EXCHANGE'):pos(price)?'VENUE_BOOK':null;
 let unrealized=null;
 if(fresh&&num(p.unrealizedPnLUSD)!==null)unrealized={usd:round(num(p.unrealizedPnLUSD),2),source:'EXCHANGE'};
 else if(avg&&current&&base)unrealized={usd:round(dir*(current-avg)*base,2),source:'ESTIMATE'};
 // Margin in use: the venue's figure when fresh, otherwise average entry × size / leverage (estimate).
 const marginEst=avg&&base&&leverage?avg*base/leverage:null;
 const margin=fresh&&pos(p.marginUSD)?{usd:round(pos(p.marginUSD),2),source:'EXCHANGE'}:marginEst?{usd:round(marginEst,2),source:'ESTIMATE'}:null;
 // Realized so far on this open position (partial take-profits, fees, funding), from the venue.
 const realizedOpen=fresh&&num(p.realizedPnLUSD)!==null?{usd:round(num(p.realizedPnLUSD),2),source:'EXCHANGE'}:null;
 if(unrealized){const m=margin?.usd??marginEst;unrealized.pct=m?round(unrealized.usd/m*100,2):null}
 const adds=Array.isArray(record.adds)?record.adds:[];
 const pending=adds.map((a,i)=>({n:i+1,price:pos(a.price),qty:baseQty(record,num(a.qty)),units:num(a.units)})).filter((_,i)=>adds[i].orderId&&!adds[i].filled&&!adds[i].cancelled);
 return {signalKey:record.signalKey,symbol:record.symbol,asset:asset(record.symbol),venue:record.venue,venueSymbol:record.venueSymbol,mode:record.mode,direction:record.direction,
  pattern:record.signal?.pattern??null,horizon:tradeHorizon(record.signal?.pattern),
  leverage,status:record.status,statusKo:LIVE_STATUS_KO[record.status]||record.status,createdAt:record.createdAt??null,test:record.test===true,routedFrom:record.routedFrom??null,
  plannedEntry:pos(record.plannedEntry),firstEntryPrice:pos(record.firstEntryPrice),averageEntryPrice:avg,currentPrice:current,currentPriceSource:currentSource,
  quantity:{venue:size,base:round(base,10),unit:record.quantity?.unit||'BASE_ASSET',source:p&&p.size>0?'EXCHANGE':'ORDER'},unrealized,margin,realizedOpen,
  adds:{filled:adds.filter(a=>a.filled).length,max:adds.length,pending,skipped:adds.filter(a=>a.skipped).length},
  stop:pos(record.stop),targets:Array.isArray(record.targets)?record.targets.map(pos):[],targetsFilled:{tp1:record.breakevenMoved===true},breakevenMoved:record.breakevenMoved===true,
  plannedRiskUSD:num(record.plannedRiskUSD),tickSize:record.venueContract?.tickSize??null,positionCheckedAt:p?.at??null,lastEvent:lastEvent(record)};
}

/** One closed live trade. realized.source: EXCHANGE (venue fund flow), ESTIMATE, UNKNOWN or PENDING. */
export function liveClosedView(record,now=Date.now()){
 // No settlement within 2 h of the close (older records): shown as unknown, not 'checking'.
 const r=!record.realized&&record.closedAt>0&&now-record.closedAt>2*3600000?{source:'UNKNOWN'}:record.realized,adds=Array.isArray(record.adds)?record.adds:[];
 const realized=!r?{source:'PENDING',netUSD:null}:r.source==='UNKNOWN'?{source:'UNKNOWN',netUSD:null}
  :{source:r.source,netUSD:num(r.netUSD),pnlUSD:num(r.pnlUSD),feeUSD:num(r.feeUSD),fundingUSD:num(r.fundingUSD),takerRate:num(r.takerRate)};
 return {signalKey:record.signalKey,deletable:record.deletable===true,symbol:record.symbol,asset:asset(record.symbol),venue:record.venue,mode:record.mode,direction:record.direction,
  pattern:record.signal?.pattern??null,horizon:tradeHorizon(record.signal?.pattern),leverage:pos(record.leverage),
  holdHours:record.closedAt>0&&record.createdAt>0?Math.round((record.closedAt-record.createdAt)/360000)/10:null,
  actualHorizon:record.closedAt>0&&record.createdAt>0?holdTier((record.closedAt-record.createdAt)/3600000):null,
  createdAt:record.createdAt??null,closedAt:record.closedAt??null,closeReason:record.closeReason??null,closeReasonKo:LIVE_CLOSE_KO[record.closeReason]||record.closeReason||'종료',
  firstEntryPrice:pos(record.firstEntryPrice),averageEntryPrice:pos(record.position?.entryPrice)??pos(record.firstEntryPrice),
  adds:{filled:adds.filter(a=>a.filled).length,max:adds.length},stop:pos(record.stop),targets:Array.isArray(record.targets)?record.targets.map(pos):[],
  tickSize:record.venueContract?.tickSize??null,test:record.test===true,realized};
}

/** Closed real (non-test) trades: count, wins and the summed realized result of those with a number. */
export function liveSummary(records=[],mode=null,now=Date.now()){
 // Only the current mode's trades (TESTNET and LIVE results are never mixed).
 const closed=records.filter(r=>r.status==='CLOSED'&&r.test!==true&&(!mode||r.mode===mode)).map(r=>({...r,realized:liveClosedView(r,now).realized.source==='PENDING'?null:r.realized??{source:'UNKNOWN'}}));
 const known=closed.filter(r=>r.realized&&r.realized.source!=='UNKNOWN'&&num(r.realized.netUSD)!==null);
 const wins=known.filter(r=>Number(r.realized.netUSD)>0).length;
 return {trades:closed.length,settled:known.length,wins,losses:known.length-wins,winRatePct:known.length?round(wins/known.length*100,1):null,
  netUSD:known.length?round(known.reduce((s,r)=>s+Number(r.realized.netUSD),0),2):null,
  estimated:known.filter(r=>r.realized.source==='ESTIMATE').length,pending:closed.filter(r=>!r.realized).length,unknown:closed.filter(r=>r.realized?.source==='UNKNOWN').length,
  tests:records.filter(r=>r.test===true).length};
}

/** Totals of the one testnet screen (user 2026-11-17 "합쳐서"): the signal strategy's closed trades of `mode` with a
 * known result and every scalp trade (ScalpExecutor.stats(), journal included). {all, signal, scalp}: trades, wins,
 * winRatePct, profitFactor (null without a loss), netUSD. mode null = no signal trades (signal strategy not on the testnet). */
export function testnetStats({records=[],mode='TESTNET',scalpStats=null}={}){
 const sig=mode?records.filter(r=>r.status==='CLOSED'&&r.test!==true&&r.mode===mode&&r.realized&&r.realized.source!=='UNKNOWN'&&num(r.realized.netUSD)!==null).map(r=>Number(r.realized.netUSD)):[];
 const signal={trades:sig.length,wins:sig.filter(x=>x>0).length,grossProfitUSD:sig.filter(x=>x>0).reduce((a,b)=>a+b,0),grossLossUSD:-sig.filter(x=>x<0).reduce((a,b)=>a+b,0),netUSD:sig.reduce((a,b)=>a+b,0)};
 const s=scalpStats||{},scalp={trades:Number(s.trades)||0,wins:Number(s.wins)||0,grossProfitUSD:Number(s.grossProfitUSD)||0,grossLossUSD:Number(s.grossLossUSD)||0,netUSD:Number(s.netUSD)||0};
 const done=x=>({trades:x.trades,wins:x.wins,winRatePct:x.trades?round(x.wins/x.trades*100,1):null,profitFactor:x.grossLossUSD>0?round(x.grossProfitUSD/x.grossLossUSD,2):null,netUSD:round(x.netUSD,2)});
 const all={trades:signal.trades+scalp.trades,wins:signal.wins+scalp.wins,grossProfitUSD:signal.grossProfitUSD+scalp.grossProfitUSD,grossLossUSD:signal.grossLossUSD+scalp.grossLossUSD,netUSD:signal.netUSD+scalp.netUSD};
 return {all:done(all),signal:done(signal),scalp:done(scalp)};
}

/** The whole 실매매 screen. status: LiveExecutor.status(); records: its full records. */
export function liveOverview({status,records=[],priceOf=()=>null,balance=null,paperTrading=false,now=Date.now()}){
 const active=records.filter(r=>LIVE_ACTIVE_STATUSES.includes(r.status)&&r.test!==true);
 const closed=records.filter(r=>r.status==='CLOSED').sort((a,b)=>(b.closedAt||b.createdAt||0)-(a.closedAt||a.createdAt||0)).slice(0,50);
 const price=r=>{try{return pos(priceOf(r))}catch{return null}};
 return {at:now,mode:status.mode,armed:status.armed,killSwitch:status.killSwitch,liveConfirmed:status.liveConfirmed,venues:status.venues,
  credentialsConfigured:status.credentialsConfigured,limits:status.limits,balance,paperTrading:paperTrading===true,
  positions:active.map(r=>livePositionView(r,{price:price(r),now})),closed:closed.map(r=>liveClosedView(r,now)),summary:liveSummary(records,status.mode,now),
  skipped:(status.skipped||[]).slice(0,20).map(x=>({at:x.at,symbol:x.symbol??null,venue:x.venue??null,reasons:(x.reasons||[x.reason]).filter(Boolean),
   reasonsKo:(x.reasons||[x.reason]).filter(Boolean).map(liveReasonKo)})),
  records:(status.records||[]).map(r=>({...r,statusKo:LIVE_STATUS_KO[r.status]||r.status,lastEventKo:r.lastEvent?(LIVE_EVENT_KO[r.lastEvent.type]||r.lastEvent.type)+(r.lastEvent.reason?' · '+liveCodeKo(r.lastEvent.reason):''):null}))};
}

/** Manual stop / target change on an open live position (the paper record no longer exists).
 * Checked against the current price: the stop stays on the loss side, every target not yet filled
 * on the profit side of the price and the average entry, in order. Returns only what changed
 * (NaN = unchanged), as LiveExecutor.setLevels expects. TP1 is locked once it has filled. */
export function checkLiveLevels(record,{stop=null,targets=null}={},{price=null}={}){
 const dir=record.direction==='LONG'?1:-1,reasons=[],current=pos(price),avg=pos(record.position?.entryPrice)??pos(record.firstEntryPrice);
 if(!current)return {ok:false,reasons:['PRICE_UNAVAILABLE']};
 const given=v=>v!==null&&v!==undefined&&v!=='';
 let nextStop=pos(record.stop),changedStop=NaN;
 if(given(stop)){const n=num(stop);if(!(n>0))reasons.push('STOP_INVALID');else{nextStop=n;if(n!==pos(record.stop))changedStop=n}}
 if(nextStop&&!(dir*(current-nextStop)>0))reasons.push('STOP_ALREADY_CROSSED');
 const old=Array.isArray(record.targets)?record.targets.map(pos):[null,null,null],next=[...old],changed=[NaN,NaN,NaN],filled=[record.breakevenMoved===true,false,false];
 if(given(targets)){
  if(!Array.isArray(targets)||targets.length!==3)reasons.push('TARGETS_NEED_THREE');
  else targets.forEach((v,i)=>{if(!given(v))return;const n=num(v);
   if(!(n>0)){reasons.push(`TP${i+1}_INVALID`);return}
   if(n===old[i])return;
   if(filled[i]){reasons.push(`TP${i+1}_ALREADY_FILLED`);return}
   next[i]=n;changed[i]=n});
 }
 next.forEach((t,i)=>{if(filled[i]||!t)return;
  if(!(dir*(t-current)>0))reasons.push(`TP${i+1}_NOT_BEYOND_PRICE`);
  if(avg&&!(dir*(t-avg)>0))reasons.push(`TP${i+1}_NOT_BEYOND_ENTRY`);
  if(i>0&&next[i-1]&&!filled[i-1]&&!(dir*(t-next[i-1])>0))reasons.push(`TP${i+1}_ORDER`);
 });
 if(nextStop&&next.some((t,i)=>!filled[i]&&t&&!(dir*(t-nextStop)>0)))reasons.push('STOP_BEYOND_TARGET');
 if(reasons.length)return {ok:false,reasons:[...new Set(reasons)]};
 return {ok:true,changed:Number.isFinite(changedStop)||changed.some(Number.isFinite),stop:changedStop,targets:changed};
}
