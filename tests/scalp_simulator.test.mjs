import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {ScalpExecutor,scalpExecConfig} from '../scalp_executor.mjs';
import {appendJsonl,signalsPath,SCALP_SIGNALS_FILE} from '../scalp_journal.mjs';
import {simulateScalpSignals,normalizeSimParams} from '../scalp_simulator.mjs';
import {scalpDetailsHTML,scalpSimResultHTML,setScalpSimOpen} from '../public/live_control.js';

function tmpDir(){return fs.mkdtempSync(path.join(os.tmpdir(),'signal-lab-s4-'))}

test('#15a ScalpExecutor auto-recovers VENUE_ERROR_110401 on profit-only TAKE_PROFIT via profitable reduce-only LIMIT',async()=>{
 const dir=tmpDir();
 const now=Date.parse('2026-11-20T03:00:00Z');
 const placed=[];
 let seq=1;
 const client={
  mode:'TESTNET',
  positions:async()=>[{symbol:'IRYS-USDT',positionAmt:'100',avgPrice:'0.0500',markPrice:'0.0495',unrealizedProfit:'-0.05',positionSide:'BOTH'}],
  openOrders:async()=>[],
  getOrder:async()=>{throw Object.assign(Error('order not exist'),{code:'VENUE_ERROR_80016'})},
  placeOrder:async params=>{
   placed.push(params);
   if(params.type==='TAKE_PROFIT'){
    throw Object.assign(Error('trigger price invalid 110401'),{code:'VENUE_ERROR_110401'});
   }
   return {order:{orderId:'rec-'+(seq++),status:'NEW'}};
  },
  cancelOrder:async()=>({}),
  balance:async()=>({equity:'1000',availableMargin:'900'}),
 };
 const contracts=async()=>new Map([['IRYSUSDT',{symbol:'IRYSUSDT',venueSymbol:'IRYS-USDT',tickSize:'0.0001',quantityStep:'1',minQuantityBase:1,minNotionalUSDT:2,tradable:true}]]);
 const ex=new ScalpExecutor({
  directory:dir,
  config:scalpExecConfig({SCALP_EXEC_MODE:'TESTNET',SCALP_STOP_LOSS:'off'}),
  client,contracts,
  priceOf:async()=>0.0505,
  markOf:async()=>0.0505,
  balance:async()=>({equity:1000,available:900}),
  now:()=>now,
 });
 // Seed an open position missing its TP orders (as happens after entry/add when 110401 fired)
 ex.store.open.push({
  id:'sc-irys-1',strategy:'SCALP_REVERSAL',kind:'MOVE_REVERSAL',mode:'TESTNET',venue:'BINGX',
  symbol:'IRYSUSDT',venueSymbol:'IRYS-USDT',direction:'LONG',hedge:false,interval:'5m',
  barAt:now-600000,openedAt:now-300000,createdAt:now-300000,deadline:now+3600000,
  entry:0.05,avg:0.05,firstEntryPrice:0.05,mark:0.0495,stop:0.045,initialStop:0.045,
  targets:[0.0515,0.0525,0.0535],qty:100,filled:100,size:100,parts:[40,35,25],
  leverage:10,riskUSD:5,marginUSD:0.5,tickSize:'0.0001',quantityStep:'1',takerRate:0.0006,
  status:'OPEN',stopLossEnabled:false,stopRetired:true,profitTargetsReady:true,
  stopOrderId:null,stopIds:[],tpOrderIds:[null,null,null],tpTries:[0,0,0],tpDone:[false,false,false],
  exitIds:[],steps:[{kind:'OPEN',at:now-300000,qty:100,avg:0.05}],
 });

 await ex.reconcile();

 const p=ex.store.open[0];
 assert.equal(p.tpOrderIds.filter(Boolean).length,3,'all 3 targets recovered and saved');
 const limitOrders=placed.filter(o=>o.type==='LIMIT');
 assert.equal(limitOrders.length,3,'recovered via reduce-only profitable LIMIT');
 for(const o of limitOrders){
  assert.equal(o.side,'SELL');
  assert.equal(o.reduceOnly,'true');
  assert.ok(Number(o.price)>0.05,'limit price strictly profitable above avg');
 }
 const recoveredEvents=ex.store.events.filter(e=>e.type==='TARGET_RECOVERED');
 assert.equal(recoveredEvents.length,3);
 const failedEvents=ex.store.events.filter(e=>e.type==='TARGET_FAILED');
 assert.equal(failedEvents.length,0,'no TARGET_FAILED once recovered');
});

