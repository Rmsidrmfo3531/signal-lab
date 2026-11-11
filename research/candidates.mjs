// Research only: textbook versions of the techniques in the user's study notes
// (RSI divergence, MACD, Bollinger bands, W / triple bottom, triangles, candle
// reversals, volume, moving averages), on closed 1H candles. Each detector looks
// only at candles up to index j and returns {direction,pattern,entry,stop} or null.
// They are backtested with the same exits as the live strategy before anything is
// allowed to trade.

const ema=(values,n)=>{const out=new Array(values.length).fill(null);if(values.length<n)return out;let e=values.slice(0,n).reduce((a,b)=>a+b,0)/n;out[n-1]=e;const k=2/(n+1);for(let i=n;i<values.length;i++){e=(values[i]-e)*k+e;out[i]=e}return out};
const sma=(values,n)=>values.map((_,i)=>i<n-1?null:values.slice(i-n+1,i+1).reduce((a,b)=>a+b,0)/n);
function rsiSeries(closes,n=14){const out=new Array(closes.length).fill(null);let g=0,l=0;for(let i=1;i<=n&&i<closes.length;i++){const d=closes[i]-closes[i-1];g+=Math.max(d,0);l+=Math.max(-d,0)}
 if(closes.length<=n)return out;g/=n;l/=n;out[n]=l===0?100:100-100/(1+g/l);
 for(let i=n+1;i<closes.length;i++){const d=closes[i]-closes[i-1];g=(g*(n-1)+Math.max(d,0))/n;l=(l*(n-1)+Math.max(-d,0))/n;out[i]=l===0?100:100-100/(1+g/l)}return out}
function atrSeries(c,n=14){const tr=c.map((x,i)=>i?Math.max(x.h-x.l,Math.abs(x.h-c[i-1].c),Math.abs(x.l-c[i-1].c)):x.h-x.l);const out=new Array(c.length).fill(null);let a=0;
 for(let i=0;i<c.length;i++){if(i<n){a+=tr[i];if(i===n-1){a/=n;out[i]=a}}else{a=(a*(n-1)+tr[i])/n;out[i]=a}}return out}

/** Precompute every series once per symbol (all causal). */
export function prepare(candles){
 const close=candles.map(c=>c.c),vol=candles.map(c=>c.v);
 const e12=ema(close,12),e26=ema(close,26),macd=close.map((_,i)=>e12[i]!=null&&e26[i]!=null?e12[i]-e26[i]:null);
 const first=macd.findIndex(x=>x!=null),sig=new Array(close.length).fill(null);
 if(first>=0){const s=ema(macd.slice(first),9);s.forEach((v,i)=>{sig[first+i]=v})}
 const mid=sma(close,20),sd=close.map((_,i)=>i<19?null:Math.sqrt(close.slice(i-19,i+1).reduce((a,x)=>a+(x-mid[i])**2,0)/20));
 return {c:candles,close,vol,rsi:rsiSeries(close),atr:atrSeries(candles),e20:ema(close,20),e50:ema(close,50),e200:ema(close,200),
  macd,sig,bbMid:mid,bbUp:mid.map((m,i)=>m==null?null:m+2*sd[i]),bbLo:mid.map((m,i)=>m==null?null:m-2*sd[i]),volAvg:sma(vol,20)};
}
const pivotLow=(c,i,s=3)=>i>=s&&i+s<c.length&&c.slice(i-s,i+s+1).every((x,k)=>k===s||c[i].l<x.l);
const pivotHigh=(c,i,s=3)=>i>=s&&i+s<c.length&&c.slice(i-s,i+s+1).every((x,k)=>k===s||c[i].h>x.h);
const bull=x=>x.c>x.o,bear=x=>x.c<x.o;

