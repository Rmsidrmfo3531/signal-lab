// Live/testnet order executor for BingX and Gate.io.
// Safety rules:
//  - OFF by default; LIVE additionally needs LIVE_TRADING_CONFIRM=REAL_MONEY and an
//    explicit "arm" after every start. TESTNET uses the venues' paper hosts.
//  - A position must always be protected: BingX attaches the stop to the entry;
//    Gate.io places the stop right after the fill and closes the position at market
//    (and engages the kill switch) if the stop cannot be placed.
//  - A failed or timed-out entry is never resent blindly: its client id is looked up
//    first. An unknown outcome blocks new entries until a person checks the account.
//  - The kill switch blocks new entries and never removes protective stops.
//  - BALANCE sizing (default): the account balance is read before every entry and the
//    position follows the paper split-buy rule (1 unit, then resting limit adds of 1, 2, 4 ...
//    units at volume zones, one stop beyond the last add for the whole position). Each new
//    position while others are open is half the size. Filled adds resize the targets; adds
//    still resting are cancelled once TP1 fills or the position is flat.
//  - Before every entry the symbol is set to CROSS margin and the signal's leverage
//    (score + market cap, 10-30x; capped at the venue maximum). If either cannot be set
//    and read back, the entry is not sent.
import fs from 'node:fs';
import path from 'node:path';
import {atomicWriteStore,readStore} from './persistence.mjs';
import {leverageForScore} from './paper.mjs';
import {roundDecimalToStep} from './decimal_grid.mjs';
import {venueStop,venueCosts} from './venue_execution.mjs';
import {bingxOrders,gateOrders,liveClientId,liveQuantity,liveSplitPlan,splitParts,preflight} from './live_orders.mjs';

const MAX_RECORDS=300,MAX_DELETED_KEYS=500,MAX_EVENTS=40;
const pick=(data,...keys)=>{for(const k of keys)if(data?.[k]!==undefined&&data[k]!==null&&data[k]!=='')return data[k];return undefined};
const orderOf=data=>data?.order??data;
const bingxOrderId=data=>{const o=orderOf(data);const id=pick(o,'orderID','orderId');return id===undefined?null:String(id)};
const num=v=>{const x=Number(v);return Number.isFinite(x)?x:null};
const given=v=>v===undefined||v===null||v===''||!Number.isFinite(Number(v))?null:Number(v);
const posNum=v=>{const x=num(v);return x>0?x:null};
// Venue units (lots / contracts) to base-asset units.
const baseUnits=(record,qty)=>record.venueContract?.quantityUnit==='CONTRACT'?qty*(Number(record.venueContract.contractSizeBase)||0):qty;
// The venue lists fund-flow rows a little after a fill, and the read window ends 120 s after the
// close: the first read waits SETTLE_DELAY_MS so a late last fill (the final stop) is not missed.
const SETTLE_TRIES=4,SETTLE_WINDOW_MS=2*3600000,SETTLE_DELAY_MS=150000;

