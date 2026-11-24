import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {parseCopyMessage} from '../copy_parser.mjs';
import {CopyExecutor,copyConfig as copyConfigRaw} from '../copy_executor.mjs';
// The copy loss limit is off by default since 2026-11-23 (user "다 없애 필요없어"); these tests exercise it at 50 %.
const copyConfig=(env={},mode)=>copyConfigRaw({COPY_LEDGER_LOSS_PCT:'50',...env},mode);
import {copyEventText} from '../copy_telegram.mjs';

const OPEN='📌 포지션 진입\n━━━━━━━━━━━━━━━━\n🪙 TNSRUSDT  🔴 Short  ×5\n━━━━━━━━━━━━━━━━\n진입가　0.05296 USDT\n현재가　0.05100 USDT\n수량　　880　마진 9.01 USDT\n손익　　🟢 +1.72 USDT';
const CHANGE=(a,b)=>`📊 포지션 변경\n━━━━━━━━━━━━━━━━\n🪙 TNSRUSDT  🔴 Short\n━━━━━━━━━━━━━━━━\n수량　　${a} → ${b}\n현재가　0.05300 USDT\n손익　　🔴 -0.51 USDT`;
const CLOSE='✅ 포지션 청산\n━━━━━━━━━━━━━━━━\n🪙 TNSRUSDT  🔴 Short\n━━━━━━━━━━━━━━━━\n진입가　0.05296 USDT\n최종손익　🟢 +1.72 USDT';

test('parser: both formats, dash quantities, monitor restart',()=>{
 assert.deepEqual(parseCopyMessage(OPEN),{kind:'OPEN',symbol:'TNSRUSDT',direction:'SHORT',leverage:5,entry:.05296,price:.051,quantity:880,marginUSD:9.01});
 assert.deepEqual(parseCopyMessage('포지션 진입\n코인: BTWUSDT\n방향: Long  레버리지: 6X\n진입가: 0.077940 USDT\n현재가: 0.078116 USDT\n수량: 200  마진: 2.61 USDT'),
  {kind:'OPEN',symbol:'BTWUSDT',direction:'LONG',leverage:6,entry:.07794,price:.078116,quantity:200,marginUSD:2.61});
 assert.deepEqual(parseCopyMessage(CHANGE(200,400)),{kind:'CHANGE',symbol:'TNSRUSDT',direction:'SHORT',price:.053,from:200,to:400});
 assert.equal(parseCopyMessage(CHANGE('0.07','-')).to,0);assert.equal(parseCopyMessage(CHANGE('-','0.07')).from,0);
 assert.equal(parseCopyMessage(CLOSE).theirPnlUSD,1.72);
 assert.equal(parseCopyMessage('Gate.io 모니터 시작 (실시간)').kind,'MONITOR_START');
 assert.equal(parseCopyMessage('에바참치 맛있다.'),null);
 assert.equal(parseCopyMessage('📌 포지션 진입\nMUSDT  🟢 Long  ×10\n진입가　0.7367 USDT\n수량　　21').symbol,'MUSDT');
});

function venue({free=500}={}){
 const calls=[];let size=0,avg=0,id=1,failStop=false,failMarket=false,unreal='-0.12';
 const client={
  leverage:async()=>({maxLongLeverage:20}),setMarginType:async()=>({}),setLeverage:async(s,side,l)=>{calls.push({op:'lev',l});return {}},
  positions:async()=>size>0?[{symbol:'TNSR-USDT',positionAmt:String(-size),avgPrice:String(avg),markPrice:'0.053',unrealizedProfit:unreal}]:[],
  placeOrder:async p=>{if(failStop&&p.type==='STOP_MARKET')throw Object.assign(Error('rate'),{code:failStop===true?'HTTP_429':failStop});if(failMarket&&p.type==='MARKET'&&p.reduceOnly)throw Object.assign(Error('rate'),{code:'HTTP_429'});calls.push({op:'order',...p});
   if(p.type==='MARKET'){const q=Number(p.quantity);if(p.reduceOnly){size=Math.max(0,+(size-q).toFixed(6))}else{avg=size?(avg*size+0.053*q)/(size+q):0.051;size=+(size+q).toFixed(6)}}
   return {order:{orderId:String(id++),avgPrice:'0.051'}}},
  cancelOrder:async(s,o)=>{calls.push({op:'cancel',o});return {}}};
 return {client,calls,setSize:v=>{size=v},get size(){return size},set failStop(v){failStop=v},set failMarket(v){failMarket=v},set unreal(v){unreal=v}};
}
const contract={symbol:'TNSRUSDT',venueSymbol:'TNSR-USDT',tickSize:'0.00001',quantityStep:'1',minQuantityBase:'1',minNotionalUSDT:2,tradable:true};
const make=(v,extra={})=>new CopyExecutor({config:{...copyConfig({COPY_SIZING:'FIRST_1USD',COPY_STOPS:'on'},'TESTNET'),...extra.config},client:v.client,contractOf:async()=>contract,
 balance:async()=>({equity:400,available:typeof extra.free==='function'?extra.free():extra.free??300}),isBusy:extra.isBusy??(()=>false),gate:extra.gate??(()=>({ok:true})),now:extra.now??(()=>1e12),auditOrders:extra.auditOrders??false});

test('real copy audit checks startup and orders, locks repeated mismatches and lets protection and closing continue',async()=>{
 const v=venue();let now=1e12,orders=[],positionUnavailable=false;
 const positions=v.client.positions,place=v.client.placeOrder;
 v.client.positions=async(symbol)=>{if(!symbol&&positionUnavailable)throw Error('offline');return positions(symbol)};
 v.client.openOrders=async()=>({orders});
 v.client.placeOrder=async(params,opts)=>{const r=await place(params,opts);if(params.type==='STOP_MARKET')orders=[{...params,orderId:r.order.orderId,status:'NEW'}];return r};
 const ex=make(v,{config:{mode:'LIVE'},auditOrders:true,now:()=>now});ex.goneRecheckMs=0;
 const msg=(id,text)=>ex.handle({id,date:now,text});
 assert.equal((await msg(1,OPEN)).reason,'COPY_AUDIT_UNAVAILABLE');
 await ex.reconcile();assert.equal(ex.auditStatus().ready,true);
 orders=[{symbol:'TNSR-USDT',orderId:'external',positionSide:'BOTH'}];
 assert.equal((await msg(2,OPEN)).reason,'COPY_OPEN_ORDERS_EXIST');
 orders=[];assert.equal((await msg(3,OPEN)).ok,true);
 await ex.reconcile();assert.equal(ex.auditStatus().lanes[0].stop,'OK');
 // Manual first (2026-11-25): 7 more on the lane than our fills is a manual position, so our whole-position stop is
 // replaced by a stop for our own 98 (the old one cancelled); the audit still flags the lane size.
 const stop=orders[0];v.setSize(105);orders=[];
 await ex.reconcile();assert.deepEqual(ex.auditStatus().lanes[0].issues,['SIZE_MISMATCH']);
 const ownStop=orders[0];assert.equal(ownStop.quantity,'98');assert.equal(ownStop.closePosition,undefined);assert.equal(ownStop.reduceOnly,'true');
 assert.equal(ex.auditStatus().lanes[0].blocked,false);
 await ex.reconcile();assert.equal(ex.auditStatus().lanes[0].blocked,true);
 assert.equal(ex.auditStatus().lanes[0].expectedQty,98,'routine display refresh does not accept the different venue size');
 assert.equal((await msg(4,CHANGE(880,1760))).reason,'COPY_AUDIT_BLOCKED');
 assert.equal(v.calls.filter(c=>c.type==='MARKET').length,1);
 v.setSize(98);orders=[ownStop];await ex.reconcile();assert.equal(ex.auditStatus().lanes[0].blocked,false);
 orders=[{...ownStop,side:'SELL'}];await ex.reconcile();assert.equal(ex.auditStatus().lanes[0].stop,'MISMATCH');
 positionUnavailable=true;now+=136000;await ex.reconcile();assert.equal(ex.auditStatus().ready,false);
 assert.equal((await msg(5,CHANGE(1760,3520))).reason,'COPY_AUDIT_UNAVAILABLE');
 positionUnavailable=false;
 let readStarted,releaseRead,timer;
 const reading=new Promise(resolve=>{readStarted=resolve});
 v.client.openOrders=()=>new Promise(resolve=>{releaseRead=resolve;readStarted()});
 const audit=ex.reconcile();await reading;
 try{
  const close=await Promise.race([msg(6,CLOSE),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('audit held the close queue')),1000)})]);
  assert.equal(close.ok,true);assert.equal(v.size,0);
 }finally{clearTimeout(timer);releaseRead({orders});await audit}
 assert.ok(v.calls.some(c=>c.op==='cancel'&&String(c.o)===String(stop.orderId)));
 assert.equal(ex.auditStatus().lanes.length,0,'a concurrent close cannot leave behind a stale open audit result');
});

test('real copy falls back to account open orders and still blocks a matching order or an unreadable list',async()=>{
 const v=venue(),ex=make(v,{config:{mode:'LIVE',stops:false},auditOrders:true});
 const queries=[],other={symbol:'ETH-USDT',orderId:'123',side:'SELL',positionSide:'BOTH'};
 const matching={...other,symbol:'TNSR-USDT',orderId:'456'};
 let account={orders:[other,matching]},scopedError='VENUE_ERROR_109400';
 v.client.openOrders=async symbol=>{
  queries.push(symbol);
  if(symbol)throw Object.assign(Error('scoped query rejected'),{code:scopedError});
  return account;
 };
 const msg=(id,text)=>ex.handle({id,date:1e12,text});
 await ex.reconcile();
 assert.equal((await msg(1,OPEN)).reason,'COPY_OPEN_ORDERS_EXIST');
 account={orders:[{...matching,symbol:'TNSR-USDT '}]};
 assert.equal((await msg(2,OPEN)).reason,'COPY_ORDERS_UNREADABLE');
 assert.equal(ex.status().events[0].detail,'종목 조회 VENUE_ERROR_109400 · 계좌 조회 UNEXPECTED_OPEN_ORDERS');
 account={};
 assert.equal((await msg(3,OPEN)).reason,'COPY_ORDERS_UNREADABLE');
 assert.equal(ex.status().events[0].detail,'종목 조회 VENUE_ERROR_109400 · 계좌 조회 UNEXPECTED_OPEN_ORDERS_SHAPE');
 assert.equal(v.calls.length,0,'a failed verification must not set leverage or place an order');
 scopedError='HTTP_429';queries.length=0;
 assert.equal((await msg(4,OPEN)).reason,'COPY_ORDERS_UNREADABLE');
 assert.deepEqual(queries,['TNSR-USDT'],'the HTTP client already retried rate-limited reads');
 scopedError='NETWORK_UNREACHABLE';queries.length=0;account={orders:[other]};
 assert.equal((await msg(5,OPEN)).ok,true);
 assert.deepEqual(queries,['TNSR-USDT',undefined]);
 await ex.reconcile();
 assert.deepEqual(ex.auditStatus().lanes[0].issues,[]);
 account={orders:[matching]};
 assert.equal((await msg(6,CHANGE(880,1760))).reason,'COPY_AUDIT_BLOCKED');
 account={orders:null};
 assert.equal((await msg(7,CHANGE(1760,2640))).ok,true);
 assert.equal(v.calls.filter(c=>c.type==='MARKET').length,2);
 account=null;
 await ex.reconcile();
 assert.deepEqual(ex.auditStatus().lanes[0].issues,['ORDERS_UNREADABLE']);
 assert.equal(ex.auditStatus().lanes[0].ordersError,'종목 조회 NETWORK_UNREACHABLE · 계좌 조회 UNEXPECTED_OPEN_ORDERS_SHAPE');
});

test('copy: 1 $ margin at the trader leverage (capped by the venue), doubles with the trader, cuts in proportion, closes, protective stop each time',async()=>{
 const v=venue(),ex=make(v);
 await ex.handle({id:1,date:1e12,text:OPEN});
 const open=v.calls.find(c=>c.op==='order'&&c.type==='MARKET');
 // 1 $ x 5x / 0.051 = 98 coins (step 1).
 assert.equal(open.side,'SELL');assert.equal(open.quantity,'98');assert.ok(v.calls.some(c=>c.op==='lev'&&c.l===5));
 const stop=v.calls.find(c=>c.type==='STOP_MARKET');assert.equal(stop.closePosition,'true');assert.equal(stop.side,'BUY');
 // The balance cap (25 % of 400 over 98 coins) would be 20x the price away: the 50 % backstop instead, with the quantity.
 assert.ok(Math.abs(Number(stop.stopPrice)-0.051*1.5)<1e-4,stop.stopPrice);assert.equal(stop.quantity,'98');
 await ex.handle({id:2,date:1e12,text:CHANGE(880,1760)});
 assert.equal(v.size,192,'the trader added as much as its first buy: 1 $ more (5x at 0.053 = 94)');assert.ok(v.calls.some(c=>c.op==='cancel'),'old stop replaced');
 await ex.handle({id:3,date:1e12,text:CHANGE(1760,440)});
 assert.equal(v.size,48,'cut to a quarter');assert.equal(v.calls.filter(c=>c.reduceOnly==='true').length,1);
 await ex.handle({id:3,date:1e12,text:CHANGE(1760,440)});assert.equal(v.size,48,'same message id once');
 await ex.handle({id:4,date:1e12,text:CLOSE});
 assert.equal(v.size,0);const st=ex.status();assert.equal(st.positions.length,0);assert.equal(st.closed[0].closeReason,'TRADER_CLOSE');assert.equal(st.closed[0].theirPnlUSD,1.72);
 assert.equal(new Set(v.calls.filter(c=>c.clientOrderId).map(c=>c.clientOrderId)).size,v.calls.filter(c=>c.clientOrderId).length,'every order has its own client id');
});

test('copy: a partial full-close keeps the stop and an unresolved order is looked up before another close',async()=>{
 const v=venue(),ex=make(v,{config:{mode:'LIVE'}});ex.goneRecheckMs=0;
 await ex.handle({id:1,date:1e12,text:OPEN});
 const stop=ex.status().positions[0].stopOrderId,send=v.client.placeOrder;
 let attempts=0,terminal=false;
 v.client.getOrder=async()=>({order:{orderId:'999',status:terminal?'CANCELED':'PARTIALLYFILLED',executedQty:'49'}});
 v.client.placeOrder=async(p,opts)=>{
  if(p.type==='MARKET'&&p.reduceOnly&&++attempts===1){
   v.setSize(49);return {order:{orderId:'999',status:'PARTIALLY_FILLED',executedQty:'49'}};
  }
  return send(p,opts);
 };
 assert.equal((await ex.handle({id:2,date:1e12+1000,text:CLOSE})).reason,'CLOSE_PENDING');
 assert.equal(v.size,49);assert.equal(ex.status().positions[0].stopOrderId,stop);
 assert.equal(ex.status().closed.length,0);assert.equal(v.calls.filter(r=>r.op==='cancel').length,0);
 const positions=v.client.positions;
 v.client.positions=async()=>[{symbol:'TNSR-USDT',positionAmt:null}];
 await ex.reconcile();assert.equal(ex.status().positions[0].stopOrderId,stop,'a missing amount does not confirm a flat position');
 v.client.positions=positions;
 await ex.reconcile();assert.equal(attempts,1,'open close order must not be submitted a second time');
 terminal=true;await ex.reconcile();
 assert.equal(v.size,0);assert.equal(ex.status().closed[0].closeReason,'TRADER_CLOSE');
 assert.equal(v.calls.filter(r=>r.op==='cancel').length,1);assert.equal(ex.status().closed[0].theirPnlUSD,1.72);
 assert.equal(ex.status().closed[0].netSource,'UNKNOWN','a partial close must wait for the complete fill history');
});

test('copy settlement matches exact order IDs and reports exchange fees separately',async()=>{
 const v=venue(),ex=make(v,{config:{mode:'LIVE'}});ex.goneRecheckMs=0;
 await ex.handle({id:1,date:1e12,text:OPEN});await ex.handle({id:2,date:1e12+1000,text:CLOSE});
 const row=ex.store.closed[0],{id:entryId}=row.fillOrders.find(x=>x.side==='SELL'),{id:exitId}=row.fillOrders.at(-1);
 assert.equal(row.netSource,'ESTIMATE_BEFORE_FEES');
 const times={entry:1e12,exit:1e12+500};
 v.client.fillOrders=async({orderId})=>[
  ...(orderId===entryId?[{tradeId:'01',orderId,symbol:'TNSR-USDT',side:'SELL',qty:98,price:'0.051',realizedPnl:0,fee:'-.02',time:times.entry}]:[]),
  ...(orderId===exitId?[{tradeId:'02',orderId,symbol:'TNSR-USDT',side:'BUY',qty:98,price:'0.05',realizedPnl:1,fee:'-.03',time:times.exit}]:[]),
  {tradeId:'03',orderId:'888',symbol:'TNSR-USDT',side:'BUY',qty:10,price:'0.05',realizedPnl:10,fee:0,time:times.exit}
 ];
 ex.now=()=>1e12+20000;await ex.settle();
 assert.equal(row.netSource,'EXCHANGE_FILLS');assert.equal(row.netUSD,.95);assert.equal(row.feeUSD,-.05);assert.equal(row.pnlUSD,1);
 assert.deepEqual(ex.status().closed[0].settlement,{state:'CONFIRMED',checkedAt:1e12+20000});
});

test('copy settlement keeps the reason and check time, then replaces it after matching receipts arrive',async()=>{
 const v=venue(),ex=make(v);ex.goneRecheckMs=0;
 await ex.handle({id:1,date:1e12,text:OPEN});await ex.handle({id:2,date:1e12,text:CLOSE});
 const p=ex.store.closed[0],entry=p.fillOrders.find(x=>x.side==='SELL').id,exit=p.fillOrders.at(-1).id;
 let now=1e12+20000,closeQty=49;
 ex.now=()=>now;
 v.client.fillOrders=async({orderId})=>orderId===entry||orderId===exit?[{orderId,tradeId:orderId,symbol:'TNSR-USDT',
  side:orderId===entry?'SELL':'BUY',qty:orderId===entry?98:closeQty,price:.05,fee:-.01,realizedPnl:1,time:p.openedAt+(orderId===exit?500:0)}]:[];
 await ex.settle();assert.deepEqual(ex.status().closed[0].settlement,{state:'QUANTITY_MISMATCH',checkedAt:now});
 assert.equal(p.netSource,'ESTIMATE_BEFORE_FEES');
 closeQty=98;now+=5*60000;await ex.settle();assert.deepEqual(ex.status().closed[0].settlement,{state:'CONFIRMED',checkedAt:now});
 const old={openedAt:1e10,closedAt:1e10+1000,netSource:'UNKNOWN'};
 assert.deepEqual(ex.settlementStatus(old),{state:'NO_ORDER_IDS',checkedAt:null});
});

