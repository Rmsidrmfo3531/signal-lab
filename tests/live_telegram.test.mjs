import test from 'node:test';
import assert from 'node:assert/strict';
import {liveEventText} from '../live_telegram.mjs';

const r={symbol:'GRASSUSDT',direction:'SHORT',leverage:13,mode:'TESTNET',firstEntryPrice:0.4387,stop:0.6041,targets:[0.3824,0.3598,0.3372],
 adds:[{filled:true},{filled:false}],position:{entryPrice:0.4487},signal:{pattern:'MACD 데드+하락다이버전스 숏',score:88},
 entryOrderId:'1736012449498123737',clientOrderId:'slabc',createdAt:1000,closedAt:1000+5*3600000,realized:{source:'EXCHANGE',netUSD:-1.234}};

test('live notices: entry, add, first target, settled close and problems — no order ids',()=>{
 const entry=liveEventText(r,'PROTECTED');assert.match(entry,/진입 · GRASSUSDT 숏 13배 · 테스트넷/);assert.match(entry,/손절 0\.6041/);assert.match(entry,/88점/);
 assert.match(liveEventText(r,'ADD_FILLED'),/추매 1차 체결/);
 assert.match(liveEventText(r,'STOP_TO_BREAKEVEN'),/1차 목표 도달/);
 const close=liveEventText(r,'SETTLED');assert.match(close,/손실 마감/);assert.match(close,/−\$1\.23/);assert.match(close,/보유 5\.0시간/);
 assert.match(liveEventText(r,'STOP_FAILED',{reason:'X'}),/주문 문제.*\n손절 주문 등록 실패 \(X\)/);
 assert.equal(liveEventText(r,'ENTRY_SENT'),null,'routine steps are not sent');
 assert.equal(liveEventText({...r,test:true},'PROTECTED'),null,'test orders: only problems');
 for(const t of ['PROTECTED','ADD_FILLED','STOP_TO_BREAKEVEN','SETTLED','STOP_FAILED'])assert.equal(/1736012449498123737|slabc/.test(liveEventText(r,t)),false,t);
});

test('test orders, partial add fills and the kill switch',()=>{
 assert.equal(liveEventText({...r,signalKey:'TEST:1'},'PROTECTED'),null,'test order before it is marked test');
 assert.equal(liveEventText({...r,adds:[{filled:false}]},'ADD_FILLED'),null,'partial fill: no "0차" notice');
 assert.match(liveEventText({symbol:'실매매 전체',mode:'TESTNET'},'KILL_SWITCH',{reason:'MANUAL'}),/긴급 정지/);
 assert.match(liveEventText(r,'ERROR',{reason:'X'}),/주문 처리 오류/);
});
