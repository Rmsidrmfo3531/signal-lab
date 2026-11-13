// Copy trading of the followed Telegram channel on the BingX TESTNET (user 2026-11-13: "모두 그대로
// 따라가보고 대신 증거금은 1달러부터 시작하기"). Its own ledger (copy-store.json), never real money.
//
//  진입 (OPEN)      -> a market entry with COPY_MARGIN_USD (1 $) of margin at the trader's leverage (capped
//                      at the venue's maximum); the trader's quantity is not copied, only the direction.
//  변경 (CHANGE)    -> the same proportion: 200 -> 400 doubles our position, 400 -> 100 closes 3/4 of it.
//  청산 (CLOSE)     -> everything closed at market.
//  모니터 시작       -> the monitor restarted: the 진입 cards within COPY_SNAPSHOT_MS re-announce positions
//                      it already had; they are not entered (no late entries).
// Safety kept (user's standing rules: stop protection, reduce-only exits, duplicate-order guard,
// kill switch): every copied position carries a whole-position stop at the price where its loss would
// reach COPY_MAX_LOSS_PCT of the balance (default 25 %), re-set after each change; an add that the
// free margin cannot carry is skipped; a symbol held by the signal strategy is not copied (one-way mode
// would merge the two positions); nothing is sent while the live executor is disarmed or stopped.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {atomicWriteStore,readStore} from './persistence.mjs';
import {roundDecimalToStep} from './decimal_grid.mjs';
import {parseCopyMessage} from './copy_parser.mjs';

export const COPY_DEFAULTS=Object.freeze({marginUSD:1,maxLossPct:25,snapshotMs:120000,maxLeverage:125});
const MAX_CLOSED=300,MAX_EVENTS=200,MAX_SEEN=1000;
const num=v=>{const n=Number(v);return Number.isFinite(n)?n:null};
const pos=v=>{const n=Number(v);return Number.isFinite(n)&&n>0?n:null};
const orderOf=d=>d?.order??d;
const venueSymbolOf=s=>s.replace(/USDT$/,'-USDT');

export function copyConfig(env=process.env,liveMode='OFF'){
 const n=(k,d,lo,hi)=>{const v=Number(env[k]);return Number.isFinite(v)&&v>=lo&&v<=hi?v:d};
 // TESTNET only. COPY_TRADING=off turns it off.
 const enabled=String(env.COPY_TRADING||'').toLowerCase()!=='off'&&liveMode==='TESTNET';
 return {enabled,marginUSD:n('COPY_MARGIN_USD',COPY_DEFAULTS.marginUSD,.1,1000),maxLossPct:n('COPY_MAX_LOSS_PCT',COPY_DEFAULTS.maxLossPct,1,90),
  snapshotMs:n('COPY_SNAPSHOT_MS',COPY_DEFAULTS.snapshotMs,0,3600000),maxLeverage:n('COPY_MAX_LEVERAGE',COPY_DEFAULTS.maxLeverage,1,125)};
}

