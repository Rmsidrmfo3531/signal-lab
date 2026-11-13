import test from 'node:test';
import assert from 'node:assert/strict';
import {reviewTrade,patternInsights,journalEntryFor,patternOf} from '../live_review.mjs';
import {journalSummary} from '../journal.mjs';

const H=3600000,T=Date.parse('2026-11-13T00:00:00Z');
const rec=(x={})=>({signalKey:'CRYPTO:AUSDT:SHORT:5/20 데드크로스 숏:1',symbol:'AUSDT',mode:'TESTNET',direction:'SHORT',status:'CLOSED',createdAt:T,closedAt:T+5*H,
 firstEntryPrice:1,stop:1.1,leverage:10,adds:[{filled:false}],events:[],realized:{source:'EXCHANGE',netUSD:2,feeUSD:-0.1},...x});

test('profit, breakeven and loss reasons come from recorded facts only',()=>{
 assert.equal(patternOf(rec()),'5/20 데드크로스 숏');
 const win=reviewTrade(rec({breakevenMoved:true}));assert.equal(win.outcome,'PROFIT');assert.match(win.reasons[0],/본절/);
 const be=reviewTrade(rec({breakevenMoved:true,realized:{netUSD:-0.1}}));assert.equal(be.outcome,'BREAKEVEN');
 const loss=reviewTrade(rec({closedAt:T+H,realized:{netUSD:-3},signal:{btcTrend:'up',trend4h:'up',score:80}}));
 assert.equal(loss.outcome,'LOSS');assert.ok(loss.reasons.some(r=>r.includes('진입 직후')));assert.ok(loss.reasons.some(r=>r.includes('BTC')));
 assert.ok(loss.next.some(n=>n.includes('추세')));assert.ok(loss.next.some(n=>n.includes('점수 80점')));
 const full=reviewTrade(rec({adds:[{filled:true},{filled:true}],closedAt:T+100*H,realized:{netUSD:-5}}));
 assert.ok(full.reasons[0].includes('모두 체결'));assert.ok(full.next.some(n=>n.includes('추매')));assert.ok(full.next.some(n=>n.includes('보유 기간')));
 assert.equal(reviewTrade(rec({realized:null})).outcome,'UNKNOWN');
});

test('pattern insights only judge with 5+ trades; journal entries fit the journal summary',()=>{
 const losses=Array.from({length:5},(_,i)=>reviewTrade(rec({signalKey:'CRYPTO:B:SHORT:P1:'+i,closedAt:T+H,realized:{netUSD:-2}})));
 const few=[reviewTrade(rec({signalKey:'CRYPTO:C:SHORT:P2:1',realized:{netUSD:-1}}))];
 const ins=patternInsights([...losses,...few]);
 assert.equal(ins[0].pattern,'P1');assert.ok(ins[0].suggestions.some(s=>s.includes('거래 중지')));
 assert.deepEqual(ins.find(x=>x.pattern==='P2').suggestions,[]);
 const e=journalEntryFor(rec());assert.equal(e.source,'LIVE_AUTO');assert.equal(e.realizedPnLUSD,2);assert.match(e.id,/^live-/);
 const s=journalSummary([e],T+6*H);assert.equal(s.closed,1);assert.equal(s.totalPnL,2);
});
