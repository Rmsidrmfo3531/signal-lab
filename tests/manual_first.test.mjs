// Manual first on the real account (user 2026-11-25 01:37 "만약 수동으로 매매를 했고 tp와 sl이 설정되어 있는 경우 어떠한
// 경우라도 강제 청산을 하지 않도록 해줘", 01:39 "수동이 주문이 들어갔고 그 다음 카피로 같은 종목과 방향일 경우 당연하게 스킵되는
// 거고 한마디로 수동이 먼저야"). Mock venues only (one-way and hedge); no network, no real orders.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {CopyExecutor,copyConfig,userProtectOrder} from '../copy_executor.mjs';
import {copyEventText} from '../copy_telegram.mjs';
import {tagOrigins,ledgerOwnQty} from '../venue_positions.mjs';
import {RealTrailingManager,userTpSlOnLane} from '../real_trailing.mjs';
import {ManualLedger} from '../manual_ledger.mjs';
import {ScalpExecutor,scalpLiveExecConfig,SCALP_LIVE_CONFIRM_TOKEN} from '../scalp_executor.mjs';
import {scalpEventText} from '../scalp_telegram.mjs';
import {reasonLabel} from '../public/scalp_reasons.js';

const OPEN='📌 포지션 진입\n━━━━━━━━━━━━━━━━\n🪙 TNSRUSDT  🔴 Short  ×5\n━━━━━━━━━━━━━━━━\n진입가　0.05296 USDT\n현재가　0.05100 USDT\n수량　　880　마진 9.01 USDT\n손익　　🟢 +1.72 USDT';
const CHANGE=(a,b)=>`📊 포지션 변경\n━━━━━━━━━━━━━━━━\n🪙 TNSRUSDT  🔴 Short\n━━━━━━━━━━━━━━━━\n수량　　${a} → ${b}\n현재가　0.05300 USDT\n손익　　🔴 -0.51 USDT`;
const CLOSE='✅ 포지션 청산\n━━━━━━━━━━━━━━━━\n🪙 TNSRUSDT  🔴 Short\n━━━━━━━━━━━━━━━━\n진입가　0.05296 USDT\n최종손익　🟢 +1.72 USDT';
const contract={symbol:'TNSRUSDT',venueSymbol:'TNSR-USDT',tickSize:'0.00001',quantityStep:'1',minQuantityBase:'1',minNotionalUSDT:2,tradable:true};

/** A BingX-like venue with lanes: one-way (BOTH, signed amount) or hedge (LONG / SHORT, positive). Copy and manual share
 * a lane exactly as on BingX; manual(lane, delta) is the user trading in the app. */
function laneVenue({hedge=false,marginMode='CROSSED'}={}){
 const calls=[],orders=new Map();let id=1,mark=0.053;
 const lanes={BOTH:0,LONG:0,SHORT:0};
 const row=(side,amt)=>({symbol:'TNSR-USDT',positionSide:side,positionAmt:String(amt),avgPrice:'0.051',markPrice:String(mark),
  unrealizedProfit:String((mark-0.051)*(side==='SHORT'?-amt:amt)),isolated:marginMode==='ISOLATED'});
 const client={
  positionMode:async()=>({dualSidePosition:hedge}),
  leverage:async()=>({maxLongLeverage:20,maxShortLeverage:20}),
  setMarginType:async(s,m)=>{calls.push({op:'margin',m});return {}},
  setLeverage:async(s,side,l)=>{calls.push({op:'lev',side,l});return {}},
  positions:async()=>hedge?['LONG','SHORT'].filter(k=>lanes[k]>0).map(k=>row(k,lanes[k])):lanes.BOTH!==0?[row('BOTH',lanes.BOTH)]:[],
  openOrders:async()=>({orders:v.userOrders}),
  cancelOrder:async(s,o,opt={})=>{calls.push({op:'cancel',o:o==null?null:String(o),cid:opt.clientOrderId??null});return {}},
  getOrder:async(s,{clientOrderId})=>{calls.push({op:'get',cid:clientOrderId});const o=orders.get(clientOrderId);if(!o)throw Object.assign(Error('order not exist'),{code:'VENUE_ERROR_80016'});return {order:o}},
  placeOrder:async p=>{calls.push({op:'order',...p});
   if(p.type!=='MARKET')return {order:{orderId:String(id++)}};
   const q=Number(p.quantity);
   if(hedge){const lane=p.positionSide,closing=lane==='LONG'?p.side==='SELL':p.side==='BUY';
    if(closing&&q>lanes[lane]+1e-9)throw Object.assign(Error('reduce more than held'),{code:'VENUE_ERROR_101205'});
    lanes[lane]=+(closing?lanes[lane]-q:lanes[lane]+q).toFixed(8)}
   else{const signed=p.side==='BUY'?q:-q,cur=lanes.BOTH;
    if(p.reduceOnly==='true'){if(!(Math.sign(cur)===-Math.sign(signed))||q>Math.abs(cur)+1e-9)throw Object.assign(Error('reduce only'),{code:'VENUE_ERROR_101205'})}
    lanes.BOTH=+(cur+signed).toFixed(8)}
   const o={orderId:String(id++),clientOrderId:p.clientOrderId,side:p.side,positionSide:p.positionSide,type:'MARKET',status:'FILLED',executedQty:String(q),avgPrice:String(mark)};
   orders.set(p.clientOrderId,o);return {order:o}},
 };
 const v={client,calls,lanes,userOrders:[],
  manual(lane,delta){lanes[lane]=+(lanes[lane]+delta).toFixed(8)},
  set mark(x){mark=x},
  orders:()=>calls.filter(c=>c.op==='order'&&c.type==='MARKET'),
  reduces:()=>calls.filter(c=>c.op==='order'&&c.type==='MARKET'&&(c.reduceOnly==='true'||hedge&&(c.positionSide==='SHORT'?c.side==='BUY':c.side==='SELL')))};
 return v;
}
function copy(v,{audit=false,manualPositions,clock={t:1e12},dir=null}={}){
 const ex=new CopyExecutor({config:{...copyConfig({COPY_SIZING:'FIRST_1USD',COPY_STOPS:'off',COPY_LEDGER_LOSS_PCT:'50'},'TESTNET'),mode:'LIVE'},
  client:v.client,contractOf:async()=>contract,balance:async()=>({equity:400,available:300}),gate:()=>({ok:true}),now:()=>clock.t,
  auditOrders:audit,manualPositions,directory:dir});
 ex.sleep=async()=>{};ex.goneRecheckMs=0;
 let n=0;ex.msg=text=>{clock.t+=1000;return ex.handle({id:++n,date:clock.t,text})};
 return ex;
}
const evs=(ex,pred)=>ex.status().events.filter(pred);

