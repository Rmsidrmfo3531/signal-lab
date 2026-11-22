import test from 'node:test';import assert from 'node:assert/strict';
import {createDailyPnl,dailySince,kstMidnight} from '../daily_pnl.mjs';
import {BingXTradeClient} from '../live_clients.mjs';

const DAY=86400000,K=s=>Date.parse(s+'+09:00');

test('monthly P&L keeps the exact KST reset time and clamps older history to venue coverage',()=>{
 const now=K('2026-11-20T08:30:00'),reset=K('2026-11-19T11:43:24');
 assert.equal(kstMidnight(now),K('2026-11-20T00:00:00'));
 assert.equal(dailySince(now),K('2026-10-01T00:00:00'));
 assert.equal(dailySince(now,reset),reset);
 assert.equal(dailySince(K('2027-01-01T03:00:00')),K('2026-12-01T00:00:00'));
 assert.equal(dailySince(K('2027-06-01T12:00:00'),reset),kstMidnight(K('2027-06-01T12:00:00'))-84*DAY);
});

test('calendar reset excludes earlier income from the same day and ignores money flows',async()=>{
 const resetAt=K('2026-11-19T11:43:24'),now=resetAt+60000,requests=[];
 const rows=[
  ['REALIZED_PNL',100,resetAt-1],['REALIZED_PNL',5,resetAt],['TRADING_FEE',-1,resetAt+100],
  ['FUNDING_FEE',.2,resetAt+200],['DEPOSIT',300,resetAt+300],['WITHDRAW',-40,resetAt+400],
  ['WITHDRAWAL',-80,resetAt+500],['TRANSFER_IN',150,resetAt+600],['REALIZED_PNL',999,now+1]
 ].map(([incomeType,income,time],i)=>({incomeType,income,time,tranId:String(i)}));
 const calendar=createDailyPnl({resetAt,now:()=>now,client:{income:async q=>{requests.push(q);return rows}}});
 await calendar.refresh();
 assert.equal(requests[0].startTime,resetAt);
 assert.deepEqual(calendar.status(),{at:now,since:resetAt,byDay:{'2026-11-19':4.2},error:null,errorAt:null,resetAt,availableSince:resetAt});
});

test('daily P&L: background cache, incremental re-read, last good data kept on errors, never throws',async()=>{
 let t=K('2026-11-18T08:30:00');const calls=[];let fail=null;
 const days={'2026-11-15':-0.45,'2026-11-17':-3.2,'2026-11-18':1.23};
 const read=async(since,now)=>{calls.push({since,now});if(fail==='throw')throw Object.assign(Error('boom https://x?signature=SECRET'),{});if(fail)return {error:fail,since};
  return {byDay:Object.fromEntries(Object.entries(days).filter(([d])=>K(d+'T00:00:00')>=since))}};
 const d=createDailyPnl({read,now:()=>t});
 assert.deepEqual(d.status(),{at:null,since:null,byDay:{},error:null,errorAt:null},'nothing before the first read');
 await d.refresh();
 assert.equal(calls[0].since,K('2026-10-01T00:00:00'),'full read starts at the previous month');
 assert.deepEqual(d.status().byDay,days);assert.equal(d.status().at,t);assert.equal(d.status().since,K('2026-10-01T00:00:00'));
 // 5 minutes later: only from yesterday (KST), the older days kept.
 t+=5*60000;days['2026-11-18']=2.5;delete days['2026-11-15'];
 await d.refresh();
 assert.equal(calls[1].since,K('2026-11-17T00:00:00'));
 assert.deepEqual(d.status().byDay,{'2026-11-15':-0.45,'2026-11-17':-3.2,'2026-11-18':2.5},'days before the re-read window stay');
 // A failed read: error code with the last good data and its time.
 const good=d.status();t+=5*60000;fail='HTTP_429';await d.refresh();
 assert.equal(d.status().error,'HTTP_429');assert.equal(d.status().errorAt,t);assert.equal(d.status().at,good.at);assert.deepEqual(d.status().byDay,good.byDay);
 // A thrown error never escapes, and a venue message (could carry anything) is reduced to a code.
 fail='throw';await assert.doesNotReject(d.refresh());assert.equal(d.status().error,'READ_FAILED');
 assert.ok(!JSON.stringify(d.status()).includes('SECRET'));
 fail='<img src=x onerror=alert(1)>';await d.refresh();assert.equal(d.status().error,'READ_FAILED');
 // Recovery clears the error; an hour after the full read it reads the full range again.
 fail=null;t+=60*60000;await d.refresh();
 assert.equal(d.status().error,null);assert.equal(calls.at(-1).since,K('2026-10-01T00:00:00'));
 assert.deepEqual(d.status().byDay,days,'a full read replaces the days');
 // Bad keys / values from a read are dropped.
 const d2=createDailyPnl({read:async()=>({byDay:{'2026-11-18':'1.5','x':3,'2026-11-17':'abc'}}),now:()=>t});await d2.refresh();assert.deepEqual(d2.status().byDay,{'2026-11-18':1.5});
 // One read at a time: overlapping refreshes share it.
 let n=0,release;const d3=createDailyPnl({read:()=>{n++;return new Promise(r=>{release=()=>r({byDay:{}})})},now:()=>t});
 const a=d3.refresh(),b=d3.refresh();assert.equal(a,b);release();await a;assert.equal(n,1);
 // The status is a copy (a caller cannot change the cache).
 d.status().byDay['2026-11-18']=999;assert.notEqual(d.status().byDay['2026-11-18'],999);
});

