import test from 'node:test';
import assert from 'node:assert/strict';
import {PaperEngine,nextSizeScale} from '../paper.mjs';

const START=Date.parse('2026-11-04T04:00:00Z');
function signal(symbol,quantity=2.6,extra={}){
 const prices=[105,108,112];
 return {symbol,direction:'LONG',pattern:'SYNTHETIC_PROFILE_BREAKOUT',patternConfirmed:true,entry:100,stop:98,patternConfirmedAt:START-1000,managementVersion:'VOLUME_PROFILE_V1',
  targetPlan:{ok:true,code:'TP_PROFILE_READY',targets:prices,quantity,minNotional:5,minQuantity:.001,quantityStep:.001,tickSize:.01,quantityUnit:'BASE_ASSET',notionalCurrency:'USDT',
   parts:prices.map((price,i)=>({price,fraction:[.4,.35,.25][i],quantity:Number((quantity*[.4,.35,.25][i]).toFixed(3))})),
   profileEvidence:{dataSource:'SYNTHETIC_TEST',startAt:START-3600000,endAt:START-1000,coverage:1,historicalOrderBookAvailable:false},
   costAssumptions:{assumption:'SYNTHETIC_TEST',makerRate:.0002,takerRate:.0006,slippageBps:2,spreadBps:2,fundingRate:0},estimatedNetRR:2.1},...extra};
}

test('each new position while others are open is half the newest open one; back to full when all are closed',()=>{
 let now=START;const engine=new PaperEngine({},{now:()=>now,settings:{maxPositions:5}});
 assert.equal(nextSizeScale(engine.store),1);
 assert.equal(engine.register(signal('AUSDT'),{quoteEligible:true}),true);
 assert.equal(engine.store.pending[0].sizeScale,1);assert.equal(engine.store.pending[0].plannedQuantity,2.6);
 now+=1000;assert.equal(engine.register(signal('BUSDT'),{quoteEligible:true}),true);
 const b=engine.store.pending.find(x=>x.symbol==='BUSDT');assert.equal(b.sizeScale,.5);assert.equal(b.plannedQuantity,1.3);
 assert.deepEqual(b.targetPlan.parts.map(p=>p.quantity),[.52,.455,.325]);
 now+=1000;assert.equal(engine.register(signal('CUSDT'),{quoteEligible:true}),true);
 assert.equal(engine.store.pending.find(x=>x.symbol==='CUSDT').plannedQuantity,.65);
 // A signal sized upstream must carry the expected scale.
 now+=1000;assert.equal(engine.register(signal('DUSDT',1,{sizeScale:1}),{quoteEligible:true}),false);
 assert.equal(engine.store.skipped.at(-1).reason,'SIZE_SCALE_STALE');
 engine.store.pending=[];assert.equal(nextSizeScale(engine.store),1);
});

test('a half size below the minimum order is skipped, not rounded up',()=>{
 let now=START;const engine=new PaperEngine({},{now:()=>now,settings:{maxPositions:5}});
 assert.equal(engine.register(signal('AUSDT',.2),{quoteEligible:true}),true);
 now+=1000;assert.equal(engine.register(signal('BUSDT',.2),{quoteEligible:true}),false);
 assert.equal(engine.store.skipped.at(-1).reason,'HALF_SIZE_BELOW_MINIMUM_ORDER');
});