test('one-way: opposite-direction manual or TP/SL-protected same-direction manual skips copy entry (MANUAL_FIRST); unprotected same-direction skips order and links ratio',async()=>{
 // Opposite direction (manual LONG vs SHORT copy): strict MANUAL_FIRST skip, never linked
 {const v=laneVenue();v.manual('BOTH',50);const ex=copy(v);
  const r=await ex.msg(OPEN);
  assert.equal(r.reason,'MANUAL_FIRST');
  assert.deepEqual(v.calls.filter(c=>['order','lev','margin','cancel'].includes(c.op)),[],'no leverage, margin mode, order or cancel');
  assert.match(copyEventText(evs(ex,x=>x.reason==='MANUAL_FIRST')[0]),/수동 포지션 우선 — 카피 진입 건너뜀/);
  assert.equal(v.lanes.BOTH,50);assert.equal(ex.status().positions.length,0)}
 // Same direction WITH user TP/SL (Option 2): strict MANUAL_FIRST skip, never linked
 {const v=laneVenue();v.manual('BOTH',-30);
  v.userOrders=[{symbol:'TNSR-USDT',orderId:'u-sl',clientOrderId:'man-sl',type:'STOP_MARKET',side:'BUY',positionSide:'BOTH',closePosition:'true',status:'NEW'}];
  const ex=copy(v);
  const r=await ex.msg(OPEN);
  assert.equal(r.reason,'MANUAL_FIRST');
  assert.deepEqual(v.calls.filter(c=>['order','lev','margin','cancel'].includes(c.op)),[]);
  assert.equal(v.lanes.BOTH,-30);assert.equal(ex.status().positions.length,0)}
 // Same direction WITHOUT TP/SL (user 2026-11-26): skips initial entry order/settings and links for ratio-following
 {const v=laneVenue();v.manual('BOTH',-30);const ex=copy(v);
  const r=await ex.msg(OPEN);
  assert.equal(r.ok,true);assert.equal(r.skippedEntry,true);assert.equal(r.manualLinked,true);
  assert.deepEqual(v.calls.filter(c=>['order','lev','margin','cancel'].includes(c.op)),[],'no initial entry order, leverage, margin, or cancel');
  assert.equal(v.lanes.BOTH,-30,'manual position untouched on initial copy entry');
  const p=ex.status().positions[0];assert.equal(p.manualLinked,true);assert.equal(p.manualBaseQty,30);assert.equal(p.theirFirstQty,880);
  assert.match(copyEventText(evs(ex,x=>x.type==='MANUAL_LINKED')[0]),/수동 포지션 비율 연결 \(첫 진입 생략\)/)}
});

test('the trader\'s later adds of a MANUAL_FIRST-skipped entry (TP/SL protected or opposite side) are not followed until the trader closes; then the next entry is copied',async()=>{
 const v=laneVenue();v.manual('BOTH',-30);
 v.userOrders=[{symbol:'TNSR-USDT',orderId:'u-sl',clientOrderId:'man-sl',type:'STOP_MARKET',side:'BUY',positionSide:'BOTH',closePosition:'true',status:'NEW'}];
 const ex=copy(v);
 assert.equal((await ex.msg(OPEN)).reason,'MANUAL_FIRST');
 assert.equal((await ex.msg(CHANGE(880,1760))).reason,'MANUAL_FIRST');
 v.manual('BOTH',30);v.userOrders=[]; // the user closed the manual position, the trader still holds his
 assert.equal((await ex.msg(CHANGE(1760,2640))).reason,'MANUAL_FIRST','still the skipped trader position');
 assert.equal((await ex.msg(OPEN)).reason,'MANUAL_FIRST','an entry card of the same trader position is an add of it');
 assert.equal(evs(ex,x=>x.type==='LATE_ENTRY').length,0);
 assert.equal(v.orders().length,0);
 assert.equal((await ex.msg(CLOSE)).ok,true);
 const r=await ex.msg(OPEN);assert.equal(r.ok,true,JSON.stringify(ex.status().events.slice(0,2)));
 assert.equal(v.lanes.BOTH,-98);assert.equal(ex.status().positions[0].ownQty,98);
});

test('hedge: TP/SL-protected same-side manual skips; unprotected same-side links without ordering; opposite cross enters without touching margin mode; opposite isolated skips',async()=>{
 {const v=laneVenue({hedge:true});v.manual('SHORT',30);
  v.userOrders=[{symbol:'TNSR-USDT',orderId:'u-tp',clientOrderId:'man-tp',type:'TAKE_PROFIT_MARKET',side:'BUY',positionSide:'SHORT',closePosition:'true',status:'NEW'}];
  const ex=copy(v);
  assert.equal((await ex.msg(OPEN)).reason,'MANUAL_FIRST');assert.equal(v.calls.filter(c=>c.op!=='get').length,0)}
 {const v=laneVenue({hedge:true});v.manual('SHORT',30);const ex=copy(v);
  const r=await ex.msg(OPEN);
  assert.equal(r.manualLinked,true);assert.equal(r.skippedEntry,true);
  assert.equal(v.calls.filter(c=>['order','lev','margin','cancel'].includes(c.op)).length,0)}
 {const v=laneVenue({hedge:true});v.manual('LONG',30);const ex=copy(v);
  assert.equal((await ex.msg(OPEN)).ok,true);
  assert.equal(v.calls.filter(c=>c.op==='margin').length,0,'the symbol-wide margin mode is not set while a manual position uses it');
  assert.deepEqual(v.calls.filter(c=>c.op==='lev').map(c=>c.side),['SHORT'],'leverage only on our own side');
  assert.equal(v.lanes.LONG,30);assert.equal(v.lanes.SHORT,98)}
 {const v=laneVenue({hedge:true,marginMode:'ISOLATED'});v.manual('LONG',30);const ex=copy(v);
  assert.equal((await ex.msg(OPEN)).reason,'MANUAL_FIRST');
  assert.equal(v.calls.filter(c=>['order','lev','margin'].includes(c.op)).length,0)}
});

test('a user TP / SL on the lane (open orders) or a recent manual-ledger record skips the entry; a stale record does not',async()=>{
 {const v=laneVenue();const ex=copy(v,{audit:true});await ex.reconcile();
  v.userOrders=[{symbol:'TNSR-USDT',orderId:'u1',clientOrderId:'man1',type:'STOP_MARKET',side:'BUY',positionSide:'BOTH',closePosition:'true',status:'NEW'}];
  assert.equal((await ex.msg(OPEN)).reason,'MANUAL_FIRST');assert.equal(v.orders().length,0)}
 const clock={t:1e12};
 for(const [age,want] of [[10000,'MANUAL_FIRST'],[600000,true]]){
  const v=laneVenue();const ex=copy(v,{clock,manualPositions:()=>[{venueSymbol:'TNSR-USDT',direction:'LONG',status:'OPEN',lastSeenAt:clock.t-age}]});
  const r=await ex.msg(OPEN);assert.equal(want===true?r.ok:r.reason,want);
 }
 assert.equal(userProtectOrder({orderId:'9',clientOrderId:'cpabc',type:'STOP_MARKET',closePosition:'true'},{hedge:false,direction:'SHORT'}),false,'our own order is not the user\'s');
 assert.equal(userProtectOrder({orderId:'9',clientOrderId:'man',type:'LIMIT',side:'SELL',positionSide:'BOTH'},{hedge:false,direction:'SHORT'}),false,'an unfilled manual opening LIMIT still does not block (#294)');
});

