// Evidence evaluation only. No transport, store, credentials or mode mutation.
// Raw field observations are never promoted to verified trading units. A caller
// must supply separate, reviewed official-document proofs matching the values.
import {orangeXBookIntegrity} from './orangex_listing_domains.mjs';

const ASSETS=Object.freeze(['BTC','ETH','SOL']);
const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const finite=value=>typeof value==='number'&&Number.isFinite(value);
const positive=value=>finite(value)&&value>0;
const stamp=value=>Number.isSafeInteger(value)&&value>=1e12&&value<8640000000000000;
const has=(object,key)=>plain(object)&&Object.hasOwn(object,key);
const raw=(fields,key)=>has(fields,key)&&plain(fields[key])&&has(fields[key],'value')?fields[key].value:undefined;
const safeNumber=value=>finite(value)?value:null;
const digest=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const labels={EVIDENCE_FORMAT:'입력 자료 구조',READ_ONLY_CONTEXT:'조회 전용 상태',SOURCE_PROVENANCE:'실측 출처 검증',
 CONTRACT_NAME:'정확한 계약명',LISTING_ACTIVE:'상장·활성 상태',CONTRACT_SIZE:'계약 크기',QUANTITY_UNIT:'주문 수량 단위',
 MINIMUM_QUANTITY:'최소 주문량',QUANTITY_INCREMENT:'주문 수량 증분',MIN_NOTIONAL:'최소 명목금액',PRICE_TICK:'가격 단위',
 FEE_UNITS:'Maker·Taker 수수료 단위',FUNDING:'펀딩 정산 정보',TIMESTAMP_UNITS:'호가·Mark 시각 단위',
 BOOK_FRESHNESS:'호가 독립 신선도',MARK_FRESHNESS:'Mark 독립 신선도',BOOK_INTEGRITY:'호가 배열 무결성',
 PRICE_PRECISION:'관측 가격 정밀도',QUANTITY_PRECISION:'관측 잔량 정밀도',BINANCE_MAPPING:'Binance 계약 대응'};
