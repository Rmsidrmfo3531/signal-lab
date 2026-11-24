// 실계좌 준비 점검 (user 2026-11-24 13:35 "조건이 완료되면 알림으로 알려줄 수 있나 실계좌에 쓸 상황이 되었다고",
// 13:37 "2주는 너무 멀어 100건으로 잡고 다시 한 번 검증해보자고"). Read only: it measures the TESTNET reversal scalp
// (scalp_executor ledger: the same rows and PnL as its stats()) and the pump-alert tracking (pump_alert.mjs), and sends
// ONE Telegram message per group when the group first meets the criteria below ("실계좌 후보 — 검증 필요"), again
// ("다시 충족") only after it stopped meeting them. It never changes a setting, never arms anything and never places
// an order; moving a strategy to the real account stays a separate, approved code change.
import fs from 'node:fs';
import path from 'node:path';
import {atomicWriteStore,readStore} from './persistence.mjs';

// A. 되돌림 단타 (all / SHORT / LONG): every criterion must hold.
export const READY_SCALP_MIN_TRADES=100;          // A1 closed trades
export const READY_SCALP_MIN_PROFIT_FACTOR=1.3;   // A2 profit factor after fees (≥)
export const READY_SCALP_MAX_BIG_LOSS_X=5;        // A4 average big loss ≤ 5 × the average winning trade
// A4 "big loss" exits: the −75 % ROE catastrophe cut, the emergency close after a failed protective stop, and the
// TRADER_LADDER final line (the same −75 % ROE after the last ladder step, user 2026-11-24 "(나) 마지막 선에서 정리"),
// and a losing 24 h ladder expiry (it can close a full ladder at a large loss; counted only when the trade lost).
export const READY_BIG_LOSS_EXIT_REASONS=Object.freeze(['EMERGENCY_ROE_STOP','NO_STOP','LADDER_FINAL_LINE','LADDER_MAX_HOLD']);
// A3: both the older and the newer half of the group's trades (by count, oldest first) have net PnL > 0.
// B. 급변 알림 되돌림 (fade): every criterion must hold.
export const READY_PUMP_MIN_TRACKED=50;           // B1 alerts on BingX-listed coins with a 15-min result
export const READY_PUMP_HORIZON_MIN=15;           // B2/B3 average fade net % at 15 min > 0, both halves > 0
export const READY_PUMP_LONG_HORIZON_MIN=60;      // B4 average fade net % at 60 min ≥ 0
export const READY_FILE='live-readiness.json';
export const READY_GROUPS=Object.freeze(['SCALP_ALL','SCALP_SHORT','SCALP_LONG','PUMP_FADE']);
export const READY_LABELS=Object.freeze({SCALP_ALL:'단타 전체',SCALP_SHORT:'단타 숏',SCALP_LONG:'단타 롱',PUMP_FADE:'급변 알림 되돌림'});
export const READY_NOT_AUTOMATIC='실계좌 적용은 자동으로 되지 않습니다 — 승인 후 코드 변경 필요 (단타는 지금 실계좌 주문이 막혀 있음)';

const num=v=>{const n=Number(v);return Number.isFinite(n)?n:0};
const r2=x=>Number.isFinite(x)?Math.round(x*100)/100:x;
const r4=x=>Number.isFinite(x)?Math.round(x*1e4)/1e4:null;
const sum=a=>a.reduce((s,v)=>s+v,0);
const mean=a=>a.length?sum(a)/a.length:null;
// Boundaries are inclusive as written (PF ≥ 1.3, ratio ≤ 5); EPS absorbs float sums such as 50 × 1.3 / 50.
const EPS=1e-9;
/** Older / newer half by count (oldest first); an odd middle trade goes to the newer half. */
export function splitHalves(list){const k=Math.floor(list.length/2);return [list.slice(0,k),list.slice(k)]}
const withLine=g=>(g.line=readinessLine(g),g);
const windowOf=(list,at)=>({fromAt:list.length?at(list[0]):null,toAt:list.length?at(list.at(-1)):null,count:list.length});

