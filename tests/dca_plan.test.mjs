import test from 'node:test';
import assert from 'node:assert/strict';
import {planZoneDca,crossLiquidationPrice,DCA_UNITS} from '../dca_plan.mjs';
import {PaperEngine} from '../paper.mjs';

const zone=(lo,hi,v=100)=>({priceLow:lo,priceHigh:hi,peakVolume:v});
const zonesBelow=[zone(97.5,97.8),zone(96,96.3),zone(94,94.4),zone(91,91.5),zone(88,88.4),zone(85,85.5),zone(82,82.3),zone(79,79.4),zone(76,76.5),zone(72,72.5),zone(101,101.5)];
const base={direction:'LONG',entry:100,atr:.4,zones:zonesBelow,balanceUSD:1000,leverage:10,unitPct:.19,tickSize:.01,quantityStep:.001,minQuantity:.001,minNotional:1};

test('units double after the first add and the plan uses volume zones against the position, nearest first',()=>{
 assert.deepEqual(DCA_UNITS,[1,1,2,4,8,16,32,64,128,256]);
 const p=planZoneDca(base);assert.equal(p.ok,true,JSON.stringify(p));
 assert.equal(p.unitQty,.18,'0.19% of $1000 = $1.9 margin x10 = $19 -> 0.19 -> 0.18 on the 0.02 grid');
 assert.deepEqual(p.adds.map(a=>a.price).slice(0,3),[97.8,96.3,94.4],'zone tops, nearest first, the zone above entry ignored');
 assert.deepEqual(p.adds.map(a=>a.units),DCA_UNITS.slice(1,1+p.adds.length));
 const last=p.adds.at(-1);assert.ok(p.stop<last.zone.priceLow,'stop beyond the last zone used');
 assert.ok(p.full.marginUSD<=1000);assert.ok(p.full.maxLossPct<=30,'loss at the stop within the 30% cap');
 assert.ok(p.full.liquidationPrice===null||p.stop>p.full.liquidationPrice,'stop is reached before liquidation');
});

test('the farthest adds are dropped until margin and liquidation fit; higher leverage keeps fewer adds',()=>{
 const at10=planZoneDca(base),at20=planZoneDca({...base,leverage:20});
 assert.ok(at20.adds.length<=at10.adds.length);assert.ok(at20.addsDropped>=at10.addsDropped);
 const big=planZoneDca({...base,unitPct:2});assert.equal(big.ok,true);assert.ok(big.adds.length<at10.adds.length,'a bigger first unit leaves room for fewer adds');
 assert.ok(big.full.marginUSD<=1000);
 const loose=planZoneDca({...base,leverage:20,settings:{maxLossPct:90}});assert.ok(loose.adds.length>=at20.adds.length,'the loss cap is what trims adds');
});

test('refusals: no zone below, unit below the exchange minimum, bad input',()=>{
 assert.deepEqual(planZoneDca({...base,zones:[zone(101,102)]}).reasons,['DCA_NO_VOLUME_ZONE_AGAINST_ENTRY']);
 assert.deepEqual(planZoneDca({...base,minNotional:100}).reasons,['DCA_UNIT_BELOW_MINIMUM_ORDER']);
 assert.ok(planZoneDca({...base,leverage:0}).reasons.includes('DCA_LEVERAGE_INVALID'));
});

test('SHORT mirrors: adds on zones above, stop above the last one; liquidation formula both ways',()=>{
 const above=[zone(102.2,102.5),zone(104,104.4),zone(107,107.3)];
 const p=planZoneDca({...base,direction:'SHORT',zones:above});assert.equal(p.ok,true,JSON.stringify(p));
 assert.deepEqual(p.adds.map(a=>a.price),[102.2,104,107]);assert.ok(p.stop>107.3);
 // LONG 1 BTC at 100 with $50 balance: liquidation near 50.25 (0.5% maintenance).
 assert.ok(Math.abs(crossLiquidationPrice({direction:'LONG',quantity:1,cost:100,balance:50})-50/(1-.005))<1e-9);
 assert.ok(Math.abs(crossLiquidationPrice({direction:'SHORT',quantity:1,cost:100,balance:50})-150/(1.005))<1e-9);
});

