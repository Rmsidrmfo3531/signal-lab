// Review of branch real-safety-fixes-1123 (signal-reviewer, 2026-11-23): regressions found on top of the audit fixes.
// Everything runs on in-memory fakes; no request leaves the process.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {placeMakerThenMarket,makerChildIds} from '../maker_order.mjs';
import {CopyExecutor,copyConfig} from '../copy_executor.mjs';
import {RealTrailingManager} from '../real_trailing.mjs';
import {AccountAlerts} from '../account_alerts.mjs';

const tmp=()=>fs.mkdtempSync(path.join(os.tmpdir(),'sl-review-'));
const fastSleep=ms=>new Promise(r=>setTimeout(r,Math.min(Number(ms)||0,5)));
const OPEN='📌 포지션 진입\n━━━━━━━━━━━━━━━━\n🪙 TNSRUSDT  🔴 Short  ×5\n━━━━━━━━━━━━━━━━\n진입가　0.05100 USDT\n현재가　0.05100 USDT\n수량　　880　마진 9.01 USDT\n손익　　🟢 +1.72 USDT';
const CHANGE=(a,b)=>`📊 포지션 변경\n━━━━━━━━━━━━━━━━\n🪙 TNSRUSDT  🔴 Short\n━━━━━━━━━━━━━━━━\n수량　　${a} → ${b}\n현재가　0.05100 USDT\n손익　　🔴 -0.51 USDT`;
const contract={symbol:'TNSRUSDT',venueSymbol:'TNSR-USDT',tickSize:'0.00001',quantityStep:'1',minQuantityBase:'1',minNotionalUSDT:2,tradable:true};

// A BingX-like fake: orders by clientOrderId, a short TNSR position, switchable network.
function bingx({onLimit=null,onMarket=null}={}){
 const orders=new Map(),sent=[],cancels=[];let size=0,net=true,id=1;
 const down=()=>{throw Object.assign(Error('fetch failed'),{code:'NETWORK_UNREACHABLE'})};
 const client={
  leverage:async()=>({maxLongLeverage:20,maxShortLeverage:20}),setMarginType:async()=>({}),setLeverage:async()=>({}),
  positions:async()=>size>0?[{symbol:'TNSR-USDT',positionAmt:String(-size),avgPrice:'0.051',markPrice:'0.051',unrealizedProfit:'0'}]:[],
  async placeOrder(p){sent.push({...p});
   if(p.type==='LIMIT'){const o={orderId:String(id++),clientOrderId:p.clientOrderId,status:'NEW',executedQty:'0',avgPrice:'0'};orders.set(p.clientOrderId,o);onLimit?.(o,p,api);return {order:{...o}}}
   if(onMarket){const r=onMarket(p);if(r)return r}
   const q=Number(p.quantity);size=p.reduceOnly?Math.max(0,size-q):size+q;
   const o={orderId:String(id++),clientOrderId:p.clientOrderId,status:'FILLED',executedQty:p.quantity,avgPrice:'0.051'};orders.set(p.clientOrderId,o);return {order:{...o}}},
  async getOrder(s,q){if(!net)down();const o=orders.get(q.clientOrderId);if(!o)throw Object.assign(Error('order not exist'),{code:'VENUE_ERROR_80016'});return {order:{...o}}},
  async cancelOrder(s,orderId,{clientOrderId}={}){if(!net)down();cancels.push({orderId,clientOrderId});
   for(const o of orders.values())if((o.orderId===orderId||o.clientOrderId===clientOrderId)&&['NEW','PARTIALLY_FILLED'].includes(o.status))o.status='CANCELED';return {}},
  openOrders:async()=>[],forceOrders:async()=>[],allOrders:async()=>[],
 };
 const api={client,orders,sent,cancels,addSize(q){size+=q},get size(){return size},set net(v){net=v}};
 return api;
}

