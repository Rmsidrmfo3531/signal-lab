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

/** The report object (also used by tests to prove nothing secret is included). */
// scalp: the 되돌림 단타 journal summary (scalp_journal.mjs summarizeJournal), when given.
export function buildReport({readiness,insights,journal=[],records=[],scalp=null,now=Date.now()}){
 const report={generatedAt:new Date(now).toISOString(),readiness,insights,...(scalp?{scalp}:{}),
  journal:journal.filter(x=>x.source==='LIVE_AUTO').map(({id,...x})=>x),
  trades:records.filter(r=>r.status==='CLOSED'&&r.test!==true).map(tradeSummary),
  open:records.filter(r=>r.status==='OPEN'&&r.test!==true).map(r=>({symbol:r.symbol,direction:r.direction,createdAt:r.createdAt,pattern:r.signal?.pattern??null}))};
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
