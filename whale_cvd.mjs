// 고래 CVD (user 2026-11-25 09:05 "CVD 관련으로 갈색 고래, 보라 고래, 빨강 고래 등이 뭔지 찾아보고 적용해줘",
// 09:12 "(나) 진행" = apply it to the reversal-scalp score now as ±5, not record-only first; 09:20 FireCharts legend screenshot).
//
// Material Indicators FireCharts 분류: CVD binned by the size of each market (taker) order (legend of the user's screenshot):
//   주황 orange "새우" (shrimp) $100 ~ $1,000
//   초록 green               $1,000 ~ $10,000
//   빨강 red                 $10,000 ~ $100,000
//   보라 purple              $100,000 ~ $1,000,000   (MI: historically the most influence on BTC price)
//   갈색 brown "고래" (whale) $1,000,000 ~ $10,000,000 (a rare order above $10M is kept in brown, not dropped)
//   파랑 blue                All Orders (the total CVD; orders under $100 count only here)
// The screenshot's reading: 고래 CVD 증가 = 매집 경향, 새우 CVD 감소 = 매도 경향 (orange vs brown is the pair to compare).
// Scored: whale = purple + brown. Recorded: all six series and the shrimp-vs-whale divergence (no extra points).
//
// Data: Binance USDT-M public /fapi/v1/aggTrades on the server's shared PublicReadBudget (the caller passes `request`
// = public_read_budget.mjs budgetedPublicRead, which reserves the weight, 20 per page, without touching the scanner's
// REST state or cache). An aggTrade merges the fills of ONE taker order
// at ONE price, so price × qty approximates the order size; an order that swept several price levels is split into
// several aggTrades (it can land in a smaller bucket), and orders split by the trader (TWAP / iceberg) are counted as
// the pieces. `m` true = the buyer was the maker = the taker SOLD.
//
// No orders, no keys: read-only market data and pure math. Any failure gives bonus 0 (WHALE_CVD_UNAVAILABLE), never a block.

export const WHALE_CVD_SOURCE_NOTE='Material Indicators FireCharts 분류';
/** MI's fixed lower edges (USD per taker order); brownMaxUSD is the legend's top (kept for the record). */
export const WHALE_CVD_FIXED=Object.freeze({orangeMinUSD:100,greenMinUSD:1_000,redMinUSD:10_000,purpleMinUSD:100_000,brownMinUSD:1_000_000,brownMaxUSD:10_000_000});
/** The five size series, small to large; 'blue' (all orders) is the total. */
export const WHALE_CVD_BUCKETS=Object.freeze(['orange','green','red','purple','brown']);
export const WHALE_CVD_SERIES=Object.freeze([...WHALE_CVD_BUCKETS,'blue']);
export const WHALE_CVD_DEFAULTS=Object.freeze({
 bonus:5,              // ± points (user choice (나): ±5)
 minSharePct:10,       // |whale CVD| must be >= 10 % of all notional traded in the window (and >= the purple edge)
 maxWindowMs:30*60000, // from the move start (evidence.originAt), at most 30 min back
 maxPages:5,           // aggTrades pages of 1000 (weight 20 each): at most 100 weight per candidate
 pageLimit:1000,
 minPurpleUSD:20_000,  // auto scaling never puts the purple edge under $20k
 referenceSymbol:'BTCUSDT',
 reservePct:40,        // stop paging when the shared budget would go above 60 % of its per-minute weight
 cacheTtlMs:30_000,
 timeoutMs:4_000,      // the executor waits at most this long for the read (and each page's fetch is aborted after it)
});
export const WHALE_CVD_CODES=Object.freeze({WITH:'WHALE_CVD_WITH',AGAINST:'WHALE_CVD_AGAINST',WEAK:'WHALE_CVD_WEAK',NO_PRINTS:'WHALE_CVD_NO_PRINTS',UNAVAILABLE:'WHALE_CVD_UNAVAILABLE'});
const AGG_TRADES_WEIGHT=20;

const fin=v=>v!==null&&v!==undefined&&v!==''&&Number.isFinite(Number(v));
const r0=v=>Math.round(Number(v)||0),r4=v=>Math.round((Number(v)||0)*1e4)/1e4;

/** SCALP_WHALE_CVD_SCALE: 'auto' (default) or 'fixed'. */
export const whaleScaleMode=v=>String(v??'').trim().toLowerCase()==='fixed'?'fixed':'auto';

