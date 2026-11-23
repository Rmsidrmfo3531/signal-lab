// One shared TESTNET budget and one switch for the signal strategy and the reversal scalp (user 2026-11-17 18:03
// "단타랑 원래 쓰던 테스트넷이랑 합쳐서 진행하자 따로 보는 게 더 복잡" -> "한도까지 하나로"; 18:11 "하루 손실을 늘리면 되지").
import test from 'node:test';
import assert from 'node:assert/strict';
import {TestnetBudget,testnetDailyLossPct,testnetMarginCapPct,armTestnet,disarmTestnet,testnetSwitch,kstDay} from '../testnet_budget.mjs';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {LiveExecutor} from '../live_executor.mjs';
import {ScalpExecutor,scalpExecConfig} from '../scalp_executor.mjs';
import {liveConfig} from '../live_orders.mjs';
import {testnetStats} from '../live_overview.mjs';
import {testnetCloses,testnetClosedHTML,testnetSummaryHTML,testnetBudgetHTML,setTestnetPage,TN_BADGE,positionCardHTML,scalpPositionCardHTML} from '../public/live_control.js';

const NOW=Date.parse('2026-11-17T03:00:00Z'); // 12:00 KST
const liveCfg=(extra={})=>({mode:'TESTNET',liveConfirmed:false,venues:['BINGX'],maxRiskUSD:2,dailyMaxRiskUSD:6,maxOpen:8,maxPerDirection:4,...extra});

test('settings: TESTNET_DAILY_LOSS_PCT default 15 (1-100); TESTNET_MARGIN_CAP_PCT default 30, maximum 100',()=>{
 assert.equal(testnetDailyLossPct({}),15);assert.equal(testnetDailyLossPct({TESTNET_DAILY_LOSS_PCT:'100'}),100);
 assert.equal(testnetDailyLossPct({TESTNET_DAILY_LOSS_PCT:'0'}),15);assert.equal(testnetDailyLossPct({TESTNET_DAILY_LOSS_PCT:'101'}),15);assert.equal(testnetDailyLossPct({TESTNET_DAILY_LOSS_PCT:'abc'}),15);
 assert.equal(testnetMarginCapPct({}),30);assert.equal(testnetMarginCapPct({TESTNET_MARGIN_CAP_PCT:'20'}),20);assert.equal(testnetMarginCapPct({TESTNET_MARGIN_CAP_PCT:'100'}),100);assert.equal(testnetMarginCapPct({TESTNET_MARGIN_CAP_PCT:'105'}),30,'invalid > 100 falls back to default 30');
 assert.equal(new TestnetBudget({marginCapPct:120}).marginCapPct,100);
 assert.equal(kstDay(Date.parse('2026-11-16T14:59:59Z')),'2026-11-16');assert.equal(kstDay(Date.parse('2026-11-16T15:00:00Z')),'2026-11-17');
});

test('budget: each strategy\'s loss (no offset) + open risk of both + the new trade within the %, margin of both within the cap',()=>{
 const mk=g=>new TestnetBudget({dailyLossPct:15,marginCapPct:30,now:()=>NOW}).register('signal',g.signal).register('scalp',g.scalp);
 const g={signal:{realizedToday:()=>-40,openRisk:()=>30,usedMargin:()=>100},scalp:{realizedToday:()=>10,openRisk:()=>20,usedMargin:()=>50}};
 const b=mk(g),s=b.snapshot(1000);assert.equal(s.limitUSD,150);assert.equal(s.realizedNetUSD,-30);assert.equal(s.lossUSD,40,'the scalp\'s +10 does not pay for the signal\'s -40');
 assert.equal(s.openRiskUSD,50);assert.equal(s.usedUSD,90);assert.equal(s.marginUSD,150);
 assert.equal(b.check({equity:1000,newRiskUSD:60}).ok,true,'90 + 60 = 150: at the limit');
 assert.equal(b.check({equity:1000,newRiskUSD:61}).reason,'OPEN_RISK_LIMIT');
 assert.equal(b.check({equity:1000,newRiskUSD:1,newMarginUSD:151}).reason,'TESTNET_MARGIN_CAP');
 assert.equal(b.check({equity:1000,newRiskUSD:1,newMarginUSD:151,margin:false}).ok,true,'the scalp sizes its margin itself');
 {const g2={signal:{realizedToday:()=>-40},scalp:{realizedToday:()=>-110}},b2=mk(g2);assert.equal(b2.check({equity:1000,newRiskUSD:1}).reason,'DAILY_LOSS_LIMIT','40 + 110 = 150: stopped');assert.equal(b2.stopped(1000),true)}
 // The scalp's shared realized + unrealized day stop stops the signal strategy too.
 {const b3=mk({signal:{realizedToday:()=>0},scalp:{realizedToday:()=>0,stoppedToday:day=>day==='2026-11-17'}});assert.equal(b3.check({equity:1000,newRiskUSD:1}).reason,'DAILY_LOSS_LIMIT')}
 // A getter that fails blocks entries (never read as 0).
 {const b4=mk({signal:{openRisk:()=>{throw Error('x')}},scalp:{}});assert.equal(b4.check({equity:1000,newRiskUSD:1}).reason,'TESTNET_BUDGET_UNAVAILABLE')}
 assert.equal(new TestnetBudget({}).check({equity:0,newRiskUSD:1}).reason,'NO_BALANCE');
 const st=new TestnetBudget({dailyLossPct:15}).register('a',{realizedToday:()=>-12.345,openRisk:()=>7.891}).status(1000);
 assert.deepEqual([st.lossUSD,st.limitUSD,st.openRiskUSD,st.dailyLossPct],[12.35,150,7.89,15]);
});

test('one balance basis (review L7): the smaller of the two strategies\' equity figures',()=>{
 const b=new TestnetBudget({dailyLossPct:15,now:()=>NOW}).register('signal',{openRisk:()=>140}).register('scalp',{});
 assert.equal(b.check({equity:1000,who:'signal',newRiskUSD:5}).ok,true,'1,000: 145 <= 150');
 assert.equal(b.check({equity:2000,who:'scalp',newRiskUSD:15}).reason,'OPEN_RISK_LIMIT','the scalp reads 2,000 but the basis is the signal\'s 1,000');
 assert.equal(b.snapshot(5000).equityUSD,1000);
});

test('shared BingX equity follows the latest account sample, retains a configured capital cap and expires',()=>{
 let now=NOW;const b=new TestnetBudget({accountEquity:true,capitalCapUSD:1200,now:()=>now});
 assert.equal(b.check({equity:9999,who:'signal'}).reason,'NO_BALANCE');
 b.observeAccount(1000);assert.equal(b.check({equity:800,who:'signal'}).snap.equityUSD,1000);
 now+=6000;b.observeAccount(2000);
 assert.deepEqual([b.status().equityUSD,b.status().accountEquityUSD,b.status().limitUSD,b.status().marginCapUSD],[1200,2000,180,360]);
 assert.equal(b.check({equity:1100,who:'signal-alt'}).snap.equityUSD,1100,'a separately funded strategy may impose a lower bound');
 now+=6000;b.observeAccount(800);assert.equal(b.status().limitUSD,120);
 const oldAt=b.status().balanceAt;
 now+=10000;
 assert.equal(b.status().balanceError,'BALANCE_STALE');assert.equal(b.check({equity:1000,who:'scalp'}).reason,'NO_BALANCE');
 b.observeAccount(1000);b.observeAccount(null);
 assert.equal(b.status().limitUSD,null);assert.ok(b.status().balanceAt>oldAt);assert.equal(b.status().balanceError,'BALANCE_UNAVAILABLE');
 assert.equal(b.check({equity:1000,who:'scalp'}).reason,'NO_BALANCE');
 b.observeAccount(0);assert.equal(b.status().limitUSD,0);assert.equal(b.storedStop(),null,'a flat zero balance does not persist a day stop');
});

