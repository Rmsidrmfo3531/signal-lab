import test from 'node:test';
import assert from 'node:assert/strict';
import * as indicators from '../indicators.mjs';
const {rsi14,macdHistogram,adx14,atrWilder,seededEMA,evaluateIndicators}=indicators;
function bars(sign=1){
 const now=1793750400000;
 return Array.from({length:150},(_,i)=>{
  const price=100+sign*.35*i+Math.sin(i*.45)*.22;
  return {time:now-(150-i)*3600000,open:price-.12*sign,high:price+.5,low:price-.5,close:price,
   volume:1000+(i%8)*30,closed:true};
 });
}
test('Wilder RSI ADX/DMI, MACD and ATR expose finite closed-1H readings',()=>{
 const b=bars(1),r=rsi14(b),m=macdHistogram(b),adx=adx14(b),atr=atrWilder(b);
 assert.ok(r>50&&r<=100);assert.ok(Number.isFinite(m.histogram)&&Number.isFinite(m.previousHistogram));
 assert.ok(adx.adx>=0&&adx.adx<=100&&adx.plusDI>adx.minusDI);assert.ok(atr>0);
});
test('indicator readings cannot create a second weighted or60:40 composite score',()=>{
 for(const direction of ['LONG','SHORT']){
  const r=evaluateIndicators(bars(direction==='LONG'?1:-1),direction);assert.equal(r.valid,true);assert.equal(r.score,null);
  assert.deepEqual(r.checks,[]);assert.equal(r.version,'ISSUE6-INDICATORS-V2');
  assert.ok(!Object.hasOwn(r.values,'obvDelta'));assert.ok(!Object.hasOwn(r.values,'bbMiddle'));
 }
 assert.equal(Object.hasOwn(indicators,'compositeWatchScore'),false);
});
test('incomplete, unfinished and invalid readings fail closed',()=>{
 assert.equal(evaluateIndicators(bars().slice(0,20),'LONG').valid,false);
 const corrupt=bars();corrupt.at(-1).close=NaN;assert.equal(evaluateIndicators(corrupt,'LONG').score,null);
 assert.equal(evaluateIndicators(bars(),'SIDE').valid,false);
 const unfinished=bars();unfinished.at(-1).closed=false;assert.equal(evaluateIndicators(unfinished,'LONG').valid,false);
});
test('EMA has an SMA seed only after its full period and never uses future values',()=>{
 assert.deepEqual(seededEMA([1,2],3),[]);assert.deepEqual(seededEMA([1,2,3,4],3),[null,null,2,3]);
 const prefix=seededEMA([1,2,3,4],3),long=seededEMA([1,2,3,4,1000],3);assert.deepEqual(long.slice(0,4),prefix);
 const c=Array.from({length:30},(_,i)=>({close:100,open:100,high:102,low:98,volume:1}));
 assert.equal(rsi14(c),50);assert.equal(atrWilder(c),4);assert.equal(macdHistogram([...c,...c]).histogram,0);
});
