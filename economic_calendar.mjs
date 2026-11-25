// High-impact macroeconomic indicator calendar for crypto traders (read-only).
// Primary source: TradingView public economic calendar (includes live `actual`, `forecast`, `previous`).
// Fallback source: ForexFactory public weekly JSON feeds (thisweek + nextweek).
// Filters to crypto-moving High-impact events (USD + major central banks),
// tiers CRITICAL vs HIGH, computes live countdowns & surprise vs forecast, and localizes to Korean.

const TV_CALENDAR_URL='https://economic-calendar.tradingview.com/events';
const FF_THIS_WEEK_URL='https://nfs.faireconomy.media/ff_calendar_thisweek.json';
const FF_NEXT_WEEK_URL='https://nfs.faireconomy.media/ff_calendar_nextweek.json';
const KST_MS=9*3600000;
const DAY_KO=['일','월','화','수','목','금','토'];

const COUNTRY_META={
 USD:{flag:'🇺🇸',nameKo:'미국'},
 EUR:{flag:'🇪🇺',nameKo:'유로존'},
 JPY:{flag:'🇯🇵',nameKo:'일본'},
 GBP:{flag:'🇬🇧',nameKo:'영국'},
 CNY:{flag:'🇨🇳',nameKo:'중국'},
};
const ISO2_TO_CCY={US:'USD',EU:'EUR',JP:'JPY',GB:'GBP',CN:'CNY'};

