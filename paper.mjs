/** Forward-only, simulated execution from subsequently observed public market prices.
 * No trading credentials, no venue orders, no backfills. Indicative prices are NOT fills.
 * Long/short PNL: signed quantity * (exit - entry) minus synthetic taker fees.
 */
import {entryAllowance} from './public/trade_plan.js';

export const PAPER_DEFAULTS=Object.freeze({startingBalance:1000,riskUSD:6,maxPositions:2,maxNotional:1500,minNotional:100,maxDailyLoss:15,maxWeeklyLoss:40,
 feeBps:5,slippageBps:2,cryptoHalfSpreadBps:1,entryTimeoutMs:20*60000,maxFreshMsCrypto:90000,maxFreshMsTradFi:180000,
 maxQuoteGapMsCrypto:120000,maxQuoteGapMsTradFi:240000});
const num=v=>Number(v);
const validPrice=p=>Number.isFinite(p)&&p>0;
const isoDay=(at)=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Seoul',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(at));
const isoWeek=(at)=>{const d=new Date(at+9*3600000);let dow=(d.getUTCDay()+6)%7;d.setUTCDate(d.getUTCDate()-dow);return d.toISOString().slice(0,10)};
const rounded=v=>Math.round(v*100000000)/100000000;
// Reconstruct cash flows without rewriting historical records. Fees have already
// been charged in each trade, so changing today's fee settings must not restate PNL.
function realizedCashFlows(trade){
 const total=Number(trade.realizedPnLUSD)||0;
 const openedAt=Number(trade.openedAt),parts=trade.closeParts;
 if(Number.isFinite(openedAt)&&openedAt>0&&Array.isArray(parts)&&Number.isFinite(Number(trade.feesUSD))&&
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
 const marketValue=settings.startingBalance+total+unrealized;
 let peak=settings.startingBalance,maxDrawdownUSD=0,running=settings.startingBalance;
 for(const r of [...done].sort((a,b)=>a.closedAt-b.closedAt)) {running+=r.realizedPnLUSD;peak=Math.max(peak,running);maxDrawdownUSD=Math.max(maxDrawdownUSD,peak-running)}
 const today=isoDay(now),week=isoWeek(now),cashFlows=[...done,...active].map(realizedCashFlows);
 const daily=cashFlows.flatMap(x=>x.flows).filter(t=>isoDay(t.at)===today).reduce((s,x)=>s+x.amount,0);
 const weekly=cashFlows.flatMap(x=>x.flows).filter(t=>isoWeek(t.at)===week).reduce((s,x)=>s+x.amount,0);
 return {startingBalance:settings.startingBalance,closedCount:done.length,openCount:active.length,pendingCount:(store.pending||[]).length,
  netRealizedUSD:rounded(total),closedTradeRealizedUSD:rounded(closedRealized),openPartialRealizedUSD:rounded(openPartRealized),unrealizedUSD:rounded(unrealized),indicativeEquityUSD:rounded(marketValue),winRatePct:done.length?rounded(winning.length/done.length*100):null,
  profitFactor:grossLosing>0?rounded(grossWinning/grossLosing):null,maxClosedTradeDrawdownUSD:rounded(maxDrawdownUSD),dailyPnLUSD:rounded(daily),weeklyPnLUSD:rounded(weekly),periodPnLApproximate:cashFlows.some(x=>x.approximate),
  totalFeesUSD:rounded(done.reduce((s,x)=>s+x.feesUSD,0)+active.reduce((s,x)=>s+x.feesUSD,0)),
  assumptions:`모의 시장가 · 수수료 편도 ${settings.feeBps}bp + 슬리피지 편도 ${settings.slippageBps}bp + 스프레드 가정 · 펀딩/청산/차입비용 미반영`,fundingIncluded:false};
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
  updatedAt:this.now(),mode:'SIMULATION_ONLY',sourceNotes:{CRYPTO:'Binance 실시간 시세 기준 모의 PNL. Variational 확정 체결·펀딩·수수료와 다름',TRADFI:'Variational 공개 Mark Price/호가 스냅샷 기준. 갭·휴장·체결 가능성 검증 불가'}}}
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
  const now=this.now(),settings=this.settings;
  this.telemetry.signalChecks++;this.telemetry.lastSignalAt=now;
  const direction=signal?.direction;const entry=num(signal?.entry),stop=num(signal?.stop);
  const barAt=num(signal?.patternConfirmedAt||signal?.lastBarAt||0),pattern=String(signal?.pattern||'');
  if(!['CRYPTO','TRADFI'].includes(market)||!symbol||!['LONG','SHORT'].includes(direction)||!pattern||!validPrice(entry)||!validPrice(stop)||
   (direction==='LONG'&&stop>=entry)||(direction==='SHORT'&&stop<=entry)||!Number.isFinite(barAt)||barAt<=0||barAt>now+60000||now-barAt>2*3600000)return false;
  const key=signalKey({market,symbol,direction,pattern,barAt});if(this.store.seen[key])return false;
  if(!quoteEligible)return this.reject(key,'상장/호가/진입 검증 실패');
  if(this.store.open.some(x=>x.symbol===symbol&&x.market===market)||this.store.pending.some(x=>x.symbol===symbol&&x.market===market))return this.reject(key,'동일 종목 중복 가상 포지션 방지');
  const summary=paperSummary(this.store,{now,settings});
  if(this.store.open.length+this.store.pending.length>=settings.maxPositions)return this.reject(key,'동시 포지션 상한');
  if(summary.dailyPnLUSD<=-settings.maxDailyLoss||summary.weeklyPnLUSD<=-settings.maxWeeklyLoss)return this.reject(key,'일간/주간 손실 경고 상한');
  const targets=(Array.isArray(signal.targets)&&signal.targets.length===3?signal.targets:[2,3,4].map(r=>entry+(direction==='LONG'?1:-1)*Math.abs(entry-stop)*r)).map(num);
  if(targets.some(p=>!validPrice(p))||targets.some((p,i)=>direction==='LONG'?p<=entry||(i>0&&p<=targets[i-1]):p>=entry||(i>0&&p>=targets[i-1])))return this.reject(key,'목표가 데이터 불일치',{remember:false});
  this.store.seen={...this.store.seen,[key]:now};
  this.store.pending.push({key,market,symbol,direction,pattern,barAt,signalPrice:entry,stop,targets,atr:Number(signal?.atr)||0,signalAt:now,expiresAt:now+settings.entryTimeoutMs});
  this.telemetry.acceptedSignals++;this.telemetry.lastAcceptedAt=now;this.telemetry.lastPositionEventAt=now;
  this.notify();return true;
 }
 onPrice(market,symbol,price,at,{halfSpreadBps=null,quoteFresh=true,entryAllowed=true}={}){
  return this.#mutate(()=>this.#onPrice(market,symbol,price,at,{halfSpreadBps,quoteFresh,entryAllowed}));
 }
 #onPrice(market,symbol,price,at,{halfSpreadBps,quoteFresh,entryAllowed}){
  const settings=this.settings,now=this.now();price=num(price);at=num(at);
  const maxFresh=market==='TRADFI'?settings.maxFreshMsTradFi:settings.maxFreshMsCrypto;
  if(!quoteFresh||!validPrice(price)||!Number.isFinite(at)||at>now+5000||now-at>maxFresh)return 0;
  this.telemetry.priceTickCount++;this.telemetry.lastQuoteAt=now;
  let modified=0;const events=[];
  for(const pending of [...this.store.pending]){
   // Losing listing/quote approval blocks new entries, never risk monitoring of
   // positions that were already opened under a previously approved listing.
   if(!entryAllowed)continue;
   if(pending.market!==market||pending.symbol!==symbol)continue;
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
   const spread=Number.isFinite(num(halfSpreadBps))&&halfSpreadBps!==null?num(halfSpreadBps):settings.cryptoHalfSpreadBps;
   const entryFill=fillPrice(price,pending.direction==='LONG'?'BUY':'SELL',{halfSpreadBps:spread,slippageBps:settings.slippageBps});
   const stopFill=fillPrice(pending.stop,pending.direction==='LONG'?'SELL':'BUY',{halfSpreadBps:spread,slippageBps:settings.slippageBps});
   if(dir*(entryFill-pending.stop)<=0){this.store.skipped.push({key:pending.key,reason:'스프레드 반영 후 진입 가격 무효',at:now});modified++;continue}
   // Size against modeled stop INCLUDING two fees, spread and slippage, but not gaps.
   const costPerDollar=(Math.abs(entryFill-stopFill)+settings.feeBps/10000*(entryFill+stopFill))/entryFill;
   const n=Math.min(settings.maxNotional,settings.riskUSD/costPerDollar);
   if(!Number.isFinite(n)||n<settings.minNotional){this.store.skipped.push({key:pending.key,reason:'비용 포함 위험 한도에 맞는 최소 명목금액 미충족',at:now});modified++;continue}
   const quantity=n/entryFill,feesUSD=n*settings.feeBps/10000;
   this.store.open.push({...pending,openedAt:at,entryRefPrice:price,entryFill,initialStop:pending.stop,notionalUSD:rounded(n),originalQty:quantity,qtyRemaining:quantity,
     exitedPct:0,realizedGrossUSD:0,feesUSD,realizedPnLUSD:-feesUSD,closeParts:[],markPrice:price,lastPriceAt:at,
     halfSpreadBps:spread,quoteGaps:0});
   events.push({type:'OPEN',key:pending.key,market,symbol,direction:pending.direction,at,entryFill,notionalUSD:rounded(n),stop:pending.stop});
   this.telemetry.openedCountSession++;this.telemetry.lastPositionEventAt=now;modified++;
  }
  for(const position of [...this.store.open]){
   if(position.market!==market||position.symbol!==symbol||at<=position.lastPriceAt)continue;
   const maxGap=market==='TRADFI'?settings.maxQuoteGapMsTradFi:settings.maxQuoteGapMsCrypto;
   if(at-position.lastPriceAt>maxGap)position.quoteGaps++;
   position.lastPriceAt=at;position.markPrice=price;
   const dir=position.direction==='LONG'?1:-1;
   const spread=halfSpreadBps===null?position.halfSpreadBps:Math.max(0,num(halfSpreadBps)||0);
   const crossedStop=dir*(price-position.stop)<=0;
   if(crossedStop){this.#exitPart(position,position.qtyRemaining,price,'STOP',at,spread);events.push(this.#finalize(position,at,'STOP'));modified++;continue}
   while(position.exitedPct<100){
    const next=position.closeParts.filter(x=>x.type==='TARGET').length;
    if(next>=3||dir*(price-position.targets[next])<0)break;
    const quantity=next===2?position.qtyRemaining:position.originalQty*[.4,.35,.25][next];
    this.#exitPart(position,quantity,position.targets[next],`TARGET`,at,spread,next+1);
    position.exitedPct=[40,75,100][next];modified++;
    if(next===0)position.stop=position.entryFill; // after TP1, remaining stop moves to break-even (reference)
    if(next===2){events.push(this.#finalize(position,at,'ALL_TARGETS'));break}
   }
  }
  if(modified){this.telemetry.lastPositionEventAt=now;this.store.skipped=this.store.skipped.slice(-100);this.notify();for(const event of events){try{this.onEvent(event)}catch(e){console.warn('[PAPER EVENT CALLBACK]',e.message)}}}
  return modified;
 }
 #exitPart(position,qty,reference,type,at,halfSpreadBps,targetNumber=null){
  const executed=fillPrice(reference,position.direction==='LONG'?'SELL':'BUY',{halfSpreadBps,slippageBps:this.settings.slippageBps});
  const profit=qty*(position.direction==='LONG'?1:-1)*(executed-position.entryFill);
  const fee=qty*executed*this.settings.feeBps/10000;
  position.qtyRemaining=Math.max(0,position.qtyRemaining-qty);position.realizedGrossUSD+=profit;
  position.feesUSD+=fee;position.realizedPnLUSD=position.realizedGrossUSD-position.feesUSD;
  position.closeParts.push({type,targetNumber,at,reference,fill:executed,qty,profitUSD:rounded(profit),feeUSD:rounded(fee)});
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
 expirePending(){return this.#mutate(()=>this.#expirePending())}
 #expirePending(){let count=0;const now=this.now();for(const p of [...this.store.pending])if(now>p.expiresAt){this.store.pending=this.store.pending.filter(x=>x.key!==p.key);this.store.skipped.push({key:p.key,reason:'20분 이내 새 시세가 없어 진입 생략',at:now});count++}
  if(count){this.telemetry.lastPositionEventAt=now;this.notify()}return count}
}
export function paperCSV(rows=[]){const cols=['market','symbol','direction','pattern','openedAt','closedAt','entryFill','stop','notionalUSD','closeReason','realizedGrossUSD','feesUSD','realizedPnLUSD','quoteGaps'];
 return '\uFEFF'+cols.join(',')+'\r\n'+rows.map(x=>cols.map(k=>{let v=x[k]??'';if(k.endsWith('At')&&Number(v))v=new Date(v).toISOString();return '"'+String(v).replaceAll('"','""')+'"'}).join(',')).join('\r\n');}
