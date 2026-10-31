// Static documentary evidence supplied by the user on 2026-10-31. These are
// official-source excerpts, not pages independently downloaded by this agent.
// No transport, account lookup, order endpoint or mode mutation exists here.
const provenance=Object.freeze({kind:'USER_CONFIRMED_OFFICIAL_SOURCE_EXCERPTS',providedOn:'2026-10-31',
 independentlyRetrievedByAgent:false,originalHTTPBodyAvailable:false,automaticOperationalProof:false});
const sources=[
 {id:'API_INSTRUMENTS',type:'API_REFERENCE',url:'https://openapi-docs.orangex.com/#get-instruments',
  section:'/public/get_instruments',updatedOn:null,
  facts:{contract_size:'CONTRACT_SIZE',min_trade_amount:'ORDER_QUANTITY_INCREMENT',min_qty:'MINIMUM_ORDER_QUANTITY',
   min_notional:'DESCRIPTION_MENTIONS_BASECURRENCY_MEANING_AMBIGUOUS',tick_size:'MINIMUM_PRICE_INCREMENT',
   is_active:'CURRENT_TRADABILITY',kind:'INSTRUMENT_TYPE'},scope:'FIELD_DEFINITIONS_NOT_SYMBOL_CONVERSION'},
 {id:'LINEAR_FUTURES_GENERAL',type:'CUSTOMER_SUPPORT',url:'https://www.orangex.com/support/faq/articles/390-margined-futures-contracts',
  updatedOn:null,facts:{usdtMarginedFutures:'LINEAR',examples:['BTC/USDT','ETH/USDT'],exampleUnderlyingAssetUnitDescription:true,symbolSpecificConversionVerified:false,
   minimumOrderRequirementsMayChange:true},scope:'GENERAL_DESCRIPTION_NOT_SOL_CONTRACT_SIZE'},
 {id:'API_BUY',type:'API_REFERENCE',url:'https://openapi-docs.orangex.com/#buy',section:'/private/buy',updatedOn:null,
  facts:{amount:'ORDER_QUANTITY',market_amount_order_default:false,market_amount_order_true_unit:'USDT_VALUE',
   market_amount_order_false_unit:'UNVERIFIED',requestAcknowledgementIsFill:false,reduce_only:'REDUCE_EXISTING_POSITION'},
  scope:'DOCUMENTATION_ONLY_PRIVATE_REQUESTS_PROHIBITED'},
 {id:'API_SELL',type:'API_REFERENCE',url:'https://openapi-docs.orangex.com/#sell',section:'/private/sell',updatedOn:null,
  facts:{amount:'ORDER_QUANTITY',market_amount_order_default:false,market_amount_order_true_unit:'USDT_VALUE',
   market_amount_order_false_unit:'UNVERIFIED',requestAcknowledgementIsFill:false,reduce_only:'REDUCE_EXISTING_POSITION'},
  scope:'DOCUMENTATION_ONLY_PRIVATE_REQUESTS_PROHIBITED'},
 {id:'STANDARD_FEES_2026',type:'CUSTOMER_SUPPORT',url:'https://www.orangex.com/support/faq/articles/1764-orangex-maker-taker-fees-explained',
  updatedOn:'2026-09-16',facts:{makerPercent:0.02,takerPercent:0.06,makerFraction:0.0002,takerFraction:0.0006,
   formula:'ACTUAL_EXECUTED_NOTIONAL_TIMES_APPLICABLE_RATE',oneOrderCanContainMixedLiquidityRoles:true,
   accountTierAndDiscountVerified:false},scope:'PUBLIC_STANDARD_NOT_EFFECTIVE_ACCOUNT_RATE'},
 {id:'LEGACY_FEES_2023',type:'CUSTOMER_SUPPORT_LEGACY',url:'https://support.orangex.com/hc/en-us/articles/16774208296727-Futures-Fee-Structure-Fee-Calculations',
  updatedOn:null,publishedYear:2023,facts:{takerPercent:0.05,takerFraction:0.0005},scope:'LEGACY_DIFFERENT_STANDARD_NOT_CURRENT_ACCOUNT_RATE'},
 {id:'FUNDING_GENERAL_2026',type:'CUSTOMER_SUPPORT',url:'https://www.orangex.com/support/1/articles/394-funding-rates-btc-imn?mid=152-1054-1056',
  updatedOn:'2026-09-16',facts:{formula:'POSITION_NOTIONAL_TIMES_FUNDING_RATE',notional:'MARK_PRICE_TIMES_BASE_POSITION_QUANTITY',
   positiveRatePayer:'LONG',negativeRatePayer:'SHORT',onlyPositionHeldAtSettlementParticipates:true,
   generalUtcHours:[0,8,16],generalKstHours:[9,17,1],kstLastHourIsNextDay:true,generalTimingVariationMs:15000,
   allSymbolsUseEightHours:false,currentSymbolRateUnitAndScheduleVerified:false},scope:'GENERAL_RULES_NOT_CURRENT_SYMBOL_SCHEDULE'},
 {id:'FUNDING_ONE_HOUR_EXCEPTION',type:'CUSTOMER_SUPPORT_NOTICE',url:'https://www.orangex.com/support/help/articles/1196-funding-rates-sign',
  updatedOn:null,facts:{publishedIntervalHours:1,appliesAutomaticallyToBTCETHSOL:false},scope:'PUBLISHED_EXCEPTION_NOT_CURRENT_TARGET_SYMBOL_RULE'},
 {id:'FUNDING_FOUR_HOUR_EXCEPTION',type:'CUSTOMER_SUPPORT_NOTICE',url:'https://www.orangex.com/support/help/articles/1193-funding-rates-zora',
  updatedOn:null,facts:{publishedIntervalHours:4,appliesAutomaticallyToBTCETHSOL:false},scope:'PUBLISHED_EXCEPTION_NOT_CURRENT_TARGET_SYMBOL_RULE'},
 {id:'API_PUBLIC_FUNDING_FIELDS',type:'API_REFERENCE',url:'https://openapi-docs.orangex.com/',section:'CoinGecko → Contracts /public/coin_gecko_contracts',
  updatedOn:null,facts:{publicEndpoint:'/public/coin_gecko_contracts',fields:['funding_rate','next_funding_rate','next_funding_rate_timestamp'],
   actualResponseSchemaVerified:false,rateUnitVerified:false,nextTimestampMeaningVerified:false},scope:'DOCUMENTED_FIELDS_NOT_OBSERVED_FUNDING_DATA'}
];
const same=(a,b)=>typeof a==='number'&&Number.isFinite(a)&&typeof b==='number'&&Number.isFinite(b)&&
 Math.abs(a-b)<=Math.max(1e-15,Math.abs(a)*Number.EPSILON*8);
