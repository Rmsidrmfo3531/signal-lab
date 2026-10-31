// Cost evidence inspection only. No fee defaults, trading, transport or stores.
// Supplied reviews are declarations to assess; they are not independent source
// authentication. This module never authorizes PAPER or LIVE, even on READY.
import {reviewOrangeXDocumentedStandards} from './orangex_official_sources.mjs';
import {orangeXBookIntegrity} from './orangex_listing_domains.mjs';
const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const finite=value=>typeof value==='number'&&Number.isFinite(value);
const positive=value=>finite(value)&&value>0;
const stamp=value=>Number.isSafeInteger(value)&&value>=1e12&&value<8640000000000000;
const digest=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const same=(a,b)=>finite(a)&&finite(b)&&Math.abs(a-b)<=Math.max(1e-12,Math.abs(a)*Number.EPSILON*8);
const rateUnits=new Set(['FRACTION','PERCENT','BPS']);
const raw=(fields,key)=>plain(fields?.[key])?fields[key].value:undefined;
const rate=(value,unit)=>unit==='FRACTION'?value:unit==='PERCENT'?value/100:unit==='BPS'?value/10000:null;
const row=(id,status,reason,observed={})=>({id,status,reason,observed});
function reviewed(proof,now){
 if(!plain(proof)||proof.status===undefined||proof.status==='UNVERIFIED')return {status:'UNVERIFIED',reason:'OFFICIAL_DEFINITION_UNVERIFIED'};
 if(proof.status==='REJECTED')return {status:'FAIL',reason:'OFFICIAL_REVIEW_REJECTED'};
 let validURL=false;
 try{const url=new URL(proof.officialDocumentURL);validURL=url.protocol==='https:'&&url.hostname==='openapi-docs.orangex.com'&&
  (!url.port||url.port==='443')&&!url.username&&!url.password&&!url.search}catch{}
 return proof.status==='VERIFIED'&&validURL&&stamp(proof.reviewedAt)&&proof.reviewedAt<=now?
  {status:'PASS',reason:'SUPPLIED_OFFICIAL_REVIEW'}:{status:'FAIL',reason:'INVALID_OFFICIAL_REVIEW'};
}
function definition(id,proof,valid,now){
 const result=reviewed(proof,now);
 return result.status!=='PASS'?row(id,result.status,result.reason):valid?row(id,'PASS','REVIEW_MATCHES_REQUIRED_DEFINITION'):
  row(id,'FAIL','REVIEW_CONTRADICTS_REQUIRED_DEFINITION');
}

// A visible spread is an observation, not a size-specific execution cost.
// Preserve its numeric value after expiry without treating it as usable now.
function spreadCostComponent(market,now,maxAgeMs){
 const book=plain(market.book)?market.book:null,integrity=book?orangeXBookIntegrity(book):null,
  bid=book?.bids?.[0]?.[0],ask=book?.asks?.[0]?.[0],
  mismatch=book&&['instrumentName','instrument_name'].some(key=>Object.hasOwn(book,key)&&book[key]!==market.instrumentName),
  valid=integrity?.valid===true&&positive(bid)&&positive(ask)&&ask>bid&&!mismatch,
  clock=book?.timestamp,clockKnown=stamp(clock),fresh=clockKnown&&clock<=now&&now-clock<=maxAgeMs,
  observedStatus=!book?'UNVERIFIED':valid?'PASS':'FAIL',
  reason=!book?'BOOK_UNOBSERVED':mismatch?'BOOK_INSTRUMENT_MISMATCH':!valid?'BOOK_INVALID':
   !clockKnown?'BOOK_CLOCK_UNOBSERVED':!fresh?'BOOK_CLOCK_FUTURE_OR_STALE':'SPREAD_OBSERVED_NOT_SIZE_SPECIFIC_EXECUTION_COST';
 return {status:observedStatus==='FAIL'||valid&&clockKnown&&!fresh?'FAIL':'UNVERIFIED',reason,
  observationStatus:observedStatus,priceDifference:valid?ask-bid:null,spreadBps:valid?(ask-bid)/(bid+(ask-bid)/2)*10000:null,
  sourceTimestamp:clockKnown?clock:null,localAgeMs:clockKnown?now-clock:null,currentlyFresh:valid&&fresh,
  priceCurrencyVerified:false,quantityConversionVerified:false,estimatedCost:null,
  scope:'VISIBLE_BOOK_OBSERVATION_NOT_VALIDATED_EXECUTION_COST'};
}

