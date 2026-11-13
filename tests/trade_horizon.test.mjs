import test from 'node:test';
import assert from 'node:assert/strict';
import {tradeHorizon} from '../trade_horizon.mjs';
import {liveEventText} from '../live_telegram.mjs';

import {holdTier} from '../trade_horizon.mjs';
test('four tiers by holding time; expected tier from the pattern; scalp is ultra-short',()=>{
 assert.deepEqual([.2,.99,1,11.9,12,71,72,200].map(h=>holdTier(h).label),['초단기','초단기','단기','단기','중기','중기','장기','장기']);
 for(const p of ['박스권 상단 돌파','상승삼각형 돌파','볼린저 수축 후 상단 돌파'])assert.equal(tradeHorizon(p).label,'중기',p);
 for(const p of ['5/20 데드크로스 숏','MACD 데드+하락다이버전스 숏','RSI 하락 다이버전스','상승 추세선 이탈 숏','거래량 다이버전스+음봉3 숏'])assert.equal(tradeHorizon(p).label,'장기',p);
 assert.equal(tradeHorizon('반등',{strategy:'SCALP'}).label,'초단기');
 assert.equal(tradeHorizon(null),null);assert.equal(holdTier(NaN),null);
});

test('Telegram live notices carry the label',()=>{
 const r={symbol:'ETHUSDT',direction:'SHORT',leverage:10,mode:'TESTNET',signal:{pattern:'5/20 데드크로스 숏',score:80},stop:110,targets:[90,80,70],firstEntryPrice:100,adds:[]};
 const t=liveEventText(r,'PROTECTED',{});assert.match(t,/\[장기\]/);assert.match(t,/장기 예상 \(백테스트 보유 중앙 4일/);
 const c=liveEventText({...r,realized:{netUSD:1.2,source:'EXCHANGE'},createdAt:1,closedAt:5.5*3600000+1},'SETTLED',{});assert.match(c,/보유 5\.5시간 \(단기\)/);
});
