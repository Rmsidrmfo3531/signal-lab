import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluateOrangeXCostEvidence} from '../orangex_cost_validation.mjs';

const NOW=Date.parse('2026-10-31T01:00:00Z'),INTERVAL=8*3600000,ANCHOR=Date.parse('2026-10-30T00:00:00Z');
const review=extra=>({status:'VERIFIED',officialDocumentURL:'https://openapi-docs.orangex.com/',reviewedAt:NOW-100,...extra});
const fields=()=>({maker_commission:{value:.0002},taker_commission:{value:.0006},contract_size:{value:1}});
// Hypothetical protocol evidence. These are NOT verified OrangeX definitions.
const complete=()=>({mode:'READ_ONLY',dataSource:'SYNTHETIC_TEST',syntheticTest:true,sourceSHA256:'a'.repeat(64),
 market:{instrumentName:'BTC-USDT-PERPETUAL',contractFields:fields(),fundingObservation:{rate:.0001,intervalMs:INTERVAL,
  settlementAnchorAt:ANCHOR,observedAt:NOW-1000}},
 costVerification:{source:review({sourceSHA256:'a'.repeat(64),responseOrigin:'ORANGEX',observedAt:NOW-1000}),
  feeUnit:review({unit:'FRACTION',makerRaw:.0002,takerRaw:.0006}),
  feeBasis:review({basis:'PRICE_TIMES_BASE_QUANTITY',currency:'USDT',contractType:'LINEAR_PERPETUAL'}),
  liquidityRole:review({maker:'ADDS_LIQUIDITY',taker:'REMOVES_LIQUIDITY',limitOrderAlwaysMaker:false}),
  accountApplicability:review({scope:'UNIVERSAL_PUBLIC_SCHEDULE',tierDependent:false,discountDependent:false,makerRaw:.0002,takerRaw:.0006}),
  contract:review({contractType:'LINEAR_PERPETUAL',settlementCurrency:'USDT',quantityUnit:'CONTRACT',contractSizeBase:1}),
  funding:review({unit:'FRACTION',rate:.0001,positiveRatePayer:'LONG',intervalMs:INTERVAL,settlementAnchorAt:ANCHOR,
   notionalBasis:'MARK_TIMES_BASE_QUANTITY',settlementPrice:'MARK_PRICE'}),
  fundingRecovery:review({capability:'COMPLETE_PUBLIC_HISTORY',paginationComplete:true,fromAt:ANCHOR,throughAt:NOW})},
 fundingCoverageRequirement:{fromAt:ANCHOR,throughAt:NOW},
 fundingHistory:{fromAt:ANCHOR,throughAt:NOW,events:[{id:'synthetic-funding-1',at:ANCHOR+INTERVAL,rate:.0001,markPrice:100},
  {id:'synthetic-funding-2',at:ANCHOR+2*INTERVAL,rate:-.0001,markPrice:101},
  {id:'synthetic-funding-3',at:ANCHOR+3*INTERVAL,rate:.0002,markPrice:102}]}});
const run=input=>evaluateOrangeXCostEvidence(input,{now:NOW}),check=(result,id)=>result.checks.find(row=>row.id===id);

test('actual observed raw fee values without official or account evidence remain unknown costs rather than zero',()=>{
 const input={mode:'READ_ONLY',dataSource:'REAL_PUBLIC_OBSERVATION_SUMMARY',market:{instrumentName:'SOL-USDT-PERPETUAL',
  contractFields:{maker_commission:{value:.0002},taker_commission:{value:.0006}}}};
 const result=run(input);assert.equal(result.status,'NOT_READY');assert.equal(check(result,'PUBLIC_FEE_VALUES').status,'PASS');
 for(const id of ['FEE_RATE_UNIT','FEE_NOTIONAL_BASIS','MAKER_TAKER_ROLE','ACCOUNT_RATE_APPLICABILITY','FUNDING_OBSERVATION','FUNDING_HISTORY_RECOVERY'])
  assert.equal(check(result,id).status,'UNVERIFIED',id);
 assert.equal(result.publicFeeRateFractions,null);assert.equal(result.effectiveAccountFeeRates,null);
 assert.equal(result.actualFeeEstimate,null);assert.equal(result.actualFundingEstimate,null);
 assert.equal(result.activationAllowed,false);assert.equal(result.paperAutoEntryEnabled,false);assert.equal(result.liveOrdersEnabled,false);
});