// ---- maker_order ----------------------------------------------------------------------------------------
test('maker remainder: float subtraction never drops a quantity step (0.3 - 0.1 sends 0.2, 10 - 9.9 sends 0.1)',async()=>{
 for(const [qty,made,step,want] of [[0.3,0.1,'0.1','0.2'],[10,9.9,'0.1','0.1'],[0.003,0.001,'0.001','0.002']]){
  const sent=[];let cancelled=false;
  const client={
   async placeOrder(p){sent.push({...p});return p.type==='LIMIT'?{order:{orderId:'L',status:'NEW',executedQty:'0'}}:{order:{orderId:'M',status:'FILLED',executedQty:p.quantity,avgPrice:'100'}}},
   async getOrder(){return {order:{orderId:'L',status:cancelled?'CANCELED':'PARTIALLY_FILLED',executedQty:String(made),avgPrice:'100'}}},
   async cancelOrder(){cancelled=true;return {}},
  };
  const r=await placeMakerThenMarket({client,symbol:'X-USDT',side:'BUY',positionSide:'BOTH',quantity:qty,quantityStep:step,tickSize:'0.1',markPrice:100,
   clientOrderId:'f',waitMs:10,pollMs:50,sleep:fastSleep});
  assert.equal(sent.find(o=>o.type==='MARKET')?.quantity,want,`${qty} - ${made}`);
  assert.equal(r.executionMode,'HYBRID');
 }
});

test('maker: a PostOnly placement with an unclear answer (HTTP 5xx) is never followed by a full MARKET order',async()=>{
 const sent=[];
 const client={
  async placeOrder(p){sent.push({...p});if(p.type==='LIMIT')throw Object.assign(Error('bad gateway'),{code:'HTTP_502'});return {order:{orderId:'M',status:'FILLED',executedQty:p.quantity}}},
  async getOrder(){return null},async cancelOrder(){return {}},
 };
 await assert.rejects(placeMakerThenMarket({client,symbol:'X-USDT',side:'BUY',positionSide:'BOTH',quantity:1,quantityStep:'0.1',tickSize:'0.1',markPrice:100,
  clientOrderId:'g',waitMs:10,pollMs:50,sleep:fastSleep}),e=>e.code==='HTTP_502');
 assert.equal(sent.filter(o=>o.type==='MARKET').length,0,'the PostOnly order may rest: no market order on top of it');
 // A venue error code is a refusal: the market fallback stays.
 const sent2=[];
 const client2={...client,async placeOrder(p){sent2.push({...p});if(p.type==='LIMIT')throw Object.assign(Error('post only'),{code:'VENUE_ERROR_101415'});return {order:{orderId:'M',status:'FILLED',executedQty:p.quantity}}}};
 assert.equal((await placeMakerThenMarket({client:client2,symbol:'X-USDT',side:'BUY',positionSide:'BOTH',quantity:1,quantityStep:'0.1',tickSize:'0.1',markPrice:100,
  clientOrderId:'g',waitMs:10,pollMs:50,sleep:fastSleep})).executionMode,'MARKET');
});

test('maker: when the remainder is refused after a partial PostOnly fill, the filled part is reported (not thrown away)',async()=>{
 const sent=[];let cancelled=false;
 const client={
  async placeOrder(p){sent.push({...p});if(p.type==='LIMIT')return {order:{orderId:'L',status:'NEW',executedQty:'0'}};
   throw Object.assign(Error('The minimum order value is 2 USDT'),{code:'VENUE_ERROR_101400'})},
  async getOrder(){return {order:{orderId:'L',status:cancelled?'CANCELED':'PARTIALLY_FILLED',executedQty:'170',avgPrice:'0.051'}}},
  async cancelOrder(){cancelled=true;return {}},
 };
 const r=await placeMakerThenMarket({client,symbol:'TNSR-USDT',side:'SELL',positionSide:'BOTH',quantity:200,quantityStep:'1',minQuantity:1,tickSize:'0.00001',markPrice:0.051,
  clientOrderId:'h',waitMs:10,pollMs:50,sleep:fastSleep});
 assert.equal(r.makerQty,170);assert.equal(r.filledQty,170);assert.equal(r.marketQty,0);
 assert.equal(r.marketError,'VENUE_ERROR_101400');
});

