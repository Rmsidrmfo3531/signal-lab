#!/usr/bin/env node
// Historical backtest of US macroeconomic releases vs 5-minute BTC-USD candles (24 months).
// Fetches US releases from TradingView Economic Calendar and 5m BTC-USD OHLCV from Coinbase Exchange,
// computes 15m/60m range, max range, volatility multiple vs non-release baseline, whipsaw/reversal rate,
// and directional return on actual > forecast vs actual < forecast, then writes econ_impact_stats.json.

import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const TV_URL='https://economic-calendar.tradingview.com/events';
const CB_URL='https://api.exchange.coinbase.com/products/BTC-USD/candles';

// Canonical US indicator families to backtest against BTC.
const FAMILIES=[
 {key:'FOMC_RATE',labelKo:'미국 기준금리 결정 (FOMC)',re:/^(?:fed interest rate decision|interest rate|federal funds rate)$/i},
 {key:'FOMC_MINUTES',labelKo:'FOMC 의사록',re:/fomc.*minutes/i},
 {key:'CPI',labelKo:'미국 소비자물가 (CPI)',re:/^(?:core )?inflation rate (?:mom|yoy)$/i},
 {key:'PCE',labelKo:'미국 개인소비지출 물가 (PCE)',re:/^(?:core )?pce price index (?:mom|yoy)$/i},
 {key:'NFP',labelKo:'미국 비농업 고용 · 실업률 (NFP)',re:/^(?:non farm payrolls|unemployment rate)$/i},
 {key:'PPI',labelKo:'미국 생산자물가 (PPI)',re:/^(?:core )?ppi (?:mom|yoy)$/i},
 {key:'GDP',labelKo:'미국 GDP 성장률',re:/^gdp growth rate qoq/i},
 {key:'RETAIL_SALES',labelKo:'미국 소매판매',re:/^retail sales mom$/i},
 {key:'JOBLESS_CLAIMS',labelKo:'미국 신규 실업수당 청구건수',re:/^initial jobless claims$/i},
 {key:'ISM_MFG',labelKo:'미국 ISM 제조업 PMI',re:/^ism manufacturing pmi$/i},
 {key:'ISM_SVC',labelKo:'미국 ISM 서비스업 PMI',re:/^ism services pmi$/i},
 {key:'JOLTS',labelKo:'미국 JOLTS 구인건수',re:/^jolts job openings$/i},
 {key:'ADP',labelKo:'미국 ADP 민간고용',re:/^adp employment change$/i},
 {key:'MICHIGAN',labelKo:'미국 미시간대 소비심리',re:/^michigan consumer sentiment/i},
 {key:'DURABLE_GOODS',labelKo:'미국 내구재 수주',re:/^durable goods orders mom$/i},
 {key:'HOUSING',labelKo:'미국 주택 지표 (착공·허가·매매)',re:/^(?:housing starts|building permits|existing home sales)/i},
];

const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const avg=a=>a.length?a.reduce((s,v)=>s+v,0)/a.length:null;
const med=a=>{if(!a.length)return null;const s=[...a].sort((x,y)=>x-y);const m=Math.floor(s.length/2);return s.length%2?s[m]:(s[m-1]+s[m])/2};
const r2=v=>v==null?null:+Number(v).toFixed(2);
const r1=v=>v==null?null:+Number(v).toFixed(1);

async function fetchTvRange(fromMs,toMs){
 const url=`${TV_URL}?from=${encodeURIComponent(new Date(fromMs).toISOString())}&to=${encodeURIComponent(new Date(toMs).toISOString())}&countries=US`;
 for(let attempt=0;attempt<4;attempt++){
  const r=await fetch(url,{
   headers:{Accept:'application/json',Origin:'https://www.tradingview.com',Referer:'https://www.tradingview.com/','User-Agent':'SignalLab/1.0'},
   signal:AbortSignal.timeout(15000),
  });
  if(r.status===429){await sleep(2500*(attempt+1));continue}
  if(!r.ok)throw Error(`TV HTTP ${r.status}`);
  const j=await r.json();
  return Array.isArray(j?.result)?j.result:[];
 }
 throw Error('TV HTTP 429 after retries');
}

// Fetch 5-minute BTC-USD candles around `tsMs` ([tsMs - 15m, tsMs + 65m]).
async function fetchBtcWindow(tsMs){
 const start=new Date(tsMs-15*60000).toISOString();
 const end=new Date(tsMs+65*60000).toISOString();
 const url=`${CB_URL}?granularity=300&start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`;
 for(let attempt=0;attempt<3;attempt++){
  const r=await fetch(url,{headers:{Accept:'application/json','User-Agent':'SignalLab/1.0'},signal:AbortSignal.timeout(12000)});
  if(r.status===429){await sleep(1200*(attempt+1));continue}
  if(!r.ok)return null;
  const rows=await r.json();
  if(!Array.isArray(rows)||!rows.length)return null;
  // Coinbase candle format: [time_sec, low, high, open, close, volume]
  return rows.map(c=>({t:c[0]*1000,l:Number(c[1]),h:Number(c[2]),o:Number(c[3]),c:Number(c[4]),v:Number(c[5])})).sort((a,b)=>a.t-b.t);
 }
 return null;
}

