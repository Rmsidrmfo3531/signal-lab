// Real-account Telegram operations & alerts (user 2026-11-20):
//  - #2 Combined manual + copy real-time risk alerts (margin usage % & unrealized loss %)
//  - #5 Daily closing summary report (00:00 KST, plus on-demand /report)
//  - #6 Private-chat Telegram bot commands (/status, /pause, /resume, /close + /confirm, /report, /help)
//  - #7 Position ROI milestone alerts (manual + copy)
//  - #8 Copy entry/add skip alert toggle + 5-min deduplication
// Never emits scan signals; only operates on confirmed real-account state & authorized private chat.
import fs from 'node:fs';
import path from 'node:path';
import {randomInt} from 'node:crypto';
import {atomicWriteStore,readStore} from './persistence.mjs';
import {createTelegramNetworkRecovery} from './telegram_transport.mjs';

export const ACCOUNT_ALERTS_DEFAULTS=Object.freeze({
 riskAlerts:true,
 marginWarnPcts:[50,70],
 lossWarnPcts:[10,20],
 dailyReport:true,
 roiAlerts:true,
 profitRoiPcts:[50,100,200],
 lossRoiPcts:[30,50,75],
 skipAlerts:true,
 remoteCommands:true,
});

const KST_MS=9*3600000;
const RISK_COOLDOWN_MS=30*60000;
const SKIP_DEDUP_MS=5*60000;
const CONFIRM_TTL_MS=60000;
const NOISY_SKIPS=new Set(['NOT_COPIED','COPY_OFF','MONITOR_RESTART_SNAPSHOT','STALE_MESSAGE']);

export const kstDay=t=>new Date(Number(t)+KST_MS).toISOString().slice(0,10);
const money=v=>{const n=Number(v);return v==null||!Number.isFinite(n)?'—':`${n>=0?'+':'−'}$${Math.abs(n).toFixed(2)}`};
const usd=v=>{const n=Number(v);return v==null||!Number.isFinite(n)?'—':`$${n.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})}`};
const px=v=>{const n=Number(v);return Number.isFinite(n)&&n>0?String(+n.toPrecision(6)):'—'};
const sideKo=d=>d==='LONG'?'🟢 롱':d==='SHORT'?'🔴 숏':String(d||'');
const originKo=o=>o==='copy'?'카피':'수동';
const err=msg=>Object.assign(Error(msg),{code:'INVALID_ACCOUNT_ALERTS',httpStatus:400});

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
  `📋 실계좌 현황`,
  `순자산 ${usd(equityUSD)} · 가용 ${usd(availableUSD)}`,
  `증거금 ${usd(totalMargin)}${marginPct!=null?` (${marginPct.toFixed(1)}%)`:''} · 미실현 ${money(totalUnreal)}`,
  `카피 상태: ${copyState}${copy?.traderBalanceUSD?` · 기준 $${Number(copy.traderBalanceUSD).toLocaleString()}`:''}`,
 ];
 if(!list.length)lines.push('보유 포지션 없음');
 else{
  lines.push(`보유 포지션 (${list.length}개):`);
  for(const p of list.slice(0,12)){
   const roe=Number.isFinite(Number(p.roePct))?` (${Number(p.roePct)>=0?'+':'−'}${Math.abs(Number(p.roePct)).toFixed(1)}%)`:'';
   lines.push(`· [${originKo(p.origin)}] ${p.symbol} ${sideKo(p.direction)} ${p.leverage??'—'}배 · ${money(p.unrealized)}${roe}`);
  }
 }
 return lines.join('\n');
}

