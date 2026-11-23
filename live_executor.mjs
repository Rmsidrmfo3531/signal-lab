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
import {readPositionMode,leverageSideFor,positionRow,orderOnSide,ordersOnSide,otherSideAmount} from './bingx_position_mode.mjs';
import {bingxOrders,gateOrders,liveClientId,liveQuantity,liveSplitPlan,splitParts,preflight,waitForFlat} from './live_orders.mjs';

const MAX_RECORDS=300,MAX_DELETED_KEYS=500,MAX_EVENTS=40;
/** Margin a plan ties up at the venue: the first entry plus every resting add, at the given leverage. */
const planMargin=(split,row,leverage)=>{if(!split)return 0;const cs=split.qty.unit==='CONTRACT'?Number(row?.venueContract?.contractSizeBase)||1:1;
 return (Number(split.qty.base)*Number(row?.entry)+(split.adds||[]).reduce((t,a)=>t+Number(a.qty)*cs*Number(a.price),0))/leverage};
const pick=(data,...keys)=>{for(const k of keys)if(data?.[k]!==undefined&&data[k]!==null&&data[k]!=='')return data[k];return undefined};
const orderOf=data=>data?.order??data;
const bingxOrderId=data=>{const o=orderOf(data);const id=pick(o,'orderID','orderId');return id===undefined?null:String(id)};
const num=v=>{const x=Number(v);return Number.isFinite(x)?x:null};
const given=v=>v===undefined||v===null||v===''||!Number.isFinite(Number(v))?null:Number(v);
const posNum=v=>{const x=num(v);return x>0?x:null};
// Venue units (lots / contracts) to base-asset units.
const baseUnits=(record,qty)=>record.venueContract?.quantityUnit==='CONTRACT'?qty*(Number(record.venueContract.contractSizeBase)||0):qty;
const recordMargin=record=>{
 const price=Number(record.position?.entryPrice)||Number(record.firstEntryPrice)||Number(record.plannedEntry)||0;
 const held=record.position?.size>0?Number(record.position.size):Number(record.quantity?.total)||0;
 const adds=(record.adds||[]).filter(a=>!a.filled&&!a.cancelled&&!a.skipped).reduce((sum,a)=>sum+baseUnits(record,Number(a.qty)||0)*(Number(a.price)||0),0);
 return (baseUnits(record,held)*price+adds)/(Number(record.leverage)||1);
};
// The venue lists fund-flow rows a little after a fill, and the read window ends 120 s after the
// close: the first read waits SETTLE_DELAY_MS so a late last fill (the final stop) is not missed.
const SETTLE_TRIES=4,SETTLE_WINDOW_MS=2*3600000,SETTLE_DELAY_MS=150000;

