import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {CopyExecutor,copyConfig} from '../copy_executor.mjs';
import {buildCopyAnalytics} from '../copy_analytics.mjs';
import {ManualLedger} from '../manual_ledger.mjs';
import {copyEventText} from '../copy_telegram.mjs';
import {copyHTML,venuePositionsHTML,analyticsHTML,setAnalyticsOpen,setAnalyticsTab,setCopyPage} from '../public/live_control.js';

function tmpDir(){return fs.mkdtempSync(path.join(os.tmpdir(),'signal-lab-s3-'))}

const OPEN_CARD=(sym='BTCUSDT',price=60000,qty=1,lev=10)=>`🚨 포지션 진입\n종목: ${sym}\n방향: 롱 (LONG)\n레버리지: ${lev}x\n진입가: ${price}\n수량: ${qty}\n마진: ${(price*qty/lev).toFixed(2)} USDT`;
const ADD_CARD=(sym='BTCUSDT',from=1,to=2,price=59500)=>`🔄 포지션 변경\n종목: ${sym}\n방향: 롱 (LONG)\n수량: ${from} → ${to}\n현재가: ${price}`;

function makeClient({posQty=0}={}){
 let qty=posQty,seq=1;
 const orders=[];
 return {
  orders,
  setQty:q=>{qty=q},
  positionMode:async()=>({dualSidePosition:false}),
  positions:async()=>qty>0?[{symbol:'BTC-USDT',positionAmt:String(qty),avgPrice:'60000',markPrice:'60000',unrealizedProfit:'0',positionSide:'BOTH'}]:[],
  leverage:async()=>({maxLongLeverage:100,maxShortLeverage:100}),
  setMarginType:async()=>({}),
  setLeverage:async()=>({}),
  placeOrder:async params=>{
   orders.push(params);
   const q=Number(params.quantity)||0;
   qty+=params.side==='BUY'?q:-q;
   return {order:{orderId:'ord'+(seq++),status:'FILLED',executedQty:String(q),avgPrice:'60000'}};
  },
 };
}

const CONTRACT={symbol:'BTCUSDT',venueSymbol:'BTC-USDT',tickSize:'0.1',quantityStep:'0.001',minQuantityBase:0.001,minNotionalUSDT:2};

test('#4 CopyExecutor defers entries during UPDATING, persists across restart, and replays when fresh & within drift',async()=>{
 const dir=tmpDir();
 let t=1795000000000,updating=true,mark=60000;
 const client=makeClient();
 const cfg=copyConfig({COPY_TRADING:'on',COPY_SIZING:'BALANCE_RATIO',COPY_TRADER_BALANCE_USD:'20000'},'TESTNET');
 const mk=()=>new CopyExecutor({
  directory:dir,fileName:'copy-store.json',config:cfg,client,
  contractOf:async()=>CONTRACT,markOf:async()=>mark,
  balance:async()=>({equity:4000,available:3500}),
  gate:()=>updating?{ok:false,reason:'UPDATING'}:{ok:true},
  now:()=>t,
 });

 const ex1=mk();
 const r1=await ex1.handle({id:'msg-1',date:t,text:OPEN_CARD('BTCUSDT',60000,1,10)});
 assert.equal(r1.ok,false);
 assert.equal(r1.reason,'UPDATING');
 assert.equal(r1.deferred,true);
 assert.equal(ex1.status().deferredEntries,1);
 assert.equal(client.orders.length,0);
 assert.ok(ex1.store.events.some(e=>e.type==='DEFERRED_FOR_UPDATE'));
 assert.match(copyEventText(ex1.store.events.at(-1)),/업데이트 중 신호 대기열 저장/);

 // Simulate restart 15 seconds later with price still within 1.5% drift
 t+=15000;
 updating=false;
 mark=60300; // +0.5% drift
 const ex2=mk();
 assert.equal(ex2.status().deferredEntries,1,'deferred queue survived restart');
 const replay=await ex2.replayDeferred({maxAgeMs:120000,maxDriftPct:1.5});
 assert.equal(replay.replayed,1);
 assert.equal(replay.skipped,0);
 assert.equal(ex2.status().deferredEntries,0);
 assert.equal(client.orders.length,1,'replayed open order sent');
 assert.equal(Object.keys(ex2.store.positions).length,1);
});