/** One scalp group. rows: [{direction, netUSD, closedAt, closeReason}] with the stats() PnL (display scale applied). */
export function scalpGroupReadiness(rows,{group='SCALP_ALL'}={}){
 const side=group==='SCALP_SHORT'?'SHORT':group==='SCALP_LONG'?'LONG':null;
 const list=(Array.isArray(rows)?rows:[]).filter(x=>x&&(!side||(x.direction||'LONG')===side))
  .map((x,i)=>({...x,net:num(x.netUSD),i})).sort((a,b)=>num(a.closedAt)-num(b.closedAt)||a.i-b.i);
 const n=list.length,wins=list.filter(x=>x.net>0).map(x=>x.net),losses=list.filter(x=>x.net<0).map(x=>-x.net);
 const gross=sum(wins),loss=sum(losses);
 const pf=loss>0?gross/loss:gross>0?Infinity:null;
 const [older,newer]=splitHalves(list),olderNet=sum(older.map(x=>x.net)),newerNet=sum(newer.map(x=>x.net));
 const big=list.filter(x=>READY_BIG_LOSS_EXIT_REASONS.includes(x.closeReason)&&x.net<0).map(x=>-x.net);
 const avgWin=mean(wins),avgBig=mean(big);
 const bigX=!big.length?null:avgWin>0?avgBig/avgWin:Infinity;
 const checks={
  trades:n>=READY_SCALP_MIN_TRADES,
  profitFactor:pf!==null&&pf>=READY_SCALP_MIN_PROFIT_FACTOR-EPS,
  halves:older.length>0&&newer.length>0&&olderNet>0&&newerNet>0,
  bigLoss:bigX===null||bigX<=READY_SCALP_MAX_BIG_LOSS_X+EPS};
 return withLine({group,label:READY_LABELS[group],kind:'SCALP',ready:Object.values(checks).every(Boolean),checks,
  trades:n,minTrades:READY_SCALP_MIN_TRADES,progress:Math.min(1,n/READY_SCALP_MIN_TRADES),
  netUSD:r2(sum(list.map(x=>x.net))),profitFactor:pf===Infinity?'INF':pf===null?null:r4(pf),minProfitFactor:READY_SCALP_MIN_PROFIT_FACTOR,
  olderHalf:{count:older.length,netUSD:r2(olderNet)},newerHalf:{count:newer.length,netUSD:r2(newerNet)},
  bigLoss:{count:big.length,avgLossUSD:avgBig===null?null:r2(avgBig),avgWinUSD:avgWin===null?null:r2(avgWin),ratio:bigX===Infinity?'INF':bigX===null?null:r4(bigX),max:READY_SCALP_MAX_BIG_LOSS_X,reasons:[...READY_BIG_LOSS_EXIT_REASONS]},
  // The exact trades measured (closedAt of the first and last, and how many), for a re-check on the same set.
  window:windowOf(list,x=>x.closedAt??null)});
}

/** Pump-alert fade: records of pump_alert.mjs (pump-alerts.json). */
export function pumpReadiness(records){
 const h=READY_PUMP_HORIZON_MIN,h2=READY_PUMP_LONG_HORIZON_MIN;
 const listed=(Array.isArray(records)?records:[]).filter(x=>x?.bingx?.listed===true).map((x,i)=>({x,i}))
  .sort((a,b)=>num(a.x.at)-num(b.x.at)||a.i-b.i).map(r=>r.x);
 const f=(x,k)=>{const v=x?.track?.horizons?.[k]?.fade?.netPct;return v===null||v===undefined||v===''?null:Number.isFinite(Number(v))?Number(v):null};
 const t15=listed.filter(x=>f(x,h)!==null),t60=listed.filter(x=>f(x,h2)!==null);
 const a15=mean(t15.map(x=>f(x,h))),a60=mean(t60.map(x=>f(x,h2)));
 const [older,newer]=splitHalves(t15),o=mean(older.map(x=>f(x,h))),w=mean(newer.map(x=>f(x,h)));
 const checks={
  tracked:t15.length>=READY_PUMP_MIN_TRACKED,
  avg15:a15!==null&&a15>0,
  halves:o!==null&&w!==null&&o>0&&w>0,
  avg60:a60!==null&&a60>=0};
 return withLine({group:'PUMP_FADE',label:READY_LABELS.PUMP_FADE,kind:'PUMP',ready:Object.values(checks).every(Boolean),checks,
  tracked:t15.length,minTracked:READY_PUMP_MIN_TRACKED,progress:Math.min(1,t15.length/READY_PUMP_MIN_TRACKED),
  avg15Pct:r4(a15),olderHalf:{count:older.length,avgPct:r4(o)},newerHalf:{count:newer.length,avgPct:r4(w)},
  avg60Pct:r4(a60),tracked60:t60.length,window:windowOf(t15,x=>x.at??null)});
}