// Ordered rules matching both TradingView and ForexFactory naming conventions.
const EVENT_RULES=[
 {re:/federal funds rate|fed interest rate decision/i,ko:'미국 기준금리 결정 (FOMC)',critical:true,hint:'금리 동결·인하 여부 및 점도표가 BTC 변동성 직결'},
 {re:/fomc economic projections/i,ko:'FOMC 경제전망 · 점도표',critical:true,hint:'향후 금리 인하 횟수 전망 변화 시 급변동'},
 {re:/fomc press conference/i,ko:'FOMC 파월 의장 기자회견',critical:true,hint:'매파·비둘기파 발언 톤에 따라 실시간 급등락'},
 {re:/fomc statement/i,ko:'FOMC 통화정책 성명서',critical:true,hint:'성명서 문구 변화로 향후 금리 경로 선반영'},
 {re:/fomc (?:meeting )?minutes/i,ko:'FOMC 의사록 공개',critical:true,hint:'연준 위원 간 매파·비둘기파 의견 확인'},
 {re:/fed chair .*speaks|powell speak|fed powell speech/i,ko:'연준 의장 연설',critical:true,hint:'금리·유동성 관련 발언 시 단기 급변동 유의'},
 {re:/core pce price index.*y\/?y|core pce price index.*yoy/i,ko:'미국 근원 PCE 물가지수 (전년비)',critical:true,hint:'연준 최선호 물가지표 — 예상 하회 시 위험자산 우호적'},
 {re:/core pce price index/i,ko:'미국 근원 PCE 물가지수 (전월비)',critical:true,hint:'연준 최선호 물가지표 — 예상 하회 시 위험자산 우호적'},
 {re:/\bpce price index.*y\/?y|\bpce price index.*yoy/i,ko:'미국 PCE 물가지수 (전년비)',critical:true,hint:'인플레이션 둔화 여부에 따라 금리 기대감 변동'},
 {re:/\bpce price index/i,ko:'미국 PCE 물가지수',critical:true,hint:'인플레이션 둔화 여부에 따라 금리 기대감 변동'},
 {re:/core (?:cpi|inflation rate).*(?:y\/y|yoy)/i,ko:'근원 CPI 소비자물가 (전년비)',critical:true,hint:'예상 상회 시 금리 부담으로 코인 하방 압력'},
 {re:/core (?:cpi|inflation rate).*(?:m\/m|mom)/i,ko:'근원 CPI 소비자물가 (전월비)',critical:true,hint:'핵심 물가 추세 — 예상 상회 시 매도 변동성 확대'},
 {re:/(?:^|\b)(?:cpi|inflation rate).*(?:y\/y|yoy)/i,ko:'소비자물가지수 CPI (전년비)',critical:true,hint:'대표 인플레이션 지표 — 발표 직후 강한 위아래 휩소 주의'},
 {re:/(?:^|\b)(?:cpi|inflation rate).*(?:m\/m|mom)/i,ko:'소비자물가지수 CPI (전월비)',critical:true,hint:'예상치 대비 ±0.1%p 괴리만으로도 급변동'},
 {re:/non[- ]?farm (?:employment change|payrolls)/i,ko:'미국 비농업 고용 (NFP)',critical:true,hint:'고용 과열·둔화 여부가 금리 인하 속도 좌우'},
 {re:/unemployment rate/i,ko:'실업률',critical:true,hint:'예상 상회 시 경기 침체 우려 vs 금리 인하 기대 충돌'},
 {re:/boj (?:policy|interest) rate/i,ko:'일본은행(BOJ) 기준금리 결정',critical:true,hint:'엔캐리 트레이드 청산·유입으로 BTC 급변동 유발'},
 {re:/boj press conference|boj outlook report/i,ko:'일본은행(BOJ) 기자회견·전망',critical:true,hint:'금리 인상 시사 시 엔화 강세·위험자산 약세 압력'},
 {re:/main refinancing rate|ecb interest rate decision/i,ko:'유럽중앙은행(ECB) 기준금리 결정',critical:true,hint:'글로벌 유동성·달러인덱스(DXY) 방향성에 영향'},
 {re:/ecb press conference/i,ko:'ECB 총재 기자회견',critical:false,hint:'유로화·달러인덱스 변동 통한 간접 영향'},
 {re:/official bank rate|boe interest rate decision/i,ko:'영란은행(BOE) 기준금리 결정',critical:false,hint:'글로벌 금리 흐름 및 달러 강세 여부 참고'},
 {re:/average hourly earnings/i,ko:'미국 시간당 평균임금',critical:false,hint:'임금 인플레이션 압력 확인 지표'},
 {re:/core (?:ppi|producer price)/i,ko:'미국 근원 생산자물가 (Core PPI)',critical:false,hint:'소비자물가(CPI) 선행 지표 — 예상 상회 시 부담'},
 {re:/\bppi\b|producer price/i,ko:'미국 생산자물가지수 (PPI)',critical:false,hint:'도매 물가 추세 확인 — 발표 직후 단기 변동'},
 {re:/(?:initial jobless|unemployment) claims/i,ko:'미국 신규 실업수당 청구건수',critical:false,hint:'매주 목요일 발표 — 고용 둔화 여부 실시간 체크'},
 {re:/adp (?:non[- ]?farm|employment)/i,ko:'미국 ADP 민간고용',critical:false,hint:'비농업 고용(NFP) 선행 지표로 시장 반응'},
 {re:/jolts job openings/i,ko:'미국 JOLTS 구인·이직 보고서',critical:false,hint:'노동시장 과열 완화 여부 확인'},
 {re:/ism manufacturing pmi/i,ko:'미국 ISM 제조업 PMI',critical:false,hint:'50 기준 경기 확장·위축 판단 및 금리 기대 반응'},
 {re:/ism services pmi/i,ko:'미국 ISM 서비스업 PMI',critical:false,hint:'미국 경제 비중이 큰 서비스업 경기 지표'},
 {re:/(?:flash|s&p global) manufacturing pmi/i,ko:'S&P 글로벌 제조업 PMI',critical:false,hint:'경기 선행 지표 — 예상 괴리 시 단기 변동'},
 {re:/(?:flash|s&p global) services pmi/i,ko:'S&P 글로벌 서비스업 PMI',critical:false,hint:'서비스 경기 및 물가 압력 동시 반영'},
 {re:/core retail sales/i,ko:'미국 근원 소매판매',critical:false,hint:'미국 소비 탄력성 지표 — 과열 시 금리 부담'},
 {re:/retail sales/i,ko:'미국 소매판매',critical:false,hint:'소비 경기 확인 — 예상 상회 시 달러 강세 경향'},
 {re:/advance gdp|gdp growth rate.*adv/i,ko:'미국 GDP 성장률 (속보치)',critical:true,hint:'첫 분기 성장률 발표로 경기 침체·과열 판단 핵심'},
 {re:/prelim gdp|gdp growth rate.*2nd|gdp growth rate.*prelim/i,ko:'미국 GDP 성장률 (잠정치)',critical:false,hint:'GDP 수정치 — 큰 폭 조정 시 변동성'},
 {re:/final gdp|gdp growth rate.*final/i,ko:'미국 GDP 성장률 (확정치)',critical:false,hint:'분기 성장률 확정치'},
 {re:/\bgdp\b/i,ko:'GDP 성장률',critical:false,hint:'거시 경기 성장세 확인 지표'},
 {re:/cb consumer confidence/i,ko:'미국 컨퍼런스보드 소비자신뢰지수',critical:false,hint:'소비 심리 변화 확인'},
 {re:/(?:uom|michigan) consumer sentiment/i,ko:'미국 미시간대 소비심리지수',critical:false,hint:'소비심리 및 기대 인플레이션 동시 주목'},
 {re:/(?:uom|michigan).*inflation expectations/i,ko:'미시간대 기대 인플레이션',critical:false,hint:'기대 물가 급등 시 연준 매파 우려 자극'},
 {re:/core durable goods/i,ko:'미국 근원 내구재 수주',critical:false,hint:'기업 설비투자·경기 선행 지표'},
 {re:/durable goods/i,ko:'미국 내구재 수주',critical:false,hint:'제조업 경기 흐름 참고'},
 {re:/jackson hole/i,ko:'잭슨홀 경제심포지엄',critical:true,hint:'연준 의장 기조연설 시 중기 통화정책 방향 전환점'},
 {re:/rate statement|monetary policy|interest rate decision/i,ko:'중앙은행 통화정책 · 금리',critical:false,hint:'글로벌 금리·유동성 기조 확인'},
];