function measureReaction(candles,releaseMs){
 if(!candles?.length)return null;
 // Anchor price: open of the release 5m bar (or close of the immediately preceding bar)
 const atOrAfter=candles.filter(c=>c.t>=releaseMs-60000&&c.t<releaseMs+60*60000);
 if(atOrAfter.length<10)return null;
 const prev=candles.filter(c=>c.t<releaseMs).at(-1);
 const anchor=prev?prev.c:atOrAfter[0].o;
 if(!(anchor>0))return null;

 const bars15=atOrAfter.slice(0,3); // 0..15m
 const bars60=atOrAfter.slice(0,12); // 0..60m
 const hi15=Math.max(...bars15.map(b=>b.h)),lo15=Math.min(...bars15.map(b=>b.l));
 const hi60=Math.max(...bars60.map(b=>b.h)),lo60=Math.min(...bars60.map(b=>b.l));
 const range15Pct=(hi15-lo15)/anchor*100;
 const range60Pct=(hi60-lo60)/anchor*100;
 const ret5Pct=(bars15[0].c-anchor)/anchor*100;
 const ret15Pct=(bars15.at(-1).c-anchor)/anchor*100;
 const ret60Pct=(bars60.at(-1).c-anchor)/anchor*100;
 // Whipsaw/reversal: initial 5m move >= 0.15% AND 60m close flips to opposite sign (or reverses >= 70% of 15m excursion)
 const flipped=Math.abs(ret5Pct)>=0.15&&((ret5Pct>0&&ret60Pct<0)||(ret5Pct<0&&ret60Pct>0));
 const upExc=(hi60-anchor)/anchor*100,dnExc=(anchor-lo60)/anchor*100;
 const bothSides=upExc>=0.35&&dnExc>=0.35;
 return {
  range15Pct,
  range60Pct,
  ret5Pct,
  ret15Pct,
  ret60Pct,
  absRet60Pct:Math.abs(ret60Pct),
  whipsaw:flipped||bothSides,
 };
}

async function runPool(items,concurrency,fn){
 const out=new Array(items.length);
 let idx=0;
 await Promise.all(Array.from({length:concurrency},async()=>{
  while(idx<items.length){
   const i=idx++;
   out[i]=await fn(items[i],i);
  }
 }));
 return out;
}

