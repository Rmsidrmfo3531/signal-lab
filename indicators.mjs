/** Closed-candle indicator confirmation for research/watch ranking.
 * Informational score only: does not weaken STRICT_MIN_SCORE or order gates.
 */
const sum=a=>a.reduce((x,y)=>x+y,0);
const round=x=>Number(x.toFixed(3));
const validBars=c=>Array.isArray(c)&&c.length>=65&&c.every(x=>[x.open,x.high,x.low,x.close,x.volume].every(v=>Number.isFinite(v))&&x.high>=x.low&&x.close>0&&x.volume>=0);
function ema(values,n){
 if(values.length<n)return [];
 const out=Array(values.length).fill(null);
 let e=sum(values.slice(0,n))/n;out[n-1]=e;
 const a=2/(n+1);
 for(let i=n;i<values.length;i++){e=(values[i]-e)*a+e;out[i]=e}
 return out;
}
export function rsi14(c){
 if(c.length<15)return null;
 const close=c.map(x=>x.close);let gain=0,loss=0;
 for(let i=1;i<=14;i++){const d=close[i]-close[i-1];gain+=Math.max(0,d);loss+=Math.max(0,-d)}
 gain/=14;loss/=14;
 for(let i=15;i<close.length;i++){const d=close[i]-close[i-1];gain=(gain*13+Math.max(d,0))/14;loss=(loss*13+Math.max(-d,0))/14}
 return loss===0?(gain===0?50:100):100-100/(1+gain/loss);
}
export function macdHistogram(c){
 const close=c.map(x=>x.close),a=ema(close,12),b=ema(close,26);
 const diffs=close.map((_,i)=>a[i]!=null&&b[i]!=null?a[i]-b[i]:null);
 const first=diffs.findIndex(x=>x!==null);
 if(first<0)return null;
 const signal=ema(diffs.slice(first),9),j=signal.length-1;
 if(j<1||signal[j]==null||signal[j-1]==null)return null;
 return {macd:diffs.at(-1),signal:signal[j],histogram:diffs.at(-1)-signal[j],
  previousHistogram:diffs.at(-2)-signal[j-1]};
}
export function adx14(c){
 if(c.length<29)return null;
 const tr=[],plus=[],minus=[];
 for(let i=1;i<c.length;i++){
  const a=c[i],p=c[i-1],up=a.high-p.high,down=p.low-a.low;
  tr.push(Math.max(a.high-a.low,Math.abs(a.high-p.close),Math.abs(a.low-p.close)));
  plus.push(up>down&&up>0?up:0);
  minus.push(down>up&&down>0?down:0);
 }
 let smoothTr=sum(tr.slice(0,14)),smoothP=sum(plus.slice(0,14)),smoothM=sum(minus.slice(0,14));
 const dx=[],directions=[];
 const calc=()=>{
  const p=smoothTr>0?100*smoothP/smoothTr:0,m=smoothTr>0?100*smoothM/smoothTr:0;
  directions.push({plusDI:p,minusDI:m});
  dx.push(p+m>0?100*Math.abs(p-m)/(p+m):0);
 };
 calc();
 for(let i=14;i<tr.length;i++){
  smoothTr=smoothTr-smoothTr/14+tr[i];
  smoothP=smoothP-smoothP/14+plus[i];
  smoothM=smoothM-smoothM/14+minus[i];
  calc();
 }
 if(dx.length<14)return null;
 let adx=sum(dx.slice(0,14))/14;
 for(let i=14;i<dx.length;i++)adx=(adx*13+dx[i])/14;
 return {adx,...directions.at(-1)};
}
export function bollinger20(c){
 if(c.length<20)return null;
 const close=c.slice(-20).map(x=>x.close),middle=sum(close)/20;
 const sigma=Math.sqrt(sum(close.map(x=>(x-middle)**2))/20);
 return {middle,upper:middle+2*sigma,lower:middle-2*sigma,width:4*sigma};
}
export function obvDirection(c){
 if(c.length<8)return null;
 const values=[0];
 for(let i=1;i<c.length;i++){
  const change=Math.sign(c[i].close-c[i-1].close);
  values.push(values.at(-1)+change*c[i].volume);
 }
 return values.at(-1)-values.at(-6);
}
export function evaluateIndicators(c,direction){
 if(!['LONG','SHORT'].includes(direction)||!validBars(c))return {valid:false,score:null,checks:[],values:{},version:'INDICATOR-V1'};
 const rsi=rsi14(c),macd=macdHistogram(c),adx=adx14(c),bands=bollinger20(c),obvDelta=obvDirection(c);
 if(!Number.isFinite(rsi)||!macd||!adx||!bands||!Number.isFinite(obvDelta))
  return {valid:false,score:null,checks:[],values:{},version:'INDICATOR-V1'};
 const long=direction==='LONG',price=c.at(-1).close;
 const aligned=long?adx.plusDI>adx.minusDI:adx.minusDI>adx.plusDI;
 const hist=macd.histogram,prev=macd.previousHistogram;
 const rsipoints=long?(rsi>=50&&rsi<=70?20:rsi>=45&&rsi<=80?10:0)
  :(rsi>=30&&rsi<=50?20:rsi>=20&&rsi<=55?10:0);
 const macdpoints=(long?hist>0:hist<0)?((long?hist>prev:hist<prev)?25:15):0;
 const adxpoints=aligned?(adx.adx>=25?25:adx.adx>=20?15:0):0;
 const bbpoints=(long?price>=bands.middle&&price<=bands.upper:price<=bands.middle&&price>=bands.lower)?15:
  ((long?price>bands.upper&&price<=bands.upper+bands.width*.5:price<bands.lower&&price>=bands.lower-bands.width*.5)?7:0);
 const obvpoints=(long?obvDelta>0:obvDelta<0)?15:0;
 const checks=[
  {key:'rsi',label:'RSI(14) 모멘텀',weight:20,earned:rsipoints,value:round(rsi)},
  {key:'macd',label:'MACD(12,26,9) 히스토그램',weight:25,earned:macdpoints,value:round(hist)},
  {key:'adx',label:'ADX/DMI(14) 추세 강도·방향',weight:25,earned:adxpoints,value:round(adx.adx)},
  {key:'bollinger',label:'볼린저밴드(20,2) 가격 위치',weight:15,earned:bbpoints,value:round(price)},
  {key:'obv',label:'OBV 최근 5봉 거래량 방향',weight:15,earned:obvpoints,value:round(obvDelta)}
 ].map(x=>({...x,passed:x.earned===x.weight}));
 return {valid:true,score:sum(checks.map(x=>x.earned)),checks,version:'INDICATOR-V1',
  values:{rsi:round(rsi),macdHistogram:round(hist),adx:round(adx.adx),plusDI:round(adx.plusDI),
   minusDI:round(adx.minusDI),bbMiddle:round(bands.middle),bbUpper:round(bands.upper),
   bbLower:round(bands.lower),obvDelta:round(obvDelta)}};
}
export function compositeWatchScore(baseScore,indicators){
 if(!indicators?.valid||!Number.isFinite(indicators.score)||!Number.isFinite(baseScore)||baseScore<0||baseScore>100)return null;
 return Math.round(.6*baseScore+.4*indicators.score);
}
