import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {CopyControls,normalizeControlSymbol} from '../copy_controls.mjs';
import {CopyExecutor,copyConfig} from '../copy_executor.mjs';
import {copyEventText} from '../copy_telegram.mjs';
import {copyHTML} from '../public/live_control.js';

const tmp=()=>fs.mkdtempSync(path.join(os.tmpdir(),'signal-lab-copy-ctrl-'));
const contract={symbol:'TNSRUSDT',venueSymbol:'TNSR-USDT',tradable:true,tickSize:'0.0001',quantityStep:'1',minQuantityBase:'1',minNotionalUSDT:'2'};

function venue({price=0.05,maxLeverage=125}={}){
 let size=0,avg=price,unrealized=0;
 const calls=[];
 const client={
  setMarginType:async()=>({}),
  setLeverage:async(_s,_side,lev)=>{calls.push({op:'leverage',lev});return {leverage:lev}},
  leverage:async()=>({maxLongLeverage:maxLeverage,maxShortLeverage:maxLeverage}),
  positionMode:async()=>({dualSidePosition:false}),
  positions:async()=>size>0?[{symbol:'TNSR-USDT',positionSide:'BOTH',positionAmt:String(-size),avgPrice:String(avg),markPrice:String(price),unrealizedProfit:String(unrealized)}]:[],
  placeOrder:async p=>{
   calls.push({op:'order',...p});
   const q=Number(p.quantity);
   if(p.type==='MARKET'){
    if(p.reduceOnly==='true')size=Math.max(0,size-q);
    else size+=q;
   }
   return {order:{orderId:String(calls.length),status:'FILLED',executedQty:String(q),avgPrice:String(price)}};
  },
  openOrders:async()=>[],
  cancelOrder:async()=>({}),
 };
 return {client,calls,get size(){return size},setUnrealized(v){unrealized=v}};
}

const OPEN=(qty=10000,lev=50,sym='TNSRUSDT')=>`📌 포지션 진입\n${sym} 🔴 Short ×${lev}\n진입가 0.05000 USDT\n현재가 0.05000 USDT\n수량 ${qty}`;
const CHANGE=(a,b,sym='TNSRUSDT')=>`📊 포지션 변경\n🪙 ${sym}  🔴 Short\n수량 ${a} → ${b}\n현재가 0.05 USDT`;
const CLOSE=(sym='TNSRUSDT')=>`✅ 포지션 청산\n🪙 ${sym}  🔴 Short\n진입가 0.05000 USDT\n최종손익 🔴 -5.00 USDT`;

test('CopyControls normalizes symbols, validates bounds, and persists across restarts',()=>{
 const dir=tmp();
 try{
  assert.equal(normalizeControlSymbol('sndk'),'SNDKUSDT');
  assert.equal(normalizeControlSymbol('BTC-USDT'),'BTCUSDT');
  assert.equal(normalizeControlSymbol('bad symbol!'),null);

  const c=new CopyControls({directory:dir});
  c.configure({
   traderBalanceUSD:40000,
   maxSymbolMarginPct:20,
   maxLeverage:25,
   filterMode:'BLOCKLIST',
   addBlocked:'sndk',
   cooldownLosses:3,
   cooldownDailyLossPct:8,
   cooldownMinutes:90,
  });
  assert.throws(()=>c.configure({traderBalanceUSD:500}),/기준 잔고/);
  assert.throws(()=>c.configure({maxSymbolMarginPct:150}),/증거금/);
  assert.throws(()=>c.configure({maxLeverage:200}),/레버리지/);
  assert.throws(()=>c.configure({cooldownMinutes:2}),/쿨다운/);

  const reloaded=new CopyControls({directory:dir});
  assert.equal(reloaded.effectiveTraderBalanceUSD(20000),40000);
  assert.equal(reloaded.effectiveMaxLeverage(125),25);
  assert.deepEqual(reloaded.status().blockedSymbols,['SNDKUSDT']);
  assert.equal(reloaded.status().maxSymbolMarginPct,20);
  assert.equal(reloaded.status().cooldownLosses,3);
  assert.equal(reloaded.status().cooldownDailyLossPct,8);
  assert.equal(reloaded.status().cooldownMinutes,90);
 }finally{fs.rmSync(dir,{recursive:true,force:true})}
});

