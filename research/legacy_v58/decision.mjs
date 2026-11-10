// Research-only compatibility for synthetic pre-Issue6 fixtures. This evaluator
// has no network transport and cannot approve real-data PAPER or exchange orders.
import {estimateBinanceExecution} from '../../binance_execution.mjs';
import {entryTiming} from '../../public/trade_plan.js';
export function evaluateLegacySyntheticSignal(row,{dataSource,market,book,verified=false,venueConnected=false,
 price,priceAt,now=Date.now()}={}){
 const reasons=[],pattern=Boolean(row?.patternConfirmed&&row.pattern),
  fresh=Number.isFinite(row?.quality?.validUntil)&&now<=row.quality.validUntil,
  technical=pattern&&fresh&&row?.technicalQualified===true&&row?.quality?.passed===true&&Number.isFinite(row?.score)&&row.score>=90,
  execution=estimateBinanceExecution({signal:row,market,book,now}),
  costs=execution.costAssumptions,sign=row?.direction==='LONG'?1:-1,entry=execution.entryBasis,
  loss=Number.isFinite(entry)?sign*(entry-row.stop)+(entry+row.stop)*costs.takerRate:null,
  reward=Number.isFinite(entry)?sign*(row.target1-entry)-(entry+row.target1)*costs.takerRate:null;
 execution.estimatedNetRR=loss>0&&Number.isFinite(reward)?reward/loss:null;
 if(dataSource!=='SYNTHETIC_FIXTURE')reasons.push('SYNTHETIC_RESEARCH_ONLY');
 if(!technical)reasons.push('LEGACY_TECHNICAL_VALIDATION_FAILED');
 if(!verified||!venueConnected)reasons.push('SYNTHETIC_BINANCE_CONTRACT_OR_CONNECTION_UNVERIFIED');
 if(!execution.eligible)reasons.push(...execution.reasons);
 if(!Number.isFinite(execution.estimatedNetRR)||execution.estimatedNetRR<1.8)reasons.push('SYNTHETIC_NET_RR_BELOW_MINIMUM');
 const timing=entryTiming({...row,qualified:true,execution:{eligible:true}},
  {price:execution.executablePrice,priceAt:execution.quoteUpdatedAt,now,venueReady:true});
 if(!timing.actionable)reasons.push(timing.label);
 if(!Number.isFinite(price)||price<=0||!Number.isFinite(priceAt)||priceAt>now||now-priceAt>90000)reasons.push('SYNTHETIC_PRICE_CLOCK_INVALID');
 if(!Number.isFinite(row?.scannedAt)||row.scannedAt>now||now-row.scannedAt>20*60000)reasons.push('SYNTHETIC_ANALYSIS_EXPIRED');
 execution.eligible=execution.eligible&&verified&&venueConnected&&dataSource==='SYNTHETIC_FIXTURE';
 return {pattern,technical,venue:technical&&execution.eligible,ready:reasons.length===0,
  stage:!pattern?'noPattern':!technical?'quality':reasons.length?'venue':'ready',execution,timing,reasons,
  tradeApproval:false,realDataAutoEntryEnabled:false,checkedAt:now};
}
