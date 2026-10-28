import test from 'node:test';
import assert from 'node:assert/strict';
import {OrangeXPaperEngine} from '../orangex_paper.mjs';

// Synthetic units, fees and books. They are not observed OrangeX specifications.
const START=Date.parse('2026-10-28T00:00:00Z'),SOURCE='SYNTHETIC_FIXTURE',BTC='BTC-USDT-PERPETUAL',ETH='ETH-USDT-PERPETUAL';
const settings=patch=>({capitalUSD:10000,leverage:3,maxRiskUSD:6,dailyLossLimitUSD:1000,maxPositions:3,
 maxPositionNotionalUSD:500,maxTotalNotionalUSD:1500,...patch});
const contract=(instrumentName=BTC,patch={})=>({instrumentName,symbol:instrumentName.split('-').slice(0,2).join(''),source:SOURCE,
 quantityUnit:'CONTRACT',contractSizeBase:1,minQty:.001,qtyStep:.001,minNotional:1,priceTick:.01,
 makerRate:.0002,takerRate:.0006,feeUnit:'FRACTION',fundingRate:.0001,fundingIntervalMs:28800000,unitsVerifiedForSimulation:true,...patch});
function fixture({seed,settingPatch={},contractPatch={},executionMode,runKind,onChange=()=>{},onEvent=()=>{}}={}){
 let now=START,index=0;
 const engine=new OrangeXPaperEngine(seed??{}, {now:()=>now,onChange,onEvent,
  ...(seed?{}:{settings:settings(settingPatch),contracts:[contract(BTC,contractPatch),contract(ETH,contractPatch)]}),
  ...(executionMode?{executionMode}:{}),...(runKind?{runKind}:{})});
 const signal=(instrumentName=BTC,patch={})=>({key:'risk25-'+(++index),symbol:instrumentName.split('-').slice(0,2).join(''),instrumentName,
  direction:'LONG',entry:100,stop:98,patternConfirmedAt:now-1,timeframe:'1h',trendTimeframe:'4h',confirmed:true,trendConfirmed:true,...patch});
 const book=(bid=99.99,ask=100.01,instrumentName=BTC,patch={})=>({instrumentName,dataSource:SOURCE,bids:[[bid,1000]],asks:[[ask,1000]],
  timestamp:now,markPrice:(bid+ask)/2,markPriceAt:now,...patch});
 const tick=(bid=99.99,ask=100.01,instrumentName=BTC,patch={})=>{now++;return engine.onMarket(book(bid,ask,instrumentName,patch))};
 return {engine,signal,book,tick,now:()=>now,setNow:value=>{now=value}};
}
const near=(a,b)=>assert.ok(Math.abs(a-b)<1e-8,`${a} != ${b}`);

test('only SYNTHETIC_TEST admits fills while historical replay and future live PAPER modes remain blocked',()=>{
 for(const executionMode of ['HISTORICAL_REPLAY','LIVE_MARKET_PAPER']){
  const f=fixture({executionMode,runKind:'BACKTEST'});
  assert.equal(f.engine.register(f.signal(),{dataSource:SOURCE}),false);assert.equal(f.tick(),0);
  assert.equal(f.engine.applyFunding({id:'not-allowed',instrumentName:BTC,dataSource:SOURCE,at:START,rate:.0001,markPrice:100}),false);
  assert.equal(f.engine.closePosition('missing'),false);
  const snapshot=f.engine.snapshot();assert.equal(snapshot.executionMode,executionMode);assert.equal(snapshot.runKind,'BACKTEST');
  assert.deepEqual([snapshot.open.length,snapshot.closed.length,snapshot.pending.length],[0,0,0]);
  assert.ok(snapshot.rejections.every(row=>row.reason==='EXECUTION_MODE_BLOCKED'));
 }
 const f=fixture({executionMode:'SYNTHETIC_TEST',runKind:'BACKTEST'});f.engine.register(f.signal(),{dataSource:SOURCE});f.tick();
 assert.equal(f.engine.snapshot().open.length,1);assert.equal(f.engine.snapshot().open[0].runKind,'BACKTEST');
});

