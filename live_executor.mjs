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
import fs from 'node:fs';
import path from 'node:path';
import {atomicWriteStore,readStore} from './persistence.mjs';
import {bingxOrders,gateOrders,liveClientId,liveQuantity,preflight} from './live_orders.mjs';

const MAX_RECORDS=300,MAX_EVENTS=40;
const pick=(data,...keys)=>{for(const k of keys)if(data?.[k]!==undefined&&data[k]!==null&&data[k]!=='')return data[k];return undefined};
const orderOf=data=>data?.order??data;
const bingxOrderId=data=>{const o=orderOf(data);const id=pick(o,'orderID','orderId');return id===undefined?null:String(id)};

export class LiveExecutor{
 constructor({config,clients={},directory,now=Date.now,log=()=>{},onChange=()=>{}}={}){
  Object.assign(this,{config,clients,now,log,onChange});
  this.file=directory?path.join(directory,'live-orders.json'):null;this.armed=false;this.busy=new Set();
  const stored=this.file&&fs.existsSync(this.file)?readStore(this.file):null;
  this.store={version:1,killSwitch:stored?.killSwitch===true,records:Array.isArray(stored?.records)?stored.records:[],skipped:[]};
 }
 #save(){this.store.records=this.store.records.slice(-MAX_RECORDS);if(this.file){fs.mkdirSync(path.dirname(this.file),{recursive:true});atomicWriteStore(this.file,{version:1,killSwitch:this.store.killSwitch,records:this.store.records})}this.onChange(this.status())}
 #event(record,type,detail={}){record.events=[...(record.events||[]),{type,at:this.now(),...detail}].slice(-MAX_EVENTS);this.log(`[LIVE ${record.venue} ${record.symbol}] ${type}`,detail.reason||'')}
 credentials(){return {BINGX:Boolean(this.clients.BINGX),GATEIO:Boolean(this.clients.GATEIO)}}
 status(){
  return {mode:this.config.mode,armed:this.armed,killSwitch:this.store.killSwitch,liveConfirmed:this.config.liveConfirmed,venues:this.config.venues,
   credentialsConfigured:this.credentials(),limits:{maxRiskUSD:this.config.maxRiskUSD,dailyMaxRiskUSD:this.config.dailyMaxRiskUSD,maxOpen:this.config.maxOpen},
   records:this.store.records.slice(-30).reverse().map(({events,...r})=>({...r,lastEvent:events?.at(-1)??null})),skipped:this.store.skipped.slice(-20).reverse()};
 }
 arm(){
  if(this.config.mode==='OFF')throw Object.assign(Error('LIVE_MODE_OFF'),{httpStatus:409});
  if(this.config.mode==='LIVE'&&!this.config.liveConfirmed)throw Object.assign(Error('LIVE_CONFIRM_MISSING'),{httpStatus:409});
  if(this.store.killSwitch)throw Object.assign(Error('KILL_SWITCH_ON'),{httpStatus:409});
  this.armed=true;this.onChange(this.status());return this.status();
 }
 disarm(){this.armed=false;this.onChange(this.status());return this.status()}
 kill(reason='MANUAL'){this.armed=false;this.store.killSwitch=true;this.store.skipped.push({at:this.now(),reason:'KILL_SWITCH:'+reason});this.#save();return this.status()}
 resetKill(){this.store.killSwitch=false;this.#save();return this.status()}

 /** Called once per newly published final signal (already venue-checked). */
 async onSignal(row,{signalKey}){
  const venue=row?.executionVenue,contract=row?.venueContract&&{...row.venueContract,symbol:row.symbol};
  const qty=contract?liveQuantity({quantity:row.targetPlan?.quantity,estimatedStopLossUSD:row.execution?.estimatedStopLossUSD,maxRiskUSD:this.config.maxRiskUSD,contract}):null;
  const check=preflight({config:this.config,armed:this.armed,killSwitch:this.store.killSwitch,credentials:this.credentials(),row,records:this.store.records,now:this.now(),qty});
  const clientOrderId=liveClientId(signalKey);
  if(this.store.records.some(r=>r.clientOrderId===clientOrderId))return {sent:false,reasons:['DUPLICATE_SIGNAL']};
  if(!check.ok){this.store.skipped=[...this.store.skipped,{at:this.now(),symbol:row?.symbol,venue,reasons:check.reasons}].slice(-50);this.onChange(this.status());return {sent:false,reasons:check.reasons}}
  if(this.busy.has(row.symbol))return {sent:false,reasons:['SYMBOL_BUSY']};
  this.busy.add(row.symbol);
  const record={clientOrderId,signalKey,venue,mode:this.config.mode,symbol:row.symbol,venueSymbol:row.venueSymbol,direction:row.direction,
   stop:row.stop,targets:[...row.targets],quantity:qty,plannedRiskUSD:qty.riskUSD,day:check.day,status:'SUBMITTING',createdAt:this.now(),
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
  // Confirm the attached stop exists; otherwise place one; otherwise close at market.
  const open=await client.openOrders(record.venueSymbol).catch(()=>null);
  const stopOrder=(open?.orders??(Array.isArray(open)?open:[])).find(o=>String(o.type).startsWith('STOP'));
  if(stopOrder){record.stopOrderId=bingxOrderId(stopOrder);this.#event(record,'STOP_CONFIRMED',{orderId:record.stopOrderId})}
  else{
   try{const s=await client.placeOrder(plan.stop(record.quantity.total));record.stopOrderId=bingxOrderId(s);this.#event(record,'STOP_PLACED',{orderId:record.stopOrderId})}
   catch(error){
    this.#event(record,'STOP_FAILED',{reason:error.code||error.message});
    try{await client.placeOrder(plan.emergencyClose(record.quantity.total));record.status='CLOSED';record.closeReason='EMERGENCY_NO_STOP';this.#event(record,'EMERGENCY_CLOSED')}
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
 }

 async #openGate(record){
  const client=this.clients.GATEIO,contract=record.venueSymbol;
  const plan=gateOrders({contract,direction:record.direction,stop:record.stop,targets:record.targets,qty:record.quantity,clientOrderId:record.clientOrderId});
  const account=await client.account();
  if(account?.in_dual_mode===true){record.status='FAILED';this.#event(record,'REJECTED',{reason:'GATEIO_DUAL_MODE_UNSUPPORTED'});return}
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
  record.status='OPEN';record.filledContracts=filled;this.#event(record,'ENTRY_FILLED',{orderId:record.entryOrderId,contracts:filled,price:entry.fill_price});
  try{const s=await client.placeTrigger(plan.stop());record.stopOrderId=String(s.id);this.#event(record,'STOP_PLACED',{orderId:record.stopOrderId})}
  catch(error){
   this.#event(record,'STOP_FAILED',{reason:error.code||error.message});
   try{await client.placeOrder(plan.emergencyClose());record.status='CLOSED';record.closeReason='EMERGENCY_NO_STOP';this.#event(record,'EMERGENCY_CLOSED')}
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
 }

 /** Compare open records with the venue: detect closed positions and move the stop to
  * the entry once TP1 (40%) has filled. New protective stop first, old one second. */
 async reconcile(){
  for(const record of this.store.records.filter(r=>r.status==='OPEN')){
   try{
    const {size,entryPrice}=await this.#position(record);
    if(size===0){
     record.status='CLOSED';record.closedAt=this.now();record.closeReason=record.closeReason||'POSITION_FLAT';
     for(const id of [record.stopOrderId,...record.targetOrderIds].filter(Boolean))await this.#cancel(record,id);
     this.#event(record,'CLOSED');continue;
    }
    const original=record.venue==='GATEIO'?(record.filledContracts??record.quantity.total):record.quantity.total;
    const lockedIn=entryPrice>0&&(record.direction==='LONG'?record.stop>=entryPrice:record.stop<=entryPrice);
    if(!record.breakevenMoved&&lockedIn&&size<=original*0.6+1e-9){record.breakevenMoved=true;this.#event(record,'BREAKEVEN_SKIPPED_STOP_ALREADY_BETTER',{stop:record.stop})}
    if(!record.breakevenMoved&&size<=original*0.6+1e-9&&entryPrice>0){
     const client=this.clients[record.venue];let placed;
     if(record.venue==='BINGX'){const plan=bingxOrders({symbol:record.venueSymbol,direction:record.direction,stop:record.stop,targets:record.targets,qty:record.quantity,clientOrderId:record.clientOrderId});
      placed=bingxOrderId(await client.placeOrder(plan.breakeven(entryPrice,size)))}
     else{const plan=gateOrders({contract:record.venueSymbol,direction:record.direction,stop:record.stop,targets:record.targets,qty:record.quantity,clientOrderId:record.clientOrderId});
      placed=String((await client.placeTrigger(plan.breakeven(entryPrice))).id)}
     const old=record.stopOrderId;record.stopOrderId=placed;record.breakevenMoved=true;record.breakevenPrice=entryPrice;record.stop=entryPrice;
     if(old)await this.#cancel(record,old);
     this.#event(record,'STOP_TO_BREAKEVEN',{price:entryPrice,orderId:placed});
    }
   }catch(error){this.#event(record,'RECONCILE_ERROR',{reason:error.code||error.message})}
  }
  this.#save();
 }
 /** Manual stop/target change on an open live position. The new stop is placed before
  * the old one is cancelled, so the position is never unprotected. A wider stop may not
  * push the position's risk above the per-trade cap. A target is replaced only after its
  * old order was cancelled, so a target can never be doubled. */
 async setLevels(signalKey,{stop,targets}){
  const record=this.store.records.find(r=>r.signalKey===signalKey&&r.status==='OPEN');
  if(!record)return {ok:true,live:false};
  if(this.busy.has(record.symbol))return {ok:false,live:true,reasons:['SYMBOL_BUSY']};
  this.busy.add(record.symbol);
  const client=this.clients[record.venue],dir=record.direction==='LONG'?1:-1,result={ok:true,live:true,stopMoved:false,targetsMoved:[],errors:[]};
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
     if(risk>this.config.maxRiskUSD*(1+1e-6))return {ok:false,live:true,reasons:['MANUAL_STOP_EXCEEDS_RISK_LIMIT'],riskUSD:risk,maxRiskUSD:this.config.maxRiskUSD};
    }
    let placed;
    try{placed=record.venue==='BINGX'?bingxOrderId(await client.placeOrder(plan.breakeven(stop,size))):String((await client.placeTrigger(plan.breakeven(stop))).id)}
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
   return {size:row?Math.abs(Number(row.positionAmt)||0):0,entryPrice:Number(row?.avgPrice)||0};
  }
  const p=await client.position(record.venueSymbol);
  return {size:Math.abs(Number(p?.size)||0),entryPrice:Number(p?.entry_price)||0};
 }
 async #cancel(record,id){
  try{if(record.venue==='BINGX')await this.clients.BINGX.cancelOrder(record.venueSymbol,id);else{
   // Gate.io protective/target orders are price-triggered orders.
   await this.clients.GATEIO.cancelTrigger(id)}}
  catch(error){this.#event(record,'CANCEL_FAILED',{orderId:id,reason:error.code||error.message})}
 }
}
