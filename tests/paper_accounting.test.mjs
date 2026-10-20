import test from 'node:test';
import assert from 'node:assert/strict';
import {PaperEngine,paperSummary} from '../paper.mjs';

const initial=Date.parse('2026-10-19T14:59:00Z'); // Monday 23:59 KST
const sample=(t,{direction='LONG',symbol='BTCUSDT',targets}={})=>({symbol,direction,pattern:'검증 패턴',entry:100,stop:direction==='LONG'?98:102,patternConfirmedAt:t-1000,...(targets?{targets}:{})});
const near=(actual,expected)=>assert.ok(Math.abs(actual-expected)<1e-7,`${actual} != ${expected}`);
function create({at=initial,seed={},settings={},onChange=()=>{},onEvent=()=>{}}={}){
 let t=at;const engine=new PaperEngine(seed,{now:()=>t,settings,onChange,onEvent});
 return {engine,now:()=>t,set:value=>t=value,quote:(price,symbol='BTCUSDT')=>{t+=1000;return engine.onPrice('CRYPTO',symbol,price,t)}};
}

test('invalid targets are logged without poisoning the same corrected signal key',()=>{
 const t=create();const s=sample(t.now(),{targets:[99,98,97]});
 assert.equal(t.engine.register(s,{quoteEligible:true}),false);
 assert.equal(t.engine.store.pending.length,0);
 assert.equal(t.engine.store.skipped.length,1);
 assert.match(t.engine.store.skipped[0].reason,/목표가/);
 assert.equal(Object.keys(t.engine.store.seen).length,0);
 assert.equal(t.engine.register({...s,targets:[104,106,108]},{quoteEligible:true}),true);
 assert.equal(t.engine.store.pending.length,1);
});

test('partial realizations and entry fees belong to their actual KST day',()=>{
 const t=create();t.engine.register(sample(t.now()),{quoteEligible:true});t.quote(100);t.quote(104);
 const before=t.engine.snapshot();
 near(before.dailyPnLUSD,before.netRealizedUSD);
 assert.ok(before.dailyPnLUSD>0);
 const priorDayProfit=before.netRealizedUSD;
 t.set(Date.parse('2026-10-19T15:01:00Z'));t.quote(95);
 const after=t.engine.snapshot(),closed=t.engine.store.closed[0],exit=closed.closeParts.at(-1);
 near(after.dailyPnLUSD,exit.profitUSD-exit.feeUSD);
 near(after.netRealizedUSD,priorDayProfit+after.dailyPnLUSD);
 near(after.weeklyPnLUSD,after.netRealizedUSD);
 assert.equal(after.periodPnLApproximate,false);
});

test('partial realizations and entry fees also respect the Monday KST week boundary',()=>{
 const t=create({at:Date.parse('2026-10-18T14:59:00Z')}); // Sunday 23:59 KST
 t.engine.register(sample(t.now()),{quoteEligible:true});t.quote(100);t.quote(104);
 near(t.engine.snapshot().weeklyPnLUSD,t.engine.snapshot().netRealizedUSD);
 t.set(Date.parse('2026-10-18T15:01:00Z'));t.quote(95);
 const x=t.engine.store.closed[0],last=x.closeParts.at(-1),summary=t.engine.snapshot();
 near(summary.weeklyPnLUSD,last.profitUSD-last.feeUSD);
 near(summary.dailyPnLUSD,summary.weeklyPnLUSD);
});

test('daily loss limit includes actual remaining-position loss after earlier-day partial profit',()=>{
 const t=create({settings:{maxDailyLoss:7}});t.engine.register(sample(t.now()),{quoteEligible:true});t.quote(100);t.quote(104);
 t.set(Date.parse('2026-10-19T15:01:00Z'));t.quote(95);
 const summary=t.engine.snapshot();assert.ok(summary.dailyPnLUSD<-7);assert.ok(summary.netRealizedUSD>-7);
 assert.equal(t.engine.register(sample(t.now(),{symbol:'ETHUSDT'}),{symbol:'ETHUSDT',quoteEligible:true}),false);
 assert.match(t.engine.store.skipped.at(-1).reason,/일간\/주간/);
});

