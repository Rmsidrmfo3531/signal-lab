// Real-account margin usage alert (user decision 2026-11-24 17:34 "1번은 교차로 진행할건데 'BTC 롱, 청산가까지 0.8% 남음'
// 이거는 굳이 필요없어 교차로 진행할거니까"): the account trades in CROSS margin, so instead of a per-position liquidation
// distance this watches the whole account: used margin ÷ equity from the BingX balance the server already reads.
// ONE Telegram message to the allowed chat when usage first crosses each level (default 70 / 85 / 95 %); a level is
// re-armed only after usage falls 10 points below it; ONE message when usage falls back below the lowest level after an
// alert. State in real-margin-alert.json (a restart never resends). Alert only: no orders, no setting changes, no blocking.
import fs from 'node:fs';
import path from 'node:path';
import {atomicWriteStore,readStore} from './persistence.mjs';

export const REAL_MARGIN_ALERT_FILE='real-margin-alert.json';
export const REAL_MARGIN_DEFAULT_LEVELS=Object.freeze([70,85,95]);
export const REAL_MARGIN_HYSTERESIS_PTS=10;
export const REAL_MARGIN_NOTE='자동 청산·주문 차단 없음 (알림만)';

const err=msg=>Object.assign(Error(msg),{code:'INVALID_MARGIN_ALERT_LEVELS',httpStatus:400});
const fin=v=>v!==null&&v!==undefined&&String(v).trim()!==''&&Number.isFinite(Number(v));
const usd=v=>fin(v)?`$${Number(v).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})}`:'—';
const money=v=>fin(v)?`${Number(v)>=0?'+':'−'}$${Math.abs(Number(v)).toFixed(2)}`:'—';

/** "70,85,95" / [70,85,95] → sorted unique levels in 1..100 (at most 5). Empty or "off" → [] (alert off). */
export function parseMarginLevels(raw){
 if(raw==null)throw err('marginAlertLevels required');
 const parts=Array.isArray(raw)?raw:String(raw).trim().toLowerCase()==='off'?[]:String(raw).split(/[,\s]+/).filter(Boolean);
 const nums=parts.map(Number);
 if(nums.some(v=>!Number.isFinite(v)||v<1||v>100))throw err('증거금 사용률 경보는 1~100 사이 숫자여야 합니다');
 const out=[...new Set(nums.map(v=>+v.toFixed(1)))].sort((a,b)=>a-b);
 if(out.length>5)throw err('증거금 사용률 경보는 최대 5단계까지 설정할 수 있습니다');
 return out;
}
/** REAL_MARGIN_ALERT_LEVELS from the environment, or null when unset / invalid (the defaults then apply). */
export function envMarginLevels(env=process.env,log=()=>{}){
 const raw=env?.REAL_MARGIN_ALERT_LEVELS;
 if(raw==null||String(raw).trim()==='')return null;
 try{return parseMarginLevels(raw)}catch(e){log('[MARGIN ALERT] REAL_MARGIN_ALERT_LEVELS 무시:',e.message);return null}
}

/** The fields this alert needs from a BingX v3 USDT balance row (equity, availableMargin, usedMargin, unrealizedProfit). */
export function marginFieldsOfBingxRow(row){
 if(!row||typeof row!=='object')return null;
 const n=k=>fin(row[k])?Number(row[k]):null;
 return {equity:n('equity'),available:n('availableMargin'),used:n('usedMargin'),unrealized:n('unrealizedProfit')};
}
/** Usage from one balance read: used margin ÷ equity. usedMargin from BingX; without it, equity − available. */
export function marginUsageOf({equity,available,used,unrealized}={}){
 if(!fin(equity)||!(Number(equity)>0))return null;
 const eq=Number(equity);
 const usedUSD=fin(used)?Math.max(0,Number(used)):fin(available)?Math.max(0,eq-Number(available)):null;
 if(usedUSD==null)return null;
 return {pct:+(usedUSD/eq*100).toFixed(2),equityUSD:eq,usedUSD:+usedUSD.toFixed(4),availableUSD:fin(available)?Number(available):null,
  unrealizedUSD:fin(unrealized)?Number(unrealized):null,source:fin(used)?'USED_MARGIN':'EQUITY_MINUS_AVAILABLE'};
}

export function formatMarginAlert({kind,level,usage,openCount}){
 const head=kind==='RECOVERED'
  ?`✅ 실계좌 증거금 사용률 ${usage.pct.toFixed(1)}% · ${level}% 아래로 내려옴`
  :`⚠️ 실계좌 증거금 사용률 ${usage.pct.toFixed(1)}% · ${level}% 넘음`;
 return [head,
  `순자산 ${usd(usage.equityUSD)} · 사용 가능 ${usd(usage.availableUSD)} · 사용 증거금 ${usd(usage.usedUSD)}`,
  `미실현 손익 ${money(usage.unrealizedUSD)} · 열린 포지션 ${Number.isFinite(Number(openCount))?Number(openCount):'—'}개`,
  REAL_MARGIN_NOTE].join('\n');
}

