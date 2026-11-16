// Entry study of the followed trader (research only, no orders; user 2026-11-17: "내가 보내준 단타 트레이더의 패턴을
// 분석해서 진행"). Input: research/data/trader_entries.json — first entries parsed from the channel export
// ("메인 포지션 공개", 2026-06-21 ~ 11-11): symbol, side, message time, entry price, later adds, hold, PnL.
//   node research/trader_entries.mjs [entries.json] [outDir]
// For every entry it downloads 5m candles (1 day before, 4 hours after) and 4H candles (trend), then records
// what the chart looked like before the entry and what price did after it. The question: is there a timing edge
// in the entries themselves (does price go our way first?), apart from the averaging down that hides losers?
// Candle sources in order: Binance USDT-M, Gate.io, BingX (BingX keeps only ~30 days of 5m). Cached in outDir.
import fs from 'node:fs';import path from 'node:path';import {pathToFileURL} from 'node:url';

const M5=300000,H4=14400000,sleep=ms=>new Promise(r=>setTimeout(r,ms));
const mean=a=>a.length?a.reduce((s,x)=>s+x,0)/a.length:null;

async function getJSON(url,tries=3){
 for(let a=1;;a++){
  try{const r=await fetch(url,{headers:{'User-Agent':'SignalLab-Research/1.0'}});
   if(r.status===429||r.status===418){await sleep(Number(r.headers.get('retry-after')||20)*1000);continue}
   if(!r.ok)return null;return await r.json()}
  catch(e){if(a>=tries)return null;await sleep(1500*a)}
 }
}
const toRow=(t,o,h,l,c,v)=>({t:+t,o:+o,h:+h,l:+l,c:+c,v:+v});
const SOURCES={
 binance:async(sym,iv,from,to)=>{const r=await getJSON(`https://fapi.binance.com/fapi/v1/klines?symbol=${sym}&interval=${iv}&startTime=${from}&endTime=${to}&limit=1500`);
  return Array.isArray(r)?r.map(x=>toRow(x[0],x[1],x[2],x[3],x[4],x[5])):null},
 gate:async(sym,iv,from,to)=>{const r=await getJSON(`https://api.gateio.ws/api/v4/futures/usdt/candlesticks?contract=${sym.replace(/USDT$/,'_USDT')}&interval=${iv}&from=${Math.floor(from/1000)}&to=${Math.floor(to/1000)}`);
  return Array.isArray(r)?r.map(x=>toRow(x.t*1000,x.o,x.h,x.l,x.c,x.v)):null},
 bingx:async(sym,iv,from,to)=>{const r=await getJSON(`https://open-api.bingx.com/openApi/swap/v3/quote/klines?symbol=${sym.replace(/USDT$/,'-USDT')}&interval=${iv}&startTime=${from}&endTime=${to}&limit=1440`);
  return Array.isArray(r?.data)?r.data.map(k=>toRow(k.time,k.open,k.high,k.low,k.close,k.volume)).sort((a,b)=>a.t-b.t):null}
};
/** Candles covering [from,to) from the first source that has (almost) all of them. */
async function candles(sym,iv,from,to,step){
 const need=Math.floor((to-from)/step);
 for(const [name,get] of Object.entries(SOURCES)){
  const rows=(await get(sym,iv,from,to))?.filter(x=>x.t>=from&&x.t<to&&x.c>0);
  await sleep(name==='binance'?150:250);
  if(rows&&rows.length>=need*.9)return {source:name,rows};
 }
 return null;
}

function rsi(closes,n=14){if(closes.length<=n)return null;let g=0,l=0;
 for(let i=1;i<=n;i++){const d=closes[i]-closes[i-1];d>0?g+=d:l-=d}g/=n;l/=n;
 for(let i=n+1;i<closes.length;i++){const d=closes[i]-closes[i-1];g=(g*(n-1)+Math.max(d,0))/n;l=(l*(n-1)+Math.max(-d,0))/n}
 return l===0?100:100-100/(1+g/l)}
function emaSeries(v,n){const k=2/(n+1);let e=v[0];return v.map(x=>e=x*k+e*(1-k))}
/** 4H trend as the strategies use it (EMA100/EMA200 on closed 4H candles): 'up' | 'down' | 'range' | null. */
export function trend4h(h4){if(!h4||h4.length<200)return null;const c=h4.map(x=>x.c),a=emaSeries(c,100).at(-1),b=emaSeries(c,200).at(-1),last=c.at(-1);
 return a>b&&last>b?'up':a<b&&last<b?'down':'range'}

