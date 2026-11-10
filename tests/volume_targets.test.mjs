import test from 'node:test';
import assert from 'node:assert/strict';
import {buildVolumeProfile,isVolumeStepAligned} from '../volume_profile.mjs';
import {planVolumeTargets} from '../volume_targets.mjs';
const END=Date.parse('2026-11-04T00:00:00Z'),START=END-60000,NOW=END+1000;
function profile(){
 const prices=[109,110,110.1,119,120,120.1,129,130,130.1,131];
 return buildVolumeProfile({symbol:'SOLUSDT',dataSource:'SYNTHETIC_TEST',windowStart:START,windowEnd:END,receivedAt:END+500,tickSize:.1,bucketTicks:1,
  coverage:{complete:true,fromTime:START,toTime:END,truncated:false,pages:1},trades:Array.from({length:40},(_,i)=>({a:i,p:String(prices[i%10]),
   q:String(prices[i%10]===110?20:prices[i%10]===120?30:prices[i%10]===130?15:1),T:START+Math.floor(i*60000/39)}))},{now:NOW});
}
function plan(direction='LONG'){
 return {profileResult:profile(),direction,entry:direction==='LONG'?100:140,stop:direction==='LONG'?99:141,
  quantity:100,tickSize:.1,quantityStep:1,minQuantity:1,minNotional:10,contractSizeBase:1,quantityUnit:'BASE_ASSET',notionalCurrency:'USDT',unitsVerified:true,
  costs:{makerRate:.0002,takerRate:.0006,spreadBps:1,slippageBps:1,fundingRate:.0003,assumption:'SYNTHETIC_TEST'},minNetRR:1.8};
}
const run=x=>planVolumeTargets(x,{now:NOW});

test('LONG picks three volume zones above entry and front-runs each zone with exact 40/35/25 quantities',()=>{
 const result=run(plan());assert.equal(result.ok,true);assert.deepEqual(result.targets,[109.9,119.9,129.9]);
 assert.deepEqual(result.parts.map(part=>part.quantity),[40,35,25]);assert.deepEqual(result.parts.map(part=>part.fraction),[.4,.35,.25]);
 assert.equal(result.quantity,100);assert.equal(result.totalQuantity,100);assert.equal(result.notionalCurrency,'USDT');
 assert.ok(result.parts.every(part=>part.estimatedNetPnL>0&&part.price<part.zone.priceLow&&isVolumeStepAligned(part.price,.1)));
 assert.ok(result.estimatedNetRR>=1.8);assert.ok(result.weightedNetRR>result.estimatedNetRR);
 assert.equal(result.profileEvidence.poc.price,120);assert.equal(result.profileEvidence.dataSource,'SYNTHETIC_TEST');
 assert.equal(result.costAssumptions.takerRate,.0006);assert.equal(result.costAssumptions.accountRateVerified,false);
 assert.equal(result.executionApproved,false);assert.equal(result.calculationOnly,true);assert.equal(result.fixedRRReplacementEnabled,false);
});

test('SHORT picks descending zones below entry and positive-price targets just before each zone',()=>{
 const result=run(plan('SHORT'));assert.equal(result.ok,true);assert.deepEqual(result.targets,[130.1,120.1,110.1]);
 assert.ok(result.parts.every(part=>part.price>part.zone.priceHigh&&part.estimatedNetPnL>0));
 assert.ok(result.targets.every((price,i)=>price<140&&(i===0||price<result.targets[i-1])));
});

test('insufficient levels, expired profile and duplicated or inverted zones hold entry without fixed-R replacement',()=>{
 for(const mutate of [x=>{x.profileResult.profile.hvn=x.profileResult.profile.hvn.slice(0,2)},
  x=>{x.profileResult.profile.hvn=[x.profileResult.profile.hvn[0],x.profileResult.profile.hvn[0],x.profileResult.profile.hvn[2]]},
  x=>{x.profileResult.profile.hvn[1].priceLow=999},x=>{x.entry=125;x.stop=124},
  x=>{x.profileResult.evidence.windowEnd=NOW-90001},x=>{x.profileResult.evidence.coverage.complete=false}]){
  const input=plan();mutate(input);const result=run(input);assert.equal(result.code,'TP_PROFILE_UNAVAILABLE');assert.equal(result.ok,false);
  assert.deepEqual(result.targets,[]);assert.equal(result.estimatedNetRR,null);assert.equal(result.fixedRRReplacementEnabled,false);
 }
});

