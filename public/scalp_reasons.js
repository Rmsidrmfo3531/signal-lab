// 되돌림 단타(테스트넷) 사유 설명 — the one Korean glossary for every reason code the testnet scalp can show
// (scalp_reversal.mjs detection, scalp_executor.mjs skips / stops / scale-in / close, testnet_budget.mjs,
// the squeeze guard, maker entry and BingX position mode), plus the 8 score items of scoreScalpSetup.
// User 2026-11-24: "진입 이유에 대한 설명을 어디에다가 정리해줬으면 해", "진입 이유 전부, 중복은 제외하고".
// Text only: nothing here changes a trading decision. Used by the #live screen and the Telegram notices.
// Each entry: short label (12 Korean chars or fewer, spaces not counted) and one plain sentence. Thresholds
// come from the settings the server sends (status().settings), so an env override shows its real value.

export const REASON_CATEGORIES=Object.freeze([
 ['entry','진입 조건 (반전 판정)'],['score','점수 항목'],['limit','한도·차단'],['pump','급변 알림'],['venue','거래소'],['position','추매·청산']]);

const fin=v=>v!==null&&v!==''&&Number.isFinite(Number(v));
const n=(v,d='설정값')=>fin(v)?String(+Number(v).toFixed(4)):d;
const fr=(v,d='설정값')=>fin(v)?String(+(Number(v)*100).toFixed(1)):d;           // 0.35 -> "35"
const list=v=>Array.isArray(v)&&v.length?v.map(x=>fr(x)+'%').join('·'):'설정값';
// $ in 만 units for the 고래 CVD text: 20000 -> "$2만", 1000000 -> "$100만".
const man=v=>fin(v)?`$${(+(Number(v)/1e4).toFixed(1)).toLocaleString('en-US')}만`:'설정값';
const WHALE_SRC='Material Indicators FireCharts 분류';
const sidesKo=v=>Array.isArray(v)&&v.length?v.map(d=>d==='SHORT'?'숏':'롱').join('·'):'없음';

