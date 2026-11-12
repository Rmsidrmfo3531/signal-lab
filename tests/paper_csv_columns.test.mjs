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

import {paperBreakdown,breakdownGroup} from '../paper.mjs';
test('closed trades are grouped by strategy and chart for the comparison table',()=>{
 const t=(extra,pnl,risk=2)=>({market:'CRYPTO',realizedPnLUSD:pnl,initialRiskUSD:risk,...extra});
 const closed=[t({},3),t({},-2),t({chartVenue:'BINANCE',strategy:'HOURLY_1H'},1),t({chartVenue:'GATEIO'},-1),t({strategy:'SCALP_REVERSAL_5M'},.5,1),t({strategy:'SCALP_REVERSAL_1M'},-1,1),
  {market:'TRADFI',realizedPnLUSD:9}];
 assert.equal(breakdownGroup(closed[3]),'HOURLY_VENUE');assert.equal(breakdownGroup(closed[6]),'OTHER');
 const g=Object.fromEntries(paperBreakdown(closed).map(x=>[x.key,x]));
 assert.deepEqual([g.HOURLY_BINANCE.trades,g.HOURLY_BINANCE.wins,g.HOURLY_BINANCE.netUSD,g.HOURLY_BINANCE.profitFactor,Number(g.HOURLY_BINANCE.averageR.toFixed(4))],[3,2,2,2,.3333]);
 assert.equal(g.HOURLY_VENUE.netUSD,-1);assert.equal(g.SCALP_REVERSAL_5M.averageR,.5);assert.equal(g.SCALP_REVERSAL_15M.trades,0);assert.equal(g.OTHER.trades,1);
 assert.equal(paperBreakdown([]).some(x=>x.key==='OTHER'),false,'empty "other" row hidden');
});

import {leverageForScore} from '../paper.mjs';
test('leverage = 10 + score points (1 per point above 90) + market-cap points, whole numbers 10-30x; a given leverage wins',()=>{
 assert.deepEqual([80,90,91,92.4,95,99.9,100,120].map(x=>leverageForScore(x)),[10,10,11,12,15,19,20,20]);assert.equal(leverageForScore(undefined),null);
 assert.deepEqual([null,49e6,50e6,150e6,300e6,1.5e9,40e9,2e12].map(c=>leverageForScore(95,c)),[15,15,16,17,18,20,24,25]);
 assert.equal(leverageForScore(100,2e12),30,'max 30x');assert.equal(leverageForScore(90,3e8),13);
 const engine=new PaperEngine({},{now:()=>START});
 engine.register(signal({score:95,marketCap:3e8}),{quoteEligible:true});engine.register(signal({symbol:'CUSDT',leverage:10}),{quoteEligible:true});
 assert.equal(engine.store.pending.find(x=>x.symbol==='AKEUSDT').leverage,18);assert.equal(engine.store.pending.find(x=>x.symbol==='AKEUSDT').marketCap,3e8);assert.equal(engine.store.pending.find(x=>x.symbol==='CUSDT').leverage,10);
 const csv=paperCSV([{market:'CRYPTO',symbol:'AKEUSDT',originalQty:2.6,leverage:15,marginUSD:17.33}]).split('\r\n')[1];
 assert.match(csv,/"2\.6","15","17\.33"$/);
});

import {entryReasons} from '../paper.mjs';
test('entry reasons: 1H score items that earned points; scalp move/volume/RSI/candle evidence',()=>{
 assert.deepEqual(entryReasons({scoreBreakdown:[{label:'4H EMA200',weight:15,earned:15},{label:'RSI(14)',weight:10,earned:5},{label:'x'.repeat(50),weight:5,earned:5},{label:'bad',weight:0,earned:0}]}),['4H EMA200 15/15','RSI(14) 5/10']);
 assert.deepEqual(entryReasons({direction:'LONG',evidence:{movePct:3.2,moveAtr:5.1,climaxVolumeRatio:4.5,rsiPeak:22.4,rejection:'WICK',retracedPct:12}}),
  ['급락 3.2% (5.1 ATR)','최대 거래량 평소의 4.5배','RSI 22.4까지 과매도','반전 꼬리 확인','되돌림 12%에서 진입']);
 const engine=new PaperEngine({},{now:()=>START});engine.register(signal({score:92,scoreBreakdown:[{label:'1H EMA20',weight:10,earned:10}]}),{quoteEligible:true});
 assert.deepEqual(engine.store.pending[0].entryReasons,['1H EMA20 10/10']);
});