/** The scalp trades that count (user 2026-11-24, 카피식 추매): only TRADER_LADDER trades closed from its switch time on.
 * scope: {management, since} (ScalpExecutor.managementScope()); none = every trade (as before). */
export function scopedScalpRows(rows,scope=null){
 const list=Array.isArray(rows)?rows:[];
 if(!scope?.management)return list;
 const since=Number(scope.since)||0;
 return list.filter(x=>x&&(x.management||'CURRENT')===scope.management&&num(x.closedAt)>=since&&(x.openedAt==null||num(x.openedAt)>=since));
}
export const scopeText=scope=>scope?.management?`단타는 카피식 추매(${scope.management}) 거래만 셈${Number(scope.since)>0?` · ${kstTime(scope.since)} KST 전환 이후`:''}`:'';
/** Every group. scalpRows: ScalpExecutor.readinessRows(); pumpRecords: PumpAlertBook.records; scalpScope:
 * ScalpExecutor.managementScope() (only those trades count). Pure. */
export function evaluateReadiness({scalpRows=[],pumpRecords=[],now=Date.now(),scalpScope=null}={}){
 const rows=scopedScalpRows(scalpRows,scalpScope);
 const groups=[...['SCALP_ALL','SCALP_SHORT','SCALP_LONG'].map(g=>scalpGroupReadiness(rows,{group:g})),pumpReadiness(pumpRecords)];
 return {at:now,anyReady:groups.some(g=>g.ready),groups,...(scalpScope?.management?{scope:{management:scalpScope.management,since:Number(scalpScope.since)||null,text:scopeText(scalpScope)}}:{}),
  criteria:{scalp:{minTrades:READY_SCALP_MIN_TRADES,minProfitFactor:READY_SCALP_MIN_PROFIT_FACTOR,halvesNetAbove:0,maxBigLossX:READY_SCALP_MAX_BIG_LOSS_X,bigLossReasons:[...READY_BIG_LOSS_EXIT_REASONS]},
   pump:{minTracked:READY_PUMP_MIN_TRACKED,horizonMin:READY_PUMP_HORIZON_MIN,avgAbovePct:0,halvesAbovePct:0,longHorizonMin:READY_PUMP_LONG_HORIZON_MIN,longMinPct:0}}};
}