/** Before/after features of one entry. m5: 5m candles (1 day before .. 4 hours after), at: entry time. */
export function entryFeatures({side,at,entry},m5,h4){
 const s=side==='SHORT'?-1:1,i=m5.findIndex(x=>x.t+M5>at); // the 5m bar the entry happened in
 if(i<60||i+48>m5.length)return null;
 const ref=Number(entry)>0?Number(entry):m5[i].o,prev=m5.slice(0,i),c=prev.map(x=>x.c),last=c.at(-1);
 const ret=n=>prev.length>=n?(last/prev[prev.length-n].o-1)*100:null;
 const day=prev.slice(-288),hi=Math.max(...day.map(x=>x.h)),lo=Math.min(...day.map(x=>x.l));
 const volBase=mean(day.slice(0,-3).map(x=>x.v)),vol3=mean(prev.slice(-3).map(x=>x.v));
 const pre60=ret(12);
 // After: signed % moves from the entry price (+ = in the trade's favour).
 const after=m5.slice(i),fav=x=>s*(x-ref)/ref*100;
 const mfe=n=>Math.max(...after.slice(0,n).map(x=>fav(s>0?x.h:x.l))),mae=n=>Math.min(...after.slice(0,n).map(x=>fav(s>0?x.l:x.h)));
 const first=(up,dn)=>{for(const x of after.slice(0,48)){const a=fav(s>0?x.l:x.h),b=fav(s>0?x.h:x.l);if(a<=-dn)return 'LOSS';if(b>=up)return 'WIN'}return 'NONE'}; // same bar: loss first
 const t4=trend4h(h4);
 return {
  pre15:ret(3),pre30:ret(6),pre60,pre240:ret(48),pre24h:ret(288),
  // fading = entering against the last hour's move (short after a rise, long after a drop)
  style:pre60==null||Math.abs(pre60)<1?'quiet':Math.sign(pre60)===s?'follow':'fade',
  rangePos:hi>lo?(ref-lo)/(hi-lo):null,fromHighPct:(hi-ref)/hi*100,fromLowPct:(ref-lo)/lo*100,
  vol3x:volBase?vol3/volBase:null,rsi5m:rsi(c.slice(-100)),
  trend4h:t4,withTrend:t4==null||t4==='range'?null:(t4==='up')===(s>0),
  hourKst:new Date(at+9*3600000).getUTCHours(),
  chase:(m5[i].o&&ref)?s*(ref-m5[i].o)/m5[i].o*100:null,
  ret15:fav(after[2].c),ret60:fav(after[11].c),ret240:fav(after[47].c),
  mfe15:mfe(3),mae15:mae(3),mfe60:mfe(12),mae60:mae(12),mfe240:mfe(48),mae240:mae(48),
  first05:first(.5,.5),first1:first(1,1),first2:first(2,2),first1v2:first(1,2)
 };
}

/** Summary rows for a list of studied entries. */
export function summarize(list){
 const n=list.length,rate=(k,v)=>n?list.filter(x=>x[k]===v).length/n*100:null,med=k=>{const a=list.map(x=>x[k]).filter(Number.isFinite).sort((a,b)=>a-b);return a.length?a[Math.floor(a.length/2)]:null};
 const decided=k=>{const w=list.filter(x=>x[k]==='WIN').length,l=list.filter(x=>x[k]==='LOSS').length;return w+l?w/(w+l)*100:null};
 return {n,win05:decided('first05'),win1:decided('first1'),win2:decided('first2'),win1v2:decided('first1v2'),
  ret15:med('ret15'),ret60:med('ret60'),ret240:med('ret240'),mfe60:med('mfe60'),mae60:med('mae60'),
  pre60:med('pre60'),pre240:med('pre240'),rangePos:med('rangePos'),vol3x:med('vol3x'),rsi5m:med('rsi5m'),laterAdded:rate('laterAdded',true)};
}
const f1=x=>Number.isFinite(x)?x.toFixed(1):'—',f2=x=>Number.isFinite(x)?x.toFixed(2):'—';
const line=(label,s)=>`${label.padEnd(26)} ${String(s.n).padStart(4)}건 | 먼저 +0.5%:${f1(s.win05).padStart(5)}% +1%:${f1(s.win1).padStart(5)}% +2%:${f1(s.win2).padStart(5)}% (+1% vs -2%:${f1(s.win1v2).padStart(5)}%) | 중간 수익 15분 ${f2(s.ret15)} 1시간 ${f2(s.ret60)} 4시간 ${f2(s.ret240)}% | 1시간 최대 +${f2(s.mfe60)}/${f2(s.mae60)}% | 진입 전 1시간 ${f2(s.pre60)}% 4시간 ${f2(s.pre240)}% | 24h 위치 ${f2(s.rangePos)} | 거래량 ${f2(s.vol3x)}배 | RSI ${f1(s.rsi5m)} | 이후 추매 ${f1(s.laterAdded)}%`;

