import test from 'node:test';
import assert from 'node:assert/strict';
import {tradeHorizon} from '../trade_horizon.mjs';
import {liveEventText} from '../live_telegram.mjs';

test('breakouts are short-term, reversal / dead-cross shorts long-term, no pattern no label',()=>{
 for(const p of ['박스권 상단 돌파','상승삼각형 돌파','볼린저 수축 후 상단 돌파'])assert.equal(tradeHorizon(p).label,'단기',p);
 for(const p of ['5/20 데드크로스 숏','MACD 데드+하락다이버전스 숏','RSI 하락 다이버전스','상승 추세선 이탈 숏','거래량 다이버전스+음봉3 숏'])assert.equal(tradeHorizon(p).label,'장기',p);
 assert.equal(tradeHorizon(null),null);
});

test('Telegram live notices carry the label',()=>{
 const r={symbol:'ETHUSDT',direction:'SHORT',leverage:10,mode:'TESTNET',signal:{pattern:'5/20 데드크로스 숏',score:80},stop:110,targets:[90,80,70],firstEntryPrice:100,adds:[]};
 const t=liveEventText(r,'PROTECTED',{});assert.match(t,/\[장기\]/);assert.match(t,/장기 \(보통 3~5일 보유\)/);
});
