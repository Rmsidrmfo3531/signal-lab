// 급변 알림 초단타 (PUMP_FADE, user 2026-11-25 14:23 / 14:30 / 14:32 / 14:34): a separate TESTNET strategy on the 공습경보
// alerts beside the 5m scalp's pump hand-off. Fake venue only: no network, no real order.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {PumpFadeExecutor,pumpFadeConfig,pumpFadeRules,fadeConfirm,fadeTurn,fadeLevels,fadeSize,fadeSimulate,pumpFadeSimulation,atr1mPct,pumpFadeEventText,pumpFadeJournalLine,
 PUMP_FADE_DEFAULTS,PUMP_FADE_COST_PCT,PUMP_FADE_STRATEGY} from '../pump_fade.mjs';
import {PumpAlertBook,pumpAlertEndpoint,pumpAlertRows,summarizePumpAlerts,PUMP_COST_PCT} from '../pump_alert.mjs';
import {ScalpExecutor,scalpExecConfig} from '../scalp_executor.mjs';
import {appendJsonl,summarizeJournal,SCALP_JOURNAL_FILE} from '../scalp_journal.mjs';
import {evaluateReadiness,scalpGroupReadiness,readinessMessage,READY_GROUPS,READY_LABELS,READY_PUMP_SCALP_BIG_LOSS_EXIT_REASONS} from '../ready_check.mjs';
import {reasonInfo,reasonLabel} from '../public/scalp_reasons.js';
import {pumpFadeHTML,testnetCloses} from '../public/live_control.js';
import {testnetStats} from '../live_overview.mjs';

const M=60000,m0=Date.parse('2026-11-25T05:30:00Z'),AT=m0+20000;
const tmp=()=>fs.mkdtempSync(path.join(os.tmpdir(),'pump-fade-'));
const SOL={symbol:'SOLUSDT',venueSymbol:'SOL-USDT',tickSize:'0.01',quantityStep:'0.01',minQuantityBase:'0.01',minNotionalUSDT:2,tradable:true};
// 1m rows [open, o, h, l, c, v, closeTime, qv] from [o,h,l,c] starting at `start`.
const bars=(start,list)=>list.map(([o,h,l,c],i)=>[start+i*M,String(o),String(h),String(l),String(c),'10',start+(i+1)*M-1,'0']);
// 20 quiet bars before the move, three red bars ending with the alert's minute (100 -> 93, 7 %), then `after` from m0+1 min.
const RED3=[[100,100.2,97.4,97.5],[97.5,97.6,94.9,95],[95,95.1,92.8,93]];
const GREEN3=RED3.map(([o,h,l,c])=>[200-o,200-l,200-h,200-c]);
const quiet=Array.from({length:20},(_,i)=>[100,100.1,99.9,100+(i%2?.05:-.05)]);
function series({three=RED3,after=[[93,94.2,92.9,94]],tail=20,flat=null}={}){
 const last=after.length?after.at(-1)[3]:three.at(-1)[3],f=flat??last;
 return bars(m0-22*M,[...quiet,...three,...after,...Array.from({length:tail},()=>[f,f+.05,f-.05,f])]);
}

// BingX fake: one-way (signed positionAmt) or hedge (one row per side).
function venue({hedge=false,fillAt=94.02,maxLev=20,failStop=false,mode='TESTNET'}={}){
 const calls=[],orders=new Map();let amt=0,avg=0,mark=0,id=1;
 const add=(p,extra={})=>{const o={orderId:String(id++),...p,status:'NEW',...extra};orders.set(o.orderId,o);return o};
 const reduce=q=>{amt=amt>0?+Math.max(0,amt-q).toFixed(8):+Math.min(0,amt+q).toFixed(8)};
 const rows=()=>amt===0?[]:hedge?[{symbol:'SOL-USDT',positionSide:amt>0?'LONG':'SHORT',positionAmt:String(Math.abs(amt)),avgPrice:String(avg),markPrice:String(mark||avg)}]
  :[{symbol:'SOL-USDT',positionSide:'BOTH',positionAmt:String(amt),avgPrice:String(avg),markPrice:String(mark||avg)}];
 const client={mode,
  positionMode:async()=>({dualSidePosition:hedge}),marginType:async()=>({marginType:'CROSSED'}),setMarginType:async()=>({}),
  leverage:async()=>({maxLongLeverage:maxLev,maxShortLeverage:maxLev}),setLeverage:async(s,side,l)=>{calls.push({op:'lev',side,l});return {leverage:l}},
  positions:async()=>rows(),openOrders:async()=>({orders:[...orders.values()].filter(o=>o.status==='NEW')}),
  getOrder:async(s,{orderId,clientOrderId})=>({order:[...orders.values()].find(o=>orderId?o.orderId===orderId:o.clientOrderId===clientOrderId)??null}),
  cancelOrder:async(s,oid)=>{calls.push({op:'cancel',oid});const o=orders.get(oid);if(o&&o.status==='NEW')o.status='CANCELED';return {}},
  placeOrder:async(p,{beforeSend}={})=>{const reason=beforeSend?.();if(reason)throw Object.assign(Error(reason),{code:'ENTRY_NOT_SENT',reason});calls.push({op:'order',...p});
   if(p.type==='STOP_MARKET'){if(failStop)throw Object.assign(Error('no'),{code:'VENUE_ERROR_1'});return {order:add(p)}}
   if(p.type==='LIMIT')return {order:add(p)};
   if(p.type==='MARKET'){const q=Number(p.quantity),closing=p.reduceOnly==='true'||(hedge&&((p.positionSide==='LONG'&&p.side==='SELL')||(p.positionSide==='SHORT'&&p.side==='BUY')));
    if(closing){reduce(q);return {order:add(p,{status:'FILLED',executedQty:String(q),avgPrice:String(mark||avg)})}}
    avg=fillAt;amt=+(amt+(p.side==='SELL'?-q:q)).toFixed(8);return {order:add(p,{status:'FILLED',executedQty:String(q),avgPrice:String(fillAt)})}}
   return {order:add(p)}}};
 return {client,calls,orders,set mark(v){mark=v},get amt(){return amt},
  placed:type=>calls.filter(c=>c.op==='order'&&c.type===type),
  fill(o,price){o.status='FILLED';o.executedQty=String(Math.abs(amt));o.avgPrice=String(price);reduce(Math.abs(amt))}};
}
function make({v=venue(),clock={t:AT+5000},rows=()=>series(),config={},busy=()=>false,active=()=>true,funds={equity:10000,available:9000},btc=null,dir=null,journalFile=null,budget=null,contracts=null}={}){
 const results=[];
 const ex=new PumpFadeExecutor({config:{...pumpFadeConfig({}),...config},client:v.client,contracts:async()=>contracts??new Map([['SOLUSDT',SOL]]),
  candles1m:async()=>rows(),btcCandles:async()=>btc??[[m0-5*M,'60000','60010','59990','60000','1',m0-4*M-1,'0'],[m0-4*M,'60000','60010','59990','60000','1',m0-3*M-1,'0']],
  balance:async()=>funds,isBusy:busy,active,now:()=>clock.t,directory:dir,journalFile,budget,onResult:(k,r)=>results.push([k,r])});
 return {v,ex,clock,results};
}
const ALERT={symbol:'SOLUSDT',dir:'DOWN',pct:11.6,low:92.8,high:100.2,price:93,at:AT,key:'bot:1'};
async function toEntry(m){m.clock.t=m0+M+3000;await m.ex.tick();m.clock.t=m0+2*M+3000;await m.ex.tick()}

