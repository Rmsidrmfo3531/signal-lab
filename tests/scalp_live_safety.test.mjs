import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {ScalpExecutor,scalpExecConfig,scalpLiveExecConfig,SCALP_LIVE_CONFIRM_TOKEN} from '../scalp_executor.mjs';
import {scalpEventText,SCALP_LIVE_LABEL} from '../scalp_telegram.mjs';
import {tagOrigins,createVenuePositionsReader} from '../venue_positions.mjs';
import {venuePositionsHTML,copyHTML} from '../public/live_control.js';
import {RealTrailingManager} from '../real_trailing.mjs';

const I=300000,BUCKET=Math.floor(Date.parse('2026-11-16T03:00:00Z')/I),T0=BUCKET*I+5000;
function crash({move=6,volume=10,lastOpen=(BUCKET-1)*I,wick=.8}={}){
 const rows=[];let p=100;const push=(o,h,l,c,v)=>rows.push([0,o,h,l,c,v]);
 for(let i=0;i<50;i++){const o=p,c=p+(i%2?.05:-.05);push(o,Math.max(o,c)+.1,Math.min(o,c)-.1,c,100);p=c}
 for(let i=0;i<4;i++){const o=p,c=p-move/4;push(o,o+.05,c-.1,c,100*volume*(i===3?1:.5));p=c}
 push(p,p+.15,p-wick,p+.1,80*volume);
 return rows.map((r,i)=>{const t=lastOpen-(rows.length-1-i)*I;return [t,...r.slice(1,6).map(String),t+I-1,String(r[5]*r[4])]});
}
const up4h=now=>Array.from({length:301},(_,i)=>{const t=now-(301-i)*4*3600000-1000,c=50+i*.1;return [t,String(c),String(c+.2),String(c-.2),String(c),'1000',t+4*3600000-1,'1']});
const ENTRY=Number(crash().at(-1)[4]),PX=+(ENTRY+.02).toFixed(2);
const SOL={symbol:'SOLUSDT',venueSymbol:'SOL-USDT',tickSize:'0.01',quantityStep:'0.01',minQuantityBase:'0.01',minNotionalUSDT:2,tradable:true};

function liveVenue({failStop=false,fillAt=PX,fillAdd=true,maxLev=20}={}){
 const calls=[],orders=new Map();let amt=0,avg=0,mark=0,id=1;
 const add=(p,extra={})=>{const o={orderId:String(id++),...p,status:'NEW',...extra};orders.set(o.orderId,o);return o};
 const client={mode:'LIVE',
  positionMode:async()=>({dualSidePosition:false}),
  marginType:async()=>({marginType:'CROSSED'}),
  setMarginType:async()=>({}),
  leverage:async()=>({maxLongLeverage:maxLev,maxShortLeverage:maxLev}),
  setLeverage:async(s,side,l)=>({leverage:l}),
  positions:async()=>amt!==0?[{symbol:'SOL-USDT',positionSide:'BOTH',positionAmt:String(amt),avgPrice:String(avg),markPrice:String(mark||avg),unrealizedProfit:String(((mark||avg)-avg)*amt)}]:[],
  openOrders:async()=>({orders:[...orders.values()].filter(o=>o.status==='NEW')}),
  getOrder:async(s,{orderId,clientOrderId})=>({order:[...orders.values()].find(o=>orderId?o.orderId===orderId:o.clientOrderId===clientOrderId)??null}),
  cancelOrder:async(s,oid)=>{calls.push({op:'cancel',oid});const o=orders.get(oid);if(o&&o.status==='NEW')o.status='CANCELED';return {}},
  placeOrder:async(p,{beforeSend}={})=>{
   const reason=beforeSend?.();if(reason)throw Object.assign(Error(reason),{code:'ENTRY_NOT_SENT',reason});
   calls.push({op:'order',...p});
   if(failStop&&p.type==='STOP_MARKET')throw Object.assign(Error('stop rejected'),{code:'VENUE_ERROR_99'});
   if(p.type==='STOP_MARKET'||p.type==='TAKE_PROFIT'||p.type==='TAKE_PROFIT_MARKET'){
    return {order:add(p)};
   }
   if(p.type==='LIMIT'&&p.timeInForce==='IOC'){
    if(!fillAdd)return {order:add(p,{status:'EXPIRED',executedQty:'0'})};
    const q=Number(p.quantity),fillPx=mark||Number(p.price);
    const canFill=p.side==='BUY'?Number(p.price)>=fillPx-1e-9:Number(p.price)<=fillPx+1e-9;
    if(!canFill)return {order:add(p,{status:'EXPIRED',executedQty:'0'})};
    avg=(avg*Math.abs(amt)+fillPx*q)/(Math.abs(amt)+q);amt=+(amt+(p.side==='SELL'?-q:q)).toFixed(8);
    return {order:add(p,{status:'FILLED',executedQty:String(q),avgPrice:String(fillPx)})};
   }
   if(p.type==='MARKET'){
    const q=Number(p.quantity);
    if(p.reduceOnly==='true'){amt=0;return {order:add(p,{status:'FILLED',executedQty:String(q),avgPrice:String(mark||fillAt)})}}
    avg=fillAt;amt=+(amt+(p.side==='SELL'?-q:q)).toFixed(8);
    return {order:add(p,{status:'FILLED',executedQty:String(q),avgPrice:String(fillAt)})};
   }
   return {order:add(p,{status:'CANCELED',executedQty:'0'})};
  },
 };
 return {client,calls,orders,setMark:v=>{mark=v},setPos:(a,p2)=>{amt=a;avg=p2;mark=p2}};
}

