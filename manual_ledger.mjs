// Manual trades on the BingX REAL account, recorded like copy trades (user 2026-11-17 "내가 수동으로 매매한 것도
// 누적 수익이라던지 기록은 똑같이 해야지 단지 이게 수동인지 아닌지 표시만 해줘").
//
// Read-only: driven by the venue position snapshots (venue_positions.mjs, GET positions, shared 3 s cache) and the
// account's income history (GET income) for the exact result. It never sends an order and never writes into the
// copy ledger (copy-store-live.json); its own file is manual-trades-live.json in the data folder.
//
//  - A venue row tagged 수동 (no OPEN copy-ledger position on that symbol and direction) seen on 2 distinct reads in a
//    row -> an OPEN manual record (symbol, direction, hedge, first seen, size, avg, leverage). On the first read after
//    a start, rows already open are adopted at once (openedAt = now, adoptedAtStart).
//  - Size changes -> adds / reductions (count, max size, an estimate of the realized part).
//  - Gone on 2 distinct reads in a row -> closed (closedAt = the first read without it), then settled from BingX
//    income for that symbol in [openedAt - 60 s, closedAt + 120 s]: REALIZED_PNL + TRADING_FEE + FUNDING_FEE ->
//    netUSD, netSource EXCHANGE. While the closing income has not shown up: PENDING (retried, up to settleDeadlineMs),
//    then ESTIMATE. When a copy position of the same symbol lived in that window (or another manual one overlapped in
//    time, hedge mode), income cannot be split by owner: MIXED_WITH_COPY / MIXED_WITH_MANUAL with the estimate
//    (exit mark - avg) x size - fees estimate. Income rows used once are remembered and never counted twice.
//  - A copy position made bigger by a manual add (one-way merge) is shown as copy by the tagging and stays a copy
//    record: no manual record is made for it. A manual record whose row later turns copy (the copy ledger entered the
//    same symbol and side) is frozen at its manual size and closes as MIXED_WITH_COPY.
//
// Risk: the copy loss limit, the copy margin limits and every copy trading decision are computed by copy_executor.mjs
// from the copy ledger only. Nothing here feeds them; manual trades only join the page's totals and the report.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {atomicWriteStore,readStore} from './persistence.mjs';
import {executionFills,summarizeBalancedFills} from './live_clients.mjs';
import {readPositionMode} from './bingx_position_mode.mjs';

export const MANUAL_LEDGER_FILE='manual-trades-live.json';
const MAX_CLOSED=1000,MAX_EVENTS=200,MAX_CLAIMED=3000;
const INCOME_TYPES=new Set(['REALIZED_PNL','TRADING_FEE','FUNDING_FEE']);
const num=v=>v===null||v===undefined||v===''?null:Number.isFinite(Number(v))?Number(v):null;
const r6=x=>x==null?null:Math.round(x*1e6)/1e6;
const keyOf=(venueSymbol,direction)=>`${venueSymbol}|${direction}`;
const incomeKey=x=>String(x?.tranId??x?.tradeId??[x?.incomeType,x?.symbol,x?.time,x?.income].join('|'));
function flatTrades(rows){
 const completed=[];let balance=0,parts=[];
 for(const fill of rows){
  const next=balance+(fill.side==='BUY'?fill.qty:-fill.qty);
  const tolerance=Math.max(1e-9,Math.abs(balance)*1e-8);
  // A single one-way fill that crosses zero needs split accounting to distinguish the two trades.
  if(balance&&Math.sign(next)!==Math.sign(balance)&&Math.abs(next)>tolerance)return [];
  parts.push(fill);balance=next;
  if(Math.abs(balance)<=tolerance){completed.push(parts);parts=[];balance=0}
 }
 return parts.length?[]:completed;
}

