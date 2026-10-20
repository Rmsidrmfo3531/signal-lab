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

test('public TradingView chart is visible while both exchange APIs remain unverified',()=>{
  const x=tradingViewAccess('BTCUSDT','1h',false);
  assert.equal(x.canView,true);
  assert.equal(x.canOpenVariational,false);
  assert.match(x.chartUrl,/BTCUSDT.P/);
});
test('trade verification never controls chart URL availability',()=>{
  const before=tradingViewAccess('SOLUSDT','4h',false);
  const after=tradingViewAccess('SOLUSDT','4h',true);
  assert.equal(before.chartUrl,after.chartUrl);
  assert.equal(after.canOpenVariational,true);
});
test('malformed chart symbol denied, including if someone claims it is verified',()=>{
  const x=tradingViewAccess('DOGEUSDT\" onclick=', '1h',true);
  assert.equal(x.canView,false);
  assert.equal(x.canOpenVariational,false);
  assert.equal(x.chartUrl,null);
});
