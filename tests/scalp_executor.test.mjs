import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {ScalpExecutor,scalpExecConfig,scalpSplits,planScalpOrder,scalpUniverse,scalpClientId,scalpSides,signedAmount,SCALP_EXEC_COSTS,SCALP_EXEC_SETTINGS} from '../scalp_executor.mjs';
import {scalpEventText,scalpReasonKo} from '../scalp_telegram.mjs';
import {detectScalpReversal,SCALP_TIMEFRAMES} from '../scalp_reversal.mjs';
import {BACKTEST_COSTS} from '../backtest.mjs';
import {scalpDetailsHTML,scalpPositionCardHTML} from '../public/live_control.js';

const I=300000,BUCKET=Math.floor(Date.parse('2026-11-16T03:00:00Z')/I),T0=BUCKET*I+5000;
// 50 quiet 5m candles near 100, a fast ~6.6 % drop on heavy volume, then a hammer (the candle that just closed).
function crash({move=6,volume=10,lastOpen=(BUCKET-1)*I,wick=.8}={}){
 const rows=[];let p=100;const push=(o,h,l,c,v)=>rows.push([0,o,h,l,c,v]);
 for(let i=0;i<50;i++){const o=p,c=p+(i%2?.05:-.05);push(o,Math.max(o,c)+.1,Math.min(o,c)-.1,c,100);p=c}
 for(let i=0;i<4;i++){const o=p,c=p-move/4;push(o,o+.05,c-.1,c,100*volume*(i===3?1:.5));p=c}
 push(p,p+.15,p-wick,p+.1,80*volume);
 return rows.map((r,i)=>{const t=lastOpen-(rows.length-1-i)*I;return [t,...r.slice(1,6).map(String),t+I-1,String(r[5]*r[4])]});
}
const up4h=now=>Array.from({length:301},(_,i)=>{const t=now-(301-i)*4*3600000-1000,c=50+i*.1;return [t,String(c),String(c+.2),String(c-.2),String(c),'1000',t+4*3600000-1,'1']});
const down4h=now=>up4h(now).map((r,i)=>{const c=200-i*.1;return [r[0],String(c),String(c+.2),String(c-.2),String(c),'1000',r[6],'1']});
// The mirror image around 100: a fast ~6.6 % rise and a shooting star (SHORT).
const rise=o=>crash(o).map(r=>[r[0],String(200-r[1]),String(200-r[3]),String(200-r[2]),String(200-r[4]),r[5],r[6],r[7]]);
const ENTRY=Number(crash().at(-1)[4]),PX=+(ENTRY+.02).toFixed(2),ENTRY_S=Number(rise().at(-1)[4]),PX_S=+(ENTRY_S-.02).toFixed(2);
const SOL={symbol:'SOLUSDT',venueSymbol:'SOL-USDT',tickSize:'0.01',quantityStep:'0.01',minQuantityBase:'0.01',minNotionalUSDT:2,tradable:true};

// One-way BingX fake: amt is the signed position (+ long, - short), as positionAmt.
function venue({hedge=false,modeFail=false,failStop=false,maxLev=20,fillAt=PX,fillAdd=true,loseAddReply=false,loseEarlyReply=false}={}){
 const calls=[],orders=new Map();let amt=0,avg=0,mark=0,id=1;
 const reduce=q=>{amt=amt>0?+Math.max(0,amt-q).toFixed(8):+Math.min(0,amt+q).toFixed(8)};
 const add=(p,extra={})=>{const o={orderId:String(id++),...p,status:'NEW',...extra};orders.set(o.orderId,o);return o};
 const client={mode:'TESTNET',
  positionMode:async()=>{if(modeFail)throw Object.assign(Error('down'),{code:'NETWORK_UNREACHABLE'});return {dualSidePosition:hedge}},marginType:async()=>({marginType:'CROSSED'}),setMarginType:async()=>({}),
  leverage:async()=>({maxLongLeverage:maxLev,maxShortLeverage:maxLev}),setLeverage:async(s,side,l)=>{calls.push({op:'lev',l});return {leverage:l}},
  positions:async()=>amt!==0?[{symbol:'SOL-USDT',positionSide:'BOTH',positionAmt:String(amt),avgPrice:String(avg),markPrice:String(mark||avg),unrealizedProfit:String(((mark||avg)-avg)*amt)}]:[],
  openOrders:async()=>({orders:[...orders.values()].filter(o=>o.status==='NEW')}),
  getOrder:async(s,{orderId,clientOrderId})=>({order:[...orders.values()].find(o=>orderId?o.orderId===orderId:o.clientOrderId===clientOrderId)??null}),
  cancelOrder:async(s,oid)=>{calls.push({op:'cancel',oid});const o=orders.get(oid);if(o&&o.status==='NEW')o.status='CANCELED';return {}},
  placeOrder:async(p,{beforeSend}={})=>{const reason=beforeSend?.();if(reason)throw Object.assign(Error(reason),{code:'ENTRY_NOT_SENT',reason});calls.push({op:'order',...p});
   if(failStop&&p.type==='STOP_MARKET')throw Object.assign(Error('no'),{code:'VENUE_ERROR_1'});
   if(p.type==='LIMIT'&&p.timeInForce==='FOK'){
    if(!fillAdd)return {order:add(p,{status:'CANCELED',executedQty:'0'})};
    const q=Number(p.quantity),price=Number(p.price);
    avg=(avg*Math.abs(amt)+price*q)/(Math.abs(amt)+q);amt=+(amt+(p.side==='SELL'?-q:q)).toFixed(8);
    const o=add(p,{status:'FILLED',executedQty:String(q),avgPrice:String(price)});
    if(loseAddReply)throw Object.assign(Error('response lost'),{code:'NETWORK_UNREACHABLE'});
    return {order:o};
   }
   if(p.type==='LIMIT'&&p.timeInForce==='IOC'){
    const q=Number(p.quantity),canFill=p.side==='SELL'?mark>=Number(p.price):mark<=Number(p.price);
    if(!canFill)return {order:add(p,{status:'EXPIRED',executedQty:'0'})};
    reduce(q);
    const o=add(p,{status:'FILLED',executedQty:String(q),avgPrice:String(mark)});
    if(loseEarlyReply)throw Object.assign(Error('response lost'),{code:'NETWORK_UNREACHABLE'});
    return {order:o};
   }
   if(p.type==='MARKET'){const q=Number(p.quantity);
    if(p.reduceOnly){reduce(q);return {order:add(p,{status:'FILLED',executedQty:String(q),avgPrice:String(mark||avg)})}}
    avg=mark||fillAt;amt=+(amt+(p.side==='SELL'?-q:q)).toFixed(8);const o=add(p,{status:'FILLED',executedQty:String(q),avgPrice:String(avg)});
    if(p.stopLoss){const sl=JSON.parse(p.stopLoss);add({symbol:p.symbol,type:'STOP_MARKET',stopPrice:String(sl.stopPrice),side:p.side==='SELL'?'BUY':'SELL'})}
    return {order:o}}
   return {order:add(p)}}};
 return {client,calls,orders,get size(){return Math.abs(amt)},set size(v){amt=v},get amt(){return amt},set mark(v){mark=v},get avg(){return avg},
  fill(o,price){o.status='FILLED';o.executedQty=o.quantity??String(Math.abs(amt));o.avgPrice=String(price??o.stopPrice);reduce(Number(o.executedQty))}};
}
function make(v,{clock={t:T0},price=PX,funds={equity:10000,available:9000},gate=()=>({ok:true}),isBusy=()=>false,dir=null,trend=up4h,contract=SOL,config={},rows=crash,budget=null,zone=null}={}){
 return new ScalpExecutor({config:{...scalpExecConfig({}),stopLossEnabled:true,scaleIn:false,...config},client:v.client,contracts:async()=>new Map([['SOLUSDT',contract]]),tickers:async()=>[{symbol:'SOL-USDT',quoteVolume:'90000000'},{symbol:'NCSKAAPL2USD-USDT',quoteVolume:'1e12'}],
  candles:async(s,iv)=>iv==='5m'?[...rows(),[BUCKET*I,'100','100','100','100','1',BUCKET*I+I-1,'1']]:trend(clock.t),priceOf:async()=>typeof price==='function'?price():price,markOf:async()=>101,
  balance:async()=>typeof funds==='function'?funds():funds,gate,isBusy,directory:dir,now:()=>clock.t,budget,...(zone?{zoneCandles:zone}:{})});
}
const tmp=()=>fs.mkdtempSync(path.join(os.tmpdir(),'scalp-exec-'));
const placed=(v,type)=>v.calls.filter(c=>c.op==='order'&&c.type===type);
const short=(opt={})=>{const v=venue({fillAt:PX_S,...opt.venue}),clock=opt.clock||{t:T0};return {v,clock,ex:make(v,{clock,price:PX_S,trend:down4h,rows:rise,...opt})}};

test('profit-only testnet checks immediately, covers fees and booked loss, and recovers a lost reply',async()=>{
 for(const direction of ['LONG','SHORT']){
  const dir=tmp(),clock={t:T0},shortSide=direction==='SHORT',sign=shortSide?-1:1;
  const v=venue({fillAt:shortSide?PX_S:PX,loseEarlyReply:shortSide});
  const inputs={clock,dir,config:{stopLossEnabled:false,scaleIn:false},
   ...(shortSide?{price:PX_S,trend:down4h,rows:rise}:{})};
  try{
   let ex=make(v,inputs);ex.arm();await ex.scan();
   const p=ex.store.open[0];assert.equal(p.direction,direction);
   const requests=()=>placed(v,'LIMIT').filter(x=>x.timeInForce==='IOC');
   const getPositions=v.client.positions;
   let bookedLoss=0;
   v.client.positions=async(...args)=>(await getPositions(...args)).map(row=>({...row,realisedProfit:String(-bookedLoss)}));
   v.mark=p.avg+sign*.02;
   clock.t=p.openedAt+15000;await ex.reconcile();assert.equal(requests().length,0);
   bookedLoss=p.size*2;
   v.mark=p.avg+sign;
   clock.t+=15000;await ex.reconcile();assert.equal(requests().length,0);
   v.mark=p.avg+sign*3;
   clock.t+=15000;await ex.reconcile();
   const [order]=requests();
   assert.equal(order.side,shortSide?'BUY':'SELL');assert.equal(order.reduceOnly,'true');
   assert.ok(sign*(Number(order.price)-p.avg)>2+.0012*p.avg);
   assert.equal(v.size,0);
   if(shortSide){assert.ok(p.earlyTakeProfit);ex=make(v,inputs)}
   clock.t+=15000;await ex.reconcile();clock.t+=15000;await ex.reconcile();
   assert.equal(requests().length,1);
   assert.equal(ex.store.closed[0].closeReason,'EARLY_TAKE_PROFIT');
   assert.ok(ex.store.closed[0].netUSD>0);
  }finally{fs.rmSync(dir,{recursive:true,force:true})}
 }
});

test('the scalp card displays first fill, venue mark and PnL, margin, realized PnL and repeat adds',async()=>{
 const v=venue(),clock={t:T0},ex=make(v,{clock,config:{stopLossEnabled:false,scaleIn:true}});
 ex.arm();await ex.scan();
 const [p]=ex.store.open,first=p.avg;
 assert.ok(p.scaleIn);p.scaleIn.count=2;
 const signed=v.client.positions;
 v.client.positions=async()=> (await signed()).map(row=>({...row,avgPrice:'94.27',markPrice:'94.90',
  initialMargin:'330.59',unrealizedProfit:'-10.47',realisedProfit:'-1.82'}));
 clock.t+=15000;await ex.reconcile();
 const [view]=(await ex.liveStatus()).positions;
 assert.equal(view.details.firstEntryPrice,first);
 assert.equal(view.details.averageEntryPrice,94.27);assert.equal(view.details.currentPrice,94.9);
 assert.deepEqual(view.details.unrealized,{usd:-10.47,source:'EXCHANGE',pct:-3.17});
 assert.deepEqual(view.details.margin,{usd:330.59,source:'EXCHANGE'});
 assert.deepEqual(view.details.realizedOpen,{usd:-1.82,source:'EXCHANGE'});
 assert.equal(view.details.quantity.base,p.size);
 const html=scalpPositionCardHTML(view);
 assert.match(html,/첫 진입가[\s\S]*평균 진입가[\s\S]*현재가<b>94\.90<\/b><small>거래소 표시가/);
 assert.match(html,/−\$10\.47 \(-3\.17%\)[\s\S]*증거금 대비[\s\S]*증거금<b>\$330\.59[\s\S]*실현 손익[\s\S]*−\$1\.82[\s\S]*추매<b>2차 \/ 한도 내 반복/);
});