test('both strategies are gated immediately when the shared net equity falls',()=>{
 const b=new TestnetBudget({accountEquity:true,now:()=>NOW}).register('signal',{usedMargin:()=>180}).register('scalp',{openRisk:()=>100});
 b.observeAccount(1000,'VST');
 for(const who of ['signal','scalp'])assert.equal(b.check({equity:1000,who,newMarginUSD:80}).ok,true);
 b.observeAccount(800,'VST');
 for(const who of ['signal','scalp']){
  assert.equal(b.check({equity:1000,who,newMarginUSD:80}).reason,'TESTNET_MARGIN_CAP');
  assert.equal(b.check({equity:1000,who,newRiskUSD:30}).reason,'OPEN_RISK_LIMIT');
 }
 b.observeAccount(null);
 for(const who of ['signal','scalp'])assert.equal(b.check({equity:1000,who}).reason,'NO_BALANCE');
});

test('budget edits apply immediately and reload, and leave a previously reached daily stop in place',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sl-budget-edit-'));
 try{
  const make=()=>new TestnetBudget({directory:dir,now:()=>NOW,accountEquity:true});
  const b=make();b.observeAccount(1000);
  assert.throws(()=>b.configure({dailyLossPct:10,marginCapPct:100.01}),/INVALID_TESTNET_BUDGET/);
  assert.throws(()=>b.configure({dailyLossPct:100.01,marginCapPct:50}),/INVALID_TESTNET_BUDGET/);
  assert.equal(b.status().limitUSD,150);
  b.markStopped({reason:'REALIZED',lossUSD:100,limitUSD:100});
  const s=b.configure({dailyLossPct:100,marginCapPct:100});
  assert.deepEqual([s.limitUSD,s.marginCapUSD,s.stopped],[1000,1000,true]);
  const restarted=make();restarted.observeAccount(2000);
  assert.deepEqual([restarted.status().limitUSD,restarted.status().marginCapUSD,restarted.status().stopped],[2000,2000,true]);
 }finally{fs.rmSync(dir,{recursive:true,force:true})}
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
const sigClosed=i=>({mode:'TESTNET',signalKey:'s'+i,symbol:'S'+i+'USDT',direction:'LONG',createdAt:NOW-(i+2)*3600000,closedAt:NOW-i*600000*2,closeReasonKo:'거래소에서 청산됨 (익절·손절)',realized:{source:i%3?'EXCHANGE':'ESTIMATE',netUSD:i%2?2:-1},deletable:i===4});
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
 const scalpOnly={testnet:{scalpOnly:true},closed:[sigClosed(4)],scalp:{closed:[scClosed(0)]}};
 assert.deepEqual(testnetCloses(scalpOnly).map(trade=>trade.kind),['scalp']);
 assert.doesNotMatch(testnetClosedHTML(scalpOnly),/S4USDT|data-live-delete/);
});

