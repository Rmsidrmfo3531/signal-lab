// Copy listener liveness (user decision 2026-11-24 17:34 "2번은 그대로 진행"): deploy/linux/copy_listener.py POSTs
// /api/copy/heartbeat every 60 s (same token as /api/copy/message). No heartbeat for 5 minutes, or heartbeats saying
// Telegram is disconnected for 3 minutes, sends ONE "카피 수신 끊김" message; the first healthy heartbeat after that sends
// ONE "카피 수신 복구". The state is kept in copy-listener-health.json so a server restart never sends either twice.
// Alert only: never orders, never changes a setting, never blocks anything. Not used while the copy mode is OFF.
import fs from 'node:fs';
import path from 'node:path';
import {timingSafeEqual} from 'node:crypto';
import {atomicWriteStore,readStore} from './persistence.mjs';

export const LISTENER_HEALTH_FILE='copy-listener-health.json';
export const LISTENER_STALE_MS=5*60000;
export const LISTENER_DISCONNECT_MS=3*60000;
const KST_MS=9*3600000;

const tokenEqual=(a,b)=>{const x=Buffer.from(String(a||'')),y=Buffer.from(String(b||''));return x.length===y.length&&timingSafeEqual(x,y)};
const int=v=>{const n=Number(v);return Number.isSafeInteger(n)?n:null};
const time=v=>{const n=Number(v);return Number.isFinite(n)&&n>0&&n<1e14?Math.round(n):null};
const count=v=>{const n=Number(v);return Number.isSafeInteger(n)&&n>=0&&n<1e7?n:null};
const kstClock=t=>t?new Date(Number(t)+KST_MS).toISOString().slice(5,19).replace('T',' '):'—';

/** Only the known fields, bounded: the body comes from a local process but is never trusted for size or type. */
export function sanitizeHeartbeat(body){
 const b=body&&typeof body==='object'&&!Array.isArray(body)?body:{};
 const q=b.queues&&typeof b.queues==='object'?b.queues:{};
 return {
  version:typeof b.version==='string'?b.version.replace(/[^0-9A-Za-z._-]/g,'').slice(0,40)||null:null,
  connected:b.connected===true?true:b.connected===false?false:null,
  startedAt:time(b.startedAt),
  lastCopyId:int(b.lastCopyId),lastCopyAt:time(b.lastCopyAt),lastCopyDeliveredAt:time(b.lastCopyDeliveredAt),
  lastPumpAt:time(b.lastPumpAt),
  queues:{copy:count(q.copy),pump:count(q.pump)},
  inFlight:count(b.inFlight),
  catchup:b.catchup&&typeof b.catchup==='object'?{forwarded:count(b.catchup.forwarded),skipped:count(b.catchup.skipped),at:time(b.catchup.at),error:typeof b.catchup.error==='string'?b.catchup.error.slice(0,80):null}:null,
 };
}