/**
 * Bucket edges for one coin.
 * fixed: MI's $100 / $1k / $10k / $100k / $1M ($10M top).
 * auto:  factor = clamp(sqrt(coin 24h quote volume / BTC 24h quote volume), minPurpleUSD / $100k, 1); every edge × factor
 *        (the ×10 ladder kept), so purple >= $20k, red >= $2k, green >= $200, orange >= $20, brown >= $200k.
 * The square root (not a straight ratio): the order size that moves a price the same amount grows roughly with the
 * square root of the traded volume (square-root impact law), so an alt with 1 % of BTC's volume gets 10 % of the
 * edges, not 1 %. Example: 1 % → factor 0.1 → purple $10k → floored to $20k (factor 0.2); ETH at ~40 % → 0.63 → $63k.
 * Without both volumes the fixed edges are used (source FIXED_NO_VOLUME), which on an alt simply means fewer whales.
 */
export function whaleThresholds({mode='auto',quoteVolume24h=null,referenceQuoteVolume24h=null,minPurpleUSD=WHALE_CVD_DEFAULTS.minPurpleUSD}={}){
 const F=WHALE_CVD_FIXED;
 if(whaleScaleMode(mode)==='fixed')return {mode:'fixed',source:'FIXED',factor:1,...F};
 const qv=Number(quoteVolume24h),ref=Number(referenceQuoteVolume24h);
 if(!(qv>0&&ref>0))return {mode:'auto',source:'FIXED_NO_VOLUME',factor:1,...F};
 const floor=Math.min(1,Math.max(0,Number(minPurpleUSD)||0)/F.purpleMinUSD);
 const factor=r4(Math.min(1,Math.max(floor,Math.sqrt(qv/ref))));
 const edge=k=>Math.round(F[k]*factor*100)/100;
 return {mode:'auto',source:'VOLUME_SQRT',factor,volumeRatio:+(qv/ref).toPrecision(4),
  orangeMinUSD:edge('orangeMinUSD'),greenMinUSD:edge('greenMinUSD'),redMinUSD:edge('redMinUSD'),purpleMinUSD:edge('purpleMinUSD'),brownMinUSD:edge('brownMinUSD'),brownMaxUSD:edge('brownMaxUSD')};
}

/** Taker side of one aggTrade: `m` true (buyer is maker) = taker SELL. */
export const aggTradeSide=t=>t?.m===true?'SELL':'BUY';
/** Series of one taker order notional (USD): 'dust' under the orange edge (counted only in blue / all orders). */
export function whaleBucketOf(notionalUSD,t=WHALE_CVD_FIXED){
 const x=Number(notionalUSD);
 return x>=t.brownMinUSD?'brown':x>=t.purpleMinUSD?'purple':x>=t.redMinUSD?'red':x>=t.greenMinUSD?'green':x>=t.orangeMinUSD?'orange':'dust';
}
/** Parsed aggTrades: {id,at,price,qty,notionalUSD,side}; bad rows dropped. */
export function parseAggTrades(rows){
 const out=[];
 for(const x of Array.isArray(rows)?rows:[]){
  const price=Number(x?.p),qty=Number(x?.q),at=Number(x?.T),id=Number(x?.a);
  if(!(price>0)||!(qty>0)||!Number.isFinite(at)||!Number.isFinite(id))continue;
  out.push({id,at,price,qty,notionalUSD:price*qty,side:aggTradeSide(x)});
 }
 return out;
}
/** Signed CVD (taker buy − taker sell notional) per series over [startMs, endMs]: the five sizes, blue = all orders
 * (dust under $100 included), plus whale = purple + brown and shrimp = orange. */