test('totals over both strategies and the 신호 / 단타 breakdown line; budget status line; badges on the open cards',()=>{
 const records=[{status:'CLOSED',mode:'TESTNET',realized:{source:'EXCHANGE',netUSD:10}},{status:'CLOSED',mode:'TESTNET',realized:{source:'ESTIMATE',netUSD:-4}},
  {status:'CLOSED',mode:'TESTNET',test:true,realized:{source:'EXCHANGE',netUSD:99}},{status:'CLOSED',mode:'TESTNET'},{status:'CLOSED',mode:'LIVE',realized:{source:'EXCHANGE',netUSD:50}}];
 const st=testnetStats({records,mode:'TESTNET',scalpStats:{trades:3,wins:2,grossProfitUSD:3,grossLossUSD:1,netUSD:2}});
 assert.deepEqual(st.signal,{trades:2,wins:1,winRatePct:50,profitFactor:2.5,netUSD:6});
 assert.deepEqual(st.all,{trades:5,wins:3,winRatePct:60,profitFactor:2.6,netUSD:8});
 const h=testnetSummaryHTML(st);assert.match(h,/5건/);assert.match(h,/60\.0%/);assert.match(h,/2\.60/);assert.match(h,/\+\$8\.00/);
 assert.ok(h.indexOf('누적 실현 손익')<h.indexOf('미실현 손익 합계'));
 assert.ok(h.indexOf('미실현 손익 합계')<h.indexOf('<span>거래</span>'));
 assert.match(h,/미실현 손익 합계<\/span><strong class="">\$0\.00<\/strong><small>보유 0건/);
 const partial=testnetSummaryHTML(st,{open:[{usd:-12.5,source:'EXCHANGE'},{usd:2,source:'ESTIMATE'},null]});
 assert.match(partial,/미실현 손익 합계<\/span><strong class="paper-loss">−\$10\.50<\/strong><small>확인 2\/3건 · 추정 포함/);
 assert.match(testnetSummaryHTML(st,{open:[null]}),/미실현 손익 합계<\/span><strong class="">—<\/strong><small>확인 0\/1건/);
 assert.match(h,/신호 <b class="paper-profit">\+\$6\.00<\/b> \(2건\) · 단타 <b class="paper-profit">\+\$2\.00<\/b> \(3건\)/);
 assert.doesNotMatch(testnetSummaryHTML(st,{scalpOnly:true}),/tn-split/);
 assert.equal(testnetStats({records,mode:null}).signal.trades,0,'no signal strategy on the testnet: scalp only');
 const line=testnetBudgetHTML({armed:true,signal:{armed:true},scalp:{armed:true},budget:{dailyLossPct:15,lossUSD:12,limitUSD:1500,openRiskUSD:40.5,marginUSD:100,marginCapUSD:3000,marginCapPct:30}});
 assert.doesNotMatch(line,/활성화|테스트넷/,'on / off is the button\'s, the mode the header\'s (user 2026-11-18)');
 assert.match(testnetBudgetHTML({armed:false,partial:true,signal:{armed:true},scalp:{armed:false},budget:{dailyLossPct:15}}),/일부 활성화[\s\S]*신호 ● · 단타 ○/,'a part-on switch says which');assert.match(line,/오늘 손실 <b class="paper-loss">−\$12\.00<\/b> \/ 한도 <b>\$1,500\.00<\/b> \(15%\) · 열린 위험 <b>\$40\.50<\/b>/);
 assert.match(testnetBudgetHTML({armed:false,partial:false,budget:{stopped:true,dailyLossPct:15}}),/오늘 정지/);
 assert.match(positionCardHTML({symbol:'ETHUSDT',direction:'LONG',status:'OPEN',venue:'BINGX',targets:[]},{badge:TN_BADGE.signal}),/vp-badge tn-signal">신호/);
 assert.doesNotMatch(positionCardHTML({symbol:'ETHUSDT',direction:'LONG',status:'OPEN',venue:'BINGX',targets:[]}),/tn-signal/,'LIVE cards unchanged');
 const sc=scalpPositionCardHTML({symbol:'SOLUSDT',direction:'SHORT',status:'OPEN',avg:100,mark:99,size:2,stop:101,targets:[99,98,97],parts:[1,1,0],riskUSD:2,unrealized:2,leverage:10,openedAt:NOW});
 assert.match(sc,/vp-badge tn-scalp">단타/);assert.match(sc,/paper-short">숏/);assert.match(sc,/\+\$2\.00/);
});

// ---- Review regressions (testnet-unify b636b19, M1-M5 / L1-L7), from the reviewer's repro tests ----
import {BingXTradeClient} from '../live_clients.mjs';
import {liveClosedView} from '../live_overview.mjs';
import {scalpHTML} from '../public/live_control.js';
const T10=Date.parse('2026-11-10T12:00:00Z');
const rjson=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}});
function mockBingX({positionAmt=()=>'0.20',maxLeverage=50}={}){
 const orders=[],canceled=[];let id=1000;
 const fetcher=async(url,options)=>{
  const u=new URL(url),q=Object.fromEntries([...u.searchParams].filter(([k])=>k!=='signature'));
  if(u.pathname==='/openApi/swap/v3/user/balance')return rjson({code:0,data:[{asset:'USDT',balance:'1000',equity:'1000',availableMargin:'1000'}]});
  if(u.pathname==='/openApi/swap/v2/trade/marginType'&&options.method==='GET')return rjson({code:0,data:{marginType:'CROSSED'}});
  if(u.pathname==='/openApi/swap/v2/trade/leverage'&&options.method==='GET')return rjson({code:0,data:{maxLongLeverage:maxLeverage,maxShortLeverage:maxLeverage}});
  if(u.pathname==='/openApi/swap/v2/trade/leverage'&&options.method==='POST')return rjson({code:0,data:{symbol:q.symbol,leverage:Number(q.leverage)}});
  if(u.pathname==='/openApi/swap/v1/positionSide/dual')return rjson({code:0,data:{dualSidePosition:false}});
  if(u.pathname==='/openApi/swap/v2/trade/order'&&options.method==='POST'){
   const o={orderID:String(++id),type:q.type,clientOrderId:q.clientOrderId,status:q.type==='MARKET'?'FILLED':'NEW'};orders.push(o);
   if(q.type==='MARKET'&&q.stopLoss)orders.push({orderID:String(++id),type:'STOP_MARKET'});
   return rjson({code:0,data:{order:o}})}
  if(u.pathname==='/openApi/swap/v2/trade/order'&&options.method==='GET'){const o=orders.find(x=>x.clientOrderId===q.clientOrderId);return o?rjson({code:0,data:{order:o}}):rjson({code:80016,msg:'order not exist'})}
  if(u.pathname==='/openApi/swap/v2/trade/order'&&options.method==='DELETE'){canceled.push(q.orderId);return rjson({code:0,data:{order:{orderID:q.orderId}}})}
  if(u.pathname==='/openApi/swap/v2/trade/openOrders')return rjson({code:0,data:{orders:orders.filter(o=>o.type!=='MARKET')}});
  if(u.pathname==='/openApi/swap/v2/user/positions')return rjson({code:0,data:[{symbol:'ETH-USDT',positionAmt:positionAmt(),avgPrice:'100.02',positionSide:'LONG'}]});
  throw Error('unexpected '+u.pathname);
 };
 return {orders,canceled,client:new BingXTradeClient({apiKey:'bingx-key',secret:'bingx-test-secret-value-0123456789',mode:'TESTNET',fetcher,now:()=>T10})};
}
const cfg10=(extra={})=>({mode:'TESTNET',liveConfirmed:false,venues:['BINGX','GATEIO'],maxRiskUSD:2,dailyMaxRiskUSD:6,maxOpen:1,...extra});
const sigRow=(extra={})=>({symbol:'ETHUSDT',executionVenue:'BINGX',venueSymbol:'ETH-USDT',direction:'LONG',stop:98,targets:[105,108,112],
 venueContract:{quantityUnit:'BASE_ASSET',contractSizeBase:'1',quantityStep:'0.01',minQuantityBase:'0.01',tickSize:'0.01'},
 targetPlan:{quantity:0.6},execution:{estimatedStopLossUSD:6},decision:{ready:true},...extra});
const zones10=[97,94,91,88,85,82].map(p=>({priceLow:p-.3,priceHigh:p+.3}));
const hybridSig=sigRow({entry:100,score:95,marketCap:3e8,paperAddInputs:{atr:1,takerRate:.0005,zoneSets:[{label:'15분봉 3일',zones:zones10}]}});

test('an existing testnet signal keeps its stop and targets when signal entries are disabled',async()=>{
 const m=mockBingX(),ex=new LiveExecutor({config:cfg10({testnetSignalEntries:false}),clients:{BINGX:m.client},now:()=>T10});
 const p={signalKey:'old',clientOrderId:'old',symbol:'ETHUSDT',venueSymbol:'ETH-USDT',venue:'BINGX',mode:'TESTNET',direction:'LONG',hedge:true,
  status:'OPEN',quantity:{total:.2},position:{size:.2,entryPrice:100.02},stop:98,stopOrderId:'9001',targetOrderIds:['9002'],
  adds:[{orderId:'9003',qty:.2,price:95}],events:[]};
 ex.store.records.push(p);
 assert.throws(()=>ex.arm(),/TESTNET_SIGNAL_DISABLED/);
 assert.deepEqual(await ex.onSignal(sigRow(),{signalKey:'new'}),{sent:false,reasons:['TESTNET_SIGNAL_DISABLED']});
 await ex.reconcile();
 assert.deepEqual(m.canceled,['9003']);assert.equal(p.adds[0].cancelled,true);
 assert.equal(p.status,'OPEN');assert.equal(p.stopOrderId,'9001');assert.deepEqual(p.targetOrderIds,['9002']);
 assert.deepEqual(m.orders,[]);
});

test('M1: a stricter signal profile (CONSERVATIVE 3 %) is never loosened to the shared 15 %',async()=>{
 assert.equal(liveConfig({LIVE_TRADING_MODE:'TESTNET',LIVE_RISK_PROFILE:'conservative'}).dailyMaxLossPct,3);
 const cfg=cfg10({sizing:'BALANCE',unitPct:.19,maxLossPct:1,maxAdds:7,dailyMaxLossPct:3,maxOpen:4,maxPerDirection:2,strategyProfile:'HYBRID',hybridMaxAdds:3,riskProfile:'CONSERVATIVE'});
 const old={signalKey:'old',clientOrderId:'old',symbol:'BTCUSDT',venue:'BINGX',mode:'TESTNET',direction:'SHORT',status:'OPEN',plannedRiskUSD:25,day:'2026-11-09',leverage:10,quantity:{total:0.001},stopOrderId:'x',events:[{type:'PROTECTED'}]};
 for(const budget of [null,new TestnetBudget({dailyLossPct:15,now:()=>T10})]){
  const m=mockBingX({positionAmt:()=>'0.01'}),ex=new LiveExecutor({config:cfg,clients:{BINGX:m.client},now:()=>T10,budget});ex.store.records.push({...old});
  budget?.register('signal',ex.budgetSource()).register('scalp',{realizedToday:()=>0,openRisk:()=>0,usedMargin:()=>0});
  ex.arm();const r=await ex.onSignal(hybridSig,{signalKey:'m1'+Boolean(budget)});
  assert.equal(r.sent,false);assert.ok(r.reasons.includes('OPEN_RISK_LIMIT'),'25 + ~10 > 3 % of 1,000 '+(budget?'with':'without')+' the budget: '+JSON.stringify(r.reasons));
 }
});

