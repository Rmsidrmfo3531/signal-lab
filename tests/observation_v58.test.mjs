import test from 'node:test';
import assert from 'node:assert/strict';
import {structureObservations,historicalPatternObservations} from '../observation.mjs';
const h=3600000;const now=Date.now();
function rows(n,tf,shift=0){return Array.from({length:n},(_,i)=>{
 const price=100+i*.012+Math.sin(i/3)*.4;
 return [now-(n-i)*tf,price.toString(),(price+.3).toString(),(price-.3).toString(),price.toString(),"10000", now-(n-i-1)*tf-1,"1000000"];});}
test('observations are read only / never tradeable',()=>{
 const a=structureObservations('BTCUSDT',rows(150,h),rows(110,4*h));
 assert.ok(Array.isArray(a));for(const x of a){assert.equal(x.tradeEligible,false);assert.equal(x.status,'OBSERVATION_ONLY');}
});
test('short/incomplete candles do not cause observations',()=>{
 assert.deepEqual(structureObservations('BTCUSDT',rows(5,h),rows(3,4*h)),[]);
});
test('past closed patterns are not current trade signals',()=>{
 const hist=historicalPatternObservations('BTCUSDT',rows(150,h),rows(110,4*h));
 for(const x of hist){assert.equal(x.tradeEligible,false);assert.ok(x.confirmedAt<=now);assert.ok(x.confirmedAt>=now-24*h)}
});
