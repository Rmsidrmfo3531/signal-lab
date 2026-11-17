import test from 'node:test';
import assert from 'node:assert/strict';
import {entryAllowance} from '../public/trade_plan.js';
// public/trade_plan.js is shared with the server (signal_pipeline.mjs, paper.mjs). The scanner
// display tests that used to live here went with the removed 대시보드 page (user 2026-11-17).

test('shared entry allowance retains price, risk and ATR guards for LONG and SHORT',()=>{
 for(const direction of ['LONG','SHORT']){
  const signal={direction,entry:100,stop:direction==='LONG'?98:102,atr:.2};
  assert.ok(Math.abs(entryAllowance(signal)-.0009)<1e-12,'ATR is the tightest guard');
  assert.equal(entryAllowance({...signal,atr:10}),.004,'price cap remains 0.4%');
  assert.ok(Math.abs(entryAllowance({...signal,stop:direction==='LONG'?99.8:100.2,atr:10})-.0005)<1e-12,'risk guard remains one quarter of stop distance');
 }
 assert.equal(entryAllowance({entry:NaN,stop:98}),0);
});