test('L6: the shared budget also applies with RISK_USD sizing',async()=>{
 const budget=new TestnetBudget({dailyLossPct:15,now:()=>T10}),m=mockBingX({positionAmt:()=>'0.20'});
 const ex=new LiveExecutor({config:cfg10({sizing:'RISK_USD',maxOpen:4,maxPerDirection:2}),clients:{BINGX:m.client},now:()=>T10,budget});
 budget.register('signal',ex.budgetSource()).register('scalp',{realizedToday:()=>0,openRisk:()=>149,usedMargin:()=>0});ex.arm();
 const r=await ex.onSignal(sigRow(),{signalKey:'l6'});assert.equal(r.sent,false);assert.ok(r.reasons.includes('OPEN_RISK_LIMIT'),JSON.stringify(r.reasons));
});

test('M4: a trade closed today cannot be deleted, and deleted (archived) trades still count today',()=>{
 const ex=new LiveExecutor({config:liveCfg(),clients:{},now:()=>NOW});
 ex.store.records.push({signalKey:'y',symbol:'AUSDT',mode:'TESTNET',status:'CLOSED',day:'2026-11-16',createdAt:NOW-20*3600000,closedAt:NOW-3600000,plannedRiskUSD:30,realized:{source:'EXCHANGE',netUSD:-30}});
 assert.equal(ex.deleteBlock(ex.store.records[0]),'TODAY_COUNTS_FOR_DAILY_RISK','entered yesterday, closed today: kept');
 assert.equal(ex.deleteRecord('y').ok,false);assert.equal(ex.budgetSource().realizedToday('2026-11-17'),-30);
 ex.store.archived.push({signalKey:'z',symbol:'BUSDT',mode:'TESTNET',status:'CLOSED',closedAt:NOW-1800000,realized:{source:'EXCHANGE',netUSD:-12}},
  {signalKey:'w',symbol:'CUSDT',mode:'LIVE',status:'CLOSED',closedAt:NOW-1800000,realized:{source:'EXCHANGE',netUSD:-99}});
 assert.equal(ex.budgetSource().realizedToday('2026-11-17'),-42,'archived TESTNET record of today counted, LIVE one not');
 ex.store.records[0].closedAt=NOW-30*3600000;assert.equal(ex.deleteBlock(ex.store.records[0]),null,'closed yesterday: deletable');
});

test('M2: no offset between strategies — a signal win never lets the scalp lose past the limit',()=>{
 const b=new TestnetBudget({dailyLossPct:15,now:()=>NOW}).register('signal',{realizedToday:()=>900,openRisk:()=>0,usedMargin:()=>0}).register('scalp',{realizedToday:()=>-1500,openRisk:()=>0,usedMargin:()=>0});
 assert.equal(b.check({equity:10000,newRiskUSD:50}).reason,'DAILY_LOSS_LIMIT','scalp -1,500 = 15 % of 10,000 whatever the signal won');
 const c=new TestnetBudget({dailyLossPct:15,now:()=>NOW}).register('signal',{realizedToday:()=>900}).register('scalp',{realizedToday:()=>-1000});
 assert.equal(c.snapshot(10000).lossUSD,1000);assert.equal(c.check({equity:10000,newRiskUSD:50}).ok,true);
});

test('M5: an unsettled signal close counts as the estimate from its fills (planned loss only without fills), marked provisional',()=>{
 const ex=new LiveExecutor({config:liveCfg(),clients:{},now:()=>NOW});
 ex.store.records.push({signalKey:'tp',symbol:'AUSDT',direction:'LONG',mode:'TESTNET',status:'CLOSED',closeReason:'POSITION_FLAT',day:'2026-11-17',createdAt:NOW-3600000,closedAt:NOW-10000,plannedRiskUSD:30,exits:[{qty:1,price:110,at:NOW-10000}],position:{entryPrice:100,size:0}});
 const src=ex.budgetSource(),v=src.realizedToday('2026-11-17');assert.ok(v>9&&v<10,'+10 minus fees by its exits: '+v);assert.equal(src.provisionalToday('2026-11-17'),true);
 delete ex.store.records[0].exits;assert.equal(src.realizedToday('2026-11-17'),-30,'no fills: the planned loss');
 ex.store.records[0].realized={source:'EXCHANGE',netUSD:9.5};assert.equal(src.realizedToday('2026-11-17'),9.5);assert.equal(src.provisionalToday('2026-11-17'),false);
});

test('L3: the merged testnet list shows only TESTNET signal records, no test orders',()=>{
 const liveRec=liveClosedView({signalKey:'real1',symbol:'REALUSDT',mode:'LIVE',status:'CLOSED',direction:'LONG',createdAt:NOW-7200000,closedAt:NOW-3600000,realized:{source:'EXCHANGE',netUSD:-55}},NOW);
 const testRec=liveClosedView({signalKey:'t1',symbol:'TESTUSDT',mode:'TESTNET',status:'CLOSED',test:true,direction:'LONG',createdAt:NOW-7200000,closedAt:NOW-3600000},NOW);
 const tn=liveClosedView({signalKey:'n1',symbol:'NETUSDT',mode:'TESTNET',status:'CLOSED',direction:'LONG',createdAt:NOW-7200000,closedAt:NOW-3600000,realized:{source:'EXCHANGE',netUSD:3}},NOW);
 assert.deepEqual(testnetCloses({closed:[liveRec,testRec,tn],scalp:{closed:[]}}).map(x=>x.symbol),['NETUSDT']);
 setTestnetPage(0);assert.doesNotMatch(testnetClosedHTML({closed:[liveRec],scalp:{closed:[]}}),/REALUSDT/);
});

test('L2: a scalp-only day stop saved before the shared budget (no shared:true) is ignored; a shared one counts',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'tn-l2-'));
 try{
  fs.writeFileSync(path.join(dir,'scalp-store.json'),JSON.stringify({version:1,open:[],closed:[],events:[],dailyStop:{day:kstDay(NOW),at:NOW-1000,lossUSD:-31,equity:1000}}));
  const b=new TestnetBudget({dailyLossPct:15,now:()=>NOW}),sc=new ScalpExecutor({config:scalpExecConfig({}),client:{mode:'TESTNET'},directory:dir,now:()=>NOW,budget:b});
  b.register('signal',{realizedToday:()=>0,openRisk:()=>0,usedMargin:()=>0}).register('scalp',sc.budgetSource());
  assert.equal(b.check({equity:1000,newRiskUSD:30}).ok,true,'old 3 % stop: not a shared stop');sc.arm();assert.equal(sc.status().blocked,null);
  sc.store.dailyStop.shared=true;assert.equal(b.check({equity:1000,newRiskUSD:30}).reason,'DAILY_LOSS_LIMIT');assert.equal(sc.status().blocked,'DAILY_LOSS_LIMIT');
 }finally{fs.rmSync(dir,{recursive:true,force:true})}
});

