import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {scalpGroupReadiness,pumpReadiness,evaluateReadiness,splitHalves,readinessLine,readinessMessage,readyReplyText,ReadinessNotifier,
 READY_SCALP_MIN_TRADES,READY_SCALP_MIN_PROFIT_FACTOR,READY_SCALP_MAX_BIG_LOSS_X,READY_PUMP_MIN_TRACKED,READY_NOT_AUTOMATIC,READY_FILE} from '../ready_check.mjs';
import {AccountAlerts} from '../account_alerts.mjs';
import {liveReadinessHTML} from '../public/live_control.js';

const tmp=()=>fs.mkdtempSync(path.join(os.tmpdir(),'signal-lab-ready-'));
const T0=Date.parse('2026-11-16T00:00:00Z');
// n trades of one side, closedAt ascending; wins of +win each except every lossEvery-th trade loses `loss`.
function trades(n,{direction='SHORT',win=2,loss=1,lossEvery=4,start=T0,reason='EARLY_TAKE_PROFIT'}={}){
 return Array.from({length:n},(_,i)=>({direction,closedAt:start+i*60000,closeReason:(i+1)%lossEvery===0?'MAX_HOLD_EXIT':reason,netUSD:(i+1)%lossEvery===0?-loss:win}));
}

test('criteria constants are the agreed values',()=>{
 assert.equal(READY_SCALP_MIN_TRADES,100);assert.equal(READY_SCALP_MIN_PROFIT_FACTOR,1.3);assert.equal(READY_SCALP_MAX_BIG_LOSS_X,5);assert.equal(READY_PUMP_MIN_TRACKED,50);
});

test('A1 trade count: 99 fails, 100 passes (no day requirement)',()=>{
 const g99=scalpGroupReadiness(trades(99),{group:'SCALP_SHORT'});
 assert.equal(g99.checks.trades,false);assert.equal(g99.ready,false);
 const g100=scalpGroupReadiness(trades(100),{group:'SCALP_SHORT'});
 assert.equal(g100.checks.trades,true);assert.equal(g100.ready,true,'all criteria met on count alone');
 assert.equal(g100.progress,1);
 assert.ok(!('days' in g100.checks));
 assert.doesNotMatch(g100.line,/일/);
});

test('A2 profit factor: exactly 1.3 passes, just below fails',()=>{
 // 100 trades: 50 wins of w, 50 losses of 1 → PF = w.
 const mk=w=>Array.from({length:100},(_,i)=>({direction:'LONG',closedAt:T0+i,closeReason:'X',netUSD:i%2?-1:w}));
 assert.equal(scalpGroupReadiness(mk(1.3),{group:'SCALP_LONG'}).checks.profitFactor,true);
 assert.equal(scalpGroupReadiness(mk(1.2999),{group:'SCALP_LONG'}).checks.profitFactor,false);
 const noLoss=scalpGroupReadiness(trades(100,{lossEvery:1e9}),{group:'SCALP_SHORT'});
 assert.equal(noLoss.profitFactor,'INF');assert.equal(noLoss.checks.profitFactor,true);
 assert.equal(scalpGroupReadiness([],{group:'SCALP_ALL'}).checks.profitFactor,false);
});

test('A3 halves by count: each half must be > 0; odd middle goes to the newer half',()=>{
 assert.deepEqual(splitHalves([1,2,3,4,5]),[[1,2],[3,4,5]]);
 // Older 50 net exactly 0 → fail even though the whole is positive.
 const older=Array.from({length:50},(_,i)=>({direction:'SHORT',closedAt:T0+i,closeReason:'X',netUSD:i%2?-2:2}));
 const newer=Array.from({length:50},(_,i)=>({direction:'SHORT',closedAt:T0+1000+i,closeReason:'X',netUSD:i%2?-1:3}));
 const g=scalpGroupReadiness([...newer,...older],{group:'SCALP_SHORT'}); // unsorted input: sorted by closedAt
 assert.equal(g.olderHalf.netUSD,0);assert.ok(g.newerHalf.netUSD>0);assert.equal(g.checks.halves,false);
 older[0].netUSD=2.01;
 assert.equal(scalpGroupReadiness([...older,...newer],{group:'SCALP_SHORT'}).checks.halves,true);
});

