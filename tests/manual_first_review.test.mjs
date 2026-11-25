// Review of manual first (user 2026-11-25 01:37 / 01:39 / 01:40): our server never opens into, reduces or closes a
// manual position. Mock venues only (one-way and hedge); no network, no real orders.
import test from 'node:test';
import assert from 'node:assert/strict';
import {CopyExecutor,copyConfig} from '../copy_executor.mjs';
import {copyEventText} from '../copy_telegram.mjs';
import {userTpSlOnLane} from '../real_trailing.mjs';

const OPEN='📌 포지션 진입\n━━━━━━━━━━━━━━━━\n🪙 TNSRUSDT  🔴 Short  ×5\n━━━━━━━━━━━━━━━━\n진입가　0.05296 USDT\n현재가　0.05100 USDT\n수량　　880　마진 9.01 USDT\n손익　　🟢 +1.72 USDT';
const CHANGE=(a,b)=>`📊 포지션 변경\n━━━━━━━━━━━━━━━━\n🪙 TNSRUSDT  🔴 Short\n━━━━━━━━━━━━━━━━\n수량　　${a} → ${b}\n현재가　0.05300 USDT\n손익　　🔴 -0.51 USDT`;
const CLOSE='✅ 포지션 청산\n━━━━━━━━━━━━━━━━\n🪙 TNSRUSDT  🔴 Short\n━━━━━━━━━━━━━━━━\n진입가　0.05296 USDT\n최종손익　🟢 +1.72 USDT';
const contract={symbol:'TNSRUSDT',venueSymbol:'TNSR-USDT',tickSize:'0.00001',quantityStep:'1',minQuantityBase:'1',minNotionalUSDT:2,tradable:true};

/** A BingX-like venue: one-way (BOTH) or hedge (LONG / SHORT). unsigned: one-way amounts without a sign (some BingX
 * answers), markPrice = avgPrice and unrealized 0 (a position at break-even). lose(n): the next n MARKET answers are
 * lost after the order went through (NETWORK_UNREACHABLE). */