test('L1: the shared stop is written to its own file when first reached and holds for the KST day (results recover, scalp off, restart)',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'tn-l1-')),clock={t:NOW};
 try{
  let sig=-150;const mk=()=>new TestnetBudget({dailyLossPct:15,now:()=>clock.t,directory:dir}).register('signal',{realizedToday:()=>sig,openRisk:()=>0,usedMargin:()=>0});
  const b=mk();assert.equal(b.check({equity:1000,newRiskUSD:1}).reason,'DAILY_LOSS_LIMIT');
  const saved=JSON.parse(fs.readFileSync(path.join(dir,'testnet-budget.json'),'utf8'));assert.equal(saved.stop.day,'2026-11-17');assert.equal(saved.stop.lossUSD,150);
  sig=+20;assert.equal(b.check({equity:1000,newRiskUSD:1}).reason,'DAILY_LOSS_LIMIT','a later recovery does not lift it');
  assert.equal(mk().check({equity:1000,newRiskUSD:1}).reason,'DAILY_LOSS_LIMIT','after a restart, no scalp registered');
  clock.t+=24*3600000;assert.equal(mk().check({equity:1000,newRiskUSD:1}).ok,true,'next KST day');
  // A placeholder figure blocks now but is never written.
  const d2=fs.mkdtempSync(path.join(os.tmpdir(),'tn-l1b-'));
  const p=new TestnetBudget({dailyLossPct:15,now:()=>NOW,directory:d2}).register('signal',{realizedToday:()=>-150,provisionalToday:()=>true});
  assert.equal(p.check({equity:1000,newRiskUSD:1}).reason,'DAILY_LOSS_LIMIT');assert.equal(fs.existsSync(path.join(d2,'testnet-budget.json')),false);
  fs.rmSync(d2,{recursive:true,force:true});
 }finally{fs.rmSync(dir,{recursive:true,force:true})}
});

test('M3: without the shared screen (signal strategy LIVE) the scalp keeps its own panel and buttons',()=>{
 const sc=new ScalpExecutor({config:scalpExecConfig({}),client:{mode:'TESTNET'},now:()=>NOW});
 const h=scalpHTML(sc.status());assert.match(h,/data-scalp-arm/);assert.match(h,/○ 꺼짐/);
 sc.arm();assert.match(scalpHTML(sc.status()),/data-scalp-disarm/);
 const html=fs.readFileSync(new URL('../public/index.html',import.meta.url),'utf8');assert.match(html,/id="liveScalpPanel"/);assert.match(html,/id="liveScalpOwn"/);
});

// Scalp harness (as tests/scalp_executor.test.mjs).
const I=300000,BUCKET=Math.floor(Date.parse('2026-11-16T03:00:00Z')/I),T0=BUCKET*I+5000;
function crash(){
 const rows=[];let p=100;const push=(o,h,l,c,v)=>rows.push([0,o,h,l,c,v]),move=6,volume=10,lastOpen=(BUCKET-1)*I;
 for(let i=0;i<50;i++){const o=p,c=p+(i%2?.05:-.05);push(o,Math.max(o,c)+.1,Math.min(o,c)-.1,c,100);p=c}
 for(let i=0;i<4;i++){const o=p,c=p-move/4;push(o,o+.05,c-.1,c,100*volume*(i===3?1:.5));p=c}
 push(p,p+.15,p-.8,p+.1,80*volume);
 return rows.map((r,i)=>{const t=lastOpen-(rows.length-1-i)*I;return [t,...r.slice(1,6).map(String),t+I-1,String(r[5]*r[4])]});
}
const up4h=now=>Array.from({length:301},(_,i)=>{const t=now-(301-i)*4*3600000-1000,c=50+i*.1;return [t,String(c),String(c+.2),String(c-.2),String(c),'1000',t+4*3600000-1,'1']});
const PX=+(Number(crash().at(-1)[4])+.02).toFixed(2);
const SOL={symbol:'SOLUSDT',venueSymbol:'SOL-USDT',tickSize:'0.01',quantityStep:'0.01',minQuantityBase:'0.01',minNotionalUSDT:2,tradable:true};
function venue({onMarket=null}={}){
 const orders=new Map();let amt=0,avg=0,mark=0,id=1;
 const reduce=q=>{amt=amt>0?+Math.max(0,amt-q).toFixed(8):+Math.min(0,amt+q).toFixed(8)};
 const add=(p,extra={})=>{const o={orderId:String(id++),...p,status:'NEW',executedQty:'0',...extra};orders.set(o.orderId,o);return o};
 const client={mode:'TESTNET',positionMode:async()=>({dualSidePosition:false}),marginType:async()=>({marginType:'CROSSED'}),setMarginType:async()=>({}),
  leverage:async()=>({maxLongLeverage:20,maxShortLeverage:20}),setLeverage:async(s,side,l)=>({leverage:l}),
  positions:async()=>amt!==0?[{symbol:'SOL-USDT',positionSide:'BOTH',positionAmt:String(amt),avgPrice:String(avg),markPrice:String(mark||avg),unrealizedProfit:String(((mark||avg)-avg)*amt)}]:[],
  openOrders:async()=>({orders:[...orders.values()].filter(o=>o.status==='NEW')}),
  getOrder:async(s,{orderId,clientOrderId})=>({order:[...orders.values()].find(o=>orderId?o.orderId===orderId:o.clientOrderId===clientOrderId)??null}),
  cancelOrder:async(s,oid)=>{const o=orders.get(oid);if(o&&o.status==='NEW')o.status='CANCELED';return {}},
  placeOrder:async p=>{
   if(p.type==='MARKET'){const q=Number(p.quantity);
    if(p.reduceOnly){reduce(q);return {order:add(p,{status:'FILLED',executedQty:String(q),avgPrice:String(mark||avg)})}}
    onMarket?.();avg=mark||PX;amt=+(amt+(p.side==='SELL'?-q:q)).toFixed(8);const o=add(p,{status:'FILLED',executedQty:String(q),avgPrice:String(avg)});
    if(p.stopLoss){const sl=JSON.parse(p.stopLoss);add({symbol:p.symbol,type:'STOP_MARKET',stopPrice:String(sl.stopPrice),side:'SELL'})}
    return {order:o}}
   return {order:add(p)}}};
 return {client,set mark(v){mark=v},get avg(){return avg}};
}
const scalpMake=(v,{clock,funds,budget})=>new ScalpExecutor({config:{...scalpExecConfig({})},client:v.client,contracts:async()=>new Map([['SOLUSDT',SOL]]),tickers:async()=>[{symbol:'SOL-USDT',quoteVolume:'90000000'}],
 candles:async(s,iv)=>iv==='5m'?[...crash(),[BUCKET*I,'100','100','100','100','1',BUCKET*I+I-1,'1']]:up4h(clock.t),priceOf:async()=>PX,markOf:async()=>101,
 balance:async()=>funds,gate:()=>({ok:true}),isBusy:()=>false,directory:null,now:()=>clock.t,budget});

