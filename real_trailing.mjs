// Real-account trailing take-profit & 50% partial profit lock-in manager (opt-in toggle, default OFF).
// Runs read-only monitoring on BingX real-account venue positions and only dispatches reduce-only actions
// (CLOSE_HALF, BREAKEVEN_STOP, TRAIL_STOP, CANCEL_STOP, CLOSE_ALL) via the shared executeAction operator when
// explicitly enabled.
// Audit fixes 2026-11-23 (user decision (a) "수동은 기본 끄기"):
//  - manual positions are not managed by default (applyToManual:false; a saved true is migrated to false once);
//  - tracking state (peak, partial taken, stop orders) is kept in real-trailing.json, so a restart never takes a
//    second partial;
//  - no lower floor on the trailing exit: a fast drop below the locked level still closes;
//  - once trailing is armed an exchange STOP_MARKET (closePosition, hedge-correct) sits at the locked level, so the
//    lock survives server downtime;
//  - the break-even stop is entry plus round-trip fees, not the bare average price.
import fs from 'node:fs';
import path from 'node:path';
import {atomicWriteStore,readStore} from './persistence.mjs';
import {displaySymbol} from './public/symbol_display.js';
import {isCoinSymbol} from './venue_charts.mjs';

export const REAL_TRAILING_DEFAULTS=Object.freeze({
 enabled:false,
 applyToManual:false,
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
// The exchange lock stop is moved up only when the locked net ROE improves by at least this much.
const LOCK_STOP_STEP_ROE=1.0;
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
// Manual first (user 2026-11-25 01:37 "만약 수동으로 매매를 했고 tp와 sl이 설정되어 있는 경우 어떠한 경우라도 강제 청산을 하지
// 않도록 해줘"): a manual position is managed only when applyToManual is on AND its lane carries no TP / SL order of the
// user (open orders read this pass; unreadable -> protected). A copy row sharing its lane with a manual position
// (manualQty > 0, or null = unknown) is never managed either: these actions close the whole lane.
const PROTECT_TYPE=/STOP|TAKE_PROFIT|TRAILING/i;
/** true: a user TP / SL order on the lane of p; false: none; null: the open orders could not be read. */
export function userTpSlOnLane(p,orders,ownIds=new Set()){
 if(!Array.isArray(orders))return null;
 const dir=String(p?.direction||'').toUpperCase(),vs=String(p?.venueSymbol||''),closeSide=dir==='LONG'?'SELL':'BUY';
 return orders.some(o=>{
  if(!o||String(o.venueSymbol??o.symbol??'')!==vs)return false;
  const id=o.orderId!=null?String(o.orderId):null;if(id&&ownIds.has(id))return false;
  const cid=String(o.clientOrderId||'').toLowerCase();if(cid.startsWith('cp')||cid.startsWith('optr'))return false; // copy's own / our lock stop
  const lane=String(o.positionSide||'BOTH').toUpperCase();
  if(lane!=='BOTH'&&lane!==dir)return false;
  // A TP / SL of this position sits on its closing side (an order that states no side is counted: fail safe). A limit
  // take-profit counts too (review 2026-11-25): reduce-only / closePosition, or in hedge mode any order of this side.
  const side=String(o.side||'').toUpperCase(),flag=v=>v===true||String(v).toLowerCase()==='true';
  const closing=flag(o.reduceOnly)||flag(o.closePosition)||lane===dir;
  return (PROTECT_TYPE.test(String(o.type||''))||closing)&&(!side||side===closeSide);
 });
}
const money=v=>{const n=Number(v);return v==null||!Number.isFinite(n)?'—':`${n>=0?'+':'−'}$${Math.abs(n).toFixed(2)}`};

/** Break-even stop net of fees: entry +/- the round-trip fee (feePct, e.g. 0.10 = 0.10 %), so a fill at the stop
 * does not lose the fees. LONG rounds up, SHORT down (never below break-even). */
export function feeNetBreakevenPrice({avg,direction,feePct=REAL_TRAILING_DEFAULTS.roundTripFeePct}){
 const a=Number(avg),f=Math.max(0,Number(feePct)||0);
 if(!(a>0)||!['LONG','SHORT'].includes(direction))return null;
 return direction==='LONG'?a*(1+f/100):a*(1-f/100);
}
/** The price at which the position shows `netRoePct` after fees (gross ROE = net + feeRoePct). */
export function priceForNetRoe({avg,direction,leverage,netRoePct,feeRoePct=0}){
 const a=Number(avg),lev=Math.max(1,Number(leverage)||1),gross=Number(netRoePct)+Number(feeRoePct||0);
 if(!(a>0)||!Number.isFinite(gross)||!['LONG','SHORT'].includes(direction))return null;
 const px=a*(1+(direction==='LONG'?1:-1)*gross/(100*lev));
 return px>0?px:null;
}
const trackedFrom=raw=>{
 const out=new Map();
 if(!raw||typeof raw!=='object'||Array.isArray(raw))return out;
 for(const [k,v] of Object.entries(raw)){
  if(!/^[A-Z0-9]+\|(LONG|SHORT)$/.test(k)||!v||typeof v!=='object')continue;
  const n=x=>Number.isFinite(Number(x))?Number(x):null;
  out.set(k,{peakRoePct:n(v.peakRoePct),partialTaken:v.partialTaken===true,breakevenPlaced:v.breakevenPlaced===true,
   breakevenOrderId:v.breakevenOrderId!=null?String(v.breakevenOrderId):null,avg:n(v.avg)??0,lastActionAt:n(v.lastActionAt)??0,
   lockStopOrderId:v.lockStopOrderId!=null?String(v.lockStopOrderId):null,lockStopPrice:n(v.lockStopPrice),lockStopRoe:n(v.lockStopRoe),
   venueSymbol:typeof v.venueSymbol==='string'?v.venueSymbol:null,
   staleStopIds:Array.isArray(v.staleStopIds)?v.staleStopIds.filter(x=>x!=null).map(String).slice(-10):[],
   missing:n(v.missing)??0,lockRetryAt:n(v.lockRetryAt)??0});
 }
 return out;
};

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
  // One-time migration (user decision 2026-11-23 (a) "수동은 기본 끄기"): a settings file saved before it with manual
  // positions on is switched off once and logged; the user can turn it back on from the screen.
  const migrate=Boolean(saved)&&saved.applyToManual!==false&&saved.manualDefaultMigrated!==true;
  this.store={
   enabled:saved?.enabled===true,
   applyToManual:migrate?false:saved?.applyToManual===true,
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
   manualDefaultMigrated:true,
   manualMigratedAt:migrate?this.now():(Number.isFinite(Number(saved?.manualMigratedAt))?Number(saved.manualMigratedAt):null),
  };
  // `${dispSym}|${dir}` -> {peakRoePct, partialTaken, breakevenPlaced, breakevenOrderId, avg, lastActionAt,
  //  lockStopOrderId, lockStopPrice, lockStopRoe, venueSymbol}; kept on disk (a restart must not re-take a partial).
  this.tracked=trackedFrom(saved?.tracked);
  this.busy=false;
  if(migrate){
   this.log?.('MANUAL_DEFAULT_MIGRATED','applyToManual true -> false (2026-11-23, 수동 기본 끄기); 화면에서 다시 켤 수 있음');
   try{this.#save()}catch(e){this.log?.('save failed',e?.message)}
  }
 }

 #save(){
  if(!this.file)return;
  fs.mkdirSync(path.dirname(this.file),{recursive:true});
  atomicWriteStore(this.file,{version:1,...this.store,tracked:Object.fromEntries(this.tracked)});
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
   tracked[k]={peakRoePct:v.peakRoePct,partialTaken:v.partialTaken===true,breakevenPlaced:v.breakevenPlaced===true,
    lockStopPrice:v.lockStopPrice??null,lockStopRoe:v.lockStopRoe??null};
  }
  return {
   ...this.store,
   excludedSymbols:[...this.store.excludedSymbols],
   tracked,
  };
 }

 async #cancelStops(st){
  // staleStopIds: older lock stops whose cancel failed when the stop moved up (still on the book, review 2026-11-23).
  for(const id of [st?.lockStopOrderId,st?.breakevenOrderId,...(st?.staleStopIds||[])]){
   if(!id||!st?.venueSymbol)continue;
   try{await this.executeAction({action:'CANCEL_STOP',venueSymbol:st.venueSymbol,orderId:id})}catch{}
  }
 }

 /** positions: the venue's current list. Anything but an array (a failed read) does nothing and keeps the state.
  * openOrders: the account's open orders read for this pass (anything but an array = unreadable: manual positions are
  * then left alone, manual first). */
 async evaluate(positions=[],now=this.now(),{openOrders=null}={}){
  if(this.busy||!Array.isArray(positions))return [];
  // Switched off: no action, but tracked positions still get the clean-up below, so an exchange lock / break-even
  // stop is cancelled once its position is gone instead of resting on the book (review 2026-11-23).
  if(!this.store.enabled&&!this.tracked.size)return [];
  const list=positions;
  this.busy=true;
  const actions=[];
  let dirty=false;
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
    if(!cfg.enabled){const st=this.tracked.get(key);if(st?.missing){st.missing=0;dirty=true}continue}
    if(p.origin==='scalp')continue;
    const isCopy=p.origin==='copy';
    if(isCopy&&!cfg.applyToCopy)continue;
    if(!isCopy&&!cfg.applyToManual)continue;
    // Manual first: a copy row that shares its lane with a manual position, or a manual position with the user's own
    // TP / SL (or orders that cannot be read), is never acted on. Our own earlier stops on it are cancelled once.
    {const prior=this.tracked.get(key);
     const ownIds=new Set([prior?.lockStopOrderId,prior?.breakevenOrderId,...(prior?.staleStopIds||[])].filter(Boolean).map(String));
     const shared=isCopy&&(p.manualQty===null||Number(p.manualQty)>0);
     const userTpSl=isCopy?false:userTpSlOnLane(p,openOrders,ownIds);
     if(shared||userTpSl!==false){
      if(prior&&(shared||userTpSl===true)){
       await this.#cancelStops(prior);this.tracked.delete(key);dirty=true;
       this.log?.('MANUAL_PROTECTED',key,shared?'copy lane shared with manual':'user TP/SL on lane');
       try{await this.sendText(`🛡 [실계좌 트레일링] ${disp} ${sideKo(dir)} ${shared?'같은 자리에 수동 포지션':'사용자 TP/SL 주문'} 확인 — 수동 우선으로 자동 트레일링을 해제했습니다`)}catch{}
      }
      continue;
     }}
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
     // A different position (or a large add): our old exchange stops would close it at the old levels.
     if(st)await this.#cancelStops(st);
     st={peakRoePct:null,partialTaken:false,breakevenPlaced:false,breakevenOrderId:null,avg,lastActionAt:0,
      lockStopOrderId:null,lockStopPrice:null,lockStopRoe:null,venueSymbol:p.venueSymbol||null,staleStopIds:[],missing:0,lockRetryAt:0};
     this.tracked.set(key,st);dirty=true;
    }
    if(p.venueSymbol&&st.venueSymbol!==p.venueSymbol){st.venueSymbol=p.venueSymbol;dirty=true}
    if(st.missing){st.missing=0;dirty=true}
    const armThreshold=Math.min(cfg.partialLockRoePct,cfg.trailActivateRoePct);
    if(roe>=armThreshold&&(st.peakRoePct===null||roe>st.peakRoePct)){
     st.peakRoePct=+roe.toFixed(2);dirty=true;
    }
    if(now-st.lastActionAt<ACTION_COOLDOWN_MS)continue;

    // Step 1: Partial profit lock-in (e.g. 25% or 50%) + optional fee-net breakeven stop on remaining runner
    if(cfg.partialClosePct>0&&!st.partialTaken&&roe>=cfg.partialLockRoePct){
     st.lastActionAt=now;dirty=true;
     const partPct=Math.max(1,Math.min(99,Math.round(Number(cfg.partialClosePct)||50)));
     const remPct=100-partPct;
     const res=await this.executeAction({symbol:p.symbol,direction:dir,action:'CLOSE_HALF',closePct:partPct}).catch(e=>({ok:false,error:e?.code||e?.message}));
     if(res?.ok){
      st.partialTaken=true;
      // Saved before the next venue call: a crash here must not take a second partial after the restart.
      try{this.#save();dirty=false}catch{}
      let beLine='';
      if(cfg.autoBreakeven&&!st.breakevenPlaced){
       const beRes=await this.executeAction({symbol:p.symbol,direction:dir,action:'BREAKEVEN_STOP',feePct:cfg.roundTripFeePct}).catch(()=>({ok:false}));
       if(beRes?.ok){st.breakevenPlaced=true;st.breakevenOrderId=beRes.orderId!=null?String(beRes.orderId):null;dirty=true;beLine=`\n🛡️ 잔여 물량 본전 스탑 자동 설정 (${beRes.stopPrice}, 수수료 포함)`}
      }
      const copyPrefix=isCopy?'[카피] ':'';
      const estPart=Number.isFinite(Number(p.unrealized))?Number(p.unrealized)*(partPct/100):null;
      const msg=`${copyPrefix}💰 [실계좌 자동 익절] ${disp} ${sideKo(dir)} ${partPct}% 부분 익절 확정\n순 ROE +${roe.toFixed(1)}% (수수료 -${feeRoePct.toFixed(1)}% 반영) · 추정 실현 ${money(estPart)}\n잔여 ${remPct}% 고점 대비 ${cfg.trailPullbackRatio}% 트레일링 추적 중${beLine}`;
      try{await this.sendText(msg)}catch{}
      actions.push({key,action:'CLOSE_HALF',closePct:partPct,roePct:roe,grossRoePct:grossRoe,feeRoePct,breakeven:st.breakevenPlaced});
     }else if(res?.error==='HALF_QTY_TOO_SMALL'||res?.error==='VENUE_ERROR_101400'){
      // Position too small (qty or notional) to split -> skip partial lock-in and trail full position instead.
      st.partialTaken=true;
     }
     continue;
    }

    // Step 2: Peak-pullback trailing exit on remaining (or full) position. No lower floor (audit C-3): a drop past
    // the locked level between two checks still closes, even below the minimum lock or into a loss.
    if(st.peakRoePct!==null&&st.peakRoePct>=cfg.trailActivateRoePct){
     const pullback=Math.max(MIN_PULLBACK_ROE,st.peakRoePct*(cfg.trailPullbackRatio/100));
     const stopRoe=+Math.max(cfg.minLockRoePct,st.peakRoePct-pullback).toFixed(2);
     const copyPrefix=isCopy?'[카피] ':'';
     if(roe<=stopRoe){
      st.lastActionAt=now;dirty=true;
      const res=await this.executeAction({symbol:p.symbol,direction:dir,action:'CLOSE_ALL'}).catch(e=>({ok:false,error:e?.code||e?.message}));
      if(res?.ok){
       const msg=`${copyPrefix}🎯 [실계좌 자동 트레일링] ${disp} ${sideKo(dir)} ${roe>0?'익절':'보호'} 청산 완료\n고점 순 ROE +${st.peakRoePct.toFixed(1)}% → 청산 순 ROE ${roe>=0?'+':''}${roe.toFixed(1)}% (${money(p.unrealized)})`;
       try{await this.sendText(msg)}catch{}
       actions.push({key,action:'CLOSE_ALL',peakRoePct:st.peakRoePct,roePct:roe,grossRoePct:grossRoe,feeRoePct});
       await this.#cancelStops(st);
       this.tracked.delete(key);
      }
      continue;
     }
     // Exchange STOP_MARKET at the locked level (survives server downtime); moved up as the peak climbs. A stop order
     // does not change the position, so it never starts the action cooldown (the exit check above keeps running every
     // pass); a failed placement waits 60 s before the next try (review 2026-11-23).
     if((st.lockStopRoe===null||stopRoe>=st.lockStopRoe+LOCK_STOP_STEP_ROE)&&!(now<(st.lockRetryAt||0))){
      const stopPrice=priceForNetRoe({avg,direction:dir,leverage:lev,netRoePct:stopRoe,feeRoePct});
      if(stopPrice){
       dirty=true;
       const replaceOrderIds=[...new Set([st.lockStopOrderId,st.breakevenOrderId].filter(Boolean).map(String))];
       const res=await this.executeAction({symbol:p.symbol,direction:dir,action:'TRAIL_STOP',stopPrice,replaceOrderId:st.lockStopOrderId,...(replaceOrderIds.length?{replaceOrderIds}:{})}).catch(e=>({ok:false,error:e?.code||e?.message}));
       if(res?.ok){
        const first=st.lockStopRoe===null;st.lockRetryAt=0;
        const staleList=[...(Array.isArray(res.staleOrderIds)?res.staleOrderIds:[]),...(res.staleOrderId!=null?[res.staleOrderId]:[])].map(String);
        if(staleList.length)st.staleStopIds=[...new Set([...(st.staleStopIds||[]),...staleList])].slice(-10);
        const canceledList=Array.isArray(res.canceledOrderIds)?res.canceledOrderIds.map(String):[];
        if(st.breakevenOrderId&&canceledList.includes(String(st.breakevenOrderId)))st.breakevenOrderId=null;
        st.lockStopOrderId=res.orderId!=null?String(res.orderId):null;
        st.lockStopPrice=Number(res.stopPrice)||stopPrice;st.lockStopRoe=stopRoe;
        if(first){try{await this.sendText(`${copyPrefix}🛡️ [실계좌 트레일링] ${disp} ${sideKo(dir)} 거래소 잠금 스탑 설정 ${st.lockStopPrice} (순 ROE +${stopRoe.toFixed(1)}% 지점, 서버가 꺼져도 유지)`)}catch{}}
        actions.push({key,action:'TRAIL_STOP',stopPrice:st.lockStopPrice,lockRoePct:stopRoe});
       }else{st.lockRetryAt=now+60000;this.log?.('TRAIL_STOP failed',key,res?.error||'ERROR')}
      }
     }
    }
   }
   for(const [k,st] of [...this.tracked]){
    if(openKeys.has(k))continue;
    // Two lists in a row without it (review 2026-11-23): a venue list can come back empty for a moment, and dropping
    // the state then would cancel the exchange stops and take a second partial when the position shows again.
    st.missing=(st.missing||0)+1;dirty=true;
    if(st.missing<2)continue;
    await this.#cancelStops(st);
    this.tracked.delete(k);
   }
  }finally{
   if(dirty){try{this.#save()}catch(e){this.log?.('save failed',e?.message)}}
   this.busy=false;
  }
  return actions;
 }
}