function laneVenue({hedge=false,unsigned=false}={}){
 const calls=[],orders=new Map();let id=1,lost=0,stops=[];
 const lanes={BOTH:0,LONG:0,SHORT:0};
 const row=(side,amt)=>({symbol:'TNSR-USDT',positionSide:side,positionAmt:String(unsigned?Math.abs(amt):amt),avgPrice:'0.053',markPrice:'0.053',unrealizedProfit:'0'});
 const client={
  positionMode:async()=>({dualSidePosition:hedge}),
  leverage:async()=>({maxLongLeverage:20,maxShortLeverage:20}),
  setMarginType:async()=>({}),setLeverage:async()=>({}),
  positions:async()=>hedge?['LONG','SHORT'].filter(k=>lanes[k]>0).map(k=>row(k,lanes[k])):lanes.BOTH!==0?[row('BOTH',lanes.BOTH)]:[],
  openOrders:async()=>({orders:[...v.userOrders,...stops.filter(o=>o.status==='NEW')]}),
  cancelOrder:async(s,o)=>{calls.push({op:'cancel',o:String(o)});const st=stops.find(x=>x.orderId===String(o));if(st)st.status='CANCELED';return {}},
  forceOrders:async()=>[],allOrders:async()=>({orders:v.history}),
  getOrder:async(s,{clientOrderId})=>{calls.push({op:'get',cid:clientOrderId});const o=orders.get(clientOrderId);if(!o)throw Object.assign(Error('order not exist'),{code:'VENUE_ERROR_80016'});return {order:o}},
  placeOrder:async p=>{calls.push({op:'order',...p});
   if(p.type!=='MARKET'){const o={orderId:String(id++),...p,status:'NEW'};stops.push(o);return {order:o}}
   const q=Number(p.quantity);
   if(hedge){const lane=p.positionSide,closing=lane==='LONG'?p.side==='SELL':p.side==='BUY';
    if(closing&&q>lanes[lane]+1e-9)throw Object.assign(Error('reduce more than held'),{code:'VENUE_ERROR_101205'});
    lanes[lane]=+(closing?lanes[lane]-q:lanes[lane]+q).toFixed(8)}
   else{const signed=p.side==='BUY'?q:-q,cur=lanes.BOTH;
    if(p.reduceOnly==='true'&&(!(Math.sign(cur)===-Math.sign(signed))||q>Math.abs(cur)+1e-9))throw Object.assign(Error('reduce only'),{code:'VENUE_ERROR_101205'});
    lanes.BOTH=+(cur+signed).toFixed(8)}
   const o={orderId:String(id++),clientOrderId:p.clientOrderId,side:p.side,positionSide:p.positionSide,type:'MARKET',status:'FILLED',executedQty:String(q),avgPrice:'0.053'};
   orders.set(p.clientOrderId,o);
   if(lost>0){lost--;throw Object.assign(Error('fetch failed'),{code:'NETWORK_UNREACHABLE'})}
   return {order:o}},
 };
 const v={client,calls,lanes,userOrders:[],history:[],get stops(){return stops},
  manual(lane,delta){lanes[lane]=+(lanes[lane]+delta).toFixed(8)},
  lose(n=1){lost=n},
  reduces:()=>calls.filter(c=>c.op==='order'&&c.type==='MARKET'&&(c.reduceOnly==='true'||hedge&&(c.positionSide==='SHORT'?c.side==='BUY':c.side==='SELL')))};
 return v;
}
function copy(v,{stops=false,audit=false,clock={t:1e12}}={}){
 const ex=new CopyExecutor({config:{...copyConfig({COPY_SIZING:'FIRST_1USD',COPY_STOPS:stops?'on':'off'},'TESTNET'),mode:'LIVE'},
  client:v.client,contractOf:async()=>contract,balance:async()=>({equity:400,available:300}),gate:()=>({ok:true}),now:()=>clock.t,auditOrders:audit});
 ex.sleep=async()=>{};ex.goneRecheckMs=0;
 let n=0;ex.msg=text=>{clock.t+=1000;return ex.handle({id:++n,date:clock.t,text})};
 return ex;
}
const sum=list=>list.map(c=>Number(c.quantity)).reduce((a,b)=>a+b,0);

test('one-way, unsigned amounts at break-even: a SHORT copy is not read as netted away (no flip without a stated side)',async()=>{
 const v=laneVenue({unsigned:true});const ex=copy(v);
 assert.equal((await ex.msg(OPEN)).ok,true);assert.equal(v.lanes.BOTH,-98);
 await ex.reconcile();await ex.reconcile();
 assert.equal(ex.status().positions.length,1,'still in the ledger: the venue does not say the side');
 assert.equal((await ex.msg(CHANGE(880,440))).ok,true);
 assert.deepEqual(v.reduces().map(c=>c.quantity),['49'],'the cut is sent');
 assert.equal((await ex.msg(CLOSE)).ok,true);
 assert.equal(v.lanes.BOTH,0,'the trader close is followed (nothing left on the venue)');
 assert.equal(ex.status().closed[0].closeReason,'TRADER_CLOSE');
});

test('one-way: a LONG copy that the user netted into a SHORT (signed amount) is booked gone without any order',async()=>{
 const LONG_OPEN=OPEN.replace('🔴 Short','🟢 Long'),LONG_CLOSE=CLOSE.replace('🔴 Short','🟢 Long');
 const v=laneVenue();const ex=copy(v);
 assert.equal((await ex.msg(LONG_OPEN)).ok,true);assert.equal(v.lanes.BOTH,98);
 v.manual('BOTH',-150); // the user sells 150 by hand: the lane is now a manual SHORT 52
 const r=await ex.msg(LONG_CLOSE);assert.equal(r.ok,true);
 assert.equal(v.reduces().length,0,'nothing sent into the manual short');assert.equal(v.lanes.BOTH,-52);
 assert.equal(ex.status().positions.length,0);
});

