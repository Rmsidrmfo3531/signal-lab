// Telegram / screen notices for the copy-trading ledger (copy_executor.mjs events).
const SIDE={LONG:'롱',SHORT:'숏'};
const LIVE_SIDE={LONG:'🟢 롱',SHORT:'🔴 숏'};
const money=v=>{const n=Number(v);return v==null||!Number.isFinite(n)?'—':`${n>=0?'+':'−'}$${Math.abs(n).toFixed(2)}`};
const REASON={MARGIN_SHORT:'여유 증거금 부족',SYMBOL_HELD_BY_SIGNAL_STRATEGY:'같은 종목을 신호 전략이 보유 중',OPPOSITE_COPY_OPEN:'같은 종목 반대 방향 보유 중',
 COPY_ORDERS_UNREADABLE:'거래소 미체결 주문 조회 실패',COPY_OPEN_ORDERS_EXIST:'거래소에 같은 종목의 미체결 주문이 있음',
 COPY_AUDIT_UNAVAILABLE:'카피 주문 감사 상태 미확인',COPY_AUDIT_BLOCKED:'카피 주문 감사 불일치로 차단됨',
 MONITOR_RESTART_SNAPSHOT:'채널 모니터 재시작 직후의 기존 포지션 재알림',LIVE_DISARMED:'실매매 비활성 상태',COPY_DISARMED:'카피 비활성 상태',ENTRY_INTERRUPTED:'주문 준비 중 거래가 정지됨',UPDATING:'업데이트 중',KILL_SWITCH:'긴급 정지 중',NOT_TESTNET:'테스트넷이 아님',
 NO_BINGX_CONTRACT:'BingX에 없는 종목',TRADER_CLOSE:'트레이더 청산',STOP_OR_EXTERNAL:'보호 손절 또는 외부 청산',POSITION_GONE:'거래소에 포지션 없음',COPY_OFF:'카피 매매 꺼짐',BINGX_HEDGE_MODE:'BingX 양방향(헤지) 모드라 건너뜀 — 이전 버전 기록(지금은 헤지 모드도 지원)',BINGX_POSITION_MODE_UNKNOWN:'BingX 포지션 모드(단방향/헤지) 확인 실패',VENUE_POSITION_EXISTS:'거래소에 같은 코인 포지션이 이미 있음(수동 매매 등) — 합쳐지지 않게 건너뜀',PRICE_MISMATCH:'거래소 가격이 알림 가격과 10% 넘게 다름(다른 상품일 수 있음)',PRICE_UNVERIFIED:'거래소 가격 확인 실패(이름이 다른 종목)',ZONE_BREAK_VOLUME:'매물대 거래량 동반 이탈 손절',COPY_MAX_ADDS:'추매 최대 횟수 도달',TRADER_QUANTITY_MISSING:'트레이더 수량이 없는 알림',NO_BALANCE:'잔고 조회 실패',NO_STOP:'보호 손절을 걸지 못해 청산',LOSS_CAP_REACHED:'손실 한도 도달로 청산',COPY_LOSS_LIMIT:'카피 손실 한도',COPY_MARGIN_CAP:'카피 전체 증거금 한도',MIN_ORDER_TOO_LARGE:'거래소 최소 주문 증거금이 한도 초과',QUANTITY_UNIT_UNCLEAR:'수량 단위(코인/계약) 불일치',QUANTITY_INVALID:'유효하지 않은 주문 수량',STALE_MESSAGE:'이전 시점의 지연 알림',TRADER_REDUCE_BELOW_MIN:'트레이더 축소 수량이 최소 단위 미만',ADD_BELOW_MIN_QTY:'추매 수량이 최소 단위 미만',DUPLICATE_ADD_WINDOW:'중복 추매 알림',TRADER_SIZE_UNTRACKED:'트레이더 기준 수량 미확인',MAX_OPEN_COPIES:'카피 최대 보유 종목 수 도달',DAILY_LOSS_LIMIT:'일일 손실 한도 도달',OPEN_RISK_LIMIT:'열린 위험 한도 도달',MARGIN_CAP:'전체 증거금 한도 도달',PROVISIONAL_LOSS_UNSETTLED:'미정산 손익 확인 대기 중',TRADER_CUT_ALL:'트레이더 전량 축소',CLOSING:'청산 중인 포지션',OUR_COPY_CLOSED:'우리가 먼저 정리한 포지션(손실 한도·보호 손절 등) — 트레이더 청산 뒤에 다시 따라감',LIQUIDATION:'강제청산',ADL:'자동 감축(ADL) 청산',EXTERNAL_UNCONFIRMED:'바깥 청산인지 확인 불가로 다시 따라가지 않음'};
