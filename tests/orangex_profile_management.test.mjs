import test from 'node:test';
import assert from 'node:assert/strict';
import {OrangeXPaperEngine} from '../orangex_paper.mjs';

// Explicit synthetic contracts and trade-derived profile fixtures. These values
// are not OrangeX specifications, real fills or measured strategy performance.
const START=Date.parse('2026-11-04T00:00:00Z'),NAME='BTC-USDT-PERPETUAL';
const settings={capitalUSD:10000,leverage:3,maxRiskUSD:6,dailyLossLimitUSD:30,maxPositions:2,
 maxPositionNotionalUSD:500,maxTotalNotionalUSD:1000,maxSpreadBps:30,maxSlippageBps:100};
const contract={instrumentName:NAME,symbol:'BTCUSDT',source:'SYNTHETIC_FIXTURE',quantityUnit:'CONTRACT',
 contractSizeBase:1,minQty:.001,qtyStep:.001,minNotional:1,priceTick:.01,makerRate:.0002,takerRate:.0006,
 feeUnit:'FRACTION',fundingRate:.0001,fundingIntervalMs:8*3600000,unitsVerifiedForSimulation:true};
const signal=(direction='LONG',extra={})=>{
 const targets=direction==='LONG'?[104,106,108]:[96,94,92];
 return {key:'profile-'+direction,symbol:'BTCUSDT',instrumentName:NAME,direction,entry:100,stop:direction==='LONG'?98:102,
  patternConfirmedAt:START-1000,timeframe:'1h',trendTimeframe:'4h',confirmed:true,trendConfirmed:true,
  managementVersion:'VOLUME_PROFILE_V1',targetPlan:{ok:true,targets,parts:targets.map((price,i)=>({price,fraction:[.4,.35,.25][i]})),
   profileEvidence:{dataSource:'SYNTHETIC_AGG_TRADES',tradeCount:300,windowStart:START-3600000,windowEnd:START-1000}},...extra};
};
function setup({seed,options={},save=()=>{}}={}){
 let now=START;
 const engine=new OrangeXPaperEngine(seed??{},{now:()=>now,onChange:save,...(!seed?{settings:{...settings,...options},contracts:[contract]}:{})});
 const book=(bid,ask,extra={})=>({instrumentName:NAME,dataSource:'SYNTHETIC_FIXTURE',timestamp:now,markPrice:(bid+ask)/2,markPriceAt:now,
  bids:[[bid,1000]],asks:[[ask,1000]],...extra});
 const tick=(bid=99.99,ask=100.01,extra={})=>{now++;return engine.onMarket(book(bid,ask,extra))};
 return {engine,tick,book,setNow:value=>{now=value},getNow:()=>now};
}
const close=(a,b)=>assert.ok(Math.abs(a-b)<1e-8,`${a} != ${b}`);

test('new profile inputs require three explicit ordered target levels and cannot fall back to R multiples',()=>{
 for(const patch of [{targetPlan:undefined},{targetPlan:{ok:false}},
  {targetPlan:{...signal().targetPlan,targets:[104,106]}},
  {targetPlan:{...signal().targetPlan,parts:[{fraction:.4},{fraction:.35},{}]}},
  {targetPlan:{...signal().targetPlan,targets:[104,104,108]}},
  {targets:[105,107,109]}]){
  const {engine}=setup();assert.equal(engine.register(signal('LONG',patch),{dataSource:'SYNTHETIC_FIXTURE'}),false);
  assert.equal(engine.snapshot().open.length,0);assert.equal(engine.snapshot().pending.length,0);
 }
 const {engine,tick}=setup();assert.equal(engine.register(signal(),{dataSource:'SYNTHETIC_FIXTURE'}),true);tick();
 assert.deepEqual(engine.snapshot().open[0].targets,[104,106,108]);
 assert.equal(engine.snapshot().open[0].managementVersion,'VOLUME_PROFILE_V1');
});

test('TP1 touch and partial execution do not move protection; full confirmed 40 percent moves exactly once after restart',()=>{
 const first=setup();first.engine.register(signal(),{dataSource:'SYNTHETIC_FIXTURE'});first.tick();
 const opened=first.engine.snapshot().open[0],quantity=opened.quantityOriginal;
 first.tick(103.99,104);assert.equal(first.engine.snapshot().open[0].stop,98,'ask touching a LONG target does not sell');
 first.tick(104,104.01,{bids:[[104,.1]],asks:[[104.01,1000]]});
 let p=first.engine.snapshot().open[0];assert.ok(p.tpFilled[0]>0&&p.tpFilled[0]<quantity*.4);
 assert.equal(p.stop,98);assert.equal(p.breakevenMovedAt,undefined);
 const restored=setup({seed:first.engine.exportState()});restored.setNow(first.getNow());
 restored.tick(104,104.01);p=restored.engine.snapshot().open[0];
 close(p.quantityRemaining,quantity*.6);close(p.stop,p.entryPrice);close(p.breakevenTargetQuantity,quantity*.4);
 const movedAt=p.breakevenMovedAt;assert.ok(movedAt);assert.equal(p.breakevenMode,'ENTRY');
 const replay=restored.book(104,104.01);restored.engine.onMarket(replay);
 restored.tick(104.1,104.11);assert.equal(restored.engine.snapshot().open[0].breakevenMovedAt,movedAt);
 assert.equal(restored.engine.snapshot().events.filter(e=>e.type==='STOP_MOVED_TO_BREAKEVEN').length,1);
 restored.tick(106,106.01);close(restored.engine.snapshot().open[0].quantityRemaining,quantity*.25);
 restored.tick(108,108.01);const closed=restored.engine.snapshot().closed[0];
 close(closed.exitParts.filter(x=>x.type==='TP1').reduce((s,p)=>s+p.quantity,0),quantity*.4);
 close(closed.exitParts.filter(x=>x.type==='TP2').reduce((s,p)=>s+p.quantity,0),quantity*.35);
 close(closed.exitParts.filter(x=>x.type==='TP3').reduce((s,p)=>s+p.quantity,0),quantity*.25);
 assert.equal(closed.quantityRemaining,0);assert.equal(closed.closeReason,'ALL_TARGETS');assert.ok(closed.realizedPnLUSD>0);
});

