import test from 'node:test';
import assert from 'node:assert/strict';
import {gateKlineRows,bingxKlineRows,venueVolumes,selectVenueOnlyCoins,isCoinSymbol} from '../venue_charts.mjs';
import {analyze} from '../engine.mjs';

test('Gate.io and BingX candles become Binance-layout rows (open, OHLC, base volume, close time)',()=>{
 const g=gateKlineRows([{t:7200,o:'2',h:'3',l:'1',c:'2.5',v:'40',sum:'100'},{t:3600,o:'1',h:'2',l:'1',c:'2',v:'10',sum:'20'}],'1h');
 assert.deepEqual(g[0],[3600000,1,2,1,2,10,7199999,20]);assert.deepEqual(g[1],[7200000,2,3,1,2.5,40,10799999,100]);
 const b=bingxKlineRows([{open:'1',close:'2',high:'2',low:'1',volume:'5',time:3600000}],'1h');
 assert.deepEqual(b[0],[3600000,1,2,1,2,5,7199999,10]);
 assert.equal(gateKlineRows([{t:'x'}],'1h'),null);assert.equal(gateKlineRows([],'2h'),null);
});

test('engine analyzes venue rows like Binance rows (closed candles only)',()=>{
 const now=Date.UTC(2026,10,11,10,5),H=3600000;
 const gate=(n,ms)=>Array.from({length:n},(_,i)=>{const t=(Math.floor(now/ms)-n+1+i)*ms/1000,c=100+Math.sin(i/5)*3;return {t,o:c-.2,h:c+.5,l:c-.5,c,v:100,sum:100*c}});
 const h1=gateKlineRows(gate(200,H),'1h'),h4=gateKlineRows(gate(301,4*H),'4h');
 const out=analyze('AKEUSDT',h1,h4,[],h1.at(-1)[4],{now,btcH4Rows:h4});
 assert.notEqual(out.status,'insufficient',out.reason);
});

test('venue-only list: coins only, not on Binance, tradable, volume at least the smallest reference coin',()=>{
 const c=(...syms)=>new Map(syms.map(s=>[s,{tradable:!s.startsWith('X')}]));
 const contracts={GATEIO:c('AKEUSDT','JCTUSDT','BIGUSDT','TINYUSDT','BTCUSDT','NVDAUSDT','XDEADUSDT'),BINGX:c('NCSKNVDA2USDUSDT','MIDUSDT')};
 const volumes=venueVolumes({gateTickers:[{contract:'AKE_USDT',volume_24h_quote:'3000000',last:'1'},{contract:'JCT_USDT',volume_24h_quote:'2000000'},
  {contract:'BIG_USDT',volume_24h_quote:'9000000'},{contract:'TINY_USDT',volume_24h_quote:'100'},{contract:'NVDA_USDT',volume_24h_quote:'9e9'},{contract:'XDEAD_USDT',volume_24h_quote:'9e9'}],
  bingxTickers:[{symbol:'MID-USDT',quoteVolume:'2500000'},{symbol:'NCSKNVDA2USD-USDT',quoteVolume:'9e9'}]});
 const r=selectVenueOnlyCoins({binanceSymbols:['BTCUSDT'],contracts,volumes,references:['AKEUSDT','JCTUSDT']});
 assert.equal(r.threshold,2e6);assert.equal(r.thresholdSource,'REFERENCE');
 assert.deepEqual(r.coins.map(x=>x.symbol),['BIGUSDT','AKEUSDT','MIDUSDT','JCTUSDT']);
 assert.deepEqual(r.coins.find(x=>x.symbol==='MIDUSDT').venues,['BINGX']);
 assert.equal(selectVenueOnlyCoins({binanceSymbols:[],contracts,volumes,minVolume:5e6,references:['AKEUSDT']}).coins.length,1);
 // Half the smaller reference (1M$) also takes coins a bit smaller than the examples.
 const half=selectVenueOnlyCoins({binanceSymbols:['BTCUSDT'],contracts,volumes,references:['AKEUSDT','JCTUSDT'],referenceRatio:.5});
 assert.equal(half.threshold,1e6);assert.equal(half.coins.length,4);
 assert.equal(isCoinSymbol('NVDAUSDT'),false);assert.equal(isCoinSymbol('NCCOGOLD2USDUSDT'),false);assert.equal(isCoinSymbol('AKEUSDT'),true);
});

import {parseMarketCaps,marketCapFor,screenByMarketCap} from '../venue_charts.mjs';
test('market cap screen: ticker+price match, tiny / unknown / wash-volume coins dropped',()=>{
 const caps=parseMarketCaps([[{id:'ake',symbol:'ake',market_cap:40e6,current_price:.5},{id:'ake-fake',symbol:'ake',market_cap:900e6,current_price:30},
  {id:'tiny',symbol:'tiny',market_cap:2e6,current_price:1},{id:'wash',symbol:'wash',market_cap:12e6,current_price:2},{id:'pepe',symbol:'pepe',market_cap:2e9,current_price:.00001}]]);
 assert.equal(marketCapFor('AKEUSDT',.52,caps).id,'ake','same ticker, price decides');
 assert.equal(marketCapFor('AKEUSDT',5,caps),null,'no price match = unknown');
 assert.equal(marketCapFor('1000PEPEUSDT',.01,caps).id,'pepe','1000x contracts');
 const coins=[{symbol:'AKEUSDT',price:.5,quoteVolume:3e6},{symbol:'TINYUSDT',price:1,quoteVolume:3e6},{symbol:'WASHUSDT',price:2,quoteVolume:80e6},{symbol:'NONEUSDT',price:1,quoteVolume:9e6}];
 const r=screenByMarketCap(coins,caps,{minMarketCap:10e6,maxVolumeToCap:5});
 assert.deepEqual(r.kept.map(c=>[c.symbol,c.marketCap]),[['AKEUSDT',40e6]]);
 assert.deepEqual(r.dropped.map(c=>[c.symbol,c.reason]),[['TINYUSDT','MCAP_TOO_SMALL'],['WASHUSDT','VOLUME_TO_MCAP_TOO_HIGH'],['NONEUSDT','MCAP_UNKNOWN']]);
});