/** code -> {cat,label,desc(S)}. desc is a sentence; S = the scalp settings sent to the screen. */
const G={
 // 진입 조건 (반전 판정) — detectScalpReversal / buildScalpPlan / planScalpOrder / #precheck
 EXTREME_NOT_RECENT:['entry','극값이 오래됨',S=>`급변의 끝(롱은 최저점, 숏은 최고점)이 최근 ${n(S.extremeWithin)}개 5분봉 안에 있어야 하는데 그보다 앞서 이미 지난 움직임입니다.`],
 MOVE_TOO_SMALL:['entry','급변 폭 부족',S=>`최근 ${n(S.moveWindow)}개 5분봉 안 움직임이 기준 ${n(S.minMovePct)}%(매물대 반전은 ${n(S.zoneMinMovePct)}%)보다 작습니다.`],
 MOVE_NOT_UNUSUAL_FOR_ATR:['entry','평소 변동 수준',S=>`움직임이 직전 평균 변동폭(ATR)의 ${n(S.minMoveAtr)}배에 못 미쳐 특별한 급변이 아닙니다.`],
 NO_VOLUME_CLIMAX:['entry','거래량 폭발 없음',S=>`급변 봉 중 가장 큰 거래량이 직전 거래량 중간값의 ${n(S.climaxVolume)}배에 못 미칩니다.`],
 RSI_NOT_EXTREME:['entry','RSI 과열 아님',S=>`급변 중 RSI(14)가 롱은 ${n(S.rsiExtreme)} 이하, 숏은 ${fin(S.rsiExtreme)?100-Number(S.rsiExtreme):'설정값'} 이상까지 가지 않았습니다.`],
 NO_REJECTION_CANDLE:['entry','반전 봉 없음',S=>`마지막 5분봉에 반전 꼬리(봉 길이의 ${fr(S.wickShare)}% 이상)나 직전 봉을 넘는 반전 마감이 없습니다.`],
 LAST_CANDLE_AGAINST:['entry','마지막 봉 역방향',()=>'마지막 5분봉이 아직 진입 반대 방향(롱이면 음봉, 숏이면 양봉)으로 마감했습니다.'],
 MOVE_ALREADY_RETRACED:['entry','이미 많이 되돌림',S=>`급변 폭의 ${fr(S.maxRetracedBeforeEntry)}% 넘게 이미 되돌아와 늦은 진입입니다.`],
 TARGETS_BEHIND_ENTRY:['entry','남은 목표 없음',S=>`되돌림 목표가(급변 폭의 ${list(S.retracements)})가 이미 진입가를 지나 먹을 폭이 없습니다.`],
 TARGETS_NOT_BEYOND_EXECUTABLE_ENTRY:['entry','목표가 순서 오류',()=>'거래소 가격 단위로 맞춘 목표가가 실제 진입가보다 수익 쪽에 있지 않습니다.'],
 TP1_NET_RR_BELOW_MINIMUM:['entry','손익비 부족',S=>`수수료·미끄러짐을 뺀 1차 목표 손익비가 ${n(S.minNetRR)} 미만입니다(자동 손절이 꺼져 있으면 비용만 넘으면 됩니다).`],
 PRICE_DRIFT:['entry','가격이 벌어짐',S=>`현재가가 신호 진입가에서 ${n(S.maxDriftPct)}%(목표 쪽은 급변 폭의 ${n(S.driftMovePct)}%) 넘게 벌어졌거나 급변의 끝을 넘었습니다.`],
 ENTRY_AT_OR_BEYOND_STOP:['entry','이미 손절가 넘음',()=>'현재가가 이미 손절 기준가를 지나 들어가면 바로 손실이 나는 자리입니다.'],
 SIDE_OFF:['entry','꺼 둔 방향',S=>`설정에서 거래하지 않는 방향의 신호입니다(지금 거래 방향: ${sidesKo(S.sides)}).`],
 AGAINST_4H_TREND:['entry','4H 추세 반대',()=>'4시간 추세와 반대 방향(하락 중 롱·상승 중 숏)이라 추세 필터가 막았습니다.'],
 TREND_4H_UNAVAILABLE:['entry','4H 추세 확인 불가',()=>'4시간봉이 200개 미만이거나 조회에 실패해 추세를 판단하지 못했습니다.'],
 ZONE_NOT_TOUCHED:['entry','매물대 밖',S=>`${n(S.zoneMinMovePct)}% 급변 후보지만 급변의 끝이 4H·1D 매물대 ±${n(S.zoneTouchPct)}% 안에 닿지 않았습니다.`],
 ZONE_DATA_UNAVAILABLE:['entry','매물대 확인 불가',()=>'4H 또는 1D 캔들을 받지 못해 매물대를 계산하지 못했습니다.'],
 ALREADY_SENT:['entry','이미 주문한 신호',()=>'같은 종목·같은 5분봉·같은 방향 신호는 한 번만 주문합니다.'],
 SPREAD_TOO_WIDE:['entry','호가 스프레드 큼',S=>`매수·매도 호가 차이가 기준 ${n(S.maxSpreadPct)}%보다 넓어 실거래 슬리피지 위험이 큽니다.`],
 // 점수 항목 — scoreScalpSetup (items are in SCORE_ITEMS below)
 SCORE_BELOW_MINIMUM:['score','점수 미달',S=>`8개 항목 100점 만점 점수가 기준 ${n(S.minScore)}점(B급)보다 낮아 진입하지 않았습니다(등급별 비중 ${scoreTierRangesText(S)}).`],
 // 고래 CVD (user 2026-11-25 09:05 "갈색 고래, 보라 고래, 빨강 고래", 09:12 "(나) 진행", 09:20 FireCharts 범례; whale_cvd.mjs):
 // the six series in the legend's colours and the ±points. Scored: 보라 + 갈색 고래. Recorded: all six.
 WHALE_ORANGE:['score','주황 새우',()=>`주황 "새우"는 시장가 주문 한 건이 $100~$1,000인 층입니다(${WHALE_SRC}). 새우 CVD가 줄면 매도 경향이고, 고래와 반대로 가면 따로 기록만 합니다(점수 없음).`],
 WHALE_GREEN:['score','초록 주문층',()=>`초록은 시장가 주문 한 건이 $1,000~$1만인 층입니다(${WHALE_SRC}).`],
 WHALE_RED:['score','빨강 주문층',()=>`빨강은 시장가 주문 한 건이 $1만~$10만인 층입니다(${WHALE_SRC}).`],
 WHALE_PURPLE:['score','보라 주문층',S=>`보라는 시장가 주문 한 건이 $10만~$100만인 층으로 BTC 가격에 가장 큰 영향을 준 층이며, 갈색과 합쳐 고래 CVD로 점수에 씁니다(${WHALE_SRC}; 알트는 24시간 거래대금에 맞춰 모든 기준을 함께 낮추되 보라는 ${man(S.whaleCvdMinPurpleUSD)} 아래로 내리지 않습니다).`],
 WHALE_BROWN:['score','갈색 고래',()=>`갈색 "고래"는 시장가 주문 한 건이 $100만~$1,000만인 가장 큰 층입니다(${WHALE_SRC}, 드문 $1,000만 초과 주문도 여기에 넣음). 고래 CVD가 늘면 매집 경향입니다.`],
 WHALE_BLUE:['score','파랑 전체 CVD',()=>`파랑은 크기와 관계없이 모든 시장가 주문(All Orders)의 CVD입니다(${WHALE_SRC}, $100 미만 주문은 여기에만 들어감).`],
 // 예전 구간 규칙(PR #316, 급변 시작~지금 고래 순매수·순매도): 2026-11-25 09:51부터 점수 없이 비교 기록(window)만 남습니다.
 WHALE_CVD_WITH:['score','고래CVD 같은 방향',S=>`예전 구간 규칙: 보라+갈색(고래)의 순매수(롱)·순매도(숏)가 진입 방향과 같고 의미 있는 크기(구간 거래대금의 ${n(S.whaleCvdMinSharePct)}% 이상)면 +${n(S.whaleCvdBonus)}점이었고, 지금은 비교 기록만 합니다(점수는 고래 매물대).`],
 WHALE_CVD_AGAINST:['score','고래CVD 반대 방향',S=>`예전 구간 규칙: 보라+갈색(고래)의 순매수·순매도가 진입 반대 방향으로 의미 있는 크기(구간 거래대금의 ${n(S.whaleCvdMinSharePct)}% 이상)면 −${n(S.whaleCvdBonus)}점이었고, 급변 자체가 구간에 들어가 반전 진입이 늘 깎이는 문제로 지금은 비교 기록만 합니다.`],
 WHALE_CVD_WEAK:['score','고래CVD 약함',S=>`예전 구간 규칙: 고래 순매수·순매도가 급변 시작부터 지금까지(최대 ${n(S.whaleCvdWindowMin)}분) 거래대금의 ${n(S.whaleCvdMinSharePct)}%와 보라 고래 기준 금액 중 큰 값보다 작았습니다(비교 기록만).`],
 WHALE_CVD_NO_PRINTS:['score','고래 주문 없음',S=>`예전 구간 규칙: 급변 시작부터 지금까지(최대 ${n(S.whaleCvdWindowMin)}분) 보라·갈색 크기의 시장가 주문이 없었습니다(비교 기록만).`],
 WHALE_CVD_UNAVAILABLE:['score','고래CVD 확인 불가',()=>'예전 구간 규칙: Binance 체결 내역(aggTrades)을 읽지 못해(바이낸스 미상장·공개 조회 한도·시간 초과) 진입을 막지 않고 0점으로 두었습니다.'],
 // 고래 매물대 (user 2026-11-25 09:51 "단타에선 CVD 활용 방법이 매물대를 보는 거라고 생각하면 편할 것 같고", "진행해"; whale_zones.mjs).
 WHALE_ZONE:['score','고래 매물대',S=>`최근 ${n(S.whaleZoneHours)}시간 Binance 체결을 가격 구간(1시간 ATR×${n(S.whaleZoneBinAtrMult)}, ATR이 없으면 가격의 ${n(S.whaleZoneBinPct)}%)으로 나눠 보라+갈색(고래) 시장가 매수−매도를 더하고, 순매수·순매도가 보라 기준의 ${n(S.whaleZoneFloorPurpleMult)}배와 그 시간 고래 거래대금의 ${n(S.whaleZoneFloorSharePct)}% 중 큰 값 이상인 상위 ${n(S.whaleZoneTopN)}개 구간(붙어 있으면 합침)을 고래 매물대로 봅니다: 순매수는 매수 매물대(지지), 순매도는 매도 매물대(저항)입니다.`],
 WHALE_ZONE_SUPPORT:['score','고래 매물대 지지',S=>`롱은 진입가 아래(또는 진입가에 걸친) 고래 매수 매물대가, 숏은 위의 고래 매도 매물대가 진입가에서 1시간 ATR×${n(S.whaleZoneNearAtrMult)}(ATR이 없으면 ${n(S.whaleZoneNearPct)}%) 안에 있어 +${n(S.whaleCvdBonus)}점을 더했습니다.`],
 WHALE_ZONE_RESISTANCE:['score','고래 매물대 저항',S=>`지지 매물대는 없고 롱은 바로 위에 고래 매도 매물대가, 숏은 바로 아래에 고래 매수 매물대가 진입가에서 1시간 ATR×${n(S.whaleZoneNearAtrMult)}(ATR이 없으면 ${n(S.whaleZoneNearPct)}%) 안에 있어 −${n(S.whaleCvdBonus)}점을 뺐습니다.`],
 WHALE_ZONE_NONE:['score','근처 고래 매물대 없음',S=>`고래 매물대는 있지만 진입가에서 1시간 ATR×${n(S.whaleZoneNearAtrMult)}(ATR이 없으면 ${n(S.whaleZoneNearPct)}%) 안에 없어 0점입니다.`],
 WHALE_ZONE_NO_ZONES:['score','고래 매물대 없음',S=>`최근 ${n(S.whaleZoneHours)}시간 고래 주문은 있었지만 기준(보라 기준의 ${n(S.whaleZoneFloorPurpleMult)}배·고래 거래대금의 ${n(S.whaleZoneFloorSharePct)}%)을 넘는 가격 구간이 없어 0점입니다.`],
 WHALE_ZONE_NO_PRINTS:['score','매물대 고래 주문 없음',S=>`최근 ${n(S.whaleZoneHours)}시간 보라·갈색 크기의 시장가 주문이 없어 0점입니다.`],
 WHALE_ZONE_PARTIAL:['score','고래 체결 일부만',S=>`최근 ${n(S.whaleZoneHours)}시간 체결을 ${n(S.whaleZoneMinCoveragePct)}% 미만만 읽었거나(한 번에 최대 ${n(S.whaleZoneMaxPages)}쪽, 큰 코인은 체결이 많음) 최근 ${n(S.whaleZoneMaxStaleSec)}초 안까지 새 체결을 읽지 못해(공개 조회 한도·오류) 짐작하지 않고 0점으로 둡니다(진입은 막지 않음, 추매 2배 자리에도 쓰지 않음).`],
 WHALE_ZONE_UNAVAILABLE:['score','고래 매물대 확인 불가',()=>'Binance 체결 내역(aggTrades)을 읽지 못해(바이낸스 미상장·공개 조회 한도·시간 초과) 진입을 막지 않고 0점으로 둡니다.'],
 // 한도·차단 — #blocked / #precheck / testnet_budget.mjs
 NOT_ARMED:['limit','단타 꺼짐',()=>'테스트넷 스위치가 꺼져 있거나 켜고 끄는 사이에 들어온 신호라 새로 진입하지 않습니다.'],
 SCALP_MODE_OFF:['limit','단타 모드 꺼짐',()=>'서버 설정(SCALP_EXEC_MODE)이 OFF라 단타 주문을 하지 않습니다.'],
 LIVE_REFUSED:['limit','실계좌 거부',()=>'되돌림 단타는 테스트넷 전용이라 실계좌 모드 설정을 거부하고 꺼 둡니다.'],
 LIVE_CONFIRM_REQUIRED:['limit','실거래 확인 필요',()=>'실계좌 단타는 SCALP_LIVE_CONFIRM=REAL_MONEY_SCALP 확인 문구가 있어야 켤 수 있습니다.'],
 MODE_INVALID:['limit','알 수 없는 모드',()=>'모드 설정 값을 알 수 없어 안전하게 꺼 둡니다.'],
 SCALP_TESTNET_ONLY:['limit','테스트넷 아님',()=>'연결된 계정이 테스트넷이 아니라 주문하지 않습니다(단타는 테스트넷 전용).'],
 KILL_SWITCH:['limit','긴급 정지 중',()=>'긴급 정지가 켜져 있어 모든 새 진입을 멈췄습니다.'],
 UPDATING:['limit','업데이트 중',()=>'프로그램 업데이트 중이라 잠시 새 진입을 멈췄습니다.'],
 GATE_CLOSED:['limit','진입 잠김',()=>'서버의 상위 안전 확인이 지금 새 진입을 막고 있습니다.'],
 LIVE_MODE_OFF:['limit','테스트넷 꺼짐',()=>'신호 전략과 단타가 모두 꺼져 있어 켤 수 있는 전략이 없습니다.'],
 DAILY_LOSS_LIMIT:['limit','하루 손실 한도',S=>`오늘(한국 시간) 손실이 잔고의 ${n(S.dailyLossPct)}%에 닿아 그날은 새 진입·추매를 멈춥니다${S.sharedBudget?'(신호 전략과 공동)':''}.`],
 OPEN_RISK_LIMIT:['limit','열린 위험 한도',S=>`오늘 손실 + 열린 포지션 손절 위험 + 새 거래 위험의 합이 잔고의 ${n(S.dailyLossPct)}%를 넘습니다.`],
 TESTNET_MARGIN_CAP:['limit','공동 증거금 한도',S=>`신호 전략과 단타의 증거금 합계가 잔고의 ${n(S.maxTotalMarginPct)}%를 넘게 됩니다.`],
 MARGIN_CAP:['limit','증거금 한도',S=>`포지션당 잔고의 ${n(S.maxMarginPct)}%·전체 ${n(S.maxTotalMarginPct)}%·여유 증거금 90% 안에서 주문할 여유가 없습니다.`],
 LADDER_BELOW_MINIMUM:['limit','추매 사다리 불가',S=>`거래소 최소 주문 때문에 첫 진입과 1회 추매(1·1단위)조차 종목당 증거금 한도(잔고의 ${n(S.maxMarginPct)}%) 안에 넣을 수 없습니다.`],
 LADDER_FINAL_LINE_OFF:['limit','마지막 선 꺼짐',()=>'카피식 추매에는 마지막 정리선(비상 손절 ROE)이 있어야 하는데 설정이 0이라 진입하지 않습니다.'],
 ACCOUNT_MARGIN_RESERVE:['limit','실계좌 마진 보호',S=>`실계좌 여유 증거금이 잔고의 ${n(S.minFreeAccountMarginPct)}% 미만이라 카피·수동 여력을 지키려 보류합니다.`],
 TESTNET_BUDGET_UNAVAILABLE:['limit','한도 계산 실패',()=>'공동 위험 한도를 계산할 자료(잔고·손익)를 읽지 못해 안전하게 건너뜁니다.'],
 NO_BALANCE:['limit','잔고 확인 실패',()=>'테스트넷 잔고를 읽지 못했거나 오래된 값이라 주문 크기를 정할 수 없습니다.'],
 MAX_OPEN_POSITIONS:['limit','동시 보유 한도',S=>`동시에 가질 수 있는 단타 포지션 수(${fin(S.maxOpen)&&Number(S.maxOpen)>0?n(S.maxOpen)+'개':'제한 없음'})를 채웠습니다.`],
 MAX_SAME_SIDE:['limit','같은 방향 한도',S=>`같은 방향(롱 또는 숏)으로 동시에 보유할 수 있는 최대 종목 수(${n(S.maxSameSide)}개)를 채웠습니다.`],
 SYMBOL_ALREADY_HELD:['limit','같은 종목 보유 중',()=>'이 종목을 이미 단타로 갖고 있거나 진입 중입니다(종목당 1개).'],
 SYMBOL_HELD_BY_OTHER_STRATEGY:['limit','다른 전략 보유',()=>'신호 전략이나 카피가 같은 종목을 갖고 있어 겹치지 않게 건너뜁니다.'],
 SYMBOL_LOSS_COOLDOWN:['limit','종목 손실 휴식',S=>`이 종목에서 손실 뒤 ${n(S.symbolLossCooldownMin)}분 동안, 또는 오늘 ${n(S.symbolDailyMaxLosses)}번 지면 자정까지 쉽니다.`],
 BTC_DUMP_GUARD:['limit','BTC 급변 방어',S=>`BTC가 5분에 ${n(S.btcGuard5mPct)}% 또는 15분에 ${n(S.btcGuard15mPct)}% 넘게 급락(롱 보류)·급등(숏 보류)했습니다(직전 5분봉이 ${n(S.btcGuardRelease5mPct)}% 이상 반전하면 해제).`],
 SHORT_SQUEEZE_GUARD:['limit','스퀴즈 위험 보류',S=>`펀딩비가 ±${n(S.squeezeFundingPct)}% 넘게 쏠리고 30분 미결제약정이 ${n(S.squeezeOiChange30mPct)}% 넘게 늘어 반대로 튈 위험이 큽니다.`],
 PRE_FUNDING_EXTREME:['limit','펀딩 정산 직전',S=>`펀딩 정산 ${n(S.preFundingWindowMin)}분 이내에 불리한 방향 펀딩비가 ±${n(S.preFundingExtremePct)}%를 넘어 보류합니다.`],
 UNRESOLVED_ORDER_STATE:['limit','확인 안 된 주문',()=>'결과를 아직 확인하지 못한 주문이 있어 새 진입을 잠시 멈춥니다.'],
 RATE_LIMIT_COOLDOWN:['limit','요청 과다 휴식',()=>'거래소 요청 한도에 닿아 1분 동안 쉬고 있습니다.'],
 // 급변 알림 — pumpAlert (scalp_executor.mjs) and pump_alert.mjs
 PUMP_NO_REVERSAL:['pump','반전 조건 미충족',()=>'알림 코인의 막 닫힌 5분봉이 반전 조건(아래 진입 조건)을 아직 채우지 못했습니다.'],
 PUMP_NOT_ON_BINGX:['pump','BingX에 없는 종목',()=>'알림 코인이 BingX 선물 목록에 없거나 거래 중지·주식형 종목입니다.'],
 PUMP_CANDLES_STALE:['pump','새 5분봉 없음',()=>'알림 뒤 막 닫힌 5분봉을 아직 받지 못했습니다.'],
 PUMP_CANDLES_FAILED:['pump','5분봉 조회 실패',()=>'알림 코인의 5분봉을 거래소에서 읽지 못했습니다.'],
 PUMP_UNIVERSE_UNAVAILABLE:['pump','종목 목록 없음',()=>'BTC 급변 방어에 쓰는 종목 목록을 아직 받지 못했습니다.'],
 PUMP_ALERTS_OFF:['pump','알림 매매 꺼짐',()=>'서버 설정(SCALP_PUMP_ALERTS=off)으로 급변 알림 매매가 꺼져 있습니다.'],
 PUMP_WATCH_EXPIRED:['pump','확인 시간 지남',S=>`알림 뒤 ${n(S.pumpWatchMin)}분 동안 반전이 나오지 않아 지켜보기를 끝냈습니다.`],
 PUMP_ALERT_INVALID:['pump','알림 형식 오류',()=>'알림에서 코인·방향을 읽지 못했습니다.'],
 PUMP_ALERT_STALE:['pump','알림 늦게 도착',S=>`알림이 ${n(S.pumpWatchMin)}분 넘게 늦게 도착해 쓰지 않습니다.`],
 PUMP_EVALUATION_FAILED:['pump','알림 확인 오류',()=>'알림을 단타 조건으로 확인하는 중에 오류가 났습니다.'],
 QUEUED_AFTER_SCAN:['pump','정기 검사 뒤 확인',()=>'정기 5분봉 검사가 도는 중이라 끝난 뒤 이 알림을 확인합니다.'],
 // 거래소 — data, contract and order problems
 SCALP_INTERVAL_UNSUPPORTED:['venue','지원 안 하는 봉',()=>'1분·5분·15분봉이 아닌 봉은 반전 판정을 하지 않습니다.'],
 KLINE_SCHEMA_OR_SEQUENCE_INVALID:['venue','캔들 자료 오류',()=>'받은 캔들 값이 이상하거나 순서가 끊겨 판정하지 않았습니다.'],
 NOT_ENOUGH_CANDLES:['venue','캔들 부족',()=>'판정에 필요한 만큼(약 30개)의 닫힌 캔들이 없습니다.'],
 CANDLES_STALE:['venue','캔들이 오래됨',()=>'마지막 캔들이 한 봉 넘게 지난 것이라 지금 시세가 아닙니다.'],
 ATR_UNAVAILABLE:['venue','변동폭 계산 불가',()=>'급변 전 평균 변동폭(ATR)을 계산할 수 없습니다.'],
 EXECUTION_ESTIMATE_NOT_ELIGIBLE:['venue','주문 계산 불가',()=>'거래소 가격·수량 정보로 주문을 계산할 수 없습니다.'],
 TARGET_GRID_INVALID:['venue','목표가 단위 오류',()=>'목표가를 거래소 가격 단위로 맞출 수 없습니다.'],
 QUANTITY_GRID_INVALID:['venue','수량 단위 오류',()=>'수량을 거래소 수량 단위로 맞출 수 없습니다.'],
 QUANTITY_SPLIT_INVALID:['venue','수량 나누기 오류',()=>'목표 3개(40·35·25%)로 나눈 수량의 합이 전체와 맞지 않습니다.'],
 QUANTITY_SPLIT_BELOW_MINIMUM:['venue','나눈 수량 최소 미만',()=>'목표별로 나눈 수량이 거래소 최소 주문보다 작습니다.'],
 QUANTITY_BELOW_MINIMUM:['venue','최소 주문 미만',()=>'위험 한도로 계산한 수량이 거래소 최소 주문보다 작습니다.'],
 CONTRACT_UNAVAILABLE:['venue','거래 불가 종목',()=>'BingX에서 지금 거래할 수 없는 종목입니다.'],
 CONTRACT_GRID_INVALID:['venue','종목 단위 오류',()=>'거래소의 가격·수량 단위 정보가 없거나 이상합니다.'],
 PRICE_UNAVAILABLE:['venue','현재가 확인 실패',()=>'BingX 현재가를 받지 못했습니다.'],
 VENUE_POSITION_EXISTS:['venue','거래소에 포지션 있음',()=>'거래소 계정에 같은 코인 포지션이 이미 있어 섞이지 않게 건너뜁니다.'],
 MANUAL_FIRST:['venue','수동 포지션 우선',()=>'실계좌에 같은 코인 수동 포지션(또는 수동 TP/SL 주문)이 있어 건드리지 않고 건너뜁니다.'],
 MANUAL_ON_LANE:['venue','같은 자리에 수동 포지션',()=>'실계좌 단타 포지션과 같은 자리에 수동 포지션이 생겨, 단타는 자기 수량만 관리하고 수동 수량은 건드리지 않습니다.'],
 OWN_QTY_UNKNOWN:['venue','단타 몫 불명',()=>'단타 원장 수량을 확인할 수 없어 수동 포지션을 보호하려고 청산 주문을 보내지 않습니다.'],
 MANUAL_ORDERS_UNREADABLE:['venue','수동 주문 확인 실패',()=>'실계좌 미체결 주문을 읽지 못해 수동 포지션 보호를 확인할 수 없어 건너뜁니다.'],
 VENUE_POSITION_LIMIT:['venue','거래소 포지션 한도',()=>'BingX가 이 종목에 더 열 수 있는 수량이 모자랍니다.'],
 MARGIN_SETUP_FAILED:['venue','레버리지 설정 실패',S=>`교차 증거금·${n(S.leverage)}배 레버리지 설정을 거래소에서 확인하지 못했습니다.`],
 BINGX_POSITION_MODE_UNKNOWN:['venue','포지션 모드 확인 실패',()=>'BingX 계정이 단방향인지 헤지인지 읽지 못해 진입하지 않습니다.'],
 BINGX_HEDGE_MODE:['venue','헤지 모드(옛 기록)',()=>'예전 버전이 헤지 모드라 건너뛴 기록입니다(지금은 헤지 모드도 지원).'],
 CREDENTIALS_MISSING:['venue','API 키 없음',()=>'BingX 테스트넷 API 키가 없어 주문할 수 없습니다.'],
 ENTRY_REJECTED:['venue','진입 주문 거부',()=>'거래소가 진입 주문을 받지 않았습니다.'],
 ENTRY_SETUP_FAILED:['venue','진입 준비 오류',()=>'주문을 준비하는 중에 오류가 나 진입하지 않았습니다.'],
 ENTRY_NOT_SENT:['venue','주문 보내기 전 중단',()=>'주문을 보내기 직전 다시 확인했더니 막혀서 보내지 않았습니다.'],
 ENTRY_OUTCOME_UNKNOWN:['venue','진입 결과 불명',()=>'진입 주문의 체결 여부를 확인하지 못해 확인될 때까지 새 진입을 멈춥니다.'],
 MAKER_STATE_UNCONFIRMED:['venue','지정가 상태 불명',()=>'먼저 넣은 지정가(메이커) 주문의 최종 상태를 확인하지 못했습니다.'],
 POST_ONLY_REJECTED:['venue','지정가 거부',()=>'지정가(메이커) 주문이 바로 체결될 가격이라 거래소가 거부했습니다.'],
 MARKET_FAILED:['venue','시장가 실패',()=>'지정가 뒤 남은 수량의 시장가 주문이 실패했습니다.'],
 INVALID_QUANTITY:['venue','주문 수량 오류',()=>'주문 수량이 0이거나 단위에 맞지 않습니다.'],
 HTTP_429:['venue','요청 과다',()=>'거래소 요청 한도에 닿아 잠시 쉬었다가 다시 봅니다.'],
 NETWORK_UNREACHABLE:['venue','연결 실패',()=>'거래소에 연결하지 못했습니다.'],
 POSITION_CHECK_FAILED:['venue','포지션 확인 실패',()=>'거래소 포지션 목록을 읽지 못했습니다.'],
 BAD_POSITIONS_RESPONSE:['venue','포지션 응답 오류',()=>'거래소 전체 포지션 목록 응답이 비정상이라 이번 확인을 건너뜁니다.'],
 POSITION_BULK_MISS:['venue','전체 목록 일시 누락',()=>'거래소 전체 포지션 목록에서 빠졌지만 종목별 재확인에서 보유 중으로 확인돼 계속 관리합니다.'],
 VENUE_ERROR_110401:['venue','주문 수량 초과',()=>'청산·목표 주문 수량이 남은 포지션보다 커서 거래소가 거부했습니다.'],
 VENUE_ERROR_80016:['venue','주문 없음',()=>'취소·조회하려는 주문이 거래소에 없습니다.'],
 // 추매·청산 — scale-in decisions and close reasons
 MAX_ADDS_REACHED:['position','추매 횟수 다 씀',S=>`이 포지션은 최대 추매 ${n(S.maxScaleInAdds)}회를 모두 했습니다.`],
 FALLING_KNIFE:['position','역방향 장대봉',()=>'마지막 5분봉이 반대 방향 장대봉(몸통 65% 이상)이라 추매를 미룹니다.'],
 PRICE_OUTSIDE_BAND:['position','추매 가격 아님',S=>S.management==='TRADER_LADDER'?`가격이 다음 추매 자리(마지막 체결가에서 ${n(S.ladderSpacingMinPct)}% 또는 1시간 ATR만큼, 강한 매물대면 그 자리)에 오지 않았습니다.`:`가격이 추매 자리(1R·1.5R 또는 −${n(S.defensiveAddRoePct)}% ROE 방어)에 오지 않았습니다.`],
 MIN_QUANTITY:['position','추매 수량 부족',()=>'추매 수량이 거래소 최소 주문보다 작습니다.'],
 RISK_OR_MARGIN_CAP:['position','추매 한도 부족',()=>'추매하면 위험·증거금 한도를 넘습니다.'],
 TESTNET_BUDGET:['position','공동 한도 부족',()=>'추매하면 테스트넷 공동 위험·증거금 한도를 넘습니다.'],
 WINDOW_EXPIRED:['position','추매 시간 지남',()=>'추매를 기다리는 시간이 지났습니다.'],
 POSITION_CHANGED:['position','포지션 바뀜',()=>'일부 청산 등으로 포지션 수량이 바뀌어 추매를 멈췄습니다.'],
 FIRST_REDUCTION:['position','이미 일부 익절',()=>'1차 목표에서 일부를 정리해 그 뒤로는 추매하지 않습니다.'],
 NOT_FILLED:['position','추매 미체결',()=>'추매 주문이 체결되지 않았습니다.'],
 ORDER_TIMEOUT:['position','추매 시간 초과',()=>'추매 주문 응답을 제때 받지 못했습니다.'],
 ORDER_NOT_FOUND:['position','추매 주문 없음',()=>'보낸 추매 주문을 거래소에서 찾지 못했습니다.'],
 ORDER_OUTCOME_UNKNOWN:['position','추매 결과 불명',()=>'추매 주문 결과를 확인하지 못해 확인될 때까지 기다립니다.'],
 NO_WHOLE_POSITION_STOP:['position','전체 손절 못 검',()=>'추매 뒤 전체 수량의 손절 주문을 걸 수 없어 추매하지 않습니다.'],
 FLAT_DURING_RESIZE:['position','조정 중 포지션 없음',()=>'추매 뒤 주문을 다시 거는 사이 포지션이 이미 닫혔습니다.'],
 EXIT_DURING_RESIZE:['position','조정 중 청산',()=>'추매 뒤 주문을 다시 거는 사이 청산이 일어났습니다.'],
 TARGET_FILLED_DURING_RESIZE:['position','조정 중 목표 체결',()=>'추매 뒤 주문을 다시 거는 사이 목표가 체결됐습니다.'],
 POSITION_CHANGED_DURING_RESIZE:['position','조정 중 수량 바뀜',()=>'추매 뒤 주문을 다시 거는 사이 수량이 바뀌었습니다.'],
 SCALE_IN_RESIZE_EXIT:['position','추매 정리 청산',()=>'추매 뒤 손절·목표 주문을 다시 걸지 못해 안전하게 청산했습니다.'],
 STOP:['position','손절',()=>'손절가에 닿아 청산했습니다.'],
 BREAKEVEN_STOP:['position','본전 손절',()=>'1차 목표 뒤 진입가로 올린 손절에 닿아 청산했습니다.'],
 ALL_TARGETS:['position','목표 모두 도달',()=>'목표가를 모두 채워 청산했습니다.'],
 TIME_STOP:['position','보유 시간 만료',S=>`최대 보유 시간(${n(S.maxHoldMin,'2시간')}${fin(S.maxHoldMin)?'분':''})이 지나 청산했습니다.`],
 MAX_HOLD_EXIT:['position','손실 장기화 컷',S=>`손실 상태로 ${n(S.profitOnlyMaxHoldMin)}분 넘게 보유해 정리했습니다.`],
 EMERGENCY_ROE_STOP:['position','비상 손절',S=>`손실이 −${n(S.emergencyStopRoePct)}% ROE에 닿아 비상 청산했습니다.`],
 EARLY_TAKE_PROFIT:['position','조기 익절',()=>'비용을 넘는 수익에서 일찍 이익을 확정했습니다.'],
 EXTERNAL:['position','외부 청산',()=>'거래소에서 직접(수동·강제) 닫힌 포지션입니다.'],
 POSITION_RECOVERED:['position','포지션 복구',()=>'오인 종료(EXTERNAL) 처리됐지만 거래소에 실제로 남아 있는 테스트넷 포지션을 다시 원장으로 복구했습니다.'],
 MANUAL:['position','수동 청산',()=>'화면 버튼으로 직접 청산했습니다.'],
 // 카피식 추매 TRADER_LADDER (user 2026-11-24, scalp_ladder.mjs): exits and the strong-zone add reasons.
 LADDER_TAKE_PROFIT:['position','평단 익절',S=>`평단에서 수수료·비용을 뺀 +${n(S.ladderTpNetPct)}% 자리에 닿아 전량 익절했습니다.`],
 LADDER_MAX_HOLD:['position','추매 보유 만료',S=>`카피식 추매 포지션을 ${n(S.ladderMaxHoldHours)}시간 넘게 보유해 손익과 관계없이 정리했습니다.`],
 LADDER_FINAL_LINE:['position','마지막 선 정리',S=>`추매 ${Array.isArray(S.ladderSteps)?S.ladderSteps.length:'모든'}단계를 다 채운 뒤에도 밀려 손실이 전체 증거금 기준 −${n(S.ladderFinalLineRoePct)}% ROE에 닿아 정리했습니다.`],
 OVERLAP_4H_1D:['position','4H·1D 매물대 겹침',S=>`4시간·1일 매물대가 ±${n(S.ladderZoneTouchPct)}% 안에서 겹치는 강한 자리라 이 추매를 ${n(S.ladderZoneBoost)}배로 넣었습니다.`],
 TOP_VOLUME_NODE:['position','최대 거래량 매물대',S=>`4시간 또는 1일 거래량 분포에서 가장 큰 매물대(1위)라 이 추매를 ${n(S.ladderZoneBoost)}배로 넣었습니다.`],
 WHALE_BUY_ZONE:['position','고래 매수 매물대 추매',S=>`롱 사다리의 추매 자리가 최근 ${n(S.whaleZoneHours)}시간 고래 매수 매물대(지지)라 4H·1D 강한 매물대처럼 이 추매를 ${n(S.ladderZoneBoost)}배로 넣었습니다.`],
 WHALE_SELL_ZONE:['position','고래 매도 매물대 추매',S=>`숏 사다리의 추매 자리가 최근 ${n(S.whaleZoneHours)}시간 고래 매도 매물대(저항)라 4H·1D 강한 매물대처럼 이 추매를 ${n(S.ladderZoneBoost)}배로 넣었습니다.`],
 REJECTIONS_3:['position','3회 이상 막힌 자리',S=>`4시간봉이 ${n(S.ladderZoneMinRejections)}번 이상 닿고 되돌아간 자리라 이 추매를 ${n(S.ladderZoneBoost)}배로 넣었습니다.`],
 NO_STOP:['position','보호 손절 실패',()=>'보호 손절 주문을 걸지 못해 긴급 청산하고 단타를 멈췄습니다.'],
};
/** Codes that mean the same thing to the user share one entry (listed once). */
export const REASON_ALIASES=Object.freeze({
 ENTRY_AT_OR_BELOW_STOP:'ENTRY_AT_OR_BEYOND_STOP',SHORT_NOT_TRADED:'SIDE_OFF',KILL_SWITCH_ON:'KILL_SWITCH',NOT_TESTNET:'SCALP_TESTNET_ONLY',
 GATE_ERROR:'GATE_CLOSED',BALANCE_STALE:'NO_BALANCE',BALANCE_UNAVAILABLE:'NO_BALANCE',INVALID_BUDGET_METRIC:'TESTNET_BUDGET_UNAVAILABLE',
 INVALID_TESTNET_BUDGET:'TESTNET_BUDGET_UNAVAILABLE',READ_FAILED:'TESTNET_BUDGET_UNAVAILABLE',BTC_PUMP_GUARD:'BTC_DUMP_GUARD',LONG_SQUEEZE_GUARD:'SHORT_SQUEEZE_GUARD',
 UNKNOWN:'ENTRY_OUTCOME_UNKNOWN',ENTRY_FILL_UNCONFIRMED:'ENTRY_OUTCOME_UNKNOWN',LEVERAGE_NOT_CONFIRMED:'MARGIN_SETUP_FAILED',CROSS_NOT_CONFIRMED:'MARGIN_SETUP_FAILED',
 VENUE_ERROR_101429:'VENUE_POSITION_LIMIT',VENUE_ERROR_100410:'HTTP_429',NO_PROTECTIVE_STOP:'NO_STOP',DAILY_LOSS_CIRCUIT_BREAKER:'DAILY_LOSS_LIMIT',
 FALSE_EXTERNAL_RECOVERED:'POSITION_RECOVERED'});

