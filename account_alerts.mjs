// Real-account Telegram operations & alerts (user 2026-11-20):
//  - #2 Combined manual + copy real-time risk alerts (margin usage % & unrealized loss %)
//  - #5 Daily closing summary report (00:00 KST, plus on-demand /report)
//  - #6 Private-chat Telegram bot commands (/status, /pause, /resume, /close + /confirm, /report, /help)
//    2026-11-23 (user decision (c)): /resume and /size are 2-step too (/confirm within 60 s); /resume never releases
//    the copy loss-limit stop (screen COPY_RESUME only); commands older than the process start or 2 minutes are dropped.
//  - #7 Position ROI milestone alerts (manual + copy)
//  - #8 Copy entry/add skip alert toggle + 5-min deduplication
// Never emits scan signals; only operates on confirmed real-account state & authorized private chat.
import fs from 'node:fs';
import path from 'node:path';
import {randomInt} from 'node:crypto';
import {atomicWriteStore,readStore} from './persistence.mjs';
import {createTelegramNetworkRecovery} from './telegram_transport.mjs';
import {displaySymbol} from './public/symbol_display.js';

export const ACCOUNT_ALERTS_DEFAULTS=Object.freeze({
 riskAlerts:true,
 marginWarnPcts:[50,70],
 lossWarnPcts:[10,20],
 dailyReport:true,
 roiAlerts:true,
 profitRoiPcts:[50,100,200],
 lossRoiPcts:[30,50,75],
 positionSummaryAlerts:true,
 positionSummaryIntervalMin:5,
 positionSummaryMinDeltaUSD:2,
 skipAlerts:true,
 remoteCommands:true,
});

const KST_MS=9*3600000;
const RISK_COOLDOWN_MS=30*60000;
const SKIP_DEDUP_MS=5*60000;
const CONFIRM_TTL_MS=60000;
const COMMAND_MAX_AGE_MS=120000;
const NOISY_SKIPS=new Set(['NOT_COPIED','COPY_OFF','MONITOR_RESTART_SNAPSHOT','STALE_MESSAGE']);

export const kstDay=t=>new Date(Number(t)+KST_MS).toISOString().slice(0,10);
const money=v=>{const n=Number(v);return v==null||!Number.isFinite(n)?'—':`${n>=0?'+':'−'}$${Math.abs(n).toFixed(2)}`};
const usd=v=>{const n=Number(v);return v==null||!Number.isFinite(n)?'—':`$${n.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})}`};
const px=v=>{const n=Number(v);return Number.isFinite(n)&&n>0?String(+n.toPrecision(6)):'—'};
const sideKo=d=>d==='LONG'?'🟢 롱':d==='SHORT'?'🔴 숏':String(d||'');
const originKo=o=>o==='copy'?'카피':'수동';
const err=msg=>Object.assign(Error(msg),{code:'INVALID_ACCOUNT_ALERTS',httpStatus:400});

