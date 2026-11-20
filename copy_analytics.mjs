// Real-account performance analytics (user 2026-11-20):
//  - #12 Cumulative equity curve (total / copy / manual) & Max Drawdown (MDD)
//  - #13 Performance breakdown by symbol, KST time-of-day bucket, and leverage tier
// Pure functions, zero network / I/O.

import {displaySymbol} from './public/symbol_display.js';

const KST_MS=9*3600000;
const r2=v=>Math.round(Number(v)*100)/100;
const fin=v=>v!==null&&v!==undefined&&String(v).trim()!==''&&Number.isFinite(Number(v));
const kstDay=t=>new Date(Number(t)+KST_MS).toISOString().slice(0,10);
const kstHour=t=>new Date(Number(t)+KST_MS).getUTCHours();
const kstTimestamp=t=>t>0&&Number.isFinite(Number(t))?new Date(Number(t)+KST_MS).toISOString().replace('T',' ').slice(0,19):'';

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
 const withFee=rows.filter(x=>x.feeUSD!=null||x.fundingUSD!=null);
 const feeSum=withFee.length?r2(withFee.reduce((s,x)=>s+(x.feeUSD||0),0)):null;
 const fundSum=withFee.length?r2(withFee.reduce((s,x)=>s+(x.fundingUSD||0),0)):null;
 return {
  trades:n,
  wins:wins.length,
  losses:losses.length,
  winRatePct:n?+(wins.length/n*100).toFixed(1):null,
  profitFactor:loss>0?+(gross/loss).toFixed(2):n&&gross>0?null:null,
  netUSD:r2(net),
  avgUSD:n?r2(net/n):null,
  feeUSD:feeSum,
  fundingUSD:fundSum,
  copyCount:rows.filter(x=>x.origin==='copy').length,
  manualCount:rows.filter(x=>x.origin==='manual').length,
 };
}

function buildCostBreakdown(trades,exchangeCosts){
 const normalizeLeak=list=>list
  .filter(x=>(x.feeUSD+x.fundingUSD)<-0.005)
  .map(x=>({
   symbol:x.symbol,
   trades:x.trades,
   pnlUSD:r2(x.pnlUSD),
   feeUSD:r2(x.feeUSD),
   fundingUSD:r2(x.fundingUSD),
   costUSD:r2(x.feeUSD+x.fundingUSD),
   netUSD:r2(x.netUSD),
   feeTurnedLoss:x.pnlUSD>0&&x.netUSD<=0,
  }))
  .sort((a,b)=>a.costUSD-b.costUSD||a.netUSD-b.netUSD)
  .slice(0,5);

 if(exchangeCosts&&fin(exchangeCosts.realizedPnlUSD)&&fin(exchangeCosts.feesUSD)){
  const pnl=Number(exchangeCosts.realizedPnlUSD)||0;
  const fee=Number(exchangeCosts.feesUSD)||0;
  const funding=Number(exchangeCosts.fundingUSD)||0;
  const totalCost=fee+funding;
  const net=fin(exchangeCosts.tradingNetUSD)?Number(exchangeCosts.tradingNetUSD):(pnl+totalCost);
  if(pnl!==0||fee!==0||funding!==0){
   const merged=new Map();
   for(const row of Array.isArray(exchangeCosts.bySymbol)?exchangeCosts.bySymbol:[]){
    const sym=displaySymbol(row.displaySymbol||row.symbol).replace(/-/g,'').toUpperCase();
    if(!sym||sym==='-')continue;
    let cur=merged.get(sym);
    if(!cur){cur={symbol:sym,trades:0,pnlUSD:0,feeUSD:0,fundingUSD:0,netUSD:0};merged.set(sym,cur)}
    cur.trades+=Number(row.closes)||0;
    cur.pnlUSD+=Number(row.pnlUSD)||0;
    cur.feeUSD+=Number(row.feeUSD)||0;
    cur.fundingUSD+=Number(row.fundingUSD)||0;
    cur.netUSD+=Number(row.netUSD)||0;
   }
   return {
    source:'EXCHANGE',
    tradesWithCost:Number(exchangeCosts.closes)||trades.length,
    realizedPnlUSD:r2(pnl),
    feeUSD:r2(fee),
    fundingUSD:r2(funding),
    totalCostUSD:r2(totalCost),
    netUSD:r2(net),
    feeDrainPct:pnl>0?+(Math.abs(totalCost)/pnl*100).toFixed(1):null,
    feeTurnedLoss:pnl>0&&net<=0,
    topFeeLeaks:normalizeLeak([...merged.values()]),
    bySymbolCost:merged,
   };
  }
 }

 const withCost=trades.filter(t=>t.feeUSD!=null||t.fundingUSD!=null);
 if(!withCost.length)return null;
 let pnl=0,fee=0,funding=0,net=0;
 const symCost=new Map();
 for(const t of withCost){
  const f=t.feeUSD||0,fn=t.fundingUSD||0,p=t.pnlUSD!=null?t.pnlUSD:(t.netUSD-f-fn);
  pnl+=p;fee+=f;funding+=fn;net+=t.netUSD;
  if(!t.symbol)continue;
  let cur=symCost.get(t.symbol);
  if(!cur){cur={symbol:t.symbol,trades:0,pnlUSD:0,feeUSD:0,fundingUSD:0,netUSD:0};symCost.set(t.symbol,cur)}
  cur.trades++;cur.pnlUSD+=p;cur.feeUSD+=f;cur.fundingUSD+=fn;cur.netUSD+=t.netUSD;
 }
 const totalCost=fee+funding;
 return {
  source:'LEDGER',
  tradesWithCost:withCost.length,
  realizedPnlUSD:r2(pnl),
  feeUSD:r2(fee),
  fundingUSD:r2(funding),
  totalCostUSD:r2(totalCost),
  netUSD:r2(net),
  feeDrainPct:pnl>0?+(Math.abs(totalCost)/pnl*100).toFixed(1):null,
  feeTurnedLoss:pnl>0&&net<=0,
  topFeeLeaks:normalizeLeak([...symCost.values()]),
  bySymbolCost:symCost,
 };
}

