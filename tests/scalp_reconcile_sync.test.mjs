import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {ScalpExecutor,scalpExecConfig,scalpLiveExecConfig} from '../scalp_executor.mjs';
import {scalpEventText} from '../scalp_telegram.mjs';
import {testnetUntrackedCardHTML} from '../public/live_control.js';

function makeExec({client,mode='TESTNET',open=[],closed=[]}){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'scalp-sync-'));
 const fileName='scalp-store.json';
 fs.writeFileSync(path.join(dir,fileName),JSON.stringify({open,closed,events:[],dailyStop:null}),'utf8');
 const events=[];
 const config=mode==='LIVE'
  ?scalpLiveExecConfig({SCALP_LIVE_MODE:'LIVE',SCALP_LIVE_CONFIRM:'REAL_MONEY_SCALP'})
  :scalpExecConfig({SCALP_EXEC_MODE:'TESTNET',SCALP_STOP_LOSS:'off'});
 const ex=new ScalpExecutor({
  config,
  client,
  directory:dir,
  fileName,
  balance:async()=>({equity:3000,available:2000}),
  priceOf:async()=>2.85,
  markOf:async()=>2.85,
  onEvent:e=>events.push(e),
 });
 return {ex,dir,events,cleanup:()=>fs.rmSync(dir,{recursive:true,force:true})};
}

const sampleOpen=()=>({
 id:'evaa-1',
 symbol:'EVAAUSDT',
 venueSymbol:'EVAA-USDT',
 direction:'SHORT',
 status:'OPEN',
 hedge:false,
 leverage:5,
 avg:2.4162,
 entry:2.4162,
 firstEntryPrice:2.4162,
 initialStop:2.65,
 stop:2.65,
 size:77.614,
 filled:77.614,
 quantityStep:0.001,
 tickSize:0.0001,
 parts:[77.614,0,0],
 targets:[2.3,2.2,2.1],
 tpOrderIds:[],
 stopIds:[],
 exitIds:[],
 steps:[{kind:'OPEN',at:Date.now()-60000,qty:77.614,avg:2.4162}],
 openedAt:Date.now()-60000,
 createdAt:Date.now()-60000,
 stopLossEnabled:false,
});

test('reconcile ignores non-array bulk positions() response without closing open positions',async()=>{
 const client={
  mode:'TESTNET',
  positions:async()=>null,
  openOrders:async()=>[],
  balance:async()=>({balance:{equity:'3000',availableMargin:'2000'}}),
 };
 const {ex,events,cleanup}=makeExec({client,open:[sampleOpen()]});
 try{
  await ex.reconcile();
  await ex.reconcile();
  assert.equal(ex.store.open.length,1);
  assert.equal(ex.store.closed.length,0);
  assert.equal(ex.store.open[0].zeroSeen||0,0);
  assert.ok(events.some(e=>e.type==='RECONCILE_ERROR'&&e.reason==='BAD_POSITIONS_RESPONSE'));
 }finally{cleanup()}
});

test('reconcile verifies symbol-specifically before EXTERNAL close and prevents false close when bulk positions() omits a live coin',async()=>{
 let symbolChecks=0;
 const liveRow={symbol:'EVAA-USDT',positionSide:'BOTH',positionAmt:'-77.614',avgPrice:'2.4162',markPrice:'2.45',unrealizedProfit:'-2.62',initialMargin:'37.51',leverage:'5'};
 const client={
  mode:'TESTNET',
  // Bulk call (no symbol) glitches and omits EVAA-USDT; symbol-specific call returns the real open position!
  positions:async sym=>{
   if(!sym)return [];
   symbolChecks++;
   return sym==='EVAA-USDT'?[liveRow]:[];
  },
  openOrders:async()=>[],
  balance:async()=>({balance:{equity:'3000',availableMargin:'2000'}}),
 };
 const {ex,events,cleanup}=makeExec({client,open:[sampleOpen()]});
 try{
  await ex.reconcile(); // zeroSeen -> 1
  assert.equal(ex.store.open.length,1);
  assert.equal(symbolChecks,0);
  await ex.reconcile(); // zeroSeen -> 2 -> symbol-specific verify catches live row!
  assert.equal(symbolChecks,1);
  assert.equal(ex.store.open.length,1);
  assert.equal(ex.store.closed.length,0);
  assert.equal(ex.store.open[0].zeroSeen,0);
  assert.ok(events.some(e=>e.type==='POSITION_BULK_MISS'&&e.symbol==='EVAAUSDT'));
 }finally{cleanup()}
});