const escHtml=s=>String(s??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
const isHtmlMessage=s=>/<(?:b|i|u|s|a|pre|code)\b[^>]*>[\s\S]*<\/(?:b|i|u|s|a|pre|code)>/.test(String(s||''));

function positionRowParts(p){
 const sym=displaySymbol(p?.symbol||p?.venueSymbol||'');
 const dir=String(p?.direction||p?.side||'').toUpperCase();
 const side=dir==='LONG'?'롱':dir==='SHORT'?'숏':'';
 const u=Number(p?.unrealized);
 const hasU=p?.unrealized!=null&&Number.isFinite(u);
 const pnl=hasU?`${u>=0?'+':'-'}$${Math.abs(u).toFixed(2)}`:'—';
 let roeNum=Number(p?.roePct);
 if((p?.roePct==null||!Number.isFinite(roeNum))&&hasU&&Number(p?.margin)>0)roeNum=u/Number(p.margin)*100;
 const roe=Number.isFinite(roeNum)?`${roeNum>=0?'+':'-'}${Math.abs(roeNum).toFixed(1)}%`:null;
 const dot=!hasU?'⚪':u>0?'🟢':u<0?'🔴':'⚪';
 return {sym,side,u:hasU?u:null,pnl,roe,dot};
}

export function formatPositionPnlLine(p){
 const r=positionRowParts(p);
 const sidePart=r.side?` [${r.side}]`:'';
 const roe=r.roe?` (${r.roe})`:'';
 return `${r.dot} <b>${escHtml(r.sym)}</b>${sidePart}   ${r.pnl}${roe}`;
}

export function formatPositionsSummary(positions=[]){
 const list=Array.isArray(positions)?positions:[];
 if(!list.length)return '보유 중인 포지션이 없습니다.';
 const sorted=[...list].sort((a,b)=>(Number(b?.unrealized)||0)-(Number(a?.unrealized)||0));
 const hasTotal=sorted.some(p=>p?.unrealized!=null&&Number.isFinite(Number(p.unrealized)));
 const totalVal=hasTotal?sorted.reduce((s,p)=>s+(Number(p?.unrealized)||0),0):null;
 const totalText=hasTotal?` · 합계 <b>${totalVal>=0?'+':'-'}$${Math.abs(totalVal).toFixed(2)}</b>`:'';
 return [
  `📊 <b>진행 중 포지션 (${sorted.length}개)</b>${totalText}`,
  '',
  ...sorted.map(formatPositionPnlLine),
 ].join('\n');
}

function parseTierList(raw,lo,hi,field){
 if(!Array.isArray(raw))throw err(`${field} must be an array`);
 const nums=[...new Set(raw.map(Number).filter(v=>Number.isFinite(v)&&v>=lo&&v<=hi).map(v=>+v.toFixed(1)))].sort((a,b)=>a-b);
 if(nums.length>6)throw err(`${field}는 최대 6개 단계까지 설정할 수 있습니다`);
 return nums;
}

export function formatDailyReport({day,copyClosed=[],manualClosed=[],dailyByDay=null,equityUSD=null,openCount=0,liveToday=false}){
 const confirmed=x=>['EXCHANGE','EXCHANGE_FILLS'].includes(x?.netSource)&&x?.netUSD!=null&&Number.isFinite(Number(x.netUSD));
 const onDay=list=>(Array.isArray(list)?list:[]).filter(x=>!x?.archivedFromHistory&&Number(x?.closedAt)>0&&kstDay(x.closedAt)===day&&confirmed(x));
 const summarize=list=>{
  const n=list.length,wins=list.filter(x=>Number(x.netUSD)>0).length;
  const net=list.reduce((s,x)=>s+Number(x.netUSD),0);
  return {n,wins,wr:n?Math.round(wins/n*100):null,net};
 };
 const cp=summarize(onDay(copyClosed)),man=summarize(onDay(manualClosed));
 const ledgerTotal=cp.net+man.net;
 const exchangeDay=dailyByDay&&Number.isFinite(Number(dailyByDay[day]))?Number(dailyByDay[day]):null;
 const lines=[
  `📊 ${liveToday?'오늘 중간 리포트':'일일 마감 리포트'} · ${day} KST`,
  exchangeDay!=null?`거래소 실현 합계: ${money(exchangeDay)} (수수료·펀딩 포함)`:`원장 정산 합계: ${money(cp.n+man.n?ledgerTotal:0)}`,
  `· 카피: ${cp.n}건${cp.n?` · 승률 ${cp.wr}% · ${money(cp.net)}`:''}`,
  `· 수동: ${man.n}건${man.n?` · 승률 ${man.wr}% · ${money(man.net)}`:''}`,
  `현재 순자산: ${usd(equityUSD)} · 보유 포지션 ${openCount}개`,
 ];
 return lines.join('\n');
}

export function formatStatusReply({equityUSD,availableUSD,positions=[],copy}){
 const list=Array.isArray(positions)?positions:[];
 const totalMargin=list.reduce((s,p)=>s+(Number(p.margin)||0),0);
 const totalUnreal=list.reduce((s,p)=>s+(Number(p.unrealized)||0),0);
 const marginPct=equityUSD>0?totalMargin/equityUSD*100:null;
 const copyState=copy?.killed?'⛔ 손실 한도 정지':!copy?.enabled?'○ 카피 꺼짐':copy?.controls?.cooldownActive?`⏸ 쿨다운 (${copy.controls.cooldownLeftMin}분 남음)`:copy?.armed?'● 활성화':'○ 비활성';
 const lines=[
  `📋 <b>실계좌 현황</b>`,
  `순자산 ${usd(equityUSD)} · 가용 ${usd(availableUSD)}`,
  `증거금 ${usd(totalMargin)}${marginPct!=null?` (${marginPct.toFixed(1)}%)`:''} · 미실현 ${money(totalUnreal)}`,
  `카피 상태: ${copyState}${copy?.traderBalanceUSD?` · 기준 $${Number(copy.traderBalanceUSD).toLocaleString()}`:''}`,
 ];
 if(!list.length)lines.push('보유 포지션 없음');
 else{
  const sorted=[...list].sort((a,b)=>(Number(b?.unrealized)||0)-(Number(a?.unrealized)||0));
  lines.push('',`보유 포지션 (${sorted.length}개)`);
  for(const p of sorted.slice(0,20))lines.push(formatPositionPnlLine(p));
 }
 return lines.join('\n');
}

export function formatScalpStatusReply(rt,{now=Date.now()}={}){
 if(!rt)return '⚠️ 테스트넷 단타 상태를 조회하지 못했습니다.';
 const state=rt.mode!=='TESTNET'?'○ 꺼짐 (TESTNET 아님)':!rt.armed?'○ 비활성':rt.blocked?`■ 진입 중지 (${rt.blocked})`:rt.scanning?'● 5분봉 스캔 진행 중':'● 활성화 (5분 감시 중)';
 const rules=[
  `4H 추세: ${rt.trendMode==='on'?'역추세 차단':rt.trendMode==='off'?'미사용':'기록만'}`,
  `손절: ${rt.stopLossEnabled?'ON':'무손절'}`,
  `반복추매: ${rt.repeatedScaleIn?'ON':'OFF'}`,
  `보유: ${rt.open??0}개`,
 ].join(' · ');
 const ls=rt.lastScan;
 let scanLine='마지막 스캔: 아직 기록 없음 (다음 5분봉 마감 대기)';
 if(ls?.at){
  const kstTime=new Date(Number(ls.at)+KST_MS).toISOString().slice(5,16).replace('T',' ');
  const ageMin=Math.max(0,Math.floor((now-Number(ls.at))/60000));
  const denom=Number(rt.universeCount)||Number(ls.checked)||0;
  const det=(Number(ls.signals)||0)+(Number(ls.zoneSignals)||0);
  const extras=[
   ls.failed>0?`실패 ${ls.failed}건${ls.lastFailure?`(${ls.lastFailure})`:''}`:null,
   ls.error?`오류 ${ls.error}`:null,
  ].filter(Boolean).join(' · ');
  scanLine=`마지막 스캔: ${kstTime} KST (${ageMin===0?'방금':ageMin+'분 전'}) · 검사 ${ls.checked??0}/${denom}종목 · 감지 ${det}건 · 진입 ${ls.entered??0}건${extras?' · ⚠️ '+extras:''}`;
 }
 return ['⚡ 테스트넷 단타 현황',`상태: ${state}`,rules,scanLine].join('\n');
}

export class AccountAlerts{
 constructor({directory=null,fileName='account-alerts.json',now=()=>Date.now(),log=()=>{},
  sendText=async()=>({ok:false}),post=null,allowedChatId='',
  getSnapshot=async()=>null,getScalpStatus=async()=>null,onControls=null,
  onPause=async()=>null,onResume=async()=>null,onClose=async()=>null}={}){
  Object.assign(this,{now,log,sendText,allowedChatId:String(allowedChatId||'').trim(),getSnapshot,getScalpStatus,onControls,onPause,onResume,onClose});
  this.file=directory?path.join(directory,fileName):null;
  const saved=this.file&&fs.existsSync(this.file)?readStore(this.file):null;
  this.store={
   riskAlerts:saved?.riskAlerts!==false,
   marginWarnPcts:Array.isArray(saved?.marginWarnPcts)?saved.marginWarnPcts:[...ACCOUNT_ALERTS_DEFAULTS.marginWarnPcts],
   lossWarnPcts:Array.isArray(saved?.lossWarnPcts)?saved.lossWarnPcts:[...ACCOUNT_ALERTS_DEFAULTS.lossWarnPcts],
   dailyReport:saved?.dailyReport!==false,
   roiAlerts:saved?.roiAlerts!==false,
   profitRoiPcts:Array.isArray(saved?.profitRoiPcts)?saved.profitRoiPcts:[...ACCOUNT_ALERTS_DEFAULTS.profitRoiPcts],
   lossRoiPcts:Array.isArray(saved?.lossRoiPcts)?saved.lossRoiPcts:[...ACCOUNT_ALERTS_DEFAULTS.lossRoiPcts],
   positionSummaryAlerts:saved?.positionSummaryAlerts!==false,
   positionSummaryIntervalCustom:saved?.positionSummaryIntervalCustom===true,
   positionSummaryIntervalMin:(()=>{
    const n=Math.round(Number(saved?.positionSummaryIntervalMin));
    if(!Number.isFinite(n)||n<1||n>1440)return ACCOUNT_ALERTS_DEFAULTS.positionSummaryIntervalMin;
    if(saved?.positionSummaryIntervalCustom!==true&&n===30)return ACCOUNT_ALERTS_DEFAULTS.positionSummaryIntervalMin;
    return n;
   })(),
   positionSummaryMinDeltaUSD:(()=>{
    const n=Number(saved?.positionSummaryMinDeltaUSD);
    return saved?.positionSummaryMinDeltaUSD!=null&&Number.isFinite(n)&&n>=0&&n<=1000?+n.toFixed(2):ACCOUNT_ALERTS_DEFAULTS.positionSummaryMinDeltaUSD;
   })(),
   skipAlerts:saved?.skipAlerts!==false,
   remoteCommands:saved?.remoteCommands!==false,
   lastDailyReportDay:typeof saved?.lastDailyReportDay==='string'?saved.lastDailyReportDay:null,
   lastPositionSummaryAt:Number.isFinite(Number(saved?.lastPositionSummaryAt))?Number(saved.lastPositionSummaryAt):null,
   lastPositionSummarySig:typeof saved?.lastPositionSummarySig==='string'?saved.lastPositionSummarySig:null,
   lastPositionSummaryTotal:saved?.lastPositionSummaryTotal!=null&&Number.isFinite(Number(saved?.lastPositionSummaryTotal))?Number(saved.lastPositionSummaryTotal):null,
   lastUpdateId:Number.isSafeInteger(saved?.lastUpdateId)?saved.lastUpdateId:null,
  };
  this.bootAt=this.now();
  this.riskSent=new Map(); // key -> {at, armed}
  this.positionTiers=new Map(); // posKey -> {profit:number, loss:number}
  this.skipDedup=new Map(); // skipKey -> at
  this.pendingAction=null; // {kind:'CLOSE'|'RESUME'|'SIZE', code, expiresAt, ...}
  this.polling=false;
  this.getUpdatesRequest=typeof post==='function'
   ?createTelegramNetworkRecovery((payload,options)=>post(payload,{...options,method:'getUpdates'}))
   :null;
  this.replyRequest=typeof post==='function'?createTelegramNetworkRecovery(post):null;
 }

 #save(){
  if(!this.file)return;
  fs.mkdirSync(path.dirname(this.file),{recursive:true});
  atomicWriteStore(this.file,{version:1,...this.store});
 }

 configure(patch={}){
  if(!patch||typeof patch!=='object'||Array.isArray(patch))throw err('JSON object required');
  const next={...this.store};
  for(const k of ['riskAlerts','dailyReport','roiAlerts','positionSummaryAlerts','skipAlerts','remoteCommands']){
   if(Object.hasOwn(patch,k)){
    if(typeof patch[k]!=='boolean')throw err(`${k} must be a boolean`);
    next[k]=patch[k];
   }
  }
  if(Object.hasOwn(patch,'positionSummaryIntervalMin')){
   const n=Math.round(Number(patch.positionSummaryIntervalMin));
   if(!Number.isFinite(n)||n<1||n>1440)throw err('positionSummaryIntervalMin must be 1..1440');
   next.positionSummaryIntervalMin=n;
   next.positionSummaryIntervalCustom=true;
  }
  if(Object.hasOwn(patch,'positionSummaryMinDeltaUSD')){
   const n=Number(patch.positionSummaryMinDeltaUSD);
   if(!Number.isFinite(n)||n<0||n>1000)throw err('positionSummaryMinDeltaUSD must be 0..1000');
   next.positionSummaryMinDeltaUSD=+n.toFixed(2);
  }
  if(Object.hasOwn(patch,'marginWarnPcts'))next.marginWarnPcts=parseTierList(patch.marginWarnPcts,10,95,'marginWarnPcts');
  if(Object.hasOwn(patch,'lossWarnPcts'))next.lossWarnPcts=parseTierList(patch.lossWarnPcts,2,80,'lossWarnPcts');
  if(Object.hasOwn(patch,'profitRoiPcts'))next.profitRoiPcts=parseTierList(patch.profitRoiPcts,10,1000,'profitRoiPcts');
  if(Object.hasOwn(patch,'lossRoiPcts'))next.lossRoiPcts=parseTierList(patch.lossRoiPcts,10,95,'lossRoiPcts');
  this.store=next;
  this.#save();
  return this.status();
 }

 status(){
  return {
   riskAlerts:this.store.riskAlerts,
   marginWarnPcts:[...this.store.marginWarnPcts],
   lossWarnPcts:[...this.store.lossWarnPcts],
   dailyReport:this.store.dailyReport,
   roiAlerts:this.store.roiAlerts,
   profitRoiPcts:[...this.store.profitRoiPcts],
   lossRoiPcts:[...this.store.lossRoiPcts],
   positionSummaryAlerts:this.store.positionSummaryAlerts,
   positionSummaryIntervalMin:this.store.positionSummaryIntervalMin,
   positionSummaryMinDeltaUSD:this.store.positionSummaryMinDeltaUSD,
   skipAlerts:this.store.skipAlerts,
   remoteCommands:this.store.remoteCommands,
   lastDailyReportDay:this.store.lastDailyReportDay,
   lastPositionSummaryAt:this.store.lastPositionSummaryAt,
  };
 }

 /** #8 Filter + 5-min deduplication for copy SKIPPED / ADD_SKIPPED Telegram alerts. */
 shouldSendSkip(e,now=this.now()){
  if(!this.store.skipAlerts||!e)return false;
  if(NOISY_SKIPS.has(e.reason))return false;
  const key=`${e.symbol||''}|${e.direction||''}|${e.type||''}|${e.reason||''}`;
  const prev=this.skipDedup.get(key)||0;
  if(now-prev<SKIP_DEDUP_MS)return false;
  this.skipDedup.set(key,now);
  if(this.skipDedup.size>300){
   for(const [k,at] of this.skipDedup)if(now-at>=SKIP_DEDUP_MS)this.skipDedup.delete(k);
  }
  return true;
 }

 /** #2 Combined manual + copy margin usage & unrealized loss alerts. */
 async checkRisk({equityUSD,positions=[],now=this.now()}={}){
  if(!this.store.riskAlerts||!(Number(equityUSD)>0))return [];
  const list=Array.isArray(positions)?positions:[];
  const eq=Number(equityUSD);
  const totalMargin=list.reduce((s,p)=>s+(Number(p.margin)||0),0);
  const totalUnreal=list.reduce((s,p)=>s+(Number(p.unrealized)||0),0);
  const copyN=list.filter(p=>p.origin==='copy').length,manN=list.length-copyN;
  const marginPct=totalMargin/eq*100;
  const lossPct=totalUnreal<0?(-totalUnreal/eq*100):0;
  const sent=[];

  const evaluate=(kind,value,tiers,buildText)=>{
   for(const tier of tiers){
    const key=`${kind}:${tier}`;
    const st=this.riskSent.get(key)||{at:0,active:false};
    if(value<Math.max(0,tier-5)){
     if(st.active)this.riskSent.set(key,{...st,active:false});
     continue;
    }
    if(value>=tier&&!st.active&&now-st.at>=RISK_COOLDOWN_MS){
     this.riskSent.set(key,{at:now,active:true});
     sent.push({kind,tier,text:buildText(tier)});
    }
   }
  };

  evaluate('margin',marginPct,this.store.marginWarnPcts,tier=>
   `⚠️ 실계좌 통합 위험 경보 · 증거금 사용률 ${marginPct.toFixed(1)}% (기준 ${tier}%)\n순자산 ${usd(eq)} · 사용 증거금 ${usd(totalMargin)} · 포지션 ${list.length}개 (카피 ${copyN} · 수동 ${manN})\n합산 미실현 ${money(totalUnreal)}`);

  evaluate('loss',lossPct,this.store.lossWarnPcts,tier=>
   `🚨 실계좌 통합 손실 경보 · 합산 미실현 ${money(totalUnreal)} (−${lossPct.toFixed(1)}%, 기준 −${tier}%)\n순자산 ${usd(eq)} · 사용 증거금 ${usd(totalMargin)} (${marginPct.toFixed(1)}%) · 포지션 ${list.length}개 (카피 ${copyN} · 수동 ${manN})`);

  // Send only the highest newly crossed tier per kind to avoid double messages on a sudden jump.
  const highestByKind=new Map();
  for(const item of sent)highestByKind.set(item.kind,item);
  const delivered=[];
  for(const item of highestByKind.values()){
   try{await this.sendText(item.text);delivered.push(item)}catch(e){this.log('[ALERTS] risk send failed',e?.message)}
  }
  return delivered;
 }

 /** #7 Position ROI milestone alerts for both manual and copy positions. */
 async checkPositions({positions=[],now=this.now()}={}){
  if(!this.store.roiAlerts)return [];
  const list=Array.isArray(positions)?positions:[];
  const openKeys=new Set();
  const delivered=[];

  for(const p of list){
   const key=`${p.venueSymbol||p.symbol}|${p.direction}`;
   openKeys.add(key);
   const roe=Number(p.roePct);
   if(!Number.isFinite(roe))continue;
   const prev=this.positionTiers.get(key)||{profit:0,loss:0};

   if(roe>0){
    const hit=[...this.store.profitRoiPcts].filter(t=>roe>=t&&t>prev.profit).at(-1);
    if(hit){
     prev.profit=hit;
     this.positionTiers.set(key,prev);
     const text=`🎯 포지션 수익 도달 · ${originKo(p.origin)} ${displaySymbol(p.symbol)} ${sideKo(p.direction)}\n수익률 +${roe.toFixed(1)}% (${money(p.unrealized)}) · 기준 +${hit}%\n평단 ${px(p.avg)} · 현재 ${px(p.mark)} · 증거금 ${usd(p.margin)}`;
     try{await this.sendText(text);delivered.push({key,kind:'profit',tier:hit,text})}catch{}
    }
   }else if(roe<0){
    const mag=Math.abs(roe);
    const hit=[...this.store.lossRoiPcts].filter(t=>mag>=t&&t>prev.loss).at(-1);
    if(hit){
     prev.loss=hit;
     this.positionTiers.set(key,prev);
     const text=`🔻 포지션 손실 경고 · ${originKo(p.origin)} ${displaySymbol(p.symbol)} ${sideKo(p.direction)}\n수익률 −${mag.toFixed(1)}% (${money(p.unrealized)}) · 기준 −${hit}%\n평단 ${px(p.avg)} · 현재 ${px(p.mark)} · 증거금 ${usd(p.margin)}`;
     try{await this.sendText(text);delivered.push({key,kind:'loss',tier:hit,text})}catch{}
    }
   }
  }
  for(const k of this.positionTiers.keys())if(!openKeys.has(k))this.positionTiers.delete(k);
  return delivered;
 }

 /** #5 Daily summary report at 00:00 KST rollover (or on-demand when force=true). */
 async checkDailyReport({copyClosed=[],manualClosed=[],dailyByDay=null,equityUSD=null,openCount=0,now=this.now(),force=false}={}){
  if(!force&&!this.store.dailyReport)return {sent:false,reason:'DISABLED'};
  const targetDay=force?kstDay(now):kstDay(now-86400000);
  if(!force&&this.store.lastDailyReportDay===targetDay)return {sent:false,reason:'ALREADY_SENT'};
  if(!force&&this.store.lastDailyReportDay===null){
   // First run ever: mark yesterday as seen if we booted well after midnight (past 01:00 KST) so we don't fire mid-day.
   const hourKst=new Date(now+KST_MS).getUTCHours();
   if(hourKst>=1){
    this.store.lastDailyReportDay=targetDay;
    this.#save();
    return {sent:false,reason:'INITIALIZED'};
   }
  }
  const text=formatDailyReport({day:targetDay,copyClosed,manualClosed,dailyByDay,equityUSD,openCount,liveToday:force});
  await this.sendText(text);
  if(!force){this.store.lastDailyReportDay=targetDay;this.#save()}
  return {sent:true,day:targetDay,text};
 }

 /** Periodic open-position PnL summary alert (one compact line per open position). */
 async checkPositionSummary({positions=[],now=this.now(),force=false}={}){
  if(!force&&!this.store.positionSummaryAlerts)return {sent:false,reason:'DISABLED'};
  const list=Array.isArray(positions)?positions:[];
  if(!list.length)return {sent:false,reason:'NO_POSITIONS'};
  const intervalMs=(this.store.positionSummaryIntervalMin||ACCOUNT_ALERTS_DEFAULTS.positionSummaryIntervalMin)*60000;
  if(!force&&this.store.lastPositionSummaryAt!=null&&now-this.store.lastPositionSummaryAt<intervalMs)
   return {sent:false,reason:'COOLDOWN'};
  const sig=list.map(p=>`${displaySymbol(p?.symbol||p?.venueSymbol||'')}|${String(p?.direction||p?.side||'').toUpperCase()}`).sort().join(',');
  const hasTotal=list.some(p=>p?.unrealized!=null&&Number.isFinite(Number(p.unrealized)));
  const total=hasTotal?list.reduce((s,p)=>s+(Number(p?.unrealized)||0),0):null;
  const minDelta=Number(this.store.positionSummaryMinDeltaUSD)||0;
  const heartbeatMs=Math.max(intervalMs,30*60000);
  if(!force&&minDelta>0&&this.store.lastPositionSummaryAt!=null&&now-this.store.lastPositionSummaryAt<heartbeatMs
   &&sig===this.store.lastPositionSummarySig&&total!==null&&this.store.lastPositionSummaryTotal!==null
   &&Math.abs(total-this.store.lastPositionSummaryTotal)<minDelta){
   return {sent:false,reason:'UNCHANGED'};
  }
  const text=formatPositionsSummary(list);
  await this.sendText(text);
  this.store.lastPositionSummaryAt=now;
  this.store.lastPositionSummarySig=sig;
  this.store.lastPositionSummaryTotal=total;
  this.#save();
  return {sent:true,count:list.length,text};
 }

 /** #6 Execute a single authorized Telegram command and return reply text. */
 async handleCommand(rawText,chatId,now=this.now()){
  if(!this.store.remoteCommands)return null;
  if(!this.allowedChatId||String(chatId??'').trim()!==this.allowedChatId)return null;
  const text=String(rawText||'').trim();
  if(!text.startsWith('/'))return null;
  const parts=text.split(/\s+/);
  const cmd=parts[0].split('@')[0].toLowerCase();

  if(cmd==='/help'||cmd==='/도움'||cmd==='/start'){
   return [
    '🤖 Signal Lab 원격 명령어',
    '/status — 실계좌 잔고·증거금·보유 포지션',
    '/pos [분] — 진행 중 포지션 손익 요약 (숫자 입력 시 알림 주기 변경)',
    '/scalp — 테스트넷 단타 5분 스캔 상태',
    '/report — 오늘 KST 손익 중간 리포트',
    '/size [금액|0.5x|1x|2x] — 카피 기준 잔고 조회·변경',
    '/block [종목] — 카피 제외 목록 조회·추가',
    '/unblock 종목 — 카피 제외 목록에서 제거',
    '/pause · /resume — 실계좌 카피 일시정지·재개 (재개는 2단계 확인, 손실 한도 정지는 화면에서만 해제)',
    '/close 종목 [LONG|SHORT] 또는 /close ALL — 청산 (2단계 확인)',
    '/confirm 코드 — /close · /resume · /size 실행 확인 (60초 안)',
   ].join('\n');
  }

  if(cmd==='/pos'||cmd==='/포지션'){
   const arg=String(parts[1]||'').trim().replace(/분$/,'');
   if(arg){
    const mins=Math.round(Number(arg));
    if(!Number.isFinite(mins)||mins<1||mins>1440)return '⚠️ 알림 주기는 1 ~ 1440분 사이 숫자로 입력하세요. (예: /pos 5 또는 /pos 1)';
    this.configure({positionSummaryAlerts:true,positionSummaryIntervalMin:mins});
    return `✅ 진행 중 포지션 알림 주기를 ${mins}분으로 변경했습니다.`;
   }
   const snap=await this.getSnapshot();
   if(!snap)return '⚠️ 현재 포지션을 조회하지 못했습니다.';
   return formatPositionsSummary(snap.positions||[]);
  }

  if(cmd==='/status'||cmd==='/상태'){
   const snap=await this.getSnapshot();
   if(!snap)return '⚠️ 현재 실계좌 상태를 조회하지 못했습니다.';
   return formatStatusReply(snap);
  }

  if(cmd==='/scalp'||cmd==='/단타'){
   const rt=await this.getScalpStatus();
   return formatScalpStatusReply(rt,{now});
  }

  if(cmd==='/size'||cmd==='/비중'){
   if(typeof this.onControls!=='function')return '⚠️ 카피 비중 제어가 연결되어 있지 않습니다.';
   const arg=String(parts[1]||'').trim().toLowerCase().replace(/[,$]/g,'');
   if(!arg){
    const cur=await this.onControls(null);
    const tb=cur?.traderBalanceUSD??20000;
    return `⚖️ 현재 카피 기준 잔고: $${Number(tb).toLocaleString()}\n변경 예: /size 20000 (1배) · /size 40000 (0.5배) · /size 10000 (2배)\n또는 /size 0.5x · /size 1x · /size 1.5x · /size 2x`;
   }
   const presetMap={'0.5x':40000,'1x':20000,'1.5x':13333,'2x':10000};
   let next=presetMap[arg]??null;
   if(next==null){
    const km=/^(\d+(?:\.\d+)?)k$/.exec(arg);
    next=km?Math.round(Number(km[1])*1000):Number(arg);
   }
   if(!Number.isFinite(next)||next<1000||next>1000000)return '⚠️ 기준 잔고는 1,000 ~ 1,000,000 USD 사이로 입력하세요. (예: /size 20000 또는 /size 0.5x)';
   next=Math.round(next);
   // 2-step (user decision 2026-11-23 (c)): shows the before / after copy size before anything changes.
   let cur=null;try{cur=await this.onControls(null)}catch{}
   const before=Number(cur?.traderBalanceUSD)||null;
   const factor=before?before/next:null;
   const code=String(randomInt(1000,10000));
   this.pendingAction={kind:'SIZE',code,traderBalanceUSD:next,before,expiresAt:now+CONFIRM_TTL_MS};
   const big=factor&&(factor>3||factor<1/3)?`\n⚠️ 한 번에 ${factor>1?factor.toFixed(1)+'배로 커지는':(1/factor).toFixed(1)+'분의 1로 줄어드는'} 큰 변경입니다.`:'';
   return `⚠️ 카피 기준 잔고 변경 확인\n변경 전: ${before?'$'+before.toLocaleString():'확인 불가'} → 변경 후: $${next.toLocaleString()}\n카피 수량: ${factor?`지금의 ${factor.toFixed(2)}배`:'확인 불가'} (내 가용 증거금 ÷ 기준 잔고, 진입·추매마다 다시 계산)${big}\n실행하려면 60초 안에 아래 명령을 보내세요:\n/confirm ${code}`;
  }

  if(cmd==='/block'||cmd==='/제외'){
   if(typeof this.onControls!=='function')return '⚠️ 종목 필터 제어가 연결되어 있지 않습니다.';
   const sym=String(parts[1]||'').trim();
   if(!sym){
    const cur=await this.onControls(null);
    const c=cur?.controls||{};
    const mode=c.filterMode==='ALLOWLIST'?'허용 목록(화이트리스트)':'제외 목록(블랙리스트)';
    const list=(c.filterMode==='ALLOWLIST'?c.allowedSymbols:c.blockedSymbols)||[];
    return `🚫 종목 필터 (${mode})\n${list.length?list.map(displaySymbol).join(', '):'등록된 종목 없음'}\n추가: /block BTC · 제거: /unblock BTC`;
   }
   try{
    const res=await this.onControls({addBlocked:sym});
    const list=(res?.controls?.blockedSymbols||[]).map(displaySymbol);
    return `🚫 ${displaySymbol(sym.toUpperCase().endsWith('USDT')?sym.toUpperCase():sym.toUpperCase()+'USDT')} 종목을 카피 제외 목록에 추가했습니다.\n현재 제외 목록 (${list.length}개): ${list.join(', ')||'없음'}`;
   }catch(e){return `⚠️ 제외 추가 실패: ${e?.message||'ERROR'}`}
  }

  if(cmd==='/unblock'||cmd==='/해제'){
   if(typeof this.onControls!=='function')return '⚠️ 종목 필터 제어가 연결되어 있지 않습니다.';
   const sym=String(parts[1]||'').trim();
   if(!sym)return '사용법: /unblock 종목 (예: /unblock BTC)';
   try{
    const res=await this.onControls({removeBlocked:sym});
    const list=(res?.controls?.blockedSymbols||[]).map(displaySymbol);
    return `✅ ${displaySymbol(sym.toUpperCase().endsWith('USDT')?sym.toUpperCase():sym.toUpperCase()+'USDT')} 종목을 제외 목록에서 제거했습니다.\n현재 제외 목록 (${list.length}개): ${list.join(', ')||'없음'}`;
   }catch(e){return `⚠️ 제외 제거 실패: ${e?.message||'ERROR'}`}
  }

  if(cmd==='/pause'||cmd==='/정지'){
   this.pendingAction=null;
   await this.onPause();
   return '⏸ 실계좌 카피 매매를 일시정지(비활성화)했습니다.\n기존 포지션은 유지되며 새 진입만 멈춥니다.';
  }

  if(cmd==='/resume'||cmd==='/재개'){
   const code=String(randomInt(1000,10000));
   this.pendingAction={kind:'RESUME',code,expiresAt:now+CONFIRM_TTL_MS};
   return `⚠️ 실계좌 카피 재개 확인\n새 진입·추매가 다시 실행됩니다. (손실 한도 정지는 텔레그램으로 풀 수 없고 화면에서만 해제합니다)\n실행하려면 60초 안에 아래 명령을 보내세요:\n/confirm ${code}`;
  }

  if(cmd==='/report'||cmd==='/리포트'){
   const snap=await this.getSnapshot();
   if(!snap)return '⚠️ 리포트 데이터를 조회하지 못했습니다.';
   return formatDailyReport({
    day:kstDay(now),
    copyClosed:snap.copyClosed||[],
    manualClosed:snap.manualClosed||[],
    dailyByDay:snap.dailyByDay||null,
    equityUSD:snap.equityUSD??null,
    openCount:(snap.positions||[]).length,
    liveToday:true,
   });
  }

  if(cmd==='/close'||cmd==='/청산'){
   const rawSym=String(parts[1]||'').trim().toUpperCase();
   if(!rawSym)return '사용법: /close BTCUSDT [LONG|SHORT] 또는 /close ALL';
   const dirRaw=String(parts[2]||'').trim().toUpperCase();
   const direction=['LONG','SHORT'].includes(dirRaw)?dirRaw:null;
   const target=rawSym==='ALL'?'ALL':displaySymbol(rawSym.endsWith('USDT')?rawSym:`${rawSym}USDT`);
   if(target!=='ALL'&&!/^[A-Z0-9]{4,30}$/.test(target))return '⚠️ 종목 형식이 올바르지 않습니다.';
   const code=String(randomInt(1000,10000));
   this.pendingAction={kind:'CLOSE',code,symbol:target,direction,expiresAt:now+CONFIRM_TTL_MS};
   const label=target==='ALL'?'전체 보유 포지션':`${target}${direction?` ${sideKo(direction)}`:' (전체 방향)'}`;
   return `⚠️ 실계좌 시장가 청산 확인\n대상: ${label}\n실행하려면 60초 안에 아래 명령을 보내세요:\n/confirm ${code}`;
  }

  if(cmd==='/confirm'||cmd==='/확인'){
   const code=String(parts[1]||'').trim();
   const pending=this.pendingAction;
   if(!pending||now>pending.expiresAt){
    this.pendingAction=null;
    return '⚠️ 유효한 확인 요청이 없거나 만료되었습니다. /close · /resume · /size 명령부터 다시 입력하세요.';
   }
   if(code!==pending.code)return '⚠️ 확인 코드가 일치하지 않습니다.';
   this.pendingAction=null;
   if(pending.kind==='RESUME'){
    try{
     const res=await this.onResume();
     if(res?.ok===false){
      if(res.reason==='COPY_LOSS_LIMIT')return '⛔ 카피 손실 한도 정지 상태라 텔레그램으로 재개할 수 없습니다.\n실계좌 화면(#real)의 "손실 한도 해제"(COPY_RESUME) 확인 버튼으로만 풀 수 있습니다.';
      if(res.reason==='DAILY_LOSS_CIRCUIT_BREAKER')return '⛔ 오늘 실계좌 일일 손실 차단이 발동 중이라 카피를 켤 수 없습니다. (한국 시간 자정에 풀리며, 화면의 계좌 안전 가드에서만 해제할 수 있습니다)';
      return `⚠️ 재개 실패: ${res.message||res.reason||'알 수 없는 오류'}`;
     }
     return '▶️ 실계좌 카피 매매를 재개(활성화)했습니다.';
    }catch(e){return `⚠️ 재개 오류: ${e?.message||'ERROR'}`}
   }
   if(pending.kind==='SIZE'){
    try{
     const res=await this.onControls({sizing:'BALANCE_RATIO',traderBalanceUSD:pending.traderBalanceUSD});
     const tb=res?.traderBalanceUSD??pending.traderBalanceUSD;
     return `✅ 카피 기준 잔고를 $${Number(tb).toLocaleString()}로 변경했습니다.\n(잔고 비례 모드 · 내 가용 증거금 ÷ $${Number(tb).toLocaleString()} 비율 자동 적용)`;
    }catch(e){return `⚠️ 변경 실패: ${e?.message||'ERROR'}`}
   }
   try{
    const res=await this.onClose({symbol:pending.symbol,direction:pending.direction});
    if(res?.ok===false)return `⚠️ 청산 실패: ${res.message||res.error||'알 수 없는 오류'}`;
    return `✅ 청산 완료\n${res?.summary||`${pending.symbol} 시장가 청산 요청 완료`}`;
   }catch(e){
    return `⚠️ 청산 오류: ${e?.message||'EXECUTION_FAILED'}`;
   }
  }

  return null;
 }

 /** Poll Telegram Bot API getUpdates safely using the network-recovery transport. */
 async pollCommands(){
  if(!this.store.remoteCommands||!this.allowedChatId||!this.getUpdatesRequest||this.polling)return;
  this.polling=true;
  try{
   const payload={limit:10,timeout:0,allowed_updates:['message']};
   if(this.store.lastUpdateId!=null)payload.offset=this.store.lastUpdateId+1;
   const {response}=await this.getUpdatesRequest(payload);
   if(!response?.ok)return;
   const body=await response.json().catch(()=>null);
   if(!body?.ok||!Array.isArray(body.result)||!body.result.length)return;
   let maxId=this.store.lastUpdateId??-1;
   for(const u of body.result){
    if(Number.isSafeInteger(u?.update_id)&&u.update_id>maxId)maxId=u.update_id;
    const msg=u?.message;
    if(!msg||typeof msg.text!=='string')continue;
    if(msg.forward_date||msg.forward_origin)continue;
    // Always (not only on the first boot, audit 2026-11-23): a command sent before this process started or more
    // than 2 minutes ago is dropped (Telegram dates are whole seconds); one without a date is dropped too.
    const msgSec=Number(msg.date);
    if(!Number.isFinite(msgSec)||msgSec<Math.floor(this.bootAt/1000)||msgSec*1000<this.now()-COMMAND_MAX_AGE_MS){
     this.log('[ALERTS] stale command dropped',String(msg.text).split(/\s+/)[0].slice(0,20));
     continue;
    }
    const reply=await this.handleCommand(msg.text,msg.chat?.id,this.now());
    if(reply){
     const isHtml=isHtmlMessage(reply);
     if(this.replyRequest)await this.replyRequest({chat_id:this.allowedChatId,text:reply,...(isHtml?{parse_mode:'HTML'}:{})}).catch(()=>{});
     else await this.sendText(reply).catch(()=>{});
    }
   }
   if(maxId>=(this.store.lastUpdateId??-1)&&maxId>=0){
    this.store.lastUpdateId=maxId;
    this.#save();
   }
  }catch(e){
   this.log('[ALERTS] pollCommands failed',e?.message||'ERROR');
  }finally{
   this.polling=false;
  }
 }
}