export class AccountAlerts{
 constructor({directory=null,fileName='account-alerts.json',now=()=>Date.now(),log=()=>{},
  sendText=async()=>({ok:false}),post=null,allowedChatId='',
  getSnapshot=async()=>null,onPause=async()=>null,onResume=async()=>null,onClose=async()=>null}={}){
  Object.assign(this,{now,log,sendText,allowedChatId:String(allowedChatId||'').trim(),getSnapshot,onPause,onResume,onClose});
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
   skipAlerts:saved?.skipAlerts!==false,
   remoteCommands:saved?.remoteCommands!==false,
   lastDailyReportDay:typeof saved?.lastDailyReportDay==='string'?saved.lastDailyReportDay:null,
   lastUpdateId:Number.isSafeInteger(saved?.lastUpdateId)?saved.lastUpdateId:null,
  };
  this.bootAt=this.now();
  this.riskSent=new Map(); // key -> {at, armed}
  this.positionTiers=new Map(); // posKey -> {profit:number, loss:number}
  this.skipDedup=new Map(); // skipKey -> at
  this.pendingClose=null; // {code, symbol, direction, expiresAt}
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
  for(const k of ['riskAlerts','dailyReport','roiAlerts','skipAlerts','remoteCommands']){
   if(Object.hasOwn(patch,k)){
    if(typeof patch[k]!=='boolean')throw err(`${k} must be a boolean`);
    next[k]=patch[k];
   }
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
   skipAlerts:this.store.skipAlerts,
   remoteCommands:this.store.remoteCommands,
   lastDailyReportDay:this.store.lastDailyReportDay,
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
     const text=`🎯 포지션 수익 도달 · ${originKo(p.origin)} ${p.symbol} ${sideKo(p.direction)}\n수익률 +${roe.toFixed(1)}% (${money(p.unrealized)}) · 기준 +${hit}%\n평단 ${px(p.avg)} · 현재 ${px(p.mark)} · 증거금 ${usd(p.margin)}`;
     try{await this.sendText(text);delivered.push({key,kind:'profit',tier:hit,text})}catch{}
    }
   }else if(roe<0){
    const mag=Math.abs(roe);
    const hit=[...this.store.lossRoiPcts].filter(t=>mag>=t&&t>prev.loss).at(-1);
    if(hit){
     prev.loss=hit;
     this.positionTiers.set(key,prev);
     const text=`🔻 포지션 손실 경고 · ${originKo(p.origin)} ${p.symbol} ${sideKo(p.direction)}\n수익률 −${mag.toFixed(1)}% (${money(p.unrealized)}) · 기준 −${hit}%\n평단 ${px(p.avg)} · 현재 ${px(p.mark)} · 증거금 ${usd(p.margin)}`;
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
    '🤖 Signal Lab 실계좌 원격 명령어',
    '/status — 잔고·증거금·보유 포지션 조회',
    '/pause — 실계좌 카피 일시정지(비활성화)',
    '/resume — 실계좌 카피 재개(활성화)',
    '/report — 오늘 KST 손익 중간 리포트',
    '/close 종목 [LONG|SHORT] — 해당 포지션 청산 (2단계 확인)',
    '/close ALL — 전체 포지션 청산 (2단계 확인)',
    '/confirm 코드 — 청산 실행 확인',
   ].join('\n');
  }

  if(cmd==='/status'||cmd==='/상태'){
   const snap=await this.getSnapshot();
   if(!snap)return '⚠️ 현재 실계좌 상태를 조회하지 못했습니다.';
   return formatStatusReply(snap);
  }

  if(cmd==='/pause'||cmd==='/정지'){
   await this.onPause();
   return '⏸ 실계좌 카피 매매를 일시정지(비활성화)했습니다.\n기존 포지션은 유지되며 새 진입만 멈춥니다.';
  }

  if(cmd==='/resume'||cmd==='/재개'){
   await this.onResume();
   return '▶️ 실계좌 카피 매매를 재개(활성화)했습니다.';
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
   const target=rawSym==='ALL'?'ALL':(rawSym.endsWith('USDT')?rawSym:`${rawSym}USDT`);
   if(target!=='ALL'&&!/^[A-Z0-9]{4,30}$/.test(target))return '⚠️ 종목 형식이 올바르지 않습니다.';
   const code=String(randomInt(1000,10000));
   this.pendingClose={code,symbol:target,direction,expiresAt:now+CONFIRM_TTL_MS};
   const label=target==='ALL'?'전체 보유 포지션':`${target}${direction?` ${sideKo(direction)}`:' (전체 방향)'}`;
   return `⚠️ 실계좌 시장가 청산 확인\n대상: ${label}\n실행하려면 60초 안에 아래 명령을 보내세요:\n/confirm ${code}`;
  }

  if(cmd==='/confirm'||cmd==='/확인'){
   const code=String(parts[1]||'').trim();
   const pending=this.pendingClose;
   if(!pending||now>pending.expiresAt){
    this.pendingClose=null;
    return '⚠️ 유효한 청산 확인 요청이 없거나 만료되었습니다. /close 명령부터 다시 입력하세요.';
   }
   if(code!==pending.code)return '⚠️ 확인 코드가 일치하지 않습니다.';
   this.pendingClose=null;
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
   const initial=this.store.lastUpdateId==null;
   let maxId=this.store.lastUpdateId??-1;
   for(const u of body.result){
    if(Number.isSafeInteger(u?.update_id)&&u.update_id>maxId)maxId=u.update_id;
    const msg=u?.message;
    if(!msg||typeof msg.text!=='string')continue;
    if(msg.forward_date||msg.forward_origin)continue;
    const msgAt=Number(msg.date)*1000;
    // On very first boot without saved offset, skip commands older than 60s before boot.
    if(initial&&Number.isFinite(msgAt)&&msgAt<this.bootAt-60000)continue;
    const reply=await this.handleCommand(msg.text,msg.chat?.id,this.now());
    if(reply){
     if(this.replyRequest)await this.replyRequest({chat_id:this.allowedChatId,text:reply}).catch(()=>{});
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