const NON_USD_MAJOR_RE=/rate|policy|press conference|monetary|cpi|inflation|gdp|pmi|payroll|employment/i;
const NO_ACTUAL_TITLE_RE=/speaks|speech|press conference|minutes|statement|symposium|outlook report|testifies|testimony|holiday/i;

export function expectsNumericActual(title){
 return !NO_ACTUAL_TITLE_RE.test(String(title||''));
}

/** Return true if a raw calendar item is a high-impact crypto-relevant release. */
export function isHighImpactCryptoEvent(raw){
 if(!raw||typeof raw!=='object')return false;
 const impact=String(raw.impact||'').trim().toLowerCase();
 if(impact!=='high'&&raw.importance!==1)return false;
 const ccy=String(raw.currency||ISO2_TO_CCY[String(raw.country||'').toUpperCase()]||raw.country||'').trim().toUpperCase();
 if(!COUNTRY_META[ccy])return false;
 if(ccy==='USD')return true;
 return NON_USD_MAJOR_RE.test(String(raw.title||''));
}

/** Localize a single economic event's title, tier, and crypto impact hint into Korean. */
export function localizeEconomicEvent(raw){
 const title=String(raw?.title||'').replace(/\s+/g,' ').trim();
 const ccy=String(raw?.currency||ISO2_TO_CCY[String(raw?.country||'').toUpperCase()]||raw?.country||'').trim().toUpperCase();
 const meta=COUNTRY_META[ccy]||{flag:'🌐',nameKo:ccy};
 for(const rule of EVENT_RULES){
  if(rule.re.test(title)){
   const hasCountry=/미국|일본|유럽|영란|유로존|중국/.test(rule.ko);
   const titleKo=!hasCountry?`${meta.nameKo} ${rule.ko}`:rule.ko;
   return {
    titleKo,
    tier:rule.critical?'CRITICAL':'HIGH',
    tierLabelKo:rule.critical?'초강력':'강력',
    hintKo:rule.hint,
   };
  }
 }
 return {
  titleKo:`${meta.nameKo} ${title}`,
  tier:'HIGH',
  tierLabelKo:'강력',
  hintKo:'주요 고영향 거시지표 — 발표 전후 변동성 확대 유의',
 };
}

