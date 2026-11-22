// 되돌림 단타 (5m "급락 후 반등" LONG and, user 2026-11-16 16:58, "급등 후 되돌림" SHORT) on the BingX TESTNET only
// (user 2026-11-14 22:29, start 2026-11-16).
// Its own ledger (scalp-store.json), strategy tag SCALP_REVERSAL, never mixed into the signal strategy.
//
//  - Detection = scalp_reversal.mjs on the 60 last CLOSED 5m candles (BingX public klines), settings
//    SCALP_EXEC_SETTINGS (move 5 %, 38.2/50/61.8 % targets, stop 0.25 ATR, climax 3x), both sides with the same
//    settings (SCALP_EXEC_SIDES=LONG,SHORT turns one off), 4H trend filter (no rebound LONG in a 4H downtrend,
//    no fade SHORT in a 4H uptrend) and TP1 net-of-costs >= 1R, as backtestScalp. Every price, side and PnL
//    below goes through dir (+1 LONG / -1 SHORT); stops are rounded away from the entry, targets toward it.
//  - Entry right after the close (= the backtest's next-candle open): market, with the stop attached,
//    only when the BingX price is still within maxDriftPct / maxDriftAtr of the planned entry.
//  - Exits as simulateTrade: reduce-only take-profits 40/35/25 % at the targets (parts below the venue
//    minimum merged into the earlier target), stop to the entry price after TP1, market close at
//    entry + maxHoldMs (2 h).
//  - Size: equity x riskPct (0.5 %) at the stop, margin capped; no position-count cap by default on testnet (user 2026-11-16; SCALP_MAX_OPEN>0 sets one), one per symbol,
//    none on a symbol the signal strategy or copy holds on the same account.
//  - LIVE is refused: the mode is OFF or TESTNET, and the client must be a TESTNET client. Starts disarmed.
//  - 매물대 반전 (user 2026-11-17 23:12 "1번 진행", backtest candidate B): when the 5 % rule finds nothing on a closed
//    candle, the same detection at 2.5 % whose extreme lies in or within 0.3 % of a 4H / 1D volume zone (backtest.mjs
//    zoneBook / zoneTouches / zoneTagFields, zones from candles closed before the move window) is traded with every other
//    rule unchanged (kind ZONE_REVERSAL; the 5 % ones are MOVE_REVERSAL). SCALP_ZONE_SIGNALS=off turns it off.
//  - Shared kill switch: no new entries. Daily loss limit (3 % of equity, realized today + open) disarms; with the shared
//    TESTNET budget (testnet_budget.mjs) the limit is TESTNET_DAILY_LOSS_PCT over both strategies and only blocks entries.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {atomicWriteStore,readStore} from './persistence.mjs';
import {roundDecimalToStep} from './decimal_grid.mjs';
import {scalpReasonKo} from './scalp_telegram.mjs';
import {livePositionView} from './live_overview.mjs';
import {appendJsonl,readJsonl,tailJsonl,candleShape,trackExcursion,journalLine,scalpMargin,signalsPath,SCALP_JOURNAL_FILE,SCALP_SIGNALS_FILE,SIGNALS_MAX_BYTES} from './scalp_journal.mjs';
import {readPositionMode,leverageSideFor,positionSideFor,forMode,positionRow,orderOnSide,otherSideAmount} from './bingx_position_mode.mjs';
import {detectScalpReversal,buildScalpPlan,SCALP_DEFAULTS,SCALP_TIMEFRAMES,fourHourTrend,trendAllows} from './scalp_reversal.mjs';
import {closedScalpBars,observeScalpStructure,WYCKOFF_CANDLES,WYCKOFF_INTERVAL_MS} from './scalp_wyckoff.mjs';
import {vsaStatus} from './scalp_vsa.mjs';
import {aiLensHigherTimeframe,aiLensRiskMap,aiLensStatus,LENS_HIGHER_INTERVAL_MS} from './scalp_ai_lens.mjs';
import {zoneBook,zoneTouches,zoneTagFields,zoneSpanMs,ZONE_PROFILES,ZONE_TOUCH_PCT} from './backtest.mjs';

export const SCALP_EXEC_STRATEGY='SCALP_REVERSAL';
export const SCALP_EXEC_MODES=Object.freeze(['OFF','TESTNET']);
// User 2026-11-20: move = 3.5 % (lowered from 5 % to capture 4~5+ daily climax setups while keeping 4x ATR, 3x volume, RSI 25/75, 50% wick).
export const SCALP_EXEC_SETTINGS=Object.freeze({minMovePct:3.5,retracements:Object.freeze([.382,.5,.618]),stopAtr:.25,climaxVolume:3});
// The backtest's cost assumptions (backtest.mjs BACKTEST_COSTS), the venue's taker fee when higher.
// Signal kinds (journal, screen badge, report): the 3.5 % move rule, and candidate B at a 4H / 1D volume zone.
export const SCALP_KINDS=Object.freeze({MOVE:'MOVE_REVERSAL',ZONE:'ZONE_REVERSAL'});
// Candidate B as in backtestScalp: zoneMinMovePct = the 5m default (2.5 %), touch within ZONE_TOUCH_PCT (0.3 %).
export const SCALP_ZONE_MIN_MOVE_PCT=SCALP_TIMEFRAMES['5m'].minMovePct;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
export const SCALP_EXEC_COSTS=Object.freeze({takerRate:.0006,makerRate:.0002,slippageBps:2,spreadBps:1,fundingRate:.0001,assumption:'EXPLICIT_PAPER_ASSUMPTIONS'});
export const SCALP_SCALE_IN=Object.freeze({version:1,windowBars:6,near:.5,far:.75});
export const SCALP_REPEAT_SCALE_IN=Object.freeze({
 version:2,
 stepR:1.0,
 stepRs:Object.freeze([1.0,2.0,3.5,5.0]),
 qtyMultipliers:Object.freeze([1.0,1.0,1.5,2.0]),
 maxAdds:4,
 slippagePct:0.35,
 minPartialRemainRatio:0.25,
});
const SCREEN_CLOSED=100,I5=SCALP_TIMEFRAMES['5m'].intervalMs,FRACTIONS=[.4,.35,.25],MAX_CLOSED=300,MAX_EVENTS=200,MAX_SKIPS=60,MAX_KEYS=500,SETTLE_DELAY_MS=150000,SETTLE_TRIES=4;
const EARLY_TAKE_PROFIT_MS=45*60000,EARLY_EXIT_RETRY_MS=60000;
const PROFIT_ONLY_EARLY_EXIT_MIN=15,PROFIT_ONLY_RETRY_MS=5000;
export const SCALP_PROFIT_HOLD_TARGET_MIN=60;
export const SCALP_MIN_PROFIT_ROE_PCT=10;
export const SCALP_SCALE_IN_MIN_ROE_PCT=5;
export const SCALP_TRAIL_PULLBACK_RATIO=0.25;
export const SCALP_TRAIL_MIN_PULLBACK_ROE=1.5;
const REVERSAL_RECHECK_MS=30*60000;
const WYCKOFF_SCAN_BUDGET_MS=12_000;
const RECHECK_REASONS=new Set(['PRICE_DRIFT','TP1_NET_RR_BELOW_MINIMUM']);
const num=v=>{const n=Number(v);return Number.isFinite(n)?n:null};
const pos=v=>{const n=Number(v);return Number.isFinite(n)&&n>0?n:null};
const orderOf=d=>d?.order??d;
const r4=x=>Number.isFinite(x)?Math.round(x*1e4)/1e4:null;
/** The touched zone of a ZONE_REVERSAL signal (the nearer one when both touch, 4H on a tie) and both lookups, for the records. */
export function zoneRecord(touches){
 const one=(tf,z)=>z?{tf,atZone:z.atZone,low:z.low??null,high:z.high??null,price:z.price??null,sharePct:r4(z.sharePct),rank:z.rank??null,distPct:r4(z.distPct)}:null;
 const a=one('4h',touches?.['4h']),b=one('1d',touches?.['1d']);
 // The touched one first, then the nearer one (4H on a tie); with none touched, the nearest zone seen.
 const best=[a,b].filter(z=>z&&Number.isFinite(z.distPct)).sort((x,y)=>(y.atZone-x.atZone)||(x.distPct-y.distPct))[0]||null;
 return {...(best||{tf:null,low:null,high:null,price:null,sharePct:null,rank:null,distPct:null}),atZone:zoneTagFields(touches||{}).atZone===true,zone4h:a,zone1d:b};
}
const orderId=d=>{const o=orderOf(d),id=o?.orderId??o?.orderID;return id===undefined||id===null?null:String(id)};
const orderAbsent=e=>/80016/.test(String(e?.code||''))||/not exist/i.test(String(e?.message||''));
const kstDay=t=>new Date(t+9*3600000).toISOString().slice(0,10);
const grid=(v,step,mode)=>{try{return roundDecimalToStep(v,step,mode)}catch{return null}};
const withTimeout=(p,ms,fallback=null)=>Promise.race([Promise.resolve(p).catch(()=>fallback),new Promise(r=>setTimeout(()=>r(fallback),ms).unref?.())]);
const err=(code,status=409)=>Object.assign(Error(code),{code,httpStatus:status});
const dirOf=d=>d==='SHORT'?-1:1;
const POSITION_LIMIT_ERROR='VENUE_ERROR_101429';
// Tick rounding by side: a stop away from the entry (LONG down / SHORT up), a target or a break-even stop
// on the safe side (target toward the entry, break-even at or beyond the entry in the profit direction).
const awayMode=d=>d==='SHORT'?'UP':'DOWN',towardMode=d=>d==='SHORT'?'UP':'DOWN',beMode=d=>d==='SHORT'?'DOWN':'UP';
const openSide=d=>d==='SHORT'?'SELL':'BUY',closeSide=d=>d==='SHORT'?'BUY':'SELL';
function profitLimit(p,lossPerUnit=0,{minNetRoePct=0}={}){
 const dir=dirOf(p.direction),fee=Math.max(p.takerRate||0,SCALP_EXEC_COSTS.takerRate);
 const reserve=(SCALP_EXEC_COSTS.spreadBps+SCALP_EXEC_COSTS.slippageBps)/10000+SCALP_EXEC_COSTS.fundingRate;
 const lev=Math.max(1,Number(p.leverage)||10);
 const netTarget=minNetRoePct>0?(minNetRoePct/100)/lev:0;
 const price=(p.avg*(1+dir*(fee+reserve+netTarget))+dir*lossPerUnit)/(1-dir*fee);
 return price>0?grid(price,p.tickSize,beMode(p.direction)):null;
}
/** One-way position amount, signed (+ long / - short): BingX reports a short as a negative positionAmt;
 * a positionSide LONG / SHORT, when given, decides the sign. */
export function signedAmount(row){
 const amt=Number(row?.positionAmt)||0,side=String(row?.positionSide||'').toUpperCase();
 return side==='LONG'?Math.abs(amt):side==='SHORT'?-Math.abs(amt):amt;
}
export const SCALP_SIDES=Object.freeze(['LONG','SHORT']);
/** SCALP_EXEC_SIDES: LONG,SHORT (default both). Unknown words are ignored; nothing valid = no side. */
export function scalpSides(value){
 if(value===undefined||value===null||String(value).trim()==='')return [...SCALP_SIDES];
 return SCALP_SIDES.filter(x=>String(value).toUpperCase().split(/[\s,]+/).includes(x));
}

export function scalpExecConfig(env=process.env){
 const n=(k,d,lo,hi)=>{const v=Number(env[k]);return env[k]!==undefined&&env[k]!==''&&Number.isFinite(v)&&v>=lo&&v<=hi?v:d};
 // SCALP_EXEC_MODE: OFF | TESTNET (default; still disarmed until the dashboard button). Anything else,
 // LIVE included, is refused and leaves the scalps OFF.
 const raw=String(env.SCALP_EXEC_MODE??'').trim().toUpperCase(),known=raw===''||SCALP_EXEC_MODES.includes(raw);
 const minMovePct=n('SCALP_MIN_MOVE_PCT',SCALP_EXEC_SETTINGS.minMovePct,2.5,15);
 return {mode:known?(raw||'TESTNET'):'OFF',refused:known?null:raw==='LIVE'?'LIVE_REFUSED':'MODE_INVALID',interval:'5m',sides:scalpSides(env.SCALP_EXEC_SIDES),
  settings:{...SCALP_EXEC_SETTINGS,minMovePct,retracements:[...SCALP_EXEC_SETTINGS.retracements]},
  minProfitRoePct:n('SCALP_MIN_PROFIT_ROE_PCT',SCALP_MIN_PROFIT_ROE_PCT,0,100),// TP1 net RR floor (was 0.7 on the testnet, user 2026-11-17 "해결 방법 찾아봐 테스트넷인데": ICP/ARIA skipped at RR 0.78-0.83);
  // the backtest default is SCALP_DEFAULTS.minNetRR (1). Each trade keeps plan.netRR, so the 0.7-1 band is judged apart.
  minNetRR:n('SCALP_MIN_NET_RR',1,.3,3), /* back to 1 (2026-11-17 12:18 backtest: RR<1 band 29 trades PF 0.84 -$16.7, RR>=1 54 trades PF 1.17 +$39.3) */maxHoldMs:SCALP_TIMEFRAMES['5m'].maxHoldMs,
  // The testnet comparison defaults to 'record': measure 4H trend and let the other entry checks run.
  // 'on' blocks against-trend signals (30-day BingX backtest: 23 such trades, -$76, PF 0.32).
  // 'off' skips the measurement. An unrecognized explicit value keeps the blocking filter.
  trendMode:(m=>['off','false','0','no'].includes(m)?'off':['record','log'].includes(m)?'record':'on')(String(env.SCALP_EXEC_TREND_FILTER??'').trim().toLowerCase()||'record'),
  wyckoffRecord:!['off','false','0','no'].includes(String(env.SCALP_WYCKOFF_RECORD??'').trim().toLowerCase()),
  riskPct:n('SCALP_RISK_PCT',.5,.05,2),maxOpen:n('SCALP_MAX_OPEN',0,0,200),leverage:n('SCALP_LEVERAGE',10,1,20),
  scaleIn:!['off','false','0','no'].includes(String(env.SCALP_SCALE_IN??'').trim().toLowerCase()),
  stopLossEnabled:['on','true','1','yes'].includes(String(env.SCALP_STOP_LOSS??'').trim().toLowerCase()),
  // Margin per position and for all scalps together, as a share of the equity; quantity is cut to fit.
  maxMarginPct:n('SCALP_MAX_MARGIN_PCT',10,1,50),maxTotalMarginPct:n('SCALP_MAX_TOTAL_MARGIN_PCT',30,1,80),
  dailyLossPct:n('SCALP_DAILY_LOSS_PCT',3,.5,10),
  // Entry price check against the planned entry (the signal candle's close): within 0.4 % and 1 ATR (the
  // pre-move ATR the stop buffer uses), either way; the TP1 net RR is checked again at the price found.
  maxDriftPct:n('SCALP_MAX_DRIFT_PCT',.4,.05,2),
  // Drift away from the stop (price already moving toward the target): allowed up to driftMovePct % of the move;
  // the TP1 net RR check then decides (user 2026-11-17: 5 % of the move, then 50 % "테스트넷인데" after
  // LIGHTER 1.6 % / HUMA 0.96 % skips). Toward the stop: maxDriftPct / 1 ATR as before.
  driftMovePct:n('SCALP_DRIFT_MOVE_PCT',50,0,100),
  // Better price (toward the stop): enter while >= this % of the planned stop distance is left (0 = old 0.4 %).
  stopKeepPct:n('SCALP_STOP_KEEP_PCT',50,0,100),maxDriftAtr:n('SCALP_MAX_DRIFT_ATR',1,.1,3),
  universeSize:n('SCALP_UNIVERSE_SIZE',80,10,200),
  // Coins always scanned whatever their volume rank (user 2026-11-16: "단타를 먹기 쉬운 것들 AKEUSDT, EVAAUSDT 등").
  watchlist:[...new Set(['AKEUSDT','EVAAUSDT',...String(env.SCALP_WATCHLIST||'').toUpperCase().split(/[\s,]+/)].filter(x=>/^[A-Z0-9]{2,20}USDT$/.test(x)))],universeRefreshMs:30*60000,klineGapMs:n('SCALP_KLINE_GAP_MS',350,100,2000),scanDelayMs:3000,
  balanceCapUSD:n('SCALP_BALANCE_CAP_USD',0,0,1e7),
  // 매물대 반전 (user 2026-11-17 23:12): on by default, SCALP_ZONE_SIGNALS=off turns it off.
  zoneSignals:!['off','false','0','no'].includes(String(env.SCALP_ZONE_SIGNALS??'').trim().toLowerCase()),zoneMinMovePct:SCALP_ZONE_MIN_MOVE_PCT,zoneTouchPct:ZONE_TOUCH_PCT};
}

/** BingX USDT perpetuals by 24h quote volume (stock / fx 'NC*' contracts excluded), tradable via API. */
export function scalpUniverse(tickers,contracts,size=80){
 const out=[];
 for(const t of Array.isArray(tickers)?tickers:[]){
  const venueSymbol=String(t?.symbol||'');if(!/^[A-Z0-9]{1,20}-USDT$/.test(venueSymbol)||venueSymbol.startsWith('NC'))continue;
  const symbol=venueSymbol.replace('-USDT','USDT'),c=contracts?.get?.(symbol),quoteVolume=pos(t.quoteVolume);
  if(c?.tradable&&quoteVolume)out.push({symbol,venueSymbol:c.venueSymbol||venueSymbol,quoteVolume});
 }
 return out.sort((a,b)=>b.quoteVolume-a.quoteVolume).slice(0,size);
}

/** 40/35/25 % of `total` on the lot grid. When a part is below the venue minimum the later targets
 * are merged into the earlier ones (3 -> 2 targets: 40/60 %, -> 1 target: all at TP1); null when
 * even the whole quantity is below the minimum. */
export function scalpSplits(total,step,minPart=0){
 const s=pos(step),n=s?Math.round(total/s+1e-9):0;if(!(n>0))return null;
 const str=String(step),dec=str.includes('e-')?Number(str.split('e-')[1]):(str.split('.')[1]||'').length,q=u=>Number(grid(u*s,step,'DOWN')??(u*s).toFixed(dec)),min=minPart-s*1e-6;
 for(const k of [3,2,1]){
  const a=k===1?n:Math.floor(n*.4),b=k===3?Math.floor(n*.35):k===2?n-a:0,c=k===3?n-a-b:0,parts=[a,b,c].map(q);
  if(parts.slice(0,k).every(p=>p>0&&p>=min))return {parts,targets:k,merged:k<3};
 }
 return null;
}

/** The order plan for a detected LONG or SHORT: price check, stop/targets on the tick grid, risk sizing,
 * splits, TP1 net RR (buildScalpPlan, as backtestScalp). Pure. */
function riskAtStop(direction,entry,stop,takerRate,costs=SCALP_EXEC_COSTS){
 const dir=dirOf(direction),slippage=costs.slippageBps/10000;
 const exit=stop*(1-dir*slippage);
 return Math.max(0,dir*(entry-exit)+takerRate*(entry+exit)+entry*(costs.fundingRate||0));
}

