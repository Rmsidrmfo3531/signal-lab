// 카피식 추매 TRADER_LADDER (scalp_ladder.mjs + scalp_executor.mjs, user 2026-11-24 21:33-21:35): ladder sizing, adds
// (spacing / strong zone), take profit on the average net of fees, max hold, final line, budget reservation, restart
// idempotency and LIVE refusal. Fake BingX TESTNET client only: no network, no orders.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {ScalpExecutor,scalpExecConfig,scalpLiveExecConfig,SCALP_LIVE_CONFIRM_TOKEN} from '../scalp_executor.mjs';
import {TRADER_LADDER,SCALP_MANAGEMENTS,scalpManagementOf,planLadder,ladderZoneBoost,ladderNextAdd,ladderSpacing,ladderTpPrice,ladderNetPct,ladderReserve,strongZones,zoneRejections,atrPct} from '../scalp_ladder.mjs';
import {TestnetBudget} from '../testnet_budget.mjs';
import {scalpEventText} from '../scalp_telegram.mjs';
import {journalLine,scalpMargin,summarizeJournal} from '../scalp_journal.mjs';
import {evaluateReadiness,readyReplyText} from '../ready_check.mjs';
import {scalpPositionCardHTML,liveReadinessHTML} from '../public/live_control.js';
import {ladderStepText,reasonInfo} from '../public/scalp_reasons.js';

const I=300000,H=3600000,BUCKET=Math.floor(Date.parse('2026-11-16T03:00:00Z')/I),T0=BUCKET*I+5000;
function crash({lastOpen=(BUCKET-1)*I}={}){
 const rows=[];let p=100;const push=(o,h,l,c,v)=>rows.push([0,o,h,l,c,v]);
 for(let i=0;i<50;i++){const o=p,c=p+(i%2?.05:-.05);push(o,Math.max(o,c)+.1,Math.min(o,c)-.1,c,100);p=c}
 for(let i=0;i<4;i++){const o=p,c=p-6/4;push(o,o+.05,c-.1,c,100*10*(i===3?1:.5));p=c}
 push(p,p+.15,p-.8,p+.1,800);
 return rows.map((r,i)=>{const t=lastOpen-(rows.length-1-i)*I;return [t,...r.slice(1,6).map(String),t+I-1,String(r[5]*r[4])]});
}
const up4h=now=>Array.from({length:301},(_,i)=>{const t=now-(301-i)*4*H-1000,c=50+i*.1;return [t,String(c),String(c+.2),String(c-.2),String(c),'1000',t+4*H-1,'1']});
// Quiet 1H candles around 94: ATR about 0.4 % (the spacing is then the 1.5 % floor).
const hourly=now=>Array.from({length:40},(_,i)=>{const t=now-(40-i)*H-1000,c=94;return [t,String(c),String(c*1.002),String(c*.998),String(c),'1000',t+H-1,'1']});
const ENTRY=Number(crash().at(-1)[4]),PX=+(ENTRY+.02).toFixed(2);
const contract=(sym,o={})=>({symbol:sym,venueSymbol:sym.replace('USDT','-USDT'),tickSize:'0.01',quantityStep:'0.01',minQuantityBase:'0.01',minNotionalUSDT:2,tradable:true,...o});

