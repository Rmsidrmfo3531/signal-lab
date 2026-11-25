// 고래 매물대 (whale CVD zones by price). User 2026-11-25 09:51 "단타에선 CVD 활용 방법이 매물대를 보는 거라고 생각하면
// 편할 것 같고", then "진행해". Replaces the 고래 CVD window rule of PR #316 (whale net flow from the move start to now,
// review M3: that window contains the spike itself, so a reversal entry was structurally scored against the spike's own
// prints) with the PRICE LEVELS where the whales (purple + brown, whale_cvd.mjs FireCharts bins, alt-scaled) traded:
//   whale BUY zone  = a price band where whale taker buying beat whale taker selling by a significant amount (support),
//   whale SELL zone = the reverse (resistance).
// The score (±5, same place in the score as before: on the total before the gate and the tier, clamped 0..100):
//   LONG  +5 when a whale BUY zone sits at or under the entry within K (support under us);
//         −5 when a whale SELL zone sits at or over the entry within K (resistance right overhead) and there is no support;
//   SHORT mirrored (SELL zone at / above = +5, BUY zone at / below = −5 without a SELL zone);
//   0 otherwise, and always 0 when the lookback was not read to at least 80 % or the read stops more than 60 s before now
//   (WHALE_ZONE_PARTIAL: never extrapolated, never the old zones).
//
// Source: Binance USDT-M public /fapi/v1/aggTrades (weight 20 a page of 1000). There is no lighter Binance source with a
// per-price split by order size: /futures/data/takerlongshortRatio (taker buy / sell volume per 5m) and the long / short
// ratio endpoints have neither the price nor the order size, klines have the price but not the size, and the depth book
// shows resting orders, not executed taker flow. aggTrades is the only public feed with price, size and taker side.
//
// Data budget: one WhaleTradeStore per process keeps, per symbol, ONLY the whale-class trades (>= the scaled purple edge;
// a few hundred to a few thousand in 4 h even on BTC) and per-minute series sums (for the shrimp / whale record and the
// old window rule kept for comparison). A later read for the same symbol reads only the trades newer than the last id
// (forward, fromId) and then, with the pages left, older ones back to the lookback start. Pages per call are capped
// (SCALP_WHALE_ZONE_MAX_PAGES, default 10 = weight 200), every page goes through the shared PublicReadBudget
// (public_read_budget.mjs budgetedPublicRead, called by the server), paging stops above 60 % of the budget, and no page
// starts after the caller's wait. The same symbol is read again at most every 30 s; an unused symbol is dropped after 15 min.
//
// No orders, no keys: read-only market data and pure math. A failure is 0 points (WHALE_ZONE_UNAVAILABLE), never a block.
import {WHALE_CVD_FIXED,WHALE_CVD_SERIES,WHALE_CVD_SOURCE_NOTE,parseAggTrades,whaleBucketOf} from './whale_cvd.mjs';

export const WHALE_ZONE_DEFAULTS=Object.freeze({
 bonus:5,               // ± points (unchanged from the window rule)
 lookbackHours:4,       // SCALP_WHALE_ZONE_HOURS 1..24
 // Bin width: 0.25 × ATR(1H) as % of the price (bounded 0.05 %..0.5 %); 0.2 % of the price without the ATR.
 binAtrMult:.25,binPctFallback:.2,binMinPct:.05,binMaxPct:.5,
 // K (how near a zone must be to the entry): 0.5 × ATR(1H) (bounded 0.1 %..1 %); 0.4 % without the ATR (= 2 bins either way).
 nearAtrMult:.5,nearPctFallback:.4,nearMinPct:.1,nearMaxPct:1,
 // A bin is a zone candidate when |net| >= max(2 × purple edge, 5 % of all whale notional in the read lookback),
 // and only the 8 largest |net| bins are kept (then adjacent same-side bins merged).
 topN:8,floorPurpleMult:2,floorSharePct:5,
 minCoveragePct:80,     // below this the score is 0 (WHALE_ZONE_PARTIAL)
 // The read must reach within 60 s of now (twice the 30 s memory), else 0 too (WHALE_ZONE_PARTIAL): a newer read that
 // failed (budget, cooldown, error) or did not catch up leaves the newest prints out (review 2026-11-25).
 maxStaleMs:60_000,
 maxPages:10,pageLimit:1000,reservePct:40,
 refreshMs:30_000,      // a symbol read less than 30 s ago is answered from memory
 storeTtlMs:15*60_000,  // a symbol unused for 15 min is dropped
 maxSymbols:40,maxWhaleTrades:20_000,
 timeoutMs:4_000,       // the executor waits at most this long; no page starts after it
 apiReservePct:60,      // GET /api/whale-zones (screen, every 30 s) pages only under 40 % of the budget: the score's reads go first
 windowMaxMs:30*60_000, // the old window rule (record only): from the move start, at most 30 min
 apiZones:12,
});
export const WHALE_ZONE_CODES=Object.freeze({SUPPORT:'WHALE_ZONE_SUPPORT',RESISTANCE:'WHALE_ZONE_RESISTANCE',NONE:'WHALE_ZONE_NONE',NO_ZONES:'WHALE_ZONE_NO_ZONES',
 NO_PRINTS:'WHALE_ZONE_NO_PRINTS',PARTIAL:'WHALE_ZONE_PARTIAL',UNAVAILABLE:'WHALE_ZONE_UNAVAILABLE'});
