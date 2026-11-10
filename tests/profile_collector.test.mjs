import test from 'node:test';
import assert from 'node:assert/strict';
import {VolumeProfileCollector} from '../profile_collector.mjs';
import {buildKlineVolumeProfile} from '../volume_profile.mjs';
const NOW=Date.now(),STEP=900000,LAST=Math.floor(NOW/STEP)*STEP;
// 3 days of 15m candles: heavy narrow candles at three levels above and below 100.
const candles=(n=288,levels=[110,120,130,90,80,70])=>Array.from({length:n},(_,i)=>{const l=levels[i%levels.length];
 return [LAST-(n-1-i)*STEP,String(l),String(l+0.05),String(l),String(l+0.05),'50',LAST-(n-1-i)*STEP+STEP-1,'0',1,'0','0','0']});

test('profile collection is on-demand, one 15m-candle request, deduplicated in flight, cached per tick',async()=>{
 const urls=[];const collector=new VolumeProfileCollector({now:()=>NOW,dataSource:'SYNTHETIC_TEST',request:async url=>{urls.push(url);return candles()}});
 assert.equal((await collector.get('SOLUSDT',{tickSize:.01})).ok,false);assert.equal(urls.length,0);
 const [a,b]=await Promise.all([collector.get('SOLUSDT',{tickSize:.01,eligible:true}),collector.get('SOLUSDT',{tickSize:.01,held:true})]);
 assert.equal(a.ok,true,a.reasons?.join());assert.deepEqual(a,b);assert.equal(urls.length,1);assert.equal(a.evidence.dataSource,'SYNTHETIC_TEST');
 assert.equal(urls[0],'/fapi/v1/klines?symbol=SOLUSDT&interval=15m&limit=288');
 await collector.get('SOLUSDT',{tickSize:.01,eligible:true});assert.equal(urls.length,1);
 await collector.get('SOLUSDT',{tickSize:.1,eligible:true});assert.equal(urls.length,2,'changed order grid cannot reuse a profile from a different tick');
});

test('request budget is enforced and invalid settings are refused',async()=>{
 let calls=0;const collector=new VolumeProfileCollector({now:()=>NOW,dataSource:'SYNTHETIC_TEST',maxRequestsPerMinute:1,request:async()=>{calls++;return candles()}});
 assert.equal((await collector.get('SOLUSDT',{tickSize:.01,eligible:true})).ok,true);
 const blocked=await collector.get('ETHUSDT',{tickSize:.01,eligible:true});assert.equal(blocked.ok,false);assert.deepEqual(blocked.reasons,['PROFILE_REQUEST_BUDGET_EXHAUSTED']);assert.equal(calls,1);
 for(const budget of [0,NaN,Infinity,121])assert.throws(()=>new VolumeProfileCollector({request:async()=>[],maxRequestsPerMinute:budget}),/CONFIG/);
 assert.throws(()=>new VolumeProfileCollector({request:async()=>[],candles:10}),/CONFIG/);
 const failing=new VolumeProfileCollector({now:()=>NOW,request:async()=>{throw Error('down')}});
 assert.deepEqual((await failing.get('SOLUSDT',{tickSize:.01,eligible:true})).reasons,['KLINES_FETCH_OR_SCHEMA_FAILED']);
});

test('15m-candle profile: HVNs at the heavy levels, multi-day window, gaps and stale data refused',()=>{
 const build=(klines,now=NOW)=>buildKlineVolumeProfile({symbol:'SOLUSDT',klines,receivedAt:now,tickSize:'0.01',dataSource:'SYNTHETIC_TEST'},{now});
 const ok=build(candles());assert.equal(ok.ok,true,ok.reasons?.join());
 const peaks=ok.profile.hvn.map(z=>Math.round(z.price));
 for(const level of [70,80,90,110,120,130])assert.ok(peaks.some(p=>Math.abs(p-level)<=1),`HVN near ${level}: ${peaks}`);
 assert.ok(ok.evidence.windowEnd-ok.evidence.windowStart>=2.9*86400000,'about three days');
 assert.equal(ok.evidence.coverage.complete,true);assert.equal(ok.evidence.candles,288);
 const gap=candles();gap.splice(100,1);assert.deepEqual(build(gap).reasons,['KLINE_SEQUENCE_GAP_OR_REGRESSION']);
 assert.deepEqual(build(candles(50)).reasons,['PROFILE_CANDLES_INSUFFICIENT_OR_UNBOUNDED']);
 assert.deepEqual(build(candles(),NOW+3600000).reasons,['PROFILE_LAST_CANDLE_STALE'],'an hour without a new candle');
 assert.deepEqual(buildKlineVolumeProfile({symbol:'SOLUSDT',klines:candles(),receivedAt:NOW-100000,tickSize:'0.01',dataSource:'SYNTHETIC_TEST'},{now:NOW}).reasons,['PROFILE_STALE']);
 const bad=candles();bad[5]=[bad[5][0],'10','9','11','10','1'];assert.deepEqual(build(bad).reasons,['KLINE_VALUE_INVALID']);
 // A candle spanning a range spreads its volume over that range.
 const wide=candles(288,[100]).map(k=>[k[0],'95','105','95','105','10']);
 const flat=build(wide);assert.equal(flat.ok,true);const vols=flat.profile.bins.map(b=>b.volume).slice(1,-1);
 assert.ok(Math.max(...vols)/Math.min(...vols.filter(v=>v>0))<1.5,'evenly spread');assert.equal(flat.profile.hvn.length,1,'a flat profile has one peak, not float-noise peaks');
});
