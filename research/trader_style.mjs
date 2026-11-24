// Copy-trader style study for the TRADER_LADDER scalp management (user 2026-11-24 21:33 "매매의 방식을 카피 트레이더처럼").
// Research only: reads local files, no network, no orders. Results: research/trader_style.md.
//   node research/trader_style.mjs [trader_entries.json] [reports latest.json] [backtest-cache dir]
// Inputs: the channel export (research/data/trader_entries.json: symbol, side, at, entry, lev, adds, holdMin, pnl),
// the copy ledger of the reports repository (latest.json ledgers.copyLive.trades: avg, adds, reduces, open/close times)
// and, for the adverse excursion, the 1H candle cache of the reports repository (backtest-cache/<SYMBOL>_1h.json.gz).
import fs from 'node:fs';import path from 'node:path';import zlib from 'node:zlib';import {pathToFileURL} from 'node:url';

export const quantile=(a,p)=>{const s=a.filter(Number.isFinite).sort((x,y)=>x-y);return s.length?s[Math.min(s.length-1,Math.floor(p*(s.length-1)+.5))]:null};
const r2=x=>Number.isFinite(x)?Math.round(x*100)/100:null;
const count=(list,key)=>list.reduce((m,x)=>{const k=key(x);m[k]=(m[k]||0)+1;return m},{});

/** Channel export: add counts, hold times, and same-entry continuations (a close card followed at once by a new card
 * with the same entry price = a partial close of one position). */
export function exportStats(entries){
 const E=Array.isArray(entries)?entries:[],hold=E.map(e=>Number(e.holdMin));
 const groups={};for(const e of E)(groups[`${e.symbol}|${e.side}|${e.entry}`]??=[]).push(e);
 let continuations=0;
 for(const g of Object.values(groups)){g.sort((a,b)=>a.at-b.at);for(let i=1;i<g.length;i++)if(Math.abs(g[i].at-(g[i-1].at+g[i-1].holdMin*60000))<120000)continuations++}
 const byAdds=k=>E.filter(e=>k==='3+'?e.adds>=3:e.adds===k).map(e=>e.holdMin);
 return {n:E.length,unique:Object.keys(groups).length,adds:count(E,e=>e.adds),upTo5AddsPct:E.length?r2(E.filter(e=>e.adds<=5).length/E.length*100):null,
  hold:{p50:quantile(hold,.5),p75:quantile(hold,.75),p90:quantile(hold,.9),p95:quantile(hold,.95),p99:quantile(hold,.99),max:hold.length?Math.max(...hold):null,
   within24hPct:E.length?r2(hold.filter(h=>h<=1440).length/E.length*100):null},
  holdByAdds:Object.fromEntries([0,1,2,'3+'].map(k=>{const h=byAdds(k);return [k,{n:h.length,p50:quantile(h,.5),p90:quantile(h,.9)}]})),
  continuations};
}

/** Copy ledger closes: adds, partial reductions before the close (full vs partial exit), hold, result. */
export function copyLedgerStats(trades){
 const T=Array.isArray(trades)?trades:[],hold=T.map(t=>(t.closedAt-t.openedAt)/60000);
 const deep=T.filter(t=>t.adds>=3);
 return {n:T.length,adds:count(T,t=>t.adds),withReductions:T.filter(t=>t.reduces>0).length,deepWithReductions:deep.filter(t=>t.reduces>0).length,deep:deep.length,
  closeReasons:count(T,t=>t.closeReason),hold:{p50:r2(quantile(hold,.5)),p90:r2(quantile(hold,.9)),max:hold.length?r2(Math.max(...hold)):null},
  wins:T.filter(t=>t.netUSD>0).length,netUSD:r2(T.reduce((s,t)=>s+(Number(t.netUSD)||0),0))};
}

/** Worst adverse move (% from the first entry) during the hold, from 1H candles: `inner` uses only candles fully inside
 * the hold (no pre-entry or post-exit extremes), `edge` also the first and last candle (an upper bound). */
export function adverseExcursion(e,candles){
 const H=3600000,end=e.at+e.holdMin*60000,s=e.side==='SHORT'?-1:1,adv=x=>s*(x-e.entry)/e.entry*100;
 const bars=candles.filter(b=>b.t+H>e.at&&b.t<=end);if(!bars.length||bars[0].t>e.at)return null;
 const worst=list=>list.length?Math.min(0,...list.map(b=>adv(s>0?b.l:b.h))):0;
 return {inner:-worst(bars.filter(b=>b.t>=e.at&&b.t+H<=end)),edge:-worst(bars)};
}
export function maeStats(entries,cacheDir){
 if(!cacheDir||!fs.existsSync(cacheDir))return null;
 const have=new Set(fs.readdirSync(cacheDir).filter(f=>f.endsWith('_1h.json.gz')).map(f=>f.replace('_1h.json.gz',''))),cache={};
 const load=s=>cache[s]??=JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(cacheDir,s+'_1h.json.gz')))).map(r=>({t:+r[0],h:+r[2],l:+r[3]}));
 const rows=[];for(const e of entries)if(have.has(e.symbol)){const m=adverseExcursion(e,load(e.symbol));if(m)rows.push({adds:e.adds,...m})}
 const g=k=>{const r=rows.filter(x=>k==='3+'?x.adds>=3:x.adds===k),i=r.map(x=>x.inner),d=r.map(x=>x.edge);
  return {n:r.length,innerP50:r2(quantile(i,.5)),innerP90:r2(quantile(i,.9)),innerMax:r.length?r2(Math.max(...i)):null,edgeP90:r2(quantile(d,.9)),edgeMax:r.length?r2(Math.max(...d)):null}};
 return {n:rows.length,byAdds:Object.fromEntries([0,1,2,'3+'].map(k=>[k,g(k)]))};
}

if(import.meta.url===pathToFileURL(process.argv[1]||'').href){
 const [entriesFile='research/data/trader_entries.json',latestFile,cacheDir]=process.argv.slice(2);
 const entries=JSON.parse(fs.readFileSync(entriesFile,'utf8'));
 const out={export:exportStats(entries),mae:maeStats(entries,cacheDir)};
 if(latestFile&&fs.existsSync(latestFile))out.copyLive=copyLedgerStats(JSON.parse(fs.readFileSync(latestFile,'utf8'))?.ledgers?.copyLive?.trades);
 console.log(JSON.stringify(out,null,1));
}