/** The ladder's strong-zone reason codes (scalp_ladder strong zones are 4H / 1D volume zones; these are the whale ones). */
export const WHALE_LADDER_WHY=Object.freeze({BUY:'WHALE_BUY_ZONE',SELL:'WHALE_SELL_ZONE'});
export const WHALE_ZONE_RULE='ZONES';
const AGG_TRADES_WEIGHT=20;

const fin=v=>v!==null&&v!==undefined&&v!==''&&Number.isFinite(Number(v));
const r0=v=>Math.round(Number(v)||0),r2=v=>Math.round((Number(v)||0)*100)/100,r4=v=>Math.round((Number(v)||0)*1e4)/1e4;
const p8=v=>+Number(v).toPrecision(8);
const clamp=(v,lo,hi)=>Math.max(lo,Math.min(hi,v));
const dirOf=d=>d==='SHORT'?-1:1;

/** SCALP_WHALE_ZONE_HOURS (1..24, default 4) as ms. */
export const whaleZoneLookbackMs=hours=>clamp(fin(hours)?Number(hours):WHALE_ZONE_DEFAULTS.lookbackHours,1,24)*3600_000;
/** Bin width % of the price: 0.25 × ATR(1H) % bounded 0.05..0.5, or 0.2 % without the ATR. */
export function whaleZoneBinPct(atrPct,o={}){
 const D={...WHALE_ZONE_DEFAULTS,...o},a=Number(atrPct);
 return a>0?{pct:r4(clamp(a*D.binAtrMult,D.binMinPct,D.binMaxPct)),source:'ATR_1H'}:{pct:D.binPctFallback,source:'PCT_FALLBACK'};
}
/** K % of the price: 0.5 × ATR(1H) % bounded 0.1..1, or 0.4 % without the ATR. */
export function whaleZoneNearPct(atrPct,o={}){
 const D={...WHALE_ZONE_DEFAULTS,...o},a=Number(atrPct);
 return a>0?{pct:r4(clamp(a*D.nearAtrMult,D.nearMinPct,D.nearMaxPct)),source:'ATR_1H'}:{pct:D.nearPctFallback,source:'PCT_FALLBACK'};
}

const emptySeries=()=>Object.fromEntries([...WHALE_CVD_SERIES,'dust'].map(k=>[k,{buyUSD:0,sellUSD:0,count:0}]));
const addTo=(s,t)=>{if(t.side==='BUY')s.buyUSD+=t.notionalUSD;else s.sellUSD+=t.notionalUSD;s.count++};
/** Sum per-minute rows [{at, scaled, fixed}] in [startMs, endMs] into the whale_cvd.mjs bucket shape. */
function sumMinutes(minutes,startMs,endMs,key){
 const acc=emptySeries();
 for(const m of minutes)if(m.at+60_000>startMs&&m.at<=endMs)for(const k of Object.keys(acc)){const s=m[key][k];acc[k].buyUSD+=s.buyUSD;acc[k].sellUSD+=s.sellUSD;acc[k].count+=s.count}
 const out={};for(const k of Object.keys(acc))out[k]={cvdUSD:r0(acc[k].buyUSD-acc[k].sellUSD),buyUSD:r0(acc[k].buyUSD),sellUSD:r0(acc[k].sellUSD),count:acc[k].count};
 const {dust,...buckets}=out;
 return {buckets,dustCount:dust.count,whaleCvdUSD:buckets.purple.cvdUSD+buckets.brown.cvdUSD,whaleCount:buckets.purple.count+buckets.brown.count,
  shrimpCvdUSD:buckets.orange.cvdUSD,totalNotionalUSD:r0(buckets.blue.buyUSD+buckets.blue.sellUSD),trades:buckets.blue.count};
}

/** The stored state of one symbol. Ids are contiguous from firstId to lastId (forward reads never skip). */
function newEntry(symbol,thresholds,now){
 return {symbol,thresholds,firstId:null,firstAt:null,lastId:null,lastAt:null,caughtUpAt:null,reachedStart:false,cappedFromAt:null,whale:[],minutes:new Map(),usedAt:now,refreshedAt:0,pages:0,snapshot:null,pending:null};
}
/** Rows sorted by id. `older`: a backward page (its trades are older than all stored ones). The whale list stays in id
 * (= time) order: older pages go in front (review 2026-11-25: they were appended, so prune() stopped at the first page's
 * trades and the cap below dropped the NEWEST trades while the coverage still said 100 %). */
