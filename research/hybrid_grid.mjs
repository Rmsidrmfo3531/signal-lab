// HYBRID parameter grid (risk per trade x open-risk / daily limit x max open x adds), seeded entry
// order, picked on the train window only. Research only.
//   SEEDS=20 node research/hybrid_grid.mjs <cacheDir> <signals.json> <out.json>
import fs from 'node:fs';import path from 'node:path';import zlib from 'node:zlib';
import {planProfile} from '../dca_plan.mjs';
import {runPortfolio,portfolioMetrics} from '../portfolio_sim.mjs';
const [cache,sigFile,outFile]=process.argv.slice(2),HOUR=3600000,SEEDS=Number(process.env.SEEDS||20);
const {signals}=JSON.parse(fs.readFileSync(sigFile,'utf8'));const candles={};
for(const s of [...new Set(signals.map(x=>x.symbol))])candles[s]=JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(cache,s+'_1h.json.gz')))).map(r=>({t:+r[0],o:+r[1],h:+r[2],l:+r[3],c:+r[4]}));
const W={train:[Date.UTC(2025,11,1),Date.UTC(2026,6,1)],validation:[Date.UTC(2026,6,1),Date.UTC(2026,10,13)],stressAug2026:[Date.UTC(2026,7,1),Date.UTC(2026,8,1)],full:[Date.UTC(2025,11,1),Date.UTC(2026,10,13)]};
const rng=seed=>()=>{seed=(seed*1664525+1013904223)>>>0;return seed/4294967296};
const shuffled=(l,seed)=>{const r=rng(seed),a=[...l];for(let i=a.length-1;i>0;i--){const j=Math.floor(r()*(i+1));[a[i],a[j]]=[a[j],a[i]]}return a};
const pct=(a,p)=>{const b=[...a].sort((x,y)=>x-y);return b[Math.min(b.length-1,Math.floor(p*(b.length-1)+.5))]};
const grid=[];
for(const risk of [1,2,3])for(const openMult of [3,6])for(const maxOpen of [4,8])for(const adds of [3])
 grid.push({name:`위험 ${risk}% · 열린위험 ${risk*openMult}% · 하루 ${risk*openMult}% · 동시 ${maxOpen}`,risk,openRisk:risk*openMult,daily:risk*openMult,maxOpen,adds});
function run(g,[from,to],seed){
 const sigs=shuffled(signals.filter(s=>s.at>=from&&s.at<to),seed+1);
 const cs=Object.fromEntries(Object.entries(candles).map(([k,v])=>[k,v.filter(c=>c.t>=from&&c.t<to+30*86400000)]));
 return portfolioMetrics(runPortfolio({candles:cs,signals:sigs,startBalance:1000,barMs:HOUR,limits:{maxOpen:g.maxOpen,maxPerDirection:g.maxOpen/2,dailyLossPct:g.daily,openRiskPct:g.openRisk},
  plan:(s,acc)=>{const p=planProfile({profile:'HYBRID',direction:s.direction,entry:s.entry,atr:s.atr,zones:s.zones,signalStop:s.stop,leverage:s.leverage,tickSize:s.filters.tickSize,quantityStep:s.filters.stepSize,
   minQuantity:s.filters.minQty,minNotional:s.filters.minNotional,balanceUSD:acc.balance,riskPct:g.risk,maxAdds:g.adds,schedule:'DOUBLE',spacing:'ZONE'});
   if(!p.ok){acc.skip(p.reasons[0]);return null}return {entryRef:s.entry,stop:p.stop,targets:s.targets,quantity:p.entryQty,adds:p.adds,riskUSD:p.fullLossUSD}}}));
}
const out={};
for(const g of grid){out[g.name]={g};for(const [w,r] of Object.entries(W)){const runs=Array.from({length:SEEDS},(_,k)=>run(g,r,k));
 out[g.name][w]={ret:[pct(runs.map(x=>x.returnPct),.1),pct(runs.map(x=>x.returnPct),.5),pct(runs.map(x=>x.returnPct),.9)],mdd:pct(runs.map(x=>x.maxDrawdownPct),.5),mdd90:pct(runs.map(x=>x.maxDrawdownPct),.9),
  worst:pct(runs.map(x=>x.worstTradeUSD),.5),pf:pct(runs.map(x=>x.profitFactor??0),.5),trades:pct(runs.map(x=>x.trades),.5),liq:runs.filter(x=>x.liquidated).length}}
 process.stderr.write('.')}
const pick=Object.keys(out).reduce((b,n)=>out[n].train.ret[1]>out[b].train.ret[1]?n:b,Object.keys(out)[0]);
fs.writeFileSync(outFile,JSON.stringify({seeds:SEEDS,pickedOnTrain:pick,out},null,1));
const f=x=>x.toFixed(1);
console.log('train에서 고른 조합:',pick);
console.log('조합 | train 중앙 | 검증 p10/중앙 | 8월 중앙 | 1년 p10/중앙/p90 | 1년 MDD 중앙/p90 | 최악 1건$ | PF | 거래');
for(const [n,o] of Object.entries(out))console.log([n,f(o.train.ret[1]),`${f(o.validation.ret[0])}/${f(o.validation.ret[1])}`,f(o.stressAug2026.ret[1]),`${f(o.full.ret[0])}/${f(o.full.ret[1])}/${f(o.full.ret[2])}`,`${f(o.full.mdd)}/${f(o.full.mdd90)}`,f(o.full.worst),o.full.pf.toFixed(2),o.full.trades].join(' | '));
