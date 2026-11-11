import test from 'node:test';
import assert from 'node:assert/strict';
import {PaperEngine,paperCSV,PAPER_CSV_COLUMNS} from '../paper.mjs';

const START=Date.parse('2026-11-04T04:00:00Z');
const signal=extra=>{const prices=[105,108,112],quantity=2.6;
 return {symbol:'AKEUSDT',direction:'LONG',pattern:'SYNTHETIC_PROFILE_BREAKOUT',patternConfirmed:true,entry:100,stop:98,patternConfirmedAt:START-1000,managementVersion:'VOLUME_PROFILE_V1',
  targetPlan:{ok:true,code:'TP_PROFILE_READY',targets:prices,quantity,minNotional:5,minQuantity:.001,quantityStep:.001,tickSize:.01,quantityUnit:'BASE_ASSET',notionalCurrency:'USDT',
   parts:prices.map((price,i)=>({price,fraction:[.4,.35,.25][i],quantity:Number((quantity*[.4,.35,.25][i]).toFixed(3))})),
   profileEvidence:{dataSource:'SYNTHETIC_TEST',startAt:START-3600000,endAt:START-1000,coverage:1,historicalOrderBookAvailable:false},
   costAssumptions:{assumption:'SYNTHETIC_TEST',makerRate:.0002,takerRate:.0006,slippageBps:2,spreadBps:2,fundingRate:0},estimatedNetRR:2.1},...extra};};

test('paper records keep the chart venue and score; the CSV adds strategy, R multiple and hold time',()=>{
 const engine=new PaperEngine({},{now:()=>START});
 assert.equal(engine.register(signal({analysisVenue:'GATEIO',score:92}),{quoteEligible:true}),true);
 assert.equal(engine.store.pending[0].chartVenue,'GATEIO');assert.equal(engine.store.pending[0].score,92);
 assert.equal(engine.register(signal({symbol:'BUSDT',analysisVenue:'EVIL',score:500}),{quoteEligible:true}),true);
 const b=engine.store.pending.find(x=>x.symbol==='BUSDT');assert.equal(b.chartVenue,undefined);assert.equal(b.score,undefined);
 const csv=paperCSV([
  {market:'CRYPTO',symbol:'AKEUSDT',direction:'LONG',chartVenue:'GATEIO',score:92,sizeScale:1,initialRiskUSD:2,realizedPnLUSD:3,openedAt:START,closedAt:START+90*60000},
  {market:'CRYPTO',symbol:'BTCUSDT',direction:'SHORT',strategy:'SCALP_REVERSAL_5M',dca:{filledAdds:2},initialRiskUSD:4,realizedPnLUSD:-4,openedAt:START,closedAt:START+600000}]).split('\r\n');
 const head=csv[0].replace('﻿','').split(','),row=line=>Object.fromEntries(line.split('","').map((v,i)=>[head[i],v.replaceAll('"','')]));
 assert.deepEqual(head,[...PAPER_CSV_COLUMNS]);
 const a=row(csv[1]),c=row(csv[2]);
 assert.equal(a.strategy,'HOURLY_1H');assert.equal(a.chartVenue,'GATEIO');assert.equal(a.score,'92');assert.equal(a.rMultiple,'1.500');assert.equal(a.holdMinutes,'90');assert.equal(a.dcaAddsFilled,'');
 assert.equal(c.strategy,'SCALP_REVERSAL_5M');assert.equal(c.chartVenue,'BINANCE');assert.equal(c.rMultiple,'-1.000');assert.equal(c.dcaAddsFilled,'2');
});
