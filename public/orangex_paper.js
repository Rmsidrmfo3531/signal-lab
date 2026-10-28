// Display only: this module has no transport, storage access or trading controls.
const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const rows=value=>Array.isArray(value)?value:[];
const esc=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const numeric=value=>typeof value==='number'&&Number.isFinite(value)?value:null;
const number=value=>numeric(value)===null?'—':value.toLocaleString('en-US',{maximumFractionDigits:8});
const money=value=>numeric(value)===null?'미확인':`${value<0?'-':''}$${Math.abs(value).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:6})}`;
const percent=value=>numeric(value)===null?'미확인':`${number(value)}%`;
const clock=value=>numeric(value)!==null&&value>0&&Number.isFinite(new Date(value).getTime())?new Date(value).toLocaleString('ko-KR',{timeZone:'Asia/Seoul',hour12:false}):'시각 미확인';
const instrument=value=>typeof value==='string'&&/^[A-Z0-9]{2,20}-[A-Z0-9]{2,12}-PERPETUAL$/.test(value)?value:'계약명 미확인';
const direction=value=>['LONG','SHORT'].includes(value)?value:'방향 미확인';
const orderType=value=>({MARKET:'시장가 모의체결',LIMIT:'지정가 모의체결'}[value]||'체결 방식 미확인');
const empty=message=>`<p class="orangex-empty">${esc(message)}</p>`;
const cell=value=>`<td>${esc(value)}</td>`;
const statistic=(label,value)=>`<div><span>${esc(label)}</span><strong>${esc(value)}</strong></div>`;
const fact=(label,value)=>`<div><dt>${esc(label)}</dt><dd>${esc(value)}</dd></div>`;
const reasons={
 REAL_DATA_DISABLED:'실제 시장 데이터 자동 진입 OFF',REAL_DATA_ENTRY_DISABLED:'실제 시장 데이터 자동 진입 OFF',
 REAL_DATA_AUTO_ENTRY_DISABLED:'실제 시장 데이터 자동 진입 OFF',
 DATA_SOURCE_NOT_ALLOWED:'허용되지 않은 시세 출처',SYNTHETIC_ONLY:'합성 데이터 전용 시뮬레이션',
 UNCONFIGURED:'오프라인 위험 설정 미완료',SETTINGS_UNCONFIGURED:'오프라인 위험 설정 미완료',
 CONTRACT_UNVERIFIED:'계약 단위 미검증',CONTRACT_UNITS_UNVERIFIED:'계약 단위 미검증',CONTRACT_MISSING:'계약 규격 미설정',
 FEES_UNVERIFIED:'수수료 단위 미검증',FUNDING_UNVERIFIED:'펀딩 비용 미검증',
 QUOTE_STALE:'호가 시세 지연',BOOK_STALE:'호가 시세 지연',MARK_STALE:'Mark Price 시세 지연',
 BOOK_INVALID:'호가 구조 오류',BOOK_INTEGRITY_FAILED:'호가 잔량 검증 실패',INSUFFICIENT_DEPTH:'호가 잔량 부족',
 DUPLICATE_SIGNAL:'중복 시그널 차단',DUPLICATE_POSITION:'동일 계약 중복 진입 차단',
 MAX_POSITIONS:'동시 포지션 한도',POSITION_LIMIT:'동시 포지션 한도',RISK_LIMIT:'거래당 손실 한도',
 DAILY_LOSS_LIMIT:'일일 손실 한도',EXPOSURE_LIMIT:'총 노출 한도',INSUFFICIENT_MARGIN:'가상 증거금 부족',
 INVALID_SIGNAL:'확정 시그널 검증 실패',SIGNAL_EXPIRED:'시그널 유효기간 종료',SIGNAL_STALE:'시그널 유효기간 종료',
 STOP_INVALIDATED:'손절선 무효화',INVALID_STOP:'손절선 검증 실패',PRICE_DEVIATION:'진입 기준가 이탈',
 MIN_QUANTITY:'최소 수량 미달',MIN_NOTIONAL:'최소 명목금액 미달',QUANTITY_STEP:'수량 증분 불일치',
 KILL_SWITCH:'신규 진입 긴급 중지',STORAGE_UNHEALTHY:'기록 저장 실패 · 신규 진입 중지',
 STORAGE_ERROR:'기록 저장 실패 · 신규 진입 중지',RECOVERY_REQUIRED:'기록 복구 확인 필요',
 NETWORK_UNAVAILABLE:'시세 공급 중단',MARKET_UNAVAILABLE:'시장 데이터 미확인',LIMIT_EXPIRED:'지정가 주문 유효기간 종료',
 PAPER_SETTINGS_UNCONFIGURED:'오프라인 자본금·위험 설정 미완료',TECHNICAL_UNQUALIFIED:'확정 1H·4H 필수 기술 조건 미충족',
 CONTRACT_UNOBSERVED:'합성 계약 규격 미설정',CONTRACT_NAME_INVALID:'계약 이름 검증 실패',
 CONTRACT_SIZE_UNVERIFIED:'계약 크기 미검증',ORDER_UNITS_UNVERIFIED:'최소량·증분·호가 단위 미검증',
 SYMBOL_MAPPING_UNVERIFIED:'원 신호와 계약 종목 대응 미확인',LIMIT_PRICE_INVALID:'지정가·호가 단위 검증 실패',
 PRICE_GRID_MISMATCH:'신호 가격의 호가 단위 불일치',TARGET_INVALID:'익절 목표가 검증 실패',
 BOOK_UNOBSERVED:'호가 배열 미관측',BOOK_REPLAY:'같거나 과거인 호가 재사용 차단',BOOK_CROSSED:'매수·매도 호가 역전',
 MARKET_GRID_MISMATCH:'호가 가격·수량 증분 불일치',PORTFOLIO_VALUATION_STALE:'기존 포지션 평가 시세 지연',
 FUNDING_EVENTS_MISSING:'정산 시각의 펀딩 이벤트 누락',SIGNAL_INVALIDATED:'진입 전 손절선·목표가 통과',
 ENTRY_ZONE:'진입 허용 구간 이탈',RISK_OR_MINIMUM_CONFLICT:'손실 한도와 최소 거래·분할 수량 충돌',
 SPREAD_LIMIT:'호가 스프레드 한도',SPLIT_MINIMUM_CONFLICT:'분할 청산의 최소 수량·금액 미달',
 SLIPPAGE_LIMIT:'잔량 기반 슬리피지 한도',FUNDING_EVENT_INVALID:'펀딩 이벤트 구조 검증 실패',
 FUNDING_SCHEDULE_INVALID:'펀딩 정산 시각 검증 실패',SIGNAL_NORMALIZATION_FAILED:'기존 최종 시그널 검증 실패',
 BOOK_DUPLICATE_PRICE:'호가 가격 중복',BOOK_UNSORTED:'호가 순서 역전',BOOK_DEPTH_EXCEEDED:'요청 깊이보다 많은 호가',BOOK_LEVELS_INVALID:'호가 가격·수량 구조 오류',
 CONSECUTIVE_LOSS_LIMIT:'연속 손실 한도 · 신규 진입 중지',CONNECTION_LOST:'시세 연결 단절 · 신규 진입 중지',
 CONNECTION_DISCONNECTED:'시세 연결 단절 · 신규 진입 중지',EXECUTION_MODE_BLOCKED:'현재 실행 모드의 모의체결 차단',
 EXECUTION_MODE_DISABLED:'현재 실행 모드의 모의체결 차단',EXECUTION_MODE_NOT_ALLOWED:'현재 실행 모드의 모의체결 차단',
 POSITION_MARGIN_LIMIT:'포지션 증거금 한도',TOTAL_MARGIN_LIMIT:'전체 증거금 한도',MARGIN_LIMIT:'가상 증거금 한도'
};
const reason=value=>typeof value==='string'&&Object.hasOwn(reasons,value)?reasons[value]:'검증 조건 미충족 · 서버 기록 확인 필요';
const eventNames={OPEN:'가상 진입',ENTRY_PARTIAL:'진입 부분 체결',PARTIAL_ENTRY:'진입 부분 체결',
 LIMIT_PLACED:'지정가 대기',ORDER_PLACED:'모의 주문 대기',CANCEL:'모의 주문 취소',CANCELLED:'모의 주문 취소',
 TP1:'1차 익절 · 40%',TP2:'2차 익절 · 35%',TP3:'3차 익절 · 25%',STOP:'손절',CLOSE:'CLOSE',
 FUNDING:'펀딩 정산',RECOVERED:'저장 포지션 복구',REJECT:'진입 거부',MARKET_STALE:'시세 지연',
 CONFIGURED:'오프라인 설정 저장',CONTRACT_SET:'합성 계약 규격 저장',CONTRACT_CONFIGURED:'합성 계약 규격 저장',
 SIGNAL_ACCEPTED:'확정 신호 접수',ENTRY_REMAINDER_CANCELLED:'시장가 미체결 잔량 취소',ENTRY_CANCELLED:'모의 진입 대기 취소',
 ENTRY_EXPIRED:'모의 진입 대기 만료',ALL_TARGETS:'전체 목표가 도달',TIME_LIMIT:'보유 시간 한도 종료',
 CLOSE_WAITING_FOR_FRESH_BOOK:'CLOSE 대기 · 신선한 호가 필요',STOP_RISK_OVERRUN:'손절 갭 · 계획 위험액 초과',
 CONNECTION_LOST:'모의 시세 연결 단절',CONNECTION_RESTORED:'모의 시세 연결 복구'};
