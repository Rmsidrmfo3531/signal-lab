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
//  - Size: equity x riskPct (0.5 %) at the stop, margin capped; at most maxOpen (5) positions, one per symbol,
//    none on a symbol the signal strategy or copy holds on the same account.
//  - LIVE is refused: the mode is OFF or TESTNET, and the client must be a TESTNET client. Starts disarmed.
//  - Shared kill switch: no new entries. Daily loss limit (3 % of equity, realized today + open) disarms.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {atomicWriteStore,readStore} from './persistence.mjs';
import {roundDecimalToStep} from './decimal_grid.mjs';
import {scalpReasonKo} from './scalp_telegram.mjs';
import {appendJsonl,readJsonl,tailJsonl,candleShape,trackExcursion,journalLine,signalsPath,SCALP_JOURNAL_FILE,SCALP_SIGNALS_FILE,SIGNALS_MAX_BYTES} from './scalp_journal.mjs';
import {detectScalpReversal,buildScalpPlan,SCALP_DEFAULTS,SCALP_TIMEFRAMES,fourHourTrend,trendAllows} from './scalp_reversal.mjs';

export const SCALP_EXEC_STRATEGY='SCALP_REVERSAL';
export const SCALP_EXEC_MODES=Object.freeze(['OFF','TESTNET']);
// User 2026-11-14 22:29: move = 2 x the 5m default (2.5 -> 5 %), targets 38.2 / 50 / 61.8 %, stop 0.25 ATR, climax 3x.
export const SCALP_EXEC_SETTINGS=Object.freeze({minMovePct:SCALP_TIMEFRAMES['5m'].minMovePct*2,retracements:Object.freeze([.382,.5,.618]),stopAtr:.25,climaxVolume:3});
// The backtest's cost assumptions (backtest.mjs BACKTEST_COSTS), the venue's taker fee when higher.
export const SCALP_EXEC_COSTS=Object.freeze({takerRate:.0006,makerRate:.0002,slippageBps:2,spreadBps:1,fundingRate:.0001,assumption:'EXPLICIT_PAPER_ASSUMPTIONS'});
const SCREEN_CLOSED=20,I5=SCALP_TIMEFRAMES['5m'].intervalMs,FRACTIONS=[.4,.35,.25],MAX_CLOSED=300,MAX_EVENTS=200,MAX_SKIPS=60,MAX_KEYS=500,SETTLE_DELAY_MS=150000,SETTLE_TRIES=4;
const num=v=>{const n=Number(v);return Number.isFinite(n)?n:null};
const pos=v=>{const n=Number(v);return Number.isFinite(n)&&n>0?n:null};
const orderOf=d=>d?.order??d;
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
  settings:{...SCALP_EXEC_SETTINGS,retracements:[...SCALP_EXEC_SETTINGS.retracements]},minNetRR:SCALP_DEFAULTS.minNetRR,maxHoldMs:SCALP_TIMEFRAMES['5m'].maxHoldMs,
  trendFilter:String(env.SCALP_EXEC_TREND_FILTER||'').toLowerCase()!=='off',
  riskPct:n('SCALP_RISK_PCT',.5,.05,2),maxOpen:n('SCALP_MAX_OPEN',5,1,10),leverage:n('SCALP_LEVERAGE',10,1,20),
  // Margin per position and for all scalps together, as a share of the equity; quantity is cut to fit.
  maxMarginPct:n('SCALP_MAX_MARGIN_PCT',10,1,50),maxTotalMarginPct:n('SCALP_MAX_TOTAL_MARGIN_PCT',30,1,80),
  dailyLossPct:n('SCALP_DAILY_LOSS_PCT',3,.5,10),
  // Entry price check against the planned entry (the signal candle's close): within 0.4 % and 1 ATR (the
  // pre-move ATR the stop buffer uses), either way; the TP1 net RR is checked again at the price found.
  maxDriftPct:n('SCALP_MAX_DRIFT_PCT',.4,.05,2),maxDriftAtr:n('SCALP_MAX_DRIFT_ATR',1,.1,3),
  universeSize:n('SCALP_UNIVERSE_SIZE',80,10,200),universeRefreshMs:30*60000,klineGapMs:n('SCALP_KLINE_GAP_MS',350,100,2000),scanDelayMs:3000,
  balanceCapUSD:n('SCALP_BALANCE_CAP_USD',0,0,1e7)};
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
export function planScalpOrder({det,price,contract:c,equity,available=null,usedMargin=0,leverage,config,costs=SCALP_EXEC_COSTS}){
 const fail=(reason,extra={})=>({ok:false,reasons:[reason],...extra});
 if(!pos(price))return fail('PRICE_UNAVAILABLE');
 const drift=Math.abs(price-det.entry),driftPct=drift/det.entry*100;
 if(driftPct>config.maxDriftPct||drift>det.atr*config.maxDriftAtr)return fail('PRICE_DRIFT',{driftPct:+driftPct.toFixed(3)});
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
 const riskUSD=equity*config.riskPct/100,lev=pos(leverage)??1;
 let qty=riskUSD/(dir*(entry-stop)),capped=false;
 const cap=Math.min(equity*config.maxMarginPct/100,equity*config.maxTotalMarginPct/100-usedMargin,available!=null?available*.9:Infinity);
 if(!(cap>0))return fail('MARGIN_CAP');
 if(qty*entry/lev>cap){qty=cap*lev/entry;capped=true}
 qty=Number(grid(qty*(1+1e-9),step,'DOWN'))||0;
 const minPart=Number(grid(Math.max(Number(c.minQuantityBase)||0,(Number(c.minNotionalUSDT)||0)/entry*1.02,Number(step)),step,'UP'))||Number(step);
 const split=scalpSplits(qty,step,minPart);if(!split)return fail(capped?'MARGIN_CAP':'QUANTITY_BELOW_MINIMUM');
 return {ok:true,entry,stop,targets:q.targets,qty,parts:split.parts,targetCount:split.targets,merged:split.merged,minPart,leverage:lev,
  riskUSD:qty*dir*(entry-stop),marginUSD:qty*entry/lev,capped,netRR:q.estimatedNetRR,driftPct:+driftPct.toFixed(3),takerRate:cost.takerRate};
}
/** Deterministic client order ids: one signal candle of one symbol and side can be sent once (LONG keeps
 * the id it had before shorts were added, so a ledger written then still blocks a resend). */