test('runtime sizing baseline (#9), leverage cap (#1), and per-symbol margin cap (#1) enforce on entry and adds',async()=>{
 const dir=tmp();
 try{
  const controls=new CopyControls({directory:dir});
  controls.configure({traderBalanceUSD:40000,maxLeverage:20,maxSymbolMarginPct:5});
  const v=venue({price:0.05});
  // Equity 2000 / traderBalance 40000 = 0.05 scale.
  // Trader enters 20,000 coins -> our qty = 1,000 coins, notional $50, capped lev 20x -> margin $2.50 (<= 5% of $2000 = $100).
  const ex=new CopyExecutor({
   config:copyConfig({},'TESTNET'),controls,client:v.client,
   contractOf:async()=>contract,markOf:async()=>0.05,
   balance:async()=>({equity:2000,available:1800}),now:()=>1e12
  });
  const r1=await ex.handle({id:1,date:1e12,text:OPEN(20000,80)});
  assert.equal(r1.ok,true);
  assert.equal(v.size,1000,'scale 2000/40000 = 0.05 applied');
  assert.equal(v.calls.find(c=>c.op==='leverage').lev,20,'80x capped to 20x');
  assert.equal(ex.status().traderBalanceUSD,40000);

  // Huge add: trader adds 1,000,000 coins -> our add = 50,000 coins, notional $2,500, margin $125 > $100 symbol cap -> SYMBOL_MARGIN_CAP!
  const r2=await ex.handle({id:2,date:1e12+60000,text:CHANGE(20000,1020000)});
  assert.equal(r2.ok,false);
  assert.equal(r2.reason,'SYMBOL_MARGIN_CAP');
  assert.equal(v.size,1000);
 }finally{fs.rmSync(dir,{recursive:true,force:true})}
});

test('symbol blocklist and allowlist (#3) block entries and adds while still allowing closes',async()=>{
 const controls=new CopyControls();
 controls.configure({filterMode:'BLOCKLIST',addBlocked:'TNSR'});
 const v=venue();
 const ex=new CopyExecutor({
  config:copyConfig({},'TESTNET'),controls,client:v.client,
  contractOf:async()=>contract,markOf:async()=>0.05,
  balance:async()=>({equity:2000,available:1800}),now:()=>1e12
 });
 const blocked=await ex.handle({id:1,date:1e12,text:OPEN(10000,10)});
 assert.equal(blocked.ok,false);assert.equal(blocked.reason,'SYMBOL_BLOCKED');assert.equal(v.size,0);

 // Unblock, enter, then re-block: adds should skip, close MUST still execute!
 controls.configure({removeBlocked:'TNSRUSDT'});
 assert.equal((await ex.handle({id:2,date:1e12+1000,text:OPEN(10000,10)})).ok,true);
 assert.equal(v.size,1000);

 controls.configure({filterMode:'ALLOWLIST',allowedSymbols:['BTCUSDT']});
 const addSkip=await ex.handle({id:3,date:1e12+2000,text:CHANGE(10000,20000)});
 assert.equal(addSkip.ok,false);assert.equal(addSkip.reason,'SYMBOL_NOT_ALLOWED');
 const closed=await ex.handle({id:4,date:1e12+3000,text:CLOSE()});
 assert.equal(closed.ok,true);assert.equal(v.size,0);
});

