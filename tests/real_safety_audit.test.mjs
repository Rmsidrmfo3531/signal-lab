// Regression tests for the real-money audit of 2026-11-23 (signal-reviewer R1-R4, C-1..C-5) and the user decisions
// of the same day: (a) real trailing off for manual positions by default, (b) a 1x trader-quantity copy match capped
// at COPY_MIN_ORDER_MAX_MARGIN_USD with adds back on the ratio, (c) Telegram /resume and /size need /confirm and
// /resume never releases the copy loss-limit stop. Everything runs on in-memory fakes; no request leaves the process.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {RealAccountGuard,copyRearmable,copyRearmOnBoot,kstDay} from '../real_safety.mjs';
import {RealTrailingManager,feeNetBreakevenPrice,priceForNetRoe} from '../real_trailing.mjs';
import {placeMakerThenMarket,makerChildIds} from '../maker_order.mjs';
import {CopyExecutor,copyConfig} from '../copy_executor.mjs';
import {executeRealManualOrder} from '../real_manual_trade.mjs';
import {AccountAlerts} from '../account_alerts.mjs';

const tmp=()=>fs.mkdtempSync(path.join(os.tmpdir(),'sl-audit-'));
const fastSleep=ms=>new Promise(r=>setTimeout(r,Math.min(Number(ms)||0,5)));

// ---- R1: daily loss circuit breaker -------------------------------------------------------------------
const OPEN='📌 포지션 진입\n━━━━━━━━━━━━━━━━\n🪙 TNSRUSDT  🔴 Short  ×5\n━━━━━━━━━━━━━━━━\n진입가　0.05296 USDT\n현재가　0.05100 USDT\n수량　　880　마진 9.01 USDT\n손익　　🟢 +1.72 USDT';
const OPEN_B='📌 포지션 진입\n━━━━━━━━━━━━━━━━\n🪙 TNSRUSDT  🟢 Long  ×5\n━━━━━━━━━━━━━━━━\n진입가　0.05296 USDT\n현재가　0.05100 USDT\n수량　　880　마진 9.01 USDT\n손익　　🟢 +1.72 USDT';
const CHANGE=(a,b)=>`📊 포지션 변경\n━━━━━━━━━━━━━━━━\n🪙 TNSRUSDT  🔴 Short\n━━━━━━━━━━━━━━━━\n수량　　${a} → ${b}\n현재가　0.05300 USDT\n손익　　🔴 -0.51 USDT`;
const CLOSE='✅ 포지션 청산\n━━━━━━━━━━━━━━━━\n🪙 TNSRUSDT  🔴 Short\n━━━━━━━━━━━━━━━━\n진입가　0.05296 USDT\n최종손익　🟢 +1.72 USDT';
const contract={symbol:'TNSRUSDT',venueSymbol:'TNSR-USDT',tickSize:'0.00001',quantityStep:'1',minQuantityBase:'1',minNotionalUSDT:2,tradable:true};
function venue(){
 const calls=[];let size=0,avg=0,id=1;
 const client={
  leverage:async()=>({maxLongLeverage:20}),setMarginType:async()=>({}),setLeverage:async()=>({}),
  positions:async()=>size>0?[{symbol:'TNSR-USDT',positionAmt:String(-size),avgPrice:String(avg),markPrice:'0.053',unrealizedProfit:'-0.1'}]:[],
  placeOrder:async p=>{calls.push({...p});
   if(p.type==='MARKET'){const q=Number(p.quantity);if(p.reduceOnly){size=Math.max(0,+(size-q).toFixed(6))}else{avg=size?(avg*size+0.053*q)/(size+q):0.051;size=+(size+q).toFixed(6)}}
   return {order:{orderId:String(id++),avgPrice:'0.051'}}},
  cancelOrder:async()=>({})};
 return {client,calls,get size(){return size}};
}

