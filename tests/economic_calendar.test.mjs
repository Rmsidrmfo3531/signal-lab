import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
 isHighImpactCryptoEvent,
 localizeEconomicEvent,
 formatKstEventTime,
 formatCountdownKo,
 parseEconomicEvents,
 buildEconomicCalendarReport,
 fetchEconomicCalendar,
} from '../economic_calendar.mjs';
import {renderEconomicCalendarHTML} from '../public/econ_calendar_ui.js';

const NOW=Date.parse('2026-11-25T12:00:00Z'); // 2026-11-25 21:00 KST

test('isHighImpactCryptoEvent keeps USD High and major central bank High releases while filtering noise',()=>{
 assert.equal(isHighImpactCryptoEvent({country:'USD',impact:'High',title:'Core PCE Price Index m/m'}),true);
 assert.equal(isHighImpactCryptoEvent({country:'USD',impact:'Medium',title:'Crude Oil Inventories'}),false);
 assert.equal(isHighImpactCryptoEvent({country:'JPY',impact:'High',title:'BOJ Policy Rate'}),true);
 assert.equal(isHighImpactCryptoEvent({country:'EUR',impact:'High',title:'Main Refinancing Rate'}),true);
 assert.equal(isHighImpactCryptoEvent({country:'NZD',impact:'High',title:'Official Cash Rate'}),false);
 assert.equal(isHighImpactCryptoEvent({country:'GBP',impact:'High',title:'Rightmove HPI m/m'}),false);
});

test('localizeEconomicEvent maps FOMC/CPI/PCE/NFP/BOJ to CRITICAL Korean labels and others to HIGH',()=>{
 const pce=localizeEconomicEvent({country:'USD',title:'Core PCE Price Index m/m'});
 assert.equal(pce.tier,'CRITICAL');
 assert.equal(pce.tierLabelKo,'초강력');
 assert.match(pce.titleKo,/근원 PCE/);

 const boj=localizeEconomicEvent({country:'JPY',title:'BOJ Policy Rate'});
 assert.equal(boj.tier,'CRITICAL');
 assert.match(boj.titleKo,/일본은행/);

 const ppi=localizeEconomicEvent({country:'USD',title:'Core PPI m/m'});
 assert.equal(ppi.tier,'HIGH');
 assert.equal(ppi.tierLabelKo,'강력');
 assert.match(ppi.titleKo,/근원 생산자물가/);

 const euCpi=localizeEconomicEvent({country:'EUR',title:'CPI y/y'});
 assert.equal(euCpi.tier,'CRITICAL');
 assert.match(euCpi.titleKo,/유로존 소비자물가지수/);
});

test('formatKstEventTime and formatCountdownKo format KST dates and countdowns accurately',()=>{
 const kst=formatKstEventTime(Date.parse('2026-11-25T13:30:00Z')); // 22:30 KST
 assert.equal(kst.dateKey,'2026-11-25');
 assert.equal(kst.timeLabel,'22:30');
 assert.match(kst.fullLabel,/11\/25\(수\) 22:30 KST/);

 assert.equal(formatCountdownKo(NOW+45*60000,NOW),'45분 후');
 assert.equal(formatCountdownKo(NOW+3*3600000+20*60000,NOW),'3시간 20분 후');
 assert.equal(formatCountdownKo(NOW+30*3600000,NOW),'1일 6시간 후');
 assert.equal(formatCountdownKo(NOW-5*60000,NOW),'발표 직후 · 변동성 유의');
 assert.equal(formatCountdownKo(NOW-2*3600000,NOW),'2시간 전 발표');
});