const eventName=value=>typeof value==='string'&&Object.hasOwn(eventNames,value)?eventNames[value]:'모의매매 상태 기록';
const stages={SIGNAL:'시그널',SOURCE:'자료 출처',TECHNICAL:'필수 기술 조건',CONTRACT:'계약 규격',MARKET:'시장 데이터',BOOK:'호가',RISK:'위험 한도',
 ENTRY:'진입',EXECUTION:'모의체결',FUNDING:'펀딩',STORAGE:'저장',RECOVERY:'복구'};
const stage=value=>typeof value==='string'&&Object.hasOwn(stages,value.toUpperCase())?stages[value.toUpperCase()]:'검증';
const storageLabels={ABSENT:'PAPER 기록 미생성',UNINITIALIZED:'PAPER 기록 미생성',NOT_CREATED:'PAPER 기록 미생성',
 NOT_FOUND:'PAPER 기록 미생성',READY:'분리된 PAPER 저장소 확인',OK:'분리된 PAPER 저장소 확인',
 READ_ONLY:'분리된 PAPER 기록 조회 전용',LOADED:'분리된 PAPER 기록 조회 완료',
 ERROR:'PAPER 저장소 오류 · 기존 파일 보존',CORRUPT:'PAPER 기록 구조 오류 · 기존 파일 보존',
 BLOCKED:'PAPER 저장소 접근 차단',LOCKED:'다른 프로세스가 PAPER 기록 사용 중'};

