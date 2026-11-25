// High-impact macroeconomic indicator calendar for crypto traders (read-only).
// Uses ForexFactory public weekly JSON feeds (thisweek + best-effort nextweek),
// filters to crypto-moving High-impact events (USD + major central banks),
// tiers CRITICAL vs HIGH, and localizes event names & crypto impact hints to Korean.

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

// Ordered rules: first match wins. `critical: true` marks Tier-S crypto volatility events.
const EVENT_RULES=[
 {re:/federal funds rate/i,ko:'미국 기준금리 결정 (FOMC)',critical:true,hint:'금리 동결·인하 여부 및 점도표가 BTC 변동성 직결'},
 {re:/fomc economic projections/i,ko:'FOMC 경제전망 · 점도표',critical:true,hint:'향후 금리 인하 횟수 전망 변화 시 급변동'},
 {re:/fomc press conference/i,ko:'FOMC 파월 의장 기자회견',critical:true,hint:'매파·비둘기파 발언 톤에 따라 실시간 급등락'},
 {re:/fomc statement/i,ko:'FOMC 통화정책 성명서',critical:true,hint:'성명서 문구 변화로 향후 금리 경로 선반영'},
 {re:/fomc meeting minutes/i,ko:'FOMC 의사록 공개',critical:true,hint:'연준 위원 간 매파·비둘기파 의견 확인'},
 {re:/fed chair .*speaks|powell speaks/i,ko:'연준 의장 연설',critical:true,hint:'금리·유동성 관련 발언 시 단기 급변동 유의'},
 {re:/core pce price index/i,ko:'미국 근원 PCE 물가지수',critical:true,hint:'연준 최선호 물가지표 — 예상 하회 시 위험자산 우호적'},
 {re:/\bpce price index/i,ko:'미국 PCE 물가지수',critical:true,hint:'인플레이션 둔화 여부에 따라 금리 기대감 변동'},
 {re:/core cpi\s*y\/y/i,ko:'미국 근원 CPI (전년비)',critical:true,hint:'예상 상회 시 금리 부담으로 코인 하방 압력'},
 {re:/core cpi\s*m\/m/i,ko:'미국 근원 CPI (전월비)',critical:true,hint:'핵심 물가 추세 — 예상 상회 시 매도 변동성 확대'},
 {re:/\bcpi\s*y\/y/i,ko:'소비자물가지수 CPI (전년비)',critical:true,hint:'대표 인플레이션 지표 — 발표 직후 강한 위아래 휩소 주의'},
 {re:/\bcpi\s*m\/m/i,ko:'소비자물가지수 CPI (전월비)',critical:true,hint:'예상치 대비 ±0.1%p 괴리만으로도 급변동'},
 {re:/non-?farm employment change|non-?farm payrolls/i,ko:'미국 비농업 고용 (NFP)',critical:true,hint:'고용 과열·둔화 여부가 금리 인하 속도 좌우'},
 {re:/unemployment rate/i,ko:'미국 실업률',critical:true,hint:'예상 상회 시 경기 침체 우려 vs 금리 인하 기대 충돌'},
 {re:/boj policy rate/i,ko:'일본은행(BOJ) 기준금리 결정',critical:true,hint:'엔캐리 트레이드 청산·유입으로 BTC 급변동 유발'},
 {re:/boj press conference|boj outlook report/i,ko:'일본은행(BOJ) 기자회견·전망',critical:true,hint:'금리 인상 시사 시 엔화 강세·위험자산 약세 압력'},
 {re:/main refinancing rate|ecb.*rate/i,ko:'유럽중앙은행(ECB) 기준금리 결정',critical:true,hint:'글로벌 유동성·달러인덱스(DXY) 방향성에 영향'},
 {re:/ecb press conference/i,ko:'ECB 총재 기자회견',critical:false,hint:'유로화·달러인덱스 변동 통한 간접 영향'},
 {re:/official bank rate/i,ko:'영란은행(BOE) 기준금리 결정',critical:false,hint:'글로벌 금리 흐름 및 달러 강세 여부 참고'},
 {re:/average hourly earnings/i,ko:'미국 시간당 평균임금',critical:false,hint:'임금 인플레이션 압력 확인 지표'},
 {re:/core ppi/i,ko:'미국 근원 생산자물가 (Core PPI)',critical:false,hint:'소비자물가(CPI) 선행 지표 — 예상 상회 시 부담'},
 {re:/\bppi\b/i,ko:'미국 생산자물가지수 (PPI)',critical:false,hint:'도매 물가 추세 확인 — 발표 직후 단기 변동'},
 {re:/unemployment claims/i,ko:'미국 신규 실업수당 청구건수',critical:false,hint:'매주 목요일 발표 — 고용 둔화 여부 실시간 체크'},
 {re:/adp non-?farm/i,ko:'미국 ADP 민간고용',critical:false,hint:'비농업 고용(NFP) 선행 지표로 시장 반응'},
 {re:/jolts job openings/i,ko:'미국 JOLTS 구인·이직 보고서',critical:false,hint:'노동시장 과열 완화 여부 확인'},
 {re:/ism manufacturing pmi/i,ko:'미국 ISM 제조업 PMI',critical:false,hint:'50 기준 경기 확장·위축 판단 및 금리 기대 반응'},
 {re:/ism services pmi/i,ko:'미국 ISM 서비스업 PMI',critical:false,hint:'미국 경제 비중이 큰 서비스업 경기 지표'},
 {re:/flash manufacturing pmi/i,ko:'S&P 글로벌 제조업 PMI (속보)',critical:false,hint:'경기 선행 지표 — 예상 괴리 시 단기 변동'},
 {re:/flash services pmi/i,ko:'S&P 글로벌 서비스업 PMI (속보)',critical:false,hint:'서비스 경기 및 물가 압력 동시 반영'},
 {re:/core retail sales/i,ko:'미국 근원 소매판매',critical:false,hint:'미국 소비 탄력성 지표 — 과열 시 금리 부담'},
 {re:/retail sales/i,ko:'미국 소매판매',critical:false,hint:'소비 경기 확인 — 예상 상회 시 달러 강세 경향'},
 {re:/advance gdp/i,ko:'미국 GDP 성장률 (속보치)',critical:true,hint:'첫 분기 성장률 발표로 경기 침체·과열 판단 핵심'},
 {re:/prelim gdp/i,ko:'미국 GDP 성장률 (잠정치)',critical:false,hint:'GDP 수정치 — 큰 폭 조정 시 변동성'},
 {re:/final gdp/i,ko:'미국 GDP 성장률 (확정치)',critical:false,hint:'분기 성장률 확정치'},
 {re:/\bgdp\b/i,ko:'GDP 성장률',critical:false,hint:'거시 경기 성장세 확인 지표'},
 {re:/cb consumer confidence/i,ko:'미국 컨퍼런스보드 소비자신뢰지수',critical:false,hint:'소비 심리 변화 확인'},
 {re:/uom consumer sentiment/i,ko:'미국 미시간대 소비심리지수',critical:false,hint:'소비심리 및 기대 인플레이션 동시 주목'},
 {re:/uom inflation expectations/i,ko:'미시간대 기대 인플레이션',critical:false,hint:'기대 물가 급등 시 연준 매파 우려 자극'},
 {re:/core durable goods/i,ko:'미국 근원 내구재 수주',critical:false,hint:'기업 설비투자·경기 선행 지표'},
 {re:/durable goods/i,ko:'미국 내구재 수주',critical:false,hint:'제조업 경기 흐름 참고'},
 {re:/jackson hole/i,ko:'잭슨홀 경제심포지엄',critical:true,hint:'연준 의장 기조연설 시 중기 통화정책 방향 전환점'},
 {re:/treasury currency report|debt ceiling/i,ko:'미국 재무부 주요 정책 일정',critical:false,hint:'거시 유동성·달러 정책 변수'},
 {re:/rate statement|monetary policy/i,ko:'중앙은행 통화정책 성명',critical:false,hint:'글로벌 금리·유동성 기조 확인'},
];