const statusRow=(id,status,reason,observed={},extra={})=>({id,status,reason,label:labels[id]??'필수 조건',observed,...extra});
function officialURL(value){
 if(typeof value!=='string'||value.length>2048)return false;
 try{const url=new URL(value);return url.protocol==='https:'&&url.hostname==='openapi-docs.orangex.com'&&
  (!url.port||url.port==='443')&&!url.username&&!url.password&&!url.search}catch{return false}
}
function reviewed(proof,now){
 if(!plain(proof)||proof.status===undefined||proof.status==='UNVERIFIED')return {status:'UNVERIFIED',reason:'OFFICIAL_MEANING_UNVERIFIED'};
 if(proof.status==='REJECTED')return {status:'FAIL',reason:'OFFICIAL_REVIEW_REJECTED'};
 if(proof.status!=='VERIFIED'||!officialURL(proof.officialDocumentURL)||!stamp(proof.reviewedAt)||proof.reviewedAt>now)
  return {status:'FAIL',reason:'INVALID_OFFICIAL_REVIEW_PROOF'};
 return {status:'PASS',reason:'REVIEWED_OFFICIAL_EVIDENCE'};
}
const near=(a,b)=>finite(a)&&finite(b)&&Math.abs(a-b)<=Math.max(1e-12,Math.abs(a)*Number.EPSILON*8,Math.abs(b)*Number.EPSILON*8);
function grid(value,step){
 if(!positive(value)||!positive(step))return false;
 const units=value/step,nearest=Math.round(units);
 return Number.isSafeInteger(nearest)&&Math.abs(units-nearest)<=Math.min(1e-6,Math.max(1,Math.abs(units))*Number.EPSILON*16);
}
function numericReview(id,fields,field,proof,unit,now,{meaning}={}){
 const value=raw(fields,field),observed={rawField:field,rawValue:safeNumber(value)};
 if(value===undefined||value===null)return statusRow(id,'UNVERIFIED','REQUIRED_FIELD_UNOBSERVED',observed);
 if(!positive(value))return statusRow(id,'FAIL','INVALID_POSITIVE_FIELD',observed);
 if(typeof unit!=='string'||!unit)return statusRow(id,'UNVERIFIED','REQUIRED_UNIT_UNVERIFIED',observed);
 const review=reviewed(proof,now);
 if(review.status!=='PASS')return statusRow(id,review.status,review.reason,observed);
 if(proof.rawField!==field||!near(proof.value,value)||proof.unit!==unit||meaning&&proof.meaning!==meaning)
  return statusRow(id,'FAIL','REVIEW_DOES_NOT_MATCH_OBSERVATION',observed);
 return statusRow(id,'PASS','REVIEWED_FIELD_AND_UNIT_MATCH',observed);
}
function clockCheck(id,value,now,maxAgeMs,{price}={}){
 const observed={timestamp:stamp(value)?value:null,ageMs:stamp(value)?now-value:null,price:safeNumber(price)};
 if(value===null||value===undefined||price===null||price===undefined)return statusRow(id,'UNVERIFIED','INDEPENDENT_PRICE_OR_CLOCK_UNOBSERVED',observed);
 if(!positive(price)||!stamp(value))return statusRow(id,'FAIL','INVALID_PRICE_OR_TIMESTAMP',observed);
 if(value>now)return statusRow(id,'FAIL','SOURCE_TIMESTAMP_IN_FUTURE',observed);
 if(now-value>maxAgeMs)return statusRow(id,'FAIL','SOURCE_TIMESTAMP_STALE',observed);
 return statusRow(id,'PASS','INDEPENDENT_SOURCE_CLOCK_FRESH',observed);
}
function isSynthetic(input){
 const tagged=value=>plain(value)&&(value.syntheticTest===true||value.executionMode==='SYNTHETIC_TEST'||
  ['SYNTHETIC_TEST','SYNTHETIC_FIXTURE','MOCK','MOCK_RESPONSE','SYNTHETIC'].includes(value.dataSource)||value.kind==='MOCK_ORANGEX_DIAGNOSTIC');
 return tagged(input)||(Array.isArray(input.markets)?input.markets.slice(0,1000):[]).some(row=>
  tagged(row)||tagged(row?.book)||tagged(row?.fundingObservation)||tagged(row?.binanceObservation));
}
function provenance(input,verification,now){
 if(isSynthetic(input))return statusRow('SOURCE_PROVENANCE','FAIL','SYNTHETIC_DATA_CANNOT_VERIFY_OPERATIONAL_READINESS',{synthetic:true});
 const proof=verification?.provenance,review=reviewed(proof,now);
 if(review.status!=='PASS')return statusRow('SOURCE_PROVENANCE',review.status,'RESPONSE_ORIGIN_UNVERIFIED',{synthetic:false});
 if(!['REAL_PUBLIC_API_RESPONSE','REAL_PUBLIC_OBSERVATION_SUMMARY','REAL_PUBLIC_READ_ONLY'].includes(input.dataSource)||
  proof.responseOrigin!=='ORANGEX'||proof.observationType!=='PUBLIC_API'||!stamp(proof.observedAt)||proof.observedAt>now||proof.reviewedAt<proof.observedAt||
  !digest(input.sourceEvidenceSHA256)||proof.sourceEvidenceSHA256!==input.sourceEvidenceSHA256)
  return statusRow('SOURCE_PROVENANCE','FAIL','ORIGIN_PROOF_DOES_NOT_MATCH_SOURCE_ARTIFACT',{synthetic:false});
 return statusRow('SOURCE_PROVENANCE','PASS','EXPLICIT_ORIGIN_REVIEW_MATCHES_ARTIFACT',{synthetic:false});
}

/** Optional proof envelope:
 * operationalVerification:{schemaVersion:1,provenance:{status:'VERIFIED',
 * officialDocumentURL,reviewedAt,responseOrigin:'ORANGEX',observationType:'PUBLIC_API',
 * observedAt,sourceEvidenceSHA256},markets:{[instrumentName]:{listing,contractSize,
 * quantityUnit,minimumQuantity,quantityIncrement,minNotional,priceTick,fees,funding,
 * timestampUnits,binanceMapping}}}.
 * Every section has the same status/officialDocumentURL/reviewedAt review header.
 * A digest binds a reviewed artifact; it does not by itself prove its origin.
 * This evaluator reports the supplied review evidence and never grants approval.
 */
