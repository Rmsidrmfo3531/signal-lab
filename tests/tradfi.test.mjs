import test from 'node:test';
import assert from 'node:assert/strict';
import {tradfiAvailability,tradfiQuoteVerdict,TRADFI_DISABLED_REASON} from '../tradfi.mjs';
import {analyzeTradFi} from '../tradfi_signal.mjs';
import {fetchTwelveSeries,pullSeries} from '../tradfi_feed.mjs';

test('TradFi explicitly reports missing replacement provider instead of a live empty market',()=>{
 const state=tradfiAvailability();
 assert.equal(state.status,'disabled');assert.equal(state.provider,null);assert.equal(state.enabled,false);
 assert.equal(state.reasonCode,'TRADFI_PROVIDER_UNAVAILABLE');
 assert.equal(state.newSignalsEnabled,false);assert.equal(state.paperEntryEnabled,false);
 assert.equal(state.positionTracking,'PAUSED_NO_VALIDATED_QUOTES');
 assert.deepEqual(state.swaps,[]);assert.deepEqual(state.patterns,[]);
});
test('TradFi snapshots are independent and cannot mutate a shared disabled state',()=>{
 const first=tradfiAvailability();first.swaps.push({ticker:'FAKE'});first.enabled=true;
 const second=tradfiAvailability();assert.equal(second.enabled,false);assert.deepEqual(second.swaps,[]);
});
test('A fresh mark and healthy-looking quotes never enable unsupported TradFi',()=>{
 const row={ticker:'XAU-SWAP',markPrice:4000,bid:3999,ask:4001,quoteUpdatedAt:Date.now()};
 assert.deepEqual(tradfiQuoteVerdict(row),{eligible:false,reasons:[TRADFI_DISABLED_REASON],ageSeconds:null});
});
test('Missing, stale and malformed TradFi quotes all stay ineligible',()=>{
 for(const row of [undefined,null,{}, {bid:1,ask:2,markPrice:1.5,quoteUpdatedAt:0}])assert.equal(tradfiQuoteVerdict(row).eligible,false);
});
test('Previously plausible 1H/4H patterns cannot generate disabled TradFi entries',()=>{
 const out=analyzeTradFi({ticker:'XAU-SWAP',feedSymbol:'XAU/USD'},{h1:[{close:100}],h4:[{close:100}]},{now:12345});
 assert.equal(out.ticker,'XAU-SWAP');assert.equal(out.checkedAt,12345);assert.equal(out.status,'disabled');
 assert.equal(out.qualified,false);assert.equal(out.direction,null);assert.equal(out.source,null);
 assert.equal(out.reasonCode,'TRADFI_PROVIDER_UNAVAILABLE');assert.equal(out.targets,undefined);
});
test('Absent TradFi input has an explicit disabled result without an invented symbol',()=>{
 assert.equal(analyzeTradFi().ticker,'');assert.equal(analyzeTradFi().status,'disabled');
});
test('Legacy OHLC configuration never causes a network request or enables TradFi',async()=>{
 let called=0;
 for(const run of [fetchTwelveSeries,pullSeries]){
  await assert.rejects(run({symbol:'XAU/USD',interval:'h1',apiKey:'fixture-only',fetchFn:()=>{called++;throw Error('unexpected network')}}),{code:'TRADFI_PROVIDER_UNAVAILABLE'});
 }
 assert.equal(called,0);
});
test('Disabled TradFi does not infer funding, contract mappings, links or quote timestamps',()=>{
 const state=tradfiAvailability();assert.equal(state.updatedAt,0);assert.equal(state.feedUpdatedAt,0);
 for(const key of ['fundingRate','tradeUrl','marketsUrl','contractSize'])assert.equal(state[key],undefined);
});
