// Price-by-price traded volume only. Candles and tickers cannot supply a profile.
// Provenance is a caller declaration, never an exchange-origin attestation.
const finite=x=>typeof x==='number'&&Number.isFinite(x);
const positive=x=>finite(x)&&x>0;
const stamp=x=>Number.isSafeInteger(x)&&x>=1e12&&x<8640000000000000;
const plain=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const SOURCES=new Set(['REAL_BINANCE_AGG_TRADES','SYNTHETIC_TEST']);
const MAX_TRADES=100000,MAX_BINS=4096;
function decimal(value){
 if(!(typeof value==='string'||finite(value)))throw Error('INVALID_DECIMAL');
 const text=String(value);if(text.length>80||! /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(text))throw Error('INVALID_DECIMAL');
 const [mantissa,exponentText='0']=text.toLowerCase().split('e'),exponent=Number(exponentText),[whole,fraction='']=mantissa.split('.');
 if(!Number.isSafeInteger(exponent)||Math.abs(exponent)>30||(whole+fraction).length>40)throw Error('DECIMAL_RANGE');
 let units=BigInt((whole||'0')+fraction),scale=fraction.length-exponent;
 if(scale<0){units*=10n**BigInt(-scale);scale=0}
 while(scale>0&&units%10n===0n){units/=10n;scale--}
 return {units,scale};
}
function common(a,b){const s=Math.max(a.scale,b.scale);return [a.units*10n**BigInt(s-a.scale),b.units*10n**BigInt(s-b.scale)]}
function format({units,scale}){if(units===0n)return '0';const digits=String(units).padStart(scale+1,'0');return scale?(digits.slice(0,-scale)+'.'+digits.slice(-scale)).replace(/0+$/,'').replace(/\.$/,''):digits}
export function quantizeVolumeStep(value,step,direction='DOWN'){
 if(!['DOWN','UP'].includes(direction))throw Error('INVALID_ROUNDING');
 const a=decimal(value),b=decimal(step);if(a.units<=0n||b.units<=0n)throw Error('NON_POSITIVE_DECIMAL');
 const [left,right]=common(a,b),count=left/right+(direction==='UP'&&left%right!==0n?1n:0n);
 return Number(format({units:b.units*count,scale:b.scale}));
}
export function isVolumeStepAligned(value,step){
 try{const a=decimal(value),b=decimal(step),[left,right]=common(a,b);return a.units>0n&&b.units>0n&&left%right===0n}catch{return false}
}
export function splitVolumeQuantity(quantity,step){
 const q=decimal(quantity),s=decimal(step),[left,right]=common(q,s);
 if(left<=0n||right<=0n||left%right!==0n)throw Error('QUANTITY_OFF_GRID');
 const count=left/right,percentages=[40n,35n,25n];
 if(percentages.some(percent=>count*percent%100n!==0n))throw Error('EXACT_SPLIT_OFF_GRID');
 return percentages.map(percent=>Number(format({units:s.units*(count*percent/100n),scale:s.scale})));
}
function tickCount(value,tick){const a=decimal(value),b=decimal(tick),[left,right]=common(a,b);if(left<=0n||right<=0n||left%right!==0n)throw Error('TRADE_PRICE_OFF_TICK');return left/right}
const fail=(reasons,evidence={})=>({ok:false,code:'TP_PROFILE_UNAVAILABLE',profile:null,evidence,reasons:[...new Set(reasons)],fixedRRReplacementEnabled:false,executionApproved:false});

/** coverage declares a bounded, fully paginated public trade interval. Temporal
 * trade span and ID continuity are checked too; neither proves remote origin.
 * Thresholds are explicit model settings, not proven predictive accuracy. */
