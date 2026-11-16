// 되돌림 단타 trade journal (user 2026-11-16 22:18): full per-trade lines, detected-signal lines, the 20-row
// screen, the reports export and summary. A fake BingX testnet only; nothing leaves the process.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {ScalpExecutor,scalpExecConfig} from '../scalp_executor.mjs';
import {appendJsonl,readJsonl,tailJsonl,summarizeJournal,signalsPath,scalpReportFiles,exportLine,trackExcursion,journalLine} from '../scalp_journal.mjs';
import {buildReport,pushReport} from '../reports_push.mjs';
import {scalpHTML} from '../public/live_control.js';

const I=300000,BUCKET=Math.floor(Date.parse('2026-11-16T03:00:00Z')/I),T0=BUCKET*I+5000;
function crash(){
 const rows=[];let p=100;const push=(o,h,l,c,v)=>rows.push([0,o,h,l,c,v]);
 for(let i=0;i<50;i++){const o=p,c=p+(i%2?.05:-.05);push(o,Math.max(o,c)+.1,Math.min(o,c)-.1,c,100);p=c}
 for(let i=0;i<4;i++){const o=p,c=p-1.5;push(o,o+.05,c-.1,c,1000*(i===3?1:.5));p=c}
 push(p,p+.15,p-.8,p+.1,800);
 return rows.map((r,i)=>{const t=(BUCKET-1)*I-(rows.length-1-i)*I;return [t,...r.slice(1,6).map(String),t+I-1,String(r[5]*r[4])]});
}
const up4h=now=>Array.from({length:301},(_,i)=>{const t=now-(301-i)*4*3600000-1000,c=50+i*.1;return [t,String(c),String(c+.2),String(c-.2),String(c),'1000',t+4*3600000-1,'1']});
const ENTRY=Number(crash().at(-1)[4]),PX=+(ENTRY+.02).toFixed(2),FILL=+(PX+.03).toFixed(2);
const SOL={symbol:'SOLUSDT',venueSymbol:'SOL-USDT',tickSize:'0.01',quantityStep:'0.01',minQuantityBase:'0.01',minNotionalUSDT:2,tradable:true};

function venue(){
 const calls=[],orders=new Map();let amt=0,avg=0,mark=0,id=1;const income=[];
 const add=(p,extra={})=>{const o={orderId:String(id++),...p,status:'NEW',...extra};orders.set(o.orderId,o);return o};
 const client={mode:'TESTNET',positionMode:async()=>({dualSidePosition:false}),marginType:async()=>({marginType:'CROSSED'}),setMarginType:async()=>({}),
  leverage:async()=>({maxLongLeverage:20,maxShortLeverage:20}),setLeverage:async(s,side,l)=>({leverage:l}),
  positions:async()=>amt?[{symbol:'SOL-USDT',positionAmt:String(amt),avgPrice:String(avg),markPrice:String(mark||avg),unrealizedProfit:String(((mark||avg)-avg)*amt)}]:[],
  openOrders:async()=>({orders:[...orders.values()].filter(o=>o.status==='NEW')}),
  getOrder:async(s,{orderId,clientOrderId})=>({order:[...orders.values()].find(o=>orderId?o.orderId===orderId:o.clientOrderId===clientOrderId)??null}),
  cancelOrder:async(s,oid)=>{const o=orders.get(oid);if(o?.status==='NEW')o.status='CANCELED';return {}},
  income:async()=>income,
  placeOrder:async p=>{calls.push(p);
   if(p.type==='MARKET'){const q=Number(p.quantity);
    if(p.reduceOnly){amt=+Math.max(0,amt-q).toFixed(8);return {order:add(p,{status:'FILLED',executedQty:String(q),avgPrice:String(mark||avg)})}}
    avg=FILL;amt=+(amt+q).toFixed(8);const o=add(p,{status:'FILLED',executedQty:String(q),avgPrice:String(avg)});
    if(p.stopLoss)add({symbol:p.symbol,type:'STOP_MARKET',stopPrice:String(JSON.parse(p.stopLoss).stopPrice),side:'SELL'});return {order:o}}
   return {order:add(p)}}};
 return {client,orders,income,get amt(){return amt},set mark(v){mark=v},
  fill(o,price){o.status='FILLED';o.executedQty=o.quantity??String(amt);o.avgPrice=String(price);amt=+Math.max(0,amt-Number(o.executedQty)).toFixed(8)}};
}
function make(v,dir,clock){
 return new ScalpExecutor({config:scalpExecConfig({}),client:v.client,contracts:async()=>new Map([['SOLUSDT',SOL]]),tickers:async()=>[{symbol:'XRP-USDT',quoteVolume:'9e8'},{symbol:'SOL-USDT',quoteVolume:'9e7'}],
  candles:async(s,iv)=>iv==='5m'?(s==='XRPUSDT'?[]:[...crash(),[BUCKET*I,'100','100','100','100','1',BUCKET*I+I-1,'1']]):up4h(clock.t),
  priceOf:async()=>PX,markOf:async()=>null,balance:async()=>({equity:10000,available:9000}),directory:dir,now:()=>clock.t});
}
const tmp=()=>fs.mkdtempSync(path.join(os.tmpdir(),'scalp-journal-'));
const contracts=async()=>new Map([['SOLUSDT',SOL],['XRPUSDT',{...SOL,symbol:'XRPUSDT',venueSymbol:'XRP-USDT'}]]);

