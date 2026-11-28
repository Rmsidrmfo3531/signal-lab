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
//  - 급변 알림 (user 2026-11-24 08:47 "@ggangalt2_bot ... 바로 매매 진행이 가능할까", pumpAlert): a crimepump 공습경보
//    (pump_alert.mjs) makes that coin a candidate at once and at each 5m close for PUMP_WATCH_MIN: DOWN -> LONG bounce,
//    UP -> SHORT fade. Only the move-size rule (minMovePct) counts as met by the alert; every other rule above (listing,
//    detection, score, BTC guard, budget, sizing, maker entry, exits) is unchanged. Trades carry trigger 'PUMP_ALERT'.
//    SCALP_PUMP_ALERTS=off turns it off; TESTNET only like everything here.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {atomicWriteStore,readStore} from './persistence.mjs';
import {roundDecimalToStep} from './decimal_grid.mjs';
import {scalpReasonKo} from './scalp_telegram.mjs';
import {livePositionView} from './live_overview.mjs';
import {evaluateScalpOrderflowBoost,evaluateScalpSqueezeGuard} from './orderflow.mjs';
import {evaluateWhaleCvdBonus,whaleCvdRecord,whaleCvdSummaryKo,whaleScaleMode,WHALE_CVD_DEFAULTS} from './whale_cvd.mjs';
import {buildWhaleZones,evaluateWhaleZoneBonus,whaleZoneRecord,whaleZoneSummaryKo,whaleWindowSnapshot,whaleLadderZones,whaleSplitOf,whaleSnapshotUsable,whaleZoneLookbackMs,whaleZoneBinPct,whaleZoneNearPct,WHALE_SPLIT_KEYS,WHALE_ZONE_DEFAULTS,WHALE_ZONE_RULE} from './whale_zones.mjs';
import {waitForFlat} from './live_orders.mjs';
import {venueRows,normalizeVenuePosition} from './venue_positions.mjs';
import {appendJsonl,readJsonl,tailJsonl,candleShape,trackExcursion,journalLine,scalpMargin,signalsPath,SCALP_JOURNAL_FILE,SCALP_SIGNALS_FILE,SIGNALS_MAX_BYTES} from './scalp_journal.mjs';
import {readPositionMode,leverageSideFor,positionSideFor,forMode,positionRow,orderOnSide,otherSideAmount} from './bingx_position_mode.mjs';
import {detectScalpReversal,buildScalpPlan,SCALP_DEFAULTS,SCALP_TIMEFRAMES,fourHourTrend,trendAllows,scoreScalpSetup,scalpScoreGrade,parseScalpScoreTiers,SCALP_SCORE_DEFAULTS,SCALP_SCORE_TIERS,SCALP_SCORE_TIER_MULTS,SCALP_GRADES} from './scalp_reversal.mjs';
export {SCALP_SCORE_TIERS,SCALP_SCORE_TIER_MULTS,parseScalpScoreTiers} from './scalp_reversal.mjs';
import {closedScalpBars,observeScalpStructure,WYCKOFF_CANDLES,WYCKOFF_INTERVAL_MS} from './scalp_wyckoff.mjs';
import {vsaStatus} from './scalp_vsa.mjs';
import {aiLensHigherTimeframe,aiLensRiskMap,aiLensStatus,LENS_HIGHER_INTERVAL_MS} from './scalp_ai_lens.mjs';
import {zoneBook,zoneTouches,zoneTagFields,zoneSpanMs,ZONE_PROFILES,ZONE_TOUCH_PCT} from './backtest.mjs';
import {placeMakerThenMarket,makerLimitPrice,makerChildIds} from './maker_order.mjs';
import {SCALP_MANAGEMENTS,TRADER_LADDER,scalpManagementOf,atrPct,ladderSpacing,planLadder,ladderZoneBoost,ladderReserve,strongZones,ladderNextAdd,ladderTpPrice} from './scalp_ladder.mjs';
import {TWO_PCT_DEFAULTS,TWO_PCT_INTERVAL,TWO_PCT_INTERVAL_MS,detectTwoPctSetup} from './two_pct_strategy.mjs';

export const SCALP_EXEC_STRATEGY='SCALP_REVERSAL';
export const SCALP_EXEC_MODES=Object.freeze(['OFF','TESTNET']);
// 40-coin BingX 5m Train/OOS backtest (B7): relax hard pre-filters (vol 2x, RSI 30/70, wick 35%, retrace 35%, ATR 3x)
// so high-scoring (>=65) reversals are filtered by the 100-point score gate instead of being hard-dropped (2.2x trades, +73% net, Ret/MDD 9.44).
export const SCALP_EXEC_SETTINGS=Object.freeze({minMovePct:3.5,minMoveAtr:3,retracements:Object.freeze([.382,.5,.618]),stopAtr:.25,climaxVolume:2,rsiExtreme:30,wickShare:.35,maxRetracedBeforeEntry:.35});
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
 stepRs:Object.freeze([1.0,1.5,3.0,4.5]),
 qtyMultipliers:Object.freeze([0.75,0.75,1.0,1.25]),
 maxAdds:4,
 slippagePct:0.35,
 retrySlippagePct:0.80,
 minStepPct:1.2,
 maxStepPct:3.0,
 retryDelayMs:15000,
 minPartialRemainRatio:0.25,
 dustRatio:0.05,
});
const SCREEN_CLOSED=100,I5=SCALP_TIMEFRAMES['5m'].intervalMs,FRACTIONS=[.4,.35,.25],MAX_CLOSED=300,MAX_EVENTS=200,MAX_SKIPS=60,MAX_KEYS=500,SETTLE_DELAY_MS=150000,SETTLE_TRIES=4;
const EARLY_TAKE_PROFIT_MS=45*60000,EARLY_EXIT_RETRY_MS=60000;
const PROFIT_ONLY_EARLY_EXIT_MIN=0,PROFIT_ONLY_RETRY_MS=5000;
export const SCALP_BASE_RISK_PCT=0.75;
export const SCALP_PROFIT_ONLY_TARGET_MARGIN_PCT=3.0;
export const SCALP_PROFIT_HOLD_TARGET_MIN=60;
export const SCALP_MIN_PROFIT_ROE_PCT=16;
export const SCALP_PARTIAL_TAKE_FRAC=0.25;
export const SCALP_PROFIT_PROTECT_ARM_ROE_PCT=10;
export const SCALP_PROFIT_PROTECT_FLOOR_ROE_PCT=2.5;
export const SCALP_AGAINST_TREND_RISK_SCALE=0.5;
export const SCALP_SCALE_IN_MIN_ROE_PCT=4;
export const SCALP_SCALE_IN_PARTIAL_ROE_PCT=8;
export const SCALP_SCALE_IN_PARTIAL_FRAC=0.40;
export const SCALP_TRAIL_PULLBACK_RATIO=0.25;
export const SCALP_TRAIL_RUNNER_PULLBACK_RATIO=0.28;
export const SCALP_TRAIL_MIN_PULLBACK_ROE=1.5;
export const SCALP_TRAIL_RUNNER_MIN_PULLBACK_ROE=2.0;
export const SCALP_HIGH_PROFIT_TRAIL_ROE_PCT=35;
export const SCALP_HIGH_PROFIT_PULLBACK_RATIO=0.18;
export const SCALP_STALE_ROTATE_HOURS=24;
export const SCALP_STALE_ROTATE_MIN_ADDS=3;
export const SCALP_STALE_ROTATE_ROE_PCT=2.5;
export const SCALP_BTC_GUARD_5M_PCT=1.5;
export const SCALP_BTC_GUARD_15M_PCT=2.5;
export const SCALP_BTC_GUARD_RELEASE_5M_PCT=0.15;
const REVERSAL_RECHECK_MS=30*60000;
export const SCALP_TRIGGERS=Object.freeze({SCAN:'SCAN',PUMP:'PUMP_ALERT'});
export const SCALP_PUMP_STRATEGIES=Object.freeze({TWO_PCT:'TWO_PCT',IMMEDIATE:'IMMEDIATE',REVERSAL:'REVERSAL'});
// A 급변 알림 is evaluated at once and at the next 5m closes within this window (the detection needs the extreme in the
// last 3 closed candles and a closed rejection candle, which an alert sent mid-candle does not have yet).
export const PUMP_WATCH_MIN=15;
const PUMP_STOP_REASONS=new Set(['NOT_ARMED','SCALP_MODE_OFF','CREDENTIALS_MISSING','SCALP_TESTNET_ONLY','KILL_SWITCH','LIVE_REFUSED','MODE_INVALID','SIDE_OFF','PUMP_NOT_ON_BINGX','SYMBOL_ALREADY_HELD','SYMBOL_HELD_BY_OTHER_STRATEGY','SYMBOL_LOSS_COOLDOWN','ALREADY_SENT','UNKNOWN','DAILY_LOSS_LIMIT','TWO_PCT_UP_ONLY']);
const WYCKOFF_SCAN_BUDGET_MS=12_000;
const RECHECK_REASONS=new Set(['PRICE_DRIFT','TP1_NET_RR_BELOW_MINIMUM']);
const num=v=>{const n=Number(v);return Number.isFinite(n)?n:null};
const pos=v=>{const n=Number(v);return Number.isFinite(n)&&n>0?n:null};
const posNoStop=(p,cfg)=>p?.twoPct?false:cfg?.stopLossEnabled===false;
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
// 고래 CVD stats: the recorded bonus of a trade (null = read before / without it) and its split key.
// 고래 매물대 (2026-11-25 09:51): plus / zero / minus / unavailable (no data or under 80 % read) and unmeasured (no zone
// record: trades before the zone rule, the old window rule's included, kept apart).
const whaleKey=s=>s&&typeof s==='object'&&s.whaleCvd?Number(s.whaleBonus)||0:null;
export const WHALE_STATS_KEYS=WHALE_SPLIT_KEYS;
export const whaleStatsKey=whaleSplitOf;
const dirOf=d=>d==='SHORT'?-1:1;
const POSITION_LIMIT_ERROR='VENUE_ERROR_101429';
// TRADER_LADDER positions hold their whole ladder budget from the entry on (user 2026-11-24, budget): margin = the larger of
// the margin in use and the reserved ladder margin, risk = the reserved worst case (every step filled, closed at the final
// line). Many small first entries laddering down together can then never commit more than the shared limits allow.
const isLadder=p=>p?.management===SCALP_MANAGEMENTS.LADDER&&Boolean(p.ladder);
const ladderOpenMargin=p=>(p.size||p.qty||0)*(p.avg||p.entry||0)/(p.leverage||1);
const ladderHeldMargin=p=>{const open=ladderOpenMargin(p);if(p.ladder?.state==='STOPPED')return open;return Math.max(open,Number(p.ladder?.reserveMarginUSD)||0)};
const ladderHeldRisk=p=>{if(p.ladder?.state==='STOPPED')return ladderReserve({totalMarginUSD:ladderOpenMargin(p),leverage:p.leverage,finalLineRoePct:p.ladder?.finalLineRoePct??75,takerRate:p.takerRate||SCALP_EXEC_COSTS.takerRate,reservePct:p.ladder?.reservePct??.0004}).riskUSD;return Number(p.ladder?.reserveRiskUSD)||0};
// An order read back by client id: {order:null} (or an empty answer) is no order at all.
const ladderOrderOf=d=>d&&typeof d==='object'&&'order' in d?d.order:d;
const LADDER_TERMINAL=new Set(['FILLED','CANCELED','CANCELLED','EXPIRED','REJECTED','FAILED']);
// An add whose orders cannot be confirmed finished is waited for this long, then the ladder stops adding (no retry).
const LADDER_PENDING_MAX_MS=10*60000;
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
 const minMovePct=n('SCALP_MIN_MOVE_PCT',SCALP_EXEC_SETTINGS.minMovePct,2.5,15),scoreTiers=parseScalpScoreTiers(env.SCALP_SCORE_TIERS);
 return {mode:known?(raw||'TESTNET'):'OFF',refused:known?null:raw==='LIVE'?'LIVE_REFUSED':'MODE_INVALID',interval:'5m',sides:scalpSides(env.SCALP_EXEC_SIDES),
  settings:{...SCALP_EXEC_SETTINGS,minMovePct,retracements:[...SCALP_EXEC_SETTINGS.retracements]},
  minProfitRoePct:n('SCALP_MIN_PROFIT_ROE_PCT',SCALP_MIN_PROFIT_ROE_PCT,0,100),
  partialTakeFrac:n('SCALP_PARTIAL_TAKE_FRAC',SCALP_PARTIAL_TAKE_FRAC,.1,.9),
  profitProtectArmRoePct:n('SCALP_PROFIT_PROTECT_ARM_ROE_PCT',SCALP_PROFIT_PROTECT_ARM_ROE_PCT,0,50),
  profitProtectFloorRoePct:n('SCALP_PROFIT_PROTECT_FLOOR_ROE_PCT',SCALP_PROFIT_PROTECT_FLOOR_ROE_PCT,0,20),
  earlyFallbackMin:n('SCALP_EARLY_FALLBACK_MIN',PROFIT_ONLY_EARLY_EXIT_MIN,0,240),
  // TP1 net RR floor (was 0.7 on the testnet, user 2026-11-17 "해결 방법 찾아봐 테스트넷인데": ICP/ARIA skipped at RR 0.78-0.83);
  // the backtest default is SCALP_DEFAULTS.minNetRR (1). Each trade keeps plan.netRR, so the 0.7-1 band is judged apart.
  minNetRR:n('SCALP_MIN_NET_RR',1,.3,3), /* back to 1 (2026-11-17 12:18 backtest: RR<1 band 29 trades PF 0.84 -$16.7, RR>=1 54 trades PF 1.17 +$39.3) */maxHoldMs:SCALP_TIMEFRAMES['5m'].maxHoldMs,
  // The testnet comparison defaults to 'record': measure 4H trend and let the other entry checks run.
  // 'on' blocks against-trend signals (30-day BingX backtest: 23 such trades, -$76, PF 0.32).
  // 'off' skips the measurement. An unrecognized explicit value keeps the blocking filter.
  trendMode:(m=>['off','false','0','no'].includes(m)?'off':['record','log'].includes(m)?'record':'on')(String(env.SCALP_EXEC_TREND_FILTER??'').trim().toLowerCase()||'record'),
  wyckoffRecord:!['off','false','0','no'].includes(String(env.SCALP_WYCKOFF_RECORD??'').trim().toLowerCase()),
  riskPct:n('SCALP_RISK_PCT',SCALP_BASE_RISK_PCT,.05,2),maxOpen:n('SCALP_MAX_OPEN',0,0,200),maxSameSide:n('SCALP_MAX_SAME_SIDE',4,0,50),leverage:n('SCALP_LEVERAGE',10,1,20),
  // Pillar 1: ATR-adaptive leverage (5m ATR <1.2% -> 10x, 1.2~2.0% -> 7x, >=2.0% -> 5x) to equalize survival room on volatile coins.
  adaptiveLeverage:!['off','false','0','no'].includes(String(env.SCALP_ADAPTIVE_LEVERAGE??'').trim().toLowerCase()),
  // A-2: Auto-shift targets up Fibonacci ladder ([50/61.8/78.6] -> [61.8/78.6/100]) when favorable live drift crosses 38.2% TP1.
  autoShiftTargets:!['off','false','0','no'].includes(String(env.SCALP_AUTO_SHIFT_TARGETS??'').trim().toLowerCase()),
  // A-1: Release stale 15m BTC shock guard once the latest closed 5m BTC candle reverses >= this % in the trade's direction.
  btcGuardRelease5mPct:n('SCALP_BTC_GUARD_RELEASE_5M_PCT',SCALP_BTC_GUARD_RELEASE_5M_PCT,0,5),
  // Pillar 3: Direct target-margin sizing in profit-only mode (default 3.0% equity = $90 on $3k, scaled by score/bounce/CVD/session, capped at $150).
  profitOnlyTargetMarginPct:n('SCALP_TARGET_MARGIN_PCT',SCALP_PROFIT_ONLY_TARGET_MARGIN_PCT,0,20),
  scaleIn:!['off','false','0','no'].includes(String(env.SCALP_SCALE_IN??'').trim().toLowerCase()),
  scaleInMinStepPct:n('SCALP_SCALE_IN_MIN_STEP_PCT',SCALP_REPEAT_SCALE_IN.minStepPct,0,10),
  scaleInMaxStepPct:n('SCALP_SCALE_IN_MAX_STEP_PCT',SCALP_REPEAT_SCALE_IN.maxStepPct,0.5,20),
  scaleInMarketFallback:!['off','false','0','no'].includes(String(env.SCALP_SCALE_IN_MARKET_FALLBACK??'').trim().toLowerCase()),
  stopLossEnabled:['on','true','1','yes'].includes(String(env.SCALP_STOP_LOSS??'').trim().toLowerCase()),
  makerEntry:!['off','false','0','no'].includes(String(env.SCALP_MAKER_ENTRY??'').trim().toLowerCase()),
  makerWaitMs:n('SCALP_MAKER_WAIT_MS',2500,200,10000),
  // Pillar 4: PostOnly-first profit exits (1.2s wait -> IOC fallback for remainder; emergency/max-hold exits remain instant MARKET).
  makerExit:!['off','false','0','no'].includes(String(env.SCALP_MAKER_EXIT??'').trim().toLowerCase()),
  makerExitWaitMs:n('SCALP_MAKER_EXIT_WAIT_MS',1200,100,5000),
  // Margin per position and for all scalps together, as a share of the equity; quantity is cut to fit (user 2026-11-25: 20% per symbol on testnet).
  maxMarginPct:n('SCALP_MAX_MARGIN_PCT',20,1,50),maxTotalMarginPct:n('SCALP_MAX_TOTAL_MARGIN_PCT',60,1,80),
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
  universeSize:n('SCALP_UNIVERSE_SIZE',120,10,250),
  scanMaxSymbols:n('SCALP_SCAN_MAX_SYMBOLS',45,10,250),
  // Coins always scanned whatever their volume rank (user 2026-11-16: "단타를 먹기 쉬운 것들 AKEUSDT, EVAAUSDT 등").
  watchlist:[...new Set(['AKEUSDT','EVAAUSDT',...String(env.SCALP_WATCHLIST||'').toUpperCase().split(/[\s,]+/)].filter(x=>/^[A-Z0-9]{2,20}USDT$/.test(x)))],universeRefreshMs:30*60000,klineGapMs:n('SCALP_KLINE_GAP_MS',350,100,2000),scanGapMs:n('SCALP_SCAN_GAP_MS',120,0,1000),scanDelayMs:3000,
  balanceCapUSD:n('SCALP_BALANCE_CAP_USD',0,0,1e7),
  // Profit-max safety rails (40-coin 120d Train/OOS backtest 1B): 4h underwater cut, -40% 1st defensive add, -75% catastrophe ROE cut (liq=0), max 2 adds, per-symbol loss cooldown.
  profitOnlyMaxHoldMin:n('SCALP_MAX_HOLD_MIN',240,0,4320),
  emergencyStopRoePct:n('SCALP_EMERGENCY_STOP_ROE_PCT',75,0,95),
  defensiveAddRoePct:n('SCALP_DEFENSIVE_ADD_ROE_PCT',40,0,90),
  defensiveBouncePct:n('SCALP_DEFENSIVE_BOUNCE_PCT',0.4,0,5),
  defensiveForceRoePct:n('SCALP_DEFENSIVE_FORCE_ROE_PCT',55,40,85),
  maxScaleInAdds:n('SCALP_MAX_SCALE_IN_ADDS',2,0,10),
  symbolLossCooldownMin:n('SCALP_SYMBOL_LOSS_COOLDOWN_MIN',120,0,1440),
  symbolDailyMaxLosses:n('SCALP_SYMBOL_DAILY_MAX_LOSSES',2,0,10),
  // 100-point setup score: entry from 70 (B), grades B / B+ 75 / A 80 / A+ 85 / S 90 sized 0.75 / 0.9 / 1.0 / 1.2 / 1.4x
  // (user 2026-11-25 08:28; initial margin cap fixed). SCALP_SCORE_TIERS="B+,A,A+,S" moves the edges above the gate.
  minScore:n('SCALP_MIN_SCORE',SCALP_SCORE_DEFAULTS.minScore,0,100),
  scoreTiers,
  highScore:n('SCALP_HIGH_SCORE',scoreTiers.A,0,100),
  highScoreSizeMult:n('SCALP_HIGH_SCORE_SIZE_MULT',SCALP_SCORE_DEFAULTS.highSizeMult,1,2),
  scoreTierSizing:!['off','false','0','no'].includes(String(env.SCALP_SCORE_TIER_SIZING??'').trim().toLowerCase()),
  // Backtest-validated orderflow boost (40 coins, Train/OOS): +5pt on 30m OI flush <=-1% + 1.5x sizing on strong CVD reversal flip (>15%).
  orderflowBoost:!['off','false','0','no'].includes(String(env.SCALP_ORDERFLOW_BOOST??'').trim().toLowerCase()),
  orderflowOiBonus:n('SCALP_ORDERFLOW_OI_BONUS',5,0,15),
  orderflowCvdBonus:n('SCALP_ORDERFLOW_CVD_BONUS',5,0,15),
  orderflowCvdSizeMult:n('SCALP_ORDERFLOW_CVD_SIZE_MULT',1.5,1,2),
  // 고래 CVD (user 2026-11-25 09:05, 09:12 "(나) 진행", 09:20 legend; whale_cvd.mjs, Material Indicators FireCharts 분류): Binance
  // aggTrades from the move start (max 30 min) in orange 새우 $100~$1k / green ~$10k / red ~$100k / purple ~$1M / brown 고래 $1M~$10M /
  // blue all; ±5 on the total before the gate when purple + brown CVD is >= max(purple edge, 10 % of the window's notional).
  whaleCvd:!['off','false','0','no'].includes(String(env.SCALP_WHALE_CVD??'').trim().toLowerCase()),
  whaleCvdBonus:n('SCALP_WHALE_CVD_BONUS',WHALE_CVD_DEFAULTS.bonus,0,5),
  whaleCvdMinSharePct:n('SCALP_WHALE_CVD_MIN_SHARE_PCT',WHALE_CVD_DEFAULTS.minSharePct,10,100),
  whaleCvdScale:whaleScaleMode(env.SCALP_WHALE_CVD_SCALE),
  whaleCvdMaxPages:n('SCALP_WHALE_CVD_MAX_PAGES',WHALE_CVD_DEFAULTS.maxPages,1,10),
  // 고래 매물대 (user 2026-11-25 09:51 "단타에선 CVD 활용 방법이 매물대를 보는 거라고 생각하면 편할 것 같고", "진행해"; whale_zones.mjs):
  // the ±whaleCvdBonus now comes from whale buy / sell zones by price over the last SCALP_WHALE_ZONE_HOURS (1..24, default 4),
  // read with at most SCALP_WHALE_ZONE_MAX_PAGES aggTrades pages a call (1..30, default 10 = weight 200), 0 under 80 % read.
  whaleZoneHours:n('SCALP_WHALE_ZONE_HOURS',WHALE_ZONE_DEFAULTS.lookbackHours,1,24),
  whaleZoneMaxPages:n('SCALP_WHALE_ZONE_MAX_PAGES',WHALE_ZONE_DEFAULTS.maxPages,1,30),
  whaleZoneTimeoutMs:n('SCALP_WHALE_ZONE_TIMEOUT_MS',5000,1000,15000),
  // Extreme funding + surging 30m OI squeeze guard: block SHORT on <=-0.10% funding + >=+2% OI, LONG on >=+0.10% + >=+2% OI.
  squeezeGuard:!['off','false','0','no'].includes(String(env.SCALP_SQUEEZE_GUARD??'').trim().toLowerCase()),
  squeezeFundingPct:n('SCALP_SQUEEZE_FUNDING_PCT',0.10,0.01,2),
  squeezeOiChange30mPct:n('SCALP_SQUEEZE_OI_30M_PCT',2.0,0,50),
  // Backtest-validated session asymmetry (40 coins, Train/OOS): EU(08-14 UTC / 17-23 KST) PF 0.36 -> 0.5x & block 4H counter-trend; US+Late(14-24 UTC / 23-09 KST) -> 1.15x.
  sessionWeighting:!['off','false','0','no'].includes(String(env.SCALP_SESSION_WEIGHTING??'').trim().toLowerCase()),
  sessionEuMult:n('SCALP_SESSION_EU_MULT',0.5,0.25,1.5),
  sessionUsMult:n('SCALP_SESSION_US_MULT',1.15,0.5,1.5),
  euBlockCounterTrend:!['off','false','0','no'].includes(String(env.SCALP_EU_BLOCK_COUNTER_TREND??'').trim().toLowerCase()),
  // Backtest-validated confirmed-bounce sizing (C7, 40 coins Train/OOS): retracedPct >=20% (WR 78.9%, PF 3.55) -> 1.35x; <20% (WR 63.9%, PF 1.64) -> 0.8x.
  bounceSizing:!['off','false','0','no'].includes(String(env.SCALP_BOUNCE_SIZING??'').trim().toLowerCase()),
  bounceThresholdPct:n('SCALP_BOUNCE_THRESHOLD_PCT',20,5,35),
  bounceHighMult:n('SCALP_BOUNCE_HIGH_MULT',1.35,1,2),
  bounceLowMult:n('SCALP_BOUNCE_LOW_MULT',0.8,0.3,1.2),
  // Unified 2.5%+ score gate (backtest: 2.5~3.5% setups scoring >=65 achieved 100% WR without requiring a 4H/1D zone touch).
  scoreUnifiedMove:!['off','false','0','no'].includes(String(env.SCALP_SCORE_UNIFIED_MOVE??'').trim().toLowerCase()),
  // 매물대 반전 (user 2026-11-17 23:12): on by default, SCALP_ZONE_SIGNALS=off turns it off.
  zoneSignals:!['off','false','0','no'].includes(String(env.SCALP_ZONE_SIGNALS??'').trim().toLowerCase()),zoneMinMovePct:SCALP_ZONE_MIN_MOVE_PCT,zoneTouchPct:ZONE_TOUCH_PCT,
  // 급변 알림 trigger (user 2026-11-24): on by default; only ever acts in TESTNET mode (LIVE is refused above).
  pumpAlerts:!['off','false','0','no'].includes(String(env.SCALP_PUMP_ALERTS??'').trim().toLowerCase()),
  // @ggangalt2_bot strategy (user 2026-11-26, TESTNET only): TWO_PCT (default: 15m >=2% trend candle -> wick flip LONG/SHORT,
  // wick SL <=2.2%, 50% TP1 at 1:2 RR + auto breakeven stop + 50% TP2 at capped 1D level, 20x leverage).
  ...(()=>{
   const rawS=String(env.SCALP_PUMP_STRATEGY??'').trim().toUpperCase();
   const hasImm=env.SCALP_PUMP_IMMEDIATE!==undefined&&String(env.SCALP_PUMP_IMMEDIATE).trim()!=='';
   const immOn=hasImm&&!['off','false','0','no'].includes(String(env.SCALP_PUMP_IMMEDIATE).trim().toLowerCase());
   const pumpStrategy=Object.values(SCALP_PUMP_STRATEGIES).includes(rawS)?rawS:(hasImm?(immOn?SCALP_PUMP_STRATEGIES.IMMEDIATE:SCALP_PUMP_STRATEGIES.REVERSAL):SCALP_PUMP_STRATEGIES.TWO_PCT);
   return {pumpStrategy,pumpImmediate:pumpStrategy===SCALP_PUMP_STRATEGIES.IMMEDIATE};
  })(),
  twoPctLeverage:n('SCALP_TWO_PCT_LEVERAGE',TWO_PCT_DEFAULTS.leverage,1,50),
  twoPctMinBodyPct:n('SCALP_TWO_PCT_MIN_BODY_PCT',TWO_PCT_DEFAULTS.minBodyPct,0.5,10),
  twoPctMinNetRR:n('SCALP_TWO_PCT_MIN_RR',TWO_PCT_DEFAULTS.minNetRR,1.0,10),
  twoPctPartialTpRR:n('SCALP_TWO_PCT_PARTIAL_RR',TWO_PCT_DEFAULTS.partialTpRR,1.2,5),
  twoPctMaxTpRR:n('SCALP_TWO_PCT_MAX_TP_RR',TWO_PCT_DEFAULTS.maxTpRR,2.5,20),
  twoPctMaxTpDistPct:n('SCALP_TWO_PCT_MAX_TP_PCT',TWO_PCT_DEFAULTS.maxTpDistPct,2,30),
  twoPctMinStopPct:n('SCALP_TWO_PCT_MIN_STOP_PCT',TWO_PCT_DEFAULTS.minStopPct,0.1,3),
  twoPctMaxStopPct:n('SCALP_TWO_PCT_MAX_STOP_PCT',TWO_PCT_DEFAULTS.maxStopPct,0.5,10),
  twoPctMaxStopRoePct:n('SCALP_TWO_PCT_MAX_STOP_ROE_PCT',TWO_PCT_DEFAULTS.maxStopRoePct,20,90),
  twoPctLossCooldownMin:n('SCALP_TWO_PCT_LOSS_COOLDOWN_MIN',TWO_PCT_DEFAULTS.lossCooldownMin,0,1440),
  twoPctWinCooldownMin:n('SCALP_TWO_PCT_WIN_COOLDOWN_MIN',TWO_PCT_DEFAULTS.winCooldownMin,0,1440),
  twoPctWatchMin:n('SCALP_TWO_PCT_WATCH_MIN',TWO_PCT_DEFAULTS.watchMin,15,180),
  twoPctPollMs:n('SCALP_TWO_PCT_POLL_MS',TWO_PCT_DEFAULTS.pollMs,5000,60000),
  twoPctMaxHoldMs:n('SCALP_TWO_PCT_MAX_HOLD_MIN',TWO_PCT_DEFAULTS.maxHoldMs/60000,60,4320)*60000,
  // Position management (user 2026-11-24, tuned 2026-11-27): TRADER_LADDER (default; 4-step 2·2·4·8 ladder, 50% capShare,
  // 2.5% min spacing, take profit on average, 24 h, final line) or CURRENT. TESTNET only.
  management:scalpManagementOf(env),
  ladderSpacingMinPct:n('SCALP_LADDER_SPACING_MIN_PCT',TRADER_LADDER.spacingMinPct,.3,10),
  ladderTpNetPct:n('SCALP_LADDER_TP_PCT',TRADER_LADDER.tpNetPct,.1,5),
  // Pump-alert specific ladder take-profit target (legacy IMMEDIATE mode): 2% price move net of fees, keeping normal scan at 0.6%.
  pumpLadderTpNetPct:n('SCALP_PUMP_TP_PCT',2,.1,10),
  ladderMaxHoldMin:n('SCALP_LADDER_MAX_HOLD_MIN',TRADER_LADDER.maxHoldMin,60,4320),
  ladderMakerWaitMs:n('SCALP_LADDER_MAKER_WAIT_MS',5000,200,15000),
  // Live-account safety rails (disabled = 0 on TESTNET by default so testnet verification is unaffected; active in scalpLiveExecConfig).
  hardStopRoePct:n('SCALP_HARD_STOP_ROE_PCT',0,0,95),
  minFreeAccountMarginPct:n('SCALP_MIN_FREE_MARGIN_PCT',0,0,90),
  maxSpreadPct:n('SCALP_MAX_SPREAD_PCT',0,0,5),
  preFundingWindowMin:n('SCALP_PRE_FUNDING_WINDOW_MIN',0,0,60),
  preFundingExtremePct:n('SCALP_PRE_FUNDING_EXTREME_PCT',0,0,5),
  scaleInRetrySlippagePct:n('SCALP_SCALE_IN_RETRY_SLIP_PCT',SCALP_REPEAT_SCALE_IN.retrySlippagePct,0.1,3)};
}

export const SCALP_LIVE_CONFIRM_TOKEN='REAL_MONEY_SCALP';

/** Dedicated real-money scalp config (default OFF): requires BOTH SCALP_LIVE_MODE=LIVE AND SCALP_LIVE_CONFIRM=REAL_MONEY_SCALP.
 * Completely independent from testnet SCALP_EXEC_MODE so testnet verification runs undisturbed alongside live pilot rails. */
