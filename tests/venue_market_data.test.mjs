import test from 'node:test';
import assert from 'node:assert/strict';
import {venueSymbol,canonicalSymbol,normalizeBingXContract,normalizeGateContract,normalizeBook,compareVenues,venueQuantity} from '../venue_market_data.mjs';
import {roundDecimalToStep,multiplyDecimal,decimalPlaces} from '../decimal_grid.mjs';

const NOW=Date.parse('2026-11-10T12:00:00Z');
// Field names and shapes follow the official BingX swap and Gate.io futures documentation.
const bingx=(extra={})=>({symbol:'BTC-USDT',currency:'USDT',asset:'BTC',pricePrecision:1,quantityPrecision:4,tradeMinQuantity:'0.0001',tradeMinUSDT:'2',
 status:1,apiStateOpen:'true',apiStateClose:'true',takerFeeRate:0.0005,makerFeeRate:0.0002,...extra});
const gate=(extra={})=>({name:'BTC_USDT',type:'direct',quanto_multiplier:'0.0001',order_price_round:'0.1',order_size_min:1,status:'trading',in_delisting:false,mark_price:'81000',...extra});

test('symbols map between the app (BTCUSDT) and each venue instrument name',()=>{
 assert.equal(venueSymbol('BINGX','BTCUSDT'),'BTC-USDT');assert.equal(venueSymbol('GATEIO','1000PEPEUSDT'),'1000PEPE_USDT');
 assert.equal(canonicalSymbol('BINGX','ETH-USDT'),'ETHUSDT');assert.equal(canonicalSymbol('GATEIO','ETH_USDT'),'ETHUSDT');
 assert.equal(canonicalSymbol('GATEIO','BTC_USD'),null);assert.equal(canonicalSymbol('BINGX','BTC-USD'),null);
 assert.throws(()=>venueSymbol('BINGX','btc-usdt;rm'),/INVALID_SYMBOL/);assert.throws(()=>venueSymbol('OTHER','BTCUSDT'),/UNKNOWN_VENUE/);
});

test('BingX contract: precision digits become exact steps and API trading flags decide tradability',()=>{
 const c=normalizeBingXContract(bingx());
 assert.deepEqual({symbol:c.symbol,tick:c.tickSize,step:c.quantityStep,unit:c.quantityUnit,min:c.minQuantityBase,notional:c.minNotionalUSDT,tradable:c.tradable},
  {symbol:'BTCUSDT',tick:'0.1',step:'0.0001',unit:'BASE_ASSET',min:'0.0001',notional:2,tradable:true});
 assert.equal(normalizeBingXContract(bingx({pricePrecision:0})).tickSize,'1');
 assert.deepEqual(normalizeBingXContract(bingx({apiStateOpen:'false'})).reasons,['VENUE_API_TRADING_DISABLED']);
 assert.deepEqual(normalizeBingXContract(bingx({status:0})).reasons,['VENUE_STATUS_INACTIVE']);
 assert.ok(normalizeBingXContract(bingx({quantityPrecision:'x'})).reasons.includes('VENUE_PRECISION_INVALID'));
 assert.equal(normalizeBingXContract(bingx({currency:'USDC'})),null,'only USDT-settled contracts');
});

test('Gate.io contract: sizes are in contracts and the minimum is converted to base asset exactly',()=>{
 const c=normalizeGateContract(gate());
 assert.equal(c.symbol,'BTCUSDT');assert.equal(c.quantityUnit,'CONTRACT');assert.equal(c.contractSizeBase,'0.0001');
 assert.equal(c.minQuantityBase,'0.0001');assert.equal(c.tickSize,'0.1');assert.equal(c.tradable,true);
 assert.equal(normalizeGateContract(gate({order_size_min:3,quanto_multiplier:'0.01'})).minQuantityBase,'0.03');
 assert.deepEqual(normalizeGateContract(gate({in_delisting:true})).reasons,['VENUE_DELISTING']);
 assert.deepEqual(normalizeGateContract(gate({status:'suspend'})).reasons,['VENUE_STATUS_INACTIVE']);
 assert.deepEqual(normalizeGateContract(gate({type:'inverse'})).reasons,['VENUE_CONTRACT_NOT_LINEAR']);
 assert.ok(normalizeGateContract(gate({quanto_multiplier:'0'})).reasons.includes('VENUE_PRECISION_INVALID'));
});