/** The 8 items of scoreScalpSetup (scalp_reversal.mjs; max = SCALP_SCORE_WEIGHTS) and the orderflow OI/CVD bonuses. */
export const SCORE_ITEMS=Object.freeze([
 ['movePct','급변',25,()=>'급변 폭 — 2%에서 0점, 2.5% 5점, 3.5% 15점, 5% 이상 25점 (사이는 1점 단위로 비례)'],
 ['trend4h','4H 추세',20,()=>'코인 4시간 추세(EMA100·200) — 진입 방향과 같으면 20점 · 횡보 10점 · 반대 0점 (추세 세기 값이 없어 3단계)'],
 ['btcTrend4h','BTC',15,()=>'BTC 4시간 추세(EMA100·200) — 진입 방향과 같으면 15점 · 횡보 10점 · 반대 0점 (추세 세기 값이 없어 3단계)'],
 ['moveAtr','ATR',15,()=>'급변 크기 ÷ 평소 변동폭(ATR) — 2배 0점, 3~4.5배 15점, 6배 10점, 9배 이상 5점 (사이는 1점 단위로 비례)'],
 ['retracedPct','반등',10,()=>'진입 전 되돌림 — 0% 0점, 15~30% 10점, 45% 이상 0점 (사이는 1점 단위로 비례) · 반전 꼬리·직전 봉 돌파 마감이면 최소 5점'],
 ['climaxVolume','거래량',5,()=>'급변 봉 거래량 ÷ 평소 — 2배 0점, 5배 이상 5점 (사이는 1점 단위로 비례)'],
 ['netRR','손익비',5,()=>'비용을 뺀 1차 목표 손익비 — 0.8 0점, 1.4 이상 5점 (사이는 1점 단위로 비례)'],
 ['rsiExtreme','RSI',5,()=>'RSI(14) 극단 — 롱은 30에서 0점, 18 이하 5점 · 숏은 70에서 0점, 82 이상 5점 (사이는 1점 단위로 비례)'],
 ['oiBonus','수급',null,S=>`30분 미결제약정(OI)이 1% 넘게 줄면(청산 소진) +${n(S.orderflowOiBonus)}점 보너스`],
 ['cvdBonus','CVD',null,S=>`5분 CVD가 진입 방향으로 15% 넘게 강하게 반전하면 +${n(S.orderflowCvdBonus)}점 보너스`],
 ['whaleBonus','고래매물대',null,S=>`최근 ${n(S.whaleZoneHours)}시간 보라(주문 $10만~$100만)+갈색 고래($100만~$1,000만)의 가격대별 순매수·순매도로 만든 고래 매물대 — 롱은 진입가 아래 1시간 ATR×${n(S.whaleZoneNearAtrMult)}(없으면 ${n(S.whaleZoneNearPct)}%) 안 매수 매물대(지지)면 +${n(S.whaleCvdBonus)}점, 지지 없이 바로 위 매도 매물대(저항)면 −${n(S.whaleCvdBonus)}점, 아니면 0점 (숏은 반대 · 체결 ${n(S.whaleZoneMinCoveragePct)}% 미만이거나 최근 ${n(S.whaleZoneMaxStaleSec)}초 안까지 못 읽으면 0점 · 주황 새우 $100~$1,000·초록·빨강·파랑 전체와 예전 급변 구간 규칙은 기록만 · ${WHALE_SRC} · 알트는 BTC 대비 24시간 거래대금의 제곱근 비율로 모든 기준 축소, 보라 최소 ${man(S.whaleCvdMinPurpleUSD)})`]]);