test('reviewed unit interpretation changes the same raw value by factors of 100 and 10000 without guessing',()=>{
 const values={FRACTION:[.0002,.0006],PERCENT:[.000002,.000006],BPS:[.00000002,.00000006]};
 for(const [unit,[maker,taker]]of Object.entries(values)){
  const input=complete();input.costVerification.feeUnit.unit=unit;const result=run(input);
  assert.equal(check(result,'FEE_RATE_UNIT').status,'PASS');assert.ok(Math.abs(result.publicFeeRateFractions.maker-maker)<1e-15);
  assert.ok(Math.abs(result.publicFeeRateFractions.taker-taker)<1e-15);
  assert.equal(result.effectiveAccountFeeRates,null,'synthetic evidence cannot become actual applicable account fees');
  assert.equal(result.status,'NOT_READY');assert.equal(check(result,'SOURCE_PROVENANCE').status,'FAIL');
 }
});

test('conflicting definitions, changed raw rates and a guessed notional basis are not accepted',()=>{
 for(const mutate of [input=>{input.costVerification.feeConflicts=[{resolved:false}]},
  input=>{input.costVerification.feeUnit.makerRaw=.02},input=>{input.costVerification.feeUnit.unit='UNKNOWN'}]){
  const input=complete();mutate(input);const result=run(input);assert.equal(check(result,'FEE_RATE_UNIT').status,'FAIL');assert.equal(result.publicFeeRateFractions,null);
 }
 const input=complete();input.costVerification.feeBasis.basis='CONTRACT_COUNT_ONLY';
 assert.equal(check(run(input),'FEE_NOTIONAL_BASIS').status,'UNVERIFIED');assert.equal(check(run(input),'FEE_NOTIONAL_BASIS').reason,'UNSUPPORTED_FEE_BASIS');
});

test('public fee fields do not establish account tiers, discounts or maker classification from a limit order',()=>{
 const input=complete();delete input.costVerification.accountApplicability;
 assert.equal(check(run(input),'ACCOUNT_RATE_APPLICABILITY').status,'UNVERIFIED');
 input.costVerification.accountApplicability=review({scope:'UNIVERSAL_PUBLIC_SCHEDULE',tierDependent:true,discountDependent:false,makerRaw:.0002,takerRaw:.0006});
 assert.equal(check(run(input),'ACCOUNT_RATE_APPLICABILITY').status,'FAIL');
 input.costVerification.liquidityRole.limitOrderAlwaysMaker=true;assert.equal(check(run(input),'MAKER_TAKER_ROLE').status,'FAIL');
 delete input.market.contractFields.contract_size;assert.equal(check(run(input),'CONTRACT_VALUE_BASIS').status,'FAIL');
});

test('a funding snapshot needs independent fresh observation, documented sign, schedule and mark basis',()=>{
 for(const [mutate,id]of [
  [input=>{input.market.fundingObservation.observedAt=NOW-90001},'FUNDING_OBSERVATION'],
  [input=>{input.costVerification.funding.positiveRatePayer='UNVERIFIED'},'FUNDING_UNIT_SIGN_SCHEDULE'],
  [input=>{input.costVerification.funding.positiveRatePayer='SHORT'},'FUNDING_UNIT_SIGN_SCHEDULE'],
  [input=>{input.costVerification.funding.intervalMs=3600000},'FUNDING_UNIT_SIGN_SCHEDULE']
 ]){const input=complete();mutate(input);assert.equal(check(run(input),id).status,'FAIL')}
 const input=complete();input.costVerification.funding.settlementPrice='LAST_TRADE';
 assert.equal(check(run(input),'FUNDING_UNIT_SIGN_SCHEDULE').status,'UNVERIFIED');
 assert.equal(check(run(input),'FUNDING_UNIT_SIGN_SCHEDULE').reason,'UNSUPPORTED_FUNDING_BASIS','unsupported model is not a claim that official definition is wrong');
});

