import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {ScalpExecutor,scalpExecConfig,scalpSplits,planScalpOrder,scalpUniverse,scalpClientId,scalpSides,signedAmount,SCALP_EXEC_COSTS,SCALP_EXEC_SETTINGS} from '../scalp_executor.mjs';
import {scalpEventText,scalpReasonKo} from '../scalp_telegram.mjs';
import {detectScalpReversal,SCALP_TIMEFRAMES} from '../scalp_reversal.mjs';
import {BACKTEST_COSTS} from '../backtest.mjs';
import {scalpHTML} from '../public/live_control.js';

const I=300000,BUCKET=Math.floor(Date.parse('2026-11-16T03:00:00Z')/I),T0=BUCKET*I+5000;
// 50 quiet 5m candles near 100, a fast ~6.6 % drop on heavy volume, then a hammer (the candle that just closed).
function crash({move=6,volume=10,lastOpen=(BUCKET-1)*I}={}){
 const rows=[];let p=100;const push=(o,h,l,c,v)=>rows.push([0,o,h,l,c,v]);
 for(let i=0;i<50;i++){const o=p,c=p+(i%2?.05:-.05);push(o,Math.max(o,c)+.1,Math.min(o,c)-.1,c,100);p=c}
 for(let i=0;i<4;i++){const o=p,c=p-move/4;push(o,o+.05,c-.1,c,100*volume*(i===3?1:.5));p=c}
 push(p,p+.15,p-.8,p+.1,80*volume);
 return rows.map((r,i)=>{const t=lastOpen-(rows.length-1-i)*I;return [t,...r.slice(1,6).map(String),t+I-1,String(r[5]*r[4])]});
}
const up4h=now=>Array.from({length:301},(_,i)=>{const t=now-(301-i)*4*3600000-1000,c=50+i*.1;return [t,String(c),String(c+.2),String(c-.2),String(c),'1000',t+4*3600000-1,'1']});
const down4h=now=>up4h(now).map((r,i)=>{const c=200-i*.1;return [r[0],String(c),String(c+.2),String(c-.2),String(c),'1000',r[6],'1']});
// The mirror image around 100: a fast ~6.6 % rise and a shooting star (SHORT).
const rise=o=>crash(o).map(r=>[r[0],String(200-r[1]),String(200-r[3]),String(200-r[2]),String(200-r[4]),r[5],r[6],r[7]]);
const ENTRY=Number(crash().at(-1)[4]),PX=+(ENTRY+.02).toFixed(2),ENTRY_S=Number(rise().at(-1)[4]),PX_S=+(ENTRY_S-.02).toFixed(2);
const SOL={symbol:'SOLUSDT',venueSymbol:'SOL-USDT',tickSize:'0.01',quantityStep:'0.01',minQuantityBase:'0.01',minNotionalUSDT:2,tradable:true};