/** One-way BingX TESTNET fake, one position per venue symbol. */
function venue({loseAddReply=false}={}){
 const st=new Map(),orders=new Map(),calls=[];let id=1;
 const S=vs=>{if(!st.has(vs))st.set(vs,{amt:0,avg:0,mark:0});return st.get(vs)};
 const add=(p,extra={})=>{const o={orderId:String(id++),...p,status:'NEW',...extra};orders.set(o.orderId,o);return o};
 const reduce=(s,q)=>{s.amt=s.amt>0?+Math.max(0,s.amt-q).toFixed(8):+Math.min(0,s.amt+q).toFixed(8)};
 const client={mode:'TESTNET',
  positionMode:async()=>({dualSidePosition:false}),marginType:async()=>({marginType:'CROSSED'}),setMarginType:async()=>({}),
  leverage:async()=>({maxLongLeverage:20,maxShortLeverage:20}),setLeverage:async(s,side,l)=>({leverage:l}),
  positions:async vs=>[...st.entries()].filter(([k,v])=>v.amt!==0&&(!vs||k===vs)).map(([k,v])=>({symbol:k,positionSide:'BOTH',positionAmt:String(v.amt),avgPrice:String(v.avg),markPrice:String(v.mark||v.avg),unrealizedProfit:String(((v.mark||v.avg)-v.avg)*v.amt)})),
  openOrders:async()=>({orders:[...orders.values()].filter(o=>o.status==='NEW')}),
  getOrder:async(s,{orderId,clientOrderId})=>({order:[...orders.values()].find(o=>orderId?o.orderId===orderId:o.clientOrderId===clientOrderId)??null}),
  cancelOrder:async(s,oid)=>{const o=orders.get(oid);if(o&&o.status==='NEW')o.status='CANCELED';return {}},
  placeOrder:async(p,{beforeSend}={})=>{
   const reason=beforeSend?.();if(reason)throw Object.assign(Error(reason),{code:'ENTRY_NOT_SENT',reason});
   calls.push(p);const s=S(p.symbol),q=Number(p.quantity),sign=p.side==='SELL'?-1:1;
   if(p.type==='MARKET'){
    const px=s.mark||PX;
    if(p.reduceOnly)reduce(s,q);
    else{s.avg=(s.avg*Math.abs(s.amt)+px*q)/(Math.abs(s.amt)+q);s.amt=+(s.amt+sign*q).toFixed(8)}
    const o=add(p,{status:'FILLED',executedQty:String(q),avgPrice:String(px)});
    if(!p.reduceOnly&&loseAddReply&&/L\d+n/.test(p.clientOrderId||''))throw Object.assign(Error('response lost'),{code:'NETWORK_UNREACHABLE'});
    return {order:o};
   }
   if(p.type==='LIMIT'&&p.timeInForce==='IOC'&&p.reduceOnly){
    const can=p.side==='SELL'?s.mark>=Number(p.price):s.mark<=Number(p.price);
    if(!can)return {order:add(p,{status:'EXPIRED',executedQty:'0'})};
    reduce(s,q);return {order:add(p,{status:'FILLED',executedQty:String(q),avgPrice:String(p.price)})};
   }
   return {order:add(p)};
  }};
 return {client,calls,st:S,orders};
}
const rise=o=>crash(o).map(r=>[r[0],String(200-r[1]),String(200-r[3]),String(200-r[2]),String(200-r[4]),r[5],r[6],r[7]]);
const down4h=now=>up4h(now).map(r=>{const c=200-(Number(r[4])-50);return [r[0],String(c),String(c+.2),String(c-.2),String(c),'1000',r[6],'1']});
const PX_S=+(Number(rise().at(-1)[4])-.02).toFixed(2);
function make(v,{clock={t:T0},symbols=['SOLUSDT'],funds={equity:10000,available:9000},budget=null,dir=null,config={},contracts=null,rows=crash,trend=up4h,px=PX}={}){
 const cmap=new Map(symbols.map(s=>[s,contracts?.[s]??contract(s)]));
 return new ScalpExecutor({config:{...scalpExecConfig({}),minScore:0,makerEntry:false,makerExit:false,dailyLossPct:10,...config},client:v.client,
  contracts:async()=>cmap,tickers:async()=>symbols.map(s=>({symbol:s.replace('USDT','-USDT'),quoteVolume:'90000000'})),
  candles:async(s,iv)=>iv==='5m'?[...rows(),[BUCKET*I,'100','100','100','100','1',BUCKET*I+I-1,'1']]:iv==='1h'?hourly(clock.t):trend(clock.t),
  zoneCandles:async()=>[],priceOf:async()=>px,markOf:async()=>px,balance:async()=>funds,gate:()=>({ok:true}),isBusy:()=>false,directory:dir,now:()=>clock.t,budget});
}
const tmp=()=>fs.mkdtempSync(path.join(os.tmpdir(),'scalp-ladder-'));
const adds=v=>v.calls.filter(c=>c.type==='MARKET'&&!c.reduceOnly&&/L\d+n\d+$/.test(c.clientOrderId||''));
const setMark=(v,sym,price)=>{v.st(sym.replace('USDT','-USDT')).mark=price};
const below=x=>+(Math.floor(x*100)/100-.01).toFixed(2);
async function opened({config={},...opt}={}){
 const v=venue(opt.venue),clock=opt.clock||{t:T0},ex=make(v,{clock,...opt,config});ex.arm();await ex.scan();
 return {v,clock,ex,p:ex.store.open[0]};
}

