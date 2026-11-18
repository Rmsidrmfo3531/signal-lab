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
import {roundDecimalToStep} from './decimal_grid.mjs';
import {executionFills,summarizeBalancedFills} from './live_clients.mjs';
import {venueRows} from './venue_positions.mjs';
import {parseCopyMessage} from './copy_parser.mjs';
import {readPositionMode,leverageSideFor,positionSideFor,positionRow} from './bingx_position_mode.mjs';

export const COPY_DEFAULTS=Object.freeze({stops:false,backstopPct:50,sizing:'MIN_ORDER',traderBalanceUSD:20000,maxAdds:100,breakVolumeMult:1.5,stopMinPct:20,stopMaxPct:40,stopBufferPct:.3,marginUSD:1,firstMarginUSD:0.3,maxLossPct:25,snapshotMs:120000,maxLeverage:125,maxTotalMarginPct:100,ledgerLossPct:50,minOrderMaxMarginUSD:5});
const MAX_CLOSED=300,MAX_EVENTS=200,MAX_SEEN=1000;
const num=v=>{const n=Number(v);return Number.isFinite(n)?n:null};
const pos=v=>{const n=Number(v);return Number.isFinite(n)&&n>0?n:null};
const orderOf=d=>d?.order??d;
const venueSymbolOf=s=>s.replace(/USDT$/,'-USDT');

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
 // TESTNET only. COPY_TRADING=off turns it off.
 const mode=String(env.COPY_MODE||'').toUpperCase()==='LIVE'&&env.COPY_LIVE_CONFIRM===COPY_LIVE_PHRASE?'LIVE':liveMode==='TESTNET'?'TESTNET':'OFF';
 const enabled=String(env.COPY_TRADING||'').toLowerCase()!=='off'&&mode!=='OFF';
 // FIRST_1USD (default, user 2026-11-14 04:30 "최초 증거금을 1달러로", after being told of the review's
 // liquidation warning): the first buy is 1 $ of margin, later buys and partial closes in proportion to the
 // trader's quantities. BALANCE_RATIO (trader quantity x our equity / 20,000 $) is selectable. The copy may
 // use up to 100 % of the equity as margin, read from the exchange before every order; each order still
 // needs 90 % of the free margin to cover it.
 // MIN_ORDER (default, user 2026-11-14 12:31 "증거금을 최소한 매매가 진행될 수 있도록", adds as many as
 // possible): the first buy is the venue's smallest valid order; later buys follow the trader's
 // quantities in proportion to that first buy (small ones carried until they make a valid order).
 const sz=String(env.COPY_SIZING||'').toUpperCase(),sizing=['BALANCE_RATIO','FIRST_1USD'].includes(sz)?sz:'MIN_ORDER';
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
  lateEntry:!/^(off|0|false|no)$/i.test(String(env.COPY_LATE_ENTRY||'on'))};
}

