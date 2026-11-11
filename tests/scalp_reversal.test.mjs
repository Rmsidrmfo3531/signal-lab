import test from 'node:test';
import assert from 'node:assert/strict';
import {detectScalpReversal,buildScalpPlan,MoveTracker,SCALP_PATTERNS} from '../scalp_reversal.mjs';
import {PaperEngine} from '../paper.mjs';

const STEP=300000,NOW=Date.parse('2026-11-11T00:00:30Z'),LAST_CLOSE=Math.floor(NOW/STEP)*STEP;
// 40 quiet candles around 100, then a fast 4% drop on heavy volume and a hammer.
function crash({direction='LONG',hammer=true,move=4,volume=10}={}){
 const d=direction==='LONG'?1:-1,rows=[];let p=100;
 const push=(o,h,l,c,v)=>rows.push([0,String(o),String(h),String(l),String(c),String(v)]);
 for(let i=0;i<44;i++){const o=p,c=p+(i%2?.05:-.05);push(o,Math.max(o,c)+.1,Math.min(o,c)-.1,c,100);p=c}
 const step=move/4;
 for(let i=0;i<4;i++){const o=p,c=p-d*step;push(o,d===1?o+.05:c+.1,d===1?c-.1:o-.05,c,100*volume*(i===3?1:.5));p=c}
 // Rejection candle: a long wick toward the extreme and a close back in the other half.
 if(hammer)push(p,d===1?p+.15:p+.8,d===1?p-.8:p-.15,p+d*.1,80*volume);
 else push(p,d===1?p+.05:p+.1,d===1?p-.1:p-.05,p-d*.05,80*volume);
 return rows.map((r,i)=>{r[0]=LAST_CLOSE-(rows.length-i)*STEP;return r});
}

test('a sharp drop with a volume climax and a hammer gives a LONG reversal with stop beyond the low and 50/62/79% targets',()=>{
 const r=detectScalpReversal(crash(),{symbol:'SOLUSDT',now:NOW});assert.equal(r.ok,true,JSON.stringify(r));
 assert.equal(r.direction,'LONG');assert.equal(r.pattern,SCALP_PATTERNS.LONG);
 assert.ok(r.stop<r.evidence.extreme);assert.ok(r.targets.every((t,i)=>t>r.entry&&(i===0||t>r.targets[i-1])));
 assert.ok(r.evidence.movePct>=2.5);assert.ok(r.evidence.climaxVolumeRatio>=3);assert.equal(r.barAt,LAST_CLOSE);
});

test('the mirror image (sharp rise, shooting star) gives a SHORT',()=>{
 const r=detectScalpReversal(crash({direction:'SHORT'}),{symbol:'SOLUSDT',now:NOW});assert.equal(r.ok,true,JSON.stringify(r));
 assert.equal(r.direction,'SHORT');assert.ok(r.stop>r.evidence.extreme);assert.ok(r.targets.every(t=>t<r.entry));
});

test('no entry without a rejection candle, a big enough move, volume, or with stale/in-progress data',()=>{
 assert.ok(detectScalpReversal(crash({hammer:false}),{now:NOW}).reasons.includes('NO_REJECTION_CANDLE'));
 assert.ok(detectScalpReversal(crash({move:1}),{now:NOW}).reasons.includes('MOVE_TOO_SMALL'));
 assert.ok(detectScalpReversal(crash({volume:1}),{now:NOW}).reasons.includes('NO_VOLUME_CLIMAX'));
 assert.deepEqual(detectScalpReversal(crash(),{now:NOW+3600000}).reasons,['CANDLES_STALE']);
 const rows=crash();assert.equal(detectScalpReversal(rows.slice(0,-1),{now:NOW}).ok,false,'without the hammer candle');
 const gap=crash();gap.splice(10,1);assert.deepEqual(detectScalpReversal(gap,{now:NOW}).reasons,['KLINE_SCHEMA_OR_SEQUENCE_INVALID']);
 // The in-progress candle is ignored: a hammer still forming does not count.
 const forming=crash();forming.at(-1)[0]=LAST_CLOSE;assert.equal(detectScalpReversal(forming,{now:NOW}).ok,false);
});