test('config: on by default for TESTNET; off, LIVE and a non-testnet scalp mode are refused',()=>{
 const c=pumpFadeConfig({});
 assert.equal(c.mode,'TESTNET');assert.equal(c.refused,null);
 assert.deepEqual([c.maxAgeSec,c.confirmBars,c.minMovePct,c.turnWaitMin,c.tpMinPct,c.tpRangeMult,c.slMinPct,c.slRangeMult,c.maxHoldMin,c.riskPct,c.leverage,c.maxMarginPct,c.makerWaitMs],
  [180,3,6,5,1.5,.15,3,.3,15,.5,10,10,0]);
 assert.deepEqual([pumpFadeConfig({PUMP_FADE:'off'}).mode,pumpFadeConfig({PUMP_FADE:'off'}).refused],['OFF','PUMP_FADE_OFF']);
 assert.deepEqual([pumpFadeConfig({PUMP_FADE:'LIVE'}).mode,pumpFadeConfig({PUMP_FADE:'LIVE'}).refused],['OFF','LIVE_REFUSED']);
 assert.equal(pumpFadeConfig({PUMP_FADE:'real'}).refused,'MODE_INVALID');
 assert.deepEqual([pumpFadeConfig({SCALP_EXEC_MODE:'LIVE'}).mode,pumpFadeConfig({SCALP_EXEC_MODE:'OFF'}).refused],['OFF','PUMP_FADE_TESTNET_ONLY']);
 // Every value configurable within bounds; the maker window never above 5 s.
 const e=pumpFadeConfig({PUMP_FADE_MIN_MOVE_PCT:'8',PUMP_FADE_TP_MIN_PCT:'2',PUMP_FADE_SL_R_MULT:'.4',PUMP_FADE_MAX_HOLD_MIN:'10',PUMP_FADE_RISK_PCT:'.25',PUMP_FADE_MAKER_WAIT_MS:'9000'});
 assert.deepEqual([e.minMovePct,e.tpMinPct,e.slRangeMult,e.maxHoldMin,e.riskPct,e.makerWaitMs],[8,2,.4,10,.25,0]);
 assert.equal(pumpFadeConfig({PUMP_FADE_MAKER_WAIT_MS:'4000'}).makerWaitMs,4000);
 assert.equal(PUMP_FADE_COST_PCT,PUMP_COST_PCT,'the same cost as the alert tracking');
});

test('LIVE refused: a LIVE client or a LIVE mode never constructs; OFF never orders',async()=>{
 assert.throws(()=>new PumpFadeExecutor({config:pumpFadeConfig({}),client:{mode:'LIVE'}}),/PUMP_FADE_TESTNET_ONLY/);
 assert.throws(()=>new PumpFadeExecutor({config:{...pumpFadeConfig({}),mode:'LIVE'}}),/PUMP_FADE_TESTNET_ONLY/);
 const v=venue(),off=make({v,config:pumpFadeConfig({PUMP_FADE:'LIVE'})});
 assert.equal((await off.ex.onAlert(ALERT)).reason,'LIVE_REFUSED');
 await toEntry(off);assert.equal(v.calls.length,0);
 const noKey=new PumpFadeExecutor({config:pumpFadeConfig({}),now:()=>AT});
 assert.equal((await noKey.onAlert(ALERT)).reason,'CREDENTIALS_MISSING');
 const disarmed=make({active:()=>false});assert.equal((await disarmed.ex.onAlert(ALERT)).reason,'NOT_ARMED');
});