test('historical copy settlement reconstructs saved client IDs and only counts matched orders from symbol fills',async()=>{
 const v=venue(),ex=make(v);ex.goneRecheckMs=0;
 await ex.handle({id:1,date:1e12,text:OPEN});await ex.handle({id:2,date:1e12,text:CLOSE});
 const p=ex.store.closed[0],ids=p.fillOrders.map(o=>o.id),market=v.calls.filter(o=>o.type==='MARKET');
 Object.assign(p,{fillOrders:[],entryCids:[],fillTracked:false});
 v.client.allOrders=async()=>({orders:[...market.map((o,i)=>({orderId:ids[i],side:o.side,clientOrderId:o.clientOrderId,status:'FILLED'})),
  {orderId:'manual',side:'BUY',status:'FILLED'}]});
 v.client.fillOrders=async()=>{throw Error('BULK_UNAVAILABLE')};
 v.client.fillHistory=async q=>{assert.equal(q.symbol,'TNSR-USDT');return [
  {orderId:ids[0],tradeId:'1',symbol:q.symbol,side:'SELL',qty:98,price:.051,fee:-.02,time:1e12-500},
  {orderId:ids[1],tradeId:'2',symbol:q.symbol,side:'BUY',qty:98,price:.05,fee:-.03,realizedPnl:1,time:1e12},
  {orderId:'manual',tradeId:'3',symbol:q.symbol,side:'BUY',qty:98,price:.05,fee:-.01,realizedPnl:20,time:1e12}]};
 ex.now=()=>1e12+10*86400000;await ex.settle({recheck:true});
 assert.equal(p.netUSD,.95);assert.equal(p.netSource,'EXCHANGE_FILLS');assert.equal(p.settlement.state,'CONFIRMED');
});

test('automatic copy settlement recovers separately executed manual reductions only when the lane is unambiguous',async()=>{
 for(const ambiguity of ['none','foreign-entry','ambiguous-close','incomplete-close']){
  const v=venue(),ex=make(v,{config:{mode:'LIVE',stops:false}});ex.goneRecheckMs=0;
  await ex.handle({id:1,date:1e12,text:OPEN});
  ex.now=()=>1e12+5000;
  await ex.handle({id:2,date:1e12+5000,text:CLOSE});
  const p=ex.store.closed[0],entry=p.fillOrders.find(x=>x.side==='SELL').id,last=p.fillOrders.find(x=>x.side==='BUY').id;
  p.closeEvidence={kind:'MANUAL_CLOSE',orderId:last};
  const symbol=p.venueSymbol,order=(id,side,qty,t,extra={})=>({orderId:id,side,executedQty:String(qty),updateTime:1e12+t,status:'FILLED',symbol,positionSide:'BOTH',...extra});
  const history=[order(entry,'SELL',98,0),order(last,'BUY',30,4000),
   order('external','BUY',ambiguity==='incomplete-close'?69:68,2000,{reduceOnly:ambiguity!=='ambiguous-close'})];
  if(ambiguity==='foreign-entry')history.push(order('foreign','SELL',1,1000));
  v.client.allOrders=async()=>({orders:history});
  const fill=(id,side,qty,t,pnl)=>({orderId:id,tradeId:id,symbol,side,qty,price:.05,fee:-.01,realizedPnl:pnl,time:1e12+t});
  const fills=[fill(entry,'SELL',98,0,0),fill(last,'BUY',30,4000,.3),fill('external','BUY',68,2000,.68)];
  v.client.fillHistory=async()=>fills;
  ex.now=()=>1e12+25000;
  await ex.settle();
  if(ambiguity==='none'){
   assert.equal(p.netSource,'EXCHANGE_FILLS');
   assert.equal(p.netUSD,.95);
   assert.equal(p.settlement.state,'CONFIRMED');
  }else{
   assert.notEqual(p.netSource,'EXCHANGE_FILLS',ambiguity);
   assert.equal(p.settlement.state,ambiguity==='incomplete-close'?'FILL_PENDING':'QUANTITY_MISMATCH');
  }
 }
});

test('copy: no entry right after a monitor restart, while disarmed, or on a symbol the signal strategy holds; add skipped without margin',async()=>{
 let v=venue(),ex=make(v);
 await ex.handle({id:1,date:1e12,text:'Gate.io 모니터 시작'});await ex.handle({id:2,date:1e12+30000,text:OPEN});
 assert.equal(v.calls.filter(c=>c.op==='order').length,0);assert.equal(ex.status().events[0].reason,'MONITOR_RESTART_SNAPSHOT');
 v=venue();ex=make(v,{gate:()=>({ok:false,reason:'LIVE_DISARMED'})});await ex.handle({id:1,date:1e12,text:OPEN});assert.equal(v.calls.length,0);
 v=venue();ex=make(v,{isBusy:()=>true});await ex.handle({id:1,date:1e12,text:OPEN});assert.equal(v.calls.length,0);
 v=venue();{let n=0;ex=make(v,{free:()=>n++<1?300:.5})}await ex.handle({id:1,date:1e12,text:OPEN});await ex.handle({id:2,date:1e12,text:CHANGE(880,1760)});
 assert.equal(v.size,98,'add needs about 1 $ of margin, 0.45 free');assert.equal(ex.status().events[0].type,'ADD_SKIPPED');
 assert.equal(ex.heldSymbols().has('TNSRUSDT'),true);
});

test('copy: the protective stop closing it is booked; an error is reported, not thrown; LIVE never copies',async()=>{
 const v=venue(),ex=make(v);await ex.handle({id:1,date:1e12,text:OPEN});v.setSize(0);await ex.reconcile();
 // One empty answer does not close the ledger; the second in a row does.
 assert.equal(ex.status().closed.length,0);assert.equal(ex.status().positions.length,1);
 await ex.reconcile();assert.equal(ex.status().closed[0].closeReason,'STOP_OR_EXTERNAL');
 // A position already on the venue (manual) is not added to.
 const v3=venue();v3.setSize(5000);const ex3=make(v3);const r3=await ex3.handle({id:1,date:1e12,text:OPEN});
 assert.equal(r3.reason,'VENUE_POSITION_EXISTS');assert.equal(v3.size,5000);
 const bad=new CopyExecutor({config:copyConfig({COPY_SIZING:'FIRST_1USD',COPY_STOPS:'on'},'TESTNET'),client:venue().client,contractOf:async()=>null,balance:async()=>null,now:()=>1});
 const r=await bad.handle({id:9,date:1,text:OPEN});assert.equal(r.reason,'NO_BINGX_CONTRACT');assert.equal(bad.status().events[0].type,'ERROR');
 assert.equal(copyConfig({},'LIVE').enabled,false);assert.equal(copyConfig({COPY_TRADING:'off'},'TESTNET').enabled,false);
});

test('copy: ledger survives a restart; notices read well',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'copy-'));const v=venue();
 const a=new CopyExecutor({config:copyConfig({COPY_SIZING:'FIRST_1USD',COPY_STOPS:'on'},'TESTNET'),client:v.client,contractOf:async()=>contract,balance:async()=>({equity:400,available:300}),directory:dir,now:()=>1e12});
 await a.handle({id:1,date:1e12,text:OPEN});
 const b=new CopyExecutor({config:copyConfig({COPY_SIZING:'FIRST_1USD',COPY_STOPS:'on'},'TESTNET'),client:v.client,contractOf:async()=>contract,balance:async()=>({equity:400,available:300}),directory:dir,now:()=>1e12});
 assert.equal(b.status().positions.length,1);assert.equal((await b.handle({id:1,date:1e12,text:OPEN})).duplicate,true);
 assert.match(copyEventText({type:'OPENED',symbol:'TNSRUSDT',direction:'SHORT',leverage:5,qty:98,avg:.051,stop:1.07}),/^\[카피\] · TNSRUSDT 숏 5배 진입 \(테스트넷\)/);
 assert.match(copyEventText({type:'CLOSED',symbol:'TNSRUSDT',reason:'TRADER_CLOSE',netUSD:-.12,theirPnlUSD:1.72,adds:1}),/^\[카피\][\s\S]+손익 −\$0\.12 .* 트레이더 \+\$1\.72/);
 for(const ev of [{type:'ARMED'},{type:'COPY_COOLDOWN_TRIGGERED',reason:'연속 손실'},{type:'DEFERRED_FOR_UPDATE',symbol:'BTCUSDT'},{type:'ERROR',symbol:'BTCUSDT',kind:'OPEN',reason:'ERR'},{type:'COPY_LOSS_LIMIT'},{type:'STOP_NOT_SET',symbol:'BTCUSDT',reason:'HTTP_429'}]){
  assert.match(copyEventText(ev),/^\[카피\]/,`${ev.type} must start with [카피]`);
 }
 fs.rmSync(dir,{recursive:true,force:true});
});

test('copy review fixes: new stop before the old is cancelled; no stop at all -> closed; failed close retried; ledger loss limit; small cuts follow',async()=>{
 let v=venue(),ex=make(v);await ex.handle({id:1,date:1e12,text:OPEN});
 await ex.handle({id:2,date:1e12,text:CHANGE(880,1760)});
 const iStop=v.calls.map((c,i)=>c.type==='STOP_MARKET'?i:-1).filter(i=>i>=0)[1],iCancel=v.calls.findIndex(c=>c.op==='cancel');
 assert.ok(iStop<iCancel,'new stop placed before the old one is cancelled');
 // The new stop fails after an add: the old stop stays, retried by the routine check.
 v.failStop=true;await ex.handle({id:3,date:1e12,text:CHANGE(1760,3520)});
 const p=ex.status().positions[0];assert.ok(p.stopOrderId,'old stop kept');assert.equal(p.stopStale,true);
 v.failStop=false;await ex.reconcile();assert.equal(ex.status().positions[0].stopStale,false);
 // A first stop that cannot be placed: the position is closed at market.
 v=venue();ex=make(v);v.failStop='VENUE_ERROR_101204';await ex.handle({id:1,date:1e12,text:OPEN});
 assert.equal(v.size,0);assert.equal(ex.status().closed[0].closeReason,'NO_STOP');
 // A rate limit is not a refusal: kept (stale), placed again by the routine check.
 v=venue();ex=make(v);v.failStop=true;await ex.handle({id:1,date:1e12,text:OPEN});assert.equal(v.size,98);assert.equal(ex.status().positions[0].stopStale,true);
 v.failStop=false;await ex.reconcile();assert.equal(ex.status().positions[0].stopStale,false);
 // A close refused by the venue is retried.
 v=venue();ex=make(v);await ex.handle({id:1,date:1e12,text:OPEN});v.failMarket=true;await ex.handle({id:2,date:1e12,text:CLOSE});
 assert.equal(v.size,98);assert.equal(ex.status().pending,1);v.failMarket=false;await ex.reconcile();assert.equal(v.size,0);assert.equal(ex.status().pending,0);
 // Ledger loss limit (user 2026-11-13: 50 %): -110 on 400 (27 %) keeps going, -210 (52 %) closes everything and stops new copies.
 v=venue();ex=make(v);await ex.handle({id:1,date:1e12,text:OPEN});v.unreal='-110';await ex.reconcile();assert.equal(ex.status().killed,false);v.unreal='-210';await ex.reconcile();
 assert.equal(v.size,0);assert.equal(ex.status().killed,true);await ex.handle({id:5,date:1e12,text:OPEN});assert.equal(v.size,0);
 ex.resume();assert.equal(ex.status().killed,false);
 // A 1-unit cut of a 3-unit position (trader 300 -> 200) is not lost to rounding down.
 v=venue();ex=make(v,{config:{marginUSD:.03}});await ex.handle({id:1,date:1e12,text:OPEN});
 const before=v.size;await ex.handle({id:2,date:1e12,text:CHANGE(300,200)});assert.equal(before-v.size,Math.round(before/3));
});

test('copy: BingX allows one stop per position (110406): the stop is swapped — cancelled, then placed at the new price; on failure the old price is put back',async()=>{
 let v=venue(),ex=make(v);await ex.handle({id:1,date:1e12,text:OPEN});
 const place=v.client.placeOrder;let live=1;
 v.client.cancelOrder=async()=>{live--;return {}};
 v.client.placeOrder=async p=>{if(p.type==='STOP_MARKET'){if(live>0)throw Object.assign(Error('A Stop Loss order already exists'),{code:'VENUE_ERROR_110406'});live++}return place(p)};
 await ex.handle({id:2,date:1e12,text:CHANGE(880,1760)});
 let p=ex.status().positions[0];assert.equal(p.stopStale,false);assert.equal(live,1,'exactly one stop');assert.equal(v.size,192);
 // The new stop keeps failing after the cancel: the old price is placed again (stale, retried later).
 v=venue();ex=make(v);await ex.handle({id:1,date:1e12,text:OPEN});const first=ex.status().positions[0].stop;let n=0;
 const place2=v.client.placeOrder;
 v.client.placeOrder=async p=>{if(p.type==='STOP_MARKET'){n++;if(n===1)throw Object.assign(Error('exists'),{code:'VENUE_ERROR_110406'});if(Number(p.stopPrice)!==first)throw Object.assign(Error('busy'),{code:'VENUE_ERROR_100500'})}return place2(p)};
 await ex.handle({id:2,date:1e12,text:CHANGE(880,1760)});
 p=ex.status().positions[0];assert.equal(p.stopStale,true);assert.ok(p.stopOrderId);assert.equal(v.size,192);
});

test('copy (user 2026-11-13): first buy 1 $, a later 진입 card of 0.4 = 1 $, 0.8 = 2 $; the same card twice is one buy; a 청산 card with a quantity closes that share',async()=>{
 const card=(q,entry)=>`📌 포지션 진입\n━━━━━━━━━━━━━━━━\nTNSRUSDT 🔴 Short ×5\n━━━━━━━━━━━━━━━━\n진입가 ${entry} USDT\n현재가 0.05000 USDT\n수량 ${q}`;
 const v=venue(),ex=make(v);
 await ex.handle({id:1,date:1e12,text:card(0.4,'0.05000')});const first=v.size;
 assert.equal(first,100,'1 $ x 5 / 0.05');
 await ex.handle({id:2,date:1e12+1000,text:card(0.4,'0.05000')});assert.equal(v.size,100,'same card again (same entry within 3 min): not a buy');
 await ex.handle({id:3,date:1e12+600000,text:card(0.4,'0.05100')});assert.equal(v.size,200,'0.4 more = 1 $ more');
 await ex.handle({id:4,date:1e12+900000,text:card(0.8,'0.05200')});assert.equal(v.size,400,'0.8 more = 2 $ more');
 // The trader holds 1.6; a 청산 card of 0.4 closes a quarter of ours.
 await ex.handle({id:5,date:1e12+990000,text:'✅ 포지션 청산\n━━━━━━━━━━━━━━━━\nTNSRUSDT 🔴 Short\n━━━━━━━━━━━━━━━━\n진입가 0.05000 USDT\n수량 0.4\n최종손익 🟢 +0.3 USDT'});
 assert.equal(v.size,300,'a quarter closed');assert.equal(ex.status().positions.length,1);
 await ex.handle({id:6,date:1e12+999000,text:CLOSE});assert.equal(v.size,0);
 assert.equal(ex.status().events.find(e=>e.type==='ADDED').marginUSD,2);
});

test('copy exit at a volume zone at least 20 % away, only when a 15m candle closes beyond it on 1.5x volume; exchange stop = balance cap; at most 10 adds',async()=>{
 const zones=[{priceLow:.0515,priceHigh:.0518},{priceLow:.0560,priceHigh:.0570},{priceLow:.0630,priceHigh:.0640}];
 let candles=[];const v=venue();
 const ex=new CopyExecutor({config:copyConfig({COPY_SIZING:'FIRST_1USD',COPY_STOPS:'on'},'TESTNET'),client:v.client,contractOf:async()=>contract,zonesOf:async()=>zones,candlesOf:async()=>candles,
  balance:async()=>({equity:400,available:300}),now:()=>1e12});
 // Short at 0.051: 0.0518 (1.6 %) and 0.0570 (11.8 %) are where the trader adds; 0.0640 (25 %) is the exit zone.
 assert.deepEqual(ex.zoneStop({direction:'SHORT',entry:.051,zones}).zone,{priceLow:.063,priceHigh:.064});
 await ex.handle({id:1,date:1e12,text:OPEN});
 const p=ex.status().positions[0];assert.equal(p.stopSource,'BACKSTOP');assert.ok(Math.abs(p.stopDistPct-25.5)<.2,p.stopDistPct);
 const bar=(i,c,vol)=>[1e12-(30-i)*900000,c,c,c,c,vol,1e12-(30-i)*900000+899999];
 // Beyond the zone on ordinary volume: kept.
 candles=[...Array.from({length:29},(_,i)=>bar(i,.06,100)),bar(29,.065,120)];await ex.reconcile();assert.equal(v.size,98);
 // Beyond the zone on 2x volume: closed.
 candles=[...Array.from({length:29},(_,i)=>bar(i,.06,100)),bar(29,.065,200)];await ex.reconcile();
 assert.equal(v.size,0);assert.equal(ex.status().closed[0].closeReason,'ZONE_BREAK_VOLUME');
 // At most COPY_MAX_ADDS adds (default 100 since 2026-11-14; 10 here).
 const v2=venue(),ex2=new CopyExecutor({config:copyConfig({COPY_SIZING:'FIRST_1USD',COPY_MAX_ADDS:'10',COPY_STOPS:'on',COPY_MAX_TOTAL_MARGIN_PCT:'100'},'TESTNET'),client:v2.client,contractOf:async()=>contract,balance:async()=>({equity:400,available:400}),now:()=>1e12});
 await ex2.handle({id:1,date:1e12,text:OPEN});let q=880;
 for(let k=0;k<12;k++){await ex2.handle({id:10+k,date:1e12,text:CHANGE(q,q+880)});q+=880}
 assert.equal(ex2.status().positions[0].adds,10);assert.ok(ex2.status().events.some(e=>e.reason==='COPY_MAX_ADDS'));
});

