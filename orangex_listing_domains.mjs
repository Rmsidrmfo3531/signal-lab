// currency is an exchange trading area, not a contract's settlement currency.
// These examples come from the user's official-document excerpt. They have not
// been independently verified against a live server in this cloud environment.
export const DOCUMENTED_LISTING_CURRENCIES=Object.freeze(['BTC','ETH','SPOT']);
const CATALOG=Object.freeze({
 BTC:Object.freeze({value:'BTC',classification:'DOCUMENTED_EXAMPLE',documentedExample:true,perpetualDomainCandidate:true}),
 ETH:Object.freeze({value:'ETH',classification:'DOCUMENTED_EXAMPLE',documentedExample:true,perpetualDomainCandidate:true}),
 SPOT:Object.freeze({value:'SPOT',classification:'DOCUMENTED_EXAMPLE',documentedExample:true,perpetualDomainCandidate:false}),
 PERPETUAL:Object.freeze({value:'PERPETUAL',classification:'UNVERIFIED_CANDIDATE',documentedExample:false,perpetualDomainCandidate:false}),
 USDT:Object.freeze({value:'USDT',classification:'LEGACY_UNSUPPORTED',documentedExample:false,perpetualDomainCandidate:false})
});
const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const positive=value=>typeof value==='number'&&Number.isFinite(value)&&value>0;
const NAME=/^[A-Z0-9]{2,20}-[A-Z0-9]{2,12}-PERPETUAL$/;
export function listingDomainInfo(value){return typeof value==='string'&&Object.hasOwn(CATALOG,value)?{...CATALOG[value]}:null}
export function normalizeListingCurrencies(values=DOCUMENTED_LISTING_CURRENCIES){
 if(!Array.isArray(values)||!values.length||values.length>5||values.some(value=>!listingDomainInfo(value)))throw Error('INVALID_LISTING_CURRENCIES');
 return [...new Set(values)];
}

// Input fields are already allowlisted observations. Never fill missing contract
// fields from another area silently, and never select an arbitrary conflicting row.
export function reconcileOrangeXListing(instrumentName,discoveries=[]){
 const matches=[];
 if(NAME.test(instrumentName))for(const discovery of discoveries){
  const info=listingDomainInfo(discovery?.currency);
  if(!info||discovery?.status!=='OBSERVED'||!Array.isArray(discovery.items))continue;
  for(const item of discovery.items){
   if(!plain(item)||item.instrument_name!==instrumentName)continue;
   matches.push({currency:info.value,classification:info.classification,perpetualDomainCandidate:info.perpetualDomainCandidate,
    active:typeof item.is_active==='boolean'?item.is_active:null,
    contractFields:plain(item.fields)?structuredClone(item.fields):{}});
  }
 }
 let conflict=false;
 for(let left=0;left<matches.length;left++)for(let right=left+1;right<matches.length;right++){
  const a=matches[left],b=matches[right];
  if(a.active!==null&&b.active!==null&&a.active!==b.active)conflict=true;
  for(const key of Object.keys(a.contractFields))if(Object.hasOwn(b.contractFields,key)&&
    !Object.is(a.contractFields[key]?.value,b.contractFields[key]?.value))conflict=true;
 }
 // Prefer a complete, positively active documented observation when an earlier
 // area omitted is_active. Choose one whole row; never merge its missing fields
 // from another area. Explicit contradictions still block all readiness.
 const selected=(!conflict?matches.find(match=>match.perpetualDomainCandidate&&match.active===true):null)??
  matches.find(match=>match.perpetualDomainCandidate)??matches[0];
 const active=conflict?null:selected?.active??null;
 return {listingObserved:matches.length>0,active,
  listingStatus:conflict?'OBSERVED_CONFLICT':active===true?'OBSERVED_ACTIVE':active===false?'OBSERVED_INACTIVE':selected?'OBSERVED_STATUS_UNKNOWN':'UNOBSERVED',
  actualInstrumentName:selected?instrumentName:null,listingSourceCurrency:selected?.currency??null,contractFields:selected?.contractFields??{},
  listingMatches:matches,listingConflict:conflict,
  listingDomainEligible:!conflict&&matches.some(match=>match.perpetualDomainCandidate&&match.active===true)};
}

