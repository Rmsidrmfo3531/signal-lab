import test from 'node:test';
import assert from 'node:assert/strict';
import {describeScanFunnel} from '../scan_diagnostics.mjs';
const now=Date.now();
const base=(symbol)=>({symbol,scannedAt:now,pattern:'박스권 상단 돌파',patternConfirmed:true,patternConfirmedAt:now-10000,quality:{passed:true,failed:[]},execution:{eligible:true},status:'signal',qualified:true});
test('diagnostics do not count repeated scans as distinct markets',()=>{
 const arr=new Map([['BTCUSDT',{symbol:'BTCUSDT',scannedAt:now,status:'neutral'}]]);
 const x=describeScanFunnel(arr,{activeSymbols:['BTCUSDT'],now});assert.equal(x.uniqueAnalyzed,1);assert.equal(x.noPattern,1);
});
test('diagnostics distinguish 1h+4h technical quality from venue execution blocks',()=>{
 const a=base('AAAUSDT');a.quality={passed:false,failed:['거래량 배율 부족']};
 const b=base('BBBUSDT');b.quality={passed:false,failed:['4시간봉 추세 역행']};
 const c=base('CCCUSDT');c.execution={eligible:false,reasons:['호가 시각 오래됨']};
 const d=base('DDDUSDT');
 const e={symbol:'EEEUSDT',scannedAt:now,status:'neutral'};
 const map=new Map([a,b,c,d,e].map(x=>[x.symbol,x]));
 const x=describeScanFunnel(map,{activeSymbols:[...map.keys()],now});
 assert.equal(x.patternCount,4);assert.equal(x.quality,2);assert.equal(x.venue,1);assert.equal(x.ready,1);assert.equal(x.noPattern,1);
 assert.equal(x.topReasons.find(q=>q.reason==='호가 시각 오래됨').count,1);
});
test('venue not verified never counted as ready even if internal status says signal',()=>{
 const a=base('AAAUSDT');const r=describeScanFunnel(new Map([[a.symbol,a]]),{researchSymbols:['AAAUSDT'],now});
 assert.equal(r.ready,0);assert.equal(r.venue,1);
});
test('expired scans are excluded',()=>{
 const a=base('AAAUSDT');a.scannedAt=now-10*3600000;
 assert.equal(describeScanFunnel(new Map([[a.symbol,a]]),{activeSymbols:['AAAUSDT'],now}).uniqueAnalyzed,0);
});
test('target-plan diagnostics name the recorded cause behind TP_PROFILE_UNAVAILABLE',()=>{
 const ready=base('AAAUSDT');ready.targetPlan={ok:true};
 const coverage=base('BBBUSDT');coverage.targetPlan={ok:false,code:'TP_PROFILE_UNAVAILABLE',reasons:['VOLUME_PROFILE_NOT_AVAILABLE'],profileReasons:['PROFILE_COVERAGE_INCOMPLETE']};
 const rr=base('CCCUSDT');rr.targetPlan={ok:false,code:'TP_PROFILE_UNAVAILABLE',reasons:['TARGET_NET_RR_BELOW_MINIMUM']};
 const sizing=base('DDDUSDT');sizing.binanceExecution={eligible:false};
 const rejected=base('EEEUSDT');rejected.quality={passed:false,failed:['거래량 배율 부족']};rejected.targetPlan={ok:false,reasons:['NOT_COUNTED']};
 const map=new Map([ready,coverage,rr,sizing,rejected].map(x=>[x.symbol,x]));
 const plan=describeScanFunnel(map,{activeSymbols:[...map.keys()],now}).targetPlan;
 assert.equal(plan.technicalCandidates,4,'only technically passed setups are counted');
 assert.equal(plan.ready,1);
 assert.deepEqual(plan.blocked.map(x=>x.reason).sort(),['EXECUTION_ESTIMATE_NOT_ELIGIBLE','PROFILE_COVERAGE_INCOMPLETE','TARGET_NET_RR_BELOW_MINIMUM']);
 assert.ok(plan.blocked.every(x=>x.count===1));
});