async function main(){
 const now=Date.now();
 const months=24;
 const startMs=now-months*30.4375*86400000;
 console.log(`Fetching ${months} months of US economic releases from TradingView...`);
 const stepDays=75;
 const allRaw=[];
 for(let a=startMs;a<now;a+=stepDays*86400000){
  const b=Math.min(now,a+stepDays*86400000);
  const chunk=await fetchTvRange(a,b);
  allRaw.push(...chunk);
  await sleep(450);
 }
 console.log(`Fetched ${allRaw.length} total US TradingView events.`);

 // Group events by family + unique release timestamp (avoid double-counting CPI MoM + CPI YoY at same timestamp)
 const familyEvents=new Map(FAMILIES.map(f=>[f.key,new Map()]));
 for(const ev of allRaw){
  const at=Date.parse(String(ev.date||''));
  if(!Number.isFinite(at)||at>now-90*60000)continue;
  const title=String(ev.title||'').trim();
  for(const fam of FAMILIES){
   if(!fam.re.test(title))continue;
   const slotMap=familyEvents.get(fam.key);
   const existing=slotMap.get(at);
   // Prefer primary (higher importance, or with forecast & actual)
   const hasBoth=ev.actual!=null&&ev.forecast!=null;
   if(!existing||(hasBoth&&!(existing.actual!=null&&existing.forecast!=null))||(ev.importance>(existing.importance??-2))){
    slotMap.set(at,{at,title,actual:ev.actual,forecast:ev.forecast,previous:ev.previous,importance:ev.importance});
   }
   break;
  }
 }

 // Collect all unique release timestamps + non-release weekday baseline timestamps (13:30 UTC)
 const uniqueTs=new Set();
 for(const slotMap of familyEvents.values())for(const ts of slotMap.keys())uniqueTs.add(ts);
 const releaseDays=new Set([...uniqueTs].map(ts=>new Date(ts).toISOString().slice(0,10)));
 const baselineTs=[];
 for(let d=5;d<months*30;d+=3){
  const dt=new Date(now-d*86400000);
  const dow=dt.getUTCDay();
  if(dow===0||dow===6)continue;
  const dayKey=dt.toISOString().slice(0,10);
  if(releaseDays.has(dayKey))continue;
  const ts=Date.parse(`${dayKey}T13:30:00.000Z`);
  baselineTs.push(ts);
  if(baselineTs.length>=60)break;
 }

 const allTimestamps=[...new Set([...uniqueTs,...baselineTs])];
 console.log(`Fetching 5m BTC-USD candles for ${uniqueTs.size} release slots + ${baselineTs.length} baseline slots...`);
 const candleMap=new Map();
 await runPool(allTimestamps,4,async(ts)=>{
  const rows=await fetchBtcWindow(ts);
  if(rows)candleMap.set(ts,rows);
  await sleep(60);
 });

 // Compute baseline 15m and 60m BTC range on non-release weekdays at 13:30 UTC
 const baseMeasures=baselineTs.map(ts=>measureReaction(candleMap.get(ts),ts)).filter(Boolean);
 const baselineRange15=avg(baseMeasures.map(m=>m.range15Pct))||0.5;
 const baselineRange60=avg(baseMeasures.map(m=>m.range60Pct))||0.9;
 const baselineWhipsaw=baseMeasures.length?baseMeasures.filter(m=>m.whipsaw).length/baseMeasures.length*100:25;

 const results={};
 const rowsForTable=[];
 for(const fam of FAMILIES){
  const entries=[...familyEvents.get(fam.key).values()];
  const measures=[];
  const aboveRets=[],belowRets=[];
  for(const e of entries){
   const m=measureReaction(candleMap.get(e.at),e.at);
   if(!m)continue;
   measures.push(m);
   const a=Number(e.actual),f=Number(e.forecast);
   if(e.actual!=null&&e.forecast!=null&&Number.isFinite(a)&&Number.isFinite(f)&&Math.abs(a-f)>1e-9){
    if(a>f)aboveRets.push(m.ret60Pct);
    else belowRets.push(m.ret60Pct);
   }
  }
  if(!measures.length)continue;
  const avgRange15=avg(measures.map(m=>m.range15Pct));
  const avgRange60=avg(measures.map(m=>m.range60Pct));
  const medRange60=med(measures.map(m=>m.range60Pct));
  const maxRange60=Math.max(...measures.map(m=>m.range60Pct));
  const avgAbs60=avg(measures.map(m=>m.absRet60Pct));
  const whipsawPct=measures.filter(m=>m.whipsaw).length/measures.length*100;
  const vsBaseline15mX=avgRange15/baselineRange15;
  const vsBaselineX=avgRange60/baselineRange60;
  // Data-driven impact grade based on immediate 15m announcement shock multiple vs baseline
  const volScore=vsBaseline15mX*55+vsBaselineX*45;
  const grade=vsBaseline15mX>=1.6?'S':(vsBaseline15mX>=1.2?'A':(vsBaseline15mX>=0.8?'B':'C'));

  const stat={
   key:fam.key,
   labelKo:fam.labelKo,
   sampleCount:measures.length,
   avgRange15mPct:r2(avgRange15),
   avgRange60mPct:r2(avgRange60),
   medRange60mPct:r2(medRange60),
   maxRange60mPct:r2(maxRange60),
   avgAbsMove60mPct:r2(avgAbs60),
   vsBaseline15mX:r2(vsBaseline15mX),
   vsBaselineX:r2(vsBaselineX),
   whipsawRatePct:r1(whipsawPct),
   aboveAvgRet60mPct:aboveRets.length>=3?r2(avg(aboveRets)):null,
   aboveCount:aboveRets.length,
   belowAvgRet60mPct:belowRets.length>=3?r2(avg(belowRets)):null,
   belowCount:belowRets.length,
   grade,
   volScore:r1(volScore),
  };
  results[fam.key]=stat;
  rowsForTable.push(stat);
 }

 rowsForTable.sort((a,b)=>b.avgRange15mPct-a.avgRange15mPct);
 console.log('\n=== 24-MONTH EMPIRICAL BTC IMPACT BACKTEST ===');
 console.log(`Baseline (non-release weekday 13:30 UTC, n=${baseMeasures.length}): 15m avg=${r2(baselineRange15)}%, 60m avg=${r2(baselineRange60)}%, whipsaw=${r1(baselineWhipsaw)}%`);
 for(const s of rowsForTable){
  console.log(`${s.grade} | ${s.key.padEnd(15)} | n=${String(s.sampleCount).padStart(3)} | 15m=${String(s.avgRange15mPct).padStart(5)}% (${s.vsBaseline15mX}x) | 60m=${String(s.avgRange60mPct).padStart(5)}% (max ${s.maxRange60mPct}%) | whipsaw=${s.whipsawRatePct}% | >fc:${s.aboveAvgRet60mPct??'—'}%(${s.aboveCount}) <fc:${s.belowAvgRet60mPct??'—'}%(${s.belowCount})`);
 }

 const out={
  generatedAt:new Date(now).toISOString(),
  windowMonths:months,
  priceSource:'Coinbase BTC-USD 5m',
  calendarSource:'TradingView US Economic Calendar',
  baseline:{
   sampleCount:baseMeasures.length,
   avgRange15mPct:r2(baselineRange15),
   avgRange60mPct:r2(baselineRange60),
   whipsawRatePct:r1(baselineWhipsaw),
  },
  families:results,
 };
 const outPath=path.join(ROOT,'econ_impact_stats.json');
 fs.writeFileSync(outPath,JSON.stringify(out,null,2)+'\n');
 console.log(`\nSaved empirical stats to ${outPath}`);
}

main().catch(e=>{console.error(e);process.exit(1)});
