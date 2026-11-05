import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {OrangeXPaperEngine} from '../orangex_paper.mjs';
import {OrangeXPaperStore} from '../orangex_paper_store.mjs';
import {trackChild,stopChild} from './helpers/child_process.mjs';

// Explicit synthetic contract, quote levels and signals. These tests make no
// claim about OrangeX market data, actual fills, fee rates or profitability.
const START=Date.parse('2026-10-28T00:00:01Z'),NAME='BTC-USDT-PERPETUAL';
const settings={capitalUSD:10000,leverage:3,maxRiskUSD:6,dailyLossLimitUSD:30,maxPositions:2,
 maxPositionNotionalUSD:500,maxTotalNotionalUSD:1000,maxQuoteAgeMs:90000,maxSignalAgeMs:7200000,
 entryTimeoutMs:1200000,maxSpreadBps:30,maxSlippageBps:100};
const contract={instrumentName:NAME,symbol:'BTCUSDT',source:'SYNTHETIC_FIXTURE',quantityUnit:'CONTRACT',
 contractSizeBase:1,minQty:.001,qtyStep:.001,minNotional:1,priceTick:.01,makerRate:.0002,takerRate:.0006,
 feeUnit:'FRACTION',fundingRate:.0001,fundingIntervalMs:28800000,unitsVerifiedForSimulation:true};
const signal=(key='fault-synthetic',at=START)=>({key,symbol:'BTCUSDT',instrumentName:NAME,direction:'LONG',entry:100,stop:98,
 patternConfirmedAt:at-1,timeframe:'1h',trendTimeframe:'4h',confirmed:true,trendConfirmed:true});
const market=(at,{bid=99.99,ask=100.01,size=1000,...patch}={})=>({instrumentName:NAME,dataSource:'SYNTHETIC_FIXTURE',
 bids:[[bid,size]],asks:[[ask,size]],timestamp:at,markPrice:(bid+ask)/2,markPriceAt:at,...patch});
const context={executionMode:'SYNTHETIC_TEST',runKind:'FORWARD_PAPER'};
const remove=directory=>fs.rmSync(directory,{recursive:true,force:true,maxRetries:8,retryDelay:100});

async function abruptPartialWriter(directory,{signal:abortSignal}={}){
 const engineURL=new URL('../orangex_paper.mjs',import.meta.url).href,
  storeURL=new URL('../orangex_paper_store.mjs',import.meta.url).href;
 const code=`
  import {OrangeXPaperEngine} from ${JSON.stringify(engineURL)};
  import {OrangeXPaperStore} from ${JSON.stringify(storeURL)};
  let clock=${START};
  const store=new OrangeXPaperStore({directory:process.argv[1],now:()=>clock});
  const engine=new OrangeXPaperEngine({}, {now:()=>clock,onChange:state=>store.write(state),
   settings:${JSON.stringify(settings)},contracts:[${JSON.stringify(contract)}],...${JSON.stringify(context)}});
  if(!engine.register(${JSON.stringify(signal())},{dataSource:'SYNTHETIC_FIXTURE',orderType:'LIMIT',limitPrice:99.5}))throw Error('synthetic signal refused');
  clock++;engine.onMarket(${JSON.stringify(market(START+1,{bid:99.49,ask:99.5,size:.2}))});
  const state=engine.exportState();
  process.stdout.write(JSON.stringify({kind:'DURABLE_ACK',quantity:state.open[0].quantityOriginal,
   remaining:state.pending[0].quantityRemaining,parts:state.open[0].entryParts.length})+'\\n');
  setInterval(()=>{},1000);
 `;
 const child=trackChild(spawn(process.execPath,['--input-type=module','-e',code,directory],{
  cwd:path.dirname(directory),env:{PATH:process.env.PATH,...(process.env.SystemRoot?{SystemRoot:process.env.SystemRoot}:{})},
  windowsHide:true,stdio:['ignore','pipe','pipe']}));
 let stderr='',timer,onData,onError,onClose,onAbort;
 const stderrData=chunk=>{stderr=(stderr+String(chunk)).slice(-8192)};
 child.stderr.on('data',stderrData);
 try{
  const ack=await new Promise((resolve,reject)=>{
   let output='';timer=setTimeout(()=>reject(Error('synthetic child acknowledgement timed out')),10000);
   onError=error=>reject(error);
   onClose=()=>reject(Error('synthetic child exited before acknowledgement: '+stderr));
   onAbort=()=>reject(abortSignal.reason??Error('synthetic writer test aborted'));
   child.once('error',onError);child.once('close',onClose);
   abortSignal?.addEventListener('abort',onAbort,{once:true});if(abortSignal?.aborted)onAbort();
   onData=chunk=>{
    output+=String(chunk);if(!output.includes('\n'))return;
    clearTimeout(timer);try{resolve(JSON.parse(output.slice(0,output.indexOf('\n'))))}catch(error){reject(error)}
   };
   child.stdout.on('data',onData);
  });
  assert.equal(ack.kind,'DURABLE_ACK');
  assert.equal(child.kill('SIGKILL'),true,'the acknowledged writer must be abruptly killed');
  await stopChild(child,{graceMs:1000,killMs:1000});
  return ack;
 }finally{
  clearTimeout(timer);abortSignal?.removeEventListener('abort',onAbort);
  if(onError)child.removeListener('error',onError);if(onClose)child.removeListener('close',onClose);
  try{await stopChild(child,{graceMs:1000,killMs:1000})}
  finally{if(onData)child.stdout.removeListener('data',onData);child.stderr.removeListener('data',stderrData)}
 }
}

