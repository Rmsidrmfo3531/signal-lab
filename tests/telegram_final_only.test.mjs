import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {finalTelegramMatch} from '../telegram_final.mjs';

const base={symbol:'SOLUSDT',direction:'LONG',pattern:'confirmed breakout',
 time:1762400000000,patternConfirmedAt:1762400000000,score:93,
 status:'signal',qualified:true,decision:{ready:true}};
const candidates=[base];

test('Telegram only permits an exact current final-screen signal at the configured threshold',()=>{
 assert.equal(finalTelegramMatch(base,candidates,90),base);
 assert.equal(finalTelegramMatch(base,candidates,94),null);
 for(const altered of [
   {...base,score:85},{...base,status:'watch'},{...base,qualified:false},
   {...base,decision:{ready:false}},{...base,score:null},
   {...base,patternConfirmedAt:base.patternConfirmedAt-3600000},
   {...base,time:base.time-3600000},{...base,direction:'SHORT'}
 ])assert.equal(finalTelegramMatch(base,[altered],90),null);
 assert.equal(finalTelegramMatch({...base,pattern:'different'},candidates,90),null);
 assert.equal(finalTelegramMatch(base,[],90),null);
 assert.equal(finalTelegramMatch(base,candidates,80),null,'lower threshold must never enable notifications');
});

test('server contains a single Telegram delivery path guarded by live final results',()=>{
 const server=fs.readFileSync(new URL('../server.mjs',import.meta.url),'utf8');
 assert.equal((server.match(/api\.telegram\.org\/bot/g)||[]).length,1,'only final signals may call Telegram');
 assert.match(server,/finalTelegramMatch\(s,relevantSignals\(\),getSignalScorePolicy\(\)\.finalMinScore\)/);
 assert.match(server,/telegramMessage\(matched,urls,F\)/);
 assert.doesNotMatch(server,/tgWatch\(|tgNews\(|telegramWatchMessage\(/);
 assert.doesNotMatch(server,/TELEGRAM_NEWS_ALERTS|TELEGRAM_SCORE_WATCH_ENABLED/);
});
