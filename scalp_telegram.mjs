// Telegram / screen notices for the testnet reversal scalp ledger (scalp_executor.mjs events), and the
// Korean labels of its skip and close reasons. Entries, closes, the first target and problems only:
// nothing per scan. Text only: symbol, prices and results — never keys or order ids.
export const SCALP_LABEL='[되돌림 단타·테스트넷]';
export const SCALP_REASON_KO=Object.freeze({SIDE_OFF:'꺼 둔 방향의 신호 (SCALP_EXEC_SIDES)',SHORT_NOT_TRADED:'급등 후 되돌림(숏) 신호 — 롱만 거래',AGAINST_4H_TREND:'4시간 추세와 반대 (하락 중 롱·상승 중 숏 안 함)',TREND_4H_UNAVAILABLE:'4시간 추세 확인 불가',
 MAX_OPEN_POSITIONS:'동시 보유 한도',SYMBOL_ALREADY_HELD:'같은 종목 보유 중',SYMBOL_HELD_BY_OTHER_STRATEGY:'신호 전략·카피가 같은 종목 보유 중',CONTRACT_UNAVAILABLE:'BingX 거래 불가 종목',
 PRICE_UNAVAILABLE:'BingX 현재가 확인 실패',PRICE_DRIFT:'진입가에서 가격이 이미 벗어남',ENTRY_AT_OR_BELOW_STOP:'현재가가 손절가 이하',ENTRY_AT_OR_BEYOND_STOP:'현재가가 이미 손절가를 넘음',CONTRACT_GRID_INVALID:'거래소 가격·수량 단위 오류',
 TP1_NET_RR_BELOW_MINIMUM:'1차 목표 손익비(비용 차감) 1 미만',TARGETS_NOT_BEYOND_EXECUTABLE_ENTRY:'목표가가 진입가 반대쪽',TARGET_GRID_INVALID:'목표가 단위 오류',
 NO_BALANCE:'잔고 조회 실패',MARGIN_CAP:'증거금 한도',OPEN_RISK_LIMIT:'오늘 손실 + 열린 포지션 손절 손실 합계가 하루 손실 한도에 닿음',TESTNET_MARGIN_CAP:'테스트넷 공동 증거금 한도',TESTNET_BUDGET_UNAVAILABLE:'공동 위험 한도 계산 실패',QUANTITY_BELOW_MINIMUM:'수량이 거래소 최소 주문 미만',BINGX_HEDGE_MODE:'BingX 양방향(헤지) 모드라 건너뜀 — 이전 버전 기록(지금은 헤지 모드도 지원)',BINGX_POSITION_MODE_UNKNOWN:'BingX 포지션 모드(단방향/헤지) 확인 실패',
 ZONE_NOT_TOUCHED:'매물대 반전 후보(2.5% 급변) — 극값이 4H/1D 매물대 ±0.3% 밖',ZONE_DATA_UNAVAILABLE:'매물대 반전 후보 — 4H/1D 캔들이 없어 매물대 확인 불가',
 VENUE_POSITION_EXISTS:'거래소에 같은 코인 포지션이 이미 있음',VENUE_POSITION_LIMIT:'BingX 포지션 한도',MARGIN_SETUP_FAILED:'교차 증거금·레버리지 설정 실패',ENTRY_REJECTED:'진입 주문 거부',ENTRY_SETUP_FAILED:'진입 준비 중 오류',HTTP_429:'요청 과다(잠시 쉼)',
 NOT_ARMED:'비활성',SCALP_MODE_OFF:'꺼짐 (SCALP_EXEC_MODE=OFF)',LIVE_REFUSED:'실계좌 모드는 거부됨 — 테스트넷 전용',MODE_INVALID:'알 수 없는 모드 — 꺼짐',CREDENTIALS_MISSING:'BingX API 키 없음',
 SCALP_TESTNET_ONLY:'테스트넷 전용',KILL_SWITCH:'긴급 정지 중',KILL_SWITCH_ON:'긴급 정지 중',UPDATING:'업데이트 중',DAILY_LOSS_LIMIT:'하루 손실 한도 도달',UNRESOLVED_ORDER_STATE:'확인 안 된 주문이 있음',RATE_LIMIT_COOLDOWN:'요청 과다로 잠시 쉼',
 // Close reasons
 STOP:'손절',BREAKEVEN_STOP:'1차 목표 뒤 본전 손절',ALL_TARGETS:'목표 모두 도달',TIME_STOP:'2시간 보유 시간 만료',EARLY_TAKE_PROFIT:'조기 익절',EXTERNAL:'외부 청산',NO_STOP:'보호 손절 실패로 긴급 청산',MANUAL:'수동',NO_PROTECTIVE_STOP:'보호 손절 실패'});