export function scalpLiveExecConfig(env=process.env){
 const base=scalpExecConfig({...env,SCALP_EXEC_MODE:'TESTNET'});
 const n=(k,d,lo,hi)=>{const v=Number(env[k]);return env[k]!==undefined&&env[k]!==''&&Number.isFinite(v)&&v>=lo&&v<=hi?v:d};
 const raw=String(env.SCALP_LIVE_MODE??'').trim().toUpperCase();
 const confirmed=String(env.SCALP_LIVE_CONFIRM??'').trim()===SCALP_LIVE_CONFIRM_TOKEN;
 const wantLive=raw==='LIVE';
 const mode=wantLive&&confirmed?'LIVE':'OFF';
 const refused=wantLive&&!confirmed?'LIVE_CONFIRM_REQUIRED':(raw===''||raw==='OFF'||raw==='LIVE'?null:'MODE_INVALID');
 return {
  ...base,
  mode,
  refused,
  allowLive:mode==='LIVE',
  balanceCapUSD:n('SCALP_LIVE_CAPITAL_CAP_USD',500,50,1e7),
  maxOpen:n('SCALP_LIVE_MAX_OPEN',3,1,20),
  maxSameSide:n('SCALP_LIVE_MAX_SAME_SIDE',2,1,10),
  maxMarginPct:n('SCALP_LIVE_MAX_MARGIN_PCT',10,1,50),
  maxTotalMarginPct:n('SCALP_LIVE_MAX_TOTAL_MARGIN_PCT',30,1,80),
  dailyLossPct:n('SCALP_LIVE_DAILY_LOSS_PCT',3,0.5,15),
  profitOnlyTargetMarginPct:n('SCALP_LIVE_TARGET_MARGIN_PCT',3.0,0.5,10),
  // Exchange-side catastrophic STOP_MARKET safety net on BingX servers when local reconcile/network stalls.
  hardStopRoePct:n('SCALP_LIVE_HARD_STOP_ROE_PCT',85,50,95),
  // Reserve >= 40% free real-account margin so live copy/manual trading is never starved.
  minFreeAccountMarginPct:n('SCALP_LIVE_MIN_FREE_MARGIN_PCT',40,0,90),
  // Live execution quality guards: filter thin alt spreads and pre-settlement extreme funding bleed.
  maxSpreadPct:n('SCALP_LIVE_MAX_SPREAD_PCT',0.25,0,5),
  preFundingWindowMin:n('SCALP_LIVE_PRE_FUNDING_WINDOW_MIN',15,0,60),
  preFundingExtremePct:n('SCALP_LIVE_PRE_FUNDING_EXTREME_PCT',0.30,0,5),
  // Bounded IOC slippage on live scale-in instead of blind MARKET fallback on thin books.
  scaleInMarketFallback:['on','true','1','yes'].includes(String(env.SCALP_LIVE_SCALE_IN_MARKET_FALLBACK??'').trim().toLowerCase()),
  scaleInRetrySlippagePct:n('SCALP_LIVE_SCALE_IN_RETRY_SLIP_PCT',1.1,0.2,3),
  pumpAlerts:!['off','false','0','no'].includes(String(env.SCALP_LIVE_PUMP_ALERTS??'off').trim().toLowerCase()),
  pumpStrategy:SCALP_PUMP_STRATEGIES.REVERSAL,
  pumpImmediate:false,
  // TRADER_LADDER is TESTNET only (user 2026-11-24): a live scalp keeps the management it had.
  management:SCALP_MANAGEMENTS.CURRENT,
 };
}

/** Backtest-validated session size multiplier (40 coins, Train/OOS): EU(08-14 UTC / 17-23 KST) 0.5x, US/Late(14-24 UTC / 23-09 KST) 1.15x, Asia 1.0x. */
export function scalpSessionMultiplier(now=Date.now(),config={}){
 if(config?.sessionWeighting===false)return {session:'OFF',labelKo:'',mult:1};
 const utcH=new Date(now).getUTCHours();
 if(utcH>=8&&utcH<14){
  const mult=Number.isFinite(Number(config?.sessionEuMult))?Number(config.sessionEuMult):0.5;
  return {session:'EUROPE',labelKo:'유럽장',mult};
 }
 if(utcH>=14){
  const mult=Number.isFinite(Number(config?.sessionUsMult))?Number(config.sessionUsMult):1.15;
  return {session:'US',labelKo:'미국·야간장',mult};
 }
 return {session:'ASIA',labelKo:'아시아장',mult:1};
}

/** Backtest-validated confirmed-bounce sizing (C7): >=20% bounce -> 1.35x, <20% -> 0.8x (Train PF 2.29, OOS PF 3.36, MDD -10.3%). */
export function scalpBounceMultiplier(retracedPct,config={}){
 if(config?.bounceSizing===false||!Number.isFinite(Number(retracedPct)))return {active:false,confirmed:false,mult:1,retracedPct:null};
 const thresh=Number.isFinite(Number(config?.bounceThresholdPct))?Number(config.bounceThresholdPct):20;
 const hi=Number.isFinite(Number(config?.bounceHighMult))?Number(config.bounceHighMult):1.35;
 const lo=Number.isFinite(Number(config?.bounceLowMult))?Number(config.bounceLowMult):0.8;
 const r=Number(retracedPct),confirmed=r>=thresh;
 return {active:true,confirmed,mult:confirmed?hi:lo,retracedPct:+r.toFixed(1)};
}

/** Score-tier sizing by grade (user 2026-11-25 08:28): B 0.75x, B+ 0.9x, A 1.0x, A+ 1.2x, S 1.4x (initial margin cap fixed).
 * Below the gate it never sizes a trade (the gate skips first); it reads as B. */
export function scalpScoreTierMultiplier(score,config={}){
 if(config?.scoreTierSizing===false||!Number.isFinite(Number(score)))return {active:false,tier:null,mult:1};
 const g=scalpScoreGrade(score,{minScore:config?.minScore??SCALP_SCORE_DEFAULTS.minScore,scoreTiers:config?.scoreTiers}),tier=SCALP_SCORE_TIER_MULTS[g]!=null?g:'B';
 return {active:true,tier,mult:SCALP_SCORE_TIER_MULTS[tier]};
}

/** Pillar 1 — Volatility-targeted leverage (5m ATR%): <1.2% -> base (10x), 1.2~2.0% -> min(base, 7x), >=2.0% -> min(base, 5x). */
export function scalpAdaptiveLeverage({atr,price,baseLeverage=10,maxLeverage=null,config={}}={}){
 const base=Math.max(1,Math.floor(pos(baseLeverage)??10));
 const clampMax=l=>pos(maxLeverage)?Math.max(1,Math.min(l,Math.floor(Number(maxLeverage)))):l;
 if(config?.adaptiveLeverage===false||!(pos(atr)&&pos(price)))return clampMax(base);
 const atrPct=Number(atr)/Number(price)*100;
 const target=atrPct>=2.0?Math.min(base,5):atrPct>=1.2?Math.min(base,7):base;
 return clampMax(target);
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
 const lev=pos(leverage)??1;
 if(det.twoPct){
  const stopDistPct=dir*(entry-stop)/entry*100;
  const minStopPct=Number(config.twoPctMinStopPct??TWO_PCT_DEFAULTS.minStopPct);
  const maxStopPct=Number(config.twoPctMaxStopPct??TWO_PCT_DEFAULTS.maxStopPct);
  const maxStopRoePct=Number(config.twoPctMaxStopRoePct??TWO_PCT_DEFAULTS.maxStopRoePct);
  if(stopDistPct<minStopPct)return fail('TWO_PCT_STOP_TOO_TIGHT');
  if(stopDistPct>Math.min(maxStopPct,maxStopRoePct/lev))return fail('TWO_PCT_STOP_TOO_WIDE');
 }
 let q;
 if(det.singleTarget===true||det.twoPct===true){
  const rawTp1=pos(det.targets?.[0]);
  const tp1=rawTp1?Number(grid(rawTp1,tick,towardMode(det.direction))):0;
  if(!(tp1>0&&dir*(tp1-entry)>0))return fail('TARGETS_NOT_BEYOND_EXECUTABLE_ENTRY');
  const roundTrip=entry*(2*cost.takerRate+(2*cost.slippageBps+Math.max(0,cost.spreadBps||0))/10000+Math.abs(cost.fundingRate||0));
  const rawTp2=det.targets?.length>=2?pos(det.targets[1]):null;
  const tp2=rawTp2?Number(grid(rawTp2,tick,towardMode(det.direction))):0;
  const hasTwo=tp2>0&&dir*(tp2-tp1)>0&&dir*(tp1-entry)>roundTrip;
  const tp1RR=(dir*(tp1-entry)-roundTrip)/(Math.abs(entry-stop)+roundTrip);
  const estRR=hasTwo?(dir*(tp2-entry)-roundTrip)/(Math.abs(entry-stop)+roundTrip):tp1RR;
  if(!(estRR>=minNetRR))return fail('TP1_NET_RR_BELOW_MINIMUM',{netRR:Number.isFinite(estRR)?estRR:null});
  q={ok:true,targets:hasTwo?[tp1,tp2]:[tp2>0&&dir*(tp2-entry)>0?tp2:tp1],estimatedNetRR:estRR};
 }else{
  // Targets and the TP1 net RR do not depend on the quantity: checked on a 20-lot sample.
  q=buildScalpPlan({signal:{...det,stop},estimate:{eligible:true,tickSize:tick,quantityStep:step,entryBasis:entry,quantity:Number(step)*20,minNotional:0,minQuantity:0},costs:cost,minNetRR});
  // A-2: When favorable drift pushed live entry near/past 38.2% TP1, auto-shift targets up the Fibonacci ladder ([50/61.8/78.6] -> [61.8/78.6/100]).
  if(!q.ok&&config.autoShiftTargets!==false&&(q.reasons[0]==='TARGETS_NOT_BEYOND_EXECUTABLE_ENTRY'||(away&&q.reasons[0]==='TP1_NET_RR_BELOW_MINIMUM'))){
   const ext=Number(det.evidence?.extreme),org=Number(det.evidence?.origin),mv=Number.isFinite(ext)&&Number.isFinite(org)?dir*(org-ext):0;
   if(mv>0){
    for(const ladder of [[.5,.618,.786],[.618,.786,1]]){
     const shifted=ladder.map(f=>ext+dir*f*mv);
     if(shifted.some(t=>dir*(t-entry)<=0))continue;
     const retry=buildScalpPlan({signal:{...det,stop,targets:shifted},estimate:{eligible:true,tickSize:tick,quantityStep:step,entryBasis:entry,quantity:Number(step)*20,minNotional:0,minQuantity:0},costs:cost,minNetRR});
     if(retry.ok){q=retry;break}
    }
   }
  }
  if(!q.ok)return fail(q.reasons[0],{netRR:q.estimatedNetRR??null});
 }
 if(!pos(equity))return fail('NO_BALANCE');
 const riskUSD=equity*config.riskPct/100,scaleIn=(det.singleTarget===true||det.twoPct===true)?false:config.scaleIn===true;
 const assumedEntry=entry*(1+dir*cost.slippageBps/10000);
 const riskUnit=scaleIn||det.twoPct?riskAtStop(det.direction,assumedEntry,stop,cost.takerRate,cost):dir*(entry-stop);
 // Each unit of the initial entry reserves the same notional at the worst permitted add price.
 const worstAdd=stop+(assumedEntry-stop)*SCALP_SCALE_IN.far;
 const addRiskUnit=scaleIn?assumedEntry/worstAdd*riskAtStop(det.direction,worstAdd,stop,cost.takerRate,cost):0;
 let qty,capped=false;
 const cap=Math.min(equity*config.maxMarginPct/100,(totalMarginCapUSD??equity*config.maxTotalMarginPct/100)-usedMargin,available!=null?available*.9:Infinity)/(scaleIn?2:1);
 if(!(cap>0))return fail('MARGIN_CAP');
 // Pillar 3: In profit-only (no-stop) mode, size by target initial margin (% of equity, scaled by effective riskPct ratio)
 // rather than a phantom virtual-stop distance that starved high-score wide-move setups ($17-$40) while maxing out tiny-1R B-grades.
 const rawTargetMarginPct=config.stopLossEnabled===false?Number(config.profitOnlyTargetMarginPct):0;
 if(Number.isFinite(rawTargetMarginPct)&&rawTargetMarginPct>0){
  const riskRatio=Number(config.riskPct)>0?Number(config.riskPct)/SCALP_BASE_RISK_PCT:1;
  const targetMargin=equity*(rawTargetMarginPct*riskRatio)/100;
  qty=targetMargin*lev/entry;
 }else{
  qty=riskUSD/(riskUnit+addRiskUnit);
 }
 if(qty*entry/lev>cap){qty=cap*lev/entry;capped=true}
 qty=Number(grid(qty*(1+1e-9),step,'DOWN'))||0;
 const minPart=Number(grid(Math.max(Number(c.minQuantityBase)||0,(Number(c.minNotionalUSDT)||0)/entry*1.02,Number(step)),step,'UP'))||Number(step);
 const splitTwoPct=()=>{
  if(!(qty>=minPart-Number(step)*1e-6&&qty>0))return null;
  if(q.targets.length>=2){
   const q1=Number(grid(qty*0.5,step,'DOWN'))||0;
   const q2=Number(grid(qty-q1,step,'DOWN'))||0;
   if(q1>=minPart-Number(step)*1e-6&&q2>=minPart-Number(step)*1e-6&&q1>0&&q2>0)return {parts:[q1,q2,0],targets:2,merged:false};
   q.targets=[q.targets[q.targets.length-1]];
   return {parts:[qty,0,0],targets:1,merged:true};
  }
  return {parts:[qty,0,0],targets:1,merged:false};
 };
 const split=(det.singleTarget===true||det.twoPct===true)?splitTwoPct():scalpSplits(qty,step,minPart);
 if(!split)return fail(capped?'MARGIN_CAP':'QUANTITY_BELOW_MINIMUM');
 return {ok:true,entry,stop,targets:q.targets,qty,parts:split.parts,targetCount:split.targets,merged:split.merged,minPart,leverage:lev,
  riskUSD:qty*riskUnit,marginUSD:qty*entry/lev,capped,netRR:q.estimatedNetRR,driftPct:+driftPct.toFixed(3),takerRate:cost.takerRate,
  scaleIn:scaleIn?{version:SCALP_SCALE_IN.version,state:'WATCH',riskPct:config.riskPct,budgetUSD:riskUSD,minPart,
   minNotional:pos(c.minNotionalUSDT)||0}:null};
}
function twoPctResizeParts(qty,step,targetCount){
 if(targetCount>=2){
  const q1=Number(grid(qty*0.5,step,'DOWN'))||0,q2=Number(grid(qty-q1,step,'DOWN'))||0;
  if(q1>0&&q2>0)return [q1,q2,0];
 }
 return [qty,0,0];
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
 const adds=isLadder(p)
  ?{filled:Math.max(0,(Number(p.ladder.filled)||1)-1),max:Math.max(0,(Array.isArray(p.ladder.units)?p.ladder.units.length:1)-1),repeat:false}
  :{filled:repeat?a.count??0:a?.fillQty>0?1:0,max:a?1:0,repeat};
 return {...view,tickSize:p.tickSize,currentPriceSource:view.currentPriceSource==='VENUE_BOOK'?'VENUE_TICKER':view.currentPriceSource,adds};
}

export function scalpAddCount(x){
 if(x?.management===SCALP_MANAGEMENTS.LADDER&&x.ladder)return Math.max(0,(Number(x.ladder.filled)||1)-1);
 const a=x?.scaleIn;
 if(a?.version===SCALP_REPEAT_SCALE_IN.version)return Math.max(0,Number(a.count)||0);
 if(a?.fillQty>0)return 1;
 if(Array.isArray(x?.addTargets)&&x.addTargets.length)return x.addTargets.length;
 if(Array.isArray(x?.steps))return x.steps.filter(s=>s?.kind==='SCALE_IN').length;
 return 0;
}

function scalpCloseReasonLabel(x){
 const base=scalpReasonKo(x?.closeReason);
 const m=x?.closeMeta;
 if(!m)return base;
 if(x.closeReason==='EMERGENCY_ROE_STOP'&&Number.isFinite(Number(m.roePct))&&Number.isFinite(Number(m.limitPct))){
  return `비상 손절 (${Number(m.roePct).toFixed(1)}% / 한도 -${Number(m.limitPct)}%)`;
 }
 if(x.closeReason==='MAX_HOLD_EXIT'&&Number.isFinite(Number(m.roePct))&&Number.isFinite(Number(m.holdMin))){
  return `보유시간 컷 (${Number(m.roePct).toFixed(1)}% · ${Math.round(Number(m.holdMin))}분)`;
 }
 return base;
}

