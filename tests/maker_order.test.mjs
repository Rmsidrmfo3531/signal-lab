import test from 'node:test';
import assert from 'node:assert/strict';
import {makerLimitPrice,placeMakerThenMarket} from '../maker_order.mjs';
import {executeRealManualOrder} from '../real_manual_trade.mjs';
import {ScalpExecutor,scalpExecConfig} from '../scalp_executor.mjs';
import {copyHTML} from '../public/live_control.js';

const noSleep=async()=>{};

test('makerLimitPrice places passive 1-tick inside markPrice on BUY and SELL',()=>{
 assert.equal(makerLimitPrice({side:'BUY',markPrice:100.0,tickSize:'0.1'}),99.9);
 assert.equal(makerLimitPrice({side:'SELL',markPrice:100.0,tickSize:'0.1'}),100.1);
 assert.equal(makerLimitPrice({side:'BUY',markPrice:100.04,tickSize:'0.1'}),100);
 assert.equal(makerLimitPrice({side:'SELL',markPrice:100.04,tickSize:'0.1'}),100.1);
});

test('placeMakerThenMarket fills fully as MAKER when PostOnly limit executes',async()=>{
 const placed=[];
 const client={
  placeOrder:async p=>{placed.push(p);return {order:{orderId:'mk1',status:'FILLED',executedQty:p.quantity,avgPrice:p.price}}},
  getOrder:async()=>({order:{orderId:'mk1',status:'FILLED',executedQty:'1',avgPrice:'99.9'}}),
  cancelOrder:async()=>{throw Error('should not cancel filled order')},
 };
 const r=await placeMakerThenMarket({
  client,symbol:'BTC-USDT',side:'BUY',positionSide:'BOTH',quantity:1,
  quantityStep:'0.001',minQuantity:0.001,tickSize:'0.1',markPrice:100,
  clientOrderId:'c1',waitMs:100,pollMs:20,sleep:noSleep,
 });
 assert.equal(r.executionMode,'MAKER');
 assert.equal(placed.length,1);
 assert.equal(placed[0].type,'LIMIT');
 assert.equal(placed[0].timeInForce,'PostOnly');
 assert.equal(placed[0].price,'99.9');
});

test('placeMakerThenMarket cancels partial PostOnly and sends MARKET strictly for remaining qty (HYBRID)',async()=>{
 const placed=[],canceled=[];
 const client={
  placeOrder:async p=>{
   placed.push(p);
   if(p.type==='LIMIT')return {order:{orderId:'mk2',status:'NEW',executedQty:'0',avgPrice:'0'}};
   return {order:{orderId:'mkt2',status:'FILLED',executedQty:p.quantity,avgPrice:'100.1'}};
  },
  // PARTIALLY_FILLED while resting; CANCELED (0.4 filled) once the cancel went through.
  getOrder:async()=>({order:{orderId:'mk2',status:canceled.length?'CANCELED':'PARTIALLY_FILLED',executedQty:'0.4',avgPrice:'99.9'}}),
  cancelOrder:async(sym,id)=>{canceled.push([sym,id]);return {}},
 };
 const r=await placeMakerThenMarket({
  client,symbol:'BTC-USDT',side:'BUY',positionSide:'BOTH',quantity:1,
  quantityStep:'0.001',minQuantity:0.001,tickSize:'0.1',markPrice:100,
  clientOrderId:'c2',waitMs:40,pollMs:20,sleep:noSleep,
 });
 assert.equal(r.executionMode,'HYBRID');
 assert.equal(canceled.length,1);
 assert.equal(placed.length,2);
 assert.equal(placed[0].type,'LIMIT');
 assert.equal(placed[1].type,'MARKET');
 assert.equal(placed[1].quantity,'0.6');
 assert.equal(r.makerQty,0.4);
 assert.equal(r.marketQty,0.6);
});