for(const hedge of [false,true]){
 const lane=hedge?'SHORT':'BOTH',sign=hedge?1:-1;
 test(`${hedge?'hedge':'one-way'}: a manual position opened on the copy's lane AFTER the copy is never added to, cut or closed`,async()=>{
  const v=laneVenue({hedge});const ex=copy(v);
  assert.equal((await ex.msg(OPEN)).ok,true);assert.equal(v.lanes[lane],sign*98);
  v.manual(lane,sign*40); // the user adds 40 by hand on the same lane
  if(hedge)v.manual('LONG',10);
  await ex.reconcile();
  const p=ex.status().positions[0];assert.equal(p.qty,98,'the copy shows its own part only');assert.equal(p.manualQty,40);
  // add: skipped
  assert.equal((await ex.msg(CHANGE(880,1760))).reason,'MANUAL_FIRST');assert.equal(v.orders().length,1);
  // trader halves: our cut is half of OUR 98 (ledger), not of the 138 on the lane
  assert.equal((await ex.msg(CHANGE(1760,880))).ok,true);
  assert.deepEqual(v.reduces().map(c=>c.quantity),['49']);assert.equal(v.lanes[lane],sign*89);
  // trader closes: only our 49; the user's 40 stays
  assert.equal((await ex.msg(CLOSE)).ok,true);
  assert.deepEqual(v.reduces().map(c=>c.quantity),['49','49']);
  assert.equal(v.lanes[lane],sign*40,'manual quantity untouched');if(hedge)assert.equal(v.lanes.LONG,10);
  assert.equal(ex.status().positions.length,0);assert.equal(ex.status().closed[0].closeReason,'TRADER_CLOSE');
  assert.equal(v.calls.filter(c=>c.op==='cancel').length,0);
  await ex.reconcile();assert.equal(v.reduces().length,2,'nothing more is sent afterwards');
 });
}

test('the copy loss limit (emergency flatten) closes only the copy\'s own quantity on a shared lane',async()=>{
 const v=laneVenue();const ex=copy(v);
 await ex.msg(OPEN);v.manual('BOTH',-40);v.mark=3; // a large loss: own 98 x (3 - 0.053) > 50 % of 400
 await ex.reconcile();
 assert.equal(ex.status().killed,true);
 assert.deepEqual(v.reduces().map(c=>c.quantity),['98']);
 assert.equal(v.lanes.BOTH,-40);assert.equal(ex.status().closed[0].closeReason,'COPY_LOSS_LIMIT');
});

test('an unknown copy quantity sends nothing: the close is held with an alert and the routine check keeps trying',async()=>{
 const v=laneVenue();const ex=copy(v);
 await ex.msg(OPEN);v.manual('BOTH',-40);
 const p=ex.store.positions['TNSRUSDT|SHORT'];delete p.ownQty;p.steps=[{kind:'OPEN',qty:null}]; // e.g. an old record with no quantity
 assert.equal(ledgerOwnQty(p),null);
 const r=await ex.msg(CLOSE);
 assert.equal(r.reason,'COPY_QTY_UNKNOWN');assert.equal(v.reduces().length,0);assert.equal(v.lanes.BOTH,-138);
 const hold=evs(ex,e=>e.type==='MANUAL_PROTECT_HOLD');assert.equal(hold.length,1);
 assert.match(copyEventText(hold[0]),/카피 몫 불명 — 수동 보호로 청산 보류/);
 assert.equal(ex.store.positions['TNSRUSDT|SHORT'].closing.reason,'TRADER_CLOSE');
 await ex.reconcile();await ex.reconcile();
 assert.equal(v.reduces().length,0);assert.equal(evs(ex,e=>e.type==='MANUAL_PROTECT_HOLD').length,1,'alert at most once per 10 min');
 // A known quantity again (e.g. repaired): the held close goes through for our part only.
 p.ownQty=98;await ex.reconcile();
 assert.deepEqual(v.reduces().map(c=>c.quantity),['98']);assert.equal(v.lanes.BOTH,-40);
});

test('an add whose answer was lost is neither counted as manual nor closed as ours until its order is looked up',async()=>{
 const v=laneVenue();const ex=copy(v);await ex.msg(OPEN);
 const place=v.client.placeOrder;let fail=true;
 v.client.placeOrder=async p=>{if(fail&&p.type==='MARKET'&&p.side==='SELL'&&!p.reduceOnly){const r=await place(p);fail=false;void r;throw Object.assign(Error('fetch failed'),{code:'NETWORK_UNREACHABLE'})}return place(p)};
 const get=v.client.getOrder;v.client.getOrder=async()=>{throw Object.assign(Error('down'),{code:'NETWORK_UNREACHABLE'})};
 await ex.msg(CHANGE(880,1760));
 const p=ex.store.positions['TNSRUSDT|SHORT'];assert.equal(p.unverifiedAdds.length,1);
 assert.equal((await ex.msg(CHANGE(1760,880))).reason,'COPY_QTY_UNKNOWN');assert.equal(v.reduces().length,0);
 v.client.getOrder=get;ex.store.pending.length=0;
 assert.equal((await ex.msg(CLOSE)).ok,true,'looked up: the add was ours, the whole lane is the copy');
 assert.equal(v.lanes.BOTH,0);assert.equal(v.reduces().map(c=>Number(c.quantity)).reduce((a,b)=>a+b,0),98+94,'entry 98 + the recovered add 94');
 assert.equal(evs(ex,e=>e.type==='ADD_RECOVERED').length,1);
});

test('the copy never reads or cancels an order it did not create',async()=>{
 const v=laneVenue();const ex=copy(v);
 v.userOrders=[{symbol:'TNSR-USDT',orderId:'u-tp',clientOrderId:'man-tp',type:'TAKE_PROFIT_MARKET',side:'BUY',positionSide:'BOTH',closePosition:'true',status:'NEW'}];
 ex.store.makerUnsettled.push({symbol:'TNSRUSDT',venueSymbol:'TNSR-USDT',clientOrderId:'man-limit',at:1e12});
 await ex.msg(OPEN);v.manual('BOTH',-40);await ex.reconcile();await ex.msg(CLOSE);await ex.reconcile();
 assert.equal(v.calls.filter(c=>c.op==='cancel').length,0);
 assert.equal(v.calls.filter(c=>c.op==='get'&&c.cid==='man-limit').length,0);
});

test('tagOrigins marks a copy row that shares its lane with a manual position (manualQty)',()=>{
 const row={symbol:'TNSRUSDT',venueSymbol:'TNSR-USDT',direction:'SHORT',size:138};
 const [t]=tagOrigins([row],[{status:'OPEN',venueSymbol:'TNSR-USDT',direction:'SHORT',ownQty:98,qtyStep:1}]);
 assert.equal(t.origin,'copy');assert.equal(t.manualQty,40);
 assert.equal(tagOrigins([{...row,size:98}],[{status:'OPEN',venueSymbol:'TNSR-USDT',direction:'SHORT',ownQty:98}])[0].manualQty,0);
 assert.equal(tagOrigins([row],[{status:'OPEN',venueSymbol:'TNSR-USDT',direction:'SHORT',steps:[{kind:'OPEN',qty:null}]}])[0].manualQty,null);
 assert.equal(ledgerOwnQty({steps:[{kind:'OPEN',qty:98},{kind:'ADD',qty:50},{kind:'REDUCE',qty:30}]}),118,'older records: from their steps');
});