test('M5: the scalp check never writes a day stop from a placeholder (unsettled signal close); it looks again later',async()=>{
 const clock={t:T0},funds={equity:1000,available:900},budget=new TestnetBudget({dailyLossPct:15,now:()=>clock.t});
 const live=new LiveExecutor({config:liveCfg(),clients:{},now:()=>clock.t}),day=kstDay(clock.t);
 live.store.records.push(
  {signalKey:'l1',symbol:'L1USDT',mode:'TESTNET',status:'CLOSED',day,closedAt:clock.t-3600000,plannedRiskUSD:30,realized:{source:'EXCHANGE',netUSD:-55}},
  {signalKey:'l2',symbol:'L2USDT',mode:'TESTNET',status:'CLOSED',day,closedAt:clock.t-3000000,plannedRiskUSD:30,realized:{source:'EXCHANGE',netUSD:-55}},
  {signalKey:'tp',symbol:'TPUSDT',mode:'TESTNET',status:'CLOSED',day,closedAt:clock.t-20000,plannedRiskUSD:30,position:{entryPrice:100,size:0}}); // no fills read: placeholder -30
 const v=venue(),ex=scalpMake(v,{clock,funds,budget});budget.register('signal',live.budgetSource()).register('scalp',ex.budgetSource());
 ex.arm();await ex.scan();assert.equal(ex.store.open.length,1);
 // -110 - 30 (placeholder) - 10.5 (scalp open) = -150.5: reached only with the placeholder.
 v.mark=v.avg-10.5/ex.store.open[0].size;clock.t+=30000;await ex.reconcile();
 assert.equal(ex.store.dailyStop,null,'not written from a placeholder');assert.equal(budget.storedStop(),null);
 live.store.records[2].realized={source:'EXCHANGE',netUSD:25};clock.t+=30000;await ex.reconcile();
 assert.equal(budget.storedStop(),null,'settled: -85 - 10.5, far from the limit');assert.equal(budget.check({equity:1000,newRiskUSD:1}).ok,true);
 // Final values that do reach it: written once, both stopped, the switch stays on.
 live.store.records[2].realized={source:'EXCHANGE',netUSD:-40};clock.t+=30000;await ex.reconcile();
 assert.equal(budget.storedStop()?.day,day);assert.equal(ex.store.dailyStop.shared,true);assert.equal(ex.armed,true);
});

test('L4: a scalp entry being placed counts its risk once (the reservation is dropped when it enters the ledger)',async()=>{
 const clock={t:T0},funds={equity:10000,available:9000},budget=new TestnetBudget({dailyLossPct:15,now:()=>clock.t});let seen=null;
 const v=venue({onMarket:()=>{seen=budget.snapshot(10000).by.scalp}}),ex=scalpMake(v,{clock,funds,budget});budget.register('scalp',ex.budgetSource());
 ex.arm();await ex.scan();const risk=ex.store.open[0].riskUSD;
 assert.ok(Math.abs(seen.openRiskUSD-risk)<1,`once during placeOrder: ${seen.openRiskUSD} vs ${risk}`);
 assert.ok(Math.abs(budget.snapshot(10000).by.scalp.openRiskUSD-risk)<1e-6);
});

test('confirmed signal leverage is included before sending the entry against the shared margin cap',async()=>{
 const mock=mockBingX({maxLeverage:5});
 const budget=new TestnetBudget({now:()=>T10}).register('scalp',{usedMargin:()=>297.5});
 const ex=new LiveExecutor({config:cfg10({sizing:'RISK_USD'}),clients:{BINGX:mock.client},now:()=>T10,budget});
 budget.register('signal',ex.budgetSource());
 ex.arm();
 const result=await ex.onSignal(sigRow({entry:100,leverage:10}),{signalKey:'capped-leverage'});
 assert.deepEqual(result,{sent:false,reasons:['TESTNET_MARGIN_CAP']});
 assert.equal(mock.orders.length,0);
 assert.equal(ex.store.records.length,0);
 assert.equal(budget.snapshot().marginUSD,297.5);
});

test('scalp sizing uses the remaining shared margin on the lower account basis',async()=>{
 const clock={t:T0},funds={equity:10000,available:9000},budget=new TestnetBudget({now:()=>clock.t});
 const v=venue(),ex=scalpMake(v,{clock,funds,budget});
 budget.register('signal',{usedMargin:()=>290}).register('scalp',ex.budgetSource());
 budget.basis(1000,'signal');
 ex.arm();
 assert.equal((await ex.scan()).entered,1,'the valid smaller order can still be sent');
 const snapshot=budget.snapshot();
 assert.equal(snapshot.marginCapUSD,300);
 assert.ok(snapshot.marginUSD>290&&snapshot.marginUSD<=300);
});

test('testnet scalp stops entry after preparation, before adding a sent ID',async()=>{
 for(const stop of ['disarm','kill','lowered budget']){
  const clock={t:T0},funds={equity:10000,available:9000},budget=new TestnetBudget({now:()=>clock.t});
  let sent=0;
  const v=venue({onMarket:()=>sent++}),ex=scalpMake(v,{clock,funds,budget});
  budget.register('signal',{usedMargin:()=>290}).register('scalp',ex.budgetSource());
  const waiting=Promise.withResolvers(),resume=Promise.withResolvers();
  v.client.setLeverage=async()=>{waiting.resolve();await resume.promise;return {leverage:10}};
  ex.arm();
  const scan=ex.scan();
  await waiting.promise;
  if(stop==='disarm'){ex.disarm();ex.arm()}
  if(stop==='kill'){ex.gate=()=>({ok:false,reason:'KILL_SWITCH'});ex.disarm('KILL_SWITCH')}
  if(stop==='lowered budget')budget.basis(1000,'signal');
  resume.resolve();
  assert.equal((await scan).entered,0,stop);
  assert.equal(sent,0);
  assert.equal(ex.store.sent.length,0);
  assert.equal(ex.store.open.length,0);
  assert.equal(ex.reservedRisk.size,0);
 }
});

test('the shared margin cap is checked again before placing resting adds after the entry fills',async()=>{
 const mock=mockBingX({positionAmt:()=>'0.20'});
 let scalpMargin=0;
 const budget=new TestnetBudget({now:()=>T10}).register('scalp',{usedMargin:()=>scalpMargin});
 const cfg=cfg10({sizing:'BALANCE',unitPct:.19,maxLossPct:1,maxAdds:7,dailyMaxLossPct:3,maxOpen:4,maxPerDirection:2,
  strategyProfile:'HYBRID',hybridMaxAdds:3,riskProfile:'CONSERVATIVE'});
 const ex=new LiveExecutor({config:cfg,clients:{BINGX:mock.client},now:()=>T10,budget});
 budget.register('signal',ex.budgetSource());
 const openOrders=mock.client.openOrders.bind(mock.client);
 mock.client.openOrders=(...args)=>{scalpMargin=299;return openOrders(...args)};
 ex.arm();
 assert.equal((await ex.onSignal(hybridSig,{signalKey:'margin-after-entry'})).status,'OPEN');
 const record=ex.store.records[0];
 assert.ok(record.stopOrderId);
 assert.ok(record.adds.length>0&&record.adds.every(add=>add.skipped&&!add.orderId));
 assert.ok(record.events.some(e=>e.type==='ADDS_SKIPPED'&&e.reason==='TESTNET_MARGIN_CAP'));
});

