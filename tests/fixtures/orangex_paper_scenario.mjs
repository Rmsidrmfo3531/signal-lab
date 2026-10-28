import {analyze} from '../../engine.mjs';
import {evaluateSignal} from '../../signal_pipeline.mjs';
import {marketSeries,ENTRY} from './pipeline_market.mjs';
import {normalizeOrangeXPaperSignal,alignOrangeXPaperSignal} from '../../orangex_paper_signal.mjs';

// These parameters and books are deliberately synthetic, not OrangeX specs.
export const syntheticSettings={capitalUSD:10000,leverage:3,maxRiskUSD:6,dailyLossLimitUSD:30,maxPositions:2,
 maxPositionNotionalUSD:500,maxTotalNotionalUSD:1000,maxSpreadBps:30,maxSlippageBps:100};
export const syntheticContract={instrumentName:'BTC-USDT-PERPETUAL',symbol:'BTCUSDT',source:'SYNTHETIC_FIXTURE',
 quantityUnit:'CONTRACT',contractSizeBase:1,minQty:.001,qtyStep:.001,minNotional:1,priceTick:.01,
 makerRate:.0002,takerRate:.0006,feeUnit:'FRACTION',fundingRate:.0001,fundingIntervalMs:28800000,unitsVerifiedForSimulation:true};
export function nativePaperSignal(direction='LONG'){
 const series=marketSeries(direction==='LONG'?'breakout-long':'breakout-short',Date.now()),
  result=analyze('BTCUSDT',series.h1,series.h4,[],ENTRY,{quoteVolume:1e8});
 const now=Date.now(),quote={bid:ENTRY-.005,ask:ENTRY+.005};
 const decision=evaluateSignal(result,{verified:true,venueConnected:true,listing:{markPrice:ENTRY,quoteUpdatedAt:now,
  quote1k:quote,quoteBase:quote},price:ENTRY,priceAt:now,statsReceivedAt:now,now});
 return {...result,decision,qualified:decision.ready,instrumentName:syntheticContract.instrumentName};
}
export function syntheticBook(at,bid,ask=Number((bid+.01).toFixed(2))){
 return {instrumentName:syntheticContract.instrumentName,dataSource:'SYNTHETIC_FIXTURE',timestamp:at,
  markPrice:Number(((bid+ask)/2).toFixed(6)),markPriceAt:at,bids:[[bid,1000]],asks:[[ask,1000]]};
}
export function paperScenario(){
 const long=nativePaperSignal(),short=nativePaperSignal('SHORT'),now=Date.now()+10;
 const plan=alignOrangeXPaperSignal(normalizeOrangeXPaperSignal(long,{now,source:'SYNTHETIC_FIXTURE'}).signal,syntheticContract);
 const shortPlan=alignOrangeXPaperSignal(normalizeOrangeXPaperSignal(short,{now,source:'SYNTHETIC_FIXTURE'}).signal,syntheticContract);
 if(!long.decision.ready||!short.decision.ready||!plan.ok||!shortPlan.ok)throw Error('SYNTHETIC_SCANNER_SETUP_FAILED');
 return {kind:'ORANGEX_PAPER_SCENARIO',dataSource:'SYNTHETIC_FIXTURE',settings:structuredClone(syntheticSettings),
  contracts:[structuredClone(syntheticContract)],events:[
   {type:'SIGNAL',at:now,signal:long},
   {type:'MARKET',at:now+1,market:syntheticBook(now+1,102.19,102.2)},
   ...plan.signal.targets.map((target,index)=>({type:'MARKET',at:now+2+index,market:syntheticBook(now+2+index,target)})),
   {type:'SIGNAL',at:now+5,signal:short},
   {type:'MARKET',at:now+6,market:syntheticBook(now+6,102.2,102.21)},
   {type:'MARKET',at:now+7,market:syntheticBook(now+7,shortPlan.signal.stop,Number((shortPlan.signal.stop+.01).toFixed(2)))}]};
}
