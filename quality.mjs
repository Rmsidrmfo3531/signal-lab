/** Conservative technical evidence checklist. Score is rule completeness, NEVER win probability. */
// All nine checks are hard requirements in the current strict preset.
// Explicitly report 100 rather than advertising 90 while vetoing 90–95.
export const STRICT_MIN_SCORE = 100;
export const STRICT_MIN_VOL_RATIO = 1.6;
export const STRICT_MIN_DAILY_QV = 15_000_000;
export const STRICT_MIN_HOURLY_QV = 500_000;
const finite = (x)=>Number.isFinite(Number(x))?Number(x):0;

export function gradeSetup({direction,h1,h4,trend,atr1h,volumeRatio,entry,stop,target1,obstacle,dayQuoteVolume,now=Date.now()}={}){
 const last=h1?.at(-1), four=h4?.at(-1);
 const cs=h4?.map(c=>c.close)||[];
 const e20=emaLocal(cs,20), latest=e20.at(-1), previous=e20.at(-4);
 const rising=direction==='LONG' ? latest>previous && latest>0 : previous>latest && previous>0;
 const aligned=(direction==='LONG'&&trend==='up')||(direction==='SHORT'&&trend==='down');
 const range=last?last.high-last.low:0;
 const body=range>0?Math.abs(last.close-last.open)/range:0;
 const finish=range>0?(direction==='LONG'?(last.close-last.low)/range:(last.high-last.close)/range):0;
 const strongCandle=range>0&&body>=0.42&&finish>=0.68 &&
   (direction==='LONG'?last.close>last.open:last.close<last.open);
 const q24=finite(dayQuoteVolume),q1=finite(last?.quoteVolume);
 const dist=Math.abs(entry-stop),riskPct=entry>0?100*dist/entry:Infinity;
 const structuredStop=entry>0&&stop>0&&atr1h>0&&dist>=entry*.0015&&dist<=entry*.035&&dist<=atr1h*3.5&&
   (direction==='LONG'?stop<entry:stop>entry);
 const closeAt=Number(last?.closeTime)||Number(last?.time)+3600000;
 const fresh=Number.isFinite(closeAt)&&closeAt<=now+60000&&now-closeAt<=75*60000;
 const ratio=finite(volumeRatio);
 const checks=[
  {key:'4hAligned',label:'4시간봉 추세·EMA20/50 정렬',weight:15,passed:aligned,value:trend},
  {key:'4hSlope',label:'4시간봉 EMA20 기울기 유지',weight:10,passed:rising,value:rising?'방향 일치':'방향 불일치'},
  {key:'volume',label:`최근 확정 1시간 거래량 ≥ ${STRICT_MIN_VOL_RATIO}배`,weight:15,passed:ratio>=STRICT_MIN_VOL_RATIO,value:`${ratio.toFixed(2)}배`},
  {key:'candle',label:'확정봉 몸통·종가 강도',weight:15,passed:strongCandle,value:`몸통 ${(body*100).toFixed(0)}% · 종가 위치 ${(finish*100).toFixed(0)}%`},
  {key:'liquidity',label:'24시간 거래대금 ≥ 1,500만 달러',weight:10,passed:q24>=STRICT_MIN_DAILY_QV,value:`$${Math.round(q24).toLocaleString()}`},
  {key:'hourlyLiquidity',label:'확정 1시간 거래대금 ≥ 50만 달러',weight:5,passed:q1>=STRICT_MIN_HOURLY_QV,value:`$${Math.round(q1).toLocaleString()}`},
  {key:'stop',label:'손절거리 0.15~3.5% 및 3.5 ATR 이내',weight:10,passed:structuredStop,value:`${riskPct.toFixed(2)}%`},
  {key:'unobstructed',label:'1차 목표 이전 반대 지지·저항 없음',weight:10,passed:!obstacle&&Number.isFinite(target1)&&target1>0,value:obstacle?`장애물 ${obstacle.price}`:'확인'},
  {key:'fresh',label:'확정 1시간봉 75분 이내',weight:10,passed:fresh,value:Number.isFinite(closeAt)?`${Math.round((now-closeAt)/60000)}분 전`:'시간 없음'}
 ];
 const score=checks.reduce((sum,c)=>sum+(c.passed?c.weight:0),0);
 const failed=checks.filter(x=>!x.passed);
 return {score,passed:failed.length===0&&score>=STRICT_MIN_SCORE,failed:failed.map(x=>x.label),checks,rule:'STRICT-2026-01',scoreMeaning:'기술적 조건 충족도(성공확률 아님)'};
}
function emaLocal(values,period){let v=values[0];const k=2/(period+1);return values.map(x=>v=x*k+(1-k)*v)}
