// 되돌림 단타 trade journal (user 2026-11-16 22:18: "매매에 대한 패턴 분석 및 개선해야 할 점을 알아야 해서 기록").
// scalp-journal.jsonl: one line per finished scalp trade, appended, never truncated.
// scalp-signals.jsonl: one line per detected signal (entered or why not), rotated at a size cap.
// Pure helpers plus small synchronous file appends: no network, no orders, no keys.
import fs from 'node:fs';
import path from 'node:path';

export const SCALP_JOURNAL_FILE='scalp-journal.jsonl',SCALP_SIGNALS_FILE='scalp-signals.jsonl';
export const SIGNALS_MAX_BYTES=20*1024*1024;
const r4=x=>Number.isFinite(x)?Math.round(x*1e4)/1e4:null,r2=x=>Number.isFinite(x)?Math.round(x*100)/100:null;
const kst=t=>new Date(t+9*3600000);
/** Signals are written one file per KST day (scalp-signals-YYYY-MM-DD.jsonl), so a report reads only the
 * last two days instead of every signal ever logged (review 2026-11-16). */
export const signalsPath=(base,t)=>base.replace(/\.jsonl$/,'')+'-'+kst(t).toISOString().slice(0,10)+'.jsonl';

/** Append one JSON line. maxBytes: the file is moved to <name>.1.jsonl (replacing the older one) first
 * when it has reached the cap. Returns false when nothing could be written (never throws). */
export function appendJsonl(file,obj,{maxBytes=0}={}){
 if(!file)return false;
 try{
  fs.mkdirSync(path.dirname(file),{recursive:true});
  if(maxBytes>0){let size=0;try{size=fs.statSync(file).size}catch{}if(size>=maxBytes)fs.renameSync(file,file.replace(/\.jsonl$/,'')+'.1.jsonl')}
  fs.appendFileSync(file,JSON.stringify(obj)+'\n');return true;
 }catch{return false}
}
/** All lines of a JSONL file (bad lines skipped); [] when it does not exist. */
export function readJsonl(file){
 let text='';try{text=fs.readFileSync(file,'utf8')}catch{return []}
 const out=[];for(const line of text.split('\n')){if(!line.trim())continue;try{out.push(JSON.parse(line))}catch{}}return out;
}
/** The newest `limit` lines (oldest first), reading the file from its end in chunks. */
export function tailJsonl(file,limit=200){
 let fd;try{fd=fs.openSync(file,'r')}catch{return []}
 try{
  const size=fs.fstatSync(fd).size,chunk=65536;let pos=size,text='',lines=[];
  while(pos>0){const n=Math.min(chunk,pos);pos-=n;const buf=Buffer.alloc(n);fs.readSync(fd,buf,0,n,pos);text=buf.toString('utf8')+text;
   lines=text.split('\n').filter(l=>l.trim());if(lines.length>limit)break}
  // When the read stopped mid-file the first piece may be a partial line: it is dropped.
  if(pos>0)lines=lines.slice(1);
  const out=[];for(const l of lines.slice(-limit)){try{out.push(JSON.parse(l))}catch{}}return out;
 }finally{fs.closeSync(fd)}
}

/** Last closed candle shape: rejection wick share of the range (toward the extreme), body share. */
export function candleShape(row,direction){
 const [o,h,l,c]=[row?.[1],row?.[2],row?.[3],row?.[4]].map(Number),range=h-l;if(!(range>0))return null;
 const wick=direction==='SHORT'?h-Math.max(o,c):Math.min(o,c)-l;
 return {open:o,high:h,low:l,close:c,volume:Number(row?.[5])||0,wickShare:r4(wick/range),bodyShare:r4(Math.abs(c-o)/range)};
}

/** Excursion of a mark from the average entry: % of the price and R (initial risk per unit). */
export function excursion(p,mark){
 const dir=p.direction==='SHORT'?-1:1,avg=Number(p.avg),risk=dir*(avg-Number(p.initialStop??p.stop));
 if(!(mark>0)||!(avg>0))return null;
 const move=dir*(mark-avg);return {pct:move/avg*100,r:risk>0?move/risk:null};
}
/** Keep the best (MFE) and worst (MAE) excursion seen on the position. */
export function trackExcursion(p,mark,at){
 const e=excursion(p,mark);if(!e)return;
 if(p.mfePct==null||e.pct>p.mfePct){p.mfePct=r4(e.pct);p.mfeR=r4(e.r);p.mfeAt=at}
 if(p.maePct==null||e.pct<p.maePct){p.maePct=r4(e.pct);p.maeR=r4(e.r);p.maeAt=at}
}