const executionModes={SYNTHETIC_TEST:'SYNTHETIC_TEST · 합성 데이터 검증',
 HISTORICAL_REPLAY:'HISTORICAL_REPLAY · 과거 데이터 분석 재생 · 모의체결 OFF',
 LIVE_MARKET_PAPER:'LIVE_MARKET_PAPER · 실제 시세 모의매매 OFF · 별도 검증·승인 필요'};
const runKinds={BACKTEST:'BACKTEST · 백테스트 기록',FORWARD_PAPER:'FORWARD_PAPER · 순방향 PAPER 기록'};
function contextView(value={},fallback={}){
 const executionMode=value.executionMode??fallback.executionMode,runKind=value.runKind??fallback.runKind;
 return {executionMode,runKind,modeLabel:Object.hasOwn(executionModes,executionMode)?executionModes[executionMode]:'실행 모드 미확인 · 모의체결 차단',
  runLabel:Object.hasOwn(runKinds,runKind)?runKinds[runKind]:'결과 구분 미확인 · 성과 합산 금지',
  valid:Object.hasOwn(executionModes,executionMode)&&Object.hasOwn(runKinds,runKind)};
}
const ratio=value=>numeric(value)===null?'미확인':`${number(value)}배`;
const duration=value=>numeric(value)===null||value<0?'미확인':value<60000?`${number(value/1000)}초`:
 value<3600000?`${number(value/60000)}분`:`${number(value/3600000)}시간`;
const count=value=>numeric(value)!==null&&Number.isSafeInteger(value)&&value>=0?number(value):'미확인';
const metricList=[
 ['totalTrades','총 종료 거래 횟수',count],['winRatePct','승률',percent],
 ['averagePlannedRR','평균 계획 손익비',ratio],['averageRealizedR','평균 실현 R 배수',ratio],
 ['averageWinLossRatio','평균 이익 / 평균 손실',ratio],
 ['profitFactor','Profit Factor',ratio],['maxDrawdownUSD','최대 낙폭 · 현금 흐름 MDD',money],
 ['maxDrawdownPct','최대 낙폭 비율',percent],['averageHoldingMs','평균 보유 시간',duration],
 ['grossPnLUSD','체결 손익 · 수수료·펀딩 전',money],['afterFeesPnLUSD','수수료 차감 후 손익',money],
 ['netPnLUSD','비용 반영 순손익',money],['feesUSD','수수료 합계',money],
 ['fundingUSD','펀딩 비용 합계',money],['slippageUSD','잔량 슬리피지 비용',money],
 ['spreadCostUSD','매수·매도 스프레드 비용',money],['frictionlessPnLUSD','슬리피지·스프레드 전 비교 손익',money],
 ['currentLossStreak','현재 연속 손실',count],['maxLossStreak','최대 연속 손실',count],
 ['expectancyUSD','거래당 평균 기대값',money]
];
const netMetrics=new Set(['winRatePct','averageRealizedR','averageWinLossRatio','profitFactor','maxDrawdownUSD','maxDrawdownPct',
 'netPnLUSD','fundingUSD','currentLossStreak','maxLossStreak','expectancyUSD']);
