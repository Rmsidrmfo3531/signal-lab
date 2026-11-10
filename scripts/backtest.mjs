// Backtest runner for the user's PC: downloads public Binance USDT-M candles (no keys),
// replays the strategies and writes a Korean report.
//   node scripts/backtest.mjs [--days 60] [--symbols BTCUSDT,ETHUSDT,...] [--leverage 10]
// Output: backtest-results/ (report.txt, trades.csv, summary.json). Candles are cached
// in backtest-cache/ so a re-run only downloads what is new.
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {backtestHourly,backtestScalp,summarize,scoreBucket,HOUR} from '../backtest.mjs';
import {SCALP_DEFAULTS} from '../scalp_reversal.mjs';
import {DCA_DEFAULTS} from '../dca_plan.mjs';

const BASE='https://fapi.binance.com';
const INTERVAL_MS={'5m':300000,'15m':900000,'1h':3600000,'4h':14400000};
export const DEFAULT_SYMBOLS=['BTCUSDT','ETHUSDT','SOLUSDT','XRPUSDT','DOGEUSDT','BNBUSDT'];

export function parseArgs(argv){
 const out={obstacle:1,trendFilter:false,days:60,symbols:DEFAULT_SYMBOLS,leverage:DCA_DEFAULTS.leverage,unitPct:DCA_DEFAULTS.unitPct,maxLossPct:DCA_DEFAULTS.maxLossPct,balance:1000,out:'backtest-results',cache:'backtest-cache'};
 for(let i=0;i<argv.length;i++){
  const key=argv[i],value=argv[i+1];
  if(key==='--days'){out.days=Math.max(7,Math.min(365,Number(value)||60));i++}
  else if(key==='--symbols'){out.symbols=String(value||'').toUpperCase().split(',').map(s=>s.trim()).filter(s=>/^[A-Z0-9]{2,20}USDT$/.test(s)).slice(0,20);i++}
  else if(key==='--leverage'){out.leverage=Math.max(10,Math.min(20,Number(value)||10));i++}
  else if(key==='--unit-pct'){out.unitPct=Math.max(.01,Math.min(10,Number(value)||DCA_DEFAULTS.unitPct));i++}
  else if(key==='--max-loss-pct'){out.maxLossPct=Math.max(1,Math.min(95,Number(value)||30));i++}
  else if(key==='--balance'){out.balance=Math.max(10,Number(value)||1000);i++}
  else if(key==='--obstacle'){out.obstacle=Math.max(.1,Math.min(1,Number(value)||1));i++}
  else if(key==='--trend-filter'){out.trendFilter=true}
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
async function klines(symbol,interval,start,end,cacheDir){
 const file=path.join(cacheDir,`${symbol}_${interval}.json`),step=INTERVAL_MS[interval];
 let rows=[];try{rows=JSON.parse(fs.readFileSync(file,'utf8'))}catch{}
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
  `비용 가정: 시장가 수수료 0.06% + 슬리피지 0.02% (진입·청산 매번), 1H·단타 고정 위험 $6/거래`,`TP1 전 매물대 차단 기준: POC의 ${Math.round(args.obstacle*100)}% 이상${args.trendFilter?' · 단타 4H 추세 필터 켬':''}`,
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
 lines.push('','[2] 1시간봉 점수 구간별 (90점 기준이 맞는지 판단용, 필수조건 통과 후보를 구간마다 따로 계산)','-'.repeat(60));
 for(const bucket of ['90점 이상','85~89점','80~84점','80점 미만'])lines.push(row(bucket,summarize(all.filter(t=>t.strategy==='HOURLY'&&t.book==='BUCKET:'+bucket))));
 lines.push('','[3] 5분봉 단타 되돌림 (분할 없음, 고정 위험 $6)','-'.repeat(60));
 const fixed=all.filter(t=>t.strategy==='SCALP'&&t.book==='FIXED');
 lines.push(row('전체',summarize(fixed)));
 for(const d of ['LONG','SHORT'])lines.push(row(d==='LONG'?'  급락 후 반등 롱':'  급등 후 되돌림 숏',summarize(fixed.filter(t=>t.direction===d))));
 for(const [label,list] of halves(fixed))lines.push(row(label+' (기간 절반씩)',summarize(list)));
 lines.push(`신호 흐름: 5분봉 ${scalpFunnel.bars}개 → 감지 ${scalpFunnel.signals} → 손익비 미달 제외 ${scalpFunnel.qualityRejected} · 진입 시 무효 ${scalpFunnel.entrySkipped}`);
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
 const args=parseArgs(argv),endAt=Date.now(),startAt=endAt-args.days*86400000;
 console.log(`백테스트 시작: ${args.days}일, ${args.symbols.join(', ')}`);
 const info=await getJSON(`${BASE}/fapi/v1/exchangeInfo`);
 const warm4h=320*14400000,warm1h=210*HOUR;
 const btcH4=await klines('BTCUSDT','4h',startAt-warm4h,endAt,args.cache);
 const results=[],hourlyFunnel={bars:0,patterns:0,validated:0,scoreOk:0,planned:0,chaseSkipped:0,planReasons:{}},
  scalpFunnel={bars:0,signals:0,qualityRejected:0,dcaRejected:{},entrySkipped:0},finalBalances={};
 for(const symbol of args.symbols){
  const filters=filtersOf(info,symbol);if(!filters){console.log(`${symbol}: 거래소 목록에 없음, 건너뜀`);continue}
  process.stdout.write(`${symbol}: 캔들 받는 중… `);
  const h4=symbol==='BTCUSDT'?btcH4:await klines(symbol,'4h',startAt-warm4h,endAt,args.cache);
  const h1=await klines(symbol,'1h',startAt-warm1h,endAt,args.cache);
  const m15=await klines(symbol,'15m',startAt-4*86400000,endAt,args.cache);
  const m5=await klines(symbol,'5m',startAt-6*HOUR,endAt,args.cache);
  process.stdout.write(`1H ${h1.length} · 5m ${m5.length} → 계산 중… `);
  const hourly=backtestHourly({symbol,h1,h4,btcH4,m15,m5,filters,startAt,obstacleFraction:args.obstacle});
  const scalp=backtestScalp({symbol,m5,m15,h4,trendFilter:args.trendFilter,filters,startAt,balanceUSD:args.balance,dca:{leverage:args.leverage,unitPct:args.unitPct,maxLossPct:args.maxLossPct}});
  for(const k of ['bars','patterns','validated','scoreOk','planned','chaseSkipped'])hourlyFunnel[k]+=hourly.funnel[k];
  for(const [k,v] of Object.entries(hourly.funnel.planReasons))hourlyFunnel.planReasons[k]=(hourlyFunnel.planReasons[k]||0)+v;
  for(const k of ['bars','signals','qualityRejected','entrySkipped'])scalpFunnel[k]+=scalp.funnel[k];
  for(const [k,v] of Object.entries(scalp.funnel.dcaRejected))scalpFunnel.dcaRejected[k]=(scalpFunnel.dcaRejected[k]||0)+v;
  finalBalances[symbol]=scalp.finalBalance;
  results.push({symbol,trades:[...hourly.trades,...scalp.trades]});
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