export function planScalpOrder({det,price,contract:c,equity,available=null,usedMargin=0,totalMarginCapUSD=null,leverage,config,costs=SCALP_EXEC_COSTS}){
 const fail=(reason,extra={})=>({ok:false,reasons:[reason],...extra});
 if(!pos(price))return fail('PRICE_UNAVAILABLE');
 const drift=Math.abs(price-det.entry),driftPct=drift/det.entry*100;
 // Only a drift away from the stop gets the move-scaled allowance; toward the stop the base 0.4 % / 1 ATR stays
 // (review 2026-11-17: a drift toward the stop shrinks the stop distance, which the RR check cannot see).
 const away=dirOf(det.direction)*(price-det.entry)>0;
 // Toward the stop = a better price (user 2026-11-17 "오히려 좋은 평단에선 매매를 해야"): allowed while the stop
 // distance left is at least stopKeepPct % of the planned one and 3 round-trip costs (risk sizing then buys more
 // with the same $ risk; the review's 0.04 % stop case stays out). stopKeepPct 0 = the old 0.4 % / 1 ATR.
 const planned=dirOf(det.direction)*(det.entry-det.stop),left=dirOf(det.direction)*(price-det.stop);
 if(!(planned>0))return fail('ENTRY_AT_OR_BEYOND_STOP'); // a stop on the wrong side (or missing) never plans
 const rt=price*(2*Math.max(costs.takerRate,pos(c?.takerFeeRate)??0)+2*costs.slippageBps/1e4+(costs.fundingRate||0));
 if(!away&&config.stopKeepPct>0&&driftPct>0){
  // The signal extreme (low / high) must still hold.
  const ext=Number(det.evidence?.extreme);
  if(Number.isFinite(ext)&&ext>0&&!(dirOf(det.direction)*(price-ext)>0))return fail('PRICE_DRIFT',{driftPct:+driftPct.toFixed(3),toward:'STOP',beyondExtreme:true});
  // stopKeepPct only applies when a protective stop is active (user 2026-11-20).
  if(config.stopLossEnabled!==false){
   // Never more than the planned distance; a planned stop already under 3 costs takes no move toward it.
   const need=Math.min(planned,Math.max(planned*config.stopKeepPct/100,3*rt));
   if(!(left>=need))return fail('PRICE_DRIFT',{driftPct:+driftPct.toFixed(3),toward:'STOP',stopLeftPct:planned>0?+(left/planned*100).toFixed(1):null,allowedPct:planned>0?+((planned-need)/det.entry*100).toFixed(3):null});
  }
 }else{
  const allowed=away?Math.max(config.maxDriftPct,(Number(det.evidence?.movePct)||0)*(config.driftMovePct||0)/100):config.maxDriftPct;
  // The ATR cap stays for ordinary moves; a drift within the move-scaled allowance is not held to it.
  if(driftPct>allowed||(allowed===config.maxDriftPct&&drift>det.atr*config.maxDriftAtr))return fail('PRICE_DRIFT',{driftPct:+driftPct.toFixed(3),allowedPct:+allowed.toFixed(3)});
 }
 const tick=c?.tickSize,step=c?.quantityStep;if(!pos(Number(tick))||!pos(Number(step)))return fail('CONTRACT_GRID_INVALID');
 const dir=dirOf(det.direction);
 // As backtestScalp: entry on the nearest tick, the stop rounded away from it (LONG down, SHORT up).
 const down=Number(grid(price,tick,'DOWN')),up=Number(grid(price,tick,'UP')),entry=price-down<=up-price?down:up,stop=Number(grid(det.stop,tick,awayMode(det.direction)));
 if(!(dir*(entry-stop)>0))return fail('ENTRY_AT_OR_BEYOND_STOP');
 const cost={...costs,takerRate:Math.max(costs.takerRate,pos(c.takerFeeRate)??0)};
 // When stop-loss is disabled, skip the virtual-stop RR floor and only require TP1 to cover round-trip costs (user 2026-11-20).
 const minNetRR=config.stopLossEnabled===false?0:config.minNetRR;
 // Targets and the TP1 net RR do not depend on the quantity: checked on a 20-lot sample.
 const q=buildScalpPlan({signal:{...det,stop},estimate:{eligible:true,tickSize:tick,quantityStep:step,entryBasis:entry,quantity:Number(step)*20,minNotional:0,minQuantity:0},costs:cost,minNetRR});
 if(!q.ok)return fail(q.reasons[0],{netRR:q.estimatedNetRR??null});
 if(!pos(equity))return fail('NO_BALANCE');
 const riskUSD=equity*config.riskPct/100,lev=pos(leverage)??1,scaleIn=config.scaleIn===true;
 const assumedEntry=entry*(1+dir*cost.slippageBps/10000);
 const riskUnit=scaleIn?riskAtStop(det.direction,assumedEntry,stop,cost.takerRate,cost):dir*(entry-stop);
 // Each unit of the initial entry reserves the same notional at the worst permitted add price.
 const worstAdd=stop+(assumedEntry-stop)*SCALP_SCALE_IN.far;
 const addRiskUnit=scaleIn?assumedEntry/worstAdd*riskAtStop(det.direction,worstAdd,stop,cost.takerRate,cost):0;
 let qty=riskUSD/(riskUnit+addRiskUnit),capped=false;
 const cap=Math.min(equity*config.maxMarginPct/100,(totalMarginCapUSD??equity*config.maxTotalMarginPct/100)-usedMargin,available!=null?available*.9:Infinity)/(scaleIn?2:1);
 if(!(cap>0))return fail('MARGIN_CAP');
 if(qty*entry/lev>cap){qty=cap*lev/entry;capped=true}
 qty=Number(grid(qty*(1+1e-9),step,'DOWN'))||0;
 const minPart=Number(grid(Math.max(Number(c.minQuantityBase)||0,(Number(c.minNotionalUSDT)||0)/entry*1.02,Number(step)),step,'UP'))||Number(step);
 const split=scalpSplits(qty,step,minPart);if(!split)return fail(capped?'MARGIN_CAP':'QUANTITY_BELOW_MINIMUM');
 return {ok:true,entry,stop,targets:q.targets,qty,parts:split.parts,targetCount:split.targets,merged:split.merged,minPart,leverage:lev,
  riskUSD:qty*riskUnit,marginUSD:qty*entry/lev,capped,netRR:q.estimatedNetRR,driftPct:+driftPct.toFixed(3),takerRate:cost.takerRate,
  scaleIn:scaleIn?{version:SCALP_SCALE_IN.version,state:'WATCH',riskPct:config.riskPct,budgetUSD:riskUSD,minPart,
   minNotional:pos(c.minNotionalUSDT)||0}:null};
}
/** Deterministic client order ids: one signal candle of one symbol and side can be sent once (LONG keeps
 * the id it had before shorts were added, so a ledger written then still blocks a resend). */
export const scalpClientId=(symbol,barAt,direction='LONG')=>'sc'+createHash('sha256').update(`${SCALP_EXEC_STRATEGY}|${symbol}|${barAt}${direction==='SHORT'?'|SHORT':''}`).digest('hex').slice(0,22);

function positionOf(list,vs,direction,hedge=false){
 // Hedge mode (user 2026-11-17): the row of our own side only, its amount unsigned; an opposite-side row is
 // another position (size 0 and any 0 for us: it neither blocks an entry nor is closed by us).
 if(hedge){const row=positionRow(list,vs,{hedge:true,direction}),size=row?Math.abs(Number(row.positionAmt)||0):0;
  return {size,any:size,signed:dirOf(direction)*size,avg:pos(row?.avgPrice),mark:pos(row?.markPrice),unrealized:row?num(row.unrealizedProfit):null,row,other:otherSideAmount(list,vs,direction)}}
 const row=(Array.isArray(list)?list:[]).find(x=>x?.symbol===vs),signed=row?signedAmount(row):0;
 // A one-way row with positionSide BOTH and a positive amount does not say its side: it is taken as ours
 // (one position per coin, and an entry is refused when one already exists). Reading a short as 0 would
 // close the ledger and cancel its stop while the venue still holds it (review note 2026-11-16).
 const side=String(row?.positionSide||'').toUpperCase(),unsignedBoth=signed>0&&(side===''||side==='BOTH');
 const mine=unsignedBoth?signed:dirOf(direction)*signed;
 return {size:mine>0?mine:0,any:Math.abs(signed),signed,avg:pos(row?.avgPrice),mark:pos(row?.markPrice),unrealized:row?num(row.unrealizedProfit):null,row};
}

function scalpPositionDetails(p,now){
 const first=p.firstEntryPrice??p.scaleIn?.initialEntry??p.steps?.find(s=>s.kind==='OPEN')?.avg;
 const ticker=now-(p.markAt??0)<90000?pos(p.tickerPrice):null;
 const snapshot=p.exchangePosition;
 const position={size:p.size,entryPrice:p.avg,...(snapshot&&snapshot.size===p.size&&snapshot.entryPrice===p.avg?snapshot:{})};
 const view=livePositionView({...p,venue:'BINGX',firstEntryPrice:first,position,
  quantity:{total:p.size,unit:'BASE_ASSET'}},{price:ticker,now});
 const a=p.scaleIn,repeat=a?.version===SCALP_REPEAT_SCALE_IN.version;
 return {...view,tickSize:p.tickSize,currentPriceSource:view.currentPriceSource==='VENUE_BOOK'?'VENUE_TICKER':view.currentPriceSource,
  adds:{filled:repeat?a.count??0:a?.fillQty>0?1:0,max:a?1:0,repeat}};
}