function performanceMetric(metric,key,format,{invalid=false,incomplete=false}={}){
 if(invalid)return '원장 검증 실패';
 if(incomplete&&netMetrics.has(key))return '비용 미검증';
 return format(metric?.[key]);
}

export function orangeXPaperPerformanceView(performance={}, {executionMode,runKind,recordsUnavailable=false}={}){
 const data=plain(performance)?performance:{},metrics=plain(data.metrics)?data.metrics:{},sample=plain(data.sample)?data.sample:{};
 const context=contextView(data,{executionMode,runKind});
 const contextMismatch=executionMode!==undefined&&data.executionMode!==undefined&&executionMode!==data.executionMode||
  runKind!==undefined&&data.runKind!==undefined&&runKind!==data.runKind;
 const observed=data.kind==='ORANGEX_PAPER_PERFORMANCE'&&plain(data.metrics)&&plain(data.audit)&&
  typeof data.audit.valid==='boolean'&&typeof data.audit.complete==='boolean'&&context.valid&&!contextMismatch;
 const invalid=recordsUnavailable||data.audit?.valid===false,incomplete=data.audit?.complete===false;
 const minSample=numeric(sample.minSampleSize)!==null&&Number.isSafeInteger(sample.minSampleSize)&&sample.minSampleSize>0?sample.minSampleSize:null;
 const trades=numeric(sample.tradeCount)!==null&&Number.isSafeInteger(sample.tradeCount)&&sample.tradeCount>=0?sample.tradeCount:null;
 const sufficient=minSample!==null&&trades!==null&&trades>=minSample&&sample.sufficient===true;
 const status=recordsUnavailable?'성과 기록 조회 실패 · 기존 원장 보존':contextMismatch?'실행 모드·결과 구분 불일치 · 성과 표시 차단':!observed?'성과 분석 자료 미확인 · 전략 검증 미완료':
  `${context.modeLabel} · ${context.runLabel} · 표본 ${count(trades)}건 / 참고 기준 ${count(minSample)}건 · ${sufficient?'참고 표본 기준 충족':'표본 부족'} · 전략 검증 미완료`+
  (invalid?' · 원장 검증 실패':incomplete?' · 비용 정산 미완료':'')+' · 합성 성과를 실제 거래소 수익률로 해석하지 마세요.';
 const value=(metric,key,format,flags={})=>!observed?'미확인':performanceMetric(metric,key,format,{invalid,incomplete,...flags});
 const metricHTML=metricList.map(([key,label,format])=>statistic(label,value(metrics,key,format))).join('');
 const groupHTML=(key,label)=>{
  const metric=plain(data[key])?data[key]:{};
  return Object.entries(label).map(([name,title])=>{
   const group=plain(metric[name]?.metrics)?metric[name].metrics:plain(metric[name])?metric[name]:{};
   const flags={invalid:invalid||metric[name]?.auditValid===false,incomplete:incomplete||metric[name]?.complete===false};
   return `<article class="orangex-paper-performance-group"><h5>${esc(title)}</h5><dl>`+
    [['totalTrades','종료 거래',count],['winRatePct','승률',percent],['netPnLUSD','비용 반영 손익',money],
     ['averageRealizedR','평균 실현 R',ratio],['profitFactor','Profit Factor',ratio],['expectancyUSD','평균 기대값',money]]
     .map(([field,title,format])=>fact(title,value(group,field,format,flags))).join('')+'</dl></article>';
  }).join('');
 };
 const periodHTML=[['daily','일별',/^\d{4}-\d{2}-\d{2}$/],['weekly','주별',/^\d{4}-W\d{2}$/],['monthly','월별',/^\d{4}-\d{2}$/]]
  .map(([key,label,pattern])=>{
   const entries=observed?rows(data.periods?.[key]).filter(row=>plain(row)&&typeof row.period==='string'&&pattern.test(row.period)).slice(-60).reverse():[];
   return `<article class="orangex-paper-period"><h5>${label} 손익 · 한국 시간</h5><div class="table-scroll"><table class="orangex-table orangex-paper-period-table">`+
    '<thead><tr><th>기간</th><th>비용 반영 손익</th><th>종료 거래</th></tr></thead><tbody>'+
    (entries.map(row=>`<tr>${cell(row.period)}${cell(invalid?'원장 검증 실패':incomplete?'비용 미검증':money(row.netPnLUSD??row.pnlUSD))}${cell(invalid?'미확인':count(row.tradeCount))}</tr>`).join('')||
     '<tr><td colspan="3" class="orangex-empty">기간별 성과 자료 미확인</td></tr>')+'</tbody></table></div></article>';
  }).join('');
 return {status,contexts:`${context.modeLabel} · ${context.runLabel} · 백테스트와 순방향 기록은 합산하지 않습니다.`,
  metrics:metricHTML,directions:groupHTML('directions',{LONG:'LONG 성과',SHORT:'SHORT 성과'}),
  assets:groupHTML('assets',{BTC:'BTC 성과',ETH:'ETH 성과',SOL:'SOL 성과'}),periods:periodHTML,
  strategyValidated:false,executionMode:context.executionMode,runKind:context.runKind};
}

