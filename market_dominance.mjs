// BTC vs Altcoin Dominance & Relative-Strength Regime Analysis (read-only market context).
// Combines CoinGecko /api/v3/global dominance shares (BTC.D, ETH.D, Stable.D, Pure Alt OTHERS.D)
// with live Binance Futures 24h breadth (BTC vs altcoin median return, ETH/BTC, alt outperform ratio).

const STABLE_KEYS=new Set(['usdt','usdc','usde','dai','fdusd','tusd','usds','pyusd','usdd','busd']);
const EXCLUDED_ALT_SYMBOLS=new Set(['BTCUSDT','USDCUSDT','FDUSDUSDT','TUSDUSDT','BUSDUSDT','USDPUSDT','USDEUSDT','EURUSDT','DAIUSDT','BTCDOMUSDT','DEFIUSDT']);
const HISTORY_MAX_MS=7*86400000;
const HISTORY_MIN_GAP_MS=9*60000;
const HISTORY_MAX_POINTS=1200;

const num=v=>{const n=Number(v);return Number.isFinite(n)?n:null};
const clamp=(v,lo,hi)=>Math.max(lo,Math.min(hi,v));
const r2=v=>v==null?null:+Number(v).toFixed(2);
const r1=v=>v==null?null:+Number(v).toFixed(1);

function median(arr){
 if(!arr.length)return null;
 const s=[...arr].sort((a,b)=>a-b);
 const mid=Math.floor(s.length/2);
 return s.length%2?s[mid]:(s[mid-1]+s[mid])/2;
}

/** Parse CoinGecko /api/v3/global JSON payload into clean dominance shares. */
export function parseGlobalDominance(raw,at=Date.now()){
 const d=raw?.data??raw;
 const pct=d?.market_cap_percentage;
 if(!pct||typeof pct!=='object')return null;
 const btc=num(pct.btc);
 const eth=num(pct.eth);
 if(btc==null||btc<=0||btc>=100)return null;
 let stable=0;
 for(const [k,v] of Object.entries(pct)){
  if(STABLE_KEYS.has(String(k).toLowerCase())){
   const n=num(v);
   if(n!=null&&n>0)stable+=n;
  }
 }
 const ethSafe=eth!=null&&eth>=0?eth:0;
 const alt=Math.max(0,100-btc-ethSafe-stable);
 const exBtc=Math.max(0,100-btc-stable);
 const totalMcapUSD=num(d?.total_market_cap?.usd);
 const mcapChange24hPct=num(d?.market_cap_change_percentage_24h_usd);
 const totalVol24hUSD=num(d?.total_volume?.usd);
 return {
  at:Number(at)||Date.now(),
  btcDomPct:r2(btc),
  ethDomPct:r2(ethSafe),
  stableDomPct:r2(stable),
  altDomPct:r2(alt),
  exBtcDomPct:r2(exBtc),
  totalMcapUSD:totalMcapUSD!=null?Math.round(totalMcapUSD):null,
  totalVol24hUSD:totalVol24hUSD!=null?Math.round(totalVol24hUSD):null,
  mcapChange24hPct:r2(mcapChange24hPct),
 };
}

/** Append a dominance snapshot to rolling 7-day history (deduplicated to >=9 min intervals). */
export function appendDominanceHistory(history,point){
 const list=Array.isArray(history)?history.filter(x=>x&&Number.isFinite(x.at)&&Number.isFinite(x.btcDomPct)):[];
 if(!point||!Number.isFinite(point.at)||!Number.isFinite(point.btcDomPct))return list;
 const cutoff=point.at-HISTORY_MAX_MS;
 const kept=list.filter(x=>x.at>=cutoff);
 const last=kept.at(-1);
 if(!last||point.at-last.at>=HISTORY_MIN_GAP_MS){
  kept.push({at:point.at,btcDomPct:point.btcDomPct,ethDomPct:point.ethDomPct,stableDomPct:point.stableDomPct,altDomPct:point.altDomPct});
 }else{
  kept[kept.length-1]={at:point.at,btcDomPct:point.btcDomPct,ethDomPct:point.ethDomPct,stableDomPct:point.stableDomPct,altDomPct:point.altDomPct};
 }
 return kept.length>HISTORY_MAX_POINTS?kept.slice(-HISTORY_MAX_POINTS):kept;
}

/** Find historical reference closest to 24h ago (falls back to oldest snapshot >=1h ago). */
export function computeDominanceDeltas(current,history){
 if(!current||!Array.isArray(history)||!history.length)return null;
 const now=current.at;
 const target24h=now-24*3600000;
 let best=null,bestErr=Infinity;
 for(const h of history){
  const ageMs=now-h.at;
  if(ageMs<18*3600000||ageMs>30*3600000)continue;
  const err=Math.abs(h.at-target24h);
  if(err<bestErr){best=h;bestErr=err}
 }
 if(!best){
  // Fallback: oldest snapshot at least 1 hour old
  const eligible=history.filter(h=>now-h.at>=3600000);
  if(!eligible.length)return null;
  best=eligible[0];
 }
 const windowHours=r1((now-best.at)/3600000);
 return {
  windowHours,
  is24h:windowHours>=18&&windowHours<=30,
  btcDomDelta:r2(current.btcDomPct-best.btcDomPct),
  ethDomDelta:r2(current.ethDomPct-best.ethDomPct),
  altDomDelta:r2(current.altDomPct-best.altDomPct),
  stableDomDelta:r2(current.stableDomPct-best.stableDomPct),
 };
}

