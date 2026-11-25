// 고래 CVD (user 2026-11-25 09:05 "CVD 관련으로 갈색 고래, 보라 고래, 빨강 고래 등이 뭔지 찾아보고 적용해줘",
// 09:12 "(나) 진행"): Material Indicators FireCharts buckets on Binance aggTrades. The pure bucket / scaling / window-rule
// functions stay here (the window rule is kept as a comparison record). Since 2026-11-25 09:51 the score comes from the
// 고래 매물대 (whale_zones.mjs): the executor, stats, screen and server tests moved to tests/whale_zones.test.mjs.
// Mocks only: no network, no orders, no production data.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
 whaleThresholds,whaleBucketOf,aggTradeSide,parseAggTrades,bucketWhaleCvd,evaluateWhaleCvdBonus,summarizeWhaleCvd,
 fetchWhaleCvd,clearWhaleCvdCache,whaleCvdRecord,whaleCvdSummaryKo,WHALE_CVD_FIXED,WHALE_CVD_CODES,WHALE_CVD_SOURCE_NOTE,
} from '../whale_cvd.mjs';
import {PublicReadBudget} from '../public_read_budget.mjs';

const tr=(id,at,notionalUSD,side,price=100)=>({a:id,p:String(price),q:String(notionalUSD/price),f:id,l:id,T:at,m:side==='SELL'});
const trades=rows=>parseAggTrades(rows.map((r,i)=>tr(i+1,...r)));

test('taker side from m and the FireCharts series (orange $100 / green $1k / red $10k / purple $100k / brown $1M, blue = all)',()=>{
 assert.equal(aggTradeSide({m:true}),'SELL','buyer is maker -> the taker sold');
 assert.equal(aggTradeSide({m:false}),'BUY');
 const F=WHALE_CVD_FIXED;
 assert.deepEqual([99,100,999,1_000,9_999,10_000,99_999,100_000,999_999,1_000_000,2e7].map(v=>whaleBucketOf(v,F)),
  ['dust','orange','orange','green','green','red','red','purple','purple','brown','brown']);
 const t=trades([[1000,500,'BUY'],[1001,5_000,'SELL'],[1002,50_000,'BUY'],[1003,200_000,'BUY'],[1004,2_000_000,'SELL'],[1005,300_000,'BUY'],[1006,50,'SELL'],[5000,999_999,'BUY']]);
 assert.equal(t[0].side,'BUY');assert.equal(t[1].side,'SELL');assert.ok(Math.abs(t[3].notionalUSD-200_000)<1e-6,'notional = price × qty');
 const b=bucketWhaleCvd(t,{startMs:1000,endMs:2000});
 assert.deepEqual(b.buckets.orange,{cvdUSD:500,buyUSD:500,sellUSD:0,count:1});
 assert.deepEqual(b.buckets.green,{cvdUSD:-5000,buyUSD:0,sellUSD:5000,count:1});
 assert.deepEqual(b.buckets.red,{cvdUSD:50000,buyUSD:50000,sellUSD:0,count:1});
 assert.deepEqual(b.buckets.purple,{cvdUSD:500000,buyUSD:500000,sellUSD:0,count:2});
 assert.deepEqual(b.buckets.brown,{cvdUSD:-2000000,buyUSD:0,sellUSD:2000000,count:1});
 assert.deepEqual(b.buckets.blue,{cvdUSD:-1_454_550,buyUSD:550_500,sellUSD:2_005_050,count:7},'blue = all orders, the $50 dust included');
 assert.equal(b.dustCount,1);assert.equal(b.whaleCvdUSD,-1_500_000,'whale = purple + brown');assert.equal(b.shrimpCvdUSD,500);
 assert.equal(b.whaleCount,3);assert.equal(b.totalNotionalUSD,2_555_550);assert.equal(b.trades,7,'the trade outside the window is left out');
 assert.equal(parseAggTrades([{a:1,p:'0',q:'1',T:1},{a:2,p:'x',q:'1',T:1},null]).length,0,'bad rows dropped');
});