test('legacy summary-only closed records keep lifetime PNL and are marked approximate for date allocation',()=>{
 const legacy={closed:[{key:'legacy',closedAt:initial,realizedPnLUSD:12.5,feesUSD:.3}],open:[],pending:[],skipped:[],seen:{}};
 const original=structuredClone(legacy);const t=create({seed:legacy});
 near(t.engine.snapshot().netRealizedUSD,12.5);near(t.engine.snapshot().dailyPnLUSD,12.5);
 assert.equal(t.engine.snapshot().periodPnLApproximate,true);
 assert.deepEqual(legacy,original);
});

test('storage failures roll back pending acceptance, OPEN, partial target and final CLOSE before notifications',()=>{
 let fail=false;let persisted={};const events=[];
 const t=create({onChange:store=>{if(fail)throw Error('disk full');persisted=structuredClone(store)},onEvent:e=>events.push(e)});
 const s=sample(t.now());fail=true;
 assert.throws(()=>t.engine.register(s,{quoteEligible:true}),/disk full/);
 assert.equal(t.engine.store.pending.length,0);assert.equal(Object.keys(t.engine.store.seen).length,0);
 fail=false;t.engine.register(s,{quoteEligible:true});
 fail=true;assert.throws(()=>t.quote(100),/disk full/);
 assert.equal(t.engine.store.open.length,0);assert.equal(t.engine.store.pending.length,1);assert.equal(events.length,0);
 fail=false;t.quote(100);assert.deepEqual(events.map(e=>e.type),['OPEN']);
 const before=structuredClone(t.engine.store);fail=true;
 assert.throws(()=>t.quote(104),/disk full/);assert.deepEqual(t.engine.store,before);
 fail=false;t.quote(104);assert.equal(t.engine.store.open[0].exitedPct,40);
 const partial=structuredClone(t.engine.store);fail=true;
 assert.throws(()=>t.quote(95),/disk full/);assert.deepEqual(t.engine.store,partial);
 assert.equal(events.length,1);assert.equal(persisted.closed.length,0);
 fail=false;t.quote(95);assert.equal(t.engine.store.open.length,0);assert.equal(t.engine.store.closed.length,1);
 assert.deepEqual(events.map(e=>e.type),['OPEN','CLOSE']);
 assert.equal(persisted.closed.length,1);assert.equal(events[1].realizedPnLUSD,persisted.closed[0].realizedPnLUSD);
});

test('restarting an open LONG after TP1 preserves size, stop, fees and finishes targets without duplicate OPEN',()=>{
 const events=[];const t=create({onEvent:event=>events.push(event)});
 t.engine.register(sample(t.now()),{quoteEligible:true});t.quote(100);t.quote(104);
 const store=JSON.parse(JSON.stringify(t.engine.store)),before=store.open[0],restartedEvents=[];
 const next=create({at:t.now(),seed:store,onEvent:event=>restartedEvents.push(event)});
 assert.equal(next.engine.store.open[0].stop,before.entryFill);
 near(next.engine.store.open[0].qtyRemaining,before.qtyRemaining);
 near(next.engine.store.open[0].feesUSD,before.feesUSD);
 assert.equal(next.engine.register(sample(initial),{quoteEligible:true}),false);
 next.quote(106);next.quote(108);
 const closed=next.engine.store.closed[0];
 assert.deepEqual(closed.closeParts.map(p=>p.targetNumber),[1,2,3]);
 near(closed.closeParts.reduce((sum,p)=>sum+p.qty,0),closed.originalQty);near(closed.qtyRemaining,0);
 assert.ok(closed.realizedPnLUSD>0);near(closed.realizedPnLUSD,closed.realizedGrossUSD-closed.feesUSD);
 assert.deepEqual(events.map(e=>e.type),['OPEN']);assert.deepEqual(restartedEvents.map(e=>e.type),['CLOSE']);
 assert.equal(store.open[0].exitedPct,40,'the caller\'s saved seed must not be mutated');
});

