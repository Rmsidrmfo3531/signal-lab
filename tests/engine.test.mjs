import test from 'node:test';import assert from 'node:assert/strict';
import {ema,atr,recentPivots,normalizedKlines,riskPosition,analyze,formatPrice} from '../engine.mjs';
test('EMA and ATR use valid finite data',()=>{assert.equal(ema([10,10,10],20).at(-1),10);const c=Array.from({length:40},(_,i)=>({open:100,close:100,high:102,low:98,volume:100,time:i}));assert.equal(atr(c),4)});
test('risk is sized from stop distance and trading costs, independent of leverage',()=>{const p=riskPosition('BTCUSDT',80000,79600,.10,6);assert.equal(p.leverage,20);assert.ok(p.riskUSD<=6.00000001);assert.ok(p.nominal>0);assert.equal(riskPosition('ETHUSDT',3000,3000),null)});
test('candlestick parsing drops invalid entries',()=>{const ts=Date.now()-900000;const data=normalizedKlines([[ts,'100','105','95','101','22',ts+60000,'2000'],[ts,'bad',2,1,4,20,ts+1,0]]);assert.equal(data.length,1);assert.equal(data[0].closed,true)});
test('pivots find symmetric extrema',()=>{const vals=[9,7,4,7,10,6,3,6,10,9].map((x,i)=>({high:x+1,low:x-1,time:i}));const p=recentPivots(vals,2);assert.ok(p.lows.length>=1);assert.ok(p.highs.length>=1)});
test('scanner never emits signal from insufficient candles or zero volume',()=>{const r=analyze('BTCUSDT',[],[],[],80000,{quoteVolume:100000000});assert.equal(r.status,'insufficient')});
test('format small token prices',()=>{assert.equal(formatPrice(0),'—');assert.ok(formatPrice(.00000045).includes('0.'))});
test('finished breakout plus 4h trend can produce a legitimate 2R long setup',()=>{
 const t=Date.now()-3600000;
 const h1=Array.from({length:149},(_,i)=>{const v=i<118?90+i*.07:100;return{time:t+(i-149)*3600000,open:v,high:v+.35,low:v-.35,close:v,volume:100,closed:true}});
 h1.push({time:t,open:100,high:103,low:99.9,close:102,volume:230,closed:true});
 const h4=Array.from({length:110},(_,i)=>{const v=70+i*.28;return{time:t+(i-110)*4*3600000,open:v-.1,high:v+.35,low:v-.35,close:v,volume:300,closed:true}});
 const r=analyze('BTCUSDT',h1,h4,[],102,{quoteVolume:1e8});assert.equal(r.status,'watch');assert.equal(r.direction,'LONG');assert.ok(r.target1-r.entry>=2*(r.entry-r.stop)-1e-6);assert.equal(r.technicalQualified,false);assert.ok(r.quality.failed.length>=1);
});

test('completed candle breakout is labelled a confirmed chart pattern even if execution is not checked',()=>{
 const t=Date.now()-3600000;
 const h1=Array.from({length:149},(_,i)=>{const v=i<118?90+i*.07:100;return{time:t+(i-149)*3600000,open:v,high:v+.35,low:v-.35,close:v,volume:100,closed:true}});
 h1.push({time:t,open:100,high:103,low:99.9,close:102,volume:230,closed:true});
 const h4=Array.from({length:110},(_,i)=>{const v=70+i*.28;return{time:t+(i-110)*4*3600000,open:v-.1,high:v+.35,low:v-.35,close:v,volume:300,closed:true}});
 const r=analyze('BTCUSDT',h1,h4,[],102,{quoteVolume:1e8});
 assert.equal(r.patternConfirmed,true);
 assert.equal(r.patternTimeframe,'1h');
 assert.ok(r.patternConfirmedAt<=Date.now()+1000);
 assert.match(r.pattern,/돌파/);
 assert.equal(r.patternInvalidated,false);
});
test('unfinished last 1h candle cannot create confirmed signal',()=>{
 const t=Date.now()-3600000;
 const h1=Array.from({length:149},(_,i)=>{const v=i<118?90+i*.07:100;return{time:t+(i-149)*3600000,open:v,high:v+.35,low:v-.35,close:v,volume:100,closed:true}});
 h1.push({time:Date.now(),open:100,high:103,low:99.9,close:102,volume:230,closed:false});
 const h4=Array.from({length:110},(_,i)=>{const v=70+i*.28;return{time:t+(i-110)*4*3600000,open:v-.1,high:v+.35,low:v-.35,close:v,volume:300,closed:true}});
 const r=analyze('BTCUSDT',h1,h4,[],102,{quoteVolume:1e8});
 assert.equal(r.patternConfirmed,false);
 assert.equal(r.status,'neutral');
});