test('parseEconomicEvents deduplicates across weeks and buildEconomicCalendarReport splits upcoming vs recent',()=>{
 const rawThis=[
  {title:'Core PCE Price Index m/m',country:'USD',date:'2026-11-25T13:30:00Z',impact:'High',forecast:'0.3%',previous:'0.2%'},
  {title:'Unemployment Claims',country:'USD',date:'2026-11-25T13:30:00Z',impact:'High',forecast:'220K',previous:'218K'},
  {title:'CB Consumer Confidence',country:'USD',date:'2026-11-25T09:00:00Z',impact:'High',forecast:'101.0',previous:'99.5'},
  {title:'Natural Gas Storage',country:'USD',date:'2026-11-25T15:30:00Z',impact:'Low',forecast:'-2B',previous:'-1B'},
 ];
 const rawNext=[
  // Duplicate of PCE from thisWeek should be deduplicated
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

test('fetchEconomicCalendar tolerates missing nextweek (404) and surfaces HTTP 429 on thisweek',async()=>{
 const fetched=await fetchEconomicCalendar({
  fetcher:async url=>{
   if(url.includes('nextweek'))return {ok:false,status:404};
   return {
    ok:true,
    status:200,
    json:async()=>[{title:'CPI m/m',country:'USD',date:'2026-11-26T13:30:00Z',impact:'High',forecast:'0.2%',previous:'0.2%'}],
   };
  },
 });
 assert.equal(fetched.length,1);
 assert.equal(fetched[0].tier,'CRITICAL');

 await assert.rejects(
  ()=>fetchEconomicCalendar({fetcher:async()=>({ok:false,status:429})}),
  /HTTP 429/
 );
});

test('renderEconomicCalendarHTML renders imminent alerts, schedule rows, and escapes untrusted strings',()=>{
 const loading=renderEconomicCalendarHTML(null);
 assert.match(loading,/주요 경제지표/);

 const events=parseEconomicEvents([
  {title:'Core PCE Price Index m/m',country:'USD',date:'2026-11-25T13:30:00Z',impact:'High',forecast:'0.3%',previous:'0.2%'},
  {title:'CB Consumer Confidence',country:'USD',date:'2026-11-25T09:00:00Z',impact:'High',forecast:'101.0',previous:'99.5'},
 ]);
 const report=buildEconomicCalendarReport({
  events,
  now:NOW,
  updatedAt:NOW,
  error:'<img src=x onerror=alert(1)>',
 });
 const html=renderEconomicCalendarHTML(report);
 assert.match(html,/econ-badge imminent/);
 assert.match(html,/지표 발표 임박/);
 assert.match(html,/미국 근원 PCE 물가지수/);
 assert.match(html,/예상 <b>0\.3%<\/b>/);
 assert.match(html,/최근 24시간 발표 완료/);
 assert.match(html,/data-econ-refresh="1"/);
 assert.doesNotMatch(html,/<img /);
 assert.match(html,/&lt;img src=x onerror=alert\(1\)&gt;/);
});

test('server.mjs, public/index.html, public/styles.css, and updater.mjs wire economic calendar cleanly',()=>{
 const root=path.resolve(import.meta.dirname,'..');
 const serverSrc=fs.readFileSync(path.join(root,'server.mjs'),'utf8');
 const htmlSrc=fs.readFileSync(path.join(root,'public/index.html'),'utf8');
 const cssSrc=fs.readFileSync(path.join(root,'public/styles.css'),'utf8');
 const updaterSrc=fs.readFileSync(path.join(root,'updater.mjs'),'utf8');

 assert.match(serverSrc,/from '\.\/economic_calendar\.mjs'/);
 assert.match(serverSrc,/pathname==='\/api\/economic-calendar'&&req\.method==='GET'/);
 assert.match(serverSrc,/refreshEconomicCalendar/);
 assert.match(htmlSrc,/id="econCalendarBar"/);
 assert.match(htmlSrc,/src="\/econ_calendar_ui\.js"/);
 assert.match(cssSrc,/\.econ-bar\{/);
 assert.match(cssSrc,/\.seg-sol\{/);
 assert.match(cssSrc,/\.seg-usdt\{/);
 assert.match(updaterSrc,/'economic_calendar\.mjs'/);
});
