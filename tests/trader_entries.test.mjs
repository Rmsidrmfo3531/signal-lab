import test from 'node:test';import assert from 'node:assert/strict';
import {entryFeatures,summarize,report,trend4h} from '../research/trader_entries.mjs';
const M5=300000,T0=Date.parse('2026-10-01T00:00:00Z');
// A day flat at 100, a 6 % rise in the last hour, then a 3 % fall after the entry.
function bars(){const b=[];let p=100;for(let i=0;i<348;i++){if(i>=336&&i<348)p*=1.005;b.push({t:T0+i*M5,o:p,h:p*1.001,l:p*.999,c:p,v:i>=345?500:100})}
 for(let i=0;i<50;i++){p*=.9994;b.push({t:T0+(348+i)*M5,o:p,h:p*1.001,l:p*.999,c:p,v:100})}return b}
test('trader entry study: fade short after a pump wins first; long into it loses; summary and report',()=>{
 const m5=bars(),at=T0+348*M5+60000,entry=m5[348].o;
 const s=entryFeatures({side:'SHORT',at,entry},m5,null);
 assert.equal(s.style,'fade');assert.ok(s.pre60>5);assert.ok(s.rangePos>.9);assert.ok(s.vol3x>2);assert.equal(s.first1,'WIN');assert.ok(s.ret240>1);assert.equal(s.trend4h,null);
 const l=entryFeatures({side:'LONG',at,entry},m5,null);assert.equal(l.style,'follow');assert.equal(l.first1,'LOSS');assert.ok(l.ret240<-1);
 assert.equal(entryFeatures({side:'LONG',at:T0+10*M5,entry:100},m5,null),null,'not enough history');
 const rows=[{...s,side:'SHORT',laterAdded:false,holdMin:10,major:false,source:'binance'},{...l,side:'LONG',laterAdded:true,holdMin:90,major:true,source:'gate'}];
 const sum=summarize(rows);assert.equal(sum.n,2);assert.equal(sum.win1,50);assert.equal(sum.laterAdded,50);
 const txt=report(rows);assert.match(txt,/역행/);assert.match(txt,/추종/);assert.match(txt,/binance 1, gate 1/);
 const up=Array.from({length:220},(_,i)=>({c:100+i}));assert.equal(trend4h(up),'up');assert.equal(trend4h(up.slice(0,50)),null);
});