test('1m confirmation: three candles of the alert colour and the minimum combined move',()=>{
 const now=m0+M+3000;
 const ok=fadeConfirm(series(),{at:AT,dir:'DOWN',bars:3,minMovePct:6,now});
 assert.equal(ok.ok,true);assert.equal(ok.movePct,7);assert.deepEqual(ok.colours,['DOWN','DOWN','DOWN']);assert.equal(ok.extreme,92.8);assert.equal(+ok.range.toFixed(4),7.4);
 const mixed=fadeConfirm(series({three:[RED3[0],[95,97.6,94.9,97.4],RED3[2]]}),{at:AT,dir:'DOWN',now});
 assert.deepEqual([mixed.ok,mixed.reason,mixed.detail],[false,'PUMP_FADE_NOT_CONFIRMED','음봉 2/3']);
 const small=fadeConfirm(series(),{at:AT,dir:'DOWN',minMovePct:8,now});
 assert.equal(small.ok,false);assert.match(small.detail,/7\.00% < 8%/);
 const up=fadeConfirm(series({three:GREEN3}),{at:AT,dir:'UP',now});assert.equal(up.ok,true);assert.equal(up.extreme,107.2);
 assert.equal(fadeConfirm(series({three:GREEN3}),{at:AT,dir:'DOWN',now}).ok,false,'green bars never confirm a DOWN alert');
 // The alert's own minute must have closed.
 assert.equal(fadeConfirm(series(),{at:AT,dir:'DOWN',now:m0+30000}).reason,'PUMP_FADE_CANDLES_MISSING');
});

test('opposite candle: the first one within 5 min, the wait, and the timeout',()=>{
 const t=fadeTurn(series({after:[[93,93.2,92,92.5],[92.5,93.5,92.4,93.3]]}),{at:AT,dir:'DOWN',waitMin:5,now:m0+4*M});
 assert.equal(t.found,true);assert.equal(t.closeAt,m0+3*M);assert.equal(t.close,93.3);assert.equal(t.minutes,+((m0+3*M-AT)/M).toFixed(2));
 // Still red so far, deadline not reached: keep waiting.
 const red=[[93,93.1,92.5,92.6],[92.6,92.7,92.1,92.2],[92.2,92.3,91.8,91.9],[91.9,92,91.5,91.6],[91.6,91.7,91.2,91.3],[91.3,95,91.2,94]];
 const wait=fadeTurn(series({after:red}),{at:AT,dir:'DOWN',waitMin:5,now:m0+3*M+1000});
 assert.deepEqual([wait.found,wait.expired],[false,false]);
 // Four red candles close inside the 5 min (the 5th closes after AT + 5 min): expired, the late green one ignored.
 const late=fadeTurn(series({after:red}),{at:AT,dir:'DOWN',waitMin:5,now:m0+7*M});
 assert.deepEqual([late.found,late.expired],[false,true]);
});

test('executor: wait for the opposite candle, then LONG at market; NO_TURN when none comes in 5 min',async()=>{
 const m=make();
 const first=await m.ex.onAlert(ALERT);
 assert.deepEqual([first.entered,first.queued,first.reason],[false,true,'PUMP_FADE_WAITING']);
 m.clock.t=m0+M+3000;await m.ex.tick();
 assert.equal(m.v.placed('MARKET').length,0,'confirmed, waiting for the opposite candle');
 assert.equal(m.ex.watches.get('SOLUSDT').phase,'TURN');
 m.clock.t=m0+2*M+3000;await m.ex.tick();
 const [p]=m.ex.store.open;
 assert.equal(p.direction,'LONG');assert.equal(p.strategy,PUMP_FADE_STRATEGY);assert.equal(p.status,'OPEN');
 assert.equal(m.v.placed('MARKET').length,1);assert.equal(m.v.placed('MARKET')[0].side,'BUY');
 assert.equal(m.results.at(-1)[1].entered,true);assert.equal(m.ex.store.alerts.at(-1).status,'ENTERED');assert.equal(m.ex.store.alerts.at(-1).turnAt,m0+2*M);
 assert.match(pumpFadeEventText(m.ex.store.events.find(e=>e.type==='OPENED')),/^🟢 \[급변 초단타·테스트넷\] SOLUSDT 롱 10배 진입/);
 // No opposite candle: skipped with PUMP_FADE_NO_TURN, nothing sent.
 const red=[[93,93.1,92.5,92.6],[92.6,92.7,92.1,92.2],[92.2,92.3,91.8,91.9],[91.9,92,91.5,91.6],[91.6,91.7,91.2,91.3]];
 const n=make({rows:()=>series({after:red})});
 await n.ex.onAlert(ALERT);
 for(const t of [1,2,3,4,5,6])n.clock.t=m0+t*M+3000,await n.ex.tick();
 assert.equal(n.v.placed('MARKET').length,0);assert.equal(n.ex.store.alerts.at(-1).reason,'PUMP_FADE_NO_TURN');assert.equal(n.ex.watches.size,0);
 // Not confirmed: skipped once the alert's minute closed.
 const c=make({rows:()=>series({three:[RED3[0],[95,97.6,94.9,97.4],RED3[2]]})});
 await c.ex.onAlert(ALERT);c.clock.t=m0+M+3000;await c.ex.tick();
 assert.equal(c.ex.store.alerts.at(-1).reason,'PUMP_FADE_NOT_CONFIRMED');assert.equal(c.v.calls.length,0);
 // UP alert -> SHORT.
 const u=make({rows:()=>series({three:GREEN3,after:[[107,107.1,105.8,106]]}),v:venue({fillAt:105.98})});
 await u.ex.onAlert({...ALERT,dir:'UP'});await toEntry(u);
 assert.equal(u.ex.store.open[0].direction,'SHORT');assert.equal(u.v.placed('MARKET')[0].side,'SELL');
});