test('stored and legacy run context cannot be re-tagged through restart, configuration or mutation',()=>{
 const f=fixture();f.engine.register(f.signal(),{dataSource:SOURCE});f.tick();const seed=f.engine.exportState();
 for(const options of [{executionMode:'HISTORICAL_REPLAY'},{runKind:'BACKTEST'}])
  assert.throws(()=>new OrangeXPaperEngine(seed,{...options,now:f.now}),/CONTEXT_IMMUTABLE/);
 assert.throws(()=>f.engine.configure({executionMode:'LIVE_MARKET_PAPER'}),/CONTEXT_IMMUTABLE/);
 const legacy=structuredClone(seed);delete legacy.executionMode;delete legacy.runKind;
 for(const collection of ['pending','open','closed'])for(const p of legacy[collection]){delete p.executionMode;delete p.runKind}
 const restored=new OrangeXPaperEngine(legacy,{now:f.now});assert.equal(restored.snapshot().executionMode,'SYNTHETIC_TEST');
 assert.throws(()=>new OrangeXPaperEngine(legacy,{executionMode:'HISTORICAL_REPLAY',now:f.now}),/CONTEXT_IMMUTABLE/);
 const mixed=structuredClone(seed);mixed.open[0].runKind='BACKTEST';assert.throws(()=>new OrangeXPaperEngine(mixed,{now:f.now}),/MIXED/);
 f.engine.store.executionMode='LIVE_MARKET_PAPER';assert.throws(()=>f.tick(),/CONTEXT_IMMUTABLE/);
});

test('three consecutive realized losses halt new signals and retain the halt after restart',()=>{
 const f=fixture();
 for(let i=0;i<3;i++){assert.equal(f.engine.register(f.signal(),{dataSource:SOURCE}),true);f.tick();f.tick(97.99,98)}
 const snap=f.engine.snapshot();assert.equal(snap.closed.length,3);assert.equal(snap.risk.currentLossStreak,3);
 assert.equal(f.engine.register(f.signal(),{dataSource:SOURCE}),false);
 assert.equal(f.engine.snapshot().rejections.at(-1).reason,'CONSECUTIVE_LOSS_LIMIT');
 const restored=new OrangeXPaperEngine(f.engine.exportState(),{now:f.now});
 assert.equal(restored.register(f.signal(),{dataSource:SOURCE}),false);assert.equal(restored.snapshot().risk.entryBlockReason,'CONSECUTIVE_LOSS_LIMIT');
});

test('a previously accepted pending order is not a bypass after the loss streak reaches its limit',()=>{
 const f=fixture({settingPatch:{maxConsecutiveLosses:1}});
 f.engine.register(f.signal(),{dataSource:SOURCE});f.tick();
 assert.equal(f.engine.register(f.signal(ETH),{dataSource:SOURCE}),true);
 f.tick(97.99,98);f.tick(99.99,100.01,ETH);
 assert.equal(f.engine.snapshot().closed.length,1);assert.equal(f.engine.snapshot().open.length,0);assert.equal(f.engine.snapshot().pending.length,0);
 assert.equal(f.engine.snapshot().rejections.at(-1).reason,'CONSECUTIVE_LOSS_LIMIT');
});

test('equal close timestamps across contracts use ledger order so an older win cannot hide the newest loss',()=>{
 const f=fixture({settingPatch:{maxConsecutiveLosses:1}}),first=f.signal(),second=f.signal(ETH);
 f.engine.register(first,{dataSource:SOURCE});f.tick();f.engine.register(second,{dataSource:SOURCE});f.tick(99.99,100.01,ETH);
 f.setNow(f.now()+1);f.engine.closePosition(first.key,f.book(101,101.01));
 f.engine.onMarket(f.book(97.99,98,ETH));
 const snapshot=f.engine.snapshot();assert.equal(snapshot.closed[0].closedAt,snapshot.closed[1].closedAt);
 assert.ok(snapshot.closed[0].realizedPnLUSD>0);assert.ok(snapshot.closed[1].realizedPnLUSD<0);
 assert.equal(snapshot.risk.currentLossStreak,1);assert.equal(f.engine.register(f.signal(),{dataSource:SOURCE}),false);
});

test('connection loss blocks new and pending fills while existing stop management still operates',()=>{
 const f=fixture();f.engine.register(f.signal(),{dataSource:SOURCE});f.tick();
 const pending=f.signal(ETH);f.engine.register(pending,{dataSource:SOURCE});
 f.engine.setConnectionStatus({connected:false,at:f.now()});
 assert.equal(f.engine.register(f.signal(ETH),{dataSource:SOURCE}),false);
 f.tick(99.99,100.01,ETH);assert.equal(f.engine.snapshot().pending.length,0);
 f.tick(97.99,98);assert.equal(f.engine.snapshot().closed.length,1);
 f.engine.setConnectionStatus({connected:true,at:f.now()});
 assert.equal(f.engine.register(pending,{dataSource:SOURCE}),false,'the cancelled identity remains seen after reconnection');
 assert.equal(f.engine.snapshot().risk.connection.connected,true);
});

