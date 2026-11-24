// 급변 알림 (crimepump "공습경보" relayed by the Telegram bot @ggangalt2_bot, user 2026-11-24 08:47
// "@ggangalt2_bot 봇 채널인데 여기서 나오는 알트 코인들에 대해서 바로 매매 진행이 가능할까").
//  - parsePumpAlert: the bot's alert text -> {symbol, dir, pct, low, high, price, ticks}; null for anything else.
//  - PumpAlertBook: every alert in pump-alerts.json (data folder, the last ~2,000), then forward tracking from
//    public 1m klines (BingX first, Binance as fallback): the price at +1 / +5 / +15 / +60 min and the best and
//    worst move for a fade (against the alert's arrow) and a follow (with it), after round-trip costs. Read only:
//    no orders here (the testnet scalp trigger is scalp_executor.mjs pumpAlert).
import fs from 'node:fs';
import path from 'node:path';
import {timingSafeEqual} from 'node:crypto';
import {atomicWriteStore,readStore} from './persistence.mjs';
import {SCALP_EXEC_COSTS} from './scalp_executor.mjs';

export const PUMP_ALERT_FILE='pump-alerts.json';
export const PUMP_ALERT_MAX=2000;
export const PUMP_HORIZONS_MIN=Object.freeze([1,5,15,60]);
// Round trip of the scalp's cost assumptions, in % of the price: taker both ways, slippage both ways, one spread.
export const PUMP_COST_PCT=+((2*SCALP_EXEC_COSTS.takerRate+(2*SCALP_EXEC_COSTS.slippageBps+SCALP_EXEC_COSTS.spreadBps)/1e4)*100).toFixed(4);
// BingX keeps at most 1,440 1m candles per read: an alert older than that cannot be measured any more.
const EXPIRE_MS=23*3600000,GRACE_MS=10000,MIN=60000;

const NUM='([0-9]+(?:\\.[0-9]+)?(?:[eE]-?[0-9]+)?)';
const RE={
 head:/공습경보\s*([A-Z0-9]{1,30}USDT)\b/,
 move:new RegExp(`변동성\\s*${NUM}\\s*%\\s*([↑↓⬆⬇])`),
 range:new RegExp(`low\\s*${NUM}\\s*↔\\s*high\\s*${NUM}`,'i'),
 now:new RegExp(`현재\\s*${NUM}(?:\\s*\\(\\s*틱\\s*([0-9][0-9,]*)\\s*\\))?`),
};
const fin=v=>Number.isFinite(v)&&v>0;
/** The alert text -> {symbol, dir:'UP'|'DOWN', pct, low, high, price, ticks}; null for any other message. */
export function parsePumpAlert(text){
 if(typeof text!=='string'||text.length>2000)return null;
 const h=RE.head.exec(text),m=RE.move.exec(text),r=RE.range.exec(text),n=RE.now.exec(text);
 if(!h||!m||!r||!n)return null;
 const pct=Number(m[1]),low=Number(r[1]),high=Number(r[2]),price=Number(n[1]),ticks=n[2]!=null?Number(n[2].replace(/,/g,'')):null;
 if(!fin(pct)||pct>1000||!fin(low)||!fin(high)||!fin(price)||low>high)return null;
 return {symbol:h[1],dir:/[↑⬆]/.test(m[2])?'UP':'DOWN',pct,low,high,price,ticks:Number.isSafeInteger(ticks)?ticks:null};
}

const r4=x=>Number.isFinite(x)?Math.round(x*1e4)/1e4:null;
const avg=a=>a.length?r4(a.reduce((s,v)=>s+v,0)/a.length):null;
/** Forward outcome of one alert from closed 1m candles ([openTime, open, high, low, close, ..., closeTime]).
 * Reference = the open of the first full minute after the alert (the first price one could act on). Horizon h =
 * the close of the candle opening h minutes after the alert's minute; the best / worst moves are over the candles
 * from the reference to that one. follow = the alert's arrow (UP -> long), fade = the other way; net = after
 * PUMP_COST_PCT. Percentages of the reference price, no leverage. Pure. */
