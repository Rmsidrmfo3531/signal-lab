// Daily results of the BingX real account for the 실계좌 page calendar (user 2026-11-18 "진입 실패 건 옆 부분 빈칸에
// 캘린더 느낌으로 내가 하루에 번 돈의 기록"): copy and manual trades together, the exchange's own income history
// (realized PnL + trading fees + funding, transfers excluded; exchange_pnl.mjs), per KST day. Read-only GETs.
//
// Read in the background at most every 5 minutes; the page only ever gets the cached value (status()), so a slow or
// failing read never holds up a request. A failed read keeps the last good days and reports the error with them.
// The first read (and one every hour) covers the calendar's accounting window; the ones in between re-read
// only from yesterday (KST) and replace those days.
import {incomeRows,summarizeIncome} from './exchange_pnl.mjs';

const DAY=86400000,KST=9*3600000,EVERY=5*60000,FULL_EVERY=60*60000,RETAIN_DAYS=85;
const PNL_TYPES=new Set(['REALIZED_PNL','TRADING_FEE','FUNDING_FEE']);
export const PNL_CALENDAR_RESET_AT=Date.parse('2026-11-19T11:43:24+09:00');
const kstDay=t=>new Date(t+KST).toISOString().slice(0,10);
/** KST midnight (epoch ms) of the day containing t. */
export const kstMidnight=t=>Math.floor((t+KST)/DAY)*DAY-KST;
/** First retained date, with the exact reset time if the reset is still in range. */
export function dailySince(now,resetAt){
 const kst=new Date(now+KST),previousMonth=Date.UTC(kst.getUTCFullYear(),kst.getUTCMonth()-1,1)-KST;
 return Math.max(Number.isFinite(resetAt)?resetAt:previousMonth,kstMidnight(now)-(RETAIN_DAYS-1)*DAY);
}
// Only short codes leave this module (a venue message could carry anything).
const safeError=e=>{const s=String(e||'ERROR');return /^[A-Z0-9_]{1,40}$/.test(s)?s:'READ_FAILED'};

/** One cache per account. The calendar uses only fund flow; account balance is used by the return report. */
export function createDailyPnl({client,resetAt=null,read=null,now=()=>Date.now(),every=EVERY,fullEvery=FULL_EVERY,log=()=>{}}={}){
 const doRead=read||(async(since,now)=>{
  if(typeof client?.income!=='function')return {error:'NO_CLIENT'};
  const rows=await incomeRows(client,{since,now});
  const trading=rows.filter(x=>Number(x.time)>=since&&Number(x.time)<=now&&PNL_TYPES.has(x.incomeType));
  return {byDay:summarizeIncome(trading,null,{since,now}).byDay};
 });
 let byDay={},at=null,from=null,error=null,errorAt=null,lastFull=0,busy=null,timer=null;
 async function readDays(start,end){
  let result;
  try{result=await doRead(start,end)}catch(e){return {error:safeError(e?.code||e?.message)}}
  if(!result?.byDay||typeof result.byDay!=='object'||Array.isArray(result.byDay)||result.error)return {error:safeError(result?.error)};
  const days={},first=kstDay(start),last=kstDay(end);
  for(const [d,v] of Object.entries(result.byDay))if(d>=first&&d<=last&&(typeof v==='number'||typeof v==='string'&&v.trim()!=='')&&/^\d{4}-\d{2}-\d{2}$/.test(d)&&Number.isFinite(Number(v)))days[d]=Math.round(Number(v)*1e4)/1e4;
  return {days};
 }
 function replaceRecent(start,days){
  const cut=kstDay(start),keep={};
  for(const [day,value] of Object.entries(byDay))if(day<cut)keep[day]=value;
  byDay={...keep,...days};
 }
 function refresh(){
  if(busy)return busy;
  busy=(async()=>{
   const t=now(),full=at===null||t-lastFull>=fullEvery||from===null;
   const fullStart=dailySince(t,resetAt),recentStart=Math.max(fullStart,kstMidnight(t)-DAY);
   if(fullStart>t)return;
   const start=full?fullStart:Math.max(from,recentStart);
   const result=await readDays(start,t);
   if(result.error){
    if(full&&recentStart>start&&result.error!=='NO_CLIENT'){
     // Keep the last good history, and recover the current and previous KST day independently.
     const recent=await readDays(recentStart,t);
     if(recent.days){
      replaceRecent(recentStart,recent.days);
      from=from??recentStart;at=t;
     }
    }
    error=result.error;errorAt=t;log('[DAILY_PNL]',error);return;
   }
   if(full){byDay=result.days;from=start;lastFull=t}
   else replaceRecent(start,result.days);
   at=t;error=null;errorAt=null;
  })().finally(()=>{busy=null});
  return busy;
 }
 return {
  refresh,
  /** {at, since, byDay, error, errorAt}: the last good days (at = when they were read) and the last error, if any. */
  status:()=>{
   const t=now(),start=dailySince(t,resetAt),first=kstDay(start),last=kstDay(t);
   return {at,since:from===null?null:Math.max(from,start),byDay:Object.fromEntries(Object.entries(byDay).filter(([day])=>day>=first&&day<=last)),
    error,errorAt,...(Number.isFinite(resetAt)?{resetAt,availableSince:start}:{})};
  },
  start(){if(timer)return;const tick=()=>{refresh().catch(()=>{})};tick();timer=setInterval(tick,every);timer.unref?.()},
  stop(){clearInterval(timer);timer=null},
 };
}