// One-way BingX fake: amt is the signed position (+ long, - short), as positionAmt.
function venue({hedge=false,failStop=false,maxLev=20,fillAt=PX}={}){
 const calls=[],orders=new Map();let amt=0,avg=0,mark=0,id=1;
 const reduce=q=>{amt=amt>0?+Math.max(0,amt-q).toFixed(8):+Math.min(0,amt+q).toFixed(8)};
 const add=(p,extra={})=>{const o={orderId:String(id++),...p,status:'NEW',...extra};orders.set(o.orderId,o);return o};
 const client={mode:'TESTNET',
  positionMode:async()=>({dualSidePosition:hedge}),marginType:async()=>({marginType:'CROSSED'}),setMarginType:async()=>({}),
  leverage:async()=>({maxLongLeverage:maxLev,maxShortLeverage:maxLev}),setLeverage:async(s,side,l)=>{calls.push({op:'lev',l});return {leverage:l}},
  positions:async()=>amt!==0?[{symbol:'SOL-USDT',positionSide:'BOTH',positionAmt:String(amt),avgPrice:String(avg),markPrice:String(mark||avg),unrealizedProfit:String(((mark||avg)-avg)*amt)}]:[],
  openOrders:async()=>({orders:[...orders.values()].filter(o=>o.status==='NEW')}),
  getOrder:async(s,{orderId,clientOrderId})=>({order:[...orders.values()].find(o=>orderId?o.orderId===orderId:o.clientOrderId===clientOrderId)??null}),
  cancelOrder:async(s,oid)=>{calls.push({op:'cancel',oid});const o=orders.get(oid);if(o&&o.status==='NEW')o.status='CANCELED';return {}},
  placeOrder:async p=>{calls.push({op:'order',...p});
   if(failStop&&p.type==='STOP_MARKET')throw Object.assign(Error('no'),{code:'VENUE_ERROR_1'});
   if(p.type==='MARKET'){const q=Number(p.quantity);
    if(p.reduceOnly){reduce(q);return {order:add(p,{status:'FILLED',executedQty:String(q),avgPrice:String(mark||avg)})}}
    avg=mark||fillAt;amt=+(amt+(p.side==='SELL'?-q:q)).toFixed(8);const o=add(p,{status:'FILLED',executedQty:String(q),avgPrice:String(avg)});
    if(p.stopLoss){const sl=JSON.parse(p.stopLoss);add({symbol:p.symbol,type:'STOP_MARKET',stopPrice:String(sl.stopPrice),side:p.side==='SELL'?'BUY':'SELL'})}
    return {order:o}}
   return {order:add(p)}}};
 return {client,calls,orders,get size(){return Math.abs(amt)},set size(v){amt=v},get amt(){return amt},set mark(v){mark=v},get avg(){return avg},
  fill(o,price){o.status='FILLED';o.executedQty=o.quantity??String(Math.abs(amt));o.avgPrice=String(price??o.stopPrice);reduce(Number(o.executedQty))}};
}
function make(v,{clock={t:T0},price=PX,funds={equity:10000,available:9000},gate=()=>({ok:true}),isBusy=()=>false,dir=null,trend=up4h,contract=SOL,config={},rows=crash}={}){
 return new ScalpExecutor({config:{...scalpExecConfig({}),...config},client:v.client,contracts:async()=>new Map([['SOLUSDT',contract]]),tickers:async()=>[{symbol:'SOL-USDT',quoteVolume:'90000000'},{symbol:'NCSKAAPL2USD-USDT',quoteVolume:'1e12'}],
  candles:async(s,iv)=>iv==='5m'?[...rows(),[BUCKET*I,'100','100','100','100','1',BUCKET*I+I-1,'1']]:trend(clock.t),priceOf:async()=>typeof price==='function'?price():price,markOf:async()=>101,
  balance:async()=>funds,gate,isBusy,directory:dir,now:()=>clock.t});
}
const tmp=()=>fs.mkdtempSync(path.join(os.tmpdir(),'scalp-exec-'));
const placed=(v,type)=>v.calls.filter(c=>c.op==='order'&&c.type===type);
const short=(opt={})=>{const v=venue({fillAt:PX_S,...opt.venue}),clock=opt.clock||{t:T0};return {v,clock,ex:make(v,{clock,price:PX_S,trend:down4h,rows:rise,...opt})}};

