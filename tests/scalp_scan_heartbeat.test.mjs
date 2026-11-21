import test from 'node:test';
import assert from 'node:assert/strict';
import {ScalpExecutor,scalpExecConfig} from '../scalp_executor.mjs';
import {buildReport} from '../reports_push.mjs';
import {scalpScanStatusHTML,scalpDetailsHTML} from '../public/live_control.js';

const T0=Date.parse('2026-11-20T06:30:05Z'); // 15:30:05 KST

function flatCandles(endAt,count=61){
 const I5=300000,lastOpen=Math.floor(endAt/I5)*I5-I5;
 return Array.from({length:count},(_,i)=>{
  const openAt=lastOpen-(count-1-i)*I5;
  return [openAt,100,100.2,99.8,100.1,1000,openAt+I5-1];
 });
}

test('ScalpExecutor.runtimeSummary exports whitelisted 5m scan heartbeat, failures, and skipCounts cleanly for reports',async()=>{
 const client={mode:'TESTNET',positions:async()=>[],balance:async()=>({balance:{equity:'2899',availableMargin:'2899'}})};
 const contractsMap=new Map([
  ['BTCUSDT',{symbol:'BTCUSDT',venueSymbol:'BTC-USDT',tradable:true,tickSize:'0.1',quantityStep:'0.001',minNotionalUSDT:2}],
  ['ETHUSDT',{symbol:'ETHUSDT',venueSymbol:'ETH-USDT',tradable:true,tickSize:'0.01',quantityStep:'0.01',minNotionalUSDT:2}],
 ]);
 let now=T0;
 const ex=new ScalpExecutor({
  config:scalpExecConfig({}),
  client,
  contracts:async()=>contractsMap,
  tickers:async()=>[{symbol:'BTC-USDT',quoteVolume:'50000000',lastPrice:'90000'},{symbol:'ETH-USDT',quoteVolume:'30000000',lastPrice:'3000'}],
  candles:async(sym)=>{
   if(sym==='ETHUSDT')throw Object.assign(Error('timeout 1234567890123'),{code:'NETWORK_UNREACHABLE'});
   return flatCandles(now);
  },
  now:()=>now,
 });
 // Before arming & scanning
 const before=ex.runtimeSummary();
 assert.equal(before.mode,'TESTNET');
 assert.equal(before.armed,false);
 assert.equal(before.blocked,'NOT_ARMED');
 assert.equal(before.scanning,false);
 assert.equal(before.lastScan,null);
 assert.equal(before.universeCount,0);

 // Arm and run a 5m scan where 1 coin succeeds and 1 fails
 ex.arm();
 await ex.scan(now);
 const after=ex.runtimeSummary();
 assert.equal(after.armed,true);
 assert.equal(after.blocked,null);
 assert.equal(after.scanning,false);
 assert.equal(after.universeCount,2);
 assert.equal(after.lastScan.at,now);
 assert.equal(after.lastScan.checked,1);
 assert.equal(after.lastScan.failed,1);
 assert.equal(after.lastScan.lastFailure,'NETWORK_UNREACHABLE');
 assert.equal(after.lastScan.signals,0);
 assert.equal(after.lastScan.entered,0);
 assert.equal(after.lastScan.error,null);

 // Verify buildReport + assertNoSecrets accepts scalp.runtime without issue
 const report=buildReport({readiness:null,insights:[],scalp:{all:{trades:0},runtime:after}});
 assert.equal(report.scalp.runtime.lastScan.checked,1);
 assert.equal(report.scalp.runtime.universeCount,2);
});

test('scalpScanStatusHTML renders healthy, scanning, stale, blocked, error, and disarmed states with XSS escaping',()=>{
 const base={mode:'TESTNET',credentials:true,armed:true,scanning:false,blocked:null,universe:{count:80}};
 assert.equal(scalpScanStatusHTML(null),'');
 assert.equal(scalpScanStatusHTML({...base,mode:'OFF'}),'');
 assert.equal(scalpScanStatusHTML({...base,credentials:false}),'');

 // Disarmed
 const off=scalpScanStatusHTML({...base,armed:false},{now:T0});
 assert.match(off,/단타 5분 스캔 꺼짐/);

 // Waiting for first scan
 const wait=scalpScanStatusHTML({...base,lastScan:null},{now:T0});
 assert.match(wait,/5분봉 스캔 대기 중/);

 // Actively scanning
 const scanning=scalpScanStatusHTML({...base,scanning:true},{now:T0});
 assert.match(scanning,/5분봉 스캔 진행 중/);
 assert.match(scanning,/대상 80종목/);

 // Healthy recent scan (2 min ago)
 const healthy=scalpScanStatusHTML({...base,lastScan:{at:T0-120000,checked:80,failed:0,signals:1,zoneSignals:2,entered:0,error:null}},{now:T0});
 assert.match(healthy,/● 5분봉 정상 감시 중/);
 assert.match(healthy,/2분 전/);
 assert.match(healthy,/80\/80종목/);
 assert.match(healthy,/감지 3건 · 진입 0건/);

 // Stale scan (12 min ago)
 const stale=scalpScanStatusHTML({...base,lastScan:{at:T0-12*60000,checked:80,failed:0,signals:0,zoneSignals:0,entered:0,error:null}},{now:T0});
 assert.match(stale,/⚠ 단타 스캔 지연 \(12분 전\)/);

 // Scan error + XSS escaping
 const errored=scalpScanStatusHTML({...base,lastScan:{at:T0-60000,checked:0,failed:80,lastFailure:'<img src=x>',error:'HTTP_429'}},{now:T0});
 assert.match(errored,/⚠ 단타 스캔 오류/);
 assert.match(errored,/조회 실패 80건/);
 assert.match(errored,/오류: HTTP_429/);
 assert.doesNotMatch(errored,/<img/);

 // Temporary pause (e.g. UNRESOLVED_ORDER_STATE) once recovered shows healthy badge + Korean pause explanation
 const paused=scalpScanStatusHTML({...base,blocked:null,lastScan:{at:T0-60000,checked:0,failed:0,signals:0,entered:0,error:'UNRESOLVED_ORDER_STATE'}},{now:T0});
 assert.match(paused,/● 5분봉 정상 감시 중/);
 assert.match(paused,/직전 보류: 미확인 주문 확인 중/);
 assert.doesNotMatch(paused,/⚠ 단타 스캔 오류/);

 // Blocked
 const blocked=scalpScanStatusHTML({...base,blocked:'DAILY_LOSS_LIMIT',blockedKo:'하루 손실 한도 도달',lastScan:{at:T0-60000,checked:80}},{now:T0});
 assert.match(blocked,/■ 단타 진입 중지 \(하루 손실 한도 도달\)/);

 // scalpDetailsHTML also surfaces lastScan errors/failures
 const det=scalpDetailsHTML({...base,settings:{...scalpExecConfig({}).settings,sides:['LONG','SHORT']},stats:{},lastScan:{at:T0-60000,checked:75,failed:5,error:'HTTP_429'}});
 assert.match(det,/75종목, 실패 5, 오류 HTTP_429/);
});