const entry=code=>{const c=REASON_ALIASES[code]||code,g=G[c];return g?{code:c,cat:g[0],label:g[1],desc:g[2]}:null};
/** Every glossary code (canonical, each once). */
export const REASON_CODES=Object.freeze(Object.keys(G));
/** The canonical glossary code of a reason code (alias resolved), or null when unknown. */
export function reasonCode(code){const e=entry(String(code??''));return e?e.code:null}
/** {code,cat,label,desc} for a reason code; unknown codes (and dynamic VENUE_ERROR_n) still get a label. */
export function reasonInfo(code,S={}){
 const raw=String(code??'').trim();if(!raw)return null;
 const e=entry(raw),s=S||{};
 if(e)return {code:e.code,cat:e.cat,label:e.label,desc:e.desc(s)};
 const ve=/^VENUE_ERROR_(\d+)$/.exec(raw);if(ve)return {code:raw,cat:'venue',label:`거래소 오류 ${ve[1]}`,desc:`BingX가 오류 코드 ${ve[1]}로 요청을 거부했습니다.`};
 const h=/^HTTP_(\d{3})$/.exec(raw);if(h)return {code:raw,cat:'venue',label:`거래소 응답 ${h[1]}`,desc:`거래소가 HTTP ${h[1]} 오류로 답했습니다.`};
 return null;
}
/** Short Korean label of a code (the code itself when it is not a known code, e.g. a free-text error). */
export const reasonLabel=code=>reasonInfo(code)?.label??String(code??'');

