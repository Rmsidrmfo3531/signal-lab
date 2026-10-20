// Variational TradFi SWAPs are NOT Binance cryptocurrency PERPs.
// Never infer live OHLC candles from a Mark Price snapshot or a TradingView iframe.
const KNOWN = Object.freeze({
 XAU:{category:'귀금속',chart:'OANDA:XAUUSD',feed:'XAU/USD',route:''},
 XAG:{category:'귀금속',chart:'OANDA:XAGUSD',feed:'XAG/USD',route:'XAGS'},
 US100:{category:'미국 지수',chart:'NASDAQ:NDX',feed:'NDX',route:'US100S'},
 US500:{category:'미국 지수',chart:'SP:SPX',feed:'SPX',route:''},
 US30:{category:'미국 지수',chart:'TVC:DJI',feed:'DJI',route:'US30S'},
 DXI:{category:'달러 지수',chart:'TVC:DXY',feed:'',route:'DXIP'},
 UKOIL:{category:'에너지',chart:'TVC:UKOIL',feed:'',route:''},
 COPP:{category:'원자재',chart:'COMEX:HG1!',feed:'',route:'COPPP'},
 VXI:{category:'변동성 지수',chart:'CBOE:VIX',feed:'',route:'VXIP'},
});
const positive=x=>{if(x===null||x===undefined||x==='')return null;const n=Number(x);return Number.isFinite(n)&&n>0?n:null};
const numberOrNull=x=>{if(x===null||x===undefined||x==='')return null;const n=Number(x);return Number.isFinite(n)?n:null};
const safeTicker=x=>/^([A-Z0-9]+)-(SWAP|PERP)$/.exec(String(x||''));
// Only known TradFi PERP underlyings; crypto PERPs must never be classified as TradFi.
const TRADFI_PERP_BASES=new Set(['XAU','US500','SPCX','CL']);
function categoryFor(base,name){
 if(KNOWN[base])return KNOWN[base].category;
 const n=String(name||'').toLowerCase();
 if(/gold|silver|platinum|palladium/.test(n))return '귀금속';
 if(/oil|gas|crude|copper|wheat/.test(n))return '원자재';
 if(/index|nasdaq|s&p|dow|midcap|non-financial/.test(n))return '주가지수';
 if(/fx|forex|eur|usd|jpy|gbp/.test(n))return '외환';
 if(/stock|share|equity|inc\b/.test(n))return '주식';
 return '기타 TradFi';
}
export function extractTradFiMarkets(payload,{now=Date.now()}={}){
 if(!Array.isArray(payload?.listings))throw Error('Variational v2 listings 배열 없음');
 return payload.listings.filter(x=>{const parsed=safeTicker(x?.ticker);return parsed&&((x.contract_type==='swap'&&parsed[2]==='SWAP')||(x.contract_type==='perpetual'&&parsed[2]==='PERP'&&TRADFI_PERP_BASES.has(parsed[1])))}).map(x=>{
  const base=safeTicker(x.ticker)[1],cfg=KNOWN[base]||{};
  const isSwap=x.contract_type==='swap';
  const at=Date.parse(x.quotes?.updated_at||'');
  const quoteAt=Number.isFinite(at)?at:null;
  const age=quoteAt!==null?Math.max(0,(now-quoteAt)/1000):null;
  const q=x.quotes?.size_1k||x.quotes?.base;
  const bid=positive(q?.bid),ask=positive(q?.ask);
  const mid=bid&&ask?(bid+ask)/2:null;
  const funding=x.funding?.next || x.funding?.last;
  const perprate=numberOrNull(x.funding?.next?.interval_rate??x.funding?.last?.interval_rate);
  return {ticker:x.ticker,base,name:String(x.name||base),category:categoryFor(base,x.name),type:isSwap?'SWAP':'PERP',
   chartSymbol:cfg.chart||null,feedSymbol:cfg.feed||null,
   tradeUrl:isSwap?(cfg.route?`https://omni.variational.io/swap/${encodeURIComponent(cfg.route)}`:null):`https://omni.variational.io/perpetual/${encodeURIComponent(base)}`, 
   marketsUrl:'https://omni.variational.io/markets',
   markPrice:positive(x.mark_price),volume24h:numberOrNull(x.volume_24h),
   bid,ask,spreadBps:mid?(ask-bid)/mid*10000:null,quoteUpdatedAt:quoteAt,quoteAgeSeconds:age,
   quoteFresh:Boolean(age!==null&&age<=180&&bid&&ask&&ask>bid),
   // Swap funding: long pays if positive, short receives if positive. The two rates are not negatives of one another.
   longRate:isSwap?numberOrNull(funding?.interval_long_rate):perprate,shortRate:isSwap?numberOrNull(funding?.interval_short_rate):perprate,
   nextFundingAt:Number.isFinite(Number(x.funding?.next_timestamp))?Number(x.funding.next_timestamp)*1000:null,
   fundingSource:x.funding?.next?'upcoming':x.funding?.last?'last':'unavailable',
   marketStatus:'공식 통계 API에 시장 개폐 상태 미포함'
  };
 }).sort((a,b)=>(b.volume24h||0)-(a.volume24h||0));
}
export function swapFundingUSD(row,side,notional=1000){
 if(!row||!['LONG','SHORT'].includes(side)||!Number.isFinite(Number(notional))||Number(notional)<0)return null;
 const r=side==='LONG'?row.longRate:row.shortRate;
 // Sign convention: positive long means long pays, positive short means short receives.
 return r===null||r===undefined?null:Number(notional)*Number(r)*(side==='LONG'?-1:1);
}
export function tradfiQuoteVerdict(row,{now=Date.now(),maxAge=180,maxSpreadBps=30}={}){
 const reasons=[];
 if(!row)reasons.push('Variational SWAP 상장 확인 실패');
 const age=row?.quoteUpdatedAt==null?null:(now-row.quoteUpdatedAt)/1000;
 if(!row?.markPrice)reasons.push('Mark Price 없음');
 if(!row?.bid||!row?.ask||row.ask<=row.bid)reasons.push('유효한 양방향 호가 없음(휴장 가능)');
 if(age===null||age<0||age>maxAge)reasons.push('호가가 오래됐거나 시간 검증 실패');
 if(row?.spreadBps!=null&&row.spreadBps>maxSpreadBps)reasons.push('스프레드 상한 초과');
 return {eligible:reasons.length===0,reasons,ageSeconds:age};
}
export function chartUrlForSwap(row){
 return row?.chartSymbol?`https://www.tradingview.com/chart/?symbol=${encodeURIComponent(row.chartSymbol)}`:null;
}
export function getTradFiConfig(base){return KNOWN[base]||null}

// Backward-compatible helper for consumers explicitly seeking only SWAP markets.
export function extractTradFiSwaps(payload,options={}){return extractTradFiMarkets(payload,options).filter(x=>x.type==='SWAP')}
