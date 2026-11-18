import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {ManualLedger,MANUAL_LEDGER_FILE} from '../manual_ledger.mjs';
import {manualTradeText} from '../live_telegram.mjs';
import {tagOrigins} from '../venue_positions.mjs';
import {CopyExecutor,copyConfig} from '../copy_executor.mjs';
import {ledgerSummary} from '../reports_push.mjs';

const tmp=()=>fs.mkdtempSync(path.join(os.tmpdir(),'sl-manual-'));
const row=(o={})=>({symbol:'BTCUSDT',venueSymbol:'BTC-USDT',positionSide:'BOTH',direction:'LONG',size:0.01,avg:50000,mark:50000,unrealized:0,leverage:10,marginMode:'CROSSED',...o});
// A snapshot as venue_positions.mjs gives it: rows tagged against the copy ledger's open positions.
const snap=(at,rows,copy=[])=>({venuePositions:tagOrigins(rows,copy),venuePositionsAt:at,venuePositionsError:null});
function clock(t0=1_800_000_000_000){let t=t0;return {now:()=>t,set:v=>{t=v},add:ms=>{t+=ms;return t}}}
function incomeClient(rows){const calls=[];return {calls,rows,income:async q=>{calls.push(q);return rows.filter(r=>(!q.symbol||r.symbol===q.symbol)&&r.time>=q.startTime&&r.time<=q.endTime)}}}

test('manual: open (2 reads) -> add -> reduce -> close (2 reads) -> settled from BingX income (EXCHANGE)',async()=>{
 const dir=tmp(),c=clock(),inc=incomeClient([]),copy=[],notices=[];
 const m=new ManualLedger({directory:dir,client:inc,copyRecords:()=>copy,now:c.now,onEvent:e=>notices.push(e)});
 const t0=c.now();
 m.observe(snap(t0,[]));                                           // first read after start: nothing to adopt
 const t1=c.add(15000);m.observe(snap(t1,[row()]));
 assert.equal(m.status().open.length,0,'one read is not enough to open');
 assert.equal(notices.length,0);
 assert.equal(m.observe(snap(t1,[row()])),false,'the same read again (cached list) is ignored');
 const t2=c.add(15000);m.observe(snap(t2,[row()]));
 let o=m.status().open;assert.equal(o.length,1);assert.equal(o[0].origin,'manual');assert.equal(o[0].openedAt,t1,'opened at the first read');
 assert.equal(o[0].direction,'LONG');assert.equal(o[0].hedge,false);assert.equal(o[0].leverage,10);assert.equal(o[0].avg,50000);assert.equal(o[0].adoptedAtStart,undefined);
 const t3=c.add(15000);m.observe(snap(t3,[row({size:0.03,avg:50500,mark:50750})]));
 const t4=c.add(15000);m.observe(snap(t4,[row({size:0.02,avg:50500,mark:51000})]));
 o=m.status().open[0];assert.equal(o.adds,1);assert.equal(o.reduces,1);assert.equal(o.maxSize,0.03);assert.equal(o.size,0.02);assert.equal(o.sizeSinceAt,t4);
 const t5=c.add(15000);m.observe(snap(t5,[]));
 assert.equal(m.status().open.length,1,'one empty read does not close');
 const t6=c.add(15000);m.observe(snap(t6,[]));
 assert.equal(m.status().open.length,0);let x=m.status().closed[0];
 assert.equal(x.closedAt,t5,'closed at the first read without it');assert.equal(x.netSource,'PENDING');assert.equal(x.netUSD,null);assert.ok(Number.isFinite(x.estimateUSD));
 // BingX income: open fee, the reduction, funding, the close; another coin and an old row are not ours.
 inc.rows.push({symbol:'BTC-USDT',incomeType:'TRADING_FEE',income:'-0.25',time:t1-5000,tranId:'a'},{symbol:'BTC-USDT',incomeType:'REALIZED_PNL',income:'5',time:t4-3000,tranId:'b'},
  {symbol:'BTC-USDT',incomeType:'FUNDING_FEE',income:'-0.1',time:t4+2000,tranId:'c'},{symbol:'BTC-USDT',incomeType:'REALIZED_PNL',income:'12',time:t5-4000,tranId:'d'},
  {symbol:'BTC-USDT',incomeType:'TRADING_FEE',income:'-0.5',time:t5-4000,tranId:'e'},{symbol:'ETH-USDT',incomeType:'REALIZED_PNL',income:'99',time:t5-4000,tranId:'f'},
  {symbol:'BTC-USDT',incomeType:'REALIZED_PNL',income:'77',time:t1-600000,tranId:'g'},{symbol:'BTC-USDT',incomeType:'TRANSFER',income:'1000',time:t3,tranId:'h'});
 await m.settle();assert.equal(m.status().closed[0].netSource,'PENDING','not before settleDelayMs');
 assert.deepEqual(notices,[],'position snapshots alone do not send an alert');
 c.add(20000);await m.settle();x=m.status().closed[0];
 assert.equal(x.netSource,'EXCHANGE');assert.equal(x.netUSD,16.15);assert.equal(x.pnlUSD,17);assert.equal(x.feeUSD,-0.75);assert.equal(x.fundingUSD,-0.1);
 assert.equal(inc.calls.at(-1).symbol,'BTC-USDT');assert.equal(inc.calls.at(-1).startTime,t1-60000);assert.ok(inc.calls.at(-1).endTime<=t5+120000);
 assert.equal(m.status().netUSD,16.15);assert.equal(m.status().settled,1);
 await m.settle();assert.equal(notices.length,0,'whole-position income cannot confirm which order closed the position');
 assert.equal(m.alertStatus().pending,4);
 // On disk, its own file; reloaded as is.
 const saved=JSON.parse(fs.readFileSync(path.join(dir,MANUAL_LEDGER_FILE),'utf8'));assert.equal(saved.origin,'manual');assert.equal(saved.closed[0].netUSD,16.15);
 assert.equal(fs.existsSync(path.join(dir,'copy-store-live.json')),false,'never writes the copy ledger');
 assert.equal(new ManualLedger({directory:dir,now:c.now}).status().closed[0].netSource,'EXCHANGE');
 // Report: the same trade fields plus origin manual.
 const rep=ledgerSummary(saved,{now:c.now()});assert.equal(rep.trades[0].origin,'manual');assert.equal(rep.trades[0].netUSD,16.15);assert.equal(rep.trades[0].netSource,'EXCHANGE');
 assert.equal(rep.trades[0].adds,1);assert.equal(rep.trades[0].reduces,1);assert.equal(rep.netUSD,16.15);
});

