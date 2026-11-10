/** Closed-candle indicator mathematics. No separate blended score exists. */
const sum=a=>a.reduce((x,y)=>x+y,0);
const round=x=>Number(x.toFixed(3));
const validBars=c=>Array.isArray(c)&&c.length>=65&&c.every(x=>[x.open,x.high,x.low,x.close,x.volume].every(v=>Number.isFinite(v))&&Math.min(x.open,x.high,x.low,x.close)>0&&x.high>=Math.max(x.open,x.close)&&x.low<=Math.min(x.open,x.close)&&x.volume>=0&&x.closed!==false);
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
/** Wilder ATR uses the same closed bars for score and risk display. */
export function atrWilder(c,period=14){
 if(!Array.isArray(c)||c.length<period+1||!Number.isSafeInteger(period)||period<1)return null;
 const ranges=[];
 for(let i=1;i<c.length;i++){
  const bar=c[i],previous=c[i-1];
  if(![bar.high,bar.low,previous.close].every(Number.isFinite))return null;
  ranges.push(Math.max(bar.high-bar.low,Math.abs(bar.high-previous.close),Math.abs(bar.low-previous.close)));
 }
 let result=sum(ranges.slice(0,period))/period;
 for(let i=period;i<ranges.length;i++)result=(result*(period-1)+ranges[i])/period;
 return Number.isFinite(result)?result:null;
}
export {ema as seededEMA};
/** Readings only. quality.mjs owns the one Issue #6 100-point score. */
export function evaluateIndicators(c,direction){
 const version='ISSUE6-INDICATORS-V2';
 if(!['LONG','SHORT'].includes(direction)||!validBars(c))return {valid:false,score:null,checks:[],values:{},version};
 const rsi=rsi14(c),macd=macdHistogram(c),adx=adx14(c),atr=atrWilder(c);
 if(!Number.isFinite(rsi)||!macd||!adx||!Number.isFinite(atr))return {valid:false,score:null,checks:[],values:{},version};
 return {valid:true,score:null,checks:[],version,values:{rsi,macd:macd.macd,macdSignal:macd.signal,
  macdHistogram:macd.histogram,previousMacdHistogram:macd.previousHistogram,
  adx:adx.adx,plusDI:adx.plusDI,minusDI:adx.minusDI,atr}};
}
