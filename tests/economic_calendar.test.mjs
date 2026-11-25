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

test('isHighImpactCryptoEvent matches Investing.com US ★★★ releases and drops China/non-US and 1-2 star US noise',()=>{
 // Kept: Investing.com US ★★★ (S / A / B empirical BTC tiers)
 assert.equal(isHighImpactCryptoEvent({country:'USD',impact:'High',title:'Core PCE Price Index m/m'}),true);
 assert.equal(isHighImpactCryptoEvent({country:'US',currency:'USD',importance:1,title:'Core Inflation Rate MoM'}),true);
 assert.equal(isHighImpactCryptoEvent({country:'US',currency:'USD',importance:1,title:'Interest Rate'}),true);
 assert.equal(isHighImpactCryptoEvent({country:'US',currency:'USD',importance:1,title:'Non Farm Payrolls'}),true);
 assert.equal(isHighImpactCryptoEvent({country:'US',currency:'USD',importance:1,title:'PPI MoM'}),true);
 assert.equal(isHighImpactCryptoEvent({country:'US',currency:'USD',importance:1,title:'ISM Manufacturing PMI'}),true);
 assert.equal(isHighImpactCryptoEvent({country:'US',currency:'USD',importance:1,title:'ISM Services PMI'}),true);
 assert.equal(isHighImpactCryptoEvent({country:'US',currency:'USD',importance:1,title:'JOLTs Job Openings'}),true);
 assert.equal(isHighImpactCryptoEvent({country:'US',currency:'USD',importance:1,title:'Michigan Consumer Sentiment Prel'}),true);
 assert.equal(isHighImpactCryptoEvent({country:'US',currency:'USD',importance:1,title:'GDP Growth Rate QoQ 2nd Est'}),true);
 assert.equal(isHighImpactCryptoEvent({country:'US',currency:'USD',importance:0,title:'Initial Jobless Claims'}),true);
 assert.equal(isHighImpactCryptoEvent({country:'US',currency:'USD',importance:1,title:'Retail Sales MoM'}),true);
 assert.equal(isHighImpactCryptoEvent({country:'US',currency:'USD',importance:0,title:'ADP Employment Change'}),true);
 assert.equal(isHighImpactCryptoEvent({country:'US',currency:'USD',importance:0,title:'CB Consumer Confidence'}),true);
 assert.equal(isHighImpactCryptoEvent({country:'US',currency:'USD',importance:0,title:'S&P Global Manufacturing PMI Flash'}),true);
 assert.equal(isHighImpactCryptoEvent({country:'US',currency:'USD',importance:0,title:'S&P Global Services PMI Flash'}),true);
 assert.equal(isHighImpactCryptoEvent({country:'US',currency:'USD',importance:1,title:'Durable Goods Orders MoM'}),true);
 assert.equal(isHighImpactCryptoEvent({country:'USD',impact:'High',title:'Core Durable Goods Orders m/m'}),true);

 // Dropped: China, EUR, JPY, and Investing.com 1-2 star US noise (Housing, Oil, Auctions, Weekly ADP, PMI Final)
 assert.equal(isHighImpactCryptoEvent({country:'CN',currency:'CNY',importance:1,title:'GDP Growth Rate YoY'}),false);
 assert.equal(isHighImpactCryptoEvent({country:'CNY',impact:'High',title:'CPI y/y'}),false);
 assert.equal(isHighImpactCryptoEvent({country:'EUR',impact:'High',title:'Main Refinancing Rate'}),false);
 assert.equal(isHighImpactCryptoEvent({country:'JPY',impact:'High',title:'BOJ Policy Rate'}),false);
 assert.equal(isHighImpactCryptoEvent({country:'US',currency:'USD',importance:0,title:'ADP Employment Change Weekly'}),false);
 assert.equal(isHighImpactCryptoEvent({country:'US',currency:'USD',importance:1,title:'Housing Starts'}),false);
 assert.equal(isHighImpactCryptoEvent({country:'US',currency:'USD',importance:1,title:'Building Permits'}),false);
 assert.equal(isHighImpactCryptoEvent({country:'US',currency:'USD',importance:1,title:'Existing Home Sales'}),false);
 assert.equal(isHighImpactCryptoEvent({country:'US',currency:'USD',importance:0,title:'EIA Crude Oil Stocks Change'}),false);
 assert.equal(isHighImpactCryptoEvent({country:'US',currency:'USD',importance:-1,title:'S&P Global Manufacturing PMI Final'}),false);
});