test('loss auto-cooldown (#11) pauses new entries after consecutive losses and resumes on expiry or manual clear',async()=>{
 let now=1795000000000;
 const controls=new CopyControls({now:()=>now});
 controls.configure({cooldownLosses:2,cooldownMinutes:60});
 const v=venue();
 const ex=new CopyExecutor({
  config:copyConfig({},'TESTNET'),controls,client:v.client,
  contractOf:async()=>contract,markOf:async()=>0.05,
  balance:async()=>({equity:2000,available:1800}),now:()=>now
 });

 // Loss #1
 assert.equal((await ex.handle({id:1,date:now,text:OPEN(10000,10)})).ok,true);
 v.setUnrealized(-15);now+=10000;
 assert.equal((await ex.handle({id:2,date:now,text:CLOSE()})).ok,true);
 assert.equal(controls.status(now).cooldownActive,false);

 // Loss #2 -> triggers 60m cooldown
 now+=10000;assert.equal((await ex.handle({id:3,date:now,text:OPEN(10000,10)})).ok,true);
 v.setUnrealized(-20);now+=10000;
 assert.equal((await ex.handle({id:4,date:now,text:CLOSE()})).ok,true);
 assert.equal(controls.status(now).cooldownActive,true);
 assert.ok(ex.status().events.some(e=>e.type==='COPY_COOLDOWN_TRIGGERED'));
 assert.match(copyEventText(ex.status().events.find(e=>e.type==='COPY_COOLDOWN_TRIGGERED')),/자동 쿨다운/);

 // New entry during cooldown is blocked
 now+=60000;
 const during=await ex.handle({id:5,date:now,text:OPEN(10000,10)});
 assert.equal(during.ok,false);assert.equal(during.reason,'COPY_COOLDOWN');

 // Manual clear allows entry immediately and does not re-trigger on past losses
 controls.configure({clearCooldown:true});
 assert.equal(controls.status(now).cooldownActive,false);
 now+=10000;
 assert.equal((await ex.handle({id:6,date:now,text:OPEN(10000,10)})).ok,true);
});

test('copyHTML renders runtime controls, live ratio, sizing mode selector, and active cooldown banner cleanly on LIVE',()=>{
 const html=copyHTML({
  mode:'LIVE',enabled:true,armed:true,sizing:'BALANCE_RATIO',traderBalanceUSD:40000,
  funds:{equity:10000,available:9500,at:Date.now()},
  maxAdds:100,maxTotalMarginPct:100,ledgerLossPct:50,positions:[],closed:[],events:[],
  controls:{sizing:'BALANCE_RATIO',traderBalanceUSD:40000,maxSymbolMarginPct:20,maxLeverage:25,filterMode:'BLOCKLIST',blockedSymbols:['SNDKUSDT'],allowedSymbols:[],cooldownLosses:3,cooldownDailyLossPct:5,cooldownMinutes:120,cooldownActive:true,cooldownLeftMin:45,cooldownReason:'연속 3회 손실'}
 });
 assert.match(html,/카피 비중 · 위험 제어/);
 assert.match(html,/카피 비율<b >23\.8%<\/b>/);
 assert.match(html,/data-copy-sizing="BALANCE_RATIO"/);
 assert.match(html,/자동 쿨다운 중/);
 assert.match(html,/SNDKUSDT/);
 assert.match(html,/data-copy-tb="40000"/);
 assert.match(html,/data-copy-clear-cooldown/);
});

test('CopyExecutor automatically scales new entries and adds when live equity increases after a deposit, and honors runtime sizing override',async()=>{
 const dir=tmp();
 let equity=3000,now=1795000000000;
 const controls=new CopyControls({directory:dir,now:()=>now});
 // Even if .env had legacy MIN_ORDER, runtime control switches to BALANCE_RATIO cleanly
 controls.configure({sizing:'BALANCE_RATIO',traderBalanceUSD:20000});
 assert.equal(controls.effectiveSizing('MIN_ORDER'),'BALANCE_RATIO');
 const v=venue();
 const ex=new CopyExecutor({
  config:copyConfig({COPY_SIZING:'MIN_ORDER',COPY_TRADER_BALANCE_USD:'20000',COPY_STOPS:'off'},'TESTNET'),
  client:v.client,controls,contractOf:async()=>contract,
  balance:async()=>({equity,available:equity*0.9}),now:()=>now,
 });
 // Entry #1 at $3,000 equity -> scale = 3000/20000 = 0.15 -> 10000 * 0.15 = 1500
 assert.equal((await ex.handle({id:1,date:now,text:OPEN(10000,10)})).ok,true);
 assert.equal(v.size,1500);
 assert.equal(ex.status().funds.equity,3000);
 assert.equal(ex.status().effectiveRatio,0.15);

 // Deposit arrives: equity jumps to $10,000 -> add of 10000 automatically scales at 10000/20000 = 0.50 (+5000)
 equity=10000;
 now+=60000;
 assert.equal((await ex.handle({id:2,date:now,text:CHANGE(10000,20000)})).ok,true);
 assert.equal(v.size,6500,'1500 initial + 5000 deposit-scaled add');
 assert.equal(ex.status().funds.equity,10000);
 assert.equal(ex.status().effectiveRatio,0.5);
});

