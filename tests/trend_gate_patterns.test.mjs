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
});