test('daily P&L: start() reads fund flow in the background without needing account balance',async()=>{
 let t=K('2026-11-18T08:30:00');const seen=[];
 const client={income:async q=>{seen.push(q);return {list:q.startTime<=K('2026-11-17T10:00:00')&&q.endTime>K('2026-11-17T10:00:00')?[{tranId:'1',incomeType:'REALIZED_PNL',income:'-3',time:K('2026-11-17T10:00:00')},{tranId:'2',incomeType:'TRADING_FEE',income:'-0.2',time:K('2026-11-17T10:00:00')},{tranId:'3',incomeType:'TRANSFER',income:'100',time:K('2026-11-17T10:00:00')}]:[]}},
  balance:async()=>{throw Error('balance unavailable')}};
 const d=createDailyPnl({client,now:()=>t,every:3600000});
 d.start();d.start();await new Promise(r=>setTimeout(r,20));d.stop();
 assert.deepEqual(d.status().byDay,{'2026-11-17':-3.2},'fees in, transfers out');
 assert.ok(seen.every(q=>q.startTime>=K('2026-10-01T00:00:00')));
 const bad=createDailyPnl({client:null,now:()=>t});await bad.refresh();assert.equal(bad.status().error,'NO_CLIENT');
});

test('calendar shows one month at a time and its curve uses only that month',async()=>{
 const m=await import('../public/live_control.js');
 const now=K('2026-12-02T08:30:00'),resetAt=K('2026-11-19T11:43:24');
 const daily={at:now,since:resetAt,resetAt,availableSince:resetAt,
  byDay:{'2026-11-18':777,'2026-11-19':2,'2026-11-30':-1,'2026-12-01':-.45,'2026-12-02':3.2,'2026-12-03':888}};
 const weeks=m.calendarWeeks(daily.byDay,'2026-11');
 assert.equal(weeks[0].slice(0,6).every(c=>c===null),true);
 assert.equal(weeks.flat().filter(Boolean).length,30);
 assert.equal(weeks.flat().filter(Boolean)[0].date,'2026-11-01');
 assert.equal(m.calendarWeeks({},'2027-02').length,4);
 assert.equal(m.kstDate(Date.parse('2026-11-17T15:30:00Z')),'2026-11-18');
 try{
  m.setCalMonth(null);
  let html=m.pnlCalendarHTML(daily,{now});
  assert.match(html,/2026년 12월/);
  assert.match(html,/12월 누적 PNL<\/span><strong class="paper-profit">\+\$2\.75<\/strong>/);
  assert.match(html,/title="2026-12-31"/);
  assert.match(html,/data-cal-month="1" aria-label="다음 달" disabled/);
  assert.equal((html.match(/class="cal-chart-point"/g)||[]).length,2);
  assert.doesNotMatch(html,/888\.00|2026-11-30/);
  m.setCalMonth('2026-11');html=m.pnlCalendarHTML(daily,{now});
  assert.match(html,/2026년 11월/);assert.match(html,/11월 누적 PNL<\/span><strong class="paper-profit">\+\$1\.00<\/strong>/);
  assert.match(html,/2026-11-18 · 초기화 이전/);assert.doesNotMatch(html,/777\.00|2026-12-01/);
  assert.match(html,/집계 시작 2026-11-19 11:43 KST/);
  assert.match(html,/data-cal-month="-1" aria-label="이전 달" disabled/);
  assert.equal((html.match(/class="cal-chart-point"/g)||[]).length,12);
  assert.match(html,/class="cal-chart-line" d="M [^"]+ C /);
  m.setCalMonth('2026-10');assert.match(m.pnlCalendarHTML(daily,{now}),/2026년 11월/);
 }finally{m.setCalMonth(null)}
});

