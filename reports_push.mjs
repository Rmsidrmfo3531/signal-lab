// Daily results to a separate private GitHub repository (signal-lab-reports) so the results can be
// reviewed and the strategy improved without access to this server. Only results are written:
// readiness, per-pattern insights, automatic journal entries and closed-trade summaries.
// Never .env, keys, tokens, order ids or account numbers. Pushed with its own deploy key
// (deploy/linux/reports.sh) that can write to that repository only.
import fs from 'node:fs';
import path from 'node:path';
import {execFile} from 'node:child_process';

// git gets only what it needs (never the server's keys or tokens from the environment).
const run=(cwd,args,env)=>new Promise((ok,fail)=>execFile('git',args,{cwd,env:{PATH:process.env.PATH,HOME:process.env.HOME,LANG:'C',...env},timeout:60000},(e,out,err)=>e?fail(Error(String(err||e.message).trim().split('\n').pop())):ok(String(out).trim())));
const SECRET=/(api[_-]?key|secret|token|password|passphrase|signature)/i;

/** Plain results for one closed live record (no order ids, no client ids). */
export function tradeSummary(r){
 return {symbol:r.symbol,mode:r.mode,direction:r.direction,leverage:r.leverage??null,pattern:r.signal?.pattern??String(r.signalKey||'').split(':')[3]??null,
  score:r.signal?.score??null,btcTrend:r.signal?.btcTrend??null,trend4h:r.signal?.trend4h??null,createdAt:r.createdAt??null,closedAt:r.closedAt??null,
  closeReason:r.closeReason??null,firstEntryPrice:r.firstEntryPrice??r.plannedEntry??null,stop:r.stop??null,targets:r.targets??[],
  adds:{filled:(r.adds||[]).filter(a=>a.filled).length,max:(r.adds||[]).length},breakevenMoved:r.breakevenMoved===true,
  realized:r.realized?{source:r.realized.source,netUSD:r.realized.netUSD??null,pnlUSD:r.realized.pnlUSD??null,feeUSD:r.realized.feeUSD??null}:null,
  events:(r.events||[]).map(e=>({type:e.type,at:e.at,reason:e.reason??null}))};
}

// Events worth a look in the daily check (copy / scalp ledgers).
const SERIOUS_EVENTS=new Set(['ERROR','STOP_NOT_SET','COPY_LOSS_LIMIT','DAILY_LOSS_LIMIT','EMERGENCY_CLOSE_FAILED','STOP_FAILED','ENTRY_OUTCOME_UNKNOWN','TARGET_FAILED','RECONCILE_ERROR']);
const num=v=>Number.isFinite(Number(v))&&v!==null&&v!==''?Math.round(Number(v)*1e4)/1e4:null;
// A reason is kept as a short code or a short text cut at 80 characters (venue messages, never ids).
const shortReason=v=>v==null?null:String(v).replace(/\d{9,}/g,'#').slice(0,80);

/** Copy (testnet / real account) or scalp ledger: closed and open positions, totals and serious events.
 * Whitelisted fields only (no order ids, no position ids). Null when the ledger file does not exist. */
export function ledgerSummary(store,{now=Date.now(),equityUSD=null}={}){
 if(!store)return null;
 // manualLive (manual_ledger.mjs): manual trades on the real account, each trade marked origin 'manual'.
 const origin=store.origin==='manual'?'manual':null;
 const closed=(store.closed||[]).filter(x=>x&&x.test!==true).slice().sort((a,b)=>(a.closedAt||0)-(b.closedAt||0));
 const open=Array.isArray(store.open)?store.open:Object.values(store.positions||{});
 let cum=0,peak=0,maxDD=0,wins=0,known=0;
 for(const x of closed){const n=Number(x.netUSD);if(!Number.isFinite(n))continue;known++;if(n>0)wins++;cum+=n;peak=Math.max(peak,cum);maxDD=Math.max(maxDD,peak-cum)}
 const week=now-7*86400000,events=(store.events||[]).filter(e=>e&&(e.at||0)>=week);
 const counts={};for(const e of events)counts[e.type]=(counts[e.type]||0)+1;
 return {equityUSD:num(equityUSD),closedCount:closed.length,settled:known,wins,winRatePct:known?Math.round(wins/known*1000)/10:null,netUSD:num(cum),maxDrawdownUSD:num(maxDD),killed:store.killed===true,
  trades:closed.slice(-100).map(x=>({...(origin?{origin}:{}),...(x.kind?{kind:x.kind}:{}),symbol:x.symbol,direction:x.direction,leverage:x.leverage??null,openedAt:x.openedAt??x.createdAt??null,closedAt:x.closedAt??null,closeReason:shortReason(x.closeReason),
   avg:num(x.avg),adds:typeof x.adds==='number'?x.adds:Array.isArray(x.adds)?x.adds.filter(a=>a?.filled).length:null,reduces:x.reduces??null,tpHits:x.tpHits??null,
   netUSD:num(x.netUSD),netSource:x.netSource??null,theirPnlUSD:num(x.theirPnlUSD),
   ...(origin?{maxSize:num(x.maxSize),estimateUSD:num(x.estimateUSD),adoptedAtStart:x.adoptedAtStart===true,mergedIntoCopy:Boolean(x.mergedIntoCopy)}:{})})),
  open:open.filter(p=>p&&p.status!=='CLOSED').map(p=>({...(origin?{origin}:{}),symbol:p.symbol,direction:p.direction,leverage:p.leverage??null,openedAt:p.openedAt??p.createdAt??null,avg:num(p.avg),adds:typeof p.adds==='number'?p.adds:null,stop:num(p.stop)})),
  eventCounts7d:counts,
  // Skips and errors of the last 7 days with their reason (user 2026-11-17: "오류로 못 들어간 건지 분석해서 못 들어간 건지").
  issues:events.filter(e=>['SKIPPED','ADD_SKIPPED','ERROR','STOP_NOT_SET','LATE_ENTRY','ENTRY_RETRY_MIN','ENTRY_RETRY','ADD_RETRY','CLOSE_RETRY','RETRY_ABANDONED','ENTRY_NOT_FILLED','UNCONFIRMED_ADOPT'].includes(e.type)).slice(-150).map(e=>({type:e.type,at:e.at,symbol:e.symbol??null,direction:e.direction??null,kind:e.kind??null,
   reason:shortReason(e.reason??e.code),cause:e.cause??null,detail:typeof e.detail==='string'?e.detail.slice(0,160):null,from:num(e.from),to:num(e.to),need:num(e.need)})),
  serious:events.filter(e=>SERIOUS_EVENTS.has(e.type)).slice(-30).map(e=>({type:e.type,at:e.at,symbol:e.symbol??null,reason:shortReason(e.reason??e.code)}))};
}

