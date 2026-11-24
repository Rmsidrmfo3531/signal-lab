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

test('one-way: a manual position of the coin in EITHER direction skips the copy entry (MANUAL_FIRST), no setting or order is sent',async()=>{
 for(const manual of [50,-30]){ // a manual LONG (opposite to the SHORT copy) and a manual SHORT (same direction)
  const v=laneVenue();v.manual('BOTH',manual);const ex=copy(v);
  const r=await ex.msg(OPEN);
  assert.equal(r.reason,'MANUAL_FIRST');
  assert.deepEqual(v.calls.filter(c=>['order','lev','margin','cancel'].includes(c.op)),[],'no leverage, margin mode, order or cancel');
  const e=evs(ex,x=>x.reason==='MANUAL_FIRST')[0];
  assert.match(copyEventText(e),/수동 포지션 우선 — 카피 진입 건너뜀/);
  assert.equal(v.lanes.BOTH,manual,'the manual position is untouched');
 }
});

test('the trader\'s later adds of a MANUAL_FIRST-skipped entry are not followed (no late entry) until the trader closes; then the next entry is copied',async()=>{
 const v=laneVenue();v.manual('BOTH',-30);const ex=copy(v);
 assert.equal((await ex.msg(OPEN)).reason,'MANUAL_FIRST');
 assert.equal((await ex.msg(CHANGE(880,1760))).reason,'MANUAL_FIRST');
 v.manual('BOTH',30); // the user closed the manual position, the trader still holds his
 assert.equal((await ex.msg(CHANGE(1760,2640))).reason,'MANUAL_FIRST','still the skipped trader position');
 assert.equal((await ex.msg(OPEN)).reason,'MANUAL_FIRST','an entry card of the same trader position is an add of it');
 assert.equal(evs(ex,x=>x.type==='LATE_ENTRY').length,0);
 assert.equal(v.orders().length,0);
 assert.equal((await ex.msg(CLOSE)).ok,true);
 const r=await ex.msg(OPEN);assert.equal(r.ok,true,JSON.stringify(ex.status().events.slice(0,2)));
 assert.equal(v.lanes.BOTH,-98);assert.equal(ex.status().positions[0].ownQty,98);
});

test('hedge: a manual position on the same side skips; on the other side the copy enters without touching the margin mode, and never when it is isolated',async()=>{
 {const v=laneVenue({hedge:true});v.manual('SHORT',30);const ex=copy(v);
  assert.equal((await ex.msg(OPEN)).reason,'MANUAL_FIRST');assert.equal(v.calls.filter(c=>c.op!=='get').length,0)}
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