test('real trailing never acts on a manual position whose lane has the user\'s TP / SL (or unreadable orders), nor on a shared copy lane',async()=>{
 const pos=(o={})=>({symbol:'ETHUSDT',venueSymbol:'ETH-USDT',direction:'LONG',origin:'manual',size:1,avg:3000,mark:3060,leverage:10,margin:300,unrealized:30,roePct:25,...o});
 const make=()=>{const calls=[],msgs=[];const rt=new RealTrailingManager({executeAction:async a=>{calls.push(a);return {ok:true,orderId:'T'+calls.length,stopPrice:3001}},sendText:async m=>{msgs.push(m)}});
  rt.configure({enabled:true,applyToManual:true,applyToCopy:true});return {rt,calls,msgs}};
 const tp={venueSymbol:'ETH-USDT',orderId:'u1',clientOrderId:'man-tp',type:'TAKE_PROFIT_MARKET',side:'SELL',positionSide:'BOTH',closePosition:true};
 const sl={...tp,orderId:'u2',type:'STOP_MARKET'};
 for(const openOrders of [[tp],[sl],[tp,sl],null,undefined]){
  const {rt,calls}=make();
  assert.deepEqual(await rt.evaluate([pos()],1e12,{openOrders}),[]);assert.equal(calls.length,0,JSON.stringify(openOrders));
 }
 {const {rt,calls}=make(); // no user TP / SL: managed as before
  const a=await rt.evaluate([pos()],1e12,{openOrders:[{...tp,venueSymbol:'BTC-USDT'}]});assert.equal(a[0].action,'CLOSE_HALF');assert.ok(calls.length>=1)}
 {const {rt,calls}=make(); // copy row sharing its lane with a manual position, or of unknown share
  for(const manualQty of [40,null])assert.deepEqual(await rt.evaluate([pos({origin:'copy',manualQty})],1e12,{openOrders:[]}),[]);
  assert.equal(calls.length,0)}
 {const {rt,calls,msgs}=make(); // trailing armed first, then the user sets his own TP: our stops are removed, nothing closed
  let t=1e12;await rt.evaluate([pos({roePct:25})],t,{openOrders:[]});
  assert.ok(rt.tracked.get('ETHUSDT|LONG'));const n=calls.length;
  t+=20000;await rt.evaluate([pos({roePct:5})],t,{openOrders:[tp]});
  const after=calls.slice(n);assert.ok(after.length>0&&after.every(c=>c.action==='CANCEL_STOP'),JSON.stringify(after));
  assert.equal(rt.tracked.has('ETHUSDT|LONG'),false);assert.match(msgs.at(-1),/수동 우선/)}
 assert.equal(userTpSlOnLane(pos(),[{...sl,clientOrderId:'optr123'}]),false,'our own lock stop is not the user\'s');
 assert.equal(userTpSlOnLane(pos({direction:'SHORT'}),[sl]),false,'a SELL stop does not protect a short');
});

// ---- opt-in live scalp (default OFF) ----
const I=300000,BUCKET=Math.floor(Date.parse('2026-11-16T03:00:00Z')/I),T0=BUCKET*I+5000;
function crash({move=6,volume=10,lastOpen=(BUCKET-1)*I,wick=.8}={}){
 const rows=[];let p=100;const push=(o,h,l,c,v)=>rows.push([0,o,h,l,c,v]);
 for(let i=0;i<50;i++){const o=p,c=p+(i%2?.05:-.05);push(o,Math.max(o,c)+.1,Math.min(o,c)-.1,c,100);p=c}
 for(let i=0;i<4;i++){const o=p,c=p-move/4;push(o,o+.05,c-.1,c,100*volume*(i===3?1:.5));p=c}
 push(p,p+.15,p-wick,p+.1,80*volume);
 return rows.map((r,i)=>{const t=lastOpen-(rows.length-1-i)*I;return [t,...r.slice(1,6).map(String),t+I-1,String(r[5]*r[4])]});
}
const up4h=now=>Array.from({length:301},(_,i)=>{const t=now-(301-i)*4*3600000-1000,c=50+i*.1;return [t,String(c),String(c+.2),String(c-.2),String(c),'1000',t+4*3600000-1,'1']});
const PX=+(Number(crash().at(-1)[4])+.02).toFixed(2);
const SOL={symbol:'SOLUSDT',venueSymbol:'SOL-USDT',tickSize:'0.01',quantityStep:'0.01',minQuantityBase:'0.01',minNotionalUSDT:2,tradable:true};
function scalpVenue(){
 const calls=[],orders=new Map();let amt=0,avg=0,id=1;
 const add=(p,extra={})=>{const o={orderId:String(id++),...p,status:'NEW',...extra};orders.set(o.orderId,o);return o};
 const client={mode:'LIVE',positionMode:async()=>({dualSidePosition:false}),marginType:async()=>({marginType:'CROSSED'}),setMarginType:async()=>({}),
  leverage:async()=>({maxLongLeverage:20,maxShortLeverage:20}),setLeverage:async(s,side,l)=>({leverage:l}),
  positions:async()=>amt!==0?[{symbol:'SOL-USDT',positionSide:'BOTH',positionAmt:String(amt),avgPrice:String(avg),markPrice:String(avg),unrealizedProfit:'0'}]:[],
  openOrders:async()=>({orders:[...v.userOrders,...[...orders.values()].filter(o=>o.status==='NEW')]}),
  getOrder:async(s,{orderId,clientOrderId})=>({order:[...orders.values()].find(o=>orderId?o.orderId===orderId:o.clientOrderId===clientOrderId)??null}),
  cancelOrder:async(s,oid)=>{calls.push({op:'cancel',oid});const o=orders.get(oid);if(o&&o.status==='NEW')o.status='CANCELED';return {}},
  placeOrder:async(p,{beforeSend}={})=>{const reason=beforeSend?.();if(reason)throw Object.assign(Error(reason),{code:'ENTRY_NOT_SENT',reason});
   calls.push({op:'order',...p});
   if(p.type==='MARKET'){const q=Number(p.quantity);
    if(p.reduceOnly==='true'){if(q>Math.abs(amt)+1e-9)throw Object.assign(Error('reduce only'),{code:'VENUE_ERROR_101205'});amt=+(amt-Math.sign(amt)*q).toFixed(8)}
    else{avg=PX;amt=+(amt+(p.side==='SELL'?-q:q)).toFixed(8)}
    return {order:add(p,{status:'FILLED',executedQty:String(q),avgPrice:String(PX)})}}
   if(/STOP|TAKE_PROFIT/.test(p.type))return {order:add(p)};
   return {order:add(p,{status:'CANCELED',executedQty:'0'})}}};
 const v={client,calls,userOrders:[],get amt(){return amt},manual(d){amt=+(amt+d).toFixed(8);avg=avg||PX}};
 return v;
}
function liveScalp(v,events=[]){
 const config=scalpLiveExecConfig({SCALP_LIVE_MODE:'LIVE',SCALP_LIVE_CONFIRM:SCALP_LIVE_CONFIRM_TOKEN,SCALP_MAKER_ENTRY:'off',SCALP_TREND_MODE:'on',SCALP_ZONE_SIGNALS:'off',
  SCALP_MIN_SCORE:'0',SCALP_BTC_GUARD:'off',SCALP_STOP_LOSS:'off',SCALP_SCALE_IN:'on'});
 const ex=new ScalpExecutor({config,client:v.client,contracts:async()=>new Map([['SOLUSDT',SOL]]),
  tickers:async()=>[{symbol:'SOL-USDT',lastPrice:String(PX),quoteVolume:'50000000'}],candles:async(s,int)=>int==='5m'?crash():up4h(T0),trendCandles:async()=>up4h(T0),
  priceOf:async()=>PX,markOf:async()=>PX,bookOf:async()=>({ok:true,bid:PX-.01,ask:PX+.01,mid:PX}),balance:async()=>({equity:2000,available:1600}),now:()=>T0,
  directory:fs.mkdtempSync(path.join(os.tmpdir(),'manual-first-scalp-')),log:()=>{},onEvent:e=>events.push(e)});
 ex.arm();return ex;
}