test('R1 breaker: while tripped the copy refuses new entries and adds (closes still go through), arm() is refused, and re-arm rules hold',async()=>{
 const dir=tmp();
 try{
  let t=Date.parse('2026-11-23T03:00:00Z');const day=kstDay(t);
  const guard=new RealAccountGuard({directory:dir,now:()=>t});guard.configure({dailyLossLimitPct:8});
  const v=venue();
  const ex=new CopyExecutor({config:copyConfig({COPY_SIZING:'FIRST_1USD'},'TESTNET'),client:v.client,contractOf:async()=>contract,directory:dir,
   balance:async()=>({equity:3000,available:2500}),now:()=>1e12,breaker:()=>guard.isTripped()?'DAILY_LOSS_CIRCUIT_BREAKER':null});
  ex.arm();
  assert.equal((await ex.handle({id:1,date:1e12,text:OPEN})).ok,true);const held=v.size;assert.ok(held>0);
  // -250 on 3,000 equity (-8.3 %) trips the -8 % breaker.
  assert.equal((await guard.evaluateDailyLoss({equityUSD:3000,dailyByDay:{[day]:-250},positions:[]})).newlyTripped,true);
  assert.equal(ex.status().breaker,'DAILY_LOSS_CIRCUIT_BREAKER');
  // An add is refused (not sent) ...
  const add=await ex.handle({id:2,date:1e12+1000,text:CHANGE(880,1760)});
  assert.equal(add.reason,'DAILY_LOSS_CIRCUIT_BREAKER');assert.equal(v.size,held);
  // ... and so is a new entry on the other side.
  const other=await ex.handle({id:3,date:1e12+2000,text:OPEN_B});
  assert.equal(other.reason,'DAILY_LOSS_CIRCUIT_BREAKER');
  assert.equal(v.calls.filter(c=>c.type==='MARKET'&&!c.reduceOnly).length,1,'only the entry before the trip was sent');
  // Arming (screen, Telegram /resume, post-update re-arm) is refused while it holds.
  assert.throws(()=>ex.arm(),e=>e.code==='DAILY_LOSS_CIRCUIT_BREAKER'&&e.httpStatus===409);
  // A trader close still closes ours.
  await ex.handle({id:4,date:1e12+3000,text:CLOSE});
  assert.equal(v.size,0,'close goes through while the breaker holds');
  // Re-arm decisions for the update marker / boot.
  assert.equal(copyRearmable({copyEnabled:true,breakerTripped:true}),false);
  assert.equal(copyRearmable({copyEnabled:true,userPaused:true}),false);
  assert.equal(copyRearmable({copyEnabled:true,killed:true}),false);
  assert.equal(copyRearmable({copyEnabled:true}),true);
  const marker={at:1000,copyArmed:true,copyMode:'LIVE'};
  assert.equal(copyRearmOnBoot({marker,now:2000,copyMode:'LIVE',copyEnabled:true}),true);
  assert.equal(copyRearmOnBoot({marker,now:2000,copyMode:'LIVE',copyEnabled:true,breakerTripped:true}),false,'never while the breaker holds');
  assert.equal(copyRearmOnBoot({marker,now:2000,copyMode:'LIVE',copyEnabled:true,userPaused:true}),false,'never after a user pause');
  assert.equal(copyRearmOnBoot({marker:{...marker,copyArmed:false},now:2000,copyMode:'LIVE',copyEnabled:true}),false);
  assert.equal(copyRearmOnBoot({marker,now:1000+16*60000,copyMode:'LIVE',copyEnabled:true}),false,'15-minute window');
  // The next KST day the breaker is gone and arming works again.
  t+=24*3600000;assert.equal(ex.breakerReason(),null);assert.equal(ex.arm().armed,true);
 }finally{fs.rmSync(dir,{recursive:true,force:true})}
});

