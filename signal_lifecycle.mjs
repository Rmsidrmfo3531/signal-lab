/** Safety-focused lifecycle for previously generated *informational* chart signals.
 * Not an execution instruction; mark old/outdated signals prominently.
 */
export function signalLifecycle(signal,{now=Date.now(),price=null,priceAt=null,maxAgeMs=2*3600000,maxPriceAgeMs=90000}={}){
 const entry=Number(signal?.entry),stop=Number(signal?.stop),target=Number(signal?.target1);
 const confirmed=Number(signal?.patternConfirmedAt)|| (Number(signal?.time)+3600000);
 const p=Number(price);
 const result=(code,label,actionable=false)=>({code,label,actionable,at:now});
 if(!signal||!['LONG','SHORT'].includes(signal.direction)||![entry,stop,target,confirmed].every(x=>Number.isFinite(x)&&x>0))return result('invalid-data','신호 데이터 불완전');
 if(!Number.isFinite(confirmed)||confirmed>now+60000||now-confirmed>maxAgeMs)return result('expired','신호 유효기간 경과');
 if(!Number.isFinite(p)||p<=0||!Number.isFinite(priceAt)||now-priceAt>maxPriceAgeMs||priceAt>now+60000)return result('stale','현재가 검증 불가');
 if(signal.direction==='LONG' ? p<=stop : p>=stop)return result('invalidated','손절·무효화 수준 도달');
 if(signal.direction==='LONG' ? p>=target : p<=target)return result('target-hit','1차 목표 수준 도달');
 const distance=Math.abs(p-entry)/entry;
 const allowed=Math.max(.006,Math.max(0,Number(signal.atr)||0)/entry*.65);
 if(distance>allowed)return result('chase','진입 기준가 이탈 · 추격 주의');
 return result('current','최근 기준 유효 · 주문 전 재확인',true);
}