test('live scalp: a manual position or a user TP / SL on the coin skips the entry (MANUAL_FIRST)',async()=>{
 {const v=scalpVenue();v.manual(-1);const ex=liveScalp(v);await ex.scan(T0);
  assert.equal(ex.store.skips.at(-1).reason,'MANUAL_FIRST');assert.equal(v.calls.filter(c=>c.op==='order').length,0)}
 {const v=scalpVenue();v.userOrders=[{symbol:'SOL-USDT',orderId:'u1',clientOrderId:'man1',type:'STOP_MARKET',side:'SELL',positionSide:'BOTH',closePosition:'true',status:'NEW'}];
  const ex=liveScalp(v);await ex.scan(T0);
  assert.equal(ex.store.skips.at(-1).reason,'MANUAL_FIRST');assert.equal(v.calls.filter(c=>c.op==='order').length,0)}
 assert.equal(reasonLabel('MANUAL_FIRST'),'수동 포지션 우선');
});

test('live scalp: a manual add on its lane is not adopted, and its close sends only the scalp\'s own size',async()=>{
 const v=scalpVenue(),events=[];const ex=liveScalp(v,events);
 const st=await ex.scan(T0);assert.equal(st.entered,1);
 const p=ex.store.open[0],own=p.size;assert.ok(own>0);
 v.manual(1); // the user adds 1 SOL by hand on the same one-way lane
 await ex.reconcile();
 assert.equal(p.size,own,'not adopted');assert.equal(p.manualQty,1);
 const note=events.find(e=>e.type==='MANUAL_FIRST');assert.ok(note);assert.match(scalpEventText(note),/수동 포지션 우선/);
 const r=await ex.closePosition(p.id,{sleep:async()=>{}});assert.equal(r.ok,true,JSON.stringify(r));
 const closes=v.calls.filter(c=>c.op==='order'&&c.type==='MARKET'&&c.reduceOnly==='true');
 assert.deepEqual(closes.map(c=>Number(c.quantity)),[own]);
 assert.equal(v.amt,1,'the manual SOL stays');
});

// ---- User 2026-11-26: manual ratio-following (Option 2: unprotected manual only; TP/SL protected) ----
const BTC_CONTRACT={symbol:'BTCUSDT',venueSymbol:'BTC-USDT',tickSize:'0.1',quantityStep:'0.001',minQuantityBase:'0.001',minNotionalUSDT:2,tradable:true};
const BTC_OPEN=(q='0.1',e='100')=>`📌 포지션 진입\n━━━━━━━━━━━━━━━━\n🪙 BTCUSDT  🟢 Long  ×5\n━━━━━━━━━━━━━━━━\n진입가　${e} USDT\n현재가　${e} USDT\n수량　　${q}　마진 2.00 USDT\n손익　　🟢 +0.00 USDT`;
const BTC_CHANGE=(a,b)=>`📊 포지션 변경\n━━━━━━━━━━━━━━━━\n🪙 BTCUSDT  🟢 Long\n━━━━━━━━━━━━━━━━\n수량　　${a} → ${b}\n현재가　100 USDT\n손익　　🟢 +0.00 USDT`;
const BTC_CLOSE='✅ 포지션 청산\n━━━━━━━━━━━━━━━━\n🪙 BTCUSDT  🟢 Long\n━━━━━━━━━━━━━━━━\n진입가　100 USDT\n최종손익　🟢 +5.00 USDT';

function btcLaneVenue({hedge=false}={}){
 const calls=[],orders=new Map();let id=1,mark=100;
 const lanes={BOTH:0,LONG:0,SHORT:0};
 const row=(side,amt)=>({symbol:'BTC-USDT',positionSide:side,positionAmt:String(amt),avgPrice:'100',markPrice:String(mark),
  leverage:'5',unrealizedProfit:String((mark-100)*(side==='SHORT'?-amt:amt)),isolated:false});
 const client={
  positionMode:async()=>({dualSidePosition:hedge}),
  leverage:async()=>({maxLongLeverage:20,maxShortLeverage:20}),
  setMarginType:async(s,m)=>{calls.push({op:'margin',m});return {}},
  setLeverage:async(s,side,l)=>{calls.push({op:'lev',side,l});return {}},
  positions:async()=>hedge?['LONG','SHORT'].filter(k=>lanes[k]>0).map(k=>row(k,lanes[k])):lanes.BOTH!==0?[row('BOTH',lanes.BOTH)]:[],
  openOrders:async()=>{if(v.failOpenOrders)throw Object.assign(Error('down'),{code:'NETWORK_UNREACHABLE'});return {orders:v.userOrders}},
  cancelOrder:async(s,o,opt={})=>{calls.push({op:'cancel',o:o==null?null:String(o),cid:opt.clientOrderId??null});return {}},
  getOrder:async(s,{clientOrderId})=>{const o=orders.get(clientOrderId);if(!o)throw Object.assign(Error('order not exist'),{code:'VENUE_ERROR_80016'});return {order:o}},
  placeOrder:async p=>{calls.push({op:'order',...p});
   if(p.type!=='MARKET')return {order:{orderId:String(id++)}};
   const q=Number(p.quantity);
   if(hedge){const lane=p.positionSide,closing=lane==='LONG'?p.side==='SELL':p.side==='BUY';
    if(closing&&q>lanes[lane]+1e-9)throw Object.assign(Error('reduce more than held'),{code:'VENUE_ERROR_101205'});
    lanes[lane]=+(closing?lanes[lane]-q:lanes[lane]+q).toFixed(8)}
   else{const signed=p.side==='BUY'?q:-q,cur=lanes.BOTH;
    if(p.reduceOnly==='true'){if(!(Math.sign(cur)===-Math.sign(signed))||q>Math.abs(cur)+1e-9)throw Object.assign(Error('reduce only'),{code:'VENUE_ERROR_101205'})}
    lanes.BOTH=+(cur+signed).toFixed(8)}
   const o={orderId:String(id++),clientOrderId:p.clientOrderId,side:p.side,positionSide:p.positionSide,type:'MARKET',status:'FILLED',executedQty:String(q),avgPrice:String(mark)};
   orders.set(p.clientOrderId,o);return {order:o}},
 };
 const v={client,calls,lanes,userOrders:[],failOpenOrders:false,
  manual(lane,delta){lanes[lane]=+(lanes[lane]+delta).toFixed(8)},
  set mark(x){mark=x},
  orders:()=>calls.filter(c=>c.op==='order'&&c.type==='MARKET')};
 return v;
}
function btcCopy(v,{clock={t:2e12},manualPositions,audit=false,stops='off'}={}){
 const ex=new CopyExecutor({config:{...copyConfig({COPY_SIZING:'BALANCE_RATIO',COPY_TRADER_BALANCE_USD:'20000',COPY_STOPS:stops,COPY_LEDGER_LOSS_PCT:'50'},'TESTNET'),mode:'LIVE'},
  client:v.client,contractOf:async()=>BTC_CONTRACT,balance:async()=>({equity:10000,available:8000}),gate:()=>({ok:true}),now:()=>clock.t,
  auditOrders:audit,manualPositions});
 ex.sleep=async()=>{};ex.goneRecheckMs=0;
 let n=0;ex.msg=text=>{clock.t+=1000;return ex.handle({id:++n,date:clock.t,text})};
 return ex;
}

