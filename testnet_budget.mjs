// One shared TESTNET risk budget for the signal strategy (live_executor.mjs, HYBRID/GROWTH on the testnet) and the
// reversal scalp (scalp_executor.mjs) (user 2026-11-17 18:03 "단타랑 원래 쓰던 테스트넷이랑 합쳐서 진행하자 따로 보는 게 더
// 복잡" -> "한도까지 하나로"; 18:11 "하루 손실을 늘리면 되지 너무 적잖아"). Testnet only: the LIVE paths never get one.
//
//  - Daily loss: today's (KST) loss of each strategy, summed with no offset between them (review 2026-11-17 M2: a win
//    of one never pays for a loss of the other): sum of max(0, -net result of that strategy today). Reaching
//    TESTNET_DAILY_LOSS_PCT (default 15) % of the equity stops new entries of both until the next KST day (open
//    positions keep their stops). The stop is written to its own small file (testnet-budget.json) when first reached
//    from final values, so it holds for the rest of the KST day even if results later recover or the scalp is off.
//    Placeholder values (a signal close not yet settled) block entries while they last but are never written.
//  - Open risk: today's loss + loss to the stops of every open position of both (+ entries being sent) + the new
//    trade's risk must stay within the same % of the equity.
//  - Margin: the margin of both together within TESTNET_MARGIN_CAP_PCT (default and maximum 30 %, the scalp's cap);
//    each executor keeps its own 90 % free-margin check.
//  - One balance basis: the latest shared account equity, subject to an explicit capital cap or an alternate venue balance.
// Per-trade risk, the signal's own open-risk cap (its profile %), 8 / 4-per-direction and the scalp's one-per-symbol
// stay per strategy. Each executor registers getters, so both stay testable on their own (no budget = old rules).
import fs from 'node:fs';
import path from 'node:path';
import {atomicWriteStore,readStore} from './persistence.mjs';

export const TESTNET_DAILY_LOSS_DEFAULT=15;
export const kstDay=t=>new Date(Number(t)+9*3600000).toISOString().slice(0,10);
const fin=v=>v!==null&&v!==undefined&&v!==''&&Number.isFinite(Number(v));
const r2=v=>Math.round(v*100)/100;

/** TESTNET_DAILY_LOSS_PCT: 1-50, default 15. */
export function testnetDailyLossPct(env=process.env){
 const raw=env?.TESTNET_DAILY_LOSS_PCT,v=Number(raw);
 return raw!==undefined&&raw!==''&&Number.isFinite(v)&&v>=1&&v<=50?v:TESTNET_DAILY_LOSS_DEFAULT;
}

