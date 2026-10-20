import test from 'node:test';import assert from 'node:assert/strict';
import {normalizeTrade,closeTrade,journalSummary,exportTradesCSV} from '../journal.mjs';
const base={symbol:'BTCUSDT',side:'LONG',entry:100,stop:99,notional:1000,leverage:20,fees:1};
test('trade must have real direction and stop-risk basis',()=>{
 const x=normalizeTrade(base);assert.equal(x.stopRiskUSD,11);assert.equal(x.status,'OPEN');
 assert.throws(()=>normalizeTrade({...base,stop:102}));
 assert.throws(()=>normalizeTrade({...base,symbol:'BTCUSDC'}, {allowedSymbols:new Set(['BTCUSDT'])}));
});
test('long/short pnl includes entered fees and signed funding',()=>{
 const x=normalizeTrade(base);const c=closeTrade(x,{exit:102,fees:1,funding:-.5});assert.equal(c.realizedPnLUSD,18.5);
 const s=normalizeTrade({...base,side:'SHORT',stop:101,fees:0,exit:98,funding:1});assert.equal(s.realizedPnLUSD,19);
});
test('journal summary daily weekly and risk caps based on manual closed entries',()=>{
 const now=Date.parse('2026-10-18T08:00:00Z');const a={...normalizeTrade({...base,exit:98,fees:0},{now}),id:'one'};
 const s=journalSummary([a],now);assert.equal(s.todayPnL,-20);assert.equal(s.dayExceeded,true);assert.equal(s.weekExceeded,false);
});
test('CSV export neutralizes spreadsheet formula injection',()=>{
 const row={...normalizeTrade({...base,note:'=HYPERLINK("evil")'})};const csv=exportTradesCSV([row]);assert.match(csv,/\'=HYPERLINK/);
});
