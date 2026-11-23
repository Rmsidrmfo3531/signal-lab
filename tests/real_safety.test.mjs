import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {RealAccountGuard,REAL_SAFETY_DEFAULTS,REAL_SAFETY_COPY_PRESET,kstDay} from '../real_safety.mjs';
import {planRealManualOrder,executeRealManualOrder} from '../real_manual_trade.mjs';
import {computeOrderPreview} from '../public/real_trade.js';
import {copyHTML} from '../public/live_control.js';

const NOW=Date.parse('2026-11-22T06:00:00Z'); // 15:00 KST
const DAY=kstDay(NOW);
const ETH={symbol:'ETHUSDT',venueSymbol:'ETH-USDT',tickSize:'0.01',quantityStep:'0.01',minQuantityBase:'0.01',minNotionalUSDT:5};

test('RealAccountGuard trips combined daily loss circuit breaker, disarms copy, persists across restart, and supports explicit unlock',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sl-real-safety-'));
 try{
  let trippedCalls=0;
  const msgs=[];
  const guard=new RealAccountGuard({
   directory:dir,now:()=>NOW,
   onTrip:()=>{trippedCalls++},
   sendText:m=>{msgs.push(m)},
  });
  // Breaker off by default (user 2026-11-23 "이거는 없애줘"); this test turns it on at 8 % from the screen setting.
  assert.deepEqual([guard.status().dailyLossLimitPct,guard.status().manualMaxLeverage,guard.status().manualMaxMarginPct],[0,20,15]);
  guard.configure({dailyLossLimitPct:8});
  assert.equal(guard.isTripped(),false);

  // Realized -$100 + unrealized -$100 = -$200 (-6.67% of $3,000) -> below -8% threshold
  const r1=await guard.evaluateDailyLoss({equityUSD:3000,dailyByDay:{[DAY]:-100},positions:[{unrealized:-100}],now:NOW});
  assert.equal(r1.tripped,false);
  assert.equal(trippedCalls,0);

  // Realized -$150 + unrealized -$100 = -$250 (-8.33% of $3,000) -> trips circuit breaker!
  const r2=await guard.evaluateDailyLoss({equityUSD:3000,dailyByDay:{[DAY]:-150},positions:[{unrealized:-100}],now:NOW});
  assert.equal(r2.tripped,true);
  assert.equal(r2.newlyTripped,true);
  assert.equal(trippedCalls,1);
  assert.match(msgs[0],/실계좌 일일 손실 차단 발동/);

  // Persists across restart on same KST day
  const reloaded=new RealAccountGuard({directory:dir,now:()=>NOW+3600000});
  assert.equal(reloaded.isTripped(),true);
  assert.equal(reloaded.orderGuard({equityUSD:3000}).blocked,true);

  // Explicit unlock lifts block for today without re-tripping
  reloaded.configure({unlockToday:true});
  assert.equal(reloaded.isTripped(),false);
  const r3=await reloaded.evaluateDailyLoss({equityUSD:3000,dailyByDay:{[DAY]:-300},positions:[],now:NOW+7200000});
  assert.equal(r3.tripped,false);

  // Next KST day resets cleanly
  const nextDay=new RealAccountGuard({directory:dir,now:()=>NOW+24*3600000});
  assert.equal(nextDay.isTripped(),false);
 }finally{fs.rmSync(dir,{recursive:true,force:true})}
});