test('manual: income lagging -> PENDING and retried; none after the deadline -> ESTIMATE; rows are never counted twice',async()=>{
 const c=clock(),inc=incomeClient([]);
 const m=new ManualLedger({client:inc,now:c.now,settleDeadlineMs:120000});
 m.observe(snap(c.now(),[row({symbol:'XRPUSDT',venueSymbol:'XRP-USDT',size:100,avg:2,mark:2})])); // adopted at start
 const gone=c.add(15000);m.observe(snap(gone,[]));c.add(15000);m.observe(snap(c.now(),[]));
 c.add(30000);await m.settle();assert.equal(m.status().closed[0].netSource,'PENDING','no closing income yet');
 inc.rows.push({symbol:'XRP-USDT',incomeType:'REALIZED_PNL',income:'-3',time:gone+8000,tranId:'r1'}); // venue clock a little ahead
 c.add(5000);await m.settle();assert.equal(m.status().closed[0].netSource,'EXCHANGE');assert.equal(m.status().closed[0].netUSD,-3);
 // A second position on the same coin right after: the first one's rows are already claimed.
 const t=c.add(15000);m.observe(snap(t,[row({symbol:'XRPUSDT',venueSymbol:'XRP-USDT',size:50,avg:2.1,mark:2.1})]));c.add(15000);m.observe(snap(c.now(),[row({symbol:'XRPUSDT',venueSymbol:'XRP-USDT',size:50,avg:2.1,mark:2.05})]));
 const g2=c.add(15000);m.observe(snap(g2,[]));c.add(15000);m.observe(snap(c.now(),[]));
 inc.rows.push({symbol:'XRP-USDT',incomeType:'REALIZED_PNL',income:'4',time:g2-2000,tranId:'r2'});
 c.add(30000);await m.settle();let y=m.status().closed[0];
 assert.ok(inc.calls.at(-1).startTime<=gone+8000,'the first close row is inside the second window');
 assert.equal(y.netSource,'EXCHANGE');assert.equal(y.netUSD,4,'the first close row (-3) is not counted twice');
 assert.equal(m.status().netUSD,1);
 // No closing income at all: PENDING until the deadline, then ESTIMATE.
 const e=new ManualLedger({client:incomeClient([]),now:c.now,settleDeadlineMs:120000});
 e.observe(snap(c.now(),[row({symbol:'XRPUSDT',venueSymbol:'XRP-USDT',size:50,avg:2.1,mark:2.05})]));c.add(15000);e.observe(snap(c.now(),[]));c.add(15000);e.observe(snap(c.now(),[]));
 c.add(30000);await e.settle();assert.equal(e.status().closed[0].netSource,'PENDING');
 c.add(130000);await e.settle();const x=e.status().closed[0];
 assert.equal(x.netSource,'ESTIMATE');assert.equal(x.incomeMissing,'NO_CLOSE_INCOME');
 assert.ok(Math.abs(x.netUSD-(-0.05*50-0.0005*(50*2.1+50*2.05)))<1e-9,'(exit - avg) x size - fees');
 // A failing income read keeps it PENDING (retried) until the deadline.
 const bad=new ManualLedger({client:{income:async()=>{throw Object.assign(Error('x'),{code:'HTTP_429'})}},now:c.now});
 bad.observe(snap(c.now(),[row()]));c.add(15000);bad.observe(snap(c.now(),[]));c.add(15000);bad.observe(snap(c.now(),[]));
 c.add(30000);await bad.settle();assert.equal(bad.status().closed[0].netSource,'PENDING');assert.equal(bad.status().closed[0].settleError,'HTTP_429');
});