test('scaling: fixed MI edges, auto = sqrt(24h volume / BTC) with a $20k purple floor, capped at the MI edges',()=>{
 assert.deepEqual(whaleThresholds({mode:'fixed',quoteVolume24h:1,referenceQuoteVolume24h:100}),{mode:'fixed',source:'FIXED',factor:1,...WHALE_CVD_FIXED});
 const q=whaleThresholds({mode:'auto',quoteVolume24h:2.5e9,referenceQuoteVolume24h:10e9});
 assert.equal(q.factor,0.5);assert.equal(q.purpleMinUSD,50_000);assert.equal(q.redMinUSD,5_000);assert.equal(q.greenMinUSD,500);assert.equal(q.orangeMinUSD,50);assert.equal(q.brownMinUSD,500_000);assert.equal(q.brownMaxUSD,5_000_000);assert.equal(q.source,'VOLUME_SQRT');
 const alt=whaleThresholds({quoteVolume24h:1e6,referenceQuoteVolume24h:10e9});
 assert.equal(alt.factor,0.2);assert.equal(alt.purpleMinUSD,20_000,'never under $20k');assert.equal(alt.redMinUSD,2_000);assert.equal(alt.orangeMinUSD,20);assert.equal(alt.brownMinUSD,200_000);
 assert.equal(whaleThresholds({quoteVolume24h:30e9,referenceQuoteVolume24h:10e9}).purpleMinUSD,100_000,'never above the MI edge');
 const none=whaleThresholds({quoteVolume24h:null,referenceQuoteVolume24h:10e9});
 assert.equal(none.source,'FIXED_NO_VOLUME');assert.equal(none.purpleMinUSD,100_000);
 // The record keeps the MI fixed series too: a $30k print is purple on the scaled edges, red on MI's.
 const snap=summarizeWhaleCvd(trades([[10,30_000,'BUY'],[11,1_000,'SELL']]),{startMs:0,endMs:100,thresholds:alt});
 assert.equal(snap.buckets.purple.cvdUSD,30_000);assert.equal(snap.fixed.buckets.red.cvdUSD,30_000);assert.equal(snap.fixed.whaleCvdUSD,0);
 assert.deepEqual(snap.fixed.thresholds,{...WHALE_CVD_FIXED});assert.equal(snap.sourceNote,WHALE_CVD_SOURCE_NOTE);
});

