import test from 'node:test';
import assert from 'node:assert/strict';
import {extractVariationalPerps,intersectPerpetualMarkets} from '../markets.mjs';
const binance={symbols:[
 {symbol:'BTCUSDT',baseAsset:'BTC',quoteAsset:'USDT',contractType:'PERPETUAL',status:'TRADING'},
 {symbol:'ETHUSDT',baseAsset:'ETH',quoteAsset:'USDT',contractType:'PERPETUAL',status:'TRADING'},
 {symbol:'SOLUSDT',baseAsset:'SOL',quoteAsset:'USDT',contractType:'PERPETUAL',status:'TRADING'},
 {symbol:'1000PEPEUSDT',baseAsset:'1000PEPE',quoteAsset:'USDT',contractType:'PERPETUAL',status:'TRADING'},
 {symbol:'XAUUSDT',baseAsset:'XAU',quoteAsset:'USDT',contractType:'PERPETUAL',status:'TRADING'},
 {symbol:'BTCUSDC',baseAsset:'BTC',quoteAsset:'USDC',contractType:'PERPETUAL',status:'TRADING'},
 {symbol:'DOTUSDT',baseAsset:'DOT',quoteAsset:'USDT',contractType:'CURRENT_QUARTER',status:'TRADING'},
 {symbol:'DOGEUSDT',baseAsset:'DOGE',quoteAsset:'USDT',contractType:'PERPETUAL',status:'BREAK'}]};
const variational={listings:[{ticker:'BTC-PERP',contract_type:'perpetual',mark_price:'82000',volume_24h:'1e8'},
 {ticker:'ETH-PERP',contract_type:'perpetual',mark_price:'2500'},
 {ticker:'XAU-SWAP',contract_type:'swap',mark_price:'4000'},
 {ticker:'PEPE-PERP',contract_type:'perpetual',mark_price:'.00001'},
 {ticker:'US500-PERP',contract_type:'perpetual',mark_price:'850'}]};
const ticks=[{symbol:'BTCUSDT',lastPrice:'82001',quoteVolume:'15000000',priceChangePercent:'1',highPrice:'83000',lowPrice:'81000'},
 {symbol:'ETHUSDT',lastPrice:'2501',quoteVolume:'20000000',priceChangePercent:'1',highPrice:'2550',lowPrice:'2450'},
 {symbol:'SOLUSDT',lastPrice:'110',quoteVolume:'10000000',priceChangePercent:'1',highPrice:'120',lowPrice:'105'},
 {symbol:'1000PEPEUSDT',lastPrice:'.01',quoteVolume:'7000000',priceChangePercent:'0',highPrice:'.01',lowPrice:'.009'},
 {symbol:'XAUUSDT',lastPrice:'4000',quoteVolume:'7000000',priceChangePercent:'0',highPrice:'4100',lowPrice:'3900'}];
test('Variational v2 only PERP accepted, not SWAP or old schema',()=>{
 const items=extractVariationalPerps(variational);
 assert.ok(items.has('BTC'));assert.ok(!items.has('XAU'));
 assert.equal(items.get('BTC').markPrice,82000);
 assert.throws(()=>extractVariationalPerps({markets:[]}));
});
test('intersection includes BTC/ETH only, excludes unmatched SOL, SWAP, and prefix aliases',()=>{
 const {markets,binancePerps,variationalPerps}=intersectPerpetualMarkets(binance,ticks,variational);
 assert.deepEqual(markets.map(x=>x.symbol),['ETHUSDT','BTCUSDT']);
 assert.equal(markets[0].variational.ticker,'ETH-PERP');
 assert.equal(binancePerps,5);assert.equal(variationalPerps,4);
});
test('no verified Variational data fails closed, no guessed matches',()=>{
 assert.throws(()=>intersectPerpetualMarkets(binance,ticks,{listings:null}));
 const res=intersectPerpetualMarkets(binance,ticks,{listings:[]});assert.deepEqual(res.markets,[]);
});

test('known TradFi base is not misclassified as crypto when a Binance XAUUSDT future exists',()=>{
 const v={listings:[...variational.listings,{ticker:'XAU-PERP',contract_type:'perpetual',mark_price:'4000'}]};
 const matched=intersectPerpetualMarkets(binance,ticks,v);
 assert.ok(!matched.markets.some(x=>x.baseAsset==='XAU'));
});