test('a reversal skipped for price drift is checked again after 25 minutes if its levels still hold',async()=>{
 for(const invalidated of [false,true]){
  const v=venue(),clock={t:T0};
  let price=PX*.99;
  const ex=make(v,{clock,price:()=>price,config:{zoneSignals:false,stopKeepPct:0}});
  const initial=crash(),original=detectScalpReversal(initial,{symbol:'SOLUSDT',now:T0,settings:SCALP_EXEC_SETTINGS});
  assert.equal(original.ok,true);
  let rows=initial;
  const previous=ex.candles;ex.candles=(symbol,interval,n)=>interval==='5m'?Promise.resolve(rows):previous(symbol,interval,n);
  ex.arm();assert.equal((await ex.scan()).entered,0);
  assert.equal(ex.signals(1).at(-1).reason,'PRICE_DRIFT');
  rows=[...initial,...Array.from({length:5},(_,i)=>{
   const t=(BUCKET+i)*I,low=invalidated&&i===0?original.evidence.extreme-.01:ENTRY-.1;
   return [t,ENTRY,ENTRY+.15,low,ENTRY+.08,100,t+I-1,0];
  })];
  price=PX;clock.t=T0+25*60000;
  const retry=await ex.scan();assert.equal(retry.entered,invalidated?0:1);
  assert.equal(placed(v,'MARKET').length,invalidated?0:1);
  if(!invalidated){const signal=ex.signals(1).at(-1);assert.equal(signal.barAt,original.barAt);assert.ok(signal.recheckedAt>signal.barAt)}
 }
});

test('config: TESTNET or OFF only — LIVE is refused; settings as the user set them; costs = backtest costs',()=>{
 const c=scalpExecConfig({});assert.equal(c.mode,'TESTNET');assert.equal(c.refused,null);
 assert.equal(c.stopLossEnabled,false);
 assert.equal(c.settings.minMovePct,5);assert.equal(SCALP_EXEC_SETTINGS.minMovePct,SCALP_TIMEFRAMES['5m'].minMovePct*2);
 assert.deepEqual(c.settings.retracements,[.382,.5,.618]);assert.equal(c.settings.stopAtr,.25);assert.equal(c.settings.climaxVolume,3);
 assert.equal(c.maxHoldMs,2*3600000);assert.equal(c.riskPct,.5);assert.equal(c.maxOpen,0);assert.equal(scalpExecConfig({SCALP_MAX_OPEN:'5'}).maxOpen,5);assert.equal(c.dailyLossPct,3);assert.equal(c.trendMode,'on');assert.equal(scalpExecConfig({SCALP_EXEC_TREND_FILTER:'record'}).trendMode,'record');
 assert.equal(scalpExecConfig({SCALP_EXEC_TREND_FILTER:' On '}).trendMode,'on');assert.equal(scalpExecConfig({SCALP_EXEC_TREND_FILTER:'true'}).trendMode,'on');assert.equal(scalpExecConfig({SCALP_EXEC_TREND_FILTER:'off'}).trendMode,'off');
 for(const k of ['takerRate','slippageBps','fundingRate'])assert.equal(SCALP_EXEC_COSTS[k],BACKTEST_COSTS[k]);
 const live=scalpExecConfig({SCALP_EXEC_MODE:'LIVE'});assert.equal(live.mode,'OFF');assert.equal(live.refused,'LIVE_REFUSED');
 assert.equal(scalpExecConfig({SCALP_EXEC_MODE:'off'}).mode,'OFF');assert.equal(scalpExecConfig({SCALP_RISK_PCT:'50'}).riskPct,.5,'out-of-range values keep the default');
 const v=venue();
 assert.throws(()=>new ScalpExecutor({config:{...c,mode:'LIVE'},client:v.client}),/SCALP_TESTNET_ONLY/);
 assert.throws(()=>new ScalpExecutor({config:c,client:{...v.client,mode:'LIVE'}}),/SCALP_TESTNET_ONLY/);
 const ex=new ScalpExecutor({config:live,client:v.client});assert.throws(()=>ex.arm(),/LIVE_REFUSED/);assert.equal(ex.armed,false);
 assert.throws(()=>new ScalpExecutor({config:c}).arm(),/CREDENTIALS_MISSING/);
});

test('universe: BingX USDT perpetuals by quote volume, stock/fx NC* and untradable contracts left out',()=>{
 const contracts=new Map([['AUSDT',{tradable:true,venueSymbol:'A-USDT'}],['BUSDT',{tradable:true,venueSymbol:'B-USDT'}],['CUSDT',{tradable:false}],['NCFXEURUSDUSDT',{tradable:true}]]);
 const u=scalpUniverse([{symbol:'A-USDT',quoteVolume:'5'},{symbol:'B-USDT',quoteVolume:'9'},{symbol:'C-USDT',quoteVolume:'99'},{symbol:'NCFXEURUSD-USDT',quoteVolume:'999'},{symbol:'A-USDC',quoteVolume:'1'}],contracts,1);
 assert.deepEqual(u.map(x=>x.symbol),['BUSDT']);
});

test('detection on synthetic closed 5m candles -> plan: 38.2/50/61.8 % targets, stop below the low, risk-sized, 40/35/25 splits',()=>{
 const cfg=scalpExecConfig({SCALP_SCALE_IN:'off'}),rows=crash();
 const det=detectScalpReversal(rows,{symbol:'SOLUSDT',now:T0,interval:'5m',settings:cfg.settings});
 assert.equal(det.ok,true,JSON.stringify(det.reasons));assert.equal(det.direction,'LONG');assert.ok(det.evidence.movePct>=5);
 assert.equal(det.barAt,BUCKET*I,'entry at the next candle open');
 const {extreme,origin}=det.evidence,move=origin-extreme;
 assert.ok([.382,.5,.618].every((f,i)=>Math.abs(det.targets[i]-(extreme+f*move))<1e-9));
 assert.equal(detectScalpReversal(crash({move:4}),{now:T0,interval:'5m',settings:cfg.settings}).ok,false,'a 4 % drop is below the 5 % setting');
 const plan=planScalpOrder({det,price:det.entry+.02,contract:SOL,equity:10000,available:9000,leverage:10,config:cfg});
 assert.equal(plan.ok,true,JSON.stringify(plan));assert.ok(plan.stop<extreme&&plan.entry>plan.stop&&plan.targets[0]>plan.entry);
 assert.ok(Math.abs(plan.riskUSD-50)<.2,'0.5 % of 10,000 at the stop');assert.ok(plan.netRR>=1);
 assert.ok(Math.abs(plan.parts.reduce((a,b)=>a+b,0)-plan.qty)<1e-9);assert.equal(plan.parts[0],Number((Math.floor(plan.qty*100*.4)/100).toFixed(2)));
 assert.deepEqual(planScalpOrder({det,price:det.entry*.994,contract:SOL,equity:10000,leverage:10,config:{...cfg,stopLossEnabled:true}}).reasons,['PRICE_DRIFT'],'0.6 % toward the stop with stop-loss on: skipped');
 assert.equal(planScalpOrder({det,price:det.entry*.994,contract:SOL,equity:10000,leverage:10,config:cfg}).ok,true,'stop-loss off: better price above extreme is allowed');
 assert.deepEqual(planScalpOrder({det,price:det.entry,contract:SOL,equity:10000,leverage:10,config:{...cfg,stopLossEnabled:true,minNetRR:50}}).reasons,['TP1_NET_RR_BELOW_MINIMUM']);
 assert.equal(planScalpOrder({det,price:det.entry,contract:SOL,equity:10000,leverage:10,config:{...cfg,minNetRR:50}}).ok,true,'stop-loss off: virtual-stop minNetRR is skipped when TP1 clears costs');
 // Margin cap: 1 % of equity per position cuts the quantity (and the risk).
 const capped=planScalpOrder({det,price:det.entry,contract:SOL,equity:10000,leverage:10,config:{...cfg,maxMarginPct:1}});
 assert.equal(capped.capped,true);assert.ok(capped.marginUSD<=100+1e-9&&capped.riskUSD<50);
});

test('splits below the venue minimum merge into the earlier target; below the minimum altogether: none',()=>{
 assert.deepEqual(scalpSplits(1,'0.01',.01),{parts:[.4,.35,.25],targets:3,merged:false});
 assert.deepEqual(scalpSplits(1,'0.01',.3),{parts:[.4,.6,0],targets:2,merged:true});
 assert.deepEqual(scalpSplits(1,'0.01',.5),{parts:[1,0,0],targets:1,merged:true});
 assert.equal(scalpSplits(.2,'0.01',.5),null);
 assert.deepEqual(scalpSplits(7,'1',1),{parts:[2,2,3],targets:3,merged:false});
});

async function scaleExample({side='LONG',fillAdd=true,loseAddReply=false,lowFunds=false,noStop=false,disarm=false,delayRecovery=false}={}){
 const direction=side==='LONG'?1:-1,entry=direction>0?PX:PX_S,signal=direction>0?crash:rise;
 const clock={t:T0},v=venue({fillAt:entry,fillAdd,loseAddReply}),dir=delayRecovery?tmp():null;
 let price=entry,extra=[],reads=0;
 const inputs={clock,price:()=>price,trend:direction>0?up4h:down4h,rows:()=>[...signal(),...extra],dir,
  funds:()=>{reads++;return {equity:10000,available:lowFunds&&reads>1?1:9000}},config:{scaleIn:true}};
 const ex=make(v,inputs);ex.arm();assert.equal((await ex.scan()).entered,1);
 const p=ex.store.open[0],original=p.filled,stop=p.stop;
 const distance=direction*(p.avg-stop),level=f=>stop+direction*distance*f;
 const open=level(.53),close=level(.62),adverse=level(.45);
 const ref=(BUCKET+1)*I;
 extra=[[ref,open,Math.max(open,close,adverse),Math.min(open,close,adverse),close,100,ref+I-1]];
 price=level(.64);clock.t=ref+I+5000;v.mark=price;
 if(noStop){const place=v.client.placeOrder;v.client.placeOrder=(o,g)=>o.type==='STOP_MARKET'?Promise.reject(Error('refused')):place(o,g)}
 if(disarm)ex.disarm();
 let lookup=v.client.getOrder;
 if(delayRecovery)v.client.getOrder=(s,q)=>q.clientOrderId?Promise.resolve(null):lookup(s,q);
 await ex.reconcile();
 if(delayRecovery){
  assert.equal(p.scaleIn.state,'PENDING');
  v.client.getOrder=lookup;
  const restarted=make(v,inputs);
  await restarted.reconcile();
  const recovered=restarted.store.open[0];
  assert.equal(recovered.scaleIn.state,'FILLED');
  assert.ok(recovered.filled>original);
 }
 return {v,ex,p,clock,original,stop,reads};
}

test('scale-in uses equal entry margin after a closed retest on either side, resizes targets and never adds twice',async()=>{
 for(const side of ['LONG','SHORT']){
  const {v,ex,p,clock,original,stop,reads}=await scaleExample({side,loseAddReply:side==='SHORT'});
  assert.ok(reads>=2,'fresh account balance read for the add');
  assert.equal(p.scaleIn.state,'FILLED');
  assert.equal(p.stop,stop);
  assert.ok(p.filled>original&&p.scaleIn.riskAfterUSD<=50);
  assert.ok(Math.abs(p.scaleIn.initialMarginUSD-p.scaleIn.fillMarginUSD)<=p.scaleIn.fillPrice*Number(p.quantityStep)/p.leverage+1e-9);
  assert.equal(placed(v,'LIMIT')[0].timeInForce,'FOK');
  const stops=placed(v,'STOP_MARKET');assert.equal(stops.length,1);
  assert.equal(stops[0].closePosition,'true');
  const targets=[...v.orders.values()].filter(o=>o.type==='TAKE_PROFIT_MARKET'&&o.status==='NEW');
  assert.equal(targets.length,3);
  assert.ok(Math.abs(targets.reduce((n,o)=>n+Number(o.quantity),0)-p.filled)<1e-8);
  assert.ok(targets.every(o=>o.clientOrderId.startsWith(p.id+'u')));
  clock.t+=I;await ex.reconcile();assert.equal(placed(v,'LIMIT').length,1);
 }
});

