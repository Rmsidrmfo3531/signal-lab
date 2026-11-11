// Score factors taken from the user's study materials (LEE의 차트연구소 videos and
// 투자성공기 blog posts). Each factor is a yes/no check on closed candles, in the trade's
// direction. Weights are set from data (see SCORE_V2_WEIGHTS), not by hand.
//
//  material                                   factor key
//  -----------------------------------------  ----------------------------------------
//  "큰 시간봉일수록 신뢰도"(추세선·이평)        htf4h, btc4h
//  이평선: 5선 위 롱/아래 숏, 20선=기준선,     ma5Side, ma20Side, maStack, ma200Side
//          정배열/역배열, 장기 이평 = 강한 지지저항
//  거래량: 평균 대비 많은 거래량 동반 돌파      volumeSpike
//  지지/저항: 거래량 1등 캔들의 위아래 선       levelBehindStop, roomAhead
//  추세선: 꼬리를 이은 선의 방향               trendSlope
//  RSI: 과매수에 롱·과매도에 숏 금지, 50 기준   rsiNotExtreme, rsiMomentum
//  MACD: 시그널선 위/아래, 0선                 macdAligned, macdZeroSide
//  다이버전스(RSI·MACD)                        divergence
//  캔들: 몸통 마감, 반대 꼬리 짧음(도지 아님)   candleBody, noOpposingWick
import {prepare,volumeLevels} from './pattern_detectors.mjs';
import {fourHourTrend} from './scalp_reversal.mjs';

const sma=(v,n,j)=>j>=n-1?v.slice(j-n+1,j+1).reduce((a,b)=>a+b,0)/n:null;
const toBar=r=>Array.isArray(r)?{t:+r[0],o:+r[1],h:+r[2],l:+r[3],c:+r[4],v:+r[5],ct:+r[6]}:{t:r.time,o:r.open,h:r.high,l:r.low,c:r.close,v:r.volume,ct:r.closeTime};
const pivotLow=(c,i,s=2)=>i>=s&&i+s<c.length&&c.slice(i-s,i+s+1).every((x,k)=>k===s||c[i].l<x.l);
const pivotHigh=(c,i,s=2)=>i>=s&&i+s<c.length&&c.slice(i-s,i+s+1).every((x,k)=>k===s||c[i].h>x.h);

export const FACTOR_LABELS=Object.freeze({
 htf4h:'4H 추세 같은 방향',btc4h:'BTC 4H 추세 같은 방향(또는 횡보)',ma5Side:'5이평 위(롱)/아래(숏)',ma20Side:'20이평(기준선) 위/아래',
 maStack:'5>20>60 정배열(롱)/역배열(숏)',ma200Side:'200이평 위/아래',volumeSpike:'신호 봉 거래량 평균 1.5배 이상',
 levelBehindStop:'손절 앞에 거래량 1등 캔들 선(지지/저항)이 받침',roomAhead:'1.5R 안에 막는 거래량선·장기이평 없음',
 trendSlope:'최근 20봉 추세선 기울기 같은 방향',rsiNotExtreme:'RSI 과열 아님(롱 70 미만/숏 30 초과)',rsiMomentum:'RSI 50 위(롱)/아래(숏)',
 macdAligned:'MACD가 시그널 위(롱)/아래(숏)',macdZeroSide:'MACD 0선 위(롱)/아래(숏)',divergence:'RSI·MACD 다이버전스 같은 방향',
 candleBody:'신호 봉 몸통 50% 이상·방향 마감',noOpposingWick:'반대 꼬리 30% 이하'});