test('per-position and aggregate margin caps constrain actual filled exposure including partial entries',()=>{
 const f=fixture({settingPatch:{maxRiskUSD:100,maxPositionNotionalUSD:10000,maxTotalNotionalUSD:20000,
  maxPositionMarginUSD:2,maxTotalMarginUSD:2.5},contractPatch:{minNotional:.01}});
 f.engine.register(f.signal(),{dataSource:SOURCE,orderType:'LIMIT',limitPrice:100.01});
 f.tick(99.99,100.01,BTC,{asks:[[100.01,.02]]});
 const partial=f.engine.snapshot();assert.equal(partial.open.length,1);assert.equal(partial.pending.length,1);
 f.tick();
 f.engine.register(f.signal(ETH),{dataSource:SOURCE});f.tick(99.99,100.01,ETH);
 const snap=f.engine.snapshot();assert.equal(snap.open.length,2);
 assert.ok(snap.open.every(p=>p.marginUSD<=2+1e-8));assert.ok(snap.summary.usedMarginUSD<=2.5+1e-8);
 assert.equal(snap.risk.positionMarginLimitUSD,2);assert.equal(snap.risk.totalMarginLimitUSD,2.5);
 const restored=new OrangeXPaperEngine(f.engine.exportState(),{now:f.now});near(restored.snapshot().summary.usedMarginUSD,snap.summary.usedMarginUSD);
});

test('unset margin caps derive from existing notional limits and invalid caps are not zero-cost defaults',()=>{
 const f=fixture(),snap=f.engine.snapshot();
 near(snap.risk.positionMarginLimitUSD,snap.settings.maxPositionNotionalUSD/snap.settings.leverage);
 near(snap.risk.totalMarginLimitUSD,snap.settings.maxTotalNotionalUSD/snap.settings.leverage);
 for(const patch of [{maxPositionMarginUSD:0},{maxTotalMarginUSD:-1},{maxConsecutiveLosses:0},{maxConsecutiveLosses:1.5}])
  assert.throws(()=>f.engine.configure(patch),/INVALID/);
});

test('STOP gaps record the actual net loss above planned risk without pretending the configured loss was guaranteed',()=>{
 const f=fixture();f.engine.register(f.signal(),{dataSource:SOURCE});f.tick();const planned=f.engine.snapshot().open[0].plannedRiskUSD;
 f.setNow(f.now()+120000);f.tick(85,85.01);
 const trade=f.engine.snapshot().closed[0];assert.equal(trade.closeReason,'STOP');assert.ok(-trade.realizedPnLUSD>planned);
 near(trade.gapStopExceeded.plannedRiskUSD,planned);near(trade.gapStopExceeded.realizedLossUSD,-trade.realizedPnLUSD);
 near(trade.gapStopExceeded.overrunUSD,-trade.realizedPnLUSD-planned);
 assert.equal(f.engine.snapshot().risk.gapStopExceededCount,1);assert.ok(f.engine.snapshot().events.some(event=>event.type==='STOP_RISK_OVERRUN'));
});

test('spread and depth slippage have independent signed references and are not subtracted from net PNL twice',()=>{
 const f=fixture();f.engine.register(f.signal(),{dataSource:SOURCE});
 f.tick(99.99,100.01,BTC,{asks:[[100.01,.2],[100.11,1000]]});
 const open=f.engine.snapshot().open[0],entry=open.entryParts[0];assert.ok(entry.slippageUSD>0);
 near(entry.slippageUSD,(entry.price-100.01)*entry.quantity);near(entry.spreadCostUSD,(100.01-100)*entry.quantity);
 f.tick(101,101.01);f.engine.closePosition(open.key);
 const trade=f.engine.snapshot().closed[0],exit=trade.exitParts[0];
 near(exit.slippageUSD,(101-exit.price)*exit.quantity);near(exit.spreadCostUSD,(101.005-101)*exit.quantity);
 near(trade.realizedPnLUSD,trade.realizedGrossUSD-trade.feesUSD-trade.fundingUSD);
});

test('legacy parts without depth references remain absent rather than being given invented zero slippage',()=>{
 const f=fixture();f.engine.register(f.signal(),{dataSource:SOURCE});f.tick();f.tick(104,104.01);f.tick(106,106.01);f.tick(108,108.01);
 const seed=f.engine.exportState();
 for(const part of [...seed.closed[0].entryParts,...seed.closed[0].exitParts])
  for(const key of ['referencePrice','marketMidPrice','slippageUSD','spreadCostUSD'])delete part[key];
 const restored=new OrangeXPaperEngine(seed,{now:f.now});
 assert.ok(restored.snapshot().closed[0].entryParts.every(part=>!Object.hasOwn(part,'slippageUSD')));
 assert.equal(restored.snapshot().closed[0].realizedPnLUSD,seed.closed[0].realizedPnLUSD);
});

