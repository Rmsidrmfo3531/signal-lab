import test from 'node:test';
import assert from 'node:assert/strict';
import {OrangeXPaperEngine} from '../orangex_paper.mjs';

// Explicitly synthetic execution contract. None of these values are claimed
// to be observed OrangeX specifications or account-specific fee rates.
const START=Date.parse('2026-10-28T00:00:00Z');
const NAME='BTC-USDT-PERPETUAL';
const config=extra=>({capitalUSD:10000,leverage:3,maxRiskUSD:6,dailyLossLimitUSD:18,maxPositions:2,
 maxPositionNotionalUSD:500,maxTotalNotionalUSD:1500,maxQuoteAgeMs:90000,maxSignalAgeMs:7200000,
 entryTimeoutMs:1200000,maxSpreadBps:30,maxSlippageBps:100,killSwitch:false,...extra});
const contract=extra=>({instrumentName:NAME,symbol:'BTCUSDT',source:'SYNTHETIC_FIXTURE',quantityUnit:'CONTRACT',
 contractSizeBase:1,minQty:.001,qtyStep:.001,minNotional:1,priceTick:.01,makerRate:.0002,takerRate:.0006,
 feeUnit:'FRACTION',fundingRate:.0001,fundingIntervalMs:8*3600000,unitsVerifiedForSimulation:true,...extra});
const signal=(direction='LONG',extra={})=>({key:'synthetic-'+direction,symbol:'BTCUSDT',instrumentName:NAME,direction,
 entry:100,stop:direction==='LONG'?98:102,patternConfirmedAt:START-1000,
 timeframe:'1h',trendTimeframe:'4h',confirmed:true,trendConfirmed:true,...extra});
function setup({settings={},manifest={},seed,save=()=>{}}={}){
 let clock=START;
 const engine=new OrangeXPaperEngine(seed??{}, {now:()=>clock,onChange:save,
  ...(seed?{}:{settings:config(settings),contracts:[contract(manifest)]})});
 const market=(bid=99.99,ask=100.01,extra={})=>({instrumentName:NAME,dataSource:'SYNTHETIC_FIXTURE',
  bids:[[bid,1000]],asks:[[ask,1000]],timestamp:clock,markPrice:(bid+ask)/2,markPriceAt:clock,...extra});
 const tick=(bid=99.99,ask=100.01,extra={})=>{clock++;return engine.onMarket(market(bid,ask,extra))};
 return {engine,market,tick,setNow:value=>{clock=value},getNow:()=>clock};
}
const closeEnough=(actual,expected,message)=>assert.ok(Math.abs(actual-expected)<1e-7,`${message}: ${actual} vs ${expected}`);

test('synthetic LONG reaches three targets with exact 40/35/25 reductions and cost-inclusive CLOSE PNL',()=>{
 const {engine,tick}=setup();
 assert.equal(engine.register(signal(),{dataSource:'SYNTHETIC_FIXTURE'}),true);
 tick();let snap=engine.snapshot();assert.equal(snap.pending.length,0);assert.equal(snap.open.length,1);
 const opened=snap.open[0],quantity=opened.quantityOriginal;
 assert.ok(quantity>0);closeEnough(opened.entryPrice,100.01,'buy uses observed ask');
 assert.ok(quantity*(100.01-98)+(quantity*100.01+quantity*98)*.0006<=6+1e-7,'position risk includes both fees');
 tick(104,104.01);snap=engine.snapshot();assert.equal(snap.open.length,1);
 closeEnough(snap.open[0].quantityRemaining,quantity*.6,'after TP1');
 tick(106,106.01);snap=engine.snapshot();closeEnough(snap.open[0].quantityRemaining,quantity*.25,'after TP2');
 tick(108,108.01);snap=engine.snapshot();assert.equal(snap.open.length,0);assert.equal(snap.closed.length,1);
 const trade=snap.closed[0];assert.equal(trade.key,opened.key);assert.equal(trade.quantityRemaining,0);
 assert.deepEqual(trade.exitParts.map(part=>part.type),['TP1','TP2','TP3']);
 for(const [index,weight]of [.4,.35,.25].entries())closeEnough(trade.exitParts[index].quantity,quantity*weight,'target split');
 const gross=quantity*(.4*(104-100.01)+.35*(106-100.01)+.25*(108-100.01));
 const fees=quantity*(100.01+.4*104+.35*106+.25*108)*.0006;
 closeEnough(trade.realizedGrossUSD,gross,'gross profit');closeEnough(trade.feesUSD,fees,'entry and three exit fees');
 closeEnough(trade.realizedPnLUSD,gross-fees,'net profit');
 assert.equal(snap.realDataEntryEnabled,false);assert.equal(snap.simulationOnly,true);
});

