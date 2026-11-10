import test from 'node:test';
import assert from 'node:assert/strict';
import {estimateBinanceExecution,BINANCE_PAPER_ASSUMPTIONS} from '../binance_execution.mjs';
import {syntheticBinanceContext} from './fixtures/binance_signal.mjs';
const T=Date.now();
const input=()=>({signal:{symbol:'BTCUSDT',direction:'LONG',entry:100,stop:98},...syntheticBinanceContext('BTCUSDT',100,T)});
test('public depth estimates retain explicit funding and fee assumptions without claiming observed settlements',()=>{
 const result=estimateBinanceExecution(input());assert.equal(result.eligible,true);assert.equal(result.dataFrom,'BINANCE_PUBLIC_DEPTH');
 assert.equal(result.costAssumptions.fundingStatus,'ASSUMED_RESERVE_NOT_ACTUAL_SETTLEMENT');assert.equal(result.actualAccountFeesVerified,false);
});
test('eligible two-sided depth uses positive spread and risk-bounded quantity',()=>{
 const result=estimateBinanceExecution(input());assert.equal(result.eligible,true);assert.ok(result.spreadBps>0);assert.ok(result.quantity>0);
 assert.ok(result.estimatedStopLossUSD<=6);assert.equal(result.ordersSubmitted,false);
});
test('LONG asks and SHORT bids determine entry independently of the displayed ticker',()=>{
 const value=input(),long=estimateBinanceExecution(value);value.signal.direction='SHORT';value.signal.stop=102;
 const short=estimateBinanceExecution(value);assert.equal(short.eligible,true);
 assert.equal(long.executablePrice,100.005);assert.equal(short.executablePrice,99.995);assert.ok(long.entryBasis>=short.entryBasis);
});
test('stale quotes, missing source clocks and missing sides fail closed',()=>{
 for(const mutate of [x=>{x.book.T=T-100000},x=>{delete x.book.T},x=>{delete x.book.asks}]){
  const value=input();mutate(value);assert.equal(estimateBinanceExecution(value).eligible,false);
 }
});
test('crossed, duplicate, reverse-sorted or excessive-spread depth blocks approval',()=>{
 for(const asks of [[[99,1000]],[[100.005,1000],[100.005,1000]],[[100.01,1000],[100.005,1000]],[[103,1000]]]){
  const value=input();value.book.asks=asks;assert.equal(estimateBinanceExecution(value).eligible,false);
 }
});
test('risk sizing never raises quantity to satisfy a minimum notional above available risk',()=>{
 const value=input();value.signal.stop=10;value.market.filters.MIN_NOTIONAL.notional='250';
 const result=estimateBinanceExecution(value);assert.equal(result.eligible,false);assert.ok(result.reasons.includes('RISK_CAP_BELOW_MINIMUM_ORDER'));
});
test('missing funding cost assumption remains unknown and blocks instead of substituting zero',()=>{
 const value=input();value.assumptions={...BINANCE_PAPER_ASSUMPTIONS,fundingReserveRate:undefined};
 const result=estimateBinanceExecution(value);assert.equal(result.eligible,false);assert.ok(result.reasons.includes('COST_ASSUMPTION_UNVERIFIED'));
});
test('quantity is floored on the exchange step for exact three-way exits and bounded by exposure',()=>{
 const value=input();value.maxNotionalUSD=100;const result=estimateBinanceExecution(value);
 assert.equal(result.eligible,true);assert.ok(result.notional<=100);const units=result.quantity/(result.quantityStep*20);
 assert.ok(Math.abs(units-Math.round(units))<1e-8);
});
test('market contract identity and exchange quantity filters are mandatory',()=>{
 for(const mutate of [x=>{x.market.symbol='ETHUSDT'},x=>{x.market.status='BREAK'},x=>{delete x.market.filters.LOT_SIZE},
  x=>{x.market.contractType='CURRENT_QUARTER'},x=>{x.market.quoteAsset='USDC'}]){
  const value=input();mutate(value);assert.equal(estimateBinanceExecution(value).eligible,false);
 }
});
test('invalid execution limits cannot disable freshness, loss or spread guards',()=>{
 for(const limits of [{maxAgeMs:NaN},{maxAgeMs:90001},{maxRiskUSD:0},{maxNotionalUSD:Infinity},{maxSpreadBps:-1}])
  assert.equal(estimateBinanceExecution({...input(),...limits}).eligible,false);
});
test('future depth clocks remain blocked even when receipt and displayed price are fresh',()=>{
 const value=input();value.book.T=T+1;const result=estimateBinanceExecution(value);
 assert.equal(result.eligible,false);assert.ok(result.reasons.includes('BOOK_CLOCK_INVALID_OR_STALE'));
});
test('insufficient depth cannot produce an approved full fill or silently ignore slippage',()=>{
 const value=input();value.book.asks=[[100.005,.001]];let result=estimateBinanceExecution(value);
 assert.equal(result.eligible,false);assert.ok(result.reasons.includes('BOOK_DEPTH_INSUFFICIENT'));
 value.book.asks=[[100.005,.001],[100.09,1000]];result=estimateBinanceExecution(value);
 assert.equal(result.eligible,false);assert.ok(result.reasons.includes('SLIPPAGE_LIMIT'));
});