test('journal line: detection evidence, plan, fill slippage, delay, MFE/MAE from marks, TP fill, breakeven, settled PnL and R',async()=>{
 const dir=tmp(),v=venue(),clock={t:T0},ex=make(v,dir,clock);ex.contracts=contracts;ex.arm();
 const st=await ex.scan();assert.equal(st.entered,1,JSON.stringify(ex.store.skips));
 const p=ex.store.open[0];assert.equal(p.universe.rank,2);assert.equal(p.scan.position,2);assert.ok(p.scan.durationMs>=0);
 // Marks while open: up 1 R-ish, then down; the extremes are kept.
 const risk=p.avg-p.initialStop;
 v.mark=p.avg+risk*.8;clock.t+=15000;await ex.reconcile();v.mark=p.avg-risk*.5;clock.t+=15000;await ex.reconcile();
 assert.ok(Math.abs(p.mfeR-.8)<.01&&Math.abs(p.maeR+.5)<.01,JSON.stringify([p.mfeR,p.maeR]));
 v.mark=p.targets[0]+.01;v.fill(v.orders.get(p.tpOrderIds[0]),p.targets[0]);clock.t+=15000;await ex.reconcile();
 assert.ok(p.breakevenAt>0);v.fill(v.orders.get(p.stopOrderId),p.stop);clock.t+=15000;await ex.reconcile();clock.t+=15000;await ex.reconcile();
 assert.equal(ex.store.open.length,0);assert.equal(readJsonl(path.join(dir,'scalp-journal.jsonl')).length,0,'waits for the venue settlement');
 v.income.push({symbol:'SOL-USDT',incomeType:'REALIZED_PNL',income:'4.2',time:String(clock.t-1000)},{symbol:'SOL-USDT',incomeType:'TRADING_FEE',income:'-0.7',time:String(clock.t-1000)});
 clock.t+=160000;await ex.reconcile();
 const [line]=readJsonl(path.join(dir,'scalp-journal.jsonl'));assert.ok(line,'written after the settlement');
 assert.equal(line.symbol,'SOLUSDT');assert.equal(line.direction,'LONG');assert.equal(line.barAt,BUCKET*I);assert.equal(line.id,p.id);
 for(const k of ['movePct','moveAtr','climaxVolumeRatio','rsiPeak','retracedPct','extreme','origin'])assert.ok(k in line.evidence,k);
 assert.ok(line.candle.wickShare>.5);assert.equal(line.trend4h,'up');assert.ok(line.atr>0);
 assert.equal(line.plan.checkedPrice,PX);assert.ok(line.plan.tp1NetR>=1);assert.deepEqual(line.plan.targets,p.targets);assert.ok(line.plan.riskUSD>0&&line.plan.marginUSD>0);
 assert.equal(line.entry.price,FILL);assert.equal(line.entry.slippageBpsVsPlan,+((FILL-PX)/PX*1e4).toFixed(2),'paid 3 ticks more than checked');
 assert.equal(line.entry.delayMs,5000);assert.equal(line.entry.leverage,10);
 assert.equal(line.universe.rank,2);assert.equal(line.universe.quoteVolume,9e7);assert.equal(line.scan.position,2);
 assert.equal(line.tpFills.length,1);assert.equal(line.tpFills[0].price,p.targets[0]);assert.equal(line.tpHits,1);
 assert.equal(line.breakeven.moved,true);assert.ok(line.breakeven.at>0);assert.equal(line.exit.reason,'BREAKEVEN_STOP');assert.ok(line.exit.holdMin>0);
 assert.ok(line.excursion.mfeR>=.99,'the TP1 fill counts as an excursion');assert.ok(Math.abs(line.excursion.maeR+.5)<.01);
 assert.equal(line.pnl.netSource,'EXCHANGE');assert.equal(line.pnl.netUSD,3.5);assert.equal(line.pnl.feeUSD,-.7);assert.ok(line.pnl.estimate.netUSD>0);
 assert.equal(line.pnl.r,+(3.5/line.pnl.riskUSDActual).toFixed(4));
 assert.ok(line.btc&&Number.isFinite(line.btc.change5mPct),'BTC change when cheaply available');
 // Detected signals: one line, entered.
 const sig=readJsonl(fs.readdirSync(dir).filter(f=>f.startsWith('scalp-signals-')).map(f=>path.join(dir,f))[0]);assert.equal(sig.length,1);assert.equal(sig[0].entered,true);assert.equal(sig[0].plan.price,PX);
 // API helper and the stats over the journal.
 assert.equal(ex.journal(5).length,1);assert.equal(ex.stats().trades,1);assert.equal(ex.stats().netUSD,3.5);
 // Restart: the stats come back from the journal file; no second line.
 const again=make(v,dir,clock);assert.equal(again.stats().trades,1);clock.t+=3*3600000;await again.reconcile();assert.equal(readJsonl(path.join(dir,'scalp-journal.jsonl')).length,1);
 fs.rmSync(dir,{recursive:true,force:true});
});

