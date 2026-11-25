import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
 isHighImpactCryptoEvent,
 localizeEconomicEvent,
 formatTvValue,
 computeEventSurprise,
 formatKstEventTime,
 formatCountdownKo,
 parseEconomicEvents,
 parseTradingViewEvents,
 isReleaseWatchWindow,
 findNewlyReleasedEvents,
 buildEconomicCalendarReport,
 fetchEconomicCalendar,
} from '../economic_calendar.mjs';
import {renderEconomicCalendarHTML,formatClientCountdown} from '../public/econ_calendar_ui.js';

const NOW=Date.parse('2026-11-25T12:00:00Z'); // 2026-11-25 21:00 KST

test('isHighImpactCryptoEvent keeps USD High and major central bank High releases (TradingView & ForexFactory)',()=>{
 assert.equal(isHighImpactCryptoEvent({country:'USD',impact:'High',title:'Core PCE Price Index m/m'}),true);
 assert.equal(isHighImpactCryptoEvent({country:'US',currency:'USD',importance:1,title:'Core Inflation Rate MoM'}),true);
 assert.equal(isHighImpactCryptoEvent({country:'US',currency:'USD',importance:0,title:'Crude Oil Inventories'}),false);
 assert.equal(isHighImpactCryptoEvent({country:'JPY',impact:'High',title:'BOJ Policy Rate'}),true);
 assert.equal(isHighImpactCryptoEvent({country:'EU',currency:'EUR',importance:1,title:'ECB Interest Rate Decision'}),true);
 assert.equal(isHighImpactCryptoEvent({country:'NZD',impact:'High',title:'Official Cash Rate'}),false);
 assert.equal(isHighImpactCryptoEvent({country:'GBP',impact:'High',title:'Rightmove HPI m/m'}),false);
});

test('localizeEconomicEvent maps FOMC/CPI/PCE/NFP/BOJ (TV & FF names) to CRITICAL Korean labels',()=>{
 const pce=localizeEconomicEvent({country:'USD',title:'Core PCE Price Index m/m'});
 assert.equal(pce.tier,'CRITICAL');
 assert.equal(pce.tierLabelKo,'초강력');
 assert.match(pce.titleKo,/근원 PCE/);

 const tvFed=localizeEconomicEvent({country:'US',currency:'USD',title:'Fed Interest Rate Decision'});
 assert.equal(tvFed.tier,'CRITICAL');
 assert.match(tvFed.titleKo,/미국 기준금리 결정/);

 const tvCpi=localizeEconomicEvent({country:'US',currency:'USD',title:'Core Inflation Rate YoY'});
 assert.equal(tvCpi.tier,'CRITICAL');
 assert.match(tvCpi.titleKo,/근원 CPI/);

 const boj=localizeEconomicEvent({country:'JPY',title:'BOJ Policy Rate'});
 assert.equal(boj.tier,'CRITICAL');
 assert.match(boj.titleKo,/일본은행/);

 const ppi=localizeEconomicEvent({country:'USD',title:'Core PPI m/m'});
 assert.equal(ppi.tier,'HIGH');
 assert.equal(ppi.tierLabelKo,'강력');
 assert.match(ppi.titleKo,/근원 생산자물가/);
});

test('formatTvValue and computeEventSurprise format units and surprise directions accurately',()=>{
 assert.equal(formatTvValue(0.3,'','%'),'0.3%');
 assert.equal(formatTvValue(220,'K',''),'220K');
 assert.equal(formatTvValue(-1.5,'B','$'),'-$1.5B');
 assert.equal(formatTvValue(null,'','%'),'');

 assert.deepEqual(computeEventSurprise('0.4%','0.3%'),{direction:'ABOVE',labelKo:'예상 상회',deltaText:'+0.1%p'});
 assert.deepEqual(computeEventSurprise('0.2%','0.3%'),{direction:'BELOW',labelKo:'예상 하회',deltaText:'-0.1%p'});
 assert.deepEqual(computeEventSurprise('0.3%','0.3%'),{direction:'INLINE',labelKo:'예상 부합',deltaText:'0'});
 assert.deepEqual(computeEventSurprise('235K','220K'),{direction:'ABOVE',labelKo:'예상 상회',deltaText:'+15K'});
});

