import test from 'node:test';
import assert from 'node:assert/strict';
import {analyze,validateKlineSeries} from '../engine.mjs';

const HOUR=3600000;
function fixture(now=Date.now()){
 const h1=Array.from({length:150},(_,i)=>{
  const close=i<118?90+i*.07:100,time=now-(150-i)*HOUR;
  return {time,closeTime:time+HOUR-1,open:close,high:close+.35,low:close-.35,close,volume:100,quoteVolume:1e6,closed:true};
 });
 Object.assign(h1.at(-1),{open:100,high:103,low:99.9,close:102.2,volume:230,quoteVolume:2300000});
 const h4=Array.from({length:110},(_,i)=>{
  const close=70+i*.28,time=now-(110-i)*4*HOUR;
  return {time,closeTime:time+4*HOUR-1,open:close-.1,high:close+.35,low:close-.35,close,volume:300,quoteVolume:1e6,closed:true};
 });
 return {h1,h4};
}
const scan=({h1,h4})=>analyze('BTCUSDT',h1,h4,[],102.2,{quoteVolume:1e8});

test('well-formed complete 1H and 4H history remains eligible',()=>{
 const rows=fixture();const result=scan(rows);
 assert.equal(result.dataValidation.valid,true);assert.equal(result.status,'signal');
});

for(const [label,mutate,reason] of [
 ['duplicate',x=>x.h1.splice(70,0,{...x.h1[70]}),'중복'],
 ['1H gap',x=>x.h1.splice(70,1),'봉 간격'],
 ['4H gap',x=>x.h4.splice(70,1),'봉 간격'],
 ['impossible high',x=>x.h1.at(-1).high=101,'OHLC'],
 ['negative volume',x=>x.h1.at(-1).volume=-1,'거래량'],
 ['invalid quote volume',x=>x.h1.at(-1).quoteVolume=NaN,'거래량'],
 ['non-finite price',x=>x.h1.at(-1).close=Infinity,'유효하지'],
 ['wrong bar duration',x=>x.h4.at(-1).closeTime-=HOUR,'종료 시각']
])test(`invalid ${label} cannot produce a confirmed setup`,()=>{
 const rows=fixture();mutate(rows);const result=scan(rows);
 assert.equal(result.status,'insufficient');assert.equal(result.dataValidation.valid,false);
 assert.equal(result.patternConfirmed,false);assert.equal(result.qualified,false);
 assert.match(result.reason,new RegExp(reason));
});

test('future closed:true object cannot bypass actual bar close time',()=>{
 const now=Date.now(),row={time:now,closeTime:now+HOUR-1,open:100,high:103,low:99.9,close:102.2,volume:230,closed:true};
 const result=validateKlineSeries([row],HOUR,now);
 assert.equal(result.valid,true);assert.deepEqual(result.candles,[]);
});

test('previous candle high belongs to the breakout reference range',()=>{
 const rows=fixture();rows.h1.at(-2).high=104;
 const result=scan(rows);
 assert.notEqual(result.pattern,'박스권 상단 돌파');
 assert.notEqual(result.status,'signal');
});