test('unknown contract units and any missing cost remain blocked rather than becoming quantity1 or zero costs',()=>{
 for(const mutate of [x=>{x.unitsVerified=false},x=>{delete x.contractSizeBase},x=>{x.quantityUnit='UNVERIFIED'},x=>{x.notionalCurrency='UNKNOWN'},
  ...['makerRate','takerRate','spreadBps','slippageBps','fundingRate','assumption'].map(key=>x=>{delete x.costs[key]})]){
  const input=plan();mutate(input);assert.equal(run(input).ok,false);
 }
 const actual=plan();actual.profileResult.evidence.dataSource='REAL_BINANCE_AGG_TRADES';actual.costs.assumption='EXPLICIT_PAPER_ASSUMPTIONS';
 assert.equal(run(actual).ok,true,'explicit standard PAPER assumptions are allowed as a model, not as account rates');
 assert.equal(run(actual).costAssumptions.accountRateVerified,false);assert.equal(run(actual).executionApproved,false);
});

test('net reward/risk, minimum order sizes, notional and exact split increments are independent safety checks',()=>{
 for(const mutate of [x=>{x.stop=90},x=>{x.minNetRR=100},x=>{x.minQuantity=30},x=>{x.minNotional=100000},
  x=>{x.quantity=101},x=>{x.quantityStep=.3},x=>{x.stop=101},x=>{x.costs.slippageBps=1000}]){
  const input=plan();mutate(input);assert.equal(run(input).ok,false);
 }
 const small=plan();small.quantity=.1;small.quantityStep=.0001;small.minQuantity=.001;small.minNotional=.1;
 assert.equal(run(small).ok,true);assert.deepEqual(run(small).parts.map(part=>part.quantity),[.04,.035,.025]);
});

test('adverse funding reserve is explicit for both directions and no favorable assumed rate inflates expected PNL',()=>{
 for(const direction of ['LONG','SHORT']){
  const base=plan(direction),zero=structuredClone(base),negative=structuredClone(base);zero.costs.fundingRate=0;negative.costs.fundingRate=-.0003;
  const regular=run(base),without=run(zero),opposite=run(negative);
  assert.ok(regular.parts[0].estimatedFundingReserve>0);assert.ok(regular.estimatedNetRR<without.estimatedNetRR);
  assert.equal(regular.estimatedNetRR,opposite.estimatedNetRR);assert.equal(regular.costAssumptions.fundingPolicy,'ABSOLUTE_RATE_STRESS_RESERVE');
 }
});

test('HVN_THEN_R: same as strict when three zones exist, R steps fill open air, heavy zone before TP1 blocks',()=>{
 const hybrid=extra=>run({...plan(),targetMode:'HVN_THEN_R',...extra});
 assert.deepEqual(hybrid().targets,run(plan()).targets);assert.equal(hybrid().fixedRRReplacementEnabled,false);assert.equal(hybrid().rMultipleTargets,0);
 const one=hybrid({entry:125,stop:124});assert.equal(one.ok,true,one.reasons?.join());
 assert.deepEqual(one.targets,[129.9,130,131]);assert.deepEqual(one.parts.map(p=>p.source),['HVN','R_MULTIPLE','R_MULTIPLE']);
 assert.deepEqual(one.parts.map(p=>p.rMultiple),[null,5,6]);assert.equal(one.fixedRRReplacementEnabled,true);assert.equal(one.hvnTargets,1);
 const air=hybrid({entry:135,stop:134});assert.equal(air.ok,true,air.reasons?.join());assert.equal(air.hvnTargets,0);
 assert.ok(air.estimatedNetRR>=1.8,'first R step clears the net minimum after costs');assert.ok(air.targets[1]-air.targets[0]>=.99);
 assert.deepEqual(hybrid({entry:109.5,stop:108.5}).reasons,['STRONG_HVN_BEFORE_TP1'],'0.4R to a zone two-thirds of POC');
 const passed=hybrid({entry:109.5,stop:108.5,obstacleFraction:.9});assert.equal(passed.ok,true);assert.equal(passed.targets[0],119.9,'a lighter zone is passed through');
 assert.deepEqual(run({...plan(),entry:135,stop:134}).reasons,['FEWER_THAN_THREE_DIRECTIONAL_HVNS'],'strict mode unchanged');
 assert.deepEqual(hybrid({targetMode:'X'}).reasons,['TARGET_SETTINGS_INVALID']);
});