test('significance |whale| >= max(purple edge, 10 % of the window notional); +5 with / −5 against, LONG and SHORT; 0 otherwise',()=>{
 const S=(rows,thresholds=WHALE_CVD_FIXED)=>summarizeWhaleCvd(trades(rows),{startMs:0,endMs:100,thresholds});
 // Total 10M: 900k whale net buy is under 10 % (1M) -> 0.
 const weak=S([[1,900_000,'BUY'],[2,4_550_000,'SELL'],[3,4_550_000,'BUY']].map(([t,v,s])=>[t,v,s]));
 // 4.55M prints are brown both ways: whale = +900k + 4.55M − 4.55M = +900k.
 assert.equal(weak.whaleCvdUSD,900_000);
 const w=evaluateWhaleCvdBonus(weak,'LONG');assert.equal(w.bonus,0);assert.equal(w.code,WHALE_CVD_CODES.WEAK);assert.equal(w.thresholdUSD,1_000_000);
 const strongBuy=S([[1,1_100_000,'BUY'],[2,4_450_000,'SELL'],[3,4_450_000,'BUY']]);
 assert.equal(evaluateWhaleCvdBonus(strongBuy,'LONG').bonus,5);assert.equal(evaluateWhaleCvdBonus(strongBuy,'LONG').code,WHALE_CVD_CODES.WITH);
 assert.equal(evaluateWhaleCvdBonus(strongBuy,'SHORT').bonus,-5);assert.equal(evaluateWhaleCvdBonus(strongBuy,'SHORT').code,WHALE_CVD_CODES.AGAINST);
 const strongSell=S([[1,1_100_000,'SELL'],[2,4_450_000,'SELL'],[3,4_450_000,'BUY']]);
 assert.equal(evaluateWhaleCvdBonus(strongSell,'SHORT').bonus,5);assert.equal(evaluateWhaleCvdBonus(strongSell,'LONG').bonus,-5);
 // The floor: one $100k whale buy in a thin window is enough (max(100k, 10 % of 150k)); $20k scaled edge for an alt.
 assert.equal(evaluateWhaleCvdBonus(S([[1,100_000,'BUY'],[2,50_000,'SELL']]),'LONG').bonus,5);
 const alt=whaleThresholds({quoteVolume24h:1e6,referenceQuoteVolume24h:10e9});
 const altSnap=S([[1,25_000,'BUY'],[2,5_000,'SELL'],[3,3_000,'SELL']],alt);
 const altEv=evaluateWhaleCvdBonus(altSnap,'LONG');assert.equal(altEv.bonus,5);assert.equal(altEv.thresholdUSD,20_000);
 assert.equal(evaluateWhaleCvdBonus(S([[1,15_000,'BUY'],[2,5_000,'SELL']],alt),'LONG').code,WHALE_CVD_CODES.NO_PRINTS,'a $15k print is no whale even scaled');
 // No whale prints at all -> 0; the shrimp (orange) / whale divergence is recorded, not required, no points.
 const none=evaluateWhaleCvdBonus(S([[1,5_000,'BUY'],[2,50_000,'SELL']]),'LONG');assert.equal(none.bonus,0);assert.equal(none.code,WHALE_CVD_CODES.NO_PRINTS);
 const accRows=[[1,300_000,'BUY'],[2,900,'SELL'],[3,800,'SELL'],[4,9_000,'BUY']];
 const acc=evaluateWhaleCvdBonus(S(accRows),'LONG');
 assert.equal(acc.bonus,5);assert.equal(acc.divergence,'ACCUMULATION');assert.equal(acc.shrimpDivergence,true);assert.equal(acc.shrimpCvdUSD,-1700);
 const accShort=evaluateWhaleCvdBonus(S(accRows),'SHORT');assert.equal(accShort.bonus,-5);assert.equal(accShort.shrimpDivergence,false,'whale against the trade: no flag');
 const noDiv=evaluateWhaleCvdBonus(S([[1,300_000,'BUY'],[2,900,'BUY'],[3,9_000,'SELL']]),'LONG');
 assert.equal(noDiv.bonus,5,'+5 without a shrimp divergence');assert.equal(noDiv.divergence,null);assert.equal(noDiv.shrimpDivergence,false);
 const dist=evaluateWhaleCvdBonus(S([[1,300_000,'SELL'],[2,900,'BUY']]),'SHORT');assert.equal(dist.divergence,'DISTRIBUTION');assert.equal(dist.shrimpDivergence,true);assert.equal(dist.bonus,5);
 // Bonus capped at 5; 0 = record only.
 assert.equal(evaluateWhaleCvdBonus(strongBuy,'LONG',{bonus:9}).bonus,5);assert.equal(evaluateWhaleCvdBonus(strongBuy,'LONG',{bonus:0}).bonus,0);
 // Unavailable data -> 0 with WHALE_CVD_UNAVAILABLE.
 for(const s of [null,{ok:false,error:'HTTP 451'}]){const e=evaluateWhaleCvdBonus(s,'LONG');assert.equal(e.bonus,0);assert.equal(e.code,WHALE_CVD_CODES.UNAVAILABLE)}
 // The record: bucket CVDs and counts, window, thresholds, both edge sets, bonus.
 const rec=whaleCvdRecord(S(accRows),acc);
 assert.equal(rec.bonus,5);assert.equal(rec.buckets.purple.cvdUSD,300_000);assert.equal(rec.buckets.orange.count,2);assert.equal(rec.buckets.green.cvdUSD,9_000);
 assert.deepEqual(Object.keys(rec.buckets),['orange','green','red','purple','brown','blue'],'all six series');assert.equal(rec.buckets.blue.cvdUSD,307_300);
 assert.equal(rec.window.minutes,0);assert.equal(rec.thresholds.purpleMinUSD,100_000);assert.equal(rec.thresholds.orangeMinUSD,100);assert.equal(rec.fixed.whaleCvdUSD,300_000);
 assert.equal(rec.divergence,'ACCUMULATION');assert.equal(rec.shrimpDivergence,true);
 assert.equal(whaleCvdSummaryKo(rec),'고래CVD +5 (보라 +$300K · 갈색 고래 $0 · 주황 새우 −$1.7K · 새우 매도·고래 매수)');
 assert.equal(whaleCvdSummaryKo(whaleCvdRecord({ok:false,error:'x'},evaluateWhaleCvdBonus(null,'LONG'))),'고래CVD 0 (자료 없음)');
});

