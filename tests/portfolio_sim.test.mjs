import test from 'node:test';
import assert from 'node:assert/strict';
import {openPosition,stepPosition,runPortfolio,portfolioMetrics,positionNet,FUNDING_MS} from '../portfolio_sim.mjs';

const T0=Date.UTC(2026,7,1,1,0),M5=300000;
const NOCOST={takerRate:0,slippageBps:0,fundingRate:0,maintenanceRate:.005};
const bar=(i,o,h,l,c)=>({t:T0+i*M5,o,h,l,c});
const pos=(o={})=>openPosition({id:1,symbol:'X',direction:'LONG',entryRef:100,stop:90,targets:[105,110,115],quantity:1,openAt:T0,costs:NOCOST,...o});

test('adds fill when touched, nearest first, and the average and targets follow the larger position',()=>{
 const p=pos({adds:[{price:97,quantity:1},{price:94,quantity:2}]});
 stepPosition(p,bar(0,100,100.5,96.5,97));
 assert.equal(p.addsFilled,1);assert.equal(p.qty,2);assert.equal(p.avg,98.5);
 assert.deepEqual(p.tpQty.map(x=>+x.toFixed(2)),[.8,.7,.5]);
 stepPosition(p,bar(1,97,97,93,95));assert.equal(p.addsFilled,2);assert.equal(p.qty,4);assert.equal(p.avg,96.25);
});

test('same candle: the add fills first, then the stop closes everything; targets in that candle are ignored',()=>{
 const p=pos({adds:[{price:95,quantity:1}]});
 stepPosition(p,bar(0,100,120,85,100)); // touches add, stop and every target
 assert.equal(p.status,'CLOSED');assert.equal(p.exitReason,'STOP');assert.equal(p.addsFilled,1);
 assert.equal(positionNet(p),(90-100)+(90-95),'worst path: add then stop');
 assert.equal(p.events.filter(e=>e.type.startsWith('TP')).length,0);
});

test('a gap beyond the stop closes at the open, not at the stop',()=>{
 const p=pos();stepPosition(p,bar(0,100,101,99,100));stepPosition(p,bar(1,85,86,84,85));
 assert.equal(p.exitReason,'STOP');assert.equal(positionNet(p),-15);
});

test('partial exits 40/35/25 %, stop to the average after TP1 from the next candle',()=>{
 const p=pos();
 stepPosition(p,bar(0,100,106,99,105));assert.equal(p.tpDone[0],true);assert.equal(+p.qty.toFixed(6),.6);assert.equal(p.stop,90,'not moved in the same candle');
 stepPosition(p,bar(1,105,105,100.5,101));assert.equal(p.stop,100);
 stepPosition(p,bar(2,101,101,99,100));assert.equal(p.exitReason,'BREAKEVEN_STOP');
 assert.equal(+positionNet(p).toFixed(6),+(.4*5).toFixed(6));
});

test('every target: the last one closes the rest',()=>{
 const p=pos();stepPosition(p,bar(0,100,116,99.5,115));assert.equal(p.exitReason,'ALL_TARGETS');
 assert.equal(+positionNet(p).toFixed(6),+(.4*5+.35*10+.25*15).toFixed(6));
});

test('fees and slippage on every fill; funding every 8 hours on the open notional',()=>{
 const costs={takerRate:.001,slippageBps:10,fundingRate:.0001,maintenanceRate:.005};
 const start=Math.floor(T0/FUNDING_MS)*FUNDING_MS+FUNDING_MS-M5; // the candle ending at the funding time
 const p=openPosition({id:1,symbol:'X',direction:'LONG',entryRef:100,stop:90,targets:[200,210,220],quantity:1,openAt:start-M5,costs});
 assert.equal(+p.avg.toFixed(6),100.1,'entry 10 bps worse');assert.equal(+p.fees.toFixed(6),.1001);
 stepPosition(p,{t:start-M5,o:100,h:100,l:100,c:100});assert.equal(p.funding,0);
 stepPosition(p,{t:start,o:100,h:100,l:100,c:100});assert.equal(+p.funding.toFixed(8),.01,'1 x 100 x 0.01 %');
 stepPosition(p,{t:start+M5,o:100,h:100,l:100,c:100});assert.equal(+p.funding.toFixed(8),.01,'once per funding time');
});

test('time stop at the open',()=>{
 const p=pos({maxHoldMs:2*M5});stepPosition(p,bar(0,100,101,99,100));stepPosition(p,bar(1,100,101,99,100));stepPosition(p,bar(2,102,103,101,102));
 assert.equal(p.exitReason,'TIME_STOP');assert.equal(positionNet(p),2);
});

test('portfolio: the balance changes with each result and sizes the next position',()=>{
 const candles={A:[bar(0,100,100,100,100),bar(1,100,100,89,90),bar(2,90,90,90,90),bar(3,100,100,100,100),bar(4,100,106,99,105),bar(5,105,116,104,115)]};
 const sizes=[];
 const r=runPortfolio({candles,startBalance:1000,limits:{},costs:NOCOST,
  signals:[{symbol:'A',at:T0,direction:'LONG'},{symbol:'A',at:T0+3*M5,direction:'LONG'}],
  plan:(s,acc)=>{const q=acc.balance/1000;sizes.push(acc.balance);return {entryRef:100,stop:90,targets:[105,110,115],quantity:q,riskUSD:10*q}}});
 assert.deepEqual(sizes,[1000,990]);assert.equal(r.trades.length,2);
 assert.equal(+r.finalBalance.toFixed(6),+(990+.99*(.4*5+.35*10+.25*15)).toFixed(6));
});

