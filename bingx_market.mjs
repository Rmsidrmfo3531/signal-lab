// BingX USDT-M perpetual PUBLIC market data client. GET only, no API key,
// no signature, no account or order endpoints. Official limits: contracts and
// depth are 1 request/s per IP, so requests are serialized with spacing.
// Primary host .com; .pro only after a network failure (not a business error).
import {normalizeBingXContract,normalizeBook,venueSymbol} from './venue_market_data.mjs';

export const BINGX_HOSTS=Object.freeze(['https://open-api.bingx.com','https://open-api.bingx.pro']);
const PATHS=Object.freeze({contracts:'/openApi/swap/v2/quote/contracts',depth:'/openApi/swap/v2/quote/depth'});
export const BINGX_MIN_INTERVAL_MS=1100;
const MAX_BYTES=4_000_000;

export class VenueHttpError extends Error{constructor(code,message){super(message||code);this.code=code}}

export async function readLimitedJSON(response,maxBytes=MAX_BYTES){
 const length=Number(response.headers?.get?.('content-length')||0);
 if(length>maxBytes)throw new VenueHttpError('RESPONSE_TOO_LARGE');
 const chunks=[];let size=0;
 for await(const chunk of response.body??[]){size+=chunk.byteLength;if(size>maxBytes)throw new VenueHttpError('RESPONSE_TOO_LARGE');chunks.push(Buffer.from(chunk))}
 try{return JSON.parse(Buffer.concat(chunks).toString('utf8'))}catch{throw new VenueHttpError('RESPONSE_NOT_JSON')}
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
 async loadContracts({force=false}={}){
  if(!force&&this.contracts&&this.now()-this.contractsAt<this.contractsTtlMs)return this.contracts;
  const data=await this.#get(PATHS.contracts);
  if(!Array.isArray(data))throw new VenueHttpError('CONTRACTS_SCHEMA');
  const map=new Map();for(const raw of data){const c=normalizeBingXContract(raw);if(c)map.set(c.symbol,c)}
  if(!map.size)throw new VenueHttpError('CONTRACTS_EMPTY');
  this.contracts=map;this.contractsAt=this.now();return map;
 }
 async book(symbol){
  const data=await this.#get(PATHS.depth,{symbol:venueSymbol('BINGX',symbol),limit:'5'});
  return normalizeBook('BINGX',data,{receivedAt:this.now(),now:this.now()});
 }
}
