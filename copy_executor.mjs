// Copy trading of the followed Telegram channel on the BingX TESTNET (user 2026-11-13: "모두 그대로
// 따라가보고 대신 증거금은 1달러부터 시작하기"). Its own ledger (copy-store.json), never real money.
//
//  진입 (OPEN)      -> the first one: COPY_MARGIN_USD (1 $) of margin at the trader's leverage (capped at the
//                      venue's maximum). The trader's quantity sets the scale: each later buy gets
//                      1 $ x (its quantity / the first quantity) — 0.4 first = 1 $, then 0.4 = 1 $, 0.8 = 2 $
//                      (user 2026-11-13). A later 진입 card for a position already held is such a buy.
//  변경 (CHANGE)    -> an increase is a buy sized the same way (to - from); a decrease cuts the same share.
//  청산 (CLOSE)     -> with a quantity smaller than the trader's position: the same share; otherwise all.
//  모니터 시작       -> the monitor restarted: the 진입 cards within COPY_SNAPSHOT_MS re-announce positions
//                      it already had; they are not entered (no late entries).
// Safety kept (user's standing rules: stop protection, reduce-only exits, duplicate-order guard,
// kill switch): (updated 2026-11-13, see #zoneBroken) the exchange stop is the balance cap; the volume zone
// below is the soft exit: closed when a 15m candle closes beyond it on rising volume. Originally a stop at a VOLUME ZONE (user 2026-11-13:
// "매물대를 봐야"): beyond the first 1h/4h volume zone at least COPY_STOP_MIN_PCT (10 %) away from the
// entry — past where the trader's first adds usually fill (1.8 / 3.6 / 6.9 / 9.7 %), before the deep
// adds that made the big losses (13.9 % +) — and at most COPY_STOP_MAX_PCT (40 %). Without such a zone
// it falls back to the price where the loss would reach COPY_MAX_LOSS_PCT of the balance (25 %), which
// also stays a ceiling: the stop is never looser than that. Re-set after each change; an add that the
// free margin cannot carry is skipped; a symbol held by the signal strategy is not copied (one-way mode
// would merge the two positions); nothing is sent while the live executor is disarmed or stopped.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {atomicWriteStore,readStore} from './persistence.mjs';
import {placeMakerThenMarket,makerChildIds} from './maker_order.mjs';
import {roundDecimalToStep} from './decimal_grid.mjs';
import {confirmedBingxFills,summarizeBalancedFills} from './live_clients.mjs';
import {directionOf,venueRows} from './venue_positions.mjs';
import {parseCopyMessage} from './copy_parser.mjs';
import {readPositionMode,leverageSideFor,positionSideFor,positionRow} from './bingx_position_mode.mjs';

export const COPY_DEFAULTS=Object.freeze({stops:false,backstopPct:50,sizing:'BALANCE_RATIO',traderBalanceUSD:20000,maxAdds:100,breakVolumeMult:1.5,stopMinPct:20,stopMaxPct:40,stopBufferPct:.3,marginUSD:1,firstMarginUSD:0.3,maxLossPct:25,snapshotMs:120000,maxLeverage:125,maxTotalMarginPct:100,ledgerLossPct:50,minOrderMaxMarginUSD:5});
const MAX_CLOSED=2000,MAX_EVENTS=200,MAX_SEEN=1000;
const AUDIT_MAX_AGE=135000,CLOSE_DELAY=120000;
const num=v=>{const n=Number(v);return Number.isFinite(n)?n:null};
const pos=v=>{const n=Number(v);return Number.isFinite(n)&&n>0?n:null};
const availableMargin=funds=>{const raw=funds?.available;return raw==null||String(raw).trim()===''?null:num(raw)};
const orderOf=d=>d?.order??d;
const venueSymbolOf=s=>s.replace(/USDT$/,'-USDT');
const orderReadCode=e=>/^(?:HTTP_\d{3}|VENUE_ERROR_\d{1,12}|NETWORK_UNREACHABLE|TIMEOUT|ETIMEDOUT|ECONNRESET|UNEXPECTED_OPEN_ORDERS(?:_SHAPE)?)$/.test(e?.code)?e.code:'LOOKUP_FAILED';

// Closes that were not ours (user decision 2026-11-17 "2,3번 둘다 적용시켜줘", fail-closed after review): only a
// close CONFIRMED as manual lets the trader's next add (late entry) or entry card be followed again. Every
// closeReason this file produces:
//  TRADER_CLOSE, TRADER_CUT_ALL   followed the trader (never block anyway)
//  COPY_LOSS_LIMIT                ledger loss cap (#emergency from reconcile)            ours: blocks
//  LOSS_CAP_REACHED, NO_STOP      emergency closes from #protect                          ours: blocks
//  ZONE_BREAK_VOLUME              our volume-zone exit (#emergency from reconcile)        ours: blocks
//  LIQUIDATION, ADL               BingX force order found for the window (#goneEvidence)  blocks
//  STOP_OR_EXTERNAL               reconcile found it gone twice in a row                  see below
//  POSITION_GONE                  gone when a card came (read twice, ~1 s apart)          see below
// The last two count as external only when (a) no close of ours was under way (p.closing), (b) the position
// carried no exchange stop of ours (no stopOrderId, no stop price — always so with COPY_STOPS off, the
// default), and (c) closeEvidence.kind is MANUAL_CLOSE: BingX showed no liquidation / ADL in the window and its
// order history showed a FILLED closing order whose clientOrderId is not ours ('cp…'). No such order, a
// failed query, or any other or unknown reason: ours / unconfirmed, keeps blocking until the trader closes.
export const EXTERNAL_CLOSE_REASONS=Object.freeze(['STOP_OR_EXTERNAL','POSITION_GONE']);
export function externalClose(p){return Boolean(p)&&!p.closing&&EXTERNAL_CLOSE_REASONS.includes(p.closeReason)&&!p.stopOrderId&&!(Number(p.stop)>0)&&p.closeEvidence?.kind==='MANUAL_CLOSE'}
/** The label key for a blocking close: EXTERNAL_UNCONFIRMED when it looked external but was not confirmed. */
export function closeLabelKey(p){return EXTERNAL_CLOSE_REASONS.includes(p?.closeReason)&&p?.closeEvidence?.kind==='UNCONFIRMED'?'EXTERNAL_UNCONFIRMED':p?.closeReason??null}
const CLOSE_KO={EXTERNAL_UNCONFIRMED:'바깥 청산 확인 불가',LIQUIDATION:'강제청산',ADL:'자동 감축(ADL)',COPY_LOSS_LIMIT:'카피 손실 한도',NO_STOP:'보호 손절 실패',LOSS_CAP_REACHED:'손실 한도 도달',ZONE_BREAK_VOLUME:'매물대 이탈',STOP_OR_EXTERNAL:'보호 손절 또는 외부 청산'};
// forceOrders / allOrders answers: an array, or {orders: array | null}. Any other shape throws (review 2026-11-17:
// an unknown shape must not read as "no liquidation"), so the close stays UNCONFIRMED and blocks.
function rowsOf(d){
 if(Array.isArray(d))return d;
 if(d&&typeof d==='object'&&Object.hasOwn(d,'orders')&&(Array.isArray(d.orders)||d.orders===null))return d.orders||[];
 throw Object.assign(Error('UNEXPECTED_HISTORY_SHAPE'),{code:'UNEXPECTED_HISTORY_SHAPE'});
}
function checkedPositions(data,symbol=null){
 const rows=venueRows(data);
 if(!rows||rows.some(r=>typeof r?.symbol!=='string'||!r.symbol||(!symbol||r.symbol===symbol)&&
  !((typeof r.positionAmt==='number'||typeof r.positionAmt==='string')&&String(r.positionAmt).trim()&&Number.isFinite(Number(r.positionAmt)))))
  throw Object.assign(Error('UNEXPECTED_POSITION_RESPONSE'),{code:'UNEXPECTED_POSITION_RESPONSE'});
 return rows;
}
const sameSize=(a,b)=>Math.abs(a-b)<=Math.max(1e-10,Math.max(Math.abs(a),Math.abs(b))*1e-8);
const settlementSource=p=>['EXCHANGE','EXCHANGE_FILLS'].includes(p.netSource);
// Closed rows reviewed in the 2026-11-18 17:37 KST operating report.
// Keep them in the ledger for trade attribution and re-entry checks.
const ARCHIVE_COPY_CLOSES=new Set([
 1794627081316,1794648129144,1794648241304,1794648375377,
 1794648499079,1794648592768,1794648763743,1794657832600,
 1794667581540,1794677025315,1794708252960,1794727616903,
 1794732646060,1794829087365,1794838467159,1794840032182,
 1794841683171,1794875187966,1794886481680,1794887049051,
 1794889578744,1794890953865,
]);
// A request that got no answer from the venue (user 2026-11-17 "3번"): connection failure or timeout. A venue
// error code (VENUE_ERROR_*, HTTP_*) is an answer and is never retried by #send.
export function noVenueAnswer(e){return ['NETWORK_UNREACHABLE','TIMEOUT','ETIMEDOUT','ECONNRESET'].includes(e?.code)||['AbortError','TimeoutError'].includes(e?.name)}
// BingX "order does not exist" for a lookup by clientOrderId (the only answer that proves the order is absent).
const orderAbsent=e=>/80016/.test(String(e?.code||''))||/not exist/i.test(String(e?.message||''));

/** BingX contract for a channel symbol: the same name, a 1000-coin contract (1000PEPEUSDT), or a stock
 * perpetual (SNDKUSDT -> NCSKSNDK2USD-USDT). contracts: Map(symbol -> normalized contract). */
export function resolveCopyContract(contracts,symbol){
 if(!contracts?.get)return null;
 const hit=contracts.get(symbol);if(hit)return hit;
 const base=String(symbol).replace(/USDT$/,'');
 const k=contracts.get('1000'+symbol);if(k)return {...k,unitMultiplier:1000,alias:k.symbol};
 const re=new RegExp('^NCS[A-Z]?'+base.replace(/[^A-Z0-9]/g,'')+'\\d*USDUSDT$');
 for(const [key,c] of contracts)if(re.test(key))return {...c,alias:key};
 return null;
}
// Real money (user 2026-11-14, "실계좌, 지금 설정 그대로"): only with COPY_MODE=LIVE and
// COPY_LIVE_CONFIRM=REAL_MONEY_COPY in the server's .env (set by the user), on its own BingX live client,
// independent of the signal strategy (which stays on the testnet). Starts disarmed after every restart;
// the copy arm button (or POST /api/copy/arm) turns it on.
export const COPY_LIVE_PHRASE='REAL_MONEY_COPY';
export function copyConfig(env=process.env,liveMode='OFF'){
 const n=(k,d,lo,hi)=>{const v=Number(env[k]);return Number.isFinite(v)&&v>=lo&&v<=hi?v:d};
 // Real-money copying requires an explicit confirmation. COPY_TRADING=off turns copying off.
 const mode=String(env.COPY_MODE||'').toUpperCase()==='LIVE'&&env.COPY_LIVE_CONFIRM===COPY_LIVE_PHRASE?'LIVE':liveMode==='TESTNET'?'TESTNET':'OFF';
 const enabled=String(env.COPY_TRADING||'').toLowerCase()!=='off'&&mode!=='OFF';
 // Live orders always size from current available margin. Fixed first-margin modes remain available on testnet.
 const sz=String(env.COPY_SIZING||'').trim().toUpperCase();
 const sizing=mode!=='LIVE'&&['MIN_ORDER','FIRST_1USD'].includes(sz)?sz:COPY_DEFAULTS.sizing;
 return {enabled,mode,sizing,traderBalanceUSD:n('COPY_TRADER_BALANCE_USD',COPY_DEFAULTS.traderBalanceUSD,100,1e9),marginUSD:n('COPY_MARGIN_USD',COPY_DEFAULTS.marginUSD,.1,1000),
  // MIN_ORDER's first buy is at least this much margin (user 2026-11-14: BTC/ETH minimums were too small); 0 = the bare minimum.
  firstMarginUSD:n('COPY_FIRST_MARGIN_USD',COPY_DEFAULTS.firstMarginUSD,0,1000),maxLossPct:n('COPY_MAX_LOSS_PCT',COPY_DEFAULTS.maxLossPct,1,90),
  snapshotMs:n('COPY_SNAPSHOT_MS',COPY_DEFAULTS.snapshotMs,0,3600000),maxLeverage:n('COPY_MAX_LEVERAGE',COPY_DEFAULTS.maxLeverage,1,125),
  // All copy positions together: margin at most this share of the equity (adds beyond it skipped), and
  // when their open loss reaches COPY_LEDGER_LOSS_PCT of the equity everything is closed and copying stops.
  // Up to COPY_MAX_ADDS adds are followed (user 2026-11-13: 10; 2026-11-14: as many as possible, 100); the position is closed when the price
  // closes beyond the stop zone on a 15m candle whose volume is COPY_BREAK_VOLUME_MULT x its 20-candle average.
  // COPY_STOPS=on brings back the exchange backstop and the volume-zone exit. Off by default (user
  // 2026-11-13, testnet: "손절라인을 없애보자"): the copy follows the trader's own exits; only the ledger
  // loss limit (COPY_LEDGER_LOSS_PCT) and the margin caps stay.
  stops:String(env.COPY_STOPS||'').toLowerCase()==='on',
  backstopPct:n('COPY_BACKSTOP_PCT',COPY_DEFAULTS.backstopPct,5,90),
  maxAdds:n('COPY_MAX_ADDS',COPY_DEFAULTS.maxAdds,0,100),breakVolumeMult:n('COPY_BREAK_VOLUME_MULT',COPY_DEFAULTS.breakVolumeMult,1,10),
  stopMinPct:n('COPY_STOP_MIN_PCT',COPY_DEFAULTS.stopMinPct,.5,80),stopMaxPct:n('COPY_STOP_MAX_PCT',COPY_DEFAULTS.stopMaxPct,1,95),stopBufferPct:n('COPY_STOP_BUFFER_PCT',COPY_DEFAULTS.stopBufferPct,0,5),
  maxTotalMarginPct:n('COPY_MAX_TOTAL_MARGIN_PCT',COPY_DEFAULTS.maxTotalMarginPct,1,100),ledgerLossPct:n('COPY_LEDGER_LOSS_PCT',COPY_DEFAULTS.ledgerLossPct,1,90),
  // The venue-minimum bump may raise the first margin to at most this much (user 2026-11-14: start at 1 $).
  minOrderMaxMarginUSD:n('COPY_MIN_ORDER_MAX_MARGIN_USD',COPY_DEFAULTS.minOrderMaxMarginUSD,.1,1000),
  // Enter late when the trader adds to a position we missed (user 2026-11-14); COPY_LATE_ENTRY=off disables.
  lateEntry:!/^(off|0|false|no)$/i.test(String(env.COPY_LATE_ENTRY||'on')),
  // Instant MARKET execution by default for lowest copy latency; opt in to Post-Only maker-first via COPY_MAKER_FIRST=on or CopyControls UI.
  makerFirst:/^(on|1|true|yes)$/i.test(String(env.COPY_MAKER_FIRST??'off')),
  makerWaitMs:n('COPY_MAKER_WAIT_MS',1000,200,10000)};
}