function addTrades(e,rows,{older=false,max=WHALE_ZONE_DEFAULTS.maxWhaleTrades}={}){
 const whales=[];
 for(const t of rows){
  const m=Math.floor(t.at/60_000)*60_000;let row=e.minutes.get(m);
  if(!row){row={at:m,scaled:emptySeries(),fixed:emptySeries()};e.minutes.set(m,row)}
  const b=whaleBucketOf(t.notionalUSD,e.thresholds);
  addTo(row.scaled[b],t);addTo(row.scaled.blue,t);addTo(row.fixed[whaleBucketOf(t.notionalUSD,WHALE_CVD_FIXED)],t);addTo(row.fixed.blue,t);
  if(b==='purple'||b==='brown')whales.push({id:t.id,at:t.at,price:t.price,notionalUSD:t.notionalUSD,side:t.side,bucket:b});
 }
 if(whales.length)e.whale=older?whales.concat(e.whale):e.whale.concat(whales);
 // Over the cap the OLDEST go, and the coverage then starts at the oldest whale trade kept (no older page is read again).
 if(e.whale.length>max){e.whale.splice(0,e.whale.length-max);e.cappedFromAt=Math.max(Number(e.cappedFromAt)||0,e.whale[0].at)}
}
function prune(e,before){
 if(e.whale.length&&e.whale[0].at<before)e.whale=e.whale.filter(t=>t.at>=before);
 for(const k of e.minutes.keys())if(k+60_000<=before)e.minutes.delete(k);
}
/** A thresholds set far from the stored one (the purple edge moved by more than 25 %) starts the symbol again. */
const sameEdges=(a,b)=>{const x=Number(a?.purpleMinUSD),y=Number(b?.purpleMinUSD);return x>0&&y>0&&x/y<=1.25&&y/x<=1.25};

/** The snapshot of a symbol over [startMs, endMs]: coverage, whale trades (for the zones), series sums (record). */
function snapshotOf(e,{startMs,endMs,pages=0,stopped=null,cached=false}){
 const from=Math.max(e.reachedStart?startMs:Math.max(startMs,Number(e.firstAt)||endMs),Number(e.cappedFromAt)||-Infinity);
 // Covered up to the moment the last forward read came back short (nothing newer then), else to the newest trade read.
 // Never "to now" by itself: a later read that failed (budget, cooldown, error) does not move it (review 2026-11-25:
 // it claimed 100 % on hours-old trades while every newer read failed).
 const to=Math.min(endMs,Math.max(Number(e.lastAt)||startMs,Number(e.caughtUpAt)||0));
 const span=endMs-startMs,coveragePct=span>0?r2(clamp((to-from)/span,0,1)*100):0;
 const minutes=[...e.minutes.values()].filter(m=>m.at+60_000>startMs&&m.at<=endMs).sort((a,b)=>a.at-b.at);
 const scaled=sumMinutes(minutes,startMs,endMs,'scaled'),fixed=sumMinutes(minutes,startMs,endMs,'fixed');
 const whaleTrades=e.whale.filter(t=>t.at>=startMs&&t.at<=endMs);
 return {ok:true,rule:WHALE_ZONE_RULE,source:'BINANCE_AGG_TRADES',sourceNote:WHALE_CVD_SOURCE_NOTE,symbol:e.symbol,startMs,endMs,lookbackMin:r2(span/60000),
  coveredFromMs:from,coveredToMs:to,staleMs:Math.max(0,endMs-to),coveragePct,complete:coveragePct>=99.9,pages,weight:pages*AGG_TRADES_WEIGHT,totalPages:e.pages,cached,...(stopped?{stopped}:{}),
  thresholds:e.thresholds,...scaled,fixed:{thresholds:{...WHALE_CVD_FIXED},buckets:fixed.buckets,whaleCvdUSD:fixed.whaleCvdUSD,whaleCount:fixed.whaleCount},
  whaleTrades,minutes};
}

/**
 * Per-symbol whale trade memory with incremental Binance aggTrades reads. One instance per process (the server's).
 * read() never throws: {ok:false,error} when nothing could be read at all.
 */
