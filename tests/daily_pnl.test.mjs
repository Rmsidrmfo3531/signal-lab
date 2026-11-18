import test from 'node:test';import assert from 'node:assert/strict';
import {createDailyPnl,dailySince,kstMidnight,kstMonthStart} from '../daily_pnl.mjs';
import {BingXTradeClient} from '../live_clients.mjs';

const DAY=86400000,K=s=>Date.parse(s+'+09:00');

test('daily P&L: since covers the previous and current KST month, never older than the venue keeps',()=>{
 const now=K('2026-11-18T08:30:00'),cfg=K('2026-11-14T00:00:00');
 assert.equal(kstMidnight(now),K('2026-11-18T00:00:00'));
 assert.equal(kstMonthStart(now),K('2026-11-01T00:00:00'));assert.equal(kstMonthStart(now,1),K('2026-10-01T00:00:00'));
 // A UTC instant that is already the next KST day / month.
 assert.equal(kstMonthStart(Date.parse('2026-11-30T16:00:00Z')),K('2026-12-01T00:00:00'));
 assert.equal(dailySince(cfg,now),K('2026-10-01T00:00:00'));
 assert.equal(dailySince(NaN,now),K('2026-10-01T00:00:00'));
 // A configured date older than the retention is clamped to ~85 days back (a KST midnight).
 const old=dailySince(K('2026-01-01T00:00:00'),now);assert.ok(old>now-86*DAY&&old<=now-84*DAY);assert.equal(old,kstMidnight(old));
});

test('daily P&L: background cache, incremental re-read, last good data kept on errors, never throws',async()=>{
 let t=K('2026-11-18T08:30:00');const calls=[];let fail=null;
 const days={'2026-11-15':-0.45,'2026-11-17':-3.2,'2026-11-18':1.23};
 const read=async(since,now)=>{calls.push({since,now});if(fail==='throw')throw Object.assign(Error('boom https://x?signature=SECRET'),{});if(fail)return {error:fail,since};
  return {byDay:Object.fromEntries(Object.entries(days).filter(([d])=>K(d+'T00:00:00')>=since))}};
 const d=createDailyPnl({since:K('2026-11-14T00:00:00'),read,now:()=>t});
 assert.deepEqual(d.status(),{at:null,since:null,byDay:{},error:null,errorAt:null},'nothing before the first read');
 await d.refresh();
 assert.equal(calls[0].since,K('2026-10-01T00:00:00'),'full read from the previous month');
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
 const d=createDailyPnl({client,since:K('2026-11-14T00:00:00'),now:()=>t,every:3600000});
 d.start();d.start();await new Promise(r=>setTimeout(r,20));d.stop();
 assert.deepEqual(d.status().byDay,{'2026-11-17':-3.2},'fees in, transfers out');
 assert.ok(seen.every(q=>q.startTime>=K('2026-10-01T00:00:00')));
 const bad=createDailyPnl({client:null,now:()=>t});await bad.refresh();assert.equal(bad.status().error,'NO_CLIENT');
});

