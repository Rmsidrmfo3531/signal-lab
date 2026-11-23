// Real-account trailing take-profit & 50% partial profit lock-in manager (opt-in toggle, default OFF).
// Runs read-only monitoring on BingX real-account venue positions and only dispatches reduce-only actions
// (CLOSE_HALF, BREAKEVEN_STOP, CLOSE_ALL) via the shared executeAction operator when explicitly enabled.
import fs from 'node:fs';
import path from 'node:path';
import {atomicWriteStore,readStore} from './persistence.mjs';
import {displaySymbol} from './public/symbol_display.js';
import {isCoinSymbol} from './venue_charts.mjs';

export const REAL_TRAILING_DEFAULTS=Object.freeze({
 enabled:false,
 applyToManual:true,
 applyToCopy:false,
 partialLockRoePct:15,
 partialClosePct:50,
 trailActivateRoePct:15,
 trailPullbackRatio:30,
 minLockRoePct:5,
 autoBreakeven:true,
 skipTradfi:true,
 roundTripFeePct:0.10, // BingX 0.05% taker × 2 (entry + exit)
 excludedSymbols:Object.freeze([]),
});

// Backtest-validated runner maximization preset (+16% Net ROE · 25% partial lock · 28% runner pullback)
export const REAL_TRAILING_BACKTEST_PRESET=Object.freeze({
 partialLockRoePct:16,
 partialClosePct:25,
 trailActivateRoePct:16,
 trailPullbackRatio:28,
 minLockRoePct:5,
 autoBreakeven:true,
});

const ACTION_COOLDOWN_MS=15000;
const MIN_PULLBACK_ROE=2.0;
const err=msg=>Object.assign(Error(msg),{code:'INVALID_REAL_TRAILING',httpStatus:400});
const normSym=s=>{
 const clean=displaySymbol(String(s||'').trim().toUpperCase().replace(/[^A-Z0-9-]/g,'')).replace(/-USDT$/,'USDT').replace(/-/g,'');
 if(!clean)return '';
 return clean.endsWith('USDT')?clean:`${clean}USDT`;
};
const isTradfiPos=p=>{
 const rawSym=String(p?.symbol||'').trim().toUpperCase().replace(/-USDT$/,'USDT');
 const rawVs=String(p?.venueSymbol||'').trim().toUpperCase().replace(/-USDT$/,'USDT');
 if(/^NC/.test(rawSym)||/^NC/.test(rawVs))return true;
 const disp=normSym(rawSym||rawVs);
 return Boolean(disp&&!isCoinSymbol(disp));
};
const sideKo=d=>d==='SHORT'?'🔴 숏':'🟢 롱';
const money=v=>{const n=Number(v);return v==null||!Number.isFinite(n)?'—':`${n>=0?'+':'−'}$${Math.abs(n).toFixed(2)}`};

function parseNum(v,lo,hi,name){
 const n=Number(v);
 if(!Number.isFinite(n)||n<lo||n>hi)throw err(`${name} must be ${lo}..${hi}`);
 return +n.toFixed(2);
}

export class RealTrailingManager{
 constructor({directory=null,fileName='real-trailing.json',now=()=>Date.now(),
  executeAction=async()=>({ok:false}),sendText=async()=>{},log=()=>{}}={}){
  Object.assign(this,{now,executeAction,sendText,log});
  this.file=directory?path.join(directory,fileName):null;
  const saved=this.file&&fs.existsSync(this.file)?readStore(this.file):null;
  this.store={
   enabled:saved?.enabled===true,
   applyToManual:saved?.applyToManual!==false,
   applyToCopy:saved?.applyToCopy===true,
   partialLockRoePct:Number.isFinite(Number(saved?.partialLockRoePct))?Number(saved.partialLockRoePct):REAL_TRAILING_DEFAULTS.partialLockRoePct,
   partialClosePct:Number.isFinite(Number(saved?.partialClosePct))?Number(saved.partialClosePct):REAL_TRAILING_DEFAULTS.partialClosePct,
   trailActivateRoePct:Number.isFinite(Number(saved?.trailActivateRoePct))?Number(saved.trailActivateRoePct):REAL_TRAILING_DEFAULTS.trailActivateRoePct,
   trailPullbackRatio:Number.isFinite(Number(saved?.trailPullbackRatio))?Number(saved.trailPullbackRatio):REAL_TRAILING_DEFAULTS.trailPullbackRatio,
   minLockRoePct:Number.isFinite(Number(saved?.minLockRoePct))?Number(saved.minLockRoePct):REAL_TRAILING_DEFAULTS.minLockRoePct,
   autoBreakeven:saved?.autoBreakeven!==false,
   skipTradfi:saved?.skipTradfi!==false,
   roundTripFeePct:Number.isFinite(Number(saved?.roundTripFeePct))?Number(saved.roundTripFeePct):REAL_TRAILING_DEFAULTS.roundTripFeePct,
   excludedSymbols:Array.isArray(saved?.excludedSymbols)?[...new Set(saved.excludedSymbols.map(normSym).filter(Boolean))]:[],
  };
  this.tracked=new Map(); // `${dispSym}|${dir}` -> {peakRoePct, partialTaken, breakevenPlaced, avg, lastActionAt}
  this.busy=false;
 }