/** Format numeric value from TradingView using scale (K/M/B/T) and unit (%/$). */
export function formatTvValue(val,scale='',unit=''){
 if(val==null||val==='')return '';
 if(typeof val==='string'&&!/^-?\d+(?:\.\d+)?$/.test(val.trim()))return val.trim();
 const n=Number(val);
 if(!Number.isFinite(n))return '';
 const sc=String(scale||'').trim();
 const u=String(unit||'').trim();
 const numStr=String(+n.toFixed(4));
 if(u==='$'||u==='€'||u==='£'||u==='¥'){
  return n<0?`-${u}${String(+Math.abs(n).toFixed(4))}${sc}`:`${u}${numStr}${sc}`;
 }
 return `${numStr}${sc}${u}`;
}

function parseNumericFigure(str){
 const s=String(str||'').trim();
 if(!s)return null;
 const m=s.match(/^([+-]?)[^\d.-]*(\d+(?:,\d+)*(?:\.\d+)?)\s*([KMBT]?)\s*(%?)$/i);
 if(!m)return null;
 const sign=m[1]==='-'?-1:1;
 const base=Number(m[2].replace(/,/g,''));
 if(!Number.isFinite(base))return null;
 const scale=String(m[3]||'').toUpperCase();
 const unit=m[4]||'';
 return {value:sign*base,scale,unit};
}

/** Compute actual-vs-forecast surprise direction and formatted Korean diff label. */
export function computeEventSurprise(actual,forecast){
 const a=parseNumericFigure(actual);
 const f=parseNumericFigure(forecast);
 if(!a||!f||a.scale!==f.scale||a.unit!==f.unit)return null;
 const diff=+(a.value-f.value).toFixed(4);
 if(Math.abs(diff)<1e-6){
  return {direction:'INLINE',labelKo:'예상 부합',deltaText:'0'};
 }
 const sign=diff>0?'+':'';
 const suffix=a.unit==='%'?'%p':`${a.scale}${a.unit}`;
 return {
  direction:diff>0?'ABOVE':'BELOW',
  labelKo:diff>0?'예상 상회':'예상 하회',
  deltaText:`${sign}${diff}${suffix}`,
 };
}

/** Format an epoch ms timestamp into KST display labels. */
export function formatKstEventTime(at){
 const d=new Date(Number(at)+KST_MS);
 const mm=String(d.getUTCMonth()+1).padStart(2,'0');
 const dd=String(d.getUTCDate()).padStart(2,'0');
 const dow=DAY_KO[d.getUTCDay()];
 const hh=String(d.getUTCHours()).padStart(2,'0');
 const mi=String(d.getUTCMinutes()).padStart(2,'0');
 return {
  dateKey:`${d.getUTCFullYear()}-${mm}-${dd}`,
  dateLabel:`${mm}/${dd}(${dow})`,
  timeLabel:`${hh}:${mi}`,
  fullLabel:`${mm}/${dd}(${dow}) ${hh}:${mi} KST`,
 };
}

/** Human-readable Korean countdown label (with live HH:MM:SS precision inside 24 hours). */
export function formatCountdownKo(at,now=Date.now(),{hasActual=false,expectsActual=true,precise=false}={}){
 if(hasActual)return '발표 완료';
 const diffMs=Number(at)-Number(now);
 if(diffMs<=0){
  const agoMin=Math.floor(Math.abs(diffMs)/60000);
  if(agoMin<15)return expectsActual?'발표 직후 · 결과 수집 중':'진행 중 · 변동성 유의';
  if(agoMin<60)return `${agoMin}분 전 발표`;
  const agoHr=Math.floor(agoMin/60);
  return `${agoHr}시간 전 발표`;
 }
 if(precise&&diffMs<24*3600000){
  const totalSec=Math.max(0,Math.ceil(diffMs/1000));
  const h=Math.floor(totalSec/3600);
  const m=Math.floor((totalSec%3600)/60);
  const s=totalSec%60;
  const p2=n=>String(n).padStart(2,'0');
  return h>0?`T-${p2(h)}:${p2(m)}:${p2(s)}`:`T-${p2(m)}:${p2(s)}`;
 }
 const mins=Math.ceil(diffMs/60000);
 if(mins<60)return `${mins}분 후`;
 const hrs=Math.floor(mins/60);
 const remMin=mins%60;
 if(hrs<24)return remMin>0?`${hrs}시간 ${remMin}분 후`:`${hrs}시간 후`;
 const days=Math.floor(hrs/24);
 const remHr=hrs%24;
 return remHr>0?`${days}일 ${remHr}시간 후`:`${days}일 후`;
}

