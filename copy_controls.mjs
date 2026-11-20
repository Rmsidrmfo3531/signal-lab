// Runtime controls for copy trading (user 2026-11-20):
//  - #1 Per-symbol max margin % cap and runtime max leverage cap
//  - #3 Symbol blocklist / allowlist
//  - #9 Real-time sizing baseline (traderBalanceUSD override for BALANCE_RATIO)
//  - #11 Automatic cooldown after consecutive losses or a daily loss % threshold
// Persisted in its own file (copy-controls[-live].json) via atomicWriteStore.
import fs from 'node:fs';
import path from 'node:path';
import {atomicWriteStore,readStore} from './persistence.mjs';
import {displaySymbol} from './public/symbol_display.js';

export const COPY_CONTROLS_DEFAULTS=Object.freeze({
 traderBalanceUSD:null,
 maxSymbolMarginPct:0,
 maxLeverage:null,
 filterMode:'BLOCKLIST',
 blockedSymbols:[],
 allowedSymbols:[],
 cooldownLosses:0,
 cooldownDailyLossPct:0,
 cooldownMinutes:120,
});

const KST_MS=9*3600000;
const kstDay=t=>new Date(Number(t)+KST_MS).toISOString().slice(0,10);
const err=(message,code='INVALID_COPY_CONTROLS')=>Object.assign(Error(message),{code,httpStatus:400});

export function normalizeControlSymbol(raw){
 const cleaned=String(raw??'').trim().toUpperCase().replace(/[-_\s/]/g,'');
 if(!cleaned)return null;
 const sym=displaySymbol(cleaned.endsWith('USDT')?cleaned:`${cleaned}USDT`);
 return /^[A-Z0-9]{4,30}$/.test(sym)?sym:null;
}

function parseSymbolList(raw,field){
 if(!Array.isArray(raw))throw err(`${field} must be an array`);
 const out=[],seen=new Set();
 for(const item of raw){
  const s=normalizeControlSymbol(item);
  if(!s)throw err(`유효하지 않은 종목 형식: ${String(item).slice(0,32)}`);
  if(!seen.has(s)){seen.add(s);out.push(s)}
 }
 if(out.length>200)throw err(`${field}는 최대 200개까지 설정할 수 있습니다`);
 return out;
}

export class CopyControls{
 constructor({directory=null,fileName='copy-controls.json',now=()=>Date.now()}={}){
  this.now=now;
  this.file=directory?path.join(directory,fileName):null;
  const saved=this.file&&fs.existsSync(this.file)?readStore(this.file):null;
  this.store={
   traderBalanceUSD:this.#validNullableNum(saved?.traderBalanceUSD,1000,1e6),
   maxSymbolMarginPct:this.#validNum(saved?.maxSymbolMarginPct,0,100,COPY_CONTROLS_DEFAULTS.maxSymbolMarginPct),
   maxLeverage:this.#validNullableInt(saved?.maxLeverage,1,125),
   filterMode:saved?.filterMode==='ALLOWLIST'?'ALLOWLIST':'BLOCKLIST',
   blockedSymbols:Array.isArray(saved?.blockedSymbols)?saved.blockedSymbols.map(normalizeControlSymbol).filter(Boolean).slice(0,200):[],
   allowedSymbols:Array.isArray(saved?.allowedSymbols)?saved.allowedSymbols.map(normalizeControlSymbol).filter(Boolean).slice(0,200):[],
   cooldownLosses:this.#validInt(saved?.cooldownLosses,0,20,COPY_CONTROLS_DEFAULTS.cooldownLosses),
   cooldownDailyLossPct:this.#validNum(saved?.cooldownDailyLossPct,0,50,COPY_CONTROLS_DEFAULTS.cooldownDailyLossPct),
   cooldownMinutes:this.#validInt(saved?.cooldownMinutes,5,1440,COPY_CONTROLS_DEFAULTS.cooldownMinutes),
   cooldownUntil:Number.isFinite(Number(saved?.cooldownUntil))&&Number(saved.cooldownUntil)>0?Number(saved.cooldownUntil):null,
   cooldownReason:typeof saved?.cooldownReason==='string'&&saved.cooldownReason?saved.cooldownReason.slice(0,120):null,
   cooldownClearedAt:Number.isFinite(Number(saved?.cooldownClearedAt))?Number(saved.cooldownClearedAt):0,
   lastCooldownTradeAt:Number.isFinite(Number(saved?.lastCooldownTradeAt))?Number(saved.lastCooldownTradeAt):0,
   lastDailyCooldownDay:typeof saved?.lastDailyCooldownDay==='string'?saved.lastDailyCooldownDay:null,
   updatedAt:Number.isFinite(Number(saved?.updatedAt))?Number(saved.updatedAt):null,
  };
 }
 #validNum(v,lo,hi,fallback){const n=Number(v);return v!==null&&v!==undefined&&v!==''&&Number.isFinite(n)&&n>=lo&&n<=hi?n:fallback}
 #validInt(v,lo,hi,fallback){const n=Number(v);return v!==null&&v!==undefined&&v!==''&&Number.isInteger(n)&&n>=lo&&n<=hi?n:fallback}
 #validNullableNum(v,lo,hi){if(v===null||v===undefined||v==='')return null;const n=Number(v);return Number.isFinite(n)&&n>=lo&&n<=hi?n:null}
 #validNullableInt(v,lo,hi){if(v===null||v===undefined||v==='')return null;const n=Number(v);return Number.isInteger(n)&&n>=lo&&n<=hi?n:null}

