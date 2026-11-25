// 고래 매물대 (user 2026-11-25 09:51 "단타에선 CVD 활용 방법이 매물대를 보는 거라고 생각하면 편할 것 같고", "진행해"):
// whale (purple + brown) CVD zones by price replace the PR #316 window rule as the scalp's ±5 (review M3: the window held
// the spike itself, so a reversal was structurally scored against it; M2: big coins were read only in part).
// Also the executor / stats / screen / server tests of the whale bonus that were in tests/whale_cvd.test.mjs, moved here
// and changed where the rule changed. Mocks only: no network, no orders, no production data.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {WHALE_CVD_FIXED,WHALE_CVD_CODES,whaleThresholds} from '../whale_cvd.mjs';
import {
 WhaleTradeStore,buildWhaleZones,evaluateWhaleZoneBonus,whaleZoneRecord,whaleWindowSnapshot,whaleSplitOf,whaleLadderZones,whaleZonesPayload,whaleSnapshotUsable,
 whaleZoneSummaryKo,whaleZoneBinPct,whaleZoneNearPct,whaleZoneLookbackMs,WHALE_ZONE_CODES,WHALE_ZONE_DEFAULTS,
} from '../whale_zones.mjs';
import {PublicReadBudget} from '../public_read_budget.mjs';
import {ScalpExecutor,scalpExecConfig} from '../scalp_executor.mjs';
import {detectScalpReversal,scoreScalpSetup} from '../scalp_reversal.mjs';
import {simulateScalpSignals} from '../scalp_simulator.mjs';
import {ladderNextAdd,strongZones} from '../scalp_ladder.mjs';
import {summarizeJournal} from '../scalp_journal.mjs';
import {scalpEventText} from '../scalp_telegram.mjs';
import {reasonInfo,SCORE_ITEMS,scoreItemsHTML,skipRowHTML,reasonGlossaryHTML,ladderStepText} from '../public/scalp_reasons.js';

const H=3600_000,C=WHALE_ZONE_CODES;
const agg=(id,at,usd,side,price)=>({a:id,p:String(price),q:String(usd/price),f:id,l:id,T:at,m:side==='SELL'});
/** A full-coverage snapshot of [end − lookback, end] from [at, usd, side, price] rows (one short page = everything). */
async function snapOf(rows,{end=10*H,lookbackMs=4*H,thresholds=WHALE_CVD_FIXED,symbol='SOLUSDT'}={}){
 const data=rows.map(([at,usd,side,price],i)=>agg(i+1,at,usd,side,price));
 return new WhaleTradeStore({now:()=>end}).read(symbol,{request:async()=>data,thresholds,lookbackMs,endMs:end});
}

test('bins: width 0.25 × ATR(1H) (bounded) or 0.2 %; K 0.5 × ATR(1H) or 0.4 %; lookback 1..24 h',()=>{
 assert.deepEqual(whaleZoneBinPct(0.8),{pct:0.2,source:'ATR_1H'});assert.deepEqual(whaleZoneBinPct(null),{pct:0.2,source:'PCT_FALLBACK'});
 assert.equal(whaleZoneBinPct(0.1).pct,0.05,'floor 0.05 %');assert.equal(whaleZoneBinPct(5).pct,0.5,'cap 0.5 %');
 assert.deepEqual(whaleZoneNearPct(0.8),{pct:0.4,source:'ATR_1H'});assert.deepEqual(whaleZoneNearPct(0),{pct:0.4,source:'PCT_FALLBACK'});
 assert.equal(whaleZoneNearPct(0.1).pct,0.1);assert.equal(whaleZoneNearPct(9).pct,1);
 assert.equal(whaleZoneLookbackMs(4),4*H);assert.equal(whaleZoneLookbackMs(99),24*H);assert.equal(whaleZoneLookbackMs(0),H);assert.equal(whaleZoneLookbackMs(),4*H);
});

test('zones: whale buy − sell per price bin, significance floor, top N, adjacent same-side bins merged, alt-scaled edges',async()=>{
 const end=10*H,t=end-H;
 // Bin 0.2 % of 100 = 0.2 wide (grid from 0): 99.0-99.2, 99.2-99.4 (buy, merged), 100.6-100.8 (sell), 101.0-101.2 (small).
 const snap=await snapOf([
  [t,400_000,'BUY',99.1],[t+1,300_000,'BUY',99.3],[t+2,100_000,'SELL',99.3],       // +400k, +200k: adjacent BUY bins
  [t+3,500_000,'SELL',100.7],[t+4,150_000,'BUY',100.7],                              // −350k
  [t+5,150_000,'BUY',101.1],                                                          // +150k < floor 200k
  [t+6,90_000,'BUY',99.5],                                                            // red, not whale: not in any bin
  [t+7,5_000,'SELL',99.5],
 ],{end});
 assert.equal(snap.ok,true);assert.equal(snap.coveragePct,100);assert.equal(snap.whaleTrades.length,6,'purple / brown only');
 const zr=buildWhaleZones(snap,{price:100,atrPct:null});
 assert.equal(zr.binPct,0.2);assert.equal(zr.binSource,'PCT_FALLBACK');assert.equal(zr.binWidth,0.2);
 assert.equal(zr.whaleNotionalUSD,1_600_000);
 assert.equal(zr.floorUSD,200_000,'max(2 × $100k purple, 5 % of $1.6M = $80k)');assert.equal(zr.floorSource,'PURPLE_EDGE');
 assert.equal(zr.zones.length,2);
 const [buy,sell]=zr.zones;
 assert.equal(buy.side,'BUY');assert.equal(buy.bins,2,'99.0-99.2 and 99.2-99.4 merged');assert.ok(Math.abs(buy.low-99)<1e-9&&Math.abs(buy.high-99.4)<1e-9,JSON.stringify(buy));
 assert.equal(buy.netUSD,600_000);assert.equal(buy.buyUSD,700_000);assert.equal(buy.sellUSD,100_000);assert.equal(buy.count,3);
 assert.equal(sell.side,'SELL');assert.equal(sell.netUSD,-350_000);assert.ok(Math.abs(sell.low-100.6)<1e-9&&Math.abs(sell.high-100.8)<1e-9);
 // 5 % of the whale notional wins when it is larger: one $10M brown day lifts the floor to $500k+.
 const big=await snapOf([[t,10_000_000,'BUY',90],[t+1,400_000,'BUY',99.1]],{end});
 const bz=buildWhaleZones(big,{price:100});assert.equal(bz.floorUSD,520_000);assert.equal(bz.floorSource,'NOTIONAL_SHARE');
 assert.deepEqual(bz.zones.map(z=>z.netUSD),[10_000_000],'the $400k bin is under 5 %');
 // Top N bins by |net| before merging.
 const many=await snapOf(Array.from({length:12},(_,i)=>[t+i,250_000+i*10_000,'BUY',90+i]),{end});
 const mz=buildWhaleZones(many,{price:100,topN:8});assert.equal(mz.zones.length,8);assert.equal(mz.zones[0].netUSD,290_000,'the 4 smallest dropped');
 // A different-side neighbour is not merged.
 const flip=await snapOf([[t,300_000,'BUY',99.1],[t+1,300_000,'SELL',99.3]],{end});
 assert.deepEqual(buildWhaleZones(flip,{price:100}).zones.map(z=>z.side),['BUY','SELL']);
 // ATR(1H) 0.8 % -> bin 0.2 %; 0.4 % -> 0.1 % (the two BUY prints fall in two bins 0.1 apart, still merged as adjacent).
 assert.equal(buildWhaleZones(snap,{price:100,atrPct:0.4}).binPct,0.1);
 // Alt scaling (1 % of BTC volume -> factor 0.2, purple $20k): $30k prints are whales, the floor is 2 × $20k.
 const alt=whaleThresholds({quoteVolume24h:1e8,referenceQuoteVolume24h:1e10});assert.equal(alt.purpleMinUSD,20_000);
 const as=await snapOf([[t,30_000,'BUY',99.1],[t+1,30_000,'BUY',99.1],[t+2,15_000,'BUY',99.1]],{end,thresholds:alt});
 assert.equal(as.whaleTrades.length,2,'$15k is red even scaled');
 const az=buildWhaleZones(as,{price:100});assert.equal(az.purpleMinUSD,20_000);assert.equal(az.floorUSD,40_000);assert.equal(az.zones[0].netUSD,60_000);
 // The same prints on fixed edges: no whale at all.
 assert.equal((await snapOf([[t,30_000,'BUY',99.1]],{end})).whaleTrades.length,0);
 // Outside the lookback: left out.
 const old=await snapOf([[end-5*H,900_000,'BUY',99.1],[t,1_000,'BUY',99]],{end});assert.equal(old.whaleTrades.length,0);
});