test('placeMakerThenMarket falls back immediately to MARKET when PostOnly is rejected',async()=>{
 const placed=[];
 const client={
  placeOrder:async p=>{
   placed.push(p);
   if(p.type==='LIMIT')throw Object.assign(Error('PostOnly order would match immediately'),{code:'VENUE_ERROR_101415'});
   return {order:{orderId:'mkt3',status:'FILLED',executedQty:p.quantity,avgPrice:'100.0'}};
  },
  getOrder:async()=>null,
  cancelOrder:async()=>({}),
 };
 const r=await placeMakerThenMarket({
  client,symbol:'ETH-USDT',side:'SELL',positionSide:'SHORT',quantity:2,
  quantityStep:'0.01',minQuantity:0.01,tickSize:'0.01',markPrice:2500,hedge:true,
  clientOrderId:'c3',waitMs:100,pollMs:20,sleep:noSleep,
 });
 assert.equal(r.executionMode,'MARKET');
 assert.equal(placed.length,2);
 assert.equal(placed[0].timeInForce,'PostOnly');
 assert.equal(placed[1].type,'MARKET');
 assert.equal(placed[1].quantity,'2');
});

test('executeRealManualOrder uses makerFirst PostOnly when requested and reports maker execution',async()=>{
 const placed=[];
 const client={
  mode:'LIVE',
  positionMode:async()=>({dualSidePosition:'false'}),
  balance:async()=>[{asset:'USDT',equity:'3000',availableMargin:'2500'}],
  leverage:async()=>({maxLongLeverage:100,maxShortLeverage:100}),
  setLeverage:async()=>({}),
  placeOrder:async p=>{placed.push(p);return {order:{orderId:'manmk1',status:'FILLED',executedQty:p.quantity,avgPrice:p.price}}},
  getOrder:async()=>({order:{orderId:'manmk1',status:'FILLED',executedQty:'0.01',avgPrice:'99999.9'}}),
  cancelOrder:async()=>({}),
 };
 const res=await executeRealManualOrder({
  confirm:'REAL_MANUAL_ORDER',symbol:'BTC',side:'LONG',orderType:'MARKET',makerFirst:true,makerWaitMs:50,sleep:noSleep,
  amountMode:'MARGIN_USDT',amount:100,leverage:10,marginMode:'CROSSED',
  client,
  contractsFor:async()=>new Map([['BTCUSDT',{symbol:'BTCUSDT',venueSymbol:'BTC-USDT',tickSize:'0.1',quantityStep:'0.001',minQuantityBase:0.001,minNotionalUSDT:5,tradable:true}]]),
  markOf:async()=>100000,
 });
 assert.equal(res.ok,true);
 assert.equal(res.executionMode,'MAKER');
 assert.match(res.summary,/메이커 지정가 체결/);
 assert.equal(placed[0].type,'LIMIT');
 assert.equal(placed[0].timeInForce,'PostOnly');
});

test('unprotected testnet scalp enforces -75% catastrophe ROE cut, -40% defensive 1st add, and 4h underwater max-hold exit',async()=>{
 const cfg=scalpExecConfig({});
 assert.equal(cfg.profitOnlyMaxHoldMin,240);
 assert.equal(cfg.emergencyStopRoePct,75);
 assert.equal(cfg.defensiveAddRoePct,40);
 assert.equal(cfg.scoreTierSizing,true);
 assert.equal(cfg.maxScaleInAdds,2);
 assert.equal(cfg.scanGapMs,120);

 const runCase=async({mark,advanceMs,expectedReason})=>{
  let openSize=10,now=1795000000000;
  const closedOrders=[];
  const client={
   mode:'TESTNET',
   positions:async()=>openSize>0?[{symbol:'AKE-USDT',positionSide:'BOTH',positionAmt:String(openSize),avgPrice:'1.00',markPrice:String(mark),unrealizedProfit:String((mark-1)*openSize),initialMargin:'1'}]:[],
   openOrders:async()=>[],
   balance:async()=>[{asset:'VST',equity:'3000',availableMargin:'2900'}],
   placeOrder:async p=>{closedOrders.push(p);if(p.type==='MARKET'){openSize=0}return {order:{orderId:'cl1',status:'FILLED',executedQty:p.quantity,avgPrice:String(mark)}}},
   cancelOrder:async()=>({}),
   getOrder:async()=>({order:{orderId:'cl1',status:'FILLED',executedQty:'10',avgPrice:String(mark)}}),
   income:async()=>[],
  };
  const ex=new ScalpExecutor({
   now:()=>now,
   config:{...cfg,mode:'TESTNET',stopLossEnabled:false,scaleIn:true},
   client,
   contracts:async()=>new Map([['AKEUSDT',{symbol:'AKEUSDT',venueSymbol:'AKE-USDT',tickSize:'0.001',quantityStep:'1',minQuantityBase:1,minNotionalUSDT:2,tradable:true}]]),
  });
  ex.store.open.push({
   id:'t1',symbol:'AKEUSDT',venueSymbol:'AKE-USDT',direction:'LONG',hedge:false,leverage:10,
   tickSize:'0.001',quantityStep:'1',takerRate:0.0005,status:'OPEN',openedAt:now,createdAt:now,
   entry:1.0,avg:1.0,firstEntryPrice:1.0,initialStop:0.98,stop:0.98,size:10,filled:10,initialQty:10,
   parts:[4,3,3],tpOrderIds:[null,null,null],targets:[1.02,1.03,1.04],tpDone:[false,false,false],
   stopOrderId:null,stopIds:[],exitIds:[],steps:[{kind:'OPEN',at:now,qty:10,avg:1.0}],
  });
  now+=advanceMs;
  await ex.reconcile();
  assert.equal(openSize,0,`expected position to close via ${expectedReason}`);
  assert.equal(ex.store.closed[0]?.closeReason,expectedReason);
  assert.equal(closedOrders.some(o=>o.type==='MARKET'),true);
 };

 // 1) -78% ROE (-7.8% drop at 10x) -> immediate catastrophe EMERGENCY_ROE_STOP (prevents liquidation)
 await runCase({mark:0.922,advanceMs:10*60000,expectedReason:'EMERGENCY_ROE_STOP'});
 // 2) Underwater (-5% ROE) held for 8h -> MAX_HOLD_EXIT
 await runCase({mark:0.995,advanceMs:481*60000,expectedReason:'MAX_HOLD_EXIT'});
});

