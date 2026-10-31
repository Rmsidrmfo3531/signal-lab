import test from 'node:test';
import assert from 'node:assert/strict';
import {orangeXOfficialSources,reviewOrangeXDocumentedStandards} from '../orangex_official_sources.mjs';
import {evaluateOrangeXCostEvidence} from '../orangex_cost_validation.mjs';

const NOW=Date.parse('2026-10-31T12:00:00Z');
const market=asset=>({instrumentName:asset+'-USDT-PERPETUAL',contractFields:{maker_commission:{value:.0002},taker_commission:{value:.0006}}});
const check=(result,id)=>result.checks.find(row=>row.id===id);

test('latest standard and legacy official descriptions retain their own dates and scopes without selecting an account rate',()=>{
 const register=orangeXOfficialSources(),latest=register.sources.find(row=>row.id==='STANDARD_FEES_2026'),old=register.sources.find(row=>row.id==='LEGACY_FEES_2023');
 assert.equal(register.provenance.kind,'USER_CONFIRMED_OFFICIAL_SOURCE_EXCERPTS');assert.equal(register.provenance.independentlyRetrievedByAgent,false);
 assert.equal(latest.updatedOn,'2026-09-16');assert.equal(latest.facts.makerFraction,.0002);assert.equal(latest.facts.takerFraction,.0006);
 assert.equal(old.publishedYear,2023);assert.equal(old.updatedOn,null);assert.equal(old.facts.takerFraction,.0005);assert.equal(old.facts.makerFraction,undefined);
 assert.match(latest.url,/1764-orangex-maker-taker-fees-explained$/);assert.match(old.url,/16774208296727-Futures-Fee-Structure-Fee-Calculations$/);
 latest.facts.takerFraction=0;assert.equal(orangeXOfficialSources().sources.find(row=>row.id==='STANDARD_FEES_2026').facts.takerFraction,.0006);
 const result=reviewOrangeXDocumentedStandards(market('BTC'),{now:NOW});assert.equal(result.feeSourceComparison.status,'DATED_OFFICIAL_DESCRIPTIONS_DIFFER');
 assert.equal(result.standardFees.effectiveAccountRates,null);assert.equal(result.status,'NOT_READY');
});

test('raw values can match a confirmed public standard while account fees and operational costs remain unverified',()=>{
 for(const asset of ['BTC','ETH','SOL']){
  const input=market(asset),before=structuredClone(input),documentary=reviewOrangeXDocumentedStandards(input,{now:NOW});
  assert.equal(check(documentary,'PUBLIC_STANDARD_FEES').status,'PASS');assert.equal(check(documentary,'OBSERVED_FEES_MATCH_PUBLIC_STANDARD').status,'PASS');
  assert.equal(documentary.standardFees.observedRawMatches,true);assert.equal(check(documentary,'EFFECTIVE_ACCOUNT_FEES').status,'UNVERIFIED');
  const operational=evaluateOrangeXCostEvidence({mode:'READ_ONLY',dataSource:'REAL_PUBLIC_OBSERVATION_SUMMARY',market:input},{now:NOW});
  assert.equal(operational.documentaryStandards.standardFees.observedRawMatches,true);
  assert.equal(check(operational,'FEE_RATE_UNIT').status,'UNVERIFIED');assert.equal(check(operational,'ACCOUNT_RATE_APPLICABILITY').status,'UNVERIFIED');
  assert.equal(operational.publicFeeRateFractions,null);assert.equal(operational.effectiveAccountFeeRates,null);
  assert.equal(operational.actualFeeEstimate,null);assert.equal(operational.actualFundingEstimate,null);assert.equal(operational.status,'NOT_READY');
  assert.equal(operational.activationAllowed,false);assert.equal(operational.paperAutoEntryEnabled,false);assert.equal(operational.liveOrdersEnabled,false);
  assert.deepEqual(input,before);
 }
 const missing=market('BTC');delete missing.contractFields.maker_commission;
 assert.equal(check(reviewOrangeXDocumentedStandards(missing,{now:NOW}),'OBSERVED_FEES_MATCH_PUBLIC_STANDARD').status,'UNVERIFIED');
 const different=market('BTC');different.contractFields.taker_commission.value=.0005;
 const result=reviewOrangeXDocumentedStandards(different,{now:NOW});assert.equal(check(result,'OBSERVED_FEES_MATCH_PUBLIC_STANDARD').status,'FAIL');
 assert.equal(result.standardFees.effectiveAccountRates,null,'difference can reflect a different schedule/account, never an automatic account-rate choice');
});

