// 급변 알림 초단타 (PUMP_FADE) on the BingX TESTNET only (user 2026-11-25 14:23 "이건 따로 조건을 봐야할 것 같은데 확인해보니
// 1분봉 3개가 연속으로 음봉이거나 양봉으로 떴을 때 역추세용으로 쓰는 초단타용인 것 같아", 14:30 TP/SL not the same % for every
// coin, 14:32 "매매 시작해", 14:34 "아냐 단타로 썼던 것 그대로 두고 초단타를 별개로 테스트해보는 거야").
// A separate strategy beside the 5m reversal scalp, driven by the same 공습경보 alerts (pump_alert.mjs). Both may look at one
// alert; one position per symbol across both (and the signal strategy / testnet copy): whoever holds or is entering a coin
// first keeps it, the other skips with SYMBOL_HELD_BY_OTHER_STRATEGY.
//
//  1. Trigger: an alert for an ordinary BingX USDT perpetual (no stock-type NC*, not unlisted), at most maxAgeSec (180 s)
//     old when it arrives, the testnet switch on, the kill switch off, and the shared testnet budget.
//  2. Confirm on BingX 1m candles: the 3 closed candles ending with the alert's own minute must all be in the alert's
//     direction (all red for DOWN, all green for UP) and move >= minMovePct (6 %) together (first open -> last close).
//  3. Entry (mode B): the first 1m candle of the opposite colour that closes within turnWaitMin (5 min) of the alert; then
//     counter-trend at market (DOWN -> LONG, UP -> SHORT). No opposite candle in time -> PUMP_FADE_NO_TURN.
//     Mode A (enter right after the confirmation) is never traded: it is simulated in the alert record (pumpFadeSimulation).
//     Execution: straight MARKET by default (makerWaitMs 0). The turn is a momentum candle: a passive PostOnly order fills
//     mostly when the price comes back against the fade (adverse selection), and waiting seconds in a ±10 % move costs far
//     more than the 0.04 % maker saving on a >= 1.5 % target. PUMP_FADE_MAKER_WAIT_MS (<= 5000) turns on maker-then-market.
//  4. TP / SL scaled to the move: R = the 3 candles' high - low as % of the entry. TP = max(tpMinPct 1.5, 0.15 R) net of the
//     round-trip costs; SL = max(slMinPct 3, 0.30 R) from the entry. The stop goes one tick beyond the 3-candle extreme
//     instead when that is closer than SL (and at least minStopPct 0.5 % away). SL = an exchange STOP_MARKET closePosition
//     (hedge: its own positionSide), so it survives a restart; TP = a reduce-only LIMIT (hedge: positionSide, no
//     reduceOnly), and monitored at the mark when that order is missing. Market close after maxHoldMin (15 min).
//  5. Size: riskPct (0.5 %) of the equity lost at the stop (costs included), no adds, margin <= maxMarginPct (10 %) of the
//     equity, the configured leverage within the venue's maximum.
// LIVE is impossible: the mode is OFF or TESTNET and the client must be a TESTNET client (the constructor refuses others).
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {atomicWriteStore,readStore} from './persistence.mjs';
import {roundDecimalToStep} from './decimal_grid.mjs';
import {readPositionMode,leverageSideFor,positionSideFor,forMode} from './bingx_position_mode.mjs';
import {placeMakerThenMarket} from './maker_order.mjs';
import {appendJsonl,readJsonl} from './scalp_journal.mjs';
import {positionOf,SCALP_EXEC_COSTS,SCALP_BTC_GUARD_5M_PCT,SCALP_BTC_GUARD_15M_PCT} from './scalp_executor.mjs';
import {reasonLabel} from './public/scalp_reasons.js';

export const PUMP_FADE_STRATEGY='PUMP_FADE';
export const PUMP_FADE_LABEL='[급변 초단타·테스트넷]';
// The same round trip as the pump-alert tracking (pump_alert.mjs PUMP_COST_PCT): taker both ways, slippage both ways, one spread.
export const PUMP_FADE_COST_PCT=+((2*SCALP_EXEC_COSTS.takerRate+(2*SCALP_EXEC_COSTS.slippageBps+SCALP_EXEC_COSTS.spreadBps)/1e4)*100).toFixed(4);
export const PUMP_FADE_DEFAULTS=Object.freeze({maxAgeSec:180,confirmBars:3,minMovePct:6,turnWaitMin:5,turnLateSec:30,tpMinPct:1.5,tpRangeMult:.15,
 slMinPct:3,slRangeMult:.3,minStopPct:.5,maxHoldMin:15,riskPct:.5,leverage:10,maxMarginPct:10,makerWaitMs:0});
const M=60000,GRACE_MS=2000,POLL_MS=2000,MAX_CLOSED=300,MAX_EVENTS=200,MAX_SKIPS=60,MAX_ALERTS=200,SETTLE_DELAY_MS=150000,SETTLE_TRIES=4;
const num=v=>{const n=Number(v);return Number.isFinite(n)?n:null};
const pos=v=>{const n=Number(v);return Number.isFinite(n)&&n>0?n:null};
const r4=x=>Number.isFinite(x)?Math.round(x*1e4)/1e4:null;
const r2=x=>Number.isFinite(x)?Math.round(x*100)/100:null;
const dirOf=d=>d==='SHORT'?-1:1;
const kstDay=t=>new Date(Number(t)+9*3600000).toISOString().slice(0,10);
const grid=(v,step,mode)=>{try{return roundDecimalToStep(v,step,mode)}catch{return null}};
const orderOf=d=>d?.order??d;
const orderId=d=>{const o=orderOf(d),id=o?.orderId??o?.orderID;return id===undefined||id===null?null:String(id)};
const err=(code,status=409)=>Object.assign(Error(code),{code,httpStatus:status});
const withTimeout=(p,ms,fallback=null)=>Promise.race([Promise.resolve(p).catch(()=>fallback),new Promise(r=>setTimeout(()=>r(fallback),ms).unref?.())]);
const openSide=d=>d==='SHORT'?'SELL':'BUY',closeSide=d=>d==='SHORT'?'BUY':'SELL';
// A stop away from the entry (LONG down / SHORT up), a target toward the entry.
// The target is rounded away from the entry too, so its net stays >= the TP % (a tick more, never less).
const awayMode=d=>d==='SHORT'?'UP':'DOWN',tpMode=d=>d==='SHORT'?'DOWN':'UP';
// Snap to the tick after removing float noise (92.8 - 0.01 = 92.78999999999999 must stay 92.79).
const snap=(v,tick,mode)=>Number(grid(+Number(v).toFixed(10),tick,mode));
const OFF_WORDS=['off','false','0','no'],ON_WORDS=['on','true','1','yes','testnet'];

/** PUMP_FADE (default on) and its parameters. Only ever TESTNET: PUMP_FADE=LIVE (or anything unknown) is refused, and the
 * strategy is OFF unless the testnet scalp mode (SCALP_EXEC_MODE) is TESTNET. */
export function pumpFadeConfig(env=process.env){
 const n=(k,d,lo,hi)=>{const v=Number(env[k]);return env[k]!==undefined&&env[k]!==''&&Number.isFinite(v)&&v>=lo&&v<=hi?v:d};
 const raw=String(env.PUMP_FADE??'').trim().toLowerCase(),off=OFF_WORDS.includes(raw),known=raw===''||off||ON_WORDS.includes(raw);
 const scalpMode=String(env.SCALP_EXEC_MODE??'').trim().toUpperCase()||'TESTNET';
 const refused=!known?(raw==='live'?'LIVE_REFUSED':'MODE_INVALID'):off?'PUMP_FADE_OFF':scalpMode!=='TESTNET'?'PUMP_FADE_TESTNET_ONLY':null;
 const D=PUMP_FADE_DEFAULTS;
 return {strategy:PUMP_FADE_STRATEGY,mode:refused?'OFF':'TESTNET',refused,
  maxAgeSec:n('PUMP_FADE_MAX_AGE_SEC',D.maxAgeSec,30,600),confirmBars:n('PUMP_FADE_CONFIRM_BARS',D.confirmBars,2,5),
  minMovePct:n('PUMP_FADE_MIN_MOVE_PCT',D.minMovePct,1,50),turnWaitMin:n('PUMP_FADE_TURN_WAIT_MIN',D.turnWaitMin,1,15),turnLateSec:n('PUMP_FADE_TURN_LATE_SEC',D.turnLateSec,5,120),
  tpMinPct:n('PUMP_FADE_TP_MIN_PCT',D.tpMinPct,.2,20),tpRangeMult:n('PUMP_FADE_TP_R_MULT',D.tpRangeMult,0,2),
  slMinPct:n('PUMP_FADE_SL_MIN_PCT',D.slMinPct,.5,30),slRangeMult:n('PUMP_FADE_SL_R_MULT',D.slRangeMult,0,3),minStopPct:n('PUMP_FADE_MIN_STOP_PCT',D.minStopPct,.1,10),
  maxHoldMin:n('PUMP_FADE_MAX_HOLD_MIN',D.maxHoldMin,1,240),riskPct:n('PUMP_FADE_RISK_PCT',D.riskPct,.05,2),
  leverage:n('PUMP_FADE_LEVERAGE',n('SCALP_LEVERAGE',D.leverage,1,20),1,20),maxMarginPct:n('PUMP_FADE_MAX_MARGIN_PCT',n('SCALP_MAX_MARGIN_PCT',D.maxMarginPct,1,50),1,50),
  makerWaitMs:n('PUMP_FADE_MAKER_WAIT_MS',D.makerWaitMs,0,5000),costPct:PUMP_FADE_COST_PCT};
}
/** The rules the simulation and the screen use (TP / SL / time / confirmation), from a config. */
export const pumpFadeRules=c=>({confirmBars:c.confirmBars,minMovePct:c.minMovePct,turnWaitMin:c.turnWaitMin,tpMinPct:c.tpMinPct,tpRangeMult:c.tpRangeMult,
 slMinPct:c.slMinPct,slRangeMult:c.slRangeMult,minStopPct:c.minStopPct,maxHoldMin:c.maxHoldMin,costPct:c.costPct??PUMP_FADE_COST_PCT});

