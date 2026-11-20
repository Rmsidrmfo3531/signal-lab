// Exchange-side profit and loss of a BingX account (user 2026-11-17 "실제 매매 기록을 갖고 와서 수익률이 얼마인지
// 정확하게"): the account's own income history (realized PnL, trading fees, funding) and its balance, read-only GETs.
// Our ledgers estimate before fees and miss some closes; this is the exchange's own record.
import {displaySymbol} from './public/symbol_display.js';
const DAY=86400000,WINDOW=7*DAY,KST=9*3600000;
// Capital moving in or out, not trading results.
const FLOW=new Set(['TRANSFER','TRIAL_FUND','DEPOSIT','WITHDRAW']);
const r2=x=>Math.round(x*100)/100,r4=x=>Math.round(x*1e4)/1e4;

/** BingX returns either multiple balance rows, a wrapped row, or a single row. */
export function bingxBalanceRows(data){
 const rows=data?.balance&&typeof data.balance==='object'?data.balance:data;
 return Array.isArray(rows)?rows:rows&&typeof rows==='object'?[rows]:[];
}
/** USDT (or the testnet VST) balance row of a BingX v3 balance answer: {equity, balance, unrealized, available}. */
export function balanceOf(data){
 const list=bingxBalanceRows(data),u=list.find(x=>['USDT','VST'].includes(x?.asset))??list[0];
 if(!u)return null;const num=k=>u[k]!==null&&u[k]!==undefined&&String(u[k]).trim()!==''&&Number.isFinite(Number(u[k]))?Number(u[k]):null;
 return {asset:u.asset??null,equity:num('equity'),balance:num('balance'),unrealized:num('unrealizedProfit'),available:num('availableMargin')};
}

/** All income rows from `since` to `now`, read in 7-day windows (newest data the venue keeps), de-duplicated. */
export async function incomeRows(client,{since,now=Date.now(),limit=1000}={}){
 if(!Number.isFinite(since)||!Number.isFinite(now)||since>now)throw Object.assign(Error('INVALID_INCOME_WINDOW'),{code:'INVALID_INCOME_WINDOW'});
 const badIncome=()=>Object.assign(Error('BAD_INCOME_RESPONSE'),{code:'BAD_INCOME_RESPONSE'});
 const number=v=>(typeof v==='number'||typeof v==='string'&&v.trim()!=='')&&Number.isFinite(Number(v));
 const out=new Map();
 const read=async(from,to,depth=0)=>{
  const res=await client.income({startTime:from,endTime:to,limit});
  const rows=Array.isArray(res)?res:Array.isArray(res?.list)?res.list:Array.isArray(res?.data)?res.data:null;
  if(!rows)throw badIncome();
  // A full page may hide rows: read the window again in halves (down to ~10 minutes).
  if(rows.length>=limit){const mid=Math.floor((from+to)/2);if(depth>=10||mid<=from||mid>=to)throw Object.assign(new Error('INCOME_PAGE_FULL'),{code:'INCOME_PAGE_FULL',from,to});
   await read(from,mid,depth+1);await read(mid,to,depth+1);return}
  for(const x of rows){if(!number(x?.time)||!number(x?.income))throw badIncome();
   const t=Number(x.time);if(t<since||t>now)continue;
   const key=[x.tranId??x.tradeId??'',x.incomeType,x.symbol,x.time,x.income].join('|');out.set(key,x)}
 };
 for(let from=since;from<now;from+=WINDOW)await read(from,Math.min(now,from+WINDOW));
 return [...out.values()].sort((a,b)=>Number(a.time)-Number(b.time));
}

/** Totals from income rows and the current balance. Return % is trading result / starting capital, where starting
 *  capital = equity now - unrealized - trading result - net transfers (so deposits do not count as profit). */
export function summarizeIncome(rows,balance,{since,now=Date.now()}={}){
 const byType={},bySymbol={},byDay={};let trading=0,flows=0;
 for(const x of rows){
  const v=Number(x.income)||0,t=String(x.incomeType||'OTHER');byType[t]=(byType[t]||0)+v;
  if(FLOW.has(t)){flows+=v;continue}
  trading+=v;const s=x.symbol||'-';bySymbol[s]||={net:0,pnl:0,fee:0,funding:0,closes:0};const b=bySymbol[s];b.net+=v;
  if(t==='REALIZED_PNL'){b.pnl+=v;b.closes++}else if(t==='TRADING_FEE')b.fee+=v;else if(t==='FUNDING_FEE')b.funding+=v;
  const d=new Date(Number(x.time)+KST).toISOString().slice(0,10);byDay[d]=(byDay[d]||0)+v;
 }
 const equity=balance?.equity??null,unreal=balance?.unrealized??0;
 const start=equity==null?null:equity-unreal-trading-flows;
 // Return base = the capital the account trades with now, before this period's result (equity - open - result).
 // A large withdrawal (the testnet's 100k VST moved out) would otherwise make the base meaningless; a deposit makes
 // this base larger, so the return is never overstated.
 const base=equity==null?null:equity-unreal-trading;
 return {since,at:now,asset:balance?.asset??null,equityUSD:equity==null?null:r4(equity),unrealizedUSD:r4(unreal),
  realizedPnlUSD:r4(byType.REALIZED_PNL||0),feesUSD:r4(byType.TRADING_FEE||0),fundingUSD:r4(byType.FUNDING_FEE||0),
  tradingNetUSD:r4(trading),transfersUSD:r4(flows),startCapitalUSD:start==null?null:r4(start),
  capitalBaseUSD:base==null?null:r4(base),returnPct:base>0?r2(trading/base*100):null,returnWithOpenPct:base>0?r2((trading+unreal)/base*100):null,
  closes:rows.filter(x=>x.incomeType==='REALIZED_PNL').length,rows:rows.length,
  byType:Object.fromEntries(Object.entries(byType).map(([k,v])=>[k,r4(v)])),
  byDay:Object.fromEntries(Object.entries(byDay).map(([k,v])=>[k,r4(v)])),
  bySymbol:Object.entries(bySymbol).map(([symbol,b])=>({symbol,displaySymbol:displaySymbol(symbol),netUSD:r4(b.net),pnlUSD:r4(b.pnl),feeUSD:r4(b.fee),fundingUSD:r4(b.funding),closes:b.closes})).sort((a,b)=>a.netUSD-b.netUSD)};
}

/** Read and summarize one account; errors come back as {error} instead of throwing. */
export async function exchangePnl(client,{since,now=Date.now()}={}){
 if(!client||typeof client.income!=='function')return {error:'NO_CLIENT'};
 try{const [rows,bal]=await Promise.all([incomeRows(client,{since,now}),client.balance()]);return summarizeIncome(rows,balanceOf(bal),{since,now})}
 catch(e){return {error:e.code||e.message||'ERROR',since}}
}
