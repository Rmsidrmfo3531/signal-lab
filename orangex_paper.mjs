/** Offline, synthetic-only OrangeX PAPER accounting. No network/order transport. */
import {TP_WEIGHTS,TP_R_MULTIPLES,entryAllowance} from './public/trade_plan.js';
import {orangeXBookIntegrity} from './orangex_listing_domains.mjs';
const SOURCE='SYNTHETIC_FIXTURE',NAME=/^[A-Z0-9]{2,20}-[A-Z0-9]{2,12}-PERPETUAL$/;
const plain=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const finite=x=>typeof x==='number'&&Number.isFinite(x),positive=x=>finite(x)&&x>0;
const clone=x=>structuredClone(x),sign=x=>x==='LONG'?1:-1;
const round=x=>Math.round(x*1e8)/1e8;
const safeKey=x=>typeof x==='string'&&/^[A-Za-z0-9:_./-]{1,240}$/.test(x);
const stamp=x=>positive(x)&&x>=1e12&&x<8e15;
const day=at=>new Date(at+9*3600000).toISOString().slice(0,10);
const floor=(qty,step)=>Math.floor(qty/step+1e-9)*step;
const aligned=(value,step)=>positive(value)&&positive(step)&&Math.abs(value/step-Math.round(value/step))<=Math.max(1,Math.abs(value/step))*Number.EPSILON*16;
const fresh=(at,now,age)=>stamp(at)&&at<=now+5000&&now-at<=age;
export const ORANGEX_PAPER_DEFAULTS=Object.freeze({capitalUSD:null,leverage:1,maxRiskUSD:null,dailyLossLimitUSD:null,maxPositions:2,
 maxPositionNotionalUSD:null,maxTotalNotionalUSD:null,maxQuoteAgeMs:90000,maxSignalAgeMs:7200000,entryTimeoutMs:1200000,
 maxSpreadBps:30,maxSlippageBps:100,maxHoldingMs:86400000,killSwitch:false});
const MONEY=['capitalUSD','maxRiskUSD','dailyLossLimitUSD','maxPositionNotionalUSD','maxTotalNotionalUSD'];
const SETTINGS=Object.keys(ORANGEX_PAPER_DEFAULTS);
const CONTRACT_FIELDS=['instrumentName','symbol','source','quantityUnit','contractSizeBase','minQty','qtyStep','minNotional','priceTick',
 'makerRate','takerRate','feeUnit','fundingRate','fundingIntervalMs','unitsVerifiedForSimulation'];