export class LiveExecutor{
 constructor({config,clients={},directory,now=Date.now,log=()=>{},onChange=()=>{},priceOf=()=>null,onEvent=null}={}){
  // priceOf(record): the venue's public mid price, used only to estimate an exit when the venue gives none.
  Object.assign(this,{config,clients,now,log,onChange,priceOf,onEvent});
  this.file=directory?path.join(directory,'live-orders.json'):null;this.armed=false;this.busy=new Set();this.skipSeen=new Map();this.inFlight=new Set();this.lastTry=new Map();this.closing=new Set();this.reconciling=false;
  const stored=this.file&&fs.existsSync(this.file)?readStore(this.file):null;
  this.store={version:1,killSwitch:stored?.killSwitch===true,records:Array.isArray(stored?.records)?stored.records:[],skipped:[],
   deletedKeys:Array.isArray(stored?.deletedKeys)?stored.deletedKeys.slice(-MAX_DELETED_KEYS):[],
   // Results of deleted trades (no orders, no keys): the readiness check still counts them.
   archived:Array.isArray(stored?.archived)?stored.archived.slice(-MAX_RECORDS):[]};
  // Successful test orders are not kept (user, 2026-11-13); a failed one stays for checking.
  this.store.records=this.store.records.filter(r=>!(r.test===true&&r.status==='CLOSED'&&r.closeReason==='TEST_CLOSE'));
  // An entry that was being submitted when the server stopped may have filled without its stop:
  // unknown state, which blocks new entries until a person checks the account.
  for(const r of this.store.records)if(r.status==='SUBMITTING'){r.status='UNKNOWN';r.events=[...(r.events||[]),{type:'RESTART_WHILE_SUBMITTING',at:now()}].slice(-MAX_EVENTS)}
 }
 #save(){this.store.records=this.store.records.slice(-MAX_RECORDS);if(this.file){fs.mkdirSync(path.dirname(this.file),{recursive:true});atomicWriteStore(this.file,{version:1,killSwitch:this.store.killSwitch,records:this.store.records,deletedKeys:this.store.deletedKeys,archived:this.store.archived})}this.onChange(this.status())}
 #event(record,type,detail={}){record.events=[...(record.events||[]),{type,at:this.now(),...detail}].slice(-MAX_EVENTS);this.log(`[LIVE ${record.venue} ${record.symbol}] ${type}`,detail.reason||'')
  // Notices only (Telegram); a failing listener never affects orders.
  try{this.onEvent?.(record,type,detail)}catch{}}
 /** False while a just-evaluated signal waits before its next try (30 s, cleared by arming). */
 canTry(signalKey){const last=this.lastTry.get(signalKey);return !(last>this.now()-30000)||this.hasSignal(signalKey)}
 hasSignal(signalKey){return this.inFlight.has(signalKey)||this.store.records.some(r=>r.signalKey===signalKey)||this.store.deletedKeys.includes(signalKey)}
 /** Why a record may not be deleted, or null. Positions and unchecked states stay; a closed trade of
  * today (KST) stays because it counts toward today's risk limit. */
 deleteBlock(record){
  if(!record)return 'NOT_FOUND';
  if(['SUBMITTING','OPEN','UNKNOWN'].includes(record.status)||this.closing.has(record.signalKey)||this.busy.has(record.symbol))return 'ACTIVE';
  // Records that turned on the kill switch stay: they are the reason trading stopped.
  if(['LATE_ADD_AFTER_FLAT','EMERGENCY_NO_STOP'].includes(record.closeReason))return 'SAFETY_RECORD';
  if(record.test===true||record.status==='FAILED')return null;
  if(record.status==='CLOSED'&&record.day===new Date(this.now()+9*3600000).toISOString().slice(0,10))return 'TODAY_COUNTS_FOR_DAILY_RISK';
  return record.status==='CLOSED'?null:'NOT_FINISHED';
 }
 deleteRecord(signalKey){
  const record=this.store.records.find(r=>r.signalKey===signalKey),block=this.deleteBlock(record);
  if(block)return {ok:false,reason:block};
  this.store.records=this.store.records.filter(r=>r!==record);
  // The signal is remembered so the same signal is never entered again after its record is gone.
  if(!record.test)this.store.deletedKeys=[...this.store.deletedKeys.filter(k=>k!==signalKey),signalKey].slice(-MAX_DELETED_KEYS);
  if(!record.test&&record.status==='CLOSED')this.store.archived=[...this.store.archived,{signalKey,symbol:record.symbol,mode:record.mode,status:'CLOSED',createdAt:record.createdAt,
   closedAt:record.closedAt,realized:record.realized?{source:record.realized.source,netUSD:record.realized.netUSD}:null,
   events:(record.events||[]).filter(e=>e.type!=='RECONCILE_ERROR').map(e=>({type:e.type,at:e.at}))}].slice(-MAX_RECORDS);
  this.#save();return {ok:true}
 }
 credentials(){return {BINGX:Boolean(this.clients.BINGX),GATEIO:Boolean(this.clients.GATEIO)}}
 status(){
  return {mode:this.config.mode,armed:this.armed,killSwitch:this.store.killSwitch,liveConfirmed:this.config.liveConfirmed,venues:this.config.venues,
   credentialsConfigured:this.credentials(),limits:{sizing:this.config.sizing,balanceCapUSD:this.config.balanceCapUSD||null,unitPct:this.config.unitPct,maxLossPct:this.config.maxLossPct,dailyMaxLossPct:this.config.dailyMaxLossPct,maxRiskUSD:this.config.maxRiskUSD,dailyMaxRiskUSD:this.config.dailyMaxRiskUSD,maxOpen:this.config.maxOpen,maxPerDirection:this.config.maxPerDirection},
   records:this.store.records.slice(-30).reverse().map(({events,...r})=>({...r,lastEvent:events?.at(-1)??null,deletable:this.deleteBlock(r)===null})),skipped:this.store.skipped.slice(-20).reverse()};
 }
 arm(){
  // updating: the server is applying an update and will restart; trading stays off until then.
  if(this.updating)throw Object.assign(Error('UPDATING'),{httpStatus:409});
  if(this.config.mode==='OFF')throw Object.assign(Error('LIVE_MODE_OFF'),{httpStatus:409});
  if(this.config.mode==='LIVE'&&!this.config.liveConfirmed)throw Object.assign(Error('LIVE_CONFIRM_MISSING'),{httpStatus:409});
  if(this.store.killSwitch)throw Object.assign(Error('KILL_SWITCH_ON'),{httpStatus:409});
  this.armed=true;this.lastTry.clear();this.onChange(this.status());return this.status();
 }
 disarm(){this.armed=false;this.onChange(this.status());return this.status()}
 kill(reason='MANUAL'){this.armed=false;this.store.killSwitch=true;this.store.skipped.push({at:this.now(),reason:'KILL_SWITCH:'+reason});this.#save();return this.status()}
 resetKill(){this.store.killSwitch=false;this.#save();return this.status()}

 /** Called once per newly published final signal (already venue-checked). */
 async onSignal(row,{signalKey}){
  if(this.updating||this.paused)return {sent:false,reasons:['UPDATING']};
  // One evaluation per signal at a time: price ticks can offer the same signal again while the
  // balance is being read; without this both could pass the duplicate check.
  if(this.inFlight.has(signalKey))return {sent:false,reasons:['SIGNAL_IN_FLIGHT']};
  if(this.store.deletedKeys.includes(signalKey))return {sent:false,reasons:['DUPLICATE_SIGNAL']};
  // A signal that was just evaluated and skipped waits 30 s before the next try (each try reads
  // the balance and the venue book); arming clears the wait.
  const last=this.lastTry.get(signalKey);if(last>this.now()-30000&&!this.hasSignal(signalKey))return {sent:false,reasons:['RETRY_WAIT']};
  this.lastTry.set(signalKey,this.now());if(this.lastTry.size>500)this.lastTry.delete(this.lastTry.keys().next().value);
  this.inFlight.add(signalKey);
  try{return await this.#onSignal(row,{signalKey})}finally{this.inFlight.delete(signalKey)}
 }
 async #onSignal(row,{signalKey}){
  const venue=row?.executionVenue,contract=row?.venueContract&&{...row.venueContract,symbol:row.symbol};
  const clientOrderId=liveClientId(signalKey);
  if(this.store.records.some(r=>r.clientOrderId===clientOrderId))return {sent:false,reasons:['DUPLICATE_SIGNAL']};
  const leverage=Number(row?.leverage)>0?Math.round(Number(row.leverage)):leverageForScore(row?.score,row?.marketCap)??10;
  let qty=null,split=null,config=this.config,extra=[];
  if(this.config.sizing==='BALANCE'){
   // Read the balance only when an order could actually be sent.
   const gateOpen=this.config.mode!=='OFF'&&this.armed&&!this.store.killSwitch&&this.config.venues.includes(venue)&&this.credentials()[venue]&&contract;
   if(gateOpen){
    let balanceUSD=null;try{balanceUSD=await this.#balance(venue)}catch(error){extra.push('BALANCE_UNAVAILABLE')}
    if(balanceUSD>0&&this.config.balanceCapUSD>0)balanceUSD=Math.min(balanceUSD,this.config.balanceCapUSD);
    if(balanceUSD>0){
     const active=this.store.records.filter(r=>['SUBMITTING','OPEN','UNKNOWN'].includes(r.status)).length;
     split=liveSplitPlan({row,balanceUSD,leverage,sizeScale:.5**active,config:this.config});
     if(split){qty=split.qty;row={...row,stop:split.stop}}
     config={...this.config,dailyMaxRiskUSD:balanceUSD*this.config.dailyMaxLossPct/100};
     split&&(split.balanceUSD=balanceUSD);
    }else if(!extra.length)extra.push('BALANCE_EMPTY');
   }
  }else qty=contract?liveQuantity({quantity:row.targetPlan?.quantity,estimatedStopLossUSD:row.execution?.estimatedStopLossUSD,maxRiskUSD:this.config.maxRiskUSD,contract}):null;
  const check=preflight({config,armed:this.armed,killSwitch:this.store.killSwitch,credentials:this.credentials(),row,records:this.store.records,now:this.now(),qty});
  if(extra.length){check.ok=false;check.reasons=[...extra,...check.reasons.filter(r=>r!=='QUANTITY_BELOW_MINIMUM_AT_LIVE_RISK')]}
  if(!check.ok){
   // The same signal is offered on every price tick while it stays valid: list a skip once per
   // signal and reason set (again after 10 minutes), not on every tick.
   const tag=signalKey+'|'+check.reasons.join(','),last=this.skipSeen.get(tag);
   if(!(last>this.now()-600000)){this.skipSeen.set(tag,this.now());if(this.skipSeen.size>500)this.skipSeen.delete(this.skipSeen.keys().next().value);
    this.store.skipped=[...this.store.skipped,{at:this.now(),symbol:row?.symbol,venue,reasons:check.reasons}].slice(-50);this.onChange(this.status())}
   return {sent:false,reasons:check.reasons}}
  if(this.busy.has(row.symbol))return {sent:false,reasons:['SYMBOL_BUSY']};
  this.busy.add(row.symbol);
  const record={clientOrderId,signalKey,venue,mode:this.config.mode,symbol:row.symbol,venueSymbol:row.venueSymbol,venueContract:row.venueContract,direction:row.direction,
   plannedEntry:posNum(row.entry),stop:row.stop,targets:[...row.targets],quantity:qty,marginMode:'CROSS',leverage,sizing:this.config.sizing,...(row.liveRoutedFrom?{routedFrom:row.liveRoutedFrom}:{}),...(split?{balanceUSD:split.balanceUSD,adds:split.adds,zoneSource:split.zoneSource,peakSize:qty.total}:{}),plannedRiskUSD:qty.riskUSD,day:check.day,status:'SUBMITTING',createdAt:this.now(),
   // Signal context for the trade journal review (no effect on orders).
   signal:{pattern:row.pattern??null,score:Number.isFinite(Number(row.score))?Number(row.score):null,btcTrend:row.btcContext?.trend??null,trend4h:typeof row.trend==='string'?row.trend:null},
   entryOrderId:null,stopOrderId:null,targetOrderIds:[],breakevenMoved:false,events:[]};
  this.store.records.push(record);this.#save();
  try{
   if(venue==='BINGX')await this.#openBingX(record);else await this.#openGate(record);
  }catch(error){
   // Anything unexpected after the entry may have filled: stop trading until checked.
   // An OPEN record already has its stop handled; only an unfinished entry is unknown.
   if(record.status==='SUBMITTING')record.status='UNKNOWN';
   this.#event(record,'ERROR',{reason:error.code||error.message});
   if(record.status==='UNKNOWN')this.kill('UNRESOLVED_'+record.venue);
  }finally{this.busy.delete(row.symbol);this.#save()}
  return {sent:true,status:record.status};
 }

 async #openBingX(record){
  const client=this.clients.BINGX,plan=bingxOrders({symbol:record.venueSymbol,direction:record.direction,stop:record.stop,targets:record.targets,qty:record.quantity,clientOrderId:record.clientOrderId});
  const mode=await client.positionMode();
  if(mode?.dualSidePosition===true||mode?.dualSidePosition==='true'){record.status='FAILED';this.#event(record,'REJECTED',{reason:'BINGX_HEDGE_MODE_UNSUPPORTED'});return}
  try{
   const current=await client.marginType(record.venueSymbol);
   if(current?.marginType!=='CROSSED'){await client.setMarginType(record.venueSymbol,'CROSSED');
    const check=await client.marginType(record.venueSymbol);if(check?.marginType!=='CROSSED')throw Object.assign(Error('cross not confirmed'),{code:'BINGX_CROSS_NOT_CONFIRMED'})}
   const info=await client.leverage(record.venueSymbol).catch(()=>null);
   const max=Number(record.direction==='LONG'?info?.maxLongLeverage:info?.maxShortLeverage);
   if(max>0&&record.leverage>max){this.#event(record,'LEVERAGE_CAPPED',{reason:`${record.leverage}x>${max}x`});record.leverage=Math.floor(max)}
   const set=await client.setLeverage(record.venueSymbol,'BOTH',record.leverage);
   if(set?.leverage!==undefined&&Number(set.leverage)!==record.leverage)throw Object.assign(Error('leverage not confirmed'),{code:'BINGX_LEVERAGE_NOT_CONFIRMED'});
   this.#event(record,'MARGIN_SET',{reason:`CROSS ${record.leverage}x`});
  }catch(error){record.status='FAILED';this.#event(record,'REJECTED',{reason:'MARGIN_SETUP_FAILED:'+(error.code||error.message)});return}
  let entry;
  try{entry=await client.placeOrder(plan.entry)}
  catch(error){
   // Outcome unknown (timeout/network) or rejected: look the client id up before anything else.
   let found=null;try{found=await client.getOrder(record.venueSymbol,{clientOrderId:record.clientOrderId})}catch{}
   if(!found||!bingxOrderId(found)){
    if(error.code==='NETWORK_UNREACHABLE'){record.status='UNKNOWN';this.#event(record,'ENTRY_OUTCOME_UNKNOWN',{reason:error.code});this.kill('UNRESOLVED_BINGX');return}
    record.status='FAILED';this.#event(record,'ENTRY_REJECTED',{reason:error.code||'REJECTED'});return;
   }
   entry=found;
  }
  record.entryOrderId=bingxOrderId(entry);record.status='OPEN';this.#event(record,'ENTRY_SENT',{orderId:record.entryOrderId});
  {const avg=posNum(pick(orderOf(entry),'avgPrice'));if(avg)record.firstEntryPrice=avg} // else read from the first position check
  // Confirm the attached stop exists; otherwise place one; otherwise close at market.
  const open=await client.openOrders(record.venueSymbol).catch(()=>null);
  const stopOrder=(open?.orders??(Array.isArray(open)?open:[])).find(o=>String(o.type).startsWith('STOP'));
  if(stopOrder){record.stopOrderId=bingxOrderId(stopOrder);this.#event(record,'STOP_CONFIRMED',{orderId:record.stopOrderId})}
  else{
   try{const s=await client.placeOrder(plan.stop(record.quantity.total));record.stopOrderId=bingxOrderId(s);this.#event(record,'STOP_PLACED',{orderId:record.stopOrderId})}
   catch(error){
    this.#event(record,'STOP_FAILED',{reason:error.code||error.message});
    try{await client.placeOrder(plan.emergencyClose(record.quantity.total));record.status='CLOSED';record.closedAt=this.now();record.closeReason='EMERGENCY_NO_STOP';this.#event(record,'EMERGENCY_CLOSED')}
    catch(e){record.status='UNKNOWN';this.#event(record,'EMERGENCY_CLOSE_FAILED',{reason:e.code||e.message})}
    this.kill('NO_PROTECTIVE_STOP');return;
   }
  }
  record.targetParts=[...record.quantity.parts];
  for(const [i,params] of plan.targets.entries()){
   try{const t=await client.placeOrder(params);record.targetOrderIds[i]=bingxOrderId(t)}
   catch(error){record.targetOrderIds[i]=null;this.#event(record,'TARGET_FAILED',{reason:error.code||error.message})} // the stop still protects the position
  }
  this.#event(record,'PROTECTED',{targets:record.targetOrderIds.filter(Boolean).length});
  if(record.adds?.length)await this.#placeAdds(record);
 }

 async #openGate(record){
  const client=this.clients.GATEIO,contract=record.venueSymbol;
  const plan=gateOrders({contract,direction:record.direction,stop:record.stop,targets:record.targets,qty:record.quantity,clientOrderId:record.clientOrderId});
  const account=await client.account();
  if(account?.in_dual_mode===true){record.status='FAILED';this.#event(record,'REJECTED',{reason:'GATEIO_DUAL_MODE_UNSUPPORTED'});return}
  try{
   const pos=await client.setCrossLeverage(contract,record.leverage);
   // leverage "0" = cross margin; cross_leverage_limit = the leverage in cross.
   if(Number(pos?.leverage)!==0)throw Object.assign(Error('cross not confirmed'),{code:'GATEIO_CROSS_NOT_CONFIRMED'});
   const got=Number(pos?.cross_leverage_limit);
   if(got>0&&got!==record.leverage){this.#event(record,'LEVERAGE_CAPPED',{reason:`${record.leverage}x>${got}x`});record.leverage=got}
   this.#event(record,'MARGIN_SET',{reason:`CROSS ${record.leverage}x`});
  }catch(error){record.status='FAILED';this.#event(record,'REJECTED',{reason:'MARGIN_SETUP_FAILED:'+(error.code||error.message)});return}
  let entry;
  try{entry=await client.placeOrder(plan.entry)}
  catch(error){
   let found=null;try{found=await client.getOrder(plan.entry.text)}catch{}
   if(!found?.id){
    if(error.code==='NETWORK_UNREACHABLE'){record.status='UNKNOWN';this.#event(record,'ENTRY_OUTCOME_UNKNOWN',{reason:error.code});this.kill('UNRESOLVED_GATEIO');return}
    record.status='FAILED';this.#event(record,'ENTRY_REJECTED',{reason:error.code||'REJECTED'});return;
   }
   entry=found;
  }
  record.entryOrderId=String(entry.id);
  const filled=Math.abs(Number(entry.size))-Math.abs(Number(entry.left??0));
  if(!(filled>0)){record.status='FAILED';this.#event(record,'ENTRY_NOT_FILLED',{reason:entry.finish_as||'ioc'});return}
  record.status='OPEN';record.filledContracts=filled;if(posNum(entry.fill_price))record.firstEntryPrice=posNum(entry.fill_price);this.#event(record,'ENTRY_FILLED',{orderId:record.entryOrderId,contracts:filled,price:entry.fill_price});
  try{const s=await client.placeTrigger(plan.stop());record.stopOrderId=String(s.id);this.#event(record,'STOP_PLACED',{orderId:record.stopOrderId})}
  catch(error){
   this.#event(record,'STOP_FAILED',{reason:error.code||error.message});
   try{await client.placeOrder(plan.emergencyClose());record.status='CLOSED';record.closedAt=this.now();record.closeReason='EMERGENCY_NO_STOP';this.#event(record,'EMERGENCY_CLOSED')}
   catch(e){record.status='UNKNOWN';this.#event(record,'EMERGENCY_CLOSE_FAILED',{reason:e.code||e.message})}
   this.kill('NO_PROTECTIVE_STOP');return;
  }
  // If the IOC filled partially, scale the targets to what is actually held.
  let parts=record.quantity.parts;
  if(filled!==record.quantity.total){const first=Math.floor(filled*.4),second=Math.floor(filled*.35);parts=[first,second,filled-first-second]}
  plan.targets.forEach((t,i)=>{t.initial.size=Math.sign(t.initial.size)*parts[i]});
  record.targetParts=[...parts];
  for(const [i,t] of plan.targets.entries()){if(!t.initial.size){record.targetOrderIds[i]=null;continue}
   try{const o=await client.placeTrigger(t);record.targetOrderIds[i]=String(o.id)}
   catch(error){record.targetOrderIds[i]=null;this.#event(record,'TARGET_FAILED',{reason:error.code||error.message})}
  }
  this.#event(record,'PROTECTED',{targets:record.targetOrderIds.filter(Boolean).length});
  if(record.adds?.length){if(filled!==record.quantity.total)record.peakSize=filled;await this.#placeAdds(record)}
 }

 /** Split buys: the stop must cover the whole future position (BingX: closePosition stop,
  * placed before the entry's own stop is cancelled; Gate.io's stop already closes it all),
  * then the resting limit adds. An add that cannot be placed is skipped, never retried blindly. */
 async #placeAdds(record){
  const client=this.clients[record.venue],full=record.adds.reduce((s,a)=>s+a.qty,record.quantity.total);
  if(record.venue==='BINGX'){
   const plan=this.#plan(record);
   try{const s=await client.placeOrder(plan.wholeStop(record.stop,Number(full.toFixed(12))));const old=record.stopOrderId;record.stopOrderId=bingxOrderId(s);
    if(old&&old!==record.stopOrderId)await this.#cancel(record,old);this.#event(record,'STOP_WHOLE_POSITION',{orderId:record.stopOrderId})}
   catch(error){this.#event(record,'STOP_WHOLE_FAILED',{reason:error.code||error.message});this.#event(record,'ADDS_SKIPPED',{reason:'NO_WHOLE_POSITION_STOP'});record.adds.forEach(a=>a.skipped=true);return}
  }
  const plan=this.#plan(record);
  for(const [i,a] of record.adds.entries()){
   const id=record.venue==='BINGX'?record.clientOrderId+'a'+String.fromCharCode(97+i):record.clientOrderId.slice(0,24)+'a'+String.fromCharCode(97+i);
   try{const o=await client.placeOrder(plan.add(a.price,a.qty,id));a.orderId=record.venue==='BINGX'?bingxOrderId(o):String(o.id)}
   catch(error){a.orderId=null;a.skipped=true;this.#event(record,'ADD_FAILED',{reason:`${i+1}: `+(error.code||error.message)})}
  }
  this.#event(record,'ADDS_PLACED',{reason:`${record.adds.filter(a=>a.orderId).length}/${record.adds.length}`});
 }
 #plan(record){
  return record.venue==='BINGX'?bingxOrders({symbol:record.venueSymbol,direction:record.direction,stop:record.stop,targets:record.targets,qty:record.quantity,clientOrderId:record.clientOrderId})
   :gateOrders({contract:record.venueSymbol,direction:record.direction,stop:record.stop,targets:record.targets,qty:record.quantity,clientOrderId:record.clientOrderId});
 }
 async #cancelAdds(record,why){
  for(const a of record.adds||[]){if(!a.orderId||a.filled||a.cancelled)continue;
   try{if(record.venue==='BINGX')await this.clients.BINGX.cancelOrder(record.venueSymbol,a.orderId);else await this.clients.GATEIO.cancelOrder(a.orderId);a.cancelled=true}
   catch(error){this.#event(record,'ADD_CANCEL_FAILED',{orderId:a.orderId,reason:error.code||error.message})}
  }
  this.#event(record,'ADDS_CANCELLED',{reason:why});
 }
 /** Filled adds: new 40/35/25 % targets for the larger position (old target cancelled first). */
 async #resizeTargets(record,size){
  if(!record.venueContract)return;
  const client=this.clients[record.venue],parts=splitParts(size,record.venueContract),plan=this.#plan(record);
  for(let i=0;i<3;i++){
   const old=record.targetOrderIds?.[i];if(old)await this.#cancel(record,old);
   if(!parts[i]){record.targetOrderIds[i]=null;continue}
   const t=plan.targets[i];if(record.venue==='BINGX')t.quantity=String(parts[i]);else t.initial.size=Math.sign(t.initial.size)*parts[i];
   try{const o=record.venue==='BINGX'?await client.placeOrder(t):await client.placeTrigger(t);record.targetOrderIds[i]=record.venue==='BINGX'?bingxOrderId(o):String(o.id)}
   catch(error){record.targetOrderIds[i]=null;this.#event(record,'TARGET_FAILED',{reason:error.code||error.message})}
  }
  record.targetParts=parts;
 }
 async #balance(venue){
  if(venue==='BINGX'){
   const data=await this.clients.BINGX.balance(),list=Array.isArray(data)?data:[data?.balance??data];
   const usdt=list.find(x=>x?.asset==='USDT')??list[0];return Number(usdt?.equity??usdt?.balance)||0;
  }
  const a=await this.clients.GATEIO.account();return Number(a?.total)||Number(a?.available)||0;
 }

 /** Compare open records with the venue: detect closed positions and move the stop to
  * the entry once TP1 (40%) has filled. New protective stop first, old one second. */
 /** TESTNET only: one order through the same path as a real signal (cross margin + leverage,
  * entry with its stop, three targets, the whole-position stop and resting adds), held for
  * holdMs, then everything cancelled and the position closed at market. Needs the executor armed.
  * The record is marked test (left out of the daily risk). */
 async testRoundTrip(row,{holdMs=5000,sleep=ms=>new Promise(r=>setTimeout(r,ms)),maxBalanceUSD=400}={}){
  if(this.updating||this.paused)throw Object.assign(Error('UPDATING'),{httpStatus:409});
  if(this.config.mode!=='TESTNET')throw Object.assign(Error('TEST_TESTNET_ONLY'),{httpStatus:409});
  // Small on purpose: size from at most maxBalanceUSD of the (virtual) balance.
  const config=this.config;this.config={...config,balanceCapUSD:Math.min(config.balanceCapUSD>0?config.balanceCapUSD:maxBalanceUSD,maxBalanceUSD)};
  const signalKey='TEST:'+this.now();let sent;
  try{sent=await this.onSignal(row,{signalKey})}finally{this.config=config}
  const record=this.store.records.find(r=>r.signalKey===signalKey);
  if(!record)return {ok:false,reasons:sent?.reasons||['NOT_SENT']};
  record.test=true;
  if(record.status==='OPEN'){await sleep(holdMs);await this.#closeTest(record,sleep)}
  const ok=record.status==='CLOSED'&&record.closeReason==='TEST_CLOSE';
  // A successful test leaves no record (its steps are in this reply); a failed one stays for checking.
  if(ok)this.store.records=this.store.records.filter(r=>r!==record);
  this.#save();
  return {ok,status:record.status,venue:record.venue,symbol:record.symbol,
   quantity:record.quantity,leverage:record.leverage,stop:record.stop,targets:record.targets,adds:(record.adds||[]).length,events:record.events.map(e=>({type:e.type,reason:e.reason??null,orderId:e.orderId??null}))};
 }
 /** Close order: adds cancelled first, then a reduce-only market close, the position confirmed
  * flat (with retries), and only then the stop and targets cancelled. Anything left (position,
  * resting orders, unknown state) marks the record UNKNOWN and stops trading. */
 async #closeTest(record,sleep){
  if(this.busy.has(record.symbol)){this.#event(record,'TEST_CLOSE_DEFERRED',{reason:'SYMBOL_BUSY'});return}
  this.busy.add(record.symbol);
  const fail=(type,reason)=>{record.status='UNKNOWN';this.#event(record,type,{reason});this.kill(type)};
  try{
   if(record.adds?.length)await this.#cancelAdds(record,'TEST_CLOSE');
   const plan=this.#plan(record);
   let pos=await this.#position(record);
   if(pos.size>0){
    if(record.venue==='BINGX')await this.clients.BINGX.placeOrder(plan.emergencyClose(pos.size));else await this.clients.GATEIO.placeOrder(plan.emergencyClose());
    pos=null;
    for(let i=0;i<4;i++){pos=await this.#position(record).catch(()=>null);if(pos&&pos.size===0)break;await sleep(1000)}
    if(!pos)return fail('TEST_CLOSE_UNVERIFIED','position check failed');
    if(pos.size>0)return fail('TEST_CLOSE_INCOMPLETE',`size ${pos.size}`); // stop and targets stay in place
   }
   for(const id of [...record.targetOrderIds,record.stopOrderId].filter(Boolean))await this.#cancel(record,id);
   if(record.venue==='BINGX'){
    const open=await this.clients.BINGX.openOrders(record.venueSymbol).catch(()=>null),list=open?.orders??(Array.isArray(open)?open:null);
    if(!list)return fail('TEST_ORDERS_UNVERIFIED','open orders check failed');
    if(list.length)return fail('TEST_ORDERS_LEFT',`${list.length} open`);
   }
   record.status='CLOSED';record.closedAt=this.now();record.closeReason='TEST_CLOSE';this.#event(record,'TEST_CLOSED');
  }catch(error){fail('TEST_CLOSE_FAILED',error.code||error.message)}
  finally{this.busy.delete(record.symbol)}
 }
 async reconcile(){
  // paused: the server is about to restart (update); no new venue work may start.
  if(this.reconciling||this.paused)return;this.reconciling=true;
  try{await this.#reconcileOpen()}finally{this.reconciling=false}
 }
 /** True while nothing is being ordered, cancelled or checked (safe moment to restart). */
 idle(){return !this.reconciling&&!this.inFlight.size&&!this.busy.size&&!this.closing.size&&!this.store.records.some(r=>r.status==='SUBMITTING')}
 async #reconcileOpen(){
  for(const record of this.store.records.filter(r=>r.status==='OPEN')){
   try{
    const pos=await this.#position(record),{size,entryPrice}=pos;
    this.#observe(record,pos);
    if(size===0){
     record.status='CLOSED';record.closedAt=this.now();record.closeReason=record.closeReason||'POSITION_FLAT';
     this.closing.add(record.signalKey);try{
     // Resting adds first: an add left behind would open a new position on its own.
     if(record.adds?.length){
      await this.#cancelAdds(record,'POSITION_FLAT');
      // An add can fill between the stop-out and its cancel (the stop uses the mark price, the
      // add the last price). Such a position has no stop: close it at market and stop trading.
      const again=await this.#position(record).catch(()=>null);
      if(!again||again.size>0){
       const plan=this.#plan(record);
       try{if(!again)throw Object.assign(Error('position unknown'),{code:'POSITION_CHECK_FAILED'});
        if(record.venue==='BINGX')await this.clients.BINGX.placeOrder(plan.emergencyClose(again.size));else await this.clients.GATEIO.placeOrder(plan.emergencyClose());
        this.#event(record,'LATE_ADD_CLOSED',{reason:`size ${again.size}`})}
       catch(error){this.#event(record,'LATE_ADD_CLOSE_FAILED',{reason:error.code||error.message})}
       record.closeReason='LATE_ADD_AFTER_FLAT';this.kill('LATE_ADD_'+record.venue);
      }
     }
     for(const id of [record.stopOrderId,...record.targetOrderIds].filter(Boolean))await this.#cancel(record,id);
     this.#event(record,'CLOSED');}finally{this.closing.delete(record.signalKey)}continue;
    }
    if(record.adds?.length&&!record.breakevenMoved&&size>(record.peakSize??record.quantity.total)*(1+1e-9)){
     // One or more adds filled: count them, then resize the targets to the whole position.
     let cum=record.peakSize??record.quantity.total;
     for(const a of record.adds)if(!a.filled&&a.orderId&&cum+a.qty<=size*(1+1e-9)){a.filled=true;cum+=a.qty}
     record.peakSize=size;record.filledAdds=record.adds.filter(a=>a.filled).length;
     this.#event(record,'ADD_FILLED',{reason:`${record.filledAdds}/${record.adds.length} size ${size} avg ${entryPrice}`});
     await this.#resizeTargets(record,size);
    }
    const original=record.peakSize??(record.venue==='GATEIO'?(record.filledContracts??record.quantity.total):record.quantity.total);
    // TP1 filled: the position shrank by at least the first target part (40 %, floored to the grid).
    const tp1Done=size<=original-Math.min(original*.4,Number(record.targetParts?.[0])||original*.4)+1e-9;
    const lockedIn=entryPrice>0&&(record.direction==='LONG'?record.stop>=entryPrice:record.stop<=entryPrice);
    if(!record.breakevenMoved&&lockedIn&&tp1Done){record.breakevenMoved=true;this.#event(record,'BREAKEVEN_SKIPPED_STOP_ALREADY_BETTER',{stop:record.stop})}
    if(!record.breakevenMoved&&tp1Done&&entryPrice>0){
     const client=this.clients[record.venue];let placed;
     if(record.venue==='BINGX'){const plan=bingxOrders({symbol:record.venueSymbol,direction:record.direction,stop:record.stop,targets:record.targets,qty:record.quantity,clientOrderId:record.clientOrderId});
      placed=bingxOrderId(await client.placeOrder(plan.breakeven(entryPrice,size)))}
     else{const plan=gateOrders({contract:record.venueSymbol,direction:record.direction,stop:record.stop,targets:record.targets,qty:record.quantity,clientOrderId:record.clientOrderId});
      placed=String((await client.placeTrigger(plan.breakeven(entryPrice))).id)}
     const old=record.stopOrderId;record.stopOrderId=placed;record.breakevenMoved=true;record.breakevenPrice=entryPrice;record.stop=entryPrice;
     if(old)await this.#cancel(record,old);
     this.#event(record,'STOP_TO_BREAKEVEN',{price:entryPrice,orderId:placed});
    }
    // TP1 filled: no more adds (same rule as paper).
    if(record.breakevenMoved&&record.adds?.some(a=>a.orderId&&!a.filled&&!a.cancelled))await this.#cancelAdds(record,'TP1_FILLED');
   }catch(error){this.#event(record,'RECONCILE_ERROR',{reason:error.code||error.message})}
  }
  // Realized result of closed trades (read only): the venue's own settlement, else an estimate.
  for(const record of this.store.records.filter(r=>r.status==='CLOSED'&&!r.test&&!r.realized&&(r.settleAttempts||0)<SETTLE_TRIES&&r.closedAt>0&&this.now()-r.closedAt>=SETTLE_DELAY_MS&&this.now()-r.closedAt<SETTLE_WINDOW_MS)){
   try{await this.#settle(record)}catch(error){this.#event(record,'SETTLE_ERROR',{reason:error.code||error.message})}
  }
  this.#save();
 }
 /** Observation only (never changes an order): the venue's position snapshot for the screen, the
  * first entry price, and each size reduction (a target or stop fill) with the price seen now. */
 #observe(record,{size,entryPrice,markPrice=null,unrealizedPnLUSD=null,marginUSD=null,realizedPnLUSD=null}){
  const prev=record.position,at=this.now(),seen=posNum(markPrice)??this.#publicPrice(record);
  if(prev&&size<prev.size-1e-12)record.exits=[...(record.exits||[]),{qty:Number((prev.size-size).toFixed(12)),price:seen??prev.markPrice??null,at}].slice(-30);
  if(size>0){
   const original=record.peakSize??(record.venue==='GATEIO'?(record.filledContracts??record.quantity?.total):record.quantity?.total);
   if(!record.firstEntryPrice&&entryPrice>0&&!(size>original*(1+1e-9)))record.firstEntryPrice=entryPrice;
   record.position={size,entryPrice:posNum(entryPrice),markPrice:seen,markSource:posNum(markPrice)?'EXCHANGE':seen?'VENUE_BOOK':null,unrealizedPnLUSD:num(unrealizedPnLUSD),marginUSD:posNum(marginUSD),realizedPnLUSD:given(realizedPnLUSD),at};
  }else record.position={...(prev||{}),size:0,unrealizedPnLUSD:null,at};
 }
 #publicPrice(record){try{return posNum(this.priceOf(record))}catch{return null}}
 /** BingX: sum of the fund-flow rows (realized PnL, trading fees, funding) of this trade's symbol
  * and lifetime. The venue may list them a little after the close, so up to SETTLE_TRIES reads;
  * then (and for Gate.io) an estimate from the observed exits, marked ESTIMATE. */
 async #settle(record){
  record.settleAttempts=(record.settleAttempts||0)+1;
  if(record.venue==='BINGX'&&typeof this.clients.BINGX?.income==='function'){
   try{
    const from=(record.createdAt||record.closedAt)-30000,to=Math.min(this.now(),record.closedAt+120000);
    const data=await this.clients.BINGX.income({symbol:record.venueSymbol,startTime:from,endTime:to,limit:1000});
    const list=Array.isArray(data)?data:Array.isArray(data?.list)?data.list:[];
    const rows=list.filter(x=>x?.symbol===record.venueSymbol&&Number(x.time)>=from&&Number(x.time)<=to);
    if(rows.some(x=>x.incomeType==='REALIZED_PNL')){
     const sum=type=>rows.filter(x=>x.incomeType===type).reduce((t,x)=>t+(Number(x.income)||0),0),r=x=>Math.round(x*1e4)/1e4;
     const pnl=sum('REALIZED_PNL'),fee=sum('TRADING_FEE'),funding=sum('FUNDING_FEE');
     record.realized={source:'EXCHANGE',pnlUSD:r(pnl),feeUSD:r(fee),fundingUSD:r(funding),netUSD:r(pnl+fee+funding),at:this.now()};
     this.#event(record,'SETTLED',{reason:'net '+record.realized.netUSD});return;
    }
   }catch(error){this.#event(record,'SETTLE_READ_FAILED',{reason:error.code||error.message})}
   if(record.settleAttempts<SETTLE_TRIES)return;
  }
  record.realized=this.#estimate(record);
 }
 #estimate(record){
  const avg=posNum(record.position?.entryPrice)??posNum(record.firstEntryPrice),exits=record.exits||[],at=this.now();
  if(!avg||!exits.length||exits.some(e=>!posNum(e.price)))return {source:'UNKNOWN',at};
  const dir=record.direction==='LONG'?1:-1,rate=venueCosts(record.venueContract).takerRate,r=x=>Math.round(x*1e4)/1e4;
  let pnl=0,fee=0;for(const e of exits){const q=baseUnits(record,e.qty);pnl+=dir*(e.price-avg)*q;fee+=(avg+e.price)*q*rate}
  return {source:'ESTIMATE',pnlUSD:r(pnl),feeUSD:r(-fee),fundingUSD:null,netUSD:r(pnl-fee),takerRate:rate,at};
 }
 /** Account equity for the status screen (read only). */
 accountBalance(venue){if(!this.clients[venue])return Promise.reject(Object.assign(Error('CREDENTIALS_MISSING'),{code:'CREDENTIALS_MISSING'}));return this.#balance(venue)}
 /** Manual stop/target change on an open live position. The new stop is placed before
  * the old one is cancelled, so the position is never unprotected. A wider stop may not
  * push the position's risk above the per-trade cap. A target is replaced only after its
  * old order was cancelled, so a target can never be doubled. */
 async setLevels(signalKey,{stop,targets}){
  if(this.updating||this.paused)return {ok:false,live:true,reasons:['UPDATING']};
  const record=this.store.records.find(r=>r.signalKey===signalKey&&r.status==='OPEN');
  if(!record)return {ok:true,live:false};
  if(this.busy.has(record.symbol))return {ok:false,live:true,reasons:['SYMBOL_BUSY']};
  this.busy.add(record.symbol);
  const client=this.clients[record.venue],dir=record.direction==='LONG'?1:-1,result={ok:true,live:true,stopMoved:false,targetsMoved:[],errors:[]};
  // Manual levels arrive on the paper venue's grid: put them on this record's venue grid
  // (stop away from the entry, targets toward it).
  const tick=record.venueContract?.tickSize;
  if(tick){
   if(Number.isFinite(stop))stop=venueStop(stop,record.direction,tick);
   if(Array.isArray(targets))targets=targets.map(t=>Number.isFinite(t)?Number(roundDecimalToStep(t,String(tick),dir===1?'DOWN':'UP')):t);
  }
  try{
   const {size,entryPrice}=await this.#position(record);
   if(size===0)return {ok:false,live:true,reasons:['LIVE_POSITION_FLAT']};
   const qty=record.quantity,original=record.venue==='GATEIO'?(record.filledContracts??qty.total):qty.total;
   const plan=record.venue==='BINGX'?bingxOrders({symbol:record.venueSymbol,direction:record.direction,stop,targets,qty,clientOrderId:record.clientOrderId})
    :gateOrders({contract:record.venueSymbol,direction:record.direction,stop,targets,qty,clientOrderId:record.clientOrderId});
   if(Number.isFinite(stop)&&stop!==record.stop){
    const reference=entryPrice>0?entryPrice:null,wider=dir*(record.stop-stop)>0;
    if(wider&&reference){
     const initial=Math.abs(reference-(record.initialStop??record.stop))||Math.abs(reference-record.stop),risk=qty.riskUSD*Math.max(0,dir*(reference-stop))/initial*(size/original);
     const cap=record.sizing==='BALANCE'?record.plannedRiskUSD:this.config.maxRiskUSD;
     if(risk>cap*(1+1e-6))return {ok:false,live:true,reasons:['MANUAL_STOP_EXCEEDS_RISK_LIMIT'],riskUSD:risk,maxRiskUSD:cap};
    }
    let placed;
    // With adds still resting, the BingX stop must keep covering the whole future position.
    const pendingAdds=(record.adds||[]).filter(a=>a.orderId&&!a.filled&&!a.cancelled).reduce((t,a)=>t+a.qty,0);
    try{placed=record.venue==='BINGX'?bingxOrderId(await client.placeOrder(pendingAdds>0?plan.wholeStop(stop,Number((size+pendingAdds).toFixed(12))):plan.breakeven(stop,size))):String((await client.placeTrigger(plan.breakeven(stop))).id)}
    catch(error){this.#event(record,'MANUAL_STOP_FAILED',{reason:error.code||error.message});return {ok:false,live:true,reasons:['LIVE_STOP_NOT_PLACED'],detail:error.code||error.message}}
    const old=record.stopOrderId;record.initialStop??=record.stop;record.stopOrderId=placed;record.stop=stop;result.stopMoved=true;
    if(old)await this.#cancel(record,old);
    this.#event(record,'MANUAL_STOP',{price:stop,orderId:placed});
   }
   if(Array.isArray(targets))for(let i=0;i<3;i++){
    if(!Number.isFinite(targets[i])||targets[i]===record.targets[i])continue;
    const old=record.targetOrderIds?.[i];
    if(old){
     try{if(record.venue==='BINGX')await client.cancelOrder(record.venueSymbol,old);else await client.cancelTrigger(old)}
     catch(error){result.errors.push(`TP${i+1}_CANCEL_FAILED`);this.#event(record,'MANUAL_TARGET_CANCEL_FAILED',{target:i+1,reason:error.code||error.message});continue}
    }
    const part=record.targetParts?.[i]??qty.parts[i];
    if(!part){record.targets[i]=targets[i];continue}
    try{
     const params=plan.targets[i];
     if(record.venue==='BINGX')params.quantity=String(part);else params.initial.size=Math.sign(params.initial.size)*part;
     const o=record.venue==='BINGX'?await client.placeOrder(params):await client.placeTrigger(params);
     record.targetOrderIds[i]=record.venue==='BINGX'?bingxOrderId(o):String(o.id);record.targets[i]=targets[i];result.targetsMoved.push(i+1);
     this.#event(record,'MANUAL_TARGET',{target:i+1,price:targets[i],orderId:record.targetOrderIds[i]});
    }catch(error){record.targetOrderIds[i]=null;record.targets[i]=targets[i];result.errors.push(`TP${i+1}_NOT_PLACED`);this.#event(record,'TARGET_FAILED',{target:i+1,reason:error.code||error.message})}
   }
  }catch(error){this.#event(record,'MANUAL_LEVELS_ERROR',{reason:error.code||error.message});return {ok:false,live:true,reasons:['LIVE_LEVELS_ERROR'],detail:error.code||error.message}}
  finally{this.busy.delete(record.symbol);this.#save()}
  return result;
 }
 async #position(record){
  const client=this.clients[record.venue];
  if(record.venue==='BINGX'){
   const list=await client.positions(record.venueSymbol),rows=Array.isArray(list)?list:[];
   const row=rows.find(p=>p.symbol===record.venueSymbol);
   return {size:row?Math.abs(Number(row.positionAmt)||0):0,entryPrice:Number(row?.avgPrice)||0,markPrice:posNum(row?.markPrice),unrealizedPnLUSD:row?num(row.unrealizedProfit):null,
    marginUSD:row?posNum(row.initialMargin??row.margin):null,realizedPnLUSD:given(row?.realisedProfit??row?.realizedProfit)};
  }
  const p=await client.position(record.venueSymbol);
  return {size:Math.abs(Number(p?.size)||0),entryPrice:Number(p?.entry_price)||0,markPrice:posNum(p?.mark_price),unrealizedPnLUSD:p?num(p.unrealised_pnl):null,
   marginUSD:p?posNum(p.margin):null,realizedPnLUSD:given(p?.realised_pnl)};
 }
 async #cancel(record,id){
  try{if(record.venue==='BINGX')await this.clients.BINGX.cancelOrder(record.venueSymbol,id);else{
   // Gate.io protective/target orders are price-triggered orders.
   await this.clients.GATEIO.cancelTrigger(id)}}
  catch(error){
   // BingX removes a position's stop/target orders by itself when the position goes flat, so a
   // cancel of those fails (e.g. 109400). If the order is no longer open, that is not a failure.
   if(record.venue==='BINGX'){
    const open=await this.clients.BINGX.openOrders(record.venueSymbol).catch(()=>null),raw=open?.orders??open,list=Array.isArray(raw)?raw:null;
    // Records saved before ids were kept exact may hold a rounded id (…737 stored as …700): match
    // it by numeric value and cancel with the venue's exact id.
    const same=o=>bingxOrderId(o)===String(id)||Number(bingxOrderId(o))===Number(id),match=list?.find(same);
    if(list&&!match){this.#event(record,'ORDER_ALREADY_GONE',{orderId:id,reason:error.code||error.message});return}
    const exact=match&&bingxOrderId(match);
    if(exact&&exact!==String(id)){
     try{await this.clients.BINGX.cancelOrder(record.venueSymbol,exact);this.#event(record,'CANCELLED_BY_EXACT_ID',{orderId:exact});return}
     catch(retry){this.#event(record,'CANCEL_FAILED',{orderId:exact,reason:retry.code||retry.message});return}
    }
   }
   this.#event(record,'CANCEL_FAILED',{orderId:id,reason:error.code||error.message})}
 }
}