// A fake Binance aggTrades history (ids 1..N, one trade a second ending at `end`) behind the real PublicReadBudget.
function fakeBinance({n=5000,end=10_000_000,fail=null,budget=new PublicReadBudget({now:()=>end})}={}){
 const routes=[];
 const all=Array.from({length:n},(_,i)=>({a:i+1,p:'100',q:i%50===0?'2000':'1',f:i+1,l:i+1,T:end-(n-1-i)*1000,m:i%2===0}));
 const request=async route=>{
  routes.push(route);
  const r=budget.reserve(route);if(!r.ok)throw Error(r.code);
  if(fail&&fail(routes.length))throw Error('Binance HTTP 503: 공개 조회 일시 보류');
  const u=new URL(route,'https://fapi.binance.com'),limit=Number(u.searchParams.get('limit')),from=u.searchParams.get('fromId');
  return from==null?all.slice(-limit):all.filter(t=>t.a>=Number(from)).slice(0,limit);
 };
 return {request,routes,budget,end,all};
}

test('fetch: newest first by fromId, from the move start, bounded pages; budget respected; failures never throw',async()=>{
 clearWhaleCvdCache();
 let f=fakeBinance();
 // Window of 30 min = 1,800 trades: 2 pages of 1000 cover it.
 let s=await fetchWhaleCvd('SOLUSDT',{request:f.request,budget:()=>f.budget.snapshot(),startMs:f.end-1800_000,endMs:f.end,now:()=>f.end});
 assert.equal(s.ok,true);assert.equal(s.pages,2);assert.equal(s.complete,true);assert.equal(s.weight,40);
 assert.match(f.routes[0],/^\/fapi\/v1\/aggTrades\?symbol=SOLUSDT&limit=1000$/);assert.match(f.routes[1],/&fromId=3001$/,"ids 3001..4000 before the first page 4001..5000");
 assert.equal(s.trades,1801,'trades in [start, end] only, each once');assert.equal(f.budget.snapshot().usedWeight,40);
 // The window is capped at 30 min even when the move started earlier; the page cap bounds the reads.
 clearWhaleCvdCache();f=fakeBinance();
 s=await fetchWhaleCvd('SOLUSDT',{request:f.request,startMs:f.end-3*3600_000,endMs:f.end,now:()=>f.end,maxPages:1});
 assert.equal(s.windowMin,30);assert.equal(f.routes.length,1);assert.equal(s.complete,false);assert.ok(s.coveragePct<60&&s.coveragePct>50,String(s.coveragePct));
 // Cached for 30 s: the same candidate does not read again.
 await fetchWhaleCvd('SOLUSDT',{request:f.request,startMs:f.end-3*3600_000,endMs:f.end,now:()=>f.end+1000,maxPages:1});assert.equal(f.routes.length,1);
 // Budget: stops before going above 60 % of the per-minute weight; a full budget or a cooldown reads nothing.
 clearWhaleCvdCache();f=fakeBinance({budget:new PublicReadBudget({now:()=>10_000_000,maxWeight:100})});
 s=await fetchWhaleCvd('SOLUSDT',{request:f.request,budget:()=>f.budget.snapshot(),startMs:f.end-1800_000,endMs:f.end,now:()=>f.end,maxPages:5,pageLimit:500}); // 4 pages of 500 would be needed
 assert.equal(f.routes.length,3,'3 × 20 = 60 = 60 % of 100');assert.equal(s.stopped,'BUDGET');assert.equal(s.complete,false);assert.ok(f.budget.snapshot().usedWeight<=60);
 clearWhaleCvdCache();f=fakeBinance();for(let i=0;i<54;i++)f.budget.reserve('/fapi/v1/aggTrades');
 s=await fetchWhaleCvd('SOLUSDT',{request:f.request,budget:()=>f.budget.snapshot(),startMs:f.end-600_000,endMs:f.end,now:()=>f.end});
 assert.equal(s.ok,false);assert.equal(s.error,'BUDGET');assert.equal(f.routes.length,0,'no request once the budget is used');
 clearWhaleCvdCache();f=fakeBinance();f.budget.rateLimited(429,120);
 s=await fetchWhaleCvd('SOLUSDT',{request:f.request,budget:()=>f.budget.snapshot(),startMs:f.end-600_000,endMs:f.end,now:()=>f.end});
 assert.equal(s.ok,false);assert.equal(f.routes.length,0,'no request in a 429 cooldown');
 // A first-page failure -> ok:false (no throw); a later one keeps what was read.
 clearWhaleCvdCache();f=fakeBinance({fail:k=>k===1});
 s=await fetchWhaleCvd('SOLUSDT',{request:f.request,startMs:f.end-600_000,endMs:f.end,now:()=>f.end});
 assert.equal(s.ok,false);assert.match(s.error,/503/);
 clearWhaleCvdCache();f=fakeBinance({fail:k=>k===2});
 s=await fetchWhaleCvd('SOLUSDT',{request:f.request,startMs:f.end-1800_000,endMs:f.end,now:()=>f.end});
 assert.equal(s.ok,true);assert.equal(s.pages,1);assert.equal(s.complete,false);
 assert.equal((await fetchWhaleCvd('SOLUSDT',{request:null})).ok,false);assert.equal((await fetchWhaleCvd('bad sym!',{request:f.request})).error,'BAD_SYMBOL');
});