const clone=value=>structuredClone(value);

/** Returned records are copies. They cannot be passed as VERIFIED provenance
 * or account applicability automatically. */
export function orangeXOfficialSources(){return {kind:'ORANGEX_OFFICIAL_SOURCE_REGISTER',provenance:clone(provenance),sources:clone(sources)}}

/** Documentary facts are separate from current venue/account eligibility.
 * This function does not apply a rate to a position or infer its base quantity. */
export function reviewOrangeXDocumentedStandards(market={}, {now=Date.now()}={}){
 if(!Number.isSafeInteger(now)||now<1e12||now>=8640000000000000)throw Error('INVALID_DOCUMENTARY_REVIEW_CLOCK');
 const synthetic=market?.syntheticTest===true||market?.executionMode==='SYNTHETIC_TEST'||
  ['SYNTHETIC_TEST','SYNTHETIC_FIXTURE','MOCK','MOCK_RESPONSE','SYNTHETIC'].includes(market?.dataSource),
  replay=market?.executionMode==='HISTORICAL_REPLAY'||market?.runKind==='BACKTEST',
  name=typeof market?.instrumentName==='string'&&/^(BTC|ETH|SOL)-USDT-PERPETUAL$/.test(market.instrumentName)?market.instrumentName:null,
  fields=market?.contractFields,maker=fields?.maker_commission?.value,taker=fields?.taker_commission?.value,
  observed=typeof maker==='number'&&Number.isFinite(maker)&&typeof taker==='number'&&Number.isFinite(taker),
  matching=observed&&same(maker,.0002)&&same(taker,.0006),checks=[
   {id:'QUANTITY_FIELD_DEFINITIONS',status:'PASS',reason:'USER_CONFIRMED_MIN_QTY_AND_INCREMENT_DEFINITIONS'},
   {id:'PUBLIC_STANDARD_FEES',status:'PASS',reason:'USER_CONFIRMED_2026_STANDARD_SCHEDULE'},
   {id:'OBSERVED_FEES_MATCH_PUBLIC_STANDARD',status:!observed?'UNVERIFIED':matching?'PASS':'FAIL',
    reason:!observed?'RAW_FEES_UNOBSERVED':matching?'NUMERICAL_MATCH_NOT_ACCOUNT_RATE_PROOF':'RAW_VALUES_DIFFER_NOT_AN_ACCOUNT_FEE_VERDICT'},
   {id:'GENERAL_FUNDING_RULES',status:'PASS',reason:'USER_CONFIRMED_MARK_BASIS_SIGN_AND_GENERAL_TIMES_WITH_EXCEPTIONS'},
   {id:'SYMBOL_QUANTITY_CONVERSION',status:'UNVERIFIED',reason:'CONTRACT_SIZE_AND_DEFAULT_AMOUNT_UNIT_NOT_ESTABLISHED'},
   {id:'MIN_NOTIONAL_CURRENCY',status:'UNVERIFIED',reason:'BASECURRENCY_DESCRIPTION_AMBIGUOUS'},
   {id:'EFFECTIVE_ACCOUNT_FEES',status:'UNVERIFIED',reason:'PUBLIC_STANDARD_NOT_ACCOUNT_TIER_OR_DISCOUNT_PROOF'},
   {id:'CURRENT_SYMBOL_FUNDING',status:'UNVERIFIED',reason:'NO_CURRENT_SYMBOL_RATE_SCHEDULE_OR_NEXT_SETTLEMENT_OBSERVATION'},
   {id:'FUNDING_HISTORY_RECOVERY',status:'UNVERIFIED',reason:'CURRENT_OR_EXPECTED_RATE_DOES_NOT_ESTABLISH_HISTORY_RECOVERY'}
  ];
 const summary={PASS:0,FAIL:0,UNVERIFIED:0,total:checks.length};for(const check of checks)summary[check.status]++;
 return {kind:'ORANGEX_DOCUMENTED_STANDARDS_REVIEW',mode:'READ_ONLY',instrumentName:name,checkedAt:now,
  provenance:clone(provenance),inputObservationClass:synthetic?'SYNTHETIC_TEST_INPUT':replay?'HISTORICAL_REPLAY_INPUT':'SUPPLIED_OBSERVATION_NO_AUTOMATIC_ORIGIN_ATTESTATION',
  rawValueComparisonScope:'PROVIDED_NUMBERS_ONLY_NOT_RESPONSE_AUTHENTICATION',status:'NOT_READY',checks,summary,
  standardFees:{makerFraction:.0002,takerFraction:.0006,makerPercent:.02,takerPercent:.06,
   scope:'PUBLIC_STANDARD_ONLY',sourceId:'STANDARD_FEES_2026',updatedOn:'2026-09-16',
   observedRawMatches:observed?matching:null,effectiveAccountRates:null},
  feeSourceComparison:{currentSourceId:'STANDARD_FEES_2026',currentTakerFraction:.0006,
   legacySourceId:'LEGACY_FEES_2023',legacyTakerFraction:.0005,status:'DATED_OFFICIAL_DESCRIPTIONS_DIFFER',
   interpretation:'PRESERVE_BOTH_VERSIONED_SOURCES_DO_NOT_USE_LEGACY_OR_SELECT_AN_ACCOUNT_RATE_AUTOMATICALLY'},
  generalFunding:{sourceId:'FUNDING_GENERAL_2026',notionalBasis:'MARK_PRICE_TIMES_BASE_POSITION_QUANTITY',
   positiveRatePayer:'LONG',negativeRatePayer:'SHORT',onlyHeldAtSettlement:true,
   generalUtcHours:[0,8,16],generalTimingVariationMs:15000,
   intervalExceptionsHours:[1,4],currentSymbolIntervalMs:null,currentSymbolNextSettlementAt:null,currentSymbolRate:null,
   actualAccountSettlementHistoryVerified:false},
  actualFeeEstimate:null,actualFundingEstimate:null,activationAllowed:false,realDataAutoEntryEnabled:false,paperAutoEntryEnabled:false,liveOrdersEnabled:false,
  sources:clone(sources),note:'문서상 표준·일반 원리와 실제 상품/계정 적용을 구분합니다. 사용자 확인 공식 출처이며 에이전트가 원문을 독립 재수집한 증거는 아닙니다.'};
}