// Inspect received levels before sorting or truncation. Repeated levels must
// never be added together as if they represented independently available size.
export function orangeXBookIntegrity(book,{requestedDepth=20}={}){
 const issues=[],bids=book?.bids,asks=book?.asks;
 for(const [rows,ascending]of [[bids,false],[asks,true]]){
  if(!Array.isArray(rows)||!rows.length||rows.length>10000){issues.push('BOOK_LEVELS_INVALID');continue}
  if(rows.length>requestedDepth)issues.push('BOOK_DEPTH_EXCEEDED');
  const seen=new Set();let previous=null;
  for(const row of rows){
   if(!Array.isArray(row)||row.length!==2||!positive(row[0])||!positive(row[1])){issues.push('BOOK_LEVELS_INVALID');continue}
   if(seen.has(row[0]))issues.push('BOOK_DUPLICATE_PRICE');
   if(previous!==null&&(ascending?row[0]<previous:row[0]>previous))issues.push('BOOK_UNSORTED');
   seen.add(row[0]);previous=row[0];
  }
 }
 return {valid:issues.length===0,issues:[...new Set(issues)],bidLevels:Array.isArray(bids)?bids.length:null,
  askLevels:Array.isArray(asks)?asks.length:null};
}

const fresh=(at,now,maxAgeMs)=>positive(at)&&at>=1e12&&at<=now+5000&&now-at<=maxAgeMs;
export function orangeXMarketReadiness(markets,{now=Date.now(),maxQuoteAgeMs=90000,expectedInstruments,publicDetailsEnabled=true}={}){
 const rows=Array.isArray(markets)?markets:[],names=Array.isArray(expectedInstruments)?expectedInstruments:
  rows.map(row=>row?.instrumentName).filter(name=>typeof name==='string');
 const checks=[...new Set(names)].map(instrumentName=>{
  const row=rows.find(item=>item?.instrumentName===instrumentName),reasons=[];
  if(!row)reasons.push('MARKET_UNOBSERVED');
  if(!publicDetailsEnabled)reasons.push('LISTING_NOT_REQUESTED');
  if(row?.listingObserved!==true)reasons.push('LISTING_UNOBSERVED');
  if(row?.active!==true)reasons.push(row?.active===false?'LISTING_INACTIVE':'LISTING_ACTIVE_UNKNOWN');
  if(row?.listingConflict===true)reasons.push('LISTING_CONFLICT');
  if(row?.listingDomainEligible!==true)reasons.push('LISTING_DOMAIN_UNVERIFIED');
  const book=row?.bookObserved!==false&&positive(row?.bid)&&positive(row?.ask)&&row.bid<row.ask;
  if(!book)reasons.push('BOOK_UNOBSERVED');
  const integrity=row?.bookIntegrity??(Array.isArray(row?.bids)||Array.isArray(row?.asks)?orangeXBookIntegrity(row):null);
  if(integrity?.valid===false)reasons.push('BOOK_INTEGRITY_FAILED',...(Array.isArray(integrity.issues)?integrity.issues:[]));
  if(!book||row?.fresh===false||!fresh(row?.priceAt,now,maxQuoteAgeMs))reasons.push('BOOK_STALE');
  if(!positive(row?.markPrice))reasons.push('MARK_UNOBSERVED');
  if(!positive(row?.markPrice)||row?.markPriceFresh===false||!fresh(row?.markPriceAt,now,maxQuoteAgeMs))reasons.push('MARK_STALE');
  if(row?.precision?.priceGrid==='MISMATCH')reasons.push('PRICE_GRID_MISMATCH');
  if(row?.precision?.quantityGrid==='MISMATCH')reasons.push('QUANTITY_GRID_MISMATCH');
  return {instrumentName,publicDataReady:reasons.length===0,reasons};
 });
 const publicDataReasons=[...new Set(checks.flatMap(check=>check.reasons))];
 if(!checks.length)publicDataReasons.push('PUBLIC_MARKETS_UNOBSERVED');
 return {publicDataReady:checks.length>0&&checks.every(check=>check.publicDataReady),
  // Public observations alone never verify execution units, fees or allow PAPER.
  ready:false,tradingReady:false,paperReady:false,
  publicDataReasons,blockingReasons:[...publicDataReasons,'CONTRACT_UNITS_UNVERIFIED','FEES_UNVERIFIED','PAPER_DISABLED','READ_ONLY_MODE'],
  markets:checks};
}