test('synthetic SHORT stop fills the actual ask and records a negative closed trade',()=>{
 const {engine,tick}=setup();assert.equal(engine.register(signal('SHORT'),{dataSource:'SYNTHETIC_FIXTURE'}),true);
 tick();const opened=engine.snapshot().open[0];closeEnough(opened.entryPrice,99.99,'short sells observed bid');
 tick(102,102.01);const snap=engine.snapshot();assert.equal(snap.open.length,0);assert.equal(snap.closed.length,1);
 const trade=snap.closed[0];assert.equal(trade.exitParts[0].type,'STOP');
 closeEnough(trade.exitParts[0].price,102.01,'stop buys ask after crossing');
 const gross=opened.quantityOriginal*(99.99-102.01),fees=opened.quantityOriginal*(99.99+102.01)*.0006;
 closeEnough(trade.realizedPnLUSD,gross-fees,'short stop net loss');assert.ok(trade.realizedPnLUSD<0);
});

test('missing contract quantities, fee units or funding do not become zero-cost entry assumptions',()=>{
 for(const patch of [{contractSizeBase:null},{qtyStep:null},{minQty:null},{minNotional:null},{priceTick:null},
  {makerRate:null},{takerRate:null},{feeUnit:'UNVERIFIED'},{fundingRate:null},{fundingIntervalMs:null},
  {unitsVerifiedForSimulation:false}]){
  const {engine,tick}=setup({manifest:patch});
  const accepted=engine.register(signal(),{dataSource:'SYNTHETIC_FIXTURE'});tick();
  assert.equal(engine.snapshot().open.length,0,JSON.stringify(patch));
  assert.equal(accepted,false,JSON.stringify(patch));
 }
 const {engine}=setup();assert.equal(engine.register(signal(),{dataSource:'REAL_PUBLIC_READ_ONLY'}),false);
 assert.equal(engine.snapshot().open.length,0);assert.equal(engine.snapshot().realDataEntryEnabled,false);
});

test('unconfirmed, wrong-timeframe, stale and stop-invalidated signals never enter',()=>{
 for(const patch of [{confirmed:false},{trendConfirmed:false},{timeframe:'15m'},{trendTimeframe:'1h'},
  {patternConfirmedAt:START-7200001},{stop:101},{entry:null}]){
  const {engine,tick}=setup();assert.equal(engine.register(signal('LONG',patch),{dataSource:'SYNTHETIC_FIXTURE'}),false);
  tick();assert.equal(engine.snapshot().open.length,0);
 }
});

test('seen signal identity and a same-contract opposite signal cannot create duplicate positions',()=>{
 const {engine,tick}=setup();const first=signal();
 assert.equal(engine.register(first,{dataSource:'SYNTHETIC_FIXTURE'}),true);
 assert.equal(engine.register(first,{dataSource:'SYNTHETIC_FIXTURE'}),false);
 assert.equal(engine.register(signal('SHORT'),{dataSource:'SYNTHETIC_FIXTURE'}),false);
 tick();assert.equal(engine.snapshot().open.length,1);
 assert.equal(engine.register(first,{dataSource:'SYNTHETIC_FIXTURE'}),false);
});