test('R1 user pause: disarm({user:true}) is kept on disk (no re-arm after an update restart) until the user arms again',()=>{
 const dir=tmp();
 try{
  const mk=()=>new CopyExecutor({config:copyConfig({},'TESTNET'),client:venue().client,contractOf:async()=>contract,directory:dir,now:()=>1e12});
  let ex=mk();ex.arm();ex.disarm();assert.equal(ex.store.userPaused,false,'a non-user disarm (breaker, update) is not a pause');
  ex.disarm({user:true});ex=mk();assert.equal(ex.store.userPaused,true);assert.equal(ex.status().userPaused,true);
  ex.arm();ex=mk();assert.equal(ex.store.userPaused,false);
 }finally{fs.rmSync(dir,{recursive:true,force:true})}
});

// ---- R2 / C-1: maker-first double fill -----------------------------------------------------------------
test('R2 maker-first: when cancel and the reads fail, nothing is sent at market (MAKER_STATE_UNCONFIRMED)',async()=>{
 const sent=[];let reads=0;
 const client={
  async placeOrder(p){sent.push({...p});return {order:{orderId:'L1',status:'NEW',executedQty:'0'}}},
  async getOrder(){reads++;if(reads<=2)return {order:{orderId:'L1',status:'NEW',executedQty:'0'}};throw Object.assign(Error('timeout'),{code:'NETWORK_UNREACHABLE'})},
  async cancelOrder(){throw Object.assign(Error('timeout'),{code:'NETWORK_UNREACHABLE'})},
 };
 await assert.rejects(placeMakerThenMarket({client,symbol:'ETH-USDT',side:'BUY',positionSide:'BOTH',quantity:1,quantityStep:0.01,
  tickSize:0.01,markPrice:100,clientOrderId:'x',waitMs:100,pollMs:50,sleep:fastSleep}),e=>e.code==='MAKER_STATE_UNCONFIRMED'&&e.makerOrderId==='L1');
 assert.equal(sent.filter(o=>o.type==='MARKET').length,0,'no market order while the PostOnly order may rest');
});

test('R2 maker-first: a cancel confirmed only on a later re-query sends exactly the confirmed remainder',async()=>{
 const sent=[];let cancels=0,reads=0;
 const client={
  async placeOrder(p){sent.push({...p});return p.type==='LIMIT'?{order:{orderId:'L1',status:'NEW',executedQty:'0'}}:{order:{orderId:'M1',status:'FILLED',executedQty:p.quantity,avgPrice:'100.2'}}},
  // NEW until the cancel, then one stale NEW answer, then CANCELED with 0.3 filled.
  async getOrder(sym,q){reads++;assert.equal(q.clientOrderId,'xp');if(!cancels)return {order:{orderId:'L1',status:'NEW',executedQty:'0'}};
   return cancels===1&&reads%2?{order:{orderId:'L1',status:'NEW',executedQty:'0.3'}}:{order:{orderId:'L1',status:'CANCELED',executedQty:'0.3',avgPrice:'99.9'}}},
  async cancelOrder(){cancels++;return {}},
 };
 const r=await placeMakerThenMarket({client,symbol:'ETH-USDT',side:'BUY',positionSide:'BOTH',quantity:1,quantityStep:0.01,
  tickSize:0.01,markPrice:100,clientOrderId:'x',waitMs:60,pollMs:50,sleep:fastSleep});
 const markets=sent.filter(o=>o.type==='MARKET');
 assert.equal(markets.length,1);assert.equal(markets[0].quantity,'0.7');assert.equal(markets[0].clientOrderId,'xm');
 assert.equal(r.executionMode,'HYBRID');assert.equal(r.makerQty,0.3);
});