test('stale alert (over 3 min), not listed / stock-type, and a second alert for a watched coin',async()=>{
 const m=make({clock:{t:AT+181000}});
 assert.deepEqual([(await m.ex.onAlert(ALERT)).reason],['PUMP_FADE_STALE']);
 const ok=make({clock:{t:AT+170000}});assert.equal((await ok.ex.onAlert(ALERT)).queued,true);
 assert.equal((await ok.ex.onAlert(ALERT)).reason,'PUMP_FADE_ALREADY_WATCHING');
 const nc=make({contracts:new Map([['NVDAUSDT',{...SOL,symbol:'NVDAUSDT',venueSymbol:'NCSKNVDA2USD-USDT'}]])});
 assert.equal((await nc.ex.onAlert({...ALERT,symbol:'NVDAUSDT'})).reason,'PUMP_NOT_ON_BINGX');
 assert.equal((await nc.ex.onAlert({...ALERT,symbol:'ZZZUSDT'})).reason,'PUMP_NOT_ON_BINGX');
 assert.equal(nc.v.calls.length,0);
});

test('TP / SL scaled to the 3-candle range, the extreme rule, LONG and SHORT',()=>{
 const R={...pumpFadeRules(pumpFadeConfig({}))};
 // R = 10 %: TP max(1.5, 1.5) = 1.5 % net of costs, SL max(3, 3) = 3 %.
 const a=fadeLevels({direction:'LONG',entry:100,range:10,extreme:80,tick:'0.01',rules:R});
 assert.deepEqual([a.rangePct,a.tpPct,a.slPct,a.stopBasis,a.stop,a.tp],[10,1.5,3,'PCT',97,+(100*(1+(1.5+PUMP_FADE_COST_PCT)/100)).toFixed(2)]);
 // R = 20 %: TP 3 %, SL 6 %.
 const b=fadeLevels({direction:'LONG',entry:100,range:20,extreme:70,tick:'0.01',rules:R});
 assert.deepEqual([b.tpPct,b.slPct,b.stop],[3,6,94]);
 // R = 5 %: the minimums.
 assert.deepEqual([fadeLevels({direction:'LONG',entry:100,range:5,extreme:50,rules:R}).tpPct,fadeLevels({direction:'LONG',entry:100,range:5,extreme:50,rules:R}).slPct],[1.5,3]);
 // Extreme closer than SL: one tick beyond it.
 const x=fadeLevels({direction:'LONG',entry:100,range:10,extreme:98,tick:'0.01',rules:R});
 assert.deepEqual([x.stopBasis,x.stop,x.stopPct],['EXTREME',97.99,2.01]);
 // Too close (< 0.5 %) or beyond the entry: the % stop.
 assert.equal(fadeLevels({direction:'LONG',entry:100,range:10,extreme:99.8,tick:'0.01',rules:R}).stopBasis,'PCT');
 assert.equal(fadeLevels({direction:'LONG',entry:100,range:10,extreme:101,tick:'0.01',rules:R}).stopBasis,'PCT');
 // SHORT mirrored.
 const s=fadeLevels({direction:'SHORT',entry:100,range:10,extreme:120,tick:'0.01',rules:R});
 assert.deepEqual([s.stop,s.tp,s.stopBasis],[103,+(100*(1-(1.5+PUMP_FADE_COST_PCT)/100)).toFixed(2),'PCT']);
 const sx=fadeLevels({direction:'SHORT',entry:100,range:10,extreme:102,tick:'0.01',rules:R});
 assert.deepEqual([sx.stopBasis,sx.stop],['EXTREME',102.01]);
 // The executor books them from the actual fill and records them per trade.
});

test('exchange stop and target: one-way (BOTH, target reduceOnly) and hedge (own side, no reduceOnly)',async()=>{
 for(const hedge of [false,true]){
  const m=make({v:venue({hedge})});await m.ex.onAlert(ALERT);await toEntry(m);
  const p=m.ex.store.open[0];
  const [stop]=m.v.placed('STOP_MARKET'),[tp]=m.v.placed('LIMIT');
  assert.equal(stop.closePosition,'true');assert.equal(stop.side,'SELL');assert.equal(stop.workingType,'MARK_PRICE');
  assert.equal(stop.positionSide,hedge?'LONG':'BOTH');assert.equal('reduceOnly' in stop,false);
  assert.equal(Number(stop.stopPrice),p.stop);assert.ok(p.stop<p.avg);
  assert.equal(tp.side,'SELL');assert.equal(tp.positionSide,hedge?'LONG':'BOTH');assert.equal(tp.reduceOnly,hedge?undefined:'true');assert.equal(Number(tp.price),p.tp);
  assert.ok(stop.clientOrderId.startsWith(p.id));assert.equal(p.hedge,hedge);
  // Levels from the actual fill 94.02: R = 7.4 / 94.02, the 3-candle low 92.8 is closer than 3 %: stop 92.79.
  assert.equal(p.avg,94.02);assert.equal(p.levels.stopBasis,'EXTREME');assert.equal(p.stop,92.79);assert.equal(p.levels.tpPct,1.5);
  const lev=m.v.calls.find(c=>c.op==='lev');assert.equal(lev.side,hedge?'LONG':'BOTH');
 }
 // The stop cannot be placed: the position is closed at once (NO_STOP), never left unprotected.
 const f=make({v:venue({failStop:true})});await f.ex.onAlert(ALERT);await toEntry(f);
 assert.equal(f.ex.store.open.length,0);assert.equal(f.ex.store.closed[0].closeReason,'NO_STOP');assert.equal(f.v.amt,0);
 assert.ok(f.ex.store.events.some(e=>e.type==='STOP_FAILED'));
 // The stop survives a restart: a new executor on the same ledger keeps the stop order and does not place another.
 const dir=tmp();
 try{
  const a=make({dir});await a.ex.onAlert(ALERT);await toEntry(a);
  const b=new PumpFadeExecutor({config:pumpFadeConfig({}),client:a.v.client,now:()=>a.clock.t,directory:dir,active:()=>true});
  assert.equal(b.store.open[0].stopOrderId,a.ex.store.open[0].stopOrderId);
  await b.reconcile();assert.equal(a.v.placed('STOP_MARKET').length,1);
 }finally{fs.rmSync(dir,{recursive:true,force:true})}
});