test('non-marketable limit stays pending and a later crossing may fill only displayed depth before cancellation',()=>{
 const {engine,tick}=setup();const key=signal().key;
 assert.equal(engine.register(signal(),{orderType:'LIMIT',limitPrice:99.5,dataSource:'SYNTHETIC_FIXTURE'}),true);
 tick();assert.equal(engine.snapshot().open.length,0);assert.equal(engine.snapshot().pending.length,1);
 tick(99.49,99.5,{bids:[[99.49,100]],asks:[[99.5,.2]]});
 const filled=engine.snapshot();assert.equal(filled.open.length,1);
 assert.ok(filled.open[0].quantityOriginal<=.2+1e-10,'never fill more than displayed quantity');
 assert.ok(filled.open[0].entryPrice<=99.5);assert.equal(filled.pending.length,1,'unfilled limit remainder stays pending');
 engine.cancelOrder(key);assert.equal(engine.snapshot().pending.length,0);
 assert.equal(engine.snapshot().open.length,1,'cancelling entry remainder must not close a filled position');
});

test('market VWAP consumes distinct levels and rejects a stale or duplicate-price depth snapshot',()=>{
 const {engine,tick}=setup();engine.register(signal(),{dataSource:'SYNTHETIC_FIXTURE'});
 tick(99.99,100.01,{bids:[[99.99,1000]],asks:[[100.01,.5],[100.02,1000]]});
 const opened=engine.snapshot().open[0];assert.ok(opened);assert.ok(opened.entryPrice>100.01);
 const quantity=opened.quantityOriginal;
 closeEnough(opened.entryPrice,(Math.min(.5,quantity)*100.01+Math.max(0,quantity-.5)*100.02)/quantity,'book walk VWAP');
 const other=setup();other.engine.register(signal(),{dataSource:'SYNTHETIC_FIXTURE'});
 other.tick(99.99,100.01,{timestamp:START-90001});assert.equal(other.engine.snapshot().open.length,0);
 other.tick(99.99,100.01,{asks:[[100.01,1],[100.01,2]]});assert.equal(other.engine.snapshot().open.length,0);
});

test('restart retains the position and waits for a fresh forward snapshot instead of inventing a stop fill',()=>{
 const original=setup();original.engine.register(signal(),{dataSource:'SYNTHETIC_FIXTURE'});original.tick();
 const before=original.engine.snapshot().open[0],restored=setup({seed:original.engine.exportState()});
 restored.setNow(START+120000);restored.engine.onMarket(restored.market(97,97.01,{timestamp:START,markPriceAt:START}));
 assert.equal(restored.engine.snapshot().open.length,1);assert.equal(restored.engine.snapshot().closed.length,0);
 restored.tick(97,97.01);const trade=restored.engine.snapshot().closed[0];
 assert.ok(trade);assert.equal(trade.key,before.key);assert.equal(trade.exitParts[0].type,'STOP');
 closeEnough(trade.exitParts[0].price,97,'reconnect stop fills current depth, not vanished historical stop');
});

test('funding events use signed long/short transfers and are idempotent across restart',()=>{
 const state=setup();state.engine.register(signal(),{dataSource:'SYNTHETIC_FIXTURE'});state.tick();
 const opened=state.engine.snapshot().open[0],at=START+8*3600000;
 state.setNow(at);const event={id:'synthetic-funding-1',instrumentName:NAME,dataSource:'SYNTHETIC_FIXTURE',at,rate:.0001,markPrice:100};
 state.engine.applyFunding(event);const first=state.engine.snapshot().open[0];
 closeEnough(first.fundingUSD,opened.quantityOriginal*100*.0001,'positive rate is long funding debit');
 const again=setup({seed:state.engine.exportState()});again.setNow(at);again.engine.applyFunding(event);
 closeEnough(again.engine.snapshot().open[0].fundingUSD,first.fundingUSD,'duplicate funding not charged');
 const short=setup();short.engine.register(signal('SHORT'),{dataSource:'SYNTHETIC_FIXTURE'});short.tick();
 const shortQuantity=short.engine.snapshot().open[0].quantityOriginal;
 short.setNow(at);short.engine.applyFunding({...event,id:'short-funding-1'});
 closeEnough(short.engine.snapshot().open[0].fundingUSD,-shortQuantity*100*.0001,'positive rate credits the SHORT');
});