export function pumpOutcome({at,dir,rows,now=Date.now(),horizons=PUMP_HORIZONS_MIN,costPct=PUMP_COST_PCT}){
 const m0=Math.floor(at/MIN)*MIN,refOpen=m0+MIN,s=dir==='UP'?1:-1;
 const byOpen=new Map();
 for(const k of Array.isArray(rows)?rows:[]){
  if(!Array.isArray(k))continue;
  const t=Number(k[0]),o=Number(k[1]),hi=Number(k[2]),lo=Number(k[3]),c=Number(k[4]),ct=Number(k[6]);
  if(!Number.isFinite(t)||!fin(o)||!fin(hi)||!fin(lo)||!fin(c)||hi<lo)continue;
  if(Number.isFinite(ct)?ct>=now:t+MIN>now)continue; // closed candles only
  byOpen.set(t,{o,hi,lo,c});
 }
 const ref=byOpen.get(refOpen);
 if(!ref)return {refAt:refOpen,refPrice:null,horizons:{}};
 const p0=ref.o,pct=p=>(p/p0-1)*100,out={};
 for(const h of horizons){
  const end=byOpen.get(m0+h*MIN);if(!end)continue;
  let hi=-Infinity,lo=Infinity;
  for(let t=refOpen;t<=m0+h*MIN;t+=MIN){const k=byOpen.get(t);if(k){hi=Math.max(hi,k.hi);lo=Math.min(lo,k.lo)}}
  const ret=s*pct(end.c),up=pct(hi),down=pct(lo);
  // Favorable / adverse extremes of the follow side; the fade's are the same moves the other way round.
  const followBest=s>0?up:-down,followWorst=s>0?-down:up;
  out[h]={price:end.c,retPct:r4(pct(end.c)),
   follow:{netPct:r4(ret-costPct),mfePct:r4(Math.max(0,followBest)),maePct:r4(Math.max(0,followWorst))},
   fade:{netPct:r4(-ret-costPct),mfePct:r4(Math.max(0,followWorst)),maePct:r4(Math.max(0,followBest))}};
 }
 return {refAt:refOpen,refPrice:p0,horizons:out};
}

/** Per-horizon count and average net % (after costs) of fade and follow, over the recorded alerts. */
export function summarizePumpAlerts(records,{now=Date.now(),horizons=PUMP_HORIZONS_MIN,costPct=PUMP_COST_PCT,recent=10}={}){
 const list=Array.isArray(records)?records:[];
 const byHorizon={};
 for(const h of horizons){
  const rows=list.map(x=>x?.track?.horizons?.[h]).filter(Boolean);
  byHorizon[h]={n:rows.length,fadeNetPct:avg(rows.map(x=>x.fade.netPct).filter(Number.isFinite)),followNetPct:avg(rows.map(x=>x.follow.netPct).filter(Number.isFinite))};
 }
 return {count:list.length,last24h:list.filter(x=>now-(x.at||0)<86400000).length,costPct,
  bingxListed:list.filter(x=>x.bingx?.listed===true).length,tracked:list.filter(x=>x.track?.horizons?.[horizons.at(-1)]).length,
  scalp:{entered:list.filter(x=>x.scalp?.entered===true).length,evaluated:list.filter(x=>x.scalp).length},
  byHorizon,
  recent:list.slice(-recent).reverse().map(x=>({at:x.at,symbol:x.symbol,dir:x.dir,pct:x.pct,bingx:x.bingx?.listed??null,
   follow60:x.track?.horizons?.[horizons.at(-1)]?.follow?.netPct??null,scalp:x.scalp?.entered?'ENTERED':x.scalp?.reason??null}))};
}

const tokenEqual=(a,b)=>{const x=Buffer.from(String(a||'')),y=Buffer.from(String(b||''));return x.length>0&&x.length===y.length&&timingSafeEqual(x,y)};
/** POST /api/pump-alert from the local listener (deploy/linux/copy_listener.py): the same token as /api/copy/message
 * (COPY_LISTENER_TOKEN, at least 24 characters, compared in constant time). Records the alert and hands a new one to
 * onAlert (the testnet scalp, not awaited). Returns {status, body}. */
export function pumpAlertEndpoint({token,want,body,book,onAlert=null}){
 if(!(String(want||'').length>=24&&tokenEqual(token,want)))return {status:403,body:{error:'FORBIDDEN'}};
 if(typeof body?.text!=='string'||body.text.length>4000)return {status:400,body:{error:'TEXT_REQUIRED'}};
 const r=book.record({id:body.id??null,chat:body.chat??null,date:Number(body.date)||null,text:body.text});
 if(r.ignored)return {status:200,body:{ok:true,ignored:true}};
 if(r.duplicate)return {status:200,body:{ok:true,duplicate:true,symbol:r.alert.symbol,dir:r.alert.dir}};
 if(typeof onAlert==='function'){
  void Promise.resolve().then(()=>onAlert({...r.alert,at:r.record.at,key:r.key}))
   .then(result=>{if(result)book.attachScalp(r.key,result)},e=>book.attachScalp(r.key,{entered:false,reason:e?.code||'PUMP_EVALUATION_FAILED'}));
 }
 return {status:200,body:{ok:true,recorded:true,symbol:r.alert.symbol,dir:r.alert.dir}};
}