test('exits: 15-minute time exit, the stop and the target filled on the venue',async()=>{
 const m=make();await m.ex.onAlert(ALERT);await toEntry(m);
 const p=m.ex.store.open[0];
 m.v.mark=94.5;m.clock.t=p.openedAt+14*M;await m.ex.reconcile();assert.equal(m.ex.store.open.length,1);
 m.clock.t=p.openedAt+15*M;await m.ex.reconcile();
 assert.equal(m.ex.store.open.length,0);const x=m.ex.store.closed[0];
 assert.equal(x.closeReason,'PUMP_FADE_TIME');assert.equal(m.v.amt,0);
 const exit=m.v.placed('MARKET').at(-1);assert.equal(exit.reduceOnly,'true');assert.equal(exit.side,'SELL');
 assert.ok([...m.v.orders.values()].filter(o=>o.type==='STOP_MARKET'||o.type==='LIMIT').every(o=>o.status==='CANCELED'),'stop and target cancelled');
 assert.match(pumpFadeEventText(m.ex.store.events.find(e=>e.type==='CLOSED')),/청산 · 초단타 시간 청산/);
 // Stop filled on the venue.
 const s=make();await s.ex.onAlert(ALERT);await toEntry(s);
 s.v.fill([...s.v.orders.values()].find(o=>o.type==='STOP_MARKET'),92.79);
 await s.ex.reconcile();await s.ex.reconcile();
 assert.equal(s.ex.store.closed[0].closeReason,'PUMP_FADE_SL');assert.ok(s.ex.store.closed[0].netUSD<0);
 // Target filled.
 const t=make();await t.ex.onAlert(ALERT);await toEntry(t);
 t.v.fill([...t.v.orders.values()].find(o=>o.type==='LIMIT'),t.ex.store.open[0].tp);
 await t.ex.reconcile();await t.ex.reconcile();
 assert.equal(t.ex.store.closed[0].closeReason,'PUMP_FADE_TP');assert.ok(t.ex.store.closed[0].netUSD>0);
});

test('sizing: 0.5 % of equity to the stop, the 10 % margin cap, the free margin and the minimum; no adds',()=>{
 const base={equity:10000,available:9000,entry:100,leverage:10,riskPct:.5,maxMarginPct:10,takerRate:.0006,contract:SOL};
 const a=fadeSize({...base,stop:97});
 assert.equal(a.ok,true);assert.equal(a.capped,null);
 assert.ok(Math.abs(a.riskUSD-50)<0.05,'risk = 0.5 % of 10,000 at the stop, costs included');
 const tight=fadeSize({...base,stop:99.9});
 assert.equal(tight.capped,'MARGIN_CAP');assert.equal(tight.marginUSD,1000);assert.ok(tight.riskUSD<50);
 const poor=fadeSize({...base,stop:99.9,available:500});assert.equal(poor.capped,'FREE_MARGIN');assert.equal(poor.marginUSD,450);
 assert.equal(fadeSize({...base,equity:10,stop:97,contract:{...SOL,minQuantityBase:'1'}}).reason,'QUANTITY_BELOW_MINIMUM');
 assert.equal(fadeSize({...base,stop:97,leverage:20}).marginUSD,+(a.qty*100/20).toFixed(4));
 assert.equal(PUMP_FADE_DEFAULTS.riskPct,.5);
});

test('executor sizing on entry: leverage within the venue maximum, the shared budget can refuse',async()=>{
 const m=make({v:venue({maxLev:5})});await m.ex.onAlert(ALERT);await toEntry(m);
 assert.equal(m.ex.store.open[0].leverage,5);assert.ok(m.ex.store.open[0].marginUSD<=1000+1e-6);
 const budget={stopped:()=>false,check:()=>({ok:false,reason:'OPEN_RISK_LIMIT',detail:'x'})};
 const b=make({budget});await b.ex.onAlert(ALERT);await toEntry(b);
 assert.equal(b.ex.store.alerts.at(-1).reason,'OPEN_RISK_LIMIT');assert.equal(b.v.placed('MARKET').length,0);
 // BTC shock guard (the scalp's thresholds): a BTC dump blocks the LONG.
 const btc=[[m0-3*M,'60000','60000','58900','59000','1',m0-2*M-1,'0'],[m0-2*M,'59000','59000','58000','58100','1',m0-M-1,'0']];
 const g=make({btc});await g.ex.onAlert(ALERT);await toEntry(g);
 assert.equal(g.ex.store.alerts.at(-1).reason,'BTC_DUMP_GUARD');assert.equal(g.v.placed('MARKET').length,0);
});

