import test from 'node:test';
import assert from 'node:assert/strict';
import {TREND_GATE_PATTERNS,scoreGatePassed,FINAL_MIN_SCORE} from '../signal_policy.mjs';
import {DETECTORS} from '../pattern_detectors.mjs';
import {LIVE_PATTERNS} from '../backtest.mjs';

test('trend-gate exception: only the six approved study-material patterns skip the 90-point score',()=>{
 assert.equal(FINAL_MIN_SCORE,90);
 assert.equal(TREND_GATE_PATTERNS.length,6,'growing this list needs the user\'s approval again (CLAUDE.md)');
 for(const name of TREND_GATE_PATTERNS)assert.equal(typeof DETECTORS[name],'function',name);
 for(const name of TREND_GATE_PATTERNS){assert.equal(scoreGatePassed(40,name),true);assert.ok(LIVE_PATTERNS.includes(name))}
 for(const base of ['박스권 상단 돌파','상승 추세선 이탈 숏','5/20 데드크로스 숏','M패턴 거래량 이탈 숏']){
  assert.equal(scoreGatePassed(89,base),false,base);assert.equal(scoreGatePassed(90,base),true,base)}
 assert.equal(scoreGatePassed(NaN,'박스권 상단 돌파'),false);
 for(const bad of [NaN,null,undefined,'95'])assert.equal(scoreGatePassed(bad,TREND_GATE_PATTERNS[0]),false,String(bad));
});

test('approved patterns also reach the final Telegram match; others still need 90',async()=>{
 const {finalTelegramMatch}=await import('../telegram_final.mjs');
 const row={decision:{ready:true},status:'signal',qualified:true,score:60,direction:'SHORT',symbol:'ETHUSDT',pattern:'RSI 하락 다이버전스',time:1};
 const alert={symbol:'ETHUSDT',direction:'SHORT',pattern:'RSI 하락 다이버전스',time:1};
 assert.equal(finalTelegramMatch(alert,[row]),row,'60-point approved pattern is sent');
 const other={...row,pattern:'박스권 하단 이탈'};assert.equal(finalTelegramMatch({...alert,pattern:other.pattern},[other]),null);
});
