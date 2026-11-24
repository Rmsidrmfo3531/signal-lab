// research/trader_style.mjs (TRADER_LADDER parameters, user 2026-11-24): pure summaries of the copy trader's records.
import test from 'node:test';
import assert from 'node:assert/strict';
import {exportStats,copyLedgerStats,adverseExcursion,quantile} from '../research/trader_style.mjs';

test('trader style: adds, holds, continuations, copy reductions and the adverse excursion',()=>{
 const H=3600000,e=(o)=>({symbol:'X',side:'LONG',at:0,entry:100,adds:0,holdMin:10,...o});
 const s=exportStats([e({}),e({adds:2,holdMin:120,entry:99}),e({at:600000,holdMin:5}),e({adds:7,holdMin:2000,entry:90})]);
 assert.equal(s.n,4);assert.equal(s.unique,3);assert.equal(s.continuations,1);assert.equal(s.upTo5AddsPct,75);assert.equal(s.hold.within24hPct,75);
 const c=copyLedgerStats([{adds:0,reduces:0,openedAt:0,closedAt:60000,netUSD:1,closeReason:'TRADER_CLOSE'},{adds:4,reduces:2,openedAt:0,closedAt:H,netUSD:-1,closeReason:'TRADER_CLOSE'}]);
 assert.deepEqual([c.withReductions,c.deep,c.deepWithReductions,c.wins],[1,1,1,1]);
 const bars=[{t:-H,h:101,l:90},{t:0,h:101,l:98},{t:H,h:100,l:96},{t:2*H,h:100,l:80}];
 assert.deepEqual(adverseExcursion({side:'LONG',at:1000,entry:100,holdMin:150},bars),{inner:4,edge:20});
 assert.equal(quantile([3,1,2],.5),2);
});
