// Real-account performance analytics (user 2026-11-20):
//  - #12 Cumulative equity curve (total / copy / manual) & Max Drawdown (MDD)
//  - #13 Performance breakdown by symbol, KST time-of-day bucket, and leverage tier
// Pure functions, zero network / I/O.

import {displaySymbol} from './public/symbol_display.js';

const KST_MS=9*3600000;
const r2=v=>Math.round(Number(v)*100)/100;
const kstDay=t=>new Date(Number(t)+KST_MS).toISOString().slice(0,10);
const kstHour=t=>new Date(Number(t)+KST_MS).getUTCHours();

const HOUR_BUCKETS=[
 {key:'00-04',label:'00~04시 (새벽)',lo:0,hi:4},
 {key:'04-08',label:'04~08시 (이른 아침)',lo:4,hi:8},
 {key:'08-12',label:'08~12시 (아시아장)',lo:8,hi:12},
 {key:'12-16',label:'12~16시 (오후장)',lo:12,hi:16},
 {key:'16-20',label:'16~20시 (유럽장)',lo:16,hi:20},
 {key:'20-24',label:'20~24시 (미국장)',lo:20,hi:24},
];

const LEV_BUCKETS=[
 {key:'1-10',label:'1~10배',match:l=>l>0&&l<=10},
 {key:'11-25',label:'11~25배',match:l=>l>10&&l<=25},
 {key:'26-50',label:'26~50배',match:l=>l>25&&l<=50},
 {key:'51+',label:'51배+',match:l=>l>50},
];

function summarizeGroup(rows){
 const n=rows.length;
 const wins=rows.filter(x=>x.netUSD>0),losses=rows.filter(x=>x.netUSD<0);
 const net=rows.reduce((s,x)=>s+x.netUSD,0);
 const gross=wins.reduce((s,x)=>s+x.netUSD,0),loss=-losses.reduce((s,x)=>s+x.netUSD,0);
 return {
  trades:n,
  wins:wins.length,
  losses:losses.length,
  winRatePct:n?+(wins.length/n*100).toFixed(1):null,
  profitFactor:loss>0?+(gross/loss).toFixed(2):n&&gross>0?null:null,
  netUSD:r2(net),
  avgUSD:n?r2(net/n):null,
  copyCount:rows.filter(x=>x.origin==='copy').length,
  manualCount:rows.filter(x=>x.origin==='manual').length,
 };
}

