// Daily results of the BingX real account for the 실계좌 page calendar (user 2026-11-18 "진입 실패 건 옆 부분 빈칸에
// 캘린더 느낌으로 내가 하루에 번 돈의 기록"): copy and manual trades together, the exchange's own income history
// (realized PnL + trading fees + funding, transfers excluded; exchange_pnl.mjs), per KST day. Read-only GETs.
//
// Read in the background at most every 5 minutes; the page only ever gets the cached value (status()), so a slow or
// failing read never holds up a request. A failed read keeps the last good days and reports the error with them.
// The first read (and one every hour) covers the previous and the current KST month; the ones in between re-read
// only from yesterday (KST) and replace those days.
import {exchangePnl} from './exchange_pnl.mjs';

const DAY=86400000,KST=9*3600000,EVERY=5*60000,FULL_EVERY=60*60000,RETENTION=85*DAY; // BingX keeps income ~3 months
const kstDay=t=>new Date(t+KST).toISOString().slice(0,10);
/** KST midnight (epoch ms) of the day containing t. */
export const kstMidnight=t=>Math.floor((t+KST)/DAY)*DAY-KST;
/** KST midnight of the first day of the month `back` months before the month containing t. */
export function kstMonthStart(t,back=0){const d=new Date(t+KST);return Date.UTC(d.getUTCFullYear(),d.getUTCMonth()-back,1)-KST}
/** Where a full read starts: the configured start date, extended back to the start of the previous KST month so the
 * whole current and previous month show, but never older than the venue keeps (then the venue's limit, a KST day). */
export function dailySince(configured,now){
 const want=Math.min(Number.isFinite(configured)?configured:Infinity,kstMonthStart(now,1));
 return Math.max(want,kstMidnight(now-RETENTION)+DAY);
}
// Only short codes leave this module (a venue message could carry anything).
const safeError=e=>{const s=String(e||'ERROR');return /^[A-Z0-9_]{1,40}$/.test(s)?s:'READ_FAILED'};

/** One cache per account. read(since,now) defaults to exchangePnl(client,…); now() is injectable for tests. */
export function createDailyPnl({client,since,read=null,now=()=>Date.now(),every=EVERY,fullEvery=FULL_EVERY,log=()=>{}}={}){
 const doRead=read||((from,at)=>exchangePnl(client,{since:from,now:at}));
 let byDay={},at=null,from=null,error=null,errorAt=null,lastFull=0,busy=null,timer=null;
 function refresh(){
  if(busy)return busy;
  busy=(async()=>{
   const t=now(),full=at===null||t-lastFull>=fullEvery||from===null;
   const start=full?dailySince(since,t):Math.max(from,kstMidnight(t)-DAY);
   let r;try{r=await doRead(start,t)}catch(e){r={error:e?.code||e?.message||'ERROR'}}
   if(!r||r.error||!r.byDay||typeof r.byDay!=='object'){error=safeError(r?.error);errorAt=t;log('[DAILY_PNL]',error);return}
   const fresh={};for(const [d,v] of Object.entries(r.byDay))if(/^\d{4}-\d{2}-\d{2}$/.test(d)&&Number.isFinite(Number(v)))fresh[d]=Math.round(Number(v)*1e4)/1e4;
   if(full){byDay=fresh;from=start;lastFull=t}
   else{const cut=kstDay(start),keep={};for(const [d,v] of Object.entries(byDay))if(d<cut)keep[d]=v;byDay={...keep,...fresh}}
   at=t;error=null;errorAt=null;
  })().finally(()=>{busy=null});
  return busy;
 }
 return {
  refresh,
  /** {at, since, byDay, error, errorAt}: the last good days (at = when they were read) and the last error, if any. */
  status:()=>({at,since:from,byDay:{...byDay},error,errorAt}),
  start(){if(timer)return;const tick=()=>{refresh().catch(()=>{})};tick();timer=setInterval(tick,every);timer.unref?.()},
  stop(){clearInterval(timer);timer=null},
 };
}
