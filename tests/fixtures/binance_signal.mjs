import {estimateBinanceExecution} from '../../binance_execution.mjs';
export function syntheticBinanceContext(symbol='BTCUSDT',price=100,now=Date.now()){
 return {dataSource:'SYNTHETIC_FIXTURE',market:{symbol,status:'TRADING',contractType:'PERPETUAL',quoteAsset:'USDT',marginAsset:'USDT',
  filters:{PRICE_FILTER:{tickSize:'.001'},LOT_SIZE:{stepSize:'.001',minQty:'.001'},MIN_NOTIONAL:{notional:'1'}}},
  book:{T:now,bids:[[price-.005,1000]],asks:[[price+.005,1000]]},verified:true,venueConnected:true,price,priceAt:now,now};
}
export function syntheticFinalSignalContext(now=Date.now()){
 const context=syntheticBinanceContext('BTCUSDT',100,now),row={symbol:'BTCUSDT',pattern:'돌파',patternConfirmed:true,technicalQualified:true,score:90,
  technicalValidation:{passed:true},quality:{passed:true,failed:[],validUntil:now+60000},direction:'LONG',entry:100,stop:98,atr:2,
  time:now-3600000,patternConfirmedAt:now-1000,scannedAt:now,status:'signal',qualified:true,managementVersion:'VOLUME_PROFILE_V1'};
 const size=estimateBinanceExecution({signal:row,...context});
 row.targetPlan={ok:true,targets:[106,110,114],quantity:size.quantity,estimatedNetRR:2.5,
  profileEvidence:{receivedAt:now-500,windowEnd:now-500},costAssumptions:{takerRate:.0006,spreadBps:1,slippageBps:5,fundingRate:.0003}};
 [row.target1,row.target2,row.target3]=row.targetPlan.targets;
 return {row,context};
}
