/** Mock-only order-state contract. No transport, credentials, API endpoint,
 * persistence, cancellation call or activation switch exists in this module.
 * Intents are descriptions for tests; sendAllowed is always false. */
const clone=value=>structuredClone(value);
const finite=value=>typeof value==='number'&&Number.isFinite(value);
const positive=value=>finite(value)&&value>0;
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const key=value=>typeof value==='string'&&/^[A-Za-z0-9_.:-]{1,160}$/.test(value);
const near=(a,b)=>finite(a)&&finite(b)&&Math.abs(a-b)<=Math.max(1e-10,Math.abs(a)*Number.EPSILON*32);
const proof=value=>value?.status==='MOCK_VALIDATED'&&value.dataSource==='SYNTHETIC_TEST';
const FRACTIONS={TP1:.4,TP2:.35,TP3:.25};
const defaultLimits=Object.freeze({maxPositions:2,maxTotalNotionalUSDT:1500,maxDailyLossUSDT:18,maxRiskUSDT:6,maxLeverage:3});
const plainState=()=>({schemaVersion:1,dataSource:'SYNTHETIC_TEST',entries:{},seenFills:{},intents:[],sequence:0,
 risk:{killSwitch:false,dailyLossUSDT:0,storageHealthy:true,positionSynchronized:true}});
const exactKeys=(value,allowed)=>object(value)&&Object.keys(value).every(name=>allowed.includes(name));
const entryKeys=['reference','instrumentName','direction','requestedQuantity','expectedEntry','originalStop','targets','notionalUSDT','plannedRiskUSDT','leverage',
 'entryOrderId','entryStatus','entrySettled','filledQuantity','entryNotional','averageEntry','quantityRemaining','exitFilled','exitOrders','stopOrders',
 'moveStopToBreakeven','breakevenMode','costCoveredPrice','protection','breakeven','reconciliationRequired','closed','lastCode'];