test('ladder sizing: unit = cap / 32, multipliers never break the cap, the min-order shrink from the end, and the refusal',()=>{
 const base={symbolCapUSD:1000,leverage:10,price:100,quantityStep:'0.01',minQty:0.01,minNotional:2};
 const a=planLadder(base);
 assert.equal(a.ok,true);assert.deepEqual(a.units,[1,1,2,4,8,16]);assert.equal(a.unitMarginUSD,31.25);assert.equal(a.totalMarginUSD,1000);assert.equal(a.qty0,3.12);
 const big=planLadder({...base,sizeMult:1.4});assert.equal(big.capped,true);assert.ok(big.totalMarginUSD<=1000+1e-9);
 const half=planLadder({...base,sizeMult:.5});assert.equal(half.unitMarginUSD,15.625);assert.equal(half.totalMarginUSD,500);
 const room=planLadder({...base,roomUSD:320});assert.ok(room.totalMarginUSD<=320+1e-9);assert.deepEqual(room.units,[1,1,2,4,8,16]);
 // 1 unit below the venue minimum (1 coin at 100 x 10 = $10 margin, +10 % headroom): unit raised, ladder shortened.
 const short=planLadder({...base,symbolCapUSD:300,minQty:1});
 assert.equal(short.raised,true);assert.equal(short.unitMarginUSD,11);assert.deepEqual(short.units,[1,1,2,4,8]);assert.ok(short.totalMarginUSD<=300);assert.equal(short.qty0,1.1);
 assert.deepEqual(planLadder({...base,symbolCapUSD:300,minQty:20}),{ok:false,reason:'LADDER_BELOW_MINIMUM',minUnitMarginUSD:220,capUSD:300});
 assert.equal(planLadder({...base,roomUSD:0}).reason,'MARGIN_CAP');
 // The cap is never exceeded, whatever the multiplier, minimum and room.
 for(const cap of [50,300,1000])for(const mult of [.3,.75,1,1.4,3])for(const minQty of [.01,.5,2,6])for(const roomUSD of [Infinity,cap/3]){
  const r=planLadder({...base,symbolCapUSD:cap,sizeMult:mult,minQty,roomUSD});
  if(!r.ok)continue;
  assert.ok(r.totalMarginUSD<=Math.min(cap,roomUSD)+1e-6,JSON.stringify({cap,mult,minQty,roomUSD}));
  assert.ok(r.qty0*100/10<=r.unitMarginUSD+1e-9);assert.ok(r.units.length>=2);
 }
});

test('strong zone x2 takes the same units off the last steps (total kept); the last step cannot grow',()=>{
 const L=[1,1,2,4,8,16];
 assert.deepEqual(ladderZoneBoost(L,1),{units:[1,2,2,4,8,15],boost:1});
 assert.deepEqual(ladderZoneBoost(L,4),{units:[1,1,2,4,16,8],boost:8});
 assert.deepEqual(ladderZoneBoost(L,5),{units:L,boost:0});
 assert.deepEqual(ladderZoneBoost([1,1,2,4,8],4),{units:[1,1,2,4,8],boost:0});
 assert.deepEqual(ladderZoneBoost([1,1,2,1],2),{units:[1,1,3],boost:1});
 for(let i=0;i<6;i++)assert.equal(ladderZoneBoost(L,i).units.reduce((s,x)=>s+x,0),32);
});

test('add level: spacing from the last fill, a strong zone in between (not too close), or the spacing level inside a zone',()=>{
 const z=(low,high,why=['TOP_VOLUME_NODE'])=>({low,high,tf:'4h',why});
 assert.deepEqual(ladderNextAdd({direction:'LONG',lastFill:100,spacingPct:2,zones:[]}),{level:98,spacingLevel:98,zone:null});
 const between=ladderNextAdd({direction:'LONG',lastFill:100,spacingPct:2,zones:[z(98.2,98.6),z(97,97.5)]});
 assert.equal(between.level,98.6);assert.equal(between.zone.at,'BETWEEN');
 // Closer than half the spacing: not used.
 assert.equal(ladderNextAdd({direction:'LONG',lastFill:100,spacingPct:2,zones:[z(99.2,99.5)]}).zone,null);
 const at=ladderNextAdd({direction:'LONG',lastFill:100,spacingPct:2,zones:[z(97.5,98.1)]});
 assert.equal(at.level,98.1);assert.equal(at.zone.at,'BETWEEN');
 const inside=ladderNextAdd({direction:'LONG',lastFill:100,spacingPct:2,zones:[z(97,99.3)]});
 assert.equal(inside.level,98);assert.equal(inside.zone.at,'AT_SPACING');
 const s=ladderNextAdd({direction:'SHORT',lastFill:100,spacingPct:2,zones:[z(101.2,101.5)]});
 assert.equal(s.spacingLevel,102);assert.equal(s.level,101.2);
 // Spacing: max(1.5 %, ATR), capped under the final line at the leverage.
 assert.equal(ladderSpacing({atrPct:.4,leverage:10}).spacingPct,1.5);
 assert.equal(ladderSpacing({atrPct:2.2,leverage:10}).spacingPct,2.2);
 assert.deepEqual([ladderSpacing({atrPct:8,leverage:10}).spacingPct,ladderSpacing({atrPct:8,leverage:10}).capped],[3.375,true]);
 assert.equal(atrPct(hourly(T0),{now:T0}).toFixed(2),'0.40');
});