export function bucketWhaleCvd(trades,{startMs=-Infinity,endMs=Infinity,thresholds=WHALE_CVD_FIXED}={}){
 const b=Object.fromEntries([...WHALE_CVD_SERIES,'dust'].map(k=>[k,{cvdUSD:0,buyUSD:0,sellUSD:0,count:0}]));
 const add=(s,t)=>{if(t.side==='BUY'){s.buyUSD+=t.notionalUSD;s.cvdUSD+=t.notionalUSD}else{s.sellUSD+=t.notionalUSD;s.cvdUSD-=t.notionalUSD}s.count++};
 for(const t of trades||[]){
  if(!(t.at>=startMs&&t.at<=endMs))continue;
  add(b[whaleBucketOf(t.notionalUSD,thresholds)],t);add(b.blue,t);
 }
 for(const s of Object.values(b)){s.cvdUSD=r0(s.cvdUSD);s.buyUSD=r0(s.buyUSD);s.sellUSD=r0(s.sellUSD)}
 const {dust,...buckets}=b;
 return {buckets,dustCount:dust.count,whaleCvdUSD:buckets.purple.cvdUSD+buckets.brown.cvdUSD,whaleCount:buckets.purple.count+buckets.brown.count,
  shrimpCvdUSD:buckets.orange.cvdUSD,totalNotionalUSD:r0(buckets.blue.buyUSD+buckets.blue.sellUSD),trades:buckets.blue.count};
}

const sign=v=>v>0?1:v<0?-1:0;
/**
 * ± points for a trade direction from a snapshot (fetchWhaleCvd / summarizeWhaleCvd).
 * Significant = |whale CVD| >= max(purple edge, minSharePct % of all notional traded in the covered window).
 * +bonus: significant whale net buying on a LONG / net selling on a SHORT. −bonus: significant and opposite.
 * 0: unavailable, no purple / brown prints, or not significant. The shrimp (orange) CVD opposite to the whales is
 * recorded (divergence ACCUMULATION: whale buy / shrimp sell, DISTRIBUTION: the reverse; shrimpDivergence when the
 * whale side is also the trade's side) but is not required and adds no points.
 */
export function evaluateWhaleCvdBonus(snapshot,direction,{bonus=WHALE_CVD_DEFAULTS.bonus,minSharePct=WHALE_CVD_DEFAULTS.minSharePct}={}){
 const pts=Math.max(0,Math.min(5,fin(bonus)?Number(bonus):WHALE_CVD_DEFAULTS.bonus)),share=Math.max(0,fin(minSharePct)?Number(minSharePct):WHALE_CVD_DEFAULTS.minSharePct);
 const dir=direction==='SHORT'?-1:1;
 if(!snapshot?.ok)return {available:false,bonus:0,code:WHALE_CVD_CODES.UNAVAILABLE,detail:snapshot?.error||'NO_DATA',minSharePct:share};
 const w=Number(snapshot.whaleCvdUSD)||0,shrimp=Number(snapshot.buckets?.orange?.cvdUSD)||0;
 const floorUSD=Number(snapshot.thresholds?.purpleMinUSD)||WHALE_CVD_FIXED.purpleMinUSD;
 const thresholdUSD=r0(Math.max(floorUSD,share/100*(Number(snapshot.totalNotionalUSD)||0)));
 const sharePct=snapshot.totalNotionalUSD>0?+(Math.abs(w)/snapshot.totalNotionalUSD*100).toFixed(2):null;
 const divergence=sign(w)!==0&&sign(shrimp)!==0&&sign(w)!==sign(shrimp)?(w>0?'ACCUMULATION':'DISTRIBUTION'):null;
 const base={available:true,whaleCvdUSD:w,shrimpCvdUSD:shrimp,thresholdUSD,floorUSD,minSharePct:share,sharePct,divergence,shrimpDivergence:divergence!==null&&sign(w)===dir};
 if(!(snapshot.whaleCount>0))return {...base,bonus:0,code:WHALE_CVD_CODES.NO_PRINTS};
 if(!(Math.abs(w)>=thresholdUSD))return {...base,bonus:0,code:WHALE_CVD_CODES.WEAK};
 const agrees=sign(w)===dir;
 return {...base,bonus:agrees?pts:-pts,agrees,code:agrees?WHALE_CVD_CODES.WITH:WHALE_CVD_CODES.AGAINST};
}

/** The snapshot of parsed trades: scaled buckets (scored) and MI fixed buckets (record), window and coverage. */
export function summarizeWhaleCvd(trades,{symbol=null,startMs,endMs,thresholds=WHALE_CVD_FIXED,complete=true,pages=0,earliestAt=null}={}){
 const scaled=bucketWhaleCvd(trades,{startMs,endMs,thresholds}),fixed=bucketWhaleCvd(trades,{startMs,endMs,thresholds:WHALE_CVD_FIXED});
 const from=complete?startMs:Math.max(startMs,Number(earliestAt)||startMs);
 return {ok:true,source:'BINANCE_AGG_TRADES',sourceNote:WHALE_CVD_SOURCE_NOTE,symbol,startMs,endMs,windowMin:+((endMs-startMs)/60000).toFixed(1),
  coveredFromMs:from,coveragePct:endMs>startMs?+(Math.min(1,(endMs-from)/(endMs-startMs))*100).toFixed(1):100,complete,pages,
  thresholds,...scaled,fixed:{thresholds:{...WHALE_CVD_FIXED},buckets:fixed.buckets,whaleCvdUSD:fixed.whaleCvdUSD,whaleCount:fixed.whaleCount}};
}