/** The report object (also used by tests to prove nothing secret is included). */
// scalp: the 되돌림 단타 journal summary (scalp_journal.mjs summarizeJournal), when given.
export function buildReport({readiness,insights,journal=[],records=[],scalp=null,ledgers={},exchange=null,now=Date.now()}){
 // exchange = the BingX accounts' own income history and balance (exchange_pnl.mjs), the exact result.
 const report={generatedAt:new Date(now).toISOString(),readiness,insights,...(scalp?{scalp}:{}),...(exchange?{exchange}:{}),
  journal:journal.filter(x=>x.source==='LIVE_AUTO').map(({id,...x})=>x),
  trades:records.filter(r=>r.status==='CLOSED'&&r.test!==true).map(tradeSummary),
  open:records.filter(r=>r.status==='OPEN'&&r.test!==true).map(r=>({symbol:r.symbol,direction:r.direction,createdAt:r.createdAt,pattern:r.signal?.pattern??null})),
  // copyLive = real-money copy (copy-store-live.json), manualLive = manual trades on that account
  // (manual-trades-live.json), copyTestnet, scalp (testnet only).
  ledgers:Object.fromEntries(Object.entries(ledgers).map(([k,v])=>[k,v?ledgerSummary(v.store,{now,equityUSD:v.equityUSD}):null]))};
 const text=JSON.stringify(report);
 for(const key of text.matchAll(/"([^"]+)":/g))if(SECRET.test(key[1]))throw Error('REPORT_SECRET_FIELD '+key[1]);
 return report;
}

export const REPORT_FILE_MAX_BYTES=50*1024*1024;
/** Write latest.json and days/<KST date>.json (and `files`: {relative path: text}, e.g. the scalp journal),
 * commit and push. Returns {pushed, reason}. A file path outside the repository, or one larger than
 * REPORT_FILE_MAX_BYTES, is not written. */
export async function pushReport(dir,report,{keyFile,git=run,now=Date.now(),files={}}={}){
 if(!dir||!fs.existsSync(path.join(dir,'.git')))return {pushed:false,reason:'REPORTS_REPO_NOT_SET_UP'};
 const env=keyFile?{GIT_SSH_COMMAND:`ssh -i ${keyFile} -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes`}:{};
 const day=new Date(now+9*3600000).toISOString().slice(0,10);
 await git(dir,['pull','--ff-only','--quiet'],env).catch(()=>{});
 fs.mkdirSync(path.join(dir,'days'),{recursive:true});
 const body=JSON.stringify(report,null,1)+'\n';
 fs.writeFileSync(path.join(dir,'latest.json'),body);fs.writeFileSync(path.join(dir,'days',day+'.json'),body);
 const extra=[];
 for(const [rel,text] of Object.entries(files||{})){
  if(typeof text!=='string'||!/^[a-z0-9][a-z0-9_\-/.]*$/i.test(rel)||rel.includes('..')||Buffer.byteLength(text)>REPORT_FILE_MAX_BYTES)continue;
  const SECRET_KEY=/"[^"]*(api[_-]?key|secret|token|password|passphrase|signature)[^"]*":/i;if(SECRET_KEY.test(text))throw Error('REPORT_SECRET_FIELD '+rel);
  fs.mkdirSync(path.dirname(path.join(dir,rel)),{recursive:true});fs.writeFileSync(path.join(dir,rel),text);extra.push(rel);
 }
 await git(dir,['add','latest.json','days/'+day+'.json',...extra],env);
 const changed=await git(dir,['status','--porcelain'],env);
 if(!changed)return {pushed:false,reason:'NO_CHANGE'};
 await git(dir,['-c','user.name=signal-lab-server','-c','user.email=signal-lab-server@users.noreply.github.com','commit','-q','-m','report '+day],env);
 await git(dir,['push','-q','origin','HEAD'],env);
 return {pushed:true,day};
}
