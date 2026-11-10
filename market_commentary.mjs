// Factual descriptions of the supplied Binance Futures 24h observations only.
// No language model, forecasts, news-based causal claims or exchange transport.
const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const numeric=value=>typeof value==='number'&&Number.isFinite(value)?value:typeof value==='string'&&value.trim()&&Number.isFinite(Number(value))?Number(value):null;
const stamp=value=>Number.isSafeInteger(value)&&value>=1e12&&value<8640000000000000;
const format=value=>Number.isFinite(value)?value!==0&&Math.abs(value)<.000001?value.toExponential(3):value.toLocaleString('ko-KR',{maximumFractionDigits:8}):'미확인';
const percent=value=>Number.isFinite(value)?(value>0?'+':'')+value.toFixed(2)+'%':'미확인';
const kst=value=>stamp(value)?new Date(value+9*3600000).toISOString().slice(0,19).replace('T',' ')+' KST':null;

export function buildMarketCommentary(tickers,{now=Date.now(),receivedAt=null,maxAgeMs=90000,eligibleSymbols,
 dataSource='UNCONFIRMED_INPUT',topAltCount=5}={}){
 if(!Array.isArray(tickers)||tickers.length>5000||!stamp(now)||!Number.isInteger(maxAgeMs)||maxAgeMs<1||maxAgeMs>90000||
  !Number.isInteger(topAltCount)||topAltCount<1||topAltCount>10||eligibleSymbols!==undefined&&(!Array.isArray(eligibleSymbols)||eligibleSymbols.length>5000))
  throw Error('INVALID_MARKET_COMMENTARY_OPTIONS');
 const universe=Array.isArray(eligibleSymbols)?new Set(eligibleSymbols.filter(value=>typeof value==='string'&&/^[A-Z0-9]{2,24}USDT$/.test(value))):null,
  source=['BINANCE_FUTURES_PUBLIC_24H','SYNTHETIC_TEST'].includes(dataSource)?dataSource:'UNCONFIRMED_INPUT',
  receiptFresh=stamp(receivedAt)&&receivedAt<=now&&now-receivedAt<=maxAgeMs,
  counts=new Map(),observations=[],rejections=[];
 for(const row of tickers)if(plain(row)&&typeof row.symbol==='string')counts.set(row.symbol,(counts.get(row.symbol)??0)+1);
 for(const raw of tickers){
  if(!plain(raw)||typeof raw.symbol!=='string'||!/^[A-Z0-9]{2,24}USDT$/.test(raw.symbol))continue;
  const symbol=raw.symbol;
  if(universe&&!universe.has(symbol))continue;
  if(raw.status!==undefined&&raw.status!=='TRADING'||raw.contractType!==undefined&&raw.contractType!=='PERPETUAL'||raw.quoteAsset!==undefined&&raw.quoteAsset!=='USDT')continue;
  if(counts.get(symbol)!==1){rejections.push({symbol,reason:'DUPLICATE_SYMBOL'});continue}
  const price=numeric(raw.lastPrice??raw.price),change=numeric(raw.priceChangePercent??raw.change),high=numeric(raw.highPrice),low=numeric(raw.lowPrice),
   quoteVolume=numeric(raw.quoteVolume),sourceAt=numeric(raw.closeTime??raw.timestamp),
   valid=price!==null&&price>0&&change!==null&&high!==null&&low!==null&&high>=low&&low>0&&price>=low&&price<=high&&quoteVolume!==null&&quoteVolume>=0;
  if(!valid){rejections.push({symbol,reason:'INVALID_OR_MISSING_24H_FIELDS'});continue}
  const clockKnown=stamp(sourceAt),fresh=receiptFresh&&clockKnown&&sourceAt<=now&&now-sourceAt<=maxAgeMs;
  observations.push({symbol,price,changePercent:change,quoteVolumeUSDT:quoteVolume,high,low,rangePercent:(high-low)/price*100,
   sourceTimestamp:clockKnown?sourceAt:null,sourceAgeMs:clockKnown?now-sourceAt:null,
   freshnessStatus:fresh?'PASS':!clockKnown||!stamp(receivedAt)?'UNVERIFIED':'FAIL',currentlyFresh:fresh});
 }
 const fresh=observations.filter(row=>row.currentlyFresh),bySymbol=new Map(fresh.map(row=>[row.symbol,row])),
  rising=fresh.filter(row=>row.changePercent>0).length,falling=fresh.filter(row=>row.changePercent<0).length,flat=fresh.length-rising-falling,
  sumVolume=fresh.reduce((total,row)=>total+row.quoteVolumeUSDT,0),volumes=fresh.length&&Number.isFinite(sumVolume)?sumVolume:null,
  alts=fresh.filter(row=>!['BTCUSDT','ETHUSDT'].includes(row.symbol)).sort((a,b)=>b.quoteVolumeUSDT-a.quoteVolumeUSDT||a.symbol.localeCompare(b.symbol)).slice(0,topAltCount),
  volatile=[...fresh].sort((a,b)=>b.rangePercent-a.rangePercent||a.symbol.localeCompare(b.symbol)).slice(0,topAltCount),
  status=!observations.length?'UNAVAILABLE':!fresh.length?observations.some(row=>row.freshnessStatus==='FAIL')?'STALE':'UNVERIFIED':
   !bySymbol.has('BTCUSDT')||!bySymbol.has('ETHUSDT')||rejections.length||fresh.length!==observations.length||!universe||source==='UNCONFIRMED_INPUT'?'PARTIAL':'AVAILABLE',
  lines=[];
 if(!fresh.length)lines.push('신선한 24시간 시세가 없어 현재 시장 시황 평가를 보류합니다.');
 else{
  for(const symbol of ['BTCUSDT','ETHUSDT']){
   const row=bySymbol.get(symbol);lines.push(row?`${symbol}: 24시간 등락 ${percent(row.changePercent)}, 현재가 ${format(row.price)} USDT, 거래대금 ${format(row.quoteVolumeUSDT)} USDT.`:`${symbol}: 신선한 실측 데이터 미확인.`);
  }
  lines.push(`수집 범위의 유효 ${fresh.length}종목: 상승 ${rising}, 하락 ${falling}, 보합 ${flat}; 상승 비율 ${(rising/fresh.length*100).toFixed(2)}%.`);
  lines.push(`같은 수집 범위의 24시간 거래대금 합계: ${format(volumes)} USDT.`);
  if(alts.length)lines.push('수집 범위 거래대금 상위 알트코인: '+alts.map(row=>`${row.symbol} ${percent(row.changePercent)}`).join(', ')+'.');
  if(volatile.length)lines.push('24시간 고저폭 상위: '+volatile.map(row=>`${row.symbol} ${row.rangePercent.toFixed(2)}%`).join(', ')+'. 고저폭은 ATR이나 미래 변동성 예측이 아닙니다.');
 }
 return {kind:'BINANCE_FACTUAL_MARKET_COMMENTARY',status,dataSource:source,syntheticTest:source==='SYNTHETIC_TEST',checkedAt:now,
  receivedAt:stamp(receivedAt)?receivedAt:null,checkedAtKst:kst(now),sourceTimestampRange:fresh.length?{from:Math.min(...fresh.map(row=>row.sourceTimestamp)),to:Math.max(...fresh.map(row=>row.sourceTimestamp))}:null,
  universeVerified:universe!==null,universeSize:universe?.size??null,scope:'COLLECTED_VALID_USDT_PERPETUAL_TICKERS_NOT_ALL_CRYPTO_MARKETS',
  coverage:{inputRows:tickers.length,validObservedSymbols:observations.length,freshSymbols:fresh.length,rejectedSymbols:rejections.length},
  assets:['BTCUSDT','ETHUSDT'].map(symbol=>bySymbol.get(symbol)??{symbol,status:'UNVERIFIED',price:null,changePercent:null}),
  breadth:{total:fresh.length,rising,falling,flat,risingPercent:fresh.length?rising/fresh.length*100:null},
  topAlts:alts,volume:{quoteCurrency:'USDT',totalQuoteVolume:volumes},volatility:{metric:'24H_HIGH_LOW_RANGE_OVER_LAST_PRICE',top:volatile},
  headline:!fresh.length?'현재 시황 미확인':`${source==='SYNTHETIC_TEST'?'합성 테스트':source==='BINANCE_FUTURES_PUBLIC_24H'?'Binance 선물 실측':'출처 미검증'} 수집 ${fresh.length}종목 시황`,lines,summary:lines.join('\n'),observations,rejections,
  priceForecastProvided:false,causesInferred:false,sourceOriginIndependentlyAuthenticated:false,
  note:'제공된 실측 숫자를 요약한 관측입니다. 수집되지 않은 사건·전망·등락 원인을 생성하지 않으며 시세 신선도와 출처를 별도로 표시합니다.'};
}