function validateRestoredState(state){
 if(!exactKeys(state,['schemaVersion','dataSource','entries','seenFills','intents','sequence','risk'])||state.schemaVersion!==1||
  state.dataSource!=='SYNTHETIC_TEST'||!object(state.entries)||!object(state.seenFills)||!Array.isArray(state.intents)||
  !Number.isSafeInteger(state.sequence)||state.sequence<0||!exactKeys(state.risk,['killSwitch','dailyLossUSDT','storageHealthy','positionSynchronized'])||
  typeof state.risk.killSwitch!=='boolean'||typeof state.risk.storageHealthy!=='boolean'||typeof state.risk.positionSynchronized!=='boolean'||
  !finite(state.risk.dailyLossUSDT)||state.risk.dailyLossUSDT<0)throw Error('INVALID_MOCK_SAFETY_STATE');
 for(const [reference,p] of Object.entries(state.entries)){
  if(!key(reference)||!exactKeys(p,entryKeys)||p.reference!==reference||!['LONG','SHORT'].includes(p.direction)||
   !/^[A-Z0-9]{2,24}-USDT-PERPETUAL$/.test(p.instrumentName)||![p.requestedQuantity,p.expectedEntry,p.originalStop,p.notionalUSDT,p.plannedRiskUSDT,p.leverage].every(positive)||
   !['SUBMITTED','ACKNOWLEDGED','PARTIAL','FILLED','CANCELLED','NOT_FOUND','UNKNOWN'].includes(p.entryStatus)||
   ![p.filledQuantity,p.entryNotional,p.quantityRemaining].every(x=>finite(x)&&x>=0)||p.filledQuantity>p.requestedQuantity+1e-10||
   p.quantityRemaining>p.filledQuantity+1e-10||p.filledQuantity>0&&!positive(p.averageEntry)||
   !exactKeys(p.exitFilled,['TP1','TP2','TP3','STOP','CLOSE'])||!['TP1','TP2','TP3','STOP','CLOSE'].every(role=>finite(p.exitFilled[role])&&p.exitFilled[role]>=0)||!object(p.exitOrders)||!object(p.stopOrders)||
   !exactKeys(p.breakeven,['status','requestId','newOrderId','oldOrderId','price','moved'])||typeof p.breakeven.moved!=='boolean'||
   !['WAITING_TP1','REPLACEMENT_PENDING','AWAITING_EXCHANGE_VERIFICATION','UNKNOWN_KEEP_OLD','FAILED_KEEP_OLD','VERIFIED','CLOSED_NO_MOVE'].includes(p.breakeven.status)||
   typeof p.closed!=='boolean'||typeof p.reconciliationRequired!=='boolean'||typeof p.entrySettled!=='boolean'||
   typeof p.moveStopToBreakeven!=='boolean'||!Array.isArray(p.targets)||p.targets.length!==3)throw Error('INVALID_MOCK_SAFETY_STATE');
  if(p.targets.some((target,i)=>!exactKeys(target,['role','price','fraction'])||target.role!==['TP1','TP2','TP3'][i]||!positive(target.price)||
   target.fraction!==[.4,.35,.25][i]))throw Error('INVALID_MOCK_SAFETY_STATE');
  for(const [id,order]of Object.entries(p.exitOrders))if(!key(id)||!exactKeys(order,['role','quantity','reduceOnly','cancelled'])||
   !['TP1','TP2','TP3','CLOSE'].includes(order.role)||!positive(order.quantity)||order.reduceOnly!==true||typeof order.cancelled!=='boolean')throw Error('INVALID_MOCK_SAFETY_STATE');
  for(const [id,order]of Object.entries(p.stopOrders))if(!key(id)||!exactKeys(order,['price','quantity','reduceOnly','cancelled'])||
   !positive(order.price)||!positive(order.quantity)||order.reduceOnly!==true||typeof order.cancelled!=='boolean')throw Error('INVALID_MOCK_SAFETY_STATE');
  if(p.protection!==null&&(!exactKeys(p.protection,['orderId','price','quantity'])||!key(p.protection.orderId)||!positive(p.protection.price)||
   !positive(p.protection.quantity)||!p.stopOrders[p.protection.orderId]||p.stopOrders[p.protection.orderId].cancelled))throw Error('INVALID_MOCK_SAFETY_STATE');
 }
 for(const [id,fill]of Object.entries(state.seenFills))if(!key(id)||!exactKeys(fill,['reference','role','quantity','price'])||
  !key(fill.reference)||!positive(fill.quantity)||!positive(fill.price)||!['ENTRY','TP1','TP2','TP3','STOP','CLOSE'].includes(fill.role))throw Error('INVALID_MOCK_SAFETY_STATE');
 const intentIds=new Set();
 for(const intent of state.intents){
  if(!exactKeys(intent,['id','reference','action','mode','sendAllowed','side','quantity','price','requiresAtomicProtection','oldOrderId','reduceOnly','replaceMode',
   'requiresExchangeRequery','orderIds','pendingProtectionRequestId','requiresReconciliation','newProtectionOrderId'])||intent.mode!=='MOCK_ONLY'||intent.sendAllowed!==false||
   !/^mock:\d+$/.test(intent.id)||Number(intent.id.slice(5))>state.sequence||!key(intent.reference)||intentIds.has(intent.id))throw Error('INVALID_MOCK_SAFETY_STATE');
  intentIds.add(intent.id);
 }
 for(const p of Object.values(state.entries)){
  const fills=Object.values(state.seenFills).filter(fill=>fill.reference===p.reference),entries=fills.filter(fill=>fill.role==='ENTRY'),
   entryQty=entries.reduce((sum,fill)=>sum+fill.quantity,0),entryNotional=entries.reduce((sum,fill)=>sum+fill.quantity*fill.price,0),
   exitQty=fills.filter(fill=>fill.role!=='ENTRY').reduce((sum,fill)=>sum+fill.quantity,0);
  if(!near(entryQty,p.filledQuantity)||!near(entryNotional,p.entryNotional)||!near(Math.max(0,entryQty-exitQty),p.quantityRemaining)||
   entryQty>0&&!near(entryNotional/entryQty,p.averageEntry)||p.closed&&p.quantityRemaining>1e-10||
   ['TP1','TP2','TP3','STOP','CLOSE'].some(role=>!near(fills.filter(fill=>fill.role===role).reduce((sum,fill)=>sum+fill.quantity,0),p.exitFilled[role])))
   throw Error('INCONSISTENT_MOCK_FILL_LEDGER');
 }
 return clone(state);
}