function makeLiveExec({v,env={},balance=async()=>({equity:2000,available:1600}),bookOf=async()=>({ok:true,bid:PX-0.01,ask:PX+0.01,mid:PX}),orderflow=null,now=()=>T0,dir=null,onEvent=()=>{}}={}){
 const config=scalpLiveExecConfig({
  SCALP_LIVE_MODE:'LIVE',SCALP_LIVE_CONFIRM:SCALP_LIVE_CONFIRM_TOKEN,
  SCALP_MAKER_ENTRY:'off',SCALP_TREND_MODE:'on',SCALP_ZONE_SIGNALS:'off',
  SCALP_MIN_SCORE:'0',SCALP_BTC_GUARD:'off',SCALP_STOP_LOSS:'off',SCALP_SCALE_IN:'on',
  ...env,
 });
 const candles=async(sym,int)=>int==='5m'?crash():up4h(now());
 const ex=new ScalpExecutor({
  config,client:v.client,
  fileName:'scalp-store-live.json',journalFileName:'scalp-journal-live.jsonl',signalsFileName:'scalp-signals-live.jsonl',
  contracts:async()=>new Map([['SOLUSDT',SOL]]),
  tickers:async()=>[{symbol:'SOL-USDT',lastPrice:String(PX),quoteVolume:'50000000'}],
  candles,trendCandles:async()=>up4h(now()),
  priceOf:async()=>PX,markOf:async()=>PX,bookOf,orderflow,balance,now,
  directory:dir,log:()=>{},onEvent,
 });
 ex.arm();
 return ex;
}

test('scalpLiveExecConfig requires double opt-in while testnet scalpExecConfig keeps refusing LIVE',()=>{
 const off=scalpLiveExecConfig({});
 assert.equal(off.mode,'OFF');assert.equal(off.allowLive,false);assert.equal(off.refused,null);

 const unconfirmed=scalpLiveExecConfig({SCALP_LIVE_MODE:'LIVE'});
 assert.equal(unconfirmed.mode,'OFF');assert.equal(unconfirmed.refused,'LIVE_CONFIRM_REQUIRED');assert.equal(unconfirmed.allowLive,false);

 const live=scalpLiveExecConfig({SCALP_LIVE_MODE:'LIVE',SCALP_LIVE_CONFIRM:SCALP_LIVE_CONFIRM_TOKEN});
 assert.equal(live.mode,'LIVE');assert.equal(live.allowLive,true);
 assert.equal(live.balanceCapUSD,500);
 assert.equal(live.hardStopRoePct,85);
 assert.equal(live.minFreeAccountMarginPct,40);
 assert.equal(live.maxOpen,3);assert.equal(live.maxSameSide,2);
 assert.equal(live.maxSpreadPct,0.25);
 assert.equal(live.preFundingWindowMin,15);assert.equal(live.preFundingExtremePct,0.3);
 assert.equal(live.scaleInMarketFallback,false);assert.equal(live.scaleInRetrySlippagePct,1.1);
 assert.equal(live.pumpAlerts,false);

 // Testnet path contract stays 100% untouched.
 const refusedTestnet=scalpExecConfig({SCALP_EXEC_MODE:'LIVE'});
 assert.equal(refusedTestnet.mode,'OFF');assert.equal(refusedTestnet.refused,'LIVE_REFUSED');
 assert.throws(()=>new ScalpExecutor({config:{...scalpExecConfig({}),mode:'LIVE'}}),/SCALP_TESTNET_ONLY/);
});