test('explicit local PAPER CLOSE uses executable opposite depth and costs, without manufacturing a live order',()=>{
 const {engine,tick}=setup();engine.register(signal(),{dataSource:'SYNTHETIC_FIXTURE'});tick();
 const opened=engine.snapshot().open[0];tick(101,101.01);
 assert.equal(engine.closePosition(opened.key),true);
 const snap=engine.snapshot();assert.equal(snap.open.length,0);assert.equal(snap.closed.length,1);
 const trade=snap.closed[0];assert.equal(trade.exitParts[0].type,'CLOSE');
 closeEnough(trade.realizedPnLUSD,opened.quantityOriginal*(101-100.01)-opened.quantityOriginal*(101+100.01)*.0006,'manual PAPER close PNL');
 assert.equal(engine.submitOrder,undefined);assert.equal(engine.cancelExchangeOrder,undefined);
});

test('a failed save rolls back entry, CLOSE and accounting before an event can be published',()=>{
 let fail=false,saves=0;const {engine,tick}=setup({save:()=>{saves++;if(fail)throw Error('synthetic-disk-full')}});
 engine.register(signal(),{dataSource:'SYNTHETIC_FIXTURE'});const pending=engine.exportState();fail=true;
 assert.throws(()=>tick(),/synthetic-disk-full/);assert.deepEqual(engine.exportState(),pending);
 fail=false;tick();const opened=engine.exportState();fail=true;
 assert.throws(()=>tick(97,97.01),/synthetic-disk-full/);assert.deepEqual(engine.exportState(),opened);
 fail=false;tick(97,97.01);assert.equal(engine.snapshot().closed.length,1);assert.ok(saves>=4);
});

test('kill switch and insufficient capital prevent new entries while existing stop management stays active',()=>{
 const {engine,tick}=setup();engine.register(signal(),{dataSource:'SYNTHETIC_FIXTURE'});tick();
 engine.configure({killSwitch:true});assert.equal(engine.register(signal('SHORT',{key:'later'}),{dataSource:'SYNTHETIC_FIXTURE'}),false);
 tick(97,97.01);assert.equal(engine.snapshot().open.length,0);assert.equal(engine.snapshot().closed.length,1);
 const small=setup({settings:{capitalUSD:1,leverage:1}});small.engine.register(signal(),{dataSource:'SYNTHETIC_FIXTURE'});small.tick();
 assert.equal(small.engine.snapshot().open.length,0,'minimum executable split size must fit actual available margin');
});

test('contract counts convert through explicit contractSizeBase before notional, fees and PNL',()=>{
 const {engine,tick}=setup({manifest:{contractSizeBase:.01}});
 engine.register(signal(),{dataSource:'SYNTHETIC_FIXTURE'});tick();
 const opened=engine.snapshot().open[0];assert.ok(opened.quantityOriginal>10,'venue quantity is contract count rather than a base amount');
 const baseQuantity=opened.quantityOriginal*.01;
 closeEnough(opened.feesUSD,baseQuantity*100.01*.0006,'entry fee uses base-equivalent notional');
 tick(101,101.01);engine.closePosition(opened.key);
 const closed=engine.snapshot().closed[0];
 closeEnough(closed.realizedPnLUSD,baseQuantity*(101-100.01)-baseQuantity*(101+100.01)*.0006,'non-unit contract PNL');
});

test('pending entries reserve a position slot before a different instrument may enter',()=>{
 const {engine}=setup({settings:{maxPositions:1}});
 engine.setContract(contract({instrumentName:'ETH-USDT-PERPETUAL',symbol:'ETHUSDT'}));
 assert.equal(engine.register(signal(),{dataSource:'SYNTHETIC_FIXTURE'}),true);
 assert.equal(engine.register(signal('LONG',{key:'second-instrument',instrumentName:'ETH-USDT-PERPETUAL',symbol:'ETHUSDT'}),{dataSource:'SYNTHETIC_FIXTURE'}),false);
 assert.equal(engine.snapshot().pending.length,1);assert.equal(engine.snapshot().rejections.at(-1).reason,'MAX_POSITIONS');
});