export const scalpReasonKo=r=>SCALP_REASON_KO[r]||r||'';
const fmt=v=>{const x=Number(v);if(!Number.isFinite(x))return '—';const a=Math.abs(x);return a>=1000?x.toLocaleString('en-US',{maximumFractionDigits:2}):a>=1?String(+x.toFixed(4)):String(+x.toPrecision(4))};
const usd=v=>{const x=Number(v);return Number.isFinite(x)?(x>=0?'+':'−')+'$'+Math.abs(x).toFixed(2):'—'};
const SIDE={LONG:'롱',SHORT:'숏'},side=e=>SIDE[e?.direction]||'롱';
const zoneText=z=>z?.tf?` — ${String(z.tf).toUpperCase()} 매물대 ${fmt(z.low)}~${fmt(z.high)}${Number(z.distPct)>0?` (${Number(z.distPct).toFixed(2)}% 거리)`:''}`:'';
/** Kind label: 급변 (5 % move) / 매물대 (2.5 % at a 4H / 1D volume zone). */
export const scalpKindKo=k=>k==='ZONE_REVERSAL'?'매물대':'급변';
const mins=ms=>Number.isFinite(ms)?Math.max(1,Math.round(ms/60000))+'분':'—';

/** Text for one scalp event, or null when it is not worth a notice. */
export function scalpEventText(e){
 if(!e)return null;
 const head=`${SCALP_LABEL} ${e.symbol||''}`.trim();
 if(e.type==='ARMED')return `${SCALP_LABEL} 활성화 — 5분봉 급락 후 반등 롱·급등 후 되돌림 숏을 테스트넷에서 주문합니다.`;
 if(e.type==='DISARMED')return ['DAILY_LOSS_LIMIT','NO_PROTECTIVE_STOP'].includes(e.reason)?null:`${SCALP_LABEL} 비활성화`;
 if(e.type==='OPENED')return `🟢 ${head} ${side(e)} ${e.leverage}배 진입${e.kind==='ZONE_REVERSAL'?` · 매물대 반전(4H/1D)${zoneText(e.zone)}`:''}\n진입 ${fmt(e.entry)} · ${e.stopLossEnabled===false?'자동 손절 없음 · 한도 계산 위험':`손절 ${fmt(e.stop)} · 위험`} $${e.riskUSD}\n목표 ${(e.targets||[]).map((t,i)=>e.parts?.[i]>0?fmt(t):null).filter(Boolean).join(' / ')}${e.merged?' (최소 주문 때문에 목표 합침)':''}\n${e.direction==='SHORT'?'급등':'급락'} ${e.movePct??'—'}% · 거래량 ${e.volumeX??'—'}배`;
 if(e.type==='STOP_TO_BREAKEVEN')return `🎯 ${head} ${side(e)} 1차 목표 도달 · 손절을 진입가 ${fmt(e.price)}로 올림`;
 if(e.type==='SCALE_IN_FILLED'&&e.qty>0)return `➕ ${head} ${side(e)} 추가 진입${e.count>0?` ${e.count}회차`:''}\n수량 +${fmt(e.qty)} · 체결가 ${fmt(e.price)} · 잔여 ${fmt(e.left)}`;
 if(e.type==='PARTIAL_EXIT')return `🎯 ${head} ${side(e)} 부분 청산\n청산 수량 ${fmt(e.qty)} · 잔여 ${fmt(e.left)}`;
 if(e.type==='CLOSED')return `${Number(e.netUSD)>0?'✅':Number(e.netUSD)<0?'🔻':'⚪'} ${head} ${side(e)} 청산 · ${scalpReasonKo(e.reason)}\n손익 ${usd(e.netUSD)} (수수료 포함 추정) · 목표 ${e.tp||0}개 · 보유 ${mins(e.holdMs)}`;
 if(e.type==='DAILY_LOSS_LIMIT')return e.shared?`⛔ [테스트넷] 하루 손실 한도 도달 (신호+단타 ${usd(e.lossUSD)})\n오늘(한국 시간)은 신호 전략·단타 모두 신규 진입과 추매를 멈췄습니다.`
  :`⛔ ${SCALP_LABEL} 하루 손실 한도 도달 (${usd(e.lossUSD)})\n오늘은 신규 진입과 추매를 멈췄습니다.`;
 if(['STOP_FAILED','EMERGENCY_CLOSE_FAILED','ENTRY_OUTCOME_UNKNOWN'].includes(e.type))return `⚠️ ${head} ${e.type==='STOP_FAILED'?'손절 주문 실패 — 긴급 청산':e.type==='ENTRY_OUTCOME_UNKNOWN'?'진입 결과 확인 안 됨 — 새 진입 멈춤':'긴급 청산 실패 — 즉시 확인 필요'} (${e.reason||''})`;
 return null;
}