test('formatKstEventTime, formatCountdownKo, and formatClientCountdown produce live HH:MM:SS precision',()=>{
 const kst=formatKstEventTime(Date.parse('2026-11-25T13:30:00Z')); // 22:30 KST
 assert.equal(kst.dateKey,'2026-11-25');
 assert.equal(kst.timeLabel,'22:30');
 assert.match(kst.fullLabel,/11\/25\(수\) 22:30 KST/);

 assert.equal(formatCountdownKo(NOW+45*60000,NOW),'45분 후');
 assert.equal(formatCountdownKo(NOW+14*60000+32000,NOW,{precise:true}),'T-14:32');
 assert.equal(formatCountdownKo(NOW+3*3600000+20*60000+5000,NOW,{precise:true}),'T-03:20:05');
 assert.equal(formatCountdownKo(NOW-5*60000,NOW,{expectsActual:true}),'발표 직후 · 결과 수집 중');
 assert.equal(formatCountdownKo(NOW-5*60000,NOW,{hasActual:true}),'발표 완료');

 assert.equal(formatClientCountdown(NOW+14*60000+32000,NOW),'T-14:32');
 assert.equal(formatClientCountdown(NOW+2*3600000+5000,NOW),'T-02:00:05');
 assert.equal(formatClientCountdown(NOW-2*60000,NOW,{hasActual:false,expectsActual:true}),'발표 완료 · 결과 수집 중');
 assert.equal(formatClientCountdown(NOW-2*60000,NOW,{hasActual:true}),'발표 완료');
});

test('parseTradingViewEvents, isReleaseWatchWindow, findNewlyReleasedEvents, and justReleased work together',()=>{
 const before=parseTradingViewEvents({
  result:[
   {id:101,title:'Core PCE Price Index MoM',country:'US',currency:'USD',date:'2026-11-25T12:00:10.000Z',importance:1,actual:null,forecast:0.3,previous:0.2,scale:'',unit:'%'},
   {id:102,title:'Fed Powell Speech',country:'US',currency:'USD',date:'2026-11-25T12:00:10.000Z',importance:1,actual:null,forecast:null,previous:null,scale:'',unit:''},
  ],
 });
 assert.equal(before.length,2);
 assert.equal(before[0].actual,'');
 assert.equal(before[0].forecast,'0.3%');
 assert.equal(before[0].expectsActual,true);
 assert.equal(before[1].expectsActual,false,'speeches do not trigger numeric actual polling');
 assert.equal(isReleaseWatchWindow(before,NOW),true,'10s before PCE triggers release watch');
 assert.equal(isReleaseWatchWindow([before[1]],NOW),false,'speech-only does not trigger release watch');

 const after=parseTradingViewEvents({
  result:[
   {id:101,title:'Core PCE Price Index MoM',country:'US',currency:'USD',date:'2026-11-25T12:00:10.000Z',importance:1,actual:0.4,forecast:0.3,previous:0.2,scale:'',unit:'%'},
   {id:102,title:'Fed Powell Speech',country:'US',currency:'USD',date:'2026-11-25T12:00:10.000Z',importance:1,actual:null,forecast:null,previous:null,scale:'',unit:''},
  ],
 });
 const newly=findNewlyReleasedEvents(before,after);
 assert.equal(newly.length,1);
 assert.equal(newly[0].actual,'0.4%');
 assert.equal(newly[0].surprise.direction,'ABOVE');
 assert.equal(isReleaseWatchWindow(after,NOW+30000),false,'stops fast polling once actual arrived');

 const report=buildEconomicCalendarReport({events:after,now:NOW+60000,updatedAt:NOW+60000});
 assert.equal(report.justReleased.length,1);
 assert.equal(report.justReleased[0].actual,'0.4%');
 assert.equal(report.upcoming.some(e=>e.id==='tv:101'),false,'released event moves out of upcoming');
});

test('parseEconomicEvents deduplicates across weeks and buildEconomicCalendarReport splits upcoming vs recent',()=>{
 const rawThis=[
  {title:'Core PCE Price Index m/m',country:'USD',date:'2026-11-25T13:30:00Z',impact:'High',forecast:'0.3%',previous:'0.2%'},
  {title:'Unemployment Claims',country:'USD',date:'2026-11-25T13:30:00Z',impact:'High',forecast:'220K',previous:'218K'},
  {title:'CB Consumer Confidence',country:'USD',date:'2026-11-25T09:00:00Z',impact:'High',forecast:'101.0',previous:'99.5'},
  {title:'Natural Gas Storage',country:'USD',date:'2026-11-25T15:30:00Z',impact:'Low',forecast:'-2B',previous:'-1B'},
 ];
 const rawNext=[
  {title:'Core PCE Price Index m/m',country:'USD',date:'2026-11-25T13:30:00Z',impact:'High',forecast:'0.3%',previous:'0.2%'},
  {title:'Non-Farm Employment Change',country:'USD',date:'2026-12-04T13:30:00Z',impact:'High',forecast:'180K',previous:'165K'},
 ];
 const parsed=parseEconomicEvents([rawThis,rawNext]);
 assert.equal(parsed.length,4);

 const report=buildEconomicCalendarReport({events:parsed,now:NOW,updatedAt:NOW});
 assert.equal(report.ok,true);
 assert.equal(report.upcomingCount,3);
 assert.equal(report.recent.length,1);
 assert.equal(report.imminentCount,2,'both 22:30 KST events are within 2 hours');
 assert.equal(report.criticalCount,2,'Core PCE and NFP are CRITICAL');
 assert.equal(report.nextEvent.title,'Core PCE Price Index m/m','CRITICAL event wins tie at same timestamp');
 assert.equal(report.nextEvent.isImminent,true);
});