const fillAccuracyLabels={SYNTHETIC_MODEL_ONLY:'합성 호가 체결 모형 · 실제 체결 정확도 검증 아님',
 UNVERIFIED_NO_HISTORICAL_DEPTH:'과거 호가 없음 · 체결 정확도 미검증',
 UNVERIFIED_HISTORICAL_DEPTH_NOT_EXECUTED:'과거 호가 관측 · 실제 과거 모의체결은 실행하지 않음'};
export function orangeXPaperReplayView(payload={}){
 const data=plain(payload)?payload:{},result=plain(data.result)?data.result:{},summary=plain(result.summary)?result.summary:{};
 const context=contextView(data,{executionMode:result.executionMode,runKind:result.runKind??'BACKTEST'});
 const error=data.status==='ERROR'||data._stale===true,observed=!error&&data.status==='OBSERVED'&&
  result.kind==='ORANGEX_PAPER_REPLAY_RESULT'&&context.valid&&context.runKind==='BACKTEST'&&result.runKind==='BACKTEST'&&
  result.executionMode===context.executionMode;
 const origin=result.dataSource==='SYNTHETIC_FIXTURE'?'합성 자료 · 실제 과거 실측 아님':
  result.dataSource==='USER_SUPPLIED_HISTORICAL_UNVERIFIED_ORIGIN'?'사용자 제공 과거 자료 · 출처 독립 검증 미완료':'자료 출처 미확인';
 const status=error?'백테스트 기록 조회 실패 · 이전 결과와 원본 보존':!observed?'백테스트 기록 미등록 · 순방향 PAPER 손익과 분리':
  `${context.modeLabel} · BACKTEST · ${origin} · ${fillAccuracyLabels[result.fillAccuracy]??'체결 정확도 미검증'} · 실제 데이터 자동 진입 OFF`;
 const replayMetrics=[['analysisCount','1H·4H 분석 횟수'],['patterns','확정 패턴 관측'],['technicalPassed','기술 조건 통과'],
  ['finalApproved','최종 시그널 관측'],['marketSamples','호가 표본'],['trades','종료 모의 거래']]
  .map(([key,label])=>statistic(label,observed?count(summary[key]):'미확인')).join('');
 const signals=observed?rows(result.signals).slice(-100).reverse().map(row=>`<tr>${cell(direction(row?.direction))}`+
  `${cell(clock(row?.signalDetectedAt))}${cell(clock(row?.entryEligibleAt))}${cell(row?.technicalQualified===true?'통과':'미통과')}`+
  `${cell(row?.finalApproved===true?'관측':'미승인')}${cell(row?.entryAccepted===true?'등록 · 체결 확인과 별도':'등록 안 됨')}</tr>`).join(''):'';
 return {status,summary:replayMetrics,signals:signals||'<tr><td colspan="6" class="orangex-empty">재생 시그널 관측 자료 미확인</td></tr>',
  performance:orangeXPaperPerformanceView(observed?result.performance:{},{executionMode:context.executionMode,runKind:'BACKTEST',recordsUnavailable:error}),
  observed};
}

