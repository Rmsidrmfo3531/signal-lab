import test from 'node:test';
import assert from 'node:assert/strict';
import {VolumeProfileCollector} from '../profile_collector.mjs';
const NOW=Date.now();
const rows=()=>Array.from({length:60},(_,i)=>({a:i,p:String([110,120,130][i%3]),q:'10',T:NOW-300000+Math.floor(i*300000/59)}));
test('trade collection is on-demand, deduplicated in flight, cached and explicitly synthetic in tests',async()=>{
 let calls=0;const collector=new VolumeProfileCollector({now:()=>NOW,dataSource:'SYNTHETIC_TEST',request:async()=>{calls++;return rows()}});
 assert.equal((await collector.get('SOLUSDT',{tickSize:.01})).ok,false);assert.equal(calls,0);
 const [a,b]=await Promise.all([collector.get('SOLUSDT',{tickSize:.01,eligible:true}),collector.get('SOLUSDT',{tickSize:.01,held:true})]);
 assert.equal(a.ok,true,a.reasons?.join());assert.deepEqual(a,b);assert.equal(calls,1);assert.equal(a.evidence.dataSource,'SYNTHETIC_TEST');
 await collector.get('SOLUSDT',{tickSize:.01,eligible:true});assert.equal(calls,1);
 await collector.get('SOLUSDT',{tickSize:.1,eligible:true});assert.equal(calls,2,'changed order grid cannot reuse a profile from a different tick');
});
test('page and global request budgets cannot turn a partial window into a complete profile or unlimited lookup',async()=>{
 let calls=0;const collector=new VolumeProfileCollector({now:()=>NOW,dataSource:'SYNTHETIC_TEST',maxPages:2,maxRequestsPerMinute:2,
  request:async()=>{const page=calls++;return Array.from({length:1000},(_,i)=>({a:page*1000+i,p:'110',q:'1',T:NOW-300000+page*1000+i}))}});
 const partial=await collector.get('SOLUSDT',{tickSize:.01,eligible:true});assert.equal(partial.ok,false);assert.equal(calls,2);
 assert.equal((await collector.get('ETHUSDT',{tickSize:.01,eligible:true})).ok,false);assert.equal(calls,2);
 for(const budget of [0,NaN,Infinity,121])assert.throws(()=>new VolumeProfileCollector({request:async()=>[],maxRequestsPerMinute:budget}),/CONFIG/);
});