export const scalpClientId=(symbol,barAt,direction='LONG')=>'sc'+createHash('sha256').update(`${SCALP_EXEC_STRATEGY}|${symbol}|${barAt}${direction==='SHORT'?'|SHORT':''}`).digest('hex').slice(0,22);

function positionOf(list,vs,direction){
 const row=(Array.isArray(list)?list:[]).find(x=>x?.symbol===vs),signed=row?signedAmount(row):0;
 // A one-way row with positionSide BOTH and a positive amount does not say its side: it is taken as ours
 // (one position per coin, and an entry is refused when one already exists). Reading a short as 0 would
 // close the ledger and cancel its stop while the venue still holds it (review note 2026-11-16).
 const side=String(row?.positionSide||'').toUpperCase(),unsignedBoth=signed>0&&(side===''||side==='BOTH');
 const mine=unsignedBoth?signed:dirOf(direction)*signed;
 return {size:mine>0?mine:0,any:Math.abs(signed),signed,avg:pos(row?.avgPrice),mark:pos(row?.markPrice),unrealized:row?num(row.unrealizedProfit):null};
}

export class ScalpExecutor{
 constructor({config,client=null,contracts=async()=>new Map(),tickers=async()=>[],candles=async()=>[],trendCandles=null,priceOf=async()=>null,markOf=async()=>null,
  balance=async()=>null,isBusy=()=>false,gate=()=>({ok:true}),directory=null,fileName='scalp-store.json',now=()=>Date.now(),log=()=>{},onEvent=()=>{}}){
  if(!SCALP_EXEC_MODES.includes(config?.mode))throw err('SCALP_TESTNET_ONLY',500);
  if(client&&client.mode!=='TESTNET')throw err('SCALP_TESTNET_ONLY',500);
  Object.assign(this,{config,client,contracts,tickers,candles,priceOf,markOf,balance,isBusy,gate,now,log,onEvent});
  this.trendCandles=trendCandles??(symbol=>this.candles(symbol,'4h',301));
  this.file=directory?path.join(directory,fileName):null;
  const saved=this.file&&fs.existsSync(this.file)?readStore(this.file):null;
  this.store={open:Array.isArray(saved?.open)?saved.open:[],closed:Array.isArray(saved?.closed)?saved.closed:[],events:Array.isArray(saved?.events)?saved.events:[],
   skipCounts:saved?.skipCounts||{},skips:Array.isArray(saved?.skips)?saved.skips:[],sent:Array.isArray(saved?.sent)?saved.sent:[],dailyStop:saved?.dailyStop||null};
  // An entry cut off by a restart: its outcome is read from the venue by the next check.
  for(const p of this.store.open)if(p.status==='SUBMITTING')p.status='UNKNOWN';
  this.armed=false;this.reserved=new Set();this.universe=[];this.universeAt=0;this.trendCache=new Map();this.lastScanBucket=null;this.lastScan=null;
  this.scanning=false;this.reconciling=false;this.lastReconcileAt=0;this.cooldownUntil=0;this.funds=null;
  // Trade journal (scalp_journal.mjs, user 2026-11-16 22:18): every finished trade, never truncated; the stats
  // header is computed over it (the in-store closed list stays capped). Detected signals go to their own file.
  this.journalFile=directory?path.join(directory,SCALP_JOURNAL_FILE):null;this.signalsFile=directory?path.join(directory,SCALP_SIGNALS_FILE):null;
  const written=this.journalFile?readJsonl(this.journalFile):[];
  this.journalRows=written.map(x=>({direction:x.direction,netUSD:x.pnl?.netUSD??null,closedAt:x.exit?.at??null,closeReason:x.exit?.reason??null}));
  // Ids already written: a restart between writing a line and saving the ledger must not write it twice.
  this.journalIds=new Set(written.map(x=>x?.id).filter(Boolean));
  this.journalMem=[];this.cur=null;this.btcCache=null;
  try{this.#flushJournal();this.#save()}catch(e){this.log?.('[SCALP] journal start',e.message)}
 }
 #save(){if(!this.file)return;const s=this.store;s.closed=s.closed.slice(-MAX_CLOSED);s.events=s.events.slice(-MAX_EVENTS);s.skips=s.skips.slice(-MAX_SKIPS);s.sent=s.sent.slice(-MAX_KEYS);
  fs.mkdirSync(path.dirname(this.file),{recursive:true});atomicWriteStore(this.file,{version:1,strategy:SCALP_EXEC_STRATEGY,...s})}
 #event(type,detail={}){const e={type,at:this.now(),mode:'TESTNET',strategy:SCALP_EXEC_STRATEGY,...detail};this.store.events.push(e);this.log(`[SCALP] ${type} ${detail.symbol||''} ${detail.reason||''}`.trim());try{this.onEvent(e)}catch{}return e}
 #skip(symbol,reason,detail=null){if(this.cur?.symbol===symbol){this.cur.reason=reason;this.cur.detail=detail==null?null:String(detail).slice(0,160)}this.store.skipCounts[reason]=(this.store.skipCounts[reason]||0)+1;this.store.skips.push({at:this.now(),symbol,reason,...(detail?{detail:String(detail).slice(0,160)}:{})})}
 #gate(){try{return this.gate()||{ok:true}}catch{return {ok:false,reason:'GATE_ERROR'}}}
 #todayStopped(){return this.store.dailyStop?.day===kstDay(this.now())}
 /** Why no new entry may be sent now (null = may). */
 #blocked(){
  if(this.config.mode!=='TESTNET')return this.config.refused||'SCALP_MODE_OFF';
  if(!this.client)return 'CREDENTIALS_MISSING';
  if(this.client.mode!=='TESTNET')return 'SCALP_TESTNET_ONLY';
  if(!this.armed)return 'NOT_ARMED';
  const g=this.#gate();if(!g.ok)return g.reason||'GATE_CLOSED';
  if(this.#todayStopped())return 'DAILY_LOSS_LIMIT';
  if(this.store.open.some(p=>p.status==='UNKNOWN'))return 'UNRESOLVED_ORDER_STATE';
  if(this.cooldownUntil>this.now())return 'RATE_LIMIT_COOLDOWN';
  return null;
 }
 arm(){
  if(this.config.mode!=='TESTNET')throw err(this.config.refused||'SCALP_MODE_OFF');
  if(!this.client)throw err('CREDENTIALS_MISSING');
  if(this.client.mode!=='TESTNET')throw err('SCALP_TESTNET_ONLY');
  const g=this.#gate();if(!g.ok)throw err(g.reason==='KILL_SWITCH'?'KILL_SWITCH_ON':g.reason||'GATE_CLOSED');
  if(this.#todayStopped())throw err('DAILY_LOSS_LIMIT');
  this.armed=true;this.#event('ARMED');this.#save();return this.status();
 }
 disarm(reason='MANUAL'){const was=this.armed;this.armed=false;if(was)this.#event('DISARMED',{reason});this.#save();return this.status()}
 /** Symbols (and venue symbols) this ledger holds or is entering: other strategies on the account skip them. */
 heldSymbols(){const s=new Set(this.reserved);for(const p of this.store.open){s.add(p.symbol);s.add(p.venueSymbol)}return s}
 // Reading candles (the scan) does not block a restart: only orders being placed (reserved) or a position
 // check (2026-11-16: a 30-60 s scan every 5 minutes made updates fail with 'ORDER_IN_PROGRESS').
 idle(){return !this.reconciling&&!this.reserved.size}

 /** Called every few seconds: the scan right after each 5m close, and the routine check. */
 async tick(now=this.now()){
  const bucket=Math.floor(now/I5);
  if(this.armed&&!this.scanning&&this.lastScanBucket!==bucket&&now-bucket*I5>=this.config.scanDelayMs)await this.scan(now);
  const every=this.store.open.length?15000:60000;
  if(!this.reconciling&&this.client&&now-this.lastReconcileAt>=every&&(this.store.open.length||this.armed||this.store.closed.some(x=>!x.journaled)))await this.reconcile();
 }
 async #refreshUniverse(now){
  if(this.universe.length&&now-this.universeAt<this.config.universeRefreshMs)return;
  const [tickers,contracts]=await Promise.all([this.tickers(),this.contracts()]);
  const list=scalpUniverse(tickers,contracts,this.config.universeSize);if(list.length){this.universe=list;this.universeAt=now}
 }
 async scan(now=this.now()){
  if(this.scanning)return this.lastScan;this.scanning=true;
  const bucket=Math.floor(now/I5),st={at:now,bucket,checked:0,signals:0,entered:0,error:null};this.lastScanBucket=bucket;
  try{
   const why=this.#blocked();if(why){st.error=why;return st}
   await this.#refreshUniverse(now);
   for(const [ix,u] of this.universe.entries()){
    if(this.#blocked())break;
    // BingX answers 100410 when the shared public request rate is exceeded (2026-11-16: 10 of 80 coins per
    // scan): wait a little and read that coin once more instead of skipping it.
    const read=()=>this.candles(u.symbol,'5m',61);
    // Up to two more tries (1.5 s, then 3 s), and once the limit was hit the rest of the scan goes slower
    // (2026-11-16: 3 of 80 coins still failed after one retry).
    const retry=async e=>{for(const w of [1500,3000]){if(e?.code!=='VENUE_ERROR_100410')throw e;st.rateLimited=(st.rateLimited||0)+1;await new Promise(r=>setTimeout(r,w));try{return await read()}catch(next){e=next}}throw e};
    if(st.rateLimited)await new Promise(r=>setTimeout(r,300));
    let rows;try{rows=await read().catch(retry)}
    // Other read failures are counted and shown (2026-11-16: a missing 5m interval failed every read silently).
    catch(e){if(e?.code==='HTTP_429'){st.error='HTTP_429';this.cooldownUntil=this.now()+60000;break}st.failed=(st.failed||0)+1;st.lastFailure=e?.code||e?.message||'READ_FAILED';continue}
    st.checked++;
    const t=this.now(),closed=(Array.isArray(rows)?rows:[]).filter(r=>Number(r?.[6])<t).slice(-60);
    // Only the candle that has just closed (a late or missing candle is not traded later).
    if(!closed.length||Number(closed.at(-1)[0])!==(bucket-1)*I5)continue;
    const det=detectScalpReversal(closed,{symbol:u.symbol,now:t,interval:'5m',settings:this.config.settings});
    if(!det.ok)continue;st.signals++;
    // Journal context of this detection (no effect on the decision).
    const ctx={at:t,symbol:u.symbol,venueSymbol:u.venueSymbol,direction:det.direction,barAt:det.barAt,evidence:det.evidence,atr:det.atr,candle:candleShape(closed.at(-1),det.direction),
     universe:{rank:ix+1,size:this.universe.length,quoteVolume:u.quoteVolume},scan:{startedAt:st.at,bucket,position:ix+1,of:this.universe.length,elapsedMs:t-st.at},reason:null,detail:null};
    this.cur=ctx;let r;
    try{
     if(!this.config.sides.includes(det.direction)){this.#skip(u.symbol,'SIDE_OFF',det.direction);r={entered:false,reason:'SIDE_OFF'}}
     else r=await this.#consider(u,det);
    }finally{this.cur=null}
    if(r?.entered)st.entered++;
    if(r?.reason!=='ALREADY_SENT')this.#logSignal(ctx,r);
   }
   // Scan duration on the positions this scan opened (journal only).
   for(const p of this.store.open)if(p.scan?.bucket===bucket)p.scan.durationMs=this.now()-st.at;
   if(!st.error&&st.failed&&!st.checked)st.error=`CANDLES_FAILED_${st.failed}:${st.lastFailure}`;
  }catch(e){st.error=e?.code||e?.message||'SCAN_FAILED'}
  finally{this.scanning=false;this.lastScan=st;this.#save()}
  return st;
 }
 async #trend(symbol){
  const b=Math.floor(this.now()/(4*3600000)),hit=this.trendCache.get(symbol);if(hit?.b===b)return hit.trend;
  let trend=null;try{trend=fourHourTrend(await this.trendCandles(symbol),this.now())}catch{}
  if(trend!==null)this.trendCache.set(symbol,{b,trend});return trend;
 }
 #usedMargin(){return this.store.open.reduce((t,p)=>t+(p.size||p.qty||0)*(p.avg||p.entry||0)/(p.leverage||1),0)}
 async #funds(){
  const b=await this.balance().catch(()=>null),eq=pos(b?.equity);if(!eq)return null;
  const cap=this.config.balanceCapUSD>0?this.config.balanceCapUSD:Infinity,equity=Math.min(eq,cap),used=Math.max(0,eq-(num(b.available)??eq));
  this.funds={equity,available:Math.max(0,Math.min(num(b.available)??equity,equity-used)),at:this.now()};return this.funds;
 }
 async #consider(u,det){
  const key=scalpClientId(u.symbol,det.barAt,det.direction),skip=(reason,detail)=>{this.#skip(u.symbol,reason,detail);return {entered:false,reason}};
  if(this.store.sent.includes(key))return {entered:false,reason:'ALREADY_SENT'};
  if(this.config.trendFilter){const trend=await this.#trend(u.symbol);if(this.cur)this.cur.trend4h=trend;if(!trendAllows(det.direction,trend))return skip(trend===null?'TREND_4H_UNAVAILABLE':'AGAINST_4H_TREND',trend)}
  if(this.store.open.length+this.reserved.size>=this.config.maxOpen)return skip('MAX_OPEN_POSITIONS');
  if(this.store.open.some(p=>p.symbol===u.symbol)||this.reserved.has(u.symbol))return skip('SYMBOL_ALREADY_HELD');
  let busy=false;try{busy=this.isBusy(u.symbol,u.venueSymbol)}catch{busy=true}
  if(busy)return skip('SYMBOL_HELD_BY_OTHER_STRATEGY');
  // Reserved right after the check, before any await: the signal strategy sees it through heldSymbols and
  // cannot enter the same coin in between (review 2026-11-16).
  this.reserved.add(u.symbol);
  try{
   const c=(await this.contracts(u.symbol).catch(()=>null))?.get?.(u.symbol);if(!c?.tradable)return skip('CONTRACT_UNAVAILABLE');
   const price=pos(await withTimeout(this.priceOf(u.symbol,u.venueSymbol),3000));
   const funds=await this.#funds();if(!funds)return skip('NO_BALANCE');
   let lev=this.config.leverage;
   try{const info=await this.client.leverage(u.venueSymbol),max=Number((det.direction==='SHORT'?info?.maxShortLeverage:info?.maxLongLeverage)??info?.maxLeverage);if(max>0)lev=Math.max(1,Math.min(lev,Math.floor(max)))}catch{}
   const plan=planScalpOrder({det,price,contract:c,equity:funds.equity,available:funds.available,usedMargin:this.#usedMargin(),leverage:lev,config:this.config});
   if(this.cur)this.cur.plan={price,ok:plan.ok,entry:plan.entry??null,stop:plan.stop??null,targets:plan.targets??null,netRR:plan.netRR??null,driftPct:plan.driftPct??null,qty:plan.qty??null,riskUSD:plan.riskUSD??null,leverage:lev};
   if(!plan.ok)return skip(plan.reasons[0],plan.driftPct!=null?`${plan.driftPct}%`:plan.netRR!=null?`RR ${Number(plan.netRR).toFixed(2)}`:null);
   return await this.#enter(u,det,c,plan,key);
  }catch(e){return skip(e?.code==='HTTP_429'?'HTTP_429':'ENTRY_SETUP_FAILED',e?.code||e?.message)}
  finally{this.reserved.delete(u.symbol)}
 }
 async #enter(u,det,c,plan,id){
  const cl=this.client,vs=u.venueSymbol,d=det.direction,skip=(reason,detail)=>{this.#skip(u.symbol,reason,detail);return {entered:false,reason}};
  const mode=await cl.positionMode();
  if(mode?.dualSidePosition===true||mode?.dualSidePosition==='true')return skip('BINGX_HEDGE_MODE');
  {const now=await this.#position(vs,d);if(now.any>0)return skip('VENUE_POSITION_EXISTS',`${now.signed}`)}
  try{
   const m=await cl.marginType(vs).catch(()=>null);
   if(m?.marginType!=='CROSSED'){await cl.setMarginType(vs,'CROSSED');const again=await cl.marginType(vs);if(again?.marginType!=='CROSSED')throw err('CROSS_NOT_CONFIRMED')}
   const set=await cl.setLeverage(vs,'BOTH',plan.leverage);
   if(set?.leverage!==undefined&&Number(set.leverage)!==plan.leverage)throw err('LEVERAGE_NOT_CONFIRMED');
  }catch(e){return skip('MARGIN_SETUP_FAILED',e?.code||e?.message)}
  const tick=c.tickSize,px=v=>grid(v,tick,awayMode(d))??String(v);
  const p={id,strategy:SCALP_EXEC_STRATEGY,strategyProfile:SCALP_EXEC_STRATEGY,mode:'TESTNET',venue:'BINGX',symbol:u.symbol,venueSymbol:vs,direction:d,interval:'5m',
   pattern:det.pattern,barAt:det.barAt,plannedEntry:det.entry,checkedPrice:plan.entry,driftPct:plan.driftPct,entry:plan.entry,stop:plan.stop,initialStop:plan.stop,targets:plan.targets,
   qty:plan.qty,parts:plan.parts,targetCount:plan.targetCount,merged:plan.merged,leverage:plan.leverage,riskUSD:plan.riskUSD,marginUSD:plan.marginUSD,netRR:plan.netRR,
   tickSize:tick,quantityStep:c.quantityStep,takerRate:plan.takerRate,evidence:det.evidence,status:'SUBMITTING',createdAt:this.now(),deadline:det.barAt+this.config.maxHoldMs,
   avg:null,size:0,filled:0,stopOrderId:null,stopIds:[],tpOrderIds:[null,null,null],tpTries:[0,0,0],breakevenMoved:false,exitIds:[],steps:[],
   // Journal context (analysis only).
   atr:det.atr,detectedAt:this.cur?.at??null,candle:this.cur?.candle??null,trend4h:this.cur?.trend4h??null,universe:this.cur?.universe??null,scan:this.cur?.scan?{...this.cur.scan}:null,tpFills:[null,null,null],journalV:1};
  this.store.open.push(p);this.store.sent.push(id);this.#save();
  let fill;
  try{fill=await cl.placeOrder({symbol:vs,side:openSide(d),positionSide:'BOTH',type:'MARKET',quantity:String(plan.qty),clientOrderId:id,
   stopLoss:JSON.stringify({type:'STOP_MARKET',stopPrice:Number(px(plan.stop)),workingType:'MARK_PRICE'})})}
  catch(e){
   // Never sent blindly again: the client id is looked up first; an unknown outcome blocks new entries.
   let found=null;try{found=await cl.getOrder(vs,{clientOrderId:id})}catch{}
   if(!orderId(found)){
    if(e?.code==='NETWORK_UNREACHABLE'||e?.code==='HTTP_429'){p.status='UNKNOWN';this.#event('ENTRY_OUTCOME_UNKNOWN',{symbol:p.symbol,reason:e.code});this.#save();return {entered:false,reason:'UNKNOWN'}}
    this.store.open=this.store.open.filter(x=>x!==p);this.#save();return skip('ENTRY_REJECTED',e?.code||e?.message)}
   fill=found;
  }
  p.entryOrderId=orderId(fill);p.status='OPEN';p.openedAt=this.now();
  const now=await this.#position(vs,d).catch(()=>({size:0}));
  p.filled=p.size=now.size>0?now.size:plan.qty;p.avg=now.avg??pos(orderOf(fill)?.avgPrice)??plan.entry;
  if(Math.abs(p.filled-plan.qty)>Number(c.quantityStep)/2){const s=scalpSplits(p.filled,c.quantityStep,0);if(s)p.parts=s.parts}
  p.steps.push({kind:'OPEN',at:this.now(),qty:p.filled,avg:p.avg});this.#save();
  if(!await this.#protect(p))return {entered:false,reason:p.closeReason||'NO_STOP'};
  await this.#placeTargets(p);
  trackExcursion(p,p.avg,this.now());
  // BTC 5m / 1h change around the entry: read after the orders are in, never awaited (journal only).
  void withTimeout(this.#btc(),5000).then(b=>{if(b)p.btc=b});
  this.#event('OPENED',{symbol:p.symbol,direction:d,id:p.id,entry:p.avg,stop:p.stop,targets:p.targets,parts:p.parts,qty:p.filled,leverage:p.leverage,riskUSD:+p.riskUSD.toFixed(2),movePct:det.evidence?.movePct,volumeX:det.evidence?.climaxVolumeRatio,merged:p.merged});
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
  const line={v:1,at:ctx.at,symbol:ctx.symbol,venueSymbol:ctx.venueSymbol,direction:ctx.direction,barAt:ctx.barAt,entered:r?.entered===true,reason:r?.entered?null:ctx.reason||r?.reason||null,
   detail:ctx.detail,evidence:ctx.evidence,candle:ctx.candle,atr:ctx.atr,trend4h:ctx.trend4h??null,plan:ctx.plan??null,universe:ctx.universe,scan:ctx.scan};
  if(this.signalsFile)appendJsonl(signalsPath(this.signalsFile,ctx.at||this.now()),line,{maxBytes:SIGNALS_MAX_BYTES});else this.signalsMem=[...(this.signalsMem||[]),line].slice(-500);
 }
 /** Closed trades whose result is final (settled by the venue, or no more settle tries) go to the journal. */
 #flushJournal(){
  const now=this.now(),income=typeof this.client?.income==='function';
  for(const x of this.store.closed){
   if(x.journaled)continue;
   if(!(x.realized||!income||(x.settleTries||0)>=SETTLE_TRIES||now-(x.closedAt||0)>=2*3600000))continue;
   // Already in the file (written before a restart that came before the ledger was saved): not again.
   if(x.id&&this.journalIds?.has(x.id)){x.journaled=true;continue}
   x.journalAt=now;if(!x.journalV)x.journalBackfill=true;
   let line;try{line=journalLine(x)}catch(e){this.log?.('[SCALP] journal line',x.symbol,e.message);continue}
   if(this.journalFile&&!appendJsonl(this.journalFile,line))continue; // not written: tried again next check
   if(!this.journalFile)this.journalMem.push(line);
   x.journaled=true;x.rMultiple=line.pnl?.r??null;if(x.id)this.journalIds?.add(x.id);
   this.journalRows.push({direction:x.direction,netUSD:line.pnl.netUSD,closedAt:x.closedAt,closeReason:x.closeReason});
  }
 }
 /** The newest `limit` journal lines (oldest first). */
 journal(limit=200){const n=Math.max(1,Math.min(2000,Math.floor(Number(limit))||200));return this.journalFile?tailJsonl(this.journalFile,n):this.journalMem.slice(-n)}
 signals(limit=200){if(!this.signalsFile)return (this.signalsMem||[]).slice(-limit);const now=this.now(),today=tailJsonl(signalsPath(this.signalsFile,now),limit);
  return today.length>=limit?today:[...tailJsonl(signalsPath(this.signalsFile,now-86400000),limit-today.length),...today]}
 /** The venue position of this symbol: `size` is the quantity on our side (a position on the other side
  * counts as 0 for us and is never closed by us), `any` any position at all. */
 async #position(vs,direction){return positionOf(await this.client.positions(vs),vs,direction)}
 async #openOrders(vs){const o=await this.client.openOrders(vs);return o?.orders??(Array.isArray(o)?o:[])}
 /** The attached stop is confirmed; else a whole-position stop is placed; else the position is closed. */
 async #protect(p){
  let list=null;try{list=await this.#openOrders(p.venueSymbol)}catch{try{list=await this.#openOrders(p.venueSymbol)}catch{}}
  // The stop attached to the entry (same price within a tick when the venue reports it).
  const found=(list||[]).find(o=>String(o.type).startsWith('STOP')&&(!pos(o.stopPrice)||Math.abs(Number(o.stopPrice)-p.stop)<=Number(p.tickSize)*1.01));
  if(found){p.stopOrderId=orderId(found);p.stopIds.push(p.stopOrderId);return true}
  try{const s=await this.client.placeOrder(this.#stopParams(p,p.stop,'s'));p.stopOrderId=orderId(s);p.stopIds.push(p.stopOrderId);this.#event('STOP_PLACED',{symbol:p.symbol});return true}
  catch(e){this.#event('STOP_FAILED',{symbol:p.symbol,reason:e?.code||e?.message});await this.#emergency(p,'NO_STOP');this.disarm('NO_PROTECTIVE_STOP');return false}
 }
 #stopParams(p,price,tag,mode=awayMode(p.direction)){return {symbol:p.venueSymbol,side:closeSide(p.direction),positionSide:'BOTH',type:'STOP_MARKET',quantity:String(p.size),stopPrice:grid(price,p.tickSize,mode)??String(price),closePosition:'true',workingType:'MARK_PRICE',clientOrderId:(p.id+tag).slice(0,40)}}
 async #placeTargets(p){
  for(const [i,q] of p.parts.entries()){
   if(!(q>0)||p.tpOrderIds[i]||p.tpDone?.[i]||p.tpTries[i]>=3)continue;p.tpTries[i]++;
   try{const o=await this.client.placeOrder({symbol:p.venueSymbol,side:closeSide(p.direction),positionSide:'BOTH',type:'TAKE_PROFIT_MARKET',quantity:String(q),stopPrice:grid(p.targets[i],p.tickSize,towardMode(p.direction))??String(p.targets[i]),
    reduceOnly:'true',workingType:'MARK_PRICE',clientOrderId:(p.id+'t'+(i+1)+(p.tpTries[i]>1?p.tpTries[i]:'')).slice(0,40)});p.tpOrderIds[i]=orderId(o)}
   catch(e){this.#event('TARGET_FAILED',{symbol:p.symbol,reason:`${i+1}: ${e?.code||e?.message}`})}
  }
 }
 async #market(p,tag){
  const now=await this.#position(p.venueSymbol,p.direction);if(!(now.size>0))return now;
  const o=await this.client.placeOrder({symbol:p.venueSymbol,side:closeSide(p.direction),positionSide:'BOTH',type:'MARKET',quantity:String(now.size),reduceOnly:'true',clientOrderId:(p.id+tag).slice(0,40)});
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
     const row=(Array.isArray(list)?list:[]).find(x=>x?.symbol===p.venueSymbol),{size}=positionOf(list,p.venueSymbol,p.direction),mark=pos(row?.markPrice);
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
    }catch(e){if(e?.code==='HTTP_429'){this.cooldownUntil=this.now()+60000;break}this.#event('RECONCILE_ERROR',{symbol:p.symbol,reason:e?.code||e?.message})}
   }
   for(const x of this.store.closed.filter(x=>!x.realized&&(x.settleTries||0)<SETTLE_TRIES&&this.now()-x.closedAt>=SETTLE_DELAY_MS&&this.now()-x.closedAt<2*3600000))await this.#settle(x).catch(()=>{});
   this.#flushJournal();
   // A check that runs only to finish the journal (disarmed, nothing open) changes nothing else.
   const journalOnly=!this.store.open.length&&!this.armed;
   const funds=journalOnly?null:await this.#funds();
   if(funds){
    const today=kstDay(this.now()),realized=this.store.closed.filter(x=>kstDay(x.closedAt)===today).reduce((t,x)=>t+(Number(x.netUSD)||0),0),total=realized+unrealized;
    if(!this.#todayStopped()&&total<=-funds.equity*this.config.dailyLossPct/100){
     this.store.dailyStop={day:today,at:this.now(),lossUSD:+total.toFixed(2),equity:funds.equity};
     this.#event('DAILY_LOSS_LIMIT',{reason:`${total.toFixed(2)} ≤ -${this.config.dailyLossPct}% of ${funds.equity.toFixed(2)}`,lossUSD:+total.toFixed(2)});this.disarm('DAILY_LOSS_LIMIT');
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
  const row={...p,estimate:{source:'ESTIMATE',pnlUSD:r(gross),feeUSD:r(-fee),netUSD:r(gross-fee)},netUSD:r(gross-fee),netSource:'ESTIMATE',holdMs:p.closedAt-(p.openedAt||p.createdAt)};
  // R multiple on the actual entry and the initial stop (replaced by the settled result when the journal line is written).
  {const risk=dir*(p.avg-p.initialStop)*p.filled;row.rMultiple=risk>0?r((gross-fee)/risk):null}
  this.store.closed.push(row);this.store.open=this.store.open.filter(x=>x!==p);
  this.#event('CLOSED',{symbol:p.symbol,direction:p.direction,reason,netUSD:row.netUSD,tp:tpFilled,holdMs:row.holdMs,entry:p.avg});
 }
 /** BingX fund flow (realized PnL + fees + funding) of this trade's symbol and lifetime, read after the close. */
 async #settle(x){
  x.settleTries=(x.settleTries||0)+1;if(typeof this.client.income!=='function')return;
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
 stats(){const list=[...this.journalRows,...this.store.closed.filter(x=>!x.journaled)];const all=this.#stats(list);all.bySide=Object.fromEntries(SCALP_SIDES.map(d=>[d,this.#stats(list.filter(x=>(x.direction||'LONG')===d))]));return all}
 #stats(list){
  const n=list.length,wins=list.filter(x=>x.netUSD>0),gross=wins.reduce((t,x)=>t+x.netUSD,0),loss=-list.filter(x=>x.netUSD<0).reduce((t,x)=>t+x.netUSD,0);
  const today=kstDay(this.now()),reasons={};for(const x of list)reasons[x.closeReason]=(reasons[x.closeReason]||0)+1;
  return {trades:n,wins:wins.length,winRatePct:n?+(wins.length/n*100).toFixed(1):null,profitFactor:loss>0?+(gross/loss).toFixed(2):null,netUSD:+list.reduce((t,x)=>t+(Number(x.netUSD)||0),0).toFixed(2),
   todayNetUSD:+list.filter(x=>kstDay(x.closedAt)===today).reduce((t,x)=>t+(Number(x.netUSD)||0),0).toFixed(2),closeReasons:reasons};
 }
 status(){
  const c=this.config,g=this.#gate();
  return {strategy:SCALP_EXEC_STRATEGY,mode:c.mode,refused:c.refused,armed:this.armed,blocked:this.#blocked(),killSwitch:g.reason==='KILL_SWITCH',credentials:Boolean(this.client),
   settings:{interval:c.interval,sides:c.sides,...c.settings,trendFilter:c.trendFilter,minNetRR:c.minNetRR,maxHoldMin:c.maxHoldMs/60000,riskPct:c.riskPct,maxOpen:c.maxOpen,leverage:c.leverage,
    maxMarginPct:c.maxMarginPct,maxTotalMarginPct:c.maxTotalMarginPct,dailyLossPct:c.dailyLossPct,maxDriftPct:c.maxDriftPct,maxDriftAtr:c.maxDriftAtr,universeSize:c.universeSize,balanceCapUSD:c.balanceCapUSD||null},
   universe:{count:this.universe.length,refreshedAt:this.universeAt||null,top:this.universe.slice(0,12).map(u=>u.symbol)},lastScan:this.lastScan,funds:this.funds,dailyStop:this.store.dailyStop,
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