test('R2 maker-first: a placement answer without an orderId is still read back by clientOrderId before any market order',async()=>{
 const sent=[];
 const client={
  async placeOrder(p){sent.push({...p});return p.type==='LIMIT'?{}:{order:{orderId:'M1',status:'FILLED',executedQty:p.quantity}}},
  async getOrder(sym,q){return {order:{orderId:'L9',clientOrderId:q.clientOrderId,status:'FILLED',executedQty:'1',avgPrice:'99.9'}}},
  async cancelOrder(){throw Error('must not cancel a filled order')},
 };
 const r=await placeMakerThenMarket({client,symbol:'ETH-USDT',side:'BUY',positionSide:'BOTH',quantity:1,quantityStep:0.01,
  tickSize:0.01,markPrice:100,clientOrderId:'y',waitMs:60,pollMs:50,sleep:fastSleep});
 assert.equal(sent.filter(o=>o.type==='MARKET').length,0,'the full quantity had filled as maker');
 assert.equal(r.executionMode,'MAKER');assert.equal(r.makerOrderId,'L9');
});

// ---- R4 / C-2: copy MAKER_FIRST clientOrderIds --------------------------------------------------------
test('R4 maker child ids: a 32-character copy id gives distinct 32-character limit and market ids',async()=>{
 const cid=('cp'+createHash('sha256').update('BTCUSDT|LONG|1|open.1').digest('hex')).slice(0,32);
 const k=makerChildIds(cid);
 assert.notEqual(k.limit,k.market);assert.equal(k.limit.length,32);assert.equal(k.market.length,32);
 assert.equal(k.limit,cid.slice(0,31)+'p');assert.equal(k.market,cid.slice(0,31)+'m');
 const sent=[];let reads=0;
 const client={
  async placeOrder(p){sent.push({...p});return p.type==='LIMIT'?{order:{orderId:'L1',status:'NEW',executedQty:'0'}}:{order:{orderId:'M1',status:'FILLED',executedQty:p.quantity,avgPrice:'100'}}},
  async getOrder(){reads++;return {order:{orderId:'L1',status:reads>2?'CANCELED':'PARTIALLY_FILLED',executedQty:'0.4',avgPrice:'100'}}},
  async cancelOrder(){return {}},
 };
 await placeMakerThenMarket({client,symbol:'BTC-USDT',side:'BUY',positionSide:'BOTH',quantity:1,quantityStep:0.001,tickSize:0.1,
  markPrice:100,clientOrderId:cid,waitMs:100,pollMs:50,sleep:fastSleep});
 assert.equal(sent.length,2);
 assert.notEqual(sent[0].clientOrderId,sent[1].clientOrderId,'maker and market orders carry different clientOrderIds');
});