export function report(rows){
 const L=[],by=(label,key,order)=>{L.push('',`[${label}]`);const g=new Map();for(const r of rows){const k=key(r);if(k==null)continue;if(!g.has(k))g.set(k,[]);g.get(k).push(r)}
  for(const k of order||[...g.keys()].sort())if(g.has(k))L.push(line('  '+k,summarize(g.get(k))))};
 L.push('트레이더 진입 분석 ("메인 포지션 공개" 2026-06-21 ~ 11-11)','='.repeat(70),
  '"먼저 +1%" = 진입가에서 +1%와 -1% 중 4시간 안에 먼저 닿은 쪽이 +1%인 비율(같은 5분봉이면 손실 먼저). 50%보다 높으면 진입 타이밍 자체에 우위가 있다는 뜻입니다.',
  '수익률은 진입 방향 기준(+ = 유리), 수수료 제외. 진입가는 알림 메시지 값이라 실제 체결과 다를 수 있습니다.','');
 L.push(line('전체',summarize(rows)));
 by('방향',r=>r.side==='LONG'?'롱':'숏',['롱','숏']);
 by('진입 방식 (직전 1시간 움직임 기준)',r=>({fade:'역행 (오른 뒤 숏·내린 뒤 롱)',follow:'추종 (오르는 중 롱·내리는 중 숏)',quiet:'조용함 (1시간 ±1% 미만)'})[r.style]);
 by('방향 × 방식',r=>(r.side==='LONG'?'롱 ':'숏 ')+r.style);
 by('직전 1시간 움직임 크기',r=>{const a=Math.abs(r.pre60??0);return a<1?'a <1%':a<3?'b 1~3%':a<5?'c 3~5%':a<10?'d 5~10%':'e 10%+'});
 by('4H 추세',r=>r.trend4h==='range'?'횡보':r.withTrend==null?'추세 없음':r.withTrend?'순방향':'역방향');
 by('24시간 범위 안 위치 (0=저점, 1=고점)',r=>r.rangePos==null?null:r.rangePos<.2?'a 0~0.2':r.rangePos<.4?'b 0.2~0.4':r.rangePos<.6?'c 0.4~0.6':r.rangePos<.8?'d 0.6~0.8':'e 0.8~1');
 by('방향 × 24시간 위치',r=>r.rangePos==null?null:(r.side==='LONG'?'롱 ':'숏 ')+(r.rangePos<.33?'저점권':r.rangePos<.67?'중간':'고점권'));
 by('직전 15분 거래량 (하루 평균 대비)',r=>r.vol3x==null?null:r.vol3x<1?'a 1배 미만':r.vol3x<2?'b 1~2배':r.vol3x<4?'c 2~4배':'d 4배+');
 by('5분 RSI',r=>r.rsi5m==null?null:r.rsi5m<30?'a 30 미만':r.rsi5m<45?'b 30~45':r.rsi5m<55?'c 45~55':r.rsi5m<70?'d 55~70':'e 70+');
 by('종목',r=>r.major?'BTC·ETH':'알트');
 by('이후 결과 (기록)',r=>r.laterAdded?'나중에 추매함':r.holdMin<60?'추매 없이 1시간 안 청산':'추매 없이 1시간+');
 by('시간대 (한국)',r=>{const h=r.hourKst;return h<6?'a 00~06':h<12?'b 06~12':h<18?'c 12~18':'d 18~24'});
 const src={};for(const r of rows)src[r.source]=(src[r.source]||0)+1;
 L.push('',`차트 출처: ${Object.entries(src).map(([k,v])=>k+' '+v).join(', ')}`);
 return L.join('\n');
}

export async function main(argv=process.argv.slice(2)){
 const [inFile=path.join('research','data','trader_entries.json'),outDir='trader-entries']=argv;
 const entries=JSON.parse(fs.readFileSync(inFile,'utf8'));fs.mkdirSync(outDir,{recursive:true});
 const cacheFile=path.join(outDir,'cache.json');let cache={};try{cache=JSON.parse(fs.readFileSync(cacheFile,'utf8'))}catch{}
 const rows=[],missing={};let k=0;
 for(const e of entries){
  k++;const id=`${e.symbol}|${e.side}|${e.at}`;
  if(!cache[id]){
   const start=Math.floor((e.at-86400000-60*M5)/M5)*M5,end=Math.floor(e.at/M5)*M5+50*M5;
   const m5=await candles(e.symbol,'5m',start,end,M5);
   const h4=m5?await candles(e.symbol,'4h',Math.floor(e.at/H4)*H4-210*H4,Math.floor(e.at/H4)*H4,H4):null;
   const f=m5?entryFeatures(e,m5.rows,h4?.rows||null):null;
   cache[id]=f?{...f,source:m5.source}:{missing:m5?'SHORT_WINDOW':'NO_CANDLES'};
   if(k%25===0){fs.writeFileSync(cacheFile,JSON.stringify(cache));console.log(`${k}/${entries.length} ${e.symbol}`)}
  }
  const f=cache[id];if(f.missing){missing[e.symbol]=(missing[e.symbol]||0)+1;continue}
  rows.push({...e,...f,laterAdded:e.adds>0,major:/^(BTC|ETH)USDT$/.test(e.symbol)});
 }
 fs.writeFileSync(cacheFile,JSON.stringify(cache));
 const text=report(rows)+`\n차트 없음 ${entries.length-rows.length}건: ${Object.entries(missing).sort((a,b)=>b[1]-a[1]).map(([s,n])=>s+' '+n).join(', ')}\n`;
 fs.writeFileSync(path.join(outDir,'report.txt'),text);fs.writeFileSync(path.join(outDir,'rows.json'),JSON.stringify(rows));
 console.log(text);console.log(`저장: ${path.join(outDir,'report.txt')}`);
}
if(import.meta.url===pathToFileURL(process.argv[1]||'').href)main().catch(e=>{console.error(e);process.exit(1)});
