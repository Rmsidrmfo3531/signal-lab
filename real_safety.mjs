// Real-account integrated safety guard (copy + manual combined):
//  - Combined KST daily loss circuit breaker (BingX exchange realized + open unrealized across manual & copy)
//  - Manual order leverage ceiling (default 20x) & single-order margin % cap (default 15% of equity)
//  - Never blocks reduce-only / close / breakeven-stop / order-cancel actions.
import fs from 'node:fs';
import path from 'node:path';
import {atomicWriteStore,readStore} from './persistence.mjs';

export const REAL_SAFETY_DEFAULTS=Object.freeze({
 dailyLossLimitPct:8,
 manualMaxLeverage:20,
 manualMaxMarginPct:15,
});

export const REAL_SAFETY_COPY_PRESET=Object.freeze({
 maxLeverage:20,
 maxSymbolMarginPct:15,
 cooldownLosses:3,
 cooldownDailyLossPct:6,
 cooldownMinutes:120,
});

const KST_MS=9*3600000;
export const kstDay=t=>new Date(Number(t)+KST_MS).toISOString().slice(0,10);
const err=msg=>Object.assign(Error(msg),{code:'INVALID_REAL_SAFETY',httpStatus:400});
const money=v=>{const n=Number(v);return !Number.isFinite(n)?'—':`${n>=0?'+':'−'}$${Math.abs(n).toFixed(2)}`};

function parseRange(v,lo,hi,name,int=false){
 const n=Number(v);
 if(!Number.isFinite(n)||n<lo||n>hi||(int&&!Number.isInteger(n)))throw err(`${name} must be ${lo}..${hi}`);
 return int?n:+n.toFixed(2);
}

export class RealAccountGuard{
 constructor({directory=null,fileName='real-safety.json',now=()=>Date.now(),
  onTrip=async()=>{},sendText=async()=>{},log=()=>{}}={}){
  Object.assign(this,{now,onTrip,sendText,log});
  this.file=directory?path.join(directory,fileName):null;
  const saved=this.file&&fs.existsSync(this.file)?readStore(this.file):null;
  this.store={
   dailyLossLimitPct:Number.isFinite(Number(saved?.dailyLossLimitPct))?Number(saved.dailyLossLimitPct):REAL_SAFETY_DEFAULTS.dailyLossLimitPct,
   manualMaxLeverage:Number.isFinite(Number(saved?.manualMaxLeverage))?Number(saved.manualMaxLeverage):REAL_SAFETY_DEFAULTS.manualMaxLeverage,
   manualMaxMarginPct:Number.isFinite(Number(saved?.manualMaxMarginPct))?Number(saved.manualMaxMarginPct):REAL_SAFETY_DEFAULTS.manualMaxMarginPct,
   trippedDay:typeof saved?.trippedDay==='string'?saved.trippedDay:null,
   trippedAt:Number.isFinite(Number(saved?.trippedAt))?Number(saved.trippedAt):null,
   trippedLossUSD:Number.isFinite(Number(saved?.trippedLossUSD))?Number(saved.trippedLossUSD):null,
   trippedLossPct:Number.isFinite(Number(saved?.trippedLossPct))?Number(saved.trippedLossPct):null,
   trippedReason:typeof saved?.trippedReason==='string'?saved.trippedReason:null,
   unlockedDay:typeof saved?.unlockedDay==='string'?saved.unlockedDay:null,
   unlockedAt:Number.isFinite(Number(saved?.unlockedAt))?Number(saved.unlockedAt):null,
  };
  this.lastEval=null;
 }

