import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {RealTrailingManager,REAL_TRAILING_DEFAULTS} from '../real_trailing.mjs';
import {copyHTML,venuePositionsHTML} from '../public/live_control.js';

const pos=(overrides={})=>({
 symbol:'ETHUSDT',venueSymbol:'ETH-USDT',direction:'LONG',origin:'manual',
 size:1,avg:3000,mark:3060,leverage:10,margin:300,unrealized:30,roePct:10,
 ...overrides,
});

test('RealTrailingManager defaults to OFF and dispatches no actions until explicitly enabled',async()=>{
 const calls=[],msgs=[];
 const rt=new RealTrailingManager({
  executeAction:async a=>{calls.push(a);return {ok:true}},
  sendText:async m=>{msgs.push(m)},
 });
 assert.equal(rt.status().enabled,false);
 assert.equal(REAL_TRAILING_DEFAULTS.enabled,false);
 assert.equal(REAL_TRAILING_DEFAULTS.partialLockRoePct,15);
 assert.equal(REAL_TRAILING_DEFAULTS.partialClosePct,50);
 assert.equal(REAL_TRAILING_DEFAULTS.trailActivateRoePct,15);
 assert.equal(REAL_TRAILING_DEFAULTS.trailPullbackRatio,30);
 assert.equal(REAL_TRAILING_DEFAULTS.minLockRoePct,5);
 assert.equal(rt.status().applyToManual,true);
 assert.equal(rt.status().applyToCopy,false);
 const res=await rt.evaluate([pos({roePct:25})]);
 assert.deepEqual(res,[]);
 assert.equal(calls.length,0);
 assert.equal(msgs.length,0);
});

test('RealTrailingManager executes 50% partial lock-in + auto breakeven + peak pullback trailing exit with Telegram notices',async()=>{
 let t=1_700_000_000_000;
 const calls=[],msgs=[];
 const rt=new RealTrailingManager({
  now:()=>t,
  executeAction:async a=>{
   calls.push(a);
   if(a.action==='BREAKEVEN_STOP')return {ok:true,stopPrice:3000};
   return {ok:true};
  },
  sendText:async m=>{msgs.push(m)},
 });
 rt.configure({enabled:true,applyToManual:true,applyToCopy:false,partialLockRoePct:8,trailActivateRoePct:8,trailPullbackRatio:25,minLockRoePct:2,autoBreakeven:true});

 // Copy position is ignored when applyToCopy=false
 assert.deepEqual(await rt.evaluate([pos({origin:'copy',roePct:20})],t),[]);
 assert.equal(calls.length,0);

 // Step 1: Manual position hits +10% ROE -> 50% partial close + auto breakeven stop
 const a1=await rt.evaluate([pos({roePct:10,unrealized:30})],t);
 assert.equal(a1.length,1);
 assert.equal(a1[0].action,'CLOSE_HALF');
 assert.equal(a1[0].breakeven,true);
 assert.deepEqual(calls.map(c=>c.action),['CLOSE_HALF','BREAKEVEN_STOP']);
 assert.match(msgs[0],/50% 부분 익절 확정/);
 assert.match(msgs[0],/본전 스탑 자동 설정/);

 // Step 2: Peak climbs to +20% Net ROE (gross +21% - 1% fee at 10x)
 t+=20_000;
 assert.deepEqual(await rt.evaluate([pos({size:0.5,roePct:21,unrealized:30})],t),[]);
 assert.equal(rt.status().tracked['ETHUSDT|LONG'].peakRoePct,20);
 assert.equal(rt.status().tracked['ETHUSDT|LONG'].partialTaken,true);

 // Pullback of 25% from +20% -> trail stop = +15% Net ROE. At +17% gross (+16% net) still holds.
 t+=20_000;
 assert.deepEqual(await rt.evaluate([pos({size:0.5,roePct:17,unrealized:24})],t),[]);

 // Drops to +15.5% gross (+14.5% net <= 15%) -> trailing exit CLOSE_ALL
 t+=20_000;
 const a2=await rt.evaluate([pos({size:0.5,roePct:15.5,unrealized:21.75})],t);
 assert.equal(a2.length,1);
 assert.equal(a2[0].action,'CLOSE_ALL');
 assert.equal(a2[0].peakRoePct,20);
 assert.equal(calls.at(-1).action,'CLOSE_ALL');
 assert.match(msgs[1],/고점 순 ROE \+20\.0% → 청산 순 ROE \+14\.5%/);
 assert.equal(rt.status().tracked['ETHUSDT|LONG'],undefined,'tracking cleared after full exit');
});

