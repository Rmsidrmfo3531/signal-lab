import test from 'node:test';
import assert from 'node:assert/strict';
import {liveReadiness,readinessText} from '../live_readiness.mjs';

const T0=Date.parse('2026-11-13T00:00:00Z'),DAY=86400000;
const trade=(i,net,extra={})=>({signalKey:'k'+i,symbol:'X'+i+'USDT',mode:'TESTNET',status:'CLOSED',createdAt:T0+i*DAY/2,closedAt:T0+i*DAY/2+3600000,
 realized:{source:'EXCHANGE',netUSD:net},events:[{type:'PROTECTED',at:T0}],...extra});

test('not ready until 30 settled trades over 14 days, net above zero, drawdown within 30% and no order problems',()=>{
 const few=liveReadiness([trade(0,5),trade(1,-2)],{since:T0,now:T0+3*DAY});
 assert.equal(few.ready,false);assert.equal(few.settled,2);assert.equal(few.netUSD,3);assert.equal(few.winRatePct,50);
 assert.deepEqual(few.checks.filter(c=>!c.ok).map(c=>c.key),['trades','days']);
 const many=Array.from({length:32},(_,i)=>trade(i,i%3===0?-3:4));
 const ok=liveReadiness(many,{since:T0,now:T0+20*DAY});
 assert.equal(ok.ready,true,JSON.stringify(ok.checks));assert.match(readinessText(ok),/기준을 모두 충족/);
});

test('drawdown, losses, order problems, test orders and old-rule trades',()=>{
 const base=Array.from({length:32},(_,i)=>trade(i,2));
 const dd=liveReadiness([...base,trade(40,-150)],{since:T0,now:T0+30*DAY,balanceUSD:400});
 assert.equal(dd.checks.find(c=>c.key==='drawdown').ok,false,'a 150 drop on a 400 balance is 37.5%');
 const sized=liveReadiness([...base,trade(40,-150)].map(r=>({...r,balanceUSD:1000})),{since:T0,now:T0+30*DAY});
 assert.equal(sized.balanceUSD,1000);assert.equal(sized.checks.find(c=>c.key==='drawdown').ok,true,'150 of a 1000 sizing balance is 15%');
 const bad=liveReadiness([...base,trade(41,1,{events:[{type:'CANCEL_FAILED',at:T0}]})],{since:T0,now:T0+30*DAY});
 assert.equal(bad.checks.find(c=>c.key==='errors').ok,false);assert.equal(bad.ready,false);
 const unknown=liveReadiness([...base,{...trade(42,0),status:'UNKNOWN',realized:null}],{since:T0,now:T0+30*DAY});
 assert.equal(unknown.serious.length,1);
 const ignored=liveReadiness([trade(0,5,{test:true}),trade(1,5,{createdAt:T0-DAY}),trade(2,5,{mode:'LIVE'})],{since:T0,now:T0+DAY});
 assert.equal(ignored.settled,0,'test orders, trades before the current rules and other modes do not count');
 const transient=liveReadiness([...base,trade(43,1,{events:[{type:'RECONCILE_ERROR',at:T0}]})],{since:T0,now:T0+30*DAY});
 assert.equal(transient.reconcileErrors,1);assert.equal(transient.checks.find(c=>c.key==='errors').ok,true,'a passing venue check error is reported, not blocking');
});

test('average holding time for closed and open trades; open positions with their unrealized result',()=>{
 const H=3600000;
 const rs=[trade(0,2,{createdAt:T0,closedAt:T0+4*H}),trade(1,-1,{createdAt:T0,closedAt:T0+8*H}),
  {signalKey:'o1',symbol:'OUSDT',direction:'SHORT',mode:'TESTNET',status:'OPEN',createdAt:T0,position:{unrealizedPnLUSD:-1.5}}];
 const r=liveReadiness(rs,{since:T0,now:T0+10*H});
 assert.equal(r.avgHoldHours,6);assert.equal(r.openAvgHoldHours,10);
 assert.deepEqual(r.openPositions,[{symbol:'OUSDT',direction:'SHORT',createdAt:T0,unrealizedUSD:-1.5}]);
 assert.match(readinessText(r),/미실현 −\$1\.50/);assert.match(readinessText(r),/평균 보유 6\.0시간/);
});

test('readiness counts only the running strategy profile (its own ledger); untagged records are CURRENT',async()=>{
 const {liveReadiness}=await import('../live_readiness.mjs');
 const now=Date.UTC(2026,10,20),rec=(p,i)=>({mode:'TESTNET',status:'CLOSED',createdAt:now-86400000*(i+1),closedAt:now-86400000*i,realizedPnLUSD:1,balanceUSD:400,...(p?{strategyProfile:p}:{})});
 const records=[rec(null,1),rec('CURRENT',2),rec('HYBRID',3),rec('HYBRID',4)];
 assert.equal(liveReadiness(records,{now,strategyProfile:'HYBRID',since:0}).closedTrades??liveReadiness(records,{now,strategyProfile:'HYBRID',since:0}).trades,2);
 assert.equal(liveReadiness(records,{now,strategyProfile:'CURRENT',since:0}).closedTrades??liveReadiness(records,{now,strategyProfile:'CURRENT',since:0}).trades,2);
});