test('A4 big loss: avg EMERGENCY_ROE_STOP / NO_STOP loss at exactly 5× avg win passes, above fails, none passes',()=>{
 const base=trades(100,{lossEvery:1e9,win:2}); // avg win 2
 assert.equal(scalpGroupReadiness(base,{group:'SCALP_SHORT'}).checks.bigLoss,true,'no big loss → pass');
 const withBig=x=>[...base.slice(0,98),{direction:'SHORT',closedAt:T0+98*60000,closeReason:'EMERGENCY_ROE_STOP',netUSD:-x},{direction:'SHORT',closedAt:T0+99*60000,closeReason:'NO_STOP',netUSD:-x}];
 const at=scalpGroupReadiness(withBig(10),{group:'SCALP_SHORT'});
 assert.equal(at.bigLoss.count,2);assert.equal(at.bigLoss.ratio,5);assert.equal(at.checks.bigLoss,true);
 const over=scalpGroupReadiness(withBig(10.01),{group:'SCALP_SHORT'});
 assert.equal(over.checks.bigLoss,false);assert.equal(over.ready,false);
 assert.match(over.line,/큰 손실 5\.1배\/5배 ✗/);
 // An ordinary loss (MAX_HOLD_EXIT) is not a big-loss exit.
 assert.equal(scalpGroupReadiness(trades(100,{loss:50,lossEvery:50}),{group:'SCALP_SHORT'}).bigLoss.count,0);
});

test('groups: ALL / SHORT / LONG split by direction; window gives first/last closedAt and count',()=>{
 const rows=[...trades(100,{direction:'SHORT'}),...trades(30,{direction:'LONG',start:T0+86400000})];
 const s=evaluateReadiness({scalpRows:rows,pumpRecords:[]});
 const by=Object.fromEntries(s.groups.map(g=>[g.group,g]));
 assert.equal(by.SCALP_ALL.trades,130);assert.equal(by.SCALP_SHORT.trades,100);assert.equal(by.SCALP_LONG.trades,30);
 assert.equal(by.SCALP_SHORT.ready,true);assert.equal(by.SCALP_LONG.ready,false);
 assert.deepEqual(by.SCALP_SHORT.window,{fromAt:T0,toAt:T0+99*60000,count:100});
 assert.equal(by.SCALP_ALL.window.toAt,T0+86400000+29*60000);
 assert.match(by.SCALP_SHORT.line,/^숏 100\/100건 · PF .+ ✓ · 앞·뒤 절반 ✓ · 큰 손실 없음 ✓$/);
});

function alerts(n,{fade15=0.5,fade60=0.1,listed=true,start=T0}={}){
 return Array.from({length:n},(_,i)=>({at:start+i*60000,symbol:'XUSDT',dir:'UP',bingx:{listed},
  track:{horizons:{15:{fade:{netPct:typeof fade15==='function'?fade15(i):fade15}},60:{fade:{netPct:typeof fade60==='function'?fade60(i):fade60}}}}}));
}
test('B pump fade: 50 listed tracked, avg15 > 0, halves > 0, avg60 ≥ 0 at their boundaries',()=>{
 assert.equal(pumpReadiness(alerts(49)).checks.tracked,false);
 const ok=pumpReadiness(alerts(50));assert.equal(ok.ready,true);assert.equal(ok.tracked,50);
 assert.equal(pumpReadiness([...alerts(49),...alerts(10,{listed:false,start:T0+1e7})]).checks.tracked,false,'unlisted coins do not count');
 assert.equal(pumpReadiness([...alerts(49),{at:T0+1e7,bingx:{listed:true},track:{horizons:{5:{fade:{netPct:1}}}}}]).checks.tracked,false,'no 15-min result');
 assert.equal(pumpReadiness(alerts(50,{fade15:0})).checks.avg15,false,'avg 0 is not > 0');
 assert.equal(pumpReadiness(alerts(50,{fade60:0})).checks.avg60,true,'60-min avg 0 passes (≥ 0)');
 assert.equal(pumpReadiness(alerts(50,{fade60:-0.0001})).checks.avg60,false);
 const badOld=pumpReadiness(alerts(50,{fade15:i=>i<25?-0.1:1}));
 assert.ok(badOld.avg15Pct>0);assert.equal(badOld.checks.halves,false);assert.equal(badOld.ready,false);
 assert.deepEqual(ok.window,{fromAt:T0,toAt:T0+49*60000,count:50});
 assert.match(readinessLine(badOld),/^급변 되돌림 50\/50건 · 15분 평균 \+0\.45% ✓ · 앞·뒤 절반 ✗ · 60분 평균 \+0\.10%\/0 ✓$/);
});