test('LIVE exchange-side catastrophic hard STOP_MARKET (-85% ROE): placed on entry, kept in reconcile, updated on scale-in, fails safe if rejected',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'scalp-live-hs-'));
 let clock=T0;
 const events=[];
 const v=liveVenue();
 const ex=makeLiveExec({v,now:()=>clock,dir,onEvent:e=>events.push(e)});
 const st=await ex.scan(clock);
 assert.equal(st.entered,1);
 assert.equal(ex.store.open.length,1);
 const p=ex.store.open[0];
 assert.equal(p.mode,'LIVE');
 assert.ok(p.hardStopOrderId,'hard stop order id saved');
 assert.ok(p.hardStopPrice>0&&p.hardStopPrice<p.avg,'LONG hard stop sits below avg');
 const stopOrders=v.calls.filter(c=>c.op==='order'&&c.type==='STOP_MARKET');
 assert.equal(stopOrders.length,1);
 assert.equal(stopOrders[0].closePosition,'true');
 assert.equal(stopOrders[0].workingType,'MARK_PRICE');
 assert.ok(events.some(e=>e.type==='HARD_STOP_PLACED'&&e.mode==='LIVE'));
 // Separate live ledger files are written, never testnet scalp-store.json.
 assert.equal(fs.existsSync(path.join(dir,'scalp-store-live.json')),true);
 assert.equal(fs.existsSync(path.join(dir,'scalp-store.json')),false);

 // Telegram OPENED notice uses live label and includes exchange hard stop price.
 const openedEvt=events.find(e=>e.type==='OPENED');
 const tg=scalpEventText(openedEvt);
 assert.ok(tg.includes(SCALP_LIVE_LABEL));
 assert.ok(tg.includes('거래소 비상스탑'));

 // Reconcile NEVER retires the hard stop when hardStopRoePct > 0.
 const firstStopId=p.hardStopOrderId;
 clock+=10000;
 await ex.reconcile();
 assert.equal(v.orders.get(firstStopId)?.status,'NEW');

 // Scale-in fill updates avg entry and moves the exchange hard stop to the new avg, cancelling the old stop.
 clock+=I+5000;
 const lowerMark=+(p.avg*0.975).toFixed(2);
 v.setMark(lowerMark);
 await ex.reconcile();
 assert.equal(p.scaleIn.count,1);
 assert.notEqual(p.hardStopOrderId,firstStopId,'hard stop replaced after scale-in');
 assert.ok(p.hardStopPrice<Number(stopOrders[0].stopPrice),'LONG hard stop moved down with lower avg');
 assert.equal(v.orders.get(firstStopId)?.status,'CANCELED','old hard stop canceled after new stop confirmed');
 assert.ok(events.some(e=>e.type==='HARD_STOP_UPDATED'));

 // Fail-safe: if exchange rejects hard stop on entry, immediately emergency-close and disarm.
 const vFail=liveVenue({failStop:true});
 const exFail=makeLiveExec({v:vFail,now:()=>T0});
 const stFail=await exFail.scan(T0);
 assert.equal(stFail.entered,0);
 assert.equal(exFail.armed,false,'disarmed on NO_PROTECTIVE_STOP');
 assert.equal(exFail.store.open.length,0,'emergency closed');
});

test('LIVE execution guards: ACCOUNT_MARGIN_RESERVE, SPREAD_TOO_WIDE, PRE_FUNDING_EXTREME, and bounded IOC scale-in (no MARKET fallback)',async()=>{
 // 1) Real-account free margin < 40% -> ACCOUNT_MARGIN_RESERVE
 const v1=liveVenue();
 const ex1=makeLiveExec({v:v1,balance:async()=>({equity:2000,available:600})}); // 30% free < 40%
 await ex1.scan(T0);
 assert.equal(ex1.store.open.length,0);
 assert.equal(ex1.store.skips.at(-1)?.reason,'ACCOUNT_MARGIN_RESERVE');

 // 2) Wide bid-ask spread > 0.25% -> SPREAD_TOO_WIDE
 const v2=liveVenue();
 const ex2=makeLiveExec({v:v2,bookOf:async()=>({ok:true,bid:PX*0.997,ask:PX*1.003,mid:PX})}); // 0.60% spread
 await ex2.scan(T0);
 assert.equal(ex2.store.open.length,0);
 assert.equal(ex2.store.skips.at(-1)?.reason,'SPREAD_TOO_WIDE');

 // 3) Adverse extreme funding within 15m of settlement -> PRE_FUNDING_EXTREME
 const v3=liveVenue();
 const ex3=makeLiveExec({
  v:v3,
  orderflow:async()=>({ok:true,funding:{ratePct:0.35,nextFundingTime:T0+10*60000}}),
 });
 await ex3.scan(T0);
 assert.equal(ex3.store.open.length,0);
 assert.equal(ex3.store.skips.at(-1)?.reason,'PRE_FUNDING_EXTREME');

 // Favorable funding (negative for LONG) within 15m is ALLOWED.
 const v3b=liveVenue();
 const ex3b=makeLiveExec({
  v:v3b,
  orderflow:async()=>({ok:true,funding:{ratePct:-0.35,nextFundingTime:T0+10*60000}}),
 });
 await ex3b.scan(T0);
 assert.equal(ex3b.store.open.length,1);

 // 4) LIVE scale-in with NOT_FILLED retries IOC with bounded 1.1% slip and NEVER falls back to MARKET.
 let clock=T0;
 const v4=liveVenue({fillAdd:false});
 const ex4=makeLiveExec({v:v4,now:()=>clock});
 await ex4.scan(clock);
 assert.equal(ex4.store.open.length,1);
 const p=ex4.store.open[0];
 clock+=I+5000;
 v4.setMark(+(p.avg*0.975).toFixed(2));
 await ex4.reconcile(); // 1st IOC -> NOT_FILLED
 assert.equal(p.scaleIn.lastReason,'NOT_FILLED');
 clock+=20000;
 await ex4.reconcile(); // 2nd widened IOC -> still NOT_FILLED, NO MARKET fallback on LIVE
 const mktOrders=v4.calls.filter(c=>c.op==='order'&&c.type==='MARKET');
 assert.equal(mktOrders.length,1,'only initial entry was MARKET; scale-in never fell back to MARKET');
});

