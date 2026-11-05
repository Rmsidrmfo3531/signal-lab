import test from 'node:test';
import assert from 'node:assert/strict';
import {binancePerpetualMarkets} from '../markets.mjs';
const info={symbols:[
 {symbol:'BTCUSDT',baseAsset:'BTC',quoteAsset:'USDT',contractType:'PERPETUAL',status:'TRADING'},
 {symbol:'ETHUSDT',baseAsset:'ETH',quoteAsset:'USDT',contractType:'PERPETUAL',status:'TRADING'},
 {symbol:'SOLUSDT',baseAsset:'SOL',quoteAsset:'USDT',contractType:'PERPETUAL',status:'TRADING'},
 {symbol:'1000PEPEUSDT',baseAsset:'1000PEPE',quoteAsset:'USDT',contractType:'PERPETUAL',status:'TRADING'},
 {symbol:'XAUUSDT',baseAsset:'XAU',quoteAsset:'USDT',contractType:'PERPETUAL',status:'TRADING'},
 {symbol:'BTCUSDC',baseAsset:'BTC',quoteAsset:'USDC',contractType:'PERPETUAL',status:'TRADING'},
 {symbol:'DOTUSDT',baseAsset:'DOT',quoteAsset:'USDT',contractType:'CURRENT_QUARTER',status:'TRADING'},
 {symbol:'DOGEUSDT',baseAsset:'DOGE',quoteAsset:'USDT',contractType:'PERPETUAL',status:'BREAK'}]};
const ticks=info.symbols.map((row,i)=>({symbol:row.symbol,lastPrice:'100',quoteVolume:String(10000-i),priceChangePercent:'1',highPrice:'101',lowPrice:'99'}));
test('Binance universe includes every matching active crypto contract without a second venue membership',()=>{
 const result=binancePerpetualMarkets(info,ticks);assert.deepEqual(result.markets.map(row=>row.symbol),['BTCUSDT','ETHUSDT','SOLUSDT','1000PEPEUSDT']);
 assert.equal(result.binancePerps,4);assert.ok(result.markets.every(row=>row.dataSource==='BINANCE_USDT_PERPETUAL'));
});
test('market discovery fails closed for malformed exchange or ticker arrays',()=>{
 for(const pair of [[null,ticks],[info,null],[{symbols:{}},ticks],[info,{}]])assert.throws(()=>binancePerpetualMarkets(...pair));
});
test('absent quotes cannot invent an active market or guess a prefix alias',()=>{
 assert.deepEqual(binancePerpetualMarkets(info,[]).markets,[]);
 const misleading=[{symbol:'PEPEUSDT',lastPrice:'.01',quoteVolume:'10000'}];
 assert.deepEqual(binancePerpetualMarkets(info,misleading).markets,[]);
});
test('missing contract filters remain unknown instead of inventing order-size rules',()=>{
 const result=binancePerpetualMarkets(info,ticks);assert.deepEqual(result.markets[0].filters,{});
 assert.equal(result.markets[0].marginAsset,null);assert.equal(result.markets[0].priceAt,null);
});
test('known TradFi bases and invalid prices cannot be classified as crypto',()=>{
 assert.ok(!binancePerpetualMarkets(info,ticks).markets.some(row=>row.baseAsset==='XAU'));
 const invalid=ticks.map(row=>({...row,lastPrice:'not-a-price'}));assert.deepEqual(binancePerpetualMarkets(info,invalid).markets,[]);
});
