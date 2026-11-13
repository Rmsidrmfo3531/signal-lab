// Telegram / screen notices for the copy-trading ledger (copy_executor.mjs events).
const SIDE={LONG:'롱',SHORT:'숏'};
const money=v=>v==null?'—':`${v>=0?'+':'−'}$${Math.abs(v).toFixed(2)}`;
const REASON={MARGIN_SHORT:'여유 증거금 부족',SYMBOL_HELD_BY_SIGNAL_STRATEGY:'같은 종목을 신호 전략이 보유 중',OPPOSITE_COPY_OPEN:'같은 종목 반대 방향 보유 중',
 MONITOR_RESTART_SNAPSHOT:'채널 모니터 재시작 직후의 기존 포지션 재알림',LIVE_DISARMED:'실매매 비활성 상태',KILL_SWITCH:'긴급 정지 중',NOT_TESTNET:'테스트넷이 아님',
 NO_BINGX_CONTRACT:'BingX에 없는 종목',TRADER_CLOSE:'트레이더 청산',STOP_OR_EXTERNAL:'보호 손절 또는 외부 청산',POSITION_GONE:'거래소에 포지션 없음',COPY_OFF:'카피 매매 꺼짐',PRICE_MISMATCH:'거래소 가격이 알림 가격과 10% 넘게 다름(다른 상품일 수 있음)',PRICE_UNVERIFIED:'거래소 가격 확인 실패(이름이 다른 종목)',ZONE_BREAK_VOLUME:'매물대 거래량 동반 이탈 손절',COPY_MAX_ADDS:'추매 최대 횟수 도달',TRADER_QUANTITY_MISSING:'트레이더 수량이 없는 알림',NO_BALANCE:'잔고 조회 실패',NO_STOP:'보호 손절을 걸지 못해 청산',LOSS_CAP_REACHED:'손실 한도 도달로 청산',COPY_LOSS_LIMIT:'카피 손실 한도',COPY_MARGIN_CAP:'카피 전체 증거금 한도',TRADER_CUT_ALL:'트레이더 전량 축소'};
const why=r=>REASON[r]||r||'';
/** Text for one copy event, or null when not worth a notice. */
export function copyEventText(e){
 if(!e)return null;
 const head=`📋 카피${e.mode==='LIVE'?'·실계좌':''} · ${e.symbol||''}`;
 if(e.type==='ARMED'||e.type==='DISARMED')return `📋 카피 ${e.mode==='LIVE'?'실계좌 ':''}${e.type==='ARMED'?'활성화':'비활성화'}`;
 if(e.type==='OPENED')return `${head} ${SIDE[e.direction]||''} ${e.leverage}배 진입 ${e.mode==='LIVE'?'(실계좌)':'(테스트넷)'}\n수량 ${e.qty} · 평균 ${e.avg??'—'}${e.stopDistPct!=null?` · 매물대 손절 기준 진입가에서 ${e.stopDistPct}% (거래량 동반 이탈 시)`:''}${e.stop?` · 거래소 보호 손절 ${e.stop}`:''}`;
 if(e.type==='ADDED')return `${head} 추매 ${e.n}차 ${e.mode==='LIVE'?'(실계좌)':'(테스트넷)'}\n+${e.qty} → 총 ${e.total} · 평균 ${e.avg??'—'}${e.stop?` · 보호 손절 ${e.stop}`:''}`;
 if(e.type==='REDUCED')return `${head} 일부 청산 ${e.mode==='LIVE'?'(실계좌)':'(테스트넷)'}\n−${e.qty} → 남은 ${e.left}`;
 if(e.type==='CLOSED')return `${head} 청산 ${e.mode==='LIVE'?'(실계좌)':'(테스트넷)'} · ${why(e.reason)}\n손익 ${money(e.netUSD)} (수수료 전 추정)${e.theirPnlUSD!=null?` · 트레이더 ${money(e.theirPnlUSD)}`:''} · 추매 ${e.adds||0}회`;
 if(e.type==='ADD_SKIPPED')return `${head} 추매 건너뜀 · ${why(e.reason)}${e.need!=null?` (필요 $${e.need} / 여유 $${Number(e.free).toFixed(2)})`:''}`;
 if(e.type==='SKIPPED'&&!['NOT_COPIED','COPY_OFF'].includes(e.reason))return `${head} 진입 안 함 · ${why(e.reason)}${e.detail?` (${e.detail})`:''}`;
 if(e.type==='ERROR')return `⚠️ ${head} 주문 문제 (${e.kind||''}) · ${e.reason||''}\n실매매 화면에서 확인해 주세요.`;
 if(e.type==='COPY_LOSS_LIMIT')return `⛔ 카피 손실 한도 도달 ${e.mode==='LIVE'?'(실계좌)':'(테스트넷)'}\n카피 포지션을 모두 청산하고 새 카피를 멈췄습니다. 실매매 화면의 '카피 다시 시작'으로 재개합니다.`;
 if(e.type==='STOP_NOT_SET')return `⚠️ ${head} 보호 손절을 걸지 못했습니다 (${e.reason||''}${e.detail?` · ${e.detail}`:''})${e.reason==='HTTP_429'?'\n1분 뒤 다시 겁니다.':''}`;
 return null;
}