for(const hedge of [false,true]){
 const lane=hedge?'SHORT':'BOTH',sign=hedge?1:-1;
 test(`${hedge?'hedge':'one-way'}: a close whose answer was lost but filled is counted before a manual position opened meanwhile`,async()=>{
  const v=laneVenue({hedge});const ex=copy(v);
  assert.equal((await ex.msg(OPEN)).ok,true);assert.equal(v.lanes[lane],sign*98);
  v.lose(1);
  const r=await ex.msg(CLOSE);assert.equal(r.ok,false);
  assert.equal(v.lanes[lane],0,'our close went through on the venue');
  v.manual(lane,sign*40); // the user opens his own position on the lane before the routine check
  await ex.reconcile();await ex.reconcile();
  assert.equal(v.lanes[lane],sign*40,'the manual 40 is never closed');
  assert.equal(sum(v.reduces()),98,'only our own 98 was ever sent');
  assert.equal(ex.status().positions.length,0,'booked closed');
 });
 test(`${hedge?'hedge':'one-way'}: a cut whose answer was lost but filled is not sent again into a manual position opened meanwhile`,async()=>{
  const v=laneVenue({hedge});const ex=copy(v);
  assert.equal((await ex.msg(OPEN)).ok,true);
  v.lose(1);
  assert.equal((await ex.msg(CHANGE(880,440))).ok,false);
  assert.equal(v.lanes[lane],sign*49,'the cut went through on the venue');
  v.manual(lane,sign*40);
  await ex.reconcile();
  assert.equal(v.lanes[lane],sign*89,'the manual 40 is not cut');
  assert.equal(sum(v.reduces()),49);
  const p=ex.status().positions[0];assert.equal(p.qty,49);assert.equal(p.manualQty,40);
  assert.equal((await ex.msg(CLOSE)).ok,true);
  assert.equal(v.lanes[lane],sign*40,'the trader close takes our 49 only');
 });
}

test('stops on: a whole-position (closePosition) stop of ours is replaced by an own-quantity stop once a manual position shares the lane',async()=>{
 const v=laneVenue();const ex=copy(v,{stops:true});
 assert.equal((await ex.msg(OPEN)).ok,true);
 const first=v.stops.filter(o=>o.status==='NEW');assert.equal(first.length,1);assert.equal(first[0].closePosition,'true');
 v.manual('BOTH',-40);
 await ex.reconcile();
 const live=v.stops.filter(o=>o.status==='NEW');
 assert.equal(live.length,1,JSON.stringify(v.stops));
 assert.equal(live[0].closePosition,undefined,'no whole-position stop over a manual position');
 assert.equal(live[0].reduceOnly,'true');assert.equal(live[0].quantity,'98');
});

test('loss limit: an emergency close whose answer was lost but filled is looked up before a manual position opened meanwhile',async()=>{
 const v=laneVenue();const clock={t:1e12};
 const ex=new CopyExecutor({config:{...copyConfig({COPY_SIZING:'FIRST_1USD',COPY_STOPS:'off',COPY_LEDGER_LOSS_PCT:'1'},'TESTNET'),mode:'LIVE'},
  client:v.client,contractOf:async()=>contract,balance:async()=>({equity:400,available:300}),gate:()=>({ok:true}),now:()=>clock.t,retryDelaysMs:[]});
 ex.sleep=async()=>{};ex.goneRecheckMs=0;
 await ex.handle({id:1,date:1e12,text:OPEN});
 const p=ex.store.positions['TNSRUSDT|SHORT'];p.unrealized=-100;
 v.client.positions=(orig=>async()=>{const r=await orig();return r.map(x=>({...x,unrealizedProfit:'-100'}))})(v.client.positions);
 v.lose(1);
 await ex.reconcile(); // the loss limit: our 98 sent, the answer lost (it filled)
 assert.equal(ex.status().killed,true);assert.equal(v.lanes.BOTH,0);assert.ok(ex.store.positions['TNSRUSDT|SHORT'].closing.lost);
 v.manual('BOTH',-40); // the user opens his own short before the next check
 await ex.reconcile();await ex.reconcile();
 assert.equal(v.lanes.BOTH,-40,'the manual short is never closed');assert.equal(sum(v.reduces()),98);
 assert.equal(ex.status().positions.length,0);assert.equal(ex.status().closed[0].closeReason,'COPY_LOSS_LIMIT');
});

