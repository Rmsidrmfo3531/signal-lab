import test from 'node:test';
import assert from 'node:assert/strict';
import {buildMarketCommentary} from '../market_commentary.mjs';
const NOW=Date.parse('2026-11-04T07:00:00Z');
const ticker=(symbol,change,volume)=>({symbol,lastPrice:'100',priceChangePercent:String(change),highPrice:'110',lowPrice:'90',quoteVolume:String(volume),closeTime:NOW-500});
const fixture=()=>[ticker('BTCUSDT',2,500),ticker('ETHUSDT',-1,400),ticker('SOLUSDT',3,300),ticker('DOGEUSDT',0,100)];
const options={now:NOW,receivedAt:NOW-100,dataSource:'SYNTHETIC_TEST',eligibleSymbols:['BTCUSDT','ETHUSDT','SOLUSDT','DOGEUSDT']};

test('factual Korean market summary calculates collected breadth, traded notional and high-low range without forecasts or causes',()=>{
 const rows=fixture(),before=JSON.stringify(rows),result=buildMarketCommentary(rows,options);
 assert.equal(JSON.stringify(rows),before);assert.equal(result.status,'AVAILABLE');assert.equal(result.syntheticTest,true);
 assert.deepEqual(result.breadth,{total:4,rising:2,falling:1,flat:1,risingPercent:50});assert.equal(result.volume.totalQuoteVolume,1300);
 assert.equal(result.topAlts[0].symbol,'SOLUSDT');assert.equal(result.volatility.top[0].rangePercent,20);
 assert.match(result.summary,/BTCUSDT.*\+2\.00%/);assert.match(result.summary,/ETHUSDT.*-1\.00%/);assert.match(result.summary,/상승 2, 하락 1, 보합 1/);
 assert.equal(result.causesInferred,false);assert.equal(result.priceForecastProvided,false);assert.doesNotMatch(result.summary,/때문|전망|상승할|하락할/);
 assert.equal(result.checkedAtKst,'2026-11-04 16:00:00 KST');
});

test('listing universe excludes unsupported, non-USDT, inactive and dated contracts from the summary',()=>{
 const rows=[...fixture(),ticker('FAKEUSDT',8,100000),ticker('BTCUSD',4,100000),ticker('BTCUSDT_261225',3,100000),
  {...ticker('STOPUSDT',8,100000),status:'BREAK'}, {...ticker('SPOTUSDT',9,100000),contractType:'SPOT'}];
 const result=buildMarketCommentary(rows,{...options,eligibleSymbols:[...options.eligibleSymbols,'STOPUSDT','SPOTUSDT']});
 assert.equal(result.breadth.total,4);assert.equal(result.volume.totalQuoteVolume,1300);assert.doesNotMatch(result.summary,/FAKEUSDT|STOPUSDT|SPOTUSDT/);
});

test('stale or future source clocks do not become current commentary and missing values are not filled with zero',()=>{
 const rows=fixture().map(row=>({...row,closeTime:NOW-90001})),stale=buildMarketCommentary(rows,options);
 assert.equal(stale.status,'STALE');assert.equal(stale.breadth.total,0);assert.equal(stale.breadth.risingPercent,null);
 assert.equal(stale.observations.length,4);assert.match(stale.summary,/評価|평가를 보류/);assert.equal(stale.assets[0].price,null);
 const future=buildMarketCommentary(fixture().map(row=>({...row,closeTime:NOW+1})),options);assert.equal(future.status,'STALE');
 const missing=fixture();delete missing[0].quoteVolume;delete missing[1].closeTime;
 const result=buildMarketCommentary(missing,options);assert.equal(result.status,'PARTIAL');assert.equal(result.assets[0].price,null);assert.equal(result.assets[1].price,null);
 assert.ok(result.rejections.some(row=>row.symbol==='BTCUSDT'));assert.equal(result.observations.find(row=>row.symbol==='ETHUSDT').freshnessStatus,'UNVERIFIED');
});

test('duplicate symbols cannot be counted twice and unknown contract/source coverage is clearly partial',()=>{
 const duplicated=buildMarketCommentary([...fixture(),ticker('SOLUSDT',9,999)],options);
 assert.equal(duplicated.breadth.total,3);assert.equal(duplicated.status,'PARTIAL');assert.ok(duplicated.rejections.some(row=>row.reason==='DUPLICATE_SYMBOL'));
 const unverified=buildMarketCommentary(fixture(),{now:NOW,receivedAt:NOW-100});assert.equal(unverified.status,'PARTIAL');
 assert.equal(unverified.universeVerified,false);assert.equal(unverified.dataSource,'UNCONFIRMED_INPUT');assert.equal(unverified.sourceOriginIndependentlyAuthenticated,false);
});

test('unavailable and delayed local receipt states have no fabricated current price or bullish/bearish narrative',()=>{
 const empty=buildMarketCommentary([],options);assert.equal(empty.status,'UNAVAILABLE');assert.equal(empty.assets[0].price,null);
 const delayed=buildMarketCommentary(fixture(),{...options,receivedAt:NOW-90001});assert.equal(delayed.status,'STALE');assert.equal(delayed.breadth.total,0);
 const malformed=fixture();malformed[0].highPrice='70';assert.equal(buildMarketCommentary(malformed,options).assets[0].price,null);
 assert.throws(()=>buildMarketCommentary(fixture(),{...options,maxAgeMs:90001}),/INVALID_MARKET_COMMENTARY_OPTIONS/);
});
