import test from 'node:test';
import assert from 'node:assert/strict';
import {gradeSetup,STRICT_MIN_SCORE} from '../quality.mjs';
import {analyze} from '../engine.mjs';
import {tradePlan,entryTiming} from '../public/trade_plan.js';

function fixture(now=Date.now()){
 const t=now-3600000;
 const h1=Array.from({length:149},(_,i)=>{const v=i<118?90+i*.07:100;return{time:t+(i-149)*3600000,open:v,high:v+.35,low:v-.35,close:v,volume:100,quoteVolume:1000000,closed:true}});
 h1.push({time:t,open:100,high:103,low:99.9,close:102.2,volume:230,quoteVolume:2_300_000,closed:true});
 const h4=Array.from({length:110},(_,i)=>{const v=70+i*.28;return{time:t+(i-110)*4*3600000,open:v-.1,high:v+.35,low:v-.35,close:v,volume:300,closed:true}});
 return {h1,h4};
}
const scan=(h1,h4,options={})=>analyze('BTCUSDT',h1,h4,[],options.price??102.2,{quoteVolume:options.quoteVolume??1e8});

test('strict confirmation can pass all independent hard criteria on a strong fresh breakout',()=>{
 const {h1,h4}=fixture();const r=scan(h1,h4);
 assert.equal(r.status,'signal');assert.equal(r.technicalQualified,true);
 assert.equal(r.score,100);assert.ok(r.score>=STRICT_MIN_SCORE);
 assert.deepEqual(r.quality.failed,[]);assert.equal(r.quality.checks.length,9);
 assert.equal(r.quality.checks.filter(x=>x.required).length,8);
 assert.equal(r.quality.checks.filter(x=>!x.required)[0].key,'4hSlope');
});

test('90-point aligned LONG and SHORT qualify without the optional slope bonus',()=>{
 for(const direction of ['LONG','SHORT']){
  const {h1,h4}=fixture();
  h4.forEach((c,i)=>{
   let close=i>85?110:70+i*.28;
   if(i>=105)close=[108,100,100,100,106][i-105];
   Object.assign(c,{open:close-.1,high:close+.35,low:close-.35,close});
  });
  if(direction==='SHORT')for(const c of [...h1,...h4])Object.assign(c,{open:200-c.open,close:200-c.close,high:200-c.low,low:200-c.high});
  const r=scan(h1,h4,{price:direction==='LONG'?102.2:97.8});
  assert.equal(r.score,90);assert.equal(r.quality.minimumScore,90);
  assert.equal(r.quality.passed,true);assert.equal(r.technicalQualified,true);
  assert.equal(r.status,'signal');assert.equal(r.direction,direction);
  assert.deepEqual(r.quality.failed,[]);assert.deepEqual(r.quality.missingBonus,['4시간봉 EMA20 기울기 유지']);
 }
});

test('weak volume rejects otherwise identical pattern; score is evidence count, not success probability',()=>{
 const {h1,h4}=fixture();h1.at(-1).volume=120;
 const r=scan(h1,h4);
 assert.equal(r.patternConfirmed,true);assert.equal(r.technicalQualified,false);
 assert.equal(r.status,'watch');assert.ok(r.quality.failed.some(x=>x.includes('거래량')));
});
test('strong volume but insufficient 1h executed notional fails',()=>{
 const {h1,h4}=fixture();h1.at(-1).quoteVolume=1000;
 const r=scan(h1,h4);
 assert.equal(r.technicalQualified,false);assert.ok(r.quality.failed.some(x=>x.includes('1시간 거래대금')));
 assert.equal(r.score,95);assert.equal(r.status,'watch','95 points cannot override mandatory liquidity');
});
test('24h liquidity too small fails',()=>{
 const {h1,h4}=fixture();const r=scan(h1,h4,{quoteVolume:1e6});
 assert.equal(r.technicalQualified,false);assert.ok(r.quality.failed.some(x=>x.includes('24시간')));
});
test('sloppy close not accepted as strong bar',()=>{
 const {h1,h4}=fixture();h1.at(-1).close=102.0;
 const r=scan(h1,h4,{price:102});assert.equal(r.technicalQualified,false);
 assert.ok(r.quality.failed.some(x=>x.includes('봉 몸통')));
});
test('stale close cannot trigger recent scan signal',()=>{
 const {h1,h4}=fixture(Date.now()-3*3600000);const r=scan(h1,h4);
 assert.equal(r.technicalQualified,false);assert.ok(r.quality.failed.some(x=>x.includes('75분')));
});
test('opposing 4H trend still vetoes strong volume and candlestick strength',()=>{
 const {h1,h4}=fixture();h4.forEach((c,i)=>{if(i>=h4.length-5){c.close=90-i*.20;c.open=c.close+.1;c.high=c.open+.35;c.low=c.close-.35}});
 const r=scan(h1,h4);assert.notEqual(r.status,'signal');
});
test('stale 4H context is a mandatory failure even at 90 points',()=>{
 const {h1,h4}=fixture();for(const c of h4)c.time-=40*86400000;
 const r=scan(h1,h4);assert.equal(r.patternConfirmed,true);assert.equal(r.score,90);
 assert.equal(r.technicalQualified,false);assert.equal(r.status,'watch');
 assert.ok(r.quality.failed.some(x=>x.includes('4시간봉 255분')));
});
test('three targets and fractional scale-out have exact percent and direction symmetry',()=>{
 for(const direction of ['LONG','SHORT']){
  const entry=100,stop=direction==='LONG'?98:102;
  const p=tradePlan({entry,stop,direction,risk:{nominal:1000}});
  assert.deepEqual(p.targets.map(t=>t.reducePct),[40,35,25]);
  assert.deepEqual(p.targets.map(t=>t.remainingPct),[60,25,0]);
  assert.deepEqual(p.targets.map(t=>t.price),direction==='LONG'?[104,106,108]:[96,94,92]);
  assert.equal(p.weightedR,2.85);assert.ok(p.projectedGrossUSD>0);
 }
});
test('entry timing prevents trigger when mark stale or venue not verified',()=>{
 const now=Date.now();const s={entry:100,stop:98,direction:'LONG',pattern:'돌파',patternConfirmed:true,patternConfirmedAt:now-20000,qualified:true,execution:{eligible:true},atr:1};
 assert.equal(entryTiming(s,{price:100,priceAt:now-100000,now,venueReady:true}).code,'stale');
 assert.equal(entryTiming(s,{price:100,priceAt:now,now,venueReady:false}).code,'venue-hold');
 assert.equal(entryTiming(s,{price:100,priceAt:now,now,venueReady:true}).code,'zone');
 assert.equal(entryTiming(s,{price:102,priceAt:now,now,venueReady:true}).code,'chase');
});