test('deadline: no new aggTrades page after the executor’s 4 s wait (no background paging on shared weight)',async()=>{
 clearWhaleCvdCache();
 // 6,000 trades, a window needing 6 pages; each page takes 1.5 s on a fake clock.
 let clock=0;const f=fakeBinance({n:6000,budget:new PublicReadBudget({now:()=>clock})});
 const slow=async route=>{const rows=await f.request(route);clock+=1500;return rows};
 const s=await fetchWhaleCvd('SOLUSDT',{request:slow,budget:()=>f.budget.snapshot(),startMs:f.end-5999_000,endMs:f.end,now:()=>clock,maxPages:10,maxWindowMs:2*3600_000});
 assert.equal(f.routes.length,3,'pages at 0 / 1.5 / 3.0 s; none at 4.5 s');assert.equal(s.stopped,'DEADLINE');assert.equal(s.complete,false);assert.equal(s.ok,true);
 assert.equal(f.budget.snapshot().usedWeight,60);
 // A fast read is not cut (the deadline only stops slow paging).
 clearWhaleCvdCache();clock=0;const g=fakeBinance({n:6000,budget:new PublicReadBudget({now:()=>clock})});
 const t=await fetchWhaleCvd('SOLUSDT',{request:g.request,budget:()=>g.budget.snapshot(),startMs:g.end-5999_000,endMs:g.end,now:()=>clock,maxPages:10,maxWindowMs:2*3600_000});
 assert.equal(t.complete,true);assert.equal(t.stopped,undefined);assert.equal(g.routes.length,6);
});