test('a realized daily loss at its cap prevents a new signal after the old position closes',()=>{
 const {engine,tick}=setup({settings:{dailyLossLimitUSD:1}});
 assert.equal(engine.register(signal(),{dataSource:'SYNTHETIC_FIXTURE'}),true);tick();
 assert.equal(engine.snapshot().open.length,1);tick(95,95.01);
 const before=engine.snapshot();assert.equal(before.closed.length,1);assert.ok(before.summary.dailyPnLUSD<-1);
 assert.equal(engine.register(signal('LONG',{key:'after-loss'}),{dataSource:'SYNTHETIC_FIXTURE'}),false);
 assert.equal(engine.snapshot().rejections.at(-1).reason,'DAILY_LOSS_LIMIT');
});

test('partial target exits share one liquidity budget and replaying the same snapshot cannot refill it',()=>{
 const {engine,tick,market}=setup();engine.register(signal(),{dataSource:'SYNTHETIC_FIXTURE'});tick();
 const quantity=engine.snapshot().open[0].quantityOriginal,oneTarget=quantity*.4;
 tick(104,104.01,{bids:[[104,.1]],asks:[[104.01,1000]]});
 const partial=engine.snapshot().open[0];assert.ok(partial);assert.ok(partial.exitParts.length>0);
 const sold=quantity-partial.quantityRemaining;assert.ok(sold<=.1+1e-10,'all target exits together use at most the displayed bid quantity');
 assert.ok(sold<oneTarget,'one target remains partially open');
 const snapshot=engine.exportState(),same=market(104,104.01,{bids:[[104,.1]],asks:[[104.01,1000]]});
 engine.onMarket(same);closeEnough(engine.snapshot().open[0].quantityRemaining,partial.quantityRemaining,'same book cannot supply another .1');
 tick(104,104.01);closeEnough(engine.snapshot().open[0].quantityRemaining,quantity*.6,'a new book completes TP1 exactly');
 assert.ok(snapshot.events.some(event=>event.type==='TP1'));
});

test('overdue unobserved funding is unknown PNL and blocks new entry rather than reporting zero cost',()=>{
 const {engine,tick,setNow}=setup();engine.register(signal(),{dataSource:'SYNTHETIC_FIXTURE'});tick();
 const firstDue=START+8*3600000;setNow(firstDue);tick(100,100.01);
 const waiting=engine.snapshot();assert.equal(waiting.summary.unverifiedFunding,true);
 assert.equal(waiting.summary.totalPnLUSD,null);assert.equal(waiting.summary.realizedPnLUSD,null);assert.equal(waiting.summary.fundingUSD,null);
 assert.equal(waiting.open[0].settlementStatus,'AWAITING_FUNDING');
 engine.setContract(contract({instrumentName:'ETH-USDT-PERPETUAL',symbol:'ETHUSDT'}));
 engine.register(signal('LONG',{key:'unfunded-next',instrumentName:'ETH-USDT-PERPETUAL',symbol:'ETHUSDT',patternConfirmedAt:firstDue-1}),{dataSource:'SYNTHETIC_FIXTURE'});
 engine.onMarket({instrumentName:'ETH-USDT-PERPETUAL',dataSource:'SYNTHETIC_FIXTURE',bids:[[99.99,1000]],asks:[[100.01,1000]],
  timestamp:firstDue+2,markPrice:100,markPriceAt:firstDue+2});
 assert.equal(engine.snapshot().open.length,1);assert.ok(engine.snapshot().rejections.some(row=>row.reason==='FUNDING_EVENTS_MISSING'));
 engine.applyFunding({id:'funding-catch-up',instrumentName:NAME,dataSource:'SYNTHETIC_FIXTURE',at:firstDue,rate:.0001,markPrice:100});
 assert.equal(engine.snapshot().summary.unverifiedFunding,false);assert.notEqual(engine.snapshot().summary.fundingUSD,null);
});

test('capital, leverage and contract changes are locked while a virtual position exists',()=>{
 const {engine,tick}=setup();engine.register(signal(),{dataSource:'SYNTHETIC_FIXTURE'});tick();
 const before=engine.exportState();
 assert.throws(()=>engine.configure({capitalUSD:20000}),/LOCKED/);assert.deepEqual(engine.exportState(),before);
 assert.throws(()=>engine.configure({leverage:10}),/LOCKED/);assert.deepEqual(engine.exportState(),before);
 assert.throws(()=>engine.setContract(contract({contractSizeBase:2})),/LOCKED/);assert.deepEqual(engine.exportState(),before);
});