test('fetchEconomicCalendar uses TradingView primary with Origin header and falls back to ForexFactory on error',async()=>{
 let seenOrigin='';
 const tvEvents=await fetchEconomicCalendar({
  now:NOW,
  fetcher:async(url,opts)=>{
   if(url.includes('tradingview.com')){
    seenOrigin=opts?.headers?.Origin||'';
    return {
     ok:true,
     status:200,
     json:async()=>({result:[{id:7,title:'Inflation Rate MoM',country:'US',currency:'USD',date:'2026-11-26T13:30:00Z',importance:1,actual:0.2,forecast:0.3,previous:0.3,scale:'',unit:'%'}]}),
    };
   }
   throw Error('unexpected fallback');
  },
 });
 assert.equal(seenOrigin,'https://www.tradingview.com');
 assert.equal(tvEvents.length,1);
 assert.equal(tvEvents[0].source,'TradingView');
 assert.equal(tvEvents[0].actual,'0.2%');

 // Fallback when TradingView fails
 const ffEvents=await fetchEconomicCalendar({
  now:NOW,
  fetcher:async url=>{
   if(url.includes('tradingview.com'))return {ok:false,status:503};
   if(url.includes('nextweek'))return {ok:false,status:404};
   return {
    ok:true,
    status:200,
    json:async()=>[{title:'CPI m/m',country:'USD',date:'2026-11-26T13:30:00Z',impact:'High',forecast:'0.2%',previous:'0.2%'}],
   };
  },
 });
 assert.equal(ffEvents.length,1);
 assert.equal(ffEvents[0].source,'ForexFactory');
});

test('renderEconomicCalendarHTML renders live countdown attrs, just-released actual results, and escapes XSS',()=>{
 const loading=renderEconomicCalendarHTML(null);
 assert.match(loading,/주요 경제지표/);

 const events=parseTradingViewEvents({
  result:[
   {id:1,title:'Core PCE Price Index MoM',country:'US',currency:'USD',date:'2026-11-25T11:55:00Z',importance:1,actual:0.4,forecast:0.3,previous:0.2,scale:'',unit:'%'},
   {id:2,title:'Initial Jobless Claims',country:'US',currency:'USD',date:'2026-11-25T13:30:00Z',importance:1,actual:null,forecast:220,previous:218,scale:'K',unit:''},
  ],
 });
 const report=buildEconomicCalendarReport({
  events,
  now:NOW,
  updatedAt:NOW,
  error:'<img src=x onerror=alert(1)>',
 });
 const html=renderEconomicCalendarHTML(report);
 assert.match(html,/econ-badge released/);
 assert.match(html,/지표 발표 결과/);
 assert.match(html,/실제 <b>0\.4%<\/b>/);
 assert.match(html,/예상 상회 \+0\.1%p/);
 assert.match(html,/data-econ-cd="1"/);
 assert.match(html,/T-01:30:00/);
 assert.match(html,/data-econ-refresh="1"/);
 assert.doesNotMatch(html,/<img /);
 assert.match(html,/&lt;img src=x onerror=alert\(1\)&gt;/);
});

test('server.mjs, public/app.js, public/index.html, public/styles.css, and updater.mjs wire live economic calendar cleanly',()=>{
 const root=path.resolve(import.meta.dirname,'..');
 const serverSrc=fs.readFileSync(path.join(root,'server.mjs'),'utf8');
 const appSrc=fs.readFileSync(path.join(root,'public/app.js'),'utf8');
 const htmlSrc=fs.readFileSync(path.join(root,'public/index.html'),'utf8');
 const cssSrc=fs.readFileSync(path.join(root,'public/styles.css'),'utf8');
 const updaterSrc=fs.readFileSync(path.join(root,'updater.mjs'),'utf8');

 assert.match(serverSrc,/from '\.\/economic_calendar\.mjs'/);
 assert.match(serverSrc,/pathname==='\/api\/economic-calendar'&&req\.method==='GET'/);
 assert.match(serverSrc,/isReleaseWatchWindow/);
 assert.match(serverSrc,/send\('economic-calendar'/);
 assert.match(appSrc,/es\.addEventListener\('economic-calendar'/);
 assert.match(htmlSrc,/id="econCalendarBar"/);
 assert.match(htmlSrc,/src="\/econ_calendar_ui\.js"/);
 assert.match(cssSrc,/\.econ-bar\{/);
 assert.match(cssSrc,/\.econ-actual\{/);
 assert.match(cssSrc,/\.econ-surprise\.above\{/);
 assert.match(updaterSrc,/'economic_calendar\.mjs'/);
});
