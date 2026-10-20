import test from 'node:test';
import assert from 'node:assert/strict';
import {PaperEngine,fillPrice,paperSummary,paperCSV} from '../paper.mjs';
let current=Date.parse('2026-10-19T08:00:00Z');
const signal=(direction='LONG',symbol='BTCUSDT')=>({symbol,direction,pattern:'1H 확정',entry:100,stop:direction==='LONG'?98:102,patternConfirmedAt:current-60000});
const create=(settings={})=>new PaperEngine({}, {now:()=>current,settings});
function quote(p,engine,symbol='BTCUSDT',market='CRYPTO',options={}){current+=1000;return engine.onPrice(market,symbol,p,current,options)}

test('forward-only: new signal cannot execute at a price observed before signal',()=>{
 const engine=create();assert.equal(engine.register(signal(),{quoteEligible:true}),true);
 assert.equal(engine.onPrice('CRYPTO','BTCUSDT',100,current-1),0);
 assert.equal(engine.snapshot().pendingCount,1);assert.equal(engine.snapshot().openCount,0);
 quote(100,engine);assert.equal(engine.snapshot().pendingCount,0);assert.equal(engine.snapshot().openCount,1);
});
test('long target 40% then protective stop closes rest and includes fees',()=>{
 const engine=create();engine.register(signal(),{quoteEligible:true});quote(100,engine);
 let trade=engine.store.open[0];assert.ok(trade.notionalUSD>=250&&trade.notionalUSD<=300);
 const entryFee=trade.feesUSD;assert.ok(entryFee>0);const filled=trade.entryFill;
 quote(104,engine);trade=engine.store.open[0];assert.equal(trade.exitedPct,40);assert.equal(trade.closeParts[0].type,'TARGET');assert.equal(trade.stop,filled);
 quote(100,engine);assert.equal(engine.store.closed.length,1);
 const item=engine.store.closed[0];assert.equal(item.closeReason,'STOP');assert.equal(item.closeParts.length,2);
 assert.ok(item.feesUSD>entryFee);assert.ok(Number.isFinite(item.realizedPnLUSD));
 assert.ok(Math.abs(item.realizedGrossUSD-item.feesUSD-item.realizedPnLUSD)<1e-6);
});
test('short all three targets gets positive net PNL and correctly weighted quantities',()=>{
 const engine=create();engine.register(signal('SHORT','ETHUSDT'),{quoteEligible:true,symbol:'ETHUSDT'});
 quote(100,engine,'ETHUSDT');quote(96,engine,'ETHUSDT');quote(94,engine,'ETHUSDT');quote(92,engine,'ETHUSDT');
 assert.equal(engine.store.open.length,0);const x=engine.store.closed[0];
 assert.equal(x.closeReason,'ALL_TARGETS');assert.deepEqual(x.closeParts.map(p=>p.targetNumber),[1,2,3]);
 const total=x.closeParts.reduce((a,p)=>a+p.qty,0);
 assert.ok(Math.abs(total-x.originalQty)<1e-9);
 assert.ok(x.realizedPnLUSD>0);assert.equal(engine.snapshot().winRatePct,100);
});
test('crossing stop with a price gap is filled at worse observed tick not guaranteed stop',()=>{
 const engine=create();engine.register(signal(),{quoteEligible:true});quote(100,engine);quote(95,engine);
 assert.equal(engine.store.closed[0].closeReason,'STOP');
 assert.equal(engine.store.closed[0].closeParts[0].reference,95);
 assert.ok(engine.store.closed[0].realizedPnLUSD<-10);
});
test('stale or duplicate quotes and reloaded observations never create artificial fills',()=>{
 const engine=create();engine.register(signal(),{quoteEligible:true});
 assert.equal(engine.onPrice('CRYPTO','BTCUSDT',100,current-200000),0);
 assert.equal(engine.store.pending.length,1);
 quote(100,engine);
 const afterReload=new PaperEngine(structuredClone(engine.store),{now:()=>current});
 assert.equal(afterReload.register(signal(),{quoteEligible:true}),false);
 assert.equal(afterReload.onPrice('CRYPTO','BTCUSDT',108,current),0);
 assert.equal(afterReload.store.closed.length,0);
});
test('TradFi stale snapshot is not executed and is marked with correct market/source',()=>{
 const engine=create();engine.register({...signal('LONG','XAU-SWAP'),ticker:'XAU-SWAP'},{market:'TRADFI',quoteEligible:true});
 assert.equal(engine.onPrice('TRADFI','XAU-SWAP',100,current+1000,{quoteFresh:false}),0);
 quote(100,engine,'XAU-SWAP','TRADFI',{halfSpreadBps:5});
 assert.equal(engine.store.open[0].market,'TRADFI');assert.equal(engine.store.open[0].halfSpreadBps,5);
});
test('risk limits block further paper positions and it never places real orders',()=>{
 const engine=create({maxPositions:1});engine.register(signal(),{quoteEligible:true});
 const second=signal('SHORT','ETHUSDT');assert.equal(engine.register(second,{quoteEligible:true,symbol:'ETHUSDT'}),false);
 assert.match(engine.store.skipped.at(-1).reason,/상한/);assert.equal(engine.store.open.length,0);
});
test('pending signal expires without a future observed ticker, never fabricated',()=>{
 const engine=create();engine.register(signal(),{quoteEligible:true});current+=22*60000;
 engine.expirePending();assert.equal(engine.snapshot().pendingCount,0);assert.equal(engine.store.closed.length,0);
 assert.match(engine.store.skipped.at(-1).reason,/20분/);
});
test('summary profits, losses, CSV and fees remain auditable',()=>{
 const engine=create();engine.register(signal(),{quoteEligible:true});quote(100,engine);quote(98,engine);
 let summary=paperSummary(engine.store,{now:current});assert.equal(summary.closedCount,1);assert.ok(summary.netRealizedUSD<0);
 assert.ok(summary.totalFeesUSD>0);assert.ok(summary.maxClosedTradeDrawdownUSD>0);
 const csv=paperCSV(engine.store.closed);assert.match(csv,/BTCUSDT/);assert.match(csv,/realizedPnLUSD/);
 assert.equal(fillPrice(100,'BUY',{halfSpreadBps:5,slippageBps:2}),100.07);
});
test('partial target profit is included in equity before final liquidation',()=>{
 const engine=create();engine.register(signal(),{quoteEligible:true});quote(100,engine);quote(104,engine);
 const summary=engine.snapshot();assert.equal(summary.closedCount,0);
 assert.ok(summary.openPartialRealizedUSD>0,'partial exit realized profit must show in running equity');
 assert.ok(summary.netRealizedUSD>0);assert.ok(summary.indicativeEquityUSD>1000);
});