test('score LONG / SHORT: support +5, resistance −5 only without support, 0 when nothing is near; K = 0.5 × ATR(1H) or 0.4 %',async()=>{
 const end=10*H,t=end-H;
 const S=async rows=>{const s=await snapOf(rows,{end});return {s,zr:buildWhaleZones(s,{price:100})}};
 const ev=(x,direction,entry,atrPct=null)=>evaluateWhaleZoneBonus(x.s,x.zr,{direction,entry,atrPct});
 // BUY zone 99.6-99.8 (support for a LONG at 100: 0.2 % under it, K = 0.4 %).
 const sup=await S([[t,500_000,'BUY',99.7]]);
 let e=ev(sup,'LONG',100);assert.equal(e.bonus,5);assert.equal(e.code,C.SUPPORT);assert.equal(e.support.side,'BUY');assert.equal(e.support.distPct,0.2);assert.equal(e.nearPct,0.4);
 // K from ATR(1H): 0.3 % ATR -> K 0.15 % < 0.2 %: not near.
 e=ev(sup,'LONG',100,0.3);assert.equal(e.code,C.NONE);assert.equal(e.bonus,0);assert.equal(e.nearPct,0.15);
 assert.equal(ev(sup,'LONG',99.7).code,C.SUPPORT,'entry inside the zone');
 assert.equal(ev(sup,'LONG',99.5).code,C.NONE,'a BUY zone ABOVE a LONG is no support (and no resistance)');
 // The same BUY zone under a SHORT at 100 is resistance in the way: −5 (no SELL zone above).
 e=ev(sup,'SHORT',100);assert.equal(e.bonus,-5);assert.equal(e.code,C.RESISTANCE);assert.equal(e.resistance.side,'BUY');
 // SELL zone 100.2-100.4 right over a LONG at 100: −5; a SHORT at 100: +5.
 const res=await S([[t,500_000,'SELL',100.3]]);
 e=ev(res,'LONG',100);assert.equal(e.bonus,-5);assert.equal(e.code,C.RESISTANCE);assert.equal(e.resistance.distPct,0.2);
 e=ev(res,'SHORT',100);assert.equal(e.bonus,5);assert.equal(e.code,C.SUPPORT);assert.equal(e.support.side,'SELL');
 // Support AND resistance near: support wins (+5), the resistance is recorded.
 const both=await S([[t,500_000,'BUY',99.7],[t+1,500_000,'SELL',100.3]]);
 e=ev(both,'LONG',100);assert.equal(e.bonus,5);assert.equal(e.code,C.SUPPORT);assert.equal(e.resistance.side,'SELL');
 e=ev(both,'SHORT',100);assert.equal(e.bonus,5);assert.equal(e.support.side,'SELL');assert.equal(e.resistance.side,'BUY');
 // Far zones: 0; no zone over the floor: NO_ZONES; no whale print: NO_PRINTS; bonus capped at 5.
 assert.equal(ev(await S([[t,500_000,'BUY',97]]),'LONG',100).code,C.NONE);
 assert.equal(ev(await S([[t,150_000,'BUY',99.7]]),'LONG',100).code,C.NO_ZONES);
 assert.equal(ev(await S([[t,5_000,'BUY',99.7]]),'LONG',100).code,C.NO_PRINTS);
 assert.equal(evaluateWhaleZoneBonus(sup.s,sup.zr,{direction:'LONG',entry:100,bonus:9}).bonus,5);
 assert.equal(evaluateWhaleZoneBonus(sup.s,sup.zr,{direction:'LONG',entry:100,bonus:0}).bonus,0);
 for(const s of [null,{ok:false,error:'HTTP 451'}])assert.equal(evaluateWhaleZoneBonus(s,null,{direction:'LONG',entry:100}).code,C.UNAVAILABLE);
});