/** One journal line for a finished trade (the closed ledger row). */
export function journalLine(x){
 const dir=x.direction==='SHORT'?-1:1,avg=Number(x.avg),plan=Number(x.checkedPrice??x.entry),signal=Number(x.plannedEntry);
 const riskUnit=dir*(avg-Number(x.initialStop)),riskActual=riskUnit>0?riskUnit*Number(x.filled||x.qty):null;
 const realized=x.realized??null,net=realized?.netUSD??x.netUSD??null;
 const bps=(a,b)=>a>0&&b>0?r2(dir*(a-b)/b*1e4):null; // + = worse for us (paid more on a LONG, got less on a SHORT)
 // kind: MOVE_REVERSAL (5 % move) or ZONE_REVERSAL (매물대 반전, 2.5 % at a 4H / 1D zone; zone = the touched zone).
 return {v:1,strategy:x.strategy,kind:x.kind||'MOVE_REVERSAL',zone:x.zone??null,id:x.id,symbol:x.symbol,venueSymbol:x.venueSymbol,direction:x.direction,interval:x.interval||'5m',mode:x.mode,
  barAt:x.barAt,detectedAt:x.detectedAt??null,evidence:x.evidence??null,candle:x.candle??null,atr:x.atr??null,trend4h:x.trend4h??null,withTrend:x.withTrend??null,
  plan:{signalClose:signal||null,checkedPrice:plan||null,entry:x.entry,stop:x.initialStop,targets:x.targets,parts:x.parts,targetCount:x.targetCount??null,merged:x.merged===true,
   tp1NetR:r4(Number(x.netRR)),riskUSD:r4(Number(x.riskUSD)),marginUSD:r4(Number(x.marginUSD)),driftPct:x.driftPct??null},
  entry:{at:x.openedAt??null,price:avg||null,qty:x.filled??x.qty,leverage:x.leverage,delayMs:x.openedAt&&x.barAt?x.openedAt-x.barAt:null,
   slippageBpsVsPlan:bps(avg,plan),slippageBpsVsSignal:bps(avg,signal)},
  universe:x.universe??null,scan:x.scan??null,btc:x.btc??null,
  tpFills:(x.tpFills||[]).map((f,i)=>f?{tp:i+1,at:f.at??null,price:f.price??null,qty:f.qty??null}:null).filter(Boolean),tpHits:x.tpHits??0,
  breakeven:{moved:x.breakevenMoved===true,at:x.breakevenAt??null,price:x.breakevenMoved?x.stop:null},
  exit:{reason:x.closeReason,at:x.closedAt,holdMin:x.closedAt&&x.openedAt?r2((x.closedAt-x.openedAt)/60000):null,fills:x.exitFills??null},
  excursion:{mfePct:x.mfePct??null,mfeR:x.mfeR??null,mfeAt:x.mfeAt??null,maePct:x.maePct??null,maeR:x.maeR??null,maeAt:x.maeAt??null},
  pnl:{estimate:x.estimate??null,realized,netUSD:net,netSource:realized?'EXCHANGE':'ESTIMATE',feeUSD:realized?.feeUSD??x.estimate?.feeUSD??null,
   riskUSDActual:r4(riskActual),r:riskActual>0&&Number.isFinite(Number(net))?r4(Number(net)/riskActual):null},
  backfilled:x.journalBackfill===true||undefined,writtenAt:x.journalAt??null};
}