export class WhaleTradeStore{
 constructor({now=Date.now,refreshMs=WHALE_ZONE_DEFAULTS.refreshMs,ttlMs=WHALE_ZONE_DEFAULTS.storeTtlMs,maxSymbols=WHALE_ZONE_DEFAULTS.maxSymbols,maxWhaleTrades=WHALE_ZONE_DEFAULTS.maxWhaleTrades}={}){
  Object.assign(this,{now,refreshMs,ttlMs,maxSymbols,maxWhaleTrades});this.entries=new Map();
 }
 clear(){this.entries.clear()}
 /** Memory per symbol, for the status screen. */
 summary(){return [...this.entries.values()].map(e=>({symbol:e.symbol,whaleTrades:e.whale.length,minutes:e.minutes.size,firstAt:e.firstAt,lastAt:e.lastAt,reachedStart:e.reachedStart,pages:e.pages,usedAt:e.usedAt}))}
 /** Only what is in memory (no read): the last snapshot of a symbol, or null. */
 peek(symbol){return this.entries.get(String(symbol||'').toUpperCase())?.snapshot??null}
 /**
  * request(route) -> parsed JSON (the server's budgetedPublicRead: weight reserved, cooldown, timeout); throws on failure.
  * budget() -> PublicReadBudget.snapshot(), optional: no page when above (100 − reservePct) % or in a cooldown.
  */
 async read(symbol,{request,budget=null,thresholds=WHALE_CVD_FIXED,lookbackMs=whaleZoneLookbackMs(),endMs=null,maxPages=WHALE_ZONE_DEFAULTS.maxPages,
  pageLimit=WHALE_ZONE_DEFAULTS.pageLimit,reservePct=WHALE_ZONE_DEFAULTS.reservePct,deadlineMs=WHALE_ZONE_DEFAULTS.timeoutMs}={}){
  const sym=String(symbol||'').toUpperCase();
  if(!/^[A-Z0-9]{2,30}USDT$/.test(sym))return {ok:false,error:'BAD_SYMBOL'};
  if(typeof request!=='function')return {ok:false,error:'NO_REQUEST'};
  const t0=this.now(),end=fin(endMs)?Number(endMs):t0,look=clamp(Number(lookbackMs)||whaleZoneLookbackMs(),3600_000,24*3600_000),start=end-look;
  for(const [k,v] of this.entries)if(t0-v.usedAt>this.ttlMs&&!v.pending)this.entries.delete(k);
  let e=this.entries.get(sym);
  // Edges moved (24h volume changed a lot), or nothing read since before the lookback: start over.
  if(e&&!e.pending&&(!sameEdges(e.thresholds,thresholds)||!(Number(e.lastAt)>=start)))e=null;
  // Most recently used last: the eviction below drops the least recently used symbol, never one being read.
  if(e){this.entries.delete(sym);this.entries.set(sym,e);e.usedAt=t0}
  // A read of this symbol already running: its result (a failure of it is {ok:false}, never a rejection).
  if(e?.pending)return e.pending.catch(err=>({ok:false,error:String(err?.message||err).slice(0,80)}));
  if(e&&t0-e.refreshedAt<this.refreshMs&&e.snapshot)return {...snapshotOf(e,{startMs:start,endMs:end,cached:true})};
  if(!e){e=newEntry(sym,thresholds,t0);this.entries.delete(sym);this.entries.set(sym,e)}
  for(const [k,v] of this.entries){if(this.entries.size<=this.maxSymbols)break;if(k!==sym&&!v.pending)this.entries.delete(k)}
  e.usedAt=t0;
  const entry=e,maxWhale=Math.max(1,Math.floor(Number(this.maxWhaleTrades)||WHALE_ZONE_DEFAULTS.maxWhaleTrades));
  // Only this read's own entry is dropped on a failure (another read may have started a new one meanwhile).
  const drop=()=>{if(this.entries.get(sym)===entry)this.entries.delete(sym)};
  const task=(async()=>{
   const pages=Math.max(1,Math.min(30,Math.floor(Number(maxPages)||1))),limit=Math.max(100,Math.min(1000,Math.floor(Number(pageLimit)||1000)));
   const deadline=Math.max(500,Number(deadlineMs)||WHALE_ZONE_DEFAULTS.timeoutMs);
   const room=()=>{if(typeof budget!=='function')return true;const s=budget()||{};const max=Number(s.maxWeightPerMinute)||0;
    if(Number(s.cooldownUntil)>this.now())return false;return !(max>0)||(Number(s.usedWeight)||0)+AGG_TRADES_WEIGHT<=max*(1-clamp(Number(reservePct)||0,0,90)/100)};
   let read=0,stopped=null,firstError=null;
   const page=async route=>{
    if(read>0&&this.now()-t0>=deadline){stopped='DEADLINE';return null}
    if(!room()){stopped='BUDGET';return null}
    const at=this.now();
    try{const rows=parseAggTrades(await request(route));read++;entry.pages++;return {rows,at}}
    catch(err){stopped=String(err?.message||err).slice(0,80);firstError??=stopped;return null}
   };
   const base=`/fapi/v1/aggTrades?symbol=${encodeURIComponent(sym)}&limit=${limit}`;
   // 1) Forward: the trades after the last id, until a short page (caught up) or out of pages.
   if(entry.lastId!=null){
    while(read<pages){
     const r=await page(`${base}&fromId=${entry.lastId+1}`);if(!r)break;
     const fresh=r.rows.filter(t=>t.id>entry.lastId).sort((a,b)=>a.id-b.id);
     if(fresh.length){addTrades(entry,fresh,{max:maxWhale});entry.lastId=fresh.at(-1).id;entry.lastAt=Math.max(Number(entry.lastAt)||0,...fresh.map(t=>t.at))}
     if(r.rows.length<limit){entry.caughtUpAt=r.at;break}
    }
   }else{
    // First read of the symbol: the newest page (caught up at that moment by definition).
    const r=await page(base);
    if(r){
     const rows=r.rows.sort((a,b)=>a.id-b.id);
     if(rows.length){addTrades(entry,rows,{max:maxWhale});entry.firstId=rows[0].id;entry.firstAt=Math.min(...rows.map(t=>t.at));entry.lastId=rows.at(-1).id;entry.lastAt=Math.max(...rows.map(t=>t.at))}
     else{entry.reachedStart=true}
     entry.caughtUpAt=r.at;
     if(rows.length<limit||entry.firstId<=0)entry.reachedStart=true;
    }
   }
   // 2) Backward: older trades with the pages left, back to the lookback start.
   while(read<pages&&!entry.reachedStart&&entry.cappedFromAt==null&&entry.firstId!=null){
    if(entry.firstAt<=start){entry.reachedStart=true;break}
    const r=await page(`${base}&fromId=${Math.max(0,entry.firstId-limit)}`);if(!r)break;
    const older=r.rows.filter(t=>t.id<entry.firstId).sort((a,b)=>a.id-b.id);
    if(!older.length){entry.reachedStart=true;break}
    addTrades(entry,older,{older:true,max:maxWhale});entry.firstId=older[0].id;entry.firstAt=Math.min(entry.firstAt,...older.map(t=>t.at));
    if(entry.firstAt<=start||entry.firstId<=0)entry.reachedStart=true;
   }
   if(entry.firstAt!=null&&entry.firstAt<=start)entry.reachedStart=true;
   prune(entry,start);
   if(entry.lastId==null){drop();return {ok:false,error:firstError||stopped||'NO_PAGE'}}
   entry.refreshedAt=t0;
   const snap=snapshotOf(entry,{startMs:start,endMs:end,pages:read,stopped});
   entry.snapshot={...snap,minutes:undefined,whaleTrades:undefined};
   return snap;
  })();
  entry.pending=task;
  try{return await task}
  catch(err){drop();return {ok:false,error:String(err?.message||err).slice(0,80)}}
  finally{entry.pending=null}
 }
}