test('malformed state and inconsistent position quantities are rejected without an automatic reset',()=>{
 for(const seed of [null,[],{schemaVersion:2},{schemaVersion:1,open:{}},{schemaVersion:1,seen:[]}])
  assert.throws(()=>new OrangeXPaperEngine(seed),/INVALID|UNSUPPORTED/);
 const {engine,tick}=setup();engine.register(signal(),{dataSource:'SYNTHETIC_FIXTURE'});tick();
 const seed=engine.exportState();seed.open[0].quantityRemaining+=1;
 assert.throws(()=>new OrangeXPaperEngine(seed),/INVALID/);
});

test('a funding event outside the declared interval cannot charge a synthetic position',()=>{
 const {engine,tick}=setup();engine.register(signal(),{dataSource:'SYNTHETIC_FIXTURE'});tick();
 const before=engine.snapshot().open[0];
 assert.equal(engine.applyFunding({id:'off-schedule',instrumentName:NAME,dataSource:'SYNTHETIC_FIXTURE',at:START+1,rate:.01,markPrice:100}),false);
 closeEnough(engine.snapshot().open[0].fundingUSD,before.fundingUSD,'off-schedule transfer not applied');
});

test('corrupt persisted cash-flow parts and duplicate pending identities are not accepted as recoverable accounting',()=>{
 const {engine,tick}=setup();engine.register(signal(),{dataSource:'SYNTHETIC_FIXTURE'});
 const duplicate=engine.exportState();duplicate.pending.push(structuredClone(duplicate.pending[0]));
 assert.throws(()=>new OrangeXPaperEngine(duplicate),/INVALID|DUPLICATE/);
 const expiry=engine.exportState();expiry.pending[0].expiresAt=expiry.pending[0].createdAt-1;
 assert.throws(()=>new OrangeXPaperEngine(expiry),/INVALID/);
 tick();const fee=engine.exportState();fee.open[0].entryParts[0].feeUSD='not-a-number';
 assert.throws(()=>new OrangeXPaperEngine(fee),/INVALID/);
});

test('a delayed market fill revalidates stop and first target even after an earlier spread failure sized the order',()=>{
 for(const [bid,ask]of [[97,97.01],[104,104.01]]){
  const {engine,tick}=setup();engine.register(signal(),{dataSource:'SYNTHETIC_FIXTURE'});
  tick(99,101);assert.equal(engine.snapshot().open.length,0,'wide spread initially prevents execution');
  tick(bid,ask);assert.equal(engine.snapshot().open.length,0,'a previously sized pending order cannot enter after invalidation');
 }
});

test('a resting limit that crosses after the stop is invalidated does not use a cached plan to open',()=>{
 const {engine,tick}=setup();engine.register(signal(),{dataSource:'SYNTHETIC_FIXTURE',orderType:'LIMIT',limitPrice:99.5});
 tick();assert.equal(engine.snapshot().pending.length,1);assert.equal(engine.snapshot().open.length,0);
 tick(97,97.01);assert.equal(engine.snapshot().open.length,0);
});

test('another instrument cannot open using stale equity from a previously opened virtual position',()=>{
 const {engine,tick,setNow}=setup();engine.register(signal(),{dataSource:'SYNTHETIC_FIXTURE'});tick();
 engine.setContract(contract({instrumentName:'ETH-USDT-PERPETUAL',symbol:'ETHUSDT'}));
 const later=START+90002;setNow(later);
 assert.equal(engine.snapshot().summary.equityUSD,null,'old BTC mark has expired');
 engine.register(signal('LONG',{key:'new-with-stale-btc',instrumentName:'ETH-USDT-PERPETUAL',symbol:'ETHUSDT',patternConfirmedAt:later-1}),{dataSource:'SYNTHETIC_FIXTURE'});
 engine.onMarket({instrumentName:'ETH-USDT-PERPETUAL',dataSource:'SYNTHETIC_FIXTURE',bids:[[99.99,1000]],asks:[[100.01,1000]],timestamp:later+1,markPrice:100,markPriceAt:later+1});
 assert.equal(engine.snapshot().open.length,1,'an unknown marked equity cannot fund a new entry');
});

