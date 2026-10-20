/** Read-only health snapshot. A running Node server is not proof that price
 * streams or eligible paper signals are being processed. */
export function paperEngineHealth({paper, telemetry={}, scanner={}, tradfi={}, now=Date.now()}={}){
 const validRecent=(at,maxAge)=>Number.isFinite(Number(at))&&Number(at)>0&&now>=Number(at)&&now-Number(at)<=maxAge;
 const cryptoQuotesFresh=scanner.ws==='connected'&&validRecent(scanner.lastTickerAt,90000);
 const cryptoSignalReady=cryptoQuotesFresh&&scanner.variational==='connected'&&scanner.scanMode==='verified'&&scanner.activeCount>0;
 const tradfiQuoteFresh=tradfi.status==='connected'&&validRecent(tradfi.updatedAt,180000);
 const tradfiSignalReady=tradfiQuoteFresh&&['connected','partial'].includes(tradfi.feedStatus)&&validRecent(tradfi.feedUpdatedAt,1800000);
 const positions=[...(paper?.open||[])];
 const pending=[...(paper?.pending||[])];
 const delayed=positions.filter(t=>!validRecent(t.lastPriceAt,t.market==='TRADFI'?180000:90000));
 const all=positions.concat(pending);
 const hasCrypto=all.some(x=>x.market==='CRYPTO');
 const hasTradFi=all.some(x=>x.market==='TRADFI');
 const feedBlocked=(hasCrypto&&!cryptoQuotesFresh)||(hasTradFi&&!tradfiQuoteFresh);
 let state='WAITING',label='새 시그널 감시 준비 중',reason='아직 신규 가상 주문이 없으며, 데이터 연결을 검사하고 있습니다.';
 if(positions.length||pending.length){
  if(delayed.length||feedBlocked){state='DELAYED';label='가상 포지션 / 시세 확인 지연';reason=`진행 ${positions.length}건 · 진입 대기 ${pending.length}건. ${delayed.length}개 포지션 시세 지연 또는 관련 시세 미수신. 새로운 체결을 확인했다고 간주하지 마세요.`}
  else{state='TRACKING';label='가상 포지션 자동 추적 중';reason=`진행 ${positions.length}건 · 진입 대기 ${pending.length}건. 새 시세가 들어오면 모의 익절·손절을 평가합니다.`}
 }else if(cryptoSignalReady||tradfiSignalReady){state='WATCHING';label='새 가상매매 시그널 대기 중';reason='스캐너의 신규 검증 신호만 가상 주문 후보로 등록합니다. 현재 열린 가상 포지션은 없습니다.'}
 else if(cryptoQuotesFresh||tradfiQuoteFresh){state='WAITING';label='시세 수신 중 · 검증 신호 대기';reason='시세는 확인됐지만 상장·캔들·호가 검증이 모두 준비되지 않아 자동 진입은 보류됩니다.'}
 else{state='OFFLINE';label='시세 갱신 대기 · 자동 모의매매 보류';reason='현재 최신 시세가 없어 새 가상 체결을 평가할 수 없습니다. 시장·WebSocket 연결을 확인하세요.'}
 return {state,label,reason,cryptoQuotesFresh,cryptoSignalReady,tradfiQuoteFresh,tradfiSignalReady,delayedPositions:delayed.length,
  checkedAt:now,sessionStartedAt:telemetry.sessionStartedAt||0,priceTickCount:telemetry.priceTickCount||0,
  signalChecks:telemetry.signalChecks||0,acceptedSignals:telemetry.acceptedSignals||0,
  lastQuoteAt:telemetry.lastQuoteAt||0,lastSignalAt:telemetry.lastSignalAt||0,
  lastAcceptedAt:telemetry.lastAcceptedAt||0,lastPositionEventAt:telemetry.lastPositionEventAt||0,
  openedCountSession:telemetry.openedCountSession||0,closedCountSession:telemetry.closedCountSession||0};
}