const ok=b=>b?'✓':'✗';
const pfText=v=>v==='INF'?'∞':v===null||v===undefined?'—':(Math.floor(Number(v)*100)/100).toFixed(2);
const xText=v=>v==='INF'?'∞':v===null||v===undefined?'—':(Math.ceil(Number(v)*10)/10).toFixed(1);
const pct=v=>v===null||v===undefined?'—':`${v>=0?'+':'−'}${Math.abs(v).toFixed(2)}%`;
const money=v=>v===null||v===undefined?'—':`${v>=0?'+':'−'}$${Math.abs(v).toFixed(2)}`;
const SHORT={SCALP_ALL:'전체',SCALP_SHORT:'숏',SCALP_LONG:'롱',PUMP_FADE:'급변 되돌림'};
/** Compact one-line progress, e.g. "숏 42/100건 · PF 1.74/1.3 ✓ · 앞·뒤 절반 ✓ · 큰 손실 13.1배/5배 ✗". */
export function readinessLine(g){
 if(g.kind==='PUMP')return `${SHORT[g.group]} ${g.tracked}/${g.minTracked}건 · 15분 평균 ${pct(g.avg15Pct)} ${ok(g.checks.avg15)} · 앞·뒤 절반 ${ok(g.checks.halves)} · 60분 평균 ${pct(g.avg60Pct)}/0 ${ok(g.checks.avg60)}`;
 const big=g.bigLoss.count?`큰 손실 ${xText(g.bigLoss.ratio)}배/${g.bigLoss.max}배 ${ok(g.checks.bigLoss)}`:`큰 손실 없음 ✓`;
 return `${SHORT[g.group]} ${g.trades}/${g.minTrades}건 · PF ${pfText(g.profitFactor)}/${g.minProfitFactor} ${ok(g.checks.profitFactor)} · 앞·뒤 절반 ${ok(g.checks.halves)} · ${big}`;
}
const KST=9*3600000;
export const kstTime=t=>Number.isFinite(Number(t))&&t!==null?new Date(Number(t)+KST).toISOString().slice(0,16).replace('T',' '):'—';
const windowText=w=>`${kstTime(w?.fromAt)} ~ ${kstTime(w?.toAt)} KST · ${w?.count??0}건`;
/** lossLimits: {dailyLossPct, copyLedgerLossPct} of the real account (0 = off). */
export function lossLimitText(l={}){
 const d=Number(l?.dailyLossPct)||0,c=Number(l?.copyLedgerLossPct)||0;
 if(!(d>0)&&!(c>0))return '⚠️ 참고: 지금 실계좌 손실 한도(카피+수동 하루 손실 차단·카피 열린 손실 한도)는 꺼져 있습니다.';
 return `⚠️ 참고: 실계좌 손실 한도 — 하루 손실 차단 ${d>0?d+'%':'꺼짐'} · 카피 열린 손실 한도 ${c>0?c+'%':'꺼짐'}`;
}
/** The Telegram message for one group that has just met the criteria. Plain text (no keys, no account numbers). */
export function readinessMessage(g,{again=false,lossLimits=null,scope=null}={}){
 const head=`✅ 실계좌 후보 — 검증 필요 · ${g.label} (테스트넷)${again?' · 다시 충족':''}`;
 const rows=g.kind==='PUMP'?[
  `${ok(g.checks.tracked)} 15분 결과가 있는 BingX 상장 알림 ${g.tracked}건 / ${g.minTracked}건 이상`,
  `${ok(g.checks.avg15)} 15분 되돌림 평균(비용 차감) ${pct(g.avg15Pct)} / 0% 초과`,
  `${ok(g.checks.halves)} 앞 절반 ${pct(g.olderHalf.avgPct)}(${g.olderHalf.count}건) · 뒤 절반 ${pct(g.newerHalf.avgPct)}(${g.newerHalf.count}건) / 둘 다 0% 초과`,
  `${ok(g.checks.avg60)} 60분 되돌림 평균 ${pct(g.avg60Pct)}(${g.tracked60}건) / 0% 이상`]:[
  `${ok(g.checks.trades)} 청산 거래 ${g.trades}건 / ${g.minTrades}건 이상`,
  `${ok(g.checks.profitFactor)} 수수료 뺀 PF ${pfText(g.profitFactor)} / ${g.minProfitFactor} 이상`,
  `${ok(g.checks.halves)} 앞 절반 ${money(g.olderHalf.netUSD)}(${g.olderHalf.count}건) · 뒤 절반 ${money(g.newerHalf.netUSD)}(${g.newerHalf.count}건) / 둘 다 0 초과`,
  g.bigLoss.count?`${ok(g.checks.bigLoss)} 큰 손실(비상 청산) 평균 ${money(-g.bigLoss.avgLossUSD)} = 평균 수익 ${money(g.bigLoss.avgWinUSD)}의 ${xText(g.bigLoss.ratio)}배 / ${g.bigLoss.max}배 이하 (${g.bigLoss.count}건)`:`✓ 큰 손실(비상 청산) 없음 / ${g.bigLoss.max}배 이하`];
 return [head,...rows,...(g.kind==='SCALP'&&scope?.management?[scopeText(scope)]:[]),`검증 구간: ${windowText(g.window)} — 이 거래들로 다시 한 번 검증한 뒤 결정하세요.`,READY_NOT_AUTOMATIC,lossLimitText(lossLimits||{})].join('\n');
}
/** /ready reply: every group's progress line. */
export function readyReplyText(summary,{lossLimits=null}={}){
 if(!summary?.groups?.length)return '⚠️ 실계좌 준비 점검 결과를 아직 계산하지 못했습니다.';
 return ['📋 실계좌 준비 점검 (테스트넷, 조회 전용)',...summary.groups.map(g=>`${g.ready?'✅':'·'} ${g.line}`),...(summary.scope?.text?[summary.scope.text]:[]),
  `단타 기준: ${READY_SCALP_MIN_TRADES}건 · PF ${READY_SCALP_MIN_PROFIT_FACTOR} 이상 · 앞·뒤 절반 모두 플러스 · 큰 손실 평균 ≤ 평균 수익 ${READY_SCALP_MAX_BIG_LOSS_X}배`,
  `급변 기준: ${READY_PUMP_MIN_TRACKED}건 · 15분 평균·앞뒤 절반 플러스 · 60분 평균 0% 이상`,
  READY_NOT_AUTOMATIC,lossLimitText(lossLimits||{})].join('\n');
}