test('missing, duplicated or off-schedule funding cannot be reported as complete recoverable history',()=>{
 const baseline=run(complete());assert.equal(check(baseline,'FUNDING_HISTORY_RECOVERY').status,'PASS');
 for(const mutate of [input=>{input.fundingHistory.events.pop()},input=>{input.fundingHistory.events[1].id=input.fundingHistory.events[0].id},
  input=>{input.fundingHistory.events[1].at--},input=>{input.fundingHistory.events[1].markPrice=0},
  input=>{input.fundingHistory.throughAt=ANCHOR;input.fundingHistory.events=[]}]){
  const input=complete();mutate(input);assert.equal(check(run(input),'FUNDING_HISTORY_RECOVERY').status,'FAIL');
 }
 const input=complete();input.costVerification.fundingRecovery.paginationComplete=false;assert.equal(check(run(input),'FUNDING_HISTORY_RECOVERY').status,'FAIL');
 delete input.fundingCoverageRequirement;assert.equal(check(run(input),'FUNDING_HISTORY_RECOVERY').status,'UNVERIFIED');
 const oldWindow=complete();oldWindow.fundingHistory.throughAt=ANCHOR+2*INTERVAL;oldWindow.fundingHistory.events.pop();
 oldWindow.fundingCoverageRequirement.throughAt=ANCHOR+2*INTERVAL;
 oldWindow.costVerification.fundingRecovery.throughAt=ANCHOR+2*INTERVAL;
 assert.equal(check(run(oldWindow),'FUNDING_HISTORY_RECOVERY').reason,'CURRENT_SETTLEMENT_COVERAGE_INCOMPLETE');
});

test('actual settlement offsets are unsupported rather than silently forced onto nominal slots or given a generic fifteen-second grace',()=>{
 const input=complete();input.costVerification.funding.eventTimestampMeaning='ACTUAL_SETTLEMENT_TIME';
 input.costVerification.funding.settlementTimingToleranceMs=15000;input.fundingHistory.events[0].at+=10000;
 const result=run(input);assert.equal(check(result,'FUNDING_HISTORY_RECOVERY').status,'UNVERIFIED');
 assert.equal(check(result,'FUNDING_HISTORY_RECOVERY').reason,'UNSUPPORTED_SETTLEMENT_TIME_MODEL');
 assert.equal(result.fundingHistoryTimingModel,'EXACT_NOMINAL_SLOTS_ONLY_NO_AUTOMATIC_15_SECOND_TOLERANCE');
 assert.equal(result.documentaryStandards.generalFunding.generalTimingVariationMs,15000);
 assert.equal(result.documentaryStandards.generalFunding.currentSymbolIntervalMs,null);
 assert.equal(result.actualFundingEstimate,null);assert.equal(result.status,'NOT_READY');
 const exact=complete();assert.equal(check(run(exact),'FUNDING_HISTORY_RECOVERY').status,'PASS','explicit nominal-slot synthetic model is still tested');
});

test('nested synthetic/replay and active-mode evidence remain restrictive and arbitrary secrets are not exported',()=>{
 const input=complete();input.dataSource='REAL_PUBLIC_OBSERVATION_SUMMARY';input.syntheticTest=false;
 const secret='unit-test-private-provider-value';input.market.fundingObservation.dataSource='SYNTHETIC_FIXTURE';
 input.market.unknown_secret=secret;input.costVerification.source.arbitrary=secret;
 let result=run(input);assert.equal(check(result,'SOURCE_PROVENANCE').status,'FAIL');assert.doesNotMatch(JSON.stringify(result),new RegExp(secret));
 delete input.market.fundingObservation.dataSource;input.fundingHistory.runKind='BACKTEST';assert.equal(check(run(input),'SOURCE_PROVENANCE').status,'FAIL');
 delete input.fundingHistory.runKind;input.market.mode='LIVE';assert.equal(check(run(input),'READ_ONLY_CONTEXT').status,'FAIL');
 delete input.market.mode;input.paperEnabled=true;assert.equal(check(run(input),'READ_ONLY_CONTEXT').status,'FAIL');
 input.paperEnabled=false;
 for(const tag of [{dataSource:'HISTORICAL_SNAPSHOT'},{dataSource:'HISTORICAL_PUBLIC_OBSERVATION'},{dataSource:'MOCK'},{dataSource:'SYNTHETIC'},
  {executionMode:'HISTORICAL_REPLAY'}]){
  Object.assign(input.fundingHistory.events[0],tag);assert.equal(check(run(input),'SOURCE_PROVENANCE').status,'FAIL');
 }
 delete input.fundingHistory.events[0].dataSource;delete input.fundingHistory.events[0].executionMode;
 input.costVerification.source.reviewedAt=NOW-2000;
 assert.equal(check(run(input),'SOURCE_PROVENANCE').reason,'ORIGIN_REVIEW_MISMATCH');
});