test('copy review: the trader total follows the trader even when our buy is skipped; a failed partial close retries the same share; "- → q" positions keep their scale',async()=>{
 const card=(q,entry)=>`📌 포지션 진입\n━━━━━━━━━━━━━━━━\nTNSRUSDT 🔴 Short ×5\n━━━━━━━━━━━━━━━━\n진입가 ${entry} USDT\n현재가 0.05000 USDT\n수량 ${q}`;
 const closeQ=q=>`✅ 포지션 청산\n━━━━━━━━━━━━━━━━\nTNSRUSDT 🔴 Short\n━━━━━━━━━━━━━━━━\n진입가 0.05000 USDT\n수량 ${q}\n최종손익 🟢 +0.3 USDT`;
 let v=venue(),ex;{let n=0;ex=make(v,{free:()=>n++<1?300:.5})}
 await ex.handle({id:1,date:1e12,text:card(0.4,'0.05000')});await ex.handle({id:2,date:1e12+600000,text:card(0.4,'0.05100')});
 assert.equal(v.size,100,'add skipped (margin)');assert.equal(ex.status().positions[0].theirTotal,.8,'trader total still 0.8');
 await ex.handle({id:3,date:1e12+700000,text:closeQ(0.4)});assert.equal(v.size,50,'half of ours, not all');
 v=venue();ex=make(v);await ex.handle({id:1,date:1e12,text:card(0.4,'0.05000')});await ex.handle({id:2,date:1e12+600000,text:card(1.2,'0.05100')});
 assert.equal(v.size,400);v.failMarket=true;await ex.handle({id:3,date:1e12+700000,text:closeQ(0.4)});assert.equal(v.size,400);
 v.failMarket=false;await ex.reconcile();assert.equal(v.size,300,'a quarter, once');await ex.reconcile();assert.equal(v.size,300);
 v=venue();ex=make(v);await ex.handle({id:1,date:1e12,text:CHANGE('-','880')});
 assert.equal(ex.status().positions[0].theirFirstQty,880);
});

test('copy BALANCE_RATIO: the trader quantity x our equity / 20,000 $, no 1 $ floor; each cut has its own order id',async()=>{
 // Default (user 2026-11-20): BALANCE_RATIO (trader quantity x our equity / 20,000 $), adds as many as the trader (100), up to 100 % of the equity as margin.
 assert.equal(copyConfig({},'TESTNET').sizing,'BALANCE_RATIO');assert.equal(copyConfig({},'TESTNET').traderBalanceUSD,20000);assert.equal(copyConfig({COPY_SIZING:'MIN_ORDER'},'TESTNET').sizing,'MIN_ORDER');assert.equal(copyConfig({},'TESTNET').maxAdds,100);assert.equal(copyConfig({},'TESTNET').maxTotalMarginPct,100);assert.equal(copyConfig({},'TESTNET').marginUSD,1);
 const card=(q,entry)=>`📌 포지션 진입\n━━━━━━━━━━━━━━━━\nTNSRUSDT 🔴 Short ×5\n━━━━━━━━━━━━━━━━\n진입가 ${entry} USDT\n현재가 0.05000 USDT\n수량 ${q}`;
 const v=venue();const ex=new CopyExecutor({config:copyConfig({COPY_SIZING:'BALANCE_RATIO',COPY_MAX_TOTAL_MARGIN_PCT:'30'},'TESTNET'),client:v.client,contractOf:async()=>contract,balance:async()=>({equity:400,available:300}),now:()=>1e12});
 // 880 x 400 / 20,000 = 17.6 -> 17 coins (0.87 $ of notional... venue minimum 2 $ -> raised to the minimum).
 await ex.handle({id:1,date:1e12,text:card(5000,'0.05000')});
 assert.equal(v.size,100,'5,000 x 0.02 = 100 coins');assert.equal(ex.status().positions[0].scale,.02);
 await ex.handle({id:2,date:1e12+600000,text:card(2500,'0.05100')});assert.equal(v.size,150,'2,500 more x 0.02 = 50');
 await ex.handle({id:3,date:1e12+700000,text:CHANGE(7500,5000)});await ex.handle({id:4,date:1e12+800000,text:CHANGE(5000,2500)});
 assert.equal(v.size,50);
 const cuts=v.calls.filter(c=>c.reduceOnly==='true').map(c=>c.clientOrderId);assert.equal(cuts.length,2);assert.notEqual(cuts[0],cuts[1]);
 assert.equal(ex.status().positions[0].reduces,2);
 // Small trader order where ratio falls below venue minimum -> matches trader's 1x quantity on entry and all adds.
 const v2=venue();const ex2=new CopyExecutor({config:copyConfig({COPY_SIZING:'BALANCE_RATIO',COPY_MAX_TOTAL_MARGIN_PCT:'30'},'TESTNET'),client:v2.client,contractOf:async()=>contract,balance:async()=>({equity:400,available:300}),now:()=>1e12});
 await ex2.handle({id:1,date:1e12,text:card(100,'0.05000')});
 assert.equal(v2.size,100,'ratio 2 < min -> matched trader 1x qty (100)');
 assert.equal(ex2.status().positions[0].matchTraderQty,true);
 assert.equal(ex2.status().positions[0].scale,1);
 assert.equal(ex2.status().positions[0].minOrder,false);
 // Even 1x below venue minimum (10 coins = $0.50 < $2) -> snaps to venue minimum and flags minOrder while keeping 1x adds.
 const v3=venue();const ex3=new CopyExecutor({config:copyConfig({COPY_SIZING:'BALANCE_RATIO',COPY_MAX_TOTAL_MARGIN_PCT:'30'},'TESTNET'),client:v3.client,contractOf:async()=>contract,balance:async()=>({equity:400,available:300}),now:()=>1e12});
 await ex3.handle({id:1,date:1e12,text:card(10,'0.05000')});
 assert.equal(ex3.status().positions[0].minOrder,true);
 assert.equal(ex3.status().positions[0].matchTraderQty,true);
});

test('live BALANCE_RATIO: a 1x trader-quantity match is capped at COPY_MIN_ORDER_MAX_MARGIN_USD; adds go back to the ratio with carry-over (decision 2026-11-23 b)',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'copy-live-1x-'));
 try{
  const openSmall=`📌 포지션 진입\n━━━━━━━━━━━━━━━━\nTNSRUSDT 🔴 Short ×7\n━━━━━━━━━━━━━━━━\n진입가 0.05100 USDT\n현재가 0.05100 USDT\n수량 200`;
  const v=venue(),config=copyConfig({COPY_MODE:'LIVE',COPY_LIVE_CONFIRM:'REAL_MONEY_COPY'});
  assert.equal(config.minOrderMaxMarginUSD,5);
  const makeEx=()=>new CopyExecutor({config,client:v.client,contractOf:async()=>contract,directory:dir,
   balance:async()=>({equity:3081,available:2921}),now:()=>1e12});
  // 200 * (2921 / 20000) = 29 coins = $1.48 < $2 venue min -> enters exact 1x trader qty (200): margin 200*0.051/7 = $1.46 <= $5.
  let ex=makeEx();
  assert.equal((await ex.handle({id:1,date:1e12,text:openSmall})).ok,true);
  assert.equal(v.size,200,'entered exact 1x trader quantity');
  assert.equal(ex.status().positions[0].matchTraderQty,true);
  // Reload from disk: adds use the balance ratio (2921/20000 = 0.14605) with carry-over, never 1x.
  ex=makeEx();
  assert.equal((await ex.handle({id:2,date:1e12+1000,text:CHANGE(200,500)})).ok,true);
  assert.equal(v.size,243,'+300 x 0.14605 = 43.8 -> 43 (carry 0.8)');
  const r2=await ex.handle({id:3,date:1e12+2000,text:CHANGE(500,700)});
  assert.equal(r2.carried,true,'+200 x 0.14605 + 0.8 = 30 coins = $1.59 < $2 minimum -> carried');
  assert.equal(v.size,243);
  assert.equal((await ex.handle({id:4,date:1e12+3000,text:CHANGE(700,1000)})).ok,true);
  assert.equal(v.size,316,'+300 x 0.14605 + 30.0 carried = 73.8 -> 73');
  // A larger trader quantity whose 1x match needs more than $5 of margin is skipped with a reason.
  const v2=venue(),ex2=new CopyExecutor({config,client:v2.client,contractOf:async()=>contract,balance:async()=>({equity:3081,available:2921}),now:()=>1e12});
  const openBig=openSmall.replace('수량 200','수량 1000').replace('TNSRUSDT 🔴 Short ×7','TNSRUSDT 🔴 Short ×1');
  // 1000 x 0.14605 = 146 coins x 0.051 = $7.4 >= $2: the plain ratio, no match needed.
  assert.equal((await ex2.handle({id:1,date:1e12,text:openBig})).ok,true);assert.equal(v2.size,146);
  const v3=venue(),ex3=new CopyExecutor({config,client:v3.client,contractOf:async()=>contract,balance:async()=>({equity:300,available:100}),now:()=>1e12});
  // 1000 x 100/20000 = 5 coins ($0.26 < $2) -> 1x would be 1000 x 0.051 / 1 = $51 margin > $5 -> skipped.
  const r3=await ex3.handle({id:1,date:1e12,text:openBig});
  assert.equal(r3.reason,'MATCH_TRADER_QTY_TOO_LARGE');assert.equal(v3.size,0);
  assert.ok(ex3.status().events.some(e=>e.reason==='MATCH_TRADER_QTY_TOO_LARGE'&&e.need>5));
 }finally{fs.rmSync(dir,{recursive:true,force:true})}
});

test('copy: a card whose quantity does not match its margin x leverage is not traded; first entries respect the total margin cap; small adds are carried',async()=>{
 const v=venue(),ex=new CopyExecutor({config:copyConfig({COPY_SIZING:'BALANCE_RATIO',COPY_MAX_TOTAL_MARGIN_PCT:'30'},'TESTNET'),client:v.client,contractOf:async()=>contract,balance:async()=>({equity:400,available:300}),now:()=>1e12});
 // 880 coins x 0.051 = 44.9 $ but 마진 9.01 x 5 = 45 $: coins. 88 "contracts" with the same margin would not match.
 const bad=OPEN.replace('수량　　880','수량　　88');
 assert.equal((await ex.handle({id:1,date:1e12,text:bad})).reason,'QUANTITY_UNIT_UNCLEAR');assert.equal(v.size,0);
 const card=(q,entry)=>`📌 포지션 진입\n━━━━━━━━━━━━━━━━\nTNSRUSDT 🔴 Short ×5\n━━━━━━━━━━━━━━━━\n진입가 ${entry} USDT\n현재가 0.05000 USDT\n수량 ${q}`;
 // 30 % of 400 = 120 $ of margin: 1,000,000 coins x 0.02 = 20,000 coins = 1,000 $ notional / 5 = 200 $ -> skipped.
 assert.equal((await ex.handle({id:2,date:1e12,text:card(1000000,'0.05000')})).reason,'COPY_MARGIN_CAP');
 await ex.handle({id:3,date:1e12,text:card(5000,'0.05000')});assert.equal(v.size,100);
 // 1,000 more x 0.02 = 20 coins = 1 $ < 2 $ venue minimum: carried; the next 1,000 makes 40 coins = 2 $: bought together.
 await ex.handle({id:4,date:1e12+600000,text:card(1000,'0.05100')});assert.equal(v.size,100);
 await ex.handle({id:5,date:1e12+700000,text:card(1000,'0.05200')});assert.equal(v.size,140,'carried adds bought together');
 await ex.handle({id:6,date:1e12+800000,text:card(1000,'0.05300')});assert.equal(v.size,140,'the next small one carried again');
});

test('live copy uses fresh available margin for new entries and each increase even with a legacy fixed sizing setting',async()=>{
 const env={COPY_MODE:'LIVE',COPY_LIVE_CONFIRM:'REAL_MONEY_COPY',COPY_SIZING:'MIN_ORDER'};
 const config=copyConfig(env);
 assert.equal(config.sizing,'BALANCE_RATIO');
 assert.equal(copyConfig({...env,COPY_SIZING:'FIRST_1USD'}).sizing,'BALANCE_RATIO');
 let available=3000;
 const v=venue(),ex=new CopyExecutor({config,client:v.client,contractOf:async()=>contract,
  balance:async()=>({equity:6500,available}),now:()=>1e12});
 const card=(id,text)=>ex.handle({id,date:1e12+id*1000,text});
 const buys=()=>v.calls.filter(c=>c.type==='MARKET'&&!c.reduceOnly).map(c=>Number(c.quantity));
 assert.equal((await card(1,OPEN)).ok,true);
 assert.deepEqual(buys(),[132]); // 880 × 3,000 / 20,000
 available=6000;
 assert.equal((await card(2,CHANGE(880,1760))).ok,true);
 assert.deepEqual(buys(),[132,264]); // 880 more, using the new available margin
 assert.equal((await card(3,CLOSE)).ok,true);
 assert.equal(v.size,0);
 assert.equal((await card(4,OPEN)).ok,true);
 assert.deepEqual(buys(),[132,264,264]);
});

test('live copy applies current available margin to the next trader increase of a position saved in MIN_ORDER mode',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'copy-live-margin-'));
 try{
  let available=3000;
  const v=venue(),config=copyConfig({COPY_MODE:'LIVE',COPY_LIVE_CONFIRM:'REAL_MONEY_COPY'});
  const create=config=>new CopyExecutor({config,client:v.client,contractOf:async()=>contract,directory:dir,
   balance:async()=>({equity:6500,available}),now:()=>1e12});
  let ex=create({...config,sizing:'MIN_ORDER'});
  assert.equal((await ex.handle({id:1,date:1e12,text:OPEN})).ok,true);
  const savedSize=v.size;
  available=6000;
  ex=create(config);
  assert.equal(ex.status().positions[0].sizing,'MIN_ORDER');
  assert.equal(v.size,savedSize);
  assert.equal((await ex.handle({id:2,date:1e12+1000,text:CHANGE(880,1760)})).ok,true);
  assert.equal(v.size,savedSize+264);
 }finally{fs.rmSync(dir,{recursive:true,force:true})}
});

test('copy entries need 90 % of the free margin; a venue minimum above 5 $ of margin is not taken',async()=>{
 const v=venue(),ex=make(v,{free:1});
 assert.equal((await ex.handle({id:1,date:1e12,text:OPEN})).reason,'MARGIN_SHORT');assert.equal(v.size,0);
 const big={...contract,minQuantityBase:'1000'};// 1000 coins x 0.05 / 5 = 10 $ of margin > 5 $
 const v2=venue(),ex2=new CopyExecutor({config:copyConfig({COPY_SIZING:'FIRST_1USD'},'TESTNET'),client:v2.client,contractOf:async()=>big,balance:async()=>({equity:400,available:300}),now:()=>1e12});
 const card=`📌 포지션 진입\nTNSRUSDT 🔴 Short ×5\n진입가 0.05 USDT\n현재가 0.05000 USDT\n수량 100`;
 assert.equal((await ex2.handle({id:1,date:1e12,text:card})).reason,'MIN_ORDER_TOO_LARGE');assert.equal(v2.size,0);
});

test('copy: the position mode is read before any setting or order; unreadable -> skipped, one-way unchanged',async()=>{
 const v=venue();v.client.positionMode=async()=>{throw Object.assign(Error('down'),{code:'NETWORK_UNREACHABLE'})};
 const ex=make(v);const r=await ex.handle({id:1,date:1e12,text:OPEN});
 assert.equal(r.reason,'BINGX_POSITION_MODE_UNKNOWN');assert.equal(v.size,0);assert.equal(v.calls.length,0);
 assert.equal(copyEventText(ex.status().events[0]).includes('BINGX_POSITION_MODE_UNKNOWN'),false,'shown in Korean');
 const v2=venue();v2.client.positionMode=async()=>({dualSidePosition:false});const ex2=make(v2);await ex2.handle({id:1,date:1e12,text:OPEN});assert.ok(v2.size>0);
 const open=v2.calls.find(c=>c.op==='order'&&c.type==='MARKET');assert.equal(open.positionSide,'BOTH');assert.equal(ex2.status().positions[0].hedge,false);
 const v3=venue();v3.client.positionMode=async()=>({});assert.equal((await make(v3).handle({id:1,date:1e12,text:OPEN})).reason,'BINGX_POSITION_MODE_UNKNOWN','a mode not stated is not guessed');
});

// Hedge (dual-side) account (user 2026-11-17): one row per side with a positive amount; BingX refuses
// reduceOnly and positionSide BOTH there.
function hedgeVenue(){
 const calls=[],pos={LONG:{amt:0,avg:0},SHORT:{amt:0,avg:0}};let id=1;
 const client={positionMode:async()=>({dualSidePosition:true}),
  leverage:async()=>({maxLongLeverage:20}),setMarginType:async()=>({}),setLeverage:async(s,side,l)=>{calls.push({op:'lev',side,l});return {}},
  positions:async()=>Object.entries(pos).filter(([,x])=>x.amt>0).map(([side,x])=>({symbol:'TNSR-USDT',positionSide:side,positionAmt:String(x.amt),avgPrice:String(x.avg),markPrice:'0.053',unrealizedProfit:'-0.1'})),
  placeOrder:async p=>{calls.push({op:'order',...p});
   if('reduceOnly' in p||!['LONG','SHORT'].includes(p.positionSide))throw Object.assign(Error('hedge mode params'),{code:'VENUE_ERROR_109400'});
   if(p.type==='MARKET'){const q=Number(p.quantity),x=pos[p.positionSide],opening=(p.positionSide==='LONG')===(p.side==='BUY');
    if(opening){x.avg=0.051;x.amt=+(x.amt+q).toFixed(6)}else x.amt=Math.max(0,+(x.amt-q).toFixed(6))}
   return {order:{orderId:String(id++),avgPrice:'0.051'}}},
  cancelOrder:async(s,o)=>{calls.push({op:'cancel',o});return {}}};
 return {client,calls,pos};
}
const OPEN_LONG=OPEN.replace('🔴 Short','🟢 Long'),CLOSE_LONG=CLOSE.replace('🔴 Short','🟢 Long');