test('RealAccountGuard blocks high-leverage and oversized manual orders via executeRealManualOrder and surfaces UI warnings',async()=>{
 const guard=new RealAccountGuard({now:()=>NOW});guard.configure({dailyLossLimitPct:8});
 const og=guard.orderGuard({equityUSD:3000});
 assert.equal(og.maxLeverage,20);
 assert.equal(og.maxMarginUSD,450); // 15% of $3,000

 // Plan rejects margin > $450
 assert.throws(()=>planRealManualOrder({
  side:'LONG',orderType:'MARKET',amountMode:'MARGIN_USDT',amount:500,leverage:10,
  contract:ETH,markPrice:3000,availableUSD:2500,maxLeverage:og.maxLeverage,maxMarginUSD:og.maxMarginUSD,
 }),/안전 한도/);

 // executeRealManualOrder rejects leverage 50x (> 20x safety cap)
 const client={
  mode:'LIVE',
  positionMode:async()=>({dualSidePosition:true}),
  balance:async()=>[{asset:'USDT',equity:'3000',availableMargin:'2500'}],
  leverage:async()=>({maxLongLeverage:100,maxShortLeverage:100}),
 };
 await assert.rejects(()=>executeRealManualOrder({
  confirm:'REAL_MANUAL_ORDER',symbol:'ETH',side:'LONG',orderType:'MARKET',amountMode:'MARGIN_USDT',amount:100,leverage:50,
  client,contractsFor:async()=>new Map([['ETHUSDT',ETH]]),markOf:async()=>3000,safety:og,
 }),/1 ~ 20배/);

 // Tripped circuit breaker blocks manual opening order immediately
 await guard.evaluateDailyLoss({equityUSD:3000,dailyByDay:{[DAY]:-260},positions:[],now:NOW});
 await assert.rejects(()=>executeRealManualOrder({
  confirm:'REAL_MANUAL_ORDER',symbol:'ETH',side:'LONG',orderType:'MARKET',amountMode:'MARGIN_USDT',amount:50,leverage:10,
  client,contractsFor:async()=>new Map([['ETHUSDT',ETH]]),markOf:async()=>3000,safety:guard.orderGuard({equityUSD:3000}),
 }),/합산 손실/);

 // UI preview & copyHTML render safety warnings and preset controls
 const pLev=computeOrderPreview({
  info:{price:3000,quantityStep:'0.01',minQuantityBase:0.01,minNotionalUSDT:5},
  leverage:50,orderType:'MARKET',amountMode:'MARGIN_USDT',amount:'100',availableUSD:2500,equityUSD:3000,
  safety:{...REAL_SAFETY_DEFAULTS,tripped:false},
 });
 assert.match(pLev.warn,/수동 안전 레버리지 상한\(20배\) 초과/);
 const pMargin=computeOrderPreview({
  info:{price:3000,quantityStep:'0.01',minQuantityBase:0.01,minNotionalUSDT:5},
  leverage:10,orderType:'MARKET',amountMode:'MARGIN_USDT',amount:'600',availableUSD:2500,equityUSD:3000,
  safety:{...REAL_SAFETY_DEFAULTS,tripped:false},
 });
 assert.match(pMargin.warn,/단일 증거금 안전 한도/);

 const html=copyHTML({
  mode:'LIVE',enabled:true,armed:false,sizing:'BALANCE_RATIO',traderBalanceUSD:20000,
  funds:{equity:3000,available:2500},positions:[],closed:[],events:[],
  safety:guard.status(),
 });
 assert.match(html,/계좌 안전 가드 · 서킷 브레이커/);
 assert.match(html,/권장 안전 프리셋 일괄 적용/);
 assert.match(html,/일일 손실 차단 발동/);
 assert.match(html,/data-safety-unlock/);
 assert.equal(REAL_SAFETY_COPY_PRESET.maxLeverage,20);
 assert.equal(REAL_SAFETY_COPY_PRESET.maxSymbolMarginPct,15);
});

test('daily loss breaker is off by default and a saved 8 % from before 2026-11-23 is migrated to off once (user "이거는 없애줘")',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'rs-off-'));
 try{
  const file=path.join(dir,'real-safety.json');
  fs.writeFileSync(file,JSON.stringify({version:1,dailyLossLimitPct:8,manualMaxLeverage:20,manualMaxMarginPct:15,trippedDay:kstDay(NOW),trippedAt:NOW}));
  const g=new RealAccountGuard({directory:dir,now:()=>NOW});
  assert.equal(g.status().dailyLossLimitPct,0);
  assert.equal(g.isTripped(),false,'an old trip of today no longer blocks');
  const r=await g.evaluateDailyLoss({equityUSD:3000,dailyByDay:{[kstDay(NOW)]:-2000},positions:[],now:NOW});
  assert.equal(r.tripped,false);assert.equal(g.orderGuard({equityUSD:3000}).blocked,false);
  assert.equal(JSON.parse(fs.readFileSync(file,'utf8')).breakerOffMigrated,true);
  // Turned back on from the screen: kept after restart (migration runs once).
  g.configure({dailyLossLimitPct:8});
  assert.equal(new RealAccountGuard({directory:dir,now:()=>NOW}).status().dailyLossLimitPct,8);
 }finally{fs.rmSync(dir,{recursive:true,force:true})}
});
