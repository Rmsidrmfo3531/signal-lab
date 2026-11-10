/** Forward-only, simulated execution from subsequently observed public market prices.
 * No trading credentials, no venue orders, no backfills. Indicative prices are NOT fills.
 * Long/short PNL: signed quantity * (exit - entry) minus synthetic taker fees.
 */
import {entryAllowance} from './public/trade_plan.js';
import {quantizeVolumeStep} from './volume_profile.mjs';

// Fixed simulation trade size, independent of any assumed account balance.
// Signals must still pass pattern, quality, quote, entry-timing and stop checks.
export const PAPER_DEFAULTS=Object.freeze({paperNotionalUSD:500,maxPositions:2,maxNotional:1500,minNotional:250,
 feeBps:5,slippageBps:2,cryptoHalfSpreadBps:1,entryTimeoutMs:20*60000,maxFreshMsCrypto:90000,
 maxQuoteGapMsCrypto:120000,maxRiskUSD:6,requireExecutionVenue:false,TP1_MOVE_STOP_TO_BREAKEVEN:true,TP1_BREAKEVEN_MODE:'ENTRY_FILL'});
const num=v=>Number(v);
// Execution venue whose quotes drive a record. Records from before the venue
// switch carry none and stay on the Binance price feed they were opened with.
export const EXECUTION_VENUES=Object.freeze(['BINGX','GATEIO']);
export const venueOf=record=>EXECUTION_VENUES.includes(record?.executionVenue)?record.executionVenue:'BINANCE';
const validPrice=p=>Number.isFinite(p)&&p>0;
const isoDay=(at)=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Seoul',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(at));
const isoWeek=(at)=>{const d=new Date(at+9*3600000);let dow=(d.getUTCDay()+6)%7;d.setUTCDate(d.getUTCDate()-dow);return d.toISOString().slice(0,10)};
const rounded=v=>Math.round(v*100000000)/100000000;
const onGrid=(value,step)=>{if(!validPrice(value)||!validPrice(step))return false;const n=value/step,near=Math.round(n);return Number.isSafeInteger(near)&&Math.abs(n-near)<=Math.max(1,Math.abs(n))*Number.EPSILON*16};
// Reconstruct cash flows without rewriting historical records. Fees have already
// been charged in each trade, so changing today's fee settings must not restate PNL.
function realizedCashFlows(trade,closed=false){
 const total=Number(trade.realizedPnLUSD)||0;
 const openedAt=Number(trade.openedAt),parts=trade.closeParts;
 if(Number.isFinite(openedAt)&&openedAt>0&&Array.isArray(parts)&&(!closed||parts.length>0)&&Number.isFinite(Number(trade.feesUSD))&&
   parts.every(p=>Number.isFinite(Number(p.at))&&Number(p.at)>0&&Number.isFinite(Number(p.profitUSD))&&Number.isFinite(Number(p.feeUSD)))){
  const exitFees=parts.reduce((sum,p)=>sum+Number(p.feeUSD),0);
  const entryFee=Math.max(0,Number(trade.feesUSD)-exitFees);
  const flows=[{at:openedAt,amount:-entryFee},...parts.map(p=>({at:Number(p.at),amount:Number(p.profitUSD)-Number(p.feeUSD)}))];
  // Stored part values use eight decimals. Attribute only the rounding remainder
  // to the latest event, keeping the lifetime PNL exactly as it was recorded.
  const remainder=total-flows.reduce((sum,p)=>sum+p.amount,0);
  flows.at(-1).amount+=remainder;
  return {flows,approximate:false};
 }
 const at=Number(trade.closedAt)||Number(trade.lastPriceAt)||openedAt;
 return {flows:Number.isFinite(at)&&at>0?[{at,amount:total}]:[],approximate:true};
}
export function fillPrice(reference,orderSide,{halfSpreadBps=1,slippageBps=2}={}){
 if(!validPrice(reference)||!['BUY','SELL'].includes(orderSide))throw Error('유효한 모의 체결 조건이 아님');
 return reference*(1+(orderSide==='BUY'?1:-1)*(Math.max(0,halfSpreadBps)+Math.max(0,slippageBps))/10000);
}
export function signalKey({market,symbol,direction,pattern,barAt}){
 return `${market}:${symbol}:${direction}:${pattern}:${barAt}`;
}
export function paperSummary(store,{now=Date.now(),settings=PAPER_DEFAULTS}={}){
 const done=store.closed||[],active=store.open||[];
 const closedRealized=done.reduce((s,x)=>s+x.realizedPnLUSD,0),openPartRealized=active.reduce((s,x)=>s+Number(x.realizedPnLUSD||0),0);
 const total=closedRealized+openPartRealized,winning=done.filter(x=>x.realizedPnLUSD>0);
 const grossWinning=done.reduce((s,x)=>s+Math.max(x.realizedPnLUSD,0),0),grossLosing=done.reduce((s,x)=>s+Math.max(-x.realizedPnLUSD,0),0);
 const unrealized=active.reduce((s,x)=>s+(validPrice(x.markPrice)?x.qtyRemaining*(x.direction==='LONG'?1:-1)*(x.markPrice-x.entryFill):0),0);
 // Cumulative PNL is centered at zero, without assuming initial deposit.
 let peak=0,maxDrawdownUSD=0,running=0;
 for(const r of [...done].sort((a,b)=>a.closedAt-b.closedAt)) {running+=r.realizedPnLUSD;peak=Math.max(peak,running);maxDrawdownUSD=Math.max(maxDrawdownUSD,peak-running)}
 const today=isoDay(now),week=isoWeek(now),cashFlows=[...done.map(t=>realizedCashFlows(t,true)),...active.map(t=>realizedCashFlows(t))];
 const daily=cashFlows.flatMap(x=>x.flows).filter(t=>isoDay(t.at)===today).reduce((s,x)=>s+x.amount,0);
 const weekly=cashFlows.flatMap(x=>x.flows).filter(t=>isoWeek(t.at)===week).reduce((s,x)=>s+x.amount,0);
 return {startingBalance:null,indicativeEquityUSD:null,paperNotionalUSD:settings.paperNotionalUSD,closedCount:done.length,openCount:active.length,pendingCount:(store.pending||[]).length,
  netRealizedUSD:rounded(total),closedTradeRealizedUSD:rounded(closedRealized),openPartialRealizedUSD:rounded(openPartRealized),unrealizedUSD:rounded(unrealized),totalMarkedPnLUSD:rounded(total+unrealized),winRatePct:done.length?rounded(winning.length/done.length*100):null,
  profitFactor:grossLosing>0?rounded(grossWinning/grossLosing):null,maxClosedTradeDrawdownUSD:rounded(maxDrawdownUSD),dailyPnLUSD:rounded(daily),weeklyPnLUSD:rounded(weekly),periodPnLApproximate:cashFlows.some(x=>x.approximate),
  totalFeesUSD:rounded(done.reduce((s,x)=>s+x.feesUSD,0)+active.reduce((s,x)=>s+x.feesUSD,0)),
  newPositionSizing:'VALIDATED_PROFILE_QUANTITY',legacyPaperNotionalUSD:settings.paperNotionalUSD,
  assumptions:`신규 매물대 거래는 검증된 수량·거래별 명시 비용 가정을 저장합니다. 구버전 모의 기준: 수수료 편도 ${settings.feeBps}bp + 슬리피지 편도 ${settings.slippageBps}bp + 스프레드 가정. 실제 체결 보장 없음 · 펀딩/청산/차입비용은 이 원장 PNL에 미반영`,fundingIncluded:false};
}
export class PaperEngine {
 constructor(seed={}, {now=()=>Date.now(),onChange=()=>{},onEvent=()=>{},settings={}}={}) {
  // A missing collection belongs to an older store format. A present but
  // malformed collection must never turn into [] and overwrite recoverable data.
  if(seed===null||typeof seed!=='object'||Array.isArray(seed))throw Error('모의매매 기록 구조 오류: paper는 객체여야 합니다. 기존 기록을 초기화하지 않습니다.');
  for(const key of ['pending','open','closed','skipped']){
   if(Object.hasOwn(seed,key)&&!Array.isArray(seed[key]))throw Error(`모의매매 기록 구조 오류: ${key}는 배열이어야 합니다. 기존 기록을 초기화하지 않습니다.`);
  }
  if(Object.hasOwn(seed,'seen')&&(seed.seen===null||typeof seed.seen!=='object'||Array.isArray(seed.seen)))throw Error('모의매매 기록 구조 오류: seen은 객체여야 합니다. 기존 기록을 초기화하지 않습니다.');
  this.now=now;this.onChange=onChange;this.onEvent=onEvent;this.settings={...PAPER_DEFAULTS,...settings};
  // Session-only activity counters. Historical PNL records remain in shared store.
  this.telemetry={sessionStartedAt:this.now(),priceTickCount:0,signalChecks:0,acceptedSignals:0,
    lastQuoteAt:0,lastSignalAt:0,lastAcceptedAt:0,lastPositionEventAt:0,openedCountSession:0,closedCountSession:0};
  this.store={pending:[],open:[],closed:[],skipped:[],seen:{}};
  if(seed&&typeof seed==='object')for(const key of ['pending','open','closed','skipped'])if(Array.isArray(seed[key]))this.store[key]=structuredClone(seed[key]);
  if(seed?.seen&&typeof seed.seen==='object'&&!Array.isArray(seed.seen))this.store.seen={...seed.seen};
 }
 snapshot(){const summary=paperSummary(this.store,{now:this.now(),settings:this.settings});return {...summary,
  pending:this.store.pending.slice(0,20),open:this.store.open.slice(0,20),closed:this.store.closed.slice(-200).reverse(),skipped:this.store.skipped.slice(-30).reverse(),
  updatedAt:this.now(),mode:'SIMULATION_ONLY',settings:{TP1_MOVE_STOP_TO_BREAKEVEN:this.settings.TP1_MOVE_STOP_TO_BREAKEVEN!==false,TP1_BREAKEVEN_MODE:this.settings.TP1_BREAKEVEN_MODE},sourceNotes:{CRYPTO:'Binance 실시간 시세 기준 모의 PNL. 실제 거래소 확정 체결·펀딩·계정 수수료와 다름',TRADFI:'대체 데이터 공급자 없음 · 신규 진입/시세 갱신 비활성 · 기존 기록 및 마지막 관측 PNL 보존'}}}
 // Only publish mutations after the persistence callback succeeds. A failed write
 // must not leave a phantom entry/CLOSE in memory or emit a Windows notification.
 #mutate(run){
  const before=this.store,telemetry={...this.telemetry};
  this.store={...before,pending:structuredClone(before.pending),open:structuredClone(before.open),
   closed:before.closed,skipped:[...before.skipped],seen:before.seen};
  try{return run()}catch(error){this.store=before;this.telemetry=telemetry;throw error}
 }
 notify(){this.onChange(this.store)}
 reject(key,reason,{remember=true}={}){if(this.store.seen[key])return false;if(remember)this.store.seen={...this.store.seen,[key]:this.now()};this.store.skipped.push({key,reason,at:this.now()});this.store.skipped=this.store.skipped.slice(-100);this.notify();return false}
 register(signal,{market='CRYPTO',symbol=signal?.symbol||signal?.ticker,quoteEligible=false}={}){
  return this.#mutate(()=>this.#register(signal,{market,symbol,quoteEligible}));
 }
 #register(signal,{market,symbol,quoteEligible}){
  if(market!=='CRYPTO')return false; // Disabled markets cannot mutate retained records.
  const now=this.now(),settings=this.settings;
  this.telemetry.signalChecks++;this.telemetry.lastSignalAt=now;
  const direction=signal?.direction;const entry=num(signal?.entry),stop=num(signal?.stop);
  const barAt=num(signal?.patternConfirmedAt||signal?.lastBarAt||0),pattern=String(signal?.pattern||'');
  if(market!=='CRYPTO'||!symbol||!['LONG','SHORT'].includes(direction)||!pattern||!validPrice(entry)||!validPrice(stop)||
   (direction==='LONG'&&stop>=entry)||(direction==='SHORT'&&stop<=entry)||!Number.isFinite(barAt)||barAt<=0||barAt>now+60000||now-barAt>2*3600000)return false;
  const key=signalKey({market,symbol,direction,pattern,barAt});if(this.store.seen[key])return false;
  if(!quoteEligible)return this.reject(key,'상장/호가/진입 검증 실패');
  if(this.store.open.some(x=>x.symbol===symbol&&x.market===market)||this.store.pending.some(x=>x.symbol===symbol&&x.market===market))return this.reject(key,'동일 종목 중복 가상 포지션 방지');
  if(this.store.open.length+this.store.pending.length>=settings.maxPositions)return this.reject(key,'동시 포지션 상한');
  const managementVersion=signal.managementVersion,profile=managementVersion==='VOLUME_PROFILE_V1',
   legacy=managementVersion==='LEGACY_R_MULTIPLES'||managementVersion==='LEGACY_R_V1',plan=signal.targetPlan;
  if(!profile&&!legacy)return this.reject(key,'TP_PROFILE_UNAVAILABLE',{remember:false});
  if(profile&&(plan?.ok!==true||!plan.profileEvidence||!Array.isArray(plan.targets)||plan.targets.length!==3||
   !Array.isArray(plan.parts)||plan.parts.length!==3||plan.parts.some((part,i)=>!Number.isFinite(part?.fraction)||Math.abs(part.fraction-[.4,.35,.25][i])>1e-10)))
   return this.reject(key,'TP_PROFILE_UNAVAILABLE',{remember:false});
  const executionVenue=EXECUTION_VENUES.includes(signal.executionVenue)?signal.executionVenue:null;
  if(settings.requireExecutionVenue===true&&!executionVenue)return this.reject(key,'EXECUTION_VENUE_UNAVAILABLE',{remember:false});
  const breakevenMode=signal.breakevenMode??settings.TP1_BREAKEVEN_MODE;
  if(profile&&!['ENTRY_FILL','COST_COVERED'].includes(breakevenMode))return this.reject(key,'BREAKEVEN_COST_MODEL_UNVERIFIED',{remember:false});
  const targets=(profile?plan.targets:Array.isArray(signal.targets)&&signal.targets.length===3?signal.targets:[2,3,4].map(r=>entry+(direction==='LONG'?1:-1)*Math.abs(entry-stop)*r)).map(num);
  const plannedQuantity=profile?(validPrice(plan.quantity)?plan.quantity:plan.parts.every(part=>validPrice(part?.quantity))?plan.parts.reduce((sum,part)=>sum+part.quantity,0):null):null;
  if(profile&&(!validPrice(plannedQuantity)||plan.quantityUnit!=='BASE_ASSET'||plan.notionalCurrency!=='USDT'||!Number.isFinite(plan.minNotional)||plan.minNotional<0||
   plan.parts.some((part,i)=>!validPrice(part.quantity)||Math.abs(part.quantity-plannedQuantity*[.4,.35,.25][i])>Math.max(1e-12,plannedQuantity*1e-9))))
   return this.reject(key,'TP_QUANTITY_UNVERIFIED',{remember:false});
  if(profile&&(!validPrice(plan.quantityStep)||!validPrice(plan.minQuantity)||!validPrice(plan.tickSize)||
   !onGrid(plannedQuantity,plan.quantityStep)||plannedQuantity<plan.minQuantity||
   plan.parts.some((part,i)=>part.quantity<plan.minQuantity||!onGrid(part.quantity,plan.quantityStep)||!onGrid(targets[i],plan.tickSize)||
    part.quantity*targets[i]<plan.minNotional)))return this.reject(key,'TP_QUANTITY_OR_NOTIONAL_INVALID',{remember:false});
  const costs=profile?plan.costAssumptions:null;
  if(profile&&(!costs||!['EXPLICIT_PAPER_ASSUMPTIONS','SYNTHETIC_TEST','VERIFIED_VENUE'].includes(costs.assumption)||
   !Number.isFinite(costs.takerRate)||costs.takerRate<0||costs.takerRate>.01||!Number.isFinite(costs.slippageBps)||costs.slippageBps<0||
   !Number.isFinite(costs.spreadBps)||costs.spreadBps<0))return this.reject(key,'TP_COSTS_UNVERIFIED',{remember:false});
  if(profile&&breakevenMode==='COST_COVERED'&&(costs.spreadBps/2+costs.slippageBps)/10000>=1)
   return this.reject(key,'BREAKEVEN_COST_MODEL_UNVERIFIED',{remember:false});
  if(targets.some(p=>!validPrice(p))||targets.some((p,i)=>direction==='LONG'?p<=entry||(i>0&&p<=targets[i-1]):p>=entry||(i>0&&p>=targets[i-1])))return this.reject(key,'목표가 데이터 불일치',{remember:false});
  this.store.seen={...this.store.seen,[key]:now};
  // Optional per-signal limits (scalp mode): a shorter entry window and a time stop.
  const entryTimeoutMs=Number.isFinite(signal.entryTimeoutMs)&&signal.entryTimeoutMs>=60000?Math.min(signal.entryTimeoutMs,settings.entryTimeoutMs):settings.entryTimeoutMs;
  const maxHoldMs=Number.isFinite(signal.maxHoldMs)&&signal.maxHoldMs>=5*60000&&signal.maxHoldMs<=7*86400000?signal.maxHoldMs:null;
  // Zone scale-in plan (paper): adds against the position, each beyond the previous, all before the stop.
  let dca=null;
  if(signal.dca){
   const d=signal.dca,dir=direction==='LONG'?1:-1,adds=Array.isArray(d.adds)?d.adds:[];
   const valid=profile&&d.ok===true&&adds.length<=9&&adds.every((a,i)=>validPrice(a?.price)&&validPrice(a?.quantity)&&dir*(entry-a.price)>0&&(i===0||dir*(adds[i-1].price-a.price)>0)&&dir*(a.price-stop)>0)&&
    num(d.stop)===stop&&validPrice(d.unitQty)&&Math.abs(d.unitQty-plan.quantity)<=plan.quantity*1e-9;
   if(!valid)return this.reject(key,'DCA_PLAN_INVALID',{remember:false});
   dca={...structuredClone(d),adds:adds.map(a=>({...structuredClone(a),filled:false})),filledAdds:0};
  }
  this.store.pending.push({key,market,symbol,direction,pattern,barAt,signalPrice:entry,stop,targets,atr:Number(signal?.atr)||0,signalAt:now,expiresAt:now+entryTimeoutMs,
   ...(dca?{dca}:{}),
   ...(maxHoldMs?{maxHoldMs}:{}),...(typeof signal.strategy==='string'&&/^[A-Z0-9_]{1,40}$/.test(signal.strategy)?{strategy:signal.strategy}:{}),
   ...(executionVenue?{executionVenue,venueSymbol:typeof signal.venueSymbol==='string'?signal.venueSymbol:null,venueContract:signal.venueContract?structuredClone(signal.venueContract):null}:{}),
   ...(profile?{managementVersion:'VOLUME_PROFILE_V1',targetPlan:structuredClone(plan),plannedQuantity,
    moveStopToBreakeven:typeof signal.moveStopToBreakeven==='boolean'?signal.moveStopToBreakeven:settings.TP1_MOVE_STOP_TO_BREAKEVEN!==false,
    breakevenMode,breakevenMoved:false,costAssumptions:structuredClone(costs)}: {managementVersion:'LEGACY_R_MULTIPLES'})});
  this.telemetry.acceptedSignals++;this.telemetry.lastAcceptedAt=now;this.telemetry.lastPositionEventAt=now;
  this.notify();return true;
 }
 onPrice(market,symbol,price,at,{halfSpreadBps=null,quoteFresh=true,entryAllowed=true,exitQuantityLimit=null,venue=null}={}){
  return this.#mutate(()=>this.#onPrice(market,symbol,price,at,{halfSpreadBps,quoteFresh,entryAllowed,exitQuantityLimit,venue}));
 }
 #onPrice(market,symbol,price,at,{halfSpreadBps,quoteFresh,entryAllowed,exitQuantityLimit,venue}){
  // A venue price only moves records executed on that venue (null = any, for callers without venues).
  const otherVenue=record=>venue!==null&&venueOf(record)!==venue;
  if(market!=='CRYPTO')return 0; // No replacement feed: freeze retained positions and pending entries.
  const settings=this.settings,now=this.now();price=num(price);at=num(at);
  const maxFresh=settings.maxFreshMsCrypto;
  if(!quoteFresh||!validPrice(price)||!Number.isFinite(at)||at>now+5000||now-at>maxFresh)return 0;
  this.telemetry.priceTickCount++;this.telemetry.lastQuoteAt=now;
  let modified=0;const events=[];
  for(const pending of [...this.store.pending]){
   // Losing listing/quote approval blocks new entries, never risk monitoring of
   // positions that were already opened under a previously approved listing.
   if(!entryAllowed)continue;
   if(pending.market!==market||pending.symbol!==symbol||otherVenue(pending))continue;
   // A first real observation AFTER signal detection is required. No past price is replayed.
   if(at<=pending.signalAt)continue;
   this.store.pending=this.store.pending.filter(x=>x.key!==pending.key);
   if(at>pending.expiresAt||now>pending.expiresAt){this.store.skipped.push({key:pending.key,reason:'신호 진입 유효기간 종료',at:now});modified++;continue}
   const dir=pending.direction==='LONG'?1:-1;
   if(dir*(price-pending.stop)<=0||dir*(price-pending.targets[0])>=0){this.store.skipped.push({key:pending.key,reason:'첫 실시간 관측 시 손절선/목표가 이미 통과',at:now});modified++;continue}
   const deviation=Math.abs(price-pending.signalPrice)/pending.signalPrice;
   if(deviation>entryAllowance({entry:pending.signalPrice,stop:pending.stop,atr:pending.atr})){
    this.store.skipped.push({key:pending.key,reason:'신호 진입 기준가 대비 가격 이탈',at:now});modified++;continue;
   }
   const profile=pending.managementVersion==='VOLUME_PROFILE_V1',feeBps=profile?pending.costAssumptions.takerRate*10000:settings.feeBps,
    slippageBps=profile?pending.costAssumptions.slippageBps:settings.slippageBps;
   const spread=Number.isFinite(num(halfSpreadBps))&&halfSpreadBps!==null?num(halfSpreadBps):profile?pending.costAssumptions.spreadBps/2:settings.cryptoHalfSpreadBps;
   const entryFill=fillPrice(price,pending.direction==='LONG'?'BUY':'SELL',{halfSpreadBps:spread,slippageBps});
   const stopFill=fillPrice(pending.stop,pending.direction==='LONG'?'SELL':'BUY',{halfSpreadBps:spread,slippageBps});
   if(dir*(entryFill-pending.stop)<=0){this.store.skipped.push({key:pending.key,reason:'스프레드 반영 후 진입 가격 무효',at:now});modified++;continue}
   // Legacy fixed sizing is retained only for historical/synthetic compatibility.
   // New profile positions use explicit quantity, exchange filters and risk limits.
   const n=profile?pending.plannedQuantity*entryFill:settings.paperNotionalUSD,minimumNotional=profile?pending.targetPlan.minNotional:settings.minNotional;
   if(!Number.isFinite(n)||!Number.isFinite(minimumNotional)||minimumNotional<0||n<minimumNotional||n>settings.maxNotional){this.store.skipped.push({key:pending.key,reason:'모의 거래 명목금액이 호가 샘플 검증 범위를 벗어남',at:now});modified++;continue}
   const quantity=profile?pending.plannedQuantity:n/entryFill,feesUSD=n*feeBps/10000;
   const plannedLossUSD=quantity*(dir*(entryFill-stopFill)+(entryFill+stopFill)*feeBps/10000);
   // A zone scale-in plan carries its own balance-based loss check instead of the per-trade cap.
   if(profile&&!pending.dca&&(!validPrice(settings.maxRiskUSD)||!Number.isFinite(plannedLossUSD)||plannedLossUSD>settings.maxRiskUSD+1e-9)){
    this.store.skipped.push({key:pending.key,reason:'체결 비용 반영 최대 손실 한도 초과',at:now});modified++;continue;
   }
   if(profile&&pending.targets.some((p,i)=>dir*(p-entryFill)<=0||i>0&&dir*(p-pending.targets[i-1])<=0)){
    this.store.skipped.push({key:pending.key,reason:'실제 가상 진입체결 후 목표가 방향 무효',at:now});modified++;continue;
   }
   this.store.open.push({...pending,openedAt:at,entryRefPrice:price,entryFill,initialStop:pending.stop,notionalUSD:rounded(n),originalQty:quantity,qtyRemaining:quantity,
     exitedPct:0,realizedGrossUSD:0,feesUSD,realizedPnLUSD:-feesUSD,closeParts:[],markPrice:price,lastPriceAt:at,
     halfSpreadBps:spread,quoteGaps:0,...(profile?{plannedLossUSD,feeBps,slippageBps,managementEvents:[],targetQuantities:[quantity*.4,quantity*.35,quantity-quantity*.4-quantity*.35]}:{})});
   events.push({type:'OPEN',key:pending.key,market,symbol,direction:pending.direction,at,entryFill,notionalUSD:rounded(n),stop:pending.stop});
   this.telemetry.openedCountSession++;this.telemetry.lastPositionEventAt=now;modified++;
  }
  for(const position of [...this.store.open]){
   if(position.market!==market||position.symbol!==symbol||otherVenue(position)||at<=position.lastPriceAt)continue;
   const maxGap=settings.maxQuoteGapMsCrypto;
   if(at-position.lastPriceAt>maxGap)position.quoteGaps++;
   position.lastPriceAt=at;position.markPrice=price;
   const dir=position.direction==='LONG'?1:-1;
   const spread=halfSpreadBps===null?position.halfSpreadBps:Math.max(0,num(halfSpreadBps)||0);
   const crossedStop=dir*(price-position.stop)<=0;
   // Zone scale-in: before any target fill, each zone reached adds its size at the zone price.
   if(position.dca&&!crossedStop&&!position.closeParts.some(x=>x.type==='TARGET')){
    for(const level of position.dca.adds){
     if(level.filled)continue;
     if(dir*(price-level.price)>0)break;
     const fill=fillPrice(level.price,dir===1?'BUY':'SELL',{halfSpreadBps:spread,slippageBps:position.slippageBps}),q=level.quantity,fee=q*fill*position.feeBps/10000;
     const total=position.qtyRemaining+q;
     position.entryFill=(position.entryFill*position.qtyRemaining+fill*q)/total;
     position.originalQty+=q;position.qtyRemaining=total;position.notionalUSD=rounded(position.notionalUSD+q*fill);
     position.feesUSD+=fee;position.realizedPnLUSD-=fee;
     position.targetQuantities=[position.originalQty*.4,position.originalQty*.35,position.originalQty-position.originalQty*.4-position.originalQty*.35];
     Object.assign(level,{filled:true,fill,at});position.dca.filledAdds++;
     position.plannedLossUSD=rounded(position.qtyRemaining*Math.max(0,dir*(position.entryFill-position.stop)));
     position.managementEvents=[...(position.managementEvents??[]),{type:'DCA_ADD',at,number:position.dca.filledAdds,units:level.units,price:level.price,fill,quantity:q,averageEntry:position.entryFill}];
     modified++;
    }
   }
   let budget=exitQuantityLimit===null?Infinity:Number.isFinite(exitQuantityLimit)&&exitQuantityLimit>0?exitQuantityLimit:0;
   const tolerance=Math.max(1e-12,position.originalQty*1e-10);
   if(crossedStop){
    const quantity=Math.min(position.qtyRemaining,budget);
    if(quantity>tolerance){this.#exitPart(position,quantity,price,'STOP',at,spread);modified++;
     if(position.qtyRemaining<=tolerance)events.push(this.#finalize(position,at,'STOP'));
    }
    continue;
   }
   // Time stop (scalp mode): whatever is left closes at the current price.
   if(Number.isFinite(position.maxHoldMs)&&at-position.openedAt>=position.maxHoldMs){
    const quantity=Math.min(position.qtyRemaining,budget);
    if(quantity>tolerance){this.#exitPart(position,quantity,price,'TIME',at,spread);modified++;
     if(position.qtyRemaining<=tolerance)events.push(this.#finalize(position,at,'TIME_STOP'));
    }
    continue;
   }
   const quantities=position.targetQuantities??[position.originalQty*.4,position.originalQty*.35,position.originalQty-position.originalQty*.4-position.originalQty*.35];
   while(position.qtyRemaining>tolerance&&budget>tolerance){
    const fills=position.closeParts.filter(x=>x.type==='TARGET');
    let next=0;
    while(next<3&&fills.filter(x=>x.targetNumber===next+1).reduce((sum,x)=>sum+x.qty,0)>=quantities[next]-tolerance)next++;
    if(next>=3||dir*(price-position.targets[next])<0)break;
    const already=fills.filter(x=>x.targetNumber===next+1).reduce((sum,x)=>sum+x.qty,0),
     quantity=Math.min(quantities[next]-already,position.qtyRemaining,budget);
    if(quantity<=tolerance)break;
    this.#exitPart(position,quantity,position.targets[next],'TARGET',at,spread,next+1);budget-=quantity;
    position.exitedPct=rounded((position.originalQty-position.qtyRemaining)/position.originalQty*100);modified++;
    const completed=already+quantity>=quantities[next]-tolerance;
    if(next===0&&completed)this.#moveStopAfterTP1(position,at);
    if(position.qtyRemaining<=tolerance){position.exitedPct=100;events.push(this.#finalize(position,at,'ALL_TARGETS'));break}
   }
  }
  if(modified){this.telemetry.lastPositionEventAt=now;this.store.skipped=this.store.skipped.slice(-100);this.notify();for(const event of events){try{this.onEvent(event)}catch(e){console.warn('[PAPER EVENT CALLBACK]',e.message)}}}
  return modified;
 }
 #moveStopAfterTP1(position,at){
  if(position.managementVersion!=='VOLUME_PROFILE_V1'){position.stop=position.entryFill;return}
  if(position.moveStopToBreakeven!==true||position.breakevenMoved===true)return;
  const dir=position.direction==='LONG'?1:-1;
  let next=position.entryFill,costModel=null;
  if(position.breakevenMode==='COST_COVERED'){
   const fee=position.feeBps/10000,friction=(position.halfSpreadBps+position.slippageBps)/10000,tick=position.targetPlan?.tickSize;
   if(!Number.isFinite(fee)||fee<0||fee>=1||!Number.isFinite(friction)||friction<0||friction>=1||!validPrice(tick))return;
   // Cover only the remaining position's allocated entry fee and expected exit
   // costs. TP1 proceeds are never used to claim a lower break-even price.
   const raw=dir===1?position.entryFill*(1+fee)/((1-friction)*(1-fee)):
    position.entryFill*(1-fee)/((1+friction)*(1+fee));
   try{next=quantizeVolumeStep(raw,tick,dir===1?'UP':'DOWN')}catch{return}
   costModel={basis:'EXPLICIT_SIMULATION_ASSUMPTIONS_NOT_ACCOUNT_COST_PROOF',feeRate:fee,exitFrictionRate:friction,
    entryFill:position.entryFill,tickSize:tick,rawPrice:raw,accountRateVerified:position.costAssumptions?.accountRateVerified===true,
    fundingCovered:false,tp1ProceedsUsed:false};
  }
  if(!validPrice(next)||dir*(next-position.stop)<0)return;
  const filled=position.closeParts.filter(x=>x.type==='TARGET'&&x.targetNumber===1).reduce((sum,x)=>sum+x.qty,0),
   required=position.originalQty*.4,tolerance=Math.max(1e-12,position.originalQty*1e-10);
  if(filled<required-tolerance)return;
  const previousStop=position.stop;position.stop=next;position.breakevenMoved=true;position.breakevenMovedAt=at;
  position.managementEvents??=[];
  position.managementEvents.push({type:'STOP_TO_BREAKEVEN',at,previousStop,stop:next,source:'CONFIRMED_SIMULATED_TP1_FILLS',filledTP1Quantity:filled,requiredTP1Quantity:required,
   mode:position.breakevenMode??'ENTRY_FILL',...(costModel?{costModel}: {})});
 }
 #exitPart(position,qty,reference,type,at,halfSpreadBps,targetNumber=null){
  const executed=fillPrice(reference,position.direction==='LONG'?'SELL':'BUY',{halfSpreadBps,slippageBps:Number.isFinite(position.slippageBps)?position.slippageBps:this.settings.slippageBps});
  const profit=qty*(position.direction==='LONG'?1:-1)*(executed-position.entryFill);
  const fee=qty*executed*(Number.isFinite(position.feeBps)?position.feeBps:this.settings.feeBps)/10000;
  position.qtyRemaining=Math.max(0,position.qtyRemaining-qty);position.realizedGrossUSD+=profit;
  position.feesUSD+=fee;position.realizedPnLUSD=position.realizedGrossUSD-position.feesUSD;
  position.closeParts.push({type,targetNumber,at,reference,fill:executed,qty,profitUSD:rounded(profit),feeUSD:rounded(fee),
   ...(type==='STOP'?{stopReference:position.stop,observedStopGapUSD:rounded(qty*Math.max(0,(position.direction==='LONG'?1:-1)*(position.stop-reference))),
    executionBeyondStopUSD:rounded(qty*Math.max(0,(position.direction==='LONG'?1:-1)*(position.stop-executed)))}:{})});
 }
 #finalize(position,at,reason){
  this.store.open=this.store.open.filter(x=>x.key!==position.key);
  position.status='CLOSED';position.closedAt=at;position.closeReason=reason;position.realizedPnLUSD=rounded(position.realizedPnLUSD);
  position.feesUSD=rounded(position.feesUSD);position.realizedGrossUSD=rounded(position.realizedGrossUSD);
  this.store.closed=[...this.store.closed,position]; // no history cap: keep lifetime PNL across updates
  this.telemetry.closedCountSession++;this.telemetry.lastPositionEventAt=this.now();
  return {type:'CLOSE',key:position.key,market:position.market,symbol:position.symbol,direction:position.direction,
    at,entryFill:position.entryFill,lastExitFill:position.closeParts.at(-1)?.fill,closeReason:reason,
    realizedPnLUSD:position.realizedPnLUSD,feesUSD:position.feesUSD};
 }
 /** Manual stop/target change for a pending or open position. Prices are rounded to
  * the position's tick. Filled targets are locked. Returns {ok,levels|reasons}; with
  * dryRun nothing changes (used to validate before touching a live order). */
 setLevels(key,{stop=null,targets=null}={},{dryRun=false,source='MANUAL'}={}){
  const run=()=>{
   const position=this.store.open.find(x=>x.key===key),pending=position?null:this.store.pending.find(x=>x.key===key),record=position??pending;
   if(!record)return {ok:false,reasons:['POSITION_NOT_FOUND']};
   const dir=record.direction==='LONG'?1:-1,tick=Number(record.targetPlan?.tickSize??record.venueContract?.tickSize)||null;
   const round=value=>{const n=num(value);if(!validPrice(n))return NaN;if(!tick)return n;try{const down=quantizeVolumeStep(n,tick,'DOWN'),up=quantizeVolumeStep(n,tick,'UP');return n-down<=up-n&&down>0?down:up}catch{return NaN}};
   const reference=position?num(position.markPrice):num(pending.signalPrice),entry=position?num(position.entryFill):num(pending.signalPrice);
   const quantities=position?.targetQuantities??null,fills=position?position.closeParts.filter(x=>x.type==='TARGET'):[];
   const tolerance=position?Math.max(1e-12,position.originalQty*1e-10):0;
   const filled=[0,1,2].map(i=>Boolean(position)&&(quantities?fills.filter(x=>x.targetNumber===i+1).reduce((a,x)=>a+x.qty,0)>=quantities[i]-tolerance:fills.some(x=>x.targetNumber===i+1)));
   const nextStop=stop===null||stop===undefined||stop===''?record.stop:round(stop);
   const reasons=[];
   if(!validPrice(nextStop))reasons.push('STOP_INVALID');
   else if(!(dir*(reference-nextStop)>0))reasons.push('STOP_ALREADY_CROSSED');
   let nextTargets=[...record.targets];
   if(targets!==null&&targets!==undefined){
    if(!Array.isArray(targets)||targets.length!==3)reasons.push('TARGETS_NEED_THREE');
    else targets.forEach((value,i)=>{
     if(value===null||value===undefined||value==='')return;
     const price=round(value);
     if(filled[i]){if(Math.abs(price-record.targets[i])>(tick||1e-12)/2)reasons.push(`TP${i+1}_ALREADY_FILLED`);return}
     if(!validPrice(price))reasons.push(`TP${i+1}_INVALID`);else nextTargets[i]=price;
    });
   }
   nextTargets.forEach((price,i)=>{
    if(filled[i])return;
    if(!(dir*(price-reference)>0))reasons.push(`TP${i+1}_NOT_BEYOND_PRICE`);
    if(!(dir*(price-entry)>0))reasons.push(`TP${i+1}_NOT_BEYOND_ENTRY`);
    if(i>0&&!(dir*(price-nextTargets[i-1])>0))reasons.push(`TP${i+1}_ORDER`);
   });
   if(validPrice(nextStop)&&nextTargets.some((price,i)=>!filled[i]&&!(dir*(price-nextStop)>0)))reasons.push('STOP_BEYOND_TARGET');
   if(reasons.length)return {ok:false,reasons:[...new Set(reasons)]};
   const levels={key,stop:nextStop,targets:nextTargets,previousStop:record.stop,previousTargets:[...record.targets],filled,state:position?'OPEN':'PENDING',
    changed:nextStop!==record.stop||nextTargets.some((p,i)=>p!==record.targets[i])};
   if(dryRun||!levels.changed)return {ok:true,levels};
   const at=this.now();record.stop=nextStop;record.targets=nextTargets;record.manualLevels=true;
   record.managementEvents=[...(record.managementEvents??[]),{type:'MANUAL_LEVELS',at,source,previousStop:levels.previousStop,stop:nextStop,previousTargets:levels.previousTargets,targets:nextTargets}];
   if(position&&validPrice(position.originalQty)&&validPrice(position.entryFill))position.plannedLossUSD=rounded(position.qtyRemaining*Math.max(0,dir*(position.entryFill-nextStop)));
   this.telemetry.lastPositionEventAt=at;this.notify();
   return {ok:true,levels};
  };
  return dryRun?run():this.#mutate(run);
 }
 expirePending(){return this.#mutate(()=>this.#expirePending())}
 #expirePending(){let count=0;const now=this.now();for(const p of [...this.store.pending])if(p.market==='CRYPTO'&&now>p.expiresAt){this.store.pending=this.store.pending.filter(x=>x.key!==p.key);this.store.skipped.push({key:p.key,reason:'20분 이내 새 시세가 없어 진입 생략',at:now});count++}
  if(count){this.telemetry.lastPositionEventAt=now;this.notify()}return count}
}
export function paperCSV(rows=[]){const cols=['market','executionVenue','symbol','direction','pattern','openedAt','closedAt','entryFill','stop','notionalUSD','closeReason','realizedGrossUSD','feesUSD','realizedPnLUSD','quoteGaps'];
 return '\uFEFF'+cols.join(',')+'\r\n'+rows.map(x=>cols.map(k=>{let v=k==='executionVenue'?venueOf(x):x[k]??'';if(k.endsWith('At')&&Number(v))v=new Date(v).toISOString();return '"'+String(v).replaceAll('"','""')+'"'}).join(',')).join('\r\n');}