test('copy hedge mode: orders carry positionSide LONG / SHORT and no reduceOnly; both sides of a coin can be copied',async()=>{
 const v=hedgeVenue(),ex=make(v);
 assert.equal((await ex.handle({id:1,date:1e12,text:OPEN})).ok,true,JSON.stringify(ex.status().events));
 const short=ex.status().positions.find(p=>p.direction==='SHORT');assert.equal(short.hedge,true);
 const open=v.calls.find(c=>c.op==='order'&&c.type==='MARKET');assert.deepEqual([open.side,open.positionSide],['SELL','SHORT']);assert.ok(!('reduceOnly' in open));
 assert.deepEqual(v.calls.find(c=>c.op==='lev'),{op:'lev',side:'SHORT',l:5});
 const stop=v.calls.find(c=>c.type==='STOP_MARKET');assert.deepEqual([stop.side,stop.positionSide,stop.closePosition],['BUY','SHORT','true']);
 await ex.handle({id:2,date:1e12,text:CHANGE(880,440)});
 const cut=v.calls.filter(c=>c.op==='order'&&c.type==='MARKET').at(-1);assert.deepEqual([cut.side,cut.positionSide],['BUY','SHORT']);assert.ok(!('reduceOnly' in cut));
 assert.equal(v.pos.SHORT.amt,49);
 // The other side of the same coin: a separate venue position in hedge mode.
 assert.equal((await ex.handle({id:3,date:1e12,text:OPEN_LONG})).ok,true,JSON.stringify(ex.status().events.slice(0,3)));
 const lo=v.calls.filter(c=>c.op==='order'&&c.type==='MARKET').at(-1);assert.deepEqual([lo.side,lo.positionSide],['BUY','LONG']);
 assert.ok(v.pos.LONG.amt>0);assert.equal(ex.status().positions.length,2);
 // Each position reads its own row; closing the long leaves the short.
 await ex.reconcile();assert.equal(ex.status().positions.find(p=>p.direction==='SHORT').qty,49);assert.equal(ex.status().positions.find(p=>p.direction==='LONG').qty,v.pos.LONG.amt);
 await ex.handle({id:4,date:1e12,text:CLOSE_LONG});
 const cl=v.calls.filter(c=>c.op==='order'&&c.type==='MARKET').at(-1);assert.deepEqual([cl.side,cl.positionSide],['SELL','LONG']);assert.ok(!('reduceOnly' in cl));
 assert.equal(v.pos.LONG.amt,0);assert.equal(v.pos.SHORT.amt,49);assert.equal(ex.status().positions.length,1);
 assert.ok(!ex.status().events.some(e=>e.reason==='BINGX_HEDGE_MODE'||e.type==='ERROR'));
});

test('copy hedge mode: a same-side position already on the venue still blocks; an opposite one does not',async()=>{
 const v=hedgeVenue();v.pos.SHORT={amt:500,avg:.05};
 assert.equal((await make(v).handle({id:1,date:1e12,text:OPEN})).reason,'VENUE_POSITION_EXISTS');
 const v2=hedgeVenue();v2.pos.LONG={amt:500,avg:.05};
 assert.equal((await make(v2).handle({id:1,date:1e12,text:OPEN})).ok,true);assert.equal(v2.pos.LONG.amt,500,'the manual long is untouched');
 // One-way ledger positions still keep the other side out (one-way would merge them).
 const v3=venue(),ex3=make(v3);await ex3.handle({id:1,date:1e12,text:OPEN});await ex3.handle({id:2,date:1e12,text:OPEN_LONG});
 assert.equal(ex3.status().events[0].reason,'OPPOSITE_COPY_OPEN');
});

test('copy: a venue error shows the exchange message and the failed step',async()=>{
 const {VenueHttpError}=await import('../bingx_market.mjs');
 const v=venue();v.client.setLeverage=async()=>{throw new VenueHttpError('VENUE_ERROR_109400','PositionSide must be LONG or SHORT in hedge mode')};
 const ex=make(v);await ex.handle({id:1,date:1e12,text:OPEN});
 const e=ex.status().events.find(x=>x.type==='ERROR');assert.equal(e.reason,'VENUE_ERROR_109400');
 assert.match(e.detail,/단계 레버리지 설정/);assert.match(e.detail,/BingX: PositionSide must be/);
});

test('copy MIN_ORDER (selectable): first buy = venue minimum, adds in proportion to it, small ones carried',async()=>{
 const card=(q,entry)=>`📌 포지션 진입\nTNSRUSDT 🔴 Short ×5\n진입가 ${entry} USDT\n현재가 0.05000 USDT\n수량 ${q}`;
 const v=venue(),ex=new CopyExecutor({config:copyConfig({COPY_SIZING:'MIN_ORDER'},'TESTNET'),client:v.client,contractOf:async()=>contract,balance:async()=>({equity:400,available:300}),now:()=>1e12});
 await ex.handle({id:1,date:1e12,text:card(1000,'0.05000')});const first=v.size;
 // The smallest valid order: at most 2 % over the venue minimum (2 $ notional here).
 assert.ok(first*0.05>=2&&first*0.05<=2.1,'minimum order: '+first);
 // Trader adds 500 (half of the first): half of our first -> below the minimum, carried.
 await ex.handle({id:2,date:1e12+600000,text:card(500,'0.05100')});assert.equal(v.size,first,'carried');
 // Trader adds 1500: with the carry, two of our first quantities.
 await ex.handle({id:3,date:1e12+700000,text:card(1500,'0.05200')});assert.ok(Math.abs(v.size-3*first)<=1,'proportional to our first: '+v.size);
});

test('copy: the screen gets PnL from the last price and a fresh balance',async()=>{
 const v=venue();let mark=0.05,eq=400,reads=0;const ex=new CopyExecutor({config:copyConfig({COPY_MIN_ORDER_MAX_MARGIN_USD:'20'},'TESTNET'),client:v.client,contractOf:async()=>contract,markOf:async()=>mark,balance:async()=>{reads++;return {equity:eq,available:300}},now:()=>1e12});
 await ex.handle({id:1,date:1e12,text:OPEN});const p=ex.status().positions[0];
 mark=p.avg*0.9;eq=412;const s=await ex.liveStatus(),q=s.positions[0];
 // A short gains 10 % of avg x qty when the price falls 10 %.
 assert.ok(Math.abs(q.unrealized-p.avg*0.1*q.qty)<1e-9,'short PnL: '+q.unrealized);assert.equal(s.funds.equity,412);
});

test('copy: a missed position is entered late on the trader\'s add (with the reason); never after our own close, never on a cut',async()=>{
 const chg=(sym,dir,a,b)=>`📊 포지션 변경\n🪙 ${sym}  ${dir==='LONG'?'🟢 Long':'🔴 Short'}\n수량 ${a} → ${b}\n현재가 0.05 USDT`;
 // The entry was skipped (no free margin); the add later finds no free margin either: the reason is kept.
 const v=venue(),ex=make(v,{free:1});
 assert.equal((await ex.handle({id:1,date:1e12,text:OPEN})).reason,'MARGIN_SHORT');
 await ex.handle({id:2,date:1e12+60000,text:chg('TNSRUSDT','SHORT',880,1760)});
 const late=ex.status().events.find(x=>x.type==='LATE_ENTRY');assert.equal(late.cause,'MARGIN_SHORT');assert.equal(v.size,0);
 // Never received: the add opens a new position now (the minimum order), tracked from the trader's 1760.
 const v2=venue(),ex2=make(v2);
 const r=await ex2.handle({id:3,date:1e12+60000,text:chg('TNSRUSDT','SHORT',880,1760)});
 assert.equal(r.ok,true);assert.ok(v2.size>0);const p=ex2.status().positions[0];assert.equal(p.theirFirstQty,1760);
 assert.equal(ex2.status().events.find(x=>x.type==='OPENED').late,true);
 // A cut of a missed position does not enter.
 const v3=venue(),ex3=make(v3);
 assert.equal((await ex3.handle({id:4,date:1e12,text:chg('TNSRUSDT','SHORT',1760,880)})).reason,'NOT_COPIED');assert.equal(v3.size,0);
 assert.equal(ex3.status().events.find(x=>x.reason==='NOT_COPIED').cause,'NO_ENTRY_RECEIVED');
 // Off switch.
 assert.equal(copyConfig({COPY_LATE_ENTRY:'off'},'TESTNET').lateEntry,false);assert.equal(copyConfig({},'TESTNET').lateEntry,true);
});

test('copy: no late entry after our own close; old messages that arrive late are ignored',async()=>{
 const chg=(a,b)=>`📊 포지션 변경\n🪙 TNSRUSDT  🔴 Short\n수량 ${a} → ${b}\n현재가 0.05 USDT`;
 // Opened with our exchange stop (COPY_STOPS on), then gone from the venue: it may have been our stop, so the
 // next add finds it gone and the one after must not reopen it (user 2026-11-17: ambiguous closes with a stop of ours keep blocking).
 const v=venue(),ex=make(v);await ex.handle({id:1,date:1e12,text:OPEN});v.setSize(0);
 await ex.handle({id:2,date:1e12+60000,text:chg(880,1760)});
 const r=await ex.handle({id:3,date:1e12+120000,text:chg(1760,3520)});
 assert.equal(r.reason,'NOT_COPIED');assert.equal(v.size,0);
 assert.equal(ex.status().events.find(x=>x.reason==='NOT_COPIED').cause,'OUR_COPY_CLOSED');
 // An entry card while the trader still holds it (an add in card form) does not reopen it either.
 assert.equal((await ex.handle({id:4,date:1e12+150000,text:OPEN.replace('0.05296','0.05100')})).reason,'OUR_COPY_CLOSED');assert.equal(v.size,0);
 // After the trader closes, a new entry is followed again.
 const nowT=ex.now;ex.now=()=>nowT()+1000;
 await ex.handle({id:7,date:1e12+170000,text:'✅ 포지션 청산\n🪙 TNSRUSDT  🔴 Short\n진입가 0.05296 USDT\n최종손익 🟢 +1.72 USDT'});
 assert.equal((await ex.handle({id:8,date:1e12+180000,text:OPEN.replace('0.05296','0.05100')})).ok,true);
 // Gone on the venue before the trader's close card: the trader's next entry is followed.
 const v4=venue(),ex4=make(v4);let t4=1e12;ex4.now=()=>t4;await ex4.handle({id:20,date:1e12,text:OPEN});v4.setSize(0);
 t4+=1000;await ex4.handle({id:21,date:1e12+60000,text:'✅ 포지션 청산\n🪙 TNSRUSDT  🔴 Short\n진입가 0.05296 USDT\n최종손익 🟢 +1.72 USDT'});
 t4+=1000;assert.equal((await ex4.handle({id:22,date:1e12+120000,text:OPEN.replace('0.05296','0.05100')})).ok,true);
 // An entry card older than a message already handled for the coin is history.
 const v2=venue(),ex2=make(v2);await ex2.handle({id:5,date:1e12+60000,text:chg(880,1760)});const after=v2.size;
 assert.equal((await ex2.handle({id:6,date:1e12,text:OPEN})).reason,'STALE_MESSAGE');assert.equal(v2.size,after);
});

test('copy MIN_ORDER: the first buy is at least 0.3 $ of margin (BTC at 80x), the venue minimum when that is less',async()=>{
 assert.equal(copyConfig({},'TESTNET').firstMarginUSD,0.3);
 const btc={...contract,minQuantityBase:'0.0001',quantityStep:'0.0001',minNotionalUSDT:'2',tickSize:'0.1'};
 const card=`📌 포지션 진입\nBTCUSDT 🟢 Long ×80\n진입가 67727.2 USDT\n현재가 67727.2 USDT\n수량 0.5`;
 const v=venue();v.client.leverage=async()=>({maxLongLeverage:125});
 const ex=new CopyExecutor({config:copyConfig({COPY_SIZING:'MIN_ORDER'},'TESTNET'),client:v.client,contractOf:async()=>btc,markOf:async()=>67727.2,balance:async()=>({equity:400,available:300}),now:()=>1e12});
 await ex.handle({id:1,date:1e12,text:card});
 // 0.3 $ x 80 / 67727 = 0.000354 -> 0.0003 BTC (about 0.25 $ of margin; the bare minimum 0.0001 was 0.08 $).
 assert.equal(v.calls.find(c=>c.type==='MARKET').quantity,'0.0003');
 assert.equal(copyConfig({COPY_FIRST_MARGIN_USD:'0'},'TESTNET').firstMarginUSD,0);
});

test('copy FIRST_1USD (selectable): adds in proportion to the trader, tiny adds carried to the venue minimum',async()=>{
 const card=(q,entry)=>`📌 포지션 진입\n━━━━━━━━━━━━━━━━\nTNSRUSDT 🔴 Short ×5\n━━━━━━━━━━━━━━━━\n진입가 ${entry} USDT\n현재가 0.05000 USDT\n수량 ${q}`;
 const v=venue(),ex=new CopyExecutor({config:copyConfig({COPY_SIZING:'FIRST_1USD'},'TESTNET'),client:v.client,contractOf:async()=>contract,balance:async()=>({equity:400,available:300}),now:()=>1e12});
 // The first buy: 1 $ of margin (raised to the venue minimum of 2 $ notional when smaller).
 await ex.handle({id:1,date:1e12,text:card(1000,'0.05000')});const first=v.size;assert.ok(first>0);
 assert.ok(first*0.05>=2&&first*0.05/ex.status().positions[0].leverage<=1.05,'about 1 $ of margin');
 // Trader adds 10 (1 % of the first): far below the minimum -> carried, nothing sent.
 const sent=v.calls.length;await ex.handle({id:2,date:1e12+600000,text:card(10,'0.05100')});assert.equal(v.size,first,'carried');
 // Trader adds 1000 (same as the first): about the first quantity again, carry included.
 await ex.handle({id:3,date:1e12+700000,text:card(1000,'0.05200')});assert.ok(v.size>first*1.8,'proportional add: '+v.size);
});

test('copy stop: a venue that refuses the far backstop gets 30 %, then 20 %',async()=>{
 const v=venue(),ex=make(v),place=v.client.placeOrder;
 v.client.placeOrder=async q=>{if(q.type==='STOP_MARKET'&&Number(q.stopPrice)>0.051*1.35)throw Object.assign(Error('trigger price out of range'),{code:'VENUE_ERROR_101204'});return place(q)};
 await ex.handle({id:1,date:1e12,text:OPEN});
 const p=ex.status().positions[0];assert.equal(p.stopDistPctActual,30);assert.ok(Math.abs(p.stop-0.051*1.3)<1e-5);
});

test('copy: SNDKUSDT follows the BingX stock perpetual, PEPEUSDT the 1000-coin contract (quantity / 1000, price x 1000)',async()=>{
 const {resolveCopyContract}=await import('../copy_executor.mjs');
 const m=new Map([['NCSKSNDK2USDUSDT',{symbol:'NCSKSNDK2USDUSDT',venueSymbol:'NCSKSNDK2USD-USDT'}],['1000PEPEUSDT',{symbol:'1000PEPEUSDT',venueSymbol:'1000PEPE-USDT',quantityStep:'1',tickSize:'0.000001',minQuantityBase:'1',minNotionalUSDT:2,tradable:true}]]);
 assert.equal(resolveCopyContract(m,'SNDKUSDT').venueSymbol,'NCSKSNDK2USD-USDT');assert.equal(resolveCopyContract(m,'AKEUSDT'),null);
 const pepe=resolveCopyContract(m,'PEPEUSDT');assert.equal(pepe.unitMultiplier,1000);
 const calls=[];let size=0;
 const client={leverage:async()=>({maxLongLeverage:50}),setMarginType:async()=>({}),setLeverage:async()=>({}),cancelOrder:async()=>({}),
  positions:async()=>size>0?[{symbol:'1000PEPE-USDT',positionAmt:String(size),avgPrice:'0.01',markPrice:'0.01',unrealizedProfit:'0'}]:[],
  placeOrder:async p=>{calls.push(p);if(p.type==='MARKET')size+=Number(p.quantity);return {order:{orderId:String(calls.length)}}}};
 const ex=new CopyExecutor({config:copyConfig({COPY_SIZING:'BALANCE_RATIO'},'TESTNET'),client,contractOf:async()=>pepe,markOf:async()=>0.01,balance:async()=>({equity:400,available:300}),now:()=>1e12});
 // 10,000,000 PEPE at 0.00001 x 0.02 = 200,000 PEPE = 200 contracts of 1000 at 0.01.
 await ex.handle({id:1,date:1e12,text:'📌 포지션 진입\nPEPEUSDT 🟢 Long ×10\n진입가 0.00001 USDT\n현재가 0.00001 USDT\n수량 10000000'});
 assert.equal(calls.find(c=>c.type==='MARKET').quantity,'200');assert.equal(calls.find(c=>c.type==='MARKET').symbol,'1000PEPE-USDT');
});

test('copy: a contract at another price is refused (a stock perpetual matched to a coin of the same letters); an alias without a price is not traded',async()=>{
 const coin={symbol:'NCSKCOIN2USDUSDT',venueSymbol:'NCSKCOIN2USD-USDT',quantityStep:'1',tickSize:'0.01',minQuantityBase:'1',minNotionalUSDT:2,tradable:true,alias:'NCSKCOIN2USDUSDT'};
 const card='📌 포지션 진입\nCOINUSDT 🟢 Long ×10\n진입가 0.05 USDT\n현재가 0.05 USDT\n수량 10000';
 let v=venue(),ex=new CopyExecutor({config:copyConfig({},'TESTNET'),client:v.client,contractOf:async()=>coin,markOf:async()=>250,balance:async()=>({equity:400,available:300}),now:()=>1e12});
 assert.equal((await ex.handle({id:1,date:1e12,text:card})).reason,'PRICE_MISMATCH');assert.equal(v.calls.filter(c=>c.op==='order').length,0);
 v=venue();ex=new CopyExecutor({config:copyConfig({},'TESTNET'),client:v.client,contractOf:async()=>coin,markOf:async()=>null,balance:async()=>({equity:400,available:300}),now:()=>1e12});
 assert.equal((await ex.handle({id:1,date:1e12,text:card})).reason,'PRICE_UNVERIFIED');
 // A 1000-coin card with a 마진 line passes the unit check (coin price used there).
 const {resolveCopyContract}=await import('../copy_executor.mjs');
 const pepe=resolveCopyContract(new Map([['1000PEPEUSDT',{symbol:'1000PEPEUSDT',venueSymbol:'1000PEPE-USDT',quantityStep:'1',tickSize:'0.000001',minQuantityBase:'1',minNotionalUSDT:2,tradable:true}]]),'PEPEUSDT');
 v=venue();ex=new CopyExecutor({config:copyConfig({},'TESTNET'),client:v.client,contractOf:async()=>pepe,markOf:async()=>0.01,balance:async()=>({equity:400,available:300}),now:()=>1e12});
 const r=await ex.handle({id:2,date:1e12,text:'📌 포지션 진입\nPEPEUSDT 🟢 Long ×10\n진입가 0.00001 USDT\n현재가 0.00001 USDT\n수량 10000000\u3000마진 10 USDT'});
 assert.notEqual(r.reason,'QUANTITY_UNIT_UNCLEAR');
});