test('R4 copy MAKER_FIRST: child orders carry their own ids and a lost answer is found through the PostOnly child (no resend)',async()=>{
 const config=copyConfig({COPY_SIZING:'FIRST_1USD',COPY_MAKER_FIRST:'on'},'TESTNET');
 // 1) Normal: PostOnly rests, is cancelled with nothing filled, the market child takes the whole quantity.
 {
  const orders=new Map(),sent=[];let size=0;
  const client={...venue().client,
   positions:async()=>size>0?[{symbol:'TNSR-USDT',positionAmt:String(-size),avgPrice:'0.051',markPrice:'0.051'}]:[],
   async placeOrder(p){sent.push({...p});const o={orderId:String(sent.length),clientOrderId:p.clientOrderId,status:p.type==='LIMIT'?'NEW':'FILLED',executedQty:p.type==='LIMIT'?'0':p.quantity,avgPrice:'0.051'};
    if(p.type==='MARKET')size+=Number(p.quantity);orders.set(p.clientOrderId,o);return {order:o}},
   async getOrder(s,q){const o=orders.get(q.clientOrderId);if(!o)throw Object.assign(Error('order not exist'),{code:'VENUE_ERROR_80016'});return {order:o}},
   async cancelOrder(){for(const o of orders.values())if(o.status==='NEW')o.status='CANCELED';return {}},
  };
  const ex=new CopyExecutor({config,client,contractOf:async()=>contract,markOf:async()=>0.051,balance:async()=>({equity:400,available:300}),now:()=>1e12,sleep:fastSleep});
  assert.equal((await ex.handle({id:1,date:1e12,text:OPEN})).ok,true);
  const limit=sent.find(o=>o.type==='LIMIT'),market=sent.find(o=>o.type==='MARKET');
  assert.ok(limit&&market);assert.notEqual(limit.clientOrderId,market.clientOrderId);
  assert.match(limit.clientOrderId,/^cp[0-9a-f]{29}p$/);assert.match(market.clientOrderId,/^cp[0-9a-f]{29}m$/);
 }
 // 2) The PostOnly placement fills but its answer is lost: the retry finds the fill through the 'p' child, nothing is resent.
 {
  const orders=new Map(),sent=[];let size=0;
  const client={...venue().client,
   positions:async()=>size>0?[{symbol:'TNSR-USDT',positionAmt:String(-size),avgPrice:'0.0511',markPrice:'0.051'}]:[],
   async placeOrder(p){sent.push({...p});if(p.type==='LIMIT'){size+=Number(p.quantity);orders.set(p.clientOrderId,{orderId:'L1',status:'FILLED',executedQty:p.quantity,avgPrice:'0.0511'});
    throw Object.assign(Error('fetch failed'),{code:'NETWORK_UNREACHABLE'})}
    throw Error('no market order expected')},
   async getOrder(s,q){const o=orders.get(q.clientOrderId);if(!o)throw Object.assign(Error('order not exist'),{code:'VENUE_ERROR_80016'});return {order:o}},
   async cancelOrder(){return {}},
  };
  const ex=new CopyExecutor({config,client,contractOf:async()=>contract,markOf:async()=>0.051,balance:async()=>({equity:400,available:300}),now:()=>1e12,
   sleep:fastSleep,retryDelaysMs:[1]});
  const r=await ex.handle({id:1,date:1e12,text:OPEN});
  assert.equal(r.ok,true);
  assert.equal(sent.length,1,'the filled PostOnly order is not sent again');
  assert.ok(ex.status().events.some(e=>e.type==='ENTRY_RETRY'&&e.outcome==='ALREADY_FILLED'));
  assert.equal(ex.status().positions[0].qty,size);
 }
});

// ---- R3 / C-3: real trailing ---------------------------------------------------------------------------
const tpos=over=>({symbol:'BTCUSDT',venueSymbol:'BTC-USDT',direction:'LONG',origin:'manual',size:0.02,avg:100000,leverage:20,roePct:20,unrealized:20,...over});

test('R3a real trailing: manual positions are off by default; a saved applyToManual:true is migrated once to false and logged',async()=>{
 const dir=tmp();
 try{
  const calls=[];const exec=async a=>{calls.push(a);return {ok:true}};
  const fresh=new RealTrailingManager({executeAction:exec});fresh.configure({enabled:true});
  assert.equal(fresh.status().applyToManual,false);
  assert.deepEqual(await fresh.evaluate([tpos({roePct:40})],1e9),[]);assert.equal(calls.length,0);
  fs.writeFileSync(path.join(dir,'real-trailing.json'),JSON.stringify({version:1,enabled:true,applyToManual:true,applyToCopy:false}));
  const logs=[];
  const m=new RealTrailingManager({directory:dir,executeAction:exec,log:(...a)=>logs.push(a.join(' '))});
  assert.equal(m.status().applyToManual,false);assert.ok(logs.some(l=>/MANUAL_DEFAULT_MIGRATED/.test(l)));
  // The user turns it back on from the screen: kept (migrated only once).
  m.configure({applyToManual:true});
  const m2=new RealTrailingManager({directory:dir,executeAction:exec,log:(...a)=>logs.push(a.join(' '))});
  assert.equal(m2.status().applyToManual,true);assert.equal(logs.filter(l=>/MANUAL_DEFAULT_MIGRATED/.test(l)).length,1);
 }finally{fs.rmSync(dir,{recursive:true,force:true})}
});

