// Stage 4: compare CURRENT / HYBRID variants / TRADER_REPLICA on the same signals and candles,
// one shared account each, over time-ordered train / validation windows and an August 2026 stress window.
//   node research/profile_compare.mjs <cacheDir> <signals.json> <out.json> [startBalance]
// Research only. Execution on 1h candles (conservative in-candle order, see portfolio_sim.mjs).
import fs from 'node:fs';import path from 'node:path';import zlib from 'node:zlib';
import {planProfile} from '../dca_plan.mjs';
import {runPortfolio,portfolioMetrics} from '../portfolio_sim.mjs';

const [cache,sigFile,outFile,bal='1000']=process.argv.slice(2);
const startBalance=Number(bal),HOUR=3600000;
// The server allows LONG only while BTC's 4H trend is up (btcLongBlocked): applied when the signal file has btcTrend.
const signals=JSON.parse(fs.readFileSync(sigFile,'utf8')).signals.filter(s=>!(s.btcTrend!==undefined&&s.direction==='LONG'&&s.btcTrend!=='up'));
const candles={};
for(const s of [...new Set(signals.map(x=>x.symbol))])candles[s]=JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(cache,s+'_1h.json.gz')))).map(r=>({t:Number(r[0]),o:+r[1],h:+r[2],l:+r[3],c:+r[4]}));

const W={
 full:[Date.UTC(2025,11,1),Date.UTC(2026,10,13)],
 train:[Date.UTC(2025,11,1),Date.UTC(2026,6,1)],      // 2025-12 ~ 2026-06 (7 months)
 validation:[Date.UTC(2026,6,1),Date.UTC(2026,10,13)],// 2026-07 ~ 2026-11 (4.4 months)
 stressAug2026:[Date.UTC(2026,7,1),Date.UTC(2026,8,1)]};

const base=s=>({direction:s.direction,entry:s.entry,atr:s.atr,zones:s.zones,signalStop:s.stop,leverage:s.leverage,tickSize:s.filters.tickSize,quantityStep:s.filters.stepSize,
 minQuantity:s.filters.minQty,minNotional:s.filters.minNotional,takerRate:.0006});
const CONFIGS={
 'A CURRENT (30%/7회, 무제한)':{profile:{profile:'CURRENT',maxAdds:7,maxLossPct:30},limits:{dailyLossPct:60,openRiskPct:60}},
 'C HYBRID 1·1·2·4·8 매물대':{profile:{profile:'HYBRID',maxAdds:4,schedule:'DOUBLE',spacing:'ZONE'}},
 ...(process.env.MORE_ADDS?{
 'C HYBRID 추매 5회 매물대':{profile:{profile:'HYBRID',maxAdds:5,schedule:'DOUBLE',spacing:'ZONE'}},
 'C HYBRID 추매 7회 매물대':{profile:{profile:'HYBRID',maxAdds:7,schedule:'DOUBLE',spacing:'ZONE'}},
 'C HYBRID 고정수량 7회 매물대':{profile:{profile:'HYBRID',maxAdds:7,schedule:'FIXED',spacing:'ZONE'}},
 'C HYBRID 완만 7회 매물대':{profile:{profile:'HYBRID',maxAdds:7,schedule:'GENTLE',spacing:'ZONE'}},
 'C HYBRID 추매 7회 위험2%':{profile:{profile:'HYBRID',maxAdds:7,schedule:'DOUBLE',spacing:'ZONE'},riskPct:2},
 'C HYBRID 1·1·2·4 위험2%':{profile:{profile:'HYBRID',maxAdds:3,schedule:'DOUBLE',spacing:'ZONE'},riskPct:2}}:{}),
 'C HYBRID 1·1·2·4 매물대':{profile:{profile:'HYBRID',maxAdds:3,schedule:'DOUBLE',spacing:'ZONE'}},
 'C HYBRID 고정수량 4회 매물대':{profile:{profile:'HYBRID',maxAdds:4,schedule:'FIXED',spacing:'ZONE'}},
 'C HYBRID 완만 4회 매물대':{profile:{profile:'HYBRID',maxAdds:4,schedule:'GENTLE',spacing:'ZONE'}},
 'C HYBRID 1·1·2·4·8 고정2%':{profile:{profile:'HYBRID',maxAdds:4,schedule:'DOUBLE',spacing:'PCT',spacingPct:2}},
 'C HYBRID 1·1·2·4·8 ATR1.5':{profile:{profile:'HYBRID',maxAdds:4,schedule:'DOUBLE',spacing:'ATR',spacingAtr:1.5}},
 'C HYBRID 추매 0회':{profile:{profile:'HYBRID',maxAdds:0}},
 'B TRADER_REPLICA (가정)':{profile:{profile:'TRADER_REPLICA',maxAdds:7},limits:{},replica:true}};
const HYBRID_LIMITS={maxOpen:4,maxPerDirection:2,dailyLossPct:3,openRiskPct:3};