test('copy stops off by default (user 2026-11-13, testnet): no exchange stop, no zone exit; an old stop is removed; the ledger loss limit stays',async()=>{
 assert.equal(copyConfig({},'TESTNET').stops,false);
 const v=venue();let candles=[];
 const ex=new CopyExecutor({config:copyConfig({COPY_SIZING:'FIRST_1USD'},'TESTNET'),client:v.client,contractOf:async()=>contract,zonesOf:async()=>[{priceLow:.063,priceHigh:.064}],candlesOf:async()=>candles,balance:async()=>({equity:400,available:300}),now:()=>1e12});
 await ex.handle({id:1,date:1e12,text:OPEN});
 assert.equal(v.calls.filter(c=>c.type==='STOP_MARKET').length,0);assert.equal(ex.status().positions[0].stopSource,'NONE');
 const bar=(i,c,vol)=>[1e12-(30-i)*900000,c,c,c,c,vol,1e12-(30-i)*900000+899999];
 candles=[...Array.from({length:29},(_,i)=>bar(i,.06,100)),bar(29,.065,300)];await ex.reconcile();assert.equal(v.size,98,'no zone exit');
 v.unreal='-210';await ex.reconcile();assert.equal(v.size,0,'ledger loss limit still closes');
});

test('real-money copy only with COPY_MODE=LIVE and the confirm phrase; notices use the direction marker',async()=>{
 const {COPY_LIVE_PHRASE}=await import('../copy_executor.mjs');
 assert.equal(copyConfig({COPY_MODE:'LIVE'},'TESTNET').mode,'TESTNET','no phrase: stays testnet');
 assert.equal(copyConfig({COPY_MODE:'LIVE',COPY_LIVE_CONFIRM:'yes'},'OFF').enabled,false);
 const cfg=copyConfig({COPY_MODE:'LIVE',COPY_LIVE_CONFIRM:COPY_LIVE_PHRASE},'TESTNET');assert.equal(cfg.mode,'LIVE');assert.equal(cfg.enabled,true);
 const v=venue();let ex;ex=new CopyExecutor({config:cfg,client:v.client,contractOf:async()=>contract,gate:()=>ex.armed?{ok:true}:{ok:false,reason:'COPY_DISARMED'},balance:async()=>({equity:400,available:300}),now:()=>1e12});
 assert.equal(ex.status().armed,false);await ex.handle({id:1,date:1e12,text:OPEN});assert.equal(v.size,0);
 ex.arm();await ex.handle({id:2,date:1e12+1,text:OPEN.replace('TNSRUSDT','TNSRUSDT')});
 assert.match(copyEventText({type:'OPENED',mode:'LIVE',symbol:'TNSRUSDT',direction:'SHORT',leverage:5,qty:1}),
  /^카피 \| 신규 진입\nTNSRUSDT · 🔴 숏 · 5배/);
 assert.doesNotMatch(copyEventText({type:'ARMED',mode:'LIVE'}),/실계좌/);
});

test('copy MIN_ORDER: the minimum is met at the venue price, a 101400 minimum is retried once, a refused entry leaves no ledger row',async()=>{
 const mk=(v,markOf)=>new CopyExecutor({config:copyConfig({COPY_SIZING:'MIN_ORDER'},'TESTNET'),client:v.client,contractOf:async()=>contract,markOf,balance:async()=>({equity:400,available:300}),now:()=>1e12});
 // Card 0.051, venue 0.0485: 2 USDT x 1.05 / 0.0485 = 43.3 -> 44 coins (the card price alone gave 42).
 let v=venue(),ex=mk(v,async()=>0.0485);await ex.handle({id:1,date:1e12,text:OPEN});
 assert.equal(v.calls.find(c=>c.type==='MARKET').quantity,'44');
 // BingX refuses with its own minimum: one retry at that minimum, a new client id.
 v=venue();let n=0;const place=v.client.placeOrder;v.client.placeOrder=async p=>{if(p.type==='MARKET'&&!p.reduceOnly&&n++===0)throw Object.assign(Error('The minimum order amount is 149 TNSR.'),{code:'VENUE_ERROR_101400'});return place(p)};
 ex=mk(v,async()=>0.051);await ex.handle({id:1,date:1e12,text:OPEN});
 const m=v.calls.filter(c=>c.type==='MARKET');assert.equal(m.length,1);assert.equal(m[0].quantity,'149');assert.equal(ex.status().positions[0].firstQty,149);
 assert.ok(ex.status().events.some(e=>e.type==='ENTRY_RETRY_MIN'));
 // Refused twice: no empty ledger row, and a later change card says why.
 v=venue();v.client.placeOrder=async p=>{if(p.type==='MARKET')throw Object.assign(Error('The minimum order amount is 149 TNSR.'),{code:'VENUE_ERROR_101400'});return {}};
 ex=mk(v,async()=>0.051);await ex.handle({id:1,date:1e12,text:OPEN});
 assert.equal(ex.status().positions.length,0);
 await ex.handle({id:2,date:1e12+60000,text:CHANGE(880,1760)});
 // With late entry on, the add tries again (LATE_ENTRY) and keeps the cause.
 const e=ex.status().events.find(x=>x.reason==='NOT_COPIED'||x.type==='LATE_ENTRY');assert.equal(e.cause,'VENUE_ERROR_101400');assert.match(e.causeDetail,/149/);
 // A minimum above the 5 $ margin limit is not retried.
 v=venue();n=0;v.client.placeOrder=async p=>{if(p.type==='MARKET'&&n++===0)throw Object.assign(Error('The minimum order amount is 9000 TNSR.'),{code:'VENUE_ERROR_101400'});return {}};
 ex=mk(v,async()=>0.051);await ex.handle({id:1,date:1e12,text:OPEN});assert.equal(n,1);assert.equal(ex.status().positions.length,0);
});

test('copy screen: an older "not copied" row without a stored cause shows the earlier failed entry',async()=>{
 const {copyHTML}=await import('../public/live_control.js');
 const events=[{type:'SKIPPED',symbol:'AKEUSDT',reason:'NOT_COPIED',at:3},{type:'ERROR',symbol:'AKEUSDT',kind:'CHANGE',reason:'VENUE_ERROR_101400',detail:'단계 진입 주문 · BingX: The minimum order amount is 182 AKE.',at:2}];
 const html=copyHTML({mode:'LIVE',enabled:true,armed:false,positions:[],closed:[],events});
 assert.match(html,/처음 진입을 .*건너뜀: 거래소 주문 조건 미달/);
});

test('copy: a "- → q" entry refused twice still explains the next change card; the retry respects the copy margin cap',async()=>{
 const chg=(a,b)=>CHANGE(a,b);
 let v=venue();v.client.placeOrder=async p=>{if(p.type==='MARKET')throw Object.assign(Error('The minimum order amount is 149 TNSR.'),{code:'VENUE_ERROR_101400'});return {}};
 let ex=new CopyExecutor({config:copyConfig({},'TESTNET'),client:v.client,contractOf:async()=>contract,markOf:async()=>0.053,balance:async()=>({equity:400,available:300}),now:()=>1e12});
 await ex.handle({id:1,date:1e12,text:chg('-',880)});await ex.handle({id:2,date:1e12+60000,text:chg(880,1760)});
 // With late entry on, the add tries again (LATE_ENTRY) and keeps the cause.
 const e=ex.status().events.find(x=>x.reason==='NOT_COPIED'||x.type==='LATE_ENTRY');assert.equal(e.cause,'VENUE_ERROR_101400');
 // Cap 1 % of 100 = 1 $: the first 42 coins fit, the 149-coin retry (1.5 $) does not.
 v=venue();let n=0;const place=v.client.placeOrder;v.client.placeOrder=async p=>{if(p.type==='MARKET'&&!p.reduceOnly&&n++===0)throw Object.assign(Error('The minimum order amount is 149 TNSR.'),{code:'VENUE_ERROR_101400'});return place(p)};
 ex=new CopyExecutor({config:copyConfig({COPY_SIZING:'MIN_ORDER',COPY_MAX_TOTAL_MARGIN_PCT:'1'},'TESTNET'),client:v.client,contractOf:async()=>contract,markOf:async()=>0.051,balance:async()=>({equity:100,available:90}),now:()=>1e12});
 await ex.handle({id:1,date:1e12,text:OPEN});assert.equal(n,1);assert.equal(v.size,0);assert.equal(ex.status().positions.length,0);
});

test('copy page: recent closes 10 per page with page buttons and the full count (user 2026-11-17)',async()=>{
 const m=await import('../public/live_control.js');
 const c={mode:'LIVE',enabled:true,positions:[],events:[],closed:Array.from({length:23},(_,i)=>({symbol:'S'+i,direction:'LONG',closedAt:Date.now()-i*1e6,netUSD:1})),closedTotal:23};
 m.setCopyPage(0);let h=m.copyHTML(c);assert.match(h,/전체 23건/);assert.match(h,/1 \/ 3쪽/);assert.ok(h.includes('>S9<')&&!h.includes('>S10<'));assert.match(h,/data-copy-page="-1" disabled/);
 m.setCopyPage(9);h=m.copyHTML(c);assert.match(h,/3 \/ 3쪽/,'past the end: last page');assert.ok(h.includes('>S22<')&&!h.includes('>S0<'));
 m.setCopyPage(0);assert.doesNotMatch(m.copyHTML({...c,closed:c.closed.slice(0,5),closedTotal:5}),/copy-pager/);
});

test('copy page: entry failures below the closes with coin, long/short and reason, 10 per page (user 2026-11-17)',async()=>{
 const m=await import('../public/live_control.js');m.setCopyFailPage(0);
 const ev=Array.from({length:14},(_,i)=>({type:'SKIPPED',at:Date.now()-i*1e5,symbol:'C'+i,direction:i%2?'SHORT':'LONG',reason:'MARGIN_SHORT'}));
 const h=m.copyHTML({mode:'LIVE',enabled:true,positions:[],closed:[],events:ev});
 assert.match(h,/진입 실패·건너뜀/);assert.match(h,/전체 14건 · 최근 24시간 14건/);assert.match(h,/1 \/ 3쪽/);assert.ok(h.includes('>C4<')&&!h.includes('>C5<'),'5 per page (2026-11-18)');assert.match(h,/<th>이유<\/th>/);
 assert.match(h,/<details class="fail-box"><summary/,'collapsed by default');m.setFailOpen(true);assert.match(m.copyHTML({mode:'LIVE',enabled:true,positions:[],closed:[],events:ev}),/<details class="fail-box" open>/);m.setFailOpen(false);
 m.setCopyFailPage(2);assert.ok(m.copyHTML({mode:'LIVE',enabled:true,positions:[],closed:[],events:ev}).includes('>C13<'));m.setCopyFailPage(0);
});

// User decision 2026-11-17 ("2,3번 둘다 적용시켜줘") and the review of 080e0da (fail closed, no retry races).
const chgS=(a,b)=>`📊 포지션 변경\n🪙 TNSRUSDT  🔴 Short\n수량 ${a} → ${b}\n현재가 0.05 USDT`;
const CLOSE_S='✅ 포지션 청산\n━━━━━━━━━━━━━━━━\n🪙 TNSRUSDT  🔴 Short\n━━━━━━━━━━━━━━━━\n진입가　0.05296 USDT\n최종손익　🟢 +1.72 USDT';
// Fake BingX (one-way TNSR short) with an order store. lookup: 'none' (no getOrder) | 'store' (80016 when unknown) |
// 'network' | 'absent' (always 80016). History: forceOrders / allOrders (our orders are in it too); history: 'fail' throws.
function bx({lookup='store',history='ok'}={}){
 const calls=[],orders=new Map(),hist=[],force=[];let size=0,id=1,unreal='-0.12',fillFrac=null,emptyReads=0;
 const client={
  leverage:async()=>({maxLongLeverage:20}),setMarginType:async()=>({}),setLeverage:async()=>({}),cancelOrder:async()=>({}),
  positions:async()=>{if(emptyReads>0){emptyReads--;return []}return size>0?[{symbol:'TNSR-USDT',positionAmt:String(-size),avgPrice:'0.051',markPrice:'0.053',unrealizedProfit:unreal}]:[]},
  placeOrder:async p=>{calls.push({...p});
   if(p.type==='MARKET'){let q=Number(p.quantity);if(fillFrac!=null){q=Math.floor(q*fillFrac);fillFrac=null}
    if(p.reduceOnly)size=Math.max(0,+(size-q).toFixed(6));else size=+(size+q).toFixed(6);
    const o={orderId:String(id++),clientOrderId:p.clientOrderId,side:p.side,positionSide:p.positionSide,type:'MARKET',status:q<Number(p.quantity)?'PARTIALLY_FILLED':'FILLED',executedQty:String(q),avgPrice:'0.051',time:1e12};
    orders.set(p.clientOrderId,o);hist.push(o);return {order:o}}
   return {order:{orderId:String(id++)}}},
  forceOrders:async({autoCloseType})=>{if(history==='fail')throw Object.assign(Error('x'),{code:'NETWORK_UNREACHABLE'});return {orders:force.filter(o=>o.autoCloseType===autoCloseType)}},
  allOrders:async()=>{if(history==='fail')throw Object.assign(Error('x'),{code:'NETWORK_UNREACHABLE'});return {orders:hist}}};
 if(lookup!=='none')client.getOrder=async(s,{clientOrderId})=>{
  if(lookup==='network')throw Object.assign(Error('fetch failed'),{code:'NETWORK_UNREACHABLE'});
  const o=lookup==='absent'?null:orders.get(clientOrderId);if(!o)throw Object.assign(Error('order not exist'),{code:'VENUE_ERROR_80016'});return {order:o}};
 return {client,calls,hist,force,
  manualClose(){hist.push({orderId:String(id++),clientOrderId:'',side:'BUY',positionSide:'BOTH',type:'MARKET',status:'FILLED',executedQty:String(size),time:1e12});size=0},
  liquidate(){force.push({orderId:String(id++),autoCloseType:'LIQUIDATION',time:1e12});size=0},
  setSize:v=>{size=v},get size(){return size},set unreal(v){unreal=v},set fillFrac(v){fillFrac=v},set emptyReads(v){emptyReads=v}};
}
const mk=(v,{gate,stops=false}={})=>{const ex=new CopyExecutor({config:copyConfig({COPY_SIZING:'FIRST_1USD',COPY_STOPS:stops?'on':'off'},'TESTNET'),client:v.client,contractOf:async()=>contract,
 balance:async()=>({equity:400,available:300}),gate:gate??(()=>({ok:true})),now:()=>1e12});ex.sleep=async()=>{};return ex};
// Network failure on matching market orders; filledFirst: the request reached the venue before the answer was lost.
function flaky(v,{fail=1,filledFirst=false,match=p=>p.type==='MARKET'&&!p.reduceOnly,code='NETWORK_UNREACHABLE'}={}){
 const place=v.client.placeOrder,attempts=[];let left=fail;
 v.client.placeOrder=async p=>{if(match(p)){attempts.push(p.clientOrderId);if(left>0){left--;if(filledFirst)await place(p);throw Object.assign(Error('fetch failed'),{code})}}return place(p)};
 return attempts;
}
const gone=async(ex)=>{await ex.reconcile();await ex.reconcile()};

test('copy (2026-11-17): after a CONFIRMED manual close the next trader add enters late and the next entry card enters',async()=>{
 const {externalClose}=await import('../copy_executor.mjs');
 const v=bx(),ex=mk(v);await ex.handle({id:1,date:1e12,text:OPEN});v.manualClose();await gone(ex);
 const row=ex.status().closed[0];assert.equal(row.closeReason,'STOP_OR_EXTERNAL');assert.equal(row.closeEvidence.kind,'MANUAL_CLOSE');assert.equal(externalClose(row),true);
 const r=await ex.handle({id:2,date:1e12+60000,text:chgS(880,1760)});
 assert.equal(r.ok,true,JSON.stringify(ex.status().events.slice(0,3)));assert.ok(v.size>0);
 const late=ex.status().events.find(x=>x.type==='LATE_ENTRY');assert.equal(late.cause,'COPY_CLOSED_EXTERNALLY');
 const opened=ex.status().events.find(x=>x.type==='OPENED');assert.equal(opened.late,true);assert.equal(opened.refollow,true);
 assert.match(copyEventText(opened),/다시 진입/);
 const {copyHTML}=await import('../public/live_control.js');
 assert.match(copyHTML({mode:'LIVE',enabled:true,positions:[],closed:[],events:[late]}),/바깥 청산됨 .*트레이더 추매에 다시 따라 들어감/);
 // Found gone when a card came (read twice), confirmed manual: a new entry card enters.
 const v2=bx(),ex2=mk(v2);await ex2.handle({id:1,date:1e12,text:OPEN});v2.manualClose();
 assert.equal((await ex2.handle({id:2,date:1e12+60000,text:chgS(880,1760)})).reason,'POSITION_GONE');
 assert.equal((await ex2.handle({id:3,date:1e12+120000,text:OPEN.replace('0.05296','0.05100')})).ok,true);assert.ok(v2.size>0);
 // A cut after it is not followed; an existing venue position still blocks the re-entry.
 const v3=bx(),ex3=mk(v3);await ex3.handle({id:1,date:1e12,text:OPEN});v3.manualClose();await gone(ex3);
 assert.equal((await ex3.handle({id:2,date:1e12+60000,text:chgS(1760,880)})).reason,'NOT_COPIED');assert.equal(v3.size,0);
 v3.setSize(500);assert.equal((await ex3.handle({id:3,date:1e12+60000,text:chgS(880,1760)})).reason,'VENUE_POSITION_EXISTS');assert.equal(v3.size,500);
});