// ---- copy MAKER_FIRST ledger -----------------------------------------------------------------------------
const makerCopy=(v,dir=null,extra={})=>new CopyExecutor({config:copyConfig({COPY_SIZING:'FIRST_1USD',COPY_MAKER_FIRST:'on'},'TESTNET'),client:v.client,
 contractOf:async()=>contract,markOf:async()=>0.051,balance:async()=>({equity:400,available:300}),now:()=>1e12,sleep:fastSleep,retryDelaysMs:[1],directory:dir,...extra});

test('copy MAKER_FIRST: a partial PostOnly fill whose remainder is refused stays in the ledger (no untracked position)',async()=>{
 const v=bingx({onLimit:(o,p,api)=>{o.status='PARTIALLY_FILLED';o.executedQty='70';api.addSize(70)},
  onMarket:p=>{if(!p.reduceOnly)throw Object.assign(Error('The minimum order value is 2 USDT'),{code:'VENUE_ERROR_101400'})}});
 const ex=makerCopy(v);
 const r=await ex.handle({id:1,date:1e12,text:OPEN});
 assert.equal(v.size,70,'70 coins are held on the venue');
 assert.equal(r.ok,true,JSON.stringify(r));
 const p=ex.status().positions[0];
 assert.ok(p,'the filled part is in the ledger');assert.equal(p.qty,70);
});

test('copy MAKER_FIRST (open point i): a PostOnly child left resting after MAKER_STATE_UNCONFIRMED is cancelled, never booked closed while it rests',async()=>{
 const v=bingx({onLimit:(o,p,api)=>{api.net=false}});
 const ex=makerCopy(v);
 // The network drops right after the PostOnly order is placed: no read, no cancel.
 const r=await ex.handle({id:1,date:1e12,text:OPEN}).catch(e=>({error:e.code}));
 assert.ok(r.error==='MAKER_STATE_UNCONFIRMED'||r.ok===false,JSON.stringify(r));
 const limit=v.sent.find(o=>o.type==='LIMIT');
 assert.equal(v.orders.get(limit.clientOrderId).status,'NEW','the PostOnly child rests');
 assert.equal(v.sent.filter(o=>o.type==='MARKET').length,0);
 v.net=true;
 await ex.reconcile();await ex.reconcile();
 assert.ok(v.cancels.some(c=>c.clientOrderId===limit.clientOrderId||c.orderId===v.orders.get(limit.clientOrderId).orderId),'the resting child is cancelled');
 assert.equal(v.orders.get(limit.clientOrderId).status,'CANCELED');
 assert.ok(!ex.store.closed.some(p=>p.steps?.[0]?.kind==='ENTRY_UNVERIFIED'),'not booked as an unverified closed trade while it rested');
 await ex.reconcile();await ex.reconcile();
 assert.equal(ex.status().positions.length,0,'dropped once the venue confirms it never filled');
 assert.ok(ex.status().events.some(e=>e.type==='ENTRY_NOT_FILLED'));
});

test('copy MAKER_FIRST: an entry whose PostOnly child still rests is kept (ENTRY_ORDER_RESTING) even when it was never noted',async()=>{
 const v=bingx({onLimit:(o,p,api)=>{api.net=false}});
 const ex=makerCopy(v);
 await ex.handle({id:1,date:1e12,text:OPEN}).catch(()=>null);
 const limit=v.sent.find(o=>o.type==='LIMIT');
 ex.store.makerUnsettled=[]; // as after a crash before the note reached the disk
 v.net=true;
 await ex.reconcile();await ex.reconcile(); // venue empty twice -> #gone: the child rests -> kept, noted
 assert.equal(ex.status().positions.length,1,'kept while the entry order rests');
 assert.ok(ex.status().events.some(e=>e.type==='ENTRY_ORDER_RESTING'));
 assert.equal(ex.store.closed.length,0);
 await ex.reconcile(); // cancelled
 assert.equal(v.orders.get(limit.clientOrderId).status,'CANCELED');
 await ex.reconcile();await ex.reconcile();
 assert.equal(ex.status().positions.length,0);assert.equal(ex.store.closed.length,0,'never booked as a closed trade');
});