test('unprotected testnet scalps use the current holding for each adverse add on both sides',async()=>{
 for(const direction of ['LONG','SHORT']){
  const sign=direction==='LONG'?1:-1,entry=sign===1?PX:PX_S,v=venue({fillAt:entry}),clock={t:T0};
  let price=entry;
  const ex=make(v,{clock,price:()=>price,trend:sign===1?up4h:down4h,rows:sign===1?crash:rise,config:{stopLossEnabled:false,scaleIn:true,riskPct:.15}});
  ex.arm();assert.equal((await ex.scan()).entered,1);
  const p=ex.store.open[0],a=p.scaleIn,first=p.size,dist=Math.abs(a.initialEntry-p.initialStop)*.5;
  assert.equal(placed(v,'MARKET')[0].stopLoss,undefined);
  const moves=async value=>{price=value;v.mark=value;await ex.reconcile()};
  clock.t+=I;await moves(a.anchor-sign*(dist+.03));
  assert.equal(a.count,1);assert.equal(a.state,'WATCH');
  const afterFirst=a.anchor,afterFirstSize=p.size;
  assert.equal(a.orders[0].qty,first);
  assert.equal(afterFirstSize,first*2);
  await moves(afterFirst-sign*(dist+.06));assert.equal(a.count,1,'at most one attempt in a candle');
  clock.t+=I;await moves(afterFirst-sign*(dist-.03));assert.equal(a.count,1,'a new adverse level must be reached');
  await moves(afterFirst-sign*(dist+.03));assert.equal(a.count,2);
  const adds=placed(v,'LIMIT');assert.equal(new Set(adds.map(o=>o.clientOrderId)).size,2);
  assert.equal(a.orders[1].qty,afterFirstSize);
  assert.equal(p.size,afterFirstSize*2);
  const active=[...v.orders.values()].filter(o=>o.type==='TAKE_PROFIT'&&o.status==='NEW');
  assert.ok(Math.abs(active.reduce((n,o)=>n+Number(o.quantity),0)-p.filled)<1e-8);
  assert.ok(active.every(o=>sign*(Number(o.price)-p.avg)>0),'the conditional exits also enforce a profitable limit');
  clock.t=p.deadline+I;await moves(a.anchor);assert.equal(ex.store.open.length,1,'adverse position survives expiry');
  const firstTarget=active.find(o=>o.stopPrice===active[0].stopPrice);v.fill(firstTarget);
  clock.t+=I;await moves(a.anchor-sign*(dist+.03));assert.equal(a.count,2,'reducing a position ends the add cycle');
  assert.equal(placed(v,'STOP_MARKET').length,0);assert.equal(placed(v,'MARKET').length,1);
  for(const target of active.filter(o=>o.status==='NEW'))v.fill(target);
  await ex.reconcile();await ex.reconcile();
  assert.equal(ex.store.closed[0].closeReason,'ALL_TARGETS');assert.equal(ex.stats().repeatedScaleIn.adds,2);
  assert.equal(ex.journal()[0].scaleIn.count,2);
 }
});

test('repeated testnet adds trim size to confirmed available funds and shared margin',async()=>{
 const {TestnetBudget}=await import('../testnet_budget.mjs');
 const v=venue(),clock={t:T0},budget=new TestnetBudget({dailyLossPct:15,marginCapPct:30,now:()=>clock.t});
 let price=PX,available=9000,otherMargin=0;
 const ex=make(v,{clock,budget,price:()=>price,funds:()=>({equity:10000,available}),config:{stopLossEnabled:false,scaleIn:true,riskPct:.15}});
 budget.register('signal',{usedMargin:()=>otherMargin}).register('scalp',ex.budgetSource());
 ex.arm();assert.equal((await ex.scan()).entered,1);
 const p=ex.store.open[0],a=p.scaleIn,first=p.size,dist=Math.abs(a.initialEntry-p.initialStop)*.5;
 const next=async()=>{clock.t+=I;price=a.anchor-dist-.03;v.mark=price;await ex.reconcile()};
 available=undefined;await next();
 assert.equal(a.lastReason,'NO_BALANCE');assert.equal(placed(v,'LIMIT').length,0);
 available=10;await next();
 assert.equal(a.count,1);
 assert.ok(a.orders[0].qty<first);
 assert.ok(a.orders[0].marginUSD<=9&&a.orders[0].marginUSD>8.9);
 available=9000;
 otherMargin=budget.snapshot(10000).marginCapUSD-ex.budgetSource().usedMargin()-5;
 await next();
 assert.equal(a.count,2);
 assert.ok(a.orders[1].marginUSD<=5&&a.orders[1].marginUSD>4.9);
 assert.ok(budget.snapshot(10000).marginUSD<=3000+1e-9);
});

test('switching an open scalp to profit-only retires its market stop and targets while preserving external orders',async()=>{
 const v=venue(),clock={t:T0},dir=tmp();
 try{
  const legacy=make(v,{clock,dir});legacy.arm();assert.equal((await legacy.scan()).entered,1);
  const owned=legacy.store.open[0].stopOrderId,manual=(await v.client.placeOrder({symbol:'SOL-USDT',side:'SELL',type:'STOP_MARKET',stopPrice:'80',clientOrderId:'manual'})).order;
  const legacyTargets=[...legacy.store.open[0].tpOrderIds];
  const externalTarget=(await v.client.placeOrder({symbol:'SOL-USDT',side:'SELL',type:'TAKE_PROFIT_MARKET',stopPrice:'110',clientOrderId:'manual-target'})).order;
  const migrated=make(v,{clock,dir,config:{stopLossEnabled:false,scaleIn:true}}),cancel=v.client.cancelOrder;
  v.client.cancelOrder=async()=>{};
  await migrated.reconcile();assert.equal(migrated.store.open[0].stopRetirementError,'SCALP_STOP_CANCEL_PENDING');
  v.client.cancelOrder=cancel;
  await migrated.reconcile();assert.equal(v.orders.get(owned).status,'CANCELED');assert.equal(manual.status,'NEW');
  assert.equal(migrated.store.open[0].stopOrderId,null);assert.equal(migrated.store.open[0].scaleIn.version,2);
  assert.ok(legacyTargets.every(id=>v.orders.get(id).status==='CANCELED'));
  assert.equal(externalTarget.status,'NEW');assert.ok(migrated.store.open[0].profitTargetsReady);
 }finally{fs.rmSync(dir,{recursive:true,force:true})}
});

test('repeated scalp adds wait for a new balance and resume a lost response without adding twice',async()=>{
 const v=venue({loseAddReply:true}),clock={t:T0},dir=tmp();let price=PX,available=9000;
 const inputs={clock,dir,price:()=>price,funds:()=>({equity:10000,available}),config:{stopLossEnabled:false,scaleIn:true}};
 try{
  const ex=make(v,inputs);ex.arm();assert.equal((await ex.scan()).entered,1);
  const p=ex.store.open[0],lookup=v.client.getOrder;
  clock.t+=I;price=p.initialStop-.1;v.mark=price;available=.1;
  await ex.reconcile();assert.equal(placed(v,'LIMIT').length,0);assert.equal(p.scaleIn.lastReason,'RISK_OR_MARGIN_CAP');
  clock.t+=I;available=9000;v.client.getOrder=(s,q)=>q.clientOrderId?Promise.resolve(null):lookup(s,q);
  await ex.reconcile();assert.equal(p.scaleIn.state,'PENDING');assert.equal(placed(v,'LIMIT').length,1);
  v.client.getOrder=lookup;
  const restarted=make(v,inputs);await restarted.reconcile();await restarted.reconcile();
  assert.equal(restarted.store.open[0].scaleIn.count,1);assert.equal(placed(v,'LIMIT').length,1);
  assert.equal(placed(v,'MARKET').length,1);
 }finally{fs.rmSync(dir,{recursive:true,force:true})}
});

test('scale-in skips on low free funds or missing whole stop, does not retry a canceled add, and recovers across restarts',async()=>{
 for(const options of [{lowFunds:true},{noStop:true},{disarm:true},{fillAdd:false}]){
  const {v,p,original}=await scaleExample(options);
  assert.equal(p.filled,original);
  assert.equal(placed(v,'LIMIT').length,options.fillAdd===false?1:0);
  if(options.noStop)assert.ok([...v.orders.values()].some(o=>o.type==='STOP_MARKET'&&o.status==='NEW'));
 }
 const {v}=await scaleExample({loseAddReply:true,delayRecovery:true});
 assert.equal(placed(v,'LIMIT').length,1);
});

test('scan after the 5m close: market entry with the stop attached, stop confirmed, reduce-only targets, once per candle',async()=>{
 const v=venue(),clock={t:T0},ex=make(v,{clock});
 assert.equal((await ex.scan()).error,'NOT_ARMED');assert.equal(v.calls.length,0,'nothing is sent while disarmed');
 ex.arm();ex.lastScanBucket=null;
 const st=await ex.scan();assert.equal(st.entered,1,JSON.stringify({st,skips:ex.store.skips}));
 const entry=placed(v,'MARKET')[0];assert.equal(entry.side,'BUY');assert.equal(entry.positionSide,'BOTH');assert.equal(entry.symbol,'SOL-USDT');
 assert.equal(entry.clientOrderId,scalpClientId('SOLUSDT',BUCKET*I));assert.ok(JSON.parse(entry.stopLoss).stopPrice>0);
 const p=ex.store.open[0];assert.equal(p.strategy,'SCALP_REVERSAL');assert.equal(p.strategyProfile,'SCALP_REVERSAL');assert.equal(p.mode,'TESTNET');
 assert.ok(p.stopOrderId,'attached stop found');assert.equal(placed(v,'STOP_MARKET').length,0,'no second stop');
 const tps=placed(v,'TAKE_PROFIT_MARKET');assert.equal(tps.length,3);assert.ok(tps.every(o=>o.reduceOnly==='true'&&o.side==='SELL'));
 assert.equal(+tps.reduce((a,o)=>a+Number(o.quantity),0).toFixed(8),Number(entry.quantity));
 assert.deepEqual(tps.map(o=>Number(o.stopPrice)),p.targets);
 assert.equal(v.calls.filter(c=>c.op==='lev')[0].l,10,'leverage min(10, venue max)');
 assert.ok(ex.heldSymbols().has('SOLUSDT')&&ex.heldSymbols().has('SOL-USDT'));
 const n=v.calls.length;ex.lastScanBucket=null;await ex.scan();assert.equal(v.calls.length,n,'the same candle is never sent twice');
 assert.match(scalpEventText(ex.store.events.find(e=>e.type==='OPENED')),/^🟢 \[되돌림 단타·테스트넷\] SOLUSDT 롱 10배 진입/);
});

test('below-minimum target splits are merged before the orders go out',async()=>{
 const v=venue(),ex=make(v,{contract:{...SOL,minQuantityBase:'20'}});ex.arm();
 await ex.scan();const tps=placed(v,'TAKE_PROFIT_MARKET');
 assert.equal(tps.length,2,JSON.stringify(ex.store.skips));assert.ok(tps.every(o=>Number(o.quantity)>=20));
 assert.equal(ex.store.open[0].merged,true);
});

test('skips: price drift, position mode unreadable, symbol held elsewhere, against the 4H trend, kill switch, venue position',async()=>{
 const cases=[[{price:PX*.99},'PRICE_DRIFT'],[{modeFail:true},'BINGX_POSITION_MODE_UNKNOWN'],[{isBusy:()=>true},'SYMBOL_HELD_BY_OTHER_STRATEGY'],[{trend:down4h,config:{trendMode:'on'}},'AGAINST_4H_TREND']];
 for(const [opt,reason] of cases){
  const v=venue({modeFail:opt.modeFail}),ex=make(v,opt);ex.arm();await ex.scan();
  assert.equal(ex.store.open.length,0,reason);assert.equal(placed(v,'MARKET').length,0,reason);assert.equal(ex.store.skips.at(-1)?.reason,reason);assert.ok(scalpReasonKo(reason)!==reason);
 }
 const v=venue();v.size=1;const ex=make(v);ex.arm();await ex.scan();assert.equal(ex.store.skips.at(-1).reason,'VENUE_POSITION_EXISTS');assert.equal(placed(v,'MARKET').length,0);
 let kill=false;const k=venue(),kx=make(k,{gate:()=>kill?{ok:false,reason:'KILL_SWITCH'}:{ok:true}});
 kx.arm();kill=true;assert.equal((await kx.scan()).error,'KILL_SWITCH');assert.equal(k.calls.length,0);
 kx.disarm();assert.throws(()=>kx.arm(),/KILL_SWITCH_ON/);
});

test('no protective stop: closed at market and scalps disarmed',async()=>{
 const v=venue({failStop:true}),ex=make(v);ex.arm();
 // The attached stop is missing on the venue: the executor places one, which fails.
 const place=v.client.placeOrder;v.client.placeOrder=async p=>{const r=await place({...p,stopLoss:undefined});return r};
 await ex.scan();assert.equal(ex.armed,false);assert.equal(v.size,0);assert.equal(ex.store.closed[0].closeReason,'NO_STOP');
});