// Signals at the same hour are taken in a shuffled order (seeded), so which one gets the last free
// slot is not decided by the symbol's alphabetical order; every variant runs SEEDS times.
const SEEDS=Number(process.env.SEEDS||30);
const rng=seed=>()=>{seed=(seed*1664525+1013904223)>>>0;return seed/4294967296};
const shuffled=(list,seed)=>{const r=rng(seed),a=[...list];for(let i=a.length-1;i>0;i--){const j=Math.floor(r()*(i+1));[a[i],a[j]]=[a[j],a[i]]}return a};
function run(name,cfg,[from,to],seed=0){
 const sigs=shuffled(signals.filter(s=>s.at>=from&&s.at<to),seed+1);
 const cs=Object.fromEntries(Object.entries(candles).map(([k,v])=>[k,v.filter(c=>c.t>=from&&c.t<to+30*86400000)]));
 const isHybrid=cfg.profile.profile==='HYBRID';
 const r=runPortfolio({candles:cs,signals:sigs,startBalance,barMs:HOUR,limits:isHybrid?HYBRID_LIMITS:{...cfg.limits},
  plan:(s,acc)=>{const p=planProfile({...base(s),...cfg.profile,balanceUSD:acc.balance,riskPct:cfg.riskPct??1});if(!p.ok){acc.skip(p.reasons[0]);return null}
   return {entryRef:s.entry,stop:p.stop,targets:s.targets,quantity:p.entryQty,adds:p.adds,riskUSD:p.fullLossUSD??0,targetsFromAveragePct:p.targetsFromAveragePct??null,
    breakeven:cfg.replica?false:true,meta:{profile:name}}}});
 // Positions still open when the window ends are closed at the last candle (counted).
 return portfolioMetrics(r);
}
const f=x=>x==null?'-':typeof x==='number'?(Math.abs(x)>=100?x.toFixed(0):x.toFixed(2)):String(x);
const results={},dist={};
const pct=(a,p)=>{const b=[...a].sort((x,y)=>x-y);return b[Math.min(b.length-1,Math.floor(p*(b.length-1)+.5))]};
for(const [w,range] of Object.entries(W)){results[w]={};dist[w]={};
 for(const [name,cfg] of Object.entries(CONFIGS)){
  const runs=Array.from({length:SEEDS},(_,k)=>run(name,cfg,range,k));
  results[w][name]=runs[0];
  dist[w][name]={returnPct:{p10:pct(runs.map(r=>r.returnPct),.1),median:pct(runs.map(r=>r.returnPct),.5),p90:pct(runs.map(r=>r.returnPct),.9)},
   profitFactor:{median:pct(runs.map(r=>r.profitFactor??0),.5)},maxDrawdownPct:{median:pct(runs.map(r=>r.maxDrawdownPct),.5),p90:pct(runs.map(r=>r.maxDrawdownPct),.9)},
   trades:{median:pct(runs.map(r=>r.trades),.5)},liquidatedRuns:runs.filter(r=>r.liquidated).length,runs:SEEDS};
  process.stderr.write('.')}}
// Pick on the train window only: the best median return among the HYBRID variants.
const hybrids=Object.keys(CONFIGS).filter(n=>n.startsWith('C '));
const pick=hybrids.reduce((b,n)=>dist.train[n].returnPct.median>dist.train[b].returnPct.median?n:b,hybrids[0]);
fs.writeFileSync(outFile,JSON.stringify({startBalance,windows:W,signals:signals.length,seeds:SEEDS,pickedOnTrain:pick,distribution:dist,results},null,1));
console.log(`# 신호 ${signals.length}개, 변형마다 진입 순서 ${SEEDS}가지. train에서 고른 변형: ${pick}`);
for(const [w,rows] of Object.entries(dist)){console.log(`\n## ${w} 분포 (수익률% p10 / 중앙 / p90 · PF 중앙 · MDD% 중앙 / p90 · 거래 중앙 · 강제청산 횟수)`);for(const [n,d] of Object.entries(rows))console.log([n,`${f(d.returnPct.p10)} / ${f(d.returnPct.median)} / ${f(d.returnPct.p90)}`,f(d.profitFactor.median),`${f(d.maxDrawdownPct.median)} / ${f(d.maxDrawdownPct.p90)}`,d.trades.median,`${d.liquidatedRuns}/${d.runs}`].join(' | '))}
console.log('\n# 아래는 순서 1가지(seed 0)의 상세');
for(const [w,rows] of Object.entries(results)){
 if(w==='full'){console.log('\n## 추매 횟수별 손익 (full)');for(const [n,m] of Object.entries(rows))console.log(n,'|',Object.entries(m.byAdds).sort().map(([k,v])=>`${k}회 ${v.n}건 ${f(v.netUSD)}$`).join(' · '),'| 건너뜀',JSON.stringify(m.skipped))}
 console.log(`\n## ${w}  (시작 잔고 $${startBalance})`);
 console.log('전략 | 거래 | 손익$ | 수익률% | PF | MDD% | 최대미실현$ | 최악거래$ | 거래당$ | 수수료$ | 펀딩$ | 청산');
 for(const [n,m] of Object.entries(rows))console.log([n,m.trades,f(m.netUSD),f(m.returnPct),f(m.profitFactor),f(m.maxDrawdownPct),f(m.worstOpenUSD),f(m.worstTradeUSD),f(m.expectancyUSD),f(m.feesUSD),f(m.fundingUSD),m.liquidated?'강제청산':''].join(' | '));
}
