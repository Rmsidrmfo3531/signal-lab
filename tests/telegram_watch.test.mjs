import test from 'node:test';
import assert from 'node:assert/strict';
import {watchMinScore,shouldNotifyWatch,watchAlertKey,telegramWatchMessage} from '../telegram_watch.mjs';
const now=Date.parse('2026-11-04T00:00:00Z');
const candidate={symbol:'SOLUSDT',direction:'LONG',pattern:'상승 추세 눌림목',score:85,scoreVersion:'ISSUE6-100-V1',
 indicators:{valid:true,score:85,checks:[{label:'RSI(14)',earned:10,weight:10,value:55}]},
 patternConfirmed:true,patternTimeframe:'1h',patternConfirmedAt:now-20000,time:now-3600000,status:'watch',
 qualified:false,volumeRatio:1.4,executionStatus:'실매매 검증 보류',quality:{failed:['거래량 미달']}};
test('default watch threshold is 80 and explicit disable or invalid thresholds never relax it',()=>{
 assert.equal(watchMinScore(undefined),80);
 for(const value of ['',0,-1,79,101,'abc',80.5])assert.equal(watchMinScore(value),0);
 assert.equal(watchMinScore('80'),80);assert.equal(shouldNotifyWatch(candidate,{verified:true,now}),true);
 assert.equal(shouldNotifyWatch(candidate,{verified:true,now,minScore:0}),false);
});
test('computed canonical score not the obsolete 60:40 score controls fresh verified altcoin alerts',()=>{
 assert.equal(shouldNotifyWatch(candidate,{minScore:80,verified:true,now}),true);
 assert.equal(shouldNotifyWatch(candidate,{minScore:90,verified:true,now}),false);
 assert.equal(shouldNotifyWatch({...candidate,score:79,compositeScore:100},{minScore:80,verified:true,now}),false);
 assert.equal(shouldNotifyWatch({...candidate,score:80,compositeScore:20},{minScore:80,verified:true,now}),true);
});
test('never notify stale, unverified, BTC or final-signal rows as Telegram observations',()=>{
 const config={minScore:80,verified:true,now};
 assert.equal(shouldNotifyWatch(candidate,{...config,verified:false}),false);
 assert.equal(shouldNotifyWatch({...candidate,patternConfirmedAt:now-76*60000},config),false);
 assert.equal(shouldNotifyWatch({...candidate,patternConfirmed:false},config),false);
 assert.equal(shouldNotifyWatch({...candidate,patternTimeframe:'4h'},config),false);
 assert.equal(shouldNotifyWatch({...candidate,patternTimeframe:undefined},config),false);
 assert.equal(shouldNotifyWatch({...candidate,status:'signal',qualified:true},config),false);
 assert.equal(shouldNotifyWatch({...candidate,qualified:true},config),false);
 assert.equal(shouldNotifyWatch({...candidate,symbol:'BTCUSDT'},config),false);
 assert.equal(shouldNotifyWatch({...candidate,symbol:'BTCUSDT'},{...config,altOnly:false}),false);
});
test('watch key deduplicates the confirmed close despite repeated scans and mutable scan timestamps',()=>{
 assert.equal(watchAlertKey(candidate),'watch:SOLUSDT:LONG:상승 추세 눌림목:'+candidate.patternConfirmedAt);
 assert.equal(watchAlertKey(candidate),watchAlertKey({...candidate,time:now+1000,scannedAt:now+1000}));
 assert.notEqual(watchAlertKey(candidate),watchAlertKey({...candidate,patternConfirmedAt:candidate.patternConfirmedAt+3600000}));
});
test('watch message uses Binance-only links, the single score, indicators and explicit no-order labels',()=>{
 const urls={binance:'https://www.binance.com/en/futures/SOLUSDT'},payload=telegramWatchMessage(candidate,urls);
 assert.match(payload.text,/관찰 알림 · 최종 신호 아님/);assert.match(payload.text,/종합 평가 점수: 85\/100/);
 assert.doesNotMatch(payload.text,/60:40|보조지표:.*\/100|Variational/);assert.match(payload.text,/RSI/);
 assert.match(payload.text,/승률이 아닙니다/);assert.match(payload.text,/거래량 미달/);
 assert.equal(payload.reply_markup.inline_keyboard.length,1);assert.equal(payload.reply_markup.inline_keyboard[0][0].url,urls.binance);
 assert.throws(()=>telegramWatchMessage(candidate,null));assert.throws(()=>telegramWatchMessage(candidate,{binance:'https://evil.invalid'}));
});
test('unavailable scores and legacy indicator arithmetic never substitute zero or a legacy score',()=>{
 const config={minScore:80,verified:true,now};
 for(const row of [{...candidate,score:null},{...candidate,score:NaN},{...candidate,scoreVersion:'INDICATOR-V1'},
  {...candidate,indicators:{valid:false,score:null}}])assert.equal(shouldNotifyWatch(row,config),false);
 assert.throws(()=>telegramWatchMessage({...candidate,score:null},{binance:'https://www.binance.com/en/futures/SOLUSDT'}));
});