test('copy (2026-11-17 review): liquidation, ADL, unconfirmed, a failed history query, ours or our stop keep blocking',async()=>{
 const {externalClose}=await import('../copy_executor.mjs');
 for(const r of ['COPY_LOSS_LIMIT','LOSS_CAP_REACHED','NO_STOP','ZONE_BREAK_VOLUME','TRADER_CLOSE','LIQUIDATION','ADL','SOMETHING_NEW'])assert.equal(externalClose({closeReason:r,closeEvidence:{kind:'MANUAL_CLOSE'}}),false,r);
 assert.equal(externalClose({closeReason:'POSITION_GONE'}),false,'no evidence: blocks');
 assert.equal(externalClose({closeReason:'POSITION_GONE',closeEvidence:{kind:'MANUAL_CLOSE'},closing:{reason:'COPY_LOSS_LIMIT'}}),false,'our close under way');
 assert.equal(externalClose({closeReason:'STOP_OR_EXTERNAL',stopOrderId:'7',stop:.07,closeEvidence:{kind:'MANUAL_CLOSE'}}),false,'our exchange stop may have filled');
 const blocked=async(ex,v)=>{assert.equal((await ex.handle({id:2,date:1e12+60000,text:chgS(880,1760)})).reason,'NOT_COPIED');
  assert.equal(ex.status().events.find(x=>x.reason==='NOT_COPIED').cause,'OUR_COPY_CLOSED');
  assert.equal((await ex.handle({id:3,date:1e12+120000,text:OPEN.replace('0.05296','0.05100')})).reason,'OUR_COPY_CLOSED');assert.equal(v.size,0)};
 // R6: vanished with nothing in the history (liquidation-like): unconfirmed, blocked, labelled so.
 let v=bx(),ex=mk(v);await ex.handle({id:1,date:1e12,text:OPEN});v.setSize(0);await gone(ex);
 assert.equal(ex.status().closed[0].closeEvidence.kind,'UNCONFIRMED');await blocked(ex,v);
 const {copyHTML}=await import('../public/live_control.js');
 assert.match(copyHTML({mode:'LIVE',enabled:true,positions:[],closed:[],events:ex.status().events}),/확인 불가로 다시 따라가지 않음/);
 // Only our own ('cp…') orders in the history: unconfirmed.
 v=bx();ex=mk(v);await ex.handle({id:1,date:1e12,text:OPEN});v.client.placeOrder({symbol:'TNSR-USDT',side:'BUY',positionSide:'BOTH',type:'MARKET',quantity:'98',reduceOnly:'true',clientOrderId:'cpdeadbeef'});await gone(ex);
 assert.equal(ex.status().closed[0].closeEvidence.kind,'UNCONFIRMED');
 // A BingX force order: LIQUIDATION, blocked, "강제청산".
 v=bx();ex=mk(v);await ex.handle({id:1,date:1e12,text:OPEN});v.liquidate();await gone(ex);
 const liq=ex.status().closed[0];assert.equal(liq.closeReason,'LIQUIDATION');await blocked(ex,v);
 assert.match(copyEventText(ex.status().events.find(e=>e.type==='CLOSED')),/강제청산/);
 // A manual close the history query cannot confirm (query failed): blocked.
 v=bx({history:'fail'});ex=mk(v);await ex.handle({id:1,date:1e12,text:OPEN});v.manualClose();await gone(ex);
 assert.equal(ex.status().closed[0].closeEvidence.kind,'UNCONFIRMED');await blocked(ex,v);
 // Ledger loss limit, then resume: blocked.
 v=bx();ex=mk(v);await ex.handle({id:1,date:1e12,text:OPEN});v.unreal='-210';await ex.reconcile();
 assert.equal(ex.status().closed[0].closeReason,'COPY_LOSS_LIMIT');ex.resume();await blocked(ex,v);
 // Emergency close (no stop could be placed), and a manual-looking close while our exchange stop was on.
 const v4=venue(),ex4=make(v4);v4.failStop='VENUE_ERROR_101204';await ex4.handle({id:1,date:1e12,text:OPEN});assert.equal(ex4.status().closed[0].closeReason,'NO_STOP');
 assert.equal((await ex4.handle({id:2,date:1e12+60000,text:chgS(880,1760)})).reason,'NOT_COPIED');assert.equal(v4.size,0);
 v=bx();ex=mk(v,{stops:true});await ex.handle({id:1,date:1e12,text:OPEN});v.manualClose();await gone(ex);
 assert.equal(ex.status().closed[0].closeEvidence.kind,'HAD_STOP');await blocked(ex,v);
});

test('copy (2026-11-17): an entry or add lost to a network failure is sent again with the same clientOrderId, once filled',async()=>{
 const v=bx(),ex=mk(v),waits=[];ex.sleep=async ms=>{waits.push(ms)};let tries=flaky(v);
 assert.equal((await ex.handle({id:1,date:1e12,text:OPEN})).ok,true);
 assert.equal(v.size,98,'one fill');assert.equal(tries.length,2);assert.equal(tries[0],tries[1],'same clientOrderId');assert.deepEqual(waits,[2000]);
 const e=ex.status().events.find(x=>x.type==='ENTRY_RETRY');assert.equal(e.attempt,2);assert.equal(e.outcome,'RESENT');assert.equal(e.reason,'NETWORK_UNREACHABLE');
 // An add: fails twice, the third try (after ~2 s and ~5 s) goes through.
 tries=flaky(v,{fail:2});await ex.handle({id:2,date:1e12,text:CHANGE(880,1760)});
 assert.equal(v.size,192);assert.equal(tries.length,3);assert.equal(new Set(tries).size,1);assert.deepEqual(waits,[2000,2000,5000]);
 assert.equal(ex.status().positions[0].adds,1);
 // Three failures: given up after two retries; the next add has a new clientOrderId.
 tries=flaky(v,{fail:3});const r=await ex.handle({id:3,date:1e12,text:CHANGE(1760,3520)});
 assert.equal(r.reason,'NETWORK_UNREACHABLE');assert.equal(tries.length,3);assert.equal(v.size,192);
 const next=flaky(v,{fail:0});await ex.handle({id:4,date:1e12,text:CHANGE(3520,5280)});assert.notEqual(next[0],tries[0]);
 // Past the ~30 s budget: not resent.
 const v2=bx(),ex2=mk(v2);ex2.retryBudgetMs=1000;const t2=flaky(v2);
 assert.equal((await ex2.handle({id:1,date:1e12,text:OPEN})).reason,'NETWORK_UNREACHABLE');assert.equal(t2.length,1);
 assert.equal(ex2.status().events.find(x=>x.type==='ENTRY_RETRY').outcome,'BUDGET');
 // Hedge mode too.
 const h=hedgeVenue(),exh=mk(h);h.client.getOrder=async()=>{throw Object.assign(Error('order not exist'),{code:'VENUE_ERROR_80016'})};const th=flaky(h);
 assert.equal((await exh.handle({id:1,date:1e12,text:OPEN})).ok,true);assert.equal(h.pos.SHORT.amt,98);assert.equal(th.length,2);
});

test('copy (2026-11-17 review): a fill that cannot be ruled out is never sent again (under-fill rather than double fill)',async()=>{
 // Filled before the answer was lost, found by clientOrderId.
 let v=bx(),ex=mk(v);await ex.handle({id:1,date:1e12,text:OPEN});let tries=flaky(v,{filledFirst:true});
 await ex.handle({id:2,date:1e12,text:CHANGE(880,1760)});
 assert.equal(v.size,192);assert.equal(tries.length,1);assert.equal(ex.status().positions[0].adds,1);
 let e=ex.status().events.find(x=>x.type==='ADD_RETRY');assert.equal(e.outcome,'ALREADY_FILLED');assert.equal(e.via,'ORDER');
 // No order lookup on the client: nothing resent; the routine check cannot confirm the entry either, so the venue
 // position is left alone and reported (review 2026-11-17: adopt only a fill shown by the order lookup).
 v=bx({lookup:'none'});ex=mk(v);tries=flaky(v,{filledFirst:true});await ex.handle({id:1,date:1e12,text:OPEN});
 assert.equal(tries.length,1);assert.equal(v.size,98);await ex.reconcile();assert.equal(ex.status().positions.length,0);assert.equal(v.size,98);
 assert.equal(ex.status().events.find(x=>x.type==='UNCONFIRMED_ADOPT').reason,'ENTRY_LOOKUP_FAILED');
 // The lookup was down while sending and works by the routine check: shown filled -> taken over.
 v=bx({lookup:'network'});ex=mk(v);tries=flaky(v,{filledFirst:true});await ex.handle({id:1,date:1e12,text:OPEN});
 assert.equal(ex.status().positions[0].steps.length,0);
 v.client.getOrder=async(s,{clientOrderId})=>({order:{clientOrderId,status:'FILLED',executedQty:'98'}});
 await ex.reconcile();assert.equal(ex.status().positions[0].steps[0].kind,'ADOPTED');assert.equal(ex.status().positions[0].qty,98);
 // R7: a partial fill with the lookup failing: not resent.
 v=bx({lookup:'network'});ex=mk(v);await ex.handle({id:1,date:1e12,text:OPEN});tries=flaky(v,{filledFirst:true});v.fillFrac=.4;
 await ex.handle({id:2,date:1e12+1,text:CHANGE(880,1760)});assert.equal(tries.length,1);assert.ok(v.size<=98+94,'no over-fill: '+v.size);
 // "Does not exist" but the venue size moved: not resent.
 v=bx({lookup:'absent'});ex=mk(v);await ex.handle({id:1,date:1e12,text:OPEN});tries=flaky(v,{filledFirst:true});
 await ex.handle({id:2,date:1e12+1,text:CHANGE(880,1760)});assert.equal(tries.length,1);assert.equal(v.size,192);
 assert.ok(ex.status().events.filter(x=>x.type==='ADD_RETRY').every(x=>x.outcome==='UNVERIFIED'&&x.why==='SIZE_MOVED'));
 // R9: an add that ended unverified does not lend its clientOrderId to the next add.
 v=bx();ex=mk(v);await ex.handle({id:1,date:1e12,text:OPEN});
 const t1=flaky(v,{filledFirst:true});const getOrder=v.client.getOrder,positions=v.client.positions;let down=false;
 v.client.getOrder=async(...a)=>{if(down)throw Object.assign(Error('x'),{code:'NETWORK_UNREACHABLE'});return getOrder(...a)};
 v.client.positions=async s=>{if(down)throw Object.assign(Error('x'),{code:'NETWORK_UNREACHABLE'});return positions(s)};
 ex.sleep=async()=>{down=true};await ex.handle({id:2,date:1e12+1,text:CHANGE(880,1760)});down=false;ex.sleep=async()=>{};
 const t2=flaky(v,{fail:1});await ex.handle({id:3,date:1e12+2,text:CHANGE(1760,2640)});
 e=ex.status().events.find(x=>x.type==='ADD_RETRY');assert.equal(e.outcome,'RESENT');assert.notEqual(t2[0],t1[0]);assert.equal(ex.status().positions[0].qty,v.size);
});

test('copy (2026-11-17): a venue error code is not retried; a lost emergency close is re-read and closed reduce-only',async()=>{
 const v=bx(),ex=mk(v),waits=[];ex.sleep=async ms=>{waits.push(ms)};await ex.handle({id:1,date:1e12,text:OPEN});
 let tries=flaky(v,{code:'VENUE_ERROR_101400'});const r=await ex.handle({id:2,date:1e12,text:CHANGE(880,1760)});
 assert.equal(r.reason,'VENUE_ERROR_101400');assert.equal(tries.length,1);assert.deepEqual(waits,[]);assert.equal(v.size,98);
 tries=flaky(v,{code:'HTTP_500'});await ex.handle({id:3,date:1e12,text:CHANGE(1760,3520)});assert.equal(tries.length,1);assert.deepEqual(waits,[]);
 tries=flaky(v,{match:p=>p.type==='MARKET'&&p.reduceOnly==='true'});v.unreal='-210';await ex.reconcile();
 assert.equal(v.size,0);assert.equal(tries.length,2);assert.equal(ex.status().closed[0].closeReason,'COPY_LOSS_LIMIT');
 assert.ok(v.calls.filter(c=>c.type==='MARKET'&&c.reduceOnly==='true').every(c=>c.quantity==='98'));
 assert.equal(ex.status().events.find(x=>x.type==='CLOSE_RETRY').outcome,'RECHECK');
});

test('copy review R1-R3, R5: the routine check never runs inside a retry wait; a state change in the wait stops the resend',async()=>{
 // R1: the loss limit fires during the add's wait -> it runs after the add; nothing left open anywhere.
 for(const lookup of ['none','store']){
  const v=bx({lookup}),ex=mk(v);await ex.handle({id:1,date:1e12,text:OPEN});flaky(v,{fail:1});
  let q=null;ex.sleep=async()=>{if(q)return;v.unreal='-210';q=ex.reconcile()};
  await ex.handle({id:2,date:1e12+60000,text:CHANGE(880,1760)});await q;
  assert.equal(ex.status().killed,true);assert.equal(ex.status().positions.length,0,lookup);assert.equal(v.size,0,lookup+': no position outside the ledger');
 }
 // ... and when copying stops in the wait (killed), the add is not resent.
 {const v=bx(),ex=mk(v);await ex.handle({id:1,date:1e12,text:OPEN});const t=flaky(v,{fail:1});ex.sleep=async()=>{ex.store.killed=true};
  await ex.handle({id:2,date:1e12+60000,text:CHANGE(880,1760)});assert.equal(t.length,1);assert.equal(v.size,98);
  assert.equal(ex.status().events.find(e=>e.type==='RETRY_ABANDONED').reason,'COPY_LOSS_LIMIT')}
 // R2: kill switch in the wait: the entry is not resent and leaves no ledger row.
 {let killed=false;const v=bx(),ex=mk(v,{gate:()=>killed?{ok:false,reason:'KILL_SWITCH'}:{ok:true}});flaky(v,{fail:1});ex.sleep=async()=>{killed=true};
  const r=await ex.handle({id:1,date:1e12,text:OPEN});assert.equal(r.ok,false);assert.equal(v.size,0);assert.equal(ex.status().positions.length,0)}
 // R3: a pending cut cannot run in the add's wait; the filled add is not sent twice.
 {const v=bx({lookup:'network'}),ex=mk(v);await ex.handle({id:1,date:1e12,text:OPEN});await ex.handle({id:2,date:1e12+1,text:CHANGE(880,1760)});
  const place=v.client.placeOrder;let n=0;v.client.placeOrder=async p=>{if(p.reduceOnly&&n++===0)throw Object.assign(Error('rate'),{code:'HTTP_429'});return place(p)};
  await ex.handle({id:3,date:1e12+2,text:CHANGE(1760,880)});assert.equal(ex.store.pending.length,1);
  const t=flaky(v,{fail:1,filledFirst:true});let q=null;ex.sleep=async()=>{q??=ex.reconcile()};
  await ex.handle({id:4,date:1e12+3,text:CHANGE(880,1760)});await q;assert.equal(t.length,1);assert.equal(ex.status().positions[0].qty,v.size)}
 // R5: an entry retried over two routine checks stays in the ledger; the trader's close closes it.
 {const v=bx(),ex=mk(v);flaky(v,{fail:2});const qs=[];ex.sleep=async()=>{qs.push(ex.reconcile())};
  await ex.handle({id:1,date:1e12,text:OPEN});await Promise.all(qs);
  assert.equal(ex.status().positions.length,1);assert.equal(v.size,98);
  await ex.handle({id:2,date:1e12+60000,text:CLOSE_S});assert.equal(v.size,0);assert.equal(ex.status().closed[0].closeReason,'TRADER_CLOSE')}
 // An inflight position is not counted as gone; a check is not queued twice and keeps idle() false.
 {const v=bx(),ex=mk(v);await ex.handle({id:1,date:1e12,text:OPEN});const p=ex.store.positions['TNSRUSDT|SHORT'];p.inflight=true;v.setSize(0);
  const a=ex.reconcile(),b=ex.reconcile();assert.equal(a,b);assert.equal(ex.idle(),false);await a;assert.equal(ex.idle(),true);await ex.reconcile();
  assert.equal(ex.status().positions.length,1);assert.ok(!p.zeroSeen)}
});