test('manual: a copy position of the same coin in the window -> MIXED_WITH_COPY with the estimate; copy rows never become manual',async()=>{
 const c=clock(),inc=incomeClient([]),copy=[];
 const m=new ManualLedger({client:inc,copyRecords:()=>copy,now:c.now});
 m.observe(snap(c.now(),[]));
 // Hedge mode: a manual SHORT and a copy LONG on the same coin.
 const cp={status:'OPEN',symbol:'SOLUSDT',venueSymbol:'SOL-USDT',direction:'LONG',hedge:true,openedAt:c.now()-1000,qty:1,avg:100};copy.push(cp);
 const rows=()=>[row({symbol:'SOLUSDT',venueSymbol:'SOL-USDT',positionSide:'LONG',direction:'LONG',size:1,avg:100,mark:101}),row({symbol:'SOLUSDT',venueSymbol:'SOL-USDT',positionSide:'SHORT',direction:'SHORT',size:2,avg:101,mark:100})];
 c.add(15000);m.observe(snap(c.now(),rows(),copy));c.add(15000);m.observe(snap(c.now(),rows(),copy));
 let o=m.status().open;assert.equal(o.length,1,'only the manual side');assert.equal(o[0].direction,'SHORT');assert.equal(o[0].hedge,true);
 c.add(15000);m.observe(snap(c.now(),[rows()[0]],copy));c.add(15000);m.observe(snap(c.now(),[rows()[0]],copy));
 inc.rows.push({symbol:'SOL-USDT',incomeType:'REALIZED_PNL',income:'50',time:c.now()-20000,tranId:'z'});
 c.add(30000);await m.settle();const x=m.status().closed[0];
 assert.equal(x.netSource,'MIXED_WITH_COPY');assert.equal(x.netUSD,x.estimateUSD);assert.ok(Math.abs(x.netUSD-(2*1-0.0005*(2*101+2*100)))<1e-9);
 assert.equal(inc.calls.length,0,'income not read: it cannot be split by owner');
 // One-way: a copy position made bigger by a manual add stays copy (no manual record).
 const ow=new ManualLedger({now:c.now}),cp2=[{status:'OPEN',symbol:'ETHUSDT',venueSymbol:'ETH-USDT',direction:'LONG',openedAt:c.now()-60000,qty:0.1}];
 ow.observe(snap(c.now(),[row({symbol:'ETHUSDT',venueSymbol:'ETH-USDT',size:0.1})],cp2));
 for(let i=0;i<3;i++){c.add(15000);ow.observe(snap(c.now(),[row({symbol:'ETHUSDT',venueSymbol:'ETH-USDT',size:0.5})],cp2))}
 assert.equal(ow.status().open.length,0);assert.equal(ow.status().closedTotal,0);
 // Manual first, then the copy ledger enters the same side: frozen and closed as MIXED_WITH_COPY.
 const mg=new ManualLedger({client:inc,now:c.now}),cp3=[];
 mg.observe(snap(c.now(),[row({symbol:'ADAUSDT',venueSymbol:'ADA-USDT',size:10,avg:1,mark:1})]));
 cp3.push({status:'OPEN',symbol:'ADAUSDT',venueSymbol:'ADA-USDT',direction:'LONG',openedAt:c.now()+1});
 c.add(15000);mg.observe(snap(c.now(),[row({symbol:'ADAUSDT',venueSymbol:'ADA-USDT',size:30,avg:1.1,mark:1.2})],cp3));
 o=mg.status().open[0];assert.ok(o.mergedIntoCopy);assert.equal(o.size,10,'frozen at the manual size');
 c.add(15000);mg.observe(snap(c.now(),[]));c.add(15000);mg.observe(snap(c.now(),[]));c.add(30000);await mg.settle();
 assert.equal(mg.status().closed[0].netSource,'MIXED_WITH_COPY');
 // A copy position just closed by the ledger: a cached list still showing it untagged is not a manual trade.
 const cp4=[{status:'CLOSED',symbol:'DOGEUSDT',venueSymbol:'DOGE-USDT',direction:'LONG',openedAt:c.now()-99999,closedAt:c.now()}],jc=new ManualLedger({now:c.now,copyRecords:()=>cp4});
 jc.observe(snap(c.now(),[]));c.add(3000);jc.observe(snap(c.now(),[row({symbol:'DOGEUSDT',venueSymbol:'DOGE-USDT'})],cp4));c.add(3000);jc.observe(snap(c.now(),[row({symbol:'DOGEUSDT',venueSymbol:'DOGE-USDT'})],cp4));
 assert.equal(jc.status().open.length,0);
});