test('abrupt shutdown after acknowledged partial fill recovers exact quantities and never replays liquidity',{timeout:20000},async(t)=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'orangex-crash25-')),directory=path.join(root,'orangex-paper');
 const legacy=path.join(root,'store.json');fs.writeFileSync(legacy,'legacy PNL and settings stay untouched');
 let store;
 try{
  const ack=await abruptPartialWriter(directory,{signal:t.signal});assert.ok(Math.abs(ack.quantity-.2)<1e-9);assert.equal(ack.parts,1);
  // The killed writer left its lock. Store.write must demonstrate that the PID
  // is dead before recovering it; this test never manually deletes the lock.
  assert.equal(fs.existsSync(path.join(directory,'orangex-paper.lock')),true);
  let clock=START+120001;store=new OrangeXPaperStore({directory,now:()=>clock});
  const engine=new OrangeXPaperEngine(store.read(),{now:()=>clock,onChange:state=>store.write(state),...context});
  const restored=engine.snapshot();assert.equal(restored.open[0].recovered,true);
  assert.ok(Math.abs(restored.open[0].quantityOriginal-.2)<1e-9);
  assert.equal(restored.pending[0].quantityRemaining,ack.remaining);
  engine.onMarket(market(START+1,{bid:99.49,ask:99.5,size:.2}));
  assert.ok(Math.abs(engine.snapshot().open[0].quantityOriginal-.2)<1e-9,'a delayed old quote cannot create a second entry');
  clock++;const fresh=market(clock,{bid:99.49,ask:99.5,size:.2});engine.onMarket(fresh);
  let state=engine.exportState();assert.ok(Math.abs(state.open[0].quantityOriginal-.4)<1e-9);
  assert.equal(state.open[0].entryParts.length,2);
  engine.onMarket(fresh);engine.onMarket(market(clock-1,{bid:99.49,ask:99.5,size:.2}));
  state=engine.exportState();assert.ok(Math.abs(state.open[0].quantityOriginal-.4)<1e-9);
  assert.equal(state.open[0].entryParts.length,2,'duplicate and reordered messages cannot consume the same size twice');
  clock++;engine.setConnectionStatus({connected:false,at:clock});
  clock++;engine.onMarket(market(clock,{bid:99.49,ask:99.5,size:.2}));
  assert.ok(Math.abs(engine.exportState().open[0].quantityOriginal-.4)<1e-9,'disconnection blocks further entry fills');
  clock++;engine.onMarket(market(clock,{bid:97,ask:97.01,size:1000}));
  assert.equal(engine.snapshot().open.length,0,'an existing stop still uses a fresh executable quote while new entries are blocked');
  assert.equal(engine.snapshot().closed.length,1);assert.equal(engine.snapshot().closed[0].closeReason,'STOP');
  const closed=engine.exportState().closed[0];
  assert.ok(Math.abs(closed.exitParts.reduce((sum,part)=>sum+part.quantity,0)-.4)<1e-9);
  assert.equal(engine.register(signal('disconnected-new',clock),{dataSource:'SYNTHETIC_FIXTURE'}),false);
  clock++;engine.setConnectionStatus({connected:true,at:clock});
  assert.equal(engine.register(signal('reconnected-new',clock),{dataSource:'SYNTHETIC_FIXTURE'}),true);
  clock++;engine.onMarket(market(clock));const once=engine.exportState().open[0];
  engine.onMarket(market(clock));assert.equal(engine.exportState().open[0].quantityOriginal,once.quantityOriginal);
  assert.equal(engine.exportState().open[0].entryParts.length,1);
  assert.equal(fs.readFileSync(legacy,'utf8'),'legacy PNL and settings stay untouched');
 }finally{store?.close();remove(root)}
});