test('skipped signals are logged with their reason; the signals file rotates at its cap',async()=>{
 const dir=tmp(),v=venue(),clock={t:T0},ex=make(v,dir,clock);ex.contracts=contracts;ex.priceOf=async()=>PX*1.01;ex.arm();await ex.scan();
 const [s]=readJsonl(fs.readdirSync(dir).filter(f=>f.startsWith('scalp-signals-')).map(f=>path.join(dir,f))[0]);assert.equal(s.entered,false);assert.equal(s.reason,'PRICE_DRIFT');assert.ok(s.evidence.movePct>=5);assert.equal(s.universe.rank,2);
 const f=path.join(dir,'x.jsonl');for(let i=0;i<5;i++)appendJsonl(f,{i,pad:'x'.repeat(100)},{maxBytes:300});
 assert.ok(fs.existsSync(path.join(dir,'x.1.jsonl')));assert.ok(fs.statSync(f).size<=300);
 assert.deepEqual(tailJsonl(f,1).map(x=>x.i),[4]);
 fs.rmSync(dir,{recursive:true,force:true});
});

test('screen: only the 20 newest closed trades, with side, times, reason, R and MFE/MAE; stats over every trade',()=>{
 const dir=tmp(),v=venue(),clock={t:T0+86400000},ex=make(v,dir,clock);
 for(let i=0;i<30;i++){const x={id:'k'+i,symbol:'S'+i+'USDT',direction:i%2?'SHORT':'LONG',avg:100,initialStop:i%2?101:99,filled:1,qty:1,openedAt:T0+i*60000,closedAt:T0+i*60000+600000,
  closeReason:'STOP',netUSD:i<25?-1:2,estimate:{netUSD:-1},rMultiple:-1,mfeR:.4,maeR:-1,journalV:1};ex.store.closed.push(x)}
 ex.store.closed.splice(0,5);  // the store keeps fewer than every trade...
 for(let i=0;i<5;i++)ex.store.closed.unshift({id:'old'+i,symbol:'O',direction:'LONG',closedAt:T0,netUSD:-1,journaled:true});
 ex.journalRows.push(...Array.from({length:12},()=>({direction:'LONG',netUSD:1,closedAt:T0,closeReason:'ALL_TARGETS'})));
 const s=ex.status();assert.equal(s.closed.length,20);assert.equal(s.closed[0].symbol,'S29USDT');
 assert.equal(s.stats.trades,12+25,'...the stats count the journal and the trades not yet in it');
 const h=scalpHTML(s);const table=h.slice(h.indexOf('<th>종목</th><th>방향</th><th>진입</th>'));
 assert.equal((table.match(/<tr><td><b>S\d+USDT/g)||[]).length,20);assert.match(h,/최근 20건/);assert.match(table,/−1\.00R/);assert.match(table,/\+0\.40R \/ −1\.00R/);
 const mob=h.slice(h.indexOf('최근 종료'));assert.equal((mob.slice(0,mob.indexOf('<table')).match(/<li>/g)||[]).length,20);
 fs.rmSync(dir,{recursive:true,force:true});
});

