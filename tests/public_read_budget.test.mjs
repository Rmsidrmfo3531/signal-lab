import test from 'node:test';import assert from 'node:assert/strict';
import {PublicReadBudget,binanceReadWeight} from '../public_read_budget.mjs';
test('bounded public-candle and trade weights prevent a new full-universe scan from unlimited REST expansion',()=>{
 let now=100000;const budget=new PublicReadBudget({now:()=>now,maxWeight:44});
 assert.equal(binanceReadWeight('/fapi/v1/klines?limit=301'),2);assert.equal(binanceReadWeight('/fapi/v1/aggTrades?limit=1000'),20);
 assert.equal(budget.reserve('/fapi/v1/ticker/24hr').ok,true);assert.equal(budget.reserve('/fapi/v1/klines?limit=301').ok,true);
 assert.equal(budget.reserve('/fapi/v1/klines?limit=301').ok,true);assert.equal(budget.reserve('/fapi/v1/aggTrades').ok,false);
 now+=60000;assert.equal(budget.reserve('/fapi/v1/aggTrades').ok,true);assert.equal(budget.snapshot().usedWeight,20);
});
test('HTTP429 or418 suspends new public reads without retrying into a ban and invalid limits do not disable protection',()=>{
 let now=100000;const budget=new PublicReadBudget({now:()=>now});budget.rateLimited(429,'120');
 assert.equal(budget.reserve('/fapi/v1/depth').code,'BINANCE_PUBLIC_COOLDOWN');now+=120000;assert.equal(budget.reserve('/fapi/v1/depth').ok,true);
 budget.rateLimited(418,NaN);assert.equal(budget.reserve('/fapi/v1/depth').ok,false);
 for(const maxWeight of [NaN,Infinity,0,2401])assert.throws(()=>new PublicReadBudget({maxWeight}),/INVALID/);
});
