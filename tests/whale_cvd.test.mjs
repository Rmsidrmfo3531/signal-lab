// 고래 CVD (user 2026-11-25 09:05 "CVD 관련으로 갈색 고래, 보라 고래, 빨강 고래 등이 뭔지 찾아보고 적용해줘",
// 09:12 "(나) 진행"): Material Indicators FireCharts buckets on Binance aggTrades, ±5 on the scalp score.
// Mocks only: no network, no orders, no production data.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
 whaleThresholds,whaleBucketOf,aggTradeSide,parseAggTrades,bucketWhaleCvd,evaluateWhaleCvdBonus,summarizeWhaleCvd,
 fetchWhaleCvd,clearWhaleCvdCache,whaleCvdRecord,whaleCvdSummaryKo,WHALE_CVD_FIXED,WHALE_CVD_CODES,WHALE_CVD_SOURCE_NOTE,
} from '../whale_cvd.mjs';
import {PublicReadBudget} from '../public_read_budget.mjs';
import {ScalpExecutor,scalpExecConfig} from '../scalp_executor.mjs';
import {detectScalpReversal} from '../scalp_reversal.mjs';
import {summarizeJournal} from '../scalp_journal.mjs';
import {scalpEventText} from '../scalp_telegram.mjs';
import {reasonInfo,SCORE_ITEMS,scoreItemsHTML,skipRowHTML,reasonGlossaryHTML} from '../public/scalp_reasons.js';

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

