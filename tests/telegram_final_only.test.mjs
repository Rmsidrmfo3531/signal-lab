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
 assert.equal((server.match(/api\.telegram\.org\/bot/g)||[]).length,1,'one Telegram transport');
 // Callers of the transport: final signals, opt-in simulation notices (paper entries/closes) and the
 // daily testnet readiness report (live_readiness.mjs: results only, no signals) and live trade
 // notices (live_telegram.mjs: entry/add/target/close/problems of orders already placed) — nothing else.
 // + the testnet reversal-scalp notices (scalp_telegram.mjs: entry/close/problems, guarded by the live-notice setting).
 // 8: + the automatic-update notice (2026-11-16).
 assert.deepEqual([...server.matchAll(/(?<!function )telegramPost\(/g)].length,8);
 assert.match(server,/function updateNotice\(text\)\{try\{if\(CONFIG\.tgToken&&CONFIG\.tgChat\)telegramPost\(/);
 assert.match(server,/const text=scalpEventText\(e\);if\(!text\)return;[\s\S]{0,400}?telegramLive===false[\s\S]{0,200}?telegramPost\(\{chat_id:CONFIG\.tgChat,text\}\)/);
 // A one-time warning when the copy mode changed with open copies on the other ledger.
 assert.match(server,/카피 모드가 \$\{COPY\.mode==='LIVE'\?'실계좌':'테스트넷'\}로 바뀌었습니다/);
 // The copy-trading notice (copy_telegram.mjs text only, guarded by the live-notice setting).
 assert.match(server,/const text=copyEventText\(e\);if\(!text\)return;[\s\S]{0,400}?telegramLive===false[\s\S]{0,200}?telegramPost\(\{chat_id:CONFIG\.tgChat,text\}\)/);
 assert.match(server,/const text=liveEventText\(record,type,detail\);if\(!text\)return;[\s\S]{0,400}?telegramPost\(\{chat_id:CONFIG\.tgChat,text\}\)/);
 assert.match(server,/telegramPost\(\{chat_id:CONFIG\.tgChat,text:readinessText\(r\)\}\)/);
 assert.match(server,/const r=await telegramPost\(payload\)/);
 assert.match(server,/void telegramPost\(\{chat_id:CONFIG\.tgChat,text,/);
 assert.match(server,/if\(!paperTelegramOn\(\)\|\|!CONFIG\.tgToken\|\|!CONFIG\.tgChat\)return/);
 assert.match(server,/persisted\.paperNotify\.telegram=persisted\.paperNotify\.telegram===true/,'paper Telegram is opt-in');
 assert.match(server,/finalTelegramMatch\(s,relevantSignals\(\),getSignalScorePolicy\(\)\.finalMinScore\)/);
 assert.match(server,/telegramMessage\(matched,urls,\{paperPosition\}\)/);
 assert.doesNotMatch(server,/tgWatch\(|tgNews\(|telegramWatchMessage\(/);
 assert.doesNotMatch(server,/TELEGRAM_NEWS_ALERTS|TELEGRAM_SCORE_WATCH_ENABLED/);
});