test('testnet $3,000 capitalCapUSD scales legacy VST positions/closes proportionally while keeping $3k-capped trades 1:1',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sl-cap-3k-'));
 try{
  const b=new TestnetBudget({accountEquity:true,capitalCapUSD:3000,directory:dir,now:()=>NOW});
  b.observeAccount(150000,'VST');
  const st=b.status();
  assert.equal(st.equityUSD,3000);
  assert.equal(st.capitalCapUSD,3000);
  assert.equal(st.displayScale,0.02);
  assert.equal(st.limitUSD,450);
  assert.equal(st.marginCapUSD,900);

  // Configure capitalCapUSD to 5000 -> persists across restart; 0 -> uncaps to null
  const updated=b.configure({dailyLossPct:15,marginCapPct:30,capitalCapUSD:5000});
  assert.equal(updated.capitalCapUSD,5000);
  assert.equal(updated.equityUSD,5000);
  const reloaded=new TestnetBudget({accountEquity:true,capitalCapUSD:3000,directory:dir,now:()=>NOW});
  reloaded.observeAccount(150000,'VST');
  assert.equal(reloaded.capitalCapUSD,5000);
  const uncapped=reloaded.configure({dailyLossPct:15,marginCapPct:30,capitalCapUSD:0});
  assert.equal(uncapped.capitalCapUSD,undefined);
  assert.equal(uncapped.equityUSD,150000);

  // Proportional display scaling in UI: legacy VST trade scales by 0.02, new $3,000 trade stays 1:1
  const budget={equityUSD:3000,accountEquityUSD:150000,capitalCapUSD:3000,displayScale:0.02,dailyLossPct:15,limitUSD:450,openRiskUSD:30,marginUSD:120,marginCapUSD:900,marginCapPct:30};
  const bHtml=testnetBudgetHTML({armed:true,budget});
  assert.match(bHtml,/기준 자본 \$3,000\.00 \(VST 비례 환산\)/);

  const legacyCard=scalpPositionCardHTML({symbol:'BTCUSDT',direction:'LONG',status:'OPEN',avg:100,mark:95,size:100,stop:90,targets:[],parts:[],riskUSD:1000,unrealized:-500,leverage:10,openedAt:NOW},{budget});
  assert.match(legacyCard,/비례환산/);
  assert.match(legacyCard,/−\$10\.00/);
  assert.match(legacyCard,/\$20\.00/);

  const freshCard=scalpPositionCardHTML({symbol:'ETHUSDT',direction:'LONG',status:'OPEN',avg:100,mark:105,size:2,stop:95,targets:[],parts:[],riskUSD:30,unrealized:10,leverage:10,capitalBasisUSD:3000,openedAt:NOW},{budget});
  assert.doesNotMatch(freshCard,/비례환산/);
  assert.match(freshCard,/\+\$10\.00/);

  const closedHtml=testnetClosedHTML({
   testnet:{scalpOnly:true,budget},
   scalp:{closed:[
    {id:'legacy1',symbol:'OLDUSDT',direction:'LONG',openedAt:NOW-3600000,closedAt:NOW-1000,closeReasonKo:'익절',netUSD:1000,netSource:'EXCHANGE',leverage:10,margin:{initialUSD:5000,totalUSD:10000}},
    {id:'new1',symbol:'NEWUSDT',direction:'SHORT',openedAt:NOW-1800000,closedAt:NOW,closeReasonKo:'익절',netUSD:25,netSource:'EXCHANGE',leverage:10,margin:{initialUSD:200,totalUSD:200},capitalBasisUSD:3000},
   ]},
  });
  assert.match(closedHtml,/\+\$20\.00/,'legacy $1000 * 0.02 = $20.00');
  assert.match(closedHtml,/\+\$25\.00/,'new $3k trade stays 1:1 at $25.00');
  assert.match(testnetSummaryHTML({all:{trades:2,wins:2,winRatePct:100,profitFactor:null,netUSD:45},signal:{trades:0,netUSD:0},scalp:{trades:2,netUSD:45}},{scalpOnly:true,open:[],budget}),/기준 자본 \$3,000\.00 비례 환산/);
 }finally{fs.rmSync(dir,{recursive:true,force:true})}
});

test('when BingX VST equity is reduced to $3,000, legacy oversized VST trades still scale proportionally and stale unscaled dailyStop self-heals',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sl-vst-reset-3k-'));
 try{
  const day=kstDay(NOW);
  // Simulate pre-fix persisted state: budget stop and scalp dailyStop recorded from -$8,652 unscaled legacy VST closes
  fs.writeFileSync(path.join(dir,'testnet-budget.json'),JSON.stringify({
   version:1,
   stop:{day,at:NOW-60000,lossUSD:8652.24,limitUSD:1500,reason:'REALIZED'},
   settings:{dailyLossPct:50,marginCapPct:30,capitalCapUSD:3000},
  }));
  fs.writeFileSync(path.join(dir,'scalp-store.json'),JSON.stringify({
   version:1,strategy:'SCALP_REVERSAL',open:[],
   closed:[
    {id:'leg1',symbol:'RENDERUSDT',direction:'SHORT',netUSD:-3249.02,closedAt:NOW-120000,closeReason:'MANUAL',initialRiskUSD:818.57,initialMarginUSD:8125.60},
    {id:'leg2',symbol:'INJUSDT',direction:'LONG',netUSD:-2484.50,closedAt:NOW-120000,closeReason:'MANUAL',initialRiskUSD:913.93,initialMarginUSD:6996.77},
    {id:'leg3',symbol:'SEIUSDT',direction:'LONG',netUSD:-2051.60,closedAt:NOW-120000,closeReason:'MANUAL',initialRiskUSD:597.82,initialMarginUSD:5849.28},
   ],
   events:[],skips:[],skipCounts:{},sent:[],
   dailyStop:{day,at:NOW-60000,lossUSD:-8652.24,equity:3000,shared:true},
  }));
  const budget=new TestnetBudget({accountEquity:true,capitalCapUSD:3000,directory:dir,now:()=>NOW});
  budget.observeAccount(3000,'VST'); // VST account itself is now $3,000 -> displayScale() === 1
  const sc=new ScalpExecutor({config:scalpExecConfig({}),client:{mode:'TESTNET'},directory:dir,now:()=>NOW,budget});
  budget.register('scalp',sc.budgetSource());

  // Legacy oversized trades must be scaled down (~-$110 instead of -$7,785) and stale unscaled stop must self-heal!
  // Also verifies one-time migration of old pinned ceiling (50%/30%) -> 100%/100% ($3,000/$3,000).
  const st=budget.status();
  assert.equal(st.dailyLossPct,100);
  assert.equal(st.marginCapPct,100);
  assert.equal(st.limitUSD,3000);
  assert.equal(st.marginCapUSD,3000);
  assert.equal(st.stopped,false,'impossible -$8,652 stop on $3,000 equity self-heals');
  assert.ok(st.lossUSD<200,`scaled today loss should be < $200, got $${st.lossUSD}`);
  assert.ok(Math.abs(sc.stats().netUSD)<200,`scaled stats netUSD should be realistic for $3k, got $${sc.stats().netUSD}`);
  sc.arm();
  assert.equal(sc.status().blocked,null,'5m scalp scanning is unblocked immediately');

  // Subsequent explicit manual edit back to 50%/30% is preserved across restart
  budget.configure({dailyLossPct:50,marginCapPct:30,capitalCapUSD:3000});
  const afterManual=new TestnetBudget({accountEquity:true,capitalCapUSD:3000,directory:dir,now:()=>NOW});
  assert.deepEqual([afterManual.dailyLossPct,afterManual.marginCapPct],[50,30]);

  // UI closed list also scales legacy oversized trades even when displayScale === 1
  const h=testnetClosedHTML({
   testnet:{scalpOnly:true,budget:st},
   scalp:{closed:[{id:'leg1',symbol:'RENDERUSDT',direction:'SHORT',openedAt:NOW-3600000,closedAt:NOW-120000,closeReasonKo:'수동 청산',netUSD:-3249.02,netSource:'EXCHANGE',leverage:10,initialRiskUSD:818.57,initialMarginUSD:8125.60,margin:{initialUSD:8125.60,totalUSD:11518.02}}]},
  });
  assert.doesNotMatch(h,/3,249|3249/,'raw -$3,249 VST loss should be scaled down to ~$60');

  // Explicit clearStop clears a legitimate stop and UI renders the clear-stop button when stopped
  budget.markStopped({lossUSD:500,limitUSD:450,reason:'REALIZED'},day);
  assert.equal(budget.status().stopped,true);
  assert.match(testnetBudgetHTML({armed:true,budget:budget.status()}),/data-testnet-clear-stop/);
  budget.clearStop();
  assert.equal(budget.status().stopped,false);
 }finally{fs.rmSync(dir,{recursive:true,force:true})}
});