export class MockOrangeXOrderSafety{
 #state;#capabilities;#limits;
 constructor({dataSource='SYNTHETIC_TEST',state,capabilities={},limits={}}={}){
  if(dataSource!=='SYNTHETIC_TEST')throw Error('MOCK_CONTEXT_REQUIRED');
  this.#state=state===undefined?plainState():validateRestoredState(state);this.#capabilities=clone(capabilities);this.#limits={...defaultLimits,...limits};
  if(!Object.values(this.#limits).every(positive)||!Number.isInteger(this.#limits.maxPositions))throw Error('INVALID_MOCK_LIMITS');
 }
 #deny(code,p){if(p)p.lastCode=code;return {accepted:false,code,mode:'MOCK_ONLY',sendAllowed:false}}
 #intent(action,p,details={}){
  const id=`mock:${++this.#state.sequence}`;
  this.#state.intents.push({id,reference:p.reference,action,mode:'MOCK_ONLY',sendAllowed:false,...details});return id;
 }
 #entry(reference){return key(reference)?this.#state.entries[reference]:null}
 #blockers(){
  const reasons=[];
  for(const name of ['protectiveStop','safeStopReplace','reduceOnly'])if(!proof(this.#capabilities[name]))reasons.push('UNVERIFIED_'+name.toUpperCase());
  if(!['REGISTER_BEFORE_CANCEL','ATOMIC_MODIFY'].includes(this.#capabilities.safeStopReplace?.mode))reasons.push('SAFE_REPLACEMENT_MODE_UNVERIFIED');
  const risk=this.#state.risk;
  if(risk.killSwitch)reasons.push('KILL_SWITCH');if(!risk.storageHealthy)reasons.push('STORAGE_UNCERTAIN');
  if(!risk.positionSynchronized)reasons.push('POSITION_MISMATCH');
  if(risk.dailyLossUSDT>=this.#limits.maxDailyLossUSDT)reasons.push('DAILY_LOSS_LIMIT');
  for(const p of Object.values(this.#state.entries)){
   if(p.reconciliationRequired||p.entryStatus==='UNKNOWN')reasons.push('ORDER_STATE_UNKNOWN');
   if(p.filledQuantity>0&&!p.closed&&(!p.protection||p.protection.quantity+1e-10<p.quantityRemaining))reasons.push('PROTECTION_UNVERIFIED');
  }
  return [...new Set(reasons)];
 }
 submit(preview,{leverage=1,moveStopToBreakeven=true,breakevenMode='ENTRY',costCoveredPrice=null,costProof}={}){
  const intent=preview?.intent,reference=intent?.clientReference,reasons=this.#blockers();
  if(reasons.length)return this.#deny(reasons[0]);
  if(this.#entry(reference))return this.#deny('DUPLICATE_SIGNAL');
  if(preview?.previewOnly!==true||preview.mode!=='READ_ONLY'||preview.transportAllowed!==false||preview.liveOrdersEnabled!==false||
   !key(reference)||!/^[A-Z0-9]{2,24}-USDT-PERPETUAL$/.test(preview.instrumentName)||!['BUY','SELL'].includes(intent?.side)||
   ![intent?.amount,intent?.limitPrice,intent?.stop,preview.notionalUSDT,preview.plannedRiskUSDT,leverage].every(positive)||
   !Array.isArray(intent.targets)||intent.targets.length!==3||!['ENTRY','COST_COVERED'].includes(breakevenMode))return this.#deny('INVALID_MOCK_ENTRY_PLAN');
  const direction=intent.side==='BUY'?'LONG':'SHORT',sign=direction==='LONG'?1:-1,quantity=intent.amount;
  if(sign*(intent.limitPrice-intent.stop)<=0||intent.targets.some((part,i)=>!positive(part.price)||!positive(part.quantity)||
   !near(part.quantity,quantity*[.4,.35,.25][i])||sign*(part.price-(i?intent.targets[i-1].price:intent.limitPrice))<=0))return this.#deny('INVALID_MOCK_TARGETS');
  if(breakevenMode==='COST_COVERED'&&(!proof(costProof)||!positive(costCoveredPrice)||sign*(costCoveredPrice-intent.limitPrice)<0))return this.#deny('COST_RECOVERY_UNVERIFIED');
  const active=Object.values(this.#state.entries).filter(p=>!p.closed&&!['NOT_FOUND','CANCELLED'].includes(p.entryStatus)||!p.closed&&p.quantityRemaining>0);
  if(active.length>=this.#limits.maxPositions)return this.#deny('POSITION_LIMIT');
  if(active.reduce((sum,p)=>sum+p.notionalUSDT,0)+preview.notionalUSDT>this.#limits.maxTotalNotionalUSDT)return this.#deny('TOTAL_EXPOSURE_LIMIT');
  if(preview.plannedRiskUSDT>this.#limits.maxRiskUSDT||leverage>this.#limits.maxLeverage)return this.#deny('RISK_OR_LEVERAGE_LIMIT');
  const p={reference,instrumentName:preview.instrumentName,direction,requestedQuantity:quantity,expectedEntry:intent.limitPrice,
   originalStop:intent.stop,targets:intent.targets.map((part,i)=>({role:['TP1','TP2','TP3'][i],price:part.price,fraction:[.4,.35,.25][i]})),
   notionalUSDT:preview.notionalUSDT,plannedRiskUSDT:preview.plannedRiskUSDT,leverage,entryOrderId:null,entryStatus:'SUBMITTED',entrySettled:false,
   filledQuantity:0,entryNotional:0,averageEntry:null,quantityRemaining:0,exitFilled:{TP1:0,TP2:0,TP3:0,STOP:0,CLOSE:0},exitOrders:{},stopOrders:{},
   moveStopToBreakeven:moveStopToBreakeven===true,breakevenMode,costCoveredPrice:breakevenMode==='COST_COVERED'?costCoveredPrice:null,
   protection:null,breakeven:{status:'WAITING_TP1',requestId:null,newOrderId:null,oldOrderId:null,price:null,moved:false},reconciliationRequired:false,closed:false,lastCode:null};
  this.#state.entries[reference]=p;this.#intent('ENTRY_PREVIEW',p,{side:intent.side,quantity,price:intent.limitPrice,requiresAtomicProtection:true});
  return {accepted:true,code:'MOCK_ENTRY_INTENT_ONLY',reference,mode:'MOCK_ONLY',sendAllowed:false};
 }
 acknowledgeEntry({reference,orderId}={}){
  const p=this.#entry(reference);if(!p||!key(orderId)||p.entryOrderId&&p.entryOrderId!==orderId)return this.#deny('ENTRY_ACK_MISMATCH',p);
  p.entryOrderId=orderId;if(p.entryStatus==='SUBMITTED')p.entryStatus='ACKNOWLEDGED';return {accepted:true,positionCreated:p.filledQuantity>0};
 }
 timeout(reference){const p=this.#entry(reference);if(!p)return this.#deny('ENTRY_UNOBSERVED');if(p.entrySettled)return this.#deny('ENTRY_ALREADY_SETTLED',p);p.entryStatus='UNKNOWN';p.reconciliationRequired=true;
  this.#intent('RECONCILE_ENTRY_BEFORE_ANY_RETRY',p);return {accepted:true,code:'UNKNOWN_NO_RESUBMISSION'};}
 reconcileEntry({reference,orderId,status,filledQuantity}={}){
  const p=this.#entry(reference);if(!p||!['OPEN','FILLED','CANCELLED','NOT_FOUND'].includes(status)||!finite(filledQuantity)||
   !near(filledQuantity,p.filledQuantity)||status==='NOT_FOUND'&&p.filledQuantity>0||status==='FILLED'&&!near(p.filledQuantity,p.requestedQuantity)||
   orderId!==undefined&&(!key(orderId)||p.entryOrderId&&p.entryOrderId!==orderId))return this.#deny('ENTRY_RECONCILIATION_MISMATCH',p);
  if(orderId)p.entryOrderId=orderId;p.entryStatus=status==='OPEN'?(p.filledQuantity?'PARTIAL':'ACKNOWLEDGED'):status;
  p.entrySettled=['FILLED','CANCELLED'].includes(status);p.reconciliationRequired=false;if(status==='NOT_FOUND'||status==='CANCELLED'&&p.filledQuantity===0)p.closed=true;
  this.#maybeBreakeven(p);return {accepted:true,code:'MOCK_RECONCILED_NO_AUTOMATIC_RETRY'};
 }
 #deduplicate(p,orderId,fillId,role,quantity,price){
  if(!key(fillId)||!key(orderId)||!positive(quantity)||!positive(price))return 'INVALID_FILL';
  const id=orderId+':'+fillId;if(!key(id))return 'INVALID_FILL_ID';const prior=this.#state.seenFills[id];
  if(prior){if(prior.reference===p.reference&&prior.role===role&&near(prior.quantity,quantity)&&near(prior.price,price))return 'DUPLICATE_FILL';
   p.reconciliationRequired=true;return 'CONFLICTING_FILL_ID';}
  return id;
 }
 entryFill({reference,orderId,fillId,quantity,price,confirmed}={}){
  const p=this.#entry(reference);if(!p||confirmed!==true)return this.#deny('CONFIRMED_ENTRY_FILL_REQUIRED',p);
  const id=this.#deduplicate(p,orderId,fillId,'ENTRY',quantity,price);if(['INVALID_FILL','INVALID_FILL_ID','DUPLICATE_FILL','CONFLICTING_FILL_ID'].includes(id))return this.#deny(id,p);
  if(p.closed||p.entryOrderId&&p.entryOrderId!==orderId||p.entrySettled||p.filledQuantity+quantity>p.requestedQuantity+1e-10){p.reconciliationRequired=true;return this.#deny('ENTRY_FILL_STATE_MISMATCH',p)}
  p.entryOrderId=orderId;p.filledQuantity+=quantity;p.entryNotional+=quantity*price;p.averageEntry=p.entryNotional/p.filledQuantity;p.quantityRemaining+=quantity;
  this.#state.seenFills[id]={reference,role:'ENTRY',quantity,price};
  const complete=near(p.filledQuantity,p.requestedQuantity);p.entrySettled=complete;p.entryStatus=complete?'FILLED':'PARTIAL';
  if(complete)p.reconciliationRequired=false;
  if((p.direction==='LONG'?1:-1)*(p.averageEntry-p.originalStop)<=0){p.reconciliationRequired=true;p.lastCode='ENTRY_STOP_INVALID_AFTER_FILL';}
  return {accepted:true,code:complete?'CONFIRMED_FILLED':'CONFIRMED_PARTIAL',positionCreated:true};
 }
 acknowledgeExit({reference,role,orderId,quantity,reduceOnly}={}){
  const p=this.#entry(reference);if(!p||!p.entrySettled||p.closed||!['TP1','TP2','TP3','CLOSE'].includes(role)||!key(orderId)||reduceOnly!==true||
   !positive(quantity)||(role==='CLOSE'?quantity>p.quantityRemaining+1e-10:!near(quantity,p.filledQuantity*FRACTIONS[role])))return this.#deny('REDUCE_ONLY_EXACT_EXIT_REQUIRED',p);
  if(p.exitOrders[orderId]&&p.exitOrders[orderId].role!==role)return this.#deny('EXIT_ORDER_ROLE_MISMATCH',p);
  if(Object.entries(p.exitOrders).some(([id,item])=>id!==orderId&&item.role===role&&!item.cancelled))return this.#deny('DUPLICATE_EXIT_ORDER',p);
  p.exitOrders[orderId]={role,quantity,reduceOnly:true,cancelled:false};return {accepted:true};
 }
 exitFill({reference,role,orderId,fillId,quantity,price,confirmed,reduceOnly}={}){
  const p=this.#entry(reference);if(!p||confirmed!==true||reduceOnly!==true||!['TP1','TP2','TP3','STOP','CLOSE'].includes(role))return this.#deny('CONFIRMED_REDUCE_ONLY_EXIT_REQUIRED',p);
  const id=this.#deduplicate(p,orderId,fillId,role,quantity,price);if(['INVALID_FILL','INVALID_FILL_ID','DUPLICATE_FILL','CONFLICTING_FILL_ID'].includes(id))return this.#deny(id,p);
  const order=role==='STOP'?p.stopOrders[orderId]:p.exitOrders[orderId];
  if(!order||order.cancelled||role!=='STOP'&&order.role!==role||p.closed||quantity>p.quantityRemaining+1e-10||
   Object.hasOwn(FRACTIONS,role)&&p.exitFilled[role]+quantity>p.filledQuantity*FRACTIONS[role]+1e-10){p.reconciliationRequired=true;return this.#deny('EXIT_FILL_STATE_MISMATCH',p)}
  p.exitFilled[role]+=quantity;p.quantityRemaining=Math.max(0,p.quantityRemaining-quantity);this.#state.seenFills[id]={reference,role,quantity,price};
  if(p.quantityRemaining<=1e-10){p.quantityRemaining=0;p.closed=true;this.#intent('CLEANUP_REMAINING_REDUCE_ONLY_ORDERS',p,
   {orderIds:[...Object.keys(p.exitOrders),...Object.keys(p.stopOrders)],pendingProtectionRequestId:p.breakeven.requestId,requiresReconciliation:true});
   if(!p.breakeven.moved)p.breakeven.status='CLOSED_NO_MOVE';}
  else this.#maybeBreakeven(p);
  return {accepted:true,code:p.closed?'POSITION_CLOSED':'CONFIRMED_EXIT_PARTIAL'};
 }
 #maybeBreakeven(p){
  if(p.closed||!p.moveStopToBreakeven||!p.entrySettled||p.breakeven.requestId||!near(p.exitFilled.TP1,p.filledQuantity*.4))return;
  if(!proof(this.#capabilities.safeStopReplace)||!proof(this.#capabilities.reduceOnly)||!proof(this.#capabilities.protectiveStop)||
   !['REGISTER_BEFORE_CANCEL','ATOMIC_MODIFY'].includes(this.#capabilities.safeStopReplace.mode)){p.lastCode='SAFE_REPLACEMENT_UNVERIFIED';p.reconciliationRequired=true;return}
  if(!p.protection||p.protection.quantity+1e-10<p.quantityRemaining){p.lastCode='PROTECTION_UNVERIFIED';return}
  const price=p.breakevenMode==='COST_COVERED'?p.costCoveredPrice:p.averageEntry;
  if(!positive(price)||(p.direction==='LONG'?1:-1)*(price-p.averageEntry)<0){p.lastCode='COST_RECOVERY_PRICE_INVALID';return}
  const requestId=this.#intent('REPLACE_PROTECTION_KEEP_OLD_ACTIVE',p,{oldOrderId:p.protection.orderId,price,quantity:p.quantityRemaining,reduceOnly:true,
   replaceMode:this.#capabilities.safeStopReplace.mode,requiresExchangeRequery:true});
  p.breakeven={status:'REPLACEMENT_PENDING',requestId,newOrderId:null,oldOrderId:p.protection.orderId,price,moved:false};
 }
 replacementAck({reference,requestId,newOrderId}={}){
  const p=this.#entry(reference);if(!p||!key(requestId)||requestId!==p.breakeven.requestId||!key(newOrderId)||p.closed||
   this.#capabilities.safeStopReplace?.mode==='REGISTER_BEFORE_CANCEL'&&newOrderId===p.breakeven.oldOrderId)return this.#deny('PROTECTION_ACK_MISMATCH',p);
  p.breakeven.newOrderId=newOrderId;p.breakeven.status='AWAITING_EXCHANGE_VERIFICATION';return {accepted:true,moved:false};
 }
 replacementFailure({reference,requestId,unknown=true}={}){
  const p=this.#entry(reference);if(!p||!key(requestId)||requestId!==p.breakeven.requestId||p.breakeven.moved)return this.#deny('PROTECTION_REQUEST_MISMATCH',p);
  p.breakeven.status=unknown?'UNKNOWN_KEEP_OLD':'FAILED_KEEP_OLD';p.reconciliationRequired=true;return {accepted:true,oldProtectionRetained:Boolean(p.protection),retryAllowed:false};
 }
 observeProtection({reference,orderId,price,quantity,reduceOnly,active,requestId}={}){
  const p=this.#entry(reference);if(!p||!key(orderId)||!positive(price)||!positive(quantity)||reduceOnly!==true||active!==true)return this.#deny('ACTIVE_REDUCE_ONLY_PROTECTION_REQUIRED',p);
  if(p.closed){this.#intent('CLEANUP_LATE_PROTECTION_AFTER_CLOSE',p,{orderIds:[orderId],requiresReconciliation:true});return {accepted:true,moved:false}}
  if(quantity+1e-10<p.quantityRemaining)return this.#deny('PROTECTION_QUANTITY_INSUFFICIENT',p);
  const be=p.breakeven,replacement=requestId!==undefined;
  if(replacement&&(!key(requestId)||requestId!==be.requestId||!near(price,be.price)||be.newOrderId!==null&&be.newOrderId!==orderId||
   this.#capabilities.safeStopReplace?.mode==='REGISTER_BEFORE_CANCEL'&&orderId===be.oldOrderId))return this.#deny('PROTECTION_OBSERVATION_MISMATCH',p);
  if(!replacement&&(!near(price,p.originalStop)||be.moved))return this.#deny('INITIAL_PROTECTION_MISMATCH',p);
  p.stopOrders[orderId]={price,quantity,reduceOnly:true,cancelled:false};p.protection={orderId,price,quantity};
  if(replacement){
   if(!be.moved){be.moved=true;be.newOrderId=orderId;be.status='VERIFIED';p.reconciliationRequired=false;
    if(be.oldOrderId!==orderId)this.#intent('CANCEL_OLD_PROTECTION_AFTER_VERIFICATION',p,{orderIds:[be.oldOrderId],newProtectionOrderId:orderId,reduceOnly:true});}
  }else this.#maybeBreakeven(p);
  return {accepted:true,moved:be.moved};
 }
 observeCancelled({reference,orderId}={}){
  const p=this.#entry(reference),order=p?.stopOrders[orderId]??p?.exitOrders[orderId];if(!p||!order)return this.#deny('CANCELLED_ORDER_UNOBSERVED',p);
  order.cancelled=true;if(p.protection?.orderId===orderId&&!p.closed){p.protection=null;p.reconciliationRequired=true;return this.#deny('PROTECTION_REMOVED_RECONCILIATION_REQUIRED',p)}return {accepted:true};
 }
 reconcilePosition({reference,quantityRemaining}={}){
  const p=this.#entry(reference);if(!p||!finite(quantityRemaining)||quantityRemaining<0)return this.#deny('INVALID_POSITION_OBSERVATION',p);
  if(!near(quantityRemaining,p.quantityRemaining)){this.#state.risk.positionSynchronized=false;p.reconciliationRequired=true;return this.#deny('POSITION_MISMATCH',p)}return {accepted:true};
 }
 setRiskState(input={}){
  if(!exactKeys(input,['killSwitch','dailyLossUSDT','storageHealthy','positionSynchronized'])||
   Object.entries(input).some(([name,value])=>name==='dailyLossUSDT'?!finite(value)||value<0:typeof value!=='boolean'))return this.#deny('INVALID_MOCK_RISK_STATE');
  Object.assign(this.#state.risk,input);return {accepted:true};
 }
 snapshot(){
  const blockers=this.#blockers();return {kind:'ORANGEX_MOCK_ORDER_SAFETY',mode:'READ_ONLY',dataSource:'SYNTHETIC_TEST',simulationOnly:true,
   mockEntryAllowed:blockers.length===0,blockers,entries:clone(this.#state.entries),intents:clone(this.#state.intents),risk:clone(this.#state.risk),
   activationAllowed:false,liveOrdersEnabled:false,ordersSubmitted:false,transportAvailable:false,pnlCalculationStatus:'NOT_CALCULATED_BY_ORDER_SAFETY_MODEL'};
 }
 exportState(){return clone(this.#state)}
}
