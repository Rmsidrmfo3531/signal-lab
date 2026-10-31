// Pure READ_ONLY constraint review. No venue transport, sizing engine, store or
// execution permission. User-confirmed documentation distinguishes min_qty
// (minimum order quantity) from min_trade_amount (quantity increment). Runtime
// meaning/unit proofs must still match the supplied observations explicitly.
import {evaluateOrangeXReadiness} from './orangex_readiness.mjs';

const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const finite=value=>typeof value==='number'&&Number.isFinite(value);
const raw=(market,key)=>market?.contractFields?.[key]?.value;
const fail=code=>{throw Error(code)};
const power=scale=>10n**BigInt(scale);
function decimal(value){
 if(!(typeof value==='string'||finite(value)))return fail('INVALID_DECIMAL');
 const text=String(value);if(text.length>80||! /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(text))return fail('INVALID_DECIMAL');
 const [mantissa,exponentText='0']=text.toLowerCase().split('e'),exponent=Number(exponentText);
 if(!Number.isSafeInteger(exponent)||Math.abs(exponent)>30)return fail('DECIMAL_RANGE_UNSUPPORTED');
 const [whole,fraction='']=mantissa.split('.');if((whole+fraction).length>40)return fail('DECIMAL_RANGE_UNSUPPORTED');
 let units=BigInt((whole||'0')+fraction),scale=fraction.length-exponent;
 if(scale<0){units*=power(-scale);scale=0}
 while(scale>0&&units%10n===0n){units/=10n;scale--}
 return {units,scale};
}
function positiveDecimal(value){const result=decimal(value);if(result.units<=0n)return fail('POSITIVE_DECIMAL_REQUIRED');return result}
function format({units,scale}){
 if(units===0n)return '0';let digits=String(units);
 if(!scale)return digits;digits=digits.padStart(scale+1,'0');
 return (digits.slice(0,-scale)+'.'+digits.slice(-scale)).replace(/0+$/,'').replace(/\.$/,'');
}
function common(a,b){const scale=Math.max(a.scale,b.scale);return [a.units*power(scale-a.scale),b.units*power(scale-b.scale)]}
const compare=(a,b)=>{const [left,right]=common(a,b);return left<right?-1:left>right?1:0};
const multiply=(a,b)=>({units:a.units*b.units,scale:a.scale+b.scale});
const aligned=(value,step)=>{const [a,b]=common(value,step);return a%b===0n};

/** Exact decimal grid rounding; returns a string to avoid binary-float drift.
 * DOWN never increases an allowed quantity/price budget. This helper does not
 * establish an exchange unit or permit execution. */
export function roundOrangeXDecimal(value,step,rounding='DOWN'){
 if(!['DOWN','UP'].includes(rounding))return fail('INVALID_GRID_ROUNDING');
 const amount=positiveDecimal(value),grid=positiveDecimal(step),[a,b]=common(amount,grid);
 const count=a/b+(rounding==='UP'&&a%b!==0n?1n:0n);
 return format({units:grid.units*count,scale:grid.scale});
}
export function floorOrangeXQuantity(quantity,increment){return roundOrangeXDecimal(quantity,increment,'DOWN')}

/** Limit-price preservation differs from a conservative risk-plan scenario.
 * RISK_PLAN mirrors the existing synthetic bridge and requires risk to be
 * calculated again after rounding. It does not verify venue stop triggers. */
export function roundOrangeXPrice(price,tick,{purpose,direction,leg,side}={}){
 let rounding;
 if(purpose==='LIMIT_PRICE'&&['BUY','SELL'].includes(side))rounding=side==='BUY'?'DOWN':'UP';
 else if(purpose==='RISK_PLAN'&&['LONG','SHORT'].includes(direction)&&['ENTRY','STOP','TARGET'].includes(leg))
  rounding=direction==='LONG'?(leg==='STOP'?'DOWN':'UP'):(leg==='STOP'?'UP':'DOWN');
 else return fail('PRICE_ROUNDING_PURPOSE_REQUIRED');
 return {price:roundOrangeXDecimal(price,tick,rounding),rounding,purpose,
  riskMustBeRecalculated:purpose==='RISK_PLAN',exchangeStopTriggerVerified:false,
  executionAllowed:false,realDataAutoEntryEnabled:false,liveOrdersEnabled:false};
}

function reviewedLinearFormula(proof,market,now){
 const row=proof?.notionalFormula;
 if(!plain(row)||row.status===undefined||row.status==='UNVERIFIED')return {status:'UNVERIFIED',reason:'LINEAR_NOTIONAL_FORMULA_UNVERIFIED'};
 let url;try{url=new URL(row.officialDocumentURL)}catch{return {status:'FAIL',reason:'INVALID_NOTIONAL_FORMULA_REVIEW'}}
 if(row.status!=='VERIFIED'||url.protocol!=='https:'||url.hostname!=='openapi-docs.orangex.com'||
  (url.port&&url.port!=='443')||url.username||url.password||url.search||!Number.isSafeInteger(row.reviewedAt)||
  row.reviewedAt<1e12||row.reviewedAt>now)return {status:'FAIL',reason:'INVALID_NOTIONAL_FORMULA_REVIEW'};
 if(row.contractType!=='LINEAR_PERPETUAL'||row.priceCurrency!=='USDT'||row.notionalCurrency!=='USDT'||
  row.settlementCurrency!=='USDT'||!['CONTRACT','BASE_ASSET'].includes(row.quantityUnit)||
  row.quantityUnit!==proof?.quantityUnit?.value||!finite(row.contractSizeBase)||row.contractSizeBase!==raw(market,'contract_size'))
  return {status:'FAIL',reason:'NOTIONAL_FORMULA_DOES_NOT_MATCH_REVIEWED_UNITS'};
 return {status:'PASS',reason:'EXPLICIT_LINEAR_USDT_NOTIONAL_REVIEW'};
}