/** The old window rule's snapshot (whale_cvd.mjs summarizeWhaleCvd shape) from the stored minutes, for comparison only. */
export function whaleWindowSnapshot(snap,{startMs,endMs}){
 if(!snap?.ok)return {ok:false,error:snap?.error||'NO_DATA'};
 const s=Math.max(Number(startMs),Number(snap.startMs)),e=Math.min(Number(endMs),Number(snap.endMs));
 if(!(e>s))return {ok:false,error:'BAD_WINDOW'};
 const minutes=Array.isArray(snap.minutes)?snap.minutes:[];
 const scaled=sumMinutes(minutes,s,e,'scaled'),fixed=sumMinutes(minutes,s,e,'fixed');
 const from=Math.max(s,Number(snap.coveredFromMs)||s),to=Math.min(e,Number(snap.coveredToMs)||e);
 return {ok:true,source:'BINANCE_AGG_TRADES',sourceNote:WHALE_CVD_SOURCE_NOTE,symbol:snap.symbol,startMs:s,endMs:e,windowMin:r2((e-s)/60000),
  coveredFromMs:from,coveragePct:r2(clamp((to-from)/(e-s),0,1)*100),complete:from<=s&&to>=e,pages:0,thresholds:snap.thresholds,...scaled,
  fixed:{thresholds:{...WHALE_CVD_FIXED},buckets:fixed.buckets,whaleCvdUSD:fixed.whaleCvdUSD,whaleCount:fixed.whaleCount}};
}

/**
 * Whale zones from a snapshot. Bins of width binPct % of `price` on a grid from 0 (index = floor(trade price / width));
 * per bin the whale (purple + brown, scaled edges) taker buy and sell notional and the net. A bin is kept when its |net| is
 * among the topN largest and >= floorUSD = max(floorPurpleMult × purple edge, floorSharePct % of all whale notional read);
 * kept bins next to each other with the same sign are merged into one zone. net > 0: BUY zone (support), < 0: SELL zone.
 */
export function buildWhaleZones(snap,{price,atrPct=null,...o}={}){
 const D={...WHALE_ZONE_DEFAULTS,...o};
 if(!snap?.ok)return {ok:false,error:snap?.error||'NO_DATA',zones:[]};
 const px=Number(price)>0?Number(price):Number(snap.whaleTrades?.at?.(-1)?.price)||0;
 const bin=whaleZoneBinPct(atrPct,D),purple=Number(snap.thresholds?.purpleMinUSD)||WHALE_CVD_FIXED.purpleMinUSD;
 const trades=Array.isArray(snap.whaleTrades)?snap.whaleTrades:[];
 const whaleNotionalUSD=trades.reduce((t,x)=>t+x.notionalUSD,0);
 const floorByPurple=D.floorPurpleMult*purple,floorByShare=D.floorSharePct/100*whaleNotionalUSD;
 const floorUSD=r0(Math.max(floorByPurple,floorByShare));
 const base={ok:true,price:px>0?p8(px):null,binPct:bin.pct,binSource:bin.source,binWidth:null,purpleMinUSD:purple,floorUSD,floorSource:floorByShare>floorByPurple?'NOTIONAL_SHARE':'PURPLE_EDGE',
  floorPurpleMult:D.floorPurpleMult,floorSharePct:D.floorSharePct,topN:D.topN,whaleNotionalUSD:r0(whaleNotionalUSD),whaleTrades:trades.length,bins:0,zones:[]};
 if(!(px>0)||!trades.length)return base;
 const width=px*bin.pct/100,bins=new Map();
 for(const t of trades){
  const i=Math.floor(t.price/width);let b=bins.get(i);
  if(!b){b={i,buyUSD:0,sellUSD:0,count:0};bins.set(i,b)}
  if(t.side==='BUY')b.buyUSD+=t.notionalUSD;else b.sellUSD+=t.notionalUSD;b.count++;
 }
 const kept=[...bins.values()].map(b=>({...b,netUSD:b.buyUSD-b.sellUSD})).filter(b=>Math.abs(b.netUSD)>=floorUSD&&b.netUSD!==0)
  .sort((a,b)=>Math.abs(b.netUSD)-Math.abs(a.netUSD)).slice(0,Math.max(1,Math.floor(D.topN))).sort((a,b)=>a.i-b.i);
 const zones=[];
 for(const b of kept){
  const last=zones.at(-1),side=b.netUSD>0?'BUY':'SELL';
  if(last&&last.side===side&&last.hi===b.i-1){last.hi=b.i;last.buyUSD+=b.buyUSD;last.sellUSD+=b.sellUSD;last.netUSD+=b.netUSD;last.count+=b.count;last.bins++;continue}
  zones.push({side,lo:b.i,hi:b.i,buyUSD:b.buyUSD,sellUSD:b.sellUSD,netUSD:b.netUSD,count:b.count,bins:1});
 }
 return {...base,binWidth:p8(width),bins:bins.size,zones:zones.map(z=>({side:z.side,low:p8(z.lo*width),high:p8((z.hi+1)*width),netUSD:r0(z.netUSD),buyUSD:r0(z.buyUSD),sellUSD:r0(z.sellUSD),count:z.count,bins:z.bins}))};
}

