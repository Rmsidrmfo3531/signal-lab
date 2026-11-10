import test from 'node:test';
import assert from 'node:assert/strict';
import {PaperEngine} from '../paper.mjs';

const START=Date.parse('2026-11-04T04:00:00Z'),quantity=2.6;
function signal(direction='LONG'){
 const prices=direction==='LONG'?[105,108,112]:[95,92,88];
 return {symbol:'ETHUSDT',direction,pattern:'SYNTHETIC_PROFILE_BREAKOUT',patternConfirmed:true,entry:100,stop:direction==='LONG'?98:102,patternConfirmedAt:START-1000,managementVersion:'VOLUME_PROFILE_V1',
  targetPlan:{ok:true,code:'TP_PROFILE_READY',targets:prices,quantity,minNotional:5,minQuantity:.001,quantityStep:.001,tickSize:.01,quantityUnit:'BASE_ASSET',notionalCurrency:'USDT',
   parts:prices.map((price,i)=>({price,fraction:[.4,.35,.25][i],quantity:quantity*[.4,.35,.25][i]})),
   profileEvidence:{dataSource:'SYNTHETIC_TEST'},costAssumptions:{assumption:'SYNTHETIC_TEST',makerRate:.0002,takerRate:.0006,slippageBps:2,spreadBps:2,fundingRate:0},estimatedNetRR:2.1}};
}
function fixture(){let now=START;const saves=[];const engine=new PaperEngine({},{now:()=>now,onChange:s=>saves.push(s)});
 return {engine,saves,quote:price=>{now+=1000;return engine.onPrice('CRYPTO','ETHUSDT',price,now)}}}

test('pending entry: stop and targets can be changed and are rounded to the tick',()=>{
 const t=fixture();assert.equal(t.engine.register(signal(),{quoteEligible:true}),true);const key=t.engine.store.pending[0].key;
 const r=t.engine.setLevels(key,{stop:97.504,targets:[106.006,null,115]});assert.equal(r.ok,true,r.reasons?.join());
 assert.equal(r.levels.state,'PENDING');assert.equal(t.engine.store.pending[0].stop,97.5);assert.deepEqual(t.engine.store.pending[0].targets,[106.01,108,115]);
 assert.equal(t.engine.store.pending[0].managementEvents.at(-1).type,'MANUAL_LEVELS');
});

test('open LONG: wrong-side or crossed levels are refused, valid change moves the next exits, filled TP is locked',()=>{
 const t=fixture();t.engine.register(signal(),{quoteEligible:true});t.quote(100);const key=t.engine.store.open[0].key;
 const reasons=levels=>t.engine.setLevels(key,levels).reasons;
 assert.deepEqual(reasons({stop:100.5}),['STOP_ALREADY_CROSSED']);
 assert.ok(reasons({targets:[99,108,112]}).includes('TP1_NOT_BEYOND_PRICE'));
 assert.ok(reasons({targets:[110,108,112]}).includes('TP2_ORDER'));
 assert.ok(reasons({targets:[1,2]}).includes('TARGETS_NEED_THREE'));
 const before=structuredClone(t.engine.store.open[0]);
 assert.equal(t.engine.setLevels(key,{stop:99},{dryRun:true}).ok,true);assert.equal(t.engine.store.open[0].stop,before.stop,'dry run changes nothing');
 assert.equal(t.engine.setLevels(key,{stop:99,targets:[104,108,112]}).ok,true);
 const p=t.engine.store.open[0];assert.equal(p.stop,99);assert.deepEqual(p.targets,[104,108,112]);assert.equal(p.manualLevels,true);
 t.quote(104);assert.equal(t.engine.store.open[0].exitedPct,40,'TP1 exits at the new price');
 assert.deepEqual(reasons({targets:[103,108,112]}),['TP1_ALREADY_FILLED']);
 assert.equal(t.engine.setLevels(key,{targets:[104,109,112]}).ok,true,'unchanged filled TP is accepted');
 assert.equal(t.engine.setLevels(key,{stop:101}).ok,true,'stop can be tightened above entry');
 t.quote(100.9);assert.equal(t.engine.store.closed.at(-1).closeReason,'STOP');
});

test('a manual stop better than break-even is never loosened by the automatic TP1 move',()=>{
 const t=fixture();t.engine.register(signal(),{quoteEligible:true});t.quote(100);const key=t.engine.store.open[0].key;
 t.quote(103);assert.equal(t.engine.setLevels(key,{stop:102}).ok,true);t.quote(105);
 assert.equal(t.engine.store.open[0].stop,102);
});

test('SHORT mirrors the rules and unknown keys are reported',()=>{
 const t=fixture();t.engine.register(signal('SHORT'),{quoteEligible:true});t.quote(100);const key=t.engine.store.open[0].key;
 assert.deepEqual(t.engine.setLevels(key,{stop:99.5}).reasons,['STOP_ALREADY_CROSSED']);
 assert.ok(t.engine.setLevels(key,{targets:[96,97,88]}).reasons.includes('TP2_ORDER'));
 assert.equal(t.engine.setLevels(key,{stop:103,targets:[96,92,88]}).ok,true);assert.equal(t.engine.store.open[0].stop,103);
 assert.deepEqual(t.engine.setLevels('nope',{stop:1}).reasons,['POSITION_NOT_FOUND']);
});