test('export: summary by side / exit reason / move / hour / rank, trades.jsonl without client ids, daily signals, pushed to the reports repo',async()=>{
 const dir=tmp(),now=Date.parse('2026-11-16T05:00:00Z'),jf=path.join(dir,'scalp-journal.jsonl'),sf=path.join(dir,'scalp-signals.jsonl');
 const mk=(i,dir_,net,reason,move,rank,at)=>journalLine({id:'sc'+i,symbol:'A'+i+'USDT',venueSymbol:'A'+i+'-USDT',direction:dir_,barAt:at-5000,openedAt:at,closedAt:at+600000,avg:100,initialStop:dir_==='LONG'?99:101,filled:2,
  checkedPrice:100,plannedEntry:100,entry:100,evidence:{movePct:move},universe:{rank},closeReason:reason,netUSD:net,estimate:{netUSD:net},mfeR:1,maeR:-.5});
 const at=Date.parse('2026-11-16T01:10:00Z');// 10:10 KST
 [mk(1,'LONG',2,'ALL_TARGETS',5.5,3,at),mk(2,'LONG',-2,'STOP',9,40,at),mk(3,'SHORT',1,'TIME_STOP',13,70,at+3600000)].forEach(l=>appendJsonl(jf,l));
 appendJsonl(signalsPath(sf,now-1000),{at:now-1000,symbol:'B',venueSymbol:'B-USDT',entered:false,reason:'PRICE_DRIFT'});appendJsonl(signalsPath(sf,now-3*86400000),{at:now-3*86400000,symbol:'C',entered:false});
 const {files,summary}=scalpReportFiles({journalFile:jf,signalsFile:sf,now});
 assert.equal(summary.all.trades,3);assert.equal(summary.bySide.LONG.trades,2);assert.equal(summary.bySide.SHORT.netUSD,1);assert.equal(summary.byExitReason.STOP.wins,0);
 assert.deepEqual(Object.keys(summary.byMoveBucket).sort(),['12%+','5-6%','8-12%']);assert.deepEqual(Object.keys(summary.byHourKst).sort(),['10','11']);
 assert.deepEqual(Object.keys(summary.byUniverseRank).sort(),['1-10위','31-60위','61위+']);assert.equal(summary.all.avgMfeR,1);assert.equal(summary.all.profitFactor,1.5);
 const trades=files['scalp/trades.jsonl'].trim().split('\n').map(JSON.parse);assert.equal(trades.length,3);
 assert.ok(trades.every(x=>!('id' in x)&&!('venueSymbol' in x)&&x.tradeKey));assert.equal(exportLine({id:'sc',symbol:'A',direction:'LONG',barAt:1}).tradeKey,'A|LONG|1');
 assert.deepEqual(Object.keys(files).sort(),['scalp/signals-2026-11-16.jsonl','scalp/trades.jsonl']);assert.equal(files['scalp/signals-2026-11-16.jsonl'].trim().split('\n').length,1);
 const report=buildReport({readiness:{ready:false},records:[],scalp:summary,now});assert.equal(report.scalp.all.trades,3);
 // Pushed with the report.
 const bare=path.join(dir,'remote.git'),work=path.join(dir,'reports');
 execFileSync('git',['init','-q','--bare',bare]);execFileSync('git',['clone','-q',bare,work],{stdio:'ignore'});
 assert.equal((await pushReport(work,report,{now,files})).pushed,true);
 const listed=execFileSync('git',['--git-dir',bare,'ls-tree','-r','--name-only','HEAD'],{encoding:'utf8'});
 assert.match(listed,/scalp\/trades\.jsonl/);assert.match(listed,/scalp\/signals-2026-11-16\.jsonl/);
 await assert.rejects(pushReport(work,report,{now,files:{'scalp/x.jsonl':'{"apiKey":"x"}\n'}}),/REPORT_SECRET_FIELD/);
 assert.equal((await pushReport(work,report,{now:now+1,files:{'../escape.txt':'x'}})).reason,'NO_CHANGE','paths outside the repository are not written');
 fs.rmSync(dir,{recursive:true,force:true});
});

test('MFE/MAE in % and R, both sides',()=>{
 const l={direction:'LONG',avg:100,initialStop:98};trackExcursion(l,103,1);trackExcursion(l,99,2);trackExcursion(l,101,3);
 assert.deepEqual([l.mfePct,l.mfeR,l.maePct,l.maeR],[3,1.5,-1,-.5]);
 const s={direction:'SHORT',avg:100,initialStop:102};trackExcursion(s,97,1);trackExcursion(s,101,2);
 assert.deepEqual([s.mfePct,s.mfeR,s.maePct,s.maeR],[3,1.5,-1,-.5]);
});