test('reconcile does NOT close as EXTERNAL if symbol-specific confirmation fails with network error',async()=>{
 const client={
  mode:'TESTNET',
  positions:async sym=>{
   if(!sym)return [];
   throw Object.assign(Error('timeout'),{code:'NETWORK_UNREACHABLE'});
  },
  openOrders:async()=>[],
  balance:async()=>({balance:{equity:'3000',availableMargin:'2000'}}),
 };
 const {ex,events,cleanup}=makeExec({client,open:[sampleOpen()]});
 try{
  await ex.reconcile();
  await ex.reconcile();
  assert.equal(ex.store.open.length,1);
  assert.equal(ex.store.closed.length,0);
  assert.ok(events.some(e=>e.type==='RECONCILE_ERROR'&&e.symbol==='EVAAUSDT'));
 }finally{cleanup()}
});

test('TESTNET reconcile automatically recovers a recently EXTERNAL-closed position still open on BingX',async()=>{
 const falseClosed={
  ...sampleOpen(),
  status:'CLOSED',
  closedAt:Date.now()-3600000,
  closeReason:'EXTERNAL',
  netUSD:-5.1,
  netSource:'ESTIMATE',
  journaled:true,
 };
 const liveRow={symbol:'EVAA-USDT',positionSide:'BOTH',positionAmt:'-77.614',avgPrice:'2.4162',markPrice:'2.85',unrealizedProfit:'-34.29',initialMargin:'37.5062',leverage:'5'};
 const client={
  mode:'TESTNET',
  positions:async()=>[liveRow],
  openOrders:async()=>[],
  balance:async()=>({balance:{equity:'3000',availableMargin:'2000'}}),
 };
 const {ex,events,cleanup}=makeExec({client,open:[],closed:[falseClosed]});
 try{
  await ex.reconcile();
  assert.equal(ex.store.open.length,1);
  assert.equal(ex.store.closed.length,0);
  const rec=ex.store.open[0];
  assert.equal(rec.symbol,'EVAAUSDT');
  assert.equal(rec.status,'OPEN');
  assert.equal(rec.size,77.614);
  assert.equal(rec.avg,2.4162);
  assert.equal(rec.closeReason,undefined);
  assert.equal(rec.journaled,false);
  const ev=events.find(e=>e.type==='POSITION_RECOVERED');
  assert.ok(ev);
  assert.match(scalpEventText(ev),/오인 종료\(EXTERNAL\) 해제/);
 }finally{cleanup()}
});

test('LIVE mode never auto-recovers EXTERNAL-closed positions (manual-first invariant)',async()=>{
 const falseClosed={
  ...sampleOpen(),
  status:'CLOSED',
  closedAt:Date.now()-3600000,
  closeReason:'EXTERNAL',
  netUSD:-5.1,
  netSource:'ESTIMATE',
 };
 const liveRow={symbol:'EVAA-USDT',positionSide:'BOTH',positionAmt:'-77.614',avgPrice:'2.4162',markPrice:'2.85',unrealizedProfit:'-34.29',initialMargin:'37.5062',leverage:'5'};
 const client={
  mode:'LIVE',
  positions:async()=>[liveRow],
  openOrders:async()=>[],
  balance:async()=>({balance:{equity:'3000',availableMargin:'2000'}}),
 };
 const {ex,cleanup}=makeExec({client,mode:'LIVE',open:[],closed:[falseClosed]});
 try{
  await ex.reconcile();
  assert.equal(ex.store.open.length,0);
  assert.equal(ex.store.closed.length,1);
 }finally{cleanup()}
});

