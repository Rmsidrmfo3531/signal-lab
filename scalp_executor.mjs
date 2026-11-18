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
import {appendJsonl,readJsonl,tailJsonl,candleShape,trackExcursion,journalLine,signalsPath,SCALP_JOURNAL_FILE,SCALP_SIGNALS_FILE,SIGNALS_MAX_BYTES} from './scalp_journal.mjs';
import {readPositionMode,leverageSideFor,positionSideFor,forMode,positionRow,orderOnSide,otherSideAmount} from './bingx_position_mode.mjs';
import {detectScalpReversal,buildScalpPlan,SCALP_DEFAULTS,SCALP_TIMEFRAMES,fourHourTrend,trendAllows} from './scalp_reversal.mjs';
import {zoneBook,zoneTouches,zoneTagFields,zoneSpanMs,ZONE_PROFILES,ZONE_TOUCH_PCT} from './backtest.mjs';

export const SCALP_EXEC_STRATEGY='SCALP_REVERSAL';
export const SCALP_EXEC_MODES=Object.freeze(['OFF','TESTNET']);
// User 2026-11-14 22:29: move = 2 x the 5m default (2.5 -> 5 %), targets 38.2 / 50 / 61.8 %, stop 0.25 ATR, climax 3x.
export const SCALP_EXEC_SETTINGS=Object.freeze({minMovePct:SCALP_TIMEFRAMES['5m'].minMovePct*2,retracements:Object.freeze([.382,.5,.618]),stopAtr:.25,climaxVolume:3});
// The backtest's cost assumptions (backtest.mjs BACKTEST_COSTS), the venue's taker fee when higher.
// Signal kinds (journal, screen badge, report): the 5 % move rule, and candidate B at a 4H / 1D volume zone.
export const SCALP_KINDS=Object.freeze({MOVE:'MOVE_REVERSAL',ZONE:'ZONE_REVERSAL'});
// Candidate B as in backtestScalp: zoneMinMovePct = the 5m default (2.5 %), touch within ZONE_TOUCH_PCT (0.3 %).
export const SCALP_ZONE_MIN_MOVE_PCT=SCALP_TIMEFRAMES['5m'].minMovePct;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
export const SCALP_EXEC_COSTS=Object.freeze({takerRate:.0006,makerRate:.0002,slippageBps:2,spreadBps:1,fundingRate:.0001,assumption:'EXPLICIT_PAPER_ASSUMPTIONS'});
export const SCALP_SCALE_IN=Object.freeze({version:1,windowBars:6,near:.5,far:.75});
const SCREEN_CLOSED=100,I5=SCALP_TIMEFRAMES['5m'].intervalMs,FRACTIONS=[.4,.35,.25],MAX_CLOSED=300,MAX_EVENTS=200,MAX_SKIPS=60,MAX_KEYS=500,SETTLE_DELAY_MS=150000,SETTLE_TRIES=4;
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
const kstDay=t=>new Date(t+9*3600000).toISOString().slice(0,10);
const grid=(v,step,mode)=>{try{return roundDecimalToStep(v,step,mode)}catch{return null}};
const withTimeout=(p,ms,fallback=null)=>Promise.race([Promise.resolve(p).catch(()=>fallback),new Promise(r=>setTimeout(()=>r(fallback),ms).unref?.())]);
const err=(code,status=409)=>Object.assign(Error(code),{code,httpStatus:status});
const dirOf=d=>d==='SHORT'?-1:1;
// Tick rounding by side: a stop away from the entry (LONG down / SHORT up), a target or a break-even stop
// on the safe side (target toward the entry, break-even at or beyond the entry in the profit direction).
const awayMode=d=>d==='SHORT'?'UP':'DOWN',towardMode=d=>d==='SHORT'?'UP':'DOWN',beMode=d=>d==='SHORT'?'DOWN':'UP';
const openSide=d=>d==='SHORT'?'SELL':'BUY',closeSide=d=>d==='SHORT'?'BUY':'SELL';
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
 return {mode:known?(raw||'TESTNET'):'OFF',refused:known?null:raw==='LIVE'?'LIVE_REFUSED':'MODE_INVALID',interval:'5m',sides:scalpSides(env.SCALP_EXEC_SIDES),
  settings:{...SCALP_EXEC_SETTINGS,retracements:[...SCALP_EXEC_SETTINGS.retracements]},// TP1 net RR floor (was 0.7 on the testnet, user 2026-11-17 "해결 방법 찾아봐 테스트넷인데": ICP/ARIA skipped at RR 0.78-0.83);
  // the backtest default is SCALP_DEFAULTS.minNetRR (1). Each trade keeps plan.netRR, so the 0.7-1 band is judged apart.
  minNetRR:n('SCALP_MIN_NET_RR',1,.3,3), /* back to 1 (2026-11-17 12:18 backtest: RR<1 band 29 trades PF 0.84 -$16.7, RR>=1 54 trades PF 1.17 +$39.3) */maxHoldMs:SCALP_TIMEFRAMES['5m'].maxHoldMs,
  // 4H trend: 'on' (default since 2026-11-17, user "수익을 극대화하는 방향으로": 30-day BingX backtest, against-trend
  // 23 trades -$76 of the -$101 total, PF 0.32) blocks against-trend signals and still logs trend4h/withTrend;
  // 'record' (2026-11-16 to 11-17, user: the followed trader shorted BLESSUSDT in a 4H uptrend that
  // the filter skipped) = measured and logged with every signal and trade, never blocks; 'on' blocks against-trend
  // signals as in the backtest; 'off' skips the measurement.
  trendMode:(m=>['on','true','1','yes'].includes(m)?'on':['off','false','0','no'].includes(m)?'off':['record','log'].includes(m)?'record':'on')(String(env.SCALP_EXEC_TREND_FILTER||'').trim().toLowerCase()),
  riskPct:n('SCALP_RISK_PCT',.5,.05,2),maxOpen:n('SCALP_MAX_OPEN',0,0,200),leverage:n('SCALP_LEVERAGE',10,1,20),
  scaleIn:!['off','false','0','no'].includes(String(env.SCALP_SCALE_IN??'').trim().toLowerCase()),
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
 const dec=(String(step).split('.')[1]||'').length,q=u=>Number((u*s).toFixed(dec)),min=minPart-s*1e-6;
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
  // Never more than the planned distance; a planned stop already under 3 costs takes no move toward it.
  // The signal extreme (low / high) must still hold.
  const need=Math.min(planned,Math.max(planned*config.stopKeepPct/100,3*rt)),ext=Number(det.evidence?.extreme);
  if(Number.isFinite(ext)&&ext>0&&!(dirOf(det.direction)*(price-ext)>0))return fail('PRICE_DRIFT',{driftPct:+driftPct.toFixed(3),toward:'STOP',beyondExtreme:true});
  if(!(left>=need))return fail('PRICE_DRIFT',{driftPct:+driftPct.toFixed(3),toward:'STOP',stopLeftPct:planned>0?+(left/planned*100).toFixed(1):null,allowedPct:planned>0?+((planned-need)/det.entry*100).toFixed(3):null});
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
 // Targets and the TP1 net RR do not depend on the quantity: checked on a 20-lot sample.
 const q=buildScalpPlan({signal:{...det,stop},estimate:{eligible:true,tickSize:tick,quantityStep:step,entryBasis:entry,quantity:Number(step)*20,minNotional:0,minQuantity:0},costs:cost,minNetRR:config.minNetRR});
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
  this.scanning=false;this.reconciling=false;this.lastReconcileAt=0;this.cooldownUntil=0;this.funds=null;
  // Trade journal (scalp_journal.mjs, user 2026-11-16 22:18): every finished trade, never truncated; the stats
  // header is computed over it (the in-store closed list stays capped). Detected signals go to their own file.
  this.journalFile=directory?path.join(directory,SCALP_JOURNAL_FILE):null;this.signalsFile=directory?path.join(directory,SCALP_SIGNALS_FILE):null;
  const written=this.journalFile?readJsonl(this.journalFile):[];
  this.journalRows=written.map(x=>({kind:x.kind||SCALP_KINDS.MOVE,direction:x.direction,netUSD:x.pnl?.netUSD??null,closedAt:x.exit?.at??null,closeReason:x.exit?.reason??null}));
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
  if(this.store.open.some(p=>p.status==='UNKNOWN'||p.id!==ignoreAddId&&p.scaleIn?.state==='PENDING'))return 'UNRESOLVED_ORDER_STATE';
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
 disarm(reason='MANUAL'){const was=this.armed;this.entryRevision++;this.armed=false;if(was)this.#event('DISARMED',{reason});this.#save();return this.status()}
 /** Symbols (and venue symbols) this ledger holds or is entering: other strategies on the account skip them. */
 heldSymbols(){const s=new Set(this.reserved);for(const p of this.store.open){s.add(p.symbol);s.add(p.venueSymbol)}return s}
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
  const every=this.store.open.length?15000:60000;
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
  try{
   const why=this.#blocked();if(why){st.error=why;return st}
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
    if(!det.ok)continue;if(kind===SCALP_KINDS.MOVE)st.signals++;
    // A candle already sent (any kind: same client id) is not looked at again.
    if(kind===SCALP_KINDS.ZONE&&this.store.sent.includes(scalpClientId(u.symbol,det.barAt,det.direction)))continue;
    // Journal context of this detection (no effect on the decision).
    const ctx={at:t,symbol:u.symbol,venueSymbol:u.venueSymbol,kind,direction:det.direction,barAt:det.barAt,evidence:det.evidence,atr:det.atr,candle:candleShape(closed.at(-1),det.direction),
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
    if(r?.entered){st.entered++;if(kind===SCALP_KINDS.ZONE)st.zoneEntered=(st.zoneEntered||0)+1}
    if(r?.reason!=='ALREADY_SENT')this.#logSignal(ctx,r);
   }
   // Scan duration on the positions this scan opened (journal only).
   for(const p of this.store.open)if(p.scan?.bucket===bucket)p.scan.durationMs=this.now()-st.at;
   if(!st.error&&st.failed&&!st.checked)st.error=`CANDLES_FAILED_${st.failed}:${st.lastFailure}`;
  }catch(e){st.error=e?.code||e?.message||'SCAN_FAILED'}
  finally{this.scanning=false;this.lastScan=st;this.#save()}
  return st;
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
  const b=Math.floor(this.now()/(4*3600000)),hit=this.trendCache.get(symbol);if(hit?.b===b)return hit.trend;
  let trend=null;try{trend=fourHourTrend(await this.trendCandles(symbol),this.now())}catch{}
  if(trend!==null)this.trendCache.set(symbol,{b,trend});return trend;
 }
 /** Loss to the stops of the open positions (0 once a stop sits at breakeven or better). */
 #openRisk(){return this.store.open.reduce((t,p)=>{
  const d=dirOf(p.direction),e=pos(p.avg||p.entry),st=pos(p.stop),q=pos(p.size||p.qty),pending=p.scaleIn?.state==='PENDING'?(p.scaleIn.reservedRiskUSD||0):0;
  if(!e||!st||!q)return t+pending;
  const unit=p.scaleIn?riskAtStop(p.direction,e,st,p.takerRate):Math.max(0,d*(e-st));
  if(p.scaleIn&&p.status==='SUBMITTING')return t+Math.max(unit*q,p.riskUSD)+pending;
  return t+unit*q+pending;
 },0)}
 #usedMargin(){return this.store.open.reduce((t,p)=>t+(p.size||p.qty||0)*(p.avg||p.entry||0)/(p.leverage||1)
  +(p.scaleIn?.state==='PENDING'?(p.scaleIn.reservedMarginUSD||0):0),0)}
 async #funds(){
  const b=await this.balance().catch(()=>null),eq=pos(b?.equity);if(!eq)return null;
  const cap=this.config.balanceCapUSD>0?this.config.balanceCapUSD:Infinity,equity=Math.min(eq,cap),used=Math.max(0,eq-(num(b.available)??eq));
  this.funds={equity,available:Math.max(0,Math.min(num(b.available)??equity,equity-used)),at:this.now()};return this.funds;
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
   // No count cap on testnet (user 2026-11-16), so the daily loss limit caps the risk up front: today's realized loss
   // + loss to the open stops + this trade must stay within it (review 2026-11-16, as OPEN_RISK_LIMIT for the signals).
   if(this.budget){
    // Shared TESTNET budget (testnet_budget.mjs): today's loss of both strategies + every open stop risk of both
    // + this trade within TESTNET_DAILY_LOSS_PCT of the equity; per-trade risk stays 0.5 %.
    const b=this.budget.check({equity:funds.equity,newRiskUSD:plan.riskUSD,newMarginUSD:plan.marginUSD,who:'scalp'});
    if(this.cur?.plan&&b.snap?.ok)this.cur.plan.openRiskUSD=+(b.snap.usedUSD+(Number(plan.riskUSD)||0)).toFixed(2);
    if(!b.ok)return skip(b.reason,b.detail);
   }else{const day=kstDay(this.now()),realized=this.store.closed.filter(x=>kstDay(x.closedAt)===day).reduce((t,x)=>t+(Number(x.netUSD)||0),0);
    const risk=Math.max(0,-realized)+this.#openRisk()+(Number(plan.riskUSD)||0),limit=funds.equity*this.config.dailyLossPct/100;
    if(this.cur?.plan)this.cur.plan.openRiskUSD=+risk.toFixed(2);
    if(risk>limit)return skip('OPEN_RISK_LIMIT',`$${risk.toFixed(2)} > $${limit.toFixed(2)}`)}
   // Held for the shared budget until the position is in the ledger (the signal strategy checks in between).
   this.reservedRisk.set(u.symbol,{riskUSD:Number(plan.riskUSD)||0,marginUSD:Number(plan.marginUSD)||0});
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
 async #enter(u,det,c,plan,id,{revision,equity}){
  const cl=this.client,vs=u.venueSymbol,d=det.direction,skip=(reason,detail)=>{this.#skip(u.symbol,reason,detail);return {entered:false,reason}};
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
  const beforeSend=()=>{
   const blocked=this.#blocked()||(revision!==this.entryRevision?'NOT_ARMED':null);
   if(blocked)return blocked;
   // Our reservation is included, either in reservedRisk or in the ledger once it has been saved.
   const shared=this.budget?.check({equity,who:'scalp'});
   return shared&&!shared.ok?shared.reason:null;
  };
  const blocked=beforeSend();if(blocked)return skip(blocked);
  const tick=c.tickSize,px=v=>grid(v,tick,awayMode(d))??String(v);
  const kind=this.cur?.kind||SCALP_KINDS.MOVE;
  const p={id,strategy:SCALP_EXEC_STRATEGY,strategyProfile:SCALP_EXEC_STRATEGY,kind,...(kind===SCALP_KINDS.ZONE&&this.cur?.zone?{zone:this.cur.zone}:{}),mode:'TESTNET',venue:'BINGX',symbol:u.symbol,venueSymbol:vs,direction:d,hedge,...(otherSide?{otherSideSeen:true}:{}),interval:'5m',
   pattern:det.pattern,barAt:det.barAt,plannedEntry:det.entry,checkedPrice:plan.entry,driftPct:plan.driftPct,entry:plan.entry,stop:plan.stop,initialStop:plan.stop,targets:plan.targets,
   qty:plan.qty,parts:plan.parts,targetCount:plan.targetCount,merged:plan.merged,leverage:plan.leverage,riskUSD:plan.riskUSD,marginUSD:plan.marginUSD,netRR:plan.netRR,
   tickSize:tick,quantityStep:c.quantityStep,takerRate:plan.takerRate,evidence:det.evidence,status:'SUBMITTING',createdAt:this.now(),deadline:det.barAt+this.config.maxHoldMs,
   avg:null,size:0,filled:0,stopOrderId:null,stopIds:[],tpOrderIds:[null,null,null],tpTries:[0,0,0],breakevenMoved:false,exitIds:[],steps:[],
   ...(plan.scaleIn?{scaleIn:plan.scaleIn}:{}),
   // Journal context (analysis only).
   atr:det.atr,detectedAt:this.cur?.at??null,candle:this.cur?.candle??null,trend4h:this.cur?.trend4h??null,withTrend:this.cur?.withTrend??null,universe:this.cur?.universe??null,scan:this.cur?.scan?{...this.cur.scan}:null,tpFills:[null,null,null],journalV:1};
  this.store.open.push(p);this.store.sent.push(id);this.#save();
  // In the ledger now (counted by #openRisk): the reservation is dropped so the risk is never counted twice (review L4).
  this.reservedRisk.delete(u.symbol);
  let fill;
  try{fill=await cl.placeOrder({symbol:vs,side:openSide(d),positionSide:positionSideFor({hedge,direction:d}),type:'MARKET',quantity:String(plan.qty),clientOrderId:id,
   stopLoss:JSON.stringify({type:'STOP_MARKET',stopPrice:Number(px(plan.stop)),workingType:'MARK_PRICE'})},{beforeSend})}
  catch(e){
   if(e?.code==='ENTRY_NOT_SENT'){
    this.store.open=this.store.open.filter(x=>x!==p);this.store.sent=this.store.sent.filter(x=>x!==id);
    this.#save();return skip(e.reason);
   }
   // Never sent blindly again: the client id is looked up first; an unknown outcome blocks new entries.
   let found=null;try{found=await cl.getOrder(vs,{clientOrderId:id})}catch{}
   if(!orderId(found)){
    if(e?.code==='NETWORK_UNREACHABLE'||e?.code==='HTTP_429'){p.status='UNKNOWN';this.#event('ENTRY_OUTCOME_UNKNOWN',{symbol:p.symbol,reason:e.code});this.#save();return {entered:false,reason:'UNKNOWN'}}
    this.store.open=this.store.open.filter(x=>x!==p);this.#save();return skip('ENTRY_REJECTED',e?.code||e?.message)}
   fill=found;
  }
  p.entryOrderId=orderId(fill);p.status='OPEN';p.openedAt=this.now();
  const now=await this.#position(vs,d,hedge).catch(()=>({size:0}));
  p.filled=p.size=now.size>0?now.size:plan.qty;p.avg=now.avg??pos(orderOf(fill)?.avgPrice)??plan.entry;
  if(p.scaleIn){
   p.riskUSD=riskAtStop(d,p.avg,p.initialStop,p.takerRate)*p.filled;p.marginUSD=p.avg*p.filled/p.leverage;
   Object.assign(p.scaleIn,{initialEntry:p.avg,initialQty:p.filled,initialMarginUSD:p.marginUSD,initialRiskUSD:p.riskUSD});
  }
  if(Math.abs(p.filled-plan.qty)>Number(c.quantityStep)/2){const s=scalpSplits(p.filled,c.quantityStep,0);if(s)p.parts=s.parts}
  p.steps.push({kind:'OPEN',at:this.now(),qty:p.filled,avg:p.avg});this.#save();
  if(!await this.#protect(p))return {entered:false,reason:p.closeReason||'NO_STOP'};
  await this.#placeTargets(p);
  trackExcursion(p,p.avg,this.now());
  // BTC 5m / 1h change around the entry: read after the orders are in, never awaited (journal only).
  void withTimeout(this.#btc(),5000).then(b=>{if(b)p.btc=b});
  this.#event('OPENED',{symbol:p.symbol,direction:d,id:p.id,kind:p.kind,...(p.zone?{zone:{tf:p.zone.tf,low:p.zone.low,high:p.zone.high,distPct:p.zone.distPct}}:{}),entry:p.avg,stop:p.stop,targets:p.targets,parts:p.parts,qty:p.filled,leverage:p.leverage,riskUSD:+p.riskUSD.toFixed(2),movePct:det.evidence?.movePct,volumeX:det.evidence?.climaxVolumeRatio,merged:p.merged});
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
   detail:ctx.detail,evidence:ctx.evidence,candle:ctx.candle,atr:ctx.atr,trend4h:ctx.trend4h??null,withTrend:ctx.withTrend??null,plan:ctx.plan??null,universe:ctx.universe,scan:ctx.scan};
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
   this.journalRows.push({kind:x.kind||SCALP_KINDS.MOVE,direction:x.direction,netUSD:line.pnl.netUSD,closedAt:x.closedAt,closeReason:x.closeReason});
  }
 }
 /** The newest `limit` journal lines (oldest first). */
 journal(limit=200){const n=Math.max(1,Math.min(2000,Math.floor(Number(limit))||200));return this.journalFile?tailJsonl(this.journalFile,n):this.journalMem.slice(-n)}
 signals(limit=200){if(!this.signalsFile)return (this.signalsMem||[]).slice(-limit);const now=this.now(),today=tailJsonl(signalsPath(this.signalsFile,now),limit);
  return today.length>=limit?today:[...tailJsonl(signalsPath(this.signalsFile,now-86400000),limit-today.length),...today]}
 /** The venue position of this symbol: `size` is the quantity on our side (a position on the other side
  * counts as 0 for us and is never closed by us), `any` any position at all. */
 async #position(vs,direction,hedge=false){return positionOf(await this.client.positions(vs),vs,direction,hedge)}
 async #openOrders(vs){const o=await this.client.openOrders(vs);return o?.orders??(Array.isArray(o)?o:[])}
 /** The attached stop is confirmed; else a whole-position stop is placed; else the position is closed. */
 async #protect(p){
  let list=null;try{list=await this.#openOrders(p.venueSymbol)}catch{try{list=await this.#openOrders(p.venueSymbol)}catch{}}
  // The stop attached to the entry (same price within a tick when the venue reports it).
  const found=(list||[]).find(o=>String(o.type).startsWith('STOP')&&orderOnSide(o,{hedge:p.hedge===true,direction:p.direction})&&(!pos(o.stopPrice)||Math.abs(Number(o.stopPrice)-p.stop)<=Number(p.tickSize)*1.01));
  if(found){p.stopOrderId=orderId(found);p.stopIds.push(p.stopOrderId);return true}
  try{const s=await this.client.placeOrder(this.#stopParams(p,p.stop,'s'));p.stopOrderId=orderId(s);p.stopIds.push(p.stopOrderId);this.#event('STOP_PLACED',{symbol:p.symbol});return true}
  catch(e){this.#event('STOP_FAILED',{symbol:p.symbol,reason:e?.code||e?.message});await this.#emergency(p,'NO_STOP');this.disarm('NO_PROTECTIVE_STOP');return false}
 }
 #stopParams(p,price,tag,mode=awayMode(p.direction)){return {symbol:p.venueSymbol,side:closeSide(p.direction),positionSide:positionSideFor({hedge:p.hedge===true,direction:p.direction}),type:'STOP_MARKET',quantity:String(p.size),stopPrice:grid(price,p.tickSize,mode)??String(price),closePosition:'true',workingType:'MARK_PRICE',clientOrderId:(p.id+tag).slice(0,40)}}
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
  const placed=await this.client.placeOrder({...params,quantity:String(Number(quantity.toFixed(12)))});
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
  const day=kstDay(this.now()),realized=this.store.closed.filter(x=>kstDay(x.closedAt)===day).reduce((sum,x)=>sum+(Number(x.netUSD)||0),0);
  return Math.max(0,-realized)+this.budgetSource().openRisk()+risk<=equity*this.config.dailyLossPct/100+1e-9
   &&this.budgetSource().usedMargin()+margin<=equity*this.config.maxTotalMarginPct/100+1e-9;
 }
 async #recoverAdd(p,order=null){
  const a=p.scaleIn,vs=p.venueSymbol;
  if(a.state==='PENDING'){
   order??=orderOf(await this.client.getOrder(vs,{clientOrderId:a.clientOrderId}).catch(()=>null));
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
 async #placeTargets(p){
  for(const [i,q] of p.parts.entries()){
   if(!(q>0)||p.tpOrderIds[i]||p.tpDone?.[i]||p.tpTries[i]>=3)continue;p.tpTries[i]++;
   try{const o=await this.client.placeOrder(forMode({symbol:p.venueSymbol,side:closeSide(p.direction),positionSide:positionSideFor({hedge:p.hedge===true,direction:p.direction}),type:'TAKE_PROFIT_MARKET',quantity:String(q),stopPrice:grid(p.targets[i],p.tickSize,towardMode(p.direction))??String(p.targets[i]),
    reduceOnly:'true',workingType:'MARK_PRICE',clientOrderId:(p.id+(p.scaleIn?.fillQty?'u':'t')+(i+1)+(p.tpTries[i]>1?p.tpTries[i]:'')).slice(0,40)},p.hedge===true));p.tpOrderIds[i]=orderId(o)}
   catch(e){this.#event('TARGET_FAILED',{symbol:p.symbol,reason:`${i+1}: ${e?.code||e?.message}`})}
  }
 }
 async #market(p,tag){
  const now=await this.#position(p.venueSymbol,p.direction,p.hedge===true);if(!(now.size>0))return now;
  const o=await this.client.placeOrder(forMode({symbol:p.venueSymbol,side:closeSide(p.direction),positionSide:positionSideFor({hedge:p.hedge===true,direction:p.direction}),type:'MARKET',quantity:String(now.size),reduceOnly:'true',clientOrderId:(p.id+tag).slice(0,40)},p.hedge===true));
  const id=orderId(o);if(id)p.exitIds.push(id);return {...now,size:0,exitAvg:pos(orderOf(o)?.avgPrice)};
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
     if(p.scaleIn?.state==='PENDING'||p.scaleIn?.state==='RESIZE'){await this.#recoverAdd(p);continue}
     const {size,row,other}=positionOf(list,p.venueSymbol,p.direction,p.hedge===true),mark=pos(row?.markPrice);
     // Hedge mode: a position on the other side of this coin at any check -> this trade is not settled from the
     // symbol's fund flow (its PnL and funding would be mixed in, review 2026-11-17); the fill estimate stays.
     if(other>0&&!p.otherSideSeen){p.otherSideSeen=true;this.#event('OTHER_SIDE_SEEN',{symbol:p.symbol,direction:p.direction,reason:`${other}`})}
     if(p.status==='UNKNOWN'){
      if(size>0){p.status='OPEN';p.filled=p.size=size;p.avg=pos(row.avgPrice)??p.entry;p.openedAt??=this.now();this.#event('ENTRY_RECOVERED',{symbol:p.symbol,qty:size});
       const s=scalpSplits(size,p.quantityStep,0);if(s)p.parts=s.parts;if(await this.#protect(p))await this.#placeTargets(p)}
      else if((p.zeroSeen=(p.zeroSeen||0)+1)>=2){this.store.open=this.store.open.filter(x=>x!==p);this.#event('ENTRY_NOT_FILLED',{symbol:p.symbol})}
      continue;
     }
     if(!(size>0)){if((p.zeroSeen=(p.zeroSeen||0)+1)>=2)await this.#finish(p);continue}
     p.zeroSeen=0;
     if(size<p.size-1e-12)p.steps.push({kind:'REDUCE',at:this.now(),qty:+(p.size-size).toFixed(12),mark});
     p.size=size;p.avg=pos(row.avgPrice)??p.avg;p.mark=mark??p.mark;p.unrealized=num(row.unrealizedProfit)??(mark&&p.avg?dirOf(p.direction)*(mark-p.avg)*size:null);unrealized+=p.unrealized||0;
     const done=p.filled-size,need=[p.parts[0],p.parts[0]+p.parts[1],p.parts[0]+p.parts[1]+p.parts[2]];
     p.tpDone=need.map((n,i)=>p.parts[i]>0&&done>=n-1e-9);
     // Journal: MFE / MAE from every mark seen, and when each target was first seen filled.
     trackExcursion(p,mark,this.now());p.tpFills??=[null,null,null];
     p.tpDone.forEach((ok,i)=>{if(ok&&!p.tpFills[i])p.tpFills[i]={at:this.now(),price:mark??null,qty:p.parts[i],seen:'RECONCILE'}});
     if(this.now()>=p.deadline){p.exitTries=(p.exitTries||0)+1;const r=await this.#market(p,'x'+p.exitTries);p.exitReason='TIME_STOP';if(!(r.size>0))await this.#finish(p);continue}
     if(p.tpDone[0]&&!p.breakevenMoved)await this.#breakeven(p,mark);
     if(p.status==='OPEN'&&p.tpOrderIds.some((id,i)=>!id&&p.parts[i]>0&&!p.tpDone[i]&&p.tpTries[i]<3))await this.#placeTargets(p);
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
  const cl=this.client,vs=p.venueSymbol,ids=[...new Set([...p.stopIds,...p.tpOrderIds,...p.exitIds].filter(Boolean))],fills=[];
  for(const id of [...new Set([...p.stopIds,...p.tpOrderIds].filter(Boolean))]){try{await cl.cancelOrder(vs,id)}catch{}}
  for(const id of ids){try{const o=orderOf(await cl.getOrder(vs,{orderId:id})),q=pos(o?.executedQty),price=pos(o?.avgPrice);if(q&&price)fills.push({id,qty:q,price,status:o?.status})}catch{}}
  // Journal: fill prices count as excursions; target fills replace the price seen on the reconcile.
  p.tpFills??=[null,null,null];
  for(const f of fills){trackExcursion(p,f.price,this.now());const i=p.tpOrderIds.indexOf(f.id);if(i>=0)p.tpFills[i]={...(p.tpFills[i]||{}),at:p.tpFills[i]?.at??this.now(),price:f.price,qty:f.qty,seen:'ORDER'}}
  p.exitFills=fills.map(f=>({kind:p.stopIds.includes(f.id)?'STOP':p.tpOrderIds.includes(f.id)?'TP'+(p.tpOrderIds.indexOf(f.id)+1):'MARKET',price:f.price,qty:f.qty}));
  const stopFilled=fills.some(f=>p.stopIds.includes(f.id)),tpFilled=p.tpOrderIds.filter((id,i)=>id&&p.parts[i]>0&&fills.some(f=>f.id===id)).length,placed=p.parts.filter(q=>q>0).length;
  const reason=forced||p.exitReason||(stopFilled?(p.breakevenMoved?'BREAKEVEN_STOP':'STOP'):tpFilled>=placed?'ALL_TARGETS':'EXTERNAL');
  // Estimate: the fills read back, any rest at the last price seen (or the stop); taker fee both ways.
  const dir=dirOf(p.direction);
  let out=fills.reduce((t,f)=>t+f.qty,0),gross=fills.reduce((t,f)=>t+dir*(f.price-p.avg)*f.qty,0),exitNotional=fills.reduce((t,f)=>t+f.price*f.qty,0);
  const rest=Math.max(0,p.filled-out);if(rest>1e-12){const px=pos(await withTimeout(this.priceOf(p.symbol,vs),3000))??p.mark??p.stop;gross+=dir*(px-p.avg)*rest;exitNotional+=px*rest;out+=rest}
  const fee=(p.avg*p.filled+exitNotional)*(p.takerRate||SCALP_EXEC_COSTS.takerRate),r=x=>Math.round(x*1e4)/1e4;
  p.status='CLOSED';p.closedAt=this.now();p.closeReason=reason;p.tpHits=tpFilled;
  if(p.scaleIn?.state==='WATCH')Object.assign(p.scaleIn,{state:'SKIPPED',reason:p.scaleIn.lastReason||reason});
  const row={...p,estimate:{source:'ESTIMATE',pnlUSD:r(gross),feeUSD:r(-fee),netUSD:r(gross-fee)},netUSD:r(gross-fee),netSource:p.otherSideSeen?'ESTIMATE_OTHER_SIDE':'ESTIMATE',holdMs:p.closedAt-(p.openedAt||p.createdAt)};
  // R multiple on the actual entry and the initial stop (replaced by the settled result when the journal line is written).
  {const risk=dir*(p.avg-p.initialStop)*p.filled;row.rMultiple=risk>0?r((gross-fee)/risk):null}
  this.store.closed.push(row);this.store.open=this.store.open.filter(x=>x!==p);
  this.#event('CLOSED',{symbol:p.symbol,direction:p.direction,reason,netUSD:row.netUSD,tp:tpFilled,holdMs:row.holdMs,entry:p.avg});
 }
 /** BingX fund flow (realized PnL + fees + funding) of this trade's symbol and lifetime, read after the close. */
 async #settle(x){
  x.settleTries=(x.settleTries||0)+1;if(typeof this.client.income!=='function')return;
  // A hedge trade that saw a position on the other side: the symbol's rows mix both, the fill estimate stays.
  if(x.otherSideSeen)return;
  const from=(x.createdAt||x.closedAt)-30000,to=Math.min(this.now(),x.closedAt+120000);
  const data=await this.client.income({symbol:x.venueSymbol,startTime:from,endTime:to,limit:1000}),list=Array.isArray(data)?data:Array.isArray(data?.list)?data.list:[];
  const rows=list.filter(y=>y?.symbol===x.venueSymbol&&Number(y.time)>=from&&Number(y.time)<=to);
  if(!rows.some(y=>y.incomeType==='REALIZED_PNL'))return;
  const sum=t=>rows.filter(y=>y.incomeType===t).reduce((s,y)=>s+(Number(y.income)||0),0),r=v=>Math.round(v*1e4)/1e4;
  x.realized={source:'EXCHANGE',pnlUSD:r(sum('REALIZED_PNL')),feeUSD:r(sum('TRADING_FEE')),fundingUSD:r(sum('FUNDING_FEE'))};x.realized.netUSD=r(x.realized.pnlUSD+x.realized.feeUSD+x.realized.fundingUSD);
  x.netUSD=x.realized.netUSD;x.netSource='EXCHANGE';
 }
 /** Win rate / PF / net over all closed scalps, and per side (bySide.LONG / bySide.SHORT). */
 // Over every trade: the journal plus the closed trades not yet written to it (the store keeps only the last 300).
 stats(){const list=[...this.journalRows,...this.store.closed.filter(x=>!x.journaled)];const all=this.#stats(list);all.bySide=Object.fromEntries(SCALP_SIDES.map(d=>[d,this.#stats(list.filter(x=>(x.direction||'LONG')===d))]));
  all.byKind=Object.fromEntries(Object.values(SCALP_KINDS).map(k=>[k,this.#stats(list.filter(x=>(x.kind||SCALP_KINDS.MOVE)===k))]));return all}
 #stats(list){
  const n=list.length,wins=list.filter(x=>x.netUSD>0),gross=wins.reduce((t,x)=>t+x.netUSD,0),loss=-list.filter(x=>x.netUSD<0).reduce((t,x)=>t+x.netUSD,0);
  const today=kstDay(this.now()),reasons={};for(const x of list)reasons[x.closeReason]=(reasons[x.closeReason]||0)+1;
  return {trades:n,wins:wins.length,grossProfitUSD:+gross.toFixed(2),grossLossUSD:+loss.toFixed(2),winRatePct:n?+(wins.length/n*100).toFixed(1):null,profitFactor:loss>0?+(gross/loss).toFixed(2):null,netUSD:+list.reduce((t,x)=>t+(Number(x.netUSD)||0),0).toFixed(2),
   todayNetUSD:+list.filter(x=>kstDay(x.closedAt)===today).reduce((t,x)=>t+(Number(x.netUSD)||0),0).toFixed(2),closeReasons:reasons};
 }
 status(){
  const c=this.config,g=this.#gate();
  return {strategy:SCALP_EXEC_STRATEGY,mode:c.mode,refused:c.refused,armed:this.armed,blocked:this.#blocked(),killSwitch:g.reason==='KILL_SWITCH',credentials:Boolean(this.client),
   settings:{interval:c.interval,sides:c.sides,...c.settings,trendFilter:c.trendMode==='on',trendMode:c.trendMode,minNetRR:c.minNetRR,maxHoldMin:c.maxHoldMs/60000,riskPct:c.riskPct,maxOpen:c.maxOpen,leverage:c.leverage,
    maxMarginPct:c.maxMarginPct,maxTotalMarginPct:this.budget?this.budget.marginCapPct:c.maxTotalMarginPct,dailyLossPct:this.budget?this.budget.dailyLossPct:c.dailyLossPct,sharedBudget:Boolean(this.budget),maxDriftPct:c.maxDriftPct,driftMovePct:c.driftMovePct,stopKeepPct:c.stopKeepPct,maxDriftAtr:c.maxDriftAtr,universeSize:c.universeSize,balanceCapUSD:c.balanceCapUSD||null,
    zoneSignals:c.zoneSignals===true,zoneMinMovePct:c.zoneMinMovePct,zoneTouchPct:c.zoneTouchPct,
    scaleIn:c.scaleIn===true,scaleInMarginRatio:1},
   universe:{count:this.universe.length,watchlist:this.config.watchlist,refreshedAt:this.universeAt||null,top:this.universe.slice(0,12).map(u=>u.symbol)},lastScan:this.lastScan,funds:this.funds,dailyStop:this.store.dailyStop,
   blockedKo:scalpReasonKo(this.#blocked()),positions:this.store.open.map(({steps,...p})=>p),closed:this.store.closed.slice(-SCREEN_CLOSED).reverse().map(({steps,...x})=>({...x,closeReasonKo:scalpReasonKo(x.closeReason)})),stats:this.stats(),
   skipCounts:Object.entries(this.store.skipCounts).map(([reason,count])=>({reason,label:scalpReasonKo(reason),count})).sort((a,b)=>b.count-a.count),
   skips:this.store.skips.slice(-20).reverse().map(x=>({...x,label:scalpReasonKo(x.reason)})),events:this.store.events.slice(-30).reverse()};
 }
 /** status() with fresh marks for open positions (public BingX price, cached) and a recent balance. */
 async liveStatus(){
  await Promise.all(this.store.open.filter(p=>p.size>0&&p.avg>0).map(async p=>{const m=pos(await withTimeout(this.markOf(p.venueSymbol),3000));if(m){p.mark=m;p.unrealized=dirOf(p.direction)*(m-p.avg)*p.size;p.markAt=this.now();trackExcursion(p,m,this.now())}}));
  if(this.client&&!(this.now()-(this.funds?.at||0)<15000))await this.#funds().catch(()=>null);
  return this.status();
 }
}