// ---- Executor integration (as tests/scalp_score.test.mjs: mocked BingX testnet client) ----
const I=300000,BUCKET=Math.floor(Date.parse('2026-11-22T03:00:00Z')/I),T0=BUCKET*I+5000;
function crash({move=6,volume=10,lastOpen=(BUCKET-1)*I,wick=.8}={}){
 const rows=[];let p=100;const push=(o,h,l,c,v)=>rows.push([0,o,h,l,c,v]);
 for(let i=0;i<50;i++){const o=p,c=p+(i%2?.05:-.05);push(o,Math.max(o,c)+.1,Math.min(o,c)-.1,c,100);p=c}
 for(let i=0;i<4;i++){const o=p,c=p-move/4;push(o,o+.05,c-.1,c,100*volume*(i===3?1:.5));p=c}
 push(p,p+.15,p-wick,p+.1,80*volume);
 return rows.map((r,i)=>{const t=lastOpen-(rows.length-1-i)*I;return [t,...r.slice(1,6).map(String),t+I-1,String(r[5]*r[4])]});
}
const up4h=now=>Array.from({length:301},(_,i)=>{const t=now-(301-i)*4*3600000-1000,c=50+i*.1;return [t,String(c),String(c+.2),String(c-.2),String(c),'1000',t+4*3600000-1,'1']});
const down4h=now=>up4h(now).map((r,i)=>{const c=200-i*.1;return [r[0],String(c),String(c+.2),String(c-.2),String(c),'1000',r[6],'1']});
const ENTRY=Number(crash().at(-1)[4]),PX=+(ENTRY+.02).toFixed(2);
const SOL={symbol:'SOLUSDT',venueSymbol:'SOL-USDT',tickSize:'0.01',quantityStep:'0.01',minQuantityBase:'0.01',minNotionalUSDT:2,tradable:true};
const BTC={symbol:'BTCUSDT',venueSymbol:'BTC-USDT',tickSize:'0.1',quantityStep:'0.001',minQuantityBase:'0.001',minNotionalUSDT:5,tradable:true};
function mockVenue(fillAt=PX){
 let amt=0,avg=0,id=1;const calls=[];
 const client={mode:'TESTNET',
  positionMode:async()=>({dualSidePosition:false}),marginType:async()=>({marginType:'CROSSED'}),setMarginType:async()=>({}),
  leverage:async()=>({maxLongLeverage:20,maxShortLeverage:20}),setLeverage:async(s,side,l)=>({leverage:l}),
  positions:async()=>amt!==0?[{symbol:'SOL-USDT',positionSide:'BOTH',positionAmt:String(amt),avgPrice:String(avg),markPrice:String(avg),unrealizedProfit:'0'}]:[],
  openOrders:async()=>({orders:[]}),getOrder:async()=>({order:null}),cancelOrder:async()=>({}),
  placeOrder:async(p)=>{calls.push(p);const q=Number(p.quantity);
   if(p.type==='LIMIT'&&p.timeInForce==='PostOnly'){const px=Number(p.price)||fillAt;avg=px;amt=p.side==='SELL'?-q:q;return {order:{orderId:String(id++),status:'FILLED',executedQty:String(q),avgPrice:String(px)}}}
   if(p.type==='MARKET'){avg=fillAt;amt=p.side==='SELL'?-q:q;return {order:{orderId:String(id++),status:'FILLED',executedQty:String(q),avgPrice:String(avg)}}}
   return {order:{orderId:String(id++),status:'NEW'}}}};
 return {client,calls};
}
// The whale snapshot a candidate sees: net whale buying of `whale` USD in a $2M window (|whale| >= 10 % = $200k is significant).
const whaleSnap=whale=>summarizeWhaleCvd(trades([[T0-60_000,Math.abs(whale),whale>=0?'BUY':'SELL'],[T0-50_000,1_000_000-Math.abs(whale)/2,'BUY'],[T0-40_000,1_000_000-Math.abs(whale)/2,'SELL']]),{symbol:'SOLUSDT',startMs:T0-1800_000,endMs:T0,thresholds:WHALE_CVD_FIXED});
function scalp({minScore,whaleCvd,orderflow=null,trend=up4h,rows=crash(),px=PX}){
 const v=mockVenue(px);
 const ex=new ScalpExecutor({config:{...scalpExecConfig({}),management:'CURRENT',minScore,stopLossEnabled:false},client:v.client,
  contracts:async()=>new Map([['SOLUSDT',SOL],['BTCUSDT',BTC]]),
  tickers:async()=>[{symbol:'SOL-USDT',quoteVolume:'90000000'},{symbol:'BTC-USDT',quoteVolume:'500000000'}],
  candles:async(s,iv)=>iv==='5m'?(s==='SOLUSDT'?[...rows,[BUCKET*I,'100','100','100','100','1',BUCKET*I+I-1,'1']]:[]):trend(T0),
  ...(whaleCvd?{whaleCvd}:{}),...(orderflow?{orderflow}:{}),
  priceOf:async()=>px,markOf:async()=>px,balance:async()=>({equity:10000,available:9000}),now:()=>T0});
 ex.arm();return {ex,v};
}
async function baseScore(trend=up4h){
 const {ex}=scalp({minScore:1,trend});const st=await ex.scan();assert.equal(st.entered,1);return ex.store.open[0].scalpScore.score;
}