const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
/** A label with its explanation: hover (title) on a computer, tap (data-tip, see bindReasonTips) on a phone. */
export function tipHTML(label,desc,cls='rz'){return desc?`<span class="${cls}" tabindex="0" role="button" title="${esc(desc)}" data-tip="${esc(desc)}">${esc(label)}</span>`:`<span class="${cls}">${esc(label)}</span>`}
// Category colour (user 2026-11-24 12:01 "중요도에 따라 점수의 색도 달라지면 좋을듯하다"): rz-c-entry / score / limit / pump / venue / position.
export function reasonHTML(code,S={}){const i=reasonInfo(code,S);return i?tipHTML(i.label,i.desc,`rz rz-c-${i.cat}`):esc(code)}

/** Grade edges from the screen settings: B = the gate S.minScore (70), B+ / A / A+ / S = S.scoreTiers (SCALP_SCORE_TIERS,
 * default 75 / 80 / 85 / 90; user 2026-11-25 08:28 "70,75,80,85,90 ... B, B+, A, A+, S"). */
export function scoreTierEdges(S={}){
 const t=S?.scoreTiers,ok=t&&['B+','A','A+','S'].every(k=>fin(t[k]));
 return {B:fin(S?.minScore)&&Number(S.minScore)>0?Number(S.minScore):70,'B+':ok?Number(t['B+']):75,A:ok?Number(t.A):80,'A+':ok?Number(t['A+']):85,S:ok?Number(t.S):90};
}
/** Grade of a total (as scalpScoreGrade): below the gate C (50+) / D, from the gate B, B+, A, A+, S. */
export function scoreTier(score,S={}){const s=Number(score),e=scoreTierEdges(S);return !Number.isFinite(s)?null:s<Math.max(1,e.B)?(s>=50?'C':'D'):s>=e.S?'S':s>=e['A+']?'A+':s>=e.A?'A':s>=e['B+']?'B+':'B'}
const span=(lo,hi)=>lo>hi?'':lo===hi?`${lo}`:`${lo}~${hi}`;
const GRADE_ROWS=e=>[['B',e.B,e['B+']-1],['B+',Math.max(e['B+'],e.B),e.A-1],['A',Math.max(e.A,e.B),e['A+']-1],['A+',Math.max(e['A+'],e.B),e.S-1],['S',Math.max(e.S,e.B),Infinity]];
/** "70~74 0.75x / 75~79 0.9x / 80~84 1x / 85~89 1.2x / 90+ 1.4x": size by grade from the gate up, empty grades left out. */
export function scoreTierRangesText(S={}){
 const M={B:0.75,'B+':0.9,A:1,'A+':1.2,S:1.4,...(S?.scoreTierMults||{})};
 return GRADE_ROWS(scoreTierEdges(S)).filter(([,lo,hi])=>lo<=hi).map(([k,lo,hi])=>`${hi===Infinity?`${lo}+`:span(lo,hi)} ${M[k]}x`).join(' / ');
}
/** Grade labels of the stats rows, e.g. "B+급 (75~79)" (no range when the grade is empty under the gate). */
export function scoreGradeLabels(S={}){
 return Object.fromEntries(GRADE_ROWS(scoreTierEdges(S)).map(([k,lo,hi])=>{const r=hi===Infinity?`${lo}+`:span(lo,hi);return [k,`${k}급${r?` (${r})`:''}`]}));
}
/** Item colour class: how much of its max it earned (full / part / zero) and how heavy the item is (hi 20+, mid 15, lo <=10). */
export function scoreItemClass(points,max){
 const p=Number(points),m=Number(max);if(!Number.isFinite(p)||!(m>0))return 'rz-i';
 return `rz-i rz-i-${p>=m?'full':p>0?'part':'zero'} rz-w-${m>=20?'hi':m>=15?'mid':'lo'}`;
}