export class CopyExecutor{
 #modeCache=null;
 #maxLevCache=new Map();
 #marginSetCache=new Map();
 #levSetCache=new Map();
 constructor({fileName='copy-store.json',config,client,contractOf,markOf=async()=>null,zonesOf=async()=>[],candlesOf=async()=>[],gate=()=>({ok:true}),breaker=()=>null,entryGateRevision=()=>null,isBusy=()=>false,balance=async()=>null,controls=null,directory=null,now=()=>Date.now(),log=()=>{},onEvent=()=>{},auditOrders=false,retryDelaysMs=[2000,5000],retryBudgetMs=30000,goneRecheckMs=1000,sleep=ms=>new Promise(r=>setTimeout(r,ms))}){
  Object.assign(this,{config,client,contractOf,markOf,zonesOf,candlesOf,gate,breaker,entryGateRevision,isBusy,balance,controls,now,log,onEvent,retryDelaysMs,retryBudgetMs,goneRecheckMs,sleep});
  this.file=directory?path.join(directory,fileName):null;
  const saved=this.file&&fs.existsSync(this.file)?readStore(this.file):null;
  this.store={positions:saved?.positions||{},closed:saved?.closed||[],events:saved?.events||[],seen:saved?.seen||[],monitorStartAt:saved?.monitorStartAt||0,lastMsgAt:saved?.lastMsgAt||{},lastTraderCloseAt:saved?.lastTraderCloseAt||{},leverageOf:saved?.leverageOf||{},pending:saved?.pending||[],deferredEntries:Array.isArray(saved?.deferredEntries)?saved.deferredEntries:[],killed:saved?.killed||false,userPaused:saved?.userPaused===true};
  // An order in flight does not survive a restart.
  for(const p of Object.values(this.store.positions))delete p.inflight;
  this.queue=Promise.resolve();this.reserved=new Set();this.armed=false;this.entryRevision=0;this.settling=null;this.settleAttempts=new Map();
  this.audit=auditOrders?{positionAt:null,checkedAt:null,error:null,lanes:new Map()}:null;
  const archive=config.mode==='LIVE'?this.store.closed.filter(p=>ARCHIVE_COPY_CLOSES.has(p.closedAt)&&!p.archivedFromHistory&&!settlementSource(p)):[];
  if(archive.length){
   for(const p of archive)p.archivedFromHistory=true;
   try{this.#save()}catch(e){
    for(const p of archive)delete p.archivedFromHistory;
    this.log('[COPY] history archive failed',e.message);
   }
  }
 }
 #effectiveSizing(){return this.controls?.effectiveSizing?.(this.config.sizing)??this.config.sizing}
 #effectiveMakerFirst(){
  const ctrlMode=this.controls?.effectiveExecutionMode?.(null);
  if(ctrlMode==='INSTANT')return false;
  if(ctrlMode==='MAKER_FIRST')return true;
  return this.config.makerFirst===true;
 }
 #effectiveTraderBalanceUSD(){return this.controls?this.controls.effectiveTraderBalanceUSD(this.config.traderBalanceUSD):this.config.traderBalanceUSD}
 #balanceRatio(funds){
  const equity=pos(funds?.equity),free=availableMargin(funds),live=this.config.mode==='LIVE';
  if(!equity||(live&&free===null))return {reason:'NO_BALANCE'};
  if(live&&free<=0)return {reason:'MARGIN_SHORT'};
  return {scale:(live?free:equity)/this.#effectiveTraderBalanceUSD()};
 }
 #effectiveMaxLeverage(){return this.controls?this.controls.effectiveMaxLeverage(this.config.maxLeverage):this.config.maxLeverage}
 async #readPositionModeCached(){
  const now=this.now();
  if(this.#modeCache&&now-this.#modeCache.at<60000)return {ok:true,hedge:this.#modeCache.hedge};
  const mode=await readPositionMode(this.client);
  if(mode.ok)this.#modeCache={hedge:mode.hedge,at:this.now()};
  return mode;
 }
 async #readMaxLeverage(venueSymbol){
  const now=this.now(),cached=this.#maxLevCache.get(venueSymbol);
  if(cached&&now-cached.at<600000)return cached.info;
  try{
   const info=await this.client.leverage(venueSymbol);
   if(info)this.#maxLevCache.set(venueSymbol,{info,at:this.now()});
   return info;
  }catch{return null}
 }
 clearVenueCache(venueSymbol=null){
  if(!venueSymbol){
   this.#modeCache=null;this.#maxLevCache.clear();this.#marginSetCache.clear();this.#levSetCache.clear();
   return;
  }
  this.#modeCache=null;
  this.#maxLevCache.delete(venueSymbol);
  this.#marginSetCache.delete(venueSymbol);
  for(const k of this.#levSetCache.keys())if(k.startsWith(venueSymbol+'|'))this.#levSetCache.delete(k);
 }
 async warmCache(){
  try{await this.#readPositionModeCached()}catch{}
 }
 async #readFunds({cache=false}={}){
  const b=await this.balance().catch(()=>null);
  if(b)this.funds={equity:b.equity==null?null:num(b.equity),available:availableMargin(b),at:cache?this.now():(this.funds?.at??0)};
  return b;
 }
 #checkCooldown(){
  if(!this.controls)return;
  const r=this.controls.evaluateCooldown({closedTrades:this.store.closed,equityUSD:this.funds?.equity??null,now:this.now()});
  if(r?.triggered)this.#event('COPY_COOLDOWN_TRIGGERED',{reason:r.reason,until:r.until,minutes:r.minutes,detail:`${r.reason} · ${r.minutes}분간 신규 진입 휴식`});
 }
 /** The real-account daily loss circuit breaker (real_safety.mjs, server option `breaker`): a reason string while
  * tripped, else null. New entries and adds are refused while it holds (closes and cuts never ask the gate). */
 breakerReason(){let b;try{b=this.breaker?.()}catch{b='DAILY_LOSS_CIRCUIT_BREAKER'}return b?(typeof b==='string'?b:b.reason||'DAILY_LOSS_CIRCUIT_BREAKER'):null}
 /** Entry / add gate: the breaker first, then the server gate (kill switch, update, armed). */
 #gate(){const b=this.breakerReason();if(b)return {ok:false,reason:b};return this.gate()}
 /** Arming is refused while the daily loss breaker holds (screen, Telegram /resume, post-update re-arm). */
 arm(){
  const b=this.breakerReason();
  if(b)throw Object.assign(Error('오늘 실계좌 일일 손실 차단이 발동 중이라 카피를 켤 수 없습니다'),{code:b,httpStatus:409});
  this.armed=true;if(this.store.userPaused){this.store.userPaused=false;try{this.#save()}catch{}}
  this.#event('ARMED',{mode:this.config.mode});if(this.config.mode==='LIVE')void this.warmCache();return this.status()}
 /** user:true = paused by the user (screen button or Telegram /pause): kept on disk so an update restart does not
  * switch it back on (2026-11-23 audit). Other disarms (breaker, update) leave the flag as it is. */
 disarm({user=false}={}){this.entryRevision++;this.armed=false;if(user&&!this.store.userPaused){this.store.userPaused=true;try{this.#save()}catch{}}
  this.#event('DISARMED',{mode:this.config.mode,...(user?{by:'USER'}:{})});return this.status()}
 resetTestnetHistory(){
  if(this.config.mode==='LIVE')throw Object.assign(Error('NOT_TESTNET'),{code:'NOT_TESTNET',httpStatus:409});
  const removed=this.store.closed.length;
  this.store.closed=[];
  this.store.events=[];
  this.#save();
  return {removed};
 }
 #save(){if(!this.file)return;this.store.closed=this.store.closed.slice(-MAX_CLOSED);this.store.events=this.store.events.slice(-MAX_EVENTS);this.store.seen=this.store.seen.slice(-MAX_SEEN);
  fs.mkdirSync(path.dirname(this.file),{recursive:true});atomicWriteStore(this.file,{version:1,...this.store})}
 #event(type,detail={}){const cur=this.curMsg,e={type,at:this.now(),mode:this.config.mode,...(detail.symbol&&cur?.symbol===detail.symbol&&cur.direction?{direction:cur.direction}:{}),...detail};this.store.events.push(e);this.log(`[COPY] ${type} ${detail.symbol||''} ${detail.reason||''}`.trim());try{this.onEvent(e)}catch{}return e}
 /** Symbols the copy ledger holds (the signal strategy skips them). */
 heldSymbols(){const s=new Set(this.reserved);for(const sym of this.reserved)if(sym.endsWith('USDT')&&!sym.includes('-'))s.add(sym.replace(/USDT$/,'-USDT'));for(const p of Object.values(this.store.positions))if(p.status==='OPEN'){s.add(p.symbol);if(p.venueSymbol)s.add(p.venueSymbol);if(p.venueAlias)s.add(p.venueAlias)}return s}
 status(){const closed=this.store.closed.filter(p=>!p.archivedFromHistory);
  const sizing=this.#effectiveSizing(),traderBalanceUSD=this.#effectiveTraderBalanceUSD(),executionMode=this.#effectiveMakerFirst()?'MAKER_FIRST':'INSTANT';
  const basis=this.config.mode==='LIVE'?availableMargin(this.funds):pos(this.funds?.equity);
  const effectiveRatio=sizing==='BALANCE_RATIO'&&basis>0&&traderBalanceUSD>0?+(basis/traderBalanceUSD).toFixed(4):null;
  return {funds:this.funds??null,firstMarginUSD:this.config.firstMarginUSD,maxAdds:this.config.maxAdds,mode:this.config.mode,armed:this.armed,stops:this.config.stops,breakVolumeMult:this.config.breakVolumeMult,sizing,executionMode,traderBalanceUSD,effectiveRatio,maxLeverage:this.#effectiveMaxLeverage(),stopMinPct:this.config.stopMinPct,enabled:this.config.enabled,killed:this.store.killed,userPaused:this.store.userPaused===true,breaker:this.breakerReason(),pending:this.store.pending.length,deferredEntries:this.store.deferredEntries.length,maxTotalMarginPct:this.config.maxTotalMarginPct,ledgerLossPct:this.config.ledgerLossPct,marginUSD:this.config.marginUSD,maxLossPct:this.config.maxLossPct,positions:Object.values(this.store.positions),
  closed:closed.slice().reverse().map(p=>({...p,settlement:this.settlementStatus(p)})),closedTotal:closed.length,events:this.store.events.slice(-200).reverse(),monitorStartAt:this.store.monitorStartAt||null,
  ...(this.controls?{controls:this.controls.status(this.now())}:{}),
  ...(this.audit?{audit:this.auditStatus()}:{})}}

 /** status() with fresh numbers for the screen (user 2026-11-14: the real-account page did not update):
  * open positions' PnL from the venue's last price (cached tickers, ~20 s), the balance re-read when
  * older than 15 s. The reconcile (60 s) still owns the quantities and the loss limit. */
 async liveStatus(){
  const open=Object.values(this.store.positions).filter(p=>p.status==='OPEN'&&p.qty>0&&p.avg>0);
  await Promise.all(open.map(async p=>{try{const m=Number(await Promise.race([this.markOf(p.venueSymbol),new Promise(r=>setTimeout(()=>r(null),3000).unref?.())]));
   if(m>0){p.mark=m;p.unrealized=(p.direction==='LONG'?1:-1)*(m-p.avg)*p.qty;p.markAt=this.now()}}catch{}}));
  if(!this.funds||!(this.now()-(this.funds.at||0)<15000))await this.#readFunds({cache:true});
  return this.status();
 }
 /** One channel message ({id, date (ms), text}); processed one at a time, each id once. */
 handle(message){
  const entry={revision:this.entryRevision,gateRevision:this.entryGateRevision()};
  this.pendingCount=(this.pendingCount||0)+1;
  const p=this.queue.then(()=>this.#handle(message,entry)).finally(()=>{this.pendingCount--});
  this.queue=p.catch(()=>{});return p;
 }
 /** No message being processed (the update restart waits for this). */
 idle(){return !(this.pendingCount>0)}
 async #handle({id,date,text},entry){
  const key=String(id??createHash('sha1').update(String(text)).digest('hex'));
  if(this.store.seen.includes(key))return {ok:true,duplicate:true};
  const m=parseCopyMessage(text);
  this.store.seen.push(key);
  if(!m){this.#save();return {ok:true,ignored:true}}
  this.curMsg=m; // events of this message carry its direction (copy page failure list)
  const at=num(date)??this.now();
  this.curRaw={id:key,date:at,text};
  let lastMsgKey=null,prevLastMsgAt;
  try{
  if(m.kind==='MONITOR_START'){this.store.monitorStartAt=at;this.#event('MONITOR_START');this.#save();return {ok:true}}
  // Messages are retried for minutes when the server restarts, so they can arrive out of order: one older
  // than the last handled for the same coin and side is history (an old entry must not reopen a position the
  // trader has closed, an old close must not close a newer one).
  {const k=this.#key(m),last=this.store.lastMsgAt[k]||0;
   if(at<last){this.#event('SKIPPED',{symbol:m.symbol,reason:'STALE_MESSAGE',detail:`${Math.round((last-at)/1000)}초 앞선 메시지가 먼저 처리됨`});this.#save();return {ok:false,reason:'STALE_MESSAGE'}}
   lastMsgKey=k;prevLastMsgAt=this.store.lastMsgAt[k];
   this.store.lastMsgAt[k]=at;
   // The trader's closes (server time, like our closedAt): after our own close we follow again only once
   // the trader has closed that position too (an entry card can also be the trader adding to it).
   // ('- → x' means the trader had closed it before, even if we missed that card.)
   if(m.kind==='CLOSE'||(m.kind==='CHANGE'&&(m.to===0||m.from===0)))this.store.lastTraderCloseAt[k]=this.now()}
  if(!this.config.enabled){this.#event('SKIPPED',{symbol:m.symbol,reason:'COPY_OFF'});this.#save();return {ok:false,reason:'COPY_OFF'}}
  this.step=null;
  try{
   const r=m.kind==='OPEN'?await this.#open(m,at,entry):m.kind==='CHANGE'?await this.#change(m,at,entry):await this.#close(m,'TRADER_CLOSE');
   if(r?.deferred===true){
    const idx=this.store.seen.lastIndexOf(key);if(idx>=0)this.store.seen.splice(idx,1);
    if(lastMsgKey!==null){if(prevLastMsgAt===undefined)delete this.store.lastMsgAt[lastMsgKey];else this.store.lastMsgAt[lastMsgKey]=prevLastMsgAt}
   }
   // Our ledger may close this position just now (found gone on the venue): the trader's close comes after it.
   if(m.kind==='CLOSE'||(m.kind==='CHANGE'&&m.to===0))this.store.lastTraderCloseAt[this.#key(m)]=this.now();
   this.#save();return r;
  }catch(error){
   // The exchange's own message and the step that failed (user 2026-11-14: "VENUE_ERROR_109400" alone
   // could not tell a hedge-mode account from a bad leverage or quantity).
   const detail=[this.step&&`단계 ${this.step}`,error.code&&error.message&&error.message!==error.code&&`BingX: ${error.message}`].filter(Boolean).join(' · ').slice(0,200);
   this.#event('ERROR',{symbol:m.symbol,kind:m.kind,reason:error.code||error.message,...(this.step==='진입 주문'?{entry:true}:{}),...(detail?{detail}:{})});
   // A close or a cut that failed (e.g. rate limit) is tried again by the routine check; a late entry or add is not.
   const job=error.retryAs??m;if(job.kind==='CLOSE'||job.kind==='CHANGE'&&job.to<job.from)this.store.pending.push({m:job,at,tries:0,pid:this.store.positions[this.#key(job)]?.id??null});
   this.#save();return {ok:false,reason:error.code||error.message}}
  }finally{this.curMsg=null;this.curRaw=null}
 }
 #deferForUpdate(m){
  if(!this.curRaw)return false;
  const raw=this.curRaw,list=this.store.deferredEntries;
  if(!list.some(x=>x.id===raw.id)){
   list.push({id:raw.id,date:raw.date,text:raw.text,symbol:m.symbol,direction:m.direction,cardPrice:pos(m.price)??pos(m.entry)??null,queuedAt:this.now()});
   if(list.length>10)list.splice(0,list.length-10);
  }
  this.#event('DEFERRED_FOR_UPDATE',{symbol:m.symbol,direction:m.direction});
  return true;
 }
 /** Replay entry/add messages queued while an auto-update was in progress, checking age and price drift first. */
 async replayDeferred({maxAgeMs=120000,maxDriftPct=1.5}={}){
  const items=this.store.deferredEntries.splice(0);
  if(!items.length)return {replayed:0,skipped:0,results:[]};
  this.#save();
  let replayed=0,skipped=0;const results=[];
  for(const item of items){
   const age=this.now()-(Number(item.queuedAt)||0);
   if(age>maxAgeMs){
    this.#event('SKIPPED',{symbol:item.symbol,direction:item.direction,reason:'UPDATE_DEFERRED_EXPIRED',detail:`업데이트 대기 ${Math.round(age/1000)}초 경과 (한도 ${Math.round(maxAgeMs/1000)}초)`});
    skipped++;results.push({id:item.id,ok:false,reason:'UPDATE_DEFERRED_EXPIRED'});
    continue;
   }
   if(item.cardPrice>0){
    let venuePrice=null,mult=1;
    try{
     const c=await this.#contract(item.symbol);
     mult=Number(c?.unitMultiplier)||1;
     const vs=c?.venueSymbol||venueSymbolOf(item.symbol);
     venuePrice=await Promise.race([this.markOf(vs),new Promise(r=>setTimeout(()=>r(null),3000).unref?.())]).catch(()=>null);
    }catch{}
    if(venuePrice>0){
     const expected=item.cardPrice*mult;
     const driftPct=Math.abs(venuePrice-expected)/expected*100;
     if(driftPct>maxDriftPct){
      this.#event('SKIPPED',{symbol:item.symbol,direction:item.direction,reason:'UPDATE_DEFERRED_DRIFT',detail:`카드 ${expected} → 현재 ${venuePrice} (${driftPct.toFixed(2)}% 이탈, 한도 ${maxDriftPct}%)`});
      skipped++;results.push({id:item.id,ok:false,reason:'UPDATE_DEFERRED_DRIFT'});
      continue;
     }
    }
   }
   const r=await this.handle({id:item.id,date:item.date,text:item.text});
   replayed++;results.push({id:item.id,...r});
  }
  this.#save();
  return {replayed,skipped,results};
 }
 #key(m){return `${m.symbol}|${m.direction}`}
 async #contract(symbol){const c=await this.contractOf(symbol);if(!c||c.tradable===false)throw Object.assign(Error('NO_BINGX_CONTRACT'),{code:'NO_BINGX_CONTRACT'});return c}
 #qty(c,raw,mode='DOWN'){try{return Number(roundDecimalToStep(mode==='DOWN'?raw*(1+1e-9):raw,c.quantityStep,mode))}catch{return 0}} // 1e-9: 299.99999… is 300
 // Hedge mode (p.hedge, user 2026-11-17): the row of this position's own side; one-way: the symbol's row.
 async #position(p){
  const list=checkedPositions(await this.client.positions(p.venueSymbol),p.venueSymbol);
  const row=positionRow(list,p.venueSymbol,{hedge:p.hedge===true,direction:p.direction}),amt=row?Number(row.positionAmt):0;
  const size=Math.abs(amt);if(size>0)p.seenAt=this.now(); // the last confirmed state (#goneEvidence window)
  const unrealized=row?.unrealizedProfit;
  return {size,direction:directionOf(row),avg:pos(row?.avgPrice),mark:pos(row?.markPrice),unrealized:unrealized==null||String(unrealized).trim()===''?null:num(unrealized)}}
 auditStatus(){
  const a=this.audit;if(!a)return null;
  const positions=Object.values(this.store.positions).filter(p=>p.status==='OPEN'),now=this.now();
  const lanes=positions.map(p=>{
   const observed=a.lanes.get(p.id);
   const stale=observed?.verifiedAt==null||now-observed.verifiedAt>AUDIT_MAX_AGE;
   const blocked=Boolean(observed?.blocked||observed&&stale);
   return {symbol:p.symbol,direction:p.direction,expectedQty:p.auditQty??p.qty??null,venueQty:observed?.venueQty??null,
    stop:observed?.stop??'UNKNOWN',checkedAt:observed?.checkedAt??null,verifiedAt:observed?.verifiedAt??null,
    issues:observed?.issues??[],blocked,stale,...(observed?.ordersError?{ordersError:observed.ordersError}:{})};
  });
  const ready=a.positionAt!=null&&now-a.positionAt<=AUDIT_MAX_AGE;
  return {checkedAt:a.checkedAt,positionAt:a.positionAt,ready,error:a.error,lanes};
 }
 #auditBlock(symbol,venueSymbol){
  if(!this.audit)return null;
  const now=this.now(),a=this.audit;
  if(a.positionAt==null||now-a.positionAt>AUDIT_MAX_AGE)return 'COPY_AUDIT_UNAVAILABLE';
  for(const p of Object.values(this.store.positions)){
   if(p.status!=='OPEN'||p.symbol!==symbol&&p.venueSymbol!==venueSymbol)continue;
   const lane=a.lanes.get(p.id);
   if(lane&&(lane.blocked||lane.verifiedAt==null||now-lane.verifiedAt>AUDIT_MAX_AGE))return 'COPY_AUDIT_BLOCKED';
  }
  return null;
 }
 async #readOpenOrders(symbol){
  const data=await this.client.openOrders(symbol);
  let orders;
  try{orders=rowsOf(data)}catch{throw Object.assign(Error('UNEXPECTED_OPEN_ORDERS_SHAPE'),{code:'UNEXPECTED_OPEN_ORDERS_SHAPE'})}
  if(orders.some(o=>typeof o?.symbol!=='string'||!o.symbol||/\s/.test(o.symbol)||symbol&&o.symbol!==symbol||
   !(typeof o.orderId==='string'&&o.orderId.trim()||Number.isSafeInteger(o.orderId)&&o.orderId>0)))
   throw Object.assign(Error('UNEXPECTED_OPEN_ORDERS'),{code:'UNEXPECTED_OPEN_ORDERS'});
  return orders;
 }
 async #auditOpenOrders(symbol,allOrders=()=>this.#readOpenOrders()){
  const transient=e=>noVenueAnswer(e)||/^HTTP_5\d\d$/.test(String(e?.code||''));
  try{return {orders:await this.#readOpenOrders(symbol)}}
  catch(e){
   const scoped=orderReadCode(e);
   // The signed client already backs off and retries HTTP 429.
   if(scoped==='HTTP_429')return {orders:null,detail:`종목 조회 ${scoped}`};
   try{
    const orders=await allOrders();
    return {orders:orders.filter(o=>o.symbol===symbol)};
   }catch(fallback){
    if(transient(e)||transient(fallback)){
     await this.sleep(Math.min(400,this.goneRecheckMs??400));
     try{return {orders:await this.#readOpenOrders(symbol)}}catch{}
    }
    return {orders:null,detail:`종목 조회 ${scoped} · 계좌 조회 ${orderReadCode(fallback)}`};
   }
  }
 }
 #compareLane(p,qty,orders){
  const issues=[],expected=p.auditQty??pos(p.qty);
  if(p.closing){if(this.now()-p.closing.at>=CLOSE_DELAY)issues.push('CLOSE_DELAYED')}
  else if(!(qty>0))issues.push('POSITION_MISSING');
  else if(expected==null||!sameSize(qty,expected))issues.push('SIZE_MISMATCH');
  let stop=this.config.stops?'UNKNOWN':'OFF';
  if(orders===null)issues.push('ORDERS_UNREADABLE');
  const onSide=o=>!p.hedge||!o.positionSide||String(o.positionSide).toUpperCase()===p.direction;
  const opening=p.direction==='LONG'?'BUY':'SELL';
  if(orders?.some(o=>onSide(o)&&String(o.side).toUpperCase()===opening&&
   String(o.reduceOnly).toLowerCase()!=='true'&&String(o.closePosition).toLowerCase()!=='true'))issues.push('UNEXPECTED_OPEN_ORDER');
  if(orders&&this.config.stops&&qty>0){
   const o=p.stopOrderId==null?null:orders.find(o=>String(o.orderId)===String(p.stopOrderId));
   if(!o){stop='MISSING';issues.push('STOP_MISSING')}
   else{
    const full=String(o.closePosition).toLowerCase()==='true';
    const size=pos(o.quantity??o.origQty),side=String(o.side||'').toUpperCase(),lane=String(o.positionSide||'').toUpperCase();
    const expectedSide=p.direction==='LONG'?'SELL':'BUY',expectedLane=positionSideFor({hedge:p.hedge===true,direction:p.direction});
    const protectedSize=full||size!=null&&(size>qty||sameSize(size,qty))&&
     (p.hedge===true||o.closePosition==null||String(o.reduceOnly).toLowerCase()==='true');
    const trigger=pos(o.stopPrice),tick=pos(p.tickSize),priceOK=trigger!=null&&pos(p.stop)!=null&&(tick?Math.abs(trigger-p.stop)<tick*.51:sameSize(trigger,p.stop));
    const match=String(o.type).toUpperCase()==='STOP_MARKET'&&side===expectedSide&&(!lane||lane===expectedLane)&&
     !['FILLED','CANCELED','CANCELLED','EXPIRED','REJECTED','FAILED'].includes(String(o.status).toUpperCase())&&protectedSize&&priceOK;
    stop=match?'OK':'MISMATCH';if(!match)issues.push('STOP_MISMATCH');
   }
  }
  return {issues,stop,venueQty:qty};
 }
 async #auditReconcile(){
  const a=this.audit;if(!a)return;
  a.checkedAt=this.now();
  // Capture the managed state before I/O. Orders and stop prices can change while these reads are in flight.
  const open=Object.values(this.store.positions).filter(p=>p.status==='OPEN').map(p=>({p,qty:p.auditQty,seq:p.orderSeq,stop:p.stopOrderId,reduces:p.reduces,closing:p.closing}));
  let rows;
  try{rows=checkedPositions(await this.client.positions());a.positionAt=this.now();a.error=null}
  catch{a.error='POSITIONS_UNREADABLE';return}
  const symbols=[...new Set(open.map(({p})=>p.venueSymbol))];
  let allOrdersRead;
  const allOrders=()=>allOrdersRead??=this.#readOpenOrders();
  const reads=new Map(await Promise.all(symbols.map(async symbol=>[symbol,await this.#auditOpenOrders(symbol,allOrders)])));
  for(const {p,qty,seq,stop,reduces,closing} of open){
   if(p.status!=='OPEN'||this.store.positions[this.#key(p)]!==p||p.inflight||p.auditQty!==qty||p.orderSeq!==seq||
    p.stopOrderId!==stop||p.reduces!==reduces||p.closing!==closing)continue;
   const prior=a.lanes.get(p.id),now=this.now();
   let result;
   try{
    const row=positionRow(rows,p.venueSymbol,{hedge:p.hedge===true,direction:p.direction});
    const qty=row?Math.abs(Number(row.positionAmt)):0;
    const {orders,detail}=reads.get(p.venueSymbol);
    result=this.#compareLane(p,qty,orders);
    if(detail)result.ordersError=detail;
    if(qty>0&&directionOf(row)!==p.direction)result.issues.push('POSITION_SIDE_MISMATCH');
   }catch{result={issues:['POSITIONS_UNREADABLE'],stop:'UNKNOWN',venueQty:null}}
   const count=Object.fromEntries(result.issues.map(code=>[code,(prior?.count[code]??0)+1]));
   const blocked=result.issues.length>0&&(prior?.verifiedAt==null||prior?.blocked||Object.values(count).some(n=>n>=2));
   a.lanes.set(p.id,{...result,count,blocked,checkedAt:now,verifiedAt:result.issues.length?prior?.verifiedAt??null:now});
  }
  const ids=new Set(Object.values(this.store.positions).map(p=>p.id));for(const id of a.lanes.keys())if(!ids.has(id))a.lanes.delete(id);
 }
 /** A position read empty once is read again ~1 s later before it counts as gone (a venue list can come back
  * empty for a moment). */
 async #recheck(p,now){if(now.size>0)return now;await this.sleep(this.goneRecheckMs);return this.#position(p)}
 /** A new order tag: p.orderSeq goes up on every new order, failed ones included, so a later order never
  * reuses an earlier clientOrderId (review 2026-11-17). Retries of the same order keep its tag. */
 #tag(p,kind){p.orderSeq=(Number(p.orderSeq)||0)+1;return `${kind}.${p.orderSeq}`}
 #rememberFillOrder(p,id,side,confirmed=false,notice=null){
  if(id==null)return;
  const orderId=String(id);
  const prior=p.fillOrders?.find(o=>o.id===orderId);
  if(prior){prior.confirmed=prior.confirmed||confirmed;if(notice)prior.notice??=notice}
  else (p.fillOrders??=[]).push({id:orderId,side,confirmed,...(notice?{notice}:{})});
 }
 #fillNotice(p,tag){return this.config.mode==='LIVE'?{tag,from:Number(p.qty)||0,at:this.now()}:null}
 #notifyOrderReceipt(p,id){
  if(this.config.mode!=='LIVE'||id==null)return;
  this.#save();this.#event('ORDER_RECEIPT',{symbol:p.symbol,orderId:String(id)});
 }
 async #market(p,side,quantity,{reduceOnly=false,tag,beforeSend,maker=null}){
  this.step=/^open/.test(tag)?'진입 주문':'시장가 주문';
  const positionSide=positionSideFor({hedge:p.hedge===true,direction:p.direction});
  if(this.#effectiveMakerFirst()&&!reduceOnly&&maker?.markPrice>0&&pos(p.tickSize)){
   {const cid=this.#clientId(p,tag);if(!p.makerCids?.includes(cid)){(p.makerCids??=[]).push(cid);p.makerCids=p.makerCids.slice(-64)}}
   const r=await placeMakerThenMarket({
    client:this.client,symbol:p.venueSymbol,side,positionSide,quantity,
    quantityStep:maker.step??null,minQuantity:maker.minQty??0,tickSize:p.tickSize,
    markPrice:maker.markPrice,hedge:p.hedge===true,clientOrderId:this.#clientId(p,tag),
    waitMs:this.config.makerWaitMs??1000,pollMs:250,sleep:this.sleep,beforeSend,
   });
   const ids=[...new Set([r.makerOrderId,r.marketOrderId].filter(Boolean))];
   for(const id of ids){
    const isMain=id===r.orderId;
    const notice=this.#fillNotice(p,tag);
    if(isMain&&notice&&r.receipt&&String(r.receipt?.status).toUpperCase()==='FILLED'&&pos(r.receipt?.executedQty)&&pos(r.receipt?.avgPrice)){
     notice.receipt={orderId:r.receipt.orderId,symbol:r.receipt.symbol??p.venueSymbol,side:r.receipt.side??side,positionSide:r.receipt.positionSide??positionSide,
      status:r.receipt.status,executedQty:r.receipt.executedQty,avgPrice:r.receipt.avgPrice,updateTime:r.receipt.updateTime??r.receipt.updatedTime??r.receipt.filledTm,
      profit:r.receipt.realizedPnl??r.receipt.realizedPnL??r.receipt.profit,commission:r.receipt.fee??r.receipt.commission};
    }
    this.#rememberFillOrder(p,id,side,true,notice);
    this.#notifyOrderReceipt(p,id);
   }
   return {orderId:r.orderId??null,avg:r.avg??null,status:r.status??null,executedQty:pos(r.filledQty),executionMode:r.executionMode};
  }
  const params={symbol:p.venueSymbol,side,positionSide,type:'MARKET',quantity:String(quantity),clientOrderId:this.#clientId(p,tag)};
  // Hedge mode: no reduceOnly (BingX refuses it); the side and positionSide make it a close.
  if(reduceOnly&&p.hedge!==true)params.reduceOnly='true';
  const notice=this.#fillNotice(p,tag),res=orderOf(await this.client.placeOrder(params,{beforeSend}));
  if(notice&&String(res?.status).toUpperCase()==='FILLED'&&pos(res?.executedQty)&&pos(res?.avgPrice)){
   notice.receipt={orderId:res.orderId,symbol:res.symbol??params.symbol,side:res.side??side,positionSide:res.positionSide??params.positionSide,
    status:res.status,executedQty:res.executedQty,avgPrice:res.avgPrice,updateTime:res.updateTime??res.updatedTime??res.filledTm,
    profit:res.realizedPnl??res.realizedPnL??res.profit,commission:res.fee??res.commission};
  }
  this.#rememberFillOrder(p,res?.orderId,side,Number(res?.executedQty)>0||res?.status==='FILLED',notice);
  this.#notifyOrderReceipt(p,res?.orderId);
  return {orderId:res?.orderId??null,avg:pos(res?.avgPrice),status:res?.status??null,executedQty:pos(res?.executedQty)};
 }
 #clientId(p,tag){return ('cp'+createHash('sha256').update(p.id+'|'+tag).digest('hex')).slice(0,32)}
 /** Entry / add market order with a bounded retry when the request got no venue answer (user 2026-11-17: three
  * BTC adds lost to "BingX: fetch failed"): up to retryDelaysMs.length (2) more tries after ~2 s and ~5 s, with
  * the SAME clientOrderId, all within retryBudgetMs (~30 s; the message queue waits meanwhile). Before each resend:
  *  - the position must still be ours and open, copying not stopped (loss limit) and the gate open (kill
  *    switch, disarm); otherwise RETRY_ABANDONED and the error is thrown;
  *  - the order is looked up by clientOrderId: a fill -> taken as filled, nothing sent; resent only when BingX
  *    answers "order does not exist" (80016) AND the venue size has not moved by one quantity step. Anything
  *    else (lookup failed, size moved, no lookup call) -> not sent (an under-fill rather than a double fill).
  * A venue error code is never retried here. event: ENTRY_RETRY / ADD_RETRY. p.inflight marks it meanwhile. */
 async #send(p,side,quantity,{tag},{event,before,step,entry,marginUSD,funds,markPrice=null,minQty=0}){
  const margin=await this.#orderMargin(marginUSD,p.symbol,funds);
  const blocked=this.#sendBlock(p,entry),orderBlock=blocked?{reason:blocked}:margin;
  if(orderBlock)throw Object.assign(Error(orderBlock.reason),{code:orderBlock.reason,orderBlock});
  const cid=this.#clientId(p,tag),started=Date.now(),delays=Array.isArray(this.retryDelaysMs)?this.retryDelaysMs:[];
  if(event==='ENTRY_RETRY'){p.entryCids=[...(p.entryCids||[]),cid];this.#save()} // looked up again before the ledger drops or adopts it
  const maker=markPrice>0?{markPrice,step,minQty}:null;
  const sendMarket=async()=>{
   try{return await this.#market(p,side,quantity,{tag,beforeSend:()=>this.#sendBlock(p,entry),maker})}
   catch(e){
    if(e?.code==='ENTRY_NOT_SENT')throw Object.assign(Error(e.reason),{code:e.reason,orderBlock:{reason:e.reason}});
    throw e;
   }
  };
  let error;p.inflight=true;
  try{
   try{return await sendMarket()}catch(e){if(!noVenueAnswer(e))throw e;error=e}
   for(let i=0;i<delays.length;i++){
    const attempt=i+2,ev=(outcome,extra={})=>this.#event(event,{symbol:p.symbol,attempt,reason:error.code||error.name,outcome,...extra,clientOrderId:cid,
     detail:`${attempt}차 시도 · ${{ALREADY_FILLED:'앞 주문이 이미 체결됨(다시 보내지 않음)',UNVERIFIED:'체결 여부 확인 불가(보내지 않음)',RESENT:'같은 주문 번호로 다시 보냄',BUDGET:'재시도 시간 한도(약 30초) 초과'}[outcome]}`});
    if(Date.now()-started+delays[i]>this.retryBudgetMs){ev('BUDGET');break}
    await this.sleep(delays[i]);
    const margin=await this.#orderMargin(marginUSD,p.symbol);
    const seen=await this.#orderOutcome(p,cid,{before,step});
    if(seen.filled){this.#rememberFillOrder(p,seen.orderId,side,true,this.#fillNotice(p,tag));this.#notifyOrderReceipt(p,seen.orderId);ev('ALREADY_FILLED',{via:seen.via});return {orderId:seen.orderId??null,avg:seen.avg??null,qty:seen.qty??null}}
    if(!seen.absent){ev('UNVERIFIED',seen.why?{why:seen.why}:{});continue}
    const block=this.#sendBlock(p,entry)||margin?.reason;
    if(block){this.#event('RETRY_ABANDONED',{symbol:p.symbol,kind:event,attempt,reason:block,clientOrderId:cid,detail:`다시 보내기 전 상태 변경(${block}) — 보내지 않음`});
     throw Object.assign(Error('RETRY_ABANDONED'),{code:'RETRY_ABANDONED',cause:block})}
    if(Date.now()-started>this.retryBudgetMs){ev('BUDGET');break}
    ev('RESENT');
    try{return await sendMarket()}catch(e){if(!noVenueAnswer(e))throw e;error=e}
   }
   throw error;
  }finally{p.inflight=false}
 }
 /** Both account values must be present for the margin checks before an entry, add, or resend. */
 async #orderMargin(need,symbol=null,funds){
  if(!Number.isFinite(need)||need<=0)return {reason:'PRICE_UNVERIFIED'};
  if(funds===undefined)funds=await this.#readFunds();
  const equity=pos(funds?.equity),free=availableMargin(funds);
  if(!equity||free===null)return {reason:'NO_BALANCE'};
  const open=Object.values(this.store.positions).filter(p=>p.status==='OPEN');
  const used=open.reduce((total,p)=>total+(p.qty||0)*(p.avg||0)/(p.leverage||1),0);
  const remaining=equity*this.config.maxTotalMarginPct/100-used;
  if(need>remaining)return {reason:'COPY_MARGIN_CAP',need:+need.toFixed(2),free:+remaining.toFixed(2)};
  if(symbol&&this.controls){
   const symUsed=open.filter(p=>p.symbol===symbol).reduce((total,p)=>total+(p.qty||0)*(p.avg||0)/(p.leverage||1),0);
   const symBlock=this.controls.checkSymbolMargin({symbol,existingMarginUSD:symUsed,newMarginUSD:need,equityUSD:equity});
   if(symBlock)return symBlock;
  }
  if(need>free*.9)return {reason:'MARGIN_SHORT',need:+need.toFixed(2),free};
  return null;
 }
 #sendBlock(p,entry){
  if(this.store.positions[this.#key(p)]!==p||p.status!=='OPEN')return 'POSITION_NOT_OPEN';
  if(p.closing)return 'CLOSING';
  if(this.store.killed)return 'COPY_LOSS_LIMIT';
  let g;try{g=this.#gate()}catch{g={ok:false,reason:'GATE_ERROR'}}
  if(!g?.ok)return g?.reason||'GATE_CLOSED';
  if(entry.revision!==this.entryRevision||entry.gateRevision!==this.entryGateRevision())return 'ENTRY_INTERRUPTED';
  return this.#auditBlock(p.symbol,p.venueSymbol);
 }
 /** Did the order with this clientOrderId go through? {filled} / {absent} (BingX says it does not exist and the
  * position has not moved by a quantity step) / {} (cannot tell: never resent). */
 async #orderOutcome(p,clientOrderId,{before,step}){
  if(typeof this.client.getOrder!=='function')return {why:'NO_ORDER_LOOKUP'};
  // MAKER_FIRST sends child orders (cid[0..30]+'p' PostOnly, +'m' market remainder; audit C-2): all three are read.
  const seen=await this.#lookupFamily(p,clientOrderId);
  if(seen.filled)return {filled:true,via:'ORDER',orderId:seen.orderId,avg:seen.avg,qty:seen.qty};
  if(!seen.absent)return {why:seen.why};
  try{const now=await this.#position(p),moved=Math.abs(now.size-(Number(before)||0)),unit=pos(step)??0;
   return moved>=(unit>0?unit:1e-12)*(1-1e-9)?{why:'SIZE_MOVED'}:{absent:true}}
  catch(e){return {why:'POSITION_'+(e.code||'FAILED')}}
 }
 // Whole-position stop where the loss would reach maxLossPct of the balance; re-set after each change.
 // The new stop goes in first and the old one is cancelled after it, so the position is never left
 // without one (closePosition stops cover the whole position whatever its size). If the new stop
 // cannot be placed, the old one stays (the routine check tries again); with no stop at all — or a
 // stop price already passed — the position is closed at market.
 async #protect(p,{ownFill=false}={}){
  const now=await this.#position(p);
  p.qty=now.size;if(now.avg)p.avg=now.avg;
  if(this.audit&&ownFill&&now.size>0)p.auditQty=now.size;
  if(!this.config.stops){if(p.stopOrderId){try{await this.client.cancelOrder(p.venueSymbol,p.stopOrderId)}catch{}}p.stopOrderId=null;p.stop=null;p.stopStale=false;p.stopSource='NONE';
   return}
  if(!(p.qty>0))return;
  const bal=await this.#readFunds(),equity=pos(bal?.equity);
  const dir=p.direction==='LONG'?1:-1,avg=p.avg||now.mark;
  if(!avg){p.stopStale=true;this.#event('STOP_NOT_SET',{symbol:p.symbol,reason:'NO_PRICE'});return}
  // The exchange stop is a backstop (it works even if this server is down); the volume zone is the
  // exit the routine check acts on (break with rising volume, user 2026-11-13). Backstop = the tighter
  // of the balance cap (loss = maxLossPct of the equity) and COPY_BACKSTOP_PCT (50 %) from the average:
  // a small copy's balance cap can sit several times the price away, which the venue refuses (NO_STOP
  // seen on the testnet 2026-11-13). If the venue still refuses, closer distances are tried.
  const capDist=equity?(equity*this.config.maxLossPct/100)/p.qty/avg:Infinity;
  const tries=[...new Set([Math.min(capDist,this.config.backstopPct/100),.3,.2].filter(d=>d>0&&d<=Math.min(capDist,this.config.backstopPct/100)+1e-12))];
  if(!tries.length)tries.push(Math.min(capDist,.2));
  let last=null;
  for(const d of tries){
   const raw=dir===1?avg*(1-d):avg*(1+d);if(!(raw>0))continue;
   let stop;try{stop=Number(roundDecimalToStep(raw,p.tickSize,dir===1?'DOWN':'UP'))}catch{stop=raw}
   if(now.mark&&dir*(now.mark-stop)<=0){this.#event('STOP_NOT_SET',{symbol:p.symbol,reason:'LOSS_CAP_REACHED'});await this.#emergency(p,'LOSS_CAP_REACHED');return}
   // Same request shape as the signal strategy's whole-position stop (quantity + closePosition).
   const params={symbol:p.venueSymbol,side:dir===1?'SELL':'BUY',positionSide:positionSideFor({hedge:p.hedge===true,direction:p.direction}),type:'STOP_MARKET',quantity:String(p.qty),stopPrice:String(stop),closePosition:'true',workingType:'MARK_PRICE'};
   try{const res=orderOf(await this.client.placeOrder(params));const old=p.stopOrderId;
    p.stop=stop;p.stopDistPctActual=+(d*100).toFixed(1);p.stopSource=d===capDist?'BALANCE_CAP':'BACKSTOP';p.stopOrderId=res?.orderId??null;p.stopStale=false;
    this.#rememberFillOrder(p,p.stopOrderId,params.side);
    if(old&&old!==p.stopOrderId){try{await this.client.cancelOrder(p.venueSymbol,old)}catch{}}
    return}
   catch(error){last=error;if(error.code==='HTTP_429')break;
    // BingX allows one stop per position (VENUE_ERROR_110406 "a Stop Loss order already exists"): swap it —
    // cancel the old one and place the new one right away (3 tries); if that fails, the old price is put
    // back; if even that fails, the position is closed (never left without a stop).
    if(p.stopOrderId&&/110406/.test(String(error.code||error.message))){
     const oldId=p.stopOrderId,oldStop=p.stop;
     try{await this.client.cancelOrder(p.venueSymbol,oldId)}catch(e){last=e;break}
     p.stopOrderId=null;
     for(const [k,attempt] of [params,params,params,oldStop?{...params,stopPrice:String(oldStop)}:null].entries()){
      if(!attempt)continue;
      try{const res=orderOf(await this.client.placeOrder(attempt));
       if(k<3){p.stop=stop;p.stopDistPctActual=+(d*100).toFixed(1);p.stopSource=d===capDist?'BALANCE_CAP':'BACKSTOP';p.stopStale=false}else p.stopStale=true;
       p.stopOrderId=res?.orderId??null;this.#rememberFillOrder(p,p.stopOrderId,params.side);return}
      catch(e){last=e;if(k<2)await new Promise(r=>setTimeout(r,500*(k+1)))}
     }
     this.#event('STOP_NOT_SET',{symbol:p.symbol,reason:last?.code||last?.message||'UNKNOWN',detail:'stop swap failed'});await this.#emergency(p,'NO_STOP');return;
    }
   }
  }
  // Nothing placed. An old stop is never cancelled for this: it is a close-position stop, so it still
  // protects the whole (larger) position — kept, and the routine check tries again. (A venue that
  // refuses a second close-position stop is handled above by swapping.)
  p.stopStale=true;this.#event('STOP_NOT_SET',{symbol:p.symbol,reason:last?.code||last?.message||'UNKNOWN',detail:String(last?.message||'').slice(0,160)});
  if(!p.stopOrderId&&last?.code!=='HTTP_429')await this.#emergency(p,'NO_STOP');
 }
 /** The volume-zone stop for a new position (null: none fits). zones: [{priceLow, priceHigh}]. */
 zoneStop({direction,entry,zones}){
  const dir=direction==='LONG'?1:-1,min=this.config.stopMinPct/100,max=this.config.stopMaxPct/100,buf=this.config.stopBufferPct/100;
  const far=z=>dir===1?Number(z.priceLow):Number(z.priceHigh),near=z=>dir===1?Number(z.priceHigh):Number(z.priceLow);
  const against=(zones||[]).filter(z=>Number(z?.priceLow)>0&&Number(z?.priceHigh)>0&&dir*(entry-near(z))>0)
   .map(z=>({z,dist:dir*(entry-far(z))/entry})).filter(x=>x.dist>=min&&x.dist<=max).sort((a,b)=>a.dist-b.dist);
  if(!against.length)return null;
  const z=against[0].z;return {stop:far(z)*(1-dir*buf),zone:{priceLow:Number(z.priceLow),priceHigh:Number(z.priceHigh)},distPct:+(against[0].dist*100).toFixed(2)};
 }
 /** Close at market, reduce-only (loss limit, no stop, zone exit; it has no other retry path). The intent is
  * saved first (p.closing), so a close whose fill cannot be verified is still booked as ours later. Each attempt
  * re-reads the position and closes what is left; up to retryDelaysMs.length more attempts when an order or a
  * read got no venue answer; booked (#closed) only once the size reads 0. */
 async #emergency(p,reason){
  if(p.status!=='OPEN'||this.store.positions[this.#key(p)]!==p)return;
  if(!p.closing){p.closing={reason,at:this.now()};this.#save()}
  const delays=Array.isArray(this.retryDelaysMs)?this.retryDelaysMs:[],started=Date.now();let last=null,lastErr=null;
  p.inflight=true;
  try{
   for(let i=0;i<=delays.length;i++){
    if(i>0){
     if(Date.now()-started+delays[i-1]>this.retryBudgetMs)break;
     this.#event('CLOSE_RETRY',{symbol:p.symbol,attempt:i+1,reason:lastErr?.code||lastErr?.name||null,outcome:'RECHECK',detail:`${i+1}차 시도 · 포지션을 다시 읽고 남은 수량을 청산`});
     await this.sleep(delays[i-1]);
     if(p.status!=='OPEN'||this.store.positions[this.#key(p)]!==p){this.#event('RETRY_ABANDONED',{symbol:p.symbol,kind:'CLOSE_RETRY',attempt:i+1,reason:'POSITION_NOT_OPEN'});return}
    }
    let now;
    try{now=await this.#recheck(p,await this.#position(p))}catch(e){if(!noVenueAnswer(e)&&e.code!=='HTTP_429')throw e;lastErr=e;continue}
    if(!(now.size>0)){await this.#completeClose(p,p.closing.reason,last??now);return}
    last=now;
    try{await this.#market(p,p.direction==='LONG'?'SELL':'BUY',now.size,{reduceOnly:true,tag:this.#tag(p,'emergency')})}
    catch(e){if(!noVenueAnswer(e))throw e;lastErr=e;continue}
    // Answered: read again (a size still there is closed by the next attempt).
    let after=null;try{after=await this.#recheck(p,await this.#position(p))}catch(e){lastErr=e;continue}
    if(!(after.size>0)){await this.#completeClose(p,p.closing.reason,now);return}
    if(after.size<now.size){p.closing.partial=true;this.#save()}
   }
   this.#emergencyError(p,{reason:lastErr?.code||lastErr?.message||'NOT_CLOSED',detail:'긴급 청산 확인 실패 — 다음 정기 확인에서 다시 청산'});
  }catch(error){this.#emergencyError(p,{reason:error.code||error.message})}
  finally{p.inflight=false}
 }
 /** A failed emergency close: an ERROR event (screen, Telegram) at most once per position per 10 minutes; the
  * repeats in between are logged only (review 2026-11-17: a close the venue keeps refusing is retried every check). */
 #emergencyError(p,{reason,detail}){
  const at=this.now();
  if(p.emergencyNoticeAt!=null&&at-p.emergencyNoticeAt<600000){this.log(`[COPY] ERROR ${p.symbol} EMERGENCY_CLOSE ${reason} (repeat, notice held)`);return}
  p.emergencyNoticeAt=at;this.#event('ERROR',{symbol:p.symbol,kind:'EMERGENCY_CLOSE',reason,...(detail?{detail}:{})});
 }
 /** Did one of this position's entry orders fill? {filled, qty} / {absent} (every one "does not exist") / {}
  * (cannot tell: no lookup call, no recorded order, or a failed lookup). */
 async #entryFill(p){
  const cids=p.entryCids||[];if(!cids.length||typeof this.client.getOrder!=='function')return {};
  let absent=0;
  for(const clientOrderId of cids){
   const f=await this.#lookupFamily(p,clientOrderId);
   if(f.filled)return {filled:true,qty:f.qty,avg:f.avg};
   if(f.absent)absent++;
  }
  return absent===cids.length?{absent:true}:{};
 }
 /** One order id and its MAKER_FIRST children (maker_order.mjs makerChildIds): {filled, qty (summed), avg, orderId} /
  * {absent} (each one "does not exist" or finished without a fill) / {why} (cannot tell). */
 async #lookupFamily(p,clientOrderId){
  // Children only for ids sent through the maker-first path (p.makerCids), so a plain market id costs one lookup.
  const kids=makerChildIds(clientOrderId),ids=p.makerCids?.includes(clientOrderId)?[...new Set([clientOrderId,kids.limit,kids.market])]:[clientOrderId];
  let qty=0,cost=0,orderId=null,anyFill=false,absent=0,why=null;
  for(const id of ids){
   try{const o=orderOf(await this.client.getOrder(p.venueSymbol,{clientOrderId:id})),st=String(o?.status||'').toUpperCase(),exec=num(o?.executedQty)??0;
    if(o&&(exec>0||st==='FILLED'||st==='PARTIALLY_FILLED')){anyFill=true;orderId??=o.orderId??null;if(exec>0){qty+=exec;const a=pos(o.avgPrice);if(a)cost+=a*exec}continue}
    if(o&&['CANCELED','CANCELLED','EXPIRED','REJECTED','FAILED'].includes(st)){absent++;continue}
    why??='ORDER_STATE_'+(st||'UNKNOWN');
   }catch(e){if(orderAbsent(e))absent++;else why??='LOOKUP_'+(e.code||'FAILED')}
  }
  if(anyFill)return {filled:true,orderId,qty:qty>0?+qty.toFixed(12):null,avg:qty>0&&cost>0?+(cost/qty).toPrecision(10):null};
  return absent===ids.length?{absent:true}:{why:why??'UNKNOWN'};
 }
 /** Our last close of this coin and side that did not follow the trader, with no trader close since. Unless it
  * was a confirmed manual close (externalClose), entering again would undo it (review 2026-11-14 / 2026-11-17). */
 #lastOwnClose(m){
  const key=this.#key(m),own=[...this.store.closed].reverse().find(x=>`${x.symbol}|${x.direction}`===key);
  if(!own||['TRADER_CLOSE','TRADER_CUT_ALL'].includes(own.closeReason))return null;
  return (this.store.lastTraderCloseAt[key]||0)>=(own.closedAt||0)?null:own;
 }
 async #open(m,at,entry){
  const key=this.#key(m),prev=this.store.positions[key];
  if(prev?.status!=='OPEN'){const own=this.#lastOwnClose(m);if(own&&!externalClose(own)){this.#event('SKIPPED',{symbol:m.symbol,reason:'OUR_COPY_CLOSED',detail:`우리가 ${new Date(own.closedAt).toISOString().slice(11,16)}Z에 먼저 정리(${CLOSE_KO[closeLabelKey(own)]||closeLabelKey(own)}) · 트레이더 청산 뒤에 다시 따라감`,causeDetail:closeLabelKey(own)});return {ok:false,reason:'OUR_COPY_CLOSED'}}
   // A confirmed manual close (user 2026-11-17): followed again, marked on the entry.
   if(own)m={...m,refollow:true,refollowAfter:own.closeReason}}
  if(prev?.status==='OPEN'){
   // The same card again (both alert formats, or a repeat) is not a new buy: same entry price within 3 min.
   if(this.store.monitorStartAt&&at-this.store.monitorStartAt<this.config.snapshotMs)return {ok:true,snapshot:true};
   if(prev.lastTheirEntry===m.entry&&prev.lastTheirQty===m.quantity&&at-(prev.lastTheirAt||0)<180000)return {ok:true,already:true};
   if(!(m.quantity>0))return {ok:true,already:true};
   const prevSnap={e:prev.lastTheirEntry,q:prev.lastTheirQty,a:prev.lastTheirAt,t:prev.theirTotal};
   prev.lastTheirEntry=m.entry;prev.lastTheirQty=m.quantity;prev.lastTheirAt=at;
   // The trader's total follows the trader, whether or not our buy goes through.
   if(prev.theirTotal>0)prev.theirTotal+=m.quantity;
   const res=await this.#buyMore(prev,m,m.quantity,{price:pos(m.price)??pos(m.entry),entry});
   if(res?.deferred){prev.lastTheirEntry=prevSnap.e;prev.lastTheirQty=prevSnap.q;prev.lastTheirAt=prevSnap.a;prev.theirTotal=prevSnap.t}
   return res;
  }
  if(this.store.monitorStartAt&&at-this.store.monitorStartAt<this.config.snapshotMs){this.#event('SKIPPED',{symbol:m.symbol,reason:'MONITOR_RESTART_SNAPSHOT'});return {ok:false,reason:'SNAPSHOT'}}
  const g=this.#gate();if(!g.ok){if(g.reason==='UPDATING'&&this.#deferForUpdate(m))return {ok:false,reason:'UPDATING',deferred:true};this.#event('SKIPPED',{symbol:m.symbol,reason:g.reason});return {ok:false,reason:g.reason}}
  const symBlock=this.controls?.checkSymbol(m.symbol);if(symBlock){this.#event('SKIPPED',{symbol:m.symbol,...symBlock});return {ok:false,reason:symBlock.reason}}
  const cooldown=this.controls?.checkCooldown(this.now());if(cooldown){this.#event('SKIPPED',{symbol:m.symbol,...cooldown});return {ok:false,reason:cooldown.reason}}
  const audit=this.#auditBlock(m.symbol);if(audit){this.#event('SKIPPED',{symbol:m.symbol,reason:audit});return {ok:false,reason:audit}}
  if(this.isBusy(m.symbol)){this.#event('SKIPPED',{symbol:m.symbol,reason:'SYMBOL_HELD_BY_SIGNAL_STRATEGY'});return {ok:false,reason:'SYMBOL_BUSY'}}
  // Our copy of the other side of this coin: one-way mode would merge the two. A copy opened in hedge mode
  // (user 2026-11-17) is a separate venue position, so the other side may be copied too (the account cannot
  // leave hedge mode while it is open; the venue check below reads the mode again).
  if(Object.values(this.store.positions).some(p=>p.status==='OPEN'&&p.symbol===m.symbol&&p.hedge!==true)){this.#event('SKIPPED',{symbol:m.symbol,reason:'OPPOSITE_COPY_OPEN'});return {ok:false,reason:'SYMBOL_BUSY'}}
  if(this.store.killed){this.#event('SKIPPED',{symbol:m.symbol,reason:'COPY_LOSS_LIMIT'});return {ok:false,reason:'COPY_LOSS_LIMIT'}}
  // Reserved before the first venue call, so the signal strategy cannot enter the same symbol meanwhile.
  this.reserved.add(m.symbol);
  try{return await this.#openReserved(m,at,key,entry)}finally{this.reserved.delete(m.symbol)}
 }
 async #openReserved(m,at,key,entry){
  const execStart=performance.now();
  const c=await this.#contract(m.symbol),venueSymbol=c.venueSymbol||venueSymbolOf(m.symbol);
  // A '- → q' change has no leverage: the last one seen for the symbol (else 10).
  if(m.leverage)this.store.leverageOf[m.symbol]=m.leverage;
  const sizing=this.#effectiveSizing();
  // Run all independent read-only verification checks in parallel before any venue write (margin/leverage/order).
  this.step='거래소 사전 확인';
  const [venuePrice,levInfo,mode,rawPos,auditRes,funds]=await Promise.all([
   Promise.race([this.markOf(venueSymbol),new Promise(r=>setTimeout(()=>r(null),3000).unref?.())]).catch(()=>null),
   this.#readMaxLeverage(venueSymbol),
   this.#readPositionModeCached(),
   this.client.positions(venueSymbol).then(data=>({ok:true,data}),error=>({ok:false,error})),
   this.audit?this.#auditOpenOrders(venueSymbol):Promise.resolve(null),
   this.#readFunds(),
  ]);
  // The venue contract must be the same thing at the same price: card price x unit multiplier within
  // 10 % of the venue's last price (a stock perpetual or a 1000-coin contract that is something else, or a
  // contract that is not 1 share / 1000 coins, is refused). A contract found under another name is not
  // traded without that check.
  {const cardPrice=(pos(m.price)??pos(m.entry))*(Number(c.unitMultiplier)||1);
   if(!(venuePrice>0)){if(c.alias){this.#event('SKIPPED',{symbol:m.symbol,reason:'PRICE_UNVERIFIED'});return {ok:false,reason:'PRICE_UNVERIFIED'}}}
   else if(Math.abs(cardPrice/venuePrice-1)>.1){this.#event('SKIPPED',{symbol:m.symbol,reason:'PRICE_MISMATCH',detail:`카드 ${cardPrice} / 거래소 ${venuePrice}`});return {ok:false,reason:'PRICE_MISMATCH'}}}
  let leverage=Math.max(1,Math.min(Math.round(m.leverage||this.store.leverageOf[m.symbol]||10),this.#effectiveMaxLeverage()));
  {const maxL=Number((m.direction==='SHORT'?levInfo?.maxShortLeverage:levInfo?.maxLongLeverage)??levInfo?.maxLongLeverage??levInfo?.maxLeverage);if(maxL>0)leverage=Math.min(leverage,maxL)}
  // The account's position mode (one-way: positionSide BOTH; hedge: LONG / SHORT, user 2026-11-17), read
  // before every entry and kept on the position. Not readable or not stated: skipped before any setting or
  // order (never guessed: the wrong mode is refused by BingX with 109400, user 2026-11-14 AKEUSDT).
  this.step='포지션 모드 확인';
  if(!mode.ok){this.#event('SKIPPED',{symbol:m.symbol,reason:mode.reason,detail:mode.detail});return {ok:false,reason:mode.reason}}
  const hedge=mode.hedge;
  // Never add to a position already on the venue (a manual trade, or one the ledger lost): it would merge
  // with ours and the trader's close would then close it all (user 2026-11-14, BTC 0.005). Hedge mode: the
  // same side only (the other side is a separate position).
  this.step='거래소 포지션 확인';
  if(!rawPos.ok)throw rawPos.error;
  {const list=checkedPositions(rawPos.data,venueSymbol),row=positionRow(list,venueSymbol,{hedge,direction:m.direction}),size=row?Math.abs(Number(row.positionAmt)):0;
   if(size>0){this.#event('SKIPPED',{symbol:m.symbol,reason:'VENUE_POSITION_EXISTS',detail:`거래소에 이미 ${size} 보유`});return {ok:false,reason:'VENUE_POSITION_EXISTS'}}}
  if(this.audit){
   const {orders,detail}=auditRes||{orders:null};
   const expected=positionSideFor({hedge,direction:m.direction});
   const reason=this.#auditBlock(m.symbol,venueSymbol)??(!orders?'COPY_ORDERS_UNREADABLE':
    orders.some(o=>!hedge||!o.positionSide||String(o.positionSide).toUpperCase()===expected||String(o.positionSide).toUpperCase()==='BOTH')?'COPY_OPEN_ORDERS_EXIST':null);
   if(reason){this.#event('SKIPPED',{symbol:m.symbol,reason,...(detail?{detail}:{})});return {ok:false,reason}}
  }
  // Check gate & entry revision after parallel reads (e.g. if disarmed or kill-switched while awaiting balance/positions).
  {const preGate=this.#gate();
   if(!preGate?.ok){const reason=preGate?.reason||'GATE_CLOSED';this.#event('SKIPPED',{symbol:m.symbol,reason});return {ok:false,reason}}
   if(entry&&(entry.revision!==this.entryRevision||entry.gateRevision!==this.entryGateRevision())){this.#event('SKIPPED',{symbol:m.symbol,reason:'ENTRY_INTERRUPTED'});return {ok:false,reason:'ENTRY_INTERRUPTED'}}}
  // unitMultiplier: venue contract of 1000 coins (1000PEPE) -> quantities / 1000, prices x 1000.
  const mult=Number(c.unitMultiplier)||1,price=(pos(m.price)??pos(m.entry))*mult;
  // BALANCE_RATIO: scale = live available margin (or testnet equity) / trader's baseline, refreshed from exchange.
  let scale=null;
  if(sizing==='BALANCE_RATIO'){
   if(!(m.quantity>0))throw Object.assign(Error('TRADER_QUANTITY_MISSING'),{code:'TRADER_QUANTITY_MISSING'});
   const ratio=this.#balanceRatio(funds);
   if(ratio.reason){this.#event('SKIPPED',{symbol:m.symbol,reason:ratio.reason});return {ok:false,reason:ratio.reason}}
   scale=ratio.scale;
  }
  const minOnly=sizing==='MIN_ORDER';
  let qty=scale!=null?this.#qty(c,m.quantity*scale/mult):minOnly?this.#qty(c,this.config.firstMarginUSD*leverage/price):this.#qty(c,this.config.marginUSD*leverage/price);
  const minQ=pos(c.minQuantityBase)??0,minN=pos(c.minNotionalUSDT)??0;
  // Below the venue minimum: if BALANCE_RATIO shrank a small trader entry below the minimum (scale < 1),
  // match the trader's exact 1x quantity for this position and its adds instead of entering a tiny venue minimum.
  let minOrder=false,matchTraderQty=false;
  // The minimum is measured at the lower of the card and venue prices, with 5 % room: BingX checks it at
  // its own price, and a card price above it left the order under the minimum (user 2026-11-14, AKEUSDT
  // real account: "minimum order amount is 149 AKE" / "minimum order value is 2 USDT", five entries).
  const minPrice=venuePrice>0?Math.min(price,venuePrice):price;
  if(qty<minQ||qty*minPrice<minN){
   if(scale!=null&&scale<1&&m.quantity>0){
    scale=1;matchTraderQty=true;
    qty=this.#qty(c,m.quantity/mult);
   }
   if(qty<minQ||qty*minPrice<minN){qty=this.#qty(c,Math.max(minQ,minN/minPrice*1.05),'UP');minOrder=!minOnly}
  }
  // A 1x trader-quantity match (user decision 2026-11-23 (b)): its margin is capped at COPY_MIN_ORDER_MAX_MARGIN_USD
  // (5 $), measured at the higher of the card and venue prices; above it the entry is skipped.
  if(matchTraderQty&&!minOrder){const need=qty*Math.max(price,venuePrice||0)/leverage;
   if(need>this.config.minOrderMaxMarginUSD){this.#event('SKIPPED',{symbol:m.symbol,reason:'MATCH_TRADER_QTY_TOO_LARGE',need:+need.toFixed(2),cap:this.config.minOrderMaxMarginUSD,detail:`트레이더 1배 수량 증거금 $${need.toFixed(2)} > 한도 $${this.config.minOrderMaxMarginUSD}`});return {ok:false,reason:'MATCH_TRADER_QTY_TOO_LARGE'}}}
  if(minOnly&&qty*price/leverage>Math.max(this.config.minOrderMaxMarginUSD,this.config.firstMarginUSD*1.05)){this.#event('SKIPPED',{symbol:m.symbol,reason:'MIN_ORDER_TOO_LARGE',need:+(qty*price/leverage).toFixed(2)});return {ok:false,reason:'MIN_ORDER_TOO_LARGE'}}
  // The card's quantity must be coins: with a 마진 line, quantity x price must match margin x leverage
  // (within 30 %), else it may be a contract count and is not traded.
  if(scale!=null&&m.marginUSD>0&&m.leverage>0){const implied=m.quantity*(price/mult)/(m.marginUSD*m.leverage);
   if(implied<.7||implied>1.3)throw Object.assign(Error('QUANTITY_UNIT_UNCLEAR'),{code:'QUANTITY_UNIT_UNCLEAR'})}
  // A venue minimum far above the planned size (an expensive stock perp, a low leverage) is not taken.
  if(minOrder&&qty*price/leverage>this.config.minOrderMaxMarginUSD){this.#event('SKIPPED',{symbol:m.symbol,reason:'MIN_ORDER_TOO_LARGE',need:+(qty*price/leverage).toFixed(2)});return {ok:false,reason:'MIN_ORDER_TOO_LARGE'}}
  if(!(qty>0))throw Object.assign(Error('QUANTITY_INVALID'),{code:'QUANTITY_INVALID'});
  // Skip redundant setMarginType / setLeverage calls when already configured within 30 min; run both in parallel on first entry.
  const levSide=leverageSideFor({hedge,direction:m.direction});
  const levKey=`${venueSymbol}|${levSide}`;
  const setupNow=this.now();
  const needMargin=!(this.#marginSetCache.get(venueSymbol)>setupNow-1800000);
  const cachedLev=this.#levSetCache.get(levKey);
  const needLev=!(cachedLev&&cachedLev.leverage===leverage&&cachedLev.at>setupNow-1800000);
  if(needMargin||needLev){
   this.step=needLev?'레버리지 설정':'증거금 모드 설정';
   try{
    await Promise.all([
     needMargin?this.client.setMarginType(venueSymbol,'CROSSED').then(()=>{this.#marginSetCache.set(venueSymbol,this.now())},()=>{}):Promise.resolve(),
     needLev?this.client.setLeverage(venueSymbol,levSide,leverage).then(()=>{this.#levSetCache.set(levKey,{leverage,at:this.now()})}):Promise.resolve(),
    ]);
   }catch(e){
    if(/109400/.test(String(e?.code||e?.message||'')))this.clearVenueCache(venueSymbol);
    throw e;
   }
  }
  const p={id:`${key}|${at}`,symbol:m.symbol,venueSymbol,direction:m.direction,hedge,leverage,tickSize:c.tickSize,status:'OPEN',openedAt:this.now(),
   scale,mult,sizing,firstQty:qty,venueAlias:c.alias??null,minOrder,matchTraderQty,theirEntry:m.entry,theirQty:m.quantity??null,theirFirstQty:m.quantity??null,theirTotal:m.quantity??null,lastTheirEntry:m.entry??null,lastTheirQty:m.quantity??null,lastTheirAt:at,theirMarginUSD:m.marginUSD??null,qty:0,avg:null,adds:0,reduces:0,stop:null,stopOrderId:null,steps:[],fillTracked:true};
  // Only fetch 1h/4h volume zones when exchange/zone stops are actually enabled (saves 1.5~3.0s on default stops=off!).
  if(this.config.stops){
   try{const zones=await Promise.race([this.zonesOf(m.symbol,{tickSize:c.tickSize}),new Promise(r=>setTimeout(()=>r([]),3000).unref?.())]);
    const zs=this.zoneStop({direction:m.direction,entry:price/mult,zones});if(zs){p.zoneStop=zs.stop;p.stopZone=zs.zone;p.stopDistPct=zs.distPct}}catch{}
  }
  this.store.positions[key]=p;
  const skipBeforeSend=block=>{
   if(this.store.positions[key]===p)delete this.store.positions[key];
   this.#event('SKIPPED',{symbol:m.symbol,...block});
   return {ok:false,reason:block.reason};
  };
  const sendOpen=()=>this.#send(p,m.direction==='LONG'?'BUY':'SELL',qty,{tag:this.#tag(p,'open')},
   {event:'ENTRY_RETRY',before:0,step:c.quantityStep,entry,marginUSD:qty*Math.max(price,venuePrice||0)/leverage,funds,markPrice:venuePrice||price,minQty:pos(c.minQuantityBase)??0});
  let fill;
  // The venue position was checked empty above: before = 0 for the retry check.
  try{fill=await sendOpen()}
  catch(error){
   if(/109400/.test(String(error?.code||error?.message||'')))this.clearVenueCache(venueSymbol);
   if(error.orderBlock)return skipBeforeSend(error.orderBlock);
   // 101400 is a refusal (nothing filled). When it names the venue minimum, try 1x trader qty if BALANCE_RATIO
   // was scaled down (< 1), otherwise retry at the venue minimum if it still fits the margin limits.
   const need=error.code==='VENUE_ERROR_101400'?this.#venueMinimum(c,error.message,minPrice):null;
   const traderQty=need&&scale!=null&&scale<1&&m.quantity>0?this.#qty(c,m.quantity/mult):null;
   const retryMatch=traderQty!=null&&traderQty>=need;
   const retryQty=retryMatch?traderQty:need;
   // The same limits as the first order (5 $ minimum-order margin, the copy margin cap, 90 % of the free
   // margin), measured at the higher of the card and venue prices.
   const margin=retryQty?retryQty*Math.max(price,venuePrice||0)/leverage:Infinity;
   if(retryMatch&&retryQty>qty&&margin>this.config.minOrderMaxMarginUSD){
    if(this.store.positions[key]===p)delete this.store.positions[key];
    this.#event('SKIPPED',{symbol:m.symbol,reason:'MATCH_TRADER_QTY_TOO_LARGE',need:+margin.toFixed(2),cap:this.config.minOrderMaxMarginUSD,detail:`트레이더 1배 수량 증거금 $${margin.toFixed(2)} > 한도 $${this.config.minOrderMaxMarginUSD}`});
    return {ok:false,reason:'MATCH_TRADER_QTY_TOO_LARGE'};
   }
   if(retryQty>qty&&margin<=this.config.minOrderMaxMarginUSD){
    this.#event('ENTRY_RETRY_MIN',{symbol:m.symbol,from:qty,to:retryQty,...(retryMatch?{matchTraderQty:true}:{})});
    qty=retryQty;p.firstQty=retryQty;
    if(retryMatch){scale=1;p.scale=1;p.matchTraderQty=true;p.minOrder=false}
    else p.minOrder=true;
    try{fill=await sendOpen()}
    catch(e2){
     if(e2.orderBlock)return skipBeforeSend(e2.orderBlock);
     if(['VENUE_ERROR_101400','RETRY_ABANDONED'].includes(e2.code)&&this.store.positions[key]===p)delete this.store.positions[key];throw e2}}
   // RETRY_ABANDONED comes only after BingX said the order does not exist: nothing to keep either.
   else{if(['VENUE_ERROR_101400','RETRY_ABANDONED'].includes(error.code)&&this.store.positions[key]===p)delete this.store.positions[key];throw error}}
  p.steps.push({kind:'OPEN',at:this.now(),qty:pos(fill.executedQty)??qty,avg:fill.avg});this.#save(); // a real fill is on disk before anything else
  // Fast path: when stops are OFF and BingX already returned an exact FILLED receipt (qty + avg), skip redundant post-fill positions() read.
  if(!this.config.stops&&!p.stopOrderId&&String(fill.status).toUpperCase()==='FILLED'&&pos(fill.executedQty)&&pos(fill.avg)){
   p.qty=fill.executedQty;p.avg=fill.avg;p.stopSource='NONE';p.stopStale=false;
   if(this.audit)p.auditQty=fill.executedQty;
  }else{
   await this.#protect(p,{ownFill:true});
  }
  if(p.status!=='OPEN')return {ok:false,reason:p.closeReason};
  const execMs=Math.max(0,Math.round(performance.now()-execStart));
  this.#event('OPENED',{symbol:m.symbol,direction:m.direction,late:m.late===true,...(m.refollow?{refollow:true,refollowAfter:m.refollowAfter??null}:{}),leverage,qty:p.qty,avg:p.avg,stop:p.stop,stopSource:p.stopSource,stopDistPct:p.stopDistPct??null,scale:p.scale,minOrder:p.minOrder,matchTraderQty:p.matchTraderQty===true,execMs});
  return {ok:true,execMs};
 }
 /** The quantity a BingX 101400 message asks for ("minimum order amount is 149 AKE" / "minimum order
  * value is 2 USDT"), rounded up to the lot step; null when the message names neither. */
 #venueMinimum(c,message,price){
  // "amount is 5 USDT" is a value too. A value is turned into coins with 10 % room (the first order already had 5 %).
  const t=String(message||''),m=/minimum order (amount|value) is ([\d.]+)\s*([A-Za-z0-9]*)/i.exec(t);
  const isValue=m&&(m[1].toLowerCase()==='value'||/^USDT?$/i.test(m[3]));
  const raw=!m?NaN:isValue?(price>0?Number(m[2])/price*1.1:NaN):Number(m[2]);
  if(!(raw>0))return null;const q=this.#qty(c,raw,'UP');return q>0?q:null;
 }
 /** Why a change card finds no copy position (user 2026-11-14, AKEUSDT): the entry was skipped (its
  * reason), our copy was closed earlier (how), or no entry card for it reached us since the copy started. */
 #whyNotCopied(m,p){
  // Our own close of this coin and side (not one that followed the trader's close), with no trader entry
  // since: a late entry would undo it (a manual close, the loss limit, a stop). Checked before the events,
  // which are trimmed and can hold other skips in between.
  const own=this.#lastOwnClose(m);if(own&&!externalClose(own))return {cause:'OUR_COPY_CLOSED',causeAt:own.closedAt,causeDetail:closeLabelKey(own)};
  const ev=this.store.events,lastClose=p&&p.status!=='OPEN'&&p.closeReason!=='TRADER_CLOSE'?p.closedAt||0:0;
  // This coin and side only (events of the other side carry their own direction).
  for(let i=ev.length-1;i>=0;i--){const e=ev[i];if(e.symbol!==m.symbol||e.direction&&e.direction!==m.direction)continue;
   if(e.type==='OPENED'||own&&e.at<(own.closedAt||0))break;
   // An entry from a '- → q' change card is logged with kind CHANGE; its step says 진입 주문.
   if((e.type==='SKIPPED'&&e.reason!=='NOT_COPIED')||(e.type==='ERROR'&&(e.entry||e.kind==='OPEN'||/진입/.test(e.detail||''))))return {cause:e.reason||e.type,causeAt:e.at,causeDetail:e.detail??null}}
  // A confirmed manual close on the venue (user 2026-11-17): an add is followed again (late entry).
  if(own)return {cause:'COPY_CLOSED_EXTERNALLY',causeAt:own.closedAt,causeDetail:own.closeReason??null};
  if(lastClose)return {cause:externalClose(p)?'COPY_CLOSED_EXTERNALLY':'OUR_COPY_CLOSED',causeAt:lastClose,causeDetail:closeLabelKey(p)};
  return {cause:'NO_ENTRY_RECEIVED'};
 }
 async #change(m,at,entry){
  const execStart=performance.now();
  const key=this.#key(m),p=this.store.positions[key];
  if(m.to===0)return this.#close(m,'TRADER_CLOSE');
  if(m.from===0&&(!p||p.status!=='OPEN'))return this.#open({...m,kind:'OPEN',entry:m.price,leverage:m.leverage,quantity:m.to},at,entry);
  if(!p||p.status!=='OPEN'){
   const why=this.#whyNotCopied(m,p);
   // Late entry (user 2026-11-14): the trader adds to a position we never got into -> enter now as a new
   // position (the trader's current total is its "first" quantity). Not after our own close of it (a loss
   // limit or a stop must not be undone), and not on a reduction. After an external close (user 2026-11-17)
   // it is entered again (#open marks it refollow).
   if(this.config.lateEntry&&m.to>m.from&&why.cause!=='OUR_COPY_CLOSED'){
    if(why.cause!=='VENUE_POSITION_EXISTS')this.#event('LATE_ENTRY',{symbol:m.symbol,from:m.from,to:m.to,...why});
    return this.#open({...m,kind:'OPEN',entry:m.price,leverage:m.leverage,quantity:m.to,late:true},at,entry);
   }
   this.#event('SKIPPED',{symbol:m.symbol,reason:'NOT_COPIED',from:m.from,to:m.to,...why});return {ok:false,reason:'NOT_COPIED'}}
  if(p.closing){
   if(m.to>m.from)this.#event('ADD_SKIPPED',{symbol:m.symbol,reason:'CLOSING'});
   return {ok:false,reason:'CLOSING'};
  }
  const [c,firstPos]=await Promise.all([this.#contract(m.symbol),this.#position(p)]);
  const ratio=m.to/m.from,now=await this.#recheck(p,firstPos);p.qty=now.size;
  if(!(p.qty>0))return this.#gone(p,'POSITION_GONE',now);
  if(ratio>1){
   const prevTotal=p.theirTotal;
   p.theirTotal=m.to;
   const res=await this.#buyMore(p,m,m.to-m.from,{price:pos(m.price),ratio,c,now,entry,execStart});
   if(res?.deferred)p.theirTotal=prevTotal;
   return res;
  }else{
   if(p.theirTotal===m.to&&!p.pendingCut)return {ok:true,already:true};
   const samePending=p.pendingCut&&p.pendingCut.from===m.from&&p.pendingCut.to===m.to;
   const baseQty=samePending?p.pendingCut.beforeQty:p.qty;
   const down=this.#qty(c,baseQty*(1-ratio)),up=this.#qty(c,baseQty*(1-ratio),'UP'),want=baseQty*(1-ratio);
   const totalWantCut=Math.min(baseQty,want-down<=up-want?down:up);
   const targetLeft=Number(Math.max(0,baseQty-totalWantCut).toFixed(12));
   if(samePending&&p.qty<=targetLeft+1e-9){
    const filledCut=Number(Math.max(0,baseQty-p.qty).toFixed(12))||totalWantCut;
    delete p.pendingCut;
    p.theirTotal=m.to;
    p.reduces++;p.steps.push({kind:'REDUCE',at:this.now(),qty:filledCut,ratio});this.#save();
    if(!this.config.stops&&!p.stopOrderId){if(this.audit)p.auditQty=p.qty}
    else{try{await this.#protect(p,{ownFill:true})}catch(e){p.stopStale=true;this.#event('STOP_NOT_SET',{symbol:p.symbol,reason:e?.code||e?.message||'UNKNOWN'})}}
    const execMs=Math.max(0,Math.round(performance.now()-execStart));
    this.#event('REDUCED',{symbol:m.symbol,direction:p.direction,qty:filledCut,left:p.qty,execMs});
    return {ok:true,execMs};
   }
   const cut=samePending?Number(Math.max(0,p.qty-targetLeft).toFixed(12)):totalWantCut;
   if(!(cut>0))return {ok:true,tooSmall:true};
   if(cut>=p.qty)return this.#close(m,'TRADER_CUT_ALL');
   p.pendingCut={from:m.from,to:m.to,beforeQty:baseQty,wantCut:totalWantCut,targetLeft};this.#save();
   const order=await this.#market(p,p.direction==='LONG'?'SELL':'BUY',Math.min(cut,p.qty),{reduceOnly:true,tag:'cut'+(p.reduces+1)});
   const filledCut=pos(order?.executedQty)?Math.min(cut,order.executedQty):cut;
   p.qty=Number(Math.max(0,p.qty-filledCut).toFixed(12));
   delete p.pendingCut;
   p.theirTotal=m.to; // set after our cut went through, so a retried cut uses the same from / to
   p.reduces++;p.steps.push({kind:'REDUCE',at:this.now(),qty:filledCut,ratio});this.#save();
   if(!this.config.stops&&!p.stopOrderId&&String(order?.status).toUpperCase()==='FILLED'&&pos(order?.executedQty)){
    if(this.audit)p.auditQty=p.qty;
   }else{
    try{await this.#protect(p,{ownFill:true})}catch(e){p.stopStale=true;this.#event('STOP_NOT_SET',{symbol:p.symbol,reason:e?.code||e?.message||'UNKNOWN'})}
   }
   const execMs=Math.max(0,Math.round(performance.now()-execStart));
   this.#event('REDUCED',{symbol:m.symbol,direction:p.direction,qty:filledCut,left:p.qty,execMs});
   return {ok:true,execMs};
  }
 }
 // Copy only the quantity added by the trader, including for positions opened before live margin sizing.
 async #buyMore(p,m,theirQty,{price,ratio=null,c=null,now=null,entry,execStart=performance.now()}={}){
  if(!c||!now){
   const [cRes,posRes]=await Promise.all([c?Promise.resolve(c):this.#contract(p.symbol),now?Promise.resolve(now):this.#position(p)]);
   c=cRes;now=now??await this.#recheck(p,posRes);
  }
  p.qty=now.size;
  if(!(p.qty>0))return this.#gone(p,'POSITION_GONE',now);
  // A position we are closing (p.closing: loss limit, emergency) is never added to (review 2026-11-17).
  const g=p.closing?{ok:false,reason:'CLOSING'}:this.store.killed?{ok:false,reason:'COPY_LOSS_LIMIT'}:p.adds>=this.config.maxAdds?{ok:false,reason:'COPY_MAX_ADDS'}:this.#gate();
  if(!g.ok){if(g.reason==='UPDATING'&&this.#deferForUpdate({...m,symbol:p.symbol,direction:p.direction}))return {ok:false,reason:'UPDATING',deferred:true};this.#event(['COPY_MAX_ADDS','CLOSING'].includes(g.reason)?'ADD_SKIPPED':'SKIPPED',{symbol:p.symbol,reason:g.reason});return {ok:false,reason:g.reason}}
  const symBlock=this.controls?.checkSymbol(p.symbol);if(symBlock){this.#event('ADD_SKIPPED',{symbol:p.symbol,...symBlock});return {ok:false,reason:symBlock.reason}}
  price=price!=null?price*(p.mult||1):now.mark; // the message price is per coin; the venue price per contract unit
  const activeSizing=this.#effectiveSizing();
  // A 1x-matched entry's adds follow the normal balance ratio with carry-over (user decision 2026-11-23 (b)).
  const needFunds=p.matchTraderQty===true||activeSizing==='BALANCE_RATIO'&&(this.config.mode==='LIVE'||p.scale!=null);
  const auditPreReason=this.audit?this.#auditBlock(p.symbol,p.venueSymbol):null;
  const [checkedAudit,funds]=await Promise.all([
   this.audit&&!auditPreReason?this.#auditOpenOrders(p.venueSymbol):Promise.resolve(null),
   needFunds?this.#readFunds():Promise.resolve(undefined),
  ]);
  if(this.audit){
   let reason=auditPreReason,detail;
   if(!reason){
    detail=checkedAudit?.detail;
    const {issues}=this.#compareLane(p,now.size,checkedAudit?.orders??null);
    if(issues.length||!p.steps?.length||now.direction!==p.direction)reason=checkedAudit?.orders?'COPY_AUDIT_BLOCKED':'COPY_ORDERS_UNREADABLE';
   }
   if(reason){this.#event('ADD_SKIPPED',{symbol:p.symbol,reason,...(detail?{detail}:{})});return {ok:false,reason}}
  }
  if(!(price>0)){this.#event('ADD_SKIPPED',{symbol:p.symbol,reason:'PRICE_UNVERIFIED'});return {ok:false,reason:'PRICE_UNVERIFIED'}}
  let scale=p.scale;
  if(needFunds){
   const ratioRes=this.#balanceRatio(funds),reason=this.#sendBlock(p,entry)??ratioRes.reason;
   if(reason){this.#event('ADD_SKIPPED',{symbol:p.symbol,reason});return {ok:false,reason}}
   scale=ratioRes.scale;
   if(p.scale!=null||p.matchTraderQty)p.scale=scale;
  }
  // MIN_ORDER positions: our first quantity x their add / their first quantity (in venue units).
  const byFirst=scale==null&&p.sizing==='MIN_ORDER'&&p.firstQty>0&&p.theirFirstQty>0?p.firstQty*theirQty/p.theirFirstQty:null;
  const marginUSD=scale==null&&byFirst==null&&p.theirFirstQty>0?this.config.marginUSD*theirQty/p.theirFirstQty:null;
  const sized=scale!=null?theirQty*scale/(p.mult||1):byFirst??(marginUSD!=null?marginUSD*p.leverage/price:null);
  let buy;
  // Adds below the venue minimum are carried in venue units.
  if(sized!=null){const raw=sized+(p.addCarry||0),minQ=pos(c.minQuantityBase)??0,minN=pos(c.minNotionalUSDT)??0;
   buy=this.#qty(c,raw);if(!(buy>0)||buy<minQ||buy*price<minN){p.addCarry=raw;this.#event('ADD_CARRIED',{symbol:p.symbol,carry:+raw.toPrecision(6)});return {ok:true,carried:true}}
   p.addCarry=Math.max(0,raw-buy)}
  else{buy=this.#qty(c,p.qty*((ratio??((p.theirTotal+theirQty)/p.theirTotal))-1));if(!(buy>0))return {ok:true,tooSmall:true}}
  let fill;
  try{fill=await this.#send(p,p.direction==='LONG'?'BUY':'SELL',buy,{tag:this.#tag(p,'add')},
   {event:'ADD_RETRY',before:p.qty,step:c.quantityStep,entry,marginUSD:buy*Math.max(price,now.mark||0)/p.leverage,funds,markPrice:now.mark||price,minQty:pos(c.minQuantityBase)??0})}
  catch(e){
   if(!e.orderBlock)throw e;
   this.#event('ADD_SKIPPED',{symbol:p.symbol,...e.orderBlock});
   return {ok:false,reason:e.orderBlock.reason};
  }
  const prevQty=p.qty,prevAvg=p.avg;
  const addedQty=pos(fill.executedQty)??fill.qty??buy;
  p.adds++;
  p.steps.push({kind:'ADD',at:this.now(),qty:addedQty,avg:fill.avg,theirQty,marginUSD});this.#save();
  if(!this.config.stops&&!p.stopOrderId&&String(fill.status).toUpperCase()==='FILLED'&&pos(fill.executedQty)&&pos(fill.avg)){
   const newQty=Number((prevQty+fill.executedQty).toFixed(12));
   p.qty=newQty;
   if(prevQty>0&&prevAvg>0)p.avg=+((prevQty*prevAvg+fill.executedQty*fill.avg)/newQty).toPrecision(10);
   else p.avg=fill.avg;
   if(this.audit)p.auditQty=newQty;
  }else{
   await this.#protect(p,{ownFill:true});
  }
  if(p.status!=='OPEN')return {ok:false,reason:p.closeReason};
  const execMs=Math.max(0,Math.round(performance.now()-execStart));
  this.#event('ADDED',{symbol:p.symbol,direction:p.direction,qty:buy,total:p.qty,avg:p.avg,stop:p.stop,n:p.adds,marginUSD:marginUSD!=null?+marginUSD.toFixed(2):null,scale,matchTraderQty:p.matchTraderQty===true,execMs});
  return {ok:true,execMs};
 }
 async #close(m,reason){
  const execStart=performance.now();
  const key=this.#key(m),p=this.store.positions[key];
  if(!p||p.status!=='OPEN')return {ok:true,notOpen:true};
  // A 청산 card with a quantity below the trader's position is a partial close: the same share of ours.
  // Fixed from / to, so a retry after a failure cuts the same share.
  if(!p.closing&&m.kind==='CLOSE'&&m.quantity>0&&p.theirTotal>0&&m.quantity<p.theirTotal*.999){
   const cm={...m,kind:'CHANGE',from:p.theirTotal,to:p.theirTotal-m.quantity};
   try{return await this.#change(cm,this.now())}catch(error){error.retryAs=cm;throw error}}
  let now=await this.#recheck(p,await this.#position(p));
  if(!(now.size>0)){await this.#completeClose(p,p.closing?.reason??'POSITION_GONE',now,m.theirPnlUSD);return {ok:true}}
  p.qty=now.size;p.unrealized=now.unrealized;
  if(p.closing&&!['TRADER_CLOSE','TRADER_CUT_ALL'].includes(p.closing.reason))return {ok:false,reason:'CLOSE_PENDING'};
  const close=p.closing??={reason,at:this.now(),theirPnlUSD:m.theirPnlUSD??null};
  const side=p.direction==='LONG'?'SELL':'BUY';
  if(close.pending){
   if(now.size<close.pending.requestedQty&&!close.partial){close.partial=true;this.#save()}
   if(typeof this.client.getOrder!=='function')return {ok:false,reason:'CLOSE_PENDING'};
   try{
    const order=orderOf(await this.client.getOrder(p.venueSymbol,{clientOrderId:this.#clientId(p,close.pending.tag)}));
    const notice=this.#fillNotice(p,close.pending.tag);
    if(notice){notice.from=close.pending.requestedQty;notice.at=close.pending.at??close.at}
    this.#rememberFillOrder(p,order?.orderId,side,Number(order?.executedQty)>0||order?.status==='FILLED',notice);
    this.#notifyOrderReceipt(p,order?.orderId);
    if(!['FILLED','CANCELED','CANCELLED','REJECTED','EXPIRED','FAILED'].includes(String(order?.status).toUpperCase()))return {ok:false,reason:'CLOSE_PENDING'};
   }catch(error){if(!orderAbsent(error))return {ok:false,reason:'CLOSE_PENDING'}}
   delete close.pending;
   now=await this.#recheck(p,await this.#position(p));
   if(!(now.size>0)){await this.#completeClose(p,reason,now);return {ok:true}}
  }
  p.qty=now.size;
  const tag=this.#tag(p,'close');
  close.pending={tag,requestedQty:now.size,at:this.now()};this.#save();
  let order;
  try{order=await this.#market(p,side,now.size,{reduceOnly:true,tag})}
  catch(error){
   if(error.code==='HTTP_429'||(/^VENUE_ERROR_\d+$/.test(error.code||'')&&!/duplicate|exist/i.test(error.message||'')))delete close.pending;
   this.#save();throw error;
  }
  const ordStatus=String(order.status||'').toUpperCase();
  if(['FILLED','CANCELED','CANCELLED','REJECTED','EXPIRED','FAILED'].includes(ordStatus))delete close.pending;
  this.#save();
  // Fast close confirmation: if BingX already returned FILLED for the full closing quantity, skip extra position poll & 1s recheck sleep!
  if(ordStatus==='FILLED'&&pos(order.executedQty)&&sameSize(order.executedQty,now.size)){
   const execMs=Math.max(0,Math.round(performance.now()-execStart));
   await this.#completeClose(p,reason,now,null,execMs);
   return {ok:true,execMs};
  }
  const afterRaw=await this.#position(p);
  const after=ordStatus==='FILLED'&&!(afterRaw.size>0)?afterRaw:await this.#recheck(p,afterRaw);
  if(!(after.size>0)){
   const execMs=Math.max(0,Math.round(performance.now()-execStart));
   await this.#completeClose(p,reason,now,null,execMs);
   return {ok:true,execMs};
  }
  if(after.size<now.size)close.partial=true;
  p.qty=after.size;p.unrealized=after.unrealized;this.#save();
  this.#event('CLOSE_RETRY',{symbol:p.symbol,reason:'CLOSE_PENDING',detail:`청산 중 · 거래소 잔여 ${after.size}`});
  return {ok:false,reason:'CLOSE_PENDING'};
 }
 async #completeClose(p,reason,now,theirPnlUSD=null,execMs=null){
  if(p.stopOrderId){try{await this.client.cancelOrder(p.venueSymbol,p.stopOrderId)}catch{}}
  this.#closed(p,reason,now,p.closing?.theirPnlUSD??theirPnlUSD,execMs);
 }
 // Realized result: the venue's unrealized PnL just before the close (an estimate: fees not included).
 // A close of ours that was under way (p.closing) is booked under its own reason. Booked once per position; the
 // ledger slot is freed only when it still holds this position.
 #closed(p,reason,now,theirPnlUSD=null,execMs=null){
  if(this.store.closed.some(x=>x.id===p.id))return;
  reason=p.closing?.reason??reason;
  p.status='CLOSED';p.closedAt=this.now();p.closeReason=reason;delete p.inflight;
  const estimate=p.closing?.partial?null:now?.unrealized??null;
  const row={...p,netUSD:estimate,netSource:estimate!=null?'ESTIMATE_BEFORE_FEES':'UNKNOWN',theirPnlUSD};
  this.store.closed.push(row);const key=this.#key(p);if(this.store.positions[key]===p)delete this.store.positions[key];
  this.#event('CLOSED',{symbol:p.symbol,direction:p.direction,reason,netUSD:row.netUSD,theirPnlUSD,adds:p.adds,...(execMs!=null?{execMs}:{}),...(p.closeEvidence?{evidence:p.closeEvidence.kind}:{})});
  this.#checkCooldown();
 }
 /** Per-position exchange settlement by exact order id, run outside the order queue. */
 settlementStatus(p){
  const checkedAt=p.settlement?.checkedAt??p.settledAt??null;
  let state;
  if(settlementSource(p))state='CONFIRMED';
  else if(!(p.openedAt>0&&p.closedAt>=p.openedAt))state='MISSING_TIMESTAMPS';
  else if(!p.fillOrders?.length&&typeof this.client?.allOrders!=='function')state='NO_ORDER_IDS';
  else if(typeof this.client?.fillOrders!=='function'&&typeof this.client?.fillHistory!=='function')state='LOOKUP_UNAVAILABLE';
  else state=p.settlement?.state??'WAITING';
  return {state,checkedAt,...(p.settlement?.error?{error:p.settlement.error}:{})};
 }
 settle({limit=1,recheck=false}={}){
  if(this.settling)return this.settling;
  if(recheck)this.settleAttempts.clear();
  this.settling=this.#settleClosed(limit).finally(()=>{this.settling=null});
  return this.settling;
 }
 async #settleClosed(limit){
  const now=this.now();
  const due=this.store.closed.filter(p=>!p.archivedFromHistory&&now-p.closedAt>=15000&&!['CONFIRMED','MISSING_TIMESTAMPS','NO_ORDER_IDS','LOOKUP_UNAVAILABLE'].includes(this.settlementStatus(p).state));
  const valid=new Set(due.map(p=>p.id));
  for(const key of this.settleAttempts.keys())if(!valid.has(key))this.settleAttempts.delete(key);
  const batch=due.filter(p=>!this.settleAttempts.has(p.id)||now-this.settleAttempts.get(p.id)>=5*60000)
   .sort((a,b)=>(this.settleAttempts.get(a.id)??0)-(this.settleAttempts.get(b.id)??0)||b.closedAt-a.closedAt).slice(0,limit);
  for(const p of batch)await this.#settlePosition(p,now);
 }
 async #settlePosition(p,now){
   this.settleAttempts.set(p.id,now);
   const mark=(state,error=null)=>{if(this.store.closed.includes(p)){p.settlement={state,checkedAt:this.now(),...(error?{error}:{})};this.#save()}};
   try{
    const window={startTs:Math.max(1,p.openedAt-60000),endTs:Math.min(now,p.closedAt+30000)};
    let orders=new Map((p.fillOrders||[]).map(o=>[String(o.id),o]));
    if(p.closeEvidence?.orderId){const cid=String(p.closeEvidence.orderId);if(!orders.has(cid))orders.set(cid,{id:cid,side:p.direction==='LONG'?'SELL':'BUY',confirmed:false})}
    if(!p.fillTracked||new Set([...orders.values()].map(o=>o.side)).size<2)orders=await this.#legacyOrders(p,window);
    if(!orders.size){mark('ORDER_LINK_MISSING');return}
    if(orders.size>64){mark('ORDER_LIMIT');return}
    const raw=[];
    let historyLoaded=false,historyRows=null,historyError;
    const collect=async batch=>{
     if(!historyLoaded&&typeof this.client.fillHistory==='function'){
      historyLoaded=true;
      try{historyRows=await this.client.fillHistory({symbol:p.venueSymbol,...window})}catch(e){historyError=e}
     }
     let history=null;
     if(historyLoaded)try{
      if(historyError)throw historyError;
      history=await confirmedBingxFills(this.client,historyRows,{symbol:p.venueSymbol,orders:batch});
     }catch(e){if(typeof this.client.fillOrders!=='function')throw e}
     for(const [orderId,order] of batch){
      const isOwned=f=>f.orderId===orderId&&f.symbol===p.venueSymbol&&f.side===order.side&&f.at>=window.startTs&&f.at<=window.endTs;
      let owned=history?.filter(isOwned)??[];
      if(!owned.length&&typeof this.client.fillOrders==='function')try{
       const receipts=await confirmedBingxFills(this.client,await this.client.fillOrders({...window,orderId}),{symbol:p.venueSymbol,orders:new Map([[orderId,order]])});
       owned=receipts.filter(isOwned);
      }catch(e){if(history===null||order.confirmed)throw e}
      if(order.confirmed&&!owned.length||order.verifiedQty&&!sameSize(owned.reduce((total,f)=>total+f.qty,0),order.verifiedQty))return false;
      raw.push(...owned);
     }
     return true;
    };
    if(!await collect(orders)){mark('FILL_PENDING');return}
    const balanced=()=>{
     const totals={BUY:0,SELL:0};for(const f of raw)totals[f.side]+=f.qty;
     return totals.BUY>0&&totals.SELL>0&&sameSize(totals.BUY,totals.SELL);
    };
    if(raw.length&&!balanced()&&typeof this.client.allOrders==='function'){
     const recovered=await this.#legacyOrders(p,window,{externalClose:true});
     const additional=new Map([...recovered].filter(([id])=>!orders.has(id)));
     if(orders.size+additional.size>64){mark('ORDER_LIMIT');return}
     if(additional.size&&!await collect(additional)){mark('FILL_PENDING');return}
    }
    const fills=raw.sort((a,b)=>a.at-b.at||a.tradeId.length-b.tradeId.length||a.tradeId.localeCompare(b.tradeId));
    if(!fills.length){mark('FILL_PENDING');return}
    if(!balanced()){mark('QUANTITY_MISMATCH');return}
    const result=summarizeBalancedFills(fills,p.direction);
    if(!result){mark('INCOMPLETE_FILLS');return}
    if(!this.store.closed.includes(p))return;
    Object.assign(p,{netSource:'EXCHANGE_FILLS',netUSD:result.netUSD,pnlUSD:result.pnlUSD,feeUSD:result.feeUSD,settledAt:now});
    mark('CONFIRMED');
    this.#event('COPY_SETTLED',{symbol:p.symbol,direction:p.direction});
    this.#checkCooldown();
   }catch(error){mark('LOOKUP_FAILED',/^[A-Z_0-9]{1,48}$/.test(error?.code??error?.message??'')?(error.code??error.message):null);this.log(`[COPY] fill settlement ${error?.code||error?.message||'FAILED'}`)}
 }
 async #legacyOrders(p,{startTs,endTs},{externalClose=false}={}){
  const orders=new Map((p.fillOrders||[]).map(o=>[String(o.id),o]));
  if(p.closeEvidence?.orderId){const cid=String(p.closeEvidence.orderId);if(!orders.has(cid))orders.set(cid,{id:cid,side:p.direction==='LONG'?'SELL':'BUY',confirmed:false})}
  if(typeof this.client.allOrders!=='function')return orders;
  const openSide=p.direction==='LONG'?'BUY':'SELL',closeSide=openSide==='BUY'?'SELL':'BUY';
  const owned=new Set(p.entryCids||[]);
  owned.add(this.#clientId(p,'close'));
  owned.add(this.#clientId(p,'open'));owned.add(this.#clientId(p,'add'));
  for(let sequence=1;sequence<=Math.min(128,Number(p.orderSeq)||0);sequence++)
   for(const tag of ['open','add','close','emergency'])owned.add(this.#clientId(p,`${tag}.${sequence}`));
  for(let cut=1;cut<=Math.min(64,Number(p.reduces)||0);cut++)owned.add(this.#clientId(p,'cut'+cut));
  // MAKER_FIRST child orders of every id above (PostOnly 'p' and market remainder 'm').
  for(const id of [...owned]){const k=makerChildIds(id);owned.add(k.limit);owned.add(k.market)}
  const rows=rowsOf(await this.client.allOrders({symbol:p.venueSymbol,startTime:startTs,endTime:endTs,limit:500}));
  for(const row of rows){
   const id=row?.orderId==null?null:String(row.orderId),side=String(row?.side).toUpperCase();
   if(id&&(owned.has(String(row.clientOrderId).toLowerCase())||id===String(p.stopOrderId))&&[openSide,closeSide].includes(side)){
    orders.set(id,{id,side,confirmed:Number(row.executedQty)>0||String(row.status).toUpperCase()==='FILLED',order:{...row,symbol:row.symbol??p.venueSymbol}});
   }
  }
  // A manual full close can consist of several reductions between position polls. Only recover
  // additional orders if the complete history identifies the recorded exit and every opening belongs to this copy.
  const evidence=p.closeEvidence;
  if(!externalClose||rows.length>=500)return orders;
  const executed=rows.filter(row=>pos(row?.executedQty)||String(row?.status).toUpperCase()==='FILLED');
  const lane=p.hedge===true?p.direction:'BOTH',positionSide=row=>String(row.positionSide??'').toUpperCase();
  if(executed.some(row=>row.symbol!==p.venueSymbol||!['BOTH','LONG','SHORT'].includes(positionSide(row))||
   (p.hedge===true?positionSide(row)==='BOTH':positionSide(row)!=='BOTH')))return orders;
  const ownLane=executed.filter(row=>positionSide(row)===lane);
  if(evidence?.kind==='MANUAL_CLOSE'&&evidence.orderId&&ownLane.some(row=>String(row.orderId)===String(evidence.orderId)&&String(row.side).toUpperCase()===closeSide)){
   const extra=ownLane.filter(row=>!orders.has(String(row.orderId)));
   if(!extra.some(row=>!row.orderId||!pos(row.executedQty)||String(row.side).toUpperCase()!==closeSide||
    !(p.hedge===true||String(row.reduceOnly).toLowerCase()==='true'||String(row.closePosition).toLowerCase()==='true')||
    !(Number(row.updateTime??row.time)>=p.openedAt&&Number(row.updateTime??row.time)<=p.closedAt))){
    for(const row of extra){const id=String(row.orderId);orders.set(id,{id,side:closeSide,confirmed:true,verifiedQty:Number(row.executedQty),order:row})}
    return orders;
   }
  }
  // Isolated hedge-lane recovery: in hedge mode (positionSide LONG/SHORT), manual adds/closes on a copy-held position
  // live on that exact isolated lane. Recover all executed orders on the lane within [openedAt-5s, closedAt+10s] ONLY
  // when no other copy position of the same symbol+direction overlaps and open/close quantities balance cleanly.
  if(p.hedge===true&&orders.size>0){
   const overlap=[...Object.values(this.store.positions||{}),...(this.store.closed||[])].some(other=>
    other&&other!==p&&other.symbol===p.symbol&&other.direction===p.direction&&
    Number(other.openedAt)<=p.closedAt+10000&&(other.closedAt==null||Number(other.closedAt)>=p.openedAt-5000));
   if(!overlap){
    const inWin=ownLane.filter(row=>{
     const t=Number(row.updateTime??row.time);
     return row.orderId&&pos(row.executedQty)&&[openSide,closeSide].includes(String(row.side).toUpperCase())
      &&t>=p.openedAt-5000&&t<=p.closedAt+10000;
    });
    if(inWin.some(row=>orders.has(String(row.orderId)))){
     let oq=0,cq=0;
     for(const row of inWin){
      if(String(row.side).toUpperCase()===openSide)oq+=Number(row.executedQty);
      else cq+=Number(row.executedQty);
     }
     if(oq>0&&cq>0&&sameSize(oq,cq)){
      for(const row of inWin){
       const id=String(row.orderId),s=String(row.side).toUpperCase();
       if(!orders.has(id))orders.set(id,{id,side:s,confirmed:true,verifiedQty:Number(row.executedQty),order:row});
      }
     }
    }
   }
  }
  return orders;
 }
 /** A position found gone on the venue without our close order: classified (#goneEvidence) and booked. An entry
  * whose answer was lost (no step) is looked up first: only when BingX says none of its orders exists is the row
  * dropped without a closed record (ENTRY_NOT_FILLED); filled or not verifiable, it is classified and booked. */
 async #gone(p,reason,now){
  const key=this.#key(p);
  if(!p.steps?.length&&!p.closing){const f=await this.#entryFill(p);
   if(f.absent){if(this.store.positions[key]===p)delete this.store.positions[key];p.status='CLOSED';
    this.#event('ENTRY_NOT_FILLED',{symbol:p.symbol,reason,detail:'진입 주문이 거래소에 없음(80016) — 원장에서 지움'});return {ok:false,reason:'POSITION_GONE'}}
   p.steps=[{kind:f.filled?'OPEN':'ENTRY_UNVERIFIED',at:this.now(),qty:f.qty??null,avg:f.avg??null}]}
  if(!p.closing){p.closeEvidence=await this.#goneEvidence(p);if(['LIQUIDATION','ADL'].includes(p.closeEvidence.kind))reason=p.closeEvidence.kind}
  this.#closed(p,reason,now);return {ok:false,reason:'POSITION_GONE'};
 }
 /** Why it is gone (fail closed, review 2026-11-17): HAD_STOP (our exchange stop may have filled), LIQUIDATION /
  * ADL (a BingX force order in the window), MANUAL_CLOSE (a FILLED closing order in the window that is not ours:
  * clientOrderId without our 'cp' prefix, not our stop), else UNCONFIRMED (none found, or a query failed). The
  * window starts a minute before the last time the position was seen on the venue. */
 async #goneEvidence(p){
  if(p.stopOrderId||Number(p.stop)>0)return {kind:'HAD_STOP'};
  const c=this.client,to=this.now(),from=Math.max(0,p.openedAt?p.openedAt-1000:0,(p.seenAt??p.openedAt??to)-60000);
  if(typeof c.forceOrders!=='function'||typeof c.allOrders!=='function')return {kind:'UNCONFIRMED',why:'NO_HISTORY_API',from,to};
  try{
   for(const type of ['LIQUIDATION','ADL']){const rows=rowsOf(await c.forceOrders({symbol:p.venueSymbol,autoCloseType:type,startTime:from,endTime:to}));
    if(rows.length)return {kind:type,orderId:rows[0]?.orderId!=null?String(rows[0].orderId):null,at:num(rows[0]?.updateTime??rows[0]?.time),from,to}}
   const rows=rowsOf(await c.allOrders({symbol:p.venueSymbol,startTime:from,endTime:to,limit:500}));
   const forced=rows.find(o=>/LIQUID|ADL/i.test(String(o?.type||'')+String(o?.autoCloseType||'')));
   if(forced)return {kind:'LIQUIDATION',orderId:forced.orderId!=null?String(forced.orderId):null,from,to};
   const closeSide=p.direction==='LONG'?'SELL':'BUY';
   const hit=rows.find(o=>{const st=String(o?.status||'').toUpperCase(),t=num(o?.updateTime??o?.time),ps=String(o?.positionSide||'BOTH').toUpperCase();
    return ((num(o?.executedQty)??0)>0||st==='FILLED')&&String(o?.side||'').toUpperCase()===closeSide&&(p.hedge===true?ps===p.direction:ps==='BOTH')
     &&t!=null&&t>=from&&!String(o?.clientOrderId||'').toLowerCase().startsWith('cp')&&String(o?.orderId??'')!==String(p.stopOrderId??'')});
   return hit?{kind:'MANUAL_CLOSE',orderId:hit.orderId!=null?String(hit.orderId):null,clientOrderId:hit.clientOrderId||null,type:hit.type??null,at:num(hit.updateTime??hit.time),from,to}
    :{kind:'UNCONFIRMED',why:'NO_MANUAL_CLOSE_ORDER',from,to};
  }catch(e){return {kind:'UNCONFIRMED',why:e.code||e.message||'QUERY_FAILED',from,to}}
 }
 /** Routine check: closed positions booked, missing stops placed again, failed closes / cuts retried,
  * and the whole-ledger loss limit. Runs in the message queue (review 2026-11-17: it must not interleave with an
  * order waiting for its retry); a check already queued or running is not queued twice; idle() counts it. */
 reconcile(){
  if(this.reconciling)return this.reconciling;
  this.pendingCount=(this.pendingCount||0)+1;
  const management=this.queue.then(()=>this.#reconcile()).finally(()=>{this.pendingCount--});
  this.queue=management.catch(()=>{});
  this.reconciling=management.then(()=>this.#auditReconcile()).finally(()=>{this.reconciling=null});
  return this.reconciling;
 }
 async #reconcile(){
  if(this.audit)for(const p of Object.values(this.store.positions))if(p.auditQty==null)p.auditQty=pos(p.qty);
  const inflight=job=>this.store.positions[this.#key(job.m)]?.inflight===true;
  const retried=new Set();
  for(const job of this.store.pending.splice(0)){
   // A retry belongs to the position it was made for: never applied to a newer one with the same key.
   if(job.pid&&this.store.positions[this.#key(job.m)]?.id!==job.pid)continue;
   if(inflight(job)){this.store.pending.push(job);continue} // an order of that position is waiting for its retry
   if(this.store.positions[this.#key(job.m)]?.closing)retried.add(this.#key(job.m));
   job.tries++;
   try{const r=job.m.kind==='CLOSE'?await this.#close(job.m,'TRADER_CLOSE'):await this.#change(job.m,job.at);if(r?.ok===false&&!['NOT_COPIED','POSITION_GONE'].includes(r.reason)&&job.tries<5)this.store.pending.push(job)}
   catch(error){if(job.tries<5)this.store.pending.push(job);else this.#event('ERROR',{symbol:job.m.symbol,kind:'RETRY_GAVE_UP',reason:error.code||error.message})}
  }
  let unrealized=0;
  for(const p of Object.values(this.store.positions).filter(x=>x.status==='OPEN')){
   if(p.inflight)continue; // never counted or booked while one of its orders waits for a retry
   try{
    if(p.closing&&['TRADER_CLOSE','TRADER_CUT_ALL'].includes(p.closing.reason)){
     if(!retried.has(this.#key(p)))await this.#close(p,p.closing.reason);
     if(p.status==='OPEN')unrealized+=Number(p.unrealized)||0;
     continue;
    }
    const now=await this.#position(p);
    // One empty answer is not enough to close the ledger (a venue list can come back empty for a moment;
    // the position would stay on the venue and the next card would buy again): two checks in a row.
    if(!(now.size>0)){p.zeroSeen=(p.zeroSeen||0)+1;if(p.zeroSeen<2){this.#save();continue}
     if(p.stopOrderId){try{await this.client.cancelOrder(p.venueSymbol,p.stopOrderId)}catch{}}await this.#gone(p,'STOP_OR_EXTERNAL',now);continue}
    p.zeroSeen=0;
    // An entry whose answer was lost: taken over only when its order shows filled; "does not exist" or a failed
    // lookup -> not ours to manage: dropped from the ledger, the venue position left alone (UNCONFIRMED_ADOPT).
    if(!p.steps?.length){const f=await this.#entryFill(p);
     if(!f.filled){const key=this.#key(p);if(this.store.positions[key]===p)delete this.store.positions[key];p.status='CLOSED';
      this.#event('UNCONFIRMED_ADOPT',{symbol:p.symbol,reason:f.absent?'ENTRY_ORDER_NOT_FOUND':'ENTRY_LOOKUP_FAILED',size:now.size,detail:`거래소에 ${now.size} 보유 — 우리 진입 체결이 확인되지 않아 원장에 넣지 않음(직접 확인 필요)`});continue}
     p.steps=[{kind:'ADOPTED',at:this.now(),qty:now.size}];if(this.audit)p.auditQty=now.size}
    // A close of ours that did not go through (no answer, a refusal): closed again.
    if(p.closing&&!['TRADER_CLOSE','TRADER_CUT_ALL'].includes(p.closing.reason)){await this.#emergency(p,p.closing.reason);continue}
    p.qty=now.size;p.avg=now.avg??p.avg;p.unrealized=now.unrealized;p.mark=now.mark;unrealized+=Number(now.unrealized)||0;
    if(this.config.stops&&(!p.stopOrderId||p.stopStale)||!this.config.stops&&p.stopOrderId)await this.#protect(p);
    if(this.config.stops&&p.stopZone&&await this.#zoneBroken(p).catch(()=>false)){await this.#emergency(p,'ZONE_BREAK_VOLUME');continue}
   }catch(error){if(error.code==='HTTP_429')break}
  }
  const bal=await this.balance().catch(()=>null),eq=pos(bal?.equity);
  if(bal)this.funds={equity:bal.equity==null?null:num(bal.equity),available:availableMargin(bal),at:this.now()};
  if(eq&&!this.store.killed&&unrealized<=-eq*this.config.ledgerLossPct/100){
   this.store.killed=true;
   for(const p of Object.values(this.store.positions).filter(x=>x.status==='OPEN'))p.closing??={reason:'COPY_LOSS_LIMIT',at:this.now()};
   this.#event('COPY_LOSS_LIMIT',{reason:`open loss ${unrealized.toFixed(2)} ≤ -${this.config.ledgerLossPct}% of ${eq.toFixed(2)}`});this.#save(); // on disk before any order
   for(const p of Object.values(this.store.positions).filter(x=>x.status==='OPEN'&&!x.closing?.pending))await this.#emergency(p,'COPY_LOSS_LIMIT');
  }else if(this.store.killed){
   for(const p of Object.values(this.store.positions).filter(x=>x.status==='OPEN'&&!x.inflight&&!x.closing))await this.#emergency(p,'COPY_LOSS_LIMIT');
  }
  this.#save();
 }
 /** The last closed 15m candle closed beyond the stop zone on volume >= breakVolumeMult x the 20 before it. */
 async #zoneBroken(p){
  const rows=await Promise.race([this.candlesOf(p.symbol,'15m',30),new Promise(r=>setTimeout(()=>r([]),3000).unref?.())]);
  const closed=(rows||[]).filter(r=>Number(r[6])<this.now());if(closed.length<21)return false;
  const last=closed.at(-1),prev=closed.slice(-21,-1),avgVol=prev.reduce((t,r)=>t+Number(r[5]),0)/prev.length;
  const dir=p.direction==='LONG'?1:-1,edge=dir===1?p.stopZone.priceLow:p.stopZone.priceHigh,close=Number(last[4]);
  const beyond=dir*(edge-close)>0,heavy=avgVol>0&&Number(last[5])>=avgVol*this.config.breakVolumeMult;
  if(beyond&&heavy)this.#event('ZONE_BREAK',{symbol:p.symbol,close,edge,volumeX:+(Number(last[5])/avgVol).toFixed(2)});
  return beyond&&heavy;
 }
 /** After the loss limit: copying resumes only when asked. */
 resume(){this.store.killed=false;this.#save();return this.status()}
}