test('reconcile: TP1 -> stop to the entry (new stop first, old cancelled); flat after the break-even stop -> booked with its result',async()=>{
 const v=venue(),clock={t:T0},ex=make(v,{clock});ex.arm();await ex.scan();
 const p=ex.store.open[0],oldStop=p.stopOrderId;
 v.mark=p.targets[0]+.01;v.fill(v.orders.get(p.tpOrderIds[0]),p.targets[0]);clock.t+=60000;
 await ex.reconcile();
 assert.equal(p.breakevenMoved,true);assert.ok(p.stop>=p.avg);
 const be=placed(v,'STOP_MARKET').at(-1);assert.equal(be.closePosition,'true');assert.equal(Number(be.stopPrice),p.stop);
 assert.ok(v.calls.some(c=>c.op==='cancel'&&c.oid===oldStop),'old stop cancelled after the new one');
 v.fill(v.orders.get(p.stopOrderId),p.stop);clock.t+=60000;
 await ex.reconcile();assert.equal(ex.store.open.length,1,'one empty read is not enough');clock.t+=20000;await ex.reconcile();
 assert.equal(ex.store.open.length,0);const x=ex.store.closed[0];
 assert.equal(x.closeReason,'BREAKEVEN_STOP');assert.equal(x.tpHits,1);assert.ok(Number.isFinite(x.netUSD)&&x.netUSD>0,'TP1 profit minus fees');
 assert.ok(v.calls.some(c=>c.op==='cancel'&&c.oid===p.tpOrderIds[1]),'leftover targets cancelled');
 assert.equal(ex.stats().trades,1);assert.equal(ex.stats().winRatePct,100);
 assert.match(scalpEventText(ex.store.events.find(e=>e.type==='CLOSED')),/청산 · 1차 목표 뒤 본전 손절/);
});

test('reconcile: time exit at entry + 2 h with a reduce-only market close',async()=>{
 const v=venue(),clock={t:T0},ex=make(v,{clock});ex.arm();await ex.scan();
 clock.t=BUCKET*I+2*3600000;v.mark=ENTRY+.3;await ex.reconcile();
 const close=placed(v,'MARKET').at(-1);assert.equal(close.reduceOnly,'true');assert.equal(close.side,'SELL');
 assert.equal(ex.store.open.length,0);assert.equal(ex.store.closed[0].closeReason,'TIME_STOP');
});

test('daily loss limit (3 % of equity, closed today + open) disarms the scalps for the day',async()=>{
 const v=venue(),clock={t:T0},funds={equity:1000,available:900},ex=make(v,{clock,funds});
 ex.arm();await ex.scan();assert.equal(ex.store.open.length,1);
 v.mark=v.avg-35/ex.store.open[0].size;clock.t+=30000;await ex.reconcile();
 assert.equal(ex.armed,false);assert.equal(ex.store.dailyStop.day,'2026-11-16');assert.throws(()=>ex.arm(),/DAILY_LOSS_LIMIT/);
 assert.match(scalpEventText(ex.store.events.find(e=>e.type==='DAILY_LOSS_LIMIT')),/하루 손실 한도/);
 clock.t+=24*3600000;assert.equal(ex.arm().armed,true,'a new day may be armed again');
});

test('restart: the ledger comes back, scalps start disarmed, an unfinished entry is read from the venue',async()=>{
 const dir=tmp(),v=venue(),ex=make(v,{dir});ex.arm();await ex.scan();assert.equal(ex.store.open.length,1);
 const again=make(v,{dir});assert.equal(again.armed,false);assert.equal(again.store.open.length,1);assert.equal(again.store.open[0].id,ex.store.open[0].id);
 assert.ok(fs.existsSync(path.join(dir,'scalp-store.json')));assert.equal(JSON.parse(fs.readFileSync(path.join(dir,'scalp-store.json'),'utf8')).strategy,'SCALP_REVERSAL');
 // A SUBMITTING record (cut off by the restart) is UNKNOWN until the venue answers; new entries wait.
 const s=JSON.parse(fs.readFileSync(path.join(dir,'scalp-store.json'),'utf8'));s.open[0].status='SUBMITTING';s.open[0].stopIds=[];s.open[0].stopOrderId=null;fs.writeFileSync(path.join(dir,'scalp-store.json'),JSON.stringify(s));
 const third=make(v,{dir});assert.equal(third.store.open[0].status,'UNKNOWN');third.arm();assert.equal(third.status().blocked,'UNRESOLVED_ORDER_STATE');
 await third.reconcile();assert.equal(third.store.open[0].status,'OPEN');assert.equal(third.status().blocked,null);
 fs.rmSync(dir,{recursive:true,force:true});
});

test('testnet page: the scalp details (collapsed "단타 신호·건너뜀") — rules, state, skip reasons in Korean, no own switch',async()=>{
 const v=venue(),ex=make(v);let h=scalpDetailsHTML(ex.status());assert.match(h,/4시간 추세 반대 제외/);
 assert.doesNotMatch(h,/상태 (꺼짐|켜짐)/,'on / off is the testnet switch\'s (user 2026-11-18: one place per fact)');assert.doesNotMatch(h,/data-scalp-arm|data-scalp-disarm/,'one testnet switch: the scalp has no button of its own');
 ex.arm();await ex.scan();ex.store.skips.push({at:T0,symbol:'XUSDT',reason:'PRICE_DRIFT'});ex.store.skipCounts.PRICE_DRIFT=1;
 h=scalpDetailsHTML(ex.status());assert.doesNotMatch(h,/상태 켜짐/);assert.match(h,/XUSDT/);
 assert.match(h,/진입가에서 가격이 이미 벗어남 1회/);assert.match(h,/api\/scalp\/journal/);
 const off=new ScalpExecutor({config:scalpExecConfig({SCALP_EXEC_MODE:'LIVE'})});assert.match(scalpDetailsHTML(off.status()),/실계좌 모드는 거부됨/);
});

// ---- SHORT side (user 2026-11-16 16:58 "숏도 넣어줘"): the mirror image of every LONG step ----
test('sides: SCALP_EXEC_SIDES (default both), one-way position sign',()=>{
 assert.deepEqual(scalpExecConfig({}).sides,['LONG','SHORT']);assert.deepEqual(scalpSides('long'),['LONG']);assert.deepEqual(scalpSides('SHORT'),['SHORT']);
 assert.deepEqual(scalpSides('LONG,SHORT'),['LONG','SHORT']);assert.deepEqual(scalpSides('none'),[],'nothing valid: no side traded');
 assert.equal(signedAmount({positionAmt:'-2'}),-2);assert.equal(signedAmount({positionAmt:'2',positionSide:'SHORT'}),-2);assert.equal(signedAmount({positionAmt:'2',positionSide:'BOTH'}),2);
 assert.notEqual(scalpClientId('SOLUSDT',1,'SHORT'),scalpClientId('SOLUSDT',1,'LONG'));assert.equal(scalpClientId('SOLUSDT',1),scalpClientId('SOLUSDT',1,'LONG'),'LONG ids unchanged');
});

test('SHORT detection -> plan: stop above the high (rounded up), 38.2/50/61.8 % targets below the entry, same risk',()=>{
 const cfg=scalpExecConfig({SCALP_SCALE_IN:'off'}),det=detectScalpReversal(rise(),{symbol:'SOLUSDT',now:T0,interval:'5m',settings:cfg.settings});
 assert.equal(det.ok,true,JSON.stringify(det.reasons));assert.equal(det.direction,'SHORT');
 const {extreme,origin}=det.evidence,move=extreme-origin;
 assert.ok([.382,.5,.618].every((f,i)=>Math.abs(det.targets[i]-(extreme-f*move))<1e-9));
 const plan=planScalpOrder({det,price:PX_S,contract:{...SOL,tickSize:'0.1'},equity:10000,leverage:10,config:cfg});
 assert.equal(plan.ok,true,JSON.stringify(plan));assert.ok(plan.stop>extreme&&plan.stop>=det.stop&&plan.entry<plan.stop);
 assert.ok(Math.abs(plan.stop*10-Math.round(plan.stop*10))<1e-9,'stop on the tick grid');
 assert.ok(plan.targets.every((t,i)=>t<plan.entry&&(i===0||t<plan.targets[i-1])&&t>=det.targets[i]-1e-9),'targets rounded up, toward the entry');
 assert.ok(Math.abs(plan.riskUSD-50)<.6);assert.ok(plan.netRR>=1);
 assert.deepEqual(planScalpOrder({det,price:PX_S*1.01,contract:SOL,equity:10000,leverage:10,config:{...cfg,stopKeepPct:0}}).reasons,['PRICE_DRIFT']);
 assert.deepEqual(planScalpOrder({det:{...det,stop:det.entry-.05},price:det.entry,contract:SOL,equity:10000,leverage:10,config:cfg}).reasons,['ENTRY_AT_OR_BEYOND_STOP'],'a short stop below the entry');
});

test('SHORT entry: SELL market with a stop above, stop confirmed, BUY reduce-only targets, its own client id',async()=>{
 const {v,ex}=short();ex.arm();const st=await ex.scan();assert.equal(st.entered,1,JSON.stringify(ex.store.skips));
 const entry=placed(v,'MARKET')[0];assert.equal(entry.side,'SELL');assert.equal(entry.positionSide,'BOTH');
 assert.equal(entry.clientOrderId,scalpClientId('SOLUSDT',BUCKET*I,'SHORT'));
 const p=ex.store.open[0];assert.equal(p.direction,'SHORT');assert.ok(JSON.parse(entry.stopLoss).stopPrice===p.stop&&p.stop>PX_S);
 assert.equal(v.amt,-Number(entry.quantity),'one-way short = negative positionAmt');assert.equal(p.size,Number(entry.quantity));
 assert.ok(p.stopOrderId);assert.equal(placed(v,'STOP_MARKET').length,0);
 const tps=placed(v,'TAKE_PROFIT_MARKET');assert.equal(tps.length,3);assert.ok(tps.every(o=>o.side==='BUY'&&o.reduceOnly==='true'));
 assert.deepEqual(tps.map(o=>Number(o.stopPrice)),p.targets);assert.ok(p.targets.every(t=>t<p.avg));
 assert.match(scalpEventText(ex.store.events.find(e=>e.type==='OPENED')),/SOLUSDT 숏 10배 진입[\s\S]*급등/);
 // Mark below the entry = profit for a short, on the screen too.
 await ex.reconcile();v.mark=p.avg-1;await ex.reconcile();assert.ok(ex.store.open[0].unrealized>0);
});

test('SHORT: TP1 -> break-even BUY stop at the entry (rounded down), then the stop -> booked with a positive result',async()=>{
 const {v,clock,ex}=short();ex.arm();await ex.scan();
 const p=ex.store.open[0],oldStop=p.stopOrderId;
 v.mark=p.targets[0]-.01;v.fill(v.orders.get(p.tpOrderIds[0]),p.targets[0]);clock.t+=60000;await ex.reconcile();
 assert.equal(p.breakevenMoved,true);assert.ok(p.stop<=p.avg&&p.stop>p.avg-.011);
 const be=placed(v,'STOP_MARKET').at(-1);assert.equal(be.side,'BUY');assert.equal(be.closePosition,'true');assert.equal(Number(be.stopPrice),p.stop);
 assert.ok(v.calls.some(c=>c.op==='cancel'&&c.oid===oldStop));
 v.fill(v.orders.get(p.stopOrderId),p.stop);clock.t+=60000;await ex.reconcile();clock.t+=20000;await ex.reconcile();
 const x=ex.store.closed[0];assert.equal(x.closeReason,'BREAKEVEN_STOP');assert.equal(x.direction,'SHORT');assert.ok(x.netUSD>0,'TP1 below the entry is a short profit');
 assert.match(scalpEventText(ex.store.events.find(e=>e.type==='CLOSED')),/SOLUSDT 숏 청산 · 1차 목표 뒤 본전 손절/);
});

test('SHORT: price already back above the entry at TP1 -> closed at market (BUY reduce-only)',async()=>{
 const {v,clock,ex}=short();ex.arm();await ex.scan();const p=ex.store.open[0];
 v.fill(v.orders.get(p.tpOrderIds[0]),p.targets[0]);v.mark=p.avg+.05;clock.t+=60000;await ex.reconcile();
 const close=placed(v,'MARKET').at(-1);assert.equal(close.side,'BUY');assert.equal(close.reduceOnly,'true');
 assert.equal(v.amt,0);assert.equal(ex.store.closed[0].closeReason,'BREAKEVEN_STOP');
});

test('SHORT: stop-out is a loss, time exit is a BUY reduce-only close; PnL sign follows the side',async()=>{
 {const {v,clock,ex}=short();ex.arm();await ex.scan();const p=ex.store.open[0];
  v.mark=p.stop;v.fill(v.orders.get(p.stopOrderId),p.stop);clock.t+=60000;await ex.reconcile();clock.t+=20000;await ex.reconcile();
  const x=ex.store.closed[0];assert.equal(x.closeReason,'STOP');assert.ok(x.netUSD<0&&x.netUSD>-60,`about -0.5 % of the equity: ${x.netUSD}`)}
 {const {v,clock,ex}=short();ex.arm();await ex.scan();
  clock.t=BUCKET*I+2*3600000;v.mark=ENTRY_S-.3;await ex.reconcile();
  const close=placed(v,'MARKET').at(-1);assert.equal(close.side,'BUY');assert.equal(close.reduceOnly,'true');
  const x=ex.store.closed[0];assert.equal(x.closeReason,'TIME_STOP');assert.ok(x.netUSD>0,'price fell: short profit')}
});

