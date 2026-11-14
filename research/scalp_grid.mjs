// Reversal-scalp parameter grid (research only, no orders): which settings would have worked, picked on
// the first half of the period and checked on the second half (user 2026-11-14: verify and improve).
//   node research/scalp_grid.mjs <cacheDir> [interval=5m] [out.json]
// cacheDir: the candles scripts/backtest.mjs saved (<SYMBOL>_5m.json, _15m.json, _4h.json, exchangeInfo.json).
// Fixed risk of 6 $ per trade, one position per symbol, round-trip costs as backtest.mjs (taker, slippage, spread).
import fs from 'node:fs';import path from 'node:path';
import {backtestScalp,summarize} from '../backtest.mjs';

const [cache,interval='5m',outFile]=process.argv.slice(2);
if(!cache){console.error('사용법: node research/scalp_grid.mjs <cacheDir> [5m|15m] [out.json]');process.exit(1)}
const read=f=>{try{return JSON.parse(fs.readFileSync(path.join(cache,f),'utf8'))}catch{return null}};
const info=read('exchangeInfo.json');
const filtersOf=symbol=>{const s=info?.symbols?.find(x=>x.symbol===symbol);if(!s)return null;const f=Object.fromEntries(s.filters.map(x=>[x.filterType,x]));
 return {tickSize:Number(f.PRICE_FILTER.tickSize),stepSize:Number(f.LOT_SIZE.stepSize),minQty:Number(f.LOT_SIZE.minQty),minNotional:Number(f.MIN_NOTIONAL?.notional??5)}};
const symbols=fs.readdirSync(cache).filter(f=>f.endsWith(`_${interval}.json`)).map(f=>f.replace(`_${interval}.json`,'')).filter(s=>s!=='BTCUSDT'||true);

// The variants: current settings first, then stop distance, move size, volume climax and targets.
const RETR={'50/61.8/78.6':[.5,.618,.786],'38.2/50/61.8':[.382,.5,.618]};
const variants=[];
for(const stopAtr of [.25,1])for(const move of ['기본','x2'])for(const climaxVolume of [3,6])for(const r of Object.keys(RETR))
 variants.push({name:`손절 ATR ${stopAtr} · 움직임 ${move} · 거래량 ${climaxVolume}배 · 익절 ${r}`,stopAtr,moveMult:move==='x2'?2:1,climaxVolume,retracements:RETR[r]});
const BASE_MOVE={'1m':1.2,'5m':2.5,'15m':4.3}[interval];

// One symbol in memory at a time (a year of 5m candles for 30 symbols at once ran the server out of
// memory, 2026-11-14): the period is read from each file's first and last row, then every variant runs
// symbol by symbol and only the trades are kept.
let first=Infinity,last=0;const usable=[];
for(const symbol of symbols){
 const bars=read(`${symbol}_${interval}.json`);if(!bars?.length||!filtersOf(symbol))continue;
 first=Math.min(first,Number(bars[0][0]));last=Math.max(last,Number(bars.at(-1)[6]));usable.push(symbol);
}
const mid=first+(last-first)/2;
console.log(`# ${interval} 되돌림 그리드: 종목 ${usable.length}개, ${new Date(first).toISOString().slice(0,10)} ~ ${new Date(last).toISOString().slice(0,10)}, 앞 절반에서 고르고 뒤 절반에서 확인`);
const f=x=>x==null||!Number.isFinite(x)?'-':Math.abs(x)>=100?x.toFixed(0):x.toFixed(2);
const line=s=>s.trades?`${String(s.trades).padStart(4)}건 승률 ${f(s.winRatePct)}% PF ${f(s.profitFactor)} 평균 ${f(s.avgR)}R 순손익 ${f(s.netUSD)}$`:'0건';
const trades=variants.map(()=>({train:[],valid:[]}));
for(const symbol of usable){
 const bars=read(`${symbol}_${interval}.json`),m5=interval==='5m'?bars:read(`${symbol}_5m.json`),h4=read(`${symbol}_4h.json`),filters=filtersOf(symbol);
 if(!m5?.length)continue;
 variants.forEach((v,i)=>{
  const settings={stopAtr:v.stopAtr,minMovePct:BASE_MOVE*v.moveMult,climaxVolume:v.climaxVolume,retracements:v.retracements};
  const run=(startAt,endAt)=>backtestScalp({symbol,m5,m15:null,h4,trendFilter:Array.isArray(h4),filters,startAt,endAt,settings,interval,bars,books:['FIXED']}).trades
   .map(t=>({netUSD:t.netUSD,R:t.R,exitAt:t.exitAt,exitReason:t.exitReason,tp:t.tp,holdMs:t.holdMs,direction:t.direction}));
  trades[i].train.push(...run(first,mid));trades[i].valid.push(...run(mid,last));
 });
 console.error(`${symbol} 완료`);
}
const results=variants.map((v,i)=>{const {train,valid}=trades[i];
 const r={...v,train:summarize(train),valid:summarize(valid),
  trainLong:summarize(train.filter(t=>t.direction==='LONG')),trainShort:summarize(train.filter(t=>t.direction==='SHORT')),
  validLong:summarize(valid.filter(t=>t.direction==='LONG')),validShort:summarize(valid.filter(t=>t.direction==='SHORT'))};
 console.log(`${v.name}\n  앞 ${line(r.train)}\n  뒤 ${line(r.valid)}`);return r});
// Picked on the first half only: the best average R with at least 60 trades.
const ok=results.filter(r=>r.train.trades>=60);
const pick=ok.sort((a,b)=>(b.train.avgR??-9)-(a.train.avgR??-9))[0];
if(pick){console.log(`\n# 앞 절반 기준 선택: ${pick.name}\n  뒤 절반(확인) ${line(pick.valid)}\n  뒤 절반 롱 ${line(pick.validLong)}\n  뒤 절반 숏 ${line(pick.validShort)}`)}
if(outFile)fs.writeFileSync(outFile,JSON.stringify({interval,first,last,mid,results,pick:pick?.name??null},null,1));