/** Score breakdown from a record: x.breakdown, or parsed from an older SCORE_BELOW_MINIMUM detail text. */
export function scoreParts(x){
 const b=x?.breakdown&&typeof x.breakdown==='object'?x.breakdown:null;
 let score=fin(x?.score)?Number(x.score):null,min=fin(x?.minScore)?Number(x.minScore):null,grade=x?.grade||null,parts=b?{...b}:null;
 const d=typeof x?.detail==='string'?x.detail:'';
 const m=/(\d+)점\/(\d+)점(?:\s*\(([SABCD])급)?/.exec(d);if(m){score??=Number(m[1]);min??=Number(m[2]);grade??=m[3]||null}
 if(!parts){const p=/급변(\d+)·4H(\d+)·BTC(\d+)·ATR(\d+)·반등(\d+)·거래량(\d+)·RR(\d+)·RSI(\d+)/.exec(d);
  if(p)parts=Object.fromEntries(SCORE_ITEMS.slice(0,8).map(([k],i)=>[k,Number(p[i+1])]))}
 if(parts&&fin(x?.oiBonus)&&Number(x.oiBonus)>0)parts.oiBonus=Number(x.oiBonus);
 if(parts&&fin(x?.cvdBonus)&&Number(x.cvdBonus)>0)parts.cvdBonus=Number(x.cvdBonus);
 // 고래 CVD: shown whenever it was read (+, − or 0), with its bucket CVDs.
 if(parts&&x?.whaleCvd&&typeof x.whaleCvd==='object')parts.whaleBonus=fin(x.whaleBonus)?Number(x.whaleBonus):Number(x.whaleCvd.bonus)||0;
 return parts||score!=null?{parts,score,min,grade,whale:x?.whaleCvd&&typeof x.whaleCvd==='object'?x.whaleCvd:null}:null;
}
const wusd=v=>{const x=Number(v)||0,a=Math.abs(x),s=x>0?'+':x<0?'−':'';return a>=1e6?`${s}$${+(a/1e6).toFixed(2)}M`:a>=1e3?`${s}$${+(a/1e3).toFixed(1)}K`:`${s}$${Math.round(a)}`};
/** 고래CVD ±5 item, then the six series in the FireCharts legend colours (주황 새우 / 초록 / 빨강 / 보라 / 갈색 고래 / 파랑 전체). */
export const WHALE_SERIES_KO=Object.freeze([['orange','새우'],['green','초록'],['red','빨강'],['purple','보라'],['brown','고래'],['blue','전체']]);
const zpx=v=>{const x=Number(v);return !(x>0)?'—':x>=1000?x.toLocaleString('en-US',{maximumFractionDigits:2}):x>=1?String(+x.toFixed(4)):String(+x.toPrecision(4))};
export function whaleItemHTML(points,rec,rule=''){
 const p=Number(points)||0,cls=`rz-i rz-whale ${p>0?'rz-whale-plus':p<0?'rz-whale-minus':'rz-whale-zero'}`;
 const why=rec?.code?reasonInfo(rec.code)?.label:null,zoneRule=rec?.rule==='ZONES';
 // 고래 매물대 records (2026-11-25 09:51) are labelled by the zone rule; older window-rule records keep "고래CVD".
 const item=tipHTML(`${zoneRule?'고래매물대':'고래CVD'} ${p>0?'+':p<0?'−':''}${Math.abs(p)}`,`${why?why+' — ':''}${rule}`,cls);
 const z=zoneRule?(rec.support&&p>0?rec.support:rec.resistance&&p<0?rec.resistance:rec.support??rec.resistance):null;
 const zchip=z?` <span class="wcv wcv-zone wcv-zone-${z.side==='BUY'?'buy':'sell'}">${z.side==='BUY'?'매수':'매도'} 매물대 ${esc(zpx(z.low))}~${esc(zpx(z.high))} ${esc(wusd(z.netUSD))}</span>`:'';
 const cov=zoneRule&&fin(rec.coveragePct)?` <small class="wcv-cov">${esc(+(Number(rec.lookbackMin)/60).toFixed(1))}시간 ${esc(rec.coveragePct)}% 읽음</small>`:'';
 const b=rec?.buckets;if(!b)return item+zchip+cov;
 const chip=(k,name)=>b[k]?`<span class="wcv wcv-${k}" title="${esc(reasonInfo('WHALE_'+k.toUpperCase())?.label||name)} CVD (${esc(WHALE_SRC)})">${esc(name)} ${esc(wusd(b[k].cvdUSD))}</span>`:'';
 const div=rec.shrimpDivergence?` <small class="wcv-div">새우↔고래 반대</small>`:'';
 return `${item}${zchip}${cov} <span class="wcv-row">${WHALE_SERIES_KO.map(([k,name])=>chip(k,name)).filter(Boolean).join(' ')}${div}</span>`;
}
/** "급변 5 · 4H 추세 0 · … / 합계 30 (기준 65 · D급)" with a tooltip per item (what it measures, max points). */
export function scoreItemsHTML(x,S={}){
 const sp=scoreParts(x);if(!sp)return '';
 const isBonus=k=>k==='oiBonus'||k==='cvdBonus'||k==='whaleBonus';
 const shown=k=>!isBonus(k)||fin(sp.parts[k])&&(sp.parts[k]>0||k==='whaleBonus');
 const items=sp.parts?SCORE_ITEMS.filter(([k])=>shown(k)).map(([k,label,max,rule])=>k==='whaleBonus'?whaleItemHTML(sp.parts[k],sp.whale,rule(S||{})):
  tipHTML(`${label} ${fin(sp.parts[k])?(isBonus(k)?'+':'')+Number(sp.parts[k]):'—'}`,`${rule(S||{})}${max?` (최대 ${max}점)`:''}`,max?scoreItemClass(sp.parts[k],max):'rz-i rz-i-full rz-w-lo')).join(' · '):'';
 const min=sp.min??(fin(S?.minScore)?Number(S.minScore):null),tier=scoreTier(sp.score,{...S,minScore:min});
 // The pass / fail line (the minimum score) is said in words too, not by colour alone.
 const pass=sp.score!=null&&min!=null?sp.score>=min:null;
 const total=sp.score!=null?`<span class="rz-total rz-g-${String(tier).replace('+','p')}${pass===false?' rz-fail':pass?' rz-pass':''}">합계 <b>${esc(sp.score)}</b> ${esc(tier)}급${pass!=null?` · ${pass?'통과':'미달'}`:''}</span>${min!=null?` <small>(기준 ${esc(min)})</small>`:''}`:'';
 return `<span class="rz-score">${items}${items&&total?' / ':''}${total}</span>`;
}

const TREND_KO={up:'4시간 상승 추세',down:'4시간 하락 추세',range:'4시간 횡보',flat:'4시간 횡보',null:'추세 자료 없음'};
const CODE_LIST=/^[A-Z][A-Z0-9_]+(?:\s*,\s*[A-Z][A-Z0-9_]+)*$/;
/** The detail of a skip row without repeating the main reason: codes become labels (each once), the score
 * becomes Korean items, a trend word becomes Korean; other text (numbers) stays. */
export function skipDetailHTML(x,S={}){
 if(x?.reason==='SCORE_BELOW_MINIMUM')return scoreItemsHTML(x,S);
 const d=x?.detail==null?'':String(x.detail).trim();if(!d)return '';
 if(TREND_KO[d])return `<small>${esc(TREND_KO[d])}</small>`;
 if(CODE_LIST.test(d)){
  const main=reasonCode(x.reason)||x.reason,seen=new Set([main]),out=[];
  for(const c of d.split(/\s*,\s*/)){const i=reasonInfo(c,S),k=i?.code||c;if(seen.has(k))continue;seen.add(k);out.push(i?tipHTML(i.label,i.desc,`rz rz-sub rz-c-${i.cat}`):`<small>${esc(c)}</small>`)}
  return out.join(' · ');
 }
 return `<small>${esc(d)}</small>`;
}

const SIDE_KO={LONG:'롱(급락 후 반등)',SHORT:'숏(급등 후 되돌림)'};
const ZONE_KO='4H·1D 매물대 근처에서 생긴 급변의 반전';
const px=v=>{const x=Number(v);if(!Number.isFinite(x)||x<=0)return '—';const a=Math.abs(x);return a>=1000?x.toLocaleString('en-US',{maximumFractionDigits:2}):a>=1?String(+x.toFixed(4)):String(+x.toPrecision(4))};
/** Shared head of a row: symbol, kind / trigger badges, direction, move size. */
function headHTML(x,when,entered=false){
 const pump=x.trigger==='PUMP_ALERT'||reasonInfo(x.reason)?.cat==='pump';
 return `<span class="muted">${esc(when(x.at))}</span><b>${esc(x.symbol||'')}</b>${x.kind==='ZONE_REVERSAL'?` ${tipHTML(entered?'매물대 반전':'매물대 후보',ZONE_KO,'rz-badge')}`:''}${pump?` ${tipHTML('급변 알림','텔레그램 급변 알림(공습경보)으로 들어온 코인','rz-badge')}`:''}${x.direction?` <b class="${x.direction==='LONG'?'pos':'neg'}">${SIDE_KO[x.direction]||esc(x.direction)}</b>`:''}${fin(x.movePct)?` <small>${esc(Number(x.movePct).toFixed(1))}% 움직임</small>`:''}`;
}
/** One skip row (status().skips): main reason label + its detail, each with an explanation. */
export function skipRowHTML(x,S={},when=t=>t){
 const detail=skipDetailHTML(x,S);
 return `<li class="rz-row">${headHTML(x,when)} · ${reasonHTML(x.reason,S)}${detail?` — ${detail}`:''}</li>`;
}
/** 카피식 추매 one line (status().positions[].ladderView or an event's ladder view): "3/6 단계 · 평단 … · 다음 추매 …".
 * Text only (the screen and Telegram both use it). */
export function ladderStepText(v,{fmt=px}={}){
 if(!v||!Number.isFinite(Number(v.step)))return '';
 const z=v.nextAdd?.zone,zone=z?` (강한 매물대 ${(z.why||[]).map(c=>reasonLabel(c)).join('·')||''} · 2배)`:'';
 const next=v.nextAdd&&Number(v.nextAdd.price)>0?`다음 추매 ${fmt(v.nextAdd.price)}${zone}`:Number(v.step)>=Number(v.of)?'추매 끝 · 마지막 선만 남음':'다음 추매 없음';
 return `${v.step}/${v.of} 단계 · 평단 ${fmt(v.avg)} · ${next}`;
}
/** One entry row (an OPENED event): why it entered — kind / trigger, direction, score items, targets / stop. */
export function enteredRowHTML(e,S={},when=t=>t){
 const tg=(e.targets||[]).filter((t,i)=>!(Array.isArray(e.parts)&&e.parts.length)||e.parts[i]>0).map(px).join(' / ');
 const stop=e.stopLossEnabled===false?'자동 손절 없음':`손절 ${px(e.stop)}`;
 const score=scoreItemsHTML(e,S);
 if(e.management==='TRADER_LADDER'&&e.ladder)return `<li class="rz-row rz-entered"><span class="rz-in">진입</span> ${headHTML(e,when,true)} · 진입 ${px(e.entry)} · 카피식 추매 ${esc(ladderStepText(e.ladder))} · 익절 ${px(e.ladder.tpPrice)}${score?` — ${score}`:''}</li>`;
 return `<li class="rz-row rz-entered"><span class="rz-in">진입</span> ${headHTML(e,when,true)} · 진입 ${px(e.entry)}${tg?` · 목표 ${tg}`:''} · ${stop}${score?` — ${score}`:''}</li>`;
}

/** The collapsed "사유 설명 보기" body: every code once, grouped by category, with live thresholds. */
export function reasonGlossaryHTML(S={}){
 const s=S||{};
 return REASON_CATEGORIES.map(([cat,title])=>{
  const dt=`<dt class="rz-c-${cat}">`;
  const rows=cat==='score'
   ?[...REASON_CODES.filter(c=>G[c][0]==='score').map(c=>[G[c][1],G[c][2](s)]),...SCORE_ITEMS.map(([,label,max,rule])=>[`${label}${max?` (최대 ${max}점)`:''}`,rule(s)])]
   :REASON_CODES.filter(c=>G[c][0]===cat).map(c=>[G[c][1],G[c][2](s)]);
  return `<details class="rz-cat"><summary>${esc(title)} <small>${rows.length}개</small></summary><dl class="rz-gloss">${rows.map(([l,d])=>`${dt}${esc(l)}</dt><dd>${esc(d)}</dd>`).join('')}</dl></details>`;
 }).join('');
}

/** Tap-to-expand for phones (title covers hover): one small bubble under the tapped label. */
export function bindReasonTips(root=globalThis.document){
 if(!root||root.__rzTips)return;root.__rzTips=true;
 let tip=null,anchor=null,shownAt=0;const hide=()=>{if(tip){tip.remove();tip=null;anchor=null}};
 const place=()=>{if(!tip||!anchor)return;const r=anchor.getBoundingClientRect(),vw=root.documentElement.clientWidth,vh=root.documentElement.clientHeight;
  tip.style.maxWidth=Math.min(320,vw-32)+'px';tip.style.left=Math.max(16,Math.min(r.left,vw-16-tip.offsetWidth))+'px';
  tip.style.top=(r.bottom+6+tip.offsetHeight>vh-8?Math.max(8,r.top-6-tip.offsetHeight):r.bottom+6)+'px'};
 const show=el=>{hide();shownAt=Date.now();anchor=el;tip=root.createElement('div');tip.className='rz-tip';tip.setAttribute('role','tooltip');tip.textContent=el.dataset.tip;
  root.body.appendChild(tip);place()};
 root.addEventListener('click',ev=>{const el=ev.target?.closest?.('[data-tip]');if(!el){hide();return}if(tip&&tip.dataset.for===el.dataset.tip){hide();return}show(el);tip.dataset.for=el.dataset.tip},true);
 root.addEventListener('keydown',ev=>{if(ev.key==='Escape')hide();if((ev.key==='Enter'||ev.key===' ')&&ev.target?.dataset?.tip){ev.preventDefault();show(ev.target)}});
 // A scroll hides the bubble (it is fixed to the screen), except the scroll the tap itself caused.
 root.addEventListener('scroll',()=>{if(Date.now()-shownAt>400)hide();else place()},{passive:true,capture:true});
}