test('strong zones: 4H/1D overlap, the top volume node, and 3 rejections (4H candles touching and closing back)',()=>{
 const z4=[{low:95,high:96,rank:2,sharePct:3},{low:90,high:91,rank:1,sharePct:6},{low:80,high:81,rank:3}],z1=[{low:96.2,high:97,rank:2}];
 const bar=(l,c)=>[0,String(c),String(c+1),String(l),String(c),'1',1,'1'];
 const rows=[bar(85,90),bar(80.5,82),bar(83,84),bar(80.9,82),bar(80.6,81.5),bar(84,85),bar(80.2,83)];
 assert.equal(zoneRejections(rows,z4[2],'LONG'),3);
 const out=strongZones({zones4h:z4,zones1d:z1,rows4h:rows,direction:'LONG'});
 const why=low=>out.find(x=>x.low===low&&x.tf==='4h')?.why;
 assert.deepEqual(why(95),['OVERLAP_4H_1D']);assert.deepEqual(why(90),['TOP_VOLUME_NODE']);assert.deepEqual(why(80),['REJECTIONS_3']);
 assert.deepEqual(out.find(x=>x.tf==='1d').why,['OVERLAP_4H_1D']);
 assert.equal(strongZones({zones4h:[{low:70,high:71,rank:4}],zones1d:[]}).length,0);
 for(const c of ['OVERLAP_4H_1D','TOP_VOLUME_NODE','REJECTIONS_3'])assert.ok(reasonInfo(c),c);
});

test('take profit on the average is net positive after fees, both sides',()=>{
 for(const direction of ['LONG','SHORT']){
  const tp=ladderTpPrice({direction,avg:100,takerRate:.0006,tpNetPct:.6,tickSize:'0.01'});
  assert.ok(direction==='LONG'?tp>100.7:tp<99.3,`${direction} ${tp}`);
  assert.ok(ladderNetPct({direction,avg:100,exit:tp,takerRate:.0006})>=.6);
 }
 const r=ladderReserve({totalMarginUSD:1000,leverage:10,finalLineRoePct:75,takerRate:.0006,reservePct:.0004});
 assert.equal(r.marginUSD,1000);assert.equal(r.riskUSD,766);
});

test('management: TRADER_LADDER by default on the testnet; CURRENT on request, with the automatic stop, and always for LIVE',()=>{
 assert.equal(scalpManagementOf({}),'TRADER_LADDER');assert.equal(scalpManagementOf({SCALP_MANAGEMENT:'current'}),'CURRENT');
 assert.equal(scalpExecConfig({}).management,'TRADER_LADDER');
 const off=scalpExecConfig({SCALP_EXEC_MODE:'LIVE'});assert.equal(off.mode,'OFF');assert.equal(off.refused,'LIVE_REFUSED');
 assert.throws(()=>new ScalpExecutor({config:{...scalpExecConfig({}),mode:'LIVE'},client:{mode:'LIVE'}}),/SCALP_TESTNET_ONLY/);
 const live=scalpLiveExecConfig({SCALP_LIVE_MODE:'LIVE',SCALP_LIVE_CONFIRM:SCALP_LIVE_CONFIRM_TOKEN,SCALP_MANAGEMENT:'TRADER_LADDER'});
 assert.equal(live.management,'CURRENT');
 // Even a live config forced to TRADER_LADDER stays CURRENT: the ladder never runs outside the TESTNET.
 const ex=new ScalpExecutor({config:{...live,management:'TRADER_LADDER',stopLossEnabled:false},client:{mode:'LIVE'}});
 assert.equal(ex.status().settings.management,'CURRENT');assert.equal(ex.managementScope().active,false);
 assert.equal(new ScalpExecutor({config:{...scalpExecConfig({}),stopLossEnabled:true},client:{mode:'TESTNET'}}).status().settings.management,'CURRENT');
 const tn=new ScalpExecutor({config:scalpExecConfig({}),client:{mode:'TESTNET'},now:()=>T0});
 assert.equal(tn.status().settings.management,'TRADER_LADDER');assert.equal(tn.managementScope().since,T0);
});

