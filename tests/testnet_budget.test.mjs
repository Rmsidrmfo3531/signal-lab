// One shared TESTNET budget and one switch for the signal strategy and the reversal scalp (user 2026-11-17 18:03
// "단타랑 원래 쓰던 테스트넷이랑 합쳐서 진행하자 따로 보는 게 더 복잡" -> "한도까지 하나로"; 18:11 "하루 손실을 늘리면 되지").
import test from 'node:test';
import assert from 'node:assert/strict';
import {TestnetBudget,testnetDailyLossPct,testnetMarginCapPct,armTestnet,disarmTestnet,testnetSwitch,kstDay} from '../testnet_budget.mjs';
import {LiveExecutor} from '../live_executor.mjs';
import {ScalpExecutor,scalpExecConfig} from '../scalp_executor.mjs';
import {liveConfig} from '../live_orders.mjs';
import {testnetStats} from '../live_overview.mjs';
import {testnetCloses,testnetClosedHTML,testnetSummaryHTML,testnetBudgetHTML,setTestnetPage,TN_BADGE,positionCardHTML,scalpPositionCardHTML} from '../public/live_control.js';

const NOW=Date.parse('2026-11-17T03:00:00Z'); // 12:00 KST
const liveCfg=(extra={})=>({mode:'TESTNET',liveConfirmed:false,venues:['BINGX'],maxRiskUSD:2,dailyMaxRiskUSD:6,maxOpen:8,maxPerDirection:4,...extra});

test('settings: TESTNET_DAILY_LOSS_PCT default 15 (1-50); the shared margin cap is the larger of the two caps',()=>{
 assert.equal(testnetDailyLossPct({}),15);assert.equal(testnetDailyLossPct({TESTNET_DAILY_LOSS_PCT:'12'}),12);
 assert.equal(testnetDailyLossPct({TESTNET_DAILY_LOSS_PCT:'0'}),15);assert.equal(testnetDailyLossPct({TESTNET_DAILY_LOSS_PCT:'abc'}),15);
 assert.equal(testnetMarginCapPct({scalpConfig:scalpExecConfig({}),liveConfig:liveConfig({LIVE_TRADING_MODE:'TESTNET'})}),30);
 assert.equal(testnetMarginCapPct({scalpConfig:{maxTotalMarginPct:20},liveConfig:{marginUsePct:40}}),40);
 assert.equal(kstDay(Date.parse('2026-11-16T14:59:59Z')),'2026-11-16');assert.equal(kstDay(Date.parse('2026-11-16T15:00:00Z')),'2026-11-17');
});

test('budget: today\'s loss of both + open risk of both + the new trade within the %, margin of both within the cap',()=>{
 const g={signal:{realizedToday:()=>-40,openRisk:()=>30,usedMargin:()=>100},scalp:{realizedToday:()=>10,openRisk:()=>20,usedMargin:()=>50}};
 const b=new TestnetBudget({dailyLossPct:15,marginCapPct:30,now:()=>NOW}).register('signal',g.signal).register('scalp',g.scalp);
 const s=b.snapshot(1000);assert.equal(s.limitUSD,150);assert.equal(s.realizedNetUSD,-30);assert.equal(s.lossUSD,30);assert.equal(s.openRiskUSD,50);assert.equal(s.usedUSD,80);assert.equal(s.marginUSD,150);
 assert.equal(b.check({equity:1000,newRiskUSD:70}).ok,true,'80 + 70 = 150: at the limit');
 assert.equal(b.check({equity:1000,newRiskUSD:71}).reason,'OPEN_RISK_LIMIT');
 assert.equal(b.check({equity:1000,newRiskUSD:1,newMarginUSD:151}).reason,'TESTNET_MARGIN_CAP');
 assert.equal(b.check({equity:1000,newRiskUSD:1,newMarginUSD:151,margin:false}).ok,true,'the scalp sizes its margin itself');
 // A win of one offsets a loss of the other (today's realized result of both, KST day).
 g.scalp.realizedToday=()=>-110;assert.equal(b.check({equity:1000,newRiskUSD:1}).reason,'DAILY_LOSS_LIMIT','-40 -110 = -150: stopped');
 assert.equal(b.stopped(1000),true);
 // The scalp's stored realized + unrealized day stop stops the signal strategy too.
 g.scalp.realizedToday=()=>0;g.scalp.stoppedToday=day=>day==='2026-11-17';assert.equal(b.check({equity:1000,newRiskUSD:1}).reason,'DAILY_LOSS_LIMIT');
 g.scalp.stoppedToday=()=>false;
 // A getter that fails blocks entries (never read as 0).
 g.signal.openRisk=()=>{throw Error('x')};assert.equal(b.check({equity:1000,newRiskUSD:1}).reason,'TESTNET_BUDGET_UNAVAILABLE');
 assert.equal(new TestnetBudget({}).check({equity:0,newRiskUSD:1}).reason,'NO_BALANCE');
 const st=new TestnetBudget({dailyLossPct:15}).register('a',{realizedToday:()=>-12.345,openRisk:()=>7.891}).status(1000);
 assert.deepEqual([st.lossUSD,st.limitUSD,st.openRiskUSD,st.dailyLossPct],[12.35,150,7.89,15]);
});