// ---- pure helpers -------------------------------------------------------------------------------------------------
/** Closed 1m candles by open time: {t, o, h, l, c, closeAt}. */
export function closedBars(rows,now){
 const out=new Map();
 for(const k of Array.isArray(rows)?rows:[]){
  if(!Array.isArray(k))continue;
  const t=Number(k[0]),o=Number(k[1]),h=Number(k[2]),l=Number(k[3]),c=Number(k[4]),ct=Number(k[6]);
  if(!Number.isFinite(t)||!pos(o)||!pos(h)||!pos(l)||!pos(c)||h<l)continue;
  if(Number.isFinite(ct)?ct>=now:t+M>now)continue;
  out.set(t,{t,o,h,l,c,closeAt:t+M});
 }
 return out;
}
const colourOf=b=>b.c>b.o?'UP':b.c<b.o?'DOWN':'FLAT';
/** Step 2: the `bars` closed 1m candles ending with the alert's minute (opens m0-(bars-1) min .. m0). ok when every one
 * closed in the alert's direction and first open -> last close moved >= minMovePct. R = (high - low) of the window. */
export function fadeConfirm(rows,{at,dir,bars=3,minMovePct=6,now=Date.now()}){
 const m0=Math.floor(at/M)*M,by=closedBars(rows,now),list=[];
 for(let i=bars-1;i>=0;i--){const b=by.get(m0-i*M);if(!b)return {ok:false,reason:'PUMP_FADE_CANDLES_MISSING',detail:`${bars}개 중 ${list.length}개`};list.push(b)}
 const colours=list.map(colourOf),same=colours.filter(c=>c===dir).length;
 const first=list[0].o,last=list.at(-1).c,movePct=Math.abs(last/first-1)*100;
 const high=Math.max(...list.map(b=>b.h)),low=Math.min(...list.map(b=>b.l));
 const res={bars:list.map(b=>({t:b.t,o:b.o,h:b.h,l:b.l,c:b.c})),colours,movePct:r4(movePct),high,low,extreme:dir==='DOWN'?low:high,range:high-low,closeAt:m0+M,lastClose:last};
 const word=dir==='DOWN'?'음봉':'양봉';
 if(same<bars)return {...res,ok:false,reason:'PUMP_FADE_NOT_CONFIRMED',detail:`${word} ${same}/${bars}`};
 if(movePct<minMovePct)return {...res,ok:false,reason:'PUMP_FADE_NOT_CONFIRMED',detail:`${bars}봉 ${movePct.toFixed(2)}% < ${minMovePct}%`};
 return {...res,ok:true,reason:null,detail:null};
}
/** Step 3: the first closed 1m candle after the alert's minute in the opposite colour whose close is within waitMin of
 * the alert. {found, bar, closeAt, close, minutes} | {found:false, expired, lastOpen}. */
export function fadeTurn(rows,{at,dir,waitMin=5,now=Date.now()}){
 const m0=Math.floor(at/M)*M,deadline=at+waitMin*M,by=closedBars(rows,now),want=dir==='DOWN'?'UP':'DOWN';
 let lastOpen=null;
 for(let t=m0+M;t+M<=deadline;t+=M){
  const b=by.get(t);if(!b)break;
  lastOpen=t;
  if(colourOf(b)===want)return {found:true,bar:{t:b.t,o:b.o,h:b.h,l:b.l,c:b.c},closeAt:b.closeAt,close:b.c,minutes:r2((b.closeAt-at)/M),lastOpen};
 }
 // Every candle that could close in time has closed and was read: none turned.
 const lastPossible=Math.floor(deadline/M)*M-M;
 const expired=lastPossible<m0+M||(lastOpen!==null&&lastOpen>=lastPossible)||now>deadline+M;
 return {found:false,expired,lastOpen};
}
/** Step 4: TP / SL from the entry and the 3-candle range. tick (optional) for the extreme rule and rounding. */
export function fadeLevels({direction,entry,range,extreme,tick=null,rules}){
 const R=rules||PUMP_FADE_DEFAULTS,d=dirOf(direction),cost=R.costPct??PUMP_FADE_COST_PCT;
 if(!pos(entry)||!(range>=0))return {ok:false,reason:'PUMP_FADE_LEVELS_INVALID'};
 const rangePct=range/entry*100,tpPct=Math.max(R.tpMinPct,R.tpRangeMult*rangePct),slPct=Math.max(R.slMinPct,R.slRangeMult*rangePct);
 let stop=entry*(1-d*slPct/100),basis='PCT';
 const t=pos(tick)||0,ex=pos(extreme)?+(extreme-d*t).toFixed(10):null;
 if(ex){const dist=d*(entry-ex)/entry*100;if(dist>=R.minStopPct&&dist<slPct){stop=ex;basis='EXTREME'}}
 let tp=entry*(1+d*(tpPct+cost)/100);
 if(t>0){stop=snap(stop,tick,awayMode(direction))||stop;tp=snap(tp,tick,tpMode(direction))||tp}
 if(!(stop>0)||!(tp>0)||d*(entry-stop)<=0||d*(tp-entry)<=0)return {ok:false,reason:'PUMP_FADE_LEVELS_INVALID'};
 return {ok:true,rangePct:r4(rangePct),tpPct:r4(tpPct),slPct:r4(slPct),stopPct:r4(d*(entry-stop)/entry*100),tpGrossPct:r4(d*(tp-entry)/entry*100),stop,tp,stopBasis:basis,costPct:cost};
}
/** Hypothetical outcome from 1m candles: entry at entryAt (a candle close), then TP / SL (both in one candle -> SL first),
 * else the close of the candle ending at entryAt + maxHoldMin. netPct after costPct. exit null while still open. */