test('entry: same gates, first ladder unit, whole ladder reserved; the card and Telegram show the step',async()=>{
 const {v,ex,p}=await opened();
 assert.equal(p.management,'TRADER_LADDER');assert.equal(p.scaleIn,undefined);
 assert.deepEqual(p.ladder.units,[1,1,2,4,8,16]);assert.equal(p.ladder.unitMarginUSD,31.25);assert.equal(p.ladder.filled,1);
 assert.equal(p.ladder.spacingPct,1.5);assert.equal(p.leverage,10);
 assert.ok(Math.abs(p.size*p.avg/10-31.25)<.1);
 assert.equal(p.ladder.reserveMarginUSD,1000);assert.equal(p.ladder.reserveRiskUSD,766);assert.equal(p.riskUSD,766);
 // No take-profit / stop orders on the venue: the ladder exits itself.
 assert.equal(v.calls.filter(c=>c.reduceOnly||c.type==='STOP_MARKET').length,0);
 const src=ex.budgetSource();assert.equal(src.usedMargin(),1000);assert.equal(src.openRisk(),766);
 const s=ex.status(),pos=s.positions[0];
 assert.equal(pos.ladderView.step,1);assert.equal(pos.ladderView.of,6);
 assert.ok(Math.abs(pos.ladderView.nextAdd.price-p.avg*.985)<1e-6);
 const card=scalpPositionCardHTML(pos);
 assert.match(card,/카피식 추매 1\/6 단계 · 평단 [\d.]+ · 다음 추매 [\d.]+/);assert.match(card,/익절/);assert.doesNotMatch(card,/자동 손절/);
 const opened_=ex.store.events.find(e=>e.type==='OPENED');
 const text=scalpEventText(opened_);
 assert.match(text,/카피식 추매/);assert.match(text,/1\/6 단계 · 평단/);assert.match(text,/마지막 선 −75% ROE/);assert.match(text,/최대 24시간/);
 assert.equal(s.settings.management,'TRADER_LADDER');assert.equal(s.settings.ladderTpNetPct,.6);assert.equal(s.settings.ladderMaxHoldMin,1440);
});

test('adds: at the spacing from the LAST fill, one per step, unique client ids; no 240-min cut, no -40 % defensive add',async()=>{
 const {v,clock,ex,p}=await opened();
 const first=p.avg;
 // 1.2 % down: not yet. 300 minutes in a loss: no time cut (CURRENT would close at 240), no defensive add.
 setMark(v,'SOLUSDT',first*.988);clock.t+=300*60000;await ex.reconcile();
 assert.equal(adds(v).length,0);assert.equal(ex.store.open.length,1);
 setMark(v,'SOLUSDT',below(first*.985));clock.t+=10000;await ex.reconcile();
 assert.equal(adds(v).length,1);assert.equal(p.ladder.filled,2);assert.equal(p.ladder.fills[1].units,1);assert.equal(p.ladder.fills[1].zone,null);
 assert.ok(Math.abs(p.ladder.lastFill-first*.985)<.03);
 // Next level from the last fill (not the first entry): 1.5 % under the add.
 const lvl=p.ladder.lastFill*.985;
 setMark(v,'SOLUSDT',+(lvl+.05).toFixed(2));clock.t+=10000;await ex.reconcile();assert.equal(adds(v).length,1);
 setMark(v,'SOLUSDT',+(lvl-.01).toFixed(2));clock.t+=10000;await ex.reconcile();
 assert.equal(adds(v).length,2);assert.equal(p.ladder.fills[2].units,2);
 assert.ok(Math.abs(p.ladder.fills[2].qty*p.ladder.fills[2].price/10-62.5)<1);
 const ids=adds(v).map(c=>c.clientOrderId);assert.equal(new Set(ids).size,ids.length);assert.match(ids[0],/L2n1$/);assert.match(ids[1],/L3n2$/);
 // Same price again: no second order for the same step.
 clock.t+=10000;await ex.reconcile();assert.equal(adds(v).length,2);
 const ev=ex.store.events.filter(e=>e.type==='LADDER_ADD');assert.equal(ev.length,2);
 assert.match(scalpEventText(ev[1]),/카피식 추매 3\/6단계/);assert.match(scalpEventText(ev[1]),/3\/6 단계 · 평단 [\d.]+ · 다음 추매/);
 assert.ok(!ex.store.events.some(e=>['MAX_HOLD_EXIT','SCALE_IN_FILLED'].includes(e.type)));
});

