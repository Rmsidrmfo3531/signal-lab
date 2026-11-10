import test from 'node:test';
import assert from 'node:assert/strict';
import {gradeSetup,STRICT_MIN_SCORE,SCORE_VERSION,SCORE_WEIGHTS,MIN_CLOSED_4H_BARS} from '../quality.mjs';
import {analyze} from '../engine.mjs';
import {tradePlan,entryTiming} from '../public/trade_plan.js';

const NOW=Date.parse('2026-11-04T08:00:00Z'),HOUR=3600000;
function fixture(now=NOW){
 const t=now-HOUR;
 const h1=Array.from({length:149},(_,i)=>{const v=i<118?90+i*.07:100;return{time:t+(i-149)*HOUR,open:v,high:v+.35,low:v-.35,close:v,volume:100,quoteVolume:1e6,closed:true}});
 h1.push({time:t,open:100,high:103,low:99.9,close:102.2,volume:230,quoteVolume:2300000,closed:true});
 const h4=Array.from({length:260},(_,i)=>{const v=50+i*.2;return{time:t+(i-260)*4*HOUR,open:v-.1,high:v+.35,low:v-.35,close:v,volume:300,closed:true}});
 return {h1,h4};
}
const scan=(h1,h4,options={})=>analyze(options.symbol??'BTCUSDT',h1,h4,[],options.price??102.2,{now:options.now??NOW,quoteVolume:options.quoteVolume??1e8,...(options.btcH4Rows?{btcH4Rows:options.btcH4Rows}:{})});
const flip=bars=>bars.map(c=>({...c,open:200-c.open,close:200-c.close,high:200-c.low,low:200-c.high}));
const grade=(patch={})=>{const {h1,h4}=fixture();return gradeSetup({symbol:'BTCUSDT',direction:'LONG',pattern:'박스권 상단 돌파',h1,h4,atr1h:.9,volumeRatio:2.3,entry:102.2,stop:99,price:102.2,now:NOW,...patch})};

test('Issue6 uses exactly nine components totaling100 and no removed or blended weights',()=>{
 const r=grade();
 assert.equal(r.scoreVersion,SCORE_VERSION);assert.equal(r.checks.length,9);
 assert.deepEqual(Object.fromEntries(r.checks.map(c=>[c.key,c.weight])),SCORE_WEIGHTS);
 assert.equal(r.checks.reduce((n,c)=>n+c.weight,0),100);assert.equal(r.checks.reduce((n,c)=>n+c.earned,0),r.score);
 assert.ok(r.checks.every(c=>c.required===false),'score components are not duplicated mandatory gates');
 for(const key of ['obv','bollinger','ema50','liquidity','hourlyLiquidity','stop','unobstructed','4hSlope'])assert.ok(!r.checks.some(c=>c.key===key),key);
 assert.equal(r.policy.scoreIsWinProbability,false);assert.equal(r.policy.thresholdStatus,'PROPOSED_NOT_BACKTEST_CALIBRATED');
});

test('clear confirmed LONG and SHORT can reach technical90 without requiring all100 points',()=>{
 for(const direction of ['LONG','SHORT']){
  let {h1,h4}=fixture();if(direction==='SHORT'){h1=flip(h1);h4=flip(h4)}
  const r=scan(h1,h4,{price:direction==='LONG'?102.2:97.8});
  assert.equal(r.direction,direction);assert.equal(r.score,90);assert.equal(r.score,STRICT_MIN_SCORE);
  assert.equal(r.quality.checks.find(c=>c.key==='rsi').earned,0);
  assert.equal(r.quality.validationPassed,true);assert.equal(r.quality.thresholdPassed,true);
  assert.equal(r.technicalQualified,true);assert.equal(r.status,'signal');assert.deepEqual(r.quality.failed,[]);
 }
});

test('new technical patterns preserve entry and stop while waiting for actual volume-profile targets',()=>{
 const {h1,h4}=fixture();const r=scan(h1,h4);
 assert.equal(r.patternConfirmed,true);assert.ok(r.entry>r.stop);
 assert.equal(r.target1,null);assert.equal(r.target2,null);assert.equal(r.target3,null);assert.equal(r.targetPlan,null);
 assert.equal(r.managementVersion,'VOLUME_PROFILE_V1');assert.equal(r.targetPlanStatus,'AWAITING_AGGTRADES_PROFILE');
});

test('pattern-specific volume points differ for breakout and retest without inventing volume',()=>{
 const breakout=grade({volumeRatio:1.3}),retest=grade({pattern:'돌파 후 지지 재확인',volumeRatio:1.3}),missing=grade({volumeRatio:null});
 assert.equal(breakout.checks.find(c=>c.key==='patternVolume').earned,5);
 assert.equal(retest.checks.find(c=>c.key==='patternVolume').earned,10);
 assert.equal(missing.checks.find(c=>c.key==='patternVolume').earned,0);
 assert.equal(retest.score-breakout.score,5);
});

test('daily and hourly turnover and pivot obstacle are not hidden point conditions',()=>{
 const {h1,h4}=fixture(),base=scan(h1,h4),thin=structuredClone(h1);thin.at(-1).quoteVolume=1;
 const other=scan(thin,h4,{quoteVolume:1});assert.equal(other.score,base.score);
 assert.equal(other.technicalQualified,base.technicalQualified);
 const plain=grade(),obstructed=grade({obstacle:{price:102.5,kind:'support'},dayQuoteVolume:0,target1:null});
 assert.equal(obstructed.score,plain.score);assert.deepEqual(obstructed.failed,plain.failed);
});