test('paper: adds fill on each zone before TP1, average entry and target sizes follow, stop closes everything',()=>{
 let now=Date.parse('2026-11-11T00:00:00Z');const engine=new PaperEngine({},{now:()=>now});
 const plan=planZoneDca(base),q=plan.unitQty,targets=[103,104,105];
 const targetPlan={ok:true,code:'SCALP_PLAN_READY',targets,quantity:q,quantityUnit:'BASE_ASSET',notionalCurrency:'USDT',minNotional:1,minQuantity:.001,quantityStep:.001,tickSize:.01,
  parts:targets.map((price,i)=>({price,fraction:[.4,.35,.25][i],quantity:Number((q*[.4,.35,.25][i]).toFixed(6))})),
  costAssumptions:{assumption:'SYNTHETIC_TEST',makerRate:.0002,takerRate:.0006,slippageBps:0,spreadBps:0,fundingRate:0},profileEvidence:{dataSource:'SYNTHETIC_TEST'}};
 const row={symbol:'SOLUSDT',direction:'LONG',pattern:'급락 후 반등 롱 (5분)',entry:100,stop:plan.stop,patternConfirmedAt:now-1000,managementVersion:'VOLUME_PROFILE_V1',targetPlan,dca:plan,strategy:'SCALP_REVERSAL_5M'};
 assert.equal(engine.register(row,{quoteEligible:true}),true,JSON.stringify(engine.store.skipped.at(-1)));
 const tick=price=>{now+=1000;engine.onPrice('CRYPTO','SOLUSDT',price,now,{halfSpreadBps:0})};
 tick(100);const p=()=>engine.store.open[0];assert.equal(p().originalQty,q);
 tick(97.7);assert.equal(p().dca.filledAdds,1);assert.ok(Math.abs(p().originalQty-2*q)<1e-12);assert.ok(p().entryFill<100&&p().entryFill>97.8);
 tick(96.2);assert.equal(p().dca.filledAdds,2);assert.ok(Math.abs(p().originalQty-4*q)<1e-12,'1+1+2 units');
 assert.ok(Math.abs(p().targetQuantities[0]-p().originalQty*.4)<1e-12);
 assert.equal(p().managementEvents.filter(e=>e.type==='DCA_ADD').length,2);
 const bad={...row,patternConfirmedAt:now-500,symbol:'XUSDT',dca:{...plan,stop:1}};assert.equal(engine.register(bad,{quoteEligible:true}),false);
 tick(plan.stop-.01);assert.equal(engine.store.closed.at(-1).closeReason,'STOP');assert.ok(engine.store.closed.at(-1).realizedPnLUSD<0);
});

test('after TP1 the stop moves to the average entry (break-even), also after zone adds',()=>{
 let now=Date.parse('2026-11-11T01:00:00Z');const engine=new PaperEngine({},{now:()=>now});
 const plan=planZoneDca(base),q=plan.unitQty,targets=[99,100.5,102];
 const targetPlan={ok:true,code:'SCALP_PLAN_READY',targets,quantity:q,quantityUnit:'BASE_ASSET',notionalCurrency:'USDT',minNotional:1,minQuantity:.001,quantityStep:.001,tickSize:.01,
  parts:targets.map((price,i)=>({price,fraction:[.4,.35,.25][i],quantity:Number((q*[.4,.35,.25][i]).toFixed(6))})),
  costAssumptions:{assumption:'SYNTHETIC_TEST',makerRate:.0002,takerRate:.0006,slippageBps:0,spreadBps:0,fundingRate:0},profileEvidence:{dataSource:'SYNTHETIC_TEST'}};
 const row={symbol:'SOLUSDT',direction:'LONG',pattern:'급락 후 반등 롱 (5분)',entry:98.5,stop:plan.stop,patternConfirmedAt:now-1000,managementVersion:'VOLUME_PROFILE_V1',targetPlan,
  dca:{...plan,adds:plan.adds.filter(a=>a.price<98.5)},strategy:'SCALP_REVERSAL_5M'};
 assert.equal(engine.register(row,{quoteEligible:true}),true,JSON.stringify(engine.store.skipped.at(-1)));
 const tick=price=>{now+=1000;engine.onPrice('CRYPTO','SOLUSDT',price,now,{halfSpreadBps:0})};
 tick(98.5);tick(96.2);const p=()=>engine.store.open[0];assert.equal(p().dca.filledAdds,2,'zone adds at 97.8 and 96.3');
 const average=p().entryFill;assert.ok(average<98.5);
 tick(99);assert.equal(p().exitedPct,40);assert.equal(p().stop,average,'stop moved to the average entry');assert.equal(p().breakevenMoved,true);
 tick(Number((average-.01).toFixed(2)));const closed=engine.store.closed.at(-1);assert.equal(closed.closeReason,'STOP','the rest closes at the break-even stop');
 assert.equal(closed.dca.filledAdds,2,'no more adds after TP1');assert.ok(closed.realizedPnLUSD>0,'TP1 profit kept: the rest exits at break-even');
});