 #save(){
  if(!this.file)return;
  fs.mkdirSync(path.dirname(this.file),{recursive:true});
  atomicWriteStore(this.file,{version:1,...this.store});
 }

 effectiveTraderBalanceUSD(fallback=20000){
  return this.store.traderBalanceUSD??fallback;
 }

 effectiveMaxLeverage(fallback=125){
  return this.store.maxLeverage!=null?Math.min(this.store.maxLeverage,fallback):fallback;
 }

 checkSymbol(symbol){
  const sym=normalizeControlSymbol(symbol);
  if(!sym)return null;
  if(this.store.filterMode==='ALLOWLIST'){
   if(!this.store.allowedSymbols.includes(sym))
    return {reason:'SYMBOL_NOT_ALLOWED',detail:`허용 목록(${this.store.allowedSymbols.length}개)에 없는 종목`};
   return null;
  }
  if(this.store.blockedSymbols.includes(sym))
   return {reason:'SYMBOL_BLOCKED',detail:'카피 제외 목록(블랙리스트) 종목'};
  return null;
 }

 checkSymbolMargin({symbol,existingMarginUSD=0,newMarginUSD=0,equityUSD=0}){
  const pct=this.store.maxSymbolMarginPct;
  if(!(pct>0)||!(equityUSD>0))return null;
  const limit=equityUSD*pct/100;
  const total=(Number(existingMarginUSD)||0)+(Number(newMarginUSD)||0);
  if(total>limit+1e-6){
   return {
    reason:'SYMBOL_MARGIN_CAP',
    need:+total.toFixed(2),
    free:+Math.max(0,limit-(Number(existingMarginUSD)||0)).toFixed(2),
    detail:`${symbol} 종목 증거금 $${total.toFixed(2)} > 한도 $${limit.toFixed(2)} (${pct}%)`,
   };
  }
  return null;
 }

 checkCooldown(at=this.now()){
  if(this.store.cooldownUntil&&this.store.cooldownUntil>at){
   const leftMin=Math.max(1,Math.ceil((this.store.cooldownUntil-at)/60000));
   return {
    reason:'COPY_COOLDOWN',
    until:this.store.cooldownUntil,
    detail:`${this.store.cooldownReason||'손실 쿨다운'} · ${leftMin}분 남음`,
   };
  }
  return null;
 }

 evaluateCooldown({closedTrades=[],equityUSD=null,now=this.now()}={}){
  const active=this.checkCooldown(now);
  if(active)return {triggered:false,active:true};
  const since=Math.max(this.store.cooldownClearedAt||0,this.store.lastCooldownTradeAt||0);
  const settled=(Array.isArray(closedTrades)?closedTrades:[])
   .filter(t=>t&&!t.archivedFromHistory&&t.netUSD!=null&&Number.isFinite(Number(t.netUSD))&&Number(t.closedAt)>0)
   .sort((a,b)=>Number(b.closedAt)-Number(a.closedAt));

  if(this.store.cooldownLosses>0&&settled.length){
   const latestAt=Number(settled[0].closedAt);
   if(latestAt>since){
    let streak=0;
    for(const t of settled){
     if(Number(t.closedAt)<=since)break;
     if(Number(t.netUSD)<0)streak++;
     else break;
    }
    if(streak>=this.store.cooldownLosses){
     const until=now+this.store.cooldownMinutes*60000;
     const reason=`연속 ${streak}회 손실`;
     this.store.cooldownUntil=until;
     this.store.cooldownReason=reason;
     this.store.lastCooldownTradeAt=latestAt;
     this.store.updatedAt=now;
     this.#save();
     return {triggered:true,until,reason,minutes:this.store.cooldownMinutes};
    }
   }
  }

  const eq=Number(equityUSD);
  if(this.store.cooldownDailyLossPct>0&&Number.isFinite(eq)&&eq>0){
   const today=kstDay(now);
   if(this.store.lastDailyCooldownDay!==today){
    const todayNet=settled
     .filter(t=>kstDay(t.closedAt)===today&&Number(t.closedAt)>(this.store.cooldownClearedAt||0))
     .reduce((sum,t)=>sum+Number(t.netUSD),0);
    const limit=eq*this.store.cooldownDailyLossPct/100;
    if(todayNet<=-limit){
     const until=now+this.store.cooldownMinutes*60000;
     const pct=(Math.abs(todayNet)/eq*100).toFixed(1);
     const reason=`당일 실현 손실 −$${Math.abs(todayNet).toFixed(2)} (${pct}%)`;
     this.store.cooldownUntil=until;
     this.store.cooldownReason=reason;
     this.store.lastDailyCooldownDay=today;
     this.store.updatedAt=now;
     this.#save();
     return {triggered:true,until,reason,minutes:this.store.cooldownMinutes};
    }
   }
  }
  return {triggered:false,active:false};
 }

 configure(patch={}){
  if(!patch||typeof patch!=='object'||Array.isArray(patch))throw err('JSON object required');
  const next={...this.store,blockedSymbols:[...this.store.blockedSymbols],allowedSymbols:[...this.store.allowedSymbols]};
  if(Object.hasOwn(patch,'traderBalanceUSD')){
   if(patch.traderBalanceUSD===null||patch.traderBalanceUSD==='')next.traderBalanceUSD=null;
   else{
    const v=Number(patch.traderBalanceUSD);
    if(!Number.isFinite(v)||v<1000||v>1e6)throw err('기준 잔고는 $1,000 ~ $1,000,000 범위여야 합니다');
    next.traderBalanceUSD=Math.round(v);
   }
  }
  if(Object.hasOwn(patch,'maxSymbolMarginPct')){
   const v=Number(patch.maxSymbolMarginPct);
   if(!Number.isFinite(v)||v<0||v>100)throw err('종목당 최대 증거금 비율은 0 ~ 100% 범위여야 합니다');
   next.maxSymbolMarginPct=+v.toFixed(2);
  }
  if(Object.hasOwn(patch,'maxLeverage')){
   if(patch.maxLeverage===null||patch.maxLeverage===''||Number(patch.maxLeverage)===0)next.maxLeverage=null;
   else{
    const v=Number(patch.maxLeverage);
    if(!Number.isInteger(v)||v<1||v>125)throw err('최대 레버리지는 1 ~ 125배 정수여야 합니다');
    next.maxLeverage=v;
   }
  }
  if(Object.hasOwn(patch,'filterMode')){
   const m=String(patch.filterMode||'').toUpperCase();
   if(!['BLOCKLIST','ALLOWLIST'].includes(m))throw err('filterMode는 BLOCKLIST 또는 ALLOWLIST여야 합니다');
   next.filterMode=m;
  }
  if(Object.hasOwn(patch,'blockedSymbols'))next.blockedSymbols=parseSymbolList(patch.blockedSymbols,'blockedSymbols');
  if(Object.hasOwn(patch,'allowedSymbols'))next.allowedSymbols=parseSymbolList(patch.allowedSymbols,'allowedSymbols');
  if(Object.hasOwn(patch,'addBlocked')){
   const s=normalizeControlSymbol(patch.addBlocked);if(!s)throw err('유효하지 않은 종목입니다');
   if(!next.blockedSymbols.includes(s)){if(next.blockedSymbols.length>=200)throw err('최대 200개');next.blockedSymbols.push(s)}
  }
  if(Object.hasOwn(patch,'removeBlocked')){
   const s=normalizeControlSymbol(patch.removeBlocked);
   if(s)next.blockedSymbols=next.blockedSymbols.filter(x=>x!==s);
  }
  if(Object.hasOwn(patch,'addAllowed')){
   const s=normalizeControlSymbol(patch.addAllowed);if(!s)throw err('유효하지 않은 종목입니다');
   if(!next.allowedSymbols.includes(s)){if(next.allowedSymbols.length>=200)throw err('최대 200개');next.allowedSymbols.push(s)}
  }
  if(Object.hasOwn(patch,'removeAllowed')){
   const s=normalizeControlSymbol(patch.removeAllowed);
   if(s)next.allowedSymbols=next.allowedSymbols.filter(x=>x!==s);
  }
  if(Object.hasOwn(patch,'cooldownLosses')){
   const v=Number(patch.cooldownLosses);
   if(!Number.isInteger(v)||v<0||v>20)throw err('연속 손실 횟수는 0 ~ 20 정수여야 합니다');
   next.cooldownLosses=v;
  }
  if(Object.hasOwn(patch,'cooldownDailyLossPct')){
   const v=Number(patch.cooldownDailyLossPct);
   if(!Number.isFinite(v)||v<0||v>50)throw err('당일 손실 쿨다운 비율은 0 ~ 50% 범위여야 합니다');
   next.cooldownDailyLossPct=+v.toFixed(2);
  }
  if(Object.hasOwn(patch,'cooldownMinutes')){
   const v=Number(patch.cooldownMinutes);
   if(!Number.isInteger(v)||v<5||v>1440)throw err('쿨다운 시간은 5 ~ 1440분 정수여야 합니다');
   next.cooldownMinutes=v;
  }
  if(patch.clearCooldown===true){
   next.cooldownUntil=null;
   next.cooldownReason=null;
   next.cooldownClearedAt=this.now();
  }
  next.updatedAt=this.now();
  this.store=next;
  this.#save();
  return this.status();
 }

 status(at=this.now()){
  const active=Boolean(this.store.cooldownUntil&&this.store.cooldownUntil>at);
  return {
   traderBalanceUSD:this.store.traderBalanceUSD,
   maxSymbolMarginPct:this.store.maxSymbolMarginPct,
   maxLeverage:this.store.maxLeverage,
   filterMode:this.store.filterMode,
   blockedSymbols:[...this.store.blockedSymbols],
   allowedSymbols:[...this.store.allowedSymbols],
   cooldownLosses:this.store.cooldownLosses,
   cooldownDailyLossPct:this.store.cooldownDailyLossPct,
   cooldownMinutes:this.store.cooldownMinutes,
   cooldownActive:active,
   cooldownUntil:active?this.store.cooldownUntil:null,
   cooldownLeftMin:active?Math.max(1,Math.ceil((this.store.cooldownUntil-at)/60000)):0,
   cooldownReason:active?this.store.cooldownReason:null,
   updatedAt:this.store.updatedAt,
  };
 }
}