test('#15a ScalpExecutor auto-recovers VENUE_ERROR_110401 on stop-loss TAKE_PROFIT_MARKET when mark crosses stale stopPrice',async()=>{
 const dir=tmpDir();
 const now=Date.parse('2026-11-20T03:00:00Z');
 const placed=[];
 let seq=1,liveMark=102.5;
 const client={
  mode:'TESTNET',
  positions:async()=>[{symbol:'SOL-USDT',positionAmt:'10',avgPrice:'100',markPrice:'101',unrealizedProfit:'10',positionSide:'BOTH'}],
  openOrders:async()=>[{orderId:'stop-1',type:'STOP_MARKET',side:'SELL',positionSide:'BOTH',stopPrice:'95'}],
  getOrder:async()=>{throw Object.assign(Error('order not exist'),{code:'VENUE_ERROR_80016'})},
  placeOrder:async params=>{
   placed.push(params);
   if(params.type==='TAKE_PROFIT_MARKET'&&Number(params.stopPrice)<=liveMark){
    throw Object.assign(Error('stopPrice must be > markPrice 110401'),{code:'VENUE_ERROR_110401'});
   }
   return {order:{orderId:'tp-'+(seq++),status:'NEW'}};
  },
  cancelOrder:async()=>({}),
  balance:async()=>({equity:'1000',availableMargin:'900'}),
 };
 const contracts=async()=>new Map([['SOLUSDT',{symbol:'SOLUSDT',venueSymbol:'SOL-USDT',tickSize:'0.1',quantityStep:'1',minQuantityBase:1,minNotionalUSDT:2,tradable:true}]]);
 const ex=new ScalpExecutor({
  directory:dir,
  config:scalpExecConfig({SCALP_EXEC_MODE:'TESTNET',SCALP_STOP_LOSS:'on'}),
  client,contracts,
  priceOf:async()=>liveMark,
  markOf:async()=>liveMark,
  balance:async()=>({equity:1000,available:900}),
  now:()=>now,
 });
 ex.store.open.push({
  id:'sc-sol-1',strategy:'SCALP_REVERSAL',kind:'MOVE_REVERSAL',mode:'TESTNET',venue:'BINGX',
  symbol:'SOLUSDT',venueSymbol:'SOL-USDT',direction:'LONG',hedge:false,interval:'5m',
  barAt:now-600000,openedAt:now-300000,createdAt:now-300000,deadline:now+3600000,
  entry:100,avg:100,firstEntryPrice:100,mark:101,stop:95,initialStop:95,
  targets:[102.0,104.0,106.0],qty:10,filled:10,size:10,parts:[4,3,3],
  leverage:10,riskUSD:50,marginUSD:100,tickSize:'0.1',quantityStep:'1',takerRate:0.0006,
  status:'OPEN',stopLossEnabled:true,stopOrderId:'stop-1',stopIds:['stop-1'],
  tpOrderIds:[null,null,null],tpTries:[0,0,0],tpDone:[false,false,false],
  exitIds:[],steps:[{kind:'OPEN',at:now-300000,qty:10,avg:100}],
 });

 await ex.reconcile();

 const p=ex.store.open[0];
 assert.equal(p.tpOrderIds.filter(Boolean).length,3,'TP1 recovered past liveMark and TP2/TP3 placed');
 const tp1Success=placed.find(o=>o.type==='TAKE_PROFIT_MARKET'&&o.quantity==='4'&&Number(o.stopPrice)>liveMark);
 assert.ok(tp1Success,'TP1 retried with stopPrice strictly above liveMark (102.7)');
 assert.equal(ex.store.events.filter(e=>e.type==='TARGET_RECOVERED').length,1);
 assert.equal(ex.store.events.filter(e=>e.type==='TARGET_FAILED').length,0);
});