/** Compute live BTC vs Altcoin breadth & relative performance from Binance 24h futures tickers. */
export function computeMarketBreadth(tickers,{eligibleSymbols=null,minQuoteVolume=1_000_000}={}){
 const rows=Array.isArray(tickers)?tickers:[];
 const allow=eligibleSymbols instanceof Set?eligibleSymbols:(Array.isArray(eligibleSymbols)&&eligibleSymbols.length?new Set(eligibleSymbols):null);
 let btc=null,eth=null;
 const alts=[];
 for(const t of rows){
  const sym=String(t?.symbol||'').toUpperCase();
  if(!sym.endsWith('USDT'))continue;
  const pct=num(t?.priceChangePercent);
  const qv=num(t?.quoteVolume);
  const last=num(t?.lastPrice);
  if(pct==null)continue;
  if(sym==='BTCUSDT'){btc={symbol:sym,pct,quoteVolume:qv,price:last};continue}
  if(sym==='ETHUSDT')eth={symbol:sym,pct,quoteVolume:qv,price:last};
  if(allow&&!allow.has(sym))continue;
  if(EXCLUDED_ALT_SYMBOLS.has(sym))continue;
  if(qv!=null&&qv<minQuoteVolume)continue;
  alts.push({symbol:sym,pct,quoteVolume:qv??0,price:last});
 }
 if(!btc||!alts.length)return null;
 const pcts=alts.map(a=>a.pct);
 const altMedianPct24h=median(pcts);
 const altMeanPct24h=pcts.reduce((s,v)=>s+v,0)/pcts.length;
 const topByVol=[...alts].sort((a,b)=>b.quoteVolume-a.quoteVolume).slice(0,20);
 const altTop20MedianPct24h=median(topByVol.map(a=>a.pct));
 const beatBtcCount=alts.filter(a=>a.pct>btc.pct).length;
 const advancingCount=alts.filter(a=>a.pct>0).length;
 const altBeatBtcPct=beatBtcCount/alts.length*100;
 const advancingPct=advancingCount/alts.length*100;
 const altSpreadPct=altMedianPct24h-btc.pct;
 const ethBtcPct24h=eth&&btc.pct>-99?(((1+eth.pct/100)/(1+btc.pct/100)-1)*100):null;
 const sortedByPct=[...alts].filter(a=>a.quoteVolume>=5_000_000||alts.length<=25).sort((a,b)=>b.pct-a.pct);
 const topAlts=sortedByPct.slice(0,3).map(a=>({symbol:a.symbol,pct:r2(a.pct)}));
 const bottomAlts=sortedByPct.slice(-3).reverse().map(a=>({symbol:a.symbol,pct:r2(a.pct)}));
 return {
  btcPct24h:r2(btc.pct),
  btcPrice:btc.price,
  ethPct24h:eth?r2(eth.pct):null,
  ethBtcPct24h:r2(ethBtcPct24h),
  altMedianPct24h:r2(altMedianPct24h),
  altMeanPct24h:r2(altMeanPct24h),
  altTop20MedianPct24h:r2(altTop20MedianPct24h),
  altSpreadPct:r2(altSpreadPct),
  altBeatBtcPct:r1(altBeatBtcPct),
  advancingPct:r1(advancingPct),
  sampleCount:alts.length,
  topAlts,
  bottomAlts,
 };
}

