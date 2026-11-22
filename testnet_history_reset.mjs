import fs from 'node:fs';
import path from 'node:path';
import {atomicWriteStore,readStore} from './persistence.mjs';
import {LiveExecutor} from './live_executor.mjs';
import {SCALP_JOURNAL_FILE} from './scalp_journal.mjs';
import {kstDay} from './testnet_budget.mjs';

const terminalTestnet=r=>r?.mode==='TESTNET'&&['CLOSED','FAILED'].includes(r.status);
const automaticTestnet=x=>x?.source==='LIVE_AUTO'&&x.mode==='TESTNET';

// Run under the data lock before any executor reads its ledger. Persist the original counts and
// today's risk totals before the first write so an interrupted reset resumes without double counting.
export function resetTestnetHistory(dir,{now=Date.now(),apply=true}={}){
 const file=name=>path.join(dir,name);
 const marker=file('testnet-history-reset-2026-11-18.json');
 let reset=readStore(marker);
 if(reset?.completed)return reset;
 if(!apply)return null;
 const signal=readStore(file('live-orders.json'));
 const scalp=readStore(file('scalp-store.json'));
 const copy=readStore(file('copy-store.json'));
 const shared=readStore(file('store.json'));
 if(!reset){
  const day=kstDay(now);
  const preview=new LiveExecutor({config:{mode:'TESTNET'},now:()=>now});
  preview.store.records=signal?.records??[];
  preview.store.archived=signal?.archived??[];
  const signalRisk=preview.budgetSource(),scalpClosed=scalp?.closed??[];
  reset={at:now,day,completed:false,removed:{
   signal:[...preview.store.records,...preview.store.archived].filter(terminalTestnet).length,
   scalp:scalpClosed.length,copy:copy?.closed?.length??0,journal:shared?.journal?.filter(automaticTestnet).length??0},
   risk:{signal:{netUSD:signalRisk.realizedToday(day),provisional:signalRisk.provisionalToday(day)},
    scalp:{netUSD:scalpClosed.filter(x=>x.closedAt>0&&kstDay(x.closedAt)===day).reduce((sum,x)=>sum+(Number(x.netUSD)||0),0)}}};
  atomicWriteStore(marker,reset);
 }
 if(signal)atomicWriteStore(file('live-orders.json'),{...signal,
  records:(signal.records??[]).filter(x=>!terminalTestnet(x)),archived:(signal.archived??[]).filter(x=>!terminalTestnet(x))});
 if(scalp)atomicWriteStore(file('scalp-store.json'),{...scalp,closed:[],events:[],skips:[],skipCounts:{}});
 if(copy)atomicWriteStore(file('copy-store.json'),{...copy,closed:[],events:[]});
 if(shared?.journal?.some(automaticTestnet))atomicWriteStore(file('store.json'),{...shared,journal:shared.journal.filter(x=>!automaticTestnet(x))});
 fs.rmSync(file(SCALP_JOURNAL_FILE),{force:true});
 reset={...reset,completed:true};
 atomicWriteStore(marker,reset);
 return reset;
}

/** Keep only the same-day aggregate in the risk calculation, even after deleting the individual trades. */
export function withTestnetResetRisk(source,reset,strategy){
 if(reset?.clearRisk===true)return source;
 const old=reset?.risk?.[strategy];
 if(!old)return source;
 return {...source,
  realizedToday:day=>(source.realizedToday?.(day)??0)+(day===reset.day?old.netUSD:0),
  provisionalToday:day=>source.provisionalToday?.(day)===true||(day===reset.day&&old.provisional===true)};
}

export const TESTNET_PNL_RESET_2026_11_22='testnet-pnl-reset-2026-11-22.json';
export const TESTNET_PNL_RESET_MANUAL='testnet-pnl-reset-manual.json';

/**
 * Full testnet realized-PnL & daily-stop reset (keeps open/in-flight testnet positions and ALL live records untouched).
 * Unlike the 2026-11-18 history archive reset, this intentionally clears today's realized loss & dailyStop (clearRisk: true)
 * so legacy VST losses no longer block testnet trading.
 */
export function resetTestnetPnl(dir,{now=Date.now(),apply=true,markerName=TESTNET_PNL_RESET_2026_11_22}={}){
 const file=name=>path.join(dir,name);
 const marker=file(markerName);
 let reset=readStore(marker);
 if(reset?.completed)return reset;
 if(!apply)return null;
 const signal=readStore(file('live-orders.json'));
 const scalp=readStore(file('scalp-store.json'));
 const copy=readStore(file('copy-store.json'));
 const shared=readStore(file('store.json'));
 const budget=readStore(file('testnet-budget.json'));
 if(!reset){
  const day=kstDay(now);
  const sigRecords=[...(signal?.records??[]),...(signal?.archived??[])];
  reset={at:now,day,completed:false,clearRisk:true,removed:{
   signal:sigRecords.filter(terminalTestnet).length,
   scalp:scalp?.closed?.length??0,
   copy:copy?.closed?.length??0,
   journal:shared?.journal?.filter(automaticTestnet).length??0}};
  atomicWriteStore(marker,reset);
 }
 if(signal)atomicWriteStore(file('live-orders.json'),{...signal,
  records:(signal.records??[]).filter(x=>!terminalTestnet(x)),archived:(signal.archived??[]).filter(x=>!terminalTestnet(x))});
 if(scalp)atomicWriteStore(file('scalp-store.json'),{...scalp,closed:[],events:[],skips:[],skipCounts:{},dailyStop:null});
 if(copy)atomicWriteStore(file('copy-store.json'),{...copy,closed:[],events:[]});
 if(shared?.journal?.some(automaticTestnet))atomicWriteStore(file('store.json'),{...shared,journal:shared.journal.filter(x=>!automaticTestnet(x))});
 if(budget?.stop)atomicWriteStore(file('testnet-budget.json'),{...budget,stop:null});
 fs.rmSync(file(SCALP_JOURNAL_FILE),{force:true});
 reset={...reset,completed:true,clearRisk:true};
 atomicWriteStore(marker,reset);
 return reset;
}

/** Persist a manual on-demand testnet PnL reset marker so exchange PnL `since` survives restarts. */
export function recordManualTestnetPnlReset(dir,{now=Date.now(),removed={}}={}){
 const marker=path.join(dir,TESTNET_PNL_RESET_MANUAL);
 const reset={at:now,day:kstDay(now),completed:true,clearRisk:true,manual:true,removed:{
  signal:Number(removed.signal)||0,scalp:Number(removed.scalp)||0,copy:Number(removed.copy)||0,journal:Number(removed.journal)||0}};
 atomicWriteStore(marker,reset);
 return reset;
}

/** Pick the newest completed reset marker (by timestamp) across startup and manual resets. */
export function latestTestnetReset(dir,...resets){
 const manual=dir?readStore(path.join(dir,TESTNET_PNL_RESET_MANUAL)):null;
 const all=[...resets,manual].filter(r=>r&&r.completed&&Number(r.at)>0);
 if(!all.length)return null;
 return all.reduce((best,cur)=>Number(cur.at)>=Number(best.at)?cur:best);
}

