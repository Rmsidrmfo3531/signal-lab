import {atr,ema} from './engine.mjs';
import {tradfiQuoteVerdict} from './tradfi.mjs';
const N=Number;
const everyEnough=(v,num)=>Array.isArray(v)&&v.length>=num;
export function normalizeTwelveSeries(payload,interval,{now=Date.now()}={}){
 if(payload?.status==='error'||!Array.isArray(payload?.values))throw Error('캔들 제공처 응답 오류: '+String(payload?.message||'values 없음').slice(0,100));
 const span=({'1h':60,'4h':240})[interval];if(!span)throw Error('미지원 간격');
 const raw=payload.values.map(c=>{
  const iso=String(c.datetime||'').replace(' ','T')+'Z',time=Date.parse(iso);
  return {time,closeTime:time+span*60000,open:N(c.open),high:N(c.high),low:N(c.low),close:N(c.close),volume:N(c.volume||0),quoteVolume:0,closed:time+span*60000<=now};
 }).filter(c=>Number.isFinite(c.time)&&c.time>0&&[c.open,c.high,c.low,c.close].every(n=>Number.isFinite(n)&&n>0)&&c.low<=Math.min(c.open,c.close)&&c.high>=Math.max(c.open,c.close))
 .sort((a,b)=>a.time-b.time);
 return raw.filter((x,i)=>i===0||x.time!==raw[i-1].time); // only time-valid rows
}
/** Strict, closed-candle confirmation. Signals are NOT a calibrated probability and not Binance-derived. */
export function analyzeTradFi(row,series,{now=Date.now()}={}){
 const output={ticker:row?.ticker||'',checkedAt:now,source:'Twelve Data · OHLC (외부 참조지표)',status:'withheld',reason:'',direction:null};
 if(!row?.feedSymbol)return {...output,reason:'검증된 외부 OHLC 심볼 매핑 없음'};
 const quote=tradfiQuoteVerdict(row,{now});if(!quote.eligible)return {...output,reason:quote.reasons.join(' · ')};
 const h1=(series?.h1||[]).filter(x=>x.closed&&x.closeTime<=now),h4=(series?.h4||[]).filter(x=>x.closed&&x.closeTime<=now);
 if(!everyEnough(h1,65)||!everyEnough(h4,60))return {...output,reason:'1시간·4시간 확정봉 데이터 부족'};
 const a=h1.at(-1),p=h1.at(-2),a4=h4.at(-1);
 // Market closure or delayed provider feeds must never yield actionable setups.
 if(now-a.closeTime>90*60000||now-a4.closeTime>5*3600000)return {...output,reason:'휴장/지연 데이터: 확정봉 신선도 기준 미달'};
 const atr1=atr(h1);if(!Number.isFinite(atr1)||atr1<=0)return {...output,reason:'1시간 ATR 계산 불가'};
 const f4=ema(h4.map(x=>x.close),20),s4=ema(h4.map(x=>x.close),50),f1=ema(h1.map(x=>x.close),20);
 const prev20=h1.slice(-21,-1),top=Math.max(...prev20.map(x=>x.high)),bottom=Math.min(...prev20.map(x=>x.low));
 const range=a.high-a.low,body=Math.abs(a.close-a.open);
 const strong=range>0&&body/range>=0.60&&body>=atr1*0.55;
 const recentSlope=f4.at(-1)-f4.at(-6),dir=(a.close>top&&a.close>a.open&&f4.at(-1)>s4.at(-1)&&recentSlope>0&&a4.close>f4.at(-1))?'LONG':
 (a.close<bottom&&a.close<a.open&&f4.at(-1)<s4.at(-1)&&recentSlope<0&&a4.close<f4.at(-1))?'SHORT':null;
 if(!dir||!strong)return {...output,reason:'4시간 추세·1시간 확정 돌파봉 강도 조건 미달'};
 const long=dir==='LONG';
 const entry=a.close,stop=long?Math.min(p.low,top-atr1*0.5):Math.max(p.high,bottom+atr1*0.5);
 const risk=Math.abs(entry-stop),riskPct=risk/entry*100;
 if(!((long&&stop<entry)||(!long&&stop>entry))||riskPct<.20||riskPct>3)return {...output,reason:'손절 범위 기준 미달'};
 const difference=Math.abs(entry-row.markPrice)/row.markPrice*10000;
 if(difference>100)return {...output,reason:`OHLC / Variational Mark 가격 차이 ${difference.toFixed(1)}bp (>100bp)`};
 // Don't pretend that this setup is an execution-approved order; use 'confirmed' not 'ready'.
 return {...output,status:'confirmed',reason:'확정봉 기술 패턴 확인 · 주문 체결 가능성 별도 검증 필요',direction:dir,
  pattern:long?'1시간봉 20봉 고점 돌파 + 4H 상승추세':'1시간봉 20봉 저점 이탈 + 4H 하락추세',
  entry,stop,targets:[2,3,4].map(R=>entry+(long?1:-1)*risk*R),takeProfitPercent:[40,35,25],
  lastBarAt:a.closeTime,priceFeedDifferenceBps:difference,quoteUpdatedAt:row.quoteUpdatedAt,
  note:'참조 OHLC 시세와 Variational 실제 RFQ 체결가는 다름. 신호 성공확률 검증 안 됨.'};
}