export function validateOrangeXPaperContract(contract){
 const reasons=[];
 if(!plain(contract))return {valid:false,reasons:['CONTRACT_UNOBSERVED']};
 if(contract.source!==SOURCE||contract.unitsVerifiedForSimulation!==true)reasons.push('CONTRACT_UNITS_UNVERIFIED');
 if(!NAME.test(contract.instrumentName)||!/^([A-Z0-9]{2,32})$/.test(contract.symbol))reasons.push('CONTRACT_NAME_INVALID');
 if(contract.quantityUnit!=='CONTRACT'||!positive(contract.contractSizeBase))reasons.push('CONTRACT_SIZE_UNVERIFIED');
 if(['minQty','qtyStep','minNotional','priceTick'].some(key=>!positive(contract[key])))reasons.push('ORDER_UNITS_UNVERIFIED');
 if(contract.feeUnit!=='FRACTION'||!finite(contract.makerRate)||!finite(contract.takerRate)||contract.makerRate<0||contract.takerRate<0||
  contract.makerRate>.1||contract.takerRate>.1)reasons.push('FEES_UNVERIFIED');
 if(!finite(contract.fundingRate)||Math.abs(contract.fundingRate)>.1||!positive(contract.fundingIntervalMs)||!Number.isSafeInteger(contract.fundingIntervalMs))reasons.push('FUNDING_UNVERIFIED');
 return {valid:!reasons.length,reasons};
}
function contractCopy(contract){
 const result={};for(const key of CONTRACT_FIELDS)if(Object.hasOwn(contract??{},key)){
  const value=contract[key];
  if(key==='instrumentName')result[key]=value;
  else if(key==='symbol')result[key]=typeof value==='string'&&/^[A-Z0-9]{2,32}$/.test(value)?value:null;
  else if(key==='source')result[key]=[SOURCE,'REAL_PUBLIC_READ_ONLY','WINDOWS_DIAGNOSTIC_REPLAY','UNVERIFIED'].includes(value)?value:'UNVERIFIED';
  else if(key==='quantityUnit')result[key]=['CONTRACT','BASE','UNVERIFIED'].includes(value)?value:'UNVERIFIED';
  else if(key==='feeUnit')result[key]=['FRACTION','PERCENT','BPS','UNVERIFIED'].includes(value)?value:'UNVERIFIED';
  else if(key==='unitsVerifiedForSimulation')result[key]=value===true;
  else result[key]=finite(value)?value:null;
 }
 if(!NAME.test(result.instrumentName))throw Error('INVALID_PAPER_CONTRACT_NAME');return result;
}
function settingsCopy(settings,base=ORANGEX_PAPER_DEFAULTS){
 if(!plain(settings))throw Error('INVALID_PAPER_SETTINGS');const result={...base};
 for(const key of SETTINGS)if(Object.hasOwn(settings,key))result[key]=settings[key];
 for(const key of MONEY)if(result[key]!==null&&!positive(result[key]))throw Error('INVALID_PAPER_SETTING_'+key);
 for(const key of ['leverage','maxPositions','maxQuoteAgeMs','maxSignalAgeMs','entryTimeoutMs','maxHoldingMs'])
  if(!positive(result[key])||!Number.isInteger(result[key]))throw Error('INVALID_PAPER_SETTING_'+key);
 if(result.leverage>100||result.maxPositions>100||result.maxQuoteAgeMs>90000||result.maxHoldingMs>7*86400000||
  !finite(result.maxSpreadBps)||result.maxSpreadBps<0||result.maxSpreadBps>1000||!finite(result.maxSlippageBps)||result.maxSlippageBps<0||
  result.maxSlippageBps>1000||typeof result.killSwitch!=='boolean')throw Error('INVALID_PAPER_SETTINGS');return result;
}
function validateSeed(seed){
 if(!plain(seed))throw Error('INVALID_PAPER_STATE_NO_RESET');
 if(Object.keys(seed).length&&seed.schemaVersion!==1)throw Error('UNSUPPORTED_PAPER_SCHEMA_NO_RESET');
 for(const key of ['pending','open','closed','events','rejections'])if(Object.hasOwn(seed,key)&&!Array.isArray(seed[key]))throw Error('INVALID_PAPER_STATE_'+key);
 for(const key of ['settings','contracts','seen','fundingSeen','lastMarkets'])if(Object.hasOwn(seed,key)&&!plain(seed[key]))throw Error('INVALID_PAPER_STATE_'+key);
 const keys=new Set();
 for(const group of ['open','closed'])for(const p of seed[group]??[]){
  if(!plain(p)||!safeKey(p.key)||keys.has(p.key)||!NAME.test(p.instrumentName)||!['LONG','SHORT'].includes(p.direction)||
   !positive(p.entryPrice)||!positive(p.quantityOriginal)||!finite(p.quantityRemaining)||p.quantityRemaining<0||p.quantityRemaining>p.quantityOriginal+1e-8||
   !Array.isArray(p.exitParts)||!Array.isArray(p.entryParts)||!Array.isArray(p.fundingParts)||!positive(p.stop)||
   !Array.isArray(p.targets)||p.targets.length!==3||!p.targets.every(positive)||!validateOrangeXPaperContract(p.contract).valid||
   !['feesUSD','fundingUSD','realizedGrossUSD','realizedPnLUSD'].every(key=>finite(p[key]))||!stamp(p.openedAt)||
   group==='closed'&&(p.quantityRemaining!==0||!stamp(p.closedAt))||group==='open'&&p.quantityRemaining<=0)throw Error('INVALID_PAPER_POSITION_NO_RESET');
  const validPart=(part,kind)=>plain(part)&&positive(part.quantity)&&positive(part.price)&&finite(part.feeUSD)&&part.feeUSD>=0&&stamp(part.at)&&part.at>=p.openedAt&&
   (kind==='entry'||finite(part.grossUSD)&&['TP1','TP2','TP3','STOP','CLOSE','TIME_LIMIT'].includes(part.type));
  if(!p.entryParts.every(part=>validPart(part,'entry'))||!p.exitParts.every(part=>validPart(part,'exit'))||
   !p.fundingParts.every(part=>plain(part)&&stamp(part.at)&&finite(part.amountUSD)&&finite(part.rate)&&positive(part.markPrice)&&finite(part.quantity)&&part.quantity>=0)||
   !Array.isArray(p.tpFilled)||p.tpFilled.length!==3||p.tpFilled.some(value=>!finite(value)||value<0)||!positive(p.leverage)||!positive(p.plannedRiskUSD)||
   !positive(p.markPrice)||!stamp(p.markPriceAt)||!stamp(p.lastPriceAt))throw Error('INVALID_PAPER_ACCOUNTING_PARTS');
  const entered=p.entryParts.reduce((sum,part)=>sum+part.quantity,0),entryFees=p.entryParts.reduce((sum,part)=>sum+part.feeUSD,0),
   exitFees=p.exitParts.reduce((sum,part)=>sum+part.feeUSD,0),gross=p.exitParts.reduce((sum,part)=>sum+part.grossUSD,0),funding=p.fundingParts.reduce((sum,part)=>sum+part.amountUSD,0);
  const close=(a,b)=>Math.abs(a-b)<=Math.max(1e-8,Math.abs(a)*1e-9,Math.abs(b)*1e-9);
  if(!close(entered,p.quantityOriginal)||!close(entryFees+exitFees,p.feesUSD)||!close(gross,p.realizedGrossUSD)||!close(funding,p.fundingUSD)||
   !close(gross-entryFees-exitFees-funding,p.realizedPnLUSD))throw Error('INVALID_PAPER_ACCOUNTING_TOTALS');
  const exited=p.exitParts.reduce((sum,part)=>sum+(positive(part?.quantity)?part.quantity:NaN),0);
  if(!finite(exited)||Math.abs(p.quantityOriginal-p.quantityRemaining-exited)>Math.max(1e-8,p.quantityOriginal*1e-9))throw Error('INVALID_PAPER_POSITION_QUANTITY');
  keys.add(p.key);
 }
 const pendingKeys=new Set();
 for(const p of seed.pending??[]){
  if(!plain(p)||!safeKey(p.key)||pendingKeys.has(p.key)||!NAME.test(p.instrumentName)||!['MARKET','LIMIT'].includes(p.orderType)||
   !stamp(p.createdAt)||!stamp(p.expiresAt)||p.expiresAt<p.createdAt||!plain(p.signal)||p.signal.key!==p.key||!validateOrangeXPaperContract(p.contract).valid||
   p.quantityRequested!==null&&!positive(p.quantityRequested)||p.quantityRemaining!==null&&(!positive(p.quantityRemaining)||p.quantityRemaining>p.quantityRequested)||
   p.orderType==='LIMIT'&&!positive(p.limitPrice))throw Error('INVALID_PAPER_PENDING_NO_RESET');
  pendingKeys.add(p.key);
 }
}
function marketCopy(market,settings,now){
 if(!plain(market)||market.dataSource!==SOURCE)return {error:'REAL_DATA_ENTRY_DISABLED'};
 if(!NAME.test(market.instrumentName)||!Array.isArray(market.bids)||!Array.isArray(market.asks))return {error:'BOOK_UNOBSERVED'};
 if(!fresh(market.timestamp,now,settings.maxQuoteAgeMs))return {error:'BOOK_STALE'};
 if(!positive(market.markPrice)||!fresh(market.markPriceAt,now,settings.maxQuoteAgeMs))return {error:'MARK_STALE'};
 const integrity=orangeXBookIntegrity(market);
 if(!integrity.valid)return {error:integrity.issues[0]??'BOOK_INTEGRITY_FAILED'};
 if(market.bids[0][0]>=market.asks[0][0])return {error:'BOOK_CROSSED'};
 return {instrumentName:market.instrumentName,dataSource:SOURCE,bids:clone(market.bids),asks:clone(market.asks),timestamp:market.timestamp,
  markPrice:market.markPrice,markPriceAt:market.markPriceAt,sequence:Number.isSafeInteger(market.sequence)?market.sequence:null};
}
function depthFill(book,buy,requested,contract,{limitPrice=null,consume=false}={}){
 const rows=buy?book.asks:book.bids,changes=[];let left=requested,total=0;
 for(let index=0;index<rows.length&&left>1e-12;index++){
  const [price,size]=rows[index];if(limitPrice!==null&&(buy?price>limitPrice:price<limitPrice))break;
  const quantity=Math.min(left,size);total+=quantity*price;left-=quantity;changes.push([index,quantity]);
 }
 let quantity=floor(requested-left,contract.qtyStep);
 if(quantity<contract.qtyStep*.999999)return null;
 // Rewalk after quantity-step rounding so fractional last lots are not charged.
 left=quantity;total=0;changes.length=0;
 for(let index=0;index<rows.length&&left>1e-12;index++){
  const [price,size]=rows[index];if(limitPrice!==null&&(buy?price>limitPrice:price<limitPrice))break;
  const take=Math.min(left,size);total+=take*price;left-=take;changes.push([index,take]);
 }
 if(consume)for(const [index,take]of changes)rows[index][1]=Math.max(0,rows[index][1]-take);
 return {quantity,price:total/quantity,notionalUSD:total*contract.contractSizeBase};
}
function cashFlows(position){
 return [...position.entryParts.map(part=>({at:part.at,amount:-part.feeUSD})),
  ...position.exitParts.map(part=>({at:part.at,amount:part.grossUSD-part.feeUSD})),
  ...position.fundingParts.map(part=>({at:part.at,amount:-part.amountUSD}))];
}
function fundingMissing(position,now){
 const end=position.closedAt??now,interval=position.contract.fundingIntervalMs;
 const expected=Math.floor(end/interval)-Math.floor(position.openedAt/interval);
 const observed=new Set(position.fundingParts.filter(part=>part.at>position.openedAt&&part.at<=end&&part.at%interval===0).map(part=>part.at));
 return !Number.isSafeInteger(expected)||observed.size!==expected;
}
export class OrangeXPaperEngine{
 constructor(seed={}, {now=()=>Date.now(),onChange=()=>{},onEvent=()=>{},settings,contracts}={}){
  validateSeed(seed);this.now=now;this.onChange=onChange;this.onEvent=onEvent;this.storageHealthy=true;
  this.recoveredKeys=new Set([...(seed.open??[]),...(seed.pending??[])].map(position=>position.key));
  const initial={schemaVersion:1,settings:settingsCopy(seed.settings??{}),contracts:{},pending:[],open:[],closed:[],seen:{},fundingSeen:{},events:[],rejections:[],lastMarkets:{},updatedAt:null,...clone(seed)};
  initial.settings=settingsCopy(settings??{},settingsCopy(seed.settings??{},ORANGEX_PAPER_DEFAULTS));
  if((initial.open.length||initial.pending.length)&&settings)for(const field of ['capitalUSD','leverage'])
   if(initial.settings[field]!==seed.settings?.[field])throw Error('PAPER_ACCOUNT_CONFIG_LOCKED_WITH_POSITIONS');
  initial.contracts={};
  for(const [name,input]of Object.entries(seed.contracts??{})){
   const contract=contractCopy(input);if(name!==contract.instrumentName)throw Error('INVALID_PAPER_CONTRACT_MAPPING');
   initial.contracts[name]=contract;
  }
  for(const position of [...initial.pending,...initial.open,...initial.closed])position.contract=contractCopy(position.contract);
  if(contracts!==undefined){
   const items=Array.isArray(contracts)?contracts:Object.values(contracts);
   for(const item of items){const contract=contractCopy(item);initial.contracts[contract.instrumentName]=contract}
  }
  this.store=initial;
 }
 exportState(){return clone(this.store)}
 #transaction(run){
  const prior=this.store;this.store=clone(prior);const events=[];
  try{
   const result=run(events);this.store.updatedAt=this.now();
   const payload=clone(this.store),save=this.onChange(payload);
   if(save&&typeof save.then==='function')throw Error('ASYNC_PAPER_PERSISTENCE_UNSUPPORTED');
   this.storageHealthy=true;
   for(const event of events)try{this.onEvent(clone(event))}catch{/* saved accounting is independent of notification delivery */}
   return result;
  }catch(error){this.store=prior;this.storageHealthy=false;throw error}
 }
 #event(type,extra={},events=[]){
  const event={type,at:this.now(),...extra};this.store.events.push(event);this.store.events=this.store.events.slice(-2000);events.push(event);
 }
 #reject(key,reason,stage='entry',events=[],instrumentName=null){
  const row=[...this.store.pending,...this.store.open,...this.store.closed].find(p=>p.key===key),
   item={key:safeKey(key)?key:null,instrumentName:NAME.test(instrumentName)?instrumentName:row?.instrumentName??null,reason,stage,at:this.now()};this.store.rejections.push(item);this.store.rejections=this.store.rejections.slice(-200);
  this.#event('REJECT',item,events);return false;
 }
 recordRejection({key=null,instrumentName=null,reason='SIGNAL_NORMALIZATION_FAILED',stage='technical'}={}){
  const codes=['REAL_DATA_ENTRY_DISABLED','SIGNAL_NORMALIZATION_FAILED','TECHNICAL_UNQUALIFIED','SYMBOL_MAPPING_UNVERIFIED','CONTRACT_UNOBSERVED','PAPER_SETTINGS_UNCONFIGURED'];
  return this.#transaction(events=>this.#reject(key,codes.includes(reason)?reason:'SIGNAL_NORMALIZATION_FAILED',
   ['source','technical','contract','risk','market','entry'].includes(stage)?stage:'technical',events,instrumentName));
 }
 configure(patch){return this.#transaction(events=>{
  const next=settingsCopy(patch,this.store.settings);
  if(this.store.open.length||this.store.pending.length)for(const field of ['capitalUSD','leverage'])
   if(next[field]!==this.store.settings[field])throw Error('PAPER_ACCOUNT_CONFIG_LOCKED_WITH_POSITIONS');
  this.store.settings=next;this.#event('CONFIGURED',{},events);return true;
 })}
 setContract(input){return this.#transaction(events=>{
  const contract=contractCopy(input);
  if(this.store.open.some(p=>p.instrumentName===contract.instrumentName)||this.store.pending.some(p=>p.instrumentName===contract.instrumentName))
   throw Error('PAPER_CONTRACT_LOCKED_WITH_POSITIONS');
  this.store.contracts[contract.instrumentName]=contract;this.#event('CONTRACT_CONFIGURED',{instrumentName:contract.instrumentName},events);return true;
 })}
 #settingsReady(){return MONEY.every(key=>positive(this.store.settings[key]))}
 #technical(signal){
  const now=this.now(),s=this.store.settings;
  return plain(signal)&&safeKey(signal.key)&&NAME.test(signal.instrumentName)&&typeof signal.symbol==='string'&&/^[A-Z0-9]{2,32}$/.test(signal.symbol)&&
   ['LONG','SHORT'].includes(signal.direction)&&signal.timeframe==='1h'&&signal.trendTimeframe==='4h'&&signal.confirmed===true&&signal.trendConfirmed===true&&
   fresh(signal.patternConfirmedAt,now,s.maxSignalAgeMs)&&positive(signal.entry)&&positive(signal.stop)&&sign(signal.direction)*(signal.entry-signal.stop)>0;
 }
 #dailyPnL(){return [...this.store.open,...this.store.closed].flatMap(cashFlows).filter(part=>day(part.at)===day(this.now())).reduce((sum,part)=>sum+part.amount,0)}
 #reservedRisk(exclude){return this.store.open.filter(p=>p.key!==exclude).reduce((sum,p)=>sum+p.plannedRiskUSD*p.quantityRemaining/p.quantityOriginal,0)+
  this.store.pending.filter(p=>p.key!==exclude).reduce((sum,p)=>sum+(p.plannedRiskUSD??this.store.settings.maxRiskUSD??0),0)}
 register(input,{orderType='MARKET',limitPrice=null,dataSource}={}){return this.#transaction(events=>{
  const key=input?.key,s=this.store.settings;
  if(dataSource!==SOURCE)return this.#reject(key,'REAL_DATA_ENTRY_DISABLED','source',events);
  if(!this.#settingsReady())return this.#reject(key,'PAPER_SETTINGS_UNCONFIGURED','risk',events);
  if(s.killSwitch)return this.#reject(key,'KILL_SWITCH','risk',events);
  if(!this.#technical(input))return this.#reject(key,'TECHNICAL_UNQUALIFIED','technical',events);
  const contract=this.store.contracts[input.instrumentName],validity=validateOrangeXPaperContract(contract);
  if(!validity.valid)return this.#reject(key,validity.reasons[0],'contract',events);
  if(input.symbol!==contract.symbol)return this.#reject(key,'SYMBOL_MAPPING_UNVERIFIED','contract',events);
  if(this.store.seen[key])return this.#reject(key,'DUPLICATE_SIGNAL','risk',events);
  if(this.store.open.some(p=>p.instrumentName===input.instrumentName)||this.store.pending.some(p=>p.instrumentName===input.instrumentName))return this.#reject(key,'DUPLICATE_POSITION','risk',events);
  if(new Set([...this.store.open,...this.store.pending].map(p=>p.key)).size>=s.maxPositions)return this.#reject(key,'MAX_POSITIONS','risk',events);
  if(this.#dailyPnL()-this.#reservedRisk(key)<=-s.dailyLossLimitUSD)return this.#reject(key,'DAILY_LOSS_LIMIT','risk',events);
  if(!['MARKET','LIMIT'].includes(orderType)||orderType==='LIMIT'&&(!positive(limitPrice)||!aligned(limitPrice,contract.priceTick)))return this.#reject(key,'LIMIT_PRICE_INVALID','entry',events);
  const dir=sign(input.direction),entry=input.entry,stop=input.stop;
  if(!aligned(entry,contract.priceTick)||!aligned(stop,contract.priceTick))return this.#reject(key,'PRICE_GRID_MISMATCH','entry',events);
  const targets=input.targets===undefined?TP_R_MULTIPLES.map(r=>entry+dir*Math.abs(entry-stop)*r):input.targets;
  if(!Array.isArray(targets)||targets.length!==3||targets.some((p,i)=>!positive(p)||!aligned(p,contract.priceTick)||dir*(p-entry)<=0||i>0&&dir*(p-targets[i-1])<=0))return this.#reject(key,'TARGET_INVALID','entry',events);
  const signal={key,symbol:input.symbol,instrumentName:input.instrumentName,direction:input.direction,entry,stop,targets:clone(targets),
   patternConfirmedAt:input.patternConfirmedAt,timeframe:'1h',trendTimeframe:'4h',confirmed:true,trendConfirmed:true};
  if(plain(input.sourcePrices)&&positive(input.sourcePrices.entry)&&positive(input.sourcePrices.stop)&&
   Array.isArray(input.sourcePrices.targets)&&input.sourcePrices.targets.length===3&&input.sourcePrices.targets.every(positive))
   signal.sourcePrices={entry:input.sourcePrices.entry,stop:input.sourcePrices.stop,targets:[...input.sourcePrices.targets]};
  if(plain(input.priceAlignment)&&positive(input.priceAlignment.priceTick)&&input.priceAlignment.source===SOURCE&&input.priceAlignment.riskMustBeRecalculated===true&&
   ['ENTRY_CEIL_STOP_FLOOR_TARGETS_CEIL','ENTRY_FLOOR_STOP_CEIL_TARGETS_FLOOR'].includes(input.priceAlignment.policy))
   signal.priceAlignment={priceTick:input.priceAlignment.priceTick,source:SOURCE,policy:input.priceAlignment.policy,riskMustBeRecalculated:true};
  this.store.pending.push({key,instrumentName:signal.instrumentName,symbol:signal.symbol,direction:signal.direction,orderType,limitPrice:orderType==='LIMIT'?limitPrice:null,
   signal,contract:clone(contract),createdAt:this.now(),expiresAt:this.now()+s.entryTimeoutMs,quantityRequested:null,quantityRemaining:null,
   plannedRiskUSD:s.maxRiskUSD,dataSource:SOURCE});this.store.seen[key]=this.now();this.#event('SIGNAL_ACCEPTED',{key,instrumentName:signal.instrumentName},events);return true;
 })}
 #account(){
  const positions=[...this.store.open,...this.store.closed],realized=positions.reduce((sum,p)=>sum+p.realizedPnLUSD,0);
  const unrealized=this.store.open.reduce((sum,p)=>sum+p.quantityRemaining*p.contract.contractSizeBase*sign(p.direction)*(p.markPrice-p.entryPrice),0);
  const margin=this.store.open.reduce((sum,p)=>sum+p.quantityRemaining*p.contract.contractSizeBase*p.entryPrice/p.leverage,0);
  const capital=this.store.settings.capitalUSD;
  return {realized,unrealized,margin,equity:capital===null?null:capital+realized+unrealized,available:capital===null?null:capital+realized+unrealized-margin};
 }
 #size(order,book){
  const s=this.store.settings,c=order.contract,dir=sign(order.direction),account=this.#account();
  if(!this.#settingsReady()||account.available===null)return {error:'PAPER_SETTINGS_UNCONFIGURED'};
  if(this.store.open.some(p=>!fresh(p.markPriceAt,this.now(),s.maxQuoteAgeMs)||!fresh(p.lastPriceAt,this.now(),s.maxQuoteAgeMs)))return {error:'PORTFOLIO_VALUATION_STALE'};
  if([...this.store.open,...this.store.closed].some(p=>fundingMissing(p,this.now())))return {error:'FUNDING_EVENTS_MISSING'};
  const top=dir===1?book.asks[0][0]:book.bids[0][0],reference=order.orderType==='LIMIT'?order.limitPrice:top;
  if(dir*(top-order.signal.stop)<=0||dir*(top-order.signal.targets[0])>=0)return {error:'SIGNAL_INVALIDATED'};
  if(order.orderType==='MARKET'&&Math.abs(top-order.signal.entry)/order.signal.entry>entryAllowance(order.signal))return {error:'ENTRY_ZONE'};
  const slip=s.maxSlippageBps/10000,worstEntry=reference*(1+dir*slip),worstStop=order.signal.stop*(1-dir*slip);
  const fundingReserve=Math.abs(c.fundingRate)*Math.ceil(s.maxHoldingMs/c.fundingIntervalMs)*worstEntry;
  const perQty=c.contractSizeBase*(dir*(worstEntry-worstStop)+(Math.abs(worstEntry)+Math.abs(worstStop))*Math.max(c.makerRate,c.takerRate)+fundingReserve);
  const existing=this.store.open.find(p=>p.key===order.key),ownRisk=existing?existing.plannedRiskUSD*existing.quantityRemaining/existing.quantityOriginal:0,
   risk=Math.min(s.maxRiskUSD-ownRisk,s.dailyLossLimitUSD+this.#dailyPnL()-this.#reservedRisk(order.key)-ownRisk);
  const exposure=this.store.open.reduce((sum,p)=>sum+p.quantityRemaining*p.entryPrice*p.contract.contractSizeBase,0);
  const ownNotional=existing?existing.quantityRemaining*existing.entryPrice*existing.contract.contractSizeBase:0,
   notional=Math.min(s.maxPositionNotionalUSD-ownNotional,s.maxTotalNotionalUSD-exposure,Math.max(0,account.available)*s.leverage);
  const quantity=floor(Math.min(risk/perQty,notional/(Math.max(worstEntry,reference)*c.contractSizeBase)),c.qtyStep*20);
  const minPrice=Math.min(order.signal.stop,...order.signal.targets,reference);
  if(!positive(quantity)||quantity*.25<c.minQty-1e-10||quantity*.25*c.contractSizeBase*minPrice<c.minNotional-1e-10)return {error:'RISK_OR_MINIMUM_CONFLICT'};
  return {quantity,plannedRiskUSD:quantity*perQty};
 }
 #fillEntry(order,book,events){
  const c=order.contract,s=this.store.settings,dir=sign(order.direction);
  if(s.killSwitch)return 0;
  const plan=this.#size(order,book);
  if(plan.error){this.#reject(order.key,plan.error,'risk',events);this.store.pending=this.store.pending.filter(p=>p.key!==order.key);return 0}
  if(!order.quantityRequested){
   order.quantityRequested=plan.quantity;order.quantityRemaining=plan.quantity;order.plannedRiskUSD=plan.plannedRiskUSD;
  }
  const top=dir===1?book.asks[0][0]:book.bids[0][0],spread=(book.asks[0][0]-book.bids[0][0])/((book.asks[0][0]+book.bids[0][0])/2)*10000;
  if(spread>s.maxSpreadBps){this.#reject(order.key,'SPREAD_LIMIT','market',events);return 0}
  const candidate=depthFill(book,dir===1,Math.min(order.quantityRemaining,plan.quantity),c,{limitPrice:order.limitPrice});
  if(!candidate)return 0;
  const quantity=floor(candidate.quantity,c.qtyStep*20);
  if(!positive(quantity)||quantity*.25<c.minQty-1e-10||quantity*.25*c.contractSizeBase*order.signal.stop<c.minNotional-1e-10){this.#reject(order.key,'SPLIT_MINIMUM_CONFLICT','execution',events);return 0}
  const preview=depthFill(book,dir===1,quantity,c,{limitPrice:order.limitPrice});
  if(Math.abs(preview.price-top)/top*10000>s.maxSlippageBps){this.#reject(order.key,'SLIPPAGE_LIMIT','execution',events);return 0}
  const fill=depthFill(book,dir===1,quantity,c,{limitPrice:order.limitPrice,consume:true}),feeUSD=fill.notionalUSD*c.takerRate;
  let p=this.store.open.find(p=>p.key===order.key);
  if(!p){p={key:order.key,instrumentName:order.instrumentName,symbol:order.symbol,direction:order.direction,contract:clone(c),dataSource:SOURCE,
    quantityOriginal:0,quantityRemaining:0,entryPrice:0,entryParts:[],stop:order.signal.stop,targets:clone(order.signal.targets),tpFilled:[0,0,0],
    leverage:s.leverage,marginUSD:0,plannedRiskUSD:0,openedAt:book.timestamp,lastPriceAt:book.timestamp,
    markPrice:book.markPrice,markPriceAt:book.markPriceAt,feesUSD:0,fundingUSD:0,realizedGrossUSD:0,realizedPnLUSD:0,exitParts:[],fundingParts:[],status:'OPEN',quoteGaps:0};
   if(order.signal.sourcePrices)p.sourcePrices=clone(order.signal.sourcePrices);
   if(order.signal.priceAlignment)p.priceAlignment=clone(order.signal.priceAlignment);
   this.store.open.push(p)}
  const old=p.quantityOriginal;p.quantityOriginal+=fill.quantity;p.quantityRemaining+=fill.quantity;p.entryPrice=(p.entryPrice*old+fill.price*fill.quantity)/p.quantityOriginal;
  p.entryParts.push({quantity:fill.quantity,price:fill.price,feeUSD,at:book.timestamp,liquidity:'TAKER',model:'VISIBLE_OPPOSITE_DEPTH_NO_QUEUE_PRIORITY'});
  p.feesUSD+=feeUSD;p.realizedPnLUSD-=feeUSD;p.marginUSD=p.quantityRemaining*p.entryPrice*c.contractSizeBase/p.leverage;
  p.plannedRiskUSD+=plan.plannedRiskUSD/plan.quantity*fill.quantity;
  order.quantityRemaining=Math.max(0,order.quantityRemaining-fill.quantity);
  order.plannedRiskUSD=order.quantityRemaining*plan.plannedRiskUSD/plan.quantity;
  this.#event(old===0?'OPEN':'ENTRY_PARTIAL',{key:p.key,instrumentName:p.instrumentName,quantity:fill.quantity,price:fill.price},events);
  if(order.orderType==='MARKET'||order.quantityRemaining<c.qtyStep*.5){
   this.store.pending=this.store.pending.filter(item=>item.key!==order.key);
   if(order.quantityRemaining>c.qtyStep*.5)this.#event('ENTRY_REMAINDER_CANCELLED',{key:p.key,instrumentName:p.instrumentName,quantity:order.quantityRemaining,reason:'MARKET_IOC'},events);
  }
  return 1;
 }
 #exit(p,book,quantity,type,events){
  const c=p.contract,fill=depthFill(book,p.direction==='SHORT',Math.min(quantity,p.quantityRemaining),c,{consume:true});
  if(!fill)return 0;
  const grossUSD=fill.quantity*c.contractSizeBase*sign(p.direction)*(fill.price-p.entryPrice),feeUSD=fill.notionalUSD*c.takerRate;
  p.exitParts.push({type,quantity:fill.quantity,price:fill.price,feeUSD,grossUSD,at:book.timestamp});
  p.quantityRemaining=Math.max(0,p.quantityRemaining-fill.quantity);if(p.quantityRemaining<c.qtyStep*.5)p.quantityRemaining=0;
  p.realizedGrossUSD+=grossUSD;p.feesUSD+=feeUSD;p.realizedPnLUSD+=grossUSD-feeUSD;p.marginUSD=p.quantityRemaining*p.entryPrice*c.contractSizeBase/p.leverage;
  if(type.startsWith('TP'))p.tpFilled[Number(type[2])-1]+=fill.quantity;
  this.#event(type,{key:p.key,instrumentName:p.instrumentName,quantity:fill.quantity,price:fill.price,netPnLUSD:grossUSD-feeUSD},events);
  if(!p.quantityRemaining){
   p.closedAt=book.timestamp;p.closeReason=type==='TP3'?'ALL_TARGETS':type;p.status='CLOSED';
   this.store.open=this.store.open.filter(item=>item.key!==p.key);this.store.pending=this.store.pending.filter(item=>item.key!==p.key);this.store.closed.push(p);
   this.#event('CLOSE',{key:p.key,instrumentName:p.instrumentName,netPnLUSD:p.realizedPnLUSD,reason:p.closeReason},events);
  }
  return 1;
 }
 #manage(p,book,events){
  if(book.timestamp<p.lastPriceAt)return 0;
  if(book.timestamp-p.lastPriceAt>this.store.settings.maxQuoteAgeMs)p.quoteGaps++;
  p.markPrice=book.markPrice;p.markPriceAt=book.markPriceAt;p.lastPriceAt=book.timestamp;
  const executable=p.direction==='LONG'?book.bids[0][0]:book.asks[0][0],dir=sign(p.direction);
  if(dir*(executable-p.stop)<=0)p.closingReason='STOP';
  if(book.timestamp-p.openedAt>=this.store.settings.maxHoldingMs&&!p.closingReason)p.closingReason='TIME_LIMIT';
  if(p.closingReason){this.store.pending=this.store.pending.filter(item=>item.key!==p.key);return this.#exit(p,book,p.quantityRemaining,p.closingReason,events)}
  let changed=0;
  for(let i=0;i<3&&p.quantityRemaining;i++){
   const target=p.quantityOriginal*TP_WEIGHTS[i]/100,remaining=target-p.tpFilled[i];
   if(remaining<p.contract.qtyStep*.5)continue;
   if(dir*(executable-p.targets[i])<0)break;
   this.store.pending=this.store.pending.filter(item=>item.key!==p.key);
   const before=p.tpFilled[i];changed+=this.#exit(p,book,remaining,`TP${i+1}`,events);
   if(p.tpFilled[i]-before<remaining-p.contract.qtyStep*.5)break;
  }
  return changed;
 }
 onMarket(input){return this.#transaction(events=>{
  const book=marketCopy(input,this.store.settings,this.now());
  if(book.error)return this.#reject(null,book.error,'market',events)?1:0;
  const previous=this.store.lastMarkets[book.instrumentName];
  if(previous&&(book.timestamp<previous.timestamp||book.timestamp===previous.timestamp&&
   !(book.sequence!==null&&previous.sequence!==null&&book.sequence>previous.sequence))){this.#reject(null,'BOOK_REPLAY','market',events);return 0}
  const contract=this.store.contracts[book.instrumentName];
  if(contract&&validateOrangeXPaperContract(contract).valid){
   if([...book.bids,...book.asks].some(([price,quantity])=>!aligned(price,contract.priceTick)||!aligned(quantity,contract.qtyStep))){this.#reject(null,'MARKET_GRID_MISMATCH','market',events);return 0}
  }
  this.store.lastMarkets[book.instrumentName]=book;let changed=0;
  for(const p of [...this.store.open])if(p.instrumentName===book.instrumentName)changed+=this.#manage(p,book,events);
  for(const order of [...this.store.pending])if(order.instrumentName===book.instrumentName){
   if(book.timestamp<=order.createdAt)continue;
   if(this.now()>order.expiresAt||book.timestamp>order.expiresAt||!this.#technical(order.signal)){
    this.store.pending=this.store.pending.filter(p=>p.key!==order.key);this.#event('ENTRY_EXPIRED',{key:order.key,instrumentName:order.instrumentName},events);continue;
   }
   changed+=this.#fillEntry(order,book,events);
  }
  return changed;
 })}
 cancelOrder(key){return this.#transaction(events=>{
  const pending=this.store.pending.find(p=>p.key===key);if(!pending)return false;
  this.store.pending=this.store.pending.filter(p=>p.key!==key);this.#event('ENTRY_CANCELLED',{key,instrumentName:pending.instrumentName},events);return true;
 })}
 closePosition(key,market){
  return this.#transaction(events=>{
   const p=this.store.open.find(p=>p.key===key);if(!p)return false;p.closingReason='CLOSE';
   this.store.pending=this.store.pending.filter(item=>item.key!==key);
   let book=this.store.lastMarkets[p.instrumentName];
   if(market!==undefined){
    const next=marketCopy(market,this.store.settings,this.now());
    const forward=!book||next.timestamp>book.timestamp||next.timestamp===book.timestamp&&next.sequence!==null&&book.sequence!==null&&next.sequence>book.sequence;
    if(next.error||next.instrumentName!==p.instrumentName)this.#reject(key,next.error??'BOOK_INSTRUMENT_MISMATCH','market',events);
    else if(!forward)this.#reject(key,'BOOK_REPLAY','market',events);
    else if([...next.bids,...next.asks].some(([price,quantity])=>!aligned(price,p.contract.priceTick)||!aligned(quantity,p.contract.qtyStep)))this.#reject(key,'MARKET_GRID_MISMATCH','market',events);
    else{book=next;this.store.lastMarkets[p.instrumentName]=book}
   }
   if(book&&fresh(book.timestamp,this.now(),this.store.settings.maxQuoteAgeMs)&&fresh(book.markPriceAt,this.now(),this.store.settings.maxQuoteAgeMs))this.#manage(p,book,events);
   else this.#event('CLOSE_WAITING_FOR_FRESH_BOOK',{key,instrumentName:p.instrumentName},events);
   return true;
  });
 }
 applyFunding(input){return this.#transaction(events=>{
  if(!plain(input)||input.dataSource!==SOURCE||!safeKey(input.id)||!NAME.test(input.instrumentName)||!stamp(input.at)||input.at>this.now()+5000||
   !finite(input.rate)||Math.abs(input.rate)>.1||!positive(input.markPrice))return this.#reject(null,'FUNDING_EVENT_INVALID','funding',events);
  if(this.store.fundingSeen[input.id])return false;
  const c=this.store.contracts[input.instrumentName];if(!validateOrangeXPaperContract(c).valid)return this.#reject(null,'FUNDING_UNVERIFIED','funding',events);
  if(input.at>this.now()||input.at%c.fundingIntervalMs!==0)return this.#reject(null,'FUNDING_SCHEDULE_INVALID','funding',events);
  for(const p of [...this.store.open,...this.store.closed]){
   if(p.instrumentName!==input.instrumentName||input.at<=p.openedAt||p.closedAt!==undefined&&input.at>p.closedAt||p.fundingParts.some(part=>part.at===input.at))continue;
   const entries=p.entryParts.filter(part=>part.at<input.at).reduce((sum,part)=>sum+part.quantity,0),
    exited=p.exitParts.filter(part=>part.at<input.at).reduce((sum,part)=>sum+part.quantity,0),quantity=Math.max(0,entries-exited);
   const amountUSD=quantity*p.contract.contractSizeBase*input.markPrice*input.rate*sign(p.direction);
   p.fundingParts.push({id:input.id,at:input.at,rate:input.rate,markPrice:input.markPrice,quantity,amountUSD});p.fundingUSD+=amountUSD;p.realizedPnLUSD-=amountUSD;
   this.#event('FUNDING',{key:p.key,instrumentName:p.instrumentName,netPnLUSD:-amountUSD},events);
  }
  this.store.fundingSeen[input.id]=input.at;return true;
 })}
 snapshot(){
  const now=this.now(),state=this.exportState(),positions=[...state.open,...state.closed],account=this.#account(),capital=state.settings.capitalUSD;
  const unverifiedFunding=positions.some(p=>fundingMissing(p,now)),valuationStale=state.open.some(p=>!fresh(p.markPriceAt,now,state.settings.maxQuoteAgeMs));
  for(const p of [...state.open,...state.closed]){
   p.recovered=this.recoveredKeys.has(p.key);
   p.unrealizedPnLUSD=p.quantityRemaining?round(p.quantityRemaining*p.contract.contractSizeBase*sign(p.direction)*(p.markPrice-p.entryPrice)):0;
   p.valuationStale=p.quantityRemaining>0&&!fresh(p.markPriceAt,now,state.settings.maxQuoteAgeMs);p.fundingComplete=!fundingMissing(p,now);
   p.settlementStatus=p.fundingComplete?'ACCOUNTED':'AWAITING_FUNDING';p.netPnLComplete=p.fundingComplete&&!p.valuationStale;
  }
  const fee=positions.reduce((sum,p)=>sum+p.feesUSD,0),funding=positions.reduce((sum,p)=>sum+p.fundingUSD,0),wins=state.closed.filter(p=>p.realizedPnLUSD>0),
   grossWins=state.closed.reduce((sum,p)=>sum+Math.max(0,p.realizedPnLUSD),0),grossLoss=state.closed.reduce((sum,p)=>sum-Math.min(0,p.realizedPnLUSD),0);
  let peak=0,running=0,drawdown=0;for(const p of [...state.closed].sort((a,b)=>a.closedAt-b.closedAt)){running+=p.realizedPnLUSD;peak=Math.max(peak,running);drawdown=Math.max(drawdown,peak-running)}
  for(const order of state.pending)order.recovered=this.recoveredKeys.has(order.key);
  return {schemaVersion:1,mode:'PAPER_OFFLINE',simulationOnly:true,dataSource:SOURCE,realDataEntryEnabled:false,liveOrdersImplemented:false,recovered:this.recoveredKeys.size>0,
   settings:state.settings,contracts:state.contracts,pending:state.pending,open:state.open,closed:state.closed,rejections:state.rejections,events:state.events,
   updatedAt:state.updatedAt,storageHealthy:this.storageHealthy,configured:this.#settingsReady(),
   summary:{capitalUSD:capital,equityUSD:capital===null||valuationStale||unverifiedFunding?null:round(account.equity),
    availableMarginUSD:capital===null||valuationStale||unverifiedFunding?null:round(account.available),usedMarginUSD:round(account.margin),
    realizedPnLUSD:unverifiedFunding?null:round(account.realized),accountedRealizedPnLUSD:round(account.realized),unrealizedPnLUSD:valuationStale?null:round(account.unrealized),
    totalPnLUSD:valuationStale||unverifiedFunding?null:round(account.realized+account.unrealized),dailyPnLUSD:unverifiedFunding?null:round(this.#dailyPnL()),feesUSD:round(fee),fundingUSD:unverifiedFunding?null:round(funding),
    accountedFundingUSD:round(funding),openCount:state.open.length,pendingCount:state.pending.length,closedCount:state.closed.length,
    winRatePct:state.closed.length&&!unverifiedFunding?round(wins.length/state.closed.length*100):null,profitFactor:grossLoss&&!unverifiedFunding?round(grossWins/grossLoss):null,
    maxDrawdownUSD:unverifiedFunding?null:round(drawdown),valuationStale,unverifiedFunding},
   assumptions:['SYNTHETIC_FIXTURE_ONLY','VISIBLE_DEPTH_NOT_ACTUAL_EXCHANGE_FILLS','LIMIT_TOUCHED_DEPTH_USES_CONSERVATIVE_TAKER_FEE','NO_QUEUE_PRIORITY_MODEL','GAP_STOP_USES_FIRST_FRESH_EXECUTABLE_BOOK','FUNDING_EVENTS_REQUIRED','LEVERAGE_MARGIN_MODEL_NO_EXCHANGE_LIQUIDATION']};
 }
}