 #save(){
  if(!this.file)return;
  fs.mkdirSync(path.dirname(this.file),{recursive:true});
  atomicWriteStore(this.file,{version:1,...this.store});
 }

 isTripped(at=this.now()){
  const today=kstDay(at);
  return this.store.trippedDay===today&&this.store.unlockedDay!==today;
 }

 configure(patch={}){
  if(!patch||typeof patch!=='object'||Array.isArray(patch))throw err('JSON object required');
  const next={...this.store};
  if(patch.applyPreset===true){
   next.dailyLossLimitPct=REAL_SAFETY_DEFAULTS.dailyLossLimitPct;
   next.manualMaxLeverage=REAL_SAFETY_DEFAULTS.manualMaxLeverage;
   next.manualMaxMarginPct=REAL_SAFETY_DEFAULTS.manualMaxMarginPct;
  }
  if(Object.hasOwn(patch,'dailyLossLimitPct'))next.dailyLossLimitPct=parseRange(patch.dailyLossLimitPct,0,50,'dailyLossLimitPct');
  if(Object.hasOwn(patch,'manualMaxLeverage'))next.manualMaxLeverage=parseRange(patch.manualMaxLeverage,0,125,'manualMaxLeverage',true);
  if(Object.hasOwn(patch,'manualMaxMarginPct'))next.manualMaxMarginPct=parseRange(patch.manualMaxMarginPct,0,100,'manualMaxMarginPct');
  if(patch.unlockToday===true){
   const today=kstDay(this.now());
   next.unlockedDay=today;
   next.unlockedAt=this.now();
  }
  if(patch.rearmToday===true){
   next.unlockedDay=null;
   next.unlockedAt=null;
  }
  this.store=next;
  this.#save();
  return this.status();
 }

 orderGuard({equityUSD=null,now=this.now()}={}){
  const tripped=this.isTripped(now);
  const eq=Number(equityUSD);
  const maxLeverage=this.store.manualMaxLeverage>0?this.store.manualMaxLeverage:null;
  const maxMarginUSD=this.store.manualMaxMarginPct>0&&Number.isFinite(eq)&&eq>0
   ?+(eq*this.store.manualMaxMarginPct/100).toFixed(2):null;
  return {
   blocked:tripped,
   reason:tripped?(this.store.trippedReason||`오늘 합산 손실 한도(-${this.store.dailyLossLimitPct}%) 도달로 신규 진입 차단 중`):null,
   maxLeverage,
   maxMarginPct:this.store.manualMaxMarginPct>0?this.store.manualMaxMarginPct:null,
   maxMarginUSD,
  };
 }

 async evaluateDailyLoss({equityUSD=null,dailyByDay=null,positions=[],now=this.now()}={}){
  const eq=Number(equityUSD);
  const limitPct=this.store.dailyLossLimitPct;
  if(!(limitPct>0)||!(Number.isFinite(eq)&&eq>0))return {tripped:this.isTripped(now),newlyTripped:false};
  const today=kstDay(now);
  const realizedToday=dailyByDay&&Number.isFinite(Number(dailyByDay[today]))?Number(dailyByDay[today]):0;
  const list=Array.isArray(positions)?positions:[];
  const openUnreal=list.reduce((s,p)=>s+(Number.isFinite(Number(p?.unrealized))?Number(p.unrealized):0),0);
  const combinedNet=+(realizedToday+openUnreal).toFixed(2);
  const combinedPct=+(combinedNet/eq*100).toFixed(2);
  this.lastEval={day:today,at:now,realizedToday:+realizedToday.toFixed(2),openUnreal:+openUnreal.toFixed(2),combinedNet,combinedPct,equityUSD:eq};

  if(this.store.unlockedDay===today)return {tripped:false,newlyTripped:false,combinedNet,combinedPct};
  if(this.store.trippedDay===today)return {tripped:true,newlyTripped:false,combinedNet,combinedPct};

  const limitUSD=eq*limitPct/100;
  if(combinedNet<=-limitUSD){
   const lossUSD=+Math.abs(combinedNet).toFixed(2);
   const lossPct=+Math.abs(combinedPct).toFixed(1);
   const reason=`오늘 합산 손실 ${money(combinedNet)} (-${lossPct}%, 한도 -${limitPct}%)`;
   this.store.trippedDay=today;
   this.store.trippedAt=now;
   this.store.trippedLossUSD=lossUSD;
   this.store.trippedLossPct=lossPct;
   this.store.trippedReason=reason;
   this.#save();
   this.log?.('CIRCUIT_BREAKER_TRIPPED',reason);
   try{await this.onTrip({today,combinedNet,combinedPct,reason})}catch(e){this.log?.('onTrip error',e?.message)}
   const msg=`🚨 [실계좌 일일 손실 차단 발동]\n${reason}\n(당일 실현 ${money(realizedToday)} · 현재 미실현 ${money(openUnreal)})\n신규 카피·수동 진입이 오늘 자정(KST)까지 자동 차단됩니다.\n(기존 포지션 청산·본전 스탑은 정상 작동)`;
   try{await this.sendText(msg)}catch{}
   return {tripped:true,newlyTripped:true,combinedNet,combinedPct,reason};
  }
  return {tripped:false,newlyTripped:false,combinedNet,combinedPct};
 }

 status(at=this.now()){
  const today=kstDay(at);
  const tripped=this.isTripped(at);
  return {
   dailyLossLimitPct:this.store.dailyLossLimitPct,
   manualMaxLeverage:this.store.manualMaxLeverage,
   manualMaxMarginPct:this.store.manualMaxMarginPct,
   tripped,
   trippedDay:tripped?this.store.trippedDay:null,
   trippedAt:tripped?this.store.trippedAt:null,
   trippedLossUSD:tripped?this.store.trippedLossUSD:null,
   trippedLossPct:tripped?this.store.trippedLossPct:null,
   trippedReason:tripped?this.store.trippedReason:null,
   unlockedToday:this.store.unlockedDay===today,
   lastEval:this.lastEval,
   copyPreset:REAL_SAFETY_COPY_PRESET,
  };
 }
}