function normalizeEventRecord({id='',at,country,title,forecast='',previous='',actual='',source='ForexFactory'}){
 const ccy=String(ISO2_TO_CCY[String(country||'').toUpperCase()]||country||'').trim().toUpperCase();
 const meta=COUNTRY_META[ccy]||{flag:'🌐',nameKo:ccy};
 const cleanTitle=String(title||'').replace(/\s+/g,' ').trim();
 const loc=localizeEconomicEvent({country:ccy,title:cleanTitle});
 const kst=formatKstEventTime(at);
 const cleanActual=String(actual||'').trim();
 const cleanForecast=String(forecast||'').trim();
 const cleanPrevious=String(previous||'').trim();
 const surprise=cleanActual&&cleanForecast?computeEventSurprise(cleanActual,cleanForecast):null;
 return {
  id:String(id||`${ccy}|${cleanTitle.toLowerCase()}|${at}`),
  at,
  date:new Date(at).toISOString(),
  country:ccy,
  flag:meta.flag,
  countryKo:meta.nameKo,
  title:cleanTitle,
  titleKo:loc.titleKo,
  tier:loc.tier,
  tierLabelKo:loc.tierLabelKo,
  hintKo:loc.hintKo,
  expectsActual:expectsNumericActual(cleanTitle),
  forecast:cleanForecast,
  previous:cleanPrevious,
  actual:cleanActual,
  surprise,
  source,
  kstDateKey:kst.dateKey,
  kstDateLabel:kst.dateLabel,
  kstTimeLabel:kst.timeLabel,
  kstFullLabel:kst.fullLabel,
 };
}

/** Parse and deduplicate raw ForexFactory JSON arrays into normalized high-impact events. */
export function parseEconomicEvents(rawLists){
 const lists=Array.isArray(rawLists)&&Array.isArray(rawLists[0])?rawLists:[rawLists];
 const seen=new Set();
 const out=[];
 for(const list of lists){
  if(!Array.isArray(list))continue;
  for(const raw of list){
   if(!isHighImpactCryptoEvent(raw))continue;
   const at=Date.parse(String(raw.date||''));
   if(!Number.isFinite(at))continue;
   const ccy=String(raw.country||'').trim().toUpperCase();
   const title=String(raw.title||'').replace(/\s+/g,' ').trim();
   const key=`${ccy}|${title.toLowerCase()}|${at}`;
   if(seen.has(key))continue;
   seen.add(key);
   out.push(normalizeEventRecord({
    id:key,
    at,
    country:ccy,
    title,
    forecast:raw.forecast,
    previous:raw.previous,
    actual:raw.actual,
    source:'ForexFactory',
   }));
  }
 }
 out.sort((a,b)=>a.at-b.at||(a.tier==='CRITICAL'?0:1)-(b.tier==='CRITICAL'?0:1));
 return out;
}