export const DETECTORS={
 // RSI divergence: price lower low, RSI higher low (first low oversold), then a bullish close above the previous high.
 'RSI 상승 다이버전스'(p,j){const c=p.c,last=c[j],prev=c[j-1],a=p.atr[j];if(!a||!bull(last)||last.c<=prev.h)return null;
  const lows=[];for(let i=j-3;i>=j-45&&i>=3;i--)if(pivotLow(c,i))lows.push(i);if(lows.length<2)return null;
  const [b,f]=[lows[0],lows[1]];if(j-b>8||b-f<5)return null;
  if(!(c[b].l<c[f].l&&p.rsi[b]>p.rsi[f]&&p.rsi[f]<35))return null;
  return {direction:'LONG',entry:last.c,stop:Math.min(c[b].l,last.l)-a*.2}},
 'RSI 하락 다이버전스'(p,j){const c=p.c,last=c[j],prev=c[j-1],a=p.atr[j];if(!a||!bear(last)||last.c>=prev.l)return null;
  const highs=[];for(let i=j-3;i>=j-45&&i>=3;i--)if(pivotHigh(c,i))highs.push(i);if(highs.length<2)return null;
  const [b,f]=[highs[0],highs[1]];if(j-b>8||b-f<5)return null;
  if(!(c[b].h>c[f].h&&p.rsi[b]<p.rsi[f]&&p.rsi[f]>65))return null;
  return {direction:'SHORT',entry:last.c,stop:Math.max(c[b].h,last.h)+a*.2}},
 // MACD: signal-line cross below zero (LONG) / above zero (SHORT), with the 200 EMA side as trend.
 'MACD 골든크로스(0선 아래)'(p,j){const m=p.macd,s=p.sig,a=p.atr[j];if([m[j],s[j],m[j-1],s[j-1],p.e200[j],a].some(x=>x==null))return null;
  if(!(m[j-1]<=s[j-1]&&m[j]>s[j]&&m[j]<0&&p.close[j]>p.e200[j]))return null;
  const low=Math.min(...p.c.slice(j-9,j+1).map(x=>x.l));return {direction:'LONG',entry:p.close[j],stop:low-a*.2}},
 'MACD 데드크로스(0선 위)'(p,j){const m=p.macd,s=p.sig,a=p.atr[j];if([m[j],s[j],m[j-1],s[j-1],p.e200[j],a].some(x=>x==null))return null;
  if(!(m[j-1]>=s[j-1]&&m[j]<s[j]&&m[j]>0&&p.close[j]<p.e200[j]))return null;
  const high=Math.max(...p.c.slice(j-9,j+1).map(x=>x.h));return {direction:'SHORT',entry:p.close[j],stop:high+a*.2}},
 // Bollinger: close back inside after closing outside the band (mean reversion toward the middle).
 '볼린저 하단 복귀'(p,j){const a=p.atr[j],c=p.c;if([p.bbLo[j],p.bbLo[j-1],a].some(x=>x==null))return null;
  if(!(c[j-1].c<p.bbLo[j-1]&&c[j].c>p.bbLo[j]&&bull(c[j])))return null;return {direction:'LONG',entry:c[j].c,stop:Math.min(c[j].l,c[j-1].l)-a*.2}},
 '볼린저 상단 복귀'(p,j){const a=p.atr[j],c=p.c;if([p.bbUp[j],p.bbUp[j-1],a].some(x=>x==null))return null;
  if(!(c[j-1].c>p.bbUp[j-1]&&c[j].c<p.bbUp[j]&&bear(c[j])))return null;return {direction:'SHORT',entry:c[j].c,stop:Math.max(c[j].h,c[j-1].h)+a*.2}},
 // Bollinger squeeze breakout: band width at a 60-bar low, then a close outside the band on 1.5x volume.
 '볼린저 수축 후 상단 돌파'(p,j){const a=p.atr[j],c=p.c;if([p.bbUp[j],p.bbMid[j],a,p.volAvg[j-1]].some(x=>x==null)||j<80)return null;
  const width=i=>(p.bbUp[i]-p.bbLo[i])/p.bbMid[i],w=[];for(let i=j-60;i<j;i++)if(p.bbUp[i]!=null)w.push(width(i));
  if(width(j-1)>Math.min(...w)*1.15||!(c[j].c>p.bbUp[j]&&bull(c[j])&&c[j].v>=1.5*p.volAvg[j-1]))return null;
  return {direction:'LONG',entry:c[j].c,stop:p.bbMid[j]-a*.2}},
 // Triple bottom: three pivot lows within 0.8 % (or 0.8 ATR), neckline close breakout.
 '삼중바닥 넥라인 돌파'(p,j){const c=p.c,a=p.atr[j];if(!a)return null;const lows=[];for(let i=j-3;i>=j-90&&i>=3;i--)if(pivotLow(c,i))lows.push(i);if(lows.length<3)return null;
  const t=lows.slice(0,3).reverse(),prices=t.map(i=>c[i].l),span=Math.max(...prices)-Math.min(...prices);
  if(span>Math.max(a*.8,prices[0]*.008)||t[1]-t[0]<4||t[2]-t[1]<4)return null;
  const neck=Math.max(...c.slice(t[0],t[2]+1).map(x=>x.h));if(!(c[j].c>neck&&c[j-1].c<=neck&&bull(c[j])))return null;
  return {direction:'LONG',entry:c[j].c,stop:Math.min(...prices)-a*.25}},
 // Ascending triangle: flat top (>=2 touches within 0.3 %), rising pivot lows, close breakout on volume.
 '상승삼각형 돌파'(p,j){const c=p.c,a=p.atr[j];if(!a||p.volAvg[j-1]==null)return null;const w=c.slice(j-40,j);if(w.length<40)return null;
  const top=Math.max(...w.map(x=>x.h)),touches=w.filter(x=>x.h>=top*.997).length;if(touches<2)return null;
  const lows=[];for(let i=j-40;i<j-3;i++)if(pivotLow(c,i))lows.push(c[i].l);if(lows.length<2||!lows.every((x,k)=>k===0||x>lows[k-1]))return null;
  if(!(c[j].c>top&&c[j-1].c<=top&&bull(c[j])&&c[j].v>=1.3*p.volAvg[j-1]))return null;return {direction:'LONG',entry:c[j].c,stop:lows.at(-1)-a*.2}},
 '하락삼각형 이탈'(p,j){const c=p.c,a=p.atr[j];if(!a||p.volAvg[j-1]==null)return null;const w=c.slice(j-40,j);if(w.length<40)return null;
  const floor=Math.min(...w.map(x=>x.l)),touches=w.filter(x=>x.l<=floor*1.003).length;if(touches<2)return null;
  const highs=[];for(let i=j-40;i<j-3;i++)if(pivotHigh(c,i))highs.push(c[i].h);if(highs.length<2||!highs.every((x,k)=>k===0||x<highs[k-1]))return null;
  if(!(c[j].c<floor&&c[j-1].c>=floor&&bear(c[j])&&c[j].v>=1.3*p.volAvg[j-1]))return null;return {direction:'SHORT',entry:c[j].c,stop:highs.at(-1)+a*.2}},
 // Candle reversals at a 20-bar extreme: bullish engulfing / hammer (and the mirrors).
 '상승장악형(20봉 저점)'(p,j){const c=p.c,x=c[j],y=c[j-1],a=p.atr[j];if(!a||j<21)return null;const low=Math.min(...c.slice(j-20,j+1).map(k=>k.l));
  if(!(bear(y)&&bull(x)&&x.o<=y.c&&x.c>=y.o&&Math.min(x.l,y.l)<=low))return null;return {direction:'LONG',entry:x.c,stop:Math.min(x.l,y.l)-a*.2}},
 '하락장악형(20봉 고점)'(p,j){const c=p.c,x=c[j],y=c[j-1],a=p.atr[j];if(!a||j<21)return null;const high=Math.max(...c.slice(j-20,j+1).map(k=>k.h));
  if(!(bull(y)&&bear(x)&&x.o>=y.c&&x.c<=y.o&&Math.max(x.h,y.h)>=high))return null;return {direction:'SHORT',entry:x.c,stop:Math.max(x.h,y.h)+a*.2}},
 '망치형(20봉 저점)'(p,j){const c=p.c,x=c[j],a=p.atr[j];if(!a||j<21)return null;const r=x.h-x.l,body=Math.abs(x.c-x.o),lower=Math.min(x.o,x.c)-x.l;
  if(!(r>0&&lower>=2*body&&lower>=.6*r&&x.l<=Math.min(...c.slice(j-20,j).map(k=>k.l))&&p.rsi[j]<40))return null;return {direction:'LONG',entry:x.c,stop:x.l-a*.2}},
 // Moving averages: 20/50 golden cross above the 200 EMA; pullback to the 50 EMA in an aligned uptrend.
 '이평 골든크로스(20/50, 200 위)'(p,j){const a=p.atr[j];if([p.e20[j],p.e50[j],p.e20[j-1],p.e50[j-1],p.e200[j],a].some(x=>x==null))return null;
  if(!(p.e20[j-1]<=p.e50[j-1]&&p.e20[j]>p.e50[j]&&p.close[j]>p.e200[j]))return null;const low=Math.min(...p.c.slice(j-9,j+1).map(x=>x.l));return {direction:'LONG',entry:p.close[j],stop:low-a*.2}},
 '이평 정배열 50선 눌림'(p,j){const c=p.c,x=c[j],a=p.atr[j];if([p.e20[j],p.e50[j],p.e200[j],a].some(v=>v==null))return null;
  if(!(p.e20[j]>p.e50[j]&&p.e50[j]>p.e200[j]&&x.l<=p.e50[j]&&x.c>p.e50[j]&&bull(x)))return null;return {direction:'LONG',entry:x.c,stop:Math.min(x.l,p.e50[j]-a*.5)-a*.2}},
 // Volume: a 20-bar high close on 2x average volume.
 '거래량 동반 20봉 고점 돌파'(p,j){const c=p.c,x=c[j],a=p.atr[j];if(!a||p.volAvg[j-1]==null||j<21)return null;const high=Math.max(...c.slice(j-20,j).map(k=>k.h));
  if(!(x.c>high&&bull(x)&&x.v>=2*p.volAvg[j-1]))return null;return {direction:'LONG',entry:x.c,stop:Math.min(x.l,x.c-a*1.2)-a*.1}},
};