export function fadeSimulate({rows,direction,entry,entryAt,levels,maxHoldMin=15,now=Date.now()}){
 if(!levels?.ok)return {exit:null,reason:levels?.reason??'PUMP_FADE_LEVELS_INVALID'};
 const d=dirOf(direction),by=closedBars(rows,now),end=entryAt+maxHoldMin*M,cost=levels.costPct??PUMP_FADE_COST_PCT;
 let mfe=0,mae=0;const pct=p=>d*(p/entry-1)*100;
 const base={entry,entryAt,tp:levels.tp,stop:levels.stop,tpPct:levels.tpPct,slPct:levels.slPct,stopPct:levels.stopPct,stopBasis:levels.stopBasis};
 for(let t=entryAt;t+M<=end;t+=M){
  const b=by.get(t);if(!b)return {...base,exit:null,mfePct:r4(mfe),maePct:r4(mae)};
  const fav=pct(d>0?b.h:b.l),adv=-pct(d>0?b.l:b.h);mfe=Math.max(mfe,fav);mae=Math.max(mae,adv);
  const hitSl=d>0?b.l<=levels.stop:b.h>=levels.stop,hitTp=d>0?b.h>=levels.tp:b.l<=levels.tp;
  if(hitSl)return {...base,exit:'SL',exitAt:b.closeAt,netPct:r4(pct(levels.stop)-cost),mfePct:r4(mfe),maePct:r4(mae)};
  if(hitTp)return {...base,exit:'TP',exitAt:b.closeAt,netPct:r4(pct(levels.tp)-cost),mfePct:r4(mfe),maePct:r4(mae)};
  if(t+M===end)return {...base,exit:'TIME',exitAt:b.closeAt,netPct:r4(pct(b.c)-cost),mfePct:r4(mfe),maePct:r4(mae)};
 }
 return {...base,exit:null,mfePct:r4(mfe),maePct:r4(mae)};
}
/** ATR(n) of the n 1m candles before `beforeOpen`, as % of the last of them. null without enough candles. */
export function atr1mPct(rows,{beforeOpen,n=14,now=Date.now()}){
 const by=closedBars(rows,now),list=[];
 for(let t=beforeOpen-(n+1)*M;t<beforeOpen;t+=M){const b=by.get(t);if(b)list.push(b)}
 if(list.length<n+1)return null;
 let s=0;for(let i=1;i<list.length;i++){const b=list[i],pc=list[i-1].c;s+=Math.max(b.h-b.l,Math.abs(b.h-pc),Math.abs(b.l-pc))}
 return r4(s/(list.length-1)/list.at(-1).c*100);
}
/** The record of one alert under the current rules (pump-alerts.json `fadeSim`): the 1m ATR % before the move, the
 * confirmation, when the opposite candle came, and the hypothetical results of mode A (enter at the confirmation close)
 * and mode B (enter at the opposite candle's close, the traded mode). Pure. */
export function pumpFadeSimulation({at,dir,rows,now=Date.now(),rules=PUMP_FADE_DEFAULTS}){
 const R={...PUMP_FADE_DEFAULTS,costPct:PUMP_FADE_COST_PCT,...(rules||{})},direction=dir==='DOWN'?'LONG':'SHORT';
 const conf=fadeConfirm(rows,{at,dir,bars:R.confirmBars,minMovePct:R.minMovePct,now});
 const m0=Math.floor(at/M)*M;
 const out={v:1,at:now,rules:{...pumpFadeRules(R)},atr1mPct:atr1mPct(rows,{beforeOpen:m0-(R.confirmBars-1)*M,now}),
  confirm:{passed:conf.ok===true,reason:conf.reason??null,detail:conf.detail??null,movePct:conf.movePct??null,colours:conf.colours??null},rangePct:null,turn:null,A:null,B:null};
 if(conf.reason==='PUMP_FADE_CANDLES_MISSING')return out;
 const sim=(entry,entryAt)=>{const lv=fadeLevels({direction,entry,range:conf.range,extreme:conf.extreme,rules:R});return fadeSimulate({rows,direction,entry,entryAt,levels:lv,maxHoldMin:R.maxHoldMin,now})};
 out.rangePct=r4(conf.range/conf.lastClose*100);
 const turn=fadeTurn(rows,{at,dir,waitMin:R.turnWaitMin,now});
 out.turn=turn.found?{at:turn.closeAt,minutes:turn.minutes,close:turn.close}:{at:null,expired:turn.expired===true};
 // Mode A and B are simulated whether the confirmation passed or not (calibration); `confirm.passed` says which one traded.
 out.A=sim(conf.lastClose,conf.closeAt);
 if(turn.found)out.B=sim(turn.close,turn.closeAt);
 return out;
}
/** clientOrderId of one alert's trade (24 chars; tags appended: s stop, t target, x time exit, e emergency). */
export const pumpFadeClientId=(symbol,at,direction)=>'pf'+createHash('sha256').update(`${PUMP_FADE_STRATEGY}|${symbol}|${at}|${direction}`).digest('hex').slice(0,22);
/** Step 5: quantity for riskPct of the equity at the stop (taker both ways), margin <= maxMarginPct of the equity and 90 %
 * of the free margin, rounded down to the venue step, at least its minimum. */
export function fadeSize({equity,available=null,entry,stop,leverage,riskPct,maxMarginPct,takerRate=SCALP_EXEC_COSTS.takerRate,contract}){
 if(!pos(equity)||!pos(entry)||!pos(stop)||!pos(leverage))return {ok:false,reason:'NO_BALANCE'};
 const perUnit=Math.abs(entry-stop)+(entry+stop)*takerRate,riskUSD=equity*riskPct/100;
 let qty=riskUSD/perUnit,capped=null;
 const capUSD=equity*maxMarginPct/100,room=available!=null&&Number.isFinite(Number(available))?Math.min(capUSD,Math.max(0,Number(available))*.9):capUSD;
 if(qty*entry/leverage>room){qty=room*leverage/entry;capped=room<capUSD?'FREE_MARGIN':'MARGIN_CAP'}
 const q=Number(grid(qty,contract?.quantityStep,'DOWN'))||0,minQ=Number(contract?.minQuantityBase)||0,minN=Number(contract?.minNotionalUSDT)||0;
 if(!(q>0)||q<minQ||q*entry<minN)return {ok:false,reason:'QUANTITY_BELOW_MINIMUM',detail:`${r4(qty)}개 · 최소 ${minQ||'-'}개·$${minN||'-'}`};
 return {ok:true,qty:q,riskUSD:r4(q*perUnit),marginUSD:r4(q*entry/leverage),capped,capUSD:r4(capUSD)};
}

// ---- Telegram / screen text ----------------------------------------------------------------------------------------
const fmt=v=>{const x=Number(v);if(!Number.isFinite(x))return '—';const a=Math.abs(x);return a>=1000?x.toLocaleString('en-US',{maximumFractionDigits:2}):a>=1?String(+x.toFixed(4)):String(+x.toPrecision(4))};
const usd=v=>{const x=Number(v);return Number.isFinite(x)?(x>=0?'+':'−')+'$'+Math.abs(x).toFixed(2):'—'};
const SIDE={LONG:'롱',SHORT:'숏'};
/** Text of one PUMP_FADE event for Telegram and the screen notice (entries, exits, problems); null for the rest. */
export function pumpFadeEventText(e){
 if(!e)return null;
 const head=`${PUMP_FADE_LABEL} ${e.symbol||''}`.trim(),side=SIDE[e.direction]||'';
 if(e.type==='OPENED'){
  const c=e.confirm||{};
  return `🟢 ${head} ${side} ${e.leverage}배 진입 · 역추세\n진입 ${fmt(e.entry)} · 익절 ${fmt(e.tp)} (+${e.tpPct}% 수수료 뺀) · 손절 ${fmt(e.stop)} (−${e.stopPct}%${e.stopBasis==='EXTREME'?' · 3봉 극값 너머':''})\n`
   +`알림 ${e.alertDir==='DOWN'?'↓':'↑'}${e.alertPct??'—'}% · 1분봉 ${c.bars??3}개 ${e.alertDir==='DOWN'?'음봉':'양봉'} ${c.movePct??'—'}% · 범위 R ${e.rangePct}% · 반대 봉 ${e.turnMinutes??'—'}분 뒤\n위험 $${Number(e.riskUSD||0).toFixed(2)} · 증거금 $${Number(e.marginUSD||0).toFixed(2)} · 최대 ${e.maxHoldMin}분`;
 }
 if(e.type==='CLOSED')return `${Number(e.netUSD)>0?'✅':Number(e.netUSD)<0?'🔻':'⚪'} ${head} ${side} 청산 · ${reasonLabel(e.reason)}\n손익 ${usd(e.netUSD)} (수수료 포함 추정) · 보유 ${Math.max(1,Math.round((Number(e.holdMs)||0)/60000))}분`;
 if(['STOP_FAILED','EMERGENCY_CLOSE_FAILED','ENTRY_OUTCOME_UNKNOWN'].includes(e.type))
  return `⚠️ ${head} ${e.type==='STOP_FAILED'?'손절 주문 실패 — 긴급 청산':e.type==='ENTRY_OUTCOME_UNKNOWN'?'진입 결과 확인 안 됨':'긴급 청산 실패 — 즉시 확인 필요'}${e.reason?` (${reasonLabel(e.reason)})`:''}`;
 return null;
}

