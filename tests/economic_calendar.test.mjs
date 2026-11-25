import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
 ECON_IMPACT_STATS,
 getHistoricalImpact,
 isHighImpactCryptoEvent,
 localizeEconomicEvent,
 evaluateCryptoImpact,
 formatTvValue,
 computeEventSurprise,
 formatKstEventTime,
 formatCountdownKo,
 parseEconomicEvents,
 parseTradingViewEvents,
 analyzeReleaseConflicts,
 isReleaseWatchWindow,
 findNewlyReleasedEvents,
 buildEconomicCalendarReport,
 fetchEconomicCalendar,
} from '../economic_calendar.mjs';
import {renderEconomicCalendarHTML,formatClientCountdown} from '../public/econ_calendar_ui.js';

const NOW=Date.parse('2026-11-25T12:00:00Z'); // 2026-11-25 21:00 KST

test('isHighImpactCryptoEvent focuses strictly on US core BTC indicators and excludes China/non-US and housing/ADP noise',()=>{
 // Included US core indicators (including Initial Jobless Claims even when TradingView sets importance=0, and Interest Rate)
 assert.equal(isHighImpactCryptoEvent({country:'USD',impact:'High',title:'Core PCE Price Index m/m'}),true);
 assert.equal(isHighImpactCryptoEvent({country:'US',currency:'USD',importance:1,title:'Core Inflation Rate MoM'}),true);
 assert.equal(isHighImpactCryptoEvent({country:'US',currency:'USD',importance:0,title:'Initial Jobless Claims'}),true);
 assert.equal(isHighImpactCryptoEvent({country:'US',currency:'USD',importance:1,title:'Interest Rate'}),true);
 assert.equal(isHighImpactCryptoEvent({country:'US',currency:'USD',importance:1,title:'GDP Growth Rate QoQ 2nd Est'}),true);

 // Excluded: China, non-US countries, US housing/ADP/oil noise
 assert.equal(isHighImpactCryptoEvent({country:'CN',currency:'CNY',importance:1,title:'GDP Growth Rate YoY'}),false);
 assert.equal(isHighImpactCryptoEvent({country:'CNY',impact:'High',title:'CPI y/y'}),false);
 assert.equal(isHighImpactCryptoEvent({country:'EUR',impact:'High',title:'Main Refinancing Rate'}),false);
 assert.equal(isHighImpactCryptoEvent({country:'JPY',impact:'High',title:'BOJ Policy Rate'}),false);
 assert.equal(isHighImpactCryptoEvent({country:'US',currency:'USD',importance:1,title:'Housing Starts'}),false);
 assert.equal(isHighImpactCryptoEvent({country:'US',currency:'USD',importance:1,title:'Existing Home Sales'}),false);
 assert.equal(isHighImpactCryptoEvent({country:'US',currency:'USD',importance:0,title:'ADP Employment Change'}),false);
 assert.equal(isHighImpactCryptoEvent({country:'US',currency:'USD',importance:0,title:'Crude Oil Inventories'}),false);
});