test('message: candidate wording, each value vs threshold, window, not-automatic line, loss limits off',()=>{
 const s=evaluateReadiness({scalpRows:trades(100),pumpRecords:alerts(50)});
 const g=s.groups.find(x=>x.group==='SCALP_SHORT');
 const m=readinessMessage(g,{lossLimits:{dailyLossPct:0,copyLedgerLossPct:0}});
 assert.match(m,/실계좌 후보 — 검증 필요 · 단타 숏/);
 assert.match(m,/청산 거래 100건 \/ 100건 이상/);assert.match(m,/PF .* \/ 1\.3 이상/);assert.match(m,/앞 절반 .* 뒤 절반/);assert.match(m,/큰 손실/);
 assert.match(m,/검증 구간: 2026-11-16 09:00 ~ .* KST · 100건/);
 assert.ok(m.includes(READY_NOT_AUTOMATIC));
 assert.ok(m.includes('실계좌 적용은 자동으로 되지 않습니다 — 승인 후 코드 변경 필요 (단타는 지금 실계좌 주문이 막혀 있음)'));
 assert.match(m,/실계좌 손실 한도.*꺼져 있습니다/);
 assert.doesNotMatch(m,/다시 충족/);assert.doesNotMatch(m,/\d+일/);
 assert.match(readinessMessage(g,{again:true}),/다시 충족/);
 assert.match(readinessMessage(s.groups.find(x=>x.group==='PUMP_FADE')),/15분 되돌림 평균/);
});

test('notifier: one message per group, persisted (no resend after restart), re-notify "다시 충족" after a loss of readiness',async()=>{
 const dir=tmp(),sent=[];let now=T0+30*86400000;
 const make=()=>new ReadinessNotifier({directory:dir,now:()=>now,send:async t=>{sent.push(t)}});
 const ready=evaluateReadiness({scalpRows:trades(100),pumpRecords:[]});
 let n=make();
 const first=await n.check(ready);
 assert.deepEqual(first.map(x=>x.group).sort(),['SCALP_ALL','SCALP_SHORT']);
 assert.equal(sent.length,2);
 assert.equal((await n.check(ready)).length,0,'same process: no resend');
 n=make(); // restart
 assert.equal((await n.check(ready)).length,0,'restart: no resend');
 const saved=JSON.parse(fs.readFileSync(path.join(dir,READY_FILE),'utf8'));
 assert.equal(saved.groups.SCALP_SHORT.ready,true);assert.equal(saved.groups.SCALP_SHORT.notifyCount,1);
 assert.deepEqual(saved.groups.SCALP_SHORT.window,{fromAt:T0,toAt:T0+99*60000,count:100});
 // Stops being ready (a big loss), then ready again.
 const broken=evaluateReadiness({scalpRows:[...trades(100),{direction:'SHORT',closedAt:T0+1e8,closeReason:'EMERGENCY_ROE_STOP',netUSD:-500}],pumpRecords:[]});
 now+=3600000;assert.equal((await n.check(broken)).length,0);
 n=make();
 assert.equal(n.status(broken).groups.find(g=>g.group==='SCALP_SHORT').notified.ready,false);
 now+=3600000;const again=await n.check(ready);
 assert.equal(again.length,2);assert.ok(again.every(x=>x.again));assert.match(sent.at(-1),/다시 충족/);
 assert.equal(JSON.parse(fs.readFileSync(path.join(dir,READY_FILE),'utf8')).groups.SCALP_SHORT.notifyCount,2);
 assert.deepEqual(fs.readdirSync(dir),[READY_FILE],'writes only live-readiness.json');
});

test('notifier: a failed send is not recorded and is retried at the next check',async()=>{
 const dir=tmp();let fail=true,sent=0;
 const n=new ReadinessNotifier({directory:dir,send:async()=>{if(fail)throw Error('HTTP_500');sent++}});
 const ready=evaluateReadiness({scalpRows:trades(100),pumpRecords:[]});
 assert.equal((await n.check(ready)).length,0);
 assert.equal(fs.existsSync(path.join(dir,READY_FILE)),false);
 fail=false;assert.equal((await n.check(ready)).length,2);assert.equal(sent,2);
 assert.equal((await new ReadinessNotifier({directory:dir}).check(ready)).length,0,'no send function needed once recorded');
});