for(const hedge of [false,true]){
 const lane=hedge?'LONG':'BOTH';
 test(`${hedge?'hedge':'one-way'}: manual 1 vs trader 0.1 links without ordering, then scales add (+0.1 -> +1), partial close (-40%), and full close (-100%)`,async()=>{
  const clock={t:2e12};
  const v=btcLaneVenue({hedge});
  v.manual(lane,1); // user manually entered 1.0 BTC LONG (no TP/SL)
  // Even while manualLedger still has an open record on that lane, manualLinked adds must proceed cleanly.
  const ex=btcCopy(v,{clock,manualPositions:()=>[{venueSymbol:'BTC-USDT',direction:'LONG',status:'OPEN',lastSeenAt:clock.t}]});

  // 1) Trader opens 0.1 -> copy initial entry is skipped, ratio 10x linked
  const rOpen=await ex.msg(BTC_OPEN('0.1','100'));
  assert.equal(rOpen.ok,true);assert.equal(rOpen.skippedEntry,true);assert.equal(rOpen.manualLinked,true);
  assert.equal(v.orders().length,0,'initial copy entry skipped');
  assert.equal(v.lanes[lane],1);
  assert.equal(ledgerOwnQty(ex.status().positions[0]),1);

  // 2) Trader adds 0.1 (0.1 -> 0.2, +100% of first entry) -> we add 1.0 (total 2.0)
  const rAdd1=await ex.msg(BTC_CHANGE('0.1','0.2'));
  assert.equal(rAdd1.ok,true,JSON.stringify(rAdd1));
  assert.equal(v.orders().length,1);
  assert.equal(Number(v.orders()[0].quantity),1);
  assert.equal(v.lanes[lane],2);

  // 3) Trader adds 0.05 via another OPEN card -> we add 0.5 (total 2.5)
  const rAdd2=await ex.msg(BTC_OPEN('0.05','101'));
  assert.equal(rAdd2.ok,true,JSON.stringify(rAdd2));
  assert.equal(v.orders().length,2);
  assert.equal(Number(v.orders()[1].quantity),0.5);
  assert.equal(v.lanes[lane],2.5);

  // 4) Trader partially closes 40% (0.25 -> 0.15) -> we reduce 1.0 (40% of 2.5), leaving 1.5
  const rCut=await ex.msg(BTC_CHANGE('0.25','0.15'));
  assert.equal(rCut.ok,true,JSON.stringify(rCut));
  assert.equal(v.orders().length,3);
  assert.equal(Number(v.orders()[2].quantity),1);
  assert.equal(v.lanes[lane],1.5);

  // 5) Trader closes 100% -> we close remaining 1.5, leaving 0
  const rClose=await ex.msg(BTC_CLOSE);
  assert.equal(rClose.ok,true,JSON.stringify(rClose));
  assert.equal(v.orders().length,4);
  assert.equal(Number(v.orders()[3].quantity),1.5);
  assert.equal(v.lanes[lane],0);
  assert.equal(ex.status().positions.length,0);
  assert.equal(ex.status().closed[0].closeReason,'TRADER_CLOSE');
 });
}

test('Option 2 runtime protection: adding manual TP/SL after linking blocks add, partial close, full close (releases link), and emergency close',async()=>{
 const sl={symbol:'BTC-USDT',orderId:'u-sl-1',clientOrderId:'man-sl-1',type:'STOP_MARKET',side:'SELL',positionSide:'BOTH',closePosition:'true',status:'NEW'};
 // Case A: mid-flight TP/SL blocks add, reduce, and full close (releasing link cleanly so reconcile never touches it)
 {
  const v=btcLaneVenue();v.manual('BOTH',1);
  const ex=btcCopy(v);
  assert.equal((await ex.msg(BTC_OPEN('0.1','100'))).manualLinked,true);
  v.userOrders=[sl]; // user sets manual SL after linking
  assert.equal((await ex.msg(BTC_CHANGE('0.1','0.2'))).reason,'MANUAL_FIRST');
  assert.equal((await ex.msg(BTC_CHANGE('0.2','0.1'))).reason,'MANUAL_FIRST');
  const rc=await ex.msg(BTC_CLOSE);
  assert.equal(rc.reason,'MANUAL_FIRST');assert.equal(rc.released,true);
  assert.equal(v.orders().length,0,'zero orders sent once TP/SL is present');
  assert.equal(v.lanes.BOTH,1,'manual position completely untouched');
  assert.equal(ex.status().positions.length,0,'released back to pure manual management');
  assert.ok(ex.status().events.some(e=>e.type==='MANUAL_RELEASED'),'emits unthrottled MANUAL_RELEASED event');
  await ex.reconcile();
  assert.equal(v.orders().length,0);
 }
 // Case B: COPY_LOSS_LIMIT / emergency never force-closes a manualLinked position with user TP/SL (and manualLinked drawdown does not trigger copy kill-switch)
 {
  const v=btcLaneVenue();v.manual('BOTH',1);
  const ex=btcCopy(v);
  assert.equal((await ex.msg(BTC_OPEN('0.1','100'))).manualLinked,true);
  v.userOrders=[sl];
  v.mark=-6000; // huge unrealized loss on manual position
  await ex.reconcile();
  assert.equal(v.orders().length,0,'emergency loss limit never closes TP/SL-protected manual position');
  assert.equal(ex.store.killed,false,'manualLinked drawdown alone must not trigger copy kill-switch');
  assert.equal(v.lanes.BOTH,1);
  // Even if kill-switch was already triggered by another copy position, #emergency detaches TP/SL-protected manualLinked cleanly
  ex.store.killed=true;
  await ex.reconcile();
  assert.equal(v.orders().length,0,'killed copy never force-closes TP/SL-protected manualLinked');
  assert.equal(v.lanes.BOTH,1);
  assert.equal(ex.status().positions.length,0,'detached back to manual');
 }
 // Case C: fail-closed when openOrders is unreadable (transient error does not permanently add to manualFirstSkips)
 {
  const v=btcLaneVenue();v.manual('BOTH',1);v.failOpenOrders=true;
  const ex=btcCopy(v);
  assert.equal((await ex.msg(BTC_OPEN('0.1','100'))).reason,'COPY_ORDERS_UNREADABLE','unreadable openOrders does not link');
  assert.equal(ex.status().positions.length,0);
  v.failOpenOrders=false;
  assert.equal((await ex.msg(BTC_OPEN('0.1','100'))).manualLinked,true,'links cleanly once openOrders recovers');
 }
 {
  const v=btcLaneVenue();v.manual('BOTH',1);
  const ex=btcCopy(v);
  assert.equal((await ex.msg(BTC_OPEN('0.1','100'))).manualLinked,true);
  v.failOpenOrders=true;
  assert.equal((await ex.msg(BTC_CHANGE('0.1','0.2'))).reason,'COPY_ORDERS_UNREADABLE');
  assert.equal((await ex.msg(BTC_CHANGE('0.2','0.1'))).reason,'COPY_ORDERS_UNREADABLE');
  assert.equal((await ex.msg(BTC_CLOSE)).reason,'COPY_ORDERS_UNREADABLE');
  assert.equal(v.orders().length,0,'fail-closed sends zero orders when openOrders fails');
  assert.equal(v.lanes.BOTH,1);
 }
});

test('manualLinked with COPY_STOPS=on + auditOrders=true: never places copy stop, never blocks adds after user manual partial close',async()=>{
 const clock={t:2e12};
 const v=btcLaneVenue();v.manual('BOTH',1);
 const ex=btcCopy(v,{clock,audit:true,stops:'on'});
 await ex.reconcile();
 assert.equal((await ex.msg(BTC_OPEN('0.1','100'))).manualLinked,true);
 await ex.reconcile();
 assert.equal(v.calls.filter(c=>c.op==='order'&&c.type==='STOP_MARKET').length,0,'COPY_STOPS=on must never place a copy stop on manualLinked');
 assert.equal(v.orders().length,0,'COPY_STOPS=on must never emergency-close manualLinked');
 assert.deepEqual(ex.auditStatus().lanes[0].issues,[],'manualLinked must not trigger STOP_MISSING in audit');
 assert.equal(ex.auditStatus().lanes[0].stop,'MANUAL');
 // User manually trims 1.0 -> 0.5 on BingX; reconcile syncs auditQty so next trader add is not blocked
 v.manual('BOTH',-0.5);
 await ex.reconcile();
 assert.deepEqual(ex.auditStatus().lanes[0].issues,[],'manual partial close syncs auditQty');
 const addRes=await ex.msg(BTC_CHANGE('0.1','0.2'));
 assert.equal(addRes.ok,true,JSON.stringify(addRes));
 assert.equal(Number(v.orders()[0].quantity),1,'add follows manualBaseQty*(theirAdd/theirFirstQty)');
 assert.equal(v.lanes.BOTH,1.5);
 assert.equal(v.calls.filter(c=>c.op==='order'&&c.type==='STOP_MARKET').length,0,'adds also never place copy stop on manualLinked');
});