const why=r=>REASON[r]||r||'';
function realCopyTradeText(e){
 const action={OPENED:e.refollow?'다시 진입':e.late?'늦은 진입':'신규 진입',ADDED:'추매',REDUCED:'일부 청산',CLOSED:'전량 청산'}[e.type];
 if(!action)return null;
 const head=[`카피 | ${action}`,[e.symbol,LIVE_SIDE[e.direction],e.leverage>0?`${e.leverage}배`:null].filter(Boolean).join(' · ')];
 let detail;
 if(e.type==='OPENED')detail=[`수량 ${e.qty} · 평균 진입가 ${e.avg??'—'} USDT`,
  e.stop?`거래소 보호 손절 ${e.stop} USDT`:null,e.stopDistPct!=null?`매물대 기준 ${e.stopDistPct}% · 거래량 동반 이탈 시`:null];
 if(e.type==='ADDED')detail=[`${e.n}차 · 수량 +${e.qty} · 총 ${e.total}`,`평균 진입가 ${e.avg??'—'} USDT`,e.stop?`거래소 보호 손절 ${e.stop} USDT`:null];
 if(e.type==='REDUCED')detail=[`수량 −${e.qty} · 잔여 ${e.left}`];
 if(e.type==='CLOSED')detail=[why(e.reason),
  e.evidence==='MANUAL_CLOSE'?'수동 청산 확인':e.evidence==='UNCONFIRMED'?'청산 경로 확인 불가':null,
  e.netUSD==null||!Number.isFinite(Number(e.netUSD))?'손익 확인 불가':`손익 ${money(e.netUSD)} (수수료 전 추정)`,
  `추매 ${e.adds||0}회${e.theirPnlUSD!=null&&Number.isFinite(Number(e.theirPnlUSD))?` · 트레이더 ${money(e.theirPnlUSD)}`:''}`];
 return [...head,...detail].filter(Boolean).join('\n');
}
/** Text for one copy event, or null when not worth a notice. */
export function copyEventText(e){
 if(!e)return null;
 if(e.mode==='LIVE'){const trade=realCopyTradeText(e);if(trade)return trade}
 const head=['📋 카피',e.symbol,e.mode==='LIVE'?LIVE_SIDE[e.direction]:null].filter(Boolean).join(' · ');
 if(e.type==='ARMED'||e.type==='DISARMED')return `📋 카피 ${e.type==='ARMED'?'활성화':'비활성화'}`;
 if(e.type==='OPENED')return `${head} ${SIDE[e.direction]||''} ${e.leverage}배 ${e.refollow?'다시 진입(우리 카피가 거래소에서 바깥 청산된 뒤 트레이더를 다시 따라감) ':e.late?'늦은 진입(진입 알림을 놓쳐 추매 시점에 들어감) ':'진입 '}${e.mode==='LIVE'?'(실계좌)':'(테스트넷)'}\n수량 ${e.qty} · 평균 ${e.avg??'—'}${e.stopDistPct!=null?` · 매물대 손절 기준 진입가에서 ${e.stopDistPct}% (거래량 동반 이탈 시)`:''}${e.stop?` · 거래소 보호 손절 ${e.stop}`:''}`;
 if(e.type==='ADDED')return `${head} 추매 ${e.n}차 ${e.mode==='LIVE'?'(실계좌)':'(테스트넷)'}\n+${e.qty} → 총 ${e.total} · 평균 ${e.avg??'—'}${e.stop?` · 보호 손절 ${e.stop}`:''}`;
 if(e.type==='REDUCED')return `${head} 일부 청산 ${e.mode==='LIVE'?'(실계좌)':'(테스트넷)'}\n−${e.qty} → 남은 ${e.left}`;
 if(e.type==='CLOSED')return `${head} 청산 ${e.mode==='LIVE'?'(실계좌)':'(테스트넷)'} · ${why(e.reason)}${e.evidence==='MANUAL_CLOSE'?' · 수동 청산 확인(트레이더 추매·진입 시 다시 따라감)':e.evidence==='UNCONFIRMED'?' · 확인 불가로 다시 따라가지 않음':''}\n손익 ${money(e.netUSD)} (수수료 전 추정)${e.theirPnlUSD!=null&&Number.isFinite(Number(e.theirPnlUSD))?` · 트레이더 ${money(e.theirPnlUSD)}`:''} · 추매 ${e.adds||0}회`;
 if(e.type==='ADD_SKIPPED')return `${head} 추매 건너뜀 · ${why(e.reason)}${e.need!=null&&Number.isFinite(Number(e.free))?` (필요 $${e.need} / 여유 $${Number(e.free).toFixed(2)})`:''}${e.detail?` (${e.detail})`:''}`;
 if(e.type==='SKIPPED'&&!['NOT_COPIED','COPY_OFF'].includes(e.reason))return `${head} 진입 안 함 · ${why(e.reason)}${e.detail?` (${e.detail})`:''}`;
 if(e.type==='UNCONFIRMED_ADOPT')return `⚠️ ${head} 거래소 포지션을 카피 원장에 넣지 않았습니다 (${e.reason==='ENTRY_ORDER_NOT_FOUND'?'우리 진입 주문이 거래소에 없음':'진입 체결 확인 실패'})\n거래소에 ${e.size??''} 보유 중 — 직접 확인해 주세요.`;
 if(e.type==='ERROR')return `⚠️ ${head} 주문 문제 (${e.kind||''}) · ${e.reason||''}\n실매매 화면에서 확인해 주세요.`;
 if(e.type==='COPY_LOSS_LIMIT')return `⛔ 카피 손실 한도 도달${e.mode==='LIVE'?'':' (테스트넷)'}\n카피 포지션을 모두 청산하고 새 카피를 멈췄습니다. 실매매 화면의 '카피 다시 시작'으로 재개합니다.`;
 if(e.type==='STOP_NOT_SET')return `⚠️ ${head} 보호 손절을 걸지 못했습니다 (${e.reason||''}${e.detail?` · ${e.detail}`:''})${e.reason==='HTTP_429'?'\n1분 뒤 다시 겁니다.':''}`;
 return null;
}