export class CopyListenerHealth{
 constructor({directory=null,fileName=LISTENER_HEALTH_FILE,now=()=>Date.now(),send=async()=>true,log=()=>{},
  staleMs=LISTENER_STALE_MS,disconnectMs=LISTENER_DISCONNECT_MS}={}){
  Object.assign(this,{now,send,log,staleMs,disconnectMs});
  this.file=directory?path.join(directory,fileName):null;
  let saved=null;
  try{saved=this.file&&fs.existsSync(this.file)?readStore(this.file):null}catch(e){log('[COPY LISTENER] 상태 읽기 실패',e.message)}
  this.store={
   lastBeatAt:time(saved?.lastBeatAt),
   last:saved?.last&&typeof saved.last==='object'?sanitizeHeartbeat(saved.last):null,
   disconnectedSince:time(saved?.disconnectedSince),
   down:saved?.down===true,downAt:time(saved?.downAt),downReason:typeof saved?.downReason==='string'?saved.downReason:null,
   // The down notice went out: only then is a recovery notice due.
   downNotified:saved?.downNotified===true,
   recoveredAt:time(saved?.recoveredAt),
  };
  // A heartbeat that is old only because this server was down (an update restart) is not the listener's fault: the
  // 5-minute clock starts again at boot.
  this.bootAt=this.now();
  this.checking=null;
 }
 #save(){
  if(!this.file)return;
  try{fs.mkdirSync(path.dirname(this.file),{recursive:true});atomicWriteStore(this.file,{version:1,...this.store})}
  catch(e){this.log('[COPY LISTENER] 상태 저장 실패',e.message)}
 }
 /** One heartbeat from the listener. Returns the state after it (and may send the recovery notice). */
 async record(body){
  const beat=sanitizeHeartbeat(body),now=this.now();
  this.store.lastBeatAt=now;this.store.last=beat;
  if(beat.connected===false)this.store.disconnectedSince??=now;
  else this.store.disconnectedSince=null;
  this.#save();
  await this.check();
  return this.status();
 }
 /** Why the listener counts as down right now, or null. */
 problem(now=this.now()){
  const since=Math.max(this.store.lastBeatAt||0,this.bootAt);
  if(now-since>=this.staleMs)return {code:'NO_HEARTBEAT',minutes:Math.floor((now-since)/60000)};
  if(this.store.disconnectedSince&&now-this.store.disconnectedSince>=this.disconnectMs)
   return {code:'TELEGRAM_DISCONNECTED',minutes:Math.floor((now-this.store.disconnectedSince)/60000)};
  return null;
 }
 /** Called on every heartbeat and every 30 s. One notice per transition; a failed send is tried again next time. */
 async check(){
  if(this.checking)return this.checking;
  this.checking=this.#check().finally(()=>{this.checking=null});
  return this.checking;
 }
 async #check(){
  const now=this.now(),p=this.problem(now);
  if(p&&!this.store.down){
   Object.assign(this.store,{down:true,downAt:now,downReason:p.code,downNotified:false});this.#save();
  }
  if(this.store.down&&!this.store.downNotified&&p){
   const last=this.store.lastBeatAt;
   const why=p.code==='NO_HEARTBEAT'?`수신기 신호 없음 ${p.minutes}분`:`텔레그램 연결 끊김 ${p.minutes}분`;
   const text=[`⚠️ 카피 수신 끊김 · ${why}`,`마지막 신호 ${kstClock(last)} KST${this.store.last?.version?` · 버전 ${this.store.last.version}`:''}`,
    '채널 알림을 받지 못하면 카피가 진입·청산을 따라가지 못합니다.','확인: journalctl -u signal-lab-copy -n 30 --no-pager'].join('\n');
   if(await this.#send(text)){this.store.downNotified=true;this.#save()}
   return;
  }
  if(!p&&this.store.down&&this.#healthyBeat(now)){
   const wasNotified=this.store.downNotified,downAt=this.store.downAt;
   Object.assign(this.store,{down:false,downNotified:false,downReason:null,recoveredAt:now});this.#save();
   if(wasNotified){
    const mins=downAt?Math.max(1,Math.round((now-downAt)/60000)):null;
    await this.#send([`✅ 카피 수신 복구${mins?` · 약 ${mins}분 끊김`:''}`,`마지막 신호 ${kstClock(this.store.lastBeatAt)} KST${this.store.last?.version?` · 버전 ${this.store.last.version}`:''}`].join('\n'));
   }
  }
 }
 #healthyBeat(now){return Boolean(this.store.lastBeatAt&&this.store.lastBeatAt>=this.bootAt-this.staleMs&&now-this.store.lastBeatAt<this.staleMs&&this.store.last?.connected!==false)}
 async #send(text){
  try{const r=await this.send(text);return r!==false}
  catch(e){this.log('[COPY LISTENER] 알림 전송 실패',e?.message||'ERROR');return false}
 }
 status(now=this.now()){
  const p=this.problem(now),beat=this.store.lastBeatAt;
  return {
   state:this.store.down||p?'DOWN':beat&&beat>=this.bootAt-this.staleMs?'OK':'WAITING',
   reason:p?.code??(this.store.down?this.store.downReason:null),
   lastBeatAt:beat,ageSec:beat?Math.max(0,Math.round((now-beat)/1000)):null,
   connected:this.store.last?.connected??null,version:this.store.last?.version??null,
   queues:this.store.last?.queues??null,lastCopyAt:this.store.last?.lastCopyAt??null,lastCopyId:this.store.last?.lastCopyId??null,
   lastPumpAt:this.store.last?.lastPumpAt??null,downAt:this.store.down?this.store.downAt:null,
  };
 }
}

/** /api/copy/heartbeat: the same token check as /api/copy/message. copyEnabled false = accepted and ignored. */
export async function listenerHeartbeatEndpoint({token,want,body,health,copyEnabled}){
 if(!(String(want||'').length>=24&&tokenEqual(token,want)))return {status:403,body:{error:'FORBIDDEN'}};
 if(!copyEnabled||!health)return {status:200,body:{ok:true,ignored:'COPY_OFF'}};
 if(!body||typeof body!=='object'||Array.isArray(body))return {status:400,body:{error:'JSON_OBJECT_REQUIRED'}};
 const st=await health.record(body);
 return {status:200,body:{ok:true,state:st.state}};
}
