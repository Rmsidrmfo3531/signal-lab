// Backtest runner for the user's PC: downloads public Binance USDT-M candles (no keys),
// replays the strategies and writes a Korean report.
//   node scripts/backtest.mjs [--days 60] [--symbols BTCUSDT,ETHUSDT,...] [--leverage 10]
// Output: backtest-results/ (report.txt, trades.csv, summary.json). Candles are cached
// in backtest-cache/ so a re-run only downloads what is new.
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {backtestHourly,backtestScalp,backtestCandidates,summarize,scoreBucket,HOUR} from '../backtest.mjs';
import {DETECTORS} from '../pattern_detectors.mjs';
import {SCALP_DEFAULTS} from '../scalp_reversal.mjs';
import {DCA_DEFAULTS,clampMaxAdds,clampZoneDays,HOURLY_MAX_ADDS_DEFAULT} from '../dca_plan.mjs';

const BASE='https://fapi.binance.com';
const INTERVAL_MS={'1m':60000,'5m':300000,'15m':900000,'1h':3600000,'4h':14400000};
export const DEFAULT_SYMBOLS=['BTCUSDT','ETHUSDT','SOLUSDT','XRPUSDT','DOGEUSDT','BNBUSDT'];

export function parseArgs(argv){
 const out={btcLongFilter:'up',candidates:false,obstacle:1,trendFilter:true,allPatterns:false,days:60,symbols:DEFAULT_SYMBOLS,leverage:DCA_DEFAULTS.leverage,unitPct:DCA_DEFAULTS.unitPct,maxLossPct:DCA_DEFAULTS.maxLossPct,maxAdds:DCA_DEFAULTS.maxAdds,zoneDays:DCA_DEFAULTS.zoneDays,balance:1000,hourlyMaxAdds:HOURLY_MAX_ADDS_DEFAULT,scalp1mDays:30,out:'backtest-results',cache:'backtest-cache'};
 for(let i=0;i<argv.length;i++){
  const key=argv[i],value=argv[i+1];
  if(key==='--days'){out.days=Math.max(7,Math.min(365,Number(value)||60));i++}
  else if(key==='--symbols'){out.symbols=String(value||'').toUpperCase().split(',').map(s=>s.trim()).filter(s=>/^[A-Z0-9]{2,20}USDT$/.test(s)).slice(0,40);i++}
  else if(key==='--leverage'){out.leverage=Math.max(10,Math.min(20,Number(value)||10));i++}
  else if(key==='--unit-pct'){out.unitPct=Math.max(.01,Math.min(10,Number(value)||DCA_DEFAULTS.unitPct));i++}
  else if(key==='--max-loss-pct'){out.maxLossPct=Math.max(1,Math.min(95,Number(value)||30));i++}
  else if(key==='--max-adds'){out.maxAdds=clampMaxAdds(value);i++}
  else if(key==='--hourly-max-adds'){out.hourlyMaxAdds=clampMaxAdds(value,HOURLY_MAX_ADDS_DEFAULT);i++}
  else if(key==='--zone-days'){out.zoneDays=clampZoneDays(value);i++}
  else if(key==='--scalp-1m-days'){out.scalp1mDays=Math.max(0,Math.min(90,Math.round(Number(value))||0));i++}
  else if(key==='--balance'){out.balance=Math.max(10,Number(value)||1000);i++}
  else if(key==='--obstacle'){out.obstacle=Math.max(.1,Math.min(1,Number(value)||1));i++}
  else if(key==='--trend-filter'){out.trendFilter=true}
  else if(key==='--no-trend-filter'){out.trendFilter=false}
  else if(key==='--all-patterns'){out.allPatterns=true}
  else if(key==='--candidates'){out.candidates=true}
  else if(key==='--offline'){out.offline=true}
  else if(key==='--btc-long-filter'){out.btcLongFilter=['up','notdown'].includes(value)?value:null;i++} // default 'up' (as the server); 'off' disables
  else if(key==='--min-box-atr'){out.minBoxWidthAtr=Math.max(0,Number(value)||0);i++}
  else if(key==='--hourly-max-hold-days'){out.hourlyMaxHoldMs=Math.max(0,Number(value)||0)*86400000||null;i++}
  else if(key==='--patterns'){out.patterns=String(value||'').split(',').map(x=>x.trim()).filter(Boolean);i++}
 }
 if(!out.symbols.length)out.symbols=DEFAULT_SYMBOLS;
 if(!out.symbols.includes('BTCUSDT'))out.symbols=[...out.symbols];
 return out;
}
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function getJSON(url,tries=4){
 for(let a=1;;a++){
  try{const r=await fetch(url,{headers:{'User-Agent':'SignalLab-Backtest/1.0'}});
   if(r.status===429||r.status===418){await sleep(Number(r.headers.get('retry-after')||30)*1000);continue}
   if(!r.ok)throw Error('HTTP '+r.status);return await r.json()}
  catch(e){if(a>=tries)throw e;await sleep(1500*a)}
 }
}
let OFFLINE=false;
async function klines(symbol,interval,start,end,cacheDir){
 const file=path.join(cacheDir,`${symbol}_${interval}.json`),step=INTERVAL_MS[interval];
 let rows=[];try{rows=JSON.parse(fs.readFileSync(file,'utf8'))}catch{}
 if(OFFLINE)return rows; // --offline: the cached candles as they are, no download
 rows=rows.filter(r=>Number(r[0])>=start);
 if(!rows.length||Number(rows[0][0])>start)rows=[];
 let from=rows.length?Number(rows.at(-1)[0])+step:start;
 while(from<end){
  const batch=await getJSON(`${BASE}/fapi/v1/klines?symbol=${symbol}&interval=${interval}&startTime=${from}&limit=1500`);
  if(!Array.isArray(batch)||!batch.length)break;
  rows.push(...batch.filter(r=>Number(r[0])>=from));from=Number(batch.at(-1)[0])+step;
  await sleep(250);
  if(batch.length<1500)break;
 }
 // Closed candles only, no duplicates.
 const seen=new Set();rows=rows.filter(r=>Number(r[6])<Date.now()&&!seen.has(r[0])&&seen.add(r[0]));
 fs.mkdirSync(cacheDir,{recursive:true});fs.writeFileSync(file,JSON.stringify(rows));
 return rows;
}
// --offline without a cached exchangeInfo: the price tick from the cached candles' decimals, a
// lot step worth roughly $0.1-$1, BTC/ETH minimum order as on Binance. An approximation.
function approxFilters(symbol,rows){
 const dec=Math.max(...rows.slice(-200).flatMap(r=>[r[1],r[2],r[3],r[4]]).map(x=>(String(x).split('.')[1]||'').replace(/0+$/,'').length)),price=Number(rows.at(-1)[4]);
 const stepSize=symbol==='BTCUSDT'||symbol==='ETHUSDT'?.001:10**Math.floor(Math.log10(1/price));
 return {tickSize:Number((10**-dec).toFixed(dec)),stepSize,minQty:stepSize,minNotional:symbol==='BTCUSDT'?100:symbol==='ETHUSDT'?20:5,approximate:true};
}
// Rough market caps (USD) for the leverage rule in the backtest; unknown symbols count as 1B.
const APPROX_MARKET_CAP={BTCUSDT:1.5e12,ETHUSDT:4e11,SOLUSDT:9e10,XRPUSDT:1.3e11,DOGEUSDT:3e10,BNBUSDT:1.2e11,ADAUSDT:2.5e10,AVAXUSDT:1e10,LINKUSDT:1e10,LTCUSDT:7e9,SUIUSDT:1e10,TRXUSDT:2.5e10};
function filtersOf(info,symbol){
 const s=info.symbols.find(x=>x.symbol===symbol);if(!s)return null;
 const f=Object.fromEntries(s.filters.map(x=>[x.filterType,x]));
 return {tickSize:Number(f.PRICE_FILTER.tickSize),stepSize:Number(f.LOT_SIZE.stepSize),minQty:Number(f.LOT_SIZE.minQty),minNotional:Number(f.MIN_NOTIONAL?.notional??5)};
}
// Korean characters take two columns in a console.
const pad=(text,width)=>{const w=[...text].reduce((n,ch)=>n+(/[\u1100-\uffdc]/.test(ch)?2:1),0);return text+' '.repeat(Math.max(1,width-w))};
const pct=x=>Number.isFinite(x)?x.toFixed(1)+'%':'—',usd=x=>Number.isFinite(x)?(x>=0?'+$':'-$')+Math.abs(x).toFixed(2):'—',num=(x,d=2)=>Number.isFinite(x)?x.toFixed(d):'—';
function row(label,s){
 if(!s.trades)return `${pad(label,24)}거래 0건`;
 return `${pad(label,24)}거래 ${String(s.trades).padStart(4)}건 | 승률 ${pct(s.winRatePct).padStart(6)} | 순손익 ${usd(s.netUSD).padStart(10)} | 평균 ${num(s.avgR)}R | PF ${num(s.profitFactor)} | 최대낙폭 ${usd(-s.maxDrawdownUSD)} | TP1 ${pct(s.tp1RatePct)} · 손절 ${pct(s.stopPct)} · 본절 ${pct(s.breakevenStopPct)} · 시간청산 ${pct(s.timeStopPct)}`;
}
export function buildReport({args,startAt,endAt,results,hourlyFunnel,scalpFunnel,finalBalances}){
 const all=results.flatMap(r=>r.trades),by=(f)=>{const m=new Map();for(const t of all.filter(f.filter)){const k=f.key(t);if(!m.has(k))m.set(k,[]);m.get(k).push(t)}return m};
 const lines=[],date=t=>new Date(t).toISOString().slice(0,16).replace('T',' ')+' UTC';
 lines.push('Signal Lab 백테스트 결과','='.repeat(60),`기간: ${date(startAt)} ~ ${date(endAt)} (${args.days}일)`,`종목: ${args.symbols.join(', ')}`,
  `비용 가정: 시장가 수수료 0.06% + 슬리피지 0.02% (진입·청산 매번), 1H·단타 고정 위험 $6/거래`,`TP1 전 매물대 차단 기준: POC의 ${Math.round(args.obstacle*100)}% 이상 · 1H 패턴: ${args.allPatterns?'전체':'박스권 상단 돌파·상승 추세선 이탈 숏·5/20 데드크로스 숏(--all-patterns로 전체)'} · 단타 4H 추세 필터 ${args.trendFilter?'켬':'끔'}`,
  `체결 가정: 신호 봉 마감 직후 5분봉 시가 진입, 같은 5분봉에서 손절·익절이 모두 닿으면 손절 우선, 갭은 시가 체결`,'');
 lines.push('[1] 1시간봉 전략 (현재 기준: 100점 중 90점 이상)','-'.repeat(60));
 const live=all.filter(t=>t.strategy==='HOURLY'&&t.book==='LIVE');
 lines.push(row('전체',summarize(live)));
 for(const [k,v] of by({filter:t=>t.strategy==='HOURLY'&&t.book==='LIVE',key:t=>t.pattern}))lines.push(row('  '+k,summarize(v)));
 const mid=startAt+(endAt-startAt)/2,halves=list=>[['  전반기',list.filter(t=>t.signalAt<mid)],['  후반기',list.filter(t=>t.signalAt>=mid)]];
 for(const d of ['LONG','SHORT'])lines.push(row('  방향 '+d,summarize(live.filter(t=>t.direction===d))));
 for(const [label,list] of halves(live))lines.push(row(label+' (기간 절반씩)',summarize(list)));
 lines.push('',`신호 흐름: 1H봉 ${hourlyFunnel.bars}개 → 패턴 ${hourlyFunnel.patterns} → 필수조건 통과 ${hourlyFunnel.validated} → 90점 이상 ${hourlyFunnel.scoreOk} → 목표가 계획 성공 ${hourlyFunnel.planned}(점수 무관) · 추격 제외 ${hourlyFunnel.chaseSkipped}`);
 const reasons=Object.entries(hourlyFunnel.planReasons).sort((a,b)=>b[1]-a[1]).slice(0,5);
 if(reasons.length)lines.push('목표가 계획 실패 사유: '+reasons.map(([k,v])=>`${k} ${v}건`).join(', '));
 // 1H split buys (the paper / live rule) against the fixed-risk rule above.
 const sp=all.filter(t=>t.strategy==='HOURLY'&&t.book==='SPLIT');
 if(sp.length){
  const bal=args.balance,pctOf=x=>pct(x/bal*100),s0=summarize(live),s1=summarize(sp);
  lines.push('',`[1-1] 1시간봉 매물대 분할 추매 (잔고 $${bal}, 1단위 ${args.unitPct}% × 점수·시총 배율, 추매 최대 ${args.hourlyMaxAdds}회, 손절은 마지막 추매 바깥)`,'-'.repeat(60));
  lines.push(row('기존: 패턴 손절 $6 위험',s0)+` | 잔고 대비 ${pctOf(s0.netUSD)}`,row('분할 추매',s1)+` | 잔고 대비 ${pctOf(s1.netUSD)}`);
  for(const [k,v] of by({filter:t=>t.strategy==='HOURLY'&&t.book==='SPLIT',key:t=>t.pattern}))lines.push(row('  '+k,summarize(v)));
  for(const [label,list] of halves(sp))lines.push(row(label+' (기간 절반씩)',summarize(list)));
  const worst=Math.min(...sp.map(t=>t.pnlPctOfBalance)),worstOpen=Math.min(...sp.map(t=>t.worstOpenPctOfBalance)),withAdds=sp.filter(t=>t.plannedAdds>0);
  const dist=[0,1,2,3,4,5].map(n=>`${n}${n===5?'회 이상':'회'} ${sp.filter(t=>n===5?t.addsFilled>=5:t.addsFilled===n).length}건`).join(' · ');
  const stops=sp.filter(t=>t.exitReason==='STOP'),avgHold=sp.reduce((s,t)=>s+t.holdMs,0)/sp.length/HOUR;
  lines.push(`최악 거래 잔고 대비 ${pct(worst)} · 보유 중 최대 평가손 잔고 대비 ${pct(worstOpen)} · 손절 ${stops.length}건(평균 ${usd(stops.reduce((s,t)=>s+t.netUSD,0)/(stops.length||1))}) · 평균 보유 ${num(avgHold,1)}시간`,
   `추매 체결 횟수: ${dist}`,
   `분할 계획 ${withAdds.length}건 (매물대 출처 ${Object.entries(hourlyFunnel.split?.sources||{}).map(([k,v])=>`${k} ${v}`).join(', ')||'—'}) · 매물대 없어 패턴 손절 ${sp.length-withAdds.length}건 · 평균 손절 거리 ${pct(withAdds.reduce((s,t)=>s+t.stopDistancePct,0)/(withAdds.length||1))} · 평균 배율 ${num(sp.reduce((s,t)=>s+t.leverage,0)/sp.length,1)}배`,
   '가정: 잔고 고정(복리 없음), 종목별 1포지션, 동시 포지션 절반 축소·롱숏 상한 미반영, 시총은 대략값.');
 }
 lines.push('','[2] 1시간봉 점수 구간별 (90점 기준이 맞는지 판단용, 필수조건 통과 후보를 구간마다 따로 계산)','-'.repeat(60));
 for(const bucket of ['90점 이상','85~89점','80~84점','80점 미만'])lines.push(row(bucket,summarize(all.filter(t=>t.strategy==='HOURLY'&&t.book==='BUCKET:'+bucket))));
 lines.push('','[3] 5분봉 단타 되돌림 (분할 없음, 고정 위험 $6)','-'.repeat(60));
 const fixed=all.filter(t=>t.strategy==='SCALP'&&t.book==='FIXED');
 lines.push(row('전체',summarize(fixed)));
 for(const d of ['LONG','SHORT'])lines.push(row(d==='LONG'?'  급락 후 반등 롱':'  급등 후 되돌림 숏',summarize(fixed.filter(t=>t.direction===d))));
 for(const [label,list] of halves(fixed))lines.push(row(label+' (기간 절반씩)',summarize(list)));
 lines.push(`신호 흐름: 5분봉 ${scalpFunnel.bars}개 → 감지 ${scalpFunnel.signals} → 손익비 미달 제외 ${scalpFunnel.qualityRejected} · 진입 시 무효 ${scalpFunnel.entrySkipped}`);
 lines.push('','[3-1] 단타 시간봉별 비교 (1분봉은 최근 '+args.scalp1mDays+'일만)','-'.repeat(60));
 const byTf=iv=>all.filter(t=>(t.strategy==='SCALP'||t.strategy==='SCALP_TF')&&(t.interval??'5m')===iv);
 for(const iv of ['1m','5m','15m'])for(const book of ['FIXED','DCA'])lines.push(row(`${iv} ${book==='FIXED'?'고정 위험':'매물대 분할'}`,summarize(byTf(iv).filter(t=>t.book===book))));
 lines.push('',`[4] 단타 + 매물대 분할 (교차 ${args.leverage}배, 1단위 잔고 ${args.unitPct}%, 손실 한도 ${args.maxLossPct}%, 시작 잔고 $${args.balance} 종목별)`,'-'.repeat(60));
 const dca=all.filter(t=>t.strategy==='SCALP'&&t.book==='DCA');
 lines.push(row('전체',summarize(dca)));
 for(const d of ['LONG','SHORT'])lines.push(row(d==='LONG'?'  급락 후 반등 롱':'  급등 후 되돌림 숏',summarize(dca.filter(t=>t.direction===d))));
 if(dca.length){
  const worst=Math.min(...dca.map(t=>t.pnlPctOfBalance)),worstOpen=Math.min(...dca.map(t=>t.worstOpenPctOfBalance)),avgAdds=dca.reduce((s,t)=>s+t.addsFilled,0)/dca.length;
  lines.push(`최악 거래 잔고 대비 ${pct(worst)} · 보유 중 최대 평가손 잔고 대비 ${pct(worstOpen)} · 평균 추가 체결 ${num(avgAdds,1)}회 · 최대 추가 ${Math.max(...dca.map(t=>t.addsFilled))}회`);
 }
 lines.push('종목별 최종 잔고: '+Object.entries(finalBalances).map(([s,b])=>`${s} $${b.toFixed(2)}`).join(', '));
 const dr=Object.entries(scalpFunnel.dcaRejected).sort((a,b)=>b[1]-a[1]).slice(0,4);if(dr.length)lines.push('분할 계획 불가 사유: '+dr.map(([k,v])=>`${k} ${v}건`).join(', '));
 if(args.candidates){
  lines.push('','[5] 교과서 전략 후보 (RSI 다이버전스·MACD·볼린저·삼중바닥·삼각형·캔들 반전·이평·거래량, 같은 청산 방식)','-'.repeat(60));
  const mid=startAt+(endAt-startAt)/2;
  for(const name of Object.keys(DETECTORS))for(const book of ['RAW','TREND']){
   const list=all.filter(t=>t.pattern===name&&t.book==='CANDIDATE:'+book);
   const a=summarize(list.filter(t=>t.signalAt<mid)),b=summarize(list.filter(t=>t.signalAt>=mid));
   lines.push(row(`${name}${book==='TREND'?' +4H추세':''}`,summarize(list))+` | 전반 ${usd(a.netUSD)} 후반 ${usd(b.netUSD)}`);
  }
 }
 lines.push('','[주의]','- 과거 결과이며 미래 수익을 보장하지 않습니다. 거래 수가 30건 미만인 구간은 우연일 가능성이 큽니다.',
  '- 펀딩비, 실제 호가 깊이, 거래소별 가격 차이는 반영하지 않았습니다. 체결 가정이 보수적이어도 실제와 다를 수 있습니다.',
  '- 1H 결과는 한 종목에 포지션 1개씩만 연다고 가정했습니다(실제 서버의 동시 포지션 상한은 반영 안 함).');
 return lines.join('\n');
}
function toCSV(trades){
 const cols=['strategy','book','symbol','direction','pattern','score','signalAt','entryAt','exitAt','entryFill','averageEntry','stop','exitReason','tp','addsFilled','netUSD','R','feesUSD','holdMs','pnlPctOfBalance'];
 return '﻿'+cols.join(',')+'\n'+trades.map(t=>cols.map(k=>{let v=t[k]??'';if(/At$/.test(k)&&v)v=new Date(v).toISOString();return '"'+String(v).replaceAll('"','""')+'"'}).join(',')).join('\n');
}