test('general funding sign and times preserve timing variation and exceptions without manufacturing current symbol schedules',()=>{
 const result=reviewOrangeXDocumentedStandards(market('SOL'),{now:NOW}),funding=result.generalFunding;
 assert.equal(check(result,'GENERAL_FUNDING_RULES').status,'PASS');assert.equal(funding.positiveRatePayer,'LONG');assert.equal(funding.negativeRatePayer,'SHORT');
 assert.equal(funding.notionalBasis,'MARK_PRICE_TIMES_BASE_POSITION_QUANTITY');assert.equal(funding.onlyHeldAtSettlement,true);
 assert.deepEqual(funding.generalUtcHours,[0,8,16]);assert.equal(funding.generalTimingVariationMs,15000);assert.deepEqual(funding.intervalExceptionsHours,[1,4]);
 assert.equal(funding.currentSymbolIntervalMs,null);assert.equal(funding.currentSymbolNextSettlementAt,null);assert.equal(funding.currentSymbolRate,null);
 assert.equal(check(result,'CURRENT_SYMBOL_FUNDING').status,'UNVERIFIED');assert.equal(check(result,'FUNDING_HISTORY_RECOVERY').status,'UNVERIFIED');
 const sources=orangeXOfficialSources().sources,api=sources.find(row=>row.id==='API_PUBLIC_FUNDING_FIELDS');
 assert.equal(api.facts.publicEndpoint,'/public/coin_gecko_contracts');assert.equal(api.facts.actualResponseSchemaVerified,false);
 assert.equal(api.facts.rateUnitVerified,false);assert.equal(api.facts.nextTimestampMeaningVerified,false);
});

test('documented amount modes and ambiguous baseCurrency do not establish default conversion or enable private calls',()=>{
 const sources=orangeXOfficialSources().sources,api=sources.find(row=>row.id==='API_INSTRUMENTS');
 assert.equal(api.facts.min_qty,'MINIMUM_ORDER_QUANTITY');assert.equal(api.facts.min_trade_amount,'ORDER_QUANTITY_INCREMENT');
 assert.equal(api.facts.min_notional,'DESCRIPTION_MENTIONS_BASECURRENCY_MEANING_AMBIGUOUS');
 const general=sources.find(row=>row.id==='LINEAR_FUTURES_GENERAL');assert.equal(general.facts.exampleUnderlyingAssetUnitDescription,true);
 assert.equal(general.facts.symbolSpecificConversionVerified,false);assert.deepEqual(general.facts.examples,['BTC/USDT','ETH/USDT']);
 for(const id of ['API_BUY','API_SELL']){
  const row=sources.find(source=>source.id===id);assert.equal(row.facts.market_amount_order_default,false);
  assert.equal(row.facts.market_amount_order_true_unit,'USDT_VALUE');assert.equal(row.facts.market_amount_order_false_unit,'UNVERIFIED');
  assert.equal(row.facts.requestAcknowledgementIsFill,false);assert.equal(row.scope,'DOCUMENTATION_ONLY_PRIVATE_REQUESTS_PROHIBITED');
 }
 const input={...market('SOL'),dataSource:'SYNTHETIC_FIXTURE',unknown_secret:'unit-test-not-output'};
 const result=reviewOrangeXDocumentedStandards(input,{now:NOW});assert.equal(result.inputObservationClass,'SYNTHETIC_TEST_INPUT');
 assert.doesNotMatch(JSON.stringify(result),/unit-test-not-output/);assert.equal(result.realDataAutoEntryEnabled,false);
});
