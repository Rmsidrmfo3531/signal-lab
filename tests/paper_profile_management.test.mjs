import test from 'node:test';
import assert from 'node:assert/strict';
import {PaperEngine} from '../paper.mjs';
import {tradePlan,entryTiming} from '../public/trade_plan.js';

const START=Date.parse('2026-11-04T04:00:00Z');
const quantity=2.6;
const near=(a,b)=>assert.ok(Math.abs(a-b)<1e-8,`${a} != ${b}`);
function signal(direction='LONG',extra={}){
 const prices=direction==='LONG'?[105,108,112]:[95,92,88];
 return {symbol:'ETHUSDT',direction,pattern:'SYNTHETIC_PROFILE_BREAKOUT',patternConfirmed:true,entry:100,
  stop:direction==='LONG'?98:102,patternConfirmedAt:START-1000,managementVersion:'VOLUME_PROFILE_V1',
  targetPlan:{ok:true,code:'TP_PROFILE_READY',targets:prices,quantity,minNotional:5,minQuantity:.001,quantityStep:.001,tickSize:.01,quantityUnit:'BASE_ASSET',notionalCurrency:'USDT',
   parts:prices.map((price,i)=>({price,fraction:[.4,.35,.25][i],quantity:quantity*[.4,.35,.25][i]})),
   profileEvidence:{dataSource:'SYNTHETIC_TEST',startAt:START-3600000,endAt:START-1000,coverage:1,historicalOrderBookAvailable:false},
   costAssumptions:{assumption:'SYNTHETIC_TEST',makerRate:.0002,takerRate:.0006,slippageBps:2,spreadBps:2,fundingRate:0},
   estimatedNetRR:2.1},...extra};
}
function fixture({seed={},settings={},onChange=()=>{}}={}){
 let now=START;const events=[],engine=new PaperEngine(seed,{now:()=>now,settings,onChange,onEvent:e=>events.push(e)});
 return {engine,events,quote:(price,options={})=>{now+=1000;return engine.onPrice('CRYPTO','ETHUSDT',price,now,options)},
  now:()=>now,setNow:value=>{now=value}};
}
function open(t,s=signal()){assert.equal(t.engine.register(s,{quoteEligible:true}),true);t.quote(100);assert.equal(t.engine.store.open.length,1);return t.engine.store.open[0]}

test('new crypto simulation requires a complete validated profile plan and never invents fixed R targets',()=>{
 const t=fixture();const noPlan=signal();delete noPlan.targetPlan;
 assert.equal(t.engine.register(noPlan,{quoteEligible:true}),false);assert.equal(t.engine.store.skipped.at(-1).reason,'TP_PROFILE_UNAVAILABLE');
 const unversioned=signal();delete unversioned.managementVersion;
 assert.equal(t.engine.register(unversioned,{quoteEligible:true}),false);assert.equal(t.engine.store.pending.length,0);
 const bad=signal();bad.targetPlan.targets=[105,105,110];assert.equal(t.engine.register(bad,{quoteEligible:true}),false);
 const missingQuantity=signal();delete missingQuantity.targetPlan.quantity;delete missingQuantity.targetPlan.parts[0].quantity;
 assert.equal(t.engine.register(missingQuantity,{quoteEligible:true}),false);
 assert.equal(t.engine.register(signal(),{quoteEligible:true}),true,'failed plans do not permanently consume the corrected signal key');
});

test('profile plan preserves prices and40/35/25 while explicit entry costs and maxloss are rechecked at the actual simulated entry',()=>{
 const t=fixture(),s=signal(),p=open(t,s);
 assert.deepEqual(p.targets,s.targetPlan.targets);near(p.originalQty,quantity);near(p.feeBps,6);
 assert.ok(p.plannedLossUSD<=6);assert.equal(p.moveStopToBreakeven,true);assert.equal(p.breakevenMoved,false);
 const risky=fixture(),over=signal();over.targetPlan.quantity=4;over.targetPlan.parts.forEach((part,i)=>part.quantity=4*[.4,.35,.25][i]);
 assert.equal(risky.engine.register(over,{quoteEligible:true}),true);risky.quote(100);
 assert.equal(risky.engine.store.open.length,0);assert.match(risky.engine.store.skipped.at(-1).reason,/최대 손실/);
 assert.equal(risky.events.length,0);
});