/** Parse TradingView /events JSON response into normalized high-impact events with live actuals. */
export function parseTradingViewEvents(payload){
 const rows=Array.isArray(payload?.result)?payload.result:(Array.isArray(payload)?payload:[]);
 const seen=new Set();
 const out=[];
 for(const raw of rows){
  if(!isHighImpactCryptoEvent(raw))continue;
  const at=Date.parse(String(raw.date||''));
  if(!Number.isFinite(at))continue;
  const ccy=String(raw.currency||ISO2_TO_CCY[String(raw.country||'').toUpperCase()]||raw.country||'').trim().toUpperCase();
  const title=String(raw.title||raw.indicator||'').replace(/\s+/g,' ').trim();
  const dedupKey=`${ccy}|${title.toLowerCase()}|${at}`;
  if(seen.has(dedupKey))continue;
  seen.add(dedupKey);
  const scale=raw.scale||'';
  const unit=raw.unit||'';
  out.push(normalizeEventRecord({
   id:raw.id!=null?`tv:${raw.id}`:dedupKey,
   at,
   country:ccy,
   title,
   actual:formatTvValue(raw.actual,scale,unit),
   forecast:formatTvValue(raw.forecast,scale,unit),
   previous:formatTvValue(raw.previous,scale,unit),
   source:'TradingView',
  }));
 }
 out.sort((a,b)=>a.at-b.at||(a.tier==='CRITICAL'?0:1)-(b.tier==='CRITICAL'?0:1));
 return out;
}

/** True when an event with an expected numeric actual is within [T-30s, T+15m] and still awaiting its actual print. */
export function isReleaseWatchWindow(events,now=Date.now()){
 const t=Number(now)||Date.now();
 return (Array.isArray(events)?events:[]).some(e=>
  e&&e.expectsActual!==false&&!e.actual&&t>=e.at-30000&&t<=e.at+15*60000
 );
}

/** Return events whose `actual` just arrived compared to the previous cached list. */
export function findNewlyReleasedEvents(prevEvents,nextEvents){
 const prevMap=new Map();
 for(const e of (Array.isArray(prevEvents)?prevEvents:[])){
  if(!e)continue;
  prevMap.set(e.id,e);
  prevMap.set(`${e.country}|${e.titleKo}|${e.at}`,e);
 }
 const newly=[];
 for(const e of (Array.isArray(nextEvents)?nextEvents:[])){
  if(!e?.actual)continue;
  const old=prevMap.get(e.id)||prevMap.get(`${e.country}|${e.titleKo}|${e.at}`);
  if(old&&!old.actual)newly.push(e);
 }
 return newly;
}

/** Build the dashboard/API economic calendar payload relative to `now`. */
export function buildEconomicCalendarReport({events=[],now=Date.now(),updatedAt=null,error='',source=''}={}){
 const t=Number(now)||Date.now();
 const todayKey=formatKstEventTime(t).dateKey;
 const list=Array.isArray(events)?events:[];
 const detectedSource=source||list[0]?.source||'TradingView';

 const decorate=e=>{
  const diffMs=e.at-t;
  const hasActual=Boolean(e.actual);
  const isImminent=!hasActual&&diffMs>-15*60000&&diffMs<=2*3600000;
  const isAwaitingResult=!hasActual&&e.expectsActual!==false&&diffMs<=0&&diffMs>-15*60000;
  const isJustReleased=hasActual&&diffMs<=60000&&diffMs>=-30*60000;
  const isWithin24h=!hasActual&&diffMs>-15*60000&&diffMs<=24*3600000;
  const isToday=e.kstDateKey===todayKey;
  return {
   ...e,
   countdownKo:formatCountdownKo(e.at,t,{hasActual,expectsActual:e.expectsActual!==false,precise:true}),
   isImminent,
   isAwaitingResult,
   isJustReleased,
   isWithin24h,
   isToday,
  };
 };

 // Events without actuals stay in upcoming up to +15m so user sees "결과 수집 중"; once actual arrives, they move to justReleased/recent.
 const upcoming=list
  .filter(e=>!e.actual&&(e.at>=t||(e.at>=t-15*60000)))
  .sort((a,b)=>a.at-b.at||(a.tier==='CRITICAL'?0:1)-(b.tier==='CRITICAL'?0:1))
  .slice(0,20)
  .map(decorate);

 const recent=list
  .filter(e=>(e.actual&&e.at<=t+60000&&e.at>=t-24*3600000)||(!e.actual&&e.at<t-15*60000&&e.at>=t-24*3600000))
  .sort((a,b)=>b.at-a.at||(a.tier==='CRITICAL'?0:1)-(b.tier==='CRITICAL'?0:1))
  .slice(0,8)
  .map(decorate);

 const justReleased=recent.filter(e=>e.isJustReleased);
 const nextEvent=upcoming[0]||null;
 const imminentCount=upcoming.filter(e=>e.isImminent).length;
 const todayCount=upcoming.filter(e=>e.isToday).length;
 const criticalCount=upcoming.filter(e=>e.tier==='CRITICAL').length;
 const releaseWatch=isReleaseWatchWindow(list,t);

 return {
  ok:Boolean(list.length||!error),
  updatedAt:Number(updatedAt)||t,
  serverNow:t,
  source:detectedSource,
  error:error||'',
  releaseWatch,
  justReleased,
  nextEvent,
  imminentCount,
  todayCount,
  criticalCount,
  upcomingCount:upcoming.length,
  upcoming,
  recent,
 };
}