export class RealMarginAlert{
 constructor({directory=null,fileName=REAL_MARGIN_ALERT_FILE,env=process.env,now=()=>Date.now(),send=async()=>true,log=()=>{}}={}){
  Object.assign(this,{now,send,log});
  this.envLevels=envMarginLevels(env,log);
  this.file=directory?path.join(directory,fileName):null;
  let saved=null;
  try{saved=this.file&&fs.existsSync(this.file)?readStore(this.file):null}catch(e){log('[MARGIN ALERT] 상태 읽기 실패',e.message)}
  let custom=null;
  if(saved?.levelsCustom===true&&Array.isArray(saved.levels)){try{custom=parseMarginLevels(saved.levels)}catch{custom=null}}
  this.store={
   levelsCustom:custom!==null,levels:custom,
   // Levels already alerted (not re-armed yet) and whether a recovery notice is due.
   alerted:Array.isArray(saved?.alerted)?saved.alerted.map(Number).filter(Number.isFinite):[],
   recoveryDue:saved?.recoveryDue===true,
   lastAlertAt:Number(saved?.lastAlertAt)||null,lastAlertLevel:Number(saved?.lastAlertLevel)||null,
  };
  this.current=null; // last computed usage (memory only; /status and the screen)
  this.failLoggedAt=0;
 }
 levels(){return this.store.levelsCustom?[...this.store.levels]:[...(this.envLevels??REAL_MARGIN_DEFAULT_LEVELS)]}
 #save(){
  if(!this.file)return;
  try{fs.mkdirSync(path.dirname(this.file),{recursive:true});atomicWriteStore(this.file,{version:1,...this.store})}
  catch(e){this.log('[MARGIN ALERT] 상태 저장 실패',e.message)}
 }
 /** Screen setting (계좌 안전 가드): {marginAlertLevels:"70,85,95"|[..]|""}; {marginAlertLevels:null} = back to env/default. */
 configure(patch={}){
  if(!patch||typeof patch!=='object'||!Object.hasOwn(patch,'marginAlertLevels'))return this.status();
  if(patch.marginAlertLevels===null){this.store.levelsCustom=false;this.store.levels=null}
  else{this.store.levels=parseMarginLevels(patch.marginAlertLevels);this.store.levelsCustom=true}
  // Levels that no longer exist are forgotten; an alerted level that stays keeps its state (no resend).
  const lv=new Set(this.levels());this.store.alerted=this.store.alerted.filter(x=>lv.has(x));
  if(!this.store.alerted.length&&!lv.size)this.store.recoveryDue=false;
  this.#save();
  return this.status();
 }
 async #send(text){
  try{const r=await this.send(text);return r!==false}
  catch(e){
   if(this.now()-this.failLoggedAt>600000){this.failLoggedAt=this.now();this.log('[MARGIN ALERT] 알림 전송 실패',e?.message||'ERROR')}
   return false;
  }
 }
 /** One balance read ({equity, available, used, unrealized}) and the open position count. Never throws. */
 async check({equity,available,used,unrealized,openCount=null}={}){
  const usage=marginUsageOf({equity,available,used,unrealized});
  if(!usage)return {sent:null,reason:'NO_BALANCE'};
  this.current={...usage,openCount:Number.isFinite(Number(openCount))?Number(openCount):null,at:this.now()};
  const levels=this.levels();
  if(!levels.length)return {sent:null,reason:'OFF'};
  const pct=usage.pct;
  let changed=false;
  // Re-arm: 10 points under the level.
  const keep=this.store.alerted.filter(l=>!(pct<l-REAL_MARGIN_HYSTERESIS_PTS));
  if(keep.length!==this.store.alerted.length){this.store.alerted=keep;changed=true}
  const crossed=levels.filter(l=>pct>=l&&!this.store.alerted.includes(l));
  let sent=null;
  if(crossed.length){
   // A jump over several levels at once: one message, for the highest.
   const level=crossed.at(-1);
   if(await this.#send(formatMarginAlert({kind:'ALERT',level,usage,openCount}))){
    this.store.alerted=[...new Set([...this.store.alerted,...crossed])].sort((a,b)=>a-b);
    Object.assign(this.store,{recoveryDue:true,lastAlertAt:this.now(),lastAlertLevel:level});
    changed=true;sent={kind:'ALERT',level};
   }
  }else if(this.store.recoveryDue&&pct<levels[0]){
   if(await this.#send(formatMarginAlert({kind:'RECOVERED',level:levels[0],usage,openCount}))){
    this.store.recoveryDue=false;changed=true;sent={kind:'RECOVERED',level:levels[0]};
   }
  }
  if(changed)this.#save();
  return {sent,pct};
 }
 status(){
  return {levels:this.levels(),levelsSource:this.store.levelsCustom?'SCREEN':this.envLevels?'ENV':'DEFAULT',hysteresisPts:REAL_MARGIN_HYSTERESIS_PTS,
   alerted:[...this.store.alerted],current:this.current?{...this.current}:null,lastAlertAt:this.store.lastAlertAt,lastAlertLevel:this.store.lastAlertLevel,note:REAL_MARGIN_NOTE};
 }
}
