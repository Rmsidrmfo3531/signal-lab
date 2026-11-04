import test from 'node:test';
import assert from 'node:assert/strict';
import {rsi14,macdHistogram,adx14,bollinger20,obvDirection,evaluateIndicators,compositeWatchScore} from '../indicators.mjs';
function bars(sign=1){
 const now=1793750400000;
 return Array.from({length:150},(_,i)=>{
  const trend=100+sign*.35*i,wiggle=Math.sin(i*.45)*.22,price=trend+wiggle;
  return {time:now-(150-i)*3600000,open:price-.12*sign,high:price+.5,low:price-.5,close:price,
   volume:1000+(i%8)*30,closed:true};
 });
}
test('RSI MACD ADX Bollinger and OBV expose finite closed-1H readings',()=>{
 const b=bars(1),r=rsi14(b),m=macdHistogram(b),adx=adx14(b),bb=bollinger20(b),obv=obvDirection(b);
 assert.ok(r>50&&r<=100);
 assert.ok(Number.isFinite(m.histogram)&&Number.isFinite(m.previousHistogram));
 assert.ok(adx.adx>=0&&adx.adx<=100&&adx.plusDI>adx.minusDI);
 assert.ok(bb.upper>bb.middle&&bb.middle>bb.lower);
 assert.ok(obv>0);
});
test('directionally asymmetric LONG/SHORT scores on identical trends',()=>{
 const up=bars(1),down=bars(-1);
 const upLong=evaluateIndicators(up,'LONG'),upShort=evaluateIndicators(up,'SHORT');
 const downLong=evaluateIndicators(down,'LONG'),downShort=evaluateIndicators(down,'SHORT');
 assert.equal(upLong.valid,true);assert.equal(downShort.valid,true);
 assert.equal(upLong.checks.reduce((v,x)=>v+x.weight,0),100);
 for(const a of [upLong,upShort,downLong,downShort]){
  assert.ok(Number.isInteger(a.score)&&a.score>=0&&a.score<=100);
  assert.equal(a.checks.reduce((v,x)=>v+x.earned,0),a.score);
  assert.equal(a.version,'INDICATOR-V1');
 }
 assert.ok(upLong.score>upShort.score);
 assert.ok(downShort.score>downLong.score);
});
test('flat, incomplete and invalid data fail closed',()=>{
 const tooShort=bars().slice(0,20);
 assert.equal(evaluateIndicators(tooShort,'LONG').valid,false);
 const corrupt=bars();corrupt.at(-1).close=NaN;
 assert.equal(evaluateIndicators(corrupt,'LONG').score,null);
 assert.equal(evaluateIndicators(bars(),'SIDE').valid,false);
 const unfinished=bars();unfinished.at(-1).closed=false;
 assert.equal(evaluateIndicators(unfinished,'LONG').valid,false);
});
test('composite is 60% strict checklist and 40% indicator points, not a probability',()=>{
 const i={valid:true,score:80};
 assert.equal(compositeWatchScore(90,i),86);
 assert.equal(compositeWatchScore(100,{valid:true,score:0}),60);
 assert.equal(compositeWatchScore(100,{valid:true,score:100}),100);
 assert.equal(compositeWatchScore(90,{valid:false,score:80}),null);
 assert.equal(compositeWatchScore(NaN,i),null);
});