/** Hourly check + one message per group when it first becomes ready (live-readiness.json keeps what was sent). */
export class ReadinessNotifier{
 constructor({directory=null,fileName=READY_FILE,send=null,now=()=>Date.now(),log=()=>{}}={}){
  Object.assign(this,{send,now,log});
  this.file=directory?path.join(directory,fileName):null;
  let saved=null;try{saved=this.file&&fs.existsSync(this.file)?readStore(this.file):null}catch(e){log('[READY] 기록 읽기 실패',e.message)}
  this.state={groups:{}};
  for(const g of READY_GROUPS){const s=saved?.groups?.[g];if(s&&typeof s==='object')this.state.groups[g]={ready:s.ready===true,notifiedAt:Number(s.notifiedAt)||null,notifyCount:Number(s.notifyCount)||0,lostAt:Number(s.lostAt)||null,window:s.window??null}}
  this.last=null;this.checking=false;
 }
 #save(){
  if(!this.file)return;
  try{fs.mkdirSync(path.dirname(this.file),{recursive:true});atomicWriteStore(this.file,{version:1,...this.state})}
  catch(e){this.log('[READY] 기록 저장 실패',e.message)}
 }
 /** summary: evaluateReadiness(); returns the groups notified now. A failed send is retried at the next check. */
 async check(summary,{lossLimits=null}={}){
  if(this.checking||!summary?.groups)return [];
  this.checking=true;const sent=[];let changed=false;
  try{
   this.last=summary;
   for(const g of summary.groups){
    if(!READY_GROUPS.includes(g.group))continue;
    const s=this.state.groups[g.group]||(this.state.groups[g.group]={ready:false,notifiedAt:null,notifyCount:0,lostAt:null,window:null});
    if(!g.ready){if(s.ready){s.ready=false;s.lostAt=this.now();changed=true}continue}
    if(s.ready)continue;
    const again=s.notifyCount>0,text=readinessMessage(g,{again,lossLimits,scope:summary.scope});
    try{
     if(typeof this.send!=='function')throw Error('TELEGRAM_NOT_CONFIGURED');
     await this.send(text);
    }catch(e){this.log('[READY] 텔레그램 전송 실패',g.group,e?.message||'ERROR');continue}
    Object.assign(s,{ready:true,notifiedAt:this.now(),notifyCount:s.notifyCount+1,window:g.window});changed=true;
    sent.push({group:g.group,again,text});
   }
  }finally{
   this.checking=false;
   if(changed)this.#save();
  }
  return sent;
 }
 /** For the screen, /ready and the hourly upload (latest.json liveReadiness). */
 status(summary=this.last){return {at:summary?.at??null,criteria:summary?.criteria??null,scope:summary?.scope??null,
  groups:(summary?.groups||[]).map(g=>({...g,notified:{...(this.state.groups[g.group]||{ready:false,notifiedAt:null,notifyCount:0,lostAt:null,window:null})}}))}}
}