test('zero public fees require explicit reviewed meaning and invalid clocks cannot disable freshness checks',()=>{
 const input=complete();input.market.contractFields.maker_commission.value=0;delete input.costVerification.feeUnit;
 assert.equal(run(input).publicFeeRateFractions,null);
 input.costVerification.feeUnit=review({unit:'FRACTION',makerRaw:0,takerRaw:.0006});
 assert.equal(run(input).publicFeeRateFractions.maker,0,'an explicitly reviewed zero is different from an unknown fee');
 for(const options of [{now:0},{now:NOW,maxFundingAgeMs:0},{now:NOW,maxFundingAgeMs:Infinity},{now:NOW,maxFundingAgeMs:90001}])
  assert.throws(()=>evaluateOrangeXCostEvidence(input,options),/INVALID_COST_REVIEW_CLOCK/);
});

test('fee, spread, slippage and funding report separate states without inventing an aggregate simulation cost',()=>{
 const input={mode:'READ_ONLY',dataSource:'REAL_PUBLIC_OBSERVATION_SUMMARY',market:{instrumentName:'SOL-USDT-PERPETUAL',
  contractFields:{maker_commission:{value:.0002},taker_commission:{value:.0006}},
  book:{bids:[[100,2],[99.9,3]],asks:[[100.1,2],[100.2,3]],timestamp:NOW-500}}};
 const result=run(input),parts=result.costComponents;
 assert.equal(parts.fees.status,'UNVERIFIED');assert.equal(parts.fees.documentedStandard.takerFraction,.0006);
 assert.equal(parts.fees.accountApplicabilityStatus,'UNVERIFIED');assert.equal(parts.spread.observationStatus,'PASS');
 assert.ok(Math.abs(parts.spread.priceDifference-.1)<1e-12);assert.equal(parts.spread.currentlyFresh,true);
 assert.equal(parts.spread.status,'UNVERIFIED','observed price spread is not a size-specific execution cost');
 assert.equal(parts.slippage.status,'UNVERIFIED');assert.equal(parts.funding.status,'UNVERIFIED');
 for(const part of Object.values(parts))assert.equal(part.estimatedCost,null);
 assert.equal(parts.total.status,'UNVERIFIED');assert.equal(result.paperAutoEntryEnabled,false);
});

test('spread evidence keeps captured numeric observations separate from expired clocks, mixed contracts and malformed depth',()=>{
 const input={mode:'READ_ONLY',market:{instrumentName:'BTC-USDT-PERPETUAL',book:{bids:[[100,2]],asks:[[100.1,3]],timestamp:NOW-90001}}};
 let component=run(input).costComponents.spread;
 assert.equal(component.observationStatus,'PASS');assert.equal(component.status,'FAIL');assert.equal(component.currentlyFresh,false);
 assert.notEqual(component.priceDifference,null,'expiry does not erase observed numbers');
 for(const mutate of [book=>{book.asks.push([100.1,4])},book=>{book.asks=[[99,3]]},
  book=>{book.instrumentName='ETH-USDT-PERPETUAL'},book=>{book.timestamp=NOW+1}]){
  const sample=structuredClone(input);sample.market.book.timestamp=NOW-500;mutate(sample.market.book);
  component=run(sample).costComponents.spread;assert.equal(component.status,'FAIL');assert.equal(component.estimatedCost,null);
 }
 const missing=structuredClone(input);delete missing.market.book.timestamp;
 assert.equal(run(missing).costComponents.spread.status,'UNVERIFIED');
 const large=structuredClone(input);large.market.book={bids:[[1e308,1]],asks:[[1.5e308,1]],timestamp:NOW-500};
 assert.ok(Math.abs(run(large).costComponents.spread.spreadBps-4000)<1e-9,'finite prices cannot overflow their midpoint into a false zero spread');
 assert.equal(evaluateOrangeXCostEvidence({...input,market:{...input.market,book:{...input.market.book,timestamp:NOW-500}}},
  {now:NOW,maxFundingAgeMs:1}).costComponents.spread.currentlyFresh,true,'funding freshness never sets the independent quote age limit');
 for(const maxQuoteAgeMs of [0,90001,Infinity])assert.throws(()=>evaluateOrangeXCostEvidence(input,{now:NOW,maxQuoteAgeMs}),/INVALID_COST_REVIEW_CLOCK/);
});