test('one-time 50%/30% -> 100%/100% migration clears stale stop recorded under old 50% limit',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'tb-mig-stop-'));
 const day=kstDay(NOW);
 try{
  fs.writeFileSync(path.join(dir,'testnet-budget.json'),JSON.stringify({
   version:1,
   stop:{day,at:NOW-60000,lossUSD:1703.65,limitUSD:1500,reason:'REALIZED'},
   settings:{dailyLossPct:50,marginCapPct:30,capitalCapUSD:3000},
  }));
  const budget=new TestnetBudget({accountEquity:true,capitalCapUSD:3000,now:()=>NOW,directory:dir});
  budget.observeAccount(3002.06,'VST');
  const st=budget.status();
  assert.equal(st.dailyLossPct,100);
  assert.equal(st.marginCapPct,100);
  assert.equal(st.stopped,false,'auto-migration from 50%/30% to 100%/100% clears stale 50%-limit stop');
 }finally{fs.rmSync(dir,{recursive:true,force:true})}
});

test('when VST equity rises slightly above $3,000 cap (e.g. $3,002.06 -> displayScale=0.9993), legacy oversized VST trades still scale down and never re-trip DAILY_LOSS_LIMIT',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sl-vst-3002-'));
 try{
  const day=kstDay(NOW);
  fs.writeFileSync(path.join(dir,'scalp-store.json'),JSON.stringify({
   version:1,strategy:'SCALP_REVERSAL',open:[{id:'open1',symbol:'BTCUSDT',direction:'LONG',status:'OPEN',avg:90000,size:0.01,leverage:10,capitalBasisUSD:3000}],
   closed:[
    {id:'leg1',symbol:'RENDERUSDT',direction:'SHORT',netUSD:-3249.02,closedAt:NOW-120000,closeReason:'MANUAL',initialRiskUSD:818.57,initialMarginUSD:8125.60},
    {id:'leg2',symbol:'INJUSDT',direction:'LONG',netUSD:-2484.50,closedAt:NOW-120000,closeReason:'MANUAL',initialRiskUSD:913.93,initialMarginUSD:6996.77},
    {id:'leg3',symbol:'SEIUSDT',direction:'LONG',netUSD:-2051.60,closedAt:NOW-120000,closeReason:'MANUAL',initialRiskUSD:597.82,initialMarginUSD:5849.28},
    {id:'new1',symbol:'IDOLUSDT',direction:'LONG',netUSD:2.0605,closedAt:NOW-30000,closeReason:'EARLY_TAKE_PROFIT',capitalBasisUSD:3000,initialRiskUSD:8.28,initialMarginUSD:58.02},
   ],
   events:[],skips:[],skipCounts:{},sent:[],dailyStop:null,
  }));
  const budget=new TestnetBudget({dailyLossPct:100,marginCapPct:100,accountEquity:true,capitalCapUSD:3000,directory:dir,now:()=>NOW});
  budget.observeAccount(3002.0605,'VST'); // displayScale() = 0.999314 (< 1)
  assert.ok(budget.displayScale()>0.99&&budget.displayScale()<1);
  const sc=new ScalpExecutor({config:scalpExecConfig({}),client:{mode:'TESTNET'},directory:dir,now:()=>NOW,budget});
  budget.register('scalp',sc.budgetSource());

  const st=budget.status();
  assert.equal(st.stopped,false,'must not trip DAILY_LOSS_LIMIT when equity rises to $3,002.06');
  assert.ok(st.lossUSD<200,`legacy losses must still scale down even when displayScale=0.9993, got $${st.lossUSD}`);
  sc.arm();
  assert.equal(sc.status().blocked,null);

  // UI tnScaleOf also scales legacy oversized trades when displayScale=0.9993
  const h=testnetClosedHTML({
   testnet:{scalpOnly:true,budget:st},
   scalp:{closed:[
    {id:'leg1',symbol:'RENDERUSDT',direction:'SHORT',openedAt:NOW-3600000,closedAt:NOW-120000,closeReasonKo:'수동 청산',netUSD:-3249.02,netSource:'EXCHANGE',leverage:10,initialRiskUSD:818.57,initialMarginUSD:8125.60},
    {id:'new1',symbol:'IDOLUSDT',direction:'LONG',openedAt:NOW-60000,closedAt:NOW-30000,closeReasonKo:'조기 익절',netUSD:2.0605,netSource:'EXCHANGE',leverage:10,capitalBasisUSD:3000,initialRiskUSD:8.28,initialMarginUSD:58.02},
   ]},
  });
  assert.doesNotMatch(h,/3,249|3249|3,246|3246/,'UI must scale legacy trade down even when displayScale=0.9993');
  assert.match(h,/\+\$2\.06/,'new $3k trade stays 1:1');

  // resetHistory() clears closed/journal/dailyStop while preserving open position and armed state
  sc.store.dailyStop={day,at:NOW,lossUSD:-500,equity:3000,shared:true};
  const r=sc.resetHistory();
  assert.equal(r.removed,4);
  assert.equal(sc.store.closed.length,0);
  assert.equal(sc.store.open.length,1,'open position preserved');
  assert.equal(sc.store.dailyStop,null);
  assert.equal(sc.armed,true);
  assert.equal(sc.stats().trades,0);
  assert.equal(sc.stats().netUSD,0);
  assert.equal(budget.status().lossUSD,0);
 }finally{fs.rmSync(dir,{recursive:true,force:true})}
});

