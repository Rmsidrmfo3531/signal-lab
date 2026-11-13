import test from 'node:test';
import assert from 'node:assert/strict';
import {planZoneDca,crossLiquidationPrice,DCA_UNITS,clampMaxAdds,clampZoneDays,DCA_DEEP_PROFILE} from '../dca_plan.mjs';
import {PaperEngine} from '../paper.mjs';
import {roundDecimalToStep} from '../decimal_grid.mjs';
// 40/35 % rounded down to the 0.001 lot, the last part takes the rest (as buildScalpPlan does).
const split=q=>{const a=Number(roundDecimalToStep(q*.4,.001,'DOWN')),b=Number(roundDecimalToStep(q*.35,.001,'DOWN'));return [a,b,Number((q-a-b).toFixed(6))]};

const zone=(lo,hi,v=100)=>({priceLow:lo,priceHigh:hi,peakVolume:v});
const zonesBelow=[zone(97.5,97.8),zone(96,96.3),zone(94,94.4),zone(91,91.5),zone(88,88.4),zone(85,85.5),zone(82,82.3),zone(79,79.4),zone(76,76.5),zone(72,72.5),zone(101,101.5)];
const base={direction:'LONG',entry:100,atr:.4,zones:zonesBelow,balanceUSD:1000,leverage:10,unitPct:.19,tickSize:.01,quantityStep:.001,minQuantity:.001,minNotional:1};

test('units double after the first add and the plan uses volume zones against the position, nearest first',()=>{
 assert.deepEqual(DCA_UNITS,[1,1,2,4,8,16,32,64,128,256,512]);
 const p=planZoneDca(base);assert.equal(p.ok,true,JSON.stringify(p));
 assert.equal(p.unitQty,.19,'0.19% of $1000 = $1.9 margin x10 = $19 -> 0.19 at price 100');
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
  parts:targets.map((price,i)=>({price,fraction:[.4,.35,.25][i],quantity:split(q)[i]})),
  costAssumptions:{assumption:'SYNTHETIC_TEST',makerRate:.0002,takerRate:.0006,slippageBps:0,spreadBps:0,fundingRate:0},profileEvidence:{dataSource:'SYNTHETIC_TEST'}};
 const row={symbol:'SOLUSDT',direction:'LONG',pattern:'급락 후 반등 롱 (5분)',entry:100,stop:plan.stop,patternConfirmedAt:now-1000,managementVersion:'VOLUME_PROFILE_V1',targetPlan,dca:plan,strategy:'SCALP_REVERSAL_5M'};
 assert.equal(engine.register(row,{quoteEligible:true}),true,JSON.stringify(engine.store.skipped.at(-1)));
 const tick=price=>{now+=1000;engine.onPrice('CRYPTO','SOLUSDT',price,now,{halfSpreadBps:0})};
 tick(100);const p=()=>engine.store.open[0];assert.equal(p().originalQty,q);
 tick(97.7);assert.equal(p().dca.filledAdds,1);assert.ok(Math.abs(p().originalQty-2*q)<1e-12);assert.ok(p().entryFill<100&&p().entryFill>97.8);
 tick(96.2);assert.equal(p().dca.filledAdds,2);assert.ok(Math.abs(p().originalQty-4*q)<1e-12,'1+1+2 units');
 const first=p().firstEntryFill;assert.ok(Math.abs(first-100)<.05,'first entry kept for the card');assert.ok(p().entryFill<first,'average below the first entry on a long');
 assert.ok(Math.abs(p().targetQuantities[0]-p().originalQty*.4)<1e-12);
 assert.equal(p().managementEvents.filter(e=>e.type==='DCA_ADD').length,2);
 const bad={...row,patternConfirmedAt:now-500,symbol:'XUSDT',dca:{...plan,stop:1}};assert.equal(engine.register(bad,{quoteEligible:true}),false);
 tick(plan.stop-.01);assert.equal(engine.store.closed.at(-1).closeReason,'STOP');assert.ok(engine.store.closed.at(-1).realizedPnLUSD<0);
});