test('hedge mode: manual Limit TP (no reduceOnly) blocks linking and protects runtime add/reduce/close',async()=>{
 const limitTp={symbol:'BTC-USDT',orderId:'u-tp-1',clientOrderId:'',type:'LIMIT',side:'SELL',positionSide:'LONG',price:'120',origQty:'1',executedQty:'0',status:'NEW'};
 const openingLimit={symbol:'BTC-USDT',orderId:'u-open-1',clientOrderId:'',type:'LIMIT',side:'BUY',positionSide:'LONG',price:'90',origQty:'1',executedQty:'0',status:'NEW'};
 assert.equal(userProtectOrder(limitTp,{hedge:true,direction:'LONG'}),true,'hedge closing Limit TP counts as protection');
 assert.equal(userProtectOrder(openingLimit,{hedge:true,direction:'LONG'}),false,'hedge opening Limit order is not TP/SL');
 const v=btcLaneVenue({hedge:true});v.manual('LONG',1);v.userOrders=[limitTp];
 const ex=btcCopy(v);
 assert.equal((await ex.msg(BTC_OPEN('0.1','100'))).reason,'MANUAL_FIRST','hedge Limit TP skips linking');
 assert.equal(ex.status().positions.length,0);
 // Clear skip, link without TP, then add hedge Limit TP mid-flight
 await ex.msg(BTC_CLOSE);v.userOrders=[openingLimit];
 assert.equal((await ex.msg(BTC_OPEN('0.1','100'))).manualLinked,true,'opening limit does not block linking');
 v.userOrders=[limitTp];
 assert.equal((await ex.msg(BTC_CHANGE('0.1','0.2'))).reason,'MANUAL_FIRST');
 assert.equal((await ex.msg(BTC_CHANGE('0.2','0.1'))).reason,'MANUAL_FIRST');
 const rc=await ex.msg(BTC_CLOSE);
 assert.equal(rc.reason,'MANUAL_FIRST');assert.equal(rc.released,true);
 assert.equal(v.orders().length,0);
});

test('COPY_ORDERS_UNREADABLE on #close keeps p.closing across >5 retries, never turns next OPEN into add, and closes on recovery',async()=>{
 const clock={t:2e12};
 const v=btcLaneVenue();v.manual('BOTH',1);
 const ex=btcCopy(v,{clock});
 assert.equal((await ex.msg(BTC_OPEN('0.1','100'))).manualLinked,true);
 v.failOpenOrders=true;
 assert.equal((await ex.msg(BTC_CLOSE)).reason,'COPY_ORDERS_UNREADABLE');
 // Even after 6 failed reconciles (past pending max tries=5), p.closing stays set and blocks new OPEN from adding
 for(let i=0;i<6;i++)await ex.reconcile();
 assert.equal(v.orders().length,0,'zero orders while openOrders unreadable');
 assert.equal((await ex.msg(BTC_OPEN('0.2','105'))).reason,'CLOSING','next OPEN must not add into a pending-close manualLinked position');
 // Once openOrders recovers, next reconcile completes the close cleanly
 v.failOpenOrders=false;
 await ex.reconcile();
 assert.equal(v.lanes.BOTH,0,'position closed cleanly on recovery');
 assert.equal(ex.status().positions.length,0);
});

test('RealTrailingManager skips manualLinked (even applyToCopy=true) and cancels prior optr stop (even applyToCopy=false)',async()=>{
 const calls=[];
 const rt=new RealTrailingManager({
  executeAction:async a=>{calls.push(a);return {ok:true,orderId:'T'+calls.length,stopPrice:101}},
  sendText:async()=>{},
 });
 rt.configure({enabled:true,applyToManual:true,applyToCopy:false});
 const baseRow={symbol:'BTCUSDT',venueSymbol:'BTC-USDT',direction:'LONG',size:1,avg:100,mark:125,leverage:5,margin:20,roePct:25,unrealized:25};
 // 1) Before copy links, realTrailing places optr lock stop on unprotected manual position
 await rt.evaluate([{...baseRow,origin:'manual'}],1e12,{openOrders:[]});
 assert.ok(calls.length>0,'manual position gets trailing actions');
 assert.ok(rt.tracked.has('BTCUSDT|LONG'));
 calls.length=0;
 // 2) Copy links it -> tagOrigins marks origin:'copy', manualLinked:true -> realTrailing cancels prior stops even with applyToCopy=false
 const tagged=tagOrigins([baseRow],[{symbol:'BTCUSDT',venueSymbol:'BTC-USDT',direction:'LONG',status:'OPEN',manualLinked:true,manualScale:10,ownQty:1,qtyStep:0.001}]);
 assert.equal(tagged[0].manualLinked,true);
 await rt.evaluate(tagged,1e12+20000,{openOrders:[]});
 assert.ok(calls.some(c=>c.action==='CANCEL_STOP'),'cancels pre-link trailing stop on manualLinked handoff');
 assert.equal(rt.tracked.has('BTCUSDT|LONG'),false);
 // 3) Even with applyToCopy=true, realTrailing never acts on manualLinked
 rt.configure({applyToCopy:true});calls.length=0;
 await rt.evaluate(tagged,1e12+40000,{openOrders:[]});
 assert.equal(calls.length,0,'never acts on manualLinked even when applyToCopy is true');
});