test('delayed response, old Mark, duplicate signal and reordered message cannot silently fill a new position',()=>{
 let clock=START;const engine=new OrangeXPaperEngine({}, {now:()=>clock,settings,contracts:[contract],...context});
 assert.equal(engine.register(signal(),{dataSource:'SYNTHETIC_FIXTURE'}),true);
 clock++;engine.onMarket(market(clock,{markPriceAt:clock-90001}));assert.equal(engine.snapshot().open.length,0);
 clock++;engine.onMarket(market(clock,{timestamp:clock-90001}));assert.equal(engine.snapshot().open.length,0);
 clock++;engine.onMarket(market(clock));const position=engine.exportState().open[0];assert.ok(position);
 assert.equal(engine.register(signal(),{dataSource:'SYNTHETIC_FIXTURE'}),false);
 engine.onMarket(market(clock));engine.onMarket(market(clock-1));
 assert.equal(engine.exportState().open[0].quantityOriginal,position.quantityOriginal);
 assert.equal(engine.exportState().open[0].entryParts.length,1);
 const codes=engine.snapshot().rejections.map(row=>row.reason);
 for(const code of ['MARK_STALE','BOOK_STALE','DUPLICATE_SIGNAL','BOOK_REPLAY'])assert.ok(codes.includes(code),code);
});

test('disk-full save failure leaves the acknowledged ledger unchanged and retries fill at most once',()=>{
 let clock=START,fail=false,acknowledged=null;
 const engine=new OrangeXPaperEngine({}, {now:()=>clock,settings,contracts:[contract],...context,
  onChange:state=>{if(fail){const error=Error('synthetic storage full');error.code='ENOSPC';throw error}acknowledged=structuredClone(state)}});
 engine.register(signal(),{dataSource:'SYNTHETIC_FIXTURE'});const before=structuredClone(acknowledged);clock++;
 fail=true;assert.throws(()=>engine.onMarket(market(clock)),error=>error.code==='ENOSPC');
 assert.deepEqual(engine.exportState(),before);assert.deepEqual(acknowledged,before);
 fail=false;engine.onMarket(market(clock));assert.equal(engine.snapshot().open.length,1);
 const quantity=engine.snapshot().open[0].quantityOriginal;
 engine.onMarket(market(clock));assert.equal(engine.snapshot().open[0].entryParts.length,1);
 assert.equal(engine.snapshot().open[0].quantityOriginal,quantity);
 clock++;fail=true;const opened=engine.exportState();assert.throws(()=>engine.onMarket(market(clock,{bid:97,ask:97.01})),error=>error.code==='ENOSPC');
 assert.deepEqual(engine.exportState(),opened);assert.equal(engine.snapshot().closed.length,0);
 fail=false;engine.onMarket(market(clock,{bid:97,ask:97.01}));assert.equal(engine.snapshot().closed.length,1);
 engine.onMarket(market(clock,{bid:97,ask:97.01}));assert.equal(engine.snapshot().closed.length,1);
});

test('a corrupt durable record blocks restart without deleting or replacing the original bytes',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'orangex-corrupt25-')),directory=path.join(root,'orangex-paper');
 let store;
 try{
  store=new OrangeXPaperStore({directory});const engine=new OrangeXPaperEngine({}, {now:()=>START,settings,contracts:[contract],...context});
  store.write(engine.exportState());store.close();
  const file=path.join(directory,'orangex-paper.json'),bytes=Buffer.from('{damaged but recoverable original\r\n');fs.writeFileSync(file,bytes);
  store=new OrangeXPaperStore({directory});assert.throws(()=>store.read(),{code:'ORANGEX_PAPER_INVALID_STORE'});
  assert.throws(()=>store.write(engine.exportState()),{code:'ORANGEX_PAPER_INVALID_STORE'});
  assert.ok(fs.readFileSync(file).equals(bytes));assert.equal(store.status().healthy,false);
 }finally{store?.close();remove(root)}
});