export function buildVolumeProfile(input={},options={}){
 const {now=Date.now(),maxAgeMs=90000,minTrades=30,minWindowMs=60000,minCoverageRatio=.8,valueAreaFraction=.7,hvnMinFractionOfPoc=.1}=options,
  {symbol,trades,windowStart,windowEnd,receivedAt,tickSize,bucketTicks=10,dataSource,coverage}=input??{},
  evidence={symbol:typeof symbol==='string'&&/^[A-Z0-9]{2,24}USDT$/.test(symbol)?symbol:null,dataSource:SOURCES.has(dataSource)?dataSource:'UNVERIFIED',
   windowStart:stamp(windowStart)?windowStart:null,windowEnd:stamp(windowEnd)?windowEnd:null,receivedAt:stamp(receivedAt)?receivedAt:null,
   generatedAt:stamp(now)?now:null,coverage:{complete:coverage?.complete===true,ratio:null,pages:Number.isSafeInteger(coverage?.pages)?coverage.pages:null,truncated:coverage?.truncated===true},
   uniqueTrades:0,duplicateTrades:0,tradeCount:Array.isArray(trades)?trades.length:null,originIndependentlyVerified:false,
   methodology:'BINANCE_AGG_TRADES_PRICE_BUCKET_BASE_VOLUME',version:'TRADED_VOLUME_PROFILE_V1',
   historicalReplay:input?.executionMode==='HISTORICAL_REPLAY'||input?.runKind==='BACKTEST'};
 if(!stamp(now)||!Number.isSafeInteger(maxAgeMs)||maxAgeMs<1||maxAgeMs>90000||!Number.isSafeInteger(minTrades)||minTrades<3||minTrades>MAX_TRADES||
  !Number.isSafeInteger(minWindowMs)||minWindowMs<1||!finite(minCoverageRatio)||minCoverageRatio<=0||minCoverageRatio>1||
  !finite(valueAreaFraction)||valueAreaFraction<=0||valueAreaFraction>1||!finite(hvnMinFractionOfPoc)||hvnMinFractionOfPoc<=0||hvnMinFractionOfPoc>1)
  return fail(['PROFILE_SETTINGS_INVALID'],evidence);
 if(!evidence.symbol||!SOURCES.has(dataSource))return fail(['PROFILE_SYMBOL_OR_SOURCE_UNVERIFIED'],evidence);
 if(!stamp(windowStart)||!stamp(windowEnd)||windowStart>=windowEnd||windowEnd-windowStart<minWindowMs||windowEnd-windowStart>7*86400000||
  !stamp(receivedAt)||receivedAt<windowEnd||receivedAt>now||windowEnd>now)return fail(['PROFILE_WINDOW_OR_CLOCK_INVALID'],evidence);
 if(now-receivedAt>maxAgeMs||now-windowEnd>maxAgeMs)return fail(['PROFILE_STALE'],evidence);
 if(!plain(coverage)||coverage.complete!==true||coverage.truncated!==false||!stamp(coverage.fromTime)||!stamp(coverage.toTime)||
  coverage.fromTime>windowStart||coverage.toTime<windowEnd||coverage.toTime>receivedAt||!Number.isSafeInteger(coverage.pages)||coverage.pages<1||coverage.pages>100)
  return fail(['PROFILE_COVERAGE_INCOMPLETE'],evidence);
 if(!positive(Number(tickSize))||!Number.isSafeInteger(bucketTicks)||bucketTicks<1||bucketTicks>1000000)return fail(['PROFILE_PRICE_GRID_INVALID'],evidence);
 if(!Array.isArray(trades)||trades.length>MAX_TRADES||trades.length<minTrades)return fail(['PROFILE_TRADES_INSUFFICIENT_OR_UNBOUNDED'],evidence);
 const synthetic=row=>row?.syntheticTest===true||['SYNTHETIC_TEST','SYNTHETIC_FIXTURE','MOCK','MOCK_RESPONSE'].includes(row?.dataSource)||row?.executionMode==='SYNTHETIC_TEST';
 if(dataSource==='REAL_BINANCE_AGG_TRADES'&&(synthetic(input)||trades.some(synthetic)))return fail(['SYNTHETIC_TRADES_CANNOT_BE_LABELED_REAL'],evidence);
 const seen=new Map(),rows=[];let previousId=null,previousTime=null;
 for(const raw of trades){
  if(!plain(raw)||!Number.isSafeInteger(raw.a)||raw.a<0||!stamp(raw.T))return fail(['AGG_TRADE_SCHEMA_INVALID'],evidence);
  let p,q,ticks;try{p=Number(raw.p);decimal(raw.q);q=Number(raw.q);ticks=tickCount(raw.p,tickSize)}catch{return fail(['AGG_TRADE_PRICE_OR_GRID_INVALID'],evidence)}
  if(!positive(p)||!positive(q)||!positive(p*q)||raw.T<windowStart||raw.T>windowEnd||raw.T>now)return fail(['AGG_TRADE_VALUE_OR_TIME_INVALID'],evidence);
  const prior=seen.get(raw.a);
  if(prior){if(prior.p!==p||prior.q!==q||prior.T!==raw.T)return fail(['AGG_TRADE_DUPLICATE_CONFLICT'],evidence);evidence.duplicateTrades++;continue}
  if(previousId!==null&&raw.a!==previousId+1)return fail(['AGG_TRADE_SEQUENCE_GAP_OR_REGRESSION'],evidence);
  if(previousTime!==null&&raw.T<previousTime)return fail(['AGG_TRADE_TIME_REGRESSION'],evidence);
  const row={a:raw.a,p,q,T:raw.T,ticks};seen.set(raw.a,row);rows.push(row);previousId=raw.a;previousTime=raw.T;
 }
 evidence.uniqueTrades=rows.length;
 if(rows.length<minTrades)return fail(['PROFILE_UNIQUE_TRADES_INSUFFICIENT'],evidence);
 evidence.coverage.ratio=(rows.at(-1).T-rows[0].T)/(windowEnd-windowStart);
 if(evidence.coverage.ratio<minCoverageRatio)return fail(['PROFILE_TEMPORAL_COVERAGE_INSUFFICIENT'],evidence);
 if(now-rows.at(-1).T>maxAgeMs)return fail(['PROFILE_LAST_TRADE_STALE'],evidence);
 const groups=new Map(),width=BigInt(bucketTicks);let totalVolume=0,totalQuoteVolume=0;
 for(const row of rows){const index=row.ticks/width,key=index.toString(),bin=groups.get(key)??{index,volume:0,quoteVolume:0,trades:0};
  bin.volume+=row.q;bin.quoteVolume+=row.q*row.p;bin.trades++;groups.set(key,bin);totalVolume+=row.q;totalQuoteVolume+=row.q*row.p;
  if(!positive(bin.volume)||!positive(bin.quoteVolume)||!positive(totalVolume)||!positive(totalQuoteVolume))return fail(['PROFILE_VOLUME_OVERFLOW'],evidence);
 }
 const indices=[...groups.values()].map(row=>row.index).sort((a,b)=>a<b?-1:a>b?1:0),first=indices[0],last=indices.at(-1);
 if(last-first+1n>BigInt(MAX_BINS))return fail(['PROFILE_PRICE_RANGE_TOO_WIDE'],evidence);
 const tick=Number(tickSize),tickDecimal=decimal(tickSize),bins=[],priceForTicks=ticks=>Number(format({units:tickDecimal.units*ticks,scale:tickDecimal.scale}));
 for(let index=first;index<=last;index++){
  const raw=groups.get(index.toString()),lowTicks=index*width>0n?index*width:1n,highTicks=index*width+width-1n,
   low=priceForTicks(lowTicks),high=priceForTicks(highTicks);
  if(!positive(low)||!positive(high)||!Number.isSafeInteger(Number(highTicks)))return fail(['PROFILE_PRICE_RANGE_UNSUPPORTED'],evidence);
  bins.push({index:Number(index),priceLow:low,priceHigh:high,price:priceForTicks(lowTicks+(highTicks-lowTicks)/2n),
   volume:raw?.volume??0,quoteVolume:raw?.quoteVolume??0,trades:raw?.trades??0});
 }
 let pocIndex=0;for(let i=1;i<bins.length;i++)if(bins[i].volume>bins[pocIndex].volume)pocIndex=i;
 const poc={...bins[pocIndex]},hvn=[],threshold=poc.volume*hvnMinFractionOfPoc;
 for(let i=0;i<bins.length;){let end=i;while(end+1<bins.length&&bins[end+1].volume===bins[i].volume)end++;
  const v=bins[i].volume,left=bins[i-1]?.volume??0,right=bins[end+1]?.volume??0;
  if(v>0&&v>=threshold&&v>=left&&v>=right&&(v>left||v>right))hvn.push({priceLow:bins[i].priceLow,priceHigh:bins[end].priceHigh,
   price:i<=pocIndex&&pocIndex<=end?poc.price:bins[i].price,volume:bins.slice(i,end+1).reduce((sum,row)=>sum+row.volume,0),
   peakVolume:v,fromIndex:bins[i].index,toIndex:bins[end].index});
  i=end+1;
 }
 let vaLeft=pocIndex,vaRight=pocIndex,vaVolume=poc.volume;
 while(vaVolume<totalVolume*valueAreaFraction&&(vaLeft>0||vaRight<bins.length-1)){
  const left=vaLeft>0?bins[vaLeft-1].volume:-1,right=vaRight<bins.length-1?bins[vaRight+1].volume:-1;
  if(left>=right){vaLeft--;vaVolume+=bins[vaLeft].volume}else{vaRight++;vaVolume+=bins[vaRight].volume}
 }
 const valueArea={low:bins[vaLeft].priceLow,high:bins[vaRight].priceHigh,volume:vaVolume,fraction:vaVolume/totalVolume,requestedFraction:valueAreaFraction};
 const profile={symbol,tickSize:tick,bucketTicks,bins,poc,hvn,valueArea,totalVolume,totalQuoteVolume,
  limitations:['BUCKETED_EXECUTED_VOLUME_NOT_ORDER_BOOK_OR_GUARANTEED_RESISTANCE','HVN_THRESHOLD_IS_MODEL_CONFIGURATION_NOT_VALIDATED_WIN_RATE']};
 return {ok:true,code:'TP_PROFILE_READY',profile,evidence:{...evidence,poc,hvn,valueArea},reasons:[],fixedRRReplacementEnabled:false,executionApproved:false};
}
