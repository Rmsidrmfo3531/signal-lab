// Stage 2 runs locally against explicitly synthetic scenarios only. There is no
// exchange transport, public-data polling, production activation flag or order API.
import {OrangeXPaperEngine} from './orangex_paper.mjs';
import {OrangeXPaperStore} from './orangex_paper_store.mjs';
import {normalizeOrangeXPaperSignal,alignOrangeXPaperSignal} from './orangex_paper_signal.mjs';
import {analyzeOrangeXPaperPerformance,auditOrangeXPaperAccounting} from './orangex_paper_performance.mjs';

const clone=value=>structuredClone(value);
const safeSymbol=value=>typeof value==='string'&&/^[A-Z0-9]{2,32}$/.test(value)?value:'UNKNOWN';
export class OrangeXPaperService{
 constructor({directory,now=()=>Date.now(),writable=false,executionMode='SYNTHETIC_TEST',runKind='FORWARD_PAPER'}={}){
  if(!['SYNTHETIC_TEST','HISTORICAL_REPLAY','LIVE_MARKET_PAPER'].includes(executionMode)||!['FORWARD_PAPER','BACKTEST'].includes(runKind))throw Error('INVALID_PAPER_CONTEXT');
  Object.defineProperties(this,{executionMode:{value:executionMode,enumerable:true},runKind:{value:runKind,enumerable:true}});
  this.now=now;this.writable=writable===true;this.store=null;this.storeConfigError=false;
  try{this.store=directory?new OrangeXPaperStore({directory,now}):null}catch{this.storeConfigError=true}
  this.engine=null;this.readError=null;this.observed=[];this.observedKeys=new Set();
  this.#load();
 }
 #load(){
  try{
   if(this.storeConfigError)throw Error('INVALID_OFFLINE_STORE');
   const seed=this.store?.read()??{};
   this.engine=new OrangeXPaperEngine(seed,{now:this.now,executionMode:this.executionMode,runKind:this.runKind,onChange:state=>{
    if(!this.writable||!this.store)throw Error('ORANGEX_PAPER_READ_ONLY_STORAGE');
    this.store.write(state);
   }});
   this.readError=null;
  }catch{
   this.engine=null;this.readError='ORANGEX_PAPER_RECORDS_UNAVAILABLE';
  }
 }
 #writer(){
  if(!this.writable||!this.store||!this.engine||this.readError)throw Error('ORANGEX_PAPER_WRITER_UNAVAILABLE');
  if(this.executionMode!=='SYNTHETIC_TEST'||this.runKind!=='FORWARD_PAPER')throw Error('ORANGEX_PAPER_CONTEXT_READ_ONLY');
  if(!auditOrangeXPaperAccounting(this.engine.exportState(),{now:this.now()}).valid)throw Error('ORANGEX_PAPER_ACCOUNTING_MISMATCH');
  return this.engine;
 }
 configure(settings){return this.#writer().configure(settings)}
 setContract(contract){return this.#writer().setContract(contract)}
 observeSignal(row,{instrumentName}={}){
  // This is the only scanner connection. Its provenance is fixed by the server,
  // not by a signal field, environment switch or a browser request.
  let result;
  try{result=normalizeOrangeXPaperSignal(row,{now:this.now(),source:'SIGNAL_LAB_SCANNER',instrumentName})}
  catch{result={ok:false,reasons:['SIGNAL_VALIDATION_FAILED']}}
  const key=result.signal?.key??`${safeSymbol(row?.symbol)}:${Number(row?.patternConfirmedAt)||0}`;
  if(!this.observedKeys.has(key)){
   const rejection={key,symbol:safeSymbol(row?.symbol),at:this.now(),reason:'REAL_DATA_AUTO_ENTRY_DISABLED',stage:'SIGNAL',code:'REAL_DATA_AUTO_ENTRY_DISABLED',
    reasons:['REAL_DATA_AUTO_ENTRY_DISABLED',...(!result.ok?result.reasons:[])],dataSource:'REAL_SCANNER'};
   this.observedKeys.add(key);this.observed.push(rejection);
   if(this.observed.length>100){const oldest=this.observed.shift();this.observedKeys.delete(oldest.key)}
  }
  return {accepted:false,code:'REAL_DATA_AUTO_ENTRY_DISABLED',normalization:result};
 }
 submitSignal(row,{dataSource='UNOBSERVED',orderType='MARKET',limitPrice}={}){
  if(dataSource!=='SYNTHETIC_FIXTURE')return this.observeSignal(row);
  const result=normalizeOrangeXPaperSignal(row,{now:this.now(),source:'SYNTHETIC_FIXTURE'});
  const engine=this.#writer();
  if(!result.ok){engine.recordRejection({reason:'SIGNAL_NORMALIZATION_FAILED',stage:'SIGNAL'});return {accepted:false,code:'SIGNAL_VALIDATION_FAILED',reasons:result.reasons}}
  const contract=engine.exportState().contracts[result.signal.instrumentName];
  const candidate={...result.signal};
  if(row.managementVersion==='VOLUME_PROFILE_V1'){
   if(row.targetPlan?.ok!==true||!Array.isArray(row.targetPlan.targets)||row.targetPlan.targets.length!==3){
    engine.recordRejection({key:result.signal.key,reason:'TP_PROFILE_UNAVAILABLE',stage:'contract'});
    return {accepted:false,code:'TP_PROFILE_UNAVAILABLE',reasons:['TP_PROFILE_UNAVAILABLE']};
   }
   // The shared signal normalizer historically omitted management metadata.
   // Carry only the explicitly supplied new plan; never replace it with R levels.
   candidate.managementVersion='VOLUME_PROFILE_V1';candidate.targetPlan=clone(row.targetPlan);
   candidate.targets=Array.isArray(row.targetPlan?.targets)?[...row.targetPlan.targets]:[];
   for(const key of ['moveStopToBreakeven','TP1_MOVE_STOP_TO_BREAKEVEN','breakevenMode','breakevenCostAssumptions'])
    if(Object.hasOwn(row,key))candidate[key]=clone(row[key]);
  }
  const plan=alignOrangeXPaperSignal(candidate,contract);
  if(!plan.ok){engine.recordRejection({key:result.signal.key,reason:'CONTRACT_UNOBSERVED',stage:'CONTRACT'});return {accepted:false,code:'PLAN_VALIDATION_FAILED',reasons:plan.reasons}}
  // Profile TP prices were already set before the liquidity zones. If venue tick
  // alignment changes those prices, do not silently move them through a zone.
  if(candidate.managementVersion==='VOLUME_PROFILE_V1'&&plan.signal.targets.some((price,i)=>
   Math.abs(price-candidate.targets[i])>Math.max(1e-10,Math.abs(candidate.targets[i])*Number.EPSILON*16))){
   engine.recordRejection({key:result.signal.key,reason:'TP_PROFILE_UNAVAILABLE',stage:'contract'});
   return {accepted:false,code:'TP_PROFILE_UNAVAILABLE',reasons:['TARGET_GRID_REQUIRES_REPLANNING']};
  }
  if(candidate.managementVersion==='VOLUME_PROFILE_V1')plan.signal.targets=[...candidate.targets];
  return engine.register(plan.signal,{dataSource,orderType,limitPrice});
 }
 onMarket(market){return this.#writer().onMarket(market)}
 applyFunding(event){return this.#writer().applyFunding(event)}
 closePosition(id,market){return this.#writer().closePosition(id,market)}
 cancelOrder(id){return this.#writer().cancelOrder(id)}
 setConnectionStatus(event){return this.#writer().setConnectionStatus(event)}
 snapshot(){
  // A running application can display a separately saved offline experiment.
  // Reading it never acquires a writer lock or rewrites either store.
  if(!this.writable)this.#load();
  let value,disk,performance=null;
  try{value=this.engine?.snapshot();disk=this.store?.status()??{exists:false};if(this.engine)performance=analyzeOrangeXPaperPerformance(this.engine.exportState(),{now:this.now()})}
  catch{this.readError='ORANGEX_PAPER_RECORDS_UNAVAILABLE'}
  value??={settings:null,summary:null,pending:[],open:[],closed:[],events:[],rejections:[]};disk??={exists:false,healthy:false};
  return {...clone(value),kind:'ORANGEX_PAPER_OFFLINE',mode:'PAPER_OFFLINE',executionMode:this.executionMode,runKind:this.runKind,performance,
   dataSource:disk.exists&&this.executionMode==='SYNTHETIC_TEST'?'SYNTHETIC_FIXTURE':'UNOBSERVED',
   simulationOnly:true,realDataAutoEntryEnabled:false,realDataEntryEnabled:false,liveOrdersEnabled:false,
   recordStatus:this.readError?'UNAVAILABLE':disk.exists?'OFFLINE_RECORDS':'UNCONFIGURED',
   recordsUnavailable:Boolean(this.readError),
   rejections:[...(value.rejections??[]),...clone(this.observed)].slice(-100),
   storage:{configured:Boolean(this.store),exists:disk.exists===true,readOnly:!this.writable,
    status:this.readError||disk.healthy===false?'ERROR':!disk.exists?'ABSENT':!this.writable?'READ_ONLY':'READY',
    healthy:!this.readError&&disk.healthy!==false&&disk.lastError==null,lastSavedAt:disk.lastSavedAt??null,
    fileSizeBytes:disk.fileSizeBytes??null,maxStoreBytes:disk.maxStoreBytes??null,nearCapacity:disk.nearCapacity===true,
    errorCode:this.readError??(disk.lastError?'ORANGEX_PAPER_STORAGE_ERROR':null)},
   signalBridge:{timeframes:['1h','4h'],productionConnection:'OBSERVE_REJECTIONS_ONLY',
    realAutoEntryEnabled:false,syntheticInputEnabled:this.writable&&this.executionMode==='SYNTHETIC_TEST'&&this.runKind==='FORWARD_PAPER'},
   updatedAt:this.now()};
 }
 close(){this.store?.close()}
}
