import test from 'node:test';import assert from 'node:assert/strict';
import {PublicReadBudget,binanceReadWeight,budgetedPublicRead} from '../public_read_budget.mjs';
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
// 고래 CVD side read (review 2026-11-25): budget reserved at the call, 429 cooldown shared, own timeout, no server state.
test('budgetedPublicRead reserves the weight synchronously, shares the 429 cooldown, aborts on its own timeout and throws on failure',async()=>{
 let now=100000;const budget=new PublicReadBudget({now:()=>now,maxWeight:100});const urls=[];
 const ok=async(url,opt)=>{urls.push(url);assert.ok(opt.signal instanceof AbortSignal);return {ok:true,status:200,json:async()=>[{a:1}]}};
 const p=budgetedPublicRead('/fapi/v1/aggTrades?symbol=SOLUSDT&limit=1000',{budget,fetcher:ok});
 assert.equal(budget.snapshot().usedWeight,20,'reserved before the first await (no interleaving with a room check)');
 assert.deepEqual(await p,[{a:1}]);assert.equal(urls[0],'https://fapi.binance.com/fapi/v1/aggTrades?symbol=SOLUSDT&limit=1000');
 // 429: throws and starts the shared cooldown; the next read is refused before any fetch.
 await assert.rejects(budgetedPublicRead('/fapi/v1/aggTrades',{budget,fetcher:async()=>({ok:false,status:429,headers:{get:()=>'90'}})}),/Binance HTTP 429/);
 assert.equal(budget.snapshot().cooldownUntil,now+90000);
 let called=0;await assert.rejects(budgetedPublicRead('/fapi/v1/aggTrades',{budget,fetcher:async()=>{called++}}),/BINANCE_PUBLIC_COOLDOWN/);assert.equal(called,0);
 // Full budget: refused before any fetch.
 now+=200000;for(let i=0;i<5;i++)budget.reserve('/fapi/v1/aggTrades');
 await assert.rejects(budgetedPublicRead('/fapi/v1/aggTrades',{budget,fetcher:async()=>{called++}}),/BINANCE_PUBLIC_WEIGHT_BUDGET/);assert.equal(called,0);
 // Own timeout: a hanging fetch is aborted.
 now+=60000;const t0=Date.now();
 const hang=(url,{signal})=>new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(Error('aborted'))));
 await assert.rejects(budgetedPublicRead('/fapi/v1/aggTrades',{budget,fetcher:hang,timeoutMs:150}),/aborted/);
 assert.ok(Date.now()-t0<2000,'aborted on its own timeout');
});
test('P0-4: depth?limit=1000 weighs 50 and orderflow/firechart respect shared PublicReadBudget cooldown',async()=>{
 assert.equal(binanceReadWeight('/fapi/v1/depth?symbol=BTCUSDT&limit=1000'),50);
 assert.equal(binanceReadWeight('/fapi/v1/depth?symbol=BTCUSDT&limit=500'),10);
 const {fetchFirechartExtras}=await import('../firechart.mjs');
 let now=200000;const budget=new PublicReadBudget({now:()=>now,maxWeight:100});
 budget.rateLimited(429,'60');
 const called=[];
 const fetcher=async u=>{called.push(u);return {ok:true,status:200,json:async()=>({bids:[],asks:[]})}};
 await fetchFirechartExtras('BTCUSDT',{needTrades:true,budget,fetcher,gateContract:'BTC_USDT',bingxSymbol:'BTC-USDT'});
 assert.equal(called.filter(u=>u.includes('fapi.binance.com')).length,0,'Binance calls skipped while PublicReadBudget is in 429 cooldown');
});