test('coverage gate: under 80 % of the lookback read is 0 (WHALE_ZONE_PARTIAL), never extrapolated; 80 % cannot be lowered',async()=>{
 const end=10*H;
 // 3,000 trades over the last 3 h (one every 3.6 s), a 4 h lookback: page cap 2 reads 2,000 trades = 2 h = 50 %.
 const all=Array.from({length:3000},(_,i)=>agg(i+1,end-3*H+i*3600,i%100===0?600_000:100,'BUY',99.7));
 const request=async route=>{const u=new URL(route,'https://x'),lim=Number(u.searchParams.get('limit')),from=u.searchParams.get('fromId');
  return from==null?all.slice(-lim):all.filter(t=>t.a>=Number(from)).slice(0,lim)};
 const store=new WhaleTradeStore({now:()=>end});
 const s=await store.read('SOLUSDT',{request,lookbackMs:4*H,endMs:end,maxPages:2});
 assert.equal(s.ok,true);assert.ok(s.coveragePct>=49&&s.coveragePct<=51,String(s.coveragePct));
 const zr=buildWhaleZones(s,{price:100});assert.ok(zr.zones.length>0,'zones exist in what was read');
 const e=evaluateWhaleZoneBonus(s,zr,{direction:'LONG',entry:100});
 assert.equal(e.bonus,0);assert.equal(e.code,C.PARTIAL);assert.match(e.detail,/< 80%/);
 assert.equal(evaluateWhaleZoneBonus(s,zr,{direction:'LONG',entry:100,minCoveragePct:10}).code,C.PARTIAL,'the 80 % is a floor');
 // The record keeps the coverage; the ladder takes no whale zone from it (tested with the executor below).
 const rec=whaleZoneRecord(s,zr,{...e,direction:'LONG'});assert.equal(rec.code,C.PARTIAL);assert.equal(rec.bonus,0);assert.equal(rec.coveragePct,s.coveragePct);
 assert.equal(whaleSplitOf({whaleBonus:0,whaleCvd:rec}),'unavailable');
 assert.match(whaleZoneSummaryKo(rec),/고래매물대 0 \(일부만 읽음/);
 // The whole 3 h history but a 4 h lookback: everything was read (the first trade is the coin's first) -> 100 %.
 const full=await new WhaleTradeStore({now:()=>end}).read('SOLUSDT',{request,lookbackMs:4*H,endMs:end,maxPages:5});
 assert.equal(full.coveragePct,100);
});

test('review 2026-11-25: a newer read that fails never claims coverage to now; a read older than 60 s scores 0 (PARTIAL)',async()=>{
 let clock=10*H,fail=false;
 const all=Array.from({length:500},(_,i)=>agg(i+1,clock-3*H+i*20_000,i%50===0?500_000:200,'BUY',99.7));
 const request=async route=>{if(fail)throw Error('Binance HTTP 429');const u=new URL(route,'https://x'),lim=Number(u.searchParams.get('limit')),from=u.searchParams.get('fromId');
  return from==null?all.slice(-lim):all.filter(t=>t.a>=Number(from)).slice(0,lim)};
 const store=new WhaleTradeStore({now:()=>clock}),opts={request,lookbackMs:4*H};
 let s=await store.read('SOLUSDT',opts);
 assert.equal(s.coveragePct,100);assert.equal(s.coveredToMs,clock);assert.equal(s.staleMs,0);
 // Within the 30 s memory: from memory, still fresh enough to score.
 clock+=20_000;s=await store.read('SOLUSDT',opts);assert.equal(s.cached,true);assert.equal(s.staleMs,20_000);
 let zr=buildWhaleZones(s,{price:100});assert.equal(evaluateWhaleZoneBonus(s,zr,{direction:'LONG',entry:100}).code,C.SUPPORT);
 // Every newer read fails for 10 min (429 / budget / cooldown) while whales sell right over the price.
 fail=true;const t=clock;for(let k=0;k<20;k++)all.push(agg(all.length+1,t+k*1000,600_000,'SELL',100.3));
 for(let i=0;i<10;i++){clock+=60_000;s=await store.read('SOLUSDT',opts)}
 assert.equal(s.ok,true);assert.equal(s.coveredToMs,t-20_000,'covered only up to the last read that caught up');
 assert.ok(s.coveragePct<100&&s.coveragePct>95,String(s.coveragePct));assert.equal(s.staleMs,clock-(t-20_000));
 zr=buildWhaleZones(s,{price:100});
 const e=evaluateWhaleZoneBonus(s,zr,{direction:'LONG',entry:100});
 assert.equal(e.bonus,0);assert.equal(e.code,C.PARTIAL,'never the old zones');assert.match(e.detail,/^STALE \d+s > 60s$/);
 assert.equal(whaleSnapshotUsable(s).usable,false);assert.equal(whaleSnapshotUsable(s,{maxStaleMs:3600_000}).usable,false,'60 s is a ceiling');
 const p=whaleZonesPayload(s,zr);assert.equal(p.partial,true);
 // Reads work again: one forward read catches up, fresh and full again.
 fail=false;clock+=31_000;s=await store.read('SOLUSDT',opts);
 assert.equal(s.coveredToMs,clock);assert.equal(s.coveragePct,100);assert.equal(whaleSnapshotUsable(s).usable,true);
 zr=buildWhaleZones(s,{price:100});assert.ok(zr.zones.some(z=>z.side==='SELL'),'the new SELL zone is in');
 // A snapshot without its end / covered-to times is never used.
 assert.equal(whaleSnapshotUsable({ok:true,coveragePct:100}).usable,false);
});

// A fake Binance aggTrades feed: ids 1..n, one trade a second; `more(k)` appends k newer trades later.
function feed({n=5000,end=10*H,budget=new PublicReadBudget({now:()=>end}),price=100}={}){
 const routes=[],all=[];let last=end;
 const push=(k,to)=>{for(let i=0;i<k;i++){const id=all.length+1;all.push(agg(id,to-(k-1-i)*1000,id%50===0?300_000:200,id%2?'BUY':'SELL',price))}};
 push(n,end);
 const request=async route=>{
  routes.push(route);const r=budget.reserve(route);if(!r.ok)throw Error(r.code);
  const u=new URL(route,'https://fapi.binance.com'),lim=Number(u.searchParams.get('limit')),from=u.searchParams.get('fromId');
  return from==null?all.slice(-lim):all.filter(t=>t.a>=Number(from)).slice(0,lim);
 };
 return {request,routes,budget,all,more:(k,to)=>{push(k,to);last=to},get last(){return last}};
}

test('store: newest page then older ones by fromId; later reads fetch only newer trades; 30 s memory; budget, cooldown, deadline',async()=>{
 let clock=10*H;const f=feed({end:clock,budget:new PublicReadBudget({now:()=>clock})});
 const store=new WhaleTradeStore({now:()=>clock}),opts={request:f.request,budget:()=>f.budget.snapshot(),lookbackMs:H,maxPages:10};
 // 1 h = 3,600 trades: the newest page + 3 older pages.
 let s=await store.read('SOLUSDT',opts);
 assert.equal(s.ok,true);assert.equal(s.pages,4);assert.equal(s.weight,80);assert.equal(s.coveragePct,100);
 assert.match(f.routes[0],/^\/fapi\/v1\/aggTrades\?symbol=SOLUSDT&limit=1000$/);assert.match(f.routes[1],/&fromId=3001$/);assert.match(f.routes[3],/&fromId=1001$/);
 assert.equal(f.budget.snapshot().usedWeight,80);
 const whales=s.whaleTrades.length;assert.ok(whales>=70&&whales<=73,String(whales));
 // Within 30 s: from memory, no request.
 clock+=10_000;s=await store.read('SOLUSDT',opts);assert.equal(f.routes.length,4);assert.equal(s.cached,true);
 // 2 min later with 120 newer trades: ONE forward page from the last id, nothing older read again.
 clock+=110_000;f.more(120,clock);
 s=await store.read('SOLUSDT',opts);
 assert.equal(f.routes.length,5);assert.match(f.routes[4],/&fromId=5001$/,'only trades after the last id');assert.equal(s.pages,1);assert.equal(s.weight,20);
 // Series sums are per minute (record only): the minute the lookback starts in is counted whole, so ≤ 60 more.
 assert.equal(s.coveragePct,100);assert.ok(s.trades>=3600&&s.trades<=3660,`the lookback slid by 2 min: ${s.trades} trades, none counted twice`);
 assert.equal(s.whaleTrades.length,s.whaleTrades.filter((t,i,a)=>a.findIndex(x=>x.id===t.id)===i).length,'each whale trade once');
 // Unused for 15 min: dropped, read again from the newest page.
 clock+=16*60_000;f.more(10,clock);
 s=await store.read('SOLUSDT',{...opts,maxPages:1});assert.match(f.routes.at(-1),/limit=1000$/,'a fresh newest page, not a forward read');assert.equal(s.pages,1);
 // Edges moved by more than 25 % (24h volume): started again.
 clock+=60_000;const before=f.routes.length;
 await store.read('SOLUSDT',{...opts,maxPages:1,thresholds:{...WHALE_CVD_FIXED,purpleMinUSD:50_000}});
 assert.match(f.routes[before],/limit=1000$/,'a fresh newest page, not a forward read');
 // Budget: no page above 60 % of the per-minute weight; a cooldown reads nothing.
 clock=20*H;const g=feed({end:clock,budget:new PublicReadBudget({now:()=>clock,maxWeight:100})}),st2=new WhaleTradeStore({now:()=>clock});
 s=await st2.read('SOLUSDT',{request:g.request,budget:()=>g.budget.snapshot(),lookbackMs:H,maxPages:10});
 assert.equal(g.routes.length,3,'3 × 20 = 60 = 60 % of 100');assert.equal(s.stopped,'BUDGET');assert.ok(s.coveragePct>80&&s.coveragePct<85,`3,000 of 3,600 s: ${s.coveragePct}`);
 const h=feed({end:clock,budget:new PublicReadBudget({now:()=>clock})});h.budget.rateLimited(429,120);
 s=await new WhaleTradeStore({now:()=>clock}).read('SOLUSDT',{request:h.request,budget:()=>h.budget.snapshot(),lookbackMs:H});
 assert.equal(s.ok,false);assert.equal(h.routes.length,0);
 // Deadline: no page starts after the caller's 4 s wait (each page 1.5 s here).
 let c2=30*H;const d=feed({end:c2,n:8000,budget:new PublicReadBudget({now:()=>c2})});
 const slow=async route=>{const rows=await d.request(route);c2+=1500;return rows};
 s=await new WhaleTradeStore({now:()=>c2}).read('SOLUSDT',{request:slow,budget:()=>d.budget.snapshot(),lookbackMs:2*H,maxPages:10,endMs:c2});
 assert.equal(d.routes.length,3);assert.equal(s.stopped,'DEADLINE');
 // Page cap: at most maxPages (30 at most) requests a call, whatever the lookback needs.
 const e=feed({end:clock,n:50000,budget:new PublicReadBudget({now:()=>clock,maxWeight:2400})});
 await new WhaleTradeStore({now:()=>clock}).read('SOLUSDT',{request:e.request,budget:()=>e.budget.snapshot(),lookbackMs:12*H,maxPages:99,reservePct:0});
 assert.equal(e.routes.length,30);
 // Failures never throw; a bad symbol / no reader is refused.
 const bad=new WhaleTradeStore({now:()=>clock});
 assert.equal((await bad.read('SOLUSDT',{request:async()=>{throw Error('Binance HTTP 503')}})).ok,false);
 assert.equal((await bad.read('bad sym!',{request:f.request})).error,'BAD_SYMBOL');assert.equal((await bad.read('SOLUSDT',{})).error,'NO_REQUEST');
 // Concurrent reads of one symbol share one fetch.
 const k=feed({end:clock});const shared=new WhaleTradeStore({now:()=>clock});
 await Promise.all([shared.read('ETHUSDT',{request:k.request,lookbackMs:H}),shared.read('ETHUSDT',{request:k.request,lookbackMs:H})]);
 assert.equal(k.routes.length,4);
});

test('review 2026-11-25: whale trades kept in time order (prune works, the cap drops the oldest and lowers the coverage); LRU; no rejection',async()=>{
 // 3,000 trades over the last 4 h, every one a whale; a cap of 2,000: the NEWEST 2,000 stay, the coverage says so.
 let clock=10*H;const N=3000,all=Array.from({length:N},(_,i)=>agg(i+1,clock-4*H+Math.round((i+1)*(4*H/N)),150_000,'BUY',100));
 const request=async route=>{const u=new URL(route,'https://x'),lim=Number(u.searchParams.get('limit')),from=u.searchParams.get('fromId');
  return from==null?all.slice(-lim):all.filter(t=>t.a>=Number(from)).slice(0,lim)};
 const capped=new WhaleTradeStore({now:()=>clock,maxWhaleTrades:2000});
 let s=await capped.read('SOLUSDT',{request,lookbackMs:4*H,maxPages:10});
 const ids=s.whaleTrades.map(t=>t.id);
 assert.equal(ids.length,2000);assert.equal(Math.min(...ids),1001);assert.equal(Math.max(...ids),N,'the newest trade is kept');
 assert.ok(ids.every((id,i)=>!i||ids[i-1]<id),'id order');
 assert.ok(s.coveragePct>66&&s.coveragePct<67,`coverage from the oldest whale trade kept: ${s.coveragePct}`);
 assert.equal(evaluateWhaleZoneBonus(s,buildWhaleZones(s,{price:100}),{direction:'LONG',entry:100}).code,C.PARTIAL);
 // Prune: after the lookback slides, nothing older than its start is kept (the newest page was read first, the older after).
 clock=20*H;const f=feed({end:clock,n:3600});const st=new WhaleTradeStore({now:()=>clock});
 await st.read('SOLUSDT',{request:f.request,lookbackMs:H,maxPages:10});
 clock+=30*60_000;f.more(1800,clock);
 s=await st.read('SOLUSDT',{request:f.request,lookbackMs:H,maxPages:10});
 const kept=st.entries.get('SOLUSDT').whale;
 assert.ok(kept.every(t=>t.at>=clock-H),'pruned to the lookback');assert.ok(kept.every((t,i)=>!i||kept[i-1].id<t.id));
 assert.equal(s.coveragePct,100);
 // LRU: a symbol read again is kept over one read once (maxSymbols 2).
 const lru=new WhaleTradeStore({now:()=>clock,maxSymbols:2}),g=feed({end:clock,n:500});
 for(const sym of ['AAAUSDT','BBBUSDT','AAAUSDT','CCCUSDT'])await lru.read(sym,{request:g.request,lookbackMs:H});
 assert.deepEqual([...lru.entries.keys()].sort(),['AAAUSDT','CCCUSDT']);
 // A read that throws inside (here the budget callback) answers every caller {ok:false}, the joined ones too.
 const boom=new WhaleTradeStore({now:()=>clock}),bad={request:g.request,lookbackMs:H,budget:()=>{throw Error('budget broke')}};
 const both=await Promise.all([boom.read('DDDUSDT',bad),boom.read('DDDUSDT',bad)]);
 assert.deepEqual(both.map(x=>x.ok),[false,false]);assert.equal(boom.entries.size,0);
});

test('API payload (GET /api/whale-zones shape): price ranges, side, net, thresholds, coverage; ladder zones by side',async()=>{
 const end=10*H,t=end-H;
 const s=await snapOf([[t,500_000,'BUY',99.7],[t+1,500_000,'SELL',100.3],[t+2,800,'SELL',100]],{end});
 const zr=buildWhaleZones(s,{price:100,atrPct:0.8});
 const p=whaleZonesPayload(s,zr,{atrPct:0.8});
 assert.equal(p.ok,true);assert.equal(p.symbol,'SOLUSDT');assert.equal(p.coveragePct,100);assert.equal(p.partial,false);
 assert.equal(p.binPct,0.2);assert.equal(p.nearPct,0.4);assert.equal(p.purpleMinUSD,100_000);assert.equal(p.floorUSD,200_000);assert.equal(p.lookbackMin,240);
 assert.deepEqual(p.zones.map(z=>[z.side,z.netUSD]),[['BUY',500_000],['SELL',-500_000]],'sorted by price');
 for(const z of p.zones)assert.deepEqual(Object.keys(z),['low','high','side','net','netUSD','buyUSD','sellUSD','count']);
 // The PR #318 screen's contract (public/orderflow_ui.js parseWhaleZones): low < high, side BUY | SELL, net = signed USD
 // (review 2026-11-25: only netUSD was sent, so every band was labelled $0).
 assert.deepEqual(p.zones.map(z=>[z.side,z.net]),[['BUY',500_000],['SELL',-500_000]]);
 for(const z of p.zones)assert.ok(z.low>0&&z.high>z.low&&Number.isFinite(z.net));
 const ui=await import('../public/orderflow_ui.js');
 if(typeof ui.parseWhaleZones==='function')assert.deepEqual(ui.parseWhaleZones(p).map(z=>[z.side,z.net,z.low,z.high]),p.zones.map(z=>[z.side,z.net,z.low,z.high]));
 // A partial or stale read draws nothing (the screen has no partial flag); the count is kept.
 for(const bad of [{...s,coveragePct:60},{...s,coveredToMs:s.endMs-120_000}]){
  const q=whaleZonesPayload(bad,zr,{atrPct:0.8});assert.equal(q.ok,true);assert.equal(q.partial,true);assert.deepEqual(q.zones,[]);assert.equal(q.hiddenZones,2);
 }
 // The screen's reads (apiReservePct 60) page only under 40 % of the budget.
 const g=feed({end,budget:new PublicReadBudget({now:()=>end,maxWeight:100})});
 await new WhaleTradeStore({now:()=>end}).read('SOLUSDT',{request:g.request,budget:()=>g.budget.snapshot(),lookbackMs:H,maxPages:10,reservePct:WHALE_ZONE_DEFAULTS.apiReservePct});
 assert.equal(g.routes.length,2,'2 × 20 = 40 % of 100');
 assert.equal(p.shrimpCvdUSD,-800);assert.equal(whaleZonesPayload({ok:false,error:'x'},null).ok,false);
 assert.deepEqual(whaleLadderZones(zr,'LONG').map(z=>[z.kind,z.side,z.why[0]]),[['WHALE','BUY','WHALE_BUY_ZONE']]);
 assert.deepEqual(whaleLadderZones(zr,'SHORT').map(z=>[z.kind,z.side,z.why[0]]),[['WHALE','SELL','WHALE_SELL_ZONE']]);
 // The ladder picks a whale zone like a 4H / 1D one and keeps its kind.
 const next=ladderNextAdd({direction:'LONG',lastFill:101,spacingPct:1.5,zones:whaleLadderZones(zr,'LONG')});
 assert.equal(next.zone.kind,'WHALE');assert.equal(next.zone.side,'BUY');assert.equal(next.zone.at,'BETWEEN');assert.ok(Math.abs(next.level-99.8)<1e-9);
 assert.equal(strongZones({zones4h:[{low:70,high:71,rank:1}],zones1d:[]})[0].kind,'VOLUME');
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
const up4h=now=>Array.from({length:301},(_,i)=>{const t=now-(301-i)*4*H-1000,c=50+i*.1;return [t,String(c),String(c+.2),String(c-.2),String(c),'1000',t+4*H-1,'1']});
const down4h=now=>up4h(now).map(r=>[r[0],String(200-Number(r[4])),String(200-Number(r[4])+.2),String(200-Number(r[4])-.2),String(200-Number(r[4])),r[5],r[6],r[7]]).map((r,i)=>{const c=200-i*.1;return [r[0],String(c),String(c+.2),String(c-.2),String(c),'1000',r[6],'1']});
// 1H candles with a 0.4 % range: ATR(1H) 0.4 % -> bin 0.1 %, K 0.2 %.
const hourly=now=>Array.from({length:40},(_,i)=>{const t=now-(40-i)*H-1000,c=94;return [t,String(c),String(c*1.002),String(c*.998),String(c),'1000',t+H-1,'1']});
const ENTRY=Number(crash().at(-1)[4]),PX=+(ENTRY+.02).toFixed(2);
const SOL={symbol:'SOLUSDT',venueSymbol:'SOL-USDT',tickSize:'0.01',quantityStep:'0.01',minQuantityBase:'0.01',minNotionalUSDT:2,tradable:true};
const BTC={symbol:'BTCUSDT',venueSymbol:'BTC-USDT',tickSize:'0.1',quantityStep:'0.001',minQuantityBase:'0.001',minNotionalUSDT:5,tradable:true};
function mockVenue(fillAt=PX){
 let amt=0,avg=0,id=1,mark=fillAt;const calls=[];
 const client={mode:'TESTNET',
  positionMode:async()=>({dualSidePosition:false}),marginType:async()=>({marginType:'CROSSED'}),setMarginType:async()=>({}),
  leverage:async()=>({maxLongLeverage:20,maxShortLeverage:20}),setLeverage:async(s,side,l)=>({leverage:l}),
  positions:async()=>amt!==0?[{symbol:'SOL-USDT',positionSide:'BOTH',positionAmt:String(amt),avgPrice:String(avg),markPrice:String(mark),unrealizedProfit:'0'}]:[],
  openOrders:async()=>({orders:[]}),getOrder:async()=>({order:null}),cancelOrder:async()=>({}),
  placeOrder:async(p)=>{calls.push(p);const q=Number(p.quantity),sign=p.side==='SELL'?-1:1;
   if(p.type==='MARKET'&&!p.reduceOnly){const px=mark;avg=(avg*Math.abs(amt)+px*q)/(Math.abs(amt)+q);amt=+(amt+sign*q).toFixed(8);return {order:{orderId:String(id++),status:'FILLED',executedQty:String(q),avgPrice:String(px)}}}
   if(p.type==='LIMIT'&&p.timeInForce==='PostOnly'){const px=Number(p.price)||fillAt;avg=px;amt=sign*q;return {order:{orderId:String(id++),status:'FILLED',executedQty:String(q),avgPrice:String(px)}}}
   return {order:{orderId:String(id++),status:'NEW'}}}};
 return {client,calls,setMark:v=>{mark=v}};
}
/** The zone snapshot a candidate sees (4 h, full coverage), trades as [minutes before T0, usd, side, price]. */
const zonesAt=rows=>snapOf(rows.map(([m,usd,side,price])=>[T0-m*60_000,usd,side,price]),{end:T0});
function scalp({minScore,whaleZones,orderflow=null,trend=up4h,rows=crash(),px=PX,config={}}){
 const v=mockVenue(px);
 const ex=new ScalpExecutor({config:{...scalpExecConfig({}),management:'CURRENT',minScore,stopLossEnabled:false,...config},client:v.client,
  contracts:async()=>new Map([['SOLUSDT',SOL],['BTCUSDT',BTC]]),
  tickers:async()=>[{symbol:'SOL-USDT',quoteVolume:'90000000'},{symbol:'BTC-USDT',quoteVolume:'500000000'}],
  candles:async(s,iv)=>iv==='5m'?(s==='SOLUSDT'?[...rows,[BUCKET*I,'100','100','100','100','1',BUCKET*I+I-1,'1']]:[]):iv==='1h'?hourly(T0):trend(T0),
  ...(whaleZones?{whaleZones}:{}),...(orderflow?{orderflow}:{}),
  priceOf:async()=>px,markOf:async()=>px,balance:async()=>({equity:10000,available:9000}),now:()=>T0});
 ex.arm();return {ex,v};
}
async function baseScore(trend=up4h){
 const {ex}=scalp({minScore:1,trend});const st=await ex.scan();assert.equal(st.entered,1);return ex.store.open[0].scalpScore.score;
}

test('gate: a whale BUY zone under a LONG (+5) lifts gate−1 over; a SELL zone right over it (−5) drops gate+2; the spike window no longer scores',async()=>{
 const base=await baseScore();assert.ok(base>20&&base<90,String(base));
 // Support 0.05 % under the entry (bin 0.1 %, K 0.2 % from the 0.4 % 1H ATR).
 const support=await zonesAt([[90,400_000,'BUY',+(PX*.9995).toFixed(4)]]);
 let seen=null;
 let {ex}=scalp({minScore:base+1,whaleZones:async(sym,o)=>{seen={sym,...o};return support}});
 assert.equal((await ex.scan()).entered,1,JSON.stringify(ex.store.skips.at(-1)));
 let sc=ex.store.open[0].scalpScore;
 assert.equal(sc.score,base+5);assert.equal(sc.whaleBonus,5);assert.equal(sc.whaleCvd.rule,'ZONES');assert.equal(sc.whaleCvd.code,C.SUPPORT);
 assert.equal(sc.whaleCvd.binPct,0.1);assert.equal(sc.whaleCvd.binSource,'ATR_1H');assert.equal(sc.whaleCvd.nearPct,0.2);assert.equal(sc.whaleCvd.coveragePct,100);
 assert.equal(sc.whaleCvd.support.side,'BUY');assert.equal(sc.whaleCvd.thresholds.purpleMinUSD,100_000);assert.equal(sc.whaleCvd.floorUSD,200_000);
 assert.equal(seen.sym,'SOLUSDT');assert.equal(seen.lookbackMs,4*H);assert.equal(seen.endMs,T0);assert.equal(seen.maxPages,10);assert.equal(seen.scale,'auto');
 const opened=ex.store.events.find(e=>e.type==='OPENED');
 assert.equal(opened.whaleBonus,5);assert.match(opened.whaleSummary,/^고래매물대 \+5 \(매수 매물대 .* \+\$400K · 진입과 [\d.]+% · 4시간 100% 읽음\)$/);
 assert.match(scalpEventText(opened),/고래매물대 \+5 \(매수 매물대/);
 const st=ex.status();assert.equal(st.whaleZoneLast.symbol,'SOLUSDT');assert.equal(st.whaleZoneLast.purpleMinUSD,100_000);assert.equal(st.whaleZoneLast.nearPct,0.2);
 // Resistance right over the LONG and no support: gate+2 − 5 fails, recorded on the skip.
 const resistance=await zonesAt([[90,400_000,'SELL',+(PX*1.001).toFixed(4)]]);
 ({ex}=scalp({minScore:base-2,whaleZones:async()=>resistance}));
 assert.equal((await ex.scan()).entered,0);
 const sk=ex.store.skips.at(-1);
 assert.equal(sk.reason,'SCORE_BELOW_MINIMUM');assert.equal(sk.score,base-5);assert.equal(sk.whaleBonus,-5);assert.equal(sk.whaleCvd.code,C.RESISTANCE);assert.match(sk.detail,/고래매물대-5/);
 // Both near: support wins.
 ({ex}=scalp({minScore:base,whaleZones:async()=>zonesAt([[90,400_000,'BUY',+(PX*.9995).toFixed(4)],[80,400_000,'SELL',+(PX*1.001).toFixed(4)]])}));
 assert.equal((await ex.scan()).entered,1);sc=ex.store.open[0].scalpScore;assert.equal(sc.whaleBonus,5);assert.equal(sc.whaleCvd.resistance.side,'SELL');
 // Review M3: heavy whale SELLING during the crash itself (old window rule: −5) with a buy zone under the entry -> +5 now,
 // and the old result kept under `window` (scored: false) for comparison.
 const det=detectScalpReversal(crash(),{symbol:'SOLUSDT',now:T0});
 const spikeMin=Math.min(20,Math.max(1,Math.round((T0-det.evidence.originAt)/60_000)-2)); // inside the (≤ 30 min) window
 ({ex}=scalp({minScore:base,whaleZones:async()=>zonesAt([[spikeMin,3_000_000,'SELL',+(PX*1.03).toFixed(4)],[90,400_000,'BUY',+(PX*.9995).toFixed(4)]])}));
 assert.equal((await ex.scan()).entered,1);sc=ex.store.open[0].scalpScore;
 assert.equal(sc.whaleBonus,5);assert.equal(sc.score,base+5);
 assert.equal(sc.whaleCvd.window.code,WHALE_CVD_CODES.AGAINST);assert.equal(sc.whaleCvd.window.bonus,-5);assert.equal(sc.whaleCvd.window.scored,false);
 assert.equal(sc.whaleCvd.window.startMs,Math.max(T0-30*60_000,det.evidence.originAt));
 // Partial read / failure: 0, the entry goes on.
 for(const whaleZones of [async()=>{throw Error('Binance HTTP 503')},async()=>({ok:false,error:'NOT_ON_BINANCE'}),async()=>({...support,coveragePct:60})]){
  ({ex}=scalp({minScore:base,whaleZones}));
  assert.equal((await ex.scan()).entered,1,'never blocks');
  const w=ex.store.open[0].scalpScore;assert.equal(w.score,base);assert.equal(w.whaleBonus,0);assert.ok([C.UNAVAILABLE,C.PARTIAL].includes(w.whaleCvd.code),w.whaleCvd.code);
 }
 // SCALP_WHALE_CVD=off: no read, no record.
 let called=0;
 ({ex}=scalp({minScore:base,whaleZones:async()=>{called++;return support},config:{whaleCvd:false}}));
 assert.equal((await ex.scan()).entered,1);assert.equal(called,0);assert.equal(ex.store.open[0].scalpScore.whaleCvd,undefined);
});

test('SHORT mirrored: a whale SELL zone over the entry +5; a BUY zone right under it −5 without a SELL zone',async()=>{
 const mirror=rows=>rows.map(r=>[r[0],String(200-Number(r[1])),String(200-Number(r[3])),String(200-Number(r[2])),String(200-Number(r[4])),r[5],r[6],r[7]]);
 const rows=mirror(crash()),det=detectScalpReversal(rows,{symbol:'SOLUSDT',now:T0});
 assert.equal(det.ok,true);assert.equal(det.direction,'SHORT');
 const px=+(det.entry-.02).toFixed(2);
 let {ex}=scalp({minScore:1,rows,px,whaleZones:async()=>zonesAt([[60,500_000,'SELL',+(px*1.0005).toFixed(4)]])});
 assert.equal((await ex.scan()).entered,1,JSON.stringify(ex.store.skips.at(-1)));
 let sc=ex.store.open[0].scalpScore;assert.equal(ex.store.open[0].direction,'SHORT');assert.equal(sc.whaleBonus,5);assert.equal(sc.whaleCvd.support.side,'SELL');
 ({ex}=scalp({minScore:1,rows,px,whaleZones:async()=>zonesAt([[60,500_000,'BUY',+(px*.999).toFixed(4)]])}));
 assert.equal((await ex.scan()).entered,1);sc=ex.store.open[0].scalpScore;assert.equal(sc.whaleBonus,-5);assert.equal(sc.whaleCvd.code,C.RESISTANCE);assert.equal(sc.whaleCvd.resistance.side,'BUY');
});

test('the orderflow / whale read covers every candidate a +5 (with OI + CVD, 15 in all) could lift, and those at the gate (unchanged)',async()=>{
 const base=await baseScore(down4h);assert.ok(base+16<=100,String(base));
 for(const [minScore,want] of [[base+15,1],[base+16,0],[base-3,1]]){
  let whale=0,of=0;
  const {ex}=scalp({minScore,trend:down4h,whaleZones:async()=>{whale++;return {ok:false,error:'x'}},orderflow:async()=>{of++;return null}});
  await ex.scan();
  assert.equal(whale,want,`whale read at gate ${minScore} (base ${base})`);assert.equal(of,want,`orderflow read at gate ${minScore}`);
 }
 // Without the whale reader (or switched off) the range stays gate − 10 (OI + CVD only).
 for(const cfg of [{},{whaleCvd:false}]){
  for(const [minScore,want] of [[base+10,1],[base+11,0]]){
   let of=0;const {ex}=scalp({minScore,trend:down4h,orderflow:async()=>{of++;return null},config:cfg,...(cfg.whaleCvd===false?{whaleZones:async()=>({ok:false})}:{})});
   await ex.scan();assert.equal(of,want,`orderflow read at gate ${minScore}`);
  }
 }
});

test('settings, byWhaleCvd split plus / zero / minus / unavailable (old window-rule trades apart) and the journal summary',async()=>{
 const c=scalpExecConfig({});
 assert.equal(c.whaleCvd,true);assert.equal(c.whaleCvdBonus,5);assert.equal(c.whaleZoneHours,4);assert.equal(c.whaleZoneMaxPages,10);
 assert.equal(scalpExecConfig({SCALP_WHALE_ZONE_HOURS:'12'}).whaleZoneHours,12);assert.equal(scalpExecConfig({SCALP_WHALE_ZONE_HOURS:'48'}).whaleZoneHours,4,'1..24 only');
 assert.equal(scalpExecConfig({SCALP_WHALE_ZONE_MAX_PAGES:'99'}).whaleZoneMaxPages,10);assert.equal(scalpExecConfig({SCALP_WHALE_CVD_BONUS:'9'}).whaleCvdBonus,5,'never more than ±5');
 const ex=new ScalpExecutor({config:scalpExecConfig({}),now:()=>T0});
 const zone=(bonus,code)=>({scalpScore:{score:75,whaleBonus:bonus,whaleCvd:{rule:'ZONES',bonus,code}}});
 const row=(net,extra={})=>({id:'x'+Math.random(),direction:'LONG',netUSD:net,closedAt:T0,closeReason:'ALL_TARGETS',...extra});
 ex.store.closed.push(row(10,zone(5,C.SUPPORT)),row(-4,zone(5,C.SUPPORT)),row(3,zone(0,C.NONE)),row(2,zone(0,C.NO_ZONES)),row(-2,zone(-5,C.RESISTANCE)),
  row(1,zone(0,C.PARTIAL)),row(1,zone(0,C.UNAVAILABLE)),row(7,{scalpScore:{score:75,whaleBonus:5,whaleCvd:{bonus:5,code:WHALE_CVD_CODES.WITH}}}),row(1));
 const st=ex.stats();
 assert.deepEqual(Object.keys(st.byWhaleCvd),['plus','zero','minus','unavailable','unmeasured']);
 assert.equal(st.byWhaleCvd.plus.trades,2);assert.equal(st.byWhaleCvd.plus.netUSD,6);
 assert.equal(st.byWhaleCvd.zero.trades,2,'NONE and NO_ZONES (WEAK-like) are zero');assert.equal(st.byWhaleCvd.minus.trades,1);
 assert.equal(st.byWhaleCvd.unavailable.trades,2,'PARTIAL and UNAVAILABLE apart from zero');
 assert.equal(st.byWhaleCvd.unmeasured.trades,2,'the old window-rule +5 and the no-record trade');
 const S=ex.status().settings;
 assert.equal(S.whaleZoneHours,4);assert.equal(S.whaleZoneBinAtrMult,0.25);assert.equal(S.whaleZoneNearPct,0.4);assert.equal(S.whaleZoneMinCoveragePct,80);assert.equal(S.whaleZoneFloorPurpleMult,2);assert.equal(S.whaleZoneFloorSharePct,5);
 const sum=summarizeJournal([{exit:{reason:'X'},pnl:{netUSD:2},score:{whaleBonus:5,whaleCvd:{rule:'ZONES',code:C.SUPPORT}}},{exit:{reason:'X'},pnl:{netUSD:-1},score:{whaleBonus:-5,whaleCvd:{rule:'ZONES',code:C.RESISTANCE}}},
  {exit:{reason:'X'},pnl:{netUSD:1},score:{whaleBonus:0,whaleCvd:{rule:'ZONES',code:C.PARTIAL}}},{exit:{reason:'X'},pnl:{netUSD:1},score:{whaleBonus:5,whaleCvd:{}}},{exit:{reason:'X'},pnl:{netUSD:1}}]);
 assert.equal(sum.byWhaleCvd.plus.trades,1);assert.equal(sum.byWhaleCvd.minus.trades,1);assert.equal(sum.byWhaleCvd.unavailable.trades,1);assert.equal(sum.byWhaleCvd.unmeasured.trades,2);
});

test('screen: 고래매물대 ±5 item with the zone chip, glossary entries with the live thresholds, the rule line and the stats rows',async()=>{
 const S=new ScalpExecutor({config:scalpExecConfig({})}).status().settings;
 for(const code of [...Object.values(C),'WHALE_ZONE','WHALE_BUY_ZONE','WHALE_SELL_ZONE',...Object.values(WHALE_CVD_CODES)])assert.ok(reasonInfo(code,S),code);
 const d=c=>reasonInfo(c,S).desc;
 assert.match(d('WHALE_ZONE'),/최근 4시간.*ATR×0\.25.*0\.2%.*2배.*5%.*상위 8개.*매수 매물대\(지지\).*매도 매물대\(저항\)/);
 assert.match(d(C.SUPPORT),/ATR×0\.5.*0\.4%.*\+5점/);assert.match(d(C.RESISTANCE),/−5점/);assert.match(d(C.PARTIAL),/80% 미만.*최대 10쪽.*0점/);
 assert.match(d('WHALE_BUY_ZONE'),/2배/);assert.match(d(WHALE_CVD_CODES.WITH),/예전 구간 규칙.*\+5점.*비교 기록만/);
 const item=SCORE_ITEMS.find(([k])=>k==='whaleBonus');assert.equal(item[1],'고래매물대');assert.match(item[3](S),/\+5점.*−5점.*0점/);assert.match(item[3](S),/80%/);assert.match(item[3](S),/\$2만/);
 const g=reasonGlossaryHTML(S);for(const t of ['고래 매물대','고래 매물대 지지','고래 매물대 저항','고래 체결 일부만','고래 매수 매물대 추매','주황 새우','갈색 고래'])assert.ok(g.includes(`>${t}</dt>`),t);
 const breakdown={movePct:15,trend4h:20,btcTrend4h:10,moveAtr:15,retracedPct:5,climaxVolume:5,netRR:0,rsiExtreme:0};
 const end=10*H,snap=await snapOf([[end-H,400_000,'SELL',100.1],[end-H+1,700,'BUY',100]],{end}),zr=buildWhaleZones(snap,{price:100});
 const ev=evaluateWhaleZoneBonus(snap,zr,{direction:'LONG',entry:100});
 const rec=whaleZoneRecord(snap,zr,{...ev,direction:'LONG'});
 assert.equal(rec.bonus,-5);assert.equal(rec.divergence,'DISTRIBUTION','whale sell / shrimp buy recorded');
 const minus=scoreItemsHTML({score:65,minScore:70,breakdown,whaleBonus:-5,whaleCvd:rec},S);
 assert.match(minus,/class="rz-i rz-whale rz-whale-minus"[^>]*>고래매물대 −5</);
 assert.match(minus,/class="wcv wcv-zone wcv-zone-sell">매도 매물대 100\.?\d*~100\.\d+ −\$400K</);assert.match(minus,/4시간 100% 읽음/);
 assert.match(minus,/class="wcv wcv-orange"[^>]*>새우 \+\$700</);
 // An old window-rule record keeps its old label.
 assert.match(scoreItemsHTML({score:70,minScore:70,breakdown,whaleBonus:0,whaleCvd:{bonus:0,code:WHALE_CVD_CODES.UNAVAILABLE}},S),/rz-whale-zero"[^>]*>고래CVD 0</);
 assert.match(skipRowHTML({at:1,symbol:'SOLUSDT',reason:'SCORE_BELOW_MINIMUM',score:65,minScore:70,breakdown,whaleBonus:-5,whaleCvd:rec},S),/고래매물대 −5/);
 assert.match(ladderStepText({step:2,of:6,avg:100,nextAdd:{price:99.8,zone:{kind:'WHALE',why:['WHALE_BUY_ZONE']}}}),/강한 매물대 고래 매수 매물대 추매 · 2배/);
 // The rule line shows the thresholds used and the stats rows include 확인 불가.
 const js=fs.readFileSync(new URL('../public/live_control.js',import.meta.url),'utf8');
 assert.match(js,/고래 매물대 ±\$\{esc\(S\.whaleCvdBonus\?\?5\)\}점/);assert.match(js,/보라 ≥ \$\{esc\(wMan\(WL\.purpleMinUSD\)\)\}/);assert.match(js,/\['plus','zero','minus','unavailable'\]/);
 const css=fs.readFileSync(new URL('../public/styles.css',import.meta.url),'utf8');assert.ok(css.includes('.wcv-zone-buy{'));
});

test('ladder: whale zones on our side count as strong zones for the ×2 step (kind recorded); none from a partial read',async()=>{
 const clock={t:T0};let whaleReads=0,snap=null;
 const v=mockVenue(PX);
 const ex=new ScalpExecutor({config:{...scalpExecConfig({}),minScore:0,makerEntry:false,makerExit:false,dailyLossPct:10,stopLossEnabled:false},client:v.client,
  contracts:async()=>new Map([['SOLUSDT',SOL]]),tickers:async()=>[{symbol:'SOL-USDT',quoteVolume:'90000000'}],
  candles:async(s,iv)=>iv==='5m'?[...crash(),[BUCKET*I,'100','100','100','100','1',BUCKET*I+I-1,'1']]:iv==='1h'?hourly(clock.t):up4h(clock.t),
  zoneCandles:async()=>[],whaleZones:async()=>{whaleReads++;return snap},
  priceOf:async()=>PX,markOf:async()=>PX,balance:async()=>({equity:10000,available:9000}),gate:()=>({ok:true}),isBusy:()=>false,now:()=>clock.t});
 ex.arm();await ex.scan();
 const p=ex.store.open[0];assert.ok(p?.ladder,'a TRADER_LADDER position');assert.equal(whaleReads,0,'no whale read at the entry with the score gate off');
 const f=p.ladder.lastFill,sp=p.ladder.spacingPct;assert.equal(sp,1.5);
 // A whale BUY zone between half a spacing and the spacing level (0.9925 f .. 0.985 f), and a SELL zone (ignored for a LONG).
 const zp=+(f*.9895).toFixed(4);
 snap=await snapOf([[T0-H,800_000,'BUY',zp],[T0-H+1,800_000,'SELL',+(f*.988).toFixed(4)]],{end:T0});
 // Partial read first: no whale zone, add at the spacing level only.
 const partial={...snap,coveragePct:50};const keep=snap;snap=partial;
 v.setMark(+(f*.99).toFixed(2));clock.t+=10_000;await ex.reconcile();
 assert.equal(whaleReads,1);assert.deepEqual(p.ladder.whaleZones.list,[]);assert.equal(p.ladder.whaleZones.code,'WHALE_ZONE_PARTIAL');assert.equal(p.ladder.filled,1,'0.99 f is above the spacing level');
 // A full-coverage read whose newest pages failed (stops 2 min before its end): stale, no whale zone either (review 2026-11-25).
 snap={...keep,coveredToMs:keep.endMs-120_000};clock.t+=6*60_000;await ex.reconcile();
 assert.equal(whaleReads,2);assert.deepEqual(p.ladder.whaleZones.list,[]);assert.equal(p.ladder.whaleZones.code,'WHALE_ZONE_PARTIAL');assert.match(p.ladder.whaleZones.detail,/^STALE 120s/);
 assert.equal(p.ladder.filled,1);
 // Full read (after the 5 min retry): the BUY zone is the add level, step 2 doubled, kind WHALE recorded.
 snap=keep;clock.t+=6*60_000;v.setMark(+(f*.9885).toFixed(2));await ex.reconcile();
 assert.equal(whaleReads,3);assert.equal(p.ladder.whaleZones.list.length,1);assert.equal(p.ladder.whaleZones.list[0].side,'BUY');
 assert.equal(p.ladder.filled,2,JSON.stringify({next:p.ladder.next,last:p.ladder.lastReason}));
 const fill=p.ladder.fills[1];
 assert.equal(fill.zone.kind,'WHALE');assert.deepEqual(fill.zone.why,['WHALE_BUY_ZONE']);assert.ok(fill.boost>0,'×2 step');assert.equal(fill.units,4);
 const ev=ex.store.events.find(e=>e.type==='LADDER_ADD');assert.equal(ev.zone.kind,'WHALE');
 // Read again only after 15 min.
 clock.t+=60_000;v.setMark(+(p.ladder.lastFill*.99).toFixed(2));await ex.reconcile();assert.equal(whaleReads,3);
});

test('server: /api/whale-zones read-only route and the scalp reader on budgetedPublicRead (no binance() side effects)',()=>{
 const src=fs.readFileSync(new URL('../server.mjs',import.meta.url),'utf8');
 const body=src.match(/function scalpWhaleZones\([^)]*\)\{([\s\S]*?)\n\}/)?.[1];
 assert.ok(body,'scalpWhaleZones found');
 assert.match(body,/budgetedPublicRead\(url,\{budget:publicReadBudget,timeoutMs:WHALE_ZONE_DEFAULTS\.timeoutMs\}\)/);
 assert.doesNotMatch(body,/\bbinance\(/,'a failed aggTrades page must not mark the Binance REST offline');
 assert.match(body,/budget:\(\)=>publicReadBudget\.snapshot\(\)/);assert.match(body,/whaleTradeStore\.read\(/);
 const route=src.slice(src.indexOf("pathname==='/api/whale-zones'"),src.indexOf("pathname==='/api/market-commentary'"));
 assert.match(route,/req\.method==='GET'/);assert.match(route,/state\.activeSet\.has\(symbol\)/);assert.match(route,/whaleZonesPayload\(/);
 // Not on Binance is not a 404 (the screen reads 404 as "no endpoint" and stops for 10 min); the screen's pages yield to the score's.
 assert.match(route,/response\(res,422,\{ok:false,symbol,error:'NOT_ON_BINANCE'\}\)/);assert.doesNotMatch(route,/response\(res,404/);
 assert.match(route,/reservePct:WHALE_ZONE_DEFAULTS\.apiReservePct/);assert.equal(WHALE_ZONE_DEFAULTS.apiReservePct,60);
 assert.match(body,/lookbackMs,endMs,maxPages,reservePct\}/);
 assert.doesNotMatch(route,/placeOrder|client\.|\bbinance\(/,'read-only');
 assert.equal((src.match(/whaleZones:\(symbol,o\)=>scalpWhaleZones\(symbol,o\)/g)||[]).length,2,'testnet and the opt-in live scalp');
 assert.doesNotMatch(src,/fetchWhaleCvd/,'the old window fetch is no longer used');
});

test('simulator: a zone-rule ±5 counts on the re-score, the old window rule ±5 (record only now) does not',async()=>{
 const det=detectScalpReversal(crash(),{symbol:'SOLUSDT',now:T0});assert.equal(det.ok,true);
 const rr=1.5,base=scoreScalpSetup({direction:'LONG',evidence:det.evidence,trend4h:'up',btcTrend4h:null,netRR:rr}).score;
 const sig=score=>({symbol:'SOLUSDT',direction:'LONG',barAt:det.barAt,at:T0,kind:'MOVE_REVERSAL',evidence:det.evidence,trend4h:'up',btcTrend4h:null,
  entered:false,reason:'SCORE_BELOW_MINIMUM',plan:{netRR:rr},score});
 const run=(score,minScore)=>simulateScalpSignals({signals:[sig(score)],params:{minScore,minMovePct:2.5,trendMode:'off',days:30},now:T0+1000,includePresets:false}).simulated.unlockedSignals;
 const zone=b=>({score:base+b,whaleBonus:b,whaleCvd:{rule:'ZONES',bonus:b,code:b>0?C.SUPPORT:C.RESISTANCE}});
 assert.equal(run(zone(5),base+3),1,'zone +5 lifts it over');
 assert.equal(run(zone(-5),base-3),0,'zone −5 drops it under');
 assert.equal(run({score:base+5,whaleBonus:5,whaleCvd:{bonus:5,code:WHALE_CVD_CODES.WITH}},base+3),0,'the old window +5 is not re-added');
 assert.equal(run({score:base-5,whaleBonus:-5,whaleCvd:{bonus:-5,code:WHALE_CVD_CODES.AGAINST}},base-3),1,'nor the old window −5');
});

test('record + split helpers: window snapshot from minutes, split keys, defaults never relax the gate',async()=>{
 const end=10*H,snap=await snapOf([[end-10*60_000,300_000,'BUY',100],[end-40*60_000,300_000,'SELL',100]],{end});
 const w=whaleWindowSnapshot(snap,{startMs:end-30*60_000,endMs:end});
 assert.equal(w.ok,true);assert.equal(w.whaleCvdUSD,300_000,'only the last 30 min');assert.equal(w.coveragePct,100);
 assert.equal(whaleSplitOf(null),'unmeasured');assert.equal(whaleSplitOf({whaleCvd:{rule:'ZONES',code:C.SUPPORT},whaleBonus:5}),'plus');
 assert.equal(whaleSplitOf({whaleCvd:{rule:'ZONES',code:C.NO_PRINTS},whaleBonus:0}),'zero');
 assert.equal(WHALE_ZONE_DEFAULTS.minCoveragePct,80);assert.equal(WHALE_ZONE_DEFAULTS.bonus,5);
});