// ---- Summary for the reports push (latest.json `scalp`) --------------------------------------
const MOVE_BUCKETS=[[2.5,5],[5,6],[6,8],[8,12],[12,Infinity]],RANK_BUCKETS=[[1,10],[11,30],[31,60],[61,Infinity]];
const bucketLabel=([a,b],unit)=>b===Infinity?`${a}${unit}+`:`${a}-${b}${unit}`;
/** Win rate / PF / net / average R of a list of journal lines. */
export function groupStats(list){
 const n=list.length,net=x=>Number(x.pnl?.netUSD)||0,wins=list.filter(x=>net(x)>0),gross=wins.reduce((t,x)=>t+net(x),0),loss=-list.filter(x=>net(x)<0).reduce((t,x)=>t+net(x),0);
 const rs=list.map(x=>x.pnl?.r).filter(Number.isFinite),mfe=list.map(x=>x.excursion?.mfeR).filter(Number.isFinite),mae=list.map(x=>x.excursion?.maeR).filter(Number.isFinite);
 const avg=a=>a.length?r4(a.reduce((s,v)=>s+v,0)/a.length):null;
 return {trades:n,wins:wins.length,winRatePct:n?r2(wins.length/n*100):null,profitFactor:loss>0?r2(gross/loss):null,netUSD:r2(list.reduce((t,x)=>t+net(x),0)),
  avgR:avg(rs),avgMfeR:avg(mfe),avgMaeR:avg(mae),avgHoldMin:avg(list.map(x=>x.exit?.holdMin).filter(Number.isFinite))};
}
const by=(list,key)=>{const m={};for(const x of list){const k=key(x);if(k==null)continue;(m[k]??=[]).push(x)}return Object.fromEntries(Object.entries(m).map(([k,v])=>[k,groupStats(v)]))};
/** Stats by side, exit reason, move-size bucket, hour of day (KST, entry) and universe rank bucket. */
export function summarizeJournal(lines,{now=Date.now()}={}){
 const list=(lines||[]).filter(x=>x&&x.exit);
 const move=x=>{const m=Number(x.evidence?.movePct);const b=MOVE_BUCKETS.find(([a,c])=>m>=a&&m<c);return b?bucketLabel(b,'%'):null};
 const rank=x=>{const k=Number(x.universe?.rank);const b=RANK_BUCKETS.find(([a,c])=>k>=a&&k<=c);return b?bucketLabel(b,'위'):null};
 const hour=x=>{const t=x.entry?.at??x.barAt;return t?String(kst(t).getUTCHours()).padStart(2,'0'):null};
 return {generatedAt:new Date(now).toISOString(),all:groupStats(list),byKind:by(list,x=>x.kind||'MOVE_REVERSAL'),bySide:by(list,x=>x.direction),byExitReason:by(list,x=>x.exit?.reason),
  byMoveBucket:by(list,move),byHourKst:by(list,hour),byUniverseRank:by(list,rank),byTrend4h:by(list,x=>x.trend4h??'unknown'),byWithTrend:by(list,x=>x.trend4h==='range'?'range':x.withTrend==null?'unknown':x.withTrend?'with':'against'),
  last:list.slice(-5).map(x=>({symbol:x.symbol,kind:x.kind||'MOVE_REVERSAL',direction:x.direction,exitAt:x.exit?.at,reason:x.exit?.reason,r:x.pnl?.r,netUSD:x.pnl?.netUSD}))};
}
/** A journal line for the reports repository: no client order id (a trade key instead). */
export function exportLine(x){const {id,venueSymbol,...rest}=x;return {...rest,tradeKey:`${x.symbol}|${x.direction}|${x.barAt}`}}
/** Signals of one KST day (YYYY-MM-DD). */
export const signalsOfDay=(lines,day)=>(lines||[]).filter(x=>x?.at&&kst(x.at).toISOString().slice(0,10)===day);
/** Files and summary for the reports repository: scalp/trades.jsonl (every trade) and
 * scalp/signals-<KST day>.jsonl for today and yesterday (the day just finished is written complete). */
export function scalpReportFiles({journalFile,signalsFile,now=Date.now()}){
 const trades=journalFile?readJsonl(journalFile):[];
 const files={'scalp/trades.jsonl':trades.map(x=>JSON.stringify(exportLine(x))).join('\n')+(trades.length?'\n':'')};
 if(signalsFile){
  for(const t of [now-86400000,now]){const f=signalsPath(signalsFile,t),day=kst(t).toISOString().slice(0,10);
   const list=signalsOfDay([...readJsonl(f.replace(/\.jsonl$/,'')+'.1.jsonl'),...readJsonl(f)].map(({venueSymbol,...x})=>x),day);
   if(list.length)files[`scalp/signals-${day}.jsonl`]=list.map(x=>JSON.stringify(x)).join('\n')+'\n'}
 }
 return {files,summary:summarizeJournal(trades,{now})};
}