function positionCard(item,{now,maxAgeMs,closed=false,valuationStale=false,unverifiedFunding=false}={}){
 const stale=!closed&&(valuationStale||item?.valuationStale===true||numeric(item?.lastPriceAt)===null||item.lastPriceAt>now+5000||now-item.lastPriceAt>maxAgeMs||
  numeric(item?.markPriceAt)!==null&&(item.markPriceAt>now+5000||now-item.markPriceAt>maxAgeMs));
 const fundingPending=unverifiedFunding||item?.fundingComplete===false||item?.settlementStatus==='AWAITING_FUNDING';
 const targets=rows(item?.targets).slice(0,3).map((value,index)=>`${index+1}차 ${number(value)} · ${[40,35,25][index]}%`).join(' / ')||'목표가 미설정';
 const parts=rows(item?.exitParts).slice(-20).map(part=>`<li>${esc(eventName(part?.type))} · 수량 ${esc(number(part?.quantity))} · 체결가 ${esc(number(part?.price))} · 수수료 ${esc(money(part?.feeUSD))} · ${esc(clock(part?.at))}</li>`).join('');
 return `<article class="orangex-paper-position"><header><strong>${esc(instrument(item?.instrumentName))} · ${esc(direction(item?.direction))}</strong>`+
  `<small>${closed?`CLOSE · ${esc(eventName(item?.closeReason))}`:stale?'시세 지연 · 마지막 평가값':'오프라인 가상 포지션'}${item?.recovered===true?' · 재시작 복구':''}${fundingPending?' · 펀딩 정산 대기':''}</small></header>`+
  `<dl>${fact('가상 진입가',number(item?.entryPrice))}${fact('마지막 Mark',number(item?.markPrice))}`+
  `${fact('잔여 / 최초 수량',`${number(item?.quantityRemaining)} / ${number(item?.quantityOriginal)}`)}`+
  `${fact('레버리지 / 가상 증거금',`${number(item?.leverage)}x / ${money(item?.marginUSD)}`)}`+
  `${fact('손절가',number(item?.stop))}${fact('실현 PNL',fundingPending?'비용 미검증':money(item?.realizedPnLUSD))}`+
  `${fact(stale?'미실현 PNL · 이전 평가':'미실현 PNL',money(item?.unrealizedPnLUSD))}`+
  `${fact('누적 수수료',money(item?.feesUSD))}${fact('누적 펀딩 비용',fundingPending?'미검증 · 정산 대기':money(item?.fundingUSD))}</dl>`+
  `<p class="orangex-paper-targets">${esc(targets)}</p><p>진입 ${esc(clock(item?.openedAt))} · ${closed?'종료 '+esc(clock(item?.closedAt)):'시세 '+esc(clock(item?.lastPriceAt))}</p>`+
  (plain(item?.gapStopExceeded)&&numeric(item.gapStopExceeded.overrunUSD)!==null&&item.gapStopExceeded.overrunUSD>0?
   `<p class="orangex-paper-gap">손절 갭 · 계획 손실 ${esc(money(item.gapStopExceeded.plannedRiskUSD))} / 모의 손실 ${esc(money(item.gapStopExceeded.realizedLossUSD))} / 초과 ${esc(money(item.gapStopExceeded.overrunUSD))}</p>`:'')+
  (parts?`<details><summary>분할 익절·손절 모의체결</summary><ul>${parts}</ul></details>`:'<p>분할 청산 기록 없음</p>')+'</article>';
}