export function buildCopyAnalytics({copyClosed=[],manualClosed=[],dailyByDay=null,equityUSD=null,confirmedOnly=true,exchangeCosts=null}={}){
 const ok=x=>x&&!x.archivedFromHistory&&x.netUSD!=null&&String(x.netUSD).trim()!==''&&Number.isFinite(Number(x.netUSD))
  &&(!confirmedOnly||['EXCHANGE','EXCHANGE_FILLS'].includes(x.netSource));

 const mapTrade=(x,origin)=>({
  symbol:displaySymbol(x.symbol).toUpperCase(),
  origin,
  direction:x.direction||null,
  leverage:Number(x.leverage)>0?Number(x.leverage):null,
  openedAt:Number(x.openedAt)||Number(x.closedAt)||0,
  closedAt:Number(x.closedAt)||0,
  netUSD:Number(x.netUSD),
  pnlUSD:fin(x.pnlUSD)?Number(x.pnlUSD):null,
  feeUSD:fin(x.feeUSD)?Number(x.feeUSD):null,
  fundingUSD:fin(x.fundingUSD)?Number(x.fundingUSD):null,
 });
 const trades=[
  ...(Array.isArray(copyClosed)?copyClosed:[]).filter(ok).map(x=>mapTrade(x,'copy')),
  ...(Array.isArray(manualClosed)?manualClosed:[]).filter(ok).map(x=>mapTrade(x,'manual')),
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

 const costBreakdown=buildCostBreakdown(trades,exchangeCosts);
 const symCostMap=costBreakdown?.bySymbolCost||null;

 // #13 By symbol
 const symMap=new Map();
 for(const t of trades){
  if(!t.symbol)continue;
  let arr=symMap.get(t.symbol);if(!arr){arr=[];symMap.set(t.symbol,arr)}
  arr.push(t);
 }
 const bySymbol=[...symMap.entries()]
  .map(([symbol,rows])=>{
   const g=summarizeGroup(rows);
   const ec=symCostMap?.get(symbol);
   if(g.feeUSD==null&&ec)g.feeUSD=r2(ec.feeUSD);
   if(g.fundingUSD==null&&ec)g.fundingUSD=r2(ec.fundingUSD);
   return {symbol,...g};
  })
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

 const costs=costBreakdown?(({bySymbolCost,...rest})=>rest)(costBreakdown):null;

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
  costs,
  curve,
  bySymbol,
  byHourKst,
  byLeverage,
 };
}

/** RFC-4180 CSV export of merged real-account (copy + manual) closed trades with UTF-8 BOM and Excel formula neutralization. */
export function exportCopyTradesCSV({copyClosed=[],manualClosed=[]}={}){
 const cols=[
  '종료시각(KST)','진입시각(KST)','구분','종목','원본심볼','방향','배율',
  '추매','부분청산','평균진입가','매매손익(USD)','수수료(USD)','펀딩비(USD)',
  '순손익(USD)','정산근거','종료사유','태그','메모',
 ];
 function cell(value){
  let s=value==null?'':String(value);
  if(/^[=+@\-\t\r]/.test(s)&&!/^-[0-9.]+$/.test(s))s="'"+s;
  return '"'+s.replaceAll('"','""')+'"';
 }
 const rows=[
  ...(Array.isArray(copyClosed)?copyClosed:[]).filter(x=>x&&!x.archivedFromHistory).map(x=>({...x,_origin:'카피'})),
  ...(Array.isArray(manualClosed)?manualClosed:[]).filter(x=>x&&!x.archivedFromHistory).map(x=>({...x,_origin:'수동'})),
 ].sort((a,b)=>(Number(b.closedAt)||0)-(Number(a.closedAt)||0));

 const lines=rows.map(x=>{
  const rawSym=String(x.symbol||'');
  const dispSym=displaySymbol(rawSym);
  const tags=Array.isArray(x.tags)?x.tags.join(', '):'';
  return [
   kstTimestamp(x.closedAt),
   kstTimestamp(x.openedAt),
   x._origin,
   dispSym,
   rawSym,
   x.direction==='LONG'?'롱':x.direction==='SHORT'?'숏':String(x.direction||''),
   fin(x.leverage)?Number(x.leverage):'',
   fin(x.adds)?Number(x.adds):0,
   fin(x.reduces)?Number(x.reduces):'',
   fin(x.avg)?Number(x.avg):'',
   fin(x.pnlUSD)?r2(x.pnlUSD):'',
   fin(x.feeUSD)?r2(x.feeUSD):'',
   fin(x.fundingUSD)?r2(x.fundingUSD):'',
   fin(x.netUSD)?r2(x.netUSD):'',
   String(x.netSource||''),
   String(x.closeReason||''),
   tags,
   String(x.note||''),
  ].map(cell).join(',');
 });
 return '\uFEFF'+cols.map(cell).join(',')+'\r\n'+(lines.length?lines.join('\r\n')+'\r\n':'');
}