test('side switch and trend: a side turned off or against the 4H trend is skipped; an opposite venue position blocks the entry',async()=>{
 {const {v,ex}=short({config:{sides:['LONG']}});ex.arm();await ex.scan();assert.equal(ex.store.skips.at(-1).reason,'SIDE_OFF');assert.equal(v.calls.length,0)}
 {const v=venue(),ex=make(v,{config:{sides:['SHORT']}});ex.arm();await ex.scan();assert.equal(ex.store.skips.at(-1).reason,'SIDE_OFF');assert.equal(v.calls.length,0)}
 {const {v,ex}=short({trend:up4h,config:{trendMode:'on'}});ex.arm();await ex.scan();assert.equal(ex.store.skips.at(-1).reason,'AGAINST_4H_TREND');assert.equal(placed(v,'MARKET').length,0)}
 {const {v,ex}=short({trend:up4h,config:{trendMode:'record'}});ex.arm();await ex.scan();assert.equal(placed(v,'MARKET').length,1,'record mode enters against the 4H trend');assert.equal(ex.store.open[0].withTrend,false);assert.ok(ex.store.open[0].trend4h)}
 {const v=venue();v.size=-1;const ex=make(v);ex.arm();await ex.scan();assert.equal(ex.store.skips.at(-1).reason,'VENUE_POSITION_EXISTS');assert.equal(placed(v,'MARKET').length,0)}
 assert.notEqual(scalpReasonKo('SIDE_OFF'),'SIDE_OFF');
});

test('SHORT daily loss (price up) disarms; stats and the page split 롱 / 숏',async()=>{
 const {v,clock,ex}=short({funds:{equity:1000,available:900}});ex.arm();await ex.scan();
 v.mark=v.avg+35/ex.store.open[0].size;clock.t+=30000;await ex.reconcile();assert.equal(ex.armed,false);assert.equal(ex.store.dailyStop.day,'2026-11-16');
 ex.store.closed.push({symbol:'AUSDT',direction:'LONG',netUSD:3,closedAt:clock.t},{symbol:'BUSDT',direction:'SHORT',netUSD:-1,closedAt:clock.t},{symbol:'CUSDT',direction:'SHORT',netUSD:2,closedAt:clock.t});
 const st=ex.stats();assert.equal(st.trades,3);assert.equal(st.bySide.LONG.trades,1);assert.equal(st.bySide.SHORT.trades,2);
 assert.equal(st.bySide.SHORT.winRatePct,50);assert.equal(st.bySide.SHORT.profitFactor,2);assert.equal(st.bySide.SHORT.netUSD,1);
 const h=scalpDetailsHTML(ex.status());assert.match(h,/숏 손익/);assert.match(h,/거래 방향 롱·숏/);
});

test('scalp watchlist: AKE and EVAA always scanned, more from SCALP_WATCHLIST (user 2026-11-16)',()=>{
 assert.deepEqual(scalpExecConfig({}).watchlist,['AKEUSDT','EVAAUSDT']);
 assert.deepEqual(scalpExecConfig({SCALP_WATCHLIST:'jctusdt, EVAAUSDT,bad'}).watchlist,['AKEUSDT','EVAAUSDT','JCTUSDT']);
});

test('no count cap on testnet, but today\'s loss + open stop risk + the new trade stays within the daily loss limit',async()=>{
 const v=venue(),ex=make(v);assert.equal(ex.config.maxOpen,0);
 ex.store.open.push({symbol:'XUSDT',venueSymbol:'X-USDT',direction:'LONG',entry:100,avg:100,stop:90,qty:29,size:29,leverage:10,status:'OPEN'});
 ex.arm();await ex.scan();assert.equal(ex.store.skips.at(-1)?.reason,'OPEN_RISK_LIMIT');assert.equal(placed(v,'MARKET').length,0);assert.notEqual(scalpReasonKo('OPEN_RISK_LIMIT'),'OPEN_RISK_LIMIT');
 const v2=venue(),ex2=make(v2);ex2.store.open.push({symbol:'XUSDT',venueSymbol:'X-USDT',direction:'LONG',entry:100,avg:100,stop:100,qty:29,size:29,leverage:10,status:'OPEN'});
 ex2.arm();await ex2.scan();assert.equal(placed(v2,'MARKET').length,1,'a stop at breakeven adds no risk');
});

test('drift allowance grows with the move (user 2026-11-17): 50 % of the move away from the stop, never under 0.4 %',()=>{
 const cfg={...scalpExecConfig({}),driftMovePct:5},det=detectScalpReversal(crash(),{symbol:'SOLUSDT',now:T0,interval:'5m',settings:cfg.settings});
 const big={...det,atr:det.atr/100,evidence:{...det.evidence,movePct:20}}; // a 20 % move: up to 1 %, the ATR cap no longer binds
 assert.notDeepEqual(planScalpOrder({det:big,price:det.entry*1.007,contract:SOL,equity:10000,leverage:10,config:cfg}).reasons?.[0],'PRICE_DRIFT');
 const far=planScalpOrder({det:big,price:det.entry*1.012,contract:SOL,equity:10000,leverage:10,config:cfg});assert.equal(far.reasons[0],'PRICE_DRIFT');assert.equal(far.allowedPct,1);
 assert.equal(planScalpOrder({det,price:det.entry*1.006,contract:SOL,equity:10000,leverage:10,config:{...cfg,driftMovePct:0}}).reasons[0],'PRICE_DRIFT');
 assert.equal(scalpExecConfig({SCALP_DRIFT_MOVE_PCT:'0'}).driftMovePct,0);assert.equal(scalpExecConfig({}).driftMovePct,50);assert.equal(scalpExecConfig({}).minNetRR,1);
 // Default 50 %: a 2 % drift after a 20 % move is left to the RR check, not skipped as PRICE_DRIFT.
 assert.notEqual(planScalpOrder({det:big,price:det.entry*1.02,contract:SOL,equity:10000,leverage:10,config:scalpExecConfig({})}).reasons?.[0],'PRICE_DRIFT');
 const toward=planScalpOrder({det:big,price:det.entry*.993,contract:SOL,equity:10000,leverage:10,config:{...cfg,stopKeepPct:0}});assert.equal(toward.reasons[0],'PRICE_DRIFT','toward the stop: base 0.4 % only');assert.equal(toward.allowedPct,.4);
});

test('scan order: coins that moved most over the last scans are read first; volume order without tickers',async()=>{
 const syms=['AAAUSDT','BBBUSDT','CCCUSDT'],contracts=new Map(syms.map(s=>[s,{...SOL,symbol:s,venueSymbol:s.replace('USDT','-USDT')}]));
 let px={'AAA-USDT':1,'BBB-USDT':1,'CCC-USDT':1};const clock={t:T0},read=[];
 const ex=new ScalpExecutor({config:scalpExecConfig({}),client:venue().client,contracts:async()=>contracts,
  tickers:async()=>syms.map((s,i)=>({symbol:s.replace('USDT','-USDT'),quoteVolume:String(3e7-i*1e6),lastPrice:'1'})),
  tickersFresh:async()=>Object.entries(px).map(([symbol,p])=>({symbol,lastPrice:String(p)})),
  candles:async s=>{read.push(s);return []},balance:async()=>({equity:1e4,available:9e3}),now:()=>clock.t});
 ex.arm();await ex.scan();assert.deepEqual(read,syms,'no history yet: volume order');
 read.length=0;px={'AAA-USDT':1,'BBB-USDT':1.01,'CCC-USDT':1.08};clock.t+=I;await ex.scan();
 assert.deepEqual(read,['CCCUSDT','BBBUSDT','AAAUSDT']);assert.deepEqual(ex.lastScan.firstSymbols.slice(0,3),['CCCUSDT','BBBUSDT','AAAUSDT']);
 read.length=0;ex.tickersFresh=async()=>[null,{symbol:'CCC-USDT'}];ex.prefetch=null;clock.t+=I;await ex.scan();assert.equal(read.length,3,'bad rows do not stop the scan');
 read.length=0;ex.tickersFresh=async()=>{throw Error('down')};ex.prefetch=null;clock.t+=I;await ex.scan();assert.deepEqual(read,syms,'ticker failure: volume order');
});

// ---- Hedge (dual-side) mode (user 2026-11-17 "hedge mode로 해보고 싶은데"): BingX fake with one row per side ----
// Positions are LONG / SHORT rows with positive amounts; an order is refused when it carries reduceOnly or
// positionSide BOTH (as BingX does in hedge mode). manual: a position on the other side opened by hand.
function hedgeVenue({fillAt=PX,manual=null,income=null}={}){
 const calls=[],orders=new Map(),pos={LONG:{amt:0,avg:0},SHORT:{amt:0,avg:0}};let mark=0,id=1;
 if(manual)pos[manual.side]={amt:manual.amt,avg:manual.avg??100};
 const add=(p,extra={})=>{const o={orderId:String(id++),...p,status:'NEW',...extra};orders.set(o.orderId,o);return o};
 const opening=p=>(p.positionSide==='LONG')===(p.side==='BUY');
 const client={mode:'TESTNET',
  positionMode:async()=>({dualSidePosition:'true'}),marginType:async()=>({marginType:'CROSSED'}),setMarginType:async()=>({}),
  leverage:async()=>({maxLongLeverage:20,maxShortLeverage:20}),setLeverage:async(s,side,l)=>{calls.push({op:'lev',side,l});return {leverage:l}},
  positions:async()=>Object.entries(pos).filter(([,x])=>x.amt>0).map(([side,x])=>({symbol:'SOL-USDT',positionSide:side,positionAmt:String(x.amt),avgPrice:String(x.avg),markPrice:String(mark||x.avg),unrealizedProfit:'0'})),
  openOrders:async()=>({orders:[...orders.values()].filter(o=>o.status==='NEW')}),
  getOrder:async(s,{orderId,clientOrderId})=>({order:[...orders.values()].find(o=>orderId?o.orderId===orderId:o.clientOrderId===clientOrderId)??null}),
  cancelOrder:async(s,oid)=>{calls.push({op:'cancel',oid});const o=orders.get(oid);if(o&&o.status==='NEW')o.status='CANCELED';return {}},
  ...(income?{income:async q=>{calls.push({op:'income'});return income(q)}}:{}),
  placeOrder:async p=>{calls.push({op:'order',...p});
   if('reduceOnly' in p)throw Object.assign(Error('reduceOnly not allowed in hedge mode'),{code:'VENUE_ERROR_109400'});
   if(!['LONG','SHORT'].includes(p.positionSide))throw Object.assign(Error('PositionSide must be LONG or SHORT in hedge mode'),{code:'VENUE_ERROR_109400'});
   if(p.type==='MARKET'){const q=Number(p.quantity),x=pos[p.positionSide];
    if(!opening(p)){x.amt=+Math.max(0,x.amt-q).toFixed(8);return {order:add(p,{status:'FILLED',executedQty:String(q),avgPrice:String(mark||x.avg)})}}
    x.avg=mark||fillAt;x.amt=+(x.amt+q).toFixed(8);const o=add(p,{status:'FILLED',executedQty:String(q),avgPrice:String(x.avg)});
    if(p.stopLoss){const sl=JSON.parse(p.stopLoss);add({symbol:p.symbol,type:'STOP_MARKET',positionSide:p.positionSide,stopPrice:String(sl.stopPrice),side:p.side==='SELL'?'BUY':'SELL'})}
    return {order:o}}
   return {order:add(p)}}};
 return {client,calls,orders,pos,set mark(v){mark=v},
  fill(o,price){o.status='FILLED';const x=pos[o.positionSide];o.executedQty=o.quantity??String(x.amt);o.avgPrice=String(price??o.stopPrice);x.amt=+Math.max(0,x.amt-Number(o.executedQty)).toFixed(8)}};
}

