import test from 'node:test';import assert from 'node:assert/strict';
import {BingXMarketData} from '../bingx_market.mjs';

// User 2026-11-16: coins listed or suspended on the exchange must be seen at once, not after the cache ends.
const row=(base,status=1)=>({symbol:`${base}-USDT`,currency:'USDT',asset:base,status,apiStateOpen:'true',apiStateClose:'true',pricePrecision:4,quantityPrecision:0,tradeMinQuantity:'1',tradeMinUSDT:'2',size:'1',feeRate:0.0005,maxLongLeverage:50,maxShortLeverage:50});
function client(lists){
 let t=1e12,reads=0;
 const fetcher=async url=>{const body=url.includes('/server/time')?{code:0,data:{serverTime:t}}:{code:0,data:lists[Math.min(reads++,lists.length-1)]};return new Response(JSON.stringify(body),{status:200,headers:{'content-type':'application/json'}})};
 const c=new BingXMarketData({fetcher,now:()=>t,minIntervalMs:0,sleep:async()=>{}});
 return {c,advance:ms=>{t+=ms},reads:()=>reads};
}

test('a coin missing from the cached contract list re-reads the list at once (at most once a minute)',async()=>{
 const {c,advance,reads}=client([[row('AAA')],[row('AAA'),row('NEW')],[row('AAA'),row('NEW')]]);
 assert.equal((await c.contractsFor('AAAUSDT')).has('NEWUSDT'),false);assert.equal(reads(),1);
 // Listed since: found without waiting for the 5-minute cache.
 assert.equal((await c.contractsFor('NEWUSDT')).get('NEWUSDT')?.tradable,true);assert.equal(reads(),2);
 // An unknown coin again within a minute: no new read.
 await c.contractsFor('NOPEUSDT');assert.equal(reads(),2);
 advance(61000);await c.contractsFor('NOPEUSDT');assert.equal(reads(),3);
});

test('a coin suspended on the exchange is not tradable after the re-read',async()=>{
 const {c}=client([[row('AAA')],[row('AAA',0)]]);
 assert.equal((await c.contractsFor('AAAUSDT')).get('AAAUSDT').tradable,true);
 const {c:c2}=client([[row('AAA',0)]]);
 assert.equal((await c2.contractsFor('AAAUSDT')).get('AAAUSDT')?.tradable,false);
});
