/** Read-only educational risk / scaling model shared by server and browser.
 * Never calls a venue or submits orders. Gross projections exclude costs/market impact.
 */
export const TP_WEIGHTS=Object.freeze([40,35,25]);
export const TP_R_MULTIPLES=Object.freeze([2,3,4]);

// Share the stricter intersection of the price, ATR and risk-distance limits
// with the server's final decision and the first simulated entry quote.
export function entryAllowance(signal){
  const entry=Number(signal?.entry),stop=Number(signal?.stop),atr=Number(signal?.atr);
  if(!(entry>0)||!(stop>0)||!Number.isFinite(entry)||!Number.isFinite(stop))return 0;
  return Math.min(.004,Math.abs(entry-stop)/entry*.25,Number.isFinite(atr)&&atr>0?atr/entry*.45:Infinity);
}

export function tradePlan(signal,{notional=signal?.risk?.nominal,allowLegacyRTargets=false}={}){
  const entry=Number(signal?.entry),stop=Number(signal?.stop),side=signal?.direction;
  if(!['LONG','SHORT'].includes(side)||!Number.isFinite(entry)||entry<=0||!Number.isFinite(stop)||stop<=0||
      (side==='LONG'&&stop>=entry)||(side==='SHORT'&&stop<=entry))return null;
  const dir=side==='LONG'?1:-1,r=Math.abs(entry-stop),profile=signal?.managementVersion==='VOLUME_PROFILE_V1',
    sourcePlan=profile?signal.targetPlan:null;
  if(profile&&sourcePlan?.ok!==true)return null;
  let prices=profile?sourcePlan.targets:Array.isArray(signal.targets)?signal.targets:[signal.target1,signal.target2,signal.target3];
  const legacy=signal.managementVersion==='LEGACY_R_MULTIPLES'||signal.managementVersion==='LEGACY_R_V1'||allowLegacyRTargets===true;
  if(!profile&&(!Array.isArray(prices)||prices.every(x=>x===undefined||x===null))&&legacy)
    prices=TP_R_MULTIPLES.map(multiple=>entry+dir*r*multiple);
  if(!Array.isArray(prices)||prices.length!==3||prices.some((p,i)=>!Number.isFinite(p)||p<=0||dir*(p-entry)<=0||i>0&&dir*(p-prices[i-1])<=0))return null;
  const funds=Number(notional),amount=Number.isFinite(funds)&&funds>0?funds:null;
  const targets=prices.map((price,i)=>{
    const reducePct=TP_WEIGHTS[i],movePct=dir*(price-entry)/entry*100;
    return {name:`${i+1}차`,price,multiple:dir*(price-entry)/r,reducePct,movePct,
      quantity:Number.isFinite(sourcePlan?.parts?.[i]?.quantity)?sourcePlan.parts[i].quantity:null,
      estimatedPartProfitUSD:amount===null?null:amount*(reducePct/100)*(movePct/100),
      remainingPct:100-TP_WEIGHTS.slice(0,i+1).reduce((x,y)=>x+y,0)};
  });
  return {entry,stop,side,oneR:r,riskPct:100*r/entry,notional:amount,targets,
    managementVersion:profile?'VOLUME_PROFILE_V1':legacy?'LEGACY_R_MULTIPLES':'STORED_TARGETS',
    profileEvidence:profile?sourcePlan.profileEvidence??null:null,
    estimatedNetRR:Number.isFinite(sourcePlan?.estimatedNetRR)?sourcePlan.estimatedNetRR:null,
    weightedR:targets.reduce((s,t)=>s+t.multiple*t.reducePct/100,0),
    projectedGrossUSD:amount===null?null:targets.reduce((s,t)=>s+t.estimatedPartProfitUSD,0),
    grossStopLossUSD:amount===null?null:amount*r/entry,
    disclaimer:profile?'실제 체결량 기반 매물대 계획입니다. 예상 손익과 실제 체결·순손익은 다르며 단위·호가·비용·수량 검증이 필요합니다.':
      '기존 저장 목표가 또는 명시적 구버전 R 계획입니다. 신규 거래의 매물대 목표를 대신하지 않습니다. 비용·펀딩·슬리피지는 별도 검증합니다.'};
}

/** A current entry *checklist*, not an assertion that an order will be profitable.
 * Entry-zone status requires: confirmed closed candle, current Binance tick, venue
 * eligibility, closed 1H/4H confirmation, and current price within a narrow R-based zone.
 */