test('calendar keeps the available curve on a partial read and escapes venue error text',async()=>{
 const m=await import('../public/live_control.js');
 const now=K('2026-11-18T08:30:00'),since=K('2026-11-17T00:00:00');
 const html=m.pnlCalendarHTML({at:now-60000,since,byDay:{'2026-10-31':9,'2026-11-17':-3.2},error:'<script>x</script>'},{now});
 assert.match(html,/조회된 기간 2026-11-17 ~ 2026-11-18/);
 assert.match(html,/조회된 기간 누적 PNL/);
 assert.equal((html.match(/class="cal-chart-point"/g)||[]).length,2);
 assert.doesNotMatch(html,/<script>|\+\$9\.00/);
 assert.match(html,/&lt;script&gt;/);assert.match(html,/−\$3\.20/);
 assert.match(m.pnlCalendarHTML({at:null,byDay:{},error:'HTTP_429'},{now}),/갱신 실패 · 불러온 기록 없음 · 거래소 요청 한도 초과/);
 assert.match(m.pnlCalendarHTML({at:null,byDay:{}},{now}),/불러오는 중/);
 const large=m.pnlCalendarHTML({at:now,byDay:{'2026-11-02':1234.5,'2026-11-03':-25000,'2026-11-04':'<i>x</i>'}},{now});
 assert.doesNotMatch(large,/<i>x/);assert.match(large,/\+\$1\.2k/);assert.match(large,/−\$25\.0k/);
 const empty=m.pnlCalendarHTML({at:now,byDay:{}},{now});
 assert.match(empty,/cal-chart-line/);assert.doesNotMatch(empty,/NaN/);
 assert.equal(m.pnlCalendarHTML(null),'');
});

test('calendar and curve appear on the real-account copy page',async()=>{
 const m=await import('../public/live_control.js');
 const now=Date.now(),today=m.kstDate(now),base={mode:'LIVE',enabled:true,armed:false,positions:[],closed:[],events:[],funds:{equity:100,available:90,at:now}};
 const daily={at:now,since:now-40*86400000,byDay:{[today]:4.56},error:null};
 const html=m.copyHTML({...base,daily});
 assert.match(html,/<div class="copy-side">[\s\S]*copy-stats[\s\S]*class="pnl-cal"[\s\S]*data-pnl-chart[\s\S]*copy-rules[\s\S]*<\/div><div class="copy-main">/);
 assert.match(html,/\+\$4\.56/);
 assert.match(html,/누적 손익 \(거래소\)<b class="paper-profit"[^>]*>\+\$4\.56/);
 // When a hedge copy leg is unsettled (QUANTITY_MISMATCH) while opposite manual loss (-$355) is confirmed,
 // the headline 누적 손익 still reflects BingX's true exchange total (-$48.15) and notes 1 unsettled record.
 const skewed=m.copyHTML({
  ...base,
  closed:[{symbol:'ETHUSDT',direction:'LONG',openedAt:now-7200000,closedAt:now-3600000,netUSD:null,netSource:'UNKNOWN',settlement:{state:'QUANTITY_MISMATCH',checkedAt:now}}],
  manual:{closed:[{origin:'manual',symbol:'ETHUSDT',direction:'SHORT',openedAt:now-7200000,closedAt:now-3700000,netUSD:-355.15,netSource:'EXCHANGE_FILLS'}]},
  daily:{at:now,since:now-40*86400000,byDay:{'2026-11-20':27.26,'2026-11-21':-65.86,'2026-11-22':-9.55},error:null},
 });
 assert.match(skewed,/누적 손익 \(거래소\)<b class="paper-loss"[^>]*>−\$48\.15/);
 assert.match(skewed,/원장 미확정 1건 제외/);
 assert.doesNotMatch(m.copyHTML({...base,daily:undefined}),/pnl-cal/);
 assert.doesNotMatch(m.copyHTML({...base,mode:'TESTNET',daily}),/pnl-cal/);
});