test('manual: positions open at start are adopted at once (adoptedAtStart); a saved open record is kept, not adopted again',async()=>{
 const dir=tmp(),c=clock(),notices=[];
 const m=new ManualLedger({directory:dir,now:c.now,onEvent:e=>notices.push(e)});
 m.observe(snap(c.now(),[row(),row({symbol:'ETHUSDT',venueSymbol:'ETH-USDT',direction:'SHORT',size:1,avg:3000,mark:2990})]));
 const o=m.status().open;assert.equal(o.length,2);assert.ok(o.every(x=>x.adoptedAtStart===true&&x.openedAt===c.now()));
 // Restart: the BTC record from before is kept (same openedAt); a failed refresh (no new read time) changes nothing.
 const first=o.find(x=>x.symbol==='BTCUSDT').openedAt;c.add(60000);
 const m2=new ManualLedger({directory:dir,now:c.now,onEvent:e=>notices.push(e)});assert.equal(m2.status().open.length,2);
 m2.observe(snap(c.now(),[row(),row({symbol:'XRPUSDT',venueSymbol:'XRP-USDT',size:5,avg:2,mark:2})]));
 const o2=m2.status().open;assert.equal(o2.find(x=>x.symbol==='BTCUSDT').openedAt,first);assert.equal(o2.find(x=>x.symbol==='XRPUSDT').adoptedAtStart,true);
 assert.equal(o2.find(x=>x.symbol==='ETHUSDT').missing,undefined,'internal fields stay off the page');
 assert.equal(m2.observe({venuePositions:null,venuePositionsAt:null,venuePositionsError:'HTTP_429'}),false);
 assert.deepEqual(notices,[],'existing positions are not announced on startup');
});

test('historical manual ledger separates overlapping long and short fills by verified direction',async()=>{
 const c=clock(),t=c.now(),events=[],m=new ManualLedger({now:c.now,onEvent:e=>events.push(e),client:{fillHistory:async()=>rows}});
 const trade=(id,direction,openedAt,lastSeenAt,closedAt)=>({id,direction,openedAt,lastSeenAt,closedAt,firstSize:1,size:1,hedge:true,
  status:'CLOSED',symbol:'BTCUSDT',venueSymbol:'BTC-USDT',netSource:'MIXED_WITH_MANUAL',netUSD:-9});
 const long=trade('a','LONG',t-75000,t-30000,t-20000),short=trade('b','SHORT',t-27000,t-10000,t-1000);
 const row=(id,side,positionSide,time,pnl=0)=>({tradeId:id,orderId:id,side,positionSide,time,realizedPnl:pnl,fee:-.01,symbol:'BTC-USDT',qty:1,price:100});
 const rows=[row('1','BUY','LONG',t-76000),row('2','SELL','SHORT',t-28000),row('3','SELL','LONG',t-25000,3),row('4','BUY','SHORT',t-3000,-2)];
 m.store.closed.push(long,short);await m.settle({historyLimit:10,recheck:true});
 assert.deepEqual([long.netUSD,short.netUSD],[2.98,-2.02]);assert.ok([long,short].every(p=>p.netSource==='EXCHANGE_FILLS'));
 assert.equal(events.length,0,'historical settlement does not replay alerts');
 const unresolved={...long,id:'c',netSource:'ESTIMATE',netUSD:-7,size:2};delete unresolved.historyFillKeys;m.store.closed.push(unresolved);
 await m.settle({recheck:true});assert.equal(unresolved.netUSD,-7);assert.equal(unresolved.settlement.state,'TRADE_LINK_UNVERIFIED');
});