test('#4 CopyExecutor skips deferred entries when expired or price drifted beyond limit',async()=>{
 const dir=tmpDir();
 let t=1795000000000,updating=true,mark=60000;
 const client=makeClient();
 const cfg=copyConfig({COPY_TRADING:'on',COPY_SIZING:'BALANCE_RATIO',COPY_TRADER_BALANCE_USD:'20000'},'TESTNET');
 const ex=new CopyExecutor({
  directory:dir,fileName:'copy-store.json',config:cfg,client,
  contractOf:async()=>CONTRACT,markOf:async()=>mark,
  balance:async()=>({equity:4000,available:3500}),
  gate:()=>updating?{ok:false,reason:'UPDATING'}:{ok:true},
  now:()=>t,
 });

 // Queue two messages: one will expire, one will drift > 1.5%
 await ex.handle({id:'exp-1',date:t,text:OPEN_CARD('BTCUSDT',60000,1,10)});
 t+=150000; // 150s later -> expired (> 120s)
 updating=false;
 const rExp=await ex.replayDeferred({maxAgeMs:120000,maxDriftPct:1.5});
 assert.equal(rExp.replayed,0);
 assert.equal(rExp.skipped,1);
 assert.equal(rExp.results[0].reason,'UPDATE_DEFERRED_EXPIRED');
 assert.equal(client.orders.length,0);

 // Now queue a fresh one and move mark +3% before replay
 updating=true;
 await ex.handle({id:'drift-1',date:t,text:OPEN_CARD('BTCUSDT',60000,1,10)});
 t+=10000;
 updating=false;
 mark=61800; // +3.0% drift
 const rDrift=await ex.replayDeferred({maxAgeMs:120000,maxDriftPct:1.5});
 assert.equal(rDrift.replayed,0);
 assert.equal(rDrift.skipped,1);
 assert.equal(rDrift.results[0].reason,'UPDATE_DEFERRED_DRIFT');
 assert.equal(client.orders.length,0);
});

test('#4 CopyExecutor defers add (CHANGE increase) during UPDATING and preserves theirTotal',async()=>{
 const dir=tmpDir();
 let t=1795000000000,updating=false;
 const client=makeClient();
 const cfg=copyConfig({COPY_TRADING:'on',COPY_SIZING:'BALANCE_RATIO',COPY_TRADER_BALANCE_USD:'20000'},'TESTNET');
 const ex=new CopyExecutor({
  directory:dir,fileName:'copy-store.json',config:cfg,client,
  contractOf:async()=>CONTRACT,markOf:async()=>60000,
  balance:async()=>({equity:4000,available:3500}),
  gate:()=>updating?{ok:false,reason:'UPDATING'}:{ok:true},
  now:()=>t,
 });

 await ex.handle({id:'open-1',date:t,text:OPEN_CARD('BTCUSDT',60000,1,10)});
 assert.equal(client.orders.length,1);
 const pos=ex.store.positions['BTCUSDT|LONG'];
 assert.equal(pos.theirTotal,1);

 updating=true;
 t+=5000;
 const rAdd=await ex.handle({id:'add-1',date:t,text:ADD_CARD('BTCUSDT',1,2,60000)});
 assert.equal(rAdd.deferred,true);
 assert.equal(pos.theirTotal,1,'theirTotal preserved until replay');
 assert.equal(client.orders.length,1);

 updating=false;
 t+=10000;
 const rep=await ex.replayDeferred({maxAgeMs:120000,maxDriftPct:1.5});
 assert.equal(rep.replayed,1);
 assert.equal(client.orders.length,2,'deferred add executed');
 assert.equal(pos.theirTotal,2);
 assert.equal(pos.adds,1);
});