test('BE off is snapshotted for a new position and later global changes never change its original protection policy',()=>{
 const {engine,tick}=setup({options:{TP1_MOVE_STOP_TO_BREAKEVEN:false}});
 engine.register(signal(),{dataSource:'SYNTHETIC_FIXTURE'});tick();engine.configure({TP1_MOVE_STOP_TO_BREAKEVEN:true});
 tick(104,104.01);const p=engine.snapshot().open[0];assert.equal(p.moveStopToBreakeven,false);assert.equal(p.stop,98);
 assert.equal(p.breakevenMovedAt,undefined);
});

test('SHORT TP1 uses average entry and a later adverse gap closes remaining quantity at executable ask, not invented BE',()=>{
 const {engine,tick}=setup();engine.register(signal('SHORT'),{dataSource:'SYNTHETIC_FIXTURE'});tick();
 const original=engine.snapshot().open[0];tick(95.99,96);
 const managed=engine.snapshot().open[0];close(managed.stop,original.entryPrice);close(managed.quantityRemaining,original.quantityOriginal*.6);
 tick(101.99,102);const p=engine.snapshot().closed[0];assert.equal(p.closeReason,'STOP');
 assert.equal(p.exitParts.at(-1).price,102);assert.ok(p.exitParts.at(-1).price>p.breakevenStop);
 close(p.exitParts.at(-1).quantity,original.quantityOriginal*.6);assert.equal(p.quantityRemaining,0);
});

test('an interrupted save cannot persist a fill without its breakeven marker or publish duplicate protection events',()=>{
 let fail=false;const context=setup({save:()=>{if(fail)throw Error('synthetic-disk-full')}});
 context.engine.register(signal(),{dataSource:'SYNTHETIC_FIXTURE'});context.tick();const before=context.engine.exportState();
 fail=true;assert.throws(()=>context.tick(104,104.01),/synthetic-disk-full/);assert.deepEqual(context.engine.exportState(),before);
 fail=false;context.tick(104,104.01);assert.equal(context.engine.snapshot().events.filter(e=>e.type==='STOP_MOVED_TO_BREAKEVEN').length,1);
 const seed=context.engine.exportState(),copy=structuredClone(seed);new OrangeXPaperEngine(seed,{now:()=>context.getNow()});
 assert.deepEqual(seed,copy,'loading does not rewrite stored targets or protection markers');
});

test('legacy saved targets and stops remain untouched and explicit profile cost mode needs verified simulation assumptions',()=>{
 const legacy=setup(),row=signal();delete row.managementVersion;delete row.targetPlan;
 legacy.engine.register(row,{dataSource:'SYNTHETIC_FIXTURE'});legacy.tick();legacy.tick(104,104.01);
 const p=legacy.engine.snapshot().open[0];assert.equal(p.managementVersion,'LEGACY_R_V1');assert.equal(p.stop,98);
 const seed=legacy.engine.exportState(),before=structuredClone(seed),restored=setup({seed});
 assert.deepEqual(seed,before);assert.deepEqual(restored.engine.snapshot().open[0].targets,p.targets);assert.equal(restored.engine.snapshot().open[0].stop,98);
 const invalid=setup();assert.equal(invalid.engine.register(signal('LONG',{breakevenMode:'COST_COVERED'}),{dataSource:'SYNTHETIC_FIXTURE'}),false);
 assert.equal(invalid.engine.snapshot().rejections.at(-1).reason,'BREAKEVEN_COSTS_UNVERIFIED');
 const explicit=setup();assert.equal(explicit.engine.register(signal('LONG',{breakevenMode:'COST_COVERED',
  breakevenCostAssumptions:{verifiedForSimulation:true,exitSlippageBps:2}}),{dataSource:'SYNTHETIC_FIXTURE'}),true);
 explicit.tick();explicit.tick(104,104.01);const protectedPosition=explicit.engine.snapshot().open[0];
 assert.ok(protectedPosition.stop>protectedPosition.entryPrice);assert.equal(protectedPosition.breakevenCostCoverage,
  'ENTRY_EXIT_TAKER_FEES_AND_EXPLICIT_EXIT_SLIPPAGE_ONLY');
 assert.equal(explicit.engine.snapshot().realDataEntryEnabled,false);
});
