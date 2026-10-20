import test from 'node:test';import assert from 'node:assert/strict';import {signalLifecycle} from '../signal_lifecycle.mjs';
const now=Date.parse('2026-10-18T08:00:00Z');const s={symbol:'BTCUSDT',entry:100,stop:99,target1:102,direction:'LONG',patternConfirmedAt:now-60000,atr:.2};
const data=(price,delta=1000)=>signalLifecycle(s,{now,price,priceAt:now-delta});
test('up-to-date signal can be current but not an order recommendation',()=>assert.equal(data(100.1).code,'current'));
test('signal invalidation, target reached, chase and old feed are distinguished',()=>{assert.equal(data(98).code,'invalidated');assert.equal(data(103).code,'target-hit');assert.equal(data(101).code,'chase');assert.equal(data(100,120000).code,'stale')});
test('expired signal is not current despite price near entry',()=>assert.equal(signalLifecycle({...s,patternConfirmedAt:now-9*3600000},{now,price:100,priceAt:now}).code,'expired'));