test('scalp plan: targets on the tick grid, 40/35/25 on the lot grid, TP1 must clear 1R after costs',()=>{
 const det=detectScalpReversal(crash(),{symbol:'SOLUSDT',now:NOW});
 const estimate={eligible:true,tickSize:.01,quantityStep:.01,entryBasis:Number(det.entry.toFixed(2)),quantity:2,minNotional:5,minQuantity:.01};
 const costs={takerRate:.0006,makerRate:.0002,slippageBps:2,spreadBps:1,fundingRate:.0001,assumption:'EXPLICIT_PAPER_ASSUMPTIONS'};
 const plan=buildScalpPlan({signal:det,estimate,costs});assert.equal(plan.ok,true,JSON.stringify(plan));
 assert.deepEqual(plan.parts.map(p=>p.quantity),[.8,.7,.5]);assert.ok(plan.estimatedNetRR>=1);
 assert.ok(plan.targets.every(t=>Math.abs(t*100-Math.round(t*100))<1e-6));
 assert.deepEqual(buildScalpPlan({signal:det,estimate,costs,minNetRR:50}).reasons,['TP1_NET_RR_BELOW_MINIMUM']);
});

test('move tracker picks only symbols that moved enough inside the window',()=>{
 const t=new MoveTracker(),base=NOW-20*60000;
 for(let i=0;i<20;i++){t.record('AUSDT',100-i*.2,base+i*60000);t.record('BUSDT',100+(i%2)*.1,base+i*60000)}
 assert.deepEqual(t.candidates({now:NOW,minMovePct:2.5}).map(c=>c.symbol),['AUSDT']);
});

test('paper: a scalp signal uses its short entry window and closes the rest at the time stop',()=>{
 let now=NOW;const engine=new PaperEngine({},{now:()=>now});
 const det=detectScalpReversal(crash(),{symbol:'SOLUSDT',now:NOW});
 const estimate={eligible:true,tickSize:.01,quantityStep:.01,entryBasis:Number(det.entry.toFixed(2)),quantity:2,minNotional:5,minQuantity:.01};
 const costs={takerRate:.0006,makerRate:.0002,slippageBps:2,spreadBps:1,fundingRate:.0001,assumption:'EXPLICIT_PAPER_ASSUMPTIONS'};
 const plan=buildScalpPlan({signal:det,estimate,costs});
 const row={symbol:'SOLUSDT',direction:'LONG',pattern:det.pattern,entry:estimate.entryBasis,stop:Number(det.stop.toFixed(2)),patternConfirmedAt:det.barAt,
  managementVersion:'VOLUME_PROFILE_V1',targetPlan:plan,strategy:'SCALP_REVERSAL_5M',entryTimeoutMs:5*60000,maxHoldMs:30*60000};
 assert.equal(engine.register(row,{quoteEligible:true}),true);const p=engine.store.pending[0];
 assert.equal(p.expiresAt-p.signalAt,5*60000);assert.equal(p.strategy,'SCALP_REVERSAL_5M');
 now+=1000;engine.onPrice('CRYPTO','SOLUSDT',estimate.entryBasis,now);assert.equal(engine.store.open.length,1);
 now+=31*60000;engine.onPrice('CRYPTO','SOLUSDT',estimate.entryBasis+.01,now);
 const closed=engine.store.closed.at(-1);assert.equal(closed.closeReason,'TIME_STOP');assert.equal(closed.closeParts.at(-1).type,'TIME');
});

test('4H trend filter: a rebound LONG is blocked in a downtrend, a fade SHORT in an uptrend',async()=>{
 const {fourHourTrend,trendAllows}=await import('../scalp_reversal.mjs');
 const H4=14400000,series=step=>{let p=100;return Array.from({length:260},(_,i)=>{const o=p;p*=step;return [i*H4,String(o),String(Math.max(o,p)),String(Math.min(o,p)),String(p),'1',i*H4+H4-1]})};
 const now=261*H4;
 assert.equal(fourHourTrend(series(.998),now),'down');assert.equal(fourHourTrend(series(1.002),now),'up');
 assert.equal(fourHourTrend(series(.998).slice(0,100),now),null,'not enough history');
 assert.equal(trendAllows('LONG','down'),false);assert.equal(trendAllows('SHORT','up'),false);
 assert.equal(trendAllows('LONG','up'),true);assert.equal(trendAllows('SHORT','range'),true);assert.equal(trendAllows('LONG',null),false);
});