test('a failed save cannot consume depth or publish a fill and retry after restart produces exactly one entry',()=>{
 let fail=false,persisted,events=0;
 const f=fixture({onChange:state=>{if(fail)throw Error('simulated ENOSPC');persisted=structuredClone(state)},onEvent:()=>events++});
 f.engine.register(f.signal(),{dataSource:SOURCE});const before=f.engine.exportState(),beforeEvents=events;
 fail=true;assert.throws(()=>f.tick(),/ENOSPC/);assert.deepEqual(f.engine.exportState(),before);assert.equal(events,beforeEvents);
 const restored=new OrangeXPaperEngine(persisted,{now:f.now}),book=f.book();restored.onMarket(book);
 const quantity=restored.snapshot().open[0].quantityOriginal;restored.onMarket(book);
 assert.equal(restored.snapshot().open.length,1);near(restored.snapshot().open[0].quantityOriginal,quantity);
});

test('constructor contract overrides cannot change the unit or fee basis of an already open position',()=>{
 const f=fixture();f.engine.register(f.signal(),{dataSource:SOURCE});f.tick();
 assert.throws(()=>new OrangeXPaperEngine(f.engine.exportState(),{now:f.now,contracts:[contract(BTC,{contractSizeBase:10})]}),/LOCKED/);
});

test('a lost, older or malformed saved cursor cannot replay a partial entry even with a fabricated larger sequence',()=>{
 const f=fixture(),signal=f.signal();f.engine.register(signal,{dataSource:SOURCE,orderType:'LIMIT',limitPrice:100.01});
 f.tick(99.99,100.01,BTC,{asks:[[100.01,.2]],sequence:10});
 const original=f.engine.exportState(),quantity=original.open[0].quantityOriginal,at=f.now();
 for(const mutation of [
  seed=>{seed.lastMarkets={}},
  seed=>{seed.lastMarkets[BTC].timestamp=at-1},
  seed=>{seed.lastMarkets[BTC].bids='corrupt-cursor'},
  seed=>{seed.lastMarkets[BTC]=null},
  seed=>{seed.lastMarkets[BTC].instrumentName=ETH}
 ]){
  const seed=structuredClone(original);mutation(seed);let now=at;
  const restored=new OrangeXPaperEngine(seed,{now:()=>now});
  const duplicate=f.book(99.99,100.01,BTC,{asks:[[100.01,.2]],sequence:1000});
  restored.onMarket(duplicate);
  assert.equal(restored.snapshot().open[0].quantityOriginal,quantity);assert.equal(restored.snapshot().open[0].entryParts.length,1);
  assert.equal(restored.snapshot().pending.length,1);assert.equal(restored.snapshot().rejections.at(-1).reason,'BOOK_REPLAY');
  now++;restored.onMarket({...duplicate,timestamp:now,markPriceAt:now,sequence:1001});
  assert.ok(restored.snapshot().open[0].quantityOriginal>quantity,'a genuinely newer source book may resume the preserved partial order');
 }
});

test('a valid saved cursor permits a newer sequence at the same source time but never its duplicate sequence',()=>{
 const f=fixture(),signal=f.signal();f.engine.register(signal,{dataSource:SOURCE,orderType:'LIMIT',limitPrice:100.01});
 f.tick(99.99,100.01,BTC,{asks:[[100.01,.2]],sequence:10});
 const restored=new OrangeXPaperEngine(f.engine.exportState(),{now:f.now}),original=restored.snapshot().open[0].quantityOriginal;
 restored.onMarket(f.book(99.99,100.01,BTC,{asks:[[100.01,.2]],sequence:10}));near(restored.snapshot().open[0].quantityOriginal,original);
 restored.onMarket(f.book(99.99,100.01,BTC,{asks:[[100.01,.2]],sequence:11}));
 assert.ok(restored.snapshot().open[0].quantityOriginal>original);
});

test('CLOSE also waits for a fresh forward source book when the persisted consumed-depth cursor was lost',()=>{
 const f=fixture(),signal=f.signal();f.engine.register(signal,{dataSource:SOURCE,orderType:'LIMIT',limitPrice:100.01});
 f.tick(99.99,100.01,BTC,{asks:[[100.01,.2]],sequence:10});
 const seed=f.engine.exportState();seed.lastMarkets={};let now=f.now();
 const restored=new OrangeXPaperEngine(seed,{now:()=>now});
 restored.closePosition(signal.key,f.book(99.99,100.01,BTC,{sequence:999}));
 assert.equal(restored.snapshot().open.length,1);assert.equal(restored.snapshot().closed.length,0);assert.equal(restored.snapshot().pending.length,0);
 now++;restored.closePosition(signal.key,{...f.book(),timestamp:now,markPriceAt:now});
 assert.equal(restored.snapshot().closed.length,1);assert.equal(restored.snapshot().closed[0].entryParts.length,1);
 assert.equal(restored.snapshot().closed[0].exitParts[0].at,now);
});