test('order books: best levels regardless of venue ordering, Gate seconds clock, stale and crossed books flagged',()=>{
 const b=normalizeBook('BINGX',{T:NOW-500,bids:[['100.0','1'],['100.1','2']],asks:[['100.5','1'],['100.3','4']]},{receivedAt:NOW,now:NOW});
 assert.equal(b.ok,true);assert.equal(b.bid,100.1);assert.equal(b.ask,100.3);assert.equal(b.ageMs,500);
 assert.ok(Math.abs(b.spreadBps-(0.2/100.2*10000))<1e-9);
 const g=normalizeBook('GATEIO',{current:(NOW-1000)/1000,asks:[{p:'100.4',s:5}],bids:[{p:'100.2',s:9}]},{receivedAt:NOW,now:NOW});
 assert.equal(g.ok,true);assert.equal(g.sourceTime,NOW-1000);assert.equal(g.bid,100.2);
 assert.deepEqual(normalizeBook('GATEIO',{current:(NOW-60000)/1000,asks:[{p:'1',s:1}],bids:[{p:'0.9',s:1}]},{receivedAt:NOW,now:NOW}).reasons,['BOOK_STALE']);
 assert.ok(normalizeBook('BINGX',{T:NOW,bids:[['101','1']],asks:[['100','1']]},{receivedAt:NOW,now:NOW}).reasons.includes('BOOK_CROSSED'));
 assert.ok(normalizeBook('BINGX',{T:NOW,bids:[['x','1']],asks:[]},{receivedAt:NOW,now:NOW}).reasons.includes('BOOK_MISSING_OR_MALFORMED'));
 assert.ok(normalizeBook('BINGX',{bids:[['1','1']],asks:[['2','1']]},{receivedAt:NOW,now:NOW}).reasons.includes('BOOK_TIME_MISSING'));
});

test('comparison row: cross-venue gap, best venue per side and Binance chart reference',()=>{
 const book=(bid,ask)=>({ok:true,bid,ask,mid:(bid+ask)/2,spreadBps:1});
 const row=compareVenues('BTCUSDT',{bingx:{contract:{},book:book(100,100.2)},gateio:{contract:{},book:book(100.1,100.3)},binancePrice:100});
 assert.ok(Math.abs(row.crossVenueMidBps-((100.1-100.2)/100.2*10000))<1e-9);
 assert.equal(row.cheapestAsk,'BINGX');assert.equal(row.richestBid,'GATEIO');
 assert.ok(Math.abs(row.venues.BINGX.vsBinanceBps-10)<1e-9);
 const missing=compareVenues('BTCUSDT',{bingx:{contract:null,book:null,error:'NOT_LISTED'},gateio:{contract:{},book:book(1,1.1)},binancePrice:null});
 assert.equal(missing.crossVenueMidBps,null);assert.equal(missing.venues.BINGX.error,'NOT_LISTED');assert.equal(missing.binanceChartPrice,null);
});

test('venue quantity: BingX base-asset grid and Gate.io whole contracts, never rounded up',()=>{
 assert.deepEqual(venueQuantity(normalizeBingXContract(bingx()),0.123456),{orderQuantity:'0.1234',unit:'BASE_ASSET',baseQuantity:0.1234});
 assert.deepEqual(venueQuantity(normalizeGateContract(gate()),0.12349),{orderQuantity:'1234',unit:'CONTRACT',baseQuantity:0.1234});
 assert.equal(venueQuantity(normalizeGateContract(gate({in_delisting:true})),1),null,'untradable contract');
});

test('decimal grid helpers are exact',()=>{
 assert.equal(roundDecimalToStep(0.3,0.1,'DOWN'),'0.3');assert.equal(roundDecimalToStep('2.64568',0.00002,'DOWN'),'2.64568');
 assert.equal(roundDecimalToStep(1.05,0.1,'UP'),'1.1');assert.equal(multiplyDecimal('0.0001','1234'),'0.1234');assert.equal(decimalPlaces('0.001'),3);
 assert.throws(()=>roundDecimalToStep(-1,0.1),/INVALID_DECIMAL/);assert.throws(()=>roundDecimalToStep(0,0.1),/POSITIVE_DECIMAL_REQUIRED/);
});

test('Gate.io decimal-size contracts step by order_size_min contracts; a missing minimum stays invalid',()=>{
 const c=normalizeGateContract(gate({name:'ETH_USDT',quanto_multiplier:'0.01',order_size_min:'0.1',enable_decimal:true}));
 assert.equal(c.tradable,true);assert.equal(c.decimalSizes,true);assert.equal(c.contractStep,'0.1');
 assert.equal(c.quantityStep,'0.001','0.1 contract x 0.01 ETH');assert.equal(c.minQuantityBase,'0.001');
 assert.deepEqual(venueQuantity(c,0.12345),{orderQuantity:'12.3',unit:'CONTRACT',baseQuantity:0.123});
 const integer=normalizeGateContract(gate());assert.equal(integer.decimalSizes,false);assert.equal(integer.contractStep,'1');assert.equal(integer.quantityStep,'0.0001');
 const missing=normalizeGateContract(gate({order_size_min:undefined}));assert.ok(missing.reasons.includes('VENUE_MIN_QUANTITY_INVALID'));
});