test('public method rejection records discard provider extras and use only fixed diagnostic codes',()=>{
 const {engine}=setup();const secret='synthetic-provider-private-extra';
 engine.register({...signal(),unknown_secret:secret},{dataSource:'REAL_PUBLIC_READ_ONLY',providerMessage:secret});
 engine.onMarket({instrumentName:NAME,dataSource:'REAL_PUBLIC_READ_ONLY',error:secret});
 engine.applyFunding({id:'fake',dataSource:'REAL_PUBLIC_READ_ONLY',token:secret});
 const state=engine.exportState();assert.doesNotMatch(JSON.stringify(state),new RegExp(secret));
 assert.ok(state.rejections.every(row=>['REAL_DATA_ENTRY_DISABLED','FUNDING_EVENT_INVALID'].includes(row.reason)));
});

test('restart annotates recovered open and pending views without writing or replaying the ledger',()=>{
 const original=setup();original.engine.register(signal(),{dataSource:'SYNTHETIC_FIXTURE'});original.tick();
 original.engine.setContract(contract({instrumentName:'ETH-USDT-PERPETUAL',symbol:'ETHUSDT'}));
 original.engine.register(signal('LONG',{key:'pending-at-restart',instrumentName:'ETH-USDT-PERPETUAL',symbol:'ETHUSDT'}),{dataSource:'SYNTHETIC_FIXTURE'});
 const before=original.engine.exportState(),newView=original.engine.snapshot();
 assert.equal(newView.recovered,false);assert.equal(newView.open[0].recovered,false);assert.equal(newView.pending[0].recovered,false);
 let saves=0,events=0;
 const restored=new OrangeXPaperEngine(before,{now:()=>START+2,onChange:()=>{saves++},onEvent:()=>{events++}});
 const view=restored.snapshot();assert.equal(view.recovered,true);assert.equal(view.open[0].recovered,true);assert.equal(view.pending[0].recovered,true);
 assert.equal(saves,0);assert.equal(events,0);assert.deepEqual(restored.exportState(),before);
 assert.equal(Object.hasOwn(restored.exportState().open[0],'recovered'),false,'recovery annotation is a view field, not a ledger rewrite');
});

test('CLOSE with a forward book cancels an entry remainder before any further limit fill and saves once',()=>{
 let saves=0;const {engine,tick,market,setNow,getNow}=setup({save:()=>{saves++}});
 const key=signal().key;
 engine.register(signal(),{dataSource:'SYNTHETIC_FIXTURE',orderType:'LIMIT',limitPrice:99.5});tick();
 tick(99.49,99.5,{bids:[[99.49,1000]],asks:[[99.5,.2]]});
 const partial=engine.snapshot();assert.equal(partial.open.length,1);assert.equal(partial.pending.length,1);
 closeEnough(partial.open[0].quantityOriginal,.2,'initial partial entry');
 const priorSaves=saves;setNow(getNow()+1);
 assert.equal(engine.closePosition(key,market(99.49,99.5)),true);
 const closed=engine.snapshot();assert.equal(saves-priorSaves,1,'close intent and accounting are a single durable transaction');
 assert.equal(closed.pending.length,0);assert.equal(closed.open.length,0);assert.equal(closed.closed.length,1);
 closeEnough(closed.closed[0].quantityOriginal,.2,'CLOSE does not accidentally buy the rest of the entry order');
 assert.equal(closed.closed[0].entryParts.length,1);assert.equal(closed.closed[0].exitParts.length,1);
 assert.equal(closed.closed[0].exitParts[0].type,'CLOSE');closeEnough(closed.closed[0].exitParts[0].quantity,.2,'only pre-existing quantity is closed');
 assert.equal(closed.events.filter(event=>event.type==='ENTRY_PARTIAL').length,0);
});