test('real-account open position cards show no-SL warning badge and one-click -15% SL button for unprotected manual positions',()=>{
 const html=copyHTML({
  mode:'LIVE',enabled:true,armed:true,funds:{equity:3034,available:2500},
  positions:[],closed:[],events:[],
  venuePositions:[
   {symbol:'ORCAUSDT',venueSymbol:'ORCA-USDT',direction:'LONG',origin:'manual',leverage:3,marginMode:'CROSSED',size:100,avg:1.227,mark:1.14,unrealized:-8.7,roePct:-21.3,margin:40.9,stop:null,stopChecked:true},
   {symbol:'AKEUSDT',venueSymbol:'AKE-USDT',direction:'SHORT',origin:'manual',leverage:5,marginMode:'CROSSED',size:500,avg:0.02,mark:0.019,unrealized:0.5,roePct:25,margin:2,stop:0.021,stopChecked:true},
  ],
 });
 assert.match(html,/⚠ 손절 없음/);
 assert.match(html,/data-pos-action="SET_STOP_LOSS"/);
 assert.match(html,/🛡 -15% 손절/);
 assert.match(html,/🛡 손절 0\.021/);
});

test('A-4: placeMakerThenMarket accepts terminal CANCELED response directly from cancelOrder when getOrder lags',async()=>{
 const placed=[];
 const client={
  placeOrder:async p=>{
   placed.push(p);
   if(p.type==='LIMIT')return {order:{orderId:'mk-lag',status:'NEW',executedQty:'0',avgPrice:'0'}};
   return {order:{orderId:'mkt-lag',status:'FILLED',executedQty:p.quantity,avgPrice:'100.0'}};
  },
  getOrder:async()=>({order:{orderId:'mk-lag',status:'NEW',executedQty:'0'}}), // lagging getOrder
  cancelOrder:async()=>({order:{orderId:'mk-lag',status:'CANCELED',executedQty:'0',avgPrice:'0'}}), // BingX DELETE returns terminal state
 };
 const r=await placeMakerThenMarket({
  client,symbol:'SOL-USDT',side:'BUY',positionSide:'BOTH',quantity:1,
  quantityStep:'0.01',minQuantity:0.01,tickSize:'0.01',markPrice:100,
  clientOrderId:'c-lag',waitMs:20,pollMs:10,sleep:noSleep,
 });
 assert.equal(r.executionMode,'MARKET');
 assert.equal(placed.length,2);
 assert.equal(placed[1].type,'MARKET');
 assert.equal(placed[1].quantity,'1');
});

