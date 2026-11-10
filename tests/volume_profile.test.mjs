import test from 'node:test';
import assert from 'node:assert/strict';
import {buildVolumeProfile,quantizeVolumeStep,isVolumeStepAligned,splitVolumeQuantity} from '../volume_profile.mjs';
const END=Date.parse('2026-11-04T00:00:00Z'),START=END-60000,NOW=END+1000;
function input(){
 const prices=[109,110,110.1,119,120,120.1,129,130,130.1,131];
 return {symbol:'SOLUSDT',dataSource:'SYNTHETIC_TEST',windowStart:START,windowEnd:END,receivedAt:END+500,tickSize:.1,bucketTicks:1,
  coverage:{complete:true,fromTime:START,toTime:END,truncated:false,pages:1},
  trades:Array.from({length:40},(_,i)=>{const price=prices[i%prices.length];return {a:i,p:String(price),q:String(price===110?20:price===120?30:price===130?15:1),T:START+Math.floor(i*60000/39)}})};
}
const build=x=>buildVolumeProfile(x,{now:NOW});

test('traded-volume profile conserves actually supplied quantity and records POC, separated HVNs and contiguous value area',()=>{
 const source=input(),result=build(source);assert.equal(result.ok,true);assert.equal(result.evidence.dataSource,'SYNTHETIC_TEST');
 assert.equal(result.profile.totalVolume,source.trades.reduce((sum,row)=>sum+Number(row.q),0));
 assert.equal(result.profile.poc.price,120);assert.deepEqual(result.profile.hvn.map(row=>row.price),[110,120,130]);
 assert.ok(result.profile.valueArea.fraction>=.7);assert.ok(result.profile.valueArea.low<=120&&result.profile.valueArea.high>=120);
 assert.equal(result.evidence.coverage.ratio,1);assert.equal(result.evidence.uniqueTrades,40);
 assert.equal(result.evidence.windowStart,START);assert.equal(result.evidence.windowEnd,END);assert.equal(result.evidence.generatedAt,NOW);
 assert.equal(result.executionApproved,false);assert.equal(result.fixedRRReplacementEnabled,false);
});

test('exact overlapping aggTrade IDs are deduplicated, while changed duplicates, gaps and time regression block the profile',()=>{
 const source=input();source.trades.push({...source.trades[5]});const deduped=build(source);
 assert.equal(deduped.ok,true);assert.equal(deduped.evidence.duplicateTrades,1);assert.equal(deduped.profile.totalVolume,build(input()).profile.totalVolume);
 for(const mutate of [x=>{x.trades.push({...x.trades[5],q:'999'})},x=>{x.trades[20].a=999},x=>{x.trades[20].T=x.trades[19].T-1}]){
  const broken=input();mutate(broken);assert.equal(build(broken).code,'TP_PROFILE_UNAVAILABLE');assert.equal(build(broken).profile,null);
 }
});

test('partial pagination, missing coverage, sparse time span, future trades and stale profiles never receive invented levels',()=>{
 for(const mutate of [x=>{x.coverage.complete=false},x=>{x.coverage.truncated=true},x=>{delete x.coverage},x=>{x.coverage.fromTime=START+1},
  x=>{x.trades=x.trades.slice(0,20)},x=>{x.trades.forEach((row,i)=>row.T=START+i)},x=>{x.trades[20].T=NOW+1},
  x=>{x.receivedAt=NOW+1},x=>{x.windowEnd=NOW+1}]){
  const source=input();mutate(source);const result=build(source);assert.equal(result.ok,false);assert.equal(result.code,'TP_PROFILE_UNAVAILABLE');assert.equal(result.profile,null);
 }
 assert.equal(buildVolumeProfile(input(),{now:NOW+90001}).reasons[0],'PROFILE_STALE');
});

test('candle volume, invalid quantities and synthetic trades relabeled as actual observations cannot create a real profile',()=>{
 for(const mutate of [x=>{x.trades=x.trades.map(row=>({open:109,close:110,volume:1,time:row.T}))},x=>{x.trades[1].q=true},
  x=>{x.trades[1].q=''},x=>{x.trades[1].p='110.11'},x=>{x.dataSource='REAL_BINANCE_AGG_TRADES';x.syntheticTest=true},
  x=>{x.dataSource='REAL_BINANCE_AGG_TRADES';x.trades[1].dataSource='MOCK'}]){
  const source=input();mutate(source);assert.equal(build(source).ok,false);
 }
 const actualShaped=input();actualShaped.dataSource='REAL_BINANCE_AGG_TRADES';const result=build(actualShaped);
 assert.equal(result.evidence.dataSource,'REAL_BINANCE_AGG_TRADES');assert.equal(result.evidence.originIndependentlyVerified,false,'caller source label is not origin authentication');
});

test('flat volume plateau is one HVN zone, not three fabricated target levels',()=>{
 const source=input();source.trades=source.trades.map((row,i)=>({...row,p:String(110+i%3/10),q:'1'}));
 // Equalize all three plateau buckets without changing timestamp coverage.
 source.trades=Array.from({length:42},(_,i)=>({a:i,p:String(110+i%3/10),q:'1',T:START+Math.floor(i*60000/41)}));
 const result=build(source);assert.equal(result.ok,true);assert.equal(result.profile.hvn.length,1);
 assert.equal(result.profile.hvn[0].priceLow,110);assert.equal(result.profile.hvn[0].priceHigh,110.2);
});

test('grid arithmetic avoids binary decimal drift and exact 40/35/25 splits never create quantity dust',()=>{
 assert.equal(quantizeVolumeStep('1.005','.01','DOWN'),1);assert.equal(quantizeVolumeStep('1.005','.01','UP'),1.01);
 assert.deepEqual(splitVolumeQuantity('.1','.0001'),[.04,.035,.025]);assert.throws(()=>splitVolumeQuantity('1','.1'),/EXACT_SPLIT_OFF_GRID/);
 assert.equal(isVolumeStepAligned(.035,.0001),true);assert.equal(isVolumeStepAligned(.035,.01),false);
 const source=input();source.bucketTicks=10;const result=build(source);assert.equal(result.ok,true);
 assert.ok(result.profile.bins.every(row=>isVolumeStepAligned(row.priceLow,.1)&&isVolumeStepAligned(row.priceHigh,.1)));
});

test('profile input and price range bounds prevent unbounded historical trade allocations',()=>{
 const source=input();source.trades[20].p='999999';assert.equal(build(source).ok,false);
 assert.equal(buildVolumeProfile(input(),{now:NOW,minTrades:1}).ok,false);
 assert.equal(buildVolumeProfile(input(),{now:NOW,maxAgeMs:Infinity}).ok,false);
 const missing=input();missing.dataSource='OHLC_APPROXIMATION';assert.equal(build(missing).ok,false);
});