test('copy MAKER_FIRST: a resting add child (state unconfirmed) is cancelled by the next reconcile',async()=>{
 let dropNet=false;
 const v=bingx({onLimit:(o,p,api)=>{if(dropNet){api.net=false;return}o.status='FILLED';o.executedQty=p.quantity;api.addSize(Number(p.quantity))}});
 const ex=makerCopy(v);
 assert.equal((await ex.handle({id:1,date:1e12,text:OPEN})).ok,true);
 // The add: PostOnly placed, then the network drops (no read, no cancel).
 dropNet=true;
 await ex.handle({id:2,date:1e12+1000,text:CHANGE(880,1760)}).catch(()=>null);
 const addLimit=v.sent.filter(o=>o.type==='LIMIT').at(-1);
 assert.equal(v.orders.get(addLimit.clientOrderId).status,'NEW');
 assert.equal(v.sent.filter(o=>o.type==='MARKET').length,0);
 v.net=true;
 await ex.reconcile();
 assert.equal(v.orders.get(addLimit.clientOrderId).status,'CANCELED','the resting add child is cancelled');
});

test('copy MAKER_FIRST: the maker child ids are on disk before the PostOnly order is sent',async()=>{
 const dir=tmp();
 try{
  let onDisk=null;
  const v=bingx({onLimit:(o,p,api)=>{const saved=JSON.parse(fs.readFileSync(path.join(dir,'copy-store.json'),'utf8'));
   onDisk=Object.values(saved.positions||{})[0]?.makerCids??null;o.status='FILLED';o.executedQty=p.quantity;api.addSize(Number(p.quantity))}});
  const ex=makerCopy(v,dir);
  await ex.handle({id:1,date:1e12,text:OPEN}).catch(()=>null);
  const limit=v.sent.find(o=>o.type==='LIMIT');
  assert.ok(Array.isArray(onDisk)&&onDisk.some(cid=>makerChildIds(cid).limit===limit.clientOrderId),'saved before sending');
 }finally{fs.rmSync(dir,{recursive:true,force:true})}
});

// ---- real trailing ---------------------------------------------------------------------------------------
const tpos=over=>({symbol:'BTCUSDT',venueSymbol:'BTC-USDT',direction:'LONG',origin:'manual',size:0.02,avg:100000,leverage:10,roePct:20,unrealized:20,...over});

test('real trailing: one empty venue list keeps the state and the exchange stops (no second partial, no stop removed)',async()=>{
 const calls=[];const exec=async a=>{calls.push(a);return {ok:true,orderId:'O'+calls.length,stopPrice:a.stopPrice??100100}};
 let t=1_000_000;
 const m=new RealTrailingManager({now:()=>t,executeAction:exec});
 m.configure({enabled:true,applyToManual:true});
 await m.evaluate([tpos({roePct:20})],t); // net 19 -> 50 % partial + break-even stop
 assert.deepEqual(calls.map(c=>c.action),['CLOSE_HALF','BREAKEVEN_STOP']);
 t+=15_000;await m.evaluate([],t); // a venue list that came back empty for a moment
 assert.equal(calls.filter(c=>c.action==='CANCEL_STOP').length,0,'stops kept after one empty list');
 t+=15_000;await m.evaluate([tpos({roePct:20,size:0.01})],t);
 assert.equal(calls.filter(c=>c.action==='CLOSE_HALF').length,1,'no second partial');
 t+=15_000;await m.evaluate([],t);t+=15_000;await m.evaluate([],t);
 // two empty lists in a row: gone; the break-even stop (O2) and the lock stop placed meanwhile (O3) are cancelled
 assert.deepEqual(calls.filter(c=>c.action==='CANCEL_STOP').map(c=>c.orderId).sort(),['O2','O3']);
 assert.equal(m.status().tracked['BTCUSDT|LONG'],undefined);
});