test('read only: evaluating and notifying never changes the inputs or any setting',async()=>{
 const rows=trades(100),recs=alerts(50),config=Object.freeze({mode:'TESTNET',minScore:65,riskPct:0.75});
 const before=JSON.stringify({rows,recs,config});
 const s=evaluateReadiness({scalpRows:rows,pumpRecords:recs});
 await new ReadinessNotifier({send:async()=>{}}).check(s,{lossLimits:{dailyLossPct:0,copyLedgerLossPct:0}});
 assert.equal(JSON.stringify({rows,recs,config}),before);
 const src=fs.readFileSync(new URL('../ready_check.mjs',import.meta.url),'utf8');
 assert.doesNotMatch(src,/placeOrder|\.arm\(|configure\(|process\.env/,'no orders, arming, setting changes or env reads');
});

test('/ready: read-only reply with every group, no /confirm, allowed chat only',async()=>{
 const s=evaluateReadiness({scalpRows:trades(42),pumpRecords:[]});
 let configured=0;
 const a=new AccountAlerts({allowedChatId:'777',getReadiness:async()=>readyReplyText(s,{lossLimits:{}}),onControls:()=>{configured++;return {}}});
 const r=await a.handleCommand('/ready','777');
 assert.match(r,/실계좌 준비 점검/);assert.match(r,/숏 42\/100건/);assert.match(r,/롱 0\/100건/);assert.match(r,/급변 되돌림 0\/50건/);
 assert.doesNotMatch(r,/\/confirm/);assert.equal(a.pendingAction,null);assert.equal(configured,0);
 assert.equal(await a.handleCommand('/ready','999'),null,'other chat ignored');
 assert.match(await a.handleCommand('/help','777'),/\/ready/);
 assert.match(await new AccountAlerts({allowedChatId:'777'}).handleCommand('/ready','777'),/아직 계산하지 못했습니다/);
});

test('sendToAllowedChat posts only to the allowed chat and throws when not delivered',async()=>{
 const posts=[];
 const a=new AccountAlerts({allowedChatId:'777',post:async p=>{posts.push(p);return {ok:true,status:200}}});
 assert.equal(await a.sendToAllowedChat('hi'),true);assert.equal(posts[0].chat_id,'777');
 const b=new AccountAlerts({allowedChatId:'777',post:async()=>({ok:false,status:500})});
 await assert.rejects(b.sendToAllowedChat('x'),/HTTP_500/);
 await assert.rejects(new AccountAlerts({}).sendToAllowedChat('x'),/TELEGRAM_NOT_CONFIGURED/);
});

test('screen: one line and a progress bar per group',()=>{
 const s=evaluateReadiness({scalpRows:trades(42),pumpRecords:alerts(10)});
 const html=liveReadinessHTML(s);
 assert.equal((html.match(/class="ready-bar"/g)||[]).length,4);
 assert.match(html,/aria-valuenow="42"/);assert.match(html,/aria-valuenow="20"/);
 assert.match(html,/숏 42\/100건/);
 assert.equal(liveReadinessHTML(null),'');
});

test('scalp executor exposes the stats() rows read only',async()=>{
 const src=fs.readFileSync(new URL('../scalp_executor.mjs',import.meta.url),'utf8');
 assert.match(src,/readinessRows\(\)\{return \[\.\.\.this\.journalRows,\.\.\.this\.store\.closed\.filter\(x=>!x\.journaled\)\]/);
 const server=fs.readFileSync(new URL('../server.mjs',import.meta.url),'utf8');
 assert.match(server,/report\.liveReadiness=readyNotifier\.status\(readySummary\(\)\)/);
 assert.match(server,/setInterval\(\(\)=>\{void readyCheck\(\)\},3600000\)/);
});

test('readiness sample restarts at the score-rules change (user 2026-11-25 "진행해")',async()=>{
 const {SCALP_SCORE_RULES_SINCE}=await import('../scalp_executor.mjs');
 assert.equal(new Date(SCALP_SCORE_RULES_SINCE).toISOString(),'2026-11-24T23:44:31.000Z');
});