test('calendar UI: weeks from Monday, month boundaries, KST today, totals, prev/next, error, escaping',async()=>{
 const m=await import('../public/live_control.js');
 // November 2026 starts on a Sunday: six empty cells first (월~토), 30 days, five weeks... plus the padding.
 const w=m.calendarWeeks({'2026-11-01':5,'2026-11-30':-2},'2026-11');
 assert.equal(w[0].slice(0,6).every(c=>c===null),true);assert.equal(w[0][6].date,'2026-11-01');assert.equal(w[0][6].value,5);
 assert.equal(w.length,6);assert.equal(w[5][0].date,'2026-11-30');assert.equal(w[5][0].value,-2);assert.equal(w[5].slice(1).every(c=>c===null),true);
 assert.ok(w.every(r=>r.length===7));
 // Monday 2026-06-01: no leading padding; February 2027 (28 days, Monday) is exactly four weeks.
 assert.equal(m.calendarWeeks({},'2026-06')[0][0].day,1);assert.equal(m.calendarWeeks({},'2027-02').length,4);
 // KST: 2026-11-17 15:30 UTC is already 18 Nov in Korea.
 assert.equal(m.kstDate(Date.parse('2026-11-17T15:30:00Z')),'2026-11-18');assert.equal(m.kstDate(Date.parse('2026-11-17T14:59:00Z')),'2026-11-17');
 const byDay={'2026-10-31':9,'2026-11-15':-0.45,'2026-11-16':0,'2026-11-17':-3.2,'2026-11-18':1.23,'2026-12-01':7};
 const s=m.monthSummary(byDay,'2026-11');
 assert.equal(+s.net.toFixed(2),-2.42);assert.equal(s.wins,1);assert.equal(s.losses,2);assert.equal(s.best.date,'2026-11-18');assert.equal(s.worst.date,'2026-11-17');assert.equal(s.maxAbs,3.2);assert.equal(s.days,4);
 assert.equal(m.monthSummary({},'2026-11').best,null);
 const now=Date.parse('2026-11-18T08:30:00+09:00'),since=Date.parse('2026-10-01T00:00:00+09:00');
 m.setCalMonth(null);
 let html=m.pnlCalendarHTML({at:now-60000,since,byDay,error:null},{now});
 assert.match(html,/일별 손익 <small>거래소 기준 · 카피\+수동<\/small>/);assert.match(html,/2026년 11월/);
 assert.match(html,/data-cal-month="1" aria-label="다음 달" disabled/,'next is disabled at the current month');
 assert.doesNotMatch(html,/data-cal-month="-1"[^>]*disabled/);
 assert.match(html,/class="cal-cell cal-today cal-up"[^>]*><b>18<\/b><i class="paper-profit">\+\$1\.23<\/i>/,'today outlined, profit green');
 assert.match(html,/<b>17<\/b><i class="paper-loss">−\$3\.20<\/i>/);
 assert.match(html,/rgba\(241,113,134,0\.55\)/,'the largest day has the strongest tint');
 assert.match(html,/월 합계 <b class="paper-loss">−\$2\.42<\/b>/);assert.match(html,/수익일 <b class="paper-profit">1<\/b> · 손실일 <b class="paper-loss">2<\/b>/);
 assert.match(html,/최고 18일/);assert.match(html,/최저 17일/);
 assert.equal((html.match(/class="cal-cell[^"]*"/g)||[]).length,42,'six weeks of seven');
 assert.equal((html.match(/class="cal-dow/g)||[]).length,7);assert.match(html,/>월<\/span><span class="cal-dow">화/);
 assert.doesNotMatch(html,/\+\$9\.00|\+\$7\.00/,'other months are not counted');
 // Previous month: back to October, next enabled; prev disabled at the first month the server read.
 m.setCalMonth('2026-10');html=m.pnlCalendarHTML({at:now,since,byDay},{now});
 assert.match(html,/2026년 10월/);assert.match(html,/data-cal-month="1" aria-label="다음 달">/);assert.match(html,/data-cal-month="-1" aria-label="이전 달" disabled/);
 assert.match(html,/월 합계 <b class="paper-profit">\+\$9\.00<\/b>/);
 // Older than the data: shown as the first month; future months fall back to the current one.
 m.setCalMonth('2025-01');assert.match(m.pnlCalendarHTML({at:now,since,byDay},{now}),/2026년 10월/);
 m.setCalMonth('2027-03');assert.match(m.pnlCalendarHTML({at:now,since,byDay},{now}),/2026년 11월/);
 m.setCalMonth('bad');assert.equal(m.getCalMonth(),null);
 // Error: last good data with its time; the code only in an escaped title.
 html=m.pnlCalendarHTML({at:now-10*60000,since,byDay,error:'<script>x</script>',errorAt:now},{now});
 assert.match(html,/갱신 실패 · \d{2}:\d{2} 기준/);assert.doesNotMatch(html,/<script>/);assert.match(html,/&lt;script&gt;/);assert.match(html,/−\$3\.20/);
 assert.match(m.pnlCalendarHTML({at:null,byDay:{},error:'HTTP_429'},{now}),/갱신 실패 · 불러온 기록 없음 · 거래소 요청 한도 초과/);
 assert.match(m.pnlCalendarHTML({at:null,byDay:{}},{now}),/불러오는 중/);
 // Keys and values from the server are never put into the page as given.
 html=m.pnlCalendarHTML({at:now,byDay:{'2026-11-05':'<i>x</i>','<img>':3}},{now});assert.doesNotMatch(html,/<img>|<i>x/);
 // Large amounts stay short enough for a cell.
 html=m.pnlCalendarHTML({at:now,byDay:{'2026-11-02':1234.5,'2026-11-03':-25000}},{now});assert.match(html,/\+\$1\.2k/);assert.match(html,/−\$25\.0k/);
 html=m.pnlCalendarHTML({at:now,byDay:{"2026-11-02":25.6,"2026-11-03":-456.7,"2026-11-04":9.996}},{now});assert.match(html,/\+\$25\.6</);assert.match(html,/−\$457</);assert.match(html,/\+\$10\.0</);
 assert.equal(m.pnlCalendarHTML(null),'');
});

test('calendar UI: on the real-account copy page after the stats, not on the testnet copy, prev/next re-render',async()=>{
 const m=await import('../public/live_control.js');m.setCalMonth(null);
 const now=Date.now(),today=m.kstDate(now),base={mode:'LIVE',enabled:true,armed:false,positions:[],closed:[],events:[],funds:{equity:100,available:90,at:now}};
 const html=m.copyHTML({...base,daily:{at:now,since:now-40*86400000,byDay:{[today]:4.56},error:null}});
 assert.match(html,/<div class="copy-side">[\s\S]*copy-stats[\s\S]*class="pnl-cal"[\s\S]*copy-rules[\s\S]*<\/div><div class="copy-main">/);
 assert.match(html,/\+\$4\.56/);
 assert.doesNotMatch(m.copyHTML({...base,daily:undefined}),/pnl-cal/,'old status without daily: no calendar');
 assert.doesNotMatch(m.copyHTML({...base,mode:'TESTNET',daily:{at:now,byDay:{}}}),/pnl-cal/);
 // The click handler's month step (module variable, like the pager).
 m.setCalMonth('2026-10');assert.match(m.copyHTML({...base,daily:{at:now,since:Date.parse('2026-09-01T00:00:00+09:00'),byDay:{}}}),/2026년 10월/);m.setCalMonth(null);
 const src=(await import('node:fs')).readFileSync(new URL('../public/live_control.js',import.meta.url),'utf8');
 assert.match(src,/closest\('\[data-cal-month\]'\)[\s\S]{0,400}box\.innerHTML=copyHTML\(lastCopy\)/);
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
