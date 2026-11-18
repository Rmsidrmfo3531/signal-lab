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
 const old=reset?.risk?.[strategy];
 if(!old)return source;
 return {...source,
  realizedToday:day=>(source.realizedToday?.(day)??0)+(day===reset.day?old.netUSD:0),
  provisionalToday:day=>source.provisionalToday?.(day)===true||(day===reset.day&&old.provisional===true)};
}
