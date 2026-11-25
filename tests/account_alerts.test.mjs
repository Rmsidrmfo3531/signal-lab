import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {AccountAlerts,formatDailyReport,kstDay} from '../account_alerts.mjs';
import {copyHTML} from '../public/live_control.js';

const tmp=()=>fs.mkdtempSync(path.join(os.tmpdir(),'signal-lab-alerts-'));

test('combined manual + copy risk alerts (#2) fire once per tier with hysteresis and cooldown',async()=>{
 let now=1795000000000;
 const sent=[];
 const alerts=new AccountAlerts({now:()=>now,sendText:async t=>{sent.push(t);return {ok:true}}});

 // 55% margin usage across 1 copy + 1 manual -> triggers 50% tier once
 const positions=[
  {symbol:'BTCUSDT',venueSymbol:'BTC-USDT',direction:'LONG',origin:'manual',margin:1000,unrealized:-150},
  {symbol:'ETHUSDT',venueSymbol:'ETH-USDT',direction:'SHORT',origin:'copy',margin:650,unrealized:-200},
 ];
 const first=await alerts.checkRisk({equityUSD:3000,positions,now});
 assert.equal(first.length,2,'margin >= 50% AND loss >= 10% both fire');
 assert.match(sent[0],/증거금 사용률 55\.0% \(기준 50%\)/);
 assert.match(sent[1],/합산 미실현 −\$350\.00 \(−11\.7%, 기준 −10%\)/);

 // Same state 1 minute later: no spam
 now+=60000;
 assert.equal((await alerts.checkRisk({equityUSD:3000,positions,now})).length,0);

 // Escalates to 72% margin -> fires 70% tier immediately
 positions[0].margin=1510;
 now+=60000;
 const escalated=await alerts.checkRisk({equityUSD:3000,positions,now});
 assert.equal(escalated.length,1);
 assert.match(escalated[0].text,/기준 70%/);

 // Recovers below 45% (50 - 5) and waits cooldown -> re-arms and fires again on next spike
 now+=35*60000;
 await alerts.checkRisk({equityUSD:3000,positions:[{...positions[0],margin:500,unrealized:0}],now});
 now+=60000;
 const again=await alerts.checkRisk({equityUSD:3000,positions:[{...positions[0],margin:1600,unrealized:0}],now});
 assert.equal(again.length,1);
});

test('position ROI milestones (#7) alert for manual and copy and reset once position closes',async()=>{
 const sent=[];
 const alerts=new AccountAlerts({sendText:async t=>{sent.push(t);return {ok:true}}});

 // Jumps straight to +115% -> sends highest crossed tier (+100%) only, not +50% + +100%
 const hit1=await alerts.checkPositions({positions:[{symbol:'BTCUSDT',venueSymbol:'BTC-USDT',direction:'LONG',origin:'manual',avg:60000,mark:61000,margin:100,unrealized:115,roePct:115}]});
 assert.equal(hit1.length,1);assert.equal(hit1[0].tier,100);
 assert.match(sent[0],/수동 BTCUSDT 🟢 롱[\s\S]*\+115\.0%[\s\S]*기준 \+100%/);

 // Same open position at +120% -> already passed 100%, below 200% -> silent
 assert.equal((await alerts.checkPositions({positions:[{symbol:'BTCUSDT',venueSymbol:'BTC-USDT',direction:'LONG',origin:'manual',avg:60000,mark:61200,margin:100,unrealized:120,roePct:120}]})).length,0);

 // Position closes -> state clears; reopened position at -55% triggers loss warning
 await alerts.checkPositions({positions:[]});
 const lossHit=await alerts.checkPositions({positions:[{symbol:'BTCUSDT',venueSymbol:'BTC-USDT',direction:'LONG',origin:'copy',avg:60000,mark:59500,margin:100,unrealized:-55,roePct:-55}]});
 assert.equal(lossHit.length,1);assert.equal(lossHit[0].kind,'loss');assert.equal(lossHit[0].tier,50);
 assert.match(lossHit[0].text,/카피 BTCUSDT[\s\S]*−55\.0%/);
});

