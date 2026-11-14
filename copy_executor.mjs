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
import {parseCopyMessage} from './copy_parser.mjs';

export const COPY_DEFAULTS=Object.freeze({stops:false,backstopPct:50,sizing:'MIN_ORDER',traderBalanceUSD:20000,maxAdds:100,breakVolumeMult:1.5,stopMinPct:20,stopMaxPct:40,stopBufferPct:.3,marginUSD:1,maxLossPct:25,snapshotMs:120000,maxLeverage:125,maxTotalMarginPct:100,ledgerLossPct:50,minOrderMaxMarginUSD:5});
const MAX_CLOSED=300,MAX_EVENTS=200,MAX_SEEN=1000;
const num=v=>{const n=Number(v);return Number.isFinite(n)?n:null};
const pos=v=>{const n=Number(v);return Number.isFinite(n)&&n>0?n:null};
const orderOf=d=>d?.order??d;
const venueSymbolOf=s=>s.replace(/USDT$/,'-USDT');

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
 return {enabled,mode,sizing,traderBalanceUSD:n('COPY_TRADER_BALANCE_USD',COPY_DEFAULTS.traderBalanceUSD,100,1e9),marginUSD:n('COPY_MARGIN_USD',COPY_DEFAULTS.marginUSD,.1,1000),maxLossPct:n('COPY_MAX_LOSS_PCT',COPY_DEFAULTS.maxLossPct,1,90),
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
  minOrderMaxMarginUSD:n('COPY_MIN_ORDER_MAX_MARGIN_USD',COPY_DEFAULTS.minOrderMaxMarginUSD,.1,1000)};
}