const EQUITY_FRESH_MS=10*60000;
export const TESTNET_BALANCE_REFRESH_MS=3000;
const ACCOUNT_EQUITY_FRESH_MS=3*TESTNET_BALANCE_REFRESH_MS;
const ALTERNATE_EQUITY_FRESH_MS=30000;
/** TESTNET_MARGIN_CAP_PCT: the shared margin cap, default and maximum 30 % (review L5: never follows LIVE_MARGIN_USE_PCT). */
export const TESTNET_MARGIN_CAP_MAX=30;
export function testnetMarginCapPct(env=process.env){
 const raw=env?.TESTNET_MARGIN_CAP_PCT,v=Number(raw);
 return raw!==undefined&&raw!==''&&Number.isFinite(v)&&v>=1&&v<=TESTNET_MARGIN_CAP_MAX?v:TESTNET_MARGIN_CAP_MAX;
}
export class TestnetBudget{
 constructor({dailyLossPct=TESTNET_DAILY_LOSS_DEFAULT,marginCapPct=TESTNET_MARGIN_CAP_MAX,accountEquity=false,capitalCapUSD=null,now=()=>Date.now(),directory=null,fileName='testnet-budget.json',log=()=>{}}={}){
  Object.assign(this,{dailyLossPct,marginCapPct:Math.min(TESTNET_MARGIN_CAP_MAX,Number(marginCapPct)||TESTNET_MARGIN_CAP_MAX),accountEquity,capitalCapUSD,now,log});
  this.sources=new Map();this.equities=new Map();
  this.file=directory?path.join(directory,fileName):null;
  let saved=null;try{saved=this.file?readStore(this.file):null}catch(e){this.log('[TESTNET BUDGET] state unreadable',e.message)}
  const settings=saved?.settings;
  const valid=settings&&validBudgetSettings(settings);
  this.state={stop:saved?.stop&&typeof saved.stop.day==='string'?saved.stop:null,settings:valid?settings:null};
  if(valid)Object.assign(this,{dailyLossPct:settings.dailyLossPct,marginCapPct:settings.marginCapPct});
  this.account=null;this.accountError=null;
 }
 #save(state){if(this.file){fs.mkdirSync(path.dirname(this.file),{recursive:true});atomicWriteStore(this.file,{version:1,...state})}}
 configure({dailyLossPct,marginCapPct}={}){
  const settings={dailyLossPct,marginCapPct};
  if(!validBudgetSettings(settings))throw codeErr('INVALID_TESTNET_BUDGET',400);
  const state={...this.state,settings};this.#save(state);
  this.state=state;Object.assign(this,settings);
  return this.status();
 }
 observeAccount(equity,asset=null){
  if(!fin(equity)||Number(equity)<0){this.accountError='BALANCE_UNAVAILABLE';return}
  this.account={equity:Number(equity),asset,at:this.now()};this.accountError=null;
 }
 /** name 'signal' | 'scalp'. getters: realizedToday(day) -> net USD of the trades closed that KST day (loss < 0),
  * openRisk() -> USD to the stops, usedMargin() -> USD, optional unrealized() -> USD, stoppedToday(day) -> bool,
  * provisionalToday(day) -> true while today's figure holds a placeholder (a close not yet settled). */
 register(name,getters){this.sources.set(name,getters||{});return this}
 /** One balance basis for both strategies (review L7): the smaller of the given equity and the other strategy's recent one. */
 basis(equity,who=null){
  const at=this.now(),v=fin(equity)&&Number(equity)>0?Number(equity):null;
  if(this.accountEquity){
   if(who==='signal-alt'&&v!==null)this.equities.set(who,{v,at});
   if(this.accountError||!this.account||at-this.account.at>ACCOUNT_EQUITY_FRESH_MS)return null;
   const alt=this.equities.get('signal-alt'),other=alt&&at-alt.at<=ALTERNATE_EQUITY_FRESH_MS?alt.v:Infinity;
   return Math.min(this.account.equity,this.capitalCapUSD>0?this.capitalCapUSD:Infinity,other);
  }
  if(v!==null&&who)this.equities.set(who,{v,at});
  const vals=[...(v!==null?[v]:[]),...[...this.equities.values()].filter(x=>at-x.at<=EQUITY_FRESH_MS).map(x=>x.v)];
  return vals.length?Math.min(...vals):null;
 }
 /** The stored shared stop of today (null when none). */
 storedStop(day=kstDay(this.now())){const s=this.state.stop;return s&&s.day===day?s:null}
 /** Writes today's shared stop once (first time reached). Returns true when newly written. */
 markStopped(detail={},day=kstDay(this.now())){
  if(this.state.stop?.day===day)return false;
  this.state.stop={day,at:this.now(),...detail};
  try{this.#save(this.state)}catch(e){this.log('[TESTNET BUDGET] save',e.message)}
  return true;
 }
 /** Today's numbers. A getter that throws makes the snapshot unusable (ok:false): no entry is allowed on it. */
 snapshot(equity=null,{who=null}={}){
  const day=kstDay(this.now()),by={};let ok=true,realized=0,loss=0,lossOpen=0,open=0,margin=0,unreal=0,stopped=false,provisional=false;
  const checkNum=(v,def=0)=>{if(v===undefined||v===null)return def;const n=Number(v);if(!Number.isFinite(n))throw Error('INVALID_BUDGET_METRIC');return n};
  for(const [name,g] of this.sources){
   try{
    const s={realizedNetUSD:checkNum(g.realizedToday?.(day)),openRiskUSD:Math.max(0,checkNum(g.openRisk?.())),marginUSD:Math.max(0,checkNum(g.usedMargin?.())),
     unrealizedUSD:checkNum(g.unrealized?.()),stopped:g.stoppedToday?.(day)===true,provisional:g.provisionalToday?.(day)===true};
    // Each strategy's loss on its own (no offset between strategies); inside one strategy its net result.
    s.lossUSD=Math.max(0,-s.realizedNetUSD);s.lossWithOpenUSD=Math.max(0,-(s.realizedNetUSD+s.unrealizedUSD));
    by[name]=s;realized+=s.realizedNetUSD;loss+=s.lossUSD;lossOpen+=s.lossWithOpenUSD;open+=s.openRiskUSD;margin+=s.marginUSD;unreal+=s.unrealizedUSD;stopped||=s.stopped;provisional||=s.provisional;
   }catch(e){ok=false;by[name]={error:e?.code||e?.message||'READ_FAILED'}}
  }
  const eq=this.basis(equity,who),limit=eq!==null?eq*this.dailyLossPct/100:null,stored=this.storedStop(day);
  if(stored)stopped=true;
  // Reached from final values: written once for the rest of the KST day. From a placeholder or open unrealized loss: blocks now, not written.
  if(ok&&limit!==null&&limit>0&&(loss>=limit||lossOpen>=limit)){stopped=true;if(!provisional&&!stored&&loss>=limit)this.markStopped({lossUSD:+loss.toFixed(2),limitUSD:+limit.toFixed(2),reason:'REALIZED'},day)}
  return {ok,day,equityUSD:eq,dailyLossPct:this.dailyLossPct,limitUSD:limit,realizedNetUSD:realized,lossUSD:loss,lossWithOpenUSD:lossOpen,openRiskUSD:open,usedUSD:loss+open,
   unrealizedUSD:unreal,marginUSD:margin,marginCapPct:this.marginCapPct,marginCapUSD:eq!==null?eq*this.marginCapPct/100:null,stopped,provisional,storedStop:this.storedStop(day),by};
 }
 /** Today's day stop (stored, the shared loss reached, or the scalp's shared realized + unrealized stop). */
 stopped(equity=null){const s=this.snapshot(equity);return s.ok&&s.stopped}
 /** May a new entry with this risk (and margin, unless margin:false) go out? {ok, reason, detail, snap}. */
 check({equity,newRiskUSD=0,newMarginUSD=0,margin=true,who=null}){
  const s=this.snapshot(equity,{who}),no=(reason,detail=null)=>({ok:false,reason,detail,snap:s});
  if(!s.ok)return no('TESTNET_BUDGET_UNAVAILABLE');
  if(!s.equityUSD)return no('NO_BALANCE');
  if(s.stopped)return no('DAILY_LOSS_LIMIT',`오늘 손실 $${s.lossUSD.toFixed(2)} / 한도 $${s.limitUSD.toFixed(2)} (${this.dailyLossPct}%)`);
  const risk=s.usedUSD+Math.max(0,Number(newRiskUSD)||0);
  if(risk>s.limitUSD+1e-9)return no('OPEN_RISK_LIMIT',`$${risk.toFixed(2)} > $${s.limitUSD.toFixed(2)} (${this.dailyLossPct}%, 신호+단타)`);
  if(margin&&s.marginUSD+Math.max(0,Number(newMarginUSD)||0)>s.marginCapUSD+1e-9)return no('TESTNET_MARGIN_CAP',`$${(s.marginUSD+Number(newMarginUSD||0)).toFixed(2)} > $${s.marginCapUSD.toFixed(2)} (${this.marginCapPct}%)`);
  return {ok:true,reason:null,detail:null,snap:s,riskUSD:risk};
 }
 /** For the page: rounded numbers. */
 status(equity=null){const s=this.snapshot(equity);
  return {ok:s.ok,at:this.now(),day:s.day,dailyLossPct:s.dailyLossPct,equityUSD:s.equityUSD,limitUSD:s.limitUSD===null?null:r2(s.limitUSD),realizedNetUSD:r2(s.realizedNetUSD),lossUSD:r2(s.lossUSD),
   ...(this.accountEquity?{accountEquityUSD:this.account?.equity??null,balanceAsset:this.account?.asset??null,balanceAt:this.account?.at??null,
    balanceError:this.accountError||(this.account&&s.equityUSD===null?'BALANCE_STALE':null)}:{}),
   openRiskUSD:r2(s.openRiskUSD),usedUSD:r2(s.usedUSD),marginUSD:r2(s.marginUSD),marginCapPct:s.marginCapPct,marginCapUSD:s.marginCapUSD===null?null:r2(s.marginCapUSD),stopped:s.stopped,provisional:s.provisional,
   by:Object.fromEntries(Object.entries(s.by).map(([k,v])=>[k,v.error?v:{realizedNetUSD:r2(v.realizedNetUSD),lossUSD:r2(v.lossUSD),openRiskUSD:r2(v.openRiskUSD),marginUSD:r2(v.marginUSD)}]))};
 }
}
function validBudgetSettings({dailyLossPct,marginCapPct}){
 return Number.isFinite(dailyLossPct)&&dailyLossPct>=1&&dailyLossPct<=50&&Number.isFinite(marginCapPct)&&marginCapPct>=1&&marginCapPct<=TESTNET_MARGIN_CAP_MAX;
}

const codeErr=(code,status=409)=>Object.assign(Error(code),{code,httpStatus:status});
/** One switch for the testnet page (활성화): the signal strategy (when it runs on the testnet) and the scalp together.
 * Never used for LIVE: the caller passes only a testnet / OFF signal executor. The kill switch or an update in
 * progress refuses both. A scalp that cannot run (no key, SCALP_EXEC_MODE=OFF) is reported, not fatal. */
export function armTestnet({live,scalp}){
 if(live?.config?.mode==='LIVE')throw codeErr('NOT_TESTNET');
 if(live?.store?.killSwitch)throw codeErr('KILL_SWITCH_ON');
 if(live?.updating)throw codeErr('UPDATING');
 const signal=live?.config?.mode==='TESTNET'&&live.config.testnetSignalEntries!==false;
 if(signal)live.arm();
 let scalpError=null;
 if(scalp){if(scalp.config?.mode==='TESTNET'&&scalp.client){try{if(!scalp.armed)scalp.arm()}catch(e){scalpError=e?.code||e?.message}}else scalpError=scalp.config?.refused||(scalp.config?.mode!=='TESTNET'?'SCALP_MODE_OFF':'CREDENTIALS_MISSING')}
 if(!signal&&!scalp?.armed)throw Object.assign(codeErr('LIVE_MODE_OFF'),scalpError?{detail:scalpError}:{});
 return testnetSwitch({live,scalp,scalpError});
}
export function disarmTestnet({live,scalp,reason='MANUAL'}){
 if(live?.config?.mode==='LIVE')throw codeErr('NOT_TESTNET');
 if(live?.config?.mode==='TESTNET')live.disarm();
 if(scalp?.armed)scalp.disarm(reason);
 return testnetSwitch({live,scalp});
}
/** The switch state the page shows: armed only when every strategy that can run is on. */
export function testnetSwitch({live,scalp,scalpError=null}){
 const scalpOnly=live?.config?.mode==='TESTNET'&&live.config.testnetSignalEntries===false;
 const signalOn=live?.config?.mode==='TESTNET'&&!scalpOnly,scalpOn=Boolean(scalp&&scalp.config?.mode==='TESTNET'&&scalp.client);
 const parts=[...(signalOn?[live.armed===true]:[]),...(scalpOn?[scalp.armed===true]:[])];
 return {signal:signalOn?{armed:live.armed===true}:null,scalp:scalpOn?{armed:scalp.armed===true}:null,
  armed:parts.length>0&&parts.every(Boolean),partial:parts.some(Boolean)&&!parts.every(Boolean),killSwitch:live?.store?.killSwitch===true,...(scalpOnly?{scalpOnly:true}:{}),...(scalpError?{scalpError}:{})};
}
