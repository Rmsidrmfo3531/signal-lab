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
import {confirmedBingxFills,completeBingxOrders,summarizeBalancedFills} from './live_clients.mjs';
import {readPositionMode} from './bingx_position_mode.mjs';

export const MANUAL_LEDGER_FILE='manual-trades-live.json';
const MAX_CLOSED=1000,MAX_EVENTS=200,MAX_CLAIMED=3000;
const INCOME_TYPES=new Set(['REALIZED_PNL','TRADING_FEE','FUNDING_FEE']);
const num=v=>v===null||v===undefined||v===''?null:Number.isFinite(Number(v))?Number(v):null;
const r6=x=>x==null?null:Math.round(x*1e6)/1e6;
const keyOf=(venueSymbol,direction)=>`${venueSymbol}|${direction}`;
const ownerOf=p=>p?.alertOrigin&&p.alertOwnerId?`${p.alertOrigin}|${p.alertOwnerId}`:null;
const incomeKey=x=>String(x?.tranId??x?.tradeId??[x?.incomeType,x?.symbol,x?.time,x?.income].join('|'));
const FILL_DELAY_MS=1500;
const qtyTolerance=qty=>Math.max(1e-12,Math.abs(qty)*1e-8);
const alertOrderKey=(symbol,orderId)=>createHash('sha256').update(`${symbol}|${orderId}`).digest('hex').slice(0,32);
function fillActions(fills,{symbol,direction,leverage,alertOrigin='MANUAL',initialSize=0}){
 const groups=[];
 for(const fill of fills){
  const last=groups.at(-1);
  if(last?.[0].orderId===fill.orderId&&last[0].side===fill.side)last.push(fill);
  else groups.push([fill]);
 }
 let size=initialSize;
 return groups.map(group=>{
  const from=size,qty=group.reduce((sum,f)=>sum+f.qty,0),opening=group[0].side===(direction==='SHORT'?'SELL':'BUY');
  const common={symbol,direction,leverage,alertOrigin,observedAt:group.at(-1).at,fromFills:true,
   alertKey:alertOrderKey(group[0].symbol,group[0].orderId)};
  if(opening){
   const avg=group.reduce((sum,f)=>sum+f.price*f.qty,0)/qty;size+=qty;
   return {type:from>0?'MANUAL_ADD':'MANUAL_OPEN',detail:{...common,from,to:size,size:qty,avg}};
  }
  const left=from-qty;size=Math.abs(left)<=qtyTolerance(from)?0:left;
  return {type:size===0?'MANUAL_SETTLED':'MANUAL_REDUCE',detail:{...common,from,to:size,size:qty,netSource:'EXCHANGE_FILLS',
   netUSD:Number(group.reduce((sum,f)=>sum+f.pnl+f.fee,0).toFixed(12))}};
 });
}
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
/** A complete fill cycle must agree with both the first and last observed position sizes. */
function historicalManualCycle(rows,p){
 const opening=p.direction==='SHORT'?'SELL':'BUY',firstAt=p.firstSeenAt??p.openedAt,lastAt=p.lastSeenAt??p.sizeSinceAt;
 if(!(p.firstSize>0&&p.size>0&&lastAt>0)||p.adoptedAtStart||p.mergedIntoCopy)return null;
 const sameQty=(a,b)=>Math.abs(a-b)<=qtyTolerance(b),candidates=[];
 for(let i=0;i<rows.length;i++){
  if(rows[i].at>firstAt+30000)break;
  if(rows[i].side!==opening||i>0&&rows[i-1].orderId===rows[i].orderId)continue;
  let size=0,initialSeen=false,lastSize=0;
  for(let j=i;j<rows.length;j++){
   const f=rows[j];size+=f.side===opening?f.qty:-f.qty;
   if(f.at<=firstAt+30000&&sameQty(size,p.firstSize))initialSeen=true;
   if(f.at<=lastAt)lastSize=size;
   if(size>qtyTolerance(p.size))continue;
   if(sameQty(size,0)&&initialSeen&&sameQty(lastSize,p.size)&&f.at>lastAt&&f.at<=p.closedAt+15000)candidates.push(rows.slice(i,j+1));
   break;
  }
 }
 return candidates.length===1?candidates[0]:null;
}