test('portfolio limits: max open, per direction, one per symbol, open risk, daily loss',()=>{
 const flat=i=>bar(i,100,100.5,99.5,100);
 const candles={A:[0,1,2,3].map(flat),B:[0,1,2,3].map(flat),C:[0,1,2,3].map(flat),D:[0,1,2,3].map(flat)};
 const plan=()=>({entryRef:100,stop:90,targets:[200,210,220],quantity:1,riskUSD:10});
 const sig=(symbol,direction='LONG',i=0)=>({symbol,at:T0+i*M5,direction});
 let r=runPortfolio({candles,costs:NOCOST,plan,limits:{maxOpen:2},signals:[sig('A'),sig('B'),sig('C')]});assert.equal(r.skipped.MAX_OPEN,1);
 r=runPortfolio({candles,costs:NOCOST,plan,limits:{maxPerDirection:1},signals:[sig('A'),sig('B'),sig('C','SHORT')]});assert.equal(r.skipped.MAX_PER_DIRECTION,1);
 r=runPortfolio({candles,costs:NOCOST,plan,signals:[sig('A'),sig('A','LONG',1)]});assert.equal(r.skipped.SYMBOL_BUSY,1);
 r=runPortfolio({candles,costs:NOCOST,plan,startBalance:1000,limits:{openRiskPct:2.5},signals:[sig('A'),sig('B'),sig('C')]});assert.equal(r.skipped.OPEN_RISK_LIMIT,1);
 // Daily loss: a 10 USD loss on a 300 USD account is 3.3 % > 3 %: no new entry that day.
 const drop={A:[bar(0,100,100,100,100),bar(1,100,100,89,90),bar(2,90,90,90,90)],B:[0,1,2].map(flat)};
 r=runPortfolio({candles:drop,costs:NOCOST,plan,startBalance:300,limits:{dailyLossPct:3},signals:[sig('A'),sig('B','LONG',2)]});
 assert.equal(r.skipped.DAILY_LOSS_LIMIT,1);
});

test('portfolio: cross liquidation closes everything at the worst prices and stops trading',()=>{
 const candles={A:[bar(0,100,100,100,100),bar(1,100,100,50,60),bar(2,60,60,60,60)],B:[0,1,2].map(i=>bar(i,100,100,100,100))};
 const r=runPortfolio({candles,costs:NOCOST,startBalance:100,signals:[{symbol:'A',at:T0,direction:'LONG'},{symbol:'B',at:T0+2*M5,direction:'LONG'}],
  plan:()=>({entryRef:100,stop:1,targets:[200,210,220],quantity:2,riskUSD:200})});
 assert.ok(r.liquidated,'2 x 50 = 100 loss on a 100 account');assert.equal(r.trades[0].exitReason,'LIQUIDATION');assert.equal(r.trades.length,1,'no entry after');
 assert.equal(r.finalBalance,0);
 const m=portfolioMetrics(r);assert.equal(m.liquidated,true);assert.equal(m.returnPct,-100);
});

test('metrics: adds bucket, PF, expectancy, worst open loss',()=>{
 const candles={A:[bar(0,100,100,100,100),bar(1,100,100,94,95),bar(2,95,95,89,90),bar(3,100,100,100,100),bar(4,100,116,99,115)]};
 const r=runPortfolio({candles,costs:NOCOST,startBalance:1000,signals:[{symbol:'A',at:T0,direction:'LONG'},{symbol:'A',at:T0+3*M5,direction:'LONG'}],
  plan:()=>({entryRef:100,stop:90,targets:[105,110,115],quantity:1,adds:[{price:95,quantity:1}],riskUSD:15})});
 const m=portfolioMetrics(r);
 assert.equal(m.trades,2);assert.equal(m.byAdds['1'].netUSD,-15);assert.equal(+m.byAdds['0'].netUSD.toFixed(6),9.25);
 assert.equal(+m.profitFactor.toFixed(4),+(9.25/15).toFixed(4));assert.equal(m.worstTradeUSD,-15);assert.ok(m.worstOpenUSD<=-15);
});

test('targets from the average: re-set after each add, the whole position closes there (trader replica)',()=>{
 const p=openPosition({id:1,symbol:'X',direction:'LONG',entryRef:100,stop:1,quantity:1,adds:[{price:98,quantity:1}],openAt:T0,costs:NOCOST,targetsFromAveragePct:[1]});
 assert.equal(p.targets[0],101);
 stepPosition(p,bar(0,100,100.5,97.5,98));assert.equal(p.avg,99);assert.ok(Math.abs(p.targets[0]-99.99)<1e-9);
 stepPosition(p,bar(1,98,100,98,100));assert.equal(p.exitReason,'ALL_TARGETS');assert.ok(Math.abs(positionNet(p)-2*.99)<1e-9);
});

test('a candle that fills an add does not also take a target (order inside the candle unknown)',()=>{
 const p=pos({adds:[{price:97,quantity:1}]});
 stepPosition(p,bar(0,100,106,96.5,100));assert.equal(p.addsFilled,1);assert.equal(p.tpDone[0],false);
 stepPosition(p,bar(1,100,106,99,105));assert.equal(p.tpDone[0],true);
});