test('#12 & #13 buildCopyAnalytics calculates equity curve, MDD, streaks, and symbol/hour/leverage breakdowns',()=>{
 // Timestamps in UTC -> KST (+9h):
 // 2026-11-18T00:30:00Z = 09:30 KST (08-12 아시아장)
 // 2026-11-18T12:30:00Z = 21:30 KST (20-24 미국장)
 // 2026-11-19T11:30:00Z = 20:30 KST (20-24 미국장)
 const t1=Date.parse('2026-11-18T00:30:00Z');
 const t2=Date.parse('2026-11-18T12:30:00Z');
 const t3=Date.parse('2026-11-19T11:30:00Z');
 const copyClosed=[
  {symbol:'BTCUSDT',direction:'LONG',leverage:20,openedAt:t1,closedAt:t1+3600000,netUSD:100,netSource:'EXCHANGE_FILLS'},
  {symbol:'ETHUSDT',direction:'SHORT',leverage:50,openedAt:t2,closedAt:t2+3600000,netUSD:-40,netSource:'EXCHANGE_FILLS'},
  // Unconfirmed estimate should be excluded when confirmedOnly=true
  {symbol:'DOGEUSDT',direction:'LONG',leverage:10,openedAt:t2,closedAt:t2+1800000,netUSD:999,netSource:'ESTIMATE_BEFORE_FEES'},
  // Archived historical close excluded
  {symbol:'SOLUSDT',direction:'LONG',leverage:10,openedAt:t1,closedAt:t1+1000,netUSD:-500,netSource:'EXCHANGE_FILLS',archivedFromHistory:true},
 ];
 const manualClosed=[
  {symbol:'BTCUSDT',direction:'LONG',leverage:10,openedAt:t3,closedAt:t3+3600000,netUSD:-20,netSource:'EXCHANGE'},
  {symbol:'BTCUSDT',direction:'SHORT',leverage:60,openedAt:t3+4000000,closedAt:t3+7200000,netUSD:80,netSource:'EXCHANGE'},
 ];
 const a=buildCopyAnalytics({copyClosed,manualClosed,equityUSD:3080,confirmedOnly:true});
 assert.equal(a.summary.trades,4);
 assert.equal(a.summary.wins,2);
 assert.equal(a.summary.losses,2);
 assert.equal(a.summary.winRatePct,50);
 assert.equal(a.summary.netUSD,120);
 assert.equal(a.summary.avgUSD,30);
 assert.equal(a.summary.avgWinUSD,90);
 assert.equal(a.summary.avgLossUSD,-30);
 assert.equal(a.summary.profitFactor,3);
 // Sequence: +100 (peak 100), -40 (60, dd 40), -20 (40, dd 60), +80 (120) -> MDD = $60
 assert.equal(a.summary.maxDrawdownUSD,60);
 assert.ok(a.summary.maxDrawdownPct>1.5&&a.summary.maxDrawdownPct<2.5);
 assert.equal(a.summary.maxWinStreak,1);
 assert.equal(a.summary.maxLossStreak,2);

 // Equity curve has 2 KST days (2026-11-18 and 2026-11-19)
 assert.equal(a.curve.length,2);
 assert.equal(a.curve[0].day,'2026-11-18');
 assert.equal(a.curve[0].totalUSD,60);
 assert.equal(a.curve[0].copyUSD,60);
 assert.equal(a.curve[0].manualUSD,0);
 assert.equal(a.curve[1].day,'2026-11-19');
 assert.equal(a.curve[1].totalUSD,120);
 assert.equal(a.curve[1].manualUSD,60);

 // By symbol
 assert.equal(a.bySymbol[0].symbol,'BTCUSDT');
 assert.equal(a.bySymbol[0].trades,3);
 assert.equal(a.bySymbol[0].netUSD,160);
 assert.equal(a.bySymbol[1].symbol,'ETHUSDT');
 assert.equal(a.bySymbol[1].netUSD,-40);

 // By KST hour bucket
 const asia=a.byHourKst.find(b=>b.key==='08-12');
 const us=a.byHourKst.find(b=>b.key==='20-24');
 assert.equal(asia.trades,1);
 assert.equal(asia.netUSD,100);
 assert.equal(us.trades,3);

 // By leverage
 assert.equal(a.byLeverage.find(b=>b.key==='1-10').trades,1);
 assert.equal(a.byLeverage.find(b=>b.key==='11-25').trades,1);
 assert.equal(a.byLeverage.find(b=>b.key==='26-50').trades,1);
 assert.equal(a.byLeverage.find(b=>b.key==='51+').trades,1);
});

test('#14 ManualLedger.setTradeNote sanitizes, persists across reload, and rejects missing id',()=>{
 const dir=tmpDir();
 let t=1795000000000;
 const m1=new ManualLedger({directory:dir,now:()=>t});
 m1.store.closed.push({id:'man-1',symbol:'ETHUSDT',direction:'LONG',openedAt:t-60000,closedAt:t,netUSD:25,netSource:'EXCHANGE'});
 const saved=m1.setTradeNote('man-1',{note:'  지지선 확인 후 진입  ',tags:['#추세추종','손절준수','추세추종','  ','t3','t4','t5','t6']});
 assert.equal(saved.ok,true);
 assert.equal(saved.note,'지지선 확인 후 진입');
 assert.deepEqual(saved.tags,['추세추종','손절준수','t3','t4','t5'],'deduped and capped at 5');

 // Reload from disk
 const m2=new ManualLedger({directory:dir,now:()=>t});
 const row=m2.store.closed.find(x=>x.id==='man-1');
 assert.equal(row.note,'지지선 확인 후 진입');
 assert.deepEqual(row.tags,['추세추종','손절준수','t3','t4','t5']);

 assert.throws(()=>m2.setTradeNote('missing-id',{note:'x'}),e=>e.code==='MANUAL_TRADE_NOT_FOUND'&&e.httpStatus===404);
});