test('a strong zone between the last fill and the spacing level: the add comes there, doubled, the last step reduced',async()=>{
 const {v,clock,ex,p}=await opened();
 const f=p.avg,zone={low:+(f*.986).toFixed(2),high:+(f*.989).toFixed(2),tf:'4h',why:['OVERLAP_4H_1D','TOP_VOLUME_NODE'],rank:1};
 p.ladder.zones={bucket:Math.floor(clock.t/(4*H)),at:clock.t,list:[zone]};
 setMark(v,'SOLUSDT',zone.high);clock.t+=10000;await ex.reconcile();
 assert.equal(adds(v).length,1);
 assert.deepEqual(p.ladder.units,[1,2,2,4,8,15]);assert.equal(p.ladder.fills[1].units,2);assert.equal(p.ladder.fills[1].boost,1);
 assert.deepEqual(p.ladder.fills[1].zone.why,['OVERLAP_4H_1D','TOP_VOLUME_NODE']);
 assert.ok(Math.abs(p.ladder.fills[1].qty*p.ladder.fills[1].price/10-62.5)<1);
 const e=ex.store.events.find(x=>x.type==='LADDER_ADD');assert.match(scalpEventText(e),/강한 매물대 2배 \(4H·1D 매물대 겹침·최대 거래량 매물대\)/);
});

test('take profit: the whole position at the average + 0.6 % net of fees, booked net positive',async()=>{
 const {v,clock,ex,p}=await opened();
 setMark(v,'SOLUSDT',below(p.avg*.985));clock.t+=10000;await ex.reconcile();assert.equal(p.ladder.filled,2);
 const tp=ladderTpPrice({direction:'LONG',avg:p.avg,takerRate:.0006,tpNetPct:.6,reservePct:p.ladder.reservePct,tickSize:'0.01'});
 setMark(v,'SOLUSDT',+(tp-.02).toFixed(2));clock.t+=10000;await ex.reconcile();assert.equal(ex.store.open.length,1);
 setMark(v,'SOLUSDT',tp);clock.t+=10000;await ex.reconcile();
 const exit=v.calls.find(c=>c.type==='LIMIT'&&c.timeInForce==='IOC');
 assert.equal(exit.price,String(tp));assert.equal(exit.reduceOnly,'true');assert.equal(Number(exit.quantity),p.size);
 assert.equal(ex.store.open.length,0);const x=ex.store.closed[0];
 assert.equal(x.closeReason,'LADDER_TAKE_PROFIT');assert.ok(x.netUSD>0);
 const notional=x.avg*x.filled;assert.ok(x.netUSD/notional*100>=.55,`${x.netUSD/notional*100}`);
 assert.match(scalpEventText(ex.store.events.find(e=>e.type==='CLOSED')),/평단 익절.*\n.*카피식 추매 2\/6단계/);
 const line=journalLine(x);assert.equal(line.management,'TRADER_LADDER');assert.equal(line.ladder.filled,2);
 const m=scalpMargin(x);assert.ok(Math.abs(m.initialUSD-31.25)<.1);assert.ok(Math.abs(m.addedUSD-31.25)<.5);
 const st=ex.stats();assert.equal(st.byManagement.TRADER_LADDER.trades,1);assert.equal(st.byManagement.CURRENT.trades,0);
 assert.equal(summarizeJournal([line]).byManagement.TRADER_LADDER.trades,1);
});

test('max hold: closed after 24 hours whatever the result',async()=>{
 const {v,clock,ex,p}=await opened();
 setMark(v,'SOLUSDT',+(p.avg*1.001).toFixed(2));clock.t+=(24*60-1)*60000;await ex.reconcile();assert.equal(ex.store.open.length,1);
 clock.t+=2*60000;await ex.reconcile();
 assert.equal(ex.store.open.length,0);assert.equal(ex.store.closed[0].closeReason,'LADDER_MAX_HOLD');
 assert.ok(reasonInfo('LADDER_MAX_HOLD',ex.status().settings).desc.includes('24시간'));
});

test('final line: after the last step -75 % ROE closes as LADDER_FINAL_LINE; before it the emergency line still protects',async()=>{
 {const {v,clock,ex,p}=await opened();
  // Ladder not full: the existing emergency line (no position ever runs unprotected).
  setMark(v,'SOLUSDT',+(p.avg*(1-.076)).toFixed(2));p.ladder.retryAfterAt=clock.t+H;clock.t+=10000;await ex.reconcile();
  assert.equal(ex.store.closed[0].closeReason,'EMERGENCY_ROE_STOP');}
 const {v,clock,ex,p}=await opened();
 for(let i=0;i<5;i++){setMark(v,'SOLUSDT',+(p.ladder.lastFill*.985-.01).toFixed(2));clock.t+=10000;await ex.reconcile()}
 assert.equal(p.ladder.filled,6);assert.equal(p.ladder.state,'COMPLETE');assert.equal(adds(v).length,5);
 const used=p.ladder.fills.reduce((t,f)=>t+f.qty*f.price/10,0);assert.ok(used<=p.ladder.capUSD+1e-6,`${used}`);
 assert.match(scalpPositionCardHTML(ex.status().positions[0]),/6\/6 단계 · 평단 [\d.]+ · 추매 끝 · 마지막 선만 남음/);
 setMark(v,'SOLUSDT',+(p.avg*(1-.07)).toFixed(2));clock.t+=10000;await ex.reconcile();assert.equal(ex.store.open.length,1);assert.equal(adds(v).length,5);
 setMark(v,'SOLUSDT',+(p.avg*(1-.0751)).toFixed(2));clock.t+=10000;await ex.reconcile();
 assert.equal(ex.store.open.length,0);const x=ex.store.closed[0];
 assert.equal(x.closeReason,'LADDER_FINAL_LINE');assert.ok(x.closeMeta.roePct<=-75);assert.equal(x.closeMeta.step,6);
});