test('daily KST closing report (#5) sends once after midnight and persists across restart',async()=>{
 const dir=tmp();
 try{
  // 2026-11-20 00:05 KST = 2026-11-19T15:05:00Z
  const midnightKst=Date.parse('2026-11-19T15:05:00Z');
  const prevTradeAt=Date.parse('2026-11-19T10:00:00Z'); // 2026-11-19 19:00 KST
  const sent=[];
  const alerts=new AccountAlerts({directory:dir,now:()=>midnightKst,sendText:async t=>{sent.push(t);return {ok:true}}});

  const payload={
   copyClosed:[{closedAt:prevTradeAt,netSource:'EXCHANGE_FILLS',netUSD:28.5},{closedAt:prevTradeAt+1000,netSource:'EXCHANGE_FILLS',netUSD:-5}],
   manualClosed:[{closedAt:prevTradeAt+2000,netSource:'EXCHANGE',netUSD:13.65}],
   dailyByDay:{'2026-11-19':37.15},
   equityUSD:3122.72,openCount:1,now:midnightKst,
  };
  const r1=await alerts.checkDailyReport(payload);
  assert.equal(r1.sent,true);assert.equal(r1.day,'2026-11-19');
  assert.match(sent[0],/일일 마감 리포트 · 2026-11-19 KST/);
  assert.match(sent[0],/거래소 실현 합계: \+\$37\.15/);
  assert.match(sent[0],/카피: 2건 · 승률 50% · \+\$23\.50/);
  assert.match(sent[0],/수동: 1건 · 승률 100% · \+\$13\.65/);

  // Restart on the same day: must not resend
  const reloaded=new AccountAlerts({directory:dir,now:()=>midnightKst+60000,sendText:async t=>{sent.push(t);return {ok:true}}});
  const r2=await reloaded.checkDailyReport({...payload,now:midnightKst+60000});
  assert.equal(r2.sent,false);assert.equal(r2.reason,'ALREADY_SENT');
  assert.equal(sent.length,1);

  // On-demand report (force: true) summarizes today
  const r3=await reloaded.checkDailyReport({...payload,now:midnightKst+60000,force:true});
  assert.equal(r3.sent,true);assert.equal(r3.day,kstDay(midnightKst+60000));
  assert.match(r3.text,/오늘 중간 리포트/);
 }finally{fs.rmSync(dir,{recursive:true,force:true})}
});

test('copy skip alert throttling (#8) deduplicates within 5 min and respects toggle',()=>{
 let now=1795000000000;
 const alerts=new AccountAlerts({now:()=>now});
 const ev={type:'SKIPPED',symbol:'IRYSUSDT',direction:'SHORT',reason:'VENUE_POSITION_EXISTS'};
 assert.equal(alerts.shouldSendSkip(ev,now),true);
 assert.equal(alerts.shouldSendSkip(ev,now+60000),false,'deduplicated within 5m');
 assert.equal(alerts.shouldSendSkip(ev,now+5*60000+1),true,'allowed after 5m');
 assert.equal(alerts.shouldSendSkip({type:'SKIPPED',symbol:'BTCUSDT',reason:'NOT_COPIED'},now),false,'noisy skip ignored');
 alerts.configure({skipAlerts:false});
 assert.equal(alerts.shouldSendSkip({type:'ADD_SKIPPED',symbol:'ETHUSDT',reason:'COPY_MARGIN_CAP'},now),false,'toggle off suppresses');
});