test('weak confirmed candle strength loses pattern points rather than asserting a win probability',()=>{
 const {h1,h4}=fixture();const baseline=scan(h1,h4);h1.at(-1).close=101.5;
 const weak=scan(h1,h4,{price:101.5});assert.equal(weak.patternConfirmed,true);
 assert.ok(weak.quality.checks.find(c=>c.key==='patternCandle').earned<baseline.quality.checks.find(c=>c.key==='patternCandle').earned);
 assert.ok(weak.score<baseline.score);assert.equal(weak.technicalQualified,false);
});

test('freshness is a separate veto and does not reduce the numeric score',()=>{
 const {h1,h4}=fixture(NOW-3*HOUR),fresh=grade(),stale=scan(h1,h4);
 assert.equal(stale.score,fresh.score);assert.equal(stale.patternConfirmed,true);assert.equal(stale.technicalQualified,false);
 assert.ok(stale.quality.failed.some(x=>x.includes('1시간봉 75분')));
});

test('stale4H evidence does not lose points but prevents technical qualification',()=>{
 const {h1,h4}=fixture();const baseline=scan(h1,h4);for(const c of h4)c.time-=40*86400000;
 const stale=scan(h1,h4);assert.equal(stale.score,baseline.score);assert.equal(stale.patternConfirmed,true);
 assert.equal(stale.technicalQualified,false);assert.ok(stale.quality.failed.some(x=>x.includes('4시간봉 255분')));
});

test('stop invalidation and chase cannot be overridden by a high score',()=>{
 for(const patch of [{stop:103},{price:105}]){
  const r=grade(patch);assert.equal(r.score,90);assert.equal(r.passed,false);assert.equal(r.technicalValidation.passed,false);
 }
});

test('insufficient EMA200 warm-up is unavailable rather than a misleading zero score',()=>{
 const {h1,h4}=fixture();
 for(const length of [110,200,MIN_CLOSED_4H_BARS-1]){
  const r=scan(h1,h4.slice(-length));assert.equal(r.status,'insufficient');assert.equal(r.score,null);
  assert.equal(r.evaluationStatus,'UNAVAILABLE');assert.equal(r.qualified,false);assert.match(r.reason,/250/);
 }
});

test('unfinished or future-completing bars cannot change a score even when closed is falsely asserted',()=>{
 const {h1,h4}=fixture(),baseline=scan(h1,h4),withForming1=structuredClone(h1),withForming4=structuredClone(h4);
 withForming1.push({time:NOW,closeTime:NOW+HOUR-1,open:102,high:10001,low:100,close:10000,volume:1e9,closed:true});
 withForming4.push({time:NOW,closeTime:NOW+4*HOUR-1,open:102,high:10001,low:100,close:10000,volume:1e9,closed:true});
 const after=scan(withForming1,withForming4);
 assert.equal(after.score,baseline.score);assert.equal(after.pattern,baseline.pattern);assert.equal(after.entry,baseline.entry);
 assert.deepEqual(after.scoreBreakdown,baseline.scoreBreakdown);
});

test('altcoin BTC4H regime is an independent required context and never contributes extra points',()=>{
 const {h1,h4}=fixture();const missing=scan(h1,h4,{symbol:'SOLUSDT'}),same=scan(h1,h4,{symbol:'SOLUSDT',btcH4Rows:h4}),
  opposite=scan(h1,h4,{symbol:'SOLUSDT',btcH4Rows:flip(h4)});
 assert.equal(missing.score,same.score);assert.equal(same.score,opposite.score);
 assert.equal(missing.quality.validationChecks.find(c=>c.key==='btc4h').status,'UNVERIFIED');assert.equal(missing.technicalQualified,false);
 assert.equal(same.technicalQualified,true);assert.equal(opposite.technicalQualified,false);
 assert.equal(opposite.quality.validationChecks.find(c=>c.key==='btc4h').status,'FAIL');
 const stale=scan(h1,h4,{symbol:'SOLUSDT',btcH4Rows:h4.map(c=>({...c,time:c.time-40*86400000}))});
 assert.equal(stale.score,same.score);assert.equal(stale.btcContext.status,'UNVERIFIED');assert.equal(stale.technicalQualified,false);
});

test('legacy fixed-R stored plans remain explicitly identifiable and direction symmetric',()=>{
 for(const direction of ['LONG','SHORT']){
  const entry=100,stop=direction==='LONG'?98:102;
  const p=tradePlan({entry,stop,direction,risk:{nominal:1000},managementVersion:'LEGACY_R_MULTIPLES'});
  assert.deepEqual(p.targets.map(t=>t.reducePct),[40,35,25]);
  assert.deepEqual(p.targets.map(t=>t.remainingPct),[60,25,0]);
  assert.deepEqual(p.targets.map(t=>t.price),direction==='LONG'?[104,106,108]:[96,94,92]);
  assert.equal(p.weightedR,2.85);assert.ok(p.projectedGrossUSD>0);
 }
});

test('entry timing rejects stale prices, missing venue verification and chase independently of score',()=>{
 const s={entry:100,stop:98,direction:'LONG',pattern:'돌파',patternConfirmed:true,patternConfirmedAt:NOW-20000,qualified:true,execution:{eligible:true},atr:1};
 assert.equal(entryTiming(s,{price:100,priceAt:NOW-100000,now:NOW,venueReady:true}).code,'stale');
 assert.equal(entryTiming(s,{price:100,priceAt:NOW,now:NOW,venueReady:false}).code,'venue-hold');
 assert.equal(entryTiming(s,{price:100,priceAt:NOW,now:NOW,venueReady:true}).code,'zone');
 assert.equal(entryTiming(s,{price:102,priceAt:NOW,now:NOW,venueReady:true}).code,'chase');
});