test('manual fill fallback records flat round trips missed by the snapshots and skips overlapping copy positions',async()=>{
 const c=clock(),start=c.now(),events=[];
 const fill=(tradeId,symbol,side,time,realizedPnl=0)=>({tradeId,orderId:tradeId,symbol,side,qty:2,price:10,fee:-.1,realizedPnl,time:start+time,positionSide:'BOTH'});
 const fills=[fill('1','BTC-USDT','BUY',1000),fill('2','BTC-USDT','SELL',2000,2),fill('3','BTC-USDT','SELL',3000),fill('4','BTC-USDT','BUY',4000,1),
  fill('5','ETH-USDT','BUY',5000),fill('6','ETH-USDT','SELL',6000,3),fill('7','SOL-USDT','BUY',7000),fill('8','SOL-USDT','SELL',8000,4)];
 const m=new ManualLedger({now:c.now,client:{fillOrders:async()=>fills},
  copyRecords:()=>[{venueSymbol:'ETH-USDT',openedAt:start+3000,closedAt:start+12000}],onEvent:e=>events.push(e)});
 m.observe(snap(start,[row({symbol:'SOLUSDT',venueSymbol:'SOL-USDT'})]));
 m.observe(snap(c.add(15000),[]));
 c.add(45000);await m.recoverFastTrades();await m.recoverFastTrades();
 assert.deepEqual(events.map(e=>[e.type,e.symbol,e.direction,e.netUSD,e.fromFills]),[
  ['MANUAL_OPEN','BTCUSDT','LONG',undefined,true],['MANUAL_SETTLED','BTCUSDT','LONG',1.9,true],
  ['MANUAL_OPEN','BTCUSDT','SHORT',undefined,true],['MANUAL_SETTLED','BTCUSDT','SHORT',.9,true]]);
 assert.ok(m.status().closed.every(t=>t.netSource==='EXCHANGE_FILLS'));
});