export class CopyExecutor{
 constructor({fileName='copy-store.json',config,client,contractOf,markOf=async()=>null,zonesOf=async()=>[],candlesOf=async()=>[],gate=()=>({ok:true}),entryGateRevision=()=>null,isBusy=()=>false,balance=async()=>null,directory=null,now=()=>Date.now(),log=()=>{},onEvent=()=>{},retryDelaysMs=[2000,5000],retryBudgetMs=30000,goneRecheckMs=1000,sleep=ms=>new Promise(r=>setTimeout(r,ms))}){
  Object.assign(this,{config,client,contractOf,markOf,zonesOf,candlesOf,gate,entryGateRevision,isBusy,balance,now,log,onEvent,retryDelaysMs,retryBudgetMs,goneRecheckMs,sleep});
  this.file=directory?path.join(directory,fileName):null;
  const saved=this.file&&fs.existsSync(this.file)?readStore(this.file):null;
  this.store={positions:saved?.positions||{},closed:saved?.closed||[],events:saved?.events||[],seen:saved?.seen||[],monitorStartAt:saved?.monitorStartAt||0,lastMsgAt:saved?.lastMsgAt||{},lastTraderCloseAt:saved?.lastTraderCloseAt||{},leverageOf:saved?.leverageOf||{},pending:saved?.pending||[],killed:saved?.killed||false};
  // An order in flight does not survive a restart.
  for(const p of Object.values(this.store.positions))delete p.inflight;
  this.queue=Promise.resolve();this.reserved=new Set();this.armed=false;this.entryRevision=0;this.settling=null;this.settleAttempts=new Map();
 }
 arm(){this.armed=true;this.#event('ARMED',{mode:this.config.mode});return this.status()}
 disarm(){this.entryRevision++;this.armed=false;this.#event('DISARMED',{mode:this.config.mode});return this.status()}
 #save(){if(!this.file)return;this.store.closed=this.store.closed.slice(-MAX_CLOSED);this.store.events=this.store.events.slice(-MAX_EVENTS);this.store.seen=this.store.seen.slice(-MAX_SEEN);
  fs.mkdirSync(path.dirname(this.file),{recursive:true});atomicWriteStore(this.file,{version:1,...this.store})}
 #event(type,detail={}){const cur=this.curMsg,e={type,at:this.now(),mode:this.config.mode,...(detail.symbol&&cur?.symbol===detail.symbol&&cur.direction?{direction:cur.direction}:{}),...detail};this.store.events.push(e);this.log(`[COPY] ${type} ${detail.symbol||''} ${detail.reason||''}`.trim());try{this.onEvent(e)}catch{}return e}
 /** Symbols the copy ledger holds (the signal strategy skips them). */
 heldSymbols(){return new Set([...Object.values(this.store.positions).filter(p=>p.status==='OPEN').map(p=>p.symbol),...this.reserved])}
 status(){return {funds:this.funds??null,firstMarginUSD:this.config.firstMarginUSD,maxAdds:this.config.maxAdds,mode:this.config.mode,armed:this.armed,stops:this.config.stops,maxAdds:this.config.maxAdds,breakVolumeMult:this.config.breakVolumeMult,sizing:this.config.sizing,traderBalanceUSD:this.config.traderBalanceUSD,stopMinPct:this.config.stopMinPct,enabled:this.config.enabled,killed:this.store.killed,pending:this.store.pending.length,maxTotalMarginPct:this.config.maxTotalMarginPct,ledgerLossPct:this.config.ledgerLossPct,marginUSD:this.config.marginUSD,maxLossPct:this.config.maxLossPct,positions:Object.values(this.store.positions),
  closed:this.store.closed.slice(-200).reverse(),closedTotal:this.store.closed.length,events:this.store.events.slice(-200).reverse(),monitorStartAt:this.store.monitorStartAt||null}}

 /** status() with fresh numbers for the screen (user 2026-11-14: the real-account page did not update):
  * open positions' PnL from the venue's last price (cached tickers, ~20 s), the balance re-read when
  * older than 15 s. The reconcile (60 s) still owns the quantities and the loss limit. */
 async liveStatus(){
  const open=Object.values(this.store.positions).filter(p=>p.status==='OPEN'&&p.qty>0&&p.avg>0);
  await Promise.all(open.map(async p=>{try{const m=Number(await Promise.race([this.markOf(p.venueSymbol),new Promise(r=>setTimeout(()=>r(null),3000).unref?.())]));
   if(m>0){p.mark=m;p.unrealized=(p.direction==='LONG'?1:-1)*(m-p.avg)*p.qty;p.markAt=this.now()}}catch{}}));
  if(!this.funds||!(this.now()-(this.funds.at||0)<15000)){try{const b=await this.balance();if(b)this.funds={equity:num(b.equity),available:num(b.available),at:this.now()}}catch{}}
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
  if(m.kind==='MONITOR_START'){this.store.monitorStartAt=at;this.#event('MONITOR_START');this.#save();return {ok:true}}
  // Messages are retried for minutes when the server restarts, so they can arrive out of order: one older
  // than the last handled for the same coin and side is history (an old entry must not reopen a position the
  // trader has closed, an old close must not close a newer one).
  {const k=this.#key(m),last=this.store.lastMsgAt[k]||0;
   if(at<last){this.#event('SKIPPED',{symbol:m.symbol,reason:'STALE_MESSAGE',detail:`${Math.round((last-at)/1000)}초 앞선 메시지가 먼저 처리됨`});this.#save();return {ok:false,reason:'STALE_MESSAGE'}}
   this.store.lastMsgAt[k]=at;
   // The trader's closes (server time, like our closedAt): after our own close we follow again only once
   // the trader has closed that position too (an entry card can also be the trader adding to it).
   // ('- → x' means the trader had closed it before, even if we missed that card.)
   if(m.kind==='CLOSE'||(m.kind==='CHANGE'&&(m.to===0||m.from===0)))this.store.lastTraderCloseAt[k]=this.now()}
  if(!this.config.enabled){this.#event('SKIPPED',{symbol:m.symbol,reason:'COPY_OFF'});this.#save();return {ok:false,reason:'COPY_OFF'}}
  this.step=null;
  try{
   const r=m.kind==='OPEN'?await this.#open(m,at,entry):m.kind==='CHANGE'?await this.#change(m,at,entry):await this.#close(m,'TRADER_CLOSE');
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
 }
 #key(m){return `${m.symbol}|${m.direction}`}
 async #contract(symbol){const c=await this.contractOf(symbol);if(!c||c.tradable===false)throw Object.assign(Error('NO_BINGX_CONTRACT'),{code:'NO_BINGX_CONTRACT'});return c}
 #qty(c,raw,mode='DOWN'){try{return Number(roundDecimalToStep(mode==='DOWN'?raw*(1+1e-9):raw,c.quantityStep,mode))}catch{return 0}} // 1e-9: 299.99999… is 300
 // Hedge mode (p.hedge, user 2026-11-17): the row of this position's own side; one-way: the symbol's row.
 async #position(p){
  const list=venueRows(await this.client.positions(p.venueSymbol));
  if(!list)throw Object.assign(Error('UNEXPECTED_POSITION_RESPONSE'),{code:'UNEXPECTED_POSITION_RESPONSE'});
  const row=positionRow(list,p.venueSymbol,{hedge:p.hedge===true,direction:p.direction}),amt=row?num(row.positionAmt):0;
  if(amt===null)throw Object.assign(Error('UNEXPECTED_POSITION_RESPONSE'),{code:'UNEXPECTED_POSITION_RESPONSE'});
  const size=Math.abs(amt);if(size>0)p.seenAt=this.now(); // the last confirmed state (#goneEvidence window)
  return {size,avg:pos(row?.avgPrice),mark:pos(row?.markPrice),unrealized:row?num(row.unrealizedProfit):null}}
 /** A position read empty once is read again ~1 s later before it counts as gone (a venue list can come back
  * empty for a moment). */
 async #recheck(p,now){if(now.size>0)return now;await this.sleep(this.goneRecheckMs);return this.#position(p)}
 /** A new order tag: p.orderSeq goes up on every new order, failed ones included, so a later order never
  * reuses an earlier clientOrderId (review 2026-11-17). Retries of the same order keep its tag. */
 #tag(p,kind){p.orderSeq=(Number(p.orderSeq)||0)+1;return `${kind}.${p.orderSeq}`}
 #rememberFillOrder(p,id,side,confirmed=false){
  if(id==null)return;
  const orderId=String(id);
  const prior=p.fillOrders?.find(o=>o.id===orderId);
  if(prior)prior.confirmed=prior.confirmed||confirmed;
  else (p.fillOrders??=[]).push({id:orderId,side,confirmed});
 }
 async #market(p,side,quantity,{reduceOnly=false,tag,beforeSend}){
  this.step=/^open/.test(tag)?'진입 주문':'시장가 주문';
  const params={symbol:p.venueSymbol,side,positionSide:positionSideFor({hedge:p.hedge===true,direction:p.direction}),type:'MARKET',quantity:String(quantity),clientOrderId:this.#clientId(p,tag)};
  // Hedge mode: no reduceOnly (BingX refuses it); the side and positionSide make it a close.
  if(reduceOnly&&p.hedge!==true)params.reduceOnly='true';
  const res=orderOf(await this.client.placeOrder(params,{beforeSend}));
  this.#rememberFillOrder(p,res?.orderId,side,Number(res?.executedQty)>0||res?.status==='FILLED');
  return {orderId:res?.orderId??null,avg:pos(res?.avgPrice),status:res?.status??null};
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
 async #send(p,side,quantity,{tag},{event,before,step,entry,marginUSD}){
  const margin=await this.#orderMargin(marginUSD);
  const blocked=this.#sendBlock(p,entry),orderBlock=blocked?{reason:blocked}:margin;
  if(orderBlock)throw Object.assign(Error(orderBlock.reason),{code:orderBlock.reason,orderBlock});
  const cid=this.#clientId(p,tag),started=Date.now(),delays=Array.isArray(this.retryDelaysMs)?this.retryDelaysMs:[];
  if(event==='ENTRY_RETRY')p.entryCids=[...(p.entryCids||[]),cid]; // looked up again before the ledger drops or adopts it
  const sendMarket=async()=>{
   try{return await this.#market(p,side,quantity,{tag,beforeSend:()=>this.#sendBlock(p,entry)})}
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
    const margin=await this.#orderMargin(marginUSD);
    const seen=await this.#orderOutcome(p,cid,{before,step});
    if(seen.filled){this.#rememberFillOrder(p,seen.orderId,side,true);ev('ALREADY_FILLED',{via:seen.via});return {orderId:seen.orderId??null,avg:seen.avg??null,qty:seen.qty??null}}
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
 async #orderMargin(need){
  if(!Number.isFinite(need)||need<=0)return {reason:'PRICE_UNVERIFIED'};
  let funds;try{funds=await this.balance()}catch{}
  const equity=pos(funds?.equity),raw=funds?.available;
  const free=raw==null||String(raw).trim()===''?null:num(raw);
  if(!equity||free===null)return {reason:'NO_BALANCE'};
  const used=Object.values(this.store.positions).filter(p=>p.status==='OPEN')
   .reduce((total,p)=>total+(p.qty||0)*(p.avg||0)/(p.leverage||1),0);
  const remaining=equity*this.config.maxTotalMarginPct/100-used;
  if(need>remaining)return {reason:'COPY_MARGIN_CAP',need:+need.toFixed(2),free:+remaining.toFixed(2)};
  if(need>free*.9)return {reason:'MARGIN_SHORT',need:+need.toFixed(2),free};
  return null;
 }
 #sendBlock(p,entry){
  if(this.store.positions[this.#key(p)]!==p||p.status!=='OPEN')return 'POSITION_NOT_OPEN';
  if(p.closing)return 'CLOSING';
  if(this.store.killed)return 'COPY_LOSS_LIMIT';
  let g;try{g=this.gate()}catch{g={ok:false,reason:'GATE_ERROR'}}
  if(!g?.ok)return g?.reason||'GATE_CLOSED';
  if(entry.revision!==this.entryRevision||entry.gateRevision!==this.entryGateRevision())return 'ENTRY_INTERRUPTED';
  return null;
 }
 /** Did the order with this clientOrderId go through? {filled} / {absent} (BingX says it does not exist and the
  * position has not moved by a quantity step) / {} (cannot tell: never resent). */
 async #orderOutcome(p,clientOrderId,{before,step}){
  if(typeof this.client.getOrder!=='function')return {why:'NO_ORDER_LOOKUP'};
  try{const o=orderOf(await this.client.getOrder(p.venueSymbol,{clientOrderId})),st=String(o?.status||'').toUpperCase(),exec=num(o?.executedQty)??0;
   if(o&&(exec>0||st==='FILLED'||st==='PARTIALLY_FILLED'))return {filled:true,via:'ORDER',orderId:o.orderId??null,avg:pos(o.avgPrice),qty:exec>0?exec:null};
   // Known to the venue and finished without a fill: absent; anything else (NEW / PENDING / no status): unknown.
   if(!(o&&['CANCELED','CANCELLED','EXPIRED','REJECTED','FAILED'].includes(st)))return {why:'ORDER_STATE_'+(st||'UNKNOWN')};
  }catch(e){if(!orderAbsent(e))return {why:'LOOKUP_'+(e.code||'FAILED')}}
  try{const now=await this.#position(p),moved=Math.abs(now.size-(Number(before)||0)),unit=pos(step)??0;
   return moved>=(unit>0?unit:1e-12)*(1-1e-9)?{why:'SIZE_MOVED'}:{absent:true}}
  catch(e){return {why:'POSITION_'+(e.code||'FAILED')}}
 }
 // Whole-position stop where the loss would reach maxLossPct of the balance; re-set after each change.
 // The new stop goes in first and the old one is cancelled after it, so the position is never left
 // without one (closePosition stops cover the whole position whatever its size). If the new stop
 // cannot be placed, the old one stays (the routine check tries again); with no stop at all — or a
 // stop price already passed — the position is closed at market.
 async #protect(p){
  if(!this.config.stops){if(p.stopOrderId){try{await this.client.cancelOrder(p.venueSymbol,p.stopOrderId)}catch{}}p.stopOrderId=null;p.stop=null;p.stopStale=false;p.stopSource='NONE';
   const now=await this.#position(p);p.qty=now.size;if(now.avg)p.avg=now.avg;return}
  const now=await this.#position(p);p.qty=now.size;if(now.avg)p.avg=now.avg;
  if(!(p.qty>0))return;
  const bal=await this.balance().catch(()=>null),equity=pos(bal?.equity);
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
   try{const o=orderOf(await this.client.getOrder(p.venueSymbol,{clientOrderId})),st=String(o?.status||'').toUpperCase(),exec=num(o?.executedQty)??0;
    if(o&&(exec>0||st==='FILLED'||st==='PARTIALLY_FILLED'))return {filled:true,qty:exec>0?exec:null,avg:pos(o.avgPrice)};
    if(o&&['CANCELED','CANCELLED','EXPIRED','REJECTED','FAILED'].includes(st))absent++;}
   catch(e){if(orderAbsent(e))absent++}
  }
  return absent===cids.length?{absent:true}:{};
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
   prev.lastTheirEntry=m.entry;prev.lastTheirQty=m.quantity;prev.lastTheirAt=at;
   // The trader's total follows the trader, whether or not our buy goes through.
   if(prev.theirTotal>0)prev.theirTotal+=m.quantity;
   return this.#buyMore(prev,m,m.quantity,{price:pos(m.price)??pos(m.entry),entry});
  }
  if(this.store.monitorStartAt&&at-this.store.monitorStartAt<this.config.snapshotMs){this.#event('SKIPPED',{symbol:m.symbol,reason:'MONITOR_RESTART_SNAPSHOT'});return {ok:false,reason:'SNAPSHOT'}}
  const g=this.gate();if(!g.ok){this.#event('SKIPPED',{symbol:m.symbol,reason:g.reason});return {ok:false,reason:g.reason}}
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
  const c=await this.#contract(m.symbol),venueSymbol=c.venueSymbol||venueSymbolOf(m.symbol);
  // A '- → q' change has no leverage: the last one seen for the symbol (else 10).
  if(m.leverage)this.store.leverageOf[m.symbol]=m.leverage;
  // The venue contract must be the same thing at the same price: card price x unit multiplier within
  // 10 % of the venue's last price (a stock perpetual or a 1000-coin contract that is something else, or a
  // contract that is not 1 share / 1000 coins, is refused). A contract found under another name is not
  // traded without that check.
  let venuePrice=null;
  {venuePrice=await Promise.race([this.markOf(venueSymbol),new Promise(r=>setTimeout(()=>r(null),3000).unref?.())]).catch(()=>null);
   const cardPrice=(pos(m.price)??pos(m.entry))*(Number(c.unitMultiplier)||1);
   if(!(venuePrice>0)){if(c.alias){this.#event('SKIPPED',{symbol:m.symbol,reason:'PRICE_UNVERIFIED'});return {ok:false,reason:'PRICE_UNVERIFIED'}}}
   else if(Math.abs(cardPrice/venuePrice-1)>.1){this.#event('SKIPPED',{symbol:m.symbol,reason:'PRICE_MISMATCH',detail:`카드 ${cardPrice} / 거래소 ${venuePrice}`});return {ok:false,reason:'PRICE_MISMATCH'}}}
  let leverage=Math.max(1,Math.min(Math.round(m.leverage||this.store.leverageOf[m.symbol]||10),this.config.maxLeverage));
  this.step='레버리지 조회';try{const info=await this.client.leverage(venueSymbol),maxL=Number(info?.maxLongLeverage??info?.maxLeverage);if(maxL>0)leverage=Math.min(leverage,maxL)}catch{}
  // The account's position mode (one-way: positionSide BOTH; hedge: LONG / SHORT, user 2026-11-17), read
  // before every entry and kept on the position. Not readable or not stated: skipped before any setting or
  // order (never guessed: the wrong mode is refused by BingX with 109400, user 2026-11-14 AKEUSDT).
  this.step='포지션 모드 확인';
  const mode=await readPositionMode(this.client);
  if(!mode.ok){this.#event('SKIPPED',{symbol:m.symbol,reason:mode.reason,detail:mode.detail});return {ok:false,reason:mode.reason}}
  const hedge=mode.hedge;
  // Never add to a position already on the venue (a manual trade, or one the ledger lost): it would merge
  // with ours and the trader's close would then close it all (user 2026-11-14, BTC 0.005). Hedge mode: the
  // same side only (the other side is a separate position).
  this.step='거래소 포지션 확인';
  {const list=await this.client.positions(venueSymbol),row=positionRow(list,venueSymbol,{hedge,direction:m.direction}),size=row?Math.abs(Number(row.positionAmt)||0):0;
   if(size>0){this.#event('SKIPPED',{symbol:m.symbol,reason:'VENUE_POSITION_EXISTS',detail:`거래소에 이미 ${size} 보유`});return {ok:false,reason:'VENUE_POSITION_EXISTS'}}}
  this.step='증거금 모드 설정';
  try{await this.client.setMarginType(venueSymbol,'CROSSED')}catch{}
  this.step='레버리지 설정';
  await this.client.setLeverage(venueSymbol,leverageSideFor({hedge,direction:m.direction}),leverage);
  // unitMultiplier: venue contract of 1000 coins (1000PEPE) -> quantities / 1000, prices x 1000.
  const mult=Number(c.unitMultiplier)||1,price=(pos(m.price)??pos(m.entry))*mult;
  // BALANCE_RATIO: scale = our equity / the trader's balance, fixed for the position (its later buys use it too).
  let scale=null;
  if(this.config.sizing==='BALANCE_RATIO'){
   if(!(m.quantity>0))throw Object.assign(Error('TRADER_QUANTITY_MISSING'),{code:'TRADER_QUANTITY_MISSING'});
   const eq=pos((await this.balance().catch(()=>null))?.equity);if(!eq)throw Object.assign(Error('NO_BALANCE'),{code:'NO_BALANCE'});
   scale=eq/this.config.traderBalanceUSD;
  }
  const minOnly=this.config.sizing==='MIN_ORDER';
  let qty=scale!=null?this.#qty(c,m.quantity*scale/mult):minOnly?this.#qty(c,this.config.firstMarginUSD*leverage/price):this.#qty(c,this.config.marginUSD*leverage/price);
  const minQ=pos(c.minQuantityBase)??0,minN=pos(c.minNotionalUSDT)??0;
  // Below the venue minimum: the smallest valid order instead (flagged: larger than the ratio asks).
  let minOrder=false;
  // The minimum is measured at the lower of the card and venue prices, with 5 % room: BingX checks it at
  // its own price, and a card price above it left the order under the minimum (user 2026-11-14, AKEUSDT
  // real account: "minimum order amount is 149 AKE" / "minimum order value is 2 USDT", five entries).
  const minPrice=venuePrice>0?Math.min(price,venuePrice):price;
  if(qty<minQ||qty*minPrice<minN){qty=this.#qty(c,Math.max(minQ,minN/minPrice*1.05),'UP');minOrder=!minOnly}
  if(minOnly&&qty*price/leverage>Math.max(this.config.minOrderMaxMarginUSD,this.config.firstMarginUSD*1.05)){this.#event('SKIPPED',{symbol:m.symbol,reason:'MIN_ORDER_TOO_LARGE',need:+(qty*price/leverage).toFixed(2)});return {ok:false,reason:'MIN_ORDER_TOO_LARGE'}}
  // The card's quantity must be coins: with a 마진 line, quantity x price must match margin x leverage
  // (within 30 %), else it may be a contract count and is not traded.
  if(scale!=null&&m.marginUSD>0&&m.leverage>0){const implied=m.quantity*(price/mult)/(m.marginUSD*m.leverage);
   if(implied<.7||implied>1.3)throw Object.assign(Error('QUANTITY_UNIT_UNCLEAR'),{code:'QUANTITY_UNIT_UNCLEAR'})}
  // A venue minimum far above the planned size (an expensive stock perp, a low leverage) is not taken.
  if(minOrder&&qty*price/leverage>this.config.minOrderMaxMarginUSD){this.#event('SKIPPED',{symbol:m.symbol,reason:'MIN_ORDER_TOO_LARGE',need:+(qty*price/leverage).toFixed(2)});return {ok:false,reason:'MIN_ORDER_TOO_LARGE'}}
  if(!(qty>0))throw Object.assign(Error('QUANTITY_INVALID'),{code:'QUANTITY_INVALID'});
  const p={id:`${key}|${at}`,symbol:m.symbol,venueSymbol,direction:m.direction,hedge,leverage,tickSize:c.tickSize,status:'OPEN',openedAt:this.now(),
   scale,mult,sizing:this.config.sizing,firstQty:qty,venueAlias:c.alias??null,minOrder,theirEntry:m.entry,theirQty:m.quantity??null,theirFirstQty:m.quantity??null,theirTotal:m.quantity??null,lastTheirEntry:m.entry??null,lastTheirQty:m.quantity??null,lastTheirAt:at,theirMarginUSD:m.marginUSD??null,qty:0,avg:null,adds:0,reduces:0,stop:null,stopOrderId:null,steps:[],fillTracked:true};
  // At most 3 s for the zones (the message queue must not wait on a slow profile); then the cap stop.
  try{const zones=await Promise.race([this.zonesOf(m.symbol,{tickSize:c.tickSize}),new Promise(r=>setTimeout(()=>r([]),3000).unref?.())]);
   const zs=this.zoneStop({direction:m.direction,entry:price/mult,zones});if(zs){p.zoneStop=zs.stop;p.stopZone=zs.zone;p.stopDistPct=zs.distPct}}catch{}
  this.store.positions[key]=p;
  const skipBeforeSend=block=>{
   if(this.store.positions[key]===p)delete this.store.positions[key];
   this.#event('SKIPPED',{symbol:m.symbol,...block});
   return {ok:false,reason:block.reason};
  };
  const sendOpen=()=>this.#send(p,m.direction==='LONG'?'BUY':'SELL',qty,{tag:this.#tag(p,'open')},
   {event:'ENTRY_RETRY',before:0,step:c.quantityStep,entry,marginUSD:qty*Math.max(price,venuePrice||0)/leverage});
  let fill;
  // The venue position was checked empty above: before = 0 for the retry check.
  try{fill=await sendOpen()}
  catch(error){
   if(error.orderBlock)return skipBeforeSend(error.orderBlock);
   // 101400 is a refusal (nothing filled). When it names the venue minimum, one more try at that minimum
   // if it still fits the same margin limits; otherwise the ledger entry is dropped, so no empty position
   // is left to be closed later as "external".
   const need=error.code==='VENUE_ERROR_101400'?this.#venueMinimum(c,error.message,minPrice):null;
   // The same limits as the first order (5 $ minimum-order margin, the copy margin cap, 90 % of the free
   // margin), measured at the higher of the card and venue prices.
   const margin=need?need*Math.max(price,venuePrice||0)/leverage:Infinity;
   if(need>qty&&margin<=this.config.minOrderMaxMarginUSD){
    this.#event('ENTRY_RETRY_MIN',{symbol:m.symbol,from:qty,to:need});qty=need;p.firstQty=need;p.minOrder=true;
    try{fill=await sendOpen()}
    catch(e2){
     if(e2.orderBlock)return skipBeforeSend(e2.orderBlock);
     if(['VENUE_ERROR_101400','RETRY_ABANDONED'].includes(e2.code)&&this.store.positions[key]===p)delete this.store.positions[key];throw e2}}
   // RETRY_ABANDONED comes only after BingX said the order does not exist: nothing to keep either.
   else{if(['VENUE_ERROR_101400','RETRY_ABANDONED'].includes(error.code)&&this.store.positions[key]===p)delete this.store.positions[key];throw error}}
  p.steps.push({kind:'OPEN',at:this.now(),qty,avg:fill.avg});this.#save(); // a real fill is on disk before anything else
  await this.#protect(p);
  if(p.status!=='OPEN')return {ok:false,reason:p.closeReason};
  this.#event('OPENED',{symbol:m.symbol,direction:m.direction,late:m.late===true,...(m.refollow?{refollow:true,refollowAfter:m.refollowAfter??null}:{}),leverage,qty:p.qty,avg:p.avg,stop:p.stop,stopSource:p.stopSource,stopDistPct:p.stopDistPct??null});
  return {ok:true};
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
    this.#event('LATE_ENTRY',{symbol:m.symbol,from:m.from,to:m.to,...why});
    return this.#open({...m,kind:'OPEN',entry:m.price,leverage:m.leverage,quantity:m.to,late:true},at,entry);
   }
   this.#event('SKIPPED',{symbol:m.symbol,reason:'NOT_COPIED',from:m.from,to:m.to,...why});return {ok:false,reason:'NOT_COPIED'}}
  if(p.closing){
   if(m.to>m.from)this.#event('ADD_SKIPPED',{symbol:m.symbol,reason:'CLOSING'});
   return {ok:false,reason:'CLOSING'};
  }
  const c=await this.#contract(m.symbol),ratio=m.to/m.from,now=await this.#recheck(p,await this.#position(p));p.qty=now.size;
  if(!(p.qty>0))return this.#gone(p,'POSITION_GONE',now);
  if(ratio>1){
   p.theirTotal=m.to;return this.#buyMore(p,m,m.to-m.from,{price:pos(m.price),ratio,c,now,entry});
  }else{
   const down=this.#qty(c,p.qty*(1-ratio)),up=this.#qty(c,p.qty*(1-ratio),'UP'),want=p.qty*(1-ratio);
   const cut=Math.min(p.qty,want-down<=up-want?down:up);if(!(cut>0))return {ok:true,tooSmall:true};
   if(cut>=p.qty)return this.#close(m,'TRADER_CUT_ALL');
   await this.#market(p,p.direction==='LONG'?'SELL':'BUY',Math.min(cut,p.qty),{reduceOnly:true,tag:'cut'+(p.reduces+1)});
   p.theirTotal=m.to; // set after our cut went through, so a retried cut uses the same from / to
   p.reduces++;p.steps.push({kind:'REDUCE',at:this.now(),qty:cut,ratio});
   await this.#protect(p);this.#event('REDUCED',{symbol:m.symbol,direction:p.direction,qty:cut,left:p.qty});
  }
  return {ok:true};
 }
 // One more buy of the trader's `theirQty`: 1 $ x theirQty / their first quantity (when known), else the
 // same proportion of our position as theirQty is of theirs.
 async #buyMore(p,m,theirQty,{price,ratio=null,c=null,now=null,entry}={}){
  c??=await this.#contract(p.symbol);now??=await this.#recheck(p,await this.#position(p));p.qty=now.size;
  if(!(p.qty>0))return this.#gone(p,'POSITION_GONE',now);
  // A position we are closing (p.closing: loss limit, emergency) is never added to (review 2026-11-17).
  const g=p.closing?{ok:false,reason:'CLOSING'}:this.store.killed?{ok:false,reason:'COPY_LOSS_LIMIT'}:p.adds>=this.config.maxAdds?{ok:false,reason:'COPY_MAX_ADDS'}:this.gate();if(!g.ok){this.#event(['COPY_MAX_ADDS','CLOSING'].includes(g.reason)?'ADD_SKIPPED':'SKIPPED',{symbol:p.symbol,reason:g.reason});return {ok:false,reason:g.reason}}
  price=price!=null?price*(p.mult||1):now.mark; // the message price is per coin; the venue price per contract unit
  // MIN_ORDER positions: our first quantity x their add / their first quantity (in venue units).
  const byFirst=p.scale==null&&p.sizing==='MIN_ORDER'&&p.firstQty>0&&p.theirFirstQty>0?p.firstQty*theirQty/p.theirFirstQty:null;
  const marginUSD=p.scale==null&&byFirst==null&&p.theirFirstQty>0?this.config.marginUSD*theirQty/p.theirFirstQty:null;
  const add=p.scale!=null?this.#qty(c,theirQty*p.scale/(p.mult||1)):byFirst!=null?this.#qty(c,byFirst):marginUSD!=null?this.#qty(c,marginUSD*p.leverage/price):this.#qty(c,p.qty*((ratio??((p.theirTotal+theirQty)/p.theirTotal))-1));
  // Adds below the venue minimum are carried until they add up to a valid order (no drift from the trader).
  let buy=add;
  // Both sizings: adds below the venue minimum are carried until they add up to a valid order.
  if(p.scale!=null||byFirst!=null||marginUSD!=null){const raw=(p.scale!=null?theirQty*p.scale/(p.mult||1):byFirst!=null?byFirst:marginUSD*p.leverage/price)+(p.addCarry||0),minQ=pos(c.minQuantityBase)??0,minN=pos(c.minNotionalUSDT)??0;
   buy=this.#qty(c,raw);if(!(buy>0)||buy<minQ||buy*price<minN){p.addCarry=raw;this.#event('ADD_CARRIED',{symbol:p.symbol,carry:+raw.toPrecision(6)});return {ok:true,carried:true}}
   p.addCarry=Math.max(0,raw-buy)}
  else if(!(add>0))return {ok:true,tooSmall:true};
  let fill;
  try{fill=await this.#send(p,p.direction==='LONG'?'BUY':'SELL',buy,{tag:this.#tag(p,'add')},
   {event:'ADD_RETRY',before:p.qty,step:c.quantityStep,entry,marginUSD:buy*Math.max(price,now.mark||0)/p.leverage})}
  catch(e){
   if(!e.orderBlock)throw e;
   this.#event('ADD_SKIPPED',{symbol:p.symbol,...e.orderBlock});
   return {ok:false,reason:e.orderBlock.reason};
  }
  p.adds++;
  p.steps.push({kind:'ADD',at:this.now(),qty:fill.qty??buy,avg:fill.avg,theirQty,marginUSD});this.#save();
  await this.#protect(p);if(p.status!=='OPEN')return {ok:false,reason:p.closeReason};
  this.#event('ADDED',{symbol:p.symbol,direction:p.direction,qty:buy,total:p.qty,avg:p.avg,stop:p.stop,n:p.adds,marginUSD:marginUSD!=null?+marginUSD.toFixed(2):null});
  return {ok:true};
 }
 async #close(m,reason){
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
   if(typeof this.client.getOrder!=='function')return {ok:false,reason:'CLOSE_PENDING'};
   try{
    const order=orderOf(await this.client.getOrder(p.venueSymbol,{clientOrderId:this.#clientId(p,close.pending.tag)}));
    this.#rememberFillOrder(p,order?.orderId,side,Number(order?.executedQty)>0||order?.status==='FILLED');
    if(!['FILLED','CANCELED','CANCELLED','REJECTED','EXPIRED','FAILED'].includes(String(order?.status).toUpperCase()))return {ok:false,reason:'CLOSE_PENDING'};
   }catch(error){if(!orderAbsent(error))return {ok:false,reason:'CLOSE_PENDING'}}
   delete close.pending;
   now=await this.#recheck(p,await this.#position(p));
   if(!(now.size>0)){await this.#completeClose(p,reason,now);return {ok:true}}
  }
  p.qty=now.size;
  const tag=this.#tag(p,'close');
  close.pending={tag};this.#save();
  let order;
  try{order=await this.#market(p,side,now.size,{reduceOnly:true,tag})}
  catch(error){
   if(error.code==='HTTP_429'||(/^VENUE_ERROR_\d+$/.test(error.code||'')&&!/duplicate|exist/i.test(error.message||'')))delete close.pending;
   this.#save();throw error;
  }
  if(['FILLED','CANCELED','CANCELLED','REJECTED','EXPIRED','FAILED'].includes(String(order.status).toUpperCase()))delete close.pending;
  this.#save();
  const after=await this.#recheck(p,await this.#position(p));
  if(!(after.size>0)){await this.#completeClose(p,reason,now);return {ok:true}}
  if(after.size<now.size)close.partial=true;
  p.qty=after.size;p.unrealized=after.unrealized;this.#save();
  this.#event('CLOSE_RETRY',{symbol:p.symbol,reason:'CLOSE_PENDING',detail:`청산 중 · 거래소 잔여 ${after.size}`});
  return {ok:false,reason:'CLOSE_PENDING'};
 }
 async #completeClose(p,reason,now,theirPnlUSD=null){
  if(p.stopOrderId){try{await this.client.cancelOrder(p.venueSymbol,p.stopOrderId)}catch{}}
  this.#closed(p,reason,now,p.closing?.theirPnlUSD??theirPnlUSD);
 }
 // Realized result: the venue's unrealized PnL just before the close (an estimate: fees not included).
 // A close of ours that was under way (p.closing) is booked under its own reason. Booked once per position; the
 // ledger slot is freed only when it still holds this position.
 #closed(p,reason,now,theirPnlUSD=null){
  if(this.store.closed.some(x=>x.id===p.id))return;
  reason=p.closing?.reason??reason;
  p.status='CLOSED';p.closedAt=this.now();p.closeReason=reason;delete p.inflight;
  const estimate=p.closing?.partial?null:now?.unrealized??null;
  const row={...p,netUSD:estimate,netSource:estimate!=null?'ESTIMATE_BEFORE_FEES':'UNKNOWN',theirPnlUSD};
  this.store.closed.push(row);const key=this.#key(p);if(this.store.positions[key]===p)delete this.store.positions[key];
  this.#event('CLOSED',{symbol:p.symbol,direction:p.direction,reason,netUSD:row.netUSD,theirPnlUSD,adds:p.adds,...(p.closeEvidence?{evidence:p.closeEvidence.kind}:{})});
 }
 /** Per-position exchange settlement by exact order id, run outside the order queue. */
 settle(){
  if(typeof this.client?.fillOrders!=='function')return Promise.resolve();
  if(this.settling)return this.settling;
  this.settling=this.#settleClosed().finally(()=>{this.settling=null});
  return this.settling;
 }
 async #settleClosed(){
  const now=this.now();
  const due=this.store.closed.filter(p=>!['EXCHANGE','EXCHANGE_FILLS'].includes(p.netSource)
   &&(p.fillOrders?.length||p.entryCids?.length&&typeof this.client.allOrders==='function')
   &&now-p.closedAt>=15000&&now-p.closedAt<7*86400000&&p.closedAt-p.openedAt<7*86400000);
  const valid=new Set(due.map(p=>p.id));
  for(const key of this.settleAttempts.keys())if(!valid.has(key))this.settleAttempts.delete(key);
  const next=due.filter(p=>!this.settleAttempts.has(p.id)||now-this.settleAttempts.get(p.id)>=5*60000)
   .sort((a,b)=>(this.settleAttempts.get(a.id)??0)-(this.settleAttempts.get(b.id)??0)||b.closedAt-a.closedAt)[0];
  if(next){
   const p=next;
   this.settleAttempts.set(p.id,now);
   try{
    const window={startTs:Math.max(1,p.openedAt-60000),endTs:Math.min(now,p.closedAt+30000)};
    const orders=p.fillTracked?new Map((p.fillOrders||[]).map(o=>[o.id,o])):await this.#legacyOrders(p,window);
    if(!orders.size||orders.size>64)return;
    const raw=[];
    for(const [orderId,order] of orders){
     const receipts=executionFills(await this.client.fillOrders({...window,orderId}));
     const owned=receipts.filter(f=>f.orderId===orderId&&f.symbol===p.venueSymbol&&f.side===order.side&&f.at>=window.startTs&&f.at<=window.endTs);
     if(order.confirmed&&!owned.length)return;
     raw.push(...owned);
    }
    const fills=raw.sort((a,b)=>a.at-b.at||a.tradeId.length-b.tradeId.length||a.tradeId.localeCompare(b.tradeId));
    const result=summarizeBalancedFills(fills,p.direction);
    if(!result||this.store.closed.indexOf(p)<0)return;
    Object.assign(p,{netSource:'EXCHANGE_FILLS',netUSD:result.netUSD,pnlUSD:result.pnlUSD,feeUSD:result.feeUSD,settledAt:now});
    this.#save();
   }catch(error){this.log(`[COPY] fill settlement ${error?.code||error?.message||'FAILED'}`)}
  }
 }
 async #legacyOrders(p,{startTs,endTs}){
  if(typeof this.client.allOrders!=='function')return new Map();
  const openSide=p.direction==='LONG'?'BUY':'SELL',closeSide=openSide==='BUY'?'SELL':'BUY';
  const orders=new Map((p.fillOrders||[]).map(o=>[o.id,o]));
  const owned=new Set(p.entryCids||[]);
  owned.add(this.#clientId(p,'close'));
  for(let sequence=1;sequence<=Math.min(128,Number(p.orderSeq)||0);sequence++)
   for(const tag of ['open','add','close','emergency'])owned.add(this.#clientId(p,`${tag}.${sequence}`));
  for(let cut=1;cut<=Math.min(64,Number(p.reduces)||0);cut++)owned.add(this.#clientId(p,'cut'+cut));
  for(const row of rowsOf(await this.client.allOrders({symbol:p.venueSymbol,startTime:startTs,endTime:endTs,limit:500}))){
   const id=row?.orderId==null?null:String(row.orderId),side=String(row?.side).toUpperCase();
   if(id&&(owned.has(String(row.clientOrderId).toLowerCase())||id===String(p.stopOrderId))&&[openSide,closeSide].includes(side)){
    orders.set(id,{id,side,confirmed:Number(row.executedQty)>0||row.status==='FILLED'});
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
  const c=this.client,to=this.now(),from=Math.max(0,(p.seenAt??p.openedAt??to)-60000);
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
  const p=this.queue.then(()=>this.#reconcile()).finally(()=>{this.pendingCount--;this.reconciling=null});
  this.queue=p.catch(()=>{});this.reconciling=p;return p;
 }
 async #reconcile(){
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
     p.steps=[{kind:'ADOPTED',at:this.now(),qty:now.size}]}
    // A close of ours that did not go through (no answer, a refusal): closed again.
    if(p.closing&&!['TRADER_CLOSE','TRADER_CUT_ALL'].includes(p.closing.reason)){await this.#emergency(p,p.closing.reason);continue}
    p.qty=now.size;p.avg=now.avg??p.avg;p.unrealized=now.unrealized;p.mark=now.mark;unrealized+=Number(now.unrealized)||0;
    if(this.config.stops&&(!p.stopOrderId||p.stopStale)||!this.config.stops&&p.stopOrderId)await this.#protect(p);
    if(this.config.stops&&p.stopZone&&await this.#zoneBroken(p).catch(()=>false)){await this.#emergency(p,'ZONE_BREAK_VOLUME');continue}
   }catch(error){if(error.code==='HTTP_429')break}
  }
  const bal=await this.balance().catch(()=>null),eq=pos(bal?.equity);
  if(bal)this.funds={equity:num(bal.equity),available:num(bal.available),at:this.now()};
  if(eq&&!this.store.killed&&unrealized<=-eq*this.config.ledgerLossPct/100){
   this.store.killed=true;this.#event('COPY_LOSS_LIMIT',{reason:`open loss ${unrealized.toFixed(2)} ≤ -${this.config.ledgerLossPct}% of ${eq.toFixed(2)}`});this.#save(); // on disk before any order
   for(const p of Object.values(this.store.positions).filter(x=>x.status==='OPEN'&&!x.closing?.pending))await this.#emergency(p,'COPY_LOSS_LIMIT');
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
