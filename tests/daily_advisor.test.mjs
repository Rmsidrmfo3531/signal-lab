import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {buildImprovementAdvice,formatAdvisorTelegram,DailyAdvisor} from '../daily_advisor.mjs';
import {AccountAlerts} from '../account_alerts.mjs';
import {advisorHTML} from '../public/live_control.js';

const NOW=Date.parse('2026-11-22T01:00:00Z'); // 2026-11-22 10:00 KST

function sampleContext(overrides={}){
 return {
  now:NOW,
  copyClosed:[
   {symbol:'ETHUSDT',leverage:50,netUSD:140,netSource:'EXCHANGE_FILLS',closedAt:NOW-500000},
   {symbol:'ETHUSDT',leverage:50,netUSD:120,netSource:'EXCHANGE_FILLS',closedAt:NOW-400000},
   {symbol:'ETHUSDT',leverage:50,netUSD:107.74,netSource:'EXCHANGE_FILLS',closedAt:NOW-300000},
   {symbol:'AKEUSDT',leverage:10,netUSD:39.11,netSource:'EXCHANGE_FILLS',closedAt:NOW-200000},
  ],
  manualClosed:[
   {symbol:'ETHUSDT',leverage:50,netUSD:-160,netSource:'EXCHANGE',closedAt:NOW-450000},
   {symbol:'ETHUSDT',leverage:50,netUSD:-205.44,netSource:'EXCHANGE',closedAt:NOW-350000},
   {symbol:'BTCUSDT',leverage:50,netUSD:-64.39,netSource:'EXCHANGE',closedAt:NOW-250000},
   {symbol:'SOLUSDT',leverage:10,netUSD:47.76,netSource:'EXCHANGE',closedAt:NOW-150000},
  ],
  copyEvents:[
   {type:'SKIPPED',at:NOW-3600000,symbol:'BTCUSDT',reason:'NOT_COPIED',cause:'VENUE_POSITION_EXISTS'},
   {type:'ADD_SKIPPED',at:NOW-1800000,symbol:'BTCUSDT',reason:'COPY_AUDIT_BLOCKED'},
   {type:'ADD_SKIPPED',at:NOW-900000,symbol:'BTCUSDT',reason:'COPY_AUDIT_BLOCKED'},
  ],
  realEquityUSD:3025.79,
  realSafety:{enabled:false},
  realTrailing:{enabled:false},
  accountAlerts:{positionSummaryAlerts:true,positionSummaryIntervalMin:5},
  scalpStats:{
   all:{trades:34,wins:27,winRatePct:79.41,profitFactor:0.17,netUSD:-8075.58,avgHoldMin:658,avgMaeR:-3.65},
   byExitReason:{
    EARLY_TAKE_PROFIT:{trades:27,wins:26,winRatePct:96.3,netUSD:1645.98},
    MANUAL:{trades:6,wins:1,winRatePct:16.67,netUSD:-9651.06,avgHoldMin:2109},
   },
  },
  scalpRuntime:{mode:'TESTNET',armed:true,blocked:'DAILY_LOSS_LIMIT',skipCounts:{UNRESOLVED_ORDER_STATE:5}},
  testnetBudget:{capitalCapUSD:3000,dailyLossPct:100,balanceError:null},
  testnetScalpOnly:true,
  paperTrading:false,
  copyTestnetTrades:0,
  ...overrides,
 };
}

test('buildImprovementAdvice classifies Add, Improve, and Remove items from both real-account and testnet records',()=>{
 const advice=buildImprovementAdvice(sampleContext());
 const ids=new Set(advice.items.map(x=>x.id));

 // Add recommendations
 assert.ok(ids.has('real:enable-safety-guard'),'suggests enabling real safety guard');
 assert.ok(ids.has('scalp:max-hold-hard-stop'),'suggests adding max-hold / hard-stop on testnet scalp');
 assert.ok(advice.add.length>=2);

 // Improve recommendations
 assert.ok(ids.has('real:copy-vs-manual-gap'),'flags copy vs manual divergence');
 assert.ok(ids.has('real:manual-high-leverage'),'flags 20x+ manual leverage loss concentration');
 assert.ok(ids.has('real:venue-position-exists-skips'),'flags manual overlap blocking copy entries');
 assert.ok(ids.has('real:copy-audit-blocked'),'flags repeated COPY_AUDIT_BLOCKED');
 assert.ok(ids.has('scalp:blocked-daily_loss_limit'),'flags active testnet scalp DAILY_LOSS_LIMIT block');

 // Remove recommendations
 assert.ok(ids.has('real:overlap-ethusdt'),'recommends stopping manual ETHUSDT trading where copy is profitable');
 assert.ok(ids.has('ui:pos-summary-frequency'),'suggests easing 5m summary frequency');
 assert.ok(ids.has('ui:prune-unused-testnet-folds'),'flags unused testnet signal folds for UI cleanup');

 const msg=formatAdvisorTelegram(advice,{mode:'daily'});
 assert.match(msg,/🧭 \[Signal Lab 매일 매매·UI 개선 코치\] 2026-11-22 KST/);
 assert.match(msg,/➕ 추가 추천/);
 assert.match(msg,/🔧 개선 추천/);
 assert.match(msg,/🗑 삭제·정리 추천/);
 assert.match(msg,/\/coach/);

 const html=advisorHTML({...advice,config:{enabled:true,dailyHourKst:9,realtimeAlerts:true}});
 assert.match(html,/data-advisor-notify/);
 assert.match(html,/➕ 추가 추천/);
 assert.match(html,/🔧 개선 추천/);
 assert.match(html,/🗑 삭제·정리 추천/);
});

