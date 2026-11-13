// Stage 4: compare CURRENT / HYBRID variants / TRADER_REPLICA on the same signals and candles,
// one shared account each, over time-ordered train / validation windows and an August 2026 stress window.
//   node research/profile_compare.mjs <cacheDir> <signals.json> <out.json> [startBalance]
// Research only. Execution on 1h candles (conservative in-candle order, see portfolio_sim.mjs).
import fs from 'node:fs';import path from 'node:path';import zlib from 'node:zlib';
import {planProfile} from '../dca_plan.mjs';
import {runPortfolio,portfolioMetrics} from '../portfolio_sim.mjs';

const [cache,sigFile,outFile,bal='1000']=process.argv.slice(2);
const startBalance=Number(bal),HOUR=3600000;
const {signals}=JSON.parse(fs.readFileSync(sigFile,'utf8'));
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
 'A CURRENT (30%/7회, 무제한)':{profile:{profile:'CURRENT',maxAdds:7,maxLossPct:30},limits:{dailyLossPct:60}},
 'C HYBRID 1·1·2·4·8 매물대':{profile:{profile:'HYBRID',maxAdds:4,schedule:'DOUBLE',spacing:'ZONE'}},
 'C HYBRID 1·1·2·4 매물대':{profile:{profile:'HYBRID',maxAdds:3,schedule:'DOUBLE',spacing:'ZONE'}},
 'C HYBRID 고정수량 4회 매물대':{profile:{profile:'HYBRID',maxAdds:4,schedule:'FIXED',spacing:'ZONE'}},
 'C HYBRID 완만 4회 매물대':{profile:{profile:'HYBRID',maxAdds:4,schedule:'GENTLE',spacing:'ZONE'}},
 'C HYBRID 1·1·2·4·8 고정2%':{profile:{profile:'HYBRID',maxAdds:4,schedule:'DOUBLE',spacing:'PCT',spacingPct:2}},
 'C HYBRID 1·1·2·4·8 ATR1.5':{profile:{profile:'HYBRID',maxAdds:4,schedule:'DOUBLE',spacing:'ATR',spacingAtr:1.5}},
 'C HYBRID 추매 0회':{profile:{profile:'HYBRID',maxAdds:0}},
 'B TRADER_REPLICA (가정)':{profile:{profile:'TRADER_REPLICA',maxAdds:7},limits:{},replica:true}};
const HYBRID_LIMITS={maxOpen:4,maxPerDirection:2,dailyLossPct:3,openRiskPct:3};

function run(name,cfg,[from,to]){
 const sigs=signals.filter(s=>s.at>=from&&s.at<to);
 const cs=Object.fromEntries(Object.entries(candles).map(([k,v])=>[k,v.filter(c=>c.t>=from&&c.t<to+30*86400000)]));
 const isHybrid=cfg.profile.profile==='HYBRID';
 const r=runPortfolio({candles:cs,signals:sigs,startBalance,barMs:HOUR,limits:isHybrid?HYBRID_LIMITS:{...cfg.limits},
  plan:(s,acc)=>{const p=planProfile({...base(s),...cfg.profile,balanceUSD:acc.balance,riskPct:1});if(!p.ok){acc.skip(p.reasons[0]);return null}
   return {entryRef:s.entry,stop:p.stop,targets:s.targets,quantity:p.entryQty,adds:p.adds,riskUSD:p.fullLossUSD??0,targetsFromAveragePct:p.targetsFromAveragePct??null,
    breakeven:cfg.replica?false:true,meta:{profile:name}}}});
 // Positions still open when the window ends are closed at the last candle (counted).
 return portfolioMetrics(r);
}
const results={};
for(const [w,range] of Object.entries(W)){results[w]={};for(const [name,cfg] of Object.entries(CONFIGS)){results[w][name]=run(name,cfg,range);process.stderr.write('.')}}
fs.writeFileSync(outFile,JSON.stringify({startBalance,windows:W,signals:signals.length,results},null,1));
const f=x=>x==null?'-':typeof x==='number'?(Math.abs(x)>=100?x.toFixed(0):x.toFixed(2)):String(x);
for(const [w,rows] of Object.entries(results)){
 if(w==='full'){console.log('\n## 추매 횟수별 손익 (full)');for(const [n,m] of Object.entries(rows))console.log(n,'|',Object.entries(m.byAdds).sort().map(([k,v])=>`${k}회 ${v.n}건 ${f(v.netUSD)}$`).join(' · '),'| 건너뜀',JSON.stringify(m.skipped))}
 console.log(`\n## ${w}  (시작 잔고 $${startBalance})`);
 console.log('전략 | 거래 | 손익$ | 수익률% | PF | MDD% | 최대미실현$ | 최악거래$ | 거래당$ | 수수료$ | 펀딩$ | 청산');
 for(const [n,m] of Object.entries(rows))console.log([n,m.trades,f(m.netUSD),f(m.returnPct),f(m.profitFactor),f(m.maxDrawdownPct),f(m.worstOpenUSD),f(m.worstTradeUSD),f(m.expectancyUSD),f(m.feesUSD),f(m.fundingUSD),m.liquidated?'강제청산':''].join(' | '));
}
