// Per-pattern results of the testnet rule (HYBRID, GROWTH limits) with the live BTC long filter.
//   node research/pattern_stats.mjs <cacheDir> <signals.json> [riskPct] [openRiskPct] [maxOpen]
import fs from 'node:fs';import path from 'node:path';import zlib from 'node:zlib';
import {planProfile} from '../dca_plan.mjs';
import {runPortfolio} from '../portfolio_sim.mjs';
const [cache,sigFile,risk='3',open='9',maxOpen='8']=process.argv.slice(2),HOUR=3600000,SEEDS=Number(process.env.SEEDS||10);
const all=JSON.parse(fs.readFileSync(sigFile,'utf8')).signals;
const drop=(process.env.DROP||'').split('|').filter(Boolean);
const signals=all.filter(s=>!(s.direction==='LONG'&&s.btcTrend!=='up')&&!drop.includes(s.pattern));
const candles={};for(const s of [...new Set(signals.map(x=>x.symbol))])candles[s]=JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(cache,s+'_1h.json.gz')))).map(r=>({t:+r[0],o:+r[1],h:+r[2],l:+r[3],c:+r[4]}));
const rng=seed=>()=>{seed=(seed*1664525+1013904223)>>>0;return seed/4294967296};
const shuffled=(l,seed)=>{const r=rng(seed),a=[...l];for(let i=a.length-1;i>0;i--){const j=Math.floor(r()*(i+1));[a[i],a[j]]=[a[j],a[i]]}return a};
const by={},tot=[];
for(let k=0;k<SEEDS;k++){
 const r=runPortfolio({candles,signals:shuffled(signals,k+1),startBalance:1000,barMs:HOUR,limits:{maxOpen:+maxOpen,maxPerDirection:+maxOpen/2,dailyLossPct:+open,openRiskPct:+open},
  plan:(s,acc)=>{const p=planProfile({profile:'HYBRID',direction:s.direction,entry:s.entry,atr:s.atr,zones:s.zones,signalStop:s.stop,leverage:s.leverage,tickSize:s.filters.tickSize,quantityStep:s.filters.stepSize,
   minQuantity:s.filters.minQty,minNotional:s.filters.minNotional,balanceUSD:acc.balance,riskPct:+risk,maxAdds:3,schedule:'DOUBLE',spacing:'ZONE'});
   if(!p.ok){acc.skip(p.reasons[0]);return null}return {entryRef:s.entry,stop:p.stop,targets:s.targets,quantity:p.entryQty,adds:p.adds,riskUSD:p.fullLossUSD}}});
 tot.push((r.finalBalance/1000-1)*100);
 for(const t of r.trades){const key=t.meta.pattern;(by[key]??={n:0,net:0,win:0,hold:[]});by[key].n++;by[key].net+=t.netUSD;if(t.netUSD>0)by[key].win++;by[key].hold.push((t.exitAt-t.openAt)/HOUR)}
}
const med=a=>{const b=[...a].sort((x,y)=>x-y);return b[Math.floor(b.length/2)]};
console.log(`BTC 롱 필터 적용 신호 ${signals.length}개 (전체 ${all.length}) · 위험 ${risk}% · 열린위험 ${open}% · 동시 ${maxOpen} · 순서 ${SEEDS}가지`);
console.log('1년 수익률 중앙',med(tot).toFixed(1)+'%','범위',Math.min(...tot).toFixed(1),'~',Math.max(...tot).toFixed(1));
console.log('패턴 | 거래/회 | 손익$/회 | 승률 | 거래당$ | 보유시간 중앙(h)');
for(const [p,v] of Object.entries(by).sort((a,b)=>b[1].net-a[1].net))console.log([p,(v.n/SEEDS).toFixed(0),(v.net/SEEDS).toFixed(0),(v.win/v.n*100).toFixed(0)+'%',(v.net/v.n).toFixed(2),med(v.hold).toFixed(1)].join(' | '));