test('a cut whose lost answer cannot be looked up sends nothing more (held with an alert) until the lookup answers',async()=>{
 const v=laneVenue();const ex=copy(v);
 await ex.msg(OPEN);v.lose(1);
 await ex.msg(CHANGE(880,440));assert.equal(v.lanes.BOTH,-49);
 const get=v.client.getOrder;v.client.getOrder=async()=>{throw Object.assign(Error('down'),{code:'NETWORK_UNREACHABLE'})};
 v.manual('BOTH',-40);await ex.reconcile();
 assert.equal(sum(v.reduces()),49,'nothing sent while our cut cannot be told');
 assert.equal(ex.status().events.filter(e=>e.type==='MANUAL_PROTECT_HOLD').length,1);
 v.client.getOrder=get;await ex.reconcile();
 assert.equal(sum(v.reduces()),49);assert.equal(v.lanes.BOTH,-89);assert.equal(ex.status().positions[0].qty,49);
});

test('a working partial cut caps its protective stop below the manual share until it settles',async()=>{
 const v=laneVenue(),ex=copy(v,{stops:true});
 await ex.msg(OPEN);
 v.manual('BOTH',-40);
 await ex.reconcile();
 const place=v.client.placeOrder,get=v.client.getOrder;
 let cut;
 v.client.placeOrder=async params=>{
  if(params.type!=='MARKET'||params.reduceOnly!=='true')return place(params);
  assert.equal(params.quantity,'49');
  const {order}=await place({...params,quantity:'24'});
  cut={...order,status:'PARTIALLY_FILLED'};
  return {order:cut};
 };
 v.client.getOrder=async (symbol,key)=>key.orderId===cut?.orderId?{order:cut}:get(symbol,key);
 const activeStop=()=>v.stops.find(o=>o.status==='NEW');
 assert.equal((await ex.msg(CHANGE(880,440))).ok,true);
 assert.equal(v.lanes.BOTH,-114);
 assert.equal(activeStop().quantity,'49','stop can coexist with the remaining 25 without consuming manual 40');
 assert.equal(activeStop().closePosition,undefined);
 await ex.reconcile();
 assert.equal(activeStop().quantity,'49');
 cut.status='CANCELED';
 await ex.reconcile();
 assert.equal(activeStop().quantity,'74','protect the full remaining copy once the other 25 cannot fill');
 assert.equal(activeStop().closePosition,undefined);
 assert.equal(ex.status().positions[0].manualQty,40);
});

test('testnet is unchanged: the whole lane is the copy\'s (closed whole), no MANUAL_FIRST, no hold',async()=>{
 const v=laneVenue();const clock={t:1e12};
 const ex=new CopyExecutor({config:copyConfig({COPY_SIZING:'FIRST_1USD',COPY_STOPS:'off'},'TESTNET'),client:v.client,contractOf:async()=>contract,
  balance:async()=>({equity:400,available:300}),gate:()=>({ok:true}),now:()=>clock.t});
 ex.sleep=async()=>{};ex.goneRecheckMs=0;let n=0;const msg=t=>{clock.t+=1000;return ex.handle({id:++n,date:clock.t,text:t})};
 assert.equal((await msg(OPEN)).ok,true);v.manual('BOTH',-40);await ex.reconcile();
 assert.equal(ex.status().positions[0].qty,138);assert.equal(ex.status().events.filter(e=>/MANUAL/.test(e.type+e.reason)).length,0);
 assert.equal((await msg(CLOSE)).ok,true);assert.equal(v.lanes.BOTH,0,'as before: the whole lane is closed on the testnet');
 v.manual('BOTH',-30);assert.equal((await msg(OPEN)).reason,'VENUE_POSITION_EXISTS');
});