test('one position per symbol across the scalps: the other strategy holds -> skip; ours is reserved while entering',async()=>{
 let busy=false;
 const m=make({busy:()=>busy});busy=true;
 assert.equal((await m.ex.onAlert(ALERT)).reason,'SYMBOL_HELD_BY_OTHER_STRATEGY');
 // The 5m scalp takes the coin while we wait for the opposite candle: skipped at entry, nothing sent.
 busy=false;const w=make({busy:()=>busy});await w.ex.onAlert(ALERT);busy=true;await toEntry(w);
 assert.equal(w.ex.store.alerts.at(-1).reason,'SYMBOL_HELD_BY_OTHER_STRATEGY');assert.equal(w.v.placed('MARKET').length,0);
 // Ours holds it: heldSymbols names the coin and its venue symbol for the scalp's isBusy; a 2nd alert is not taken.
 const h=make();await h.ex.onAlert(ALERT);await toEntry(h);
 assert.ok(h.ex.heldSymbols().has('SOLUSDT')&&h.ex.heldSymbols().has('SOL-USDT'));
 h.clock.t=m0+3*M;assert.equal((await h.ex.onAlert({...ALERT,at:m0+3*M,key:'bot:2'})).reason,'SYMBOL_ALREADY_HELD');
 // The 5m scalp with the server's isBusy (our heldSymbols) skips the coin the 초단타 holds.
 const scalp=new ScalpExecutor({config:{...scalpExecConfig({}),pumpAlerts:true},isBusy:(s,vs)=>h.ex.heldSymbols().has(s)||h.ex.heldSymbols().has(vs)});
 assert.equal(scalp.isBusy('SOLUSDT','SOL-USDT'),true);
 // Server wiring: both directions, and both strategies still get every alert (the 5m hand-off kept).
 const server=fs.readFileSync(new URL('../server.mjs',import.meta.url),'utf8');
 assert.match(server,/scalpExec=new ScalpExecutor\(\{[\s\S]*?isBusy:\(symbol,venueSymbol\)=>Boolean\(pumpFade\?\.heldSymbols\(\)\.has\(symbol\)/);
 assert.match(server,/pumpFade=new PumpFadeExecutor\(\{[\s\S]*?isBusy:\(symbol,venueSymbol\)=>Boolean\(scalpExec\?\.heldSymbols\(\)\.has\(symbol\)/);
 assert.match(server,/onAlert:SCALP_EXEC\.mode==='TESTNET'&&scalpClient\?\.mode==='TESTNET'\?alert=>scalpExec\.pumpAlert\(alert\):null,\s*onFade:PUMP_FADE\.mode==='TESTNET'/);
 assert.match(server,/externalHeld:[^\n]*pumpFade\?\.heldSymbols\(\)/);
});

test('endpoint: one alert goes to both strategies; each decision kept apart on the record',async()=>{
 const book=new PumpAlertBook({now:()=>AT});const TOKEN='t'.repeat(32);
 const body={id:7,chat:'bot',date:AT,text:'🚨🚨 공습경보 SOLUSDT 🚨🚨\n3분 변동성 11.6% ↓\nlow 92.8 ↔ high 100.2\n현재 93 (틱 12)'};
 const seen=[];
 pumpAlertEndpoint({token:TOKEN,want:TOKEN,body,book,onAlert:a=>{seen.push('scalp');return {entered:false,reason:'PUMP_NO_REVERSAL'}},onFade:a=>{seen.push('fade');return {entered:false,queued:true,reason:'PUMP_FADE_WAITING'}}});
 await new Promise(r=>setTimeout(r,10));
 assert.deepEqual(seen.sort(),['fade','scalp']);
 const rec=book.records[0];
 assert.equal(rec.scalp.reason,'PUMP_NO_REVERSAL');assert.deepEqual([rec.fade.status,rec.fade.reason],['WAITING','PUMP_FADE_WAITING']);
 book.attachFade(rec.key,{entered:true,turnAt:m0+2*M,turnMinutes:1.67,tradeId:'pfabc',confirm:{passed:true,movePct:7,colours:['DOWN','DOWN','DOWN']}});
 assert.deepEqual([rec.fade.status,rec.fade.entered,rec.fade.turnAt,rec.fade.confirm.passed,rec.scalp.reason],['ENTERED',true,m0+2*M,true,'PUMP_NO_REVERSAL']);
});

test('records: per-alert simulation (ATR, R, confirmation, opposite candle, mode A / B), tracking and the 200-alert export',async()=>{
 const rows=series({after:[[93,94.2,92.9,94],[94,96.5,93.9,96.3]],tail:70,flat:96.3});
 const sim=pumpFadeSimulation({at:AT,dir:'DOWN',rows,now:m0+70*M,rules:pumpFadeRules(pumpFadeConfig({}))});
 assert.equal(sim.confirm.passed,true);assert.equal(sim.rangePct,+(7.4/93*100).toFixed(4));assert.ok(sim.atr1mPct>0&&sim.atr1mPct<1);
 assert.deepEqual([sim.turn.at,sim.turn.close],[m0+2*M,94]);
 // A: entry 93 at the confirmation close, TP 93 × (1 + 1.67 %) = 94.55 hit by the 96.5 high.
 assert.deepEqual([sim.A.entry,sim.A.exit,sim.A.netPct],[93,'TP',1.5]);
 // B: entry 94 at the opposite close; stop 92.8 (3-candle low, closer than 3 %), TP 95.57 hit next minute.
 assert.deepEqual([sim.B.entry,sim.B.exit,sim.B.stopBasis,sim.B.netPct],[94,'TP','EXTREME',1.5]);
 // A stop: the price falls again after the turn.
 const down=pumpFadeSimulation({at:AT,dir:'DOWN',rows:series({after:[[93,94.2,92.9,94],[94,94.1,90,90.5]],tail:20,flat:90.5}),now:m0+40*M});
 assert.equal(down.B.exit,'SL');assert.ok(down.B.netPct<0);
 // Time exit after 15 min of nothing.
 const flat=pumpFadeSimulation({at:AT,dir:'DOWN',rows:series({after:[[93,94.2,92.9,94]],tail:30,flat:94.3}),now:m0+40*M});
 assert.equal(flat.B.exit,'TIME');assert.equal(flat.B.exitAt,m0+2*M+15*M);
 // Tracking computes it on the same candles and the export carries every field.
 const clock={t:m0+62*M+20000};
 const book=new PumpAlertBook({now:()=>clock.t,sources:[{name:'BINGX',klines:async()=>rows}],fadeRules:()=>pumpFadeRules(pumpFadeConfig({}))});
 book.record({id:1,date:AT,text:'🚨🚨 공습경보 SOLUSDT 🚨🚨\n3분 변동성 11.6% ↓\nlow 92.8 ↔ high 100.2\n현재 93 (틱 12)'});
 await book.track();
 assert.equal(book.records[0].fadeSim.B.exit,'TP');
 const [row]=pumpAlertRows(book.records);
 for(const k of ['atr1mPct','rangePct','confirm','turn','turnMinutes','modeA','modeB','fadeByHorizon'])assert.ok(k in row,k);
 assert.ok(row.fadeByHorizon[60].mfePct>=0&&row.fadeByHorizon[60].maePct>=0);
 assert.equal(row.modeB.exit,'TP');assert.equal(row.confirm.passed,true);assert.ok(!('key' in row),'no message ids');
 const s=summarizePumpAlerts(book.records);assert.deepEqual([s.fade.confirmed,s.fade.turned,s.fade.modeB.tp],[1,1,1]);
 assert.equal(pumpAlertRows(Array.from({length:250},(_,i)=>({at:i,symbol:'A',dir:'UP'}))).length,200);
});

test('journal, stats and the testnet list: PUMP_FADE apart from the 5m scalp',async()=>{
 const dir=tmp(),jf=path.join(dir,SCALP_JOURNAL_FILE);
 try{
  const m=make({journalFile:jf});await m.ex.onAlert(ALERT);await toEntry(m);
  m.clock.t=m.ex.store.open[0].openedAt+15*M;await m.ex.reconcile();
  const line=JSON.parse(fs.readFileSync(jf,'utf8').trim());
  assert.equal(line.strategy,'PUMP_FADE');assert.equal(line.exit.reason,'PUMP_FADE_TIME');
  for(const k of ['tpPct','slPct','stopPct','stopBasis','rangePct','riskUSD'])assert.ok(line.plan[k]!=null,k);
  assert.ok(line.confirm&&line.turn&&line.rules);
  assert.equal(m.ex.stats().trades,1);
  // The 5m scalp never counts it (its own stats / readiness), but the journal summary splits by strategy.
  appendJsonl(jf,{v:1,strategy:'SCALP_REVERSAL',id:'sc1',direction:'LONG',exit:{reason:'ALL_TARGETS',at:2},pnl:{netUSD:3}});
  const scalp=new ScalpExecutor({config:scalpExecConfig({}),directory:dir});
  assert.equal(scalp.stats().trades,1);assert.equal(scalp.readinessRows().length,1);
  const sum=summarizeJournal(JSON.parse('['+fs.readFileSync(jf,'utf8').trim().split('\n').join(',')+']'));
  assert.equal(sum.all.trades,1);assert.equal(sum.byStrategy.PUMP_FADE.trades,1);assert.equal(sum.byStrategy.SCALP_REVERSAL.trades,1);
  // Restart: the journal rows come back for its stats.
  const again=new PumpFadeExecutor({config:pumpFadeConfig({}),journalFile:jf,now:()=>m.clock.t});
  assert.equal(again.stats().trades,1);
  // Screen: badge 급변 초단타 in the one closed list, its own split in the totals, the block.
  const st=m.ex.status();
  const rows=testnetCloses({pumpFade:st});assert.equal(rows[0].scalpKind,'PUMP_FADE');
  const tot=testnetStats({scalpStats:{trades:2,wins:1,grossProfitUSD:3,grossLossUSD:1,netUSD:2},pumpFadeStats:m.ex.stats()});
  assert.equal(tot.all.trades,3);assert.equal(tot.pumpFade.trades,1);
  const html=pumpFadeHTML(st);
  assert.match(html,/상태<b>켜짐/);assert.match(html,/진입/);assert.doesNotMatch(html,/PUMP_FADE_/);
  assert.equal(pumpFadeHTML(null),'');
 }finally{fs.rmSync(dir,{recursive:true,force:true})}
});

test('readiness: group 급변 초단타 from its own trades (100, PF 1.3, halves, stop loss <= 5x the average win)',()=>{
 assert.ok(READY_GROUPS.includes('PUMP_FADE_SCALP'));assert.equal(READY_LABELS.PUMP_FADE_SCALP,'급변 초단타');
 assert.deepEqual([...READY_PUMP_SCALP_BIG_LOSS_EXIT_REASONS],['PUMP_FADE_SL','NO_STOP']);
 const T=Date.parse('2026-11-26T00:00:00Z');
 const rows=n=>Array.from({length:n},(_,i)=>({direction:i%2?'LONG':'SHORT',closedAt:T+i*M,closeReason:(i+1)%4===0?'PUMP_FADE_SL':'PUMP_FADE_TP',netUSD:(i+1)%4===0?-2:1.5}));
 const s=evaluateReadiness({scalpRows:[],pumpRecords:[],pumpFadeRows:rows(100)});
 const g=s.groups.find(x=>x.group==='PUMP_FADE_SCALP');
 assert.equal(g.ready,true);assert.equal(g.trades,100);assert.ok(g.profitFactor>=1.3);
 assert.equal(s.groups.find(x=>x.group==='SCALP_ALL').trades,0,'never mixed into the scalp groups');
 assert.equal(evaluateReadiness({pumpFadeRows:rows(99)}).groups.find(x=>x.group==='PUMP_FADE_SCALP').ready,false);
 // A stop loss more than 5x the average win fails; the same loss on a time exit is not a "big loss".
 const big=rows(100).map((x,i)=>i===99?{...x,closeReason:'PUMP_FADE_SL',netUSD:-8}:x);
 const gb=scalpGroupReadiness(big,{group:'PUMP_FADE_SCALP',bigLossReasons:READY_PUMP_SCALP_BIG_LOSS_EXIT_REASONS});
 assert.equal(gb.checks.bigLoss,true,'avg stop loss (2*24+8)/25 = 2.24 <= 5 x 1.5');
 const huge=rows(100).map(x=>x.closeReason==='PUMP_FADE_SL'?{...x,netUSD:-8}:x);
 assert.equal(scalpGroupReadiness(huge,{group:'PUMP_FADE_SCALP',bigLossReasons:READY_PUMP_SCALP_BIG_LOSS_EXIT_REASONS}).checks.bigLoss,false);
 const timeLoss=huge.map(x=>x.closeReason==='PUMP_FADE_SL'?{...x,closeReason:'PUMP_FADE_TIME'}:x);
 assert.equal(scalpGroupReadiness(timeLoss,{group:'PUMP_FADE_SCALP',bigLossReasons:READY_PUMP_SCALP_BIG_LOSS_EXIT_REASONS}).checks.bigLoss,true);
 // Halves both > 0.
 const halves=rows(100).map((x,i)=>i<50?{...x,netUSD:-1}:x);
 assert.equal(scalpGroupReadiness(halves,{group:'PUMP_FADE_SCALP',bigLossReasons:READY_PUMP_SCALP_BIG_LOSS_EXIT_REASONS}).checks.halves,false);
 assert.match(readinessMessage(g),/급변 초단타 \(테스트넷\)/);assert.match(g.line,/^급변 초단타 100\/100건/);
});

test('readiness notification: the new group is sent once like the others',async()=>{
 const {ReadinessNotifier}=await import('../ready_check.mjs');
 const T=Date.parse('2026-11-26T00:00:00Z'),sent=[];
 const rows=Array.from({length:100},(_,i)=>({direction:'LONG',closedAt:T+i*M,closeReason:'PUMP_FADE_TP',netUSD:1}));
 const n=new ReadinessNotifier({send:async t=>{sent.push(t)},now:()=>T});
 await n.check(evaluateReadiness({pumpFadeRows:rows}));await n.check(evaluateReadiness({pumpFadeRows:rows}));
 assert.equal(sent.length,1);assert.match(sent[0],/급변 초단타/);
});

test('glossary: every PUMP_FADE reason has a Korean entry; Telegram texts use labels, never codes',()=>{
 const src=fs.readFileSync(new URL('../pump_fade.mjs',import.meta.url),'utf8');
 const env=new Set([...src.matchAll(/n\('([A-Z0-9_]+)'/g)].map(m=>m[1]));
 const codes=[...new Set([...src.matchAll(/'(PUMP_FADE_[A-Z_]+)'/g)].map(m=>m[1]))].filter(c=>!env.has(c));
 assert.ok(codes.length>=12);
 for(const c of codes)assert.ok(reasonInfo(c),c);
 for(const c of ['PUMP_FADE_TP','PUMP_FADE_SL','PUMP_FADE_TIME','PUMP_FADE_NO_TURN','PUMP_FADE_NOT_CONFIRMED','PUMP_FADE_STALE'])assert.ok(!/설정값/.test(reasonInfo(c,{}).desc),c);
 assert.match(reasonInfo('PUMP_FADE_NOT_CONFIRMED',{pumpFadeMinMovePct:8}).desc,/8%/);
 const t=pumpFadeEventText({type:'CLOSED',symbol:'SOLUSDT',direction:'LONG',reason:'PUMP_FADE_SL',netUSD:-3,holdMs:120000});
 assert.match(t,/초단타 손절/);assert.doesNotMatch(t,/PUMP_FADE_SL/);
 assert.equal(pumpFadeEventText({type:'WATCH'}),null);
 assert.equal(reasonLabel('PUMP_FADE_NO_TURN'),'반대 봉 없음');
 // The journal line has no keys or order ids beyond the trade id.
 const line=pumpFadeJournalLine({id:'pf1',symbol:'S',direction:'LONG',closeReason:'PUMP_FADE_TP',netUSD:1,riskUSD:2});
 assert.equal(line.strategy,'PUMP_FADE');assert.equal(line.pnl.r,.5);
});