test('localizeEconomicEvent attaches Investing.com ★★★ stars and real 24-month empirical BTC backtest S/A/B tiers',()=>{
 assert.ok(ECON_IMPACT_STATS?.families?.CPI?.sampleCount>=12,'24-month empirical stats loaded');
 assert.ok(getHistoricalImpact('FOMC_RATE')?.whipsawRatePct>0);

 const cpi=localizeEconomicEvent({country:'US',currency:'USD',title:'Core Inflation Rate MoM'});
 assert.equal(cpi.familyKey,'CPI');
 assert.equal(cpi.importanceStars,3);
 assert.equal(cpi.starsLabel,'★★★');
 assert.equal(cpi.grade,'S');
 assert.equal(cpi.tier,'CRITICAL');
 assert.equal(cpi.tierLabelKo,'★★★ S초강력');
 assert.ok(cpi.backtest?.avgRange15mPct>0.5);

 const fomc=localizeEconomicEvent({country:'US',currency:'USD',title:'Interest Rate'});
 assert.equal(fomc.familyKey,'FOMC_RATE');
 assert.equal(fomc.tier,'CRITICAL');
 assert.match(fomc.titleKo,/미국 기준금리 결정/);

 const ppi=localizeEconomicEvent({country:'USD',title:'Core PPI m/m'});
 assert.equal(ppi.familyKey,'PPI');
 assert.equal(ppi.grade,'A');
 assert.equal(ppi.tier,'HIGH');
 assert.equal(ppi.tierLabelKo,'★★★ A강력');

 const pce=localizeEconomicEvent({country:'USD',title:'Core PCE Price Index m/m'});
 assert.equal(pce.familyKey,'PCE');
 assert.equal(pce.tier,'HIGH');
 assert.match(pce.titleKo,/근원 PCE/);
 assert.ok(pce.backtest?.maxRange60mPct>1);

 const gdp=localizeEconomicEvent({country:'US',currency:'USD',title:'GDP Growth Rate QoQ 2nd Est'});
 assert.equal(gdp.familyKey,'GDP');
 assert.equal(gdp.importanceStars,3);
 assert.equal(gdp.grade,'B');
 assert.equal(gdp.tier,'WATCH');
 assert.equal(gdp.tierLabelKo,'★★★ B주요');
 assert.ok(gdp.backtest?.sampleCount>=12);

 const adp=localizeEconomicEvent({country:'US',currency:'USD',title:'ADP Employment Change'});
 assert.equal(adp.familyKey,'ADP');
 assert.equal(adp.tier,'WATCH');
 assert.equal(adp.tierLabelKo,'★★★ B주요');
 assert.ok(adp.backtest?.sampleCount>=12);

 const spPmi=localizeEconomicEvent({country:'US',currency:'USD',title:'S&P Global Manufacturing PMI Flash'});
 assert.equal(spPmi.familyKey,'SP_GLOBAL_PMI');
 assert.equal(spPmi.importanceStars,3);
 assert.equal(spPmi.tier,'WATCH');
 assert.equal(spPmi.tierLabelKo,'★★★ B주요');
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

test('parseTradingViewEvents keeps US ★★★ primaries, folds companion sub-indicators, drops China/1-2 star noise, and detects conflict',()=>{
 const events=parseTradingViewEvents({
  result:[
   {id:1,title:'Core PCE Price Index MoM',country:'US',currency:'USD',date:'2026-11-25T11:55:00Z',importance:1,actual:0.3,forecast:0.3,previous:0.3,scale:'',unit:'%'},
   {id:2,title:'Core PCE Price Index YoY',country:'US',currency:'USD',date:'2026-11-25T11:55:00Z',importance:-1,actual:3.3,forecast:3.2,previous:3.2,scale:'',unit:'%'},
   {id:3,title:'GDP Growth Rate QoQ 2nd Est',country:'US',currency:'USD',date:'2026-11-25T11:55:00Z',importance:1,actual:4.3,forecast:3.5,previous:3.4,scale:'',unit:'%'},
   {id:4,title:'GDP Price Index QoQ 2nd Est',country:'US',currency:'USD',date:'2026-11-25T11:55:00Z',importance:0,actual:1.8,forecast:2.3,previous:2.3,scale:'',unit:'%'},
   // US ★★★ Thursday Initial Jobless Claims + Continuing Claims sub-indicator
   {id:5,title:'Initial Jobless Claims',country:'US',currency:'USD',date:'2026-12-03T13:30:00Z',importance:0,actual:null,forecast:200,previous:202,scale:'K',unit:''},
   {id:6,title:'Continuing Jobless Claims',country:'US',currency:'USD',date:'2026-12-03T13:30:00Z',importance:-1,actual:null,forecast:1850,previous:1860,scale:'K',unit:''},
   // US ★★★ Retail Sales + Control Group sub-indicator
   {id:8,title:'Retail Sales MoM',country:'US',currency:'USD',date:'2026-12-04T13:30:00Z',importance:1,actual:null,forecast:0.4,previous:0.3,scale:'',unit:'%'},
   {id:9,title:'Retail Sales Control Group',country:'US',currency:'USD',date:'2026-12-04T13:30:00Z',importance:-1,actual:null,forecast:0.3,previous:0.2,scale:'',unit:'%'},
   // China GDP & US Housing -> dropped completely
   {id:7,title:'GDP Growth Rate YoY',country:'CN',currency:'CNY',date:'2026-11-25T11:55:00Z',importance:1,actual:5.0,forecast:4.8,previous:4.7,scale:'',unit:'%'},
   {id:10,title:'Existing Home Sales',country:'US',currency:'USD',date:'2026-12-05T15:00:00Z',importance:1,actual:null,forecast:4.0,previous:3.9,scale:'M',unit:''},
  ],
 });
 assert.equal(events.length,4,'PCE, GDP, Initial Jobless Claims, Retail Sales kept; China & Housing dropped');
 const pce=events.find(e=>e.familyKey==='PCE');
 const gdp=events.find(e=>e.familyKey==='GDP');
 const claims=events.find(e=>e.familyKey==='JOBLESS_CLAIMS');
 const retail=events.find(e=>e.familyKey==='RETAIL_SALES');
 assert.equal(pce.importanceStars,3);
 assert.equal(pce.subEvents.length,1,'Core PCE YoY attaches to PCE');
 assert.equal(gdp.subEvents.length,1,'GDP Price Index attaches to GDP');
 assert.equal(claims.subEvents.length,1,'Continuing Jobless Claims attaches to Initial Jobless Claims');
 assert.equal(retail.subEvents.length,1,'Retail Sales Control Group attaches to Retail Sales');
 assert.ok(pce.conflict?.detected,'detects opposite-impact conflict between Core PCE YoY hot vs GDP Price Index cool');
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
  {title:'ISM Manufacturing PMI',country:'USD',date:'2026-11-25T13:30:00Z',impact:'High',forecast:'55.0',previous:'54.5'},
  {title:'PPI m/m',country:'USD',date:'2026-11-25T09:00:00Z',impact:'High',forecast:'0.3%',previous:'0.4%'},
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

test('renderEconomicCalendarHTML renders Investing.com ★★★ badges, 2-year BTC backtest metrics, sub-indicators, conflict badge, and escapes XSS',()=>{
 assert.equal(evaluateCryptoImpact({direction:'BELOW',labelKo:'예상 하회'},'INVERSE').tone,'BULLISH');
 const events=parseTradingViewEvents({
  result:[
   {id:201,title:'Inflation Rate YoY',country:'US',currency:'USD',date:'2026-11-25T11:55:00Z',importance:1,actual:3.0,forecast:2.8,previous:2.7,scale:'',unit:'%',period:'Oct'},
   {id:202,title:'Core Inflation Rate MoM',country:'US',currency:'USD',date:'2026-11-25T11:55:00Z',importance:1,actual:0.2,forecast:0.3,previous:0.3,scale:'',unit:'%',period:'Oct'},
   {id:203,title:'ISM Manufacturing PMI',country:'US',currency:'USD',date:'2026-11-25T13:30:00Z',importance:1,actual:null,forecast:55.0,previous:54.5,scale:'',unit:''},
   {id:204,title:'Durable Goods Orders MoM',country:'US',currency:'USD',date:'2026-11-26T13:30:00Z',importance:1,actual:null,forecast:0.5,previous:-0.4,scale:'',unit:'%'},
   {id:205,title:'Durable Goods Orders Ex Transp MoM',country:'US',currency:'USD',date:'2026-11-26T13:30:00Z',importance:0,actual:null,forecast:0.2,previous:0.1,scale:'',unit:'%'},
   {id:206,title:'S&P Global Manufacturing PMI Flash',country:'US',currency:'USD',date:'2026-11-27T14:45:00Z',importance:0,actual:null,forecast:51.0,previous:50.8,scale:'',unit:''},
   {id:207,title:'S&P Global Services PMI Flash',country:'US',currency:'USD',date:'2026-11-27T14:45:00Z',importance:0,actual:null,forecast:53.0,previous:52.9,scale:'',unit:''},
   {id:208,title:'S&P Global Composite PMI Flash',country:'US',currency:'USD',date:'2026-11-27T14:45:00Z',importance:0,actual:null,forecast:52.5,previous:52.4,scale:'',unit:''},
  ],
 });
 const spPmi=events.find(e=>e.familyKey==='SP_GLOBAL_PMI');
 assert.equal(spPmi.subEvents.length,2,'S&P Global Services & Composite Flash fold under Manufacturing Flash');
 const durable=events.find(e=>e.familyKey==='DURABLE_GOODS');
 assert.equal(durable.subEvents.length,1,'Durable Goods Ex Transp attaches under Durable Goods MoM');

 const report=buildEconomicCalendarReport({
  events,
  now:NOW,
  updatedAt:NOW,
  error:'<img src=x onerror=alert(1)>',
 });
 const html=renderEconomicCalendarHTML(report);
 assert.match(html,/econ-badge conflict/);
 assert.match(html,/지표 엇갈림 · 반전 주의/);
 assert.match(html,/Investing\.com 미국 중요도 ★★★/);
 assert.match(html,/★★★ S초강력/);
 assert.match(html,/★★★ A강력/);
 assert.match(html,/★★★ B주요/);
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
