import test from 'node:test';
import assert from 'node:assert/strict';
import {tradingViewTicker, tradingViewInterval, tradingViewChartUrl, tradingViewAccess} from '../public/tradingview.js';
test('perpetual symbol maps to TradingView Binance futures (.P)',()=>{
  assert.equal(tradingViewTicker('BTCUSDT'),'BINANCE:BTCUSDT.P');
  assert.equal(tradingViewTicker('ETHUSDT'),'BINANCE:ETHUSDT.P');
  assert.equal(tradingViewTicker('1000PEPEUSDT'),'BINANCE:1000PEPEUSDT.P');
});
test('invalid/unverified formats cannot produce chart links',()=>{
  for(const bad of ['BTC','BTCUSD','BTCUSDT?x=1','btcUSDT','DOGEUSDT<script>','']) assert.equal(tradingViewChartUrl(bad),null);
});
test('timeframe mapping is stable',()=>{
  assert.deepEqual(['1h','4h','1d'].map(tradingViewInterval),['60','240','D']);
});
test('TradingView browser link preserves future symbol and timeframe',()=>{
  assert.equal(tradingViewChartUrl('SOLUSDT','4h'),'https://www.tradingview.com/chart/?symbol=BINANCE%3ASOLUSDT.P&interval=240');
});

test('public TradingView chart is visible while listing metadata remains unverified',()=>{
  const x=tradingViewAccess('BTCUSDT','1h',false);
  assert.equal(x.canView,true);
  assert.deepEqual(Object.keys(x).sort(),['canView','chartUrl']);
  assert.match(x.chartUrl,/BTCUSDT.P/);
});
test('trade verification never controls chart URL availability',()=>{
  const before=tradingViewAccess('SOLUSDT','4h',false);
  const after=tradingViewAccess('SOLUSDT','4h',true);
  assert.equal(before.chartUrl,after.chartUrl);
  assert.equal(after.canView,true);assert.deepEqual(Object.keys(after).sort(),['canView','chartUrl']);
});
test('malformed chart symbol denied, including if someone claims it is verified',()=>{
  const x=tradingViewAccess('DOGEUSDT\" onclick=', '1h',true);
  assert.equal(x.canView,false);
  assert.deepEqual(Object.keys(x).sort(),['canView','chartUrl']);
  assert.equal(x.chartUrl,null);
});