export function buildCopyAnalytics({copyClosed=[],manualClosed=[],dailyByDay=null,equityUSD=null,confirmedOnly=true}={}){
 const ok=x=>x&&!x.archivedFromHistory&&x.netUSD!=null&&String(x.netUSD).trim()!==''&&Number.isFinite(Number(x.netUSD))
  &&(!confirmedOnly||['EXCHANGE','EXCHANGE_FILLS'].includes(x.netSource));

 const trades=[
  ...(Array.isArray(copyClosed)?copyClosed:[]).filter(ok).map(x=>({
   symbol:displaySymbol(x.symbol).toUpperCase(),
   origin:'copy',
   direction:x.direction||null,
   leverage:Number(x.leverage)>0?Number(x.leverage):null,
   openedAt:Number(x.openedAt)||Number(x.closedAt)||0,
   closedAt:Number(x.closedAt)||0,
   netUSD:Number(x.netUSD),
  })),
  ...(Array.isArray(manualClosed)?manualClosed:[]).filter(ok).map(x=>({
   symbol:displaySymbol(x.symbol).toUpperCase(),
   origin:'manual',
   direction:x.direction||null,
   leverage:Number(x.leverage)>0?Number(x.leverage):null,
   openedAt:Number(x.openedAt)||Number(x.closedAt)||0,
   closedAt:Number(x.closedAt)||0,
   netUSD:Number(x.netUSD),
  })),
 ].sort((a,b)=>a.closedAt-b.closedAt);

 // Daily series for equity curve (total, copy, manual)
 const dayMap=new Map();
 const ensure=day=>{let row=dayMap.get(day);if(!row){row={day,copy:0,manual:0,exchange:null};dayMap.set(day,row)}return row};
 for(const t of trades){
  if(!(t.closedAt>0))continue;
  const row=ensure(kstDay(t.closedAt));
  if(t.origin==='copy')row.copy+=t.netUSD;else row.manual+=t.netUSD;
 }
 if(dailyByDay&&typeof dailyByDay==='object'){
  for(const [day,val] of Object.entries(dailyByDay)){
   if(/^\d{4}-\d{2}-\d{2}$/.test(day)&&Number.isFinite(Number(val)))ensure(day).exchange=Number(val);
  }
 }
 const sortedDays=[...dayMap.values()].sort((a,b)=>a.day.localeCompare(b.day));
 let cumTotal=0,cumCopy=0,cumManual=0,peak=0,maxDrawdownUSD=0;
 const curve=[];
 for(const d of sortedDays){
  const dayDelta=d.exchange!=null?d.exchange:(d.copy+d.manual);
  cumTotal+=dayDelta;
  cumCopy+=d.copy;
  cumManual+=d.manual;
  if(cumTotal>peak)peak=cumTotal;
  const dd=peak-cumTotal;
  if(dd>maxDrawdownUSD)maxDrawdownUSD=dd;
  curve.push({
   day:d.day,
   dayUSD:r2(dayDelta),
   totalUSD:r2(cumTotal),
   copyUSD:r2(cumCopy),
   manualUSD:r2(cumManual),
   drawdownUSD:r2(dd),
  });
 }

 // Also compute trade-level MDD (often sharper intra-day than end-of-day)
 let tradeCum=0,tradePeak=0,tradeMdd=0,winStreak=0,lossStreak=0,curW=0,curL=0;
 for(const t of trades){
  tradeCum+=t.netUSD;
  if(tradeCum>tradePeak)tradePeak=tradeCum;
  if(tradePeak-tradeCum>tradeMdd)tradeMdd=tradePeak-tradeCum;
  if(t.netUSD>0){curW++;curL=0;if(curW>winStreak)winStreak=curW}
  else if(t.netUSD<0){curL++;curW=0;if(curL>lossStreak)lossStreak=curL}
 }
 const effectiveMddUSD=r2(Math.max(maxDrawdownUSD,tradeMdd));
 const eq=Number(equityUSD);
 const baseEquity=Number.isFinite(eq)&&eq>0?Math.max(eq,eq-cumTotal+peak):null;
 const maxDrawdownPct=baseEquity&&baseEquity>0?+(effectiveMddUSD/baseEquity*100).toFixed(2):null;

 const summary=summarizeGroup(trades);
 const wins=trades.filter(t=>t.netUSD>0),losses=trades.filter(t=>t.netUSD<0);
 const avgWinUSD=wins.length?r2(wins.reduce((s,t)=>s+t.netUSD,0)/wins.length):null;
 const avgLossUSD=losses.length?r2(losses.reduce((s,t)=>s+t.netUSD,0)/losses.length):null;

 // #13 By symbol
 const symMap=new Map();
 for(const t of trades){
  if(!t.symbol)continue;
  let arr=symMap.get(t.symbol);if(!arr){arr=[];symMap.set(t.symbol,arr)}
  arr.push(t);
 }
 const bySymbol=[...symMap.entries()]
  .map(([symbol,rows])=>({symbol,...summarizeGroup(rows)}))
  .sort((a,b)=>b.netUSD-a.netUSD||b.trades-a.trades);

 // #13 By KST hour bucket (entry time if available, else close time)
 const byHourKst=HOUR_BUCKETS.map(b=>{
  const rows=trades.filter(t=>{const at=t.openedAt||t.closedAt;if(!(at>0))return false;const h=kstHour(at);return h>=b.lo&&h<b.hi});
  return {key:b.key,label:b.label,...summarizeGroup(rows)};
 });

 // #13 By leverage bucket
 const byLeverage=LEV_BUCKETS.map(b=>{
  const rows=trades.filter(t=>t.leverage!=null&&b.match(t.leverage));
  return {key:b.key,label:b.label,...summarizeGroup(rows)};
 });

 return {
  summary:{
   ...summary,
   avgWinUSD,
   avgLossUSD,
   maxDrawdownUSD:effectiveMddUSD,
   maxDrawdownPct,
   peakUSD:r2(Math.max(peak,tradePeak)),
   maxWinStreak:winStreak,
   maxLossStreak:lossStreak,
  },
  curve,
  bySymbol,
  byHourKst,
  byLeverage,
 };
}
