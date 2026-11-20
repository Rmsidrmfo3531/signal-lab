import test from 'node:test';
import assert from 'node:assert/strict';
import {
 normalizeManualSymbol,planRealManualOrder,lookupRealTradeSymbol,
 executeRealManualOrder,listRealOpenOrders,cancelRealOpenOrder,
} from '../real_manual_trade.mjs';
import {computeOrderPreview,realTradePanelHTML} from '../public/real_trade.js';
import {venuePositionsHTML} from '../public/live_control.js';

const AKE={symbol:'AKEUSDT',venueSymbol:'AKE-USDT',tickSize:'0.000001',quantityStep:'10',minQuantityBase:'10',minNotionalUSDT:2,unitMultiplier:1};
const PEPE={symbol:'PEPEUSDT',venueSymbol:'1000PEPE-USDT',tickSize:'0.00001',quantityStep:'1',minQuantityBase:'1',minNotionalUSDT:2,unitMultiplier:1000};

test('planRealManualOrder calculates MARGIN_USDT, NOTIONAL_USDT, COIN modes, unitMultiplier, and TP/SL validation',()=>{
 // Margin mode: $50 margin * 10x = $500 notional / 0.005 = 100,000 AKE
 const p1=planRealManualOrder({
  side:'LONG',orderType:'MARKET',amountMode:'MARGIN_USDT',amount:50,leverage:10,marginMode:'CROSSED',
  tpPrice:0.006,slPrice:0.0045,contract:AKE,markPrice:0.005,availableUSD:1000,maxLeverage:20,
 });
 assert.equal(p1.qty,100000);
 assert.equal(p1.notionalUSD,500);
 assert.equal(p1.marginUSD,50);
 assert.equal(p1.tpPrice,0.006);
 assert.equal(p1.slPrice,0.0045);

 // Notional mode + LIMIT order
 const p2=planRealManualOrder({
  side:'SHORT',orderType:'LIMIT',amountMode:'NOTIONAL_USDT',amount:200,price:0.0055,leverage:5,marginMode:'ISOLATED',
  tpPrice:0.005,slPrice:0.006,contract:AKE,markPrice:0.005,availableUSD:1000,maxLeverage:20,
 });
 assert.equal(p2.orderType,'LIMIT');
 assert.equal(p2.limitPrice,0.0055);
 assert.equal(p2.qty,36360); // floor(200 / 0.0055 = 36363.63 -> step 10)
 assert.equal(p2.marginUSD,+(36360*0.0055/5).toFixed(2));

 // Coin quantity mode (direct venue units: 500 * $0.01 = $5 notional, $0.50 margin)
 const p3=planRealManualOrder({
  side:'LONG',orderType:'MARKET',amountMode:'COIN',amount:500,leverage:10,
  contract:PEPE,markPrice:0.01,availableUSD:1000,
 });
 assert.equal(p3.qty,500);
 assert.equal(p3.notionalUSD,5);
 assert.equal(p3.marginUSD,0.5);

 // Validation errors: invalid TP direction, below min notional, margin short
 assert.throws(()=>planRealManualOrder({side:'LONG',orderType:'MARKET',amountMode:'MARGIN_USDT',amount:10,leverage:5,tpPrice:0.004,contract:AKE,markPrice:0.005,availableUSD:500}),/높아야/);
 assert.throws(()=>planRealManualOrder({side:'SHORT',orderType:'MARKET',amountMode:'MARGIN_USDT',amount:10,leverage:5,slPrice:0.004,contract:AKE,markPrice:0.005,availableUSD:500}),/높아야/);
 assert.throws(()=>planRealManualOrder({side:'LONG',orderType:'MARKET',amountMode:'MARGIN_USDT',amount:0.1,leverage:5,contract:AKE,markPrice:0.005,availableUSD:500}),/최소 금액/);
 assert.throws(()=>planRealManualOrder({side:'LONG',orderType:'MARKET',amountMode:'MARGIN_USDT',amount:500,leverage:5,contract:AKE,markPrice:0.005,availableUSD:100}),/가용 증거금/);
 assert.equal(normalizeManualSymbol('ake'),'AKEUSDT');
 assert.equal(normalizeManualSymbol('BTC-USDT'),'BTCUSDT');
});