export function orangeXPaperView(payload={}, {now=Date.now()}={}){
 const data=plain(payload)?payload:{},settings=plain(data.settings)?data.settings:{},summary=plain(data.summary)?data.summary:{};
 const risk=plain(data.risk)?data.risk:{};
 const unavailable=data.recordsUnavailable===true,unverifiedFunding=summary.unverifiedFunding===true;
 const synthetic=data.dataSource==='SYNTHETIC_FIXTURE',configured=data.configured===true||numeric(settings.capitalUSD)!==null;
 const unexpectedMode=data.mode!==undefined&&data.mode!=='PAPER_OFFLINE';
 const source=synthetic?'합성 테스트 데이터 · 실제 거래소 체결 아님':data.dataSource==='UNOBSERVED'||!data.dataSource?
  '오프라인 PAPER 기록 미생성':'허용되지 않은 자료 출처 · 실제 자동 진입 차단';
 const interrupted=data._stale===true?'조회 갱신 실패 · 이전에 확인한 PAPER 기록입니다. ':'';
 const mode=unexpectedMode?'지원하지 않는 모드 · 주문 차단':'PAPER_OFFLINE · 오프라인 시뮬레이션';
 const context=contextView(data,{executionMode:synthetic?'SYNTHETIC_TEST':undefined,runKind:synthetic?'FORWARD_PAPER':undefined});
 const performance=orangeXPaperPerformanceView(data.performance,{executionMode:context.executionMode,runKind:context.runKind,recordsUnavailable:unavailable});
 const state=interrupted||unavailable?'orangex-paper-stale':synthetic&&configured?'orangex-paper-observed':'orangex-paper-unconfigured';
 const notice=`${interrupted}${unavailable?'PAPER 기록 조회 실패 · 기존 파일 보존. ':''}${mode} · ${source} · 실제 데이터 자동 진입 OFF · LIVE 주문 없음`;
 const maxAgeMs=numeric(settings.maxQuoteAgeMs)!==null&&settings.maxQuoteAgeMs>0?settings.maxQuoteAgeMs:90000;
 const settingsView=[['모의 자본금',money(settings.capitalUSD)],['레버리지',numeric(settings.leverage)===null?'미설정':number(settings.leverage)+'x'],
  ['거래당 최대 손실',money(settings.maxRiskUSD)],['일일 최대 손실',money(settings.dailyLossLimitUSD)],
  ['동시 포지션 한도',numeric(settings.maxPositions)===null?'미설정':number(settings.maxPositions)+'개'],
  ['포지션 명목 한도',money(settings.maxPositionNotionalUSD)],['총 명목 한도',money(settings.maxTotalNotionalUSD)],
  ['연속 손실 중지 한도',numeric(settings.maxConsecutiveLosses)===null?'미설정':number(settings.maxConsecutiveLosses)+'회'],
  ['포지션 증거금 한도',numeric(settings.maxPositionMarginUSD)===null?numeric(risk.positionMarginLimitUSD)===null?'명목 한도·레버리지에서 산정':`${money(risk.positionMarginLimitUSD)} · 명목 한도에서 산정`:money(settings.maxPositionMarginUSD)],
  ['전체 증거금 한도',numeric(settings.maxTotalMarginUSD)===null?numeric(risk.totalMarginLimitUSD)===null?'명목 한도·레버리지에서 산정':`${money(risk.totalMarginLimitUSD)} · 명목 한도에서 산정`:money(settings.maxTotalMarginUSD)],
  ['모의 시세 연결',risk.connection?.connected===true?'연결 관측':risk.connection?.connected===false?'연결 단절 · 신규 진입 중지':'미확인'],
  ['신규 진입 위험 상태',risk.entryBlockReason?reason(risk.entryBlockReason):'실제 데이터 진입 OFF · 합성 조건 별도 검사'],
  ['신규 진입 긴급 중지',settings.killSwitch===true?'ON · 신규 모의 진입 차단':settings.killSwitch===false?'OFF · 합성 데이터에만 적용':'미설정']]
  .map(([label,value])=>statistic(label,value)).join('');
 const uninitialized=!synthetic||!configured;
 const net=value=>unavailable?'조회 실패':uninitialized?'미설정':unverifiedFunding?'비용 미검증':money(value);
 const summaryView=[['가상 자산 평가액',net(summary.equityUSD)],['사용 가능 가상 증거금',net(summary.availableMarginUSD)],
  ['실현 PNL · 비용 반영',net(summary.realizedPnLUSD)],['미실현 PNL · 마지막 Mark 평가',unavailable?'조회 실패':uninitialized?'미설정':money(summary.unrealizedPnLUSD)],
  ['총 PNL',net(summary.totalPnLUSD)],['당일 PNL',net(summary.dailyPnLUSD)],['수수료 합계',unavailable?'조회 실패':uninitialized?'미설정':money(summary.feesUSD)],
  ['펀딩 비용 합계',unavailable?'조회 실패':uninitialized?'미설정':unverifiedFunding?'미검증 · PNL 확정 불가':money(summary.fundingUSD)],
  ['종료 거래 / 승률',unavailable?'조회 실패':uninitialized?'미설정':`${number(summary.closedCount)} / ${unverifiedFunding?'비용 미검증':percent(summary.winRatePct)}`],['최대 낙폭',net(summary.maxDrawdownUSD)]]
  .map(([label,value])=>statistic(label,value)).join('');
 const pending=unavailable?'<tr><td colspan="7" class="orangex-empty">PAPER 기록 조회 실패 · 대기 주문 유무를 확인할 수 없습니다. 기존 파일을 보존합니다.</td></tr>':rows(data.pending).slice(0,100).map(item=>`<tr>${cell(instrument(item?.instrumentName))}${cell(direction(item?.direction))}`+
  `${cell(orderType(item?.orderType))}${cell(number(item?.limitPrice))}${cell(number(item?.quantityRequested))}`+
  `${cell(number(item?.quantityRemaining))}${cell(clock(item?.expiresAt))}</tr>`).join('')||'<tr><td colspan="7" class="orangex-empty">모의 진입 대기 기록이 없습니다.</td></tr>';
 const open=unavailable?empty('PAPER 기록 조회 실패 · 진행 포지션 유무를 확인할 수 없습니다. 기존 파일을 보존합니다.'):rows(data.open).slice(0,100).map(item=>positionCard(item,{now,maxAgeMs,unverifiedFunding,valuationStale:summary.valuationStale===true})).join('')||empty('진행 중인 OrangeX PAPER 포지션 기록이 없습니다. 실제 계좌 포지션과 다릅니다.');
 const closed=unavailable?empty('PAPER 기록 조회 실패 · 종료 거래 유무를 확인할 수 없습니다. 기존 파일을 보존합니다.'):rows(data.closed).slice(-100).reverse().map(item=>positionCard(item,{now,maxAgeMs,unverifiedFunding,closed:true})).join('')||empty('종료된 OrangeX PAPER 거래 기록이 없습니다.');
 const events=unavailable?'<li>PAPER 기록 조회 실패 · 모의체결 이력 미확인</li>':rows(data.events).slice(-100).reverse().map(item=>`<li><strong>${esc(eventName(item?.type))} · ${esc(instrument(item?.instrumentName))}</strong>`+
  `<span>수량 ${esc(number(item?.quantity))} · 모의체결가 ${esc(number(item?.price))} · PNL ${esc(unverifiedFunding?'비용 미검증':money(item?.netPnLUSD))}</span><small>${esc(clock(item?.at))}</small></li>`).join('')||'<li>모의체결·복구 이벤트 기록 없음</li>';
 const rejections=unavailable?'<li>PAPER 기록 조회 실패 · 과거 시그널 거부 이력 미확인</li>':rows(data.rejections).slice(-100).reverse().map(item=>`<li><strong>${esc(instrument(item?.instrumentName))} · ${esc(stage(item?.stage))} · ${esc(reason(item?.reason))}</strong>`+
  `<small>${esc(clock(item?.at))}</small></li>`).join('')||'<li>기록된 시그널 거부 사유 없음 · 실제 데이터 자동 진입은 계속 OFF입니다.</li>';
 const storage=plain(data.storage)?data.storage:{},storageStatus=unavailable?'PAPER 기록 조회 실패 · 기존 파일 보존':
  data.storageHealthy===false||storage.healthy===false?'PAPER 기록 저장 실패 · 신규 모의 진입 중지':
  typeof storage.status==='string'&&Object.hasOwn(storageLabels,storage.status)?storageLabels[storage.status]:'PAPER 저장소 조회 상태 미확인';
 const storageView=`${storageStatus} · 기존 Signal Lab PNL·포지션·설정·백업과 분리 · ${source}`+
  (data.recovered===true?' · 저장된 진행 포지션 복구됨':'')+(summary.valuationStale===true?' · 시세 지연, 평가값 재확인 필요':'')+
  (summary.unverifiedFunding===true?' · 펀딩 비용 미검증, 0으로 계산하지 않음':'');
 return {mode,source,state,configured,realDataAutoEntryEnabled:false,liveOrdersEnabled:false,notice,
  settings:settingsView,summary:summaryView,pending,open,closed,events,rejections,storage:storageView,
  contexts:`${context.modeLabel} · ${context.runLabel} · 서로 다른 실행 모드·백테스트·순방향 성과는 합산하지 않습니다.`,
  performanceStatus:performance.status,performanceMetrics:performance.metrics,performanceDirections:performance.directions,
  performanceAssets:performance.assets,performancePeriods:performance.periods};
}