/** Fetch live high-impact events (including `actual` prints) from TradingView Economic Calendar. */
export async function fetchTradingViewCalendar({fetcher=fetch,now=Date.now(),timeoutMs=15000}={}){
 const fromIso=new Date(now-24*3600000).toISOString();
 const toIso=new Date(now+14*86400000).toISOString();
 const url=`${TV_CALENDAR_URL}?from=${encodeURIComponent(fromIso)}&to=${encodeURIComponent(toIso)}&countries=US,EU,JP,GB,CN`;
 const headers={
  Accept:'application/json',
  Origin:'https://www.tradingview.com',
  Referer:'https://www.tradingview.com/',
  'User-Agent':'SignalLab/1.0',
 };
 const res=await fetcher(url,{signal:AbortSignal.timeout(timeoutMs),headers});
 if(!res.ok)throw Error(`TradingView 캘린더 HTTP ${res.status}${res.status===429?' (요청 한도 초과)':''}`);
 const json=await res.json();
 if(!Array.isArray(json?.result))throw Error('TradingView 캘린더 응답 형식 오류');
 return parseTradingViewEvents(json);
}

/** Fetch fallback weekly schedule from ForexFactory public CDN JSON feeds. */
export async function fetchForexFactoryCalendar({fetcher=fetch,timeoutMs=15000}={}){
 const headers={Accept:'application/json','User-Agent':'SignalLab/1.0'};
 const resThis=await fetcher(FF_THIS_WEEK_URL,{signal:AbortSignal.timeout(timeoutMs),headers});
 if(!resThis.ok)throw Error(`경제지표 캘린더 HTTP ${resThis.status}${resThis.status===429?' (요청 한도 초과)':''}`);
 const thisWeek=await resThis.json();
 if(!Array.isArray(thisWeek))throw Error('경제지표 캘린더 응답 형식 오류');

 let nextWeek=[];
 try{
  const resNext=await fetcher(FF_NEXT_WEEK_URL,{signal:AbortSignal.timeout(timeoutMs),headers});
  if(resNext.ok){
   const parsed=await resNext.json();
   if(Array.isArray(parsed))nextWeek=parsed;
  }
 }catch{}

 return parseEconomicEvents([thisWeek,nextWeek]);
}

/** Fetch high-impact economic calendar events: TradingView (live actuals) primary, ForexFactory fallback. */
export async function fetchEconomicCalendar({fetcher=fetch,now=Date.now(),timeoutMs=15000}={}){
 try{
  const tvEvents=await fetchTradingViewCalendar({fetcher,now,timeoutMs});
  if(tvEvents.length)return tvEvents;
 }catch(tvErr){
  try{
   return await fetchForexFactoryCalendar({fetcher,timeoutMs});
  }catch(ffErr){
   throw Error(`${tvErr.message} / 대체 ${ffErr.message}`);
  }
 }
 return fetchForexFactoryCalendar({fetcher,timeoutMs}).catch(()=>[]);
}