test('R3a real trailing: tracking state is persisted, so a restart never takes a second partial; a failed read keeps it',async()=>{
 const dir=tmp();
 try{
  const calls=[];const exec=async a=>{calls.push(a);return {ok:true,stopPrice:100100,orderId:'S'+calls.length}};
  let t=1_000_000;
  const m1=new RealTrailingManager({directory:dir,now:()=>t,executeAction:exec});
  m1.configure({enabled:true,applyToManual:true});
  await m1.evaluate([tpos({roePct:20})],t);
  assert.deepEqual(calls.map(c=>c.action),['CLOSE_HALF','BREAKEVEN_STOP']);
  assert.equal(calls[1].feePct,0.1,'break-even stop asked net of the round-trip fee');
  t+=60_000;
  const m2=new RealTrailingManager({directory:dir,now:()=>t,executeAction:exec});
  assert.equal(m2.status().tracked['BTCUSDT|LONG'].partialTaken,true);
  await m2.evaluate(null,t);
  assert.equal(m2.status().tracked['BTCUSDT|LONG'].partialTaken,true,'a failed read (not an array) does not drop the state');
  await m2.evaluate([tpos({roePct:20,size:0.01})],t);
  assert.equal(calls.filter(c=>c.action==='CLOSE_HALF').length,1,'no second 50 % partial after the restart');
 }finally{fs.rmSync(dir,{recursive:true,force:true})}
});

test('R3b real trailing: a fast drop below the locked level exits (no floor), with an exchange lock stop placed and cleaned up',async()=>{
 const calls=[];
 const exec=async a=>{calls.push(a);if(a.action==='CLOSE_HALF')return {ok:false,error:'HALF_QTY_TOO_SMALL'};if(a.action==='TRAIL_STOP')return {ok:true,orderId:'T'+calls.length,stopPrice:a.stopPrice};return {ok:true}};
 let t=1_000_000;
 const m=new RealTrailingManager({now:()=>t,executeAction:exec});
 m.configure({enabled:true,applyToManual:true});
 await m.evaluate([tpos({roePct:32})],t); // net 30 (fee 2 at 20x): partial refused (too small)
 t+=15_000;const a=await m.evaluate([tpos({roePct:34})],t); // peak 32 -> lock at 32-9.6 = 22.4 net
 assert.deepEqual(a.map(x=>x.action),['TRAIL_STOP']);
 const lock=calls.find(c=>c.action==='TRAIL_STOP');
 // 22.4 net + 2 fee = 24.4 gross at 20x -> +1.22 % -> 101,220
 assert.ok(Math.abs(lock.stopPrice-101220)<1e-6,String(lock.stopPrice));
 t+=15_000;const b=await m.evaluate([tpos({roePct:3})],t); // net 1, far below 22.4 -> exits now
 assert.deepEqual(b.map(x=>x.action),['CLOSE_ALL']);
 assert.deepEqual(calls.map(c=>c.action),['CLOSE_HALF','TRAIL_STOP','CLOSE_ALL','CANCEL_STOP']);
 assert.equal(calls.at(-1).orderId,lock.action==='TRAIL_STOP'?'T2':null);assert.equal(calls.at(-1).venueSymbol,'BTC-USDT');
 assert.equal(m.status().tracked['BTCUSDT|LONG'],undefined);
});