test('DailyAdvisor stays silent on empty sandbox, sends daily digest once per KST day at >= 09:00, and deduplicates realtime HIGH alerts',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'adv-'));
 const sent=[];
 let clock=Date.parse('2026-11-21T23:30:00Z'); // 2026-11-22 08:30 KST
 const advisor=new DailyAdvisor({directory:dir,now:()=>clock,sendText:async text=>{sent.push(text);return {ok:true}}});

 // 1) Fresh empty sandbox: completely silent (neither daily nor realtime sends)
 assert.equal((await advisor.checkDaily({now:clock})).sent,false);
 assert.equal((await advisor.checkRealtime({now:clock})).sent,false);
 assert.equal(sent.length,0);

 // 2) Fresh instance with real trading records before 09:00 KST -> waits until 09:00 KST
 const dir2=fs.mkdtempSync(path.join(os.tmpdir(),'adv2-'));
 const adv2=new DailyAdvisor({directory:dir2,now:()=>clock,sendText:async text=>{sent.push(text);return {ok:true}}});
 assert.equal((await adv2.checkDaily(sampleContext({now:clock}))).reason,'BEFORE_HOUR');
 // Baseline init for realtime does not spam on first boot
 assert.equal((await adv2.checkRealtime(sampleContext({now:clock}))).reason,'BASELINE_INITIALIZED');
 assert.equal(sent.length,0);

 // 3) At 09:05 KST -> daily digest fires once
 clock=Date.parse('2026-11-22T00:05:00Z'); // 09:05 KST
 const dailyRes=await adv2.checkDaily(sampleContext({now:clock}));
 assert.equal(dailyRes.sent,true);
 assert.equal(sent.length,1);
 assert.equal((await adv2.checkDaily(sampleContext({now:clock+60000}))).reason,'ALREADY_SENT');

 // 4) New HIGH issue appears later (balance error) -> triggers single realtime alert
 const withNewHigh=sampleContext({now:clock+120000,testnetBudget:{capitalCapUSD:3000,dailyLossPct:100,balanceError:'BALANCE_UNAVAILABLE'}});
 const rtRes=await adv2.checkRealtime(withNewHigh);
 assert.equal(rtRes.sent,true);
 assert.equal(rtRes.count,1);
 assert.match(rtRes.text,/⚡ \[Signal Lab 실시간 개선 감지\]/);
 assert.match(rtRes.text,/BALANCE_UNAVAILABLE/);
 // Repeating immediately is deduplicated for 24h
 assert.equal((await adv2.checkRealtime(sampleContext({now:clock+180000,testnetBudget:{capitalCapUSD:3000,dailyLossPct:100,balanceError:'BALANCE_UNAVAILABLE'}}))).reason,'NO_NEW_HIGH');
});

test('Telegram /coach command returns live coaching report and is listed in /help',async()=>{
 const alerts=new AccountAlerts({
  allowedChatId:'777',
  getAdvisorReply:async()=>formatAdvisorTelegram(buildImprovementAdvice(sampleContext()),{mode:'ondemand'}),
 });
 const help=await alerts.handleCommand('/help','777',NOW);
 assert.match(help,/\/coach/);
 const coach=await alerts.handleCommand('/개선','777',NOW);
 assert.match(coach,/🧭 \[Signal Lab 실시간 매매·UI 개선 코치\]/);
 assert.match(coach,/실계좌 카피/);
});