test('after TP1 the stop moves to the average entry (break-even), also after zone adds',()=>{
 let now=Date.parse('2026-11-11T01:00:00Z');const engine=new PaperEngine({},{now:()=>now});
 const plan=planZoneDca(base),q=plan.unitQty,targets=[99,100.5,102];
 const targetPlan={ok:true,code:'SCALP_PLAN_READY',targets,quantity:q,quantityUnit:'BASE_ASSET',notionalCurrency:'USDT',minNotional:1,minQuantity:.001,quantityStep:.001,tickSize:.01,
  parts:targets.map((price,i)=>({price,fraction:[.4,.35,.25][i],quantity:split(q)[i]})),
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

test('unit size follows the lot step; a unit whose 25 % part is below the exchange minimum is refused',()=>{
 assert.equal(planZoneDca({...base,quantityStep:.01,minQuantity:.01}).unitQty,.19,'no 20-lot rounding: 0.19 stays 0.19');
 assert.deepEqual(planZoneDca({...base,quantityStep:1,minQuantity:1}).reasons,['DCA_UNIT_BELOW_MINIMUM_ORDER'],'a 1-coin lot cannot hold a $19 unit');
 assert.deepEqual(planZoneDca({...base,quantityStep:.1,minQuantity:.1}).reasons,['DCA_UNIT_BELOW_MINIMUM_ORDER'],'0.1 lot: the 25 % part would be 0');
});

test('max adds is 0-10 (default 10) and caps the plan; the deep zone window is 3-15 days',()=>{
 assert.equal(clampMaxAdds(undefined),10);assert.equal(clampMaxAdds('3'),3);assert.equal(clampMaxAdds('0'),0);assert.equal(clampMaxAdds('-2'),0);assert.equal(clampMaxAdds('12'),10);assert.equal(clampMaxAdds('7'),7);
 assert.equal(clampZoneDays(undefined),14);assert.equal(clampZoneDays('1'),3);assert.equal(clampZoneDays('30'),15);
 assert.equal(DCA_DEEP_PROFILE(14).candles,1344);
 const loose={...base,leverage:10,unitPct:.01,settings:{maxLossPct:95}};
 const all=planZoneDca(loose);assert.equal(all.ok,true,JSON.stringify(all));assert.equal(all.adds.length,10,'ten zones below, all used');
 // 0 adds: entry only, the stop beyond the first zone.
 {const p=planZoneDca({...loose,settings:{...loose.settings,maxAdds:0}});assert.equal(p.ok,true,JSON.stringify(p));assert.equal(p.adds.length,0);assert.equal(p.addsDropped,0);assert.ok(p.stop<base.zones?.[0]?.priceLow||p.stop<p.entry)}
 for(const n of [3,5,7]){const p=planZoneDca({...loose,settings:{...loose.settings,maxAdds:n}});assert.equal(p.adds.length,n);assert.equal(p.maxAdds,n);
  assert.ok(p.stop<p.adds.at(-1).zone.priceLow,'stop moves to beyond the last zone kept')}
});

import {dcaZoneDaysFor} from '../dca_plan.mjs';
test('1m scalps use only the 3-day zones; 5m and 15m keep the configured window',()=>{
 assert.equal(dcaZoneDaysFor('1m',14),3);assert.equal(dcaZoneDaysFor('5m',14),14);assert.equal(dcaZoneDaysFor('15m',10),10);
});

import {planProfile,addPrices} from '../dca_plan.mjs';
test('profiles: HYBRID works the first quantity back from the account risk; CURRENT is planZoneDca; replica is marked assumed',()=>{
 const zones=[97,94,91,88,85].map(p=>({priceLow:p-.3,priceHigh:p+.3}));
 const b={direction:'LONG',entry:100,atr:1,zones,signalStop:97,balanceUSD:400,leverage:18,tickSize:.01,quantityStep:.001,takerRate:.0006};
 const h=planProfile({...b,profile:'HYBRID',riskPct:1,maxAdds:4});
 assert.equal(h.ok,true);assert.equal(h.adds.length,4);
 assert.deepEqual(h.adds.map(a=>+(a.quantity/h.unitQty).toFixed(1)),[1,2,4,8],'1·1·2·4·8');
 assert.ok(h.fullLossUSD<=4+1e-9&&h.fullLossUSD>3.8,'full loss ≈ 1 % of 400: '+h.fullLossUSD);
 assert.ok(h.stop<h.adds.at(-1).price);
 const z=planProfile({...b,profile:'HYBRID',maxAdds:0});assert.equal(z.adds.length,0);assert.equal(z.stop,97);assert.ok(z.fullLossUSD<=4+1e-9);
 const pct=addPrices({direction:'SHORT',entry:100,atr:1,spacing:'PCT',spacingPct:2,count:2});assert.deepEqual(pct.map(p=>p.price),[102,104]);
 const atr=addPrices({direction:'LONG',entry:100,atr:2,spacing:'ATR',spacingAtr:1.5,count:2});assert.deepEqual(atr.map(p=>p.price),[97,94]);
 const c=planProfile({...b,profile:'CURRENT',maxAdds:7});assert.equal(c.ok,true);
 const r=planProfile({...b,profile:'TRADER_REPLICA',maxAdds:7});assert.equal(r.assumed,true);assert.equal(r.adds.length,7);assert.deepEqual(r.targetsFromAveragePct,[.56]);
 assert.equal(planProfile({...b,profile:'HYBRID',schedule:'NOPE'}).ok,false);
});