test('R3 real trailing: the lock stop only moves up (new first, old replaced) and stops are cancelled when the position is gone',async()=>{
 const calls=[];const exec=async a=>{calls.push(a);return {ok:true,orderId:'O'+calls.length,stopPrice:a.stopPrice}};
 let t=1_000_000;
 const m=new RealTrailingManager({now:()=>t,executeAction:exec});
 m.configure({enabled:true,applyToManual:true,partialClosePct:0,autoBreakeven:false});
 await m.evaluate([tpos({roePct:22,leverage:10})],t); // net 21 -> lock 21-6.3=14.7
 t+=15_000;await m.evaluate([tpos({roePct:22.5,leverage:10})],t); // net 21.5 -> lock 15.05 (< +1 step): no move
 t+=15_000;await m.evaluate([tpos({roePct:26,leverage:10})],t); // net 25 -> lock 17.5: moved, replacing O1
 const stops=calls.filter(c=>c.action==='TRAIL_STOP');
 assert.equal(stops.length,2);assert.equal(stops[1].replaceOrderId,'O1');assert.ok(stops[1].stopPrice>stops[0].stopPrice);
 t+=15_000;await m.evaluate([],t);
 assert.notEqual(calls.at(-1).action,'CANCEL_STOP','one empty list is not enough (review 2026-11-23)');
 t+=15_000;await m.evaluate([],t);
 assert.deepEqual(calls.at(-1),{action:'CANCEL_STOP',venueSymbol:'BTC-USDT',orderId:'O2'});
});

test('C-3 fee-net break-even and lock prices',()=>{
 assert.equal(+feeNetBreakevenPrice({avg:100,direction:'LONG',feePct:0.1}).toFixed(6),100.1);
 assert.equal(+feeNetBreakevenPrice({avg:100,direction:'SHORT',feePct:0.1}).toFixed(6),99.9);
 assert.equal(+priceForNetRoe({avg:100,direction:'SHORT',leverage:10,netRoePct:15,feeRoePct:1}).toFixed(6),98.4);
 assert.equal(feeNetBreakevenPrice({avg:0,direction:'LONG'}),null);
});

// ---- C-5: manual panel vs copy lane --------------------------------------------------------------------
test('C-5 manual panel: no leverage or margin-mode change under an open copy position (one-way and hedge lanes)',async()=>{
 const BTC={symbol:'BTCUSDT',venueSymbol:'BTC-USDT',tickSize:'0.1',quantityStep:'0.001',minQuantityBase:0.001,minNotionalUSDT:5,tradable:true};
 const mk=({hedge=false}={})=>{const ops=[];return {ops,client:{mode:'LIVE',
  positionMode:async()=>({dualSidePosition:hedge?'true':'false'}),
  balance:async()=>[{asset:'USDT',equity:'3000',availableMargin:'2500'}],
  leverage:async()=>({maxLongLeverage:100,maxShortLeverage:100,longLeverage:10,shortLeverage:10}),
  marginType:async()=>({marginType:'CROSSED'}),
  setMarginType:async(...a)=>{ops.push(['margin',...a]);return {}},setLeverage:async(...a)=>{ops.push(['lev',...a]);return {}},
  placeOrder:async p=>{ops.push(['order',p.type]);return {order:{orderId:'1'}}}}}};
 const base={confirm:'REAL_MANUAL_ORDER',symbol:'BTC',side:'LONG',orderType:'MARKET',amountMode:'MARGIN_USDT',amount:50,marginMode:'CROSSED',
  contractsFor:async()=>new Map([['BTCUSDT',BTC]]),markOf:async()=>100000};
 const copyLong=[{status:'OPEN',symbol:'BTCUSDT',venueSymbol:'BTC-USDT',direction:'LONG',leverage:10,hedge:false,qty:0.002}];
 let v=mk();
 await assert.rejects(executeRealManualOrder({...base,leverage:20,client:v.client,copyPositions:copyLong}),e=>e.code==='COPY_LANE_LEVERAGE'&&e.httpStatus===409&&/카피/.test(e.message));
 assert.deepEqual(v.ops,[],'nothing changed or sent');
 v=mk();
 await assert.rejects(executeRealManualOrder({...base,leverage:10,marginMode:'ISOLATED',client:v.client,copyPositions:copyLong}),e=>e.code==='COPY_LANE_MARGIN_MODE');
 assert.deepEqual(v.ops,[]);
 v=mk();
 assert.equal((await executeRealManualOrder({...base,leverage:10,client:v.client,copyPositions:copyLong})).ok,true);
 assert.deepEqual(v.ops,[['order','MARKET']],'same leverage: order sent without touching leverage or margin mode');
 // Hedge account: the copy holds LONG; a manual SHORT may set its own side's leverage, never the margin mode.
 v=mk({hedge:true});
 assert.equal((await executeRealManualOrder({...base,side:'SHORT',leverage:20,client:v.client,copyPositions:[{...copyLong[0],hedge:true}]})).ok,true);
 assert.deepEqual(v.ops.map(o=>o[0]),['lev','order']);assert.equal(v.ops[0][2],'SHORT');
 // No copy position: unchanged behaviour (leverage set).
 v=mk();
 assert.equal((await executeRealManualOrder({...base,leverage:20,client:v.client,copyPositions:[]})).ok,true);
 assert.deepEqual(v.ops.map(o=>o[0]),['lev','order']);
});