test('hedge mode: LONG entry, stop, targets and closes carry positionSide LONG and no reduceOnly; an opposite manual SHORT does not block',async()=>{
 const v=hedgeVenue({manual:{side:'SHORT',amt:3,avg:110}}),clock={t:T0},ex=make(v,{clock});ex.arm();
 const st=await ex.scan();assert.equal(st.entered,1,JSON.stringify(ex.store.skips));
 const p=ex.store.open[0];assert.equal(p.hedge,true,'the mode is kept on the position');
 const entry=placed(v,'MARKET')[0];assert.deepEqual([entry.side,entry.positionSide],['BUY','LONG']);assert.ok(!('reduceOnly' in entry));
 assert.deepEqual(v.calls.find(c=>c.op==='lev'),{op:'lev',side:'LONG',l:10},'leverage set for the LONG side');
 assert.equal(p.size,Number(entry.quantity),'size read from the LONG row, not netted with the SHORT row');
 const tps=placed(v,'TAKE_PROFIT_MARKET');assert.equal(tps.length,3);assert.ok(tps.every(o=>o.side==='SELL'&&o.positionSide==='LONG'&&!('reduceOnly' in o)));
 // Both rows on the venue: the reconcile keeps the LONG position and never touches the SHORT one.
 clock.t+=30000;await ex.reconcile();assert.equal(ex.store.open.length,1);assert.equal(ex.store.open[0].size,Number(entry.quantity));
 // TP1 -> breakeven stop with closePosition on the LONG side.
 v.mark=p.targets[0]+.01;v.fill(v.orders.get(p.tpOrderIds[0]),p.targets[0]);clock.t+=30000;await ex.reconcile();
 const be=placed(v,'STOP_MARKET').at(-1);assert.equal(p.breakevenMoved,true);assert.deepEqual([be.side,be.positionSide,be.closePosition],['SELL','LONG','true']);assert.ok(!('reduceOnly' in be));
 // Time exit: market close SELL + LONG without reduceOnly; the manual SHORT stays.
 clock.t=BUCKET*I+2*3600000;v.mark=ENTRY+.3;await ex.reconcile();
 const close=placed(v,'MARKET').at(-1);assert.deepEqual([close.side,close.positionSide],['SELL','LONG']);assert.ok(!('reduceOnly' in close));
 assert.equal(ex.store.open.length,0);assert.equal(ex.store.closed[0].closeReason,'TIME_STOP');assert.equal(v.pos.SHORT.amt,3,'the other side is never closed by us');
 assert.ok(!ex.store.skips.some(x=>x.reason==='BINGX_HEDGE_MODE'));
});

test('hedge mode: SHORT entry uses SELL + SHORT, targets BUY + SHORT; a same-side position on the venue still blocks',async()=>{
 const v=hedgeVenue({fillAt:PX_S}),ex=make(v,{price:PX_S,trend:down4h,rows:rise});ex.arm();
 assert.equal((await ex.scan()).entered,1,JSON.stringify(ex.store.skips));
 const entry=placed(v,'MARKET')[0];assert.deepEqual([entry.side,entry.positionSide],['SELL','SHORT']);
 assert.ok(placed(v,'TAKE_PROFIT_MARKET').every(o=>o.side==='BUY'&&o.positionSide==='SHORT'&&!('reduceOnly' in o)));
 assert.equal(ex.store.open[0].size,v.pos.SHORT.amt);
 const v2=hedgeVenue({manual:{side:'LONG',amt:2}}),ex2=make(v2);ex2.arm();await ex2.scan();
 assert.equal(ex2.store.skips.at(-1).reason,'VENUE_POSITION_EXISTS');assert.equal(placed(v2,'MARKET').length,0);
 // A position opened before this change (no hedge field) keeps the one-way orders.
 const v3=venue(),ex3=make(v3);ex3.arm();await ex3.scan();assert.equal(ex3.store.open[0].hedge,false);assert.equal(placed(v3,'MARKET')[0].positionSide,'BOTH');
 assert.ok(placed(v3,'TAKE_PROFIT_MARKET').every(o=>o.reduceOnly==='true'));
});

test('hedge mode: a position on the other side of the coin -> no settlement from the symbol fund flow (fill estimate kept)',async()=>{
 // The symbol's fund flow holds the other side's +38.4 realized PnL: it must not become this trade's result.
 const flow=q=>[{symbol:'SOL-USDT',incomeType:'REALIZED_PNL',income:'38.4',time:String(q.startTime+60000)},{symbol:'SOL-USDT',incomeType:'TRADING_FEE',income:'-0.2',time:String(q.startTime+60000)}];
 const run=async({manual,later})=>{
  const v=hedgeVenue({manual,income:flow}),clock={t:T0},ex=make(v,{clock});ex.arm();await ex.scan();const p=ex.store.open[0];
  if(later){v.pos.SHORT={amt:4,avg:120};clock.t+=30000;await ex.reconcile()}
  clock.t=BUCKET*I+2*3600000;v.mark=p.avg-.05;await ex.reconcile(); // time exit
  clock.t+=200000;await ex.reconcile();return {v,ex,x:ex.store.closed[0]};
 };
 for(const c of [{manual:{side:'SHORT',amt:3,avg:110}},{later:true}]){
  const {v,ex,x}=await run(c);
  assert.equal(x.otherSideSeen,true,JSON.stringify(c));assert.equal(x.realized,undefined);assert.equal(x.netSource,'ESTIMATE_OTHER_SIDE');
  assert.ok(x.netUSD<0,'the estimate of our own losing exit, not +38.2');assert.equal(v.calls.filter(k=>k.op==='income').length,0,'fund flow never read');
  assert.equal(x.journaled,true,'journaled from the estimate right away');assert.ok(ex.journal(5)[0].pnl.netUSD<0);
 }
 // Control: no other side -> the exchange settlement as before.
 const {x}=await run({});assert.equal(x.otherSideSeen,undefined);assert.equal(x.netSource,'EXCHANGE');
});

test('hedge mode: a non-zero row without LONG / SHORT is an error, not "flat" — stop and targets stay',async()=>{
 const v=hedgeVenue(),clock={t:T0},ex=make(v,{clock});ex.arm();await ex.scan();const p=ex.store.open[0];
 const real=v.client.positions;v.client.positions=async()=>[{symbol:'SOL-USDT',positionSide:'BOTH',positionAmt:String(p.size),avgPrice:String(p.avg)}];
 for(let i=0;i<3;i++){clock.t+=20000;await ex.reconcile()}
 assert.equal(ex.store.open.length,1);assert.equal(ex.store.open[0].zeroSeen??0,0);assert.ok(!v.calls.some(c=>c.op==='cancel'));
 assert.ok(ex.store.events.some(e=>e.type==='RECONCILE_ERROR'&&e.reason==='POSITION_SIDE_UNKNOWN'));
 v.client.positions=real;clock.t+=20000;await ex.reconcile();assert.equal(ex.store.open.length,1);
});

test('better price (toward the stop) is taken while half the stop distance is left (user 2026-11-17)',()=>{
 const cfg=scalpExecConfig({SCALP_STOP_LOSS:'on'}),det=detectScalpReversal(crash(),{symbol:'SOLUSDT',now:T0,interval:'5m',settings:cfg.settings});
 assert.equal(cfg.stopKeepPct,50);
 const planned=det.entry-det.stop,base=planScalpOrder({det,price:det.entry,contract:SOL,equity:10000,leverage:10,config:cfg});assert.ok(base.ok);
 const better=planScalpOrder({det,price:det.entry-planned*.4,contract:SOL,equity:10000,leverage:10,config:cfg});
 assert.ok(better.ok,'60 % of the stop distance left: enters at the better price');assert.ok(better.netRR>base.netRR,'better RR');assert.ok(Math.abs(better.riskUSD-base.riskUSD)<=base.riskUSD*.05||better.capped,'same $ risk');
 const tight=planScalpOrder({det,price:det.entry-planned*.6,contract:SOL,equity:10000,leverage:10,config:cfg});
 assert.equal(tight.reasons[0],'PRICE_DRIFT');assert.equal(tight.toward,'STOP');assert.ok(tight.stopLeftPct<50);
 assert.equal(planScalpOrder({det,price:det.stop,contract:SOL,equity:10000,leverage:10,config:cfg}).reasons[0],'PRICE_DRIFT','at the stop: never');
 assert.equal(scalpExecConfig({SCALP_STOP_KEEP_PCT:'0'}).stopKeepPct,0);
 // Review 2026-11-17: no drift always passes even with a stop shorter than 3 costs; a stop on the wrong side never
 // plans; a price past the signal extreme is out; SHORT is symmetric.
 const tightStop={...det,stop:det.entry*(1-.003)};
 assert.notEqual(planScalpOrder({det:tightStop,price:det.entry,contract:SOL,equity:10000,leverage:10,config:cfg}).reasons?.[0],'PRICE_DRIFT');
 assert.equal(planScalpOrder({det:tightStop,price:det.entry*(1-.0005),contract:SOL,equity:10000,leverage:10,config:cfg}).reasons[0],'PRICE_DRIFT','under 3 costs: no move toward the stop');
 assert.equal(planScalpOrder({det:{...det,stop:det.entry*1.01},price:det.entry*1.002,contract:SOL,equity:10000,leverage:10,config:cfg}).reasons[0],'ENTRY_AT_OR_BEYOND_STOP');
 assert.equal(planScalpOrder({det:{...det,evidence:{...det.evidence,extreme:det.entry-planned*.3}},price:det.entry-planned*.4,contract:SOL,equity:10000,leverage:10,config:cfg}).beyondExtreme,true);
 const ds=detectScalpReversal(rise(),{symbol:'SOLUSDT',now:T0,interval:'5m',settings:cfg.settings}),ps=ds.stop-ds.entry;
 const sb=planScalpOrder({det:ds,price:ds.entry+ps*.3,contract:SOL,equity:10000,leverage:10,config:cfg});
 assert.ok(sb.ok||sb.reasons[0]!=='PRICE_DRIFT'||sb.beyondExtreme,'SHORT: a better (higher) price with 70 % left is not a plain drift skip');
});

test('testnet scalp without stop-loss skips virtual-stop RR and stopKeepPct (user 2026-11-20)',()=>{
 const cfg=scalpExecConfig({});
 assert.equal(cfg.stopLossEnabled,false);
 const det=detectScalpReversal(crash(),{symbol:'SOLUSDT',now:T0,interval:'5m',settings:cfg.settings});
 assert.equal(det.ok,true);
 // 1) Virtual-stop minNetRR is skipped, but TP1 must still cover round-trip costs.
 const wideStop={...det,stop:det.entry-20};
 assert.equal(planScalpOrder({det:wideStop,price:det.entry,contract:SOL,equity:10000,leverage:10,config:cfg}).ok,true);
 const tinyTp1={...det,targets:[det.entry*1.0005,det.targets[1],det.targets[2]]};
 assert.deepEqual(planScalpOrder({det:tinyTp1,price:det.entry,contract:SOL,equity:10000,leverage:10,config:cfg}).reasons,['TP1_NET_RR_BELOW_MINIMUM']);
 // 2) Better price toward virtual stop skips stopKeepPct, while still rejecting beyond the signal extreme.
 const planned=det.entry-det.stop;
 const deepBetter=planScalpOrder({det,price:det.entry-planned*.6,contract:SOL,equity:10000,leverage:10,config:cfg});
 assert.equal(deepBetter.ok,true);
 const pastExtreme=planScalpOrder({det:{...det,evidence:{...det.evidence,extreme:det.entry-planned*.3}},price:det.entry-planned*.4,contract:SOL,equity:10000,leverage:10,config:cfg});
 assert.equal(pastExtreme.beyondExtreme,true);
});

// ---- Shared TESTNET budget with the signal strategy (user 2026-11-17 "한도까지 하나로", "하루 손실을 늘리면 되지") ----
test('shared testnet budget: the signal strategy\'s open risk, loss and margin count for a scalp entry; per-trade risk stays 0.5 %',async()=>{
 const {TestnetBudget}=await import('../testnet_budget.mjs');
 const sig={open:0,realized:0,margin:0};
 const run=async()=>{const v=venue(),clock={t:T0},budget=new TestnetBudget({dailyLossPct:15,marginCapPct:30,now:()=>clock.t});
  const ex=make(v,{clock,budget});budget.register('signal',{realizedToday:()=>sig.realized,openRisk:()=>sig.open,usedMargin:()=>sig.margin}).register('scalp',ex.budgetSource());
  ex.arm();const st=await ex.scan();return {v,ex,st,budget}};
 // 10,000 equity: limit 1,500. The signal strategy holds 1,460 to its stops; the scalp's 50 would cross it.
 sig.open=1460;{const {v,ex}=await run();assert.equal(ex.store.skips.at(-1)?.reason,'OPEN_RISK_LIMIT');assert.match(ex.store.skips.at(-1).detail,/신호\+단타/);assert.equal(placed(v,'MARKET').length,0)}
 // The signal strategy lost 1,500 today: no scalp entry either.
 sig.open=0;sig.realized=-1500;{const {v,ex,st}=await run();assert.ok(st.error==='DAILY_LOSS_LIMIT'||ex.store.skips.at(-1)?.reason==='DAILY_LOSS_LIMIT',JSON.stringify({st,s:ex.store.skips}));assert.equal(placed(v,'MARKET').length,0)}
 // The signal strategy uses the whole shared margin (30 % of 10,000).
 sig.realized=0;sig.margin=3000;{const {v,ex}=await run();assert.equal(ex.store.skips.at(-1)?.reason,'MARGIN_CAP');assert.equal(placed(v,'MARKET').length,0)}
 // Room left (1,400 + 50 <= 1,500): entered at the same per-trade risk; its risk is in the shared numbers.
 sig.margin=0;sig.open=1400;{const {v,ex,budget}=await run();assert.equal(placed(v,'MARKET').length,1,JSON.stringify(ex.store.skips));
  assert.ok(Math.abs(ex.store.open[0].riskUSD-50)<.2,'0.5 % of 10,000 as without the budget');
  const s=budget.snapshot(10000);assert.ok(Math.abs(s.openRiskUSD-1400-ex.store.open[0].riskUSD)<.5,JSON.stringify(s));assert.ok(s.by.scalp.marginUSD>0);
  assert.equal(ex.status().settings.dailyLossPct,15);assert.equal(ex.status().settings.sharedBudget,true)}
});