export class CopyExecutor{
 constructor({config,client,contractOf,gate=()=>({ok:true}),isBusy=()=>false,balance=async()=>null,directory=null,now=()=>Date.now(),log=()=>{},onEvent=()=>{}}){
  Object.assign(this,{config,client,contractOf,gate,isBusy,balance,now,log,onEvent});
  this.file=directory?path.join(directory,'copy-store.json'):null;
  const saved=this.file&&fs.existsSync(this.file)?readStore(this.file):null;
  this.store={positions:saved?.positions||{},closed:saved?.closed||[],events:saved?.events||[],seen:saved?.seen||[],monitorStartAt:saved?.monitorStartAt||0,leverageOf:saved?.leverageOf||{}};
  this.queue=Promise.resolve();
 }
 #save(){if(!this.file)return;this.store.closed=this.store.closed.slice(-MAX_CLOSED);this.store.events=this.store.events.slice(-MAX_EVENTS);this.store.seen=this.store.seen.slice(-MAX_SEEN);
  fs.mkdirSync(path.dirname(this.file),{recursive:true});atomicWriteStore(this.file,{version:1,...this.store})}
 #event(type,detail={}){const e={type,at:this.now(),...detail};this.store.events.push(e);this.log(`[COPY] ${type} ${detail.symbol||''} ${detail.reason||''}`.trim());try{this.onEvent(e)}catch{}return e}
 /** Symbols the copy ledger holds (the signal strategy skips them). */
 heldSymbols(){return new Set(Object.values(this.store.positions).filter(p=>p.status==='OPEN').map(p=>p.symbol))}
 status(){return {enabled:this.config.enabled,marginUSD:this.config.marginUSD,maxLossPct:this.config.maxLossPct,positions:Object.values(this.store.positions),
  closed:this.store.closed.slice(-50).reverse(),events:this.store.events.slice(-30).reverse(),monitorStartAt:this.store.monitorStartAt||null}}

 /** One channel message ({id, date (ms), text}); processed one at a time, each id once. */
 handle(message){const p=this.queue.then(()=>this.#handle(message));this.queue=p.catch(()=>{});return p}
 async #handle({id,date,text}){
  const key=String(id??createHash('sha1').update(String(text)).digest('hex'));
  if(this.store.seen.includes(key))return {ok:true,duplicate:true};
  this.store.seen.push(key);
  const m=parseCopyMessage(text);
  if(!m){this.#save();return {ok:true,ignored:true}}
  const at=num(date)??this.now();
  if(m.kind==='MONITOR_START'){this.store.monitorStartAt=at;this.#event('MONITOR_START');this.#save();return {ok:true}}
  if(!this.config.enabled){this.#event('SKIPPED',{symbol:m.symbol,reason:'COPY_OFF'});this.#save();return {ok:false,reason:'COPY_OFF'}}
  try{
   const r=m.kind==='OPEN'?await this.#open(m,at):m.kind==='CHANGE'?await this.#change(m,at):await this.#close(m,'TRADER_CLOSE');
   this.#save();return r;
  }catch(error){this.#event('ERROR',{symbol:m.symbol,kind:m.kind,reason:error.code||error.message});this.#save();return {ok:false,reason:error.code||error.message}}
 }
 #key(m){return `${m.symbol}|${m.direction}`}
 async #contract(symbol){const c=await this.contractOf(symbol);if(!c||c.tradable===false)throw Object.assign(Error('NO_BINGX_CONTRACT'),{code:'NO_BINGX_CONTRACT'});return c}
 #qty(c,raw,mode='DOWN'){try{return Number(roundDecimalToStep(raw,c.quantityStep,mode))}catch{return 0}}
 async #position(p){const list=await this.client.positions(p.venueSymbol),row=(Array.isArray(list)?list:[]).find(x=>x.symbol===p.venueSymbol);
  return {size:row?Math.abs(Number(row.positionAmt)||0):0,avg:pos(row?.avgPrice),mark:pos(row?.markPrice),unrealized:row?num(row.unrealizedProfit):null}}
 async #market(p,side,quantity,{reduceOnly=false,tag}){
  const params={symbol:p.venueSymbol,side,positionSide:'BOTH',type:'MARKET',quantity:String(quantity),clientOrderId:('cp'+createHash('sha256').update(p.id+'|'+tag).digest('hex')).slice(0,32)};
  if(reduceOnly)params.reduceOnly='true';
  const res=orderOf(await this.client.placeOrder(params));return {orderId:res?.orderId??null,avg:pos(res?.avgPrice)};
 }
 // Whole-position stop where the loss would reach maxLossPct of the balance; re-set after each change.
 async #protect(p){
  if(p.stopOrderId){try{await this.client.cancelOrder(p.venueSymbol,p.stopOrderId)}catch{}p.stopOrderId=null}
  const now=await this.#position(p);p.qty=now.size;if(now.avg)p.avg=now.avg;
  if(!(p.qty>0))return;
  const bal=await this.balance().catch(()=>null),equity=pos(bal?.equity);if(!equity||!p.avg){this.#event('STOP_NOT_SET',{symbol:p.symbol,reason:'NO_BALANCE'});return}
  const dir=p.direction==='LONG'?1:-1,raw=p.avg-dir*(equity*this.config.maxLossPct/100)/p.qty;
  if(!(raw>0)){p.stop=null;return} // a long whose stop would sit below zero: the loss cannot reach the cap
  let stop;try{stop=Number(roundDecimalToStep(raw,p.tickSize,dir===1?'DOWN':'UP'))}catch{stop=raw}
  const res=orderOf(await this.client.placeOrder({symbol:p.venueSymbol,side:dir===1?'SELL':'BUY',positionSide:'BOTH',type:'STOP_MARKET',stopPrice:String(stop),closePosition:'true',workingType:'MARK_PRICE'}));
  p.stop=stop;p.stopOrderId=res?.orderId??null;
 }
 async #open(m,at){
  const key=this.#key(m),prev=this.store.positions[key];
  if(prev?.status==='OPEN')return {ok:true,already:true};
  if(this.store.monitorStartAt&&at-this.store.monitorStartAt<this.config.snapshotMs){this.#event('SKIPPED',{symbol:m.symbol,reason:'MONITOR_RESTART_SNAPSHOT'});return {ok:false,reason:'SNAPSHOT'}}
  const g=this.gate();if(!g.ok){this.#event('SKIPPED',{symbol:m.symbol,reason:g.reason});return {ok:false,reason:g.reason}}
  if(this.isBusy(m.symbol)){this.#event('SKIPPED',{symbol:m.symbol,reason:'SYMBOL_HELD_BY_SIGNAL_STRATEGY'});return {ok:false,reason:'SYMBOL_BUSY'}}
  if(Object.values(this.store.positions).some(p=>p.status==='OPEN'&&p.symbol===m.symbol)){this.#event('SKIPPED',{symbol:m.symbol,reason:'OPPOSITE_COPY_OPEN'});return {ok:false,reason:'SYMBOL_BUSY'}}
  const c=await this.#contract(m.symbol),venueSymbol=c.venueSymbol||venueSymbolOf(m.symbol);
  // A '- → q' change has no leverage: the last one seen for the symbol (else 10).
  if(m.leverage)this.store.leverageOf[m.symbol]=m.leverage;
  let leverage=Math.max(1,Math.min(Math.round(m.leverage||this.store.leverageOf[m.symbol]||10),this.config.maxLeverage));
  try{const info=await this.client.leverage(venueSymbol),maxL=Number(info?.maxLongLeverage??info?.maxLeverage);if(maxL>0)leverage=Math.min(leverage,maxL)}catch{}
  try{await this.client.setMarginType(venueSymbol,'CROSSED')}catch{}
  await this.client.setLeverage(venueSymbol,'BOTH',leverage);
  const price=pos(m.price)??pos(m.entry);
  let qty=this.#qty(c,this.config.marginUSD*leverage/price);
  const minQ=pos(c.minQuantityBase)??0,minN=pos(c.minNotionalUSDT)??0;
  // Below the venue minimum: the smallest valid order (margin a little above the 1 $ start).
  if(qty<minQ||qty*price<minN)qty=this.#qty(c,Math.max(minQ,minN/price*1.02),'UP');
  if(!(qty>0))throw Object.assign(Error('QUANTITY_INVALID'),{code:'QUANTITY_INVALID'});
  const p={id:`${key}|${at}`,symbol:m.symbol,venueSymbol,direction:m.direction,leverage,tickSize:c.tickSize,status:'OPEN',openedAt:this.now(),
   theirEntry:m.entry,theirQty:m.quantity??null,theirMarginUSD:m.marginUSD??null,qty:0,avg:null,adds:0,reduces:0,stop:null,stopOrderId:null,steps:[]};
  this.store.positions[key]=p;
  const fill=await this.#market(p,m.direction==='LONG'?'BUY':'SELL',qty,{tag:'open'});
  p.steps.push({kind:'OPEN',at:this.now(),qty,avg:fill.avg});
  await this.#protect(p);
  this.#event('OPENED',{symbol:m.symbol,direction:m.direction,leverage,qty:p.qty,avg:p.avg,stop:p.stop});
  return {ok:true};
 }
 async #change(m,at){
  const key=this.#key(m),p=this.store.positions[key];
  if(m.to===0)return this.#close(m,'TRADER_CLOSE');
  if(m.from===0&&(!p||p.status!=='OPEN'))return this.#open({...m,kind:'OPEN',entry:m.price,leverage:m.leverage},at);
  if(!p||p.status!=='OPEN'){this.#event('SKIPPED',{symbol:m.symbol,reason:'NOT_COPIED'});return {ok:false,reason:'NOT_COPIED'}}
  const c=await this.#contract(m.symbol),ratio=m.to/m.from,now=await this.#position(p);p.qty=now.size;
  if(!(p.qty>0)){p.status='CLOSED';this.#closed(p,'POSITION_GONE',now);return {ok:false,reason:'POSITION_GONE'}}
  if(ratio>1){
   const g=this.gate();if(!g.ok){this.#event('SKIPPED',{symbol:m.symbol,reason:g.reason});return {ok:false,reason:g.reason}}
   const add=this.#qty(c,p.qty*(ratio-1)),price=pos(m.price)??now.mark;
   if(!(add>0))return {ok:true,tooSmall:true};
   const bal=await this.balance().catch(()=>null),free=num(bal?.available);
   if(free!==null&&add*price/p.leverage>free*.9){this.#event('ADD_SKIPPED',{symbol:m.symbol,reason:'MARGIN_SHORT',need:+(add*price/p.leverage).toFixed(2),free});return {ok:false,reason:'MARGIN_SHORT'}}
   const fill=await this.#market(p,p.direction==='LONG'?'BUY':'SELL',add,{tag:'add'+(p.adds+1)});p.adds++;p.steps.push({kind:'ADD',at:this.now(),qty:add,avg:fill.avg,ratio});
   await this.#protect(p);this.#event('ADDED',{symbol:m.symbol,qty:add,total:p.qty,avg:p.avg,stop:p.stop,n:p.adds});
  }else{
   const cut=this.#qty(c,p.qty*(1-ratio));if(!(cut>0))return {ok:true,tooSmall:true};
   await this.#market(p,p.direction==='LONG'?'SELL':'BUY',Math.min(cut,p.qty),{reduceOnly:true,tag:'cut'+(p.reduces+1)});p.reduces++;p.steps.push({kind:'REDUCE',at:this.now(),qty:cut,ratio});
   await this.#protect(p);this.#event('REDUCED',{symbol:m.symbol,qty:cut,left:p.qty});
  }
  return {ok:true};
 }
 async #close(m,reason){
  const key=this.#key(m),p=this.store.positions[key];
  if(!p||p.status!=='OPEN')return {ok:true,notOpen:true};
  const now=await this.#position(p);
  if(now.size>0)await this.#market(p,p.direction==='LONG'?'SELL':'BUY',now.size,{reduceOnly:true,tag:'close'});
  if(p.stopOrderId){try{await this.client.cancelOrder(p.venueSymbol,p.stopOrderId)}catch{}}
  this.#closed(p,now.size>0?reason:'POSITION_GONE',now,m.theirPnlUSD);
  return {ok:true};
 }
 // Realized result: the venue's unrealized PnL just before the close (an estimate: fees not included).
 #closed(p,reason,now,theirPnlUSD=null){
  p.status='CLOSED';p.closedAt=this.now();p.closeReason=reason;
  const row={...p,netUSD:now?.unrealized??null,netSource:now?.unrealized!=null?'ESTIMATE_BEFORE_FEES':'UNKNOWN',theirPnlUSD};
  this.store.closed.push(row);delete this.store.positions[this.#key(p)];
  this.#event('CLOSED',{symbol:p.symbol,reason,netUSD:row.netUSD,theirPnlUSD,adds:p.adds});
 }
 /** Routine check: a copied position the stop (or anything else) closed is booked as closed. */
 async reconcile(){
  for(const p of Object.values(this.store.positions).filter(x=>x.status==='OPEN')){
   try{const now=await this.#position(p);if(!(now.size>0)){if(p.stopOrderId){try{await this.client.cancelOrder(p.venueSymbol,p.stopOrderId)}catch{}}this.#closed(p,'STOP_OR_EXTERNAL',now)}else{p.qty=now.size;p.avg=now.avg??p.avg;p.unrealized=now.unrealized;p.mark=now.mark}}
   catch(error){if(error.code==='HTTP_429')break}
  }
  this.#save();
 }
}