export function entryTiming(signal,{price=null,priceAt=null,now=Date.now(),venueReady=false,maxPriceAgeMs=90000,maxAgeMs=2*3600000}={}){
  const plan=tradePlan(signal);
  const result=(code,label,detail,actionable=false,extra={})=>({code,label,detail,actionable,...extra});
  const entry=Number(signal?.entry),stop=Number(signal?.stop),side=signal?.direction;
  if(!['LONG','SHORT'].includes(side)||!Number.isFinite(entry)||entry<=0||!Number.isFinite(stop)||stop<=0||
    (side==='LONG'?stop>=entry:stop<=entry))return result('invalid','진입 조건 불명확','진입·손절 기준을 검증할 수 없습니다.');
  const dir=side==='LONG'?1:-1;
  const width=entry*entryAllowance(signal);
  const zoneLow=entry-width, zoneHigh=entry+width;
  const trigger=`1시간봉 ${signal.pattern||'패턴'} 종가 확정 + 4시간봉 추세 확인 → ${formatTriggerSide(side)} ${zoneLow.toPrecision(8)}~${zoneHigh.toPrecision(8)} 재진입 → Binance 차트 기준 · 실제 주문 없음`;
  const extra={zoneLow,zoneHigh,confirmation:trigger};
  const confirmed=Number(signal.patternConfirmedAt??signal.time+3600000);
  if(!signal.patternConfirmed||!Number.isFinite(confirmed)||confirmed>now+60000)return result('unconfirmed','패턴 확정 대기','1시간봉 마감 확정 전 진입 판단 보류',false,extra);
  if(Number.isFinite(signal.quality?.validUntil)&&now>signal.quality.validUntil)
    return result('expired','필수 봉 신선도 만료 · 재분석 대기','1시간·4시간 확정봉의 필수 신선도 조건이 만료되었습니다.',false,extra);
  if(Number.isFinite(signal.scannedAt)&&(signal.scannedAt>now+60000||now-signal.scannedAt>20*60000))
    return result('expired','최근 분석 만료 · 재분석 대기','최종 진입은 최근 20분 이내의 분석이 필요합니다.',false,extra);
  if(now-confirmed>maxAgeMs)return result('expired','신호 만료 · 신규 진입 금지','1시간봉 확정 후 2시간 초과. 새 패턴을 기다리세요.',false,extra);
  const p=Number(price),at=Number(priceAt);
  if(!Number.isFinite(p)||p<=0||!Number.isFinite(at)||at<=0||at>now+60000||now-at>maxPriceAgeMs)
    return result('stale','현재가 수신 지연 · 진입 보류','최근 90초 이내의 Binance 가격이 확인되지 않았습니다.',false,extra);
  if(dir*(p-stop)<=0)return result('invalidated','손절선 침범 · 신규 진입 금지','확정 패턴 무효화 수준에 도달했습니다.',false,extra);
  const first=plan?.targets[0]?.price;
  if(first&&dir*(p-first)>=0)return result('target-hit','1차 목표 도달 · 신규 진입 보류','이미 첫 목표를 통과한 가격입니다.',false,extra);
  if(!venueReady||!signal.qualified||!signal.execution?.eligible)
    return result('venue-hold','패턴 확정 · 체결 조건 보류','1시간봉 확정·4시간봉 추세 및 Binance 선물 호가·거래비용을 검증해야 합니다. 실제 주문 승인은 별도입니다.',false,extra);
  const deviation=(p-entry)*dir;
  if(p>=zoneLow&&p<=zoneHigh)return result('zone','진입 관찰 구간 도달 · 주문 전 확인',
     `${side==='LONG'?'롱':'숏'} 기준 구간 내 가격. 실제 거래소 Bid/Ask·보호 손절·수량·포지션 위험을 재확인하세요.`,true,extra);
  if(deviation>width)return result('chase','추격 진입 금지 · 되돌림 대기','기준가보다 유리한 방향으로 이미 멀어졌습니다. 진입 구간 재접근과 새로운 확인봉을 기다리세요.',false,extra);
  return result('reconfirm','가격 반대 이탈 · 재확인 대기','기준가 반대 방향으로 이탈했습니다. 새 1시간봉 마감 또는 새로운 패턴이 필요합니다.',false,extra);
}
function formatTriggerSide(side){return side==='LONG'?'롱':'숏'}