export class LiveExecutor{
 constructor({config,clients={},directory,now=Date.now,log=()=>{},onChange=()=>{},priceOf=()=>null,onEvent=null,externalHeld=null,budget=null,testnetBingxFunds=null}={}){
  // externalHeld(): symbols another ledger (copy trading) holds on the same account: not traded here.
  this.externalHeld=externalHeld;
  // budget (testnet_budget.mjs, user 2026-11-17 "한도까지 하나로"): the shared TESTNET daily loss / open risk / margin
  // budget with the reversal scalp. Only ever given on TESTNET (never LIVE); without it the rules below are unchanged.
  this.budget=config?.mode==='TESTNET'?budget:null;
  this.testnetBingxFunds=config?.mode==='TESTNET'?testnetBingxFunds:null;
  // priceOf(record): the venue's public mid price, used only to estimate an exit when the venue gives none.
  Object.assign(this,{config,clients,now,log,onChange,priceOf,onEvent});
  this.file=directory?path.join(directory,'live-orders.json'):null;this.armed=false;this.busy=new Set();this.skipSeen=new Map();this.inFlight=new Set();this.lastTry=new Map();this.closing=new Set();this.reconciling=false;
  this.entryRevision=0;this.killRevision=0;
  const stored=this.file&&fs.existsSync(this.file)?readStore(this.file):null;
  this.store={version:1,killSwitch:stored?.killSwitch===true,records:Array.isArray(stored?.records)?stored.records:[],skipped:[],
   deletedKeys:Array.isArray(stored?.deletedKeys)?stored.deletedKeys.slice(-MAX_DELETED_KEYS):[],
   // Results of deleted trades (no orders, no keys): the readiness check still counts them.
   archived:Array.isArray(stored?.archived)?stored.archived.slice(-MAX_RECORDS):[]};
  // Successful test orders are not kept (user, 2026-11-13); a failed one stays for checking.
  this.store.records=this.store.records.filter(r=>!(r.test===true&&r.status==='CLOSED'&&r.closeReason==='TEST_CLOSE'));
  // An entry that was being submitted when the server stopped may have filled without its stop:
  // unknown state, which blocks new entries until a person checks the account.
  for(const r of this.store.records)if(this.#sameMode(r)&&r.status==='SUBMITTING'){r.status='UNKNOWN';r.events=[...(r.events||[]),{type:'RESTART_WHILE_SUBMITTING',at:now()}].slice(-MAX_EVENTS)}
  // Protection recovery (BingX): an entry cut off by a stop/crash, or an open position whose stop was
  // never confirmed, is checked against the venue at the next reconcile — the stop is found or placed,
  // otherwise the position is closed and trading stops. Other venues stay UNKNOWN and stop trading.
  for(const r of this.store.records){
   if(!this.#sameMode(r))continue;
   const cut=r.status==='UNKNOWN'&&(r.events||[]).some(e=>e.type==='RESTART_WHILE_SUBMITTING')&&!r.recovery;
   const unprotected=r.status==='OPEN'&&!r.stopOrderId&&!(r.events||[]).some(e=>e.type==='PROTECTED'||e.type==='PROTECTION_RECOVERED')&&!r.test;
   if(!(cut||unprotected))continue;
   if(unprotected)r.events=[...(r.events||[]),{type:'UNPROTECTED_AFTER_RESTART',at:now()}].slice(-MAX_EVENTS);
   if(r.venue==='BINGX'){r.recovery='PENDING';continue}
   // Other venues: no automatic recovery; trading stops once, with a notice.
   r.recovery='MANUAL';this.store.killSwitch=true;try{this.onEvent?.(r,'RECOVERY_MANUAL',{})}catch{}
  }
 }
 #sameMode(r){return !r?.mode||r.mode===this.config?.mode}
 #isActiveRecord(r){return ['SUBMITTING','OPEN','UNKNOWN'].includes(r?.status)||r?.recovery==='PENDING'||r?.cleanupPending===true}
 #save(){
  if(this.store.records.length>MAX_RECORDS){
   const keep=new Set(this.store.records.filter(r=>this.#isActiveRecord(r)));
   const slots=Math.max(0,MAX_RECORDS-keep.size);
   const tail=this.store.records.filter(r=>!keep.has(r)).slice(-slots);
   for(const r of tail)keep.add(r);
   this.store.records=this.store.records.filter(r=>keep.has(r));
  }
  if(this.file){fs.mkdirSync(path.dirname(this.file),{recursive:true});atomicWriteStore(this.file,{version:1,killSwitch:this.store.killSwitch,records:this.store.records,deletedKeys:this.store.deletedKeys,archived:this.store.archived})}
  this.onChange(this.status());
 }
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
  // Entered today or closed today (KST): it counts toward today's risk / the shared testnet daily loss (review M4).
  const today=new Date(this.now()+9*3600000).toISOString().slice(0,10),closedDay=record.closedAt>0?new Date(record.closedAt+9*3600000).toISOString().slice(0,10):null;
  if(record.status==='CLOSED'&&(record.day===today||closedDay===today))return 'TODAY_COUNTS_FOR_DAILY_RISK';
  return record.status==='CLOSED'?null:'NOT_FINISHED';
 }
 deleteRecord(signalKey){
  const record=this.store.records.find(r=>r.signalKey===signalKey),block=this.deleteBlock(record);
  if(block)return {ok:false,reason:block};
  this.store.records=this.store.records.filter(r=>r!==record);
  // The signal is remembered so the same signal is never entered again after its record is gone.
  if(!record.test)this.store.deletedKeys=[...this.store.deletedKeys.filter(k=>k!==signalKey),signalKey].slice(-MAX_DELETED_KEYS);
  if(!record.test&&record.status==='CLOSED')this.store.archived=[...this.store.archived,{signalKey,symbol:record.symbol,mode:record.mode,status:'CLOSED',createdAt:record.createdAt,
   closedAt:record.closedAt,plannedRiskUSD:record.plannedRiskUSD??null,realized:record.realized?{source:record.realized.source,netUSD:record.realized.netUSD}:null,
   events:(record.events||[]).filter(e=>e.type!=='RECONCILE_ERROR').map(e=>({type:e.type,at:e.at}))}].slice(-MAX_RECORDS);
  this.#save();return {ok:true}
 }
 resetTestnetHistory(){
  const terminal=r=>r?.mode==='TESTNET'&&['CLOSED','FAILED'].includes(r.status);
  const removed=this.store.records.filter(terminal).length+this.store.archived.filter(terminal).length;
  this.store.records=this.store.records.filter(r=>!terminal(r));
  this.store.archived=this.store.archived.filter(r=>!terminal(r));
  this.#save();
  return {removed};
 }
 /** Getters for the shared TESTNET budget (testnet_budget.mjs). Read only.
  *  realizedToday: closed (non-test) trades of this mode closed that KST day, deleted (archived) ones included (review
  *  M4). A trade not yet settled counts as the estimate from its fills, else as its planned worst loss (never as 0);
  *  provisionalToday is then true, so no day stop is written from it (review M5). openRisk: planned worst loss of every
  *  active record (as the open-risk cap above). usedMargin: margin of the held size plus the resting adds. */
 budgetSource(){
  const active=()=>this.store.records.filter(r=>this.#sameMode(r)&&['SUBMITTING','OPEN','UNKNOWN'].includes(r.status)&&r.test!==true);
  const kst=t=>new Date(Number(t)+9*3600000).toISOString().slice(0,10);
  const today=day=>[...this.store.records,...this.store.archived].filter(r=>r.status==='CLOSED'&&r.test!==true&&r.mode===this.config.mode&&r.closedAt>0&&kst(r.closedAt)===day);
  const settled=r=>r.realized&&r.realized.netUSD!==null&&r.realized.netUSD!==undefined&&Number.isFinite(Number(r.realized.netUSD));
  const value=r=>{if(settled(r))return {net:Number(r.realized.netUSD),placeholder:false};
   const e=r.exits?this.#estimate(r):null;if(e?.source==='ESTIMATE'&&Number.isFinite(Number(e.netUSD)))return {net:Number(e.netUSD),placeholder:true};
   return {net:-(Number(r.plannedRiskUSD)||0),placeholder:true}};
  return {
   realizedToday:day=>today(day).reduce((t,r)=>t+value(r).net,0),
   provisionalToday:day=>today(day).some(r=>value(r).placeholder),
   openRisk:()=>active().reduce((t,r)=>t+(Number(r.plannedRiskUSD)||0),0),
   usedMargin:()=>active().reduce((t,r)=>t+recordMargin(r),0),
   unrealized:()=>active().reduce((t,r)=>t+(Number(r.position?.unrealizedPnLUSD)||0),0)};
 }
 credentials(){return {BINGX:Boolean(this.clients.BINGX),GATEIO:Boolean(this.clients.GATEIO)}}
 status(){
  return {mode:this.config.mode,armed:this.armed,killSwitch:this.store.killSwitch,liveConfirmed:this.config.liveConfirmed,venues:this.config.venues,
   credentialsConfigured:this.credentials(),limits:{riskProfile:this.config.riskProfile||null,strategyProfile:this.config.strategyProfile||null,hybridMaxAdds:this.config.hybridMaxAdds,sizing:this.config.sizing,marginUsePct:this.config.marginUsePct??25,balanceCapUSD:this.config.balanceCapUSD||null,unitPct:this.config.unitPct,maxLossPct:this.config.maxLossPct,dailyMaxLossPct:this.config.dailyMaxLossPct,maxRiskUSD:this.config.maxRiskUSD,dailyMaxRiskUSD:this.config.dailyMaxRiskUSD,maxOpen:this.config.maxOpen,maxPerDirection:this.config.maxPerDirection},
   records:this.store.records.slice(-30).reverse().map(({events,...r})=>({...r,lastEvent:events?.at(-1)??null,deletable:this.deleteBlock(r)===null})),skipped:this.store.skipped.slice(-20).reverse()};
 }
 arm(){
  // updating: the server is applying an update and will restart; trading stays off until then.
  if(this.updating)throw Object.assign(Error('UPDATING'),{httpStatus:409});
  if(this.config.mode==='OFF')throw Object.assign(Error('LIVE_MODE_OFF'),{httpStatus:409});
  if(this.testnetSignalDisabled)throw Object.assign(Error('TESTNET_SIGNAL_DISABLED'),{httpStatus:409});
  if(this.config.mode==='LIVE'&&!this.config.liveConfirmed)throw Object.assign(Error('LIVE_CONFIRM_MISSING'),{httpStatus:409});
  if(this.store.killSwitch)throw Object.assign(Error('KILL_SWITCH_ON'),{httpStatus:409});
  this.armed=true;this.lastTry.clear();this.onChange(this.status());return this.status();
 }
 disarm(){this.entryRevision++;this.armed=false;this.onChange(this.status());return this.status()}
 kill(reason='MANUAL'){this.entryRevision++;this.killRevision++;this.armed=false;this.store.killSwitch=true;this.store.skipped.push({at:this.now(),reason:'KILL_SWITCH:'+reason});this.#save();
  try{this.onEvent?.({symbol:'실매매 전체',mode:this.config.mode},'KILL_SWITCH',{reason})}catch{}
  return this.status()}
 resetKill(){this.store.killSwitch=false;this.#save();return this.status()}
 get testnetSignalDisabled(){return this.config.mode==='TESTNET'&&this.config.testnetSignalEntries===false}

 #entryBlock(revision){
  if(this.store.killSwitch)return 'KILL_SWITCH_ON';
  if(this.updating||this.paused)return 'UPDATING';
  if(!this.armed||revision!==this.entryRevision)return 'NOT_ARMED';
  return null;
 }
 #orderBlock(record,{revision,budgetEquity}){
  const blocked=this.#entryBlock(revision);
  if(blocked)return blocked;
  if(this.budget){
   if(!(record.plannedEntry>0))return 'PRICE_UNAVAILABLE';
   // The provisional record is already included in the shared budget, with the venue's confirmed leverage.
   const checked=this.budget.check({equity:budgetEquity,who:record.venue==='BINGX'?'signal':'signal-alt'});
   if(!checked.ok)return checked.reason;
  }
  if(record.balanceUSD>0&&recordMargin(record)>Math.min(record.balanceUSD*(this.config.marginUsePct??25)/100,record.freeUSD*.9)+1e-9)return 'MARGIN_SHORT';
  return null;
 }

 /** Called once per newly published final signal (already venue-checked). */
 async onSignal(row,{signalKey}){
  if(this.testnetSignalDisabled)return {sent:false,reasons:['TESTNET_SIGNAL_DISABLED']};
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
  try{return await this.#onSignal(row,{signalKey,revision:this.entryRevision})}finally{this.inFlight.delete(signalKey)}
 }
 async #onSignal(row,{signalKey,revision}){
  const venue=row?.executionVenue,contract=row?.venueContract&&{...row.venueContract,symbol:row.symbol};
  const clientOrderId=liveClientId(signalKey);
  if(this.store.records.some(r=>r.clientOrderId===clientOrderId))return {sent:false,reasons:['DUPLICATE_SIGNAL']};
  const leverage=Number(row?.leverage)>0?Math.round(Number(row.leverage)):leverageForScore(row?.score,row?.marketCap)??10;
  let qty=null,split=null,config=this.config,extra=[],budgetEquity=null,budgetMargin=null;
  try{const held=this.externalHeld?.();if(held?.has?.(row.symbol)||held?.has?.(row.venueSymbol))extra.push('SYMBOL_HELD_BY_COPY')}catch{}
  // Read the balance only when an order could actually be sent.
  const gateOpen=this.config.mode!=='OFF'&&this.armed&&!this.store.killSwitch&&this.config.venues.includes(venue)&&this.credentials()[venue]&&contract;
  if(this.config.sizing==='BALANCE'){
   if(gateOpen){
    let bal=null;try{bal=await this.#funds(venue)}catch(error){extra.push('BALANCE_UNAVAILABLE')}
    // Every position the same size (user 2026-11-13: "일정하게"): sized from the account equity, not
    // from what earlier positions left free. The whole plan (entry + every resting add) uses at most
    // marginUsePct of the equity (shrunk once to fit) and must fit in the free margin, else it is
    // skipped (MARGIN_SHORT) rather than made smaller. The open-risk cap and the position count bound
    // how many such positions can be open at once.
    let balanceUSD=bal?.equity||0,freeUSD=bal?.available??balanceUSD;
    if(balanceUSD>0&&this.config.balanceCapUSD>0){const used=Math.max(0,balanceUSD-freeUSD);balanceUSD=Math.min(balanceUSD,this.config.balanceCapUSD);freeUSD=Math.max(0,Math.min(freeUSD,balanceUSD-used))}
    if(balanceUSD>0&&!(freeUSD>0)&&!extra.length)extra.push('MARGIN_SHORT');
    if(balanceUSD>0&&freeUSD>0){
     const budget=balanceUSD*(this.config.marginUsePct??25)/100;
     split=liveSplitPlan({row,balanceUSD,leverage,config:this.config});
     const need=planMargin(split,row,leverage);
     if(split&&need>budget)split=liveSplitPlan({row,balanceUSD,leverage,sizeScale:budget/need*.98,config:this.config});
     if(split&&planMargin(split,row,leverage)>Math.min(budget,freeUSD*.9)){split=null;extra.push('MARGIN_SHORT')}
     if(split){qty=split.qty;row={...row,stop:split.stop}}
     config={...this.config,dailyMaxRiskUSD:balanceUSD*this.config.dailyMaxLossPct/100};
     // Open-risk cap: the worst losses of every open position plus this one stay within the daily
     // loss limit of the balance — positions opened on earlier days count too (margin floor safety).
     // Always this strategy's own % (a stricter profile is never loosened by the shared testnet budget, review M1).
     const openRisk=this.store.records.filter(r=>this.#sameMode(r)&&['SUBMITTING','OPEN','UNKNOWN'].includes(r.status)).reduce((n,r)=>n+(Number(r.plannedRiskUSD)||0),0);
     if(split&&openRisk+split.riskUSD>balanceUSD*this.config.dailyMaxLossPct/100)extra.push('OPEN_RISK_LIMIT');
     budgetEquity=balanceUSD;if(split)budgetMargin=planMargin(split,row,leverage);
     split&&Object.assign(split,{balanceUSD,freeUSD}); // equity (sizing and readiness drawdown), free margin at the entry
    }else if(!extra.length)extra.push('BALANCE_EMPTY');
   }
  }else qty=contract?liveQuantity({quantity:row.targetPlan?.quantity,estimatedStopLossUSD:row.execution?.estimatedStopLossUSD,maxRiskUSD:this.config.maxRiskUSD,contract}):null;
  // TESTNET shared budget on top, any sizing (review L6): today's loss of each strategy + every open stop risk of both
  // + this trade within TESTNET_DAILY_LOSS_PCT of the equity, the margin of both within the shared cap. No await
  // between this check and the record below, so the scalp sees this trade as soon as it passes.
  if(this.budget&&gateOpen&&qty&&!extra.includes('BALANCE_UNAVAILABLE')){
   if(budgetEquity===null){try{const f=await this.#funds(venue);budgetEquity=this.config.balanceCapUSD>0?Math.min(f.equity,this.config.balanceCapUSD):f.equity}catch{extra.push('BALANCE_UNAVAILABLE')}}
   if(budgetEquity!==null){
    const margin=budgetMargin??(Number(qty.base)||0)*(posNum(row.entry)||posNum(row.venueEntry)||0)/leverage;
    const b=this.budget.check({equity:budgetEquity,newRiskUSD:Number(qty.riskUSD)||0,newMarginUSD:margin,who:venue==='BINGX'?'signal':'signal-alt'});
    if(!b.ok)extra.push(b.reason);
   }
  }
  const check=preflight({config,armed:this.armed,killSwitch:this.store.killSwitch,credentials:this.credentials(),row,records:this.store.records.filter(r=>this.#sameMode(r)),now:this.now(),qty});
  if(extra.length){check.ok=false;check.reasons=[...extra,...check.reasons.filter(r=>r!=='QUANTITY_BELOW_MINIMUM_AT_LIVE_RISK')]}
  if(!check.ok){
   // The same signal is offered on every price tick while it stays valid: list a skip once per
   // signal and reason set (again after 10 minutes), not on every tick.
   const tag=signalKey+'|'+check.reasons.join(','),last=this.skipSeen.get(tag);
   if(!(last>this.now()-600000)){this.skipSeen.set(tag,this.now());if(this.skipSeen.size>500)this.skipSeen.delete(this.skipSeen.keys().next().value);
    this.store.skipped=[...this.store.skipped,{at:this.now(),symbol:row?.symbol,venue,reasons:check.reasons}].slice(-50);this.onChange(this.status())}
   return {sent:false,reasons:check.reasons}}
  const blocked=this.#entryBlock(revision);if(blocked)return {sent:false,reasons:[blocked]};
  if(this.busy.has(row.symbol))return {sent:false,reasons:['SYMBOL_BUSY']};
  // Checked again after the balance read: copy trading may have reserved the symbol meanwhile.
  try{const held=this.externalHeld?.();if(held?.has?.(row.symbol)||held?.has?.(row.venueSymbol))return {sent:false,reasons:['SYMBOL_HELD_BY_COPY']}}catch{}
  this.busy.add(row.symbol);
  // hedge: null until the account's mode is read (BingX): a record cut off before that sent nothing (#recover).
  const record={clientOrderId,signalKey,venue,mode:this.config.mode,...(venue==='BINGX'?{hedge:null}:{}),symbol:row.symbol,venueSymbol:row.venueSymbol,venueContract:row.venueContract,direction:row.direction,
   plannedEntry:posNum(row.entry)??posNum(row.venueEntry),stop:row.stop,targets:[...row.targets],quantity:qty,marginMode:'CROSS',leverage,sizing:this.config.sizing,strategyProfile:split?.strategyProfile||'CURRENT',...(row.liveRoutedFrom?{routedFrom:row.liveRoutedFrom}:{}),...(split?{balanceUSD:split.balanceUSD,freeUSD:split.freeUSD,adds:split.adds,zoneSource:split.zoneSource,peakSize:qty.total}:{}),plannedRiskUSD:qty.riskUSD,day:check.day,status:'SUBMITTING',createdAt:this.now(),
   // Signal context for the trade journal review (no effect on orders).
   signal:{pattern:row.pattern??null,score:Number.isFinite(Number(row.score))?Number(row.score):null,btcTrend:row.btcContext?.trend??null,trend4h:typeof row.trend==='string'?row.trend:null},
   entryOrderId:null,stopOrderId:null,targetOrderIds:[],breakevenMoved:false,events:[]};
  this.store.records.push(record);this.#save();
  let stoppedBeforeSend;
  try{
   const guard={revision,budgetEquity};
   stoppedBeforeSend=venue==='BINGX'?await this.#openBingX(record,guard):await this.#openGate(record,guard);
   if(stoppedBeforeSend){
    this.store.records=this.store.records.filter(r=>r!==record);
    this.store.skipped=[...this.store.skipped,{at:this.now(),symbol:row.symbol,venue,reasons:[stoppedBeforeSend]}].slice(-50);
   }
  }catch(error){
   // Anything unexpected after the entry may have filled: stop trading until checked.
   // An OPEN record already has its stop handled; only an unfinished entry is unknown.
   if(record.status==='SUBMITTING')record.status='UNKNOWN';
   this.#event(record,'ERROR',{reason:error.code||error.message});
   if(record.status==='UNKNOWN')this.kill('UNRESOLVED_'+record.venue);
  }finally{this.busy.delete(row.symbol);this.#save()}
  return stoppedBeforeSend?{sent:false,reasons:[stoppedBeforeSend]}:{sent:true,status:record.status};
 }

 async #openBingX(record,guard){
  const client=this.clients.BINGX;
  // The account's position mode (one-way or hedge, user 2026-11-17), read before every entry and kept on the
  // record: its stop, targets, adds, breakeven and closes use the mode it was opened under. Not stated or not
  // readable: nothing is sent (never guessed).
  const mode=await readPositionMode(client);
  if(!mode.ok){record.status='FAILED';this.#event(record,'REJECTED',{reason:mode.reason+':'+mode.detail});return}
  record.hedge=mode.hedge;
  // Hedge mode: a position on the other side of this coin shares the symbol's fund-flow rows, so this trade
  // is then settled from its fills, not from those rows (review 2026-11-17). Not readable: assumed present.
  if(record.hedge){try{if(otherSideAmount(await client.positions(record.venueSymbol),record.venueSymbol,record.direction)>0)record.otherSideSeen=true}catch{record.otherSideSeen=true}}
  this.#save(); // on disk before any order: a restart's recovery uses the same mode
  const plan=this.#plan(record);
  try{
   const current=await client.marginType(record.venueSymbol);
   if(current?.marginType!=='CROSSED'){await client.setMarginType(record.venueSymbol,'CROSSED');
    const check=await client.marginType(record.venueSymbol);if(check?.marginType!=='CROSSED')throw Object.assign(Error('cross not confirmed'),{code:'BINGX_CROSS_NOT_CONFIRMED'})}
   const info=await client.leverage(record.venueSymbol).catch(()=>null);
   const max=Number(record.direction==='LONG'?info?.maxLongLeverage:info?.maxShortLeverage);
   if(max>0&&record.leverage>max){this.#event(record,'LEVERAGE_CAPPED',{reason:`${record.leverage}x>${max}x`});record.leverage=Math.floor(max)}
   const set=await client.setLeverage(record.venueSymbol,leverageSideFor({hedge:record.hedge===true,direction:record.direction}),record.leverage);
   if(set?.leverage!==undefined&&Number(set.leverage)!==record.leverage)throw Object.assign(Error('leverage not confirmed'),{code:'BINGX_LEVERAGE_NOT_CONFIRMED'});
   this.#event(record,'MARGIN_SET',{reason:`CROSS ${record.leverage}x`});
  }catch(error){record.status='FAILED';this.#event(record,'REJECTED',{reason:'MARGIN_SETUP_FAILED:'+(error.code||error.message)});return}
  const beforeSend=()=>this.#orderBlock(record,guard),blocked=beforeSend();if(blocked)return blocked;
  let entry;
  const uncertainEntry=e=>['NETWORK_UNREACHABLE','TIMEOUT','ETIMEDOUT','ECONNRESET','HTTP_429'].includes(e?.code)||/^HTTP_5\d\d$/.test(e?.code||'')||['AbortError','TimeoutError'].includes(e?.name);
  try{entry=await client.placeOrder(plan.entry,{beforeSend})}
  catch(error){
   if(error.code==='ENTRY_NOT_SENT')return error.reason;
   // Outcome unknown (timeout/network) or rejected: look the client id up before anything else.
   let found=null;try{found=await client.getOrder(record.venueSymbol,{clientOrderId:record.clientOrderId})}catch{}
   if(!found||!bingxOrderId(found)){
    if(uncertainEntry(error)){record.status='UNKNOWN';this.#event(record,'ENTRY_OUTCOME_UNKNOWN',{reason:error.code||error.name});this.kill('UNRESOLVED_BINGX');return}
    record.status='FAILED';this.#event(record,'ENTRY_REJECTED',{reason:error.code||'REJECTED'});return;
   }
   entry=found;
  }
  record.entryOrderId=bingxOrderId(entry);record.status='OPEN';this.#event(record,'ENTRY_SENT',{orderId:record.entryOrderId});
  {const avg=posNum(pick(orderOf(entry),'avgPrice'));if(avg)record.firstEntryPrice=avg} // else read from the first position check
  this.#save();
  // Confirm the attached stop exists; otherwise place one; otherwise close at market.
  // A failed read is "not checked", not "no stop": it is read once more before a second stop is sent.
  const open=await client.openOrders(record.venueSymbol).catch(()=>null)??await client.openOrders(record.venueSymbol).catch(()=>null);
  const side={hedge:record.hedge===true,direction:record.direction},stopOrder=(open?.orders??(Array.isArray(open)?open:[])).find(o=>String(o.type).startsWith('STOP')&&orderOnSide(o,side));
  if(stopOrder){record.stopOrderId=bingxOrderId(stopOrder);this.#event(record,'STOP_CONFIRMED',{orderId:record.stopOrderId});this.#save()}
  else{
   try{const s=await client.placeOrder(plan.stop(record.quantity.total));record.stopOrderId=bingxOrderId(s);this.#event(record,'STOP_PLACED',{orderId:record.stopOrderId});this.#save()}
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
  this.#event(record,'PROTECTED',{targets:record.targetOrderIds.filter(Boolean).length});this.#save();
  if(record.adds?.length)await this.#placeAdds(record,guard);
 }

 async #openGate(record,guard){
  const client=this.clients.GATEIO,contract=record.venueSymbol;
  const plan=gateOrders({contract,direction:record.direction,stop:record.stop,targets:record.targets,qty:record.quantity,clientOrderId:record.clientOrderId});
  let account;
  try{account=await client.account()}
  catch(error){record.status='FAILED';this.#event(record,'REJECTED',{reason:'ACCOUNT_CHECK_FAILED:'+(error.code||error.message)});return}
  if(account?.in_dual_mode===true){record.status='FAILED';this.#event(record,'REJECTED',{reason:'GATEIO_DUAL_MODE_UNSUPPORTED'});return}
  try{
   const pos=await client.setCrossLeverage(contract,record.leverage);
   // leverage "0" = cross margin; cross_leverage_limit = the leverage in cross.
   if(Number(pos?.leverage)!==0)throw Object.assign(Error('cross not confirmed'),{code:'GATEIO_CROSS_NOT_CONFIRMED'});
   const got=Number(pos?.cross_leverage_limit);
   if(got>0&&got!==record.leverage){this.#event(record,'LEVERAGE_CAPPED',{reason:`${record.leverage}x>${got}x`});record.leverage=got}
   this.#event(record,'MARGIN_SET',{reason:`CROSS ${record.leverage}x`});
  }catch(error){record.status='FAILED';this.#event(record,'REJECTED',{reason:'MARGIN_SETUP_FAILED:'+(error.code||error.message)});return}
  const beforeSend=()=>this.#orderBlock(record,guard),blocked=beforeSend();if(blocked)return blocked;
  let entry;
  const uncertainEntry=e=>['NETWORK_UNREACHABLE','TIMEOUT','ETIMEDOUT','ECONNRESET','HTTP_429'].includes(e?.code)||/^HTTP_5\d\d$/.test(e?.code||'')||['AbortError','TimeoutError'].includes(e?.name);
  try{entry=await client.placeOrder(plan.entry,{beforeSend})}
  catch(error){
   if(error.code==='ENTRY_NOT_SENT')return error.reason;
   let found=null;try{found=await client.getOrder(plan.entry.text)}catch{}
   if(!found?.id){
    if(uncertainEntry(error)){record.status='UNKNOWN';this.#event(record,'ENTRY_OUTCOME_UNKNOWN',{reason:error.code||error.name});this.kill('UNRESOLVED_GATEIO');return}
    record.status='FAILED';this.#event(record,'ENTRY_REJECTED',{reason:error.code||'REJECTED'});return;
   }
   entry=found;
  }
  record.entryOrderId=String(entry.id);
  const filled=Math.abs(Number(entry.size))-Math.abs(Number(entry.left??0));
  if(!(filled>0)){record.status='FAILED';this.#event(record,'ENTRY_NOT_FILLED',{reason:entry.finish_as||'ioc'});return}
  record.status='OPEN';record.filledContracts=filled;if(posNum(entry.fill_price))record.firstEntryPrice=posNum(entry.fill_price);this.#event(record,'ENTRY_FILLED',{orderId:record.entryOrderId,contracts:filled,price:entry.fill_price});
  this.#save();
  try{const s=await client.placeTrigger(plan.stop());record.stopOrderId=String(s.id);this.#event(record,'STOP_PLACED',{orderId:record.stopOrderId});this.#save()}
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
  this.#event(record,'PROTECTED',{targets:record.targetOrderIds.filter(Boolean).length});this.#save();
  if(record.adds?.length){if(filled!==record.quantity.total)record.peakSize=filled;await this.#placeAdds(record,guard)}
 }

 /** Split buys: the stop must cover the whole future position (BingX: closePosition stop,
  * placed before the entry's own stop is cancelled; Gate.io's stop already closes it all),
  * then the resting limit adds. An add that cannot be placed is skipped, never retried blindly. */
 async #placeAdds(record,guard){
  const skipRemaining=(from,reason)=>{
   for(const add of record.adds.slice(from))add.skipped=true;
   this.#event(record,'ADDS_SKIPPED',{reason});this.#save();
  };
  const beforeSend=()=>this.#orderBlock(record,guard),blocked=beforeSend();
  if(blocked){skipRemaining(0,blocked);return}
  const client=this.clients[record.venue],full=record.adds.reduce((s,a)=>s+a.qty,record.quantity.total);
  if(record.venue==='BINGX'){
   const plan=this.#plan(record);
   try{const s=await client.placeOrder(plan.wholeStop(record.stop,Number(full.toFixed(12))));const old=record.stopOrderId;record.stopOrderId=bingxOrderId(s);
    if(old&&old!==record.stopOrderId)await this.#cancel(record,old);this.#event(record,'STOP_WHOLE_POSITION',{orderId:record.stopOrderId});this.#save()}
   catch(error){this.#event(record,'STOP_WHOLE_FAILED',{reason:error.code||error.message});this.#event(record,'ADDS_SKIPPED',{reason:'NO_WHOLE_POSITION_STOP'});record.adds.forEach(a=>a.skipped=true);this.#save();return}
  }
  const plan=this.#plan(record);
  for(const [i,a] of record.adds.entries()){
   const blocked=beforeSend();
   if(blocked){skipRemaining(i,blocked);break}
   const id=record.venue==='BINGX'?record.clientOrderId+'a'+String.fromCharCode(97+i):record.clientOrderId.slice(0,24)+'a'+String.fromCharCode(97+i);
   try{const o=await client.placeOrder(plan.add(a.price,a.qty,id),{beforeSend});a.orderId=record.venue==='BINGX'?bingxOrderId(o):String(o.id);this.#save()}
   catch(error){
    if(error.code==='ENTRY_NOT_SENT'){skipRemaining(i,error.reason);break}
    a.orderId=null;a.skipped=true;this.#event(record,'ADD_FAILED',{reason:`${i+1}: `+(error.code||error.message)})}
  }
  this.#event(record,'ADDS_PLACED',{reason:`${record.adds.filter(a=>a.orderId).length}/${record.adds.length}`});this.#save();
 }
 #plan(record){
  return record.venue==='BINGX'?bingxOrders({symbol:record.venueSymbol,direction:record.direction,stop:record.stop,targets:record.targets,qty:record.quantity,clientOrderId:record.clientOrderId,hedge:record.hedge===true})
   :gateOrders({contract:record.venueSymbol,direction:record.direction,stop:record.stop,targets:record.targets,qty:record.quantity,clientOrderId:record.clientOrderId});
 }
 async #cancelAdds(record,why,{verify=false}={}){
  const client=this.clients[record.venue];
  const bingx=record.venue==='BINGX';
  if(verify&&bingx&&record.adds?.length){
   const open=await client.openOrders(record.venueSymbol),orders=open?.orders??open;
   if(!Array.isArray(orders))throw Object.assign(Error('ADD_CANCEL_UNCONFIRMED'),{code:'ADD_CANCEL_UNCONFIRMED'});
   for(const [i,a] of record.adds.entries()){
    const tag=record.clientOrderId+'a'+String.fromCharCode(97+i);
    const row=orders.find(o=>String(o.clientOrderId??o.clientOrderID??'')===tag||a.orderId&&String(a.orderId)===bingxOrderId(o));
    if(row&&bingxOrderId(row)){a.orderId=bingxOrderId(row);a.filled=false;a.cancelled=false}
   }
  }
  let allDone=true;
  for(const a of record.adds||[]){if(!a.orderId||a.filled||a.cancelled)continue;
   try{if(bingx)await client.cancelOrder(record.venueSymbol,a.orderId);else await client.cancelOrder(a.orderId);a.cancelled=true}
   catch(error){
    this.#event(record,'ADD_CANCEL_FAILED',{orderId:a.orderId,reason:error.code||error.message});
    if(!verify){allDone=false;continue}
    const data=await (bingx?client.getOrder(record.venueSymbol,{orderId:a.orderId}):client.getOrder(a.orderId)).catch(()=>null);
    const status=String(orderOf(data)?.status??'').toUpperCase();
    if(['FILLED','FINISHED','CANCELED','CANCELLED','EXPIRED','REJECTED'].includes(status)){a.cancelled=true;continue}
    if(bingx){
     const open=await client.openOrders(record.venueSymbol).catch(()=>null),orders=open?.orders??open;
     if(Array.isArray(orders)&&!orders.some(o=>bingxOrderId(o)===String(a.orderId))){a.cancelled=true;continue}
    }
    throw Object.assign(Error('ADD_CANCEL_UNCONFIRMED'),{code:'ADD_CANCEL_UNCONFIRMED'});
   }
  }
  if(allDone)this.#event(record,'ADDS_CANCELLED',{reason:why});
  return allDone;
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
 /** Account equity and the margin still free (BingX availableMargin, Gate available). */
 async #funds(venue){
  if(venue==='BINGX'){
   if(this.testnetBingxFunds)return this.testnetBingxFunds();
   const data=await this.clients.BINGX.balance(),list=Array.isArray(data)?data:[data?.balance??data];
   const usdt=list.find(x=>x?.asset==='USDT')??list[0],equity=Number(usdt?.equity??usdt?.balance)||0;
   const raw=usdt?.availableMargin,free=Number(raw);
   return {equity,available:raw!==undefined&&raw!==null&&raw!==''&&Number.isFinite(free)?Math.max(0,free):equity};
  }
  const a=await this.clients.GATEIO.account(),total=Number(a?.total)||0,free=Number(a?.available);
  return {equity:total||free||0,available:Number.isFinite(free)?Math.max(0,free):total};
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
    // Hedge mode: only this position's side (a stop of a manual position on the other side is not ours).
    const mine=record.hedge===true?ordersOnSide(list,{hedge:true,direction:record.direction}):list;
    if(mine.length)return fail('TEST_ORDERS_LEFT',`${mine.length} open`);
   }
   record.status='CLOSED';record.closedAt=this.now();record.closeReason='TEST_CLOSE';this.#event(record,'TEST_CLOSED');
  }catch(error){fail('TEST_CLOSE_FAILED',error.code||error.message)}
  finally{this.busy.delete(record.symbol)}
 }
 /** User-initiated exit for one tracked testnet signal position. Entries may be disarmed. */
 async closeTestnetPosition(key,{sleep}={}){
  const refuse=(error,status=409)=>({ok:false,error,status});
  if(this.config.mode!=='TESTNET')return refuse('TESTNET_CLOSE_ONLY');
  if(this.updating||this.paused)return refuse('UPDATING');
  const record=this.store.records.find(r=>r.signalKey===key&&r.mode==='TESTNET'&&r.status==='OPEN'&&!r.test);
  if(!record)return refuse('POSITION_NOT_FOUND',404);
  const client=this.clients[record.venue];
  if(client?.mode!=='TESTNET')return refuse('TESTNET_CLOSE_ONLY');
  if(this.busy.has(record.symbol)||this.closing.has(key)||record.recovery==='PENDING')return refuse('SYMBOL_BUSY');
  this.busy.add(record.symbol);
  try{
   if(record.venue==='BINGX'){
    const mode=await readPositionMode(client);
    if(!mode.ok)return refuse(mode.reason,502);
    if(mode.hedge!==(record.hedge===true))return refuse('POSITION_MODE_CHANGED');
   }
   if(record.adds?.length)await this.#cancelAdds(record,'MANUAL',{verify:true});
   const read=()=>this.#position(record,{strict:true});
   const held=await read();
   if(held.size>0&&held.side&&held.side!==record.direction)return refuse('POSITION_SIDE_MISMATCH');
   let flat=held;
   if(held.size>0){
    const order=record.venue==='BINGX'?this.#plan(record).emergencyClose(held.size):
     {contract:record.venueSymbol,size:record.direction==='LONG'?-held.size:held.size,price:'0',tif:'ioc',reduce_only:true};
    let failure;
    try{await client.placeOrder(order)}catch(error){failure=error}
    flat=await waitForFlat(read,sleep);
    if(!flat)return refuse('CLOSE_UNCONFIRMED',502);
    if(!failure)record.closeReason='MANUAL';
   }
   if(held.otherSide>0)record.otherSideSeen=true;
   this.#observe(record,flat);
   let cleanupPending=false;
   for(const id of [record.stopOrderId,...(record.targetOrderIds||[])].filter(Boolean))if(await this.#cancel(record,id)===false)cleanupPending=true;
   record.status='CLOSED';record.closedAt=this.now();record.closeReason??='POSITION_FLAT';this.#event(record,'CLOSED');
   return {ok:true,alreadyFlat:held.size===0,cleanupPending};
  }catch(error){return refuse(error.code||'CLOSE_FAILED',502)}
  finally{this.busy.delete(record.symbol);this.#save()}
 }
 async reconcile(){
  // paused: the server is about to restart (update); no new venue work may start.
  // Never touch venue clients when mode is OFF or when LIVE is not explicitly confirmed.
  if(this.reconciling||this.paused||this.config.mode==='OFF'||(this.config.mode==='LIVE'&&!this.config.liveConfirmed))return;
  this.reconciling=true;
  try{
   for(const record of this.store.records.filter(r=>this.#sameMode(r)&&r.recovery==='PENDING'&&!this.busy.has(r.symbol))){
    this.busy.add(record.symbol);
    try{await this.#recover(record)}catch(error){
     // Retried at every check; recorded (and notified) only the first time.
     record.recoveryErrors=(record.recoveryErrors||0)+1;if(record.recoveryErrors===1)this.#event(record,'RECOVERY_ERROR',{reason:error.code||error.message})}
    finally{this.busy.delete(record.symbol);this.#save()}
   }
   await this.#reconcileOpen();
  }finally{this.reconciling=false}
 }
 /** After a restart cut an entry short: find or place the stop for whatever the venue holds. */
 async #recover(record){
  // Cut off before the position mode was read: nothing was sent for it (the venue is not touched, so a
  // manual position on the coin is never taken as this trade's).
  if(record.hedge===null&&record.status==='UNKNOWN'&&!record.entryOrderId){record.status='FAILED';record.closeReason='ENTRY_NOT_SENT_AFTER_RESTART';record.recovery='DONE';this.#event(record,'RECOVERY_NO_ORDER_SENT');return}
  const client=this.clients.BINGX,pos=await this.#position(record);
  const open=await client.openOrders(record.venueSymbol),list=open?.orders??(Array.isArray(open)?open:[]);
  // Add orders of a cut-off entry were never tracked (no order ids): take them off the book.
  for(const o of list){
   const cid=String(o.clientOrderId??o.clientOrderID??'');
   if(cid.startsWith(record.clientOrderId+'a')){await client.cancelOrder(record.venueSymbol,bingxOrderId(o));this.#event(record,'ADDS_CANCELLED',{reason:'RECOVERY'})}
  }
  for(const a of record.adds||[])if(!a.filled)a.cancelled=true;
  if(!(pos.size>0)){
   if(record.status==='UNKNOWN'){
    // Filled and already stopped out, or never filled: the entry order tells which.
    // A failed lookup is retried at the next check (never guessed as 'not filled').
    const found=await client.getOrder(record.venueSymbol,{clientOrderId:record.clientOrderId}).catch(e=>{if(e?.code==='VENUE_ERROR_80016'||/not exist/i.test(e?.message||''))return null;throw e}),o=orderOf(found);
    const filled=Number(pick(o,'executedQty'))>0||String(pick(o,'status')).toUpperCase()==='FILLED';
    if(filled){record.status='CLOSED';record.closedAt=this.now();record.closeReason='NO_POSITION_AFTER_RESTART'}
    else{record.status='FAILED';record.closeReason='ENTRY_NOT_FILLED_AFTER_RESTART'}
   }
   record.recovery='DONE';this.#event(record,'RECOVERY_NO_POSITION');return;
  }
  // One-way mode: a position on the other side is not this trade's; leave it and stop trading.
  if(pos.side&&pos.side!==record.direction){record.recovery='FAILED';this.#event(record,'RECOVERY_ERROR',{reason:'POSITION_SIDE_'+pos.side});this.kill('RECOVERY_SIDE_MISMATCH');return}
  const plan=this.#plan(record),stop=list.find(o=>String(o.type).startsWith('STOP')&&orderOnSide(o,{hedge:record.hedge===true,direction:record.direction}));
  record.position={...(record.position||{}),size:pos.size,entryPrice:posNum(pos.entryPrice),at:this.now()};
  if(!record.firstEntryPrice&&posNum(pos.entryPrice))record.firstEntryPrice=posNum(pos.entryPrice);
  if(stop){record.stopOrderId=bingxOrderId(stop);record.status='OPEN';record.recovery='DONE';this.#event(record,'PROTECTION_RECOVERED',{orderId:record.stopOrderId,reason:'STOP_FOUND'});return}
  try{
   const s=await client.placeOrder(plan.stop(pos.size));record.stopOrderId=bingxOrderId(s);record.status='OPEN';record.recovery='DONE';
   this.#event(record,'PROTECTION_RECOVERED',{orderId:record.stopOrderId,reason:'STOP_PLACED'});
  }catch(error){
   this.#event(record,'STOP_FAILED',{reason:error.code||error.message});record.recovery='FAILED';
   try{await client.placeOrder(plan.emergencyClose(pos.size));record.status='CLOSED';record.closedAt=this.now();record.closeReason='EMERGENCY_NO_STOP';this.#event(record,'EMERGENCY_CLOSED')}
   catch(e){record.status='UNKNOWN';this.#event(record,'EMERGENCY_CLOSE_FAILED',{reason:e.code||e.message})}
   this.kill('RECOVERY_NO_STOP');
  }
 }
 /** True while nothing is being ordered, cancelled or checked (safe moment to restart). */
 idle(){return !this.reconciling&&!this.inFlight.size&&!this.busy.size&&!this.closing.size&&!this.store.records.some(r=>this.#sameMode(r)&&r.status==='SUBMITTING')}
 async #reconcileOpen(){
  this.posCache=null; // one fresh all-symbols read per check
  let limited=false;
  // Each round starts one position further on, so a round cut short by a 429 does not always
  // leave the same positions unchecked.
  const open=this.store.records.filter(r=>this.#sameMode(r)&&r.status==='OPEN'&&!this.busy.has(r.symbol)&&!this.closing.has(r.signalKey)),start=open.length?(this.roundStart=((this.roundStart||0)+1)%open.length):0;
  for(const record of [...open.slice(start),...open.slice(0,start)]){
   if(record.status!=='OPEN'||this.busy.has(record.symbol))continue;
   this.busy.add(record.symbol);
   try{
    const pos=await this.#position(record,{cached:true}),{size,entryPrice}=pos;
    const priorSize=record.position?.size;
    if(pos.otherSide>0&&!record.otherSideSeen){record.otherSideSeen=true;this.#event(record,'OTHER_SIDE_SEEN',{reason:`${pos.otherSide}`})}
    this.#observe(record,pos);
    if(record.mode==='TESTNET'&&size>0&&priorSize-size>Math.max(1e-12,priorSize*1e-9))this.#event(record,'PARTIAL_EXIT',{qty:priorSize-size,left:size});
    if(size===0){
     record.status='CLOSED';record.closedAt=this.now();record.closeReason=record.closeReason||'POSITION_FLAT';
     this.closing.add(record.signalKey);try{
     let cleanupPending=false;
     // Resting adds first: an add left behind would open a new position on its own.
     if(record.adds?.length){
      const addsDone=await this.#cancelAdds(record,'POSITION_FLAT');
      if(!addsDone)cleanupPending=true;
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
     for(const id of [record.stopOrderId,...(record.targetOrderIds||[])].filter(Boolean)){
      if(await this.#cancel(record,id)===false)cleanupPending=true;
     }
     if(cleanupPending)record.cleanupPending=true;else delete record.cleanupPending;
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
     const tick=record.venueContract?.tickSize,bePrice=posNum(tick)?Number(roundDecimalToStep(entryPrice,String(tick),record.direction==='LONG'?'UP':'DOWN')):entryPrice;
     const client=this.clients[record.venue];let placed;
     if(record.venue==='BINGX'){const plan=bingxOrders({symbol:record.venueSymbol,direction:record.direction,stop:record.stop,targets:record.targets,qty:record.quantity,clientOrderId:record.clientOrderId,hedge:record.hedge===true});
      placed=bingxOrderId(await client.placeOrder(plan.breakeven(bePrice,size)))}
     else{const plan=gateOrders({contract:record.venueSymbol,direction:record.direction,stop:record.stop,targets:record.targets,qty:record.quantity,clientOrderId:record.clientOrderId});
      placed=String((await client.placeTrigger(plan.breakeven(bePrice))).id)}
     const old=record.stopOrderId;record.stopOrderId=placed;record.breakevenMoved=true;record.breakevenPrice=bePrice;record.stop=bePrice;
     if(old)await this.#cancel(record,old);
     this.#event(record,'STOP_TO_BREAKEVEN',{price:bePrice,orderId:placed});
    }
    // A retired testnet signal position keeps its exits but cannot increase exposure.
    const retired=record.mode==='TESTNET'&&this.testnetSignalDisabled;
    if((retired||record.breakevenMoved)&&record.adds?.some(a=>a.orderId&&!a.filled&&!a.cancelled))
     await this.#cancelAdds(record,retired?'TESTNET_SIGNAL_DISABLED':'TP1_FILLED');
   }catch(error){
    // A rate-limit answer is a pause, not a problem with this trade: logged, not recorded on it.
    // The rest of this round is skipped (every call would wait out the same pause). If the venue
    // keeps refusing for 5 minutes, it is recorded once so a stalled check is visible.
    if(error.code==='HTTP_429'){this.posCache=null;this.rateLimitedSince??=this.now();
     this.log(`[LIVE ${record.venue} ${record.symbol}] rate limited, next check later`);
     if(!this.rateLimitNoted&&this.now()-this.rateLimitedSince>=5*60_000){this.rateLimitNoted=true;this.#event(record,'RECONCILE_ERROR',{reason:'HTTP_429 for 5+ min'})}
     limited=true;break}
    else this.#event(record,'RECONCILE_ERROR',{reason:error.code||error.message})}
   finally{this.busy.delete(record.symbol)}
  }
  if(!limited){
   for(const record of this.store.records.filter(r=>this.#sameMode(r)&&r.status==='CLOSED'&&r.cleanupPending===true&&!this.busy.has(r.symbol))){
    this.busy.add(record.symbol);
    try{
     let done=true;
     if(record.adds?.some(a=>a.orderId&&!a.filled&&!a.cancelled)){
      if(!(await this.#cancelAdds(record,'POSITION_FLAT')))done=false;
     }
     if(done)delete record.cleanupPending;
    }catch{}
    finally{this.busy.delete(record.symbol)}
   }
  }
  if(!limited){this.rateLimitedSince=null;this.rateLimitNoted=false}
  // Realized result of closed trades (read only): the venue's own settlement, else an estimate.
  if(!limited)for(const record of this.store.records.filter(r=>this.#sameMode(r)&&r.status==='CLOSED'&&!r.test&&!r.realized&&(r.settleAttempts||0)<SETTLE_TRIES&&r.closedAt>0&&this.now()-r.closedAt>=SETTLE_DELAY_MS&&this.now()-r.closedAt<SETTLE_WINDOW_MS)){
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
  // A hedge trade that saw a position on the other side of its coin: the symbol's fund-flow rows mix both
  // positions, so the estimate from its own exits is used (review 2026-11-17).
  if(record.otherSideSeen){record.realized={...this.#estimate(record),reason:'HEDGE_OTHER_SIDE'};this.#event(record,'SETTLED',{reason:'estimate (other side held) '+record.realized?.netUSD});return}
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
  this.#event(record,'SETTLED',{reason:'estimate '+record.realized?.netUSD});
 }
 #estimate(record){
  const avg=posNum(record.position?.entryPrice)??posNum(record.firstEntryPrice),exits=record.exits||[],at=this.now();
  if(!avg||!exits.length||exits.some(e=>!posNum(e.price)))return {source:'UNKNOWN',at};
  const dir=record.direction==='LONG'?1:-1,rate=venueCosts(record.venueContract).takerRate,r=x=>Math.round(x*1e4)/1e4;
  let pnl=0,fee=0;for(const e of exits){const q=baseUnits(record,e.qty);pnl+=dir*(e.price-avg)*q;fee+=(avg+e.price)*q*rate}
  return {source:'ESTIMATE',pnlUSD:r(pnl),feeUSD:r(-fee),fundingUSD:null,netUSD:r(pnl-fee),takerRate:rate,at};
 }
 /** Account equity for the status screen (read only). */
 /** Equity and free margin, for the copy-trading ledger. */
 accountFunds(venue){if(!this.clients[venue])return Promise.reject(Object.assign(Error('CREDENTIALS_MISSING'),{code:'CREDENTIALS_MISSING'}));return this.#funds(venue)}
 accountBalance(venue){if(!this.clients[venue])return Promise.reject(Object.assign(Error('CREDENTIALS_MISSING'),{code:'CREDENTIALS_MISSING'}));return this.#balance(venue)}
 /** Manual stop/target change on an open live position. The new stop is placed before
  * the old one is cancelled, so the position is never unprotected. A wider stop may not
  * push the position's risk above the per-trade cap. A target is replaced only after its
  * old order was cancelled, so a target can never be doubled. */
 async setLevels(signalKey,{stop,targets}){
  if(this.updating||this.paused)return {ok:false,live:true,reasons:['UPDATING']};
  const record=this.store.records.find(r=>this.#sameMode(r)&&r.signalKey===signalKey&&r.status==='OPEN');
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
   const plan=record.venue==='BINGX'?bingxOrders({symbol:record.venueSymbol,direction:record.direction,stop,targets,qty,clientOrderId:record.clientOrderId,hedge:record.hedge===true})
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
 async #position(record,{cached=false,strict=false}={}){
  const client=this.clients[record.venue];
  if(record.venue==='BINGX'){
   // The routine check reads all symbols in one call (rate limit); every other caller (orders, closes,
   // recovery) reads its own symbol fresh.
   let raw;
   if(cached){if(!this.posCache)this.posCache={at:this.now(),list:await client.positions()};raw=this.posCache.list}
   else raw=await client.positions(record.venueSymbol);
   const list=Array.isArray(raw)?raw:Array.isArray(raw?.positions)?raw.positions:Array.isArray(raw?.data)?raw.data:null;
   if(!Array.isArray(list))throw Object.assign(Error('POSITION_CHECK_FAILED'),{code:'POSITION_CHECK_FAILED'});
   // Hedge mode: the row of this record's own side (an opposite-side row is another position).
   const row=positionRow(list,record.venueSymbol,{hedge:record.hedge===true,direction:record.direction});
   if(row&&given(row.positionAmt)===null)throw Object.assign(Error('POSITION_CHECK_FAILED'),{code:'POSITION_CHECK_FAILED'});
   return {size:row?Math.abs(Number(row.positionAmt)||0):0,entryPrice:Number(row?.avgPrice)||0,markPrice:posNum(row?.markPrice),unrealizedPnLUSD:row?num(row.unrealizedProfit):null,
    marginUSD:row?posNum(row.initialMargin??row.margin):null,realizedPnLUSD:given(row?.realisedProfit??row?.realizedProfit),
    // Side only when the venue states it (positionSide LONG/SHORT or a signed negative amount); an unsigned amount is not guessed.
    side:row?(['LONG','SHORT'].includes(row.positionSide)?row.positionSide:Number(row.positionAmt)<0?'SHORT':null):null,
    otherSide:record.hedge===true?otherSideAmount(list,record.venueSymbol,record.direction):0};
  }
  const p=await client.position(record.venueSymbol);
  if(strict&&given(p?.size)===null)throw Object.assign(Error('POSITION_CHECK_FAILED'),{code:'POSITION_CHECK_FAILED'});
  return {size:Math.abs(Number(p?.size)||0),...(strict?{side:Number(p.size)<0?'SHORT':'LONG'}:{}),entryPrice:Number(p?.entry_price)||0,markPrice:posNum(p?.mark_price),unrealizedPnLUSD:p?num(p.unrealised_pnl):null,
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
     catch(retry){this.#event(record,'CANCEL_FAILED',{orderId:exact,reason:retry.code||retry.message});return false}
    }
   }
   this.#event(record,'CANCEL_FAILED',{orderId:id,reason:error.code||error.message});return false}
 }
}