/** Expected shape: {mode, dataSource, syntheticTest, sourceSHA256, market,
 * costVerification:{source,feeUnit,feeBasis,liquidityRole,accountApplicability,
 * contract,funding,fundingRecovery,feeConflicts},fundingHistory,
 * fundingCoverageRequirement:{fromAt,throughAt}}.
 * Review sections share status, officialDocumentURL and reviewedAt headers.
 * No account identifier, private data, original quote or unknown input is output.
 */
export function evaluateOrangeXCostEvidence(evidence={}, {now=Date.now(),maxFundingAgeMs=90000,maxQuoteAgeMs=90000}={}){
 if(!stamp(now)||[maxFundingAgeMs,maxQuoteAgeMs].some(age=>!Number.isSafeInteger(age)||age<1||age>90000))throw Error('INVALID_COST_REVIEW_CLOCK');
 const input=plain(evidence)?evidence:{},market=plain(input.market)?input.market:{},fields=plain(market.contractFields)?market.contractFields:{},
  proof=plain(input.costVerification)?input.costVerification:{},checks=[],maker=raw(fields,'maker_commission'),taker=raw(fields,'taker_commission'),
  samples=[input,market,market.book,market.fundingObservation,input.fundingHistory,...(Array.isArray(input.fundingHistory?.events)?input.fundingHistory.events.slice(0,10001):[])],
  synthetic=samples.some(value=>value?.syntheticTest===true||value?.executionMode==='SYNTHETIC_TEST'||['SYNTHETIC_TEST','SYNTHETIC_FIXTURE','SYNTHETIC','MOCK','MOCK_RESPONSE'].includes(value?.dataSource)),
  replay=samples.some(value=>value?.executionMode==='HISTORICAL_REPLAY'||value?.runKind==='BACKTEST'||
   ['HISTORICAL_REPLAY','HISTORICAL_SNAPSHOT','HISTORICAL_PUBLIC_OBSERVATION','BACKTEST'].includes(value?.dataSource));
 const unsafe=[input,market].some(value=>plain(value)&&(Object.hasOwn(value,'mode')&&value.mode!=='READ_ONLY'||
  ['ordersSubmitted','orderSubmissionEnabled','paperAutoEntryEnabled','realDataAutoEntryEnabled','liveOrdersEnabled','paperEnabled'].some(key=>value[key]===true)));
 checks.push(row('INSTRUMENT',typeof market.instrumentName==='string'&&/^(BTC|ETH|SOL)-USDT-PERPETUAL$/.test(market.instrumentName)?'PASS':'FAIL','EXACT_REVIEW_INSTRUMENT_REQUIRED'));
 checks.push(row('READ_ONLY_CONTEXT',input.mode==='READ_ONLY'&&!unsafe?'PASS':'FAIL',input.mode==='READ_ONLY'&&!unsafe?'READ_ONLY':'UNSAFE_OR_UNESTABLISHED_CONTEXT'));
 const sourceReview=reviewed(proof.source,now),sourceMatches=['REAL_PUBLIC_OBSERVATION_SUMMARY','REAL_PUBLIC_API_RESPONSE','REAL_PUBLIC_READ_ONLY'].includes(input.dataSource)&&
  digest(input.sourceSHA256)&&proof.source?.sourceSHA256===input.sourceSHA256&&proof.source?.responseOrigin==='ORANGEX'&&stamp(proof.source?.observedAt)&&
  proof.source.observedAt<=now&&proof.source.reviewedAt>=proof.source.observedAt;
 checks.push(synthetic||replay?row('SOURCE_PROVENANCE','FAIL',synthetic?'SYNTHETIC_COSTS_NOT_EXCHANGE_EVIDENCE':'HISTORICAL_OR_REPLAY_NOT_CURRENT_COST_EVIDENCE'):
  sourceReview.status!=='PASS'?row('SOURCE_PROVENANCE',sourceReview.status,sourceReview.reason):
   row('SOURCE_PROVENANCE',sourceMatches?'PASS':'FAIL',sourceMatches?'SUPPLIED_ORIGIN_REVIEW_MATCHES_DIGEST':'ORIGIN_REVIEW_MISMATCH'));
 checks.push(row('PUBLIC_FEE_VALUES',maker===undefined||taker===undefined?'UNVERIFIED':finite(maker)&&finite(taker)?'PASS':'FAIL',
  maker===undefined||taker===undefined?'PUBLIC_FEES_UNOBSERVED':finite(maker)&&finite(taker)?'RAW_FEES_OBSERVED_WITHOUT_UNIT_ASSUMPTION':'INVALID_RAW_FEES',
  {makerRaw:finite(maker)?maker:null,takerRaw:finite(taker)?taker:null}));
 const unresolved=Array.isArray(proof.feeConflicts)&&proof.feeConflicts.some(conflict=>conflict?.resolved!==true);
 checks.push(unresolved?row('FEE_RATE_UNIT','FAIL','UNRESOLVED_FEE_DEFINITION_CONFLICT'):
  definition('FEE_RATE_UNIT',proof.feeUnit,rateUnits.has(proof.feeUnit?.unit)&&same(proof.feeUnit?.makerRaw,maker)&&same(proof.feeUnit?.takerRaw,taker),now));
 const feeBasisReview=reviewed(proof.feeBasis,now),feeBasisSupported=proof.feeBasis?.basis==='PRICE_TIMES_BASE_QUANTITY'&&proof.feeBasis?.currency==='USDT'&&
  proof.feeBasis?.contractType==='LINEAR_PERPETUAL';
 checks.push(feeBasisReview.status==='PASS'&&!feeBasisSupported?row('FEE_NOTIONAL_BASIS','UNVERIFIED','UNSUPPORTED_FEE_BASIS'):
  definition('FEE_NOTIONAL_BASIS',proof.feeBasis,feeBasisSupported,now));
 checks.push(definition('MAKER_TAKER_ROLE',proof.liquidityRole,proof.liquidityRole?.maker==='ADDS_LIQUIDITY'&&proof.liquidityRole?.taker==='REMOVES_LIQUIDITY'&&
  proof.liquidityRole?.limitOrderAlwaysMaker===false,now));
 // A public instrument rate is not an account rate. Public-only evidence can
 // establish applicability only if a reviewed universal schedule explicitly
 // rules out tiers and discounts. No account endpoint/key is used here.
 checks.push(definition('ACCOUNT_RATE_APPLICABILITY',proof.accountApplicability,
  proof.accountApplicability?.scope==='UNIVERSAL_PUBLIC_SCHEDULE'&&proof.accountApplicability?.tierDependent===false&&
  proof.accountApplicability?.discountDependent===false&&same(proof.accountApplicability?.makerRaw,maker)&&same(proof.accountApplicability?.takerRaw,taker),now));
 const contract=proof.contract;
 checks.push(definition('CONTRACT_VALUE_BASIS',contract,contract?.contractType==='LINEAR_PERPETUAL'&&contract?.settlementCurrency==='USDT'&&
  ['BASE_ASSET','CONTRACT'].includes(contract?.quantityUnit)&&positive(contract?.contractSizeBase)&&same(contract.contractSizeBase,raw(fields,'contract_size')),now));

 const funding=plain(market.fundingObservation)?market.fundingObservation:null,fp=proof.funding;
 const fundingObserved=funding!==null&&finite(funding.rate)&&Number.isSafeInteger(funding.intervalMs)&&funding.intervalMs>0&&
  stamp(funding.settlementAnchorAt)&&stamp(funding.observedAt)&&funding.observedAt<=now;
 checks.push(!funding?row('FUNDING_OBSERVATION','UNVERIFIED','FUNDING_NOT_COLLECTED'):
  row('FUNDING_OBSERVATION',fundingObserved&&now-funding.observedAt<=maxFundingAgeMs?'PASS':'FAIL',
   !fundingObserved?'INVALID_FUNDING_OBSERVATION':now-funding.observedAt>maxFundingAgeMs?'FUNDING_OBSERVATION_STALE':'INDEPENDENT_FUNDING_OBSERVED'));
 const fundingBasisSupported=fp?.notionalBasis==='MARK_TIMES_BASE_QUANTITY'&&fp?.settlementPrice==='MARK_PRICE',fundingReview=reviewed(fp,now);
 checks.push(fundingReview.status==='PASS'&&!fundingBasisSupported?row('FUNDING_UNIT_SIGN_SCHEDULE','UNVERIFIED','UNSUPPORTED_FUNDING_BASIS'):
  definition('FUNDING_UNIT_SIGN_SCHEDULE',fp,fundingObserved&&rateUnits.has(fp?.unit)&&same(fp?.rate,funding?.rate)&&
  fp?.positiveRatePayer==='LONG'&&fp?.intervalMs===funding?.intervalMs&&fp?.settlementAnchorAt===funding?.settlementAnchorAt&&
  fundingBasisSupported,now));
 // This historical checker supports nominal schedule slots only. The user has
 // confirmed that actual settlement may differ by about 15 seconds, but that
 // general statement is not a symbol-specific tolerance or grace-period proof.
 // Never call actual-time rows invalid merely because this model cannot align
 // them; keep them UNVERIFIED until a reviewed timing model is implemented.
 const timingModelUnsupported=fp?.eventTimestampMeaning==='ACTUAL_SETTLEMENT_TIME'||
  fp?.settlementTimingToleranceMs!==undefined&&fp.settlementTimingToleranceMs!==0,
  history=plain(input.fundingHistory)?input.fundingHistory:null,recovery=proof.fundingRecovery,
  required=plain(input.fundingCoverageRequirement)?input.fundingCoverageRequirement:null,
  coverageKnown=required!==null&&stamp(required.fromAt)&&stamp(required.throughAt)&&required.throughAt>=required.fromAt&&required.throughAt<=now,
  historyShape=history!==null&&stamp(history.fromAt)&&stamp(history.throughAt)&&history.throughAt>=history.fromAt&&history.throughAt<=now&&
   Array.isArray(history.events)&&history.events.length<=10000&&fundingObserved;
 let historyComplete=false;
 if(historyShape){
  const anchor=funding.settlementAnchorAt,interval=funding.intervalMs,
   expected=Math.floor((history.throughAt-anchor)/interval)-Math.floor((history.fromAt-anchor)/interval),ids=new Set(),times=new Set();
  historyComplete=expected>0&&history.events.length===expected&&history.events.every(event=>{
   if(!plain(event)||typeof event.id!=='string'||!event.id||ids.has(event.id)||!stamp(event.at)||times.has(event.at)||event.at<=history.fromAt||event.at>history.throughAt||
    (event.at-anchor)%interval!==0||!finite(event.rate)||!positive(event.markPrice))return false;
   ids.add(event.id);times.add(event.at);return true;
  });
 }
 const lastSettlement=fundingObserved?funding.settlementAnchorAt+Math.floor((now-funding.settlementAnchorAt)/funding.intervalMs)*funding.intervalMs:null;
 checks.push(!history?row('FUNDING_HISTORY_RECOVERY','UNVERIFIED','HISTORY_QUERY_COVERAGE_UNOBSERVED'):
  timingModelUnsupported?row('FUNDING_HISTORY_RECOVERY','UNVERIFIED','UNSUPPORTED_SETTLEMENT_TIME_MODEL'):
  !coverageKnown?row('FUNDING_HISTORY_RECOVERY','UNVERIFIED','REQUIRED_RECOVERY_WINDOW_UNOBSERVED'):
  history.fromAt>required.fromAt||history.throughAt<required.throughAt||required.throughAt<lastSettlement?
   row('FUNDING_HISTORY_RECOVERY','FAIL','CURRENT_SETTLEMENT_COVERAGE_INCOMPLETE'):
  !historyComplete?row('FUNDING_HISTORY_RECOVERY','FAIL','MISSING_DUPLICATE_OR_INVALID_SETTLEMENTS'):
   definition('FUNDING_HISTORY_RECOVERY',recovery,recovery?.capability==='COMPLETE_PUBLIC_HISTORY'&&recovery?.paginationComplete===true&&
    recovery?.fromAt===history.fromAt&&recovery?.throughAt===history.throughAt,now));
 const byId=id=>checks.find(check=>check.id===id),feeUnitPassed=byId('FEE_RATE_UNIT').status==='PASS'&&finite(maker)&&finite(taker),
  feeApplicable=['INSTRUMENT','READ_ONLY_CONTEXT','SOURCE_PROVENANCE','PUBLIC_FEE_VALUES','FEE_RATE_UNIT','FEE_NOTIONAL_BASIS','MAKER_TAKER_ROLE','ACCOUNT_RATE_APPLICABILITY','CONTRACT_VALUE_BASIS'].every(id=>byId(id).status==='PASS'),
  unit=feeUnitPassed?proof.feeUnit.unit:null,summary={PASS:0,FAIL:0,UNVERIFIED:0,total:checks.length};
 for(const check of checks)summary[check.status]++;
 const componentStatus=ids=>ids.some(id=>byId(id).status==='FAIL')?'FAIL':ids.every(id=>byId(id).status==='PASS')?'PASS':'UNVERIFIED',
  documentaryStandards=reviewOrangeXDocumentedStandards(market,{now}),
  costComponents={
   fees:{status:componentStatus(['INSTRUMENT','READ_ONLY_CONTEXT','SOURCE_PROVENANCE','FEE_RATE_UNIT','FEE_NOTIONAL_BASIS','MAKER_TAKER_ROLE','ACCOUNT_RATE_APPLICABILITY','CONTRACT_VALUE_BASIS']),
    documentedStandard:documentaryStandards.standardFees,accountApplicabilityStatus:byId('ACCOUNT_RATE_APPLICABILITY').status,
    estimatedCost:null,scope:'DEFINITIONS_AND_APPLICABILITY_NOT_ACTUAL_CHARGE'},
   spread:spreadCostComponent(market,now,maxQuoteAgeMs),
   slippage:{status:'UNVERIFIED',reason:'NO_VERIFIED_PROPOSED_SIZE_AND_EXECUTION_MODEL',estimatedCost:null},
   funding:{status:componentStatus(['INSTRUMENT','READ_ONLY_CONTEXT','SOURCE_PROVENANCE','CONTRACT_VALUE_BASIS','FUNDING_OBSERVATION','FUNDING_UNIT_SIGN_SCHEDULE','FUNDING_HISTORY_RECOVERY']),
    estimatedCost:null,scope:'OBSERVATION_SCHEDULE_AND_HISTORY_NOT_ACTUAL_SETTLEMENT'},
   total:{status:'UNVERIFIED',estimatedCost:null,reason:'UNVERIFIED_COMPONENTS_ARE_NOT_ZERO_COSTS'}
  };
 return {kind:'ORANGEX_COST_EVIDENCE_REVIEW',scope:'READ_ONLY_COST_DEFINITIONS_NOT_TRADING_APPROVAL',mode:'READ_ONLY',
  instrumentName:typeof market.instrumentName==='string'&&/^(BTC|ETH|SOL)-USDT-PERPETUAL$/.test(market.instrumentName)?market.instrumentName:null,
  checkedAt:now,status:checks.every(check=>check.status==='PASS')?'READY':'NOT_READY',checks,summary,
  publicFeeRateFractions:feeUnitPassed?{maker:rate(maker,unit),taker:rate(taker,unit)}:null,
  effectiveAccountFeeRates:feeApplicable?{maker:rate(maker,unit),taker:rate(taker,unit)}:null,
  documentaryStandards,costComponents,
  fundingHistoryTimingModel:'EXACT_NOMINAL_SLOTS_ONLY_NO_AUTOMATIC_15_SECOND_TOLERANCE',
  actualFeeEstimate:null,actualFundingEstimate:null,
  activationAllowed:false,realDataAutoEntryEnabled:false,paperAutoEntryEnabled:false,liveOrdersEnabled:false,
  note:'원값·정의·계정 적용·펀딩 복구 근거를 분리합니다. 미확인 비용은 0이 아닌 null이며, 상태 PASS도 모의 진입이나 실거래를 허용하지 않습니다.'};
}
