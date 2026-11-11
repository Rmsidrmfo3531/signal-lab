// Gate.io USDT-settled perpetual PUBLIC market data client. GET only, no API
// key, no signature, no account or order endpoints. Public futures endpoints are
// limited to 200 requests per 10 s per IP; requests are spaced well below that.
import {normalizeGateContract,normalizeBook,venueSymbol} from './venue_market_data.mjs';
import {VenueHttpError,readLimitedJSON,spacedQueue} from './bingx_market.mjs';
import {gateKlineRows} from './venue_charts.mjs';

export const GATEIO_HOST='https://api.gateio.ws';
const PATHS=Object.freeze({contracts:'/api/v4/futures/usdt/contracts',book:'/api/v4/futures/usdt/order_book',time:'/api/v4/spot/time',
 tickers:'/api/v4/futures/usdt/tickers',candles:'/api/v4/futures/usdt/candlesticks'});
export const GATEIO_MIN_INTERVAL_MS=120;

export class GateMarketData{
 constructor({fetcher=globalThis.fetch,now=Date.now,timeoutMs=8000,minIntervalMs=GATEIO_MIN_INTERVAL_MS,contractsTtlMs=600000,sleep}={}){
  if(typeof fetcher!=='function')throw Error('FETCH_UNAVAILABLE');
  Object.assign(this,{fetcher,now,timeoutMs,contractsTtlMs});
  this.queue=spacedQueue(minIntervalMs,{now,sleep});this.contracts=null;this.contractsAt=0;
  // Venue clock - local clock, measured from the venue server time (midpoint of the round trip).
  this.clockOffsetMs=0;this.clockSyncedAt=0;this.rawContracts=new Map();
 }
 async #get(path,query={}){
  const search=new URLSearchParams(query).toString();
  return this.queue(async()=>{
   let response;
   try{response=await this.fetcher(GATEIO_HOST+path+(search?'?'+search:''),{method:'GET',redirect:'error',signal:AbortSignal.timeout(this.timeoutMs),headers:{Accept:'application/json'}})}
   catch(error){throw new VenueHttpError('NETWORK_UNREACHABLE',error?.message)}
   const body=await readLimitedJSON(response);
   if(!response.ok)throw new VenueHttpError('HTTP_'+response.status,String(body?.label??body?.message??'').slice(0,160));
   return body;
  });
 }
 async syncClock(){
  const t0=this.now(),data=await this.#get(PATHS.time),t1=this.now(),server=Number(data?.server_time);
  if(!Number.isFinite(server)||server<=0)throw new VenueHttpError('SERVER_TIME_SCHEMA');
  this.clockOffsetMs=Math.round(server-(t0+t1)/2);this.clockSyncedAt=t1;return this.clockOffsetMs;
 }
 async loadContracts({force=false}={}){
  if(!force&&this.contracts&&this.now()-this.contractsAt<this.contractsTtlMs)return this.contracts;
  const data=await this.#get(PATHS.contracts);
  if(!Array.isArray(data))throw new VenueHttpError('CONTRACTS_SCHEMA');
  const map=new Map(),raws=new Map();for(const raw of data){const c=normalizeGateContract(raw);if(c){map.set(c.symbol,c);raws.set(c.symbol,raw)}}
  if(!map.size)throw new VenueHttpError('CONTRACTS_EMPTY');
  this.contracts=map;this.rawContracts=raws;this.contractsAt=this.now();
  await this.syncClock().catch(()=>{});
  return map;
 }
 async tickers(){const data=await this.#get(PATHS.tickers);if(!Array.isArray(data))throw new VenueHttpError('TICKERS_SCHEMA');return data}
 /** Closed and forming candles in the Binance kline layout (chart data for coins Binance does not list). */
 async klines(symbol,interval,limit){
  const data=await this.#get(PATHS.candles,{contract:venueSymbol('GATEIO',symbol),interval,limit:String(Math.min(2000,limit))});
  const rows=gateKlineRows(data,interval,{multiplier:this.contracts?.get(symbol)?.contractSizeBase??1});
  if(!rows)throw new VenueHttpError('KLINES_SCHEMA');return rows;
 }
 async book(symbol){
  const data=await this.#get(PATHS.book,{contract:venueSymbol('GATEIO',symbol),limit:'5'});
  return normalizeBook('GATEIO',data,{receivedAt:this.now(),now:this.now(),clockOffsetMs:this.clockOffsetMs});
 }
}