test('profile sizing uses the actual minimum rather than the old250-dollar sample and never rounds up deficient exit orders',()=>{
 const t=fixture(),small=signal();small.targetPlan.quantity=.2;small.targetPlan.parts.forEach((part,i)=>part.quantity=.2*[.4,.35,.25][i]);
 assert.equal(t.engine.register(small,{quoteEligible:true}),true);t.quote(100);
 assert.ok(t.engine.store.open[0].notionalUSD<250);near(t.engine.store.open[0].originalQty,.2);
 const invalid=fixture(),tiny=signal();tiny.targetPlan.quantity=.08;tiny.targetPlan.parts.forEach((part,i)=>part.quantity=.08*[.4,.35,.25][i]);
 assert.equal(invalid.engine.register(tiny,{quoteEligible:true}),false);assert.equal(invalid.engine.store.pending.length,0);
 assert.equal(invalid.engine.store.skipped.at(-1).reason,'TP_QUANTITY_OR_NOTIONAL_INVALID');
});

test('TP1 touch with no simulated liquidity and partial40% completion do not move stop; finalfill moves it once',()=>{
 const t=fixture();const p=open(t),originalStop=p.stop;
 t.quote(105,{exitQuantityLimit:0});assert.equal(p.stop,originalStop);assert.equal(p.closeParts.length,0);
 t.quote(105,{exitQuantityLimit:quantity*.2});const half=t.engine.store.open[0];
 near(half.exitedPct,20);near(half.qtyRemaining,quantity*.8);assert.equal(half.stop,originalStop);assert.equal(half.breakevenMoved,false);
 t.quote(105,{exitQuantityLimit:quantity*.2});const full=t.engine.store.open[0];
 near(full.exitedPct,40);near(full.qtyRemaining,quantity*.6);near(full.stop,full.entryFill);
 assert.equal(full.breakevenMoved,true);assert.equal(full.managementEvents.length,1);
 const before=structuredClone(t.engine.store);assert.equal(t.engine.onPrice('CRYPTO','ETHUSDT',105,t.now(),{exitQuantityLimit:quantity}),0);
 assert.deepEqual(t.engine.store,before,'duplicate observation creates neither duplicate fill nor another stop movement');
});

test('partialTP1 and fullTP1 restart recovery keep cumulative fill quantities, oneBE event and exact residualTP2/TP3',()=>{
 const t=fixture();open(t);t.quote(105,{exitQuantityLimit:quantity*.2});
 const saved=structuredClone(t.engine.store),r=fixture({seed:saved});r.setNow(t.now());
 assert.equal(r.engine.store.open[0].breakevenMoved,false);assert.equal(r.events.length,0);
 r.quote(105,{exitQuantityLimit:quantity*.2});const afterTP1=structuredClone(r.engine.store),next=fixture({seed:afterTP1});next.setNow(r.now());
 next.quote(108);next.quote(112);assert.equal(next.engine.store.open.length,0);
 const closed=next.engine.store.closed[0];near(closed.qtyRemaining,0);
 near(closed.closeParts.filter(x=>x.targetNumber===1).reduce((n,x)=>n+x.qty,0),quantity*.4);
 near(closed.closeParts.filter(x=>x.targetNumber===2).reduce((n,x)=>n+x.qty,0),quantity*.35);
 near(closed.closeParts.filter(x=>x.targetNumber===3).reduce((n,x)=>n+x.qty,0),quantity*.25);
 assert.equal(closed.managementEvents.length,1);near(closed.realizedPnLUSD,closed.realizedGrossUSD-closed.feesUSD);
 assert.equal(closed.closeReason,'ALL_TARGETS');assert.deepEqual(next.events.map(e=>e.type),['CLOSE']);
 assert.deepEqual(saved.open[0].stop,98,'loading saved data never modifies the caller source');
});