export class ScalpExecutor{
 constructor({config,client=null,contracts=async()=>new Map(),tickers=async()=>[],tickersFresh=null,candles=async()=>[],trendCandles=null,zoneCandles=null,orderflow=null,whaleZones=null,priceOf=async()=>null,markOf=async()=>null,bookOf=null,
  balance=async()=>null,isBusy=()=>false,gate=()=>({ok:true}),directory=null,fileName='scalp-store.json',journalFileName=SCALP_JOURNAL_FILE,signalsFileName=SCALP_SIGNALS_FILE,now=()=>Date.now(),log=()=>{},onEvent=()=>{},budget=null}){
  const isLiveAllowed=config?.mode==='LIVE'&&config?.allowLive===true;
  if(!SCALP_EXEC_MODES.includes(config?.mode)&&!isLiveAllowed)throw err('SCALP_TESTNET_ONLY',500);
  const expectedClientMode=isLiveAllowed?'LIVE':'TESTNET';
  if(client&&client.mode!==expectedClientMode)throw err('SCALP_TESTNET_ONLY',500);
  this.execMode=isLiveAllowed?'LIVE':'TESTNET';
  Object.assign(this,{config,client,contracts,tickers,tickersFresh,candles,orderflow,whaleZones,priceOf,markOf,bookOf,balance,isBusy,gate,now,log,onEvent});
  this.trendCandles=trendCandles??(symbol=>this.candles(symbol,'4h',301));
  // 4H / 1D candles for the volume zones (BingX public market data, the scan's paced queue); cached per symbol and
  // timeframe until the next candle of that timeframe closes.
  this.zoneCandles=zoneCandles??((symbol,interval,limit)=>this.candles(symbol,interval,limit));this.zoneCache=new Map();this.dailyCache=new Map();
  this.file=directory?path.join(directory,fileName):null;
  const saved=this.file&&fs.existsSync(this.file)?readStore(this.file):null;
  this.store={open:Array.isArray(saved?.open)?saved.open:[],closed:Array.isArray(saved?.closed)?saved.closed:[],events:Array.isArray(saved?.events)?saved.events:[],
   skipCounts:saved?.skipCounts||{},skips:Array.isArray(saved?.skips)?saved.skips:[],sent:Array.isArray(saved?.sent)?saved.sent:[],dailyStop:saved?.dailyStop||null,
   autoRearm:saved?.autoRearm===true,userPaused:saved?.userPaused===true,
   managementSince:saved?.managementSince&&typeof saved.managementSince==='object'?{...saved.managementSince}:{},
   migrations:saved?.migrations&&typeof saved.migrations==='object'?{...saved.migrations}:{}};
  // An entry cut off by a restart: its outcome is read from the venue by the next check.
  for(const p of this.store.open)if(p.status==='SUBMITTING')p.status='UNKNOWN';
  // budget (testnet_budget.mjs, user 2026-11-17 "한도까지 하나로"): the daily loss, open risk and margin shared with the
  // signal strategy on the testnet (TESTNET_DAILY_LOSS_PCT, default 15 %). Without it the scalp's own 3 % rules apply.
  this.budget=this.execMode==='LIVE'?null:budget;this.reservedRisk=new Map();
  // When TRADER_LADDER first ran here (ready_check.mjs counts only its trades from then on): written once, kept.
  if(this.#management()===SCALP_MANAGEMENTS.LADDER&&!(Number(this.store.managementSince[SCALP_MANAGEMENTS.LADDER])>0))this.store.managementSince[SCALP_MANAGEMENTS.LADDER]=this.now();
  this.armed=false;this.entryRevision=0;this.reserved=new Set();this.reservedDirections=new Map();this.universe=[];this.universeAt=0;this.trendCache=new Map();this.lastScanBucket=null;this.lastScan=null;
  this.reversalWatch=new Map();this.pumpWatch=new Map();
  this.wyckoffCache=new Map();
  this.scanning=false;this.reconciling=false;this.lastReconcileAt=0;this.cooldownUntil=0;this.funds=null;
  // Trade journal (scalp_journal.mjs, user 2026-11-16 22:18): every finished trade, never truncated; the stats
  // header is computed over it (the in-store closed list stays capped). Detected signals go to their own file.
  this.journalFile=directory?path.join(directory,journalFileName):null;this.signalsFile=directory?path.join(directory,signalsFileName):null;
  const written=this.journalFile?readJsonl(this.journalFile):[];
  this.journalRows=written.map(x=>this.#journalRowOf(x));
  // Ids already written: a restart between writing a line and saving the ledger must not write it twice.
  this.journalIds=new Set(written.map(x=>x?.id).filter(Boolean));
  this.journalMem=[];this.cur=null;this.btcCache=null;
  try{this.#flushJournal();this.#purgeCorruptedEvaaBugRecord();this.#save()}catch(e){this.log?.('[SCALP] journal start',e.message)}
 }
 #journalRowOf(x){
  return {kind:x.kind||SCALP_KINDS.MOVE,trigger:x.trigger||SCALP_TRIGGERS.SCAN,management:x.management||SCALP_MANAGEMENTS.CURRENT,openedAt:x.entry?.at??null,direction:x.direction,netUSD:x.pnl?.netUSD??null,closedAt:x.exit?.at??null,closeReason:x.exit?.reason??null,scaleIn:x.scaleIn,scoreGrade:x.score?.grade??x.scalpScore?.grade??null,scoreTotal:x.score?.score??x.scalpScore?.score??null,whaleBonus:whaleKey(x.score??x.scalpScore),whaleSplit:whaleSplitOf(x.score??x.scalpScore),capitalBasisUSD:pos(x.capitalBasisUSD)??null,initialRiskUSD:pos(x.plan?.riskUSD)??null,initialMarginUSD:pos(x.plan?.marginUSD??x.margin?.initialUSD)??null};
 }
 #rewriteJournal(keepFn,source=this.journalFile?readJsonl(this.journalFile):this.journalMem){
  const kept=source.filter(keepFn);
  const removed=source.length-kept.length;
  if(removed>0){
   if(this.journalFile){
    fs.mkdirSync(path.dirname(this.journalFile),{recursive:true});
    const tmp=`${this.journalFile}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp,kept.map(x=>JSON.stringify(x)).join('\n')+(kept.length?'\n':''),'utf8');
    fs.renameSync(tmp,this.journalFile);
   }else{
    this.journalMem=kept;
   }
   this.journalRows=kept.map(x=>this.#journalRowOf(x));
   this.journalIds=new Set(kept.map(x=>x?.id).filter(Boolean));
  }
  return removed;
 }
 /** One-time TESTNET cleanup (user 2026-11-26): purge the corrupted EVAAUSDT SHORT trade (opened 1795599322366, -$31.95) caused by the false-EXTERNAL bug from store & journal. */
 #purgeCorruptedEvaaBugRecord(){
  if(this.execMode!=='TESTNET'||this.store.migrations?.purgeEvaaBug1795599322===true)return 0;
  const TARGET_OPEN_AT=1795599322366,WINDOW_MS=120000;
  const isTargetClosed=x=>x?.symbol==='EVAAUSDT'&&x?.direction==='SHORT'&&Math.abs((Number(x.openedAt)||Number(x.createdAt)||0)-TARGET_OPEN_AT)<=WINDOW_MS;
  const isTargetJournal=x=>x?.symbol==='EVAAUSDT'&&x?.direction==='SHORT'&&Math.abs((Number(x.entry?.at)||0)-TARGET_OPEN_AT)<=WINDOW_MS;
  const beforeClosed=this.store.closed.length;
  this.store.closed=this.store.closed.filter(x=>!isTargetClosed(x));
  const removedClosed=beforeClosed-this.store.closed.length;
  const removedJournal=this.#rewriteJournal(x=>!isTargetJournal(x));
  this.store.migrations={...(this.store.migrations||{}),purgeEvaaBug1795599322:true};
  return Math.max(removedClosed,removedJournal);
 }
 /** The management a new entry gets: TRADER_LADDER only on the TESTNET, without the automatic stop; else CURRENT. */
 #management(){return this.execMode==='TESTNET'&&this.config?.mode==='TESTNET'&&this.config.management===SCALP_MANAGEMENTS.LADDER&&this.config.stopLossEnabled===false?SCALP_MANAGEMENTS.LADDER:SCALP_MANAGEMENTS.CURRENT}
 /** For 실계좌 준비 점검: which trades count (TRADER_LADDER from its switch time). */
 managementScope(){return {management:SCALP_MANAGEMENTS.LADDER,since:Number(this.store.managementSince?.[SCALP_MANAGEMENTS.LADDER])||null,active:this.#management()===SCALP_MANAGEMENTS.LADDER}}
 #save(){if(!this.file)return;const s=this.store;s.closed=s.closed.slice(-MAX_CLOSED);s.events=s.events.slice(-MAX_EVENTS);s.skips=s.skips.slice(-MAX_SKIPS);s.sent=s.sent.slice(-MAX_KEYS);
  fs.mkdirSync(path.dirname(this.file),{recursive:true});atomicWriteStore(this.file,{version:1,strategy:SCALP_EXEC_STRATEGY,...s})}
 #event(type,detail={}){const e={type,at:this.now(),mode:this.execMode,strategy:SCALP_EXEC_STRATEGY,...detail};this.store.events.push(e);this.log(`[SCALP${this.execMode==='LIVE'?':LIVE':''}] ${type} ${detail.symbol||''} ${detail.reason||''}`.trim());try{this.onEvent(e)}catch{}return e}
 #skip(symbol,reason,detail=null){if(this.cur?.symbol===symbol){this.cur.reason=reason;this.cur.detail=detail==null?null:String(detail).slice(0,160)}this.store.skipCounts[reason]=(this.store.skipCounts[reason]||0)+1;this.store.skips.push({at:this.now(),symbol,reason,...(this.cur?.symbol===symbol&&this.cur.direction?{direction:this.cur.direction,movePct:this.cur.evidence?.movePct??null,kind:this.cur.kind||SCALP_KINDS.MOVE}:{}),...(this.cur?.symbol===symbol&&this.cur.score?{score:this.cur.score.score,grade:this.cur.score.grade,minScore:this.cur.score.minScore,...(this.cur.score.breakdown?{breakdown:{...this.cur.score.breakdown}}:{}),...(this.cur.score.oiBonus>0?{oiBonus:this.cur.score.oiBonus}:{}),...(this.cur.score.cvdBonus>0?{cvdBonus:this.cur.score.cvdBonus}:{}),...(this.cur.score.whaleCvd?{whaleBonus:this.cur.score.whaleBonus||0,whaleCvd:this.cur.score.whaleCvd}:{})}:{}),...(this.cur?.symbol===symbol&&this.cur.trigger?{trigger:this.cur.trigger}:{}),...(detail?{detail:String(detail).slice(0,160)}:{})})}
 #gate(){try{return this.gate()||{ok:true}}catch{return {ok:false,reason:'GATE_ERROR'}}}
 // With the shared budget only a stop written under it counts (review L2: a scalp-only 3 % stop saved before is ignored).
 #todayStopped(day=kstDay(this.now())){
  const d=this.store.dailyStop;
  if(!(d?.day===day&&(!this.budget||d.shared===true)))return false;
  const cap=this.budget?.capitalCapUSD;
  // Self-heal an impossible unscaled legacy-VST dailyStop (loss > 100% of current capitalCapUSD).
  if(this.budget&&cap>0&&Number.isFinite(Number(d.lossUSD))&&Math.abs(Number(d.lossUSD))>cap){
   this.store.dailyStop=null;this.#save();return false;
  }
  return true;
 }
 clearDailyStop(){
  if(this.store.dailyStop){this.store.dailyStop=null;this.#save()}
  return this.status();
 }
 resetHistory(){
  const removed=Math.max(this.store.closed.length,this.journalRows.length);
  this.store.closed=[];
  this.store.events=[];
  this.store.skips=[];
  this.store.skipCounts={};
  this.store.dailyStop=null;
  this.journalRows=[];
  this.journalIds=new Set();
  this.journalMem=[];
  if(this.journalFile){try{fs.rmSync(this.journalFile,{force:true})}catch{}}
  this.#save();
  return {removed,status:this.status()};
 }
 /** Delete one closed TESTNET scalp trade from both store.closed and scalp-journal.jsonl so it is excluded from cumulative PnL. */
 deleteClosedTrade(id){
  if(this.execMode!=='TESTNET')return {ok:false,reason:'SCALP_TESTNET_ONLY'};
  const key=String(id||'').trim();
  if(!key)return {ok:false,reason:'POSITION_NOT_FOUND'};
  const target=this.store.closed.find(x=>x?.id===key)||null;
  let journal;
  try{journal=this.journalFile?readJsonl(this.journalFile,{strict:true}):this.journalMem}
  catch{return {ok:false,reason:'JOURNAL_READ_FAILED'}}
  const tradeKey=target?.barAt?`${target.symbol}|${target.direction}|${target.barAt}`:key;
  let matches=journal.filter(row=>row&&(row.id?row.id===key:row.tradeKey===tradeKey));
  if(!matches.length&&target){
   // Old journal rows can lack an ID. Only use exact recorded timestamps on such rows.
   matches=journal.filter(row=>row&&!row.id&&!row.tradeKey&&row.symbol===target.symbol&&row.direction===target.direction&&
    target.openedAt>0&&Number(row.entry?.at)===Number(target.openedAt)&&
    target.closedAt>0&&Number(row.exit?.at)===Number(target.closedAt));
  }
  if(matches.length>1)return {ok:false,reason:'AMBIGUOUS_JOURNAL_MATCH'};
  if(!target&&!matches.length)return {ok:false,reason:'POSITION_NOT_FOUND'};
  if(matches.length)this.#rewriteJournal(row=>row!==matches[0],journal);
  if(target)this.store.closed=this.store.closed.filter(row=>row!==target);
  this.#save();
  return {ok:true,removed:1,status:this.status()};
 }
 /** Why no new entry may be sent now (null = may). */
 #blocked(ignoreAddId=null){
  const activeMode=this.config.mode==='LIVE'&&this.config.allowLive===true?'LIVE':this.config.mode==='TESTNET'?'TESTNET':null;
  if(!activeMode)return this.config.refused||'SCALP_MODE_OFF';
  if(!this.client)return 'CREDENTIALS_MISSING';
  if(this.client.mode!==activeMode)return 'SCALP_TESTNET_ONLY';
  if(!this.armed)return 'NOT_ARMED';
  const g=this.#gate();if(!g.ok)return g.reason||'GATE_CLOSED';
  if(this.#todayStopped())return 'DAILY_LOSS_LIMIT';
  // Shared budget: the signal strategy's and the scalp's realized loss today reached the shared limit.
  if(this.budget?.stopped(this.funds?.equity))return 'DAILY_LOSS_LIMIT';
  if(this.store.open.some(p=>p.status==='UNKNOWN'||p.id!==ignoreAddId&&(p.scaleIn?.state==='PENDING'&&this.now()-(p.scaleIn.attemptedAt||0)<5*60000||p.ladder?.pending&&this.now()-(p.ladder.pending.attemptedAt||0)<5*60000)))return 'UNRESOLVED_ORDER_STATE';
  if(this.cooldownUntil>this.now())return 'RATE_LIMIT_COOLDOWN';
  return null;
 }
 isDailyStopped(){return this.#todayStopped()}
 arm(){
  const activeMode=this.config.mode==='LIVE'&&this.config.allowLive===true?'LIVE':this.config.mode==='TESTNET'?'TESTNET':null;
  if(!activeMode)throw err(this.config.refused||'SCALP_MODE_OFF');
  if(!this.client)throw err('CREDENTIALS_MISSING');
  if(this.client.mode!==activeMode)throw err('SCALP_TESTNET_ONLY');
  const g=this.#gate();if(!g.ok)throw err(g.reason==='KILL_SWITCH'?'KILL_SWITCH_ON':g.reason||'GATE_CLOSED');
  // Shared budget (one testnet switch): the switch may stay on through a day stop; entries wait for the next KST day.
  if(this.#todayStopped()&&!this.budget)throw err('DAILY_LOSS_LIMIT');
  this.armed=true;this.store.autoRearm=true;this.store.userPaused=false;this.#event('ARMED');this.#save();return this.status();
 }
 disarm(reason='MANUAL'){
  const was=this.armed;this.entryRevision++;this.armed=false;this.reversalWatch.clear();this.pumpWatch.clear();
  if(reason==='MANUAL'){this.store.userPaused=true;this.store.autoRearm=false}
  else if(reason==='NO_PROTECTIVE_STOP'){this.store.autoRearm=false}
  if(was)this.#event('DISARMED',{reason});this.#save();return this.status();
 }
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
  // 급변 알림 candidates: TWO_PCT polls on 15s cadence for live 15m red->green flips; REVERSAL waits for 5m scan bucket inside #pumpEvaluate.
  if(this.pumpWatch.size&&!this.scanning)await this.#pumpTick();
  const every=this.store.open.length?(this.config.stopLossEnabled===false?5000:15000):60000;
  const hasRecoverableExternal=this.config.mode==='TESTNET'&&this.store.closed.some(x=>x.closeReason==='EXTERNAL'&&!x.realized&&now-(x.closedAt||0)<7*86400000);
  if(!this.reconciling&&this.client&&now-this.lastReconcileAt>=every&&(this.store.open.length||this.armed||hasRecoverableExternal||this.store.closed.some(x=>!x.journaled)))await this.reconcile();
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
 /** The universe ordered by the price range of the last 8 scans' ticker snapshots (largest first), with
  * conservative flat-symbol prefiltering when the universe exceeds scanMaxSymbols so 5m scans finish fast. */
 async #byRecentMove(bucket){
  try{
  const pre=this.prefetch?.bucket===bucket?this.prefetch.rows:null;
  let rows=null;try{rows=await withTimeout(pre||(this.tickersFresh||this.tickers)(),pre?3000:5000)}catch{}
  if(!Array.isArray(rows))return [...this.universe];
  const px=new Map(),chg24=new Map();
  for(const r of rows){
   if(!r?.symbol)continue;
   const sym=String(r.symbol);
   const p=Number(r.lastPrice);if(p>0)px.set(sym,p);
   const c=Math.abs(Number(r.priceChangePercent));if(Number.isFinite(c))chg24.set(sym,c);
  }
  this.pxHist||=new Map();
  const live=new Set(this.universe.map(u=>u.symbol));for(const k of this.pxHist.keys())if(!live.has(k))this.pxHist.delete(k);
  const score=new Map();
  let warmed=0;
  for(const u of this.universe){const p=px.get(u.venueSymbol);if(!(p>0))continue;
   const h=(this.pxHist.get(u.symbol)||[]).filter(x=>x.bucket>bucket-8&&x.bucket!==bucket);h.push({bucket,p});this.pxHist.set(u.symbol,h);
   if(h.length>=2)warmed++;
   const ps=h.map(x=>x.p),lo=Math.min(...ps);score.set(u.symbol,(Math.max(...ps)-lo)/lo)}
  const sorted=[...this.universe].sort((a,b)=>{
   const sa=score.get(a.symbol)??-1,sb=score.get(b.symbol)??-1;
   if(sb!==sa)return sb-sa;
   return (chg24.get(b.venueSymbol)??-1)-(chg24.get(a.venueSymbol)??-1);
  });
  const maxSym=Number(this.config.scanMaxSymbols)||0;
  if(!(maxSym>0)||sorted.length<=maxSym)return sorted;
  const minMoveFloor=Math.min(Number(this.config.settings?.minMovePct)||3.5,this.config.zoneSignals?(Number(this.config.zoneMinMovePct)||2.5):3.5);
  const activeRange=(minMoveFloor/100)*0.35;
  const hasHist=warmed>=Math.ceil(sorted.length*0.5);
  const kept=[];
  for(const [i,u] of sorted.entries()){
   const mustScan=u.watch===true||this.reversalWatch.has(u.symbol)||i<maxSym||(hasHist&&(score.get(u.symbol)??0)>=activeRange);
   if(mustScan)kept.push(u);
  }
  return kept;
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
   const order=await this.#byRecentMove(bucket);st.firstSymbols=order.slice(0,5).map(u=>u.symbol);st.prefiltered=order.length;st.universeTotal=this.universe.length;
   for(const [seq,u] of order.entries()){const ix=this.universe.indexOf(u);
    if(revision!==this.entryRevision)break;
    let loopWhy=this.#blocked();
    if(loopWhy==='UNRESOLVED_ORDER_STATE'&&!this.reconciling&&this.client){await this.reconcile();loopWhy=this.#blocked()}
    if(loopWhy)break;
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
    // Unified 2.5%+ score gate (40-coin backtest: 2.5~3.5% setups scoring >=65 achieved 100% WR without 4H/1D zone gating).
    // Respects explicit SCALP_ZONE_SIGNALS=off; falls back to legacy ZONE_REVERSAL + 4H/1D zone check when minScore===0 or scoreUnifiedMove===false.
    const unifiedScoreMove=Number(this.config.minScore)>0&&this.config.scoreUnifiedMove!==false;
    if(!det.ok&&this.config.zoneSignals&&(this.config.settings.minMovePct??SCALP_TIMEFRAMES['5m'].minMovePct)>this.config.zoneMinMovePct){
     const alt=detectScalpReversal(closed,{symbol:u.symbol,now:t,interval:'5m',settings:{...this.config.settings,minMovePct:this.config.zoneMinMovePct}});
     if(alt.ok){
      det=alt;
      if(!unifiedScoreMove){kind=SCALP_KINDS.ZONE;st.zoneSignals=(st.zoneSignals||0)+1}
     }
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
  if(this.pumpWatch.size&&this.armed&&!this.scanning)await this.#pumpTick();
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
 #pumpStrategy(){
  if(this.config.mode!=='TESTNET')return SCALP_PUMP_STRATEGIES.REVERSAL;
  const s=String(this.config.pumpStrategy||'').toUpperCase();
  if(Object.values(SCALP_PUMP_STRATEGIES).includes(s))return s;
  return this.config.pumpImmediate===false?SCALP_PUMP_STRATEGIES.REVERSAL:SCALP_PUMP_STRATEGIES.TWO_PCT;
 }
 /** Cached 1D candles per symbol (until next 1D close, max 6h TTL) for TWO_PCT resistance calculation. */
 async #dailyRows(symbol,st={}){
  const now=this.now(),hit=this.dailyCache.get(symbol);
  if(hit&&now<hit.nextCloseAt&&now-hit.fetchedAt<6*3600000){hit.usedAt=now;return hit.rows}
  for(const [k,v] of this.dailyCache)if(now-v.usedAt>6*3600000)this.dailyCache.delete(k);
  let rows;
  try{rows=await this.#paced(()=>this.zoneCandles(symbol,'1d',182),st)}
  catch(e){if(e?.code==='HTTP_429'){this.cooldownUntil=this.now()+60000;st.error='HTTP_429'}return null}
  if(!Array.isArray(rows)||!rows.length)return null;
  const valid=rows.filter(r=>Array.isArray(r)&&Number.isFinite(Number(r[0]))&&Number.isFinite(Number(r[6]))).sort((a,b)=>Number(a[0])-Number(b[0]));
  const open=valid.find(r=>Number(r[6])>=now);
  const nextCloseAt=open?Number(open[6])+1:(valid.length?Number(valid.at(-1)[6])+1+86400000:now+86400000);
  this.dailyCache.set(symbol,{rows:valid,nextCloseAt,fetchedAt:now,usedAt:now});
  return valid;
 }
 /** 급변 알림 (crimepump 공습경보, user 2026-11-24 / 2026-11-26):
  *  - TWO_PCT (default on TESTNET): @ggangalt2_bot selects coins & direction (UP -> LONG, DOWN -> SHORT);
  *    watch 15m candles for >=2% strong trend candle -> pullback wick flip -> wick SL, 1D resistance/support TP (>=1:2 RR), 20x.
  *  - IMMEDIATE / REVERSAL: legacy reverse-entry modes on DOWN->LONG / UP->SHORT.
  * TESTNET only: refused in any other mode or with any other client. */
 async pumpAlert(alert){
  if(this.config.pumpAlerts===false)return {entered:false,reason:'PUMP_ALERTS_OFF'};
  const activeMode=this.config.mode==='LIVE'&&this.config.allowLive===true?'LIVE':this.config.mode==='TESTNET'?'TESTNET':null;
  if(!activeMode||!this.client||this.client.mode!==activeMode)return {entered:false,reason:this.config.refused||'SCALP_TESTNET_ONLY'};
  const strat=this.#pumpStrategy();
  const symbol=String(alert?.symbol||'').toUpperCase(),dirRaw=alert?.dir==='UP'||alert?.dir==='DOWN'?alert.dir:null;
  if(!/^[A-Z0-9]{1,30}USDT$/.test(symbol)||!dirRaw)return {entered:false,reason:'PUMP_ALERT_INVALID'};
  if(!this.armed)return {entered:false,reason:'NOT_ARMED'};
  const now=this.now();
  const watchMin=strat===SCALP_PUMP_STRATEGIES.TWO_PCT?(Number(this.config.twoPctWatchMin)||TWO_PCT_DEFAULTS.watchMin):PUMP_WATCH_MIN;
  // The window runs from the alert's own time, not from its delivery (review 2026-11-24): an alert relayed late (listener
  // retries while the server restarts, a Telegram reconnect catch-up) keeps only what is left of it, and one older than
  // the window is not traded.
  const at=Number(alert.at),until=(Number.isFinite(at)&&at>0?Math.min(at,now):now)+watchMin*60000;
  if(now>=until)return {entered:false,reason:'PUMP_ALERT_STALE'};
  const normAlert={key:typeof alert.key==='string'?alert.key.slice(0,100):null,at:Number(alert.at)||now,dir:dirRaw,pct:Number(alert.pct)||null,low:Number(alert.low)||null,high:Number(alert.high)||null,price:Number(alert.price)||null,ticks:Number.isFinite(Number(alert.ticks))?Number(alert.ticks):null};
  const direction=strat===SCALP_PUMP_STRATEGIES.TWO_PCT?(dirRaw==='UP'?'LONG':'SHORT'):(dirRaw==='DOWN'?'LONG':'SHORT');
  this.pumpWatch.set(symbol,{symbol,direction,mode:strat,since:now,until,lastBucket:null,lastCheckAt:0,lastSkipKey:null,tries:0,lastReason:null,alert:normAlert});
  if(this.scanning)return {entered:false,queued:true,reason:'QUEUED_AFTER_SCAN'};
  return await this.#pumpEvaluate(symbol)??{entered:false,queued:true,reason:'QUEUED_AFTER_SCAN'};
 }
 async #pumpTick(){
  for(const symbol of [...this.pumpWatch.keys()]){
   if(this.scanning)return;
   await this.#pumpEvaluate(symbol).catch(e=>this.log('[SCALP] pump',symbol,e?.message));
  }
 }
 /** One evaluation of a 급변 알림 candidate (TWO_PCT 15m poll, IMMEDIATE entry, or 5m REVERSAL close). */
 async #pumpEvaluate(symbol){
  const w=this.pumpWatch.get(symbol);if(!w)return null;
  const now=this.now(),bucket=Math.floor(now/I5);
  if(now>w.until){this.pumpWatch.delete(symbol);return {entered:false,reason:'PUMP_WATCH_EXPIRED'}}
  const mode=w.mode||this.#pumpStrategy();
  const isTwoPct=mode===SCALP_PUMP_STRATEGIES.TWO_PCT&&this.config.mode==='TESTNET';
  const immediate=mode===SCALP_PUMP_STRATEGIES.IMMEDIATE&&this.config.mode==='TESTNET';
  if(isTwoPct){
   const pollMs=Number(this.config.twoPctPollMs)||TWO_PCT_DEFAULTS.pollMs;
   if(this.scanning||(w.lastCheckAt>0&&now-w.lastCheckAt<pollMs))return null;
   w.lastCheckAt=now;
  }else{
   // Non-immediate mode waits for this candle's 5m scan to settle first; immediate mode enters right away (unless a scan holds the lock).
   if(w.lastBucket===bucket||this.scanning||(!immediate&&this.lastScanBucket!==bucket))return null;
   w.lastBucket=bucket;
  }
  // The scan's lock: #consider and the journal context (this.cur) are shared with the 5m scan.
  this.scanning=true;w.tries++;
  const revision=this.entryRevision,st={at:now,bucket,checked:0};
  // Only this watch: a newer alert for the coin that came during the evaluation keeps its own (and gets its own result).
  const done=(r,{stop=false}={})=>{w.lastReason=r?.entered?'ENTERED':r?.reason??null;if((stop||r?.entered||PUMP_STOP_REASONS.has(r?.reason))&&this.pumpWatch.get(symbol)===w)this.pumpWatch.delete(symbol);
   // The alert's record (pump-alerts.json) keeps the latest decision for it (server: PumpAlertBook.attachScalp).
   try{this.onPumpResult?.(w.alert.key,{...r,tries:w.tries})}catch{}
   return r};
  const ctx={at:now,symbol,venueSymbol:null,kind:SCALP_KINDS.MOVE,trigger:SCALP_TRIGGERS.PUMP,pumpAlert:w.alert,direction:w.direction,barAt:null,reason:null,detail:null,
   scan:{startedAt:now,bucket,position:null,of:null,elapsedMs:0,trigger:SCALP_TRIGGERS.PUMP,try:w.tries}};
  this.cur=ctx;
  const skip=(reason,detail=null,opt)=>{
   const dedupKey=opt?.dedup?`${reason}|${Math.floor(this.now()/TWO_PCT_INTERVAL_MS)}`:null;
   if(!dedupKey||w.lastSkipKey!==dedupKey){this.#skip(symbol,reason,detail);if(dedupKey)w.lastSkipKey=dedupKey}
   return done({entered:false,reason},opt);
  };
  let r;
  try{
   {const why=this.#blocked();if(why)return r=skip(why,null,{stop:immediate})}
   if(!this.config.sides.includes(w.direction))return r=skip('SIDE_OFF',w.direction,{stop:true});
   // The universe carries BTCUSDT for the BTC shock guard and the BTC 4H trend of the score: never evaluated without it.
   try{await this.#refreshUniverse(now)}catch{}
   if(!this.universe.some(x=>x.symbol==='BTCUSDT'))return r=skip('PUMP_UNIVERSE_UNAVAILABLE',null,{stop:immediate});
   // BingX must list it as an ordinary USDT perpetual (stock / fx 'NC*' contracts are not scalped, as scalpUniverse).
   const c=(await this.contracts(symbol).catch(()=>null))?.get?.(symbol),vs=String(c?.venueSymbol||'');
   if(!c?.tradable||!/^[A-Z0-9]{1,20}-USDT$/.test(vs)||vs.startsWith('NC'))return r=skip('PUMP_NOT_ON_BINGX',c?(c.tradable?vs:'거래 중지'):'목록에 없음',{stop:true});
   ctx.venueSymbol=vs;
   const ix=this.universe.findIndex(x=>x.symbol===symbol),u={symbol,venueSymbol:vs,quoteVolume:ix>=0?this.universe[ix].quoteVolume:null};
   ctx.universe={rank:ix>=0?ix+1:null,size:this.universe.length,quoteVolume:u.quoteVolume};
   if(isTwoPct){
    let rows15m=null;
    try{rows15m=await this.#paced(()=>this.candles(symbol,TWO_PCT_INTERVAL,20),st)}
    catch(e){if(e?.code==='HTTP_429'){this.cooldownUntil=this.now()+60000;return r=skip('HTTP_429',e?.code||e?.message)}return r=skip('PUMP_CANDLES_FAILED',e?.code||e?.message,{dedup:true})}
    const [rows1d,livePx,levInfo]=await Promise.all([
     this.#dailyRows(symbol,st),
     withTimeout(Promise.resolve().then(()=>this.priceOf(symbol,vs)),3000).catch(()=>null),
     typeof this.client?.leverage==='function'?Promise.resolve().then(()=>this.client.leverage(vs)).catch(()=>null):null,
    ]);
    if(st.error==='HTTP_429')return r=skip('HTTP_429');
    const maxVenue=Number((w.direction==='SHORT'?levInfo?.maxShortLeverage:levInfo?.maxLongLeverage)??levInfo?.maxLeverage);
    const cfgLev=Number(this.config.twoPctLeverage??TWO_PCT_DEFAULTS.leverage);
    const targetLev=Math.max(1,Math.floor(maxVenue>0?Math.min(cfgLev,maxVenue):cfgLev));
    const t=this.now();
    const setup=detectTwoPctSetup({
     rows15m,
     rows1d,
     direction:w.direction,
     livePrice:pos(livePx),
     now:t,
     leverage:targetLev,
     costs:{...SCALP_EXEC_COSTS,takerRate:Math.max(SCALP_EXEC_COSTS.takerRate,pos(c.takerFeeRate)??0)},
     config:{
      minBodyPct:this.config.twoPctMinBodyPct??TWO_PCT_DEFAULTS.minBodyPct,
      minNetRR:this.config.twoPctMinNetRR??TWO_PCT_DEFAULTS.minNetRR,
      partialTpRR:this.config.twoPctPartialTpRR??TWO_PCT_DEFAULTS.partialTpRR,
      maxTpRR:this.config.twoPctMaxTpRR??TWO_PCT_DEFAULTS.maxTpRR,
      maxTpDistPct:this.config.twoPctMaxTpDistPct??TWO_PCT_DEFAULTS.maxTpDistPct,
      minStopPct:this.config.twoPctMinStopPct??TWO_PCT_DEFAULTS.minStopPct,
      maxStopPct:this.config.twoPctMaxStopPct??TWO_PCT_DEFAULTS.maxStopPct,
      maxStopRoePct:this.config.twoPctMaxStopRoePct??TWO_PCT_DEFAULTS.maxStopRoePct,
      leverage:targetLev,
     },
    });
    ctx.at=t;
    if(!setup.ok)return r=skip(setup.reason,setup.detail,{dedup:true,stop:setup.reason==='SCALP_INTERVAL_UNSUPPORTED'});
    const setupTargets=Array.isArray(setup.targets)&&setup.targets.length?setup.targets:[setup.tp];
    const det={
     ok:true,twoPct:true,singleTarget:setupTargets.length===1,symbol,direction:w.direction,kind:SCALP_KINDS.MOVE,interval:TWO_PCT_INTERVAL,
     barAt:setup.entryCandle.openTime,entry:setup.entry,stop:setup.stop,targets:setupTargets,leverage:targetLev,atr:setup.atr,
     twoPctMeta:{
      direction:w.direction,baseCandle:setup.baseCandle,entryCandle:setup.entryCandle,resistance:setup.resistance,targetLevel:setup.targetLevel,tpSource:setup.tpSource,
      allTimeHigh:setup.allTimeHigh,allTimeLow:setup.allTimeLow,netRR:setup.netRR,tp1NetRR:setup.tp1NetRR??setup.netRR,tp1:setup.tp1??setup.tp,tp2:setup.tp2??setup.tp,
      splitPartial:setup.splitPartial===true,tpCapped:setup.tpCapped===true,rawDailyTp:setup.rawDailyTp??setup.tp,
      stopDistPct:setup.stopDistPct,lowerWickPct:setup.lowerWickPct,wickPct:setup.wickPct,leverage:targetLev,
     },
     evidence:{
      symbol,origin:setup.baseCandle.open,extreme:setup.stop,movePct:setup.baseCandle.bodyPct,
      interval:TWO_PCT_INTERVAL,twoPct:true,candleCloseAt:setup.baseCandle.closeTime,
     },
    };
    ctx.barAt=det.barAt;ctx.evidence=det.evidence;ctx.atr=det.atr;ctx.lensEntry=det.entry;
    r=await this.#consider(u,det,revision);
    return done(r);
   }
   if(immediate){
    let rows=null;
    try{rows=await this.#paced(()=>this.candles(symbol,'5m',20),st)}
    catch(e){if(e?.code==='HTTP_429'){this.cooldownUntil=this.now()+60000;return r=skip('HTTP_429',e?.code||e?.message,{stop:true})}}
    const t=this.now(),closed=(Array.isArray(rows)?rows:[]).filter(x=>Number(x?.[6])<t);
    const lastClose=pos(closed.at(-1)?.[4]);
    const refPrice=pos(w.alert.price)??lastClose;
    const ap=atrPct(closed,{now:t});
    const estAtr=Number.isFinite(ap)&&ap>0&&refPrice?refPrice*ap/100:(refPrice?refPrice*0.015:null);
    const d=dirOf(w.direction);
    const span=refPrice?Math.max(pos(w.alert.high)&&pos(w.alert.low)?Math.abs(w.alert.high-w.alert.low):0,refPrice*Math.max(0.02,(Number(w.alert.pct)||10)/100)):0;
    const barAt=bucket*I5;
    const det={ok:true,immediatePump:true,symbol,direction:w.direction,kind:SCALP_KINDS.MOVE,barAt,entry:refPrice,atr:estAtr,immediateSpan:span,
     stop:refPrice?(d>0?Math.max(refPrice*0.5,refPrice-Math.max((estAtr||refPrice*0.015)*1.5,refPrice*0.02)):refPrice+Math.max((estAtr||refPrice*0.015)*1.5,refPrice*0.02)):null,
     targets:refPrice?[refPrice+d*span*0.382,refPrice+d*span*0.618,refPrice+d*span*0.786]:[],
     evidence:{symbol,origin:d>0?(pos(w.alert.high)??refPrice):(pos(w.alert.low)??refPrice),extreme:d>0?(pos(w.alert.low)??refPrice):(pos(w.alert.high)??refPrice),
      movePct:Number(w.alert.pct)||0,immediate:true,interval:'5m',candleCloseAt:barAt}};
    ctx.at=t;ctx.barAt=barAt;ctx.evidence=det.evidence;ctx.atr=estAtr;ctx.lensEntry=refPrice;
    r=await this.#consider(u,det,revision);
    return done(r,{stop:true});
   }
   let rows;
   try{rows=await this.#paced(()=>this.candles(symbol,'5m',61),st)}
   catch(e){if(e?.code==='HTTP_429')this.cooldownUntil=this.now()+60000;return r=skip(e?.code==='HTTP_429'?'HTTP_429':'PUMP_CANDLES_FAILED',e?.code||e?.message)}
   const t=this.now(),closed=(Array.isArray(rows)?rows:[]).filter(x=>Number(x?.[6])<t).slice(-60);
   if(!closed.length||Number(closed.at(-1)[0])!==(bucket-1)*I5)return r=skip('PUMP_CANDLES_STALE');
   // The alert stands in for the move size only (minMovePct); ATR multiple, volume climax, RSI, rejection candle,
   // retrace and targets are checked as in the scan, on the alert's side only.
   const det=detectScalpReversal(closed,{symbol,now:t,interval:'5m',settings:{...this.config.settings,minMovePct:0},only:w.direction});
   ctx.at=t;ctx.evidence=det.evidence??null;
   if(!det.ok){ctx.reason='PUMP_NO_REVERSAL';ctx.detail=(det.reasons||[]).join(',');return r=skip('PUMP_NO_REVERSAL',(det.reasons||[]).join(','))}
   Object.assign(ctx,{barAt:det.barAt,evidence:det.evidence,atr:det.atr,lensEntry:det.entry,candle:candleShape(closed.at(-1),det.direction)});
   r=await this.#consider(u,det,revision);
   return done(r);
  }catch(e){r=skip('ENTRY_SETUP_FAILED',e?.code||e?.message,{stop:immediate});return r}
  finally{
   this.cur=null;this.scanning=false;
   // A detected reversal goes to the signal journal (scalp-signals-*.jsonl) with trigger PUMP_ALERT, as the scan's do;
   // earlier stops (not listed, no reversal, blocked) are in the skip list and in the alert's record (pump-alerts.json).
   if(r&&ctx.barAt!=null&&r.reason!=='ALREADY_SENT')try{this.#logSignal(ctx,r)}catch{}
   this.#save();
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
 /** A public read with adaptive rate-limit pacing: gentle base gap across large universes (>10 coins) so
  * 80-coin 5m scans avoid BingX 100410, plus two retries (1.5 s, 3.5 s) and escalating pacing if hit. */
 async #paced(read,st){
  if(st.rateLimited)await sleep(Math.min(800,300+st.rateLimited*150));
  else if(this.universe.length>10&&this.config.scanGapMs>0&&st.checked>0)await sleep(this.config.scanGapMs);
  try{return await read()}
  catch(e){for(const w of [1500,3500]){if(e?.code!=='VENUE_ERROR_100410')throw e;st.rateLimited=(st.rateLimited||0)+1;await sleep(w);try{return await read()}catch(next){e=next}}throw e}
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
  this.zoneCache.set(key,{book,rows:valid,nextCloseAt,tickSize:String(tickSize),usedAt:now});return book;
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
  if(isLadder(p))return t+ladderHeldRisk(p);
  const d=dirOf(p.direction),e=pos(p.avg||p.entry),st=pos(p.stop),q=pos(p.size||p.qty),pending=p.scaleIn?.state==='PENDING'?(p.scaleIn.reservedRiskUSD||0):0;
  if(!e||!st||!q)return t+pending;
  if(posNoStop(p,this.config))return t+this.#repeatRisk(p,e,p.mark)*q+pending;
  const unit=p.scaleIn||p.twoPct?riskAtStop(p.direction,e,st,p.takerRate):Math.max(0,d*(e-st));
  if(p.scaleIn&&p.status==='SUBMITTING')return t+Math.max(unit*q,p.riskUSD)+pending;
  return t+unit*q+pending;
 },0)}
 #usedMargin(){return this.store.open.reduce((t,p)=>isLadder(p)?t+ladderHeldMargin(p):t+(p.size||p.qty||0)*(p.avg||p.entry||0)/(p.leverage||1)
  +(p.scaleIn?.state==='PENDING'?(p.scaleIn.reservedMarginUSD||0):0),0)}
 async #funds({requireAvailable=false}={}){
  const b=await this.balance().catch(()=>null),eq=pos(b?.equity);if(!eq)return null;
  const raw=b.available,available=num(raw);
  if(requireAvailable&&(!['number','string'].includes(typeof raw)||String(raw).trim()===''||available===null))return null;
  const cap=this.config.balanceCapUSD>0?this.config.balanceCapUSD:Infinity,equity=Math.min(eq,cap),used=Math.max(0,eq-(available??eq));
  const scaledAvail=cap<Infinity&&eq>cap&&available!==null?equity*(available/eq):Math.min(available??equity,equity-used);
  this.funds={equity,available:Math.max(0,scaledAvail),accountEquity:eq,accountAvailable:available!==null?Math.max(0,available):null,at:this.now()};return this.funds;
 }
 /** Real-account free-margin buffer guard: ensures live scalp never starves copy/manual trading margin. */
 #accountMarginLow(funds){
  const minPct=Number(this.config.minFreeAccountMarginPct)||0;
  if(!(minPct>0)||!funds)return null;
  const accEq=pos(funds.accountEquity),accAv=funds.accountAvailable;
  if(!(accEq>0)||accAv==null||!Number.isFinite(accAv))return null;
  const freePct=accAv/accEq*100;
  return freePct<minPct?`여유 마진 ${freePct.toFixed(1)}% < ${minPct}%`:null;
 }
 /** ATR(1H) % of a symbol from the scan's 1H candles (40), kept on the candidate so the ladder plan reuses it; null on failure. */
 async #atr1h(symbol){
  if(this.cur?.symbol===symbol&&this.cur.atr1hRead)return this.cur.atr1h??null;
  const rows=await withTimeout(Promise.resolve().then(()=>this.candles(symbol,'1h',40)),3000);
  const a=atrPct(rows,{now:this.now()});
  if(this.cur?.symbol===symbol&&Number.isFinite(a)){this.cur.atr1hRead=true;this.cur.atr1h=a}
  return a;
 }
 /** Outer timeout (default 5 s via SCALP_WHALE_ZONE_TIMEOUT_MS) and inner paging deadline (3.5 s at default) so
  * WhaleTradeStore stops starting new pages cleanly before the outer timeout discards already-fetched pages. */
 #whaleZoneTimeouts(){
  const outerMs=Math.max(1000,Number(this.config.whaleZoneTimeoutMs)||5000);
  const deadlineMs=Math.max(500,Math.min(outerMs-500,Math.round(outerMs*0.7)));
  return {outerMs,deadlineMs};
 }
 /** 고래 매물대 of a candidate (whale_zones.mjs, user 2026-11-25 09:51): whale (purple + brown) buy / sell zones by price over
  * the last whaleZoneHours, scored at the plan's entry price. The old window rule (move start .. now, at most 30 min) is
  * computed from the same read and kept under `window` for comparison only (never scored).
  * Never throws and never waits more than whaleZoneTimeoutMs (default 5 s; inner paging deadline 3.5 s). */
 async #whaleZoneFor(u,det,entry){
  const end=this.now(),lookbackMs=whaleZoneLookbackMs(this.config.whaleZoneHours);
  const {outerMs,deadlineMs}=this.#whaleZoneTimeouts();
  const read=Promise.resolve().then(()=>this.whaleZones(u.symbol,{lookbackMs,endMs:end,direction:det.direction,scale:this.config.whaleCvdScale??'auto',maxPages:this.config.whaleZoneMaxPages??WHALE_ZONE_DEFAULTS.maxPages,deadlineMs}))
   .catch(e=>({ok:false,error:String(e?.code||e?.message||e).slice(0,80)}));
  const [snap,atr]=await Promise.all([withTimeout(read,outerMs,{ok:false,error:`timeout ${outerMs/1000}s`}),this.#atr1h(u.symbol).catch(()=>null)]);
  const zr=buildWhaleZones(snap,{price:entry,atrPct:atr});
  const ev=evaluateWhaleZoneBonus(snap,zr,{direction:det.direction,entry,atrPct:atr,bonus:this.config.whaleCvdBonus??WHALE_ZONE_DEFAULTS.bonus});
  // Comparison only: the PR #316 window rule on the same trades (review M3: it includes the spike itself).
  const origin=Number(det.evidence?.originAt),wStart=Math.max(end-WHALE_ZONE_DEFAULTS.windowMaxMs,origin>0&&origin<end?origin:end-WHALE_ZONE_DEFAULTS.windowMaxMs);
  const wSnap=whaleWindowSnapshot(snap,{startMs:wStart,endMs:end}),wEv=evaluateWhaleCvdBonus(wSnap,det.direction,{bonus:this.config.whaleCvdBonus??WHALE_CVD_DEFAULTS.bonus,minSharePct:this.config.whaleCvdMinSharePct??WHALE_CVD_DEFAULTS.minSharePct});
  const w=whaleCvdRecord(wSnap,wEv);
  const window={bonus:w.bonus,code:w.code,scored:false,whaleCvdUSD:w.whaleCvdUSD??null,thresholdUSD:w.thresholdUSD??null,sharePct:w.sharePct??null,startMs:wSnap.startMs??wStart,endMs:end,minutes:wSnap.windowMin??null,coveragePct:wSnap.coveragePct??null};
  const rec=whaleZoneRecord(snap,zr,{...ev,direction:det.direction},{window});
  this.whaleZoneLast={at:end,symbol:u.symbol,direction:det.direction,code:rec.code,bonus:rec.bonus,coveragePct:rec.coveragePct??null,purpleMinUSD:rec.thresholds?.purpleMinUSD??null,
   floorUSD:rec.floorUSD??null,binPct:rec.binPct??null,binSource:rec.binSource??null,nearPct:rec.nearPct??null,nearSource:rec.nearSource??null,scaleSource:rec.thresholds?.source??null,atrPct:Number.isFinite(atr)?+atr.toFixed(4):null};
  return rec;
 }
 async #btcTrend4h(symbol){
  if(symbol==='BTCUSDT')return this.cur?.trend4h??await this.#trend('BTCUSDT');
  if(!this.universe.some(x=>x.symbol==='BTCUSDT'))return null;
  return await this.#trend('BTCUSDT');
 }
 async #consider(u,det,revision){
  const key=scalpClientId(u.symbol,det.barAt,det.direction),skip=(reason,detail)=>{this.#skip(u.symbol,reason,detail);return {entered:false,reason}};
  if(this.store.sent.includes(key))return {entered:false,reason:'ALREADY_SENT'};
  // Blocked since the scan loop looked (kill switch, disarm, cooldown during the candle / zone reads): no order (review L2).
  {const why=this.#blocked()||(revision!==this.entryRevision?'NOT_ARMED':null);if(why)return skip(why)}
  const pre=await this.#precheck(u,det);if(pre)return pre;
  // Reserved right after the check, before any await: the signal strategy sees it through heldSymbols and
  // cannot enter the same coin in between (review 2026-11-16).
  this.reserved.add(u.symbol);this.reservedDirections.set(u.symbol,det.direction);
  try{
   const maxSpread=Number(this.config.maxSpreadPct)||0;
   const [contractsMap,rawPrice,funds,bk,levInfo,btcTrend4h]=await Promise.all([
    this.contracts(u.symbol).catch(()=>null),
    withTimeout(Promise.resolve().then(()=>this.priceOf(u.symbol,u.venueSymbol)),3000),
    this.#funds(),
    maxSpread>0&&typeof this.bookOf==='function'
     ?withTimeout(Promise.resolve().then(()=>this.bookOf(u.symbol,u.venueSymbol)),2500).catch(()=>null):null,
    typeof this.client.leverage==='function'
     ?Promise.resolve().then(()=>this.client.leverage(u.venueSymbol)).catch(()=>null):null,
    this.config.trendMode==='off'?null:this.#btcTrend4h(u.symbol).catch(()=>null),
   ]);
   const c=contractsMap?.get?.(u.symbol);if(!c?.tradable)return skip('CONTRACT_UNAVAILABLE');
   const price=pos(rawPrice);
   if(!funds)return skip('NO_BALANCE');
   const lowMargin=this.#accountMarginLow(funds);
   if(lowMargin)return skip('ACCOUNT_MARGIN_RESERVE',lowMargin);
   if(maxSpread>0&&bk){
    const bid=pos(bk?.bid),ask=pos(bk?.ask),mid=bid&&ask?(bid+ask)/2:0;
    if(mid>0&&ask>=bid){
     const spPct=(ask-bid)/mid*100;
     if(spPct>maxSpread)return skip('SPREAD_TOO_WIDE',`${spPct.toFixed(2)}% > ${maxSpread}%`);
    }
   }
   let maxVenueLev=null;
   {const max=Number((det.direction==='SHORT'?levInfo?.maxShortLeverage:levInfo?.maxLongLeverage)??levInfo?.maxLeverage);if(max>0)maxVenueLev=Math.floor(max)}
   if(det.immediatePump&&price>0){
    const d=dirOf(det.direction),a=pos(det.atr)??price*0.015;
    const span=Math.max(pos(det.immediateSpan)??0,price*Math.max(0.02,(Number(det.evidence?.movePct)||10)/100),a*2);
    det={...det,entry:price,atr:a,
     stop:d>0?Math.max(price*0.5,price-Math.max(a*1.5,price*0.02)):price+Math.max(a*1.5,price*0.02),
     targets:[price+d*span*0.382,price+d*span*0.618,price+d*span*0.786]};
    if(this.cur){this.cur.atr=a;this.cur.lensEntry=price}
   }
   const lev=det.twoPct
    ?Math.max(1,Math.floor(maxVenueLev>0?Math.min(Number(det.leverage)||Number(this.config.twoPctLeverage)||TWO_PCT_DEFAULTS.leverage,maxVenueLev):(Number(det.leverage)||Number(this.config.twoPctLeverage)||TWO_PCT_DEFAULTS.leverage)))
    :scalpAdaptiveLeverage({atr:det.atr,price:price??det.entry,baseLeverage:this.config.leverage,maxLeverage:maxVenueLev,config:this.config});
   const shared=this.budget?.snapshot(funds.equity,{who:'scalp'});
   if(shared&&!shared.ok)return skip('TESTNET_BUDGET_UNAVAILABLE');
   // Legacy 4H against-trend 50% reduction applies only when 100-point scoring is disabled (scoring already weights 4H trend 0/20).
   const againstTrend=!det.twoPct&&!(Number(this.config.minScore)>0)&&this.config.trendMode==='record'&&this.cur?.withTrend===false;
   const rawSess=scalpSessionMultiplier(this.now(),this.config);
   const euMult=rawSess.session==='EUROPE'?rawSess.mult:1;
   const basePlanConfig=det.twoPct
    ?{...this.config,riskPct:this.config.riskPct*euMult,stopLossEnabled:true,scaleIn:false,minNetRR:Number(this.config.twoPctMinNetRR??TWO_PCT_DEFAULTS.minNetRR),maxDriftPct:Math.max(Number(this.config.maxDriftPct)||0.4,0.8),driftMovePct:10,stopKeepPct:50}
    :(againstTrend?{...this.config,riskPct:this.config.riskPct*SCALP_AGAINST_TREND_RISK_SCALE}:this.config);
   let plan=planScalpOrder({det,price,contract:c,equity:funds.equity,available:funds.available,
    usedMargin:shared?.marginUSD??this.#usedMargin(),totalMarginCapUSD:shared?.marginCapUSD,leverage:lev,config:basePlanConfig});
   if(!plan.ok&&!det.twoPct&&this.#management()===SCALP_MANAGEMENTS.LADDER&&price>0&&Array.isArray(plan.reasons)&&plan.reasons.length
    &&plan.reasons.every(r=>r==='TARGETS_NOT_BEYOND_EXECUTABLE_ENTRY'||r==='TP1_NET_RR_BELOW_MINIMUM')){
    const takerRate=Math.max(Number(c?.takerFeeRate)||0,SCALP_EXEC_COSTS.takerRate);
    plan={ok:true,entry:price,stop:det.stop,targets:det.targets||[],parts:[1,0,0],takerRate,netRR:plan.netRR??0,driftPct:plan.driftPct??0,qty:0,riskUSD:0,marginUSD:0,ladderBypassedFib:true};
   }
   if(this.cur)this.cur.plan={price,ok:plan.ok,entry:plan.entry??null,stop:plan.stop??null,targets:plan.targets??null,netRR:plan.netRR??null,driftPct:plan.driftPct??null,qty:plan.qty??null,riskUSD:plan.riskUSD??null,leverage:lev};
   if(!plan.ok)return skip(plan.reasons[0],plan.driftPct!=null?`${plan.driftPct}%${plan.allowedPct!=null?` > ${plan.allowedPct}%`:''}`:plan.netRR!=null?`RR ${Number(plan.netRR).toFixed(2)}`:null);
   const skipScore=det.immediatePump===true||det.twoPct===true;
   // Data-calibrated 100-point setup score (40-coin BingX 5m Train/OOS): filter negative-EV (<minScore) & scale up A/S setups.
   let scalpScore=scoreScalpSetup({direction:det.direction,evidence:det.evidence,trend4h:this.cur?.trend4h??null,btcTrend4h,netRR:plan.netRR,config:this.config});
   // Backtest-validated confirmed-bounce sizing (C7, 40 coins Train/OOS): >=20% bounce (PF 3.55) -> 1.35x, <20% (PF 1.64) -> 0.8x.
   const minSc=Number(this.config.minScore)||0,oiBonusCfg=Number(this.config.orderflowOiBonus??5),cvdBonusCfg=Number(this.config.orderflowCvdBonus??5);
   // 고래 매물대 ±whaleBonusCfg (user 2026-11-25 "(나) 진행", 09:51 매물대): only with the score gate on (skipped on immediate/twoPct pump entry).
   const whaleOn=!skipScore&&minSc>0&&this.config.whaleCvd!==false&&typeof this.whaleZones==='function',whaleBonusCfg=whaleOn?Math.max(0,Math.min(5,Number(this.config.whaleCvdBonus??WHALE_CVD_DEFAULTS.bonus))):0;
   // Every candidate a bonus could lift to the gate (OI + CVD + whale) has its orderflow read; at or above the gate too, so a −whale can drop it.
   const maxOfBonus=Math.max(0,oiBonusCfg)+Math.max(0,cvdBonusCfg)+whaleBonusCfg;
   const bounce=minSc>0?scalpBounceMultiplier(det.evidence?.retracedPct,this.config):{active:false,confirmed:false,mult:1,retracedPct:null};
   const tierEnabled=minSc>0&&this.config.scoreTierSizing!==false;
   if(bounce.active&&scalpScore.pass)scalpScore={...scalpScore,sizeMult:bounce.mult,bounce};
   else if(tierEnabled&&scalpScore.pass)scalpScore={...scalpScore,sizeMult:1};
   // Backtest-validated orderflow boost (FJ + A-3): +5pt on 30m OI flush <=-1%, +5pt & 1.5x sizing on strong CVD reversal flip (>15%).
   const wantOrderflowBoost=!skipScore&&this.config.orderflowBoost!==false&&scalpScore.score>=Math.max(0,minSc-maxOfBonus);
   const wantSqueezeGuard=this.config.squeezeGuard!==false&&(skipScore||minSc<=0||scalpScore.score>=Math.max(0,minSc-maxOfBonus));
   const wantPreFunding=Number(this.config.preFundingWindowMin)>0&&Number(this.config.preFundingExtremePct)>0&&(skipScore||minSc<=0||scalpScore.score>=Math.max(0,minSc-maxOfBonus));
   const wantWhale=whaleOn&&scalpScore.score>=Math.max(0,minSc-maxOfBonus);
   // The orderflow and the whale trades are read side by side; a failure or a timeout of either never blocks (0 points).
   const [ofSnap,whale]=await Promise.all([
    (wantOrderflowBoost||wantSqueezeGuard||wantPreFunding)&&typeof this.orderflow==='function'
     ?withTimeout(Promise.resolve().then(()=>this.orderflow(u.symbol)),3500).catch(()=>null):null,
    wantWhale?this.#whaleZoneFor(u,det,plan.entry??price??det.entry):null]);
   let ofBoost=null;
   if(wantOrderflowBoost&&ofSnap){
    const boost=evaluateScalpOrderflowBoost(ofSnap,det.direction,{oiBonus:oiBonusCfg,cvdBonus:cvdBonusCfg,cvdSizeMult:Number(this.config.orderflowCvdSizeMult??1.5)});
    if(boost.available)ofBoost=boost;
   }
   const whaleBonus=whale?.bonus||0;
   if(ofBoost||whaleBonus!==0){
    // OI / CVD (+) and the whale (±) go on the total before the gate and the tier, clamped 0..100.
    const nextScore=Math.max(0,Math.min(100,scalpScore.score+(ofBoost?.oiBonus||0)+(ofBoost?.cvdBonus||0)+whaleBonus));
    const nextGrade=scalpScoreGrade(nextScore,scalpScore); // the gate / A / S edges scoreScalpSetup used
    const nextPass=minSc>0?nextScore>=minSc:true;
    const highScore=Number(this.config.highScore??SCALP_SCORE_DEFAULTS.highScore);
    const baseMult=bounce.active?bounce.mult:(tierEnabled?1:(nextScore>=highScore?Number(this.config.highScoreSizeMult??SCALP_SCORE_DEFAULTS.highSizeMult):1));
    const nextMult=ofBoost?.cvdBoost?Math.max(baseMult,ofBoost.sizeMult):baseMult;
    scalpScore={...scalpScore,score:nextScore,grade:nextGrade,pass:nextPass,sizeMult:nextMult,
     ...(ofBoost?{oiBonus:ofBoost.oiBonus,cvdBonus:ofBoost.cvdBonus||0,orderflow:ofBoost}:{}),...(bounce.active?{bounce}:{})};
   }
   if(whale)scalpScore={...scalpScore,whaleBonus,whaleCvd:whale};
   // Score-tier sizing by grade (user 2026-11-25 08:28): B 70~74 0.75x, B+ 75~79 0.9x, A 80~84 1.0x, A+ 85~89 1.2x, S 90+ 1.4x (initial margin cap fixed).
   const scoreTier=minSc>0?scalpScoreTierMultiplier(scalpScore.score,this.config):{active:false,tier:null,mult:1};
   // Backtest-validated session asymmetry (EU 08-14 UTC -> 0.5x, US/Late 14-24 UTC -> 1.15x; only active when scoring is enabled).
   const sess=minSc>0?rawSess:{session:'OFF',labelKo:'',mult:1};
   const effectiveMult=+(Math.max(0.1,Math.min(3,(scalpScore.sizeMult||1)*scoreTier.mult*sess.mult))).toFixed(4);
   if(scoreTier.active||sess.session!=='OFF')scalpScore={...scalpScore,...(scoreTier.active?{scoreTier}:{}),...(sess.session!=='OFF'?{session:sess}:{}),effectiveMult};
   if(this.cur){this.cur.btcTrend4h=btcTrend4h;this.cur.score=skipScore?null:scalpScore}
   if(!skipScore&&minSc>0&&!scalpScore.pass){
    return skip('SCORE_BELOW_MINIMUM',`${scalpScore.score}점/${this.config.minScore}점 (${scalpScore.grade}급 · ${scalpScore.shortBreakdown}${whaleBonus?` · 고래매물대${whaleBonus>0?'+':''}${whaleBonus}`:''})`);
   }
   if(wantSqueezeGuard&&ofSnap){
    const sq=evaluateScalpSqueezeGuard(ofSnap,det.direction,{fundingPct:this.config.squeezeFundingPct,oiChange30mPct:this.config.squeezeOiChange30mPct});
    if(sq.blocked)return skip(sq.reason,sq.detail);
   }
   if(wantPreFunding&&ofSnap?.funding){
    const ratePct=num(ofSnap.funding.ratePct),nextAt=num(ofSnap.funding.nextFundingTime);
    const leftMs=nextAt!=null?nextAt-this.now():null;
    const winMs=Number(this.config.preFundingWindowMin)*60000,lim=Number(this.config.preFundingExtremePct);
    const adverse=ratePct!==null&&(det.direction==='LONG'?ratePct>=lim:ratePct<=-lim);
    if(adverse&&leftMs!==null&&leftMs>=0&&leftMs<=winMs){
     const leftMin=Math.max(0,Math.ceil(leftMs/60000));
     return skip('PRE_FUNDING_EXTREME',`펀딩 ${ratePct>=0?'+':''}${ratePct.toFixed(3)}% · 정산 ${leftMin}분 전`);
    }
   }
   if(!skipScore&&!againstTrend&&Math.abs(effectiveMult-1)>1e-6){
    const scaled=planScalpOrder({det,price,contract:c,equity:funds.equity,available:funds.available,
     usedMargin:shared?.marginUSD??this.#usedMargin(),totalMarginCapUSD:shared?.marginCapUSD,leverage:lev,
     config:{...basePlanConfig,riskPct:basePlanConfig.riskPct*effectiveMult}});
    if(scaled.ok){
     plan=scaled;
     if(this.cur?.plan)Object.assign(this.cur.plan,{qty:plan.qty??null,riskUSD:plan.riskUSD??null,sizeMult:effectiveMult});
    }
   }
   // TRADER_LADDER (tuned 2026-11-27): 4-step 2·2·4·8 ladder (50% capShare), full 1.0x in Asia/US and 0.5x in EU session.
   // TWO_PCT uses fixed wick SL + 2-stage TP (never TRADER_LADDER).
   if(!det.twoPct&&this.#management()===SCALP_MANAGEMENTS.LADDER){
    const lad=await this.#ladderPlan({u,c,plan,funds,shared,lev,sizeMult:euMult,trigger:this.cur?.trigger??null});
    if(!lad.ok)return skip(lad.reason,lad.detail);
    plan=lad.plan;
    if(this.cur?.plan)Object.assign(this.cur.plan,{qty:plan.qty,riskUSD:plan.riskUSD,management:SCALP_MANAGEMENTS.LADDER,ladderUnits:plan.ladder.units,unitMarginUSD:plan.ladder.unitMarginUSD,reserveMarginUSD:plan.ladder.reserveMarginUSD,spacingPct:plan.ladder.spacingPct});
   }
   // Reserve a plan that fits the shared budget while the venue setup runs. A larger plan may still fit after the cap.
   const holdRisk=plan.ladder?.reserveRiskUSD??plan.riskUSD,holdMargin=plan.ladder?.reserveMarginUSD??plan.marginUSD;
   if(this.budget?.check({equity:funds.equity,newRiskUSD:holdRisk,newMarginUSD:holdMargin,who:'scalp'}).ok)
    this.reservedRisk.set(u.symbol,{riskUSD:holdRisk,marginUSD:holdMargin});
   return await this.#enter(u,det,c,plan,key,{revision,equity:funds.equity});
  }catch(e){return skip(e?.code==='HTTP_429'?'HTTP_429':'ENTRY_SETUP_FAILED',e?.code||e?.message)}
  finally{this.reserved.delete(u.symbol);this.reservedDirections.delete(u.symbol);this.reservedRisk.delete(u.symbol)}
 }
 /** The TRADER_LADDER plan of an entry (scalp_ladder.mjs): 4-step 2·2·4·8 (16 units) on 50% of per-symbol cap, held
  * within the shared margin room and 90 % of the free margin; spacing from the 1H ATR (>= 2.5%); worst case reserved. */
 async #ladderPlan({u,c,plan,funds,shared,lev,sizeMult,trigger=null}){
  const finalLine=Number(this.config.emergencyStopRoePct)||0;
  // Without the final line a full ladder would have no loss exit: no entry.
  if(!(finalLine>0))return {ok:false,reason:'LADDER_FINAL_LINE_OFF'};
  const symbolCapUSD=funds.equity*this.config.maxMarginPct/100*(TRADER_LADDER.capShare??1);
  const roomUSD=Math.min((shared?.marginCapUSD??funds.equity*this.config.maxTotalMarginPct/100)-(shared?.marginUSD??this.#usedMargin()),funds.available!=null?funds.available*.9:Infinity);
  const lad=planLadder({symbolCapUSD,roomUSD,leverage:lev,price:plan.entry,quantityStep:c.quantityStep,minQty:c.minQuantityBase,minNotional:c.minNotionalUSDT,sizeMult});
  if(!lad.ok)return {ok:false,reason:lad.reason,detail:lad.reason==='LADDER_BELOW_MINIMUM'?`첫 진입 최소 $${lad.minUnitMarginUSD} · 한도 $${lad.capUSD}`:null};
  const sp=ladderSpacing({atrPct:await this.#atr1h(u.symbol),leverage:lev,finalLineRoePct:finalLine,minPct:this.config.ladderSpacingMinPct});
  const reservePct=(SCALP_EXEC_COSTS.spreadBps+SCALP_EXEC_COSTS.slippageBps)/1e4+SCALP_EXEC_COSTS.fundingRate;
  const reserve=ladderReserve({totalMarginUSD:lad.totalMarginUSD,leverage:lev,finalLineRoePct:finalLine,takerRate:plan.takerRate,reservePct});
  const tpNetPct=trigger===SCALP_TRIGGERS.PUMP?(this.config.pumpLadderTpNetPct??2):this.config.ladderTpNetPct;
  const ladder={v:TRADER_LADDER.version,units:[...lad.units],plannedUnits:[...lad.units],unitMarginUSD:lad.unitMarginUSD,symbolCapUSD:+symbolCapUSD.toFixed(4),capUSD:lad.capUSD,
   sizeMult:lad.sizeMult,capped:lad.capped,raised:lad.raised,shortened:lad.shortened,minQty:lad.minQty,
   spacingPct:sp.spacingPct,spacingBasePct:sp.basePct,spacingCapPct:sp.capPct,spacingCapped:sp.capped,atrPct:sp.atrPct,
   tpNetPct,maxHoldMin:this.config.ladderMaxHoldMin,finalLineRoePct:finalLine,reservePct,
   reserveMarginUSD:reserve.marginUSD,reserveRiskUSD:reserve.riskUSD,filled:0,fills:[],attempt:0,lastFill:null,size:0,state:'WATCH',source:{...TRADER_LADDER.source}};
  const qty=lad.qty0;
  return {ok:true,plan:{...plan,qty,parts:[qty,0,0],targetCount:1,merged:false,marginUSD:qty*plan.entry/lev,riskUSD:reserve.riskUSD,scaleIn:null,ladder}};
 }
 /** BTC 5m/15m shock check (cached once per 5m bucket) to avoid catching simultaneous altcoin knives during BTC dumps/pumps. */
 async #btcShock(bucket){
  if(this.btcShockCache?.b===bucket)return this.btcShockCache.v;
  if(!this.universe.some(x=>x.symbol==='BTCUSDT')||typeof this.candles!=='function')return null;
  const rows=await withTimeout(this.candles('BTCUSDT','5m',5),2500);
  const closed=(Array.isArray(rows)?rows:[]).filter(r=>Number(r?.[6])<this.now());
  const last=closed.at(-1);
  if(!last)return null;
  const o1=Number(last[1]),c1=Number(last[4]);
  const pct5m=o1>0&&c1>0?(c1/o1-1)*100:0;
  const bar3=closed.length>=3?closed.at(-3):null;
  const o3=Number(bar3?.[1]);
  const pct15m=o3>0&&c1>0?(c1/o3-1)*100:0;
  const v={pct5m:+pct5m.toFixed(2),pct15m:+pct15m.toFixed(2)};
  this.btcShockCache={b:bucket,v};
  return v;
 }
 /** Per-symbol loss cooldown: rest after a recent losing close or after N same-KST-day losses on the same coin. */
 #symbolLossCooldown(symbol,now=this.now()){
  const coolMin=Number(this.config.symbolLossCooldownMin)||0;
  const maxDay=Number(this.config.symbolDailyMaxLosses)||0;
  if(!(coolMin>0)&&!(maxDay>0))return null;
  const today=kstDay(now);
  let dayLosses=0,lastLossAt=0;
  for(const x of this.store.closed){
   if(x?.symbol!==symbol||x.closeReason==='MANUAL')continue;
   const net=Number(x.netUSD),at=Number(x.closedAt)||0;
   if(!(net<0)||!(at>0))continue;
   if(kstDay(at)===today)dayLosses++;
   if(at>lastLossAt)lastLossAt=at;
  }
  if(maxDay>0&&dayLosses>=maxDay)return `당일 ${dayLosses}회 손실 · 내일(KST)까지 휴식`;
  if(coolMin>0&&lastLossAt>0&&now-lastLossAt<coolMin*60000){
   const leftMin=Math.max(1,Math.ceil((coolMin*60000-(now-lastLossAt))/60000));
   return `최근 손실 후 ${leftMin}분 남음`;
  }
  return null;
 }
 /** Per-symbol TWO_PCT re-entry cooldown (2026-11-27): 4h after a loss, 1h after a win to block same-coin overtrading. */
 #twoPctCooldown(symbol,now=this.now()){
  const lossMin=Number(this.config.twoPctLossCooldownMin??TWO_PCT_DEFAULTS.lossCooldownMin)||0;
  const winMin=Number(this.config.twoPctWinCooldownMin??TWO_PCT_DEFAULTS.winCooldownMin)||0;
  if(!(lossMin>0)&&!(winMin>0))return null;
  let lastLossAt=0,lastWinAt=0;
  for(const x of this.store.closed){
   if(x?.symbol!==symbol||!x?.twoPct||x.closeReason==='MANUAL')continue;
   const net=Number(x.netUSD),at=Number(x.closedAt)||0;
   if(!(at>0)||!Number.isFinite(net))continue;
   if(net<0&&at>lastLossAt)lastLossAt=at;
   if(net>=0&&at>lastWinAt)lastWinAt=at;
  }
  if(lossMin>0&&lastLossAt>0&&now-lastLossAt<lossMin*60000){
   const leftMin=Math.max(1,Math.ceil((lossMin*60000-(now-lastLossAt))/60000));
   return {reason:'TWO_PCT_LOSS_COOLDOWN',detail:`2% 손절 후 ${leftMin}분 남음 (${lossMin}분 휴식)`};
  }
  if(winMin>0&&lastWinAt>0&&now-lastWinAt<winMin*60000){
   const leftMin=Math.max(1,Math.ceil((winMin*60000-(now-lastWinAt))/60000));
   return {reason:'TWO_PCT_WIN_COOLDOWN',detail:`2% 익절 후 ${leftMin}분 남음 (${winMin}분 휴식)`};
  }
  return null;
 }
 /** The cheap entry checks: 4H trend (cached per 4H candle), EU counter-trend block, BTC shock guard, position cap, same-side cap, one per symbol, another strategy's coin, per-symbol cooldowns.
  * A skip result, or null. Used by #consider and, before any zone read, by #zoneCheck. */
 async #precheck(u,det){
  const skip=reason=>detail=>{this.#skip(u.symbol,reason,detail);return {entered:false,reason}};
  if(this.config.trendMode!=='off'){const trend=await this.#trend(u.symbol);if(this.cur){this.cur.trend4h=trend;this.cur.withTrend=trend==null||trend==='range'?null:trendAllows(det.direction,trend)}
   if(!det.twoPct&&this.config.trendMode==='on'&&!trendAllows(det.direction,trend))return skip(trend===null?'TREND_4H_UNAVAILABLE':'AGAINST_4H_TREND')(trend)}
  if(!det.twoPct&&this.config.euBlockCounterTrend!==false&&this.cur?.withTrend===false&&scalpSessionMultiplier(this.now(),this.config).session==='EUROPE'){
   return skip('EU_SESSION_AGAINST_TREND')('유럽장(17~23 KST) 4H 역추세 진입 차단');
  }
  if(u.symbol!=='BTCUSDT'&&this.config.btcGuard!==false){
   const shock=await this.#btcShock(Math.floor(this.now()/I5));
   if(shock){
    const release=Number(this.config.btcGuardRelease5mPct??SCALP_BTC_GUARD_RELEASE_5M_PCT);
    if(det.direction==='LONG'&&(shock.pct5m<=-SCALP_BTC_GUARD_5M_PCT||(shock.pct15m<=-SCALP_BTC_GUARD_15M_PCT&&!(release>0&&shock.pct5m>=release))))
     return skip('BTC_DUMP_GUARD')(`BTC 5m ${shock.pct5m}% · 15m ${shock.pct15m}%`);
    if(det.direction==='SHORT'&&(shock.pct5m>=SCALP_BTC_GUARD_5M_PCT||(shock.pct15m>=SCALP_BTC_GUARD_15M_PCT&&!(release>0&&shock.pct5m<=-release))))
     return skip('BTC_PUMP_GUARD')(`BTC 5m +${shock.pct5m}% · 15m +${shock.pct15m}%`);
   }
  }
  if(this.config.maxOpen>0&&this.store.open.length+this.reserved.size>=this.config.maxOpen)return skip('MAX_OPEN_POSITIONS')();
  const maxSide=Number(this.config.maxSameSide)||0;
  if(maxSide>0){
   const openSame=this.store.open.filter(p=>p.direction===det.direction).length;
   let resSame=0;for(const [sym,dir] of this.reservedDirections)if(dir===det.direction&&!this.store.open.some(p=>p.symbol===sym))resSame++;
   if(openSame+resSame>=maxSide)return skip('MAX_SAME_SIDE')(`${det.direction==='SHORT'?'숏':'롱'} ${openSame+resSame}/${maxSide}종목`);
  }
  if(this.store.open.some(p=>p.symbol===u.symbol)||this.reserved.has(u.symbol))return skip('SYMBOL_ALREADY_HELD')();
  let busy=false;try{busy=this.isBusy(u.symbol,u.venueSymbol)}catch{busy=true}
  if(busy)return skip('SYMBOL_HELD_BY_OTHER_STRATEGY')();
  if(det.twoPct){
   const tpCool=this.#twoPctCooldown(u.symbol,this.now());
   if(tpCool)return skip(tpCool.reason)(tpCool.detail);
  }
  const cool=this.#symbolLossCooldown(u.symbol,this.now());
  if(cool)return skip('SYMBOL_LOSS_COOLDOWN')(cool);
  return null;
 }
 /** Scale factor for legacy uncapped VST positions/closes when testnet capitalCapUSD is active (1 for $3k-capped trades). */
 #displayScaleFor(p){
  const cap=this.budget?.capitalCapUSD;
  if(!(cap>0))return 1;
  if(pos(p?.capitalBasisUSD)&&Number(p.capitalBasisUSD)<=cap*1.5)return 1;
  const ds=this.budget?.displayScale?.();
  const base=Number.isFinite(ds)&&ds>0&&ds<1?ds:1;
  // Even when BingX VST balance is near cap (e.g. $3,002 vs $3,000 -> ds=0.9993), legacy oversized VST trades must still scale down.
  const r=Number(p?.initialRiskUSD??p?.riskUSD??p?.plan?.riskUSD)||0;
  const m=Number(p?.initialMarginUSD??p?.margin?.initialUSD??p?.marginUSD??p?.plan?.marginUSD)||0;
  if(m*base>cap*0.18||r*base>cap*0.05){
   const rp=Number(this.config?.riskPct)>0?Number(this.config.riskPct):0.5;
   const implied=Math.max(r>0?r/(rp/100):0,m>0?m/0.05:0,100000);
   return +(Math.min(base,cap/implied)).toFixed(6);
  }
  return base;
 }
 /** Getters for the shared TESTNET budget (testnet_budget.mjs). Read only. */
 budgetSource(){
  const reserved=k=>[...this.reservedRisk.values()].reduce((t,x)=>t+(x[k]||0),0);
  const scaleOf=p=>this.#displayScaleFor(p);
  return {
   realizedToday:day=>this.store.closed.filter(x=>kstDay(x.closedAt)===day).reduce((t,x)=>t+(Number(x.netUSD)||0)*scaleOf(x),0),
   openRisk:()=>this.store.open.reduce((t,p)=>{
    if(isLadder(p))return t+ladderHeldRisk(p)*scaleOf(p);
    const sc=scaleOf(p),d=dirOf(p.direction),e=pos(p.avg||p.entry),st=pos(p.stop),q=pos(p.size||p.qty),pending=(p.scaleIn?.state==='PENDING'?(p.scaleIn.reservedRiskUSD||0):0)*sc;
    if(!e||!st||!q)return t+pending;
    if(posNoStop(p,this.config))return t+this.#repeatRisk(p,e,p.mark)*q*sc+pending;
    const unit=p.scaleIn||p.twoPct?riskAtStop(p.direction,e,st,p.takerRate):Math.max(0,d*(e-st));
    if(p.scaleIn&&p.status==='SUBMITTING')return t+Math.max(unit*q,p.riskUSD)*sc+pending;
    return t+unit*q*sc+pending;
   },0)+reserved('riskUSD'),
   usedMargin:()=>this.store.open.reduce((t,p)=>{
    const sc=scaleOf(p);
    if(isLadder(p))return t+ladderHeldMargin(p)*sc;
    return t+((p.size||p.qty||0)*(p.avg||p.entry||0)/(p.leverage||1)+(p.scaleIn?.state==='PENDING'?(p.scaleIn.reservedMarginUSD||0):0))*sc;
   },0)+reserved('marginUSD'),
   unrealized:()=>this.store.open.reduce((t,p)=>t+(Number(p.unrealized)||0)*scaleOf(p),0),
   stoppedToday:day=>this.#todayStopped(day),
  };
 }
 async #enter(u,det,c,initialPlan,id,{revision,equity}){
  const cl=this.client,vs=u.venueSymbol,d=det.direction,skip=(reason,detail)=>{this.#skip(u.symbol,reason,detail);return {entered:false,reason}};
  let plan=initialPlan;
  // The account's position mode (one-way or hedge, user 2026-11-17), read before every entry and kept on the
  // position: its stop, targets, breakeven and closes use the mode it was opened under. Never guessed.
  const mode=await readPositionMode(cl);if(!mode.ok)return skip(mode.reason,mode.detail);
  const hedge=mode.hedge;
  // otherSide: a position on the other side of this coin (hedge mode) shares the symbol's fund-flow rows.
  // Manual first on the real account (user 2026-11-25 "수동이 먼저야"): any position of the coin that is not ours is the
  // user's -> MANUAL_FIRST (testnet keeps VENUE_POSITION_EXISTS); so is a user TP / SL / reduce-only order on the coin.
  const live=this.config.mode==='LIVE';
  let otherSide=false;{const now=await this.#position(vs,d,hedge);if(now.any>0)return skip(live?'MANUAL_FIRST':'VENUE_POSITION_EXISTS',`${now.signed}`);otherSide=now.other>0}
  if(live&&typeof cl.openOrders==='function'){
   let orders;try{orders=await this.#openOrders(vs)}catch{return skip('MANUAL_ORDERS_UNREADABLE')}
   const userOrder=(Array.isArray(orders)?orders:[]).find(o=>o?.symbol===vs&&(String(o.reduceOnly).toLowerCase()==='true'||String(o.closePosition).toLowerCase()==='true'||/STOP|TAKE_PROFIT|TRAILING/i.test(String(o.type||''))));
   if(userOrder)return skip('MANUAL_FIRST',`사용자 ${String(userOrder.type||'').toUpperCase()} 주문`);
  }
  try{
   const m=await cl.marginType(vs).catch(()=>null);
   // Hedge: a position on the other side shares the symbol's margin mode; it is never switched under it.
   if(live&&otherSide&&m?.marginType!=='CROSSED')return skip('MANUAL_FIRST','반대쪽 포지션의 마진 모드를 바꾸지 않음');
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
  if(venueAvailableQty!==null&&venueAvailableQty<requestedQty&&plan.ladder)return skip('VENUE_POSITION_LIMIT',`가용 ${venueAvailableQty}개 · 첫 단위 ${requestedQty}개`);
  if(venueAvailableQty!==null&&venueAvailableQty<requestedQty){
   const qty=Number(grid(venueAvailableQty,c.quantityStep,'DOWN'))||0;
   const split=det.singleTarget===true?(qty>=plan.minPart-Number(c.quantityStep)*1e-6&&qty>0?{parts:[qty,0,0],targets:1,merged:false}:null):scalpSplits(qty,c.quantityStep,plan.minPart);
   if(!split)return skip('VENUE_POSITION_LIMIT',`가용 ${venueAvailableQty}개 · 최소 ${plan.minPart}개`);
   const ratio=qty/requestedQty;
   plan={...plan,qty,parts:split.parts,targetCount:split.targets,merged:split.merged,
    riskUSD:plan.riskUSD*ratio,marginUSD:plan.marginUSD*ratio};
   if(this.cur?.plan)Object.assign(this.cur.plan,{qty,riskUSD:plan.riskUSD});
  }
  // Check the final size and save it in the ledger before yielding to order dispatch.
  this.reservedRisk.delete(u.symbol);
  // A ladder is checked with its whole reserved budget (every step at the final line), not its first unit.
  const holdRisk=plan.ladder?.reserveRiskUSD??plan.riskUSD,holdMargin=plan.ladder?.reserveMarginUSD??plan.marginUSD;
  if(this.budget){
   const b=this.budget.check({equity,newRiskUSD:holdRisk,newMarginUSD:holdMargin,who:'scalp'});
   if(this.cur?.plan&&b.snap?.ok)this.cur.plan.openRiskUSD=+(b.snap.usedUSD+holdRisk).toFixed(2);
   if(!b.ok)return skip(b.reason,b.detail);
  }else{
   const day=kstDay(this.now()),realized=this.store.closed.filter(x=>kstDay(x.closedAt)===day).reduce((t,x)=>t+(Number(x.netUSD)||0),0);
   const risk=Math.max(0,-realized)+this.#openRisk()+holdRisk,limit=equity*this.config.dailyLossPct/100;
   if(plan.ladder&&this.#usedMargin()+holdMargin>equity*this.config.maxTotalMarginPct/100+1e-9)return skip('MARGIN_CAP',`$${(this.#usedMargin()+holdMargin).toFixed(2)} > $${(equity*this.config.maxTotalMarginPct/100).toFixed(2)}`);
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
  const trigger=this.cur?.trigger===SCALP_TRIGGERS.PUMP?SCALP_TRIGGERS.PUMP:SCALP_TRIGGERS.SCAN;
  const slEnabled=det.twoPct===true?true:this.config.stopLossEnabled!==false;
  const twoPctMeta=det.twoPct?{...(det.twoPctMeta||{}),netRR:Number.isFinite(Number(plan.netRR))?+Number(plan.netRR).toFixed(2):det.twoPctMeta?.netRR??null,stopPrice:plan.stop,tp1Price:plan.targets?.length>=2?plan.targets[0]:null,tp2Price:plan.targets?.length>=2?plan.targets[1]:(plan.targets?.[0]??null),tpPrice:plan.targets?.at(-1)??null,splitPartial:plan.targets?.length>=2&&plan.parts?.[1]>0}:null;
  const p={id,strategy:SCALP_EXEC_STRATEGY,strategyProfile:SCALP_EXEC_STRATEGY,kind,trigger,...(trigger===SCALP_TRIGGERS.PUMP&&this.cur?.pumpAlert?{pumpAlert:this.cur.pumpAlert}:{}),...(twoPctMeta?{twoPct:twoPctMeta}:{}),...(kind===SCALP_KINDS.ZONE&&this.cur?.zone?{zone:this.cur.zone}:{}),mode:this.execMode,venue:'BINGX',symbol:u.symbol,venueSymbol:vs,direction:d,hedge,...(otherSide?{otherSideSeen:true}:{}),interval:det.twoPct?TWO_PCT_INTERVAL:'5m',
   pattern:det.pattern,barAt:det.barAt,plannedEntry:det.entry,checkedPrice:plan.entry,driftPct:plan.driftPct,entry:plan.entry,stop:plan.stop,initialStop:plan.stop,targets:plan.targets,
   qty:plan.qty,initialQty:plan.qty,parts:plan.parts,targetCount:plan.targetCount,merged:plan.merged,leverage:plan.leverage,riskUSD:plan.riskUSD,initialRiskUSD:plan.riskUSD,marginUSD:plan.marginUSD,initialMarginUSD:plan.marginUSD,capitalBasisUSD:pos(equity)??null,netRR:plan.netRR,
   tickSize:tick,quantityStep:c.quantityStep,takerRate:plan.takerRate,evidence:det.evidence,status:'SUBMITTING',createdAt:this.now(),deadline:det.twoPct?this.now()+(this.config.twoPctMaxHoldMs??TWO_PCT_DEFAULTS.maxHoldMs):det.barAt+this.config.maxHoldMs,
   avg:null,size:0,filled:0,stopOrderId:null,stopIds:[],tpOrderIds:[null,null,null],tpTries:[0,0,0],breakevenMoved:false,exitIds:[],steps:[],
   stopLossEnabled:slEnabled,
   ...(!slEnabled?{profitTargetsReady:true}:{}),
   management:plan.ladder?SCALP_MANAGEMENTS.LADDER:SCALP_MANAGEMENTS.CURRENT,...(plan.ladder?{ladder:plan.ladder}:{}),
   ...(plan.scaleIn?{scaleIn:plan.scaleIn}:{}),
   // Journal context (analysis only).
   atr:det.atr,detectedAt:this.cur?.at??null,candle:this.cur?.candle??null,trend4h:this.cur?.trend4h??null,btcTrend4h:this.cur?.btcTrend4h??null,withTrend:this.cur?.withTrend??null,
   ...(this.cur?.score?{scalpScore:{score:this.cur.score.score,grade:this.cur.score.grade,minScore:this.cur.score.minScore,sizeMult:this.cur.score.sizeMult,breakdown:this.cur.score.breakdown,summary:this.cur.score.summary,...(this.cur.score.oiBonus?{oiBonus:this.cur.score.oiBonus}:{}),...(this.cur.score.cvdBonus?{cvdBonus:this.cur.score.cvdBonus}:{}),...(this.cur.score.orderflow?{orderflow:this.cur.score.orderflow}:{}),...(this.cur.score.whaleCvd?{whaleBonus:this.cur.score.whaleBonus||0,whaleCvd:this.cur.score.whaleCvd}:{}),...(this.cur.score.scoreTier?{scoreTier:this.cur.score.scoreTier}:{}),...(this.cur.score.session?{session:this.cur.score.session}:{}),...(Number.isFinite(Number(this.cur.score.effectiveMult))?{effectiveMult:this.cur.score.effectiveMult}:{})}}:{}),
   universe:this.cur?.universe??null,scan:this.cur?.scan?{...this.cur.scan}:null,tpFills:[null,null,null],journalV:1};
  this.store.open.push(p);this.store.sent.push(id);this.#save();
  let fill,executionMode='MARKET';
  try{
   if(this.config.makerEntry!==false&&typeof cl.getOrder==='function'&&typeof cl.cancelOrder==='function'){
    const exec=await placeMakerThenMarket({
     client:cl,symbol:vs,side:openSide(d),positionSide:positionSideFor({hedge,direction:d}),
     quantity:plan.qty,quantityStep:c.quantityStep,minQuantity:plan.minPart,tickSize:tick,markPrice:plan.entry,
     hedge,clientOrderId:id,
     extraParams:p.stopLossEnabled?{stopLoss:JSON.stringify({type:'STOP_MARKET',stopPrice:Number(px(plan.stop)),workingType:'MARK_PRICE'})}:{},
     waitMs:this.config.makerWaitMs??2500,pollMs:this.config.makerPollMs??400,beforeSend,
    });
    fill=exec.receipt||{orderId:exec.orderId,executedQty:String(exec.filledQty),avgPrice:exec.avg!=null?String(exec.avg):undefined};
    executionMode=exec.executionMode||'MARKET';
   }else{
    fill=await cl.placeOrder({symbol:vs,side:openSide(d),positionSide:positionSideFor({hedge,direction:d}),type:'MARKET',quantity:String(plan.qty),clientOrderId:id,
     ...(p.stopLossEnabled?{stopLoss:JSON.stringify({type:'STOP_MARKET',stopPrice:Number(px(plan.stop)),workingType:'MARK_PRICE'})}:{})},{beforeSend});
   }
  }
  catch(e){
   if(e?.code==='ENTRY_NOT_SENT'){
    this.store.open=this.store.open.filter(x=>x!==p);this.store.sent=this.store.sent.filter(x=>x!==id);
    this.#save();return skip(e.reason);
   }
   // Never sent blindly again: the client id is looked up first; an unknown outcome blocks new entries.
   let found=null;try{found=await cl.getOrder(vs,{clientOrderId:id})}catch{}
   if(!orderId(found)){
    // MAKER_STATE_UNCONFIRMED (maker_order.mjs): the PostOnly child may still rest; never dropped as rejected.
    // HTTP 5xx: an answer that does not say the order was refused (maker_order.mjs rethrows it, review 2026-11-23).
    if(e?.code==='NETWORK_UNREACHABLE'||e?.code==='HTTP_429'||e?.code==='MAKER_STATE_UNCONFIRMED'||/^HTTP_5\d\d$/.test(String(e?.code||''))){
     p.status='UNKNOWN';
     const makerCid=e?.makerClientOrderId||(this.config.makerEntry!==false?makerChildIds(id).limit:null);
     if(makerCid||e?.makerOrderId)p.unknownOrder={makerClientOrderId:makerCid||null,makerOrderId:e?.makerOrderId??null,reason:e?.code||null};
     this.#event('ENTRY_OUTCOME_UNKNOWN',{symbol:p.symbol,reason:e.code});this.#save();return {entered:false,reason:'UNKNOWN'};
    }
    this.store.open=this.store.open.filter(x=>x!==p);this.#save();
    if(e?.code===POSITION_LIMIT_ERROR)return skip('VENUE_POSITION_LIMIT',`${e.code} · 주문 ${plan.qty}개 · 가용 ${venueAvailableQty??'미확인'}`);
    return skip('ENTRY_REJECTED',e?.code||e?.message)}
   fill=found;
  }
  p.entryOrderId=orderId(fill);p.executionMode=executionMode;p.status='OPEN';p.openedAt=this.now();
  const now=await this.#position(vs,d,hedge).catch(()=>({size:0}));
  const confirmedQty=pos(now.size)??pos(orderOf(fill)?.executedQty),confirmedPrice=pos(now.avg)??pos(orderOf(fill)?.avgPrice);
  if(!p.stopLossEnabled&&(!confirmedQty||!confirmedPrice)){
   p.status='UNKNOWN';this.#event('ENTRY_OUTCOME_UNKNOWN',{symbol:p.symbol,reason:'ENTRY_FILL_UNCONFIRMED'});this.#save();return {entered:false,reason:'UNKNOWN'};
  }
  p.filled=p.size=confirmedQty??plan.qty;p.avg=confirmedPrice??plan.entry;p.firstEntryPrice=confirmedPrice??null;p.initialQty=p.filled;
  if(p.scaleIn){
   p.riskUSD=riskAtStop(d,p.avg,p.initialStop,p.takerRate)*p.filled;p.marginUSD=p.avg*p.filled/p.leverage;
   Object.assign(p.scaleIn,{initialEntry:p.avg,initialQty:p.filled,initialMarginUSD:p.marginUSD,initialRiskUSD:p.riskUSD});
  }else if(p.twoPct){
   p.riskUSD=riskAtStop(d,p.avg,p.initialStop,p.takerRate)*p.filled;p.marginUSD=p.avg*p.filled/p.leverage;
  }
  p.initialRiskUSD=p.riskUSD;p.initialMarginUSD=p.marginUSD;
  if(isLadder(p)){this.#ladderOpened(p);p.riskUSD=p.initialRiskUSD=ladderHeldRisk(p)}
  else if(!p.stopLossEnabled){
   this.#enableRepeat(p);
   p.riskUSD=this.#repeatRisk(p,p.avg,p.mark)*p.filled;
   if(p.scaleIn)p.scaleIn.initialRiskUSD=p.riskUSD;
   p.initialRiskUSD=p.riskUSD;
  }
  if(Math.abs(p.filled-plan.qty)>Number(c.quantityStep)/2){
   if(p.twoPct)p.parts=twoPctResizeParts(p.filled,c.quantityStep,p.targets?.length||1);
   else{const s=scalpSplits(p.filled,c.quantityStep,0);if(s)p.parts=s.parts}
  }
  p.steps.push({kind:'OPEN',at:this.now(),qty:p.filled,avg:p.avg});this.#save();
  if(!await this.#protect(p))return {entered:false,reason:p.closeReason||'NO_STOP'};
  await this.#placeTargets(p);
  trackExcursion(p,p.avg,this.now());
  // BTC 5m / 1h change around the entry: read after the orders are in, never awaited (journal only).
  void withTimeout(this.#btc(),5000).then(b=>{if(b)p.btc=b});
  this.#event('OPENED',{symbol:p.symbol,direction:d,id:p.id,kind:p.kind,trigger:p.trigger,executionMode,...(p.twoPct?{twoPct:p.twoPct}:{}),...(p.zone?{zone:{tf:p.zone.tf,low:p.zone.low,high:p.zone.high,distPct:p.zone.distPct}}:{}),entry:p.avg,stop:p.stop,stopLossEnabled:p.stopLossEnabled,...(pos(p.hardStopPrice)?{hardStopPrice:p.hardStopPrice}:{}),targets:p.targets,parts:p.parts,qty:p.filled,leverage:p.leverage,riskUSD:+p.riskUSD.toFixed(2),movePct:det.evidence?.movePct,volumeX:det.evidence?.climaxVolumeRatio,merged:p.merged,...(p.scalpScore?{score:p.scalpScore.score,grade:p.scalpScore.grade,minScore:p.scalpScore.minScore,...(p.scalpScore.breakdown?{breakdown:{...p.scalpScore.breakdown}}:{}),...(p.scalpScore.oiBonus>0?{oiBonus:p.scalpScore.oiBonus}:{}),...(p.scalpScore.cvdBonus>0?{cvdBonus:p.scalpScore.cvdBonus}:{}),...(p.scalpScore.whaleCvd?{whaleBonus:p.scalpScore.whaleBonus||0,whaleCvd:p.scalpScore.whaleCvd,whaleSummary:p.scalpScore.whaleCvd.rule===WHALE_ZONE_RULE?whaleZoneSummaryKo(p.scalpScore.whaleCvd):whaleCvdSummaryKo(p.scalpScore.whaleCvd)}:{}),sizeMult:p.scalpScore.sizeMult,...(p.scalpScore.scoreTier?.active?{scoreTierMult:p.scalpScore.scoreTier.mult}:{}),...(Number.isFinite(Number(p.scalpScore.effectiveMult))?{effectiveMult:p.scalpScore.effectiveMult}:{}),...(p.scalpScore.orderflow?.summaryKo?{orderflowSummary:p.scalpScore.orderflow.summaryKo}:{}),...(p.scalpScore.session?.labelKo?{sessionLabel:p.scalpScore.session.labelKo,sessionMult:p.scalpScore.session.mult}:{})}:{}),...(isLadder(p)?{management:p.management,ladder:this.#ladderView(p)}:{})});
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
  const line={v:1,at:ctx.at,symbol:ctx.symbol,venueSymbol:ctx.venueSymbol,kind:ctx.kind||SCALP_KINDS.MOVE,...(ctx.trigger?{trigger:ctx.trigger,pumpAlert:ctx.pumpAlert??null}:{}),...(ctx.zone?{zone:ctx.zone}:{}),direction:ctx.direction,barAt:ctx.barAt,entered:r?.entered===true,reason:r?.entered?null:ctx.reason||r?.reason||null,
   detail:ctx.detail,evidence:ctx.evidence,candle:ctx.candle,atr:ctx.atr,trend4h:ctx.trend4h??null,btcTrend4h:ctx.btcTrend4h??null,withTrend:ctx.withTrend??null,...(ctx.score?{score:ctx.score}:{}),plan:ctx.plan??null,universe:ctx.universe,scan:ctx.scan,
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
   this.journalRows.push({kind:x.kind||SCALP_KINDS.MOVE,trigger:x.trigger||SCALP_TRIGGERS.SCAN,management:x.management||SCALP_MANAGEMENTS.CURRENT,openedAt:x.openedAt??null,direction:x.direction,netUSD:line.pnl.netUSD,closedAt:x.closedAt,closeReason:x.closeReason,scaleIn:line.scaleIn,scoreGrade:line.score?.grade??x.scalpScore?.grade??null,scoreTotal:line.score?.score??x.scalpScore?.score??null,whaleBonus:whaleKey(line.score??x.scalpScore),whaleSplit:whaleSplitOf(line.score??x.scalpScore),capitalBasisUSD:pos(x.capitalBasisUSD)??null,initialRiskUSD:pos(line.plan?.riskUSD)??null,initialMarginUSD:pos(line.plan?.marginUSD??line.margin?.initialUSD)??null});
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
 async #position(vs,direction,hedge=false,{strict=false}={}){
  const rows=await this.client.positions(vs);
  if(strict&&!Array.isArray(rows))throw err('POSITION_CHECK_FAILED',502);
  const p=positionOf(rows,vs,direction,hedge);
  if(strict&&p.row&&(p.row.positionAmt==null||p.row.positionAmt===''||num(p.row.positionAmt)===null))throw err('POSITION_CHECK_FAILED',502);
  if(strict&&p.any>0&&p.size===0)throw err('POSITION_SIDE_MISMATCH');
  return p;
 }
 async #openOrders(vs){const o=await this.client.openOrders(vs);return o?.orders??(Array.isArray(o)?o:[])}
 /** The attached stop is confirmed; else a whole-position stop is placed; else the position is closed. */
 async #protect(p){
  if(posNoStop(p,this.config)){
   if(Number(this.config.hardStopRoePct)>0)return this.#ensureHardStop(p,{critical:true});
   return this.#retireStop(p);
  }
  let list=null;try{list=await this.#openOrders(p.venueSymbol)}catch{try{list=await this.#openOrders(p.venueSymbol)}catch{}}
  // The stop attached to the entry (same price within a tick when the venue reports it).
  const found=(list||[]).find(o=>String(o.type).startsWith('STOP')&&orderOnSide(o,{hedge:p.hedge===true,direction:p.direction})&&(!pos(o.stopPrice)||Math.abs(Number(o.stopPrice)-p.stop)<=Number(p.tickSize)*1.01));
  if(found){p.stopOrderId=orderId(found);p.stopIds.push(p.stopOrderId);return true}
  try{const s=await this.client.placeOrder(this.#stopParams(p,p.stop,'s'));p.stopOrderId=orderId(s);p.stopIds.push(p.stopOrderId);this.#event('STOP_PLACED',{symbol:p.symbol});return true}
  catch(e){this.#event('STOP_FAILED',{symbol:p.symbol,reason:e?.code||e?.message});await this.#emergency(p,'NO_STOP');this.disarm('NO_PROTECTIVE_STOP');return false}
 }
 /** Exchange-side catastrophic hard stop price at -hardStopRoePct% ROE from current avg entry. */
 #hardStopPrice(p){
  const pct=Number(this.config.hardStopRoePct)||0;
  if(!(pct>0))return null;
  const avg=pos(p.avg)??pos(p.entry),lev=Math.max(1,Number(p.leverage)||10),dir=dirOf(p.direction);
  if(!(avg>0))return null;
  const raw=avg*(1-dir*(pct/100)/lev);
  if(!(raw>0))return null;
  const snapped=Number(grid(raw,p.tickSize,awayMode(p.direction)));
  return snapped>0?snapped:null;
 }
 /** Ensure an exchange-side STOP_MARKET closePosition order protects the position at -hardStopRoePct% ROE. */
 async #ensureHardStop(p,{forceReplace=false,critical=false}={}){
  const target=this.#hardStopPrice(p);
  if(!(target>0))return true;
  const vs=p.venueSymbol,side={hedge:p.hedge===true,direction:p.direction},tick=Number(p.tickSize)||0;
  const tol=Math.max(tick*2,target*0.002);
  const now=this.now();
  if(!forceReplace&&!critical&&p.hardStopOrderId&&pos(p.hardStopPrice)&&Math.abs(p.hardStopPrice-target)<=tol&&now-(p.hardStopVerifiedAt||0)<60000){
   return true;
  }
  let open=[];
  try{open=await this.#openOrders(vs)}catch{open=[]}
  const match=open.find(o=>/^STOP(?:_|$)/i.test(String(o?.type))&&orderOnSide(o,side)&&(!o.side||String(o.side).toUpperCase()===closeSide(p.direction))&&pos(o.stopPrice)&&Math.abs(Number(o.stopPrice)-target)<=tol);
  if(match&&!forceReplace){
   const id=orderId(match);
   p.hardStopOrderId=p.stopOrderId=id;
   p.hardStopPrice=Number(match.stopPrice)||target;
   p.hardStopVerifiedAt=now;
   if(id&&!p.stopIds.includes(id))p.stopIds.push(id);
   this.#save();return true;
  }
  const old=p.hardStopOrderId||p.stopOrderId||null;
  p.hardStopTries=(p.hardStopTries||0)+1;
  const tag='hs'+p.hardStopTries;
  let placed=null;
  try{
   placed=await this.client.placeOrder(this.#stopParams(p,target,tag));
  }catch(e){
   if(/110406/.test(String(e?.code||e?.message))&&old){
    try{await this.client.cancelOrder(vs,old)}catch{}
    p.hardStopOrderId=p.stopOrderId=null;
    try{placed=await this.client.placeOrder(this.#stopParams(p,target,tag+'b'))}
    catch(e2){
     this.#event('STOP_FAILED',{symbol:p.symbol,reason:e2?.code||e2?.message});
     if(critical){await this.#emergency(p,'NO_STOP');this.disarm('NO_PROTECTIVE_STOP')}
     return false;
    }
   }else{
    this.#event('STOP_FAILED',{symbol:p.symbol,reason:e?.code||e?.message});
    if(critical){await this.#emergency(p,'NO_STOP');this.disarm('NO_PROTECTIVE_STOP')}
    return false;
   }
  }
  const id=orderId(placed);
  if(!id){
   this.#event('STOP_FAILED',{symbol:p.symbol,reason:'NO_STOP'});
   if(critical){await this.#emergency(p,'NO_STOP');this.disarm('NO_PROTECTIVE_STOP')}
   return false;
  }
  p.hardStopOrderId=p.stopOrderId=id;
  p.hardStopPrice=target;
  p.hardStopVerifiedAt=now;
  if(!p.stopIds.includes(id))p.stopIds.push(id);
  if(old&&old!==id){try{await this.client.cancelOrder(vs,old)}catch{}}
  this.#event(old?'HARD_STOP_UPDATED':'HARD_STOP_PLACED',{symbol:p.symbol,direction:p.direction,price:target,roePct:this.config.hardStopRoePct});
  this.#save();return true;
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
 #maxAdds(){const m=Number(this.config?.maxScaleInAdds);return Number.isFinite(m)&&m>0?m:SCALP_REPEAT_SCALE_IN.maxAdds}
 #enableRepeat(p){
  if(isLadder(p)||!this.config.scaleIn)return;
  if(p.scaleIn?.version===SCALP_REPEAT_SCALE_IN.version){
   // Re-open positions that were previously skipped solely due to partial exit when >=25% remains and under maxAdds.
   if(p.scaleIn.state==='SKIPPED'&&p.scaleIn.reason==='POSITION_CHANGED'&&!this.#partialTooSmall(p)&&(p.scaleIn.count||0)<this.#maxAdds()){
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
  const rawR=Math.abs(entry-p.initialStop);
  const minPct=Number.isFinite(Number(this.config?.scaleInMinStepPct))?Number(this.config.scaleInMinStepPct):SCALP_REPEAT_SCALE_IN.minStepPct;
  const maxPct=Number.isFinite(Number(this.config?.scaleInMaxStepPct))?Number(this.config.scaleInMaxStepPct):SCALP_REPEAT_SCALE_IN.maxStepPct;
  const minDist=minPct>0?entry*minPct/100:0;
  const maxDist=maxPct>0?entry*maxPct/100:Infinity;
  const baseDist=Math.max(minDist,Math.min(maxDist,rawR));
  return Math.max(Number(p.tickSize),baseDist*this.#repeatStepR(p.scaleIn?.count||0));
 }
 #repeatTrigger(p){return p.scaleIn.anchor-dirOf(p.direction)*this.#repeatDistance(p)}
 #repeatRisk(p,entry,mark){
  const dir=dirOf(p.direction),worst=(pos(mark)??entry)-dir*this.#repeatDistance(p);
  const reference=dir>0?Math.max(Number(p.tickSize),Math.min(p.initialStop,worst)):Math.max(p.initialStop,worst);
  return riskAtStop(p.direction,entry,reference,p.takerRate||SCALP_EXEC_COSTS.takerRate);
 }
 async #considerRepeat(p,mark,{defensive=false,roePct=null}={}){
  const a=p.scaleIn,dir=dirOf(p.direction),nowTs=this.now(),bucket=Math.floor(nowTs/I5),step=Number(p.quantityStep);
  if(!this.config.scaleIn||a?.state!=='WATCH'||this.#blocked()||!mark)return;
  if(a.retryAfterAt&&nowTs<a.retryAfterAt)return;
  if(defensive){
   if((a.count||0)>0||p.everReduced||a.defensiveCheckedBucket===bucket)return;
  }else{
   if(bucket<=Math.floor(p.openedAt/I5)||a.checkedBucket===bucket)return;
  }
  if((a.count||0)>=this.#maxAdds()){a.lastReason='MAX_ADDS_REACHED';return}
  if(this.#partialTooSmall(p)||(!p.everReduced&&Math.abs(p.size-p.filled)>step/2)){this.#addDecision(p,'SKIPPED','POSITION_CHANGED');return}
  const trigger=defensive?mark:this.#repeatTrigger(p);
  if(!defensive&&(!(trigger>0)||dir*(mark-trigger)>1e-12))return;
  if(defensive)a.defensiveCheckedBucket=bucket;else a.checkedBucket=bucket;
  if(await this.#isFallingKnife(p.symbol,p.direction,nowTs)){a.lastReason='FALLING_KNIFE';return}
  const revision=this.entryRevision,vs=p.venueSymbol,hedge=p.hedge===true;
  const [price,funds,fresh,levInfo]=await Promise.all([
   withTimeout(this.priceOf(p.symbol,vs),3000),
   this.#funds({requireAvailable:true}),
   this.#position(vs,p.direction,hedge),
   typeof this.client.leverage==='function'?withTimeout(this.client.leverage(vs),2500):null,
  ]);
  if(!funds){a.lastReason='NO_BALANCE';return}
  if(this.#accountMarginLow(funds)){a.lastReason='ACCOUNT_MARGIN_RESERVE';return}
  if(!fresh.avg||Math.abs(fresh.size-p.size)>step/2||Math.abs(fresh.avg-p.avg)>Number(p.tickSize)/2||this.#partialTooSmall(p,fresh.size)){a.lastReason='POSITION_CHANGED';return}
  if(!fresh.mark&&!pos(price)){a.lastReason='PRICE_OUTSIDE_BAND';return}
  const venueMark=pos(fresh.mark)??pos(price);
  // Pillar 2: Anchor marketable IOC price to venueMark (not live-only priceOf which can diverge 0.5~2% from VST).
  const retryWide=a.lastReason==='NOT_FILLED';
  const retrySlip=Number(this.config.scaleInRetrySlippagePct)||SCALP_REPEAT_SCALE_IN.retrySlippagePct;
  const slip=(retryWide?retrySlip:SCALP_REPEAT_SCALE_IN.slippagePct)/100;
  const refPrice=pos(price)?(dir>0?Math.max(price,venueMark):Math.min(price,venueMark)):venueMark;
  const bound=Number(grid(refPrice*(1+dir*slip),p.tickSize,awayMode(p.direction)))||Number(grid(refPrice+dir*Number(p.tickSize),p.tickSize,awayMode(p.direction)));
  let orderPrice=bound;
  if(defensive){
   const lev=Math.max(1,Number(p.leverage)||10),defLim=Number(this.config.defensiveAddRoePct)||0;
   const defBounce=Number(this.config.defensiveBouncePct??0.4);
   const minConfirmRoe=defBounce>0&&p.defensiveArmed?Math.max(20,defLim-10):defLim;
   const freshRoe=dir*(venueMark-fresh.avg)/fresh.avg*lev*100;
   if(minConfirmRoe>0&&freshRoe>-minConfirmRoe){a.lastReason='PRICE_OUTSIDE_BAND';return}
  }else{
   if(dir*(venueMark-trigger)>1e-12){a.lastReason='PRICE_OUTSIDE_BAND';return}
  }
  const baseQty=p.everReduced?fresh.size:(pos(a.initialQty)??fresh.size);
  const desiredQty=baseQty*this.#repeatMultiplier(a.count||0);
  if(!(desiredQty>=a.minPart&&desiredQty*orderPrice>=a.minNotional)){a.lastReason='MIN_QUANTITY';return}
  const room=this.#scaleBudgetRoom(funds.equity);
  if(!room){a.lastReason='TESTNET_BUDGET';return}
  const rawVenueRoom=p.direction==='SHORT'?levInfo?.availableShortVol:levInfo?.availableLongVol;
  const parsedVenueRoom=typeof rawVenueRoom==='number'||(typeof rawVenueRoom==='string'&&rawVenueRoom.trim()!=='')?num(rawVenueRoom):null;
  const venueRoom=parsedVenueRoom!==null&&parsedVenueRoom>=0?parsedVenueRoom:null;
  if(venueRoom!==null&&!(venueRoom>=a.minPart&&venueRoom*orderPrice>=a.minNotional)){a.lastReason='VENUE_POSITION_LIMIT';return}
  const marginUnit=orderPrice/p.leverage,riskUnit=this.#repeatRisk(p,orderPrice,venueMark);
  const extraExistingRisk=Math.max(0,this.#repeatRisk(p,fresh.avg,venueMark)*fresh.size-this.#repeatRisk(p,p.avg,p.mark)*p.size);
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
  let order,lastTryQty=Infinity,sentQty=0;
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
    reservedRiskUSD:risk,reservedMarginUSD:margin,plannedMarginUSD:margin,unknownLogged:false,lastReason:null,retryAfterAt:null,
    pendingDefensive:defensive===true,pendingDefensiveRoePct:defensive&&Number.isFinite(Number(roePct))?+Number(roePct).toFixed(1):null});
   this.#save();
   try{
    order=orderOf(await this.client.placeOrder({symbol:vs,side:openSide(p.direction),positionSide:positionSideFor({hedge,direction:p.direction}),
     type:'LIMIT',timeInForce:'IOC',price:String(orderPrice),quantity:String(tryQty),clientOrderId:id},{beforeSend:guard}));
    sentQty=tryQty;
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
  // Pillar 2: If a widened retry IOC still expires completely unfilled on thin VST books, immediately fall back to MARKET.
  const iocStatus=String(order?.status||'').toUpperCase();
  if(retryWide&&this.config.scaleInMarketFallback!==false&&sentQty>0&&!pos(order?.executedQty)&&['CANCELED','CANCELLED','EXPIRED'].includes(iocStatus)&&!guard()){
   a.attempt++;
   const mktId=p.id+'a'+(a.attempt+1);
   Object.assign(a,{state:'PENDING',clientOrderId:mktId,attemptedAt:this.now(),requestedQty:sentQty,unknownLogged:false});
   this.#save();
   try{
    order=orderOf(await this.client.placeOrder({symbol:vs,side:openSide(p.direction),positionSide:positionSideFor({hedge,direction:p.direction}),
     type:'MARKET',quantity:String(sentQty),clientOrderId:mktId},{beforeSend:guard}));
   }catch(e){
    if(e?.code==='ENTRY_NOT_SENT'||/^VENUE_ERROR_\d+$/.test(e?.code||'')&&!/duplicate|exist/i.test(e?.message||'')){
     this.#retryRepeat(p,e.reason||e.code);return;
    }
    order=null;
   }
  }
  await this.#recoverRepeat(p,order);
 }
 #retryRepeat(p,reason){
  delete p.scaleIn.pendingDefensive;delete p.scaleIn.pendingDefensiveRoePct;
  p.scaleIn.lastReason=reason;
  if(reason==='NOT_FILLED'){
   p.scaleIn.checkedBucket=null;p.scaleIn.defensiveCheckedBucket=null;
   p.scaleIn.retryAfterAt=this.now()+SCALP_REPEAT_SCALE_IN.retryDelayMs;
  }
  this.#addDecision(p,'WATCH',reason);
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
   const prevAvg=pos(p.avg);
   const newSize=prevSize+added;
   const total=p.filled+added;
   const nextAvg=(p.avg*prevSize+fill*added)/newSize;
   const avgImprovePct=prevAvg>0?+(Math.abs(nextAvg-prevAvg)/prevAvg*100).toFixed(2):0;
   Object.assign(a,{fillQty:added,fillPrice:fill,fillMarginUSD:fill*added/p.leverage,filledAt:this.now(),prevAvg,avgImprovePct,retryAfterAt:null});
   p.avg=nextAvg;p.filled=total;p.size=newSize;p.marginUSD=p.avg*newSize/p.leverage;
   p.trailPeakRoePct=null;p.profitProtectPeakRoePct=null;p.scaleInPartialTaken=false;
   p.defensiveArmed=false;p.defensiveExtremeMark=null;
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
  const wasDefensive=a.pendingDefensive===true,defRoe=a.pendingDefensiveRoePct??null;
  if(a.version===SCALP_REPEAT_SCALE_IN.version){
   a.count++;a.anchor=a.fillPrice;
   a.orders.push({at:a.filledAt,qty:a.fillQty,price:a.fillPrice,marginUSD:a.fillMarginUSD,...(wasDefensive?{defensive:true,defensiveRoePct:defRoe}:{})});
  }
  delete a.preAddSize;delete a.pendingDefensive;delete a.pendingDefensiveRoePct;
  p.size=fresh.size;p.mark=fresh.mark??p.mark;p.riskUSD=a.riskAfterUSD=this.#repeatRisk(p,p.avg,p.mark)*fresh.size;
  const nextState=a.version!==SCALP_REPEAT_SCALE_IN.version||!(fresh.size>0)?'FILLED'
   :this.#partialTooSmall(p,fresh.size)?'SKIPPED'
   :(a.count>=this.#maxAdds()?'FILLED':'WATCH');
  Object.assign(a,{state:nextState,reason:fresh.size>0?(nextState==='SKIPPED'?'POSITION_CHANGED':null):'FLAT_DURING_RESIZE'});
  this.#save();this.#event('SCALE_IN_FILLED',{symbol:p.symbol,direction:p.direction,count:a.count,fillMarginUSD:a.fillMarginUSD,qty:a.fillQty,price:a.fillPrice,prevAvg:a.prevAvg??null,avg:p.avg,avgImprovePct:a.avgImprovePct??null,left:p.size,...(wasDefensive?{defensive:true,defensiveRoePct:defRoe}:{})});
  if(!fresh.size){await this.#finish(p);return}
  if(posNoStop(p,this.config)&&Number(this.config.hardStopRoePct)>0)await this.#ensureHardStop(p,{forceReplace:true});
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
  if(isLadder(p)||p.twoPct)return;
  if(posNoStop(p,this.config))return this.#considerRepeat(p,mark);
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
  if(posNoStop(p,this.config))return this.#recoverRepeat(p,order);
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
  if(isLadder(p))return; // TRADER_LADDER takes profit on the average itself (#ladderTakeProfit)
  const profitOnly=posNoStop(p,this.config);
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
     const tpLimitFor=(sp,floor)=>{
      if(!profitOnly)return null;
      const spNum=Number(sp),flNum=Number(floor);
      if(!(spNum>0))return floor??price;
      const buffered=spNum*(1-dir*0.0015);
      const clamped=flNum>0?(dir>0?Math.max(buffered,flNum):Math.min(buffered,flNum)):buffered;
      return grid(clamped,p.tickSize,beMode(p.direction))??floor??price;
     };
     let o;
     try{
      o=await this.client.placeOrder(buildParams({stopPrice,limitPrice:tpLimitFor(stopPrice,triggerFloor),type:orderType,cid:clientOrderId,qty:qtyStr}));
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
      const profitFloor=Number(triggerFloor??freshLimit)??p.avg;
      if(profitOnly&&freshLimit&&freshMark&&dir*(freshMark-Number(freshLimit))>=0){
       const limPx=grid(dir>0?Math.max(Number(retryStop),Number(freshLimit)):Math.min(Number(retryStop),Number(freshLimit)),p.tickSize,beMode(p.direction))??retryStop;
       try{recovered=await this.client.placeOrder(buildParams({stopPrice:null,limitPrice:limPx,type:'LIMIT',cid:retryCid,qty:freshQty}));how=`LIMIT@${limPx}`}catch{}
      }
      if(!recovered){
       if(freshMark&&freshTick>0&&dir*(Number(retryStop)-freshMark)<=0){
        const bumped=grid(freshMark+dir*freshTick*2,p.tickSize,beMode(p.direction));
        if(bumped&&dir*(Number(bumped)-freshMark)>0)retryStop=bumped;
       }
       try{
        recovered=await this.client.placeOrder(buildParams({stopPrice:retryStop,limitPrice:tpLimitFor(retryStop,triggerFloor??freshLimit),type:orderType,cid:(retryCid+'a').slice(0,40),qty:freshQty}));
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
 async #market(p,tag,now=null){
  now??=await this.#position(p.venueSymbol,p.direction,p.hedge===true);if(!(now.size>0))return now;
  // Manual first (real account): at most our own size, never the whole lane; our own size unknown -> nothing is sent.
  let qty=now.size;
  if(this.config.mode==='LIVE'){const own=pos(p.size);
   if(!own){this.#event('MANUAL_PROTECT_HOLD',{symbol:p.symbol,direction:p.direction,reason:'OWN_QTY_UNKNOWN'});throw err('OWN_QTY_UNKNOWN')}
   qty=Math.min(now.size,own)}
  const o=await this.client.placeOrder(forMode({symbol:p.venueSymbol,side:closeSide(p.direction),positionSide:positionSideFor({hedge:p.hedge===true,direction:p.direction}),type:'MARKET',quantity:String(qty),reduceOnly:'true',clientOrderId:(p.id+tag).slice(0,40)},p.hedge===true));
  const id=orderId(o);if(id)p.exitIds.push(id);return {...now,size:0,exitAvg:pos(orderOf(o)?.avgPrice)};
 }
 /** User-initiated exit for one tracked scalp position (testnet or opt-in live). */
 async closePosition(id,{sleep}={}){
  const refuse=(error,status=409)=>({ok:false,error,status});
  const activeMode=this.config.mode==='LIVE'&&this.config.allowLive===true?'LIVE':this.config.mode==='TESTNET'?'TESTNET':null;
  if(!activeMode||this.client?.mode!==activeMode)return refuse(activeMode==='LIVE'?'SCALP_MODE_OFF':'TESTNET_CLOSE_ONLY');
  const p=this.store.open.find(p=>p.id===id&&p.mode===activeMode&&p.status==='OPEN');
  if(!p)return refuse('POSITION_NOT_FOUND',404);
  if(this.reserved.has(p.symbol)||this.reconcilingSymbol===p.symbol||['PENDING','RESIZE'].includes(p.scaleIn?.state)||p.ladder?.pending||p.ladder?.exit)return refuse('SYMBOL_BUSY');
  this.reserved.add(p.symbol);
  try{
   const mode=await readPositionMode(this.client);
   if(!mode.ok)return refuse(mode.reason,502);
   if(mode.hedge!==(p.hedge===true))return refuse('POSITION_MODE_CHANGED');
   const raw=()=>this.#position(p.venueSymbol,p.direction,p.hedge===true,{strict:true});
   const first=await raw();
   // Manual first (real account): a manual part of the lane stays; only our own part has to go.
   const manualPart=this.config.mode==='LIVE'&&pos(p.size)?Math.max(0,first.size-p.size):0;
   const read=async()=>{const r=await raw();return manualPart>0?{...r,size:Math.max(0,+(r.size-manualPart).toFixed(12))}:r};
   const held=manualPart>0?{...first,size:Math.max(0,+(first.size-manualPart).toFixed(12))}:first;
   let forced=null;
   if(held.other>0)p.otherSideSeen=true;
   if(held.size>0){
    p.manualCloseAttempts=(p.manualCloseAttempts||0)+1;
    const tag='m'+p.manualCloseAttempts;
    this.#save();
    try{await this.#market(p,tag,held);forced='MANUAL'}
    catch{
     const order=await this.client.getOrder(p.venueSymbol,{clientOrderId:(p.id+tag).slice(0,40)}).catch(()=>null);
     const id=orderId(order);
     if(id&&!p.exitIds.includes(id))p.exitIds.push(id);
     if(pos(orderOf(order)?.executedQty))forced='MANUAL';
    }
    if(!await waitForFlat(read,sleep))return refuse('CLOSE_UNCONFIRMED',502);
   }
   const cleanupPending=await this.#finish(p,forced,{verifyCleanup:true});
   return {ok:true,alreadyFlat:held.size===0,cleanupPending};
  }catch(error){return refuse(error.code||'CLOSE_FAILED',error.httpStatus||502)}
  finally{this.reserved.delete(p.symbol);this.#save()}
 }
 /** User-initiated exit for one tracked testnet scalp. */
 async closeTestnetPosition(id,opts={}){
  if(this.config.mode!=='TESTNET'||this.client?.mode!=='TESTNET')return {ok:false,error:'TESTNET_CLOSE_ONLY',status:409};
  return this.closePosition(id,opts);
 }
 #recordEarlyTakeProfit(p,response,{alreadyFilled=0,suppressPartialEvent=false}={}){
  const o=orderOf(response),id=orderId(o),filled=Number(o?.executedQty)||0,totalFilled=filled+alreadyFilled;
  if(id&&!p.exitIds.includes(id))p.exitIds.push(id);
  if(totalFilled>0){
   p.everReduced=true;
   if(p.earlyTakeProfit?.partial){
    p.scaleInPartialTaken=true;
    if(!suppressPartialEvent)this.#event('PARTIAL_TAKE_PROFIT',{symbol:p.symbol,direction:p.direction,qty:totalFilled,left:Math.max(0,p.size-totalFilled),takePct:p.earlyTakeProfit.takePct??50,netRoePct:p.earlyTakeProfit.netRoePct??null,estProfitUSD:p.earlyTakeProfit.estProfitUSD??null});
   }else if(totalFilled>=(p.earlyTakeProfit?.targetQty??p.earlyTakeProfit?.qty??0)-Number(p.quantityStep)/2){
    p.exitReason='EARLY_TAKE_PROFIT';
   }
  }
  if(['FILLED','CANCELED','CANCELLED','EXPIRED','REJECTED','FAILED'].includes(String(o?.status).toUpperCase()))
   delete p.earlyTakeProfit;
  this.#save();
 }
 async #tryEarlyTakeProfit(p,mark){
  if(isLadder(p)||p.twoPct)return false;
  const now=this.now(),opened=p.openedAt??p.createdAt,profitOnly=posNoStop(p,this.config);
  const delay=profitOnly?0:EARLY_TAKE_PROFIT_MS,retry=profitOnly?PROFIT_ONLY_RETRY_MS:EARLY_EXIT_RETRY_MS;
  const activeMode=this.config.mode==='LIVE'&&this.config.allowLive===true?'LIVE':this.config.mode==='TESTNET'?'TESTNET':null;
  if(!activeMode||!(opened>0)||now-opened<delay||now-(p.earlyTakeProfitAt??0)<retry||!(mark>0&&p.avg>0&&p.size>0))return false;
  const direction=dirOf(p.direction);
  const qty=Number(grid(p.size,p.quantityStep,'DOWN'));
  if(!(qty>0))return false;
  const rawRealizedLoss=profitOnly?Math.max(0,-(num(p.exchangePosition?.realizedPnLUSD)??0)):0;
  // BingX books the entry fee as negative realisedProfit immediately upon opening (already covered by 2*fee in
  // profitLimit/netRoePct). Only treat negative realisedProfit exceeding ~2.5x taker entry fee as a real booked
  // trading loss; otherwise every new position would falsely enter recoveryMode (minNetRoePct=0) and dump at +3% ROE.
  const entryFeeAllowance=(pos(p.filled)??qty)*p.avg*Math.max(p.takerRate||0,SCALP_EXEC_COSTS.takerRate)*2.5;
  const bookedLoss=rawRealizedLoss>entryFeeAllowance?rawRealizedLoss:0;
  const scaledIn=(p.scaleIn?.count||0)>0;
  const initQty=pos(p.scaleIn?.initialQty)??pos(p.initialQty)??pos(p.filled);
  const isDust=profitOnly&&p.everReduced===true&&initQty>0&&p.size<initQty*SCALP_REPEAT_SCALE_IN.dustRatio;
  let limit,orderQty=qty,partial=false,partialTakePct=null,partialRoePct=null,partialProfitUSD=null;
  if(isDust){
   // Auto-clean dust remainder (<5% of initialQty) as soon as breakeven+fees clears so slots stay clean.
   limit=profitLimit(p,bookedLoss/qty,{minNetRoePct:0});
   if(!(Number(limit)>0&&direction*(mark-Number(limit))>=0))return false;
  }else if(profitOnly&&scaledIn){
   const fee=Math.max(p.takerRate||0,SCALP_EXEC_COSTS.takerRate);
   const reserve=(SCALP_EXEC_COSTS.spreadBps+SCALP_EXEC_COSTS.slippageBps)/10000+SCALP_EXEC_COSTS.fundingRate;
   const lev=Math.max(1,Number(p.leverage)||10);
   const grossMove=direction*(mark-p.avg)/p.avg;
   const lossMove=bookedLoss>0?bookedLoss/(qty*p.avg):0;
   const netRoePct=(grossMove-2*fee-reserve-lossMove)*lev*100;
   const staleRotate=(p.scaleIn?.count||0)>=SCALP_STALE_ROTATE_MIN_ADDS&&(now-opened)>=SCALP_STALE_ROTATE_HOURS*3600000;
   if(staleRotate&&netRoePct>=SCALP_STALE_ROTATE_ROE_PCT){
    // Long-held (>=24h) deeply scaled-in (>=3 adds) position: rotate capital out at >= +2.5% Net ROE.
    limit=profitLimit(p,bookedLoss/qty,{minNetRoePct:0});
    if(!(Number(limit)>0&&direction*(mark-Number(limit))>=0))return false;
   }else{
    if(netRoePct>=SCALP_SCALE_IN_MIN_ROE_PCT){
     const prevPeak=Number(p.trailPeakRoePct);
     if(!Number.isFinite(prevPeak)||netRoePct>prevPeak){p.trailPeakRoePct=+netRoePct.toFixed(2);this.#save()}
    }
    // Pillar 4: 40% partial profit lock-in at +8% Net ROE after scale-in, leaving 60% runner for full V-bounce.
    if(!p.scaleInPartialTaken&&netRoePct>=SCALP_SCALE_IN_PARTIAL_ROE_PCT){
     const minPart=pos(p.scaleIn?.minPart)??Number(p.quantityStep);
     const minNotional=Number(p.scaleIn?.minNotional)||0;
     const partQty=Number(grid(qty*SCALP_SCALE_IN_PARTIAL_FRAC,p.quantityStep,'DOWN'));
     const remQty=Number(grid(qty-partQty,p.quantityStep,'DOWN'));
     if(partQty>=minPart&&remQty>=minPart&&partQty*mark>=minNotional&&remQty*mark>=minNotional){
      limit=profitLimit(p,bookedLoss/qty,{minNetRoePct:0});
      if(Number(limit)>0&&direction*(mark-Number(limit))>=0){orderQty=partQty;partial=true;partialTakePct=Math.round(SCALP_SCALE_IN_PARTIAL_FRAC*100);partialRoePct=+netRoePct.toFixed(1);partialProfitUSD=+(direction*(mark-p.avg)*partQty).toFixed(2)}
     }
    }
    if(!partial){
     const peak=Number(p.trailPeakRoePct);
     if(!(Number.isFinite(peak)&&peak>=SCALP_SCALE_IN_MIN_ROE_PCT))return false;
     const baseRatio=SCALP_TRAIL_PULLBACK_RATIO;
     const ratio=peak>=SCALP_HIGH_PROFIT_TRAIL_ROE_PCT?SCALP_HIGH_PROFIT_PULLBACK_RATIO:baseRatio;
     const minBuf=p.scaleInPartialTaken?SCALP_TRAIL_RUNNER_MIN_PULLBACK_ROE:SCALP_TRAIL_MIN_PULLBACK_ROE;
     const pullback=Math.max(minBuf,peak*ratio);
     const trailStopRoe=Math.max(SCALP_SCALE_IN_MIN_ROE_PCT,peak-pullback);
     if(netRoePct>trailStopRoe)return false;
     limit=profitLimit(p,bookedLoss/qty,{minNetRoePct:0});
     if(!(Number(limit)>0&&direction*(mark-Number(limit))>=0))return false;
    }
   }
  }else{
   const fbMin=Number(this.config.earlyFallbackMin??PROFIT_ONLY_EARLY_EXIT_MIN);
   const fallbackElapsed=fbMin>0&&now-opened>=fbMin*60000;
   const minRoe=this.config.minProfitRoePct??SCALP_MIN_PROFIT_ROE_PCT;
   const takeFrac=Number(this.config.partialTakeFrac??SCALP_PARTIAL_TAKE_FRAC);
   if(profitOnly&&minRoe>0&&(p.scaleInPartialTaken||(!fallbackElapsed&&!(bookedLoss>0)))){
    const fee=Math.max(p.takerRate||0,SCALP_EXEC_COSTS.takerRate);
    const reserve=(SCALP_EXEC_COSTS.spreadBps+SCALP_EXEC_COSTS.slippageBps)/10000+SCALP_EXEC_COSTS.fundingRate;
    const lev=Math.max(1,Number(p.leverage)||10);
    const grossMove=direction*(mark-p.avg)/p.avg;
    const lossMove=bookedLoss>0?bookedLoss/(qty*p.avg):0;
    const netRoePct=(grossMove-2*fee-reserve-lossMove)*lev*100;
    const armRoe=Number(this.config.profitProtectArmRoePct??SCALP_PROFIT_PROTECT_ARM_ROE_PCT);
    const floorRoe=Number(this.config.profitProtectFloorRoePct??SCALP_PROFIT_PROTECT_FLOOR_ROE_PCT);
    if(armRoe>0&&armRoe<minRoe&&netRoePct>=armRoe){
     const prevArm=Number(p.profitProtectPeakRoePct);
     if(!Number.isFinite(prevArm)||netRoePct>prevArm){p.profitProtectPeakRoePct=+netRoePct.toFixed(2);this.#save()}
    }
    if(netRoePct>=minRoe){
     const prevPeak=Number(p.trailPeakRoePct);
     if(!Number.isFinite(prevPeak)||netRoePct>prevPeak){p.trailPeakRoePct=+netRoePct.toFixed(2);this.#save()}
    }
    if(!p.scaleInPartialTaken&&netRoePct>=minRoe){
     const minPart=pos(p.scaleIn?.minPart)??Number(p.quantityStep);
     const minNotional=Number(p.scaleIn?.minNotional)||0;
     const takeQty=Number(grid(qty*takeFrac,p.quantityStep,'DOWN'));
     const remQty=Number(grid(qty-takeQty,p.quantityStep,'DOWN'));
     if(takeQty>=minPart&&remQty>=minPart&&takeQty*mark>=minNotional&&remQty*mark>=minNotional){
      limit=profitLimit(p,bookedLoss/qty,{minNetRoePct:0});
      if(Number(limit)>0&&direction*(mark-Number(limit))>=0){orderQty=takeQty;partial=true;partialTakePct=Math.round(takeFrac*100);partialRoePct=+netRoePct.toFixed(1);partialProfitUSD=+(direction*(mark-p.avg)*takeQty).toFixed(2)}
     }
    }
    if(!partial){
     if(p.scaleInPartialTaken){
      const peak=Number(p.trailPeakRoePct);
      // Pillar 4: Tighten runner pullback from 25% -> 18% once peak reaches >= +35% Net ROE.
      const ratio=peak>=SCALP_HIGH_PROFIT_TRAIL_ROE_PCT?SCALP_HIGH_PROFIT_PULLBACK_RATIO:SCALP_TRAIL_PULLBACK_RATIO;
      const pullback=Math.max(SCALP_TRAIL_RUNNER_MIN_PULLBACK_ROE,peak*ratio);
      const trailStopRoe=Math.max(minRoe,peak-pullback);
      if(netRoePct>trailStopRoe)return false;
      limit=profitLimit(p,bookedLoss/qty,{minNetRoePct:0});
      if(!(Number(limit)>0&&direction*(mark-Number(limit))>=0))return false;
     }else if(armRoe>0&&armRoe<minRoe&&Number(p.profitProtectPeakRoePct)>=armRoe&&netRoePct<=floorRoe){
      // Free-roll profit protection: peaked >= +10% Net ROE without reaching +16%, pulled back to <= +2.5% -> lock in net profit.
      limit=profitLimit(p,bookedLoss/qty,{minNetRoePct:0});
      if(!(Number(limit)>0&&direction*(mark-Number(limit))>=0))return false;
     }else{
      limit=profitLimit(p,bookedLoss/qty,{minNetRoePct:minRoe});
      if(!(Number(limit)>0&&direction*(mark-Number(limit))>=0))return false;
     }
    }
   }else{
    const recoveryMode=bookedLoss>0||fallbackElapsed;
    const minNetRoePct=profitOnly&&!recoveryMode?minRoe:0;
    limit=profitLimit(p,bookedLoss/qty,{minNetRoePct});
    if(!(Number(limit)>0&&direction*(mark-Number(limit))>=0))return false;
   }
  }
  const clientOrderId=createHash('sha256').update(`${p.id}|early|${partial?'p':'f'}|${now}`).digest('hex').slice(0,32);
  const meta={qty:orderQty,targetQty:orderQty,partial,...(partial?{takePct:partialTakePct,netRoePct:partialRoePct,estProfitUSD:partialProfitUSD}:{})};
  const side=closeSide(p.direction),posSide=positionSideFor({hedge:p.hedge===true,direction:p.direction});
  let remQty=orderQty,makerFilledTotal=0;
  // Pillar 4: Profit exits try PostOnly maker (0.02%) for ~1.2s first, then cancel & IOC only the unfilled remainder.
  if(profitOnly&&this.config.makerExit!==false&&typeof this.client.getOrder==='function'&&typeof this.client.cancelOrder==='function'){
   const rawMakerPx=makerLimitPrice({side,markPrice:mark,tickSize:p.tickSize});
   const limitNum=Number(limit);
   const safeMakerPx=rawMakerPx>0&&limitNum>0?(direction>0?Math.max(rawMakerPx,limitNum):Math.min(rawMakerPx,limitNum)):rawMakerPx;
   const makerPxStr=safeMakerPx>0?(grid(safeMakerPx,p.tickSize,beMode(p.direction))??String(safeMakerPx)):null;
   if(makerPxStr){
    const makerCid=(clientOrderId.slice(0,31)+'p');
    p.earlyTakeProfit={clientOrderId:makerCid,...meta};p.earlyTakeProfitAt=now;this.#save();
    let makerRes=null,makerRejected=false;
    try{
     makerRes=orderOf(await this.client.placeOrder(forMode({symbol:p.venueSymbol,side,positionSide:posSide,
      type:'LIMIT',timeInForce:'PostOnly',price:makerPxStr,quantity:String(orderQty),reduceOnly:'true',clientOrderId:makerCid},p.hedge===true)));
    }catch(e){
     if(/^(?:VENUE_ERROR_|HTTP_4\d\d$)/.test(String(e?.code||''))||/post.?only|gtx|immediately|would match|cross|101415|101400|80014/i.test(String(e?.code||'')+' '+String(e?.message||''))){
      makerRejected=true;delete p.earlyTakeProfit;this.#save();
     }else{
      throw e;
     }
    }
    if(!makerRejected){
     const TERMINAL=new Set(['FILLED','CANCELED','CANCELLED','EXPIRED','REJECTED','FAILED']);
     let latest=makerRes,status=String(latest?.status||'NEW').toUpperCase(),oid=orderId(latest);
     const waitMs=Math.max(0,Number(this.config.makerExitWaitMs??1200));
     const pollMs=Math.max(20,Math.min(300,waitMs||20));
     const deadline=Date.now()+waitMs;
     const readOrder=async()=>{
      const fresh=orderOf(await this.client.getOrder(p.venueSymbol,{clientOrderId:makerCid,...(oid?{orderId:oid}:{})}));
      if(fresh){latest=fresh;status=String(fresh.status||'').toUpperCase()||status;if(!oid&&orderId(fresh))oid=orderId(fresh)}
     };
     while(!TERMINAL.has(status)&&Date.now()<deadline){
      await sleep(Math.min(pollMs,Math.max(0,deadline-Date.now())));
      try{await readOrder()}catch{break}
     }
     if(!TERMINAL.has(status)){
      for(let attempt=0;attempt<3&&!TERMINAL.has(status);attempt++){
       if(attempt===0||attempt===2){try{await this.client.cancelOrder(p.venueSymbol,oid??undefined,{clientOrderId:makerCid})}catch{}}
       if(attempt>0)await sleep(Math.min(200,pollMs));
       try{await readOrder()}catch{}
      }
     }
     if(!TERMINAL.has(status)){
      // State still unconfirmed: leave p.earlyTakeProfit tracking makerCid so next reconcile resolves without double-closing.
      this.#recordEarlyTakeProfit(p,latest);
      return true;
     }
     makerFilledTotal=Math.max(0,num(latest?.executedQty)??0);
     remQty=Number(grid(Math.max(0,Number((orderQty-makerFilledTotal).toPrecision(12))),p.quantityStep,'DOWN'))||0;
     this.#recordEarlyTakeProfit(p,latest,{suppressPartialEvent:remQty>0});
     if(!(remQty>0))return true;
    }
   }
  }
  p.earlyTakeProfit={clientOrderId,...meta,qty:remQty};p.earlyTakeProfitAt=now;this.#save();
  const response=await this.client.placeOrder(forMode({symbol:p.venueSymbol,side,
   positionSide:posSide,type:'LIMIT',
   timeInForce:'IOC',price:limit,quantity:String(remQty),reduceOnly:'true',clientOrderId},p.hedge===true));
  this.#recordEarlyTakeProfit(p,response,{alreadyFilled:makerFilledTotal});
  return true;
 }
 // ---- TRADER_LADDER (scalp_ladder.mjs, user 2026-11-24) ----------------------------------------------------------
 /** The first fill is step 1 of the ladder. */
 #ladderOpened(p){
  const L=p.ladder;if(!L||L.filled>0)return;
  L.filled=1;L.lastFill=p.avg;L.avg=p.avg;L.size=p.filled;L.fills=[{step:1,units:L.units[0],qty:p.filled,price:p.avg,at:this.now(),zone:null,boost:0,executionMode:p.executionMode||null}];
  L.state=L.units.length>1?'WATCH':'COMPLETE';
 }
 #ladderTp(p){
  const L=p.ladder;
  return ladderTpPrice({direction:p.direction,avg:p.avg,takerRate:Math.max(Number(p.takerRate)||0,SCALP_EXEC_COSTS.takerRate),tpNetPct:L.tpNetPct,reservePct:L.reservePct??.0004,tickSize:p.tickSize});
 }
 /** What the screen and the Telegram notices show: "3/6 단계 · 평단 … · 다음 추매 …". */
 #ladderView(p){
  const L=p.ladder;if(!L)return null;
  const next=L.state==='WATCH'&&L.filled<L.units.length?(L.next??ladderNextAdd({direction:p.direction,lastFill:L.lastFill,spacingPct:L.spacingPct,zones:[...(L.zones?.list||[]),...(L.whaleZones?.list||[])]})):null;
  const opened=p.openedAt??p.createdAt;
  return {step:L.filled,of:L.units.length,units:[...L.units],avg:pos(p.avg),lastFill:pos(L.lastFill),spacingPct:L.spacingPct,atrPct:L.atrPct??null,
   nextAdd:next?{price:pos(next.level),zone:next.zone&&ladderZoneBoost(L.units,L.filled).boost>0?{tf:next.zone.tf,kind:next.zone.kind??'VOLUME',low:next.zone.low,high:next.zone.high,why:[...(next.zone.why||[])],at:next.zone.at}:null,units:next.zone?ladderZoneBoost(L.units,L.filled).units[L.filled]:L.units[L.filled]}:null,
   tpPrice:pos(L.tpPrice)??this.#ladderTp(p),tpNetPct:L.tpNetPct,finalLineRoePct:L.finalLineRoePct,maxHoldMin:L.maxHoldMin,closeBy:opened>0&&L.maxHoldMin>0?opened+L.maxHoldMin*60000:null,
   state:L.state,lastReason:L.lastReason??null,pending:Boolean(L.pending),unitMarginUSD:L.unitMarginUSD,reserveMarginUSD:L.reserveMarginUSD,reserveRiskUSD:L.reserveRiskUSD,
   fills:(L.fills||[]).map(f=>({step:f.step,units:f.units,qty:f.qty,price:f.price,at:f.at,zone:f.zone?{tf:f.zone.tf,kind:f.zone.kind??'VOLUME',why:[...(f.zone.why||[])]}:null,boost:f.boost||0}))};
 }
 /** Strong zones of the ladder's ×2 step: the 4H / 1D volume zones (kind VOLUME, below) and, since 2026-11-25 09:51, the
  * 고래 매물대 on our side (kind WHALE: LONG whale BUY zones, SHORT whale SELL zones; whale_zones.mjs). */
 async #ladderZones(p){
  const [vol,whale]=await Promise.all([this.#ladderVolumeZones(p),this.#ladderWhaleZones(p).catch(()=>[])]);
  return [...vol,...whale];
 }
 /** 고래 매물대 for a ladder (whale_zones.mjs), read again every 15 min (the store's own 30 s / incremental reads below that).
  * Only with at least 80 % of the lookback read (else none: never extrapolated); a failure is none, tried again in 5 min. */
 async #ladderWhaleZones(p){
  const L=p.ladder,now=this.now();
  if(this.config.whaleCvd===false||typeof this.whaleZones!=='function')return [];
  // A full read is kept 15 min; a partial / failed one (retryAt) only until its 5 min retry.
  if(L.whaleZones&&(L.whaleZones.retryAt!=null?L.whaleZones.retryAt>now:now-L.whaleZones.at<WHALE_ZONE_DEFAULTS.storeTtlMs))return L.whaleZones.list||[];
  const lookbackMs=whaleZoneLookbackMs(this.config.whaleZoneHours);
  const {outerMs,deadlineMs}=this.#whaleZoneTimeouts();
  const snap=await withTimeout(Promise.resolve().then(()=>this.whaleZones(p.symbol,{lookbackMs,endMs:now,direction:p.direction,scale:this.config.whaleCvdScale??'auto',maxPages:this.config.whaleZoneMaxPages??WHALE_ZONE_DEFAULTS.maxPages,deadlineMs})),
   outerMs,{ok:false,error:`timeout ${outerMs/1000}s`}).catch(e=>({ok:false,error:String(e?.message||e).slice(0,80)}));
  // The score's own test (whaleSnapshotUsable): >= 80 % of the lookback read and reaching within 60 s of now; a read whose
  // newer pages failed is never used with its old zones (review 2026-11-25).
  const use=whaleSnapshotUsable(snap),enough=use.usable;
  const zr=enough?buildWhaleZones(snap,{price:L.lastFill??p.avg,atrPct:L.atrPct}):null;
  const list=zr?whaleLadderZones(zr,p.direction):[];
  L.whaleZones={at:now,list,coveragePct:snap?.ok?snap.coveragePct:null,code:enough?null:use.code,...(enough?{}:{detail:use.detail,retryAt:now+5*60000})};
  return list;
 }
 /** Strong 4H / 1D zones of this coin (scalp_ladder.mjs strongZones), read again once per 4H candle. */
 async #ladderVolumeZones(p){
  const L=p.ladder,b=Math.floor(this.now()/(4*3600000));
  if(L.zones?.bucket===b||L.zones?.retryAt>this.now())return L.zones.list||[];
  const st={},b4=await this.zoneBookOf(p.symbol,'4h',p.tickSize,st),b1=st.error?null:await this.zoneBookOf(p.symbol,'1d',p.tickSize,st);
  const now=this.now(),rows4h=this.zoneCache.get(p.symbol+'|4h')?.rows||null;
  // Rejections from closed 4H candles only (the cached rows end with the candle still open; review 2026-11-24).
  const list=strongZones({zones4h:b4?b4(now):null,zones1d:b1?b1(now):null,rows4h:Array.isArray(rows4h)?rows4h.filter(r=>Number(r?.[6])<now).slice(-180):null,direction:p.direction});
  // Nothing read: no zones now, read again in 5 minutes (not cached for the candle).
  L.zones={bucket:b4||b1?b:null,at:now,list,...(b4||b1?{}:{retryAt:now+5*60000})};
  return list;
 }
 /** Reconcile step for a TRADER_LADDER position: final line, max hold, take profit on the average, the next add. */
 async #manageLadder(p,{size,mark,row}){
  const L=p.ladder,dir=dirOf(p.direction),step=Number(p.quantityStep)||0;
  if(Number(this.config.hardStopRoePct)>0)await this.#ensureHardStop(p);
  else if(!await this.#retireStop(p))return;
  // A take-profit order whose answer was lost: its outcome first, so its fill is booked before the size is compared
  // (a partial fill was taken as a reduction here and then subtracted again: a phantom late add, review 2026-11-24).
  if(L.exit){await this.#ladderExitCheck(p);if(p.status!=='OPEN')return}
  // A fill the ledger has not booked (an add answered after we gave up on it, a PostOnly child that rested): booked
  // as the next step, never added again. Less than booked: something else closed part of it, so no more adds.
  // Not while the take-profit outcome is unknown, and not after it filled (a position read that lags is not an add).
  if(!L.exit){
   if(size>L.size+step/2){if(p.exitReason!=='LADDER_TAKE_PROFIT')this.#ladderBook(p,{qty:+(size-L.size).toFixed(12),size,avg:pos(row?.avgPrice),prevAvg:pos(L.avg)??pos(L.lastFill),prevSize:L.size,adopted:true})}
   else if(size<L.size-step/2){L.size=size;p.everReduced=true;if(L.state==='WATCH'){L.state='STOPPED';L.lastReason='POSITION_CHANGED'}this.#save()}
  }
  p.riskUSD=ladderHeldRisk(p);
  // The final line runs whatever else is unresolved (review 2026-11-24: it used to wait for the take-profit lookup).
  if(await this.#ladderFinalLine(p,{size,mark,avg:p.avg}))return;
  const lev=Math.max(1,Number(p.leverage)||10),roePct=mark>0&&p.avg>0?dir*(mark-p.avg)/p.avg*lev*100:null;
  const opened=p.openedAt??p.createdAt,maxHoldMin=Number(L.maxHoldMin)||0;
  if(maxHoldMin>0&&opened>0&&this.now()-opened>=maxHoldMin*60000){
   p.exitTries=(p.exitTries||0)+1;const r=await this.#market(p,'mh'+p.exitTries);
   const holdMin=Math.round((this.now()-opened)/60000);
   p.exitReason='LADDER_MAX_HOLD';p.closeMeta={holdMin,maxHoldMin,roePct:roePct===null?null:+roePct.toFixed(1),step:L.filled,of:L.units.length};
   this.#event('LADDER_MAX_HOLD',{symbol:p.symbol,direction:p.direction,holdMin,maxHoldMin,roePct:p.closeMeta.roePct,step:L.filled,of:L.units.length});
   if(!(r.size>0))await this.#finish(p,'LADDER_MAX_HOLD');
   return;
  }
  // The take-profit order's outcome still unknown: no new order on this position until it is known.
  if(L.exit)return;
  if(await this.#ladderTakeProfit(p,mark,size))return;
  await this.#ladderAdd(p,mark);
 }
 /** The final line: -finalLineRoePct % ROE on the position margin (venue average and mark), closed at market. After the
  * last step it is the user's "(나) 마지막 선에서 정리"; before it, the existing emergency line. true when it fired.
  * Also run while an add is pending (review 2026-11-24): that add's PostOnly child is cancelled first so it cannot reopen
  * the position, and the ledger is closed only once the attempt is resolved (#ladderSettle), never before. */
 async #ladderFinalLine(p,{size,mark,avg}){
  const L=p.ladder,lev=Math.max(1,Number(p.leverage)||10),a=pos(avg)??pos(p.avg);
  const roePct=size>0&&mark>0&&a>0?dirOf(p.direction)*(mark-a)/a*lev*100:null;
  const line=Number(L.finalLineRoePct)||Number(this.config.emergencyStopRoePct)||0;
  if(!(line>0&&roePct!==null&&roePct<=-line))return false;
  const pending=L.pending||null;
  if(pending)await this.#ladderCancelAttempt(p,pending);
  const reason=L.filled>=L.units.length?'LADDER_FINAL_LINE':'EMERGENCY_ROE_STOP';
  p.exitTries=(p.exitTries||0)+1;const r=await this.#market(p,'em'+p.exitTries);
  p.exitReason=reason;p.closeMeta={roePct:+roePct.toFixed(1),limitPct:line,step:L.filled,of:L.units.length,...(pending?{pendingStep:pending.step}:{})};
  this.#event(reason,{symbol:p.symbol,direction:p.direction,roePct:+roePct.toFixed(1),limitPct:line,step:L.filled,of:L.units.length});
  if(!pending&&!(r.size>0))await this.#finish(p,reason);
  else this.#save();
  return true;
 }
 /** Whole position at the average + tpNetPct % net of fees: when makerExit !== false, tries a reduce-only PostOnly
  * limit at/above tp first and falls back to IOC ONLY for the unfilled remainder (never a worse fill). */
 async #ladderTakeProfit(p,mark,size){
  const L=p.ladder,dir=dirOf(p.direction),tp=this.#ladderTp(p);
  L.tpPrice=tp;
  if(!(tp>0&&mark>0&&dir*(mark-tp)>=0))return false;
  const qty=Number(grid(size,p.quantityStep,'DOWN'));if(!(qty>0))return false;
  const n=L.exitTries=(L.exitTries||0)+1,cid=(p.id+'lx'+n).slice(0,40);
  const side=closeSide(p.direction),posSide=positionSideFor({hedge:p.hedge===true,direction:p.direction});
  // First attempt uses exact tp; on unfilled retries (thin alt spread), allow a 1-tick marketable buffer if strictly above fee-net breakeven.
  let limitPrice=tp;
  const tick=pos(p.tickSize);
  if(n>=2&&tick&&p.avg>0){
   const fee=Math.max(p.takerRate||0,SCALP_EXEC_COSTS.takerRate);
   const reserve=Number(L.reservePct)||0;
   const be=p.avg*(1+dir*(2*fee+reserve));
   const buf=Number(grid(tp-dir*tick,p.tickSize,dir>0?'DOWN':'UP'));
   if(buf>0&&dir*(buf-be)>0)limitPrice=buf;
  }
  let remQty=qty;
  // Maker-first profit exit: try PostOnly (0.02% fee) for makerExitWaitMs, then cancel & IOC only the unfilled remainder.
  if(this.config.makerExit!==false&&typeof this.client.getOrder==='function'&&typeof this.client.cancelOrder==='function'){
   const rawMakerPx=makerLimitPrice({side,markPrice:mark,tickSize:p.tickSize});
   const safeMakerPx=rawMakerPx>0?(dir>0?Math.max(rawMakerPx,tp):Math.min(rawMakerPx,tp)):tp;
   const makerPxStr=safeMakerPx>0?(grid(safeMakerPx,p.tickSize,beMode(p.direction))??String(safeMakerPx)):null;
   if(makerPxStr){
    const makerCid=(cid.slice(0,39)+'p');
    L.exit={clientOrderId:makerCid,qty,price:Number(makerPxStr),at:this.now(),maker:true};this.#save();
    let makerRes=null,makerRejected=false;
    try{
     makerRes=orderOf(await this.client.placeOrder(forMode({symbol:p.venueSymbol,side,positionSide:posSide,
      type:'LIMIT',timeInForce:'PostOnly',price:makerPxStr,quantity:String(qty),reduceOnly:'true',clientOrderId:makerCid},p.hedge===true)));
    }catch(e){
     if(e?.code==='HTTP_429'||e?.code==='VENUE_ERROR_109429')this.cooldownUntil=this.now()+60000;
     if(/^(?:VENUE_ERROR_\d+|HTTP_4\d\d)$/.test(String(e?.code||''))||/post.?only|gtx|immediately|would match|cross|101415|101400|80014/i.test(String(e?.code||'')+' '+String(e?.message||''))){
      makerRejected=true;delete L.exit;this.#save();
     }else{
      this.#event('RECONCILE_ERROR',{symbol:p.symbol,reason:e?.code||e?.message});
      return true;
     }
    }
    if(!makerRejected){
     const TERMINAL=new Set(['FILLED','CANCELED','CANCELLED','EXPIRED','REJECTED','FAILED']);
     let latest=makerRes,status=String(latest?.status||'NEW').toUpperCase(),oid=orderId(latest);
     const waitMs=Math.max(0,Number(this.config.makerExitWaitMs??1200));
     const pollMs=Math.max(20,Math.min(300,waitMs||20));
     const deadline=Date.now()+waitMs;
     const readOrder=async()=>{
      const fresh=orderOf(await this.client.getOrder(p.venueSymbol,{clientOrderId:makerCid,...(oid?{orderId:oid}:{})}));
      if(fresh){latest=fresh;status=String(fresh.status||'').toUpperCase()||status;if(!oid&&orderId(fresh))oid=orderId(fresh)}
     };
     while(!TERMINAL.has(status)&&Date.now()<deadline){
      await sleep(Math.min(pollMs,Math.max(0,deadline-Date.now())));
      try{await readOrder()}catch{break}
     }
     if(!TERMINAL.has(status)){
      for(let attempt=0;attempt<3&&!TERMINAL.has(status);attempt++){
       if(attempt===0||attempt===2){try{await this.client.cancelOrder(p.venueSymbol,oid??undefined,{clientOrderId:makerCid})}catch{}}
       if(attempt>0)await sleep(Math.min(200,pollMs));
       try{await readOrder()}catch{}
      }
     }
     if(!TERMINAL.has(status)){
      // State still unconfirmed: leave L.exit tracking makerCid so next reconcile resolves without double-closing.
      return this.#ladderExitResult(p,latest);
     }
     const mid=orderId(latest);
     if(mid&&!p.exitIds.includes(mid))p.exitIds.push(mid);
     const makerFilled=pos(latest?.executedQty)??0;
     if(makerFilled>0)L.size=Math.max(0,+(L.size-makerFilled).toFixed(12));
     remQty=Number(grid(Math.max(0,Number((qty-makerFilled).toPrecision(12))),p.quantityStep,'DOWN'))||0;
     delete L.exit;
     if(!(remQty>0)){
      p.exitReason='LADDER_TAKE_PROFIT';
      this.#save();
      const nowPos=await this.#position(p.venueSymbol,p.direction,p.hedge===true).catch(()=>null);
      if(nowPos&&!(nowPos.size>0))await this.#finish(p,'LADDER_TAKE_PROFIT');
      return true;
     }
     if(makerFilled>0)p.everReduced=true;
     this.#save();
    }
   }
  }
  L.exit={clientOrderId:cid,qty:remQty,price:limitPrice,at:this.now()};this.#save();
  let o;
  try{
   o=orderOf(await this.client.placeOrder(forMode({symbol:p.venueSymbol,side,positionSide:posSide,
    type:'LIMIT',timeInForce:'IOC',price:String(limitPrice),quantity:String(remQty),reduceOnly:'true',clientOrderId:cid},p.hedge===true)));
  }catch(e){
   if(e?.code==='HTTP_429'||e?.code==='VENUE_ERROR_109429')this.cooldownUntil=this.now()+60000;
   // A refusal from the venue: nothing was placed. Anything else (no answer): looked up by its id at the next check.
   if(/^(?:VENUE_ERROR_\d+|HTTP_4\d\d)$/.test(String(e?.code||''))){delete L.exit;L.lastReason=e.code;this.#save()}
   else this.#event('RECONCILE_ERROR',{symbol:p.symbol,reason:e?.code||e?.message});
   return true;
  }
  return this.#ladderExitResult(p,o);
 }
 async #ladderExitResult(p,o){
  const L=p.ladder,x=L.exit,step=Number(p.quantityStep)||0,id=orderId(o),filled=pos(o?.executedQty)??0,status=String(o?.status||'').toUpperCase();
  if(id&&!p.exitIds.includes(id))p.exitIds.push(id);
  if(filled>0&&!x?.booked){L.size=Math.max(0,+(L.size-filled).toFixed(12));if(x)x.booked=true;if(filled>=(x?.qty??0)-step/2)p.exitReason='LADDER_TAKE_PROFIT';else p.everReduced=true}
  if(['FILLED','CANCELED','CANCELLED','EXPIRED','REJECTED','FAILED'].includes(status)||filled>=(x?.qty??Infinity)-step/2)delete L.exit;
  this.#save();
  if(p.exitReason==='LADDER_TAKE_PROFIT'){
   const now=await this.#position(p.venueSymbol,p.direction,p.hedge===true).catch(()=>null);
   if(now&&!(now.size>0))await this.#finish(p,'LADDER_TAKE_PROFIT');
  }
  return true;
 }
 /** A take-profit order sent without an answer: its outcome by client id. true = the check may go on. */
 async #ladderExitCheck(p){
  const L=p.ladder,old=this.now()-(L.exit.at||0)>120000;let o=null;
  // Not readable for 2 minutes: forgotten; the position size then tells what is left (a fill shows as a reduction).
  try{o=ladderOrderOf(await this.client.getOrder(p.venueSymbol,{clientOrderId:L.exit.clientOrderId}))}
  catch(e){if(orderAbsent(e)||old){delete L.exit;this.#save();return true}return false}
  if(!o){if(old){delete L.exit;this.#save();return true}return false}
  const st=String(o?.status||'').toUpperCase();
  if(L.exit?.maker&&!['FILLED','CANCELED','CANCELLED','EXPIRED','REJECTED','FAILED'].includes(st)&&typeof this.client.cancelOrder==='function'){
   try{await this.client.cancelOrder(p.venueSymbol,orderId(o)??undefined,{clientOrderId:L.exit.clientOrderId})}catch{}
   try{const fresh=ladderOrderOf(await this.client.getOrder(p.venueSymbol,{clientOrderId:L.exit.clientOrderId}));if(fresh)o=fresh}catch{}
  }
  await this.#ladderExitResult(p,o);
  return p.status==='OPEN'&&!L.exit;
 }
 /** The next ladder add when the price reaches it (from the last fill, or a strong zone before that). One order at a time,
  * saved as pending before it is sent (a restart settles it from the position, never sends it again). */
 async #ladderAdd(p,mark){
  const L=p.ladder,dir=dirOf(p.direction),nowTs=this.now();
  if(L.state!=='WATCH'||L.pending)return;
  if(L.filled>=L.units.length){L.state='COMPLETE';this.#save();return}
  if(L.retryAfterAt&&nowTs<L.retryAfterAt)return;
  // Adds pause while new entries are blocked (switch off, day loss stop, kill switch), as the earlier adds did.
  if(this.#blocked(p.id))return;
  // No add before the price is zoneMinFrac of the spacing from the last fill (a nearer zone is never used), so nothing is
  // read before that. The 4H / 1D read shares the scan's paced candle queue: the routine check waits at most 5 s for it
  // and tries again next time (review 2026-11-24: it held the final-line checks of the other positions behind the scan).
  const minLevel=Number(L.lastFill)*(1-dir*Number(L.spacingPct)*TRADER_LADDER.zoneMinFrac/100);
  if(!(mark>0)||!(minLevel>0)||dir*(mark-minLevel)>0)return;
  const zones=await withTimeout(this.#ladderZones(p),5000,null);
  if(!Array.isArray(zones))return;
  const next=ladderNextAdd({direction:p.direction,lastFill:L.lastFill,spacingPct:L.spacingPct,zones});
  L.next=next;
  if(!next||!(mark>0)||dir*(mark-next.level)>0)return;
  const revision=this.entryRevision,vs=p.venueSymbol,hedge=p.hedge===true,cl=this.client,stepQ=Number(p.quantityStep)||0;
  const [funds,fresh,levInfo]=await Promise.all([this.#funds({requireAvailable:true}),this.#position(vs,p.direction,hedge),typeof cl.leverage==='function'?withTimeout(cl.leverage(vs),2500):null]);
  if(!funds){L.lastReason='NO_BALANCE';return}
  if(!fresh.avg||Math.abs(fresh.size-L.size)>stepQ/2){L.lastReason='POSITION_CHANGED';return}
  const price=pos(fresh.mark)??mark;
  if(dir*(price-next.level)>0){L.lastReason='PRICE_OUTSIDE_BAND';return}
  const index=L.filled,boosted=next.zone?ladderZoneBoost(L.units,index):{units:[...L.units],boost:0},units=boosted.units[index];
  // The per-symbol cap: the margin of the fills so far + this step never goes past it.
  const used=L.fills.reduce((t,f)=>t+f.qty*f.price/p.leverage,0),left=L.capUSD-used;
  let qty=Number(grid(Math.min(units*L.unitMarginUSD,left)*p.leverage/price*(1+1e-9),p.quantityStep,'DOWN'))||0;
  if(qty<L.minQty&&L.minQty*price/p.leverage<=left+1e-9)qty=L.minQty;
  if(!(qty>=L.minQty)){L.state='STOPPED';L.lastReason='MIN_QUANTITY';this.#save();return}
  if(qty*price/p.leverage>funds.available*.9){L.lastReason='RISK_OR_MARGIN_CAP';L.retryAfterAt=nowTs+60000;return}
  const rawRoom=p.direction==='SHORT'?levInfo?.availableShortVol:levInfo?.availableLongVol;
  const room=typeof rawRoom==='number'||(typeof rawRoom==='string'&&rawRoom.trim()!=='')?num(rawRoom):null;
  if(room!==null&&room>=0&&room<qty){L.lastReason='VENUE_POSITION_LIMIT';L.retryAfterAt=nowTs+60000;return}
  const guard=()=>this.#blocked(p.id)||(revision!==this.entryRevision?'NOT_ARMED':null);
  if(guard())return;
  L.attempt=(L.attempt||0)+1;
  const id=(p.id+'L'+(index+1)+'n'+L.attempt).slice(0,31);
  // maker: a PostOnly child (id 'p') may rest on the book; it is cancelled and confirmed finished before a retry.
  const maker=this.config.makerEntry!==false&&typeof cl.getOrder==='function'&&typeof cl.cancelOrder==='function';
  L.pending={step:index+1,index,units,plannedUnits:boosted.units,boost:boosted.boost,zone:next.zone,level:next.level,clientOrderId:id,maker,attemptedAt:nowTs,preSize:fresh.size,preAvg:fresh.avg,requestedQty:qty,prevLastFill:L.lastFill};
  this.#save();
  try{
   if(maker){
    const exec=await placeMakerThenMarket({client:cl,symbol:vs,side:openSide(p.direction),positionSide:positionSideFor({hedge,direction:p.direction}),
     quantity:qty,quantityStep:p.quantityStep,minQuantity:L.minQty,tickSize:p.tickSize,markPrice:price,hedge,clientOrderId:id,
     waitMs:this.config.ladderMakerWaitMs??this.config.makerWaitMs??5000,pollMs:this.config.makerPollMs??400,beforeSend:guard});
    Object.assign(L.pending,{executionMode:exec.executionMode||'MARKET',reportedQty:pos(exec.filledQty),reportedPrice:pos(exec.avg)});
   }else{
    const o=orderOf(await cl.placeOrder({symbol:vs,side:openSide(p.direction),positionSide:positionSideFor({hedge,direction:p.direction}),type:'MARKET',quantity:String(qty),clientOrderId:id},{beforeSend:guard}));
    Object.assign(L.pending,{executionMode:'MARKET',reportedQty:pos(o?.executedQty),reportedPrice:pos(o?.avgPrice)});
   }
  }catch(e){
   if(e?.code==='ENTRY_NOT_SENT'){delete L.pending;L.lastReason=e.reason||'ENTRY_NOT_SENT';this.#save();return}
   // Refused by the venue: nothing was placed (a PostOnly part that filled is returned, not thrown, by the helper).
   if(/^(?:VENUE_ERROR_\d+|HTTP_4\d\d)$/.test(String(e?.code||''))){delete L.pending;L.lastReason=e.code;L.retryAfterAt=nowTs+60000;this.#save();return}
   // No answer, HTTP 5xx, PostOnly state unknown: kept pending and settled from the position.
   Object.assign(L.pending,{unknown:e?.code||e?.message||'UNKNOWN',...(e?.makerClientOrderId?{makerClientOrderId:e.makerClientOrderId}:{})});
   this.#event('SCALE_IN_PENDING',{symbol:p.symbol,reason:'ORDER_OUTCOME_UNKNOWN'});this.#save();return;
  }
  this.#save();
  await this.#ladderSettle(p);
 }
 /** A pending add settled from the venue position: added = size now - size before. Nothing added: waits up to 2 minutes,
  * cancelling a PostOnly child that may rest, then gives the step back (tried again 15 s later at the same level). */
 async #ladderSettle(p){
  const L=p.ladder,a=L.pending;if(!a)return;
  const fresh=await this.#position(p.venueSymbol,p.direction,p.hedge===true).catch(()=>null);
  if(!fresh)return;
  const stepQ=Number(p.quantityStep)||0,added=+(fresh.size-a.preSize).toFixed(12);
  if(added>stepQ/2){
   // An outcome never read: a PostOnly child may still rest; cancelled so no more of it fills (what still does is a
   // late fill, booked from the position and bounded by this attempt's quantity).
   if(a.unknown)await this.#ladderCancelAttempt(p,a);
   return this.#ladderBook(p,{qty:added,size:fresh.size,avg:pos(fresh.avg),prevAvg:pos(a.preAvg),prevSize:a.preSize,pending:a});
  }
  const age=this.now()-(a.attemptedAt||0);
  // Any add not yet seen in the position (an answer lost, a restart between sending and booking, a slow position read)
  // is waited for; only after that is the step given back.
  if(age<120000){await this.#ladderCancelAttempt(p,a);return}
  // Given back (and tried again under a new id) only when every order of this attempt is known to be finished
  // (review 2026-11-24): after an outage the old code gave the step back without a cancel, and a PostOnly child still
  // resting filled on top of the retry — two fills for one step, past the per-symbol cap and the reserved budget.
  const done=await this.#ladderAttemptDone(p,a);
  if(!done.ok&&age<LADDER_PENDING_MAX_MS)return;
  delete L.pending;
  if(!done.ok||done.filledQty>stepQ/2){
   // Still not known after 10 minutes, or filled per the venue but not in the position: this ladder adds no more,
   // so no retry can double the step (a late fill is booked from the position).
   L.state='STOPPED';L.lastReason=done.ok?'ORDER_OUTCOME_UNKNOWN':'MAKER_STATE_UNCONFIRMED';
   this.#event('SCALE_IN_PENDING',{symbol:p.symbol,reason:L.lastReason});this.#save();return;
  }
  L.lastReason='NOT_FILLED';L.retryAfterAt=this.now()+15000;
  this.#save();
 }
 /** Best effort: the PostOnly child of an add attempt cancelled (a market order cannot rest). */
 async #ladderCancelAttempt(p,a){
  if(a?.maker===false||typeof this.client.cancelOrder!=='function')return;
  const cid=a.makerClientOrderId||makerChildIds(a.clientOrderId).limit;
  try{await this.client.cancelOrder(p.venueSymbol,undefined,{clientOrderId:cid})}catch{}
 }
 /** Is every order of one add attempt finished? {ok, filledQty}. ok false while one still rests (it is cancelled) or
  * cannot be read. Client ids: the attempt's own (a plain market order) and, with the maker entry, its children. */
 async #ladderAttemptDone(p,a){
  const cl=this.client;
  if(typeof cl.getOrder!=='function')return {ok:true,filledQty:0};
  const kids=a.maker===false?[]:[a.makerClientOrderId||makerChildIds(a.clientOrderId).limit,makerChildIds(a.clientOrderId).market];
  let filledQty=0;
  for(const cid of new Set([a.clientOrderId,...kids])){
   let o;
   try{o=ladderOrderOf(await cl.getOrder(p.venueSymbol,{clientOrderId:cid}))}
   catch(e){if(orderAbsent(e))continue;return {ok:false}}
   if(!o)continue;
   if(!LADDER_TERMINAL.has(String(o.status||'').toUpperCase())){
    if(typeof cl.cancelOrder==='function')try{await cl.cancelOrder(p.venueSymbol,undefined,{clientOrderId:cid})}catch{}
    return {ok:false};
   }
   filledQty+=num(o.executedQty)||0;
  }
  return {ok:true,filledQty};
 }
 /** Books one ladder fill (from a pending add, or adopted from the position). */
 #ladderBook(p,{qty,size,avg,prevAvg=null,prevSize=0,pending=null,adopted=false}){
  const L=p.ladder;
  // The fill price from the venue average before and after (the order answer's price when that cannot be worked out).
  const price=avg&&prevAvg&&prevSize>0?(avg*size-prevAvg*prevSize)/qty:avg;
  const fill=pos(price)??pos(pending?.reportedPrice)??avg??p.avg;
  if(pending?.plannedUnits)L.units=[...pending.plannedUnits];
  L.filled++;L.lastFill=fill;L.size=size;if(avg)L.avg=avg;
  L.fills.push({step:L.filled,units:pending?.units??L.units[L.filled-1]??null,qty,price:fill,at:this.now(),zone:pending?.zone?{tf:pending.zone.tf,kind:pending.zone.kind??'VOLUME',low:pending.zone.low,high:pending.zone.high,why:[...(pending.zone.why||[])],at:pending.zone.at,...(pending.zone.kind==='WHALE'?{netUSD:pending.zone.netUSD??null}:{})}:null,
   boost:pending?.boost||0,executionMode:pending?.executionMode||null,...(adopted?{adopted:true}:{})});
  p.filled=+(Number(p.filled||0)+qty).toFixed(12);p.size=size;if(avg)p.avg=avg;p.marginUSD=p.avg*size/p.leverage;
  p.steps.push({kind:'ADD',at:this.now(),qty,avg:p.avg});
  delete L.pending;L.lastReason=null;L.retryAfterAt=null;L.next=null;
  L.state=L.state==='WATCH'||L.state==='COMPLETE'?(L.filled>=L.units.length?'COMPLETE':'WATCH'):L.state;
  this.#save();
  const view=this.#ladderView(p);
  this.#event('LADDER_ADD',{symbol:p.symbol,direction:p.direction,step:L.filled,of:L.units.length,units:L.fills.at(-1).units,qty,price:fill,prevAvg,avg:p.avg,left:size,
   zone:L.fills.at(-1).zone,boost:L.fills.at(-1).boost,adopted,nextAdd:view?.nextAdd?.price??null,tpPrice:view?.tpPrice??null,finalLineRoePct:L.finalLineRoePct});
  if(Number(this.config.hardStopRoePct)>0)void this.#ensureHardStop(p,{forceReplace:true}).catch(()=>{});
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
   const hasRecoverableExternal=this.config.mode==='TESTNET'&&this.store.closed.some(x=>x.closeReason==='EXTERNAL'&&!x.realized&&this.now()-(x.closedAt||0)<7*86400000);
   if(this.store.open.length||hasRecoverableExternal){
    try{
     const rawList=await this.client.positions();
     list=venueRows(rawList);
     if(!list){this.#event('RECONCILE_ERROR',{reason:'BAD_POSITIONS_RESPONSE'});return}
    }catch(e){if(e?.code==='HTTP_429'||e?.code==='VENUE_ERROR_109429')this.cooldownUntil=this.now()+60000;this.#event('RECONCILE_ERROR',{reason:e?.code||e?.message});return}
   }
   let unrealized=0;
   for(const p of [...this.store.open]){
    // An entry still being placed (its stop / targets not yet sent) is left to the entry path.
     if(p.status==='SUBMITTING'||p.status==='CLOSED'||this.reserved.has(p.symbol))continue;
     this.reconcilingSymbol=p.symbol;
    try{
     // A ladder add sent but not booked (also after a restart): settled from the venue position first, never sent again.
     // Still pending afterwards: the final line keeps protecting the position meanwhile (review 2026-11-24: it was
     // skipped for up to 2 minutes, longer while the position read failed).
     if(isLadder(p)&&p.ladder.pending){
      await this.#ladderSettle(p);
      if(p.ladder.pending&&p.status==='OPEN'){const {size,row}=positionOf(list,p.venueSymbol,p.direction,p.hedge===true);await this.#ladderFinalLine(p,{size,mark:pos(row?.markPrice),avg:pos(row?.avgPrice)})}
      continue;
     }
     if(p.scaleIn?.state==='PENDING'||p.scaleIn?.state==='RESIZE'){
      if(posNoStop(p,this.config)&&!(Number(this.config.hardStopRoePct)>0))await this.#retireStop(p);
      await this.#recoverAdd(p);continue;
     }
     let {size,row,other}=positionOf(list,p.venueSymbol,p.direction,p.hedge===true);let mark=pos(row?.markPrice);
     if(p.earlyTakeProfit){
      try{this.#recordEarlyTakeProfit(p,await this.client.getOrder(p.venueSymbol,{clientOrderId:p.earlyTakeProfit.clientOrderId}))}
      catch(e){
       const oldEt=this.now()-(Number(p.earlyTakeProfit?.at)||0)>=10*60000;
       if(!orderAbsent(e)&&e?.code!=='VENUE_ERROR_109421'&&!(oldEt&&/^VENUE_ERROR_\d+$/.test(String(e?.code||''))))throw e;
       delete p.earlyTakeProfit;this.#save();
      }
     }
     if(size>0&&p.reconcileRetryAfter&&this.now()<p.reconcileRetryAfter){continue}
     const noStop=posNoStop(p,this.config);
     // Hedge mode: a position on the other side of this coin at any check -> this trade is not settled from the
     // symbol's fund flow (its PnL and funding would be mixed in, review 2026-11-17); the fill estimate stays.
     if(other>0&&!p.otherSideSeen){p.otherSideSeen=true;this.#event('OTHER_SIDE_SEEN',{symbol:p.symbol,direction:p.direction,reason:`${other}`})}
     if(p.status==='UNKNOWN'){
      if(!(size>0)){
       const uo=p.unknownOrder;
       let cleared=false,stillResting=false;
       if(uo&&(uo.makerClientOrderId||uo.makerOrderId)&&typeof this.client.getOrder==='function'){
        const q={...(uo.makerClientOrderId?{clientOrderId:uo.makerClientOrderId}:{}),...(uo.makerOrderId?{orderId:uo.makerOrderId}:{})};
        let ord=null,absent=false;
        try{ord=orderOf(await this.client.getOrder(p.venueSymbol,q))}catch(e){if(orderAbsent(e))absent=true}
        const TERM=new Set(['FILLED','CANCELED','CANCELLED','EXPIRED','REJECTED','FAILED']);
        let st=String(ord?.status||'').toUpperCase();
        if(!absent&&ord&&!TERM.has(st)&&typeof this.client.cancelOrder==='function'){
         const oid=orderId(ord)??uo.makerOrderId??undefined;
         try{
          const cRes=orderOf(await this.client.cancelOrder(p.venueSymbol,oid,{...(uo.makerClientOrderId?{clientOrderId:uo.makerClientOrderId}:{})}));
          const cSt=String(cRes?.status||'').toUpperCase();
          if(TERM.has(cSt)){ord=cRes;st=cSt}
         }catch{}
         if(!TERM.has(st)){
          try{ord=orderOf(await this.client.getOrder(p.venueSymbol,q));st=String(ord?.status||'').toUpperCase()}catch(e){if(orderAbsent(e))absent=true}
         }
        }
        const exQty=num(ord?.executedQty);
        if(absent||(TERM.has(st)&&st!=='FILLED'&&!(exQty>0))){
         cleared=true;
        }else if(ord&&!TERM.has(st)){
         stillResting=true;
        }
       }
       if(!cleared&&!stillResting&&(p.zeroSeen=(p.zeroSeen||0)+1)>=2){
        // Confirm symbol-specifically before dropping UNKNOWN as ENTRY_NOT_FILLED in case bulk positions() missed it.
        const symRows=venueRows(await this.client.positions(p.venueSymbol));
        if(!symRows)throw err('POSITION_CHECK_FAILED',502);
        const verified=positionOf(symRows,p.venueSymbol,p.direction,p.hedge===true);
        if(verified.size>0){size=verified.size;row=verified.row;other=verified.other||0;mark=pos(row?.markPrice);p.zeroSeen=0}
        else{this.store.open=this.store.open.filter(x=>x!==p);this.#event('ENTRY_NOT_FILLED',{symbol:p.symbol});continue}
       }else if(cleared){
        this.store.open=this.store.open.filter(x=>x!==p);this.#event('ENTRY_NOT_FILLED',{symbol:p.symbol});continue;
       }else continue;
      }
      if(size>0){
       const uo=p.unknownOrder;
       if(uo&&(uo.makerOrderId||uo.makerClientOrderId)&&typeof this.client.cancelOrder==='function'){
        try{await this.client.cancelOrder(p.venueSymbol,uo.makerOrderId??undefined,{...(uo.makerClientOrderId?{clientOrderId:uo.makerClientOrderId}:{})})}catch{}
       }
       delete p.unknownOrder;
       p.status='OPEN';p.filled=p.size=size;p.avg=pos(row.avgPrice)??p.entry;p.firstEntryPrice??=pos(row.avgPrice);p.openedAt??=this.now();this.#event('ENTRY_RECOVERED',{symbol:p.symbol,qty:size});
       if(noStop){p.steps.push({kind:'OPEN',at:this.now(),qty:size,avg:p.avg});if(isLadder(p)){this.#ladderOpened(p);p.riskUSD=p.initialRiskUSD=ladderHeldRisk(p)}else this.#enableRepeat(p)}
       if(p.twoPct)p.parts=twoPctResizeParts(size,p.quantityStep,p.targets?.length||1);
       else{const s=scalpSplits(size,p.quantityStep,0);if(s)p.parts=s.parts}
       if(await this.#protect(p))await this.#placeTargets(p);
      }
      continue;
     }
     if(!(size>0)){
      if((p.zeroSeen=(p.zeroSeen||0)+1)<2)continue;
      if(!p.exitReason){
       // Confirm symbol-specifically before closing as EXTERNAL (guards against BingX bulk positions() omitting a live coin).
       const symRows=venueRows(await this.client.positions(p.venueSymbol));
       if(!symRows)throw err('POSITION_CHECK_FAILED',502);
       const verified=positionOf(symRows,p.venueSymbol,p.direction,p.hedge===true);
       if(verified.size>0){
        size=verified.size;row=verified.row;other=verified.other||0;mark=pos(row?.markPrice);p.zeroSeen=0;
        this.#event('POSITION_BULK_MISS',{symbol:p.symbol,direction:p.direction,qty:size});
       }else{
        await this.#finish(p);continue;
       }
      }else{
       await this.#finish(p);continue;
      }
     }
     p.zeroSeen=0;
     // Manual first (real account): a lane that grew beyond our own size holds a manual position: never adopted as ours
     // (closes stay at our own size, adds see POSITION_CHANGED), told once.
     if(this.config.mode==='LIVE'&&pos(p.size)&&size>p.size+(Number(p.quantityStep)||0)/2){
      const manualQty=+(size-p.size).toFixed(12);
      if(!(p.manualQty>0))this.#event('MANUAL_FIRST',{symbol:p.symbol,direction:p.direction,reason:'MANUAL_ON_LANE',qty:manualQty,detail:`같은 자리에 수동 ${manualQty} — 단타는 자기 수량만 관리`});
      p.manualQty=manualQty;size=p.size;
     }else if(p.manualQty>0)p.manualQty=0;
     if(size<p.size-1e-12){
      const qty=+(p.size-size).toFixed(12);p.everReduced=true;p.steps.push({kind:'REDUCE',at:this.now(),qty,mark});
      this.#event('PARTIAL_EXIT',{symbol:p.symbol,direction:p.direction,qty,left:size});
     }
     p.size=size;if(!(p.manualQty>0))p.avg=pos(row.avgPrice)??p.avg;p.mark=mark??p.mark;
     p.unrealized=p.manualQty>0?(mark&&p.avg?dirOf(p.direction)*(mark-p.avg)*size:null):num(row.unrealizedProfit)??(mark&&p.avg?dirOf(p.direction)*(mark-p.avg)*size:null);unrealized+=p.unrealized||0;
     p.exchangePosition={size,entryPrice:p.avg,markPrice:mark,unrealizedPnLUSD:row.unrealizedProfit??null,
      marginUSD:pos(row.initialMargin)??pos(row.margin),realizedPnLUSD:row.realisedProfit??row.realizedProfit??null,at:this.now()};
     const parts=p.parts.map((q,i)=>q+(p.addTargets||[]).reduce((n,g)=>n+g.parts[i],0));
     const done=p.filled-size,need=[parts[0],parts[0]+parts[1],parts[0]+parts[1]+parts[2]];
     p.tpDone=need.map((n,i)=>parts[i]>0&&done>=n-1e-9);
     // Journal: MFE / MAE from every mark seen, and when each target was first seen filled.
     trackExcursion(p,mark,this.now());p.tpFills??=[null,null,null];
     p.tpDone.forEach((ok,i)=>{if(ok&&!p.tpFills[i])p.tpFills[i]={at:this.now(),price:mark??null,qty:parts[i],seen:'RECONCILE'}});
     if(p.earlyTakeProfit||p.exitReason==='EARLY_TAKE_PROFIT')continue;
     if(isLadder(p)){await this.#manageLadder(p,{size,mark,row});continue}
     if(noStop){
      if(Number(this.config.hardStopRoePct)>0){await this.#ensureHardStop(p)}
      else if(!await this.#retireStop(p))continue;
      await this.#retireLegacyProfitTargets(p);
      this.#enableRepeat(p);p.riskUSD=this.#repeatRisk(p,p.avg,mark)*size;
      const lev=Math.max(1,Number(p.leverage)||10);
      let roePct=mark>0&&p.avg>0?dirOf(p.direction)*(mark-p.avg)/p.avg*lev*100:null;
      const emLimit=Number(this.config.emergencyStopRoePct)||0;
      if(emLimit>0&&roePct!==null&&roePct<=-emLimit){
       p.exitTries=(p.exitTries||0)+1;
       const r=await this.#market(p,'em'+p.exitTries);
       p.exitReason='EMERGENCY_ROE_STOP';
       p.closeMeta={roePct:+roePct.toFixed(1),limitPct:emLimit};
       this.#event('EMERGENCY_ROE_STOP',{symbol:p.symbol,direction:p.direction,roePct:+roePct.toFixed(1),limitPct:emLimit});
       if(!(r.size>0))await this.#finish(p,'EMERGENCY_ROE_STOP');
       continue;
      }
      const defAddLimit=Number(this.config.defensiveAddRoePct)||0;
      const canDefensive=defAddLimit>0&&roePct!==null&&this.config.scaleIn&&p.scaleIn?.version===SCALP_REPEAT_SCALE_IN.version&&p.scaleIn.state==='WATCH'&&(p.scaleIn.count||0)===0&&!p.everReduced;
      if(canDefensive){
       const defBounce=Number(this.config.defensiveBouncePct??0.4);
       const defForce=Number(this.config.defensiveForceRoePct??55);
       const disarmRoe=-Math.max(20,defAddLimit-10);
       const dSign=dirOf(p.direction);
       if(roePct<=-defAddLimit){
        p.defensiveArmed=true;
        if(!pos(p.defensiveExtremeMark)||dSign*(mark-p.defensiveExtremeMark)<0){p.defensiveExtremeMark=mark;this.#save()}
       }else if(p.defensiveArmed&&roePct>disarmRoe){
        p.defensiveArmed=false;p.defensiveExtremeMark=null;this.#save();
       }
       if(p.defensiveArmed){
        if(pos(p.defensiveExtremeMark)&&dSign*(mark-p.defensiveExtremeMark)<0){p.defensiveExtremeMark=mark;this.#save()}
        const ext=pos(p.defensiveExtremeMark)??mark;
        const bouncePct=dSign*(mark-ext)/ext*100;
        const ready=!(defBounce>0)||bouncePct>=defBounce||(defForce>0&&roePct<=-defForce);
        if(ready){
         await this.#considerRepeat(p,mark,{defensive:true,roePct});
         if(p.status!=='OPEN')continue;
         roePct=p.mark>0&&p.avg>0?dirOf(p.direction)*(p.mark-p.avg)/p.avg*lev*100:roePct;
        }
       }
      }
      const maxHoldMin=Number(this.config.profitOnlyMaxHoldMin)||0;
      const opened=p.openedAt??p.createdAt;
      if(maxHoldMin>0&&opened>0&&this.now()-opened>=maxHoldMin*60000&&roePct!==null&&roePct<0){
       p.exitTries=(p.exitTries||0)+1;
       const r=await this.#market(p,'mh'+p.exitTries);
       const holdMin=Math.round((this.now()-opened)/60000);
       p.exitReason='MAX_HOLD_EXIT';
       p.closeMeta={holdMin,maxHoldMin,roePct:+roePct.toFixed(1)};
       this.#event('MAX_HOLD_EXIT',{symbol:p.symbol,direction:p.direction,holdMin,maxHoldMin,roePct:+roePct.toFixed(1)});
       if(!(r.size>0))await this.#finish(p,'MAX_HOLD_EXIT');
       continue;
      }
     }else{
      if(this.now()>=p.deadline){p.exitTries=(p.exitTries||0)+1;const r=await this.#market(p,'x'+p.exitTries);p.exitReason='TIME_STOP';if(!(r.size>0))await this.#finish(p);continue}
      if(p.tpDone[0]&&!p.breakevenMoved)await this.#breakeven(p,mark);
     }
     if(p.status==='OPEN'&&await this.#tryEarlyTakeProfit(p,mark))continue;
     if(p.status==='OPEN')await this.#placeTargets(p);
     if(p.status==='OPEN')await this.#considerAdd(p,mark);
     if(p.reconcileErrCount){p.reconcileErrCount=0;p.reconcileRetryAfter=0}
     }catch(e){
      if(e?.code==='HTTP_429'||e?.code==='VENUE_ERROR_109429'){this.cooldownUntil=this.now()+60000;this.#event('RECONCILE_ERROR',{symbol:p.symbol,reason:e.code});break}
      p.reconcileErrCount=(p.reconcileErrCount||0)+1;
      const delay=Math.min(300000,15000*(2**Math.min(4,p.reconcileErrCount-1)));
      p.reconcileRetryAfter=this.now()+delay;
      this.#event('RECONCILE_ERROR',{symbol:p.symbol,reason:e?.code||e?.message});
     }
     finally{this.reconcilingSymbol=null}
   }
   if(this.config.mode==='TESTNET'&&Array.isArray(list)&&list.length){
    this.#recoverFalseExternalPositions(list);
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
 /** TESTNET only: if a recently EXTERNAL-closed (unsettled) scalp position is still live on BingX with matching entry/size, restore it to open. */
 #recoverFalseExternalPositions(list){
  const now=this.now();
  for(const raw of list){
   const v=normalizeVenuePosition(raw);
   if(!v||!(v.size>0)||!v.direction)continue;
   if(this.reserved.has(v.symbol)||this.store.open.some(o=>o.venueSymbol===v.venueSymbol&&o.direction===v.direction))continue;
   let matchIdx=-1;
   for(let i=this.store.closed.length-1;i>=0;i--){
    const c=this.store.closed[i];
    if(!c||c.venueSymbol!==v.venueSymbol||c.direction!==v.direction)continue;
    if(c.closeReason!=='EXTERNAL'||c.realized)continue;
    if(c.closedAt&&now-c.closedAt>7*86400000)continue;
    const avgMatch=pos(c.avg)&&pos(v.avg)&&Math.abs(v.avg-c.avg)/c.avg<=0.02;
    const sizeMatch=pos(c.filled)&&Math.abs(v.size-c.filled)/c.filled<=0.05;
    if(avgMatch||sizeMatch){matchIdx=i;break}
   }
   if(matchIdx<0)continue;
   const [c]=this.store.closed.splice(matchIdx,1);
   delete c.closedAt;delete c.closeReason;delete c.estimate;delete c.netUSD;delete c.netSource;
   delete c.holdMs;delete c.rMultiple;delete c.exitFills;delete c.exitReason;delete c.closeMeta;delete c.settleTries;
   c.status='OPEN';c.zeroSeen=0;c.journaled=false;c.reconcileErrCount=0;c.reconcileRetryAfter=0;
   c.size=v.size;
   if(pos(v.avg))c.avg=v.avg;
   if(pos(v.mark))c.mark=v.mark;
   if(v.unrealized!==null)c.unrealized=v.unrealized;
   if(pos(v.leverage))c.leverage=v.leverage;
   c.exchangePosition={size:v.size,entryPrice:c.avg,markPrice:v.mark??c.mark,unrealizedPnLUSD:v.unrealized,marginUSD:v.margin,at:now};
   this.store.open.push(c);
   this.#event('POSITION_RECOVERED',{symbol:c.symbol,direction:c.direction,qty:c.size,entry:c.avg,reason:'FALSE_EXTERNAL_RECOVERED'});
  }
 }
 /** Flat on the venue: leftover orders cancelled, the fills read, close reason and estimated result booked. */
 async #finish(p,forced=null,{verifyCleanup=false}={}){
  const cl=this.client,vs=p.venueSymbol,targets=new Map(),fills=[];
  for(const group of [{ids:p.tpOrderIds},...(p.addTargets||[])])group.ids.forEach((id,i)=>{if(id)targets.set(id,i)});
  const exits=[...new Set([...p.stopIds,...targets.keys()].filter(Boolean))],ids=[...new Set([...exits,...p.exitIds].filter(Boolean))];
  const failedExits=[];
  for(const id of exits){try{await cl.cancelOrder(vs,id)}catch{if(verifyCleanup)failedExits.push(id)}}
  let cleanupPending=false;
  if(failedExits.length){
   const open=await cl.openOrders(vs).catch(()=>null),orders=open?.orders??open;
   cleanupPending=!Array.isArray(orders)||orders.some(o=>failedExits.includes(orderId(o)));
   if(cleanupPending)this.#event('CANCEL_FAILED',{symbol:p.symbol,direction:p.direction,reason:'MANUAL_CLOSE_CLEANUP'});
  }
  for(const id of ids){try{const o=orderOf(await cl.getOrder(vs,{orderId:id})),q=pos(o?.executedQty),price=pos(o?.avgPrice);if(q&&price)fills.push({id,qty:q,price,status:o?.status})}catch{}}
  // Journal: fill prices count as excursions; target fills replace the price seen on the reconcile.
  p.tpFills??=[null,null,null];
  const byTarget=new Map();
  for(const f of fills){trackExcursion(p,f.price,this.now());if(targets.has(f.id)){
   const i=targets.get(f.id),g=byTarget.get(i)??{qty:0,notional:0};g.qty+=f.qty;g.notional+=f.price*f.qty;byTarget.set(i,g);
  }}
  for(const [i,g] of byTarget)p.tpFills[i]={...(p.tpFills[i]||{}),at:p.tpFills[i]?.at??this.now(),price:Number((g.notional/g.qty).toPrecision(12)),qty:g.qty,seen:'ORDER'};
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
  const marginBase=p.avg>0&&p.filled>0?(p.avg*p.filled/(p.leverage||1)):0;
  const roePct=marginBase>0?+(row.netUSD/marginBase*100).toFixed(2):null;
  const adds=scalpAddCount(p);
  this.#event('CLOSED',{symbol:p.symbol,direction:p.direction,reason,netUSD:row.netUSD,tp:tpFilled,adds,...(isLadder(p)?{management:p.management,step:p.ladder.filled,of:p.ladder.units.length}:{}),holdMs:row.holdMs,entry:p.avg,roePct,peakRoePct:pos(p.trailPeakRoePct)??null,...(p.scalpScore?{score:p.scalpScore.score,grade:p.scalpScore.grade}:{})});
  return cleanupPending;
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
  all.byTrigger=Object.fromEntries(Object.values(SCALP_TRIGGERS).map(k=>[k,this.#stats(list.filter(x=>(x.trigger||SCALP_TRIGGERS.SCAN)===k))]));
  // By grade of the entry total on today's edges (B 70 / B+ 75 / A 80 / A+ 85 / S 90, 2026-11-25); the saved letter when no total.
  const gradeOf=x=>{const t=num(x.scoreTotal??x.scalpScore?.score??x.score?.score);return t!==null?scalpScoreGrade(t,this.config):(x.scoreGrade??x.scalpScore?.grade??x.score?.grade)};
  all.byGrade=Object.fromEntries(SCALP_GRADES.map(g=>[g,this.#stats(list.filter(x=>gradeOf(x)===g))]));
  // TRADER_LADDER (from 2026-11-24) and the management before it, apart.
  all.byManagement=Object.fromEntries(Object.values(SCALP_MANAGEMENTS).map(k=>[k,this.#stats(list.filter(x=>(x.management||SCALP_MANAGEMENTS.CURRENT)===k))]));
  // 고래 매물대 (user 2026-11-25 09:51): +5 / 0 / −5 / 확인 불가(자료 없음·80 % 미만) apart, and the trades without a zone record
  // (before it, the old window rule's included) apart as unmeasured, to check it later.
  const whaleOf=x=>x.whaleSplit??whaleSplitOf(x.scalpScore??x.score);
  all.byWhaleCvd=Object.fromEntries(WHALE_STATS_KEYS.map(k=>[k,this.#stats(list.filter(x=>whaleOf(x)===k))]));
  const experiment=list.filter(x=>x.scaleIn?.version===SCALP_SCALE_IN.version);
  const repeated=list.filter(x=>x.scaleIn?.version===SCALP_REPEAT_SCALE_IN.version);
  all.scaleIn={closed:experiment.length,filled:experiment.filter(x=>x.scaleIn.fillQty>0).length};
  all.repeatedScaleIn={closed:repeated.length,filled:repeated.filter(x=>x.scaleIn.count>0).length,adds:repeated.reduce((n,x)=>n+(x.scaleIn.count||0),0)};return all}
 /** Read only, for 실계좌 준비 점검 (ready_check.mjs): the same trades and scaled net as stats(), one row each. */
 readinessRows(){return [...this.journalRows,...this.store.closed.filter(x=>!x.journaled)].map(x=>({direction:x.direction||'LONG',netUSD:(Number(x.netUSD)||0)*this.#displayScaleFor(x),closedAt:x.closedAt??null,openedAt:x.openedAt??null,closeReason:x.closeReason??null,management:x.management||SCALP_MANAGEMENTS.CURRENT}))}
 #stats(list){
  const n=list.length,scaled=list.map(x=>({x,net:(Number(x.netUSD)||0)*this.#displayScaleFor(x)}));
  const wins=scaled.filter(r=>r.net>0),gross=wins.reduce((t,r)=>t+r.net,0),loss=-scaled.filter(r=>r.net<0).reduce((t,r)=>t+r.net,0);
  const today=kstDay(this.now()),reasons={};for(const x of list)reasons[x.closeReason]=(reasons[x.closeReason]||0)+1;
  return {trades:n,wins:wins.length,grossProfitUSD:+gross.toFixed(2),grossLossUSD:+loss.toFixed(2),winRatePct:n?+(wins.length/n*100).toFixed(1):null,profitFactor:loss>0?+(gross/loss).toFixed(2):null,netUSD:+scaled.reduce((t,r)=>t+r.net,0).toFixed(2),
   todayNetUSD:+scaled.filter(r=>kstDay(r.x.closedAt)===today).reduce((t,r)=>t+r.net,0).toFixed(2),closeReasons:reasons};
 }
 #scoreSummary(){
  const minScore=Number(this.config.minScore??SCALP_SCORE_DEFAULTS.minScore)||SCALP_SCORE_DEFAULTS.minScore;
  const nearFloor=Math.max(0,minScore-5);
  let nearMiss=0,low=0;
  for(const x of this.store.skips){
   if(x?.reason!=='SCORE_BELOW_MINIMUM')continue;
   const sc=num(x.score);
   if(sc!==null&&sc>=nearFloor)nearMiss++;else low++;
  }
  const st=this.stats();
  const passed=SCALP_GRADES.reduce((t,g)=>t+(st.byGrade?.[g]?.trades||0),0)+this.store.open.filter(p=>p?.scalpScore).length;
  return {minScore,nearFloor,passed,nearMiss,low};
 }
 status(){
  const c=this.config,g=this.#gate();
  return {strategy:SCALP_EXEC_STRATEGY,mode:c.mode,refused:c.refused,armed:this.armed,scanning:this.scanning===true,blocked:this.#blocked(),killSwitch:g.reason==='KILL_SWITCH',credentials:Boolean(this.client),
   // moveWindow / extremeWithin (detector defaults) and the guard thresholds: shown in the reason glossary (text only).
   settings:{interval:c.interval,sides:c.sides,moveWindow:SCALP_DEFAULTS.moveWindow,extremeWithin:SCALP_DEFAULTS.extremeWithin,...c.settings,squeezeFundingPct:c.squeezeFundingPct,squeezeOiChange30mPct:c.squeezeOiChange30mPct,btcGuard5mPct:SCALP_BTC_GUARD_5M_PCT,btcGuard15mPct:SCALP_BTC_GUARD_15M_PCT,btcGuardRelease5mPct:c.btcGuardRelease5mPct??SCALP_BTC_GUARD_RELEASE_5M_PCT,autoShiftTargets:c.autoShiftTargets!==false,maxSameSide:c.maxSameSide??4,trendFilter:c.trendMode==='on',trendMode:c.trendMode,minNetRR:c.minNetRR,maxHoldMin:c.stopLossEnabled===false?null:c.maxHoldMs/60000,
    earlyTakeProfitMin:c.stopLossEnabled===false?(c.earlyFallbackMin??PROFIT_ONLY_EARLY_EXIT_MIN):EARLY_TAKE_PROFIT_MS/60000,profitHoldTargetMin:c.stopLossEnabled===false?SCALP_PROFIT_HOLD_TARGET_MIN:null,minProfitRoePct:c.stopLossEnabled===false?(c.minProfitRoePct??SCALP_MIN_PROFIT_ROE_PCT):null,partialTakeFrac:c.partialTakeFrac??SCALP_PARTIAL_TAKE_FRAC,profitOnlyMaxHoldMin:c.profitOnlyMaxHoldMin??240,makerEntry:c.makerEntry!==false,makerExit:c.makerExit!==false,adaptiveLeverage:c.adaptiveLeverage!==false,profitOnlyTargetMarginPct:c.profitOnlyTargetMarginPct??SCALP_PROFIT_ONLY_TARGET_MARGIN_PCT,
    reversalRecheckMin:REVERSAL_RECHECK_MS/60000,riskPct:c.riskPct,maxOpen:c.maxOpen,leverage:c.leverage,
    maxMarginPct:c.maxMarginPct,maxTotalMarginPct:this.budget?this.budget.marginCapPct:c.maxTotalMarginPct,dailyLossPct:this.budget?this.budget.dailyLossPct:c.dailyLossPct,sharedBudget:Boolean(this.budget),maxDriftPct:c.maxDriftPct,driftMovePct:c.driftMovePct,stopKeepPct:c.stopKeepPct,maxDriftAtr:c.maxDriftAtr,universeSize:c.universeSize,balanceCapUSD:c.balanceCapUSD||null,
    zoneSignals:c.zoneSignals===true,zoneMinMovePct:c.zoneMinMovePct,zoneTouchPct:c.zoneTouchPct,pumpAlerts:c.pumpAlerts!==false&&(c.mode==='TESTNET'||(c.mode==='LIVE'&&c.allowLive===true)),pumpStrategy:this.#pumpStrategy(),pumpImmediate:this.#pumpStrategy()===SCALP_PUMP_STRATEGIES.IMMEDIATE,pumpWatchMin:this.#pumpStrategy()===SCALP_PUMP_STRATEGIES.TWO_PCT?(c.twoPctWatchMin??TWO_PCT_DEFAULTS.watchMin):PUMP_WATCH_MIN,
    twoPctLeverage:c.twoPctLeverage??TWO_PCT_DEFAULTS.leverage,twoPctMinBodyPct:c.twoPctMinBodyPct??TWO_PCT_DEFAULTS.minBodyPct,twoPctMinNetRR:c.twoPctMinNetRR??TWO_PCT_DEFAULTS.minNetRR,twoPctPartialTpRR:c.twoPctPartialTpRR??TWO_PCT_DEFAULTS.partialTpRR,twoPctMaxTpRR:c.twoPctMaxTpRR??TWO_PCT_DEFAULTS.maxTpRR,twoPctMaxTpDistPct:c.twoPctMaxTpDistPct??TWO_PCT_DEFAULTS.maxTpDistPct,twoPctMinStopPct:c.twoPctMinStopPct??TWO_PCT_DEFAULTS.minStopPct,twoPctMaxStopPct:c.twoPctMaxStopPct??TWO_PCT_DEFAULTS.maxStopPct,twoPctMaxStopRoePct:c.twoPctMaxStopRoePct??TWO_PCT_DEFAULTS.maxStopRoePct,twoPctWatchMin:c.twoPctWatchMin??TWO_PCT_DEFAULTS.watchMin,twoPctLossCooldownMin:c.twoPctLossCooldownMin??TWO_PCT_DEFAULTS.lossCooldownMin,twoPctWinCooldownMin:c.twoPctWinCooldownMin??TWO_PCT_DEFAULTS.winCooldownMin,
    minScore:c.minScore??SCALP_SCORE_DEFAULTS.minScore,highScore:c.highScore??SCALP_SCORE_DEFAULTS.highScore,highScoreSizeMult:c.highScoreSizeMult??SCALP_SCORE_DEFAULTS.highSizeMult,scoreTierSizing:c.scoreTierSizing!==false,scoreTiers:{...(c.scoreTiers??SCALP_SCORE_TIERS)},scoreTierMults:{...SCALP_SCORE_TIER_MULTS},scoreUnifiedMove:c.scoreUnifiedMove!==false,maxScaleInAdds:c.maxScaleInAdds??2,
    emergencyStopRoePct:c.emergencyStopRoePct??75,hardStopRoePct:c.hardStopRoePct??0,minFreeAccountMarginPct:c.minFreeAccountMarginPct??0,maxSpreadPct:c.maxSpreadPct??0,preFundingWindowMin:c.preFundingWindowMin??0,preFundingExtremePct:c.preFundingExtremePct??0,scaleInRetrySlippagePct:c.scaleInRetrySlippagePct??SCALP_REPEAT_SCALE_IN.retrySlippagePct,scaleInMarketFallback:c.scaleInMarketFallback!==false,
    defensiveAddRoePct:c.defensiveAddRoePct??40,defensiveBouncePct:c.defensiveBouncePct??0.4,defensiveForceRoePct:c.defensiveForceRoePct??55,scaleInMinStepPct:c.scaleInMinStepPct??SCALP_REPEAT_SCALE_IN.minStepPct,scaleInMaxStepPct:c.scaleInMaxStepPct??SCALP_REPEAT_SCALE_IN.maxStepPct,scaleInSteps:SCALP_REPEAT_SCALE_IN.stepRs.slice(0,2),scaleInMults:SCALP_REPEAT_SCALE_IN.qtyMultipliers.slice(0,2),
    orderflowBoost:c.orderflowBoost!==false,orderflowOiBonus:c.orderflowOiBonus??5,orderflowCvdBonus:c.orderflowCvdBonus??5,orderflowCvdSizeMult:c.orderflowCvdSizeMult??1.5,
    whaleCvd:c.whaleCvd!==false,whaleCvdBonus:c.whaleCvdBonus??WHALE_CVD_DEFAULTS.bonus,whaleCvdMinSharePct:c.whaleCvdMinSharePct??WHALE_CVD_DEFAULTS.minSharePct,whaleCvdScale:c.whaleCvdScale??'auto',whaleCvdMaxPages:c.whaleCvdMaxPages??WHALE_CVD_DEFAULTS.maxPages,whaleCvdWindowMin:WHALE_CVD_DEFAULTS.maxWindowMs/60000,whaleCvdMinPurpleUSD:WHALE_CVD_DEFAULTS.minPurpleUSD,whaleCvdFixedPurpleUSD:100_000,whaleCvdFixedBrownUSD:1_000_000,
    whaleZoneHours:c.whaleZoneHours??WHALE_ZONE_DEFAULTS.lookbackHours,whaleZoneMaxPages:c.whaleZoneMaxPages??WHALE_ZONE_DEFAULTS.maxPages,whaleZoneBinAtrMult:WHALE_ZONE_DEFAULTS.binAtrMult,whaleZoneBinPct:WHALE_ZONE_DEFAULTS.binPctFallback,
    whaleZoneNearAtrMult:WHALE_ZONE_DEFAULTS.nearAtrMult,whaleZoneNearPct:WHALE_ZONE_DEFAULTS.nearPctFallback,whaleZoneTopN:WHALE_ZONE_DEFAULTS.topN,whaleZoneFloorPurpleMult:WHALE_ZONE_DEFAULTS.floorPurpleMult,
    whaleZoneFloorSharePct:WHALE_ZONE_DEFAULTS.floorSharePct,whaleZoneMinCoveragePct:WHALE_ZONE_DEFAULTS.minCoveragePct,whaleZoneMaxStaleSec:WHALE_ZONE_DEFAULTS.maxStaleMs/1000,whaleZoneRefreshMin:WHALE_ZONE_DEFAULTS.storeTtlMs/60000,
    sessionWeighting:c.sessionWeighting!==false,sessionEuMult:c.sessionEuMult??0.5,sessionUsMult:c.sessionUsMult??1.15,euBlockCounterTrend:c.euBlockCounterTrend!==false,
    bounceSizing:c.bounceSizing!==false,bounceThresholdPct:c.bounceThresholdPct??20,bounceHighMult:c.bounceHighMult??1.35,bounceLowMult:c.bounceLowMult??0.8,
    symbolLossCooldownMin:c.symbolLossCooldownMin??120,symbolDailyMaxLosses:c.symbolDailyMaxLosses??2,
    scaleIn:c.scaleIn===true,scaleInMarginRatio:c.stopLossEnabled===false?null:1,stopLossEnabled:c.stopLossEnabled!==false,repeatedScaleIn:c.scaleIn===true&&c.stopLossEnabled===false&&this.#management()!==SCALP_MANAGEMENTS.LADDER,
    // TRADER_LADDER (scalp_ladder.mjs): the settings the screen and the reason glossary show.
    management:this.#management(),managementConfigured:c.management??SCALP_MANAGEMENTS.LADDER,managementSince:this.managementScope().since,
    ladderSteps:[...TRADER_LADDER.steps],ladderTotalUnits:TRADER_LADDER.totalUnits,ladderCapShare:TRADER_LADDER.capShare??1,ladderSpacingMinPct:c.ladderSpacingMinPct??TRADER_LADDER.spacingMinPct,ladderSpacingAtrMult:TRADER_LADDER.spacingAtrMult,
    ladderTpNetPct:c.ladderTpNetPct??TRADER_LADDER.tpNetPct,pumpLadderTpNetPct:c.pumpLadderTpNetPct??2,ladderMaxHoldMin:c.ladderMaxHoldMin??TRADER_LADDER.maxHoldMin,ladderMaxHoldHours:+((c.ladderMaxHoldMin??TRADER_LADDER.maxHoldMin)/60).toFixed(1),
    ladderFinalLineRoePct:c.emergencyStopRoePct??75,ladderZoneTouchPct:TRADER_LADDER.zoneTouchPct,ladderZoneMinRejections:TRADER_LADDER.zoneMinRejections,ladderZoneBoost:TRADER_LADDER.zoneBoost,ladderSource:{...TRADER_LADDER.source}},
   pumpWatch:[...this.pumpWatch.values()].map(w=>({symbol:w.symbol,direction:w.direction,until:w.until,tries:w.tries,lastReason:w.lastReason??null})),
   universe:{count:this.universe.length,watchlist:this.config.watchlist,refreshedAt:this.universeAt||null,top:this.universe.slice(0,12).map(u=>u.symbol)},lastScan:this.lastScan,funds:this.funds,dailyStop:this.store.dailyStop,
   blockedKo:scalpReasonKo(this.#blocked()),positions:this.store.open.map(({steps,exchangePosition,...p})=>({...p,details:scalpPositionDetails({...p,steps,exchangePosition},this.now()),...(isLadder(p)?{ladderView:this.#ladderView(p)}:{})})),
   closed:this.store.closed.slice(-SCREEN_CLOSED).reverse().map(({steps,exchangePosition,...x})=>({...x,adds:scalpAddCount({steps,...x}),margin:scalpMargin(x),closeReasonKo:scalpCloseReasonLabel(x)})),stats:this.stats(),
   scoreSummary:this.#scoreSummary(),
   // The thresholds the last 고래 매물대 read used (alt-scaled purple edge, floor, bin, K, coverage), for the rule line.
   whaleZoneLast:this.whaleZoneLast??null,
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
   trendMode:c.trendMode,minScore:c.minScore??SCALP_SCORE_DEFAULTS.minScore,highScore:c.highScore??SCALP_SCORE_DEFAULTS.highScore,scoreTiers:{...(c.scoreTiers??SCALP_SCORE_TIERS)},highScoreSizeMult:c.highScoreSizeMult??SCALP_SCORE_DEFAULTS.highSizeMult,scoreUnifiedMove:c.scoreUnifiedMove!==false,
   symbolLossCooldownMin:c.symbolLossCooldownMin??120,symbolDailyMaxLosses:c.symbolDailyMaxLosses??2,makerEntry:c.makerEntry!==false,scoreSummary:this.#scoreSummary(),
   aiLensRecord:c.mode==='TESTNET'&&c.wyckoffRecord===true&&Boolean(this.signalsFile),scaleInEnabled:c.scaleIn,stopLossEnabled:c.stopLossEnabled,
   repeatedScaleIn:c.scaleIn&&!c.stopLossEnabled&&this.#management()!==SCALP_MANAGEMENTS.LADDER,management:this.#management(),open:this.store.open.length,
   ladderPositions:this.store.open.filter(isLadder).map(p=>({symbol:p.symbol,direction:p.direction,step:p.ladder.filled,of:p.ladder.units.length,state:p.ladder.state,lastReason:short(p.ladder.lastReason),pending:Boolean(p.ladder.pending)})),
   ...(c.mode==='TESTNET'&&!c.stopLossEnabled?{profitHoldTargetMin:SCALP_PROFIT_HOLD_TARGET_MIN,profitCheckStartsMin:0,earlyFallbackMin:c.earlyFallbackMin??PROFIT_ONLY_EARLY_EXIT_MIN,minProfitRoePct:c.minProfitRoePct??SCALP_MIN_PROFIT_ROE_PCT,partialTakeFrac:c.partialTakeFrac??SCALP_PARTIAL_TAKE_FRAC,profitOnlyMaxHoldMin:c.profitOnlyMaxHoldMin??240,minMovePct:c.settings?.minMovePct??null}:{}),
   stopRetirementPending:this.store.open.filter(p=>p.stopRetirementError).length,
   openAdds:this.store.open.reduce((n,p)=>n+scalpAddCount(p),0),
    ...(c.scaleIn&&!c.stopLossEnabled?{
     availableMarginUSD:this.funds?.available??null,
     maxPositionMarginPct:c.maxMarginPct,
     scaleInPositions:this.store.open.map(p=>{
      const a=p.scaleIn,position=p.exchangePosition;
      return {symbol:p.symbol,direction:p.direction,status:p.status,
       state:a?.state??null,adds:a?.count??0,reason:short(a?.reason),lastReason:short(a?.lastReason),checkedBucket:a?.checkedBucket??null,
       mark:pos(position?.markPrice),positionCheckedAt:position?.at??null,trigger:a?.version===SCALP_REPEAT_SCALE_IN.version?pos(this.#repeatTrigger(p)):null,
       size:pos(p.size),filled:pos(p.filled),partialExit:p.everReduced===true,partialProfitTaken:p.scaleInPartialTaken===true,trailPeakRoePct:p.trailPeakRoePct==null?null:num(p.trailPeakRoePct),exitPending:Boolean(p.earlyTakeProfit||p.exitReason==='EARLY_TAKE_PROFIT'),
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
