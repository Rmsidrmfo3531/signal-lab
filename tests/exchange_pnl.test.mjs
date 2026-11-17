import test from 'node:test';import assert from 'node:assert/strict';
import {exchangePnl,summarizeIncome,balanceOf,incomeRows} from '../exchange_pnl.mjs';
const T0=Date.parse('2026-11-14T00:00:00+09:00'),D=86400000;
const rows=[
 {symbol:'AKE-USDT',incomeType:'REALIZED_PNL',income:'3.00',time:T0+D,tranId:'1'},
 {symbol:'AKE-USDT',incomeType:'TRADING_FEE',income:'-0.20',time:T0+D,tranId:'2'},
 {symbol:'BTC-USDT',incomeType:'REALIZED_PNL',income:'-1.00',time:T0+9*D,tranId:'3'},
 {symbol:'BTC-USDT',incomeType:'FUNDING_FEE',income:'-0.05',time:T0+9*D,tranId:'4'},
 {symbol:'',incomeType:'TRANSFER',income:'50',time:T0+2*D,tranId:'5'}];
test('exchange PnL: income totals, transfers kept out of the result, return on starting capital, 7-day windows',async()=>{
 const calls=[],client={income:async q=>{calls.push(q);return {list:rows.filter(r=>r.time>=q.startTime&&r.time<q.endTime)}},balance:async()=>({balance:{asset:'USDT',balance:'201.75',equity:'202.75',unrealizedProfit:'1',availableMargin:'150'}})};
 const s=await exchangePnl(client,{since:T0,now:T0+10*D});
 assert.equal(calls.length,2,'10 days = two 7-day windows');
 assert.equal(s.realizedPnlUSD,2);assert.equal(s.feesUSD,-.2);assert.equal(s.fundingUSD,-.05);assert.equal(s.tradingNetUSD,1.75);assert.equal(s.transfersUSD,50);
 assert.equal(s.startCapitalUSD,150,'202.75 - 1 open - 1.75 result - 50 deposit');assert.equal(s.returnPct,1.17);assert.equal(s.returnWithOpenPct,1.83);
 assert.equal(s.closes,2);assert.equal(s.bySymbol[0].symbol,'BTC-USDT');assert.equal(s.bySymbol[0].netUSD,-1.05);
 assert.deepEqual(Object.keys(s.byDay).length,2);
 assert.equal(balanceOf([{asset:'VST',equity:'100'}]).equity,100);
 assert.deepEqual(await exchangePnl({income:async()=>{throw Object.assign(Error('x'),{code:'NETWORK'})},balance:async()=>({})},{since:T0,now:T0+D}),{error:'NETWORK',since:T0});
 // A full page is read again in halves; a window that never gets under the limit is an error, not a silent gap.
 const many=Array.from({length:6},(_,i)=>({tranId:String(i),incomeType:'TRADING_FEE',income:'-0.1',time:T0+i*3600000}));
 const got=await incomeRows({income:async q=>many.filter(r=>r.time>=q.startTime&&r.time<q.endTime)},{since:T0,now:T0+D,limit:4});assert.equal(got.length,6);
 await assert.rejects(incomeRows({income:async()=>Array.from({length:3},(_,i)=>({tranId:i}))},{since:T0,now:T0+D,limit:3}),/INCOME_PAGE_FULL/);
 assert.equal(summarizeIncome([],null,{since:T0}).returnPct,null);
});