export class ScalpExecutor{
 constructor({config,client=null,contracts=async()=>new Map(),tickers=async()=>[],tickersFresh=null,candles=async()=>[],trendCandles=null,zoneCandles=null,priceOf=async()=>null,markOf=async()=>null,
  balance=async()=>null,isBusy=()=>false,gate=()=>({ok:true}),directory=null,fileName='scalp-store.json',now=()=>Date.now(),log=()=>{},onEvent=()=>{},budget=null}){
  if(!SCALP_EXEC_MODES.includes(config?.mode))throw err('SCALP_TESTNET_ONLY',500);
  if(client&&client.mode!=='TESTNET')throw err('SCALP_TESTNET_ONLY',500);
  Object.assign(this,{config,client,contracts,tickers,tickersFresh,candles,priceOf,markOf,balance,isBusy,gate,now,log,onEvent});
  this.trendCandles=trendCandles??(symbol=>this.candles(symbol,'4h',301));
  // 4H / 1D candles for the volume zones (BingX public market data, the scan's paced queue); cached per symbol and
  // timeframe until the next candle of that timeframe closes.
  this.zoneCandles=zoneCandles??((symbol,interval,limit)=>this.candles(symbol,interval,limit));this.zoneCache=new Map();
  this.file=directory?path.join(directory,fileName):null;
  const saved=this.file&&fs.existsSync(this.file)?readStore(this.file):null;
  this.store={open:Array.isArray(saved?.open)?saved.open:[],closed:Array.isArray(saved?.closed)?saved.closed:[],events:Array.isArray(saved?.events)?saved.events:[],
   skipCounts:saved?.skipCounts||{},skips:Array.isArray(saved?.skips)?saved.skips:[],sent:Array.isArray(saved?.sent)?saved.sent:[],dailyStop:saved?.dailyStop||null};
  // An entry cut off by a restart: its outcome is read from the venue by the next check.
  for(const p of this.store.open)if(p.status==='SUBMITTING')p.status='UNKNOWN';
  // budget (testnet_budget.mjs, user 2026-11-17 "한도까지 하나로"): the daily loss, open risk and margin shared with the
  // signal strategy on the testnet (TESTNET_DAILY_LOSS_PCT, default 15 %). Without it the scalp's own 3 % rules apply.
  this.budget=budget;this.reservedRisk=new Map();
  this.armed=false;this.entryRevision=0;this.reserved=new Set();this.universe=[];this.universeAt=0;this.trendCache=new Map();this.lastScanBucket=null;this.lastScan=null;
  this.reversalWatch=new Map();
  this.wyckoffCache=new Map();
  this.scanning=false;this.reconciling=false;this.lastReconcileAt=0;this.cooldownUntil=0;this.funds=null;
  // Trade journal (scalp_journal.mjs, user 2026-11-16 22:18): every finished trade, never truncated; the stats
  // header is computed over it (the in-store closed list stays capped). Detected signals go to their own file.
  this.journalFile=directory?path.join(directory,SCALP_JOURNAL_FILE):null;this.signalsFile=directory?path.join(directory,SCALP_SIGNALS_FILE):null;
  const written=this.journalFile?readJsonl(this.journalFile):[];
  this.journalRows=written.map(x=>({kind:x.kind||SCALP_KINDS.MOVE,direction:x.direction,netUSD:x.pnl?.netUSD??null,closedAt:x.exit?.at??null,closeReason:x.exit?.reason??null,scaleIn:x.scaleIn}));
  // Ids already written: a restart between writing a line and saving the ledger must not write it twice.
  this.journalIds=new Set(written.map(x=>x?.id).filter(Boolean));
  this.journalMem=[];this.cur=null;this.btcCache=null;
  try{this.#flushJournal();this.#save()}catch(e){this.log?.('[SCALP] journal start',e.message)}
 }
 #save(){if(!this.file)return;const s=this.store;s.closed=s.closed.slice(-MAX_CLOSED);s.events=s.events.slice(-MAX_EVENTS);s.skips=s.skips.slice(-MAX_SKIPS);s.sent=s.sent.slice(-MAX_KEYS);
  fs.mkdirSync(path.dirname(this.file),{recursive:true});atomicWriteStore(this.file,{version:1,strategy:SCALP_EXEC_STRATEGY,...s})}
 #event(type,detail={}){const e={type,at:this.now(),mode:'TESTNET',strategy:SCALP_EXEC_STRATEGY,...detail};this.store.events.push(e);this.log(`[SCALP] ${type} ${detail.symbol||''} ${detail.reason||''}`.trim());try{this.onEvent(e)}catch{}return e}
 #skip(symbol,reason,detail=null){if(this.cur?.symbol===symbol){this.cur.reason=reason;this.cur.detail=detail==null?null:String(detail).slice(0,160)}this.store.skipCounts[reason]=(this.store.skipCounts[reason]||0)+1;this.store.skips.push({at:this.now(),symbol,reason,...(this.cur?.symbol===symbol&&this.cur.direction?{direction:this.cur.direction,movePct:this.cur.evidence?.movePct??null,kind:this.cur.kind||SCALP_KINDS.MOVE}:{}),...(detail?{detail:String(detail).slice(0,160)}:{})})}
 #gate(){try{return this.gate()||{ok:true}}catch{return {ok:false,reason:'GATE_ERROR'}}}
 // With the shared budget only a stop written under it counts (review L2: a scalp-only 3 % stop saved before is ignored).
 #todayStopped(){const d=this.store.dailyStop;return d?.day===kstDay(this.now())&&(!this.budget||d.shared===true)}
 /** Why no new entry may be sent now (null = may). */
 #blocked(ignoreAddId=null){
  if(this.config.mode!=='TESTNET')return this.config.refused||'SCALP_MODE_OFF';
  if(!this.client)return 'CREDENTIALS_MISSING';
  if(this.client.mode!=='TESTNET')return 'SCALP_TESTNET_ONLY';
  if(!this.armed)return 'NOT_ARMED';
  const g=this.#gate();if(!g.ok)return g.reason||'GATE_CLOSED';
  if(this.#todayStopped())return 'DAILY_LOSS_LIMIT';
  // Shared budget: the signal strategy's and the scalp's realized loss today reached the shared limit.
  if(this.budget?.stopped(this.funds?.equity))return 'DAILY_LOSS_LIMIT';
  if(this.store.open.some(p=>p.status==='UNKNOWN'||p.id!==ignoreAddId&&p.scaleIn?.state==='PENDING'&&this.now()-(p.scaleIn.attemptedAt||0)<5*60000))return 'UNRESOLVED_ORDER_STATE';
  if(this.cooldownUntil>this.now())return 'RATE_LIMIT_COOLDOWN';
  return null;
 }
 arm(){
  if(this.config.mode!=='TESTNET')throw err(this.config.refused||'SCALP_MODE_OFF');
  if(!this.client)throw err('CREDENTIALS_MISSING');
  if(this.client.mode!=='TESTNET')throw err('SCALP_TESTNET_ONLY');
  const g=this.#gate();if(!g.ok)throw err(g.reason==='KILL_SWITCH'?'KILL_SWITCH_ON':g.reason||'GATE_CLOSED');
  // Shared budget (one testnet switch): the switch may stay on through a day stop; entries wait for the next KST day.
  if(this.#todayStopped()&&!this.budget)throw err('DAILY_LOSS_LIMIT');
  this.armed=true;this.#event('ARMED');this.#save();return this.status();
 }
 disarm(reason='MANUAL'){const was=this.armed;this.entryRevision++;this.armed=false;this.reversalWatch.clear();if(was)this.#event('DISARMED',{reason});this.#save();return this.status()}
 /** Symbols (and venue symbols) this ledger holds or is entering: other strategies on the account skip them. */
 heldSymbols(){const s=new Set();for(const sym of this.reserved){s.add(sym);if(sym.endsWith('USDT')&&!sym.includes('-'))s.add(sym.replace(/USDT$/,'-USDT'))}for(const p of this.store.open){s.add(p.symbol);s.add(p.venueSymbol)}return s}
 // Reading candles (the scan) does not block a restart: only orders being placed (reserved) or a position
 // check (2026-11-16: a 30-60 s scan every 5 minutes made updates fail with 'ORDER_IN_PROGRESS').
 idle(){return !this.reconciling&&!this.reserved.size}

 /** Called every few seconds: the scan right after each 5m close, and the routine check. */
 async tick(now=this.now()){
  const bucket=Math.floor(now/I5);
  // The bulk ticker read for the scan order starts right at the close, during the scan delay, not awaited here.
  if(this.armed&&this.lastScanBucket!==bucket&&this.prefetch?.bucket!==bucket&&(this.tickersFresh||this.tickers))
   this.prefetch={bucket,rows:withTimeout((this.tickersFresh||this.tickers)(),8000)};
  if(this.armed&&!this.scanning&&this.lastScanBucket!==bucket&&now-bucket*I5>=this.config.scanDelayMs)await this.scan(now);
  const every=this.store.open.length?(this.config.stopLossEnabled===false?5000:15000):60000;
  if(!this.reconciling&&this.client&&now-this.lastReconcileAt>=every&&(this.store.open.length||this.armed||this.store.closed.some(x=>!x.journaled)))await this.reconcile();
 }
 async #refreshUniverse(now){
  if(this.universe.length&&now-this.universeAt<this.config.universeRefreshMs)return;
  const [tickers,contracts]=await Promise.all([this.tickers(),this.contracts()]);
  const list=scalpUniverse(tickers,contracts,this.config.universeSize);
  // The watchlist first (tradable ones only), then the volume ranking without duplicates.
  const all=scalpUniverse(tickers,contracts,100000),watch=(this.config.watchlist||[]).map(sym=>all.find(u=>u.symbol===sym)).filter(Boolean).map(u=>({...u,watch:true}));
  const merged=[...watch,...list.filter(u=>!watch.some(w=>w.symbol===u.symbol))];
  if(merged.length){this.universe=merged;this.universeAt=now}
 }
 /** The universe ordered by the price range of the last 8 scans' ticker snapshots (largest first); the volume
  * order when no ticker is available. */
 async #byRecentMove(bucket){
  try{
  const pre=this.prefetch?.bucket===bucket?this.prefetch.rows:null;
  let rows=null;try{rows=await withTimeout(pre||(this.tickersFresh||this.tickers)(),pre?3000:5000)}catch{}
  if(!Array.isArray(rows))return [...this.universe];
  const px=new Map(rows.filter(Boolean).map(r=>[String(r?.symbol),Number(r?.lastPrice)]));this.pxHist||=new Map();
  const live=new Set(this.universe.map(u=>u.symbol));for(const k of this.pxHist.keys())if(!live.has(k))this.pxHist.delete(k);
  const score=new Map();
  for(const u of this.universe){const p=px.get(u.venueSymbol);if(!(p>0))continue;
   const h=(this.pxHist.get(u.symbol)||[]).filter(x=>x.bucket>bucket-8&&x.bucket!==bucket);h.push({bucket,p});this.pxHist.set(u.symbol,h);
   const ps=h.map(x=>x.p),lo=Math.min(...ps);score.set(u.symbol,(Math.max(...ps)-lo)/lo)}
  return [...this.universe].sort((a,b)=>(score.get(b.symbol)??-1)-(score.get(a.symbol)??-1));
  }catch{return [...this.universe]} // any bad ticker data: the volume order
 }
 async scan(now=this.now()){
  if(this.scanning)return this.lastScan;this.scanning=true;
  const revision=this.entryRevision,bucket=Math.floor(now/I5),st={at:now,bucket,checked:0,signals:0,entered:0,error:null};this.lastScanBucket=bucket;
  const observations=[];
  try{
   let why=this.#blocked();
   // An UNKNOWN entry or PENDING FOK scale-in may already have settled on the venue; reconcile once before aborting the 5m scan.
   if(why==='UNRESOLVED_ORDER_STATE'&&!this.reconciling&&this.client){await this.reconcile();why=this.#blocked()}
   if(why){st.error=why;return st}
   for(const [symbol,w] of this.reversalWatch)if(now-w.det.barAt>REVERSAL_RECHECK_MS)this.reversalWatch.delete(symbol);
   await this.#refreshUniverse(now);
   // Coins that moved most over the last ~35 minutes are read first (user 2026-11-17: by the 60th coin the
   // signal was ~50 s old and big movers drifted past the price check). One bulk ticker read per scan.
   const order=await this.#byRecentMove(bucket);st.firstSymbols=order.slice(0,5).map(u=>u.symbol);
   for(const [seq,u] of order.entries()){const ix=this.universe.indexOf(u);
    if(revision!==this.entryRevision||this.#blocked())break;
    // BingX answers 100410 when the shared public request rate is exceeded (2026-11-16: 10 of 80 coins per
    // scan): wait a little and read that coin once more instead of skipping it.
    let rows;try{rows=await this.#paced(()=>this.candles(u.symbol,'5m',61),st)}
    // Other read failures are counted and shown (2026-11-16: a missing 5m interval failed every read silently).
    catch(e){if(e?.code==='HTTP_429'){st.error='HTTP_429';this.cooldownUntil=this.now()+60000;break}st.failed=(st.failed||0)+1;st.lastFailure=e?.code||e?.message||'READ_FAILED';continue}
    st.checked++;
    const t=this.now(),closed=(Array.isArray(rows)?rows:[]).filter(r=>Number(r?.[6])<t).slice(-60);
    // Only the candle that has just closed (a late or missing candle is not traded later).
    if(!closed.length||Number(closed.at(-1)[0])!==(bucket-1)*I5)continue;
    let det=detectScalpReversal(closed,{symbol:u.symbol,now:t,interval:'5m',settings:this.config.settings}),kind=SCALP_KINDS.MOVE;
    // 매물대 반전 (backtestScalp zoneSignals): only when the 5 % rule found nothing on this candle, the same detection at
    // 2.5 %; it is traded only when its extreme touched a 4H / 1D zone (checked below, zones read only for these).
    if(!det.ok&&this.config.zoneSignals&&(this.config.settings.minMovePct??SCALP_TIMEFRAMES['5m'].minMovePct)>this.config.zoneMinMovePct){
     const alt=detectScalpReversal(closed,{symbol:u.symbol,now:t,interval:'5m',settings:{...this.config.settings,minMovePct:this.config.zoneMinMovePct}});
     if(alt.ok){det=alt;kind=SCALP_KINDS.ZONE;st.zoneSignals=(st.zoneSignals||0)+1}
    }
    const watched=!det.ok?this.#recheckReversal(u.symbol,closed,t):null;
    if(watched){det=watched.det;kind=watched.kind;st.rechecked=(st.rechecked||0)+1}
    if(!det.ok)continue;if(!watched&&kind===SCALP_KINDS.MOVE)st.signals++;
    // A candle already sent (any kind: same client id) is not looked at again.
    if(kind===SCALP_KINDS.ZONE&&this.store.sent.includes(scalpClientId(u.symbol,det.barAt,det.direction)))continue;
    // Journal context of this detection (no effect on the decision).
    const ctx={at:t,symbol:u.symbol,venueSymbol:u.venueSymbol,kind,direction:det.direction,barAt:det.barAt,evidence:det.evidence,atr:det.atr,lensEntry:det.entry,
     candle:watched?.candle??candleShape(closed.at(-1),det.direction),...(watched?{recheckedAt:Number(closed.at(-1)[6])}:{}),
     universe:{rank:ix+1,size:this.universe.length,quoteVolume:u.quoteVolume},scan:{startedAt:st.at,bucket,position:seq+1,of:this.universe.length,elapsedMs:t-st.at},reason:null,detail:null};
    this.cur=ctx;let r;
    try{
     if(!this.config.sides.includes(det.direction)){this.#skip(u.symbol,'SIDE_OFF',det.direction);r={entered:false,reason:'SIDE_OFF'}}
     else{
      // 매물대 반전: the zone touch first; then every rule of the 5 % scalp (#consider) unchanged.
      const z=kind===SCALP_KINDS.ZONE?await this.#zoneCheck(u,det,st):{ok:true};
      r=z.ok?await this.#consider(u,det,revision):z;
     }
    }finally{this.cur=null}
    if(revision===this.entryRevision&&!r?.entered&&RECHECK_REASONS.has(r?.reason))this.reversalWatch.set(u.symbol,{det,kind,candle:ctx.candle});
    else this.reversalWatch.delete(u.symbol);
    if(r?.entered){st.entered++;if(kind===SCALP_KINDS.ZONE)st.zoneEntered=(st.zoneEntered||0)+1}
    if(r?.reason!=='ALREADY_SENT'){
     if(this.config.wyckoffRecord&&this.signalsFile)observations.push({ctx,result:r});
     else this.#logSignal(ctx,r);
    }
   }
   // Scan duration on the positions this scan opened (journal only).
   for(const p of this.store.open)if(p.scan?.bucket===bucket)p.scan.durationMs=this.now()-st.at;
   if(!st.error&&st.failed&&!st.checked)st.error=`CANDLES_FAILED_${st.failed}:${st.lastFailure}`;
  }catch(e){st.error=e?.code||e?.message||'SCAN_FAILED'}
  finally{
   try{await this.#recordWyckoff(observations,st)}finally{this.scanning=false;this.lastScan=st;this.#save()}
  }
  return st;
 }
 /** Add context to the existing signal journal after all entry decisions. No context result gates an order. */
 async #recordWyckoff(observations,st){
  if(!observations.length)return;
  const asOf=st.bucket*I5;
  const bucket=Math.floor(asOf/WYCKOFF_INTERVAL_MS);
  const higherCloseAt=Math.floor(asOf/LENS_HIGHER_INTERVAL_MS)*LENS_HIGHER_INTERVAL_MS;
  for(const [symbol,entry] of this.wyckoffCache)if(entry.bucket!==bucket)this.wyckoffCache.delete(symbol);
  const deadline=performance.now()+WYCKOFF_SCAN_BUDGET_MS;
  let canRead=!st.error&&!st.rateLimited;
  for(const {ctx,result} of observations){
   const timeLeft=Math.min(deadline-performance.now(),(st.bucket+1)*I5-this.now()-25_000);
   const status=state=>({version:1,timeframe:'15m',model:'WYCKOFF_STRUCTURE_OBSERVATION',status:state});
   let cached=this.wyckoffCache.get(ctx.symbol);
   if(!cached&&canRead&&timeLeft>0){
    const rows=await withTimeout(Promise.resolve().then(()=>this.candles(ctx.symbol,'15m',WYCKOFF_CANDLES)),Math.min(timeLeft,5000));
    if(Array.isArray(rows)){
     // Use the actual observation candle, including for a recheck of an older 5m candidate.
     cached={bucket,...observeScalpStructure(rows,{asOf})};
     if(cached.vsa.status!=='INSUFFICIENT_CANDLES')this.wyckoffCache.set(ctx.symbol,cached);
    }else{
     ctx.wyckoff=status('READ_FAILED');
     canRead=false;
    }
   }
   if(cached){
    const o=cached.map;
    const alignment=o.status==='CONFIRMED_RANGE'&&o.verdict?(o.verdict===ctx.direction?'ALIGNED':'OPPOSED'):null;
    ctx.wyckoff={...o,alignment};
    ctx.vsa=cached.vsa;
    const higher=this.trendCache.get(ctx.symbol)?.higher;
    ctx.aiLens={...cached.aiLens,
     higher4h:higher?.closedCandleAt===higherCloseAt?higher:null,
     riskMap:aiLensRiskMap(ctx.lensEntry,ctx.direction,cached.aiLens.atr14)};
   }else ctx.wyckoff??=status('READ_DEFERRED');
   ctx.vsa??=vsaStatus(ctx.wyckoff.status);
   ctx.aiLens??=aiLensStatus(ctx.wyckoff.status);
   this.#logSignal(ctx,result);
  }
 }
 #recheckReversal(symbol,closed,now){
  const candidate=this.reversalWatch.get(symbol);
  if(!candidate)return null;
  const {det}=candidate,dir=dirOf(det.direction);
  const first=Math.ceil(det.barAt/I5)*I5,bars=closed.filter(r=>Number(r[0])>=first);
  if(!bars.length)return null;
  const invalid=now-det.barAt>REVERSAL_RECHECK_MS||bars.some((r,i)=>{
   const low=pos(r[3]),high=pos(r[2]);
   return Number(r[0])!==first+i*I5||!low||!high||
    (dir>0?low<=det.evidence.extreme||high>=det.targets[0]:high>=det.evidence.extreme||low<=det.targets[0]);
  });
  if(invalid){this.reversalWatch.delete(symbol);return null}
  const bar=bars.at(-1),open=pos(bar[1]),close=pos(bar[4]);
  return open&&close&&dir*(close-open)>0?candidate:null;
 }
 /** A public read with the scan's 100410 handling: up to two more tries (1.5 s, then 3 s), and once the limit was
  * hit the rest of the scan goes 300 ms slower (2026-11-16: 3 of 80 coins still failed after one retry). */
 async #paced(read,st){
  if(st.rateLimited)await sleep(300);
  try{return await read()}
  catch(e){for(const w of [1500,3000]){if(e?.code!=='VENUE_ERROR_100410')throw e;st.rateLimited=(st.rateLimited||0)+1;await sleep(w);try{return await read()}catch(next){e=next}}throw e}
 }
 /** The 4H / 1D zone book of a symbol (backtest.mjs zoneBook on BingX candles, ZONE_PROFILES counts), cached until the
  * next candle of that timeframe closes. null when the candles could not be read (not cached: read again next time). */
 async zoneBookOf(symbol,interval,tickSize,st={}){
  const key=symbol+'|'+interval,now=this.now(),hit=this.zoneCache.get(key);
  if(hit&&now<hit.nextCloseAt&&hit.tickSize===String(tickSize)){hit.usedAt=now;return hit.book}
  const cfg=ZONE_PROFILES[interval];let rows;
  try{rows=await this.#paced(()=>this.zoneCandles(symbol,interval,cfg.candles+2),st)}
  catch(e){if(e?.code==='HTTP_429'){this.cooldownUntil=this.now()+60000;st.error='HTTP_429'}st.zoneReadFailed=(st.zoneReadFailed||0)+1;return null}
  if(!Array.isArray(rows))return null;st.zoneReads=(st.zoneReads||0)+1;
  const at=this.now(),valid=rows.filter(r=>Array.isArray(r)&&Number.isFinite(Number(r[0]))&&Number.isFinite(Number(r[6]))).sort((a,b)=>Number(a[0])-Number(b[0]));
  // The candle still open closes next; with none open, the one after the last closed candle.
  const open=valid.find(r=>Number(r[6])>=at),nextCloseAt=open?Number(open[6])+1:valid.length?Number(valid.at(-1)[6])+1+cfg.intervalMs:at+cfg.intervalMs;
  const book=zoneBook(valid,{symbol,tickSize,interval});
  this.zoneCache.set(key,{book,nextCloseAt,tickSize:String(tickSize),usedAt:now});return book;
 }
 /** 매물대 반전 gate: the extreme in or within 0.3 % of a 4H / 1D zone from candles closed before the move window
  * (backtestScalp's zoneTag). Missing candles are never a touch: ZONE_DATA_UNAVAILABLE. */
 async #zoneCheck(u,det,st){
  const skip=(reason,detail)=>{this.#skip(u.symbol,reason,detail);return {ok:false,entered:false,reason}};
  // The cheap checks of #consider first (same checks, same order, same results): no zone read for a candidate the
  // 4H trend, the position cap, a held coin or another strategy would stop anyway (review L3).
  const pre=await this.#precheck(u,det);if(pre)return {ok:false,...pre};
  const c=(await this.contracts(u.symbol).catch(()=>null))?.get?.(u.symbol);if(!c?.tradable||!pos(Number(c.tickSize)))return skip('CONTRACT_UNAVAILABLE');
  for(const [k,v] of this.zoneCache)if(this.now()-v.usedAt>6*3600000)this.zoneCache.delete(k);
  // HTTP 429 on the 4H read: no 1D read, the scan stops (st.error, as a 5m read; review L2).
  const b4=await this.zoneBookOf(u.symbol,'4h',c.tickSize,st);if(st.error==='HTTP_429')return skip('HTTP_429');
  const b1=await this.zoneBookOf(u.symbol,'1d',c.tickSize,st);if(st.error==='HTTP_429')return skip('HTTP_429');
  // A kill switch, disarm or cooldown that came during the reads stops here (review L2).
  {const why=this.#blocked();if(why)return skip(why)}
  // As the backtest: `now` = the signal candle's close + 1 s (det.barAt is its close time + 1 ms).
  const touches=zoneTouches({zones4h:b4||(()=>null),zones1d:b1||(()=>null),det,now:det.barAt-1+1000,moveSpanMs:zoneSpanMs(this.config.settings,'5m'),touchPct:this.config.zoneTouchPct});
  const zone=zoneRecord(touches);if(this.cur)this.cur.zone=zone;
  if(zone.atZone){st.zoneAtZone=(st.zoneAtZone||0)+1;return {ok:true}}
  // No touch on what could be read; a profile missing on either timeframe = not checked, never 'no zone'.
  if(!touches['4h']||!touches['1d'])return skip('ZONE_DATA_UNAVAILABLE',[!touches['4h']?'4H':null,!touches['1d']?'1D':null].filter(Boolean).join('·'));
  return skip('ZONE_NOT_TOUCHED',zone.distPct!=null?`${Number(zone.distPct).toFixed(2)}%`:null);
 }
 async #trend(symbol){
  const b=Math.floor(this.now()/LENS_HIGHER_INTERVAL_MS),hit=this.trendCache.get(symbol);
  if(hit?.b===b&&hit.trend!==null)return hit.trend;
  let trend=null,higher=null;
  try{
   const rows=await this.trendCandles(symbol);
   trend=fourHourTrend(rows,this.now());
   if(this.config.wyckoffRecord&&this.signalsFile)higher=aiLensHigherTimeframe(closedScalpBars(rows,b*LENS_HIGHER_INTERVAL_MS,LENS_HIGHER_INTERVAL_MS));
  }catch{}
  if(trend!==null||higher)this.trendCache.set(symbol,{b,trend,higher});
  return trend;
 }
 /** Loss to the stops of the open positions (0 once a stop sits at breakeven or better). */
 #openRisk(){return this.store.open.reduce((t,p)=>{
  const d=dirOf(p.direction),e=pos(p.avg||p.entry),st=pos(p.stop),q=pos(p.size||p.qty),pending=p.scaleIn?.state==='PENDING'?(p.scaleIn.reservedRiskUSD||0):0;
  if(!e||!st||!q)return t+pending;
  if(this.config.stopLossEnabled===false)return t+this.#repeatRisk(p,e,p.mark)*q+pending;
  const unit=p.scaleIn?riskAtStop(p.direction,e,st,p.takerRate):Math.max(0,d*(e-st));
  if(p.scaleIn&&p.status==='SUBMITTING')return t+Math.max(unit*q,p.riskUSD)+pending;
  return t+unit*q+pending;
 },0)}
 #usedMargin(){return this.store.open.reduce((t,p)=>t+(p.size||p.qty||0)*(p.avg||p.entry||0)/(p.leverage||1)
  +(p.scaleIn?.state==='PENDING'?(p.scaleIn.reservedMarginUSD||0):0),0)}
 async #funds({requireAvailable=false}={}){
  const b=await this.balance().catch(()=>null),eq=pos(b?.equity);if(!eq)return null;
  const raw=b.available,available=num(raw);
  if(requireAvailable&&(!['number','string'].includes(typeof raw)||String(raw).trim()===''||available===null))return null;
  const cap=this.config.balanceCapUSD>0?this.config.balanceCapUSD:Infinity,equity=Math.min(eq,cap),used=Math.max(0,eq-(available??eq));
  this.funds={equity,available:Math.max(0,Math.min(available??equity,equity-used)),at:this.now()};return this.funds;
 }
 async #consider(u,det,revision){
  const key=scalpClientId(u.symbol,det.barAt,det.direction),skip=(reason,detail)=>{this.#skip(u.symbol,reason,detail);return {entered:false,reason}};
  if(this.store.sent.includes(key))return {entered:false,reason:'ALREADY_SENT'};
  // Blocked since the scan loop looked (kill switch, disarm, cooldown during the candle / zone reads): no order (review L2).
  {const why=this.#blocked()||(revision!==this.entryRevision?'NOT_ARMED':null);if(why)return skip(why)}
  const pre=await this.#precheck(u,det);if(pre)return pre;
  // Reserved right after the check, before any await: the signal strategy sees it through heldSymbols and
  // cannot enter the same coin in between (review 2026-11-16).
  this.reserved.add(u.symbol);
  try{
   const c=(await this.contracts(u.symbol).catch(()=>null))?.get?.(u.symbol);if(!c?.tradable)return skip('CONTRACT_UNAVAILABLE');
   const price=pos(await withTimeout(this.priceOf(u.symbol,u.venueSymbol),3000));
   const funds=await this.#funds();if(!funds)return skip('NO_BALANCE');
   let lev=this.config.leverage;
   try{const info=await this.client.leverage(u.venueSymbol),max=Number((det.direction==='SHORT'?info?.maxShortLeverage:info?.maxLongLeverage)??info?.maxLeverage);if(max>0)lev=Math.max(1,Math.min(lev,Math.floor(max)))}catch{}
   const shared=this.budget?.snapshot(funds.equity,{who:'scalp'});
   if(shared&&!shared.ok)return skip('TESTNET_BUDGET_UNAVAILABLE');
   const plan=planScalpOrder({det,price,contract:c,equity:funds.equity,available:funds.available,
    usedMargin:shared?.marginUSD??this.#usedMargin(),totalMarginCapUSD:shared?.marginCapUSD,leverage:lev,config:this.config});
   if(this.cur)this.cur.plan={price,ok:plan.ok,entry:plan.entry??null,stop:plan.stop??null,targets:plan.targets??null,netRR:plan.netRR??null,driftPct:plan.driftPct??null,qty:plan.qty??null,riskUSD:plan.riskUSD??null,leverage:lev};
   if(!plan.ok)return skip(plan.reasons[0],plan.driftPct!=null?`${plan.driftPct}%${plan.allowedPct!=null?` > ${plan.allowedPct}%`:''}`:plan.netRR!=null?`RR ${Number(plan.netRR).toFixed(2)}`:null);
   // Reserve a plan that fits the shared budget while the venue setup runs. A larger plan may still fit after the cap.
   if(this.budget?.check({equity:funds.equity,newRiskUSD:plan.riskUSD,newMarginUSD:plan.marginUSD,who:'scalp'}).ok)
    this.reservedRisk.set(u.symbol,{riskUSD:plan.riskUSD,marginUSD:plan.marginUSD});
   return await this.#enter(u,det,c,plan,key,{revision,equity:funds.equity});
  }catch(e){return skip(e?.code==='HTTP_429'?'HTTP_429':'ENTRY_SETUP_FAILED',e?.code||e?.message)}
  finally{this.reserved.delete(u.symbol);this.reservedRisk.delete(u.symbol)}
 }
 /** The cheap entry checks: 4H trend (cached per 4H candle), position cap, one per symbol, another strategy's coin.
  * A skip result, or null. Used by #consider and, before any zone read, by #zoneCheck. */
 async #precheck(u,det){
  const skip=reason=>detail=>{this.#skip(u.symbol,reason,detail);return {entered:false,reason}};
  if(this.config.trendMode!=='off'){const trend=await this.#trend(u.symbol);if(this.cur){this.cur.trend4h=trend;this.cur.withTrend=trend==null||trend==='range'?null:trendAllows(det.direction,trend)}
   if(this.config.trendMode==='on'&&!trendAllows(det.direction,trend))return skip(trend===null?'TREND_4H_UNAVAILABLE':'AGAINST_4H_TREND')(trend)}
  if(this.config.maxOpen>0&&this.store.open.length+this.reserved.size>=this.config.maxOpen)return skip('MAX_OPEN_POSITIONS')();
  if(this.store.open.some(p=>p.symbol===u.symbol)||this.reserved.has(u.symbol))return skip('SYMBOL_ALREADY_HELD')();
  let busy=false;try{busy=this.isBusy(u.symbol,u.venueSymbol)}catch{busy=true}
  if(busy)return skip('SYMBOL_HELD_BY_OTHER_STRATEGY')();
  return null;
 }
 /** Getters for the shared TESTNET budget (testnet_budget.mjs). Read only. */
 budgetSource(){
  const reserved=k=>[...this.reservedRisk.values()].reduce((t,x)=>t+(x[k]||0),0);
  return {realizedToday:day=>this.store.closed.filter(x=>kstDay(x.closedAt)===day).reduce((t,x)=>t+(Number(x.netUSD)||0),0),
   openRisk:()=>this.#openRisk()+reserved('riskUSD'),usedMargin:()=>this.#usedMargin()+reserved('marginUSD'),
   unrealized:()=>this.store.open.reduce((t,p)=>t+(Number(p.unrealized)||0),0),stoppedToday:day=>this.store.dailyStop?.day===day&&this.store.dailyStop.shared===true};
 }
 async #enter(u,det,c,initialPlan,id,{revision,equity}){
  const cl=this.client,vs=u.venueSymbol,d=det.direction,skip=(reason,detail)=>{this.#skip(u.symbol,reason,detail);return {entered:false,reason}};
  let plan=initialPlan;
  // The account's position mode (one-way or hedge, user 2026-11-17), read before every entry and kept on the
  // position: its stop, targets, breakeven and closes use the mode it was opened under. Never guessed.
  const mode=await readPositionMode(cl);if(!mode.ok)return skip(mode.reason,mode.detail);
  const hedge=mode.hedge;
  // otherSide: a position on the other side of this coin (hedge mode) shares the symbol's fund-flow rows.
  let otherSide=false;{const now=await this.#position(vs,d,hedge);if(now.any>0)return skip('VENUE_POSITION_EXISTS',`${now.signed}`);otherSide=now.other>0}
  try{
   const m=await cl.marginType(vs).catch(()=>null);
   if(m?.marginType!=='CROSSED'){await cl.setMarginType(vs,'CROSSED');const again=await cl.marginType(vs);if(again?.marginType!=='CROSSED')throw err('CROSS_NOT_CONFIRMED')}
   const set=await cl.setLeverage(vs,leverageSideFor({hedge,direction:d}),plan.leverage);
   if(set?.leverage!==undefined&&Number(set.leverage)!==plan.leverage)throw err('LEVERAGE_NOT_CONFIRMED');
  }catch(e){return skip('MARGIN_SETUP_FAILED',e?.code||e?.message)}
  // BingX reports the remaining opening quantity per side. Read it after setting cross margin and leverage.
  const leverage=await withTimeout(cl.leverage(vs),3000);
  const rawRoom=d==='SHORT'?leverage?.availableShortVol:leverage?.availableLongVol;
  const room=typeof rawRoom==='number'||(typeof rawRoom==='string'&&rawRoom.trim()!=='')?num(rawRoom):null;
  const venueAvailableQty=room!==null&&room>=0?room:null;
  const requestedQty=plan.qty;
  if(this.cur?.plan)Object.assign(this.cur.plan,{requestedQty,venueAvailableQty});
  if(venueAvailableQty!==null&&venueAvailableQty<requestedQty){
   const qty=Number(grid(venueAvailableQty,c.quantityStep,'DOWN'))||0;
   const split=scalpSplits(qty,c.quantityStep,plan.minPart);
   if(!split)return skip('VENUE_POSITION_LIMIT',`가용 ${venueAvailableQty}개 · 최소 ${plan.minPart}개`);
   const ratio=qty/requestedQty;
   plan={...plan,qty,parts:split.parts,targetCount:split.targets,merged:split.merged,
    riskUSD:plan.riskUSD*ratio,marginUSD:plan.marginUSD*ratio};
   if(this.cur?.plan)Object.assign(this.cur.plan,{qty,riskUSD:plan.riskUSD});
  }
  // Check the final size and save it in the ledger before yielding to order dispatch.
  this.reservedRisk.delete(u.symbol);
  if(this.budget){
   const b=this.budget.check({equity,newRiskUSD:plan.riskUSD,newMarginUSD:plan.marginUSD,who:'scalp'});
   if(this.cur?.plan&&b.snap?.ok)this.cur.plan.openRiskUSD=+(b.snap.usedUSD+plan.riskUSD).toFixed(2);
   if(!b.ok)return skip(b.reason,b.detail);
  }else{
   const day=kstDay(this.now()),realized=this.store.closed.filter(x=>kstDay(x.closedAt)===day).reduce((t,x)=>t+(Number(x.netUSD)||0),0);
   const risk=Math.max(0,-realized)+this.#openRisk()+plan.riskUSD,limit=equity*this.config.dailyLossPct/100;
   if(this.cur?.plan)this.cur.plan.openRiskUSD=+risk.toFixed(2);
   if(risk>limit)return skip('OPEN_RISK_LIMIT',`$${risk.toFixed(2)} > $${limit.toFixed(2)}`);
  }
  const beforeSend=()=>{
   const blocked=this.#blocked()||(revision!==this.entryRevision?'NOT_ARMED':null);
   if(blocked)return blocked;
   // The pending entry is included in the ledger by the time the order reaches dispatch.
   const shared=this.budget?.check({equity,who:'scalp'});
   return shared&&!shared.ok?shared.reason:null;
  };
  const blocked=beforeSend();if(blocked)return skip(blocked);
  const tick=c.tickSize,px=v=>grid(v,tick,awayMode(d))??String(v);
  const kind=this.cur?.kind||SCALP_KINDS.MOVE;
  const p={id,strategy:SCALP_EXEC_STRATEGY,strategyProfile:SCALP_EXEC_STRATEGY,kind,...(kind===SCALP_KINDS.ZONE&&this.cur?.zone?{zone:this.cur.zone}:{}),mode:'TESTNET',venue:'BINGX',symbol:u.symbol,venueSymbol:vs,direction:d,hedge,...(otherSide?{otherSideSeen:true}:{}),interval:'5m',
   pattern:det.pattern,barAt:det.barAt,plannedEntry:det.entry,checkedPrice:plan.entry,driftPct:plan.driftPct,entry:plan.entry,stop:plan.stop,initialStop:plan.stop,targets:plan.targets,
   qty:plan.qty,initialQty:plan.qty,parts:plan.parts,targetCount:plan.targetCount,merged:plan.merged,leverage:plan.leverage,riskUSD:plan.riskUSD,initialRiskUSD:plan.riskUSD,marginUSD:plan.marginUSD,initialMarginUSD:plan.marginUSD,netRR:plan.netRR,
   tickSize:tick,quantityStep:c.quantityStep,takerRate:plan.takerRate,evidence:det.evidence,status:'SUBMITTING',createdAt:this.now(),deadline:det.barAt+this.config.maxHoldMs,
   avg:null,size:0,filled:0,stopOrderId:null,stopIds:[],tpOrderIds:[null,null,null],tpTries:[0,0,0],breakevenMoved:false,exitIds:[],steps:[],
   stopLossEnabled:this.config.stopLossEnabled!==false,
   ...(this.config.stopLossEnabled===false?{profitTargetsReady:true}:{}),
   ...(plan.scaleIn?{scaleIn:plan.scaleIn}:{}),
   // Journal context (analysis only).
   atr:det.atr,detectedAt:this.cur?.at??null,candle:this.cur?.candle??null,trend4h:this.cur?.trend4h??null,withTrend:this.cur?.withTrend??null,universe:this.cur?.universe??null,scan:this.cur?.scan?{...this.cur.scan}:null,tpFills:[null,null,null],journalV:1};
  this.store.open.push(p);this.store.sent.push(id);this.#save();
  let fill;
  try{fill=await cl.placeOrder({symbol:vs,side:openSide(d),positionSide:positionSideFor({hedge,direction:d}),type:'MARKET',quantity:String(plan.qty),clientOrderId:id,
   ...(p.stopLossEnabled?{stopLoss:JSON.stringify({type:'STOP_MARKET',stopPrice:Number(px(plan.stop)),workingType:'MARK_PRICE'})}:{})},{beforeSend})}
  catch(e){
   if(e?.code==='ENTRY_NOT_SENT'){
    this.store.open=this.store.open.filter(x=>x!==p);this.store.sent=this.store.sent.filter(x=>x!==id);
    this.#save();return skip(e.reason);
   }
   // Never sent blindly again: the client id is looked up first; an unknown outcome blocks new entries.
   let found=null;try{found=await cl.getOrder(vs,{clientOrderId:id})}catch{}
   if(!orderId(found)){
    if(e?.code==='NETWORK_UNREACHABLE'||e?.code==='HTTP_429'){p.status='UNKNOWN';this.#event('ENTRY_OUTCOME_UNKNOWN',{symbol:p.symbol,reason:e.code});this.#save();return {entered:false,reason:'UNKNOWN'}}
    this.store.open=this.store.open.filter(x=>x!==p);this.#save();
    if(e?.code===POSITION_LIMIT_ERROR)return skip('VENUE_POSITION_LIMIT',`${e.code} · 주문 ${plan.qty}개 · 가용 ${venueAvailableQty??'미확인'}`);
    return skip('ENTRY_REJECTED',e?.code||e?.message)}
   fill=found;
  }
  p.entryOrderId=orderId(fill);p.status='OPEN';p.openedAt=this.now();
  const now=await this.#position(vs,d,hedge).catch(()=>({size:0}));
  const confirmedQty=pos(now.size)??pos(orderOf(fill)?.executedQty),confirmedPrice=pos(now.avg)??pos(orderOf(fill)?.avgPrice);
  if(!p.stopLossEnabled&&(!confirmedQty||!confirmedPrice)){
   p.status='UNKNOWN';this.#event('ENTRY_OUTCOME_UNKNOWN',{symbol:p.symbol,reason:'ENTRY_FILL_UNCONFIRMED'});this.#save();return {entered:false,reason:'UNKNOWN'};
  }
  p.filled=p.size=confirmedQty??plan.qty;p.avg=confirmedPrice??plan.entry;p.firstEntryPrice=confirmedPrice??null;p.initialQty=p.filled;
  if(p.scaleIn){
   p.riskUSD=riskAtStop(d,p.avg,p.initialStop,p.takerRate)*p.filled;p.marginUSD=p.avg*p.filled/p.leverage;
   Object.assign(p.scaleIn,{initialEntry:p.avg,initialQty:p.filled,initialMarginUSD:p.marginUSD,initialRiskUSD:p.riskUSD});
  }
  p.initialRiskUSD=p.riskUSD;p.initialMarginUSD=p.marginUSD;
  if(!p.stopLossEnabled)this.#enableRepeat(p);
  if(Math.abs(p.filled-plan.qty)>Number(c.quantityStep)/2){const s=scalpSplits(p.filled,c.quantityStep,0);if(s)p.parts=s.parts}
  p.steps.push({kind:'OPEN',at:this.now(),qty:p.filled,avg:p.avg});this.#save();
  if(!await this.#protect(p))return {entered:false,reason:p.closeReason||'NO_STOP'};
  await this.#placeTargets(p);
  trackExcursion(p,p.avg,this.now());
  // BTC 5m / 1h change around the entry: read after the orders are in, never awaited (journal only).
  void withTimeout(this.#btc(),5000).then(b=>{if(b)p.btc=b});
  this.#event('OPENED',{symbol:p.symbol,direction:d,id:p.id,kind:p.kind,...(p.zone?{zone:{tf:p.zone.tf,low:p.zone.low,high:p.zone.high,distPct:p.zone.distPct}}:{}),entry:p.avg,stop:p.stop,stopLossEnabled:p.stopLossEnabled,targets:p.targets,parts:p.parts,qty:p.filled,leverage:p.leverage,riskUSD:+p.riskUSD.toFixed(2),movePct:det.evidence?.movePct,volumeX:det.evidence?.climaxVolumeRatio,merged:p.merged});
  this.#save();return {entered:true};
 }
 /** BTC change over the last closed 5m candle and the last hour (12 candles), cached per 5m candle. */
 async #btc(){
  const b=Math.floor(this.now()/I5);if(this.btcCache?.b===b)return this.btcCache.v;
  const rows=(await this.candles('BTCUSDT','5m',14).catch(()=>[])||[]).filter(r=>Number(r?.[6])<this.now()),c=rows.map(r=>Number(r[4]));
  const pct=(a,b2)=>a>0&&b2>0?Math.round((a/b2-1)*1e6)/1e4:null;
  const v=c.length>=2?{change5mPct:pct(c.at(-1),c.at(-2)),change1hPct:c.length>=13?pct(c.at(-1),c.at(-13)):null,at:Number(rows.at(-1)[6])}:null;
  this.btcCache={b,v};return v;
 }
 /** One line per detected signal: entered, or why not (scalp-signals.jsonl, rotated at 20 MB). */
 #logSignal(ctx,r){
  const line={v:1,at:ctx.at,symbol:ctx.symbol,venueSymbol:ctx.venueSymbol,kind:ctx.kind||SCALP_KINDS.MOVE,...(ctx.zone?{zone:ctx.zone}:{}),direction:ctx.direction,barAt:ctx.barAt,entered:r?.entered===true,reason:r?.entered?null:ctx.reason||r?.reason||null,
   detail:ctx.detail,evidence:ctx.evidence,candle:ctx.candle,atr:ctx.atr,trend4h:ctx.trend4h??null,withTrend:ctx.withTrend??null,plan:ctx.plan??null,universe:ctx.universe,scan:ctx.scan,
   ...(ctx.recheckedAt?{recheckedAt:ctx.recheckedAt}:{}),...(ctx.wyckoff?{wyckoff:ctx.wyckoff,vsa:ctx.vsa,aiLens:ctx.aiLens}:{})};
  if(this.signalsFile)appendJsonl(signalsPath(this.signalsFile,ctx.at||this.now()),line,{maxBytes:SIGNALS_MAX_BYTES});else this.signalsMem=[...(this.signalsMem||[]),line].slice(-500);
 }
 /** Closed trades whose result is final (settled by the venue, or no more settle tries) go to the journal. */
 #flushJournal(){
  const now=this.now(),income=typeof this.client?.income==='function';
  for(const x of this.store.closed){
   if(x.journaled)continue;
   if(!(x.realized||!income||x.otherSideSeen||(x.settleTries||0)>=SETTLE_TRIES||now-(x.closedAt||0)>=2*3600000))continue;
   // Already in the file (written before a restart that came before the ledger was saved): not again.
   if(x.id&&this.journalIds?.has(x.id)){x.journaled=true;continue}
   x.journalAt=now;if(!x.journalV)x.journalBackfill=true;
   let line;try{line=journalLine(x)}catch(e){this.log?.('[SCALP] journal line',x.symbol,e.message);continue}
   if(this.journalFile&&!appendJsonl(this.journalFile,line))continue; // not written: tried again next check
   if(!this.journalFile)this.journalMem.push(line);
   x.journaled=true;x.rMultiple=line.pnl?.r??null;if(x.id)this.journalIds?.add(x.id);
   this.journalRows.push({kind:x.kind||SCALP_KINDS.MOVE,direction:x.direction,netUSD:line.pnl.netUSD,closedAt:x.closedAt,closeReason:x.closeReason,scaleIn:line.scaleIn});
  }
 }
 /** The newest `limit` journal lines (oldest first). */
 journal(limit=200){
  const n=Math.max(1,Math.min(2000,Math.floor(Number(limit))||200));
  const rows=this.journalFile?tailJsonl(this.journalFile,n):this.journalMem.slice(-n);
  return rows.map(x=>x.margin?x:{...x,margin:scalpMargin(x)});
 }
 signals(limit=200){if(!this.signalsFile)return (this.signalsMem||[]).slice(-limit);const now=this.now(),today=tailJsonl(signalsPath(this.signalsFile,now),limit);
  return today.length>=limit?today:[...tailJsonl(signalsPath(this.signalsFile,now-86400000),limit-today.length),...today]}
 /** Logged scalp signals over the last N KST days (oldest first, capped at 5000). */
 recentSignals(days=7){
  const n=Math.max(1,Math.min(30,Math.floor(Number(days))||7)),now=this.now(),since=now-n*86400000;
  if(!this.signalsFile)return (this.signalsMem||[]).filter(x=>(Number(x?.at)||Number(x?.barAt)||0)>=since).slice(-5000);
  const out=[];
  for(let d=n-1;d>=0;d--){
   const f=signalsPath(this.signalsFile,now-d*86400000);
   const rotated=f.replace(/\.jsonl$/,'')+'.1.jsonl';
   for(const row of [...readJsonl(rotated),...readJsonl(f)]){
    if((Number(row?.at)||Number(row?.barAt)||0)>=since)out.push(row);
   }
  }
  return out.slice(-5000);
 }
 /** Journaled plus unjournaled closed scalp trades over the last N days. */
 recentTrades(days=7){
  const n=Math.max(1,Math.min(30,Math.floor(Number(days))||7)),since=this.now()-n*86400000;
  const rows=this.journal(2000).filter(x=>(Number(x?.exit?.at)||Number(x?.barAt)||0)>=since);
  const seen=new Set(rows.map(x=>x?.id).filter(Boolean));
  for(const x of this.store.closed){
   if(x.journaled||x.id&&seen.has(x.id)||(Number(x.closedAt)||0)<since)continue;
   try{rows.push(journalLine(x))}catch{}
  }
  return rows;
 }
 /** The venue position of this symbol: `size` is the quantity on our side (a position on the other side
  * counts as 0 for us and is never closed by us), `any` any position at all. */
 async #position(vs,direction,hedge=false){return positionOf(await this.client.positions(vs),vs,direction,hedge)}
 async #openOrders(vs){const o=await this.client.openOrders(vs);return o?.orders??(Array.isArray(o)?o:[])}
 /** The attached stop is confirmed; else a whole-position stop is placed; else the position is closed. */
 async #protect(p){
  if(this.config.stopLossEnabled===false)return this.#retireStop(p);
  let list=null;try{list=await this.#openOrders(p.venueSymbol)}catch{try{list=await this.#openOrders(p.venueSymbol)}catch{}}
  // The stop attached to the entry (same price within a tick when the venue reports it).
  const found=(list||[]).find(o=>String(o.type).startsWith('STOP')&&orderOnSide(o,{hedge:p.hedge===true,direction:p.direction})&&(!pos(o.stopPrice)||Math.abs(Number(o.stopPrice)-p.stop)<=Number(p.tickSize)*1.01));
  if(found){p.stopOrderId=orderId(found);p.stopIds.push(p.stopOrderId);return true}
  try{const s=await this.client.placeOrder(this.#stopParams(p,p.stop,'s'));p.stopOrderId=orderId(s);p.stopIds.push(p.stopOrderId);this.#event('STOP_PLACED',{symbol:p.symbol});return true}
  catch(e){this.#event('STOP_FAILED',{symbol:p.symbol,reason:e?.code||e?.message});await this.#emergency(p,'NO_STOP');this.disarm('NO_PROTECTIVE_STOP');return false}
 }
 #stopParams(p,price,tag,mode=awayMode(p.direction)){return {symbol:p.venueSymbol,side:closeSide(p.direction),positionSide:positionSideFor({hedge:p.hedge===true,direction:p.direction}),type:'STOP_MARKET',quantity:String(p.size),stopPrice:grid(price,p.tickSize,mode)??String(price),closePosition:'true',workingType:'MARK_PRICE',clientOrderId:(p.id+tag).slice(0,40)}}
 async #retireStop(p){
  if(p.stopRetired)return true;
  if(p.stopLossEnabled===false&&!p.stopOrderId&&!p.stopIds.length){p.stopRetired=true;return true}
  const vs=p.venueSymbol,ids=new Set([p.stopOrderId,...p.stopIds].filter(Boolean)),side={hedge:p.hedge===true,direction:p.direction};
  const owned=o=>{
   if(!/^STOP(?:_|$)/i.test(String(o?.type))||!orderOnSide(o,side)||o.side&&String(o.side).toUpperCase()!==closeSide(p.direction))return false;
   const cid=String(o.clientOrderId??o.clientOrderID??''),tag=cid.slice(p.id.length);
   const parent=o.parentOrderId??o.parentOrderID;
   return ids.has(orderId(o))||cid.startsWith(p.id)&&/^(s|ws|b\d+|r\d+)$/.test(tag)||parent!=null&&String(parent)===p.entryOrderId;
  };
  try{
   const open=await this.#openOrders(vs),stops=open.filter(owned);
   for(const order of stops){const id=orderId(order);if(!id)return false;if(!ids.has(id)){ids.add(id);p.stopIds.push(id);this.#save()}
    try{await this.client.cancelOrder(vs,id)}catch(e){if(e?.code==='HTTP_429')throw e}}
   if(stops.length&&(await this.#openOrders(vs)).some(owned))throw err('SCALP_STOP_CANCEL_PENDING');
   p.stopOrderId=null;p.stopRetired=true;p.stopLossEnabled=false;p.stopRetirementError=null;
   if(stops.length)this.#event('SCALP_STOP_REMOVED',{symbol:p.symbol,direction:p.direction});
   this.#save();return true;
  }catch(e){const reason=e?.code||e?.message;if(p.stopRetirementError!==reason)this.#event('SCALP_STOP_CANCEL_PENDING',{symbol:p.symbol,reason});p.stopRetirementError=reason;return false}
 }
 #partialTooSmall(p,size=p.size){
  const base=pos(p.scaleIn?.initialQty)??pos(p.initialQty)??pos(p.filled);
  if(!(base>0))return p.everReduced===true;
  return p.everReduced===true&&!(size>=base*SCALP_REPEAT_SCALE_IN.minPartialRemainRatio-1e-12);
 }
 #repeatStepR(count=0){
  const arr=SCALP_REPEAT_SCALE_IN.stepRs;
  return arr[Math.min(Math.max(0,Number(count)||0),arr.length-1)]??SCALP_REPEAT_SCALE_IN.stepR;
 }
 #repeatMultiplier(count=0){
  const arr=SCALP_REPEAT_SCALE_IN.qtyMultipliers;
  return arr[Math.min(Math.max(0,Number(count)||0),arr.length-1)]??1;
 }
 async #isFallingKnife(symbol,direction,now){
  if(typeof this.candles!=='function')return false;
  const rows=await withTimeout(this.candles(symbol,'5m',3),2500);
  if(!Array.isArray(rows)||!rows.length)return false;
  const closed=rows.filter(r=>{const ct=Number(r?.[6]);return ct>0&&ct<now&&now-ct<=2*I5});
  const bar=closed.at(-1);
  if(!bar)return false;
  const o=Number(bar[1]),h=Number(bar[2]),l=Number(bar[3]),c=Number(bar[4]),range=h-l;
  if(!(range>0&&o>0&&c>0))return false;
  const body=Math.abs(c-o);
  if(direction==='SHORT')return c>o&&body/range>=0.65&&(h-c)/range<0.20;
  return c<o&&body/range>=0.65&&(c-l)/range<0.20;
 }
 #enableRepeat(p){
  if(!this.config.scaleIn)return;
  if(p.scaleIn?.version===SCALP_REPEAT_SCALE_IN.version){
   // Re-open positions that were previously skipped solely due to partial exit when >=25% remains and under maxAdds.
   if(p.scaleIn.state==='SKIPPED'&&p.scaleIn.reason==='POSITION_CHANGED'&&!this.#partialTooSmall(p)&&(p.scaleIn.count||0)<SCALP_REPEAT_SCALE_IN.maxAdds){
    p.scaleIn.state='WATCH';p.scaleIn.reason=null;this.#save();
   }
   return;
  }
  const a=p.scaleIn,opening=p.steps?.find(s=>s.kind==='OPEN'),initialEntry=pos(a?.initialEntry)??pos(opening?.avg)??pos(p.avg);
  const initialQty=pos(a?.initialQty)??pos(opening?.qty)??pos(p.filled);
  if(!initialEntry||!initialQty||!pos(p.leverage))return;
  const legacyCount=pos(a?.fillQty)?1:0;
  if(a)p.legacyScaleIn=a;
  p.scaleIn={version:SCALP_REPEAT_SCALE_IN.version,state:'WATCH',initialEntry,initialQty,initialMarginUSD:pos(a?.initialMarginUSD)??initialEntry*initialQty/p.leverage,
   minPart:pos(a?.minPart)??Number(p.quantityStep),minNotional:pos(a?.minNotional)??0,
   count:0,orders:[],attempt:0,anchor:legacyCount?pos(a?.fillPrice)??initialEntry:initialEntry};
 }
 #repeatDistance(p){
  const entry=pos(p.scaleIn?.initialEntry)??pos(p.avg)??p.entry;
  return Math.max(Number(p.tickSize),Math.abs(entry-p.initialStop)*this.#repeatStepR(p.scaleIn?.count||0));
 }
 #repeatTrigger(p){return p.scaleIn.anchor-dirOf(p.direction)*this.#repeatDistance(p)}
 #repeatRisk(p,entry,mark){
  const dir=dirOf(p.direction),worst=(pos(mark)??entry)-dir*this.#repeatDistance(p);
  const reference=dir>0?Math.max(Number(p.tickSize),Math.min(p.initialStop,worst)):Math.max(p.initialStop,worst);
  return riskAtStop(p.direction,entry,reference,p.takerRate||SCALP_EXEC_COSTS.takerRate);
 }
 async #considerRepeat(p,mark){
  const a=p.scaleIn,dir=dirOf(p.direction),bucket=Math.floor(this.now()/I5),step=Number(p.quantityStep);
  if(!this.config.scaleIn||a?.state!=='WATCH'||this.#blocked()||!mark||bucket<=Math.floor(p.openedAt/I5)||a.checkedBucket===bucket)return;
  if((a.count||0)>=SCALP_REPEAT_SCALE_IN.maxAdds){a.lastReason='MAX_ADDS_REACHED';return}
  if(this.#partialTooSmall(p)||(!p.everReduced&&Math.abs(p.size-p.filled)>step/2)){this.#addDecision(p,'SKIPPED','POSITION_CHANGED');return}
  const trigger=this.#repeatTrigger(p);
  if(!(trigger>0)||dir*(mark-trigger)>1e-12)return;
  a.checkedBucket=bucket;
  if(await this.#isFallingKnife(p.symbol,p.direction,this.now())){a.lastReason='FALLING_KNIFE';return}
  const revision=this.entryRevision,vs=p.venueSymbol,hedge=p.hedge===true;
  const [price,funds,fresh,levInfo]=await Promise.all([
   withTimeout(this.priceOf(p.symbol,vs),3000),
   this.#funds({requireAvailable:true}),
   this.#position(vs,p.direction,hedge),
   typeof this.client.leverage==='function'?withTimeout(this.client.leverage(vs),2500):null,
  ]);
  if(!funds){a.lastReason='NO_BALANCE';return}
  if(!fresh.avg||Math.abs(fresh.size-p.size)>step/2||Math.abs(fresh.avg-p.avg)>Number(p.tickSize)/2||this.#partialTooSmall(p,fresh.size)){a.lastReason='POSITION_CHANGED';return}
  if(!pos(price)||!fresh.mark||dir*(price-trigger)>1e-12||dir*(fresh.mark-trigger)>1e-12){a.lastReason='PRICE_OUTSIDE_BAND';return}
  const limit=pos(grid(trigger,p.tickSize,awayMode(p.direction)));
  if(!limit||dir*(price-limit)>1e-12){a.lastReason='PRICE_OUTSIDE_BAND';return}
  // Marketable IOC limit with 0.35% slippage allowance (capped near trigger) so thin orderbooks fill partially/fully instead of FOK-canceling.
  const slip=SCALP_REPEAT_SCALE_IN.slippagePct/100;
  const bound=Number(grid(price*(1+dir*slip),p.tickSize,awayMode(p.direction)))||Number(grid(price+dir*Number(p.tickSize),p.tickSize,awayMode(p.direction)));
  const triggerCap=Number(grid(limit*(1+dir*0.0015),p.tickSize,awayMode(p.direction)))||limit;
  const orderPrice=dir>0?Math.min(triggerCap,bound):Math.max(triggerCap,bound);
  const baseQty=p.everReduced?fresh.size:(pos(a.initialQty)??fresh.size);
  const desiredQty=baseQty*this.#repeatMultiplier(a.count||0);
  if(!(desiredQty>=a.minPart&&desiredQty*orderPrice>=a.minNotional)){a.lastReason='MIN_QUANTITY';return}
  const room=this.#scaleBudgetRoom(funds.equity);
  if(!room){a.lastReason='TESTNET_BUDGET';return}
  const rawVenueRoom=p.direction==='SHORT'?levInfo?.availableShortVol:levInfo?.availableLongVol;
  const parsedVenueRoom=typeof rawVenueRoom==='number'||(typeof rawVenueRoom==='string'&&rawVenueRoom.trim()!=='')?num(rawVenueRoom):null;
  const venueRoom=parsedVenueRoom!==null&&parsedVenueRoom>=0?parsedVenueRoom:null;
  if(venueRoom!==null&&!(venueRoom>=a.minPart&&venueRoom*orderPrice>=a.minNotional)){a.lastReason='VENUE_POSITION_LIMIT';return}
  const marginUnit=orderPrice/p.leverage,riskUnit=this.#repeatRisk(p,orderPrice,fresh.mark);
  const extraExistingRisk=Math.max(0,this.#repeatRisk(p,fresh.avg,fresh.mark)*fresh.size-this.#repeatRisk(p,p.avg,p.mark)*p.size);
  const availRisk=Math.max(0,room.risk-extraExistingRisk);
  const cap=Math.min(funds.available*.9,funds.equity*this.config.maxMarginPct/100-fresh.size*fresh.avg/p.leverage,room.margin);
  // Controlled progressive multiplier capped by confirmed funds, shared budget, and BingX remaining side volume.
  const maxQty=Math.min(desiredQty,cap/marginUnit,riskUnit>0?availRisk/riskUnit:Infinity,venueRoom??Infinity);
  const quantity=Number(grid(Math.max(0,maxQty),p.quantityStep,'DOWN'));
  if(!(quantity>0&&quantity>=a.minPart&&quantity*orderPrice>=a.minNotional)){a.lastReason=venueRoom!==null&&venueRoom<desiredQty?'VENUE_POSITION_LIMIT':'RISK_OR_MARGIN_CAP';return}
  const guard=()=>this.#blocked(p.id)||(revision!==this.entryRevision?'NOT_ARMED':null)
   ||(Math.floor(this.now()/I5)!==bucket?'WINDOW_EXPIRED':null)||(!this.#scaleBudget(funds.equity)?'TESTNET_BUDGET':null);
  if(guard())return;
  // Send IOC limit; on BingX 101429 (symbol position limit) automatically downsize 50% -> 25% before giving up.
  const scales=[1,0.5,0.25];
  let order,lastTryQty=Infinity;
  for(const factor of scales){
   const tryQty=factor===1?quantity:Number(grid(quantity*factor,p.quantityStep,'DOWN'));
   if(!(tryQty>0&&tryQty>=a.minPart&&tryQty*orderPrice>=a.minNotional&&tryQty<lastTryQty)){
    if(factor<1){this.#retryRepeat(p,'VENUE_POSITION_LIMIT');return}
    break;
   }
   lastTryQty=tryQty;
   const margin=tryQty*marginUnit,risk=tryQty*riskUnit;
   a.attempt++;
   const id=p.id+'a'+(a.attempt+1); // a1 was used by the single-add strategy.
   Object.assign(a,{state:'PENDING',clientOrderId:id,attemptedAt:this.now(),limit:orderPrice,requestedQty:tryQty,preAddSize:fresh.size,
    reservedRiskUSD:risk,reservedMarginUSD:margin,plannedMarginUSD:margin,unknownLogged:false,lastReason:null});
   this.#save();
   try{
    order=orderOf(await this.client.placeOrder({symbol:vs,side:openSide(p.direction),positionSide:positionSideFor({hedge,direction:p.direction}),
     type:'LIMIT',timeInForce:'IOC',price:String(orderPrice),quantity:String(tryQty),clientOrderId:id},{beforeSend:guard}));
    break;
   }catch(e){
    if(e?.code===POSITION_LIMIT_ERROR){
     if(factor===scales.at(-1)){this.#retryRepeat(p,'VENUE_POSITION_LIMIT');return}
     continue;
    }
    if(e?.code==='ENTRY_NOT_SENT'||/^VENUE_ERROR_\d+$/.test(e?.code||'')&&!/duplicate|exist/i.test(e?.message||'')){
     this.#retryRepeat(p,e.reason||e.code);return;
    }
    break;
   }
  }
  await this.#recoverRepeat(p,order);
 }
 #retryRepeat(p,reason){
  p.scaleIn.lastReason=reason;this.#addDecision(p,'WATCH',reason);
 }
 async #recoverRepeat(p,order=null){
  const a=p.scaleIn,vs=p.venueSymbol;
  // A restarted legacy add may already have been applied to the position before resizing targets.
  const applied=a.state==='RESIZE';
  if(!applied){
   let absent=false;
   if(!order){
    try{order=orderOf(await this.client.getOrder(vs,{clientOrderId:a.clientOrderId}))}
    catch(e){if(orderAbsent(e))absent=true}
   }
   if(absent){
    const fresh=await this.#position(vs,p.direction,p.hedge===true).catch(()=>null);
    const baseSize=pos(a.preAddSize)??pos(p.size)??p.filled;
    if(fresh&&Number.isFinite(fresh.size)&&fresh.size<=baseSize+(Number(p.quantityStep)||0)/2){
     if(a.version===SCALP_REPEAT_SCALE_IN.version)this.#retryRepeat(p,'ORDER_NOT_FOUND');else this.#addDecision(p,'SKIPPED','ORDER_NOT_FOUND');
     return;
    }
   }
   const status=String(order?.status).toUpperCase();
   if(!['FILLED','CANCELED','CANCELLED','EXPIRED','REJECTED','FAILED'].includes(status)){
    if(this.now()-(a.attemptedAt||0)>=5*60000){
     try{if(order?.orderId)await this.client.cancelOrder(vs,orderId(order))}catch{}
     if(a.version===SCALP_REPEAT_SCALE_IN.version)this.#retryRepeat(p,'ORDER_TIMEOUT');else this.#addDecision(p,'SKIPPED','ORDER_TIMEOUT');
     return;
    }
    if(!a.unknownLogged){a.unknownLogged=true;this.#event('SCALE_IN_PENDING',{symbol:p.symbol,reason:'ORDER_OUTCOME_UNKNOWN'});this.#save()}
    return;
   }
   const added=pos(order.executedQty),fill=pos(order.avgPrice);
   if((!added&&status==='FILLED')||(added&&!fill))return;
   if(!added){if(a.version===SCALP_REPEAT_SCALE_IN.version)this.#retryRepeat(p,'NOT_FILLED');else this.#addDecision(p,'SKIPPED','NOT_FILLED');return}
   const prevSize=pos(a.preAddSize)??pos(p.size)??p.filled;
   const newSize=prevSize+added;
   const total=p.filled+added;
   Object.assign(a,{fillQty:added,fillPrice:fill,fillMarginUSD:fill*added/p.leverage,filledAt:this.now()});
   p.avg=(p.avg*prevSize+fill*added)/newSize;p.filled=total;p.size=newSize;p.marginUSD=p.avg*newSize/p.leverage;
   p.trailPeakRoePct=null;
   p.steps.push({kind:'ADD',at:a.filledAt,qty:added,avg:p.avg});
   a.state='RESIZE';this.#save();
  }
  const fresh=await this.#position(vs,p.direction,p.hedge===true);
  // Persist the fill and take-profit allocation together. Restarting can only resubmit a target by its same client ID.
  const alreadyAllocated=a.version!==SCALP_REPEAT_SCALE_IN.version&&applied;
  const extra=alreadyAllocated?Math.max(0,p.filled-p.parts.reduce((n,q)=>n+q,0)):a.fillQty;
  let committed=p.parts.reduce((n,q)=>n+q,0)+(p.addTargets||[]).reduce((n,g)=>n+g.parts.reduce((sum,q)=>sum+q,0),0);
  const expectedSize=pos(a.preAddSize)?a.preAddSize+a.fillQty:p.filled;
  if(fresh.size+Number(p.quantityStep)/2<expectedSize){
   const ids=[...p.tpOrderIds,...(p.addTargets||[]).flatMap(g=>g.ids)].filter(Boolean);
   let reduced=0;
   for(const id of ids){const current=orderOf(await this.client.getOrder(vs,{orderId:id}));reduced+=pos(current?.executedQty)??0}
   if(reduced+Number(p.quantityStep)/2<expectedSize-fresh.size&&this.now()-a.filledAt<45000)return;
   committed-=reduced;
   p.everReduced=true;
  }else if(p.everReduced&&pos(a.preAddSize)){
   committed=Math.min(committed,a.preAddSize);
  }
  const room=Math.min(extra,Math.max(0,fresh.size-committed));
  const split=scalpSplits(room,p.quantityStep,a.minPart);
  if(split)(p.addTargets??=[]).push({key:String(a.attempt??0),parts:split.parts,ids:[null,null,null],tries:[0,0,0]});
  if(a.version===SCALP_REPEAT_SCALE_IN.version){
   a.count++;a.anchor=a.fillPrice;
   a.orders.push({at:a.filledAt,qty:a.fillQty,price:a.fillPrice,marginUSD:a.fillMarginUSD});
  }
  delete a.preAddSize;
  p.size=fresh.size;p.mark=fresh.mark??p.mark;p.riskUSD=a.riskAfterUSD=this.#repeatRisk(p,p.avg,p.mark)*fresh.size;
  const nextState=a.version!==SCALP_REPEAT_SCALE_IN.version||!(fresh.size>0)?'FILLED'
   :this.#partialTooSmall(p,fresh.size)?'SKIPPED'
   :(a.count>=SCALP_REPEAT_SCALE_IN.maxAdds?'FILLED':'WATCH');
  Object.assign(a,{state:nextState,reason:fresh.size>0?(nextState==='SKIPPED'?'POSITION_CHANGED':null):'FLAT_DURING_RESIZE'});
  this.#save();this.#event('SCALE_IN_FILLED',{symbol:p.symbol,direction:p.direction,count:a.count,fillMarginUSD:a.fillMarginUSD,qty:a.fillQty,price:a.fillPrice,left:p.size});
  if(!fresh.size){await this.#finish(p);return}
  await this.#placeTargets(p);
 }
 #addDecision(p,state,reason=null){
  Object.assign(p.scaleIn,{state,reason});
  this.#event('SCALE_IN_'+state,{symbol:p.symbol,direction:p.direction,reason});
  this.#save();
 }
 async #wholeStopForAdd(p,quantity){
  const old=p.stopOrderId,vs=p.venueSymbol;
  const matches=o=>o&&String(o.type).toUpperCase()==='STOP_MARKET'&&(!o.workingType||o.workingType==='MARK_PRICE')
   &&orderOnSide(o,{hedge:p.hedge===true,direction:p.direction})&&Math.abs(Number(o.stopPrice)-p.initialStop)<Number(p.tickSize)*.51;
  const orders=await this.#openOrders(vs);
  if(orders.some(o=>orderId(o)===old&&matches(o)&&String(o.closePosition).toLowerCase()==='true'))return true;
  const params=this.#stopParams(p,p.initialStop,'ws');
  let placed=null;
  try{placed=await this.client.placeOrder({...params,quantity:String(Number(quantity.toFixed(12)))})}
  catch(e){
   if(!/110406/.test(String(e?.code||e?.message))||!old)throw e;
   await this.client.cancelOrder(vs,old);p.stopOrderId=null;
   try{placed=await this.client.placeOrder({...params,clientOrderId:(p.id+'ws2').slice(0,40),quantity:String(Number(quantity.toFixed(12)))})}
   catch(e2){try{const r=await this.client.placeOrder(this.#stopParams(p,p.stop,'wsr'));p.stopOrderId=orderId(r);if(p.stopOrderId)p.stopIds.push(p.stopOrderId);this.#save()}catch{}throw e2}
  }
  const id=orderId(placed);
  if(!id)return false;
  p.stopIds.push(id);this.#save();
  const active=await this.#openOrders(vs);
  if(!active.some(o=>orderId(o)===id&&matches(o)&&(o.closePosition==null||String(o.closePosition).toLowerCase()==='true'))){await this.client.cancelOrder(vs,id);return false}
  if(old&&old!==id&&orders.some(o=>orderId(o)===old))await this.client.cancelOrder(vs,old);
  p.stopOrderId=id;this.#save();return true;
 }
 /** One attempt: closed midpoint retest after entry, then a price in the band in the immediately following candle. */
 async #considerAdd(p,mark){
  if(this.config.stopLossEnabled===false)return this.#considerRepeat(p,mark);
  const a=p.scaleIn,now=this.now(),bucket=Math.floor(now/I5)*I5,dir=dirOf(p.direction);
  if(!a||a.state!=='WATCH')return;
  if(now>=Math.min(p.deadline,p.openedAt+SCALP_SCALE_IN.windowBars*I5))return this.#addDecision(p,'SKIPPED',a.lastReason||'WINDOW_EXPIRED');
  if(p.breakevenMoved||p.size<p.filled-Number(p.quantityStep)/2)return this.#addDecision(p,'SKIPPED','FIRST_REDUCTION');
  if(!this.config.scaleIn||this.#blocked()||!mark||bucket<=p.openedAt||a.checkedBucket===bucket)return;
  const revision=this.entryRevision,vs=p.venueSymbol,entry=p.avg,stop=p.initialStop,distance=dir*(entry-stop);
  if(!(distance>0))return this.#addDecision(p,'SKIPPED','ENTRY_AT_OR_BEYOND_STOP');
  const level=price=>dir*(price-stop)/distance;
  const bars=await withTimeout(this.candles(p.symbol,'5m',3),3000);
  const row=(bars||[]).find(r=>Number(r[0])===bucket-I5&&Number(r[6])<now);
  if(!row||Number(row[0])<p.openedAt)return;
  a.checkedBucket=bucket;
  const [open,high,low,close]=row.slice(1,5).map(Number),adverse=dir>0?low:high,favorable=dir>0?high:low;
  if(![open,high,low,close].every(pos))return;
  if(level(adverse)<=SCALP_SCALE_IN.near)a.touchedAt=Number(row[6]);
  if(level(adverse)<=0||dir*(p.targets[0]-favorable)<=0||level(adverse)>SCALP_SCALE_IN.near
    ||level(close)<SCALP_SCALE_IN.near||dir*(close-open)<=0)return;
  a.recoveredAt=Number(row[6]);
  const [price,funds]=await Promise.all([withTimeout(this.priceOf(p.symbol,vs),3000),this.#funds()]);
  if(!funds){a.lastReason='NO_BALANCE';return}
  if(!pos(price)||level(price)<SCALP_SCALE_IN.near||level(price)>SCALP_SCALE_IN.far||level(mark)<=0){a.lastReason='PRICE_OUTSIDE_BAND';return}
  const bandEdge=stop+dir*distance*SCALP_SCALE_IN.far,tick=Number(p.tickSize);
  const limit=Number(grid(dir>0?Math.min(price+tick,bandEdge):Math.max(price-tick,bandEdge),p.tickSize,awayMode(p.direction)));
  if(!(level(limit)>=SCALP_SCALE_IN.near&&level(limit)<=SCALP_SCALE_IN.far+1e-9))return;
  const budget=Math.min(a.budgetUSD,funds.equity*a.riskPct/100),fee=p.takerRate;
  const unit=riskAtStop(p.direction,limit,stop,fee),heldRisk=riskAtStop(p.direction,entry,stop,fee)*p.size;
  const shared=this.budget?.snapshot(funds.equity,{who:'scalp'});
  if(shared&&!shared.ok){a.lastReason='TESTNET_BUDGET_UNAVAILABLE';return}
  const cap=Math.min(funds.available*.9,funds.equity*this.config.maxMarginPct/100-p.size*entry/p.leverage,
   (shared?.marginCapUSD??funds.equity*this.config.maxTotalMarginPct/100)-(shared?.marginUSD??this.#usedMargin()));
  const initialNotional=p.filled*entry,quantity=Number(grid(initialNotional/limit,p.quantityStep,'DOWN'));
  const risk=quantity*unit,margin=quantity*limit/p.leverage;
  if(!(quantity>0&&quantity>=a.minPart&&quantity*limit>=a.minNotional)){a.lastReason='MIN_QUANTITY';return}
  if(heldRisk+risk>budget+1e-9||margin>cap+1e-9){a.lastReason='RISK_OR_MARGIN_CAP';return}
  if(!this.#scaleBudget(funds.equity,risk,margin)){a.lastReason='TESTNET_BUDGET';return}
  const guard=()=>this.#blocked(p.id)||(revision!==this.entryRevision?'NOT_ARMED':null)
   ||(this.now()>=Math.min(bucket+I5,p.deadline,p.openedAt+SCALP_SCALE_IN.windowBars*I5)?'WINDOW_EXPIRED':null)
   ||(!this.#scaleBudget(funds.equity)?'TESTNET_BUDGET':null);
  if(guard())return;
  try{if(!await this.#wholeStopForAdd(p,p.size+quantity))return this.#addDecision(p,'SKIPPED','NO_WHOLE_POSITION_STOP')}
  catch{return this.#addDecision(p,'SKIPPED','NO_WHOLE_POSITION_STOP')}
  const fresh=await this.#position(vs,p.direction,p.hedge===true);
  if(Math.abs(fresh.size-p.size)>Number(p.quantityStep)/2||!fresh.mark||level(fresh.mark)<=0||dir*(p.targets[0]-fresh.mark)<=0
     ||!fresh.avg||Math.abs(fresh.avg-entry)>Number(p.tickSize)/2)
   return this.#addDecision(p,'SKIPPED','POSITION_CHANGED');
  const blocked=guard()||(!this.#scaleBudget(funds.equity,risk,margin)?'TESTNET_BUDGET':null);
  if(blocked)return this.#addDecision(p,'SKIPPED',blocked);
  const id=p.id+'a1';
  Object.assign(a,{state:'PENDING',clientOrderId:id,attemptedAt:this.now(),limit,requestedQty:quantity,reservedRiskUSD:risk,reservedMarginUSD:margin,
   initialEntry:entry,initialQty:p.filled,initialMarginUSD:initialNotional/p.leverage,plannedMarginUSD:margin,budgetAtAddUSD:budget});
  this.#save();
  let order;
  try{order=orderOf(await this.client.placeOrder({symbol:vs,side:openSide(p.direction),positionSide:positionSideFor({hedge:p.hedge===true,direction:p.direction}),
   type:'LIMIT',timeInForce:'FOK',price:String(limit),quantity:String(quantity),clientOrderId:id},{beforeSend:guard}))}
  catch(e){
   if(e?.code==='ENTRY_NOT_SENT'||e?.code==='HTTP_429')return this.#addDecision(p,'SKIPPED',e.reason||e.code);
   const found=orderOf(await this.client.getOrder(vs,{clientOrderId:id}).catch(()=>null));
   if(!orderId(found)&&/^VENUE_ERROR_\d+$/.test(e?.code||'')&&!/duplicate|exist/i.test(e?.message||''))
    return this.#addDecision(p,'SKIPPED',e.code);
   order=found;
  }
  await this.#recoverAdd(p,order);
 }
 #scaleBudget(equity,risk=0,margin=0){
  if(this.budget)return this.budget.check({equity,newRiskUSD:risk,newMarginUSD:margin,who:'scalp'}).ok;
  const room=this.#scaleBudgetRoom(equity);
  return risk<=room.risk+1e-9&&margin<=room.margin+1e-9;
 }
 #scaleBudgetRoom(equity){
  if(this.budget){
   const {ok,snap}=this.budget.check({equity,who:'scalp'});
   return ok?{risk:snap.limitUSD-snap.usedUSD,margin:snap.marginCapUSD-snap.marginUSD}:null;
  }
  const source=this.budgetSource(),realized=source.realizedToday(kstDay(this.now()));
  return {risk:equity*this.config.dailyLossPct/100-Math.max(0,-realized)-source.openRisk(),
   margin:equity*this.config.maxTotalMarginPct/100-source.usedMargin()};
 }
 async #recoverAdd(p,order=null){
  if(this.config.stopLossEnabled===false)return this.#recoverRepeat(p,order);
  const a=p.scaleIn,vs=p.venueSymbol;
  if(a.state==='PENDING'){
   let absent=false;
   if(!order){
    try{order=orderOf(await this.client.getOrder(vs,{clientOrderId:a.clientOrderId}))}
    catch(e){if(orderAbsent(e))absent=true}
   }
   if(absent){
    const fresh=await this.#position(vs,p.direction,p.hedge===true).catch(()=>null);
    if(fresh&&Number.isFinite(fresh.size)&&fresh.size<=p.filled+(Number(p.quantityStep)||0)/2)
     return this.#addDecision(p,'SKIPPED','ORDER_NOT_FOUND');
   }
   const terminal=['FILLED','CANCELED','CANCELLED','EXPIRED','REJECTED','FAILED'].includes(String(order?.status).toUpperCase());
   if(!terminal){
    if(!a.unknownLogged){a.unknownLogged=true;this.#event('SCALE_IN_PENDING',{symbol:p.symbol,reason:'ORDER_OUTCOME_UNKNOWN'});this.#save()}
    if(this.now()>=p.deadline){
     const current=await this.#position(vs,p.direction,p.hedge===true);if(current.size>0)await this.#market(p,'ax'+(p.exitTries=(p.exitTries||0)+1));
    }
    return;
   }
   const added=pos(order.executedQty),fill=pos(order.avgPrice);
   if(!added){
    if(String(order.status).toUpperCase()==='FILLED')return;
    return this.#addDecision(p,'SKIPPED','NOT_FILLED');
   }
   if(!fill)return;
   const total=p.filled+added;
   a.fillQty=added;a.fillPrice=fill;a.filledAt=this.now();a.fillMarginUSD=fill*added/p.leverage;a.state='RESIZE';
   p.avg=(p.avg*p.filled+fill*added)/total;p.filled=total;p.size=total;
   p.riskUSD=a.riskAfterUSD=riskAtStop(p.direction,p.avg,p.initialStop,p.takerRate)*total;p.marginUSD=p.avg*total/p.leverage;
   p.steps.push({kind:'ADD',at:a.filledAt,qty:added,avg:p.avg});this.#save();
  }
  const fresh=await this.#position(vs,p.direction,p.hedge===true);
  if(fresh.size<=0){this.#addDecision(p,'FILLED','FLAT_DURING_RESIZE');return this.#finish(p)}
  if(Math.abs(fresh.size-p.filled)>Number(p.quantityStep)/2||this.now()>=p.deadline||a.riskAfterUSD>a.budgetAtAddUSD+1e-8){
   this.#addDecision(p,'FILLED','EXIT_DURING_RESIZE');
   return this.#emergency(p,'SCALE_IN_RESIZE_EXIT');
  }
  if(!(await this.#openOrders(vs)).some(o=>orderId(o)===p.stopOrderId)){
   this.#addDecision(p,'FILLED','NO_WHOLE_POSITION_STOP');
   await this.#emergency(p,'NO_STOP');this.disarm('NO_PROTECTIVE_STOP');return;
  }
  for(const [i,id] of p.tpOrderIds.entries()){
   if(!id)continue;
   let old=orderOf(await this.client.getOrder(vs,{orderId:id}));
   if(!['CANCELED','CANCELLED','EXPIRED'].includes(String(old?.status).toUpperCase())){
    if(!pos(old?.executedQty))await this.client.cancelOrder(vs,id);
    old=orderOf(await this.client.getOrder(vs,{orderId:id}));
   }
   if(pos(old?.executedQty)){
    this.#addDecision(p,'FILLED','TARGET_FILLED_DURING_RESIZE');
    return this.#emergency(p,'SCALE_IN_RESIZE_EXIT');
   }
   if(!['CANCELED','CANCELLED','EXPIRED'].includes(String(old?.status).toUpperCase()))return;
   p.tpOrderIds[i]=null;this.#save();
  }
  const after=await this.#position(vs,p.direction,p.hedge===true);
  if(Math.abs(after.size-p.filled)>Number(p.quantityStep)/2){
   this.#addDecision(p,'FILLED','POSITION_CHANGED_DURING_RESIZE');
   return this.#emergency(p,'SCALE_IN_RESIZE_EXIT');
  }
  const s=scalpSplits(p.filled,p.quantityStep,a.minPart);
  p.parts=s.parts;p.targetCount=s.targets;p.merged=s.merged;p.tpTries=[0,0,0];
  this.#addDecision(p,'FILLED');await this.#placeTargets(p);
 }
 async #retireLegacyProfitTargets(p){
  if(p.profitTargetsReady)return true;
  const ids=new Set([...(p.tpOrderIds||[]),...(p.addTargets||[]).flatMap(g=>g.ids)].filter(Boolean).map(String));
  const owned=o=>{
   if(String(o?.type).toUpperCase()!=='TAKE_PROFIT_MARKET'||!orderOnSide(o,{hedge:p.hedge===true,direction:p.direction})||
     o.side&&String(o.side).toUpperCase()!==closeSide(p.direction))return false;
   const cid=String(o.clientOrderId??o.clientOrderID??'');
   return ids.has(orderId(o))||cid.startsWith(p.id)&&/^(?:[tu][1-3]\d*|a\d+t[1-3])$/.test(cid.slice(p.id.length));
  };
  const legacy=(await this.#openOrders(p.venueSymbol)).filter(owned);
  for(const order of legacy){
   const id=orderId(order);if(!id)throw err('SCALP_TARGET_CANCEL_PENDING');
   if(!ids.has(id)&&!p.exitIds.includes(id)){p.exitIds.push(id);this.#save()}
   await this.client.cancelOrder(p.venueSymbol,id);
  }
  if(legacy.length&&(await this.#openOrders(p.venueSymbol)).some(owned))throw err('SCALP_TARGET_CANCEL_PENDING');
  p.profitTargetsReady=true;this.#save();return true;
 }
 async #placeTargets(p){
  const profitOnly=this.config.stopLossEnabled===false;
  if(profitOnly)await this.#retireLegacyProfitTargets(p);
  const dir=dirOf(p.direction);
  let price=profitOnly?profitLimit(p):null;
  if(profitOnly&&!price)return;
  const minRoe=profitOnly?(p.scaleIn?.count>0?SCALP_SCALE_IN_MIN_ROE_PCT:(this.config.minProfitRoePct??SCALP_MIN_PROFIT_ROE_PCT)):0;
  let triggerFloor=profitOnly?(profitLimit(p,0,{minNetRoePct:minRoe})??price):null;
  const groups=[{parts:p.parts,ids:p.tpOrderIds,tries:p.tpTries,done:p.tpDone},...(p.addTargets||[])];
  for(const g of groups){
   for(const [i,q] of g.parts.entries()){
    if(!(q>0)||g.ids[i]||g.done?.[i]||g.tries[i]>=3)continue;
    const qtyStr=grid(q,p.quantityStep,'DOWN')??String(q);
    if(!(Number(qtyStr)>0))continue;
    const stable=g.key!=null||p.stopLossEnabled===false;
    const tries=++g.tries[i],tag=g.key!=null?`a${g.key}t${i+1}`:(p.scaleIn?.version===1&&p.scaleIn?.fillQty?'u':'t')+(i+1)+(!stable&&tries>1?tries:'');
    const clientOrderId=(p.id+(profitOnly?'p':'')+tag).slice(0,40);
    const buildParams=({stopPrice,limitPrice,type,cid,qty})=>forMode({
     symbol:p.venueSymbol,side:closeSide(p.direction),positionSide:positionSideFor({hedge:p.hedge===true,direction:p.direction}),
     type,quantity:qty,
     ...(stopPrice!=null?{stopPrice,workingType:'MARK_PRICE'}:{}),
     ...(limitPrice!=null?{price:limitPrice}:{}),
     reduceOnly:'true',clientOrderId:cid,
    },p.hedge===true);
    try{
     if(stable){
      const known=await this.client.getOrder(p.venueSymbol,{clientOrderId}).catch(()=>null),st=String(orderOf(known)?.status||'').toUpperCase();
      if(orderId(known)&&!['CANCELED','CANCELLED','EXPIRED','REJECTED','FAILED'].includes(st)){g.ids[i]=orderId(known);this.#save();continue}
     }
     const target=grid(p.targets[i],p.tickSize,towardMode(p.direction))??String(p.targets[i]);
     let stopPrice=profitOnly&&dir*(Number(target)-Number(triggerFloor))<0?triggerFloor:target;
     const tick=pos(p.tickSize)||0,mark=pos(p.mark),orderType=profitOnly?'TAKE_PROFIT':'TAKE_PROFIT_MARKET';
     if(mark&&tick>0&&dir*(Number(stopPrice)-mark)<=0){
      const bumped=grid(mark+dir*tick,p.tickSize,beMode(p.direction));
      if(bumped&&dir*(Number(bumped)-mark)>0)stopPrice=bumped;
     }
     let o;
     try{
      o=await this.client.placeOrder(buildParams({stopPrice,limitPrice:profitOnly?price:null,type:orderType,cid:clientOrderId,qty:qtyStr}));
     }catch(e){
      const is110401=e?.code==='VENUE_ERROR_110401'||/\b110401\b/.test(String(e?.message||''));
      if(!is110401)throw e;
      let c=null;
      try{const cmap=await withTimeout(this.contracts(p.symbol),3000);c=cmap?.get?.(p.symbol)||null}catch{}
      if(c?.tickSize&&pos(c.tickSize))p.tickSize=c.tickSize;
      if(c?.quantityStep&&pos(c.quantityStep))p.quantityStep=c.quantityStep;
      const freshMark=pos(await withTimeout(this.priceOf(p.symbol,p.venueSymbol),3000))??pos(await withTimeout(this.markOf(p.venueSymbol),3000))??pos(p.mark);
      if(freshMark)p.mark=freshMark;
      const freshQty=grid(q,p.quantityStep,'DOWN')??qtyStr;
      if(!(Number(freshQty)>0))throw e;
      const freshTick=pos(p.tickSize)||0;
      const freshLimit=profitOnly?profitLimit(p):null;
      if(profitOnly&&freshLimit){price=freshLimit;triggerFloor=profitLimit(p,0,{minNetRoePct:minRoe})??freshLimit}
      const freshTarget=grid(p.targets[i],p.tickSize,towardMode(p.direction))??String(p.targets[i]);
      let retryStop=profitOnly&&triggerFloor&&dir*(Number(freshTarget)-Number(triggerFloor))<0?triggerFloor:freshTarget;
      const retryCid=(p.id+(profitOnly?'p':'')+tag+'r'+tries).slice(0,39);
      let recovered=null,how='';
      const profitFloor=freshLimit?Number(freshLimit):p.avg;
      if(profitOnly&&freshLimit&&freshMark&&dir*(freshMark-Number(freshLimit))>=0){
       const limPx=grid(dir>0?Math.max(Number(freshTarget),Number(freshLimit)):Math.min(Number(freshTarget),Number(freshLimit)),p.tickSize,beMode(p.direction))??freshLimit;
       try{recovered=await this.client.placeOrder(buildParams({stopPrice:null,limitPrice:limPx,type:'LIMIT',cid:retryCid,qty:freshQty}));how=`LIMIT@${limPx}`}catch{}
      }
      if(!recovered){
       if(freshMark&&freshTick>0&&dir*(Number(retryStop)-freshMark)<=0){
        const bumped=grid(freshMark+dir*freshTick*2,p.tickSize,beMode(p.direction));
        if(bumped&&dir*(Number(bumped)-freshMark)>0)retryStop=bumped;
       }
       try{
        recovered=await this.client.placeOrder(buildParams({stopPrice:retryStop,limitPrice:profitOnly?(freshLimit??price):null,type:orderType,cid:(retryCid+'a').slice(0,40),qty:freshQty}));
        how=`${orderType}@${retryStop}`;
       }catch(e2){
        if(profitOnly&&dir*(Number(retryStop)-profitFloor)>=0){
         recovered=await this.client.placeOrder(buildParams({stopPrice:null,limitPrice:retryStop,type:'LIMIT',cid:(retryCid+'b').slice(0,40),qty:freshQty}));
         how=`LIMIT@${retryStop}`;
        }else throw e2;
       }
      }
      o=recovered;
      this.#event('TARGET_RECOVERED',{symbol:p.symbol,direction:p.direction,target:i+1,detail:`110401 자동 복구 (${how} · 수량 ${freshQty})`});
     }
     g.ids[i]=orderId(o);
     if(stable&&g.ids[i])this.#save();
    }catch(e){if(e?.code==='HTTP_429')g.tries[i]=Math.max(0,g.tries[i]-1);this.#event('TARGET_FAILED',{symbol:p.symbol,reason:`${i+1}: ${e?.code||e?.message}`})}
   }
  }
 }
 async #market(p,tag){
  const now=await this.#position(p.venueSymbol,p.direction,p.hedge===true);if(!(now.size>0))return now;
  const o=await this.client.placeOrder(forMode({symbol:p.venueSymbol,side:closeSide(p.direction),positionSide:positionSideFor({hedge:p.hedge===true,direction:p.direction}),type:'MARKET',quantity:String(now.size),reduceOnly:'true',clientOrderId:(p.id+tag).slice(0,40)},p.hedge===true));
  const id=orderId(o);if(id)p.exitIds.push(id);return {...now,size:0,exitAvg:pos(orderOf(o)?.avgPrice)};
 }
 #recordEarlyTakeProfit(p,response){
  const o=orderOf(response),id=orderId(o),filled=Number(o?.executedQty)||0;
  if(id&&!p.exitIds.includes(id))p.exitIds.push(id);
  if(filled>0){
   p.everReduced=true;
   if(filled>=p.earlyTakeProfit.qty-Number(p.quantityStep)/2)p.exitReason='EARLY_TAKE_PROFIT';
  }
  if(['FILLED','CANCELED','CANCELLED','EXPIRED','REJECTED','FAILED'].includes(String(o?.status).toUpperCase()))
   delete p.earlyTakeProfit;
  this.#save();
 }
 async #tryEarlyTakeProfit(p,mark){
  const now=this.now(),opened=p.openedAt??p.createdAt,profitOnly=this.config.stopLossEnabled===false;
  const delay=profitOnly?0:EARLY_TAKE_PROFIT_MS,retry=profitOnly?PROFIT_ONLY_RETRY_MS:EARLY_EXIT_RETRY_MS;
  if(this.config.mode!=='TESTNET'||!(opened>0)||now-opened<delay||now-(p.earlyTakeProfitAt??0)<retry||!(mark>0&&p.avg>0&&p.size>0))return false;
  const direction=dirOf(p.direction);
  const qty=Number(grid(p.size,p.quantityStep,'DOWN'));
  if(!(qty>0))return false;
  const bookedLoss=profitOnly?Math.max(0,-(num(p.exchangePosition?.realizedPnLUSD)??0)):0;
  const scaledIn=(p.scaleIn?.count||0)>0;
  let limit;
  if(profitOnly&&scaledIn){
   // Scaled-in positions require >= +5% Net ROE to arm trailing, then ride rebounds and exit on pullback from peak.
   const fee=Math.max(p.takerRate||0,SCALP_EXEC_COSTS.takerRate);
   const reserve=(SCALP_EXEC_COSTS.spreadBps+SCALP_EXEC_COSTS.slippageBps)/10000+SCALP_EXEC_COSTS.fundingRate;
   const lev=Math.max(1,Number(p.leverage)||10);
   const grossMove=direction*(mark-p.avg)/p.avg;
   const lossMove=bookedLoss>0?bookedLoss/(qty*p.avg):0;
   const netRoePct=(grossMove-2*fee-reserve-lossMove)*lev*100;
   if(netRoePct>=SCALP_SCALE_IN_MIN_ROE_PCT){
    const prevPeak=Number(p.trailPeakRoePct);
    if(!Number.isFinite(prevPeak)||netRoePct>prevPeak){p.trailPeakRoePct=+netRoePct.toFixed(2);this.#save()}
   }
   const peak=Number(p.trailPeakRoePct);
   if(!(Number.isFinite(peak)&&peak>=SCALP_SCALE_IN_MIN_ROE_PCT))return false;
   const pullback=Math.max(SCALP_TRAIL_MIN_PULLBACK_ROE,peak*SCALP_TRAIL_PULLBACK_RATIO);
   const trailStopRoe=Math.max(SCALP_SCALE_IN_MIN_ROE_PCT,peak-pullback);
   if(netRoePct>trailStopRoe)return false;
   limit=profitLimit(p,bookedLoss/qty,{minNetRoePct:0});
   if(!(Number(limit)>0&&direction*(mark-Number(limit))>=0))return false;
  }else{
   const fallbackElapsed=now-opened>=PROFIT_ONLY_EARLY_EXIT_MIN*60000;
   const recoveryMode=bookedLoss>0||fallbackElapsed;
   const minNetRoePct=profitOnly&&!recoveryMode?(this.config.minProfitRoePct??SCALP_MIN_PROFIT_ROE_PCT):0;
   limit=profitLimit(p,bookedLoss/qty,{minNetRoePct});
   if(!(Number(limit)>0&&direction*(mark-Number(limit))>=0))return false;
  }
  const clientOrderId=createHash('sha256').update(`${p.id}|early|${now}`).digest('hex').slice(0,32);
  p.earlyTakeProfit={clientOrderId,qty};p.earlyTakeProfitAt=now;this.#save();
  const response=await this.client.placeOrder(forMode({symbol:p.venueSymbol,side:closeSide(p.direction),
   positionSide:positionSideFor({hedge:p.hedge===true,direction:p.direction}),type:'LIMIT',
   timeInForce:'IOC',price:limit,quantity:String(qty),reduceOnly:'true',clientOrderId},p.hedge===true));
  this.#recordEarlyTakeProfit(p,response);
  return true;
 }
 async #emergency(p,reason){
  try{p.exitTries=(p.exitTries||0)+1;await this.#market(p,'e'+p.exitTries);p.exitReason=reason;await this.#finish(p,reason)}
  catch(e){p.status='UNKNOWN';this.#event('EMERGENCY_CLOSE_FAILED',{symbol:p.symbol,reason:e?.code||e?.message})}
 }
 /** Stop to the entry price after TP1 (backtest: from the next candle on). The new stop goes in
  * first; BingX refusing a second stop (110406) -> swap; nothing placed -> closed at market. */
 async #breakeven(p,mark){
  // Each attempt has its own order ids (a retry 15 s later must not reuse a refused/duplicate id).
  const n=p.beTries=(p.beTries||0)+1;
  const dir=dirOf(p.direction),be=Number(grid(p.avg,p.tickSize,beMode(p.direction)))||p.avg;
  if(!(dir*(be-p.stop)>0)){p.breakevenMoved=true;return}
  // Price already back at the entry (the backtest's next candle would stop out at its open): close now.
  if(mark&&dir*(mark-be)<=0){const r=await this.#market(p,'b'+n);p.exitReason='BREAKEVEN_STOP';p.breakevenMoved=true;p.breakevenAt=this.now();if(!(r.size>0))await this.#finish(p);return}
  const params=this.#stopParams(p,be,'b'+n,beMode(p.direction)),old=p.stopOrderId;
  let placed=null;
  try{placed=orderId(await this.client.placeOrder(params))}
  catch(e){
   if(!/110406/.test(String(e?.code||e?.message))||!old)throw e;
   await this.client.cancelOrder(p.venueSymbol,old);p.stopOrderId=null;
   try{placed=orderId(await this.client.placeOrder({...params,clientOrderId:(p.id+'b2'+n).slice(0,40)}))}
   catch(e2){try{p.stopOrderId=orderId(await this.client.placeOrder(this.#stopParams(p,p.stop,'r'+n)));p.stopIds.push(p.stopOrderId)}catch{await this.#emergency(p,'NO_STOP');return}throw e2}
  }
  p.stopOrderId=placed;p.stopIds.push(placed);p.stop=be;p.breakevenMoved=true;p.breakevenAt=this.now();
  if(old&&old!==placed){try{await this.client.cancelOrder(p.venueSymbol,old)}catch{}}
  this.#event('STOP_TO_BREAKEVEN',{symbol:p.symbol,direction:p.direction,price:be});
 }
 /** Routine check: fills, TP1 -> breakeven, time exit, closes, results, the daily loss limit. */
 async reconcile(){
  if(this.reconciling||!this.client)return;this.reconciling=true;this.lastReconcileAt=this.now();
  try{
   let list=null;
   if(this.store.open.length){try{list=await this.client.positions()}catch(e){if(e?.code==='HTTP_429')this.cooldownUntil=this.now()+60000;this.#event('RECONCILE_ERROR',{reason:e?.code||e?.message});return}}
   let unrealized=0;
   for(const p of [...this.store.open]){
    // An entry still being placed (its stop / targets not yet sent) is left to the entry path.
    if(p.status==='SUBMITTING'||this.reserved.has(p.symbol))continue;
    try{
     if(p.scaleIn?.state==='PENDING'||p.scaleIn?.state==='RESIZE'){
      if(this.config.stopLossEnabled===false)await this.#retireStop(p);
      await this.#recoverAdd(p);continue;
     }
     const {size,row,other}=positionOf(list,p.venueSymbol,p.direction,p.hedge===true),mark=pos(row?.markPrice);
     if(p.earlyTakeProfit){
      try{this.#recordEarlyTakeProfit(p,await this.client.getOrder(p.venueSymbol,{clientOrderId:p.earlyTakeProfit.clientOrderId}))}
      catch(e){if(e?.code!=='VENUE_ERROR_80016')throw e;delete p.earlyTakeProfit}
     }
     const noStop=this.config.stopLossEnabled===false;
     // Hedge mode: a position on the other side of this coin at any check -> this trade is not settled from the
     // symbol's fund flow (its PnL and funding would be mixed in, review 2026-11-17); the fill estimate stays.
     if(other>0&&!p.otherSideSeen){p.otherSideSeen=true;this.#event('OTHER_SIDE_SEEN',{symbol:p.symbol,direction:p.direction,reason:`${other}`})}
     if(p.status==='UNKNOWN'){
      if(size>0){p.status='OPEN';p.filled=p.size=size;p.avg=pos(row.avgPrice)??p.entry;p.firstEntryPrice??=pos(row.avgPrice);p.openedAt??=this.now();this.#event('ENTRY_RECOVERED',{symbol:p.symbol,qty:size});
       if(noStop){p.steps.push({kind:'OPEN',at:this.now(),qty:size,avg:p.avg});this.#enableRepeat(p)}
       const s=scalpSplits(size,p.quantityStep,0);if(s)p.parts=s.parts;if(await this.#protect(p))await this.#placeTargets(p)}
      else if((p.zeroSeen=(p.zeroSeen||0)+1)>=2){this.store.open=this.store.open.filter(x=>x!==p);this.#event('ENTRY_NOT_FILLED',{symbol:p.symbol})}
      continue;
     }
     if(!(size>0)){if((p.zeroSeen=(p.zeroSeen||0)+1)>=2)await this.#finish(p);continue}
     p.zeroSeen=0;
     if(size<p.size-1e-12){
      const qty=+(p.size-size).toFixed(12);p.everReduced=true;p.steps.push({kind:'REDUCE',at:this.now(),qty,mark});
      this.#event('PARTIAL_EXIT',{symbol:p.symbol,direction:p.direction,qty,left:size});
     }
     p.size=size;p.avg=pos(row.avgPrice)??p.avg;p.mark=mark??p.mark;p.unrealized=num(row.unrealizedProfit)??(mark&&p.avg?dirOf(p.direction)*(mark-p.avg)*size:null);unrealized+=p.unrealized||0;
     p.exchangePosition={size,entryPrice:p.avg,markPrice:mark,unrealizedPnLUSD:row.unrealizedProfit??null,
      marginUSD:pos(row.initialMargin)??pos(row.margin),realizedPnLUSD:row.realisedProfit??row.realizedProfit??null,at:this.now()};
     const parts=p.parts.map((q,i)=>q+(p.addTargets||[]).reduce((n,g)=>n+g.parts[i],0));
     const done=p.filled-size,need=[parts[0],parts[0]+parts[1],parts[0]+parts[1]+parts[2]];
     p.tpDone=need.map((n,i)=>parts[i]>0&&done>=n-1e-9);
     // Journal: MFE / MAE from every mark seen, and when each target was first seen filled.
     trackExcursion(p,mark,this.now());p.tpFills??=[null,null,null];
     p.tpDone.forEach((ok,i)=>{if(ok&&!p.tpFills[i])p.tpFills[i]={at:this.now(),price:mark??null,qty:parts[i],seen:'RECONCILE'}});
     if(p.earlyTakeProfit||p.exitReason==='EARLY_TAKE_PROFIT')continue;
     if(noStop){
      if(!await this.#retireStop(p))continue;
      await this.#retireLegacyProfitTargets(p);
      this.#enableRepeat(p);p.riskUSD=this.#repeatRisk(p,p.avg,mark)*size;
     }else{
      if(this.now()>=p.deadline){p.exitTries=(p.exitTries||0)+1;const r=await this.#market(p,'x'+p.exitTries);p.exitReason='TIME_STOP';if(!(r.size>0))await this.#finish(p);continue}
      if(p.tpDone[0]&&!p.breakevenMoved)await this.#breakeven(p,mark);
     }
     if(p.status==='OPEN'&&await this.#tryEarlyTakeProfit(p,mark))continue;
     if(p.status==='OPEN')await this.#placeTargets(p);
     if(p.status==='OPEN')await this.#considerAdd(p,mark);
    }catch(e){if(e?.code==='HTTP_429'){this.cooldownUntil=this.now()+60000;break}this.#event('RECONCILE_ERROR',{symbol:p.symbol,reason:e?.code||e?.message})}
   }
   for(const x of this.store.closed.filter(x=>!x.realized&&!x.otherSideSeen&&(x.settleTries||0)<SETTLE_TRIES&&this.now()-x.closedAt>=SETTLE_DELAY_MS&&this.now()-x.closedAt<2*3600000))await this.#settle(x).catch(()=>{});
   this.#flushJournal();
   // A check that runs only to finish the journal (disarmed, nothing open) changes nothing else.
   const journalOnly=!this.store.open.length&&!this.armed;
   const funds=journalOnly?null:await this.#funds();
   if(funds){
    const today=kstDay(this.now());
    if(this.budget){
     // Shared budget: each strategy's realized today + unrealized, as a loss on its own (no offset between strategies,
     // review M2), against the shared %; written once to the budget's file. A figure holding a placeholder (a signal
     // close not yet settled) is never written: the next check looks again (review M5). The switch stays on.
     const snap=this.budget.snapshot(funds.equity,{who:'scalp'});
     if(snap.ok&&snap.limitUSD!==null&&!snap.provisional&&!snap.storedStop&&snap.lossWithOpenUSD>=snap.limitUSD)
      this.budget.markStopped({lossUSD:+snap.lossWithOpenUSD.toFixed(2),limitUSD:+snap.limitUSD.toFixed(2),reason:'REALIZED_AND_OPEN'});
     const st=this.budget.storedStop();
     if(st&&!this.#todayStopped()){
      const loss=-Math.abs(Number(st.lossUSD)||0);
      this.store.dailyStop={day:today,at:this.now(),lossUSD:+loss.toFixed(2),equity:snap.equityUSD,shared:true};
      this.#event('DAILY_LOSS_LIMIT',{reason:`${loss.toFixed(2)} ≤ -${this.budget.dailyLossPct}% of ${(snap.equityUSD||0).toFixed(2)} (신호+단타)`,lossUSD:+loss.toFixed(2),shared:true});
     }
    }else{
     // Alone: the scalp's own numbers and 3 %, disarmed as before.
     const realized=this.store.closed.filter(x=>kstDay(x.closedAt)===today).reduce((t,x)=>t+(Number(x.netUSD)||0),0),total=realized+unrealized,pct=this.config.dailyLossPct;
     if(!this.#todayStopped()&&total<=-funds.equity*pct/100){
      this.store.dailyStop={day:today,at:this.now(),lossUSD:+total.toFixed(2),equity:funds.equity};
      this.#event('DAILY_LOSS_LIMIT',{reason:`${total.toFixed(2)} ≤ -${pct}% of ${funds.equity.toFixed(2)}`,lossUSD:+total.toFixed(2)});
      this.disarm('DAILY_LOSS_LIMIT');
     }
    }
   }
  }finally{this.reconciling=false;this.#save()}
 }
 /** Flat on the venue: leftover orders cancelled, the fills read, close reason and estimated result booked. */
 async #finish(p,forced=null){
  const cl=this.client,vs=p.venueSymbol,targets=new Map(),fills=[];
  for(const group of [{ids:p.tpOrderIds},...(p.addTargets||[])])group.ids.forEach((id,i)=>{if(id)targets.set(id,i)});
  const exits=[...new Set([...p.stopIds,...targets.keys()].filter(Boolean))],ids=[...new Set([...exits,...p.exitIds].filter(Boolean))];
  for(const id of exits){try{await cl.cancelOrder(vs,id)}catch{}}
  for(const id of ids){try{const o=orderOf(await cl.getOrder(vs,{orderId:id})),q=pos(o?.executedQty),price=pos(o?.avgPrice);if(q&&price)fills.push({id,qty:q,price,status:o?.status})}catch{}}
  // Journal: fill prices count as excursions; target fills replace the price seen on the reconcile.
  p.tpFills??=[null,null,null];
  const byTarget=new Map();
  for(const f of fills){trackExcursion(p,f.price,this.now());if(targets.has(f.id)){
   const i=targets.get(f.id),g=byTarget.get(i)??{qty:0,notional:0};g.qty+=f.qty;g.notional+=f.price*f.qty;byTarget.set(i,g);
  }}
  for(const [i,g] of byTarget)p.tpFills[i]={...(p.tpFills[i]||{}),at:p.tpFills[i]?.at??this.now(),price:g.notional/g.qty,qty:g.qty,seen:'ORDER'};
  p.exitFills=fills.map(f=>({kind:p.stopIds.includes(f.id)?'STOP':targets.has(f.id)?'TP'+(targets.get(f.id)+1):'MARKET',price:f.price,qty:f.qty}));
  const stopFilled=fills.some(f=>p.stopIds.includes(f.id)),tpFilled=byTarget.size,placed=p.parts.filter(q=>q>0).length;
  const allTargets=p.addTargets?.length?[...byTarget.values()].reduce((n,g)=>n+g.qty,0)>=p.filled-Number(p.quantityStep)/2:tpFilled>=placed;
  const reason=forced||p.exitReason||(stopFilled?(p.breakevenMoved?'BREAKEVEN_STOP':'STOP'):allTargets?'ALL_TARGETS':'EXTERNAL');
  // Estimate: the fills read back, any rest at the last price seen (or the stop); taker fee both ways.
  const dir=dirOf(p.direction);
  let out=fills.reduce((t,f)=>t+f.qty,0),gross=fills.reduce((t,f)=>t+dir*(f.price-p.avg)*f.qty,0),exitNotional=fills.reduce((t,f)=>t+f.price*f.qty,0);
  const rest=Math.max(0,p.filled-out);if(rest>1e-12){const px=pos(await withTimeout(this.priceOf(p.symbol,vs),3000))??p.mark??p.stop;gross+=dir*(px-p.avg)*rest;exitNotional+=px*rest;out+=rest}
  const fee=(p.avg*p.filled+exitNotional)*(p.takerRate||SCALP_EXEC_COSTS.takerRate),r=x=>Math.round(x*1e4)/1e4;
  p.status='CLOSED';p.closedAt=this.now();p.closeReason=reason;p.tpHits=tpFilled;
  if(p.scaleIn?.state==='WATCH')Object.assign(p.scaleIn,{state:'SKIPPED',reason:p.scaleIn.lastReason||reason});
  const row={...p,estimate:{source:'ESTIMATE',pnlUSD:r(gross),feeUSD:r(-fee),netUSD:r(gross-fee)},netUSD:r(gross-fee),netSource:p.otherSideSeen?'ESTIMATE_OTHER_SIDE':'ESTIMATE',holdMs:p.closedAt-(p.openedAt||p.createdAt)};
  // R multiple on the actual entry and the initial stop (replaced by the settled result when the journal line is written).
  {const risk=p.scaleIn?.version===SCALP_REPEAT_SCALE_IN.version?dir*(p.scaleIn.initialEntry-p.initialStop)*p.scaleIn.initialQty:dir*(p.avg-p.initialStop)*p.filled;row.rMultiple=risk>0?r((gross-fee)/risk):null}
  this.store.closed.push(row);this.store.open=this.store.open.filter(x=>x!==p);
  this.#event('CLOSED',{symbol:p.symbol,direction:p.direction,reason,netUSD:row.netUSD,tp:tpFilled,holdMs:row.holdMs,entry:p.avg});
 }
 /** BingX fund flow (realized PnL + fees + funding) of this trade's symbol and lifetime, read after the close. */
 async #settle(x){
  if(typeof this.client.income!=='function'||x.otherSideSeen)return;
  const from=(x.createdAt||x.closedAt)-30000,to=Math.min(this.now(),x.closedAt+120000);
  const data=await this.client.income({symbol:x.venueSymbol,startTime:from,endTime:to,limit:1000}),list=Array.isArray(data)?data:Array.isArray(data?.list)?data.list:[];
  x.settleTries=(x.settleTries||0)+1;
  const rows=list.filter(y=>y?.symbol===x.venueSymbol&&Number(y.time)>=from&&Number(y.time)<=to);
  if(!rows.some(y=>y.incomeType==='REALIZED_PNL'))return;
  const sum=t=>rows.filter(y=>y.incomeType===t).reduce((s,y)=>s+(Number(y.income)||0),0),r=v=>Math.round(v*1e4)/1e4;
  x.realized={source:'EXCHANGE',pnlUSD:r(sum('REALIZED_PNL')),feeUSD:r(sum('TRADING_FEE')),fundingUSD:r(sum('FUNDING_FEE'))};x.realized.netUSD=r(x.realized.pnlUSD+x.realized.feeUSD+x.realized.fundingUSD);
  x.netUSD=x.realized.netUSD;x.netSource='EXCHANGE';
 }
 /** Win rate / PF / net over all closed scalps, and per side (bySide.LONG / bySide.SHORT). */
 // Over every trade: the journal plus the closed trades not yet written to it (the store keeps only the last 300).
 stats(){const list=[...this.journalRows,...this.store.closed.filter(x=>!x.journaled)];const all=this.#stats(list);all.bySide=Object.fromEntries(SCALP_SIDES.map(d=>[d,this.#stats(list.filter(x=>(x.direction||'LONG')===d))]));
  all.byKind=Object.fromEntries(Object.values(SCALP_KINDS).map(k=>[k,this.#stats(list.filter(x=>(x.kind||SCALP_KINDS.MOVE)===k))]));
  const experiment=list.filter(x=>x.scaleIn?.version===SCALP_SCALE_IN.version);
  const repeated=list.filter(x=>x.scaleIn?.version===SCALP_REPEAT_SCALE_IN.version);
  all.scaleIn={closed:experiment.length,filled:experiment.filter(x=>x.scaleIn.fillQty>0).length};
  all.repeatedScaleIn={closed:repeated.length,filled:repeated.filter(x=>x.scaleIn.count>0).length,adds:repeated.reduce((n,x)=>n+(x.scaleIn.count||0),0)};return all}
 #stats(list){
  const n=list.length,wins=list.filter(x=>x.netUSD>0),gross=wins.reduce((t,x)=>t+x.netUSD,0),loss=-list.filter(x=>x.netUSD<0).reduce((t,x)=>t+x.netUSD,0);
  const today=kstDay(this.now()),reasons={};for(const x of list)reasons[x.closeReason]=(reasons[x.closeReason]||0)+1;
  return {trades:n,wins:wins.length,grossProfitUSD:+gross.toFixed(2),grossLossUSD:+loss.toFixed(2),winRatePct:n?+(wins.length/n*100).toFixed(1):null,profitFactor:loss>0?+(gross/loss).toFixed(2):null,netUSD:+list.reduce((t,x)=>t+(Number(x.netUSD)||0),0).toFixed(2),
   todayNetUSD:+list.filter(x=>kstDay(x.closedAt)===today).reduce((t,x)=>t+(Number(x.netUSD)||0),0).toFixed(2),closeReasons:reasons};
 }
 status(){
  const c=this.config,g=this.#gate();
  return {strategy:SCALP_EXEC_STRATEGY,mode:c.mode,refused:c.refused,armed:this.armed,scanning:this.scanning===true,blocked:this.#blocked(),killSwitch:g.reason==='KILL_SWITCH',credentials:Boolean(this.client),
   settings:{interval:c.interval,sides:c.sides,...c.settings,trendFilter:c.trendMode==='on',trendMode:c.trendMode,minNetRR:c.minNetRR,maxHoldMin:c.stopLossEnabled===false?null:c.maxHoldMs/60000,
    earlyTakeProfitMin:c.stopLossEnabled===false?PROFIT_ONLY_EARLY_EXIT_MIN:EARLY_TAKE_PROFIT_MS/60000,profitHoldTargetMin:c.stopLossEnabled===false?SCALP_PROFIT_HOLD_TARGET_MIN:null,minProfitRoePct:c.stopLossEnabled===false?(c.minProfitRoePct??SCALP_MIN_PROFIT_ROE_PCT):null,
    reversalRecheckMin:REVERSAL_RECHECK_MS/60000,riskPct:c.riskPct,maxOpen:c.maxOpen,leverage:c.leverage,
    maxMarginPct:c.maxMarginPct,maxTotalMarginPct:this.budget?this.budget.marginCapPct:c.maxTotalMarginPct,dailyLossPct:this.budget?this.budget.dailyLossPct:c.dailyLossPct,sharedBudget:Boolean(this.budget),maxDriftPct:c.maxDriftPct,driftMovePct:c.driftMovePct,stopKeepPct:c.stopKeepPct,maxDriftAtr:c.maxDriftAtr,universeSize:c.universeSize,balanceCapUSD:c.balanceCapUSD||null,
    zoneSignals:c.zoneSignals===true,zoneMinMovePct:c.zoneMinMovePct,zoneTouchPct:c.zoneTouchPct,
    scaleIn:c.scaleIn===true,scaleInMarginRatio:c.stopLossEnabled===false?null:1,stopLossEnabled:c.stopLossEnabled!==false,repeatedScaleIn:c.scaleIn===true&&c.stopLossEnabled===false},
   universe:{count:this.universe.length,watchlist:this.config.watchlist,refreshedAt:this.universeAt||null,top:this.universe.slice(0,12).map(u=>u.symbol)},lastScan:this.lastScan,funds:this.funds,dailyStop:this.store.dailyStop,
   blockedKo:scalpReasonKo(this.#blocked()),positions:this.store.open.map(({steps,exchangePosition,...p})=>({...p,details:scalpPositionDetails({...p,steps,exchangePosition},this.now())})),
   closed:this.store.closed.slice(-SCREEN_CLOSED).reverse().map(({steps,exchangePosition,...x})=>({...x,margin:scalpMargin(x),closeReasonKo:scalpReasonKo(x.closeReason)})),stats:this.stats(),
   skipCounts:Object.entries(this.store.skipCounts).map(([reason,count])=>({reason,label:scalpReasonKo(reason),count})).sort((a,b)=>b.count-a.count),
   skips:this.store.skips.slice(-20).reverse().map(x=>({...x,label:scalpReasonKo(x.reason)})),events:this.store.events.slice(-30).reverse()};
 }
 /** Compact whitelisted runtime and 5m scan heartbeat for reports (no secrets or order ids). */
 runtimeSummary(){
  const c=this.config,ls=this.lastScan;
  const short=v=>v==null?null:String(v).replace(/\d{9,}/g,'#').slice(0,80);
  const skipCounts=Object.fromEntries(Object.entries(this.store.skipCounts||{}).filter(([,v])=>Number.isFinite(Number(v))&&Number(v)>0).slice(0,30));
  return {
   mode:c.mode,armed:this.armed,blocked:this.#blocked(),scanning:this.scanning===true,
   trendMode:c.trendMode,aiLensRecord:c.mode==='TESTNET'&&c.wyckoffRecord===true&&Boolean(this.signalsFile),scaleInEnabled:c.scaleIn,stopLossEnabled:c.stopLossEnabled,
   repeatedScaleIn:c.scaleIn&&!c.stopLossEnabled,open:this.store.open.length,
   ...(c.mode==='TESTNET'&&!c.stopLossEnabled?{profitHoldTargetMin:SCALP_PROFIT_HOLD_TARGET_MIN,profitCheckStartsMin:0,earlyFallbackMin:PROFIT_ONLY_EARLY_EXIT_MIN,minProfitRoePct:c.minProfitRoePct??SCALP_MIN_PROFIT_ROE_PCT,minMovePct:c.settings?.minMovePct??null}:{}),
   stopRetirementPending:this.store.open.filter(p=>p.stopRetirementError).length,
   openAdds:this.store.open.reduce((n,p)=>n+(p.scaleIn?.count||0),0),
    ...(c.scaleIn&&!c.stopLossEnabled?{
     availableMarginUSD:this.funds?.available??null,
     maxPositionMarginPct:c.maxMarginPct,
     scaleInPositions:this.store.open.map(p=>{
      const a=p.scaleIn,position=p.exchangePosition;
      return {symbol:p.symbol,direction:p.direction,status:p.status,
       state:a?.state??null,adds:a?.count??0,reason:short(a?.reason),lastReason:short(a?.lastReason),checkedBucket:a?.checkedBucket??null,
       mark:pos(position?.markPrice),positionCheckedAt:position?.at??null,trigger:a?.version===SCALP_REPEAT_SCALE_IN.version?pos(this.#repeatTrigger(p)):null,
       size:pos(p.size),filled:pos(p.filled),partialExit:p.everReduced===true,trailPeakRoePct:num(p.trailPeakRoePct),exitPending:Boolean(p.earlyTakeProfit||p.exitReason==='EARLY_TAKE_PROFIT'),
       stopRetirementPending:Boolean(p.stopRetirementError)};
     }),
    }:{}),
   universeCount:this.universe.length,universeRefreshedAt:this.universeAt||null,
   lastScan:ls?{at:ls.at??null,bucket:ls.bucket??null,checked:ls.checked??0,failed:ls.failed??0,
    lastFailure:short(ls.lastFailure),rateLimited:ls.rateLimited??0,signals:ls.signals??0,
    zoneSignals:ls.zoneSignals??0,rechecked:ls.rechecked??0,entered:ls.entered??0,error:short(ls.error)}:null,
   skipCounts,
  };
 }
 /** status() with fresh marks for open positions (public BingX price, cached) and a recent balance. */
 async liveStatus(){
  await Promise.all(this.store.open.filter(p=>p.size>0&&p.avg>0).map(async p=>{const m=pos(await withTimeout(this.markOf(p.venueSymbol),3000));if(m){p.mark=p.tickerPrice=m;p.unrealized=dirOf(p.direction)*(m-p.avg)*p.size;p.markAt=this.now();trackExcursion(p,m,this.now())}}));
  if(this.client&&!(this.now()-(this.funds?.at||0)<15000))await this.#funds().catch(()=>null);
  return this.status();
 }
}