test('manualLinked settlement recovers pre-link manual opening fill as CONFIRMED and ManualLedger avoids duplicate MIXED_WITH_COPY',async()=>{
 const clock={t:2e12};
 const v=btcLaneVenue();v.manual('BOTH',1);
 const manualOpenAt=clock.t-300000;
 const manualOrder={orderId:'m-open-1',symbol:'BTC-USDT',side:'BUY',positionSide:'BOTH',type:'MARKET',status:'FILLED',executedQty:'1',avgPrice:'100',updateTime:manualOpenAt};
 const copyOrders=[];
 const origPlace=v.client.placeOrder;
 v.client.placeOrder=async p=>{const r=await origPlace(p);if(p.type==='MARKET')copyOrders.push({...r.order,symbol:'BTC-USDT',updateTime:clock.t});return r};
 v.client.allOrders=async()=>({orders:[manualOrder,...copyOrders]});
 v.client.fillHistory=async()=>({fill_orders:[
  {tradeId:'t1',orderId:'m-open-1',symbol:'BTC-USDT',side:'BUY',filledQty:'1',price:'100',commission:'-0.05',realizedPnl:'0',filledTime:manualOpenAt},
  ...copyOrders.map((o,i)=>({tradeId:`t${i+2}`,orderId:o.orderId,symbol:'BTC-USDT',side:o.side,filledQty:o.executedQty,price:o.avgPrice,commission:'-0.05',realizedPnl:o.side==='SELL'?'10':'0',filledTime:o.updateTime})),
 ]});
 let ex;
 const ml=new ManualLedger({openReads:1,closeReads:1,now:()=>clock.t,copyRecords:()=>ex?ex.status().positions:[]});
 ex=btcCopy(v,{clock,manualPositions:()=>Object.values(ml.store.positions)});
 // ManualLedger observes user's manual position first and keeps it fresh every 15s
 ml.observe({venuePositions:[{symbol:'BTCUSDT',venueSymbol:'BTC-USDT',direction:'LONG',size:1,avg:100,mark:100,leverage:5,origin:'manual'}],venuePositionsAt:manualOpenAt});
 ml.observe({venuePositions:[{symbol:'BTCUSDT',venueSymbol:'BTC-USDT',direction:'LONG',size:1,avg:100,mark:100,leverage:5,origin:'manual'}],venuePositionsAt:clock.t-1000});
 assert.equal(Object.keys(ml.store.positions).length,1);
 // Copy links it -> ManualLedger hands off cleanly without leaving a frozen mergedIntoCopy row
 assert.equal((await ex.msg(BTC_OPEN('0.1','100'))).manualLinked,true);
 ml.observe({venuePositions:tagOrigins([{symbol:'BTCUSDT',venueSymbol:'BTC-USDT',direction:'LONG',size:1,avg:100,mark:100,leverage:5}],ex.status().positions),venuePositionsAt:clock.t});
 assert.equal(Object.keys(ml.store.positions).length,0,'ManualLedger drops open record on manualLinked handoff');
 // Trader adds (+0.1 -> +1.0) and closes at 105
 assert.equal((await ex.msg(BTC_CHANGE('0.1','0.2'))).ok,true);
 v.mark=105;
 assert.equal((await ex.msg(BTC_CLOSE)).ok,true);
 clock.t+=20000;
 await ex.settle({limit:5});
 const closed=ex.status().closed[0];
 assert.equal(closed.netSource,'EXCHANGE_FILLS','manualLinked trade settles as CONFIRMED');
 assert.equal(closed.settlement.state,'CONFIRMED');
 assert.equal(ml.store.closed.length,0,'no duplicate MIXED_WITH_COPY row in ManualLedger');
});

test('manualLinked partial close rounding never closes 100% on a partial trim and Telegram formats MANUAL_LINKED/MANUAL_RELEASED/MANUAL_PROTECT_HOLD',async()=>{
 const v=btcLaneVenue();v.manual('BOTH',0.001); // minimum step = 0.001
 const ex=btcCopy(v);
 assert.equal((await ex.msg(BTC_OPEN('0.1','100'))).manualLinked,true);
 // Trader trims 60% (0.1 -> 0.04): 0.0006 would round up to 0.001 (100% close) — manualLinked must skip as tooSmall instead of closing 100%
 const rc=await ex.msg(BTC_CHANGE('0.1','0.04'));
 assert.equal(rc.ok,true);assert.equal(rc.tooSmall,true);
 assert.equal(v.orders().length,0,'partial trim must not round up into a 100% close');
 assert.equal(v.lanes.BOTH,0.001);
 assert.equal(ex.status().positions[0].theirTotal,0.04,'theirTotal updated even when cut is tooSmall');
 // Telegram notification formatting checks
 assert.match(copyEventText({type:'MANUAL_LINKED',symbol:'BTCUSDT',direction:'LONG',mode:'LIVE',qty:1,theirQty:0.1,ratio:10}),/비율 연결/);
 assert.match(copyEventText({type:'MANUAL_RELEASED',symbol:'BTCUSDT',direction:'LONG',mode:'LIVE',detail:'TP/SL 설정'}),/연결 해제/);
 assert.match(copyEventText({type:'MANUAL_PROTECT_HOLD',symbol:'BTCUSDT',direction:'LONG',mode:'LIVE',reason:'MANUAL_FIRST',detail:'TP/SL 보호'}),/수동 TP\/SL 보호/);
 assert.doesNotMatch(copyEventText({type:'MANUAL_PROTECT_HOLD',symbol:'BTCUSDT',direction:'LONG',mode:'LIVE',reason:'MANUAL_FIRST',detail:'TP/SL 보호'}),/카피 몫 불명/);
 assert.match(copyEventText({type:'MANUAL_PROTECT_HOLD',symbol:'BTCUSDT',direction:'LONG',mode:'LIVE',reason:'COPY_ORDERS_UNREADABLE'}),/미체결 주문 조회 실패/);
});

test('ManualLedger re-adopts a released manualLinked position cleanly as manual without stranded managedPositions or [카피] alerts',async()=>{
 const clock={t:2e12};
 const v=btcLaneVenue();v.manual('BOTH',1);
 let ex;
 const ml=new ManualLedger({openReads:1,closeReads:1,now:()=>clock.t,
  copyRecords:()=>ex?[...ex.status().positions,...ex.status().closed].map(p=>({...p,alertOrigin:'COPY',alertOwnerId:p.id})):[]});
 ex=btcCopy(v,{clock,manualPositions:()=>Object.values(ml.store.positions)});
 const row={symbol:'BTCUSDT',venueSymbol:'BTC-USDT',direction:'LONG',size:1,avg:100,mark:100,leverage:5};
 // 1) Manual open observed
 ml.observe({venuePositions:[{...row,origin:'manual'}],venuePositionsAt:clock.t});
 assert.equal(Object.keys(ml.store.positions).length,1);
 // 2) Copy links -> handed off to managedPositions with manualLinked:true
 assert.equal((await ex.msg(BTC_OPEN('0.1','100'))).manualLinked,true);
 clock.t+=5000;
 ml.observe({venuePositions:tagOrigins([row],ex.status().positions),venuePositionsAt:clock.t});
 assert.equal(Object.keys(ml.store.positions).length,0);
 assert.equal(ml.store.managedPositions['BTC-USDT|LONG']?.manualLinked,true);
 // 3) User sets manual SL and trader closes -> #releaseManualLinked detaches copy without closing venue position
 v.userOrders=[{symbol:'BTC-USDT',orderId:'u-sl-9',clientOrderId:'man-sl-9',type:'STOP_MARKET',side:'SELL',positionSide:'BOTH',closePosition:'true',status:'NEW'}];
 const rc=await ex.msg(BTC_CLOSE);
 assert.equal(rc.reason,'MANUAL_FIRST');assert.equal(rc.released,true);
 assert.equal(ex.status().positions.length,0);
 // 4) Next ManualLedger observe drops stranded managedPositions and re-adopts cleanly as manual
 clock.t+=5000;
 ml.observe({venuePositions:tagOrigins([row],ex.status().positions),venuePositionsAt:clock.t});
 assert.equal(ml.store.managedPositions['BTC-USDT|LONG'],undefined,'managedPositions cleared on release');
 assert.equal(Object.keys(ml.store.positions).length,1,'re-adopted into manual store.positions');
 assert.equal(ml.store.positions['BTC-USDT|LONG'].origin,'manual');
 // 5) User manually closes on BingX -> recorded as manual close, zero COPY alerts queued
 clock.t+=5000;
 ml.observe({venuePositions:[],venuePositionsAt:clock.t});
 assert.equal(Object.keys(ml.store.positions).length,0);
 assert.equal(ml.store.closed.length,1);
 assert.equal(ml.store.closed[0].origin,'manual');
 assert.equal(ml.store.pendingAlerts.some(a=>a.alertOrigin==='COPY'),false,'no [카피] alerts queued for detached manual close');
});