/**
 * Whether a snapshot may be used at all (score, ladder, API bands): read, at least minCoveragePct of the lookback (never
 * under 80), and reaching within maxStaleMs (never over 60 s) of its end. {usable:true} or {usable:false,code,detail}.
 */
export function whaleSnapshotUsable(snap,{minCoveragePct=WHALE_ZONE_DEFAULTS.minCoveragePct,maxStaleMs=WHALE_ZONE_DEFAULTS.maxStaleMs}={}){
 const C=WHALE_ZONE_CODES;
 if(!snap?.ok)return {usable:false,code:C.UNAVAILABLE,detail:snap?.error||'NO_DATA'};
 const minCov=Math.max(WHALE_ZONE_DEFAULTS.minCoveragePct,Number(minCoveragePct)||0);
 if(!(Number(snap.coveragePct)>=minCov))return {usable:false,code:C.PARTIAL,detail:`${snap.coveragePct}% < ${minCov}%`};
 const maxStale=Math.min(WHALE_ZONE_DEFAULTS.maxStaleMs,Number(maxStaleMs)>0?Number(maxStaleMs):WHALE_ZONE_DEFAULTS.maxStaleMs);
 const lag=Number(snap.endMs)-Number(snap.coveredToMs);
 if(!(lag<=maxStale))return {usable:false,code:C.PARTIAL,detail:`STALE ${Number.isFinite(lag)?Math.round(lag/1000):'?'}s > ${maxStale/1000}s`};
 return {usable:true};
}

/** Zones near a price within K (% of the price): `under` = at or below (low <= price, price − high <= K),
 * `over` = at or above (high >= price, low − price <= K); the nearest first. */
export function zonesNear(zones,price,nearPct){
 const px=Number(price),k=px*Number(nearPct)/100,list=Array.isArray(zones)?zones:[];
 const dist=z=>z.low>px?z.low-px:z.high<px?px-z.high:0;
 const under=list.filter(z=>z.low<=px&&px-z.high<=k).sort((a,b)=>dist(a)-dist(b));
 const over=list.filter(z=>z.high>=px&&z.low-px<=k).sort((a,b)=>dist(a)-dist(b));
 return {under,over,dist};
}

/**
 * ± points for a trade direction at `entry` from a snapshot and its zones.
 * LONG: support = a BUY zone at or under the entry within K -> +bonus; else resistance = a SELL zone at or over it within
 * K -> −bonus; else 0. SHORT: support = a SELL zone at or over the entry within K, resistance = a BUY zone at or under it.
 * Coverage under minCoveragePct or a read older than maxStaleMs (whaleSnapshotUsable), no data, no whale prints or no zone:
 * 0 (codes PARTIAL / UNAVAILABLE / NO_PRINTS / NO_ZONES).
 */
export function evaluateWhaleZoneBonus(snap,zr,{direction,entry,atrPct=null,...o}={}){
 const D={...WHALE_ZONE_DEFAULTS,...o};
 const pts=clamp(fin(D.bonus)?Number(D.bonus):WHALE_ZONE_DEFAULTS.bonus,0,5),near=whaleZoneNearPct(atrPct,D);
 const C=WHALE_ZONE_CODES,minCov=Math.max(80,Number(D.minCoveragePct)||80);
 const head={nearPct:near.pct,nearSource:near.source,minCoveragePct:minCov};
 if(!snap?.ok)return {...head,available:false,bonus:0,code:C.UNAVAILABLE,detail:snap?.error||'NO_DATA'};
 const cov={...head,available:true,coveragePct:snap.coveragePct};
 const use=whaleSnapshotUsable(snap,{minCoveragePct:minCov});
 if(!use.usable)return {...cov,available:false,bonus:0,code:C.PARTIAL,detail:use.detail};
 if(!(snap.whaleTrades?.length>0||Number(snap.whaleCount)>0))return {...cov,bonus:0,code:C.NO_PRINTS};
 if(!zr?.ok||!zr.zones?.length)return {...cov,bonus:0,code:C.NO_ZONES};
 const px=Number(entry)>0?Number(entry):Number(zr.price);
 if(!(px>0))return {...cov,available:false,bonus:0,code:C.UNAVAILABLE,detail:'NO_ENTRY_PRICE'};
 const d=dirOf(direction),{under,over,dist}=zonesNear(zr.zones,px,near.pct);
 const sup=(d>0?under.filter(z=>z.side==='BUY'):over.filter(z=>z.side==='SELL'))[0]??null;
 const res=(d>0?over.filter(z=>z.side==='SELL'):under.filter(z=>z.side==='BUY'))[0]??null;
 const brief=z=>z?{side:z.side,low:z.low,high:z.high,netUSD:z.netUSD,distPct:r4(dist(z)/px*100)}:null;
 const out={...cov,entry:p8(px),support:brief(sup),resistance:brief(res)};
 if(sup)return {...out,bonus:pts,code:C.SUPPORT};
 if(res)return {...out,bonus:-pts,code:C.RESISTANCE};
 return {...out,bonus:0,code:C.NONE};
}