test('gate: gate−1 +5 passes, gate+2 −5 fails; the window starts at the move start; a fetch failure gives 0 and never blocks',async()=>{
 const base=await baseScore();
 assert.ok(base>20&&base<90,String(base));
 // base = gate − 1 (as 69 vs 70) + whale with the LONG -> enters at gate + 4.
 let seen=null;
 let {ex}=scalp({minScore:base+1,whaleCvd:async(sym,o)=>{seen={sym,...o};return whaleSnap(400_000)}});
 assert.equal((await ex.scan()).entered,1,'69 + 5 passes');
 const sc=ex.store.open[0].scalpScore;
 assert.equal(sc.score,base+5);assert.equal(sc.whaleBonus,5);assert.equal(sc.whaleCvd.code,WHALE_CVD_CODES.WITH);
 assert.equal(sc.whaleCvd.buckets.purple.cvdUSD,400_000);assert.equal(sc.whaleCvd.thresholds.purpleMinUSD,100_000);
 const det=detectScalpReversal(crash(),{symbol:'SOLUSDT',now:T0});
 assert.equal(seen.sym,'SOLUSDT');assert.equal(seen.direction,'LONG');assert.equal(seen.endMs,T0);
 assert.equal(seen.startMs,Math.max(T0-1800_000,det.evidence.originAt),'from the move start, at most 30 min');assert.equal(seen.scale,'auto');assert.equal(seen.maxPages,5);
 const opened=ex.store.events.find(e=>e.type==='OPENED');
 assert.equal(opened.whaleBonus,5);assert.match(opened.whaleSummary,/^고래CVD \+5 \(보라 \+\$400K/);
 assert.match(scalpEventText(opened),/고래CVD \+5 \(보라/);
 // base = gate + 2 (as 72 vs 70) − whale against the LONG -> skipped at gate − 3, recorded on the skip.
 ({ex}=scalp({minScore:base-2,whaleCvd:async()=>whaleSnap(-400_000)}));
 assert.equal((await ex.scan()).entered,0,'72 − 5 fails');
 const sk=ex.store.skips.at(-1);
 assert.equal(sk.reason,'SCORE_BELOW_MINIMUM');assert.equal(sk.score,base-5);assert.equal(sk.whaleBonus,-5);assert.equal(sk.whaleCvd.code,WHALE_CVD_CODES.AGAINST);
 assert.match(sk.detail,/고래CVD-5/);
 // Not significant -> 0, enters on its own score.
 ({ex}=scalp({minScore:base,whaleCvd:async()=>whaleSnap(150_000)}));
 assert.equal((await ex.scan()).entered,1);assert.equal(ex.store.open[0].scalpScore.score,base);assert.equal(ex.store.open[0].scalpScore.whaleCvd.code,WHALE_CVD_CODES.WEAK);
 // Failure (throw / ok:false) -> 0, WHALE_CVD_UNAVAILABLE, the entry goes on.
 for(const whaleCvd of [async()=>{throw Error('Binance HTTP 503')},async()=>({ok:false,error:'NOT_ON_BINANCE'})]){
  ({ex}=scalp({minScore:base,whaleCvd}));
  assert.equal((await ex.scan()).entered,1,'never blocks');
  const w=ex.store.open[0].scalpScore;assert.equal(w.score,base);assert.equal(w.whaleBonus,0);assert.equal(w.whaleCvd.code,WHALE_CVD_CODES.UNAVAILABLE);
 }
 // SCALP_WHALE_CVD=off: no read, no record.
 let called=0;
 ({ex}=scalp({minScore:base,whaleCvd:async()=>{called++;return whaleSnap(400_000)}}));ex.config={...ex.config,whaleCvd:false};
 assert.equal((await ex.scan()).entered,1);assert.equal(called,0);assert.equal(ex.store.open[0].scalpScore.whaleCvd,undefined);
});

test('the orderflow / whale read covers every candidate a +5 (with OI + CVD, 15 in all) could lift, and those at the gate',async()=>{
 // Coin and BTC 4H trend against the LONG: a base far enough under 100 for gate = base + 15.
 const base=await baseScore(down4h);assert.ok(base+16<=100,String(base));
 for(const [minScore,want] of [[base+15,1],[base+16,0],[base-3,1]]){
  let whale=0,of=0;
  const {ex}=scalp({minScore,trend:down4h,whaleCvd:async()=>{whale++;return {ok:false,error:'x'}},orderflow:async()=>{of++;return null}});
  await ex.scan();
  assert.equal(whale,want,`whale read at gate ${minScore} (base ${base})`);assert.equal(of,want,`orderflow read at gate ${minScore}`);
 }
 // A +5 from 15 under the gate does not pass alone; with OI + CVD (+10) it does (clamped total).
 const of={ok:true,source:'BINANCE',funding:{ratePct:0},oi:{change30mPct:-2},cvd:{lastDeltaNorm:0.3}};
 const {ex}=scalp({minScore:base+15,trend:down4h,whaleCvd:async()=>whaleSnap(400_000),orderflow:async()=>of});
 assert.equal((await ex.scan()).entered,1,JSON.stringify(ex.store.skips.at(-1)));
 const sc=ex.store.open[0].scalpScore;assert.equal(sc.score,base+15);assert.equal(sc.oiBonus,5);assert.equal(sc.cvdBonus,5);assert.equal(sc.whaleBonus,5);
});

test('settings, byWhaleCvd stats split (+5 / 0 / −5, before apart) and the journal summary',()=>{
 const c=scalpExecConfig({});
 assert.equal(c.whaleCvd,true);assert.equal(c.whaleCvdBonus,5);assert.equal(c.whaleCvdMinSharePct,10);assert.equal(c.whaleCvdScale,'auto');assert.equal(c.whaleCvdMaxPages,5);
 assert.equal(scalpExecConfig({SCALP_WHALE_CVD_BONUS:'9'}).whaleCvdBonus,5,'never more than ±5');
 assert.equal(scalpExecConfig({SCALP_WHALE_CVD_MIN_SHARE_PCT:'3'}).whaleCvdMinSharePct,10,'the 10 % significance is not relaxed');
 assert.equal(scalpExecConfig({SCALP_WHALE_CVD_SCALE:'fixed'}).whaleCvdScale,'fixed');assert.equal(scalpExecConfig({SCALP_WHALE_CVD:'off'}).whaleCvd,false);
 const ex=new ScalpExecutor({config:scalpExecConfig({}),now:()=>T0});
 const row=(net,bonus)=>({id:'x'+Math.random(),direction:'LONG',netUSD:net,closedAt:T0,closeReason:'ALL_TARGETS',...(bonus===undefined?{}:{scalpScore:{score:75,whaleBonus:bonus,whaleCvd:{bonus,code:'X'}}})});
 ex.store.closed.push(row(10,5),row(-4,5),row(3,0),row(-2,-5),row(1));
 const st=ex.stats();
 assert.equal(st.byWhaleCvd.plus.trades,2);assert.equal(st.byWhaleCvd.plus.netUSD,6);assert.equal(st.byWhaleCvd.zero.trades,1);
 assert.equal(st.byWhaleCvd.minus.trades,1);assert.equal(st.byWhaleCvd.unmeasured.trades,1);
 const S=ex.status().settings;assert.equal(S.whaleCvdBonus,5);assert.equal(S.whaleCvdMinSharePct,10);assert.equal(S.whaleCvdWindowMin,30);
 const sum=summarizeJournal([{exit:{reason:'X'},pnl:{netUSD:2},score:{whaleBonus:5,whaleCvd:{}}},{exit:{reason:'X'},pnl:{netUSD:-1},score:{whaleBonus:-5,whaleCvd:{}}},{exit:{reason:'X'},pnl:{netUSD:1}}]);
 assert.equal(sum.byWhaleCvd.plus.trades,1);assert.equal(sum.byWhaleCvd.minus.trades,1);assert.equal(sum.byWhaleCvd.unmeasured.trades,1);
});

test('screen: 고래CVD ±5 in the breakdown with the six FireCharts colours, glossary entries and the source note',()=>{
 const S=new ScalpExecutor({config:scalpExecConfig({})}).status().settings;
 const SERIES=['WHALE_ORANGE','WHALE_GREEN','WHALE_RED','WHALE_PURPLE','WHALE_BROWN','WHALE_BLUE'];
 for(const code of [...Object.values(WHALE_CVD_CODES),...SERIES])assert.ok(reasonInfo(code,S),code);
 const d=c=>reasonInfo(c,S).desc;
 assert.match(d('WHALE_ORANGE'),/새우.*\$100~\$1,000/);assert.match(d('WHALE_GREEN'),/\$1,000~\$1만/);assert.match(d('WHALE_RED'),/\$1만~\$10만/);
 assert.match(d('WHALE_PURPLE'),/\$10만~\$100만/);assert.match(d('WHALE_BROWN'),/고래.*\$100만~\$1,000만/);assert.match(d('WHALE_BLUE'),/모든 시장가 주문\(All Orders\)/);
 assert.match(d('WHALE_PURPLE'),/\$2만/);assert.match(d('WHALE_BROWN'),/매집 경향/);assert.match(d('WHALE_ORANGE'),/매도 경향/);
 for(const c of SERIES)assert.match(d(c),/Material Indicators FireCharts 분류/);
 assert.match(d('WHALE_CVD_WITH'),/\+5점/);assert.match(d('WHALE_CVD_AGAINST'),/−5점/);
 const item=SCORE_ITEMS.find(([k])=>k==='whaleBonus');assert.ok(item);assert.match(item[3](S),/\+5점.*−5점.*0점/);assert.match(item[3](S),/10%/);
 const g=reasonGlossaryHTML(S);for(const t of ['주황 새우','초록 주문층','빨강 주문층','보라 주문층','갈색 고래','파랑 전체 CVD','고래CVD 같은 방향'])assert.ok(g.includes(`>${t}</dt>`),t);
 const breakdown={movePct:15,trend4h:20,btcTrend4h:10,moveAtr:15,retracedPct:5,climaxVolume:5,netRR:0,rsiExtreme:0};
 const rec=whaleCvdRecord(summarizeWhaleCvd(trades([[1,300_000,'BUY'],[2,2_000_000,'SELL'],[3,9_000,'SELL'],[4,700,'BUY']]),{startMs:0,endMs:100}),{available:true,bonus:-5,code:WHALE_CVD_CODES.AGAINST,shrimpDivergence:false});
 const minus=scoreItemsHTML({score:65,minScore:70,breakdown,whaleBonus:-5,whaleCvd:rec},S);
 assert.match(minus,/class="rz-i rz-whale rz-whale-minus"[^>]*>고래CVD −5</);assert.doesNotMatch(minus,/\+-5/);
 for(const [cls,text] of [['orange','새우 \\+\\$700'],['green','초록 −\\$9K'],['red','빨강 \\$0'],['purple','보라 \\+\\$300K'],['brown','고래 −\\$2M'],['blue','전체 −\\$1\\.71M']])
  assert.match(minus,new RegExp(`class="wcv wcv-${cls}"[^>]*>${text}<`),cls);
 assert.ok(minus.indexOf('wcv-orange')<minus.indexOf('wcv-green')&&minus.indexOf('wcv-brown')<minus.indexOf('wcv-blue'),'legend order');
 assert.match(scoreItemsHTML({score:75,minScore:70,breakdown,whaleBonus:5,whaleCvd:{...rec,bonus:5,shrimpDivergence:true}},S),/rz-whale-plus"[^>]*>고래CVD \+5<.*새우↔고래 반대/);
 assert.match(scoreItemsHTML({score:70,minScore:70,breakdown,whaleBonus:0,whaleCvd:{bonus:0,code:WHALE_CVD_CODES.UNAVAILABLE}},S),/rz-whale-zero"[^>]*>고래CVD 0</);
 assert.doesNotMatch(scoreItemsHTML({score:70,minScore:70,breakdown},S),/고래CVD/,'no record (older rows): no item');
 assert.match(skipRowHTML({at:1,symbol:'SOLUSDT',reason:'SCORE_BELOW_MINIMUM',score:65,minScore:70,breakdown,whaleBonus:-5,whaleCvd:rec},S),/고래CVD −5/);
 const css=fs.readFileSync(new URL('../public/styles.css',import.meta.url),'utf8');
 for(const [k,hex] of [['orange','#fb923c'],['green','#4ade80'],['red','#f87171'],['purple','#c084fc'],['brown','#d19a66'],['blue','#60a5fa']]){
  assert.ok(css.includes(`--wcv-${k}:${hex}`),k);assert.ok(css.includes(`.wcv-${k}{color:var(--wcv-${k})}`),k);
 }
});

test('server wiring: the whale read uses budgetedPublicRead (no state.rest / state.error / apiCache side effect), never binance()',()=>{
 const src=fs.readFileSync(new URL('../server.mjs',import.meta.url),'utf8');
 const body=src.match(/function scalpWhaleCvd\([^)]*\)\{([\s\S]*?)\n\}/)?.[1];
 assert.ok(body,'scalpWhaleCvd found');
 assert.match(body,/budgetedPublicRead\(url,\{budget:publicReadBudget,timeoutMs:WHALE_CVD_DEFAULTS\.timeoutMs\}\)/);
 assert.doesNotMatch(body,/\bbinance\(/,'a failed aggTrades page must not mark the Binance REST offline');
 assert.match(body,/budget:\(\)=>publicReadBudget\.snapshot\(\)/,'the 60 % room check reads the same shared budget');
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

test('whale off: the orderflow read range stays gate−10 (OI + CVD only), as before the whale bonus',async()=>{
 const base=await baseScore(down4h);assert.ok(base+11<=100,String(base));
 for(const off of [{cfg:{whaleCvd:false}},{cfg:{},noFn:true}]){
  for(const [minScore,want] of [[base+10,1],[base+11,0]]){
   let of=0,whale=0;
   const {ex}=scalp({minScore,trend:down4h,orderflow:async()=>{of++;return null},...(off.noFn?{}:{whaleCvd:async()=>{whale++;return whaleSnap(400_000)}})});
   ex.config={...ex.config,...off.cfg};
   await ex.scan();
   assert.equal(of,want,`orderflow read at gate ${minScore} (base ${base}, ${off.noFn?'no whale reader':'SCALP_WHALE_CVD=off'})`);assert.equal(whale,0);
  }
 }
});

test('SHORT (fade after a pump): the window starts at the open of the candle with the lowest low before the high, max 30 min',async()=>{
 // The crash fixture mirrored around 100: the same move up, an upper-wick rejection.
 const mirror=rows=>rows.map(r=>[r[0],String(200-Number(r[1])),String(200-Number(r[3])),String(200-Number(r[2])),String(200-Number(r[4])),r[5],r[6],r[7]]);
 const rows=mirror(crash()),det=detectScalpReversal(rows,{symbol:'SOLUSDT',now:T0});
 assert.equal(det.ok,true);assert.equal(det.direction,'SHORT');
 const originRow=rows.find(r=>r[0]===det.evidence.originAt);assert.ok(originRow);
 assert.equal(Number(originRow[3]),det.evidence.origin,'SHORT origin = the lowest low, at that candle');
 const long=detectScalpReversal(crash(),{symbol:'SOLUSDT',now:T0}),longRow=crash().find(r=>r[0]===long.evidence.originAt);
 assert.equal(Number(longRow[2]),long.evidence.origin,'LONG origin = the highest high, at that candle');
 let seen=null;
 const {ex}=scalp({minScore:1,rows,px:+(det.entry-.02).toFixed(2),whaleCvd:async(sym,o)=>{seen=o;return whaleSnap(-400_000)}});
 assert.equal((await ex.scan()).entered,1,JSON.stringify(ex.store.skips.at(-1)));
 assert.equal(seen.direction,'SHORT');assert.equal(seen.startMs,Math.max(T0-1800_000,det.evidence.originAt));assert.equal(seen.endMs,T0);
 const sc=ex.store.open[0].scalpScore;assert.equal(ex.store.open[0].direction,'SHORT');
 assert.equal(sc.whaleBonus,5,'whale net selling agrees with the SHORT');assert.equal(sc.whaleCvd.code,WHALE_CVD_CODES.WITH);
});