export class CopyExecutor{
 constructor({fileName='copy-store.json',config,client,contractOf,markOf=async()=>null,zonesOf=async()=>[],candlesOf=async()=>[],gate=()=>({ok:true}),isBusy=()=>false,balance=async()=>null,directory=null,now=()=>Date.now(),log=()=>{},onEvent=()=>{}}){
  Object.assign(this,{config,client,contractOf,markOf,zonesOf,candlesOf,gate,isBusy,balance,now,log,onEvent});
  this.file=directory?path.join(directory,fileName):null;
  const saved=this.file&&fs.existsSync(this.file)?readStore(this.file):null;
  this.store={positions:saved?.positions||{},closed:saved?.closed||[],events:saved?.events||[],seen:saved?.seen||[],monitorStartAt:saved?.monitorStartAt||0,leverageOf:saved?.leverageOf||{},pending:saved?.pending||[],killed:saved?.killed||false};
  this.queue=Promise.resolve();this.reserved=new Set();this.armed=false;
 }
 arm(){this.armed=true;this.#event('ARMED',{mode:this.config.mode});return this.status()}
 disarm(){this.armed=false;this.#event('DISARMED',{mode:this.config.mode});return this.status()}
 #save(){if(!this.file)return;this.store.closed=this.store.closed.slice(-MAX_CLOSED);this.store.events=this.store.events.slice(-MAX_EVENTS);this.store.seen=this.store.seen.slice(-MAX_SEEN);
  fs.mkdirSync(path.dirname(this.file),{recursive:true});atomicWriteStore(this.file,{version:1,...this.store})}
 #event(type,detail={}){const e={type,at:this.now(),mode:this.config.mode,...detail};this.store.events.push(e);this.log(`[COPY] ${type} ${detail.symbol||''} ${detail.reason||''}`.trim());try{this.onEvent(e)}catch{}return e}
 /** Symbols the copy ledger holds (the signal strategy skips them). */
 heldSymbols(){return new Set([...Object.values(this.store.positions).filter(p=>p.status==='OPEN').map(p=>p.symbol),...this.reserved])}
 status(){return {funds:this.funds??null,maxAdds:this.config.maxAdds,mode:this.config.mode,armed:this.armed,stops:this.config.stops,maxAdds:this.config.maxAdds,breakVolumeMult:this.config.breakVolumeMult,sizing:this.config.sizing,traderBalanceUSD:this.config.traderBalanceUSD,stopMinPct:this.config.stopMinPct,enabled:this.config.enabled,killed:this.store.killed,pending:this.store.pending.length,maxTotalMarginPct:this.config.maxTotalMarginPct,ledgerLossPct:this.config.ledgerLossPct,marginUSD:this.config.marginUSD,maxLossPct:this.config.maxLossPct,positions:Object.values(this.store.positions),
  closed:this.store.closed.slice(-50).reverse(),events:this.store.events.slice(-30).reverse(),monitorStartAt:this.store.monitorStartAt||null}}

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
 handle(message){this.pendingCount=(this.pendingCount||0)+1;const p=this.queue.then(()=>this.#handle(message)).finally(()=>{this.pendingCount--});this.queue=p.catch(()=>{});return p}
 /** No message being processed (the update restart waits for this). */
 idle(){return !(this.pendingCount>0)}
 async #handle({id,date,text}){
  const key=String(id??createHash('sha1').update(String(text)).digest('hex'));
  if(this.store.seen.includes(key))return {ok:true,duplicate:true};
  const m=parseCopyMessage(text);
  this.store.seen.push(key);
  if(!m){this.#save();return {ok:true,ignored:true}}
  const at=num(date)??this.now();
  if(m.kind==='MONITOR_START'){this.store.monitorStartAt=at;this.#event('MONITOR_START');this.#save();return {ok:true}}
  if(!this.config.enabled){this.#event('SKIPPED',{symbol:m.symbol,reason:'COPY_OFF'});this.#save();return {ok:false,reason:'COPY_OFF'}}
  this.step=null;
  try{
   const r=m.kind==='OPEN'?await this.#open(m,at):m.kind==='CHANGE'?await this.#change(m,at):await this.#close(m,'TRADER_CLOSE');
   this.#save();return r;
  }catch(error){
   // The exchange's own message and the step that failed (user 2026-11-14: "VENUE_ERROR_109400" alone
   // could not tell a hedge-mode account from a bad leverage or quantity).
   const detail=[this.step&&`단계 ${this.step}`,error.code&&error.message&&error.message!==error.code&&`BingX: ${error.message}`].filter(Boolean).join(' · ').slice(0,200);
   this.#event('ERROR',{symbol:m.symbol,kind:m.kind,reason:error.code||error.message,...(detail?{detail}:{})});
   // A close or a cut that failed (e.g. rate limit) is tried again by the routine check; a late entry or add is not.
   const job=error.retryAs??m;if(job.kind==='CLOSE'||job.kind==='CHANGE'&&job.to<job.from)this.store.pending.push({m:job,at,tries:0});
   this.#save();return {ok:false,reason:error.code||error.message}}
 }
 #key(m){return `${m.symbol}|${m.direction}`}
 async #contract(symbol){const c=await this.contractOf(symbol);if(!c||c.tradable===false)throw Object.assign(Error('NO_BINGX_CONTRACT'),{code:'NO_BINGX_CONTRACT'});return c}
 #qty(c,raw,mode='DOWN'){try{return Number(roundDecimalToStep(mode==='DOWN'?raw*(1+1e-9):raw,c.quantityStep,mode))}catch{return 0}} // 1e-9: 299.99999… is 300
 async #position(p){const list=await this.client.positions(p.venueSymbol),row=(Array.isArray(list)?list:[]).find(x=>x.symbol===p.venueSymbol);
  return {size:row?Math.abs(Number(row.positionAmt)||0):0,avg:pos(row?.avgPrice),mark:pos(row?.markPrice),unrealized:row?num(row.unrealizedProfit):null}}
 async #market(p,side,quantity,{reduceOnly=false,tag}){
  this.step=tag==='open'?'진입 주문':'시장가 주문';
  const params={symbol:p.venueSymbol,side,positionSide:'BOTH',type:'MARKET',quantity:String(quantity),clientOrderId:('cp'+createHash('sha256').update(p.id+'|'+tag).digest('hex')).slice(0,32)};
  if(reduceOnly)params.reduceOnly='true';
  const res=orderOf(await this.client.placeOrder(params));return {orderId:res?.orderId??null,avg:pos(res?.avgPrice)};
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
   const params={symbol:p.venueSymbol,side:dir===1?'SELL':'BUY',positionSide:'BOTH',type:'STOP_MARKET',quantity:String(p.qty),stopPrice:String(stop),closePosition:'true',workingType:'MARK_PRICE'};
   try{const res=orderOf(await this.client.placeOrder(params));const old=p.stopOrderId;
    p.stop=stop;p.stopDistPctActual=+(d*100).toFixed(1);p.stopSource=d===capDist?'BALANCE_CAP':'BACKSTOP';p.stopOrderId=res?.orderId??null;p.stopStale=false;
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
       p.stopOrderId=res?.orderId??null;return}
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
 async #emergency(p,reason){
  try{const now=await this.#position(p);if(now.size>0)await this.#market(p,p.direction==='LONG'?'SELL':'BUY',now.size,{reduceOnly:true,tag:'emergency'+this.now()});this.#closed(p,reason,now)}
  catch(error){this.#event('ERROR',{symbol:p.symbol,kind:'EMERGENCY_CLOSE',reason:error.code||error.message})}
 }
 async #open(m,at){
  const key=this.#key(m),prev=this.store.positions[key];
  if(prev?.status==='OPEN'){
   // The same card again (both alert formats, or a repeat) is not a new buy: same entry price within 3 min.
   if(this.store.monitorStartAt&&at-this.store.monitorStartAt<this.config.snapshotMs)return {ok:true,snapshot:true};
   if(prev.lastTheirEntry===m.entry&&prev.lastTheirQty===m.quantity&&at-(prev.lastTheirAt||0)<180000)return {ok:true,already:true};
   if(!(m.quantity>0))return {ok:true,already:true};
   prev.lastTheirEntry=m.entry;prev.lastTheirQty=m.quantity;prev.lastTheirAt=at;
   // The trader's total follows the trader, whether or not our buy goes through.
   if(prev.theirTotal>0)prev.theirTotal+=m.quantity;
   return this.#buyMore(prev,m,m.quantity,{price:pos(m.price)??pos(m.entry)});
  }
  if(this.store.monitorStartAt&&at-this.store.monitorStartAt<this.config.snapshotMs){this.#event('SKIPPED',{symbol:m.symbol,reason:'MONITOR_RESTART_SNAPSHOT'});return {ok:false,reason:'SNAPSHOT'}}
  const g=this.gate();if(!g.ok){this.#event('SKIPPED',{symbol:m.symbol,reason:g.reason});return {ok:false,reason:g.reason}}
  if(this.isBusy(m.symbol)){this.#event('SKIPPED',{symbol:m.symbol,reason:'SYMBOL_HELD_BY_SIGNAL_STRATEGY'});return {ok:false,reason:'SYMBOL_BUSY'}}
  if(Object.values(this.store.positions).some(p=>p.status==='OPEN'&&p.symbol===m.symbol)){this.#event('SKIPPED',{symbol:m.symbol,reason:'OPPOSITE_COPY_OPEN'});return {ok:false,reason:'SYMBOL_BUSY'}}
  if(this.store.killed){this.#event('SKIPPED',{symbol:m.symbol,reason:'COPY_LOSS_LIMIT'});return {ok:false,reason:'COPY_LOSS_LIMIT'}}
  // Reserved before the first venue call, so the signal strategy cannot enter the same symbol meanwhile.
  this.reserved.add(m.symbol);
  try{return await this.#openReserved(m,at,key)}finally{this.reserved.delete(m.symbol)}
 }
 async #openReserved(m,at,key){
  const c=await this.#contract(m.symbol),venueSymbol=c.venueSymbol||venueSymbolOf(m.symbol);
  // A '- → q' change has no leverage: the last one seen for the symbol (else 10).
  if(m.leverage)this.store.leverageOf[m.symbol]=m.leverage;
  // The venue contract must be the same thing at the same price: card price x unit multiplier within
  // 10 % of the venue's last price (a stock perpetual or a 1000-coin contract that is something else, or a
  // contract that is not 1 share / 1000 coins, is refused). A contract found under another name is not
  // traded without that check.
  {const venuePrice=await Promise.race([this.markOf(venueSymbol),new Promise(r=>setTimeout(()=>r(null),3000).unref?.())]).catch(()=>null);
   const cardPrice=(pos(m.price)??pos(m.entry))*(Number(c.unitMultiplier)||1);
   if(!(venuePrice>0)){if(c.alias){this.#event('SKIPPED',{symbol:m.symbol,reason:'PRICE_UNVERIFIED'});return {ok:false,reason:'PRICE_UNVERIFIED'}}}
   else if(Math.abs(cardPrice/venuePrice-1)>.1){this.#event('SKIPPED',{symbol:m.symbol,reason:'PRICE_MISMATCH',detail:`카드 ${cardPrice} / 거래소 ${venuePrice}`});return {ok:false,reason:'PRICE_MISMATCH'}}}
  let leverage=Math.max(1,Math.min(Math.round(m.leverage||this.store.leverageOf[m.symbol]||10),this.config.maxLeverage));
  this.step='레버리지 조회';try{const info=await this.client.leverage(venueSymbol),maxL=Number(info?.maxLongLeverage??info?.maxLeverage);if(maxL>0)leverage=Math.min(leverage,maxL)}catch{}
  // Orders use positionSide BOTH (one-way mode). An account in hedge mode answers 109400 (user 2026-11-14,
  // AKEUSDT on the real account): say so before any setting or order is sent.
  {let mode=null;try{mode=await this.client.positionMode?.()}catch{}
   if(mode?.dualSidePosition===true||mode?.dualSidePosition==='true'){this.#event('SKIPPED',{symbol:m.symbol,reason:'BINGX_HEDGE_MODE'});return {ok:false,reason:'BINGX_HEDGE_MODE'}}}
  // Never add to a position already on the venue (a manual trade, or one the ledger lost): one-way mode
  // would merge them and the trader's close would then close it all (user 2026-11-14, BTC 0.005).
  this.step='거래소 포지션 확인';
  {const list=await this.client.positions(venueSymbol),row=(Array.isArray(list)?list:[]).find(x=>x.symbol===venueSymbol),size=row?Math.abs(Number(row.positionAmt)||0):0;
   if(size>0){this.#event('SKIPPED',{symbol:m.symbol,reason:'VENUE_POSITION_EXISTS',detail:`거래소에 이미 ${size} 보유`});return {ok:false,reason:'VENUE_POSITION_EXISTS'}}}
  this.step='증거금 모드 설정';
  try{await this.client.setMarginType(venueSymbol,'CROSSED')}catch{}
  this.step='레버리지 설정';
  await this.client.setLeverage(venueSymbol,'BOTH',leverage);
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
  let qty=scale!=null?this.#qty(c,m.quantity*scale/mult):minOnly?0:this.#qty(c,this.config.marginUSD*leverage/price);
  const minQ=pos(c.minQuantityBase)??0,minN=pos(c.minNotionalUSDT)??0;
  // Below the venue minimum: the smallest valid order instead (flagged: larger than the ratio asks).
  let minOrder=false;
  if(qty<minQ||qty*price<minN){qty=this.#qty(c,Math.max(minQ,minN/price*1.02),'UP');minOrder=!minOnly}
  if(minOnly&&qty*price/leverage>this.config.minOrderMaxMarginUSD){this.#event('SKIPPED',{symbol:m.symbol,reason:'MIN_ORDER_TOO_LARGE',need:+(qty*price/leverage).toFixed(2)});return {ok:false,reason:'MIN_ORDER_TOO_LARGE'}}
  // The card's quantity must be coins: with a 마진 line, quantity x price must match margin x leverage
  // (within 30 %), else it may be a contract count and is not traded.
  if(scale!=null&&m.marginUSD>0&&m.leverage>0){const implied=m.quantity*(price/mult)/(m.marginUSD*m.leverage);
   if(implied<.7||implied>1.3)throw Object.assign(Error('QUANTITY_UNIT_UNCLEAR'),{code:'QUANTITY_UNIT_UNCLEAR'})}
  {const bal=await this.balance().catch(()=>null),eq=pos(bal?.equity),used=Object.values(this.store.positions).filter(x=>x.status==='OPEN').reduce((t,x)=>t+(x.qty||0)*(x.avg||0)/(x.leverage||1),0);
   if(eq&&used+qty*price/leverage>eq*this.config.maxTotalMarginPct/100){this.#event('SKIPPED',{symbol:m.symbol,reason:'COPY_MARGIN_CAP'});return {ok:false,reason:'COPY_MARGIN_CAP'}}
   // Entries too must fit in 90 % of the free margin (the same check as the adds).
   const free=num(bal?.available);if(free!==null&&qty*price/leverage>free*.9){this.#event('SKIPPED',{symbol:m.symbol,reason:'MARGIN_SHORT',need:+(qty*price/leverage).toFixed(2),free});return {ok:false,reason:'MARGIN_SHORT'}}}
  // A venue minimum far above the planned size (an expensive stock perp, a low leverage) is not taken.
  if(minOrder&&qty*price/leverage>this.config.minOrderMaxMarginUSD){this.#event('SKIPPED',{symbol:m.symbol,reason:'MIN_ORDER_TOO_LARGE',need:+(qty*price/leverage).toFixed(2)});return {ok:false,reason:'MIN_ORDER_TOO_LARGE'}}
  if(!(qty>0))throw Object.assign(Error('QUANTITY_INVALID'),{code:'QUANTITY_INVALID'});
  const p={id:`${key}|${at}`,symbol:m.symbol,venueSymbol,direction:m.direction,leverage,tickSize:c.tickSize,status:'OPEN',openedAt:this.now(),
   scale,mult,sizing:this.config.sizing,firstQty:qty,venueAlias:c.alias??null,minOrder,theirEntry:m.entry,theirQty:m.quantity??null,theirFirstQty:m.quantity??null,theirTotal:m.quantity??null,lastTheirEntry:m.entry??null,lastTheirQty:m.quantity??null,lastTheirAt:at,theirMarginUSD:m.marginUSD??null,qty:0,avg:null,adds:0,reduces:0,stop:null,stopOrderId:null,steps:[]};
  // At most 3 s for the zones (the message queue must not wait on a slow profile); then the cap stop.
  try{const zones=await Promise.race([this.zonesOf(m.symbol,{tickSize:c.tickSize}),new Promise(r=>setTimeout(()=>r([]),3000).unref?.())]);
   const zs=this.zoneStop({direction:m.direction,entry:price/mult,zones});if(zs){p.zoneStop=zs.stop;p.stopZone=zs.zone;p.stopDistPct=zs.distPct}}catch{}
  this.store.positions[key]=p;
  const fill=await this.#market(p,m.direction==='LONG'?'BUY':'SELL',qty,{tag:'open'});
  p.steps.push({kind:'OPEN',at:this.now(),qty,avg:fill.avg});this.#save(); // a real fill is on disk before anything else
  await this.#protect(p);
  if(p.status!=='OPEN')return {ok:false,reason:p.closeReason};
  this.#event('OPENED',{symbol:m.symbol,direction:m.direction,leverage,qty:p.qty,avg:p.avg,stop:p.stop,stopSource:p.stopSource,stopDistPct:p.stopDistPct??null});
  return {ok:true};
 }
 /** Why a change card finds no copy position (user 2026-11-14, AKEUSDT): the entry was skipped (its
  * reason), our copy was closed earlier (how), or no entry card for it reached us since the copy started. */
 #whyNotCopied(m,p){
  const ev=this.store.events,lastClose=p&&p.status!=='OPEN'?p.closedAt||0:0;
  for(let i=ev.length-1;i>=0;i--){const e=ev[i];if(e.symbol!==m.symbol)continue;
   if(e.type==='OPENED')break;
   if((e.type==='SKIPPED'&&e.reason!=='NOT_COPIED')||(e.type==='ERROR'&&e.kind==='OPEN'))return {cause:e.reason||e.type,causeAt:e.at,causeDetail:e.detail??null}}
  if(lastClose)return {cause:'OUR_COPY_CLOSED',causeAt:lastClose,causeDetail:p.closeReason??null};
  return {cause:'NO_ENTRY_RECEIVED'};
 }
 async #change(m,at){
  const key=this.#key(m),p=this.store.positions[key];
  if(m.to===0)return this.#close(m,'TRADER_CLOSE');
  if(m.from===0&&(!p||p.status!=='OPEN'))return this.#open({...m,kind:'OPEN',entry:m.price,leverage:m.leverage,quantity:m.to},at);
  if(!p||p.status!=='OPEN'){this.#event('SKIPPED',{symbol:m.symbol,reason:'NOT_COPIED',from:m.from,to:m.to,...this.#whyNotCopied(m,p)});return {ok:false,reason:'NOT_COPIED'}}
  const c=await this.#contract(m.symbol),ratio=m.to/m.from,now=await this.#position(p);p.qty=now.size;
  if(!(p.qty>0)){p.status='CLOSED';this.#closed(p,'POSITION_GONE',now);return {ok:false,reason:'POSITION_GONE'}}
  if(ratio>1){
   p.theirTotal=m.to;return this.#buyMore(p,m,m.to-m.from,{price:pos(m.price),ratio,c,now});
  }else{
   const down=this.#qty(c,p.qty*(1-ratio)),up=this.#qty(c,p.qty*(1-ratio),'UP'),want=p.qty*(1-ratio);
   const cut=Math.min(p.qty,want-down<=up-want?down:up);if(!(cut>0))return {ok:true,tooSmall:true};
   if(cut>=p.qty)return this.#close(m,'TRADER_CUT_ALL');
   await this.#market(p,p.direction==='LONG'?'SELL':'BUY',Math.min(cut,p.qty),{reduceOnly:true,tag:'cut'+(p.reduces+1)});
   p.theirTotal=m.to; // set after our cut went through, so a retried cut uses the same from / to
   p.reduces++;p.steps.push({kind:'REDUCE',at:this.now(),qty:cut,ratio});
   await this.#protect(p);this.#event('REDUCED',{symbol:m.symbol,qty:cut,left:p.qty});
  }
  return {ok:true};
 }
 // One more buy of the trader's `theirQty`: 1 $ x theirQty / their first quantity (when known), else the
 // same proportion of our position as theirQty is of theirs.
 async #buyMore(p,m,theirQty,{price,ratio=null,c=null,now=null}={}){
  c??=await this.#contract(p.symbol);now??=await this.#position(p);p.qty=now.size;
  if(!(p.qty>0)){this.#closed(p,'POSITION_GONE',now);return {ok:false,reason:'POSITION_GONE'}}
  const g=this.store.killed?{ok:false,reason:'COPY_LOSS_LIMIT'}:p.adds>=this.config.maxAdds?{ok:false,reason:'COPY_MAX_ADDS'}:this.gate();if(!g.ok){this.#event(g.reason==='COPY_MAX_ADDS'?'ADD_SKIPPED':'SKIPPED',{symbol:p.symbol,reason:g.reason});return {ok:false,reason:g.reason}}
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
  const bal=await this.balance().catch(()=>null),free=num(bal?.available);
  const eq=pos(bal?.equity),used=Object.values(this.store.positions).filter(x=>x.status==='OPEN').reduce((t,x)=>t+(x.qty||0)*(x.avg||0)/(x.leverage||1),0);
  if(eq&&used+buy*price/p.leverage>eq*this.config.maxTotalMarginPct/100){this.#event('ADD_SKIPPED',{symbol:p.symbol,reason:'COPY_MARGIN_CAP',need:+(buy*price/p.leverage).toFixed(2),free:+(eq*this.config.maxTotalMarginPct/100-used).toFixed(2)});return {ok:false,reason:'COPY_MARGIN_CAP'}}
  if(free!==null&&buy*price/p.leverage>free*.9){this.#event('ADD_SKIPPED',{symbol:p.symbol,reason:'MARGIN_SHORT',need:+(buy*price/p.leverage).toFixed(2),free});return {ok:false,reason:'MARGIN_SHORT'}}
  const fill=await this.#market(p,p.direction==='LONG'?'BUY':'SELL',buy,{tag:'add'+(p.adds+1)});p.adds++;
  p.steps.push({kind:'ADD',at:this.now(),qty:buy,avg:fill.avg,theirQty,marginUSD});this.#save();
  await this.#protect(p);if(p.status!=='OPEN')return {ok:false,reason:p.closeReason};
  this.#event('ADDED',{symbol:p.symbol,qty:buy,total:p.qty,avg:p.avg,stop:p.stop,n:p.adds,marginUSD:marginUSD!=null?+marginUSD.toFixed(2):null});
  return {ok:true};
 }
 async #close(m,reason){
  const key=this.#key(m),p=this.store.positions[key];
  if(!p||p.status!=='OPEN')return {ok:true,notOpen:true};
  // A 청산 card with a quantity below the trader's position is a partial close: the same share of ours.
  // Fixed from / to, so a retry after a failure cuts the same share.
  if(m.kind==='CLOSE'&&m.quantity>0&&p.theirTotal>0&&m.quantity<p.theirTotal*.999){
   const cm={...m,kind:'CHANGE',from:p.theirTotal,to:p.theirTotal-m.quantity};
   try{return await this.#change(cm,this.now())}catch(error){error.retryAs=cm;throw error}}
  const now=await this.#position(p);
  if(now.size>0)await this.#market(p,p.direction==='LONG'?'SELL':'BUY',now.size,{reduceOnly:true,tag:'close'});
  if(p.stopOrderId){try{await this.client.cancelOrder(p.venueSymbol,p.stopOrderId)}catch{}}
  this.#closed(p,now.size>0?reason:'POSITION_GONE',now,m.theirPnlUSD);
  return {ok:true};
 }
 // Realized result: the venue's unrealized PnL just before the close (an estimate: fees not included).
 #closed(p,reason,now,theirPnlUSD=null){
  p.status='CLOSED';p.closedAt=this.now();p.closeReason=reason;
  const row={...p,netUSD:now?.unrealized??null,netSource:now?.unrealized!=null?'ESTIMATE_BEFORE_FEES':'UNKNOWN',theirPnlUSD};
  this.store.closed.push(row);delete this.store.positions[this.#key(p)];
  this.#event('CLOSED',{symbol:p.symbol,reason,netUSD:row.netUSD,theirPnlUSD,adds:p.adds});
 }
 /** Routine check: closed positions booked, missing stops placed again, failed closes / cuts retried,
  * and the whole-ledger loss limit. */
 async reconcile(){
  for(const job of this.store.pending.splice(0)){
   job.tries++;
   try{const r=job.m.kind==='CLOSE'?await this.#close(job.m,'TRADER_CLOSE'):await this.#change(job.m,job.at);if(r?.ok===false&&!['NOT_COPIED','POSITION_GONE'].includes(r.reason)&&job.tries<5)this.store.pending.push(job)}
   catch(error){if(job.tries<5)this.store.pending.push(job);else this.#event('ERROR',{symbol:job.m.symbol,kind:'RETRY_GAVE_UP',reason:error.code||error.message})}
  }
  let unrealized=0;
  for(const p of Object.values(this.store.positions).filter(x=>x.status==='OPEN')){
   try{const now=await this.#position(p);
    // One empty answer is not enough to close the ledger (a venue list can come back empty for a moment;
    // the position would stay on the venue and the next card would buy again): two checks in a row.
    if(!(now.size>0)){p.zeroSeen=(p.zeroSeen||0)+1;if(p.zeroSeen<2){this.#save();continue}
     if(p.stopOrderId){try{await this.client.cancelOrder(p.venueSymbol,p.stopOrderId)}catch{}}this.#closed(p,'STOP_OR_EXTERNAL',now);continue}
    p.zeroSeen=0;
    p.qty=now.size;p.avg=now.avg??p.avg;p.unrealized=now.unrealized;p.mark=now.mark;unrealized+=Number(now.unrealized)||0;
    if(this.config.stops&&(!p.stopOrderId||p.stopStale)||!this.config.stops&&p.stopOrderId)await this.#protect(p);
    if(this.config.stops&&p.stopZone&&await this.#zoneBroken(p).catch(()=>false)){await this.#emergency(p,'ZONE_BREAK_VOLUME');continue}
   }catch(error){if(error.code==='HTTP_429')break}
  }
  const bal=await this.balance().catch(()=>null),eq=pos(bal?.equity);
  if(bal)this.funds={equity:num(bal.equity),available:num(bal.available),at:this.now()};
  if(eq&&!this.store.killed&&unrealized<=-eq*this.config.ledgerLossPct/100){
   this.store.killed=true;this.#event('COPY_LOSS_LIMIT',{reason:`open loss ${unrealized.toFixed(2)} ≤ -${this.config.ledgerLossPct}% of ${eq.toFixed(2)}`});
   for(const p of Object.values(this.store.positions).filter(x=>x.status==='OPEN'))await this.#emergency(p,'COPY_LOSS_LIMIT');
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