test('Telegram bot remote commands (#6) enforce private chat auth, 2-step close confirmation, and update offset persistence',async()=>{
 const dir=tmp();
 try{
  let now=1795000000000,paused=0,resumed=0,closed=[];
  const replies=[];
  const updates=[
   {update_id:101,message:{chat:{id:999999,type:'private'},date:Math.floor(now/1000),text:'/pause'}}, // unauthorized chat!
   {update_id:102,message:{chat:{id:123456,type:'private'},date:Math.floor(now/1000),text:'/status'}},
   {update_id:103,message:{chat:{id:123456,type:'private'},date:Math.floor(now/1000),text:'/pause'}},
   {update_id:104,message:{chat:{id:123456,type:'private'},date:Math.floor(now/1000),text:'/resume'}},
   {update_id:105,message:{chat:{id:123456,type:'private'},date:Math.floor(now/1000),text:'/close eth short'}},
  ];
  const post=async(payload,{method='sendMessage'}={})=>{
   if(method==='getUpdates')return {ok:true,status:200,headers:{get:()=>null},json:async()=>({ok:true,result:updates.splice(0)})};
   replies.push(payload);
   return {ok:true,status:200,headers:{get:()=>null},json:async()=>({ok:true,result:{message_id:replies.length}})};
  };
  const alerts=new AccountAlerts({
   directory:dir,now:()=>now,allowedChatId:'123456',post,
   getSnapshot:async()=>({equityUSD:3080.5,availableUSD:2900,positions:[{symbol:'ETHUSDT',direction:'SHORT',origin:'copy',leverage:80,margin:40,unrealized:12.5,roePct:31.2}],copy:{enabled:true,armed:true,traderBalanceUSD:20000}}),
   onPause:async()=>{paused++},
   onResume:async()=>{resumed++},
   onClose:async req=>{closed.push(req);return {ok:true,summary:`${req.symbol} ${req.direction} 청산 완료`}},
  });

  await alerts.pollCommands();
  assert.equal(paused,1,'only authorized /pause ran');
  assert.equal(resumed,0,'/resume waits for /confirm (decision 2026-11-23 (c))');
  assert.match(replies[2].text,/카피 재개 확인[\s\S]*화면에서만 해제/);
  assert.equal(closed.length,0,'/close must NOT execute without /confirm');
  assert.equal(replies.length,4);
  assert.match(replies[0].text,/실계좌 현황[\s\S]*3,080\.50/);
  assert.match(replies[3].text,/\/confirm (\d{4})/);

  const code=replies[3].text.match(/\/confirm (\d{4})/)[1];
  // Wrong code rejected
  const bad=await alerts.handleCommand('/confirm 0000','123456',now+5000);
  assert.match(bad,/일치하지 않습니다/);
  assert.equal(closed.length,0);

  // Correct code executes once and invalidates
  const ok=await alerts.handleCommand(`/confirm ${code}`,'123456',now+10000);
  assert.match(ok,/청산 완료/);
  assert.deepEqual(closed,[{symbol:'ETHUSDT',direction:'SHORT'}]);
  const replay=await alerts.handleCommand(`/confirm ${code}`,'123456',now+11000);
  assert.match(replay,/없거나 만료/);
  assert.equal(closed.length,1);

  // Reloading preserves lastUpdateId
  const reloaded=new AccountAlerts({directory:dir,now:()=>now,allowedChatId:'123456'});
  assert.equal(reloaded.store.lastUpdateId,105);
 }finally{fs.rmSync(dir,{recursive:true,force:true})}
});

test('copyHTML renders accountAlerts panel on LIVE',()=>{
 const html=copyHTML({
  mode:'LIVE',enabled:true,armed:true,sizing:'BALANCE_RATIO',traderBalanceUSD:20000,
  maxAdds:100,maxTotalMarginPct:100,ledgerLossPct:50,positions:[],closed:[],events:[],
  accountAlerts:{riskAlerts:true,marginWarnPcts:[50,70],lossWarnPcts:[10,20],dailyReport:true,roiAlerts:true,profitRoiPcts:[50,100],lossRoiPcts:[30,50],positionSummaryAlerts:true,positionSummaryIntervalMin:30,skipAlerts:true,remoteCommands:true},
 });
 assert.match(html,/텔레그램 알림 · 위험 경보/);
 assert.match(html,/data-account-alerts-form/);
 assert.match(html,/data-send-position-summary/);
 assert.match(html,/data-send-daily-report/);
 assert.equal(typeof formatDailyReport,'function');
});