test('executeRealManualOrder enforces confirmation, sets margin/leverage, submits market/limit with TP/SL, and allows adding to copy-held symbols',async()=>{
 const calls=[];
 const client={
  mode:'LIVE',
  positionMode:async()=>({dualSidePosition:true}),
  balance:async()=>[{asset:'USDT',equity:'3000',availableMargin:'2500'}],
  leverage:async()=>({maxLongLeverage:20,maxShortLeverage:20,longLeverage:7,shortLeverage:7}),
  marginType:async()=>({marginType:'CROSSED'}),
  setMarginType:async(s,m)=>{calls.push({op:'marginType',s,m});return {}},
  setLeverage:async(s,side,lev)=>{calls.push({op:'leverage',s,side,lev});return {}},
  placeOrder:async p=>{calls.push({op:'order',p});return {order:{orderId:'99123456'}}},
  openOrders:async()=>({orders:[
   {orderId:'111',symbol:'NCSKSNDK2USD-USDT',side:'BUY',positionSide:'LONG',type:'LIMIT',price:'100',origQty:'2',time:2000},
   {orderId:'222',symbol:'AKE-USDT',side:'SELL',positionSide:'LONG',type:'STOP_MARKET',stopPrice:'0.004',origQty:'2000',reduceOnly:true,time:1000},
  ]}),
  cancelOrder:async(s,id)=>{calls.push({op:'cancel',s,id});return {}},
 };
 const contractsFor=async()=>new Map([['AKEUSDT',AKE]]);

 // Missing confirm rejected
 await assert.rejects(()=>executeRealManualOrder({
  confirm:'WRONG',symbol:'AKE',side:'LONG',orderType:'MARKET',amountMode:'MARGIN_USDT',amount:20,leverage:7,
  client,contractsFor,markOf:async()=>0.005,
 }),/확인 문구/);

 // Lookup detects open copy position without blocking manual order
 const info=await lookupRealTradeSymbol({
  rawSymbol:'ake',client,contractsFor,markOf:async()=>0.005,availableUSD:2500,
  copyPositions:[{symbol:'AKEUSDT',status:'OPEN',direction:'LONG',qty:360,leverage:7}],
 });
 assert.equal(info.displaySymbol,'AKEUSDT');
 assert.equal(info.copyHolding.length,1);
 assert.equal(info.maxLeverage.long,20);

 // Execute LIMIT order with ISOLATED margin switch + TP + SL on copy-held symbol (allowed!)
 const res=await executeRealManualOrder({
  confirm:'REAL_MANUAL_ORDER',symbol:'ake',side:'LONG',orderType:'LIMIT',amountMode:'MARGIN_USDT',
  amount:50,price:0.005,leverage:7,marginMode:'ISOLATED',tpPrice:0.006,slPrice:0.0045,
  client,contractsFor,markOf:async()=>0.0052,
 });
 assert.equal(res.ok,true);
 assert.equal(res.orderId,'99123456');
 assert.equal(calls[0].op,'marginType');assert.equal(calls[0].m,'ISOLATED');
 assert.equal(calls[1].op,'leverage');assert.equal(calls[1].side,'LONG');assert.equal(calls[1].lev,7);
 assert.equal(calls[2].op,'order');
 assert.equal(calls[2].p.type,'LIMIT');
 assert.equal(calls[2].p.price,'0.005');
 assert.equal(calls[2].p.positionSide,'LONG');
 assert.equal(JSON.parse(calls[2].p.takeProfit).stopPrice,0.006);
 assert.equal(JSON.parse(calls[2].p.stopLoss).stopPrice,0.0045);

 // Open orders & cancel
 const orders=await listRealOpenOrders({client});
 assert.equal(orders.length,2);
 assert.equal(orders[0].displaySymbol,'SNDKUSDT');
 assert.equal(orders[1].type,'STOP_MARKET');
 await assert.rejects(()=>cancelRealOpenOrder({confirm:'NO',symbol:'AKE-USDT',orderId:'222',client}),/확인 문구/);
 const can=await cancelRealOpenOrder({confirm:'REAL_MANUAL_CANCEL',symbol:'AKE-USDT',orderId:'222',client});
 assert.equal(can.ok,true);
 assert.equal(calls.at(-1).op,'cancel');
});