export function evaluateOrangeXReadiness(evidence={}, {now=Date.now(),maxQuoteAgeMs=90000}={}){
 if(!stamp(now)||!Number.isSafeInteger(maxQuoteAgeMs)||maxQuoteAgeMs<1||maxQuoteAgeMs>90000)throw Error('INVALID_READINESS_OPTIONS');
 const input=plain(evidence)?evidence:{},formatValid=plain(evidence)&&Array.isArray(input.markets)&&input.markets.length<=1000,
  rows=formatValid?input.markets:[],verification=plain(input.operationalVerification)&&input.operationalVerification.schemaVersion===1?input.operationalVerification:null;
 const readOnly=input.mode==='READ_ONLY'&&['orderSubmissionEnabled','ordersSubmitted','liveOrdersEnabled','realDataAutoEntryEnabled','paperAutoEntryEnabled','paperEnabled'].every(key=>input[key]!==true);
 const checks=[statusRow('EVIDENCE_FORMAT',formatValid?'PASS':'FAIL',formatValid?'NORMALIZED_PUBLIC_OBSERVATIONS':'PUBLIC_OBSERVATIONS_UNAVAILABLE'),
  statusRow('READ_ONLY_CONTEXT',readOnly?'PASS':'FAIL',readOnly?'READ_ONLY_REPORTED':'READ_ONLY_CONTEXT_NOT_ESTABLISHED'),
  provenance(input,verification,now)];
 const markets=ASSETS.map(asset=>{
  const instrumentName=asset+'-USDT-PERPETUAL',matches=rows.filter(row=>row?.instrumentName===instrumentName),market=matches.length===1?matches[0]:{},
   fields=plain(market.contractFields)?market.contractFields:{},proof=verification?.markets?.[instrumentName]??{},local=[],
   book=plain(market.book)?market.book:market,
   bids=Array.isArray(book.bids)?book.bids:null,asks=Array.isArray(book.asks)?book.asks:null,
   bestBid=Array.isArray(bids?.[0])?bids[0][0]:market.bid,bestAsk=Array.isArray(asks?.[0])?asks[0][0]:market.ask,
   bookAt=plain(market.book)?market.book.timestamp:market.priceAt,
   mark=market.markPrice,markAt=market.markPriceTimestamp??market.markPriceAt;
  const add=row=>{local.push({...row,asset,instrumentName});return row};
  const listingReview=reviewed(proof.listing,now);
  if(matches.length>1)add(statusRow('CONTRACT_NAME','FAIL','DUPLICATE_CONTRACT_OBSERVATIONS'));
  else if(matches.length===0)add(statusRow('CONTRACT_NAME','UNVERIFIED','EXACT_CONTRACT_UNOBSERVED'));
  else if(market.actualInstrumentName!==undefined&&market.actualInstrumentName!==null&&market.actualInstrumentName!==instrumentName)
   add(statusRow('CONTRACT_NAME','FAIL','ACTUAL_CONTRACT_NAME_MISMATCH'));
  else if(market.listingObserved!==true)add(statusRow('CONTRACT_NAME','UNVERIFIED','REQUEST_CANDIDATE_IS_NOT_LISTING_VERIFICATION'));
  else if(listingReview.status!=='PASS')add(statusRow('CONTRACT_NAME',listingReview.status,listingReview.reason));
  else if(proof.listing.instrumentName!==instrumentName)add(statusRow('CONTRACT_NAME','FAIL','REVIEW_CONTRACT_NAME_MISMATCH'));
  else add(statusRow('CONTRACT_NAME','PASS','EXACT_REVIEWED_CONTRACT_MATCH'));
  if(raw(fields,'kind')!==undefined&&raw(fields,'kind')!=='perpetual'&&raw(fields,'kind')!=='PERPETUAL')add(statusRow('LISTING_ACTIVE','FAIL','CONTRACT_KIND_MISMATCH'));
  else if(market.listingConflict===true||market.active===false)add(statusRow('LISTING_ACTIVE','FAIL',market.active===false?'LISTED_CONTRACT_INACTIVE':'CONFLICTING_LISTING_OBSERVATIONS'));
  else if(market.listingObserved!==true||market.active!==true)add(statusRow('LISTING_ACTIVE','UNVERIFIED','ACTIVE_LISTING_UNOBSERVED'));
  else if(listingReview.status!=='PASS')add(statusRow('LISTING_ACTIVE',listingReview.status,listingReview.reason));
  else if(proof.listing.active!==true||proof.listing.kind!=='PERPETUAL'||typeof proof.listing.tradingArea!=='string'||
   proof.listing.tradingArea!==market.listingSourceCurrency||market.listingDomainEligible!==true)
   add(statusRow('LISTING_ACTIVE','UNVERIFIED','TRADING_AREA_AND_PERPETUAL_ROLE_UNVERIFIED'));
  else add(statusRow('LISTING_ACTIVE','PASS','ACTIVE_PERPETUAL_LISTING_REVIEWED'));

  add(numericReview('CONTRACT_SIZE',fields,'contract_size',proof.contractSize,'BASE_PER_CONTRACT',now));
  const unitReview=reviewed(proof.quantityUnit,now),quantityUnit=proof.quantityUnit?.value;
  add(statusRow('QUANTITY_UNIT',unitReview.status!=='PASS'?unitReview.status:['CONTRACT','BASE_ASSET'].includes(quantityUnit)?'PASS':'FAIL',
   unitReview.status!=='PASS'?unitReview.reason:['CONTRACT','BASE_ASSET'].includes(quantityUnit)?'EXPLICIT_QUANTITY_MEANING_REVIEWED':'UNSUPPORTED_QUANTITY_MEANING',
   {unit:['CONTRACT','BASE_ASSET'].includes(quantityUnit)?quantityUnit:null}));
  const minimumField=['min_qty','min_trade_amount'].includes(proof.minimumQuantity?.rawField)?proof.minimumQuantity.rawField:'min_qty';
  const minimum=numericReview('MINIMUM_QUANTITY',fields,minimumField,proof.minimumQuantity,quantityUnit,now,{meaning:'MINIMUM_ORDER_QUANTITY'});
  minimum.observed.minTradeAmount=safeNumber(raw(fields,'min_trade_amount'));minimum.observed.minQty=safeNumber(raw(fields,'min_qty'));add(minimum);
  const increments=['qty_step','quantity_step','quantity_increment','lot_size'],stepField=increments.includes(proof.quantityIncrement?.rawField)?proof.quantityIncrement.rawField:'qty_step',
   observedIncrements=increments.map(key=>raw(fields,key)).filter(value=>value!==undefined&&value!==null);
  const increment=numericReview('QUANTITY_INCREMENT',fields,stepField,proof.quantityIncrement,quantityUnit,now,{meaning:'ORDER_QUANTITY_INCREMENT'});
  if(observedIncrements.some(value=>!positive(value))||new Set(observedIncrements).size>1){increment.status='FAIL';increment.reason='CONFLICTING_OR_INVALID_QUANTITY_INCREMENT_FIELDS'}
  add(increment);
  add(numericReview('MIN_NOTIONAL',fields,'min_notional',proof.minNotional,'USDT',now));
  const tick=add(numericReview('PRICE_TICK',fields,'tick_size',proof.priceTick,'USDT',now));

  const feeProof=proof.fees,feeReview=reviewed(feeProof,now),feeFields=['maker_commission','maker_fee','maker_fee_rate','maker'],takerFields=['taker_commission','taker_fee','taker_fee_rate','taker'];
  const makerField=feeFields.includes(feeProof?.makerField)?feeProof.makerField:'maker_commission',
   takerField=takerFields.includes(feeProof?.takerField)?feeProof.takerField:'taker_commission',maker=raw(fields,makerField),taker=raw(fields,takerField),
   feeObserved={makerRaw:safeNumber(maker),takerRaw:safeNumber(taker),unit:['FRACTION','PERCENT','BPS'].includes(feeProof?.unit)?feeProof.unit:null};
  if(maker===undefined||maker===null||taker===undefined||taker===null)add(statusRow('FEE_UNITS','UNVERIFIED','MAKER_TAKER_RAW_FIELDS_UNOBSERVED',feeObserved));
  else if(!finite(maker)||!finite(taker))add(statusRow('FEE_UNITS','FAIL','INVALID_FEE_OBSERVATION',feeObserved));
  else if(feeReview.status!=='PASS')add(statusRow('FEE_UNITS',feeReview.status,feeReview.reason,feeObserved));
  else if(!feeObserved.unit||feeProof.makerField!==makerField||feeProof.takerField!==takerField||!near(feeProof.makerRaw,maker)||!near(feeProof.takerRaw,taker))
   add(statusRow('FEE_UNITS','FAIL','FEE_UNIT_REVIEW_DOES_NOT_MATCH_RAW_VALUES',feeObserved));
  else add(statusRow('FEE_UNITS','PASS','FEE_RAW_VALUES_AND_UNIT_REVIEWED',feeObserved));

  const funding=market.fundingObservation,fp=proof.funding,fr=reviewed(fp,now);
  if(!plain(funding))add(statusRow('FUNDING','UNVERIFIED','FUNDING_OBSERVATION_UNAVAILABLE'));
  else if(!finite(funding.rate)||!Number.isSafeInteger(funding.intervalMs)||funding.intervalMs<=0||!stamp(funding.settlementAnchorAt)||!stamp(funding.observedAt)||funding.observedAt>now)
   add(statusRow('FUNDING','FAIL','INVALID_FUNDING_OBSERVATION'));
  else if(now-funding.observedAt>maxQuoteAgeMs)add(statusRow('FUNDING','FAIL','FUNDING_OBSERVATION_STALE'));
  else if(fr.status!=='PASS')add(statusRow('FUNDING',fr.status,fr.reason));
  else if(!near(fp.rate,funding.rate)||fp.intervalMs!==funding.intervalMs||fp.settlementAnchorAt!==funding.settlementAnchorAt||
   !['FRACTION','PERCENT','BPS'].includes(fp.rateUnit)||!['LONG_PAYS_SHORT','SHORT_PAYS_LONG'].includes(fp.positiveRateMeaning))
   add(statusRow('FUNDING','FAIL','FUNDING_SCHEDULE_UNIT_OR_SIGN_UNVERIFIED'));
  else add(statusRow('FUNDING','PASS','OBSERVED_FUNDING_SCHEDULE_AND_MEANING_REVIEWED',
   {rate:funding.rate,intervalMs:funding.intervalMs,settlementAnchorAt:funding.settlementAnchorAt}));
  const timeReview=reviewed(proof.timestampUnits,now);
  add(statusRow('TIMESTAMP_UNITS',timeReview.status!=='PASS'?timeReview.status:
   proof.timestampUnits.book==='MILLISECONDS'&&proof.timestampUnits.mark==='MILLISECONDS'?'PASS':'FAIL',
   timeReview.status!=='PASS'?timeReview.reason:proof.timestampUnits.book==='MILLISECONDS'&&proof.timestampUnits.mark==='MILLISECONDS'?'SOURCE_TIME_UNITS_REVIEWED':'SOURCE_TIME_UNITS_NOT_SUPPORTED'));
  add(clockCheck('BOOK_FRESHNESS',bookAt,now,maxQuoteAgeMs,{price:positive(bestBid)&&positive(bestAsk)?(bestBid+bestAsk)/2:null}));
  add(clockCheck('MARK_FRESHNESS',markAt,now,maxQuoteAgeMs,{price:mark}));
  const integrity=orangeXBookIntegrity({bids,asks}),bookPresent=Array.isArray(bids)&&Array.isArray(asks),
   crossed=bookPresent&&positive(bestBid)&&positive(bestAsk)&&bestBid>=bestAsk;
  add(statusRow('BOOK_INTEGRITY',!bookPresent?'UNVERIFIED':!integrity.valid||crossed?'FAIL':'PASS',
   !bookPresent?'BOOK_DEPTH_UNOBSERVED':crossed?'BOOK_CROSSED':!integrity.valid?'BOOK_ARRAY_INVALID':'OBSERVED_DEPTH_SORTED_UNIQUE_AND_POSITIVE',
   {bidLevels:integrity.bidLevels,askLevels:integrity.askLevels,issues:integrity.issues}));
  const levels=bookPresent?[...bids,...asks]:[],validLevel=level=>Array.isArray(level)&&level.length===2&&positive(level[0])&&positive(level[1]);
  for(const [id,column,condition,step]of [['PRICE_PRECISION',0,tick,raw(fields,'tick_size')],['QUANTITY_PRECISION',1,increment,raw(fields,stepField)]]){
   const observed=levels.length>0&&levels.every(validLevel);
   add(statusRow(id,!observed||condition.status!=='PASS'?'UNVERIFIED':levels.every(level=>grid(level[column],step))?'PASS':'FAIL',
    !observed?'DEPTH_GRID_UNOBSERVED':condition.status!=='PASS'?'OFFICIAL_GRID_UNIT_UNVERIFIED':levels.every(level=>grid(level[column],step))?'OBSERVED_LEVELS_ALIGN_WITH_REVIEWED_GRID':'OBSERVED_LEVELS_MISMATCH_REVIEWED_GRID'));
  }

  const mapping=proof.binanceMapping,mr=reviewed(mapping,now),comparison=plain(market.binanceObservation)?market.binanceObservation:market.binanceComparison,
   symbol=comparison?.symbol??comparison?.referenceSymbol,price=comparison?.price,priceAt=comparison?.timestamp??comparison?.priceAt,
   base=raw(fields,'base_currency'),quote=raw(fields,'quote_currency'),meanings=mapping?.exchangeCurrencyDefinitions,
   expected={UNDERLYING_ASSET:asset,QUOTE_ASSET:'USDT',SETTLEMENT_ASSET:'USDT'},
   observed={referenceSymbol:symbol===asset+'USDT'?symbol:null,price:safeNumber(price),timestamp:stamp(priceAt)?priceAt:null};
  if(!plain(comparison))add(statusRow('BINANCE_MAPPING','UNVERIFIED','BINANCE_REFERENCE_UNOBSERVED',observed));
  else if(symbol!==asset+'USDT'||!positive(price)||!stamp(priceAt)||priceAt>now||now-priceAt>maxQuoteAgeMs)
   add(statusRow('BINANCE_MAPPING','FAIL','BINANCE_SYMBOL_PRICE_OR_CLOCK_INVALID',observed));
  else if(mr.status!=='PASS')add(statusRow('BINANCE_MAPPING',mr.status,mr.reason,observed));
  else if(!plain(meanings)||base===undefined||quote===undefined||
   !(comparison.dataSource==='BINANCE_PUBLIC_API'||comparison.source==='BINANCE_PUBLIC_API'))
   add(statusRow('BINANCE_MAPPING','UNVERIFIED','CURRENCY_DEFINITIONS_AND_REFERENCE_SOURCE_UNVERIFIED',observed));
  else if(mapping.instrumentName!==instrumentName||mapping.binanceSymbol!==symbol||mapping.baseAsset!==asset||mapping.quoteAsset!=='USDT'||
   mapping.settlementAsset!=='USDT'||mapping.contractType!=='LINEAR_PERPETUAL'||!near(mapping.contractSizeBase,raw(fields,'contract_size'))||
   !Object.hasOwn(expected,meanings.base_currency)||!Object.hasOwn(expected,meanings.quote_currency)||
   base!==expected[meanings.base_currency]||quote!==expected[meanings.quote_currency])
   add(statusRow('BINANCE_MAPPING','FAIL','REVIEWED_CONTRACT_MAPPING_CONTRADICTS_OBSERVATIONS',observed));
  else add(statusRow('BINANCE_MAPPING','PASS','REVIEWED_LINEAR_CONTRACT_AND_FRESH_REFERENCE_MATCH',observed));
  checks.push(...local);
  return {asset,instrumentName,status:local.every(check=>check.status==='PASS')&&checks.slice(0,3).every(check=>check.status==='PASS')?'READY':'NOT_READY',checks:local};
 });
 const summary={PASS:0,FAIL:0,UNVERIFIED:0,total:checks.length};for(const check of checks)summary[check.status]++;
 return {kind:'ORANGEX_OPERATIONAL_READINESS',scope:'MARKET_DATA_PRECONDITIONS_ONLY',mode:'READ_ONLY',status:checks.every(check=>check.status==='PASS')?'READY':'NOT_READY',
  checkedAt:now,checks,markets,summary,requiredChecks:Object.keys(labels),
  activationAllowed:false,realDataAutoEntryEnabled:false,liveOrdersEnabled:false,orderSubmissionEnabled:false,
  note:'상태 보고 전용입니다. PASS는 제공한 관측·검토 근거의 평가이며 자동매매 승인이나 실제 체결 보장이 아닙니다. 하나라도 미확인·실패이면 NOT_READY입니다.'};
}