test('#10 #12 #13 #14 UI renderers: position quick actions, analytics fold & tabs, and manual trade memos',()=>{
 const now=Date.parse('2026-11-19T12:00:00Z');
 const vp=[
  {symbol:'BTCUSDT',origin:'copy',direction:'LONG',leverage:20,marginMode:'CROSSED',size:0.05,avg:60000,mark:61000,margin:150,unrealized:50,roePct:33.3,liquidation:55000},
  {symbol:'ETHUSDT',origin:'manual',direction:'SHORT',leverage:10,marginMode:'ISOLATED',size:1,avg:3000,mark:3050,margin:300,unrealized:-50,roePct:-16.7,liquidation:3300},
 ];
 const vpHtml=venuePositionsHTML({mode:'LIVE',venuePositions:vp},[]);
 assert.match(vpHtml,/data-pos-action="CLOSE_HALF" data-pos-symbol="BTCUSDT" data-pos-dir="LONG"/);
 assert.match(vpHtml,/data-pos-action="CLOSE_ALL" data-pos-symbol="ETHUSDT" data-pos-dir="SHORT"/);
 // BTCUSDT is in profit -> BREAKEVEN_STOP enabled; ETHUSDT is losing -> BREAKEVEN_STOP disabled
 assert.match(vpHtml,/data-pos-action="BREAKEVEN_STOP" data-pos-symbol="BTCUSDT"[^>]*>본전 스탑/);
 assert.doesNotMatch(vpHtml,/data-pos-action="BREAKEVEN_STOP" data-pos-symbol="BTCUSDT"[^>]*disabled/);
 assert.match(vpHtml,/data-pos-action="BREAKEVEN_STOP" data-pos-symbol="ETHUSDT"[^>]*disabled/);

 // Analytics panel & tabs
 const analytics=buildCopyAnalytics({
  copyClosed:[{symbol:'BTCUSDT',direction:'LONG',leverage:20,openedAt:now-7200000,closedAt:now-3600000,netUSD:50,netSource:'EXCHANGE_FILLS'}],
  manualClosed:[{symbol:'ETHUSDT',direction:'SHORT',leverage:10,openedAt:now-3600000,closedAt:now,netUSD:-15,netSource:'EXCHANGE'}],
  equityUSD:3080,confirmedOnly:true,
 });
 setAnalyticsOpen(true);
 setAnalyticsTab('symbol');
 const anSym=analyticsHTML(analytics);
 assert.match(anSym,/copy-analytics-fold" open/);
 assert.match(anSym,/최대 낙폭 \(MDD\)/);
 assert.match(anSym,/an-line-tot/);
 assert.match(anSym,/BTCUSDT/);

 setAnalyticsTab('hour');
 assert.match(analyticsHTML(analytics),/시간대 \(KST\)/);
 setAnalyticsTab('leverage');
 assert.match(analyticsHTML(analytics),/1~10배/);
 setAnalyticsOpen(false);
 setAnalyticsTab('symbol');

 // Manual memos in copyHTML + deferred queue banner
 setCopyPage(0);
 const html=copyHTML({
  mode:'LIVE',enabled:true,armed:true,deferredEntries:2,
  funds:{equity:3080,available:2500,at:now},
  positions:[],venuePositions:vp,venuePositionsAt:now,
  analytics,
  closed:[{id:'cp-1',symbol:'BTCUSDT',direction:'LONG',openedAt:now-7200000,closedAt:now-3600000,netUSD:50,netSource:'EXCHANGE_FILLS',adds:0}],
  manual:{
   open:[],
   closed:[{id:'man-9',symbol:'ETHUSDT',direction:'SHORT',openedAt:now-3600000,closedAt:now,netUSD:-15,netSource:'EXCHANGE',adds:0,note:'추격 진입 반성',tags:['뇌동매매','손절준수']}],
   closedTotal:1,
  },
 });
 assert.match(html,/업데이트 대기 중인 카피 신호 2건/);
 assert.match(html,/성과 분석 · 수익 곡선 · MDD/);
 assert.match(html,/data-manual-note-id="man-9"/);
 assert.match(html,/#뇌동매매/);
 assert.match(html,/추격 진입 반성/);
 assert.doesNotMatch(html,/data-manual-note-id="cp-1"/,'copy trade rows do not have manual memo buttons');
});
