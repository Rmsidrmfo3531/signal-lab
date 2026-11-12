// BingX USDT-M perpetual PUBLIC market data client. GET only, no API key,
// no signature, no account or order endpoints. Official limits: contracts and
// depth are 1 request/s per IP, so requests are serialized with spacing.
// Primary host .com; .pro only after a network failure (not a business error).
import {normalizeBingXContract,normalizeBook,venueSymbol} from './venue_market_data.mjs';
import {bingxKlineRows} from './venue_charts.mjs';

export const BINGX_HOSTS=Object.freeze(['https://open-api.bingx.com','https://open-api.bingx.pro']);
const PATHS=Object.freeze({contracts:'/openApi/swap/v2/quote/contracts',depth:'/openApi/swap/v2/quote/depth',time:'/openApi/swap/v2/server/time',
 tickers:'/openApi/swap/v2/quote/ticker',klines:'/openApi/swap/v3/quote/klines'});
export const BINGX_MIN_INTERVAL_MS=1100;
const MAX_BYTES=4_000_000;

export class VenueHttpError extends Error{constructor(code,message){super(message||code);this.code=code}}

// BingX order ids are 19-digit integers (> 2^53): JSON.parse would round them (…737 -> …700) and a
// cancel would then name another order. They are kept as exact strings before parsing.
export const keepBigIds=text=>text.replace(/("(?:orderId|orderID|clientOrderID|tradeId|positionId)"\s*:\s*)(-?\d{16,})(?=\s*[,}\]])/g,'$1"$2"');
export async function readLimitedJSON(response,maxBytes=MAX_BYTES,{bigIds=false}={}){
 const length=Number(response.headers?.get?.('content-length')||0);
 if(length>maxBytes)throw new VenueHttpError('RESPONSE_TOO_LARGE');
 const chunks=[];let size=0;
 for await(const chunk of response.body??[]){size+=chunk.byteLength;if(size>maxBytes)throw new VenueHttpError('RESPONSE_TOO_LARGE');chunks.push(Buffer.from(chunk))}
 try{const text=Buffer.concat(chunks).toString('utf8');return JSON.parse(bigIds?keepBigIds(text):text)}catch{throw new VenueHttpError('RESPONSE_NOT_JSON')}
}

/** Serializes calls with a minimum spacing (per venue and IP). */
export function spacedQueue(minIntervalMs,{now=Date.now,sleep=ms=>new Promise(r=>setTimeout(r,ms))}={}){
 let tail=Promise.resolve(),last=-Infinity;
 return task=>{
  const run=tail.then(async()=>{const wait=last+minIntervalMs-now();if(wait>0)await sleep(wait);last=now();return task()});
  tail=run.catch(()=>{});return run;
 };
}

export class BingXMarketData{
 constructor({fetcher=globalThis.fetch,now=Date.now,timeoutMs=8000,minIntervalMs=BINGX_MIN_INTERVAL_MS,contractsTtlMs=600000,sleep}={}){
  if(typeof fetcher!=='function')throw Error('FETCH_UNAVAILABLE');
  Object.assign(this,{fetcher,now,timeoutMs,contractsTtlMs});
  this.queue=spacedQueue(minIntervalMs,{now,sleep});this.contracts=null;this.contractsAt=0;this.lastError=null;
  // Venue clock - local clock, measured from the venue server time (midpoint of the round trip).
  this.clockOffsetMs=0;this.clockSyncedAt=0;
 }
 async #get(path,query={}){
  const search=new URLSearchParams(query).toString();
  return this.queue(async()=>{
   let lastNetworkError;
   for(const host of BINGX_HOSTS){
    let response;
    try{response=await this.fetcher(host+path+(search?'?'+search:''),{method:'GET',redirect:'error',signal:AbortSignal.timeout(this.timeoutMs),headers:{Accept:'application/json'}})}
    catch(error){lastNetworkError=error;continue} // network failure only: try the fallback host
    if(!response.ok)throw new VenueHttpError('HTTP_'+response.status);
    const body=await readLimitedJSON(response);
    if(body?.code!==0)throw new VenueHttpError('VENUE_ERROR_'+String(body?.code??'UNKNOWN').slice(0,12),String(body?.msg??'').slice(0,160));
    return body.data;
   }
   throw new VenueHttpError('NETWORK_UNREACHABLE',lastNetworkError?.message);
  });
 }
 async syncClock(){
  const t0=this.now(),data=await this.#get(PATHS.time),t1=this.now(),server=Number(data?.serverTime);
  if(!Number.isFinite(server)||server<=0)throw new VenueHttpError('SERVER_TIME_SCHEMA');
  this.clockOffsetMs=Math.round(server-(t0+t1)/2);this.clockSyncedAt=t1;return this.clockOffsetMs;
 }
 async loadContracts({force=false}={}){
  if(!force&&this.contracts&&this.now()-this.contractsAt<this.contractsTtlMs)return this.contracts;
  const data=await this.#get(PATHS.contracts);
  if(!Array.isArray(data))throw new VenueHttpError('CONTRACTS_SCHEMA');
  const map=new Map(),raws=new Map();for(const raw of data){const c=normalizeBingXContract(raw);if(c){map.set(c.symbol,c);raws.set(c.symbol,raw)}}
  if(!map.size)throw new VenueHttpError('CONTRACTS_EMPTY');
  this.contracts=map;this.rawContracts=raws;this.contractsAt=this.now();
  await this.syncClock().catch(()=>{}); // re-measured with every contract refresh (10 min)
  return map;
 }
 async tickers(){const data=await this.#get(PATHS.tickers);if(!Array.isArray(data))throw new VenueHttpError('TICKERS_SCHEMA');return data}
 async klines(symbol,interval,limit){
  const rows=bingxKlineRows(await this.#get(PATHS.klines,{symbol:venueSymbol('BINGX',symbol),interval,limit:String(Math.min(1440,limit))}),interval);
  if(!rows)throw new VenueHttpError('KLINES_SCHEMA');return rows;
 }
 async book(symbol){
  const data=await this.#get(PATHS.depth,{symbol:venueSymbol('BINGX',symbol),limit:'5'});
  return normalizeBook('BINGX',data,{receivedAt:this.now(),now:this.now(),clockOffsetMs:this.clockOffsetMs});
 }
}