test('budget: every open ladder holds its whole margin and worst-case risk, so concurrent first entries cannot over-commit',async()=>{
 // Daily loss 15 % of 10,000 = 1,500; one ladder reserves 766 (1,000 margin at -75 % + fees): only one fits.
 {const v=venue(),clock={t:T0},budget=new TestnetBudget({dailyLossPct:15,marginCapPct:100,now:()=>clock.t});
  const ex=make(v,{clock,symbols:['SOLUSDT','XRPUSDT','ADAUSDT'],budget});budget.register('scalp',ex.budgetSource());
  ex.arm();await ex.scan();
  assert.equal(ex.store.open.length,1);assert.ok(ex.store.skips.some(s=>s.reason==='OPEN_RISK_LIMIT'));
  const snap=budget.snapshot(10000);assert.equal(snap.marginUSD,1000);assert.equal(snap.openRiskUSD,766);}
 // Margin cap 30 % = 3,000: three ladders (3 x 1,000 reserved) and no fourth, although their first units use ~94.
 const v=venue(),clock={t:T0},budget=new TestnetBudget({dailyLossPct:100,marginCapPct:30,now:()=>clock.t});
 const ex=make(v,{clock,symbols:['SOLUSDT','XRPUSDT','ADAUSDT','DOTUSDT'],budget});budget.register('scalp',ex.budgetSource());
 ex.arm();await ex.scan();
 assert.equal(ex.store.open.length,3);
 assert.ok(ex.store.skips.some(s=>['MARGIN_CAP','TESTNET_MARGIN_CAP'].includes(s.reason)),JSON.stringify(ex.store.skips.map(s=>s.reason)));
 const firstUnits=ex.store.open.reduce((t,p)=>t+p.size*p.avg/p.leverage,0);assert.ok(firstUnits<100);
 assert.equal(budget.snapshot(10000).marginUSD,3000);
 // Worst case: every step filled to the final line still fits the shared margin.
 for(const p of ex.store.open)assert.ok(p.ladder.reserveMarginUSD<=1000+1e-9);
});

test('restart: an add whose answer was lost is settled from the position once, never sent twice',async()=>{
 const dir=tmp(),v=venue({loseAddReply:true}),clock={t:T0};
 const ex=make(v,{clock,dir});ex.arm();await ex.scan();
 const p=ex.store.open[0];
 setMark(v,'SOLUSDT',below(p.avg*.985));clock.t+=10000;await ex.reconcile();
 assert.equal(adds(v).length,1);assert.ok(ex.store.open[0].ladder.pending,'kept pending: the answer was lost');
 assert.equal(ex.status().blocked,'UNRESOLVED_ORDER_STATE');
 // Restart (same files), price still at the level: settled from the position, no second order.
 const again=make(v,{clock,dir});
 clock.t+=10000;await again.reconcile();clock.t+=10000;await again.reconcile();
 const q=again.store.open[0];
 assert.equal(adds(v).length,1);assert.equal(q.ladder.filled,2);assert.equal(q.ladder.pending,undefined);
 assert.ok(Math.abs(q.ladder.fills[1].price-p.avg*.985)<.03);assert.equal(again.managementScope().since,T0);
 fs.rmSync(dir,{recursive:true,force:true});
});

test('readiness counts only TRADER_LADDER trades from the switch time, and says so',()=>{
 const since=T0;
 const row=(m,at,net)=>({direction:'LONG',netUSD:net,closedAt:at,openedAt:at,closeReason:'X',management:m});
 const rows=[...Array.from({length:120},(_,i)=>row('CURRENT',since+i,5)),row('TRADER_LADDER',since-5000,9),row('TRADER_LADDER',since+10,3),row('TRADER_LADDER',since+20,-1)];
 const s=evaluateReadiness({scalpRows:rows,pumpRecords:[],now:since+1e6,scalpScope:{management:'TRADER_LADDER',since}});
 assert.equal(s.groups[0].trades,2);assert.equal(s.groups[0].ready,false);
 assert.match(s.scope.text,/카피식 추매\(TRADER_LADDER\) 거래만/);assert.match(readyReplyText(s),/카피식 추매\(TRADER_LADDER\) 거래만/);
 assert.match(liveReadinessHTML(s),/카피식 추매\(TRADER_LADDER\) 거래만 셉니다/);
 assert.equal(evaluateReadiness({scalpRows:rows,pumpRecords:[]}).groups[0].trades,123);
});