const NON_USD_MAJOR_RE=/rate|policy|press conference|monetary|cpi|inflation|gdp|pmi|payroll|employment/i;

/** Return true if a raw ForexFactory calendar item is a high-impact crypto-relevant release. */
export function isHighImpactCryptoEvent(raw){
 if(!raw||typeof raw!=='object')return false;
 const impact=String(raw.impact||'').trim().toLowerCase();
 if(impact!=='high')return false;
 const country=String(raw.country||'').trim().toUpperCase();
 if(!COUNTRY_META[country])return false;
 if(country==='USD')return true;
 return NON_USD_MAJOR_RE.test(String(raw.title||''));
}

/** Localize a single economic event's title, tier, and crypto impact hint into Korean. */
export function localizeEconomicEvent(raw){
 const title=String(raw?.title||'').replace(/\s+/g,' ').trim();
 const country=String(raw?.country||'').trim().toUpperCase();
 const meta=COUNTRY_META[country]||{flag:'🌐',nameKo:country};
 for(const rule of EVENT_RULES){
  if(rule.re.test(title)){
   // Prefix country name for generic non-USD matches like CPI/GDP
   const titleKo=country!=='USD'&&!/미국|일본|유럽|영란/.test(rule.ko)?`${meta.nameKo} ${rule.ko}`:rule.ko;
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

/** Human-readable Korean countdown label relative to `now`. */
export function formatCountdownKo(at,now=Date.now()){
 const diffMs=Number(at)-Number(now);
 if(diffMs<=0){
  const agoMin=Math.floor(Math.abs(diffMs)/60000);
  if(agoMin<15)return '발표 직후 · 변동성 유의';
  if(agoMin<60)return `${agoMin}분 전 발표`;
  const agoHr=Math.floor(agoMin/60);
  return `${agoHr}시간 전 발표`;
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
   const country=String(raw.country||'').trim().toUpperCase();
   const title=String(raw.title||'').replace(/\s+/g,' ').trim();
   const key=`${country}|${title.toLowerCase()}|${at}`;
   if(seen.has(key))continue;
   seen.add(key);
   const meta=COUNTRY_META[country]||{flag:'🌐',nameKo:country};
   const loc=localizeEconomicEvent(raw);
   const kst=formatKstEventTime(at);
   out.push({
    id:key,
    at,
    date:new Date(at).toISOString(),
    country,
    flag:meta.flag,
    countryKo:meta.nameKo,
    title,
    titleKo:loc.titleKo,
    tier:loc.tier,
    tierLabelKo:loc.tierLabelKo,
    hintKo:loc.hintKo,
    forecast:String(raw.forecast||'').trim(),
    previous:String(raw.previous||'').trim(),
    actual:String(raw.actual||'').trim(),
    kstDateKey:kst.dateKey,
    kstDateLabel:kst.dateLabel,
    kstTimeLabel:kst.timeLabel,
    kstFullLabel:kst.fullLabel,
   });
  }
 }
 out.sort((a,b)=>a.at-b.at||(a.tier==='CRITICAL'?-1:1)-(b.tier==='CRITICAL'?-1:1));
 return out;
}

/** Build the dashboard/API economic calendar payload relative to `now`. */
export function buildEconomicCalendarReport({events=[],now=Date.now(),updatedAt=null,error='',source='ForexFactory'}={}){
 const t=Number(now)||Date.now();
 const todayKey=formatKstEventTime(t).dateKey;
 const list=Array.isArray(events)?events:[];

 const decorate=e=>{
  const diffMs=e.at-t;
  const isImminent=diffMs>-15*60000&&diffMs<=2*3600000;
  const isWithin24h=diffMs>-15*60000&&diffMs<=24*3600000;
  const isToday=e.kstDateKey===todayKey;
  return {
   ...e,
   countdownKo:formatCountdownKo(e.at,t),
   isImminent,
   isWithin24h,
   isToday,
  };
 };

 const upcoming=list
  .filter(e=>e.at>=t-15*60000)
  .sort((a,b)=>a.at-b.at||(a.tier==='CRITICAL'?0:1)-(b.tier==='CRITICAL'?0:1))
  .slice(0,20)
  .map(decorate);

 const recent=list
  .filter(e=>e.at<t-15*60000&&e.at>=t-24*3600000)
  .sort((a,b)=>b.at-a.at)
  .slice(0,6)
  .map(decorate);

 const nextEvent=upcoming[0]||null;
 const imminentCount=upcoming.filter(e=>e.isImminent).length;
 const todayCount=upcoming.filter(e=>e.isToday).length;
 const criticalCount=upcoming.filter(e=>e.tier==='CRITICAL').length;

 return {
  ok:Boolean(list.length||!error),
  updatedAt:Number(updatedAt)||t,
  source,
  error:error||'',
  nextEvent,
  imminentCount,
  todayCount,
  criticalCount,
  upcomingCount:upcoming.length,
  upcoming,
  recent,
 };
}

/** Fetch high-impact economic calendar events from ForexFactory public weekly JSON feeds. */
export async function fetchEconomicCalendar({fetcher=fetch,timeoutMs=15000}={}){
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