/** Review one proposed quantity against explicitly reviewed observations.
 * Conditions: q >= min_qty AND q / min_trade_amount is an integer, with a
 * reviewed price grid and a reviewed linear-USDT notional formula. Unreviewed
 * min_trade_amount is never treated as a default increment. Missing costs,
 * funding, fresh market data and full readiness are outside this review, so
 * the result always remains NOT_READY and never authorizes PAPER or LIVE. */
export function reviewOrangeXQuantity(market,{quantity,price,proof={},now=Date.now()}={}){
 const name=market?.instrumentName,report=evaluateOrangeXReadiness({mode:'READ_ONLY',markets:[market],
  operationalVerification:{schemaVersion:1,markets:typeof name==='string'?{[name]:proof}:{}}},{now});
 const ids=['CONTRACT_NAME','LISTING_ACTIVE','CONTRACT_SIZE','QUANTITY_UNIT','MINIMUM_QUANTITY','QUANTITY_INCREMENT','MIN_NOTIONAL','PRICE_TICK'],
  row=report.markets.find(item=>item.instrumentName===name),requirements=ids.map(id=>{
   const check=row?.checks.find(item=>item.id===id);return {id,status:check?.status??'UNVERIFIED',reason:check?.reason??'EXACT_CONTRACT_UNOBSERVED'};
  }),formula=reviewedLinearFormula(proof,market,now);
 requirements.push({id:'LINEAR_NOTIONAL_FORMULA',...formula});
 const synthetic=market?.syntheticTest===true||market?.executionMode==='SYNTHETIC_TEST'||
  ['SYNTHETIC_FIXTURE','SYNTHETIC_TEST','MOCK','MOCK_RESPONSE'].includes(market?.dataSource),
  historical=market?.executionMode==='HISTORICAL_REPLAY'||market?.runKind==='BACKTEST'||
   ['HISTORICAL_REPLAY','HISTORICAL_SNAPSHOT','BACKTEST'].includes(market?.dataSource);
 const result={kind:'ORANGEX_READ_ONLY_QUANTITY_REVIEW',mode:'READ_ONLY',status:'NOT_READY',
  source:synthetic?'SYNTHETIC_FIXTURE':historical?'HISTORICAL_REPLAY':'SUPPLIED_OBSERVATION_SOURCE_UNVERIFIED',
  constraintStatus:'UNVERIFIED',requirements,checks:[],quantity:null,price:null,notional:null,notionalCurrency:null,
  quantityRule:'q >= min_qty AND q / reviewed_increment is an integer; never increase q to satisfy minimums',
  executionAllowed:false,paperAutoEntryEnabled:false,realDataAutoEntryEnabled:false,liveOrdersEnabled:false,
  remainingExecutionBlockers:['FULL_OPERATIONAL_READINESS_NOT_EVALUATED','FEES_AND_FUNDING_NOT_EVALUATED','READ_ONLY_MODE']};
 if(requirements.some(check=>check.status==='FAIL')){result.constraintStatus='FAIL';return result}
 if(requirements.some(check=>check.status!=='PASS'))return result;
 if(quantity===undefined||quantity===null||price===undefined||price===null){result.checks.push({id:'PROPOSED_QUANTITY_PRICE',status:'UNVERIFIED',reason:'QUANTITY_OR_PRICE_UNOBSERVED'});return result}
 try{
  const q=positiveDecimal(quantity),p=positiveDecimal(price),minimum=positiveDecimal(raw(market,'min_qty')),
   field=proof.quantityIncrement.rawField,step=positiveDecimal(raw(market,field)),tick=positiveDecimal(raw(market,'tick_size')),
   size=positiveDecimal(raw(market,'contract_size')),minNotional=positiveDecimal(raw(market,'min_notional')),
   notional=multiply(multiply(q,p),proof.quantityUnit.value==='CONTRACT'?size:decimal(1));
  result.quantity=format(q);result.price=format(p);result.notional=format(notional);result.notionalCurrency='USDT';
  result.checks=[
   {id:'MINIMUM_QUANTITY',status:compare(q,minimum)>=0?'PASS':'FAIL',reason:'PROPOSED_QUANTITY_AT_LEAST_MIN_QTY'},
   {id:'QUANTITY_GRID',status:aligned(q,step)?'PASS':'FAIL',reason:'PROPOSED_QUANTITY_MULTIPLE_OF_REVIEWED_INCREMENT'},
   {id:'PRICE_GRID',status:aligned(p,tick)?'PASS':'FAIL',reason:'PROPOSED_PRICE_MULTIPLE_OF_REVIEWED_TICK'},
   {id:'MINIMUM_NOTIONAL',status:compare(notional,minNotional)>=0?'PASS':'FAIL',reason:'LINEAR_USDT_NOTIONAL_AT_LEAST_MINIMUM'}
  ];result.constraintStatus=result.checks.every(check=>check.status==='PASS')?'PASS':'FAIL';
 }catch{result.constraintStatus='FAIL';result.checks=[{id:'DECIMAL_INPUT',status:'FAIL',reason:'INVALID_OR_UNSUPPORTED_DECIMAL_INPUT'}]}
 return result;
}