export class ManualLedger{
 /** client: the BingX real-account client (income() only). copyRecords(): the copy ledger's positions and closed
  * rows (read only, for the window check). */
 constructor({directory=null,fileName=MANUAL_LEDGER_FILE,client=null,copyRecords=()=>[],now=()=>Date.now(),log=()=>{},onEvent=()=>{},
  feeRate=0.0005,openReads=2,closeReads=2,settleDelayMs=20000,settleDeadlineMs=5*60000,preMs=60000,postMs=120000,copyCloseGraceMs=30000}={}){
  Object.assign(this,{client,copyRecords,now,log,onEvent,feeRate,openReads,closeReads,settleDelayMs,settleDeadlineMs,preMs,postMs,copyCloseGraceMs});
  this.file=directory?path.join(directory,fileName):null;
  const saved=this.file&&fs.existsSync(this.file)?readStore(this.file):null;
  this.store={origin:'manual',account:'BINGX_LIVE',positions:saved?.positions||{},closed:saved?.closed||[],events:saved?.events||[],claimed:saved?.claimed||[]};
  this.lastReadAt=0;this.started=false;this.candidates=new Map();this.settling=null;this.notices=[];
  this.lastFillSnapshot=null;this.fillWindows=[];this.scanningFills=null;this.lastFillScanAt=0;
 }
 #save(){
  if(this.file){
   this.store.closed=this.store.closed.slice(-MAX_CLOSED);this.store.events=this.store.events.slice(-MAX_EVENTS);this.store.claimed=this.store.claimed.slice(-MAX_CLAIMED);
   fs.mkdirSync(path.dirname(this.file),{recursive:true});atomicWriteStore(this.file,{version:1,...this.store});
  }
  for(const event of this.notices.splice(0))try{this.onEvent(event)}catch{this.log('[MANUAL] notice failed')}
 }
 #event(type,detail={},notify=false){
  const e={type,at:this.now(),...detail};this.store.events.push(e);if(notify)this.notices.push(e);
  this.log(`[MANUAL] ${type} ${detail.symbol||''}`.trim());return e;
 }
 #copyList(){try{const l=this.copyRecords();return Array.isArray(l)?l.filter(Boolean):[]}catch{return []}}

 /** One venue snapshot ({venuePositions, venuePositionsAt}, rows tagged copy / manual). A snapshot already seen (the
  * same read time, e.g. the cached list or a failed refresh) is ignored, so "2 reads" are 2 distinct venue reads. */
 observe(snap){
  const rows=Array.isArray(snap?.venuePositions)?snap.venuePositions:null,at=num(snap?.venuePositionsAt);
  if(!rows||!at||at<=this.lastReadAt)return false;
  if(typeof this.client?.fillOrders==='function'){
   const symbols=new Set(rows.map(r=>r.venueSymbol)),prior=this.lastFillSnapshot;
   if(prior&&at-prior.at<=5*60000)this.fillWindows.push({from:prior.at,to:at,blocked:new Set([...prior.symbols,...symbols])});
   this.lastFillSnapshot={at,symbols};
   this.fillWindows=this.fillWindows.slice(-240);
  }
  this.lastReadAt=at;const first=!this.started;this.started=true;let changed=false;
  const byKey=new Map();for(const r of rows)if(r?.venueSymbol&&r.direction&&r.size>0)byKey.set(keyOf(r.venueSymbol,r.direction),r);
  for(const [key,p] of Object.entries(this.store.positions)){
   const row=byKey.get(key);
   if(!row){p.missing=(p.missing||0)+1;if(p.missing===1)p.goneAt=at;changed=true;
    if(p.missing>=this.closeReads)this.#close(p,p.goneAt);continue}
   if(p.missing){p.missing=0;delete p.goneAt;changed=true}
   p.lastSeenAt=at;
   if(row.origin==='copy'){
    // The copy ledger entered the same symbol and side: the venue position is shared from here on.
    if(!p.mergedIntoCopy){p.mergedIntoCopy=at;this.#event('MANUAL_MERGED_INTO_COPY',{symbol:p.symbol,direction:p.direction,size:p.size});changed=true}
    continue;
   }
   if(p.mergedIntoCopy)continue; // frozen at the manual size until the venue position is gone
   changed=this.#track(p,row,at)||changed;
  }
  for(const [key,row] of byKey){
   if(row.origin==='copy'||this.store.positions[key]){this.candidates.delete(key);continue}
   // A copy position of the same symbol and side that was just closed: a cached list may still show it untagged.
   const justClosed=this.#copyList().some(c=>c.status==='CLOSED'&&c.venueSymbol===row.venueSymbol&&c.direction===row.direction&&num(c.closedAt)!=null&&c.closedAt>=at-this.copyCloseGraceMs);
   if(justClosed){this.candidates.delete(key);continue}
   if(first){this.#open(row,at,true);changed=true;continue}
   const c=this.candidates.get(key)||{seen:0,firstAt:at};c.seen++;this.candidates.set(key,c);
   if(c.seen>=this.openReads){this.candidates.delete(key);this.#open(row,c.firstAt,false);changed=true}
  }
  for(const key of [...this.candidates.keys()])if(!byKey.has(key)||byKey.get(key).origin==='copy')this.candidates.delete(key);
  if(changed)this.#save();
  return changed;
 }
 #open(row,at,adopted){
  const key=keyOf(row.venueSymbol,row.direction),price=num(row.avg)??num(row.mark)??0;
  const p={id:`${key}|${at}`,key,origin:'manual',symbol:row.symbol,venueSymbol:row.venueSymbol,direction:row.direction,hedge:row.positionSide==='LONG'||row.positionSide==='SHORT',
   status:'OPEN',openedAt:at,firstSeenAt:at,lastSeenAt:at,sizeSinceAt:at,size:row.size,qty:row.size,maxSize:row.size,firstSize:row.size,avg:num(row.avg),firstAvg:num(row.avg),
   leverage:num(row.leverage),marginMode:row.marginMode??null,mark:num(row.mark),unrealized:num(row.unrealized),adds:0,reduces:0,realizedEstUSD:0,tradedNotionalUSD:row.size*price,
   ...(adopted?{adoptedAtStart:true}:{})};
  this.store.positions[key]=p;this.#event(adopted?'MANUAL_ADOPTED':'MANUAL_OPEN',
   {symbol:p.symbol,direction:p.direction,size:p.size,avg:p.avg,leverage:p.leverage,observedAt:at},!adopted);
 }
 #track(p,row,at){
  const dir=p.direction==='LONG'?1:-1,mark=num(row.mark)??num(row.avg)??p.mark??p.avg??0,size=row.size,diff=size-p.size;
  let changed=false;
  if(Math.abs(diff)>Math.max(1e-12,p.size*1e-9)){
   const detail={symbol:p.symbol,direction:p.direction,from:p.size,to:size,avg:num(row.avg)??p.avg,observedAt:at};
   if(diff>0){p.adds++;p.tradedNotionalUSD+=diff*mark;this.#event('MANUAL_ADD',detail,true)}
   else{p.reduces++;p.realizedEstUSD+=dir*(mark-(p.avg??mark))*(-diff);p.tradedNotionalUSD+=(-diff)*mark;this.#event('MANUAL_REDUCE',detail,true)}
   p.size=size;p.qty=size;p.maxSize=Math.max(p.maxSize,size);p.sizeSinceAt=at;changed=true;
  }
  const avg=num(row.avg);if(avg&&avg!==p.avg){p.avg=avg;changed=true}
  const lev=num(row.leverage);if(lev&&lev!==p.leverage){p.leverage=lev;changed=true}
  p.mark=num(row.mark)??p.mark;p.unrealized=num(row.unrealized);p.markAt=at;
  return changed;
 }
 /** (exit mark - avg) x size, plus the reductions' estimate, minus a taker fee on every traded notional. */
 #estimate(p){
  const dir=p.direction==='LONG'?1:-1,exit=p.mark??p.avg;
  if(!(exit>0)||!(p.avg>0))return null;
  return r6(p.realizedEstUSD+dir*(exit-p.avg)*p.size-this.feeRate*(p.tradedNotionalUSD+p.size*exit));
 }
 #close(p,closedAt){
  delete this.store.positions[p.key];
  const row={...p,status:'CLOSED',closedAt,exitMark:p.mark??null,closeReason:'MANUAL_OR_VENUE_CLOSE',estimateUSD:this.#estimate(p),
   netUSD:null,netSource:'PENDING',notifySettlement:!p.mergedIntoCopy};
  delete row.missing;delete row.goneAt;
  this.store.closed.push(row);
  this.#event('MANUAL_CLOSE',{symbol:p.symbol,direction:p.direction,size:p.size,estimateUSD:row.estimateUSD});
 }
 /** Recover trades opened and closed entirely between successful position reads. */
 recoverFastTrades(){
  if(typeof this.client?.fillOrders!=='function')return Promise.resolve();
  if(this.scanningFills)return this.scanningFills;
  const now=this.now();
  if(now-this.lastFillScanAt<30000)return Promise.resolve();
  const ready=this.fillWindows.filter(w=>w.to<=now-45000);
  if(!ready.length)return Promise.resolve();
  const first=ready[0],windows=ready.filter(w=>w.from<first.from+5*60000);
  this.lastFillScanAt=now;
  this.scanningFills=this.#recoverWindows(windows,now).catch(e=>this.log(`[MANUAL] fill history ${e?.code||e?.message||'FAILED'}`)).finally(()=>{this.scanningFills=null});
  return this.scanningFills;
 }
 async #recoverWindows(windows,now){
  const fills=executionFills(await this.client.fillOrders({startTs:windows[0].from,endTs:windows.at(-1).to}));
  const ambiguous=fills.some(f=>!['LONG','SHORT','BOTH'].includes(f.positionSide));
  const mode=ambiguous&&typeof this.client.positionMode==='function'?await readPositionMode(this.client):null;
  const oneWay=mode?.ok&&mode.hedge===false,managed=this.#copyList();
  let changed=false;
  for(const w of windows){
   const groups=new Map();
   for(const f of fills){
    if(f.at<=w.from||f.at>=w.to||w.blocked.has(f.symbol))continue;
    if(managed.some(p=>p.venueSymbol===f.symbol&&(p.openedAt??p.createdAt??0)<=w.to&&(p.closedAt??Infinity)>=w.from))continue;
    const dir=['LONG','SHORT'].includes(f.positionSide)?f.positionSide:f.positionSide==='BOTH'||oneWay?'BOTH':null;
    const rows=groups.get(f.symbol)||[];rows.push({...f,dir});groups.set(f.symbol,rows);
   }
   for(const [venueSymbol,rows] of groups){
    if(rows.some(f=>!f.dir)||rows.some(f=>f.dir==='BOTH')&&rows.some(f=>f.dir!=='BOTH'))continue;
    for(const lane of new Set(rows.map(f=>f.dir)))for(const laneFills of flatTrades(rows.filter(f=>f.dir===lane))){
     const direction=lane==='BOTH'?(laneFills[0].side==='BUY'?'LONG':'SHORT'):lane;
     const result=summarizeBalancedFills(laneFills,direction);
     if(!result)continue;
     const openedAt=laneFills[0].at,closedAt=laneFills.at(-1).at;
     const tradeId='fills:'+createHash('sha256').update(laneFills.map(f=>f.tradeId).join('|')).digest('hex').slice(0,24);
     if(this.store.closed.some(p=>p.id===tradeId||p.venueSymbol===venueSymbol&&p.direction===direction&&p.openedAt<=closedAt&&p.closedAt>=openedAt))continue;
     const symbol=venueSymbol.replace(/-/g,'');
     this.store.closed.push({id:tradeId,origin:'manual',status:'CLOSED',symbol,venueSymbol,direction,openedAt,closedAt,
      size:result.qty,qty:result.qty,avg:result.avg,pnlUSD:result.pnlUSD,feeUSD:result.feeUSD,netUSD:result.netUSD,
      netSource:'EXCHANGE_FILLS',settledAt:now,closeReason:'MISSED_SNAPSHOT_ROUND_TRIP'});
     this.#event('MANUAL_SETTLED',{symbol,direction,size:result.qty,netSource:'EXCHANGE_FILLS',netUSD:result.netUSD,observedAt:closedAt,fromFills:true},true);
     changed=true;
    }
   }
  }
  if(changed){this.store.closed.sort((a,b)=>a.closedAt-b.closedAt);this.#save()}
  const done=new Set(windows);this.fillWindows=this.fillWindows.filter(w=>!done.has(w));
 }

 /** Settles closed records still PENDING (oldest first). One run at a time; never throws. */
 settle(){
  if(this.settling)return this.settling;
  this.settling=this.#settleAll().catch(e=>{this.log(`[MANUAL] settle ${e?.code||e?.message||e}`)}).finally(()=>{this.settling=null});
  return this.settling;
 }
 async #settleAll(){
  const now=this.now(),todo=this.store.closed.filter(x=>x.netSource==='PENDING'&&now>=x.closedAt+this.settleDelayMs).sort((a,b)=>a.closedAt-b.closedAt);
  let changed=false;
  for(const x of todo){if(await this.#settleOne(x,now))changed=true}
  if(changed)this.#save();
 }
 #window(x,now){
  const start=x.openedAt-this.preMs;let end=Math.min(x.closedAt+this.postMs,now);
  // A later position on the same symbol (copy or manual) starts its own income: the window ends before it.
  for(const c of this.#copyList())if(c.venueSymbol===x.venueSymbol&&num(c.openedAt)>x.closedAt)end=Math.min(end,c.openedAt-1);
  for(const m of [...this.store.closed,...Object.values(this.store.positions)])if(m!==x&&m.venueSymbol===x.venueSymbol&&m.openedAt>x.closedAt)end=Math.min(end,Math.max(x.closedAt,m.openedAt-20000));
  return {start,end};
 }
 #mixed(x,{start}){
  const live=(a0,a1,b0,b1)=>a0<=b1&&b0<=a1;
  if(x.mergedIntoCopy)return 'MIXED_WITH_COPY';
  // Copy rows carry openedAt / closedAt; an open one runs to now.
  if(this.#copyList().some(c=>c.venueSymbol===x.venueSymbol&&num(c.openedAt)!=null&&live(c.openedAt,num(c.closedAt)??Infinity,start,x.closedAt)))return 'MIXED_WITH_COPY';
  if([...this.store.closed,...Object.values(this.store.positions)].some(m=>m!==x&&m.id!==x.id&&m.venueSymbol===x.venueSymbol&&live(m.openedAt,m.closedAt??Infinity,x.openedAt,x.closedAt)))return 'MIXED_WITH_MANUAL';
  return null;
 }
 async #settleOne(x,now){
  const w=this.#window(x,now),mixed=this.#mixed(x,w);
  const done=(netSource,netUSD,extra={})=>{
   Object.assign(x,{netSource,netUSD:netUSD==null?null:r6(netUSD),settledAt:now,...extra});
   this.#event('MANUAL_SETTLED',{symbol:x.symbol,direction:x.direction,size:x.size,netSource,netUSD:x.netUSD,observedAt:x.closedAt},x.notifySettlement===true);
   delete x.notifySettlement;
   return true;
  };
  if(mixed)return done(mixed,x.estimateUSD);
  const expired=now>=x.closedAt+this.settleDeadlineMs;
  if(!this.client||typeof this.client.income!=='function')return expired?done('ESTIMATE',x.estimateUSD,{incomeMissing:'NO_CLIENT'}):false;
  let rows;
  try{const res=await this.client.income({symbol:x.venueSymbol,startTime:w.start,endTime:w.end,limit:1000});
   rows=Array.isArray(res)?res:Array.isArray(res?.list)?res.list:Array.isArray(res?.data)?res.data:null;
   if(!rows)throw Object.assign(Error('BAD_RESPONSE'),{code:'BAD_RESPONSE'})}
  catch(e){x.settleError=String(e?.code||e?.message||'INCOME_FAILED').slice(0,60);x.settleTries=(x.settleTries||0)+1;
   return expired?done('ESTIMATE',x.estimateUSD,{incomeMissing:x.settleError}):true}
  const claimed=new Set(this.store.claimed);
  const mine=rows.filter(r=>r&&r.symbol===x.venueSymbol&&INCOME_TYPES.has(String(r.incomeType))&&num(r.time)!=null&&r.time>=w.start&&r.time<=w.end&&!claimed.has(incomeKey(r)));
  // The close itself: a realized row after the size was last seen changing (earlier reductions are before it).
  const closing=mine.some(r=>r.incomeType==='REALIZED_PNL'&&r.time>(x.sizeSinceAt??x.openedAt)-1000);
  if(!closing){x.settleTries=(x.settleTries||0)+1;return expired?done('ESTIMATE',x.estimateUSD,{incomeMissing:'NO_CLOSE_INCOME'}):true}
  const sum=t=>mine.filter(r=>r.incomeType===t).reduce((a,r)=>a+(num(r.income)||0),0);
  const pnl=sum('REALIZED_PNL'),fee=sum('TRADING_FEE'),funding=sum('FUNDING_FEE');
  for(const r of mine)this.store.claimed.push(incomeKey(r));
  delete x.settleError;
  return done('EXCHANGE',pnl+fee+funding,{pnlUSD:r6(pnl),feeUSD:r6(fee),fundingUSD:r6(funding),incomeRows:mine.length});
 }

 /** For the page: open records, the last 200 closes (newest first, origin manual) and totals of the settled ones. */
 status(){
  const pub=x=>{const {claimed,missing,goneAt,notifySettlement,...rest}=x;return {...rest,origin:'manual'}};
  const closed=this.store.closed,settled=closed.filter(x=>x.netUSD!=null&&Number.isFinite(Number(x.netUSD)));
  return {open:Object.values(this.store.positions).map(pub),closed:closed.slice(-200).reverse().map(pub),closedTotal:closed.length,
   pending:closed.filter(x=>x.netSource==='PENDING').length,settled:settled.length,netUSD:r6(settled.reduce((a,x)=>a+Number(x.netUSD),0))};
 }
}