// ---- the executor --------------------------------------------------------------------------------------------------
export class PumpFadeExecutor{
 /** candles1m(symbol, limit): BingX public 1m klines. btcCandles(): BTC 5m klines (shock guard). isBusy(symbol, venueSymbol):
  * another strategy holds or is entering it. active(): the testnet switch. journalFile: the shared scalp journal (lines
  * tagged strategy PUMP_FADE). budget: the shared testnet budget (TestnetBudget). */
 constructor({config,client=null,contracts=async()=>new Map(),candles1m=async()=>[],btcCandles=null,balance=async()=>null,isBusy=()=>false,active=()=>true,
  gate=()=>({ok:true}),budget=null,directory=null,fileName='pump-fade-store.json',journalFile=null,now=()=>Date.now(),log=()=>{},onEvent=()=>{},onResult=null}={}){
  if(config?.mode!=='TESTNET'&&config?.mode!=='OFF')throw err('PUMP_FADE_TESTNET_ONLY',500);
  if(client&&client.mode!=='TESTNET')throw err('PUMP_FADE_TESTNET_ONLY',500);
  Object.assign(this,{config,client,contracts,candles1m,btcCandles,balance,isBusy,active,gate,budget,now,log,onEvent,onResult});
  this.file=directory?path.join(directory,fileName):null;this.journalFile=journalFile;
  let saved=null;try{saved=this.file&&fs.existsSync(this.file)?readStore(this.file):null}catch(e){log('[PUMP_FADE] 기록 읽기 실패',e.message)}
  this.store={open:Array.isArray(saved?.open)?saved.open:[],closed:Array.isArray(saved?.closed)?saved.closed:[],events:Array.isArray(saved?.events)?saved.events:[],
   skips:Array.isArray(saved?.skips)?saved.skips:[],skipCounts:saved?.skipCounts&&typeof saved.skipCounts==='object'?saved.skipCounts:{},alerts:Array.isArray(saved?.alerts)?saved.alerts:[]};
  for(const p of this.store.open)if(p.status==='SUBMITTING')p.status='UNKNOWN';
  const written=this.journalFile?readJsonl(this.journalFile).filter(x=>x?.strategy===PUMP_FADE_STRATEGY):[];
  this.journalRows=written.map(x=>({id:x.id,direction:x.direction,netUSD:x.pnl?.netUSD??null,openedAt:x.entry?.at??null,closedAt:x.exit?.at??null,closeReason:x.exit?.reason??null}));
  this.journalIds=new Set(this.journalRows.map(x=>x.id).filter(Boolean));
  this.watches=new Map();this.reserved=new Set();this.reconciling=false;this.lastReconcileAt=0;this.ticking=false;this.funds=null;
 }
 rules(){return pumpFadeRules(this.config)}
 #save(){if(!this.file)return;const s=this.store;s.closed=s.closed.slice(-MAX_CLOSED);s.events=s.events.slice(-MAX_EVENTS);s.skips=s.skips.slice(-MAX_SKIPS);s.alerts=s.alerts.slice(-MAX_ALERTS);
  try{fs.mkdirSync(path.dirname(this.file),{recursive:true});atomicWriteStore(this.file,{version:1,strategy:PUMP_FADE_STRATEGY,...s})}catch(e){this.log('[PUMP_FADE] 저장 실패',e.message)}}
 #event(type,detail={}){const e={type,at:this.now(),mode:'TESTNET',strategy:PUMP_FADE_STRATEGY,...detail};this.store.events.push(e);this.log(`[PUMP_FADE] ${type} ${detail.symbol||''} ${detail.reason||''}`.trim());try{this.onEvent(e)}catch{}return e}
 #active(){try{return this.active()===true}catch{return false}}
 #gate(){try{return this.gate()||{ok:true}}catch{return {ok:false,reason:'GATE_CLOSED'}}}
 /** Why no new entry may go out now (null = may). */
 #blocked(){
  if(this.config.mode!=='TESTNET')return this.config.refused||'PUMP_FADE_OFF';
  if(!this.client)return 'CREDENTIALS_MISSING';
  if(this.client.mode!=='TESTNET')return 'PUMP_FADE_TESTNET_ONLY';
  if(!this.#active())return 'NOT_ARMED';
  const g=this.#gate();if(!g.ok)return g.reason||'GATE_CLOSED';
  if(this.budget?.stopped(this.funds?.equity))return 'DAILY_LOSS_LIMIT';
  if(this.store.open.some(p=>p.status==='UNKNOWN'))return 'UNRESOLVED_ORDER_STATE';
  return null;
 }
 /** Symbols (and venue symbols) this strategy holds or is entering: the other strategies on the account skip them. */
 heldSymbols(){const s=new Set();for(const sym of this.reserved){s.add(sym);s.add(sym.replace(/USDT$/,'-USDT'))}for(const p of this.store.open){s.add(p.symbol);s.add(p.venueSymbol)}return s}
 idle(){return !this.reconciling&&!this.reserved.size}
 /** One position per symbol across the scalp strategies: our own first, then the others (isBusy). Synchronous. */
 #heldReason(symbol,venueSymbol){
  if(this.store.open.some(p=>p.symbol===symbol)||this.reserved.has(symbol))return 'SYMBOL_ALREADY_HELD';
  let busy=false;try{busy=this.isBusy(symbol,venueSymbol)===true}catch{busy=true}
  return busy?'SYMBOL_HELD_BY_OTHER_STRATEGY':null;
 }
 #remember(w,patch){
  const base={key:w.key,symbol:w.symbol,dir:w.dir,direction:w.direction,at:w.at,receivedAt:w.receivedAt??null,alertPct:w.alert?.pct??null};
  let rec=w.key?this.store.alerts.find(x=>x.key===w.key&&x.at===w.at&&x.symbol===w.symbol):null;
  if(!rec){rec={...base};this.store.alerts.push(rec)}
  Object.assign(rec,patch,{updatedAt:this.now()});
  return rec;
 }
 /** A final (or interim) decision for an alert: kept in the store and handed to the alert record (PumpAlertBook.attachFade). */
 #decide(w,result,{final=true}={}){
  const r={entered:result.entered===true,reason:result.entered?null:result.reason??null,...(result.detail?{detail:String(result.detail).slice(0,160)}:{}),...(result.queued?{queued:true}:{}),
   ...(w.confirm?{confirm:w.confirm}:{}),...(w.turn?{turnAt:w.turn.closeAt,turnMinutes:w.turn.minutes}:{}),...(result.id?{tradeId:result.id}:{})};
  this.#remember(w,{status:r.entered?'ENTERED':r.queued?'WAITING':'SKIPPED',...r});
  if(!r.entered&&!r.queued){this.store.skipCounts[r.reason]=(this.store.skipCounts[r.reason]||0)+1;this.store.skips.push({at:this.now(),symbol:w.symbol,direction:w.direction,reason:r.reason,...(r.detail?{detail:r.detail}:{})})}
  if(final&&this.watches.get(w.symbol)===w)this.watches.delete(w.symbol);
  this.#save();
  if(w.key&&typeof this.onResult==='function')try{this.onResult(w.key,r)}catch{}
  return r;
 }
 /** A 공습경보 alert ({symbol, dir, pct, low, high, price, at, key}). Returns the first decision: a skip, or
  * {queued:true, reason:'PUMP_FADE_WAITING'} while the 1m confirmation and the opposite candle are awaited (tick()). */
 async onAlert(alert){
  const now=this.now(),symbol=String(alert?.symbol||'').toUpperCase(),dir=alert?.dir==='DOWN'?'DOWN':alert?.dir==='UP'?'UP':null;
  const atIn=Number(alert?.at),at=Number.isFinite(atIn)&&atIn>0?Math.min(atIn,now):now;
  const w={key:typeof alert?.key==='string'?alert.key.slice(0,100):null,symbol,dir,direction:dir==='DOWN'?'LONG':dir==='UP'?'SHORT':null,at,receivedAt:now,m0:Math.floor(at/M)*M,phase:'CONFIRM',
   alert:{at,dir,pct:num(alert?.pct),low:num(alert?.low),high:num(alert?.high),price:num(alert?.price),ticks:num(alert?.ticks)}};
  const skip=(reason,detail=null)=>this.#decide(w,{entered:false,reason,detail});
  if(this.config.mode!=='TESTNET')return skip(this.config.refused||'PUMP_FADE_OFF');
  if(!this.client)return skip('CREDENTIALS_MISSING');
  if(this.client.mode!=='TESTNET')return skip('PUMP_FADE_TESTNET_ONLY');
  if(!/^[A-Z0-9]{1,30}USDT$/.test(symbol)||!dir)return skip('PUMP_ALERT_INVALID');
  if(!this.#active())return skip('NOT_ARMED');
  {const g=this.#gate();if(!g.ok)return skip(g.reason||'GATE_CLOSED')}
  if(now-at>this.config.maxAgeSec*1000)return skip('PUMP_FADE_STALE',`${Math.round((now-at)/1000)}초`);
  // BingX must list it as an ordinary USDT perpetual (stock / fx 'NC*' contracts are not traded, as the scalp's).
  const c=(await Promise.resolve().then(()=>this.contracts(symbol)).catch(()=>null))?.get?.(symbol),vs=String(c?.venueSymbol||'');
  if(!c?.tradable||!/^[A-Z0-9]{1,20}-USDT$/.test(vs)||vs.startsWith('NC'))return skip('PUMP_NOT_ON_BINGX',c?(c.tradable?vs:'거래 중지'):'목록에 없음');
  w.venueSymbol=vs;w.contract=c;
  if(this.watches.has(symbol))return skip('PUMP_FADE_ALREADY_WATCHING');
  {const held=this.#heldReason(symbol,vs);if(held)return skip(held)}
  this.watches.set(symbol,w);
  return this.#decide(w,{entered:false,queued:true,reason:'PUMP_FADE_WAITING'},{final:false});
 }
 /** Every few seconds: the watched alerts, then the open positions. */
 async tick(){
  if(this.ticking)return;this.ticking=true;
  try{
   for(const w of [...this.watches.values()])await this.#step(w).catch(e=>{this.log('[PUMP_FADE] step',w.symbol,e?.message);if(this.watches.get(w.symbol)===w)this.#decide(w,{entered:false,reason:'ENTRY_SETUP_FAILED',detail:e?.code||e?.message})});
   const now=this.now();
   if(this.client&&!this.reconciling&&(this.store.open.length||this.store.closed.some(x=>!x.journaled))&&now-this.lastReconcileAt>=(this.store.open.length?3000:60000))await this.reconcile();
  }finally{this.ticking=false}
 }
 async #read(w){try{return await this.candles1m(w.symbol,40)}catch(e){w.readError=e?.code||e?.message||'READ_FAILED';return null}}
 async #step(w){
  const now=this.now();
  if(w.phase==='CONFIRM'){
   if(now<w.m0+M+GRACE_MS||now-(w.lastTry||0)<POLL_MS)return;
   w.lastTry=now;
   const rows=await this.#read(w);
   if(!rows){if(now>w.m0+2*M)this.#decide(w,{entered:false,reason:'PUMP_FADE_CANDLES_FAILED',detail:w.readError});return}
   const conf=fadeConfirm(rows,{at:w.at,dir:w.dir,bars:this.config.confirmBars,minMovePct:this.config.minMovePct,now});
   if(conf.reason==='PUMP_FADE_CANDLES_MISSING'){if(now>w.m0+2*M)this.#decide(w,{entered:false,reason:conf.reason,detail:conf.detail});return}
   w.confirm={passed:conf.ok,bars:this.config.confirmBars,movePct:conf.movePct,colours:conf.colours,high:conf.high,low:conf.low,extreme:conf.extreme,range:conf.range,lastClose:conf.lastClose,closeAt:conf.closeAt};
   if(!conf.ok){this.#decide(w,{entered:false,reason:conf.reason,detail:conf.detail});return}
   w.phase='TURN';w.lastTry=0;
  }
  if(w.phase==='TURN'){
   // Read when a candle we have not seen should have closed (once a minute), retried every POLL_MS until it shows.
   const expected=Math.floor((now-GRACE_MS)/M)*M-M,deadline=w.at+this.config.turnWaitMin*M;
   if(w.seenOpen!=null&&w.seenOpen>=expected&&now<=deadline+M)return;
   if(now-(w.lastTry||0)<POLL_MS)return;
   w.lastTry=now;
   const rows=await this.#read(w);
   if(!rows){if(now>deadline+M)this.#decide(w,{entered:false,reason:'PUMP_FADE_CANDLES_FAILED',detail:w.readError});return}
   const turn=fadeTurn(rows,{at:w.at,dir:w.dir,waitMin:this.config.turnWaitMin,now});
   // Nothing after the alert's minute yet: wait for the next close instead of polling.
   w.seenOpen=turn.lastOpen??Math.max(w.seenOpen??w.m0,w.m0);
   if(turn.found){
    w.turn=turn;
    if(now-turn.closeAt>this.config.turnLateSec*1000){this.#decide(w,{entered:false,reason:'PUMP_FADE_TURN_LATE',detail:`${Math.round((now-turn.closeAt)/1000)}초`});return}
    w.phase='ENTER';
    const r=await this.#enter(w);
    this.#decide(w,r);
    return;
   }
   if(turn.expired)this.#decide(w,{entered:false,reason:'PUMP_FADE_NO_TURN',detail:`${this.config.turnWaitMin}분`});
  }
 }
 async #btcShock(){
  if(typeof this.btcCandles!=='function')return null;
  const rows=await withTimeout(Promise.resolve().then(()=>this.btcCandles()),2500);
  const closed=(Array.isArray(rows)?rows:[]).filter(r=>Number(r?.[6])<this.now()),last=closed.at(-1);if(!last)return null;
  const c1=Number(last[4]),o1=Number(last[1]),o3=Number(closed.length>=3?closed.at(-3)[1]:NaN);
  return {pct5m:o1>0&&c1>0?r2((c1/o1-1)*100):0,pct15m:o3>0&&c1>0?r2((c1/o3-1)*100):0};
 }
 async #funds(){
  const b=await Promise.resolve().then(()=>this.balance()).catch(()=>null),eq=pos(b?.equity);if(!eq)return null;
  const a=num(b.available);this.funds={equity:eq,available:a===null?null:Math.max(0,a),at:this.now()};return this.funds;
 }
 #position(rows,p){return positionOf(rows,p.venueSymbol,p.direction,p.hedge===true)}
 /** Mode B entry at the opposite candle's close. Returns {entered:true, id} or a skip {entered:false, reason, detail}. */
 async #enter(w){
  const skip=(reason,detail=null)=>({entered:false,reason,detail});
  {const why=this.#blocked();if(why)return skip(why)}
  // One per symbol: checked and reserved with no await in between (the scalp sees the reservation through heldSymbols).
  {const held=this.#heldReason(w.symbol,w.venueSymbol);if(held)return skip(held)}
  this.reserved.add(w.symbol);
  const cl=this.client,vs=w.venueSymbol,d=w.direction,c=w.contract;
  try{
   const shock=await this.#btcShock();
   if(shock){
    if(d==='LONG'&&(shock.pct5m<=-SCALP_BTC_GUARD_5M_PCT||shock.pct15m<=-SCALP_BTC_GUARD_15M_PCT))return skip('BTC_DUMP_GUARD',`BTC 5m ${shock.pct5m}% · 15m ${shock.pct15m}%`);
    if(d==='SHORT'&&(shock.pct5m>=SCALP_BTC_GUARD_5M_PCT||shock.pct15m>=SCALP_BTC_GUARD_15M_PCT))return skip('BTC_PUMP_GUARD',`BTC 5m +${shock.pct5m}% · 15m +${shock.pct15m}%`);
   }
   const funds=await this.#funds();if(!funds)return skip('NO_BALANCE');
   let lev=this.config.leverage;
   try{const info=await cl.leverage(vs),max=Number((d==='SHORT'?info?.maxShortLeverage:info?.maxLongLeverage)??info?.maxLeverage);if(max>0)lev=Math.min(lev,Math.floor(max))}catch{}
   const entryRef=w.turn.close,rules=this.rules(),takerRate=Math.max(Number(c.takerFeeRate)||0,SCALP_EXEC_COSTS.takerRate);
   const plan=fadeLevels({direction:d,entry:entryRef,range:w.confirm.range,extreme:w.confirm.extreme,tick:c.tickSize,rules});
   if(!plan.ok)return skip(plan.reason);
   const size=fadeSize({equity:funds.equity,available:funds.available,entry:entryRef,stop:plan.stop,leverage:lev,riskPct:this.config.riskPct,maxMarginPct:this.config.maxMarginPct,takerRate,contract:c});
   if(!size.ok)return skip(size.reason,size.detail);
   if(this.budget){const b=this.budget.check({equity:funds.equity,newRiskUSD:size.riskUSD,newMarginUSD:size.marginUSD,who:'pumpFade'});if(!b.ok)return skip(b.reason,b.detail)}
   const mode=await readPositionMode(cl);if(!mode.ok)return skip(mode.reason,mode.detail);
   const hedge=mode.hedge;
   {let rows;try{rows=await cl.positions(vs)}catch(e){return skip('POSITION_CHECK_FAILED',e?.code||e?.message)}
    const now=positionOf(rows,vs,d,hedge);if(now.any>0)return skip('VENUE_POSITION_EXISTS',`${now.signed}`)}
   try{
    const m=await cl.marginType(vs).catch(()=>null);
    if(m?.marginType!=='CROSSED'){await cl.setMarginType(vs,'CROSSED');const again=await cl.marginType(vs);if(again?.marginType!=='CROSSED')throw err('CROSS_NOT_CONFIRMED')}
    const set=await cl.setLeverage(vs,leverageSideFor({hedge,direction:d}),lev);
    if(set?.leverage!==undefined&&Number(set.leverage)!==lev)throw err('LEVERAGE_NOT_CONFIRMED');
   }catch(e){return skip('MARGIN_SETUP_FAILED',e?.code||e?.message)}
   const beforeSend=()=>{const why=this.#blocked();if(why)return why;const b=this.budget?.check({equity:funds.equity,who:'pumpFade'});return b&&!b.ok?b.reason:null};
   {const why=beforeSend();if(why)return skip(why)}
   const id=pumpFadeClientId(w.symbol,w.at,d);
   const p={id,strategy:PUMP_FADE_STRATEGY,strategyProfile:PUMP_FADE_STRATEGY,kind:PUMP_FADE_STRATEGY,trigger:'PUMP_ALERT',management:PUMP_FADE_STRATEGY,mode:'TESTNET',venue:'BINGX',
    symbol:w.symbol,venueSymbol:vs,direction:d,hedge,interval:'1m',entryMode:'B',
    pumpAlert:{key:w.key,...w.alert},confirm:w.confirm,turn:{at:w.turn.closeAt,minutes:w.turn.minutes,close:w.turn.close,bar:w.turn.bar},
    plannedEntry:entryRef,plan:{...plan,qty:size.qty,riskUSD:size.riskUSD,marginUSD:size.marginUSD,capped:size.capped,leverage:lev,riskPct:this.config.riskPct,maxMarginPct:this.config.maxMarginPct},
    rules,qty:size.qty,leverage:lev,tickSize:c.tickSize,quantityStep:c.quantityStep,takerRate,capitalBasisUSD:funds.equity,
    status:'SUBMITTING',createdAt:this.now(),avg:null,size:0,filled:0,stopOrderId:null,tpOrderId:null,exitIds:[],tpTries:0,stopTries:0};
   this.store.open.push(p);this.#save();
   let fill,executionMode='MARKET';
   try{
    if(this.config.makerWaitMs>0){
     const exec=await placeMakerThenMarket({client:cl,symbol:vs,side:openSide(d),positionSide:positionSideFor({hedge,direction:d}),quantity:size.qty,quantityStep:c.quantityStep,
      minQuantity:c.minQuantityBase,tickSize:c.tickSize,markPrice:entryRef,hedge,clientOrderId:id,waitMs:Math.min(5000,this.config.makerWaitMs),pollMs:400,beforeSend});
     fill=exec.receipt||{orderId:exec.orderId,executedQty:String(exec.filledQty),avgPrice:exec.avg!=null?String(exec.avg):undefined};executionMode=exec.executionMode||'MARKET';
    }else fill=await cl.placeOrder({symbol:vs,side:openSide(d),positionSide:positionSideFor({hedge,direction:d}),type:'MARKET',quantity:String(size.qty),clientOrderId:id},{beforeSend});
   }catch(e){
    if(e?.code==='ENTRY_NOT_SENT'){this.store.open=this.store.open.filter(x=>x!==p);this.#save();return skip(e.reason)}
    let found=null;try{found=await cl.getOrder(vs,{clientOrderId:id})}catch{}
    if(!orderId(found)){
     if(e?.code==='NETWORK_UNREACHABLE'||e?.code==='HTTP_429'||e?.code==='MAKER_STATE_UNCONFIRMED'||/^HTTP_5\d\d$/.test(String(e?.code||''))){
      p.status='UNKNOWN';this.#event('ENTRY_OUTCOME_UNKNOWN',{symbol:p.symbol,direction:d,reason:e.code});this.#save();return skip('UNKNOWN')}
     this.store.open=this.store.open.filter(x=>x!==p);this.#save();return skip('ENTRY_REJECTED',e?.code||e?.message);
    }
    fill=found;
   }
   p.entryOrderId=orderId(fill);p.executionMode=executionMode;
   let now;try{now=this.#position(await cl.positions(vs),p)}catch{now={size:0}}
   const qty=pos(now.size)??pos(orderOf(fill)?.executedQty),avg=pos(now.avg)??pos(orderOf(fill)?.avgPrice);
   if(!qty||!avg){p.status='UNKNOWN';this.#event('ENTRY_OUTCOME_UNKNOWN',{symbol:p.symbol,direction:d,reason:'ENTRY_FILL_UNCONFIRMED'});this.#save();return skip('UNKNOWN')}
   this.#opened(p,qty,avg);
   await this.#protect(p);
   if(p.status!=='OPEN')return {entered:true,id,closedAtOnce:true};
   this.#event('OPENED',{symbol:p.symbol,direction:d,id:p.id,entry:p.avg,stop:p.stop,tp:p.tp,tpPct:p.levels.tpPct,stopPct:p.levels.stopPct,slPct:p.levels.slPct,stopBasis:p.levels.stopBasis,rangePct:p.levels.rangePct,
    qty:p.filled,leverage:p.leverage,riskUSD:p.riskUSD,marginUSD:p.marginUSD,maxHoldMin:p.rules.maxHoldMin,executionMode,alertDir:w.dir,alertPct:w.alert.pct,turnMinutes:w.turn.minutes,confirm:{bars:w.confirm.bars,movePct:w.confirm.movePct}});
   this.#save();return {entered:true,id};
  }catch(e){return skip(e?.code==='HTTP_429'?'HTTP_429':'ENTRY_SETUP_FAILED',e?.code||e?.message)}
  finally{this.reserved.delete(w.symbol)}
 }
 /** The fill is known: TP / SL from the actual average (the rules do not depend on the order's own price). */
 #opened(p,qty,avg){
  const lv=fadeLevels({direction:p.direction,entry:avg,range:p.confirm.range,extreme:p.confirm.extreme,tick:p.tickSize,rules:p.rules});
  const levels=lv.ok?lv:fadeLevels({direction:p.direction,entry:avg,range:p.confirm.range,extreme:null,tick:p.tickSize,rules:p.rules});
  Object.assign(p,{status:'OPEN',openedAt:p.openedAt??this.now(),filled:qty,size:qty,avg,firstEntryPrice:avg,levels,stop:levels.stop,tp:levels.tp,deadline:(p.openedAt??this.now())+p.rules.maxHoldMin*M,
   riskUSD:r4(qty*(Math.abs(avg-levels.stop)+(avg+levels.stop)*p.takerRate)),marginUSD:r4(qty*avg/p.leverage),mfePct:0,maePct:0});
  this.#save();
 }
 #stopParams(p,tag){return {symbol:p.venueSymbol,side:closeSide(p.direction),positionSide:positionSideFor({hedge:p.hedge===true,direction:p.direction}),type:'STOP_MARKET',quantity:String(p.size),
  stopPrice:grid(+Number(p.stop).toFixed(10),p.tickSize,awayMode(p.direction))??String(p.stop),closePosition:'true',workingType:'MARK_PRICE',clientOrderId:(p.id+tag).slice(0,40)}}
 #tpParams(p,tag){return forMode({symbol:p.venueSymbol,side:closeSide(p.direction),positionSide:positionSideFor({hedge:p.hedge===true,direction:p.direction}),type:'LIMIT',timeInForce:'GTC',
  quantity:grid(p.size,p.quantityStep,'DOWN')??String(p.size),price:grid(+Number(p.tp).toFixed(10),p.tickSize,tpMode(p.direction))??String(p.tp),reduceOnly:'true',clientOrderId:(p.id+tag).slice(0,40)},p.hedge===true)}
 /** The exchange stop (survives a restart), then the reduce-only target. No stop -> the position is closed at once. */
 async #protect(p){
  if(!p.stopOrderId){
   p.stopTries=(p.stopTries||0)+1;
   try{const s=await this.client.placeOrder(this.#stopParams(p,'s'+(p.stopTries>1?p.stopTries:'')));p.stopOrderId=orderId(s);if(!p.stopOrderId)throw err('NO_STOP')}
   catch(e){this.#event('STOP_FAILED',{symbol:p.symbol,direction:p.direction,reason:e?.code||e?.message});await this.#exit(p,'e','NO_STOP');return false}
   this.#save();
  }
  await this.#placeTarget(p);
  return true;
 }
 async #placeTarget(p){
  if(p.tpOrderId||(p.tpTries||0)>=3||!(p.size>0))return;
  p.tpTries=(p.tpTries||0)+1;
  try{const o=await this.client.placeOrder(this.#tpParams(p,'t'+(p.tpTries>1?p.tpTries:'')));p.tpOrderId=orderId(o)}
  catch(e){this.#event('TARGET_FAILED',{symbol:p.symbol,direction:p.direction,reason:e?.code||e?.message})}
  this.#save();
 }
 /** Market reduce-only close of the remaining size; finished when flat. */
 async #exit(p,tag,reason){
  p.exitTries=(p.exitTries||0)+1;p.exitReason=p.exitReason||reason;this.#save();
  let left=p.size;
  try{
   const rows=await this.client.positions(p.venueSymbol);const now=this.#position(rows,p);left=now.size;
   if(left>0){const o=await this.client.placeOrder(forMode({symbol:p.venueSymbol,side:closeSide(p.direction),positionSide:positionSideFor({hedge:p.hedge===true,direction:p.direction}),type:'MARKET',quantity:String(left),reduceOnly:'true',clientOrderId:(p.id+tag+p.exitTries).slice(0,40)},p.hedge===true));
    const id=orderId(o);if(id)p.exitIds.push(id);if(pos(orderOf(o)?.executedQty)>=left-1e-12)left=0}
  }catch(e){this.#event('EMERGENCY_CLOSE_FAILED',{symbol:p.symbol,direction:p.direction,reason:e?.code||e?.message});return false}
  if(!(left>0))await this.#finish(p);
  return true;
 }
 async reconcile(){
  if(this.reconciling||!this.client)return;this.reconciling=true;this.lastReconcileAt=this.now();
  try{
   let list=null;
   if(this.store.open.length){try{list=await this.client.positions()}catch(e){this.#event('RECONCILE_ERROR',{reason:e?.code||e?.message});return}}
   for(const p of [...this.store.open]){
    if(p.status==='SUBMITTING'||p.status==='CLOSED'||this.reserved.has(p.symbol))continue;
    try{
     const {size,row,other}=this.#position(list,p);
     if(other>0)p.otherSideSeen=true;
     if(p.status==='UNKNOWN'){
      if(size>0){this.#opened(p,size,pos(row?.avgPrice)??p.plannedEntry);this.#event('ENTRY_RECOVERED',{symbol:p.symbol,qty:size});await this.#protect(p)}
      else if((p.zeroSeen=(p.zeroSeen||0)+1)>=2){this.store.open=this.store.open.filter(x=>x!==p);this.#event('ENTRY_NOT_FILLED',{symbol:p.symbol})}
      continue;
     }
     if(!(size>0)){if((p.zeroSeen=(p.zeroSeen||0)+1)>=2)await this.#finish(p);continue}
     p.zeroSeen=0;
     if(size<p.size-1e-12)p.everReduced=true;
     p.size=size;const mark=pos(row?.markPrice);if(mark){p.mark=mark;const e=dirOf(p.direction)*(mark/p.avg-1)*100;p.mfePct=r4(Math.max(p.mfePct||0,e));p.maePct=r4(Math.max(p.maePct||0,-e))}
     p.unrealized=num(row?.unrealizedProfit)??(mark?dirOf(p.direction)*(mark-p.avg)*size:null);
     if(!p.stopOrderId){if(!await this.#protect(p))continue}
     if(this.now()>=p.deadline){await this.#exit(p,'x','PUMP_FADE_TIME');continue}
     // Monitored target: the limit order is missing (placement failed) and the mark is at or beyond it.
     if(!p.tpOrderId&&mark&&dirOf(p.direction)*(mark-p.tp)>=0){await this.#exit(p,'k','PUMP_FADE_TP');continue}
     if(!p.tpOrderId)await this.#placeTarget(p);
    }catch(e){this.#event('RECONCILE_ERROR',{symbol:p.symbol,reason:e?.code||e?.message})}
   }
   for(const x of this.store.closed.filter(x=>!x.realized&&!x.otherSideSeen&&(x.settleTries||0)<SETTLE_TRIES&&this.now()-x.closedAt>=SETTLE_DELAY_MS&&this.now()-x.closedAt<2*3600000))await this.#settle(x).catch(()=>{});
   this.#flushJournal();
  }finally{this.reconciling=false;this.#save()}
 }
 /** Flat: the leftover stop / target cancelled, fills read, the reason and the estimated result booked. */
 async #finish(p){
  const cl=this.client,vs=p.venueSymbol;
  for(const id of [p.stopOrderId,p.tpOrderId].filter(Boolean)){try{await cl.cancelOrder(vs,id)}catch{}}
  const fills=[];
  for(const [kind,id] of [['STOP',p.stopOrderId],['TP',p.tpOrderId],...p.exitIds.map(id=>['MARKET',id])]){if(!id)continue;
   try{const o=orderOf(await cl.getOrder(vs,{orderId:id})),q=pos(o?.executedQty),price=pos(o?.avgPrice);if(q&&price)fills.push({kind,id,qty:q,price})}catch{}}
  const stopHit=fills.some(f=>f.kind==='STOP'),tpHit=fills.some(f=>f.kind==='TP');
  const reason=stopHit?'PUMP_FADE_SL':tpHit&&!p.exitReason?'PUMP_FADE_TP':p.exitReason||(tpHit?'PUMP_FADE_TP':'EXTERNAL');
  const d=dirOf(p.direction);
  let out=fills.reduce((t,f)=>t+f.qty,0),gross=fills.reduce((t,f)=>t+d*(f.price-p.avg)*f.qty,0),exitNotional=fills.reduce((t,f)=>t+f.price*f.qty,0);
  const rest=Math.max(0,p.filled-out);if(rest>1e-12){const px=reason==='PUMP_FADE_SL'?p.stop:reason==='PUMP_FADE_TP'?p.tp:pos(p.mark)??p.avg;gross+=d*(px-p.avg)*rest;exitNotional+=px*rest}
  const fee=(p.avg*p.filled+exitNotional)*(p.takerRate||SCALP_EXEC_COSTS.takerRate);
  p.status='CLOSED';p.closedAt=this.now();p.closeReason=reason;
  const net=r4(gross-fee),row={...p,exitFills:fills.map(({kind,price,qty})=>({kind,price,qty})),estimate:{source:'ESTIMATE',pnlUSD:r4(gross),feeUSD:r4(-fee),netUSD:net},netUSD:net,
   netSource:p.otherSideSeen?'ESTIMATE_OTHER_SIDE':'ESTIMATE',holdMs:p.closedAt-(p.openedAt||p.createdAt),rMultiple:p.riskUSD>0?r4(net/p.riskUSD):null};
  this.store.closed.push(row);this.store.open=this.store.open.filter(x=>x!==p);
  this.#event('CLOSED',{symbol:p.symbol,direction:p.direction,id:p.id,reason,netUSD:net,holdMs:row.holdMs,entry:p.avg});
  this.#save();
 }
 /** BingX fund flow (realized PnL + fees + funding) of the symbol over the trade's life, read after the close. */
 async #settle(x){
  if(typeof this.client.income!=='function'||x.otherSideSeen)return;
  const from=(x.createdAt||x.closedAt)-30000,to=Math.min(this.now(),x.closedAt+120000);
  const data=await this.client.income({symbol:x.venueSymbol,startTime:from,endTime:to,limit:1000}),list=Array.isArray(data)?data:Array.isArray(data?.list)?data.list:[];
  x.settleTries=(x.settleTries||0)+1;
  const rows=list.filter(y=>y?.symbol===x.venueSymbol&&Number(y.time)>=from&&Number(y.time)<=to);
  if(!rows.some(y=>y.incomeType==='REALIZED_PNL'))return;
  const sum=t=>rows.filter(y=>y.incomeType===t).reduce((s,y)=>s+(Number(y.income)||0),0);
  x.realized={source:'EXCHANGE',pnlUSD:r4(sum('REALIZED_PNL')),feeUSD:r4(sum('TRADING_FEE')),fundingUSD:r4(sum('FUNDING_FEE'))};x.realized.netUSD=r4(x.realized.pnlUSD+x.realized.feeUSD+x.realized.fundingUSD);
  x.netUSD=x.realized.netUSD;x.netSource='EXCHANGE';
 }
 /** Final results go to the shared scalp journal (one line, strategy PUMP_FADE). */
 #flushJournal(){
  const income=typeof this.client?.income==='function';
  for(const x of this.store.closed){
   if(x.journaled)continue;
   if(!(x.realized||!income||x.otherSideSeen||(x.settleTries||0)>=SETTLE_TRIES||this.now()-(x.closedAt||0)>=2*3600000))continue;
   if(this.journalIds.has(x.id)){x.journaled=true;continue}
   const line=pumpFadeJournalLine({...x,journalAt:this.now()});
   if(this.journalFile&&!appendJsonl(this.journalFile,line))continue;
   x.journaled=true;this.journalIds.add(x.id);
   this.journalRows.push({id:x.id,direction:x.direction,netUSD:line.pnl.netUSD,openedAt:x.openedAt??null,closedAt:x.closedAt,closeReason:x.closeReason});
  }
 }
 #rows(){return [...this.journalRows,...this.store.closed.filter(x=>!x.journaled)]}
 /** Win rate / PF / net over every PUMP_FADE trade, and by side and exit reason. */
 stats(){
  const list=this.#rows(),one=l=>{const nets=l.map(x=>Number(x.netUSD)||0),wins=nets.filter(v=>v>0),gross=wins.reduce((a,b)=>a+b,0),loss=-nets.filter(v=>v<0).reduce((a,b)=>a+b,0),today=kstDay(this.now());
   return {trades:l.length,wins:wins.length,grossProfitUSD:+gross.toFixed(2),grossLossUSD:+loss.toFixed(2),winRatePct:l.length?+(wins.length/l.length*100).toFixed(1):null,profitFactor:loss>0?+(gross/loss).toFixed(2):null,
    netUSD:+nets.reduce((a,b)=>a+b,0).toFixed(2),todayNetUSD:+l.filter(x=>kstDay(x.closedAt)===today).reduce((a,x)=>a+(Number(x.netUSD)||0),0).toFixed(2)}};
  const all=one(list);all.bySide={LONG:one(list.filter(x=>x.direction==='LONG')),SHORT:one(list.filter(x=>x.direction==='SHORT'))};
  all.byExitReason={};for(const x of list)(all.byExitReason[x.closeReason]??=[]).push(x);
  all.byExitReason=Object.fromEntries(Object.entries(all.byExitReason).map(([k,v])=>[k,one(v)]));
  return all;
 }
 /** For 실계좌 준비 점검 (ready_check.mjs group PUMP_FADE_SCALP). */
 readinessRows(){return this.#rows().map(x=>({direction:x.direction||'LONG',netUSD:Number(x.netUSD)||0,closedAt:x.closedAt??null,openedAt:x.openedAt??null,closeReason:x.closeReason??null}))}
 /** Getters for the shared TESTNET budget (testnet_budget.mjs register('pumpFade', ...)). */
 budgetSource(){
  return {realizedToday:day=>this.store.closed.filter(x=>kstDay(x.closedAt)===day).reduce((t,x)=>t+(Number(x.netUSD)||0),0),
   openRisk:()=>this.store.open.reduce((t,p)=>t+(Number(p.riskUSD)||Number(p.plan?.riskUSD)||0),0),
   usedMargin:()=>this.store.open.reduce((t,p)=>t+(Number(p.marginUSD)||Number(p.plan?.marginUSD)||0),0),
   unrealized:()=>this.store.open.reduce((t,p)=>t+(Number(p.unrealized)||0),0)};
 }
 resetHistory(){const removed=this.store.closed.length;Object.assign(this.store,{closed:[],events:[],skips:[],skipCounts:{},alerts:[]});this.journalRows=[];this.journalIds=new Set();this.#save();return {removed}}
 /** The screen block and the report: switch, open positions, recent alerts with their decision, stats. */
 status(){
  const c=this.config;
  return {strategy:PUMP_FADE_STRATEGY,mode:c.mode,refused:c.refused,on:c.mode==='TESTNET'&&Boolean(this.client)&&this.#active(),armed:this.#active(),credentials:Boolean(this.client),blocked:this.#blocked(),
   settings:{pumpFadeMaxAgeSec:c.maxAgeSec,pumpFadeConfirmBars:c.confirmBars,pumpFadeMinMovePct:c.minMovePct,pumpFadeTurnWaitMin:c.turnWaitMin,pumpFadeTurnLateSec:c.turnLateSec,
    pumpFadeTpMinPct:c.tpMinPct,pumpFadeTpRangeMult:c.tpRangeMult,pumpFadeSlMinPct:c.slMinPct,pumpFadeSlRangeMult:c.slRangeMult,pumpFadeMinStopPct:c.minStopPct,pumpFadeMaxHoldMin:c.maxHoldMin,
    pumpFadeRiskPct:c.riskPct,pumpFadeLeverage:c.leverage,pumpFadeMaxMarginPct:c.maxMarginPct,pumpFadeMakerWaitMs:c.makerWaitMs,pumpFadeCostPct:c.costPct},
   watching:[...this.watches.values()].map(w=>({symbol:w.symbol,direction:w.direction,at:w.at,phase:w.phase})),
   positions:this.store.open.map(p=>({id:p.id,symbol:p.symbol,direction:p.direction,status:p.status,entry:p.avg,stop:p.stop,tp:p.tp,size:p.size,leverage:p.leverage,openedAt:p.openedAt??null,deadline:p.deadline??null,
    mark:p.mark??null,unrealized:p.unrealized??null,stopBasis:p.levels?.stopBasis??null,tpPct:p.levels?.tpPct??null,stopPct:p.levels?.stopPct??null,rangePct:p.levels?.rangePct??null,riskUSD:p.riskUSD??null,marginUSD:p.marginUSD??null})),
   closed:this.store.closed.slice(-100).reverse().map(x=>({id:x.id,symbol:x.symbol,direction:x.direction,openedAt:x.openedAt??x.createdAt,closedAt:x.closedAt,closeReason:x.closeReason,closeReasonKo:reasonLabel(x.closeReason),
    netUSD:x.netUSD,netSource:x.netSource,leverage:x.leverage,margin:{initialUSD:x.marginUSD??null,addedUSD:0,totalUSD:x.marginUSD??null},capitalBasisUSD:x.capitalBasisUSD??null,initialRiskUSD:x.riskUSD??null})),
   alerts:this.store.alerts.slice(-20).reverse(),stats:this.stats(),skipCounts:{...this.store.skipCounts},events:this.store.events.slice(-20).reverse(),funds:this.funds};
 }
}

/** One journal line of a finished PUMP_FADE trade (scalp-journal.jsonl, strategy PUMP_FADE). */
export function pumpFadeJournalLine(x){
 const net=x.realized?.netUSD??x.netUSD??null;
 return {v:1,strategy:PUMP_FADE_STRATEGY,kind:PUMP_FADE_STRATEGY,trigger:'PUMP_ALERT',management:PUMP_FADE_STRATEGY,entryMode:x.entryMode||'B',id:x.id,symbol:x.symbol,venueSymbol:x.venueSymbol,direction:x.direction,interval:'1m',mode:x.mode,
  capitalBasisUSD:pos(x.capitalBasisUSD),pumpAlert:x.pumpAlert??null,confirm:x.confirm??null,turn:x.turn??null,rules:x.rules??null,
  plan:{signalClose:x.plannedEntry??null,entry:x.avg,stop:x.stop,tp:x.tp,tpPct:x.levels?.tpPct??null,slPct:x.levels?.slPct??null,stopPct:x.levels?.stopPct??null,stopBasis:x.levels?.stopBasis??null,
   rangePct:x.levels?.rangePct??null,riskUSD:r4(Number(x.riskUSD)),marginUSD:r4(Number(x.marginUSD)),capped:x.plan?.capped??null},
  entry:{at:x.openedAt??null,price:x.avg,qty:x.filled,leverage:x.leverage,executionMode:x.executionMode??null,delayMs:x.openedAt&&x.turn?.at?x.openedAt-x.turn.at:null},
  margin:{initialUSD:r4(Number(x.marginUSD)),addedUSD:0,totalUSD:r4(Number(x.marginUSD))},
  exit:{reason:x.closeReason,at:x.closedAt,holdMin:x.closedAt&&x.openedAt?r2((x.closedAt-x.openedAt)/60000):null,fills:x.exitFills??null},
  excursion:{mfePct:x.mfePct??null,maePct:x.maePct??null},
  pnl:{estimate:x.estimate??null,realized:x.realized??null,netUSD:net,netSource:x.realized?'EXCHANGE':'ESTIMATE',feeUSD:x.realized?.feeUSD??x.estimate?.feeUSD??null,riskUSDActual:r4(Number(x.riskUSD)),r:Number(x.riskUSD)>0&&Number.isFinite(Number(net))?r4(Number(net)/Number(x.riskUSD)):null},
  writtenAt:x.journalAt??null};
}
