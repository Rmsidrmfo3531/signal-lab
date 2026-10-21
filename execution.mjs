/** Read-only estimates from Variational's publicly documented, potentially cached v2 indicative quotes.
 * Neither indicative quotations nor Binance last price are executable prices. Never place orders.
 */
const finitePositive=x=>{const n=Number(x);return Number.isFinite(n)&&n>0?n:null};
const finiteSigned=x=>{if(x===undefined||x===null||x==='')return null;const n=Number(x);return Number.isFinite(n)?n:null};
const bps=(a,b)=>((a-b)/b)*10000;
export const EXEC_DEFAULTS=Object.freeze({maxQuoteAgeSeconds:180,maxFeedAgeSeconds:90,maxSpreadBps:20,maxAdverseVenueBps:35,maxRoundTripBps:30,paperNotionalUSD:500});
export function parsePerpExecution(listing){
 if(!listing||listing.contract_type!=='perpetual'||!/^([A-Z0-9]+)-PERP$/.test(listing.ticker||''))return null;
 const q=listing.quotes||{};
 const parseQuote=o=>({bid:finitePositive(o?.bid),ask:finitePositive(o?.ask)});
 const base=parseQuote(q.base),oneK=parseQuote(q.size_1k);
 const rate=listing.funding?.next?.interval_rate??listing.funding?.last?.interval_rate;
 const seconds=Number(listing.funding?.interval_seconds);
 const timestamp=Date.parse(q.updated_at||'');
 return {ticker:listing.ticker,markPrice:finitePositive(listing.mark_price),volume24h:finiteSigned(listing.volume_24h),openInterestLong:finiteSigned(listing.open_interest?.long_open_interest),openInterestShort:finiteSigned(listing.open_interest?.short_open_interest),
  baseSpreadBps:finiteSigned(listing.base_spread_bps),quoteUpdatedAt:Number.isFinite(timestamp)?timestamp:null,
  quoteBase:base,quote1k:oneK,fundingIntervalRate:finiteSigned(rate),fundingIntervalSeconds:Number.isFinite(seconds)&&seconds>0?seconds:null,
  nextFundingAt:Number.isFinite(Number(listing.funding?.next_timestamp))?Number(listing.funding.next_timestamp)*1000:null};
}
export function executionEstimate({listing,side='LONG',notional=1000,binancePrice=null,binancePriceAt=null,statsReceivedAt=null,now=Date.now(),limits=EXEC_DEFAULTS}={}){
 const reasons=[];const cfg={...EXEC_DEFAULTS,...limits};
 // A mistyped numeric environment setting becomes NaN in server.mjs. Comparisons
 // such as age > NaN are always false, so reject the setting rather than silently
 // disabling a risk limit. Zero remains a valid strict spread/age threshold.
 for(const key of Object.keys(EXEC_DEFAULTS)){
  if(!Number.isFinite(cfg[key])||cfg[key]<0||key==='paperNotionalUSD'&&cfg[key]===0)reasons.push('체결 검증 설정 오류: '+key);
 }
 const n=Number(notional),mark=finitePositive(listing?.markPrice),bp=finitePositive(binancePrice);
 const quote=Number.isFinite(n)&&n>=250&&n<=3000?listing?.quote1k:listing?.quoteBase;
 const bid=finitePositive(quote?.bid),ask=finitePositive(quote?.ask);
 const at=listing?.quoteUpdatedAt;
 const quoteAgeSeconds=Number.isFinite(at)?Math.max(0,(now-at)/1000):null;
 const binanceAgeSeconds=Number.isFinite(binancePriceAt)?Math.max(0,(now-binancePriceAt)/1000):null;
 const statsAgeSeconds=Number.isFinite(statsReceivedAt)?Math.max(0,(now-statsReceivedAt)/1000):null;
 if(!listing)reasons.push('Variational 계약 데이터 없음');
 if(side!=='LONG'&&side!=='SHORT')reasons.push('진입 방향 오류');
 if(!Number.isFinite(n)||n<=0)reasons.push('포지션 크기 오류');
 if(n<250||n>1500)reasons.push('공개 호가 샘플($1,000)과 주문 금액 차이 과다');
 if(!mark)reasons.push('Variational Mark Price 없음');
 if(!bp)reasons.push('Binance 가격 없음');
 if(!bid||!ask||bid>=ask)reasons.push('유효한 Variational indicative 양방향 호가 없음');
 if(quoteAgeSeconds===null||quoteAgeSeconds>cfg.maxQuoteAgeSeconds)reasons.push('Variational 호가 오래됨 또는 갱신시각 없음');
 if(binanceAgeSeconds===null||binanceAgeSeconds>cfg.maxFeedAgeSeconds)reasons.push('Binance 해당 종목 시세 오래됨');
 if(statsAgeSeconds===null||statsAgeSeconds>cfg.maxQuoteAgeSeconds)reasons.push('Variational API 응답 오래됨');
 if([at,binancePriceAt,statsReceivedAt].some(t=>Number.isFinite(t)&&t>now+5000))reasons.push('시장 데이터 시각이 현재보다 미래임');
 const mid=bid&&ask?(bid+ask)/2:null;
 const effectiveSpreadBps=mid?((ask-bid)/mid)*10000:null;
 const venueMarkDiffBps=mark&&bp?bps(mark,bp):null;
 const entryQuote=side==='LONG'?ask:bid;
 const adverseVenueBps=entryQuote&&bp?(side==='LONG'?bps(entryQuote,bp):bps(bp,entryQuote)):null;
 const roundTripCostBps=effectiveSpreadBps; // symmetric exit quote is hypothetical; excludes price movement/funding.
 if(effectiveSpreadBps!==null&&effectiveSpreadBps>cfg.maxSpreadBps)reasons.push('스프레드 상한 초과');
 if(adverseVenueBps!==null&&adverseVenueBps>cfg.maxAdverseVenueBps)reasons.push('Binance 대비 불리한 방향의 Variational 호가');
 if(roundTripCostBps!==null&&roundTripCostBps>cfg.maxRoundTripBps)reasons.push('왕복 indicative 비용 상한 초과');
 const f=listing?.fundingIntervalRate;
 const hasFunding=Number.isFinite(f);
 const directionalFundingRate=hasFunding?(side==='LONG'?f:-f):null;
 // One complete funding interval only; can be either payment or credit, no forecast beyond current rate.
 const fundingOneIntervalUSD=hasFunding&&Number.isFinite(n)?n*directionalFundingRate:null;
 const spreadCostUSD=roundTripCostBps!==null&&Number.isFinite(n)?n*roundTripCostBps/10000:null;
 const checkTime=Math.min(...[at,binancePriceAt,statsReceivedAt].filter(Number.isFinite));
 return {eligible:reasons.length===0,reasons,side,notional:n,binancePrice:bp,markPrice:mark,bid,ask,quoteSample:'size_1k (indicative)',quoteUpdatedAt:at||null,quoteAgeSeconds,binanceAgeSeconds,statsAgeSeconds,statsReceivedAt,
  spreadBps:effectiveSpreadBps,spreadPercent:effectiveSpreadBps===null?null:effectiveSpreadBps/100,markVsBinanceBps:venueMarkDiffBps,adverseVenueBps,roundTripCostBps,spreadCostUSD,
  fundingIntervalRate:hasFunding?f:null,fundingIntervalSeconds:listing?.fundingIntervalSeconds??null,nextFundingAt:listing?.nextFundingAt??null,fundingOneIntervalUSD,checkedAt:now,
  dataFrom:'Variational public indicative quote (NOT firm / size-specific)',lastCheckedQuoteAt:Number.isFinite(checkTime)?checkTime:null};
}
export function riskSizedEstimate({signal,listing,binancePrice,binancePriceAt,statsReceivedAt,now=Date.now(),limits}={}){
 if(!signal?.entry||!signal?.stop)return {eligible:false,reasons:['진입가·손절가 없음']};
 const direction=signal.direction;
 // Public $1,000 quote is an indicative size sample, not an account balance.
 const n=limits?.paperNotionalUSD??EXEC_DEFAULTS.paperNotionalUSD;
 const quote=executionEstimate({listing,side:direction,notional:n,binancePrice,binancePriceAt,statsReceivedAt,now,limits});
 const entryBasis=(direction==='LONG'?quote.ask:quote.bid)||signal.entry;
 const sign=direction==='LONG'?1:-1;
 const stopRate=sign*(entryBasis-signal.stop)/entryBasis;
 const targetRate=sign*(signal.target1-entryBasis)/entryBasis;
 const spreadRate=Math.max(0,quote.roundTripCostBps??0)/10000;
 const result=quote;
 if(!(stopRate>0&&targetRate>0)){result.eligible=false;result.reasons.push('Variational 참고 진입가 기준 손절·목표 방향 불일치')}
 const expectedLoss=n*(stopRate+spreadRate);
 return {...result,stopRate,entryBasis,estimatedStopLossUSD:expectedLoss,expectedGrossTargetUSD:n*targetRate,
  estimatedNetRR:expectedLoss>0?(n*targetRate-(result.spreadCostUSD||0))/expectedLoss:null};
}