export class PumpAlertBook{
 /** sources: [{name, klines:(symbol, limit) => rows}] tried in order (BingX first, Binance as fallback).
  * listed: async symbol => true | false | null (BingX lists the perpetual). */
 constructor({directory=null,fileName=PUMP_ALERT_FILE,now=()=>Date.now(),max=PUMP_ALERT_MAX,sources=[],listed=null,log=()=>{}}={}){
  Object.assign(this,{now,max,sources,listed,log});
  this.file=directory?path.join(directory,fileName):null;
  let saved=null;try{saved=this.file&&fs.existsSync(this.file)?readStore(this.file):null}catch(e){log('[PUMP] 기록 읽기 실패',e.message)}
  this.records=Array.isArray(saved?.records)?saved.records:[];
  this.tracking=false;
 }
 #save(){
  if(this.records.length>this.max)this.records=this.records.slice(-this.max);
  if(!this.file)return;
  try{fs.mkdirSync(path.dirname(this.file),{recursive:true});atomicWriteStore(this.file,{version:1,records:this.records})}
  catch(e){this.log('[PUMP] 기록 저장 실패',e.message)}
 }
 find(key){return this.records.find(x=>x.key===key)||null}
 /** One relayed message. Not an alert -> {ok:true, ignored:true}; an id seen before -> duplicate (no second record). */
 record({id=null,chat=null,date=null,text}){
  const alert=parsePumpAlert(text);
  if(!alert)return {ok:true,ignored:true};
  const at=Number(date)>0?Number(date):this.now();
  const key=id!=null&&String(id).trim()?`${String(chat??'bot').slice(0,64)}:${String(id).slice(0,32)}`:`t:${at}:${alert.symbol}:${alert.dir}`;
  const old=this.find(key);
  if(old)return {ok:true,duplicate:true,key,alert,record:old};
  const rec={key,at,receivedAt:this.now(),...alert,bingx:null,track:null,trackError:null,scalp:null};
  this.records.push(rec);this.#save();
  if(typeof this.listed==='function')void Promise.resolve().then(()=>this.listed(alert.symbol)).then(v=>{rec.bingx={listed:v===true?true:v===false?false:null,at:this.now()};this.#save()},()=>{});
  return {ok:true,recorded:true,key,alert,record:rec};
 }
 /** The scalp's decision for this alert (entered, or why not). */
 attachScalp(key,result){
  const rec=this.find(key);if(!rec)return;
  rec.scalp={entered:result?.entered===true,reason:result?.entered?null:String(result?.reason||'').slice(0,60)||null,...(result?.queued===true?{queued:true}:{}),...(Number.isFinite(result?.tries)?{tries:result.tries}:{}),at:this.now()};
  this.#save();
 }
 /** Measures the horizons that have closed since the last call. One kline read per due alert. */
 async track(){
  if(this.tracking)return {read:0};
  this.tracking=true;let read=0,changed=false;
  try{
   const now=this.now();
   for(const rec of this.records){
    if(rec.trackDone)continue;
    const m0=Math.floor(rec.at/MIN)*MIN;
    if(now-m0>EXPIRE_MS){rec.trackDone=true;if(!rec.track?.horizons?.[PUMP_HORIZONS_MIN.at(-1)])rec.trackError=rec.trackError||'EXPIRED';changed=true;continue}
    const missing=PUMP_HORIZONS_MIN.filter(h=>!rec.track?.horizons?.[h]);
    if(!missing.length){rec.trackDone=true;changed=true;continue}
    // Due when the candle closing the first missing horizon has closed; retried at most once a minute.
    if(now<m0+(missing[0]+1)*MIN+GRACE_MS||now-(rec.trackTriedAt||0)<MIN-GRACE_MS)continue;
    rec.trackTriedAt=now;read++;changed=true;
    const limit=Math.min(1440,Math.ceil((now-m0)/MIN)+3);
    let result=null,source=null,error=null;
    const chosen=rec.track?.source,order=chosen?[...this.sources].sort((a,b)=>(b.name===chosen)-(a.name===chosen)):this.sources;
    for(const s of order){
     try{const rows=await s.klines(rec.symbol,limit);const o=pumpOutcome({at:rec.at,dir:rec.dir,rows,now});
      if(o.refPrice){result=o;source=s.name;break}error=error||'NO_CANDLES'}
     catch(e){error=String(e?.code||e?.message||'READ_FAILED').slice(0,60)}
    }
    if(!result){rec.trackError=error||'NO_SOURCE';continue}
    // Keep a source once chosen (both venues' prices are never mixed for one alert).
    if(rec.track?.source&&rec.track.source!==source&&Object.keys(rec.track.horizons||{}).length)continue;
    rec.track={source,refAt:result.refAt,refPrice:result.refPrice,horizons:{...(rec.track?.horizons||{}),...result.horizons}};
    rec.trackError=null;
    if(PUMP_HORIZONS_MIN.every(h=>rec.track.horizons[h]))rec.trackDone=true;
   }
  }finally{
   this.tracking=false;
   if(changed)this.#save();
  }
  return {read};
 }
 summary(){return summarizePumpAlerts(this.records,{now:this.now()})}
}