const sign=v=>v>0?1:v<0?-1:0;
/** The shrimp (orange) vs whale (purple + brown) divergence over the lookback: record only. */
export function whaleShrimpDivergence(snap,direction){
 const w=Number(snap?.whaleCvdUSD)||0,s=Number(snap?.buckets?.orange?.cvdUSD)||0;
 const divergence=sign(w)!==0&&sign(s)!==0&&sign(w)!==sign(s)?(w>0?'ACCUMULATION':'DISTRIBUTION'):null;
 return {whaleCvdUSD:w,shrimpCvdUSD:s,divergence,shrimpDivergence:divergence!==null&&sign(w)===dirOf(direction)};
}

/**
 * The record kept per candidate / trade / skip (scalpScore.whaleCvd): rule 'ZONES', the bonus and why, coverage, the
 * thresholds used (scaled purple edge, bin, K, floor), the zones (largest |net| first, at most 6), the series sums of the
 * lookback and, under `window`, the old window rule's result (comparison only, never scored).
 */
export function whaleZoneRecord(snap,zr,ev,{window=null,maxZones=6}={}){
 const e=ev||{available:false,bonus:0,code:WHALE_ZONE_CODES.UNAVAILABLE};
 const out={rule:WHALE_ZONE_RULE,bonus:e.bonus||0,code:e.code,sourceNote:WHALE_CVD_SOURCE_NOTE,nearPct:e.nearPct??null,nearSource:e.nearSource??null,minCoveragePct:e.minCoveragePct??WHALE_ZONE_DEFAULTS.minCoveragePct,
  ...(window?{window}:{})};
 if(!snap?.ok)return {...out,detail:e.detail??snap?.error??null};
 const T=snap.thresholds||{},brief=b=>Object.fromEntries(WHALE_CVD_SERIES.map(k=>[k,{cvdUSD:b[k].cvdUSD,count:b[k].count}]));
 const zones=(zr?.zones||[]).slice().sort((a,b)=>Math.abs(b.netUSD)-Math.abs(a.netUSD)).slice(0,maxZones);
 return {...out,...(e.detail?{detail:e.detail}:{}),coveragePct:snap.coveragePct,lookbackMin:snap.lookbackMin,coveredFromMs:snap.coveredFromMs,endMs:snap.endMs,pages:snap.pages,weight:snap.weight,cached:snap.cached===true,
  entry:e.entry??null,support:e.support??null,resistance:e.resistance??null,
  binPct:zr?.binPct??null,binSource:zr?.binSource??null,floorUSD:zr?.floorUSD??null,floorSource:zr?.floorSource??null,whaleNotionalUSD:zr?.whaleNotionalUSD??null,whaleTrades:zr?.whaleTrades??null,zones,
  thresholds:{mode:T.mode??'fixed',source:T.source??'FIXED',factor:T.factor??1,orangeMinUSD:T.orangeMinUSD,greenMinUSD:T.greenMinUSD,redMinUSD:T.redMinUSD,purpleMinUSD:T.purpleMinUSD,brownMinUSD:T.brownMinUSD,brownMaxUSD:T.brownMaxUSD},
  buckets:brief(snap.buckets),totalNotionalUSD:snap.totalNotionalUSD,trades:snap.trades,...whaleShrimpDivergence(snap,e.direction),
  fixed:{whaleCvdUSD:snap.fixed?.whaleCvdUSD??null}};
}

/** Stats split of a trade's score object: plus / zero / minus, unavailable (no data or under 80 % read), and unmeasured
 * (no zone record: before this rule, including the old window rule's trades, which are kept apart). */
export const WHALE_SPLIT_KEYS=Object.freeze(['plus','zero','minus','unavailable','unmeasured']);
export function whaleSplitOf(score){
 const r=score&&typeof score==='object'?score.whaleCvd:null;
 if(!r||typeof r!=='object'||r.rule!==WHALE_ZONE_RULE)return 'unmeasured';
 if(r.code===WHALE_ZONE_CODES.UNAVAILABLE||r.code===WHALE_ZONE_CODES.PARTIAL)return 'unavailable';
 const b=Number(score.whaleBonus??r.bonus)||0;
 return b>0?'plus':b<0?'minus':'zero';
}