test('signal strategy source: KST day of the close, open risk and margin of active records (tests left out)',()=>{
 const ex=new LiveExecutor({config:liveCfg(),clients:{},now:()=>NOW});
 ex.store.records.push(
  {signalKey:'a',symbol:'AUSDT',mode:'TESTNET',status:'CLOSED',closedAt:Date.parse('2026-11-16T15:30:00Z'),plannedRiskUSD:30,realized:{source:'EXCHANGE',netUSD:-12}},
  {signalKey:'b',symbol:'BUSDT',mode:'TESTNET',status:'CLOSED',closedAt:Date.parse('2026-11-16T14:30:00Z'),plannedRiskUSD:30,realized:{source:'EXCHANGE',netUSD:-99}},
  {signalKey:'t',symbol:'TUSDT',mode:'TESTNET',status:'CLOSED',test:true,closedAt:NOW,plannedRiskUSD:30},
  {signalKey:'o',symbol:'OUSDT',mode:'TESTNET',status:'OPEN',plannedRiskUSD:25,leverage:10,position:{size:2,entryPrice:100,unrealizedPnLUSD:-3},quantity:{total:2},venueContract:{quantityUnit:'BASE_ASSET'},
   adds:[{qty:2,price:95,filled:false},{qty:4,price:90,cancelled:true}]});
 const src=ex.budgetSource();
 assert.equal(src.realizedToday('2026-11-17'),-12,'00:30 KST is today, 23:30 KST yesterday is not; test orders never count');
 assert.equal(src.openRisk(),25);assert.equal(src.usedMargin(),(2*100+2*95)/10);assert.equal(src.unrealized(),-3);
});

function scalpFake(){return new ScalpExecutor({config:scalpExecConfig({}),client:{mode:'TESTNET'},now:()=>NOW})}
test('one switch: 활성화 arms the signal strategy and the scalp, 비활성화 turns both off; the kill switch refuses both',()=>{
 const live=new LiveExecutor({config:liveCfg(),clients:{},now:()=>NOW}),scalp=scalpFake();
 let t=armTestnet({live,scalp});assert.equal(live.armed,true);assert.equal(scalp.armed,true);assert.equal(t.armed,true);assert.equal(t.partial,false);
 t=disarmTestnet({live,scalp});assert.equal(live.armed,false);assert.equal(scalp.armed,false);assert.equal(t.armed,false);
 // One on alone (old scalp route): shown as partly on.
 scalp.arm();assert.deepEqual([testnetSwitch({live,scalp}).armed,testnetSwitch({live,scalp}).partial],[false,true]);scalp.disarm();
 live.kill('TEST');assert.throws(()=>armTestnet({live,scalp}),/KILL_SWITCH_ON/);assert.equal(scalp.armed,false);
 live.resetKill();
 // A scalp that cannot run is reported, the signal strategy still turns on.
 const noKey=new ScalpExecutor({config:scalpExecConfig({}),now:()=>NOW});t=armTestnet({live,scalp:noKey});assert.equal(live.armed,true);assert.equal(t.scalpError,'CREDENTIALS_MISSING');assert.equal(t.scalp,null);
 // Signal strategy OFF: the scalp alone; nothing that can run -> LIVE_MODE_OFF as before.
 const off=new LiveExecutor({config:liveCfg({mode:'OFF'}),clients:{},now:()=>NOW});
 assert.throws(()=>armTestnet({live:off,scalp:noKey}),/LIVE_MODE_OFF/);
 const s2=scalpFake();assert.equal(armTestnet({live:off,scalp:s2}).armed,true);assert.equal(s2.armed,true);
});