test('RealTrailingManager skips TradFi thin-liquidity symbols by default and prevents fee-losing exits on high leverage',async()=>{
 let t=1_700_000_000_000;
 const calls=[];
 const rt=new RealTrailingManager({
  now:()=>t,
  executeAction:async a=>{calls.push(a);return {ok:true}},
 });
 rt.configure({enabled:true,partialLockRoePct:8,trailActivateRoePct:8,skipTradfi:true});

 // TradFi symbol (NCSKSNDK2USD-USDT / GOLDUSDT) skipped by default
 assert.deepEqual(await rt.evaluate([
  pos({symbol:'NCSKSNDK2USDUSDT',venueSymbol:'NCSKSNDK2USD-USDT',roePct:25,leverage:10}),
  pos({symbol:'GOLDUSDT',venueSymbol:'NCCOGOLD2USD-USDT',roePct:25,leverage:10}),
 ],t),[]);
 assert.equal(calls.length,0);

 // 50x leverage has 5.0% round-trip fee ROE -> gross +10% is only +5% Net ROE (< +8% trigger), so no premature close!
 assert.deepEqual(await rt.evaluate([pos({symbol:'BTCUSDT',venueSymbol:'BTC-USDT',leverage:50,roePct:10})],t),[]);
 assert.equal(calls.length,0);

 // Once gross hits +14% (net +9% >= +8%), partial lock-in triggers cleanly
 const a=await rt.evaluate([pos({symbol:'BTCUSDT',venueSymbol:'BTC-USDT',leverage:50,roePct:14})],t);
 assert.equal(a.length,1);
 assert.equal(a[0].action,'CLOSE_HALF');
 assert.equal(a[0].feeRoePct,5);
 assert.equal(a[0].roePct,9);
});

test('RealTrailingManager handles HALF_QTY_TOO_SMALL fallback, excludedSymbols, and persistence across restart',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sl-real-trail-'));
 let t=1_700_000_000_000;
 try{
  const calls=[];
  const rt=new RealTrailingManager({
   directory:dir,
   now:()=>t,
   executeAction:async a=>{
    calls.push(a);
    if(a.action==='CLOSE_HALF')return {ok:false,error:'HALF_QTY_TOO_SMALL'};
    return {ok:true};
   },
  });
  rt.configure({enabled:true,excludedSymbols:'BTC, eth'});
  assert.deepEqual(rt.status().excludedSymbols,['BTCUSDT','ETHUSDT']);

  // Excluded symbol skipped
  assert.deepEqual(await rt.evaluate([pos({symbol:'ETHUSDT',roePct:15})],t),[]);
  assert.equal(calls.length,0);

  // Toggle exclude removes ETHUSDT
  rt.configure({toggleExcludeSymbol:'ETHUSDT'});
  assert.deepEqual(rt.status().excludedSymbols,['BTCUSDT']);

  // HALF_QTY_TOO_SMALL marks partialTaken=true and falls back to full trailing (10x -> -1% fee, default +15% trigger / 30% pullback)
  await rt.evaluate([pos({symbol:'ETHUSDT',roePct:17})],t); // net 16% >= 15%
  assert.equal(rt.status().tracked['ETHUSDT|LONG'].partialTaken,true);
  t+=20_000;
  await rt.evaluate([pos({symbol:'ETHUSDT',roePct:21})],t); // peak net ROE = 20% -> 30% pullback stop = 14%
  t+=20_000;
  const res=await rt.evaluate([pos({symbol:'ETHUSDT',roePct:14.5})],t); // net 13.5% <= 14% stop
  assert.equal(res.length,1);
  assert.equal(res[0].action,'CLOSE_ALL');

  // Persistence across restart
  const restarted=new RealTrailingManager({directory:dir});
  assert.equal(restarted.status().enabled,true);
  assert.deepEqual(restarted.status().excludedSymbols,['BTCUSDT']);
 }finally{
  fs.rmSync(dir,{recursive:true,force:true});
 }
});

test('Real-account UI renders trailing panel, live peak badges, and per-symbol exclude toggle',()=>{
 const trailing={
  ...REAL_TRAILING_DEFAULTS,
  enabled:true,
  applyToManual:true,
  applyToCopy:false,
  excludedSymbols:['BTCUSDT'],
  tracked:{'ETHUSDT|LONG':{peakRoePct:14.2,partialTaken:true,breakevenPlaced:true}},
 };
 const liveCopy={
  mode:'LIVE',enabled:true,armed:true,sizing:'BALANCE_RATIO',traderBalanceUSD:20000,
  funds:{equity:3000,available:2500},
  venuePositions:[
   pos({symbol:'ETHUSDT',direction:'LONG',origin:'manual',roePct:12.5}),
   pos({symbol:'BTCUSDT',direction:'SHORT',origin:'manual',roePct:9.0}),
  ],
  positions:[],closed:[],events:[],trailing,
 };
 const h=copyHTML(liveCopy);
 assert.match(h,/자동 트레일링 익절 \(실계좌\)/);
 assert.match(h,/data-real-trailing-form/);
 assert.match(h,/TradFi·주식 종목 자동 제외/);
 assert.match(h,/50%확정·고점 \+14\.2%/);
 assert.match(h,/트레일 제외/);
 assert.match(h,/data-trail-toggle="ETHUSDT"/);
 assert.match(h,/data-trail-toggle="BTCUSDT"/);
 const vp=venuePositionsHTML(liveCopy,[]);
 assert.match(vp,/트레일 포함/);
});