export class ManualLedger{
 /** client: read-only BingX income, fill and order queries. copyRecords(): the copy ledger's positions and closed
  * rows (read only, for the window check). */
 constructor({directory=null,fileName=MANUAL_LEDGER_FILE,client=null,copyRecords=()=>[],now=()=>Date.now(),log=()=>{},onEvent=()=>{},copyOrderAlerts=false,sendTelegram=null,
  feeRate=0.0005,openReads=2,closeReads=2,settleDelayMs=20000,settleDeadlineMs=5*60000,preMs=60000,postMs=120000,copyCloseGraceMs=30000}={}){
  Object.assign(this,{client,copyRecords,now,log,onEvent,copyOrderAlerts,sendTelegram,feeRate,openReads,closeReads,settleDelayMs,settleDeadlineMs,preMs,postMs,copyCloseGraceMs});
  this.file=directory?path.join(directory,fileName):null;
  const saved=this.file&&fs.existsSync(this.file)?readStore(this.file):null;
  this.store={origin:'manual',account:'BINGX_LIVE',positions:saved?.positions||{},closed:saved?.closed||[],events:saved?.events||[],claimed:saved?.claimed||[],
   pendingAlerts:Array.isArray(saved?.pendingAlerts)?saved.pendingAlerts:[],managedPositions:saved?.managedPositions??{},
   managedFast:Array.isArray(saved?.managedFast)?saved.managedFast:[],
   copyAlertsSince:saved?.copyAlertsSince??null,alertOrders:Array.isArray(saved?.alertOrders)?saved.alertOrders:[],
   telegramQueue:Array.isArray(saved?.telegramQueue)?saved.telegramQueue:[],telegramSent:saved?.telegramSent??0,telegramByOrigin:saved?.telegramByOrigin??{},
   telegramLastAt:saved?.telegramLastAt??null,telegramChatType:saved?.telegramChatType??null,telegramError:saved?.telegramError??null,
   telegramTransport:saved?.telegramTransport??null};
  if(Array.isArray(saved?.reductions))for(const note of saved.reductions)this.#queueAlert(note,note,note.fromAt);
  for(const row of this.store.closed){
   if(row.notifySettlement&&row.exitNote)this.#queueAlert(row,row.exitNote,row.exitNote.fromAt);
   delete row.notifySettlement;delete row.exitNote;
  }
  this.fillSides=new Map();this.copyAlertRetries=new Map();this.copyOrderTasks=new Map();this.delivery=null;this.alerting=null;
  this.historyAttempts=new Map();this.lastHistoryAt=null;
  this.lastPositionKeys=new Set();
  this.lastReadAt=0;this.started=false;this.candidates=new Map();this.settling=null;this.notices=[];
  this.lastFillSnapshot=null;this.fillWindows=[];this.scanningFills=null;this.lastFillScanAt=0;
 }
 #save(){
  if(this.file){
   this.store.closed=this.store.closed.slice(-MAX_CLOSED);this.store.events=this.store.events.slice(-MAX_EVENTS);this.store.claimed=this.store.claimed.slice(-MAX_CLAIMED);
   this.store.managedFast=this.store.managedFast.slice(-MAX_CLAIMED);this.store.alertOrders=this.store.alertOrders.slice(-MAX_CLAIMED);
   fs.mkdirSync(path.dirname(this.file),{recursive:true});atomicWriteStore(this.file,{version:1,...this.store});
  }
  for(const event of this.notices.splice(0))try{this.onEvent(event)}catch{this.log('[MANUAL] notice failed')}
 }
 #event(type,detail={},notify=false){
  if(notify&&detail.alertKey){
   if(this.store.alertOrders.includes(detail.alertKey))return null;
   this.store.alertOrders.push(detail.alertKey);
   if(this.store.events.some(e=>!e.alertKey&&e.fromFills&&e.alertOrigin===detail.alertOrigin&&e.symbol===detail.symbol&&e.direction===detail.direction&&e.type===type&&e.observedAt===detail.observedAt&&e.size===detail.size))return null;
  }
  const e={type,at:this.now(),...detail};this.store.events.push(e);if(notify)this.notices.push(e);
  if(notify&&this.sendTelegram)this.store.telegramQueue.push({event:e,nextAt:this.now()});
  this.log(`[MANUAL] ${type} ${detail.symbol||''}`.trim());return e;
 }
 #copyList(){try{const l=this.copyRecords();return Array.isArray(l)?l.filter(Boolean):[]}catch{return []}}

 /** One venue snapshot ({venuePositions, venuePositionsAt}, rows tagged copy / manual). A snapshot already seen (the
  * same read time, e.g. the cached list or a failed refresh) is ignored, so "2 reads" are 2 distinct venue reads. */
 observe(snap){
  const rows=Array.isArray(snap?.venuePositions)?snap.venuePositions:null,at=num(snap?.venuePositionsAt);
  if(!rows||!at||at<=this.lastReadAt)return false;
  let window=null;
  if(typeof this.client?.fillOrders==='function'){
   const symbols=new Set(rows.map(r=>r.venueSymbol)),prior=this.lastFillSnapshot;
   if(prior&&at-prior.at<=5*60000){window={from:prior.at,to:at,blocked:new Set([...prior.symbols,...symbols]),unchanged:[]};this.fillWindows.push(window)}
   this.lastFillSnapshot={at,symbols};
   this.fillWindows=this.fillWindows.slice(-240);
  }
  const priorAt=this.lastReadAt;this.lastReadAt=at;const first=!this.started;this.started=true;let changed=false;
  const byKey=new Map();for(const r of rows)if(r?.venueSymbol&&r.direction&&r.size>0)byKey.set(keyOf(r.venueSymbol,r.direction),r);
  const priorKeys=this.lastPositionKeys;this.lastPositionKeys=new Set(byKey.keys());
  const managed=this.#copyList(),owners=new Map();
  for(const p of managed){
   if(!ownerOf(p)||!['OPEN','SUBMITTING','UNKNOWN'].includes(p.status)||!p.venueSymbol||!p.direction)continue;
   const key=keyOf(p.venueSymbol,p.direction);
   owners.set(key,owners.has(key)?null:p);
  }
  if(window)for(const p of [...Object.values(this.store.positions),...Object.values(this.store.managedPositions)]){
   const key=keyOf(p.venueSymbol,p.direction),row=byKey.get(key);
   if(!row||!priorKeys.has(key)||p.mergedIntoCopy||Math.abs(row.size-p.size)>qtyTolerance(p.size))continue;
   if(owners.has(key)&&ownerOf(owners.get(key))!==ownerOf(p))continue;
   window.unchanged.push({...p,from:p.size,to:row.size,fromAt:window.from,observedAt:window.to});
  }
  changed=this.#observeManaged(byKey,owners,at,priorAt,priorKeys,first)||changed;
  for(const [key,p] of Object.entries(this.store.positions)){
   const row=byKey.get(key);
   if(!row){p.missing=(p.missing||0)+1;if(p.missing===1)p.goneAt=at;changed=true;
    if(p.missing>=this.closeReads)this.#close(p,p.goneAt);continue}
   if(p.missing){p.missing=0;delete p.goneAt;changed=true}
   const fromAt=p.lastSeenAt;p.lastSeenAt=at;
   if(row.origin==='copy'||owners.has(key)||this.store.managedPositions[key]){
    // The copy ledger entered the same symbol and side: the venue position is shared from here on.
    if(!p.mergedIntoCopy){p.mergedIntoCopy=at;this.#event('MANUAL_MERGED_INTO_COPY',{symbol:p.symbol,direction:p.direction,size:p.size});changed=true}
    continue;
   }
   if(p.mergedIntoCopy)continue; // frozen at the manual size until the venue position is gone
   changed=this.#track(p,row,at,fromAt)||changed;
  }
  for(const [key,row] of byKey){
   if(row.origin==='copy'||owners.has(key)||this.store.managedPositions[key]||this.store.positions[key]){this.candidates.delete(key);continue}
   // A copy position of the same symbol and side that was just closed: a cached list may still show it untagged.
   const justClosed=managed.some(c=>c.status==='CLOSED'&&c.venueSymbol===row.venueSymbol&&c.direction===row.direction&&num(c.closedAt)!=null&&c.closedAt>=at-this.copyCloseGraceMs);
   if(justClosed){this.candidates.delete(key);continue}
   if(first){this.#open(row,at,true);changed=true;continue}
   const c=this.candidates.get(key)||{seen:0,firstAt:at,fromAt:priorAt};c.seen++;this.candidates.set(key,c);
   if(c.seen>=this.openReads){
    this.candidates.delete(key);this.#open(row,c.firstAt,false);const p=this.store.positions[key];p.lastSeenAt=at;
    this.#queueAlert(p,{from:0,to:p.size,observedAt:at},c.fromAt);changed=true;
   }
  }
  for(const key of [...this.candidates.keys()])if(!byKey.has(key)||byKey.get(key).origin==='copy')this.candidates.delete(key);
  if(changed)this.#save();
  return changed;
 }
 #observeManaged(byKey,owners,at,priorAt,priorKeys,first){
  const positions=this.store.managedPositions;let changed=false;
  for(const [key,p] of Object.entries(positions)){
   const row=byKey.get(key),owner=owners.get(key);
   if(owners.has(key)&&(!owner||ownerOf(owner)!==ownerOf(p))){delete positions[key];changed=true;continue}
   if(!row){
    p.missing=(p.missing??0)+1;p.goneAt??=at;changed=true;
    if(p.missing>=this.closeReads){this.#queueAlert(p,{from:p.size,to:0,observedAt:p.goneAt},p.lastSeenAt);delete positions[key]}
    continue;
   }
   if(p.missing){delete p.missing;delete p.goneAt;changed=true}
   if(Math.abs(row.size-p.size)>qtyTolerance(p.size)){
    this.#queueAlert(p,{from:p.size,to:row.size,observedAt:at},p.lastSeenAt);p.size=row.size;changed=true;
   }
   p.lastSeenAt=at;
  }
  for(const [key,owner] of owners){
   const row=byKey.get(key);
   if(!owner||!row||positions[key])continue;
   const p={symbol:owner.symbol??row.symbol,venueSymbol:row.venueSymbol,direction:row.direction,hedge:owner.hedge===true||['LONG','SHORT'].includes(row.positionSide),
    leverage:row.leverage??owner.leverage,alertOrigin:owner.alertOrigin,alertOwnerId:owner.alertOwnerId,size:row.size,lastSeenAt:at};
   positions[key]=p;changed=true;
   if(!first&&!priorKeys.has(key)&&!this.store.positions[key])
    this.#queueAlert(p,{from:0,to:row.size,observedAt:at},priorAt);
  }
  return changed;
 }
 #open(row,at,adopted){
  const key=keyOf(row.venueSymbol,row.direction),price=num(row.avg)??num(row.mark)??0;
  const p={id:`${key}|${at}`,key,origin:'manual',symbol:row.symbol,venueSymbol:row.venueSymbol,direction:row.direction,hedge:row.positionSide==='LONG'||row.positionSide==='SHORT',
   status:'OPEN',openedAt:at,firstSeenAt:at,lastSeenAt:at,sizeSinceAt:at,size:row.size,qty:row.size,maxSize:row.size,firstSize:row.size,avg:num(row.avg),firstAvg:num(row.avg),
   leverage:num(row.leverage),marginMode:row.marginMode??null,mark:num(row.mark),unrealized:num(row.unrealized),adds:0,reduces:0,realizedEstUSD:0,tradedNotionalUSD:row.size*price,
   ...(adopted?{adoptedAtStart:true}:{})};
  this.store.positions[key]=p;this.#event(adopted?'MANUAL_ADOPTED':'MANUAL_OPEN',
   {symbol:p.symbol,direction:p.direction,size:p.size,avg:p.avg,leverage:p.leverage,observedAt:at});
 }
 #track(p,row,at,fromAt){
  const dir=p.direction==='LONG'?1:-1,mark=num(row.mark)??num(row.avg)??p.mark??p.avg??0,size=row.size,diff=size-p.size;
  let changed=false;
  if(Math.abs(diff)>Math.max(1e-12,p.size*1e-9)){
   const detail={symbol:p.symbol,direction:p.direction,leverage:p.leverage,from:p.size,to:size,avg:num(row.avg)??p.avg,observedAt:at};
   this.#queueAlert(p,detail,fromAt);
   if(diff>0){p.adds++;p.tradedNotionalUSD+=diff*mark;this.#event('MANUAL_ADD',detail)}
   else{
    p.reduces++;p.realizedEstUSD+=dir*(mark-(p.avg??mark))*(-diff);p.tradedNotionalUSD+=(-diff)*mark;
    this.#event('MANUAL_REDUCE',detail);
   }
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
   netUSD:null,netSource:'PENDING'};
  if(!p.mergedIntoCopy)this.#queueAlert(p,{from:p.size,to:0,observedAt:closedAt},p.lastSeenAt);
  delete row.missing;delete row.goneAt;
  this.store.closed.push(row);
  this.#event('MANUAL_CLOSE',{symbol:p.symbol,direction:p.direction,size:p.size,estimateUSD:row.estimateUSD});
 }
 #queueAlert(p,{from,to,observedAt},fromAt){
  if(!(fromAt>0&&observedAt>fromAt&&from>=0&&to>=0&&from!==to)||!p?.venueSymbol)return;
  this.store.pendingAlerts.push({symbol:p.symbol,venueSymbol:p.venueSymbol,direction:p.direction,hedge:p.hedge===true,
   leverage:p.leverage,alertOrigin:p.alertOrigin??'MANUAL',alertOwnerId:p.alertOwnerId,from,to,fromAt,observedAt,nextAt:observedAt+FILL_DELAY_MS});
 }
 #unmixedAlert(note){
  // A hedge lane can still be matched by direction when another owner trades the opposite lane.
  const owner=ownerOf(note);
  return !this.#copyList().some(p=>(!owner||ownerOf(p)!==owner)&&p.venueSymbol===note.venueSymbol&&(!note.hedge||!p.direction||p.direction===note.direction)&&
   (p.openedAt??p.createdAt??0)<=note.observedAt&&(p.closedAt??Infinity)>note.fromAt);
 }
 async #fillPositionSides(rows){
  const known=new Set(['LONG','SHORT','BOTH']),attempted=new Set();
  for(const f of rows){
   if(known.has(f.positionSide)||typeof this.client?.getOrder!=='function')continue;
   const key=`${f.symbol}|${f.orderId}`;
   if(!this.fillSides.has(key)&&!attempted.has(key))try{
    attempted.add(key);
    const res=await this.client.getOrder(f.symbol,{orderId:f.orderId}),o=res?.order??res,lane=String(o?.positionSide??'').toUpperCase();
    if(String(o?.orderId)===f.orderId&&o.symbol===f.symbol&&String(o.side).toUpperCase()===f.side&&known.has(lane))this.fillSides.set(key,lane);
   }catch{}
   if(this.fillSides.has(key))f.positionSide=this.fillSides.get(key);
  }
  while(this.fillSides.size>1000)this.fillSides.delete(this.fillSides.keys().next().value);
  return rows;
 }
 async #matchedAlert(note,fills){
  let rows=fills.filter(f=>f.symbol===note.venueSymbol&&f.at>note.fromAt&&f.at<=note.observedAt);
  if(note.hedge){
   rows=await this.#fillPositionSides(rows.map(f=>({...f})));
   if(rows.some(f=>!['LONG','SHORT'].includes(f.positionSide)))return null;
  }
  rows=rows.filter(f=>note.hedge?f.positionSide===note.direction:!f.positionSide||['BOTH',note.direction].includes(f.positionSide));
  const opening=note.direction==='SHORT'?'SELL':'BUY',tolerance=qtyTolerance(Math.max(note.from,note.to));
  let balance=note.from;
  for(const f of rows){
   if(f.side!==opening&&(f.pnl===null||f.fee===null))return null;
   balance+=f.side===opening?f.qty:-f.qty;
   if(balance < -tolerance)return null;
   if(Math.abs(balance)<=tolerance)balance=0;
  }
  if(!rows.length||Math.abs(balance-note.to)>tolerance||!completeBingxOrders(rows)||!this.#unmixedAlert(note))return null;
  return fillActions(rows,{...note,initialSize:note.from});
 }
 async #settleAlerts(now){
  const ready=this.store.pendingAlerts.filter(p=>now>=p.nextAt).sort((a,b)=>a.nextAt-b.nextAt),first=ready[0];
  if(!first)return false;
  const notes=ready.filter(p=>Math.abs(p.observedAt-first.observedAt)<=60000).slice(0,12);
  let bulk=[];
  if(typeof this.client?.fillOrders==='function'&&notes.some(p=>this.#unmixedAlert(p)))try{
   const startTs=Math.min(...notes.map(p=>p.fromAt)),endTs=Math.max(...notes.map(p=>p.observedAt));
   bulk=await confirmedBingxFills(this.client,await this.client.fillOrders({startTs,endTs}));
  }catch(e){this.log(`[MANUAL] alert receipts ${e?.code||e?.message||'FAILED'}`)}
  const done=new Set();
  const confirmed=[];
  for(const note of notes){
   let matched=null;
   if(this.#unmixedAlert(note)){
    matched=await this.#matchedAlert(note,bulk);
    if(!matched&&typeof this.client?.fillHistory==='function')try{
     const receipts=await this.client.fillHistory({symbol:note.venueSymbol,startTs:note.fromAt,endTs:note.observedAt});
     matched=await this.#matchedAlert(note,await confirmedBingxFills(this.client,receipts,{symbol:note.venueSymbol}));
    }catch(e){this.log(`[MANUAL] symbol receipts ${e?.code||e?.message||'FAILED'}`)}
   }
   if(matched){done.add(note);confirmed.push(...matched)}
   else{note.attempts=(note.attempts??0)+1;note.nextAt=now+Math.min(3600000,3000*2**Math.min(10,note.attempts-1))}
  }
  for(const e of confirmed.sort((a,b)=>a.detail.observedAt-b.detail.observedAt))this.#event(e.type,e.detail,true);
  if(done.size)this.store.pendingAlerts=this.store.pendingAlerts.filter(note=>!done.has(note));
  return true;
 }
 async #settleCopyAlerts(now){
  if(!this.copyOrderAlerts||typeof this.client?.getOrder!=='function')return false;
  const start=this.store.copyAlertsSince??(now-30*60000);
  let changed=this.store.copyAlertsSince==null;this.store.copyAlertsSince=start;
  const candidates=[];
  for(const p of this.#copyList()){
   if(p.alertOrigin!=='COPY'||!p.venueSymbol||!p.direction)continue;
   const side=p.direction==='LONG'?'BUY':'SELL',openingOrders=(p.fillOrders??[]).filter(o=>o.side===side);
   const openingSteps=(p.steps??[]).filter(s=>s.kind==='OPEN'||s.kind==='ADD');
   for(const o of p.fillOrders??[]){
    if(!o.id)continue;
    const stage=o.notice??(o.side===side&&openingOrders.length===openingSteps.length&&openingSteps[0]?.kind==='OPEN'?openingSteps[openingOrders.indexOf(o)]:null);
    if(!(stage?.at>0)||stage.at<start||stage.at>now||o.side!==side&&!(stage.from>0))continue;
    const key=alertOrderKey(p.venueSymbol,o.id);
    if(this.copyOrderTasks.has(String(o.id))||this.store.alertOrders.includes(key)||(this.copyAlertRetries.get(key)??0)>now)continue;
    candidates.push({p,o,stage,key});
   }
  }
  for(const candidate of candidates.sort((a,b)=>a.stage.at-b.stage.at).slice(0,6)){
   const {key}=candidate;
   try{
    const e=await this.#copyAlert(candidate,now);
    if(e){this.#event(e.type,e.detail,true);this.copyAlertRetries.delete(key);changed=true;continue}
   }catch(e){this.log(`[MANUAL] copy order receipt ${e?.code||'LOOKUP_FAILED'}`)}
   this.copyAlertRetries.set(key,now+60000);
  }
  while(this.copyAlertRetries.size>MAX_CLAIMED)this.copyAlertRetries.delete(this.copyAlertRetries.keys().next().value);
  return changed;
 }
 async #copyAlert({p,o,stage,key},now){
  const symbol=p.venueSymbol,orderId=String(o.id);
  const opening=o.side===(p.direction==='SHORT'?'SELL':'BUY'),receipt=stage.receipt;
  const complete=receipt?.updateTime&&(opening||num(receipt.profit)!==null&&num(receipt.commission)!==null);
  const response=complete?receipt:await this.client.getOrder(symbol,{orderId}),order=response?.order??response;
  if(String(order?.orderId??order?.orderID)!==orderId||order?.symbol!==symbol||String(order?.side).toUpperCase()!==o.side)return null;
  if(!['FILLED','CANCELED','CANCELLED','EXPIRED'].includes(String(order.status).toUpperCase()))return null;
  const size=num(order.executedQty),avg=num(order.avgPrice);
  if(!(size>0)||!(avg>0))return null;
  const lane=String(order.positionSide??'').toUpperCase();
  if(p.hedge===true&&lane&&lane!==p.direction)return null;
  let observedAt=num(order.updateTime??order.updatedTime??order.filledTm),pnl=num(order.realizedPnl??order.realizedPnL??order.profit),fee=num(order.fee??order.commission);
  if(!(observedAt>0)||!opening&&(pnl===null||fee===null)){
   if(typeof this.client.fillOrders!=='function'&&typeof this.client.fillHistory!=='function')return null;
   const window={startTs:Math.max(1,stage.at-180000),endTs:Math.min(now,stage.at+300000)};
   const confirm=async raw=>{const fills=await confirmedBingxFills(this.client,raw,{symbol,orders:new Map([[orderId,{order,side:o.side}]])});
    return fills.length&&Math.abs(fills.reduce((total,f)=>total+f.qty,0)-size)<=qtyTolerance(size)&&
     (opening||fills.every(f=>f.pnl!==null&&f.fee!==null))?fills:null};
   let fills=null;
   try{if(typeof this.client.fillOrders==='function')fills=await confirm(await this.client.fillOrders({...window,orderId}))}catch{}
   if(!fills&&typeof this.client.fillHistory==='function')fills=await confirm(await this.client.fillHistory({symbol,...window}));
   if(!fills)return null;
   observedAt=fills.at(-1).at;
   if(!opening){if(fills.some(f=>f.pnl===null||f.fee===null))return null;pnl=fills.reduce((sum,f)=>sum+f.pnl,0);fee=fills.reduce((sum,f)=>sum+f.fee,0)}
  }
  if(!(observedAt>0))return null;
  if(observedAt>=1e9&&observedAt<1e11)observedAt*=1000;
  if(observedAt>now+10000)return null;
  const detail={symbol:p.symbol??symbol.replace(/-/g,''),direction:p.direction,leverage:p.leverage,alertOrigin:'COPY',fromFills:true,alertKey:key,observedAt,size};
  const from=num(stage.from);
  if(opening){
   const entry=/^open(?:\.|$)/.test(stage.tag??'')||stage.kind==='OPEN';
   return {type:entry?'MANUAL_OPEN':'MANUAL_ADD',detail:{...detail,avg,from,to:from!==null?from+size:null}};
  }
  if(!(from>0)||size-from>qtyTolerance(from))return null;
  const to=from-size<=qtyTolerance(from)?0:from-size;
  return {type:to===0?'MANUAL_SETTLED':'MANUAL_REDUCE',detail:{...detail,from,to,netSource:'EXCHANGE_FILLS',netUSD:Number((pnl+fee).toFixed(12))}};
 }
 confirmCopyOrder(orderId){
  if(!this.copyOrderAlerts||!orderId)return Promise.resolve();
  const existing=this.copyOrderTasks.get(orderId);if(existing)return existing;
  const p=this.#copyList().find(x=>x.alertOrigin==='COPY'&&x.fillOrders?.some(o=>o.id===orderId));
  const o=p?.fillOrders.find(o=>o.id===orderId),stage=o?.notice;
  if(!stage?.tag)return Promise.resolve();
  const key=alertOrderKey(p.venueSymbol,orderId);
  const run=(async()=>{
   for(const delay of [0,750,1500]){
    if(delay)await new Promise(resolve=>setTimeout(resolve,delay));
    if(this.store.alertOrders.includes(key))return;
    let event;
    try{event=await this.#copyAlert({p,o,stage,key},this.now())}catch{}
    if(!event)continue;
    this.#event(event.type,event.detail,true);this.#save();void this.deliverAlerts();return;
   }
  })().catch(()=>this.log('[MANUAL] copy order receipt failed')).finally(()=>this.copyOrderTasks.delete(orderId));
  this.copyOrderTasks.set(orderId,run);return run;
 }
 settleNotifications(){
  if(!this.alerting)this.alerting=this.#settleAlerts(this.now()).then(changed=>{
   if(changed)this.#save();void this.deliverAlerts();
  }).catch(()=>this.log('[MANUAL] alert receipts failed')).finally(()=>{this.alerting=null});
  return this.alerting;
 }
 deliverAlerts(){
  if(!this.sendTelegram||!this.store.telegramQueue.length)return Promise.resolve();
  if(!this.delivery)this.delivery=this.#deliverAlerts().catch(()=>this.log('[MANUAL] Telegram queue failed')).finally(()=>{this.delivery=null});
  return this.delivery;
 }
 async #deliverAlerts(){
  for(const item of this.store.telegramQueue.filter(x=>x.nextAt<=this.now()).slice(0,6)){
   let outcome;
   try{outcome=await this.sendTelegram(item.event)}catch{outcome={error:'TRANSPORT_FAILED'}}
   if(outcome?.transport)this.store.telegramTransport=outcome.transport;
   if(outcome?.paused){this.store.telegramError=outcome.error;this.#save();return}
   if(outcome?.ok){
    this.store.telegramQueue=this.store.telegramQueue.filter(x=>x!==item);this.store.telegramSent++;
    const origin=item.event.alertOrigin??'MANUAL';this.store.telegramByOrigin[origin]=(this.store.telegramByOrigin[origin]??0)+1;
    this.store.telegramLastAt=this.now();this.store.telegramChatType=['channel','supergroup','group','private'].includes(outcome.chatType)?outcome.chatType:null;this.store.telegramError=null;
   }else{
    item.attempts=(item.attempts??0)+1;
    item.nextAt=this.now()+Math.max(outcome?.retryMs??0,Math.min(15*60000,15000*2**Math.min(item.attempts-1,6)));
    this.store.telegramError=outcome?.error??'DELIVERY_UNCONFIRMED';
   }
   this.#save();
   if(outcome?.retryMs>0)return;
  }
 }
 /** Recover trades opened and closed entirely between successful position reads. */
 recoverFastTrades(){
  if(typeof this.client?.fillOrders!=='function')return Promise.resolve();
  if(this.scanningFills)return this.scanningFills;
  const now=this.now();
  if(now-this.lastFillScanAt<6000)return Promise.resolve();
  const ready=this.fillWindows.filter(w=>w.to<=now-FILL_DELAY_MS);
  if(!ready.length)return Promise.resolve();
  const first=ready[0],windows=ready.filter(w=>w.from<first.from+5*60000);
  this.lastFillScanAt=now;
  this.scanningFills=this.#recoverWindows(windows,now).catch(e=>this.log(`[MANUAL] fill history ${e?.code||e?.message||'FAILED'}`)).finally(()=>{this.scanningFills=null});
  return this.scanningFills;
 }
 async #recoverWindows(windows,now){
  const startTs=windows[0].from,endTs=windows.at(-1).to;
  let fills;
  try{fills=await confirmedBingxFills(this.client,await this.client.fillOrders({startTs,endTs}))}
  catch(error){
   if(typeof this.client.allOrders!=='function'||typeof this.client.fillHistory!=='function')throw error;
   const data=await this.client.allOrders({startTime:startTs,endTime:endTs,limit:1000});
   const orders=data?.orders??data?.list??data;
   if(!Array.isArray(orders))throw error;
   const symbols=[...new Set(orders.map(o=>o?.symbol).filter(Boolean))].slice(0,12);fills=[];
   for(const symbol of symbols)try{fills.push(...await confirmedBingxFills(this.client,await this.client.fillHistory({symbol,startTs,endTs}),{symbol}))}catch{}
   fills.sort((a,b)=>a.at-b.at||a.tradeId.length-b.tradeId.length||a.tradeId.localeCompare(b.tradeId));
  }
  const ambiguous=fills.some(f=>!['LONG','SHORT','BOTH'].includes(f.positionSide));
  const mode=ambiguous&&typeof this.client.positionMode==='function'?await readPositionMode(this.client):null;
  const oneWay=mode?.ok&&mode.hedge===false,managed=this.#copyList();
  if(ambiguous&&!oneWay){
   fills=fills.filter(f=>windows.some(w=>w.from<f.at&&f.at<=w.to&&(!w.blocked.has(f.symbol)||w.unchanged.some(p=>p.venueSymbol===f.symbol))));
   await this.#fillPositionSides(fills);
  }
  let changed=false;
  for(const w of windows){
   for(const note of w.unchanged??[]){
    if(!this.#unmixedAlert(note))continue;
    const events=await this.#matchedAlert(note,fills);
    if(events){for(const event of events)this.#event(event.type,event.detail,true);changed=true}
   }
   const groups=new Map();
   for(const f of fills){
    if(f.at<=w.from||f.at>=w.to||w.blocked.has(f.symbol))continue;
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
     const owners=managed.filter(p=>p.venueSymbol===venueSymbol&&(!p.direction||p.direction===direction)&&
      (p.openedAt??p.createdAt??0)<=closedAt&&(p.closedAt??Infinity)>=openedAt);
     const owner=owners[0];
     const symbol=owner?.symbol??venueSymbol.replace(/-/g,'');
     if(owners.length){
      const entryId=laneFills[0].orderId,known=owner.entryOrderId!=null&&String(owner.entryOrderId)===entryId||
       owner.fillOrders?.some(o=>String(o.id)===entryId&&o.side===laneFills[0].side);
      if(owners.length!==1||!ownerOf(owner)||!known||this.store.managedFast.includes(tradeId))continue;
      this.store.managedFast.push(tradeId);
      for(const event of fillActions(laneFills,{symbol,direction,leverage:owner.leverage,alertOrigin:owner.alertOrigin}))this.#event(event.type,event.detail,true);
      changed=true;continue;
     }
     this.store.closed.push({id:tradeId,origin:'manual',status:'CLOSED',symbol,venueSymbol,direction,openedAt,closedAt,
      size:result.qty,qty:result.qty,avg:result.avg,pnlUSD:result.pnlUSD,feeUSD:result.feeUSD,netUSD:result.netUSD,
      netSource:'EXCHANGE_FILLS',settledAt:now,closeReason:'MISSED_SNAPSHOT_ROUND_TRIP'});
     for(const event of fillActions(laneFills,{symbol,direction}))this.#event(event.type,event.detail,true);
     changed=true;
    }
   }
  }
  if(changed){this.store.closed.sort((a,b)=>a.closedAt-b.closedAt);this.#save();void this.deliverAlerts()}
  const done=new Set(windows);this.fillWindows=this.fillWindows.filter(w=>!done.has(w));
 }

 /** Settles closed records still PENDING (oldest first). One run at a time; never throws. */
 settle({historyLimit=1,recheck=false}={}){
  if(this.settling)return this.settling;
  if(recheck){this.historyAttempts.clear();this.lastHistoryAt=null}
  this.settling=this.#settleAll(historyLimit).catch(e=>{this.log(`[MANUAL] settle ${e?.code||e?.message||e}`)}).finally(()=>{this.settling=null});
  return this.settling;
 }
 async #settleAll(historyLimit){
  const now=this.now(),todo=this.store.closed.filter(x=>x.netSource==='PENDING'&&now>=x.closedAt+this.settleDelayMs).sort((a,b)=>a.closedAt-b.closedAt);
  await this.settleNotifications();
  if(await this.#settleCopyAlerts(now))this.#save();
  void this.deliverAlerts();
  let changed=false;
  for(const x of todo){if(await this.#settleOne(x,now))changed=true}
  if(await this.#settleHistory(now,historyLimit))changed=true;
  if(changed)this.#save();
  void this.deliverAlerts();
 }
 async #settleHistory(now,limit){
  if(typeof this.client?.fillOrders!=='function'&&typeof this.client?.fillHistory!=='function')return false;
  if(this.lastHistoryAt!=null&&now-this.lastHistoryAt<15000)return false;
  const due=this.store.closed.filter(p=>!['EXCHANGE','EXCHANGE_FILLS','PENDING'].includes(p.netSource)&&p.openedAt>0&&p.closedAt>=p.openedAt);
  const ids=new Set(due.map(p=>p.id));for(const id of this.historyAttempts.keys())if(!ids.has(id))this.historyAttempts.delete(id);
  const batch=due.filter(p=>!this.historyAttempts.has(p.id)||now-this.historyAttempts.get(p.id)>=5*60000)
   .sort((a,b)=>(this.historyAttempts.get(a.id)??0)-(this.historyAttempts.get(b.id)??0)||b.closedAt-a.closedAt).slice(0,limit);
  if(!batch.length)return false;
  this.lastHistoryAt=now;
  const claimed=new Set(this.store.closed.flatMap(p=>p.historyFillKeys??[]));
  for(const p of batch){
   this.historyAttempts.set(p.id,now);
   const mark=(state,error=null)=>{p.settlement={state,checkedAt:this.now(),...(error?{error}:{})}};
   const startTs=Math.max(1,p.openedAt-this.preMs),endTs=Math.min(now,p.closedAt+15000);
   const overlapping=(a,b)=>a.venueSymbol===p.venueSymbol&&(!p.hedge||!a.direction||a.direction===p.direction)&&
    (a.openedAt??a.createdAt??0)<=endTs&&(a.closedAt??Infinity)>=startTs&&a!==b;
   if(p.mergedIntoCopy||this.#copyList().some(c=>overlapping(c,p))){mark('MIXED_WITH_COPY');continue}
   if(p.adoptedAtStart){mark('ENTRY_HISTORY_UNVERIFIED');continue}
   try{
    let fills=null;
    if(typeof this.client.fillHistory==='function')try{fills=await confirmedBingxFills(this.client,await this.client.fillHistory({symbol:p.venueSymbol,startTs,endTs}),{symbol:p.venueSymbol})}catch(e){if(typeof this.client.fillOrders!=='function')throw e}
    if(!fills?.length&&typeof this.client.fillOrders==='function')fills=await confirmedBingxFills(this.client,await this.client.fillOrders({startTs,endTs}));
    let rows=(fills??[]).filter(f=>f.symbol===p.venueSymbol&&f.at>=startTs&&f.at<=endTs);
    if(p.hedge){await this.#fillPositionSides(rows);if(rows.some(f=>!['LONG','SHORT'].includes(f.positionSide))){mark('POSITION_SIDE_UNVERIFIED');continue}}
    rows=rows.filter(f=>p.hedge?f.positionSide===p.direction:!f.positionSide||f.positionSide==='BOTH'||f.positionSide===p.direction);
    if(!rows.length){mark('FILL_PENDING');continue}
    const cycle=historicalManualCycle(rows,p),result=cycle&&summarizeBalancedFills(cycle,p.direction);
    const keys=cycle?.map(f=>`${f.symbol}|${f.tradeId}`)??[];
    const overlapsTrade=cycle&&[...this.store.closed,...Object.values(this.store.positions)].some(q=>q!==p&&q.venueSymbol===p.venueSymbol&&q.direction===p.direction&&
     q.openedAt<cycle.at(-1).at&&(q.closedAt??Infinity)>cycle[0].at);
    if(!result||overlapsTrade||keys.some(key=>claimed.has(key))||!this.store.closed.includes(p)){mark('TRADE_LINK_UNVERIFIED');continue}
    Object.assign(p,{netSource:'EXCHANGE_FILLS',pnlUSD:result.pnlUSD,feeUSD:result.feeUSD,netUSD:result.netUSD,settledAt:now,historyFillKeys:keys});
    for(const key of keys)claimed.add(key);
    mark('CONFIRMED');this.#event('MANUAL_HISTORY_SETTLED',{symbol:p.symbol,direction:p.direction});
   }catch(e){const code=e?.code??e?.message??'';mark('LOOKUP_FAILED',/^[A-Z_0-9]{1,48}$/.test(code)?code:null)}
  }
  return true;
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
   this.#event('MANUAL_SETTLED',{symbol:x.symbol,direction:x.direction,size:x.size,netSource,netUSD:x.netUSD,observedAt:x.closedAt});
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

 alertStatus(){
  const confirmed=this.store.events.filter(e=>e.fromFills===true),byOrigin={};
  for(const e of confirmed){const key=e.alertOrigin??'MANUAL';byOrigin[key]=(byOrigin[key]??0)+1}
  return {pending:this.store.pendingAlerts.length,confirmedRecent:confirmed.length,byOrigin};
 }
 telegramStatus(){return {pending:this.store.telegramQueue.length,sent:this.store.telegramSent,byOrigin:{...this.store.telegramByOrigin},lastAt:this.store.telegramLastAt,
  chatType:this.store.telegramChatType,error:this.store.telegramError,transport:this.store.telegramTransport}}
 /** For the page: open records, the last 200 closes (newest first, origin manual) and totals of the settled ones. */
 status(){
  const pub=x=>{const {claimed,missing,goneAt,notifySettlement,exitNote,historyFillKeys,...rest}=x;return {...rest,origin:'manual'}};
  const closed=this.store.closed,settled=closed.filter(x=>x.netUSD!=null&&Number.isFinite(Number(x.netUSD)));
  return {open:Object.values(this.store.positions).map(pub),closed:closed.slice(-200).reverse().map(pub),closedTotal:closed.length,
   pending:closed.filter(x=>x.netSource==='PENDING').length,settled:settled.length,netUSD:r6(settled.reduce((a,x)=>a+Number(x.netUSD),0))};
 }
}