test('BE can be disabled per newposition or setting without changing existing position protection',()=>{
 for(const settings of [{}, {TP1_MOVE_STOP_TO_BREAKEVEN:false}]){
  const t=fixture({settings}),s=signal();
  if(settings.TP1_MOVE_STOP_TO_BREAKEVEN!==false)s.moveStopToBreakeven=false;
  open(t,s);t.quote(105);const p=t.engine.store.open[0];assert.equal(p.stop,98);assert.equal(p.breakevenMoved,false);
  assert.deepEqual(p.managementEvents,[]);
 }
 const t=fixture();open(t);t.engine.settings.TP1_MOVE_STOP_TO_BREAKEVEN=false;t.quote(105);
 assert.equal(t.engine.store.open[0].breakevenMoved,true,'newglobalsetting does not retroactively alter saved perposition choice');
});

test('SHORT TP1 then adverse gap through BE records the worse fill, remaining60% loss and one final CLOSE',()=>{
 const t=fixture();open(t,signal('SHORT'));t.quote(95);const p=t.engine.store.open[0];near(p.stop,p.entryFill);
 t.quote(103);const closed=t.engine.store.closed[0],stop=closed.closeParts.at(-1);
 assert.equal(closed.closeReason,'STOP');near(stop.qty,quantity*.6);assert.ok(stop.fill>p.entryFill);
 assert.ok(stop.observedStopGapUSD>0);assert.ok(stop.executionBeyondStopUSD>0);near(closed.qtyRemaining,0);
 near(closed.realizedPnLUSD,closed.realizedGrossUSD-closed.feesUSD);assert.deepEqual(t.events.map(e=>e.type),['OPEN','CLOSE']);
});

test('failed save rolls back cumulativeTP1 fill and BE move before a retry; no phantom notifications',()=>{
 let fail=false;const t=fixture({onChange:()=>{if(fail)throw Error('disk full')}});open(t);t.quote(105,{exitQuantityLimit:quantity*.2});
 const before=structuredClone(t.engine.store);fail=true;assert.throws(()=>t.quote(105,{exitQuantityLimit:quantity*.2}),/disk full/);
 assert.deepEqual(t.engine.store,before);assert.equal(t.events.length,1);fail=false;t.quote(105,{exitQuantityLimit:quantity*.2});
 assert.equal(t.engine.store.open[0].breakevenMoved,true);assert.equal(t.engine.store.open[0].managementEvents.length,1);
});

test('historical open/closed target and stop values are preserved at load and new plan display has no implicit R fallback',()=>{
 const legacy={open:[{key:'old',symbol:'ETHUSDT',market:'CRYPTO',direction:'LONG',entryFill:100,stop:97,targets:[102,107,113],originalQty:2,qtyRemaining:2,
  closeParts:[],realizedPnLUSD:-.1,feesUSD:.1,markPrice:100,lastPriceAt:START}],closed:[{key:'oldclosed',realizedPnLUSD:12,feesUSD:.1,closedAt:START}]};
 const before=structuredClone(legacy);const t=fixture({seed:legacy});assert.deepEqual(t.engine.store.open,legacy.open);assert.deepEqual(legacy,before);
 assert.equal(tradePlan({entry:100,stop:98,direction:'LONG'}),null);
 const plan=tradePlan(signal(),{notional:260});assert.deepEqual(plan.targets.map(x=>x.price),[105,108,112]);
 assert.deepEqual(plan.targets.map(x=>x.reducePct),[40,35,25]);assert.equal(plan.managementVersion,'VOLUME_PROFILE_V1');
 const check=entryTiming({...signal(),targetPlan:undefined,qualified:true,execution:{eligible:true}},{price:100,priceAt:START,now:START,venueReady:true});
 assert.equal(check.code,'zone','timing assessment stays separate from required target profile approval');
});