test('origin:scalp tagging, cachedRows(), #real 단타 badge & pilot panel, and RealTrailingManager skip',async()=>{
 const rows=[
  {symbol:'BTCUSDT',venueSymbol:'BTC-USDT',direction:'LONG',size:0.1,avg:90000,mark:91000,margin:900,leverage:10,marginMode:'CROSSED',unrealized:100,roePct:11.1},
  {symbol:'SOLUSDT',venueSymbol:'SOL-USDT',direction:'LONG',size:2,avg:100,mark:105,margin:20,leverage:10,marginMode:'CROSSED',unrealized:10,roePct:50},
  {symbol:'ETHUSDT',venueSymbol:'ETH-USDT',direction:'SHORT',size:1,avg:3000,mark:2950,margin:300,leverage:10,marginMode:'CROSSED',unrealized:50,roePct:16.7},
 ];
 const tagged=tagOrigins(rows,[{symbol:'BTCUSDT',venueSymbol:'BTC-USDT',direction:'LONG',status:'OPEN'}],[{symbol:'SOLUSDT',venueSymbol:'SOL-USDT',direction:'LONG',status:'OPEN'}]);
 assert.deepEqual(tagged.map(r=>[r.symbol,r.origin]),[['BTCUSDT','copy'],['SOLUSDT','scalp'],['ETHUSDT','manual']]);

 const reader=createVenuePositionsReader({
  read:async()=>[{symbol:'ETH-USDT',positionSide:'BOTH',positionAmt:'-1',avgPrice:'3000',markPrice:'2950',unrealizedProfit:'50',leverage:'10'}],
 });
 await reader.snapshot([],[]);
 assert.equal(reader.cachedRows().length,1);
 assert.equal(reader.cachedRows()[0].symbol,'ETHUSDT');

 // #real venuePositionsHTML renders 단타 badge and count without treating scalp as manual.
 const vpHtml=venuePositionsHTML({mode:'LIVE',venuePositions:tagged,stopChecked:true},[]);
 assert.ok(vpHtml.includes('<span class="vp-badge scalp">단타</span>'));
 assert.ok(vpHtml.includes('단타 1개'));

 // copyHTML shows pilot panel ONLY when liveScalp.mode==='LIVE'.
 const baseCopy={mode:'LIVE',enabled:true,armed:false,positions:[],closed:[],events:[],venuePositions:tagged};
 assert.equal(copyHTML(baseCopy).includes('되돌림 단타 · 실계좌 파일럿'),false);
 const withLiveScalp=copyHTML({...baseCopy,liveScalp:{mode:'LIVE',armed:false,positions:[],settings:{balanceCapUSD:500,hardStopRoePct:85,minFreeAccountMarginPct:40,maxOpen:3,maxSameSide:2,maxSpreadPct:0.25,dailyLossPct:3},stats:{trades:0,todayNetUSD:0}}});
 assert.ok(withLiveScalp.includes('되돌림 단타 · 실계좌 파일럿'));
 assert.ok(withLiveScalp.includes('data-live-scalp-arm'));

 // RealTrailingManager skips origin:'scalp' so it never conflicts with live scalp trailing.
 const actions=[];
 const tm=new RealTrailingManager({executeAction:async a=>{actions.push(a);return {ok:true}}});
 tm.configure({enabled:true,applyToManual:true,applyToCopy:true,partialLockRoePct:15});
 await tm.evaluate([tagged[1]]); // SOLUSDT origin:'scalp' at +50% ROE
 assert.equal(actions.length,0,'RealTrailingManager never acts on origin:scalp');
});
