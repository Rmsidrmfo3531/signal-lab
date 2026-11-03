import test from 'node:test';
import assert from 'node:assert/strict';
import {watchMinScore,shouldNotifyWatch,watchAlertKey,telegramWatchMessage} from '../telegram_watch.mjs';

const now=Date.parse('2026-11-04T00:00:00Z');
const candidate={symbol:'SOLUSDT',direction:'LONG',pattern:'상승 추세 눌림목',score:85,
 patternConfirmed:true,patternConfirmedAt:now-20000,time:now-3600000,status:'watch',
 qualified:false,volumeRatio:1.4,executionStatus:'실매매 검증 보류',quality:{failed:['거래량 미달']}};

test('disabled by default; reject invalid and out-of-range thresholds',()=>{
 for(const value of [undefined,'',0,-1,101,'abc',80.5])assert.equal(watchMinScore(value),0);
 assert.equal(watchMinScore('80'),80);
 assert.equal(shouldNotifyWatch(candidate,{verified:true,now}),false);
});
test('valid, fresh, verified altcoin pattern with score >= threshold notifies',()=>{
 assert.equal(shouldNotifyWatch(candidate,{minScore:80,verified:true,now}),true);
 assert.equal(shouldNotifyWatch(candidate,{minScore:90,verified:true,now}),false);
 assert.equal(shouldNotifyWatch({...candidate,score:80},{minScore:80,verified:true,now}),true);
});
test('never notify stale, unverified or strict final signals',()=>{
 const config={minScore:80,verified:true,now};
 assert.equal(shouldNotifyWatch(candidate,{...config,verified:false}),false);
 assert.equal(shouldNotifyWatch({...candidate,patternConfirmedAt:now-76*60000},config),false);
 assert.equal(shouldNotifyWatch({...candidate,patternConfirmed:false},config),false);
 assert.equal(shouldNotifyWatch({...candidate,status:'signal',qualified:true},config),false);
 assert.equal(shouldNotifyWatch({...candidate,qualified:true},config),false);
 assert.equal(shouldNotifyWatch({...candidate,symbol:'BTCUSDT'},config),false);
 assert.equal(shouldNotifyWatch({...candidate,symbol:'BTCUSDT'}, {...config,altOnly:false}),true);
});
test('watch alerts persistently deduplicate by pattern and closed candle',()=>{
 assert.equal(watchAlertKey(candidate),'watch:SOLUSDT:LONG:상승 추세 눌림목:'+candidate.time);
 assert.notEqual(watchAlertKey(candidate),watchAlertKey({...candidate,time:candidate.time+3600000}));
});
test('message labels research only, lists failed checks and verified market links',()=>{
 const urls={variational:'https://omni.variational.io/perpetual/SOL',binance:'https://www.binance.com/en/futures/SOLUSDT'};
 const payload=telegramWatchMessage(candidate,urls);
 assert.match(payload.text,/관찰용 · 매매 신호 아님/);
 assert.match(payload.text,/85\/100/);
 assert.match(payload.text,/승률이 아닙니다/);
 assert.match(payload.text,/거래량 미달/);
 assert.equal(payload.reply_markup.inline_keyboard[1][0].url,urls.binance);
 assert.throws(()=>telegramWatchMessage(candidate,null));
});