test('open-position PnL summary sends clean readable Telegram list (no code block), respects interval cooldown, and supports /pos command',async()=>{
 const {formatPositionPnlLine,formatPositionsSummary}=await import('../account_alerts.mjs');
 const positions=[
  {symbol:'NCSKSNDK2USDUSDT',direction:'SHORT',unrealized:-45.2,margin:544.58},
  {symbol:'BTCUSDT',direction:'LONG',unrealized:100.11,roePct:12.5},
 ];
 assert.equal(formatPositionPnlLine(positions[1]),'🟢 <b>BTCUSDT</b> [롱]   +$100.11 (+12.5%)');
 assert.equal(formatPositionPnlLine(positions[0]),'🔴 <b>SNDKUSDT</b> [숏]   -$45.20 (-8.3%)');
 const summary=formatPositionsSummary(positions);
 assert.doesNotMatch(summary,/<pre>|<code>/);
 assert.equal(
  summary,
  '📊 <b>진행 중 포지션 (2개)</b> · 합계 <b>+$54.91</b>\n\n🟢 <b>BTCUSDT</b> [롱]   +$100.11 (+12.5%)\n🔴 <b>SNDKUSDT</b> [숏]   -$45.20 (-8.3%)'
 );

 const dir=tmp();
 try{
  let now=1795000000000;
  const sent=[];
  const alerts=new AccountAlerts({
   directory:dir,now:()=>now,allowedChatId:'123456',
   sendText:async t=>{sent.push(t);return {ok:true}},
   getSnapshot:async()=>({equityUSD:5000,availableUSD:4200,positions,copy:{enabled:true,armed:true,traderBalanceUSD:20000}}),
  });
  // No positions -> silent
  assert.equal((await alerts.checkPositionSummary({positions:[],now})).sent,false);
  // First periodic check with open positions -> sends (default 5m interval)
  assert.equal(alerts.status().positionSummaryIntervalMin,5);
  const r1=await alerts.checkPositionSummary({positions,now});
  assert.equal(r1.sent,true);assert.equal(r1.count,2);
  assert.equal(sent.length,1);
  assert.equal(sent[0],summary);
  // Within 5m cooldown -> suppressed
  now+=3*60000;
  assert.equal((await alerts.checkPositionSummary({positions,now})).reason,'COOLDOWN');
  // After 5m cooldown with unchanged PnL (<$2 delta, <30m heartbeat) -> suppressed as UNCHANGED
  now+=3*60000;
  assert.equal((await alerts.checkPositionSummary({positions,now})).reason,'UNCHANGED');
  // Once PnL shifts by >=$2 -> sends immediately
  const moved=[positions[0],{...positions[1],unrealized:103.5}];
  assert.equal((await alerts.checkPositionSummary({positions:moved,now})).sent,true);
  assert.equal(sent.length,2);
  // Even without PnL movement, sends again on 30m heartbeat
  now+=31*60000;
  assert.equal((await alerts.checkPositionSummary({positions:moved,now})).sent,true);
  assert.equal(sent.length,3);
  // /pos command returns clean list immediately, and /pos 3 updates interval to 3 min
  const reply=await alerts.handleCommand('/pos','123456',now);
  assert.equal(reply,summary);
  const setRes=await alerts.handleCommand('/pos 3','123456',now);
  assert.match(setRes,/3분/);
  assert.equal(alerts.status().positionSummaryIntervalMin,3);
  // Legacy uncustomized 30m store auto-migrates to 5m on reload
  fs.writeFileSync(path.join(dir,'legacy-alerts.json'),JSON.stringify({version:1,positionSummaryAlerts:true,positionSummaryIntervalMin:30}));
  const migrated=new AccountAlerts({directory:dir,fileName:'legacy-alerts.json',now:()=>now});
  assert.equal(migrated.status().positionSummaryIntervalMin,5);
  // Toggle off suppresses periodic sends (force still works)
  alerts.configure({positionSummaryAlerts:false,positionSummaryIntervalMin:15});
  now+=20*60000;
  assert.equal((await alerts.checkPositionSummary({positions,now})).reason,'DISABLED');
  assert.equal((await alerts.checkPositionSummary({positions,now,force:true})).sent,true);
 }finally{fs.rmSync(dir,{recursive:true,force:true})}
});

test('#10 Telegram /panic (/비상청산) requires 2-step /confirm within 60s and invokes onPanic',async()=>{
 let now=1795000000000,panicCalls=0;
 const alerts=new AccountAlerts({
  now:()=>now,
  allowedChatId:'123456',
  onPanic:async()=>{panicCalls++;return {ok:true,summary:'전체 자동매매 중지 + 미체결 2건 취소 + 포지션 1건 청산'}},
 });
 const help=await alerts.handleCommand('/help','123456',now);
 assert.match(help,/\/panic/);

 const ask=await alerts.handleCommand('/panic','123456',now);
 assert.match(ask,/비상 일괄 청산 확인/);
 const code=ask.match(/\/confirm (\d{4})/)?.[1];
 assert.ok(code);
 assert.equal(panicCalls,0);

 // Wrong code rejected without executing
 const bad=await alerts.handleCommand('/confirm 0000','123456',now);
 assert.match(bad,/일치하지 않습니다/);
 assert.equal(panicCalls,0);

 // Valid code executes onPanic once
 const ok=await alerts.handleCommand(`/confirm ${code}`,'123456',now);
 assert.match(ok,/비상 일괄 청산 완료/);
 assert.equal(panicCalls,1);

 // Expiry after 60s
 const ask2=await alerts.handleCommand('/비상청산','123456',now);
 const code2=ask2.match(/\/confirm (\d{4})/)?.[1];
 now+=61000;
 const exp=await alerts.handleCommand(`/confirm ${code2}`,'123456',now);
 assert.match(exp,/만료되었습니다/);
 assert.equal(panicCalls,1);

 // Unwired onPanic returns clear message
 const unwired=new AccountAlerts({now:()=>now,allowedChatId:'123456'});
 assert.match(await unwired.handleCommand('/panic','123456',now),/연결되어 있지 않습니다/);
});