test('restarting an open SHORT retains it until a stop and records negative PNL with one CLOSE',()=>{
 const t=create();t.engine.register(sample(t.now(),{direction:'SHORT',symbol:'ETHUSDT'}),{quoteEligible:true,symbol:'ETHUSDT'});t.quote(100,'ETHUSDT');
 const events=[],next=create({at:t.now(),seed:JSON.parse(JSON.stringify(t.engine.store)),onEvent:event=>events.push(event)});
 next.quote(103,'ETHUSDT');next.quote(104,'ETHUSDT');
 assert.equal(next.engine.store.open.length,0);assert.equal(next.engine.store.closed.length,1);
 const x=next.engine.store.closed[0];assert.equal(x.closeReason,'STOP');assert.ok(x.realizedPnLUSD<0);
 near(x.realizedPnLUSD,x.realizedGrossUSD-x.feesUSD);assert.deepEqual(events.map(e=>e.type),['CLOSE']);
});

test('failed pending expiry save preserves the pending signal for retry',()=>{
 let fail=false;const t=create({onChange:()=>{if(fail)throw Error('disk full')}});
 t.engine.register(sample(t.now()),{quoteEligible:true});const before=structuredClone(t.engine.store);
 t.set(t.now()+21*60000);fail=true;assert.throws(()=>t.engine.expirePending(),/disk full/);assert.deepEqual(t.engine.store,before);
 fail=false;assert.equal(t.engine.expirePending(),1);assert.equal(t.engine.store.pending.length,0);
});

test('loss of entry approval keeps pending signals waiting but still stops an existing position',()=>{
 const t=create();t.engine.register(sample(t.now()),{quoteEligible:true});t.quote(100);
 t.engine.register(sample(t.now(),{symbol:'ETHUSDT'}),{quoteEligible:true,symbol:'ETHUSDT'});
 t.set(t.now()+1000);t.engine.onPrice('CRYPTO','ETHUSDT',100,t.now(),{entryAllowed:false});
 assert.equal(t.engine.store.pending.length,1);assert.equal(t.engine.store.open.length,1);
 t.set(t.now()+1000);t.engine.onPrice('CRYPTO','BTCUSDT',95,t.now(),{entryAllowed:false});
 assert.equal(t.engine.store.open.length,0);assert.equal(t.engine.store.closed[0].closeReason,'STOP');
 assert.equal(t.engine.store.pending.length,1);
 t.set(t.now()+1000);t.engine.onPrice('CRYPTO','ETHUSDT',100,t.now(),{entryAllowed:true});
 assert.equal(t.engine.store.pending.length,0);assert.equal(t.engine.store.open[0].symbol,'ETHUSDT');
});

test('malformed existing paper collections fail closed without clearing the caller\'s records',()=>{
 for(const key of ['pending','open','closed','skipped']){
  for(const invalid of [null,{},'recoverable data',42,false,undefined]){
   const seed={closed:[{key:'keep-history',realizedPnLUSD:12.5}],seen:{keep:123},[key]:invalid};
   const before=structuredClone(seed);let writes=0;
   assert.throws(()=>new PaperEngine(seed,{onChange:()=>writes++}),new RegExp(`${key}.*배열`));
   assert.deepEqual(seed,before);assert.equal(writes,0);
  }
 }
 for(const invalid of [null,[],'recoverable keys',42,false,undefined]){
  const seed={closed:[{key:'keep-history',realizedPnLUSD:12.5}],seen:invalid};
  const before=structuredClone(seed);
  assert.throws(()=>new PaperEngine(seed),/seen.*객체/);assert.deepEqual(seed,before);
 }
 for(const invalid of [null,[],42,false,'recoverable paper'])assert.throws(()=>new PaperEngine(invalid),/paper.*객체/);
});

test('missing collections in a valid legacy object receive defaults without losing history',()=>{
 const seed={closed:[{key:'keep-history',closedAt:initial,realizedPnLUSD:12.5,feesUSD:.3}]};
 const before=structuredClone(seed),engine=new PaperEngine(seed,{now:()=>initial});
 assert.equal(engine.store.closed.length,1);near(engine.snapshot().netRealizedUSD,12.5);
 for(const key of ['pending','open','skipped'])assert.deepEqual(engine.store[key],[]);
 assert.deepEqual(engine.store.seen,{});assert.deepEqual(seed,before);
});