test('manual alerts use each exact reduction and final fill, while the journal still settles the entire trade',async()=>{
 const c=clock(),events=[],dir=tmp(),inc=incomeClient([]),fills=[];
 const client={...inc,fillOrders:async({startTs,endTs})=>fills.filter(f=>f.time>startTs&&f.time<=endTs)};
 const make=()=>new ManualLedger({directory:dir,now:c.now,client,onEvent:e=>events.push(e)});
 let m=make();m.observe(snap(c.now(),[row({size:3,avg:100,mark:110})]));
 const partAt=c.add(15000);m.observe(snap(partAt,[row({size:1,avg:100,mark:110})]));
 fills.push({symbol:'BTC-USDT',tradeId:'21',orderId:'9',positionSide:'BOTH',side:'SELL',qty:1,price:103,fee:-0.1,realizedPnl:3,time:partAt-2000},
  {symbol:'BTC-USDT',tradeId:'22',orderId:'10',positionSide:'BOTH',side:'SELL',qty:1,price:99,fee:-0.1,realizedPnl:-1,time:partAt-1000});
 assert.equal(events.length,0,'wait for fills before classifying the reduction');
 m=make();c.add(45000);await m.settle();await m.settle();
 assert.deepEqual(events.map(e=>[e.to,e.netUSD,e.fromFills]),[[2,2.9,true],[1,-1.1,true]],'persisted pending partial orders each emit once');
 assert.match(manualTradeText(events[0]),/부분 익절[\s\S]*잔여 2/);assert.match(manualTradeText(events[1]),/부분 손절[\s\S]*잔여 1/);
 const gone=c.add(1000);m.observe(snap(gone,[]));c.add(15000);m.observe(snap(c.now(),[]));
 fills.push({symbol:'BTC-USDT',tradeId:'23',orderId:'11',positionSide:'BOTH',side:'SELL',qty:1,price:98,fee:-0.1,realizedPnl:-2,time:gone-100});
 c.add(45000);await m.settle();assert.equal(m.status().closed[0].netSource,'PENDING');
 assert.match(manualTradeText(events[2]),/전량 손절[\s\S]*순손익 −\$2\.10 \(거래소 체결[\s\S]*체결 .+ KST/);
 inc.rows.push({symbol:'BTC-USDT',tranId:'later',incomeType:'REALIZED_PNL',income:'8',time:gone-100});
 await m.settle();assert.equal(m.status().closed[0].netUSD,8);assert.equal(events.length,3,'later whole-trade income never sends a second full-close alert');
});

test('manual notifications require confirmed trade data and label exact zero as break-even',()=>{
 const base={symbol:'BTCUSDT',direction:'SHORT',from:2,to:1,fromFills:true,netSource:'EXCHANGE_FILLS'};
 assert.equal(manualTradeText({...base,type:'MANUAL_REDUCE',netUSD:null}),null);
 assert.equal(manualTradeText({...base,type:'MANUAL_SETTLED',netUSD:-2,netSource:'ESTIMATE'}),null);
 assert.equal(manualTradeText({...base,type:'MANUAL_OPEN',fromFills:false,size:1,avg:10}),null);
 assert.match(manualTradeText({...base,type:'MANUAL_REDUCE',netUSD:0}),/부분 본전[\s\S]*순손익 \$0\.00/);
 assert.match(manualTradeText({...base,type:'MANUAL_SETTLED',size:1,netUSD:0}),/전량 본전[\s\S]*순손익 \$0\.00/);
 assert.match(manualTradeText({...base,type:'MANUAL_SETTLED',size:1,netUSD:-.004}),/전량 손절[\s\S]*−\$0\.004/);
});

test('manual alerts survive delayed receipts, restart and missing hedge direction until the exact fee is present',async()=>{
 const c=clock(),dir=tmp(),events=[];let fill=null;
 const m=()=>new ManualLedger({directory:dir,now:c.now,onEvent:e=>events.push(e),client:{
  fillOrders:async()=>{throw Error('bulk unavailable')},fillHistory:async q=>{assert.equal(q.symbol,'BTC-USDT');return fill?[fill]:[]},
  getOrder:async()=>({order:{symbol:'BTC-USDT',orderId:'91',positionSide:'SHORT',side:'BUY'}})}});
 let ledger=m();ledger.observe(snap(c.now(),[row({positionSide:'SHORT',direction:'SHORT',size:2})]));
 const partAt=c.add(15000);ledger.observe(snap(partAt,[row({positionSide:'SHORT',direction:'SHORT',size:1})]));
 c.add(360000);await ledger.settle();assert.equal(events.length,0);assert.equal(ledger.alertStatus().pending,1);
 ledger=m();fill={symbol:'BTC-USDT',orderId:'91',tradeId:'99',time:partAt-1000,side:'BUY',qty:1,price:5,realizedPnl:.1};
 c.add(15000);await ledger.settle();assert.equal(events.length,0,'known realized P&L without a fee is still pending');
 fill.fee=-.1;c.add(30000);await ledger.settle();await ledger.settle();
 assert.equal(ledger.alertStatus().pending,0);assert.equal(events.length,1);
 assert.match(manualTradeText(events[0]),/부분 본전[\s\S]*\$0\.00/);
 fs.rmSync(dir,{recursive:true,force:true});
});

test('real managed copy fills send all position actions, including a reduction and add between equal-size reads',async()=>{
 const c=clock(),at=c.now(),events=[],managed=[],fills=[];
 const m=new ManualLedger({now:c.now,client:{fillOrders:async()=>fills},copyRecords:()=>managed,onEvent:e=>events.push(e)});
 const owner={id:'copy0',alertOwnerId:'copy0',alertOrigin:'COPY',venueSymbol:'BTC-USDT',symbol:'BTCUSDT',direction:'LONG',status:'OPEN',openedAt:at+5000};
 const receipts=(id,side,qty,time,realizedPnl=0,fee=-.01)=>fills.push({orderId:id,tradeId:id,symbol:'BTC-USDT',positionSide:'BOTH',side,qty,price:10,time,realizedPnl,fee});
 m.observe(snap(at,[]));managed.push(owner);
 receipts('1','BUY',1,at+5000);m.observe(snap(c.add(15000),[row({size:1})],managed));
 receipts('2','BUY',1,at+20000);m.observe(snap(c.add(15000),[row({size:2})],managed));
 receipts('3','SELL',1,at+35000,3);receipts('4','BUY',1,at+40000);m.observe(snap(c.add(15000),[row({size:2})],managed));
 receipts('5','SELL',1,at+50000,-2);m.observe(snap(c.add(15000),[row({size:1})],managed));
 receipts('6','SELL',1,at+65000,.01);owner.status='CLOSED';owner.closedAt=at+66000;
 m.observe(snap(c.add(15000),[]));m.observe(snap(c.add(15000),[]));
 c.add(45000);await m.settle();await m.recoverFastTrades();await m.settle();
 const labels=events.sort((a,b)=>a.observedAt-b.observedAt).map(e=>manualTradeText(e).split('\n')[0]);
 assert.deepEqual(labels,['신규 진입','추가 진입','부분 익절','추가 진입','부분 손절','전량 본전'].map(label=>'🔴 실계좌 | 카피 | '+label));
 assert.equal(m.status().closedTotal,0);assert.deepEqual(m.alertStatus().byOrigin,{COPY:6});
});

test('a fast owned automatic signal trade between flat snapshots is confirmed once and stays out of the manual ledger',async()=>{
 const c=clock(),at=c.now(),events=[],fills=[{orderId:'12',tradeId:'1',symbol:'BTC-USDT',positionSide:'BOTH',side:'BUY',qty:1,price:10,time:at+1000,realizedPnl:0,fee:-.01},
  {orderId:'13',tradeId:'2',symbol:'BTC-USDT',positionSide:'BOTH',side:'SELL',qty:1,price:11,time:at+2000,realizedPnl:1,fee:-.01}];
 const owner={alertOrigin:'SIGNAL',alertOwnerId:'short-window',symbol:'BTCUSDT',venueSymbol:'BTC-USDT',direction:'LONG',status:'CLOSED',entryOrderId:'12',createdAt:at+500,closedAt:at+3000};
 const m=new ManualLedger({now:c.now,client:{fillOrders:async()=>fills},copyRecords:()=>[owner],onEvent:e=>events.push(e)});
 m.observe(snap(at,[]));m.observe(snap(c.add(15000),[]));c.add(45000);
 await m.recoverFastTrades();c.add(45000);await m.recoverFastTrades();
 assert.deepEqual(events.map(e=>manualTradeText(e).split('\n')[0]),['🔴 실계좌 | 자동 신호 | 신규 진입','🔴 실계좌 | 자동 신호 | 전량 익절']);
 assert.equal(m.status().closedTotal,0);
});

test('copy loss limit: computed from the copy ledger only — a large manual loss on the same account changes nothing',async()=>{
 const dir=tmp();let size=0;
 const client={leverage:async()=>({maxLongLeverage:20}),setMarginType:async()=>({}),setLeverage:async()=>({}),cancelOrder:async()=>({}),
  positions:async()=>[...(size>0?[{symbol:'TNSR-USDT',positionAmt:String(-size),avgPrice:'0.051',markPrice:'0.053',unrealizedProfit:'-0.12'}]:[]),
   {symbol:'BTC-USDT',positionSide:'BOTH',positionAmt:'1',avgPrice:'50000',markPrice:'40000',unrealizedProfit:'-10000',leverage:'10'}],
  placeOrder:async p=>{if(p.type==='MARKET')size=p.reduceOnly?0:size+Number(p.quantity);return {order:{orderId:'1',avgPrice:'0.051'}}}};
 const contract={symbol:'TNSRUSDT',venueSymbol:'TNSR-USDT',tickSize:'0.00001',quantityStep:'1',minQuantityBase:'1',minNotionalUSDT:2,tradable:true};
 const ex=new CopyExecutor({config:copyConfig({COPY_SIZING:'FIRST_1USD'},'TESTNET'),client,contractOf:async()=>contract,balance:async()=>({equity:400,available:300}),directory:dir,fileName:'copy-store-live.json',now:()=>1e12});
 await ex.handle({id:1,date:1e12,text:'📌 포지션 진입\n━━━━━━━━━━━━━━━━\n🪙 TNSRUSDT  🔴 Short  ×5\n━━━━━━━━━━━━━━━━\n진입가　0.05296 USDT\n현재가　0.05100 USDT\n수량　　880　마진 9.01 USDT\n손익　　🟢 +1.72 USDT'});
 const m=new ManualLedger({directory:dir,copyRecords:()=>[...Object.values(ex.store.positions),...ex.store.closed],now:()=>1e12});
 const {normalizeVenuePosition}=await import('../venue_positions.mjs');
 m.observe(snap(1e12,(await client.positions()).map(r=>normalizeVenuePosition(r)),Object.values(ex.store.positions)));
 assert.equal(m.status().open.length,1);assert.equal(m.status().open[0].symbol,'BTCUSDT');assert.equal(m.status().open[0].unrealized,-10000);
 await ex.reconcile();
 assert.equal(ex.status().killed,false,'-10000 manual is not copy loss (limit 50 % of 400)');assert.equal(ex.status().positions.length,1);
 const copyFile=JSON.parse(fs.readFileSync(path.join(dir,'copy-store-live.json'),'utf8'));assert.ok(!JSON.stringify(copyFile).includes('BTC-USDT'),'the copy ledger never holds the manual trade');
});

test('page: copy and manual closes in one newest-first list with 수동 badges and the 10-per-page pager; stats include both',async()=>{
 const m=await import('../public/live_control.js');const T=1_800_000_000_000;
 const copyClosed=Array.from({length:8},(_,i)=>({symbol:'C'+i,direction:'LONG',openedAt:T-9e6,closedAt:T-i*2e5,netUSD:i%2?-1:2,adds:1}));
 const manualClosed=[{symbol:'M0',direction:'SHORT',openedAt:T-9e6,closedAt:T-1e5,netUSD:5,netSource:'EXCHANGE',adds:0},
  {symbol:'M1',direction:'LONG',openedAt:T-9e6,closedAt:T-5e5,netUSD:-3,netSource:'MIXED_WITH_COPY',adds:2},
  {symbol:'M2',direction:'LONG',openedAt:T-9e6,closedAt:T-2.1e6,netUSD:null,estimateUSD:1.5,netSource:'PENDING',adds:0}];
 const c={mode:'LIVE',enabled:true,positions:[],events:[],closed:copyClosed,closedTotal:8,manual:{open:[],closed:manualClosed,closedTotal:3}};
 const list=m.mergedCloses(c);assert.deepEqual(list.map(x=>x.symbol),['C0','M0','C1','C2','M1','C3','C4','C5','C6','C7','M2']);
 assert.deepEqual(list.map(x=>x.origin),['copy','manual','copy','copy','manual','copy','copy','copy','copy','copy','manual']);
 const st=m.copyStats(c);
 assert.equal(st.copy.n,8);assert.equal(st.copy.net,4);assert.equal(st.manual.n,2,'PENDING not counted yet');assert.equal(st.manual.net,2);assert.equal(st.pending,1);
 assert.equal(st.all.n,10);assert.equal(st.all.net,6);assert.equal(st.all.wins,5);
 m.setCopyPage(0);let h=m.copyHTML(c);
 assert.match(h,/전체 11건<\/small>/,'the 수동 count is in the 카피 / 수동 line (user 2026-11-18: one place per fact)');assert.match(h,/1 \/ 2쪽/);
 assert.match(h,/정산 확인<b >1건/);assert.match(h,/누적 손익<b class="paper-profit">\+\$5\.00/);assert.match(h,/승률<b >100%/);
 assert.match(h,/카피 <b class="">—<\/b> \(0건\) · 수동 <b class="paper-profit">\+\$5\.00<\/b> \(1건\)/);
 assert.match(h,/정산 미확정 10건/);
 const desk=h.slice(h.indexOf('<th>종료</th>'));
 assert.match(desk,/<tr class="vp-manual"><td class="muted">[^<]*<\/td><td><b>M0<\/b> <span class="vp-badge manual">수동<\/span>/);
 assert.match(desk,/<tr class=""><td class="muted">[^<]*<\/td><td><b>C0<\/b> <\/td>/,'copy rows keep their look');
 assert.match(h,/<li class="vp-manual"><span class="muted">[^<]*<\/span><b>M1<\/b><span class="vp-badge manual">수동<\/span>/);
 assert.match(h,/같은 종목의 카피 거래와 정산 내역 겹침/);assert.doesNotMatch(h,/−\$3\.00|추정/);
 assert.ok(!h.includes('>M2<'),'11th row on page 2');
 m.setCopyPage(1);h=m.copyHTML(c);assert.match(h,/2 \/ 2쪽/);assert.ok(h.includes('>M2<'));assert.match(h,/정산 미확정<\/span>/);assert.ok(!h.includes('>C0<'));
 m.setCopyPage(0);
 // Testnet (no manual ledger): unchanged, no split line.
 assert.doesNotMatch(m.copyHTML({...c,manual:undefined}),/copy-split/);
});