test('a malformed venue income response keeps the last good calendar value',async()=>{
 let now=K('2026-11-18T10:00:00'),unexpected=false;
 const income={incomeType:'REALIZED_PNL',income:'27.50',time:now-1800000,symbol:'BTC-USDT',tranId:'1'};
 const client={income:async({startTime,endTime})=>unexpected?{unexpected:[]}:income.time>=startTime&&income.time<endTime?[income]:[],
  balance:async()=>({balance:{asset:'USDT',equity:'1000',unrealizedProfit:'0'}})};
 const calendar=createDailyPnl({client,now:()=>now});
 await calendar.refresh();
 const good=calendar.status();
 assert.deepEqual(good.byDay,{'2026-11-18':27.5});
 now+=5*60000;unexpected=true;
 await calendar.refresh();
 assert.deepEqual(calendar.status(),{...good,error:'BAD_INCOME_RESPONSE',errorAt:now});
});

test('BingX success with explicit null on empty windows allows later income; an omitted data field remains an error',async()=>{
 const now=K('2026-11-18T10:00:00');
 const income={incomeType:'REALIZED_PNL',income:'27.50',time:now-3600000,symbol:'BTC-USDT',tranId:'1'};
 let omitData=false,emptyReads=0;
 const client=new BingXTradeClient({apiKey:'fixture',secret:'fixture',mode:'LIVE',now:()=>now,fetcher:async(url,options)=>{
  const u=new URL(url);
  assert.equal(u.pathname,'/openApi/swap/v2/user/income');
  assert.equal(options.method,'GET');
  if(omitData)return Response.json({code:0});
  const from=Number(u.searchParams.get('startTime')),to=Number(u.searchParams.get('endTime'));
  if(income.time>=from&&income.time<to)return Response.json({code:0,data:[income]});
  emptyReads++;
  return Response.json({code:0,data:null});
 }});
 const calendar=createDailyPnl({client,now:()=>now});
 await calendar.refresh();
 assert.ok(emptyReads>0);
 assert.deepEqual(calendar.status().byDay,{'2026-11-18':27.5});
 omitData=true;
 await calendar.refresh();
 assert.deepEqual(calendar.status().byDay,{'2026-11-18':27.5});
 assert.equal(calendar.status().error,'BAD_INCOME_RESPONSE');
});

test('older income errors still show recent KST days and a later full refresh restores history',async()=>{
 let now=K('2026-11-18T10:00:00'),olderAvailable=false,net=27.50;
 const recent=K('2026-11-17T00:00:00'),olderDay='2026-11-02',today='2026-11-18';
 const calendar=createDailyPnl({now:()=>now,read:async(start)=>{
  if(start<recent&&!olderAvailable)throw Object.assign(Error('older income not available'),{code:'HTTP_429'});
  return {byDay:start<recent?{[olderDay]:8,[today]:net}:{[today]:net}};
 }});
 await calendar.refresh();
 assert.deepEqual(calendar.status(),{at:now,since:recent,byDay:{[today]:27.50},error:'HTTP_429',errorAt:now});
 olderAvailable=true;now+=5*60000;
 await calendar.refresh();
 assert.deepEqual(calendar.status().byDay,{[olderDay]:8,[today]:27.50});
 assert.equal(calendar.status().error,null);
 olderAvailable=false;now+=60*60000;net=31;
 await calendar.refresh();
 assert.deepEqual(calendar.status().byDay,{[olderDay]:8,[today]:31},'last good older data stays visible');
 assert.equal(calendar.status().error,'HTTP_429');
});