test('LIVE paths untouched: the one switch refuses a LIVE signal executor and changes nothing',()=>{
 const live=new LiveExecutor({config:liveCfg({mode:'LIVE',liveConfirmed:true}),clients:{},now:()=>NOW,budget:new TestnetBudget({})}),scalp=scalpFake();
 assert.equal(live.budget,null,'a LIVE executor never takes the testnet budget');
 assert.throws(()=>armTestnet({live,scalp}),/NOT_TESTNET/);assert.throws(()=>disarmTestnet({live,scalp}),/NOT_TESTNET/);
 assert.equal(live.armed,false);assert.equal(scalp.armed,false);
 const l=liveConfig({LIVE_TRADING_MODE:'LIVE',TESTNET_DAILY_LOSS_PCT:'30'});assert.deepEqual([l.riskProfile,l.dailyMaxLossPct],['CURRENT',60]);
});

// ---- One testnet screen ----
const sigClosed=i=>({signalKey:'s'+i,symbol:'S'+i+'USDT',direction:'LONG',createdAt:NOW-(i+2)*3600000,closedAt:NOW-i*600000*2,closeReasonKo:'거래소에서 청산됨 (익절·손절)',realized:{source:i%3?'EXCHANGE':'ESTIMATE',netUSD:i%2?2:-1},deletable:i===4});
const scClosed=i=>({id:'c'+i,symbol:'C'+i+'USDT',direction:i%2?'SHORT':'LONG',openedAt:NOW-(i*2+1)*600000-1800000,closedAt:NOW-(i*2+1)*600000,closeReasonKo:'손절',netUSD:i%2?-0.5:1.5,netSource:'ESTIMATE'});
test('merged 종료된 거래: both strategies newest first, badges 신호 / 단타, 10 per page with the copy page\'s pager',()=>{
 const o={closed:Array.from({length:12},(_,i)=>sigClosed(i)),scalp:{closed:Array.from({length:11},(_,i)=>scClosed(i))}};
 const all=testnetCloses(o);assert.equal(all.length,23);
 assert.ok(all.every((x,i)=>i===0||x.closedAt<=all[i-1].closedAt),'newest first');assert.deepEqual(new Set(all.map(x=>x.kind)),new Set(['signal','scalp']));
 setTestnetPage(0);let h=testnetClosedHTML(o);
 assert.match(h,/class="copy-pager"/);assert.match(h,/1 \/ 3쪽/);assert.match(h,/data-tn-page="-1" disabled/);assert.match(h,/data-tn-page="1"/);
 assert.match(h,new RegExp(TN_BADGE.signal));assert.match(h,new RegExp(TN_BADGE.scalp));
 assert.equal((h.match(/<tr class="tn-/g)||[]).length,10,'10 rows on the desktop table');assert.equal((h.match(/<li class="tn-/g)||[]).length,10,'10 rows on the phone list');
 assert.match(h,/<table class="copy-table only-desk">/);assert.match(h,/<ul class="copy-list only-mob">/);
 assert.ok(h.indexOf(all[0].symbol)<h.indexOf(all[1].symbol));
 setTestnetPage(2);h=testnetClosedHTML(o);assert.match(h,/3 \/ 3쪽/);assert.equal((h.match(/<tr class="tn-/g)||[]).length,3);assert.match(h,/data-tn-page="1" disabled/);
 setTestnetPage(9);assert.match(testnetClosedHTML(o),/3 \/ 3쪽/,'a page past the end shows the last one');setTestnetPage(0);
 assert.match(testnetClosedHTML({closed:[{...sigClosed(4),closedAt:NOW}]}),/data-live-delete="s4"/,'a deletable signal record keeps its delete button');
 assert.match(testnetClosedHTML({closed:[],scalp:{closed:[]}}),/아직 종료된 테스트넷 거래가 없습니다/);
 assert.doesNotMatch(testnetClosedHTML({closed:[sigClosed(1)]}),/copy-pager/,'one page: no pager');
});

test('totals over both strategies and the 신호 / 단타 breakdown line; budget status line; badges on the open cards',()=>{
 const records=[{status:'CLOSED',mode:'TESTNET',realized:{source:'EXCHANGE',netUSD:10}},{status:'CLOSED',mode:'TESTNET',realized:{source:'ESTIMATE',netUSD:-4}},
  {status:'CLOSED',mode:'TESTNET',test:true,realized:{source:'EXCHANGE',netUSD:99}},{status:'CLOSED',mode:'TESTNET'},{status:'CLOSED',mode:'LIVE',realized:{source:'EXCHANGE',netUSD:50}}];
 const st=testnetStats({records,mode:'TESTNET',scalpStats:{trades:3,wins:2,grossProfitUSD:3,grossLossUSD:1,netUSD:2}});
 assert.deepEqual(st.signal,{trades:2,wins:1,winRatePct:50,profitFactor:2.5,netUSD:6});
 assert.deepEqual(st.all,{trades:5,wins:3,winRatePct:60,profitFactor:2.6,netUSD:8});
 const h=testnetSummaryHTML(st);assert.match(h,/5건/);assert.match(h,/60\.0%/);assert.match(h,/2\.60/);assert.match(h,/\+\$8\.00/);
 assert.match(h,/신호 <b class="paper-profit">\+\$6\.00<\/b> \(2건\) · 단타 <b class="paper-profit">\+\$2\.00<\/b> \(3건\)/);
 assert.equal(testnetStats({records,mode:null}).signal.trades,0,'no signal strategy on the testnet: scalp only');
 const line=testnetBudgetHTML({armed:true,signal:{armed:true},scalp:{armed:true},budget:{dailyLossPct:15,lossUSD:12,limitUSD:1500,openRiskUSD:40.5,marginUSD:100,marginCapUSD:3000,marginCapPct:30}});
 assert.match(line,/● 활성화/);assert.match(line,/오늘 손실 <b class="paper-loss">−\$12\.00<\/b> \/ 한도 <b>\$1,500\.00<\/b> \(15%\) · 열린 위험 <b>\$40\.50<\/b>/);
 assert.match(testnetBudgetHTML({armed:false,partial:false,budget:{stopped:true,dailyLossPct:15}}),/오늘 정지/);
 assert.match(positionCardHTML({symbol:'ETHUSDT',direction:'LONG',status:'OPEN',venue:'BINGX',targets:[]},{badge:TN_BADGE.signal}),/vp-badge tn-signal">신호/);
 assert.doesNotMatch(positionCardHTML({symbol:'ETHUSDT',direction:'LONG',status:'OPEN',venue:'BINGX',targets:[]}),/tn-signal/,'LIVE cards unchanged');
 const sc=scalpPositionCardHTML({symbol:'SOLUSDT',direction:'SHORT',status:'OPEN',avg:100,mark:99,size:2,stop:101,targets:[99,98,97],parts:[1,1,0],riskUSD:2,unrealized:2,leverage:10,openedAt:NOW});
 assert.match(sc,/vp-badge tn-scalp">단타/);assert.match(sc,/paper-short">숏/);assert.match(sc,/\+\$2\.00/);
});