test('shared testnet budget: the day stop (both strategies) blocks new entries of both without turning the switch off; next KST day resumes',async()=>{
 const {TestnetBudget}=await import('../testnet_budget.mjs');
 const v=venue(),clock={t:T0},funds={equity:1000,available:900},budget=new TestnetBudget({dailyLossPct:15,marginCapPct:30,now:()=>clock.t});
 const sig={realized:-140};const ex=make(v,{clock,funds,budget});
 budget.register('signal',{realizedToday:day=>day==='2026-11-16'?sig.realized:0,openRisk:()=>0,usedMargin:()=>0}).register('scalp',ex.budgetSource());
 ex.arm();await ex.scan();assert.equal(ex.store.open.length,1,JSON.stringify(ex.store.skips));
 // Signal -140 realized + scalp about -10 unrealized <= -150 (15 % of 1,000).
 v.mark=v.avg-10.5/ex.store.open[0].size;clock.t+=30000;await ex.reconcile();
 assert.equal(ex.store.dailyStop?.day,'2026-11-16');assert.equal(ex.armed,true,'one switch: stays on');assert.equal(ex.status().blocked,'DAILY_LOSS_LIMIT');
 assert.equal(ex.store.events.find(e=>e.type==='DAILY_LOSS_LIMIT').shared,true);
 assert.match(scalpEventText(ex.store.events.find(e=>e.type==='DAILY_LOSS_LIMIT')),/신호 전략·단타 모두/);
 assert.equal(budget.check({equity:1000,newRiskUSD:1}).reason,'DAILY_LOSS_LIMIT','the signal strategy is stopped too');
 assert.ok(ex.store.open[0].stopOrderId,'the open position keeps its stop');
 clock.t+=24*3600000;assert.equal(ex.status().blocked,null,'next KST day: entries again');
});

// ---- 매물대 반전 (user 2026-11-17 23:12 "1번 진행", backtest candidate B) ----
// A ~4.4 % drop (below the 5 % rule, above 2.5 %) to a low of 95.7; zones from 4H / 1D candles (backtest.mjs zoneBook).
const H4=4*3600000,D1=86400000,DAY0=Date.parse('2026-11-16T00:00:00Z');
const blocks=(list,endAt,ms)=>{const n=list.reduce((a,b)=>a+b[0],0),out=[];let t=endAt-n*ms;
 for(const [count,lo,hi,v] of list)for(let i=0;i<count;i++,t+=ms){const mid=(lo+hi)/2;out.push([t,String(mid),String(hi),String(lo),String(mid),String(v),t+ms-1,'1'])}return out};
const Z4_TOUCH=blocks([[150,109.5,110.5,1],[120,95.3,96.1,10]],DAY0,H4),Z4_FAR=blocks([[150,109.5,110.5,1],[120,120,121,10]],DAY0,H4);
const Z1_FAR=blocks([[60,119,121,1],[60,130,131,5]],DAY0,D1);
const small=()=>crash({move:4,wick:.3}),PX_Z=+(Number(small().at(-1)[4])+.02).toFixed(2);
function zoneFeed(h4=Z4_TOUCH,d1=Z1_FAR){const calls=[];const fn=async(s,iv,limit)=>{calls.push({iv,limit});const r=iv==='4h'?h4:iv==='1d'?d1:null;
 if(r instanceof Error)throw r;return typeof r==='function'?r():r};fn.calls=calls;return fn}
const zoneMake=(v,opt={})=>make(v,{rows:small,price:PX_Z,...opt,zone:opt.zone??zoneFeed()});

test('매물대 반전: a 2.5 %+ reversal whose low touched a 4H zone enters as ZONE_REVERSAL; the same signal off a zone is skipped',async()=>{
 const v=venue({fillAt:PX_Z}),zone=zoneFeed(),ex=zoneMake(v,{zone});ex.arm();
 const st=await ex.scan();assert.equal(st.entered,1,JSON.stringify({st,skips:ex.store.skips}));assert.equal(st.signals,0,'not a 5 % signal');
 assert.equal(st.zoneSignals,1);assert.equal(st.zoneAtZone,1);assert.equal(st.zoneEntered,1);
 const p=ex.store.open[0];assert.equal(p.kind,'ZONE_REVERSAL');assert.ok(p.evidence.movePct>=2.5&&p.evidence.movePct<5);
 assert.equal(p.zone.tf,'4h');assert.equal(p.zone.atZone,true);assert.ok(p.zone.distPct>=0&&p.zone.distPct<=.3,'low within 0.3 % of the band');assert.equal(p.zone.rank,1);
 assert.ok(p.zone.low>=95.3&&p.zone.high<=96.1&&p.zone.sharePct>0);assert.equal(p.zone.zone1d.atZone,false,'1D zones read too (far away)');
 // Same rules as the 5 % scalp: stop attached, three reduce-only targets, 0.5 % risk, 38.2 % TP1, net RR >= 1.
 assert.ok(JSON.parse(placed(v,'MARKET')[0].stopLoss).stopPrice<95.7);assert.equal(placed(v,'TAKE_PROFIT_MARKET').length,3);
 assert.ok(Math.abs(p.riskUSD-50)<.2);assert.ok(p.netRR>=1);assert.equal(placed(v,'MARKET')[0].clientOrderId,scalpClientId('SOLUSDT',BUCKET*I));
 assert.deepEqual(zone.calls,[{iv:'4h',limit:542},{iv:'1d',limit:182}],'ZONE_PROFILES counts + 2, read once each');
 const opened=ex.store.events.find(e=>e.type==='OPENED');assert.equal(opened.kind,'ZONE_REVERSAL');
 assert.match(scalpEventText(opened),/매물대 반전\(4H\/1D\) — 4H 매물대/);assert.doesNotMatch(scalpEventText({...opened,kind:'MOVE_REVERSAL'}),/매물대/);
 const sig=ex.signals(5).at(-1);assert.equal(sig.kind,'ZONE_REVERSAL');assert.equal(sig.entered,true);assert.equal(sig.zone.tf,'4h');assert.equal(sig.zone.distPct,p.zone.distPct);
 // Off a zone (4H zone at 120, 1D far): detected, logged, skipped, no order.
 const w=venue({fillAt:PX_Z}),off=zoneMake(w,{zone:zoneFeed(Z4_FAR,Z1_FAR)});off.arm();const s2=await off.scan();
 assert.equal(s2.entered,0);assert.equal(s2.zoneSignals,1);assert.equal(placed(w,'MARKET').length,0);
 assert.equal(off.store.skips.at(-1).reason,'ZONE_NOT_TOUCHED');assert.equal(off.store.skips.at(-1).kind,'ZONE_REVERSAL');assert.ok(scalpReasonKo('ZONE_NOT_TOUCHED')!=='ZONE_NOT_TOUCHED');
 const line=off.signals(5).at(-1);assert.equal(line.kind,'ZONE_REVERSAL');assert.equal(line.reason,'ZONE_NOT_TOUCHED');assert.equal(line.zone.atZone,false);assert.ok(line.zone.distPct>20);
 // The 5 % rule alone: the 4.9 % drop is not a signal.
 const x=venue({fillAt:PX_Z}),offCfg=zoneMake(x,{config:scalpExecConfig({SCALP_ZONE_SIGNALS:'off'}),zone:zoneFeed()});offCfg.arm();
 const s3=await offCfg.scan();assert.equal(s3.entered,0);assert.equal(s3.zoneSignals,undefined);assert.equal(placed(x,'MARKET').length,0);
 assert.equal(offCfg.status().settings.zoneSignals,false);assert.equal(ex.status().settings.zoneSignals,true);assert.equal(scalpExecConfig({}).zoneSignals,true);
 assert.equal(scalpExecConfig({SCALP_ZONE_SIGNALS:' OFF '}).zoneSignals,false);assert.equal(scalpExecConfig({SCALP_ZONE_SIGNALS:'on'}).zoneSignals,true);
 assert.equal(offCfg.signals(5).length,0,'nothing detected, nothing logged');
});

test('매물대 반전: a zone from candles that closed after the move window began does not count',async()=>{
 // One heavy 4H candle at 95.3-96.1 that closed 20 minutes before the signal candle's close (inside the 35-minute window).
 const late=blocks([[269,109.5,110.5,1],[1,95.3,96.1,1000]],BUCKET*I-20*60000+1,H4),early=blocks([[269,109.5,110.5,1],[1,95.3,96.1,1000]],BUCKET*I-40*60000+1,H4);
 const v=venue({fillAt:PX_Z}),ex=zoneMake(v,{zone:zoneFeed(late,Z1_FAR)});ex.arm();await ex.scan();
 assert.equal(placed(v,'MARKET').length,0);assert.equal(ex.store.skips.at(-1).reason,'ZONE_NOT_TOUCHED',JSON.stringify(ex.store.skips));
 const w=venue({fillAt:PX_Z}),ok=zoneMake(w,{zone:zoneFeed(early,Z1_FAR)});ok.arm();await ok.scan();
 assert.equal(placed(w,'MARKET').length,1,'closed before the window: the zone counts');assert.equal(ok.store.open[0].zone.tf,'4h');
});

test('매물대 반전: a 5 % signal is never a zone signal too; a candle sent once is not sent again',async()=>{
 const v=venue(),zone=zoneFeed(),ex=make(v,{zone});ex.arm();
 const st=await ex.scan();assert.equal(st.entered,1);assert.equal(st.signals,1);assert.equal(st.zoneSignals,undefined);
 assert.equal(ex.store.open[0].kind,'MOVE_REVERSAL');assert.equal(ex.store.open[0].zone,undefined);assert.equal(zone.calls.length,0,'no zone reads for a 5 % signal');
 assert.equal(ex.signals(5).at(-1).kind,'MOVE_REVERSAL');assert.match(scalpEventText(ex.store.events.find(e=>e.type==='OPENED')),/진입\n/);
 const n=v.calls.length;ex.lastScanBucket=null;await ex.scan();assert.equal(v.calls.length,n);assert.equal(zone.calls.length,0);
 // A zone signal already sent: the rescan reads nothing more and sends nothing.
 const w=venue({fillAt:PX_Z}),z2=zoneFeed(),zx=zoneMake(w,{zone:z2});zx.arm();await zx.scan();assert.equal(placed(w,'MARKET').length,1);
 const m=w.calls.length,reads=z2.calls.length,lines=zx.signals(10).length;zx.lastScanBucket=null;const again=await zx.scan();
 assert.equal(w.calls.length,m);assert.equal(z2.calls.length,reads);assert.equal(zx.signals(10).length,lines,'not logged twice');assert.equal(again.entered,0);
});

test('매물대 반전: missing 4H / 1D candles are never a touch (ZONE_DATA_UNAVAILABLE); 100410 is retried; zones cached until the next close',async()=>{
 const down=Object.assign(Error('net'),{code:'NETWORK_UNREACHABLE'});
 for(const [h4,d1] of [[down,down],[[],[]],[Z4_FAR,down],[Z4_FAR.slice(-20),Z1_FAR]]){
  const v=venue({fillAt:PX_Z}),ex=zoneMake(v,{zone:zoneFeed(h4,d1)});ex.arm();await ex.scan();
  assert.equal(placed(v,'MARKET').length,0);assert.equal(ex.store.skips.at(-1).reason,'ZONE_DATA_UNAVAILABLE',JSON.stringify(ex.store.skips.at(-1)));
  assert.equal(ex.signals(5).at(-1).reason,'ZONE_DATA_UNAVAILABLE');
 }
 // A touch on the timeframe that could be read still counts (as the backtest without daily candles).
 {const v=venue({fillAt:PX_Z}),ex=zoneMake(v,{zone:zoneFeed(Z4_TOUCH,down)});ex.arm();await ex.scan();assert.equal(placed(v,'MARKET').length,1);assert.equal(ex.store.open[0].zone.zone1d,null)}
 // BingX 100410 (shared public rate): read again after 1.5 s, as the 5m candles.
 {let n=0;const busy=Object.assign(Error('rate'),{code:'VENUE_ERROR_100410'}),z=zoneFeed(()=>{if(!n++)throw busy;return Z4_TOUCH},Z1_FAR);
  const v=venue({fillAt:PX_Z}),ex=zoneMake(v,{zone:z});ex.arm();const st=await ex.scan();assert.equal(st.rateLimited,1);assert.equal(placed(v,'MARKET').length,1,JSON.stringify(ex.store.skips))}
 // Cache: the same 4H / 1D book until a newer candle of that timeframe closes.
 const clock={t:T0},z=zoneFeed(),ex=zoneMake(venue(),{clock,zone:z});
 const b4=await ex.zoneBookOf('SOLUSDT','4h','0.01'),b1=await ex.zoneBookOf('SOLUSDT','1d','0.01');assert.equal(z.calls.length,2);
 assert.equal(await ex.zoneBookOf('SOLUSDT','4h','0.01'),b4);assert.equal(await ex.zoneBookOf('SOLUSDT','1d','0.01'),b1);assert.equal(z.calls.length,2);
 clock.t=DAY0+H4+1000;await ex.zoneBookOf('SOLUSDT','4h','0.01');await ex.zoneBookOf('SOLUSDT','1d','0.01');
 assert.deepEqual(z.calls.map(c=>c.iv),['4h','1d','4h'],'a new 4H close: 4H read again, 1D kept');
 clock.t=DAY0+D1+1000;await ex.zoneBookOf('SOLUSDT','1d','0.01');assert.equal(z.calls.at(-1).iv,'1d');
});

