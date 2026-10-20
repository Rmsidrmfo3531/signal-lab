/** Observation-only 1H/4H market structure. NEVER an entry signal, alert, or paper trade. */
import {normalizedKlines,ema,atr,analyze} from './engine.mjs';
const finite=n=>Number.isFinite(n);
export function structureObservations(symbol,h1Rows,h4Rows,{now=Date.now()}={}){
 const h1=normalizedKlines(h1Rows,now).filter(x=>x.closed);
 const h4=normalizedKlines(h4Rows,now).filter(x=>x.closed);
 if(h1.length<65||h4.length<60)return [];
 const last=h1.at(-1), prior=h1.slice(-21,-1),unit=atr(h1);
 if(!finite(unit)||unit<=0)return [];
 const upper=Math.max(...prior.map(x=>x.high)),lower=Math.min(...prior.map(x=>x.low));
 const ma=ema(h1.map(x=>x.close),20).at(-1),m4=ema(h4.map(x=>x.close),20).at(-1);
 const slow=ema(h4.map(x=>x.close),50).at(-1);
 const trend=m4>slow?'UP':m4<slow?'DOWN':'RANGE';
 const near=(level)=>Math.abs(last.close-level)<=unit*0.7;
 const out=[];
 const add=(direction,kind,level,detail)=>out.push({symbol,direction,kind,referencePrice:level,close:last.close,observedAt:last.closeTime,atr:unit,detail,status:'OBSERVATION_ONLY',tradeEligible:false});
 if(near(upper))add('LONG','1시간 박스 상단 인접',upper,'상단 돌파를 확정하려면 이후 1시간봉 종가가 기준가 위에서 마감해야 합니다.');
 if(near(lower))add('SHORT','1시간 박스 하단 인접',lower,'하단 이탈을 확정하려면 이후 1시간봉 종가가 기준가 아래에서 마감해야 합니다.');
 if(trend==='UP'&&near(ma))add('LONG','4시간 상승 추세 · 1시간 EMA20 부근',ma,'1시간봉 반등 구조·거래량을 추가 확인해야 합니다.');
 if(trend==='DOWN'&&near(ma))add('SHORT','4시간 하락 추세 · 1시간 EMA20 부근',ma,'1시간봉 저항 확인·거래량을 추가 확인해야 합니다.');
 // No forced candidates: 0 observations is valid if no price is near a level.
 return out;
}
/** Recent closed-bar occurrences are historical observations only (no backfilled fills or alerts).
 * Truncate 4H candles at each old 1H bar to avoid using future 4H context.
 */
export function historicalPatternObservations(symbol,h1Rows,h4Rows,{now=Date.now(),lookbackHours=24}={}){
 const h1=normalizedKlines(h1Rows,now).filter(x=>x.closed);
 const h4=normalizedKlines(h4Rows,now).filter(x=>x.closed);
 if(h1.length<65||h4.length<60)return [];
 const seen=new Set(),result=[];
 for(let lag=1;lag<=Math.min(lookbackHours,h1.length-65);lag++){
  const cut=h1.length-lag,older=h1.slice(0,cut),stamp=older.at(-1).closeTime;
  if(now-stamp>lookbackHours*3600000||now-stamp<0)continue;
  const four=h4.filter(c=>c.closeTime<=stamp);
  if(four.length<60)continue;
  const x=analyze(symbol,older,four,[],null,{});
  if(!x.patternConfirmed||!x.pattern||!x.direction)continue;
  const key=`${x.pattern}:${x.direction}:${x.patternConfirmedAt}`;
  if(seen.has(key))continue;seen.add(key);
  result.push({symbol,pattern:x.pattern,direction:x.direction,entry:x.entry,stop:x.stop,confirmedAt:x.patternConfirmedAt,
   status:'HISTORICAL_ONLY',tradeEligible:false,detail:'과거 1시간봉에서 확인 · 현재 진입/모의매매/자동 알림 대상 아님'});
 }
 return result.sort((a,b)=>b.confirmedAt-a.confirmedAt).slice(0,12);
}