/** All factors for a set-up on the last closed 1H candle. Rows are Binance arrays or engine candles. */
export function scoreFactors({h1,h4,btcH4=null,direction,entry,stop,now}){
 const c=h1.map(toBar),p=prepare(c),j=c.length-1,x=c[j],d=direction==='LONG'?1:-1,a=p.atr[j],close=p.close;
 const risk=Math.abs(entry-stop),side=(value,ref)=>ref!=null&&d*(value-ref)>0;
 const s5=sma(close,5,j),s20=sma(close,20,j),s60=sma(close,60,j),s200=sma(close,200,j),s300=sma(close,300,j);
 const t4=fourHourTrend(h4,now),tb=btcH4?fourHourTrend(btcH4,now):null;
 const levels=j>=10?volumeLevels(p,j):[];
 const opposing=[...levels,s200,s300].filter(l=>l!=null&&d*(l-entry)>0&&d*(l-entry)<1.5*risk);
 // Least-squares slope of the last 20 lows (long) / highs (short).
 const w=c.slice(-20),ys=w.map(k=>d===1?k.l:k.h),n=ys.length,mx=(n-1)/2,my=ys.reduce((s,v)=>s+v,0)/n;
 const slope=ys.reduce((s,v,i)=>s+(i-mx)*(v-my),0)/ys.reduce((s,_,i)=>s+(i-mx)**2,0);
 let divergence=false;{const piv=[];for(let i=j-1;i>=j-40&&i>=3;i--)if(d===1?pivotLow(c,i):pivotHigh(c,i))piv.push(i);
  if(piv.length>=2){const [b,f]=piv;if(j-b<=12&&b-f>=4){const price=d===1?c[b].l<c[f].l:c[b].h>c[f].h;
   divergence=price&&(d===1?p.rsi[b]>p.rsi[f]||p.macd[b]>p.macd[f]:p.rsi[b]<p.rsi[f]||p.macd[b]<p.macd[f])}}}
 const range=x.h-x.l,body=range>0?Math.abs(x.c-x.o)/range:0,opp=range>0?(d===1?x.h-Math.max(x.o,x.c):Math.min(x.o,x.c)-x.l)/range:1;
 return {
  htf4h:t4===(d===1?'up':'down'),btc4h:tb===null?true:tb===(d===1?'up':'down')||tb==='range',
  ma5Side:side(x.c,s5),ma20Side:side(x.c,s20),maStack:s5!=null&&s60!=null&&d*(s5-s20)>0&&d*(s20-s60)>0,ma200Side:side(x.c,s200),
  volumeSpike:p.volAvg[j-1]!=null&&x.v>=1.5*p.volAvg[j-1],
  levelBehindStop:levels.some(l=>d*(l-stop)>0&&d*(entry-l)>0),roomAhead:opposing.length===0,
  trendSlope:Number.isFinite(slope)&&d*slope>0,
  rsiNotExtreme:p.rsi[j]!=null&&(d===1?p.rsi[j]<70:p.rsi[j]>30),rsiMomentum:p.rsi[j]!=null&&d*(p.rsi[j]-50)>0,
  macdAligned:p.macd[j]!=null&&p.sig[j]!=null&&d*(p.macd[j]-p.sig[j])>0,macdZeroSide:p.macd[j]!=null&&d*p.macd[j]>0,
  divergence,candleBody:body>=.5&&d*(x.c-x.o)>0,noOpposingWick:opp<=.3,
  _atr:a};
}

// Weights fitted on days 1-120 of a 180-day, 12-symbol replay (7,212 validated 1H set-ups):
// a factor is kept only when both training thirds agree in sign; "!" scores the factor's absence.
// Out of sample (days 121-180) SHORT >= 60 was +$283 / PF 1.81 against -$8 for the current rule,
// but days 61-120 stayed negative (-$166), so this is a research score: it is not a live gate.
export const SCORE_V2_WEIGHTS=Object.freeze({
 LONG:Object.freeze({divergence:62,levelBehindStop:38}),
 SHORT:Object.freeze({'!ma5Side':19,'!roomAhead':17,'!macdAligned':17,'!ma20Side':14,levelBehindStop:12,'!volumeSpike':9,trendSlope:7,'!divergence':5})});

/** 0-100 score and the items that earned points. */
export function scoreV2(factors,direction){
 const items=Object.entries(SCORE_V2_WEIGHTS[direction]||{}).map(([key,weight])=>{const inverted=key[0]==='!',name=inverted?key.slice(1):key;
  return {key,label:(inverted?'아님: ':'')+FACTOR_LABELS[name],weight,earned:(inverted?!factors[name]:!!factors[name])?weight:0}});
 return {score:items.reduce((s,i)=>s+i.earned,0),items};
}
