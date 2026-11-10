import test from 'node:test';
import assert from 'node:assert/strict';
import {binancePerpetualMarkets} from '../markets.mjs';
import {estimateBinanceExecution} from '../binance_execution.mjs';
import {roundDecimalToStep} from '../decimal_grid.mjs';
const NOW=Date.now();
const market=()=>({symbol:'SOLUSDT',baseAsset:'SOL',quoteAsset:'USDT',marginAsset:'USDT',status:'TRADING',contractType:'PERPETUAL',filters:{
 PRICE_FILTER:{tickSize:'.01'},LOT_SIZE:{stepSize:'.01',minQty:'.01'},MIN_NOTIONAL:{notional:'5'}}});
const input=()=>({signal:{symbol:'SOLUSDT',direction:'LONG',entry:100,stop:98},market:market(),now:NOW,
 book:{T:NOW-100,bids:[['99.99','100']],asks:[['100.01','100']]}});
test('Binance crypto universe is TRADING USDT perpetual and independent of another exchange membership',()=>{
 const raw=market(),eligible={...raw,filters:Object.entries(raw.filters).map(([filterType,fields])=>({filterType,...fields}))},symbols=[eligible,{...eligible,symbol:'ETHUSDT',baseAsset:'ETH'},
  {...eligible,symbol:'BTCUSDC',baseAsset:'BTC',quoteAsset:'USDC'}, {...eligible,symbol:'XUSDT',baseAsset:'X',status:'BREAK'},
  {...eligible,symbol:'YUSDT',baseAsset:'Y',contractType:'CURRENT_QUARTER'}],tickers=symbols.map(s=>({symbol:s.symbol,lastPrice:'100',quoteVolume:'100000',priceChangePercent:'1',highPrice:'101',lowPrice:'99',closeTime:NOW}));
 const result=binancePerpetualMarkets({symbols},tickers);assert.deepEqual(result.markets.map(x=>x.symbol),['ETHUSDT','SOLUSDT']);
 assert.equal(result.binancePerps,2);assert.ok(result.markets.every(x=>x.filters.LOT_SIZE));
});
test('risk-sized depth validation floors quantity for exact40/35/25 without a fixed250 minimum or increasing risk',()=>{
 const result=estimateBinanceExecution(input());assert.equal(result.eligible,true,result.reasons.join());
 assert.ok(result.estimatedStopLossUSD<=6);assert.ok(Math.abs(result.quantity/.2-Math.round(result.quantity/.2))<1e-10);
 assert.ok(result.notional<500);assert.equal(result.tradeApproval,false);assert.equal(result.actualAccountFeesVerified,false);
 const tiny=input();tiny.signal.stop=10;tiny.market.filters.MIN_NOTIONAL.notional='250';
 assert.equal(estimateBinanceExecution(tiny).eligible,false,'minimum cannot be met by exceeding the risk-sized quantity');
});
test('risk-sized quantity stays on the exact 20-lot grid for steps whose float product is inexact',()=>{
 // 0.000001*20 is 0.000019999999999999998 in binary floating point; a grid built
 // that way puts the quantity (and the 40/35/25% split) off the exchange lot grid.
 for(const [stepSize,grid] of [['0.000001','0.00002'],['0.0000005','0.00001'],['0.07','1.4'],['.01','0.2']]){
  const value=input();value.market.filters.LOT_SIZE={stepSize,minQty:stepSize};
  const result=estimateBinanceExecution(value);assert.equal(result.eligible,true,`${stepSize}: ${result.reasons.join()}`);
  assert.equal(Number(roundDecimalToStep(result.quantity,grid,'DOWN')),result.quantity,`${stepSize}: ${result.quantity} is not a multiple of ${grid}`);
  assert.ok(result.estimatedStopLossUSD<=6);
 }
});
test('stale or crossed quotes, bad depth, unknown units and missing cost assumptions remain blocked independently of score',()=>{
 for(const mutate of [x=>{x.book.T=NOW-90001},x=>{x.book.T=NOW+1},x=>{x.book.asks=[['99','10']]},
  x=>{x.book.asks=[['100.01','.001']]},x=>{delete x.market.filters.LOT_SIZE},x=>{x.assumptions={takerRate:0}},
  x=>{x.maxRiskUSD=NaN}]){const value=input();mutate(value);value.signal.score=100;assert.equal(estimateBinanceExecution(value).eligible,false)}
 const short=input();short.signal.direction='SHORT';short.signal.stop=102;const result=estimateBinanceExecution(short);
 assert.equal(result.eligible,true);assert.ok(result.entryBasis<=result.bid);assert.ok(result.estimatedStopLossUSD<=6);
});