test('real trailing: an old lock stop whose cancel failed is remembered and cancelled when the position is gone',async()=>{
 const calls=[];let n=0;
 const exec=async a=>{calls.push(a);if(a.action==='TRAIL_STOP'){n++;return {ok:true,orderId:'T'+n,stopPrice:a.stopPrice,...(a.replaceOrderId?{staleOrderId:a.replaceOrderId}:{})}}return {ok:true}};
 let t=1_000_000;
 const m=new RealTrailingManager({now:()=>t,executeAction:exec});
 m.configure({enabled:true,applyToManual:true,partialClosePct:0,autoBreakeven:false});
 await m.evaluate([tpos({roePct:22})],t);
 t+=15_000;await m.evaluate([tpos({roePct:26})],t); // moved: T2 placed, T1 cancel failed (stale)
 t+=15_000;await m.evaluate([],t);t+=15_000;await m.evaluate([],t);
 assert.deepEqual(calls.filter(c=>c.action==='CANCEL_STOP').map(c=>c.orderId).sort(),['T1','T2']);
});

test('real trailing: a failed lock-stop placement does not hold back the exit check',async()=>{
 const calls=[];
 const exec=async a=>{calls.push(a);if(a.action==='TRAIL_STOP')return {ok:false,error:'VENUE_ERROR_X'};return {ok:true}};
 let t=1_000_000;
 const m=new RealTrailingManager({now:()=>t,executeAction:exec});
 m.configure({enabled:true,applyToManual:true,partialClosePct:0,autoBreakeven:false});
 await m.evaluate([tpos({roePct:31})],t); // net 30: lock stop tried (fails)
 assert.equal(calls.at(-1).action,'TRAIL_STOP');
 t+=5_000;const a=await m.evaluate([tpos({roePct:10})],t); // net 9 <= lock 21: exits now, not 15 s later
 assert.deepEqual(a.map(x=>x.action),['CLOSE_ALL']);
});

// ---- Telegram /resume (open point ii) ----------------------------------------------------------------------
test('Telegram /resume: the confirmation says that an active copy cooldown will be released',async()=>{
 const a=new AccountAlerts({allowedChatId:'1',now:()=>1795000000000,onResume:async()=>({ok:true}),
  onControls:async()=>({controls:{cooldownActive:true,cooldownUntil:1795000000000+3600000,cooldownReason:'연속 손실 3회'},traderBalanceUSD:9000})});
 const r=await a.handleCommand('/resume','1',1795000000000);
 assert.match(r,/휴식[\s\S]*해제/);
});

test('real trailing: switched off while a lock stop rests, the stop is still cancelled once the position is gone',async()=>{
 const calls=[];const exec=async a=>{calls.push(a);return {ok:true,orderId:'O'+calls.length,stopPrice:a.stopPrice}};
 let t=1_000_000;
 const m=new RealTrailingManager({now:()=>t,executeAction:exec});
 m.configure({enabled:true,applyToManual:true,partialClosePct:0,autoBreakeven:false});
 await m.evaluate([tpos({roePct:22})],t);
 assert.deepEqual(calls.map(c=>c.action),['TRAIL_STOP']);
 m.configure({enabled:false});
 t+=15_000;assert.deepEqual(await m.evaluate([tpos({roePct:5})],t),[],'no action while off (the stop stays as protection)');
 assert.equal(calls.length,1);
 t+=15_000;await m.evaluate([],t);t+=15_000;await m.evaluate([],t);
 assert.deepEqual(calls.at(-1),{action:'CANCEL_STOP',venueSymbol:'BTC-USDT',orderId:'O1'},'orphan closePosition stop removed');
 assert.equal(m.status().tracked['BTCUSDT|LONG'],undefined);
});