 #save(){
  if(!this.file)return;
  fs.mkdirSync(path.dirname(this.file),{recursive:true});
  atomicWriteStore(this.file,{version:1,...this.store});
 }

 configure(patch={}){
  if(!patch||typeof patch!=='object'||Array.isArray(patch))throw err('JSON object required');
  const next={...this.store};
  if(patch.applyPreset===true)Object.assign(next,REAL_TRAILING_BACKTEST_PRESET);
  for(const k of ['enabled','applyToManual','applyToCopy','autoBreakeven','skipTradfi']){
   if(Object.hasOwn(patch,k)){
    if(typeof patch[k]!=='boolean')throw err(`${k} must be a boolean`);
    next[k]=patch[k];
   }
  }
  if(Object.hasOwn(patch,'partialLockRoePct'))next.partialLockRoePct=parseNum(patch.partialLockRoePct,2,200,'partialLockRoePct');
  if(Object.hasOwn(patch,'partialClosePct'))next.partialClosePct=parseNum(patch.partialClosePct,0,100,'partialClosePct');
  if(Object.hasOwn(patch,'trailActivateRoePct'))next.trailActivateRoePct=parseNum(patch.trailActivateRoePct,2,200,'trailActivateRoePct');
  if(Object.hasOwn(patch,'trailPullbackRatio'))next.trailPullbackRatio=parseNum(patch.trailPullbackRatio,5,70,'trailPullbackRatio');
  if(Object.hasOwn(patch,'minLockRoePct'))next.minLockRoePct=parseNum(patch.minLockRoePct,0.5,50,'minLockRoePct');
  if(Object.hasOwn(patch,'roundTripFeePct'))next.roundTripFeePct=parseNum(patch.roundTripFeePct,0,1,'roundTripFeePct');
  if(Object.hasOwn(patch,'excludedSymbols')){
   const list=Array.isArray(patch.excludedSymbols)?patch.excludedSymbols:String(patch.excludedSymbols||'').split(/[,\s]+/);
   next.excludedSymbols=[...new Set(list.map(normSym).filter(Boolean))].slice(0,50);
  }
  if(Object.hasOwn(patch,'toggleExcludeSymbol')){
   const sym=normSym(patch.toggleExcludeSymbol);
   if(sym){
    const set=new Set(next.excludedSymbols);
    if(set.has(sym))set.delete(sym);else set.add(sym);
    next.excludedSymbols=[...set];
   }
  }
  this.store=next;
  this.#save();
  return this.status();
 }

 status(){
  const tracked={};
  for(const [k,v] of this.tracked){
   tracked[k]={peakRoePct:v.peakRoePct,partialTaken:v.partialTaken===true,breakevenPlaced:v.breakevenPlaced===true};
  }
  return {
   ...this.store,
   excludedSymbols:[...this.store.excludedSymbols],
   tracked,
  };
 }

 async evaluate(positions=[],now=this.now()){
  if(!this.store.enabled||this.busy)return [];
  const list=Array.isArray(positions)?positions:[];
  this.busy=true;
  const actions=[];
  try{
   const openKeys=new Set();
   const excluded=new Set(this.store.excludedSymbols);
   const cfg=this.store;
   for(const p of list){
    const disp=normSym(p?.symbol||p?.venueSymbol);
    const dir=String(p?.direction||'').toUpperCase();
    if(!disp||!['LONG','SHORT'].includes(dir))continue;
    const key=`${disp}|${dir}`;
    openKeys.add(key);
    const isCopy=p.origin==='copy';
    if(isCopy&&!cfg.applyToCopy)continue;
    if(!isCopy&&!cfg.applyToManual)continue;
    if(excluded.has(disp))continue;
    if(cfg.skipTradfi&&isTradfiPos(p))continue;
    const grossRoe=Number(p.roePct);
    const avg=Number(p.avg);
    if(!Number.isFinite(grossRoe)||!(Number(p.size)>0)||!(avg>0))continue;
    // Fee-adjusted Net ROE: subtract round-trip taker fee (default 0.10% × leverage) so high-leverage exits never lose to fees.
    const lev=Math.max(1,Number(p.leverage)||10);
    const feeRoePct=+(Number(cfg.roundTripFeePct||0)*lev).toFixed(2);
    const roe=+(grossRoe-feeRoePct).toFixed(2);

    let st=this.tracked.get(key);
    if(!st||(st.avg>0&&Math.abs(avg-st.avg)/st.avg>0.02)){
     st={peakRoePct:null,partialTaken:false,breakevenPlaced:false,avg,lastActionAt:0};
     this.tracked.set(key,st);
    }
    const armThreshold=Math.min(cfg.partialLockRoePct,cfg.trailActivateRoePct);
    if(roe>=armThreshold&&(st.peakRoePct===null||roe>st.peakRoePct)){
     st.peakRoePct=+roe.toFixed(2);
    }
    if(now-st.lastActionAt<ACTION_COOLDOWN_MS)continue;

    // Step 1: Partial profit lock-in (e.g. 25% or 50%) + optional breakeven stop on remaining runner
    if(cfg.partialClosePct>0&&!st.partialTaken&&roe>=cfg.partialLockRoePct){
     st.lastActionAt=now;
     const partPct=Math.max(1,Math.min(99,Math.round(Number(cfg.partialClosePct)||50)));
     const remPct=100-partPct;
     const res=await this.executeAction({symbol:p.symbol,direction:dir,action:'CLOSE_HALF',closePct:partPct}).catch(e=>({ok:false,error:e?.code||e?.message}));
     if(res?.ok){
      st.partialTaken=true;
      let beLine='';
      if(cfg.autoBreakeven&&!st.breakevenPlaced){
       const beRes=await this.executeAction({symbol:p.symbol,direction:dir,action:'BREAKEVEN_STOP'}).catch(()=>({ok:false}));
       if(beRes?.ok){st.breakevenPlaced=true;beLine=`\n🛡️ 잔여 물량 본전 스탑 자동 설정 (${beRes.stopPrice})`}
      }
      const estPart=Number.isFinite(Number(p.unrealized))?Number(p.unrealized)*(partPct/100):null;
      const msg=`💰 [실계좌 자동 익절] ${disp} ${sideKo(dir)} ${partPct}% 부분 익절 확정\n순 ROE +${roe.toFixed(1)}% (수수료 -${feeRoePct.toFixed(1)}% 반영) · 추정 실현 ${money(estPart)}\n잔여 ${remPct}% 고점 대비 ${cfg.trailPullbackRatio}% 트레일링 추적 중${beLine}`;
      try{await this.sendText(msg)}catch{}
      actions.push({key,action:'CLOSE_HALF',closePct:partPct,roePct:roe,grossRoePct:grossRoe,feeRoePct,breakeven:st.breakevenPlaced});
     }else if(res?.error==='HALF_QTY_TOO_SMALL'){
      // Position too small to split -> skip partial lock-in and trail full position instead.
      st.partialTaken=true;
     }
     continue;
    }

    // Step 2: Peak-pullback trailing exit on remaining (or full) position (strictly fee-positive net ROE)
    if(st.peakRoePct!==null&&st.peakRoePct>=cfg.trailActivateRoePct){
     const pullback=Math.max(MIN_PULLBACK_ROE,st.peakRoePct*(cfg.trailPullbackRatio/100));
     const stopRoe=Math.max(cfg.minLockRoePct,st.peakRoePct-pullback);
     if(roe<=stopRoe&&roe>=Math.max(1.0,cfg.minLockRoePct*0.5)){
      st.lastActionAt=now;
      const res=await this.executeAction({symbol:p.symbol,direction:dir,action:'CLOSE_ALL'}).catch(e=>({ok:false,error:e?.code||e?.message}));
      if(res?.ok){
       const msg=`🎯 [실계좌 자동 트레일링] ${disp} ${sideKo(dir)} 익절 청산 완료\n고점 순 ROE +${st.peakRoePct.toFixed(1)}% → 청산 순 ROE +${roe.toFixed(1)}% (${money(p.unrealized)})`;
       try{await this.sendText(msg)}catch{}
       actions.push({key,action:'CLOSE_ALL',peakRoePct:st.peakRoePct,roePct:roe,grossRoePct:grossRoe,feeRoePct});
       this.tracked.delete(key);
      }
     }
    }
   }
   for(const k of this.tracked.keys())if(!openKeys.has(k))this.tracked.delete(k);
  }finally{
   this.busy=false;
  }
  return actions;
 }
}