/** The ladder's whale strong zones for a direction: LONG adds below on whale BUY zones (support), SHORT above on SELL zones.
 * In the scalp_ladder strongZones shape, with kind 'WHALE' (the 4H / 1D ones are kind 'VOLUME'). */
export function whaleLadderZones(zr,direction){
 const side=direction==='SHORT'?'SELL':'BUY';
 return (zr?.ok?zr.zones:[]).filter(z=>z.side===side).map(z=>({low:z.low,high:z.high,tf:'whale',kind:'WHALE',side:z.side,netUSD:z.netUSD,rank:null,sharePct:null,rejections:0,why:[WHALE_LADDER_WHY[side]]}));
}

/**
 * The read-only API shape (GET /api/whale-zones?symbol=): zones with price range, side and net, the thresholds and coverage.
 * Contract of the PR #318 screen (public/orderflow_ui.js parseWhaleZones): zones[].{low, high, side 'BUY'|'SELL', net = signed
 * USD}; `netUSD` is the same value. A partial or stale read (whaleSnapshotUsable, as the score and the ladder) gives no zones
 * (`hiddenZones` counts them): the screen has no partial flag and would draw them as the full lookback's (review 2026-11-25).
 */
export function whaleZonesPayload(snap,zr,{atrPct=null,maxZones=WHALE_ZONE_DEFAULTS.apiZones,minCoveragePct=WHALE_ZONE_DEFAULTS.minCoveragePct}={}){
 if(!snap?.ok)return {ok:false,error:snap?.error||'NO_DATA'};
 const near=whaleZoneNearPct(atrPct),partial=!whaleSnapshotUsable(snap,{minCoveragePct}).usable;
 const zones=(zr?.zones||[]).slice().sort((a,b)=>Math.abs(b.netUSD)-Math.abs(a.netUSD)).slice(0,maxZones).sort((a,b)=>a.low-b.low);
 return {ok:true,symbol:snap.symbol,rule:WHALE_ZONE_RULE,source:snap.source,sourceNote:snap.sourceNote,startMs:snap.startMs,endMs:snap.endMs,lookbackMin:snap.lookbackMin,
  coveragePct:snap.coveragePct,staleMs:snap.staleMs??null,partial,cached:snap.cached===true,price:zr?.price??null,atrPct:fin(atrPct)?r4(atrPct):null,
  binPct:zr?.binPct??null,binSource:zr?.binSource??null,nearPct:near.pct,floorUSD:zr?.floorUSD??null,purpleMinUSD:zr?.purpleMinUSD??null,brownMinUSD:snap.thresholds?.brownMinUSD??null,
  scale:{mode:snap.thresholds?.mode??'fixed',source:snap.thresholds?.source??'FIXED',factor:snap.thresholds?.factor??1},
  whaleNotionalUSD:zr?.whaleNotionalUSD??null,whaleCvdUSD:snap.whaleCvdUSD,shrimpCvdUSD:snap.shrimpCvdUSD,
  hiddenZones:partial?zones.length:0,
  zones:partial?[]:zones.map(z=>({low:z.low,high:z.high,side:z.side,net:z.netUSD,netUSD:z.netUSD,buyUSD:z.buyUSD,sellUSD:z.sellUSD,count:z.count}))};
}

const usd=v=>{const x=Number(v)||0,a=Math.abs(x),s=x>0?'+':x<0?'−':'';return a>=1e6?`${s}$${+(a/1e6).toFixed(2)}M`:a>=1e3?`${s}$${+(a/1e3).toFixed(1)}K`:`${s}$${Math.round(a)}`};
const pxs=v=>{const x=Number(v);return !(x>0)?'—':x>=1000?x.toLocaleString('en-US',{maximumFractionDigits:2}):x>=1?String(+x.toFixed(4)):String(+x.toPrecision(4))};
/** "고래매물대 +5 (매수 매물대 94.1~94.3 +$1.2M · 진입과 0.12% · 4시간 96% 읽음)" for Telegram and the journal. */
export function whaleZoneSummaryKo(rec){
 if(!rec)return '';
 const b=Number(rec.bonus)||0,head=`고래매물대 ${b>0?'+':b<0?'−':''}${Math.abs(b)}`;
 if(rec.coveragePct==null)return `${head} (자료 없음)`;
 const read=` · ${+(Number(rec.lookbackMin)/60).toFixed(1)}시간 ${rec.coveragePct}% 읽음`;
 const z=rec.code===WHALE_ZONE_CODES.SUPPORT?rec.support:rec.code===WHALE_ZONE_CODES.RESISTANCE?rec.resistance:null;
 if(rec.code===WHALE_ZONE_CODES.PARTIAL)return `${head} (일부만 읽음${read})`;
 if(!z)return `${head} (가까운 고래 매물대 없음${read})`;
 return `${head} (${z.side==='BUY'?'매수':'매도'} 매물대 ${pxs(z.low)}~${pxs(z.high)} ${usd(z.netUSD)} · 진입과 ${z.distPct}%${read})`;
}
export const whaleZoneUsd=usd;