/** Combine global dominance & live breadth into a clear BTC-vs-Altcoin regime assessment. */
export function buildMarketDominanceReport({global=null,history=[],tickers=[],eligibleSymbols=null,now=Date.now(),globalError=''}={}){
 const deltas=computeDominanceDeltas(global,history);
 const breadth=computeMarketBreadth(tickers,{eligibleSymbols});

 // Weighted score: -100 (strong BTC dominance) .. 0 (neutral) .. +100 (strong Altcoin season/strength)
 let scoreSum=0,weightSum=0;
 if(breadth){
  // 1) Alt median minus BTC 24h return (%p): ±4%p saturates
  scoreSum+=clamp(breadth.altSpreadPct/4,-1,1)*45;
  weightSum+=45;
  // 2) % of altcoins outperforming BTC (centered at 50%): ±30%p saturates
  scoreSum+=clamp((breadth.altBeatBtcPct-50)/30,-1,1)*30;
  weightSum+=30;
  // 3) ETH/BTC 24h relative strength: ±3%p saturates
  if(breadth.ethBtcPct24h!=null){
   scoreSum+=clamp(breadth.ethBtcPct24h/3,-1,1)*15;
   weightSum+=15;
  }
 }
 if(deltas?.btcDomDelta!=null){
  // 4) Inverse of BTC.D change: BTC.D dropping = altcoin strength (±0.8%p saturates)
  scoreSum+=clamp(-deltas.btcDomDelta/0.8,-1,1)*10;
  weightSum+=10;
 }

 const score=weightSum>0?Math.round(clamp(scoreSum/weightSum*100,-100,100)):null;
 const gaugePct=score!=null?Math.round((score+100)/2):50;

 let regime='UNAVAILABLE',labelKo='데이터 수집 중',emoji='⏳',tone='neutral',phaseKo='',summaryKo='시장 도미넌스와 상대강도 데이터를 불러오는 중입니다.';
 if(score!=null){
  if(score<=-45){regime='BTC_STRONG';labelKo='비트코인 강한 독주';emoji='🟠';tone='btc-strong'}
  else if(score<=-15){regime='BTC_LEAD';labelKo='비트코인 우세';emoji='🟡';tone='btc'}
  else if(score<15){regime='NEUTRAL';labelKo='중립 · 혼조';emoji='⚪';tone='neutral'}
  else if(score<45){regime='ALT_LEAD';labelKo='알트코인 우세';emoji='🟢';tone='alt'}
  else{regime='ALT_STRONG';labelKo='알트코인 강세장';emoji='🚀';tone='alt-strong'}

  const btcUp=(breadth?.btcPct24h??0)>=0;
  const altUp=(breadth?.altMedianPct24h??0)>=0;
  if(regime==='BTC_STRONG'||regime==='BTC_LEAD'){
   phaseKo=btcUp?'상승장 BTC 단독 주도':'하락장 BTC 방어 · 알트 약세';
  }else if(regime==='ALT_STRONG'||regime==='ALT_LEAD'){
   phaseKo=altUp?'알트 순환매 강세 유입':'약세장 속 알트 상대 방어';
  }else{
   phaseKo='BTC·알트 균형 · 개별 종목 장세';
  }

  const parts=[];
  if(breadth){
   const sp=breadth.altSpreadPct;
   parts.push(`알트 중앙값(${breadth.altMedianPct24h>=0?'+':''}${breadth.altMedianPct24h}%)이 BTC(${breadth.btcPct24h>=0?'+':''}${breadth.btcPct24h}%) 대비 ${sp>=0?'+':''}${sp}%p`);
   parts.push(`알트 ${breadth.sampleCount}종 중 ${breadth.altBeatBtcPct}%가 BTC 상회`);
  }
  if(global){
   const dTxt=deltas?.btcDomDelta!=null?` (${deltas.is24h?'24h':`${deltas.windowHours}h`} ${deltas.btcDomDelta>=0?'+':''}${deltas.btcDomDelta}%p)`:'';
   parts.push(`BTC.D ${global.btcDomPct}%${dTxt} · 순수 알트.D ${global.altDomPct}%`);
  }
  const advice=regime==='BTC_STRONG'||regime==='BTC_LEAD'
   ?(btcUp?'비트코인 단독 강세 구간으로 알트 추격 매수에 유의하세요.':'리스크오프 하락 구간에서 알트 낙폭이 더 커 방어적 대응이 유리합니다.')
   :(regime==='ALT_STRONG'||regime==='ALT_LEAD'
    ?(altUp?'알트 전반으로 매수세가 확산되는 구간입니다.':'BTC 조정 대비 알트 하방 경직성이 양호한 편입니다.')
    :'뚜렷한 쏠림이 없어 개별 수급·매물대 기준 선별 대응이 적합합니다.');
  summaryKo=`${parts.join(' · ')}. ${advice}`;
 }else if(global){
  summaryKo=`BTC.D ${global.btcDomPct}% · 순수 알트.D ${global.altDomPct}% (바이낸스 실시간 알트 상대강도 수신 대기 중)`;
 }

 return {
  ok:Boolean(global||breadth),
  updatedAt:Number(now)||Date.now(),
  regime,
  labelKo,
  emoji,
  tone,
  phaseKo,
  summaryKo,
  score,
  gaugePct,
  global,
  deltas,
  breadth,
  globalError:globalError||'',
 };
}

/** Fetch live global dominance from CoinGecko public API (optional free demo key supported). */
export async function fetchGlobalDominance({fetcher=fetch,apiKey=process.env.COINGECKO_API_KEY||'',timeoutMs=15000}={}){
 const headers={Accept:'application/json','User-Agent':'SignalLab/1.0'};
 if(apiKey)headers['x-cg-demo-api-key']=apiKey;
 const res=await fetcher('https://api.coingecko.com/api/v3/global',{signal:AbortSignal.timeout(timeoutMs),headers});
 if(!res.ok)throw Error(`CoinGecko HTTP ${res.status}${res.status===429?' (요청 한도 초과)':''}`);
 const json=await res.json();
 const parsed=parseGlobalDominance(json,Date.now());
 if(!parsed)throw Error('CoinGecko global dominance payload invalid');
 return parsed;
}