test('copy review R4, R8, R10, R11: our close intent is saved, one empty read is not "gone", one closed row, killed on disk at once',async()=>{
 // R4: a loss-limit close that could not be verified is booked as ours, and blocks after resume.
 {const v=bx({lookup:'network'}),ex=mk(v);await ex.handle({id:1,date:1e12,text:OPEN});
  flaky(v,{fail:1,filledFirst:true,match:p=>p.type==='MARKET'&&p.reduceOnly==='true'});
  const positions=v.client.positions;let down=false;v.client.positions=async s=>{if(down)throw Object.assign(Error('x'),{code:'NETWORK_UNREACHABLE'});return positions(s)};
  ex.sleep=async()=>{down=true};v.unreal='-210';await ex.reconcile();down=false;ex.sleep=async()=>{};
  assert.equal(ex.status().positions[0]?.closing?.reason,'COPY_LOSS_LIMIT');
  await gone(ex);assert.equal(ex.status().closed[0].closeReason,'COPY_LOSS_LIMIT');ex.resume();
  assert.equal((await ex.handle({id:2,date:1e12+60000,text:CHANGE(880,1760)})).reason,'NOT_COPIED');assert.equal(v.size,0)}
 // A loss-limit close the venue refused is closed again by the next routine check.
 {const v=bx(),ex=mk(v);await ex.handle({id:1,date:1e12,text:OPEN});flaky(v,{code:'HTTP_429',match:p=>p.type==='MARKET'&&p.reduceOnly==='true'});
  v.unreal='-210';await ex.reconcile();assert.equal(v.size,98);await ex.reconcile();assert.equal(v.size,0);assert.equal(ex.status().closed[0].closeReason,'COPY_LOSS_LIMIT')}
 // R8: one empty read on an add card: read again, the add goes on.
 {const v=bx(),ex=mk(v);await ex.handle({id:1,date:1e12,text:OPEN});v.emptyReads=1;
  const r=await ex.handle({id:2,date:1e12+1,text:CHANGE(880,1760)});assert.equal(r.ok,true);assert.equal(v.size,192);
  assert.equal(ex.status().closed.length,0);assert.equal(ex.status().positions[0].qty,192)}
 // R10: the trader's close card during the emergency retry: one closed row.
 {const v=bx(),ex=mk(v);await ex.handle({id:1,date:1e12,text:OPEN});
  flaky(v,{fail:1,filledFirst:true,match:p=>p.type==='MARKET'&&p.reduceOnly==='true'});
  let q=null;ex.sleep=async()=>{q??=ex.handle({id:2,date:1e12+60000,text:CLOSE_S})};
  v.unreal='-210';await ex.reconcile();await q;assert.equal(ex.status().closed.length,1);assert.equal(v.size,0)}
 // R11: killed is on disk before the emergency close is sent.
 {const dir=fs.mkdtempSync(path.join(os.tmpdir(),'copy-r11-'));const v=bx();
  const ex=new CopyExecutor({config:copyConfig({COPY_SIZING:'FIRST_1USD'},'TESTNET'),client:v.client,contractOf:async()=>contract,balance:async()=>({equity:400,available:300}),directory:dir,now:()=>1e12});
  await ex.handle({id:1,date:1e12,text:OPEN});flaky(v,{fail:1,match:p=>p.type==='MARKET'&&p.reduceOnly==='true'});
  let onDisk=null;ex.sleep=async()=>{onDisk??=JSON.parse(fs.readFileSync(path.join(dir,'copy-store.json'),'utf8'))};
  v.unreal='-210';await ex.reconcile();assert.equal(onDisk.killed,true);assert.equal(Object.values(onDisk.positions)[0].closing.reason,'COPY_LOSS_LIMIT');
  fs.rmSync(dir,{recursive:true,force:true})}
});

test('BingX client: open orders, liquidation / ADL orders and order history are read-only GET calls',async()=>{
 const {BingXTradeClient}=await import('../live_clients.mjs');const seen=[];
 const c=new BingXTradeClient({apiKey:'k',secret:'s',mode:'TESTNET',fetcher:async(url,o)=>{seen.push([o.method,new URL(url)]);return new Response(JSON.stringify({code:0,data:{orders:[]}}),{status:200})}});
 await c.forceOrders({symbol:'BTC-USDT',autoCloseType:'ADL',startTime:1,endTime:2});await c.allOrders({symbol:'BTC-USDT',startTime:1,endTime:2});
 await c.openOrders('IRYS-USDT');await c.openOrders();
 assert.deepEqual(seen.map(([m,u])=>[m,u.pathname]),[['GET','/openApi/swap/v2/trade/forceOrders'],['GET','/openApi/swap/v2/trade/allOrders'],
  ['GET','/openApi/swap/v2/trade/openOrders'],['GET','/openApi/swap/v2/trade/openOrders']]);
 assert.equal(seen[0][1].searchParams.get('autoCloseType'),'ADL');assert.equal(seen[1][1].searchParams.get('limit'),'500');
 assert.equal(seen[2][1].searchParams.get('symbol'),'IRYS-USDT');
 assert.equal(seen[3][1].searchParams.has('symbol'),false);
});

// Second review of 4ebc7aa (N1-N4, adopt).
function bx2(opts={}){const v=bx(opts);v.force.length=0;
 v.liquidateAsMarket=()=>{const o={orderId:'L'+v.hist.length,clientOrderId:'',side:'BUY',positionSide:'BOTH',type:'MARKET',status:'FILLED',executedQty:String(v.size),time:1e12};v.hist.push(o);v.force.push({...o,autoCloseType:'LIQUIDATION'});v.setSize(0)};
 return v}

test('copy review N1: a history answer of an unknown shape is not "no liquidation": unconfirmed, blocked',async()=>{
 for(const shape of [{list:[]},{data:[]},null,'x',{orders:'x'}]){
  const v=bx2();const real=v.client.forceOrders;v.client.forceOrders=async q=>{await real(q);return shape};
  const ex=mk(v);await ex.handle({id:1,date:1e12,text:OPEN});v.liquidateAsMarket();await gone(ex);
  const row=ex.status().closed[0];assert.equal(row.closeEvidence.kind,'UNCONFIRMED',JSON.stringify(shape));assert.equal(row.closeEvidence.why,'UNEXPECTED_HISTORY_SHAPE');
  assert.equal((await ex.handle({id:2,date:1e12+60000,text:chgS(880,1760)})).reason,'NOT_COPIED');assert.equal(v.size,0);
 }
 // The same with allOrders; {orders:null} (none) is a valid empty answer.
 let v=bx2();v.client.allOrders=async()=>({rows:[]});let ex=mk(v);await ex.handle({id:1,date:1e12,text:OPEN});v.manualClose();await gone(ex);
 assert.equal(ex.status().closed[0].closeEvidence.why,'UNEXPECTED_HISTORY_SHAPE');
 v=bx2();v.client.forceOrders=async()=>({orders:null});ex=mk(v);await ex.handle({id:1,date:1e12,text:OPEN});v.manualClose();await gone(ex);
 assert.equal(ex.status().closed[0].closeEvidence.kind,'MANUAL_CLOSE');
 // The expected shape still finds the liquidation.
 v=bx2();ex=mk(v);await ex.handle({id:1,date:1e12,text:OPEN});v.liquidateAsMarket();await gone(ex);assert.equal(ex.status().closed[0].closeReason,'LIQUIDATION');
});

test('copy review N2, N4: no add into a position being closed; a refused emergency close is noticed once per 10 minutes',async()=>{
 const v=bx(),logs=[];let t=1e12;const ex=new CopyExecutor({config:copyConfig({COPY_SIZING:'FIRST_1USD'},'TESTNET'),client:v.client,contractOf:async()=>contract,
  balance:async()=>({equity:400,available:300}),now:()=>t,log:m=>logs.push(m)});ex.sleep=async()=>{};
 await ex.handle({id:1,date:1e12,text:OPEN});
 flaky(v,{fail:99,code:'VENUE_ERROR_101205',match:p=>p.type==='MARKET'&&p.reduceOnly==='true'});
 v.unreal='-210';await ex.reconcile();assert.equal(ex.store.positions['TNSRUSDT|SHORT'].closing.reason,'COPY_LOSS_LIMIT');
 ex.resume();v.unreal='-0.1';
 const r=await ex.handle({id:2,date:1e12+60000,text:CHANGE(880,1760)});assert.equal(r.reason,'CLOSING');assert.equal(v.size,98);
 assert.equal(ex.status().events.find(e=>e.type==='ADD_SKIPPED').reason,'CLOSING');
 // Five more checks within 10 minutes: one notice, each logged; after 10 minutes a second notice.
 for(let i=0;i<5;i++){t+=60000;await ex.reconcile()}
 const notices=()=>ex.status().events.filter(e=>e.type==='ERROR'&&e.kind==='EMERGENCY_CLOSE').length;
 assert.equal(notices(),1);assert.equal(logs.filter(m=>/EMERGENCY_CLOSE .*repeat/.test(m)).length,5);
 t+=600000;await ex.reconcile();assert.equal(notices(),2);
});

test('copy review N3, adopt: an entry whose answer was lost is looked up before it is dropped or taken over',async()=>{
 // Filled but its answer lost (lookup down while sending), then liquidated before the check: booked LIQUIDATION, blocked.
 let v=bx2({lookup:'network'}),ex=mk(v);flaky(v,{fail:1,filledFirst:true});await ex.handle({id:1,date:1e12,text:OPEN});
 const getOrder=async(s,{clientOrderId})=>{const o=v.hist.find(x=>x.clientOrderId===clientOrderId);if(!o)throw Object.assign(Error('order not exist'),{code:'VENUE_ERROR_80016'});return {order:o}};
 v.client.getOrder=getOrder;v.liquidateAsMarket();await gone(ex);
 assert.equal(ex.status().closed.length,1);assert.equal(ex.status().closed[0].closeReason,'LIQUIDATION');
 assert.equal((await ex.handle({id:2,date:1e12+60000,text:chgS(880,1760)})).reason,'NOT_COPIED');assert.equal(v.size,0);
 // Lookup still failing at the check: not dropped silently either (classified, unconfirmed -> blocks).
 v=bx2({lookup:'network'});ex=mk(v);flaky(v,{fail:1,filledFirst:true});await ex.handle({id:1,date:1e12,text:OPEN});v.setSize(0);await gone(ex);
 assert.equal(ex.status().closed[0].closeEvidence.kind,'UNCONFIRMED');assert.ok(!ex.status().events.some(e=>e.type==='ENTRY_NOT_FILLED'));
 // BingX says the entry order does not exist and nothing is on the venue: dropped (ENTRY_NOT_FILLED), no closed row.
 v=bx2({lookup:'network'});ex=mk(v);flaky(v,{fail:1});await ex.handle({id:1,date:1e12,text:OPEN});v.client.getOrder=getOrder;await gone(ex);
 assert.equal(ex.status().closed.length,0);assert.equal(ex.status().positions.length,0);assert.ok(ex.status().events.some(e=>e.type==='ENTRY_NOT_FILLED'));
 // A venue position whose entry order does not exist (a manual position): not adopted, left alone, reported.
 v=bx2({lookup:'network'});ex=mk(v);flaky(v,{fail:1});await ex.handle({id:1,date:1e12,text:OPEN});v.client.getOrder=getOrder;v.setSize(500);
 await ex.reconcile();assert.equal(ex.status().positions.length,0);assert.equal(v.size,500);
 const e=ex.status().events.find(x=>x.type==='UNCONFIRMED_ADOPT');assert.equal(e.reason,'ENTRY_ORDER_NOT_FOUND');assert.match(copyEventText(e),/직접 확인/);
});

test('real copy does not dispatch a pending entry or add after a stop, and still follows a close',async()=>{
 for(const [kind,stop] of [['entry','disarm'],['add','disarm'],['entry','global kill reset']]){
  const v=venue(),waiting=Promise.withResolvers(),resume=Promise.withResolvers();
  let ex,pause=false,gateRevision=0;
  const cfg=copyConfig({COPY_MODE:'LIVE',COPY_LIVE_CONFIRM:'REAL_MONEY_COPY'},'OFF');
  ex=new CopyExecutor({config:cfg,client:v.client,contractOf:async()=>contract,now:()=>1e12,
   gate:()=>ex.armed?{ok:true}:{ok:false,reason:'COPY_DISARMED'},entryGateRevision:()=>gateRevision,
   balance:async()=>{if(pause){waiting.resolve();await resume.promise}return {equity:2000,available:1500}}});
  ex.arm();
  if(kind==='add')assert.equal((await ex.handle({id:1,date:1e12,text:OPEN})).ok,true);
  const size=v.size,orders=v.calls.filter(c=>c.type==='MARKET').length;
  pause=true;
  const pending=ex.handle({id:2,date:1e12,text:kind==='add'?CHANGE(880,1760):OPEN});
  await waiting.promise;
  if(stop==='disarm')ex.disarm();else gateRevision++;
  resume.resolve();
  assert.equal((await pending).reason,stop==='disarm'?'COPY_DISARMED':'ENTRY_INTERRUPTED');
  assert.equal(v.size,size);
  assert.equal(v.calls.filter(c=>c.type==='MARKET').length,orders);
  assert.equal(ex.status().positions.length,kind==='add'?1:0);
  if(kind==='add'){
   assert.equal((await ex.handle({id:3,date:1e12,text:CLOSE})).ok,true);
   assert.equal(v.size,0);
  }
 }
});

test('copy blocks new risk when either balance field is unverified; a known zero is insufficient margin',async()=>{
 const cfg=copyConfig({COPY_MODE:'LIVE',COPY_LIVE_CONFIRM:'REAL_MONEY_COPY'},'OFF');
 for(const [balance,reason] of [
  [async()=>{throw Error('unavailable')},'NO_BALANCE'],
  [async()=>({equity:2000}),'NO_BALANCE'],
  [async()=>({equity:2000,available:null}),'NO_BALANCE'],
  [async()=>({equity:2000,available:0}),'MARGIN_SHORT'],
 ]){
  const v=venue();
  let healthy=true;
  const ex=new CopyExecutor({config:cfg,client:v.client,contractOf:async()=>contract,
   balance:async()=>healthy?{equity:2000,available:1500}:balance(),now:()=>1e12});
  healthy=false;
  assert.equal((await ex.handle({id:1,date:1e12,text:OPEN})).reason,reason);
  assert.equal(v.size,0);
  healthy=true;
  assert.equal((await ex.handle({id:2,date:1e12,text:OPEN})).ok,true);
  const size=v.size;
  healthy=false;
  assert.equal((await ex.handle({id:3,date:1e12,text:CHANGE(880,1760)})).reason,reason);
  assert.equal(v.size,size);
 }
});

test('hedge-mode copy settlement recovers manual adds and closes on the isolated hedge lane (ETHUSDT 11/21 scenario) without mixing opposite side',async()=>{
 for(const hasOverlap of [false,true]){
  const v=venue({hedge:true}),ex=make(v,{config:{mode:'LIVE',stops:false}});ex.goneRecheckMs=0;
  const openAt=1e12,closeAt=1e12+60000;
  ex.now=()=>openAt;
  const p={
   id:'cp-eth-long',symbol:'ETHUSDT',venueSymbol:'ETH-USDT',direction:'LONG',hedge:true,
   leverage:80,openedAt:openAt,closedAt:closeAt,status:'CLOSED',closeReason:'STOP_OR_EXTERNAL',
   fillTracked:true,fillOrders:[{id:'copy-buy-1',side:'BUY',confirmed:true}],
   entryCids:['cp-eth-open'],netSource:'UNKNOWN',netUSD:null,
   settlement:{state:'QUANTITY_MISMATCH',checkedAt:closeAt+15000},
  };
  ex.store.closed.push(p);
  if(hasOverlap){
   ex.store.closed.push({
    id:'cp-eth-long-overlap',symbol:'ETHUSDT',venueSymbol:'ETH-USDT',direction:'LONG',hedge:true,
    openedAt:openAt+10000,closedAt:closeAt-5000,status:'CLOSED',netSource:'EXCHANGE_FILLS',netUSD:1,
   });
  }
  const symbol='ETH-USDT';
  v.client.allOrders=async()=>({orders:[
   {orderId:'copy-buy-1',symbol,side:'BUY',positionSide:'LONG',executedQty:'2',updateTime:openAt,status:'FILLED',clientOrderId:'cp-eth-open'},
   {orderId:'manual-buy-add',symbol,side:'BUY',positionSide:'LONG',executedQty:'8',updateTime:openAt+20000,status:'FILLED',clientOrderId:'man-1'},
   {orderId:'manual-sell-close',symbol,side:'SELL',positionSide:'LONG',executedQty:'10',updateTime:closeAt+1000,status:'FILLED',clientOrderId:'man-2'},
   // Opposite hedge lane SHORT (-$355) MUST NEVER contaminate LONG settlement
   {orderId:'opp-short-open',symbol,side:'SELL',positionSide:'SHORT',executedQty:'10.4',updateTime:openAt+30000,status:'FILLED'},
   {orderId:'opp-short-close',symbol,side:'BUY',positionSide:'SHORT',executedQty:'10.4',updateTime:closeAt-2000,status:'FILLED'},
  ]});
  v.client.fillHistory=async()=>[
   {orderId:'copy-buy-1',tradeId:'t1',symbol,side:'BUY',qty:2,price:'1600',fee:'-1.5',realizedPnl:0,time:openAt},
   {orderId:'manual-buy-add',tradeId:'t2',symbol,side:'BUY',qty:8,price:'1600',fee:'-6.0',realizedPnl:0,time:openAt+20000},
   {orderId:'manual-sell-close',tradeId:'t3',symbol,side:'SELL',qty:10,price:'1640',fee:'-8.0',realizedPnl:400,time:closeAt+1000},
   {orderId:'opp-short-open',tradeId:'t4',symbol,side:'SELL',qty:10.4,price:'1581.91',fee:'-8.0',realizedPnl:0,time:openAt+30000},
   {orderId:'opp-short-close',tradeId:'t5',symbol,side:'BUY',qty:10.4,price:'1615',fee:'-8.0',realizedPnl:-355,time:closeAt-2000},
  ];
  ex.now=()=>closeAt+30000;
  await ex.settle({recheck:true});
  if(!hasOverlap){
   assert.equal(p.netSource,'EXCHANGE_FILLS');
   assert.equal(p.settlement.state,'CONFIRMED');
   assert.equal(p.pnlUSD,400);
   assert.equal(p.feeUSD,-15.5);
   assert.equal(p.netUSD,384.5);
  }else{
   assert.equal(p.netSource,'UNKNOWN');
   assert.equal(p.settlement.state,'QUANTITY_MISMATCH');
  }
 }
});

