import test from 'node:test';
import assert from 'node:assert/strict';
import {compareOrangeXBinance} from '../orangex_comparison.mjs';
const NOW=Date.parse('2026-10-27T06:00:00Z');
const market={instrumentName:'BTC-USDT-PERPETUAL',bid:100.01,ask:100.03,priceAt:NOW,markPrice:500};
const quote={symbol:'BTCUSDT',price:100,priceAt:NOW,exchangePriceAt:NOW};

test('fresh source clocks permit an observed midpoint comparison without approving contract equivalence or using Mark',()=>{
 const result=compareOrangeXBinance(market,quote,{now:NOW});
 assert.equal(result.status,'OBSERVATION_ONLY');assert.ok(Math.abs(result.gapBps-2)<1e-8);
 assert.equal(result.mappingVerified,false);assert.equal(result.orderSubmissionEnabled,false);assert.equal(result.referenceSymbol,'BTCUSDT');
});
test('receipt time alone, old/future source clocks and crossed books do not produce a fresh comparison',()=>{
 for(const source of [undefined,null,NOW-90001,NOW+5001])assert.equal(compareOrangeXBinance(market,{...quote,exchangePriceAt:source},{now:NOW}).gapBps,null);
 assert.equal(compareOrangeXBinance({...market,priceAt:NOW-90001},quote,{now:NOW}).gapBps,null);
 assert.equal(compareOrangeXBinance({...market,bid:101},quote,{now:NOW}).gapBps,null);
});
test('USDC contracts and mismatched Binance names are never silently treated as USDT equivalents',()=>{
 const different=compareOrangeXBinance({...market,instrumentName:'BTC-USDC-PERPETUAL'},quote,{now:NOW});
 assert.equal(different.status,'UNVERIFIED_MAPPING');assert.equal(different.referenceSymbol,null);assert.equal(different.gapBps,null);
 assert.equal(compareOrangeXBinance(market,{...quote,symbol:'ETHUSDT'},{now:NOW}).gapBps,null);
});