test('after the deploy: an older open copy (no ownQty) is split from its steps; a lane bigger than its fills is told once, and the close takes the steps only',async()=>{
 const v=laneVenue();const ex=copy(v);
 await ex.msg(OPEN);
 const p=ex.store.positions['TNSRUSDT|SHORT'];delete p.ownQty;delete p.qtyStep;p.steps=[{kind:'OPEN',qty:98}];
 await ex.reconcile();
 assert.equal(p.ownQty,98);assert.equal(p.ownQtySource,'STEPS');assert.equal(ex.status().events.filter(e=>e.type==='MANUAL_ON_LANE').length,0,'fills = venue: nothing to tell');
 v.manual('BOTH',-40);await ex.reconcile();await ex.reconcile();
 const told=ex.status().events.filter(e=>e.type==='MANUAL_ON_LANE');assert.equal(told.length,1,'told once');
 assert.equal(told[0].manualQty,40);assert.equal(told[0].ownQty,98);
 assert.match(copyEventText(told[0]),/같은 자리에 수동 40 확인 — 카피는 자기 수량 98만 관리/);
 assert.match(copyEventText(told[0]),/이전 체결 기록으로 계산/);
 v.manual('BOTH',40);await ex.reconcile(); // the user closed his 40 again
 const again=ex.status().events.filter(e=>e.type==='MANUAL_ON_LANE');assert.equal(again.length,2);
 assert.match(copyEventText(again[0]),/수동 몫이 0이 되었습니다 \(이전 40\)/);
 assert.equal((await ex.msg(CLOSE)).ok,true);assert.equal(v.lanes.BOTH,0);
});

for(const hedge of [false,true]){
 const lane=hedge?'SHORT':'BOTH',sign=hedge?1:-1;
 test(`${hedge?'hedge':'one-way'}, no manual position: entry, adds, cuts, close and the next entry follow the trader on the whole lane`,async()=>{
  const v=laneVenue({hedge});const ex=copy(v);
  assert.equal((await ex.msg(OPEN)).ok,true);
  assert.equal((await ex.msg(CHANGE(880,1760))).ok,true);
  assert.equal((await ex.msg(CHANGE(1760,1320))).ok,true);
  assert.equal((await ex.msg(CHANGE(1320,2640))).ok,true);
  await ex.reconcile();
  const p=ex.status().positions[0];assert.equal(p.qty,Math.abs(v.lanes[lane]));assert.equal(p.ownQty,p.qty);assert.equal(p.manualQty,0);
  assert.equal(ex.status().events.filter(e=>/MANUAL/.test(e.type+(e.reason||''))).length,0);
  assert.equal((await ex.msg(CLOSE)).ok,true);assert.equal(v.lanes[lane],0,'nothing left on the venue');
  assert.equal((await ex.msg(OPEN)).ok,true,'the next trader position is copied');assert.equal(v.lanes[lane],sign*98);
 });
}

test('a real-trailing lock stop (optr) on the copy\'s own lane does not block the copy\'s adds as a user TP / SL',async()=>{
 const v=laneVenue();const ex=copy(v,{audit:true});
 await ex.reconcile();assert.equal((await ex.msg(OPEN)).ok,true);await ex.reconcile();
 v.userOrders=[{symbol:'TNSR-USDT',orderId:'t1',clientOrderId:'optrmabc12',type:'STOP_MARKET',side:'BUY',positionSide:'BOTH',closePosition:'true',status:'NEW'}];
 assert.equal((await ex.msg(CHANGE(880,1760))).ok,true);assert.equal(v.lanes.BOTH,-192,'entry 98 + add 94');
 v.userOrders=[{...v.userOrders[0],orderId:'u1',clientOrderId:'man-sl'}];
 assert.equal((await ex.msg(CHANGE(1760,2640))).reason,'MANUAL_FIRST','a user stop still blocks');
});

