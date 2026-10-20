/** Read-only educational risk / scaling model shared by server and browser.
 * Never calls a venue or submits orders. Gross projections exclude costs/market impact.
 */
export const TP_WEIGHTS=Object.freeze([40,35,25]);
export const TP_R_MULTIPLES=Object.freeze([2,3,4]);

export function tradePlan(signal,{notional=signal?.risk?.nominal}={}){
  const entry=Number(signal?.entry),stop=Number(signal?.stop),side=signal?.direction;
  if(!['LONG','SHORT'].includes(side)||!Number.isFinite(entry)||entry<=0||!Number.isFinite(stop)||stop<=0||
      (side==='LONG'&&stop>=entry)||(side==='SHORT'&&stop<=entry))return null;
  const dir=side==='LONG'?1:-1, r=Math.abs(entry-stop);
  const funds=Number(notional), amount=Number.isFinite(funds)&&funds>0?funds:null;
  const targets=TP_R_MULTIPLES.map((multiple,i)=>{
    const price=entry+dir*r*multiple, reducePct=TP_WEIGHTS[i];
    if(!Number.isFinite(price)||price<=0)return null;
    const movePct=dir*(price-entry)/entry*100;
    return {name:`${i+1}차`,price,multiple,reducePct,movePct,
      estimatedPartProfitUSD:amount===null?null:amount*(reducePct/100)*(movePct/100),
      remainingPct:100-TP_WEIGHTS.slice(0,i+1).reduce((x,y)=>x+y,0)};
  });
  const valid=targets.filter(Boolean);
  if(!valid.length)return null;
  const weightedR=valid.reduce((s,t)=>s+t.multiple*t.reducePct/100,0);
  return {entry,stop,side,oneR:r,riskPct:100*r/entry,notional:amount,
    targets,weightedR,
    projectedGrossUSD:amount===null?null:valid.reduce((s,t)=>s+t.estimatedPartProfitUSD,0),
    grossStopLossUSD:amount===null?null:amount*r/entry,
    disclaimer:'가격 목표는 진입·손절 간격의 R 배수를 사용한 가상 계획입니다. 스프레드·수수료·펀딩·슬리피지·레버리지 청산 영향은 제외합니다.'};
}

/** A current entry *checklist*, not an assertion that an order will be profitable.
 * Entry-zone status requires: confirmed closed candle, current Binance tick, venue
 * eligibility, closed 1H/4H confirmation, and current price within a narrow R-based zone.
 */
export function entryTiming(signal,{price=null,priceAt=null,now=Date.now(),venueReady=false,maxPriceAgeMs=90000,maxAgeMs=2*3600000}={}){
  const plan=tradePlan(signal);
  const result=(code,label,detail,actionable=false,extra={})=>({code,label,detail,actionable,...extra});
  if(!plan)return result('invalid','진입 조건 불명확','진입·손절 기준을 검증할 수 없습니다.');
  const {entry,stop,oneR,side}=plan,dir=side==='LONG'?1:-1;
  const atr=Number(signal.atr)||0;
  const width=Math.min(oneR*.25,entry*.004,Math.max(oneR*.12,atr*.25));
  const zoneLow=entry-width, zoneHigh=entry+width;
  const trigger=`1시간봉 ${signal.pattern||'패턴'} 종가 확정 + 4시간봉 추세 확인 → ${formatTriggerSide(side)} ${zoneLow.toPrecision(8)}~${zoneHigh.toPrecision(8)} 재진입 → Variational 실제 주문 호가 확인`;
  const extra={zoneLow,zoneHigh,confirmation:trigger};
  const confirmed=Number(signal.patternConfirmedAt??signal.time+3600000);
  if(!signal.patternConfirmed||!Number.isFinite(confirmed)||confirmed>now+60000)return result('unconfirmed','패턴 확정 대기','1시간봉 마감 확정 전 진입 판단 보류',false,extra);
  if(now-confirmed>maxAgeMs)return result('expired','신호 만료 · 신규 진입 금지','1시간봉 확정 후 2시간 초과. 새 패턴을 기다리세요.',false,extra);
  const p=Number(price),at=Number(priceAt);
  if(!Number.isFinite(p)||p<=0||!Number.isFinite(at)||at<=0||at>now+60000||now-at>maxPriceAgeMs)
    return result('stale','현재가 수신 지연 · 진입 보류','최근 90초 이내의 Binance 가격이 확인되지 않았습니다.',false,extra);
  if(dir*(p-stop)<=0)return result('invalidated','손절선 침범 · 신규 진입 금지','확정 패턴 무효화 수준에 도달했습니다.',false,extra);
  const first=plan.targets[0]?.price;
  if(first&&dir*(p-first)>=0)return result('target-hit','1차 목표 도달 · 신규 진입 보류','이미 첫 목표를 통과한 가격입니다.',false,extra);
  if(!venueReady||!signal.qualified||!signal.execution?.eligible)
    return result('venue-hold','패턴 확정 · 체결 조건 보류','1시간봉 확정·4시간봉 추세 및 Variational 호가·가격차·거래비용을 모두 검증해야 합니다.',false,extra);
  const deviation=(p-entry)*dir;
  if(p>=zoneLow&&p<=zoneHigh)return result('zone','진입 관찰 구간 도달 · 주문 전 확인',
     `${side==='LONG'?'롱':'숏'} 기준 구간 내 가격. Variational 실제 Bid/Ask·청산가·포지션 위험을 재확인하세요.`,true,extra);
  if(deviation>width)return result('chase','추격 진입 금지 · 되돌림 대기','기준가보다 유리한 방향으로 이미 멀어졌습니다. 진입 구간 재접근과 새로운 확인봉을 기다리세요.',false,extra);
  return result('reconfirm','가격 반대 이탈 · 재확인 대기','기준가 반대 방향으로 이탈했습니다. 새 1시간봉 마감 또는 새로운 패턴이 필요합니다.',false,extra);
}
function formatTriggerSide(side){return side==='LONG'?'롱':'숏'}
