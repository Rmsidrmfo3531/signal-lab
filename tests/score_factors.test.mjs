import test from 'node:test';
import assert from 'node:assert/strict';
import {scoreFactors,scoreV2,SCORE_V2_WEIGHTS} from '../score_factors.mjs';

const H=3600000;
const bars=(n,step,start=100)=>Array.from({length:n},(_,i)=>{const c=start+i*step+Math.sin(i)*.4,o=c-step/2;
 return [i*H,o,Math.max(o,c)+.3,Math.min(o,c)-.3,c,1000+(i%5)*50,(i+1)*H-1]});

test('weights add up to 100 for each direction', () => {
 for(const d of ['LONG','SHORT'])assert.equal(Object.values(SCORE_V2_WEIGHTS[d]).reduce((a,b)=>a+b,0),100);
});

test('factors are booleans and the score stays in 0-100', () => {
 const h1=bars(200,.2),h4=bars(120,.8);
 for(const direction of ['LONG','SHORT']){
  const last=h1.at(-1)[4],f=scoreFactors({h1,h4,direction,entry:last,stop:direction==='LONG'?last-2:last+2,now:200*H});
  for(const [k,v] of Object.entries(f))if(k!=='_atr')assert.equal(typeof v,'boolean',k);
  const {score,items}=scoreV2(f,direction);
  assert.ok(score>=0&&score<=100);assert.equal(items.reduce((s,i)=>s+i.earned,0),score);
 }
 // A steady rise: the price is above the 5 and 20 averages, so the short score gets no points for those.
 const last=h1.at(-1)[4],f=scoreFactors({h1,h4,direction:'SHORT',entry:last,stop:last+2,now:200*H});
 assert.equal(f.ma20Side,false);
});