const cache=new Map();
export function clearWhaleCvdCache(){cache.clear()}

/**
 * Read the aggTrades of [startMs, endMs] newest first (no fromId = the newest 1000; then fromId = first id − 1000),
 * at most maxPages pages, stopping early when the shared budget is above (100 − reservePct) % of its weight, and
 * requesting no new page once deadlineMs (the executor's wait) has passed since the call.
 * request(route) -> parsed JSON (the server's Binance public read: budget, cooldown, timeout).
 * budget() -> {usedWeight,maxWeightPerMinute,cooldownUntil} (PublicReadBudget.snapshot), optional.
 * Never throws: {ok:false,error} on a failure of the first page; a later page failure keeps what was read (complete false).
 */
export async function fetchWhaleCvd(symbol,{request,budget=null,startMs,endMs=Date.now(),now=Date.now,thresholds=WHALE_CVD_FIXED,
 maxPages=WHALE_CVD_DEFAULTS.maxPages,pageLimit=WHALE_CVD_DEFAULTS.pageLimit,reservePct=WHALE_CVD_DEFAULTS.reservePct,
 maxWindowMs=WHALE_CVD_DEFAULTS.maxWindowMs,cacheTtlMs=WHALE_CVD_DEFAULTS.cacheTtlMs,deadlineMs=WHALE_CVD_DEFAULTS.timeoutMs}={}){
 const sym=String(symbol||'').toUpperCase();
 if(!/^[A-Z0-9]{2,30}USDT$/.test(sym))return {ok:false,error:'BAD_SYMBOL'};
 if(typeof request!=='function')return {ok:false,error:'NO_REQUEST'};
 const end=Number(endMs),start=Math.max(fin(startMs)?Number(startMs):end-maxWindowMs,end-maxWindowMs);
 if(!(end>start))return {ok:false,error:'BAD_WINDOW'};
 const key=`${sym}|${Math.floor(start/60000)}|${thresholds?.purpleMinUSD}`,hit=cache.get(key),t0=now();
 if(hit&&t0-hit.at<cacheTtlMs)return hit.pending??hit.data;
 const task=(async()=>{
  const pages=Math.max(1,Math.min(10,Math.floor(Number(maxPages)||1))),limit=Math.max(100,Math.min(1000,Math.floor(Number(pageLimit)||1000)));
  const deadline=Math.max(500,Number(deadlineMs)||WHALE_CVD_DEFAULTS.timeoutMs);
  const room=()=>{if(typeof budget!=='function')return true;const s=budget()||{};const max=Number(s.maxWeightPerMinute)||0;
   if(Number(s.cooldownUntil)>now())return false;return !(max>0)||(Number(s.usedWeight)||0)+AGG_TRADES_WEIGHT<=max*(1-Math.max(0,Math.min(90,reservePct))/100)};
  const all=new Map();let read=0,complete=false,stopped=null,firstId=null;
  while(read<pages){
   // No new page after the caller's wait (review 2026-11-25): the executor gives up at timeoutMs, so later pages
   // would only spend shared weight on a result nobody reads.
   if(read>0&&now()-t0>=deadline){stopped='DEADLINE';break}
   if(!room()){stopped='BUDGET';break}
   const route=`/fapi/v1/aggTrades?symbol=${encodeURIComponent(sym)}&limit=${limit}${firstId==null?'':`&fromId=${Math.max(0,firstId-limit)}`}`;
   let rows;
   try{rows=parseAggTrades(await request(route))}catch(e){stopped=String(e?.message||e).slice(0,80);break}
   read++;
   const fresh=firstId==null?rows:rows.filter(t=>t.id<firstId);
   if(!fresh.length){complete=true;break}
   for(const t of fresh)all.set(t.id,t);
   const oldest=fresh.reduce((a,t)=>t.id<a.id?t:a,fresh[0]);
   firstId=oldest.id;
   if(oldest.at<=start||rows.length<limit||firstId<=0){complete=true;break}
  }
  if(!read)return {ok:false,error:stopped||'NO_PAGE'};
  const trades=[...all.values()],earliestAt=trades.length?Math.min(...trades.map(t=>t.at)):null;
  return {...summarizeWhaleCvd(trades,{symbol:sym,startMs:start,endMs:end,thresholds,complete,pages:read,earliestAt}),weight:read*AGG_TRADES_WEIGHT,...(stopped?{stopped}:{})};
 })();
 cache.set(key,{at:t0,pending:task});
 if(cache.size>60)cache.delete(cache.keys().next().value);
 try{const data=await task;if(data.ok)cache.set(key,{at:t0,data});else cache.delete(key);return data}
 catch(e){cache.delete(key);return {ok:false,error:String(e?.message||e).slice(0,80)}}
}