test('glossary and texts: the ladder line, the new exit reasons',()=>{
 assert.equal(ladderStepText({step:3,of:6,avg:98,nextAdd:{price:95.5,zone:null}}),'3/6 단계 · 평단 98 · 다음 추매 95.5');
 const S=new ScalpExecutor({config:scalpExecConfig({})}).status().settings;
 for(const c of ['LADDER_TAKE_PROFIT','LADDER_MAX_HOLD','LADDER_FINAL_LINE','LADDER_BELOW_MINIMUM','LADDER_FINAL_LINE_OFF'])assert.ok(reasonInfo(c,S)?.label,c);
 assert.match(reasonInfo('LADDER_TAKE_PROFIT',S).desc,/\+0\.6%/);assert.match(reasonInfo('LADDER_FINAL_LINE',S).desc,/6단계.*−75% ROE/);
 assert.deepEqual([...TRADER_LADDER.steps],[1,1,2,4,8,16]);assert.equal(SCALP_MANAGEMENTS.LADDER,'TRADER_LADDER');
});

test('SHORT: adds above the last fill, take profit below the average, all net of fees',async()=>{
 const v=venue(),clock={t:T0};setMark(v,'SOLUSDT',PX_S);
 const ex=make(v,{clock,rows:rise,trend:down4h,px:PX_S});ex.arm();await ex.scan();
 const p=ex.store.open[0];assert.equal(p.direction,'SHORT');assert.equal(p.management,'TRADER_LADDER');
 setMark(v,'SOLUSDT',+(Math.ceil(p.avg*1.015*100)/100+.01).toFixed(2));clock.t+=10000;await ex.reconcile();
 assert.equal(adds(v).length,1);assert.equal(adds(v)[0].side,'SELL');assert.ok(p.ladder.lastFill>p.ladder.fills[0].price);
 const tp=ladderTpPrice({direction:'SHORT',avg:p.avg,takerRate:.0006,tpNetPct:.6,reservePct:p.ladder.reservePct,tickSize:'0.01'});
 assert.ok(tp<p.avg*.993);
 setMark(v,'SOLUSDT',tp);clock.t+=10000;await ex.reconcile();
 const exit=v.calls.find(c=>c.type==='LIMIT'&&c.timeInForce==='IOC');assert.equal(exit.side,'BUY');assert.equal(exit.price,String(tp));
 assert.equal(ex.store.closed[0].closeReason,'LADDER_TAKE_PROFIT');assert.ok(ex.store.closed[0].netUSD>0);
});

test('restart before the add was sent: the step waits 2 minutes, then is tried again with a new client id (one fill)',async()=>{
 const dir=tmp(),v=venue(),clock={t:T0};
 const ex=make(v,{clock,dir});ex.arm();await ex.scan();
 const p=ex.store.open[0],lvl=below(p.avg*.985);
 // The process stopped after saving the pending add and before sending it.
 p.ladder.attempt=1;p.ladder.pending={step:2,index:1,units:1,plannedUnits:[...p.ladder.units],boost:0,zone:null,level:lvl,clientOrderId:p.id+'L2n1',attemptedAt:clock.t,preSize:p.size,preAvg:p.avg,requestedQty:p.size};
 ex.reconcile&&fs.writeFileSync(path.join(dir,'scalp-store.json'),JSON.stringify({version:1,strategy:'SCALP_REVERSAL',...ex.store}));
 const again=make(v,{clock,dir});again.arm();setMark(v,'SOLUSDT',lvl);
 clock.t+=30000;await again.reconcile();assert.ok(again.store.open[0].ladder.pending);assert.equal(adds(v).length,0);
 clock.t+=120000;await again.reconcile();assert.equal(again.store.open[0].ladder.pending,undefined);assert.equal(again.store.open[0].ladder.lastReason,'NOT_FILLED');
 clock.t+=20000;await again.reconcile();
 assert.equal(adds(v).length,1);assert.match(adds(v)[0].clientOrderId,/L2n2$/);assert.equal(again.store.open[0].ladder.filled,2);
 fs.rmSync(dir,{recursive:true,force:true});
});