export function renderOrangeXPaper(payload={}, {root=globalThis.document,now=Date.now()}={}){
 const view=orangeXPaperView(payload,{now});
 const mappings={orangexPaperSettings:'settings',orangexPaperSummary:'summary',orangexPaperPending:'pending',
  orangexPaperOpen:'open',orangexPaperClosed:'closed',orangexPaperEvents:'events',orangexPaperRejections:'rejections',
  orangexPaperPerformanceMetrics:'performanceMetrics',orangexPaperPerformanceDirections:'performanceDirections',
  orangexPaperPerformanceAssets:'performanceAssets',orangexPaperPerformancePeriods:'performancePeriods'};
 for(const [id,key]of Object.entries(mappings)){const node=root?.getElementById?.(id);if(node)node.innerHTML=view[key]}
 for(const [id,key]of [['orangexPaperStatus','notice'],['orangexPaperStorage','storage'],['orangexPaperContexts','contexts'],
  ['orangexPaperPerformanceStatus','performanceStatus']]){const node=root?.getElementById?.(id);if(node)node.textContent=view[key]}
 const container=root?.getElementById?.('orangexPaper');if(container)container.className=`orangex-paper ${view.state}`;
 return view;
}

export function renderOrangeXPaperReplay(payload={}, {root=globalThis.document}={}){
 const view=orangeXPaperReplayView(payload);
 for(const [id,value,html]of [['orangexPaperReplayStatus',view.status,false],['orangexPaperReplaySummary',view.summary,true],
  ['orangexPaperReplaySignals',view.signals,true],['orangexPaperReplayPerformanceStatus',view.performance.status,false],
  ['orangexPaperReplayPerformanceMetrics',view.performance.metrics,true]]){
  const node=root?.getElementById?.(id);if(node)node[html?'innerHTML':'textContent']=value;
 }
 return view;
}
