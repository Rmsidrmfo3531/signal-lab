// Optional licensed/reference OHLC feed for TradFi. The public TradingView iframe does not expose its candles.
import {normalizeTwelveSeries} from './tradfi_signal.mjs';
const INTERVALS={h1:'1h',h4:'4h'};
export async function fetchTwelveSeries({symbol,apiKey,interval,fetchFn=fetch,now=Date.now(),timeoutMs=10000}={}){
 if(!apiKey)throw Error('TWELVE_DATA_API_KEY 미설정');
 if(!/^[A-Z0-9]+(?:\/[A-Z0-9]+)?$/.test(symbol||''))throw Error('지원되지 않는 참조 시세 심볼');
 if(!Object.hasOwn(INTERVALS,interval))throw Error('미지원 시간봉');
 const u=new URL('https://api.twelvedata.com/time_series');
 u.searchParams.set('symbol',symbol);u.searchParams.set('interval',INTERVALS[interval]);u.searchParams.set('outputsize','130');u.searchParams.set('timezone','UTC');u.searchParams.set('apikey',apiKey);
 const ctrl=new AbortController();const timer=setTimeout(()=>ctrl.abort(),timeoutMs);
 try{
  const r=await fetchFn(u.toString(),{signal:ctrl.signal,headers:{Accept:'application/json'}});
  if(!r.ok)throw Error(`Twelve Data HTTP ${r.status}`);
  const json=await r.json();return normalizeTwelveSeries(json,INTERVALS[interval],{now});
 }finally{clearTimeout(timer)}
}
export async function pullSeries(symbol,apiKey,options={}){
 const arr=[];
 for(const interval of ['h1','h4'])arr.push(await fetchTwelveSeries({symbol,apiKey,interval,...options}));
 return {h1:arr[0],h4:arr[1]};
}