test('매물대 반전: the 4H against-trend block and the shared testnet budget apply as to the 5 % scalp',async()=>{
 {const v=venue({fillAt:PX_Z}),ex=zoneMake(v,{trend:down4h});ex.arm();await ex.scan();
  assert.equal(placed(v,'MARKET').length,0);assert.equal(ex.store.skips.at(-1).reason,'AGAINST_4H_TREND');assert.equal(ex.signals(5).at(-1).trend4h,'down')}
 const {TestnetBudget}=await import('../testnet_budget.mjs');
 const run=async open=>{const v=venue({fillAt:PX_Z}),clock={t:T0},budget=new TestnetBudget({dailyLossPct:15,marginCapPct:30,now:()=>clock.t});
  const ex=zoneMake(v,{clock,budget});budget.register('signal',{realizedToday:()=>0,openRisk:()=>open,usedMargin:()=>0}).register('scalp',ex.budgetSource());ex.arm();await ex.scan();return {v,ex}};
 {const {v,ex}=await run(1460);assert.equal(ex.store.skips.at(-1).reason,'OPEN_RISK_LIMIT');assert.equal(placed(v,'MARKET').length,0)}
 {const {v,ex}=await run(1400);assert.equal(placed(v,'MARKET').length,1);assert.ok(Math.abs(ex.store.open[0].riskUSD-50)<.2)}
 // One position per symbol: a held coin is not read for zones again.
 {const v=venue({fillAt:PX_Z}),z=zoneFeed(),ex=zoneMake(v,{zone:z});ex.store.open.push({symbol:'SOLUSDT',venueSymbol:'SOL-USDT',status:'OPEN',direction:'LONG',size:0});ex.arm();await ex.scan();
  assert.equal(ex.store.skips.at(-1).reason,'SYMBOL_ALREADY_HELD');assert.equal(z.calls.length,0);assert.equal(placed(v,'MARKET').length,0)}
});

test('매물대 반전: kind flows into the journal, its summary, stats and the report export',async()=>{
 const {scalpReportFiles,journalLine}=await import('../scalp_journal.mjs');
 const dir=tmp(),v=venue({fillAt:PX_Z}),clock={t:T0},ex=zoneMake(v,{clock,dir});ex.arm();await ex.scan();assert.equal(ex.store.open.length,1);
 v.size=0;clock.t+=20000;await ex.reconcile();clock.t+=20000;await ex.reconcile();
 assert.equal(ex.store.closed.length,1);assert.equal(ex.store.closed[0].kind,'ZONE_REVERSAL');
 const j=ex.journal(5);assert.equal(j.length,1);assert.equal(j[0].kind,'ZONE_REVERSAL');assert.equal(j[0].zone.tf,'4h');
 const st=ex.stats();assert.equal(st.byKind.ZONE_REVERSAL.trades,1);assert.equal(st.byKind.MOVE_REVERSAL.trades,0);
 const {files,summary}=scalpReportFiles({journalFile:ex.journalFile,signalsFile:ex.signalsFile,now:clock.t});
 const t=files['scalp/trades.jsonl'].trim().split('\n').map(JSON.parse);assert.equal(t[0].kind,'ZONE_REVERSAL');assert.equal(t[0].zone.tf,'4h');
 assert.equal(summary.byKind.ZONE_REVERSAL.trades,1);assert.equal(summary.last[0].kind,'ZONE_REVERSAL');assert.ok(summary.byMoveBucket['2.5-5%']);
 const sigFile=Object.keys(files).find(k=>k.startsWith('scalp/signals-'));assert.ok(files[sigFile].includes('"kind":"ZONE_REVERSAL"'));
 // A restart reads the kind back from the journal; older lines without one are 5 % move trades.
 const again=make(venue(),{dir,clock});assert.equal(again.stats().byKind.ZONE_REVERSAL.trades,1);
 assert.equal(journalLine({strategy:'SCALP_REVERSAL',direction:'LONG',avg:1,initialStop:.9,filled:1}).kind,'MOVE_REVERSAL');
});

test('testnet screen: scalp badge 단타·급변 / 단타·매물대 on cards and the merged list; details split by kind',async()=>{
 const {testnetClosedHTML,setTestnetPage,scalpPositionCardHTML,scalpBadge}=await import('../public/live_control.js');
 assert.match(scalpBadge('ZONE_REVERSAL'),/단타·매물대/);assert.match(scalpBadge('MOVE_REVERSAL'),/단타·급변/);assert.match(scalpBadge(undefined),/단타·급변/);
 setTestnetPage(0);const h=testnetClosedHTML({closed:[],scalp:{closed:[{id:'a',symbol:'AUSDT',direction:'LONG',kind:'ZONE_REVERSAL',closedAt:T0,netUSD:1},{id:'b',symbol:'BUSDT',direction:'SHORT',closedAt:T0-1,netUSD:-1}]}});
 assert.match(h,/tn-scalp-zone">단타·매물대<\/span><\/td><td><b>AUSDT/);assert.match(h,/tn-scalp">단타·급변<\/span><\/td><td><b>BUSDT/);
 const c=scalpPositionCardHTML({symbol:'SOLUSDT',direction:'LONG',status:'OPEN',kind:'ZONE_REVERSAL',zone:{tf:'4h',low:95.3,high:96.1,sharePct:12.5,rank:1,distPct:0},targets:[],parts:[]});
 assert.match(c,/단타·매물대/);assert.match(c,/4H 매물대 95\.3~96\.1/);
 const d=scalpDetailsHTML({mode:'TESTNET',credentials:true,armed:true,settings:{...scalpExecConfig({}).settings,sides:['LONG','SHORT'],zoneSignals:true,zoneMinMovePct:2.5,zoneTouchPct:.3},
  stats:{byKind:{MOVE_REVERSAL:{trades:2,wins:1,winRatePct:50,profitFactor:1.2,netUSD:3},ZONE_REVERSAL:{trades:1,wins:1,winRatePct:100,profitFactor:null,netUSD:2}}},skips:[{at:T0,symbol:'X',reason:'ZONE_NOT_TOUCHED',kind:'ZONE_REVERSAL',direction:'LONG',label:scalpReasonKo('ZONE_NOT_TOUCHED')}],skipCounts:[{reason:'ZONE_NOT_TOUCHED',label:'x',count:1}]});
 assert.match(d,/급변 5%<b >2건/);assert.match(d,/매물대 반전<b >1건/);assert.match(d,/2\.5% 이상 \+ 극값이 4H\/1D 매물대 ±0\.3% 안/);assert.match(d,/매물대 후보/);
});

test('매물대 반전 (review L2): a kill switch or disarm during the zone reads stops the order; HTTP 429 on the 4H read stops the scan without the 1D read',async()=>{
 // Kill switch pressed while the 4H zone candles are read.
 {let killed=false;const z=zoneFeed(()=>{killed=true;return Z4_TOUCH},Z1_FAR),v=venue({fillAt:PX_Z});
  const ex=zoneMake(v,{zone:z,gate:()=>killed?{ok:false,reason:'KILL_SWITCH'}:{ok:true}});ex.arm();await ex.scan();
  assert.equal(placed(v,'MARKET').length,0,'no order after the kill switch');assert.equal(ex.store.skips.at(-1).reason,'KILL_SWITCH');assert.equal(ex.store.open.length,0)}
 // Disarmed while the 1D candles are read.
 {let ex;const z=zoneFeed(Z4_TOUCH,()=>{ex.disarm();return Z1_FAR}),v=venue({fillAt:PX_Z});ex=zoneMake(v,{zone:z});ex.arm();await ex.scan();
  assert.equal(placed(v,'MARKET').length,0);assert.equal(ex.store.skips.at(-1).reason,'NOT_ARMED')}
 // HTTP 429 on the 4H read: cooldown, no 1D read, no order, the scan ends with HTTP_429.
 {const e429=Object.assign(Error('429'),{code:'HTTP_429'}),z=zoneFeed(e429,Z4_TOUCH),v=venue({fillAt:PX_Z}),ex=zoneMake(v,{zone:z});ex.arm();const st=await ex.scan();
  assert.deepEqual(z.calls.map(c=>c.iv),['4h']);assert.equal(placed(v,'MARKET').length,0);assert.equal(st.error,'HTTP_429');
  assert.equal(ex.store.skips.at(-1).reason,'HTTP_429');assert.equal(ex.status().blocked,'RATE_LIMIT_COOLDOWN')}
 // HTTP 429 on the 1D read after a touching 4H: still no order.
 {const e429=Object.assign(Error('429'),{code:'HTTP_429'}),v=venue({fillAt:PX_Z}),ex=zoneMake(v,{zone:zoneFeed(Z4_TOUCH,e429)});ex.arm();const st=await ex.scan();
  assert.equal(placed(v,'MARKET').length,0);assert.equal(st.error,'HTTP_429')}
 // The 5 % path: blocked between the scan loop's check and the entry checks -> no order.
 {let killed=false;const v=venue(),ex=make(v,{gate:()=>killed?{ok:false,reason:'KILL_SWITCH'}:{ok:true}});
  const read=ex.candles;ex.candles=async(...a)=>{const r=await read(...a);if(a[1]==='5m')killed=true;return r};ex.arm();await ex.scan();
  assert.equal(placed(v,'MARKET').length,0);assert.equal(ex.store.skips.at(-1).reason,'KILL_SWITCH')}
});

test('매물대 반전 (review L3): trend block, other strategy, position cap and a held coin stop the candidate before any zone read, with the same reasons',async()=>{
 const cases=[[{trend:down4h},'AGAINST_4H_TREND'],[{isBusy:()=>true},'SYMBOL_HELD_BY_OTHER_STRATEGY'],[{config:{maxOpen:1},held:'ETHUSDT'},'MAX_OPEN_POSITIONS'],[{held:'SOLUSDT'},'SYMBOL_ALREADY_HELD']];
 for(const [opt,reason] of cases){
  const z=zoneFeed(),v=venue({fillAt:PX_Z}),ex=zoneMake(v,{...opt,zone:z});
  if(opt.held)ex.store.open.push({symbol:opt.held,venueSymbol:opt.held.replace('USDT','-USDT'),status:'OPEN',direction:'LONG',size:0});
  ex.arm();await ex.scan();
  assert.equal(z.calls.length,0,reason+': no zone read');assert.equal(ex.store.skips.at(-1).reason,reason);assert.equal(placed(v,'MARKET').length,0);
  assert.equal(ex.store.skips.filter(s=>s.reason===reason).length,1,'one skip line');assert.equal(ex.signals(5).at(-1).reason,reason);
 }
 // Passing the checks: the zones are read and the entry checks run again on the way in (still one entry).
 const z=zoneFeed(),v=venue({fillAt:PX_Z}),ex=zoneMake(v,{zone:z});ex.arm();await ex.scan();assert.equal(z.calls.length,2);assert.equal(placed(v,'MARKET').length,1);
 assert.equal(ex.signals(5).at(-1).trend4h,'up');
});

test('report push: scalp ledger trades carry kind',async()=>{
 const {ledgerSummary}=await import('../reports_push.mjs');
 const s=ledgerSummary({closed:[{symbol:'A',direction:'LONG',kind:'ZONE_REVERSAL',closedAt:2,netUSD:1},{symbol:'B',direction:'SHORT',closedAt:3,netUSD:-1}],open:[]},{now:10});
 assert.equal(s.trades[0].kind,'ZONE_REVERSAL');assert.equal('kind' in s.trades[1],false,'copy / older rows: no kind field');
});