test('buildBingxMarketList and filterSortMarkets support all BingX Futures + TradFi symbols, search, category tabs, favorites, and sorting',async()=>{
 const {buildBingxMarketList}=await import('../real_manual_trade.mjs');
 const {filterSortMarkets}=await import('../public/real_trade.js');
 const contracts=new Map([
  ['BTCUSDT',{symbol:'BTCUSDT',venueSymbol:'BTC-USDT',tradable:true,tickSize:'0.1',quantityStep:'0.001',minNotionalUSDT:5}],
  ['AKEUSDT',{symbol:'AKEUSDT',venueSymbol:'AKE-USDT',tradable:true,tickSize:'0.000001',quantityStep:'10',minNotionalUSDT:2}],
  ['NCSKSNDK2USDUSDT',{symbol:'NCSKSNDK2USDUSDT',venueSymbol:'NCSKSNDK2USD-USDT',tradable:true,tickSize:'0.01',quantityStep:'0.1',minNotionalUSDT:2}],
  ['DEADUSDT',{symbol:'DEADUSDT',venueSymbol:'DEAD-USDT',tradable:false}],
 ]);
 const tickers=[
  {symbol:'BTC-USDT',lastPrice:'61451.0',priceChangePercent:'-3.85',quoteVolume:'2500000000'},
  {symbol:'AKE-USDT',lastPrice:'0.004407',priceChangePercent:'-54.5',quoteVolume:'18500000'},
  {symbol:'NCSKSNDK2USD-USDT',lastPrice:'125.5',priceChangePercent:'4.2',quoteVolume:'32000000'},
 ];
 const markets=buildBingxMarketList({
  contracts,tickers,
  openPositions:[{symbol:'AKEUSDT',direction:'LONG',size:2000,avg:0.005,unrealized:-1.2,roePct:-12,origin:'copy'}],
 });
 assert.equal(markets.length,3,'excludes untradable');
 assert.equal(markets[0].displaySymbol,'BTCUSDT','sorted by volume desc by default');
 assert.equal(markets[1].displaySymbol,'SNDKUSDT');
 assert.equal(markets[1].category,'TRADFI');
 assert.equal(markets[2].holding.length,1);

 assert.deepEqual(filterSortMarkets(markets,{tab:'TRADFI'}).map(m=>m.displaySymbol),['SNDKUSDT']);
 assert.deepEqual(filterSortMarkets(markets,{tab:'HELD'}).map(m=>m.displaySymbol),['AKEUSDT']);
 assert.deepEqual(filterSortMarkets(markets,{tab:'FAV',favorites:new Set(['BTCUSDT'])}).map(m=>m.displaySymbol),['BTCUSDT']);
 assert.deepEqual(filterSortMarkets(markets,{query:'sndk'}).map(m=>m.displaySymbol),['SNDKUSDT']);
 assert.deepEqual(filterSortMarkets(markets,{sortBy:'change',sortDir:'desc'}).map(m=>m.displaySymbol),['SNDKUSDT','BTCUSDT','AKEUSDT']);
 assert.deepEqual(filterSortMarkets(markets,{sortBy:'price',sortDir:'asc'}).map(m=>m.displaySymbol),['AKEUSDT','SNDKUSDT','BTCUSDT']);
});

test('realTradePanelHTML, computeOrderPreview, roundToTick, and venuePositionsHTML render dropdown, chart overlays, click-to-trade bar, and quick-fill button',async()=>{
 const {roundToTick}=await import('../public/real_trade_chart.js');
 assert.equal(roundToTick(0.0058714,'0.000001'),0.005871);
 assert.equal(roundToTick(61451.27,'0.1'),61451.3);

 const st={
  open:true,dropdownOpen:true,symbol:'AKEUSDT',marginMode:'CROSSED',leverage:7,orderType:'MARKET',limitPrice:'',
  amountMode:'MARGIN_USDT',amount:'20',tpPrice:'',slPrice:'',availableUSD:2900,interval:'15m',showEma:true,selectedPrice:0.00512,
  marketQuery:'',marketTab:'ALL',marketSortBy:'volume',marketSortDir:'desc',favorites:new Set(['BTCUSDT']),
  markets:[
   {symbol:'BTCUSDT',displaySymbol:'BTCUSDT',category:'FUTURES',lastPrice:61451,changePct:-3.85,quoteVolume:2.5e9,holding:[]},
   {symbol:'AKEUSDT',displaySymbol:'AKEUSDT',category:'FUTURES',lastPrice:0.005,changePct:-12.4,quoteVolume:18e6,holding:[{direction:'LONG'}]},
  ],
  heldPositions:[{symbol:'AKEUSDT',direction:'LONG',origin:'copy',size:360,avg:0.0058,unrealized:-0.28,roePct:-11.2}],
  info:{symbol:'AKEUSDT',displaySymbol:'AKEUSDT',venueSymbol:'AKE-USDT',price:0.005,quantityStep:'10',minQuantityBase:10,minNotionalUSDT:2,unitMultiplier:1,maxLeverage:{long:20},copyHolding:[{direction:'LONG',qty:360,leverage:7}]},
  openOrders:[{orderId:'11',displaySymbol:'AKEUSDT',venueSymbol:'AKE-USDT',side:'BUY',positionSide:'LONG',type:'LIMIT',price:0.0048,origQty:5000}],
 };
 const prev=computeOrderPreview(st);
 assert.equal(prev.qty,28000);
 assert.equal(prev.warn,null);
 const html=realTradePanelHTML(st);
 assert.match(html,/거래소 차트 · 수동 매매/);
 assert.match(html,/data-rt-dropdown/);
 assert.match(html,/data-rt-dd-sort="volume"/);
 assert.match(html,/data-rt-dd-sort="change"/);
 assert.match(html,/data-rt-canvas/);
 assert.match(html,/data-rt-ca="LIMIT_LONG"/);
 assert.match(html,/data-rt-ca="LIMIT_SHORT"/);
 assert.match(html,/카피 매매 보유 중/);
 assert.match(html,/data-rt-submit="LONG"/);
 assert.match(html,/data-rt-submit="SHORT"/);
 assert.match(html,/data-rt-cancel-order="11"/);

 const vpHtml=venuePositionsHTML({
  mode:'LIVE',
  venuePositions:[{symbol:'AKEUSDT',direction:'LONG',origin:'copy',leverage:7,marginMode:'CROSSED',size:360,avg:0.0058,mark:0.0059,margin:0.3,unrealized:0.03,roePct:10}],
 });
 assert.match(vpHtml,/data-trade-fill/);
 assert.match(vpHtml,/주문\/추매/);
});
