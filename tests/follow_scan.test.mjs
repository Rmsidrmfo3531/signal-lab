import test from 'node:test';import assert from 'node:assert/strict';
import {signals,simulate,stats,CONFIGS} from '../research/follow_scan.mjs';
const bar=(t,o,c,w=.001)=>({t,o,h:Math.max(o,c)*(1+w),l:Math.min(o,c)*(1-w),c});
test('follow study: a steady 2 % hour signals LONG, the trend carries it to target; stop first on a both-sides candle',()=>{
 const b=[];let p=100;for(let i=0;i<60;i++){const o=p;p*=i>=48?1.0017:1;b.push(bar(i*3e5,o,p))}
 for(let i=0;i<60;i++){const o=p;p*=1.002;b.push(bar((60+i)*3e5,o,p))}
 const cfg=CONFIGS.find(c=>c.rule==='FOLLOW'&&c.lo===1&&c.stop===1&&c.r===1);
 const s=signals(b,cfg);assert.ok(s.length>=1);assert.equal(s[0].side,'LONG');
 const t=simulate(b,s[0].i,'LONG',cfg);assert.equal(t.exit,'TARGET');assert.ok(Math.abs(t.R-(1-.12))<1e-9);
 const wide=[...b.slice(0,s[0].i+1),bar(0,b[s[0].i].c,b[s[0].i].c,.05)];assert.equal(simulate(wide,s[0].i,'LONG',cfg).exit,'STOP');
 assert.equal(signals(b,CONFIGS.find(c=>c.rule==='ROLLOVER')).length,0,'no 4h move then reversal');
 const st=stats([{R:1},{R:-1},{R:2}]);assert.equal(st.n,3);assert.equal(st.pf,3);assert.ok(Math.abs(st.avgR-2/3)<1e-9);
});