test('real trailing: a limit take-profit of the user (reduce-only, or a hedge close order) protects the manual position too',async()=>{
 const p={venueSymbol:'ETH-USDT',direction:'LONG'};
 assert.equal(userTpSlOnLane(p,[{venueSymbol:'ETH-USDT',orderId:'1',clientOrderId:'m1',type:'LIMIT',side:'SELL',positionSide:'BOTH',reduceOnly:true}]),true);
 assert.equal(userTpSlOnLane(p,[{venueSymbol:'ETH-USDT',orderId:'2',clientOrderId:'m2',type:'LIMIT',side:'SELL',positionSide:'LONG',reduceOnly:false}]),true);
 assert.equal(userTpSlOnLane(p,[{venueSymbol:'ETH-USDT',orderId:'3',clientOrderId:'m3',type:'LIMIT',side:'SELL',positionSide:'BOTH',reduceOnly:false}]),false,'a one-way opening order is not a TP');
 assert.equal(userTpSlOnLane(p,[{venueSymbol:'ETH-USDT',orderId:'4',clientOrderId:'m4',type:'LIMIT',side:'BUY',positionSide:'LONG'}]),false,'a hedge add is not a TP');
});

test('an entry whose answer was lost is taken over at its own fill, not at a lane that a manual position joined meanwhile',async()=>{
 const v=laneVenue();const ex=copy(v);
 v.lose(1); // the entry fills but its answer is lost, and its order cannot be looked up yet (no resend)
 const get=v.client.getOrder;v.client.getOrder=async()=>{throw Object.assign(Error('down'),{code:'NETWORK_UNREACHABLE'})};
 await ex.msg(OPEN);
 assert.equal(v.lanes.BOTH,-98,'our entry filled');const p=ex.store.positions['TNSRUSDT|SHORT'];assert.equal(p.steps.length,0,'not confirmed yet');
 v.manual('BOTH',-40);v.client.getOrder=get;
 await ex.reconcile();
 assert.equal(p.ownQty,98,'our fill only');assert.equal(p.qty,98);assert.equal(p.manualQty,40);
 assert.equal((await ex.msg(CLOSE)).ok,true);assert.equal(v.lanes.BOTH,-40,'the manual 40 stays');
});

for(const hedge of [false,true]){
 const lane=hedge?'SHORT':'BOTH',sign=hedge?1:-1;
 test(`${hedge?'hedge':'one-way'}, no manual position: an add whose answer was lost is found filled by lookup (no resend) and counted as ours`,async()=>{
  const v=laneVenue({hedge});const ex=copy(v);ex.retryDelaysMs=[1];
  await ex.msg(OPEN);v.lose(1);
  assert.equal((await ex.msg(CHANGE(880,1760))).ok,true);
  assert.equal(v.calls.filter(c=>c.op==='order'&&c.type==='MARKET').length,2,'no resend');
  const p=ex.status().positions[0];assert.equal(p.ownQty,192);assert.equal(p.unverifiedAdds,undefined);
  await ex.reconcile();assert.equal(ex.status().positions[0].manualQty,0);
  assert.equal((await ex.msg(CLOSE)).ok,true);assert.equal(v.lanes[lane],0);
 });
 test(`${hedge?'hedge':'one-way'}, no manual position: after the user closes our copy by hand, the trader's next add is followed again (refollow)`,async()=>{
  const v=laneVenue({hedge});const clock={t:1e12};const ex=copy(v,{clock});
  await ex.msg(OPEN);
  v.manual(lane,-sign*98); // the user closes the whole copy by hand in the app
  v.history=[{orderId:'m9',clientOrderId:'app1',side:'BUY',positionSide:hedge?'SHORT':'BOTH',status:'FILLED',executedQty:'98',updateTime:clock.t+500}];
  clock.t+=1000;await ex.reconcile();clock.t+=1000;await ex.reconcile();
  assert.equal(ex.status().positions.length,0);assert.equal(ex.status().closed[0].closeEvidence.kind,'MANUAL_CLOSE');
  const r=await ex.msg(CHANGE(880,1760));assert.equal(r.ok,true,JSON.stringify(ex.status().events.slice(0,3)));
  assert.equal(v.lanes[lane],sign*Math.abs(v.lanes[lane]));assert.ok(Math.abs(v.lanes[lane])>0);
  assert.equal(ex.status().events.find(e=>e.type==='OPENED')?.refollow,true);
 });
}