test('Astra audit regressions: idempotent partial reduce, exact partial fill qty, entry/kill restart recovery, 201+ trade PnL, and LiveExecutor mode isolation',async()=>{
 const {copyStats}=await import('../public/live_control.js');
 const {LiveExecutor}=await import('../live_executor.mjs');

 // 1) Partial reduce idempotency & partial fill exact executedQty
 {
  const v=venue();
  const ex=make(v,{config:{stops:true}});
  await ex.handle({id:1,date:1e12,text:OPEN}); // opens 98
  assert.equal(v.size,98);
  // Make the post-cut #protect position read fail once, then retry the same reduction message
  const origPos=v.client.positions;
  let posCalls=0;
  v.client.positions=async(...a)=>{
   posCalls++;
   if(posCalls===2)throw Object.assign(Error('timeout'),{code:'NETWORK_UNREACHABLE'});
   return origPos(...a);
  };
  await ex.handle({id:2,date:1e12+1000,text:CHANGE(880,440)});
  v.client.positions=origPos;
  //Even if the same reduction is retried, it must NOT sell another half
  await ex.handle({id:3,date:1e12+2000,text:CHANGE(880,440)});
  assert.equal(v.size,49,'position stays at 49, never double-reduced');

  // Partial fill: 49 requested, only 24 filled -> step records 24
  const v2=venue();
  const origPlace=v2.client.placeOrder;
  v2.client.placeOrder=async p=>{
   if(p.type==='MARKET'&&p.reduceOnly){
    v2.setSize(v2.size-24);
    return {order:{orderId:'partial-24',avgPrice:'0.051',executedQty:'24',status:'PARTIALLY_FILLED'}};
   }
   return origPlace(p);
  };
  const ex2=make(v2,{config:{stops:false}});
  await ex2.handle({id:10,date:1e12,text:OPEN});
  await ex2.handle({id:11,date:1e12+1000,text:CHANGE(880,440)});
  const redStep=ex2.store.positions['TNSRUSDT|SHORT'].steps.find(s=>s.kind==='REDUCE');
  assert.equal(redStep.qty,24,'records actual filled 24 rather than requested 49');
 }

 // 2) Entry crash before response & COPY_LOSS_LIMIT restart with 2 open positions
 {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'copy-audit-'));
  try{
   const v=venue();
   v.client.positionMode=async()=>({dualSidePosition:false});
   const origPlace=v.client.placeOrder;
   let lastCid=null;
   v.client.placeOrder=async p=>{
    lastCid=p.clientOrderId;
    await origPlace(p);
    throw Object.assign(Error('simulated crash before response'),{code:'NETWORK_UNREACHABLE'});
   };
   const ex1=new CopyExecutor({config:copyConfig({COPY_SIZING:'FIRST_1USD'},'TESTNET'),client:v.client,contractOf:async()=>contract,balance:async()=>({equity:400,available:300}),directory:dir,retryDelaysMs:[],now:()=>1e12});
   await ex1.handle({id:1,date:1e12,text:OPEN});
   // Restart from disk: entryCids is persisted on disk even though placeOrder threw before returning!
   v.client.placeOrder=origPlace;
   v.client.getOrder=async(s,{clientOrderId})=>clientOrderId===lastCid?{order:{orderId:'1',clientOrderId,status:'FILLED',executedQty:'98',avgPrice:'0.051'}}:null;
   const ex2=new CopyExecutor({config:copyConfig({COPY_SIZING:'FIRST_1USD'},'TESTNET'),client:v.client,contractOf:async()=>contract,balance:async()=>({equity:400,available:300}),directory:dir,now:()=>1e12+5000});
   await ex2.reconcile();
   assert.equal(ex2.status().positions.length,1);
   await ex2.handle({id:2,date:1e12+6000,text:CLOSE});
   assert.equal(v.size,0,'restarted executor adopts filled entry from disk entryCids and closes it on trader CLOSE');
  }finally{fs.rmSync(dir,{recursive:true,force:true})}
 }

 // 3) 201 closed trades (-$500 first, then 200 x +$1 = -$300 net)
 {
  const v=venue(),ex=make(v);
  ex.store.closed=[
   {id:'c0',symbol:'BTCUSDT',direction:'LONG',openedAt:1000,closedAt:2000,netUSD:-500,netSource:'EXCHANGE_FILLS'},
   ...Array.from({length:200},(_,i)=>({id:'c'+(i+1),symbol:'BTCUSDT',direction:'LONG',openedAt:3000+i*10,closedAt:3005+i*10,netUSD:1,netSource:'EXCHANGE_FILLS'})),
  ];
  const st=copyStats(ex.status(),{confirmedOnly:true});
  assert.equal(st.all.n,201);
  assert.equal(st.all.net,-300,'cumulative PnL includes trade #1 (-$500) + 200*(+$1) = -$300');
 }

 // 4) LiveExecutor: TESTNET records never touch LIVE client, {positions:[...]} is unwrapped, and 300 closed trades never prune an old OPEN record
 {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'live-audit-'));
  try{
   fs.writeFileSync(path.join(dir,'live-orders.json'),JSON.stringify({
    version:1,killSwitch:false,deletedKeys:[],archived:[],
    records:[
     {signalKey:'tn-open',symbol:'BTCUSDT',venueSymbol:'BTC-USDT',venue:'BINGX',mode:'TESTNET',direction:'LONG',status:'OPEN',stop:90,targets:[110,115,120],quantity:{total:10,parts:[4,3.5,2.5],riskUSD:10},plannedRiskUSD:10,events:[]},
     ...Array.from({length:305},(_,i)=>({signalKey:'c'+i,symbol:'ETHUSDT',venueSymbol:'ETH-USDT',venue:'BINGX',mode:'TESTNET',direction:'LONG',status:'CLOSED',closedAt:1000+i,plannedRiskUSD:5,events:[]})),
    ],
   }));
   let liveOrdersSent=0;
   const liveClient={positions:async()=>({positions:[{symbol:'BTC-USDT',positionAmt:'4',avgPrice:'100'}]}),openOrders:async()=>({orders:[]}),placeOrder:async()=>{liveOrdersSent++;return {order:{orderId:'1'}}},cancelOrder:async()=>({})};
   const exLive=new LiveExecutor({config:{mode:'LIVE',liveConfirmed:false,venues:['BINGX']},clients:{BINGX:liveClient},directory:dir});
   await exLive.reconcile();
   assert.equal(liveOrdersSent,0,'TESTNET records never trigger orders on LIVE client');

   // On TESTNET, the old OPEN record is preserved across 305 closed records and {positions:[...]} keeps it open
   let cancelled=0;
   const tnClient={positions:async()=>({positions:[{symbol:'BTC-USDT',positionAmt:'10',avgPrice:'100'}]}),openOrders:async()=>({orders:[]}),placeOrder:async()=>({order:{orderId:'s1'}}),cancelOrder:async()=>{cancelled++;return {}}};
   const exTn=new LiveExecutor({config:{mode:'TESTNET',venues:['BINGX']},clients:{BINGX:tnClient},directory:dir});
   exTn.store.records[0].stopOrderId='stop-1';
   exTn.store.records[0].recovery='DONE';
   await exTn.reconcile();
   assert.equal(cancelled,0,'{positions:[...]} payload is unwrapped and never treated as size 0');
   assert.equal(exTn.budgetSource().openRisk(),10,'old OPEN record is never pruned by 300+ newer CLOSED records');
  }finally{fs.rmSync(dir,{recursive:true,force:true})}
 }
});

test('fast copy execution: instant MARKET default, skips unused zonesOf, deduplicates balance read, caches setup, skips redundant post-fill/close polls, and prioritizes BingX orders',async()=>{
 const {BingXTradeClient}=await import('../live_clients.mjs');
 const {CopyControls}=await import('../copy_controls.mjs');

 // 1) LIVE config defaults to instant MARKET (makerFirst: false) for lowest latency
 const liveCfg=copyConfig({COPY_MODE:'LIVE',COPY_LIVE_CONFIRM:'REAL_MONEY_COPY'},'OFF');
 assert.equal(liveCfg.makerFirst,false,'LIVE copy defaults to instant market');
 assert.equal(liveCfg.makerWaitMs,1000,'makerWaitMs lowered to 1000ms when opted in');

 // 2) Fast entry & close path: 0 zonesOf calls, 1 balance read, cached setup on 2nd entry, 0ms recheck sleep on FILLED close
 let zonesCalls=0,balCalls=0,posCalls=0,modeCalls=0,levReadCalls=0,marginSetCalls=0,levSetCalls=0,sleepCalls=0;
 let amt=0,oid=1;
 const client={
  positionMode:async()=>{modeCalls++;return {dualSidePosition:true}},
  leverage:async()=>{levReadCalls++;return {maxLongLeverage:20,maxShortLeverage:20}},
  setMarginType:async()=>{marginSetCalls++;return {}},
  setLeverage:async()=>{levSetCalls++;return {}},
  positions:async()=>{posCalls++;return amt>0?[{symbol:'TNSR-USDT',positionSide:'SHORT',positionAmt:String(amt),avgPrice:'0.051',markPrice:'0.051',unrealizedProfit:'0.4'}]:[]},
  placeOrder:async p=>{
   const q=Number(p.quantity);
   if(p.side==='SELL')amt=+(amt+q).toFixed(6);
   else amt=Math.max(0,+(amt-q).toFixed(6));
   return {order:{orderId:String(oid++),status:'FILLED',executedQty:String(q),avgPrice:'0.051'}};
  },
  cancelOrder:async()=>({}),
 };
 const controls=new CopyControls();
 const ex=new CopyExecutor({
  config:liveCfg,client,controls,
  contractOf:async()=>contract,
  markOf:async()=>0.051,
  zonesOf:async()=>{zonesCalls++;return [{priceLow:0.04,priceHigh:0.045}]},
  balance:async()=>{balCalls++;return {equity:2000,available:1500}},
  gate:()=>({ok:true}),
  sleep:async()=>{sleepCalls++},
  now:()=>1e12,
 });
 // Entry #1
 const r1=await ex.handle({id:1,date:1e12,text:OPEN});
 assert.equal(r1.ok,true);
 assert.equal(typeof r1.execMs,'number');
 assert.equal(zonesCalls,0,'zonesOf skipped completely when stops=false');
 assert.equal(balCalls,1,'single balance read per entry (no duplicate in #orderMargin)');
 assert.equal(posCalls,1,'post-fill positions() skipped when FILLED receipt carries qty+avg');
 assert.equal(ex.status().executionMode,'INSTANT');
 assert.match(copyEventText(ex.status().events.find(e=>e.type==='OPENED')),/⚡ \d+\.\d{2}초/);

 // Close #1: FILLED full close completes immediately without extra positions() or 1000ms recheck sleep
 const posBeforeClose=posCalls;
 const rc=await ex.handle({id:2,date:1e12+1000,text:CLOSE});
 assert.equal(rc.ok,true);
 assert.equal(posCalls,posBeforeClose+1,'only pre-close positions() read, no post-close recheck');
 assert.equal(sleepCalls,0,'zero 1000ms #recheck sleep on confirmed FILLED close');

 // Entry #2 on same symbol/side/leverage reuses cached positionMode, maxLeverage, setMarginType, setLeverage
 const r2=await ex.handle({id:3,date:1e12+2000,text:OPEN});
 assert.equal(r2.ok,true);
 assert.equal(modeCalls,1,'positionMode cached');
 assert.equal(levReadCalls,1,'maxLeverage cached');
 assert.equal(marginSetCalls,1,'setMarginType cached');
 assert.equal(levSetCalls,1,'setLeverage cached');

 // Runtime toggle switches to MAKER_FIRST cleanly
 controls.configure({executionMode:'MAKER_FIRST'});
 assert.equal(ex.status().executionMode,'MAKER_FIRST');

 // 3) BingXTradeClient priority lane: POST order jumps ahead of queued GET reads
 const prevGap=process.env.BINGX_MIN_INTERVAL_MS;
 process.env.BINGX_MIN_INTERVAL_MS='15';
 try{
  const order=[];
  const mockFetch=async(url,init)=>{
   const tag=init.method==='POST'?'POST':'GET';
   order.push(`${tag}:${new URL(url).pathname.split('/').pop()}`);
   return new Response(JSON.stringify({code:0,data:{}}),{status:200,headers:{'content-type':'application/json'}});
  };
  const bx=new BingXTradeClient({apiKey:'k',secret:'s',mode:'TESTNET',fetcher:mockFetch});
  // Queue 3 GETs and then immediately dispatch a POST order
  const p1=bx.positions();
  const p2=bx.balance();
  const p3=bx.openOrders('BTC-USDT');
  const pOrder=bx.placeOrder({symbol:'BTC-USDT',side:'BUY',type:'MARKET',quantity:'1'});
  await Promise.all([p1,p2,p3,pOrder]);
  // First GET starts immediately; POST jumps ahead of the remaining queued GETs!
  assert.equal(order[0],'GET:positions');
  assert.equal(order[1],'POST:order','POST order preempts queued GET reads');
 }finally{
  if(prevGap===undefined)delete process.env.BINGX_MIN_INTERVAL_MS;
  else process.env.BINGX_MIN_INTERVAL_MS=prevGap;
 }
});


test('copy loss limit is off by default (user 2026-11-23 "다 없애 필요없어"): a deep open loss closes nothing and does not stop the copy',async()=>{
 assert.equal(copyConfigRaw({},'TESTNET').ledgerLossPct,0);
 assert.equal(copyConfigRaw({COPY_LEDGER_LOSS_PCT:'50'},'TESTNET').ledgerLossPct,50);
});

test('live copy enters and adds when only unfilled resting manual LIMIT orders exist (Signal Lab or BingX app), while still blocking copy-owned or filled orders',async()=>{
 // 1) One-way mode: Signal Lab manual LIMIT ('man...') and BingX app LIMIT / TRIGGER_LIMIT do not block entry or adds
 const v=venue();
 let orders=[
  {symbol:'TNSR-USDT',orderId:'m1',clientOrderId:'manm9abc123',type:'LIMIT',side:'SELL',positionSide:'BOTH',price:'0.06',origQty:'50',executedQty:'0',status:'NEW',reduceOnly:'false'},
  {symbol:'TNSR-USDT',orderId:'m2',type:'TRIGGER_LIMIT',side:'BUY',positionSide:'BOTH',price:'0.04',origQty:'50',executedQty:'0',status:'NEW'},
 ];
 v.client.openOrders=async()=>({orders});
 const ex=make(v,{config:{mode:'LIVE',stops:false},auditOrders:true});
 await ex.reconcile();
 const openRes=await ex.handle({id:1,date:1e12,text:OPEN});
 assert.equal(openRes.ok,true,'resting unfilled manual LIMIT orders must not block live copy entry');
 await ex.reconcile();
 assert.deepEqual(ex.auditStatus().lanes[0].issues,[],'resting unfilled manual LIMIT orders must not trigger UNEXPECTED_OPEN_ORDER');
 assert.equal(ex.auditStatus().lanes[0].blocked,false);
 const addRes=await ex.handle({id:2,date:1e12+1000,text:CHANGE(880,1760)});
 assert.equal(addRes.ok,true,'copy add must succeed while manual LIMIT order remains unfilled');

 // 2) Copy's own orphaned PostOnly LIMIT order (clientOrderId starting with 'cp') STILL blocks adds and new entries
 orders=[{symbol:'TNSR-USDT',orderId:'c1',clientOrderId:'cp1234567890p',type:'LIMIT',side:'SELL',positionSide:'BOTH',executedQty:'0',status:'NEW'}];
 await ex.reconcile();
 assert.ok(ex.auditStatus().lanes[0].issues.includes('UNEXPECTED_OPEN_ORDER'),'copy-owned resting LIMIT must still flag UNEXPECTED_OPEN_ORDER');
 const blockedAdd=await ex.handle({id:3,date:1e12+2000,text:CHANGE(1760,2640)});
 assert.equal(blockedAdd.reason,'COPY_AUDIT_BLOCKED');

 // Close out and verify pre-entry checks for copy-owned LIMIT vs partially filled manual LIMIT vs filled position
 orders=[];
 await ex.reconcile();
 assert.equal((await ex.handle({id:4,date:1e12+3000,text:CLOSE})).ok,true);
 assert.equal(v.size,0);

 orders=[{symbol:'TNSR-USDT',orderId:'c2',clientOrderId:'cp9999p',type:'LIMIT',side:'SELL',positionSide:'BOTH',executedQty:'0',status:'NEW'}];
 assert.equal((await ex.handle({id:5,date:1e12+4000,text:OPEN})).reason,'COPY_OPEN_ORDERS_EXIST','copy-owned resting LIMIT must still block new entry');

 orders=[{symbol:'TNSR-USDT',orderId:'m3',clientOrderId:'manpartial1',type:'LIMIT',side:'SELL',positionSide:'BOTH',executedQty:'10',status:'PARTIALLY_FILLED'}];
 assert.equal((await ex.handle({id:6,date:1e12+5000,text:OPEN})).reason,'COPY_OPEN_ORDERS_EXIST','partially filled manual LIMIT must still block entry');

 v.setSize(10);
 orders=[{symbol:'TNSR-USDT',orderId:'m4',type:'LIMIT',side:'SELL',positionSide:'BOTH',executedQty:'0',status:'NEW'}];
 assert.equal((await ex.handle({id:7,date:1e12+6000,text:OPEN})).reason,'MANUAL_FIRST','filled manual position must still block entry (manual first, real account)');
});

test('live copy in hedge mode handles resting manual LIMIT order and venue setLeverage refusal safely within maxLeverage',async()=>{
 const v=venue({hedge:true});
 const orders=[{symbol:'TNSR-USDT',orderId:'h1',clientOrderId:'',type:'LIMIT',side:'SELL',positionSide:'SHORT',price:'0.06',origQty:'50',executedQty:'0',status:'NEW'}];
 v.client.openOrders=async()=>({orders});
 let shortLev=10;
 v.client.leverage=async()=>({maxLongLeverage:20,maxShortLeverage:20,longLeverage:10,shortLeverage:shortLev});
 v.client.setLeverage=async()=>{throw Object.assign(Error('cannot change leverage while open orders exist'),{code:'VENUE_ERROR_101400'})};

 // Within maxLeverage (10 <= 125): keeps current venue leverage and enters cleanly
 const ex=make(v,{config:{mode:'LIVE',stops:false,maxLeverage:20},auditOrders:true});
 await ex.reconcile();
 const okRes=await ex.handle({id:1,date:1e12,text:OPEN});
 assert.equal(okRes.ok,true,'copy entry succeeds using current leverage when BingX rejects leverage change due to resting manual LIMIT');
 assert.equal(ex.status().positions[0].leverage,10);

 // Exceeding maxLeverage (25 > 20): still refuses rather than silently exceeding configured max leverage
 const v2=venue({hedge:true});
 v2.client.openOrders=async()=>({orders});
 v2.client.leverage=async()=>({maxLongLeverage:50,maxShortLeverage:50,longLeverage:25,shortLeverage:25});
 v2.client.setLeverage=async()=>{throw Object.assign(Error('cannot change leverage while open orders exist'),{code:'VENUE_ERROR_101400'})};
 const ex2=make(v2,{config:{mode:'LIVE',stops:false,maxLeverage:20},auditOrders:true});
 await ex2.reconcile();
 const failRes=await ex2.handle({id:1,date:1e12,text:OPEN});
 assert.equal(failRes.ok,false,'must not enter if existing venue leverage exceeds maxLeverage');
 assert.equal(failRes.reason,'VENUE_ERROR_101400');
});