test('testnetUntrackedCardHTML renders untracked venue position safely with direct venue close button',()=>{
 const html=testnetUntrackedCardHTML({
  symbol:'BLESSUSDT',
  venueSymbol:'BLESS-USDT',
  direction:'LONG',
  size:22986.3,
  avg:0.016274,
  mark:0.016293,
  margin:37.4079,
  unrealized:0.4367,
  roePct:1.16,
  leverage:10,
  marginMode:'CROSSED',
 });
 assert.ok(html.includes('BLESSUSDT'));
 assert.ok(html.includes('거래소 미추적'));
 assert.ok(html.includes('data-strategy="venue"'));
 assert.ok(html.includes('data-testnet-close="BLESS-USDT|LONG"'));
 assert.ok(html.includes('10배 교차'));
 assert.ok(html.includes('+1.16%'));
});

test('one-time TESTNET migration purges corrupted EVAAUSDT (opened 1795599322366, -$31.95) from store, journal, and cumulative PnL while keeping other trades',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'scalp-evaa-purge-'));
 try{
  const badClosed={
   ...sampleOpen(),
   id:'evaa-bug-1',
   status:'CLOSED',
   openedAt:1795599322366,
   closedAt:1795659018266,
   closeReason:'EMERGENCY_ROE_STOP',
   netUSD:-31.9511,
   journaled:true,
  };
  const goodClosed={
   ...sampleOpen(),
   id:'bless-ok-1',
   symbol:'BLESSUSDT',
   venueSymbol:'BLESS-USDT',
   direction:'LONG',
   status:'CLOSED',
   openedAt:1795657514073,
   closedAt:1795657844865,
   closeReason:'LADDER_TAKE_PROFIT',
   netUSD:4.1,
   journaled:true,
  };
  fs.writeFileSync(path.join(dir,'scalp-store.json'),JSON.stringify({open:[],closed:[goodClosed,badClosed],events:[],dailyStop:null}),'utf8');
  const journalLines=[
   {id:'evaa-old-ext',symbol:'EVAAUSDT',direction:'SHORT',entry:{at:1795599322366},exit:{at:1795600655473,reason:'EXTERNAL'},pnl:{netUSD:-5.2}},
   {id:'evaa-bug-1',symbol:'EVAAUSDT',direction:'SHORT',entry:{at:1795599322366},exit:{at:1795659018266,reason:'EMERGENCY_ROE_STOP'},pnl:{netUSD:-31.9511}},
   {id:'bless-ok-1',symbol:'BLESSUSDT',direction:'LONG',entry:{at:1795657514073},exit:{at:1795657844865,reason:'LADDER_TAKE_PROFIT'},pnl:{netUSD:4.1}},
  ];
  fs.writeFileSync(path.join(dir,'scalp-journal.jsonl'),journalLines.map(x=>JSON.stringify(x)).join('\n')+'\n','utf8');

  const ex=new ScalpExecutor({
   config:scalpExecConfig({SCALP_EXEC_MODE:'TESTNET',SCALP_STOP_LOSS:'off'}),
   directory:dir,
   fileName:'scalp-store.json',
  });
  assert.equal(ex.store.closed.length,1);
  assert.equal(ex.store.closed[0].id,'bless-ok-1');
  assert.equal(ex.journalRows.length,1);
  assert.equal(ex.stats().trades,1);
  assert.equal(ex.stats().netUSD,4.1);
  assert.equal(ex.store.migrations.purgeEvaaBug1795599322,true);

  // deleteClosedTrade removes remaining BLESSUSDT trade from store & journal, excluding from cumulative PnL
  const del=ex.deleteClosedTrade('bless-ok-1');
  assert.equal(del.ok,true);
  assert.equal(ex.store.closed.length,0);
  assert.equal(ex.journalRows.length,0);
  assert.equal(ex.stats().trades,0);
  assert.equal(ex.stats().netUSD,0);
  assert.equal(ex.deleteClosedTrade('bless-ok-1').ok,false);
 }finally{
  fs.rmSync(dir,{recursive:true,force:true});
 }
});

test('deleteClosedTrade is refused in LIVE mode',()=>{
 const client={mode:'LIVE',positions:async()=>[],openOrders:async()=>[]};
 const {ex,cleanup}=makeExec({client,mode:'LIVE',closed:[{...sampleOpen(),id:'live-1',status:'CLOSED',netUSD:-10}]});
 try{
  const r=ex.deleteClosedTrade('live-1');
  assert.equal(r.ok,false);
  assert.equal(r.reason,'SCALP_TESTNET_ONLY');
  assert.equal(ex.store.closed.length,1);
 }finally{cleanup()}
});

