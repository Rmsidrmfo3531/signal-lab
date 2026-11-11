import test from 'node:test';
import assert from 'node:assert/strict';
import {paperTelegramText} from '../paper_telegram.mjs';

const T=Date.parse('2026-11-12T00:00:00Z');
test('paper entry text: simulation label, strategy, chart, levels, half size',()=>{
 const text=paperTelegramText({type:'OPEN',symbol:'AKEUSDT',direction:'LONG',entryFill:1.2345,stop:1.2,notionalUSD:12.5},
  {strategy:'HOURLY_1H',pattern:'박스권 상단 돌파',score:92,targets:[1.3,1.35,1.4],sizeScale:.5,chartVenue:'GATEIO',executionVenue:'BINGX'});
 assert.match(text,/^🟢 \[모의 진입\] AKEUSDT 롱/);assert.match(text,/1시간봉 · 박스권 상단 돌파 · 92점/);
 assert.match(text,/진입 1\.2345 · 손절 1\.2/);assert.match(text,/목표 1\.3 \/ 1\.35 \/ 1\.4/);assert.match(text,/크기 ×0\.5/);
 assert.match(text,/차트 Gate\.io · 체결 BingX/);assert.match(text,/실제 주문 없음/);
});
test('paper close text: PnL, R multiple, reason (breakeven after a target), hold time, running totals',()=>{
 const rec={strategy:'SCALP_REVERSAL_5M',pattern:'급락 후 반등 롱 (5분)',chartVenue:'BINANCE',openedAt:T,initialRiskUSD:2,breakevenMoved:true,closeParts:[{type:'TARGET'},{type:'STOP'}],dca:{filledAdds:2,adds:[{},{},{}]}};
 const text=paperTelegramText({type:'CLOSE',symbol:'SOLUSDT',direction:'SHORT',at:T+95*60000,entryFill:150,lastExitFill:149,closeReason:'STOP',realizedPnLUSD:1.5},rec,{totals:{pnl:-3.25,closed:7,wins:4}});
 assert.match(text,/^✅ \[모의 청산\] SOLUSDT 숏 \+\$1\.50 \(\+0\.75R\)/);assert.match(text,/익절 후 본절 손절 · 보유 1시간 35분/);
 assert.match(text,/물타기 2회 체결/);assert.match(text,/5분 단타/);assert.match(text,/누적 모의 손익 -\$3\.25 · 청산 7건 \(승 4\)/);
 const loss=paperTelegramText({type:'CLOSE',symbol:'X',direction:'LONG',closeReason:'TIME_STOP',realizedPnLUSD:-2},{initialRiskUSD:2});
 assert.match(loss,/^❌ \[모의 청산\] X 롱 -\$2\.00 \(-1\.00R\)/);assert.match(loss,/시간 청산/);
 assert.match(paperTelegramText({type:'OPEN',symbol:'BTCUSDT',direction:'LONG'},null,{test:true}),/\[테스트\] \[모의 진입\]/);
});