/** The record kept per candidate / trade / skip: the bonus and why, bucket CVDs and counts, window, both edge sets. */
export function whaleCvdRecord(snapshot,evaluation){
 const e=evaluation||{available:false,bonus:0,code:WHALE_CVD_CODES.UNAVAILABLE};
 const out={bonus:e.bonus||0,code:e.code,sourceNote:WHALE_CVD_SOURCE_NOTE};
 if(!e.available||!snapshot?.ok)return {...out,detail:e.detail??snapshot?.error??null};
 const brief=b=>Object.fromEntries(WHALE_CVD_SERIES.map(k=>[k,{cvdUSD:b[k].cvdUSD,count:b[k].count}]));
 const T=snapshot.thresholds||{};
 return {...out,whaleCvdUSD:e.whaleCvdUSD,shrimpCvdUSD:e.shrimpCvdUSD,thresholdUSD:e.thresholdUSD,minSharePct:e.minSharePct,sharePct:e.sharePct,divergence:e.divergence,shrimpDivergence:e.shrimpDivergence===true,
  buckets:brief(snapshot.buckets),dustCount:snapshot.dustCount??0,totalNotionalUSD:snapshot.totalNotionalUSD,trades:snapshot.trades,
  window:{startMs:snapshot.startMs,endMs:snapshot.endMs,minutes:snapshot.windowMin,coveredFromMs:snapshot.coveredFromMs,coveragePct:snapshot.coveragePct,complete:snapshot.complete,pages:snapshot.pages},
  thresholds:{mode:T.mode??'fixed',source:T.source??'FIXED',factor:T.factor??1,orangeMinUSD:T.orangeMinUSD,greenMinUSD:T.greenMinUSD,redMinUSD:T.redMinUSD,purpleMinUSD:T.purpleMinUSD,brownMinUSD:T.brownMinUSD,brownMaxUSD:T.brownMaxUSD},
  fixed:{whaleCvdUSD:snapshot.fixed?.whaleCvdUSD??null,buckets:snapshot.fixed?.buckets?brief(snapshot.fixed.buckets):null}};
}

const usd=v=>{const x=Number(v)||0,a=Math.abs(x),s=x>0?'+':x<0?'−':'';return a>=1e6?`${s}$${+(a/1e6).toFixed(2)}M`:a>=1e3?`${s}$${+(a/1e3).toFixed(1)}K`:`${s}$${Math.round(a)}`};
/** "고래CVD +5 (보라 +$1.2M · 갈색 고래 $0 · 주황 새우 −$80K)" for Telegram and the journal; '' when there is no record. */
export function whaleCvdSummaryKo(rec){
 if(!rec)return '';
 const b=Number(rec.bonus)||0,head=`고래CVD ${b>0?'+':b<0?'−':''}${Math.abs(b)}`;
 if(!rec.buckets)return `${head} (자료 없음)`;
 const div=rec.divergence==='ACCUMULATION'?' · 새우 매도·고래 매수':rec.divergence==='DISTRIBUTION'?' · 새우 매수·고래 매도':'';
 return `${head} (보라 ${usd(rec.buckets.purple?.cvdUSD)} · 갈색 고래 ${usd(rec.buckets.brown?.cvdUSD)} · 주황 새우 ${usd(rec.buckets.orange?.cvdUSD)}${div})`;
}
export const whaleCvdUsd=usd;