test('config: TESTNET or OFF only — LIVE is refused; settings as the user set them; costs = backtest costs',()=>{
 const c=scalpExecConfig({});assert.equal(c.mode,'TESTNET');assert.equal(c.refused,null);
 assert.equal(c.settings.minMovePct,5);assert.equal(SCALP_EXEC_SETTINGS.minMovePct,SCALP_TIMEFRAMES['5m'].minMovePct*2);
 assert.deepEqual(c.settings.retracements,[.382,.5,.618]);assert.equal(c.settings.stopAtr,.25);assert.equal(c.settings.climaxVolume,3);
 assert.equal(c.maxHoldMs,2*3600000);assert.equal(c.riskPct,.5);assert.equal(c.maxOpen,5);assert.equal(c.dailyLossPct,3);assert.equal(c.trendFilter,true);
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
 const cfg=scalpExecConfig({}),rows=crash();
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
 assert.deepEqual(planScalpOrder({det,price:det.entry*1.006,contract:SOL,equity:10000,leverage:10,config:cfg}).reasons,['PRICE_DRIFT'],'0.6 % above the plan: skipped');
 assert.deepEqual(planScalpOrder({det,price:det.entry,contract:SOL,equity:10000,leverage:10,config:{...cfg,minNetRR:50}}).reasons,['TP1_NET_RR_BELOW_MINIMUM']);
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

test('skips: price drift, hedge mode, symbol held elsewhere, against the 4H trend, kill switch, venue position',async()=>{
 const cases=[[{price:PX*1.01},'PRICE_DRIFT'],[{hedge:true},'BINGX_HEDGE_MODE'],[{isBusy:()=>true},'SYMBOL_HELD_BY_OTHER_STRATEGY'],[{trend:down4h},'AGAINST_4H_TREND']];
 for(const [opt,reason] of cases){
  const v=venue({hedge:opt.hedge}),ex=make(v,opt);ex.arm();await ex.scan();
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

test('testnet page section: on/off pill, switch, desktop tables and phone lists, skip reasons in Korean',async()=>{
 const v=venue(),ex=make(v);let h=scalpHTML(ex.status());
 assert.match(h,/○ 꺼짐/);assert.match(h,/data-scalp-arm/);assert.doesNotMatch(h,/data-scalp-disarm/);
 ex.arm();await ex.scan();ex.store.skips.push({at:T0,symbol:'XUSDT',reason:'PRICE_DRIFT'});ex.store.skipCounts.PRICE_DRIFT=1;
 h=scalpHTML(ex.status());assert.match(h,/● 켜짐/);assert.match(h,/data-scalp-disarm/);
 assert.match(h,/<table class="copy-table only-desk">/);assert.match(h,/<ul class="copy-list only-mob">/);assert.match(h,/SOLUSDT/);
 assert.match(h,/진입가에서 가격이 이미 벗어남 1회/);
 const off=new ScalpExecutor({config:scalpExecConfig({SCALP_EXEC_MODE:'LIVE'})});assert.match(scalpHTML(off.status()),/실계좌 모드는 거부됨/);
});

// ---- SHORT side (user 2026-11-16 16:58 "숏도 넣어줘"): the mirror image of every LONG step ----
test('sides: SCALP_EXEC_SIDES (default both), one-way position sign',()=>{
 assert.deepEqual(scalpExecConfig({}).sides,['LONG','SHORT']);assert.deepEqual(scalpSides('long'),['LONG']);assert.deepEqual(scalpSides('SHORT'),['SHORT']);
 assert.deepEqual(scalpSides('LONG,SHORT'),['LONG','SHORT']);assert.deepEqual(scalpSides('none'),[],'nothing valid: no side traded');
 assert.equal(signedAmount({positionAmt:'-2'}),-2);assert.equal(signedAmount({positionAmt:'2',positionSide:'SHORT'}),-2);assert.equal(signedAmount({positionAmt:'2',positionSide:'BOTH'}),2);
 assert.notEqual(scalpClientId('SOLUSDT',1,'SHORT'),scalpClientId('SOLUSDT',1,'LONG'));assert.equal(scalpClientId('SOLUSDT',1),scalpClientId('SOLUSDT',1,'LONG'),'LONG ids unchanged');
});

test('SHORT detection -> plan: stop above the high (rounded up), 38.2/50/61.8 % targets below the entry, same risk',()=>{
 const cfg=scalpExecConfig({}),det=detectScalpReversal(rise(),{symbol:'SOLUSDT',now:T0,interval:'5m',settings:cfg.settings});
 assert.equal(det.ok,true,JSON.stringify(det.reasons));assert.equal(det.direction,'SHORT');
 const {extreme,origin}=det.evidence,move=extreme-origin;
 assert.ok([.382,.5,.618].every((f,i)=>Math.abs(det.targets[i]-(extreme-f*move))<1e-9));
 const plan=planScalpOrder({det,price:PX_S,contract:{...SOL,tickSize:'0.1'},equity:10000,leverage:10,config:cfg});
 assert.equal(plan.ok,true,JSON.stringify(plan));assert.ok(plan.stop>extreme&&plan.stop>=det.stop&&plan.entry<plan.stop);
 assert.ok(Math.abs(plan.stop*10-Math.round(plan.stop*10))<1e-9,'stop on the tick grid');
 assert.ok(plan.targets.every((t,i)=>t<plan.entry&&(i===0||t<plan.targets[i-1])&&t>=det.targets[i]-1e-9),'targets rounded up, toward the entry');
 assert.ok(Math.abs(plan.riskUSD-50)<.6);assert.ok(plan.netRR>=1);
 assert.deepEqual(planScalpOrder({det,price:PX_S*0.99,contract:SOL,equity:10000,leverage:10,config:cfg}).reasons,['PRICE_DRIFT']);
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
 {const {v,ex}=short({trend:up4h});ex.arm();await ex.scan();assert.equal(ex.store.skips.at(-1).reason,'AGAINST_4H_TREND');assert.equal(placed(v,'MARKET').length,0)}
 {const v=venue();v.size=-1;const ex=make(v);ex.arm();await ex.scan();assert.equal(ex.store.skips.at(-1).reason,'VENUE_POSITION_EXISTS');assert.equal(placed(v,'MARKET').length,0)}
 assert.notEqual(scalpReasonKo('SIDE_OFF'),'SIDE_OFF');
});

test('SHORT daily loss (price up) disarms; stats and the page split 롱 / 숏',async()=>{
 const {v,clock,ex}=short({funds:{equity:1000,available:900}});ex.arm();await ex.scan();
 v.mark=v.avg+35/ex.store.open[0].size;clock.t+=30000;await ex.reconcile();assert.equal(ex.armed,false);assert.equal(ex.store.dailyStop.day,'2026-11-16');
 ex.store.closed.push({symbol:'AUSDT',direction:'LONG',netUSD:3,closedAt:clock.t},{symbol:'BUSDT',direction:'SHORT',netUSD:-1,closedAt:clock.t},{symbol:'CUSDT',direction:'SHORT',netUSD:2,closedAt:clock.t});
 const st=ex.stats();assert.equal(st.trades,3);assert.equal(st.bySide.LONG.trades,1);assert.equal(st.bySide.SHORT.trades,2);
 assert.equal(st.bySide.SHORT.winRatePct,50);assert.equal(st.bySide.SHORT.profitFactor,2);assert.equal(st.bySide.SHORT.netUSD,1);
 const h=scalpHTML(ex.status());assert.match(h,/<th>방향<\/th>/);assert.match(h,/paper-short">숏/);assert.match(h,/숏 손익/);assert.match(h,/거래 방향 롱·숏/);
});
