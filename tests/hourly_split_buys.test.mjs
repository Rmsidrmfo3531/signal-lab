import test from 'node:test';
import assert from 'node:assert/strict';
import {PaperEngine,planWithQuantity,leverageForScore} from '../paper.mjs';
import {planZoneDca} from '../dca_plan.mjs';

const START=Date.parse('2026-11-12T00:00:00Z');
const prices=[105,108,112];
function hourly(){
 const quantity=2.6;
 return {symbol:'AUSDT',direction:'LONG',pattern:'SYNTHETIC_PROFILE_BREAKOUT',patternConfirmed:true,entry:100,stop:98,score:95,marketCap:3e8,
  patternConfirmedAt:START-1000,managementVersion:'VOLUME_PROFILE_V1',
  targetPlan:{ok:true,code:'TP_PROFILE_READY',targets:prices,quantity,minNotional:5,minQuantity:.001,quantityStep:.001,tickSize:.01,quantityUnit:'BASE_ASSET',notionalCurrency:'USDT',
   parts:prices.map((price,i)=>({price,fraction:[.4,.35,.25][i],quantity:Number((quantity*[.4,.35,.25][i]).toFixed(3))})),
   profileEvidence:{dataSource:'SYNTHETIC_TEST',startAt:START-3600000,endAt:START-1000,coverage:1,historicalOrderBookAvailable:false},
   costAssumptions:{assumption:'SYNTHETIC_TEST',makerRate:.0002,takerRate:.0006,slippageBps:2,spreadBps:2,fundingRate:0},estimatedNetRR:2.1}};
}

test('1H position as one split-buy trade: adds at zones below entry, stop beyond the last add',()=>{
 const row=hourly();
 // Volume zones under a long entry at 100 (the pattern stop at 98 would cut the trade before any add).
 const zones=[97,94,91,88,85,82,79,76].map(p=>({priceLow:p-.3,priceHigh:p+.3}));
 const leverage=leverageForScore(row.score,row.marketCap);
 assert.ok(leverage>=10&&leverage<=30);
 const dca=planZoneDca({direction:'LONG',entry:100,atr:1,zones,balanceUSD:10000,leverage,unitPct:.19,tickSize:.01,quantityStep:.001,
  minQuantity:.001,minNotional:5,takerRate:.0006,settings:{maxLossPct:30,maxAdds:10}});
 assert.equal(dca.ok,true,JSON.stringify(dca.reasons));
 assert.ok(dca.adds.length>=1&&dca.adds.length<=10);
 const last=dca.adds.at(-1).price;
 assert.ok(dca.stop<last,'stop sits beyond the last add');
 assert.ok(dca.adds.every(a=>a.price<100&&a.price>dca.stop));
 const targetPlan=planWithQuantity(row.targetPlan,dca.unitQty);
 assert.equal(targetPlan.quantity,dca.unitQty);
 let now=START;const engine=new PaperEngine({},{now:()=>now,settings:{maxPositions:5}});
 assert.equal(engine.register({...row,stop:dca.stop,targetPlan,dca,sizeScale:1,leverage},{market:'CRYPTO',symbol:'AUSDT',quoteEligible:true}),true,
  JSON.stringify(engine.store.skipped.at(-1)));
 const p=engine.store.pending[0];
 assert.equal(p.stop,dca.stop);assert.equal(p.dca.adds.length,dca.adds.length);assert.equal(p.leverage,leverage);
});