test('localizeEconomicEvent attaches real 24-month empirical BTC backtest stats and data-driven S/A/B tiers',()=>{
 assert.ok(ECON_IMPACT_STATS?.families?.CPI?.sampleCount>=12,'24-month empirical stats loaded');
 assert.ok(getHistoricalImpact('FOMC_RATE')?.whipsawRatePct>0);

 const cpi=localizeEconomicEvent({country:'US',currency:'USD',title:'Core Inflation Rate MoM'});
 assert.equal(cpi.familyKey,'CPI');
 assert.equal(cpi.grade,'S');
 assert.equal(cpi.tier,'CRITICAL');
 assert.equal(cpi.tierLabelKo,'S 초강력');
 assert.ok(cpi.backtest?.avgRange15mPct>0.5);

 const fomc=localizeEconomicEvent({country:'US',currency:'USD',title:'Interest Rate'});
 assert.equal(fomc.familyKey,'FOMC_RATE');
 assert.equal(fomc.tier,'CRITICAL');
 assert.match(fomc.titleKo,/미국 기준금리 결정/);

 const ppi=localizeEconomicEvent({country:'USD',title:'Core PPI m/m'});
 assert.equal(ppi.familyKey,'PPI');
 assert.equal(ppi.grade,'A');
 assert.equal(ppi.tier,'HIGH');
 assert.equal(ppi.tierLabelKo,'A 강력');

 const pce=localizeEconomicEvent({country:'USD',title:'Core PCE Price Index m/m'});
 assert.equal(pce.familyKey,'PCE');
 assert.equal(pce.tier,'WATCH');
 assert.match(pce.titleKo,/근원 PCE/);
 assert.ok(pce.backtest?.maxRange60mPct>1);
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

test('parseTradingViewEvents folds same-family siblings & imp=-1 sub-indicators and detects release conflicts',()=>{
 // Real-world 22:30 KST bundle: Core PCE MoM (imp=1) + Core PCE YoY (imp=-1) + GDP 2nd Est (imp=1) + GDP Price Index (imp=0) + Initial Claims (imp=0) + Continuing Claims (imp=-1)
 const events=parseTradingViewEvents({
  result:[
   {id:1,title:'Core PCE Price Index MoM',country:'US',currency:'USD',date:'2026-11-25T11:55:00Z',importance:1,actual:0.3,forecast:0.3,previous:0.3,scale:'',unit:'%'},
   {id:2,title:'Core PCE Price Index YoY',country:'US',currency:'USD',date:'2026-11-25T11:55:00Z',importance:-1,actual:3.3,forecast:3.2,previous:3.2,scale:'',unit:'%'},
   {id:3,title:'GDP Growth Rate QoQ 2nd Est',country:'US',currency:'USD',date:'2026-11-25T11:55:00Z',importance:1,actual:4.3,forecast:3.5,previous:3.4,scale:'',unit:'%'},
   {id:4,title:'GDP Price Index QoQ 2nd Est',country:'US',currency:'USD',date:'2026-11-25T11:55:00Z',importance:0,actual:1.8,forecast:2.3,previous:2.3,scale:'',unit:'%'},
   {id:5,title:'Initial Jobless Claims',country:'US',currency:'USD',date:'2026-11-25T11:55:00Z',importance:0,actual:189,forecast:200,previous:202,scale:'K',unit:''},
   {id:6,title:'Continuing Jobless Claims',country:'US',currency:'USD',date:'2026-11-25T11:55:00Z',importance:-1,actual:1697,forecast:1721,previous:1710,scale:'K',unit:''},
   // China event should be ignored completely
   {id:7,title:'GDP Growth Rate YoY',country:'CN',currency:'CNY',date:'2026-11-25T11:55:00Z',importance:1,actual:5.0,forecast:4.8,previous:4.7,scale:'',unit:'%'},
  ],
 });
 assert.equal(events.length,3,'3 US primary families: PCE, GDP, JOBLESS_CLAIMS (China dropped)');
 const pce=events.find(e=>e.familyKey==='PCE');
 const gdp=events.find(e=>e.familyKey==='GDP');
 const claims=events.find(e=>e.familyKey==='JOBLESS_CLAIMS');
 assert.ok(pce&&gdp&&claims);
 assert.equal(pce.subEvents.length,1,'Core PCE YoY (imp=-1) attached to PCE');
 assert.equal(gdp.subEvents.length,1,'GDP Price Index (imp=0) attached to GDP');
 assert.equal(claims.subEvents.length,1,'Continuing Jobless Claims (imp=-1) attached to Initial Claims');
 // Core PCE YoY hot (BEARISH) vs GDP Price Index cool (BULLISH) -> automatic reversal conflict detected!
 assert.ok(pce.conflict?.detected,'detects opposite-impact conflict across simultaneous US prints');
 assert.equal(pce.conflict.kind,'OPPOSITE_IMPACT');
 assert.equal(analyzeReleaseConflicts(events).length,1);
});

test('isReleaseWatchWindow and findNewlyReleasedEvents track imminent release actuals accurately',()=>{
 const before=parseTradingViewEvents({
  result:[
   {id:101,title:'Core PCE Price Index MoM',country:'US',currency:'USD',date:'2026-11-25T12:00:10.000Z',importance:1,actual:null,forecast:0.3,previous:0.2,scale:'',unit:'%'},
   {id:102,title:'Fed Powell Speech',country:'US',currency:'USD',date:'2026-11-25T12:00:10.000Z',importance:1,actual:null,forecast:null,previous:null,scale:'',unit:''},
  ],
 });
 assert.equal(isReleaseWatchWindow(before,NOW),true,'10s before PCE triggers release watch');
 assert.equal(isReleaseWatchWindow([before.find(e=>e.id==='tv:102')],NOW),false,'speech-only does not trigger release watch');

 const after=parseTradingViewEvents({
  result:[
   {id:101,title:'Core PCE Price Index MoM',country:'US',currency:'USD',date:'2026-11-25T12:00:10.000Z',importance:1,actual:0.4,forecast:0.3,previous:0.2,scale:'',unit:'%'},
  ],
 });
 const newly=findNewlyReleasedEvents(before,after);
 assert.equal(newly.length,1);
 assert.equal(newly[0].actual,'0.4%');
 assert.equal(isReleaseWatchWindow(after,NOW+30000),false,'stops fast polling once actual arrived');
});

test('parseEconomicEvents deduplicates across weeks and buildEconomicCalendarReport splits upcoming vs recent',()=>{
 const rawThis=[
  {title:'Core CPI m/m',country:'USD',date:'2026-11-25T13:30:00Z',impact:'High',forecast:'0.3%',previous:'0.2%'},
  {title:'Unemployment Claims',country:'USD',date:'2026-11-25T13:30:00Z',impact:'High',forecast:'220K',previous:'218K'},
  {title:'CB Consumer Confidence',country:'USD',date:'2026-11-25T09:00:00Z',impact:'High',forecast:'101.0',previous:'99.5'},
  {title:'Natural Gas Storage',country:'USD',date:'2026-11-25T15:30:00Z',impact:'Low',forecast:'-2B',previous:'-1B'},
 ];
 const rawNext=[
  {title:'Core CPI m/m',country:'USD',date:'2026-11-25T13:30:00Z',impact:'High',forecast:'0.3%',previous:'0.2%'},
  {title:'Non-Farm Employment Change',country:'USD',date:'2026-12-04T13:30:00Z',impact:'High',forecast:'180K',previous:'165K'},
 ];
 const parsed=parseEconomicEvents([rawThis,rawNext]);
 assert.equal(parsed.length,4);

 const report=buildEconomicCalendarReport({events:parsed,now:NOW,updatedAt:NOW});
 assert.equal(report.ok,true);
 assert.equal(report.upcomingCount,3);
 assert.equal(report.recent.length,1);
 assert.equal(report.imminentCount,2);
 assert.equal(report.criticalCount,2,'Core CPI and NFP are S-grade CRITICAL');
 assert.equal(report.nextEvent.title,'Core CPI m/m','S-grade CRITICAL wins tie at same timestamp');
});

test('fetchEconomicCalendar queries US-only on TradingView and falls back to ForexFactory on error',async()=>{
 let seenUrl='',seenOrigin='';
 const tvEvents=await fetchEconomicCalendar({
  now:NOW,
  fetcher:async(url,opts)=>{
   if(url.includes('tradingview.com')){
    seenUrl=url;
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
 assert.match(seenUrl,/countries=US$/);
 assert.equal(seenOrigin,'https://www.tradingview.com');
 assert.equal(tvEvents.length,1);
 assert.equal(tvEvents[0].source,'TradingView');

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

test('renderEconomicCalendarHTML renders 2-year BTC backtest metrics, sub-indicators, conflict badge, and escapes XSS',()=>{
 assert.equal(evaluateCryptoImpact({direction:'BELOW',labelKo:'예상 하회'},'INVERSE').tone,'BULLISH');
 const events=parseTradingViewEvents({
  result:[
   {id:201,title:'Inflation Rate YoY',country:'US',currency:'USD',date:'2026-11-25T11:55:00Z',importance:1,actual:3.0,forecast:2.8,previous:2.7,scale:'',unit:'%',period:'Oct'},
   {id:202,title:'Core Inflation Rate MoM',country:'US',currency:'USD',date:'2026-11-25T11:55:00Z',importance:1,actual:0.2,forecast:0.3,previous:0.3,scale:'',unit:'%',period:'Oct'},
   {id:203,title:'Initial Jobless Claims',country:'US',currency:'USD',date:'2026-11-25T13:30:00Z',importance:0,actual:null,forecast:200,previous:202,scale:'K',unit:''},
  ],
 });
 const report=buildEconomicCalendarReport({
  events,
  now:NOW,
  updatedAt:NOW,
  error:'<img src=x onerror=alert(1)>',
 });
 const html=renderEconomicCalendarHTML(report);
 assert.match(html,/econ-badge conflict/);
 assert.match(html,/지표 엇갈림 · 반전 주의/);
 assert.match(html,/2년 BTC 실측/);
 assert.match(html,/휩소 반전/);
 assert.match(html,/동시 발표 세부 지표 \(1건\)/);
 assert.match(html,/data-econ-cd="1"/);
 assert.match(html,/T-01:30:00/);
 assert.doesNotMatch(html,/<img /);
 assert.match(html,/&lt;img src=x onerror=alert\(1\)&gt;/);
});

test('server.mjs, public/app.js, public/index.html, public/styles.css, and updater.mjs wire everything cleanly',()=>{
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
 assert.match(cssSrc,/\.econ-bt\{/);
 assert.match(cssSrc,/\.econ-tier\.watch\{/);
 assert.match(updaterSrc,/'econ_impact_stats\.json'/);
 assert.match(updaterSrc,/'scripts\/backtest-econ-impact\.mjs'/);
});