test('#15b simulateScalpSignals evaluates filters, unlocked candidates, trade PnL impact, and 5 presets',()=>{
 const now=Date.parse('2026-11-20T06:00:00Z');
 const signals=[
  // Entered 6% move with trend -> win +$12
  {at:now-100000,barAt:now-120000,symbol:'AUSDT',direction:'LONG',kind:'MOVE_REVERSAL',entered:true,reason:null,evidence:{movePct:6.2},withTrend:true,plan:{netRR:1.3}},
  // Entered 3.1% zone reversal -> loss -$8
  {at:now-200000,barAt:now-220000,symbol:'BUSDT',direction:'SHORT',kind:'ZONE_REVERSAL',entered:true,reason:null,evidence:{movePct:3.1},withTrend:true,zone:{atZone:true},plan:{netRR:0.75}},
  // Skipped because against 4H trend (5.5% move)
  {at:now-300000,barAt:now-320000,symbol:'CUSDT',direction:'LONG',kind:'MOVE_REVERSAL',entered:false,reason:'AGAINST_4H_TREND',evidence:{movePct:5.5},withTrend:false,plan:{netRR:1.2}},
  // Skipped because zone not touched at 4.3% move (would unlock at minMovePct=4%)
  {at:now-400000,barAt:now-420000,symbol:'DUSDT',direction:'LONG',kind:'ZONE_REVERSAL',entered:false,reason:'ZONE_NOT_TOUCHED',evidence:{movePct:4.3},withTrend:true,zone:{atZone:false},plan:{netRR:1.1}},
  // Skipped because RR < 1 (0.8)
  {at:now-500000,barAt:now-520000,symbol:'EUSDT',direction:'SHORT',kind:'MOVE_REVERSAL',entered:false,reason:'TP1_NET_RR_BELOW_MINIMUM',evidence:{movePct:5.2},withTrend:true,plan:{netRR:0.8}},
  // Old signal outside 7-day window -> excluded
  {at:now-10*86400000,barAt:now-10*86400000,symbol:'OLDUSDT',direction:'LONG',kind:'MOVE_REVERSAL',entered:true,reason:null,evidence:{movePct:7.0},withTrend:true,plan:{netRR:1.5}},
 ];
 const trades=[
  {symbol:'AUSDT',direction:'LONG',barAt:now-120000,kind:'MOVE_REVERSAL',evidence:{movePct:6.2},withTrend:true,plan:{tp1NetR:1.3},exit:{at:now-50000},pnl:{netUSD:12,r:1.2}},
  {symbol:'BUSDT',direction:'SHORT',barAt:now-220000,kind:'ZONE_REVERSAL',evidence:{movePct:3.1},withTrend:true,zone:{atZone:true},plan:{tp1NetR:0.75},exit:{at:now-150000},pnl:{netUSD:-8,r:-0.8}},
 ];

 // Default current: 5%, trend on, zone on, minNetRR=0 -> keeps both trades, unlocks EUSDT (RR=0.8)
 const cur=simulateScalpSignals({signals,trades,params:{days:7,minMovePct:5,trendMode:'on',zoneSignals:true,minNetRR:0},now});
 assert.equal(cur.signalSummary.totalSignals,5,'old 10d signal excluded');
 assert.equal(cur.baseline.trades,2);
 assert.equal(cur.baseline.netUSD,4);
 assert.equal(cur.simulated.trades,2);
 assert.equal(cur.simulated.unlockedSignals,1);
 assert.equal(cur.simulated.unlockedByReason.TP1_NET_RR_BELOW_MINIMUM,1);
 assert.equal(cur.presets.length,5);

 // Turning zoneSignals OFF removes losing BUSDT trade (-$8), raising simulated net to +$12!
 const zoneOff=simulateScalpSignals({signals,trades,params:{days:7,minMovePct:5,trendMode:'on',zoneSignals:false,minNetRR:0},now,includePresets:false});
 assert.equal(zoneOff.simulated.trades,1);
 assert.equal(zoneOff.simulated.netUSD,12);
 assert.equal(zoneOff.simulated.removedTrades,1);
 assert.equal(zoneOff.simulated.removedNetUSD,-8);

 // Relaxing minMovePct to 4% unlocks DUSDT (4.3%) as well as EUSDT
 const move4=simulateScalpSignals({signals,trades,params:{days:7,minMovePct:4,trendMode:'on',zoneSignals:true,minNetRR:0},now,includePresets:false});
 assert.equal(move4.simulated.unlockedSignals,2);
 assert.equal(move4.simulated.unlockedByReason.ZONE_NOT_TOUCHED,1);

 // Turning trendMode OFF unlocks CUSDT (AGAINST_4H_TREND)
 const trendOff=simulateScalpSignals({signals,trades,params:{days:7,minMovePct:5,trendMode:'off',zoneSignals:true,minNetRR:0},now,includePresets:false});
 assert.equal(trendOff.simulated.unlockedByReason.AGAINST_4H_TREND,1);

 // Clamping check
 const clamped=normalizeSimParams({days:999,minMovePct:0.5,minNetRR:99,sides:'INVALID'});
 assert.equal(clamped.days,30);
 assert.equal(clamped.minMovePct,2.5);
 assert.equal(clamped.minNetRR,3);
 assert.deepEqual(clamped.sides,['LONG','SHORT']);
});

test('#15b ScalpExecutor.recentSignals reads multi-day KST signal logs and UI renders simulator cleanly',()=>{
 const dir=tmpDir();
 const now=Date.parse('2026-11-20T06:00:00Z');
 const base=path.join(dir,SCALP_SIGNALS_FILE);
 appendJsonl(signalsPath(base,now-2*86400000),{at:now-2*86400000,symbol:'DAY2USDT',direction:'LONG',barAt:now-2*86400000,entered:false,reason:'AGAINST_4H_TREND'});
 appendJsonl(signalsPath(base,now),{at:now-1000,symbol:'TODAYUSDT',direction:'SHORT',barAt:now-1000,entered:true,reason:null});

 const ex=new ScalpExecutor({directory:dir,config:scalpExecConfig({SCALP_EXEC_MODE:'TESTNET'}),now:()=>now});
 const list=ex.recentSignals(5);
 assert.equal(list.length,2);
 assert.deepEqual(list.map(x=>x.symbol),['DAY2USDT','TODAYUSDT']);

 setScalpSimOpen(true);
 const detHtml=scalpDetailsHTML(ex.status());
 assert.match(detHtml,/scalp-sim-fold" open/);
 assert.match(detHtml,/단타 조건 시뮬레이터 \(What-If\)/);
 assert.match(detHtml,/data-scalp-sim-form/);
 setScalpSimOpen(false);

 const simData=simulateScalpSignals({signals:list,trades:[],params:{days:7},now});
 const resHtml=scalpSimResultHTML(simData);
 assert.match(resHtml,/조건 프리셋/);
 assert.match(resHtml,/급변 4% 완화/);
 assert.match(resHtml,/4H 역추세 포함/);
});
