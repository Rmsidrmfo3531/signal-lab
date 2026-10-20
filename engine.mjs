import {gradeSetup,STRICT_MIN_SCORE} from './quality.mjs';
// Price-action scanner for closed Binance futures candles. No trading or order execution.
export const number = value => Number(value);
export function normalizedKlines(rows, now=Date.now()) {
  if (!Array.isArray(rows)) return [];
  return rows.map(r => Array.isArray(r) ? ({
    time:Number(r[0]), closeTime:Number(r[6]), open:Number(r[1]), high:Number(r[2]), low:Number(r[3]), close:Number(r[4]),
    volume:Number(r[5]), quoteVolume:Number(r[7]||0), closed:Number(r[6]) < now
  }) : r).filter(k => [k.open,k.high,k.low,k.close,k.volume].every(Number.isFinite)).sort((a,b)=>a.time-b.time);
}
export function ema(values, period) {
  if (!values?.length) return [];
  const result=[]; const a=2/(period+1); let v=values[0];
  for (const x of values) { v = a*x+(1-a)*v; result.push(v); }
  return result;
}
export function atr(candles, period=14) {
  if(candles.length < period+1) return 0;
  let sum=0; const tails=candles.slice(-period);
  for(let i=0;i<tails.length;i++) {
    const idx=candles.length-period+i, c=candles[idx], prior=candles[idx-1];
    sum+=Math.max(c.high-c.low,Math.abs(c.high-prior.close),Math.abs(c.low-prior.close));
  }
  return sum/period;
}
export function recentPivots(candles, span=2) {
  const lows=[], highs=[];
  for(let i=span;i<candles.length-span;i++) {
    const sub=candles.slice(i-span,i+span+1), c=candles[i];
    if(sub.every((x,j)=>j===span||c.low<x.low)) lows.push({price:c.low,time:c.time});
    if(sub.every((x,j)=>j===span||c.high>x.high)) highs.push({price:c.high,time:c.time});
  }
  return {lows,highs};
}
export function levels(hourly, fourHour, price) {
  const a=recentPivots(hourly.slice(-120)), b=recentPivots(fourHour.slice(-100));
  const pool=[...a.lows.map(x=>({...x,kind:'support',source:'1h'})), ...a.highs.map(x=>({...x,kind:'resistance',source:'1h'})),
    ...b.lows.map(x=>({...x,kind:'support',source:'4h'})),...b.highs.map(x=>({...x,kind:'resistance',source:'4h'}))];
  const supports=pool.filter(x=>x.price<price).sort((x,y)=>y.price-x.price);
  const resistances=pool.filter(x=>x.price>price).sort((x,y)=>x.price-y.price);
  const supportsUnique=[], resistancesUnique=[];
  const distance=Math.max(atr(hourly)*.22,price*.0005);
  for (const c of supports) if(!supportsUnique.some(x=>Math.abs(x.price-c.price)<distance)) supportsUnique.push(c);
  for (const c of resistances) if(!resistancesUnique.some(x=>Math.abs(x.price-c.price)<distance)) resistancesUnique.push(c);
  const fallbackLow=Math.min(...hourly.slice(-24,-1).map(x=>x.low));
  const fallbackHigh=Math.max(...hourly.slice(-24,-1).map(x=>x.high));
  if(!supportsUnique.length && Number.isFinite(fallbackLow) && fallbackLow < price) supportsUnique.push({price:fallbackLow,source:'1h range',kind:'support'});
  if(!resistancesUnique.length && Number.isFinite(fallbackHigh) && fallbackHigh>price) resistancesUnique.push({price:fallbackHigh,source:'1h range',kind:'resistance'});
  return {supports:supportsUnique.slice(0,3),resistances:resistancesUnique.slice(0,3)};
}
export function formatPrice(price) {
  if(!Number.isFinite(price)||price<=0) return '—';
  if(price>=1000)return price.toLocaleString('en-US',{maximumFractionDigits:2});
  if(price>=1)return price.toLocaleString('en-US',{maximumFractionDigits:4});
  if(price>=.01)return price.toFixed(5);
  if(price>=.0001)return price.toFixed(7);
  return price.toFixed(Math.min(14,Math.max(8,Math.ceil(-Math.log10(price))+5))).replace(/0+$/,'').replace(/\.$/,'');
}
export const CONFIG = {
  BTC:{min:20,max:40,default:20}, ETH:{min:10,max:25,default:15}, SOL:{min:10,max:15,default:10}, OTHER:{min:3,max:5,default:3}
};
export function riskPosition(symbol, entry, stop, costPercent=.10, riskUSD=6) {
  const group=symbol.startsWith('BTC')?'BTC':symbol.startsWith('ETH')?'ETH':symbol.startsWith('SOL')?'SOL':'OTHER';
  const lev=CONFIG[group].default;
  const distance=Math.abs(entry-stop)/entry;
  const tradeCost=costPercent/100;
  if(!Number.isFinite(distance)||distance===0)return null;
  const nominal=Math.min(3000, riskUSD/(distance+tradeCost));
  return {nominal, margin:nominal/lev, leverage:lev, riskUSD:nominal*(distance+tradeCost), riskPct:distance*100, costUSD:nominal*tradeCost};
}
function volumeRatio(candles) {
  const avg=candles.slice(-21,-1).reduce((s,x)=>s+x.volume,0)/20;
  return avg>0?candles.at(-1).volume/avg:0;
}
function recentRange(candles, count) {
  const a=candles.slice(-count-1,-1);
  return {high:Math.max(...a.map(x=>x.high)),low:Math.min(...a.map(x=>x.low))};
}
export function analyze(symbol, h1Rows, h4Rows, m15Rows=[], priceOverride=null, meta={}) {
  const now=Date.now();
  const h1=normalizedKlines(h1Rows,now).filter(c=>c.closed);
  const h4=normalizedKlines(h4Rows,now).filter(c=>c.closed);
  if(h1.length<65||h4.length<60) return {symbol,status:'insufficient',reason:'봉 데이터 부족'};
  const last=h1.at(-1), prev=h1.at(-2), price=Number(priceOverride)>0?Number(priceOverride):last.close;
  const values1=h1.map(x=>x.close), values4=h4.map(x=>x.close);
  const e1=ema(values1,20).at(-1), e4f=ema(values4,20).at(-1),e4s=ema(values4,50).at(-1);
  const a=atr(h1), vRatio=volumeRatio(h1);
  if(!Number.isFinite(a)||a<=0)return {symbol,status:'insufficient',reason:'ATR 산출 불가'};
  const lv=levels(h1,h4,price);
  const trend=e4f>e4s&&h4.at(-1).close>e4f?'up':e4f<e4s&&h4.at(-1).close<e4f?'down':'range';
  const buy=trend==='up',sell=trend==='down';
  const zone=recentRange(h1.slice(0,-1),20);
  const prevSupport=Math.min(...h1.slice(-18,-1).map(c=>c.low));
  const prevResistance=Math.max(...h1.slice(-18,-1).map(c=>c.high));
  const candidates=[];
  const push=(direction,pattern,entry,stop,_legacyScore,reason)=>{
    if (!(entry>0&&stop>0)) return;
    const r=Math.abs(entry-stop);
    if(r<price*.0002 || !Number.isFinite(r)) return;
    const target1=direction==='LONG'?entry+r*2:entry-r*2;
    const target2=direction==='LONG'?entry+r*3:entry-r*3;
    const target3=direction==='LONG'?entry+r*4:entry-r*4;
    if(target1<=0||target2<=0)return;
    const obstacle = direction==='LONG'?lv.resistances.find(x=>x.price>entry&&x.price<target1):lv.supports.find(x=>x.price<entry&&x.price>target1);
    // Do not discard the pattern record. Instead, record an explicit veto reason.
    // The pattern must pass every independent gate before being shown as a signal.
    // Closed-candle chart recognition is independent of the latest quote.
    // The quality gate below decides whether the setup is still actionable.
    const quality=gradeSetup({direction,h1,h4,trend,atr1h:a,volumeRatio:vRatio,entry,stop,target1,obstacle,dayQuoteVolume:meta.quoteVolume,now});
    const risk=riskPosition(symbol,entry,stop,.12,6);
    candidates.push({direction,pattern,entry,stop,target1,target2,target3:target3>0?target3:null,rr:2,score:quality.score,quality,technicalQualified:quality.passed,reason,atr:a,volumeRatio:vRatio,risk});
  };
  // A confirmed close over a former range high / under former range low.
  if(last.close>zone.high+a*.06 && last.close>last.open && prev.close<=zone.high && buy) {
    push('LONG','박스권 상단 돌파',last.close, Math.min(zone.high-a*.25,last.low-a*.1),59,'1H 종가 저항 돌파, 4H 상승 추세');
  }
  if(last.close<zone.low-a*.06 && last.close<last.open && prev.close>=zone.low && sell) {
    push('SHORT','박스권 하단 이탈',last.close,Math.max(zone.low+a*.25,last.high+a*.1),59,'1H 종가 지지 이탈, 4H 하락 추세');
  }
  // Sweep + reclaim / rejection.
  if(last.low<prevSupport-a*.06&&last.close>prevSupport&&last.close>last.open&&!sell) {
    push('LONG','저점 스윕 후 회복',last.close,last.low-a*.20,63,'기존 저점 일시 이탈 후 1H 종가 회복');
  }
  if(last.high>prevResistance+a*.06&&last.close<prevResistance&&last.close<last.open&&!buy) {
    push('SHORT','고점 스윕 후 하락',last.close,last.high+a*.20,63,'기존 고점 일시 돌파 후 1H 종가 재진입');
  }
  // Trend pullback to EMA20 with 1h candle confirmation.
  if(buy&&last.low<=e1+a*.18&&last.close>e1&&last.close>last.open&&prev.close<=e1+a*.3) {
    push('LONG','상승 추세 눌림목',last.close, Math.min(last.low-a*.25,e1-a*.65),52,'4H 상승 추세 + 1H EMA20 회복');
  }
  if(sell&&last.high>=e1-a*.18&&last.close<e1&&last.close<last.open&&prev.close>=e1-a*.3) {
    push('SHORT','하락 추세 반등 숏',last.close,Math.max(last.high+a*.25,e1+a*.65),52,'4H 하락 추세 + 1H EMA20 저항');
  }
  // Retest after breakout: current candle touches previous breakout line then rejects.
  const prior=h1.slice(-24,-3);
  if(prior.length) {
    const ph=Math.max(...prior.map(c=>c.high)),pl=Math.min(...prior.map(c=>c.low));
    if(buy&&prev.close>ph+a*.05&&last.low<=ph+a*.25&&last.close>ph&&last.close>last.open) {
      push('LONG','돌파 후 지지 재확인',last.close,Math.min(last.low-a*.2,ph-a*.4),66,'이전 저항이 지지로 전환된 리테스트');
    }
    if(sell&&prev.close<pl-a*.05&&last.high>=pl-a*.25&&last.close<pl&&last.close<last.open) {
      push('SHORT','이탈 후 저항 재확인',last.close,Math.max(last.high+a*.2,pl+a*.4),66,'이전 지지가 저항으로 전환된 리테스트');
    }
  }

  // Completed reversal formations (not subjective image recognition): two confirmed
  // swing extremes, a neckline, and a completed 1H close through that neckline.
  // More than one swing pivot is required to avoid labelling a lone V as a double bottom.
  const older=h1.slice(-85,-1);
  const swings=recentPivots(older,3);
  const lastCrossedUp=(neck)=>last.close>neck+a*.06&&prev.close<=neck&&last.close>last.open;
  const lastCrossedDown=(neck)=>last.close<neck-a*.06&&prev.close>=neck&&last.close<last.open;
  const doubleExtremes=(points,orientation)=>{
    for(let k=points.length-1;k>=1;k--){
      const b=points[k];
      for(let j=k-1;j>=Math.max(0,k-6);j--){
        const first=points[j],gap=(b.time-first.time)/3600000;
        if(gap<5||gap>50||Math.abs(b.price-first.price)>Math.max(a*.7,price*.006))continue;
        const between=older.filter(x=>x.time>first.time&&x.time<b.time);
        if(between.length<3)continue;
        const neck=orientation==='bottom'?Math.max(...between.map(x=>x.high)):Math.min(...between.map(x=>x.low));
        const depth=orientation==='bottom'?neck-Math.max(first.price,b.price):Math.min(first.price,b.price)-neck;
        if(depth<a*.8)continue;
        return {first,b,neck};
      }
    }
    return null;
  };
  if(!sell&&vRatio>=1.10){
    const db=doubleExtremes(swings.lows,'bottom');
    if(db&&lastCrossedUp(db.neck))push('LONG','이중바닥 넥라인 돌파',last.close,Math.min(db.first.price,db.b.price)-a*.25,72,'두 저점의 가격 근접·간격 확인, 1H 넥라인 상향 종가 돌파');
  }
  if(!buy&&vRatio>=1.10){
    const dt=doubleExtremes(swings.highs,'top');
    if(dt&&lastCrossedDown(dt.neck))push('SHORT','이중천장 넥라인 이탈',last.close,Math.max(dt.first.price,dt.b.price)+a*.25,72,'두 고점의 가격 근접·간격 확인, 1H 넥라인 하향 종가 이탈');
  }
  const best=candidates.sort((a,b)=>Number(b.technicalQualified)-Number(a.technicalQualified)||b.score-a.score)[0]??null;
  // The closed 1H confirmation and 4H trend are required; venue liquidity
  // and spread checks are applied separately in server.mjs.
  const quality = best && best.technicalQualified && best.score>=STRICT_MIN_SCORE &&
    Math.abs(price-best.entry)/price<=Math.min(.004, a/price*.45) &&
    (best.direction==='LONG'?price>best.stop:price<best.stop);
  return {
    symbol, price, trend, ema20:e1, atr:a, volumeRatio:vRatio, supports:lv.supports,
    resistances:lv.resistances, time:last.time, status:quality?'signal':best?'watch':'neutral',
    ...(best?{...best,qualified:Boolean(quality)}:{}),quoteVolume:Number(meta.quoteVolume||0),
    priceChangePercent:Number(meta.priceChangePercent||0),scannedAt:now,
    patternConfirmed:Boolean(best),patternTimeframe:'1h',
    patternConfirmedAt:best ? (Number(last.closeTime)||last.time+3600000) : null,
    confirmationNotes:best ? ['1시간봉 종가 확정','4시간봉 최근 마감 구조 평가',vRatio>=1.6?'거래량 확증 확인':'거래량 배율 부족'] : [],
    patternInvalidated:best ? (best.direction==='LONG'?price<=best.stop:price>=best.stop) : false
  };
}