// ---- Telegram (decision c) -----------------------------------------------------------------------------
test('Telegram /resume needs /confirm and never releases the loss-limit stop; the breaker refusal is explained',async()=>{
 let now=1795000000000;const results=[{ok:false,reason:'COPY_LOSS_LIMIT'},{ok:false,reason:'DAILY_LOSS_CIRCUIT_BREAKER'},{ok:true}];let resumed=0;
 const a=new AccountAlerts({allowedChatId:'1',now:()=>now,onResume:async()=>{resumed++;return results.shift()}});
 const code=r=>r.match(/\/confirm (\d{4})/)[1];
 let r=await a.handleCommand('/resume','1',now);assert.equal(resumed,0);assert.match(r,/60초 안/);
 r=await a.handleCommand('/confirm '+code(r),'1',now+1000);assert.equal(resumed,1);assert.match(r,/손실 한도 정지[\s\S]*화면/);
 r=await a.handleCommand('/resume','1',now);r=await a.handleCommand('/confirm '+code(r),'1',now+1000);assert.match(r,/일일 손실 차단/);
 r=await a.handleCommand('/resume','1',now);
 assert.match(await a.handleCommand('/confirm '+code(r),'1',now+61000),/만료/);assert.equal(resumed,2);
 r=await a.handleCommand('/resume','1',now);r=await a.handleCommand('/confirm '+code(r),'1',now+1000);assert.match(r,/재개\(활성화\)/);assert.equal(resumed,3);
});

test('Telegram commands older than the process start or 2 minutes are always dropped (also with a saved offset)',async()=>{
 const dir=tmp();
 try{
  fs.writeFileSync(path.join(dir,'account-alerts.json'),JSON.stringify({version:1,lastUpdateId:500}));
  let now=1795000000000;const boot=now;let paused=0;const updates=[];const replies=[];
  const post=async(payload,{method='sendMessage'}={})=>{
   if(method==='getUpdates')return {ok:true,status:200,headers:{get:()=>null},json:async()=>({ok:true,result:updates.splice(0)})};
   replies.push(payload);return {ok:true,status:200,headers:{get:()=>null},json:async()=>({ok:true,result:{message_id:1}})};
  };
  const a=new AccountAlerts({directory:dir,allowedChatId:'1',post,now:()=>now,onPause:async()=>{paused++}});
  const msg=(id,at,text='/pause')=>({update_id:id,message:{chat:{id:1,type:'private'},date:Math.floor(at/1000),text}});
  updates.push(msg(501,boot-30_000),msg(502,boot-1));
  await a.pollCommands();assert.equal(paused,0,'sent before this process started');
  now=boot+10*60000;
  updates.push(msg(503,boot+5*60000),msg(504,now-150_000),{update_id:505,message:{chat:{id:1},text:'/pause'}});
  await a.pollCommands();assert.equal(paused,0,'older than 2 minutes, or without a date');
  updates.push(msg(506,now-30_000));
  await a.pollCommands();assert.equal(paused,1);
  assert.equal(a.store.lastUpdateId,506,'dropped commands are still consumed');
 }finally{fs.rmSync(dir,{recursive:true,force:true})}
});