export async function main(argv=process.argv.slice(2)){
 const args=parseArgs(argv);let endAt=Date.now(),startAt=endAt-args.days*86400000;
 console.log(`백테스트 시작: ${args.days}일, ${args.symbols.join(', ')}`);
 OFFLINE=args.offline===true;
 const infoFile=path.join(args.cache,'exchangeInfo.json');let info=null;
 if(OFFLINE){try{info=JSON.parse(fs.readFileSync(infoFile,'utf8'))}catch{}}
 else{info=await getJSON(`${BASE}/fapi/v1/exchangeInfo`);
  try{fs.mkdirSync(args.cache,{recursive:true});fs.writeFileSync(infoFile,JSON.stringify({symbols:info.symbols.filter(s=>args.symbols.includes(s.symbol)).map(s=>({symbol:s.symbol,filters:s.filters}))}))}catch{}}
 const warm4h=320*14400000,warm1h=210*HOUR;
 let btcH4=await klines('BTCUSDT','4h',startAt-warm4h,endAt,args.cache);
 if(OFFLINE){ // the period ends at the last cached candle
  if(!btcH4.length)throw Error('캐시된 캔들이 없습니다 (--offline)');
  endAt=Number(btcH4.at(-1)[6]);startAt=endAt-args.days*86400000;btcH4=btcH4.filter(r=>Number(r[0])>=startAt-warm4h);
 }
 const results=[],hourlyFunnel={bars:0,patterns:0,validated:0,scoreOk:0,planned:0,chaseSkipped:0,planReasons:{}},
  scalpFunnel={bars:0,signals:0,qualityRejected:0,dcaRejected:{},entrySkipped:0},finalBalances={};
 for(const symbol of args.symbols){
  let filters=info?filtersOf(info,symbol):null;
  if(!filters&&OFFLINE){let r=[];try{r=JSON.parse(fs.readFileSync(path.join(args.cache,`${symbol}_1h.json`),'utf8'))}catch{};if(r.length)filters=approxFilters(symbol,r)}
  if(!filters){console.log(`${symbol}: 거래소 목록에 없음, 건너뜀`);continue}
  process.stdout.write(`${symbol}: 캔들 받는 중… `);
  const h4=symbol==='BTCUSDT'?btcH4:await klines(symbol,'4h',startAt-warm4h,endAt,args.cache);
  const h1=await klines(symbol,'1h',startAt-warm1h,endAt,args.cache);
  const m15=await klines(symbol,'15m',startAt-4*86400000,endAt,args.cache);
  const m5=await klines(symbol,'5m',startAt-6*HOUR,endAt,args.cache);
  process.stdout.write(`1H ${h1.length} · 5m ${m5.length} → 계산 중… `);
  const hourly=backtestHourly({symbol,h1,h4,btcH4,m15,m5,filters,startAt,obstacleFraction:args.obstacle,...(args.allPatterns?{patterns:null}:args.patterns?.length?{patterns:args.patterns}:{}),
   split:{balanceUSD:args.balance,unitPct:args.unitPct,maxLossPct:args.maxLossPct,maxAdds:args.hourlyMaxAdds,btcLongFilter:args.btcLongFilter??null,minBoxWidthAtr:args.minBoxWidthAtr??0,maxHoldMs:args.hourlyMaxHoldMs??null,zoneDays:args.zoneDays,marketCap:APPROX_MARKET_CAP[symbol]??1e9}});
  if(hourly.funnel.split){hourlyFunnel.split??={planned:0,fallback:0,sources:{}};hourlyFunnel.split.planned+=hourly.funnel.split.planned;hourlyFunnel.split.fallback+=hourly.funnel.split.fallback;
   for(const [k,v] of Object.entries(hourly.funnel.split.sources))hourlyFunnel.split.sources[k]=(hourlyFunnel.split.sources[k]||0)+v}
  const dcaArgs={leverage:args.leverage,unitPct:args.unitPct,maxLossPct:args.maxLossPct,maxAdds:args.maxAdds,zoneDays:args.zoneDays};
  const scalp=backtestScalp({symbol,m5,m15,h4,trendFilter:args.trendFilter,filters,startAt,balanceUSD:args.balance,dca:dcaArgs});
  // Other scalp timeframes: 15m over the whole period, 1m over the last --scalp-1m-days days (1m data is large).
  const scalp15=backtestScalp({symbol,m5,m15,h4,trendFilter:args.trendFilter,filters,startAt,balanceUSD:args.balance,dca:dcaArgs,interval:'15m',bars:m15}).trades;
  let scalp1=[];
  if(args.scalp1mDays>0){const from=Math.max(startAt,endAt-args.scalp1mDays*86400000),m1=await klines(symbol,'1m',from-2*HOUR,endAt,args.cache);
   scalp1=backtestScalp({symbol,m5,m15,h4,trendFilter:args.trendFilter,filters,startAt:from,balanceUSD:args.balance,dca:dcaArgs,interval:'1m',bars:m1}).trades}
  for(const k of ['bars','patterns','validated','scoreOk','planned','chaseSkipped'])hourlyFunnel[k]+=hourly.funnel[k];
  for(const [k,v] of Object.entries(hourly.funnel.planReasons))hourlyFunnel.planReasons[k]=(hourlyFunnel.planReasons[k]||0)+v;
  for(const k of ['bars','signals','qualityRejected','entrySkipped'])scalpFunnel[k]+=scalp.funnel[k];
  for(const [k,v] of Object.entries(scalp.funnel.dcaRejected))scalpFunnel.dcaRejected[k]=(scalpFunnel.dcaRejected[k]||0)+v;
  finalBalances[symbol]=scalp.finalBalance;
  const cand=args.candidates?backtestCandidates({symbol,h1,h4,m15,m5,filters,startAt}).trades:[];
  results.push({symbol,trades:[...hourly.trades,...scalp.trades,...scalp15.map(t=>({...t,strategy:'SCALP_TF'})),...scalp1.map(t=>({...t,strategy:'SCALP_TF'})),...cand]});
  console.log(`1H 거래 ${hourly.trades.filter(t=>t.book==='LIVE').length} · 단타 ${scalp.trades.filter(t=>t.book==='FIXED').length}`);
 }
 const report=buildReport({args,startAt,endAt,results,hourlyFunnel,scalpFunnel,finalBalances});
 fs.mkdirSync(args.out,{recursive:true});
 fs.writeFileSync(path.join(args.out,'report.txt'),'﻿'+report);
 fs.writeFileSync(path.join(args.out,'trades.csv'),toCSV(results.flatMap(r=>r.trades)));
 fs.writeFileSync(path.join(args.out,'summary.json'),JSON.stringify({args,startAt,endAt,hourlyFunnel,scalpFunnel,finalBalances,
  scalpSettings:SCALP_DEFAULTS,generatedAt:new Date().toISOString()},null,2));
 console.log('\n'+report+`\n\n결과 파일: ${path.resolve(args.out)}`);
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 main().catch(e=>{console.error('백테스트 실패: '+e.message+'\n인터넷 연결과 Binance 접속을 확인하세요.');process.exitCode=1});
}