test('explicit cost-covered mode compensates remaining entry and exit model costs in both directions only after TP1 completes',()=>{
 for(const direction of ['LONG','SHORT']){
  const t=fixture({settings:{TP1_BREAKEVEN_MODE:'COST_COVERED'}}),s=signal(direction),p=open(t,s),initial=p.stop;
  assert.equal(t.engine.snapshot().settings.TP1_BREAKEVEN_MODE,'COST_COVERED');assert.equal(p.breakevenMode,'COST_COVERED');
  t.engine.settings.TP1_BREAKEVEN_MODE='ENTRY_FILL';
  const target=direction==='LONG'?105:95;
  t.quote(target,{exitQuantityLimit:quantity*.2});assert.equal(t.engine.store.open[0].stop,initial);
  const restored=fixture({seed:structuredClone(t.engine.store)});restored.setNow(t.now());restored.quote(target,{exitQuantityLimit:quantity*.2});
  const managed=restored.engine.store.open[0],sign=direction==='LONG'?1:-1;
  assert.equal(managed.breakevenMode,'COST_COVERED');assert.ok(sign*(managed.stop-managed.entryFill)>0);
  near(managed.stop/.01,Math.round(managed.stop/.01));assert.equal(managed.managementEvents.length,1);
  const model=managed.managementEvents[0].costModel;
  assert.equal(model.tp1ProceedsUsed,false);assert.equal(model.accountRateVerified,false);assert.equal(model.fundingCovered,false);
  const trigger=managed.stop,allocatedEntryFees=managed.qtyRemaining*managed.entryFill*managed.feeBps/10000;
  restored.quote(trigger);const closed=restored.engine.store.closed[0],exit=closed.closeParts.at(-1);
  assert.equal(exit.type,'STOP');assert.ok(exit.profitUSD-exit.feeUSD-allocatedEntryFees>=-1e-8,'remaining model costs are covered without crediting TP1 profit');
  assert.equal(closed.managementEvents.length,1);assert.equal(restored.engine.store.open.length,0);
 }
});

test('unknown or impossible cost-cover models cannot be enabled and cost BE never weakens prior protection or promises a gap fill',()=>{
 for(const s of [signal('LONG',{breakevenMode:'UNVERIFIED'}),signal('LONG',{breakevenMode:'COST_COVERED'})]){
  if(s.breakevenMode==='COST_COVERED')s.targetPlan.costAssumptions.slippageBps=10000;
  const t=fixture();assert.equal(t.engine.register(s,{quoteEligible:true}),false);assert.equal(t.engine.store.pending.length,0);
  assert.equal(t.engine.store.skipped.at(-1).reason,'BREAKEVEN_COST_MODEL_UNVERIFIED');
 }
 const invalid=fixture({settings:{TP1_BREAKEVEN_MODE:'UNVERIFIED'}});
 assert.equal(invalid.engine.register(signal(),{quoteEligible:true}),false);
 const better=fixture(),s=signal('LONG',{breakevenMode:'COST_COVERED'});open(better,s);better.engine.store.open[0].stop=103;
 better.quote(105);assert.equal(better.engine.store.open[0].stop,103);assert.equal(better.engine.store.open[0].breakevenMoved,false);
 const gap=fixture();open(gap,signal('SHORT',{breakevenMode:'COST_COVERED'}));gap.quote(95);gap.quote(103);
 const close=gap.engine.store.closed[0],stop=close.closeParts.at(-1);
 assert.ok(stop.fill>stop.stopReference);assert.ok(stop.observedStopGapUSD>0);assert.ok(stop.executionBeyondStopUSD>0);
});
