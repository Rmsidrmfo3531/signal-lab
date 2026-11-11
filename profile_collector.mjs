import {buildKlineVolumeProfile,KLINE_PROFILE_SOURCE} from './volume_profile.mjs';
// A bounded on-demand collector. Called only after technical qualification or
// for existing positions; never enumerates every symbol's history.
// One request per symbol: the last `candles` 15-minute Binance candles (3 days by
// default), so the profile spans the same price scale as 1H/4H stops.
export class VolumeProfileCollector{
 constructor({request,now=Date.now,candles=288,maxRequestsPerMinute=12,dataSource=KLINE_PROFILE_SOURCE,cacheMs=60000,profileOptions={}}={}){
  if(typeof request!=='function'||!Number.isInteger(candles)||candles<96||candles>1500||
   !Number.isInteger(maxRequestsPerMinute)||maxRequestsPerMinute<1||maxRequestsPerMinute>120||![KLINE_PROFILE_SOURCE,'SYNTHETIC_TEST'].includes(dataSource)||
   !Number.isInteger(cacheMs)||cacheMs<0||cacheMs>60000)throw Error('PROFILE_COLLECTOR_CONFIG');
  Object.assign(this,{request,now,candles,maxRequestsPerMinute,dataSource,cacheMs,profileOptions});this.cache=new Map();this.pending=new Map();this.issued=[];
 }
 async get(symbol,{tickSize,eligible=false,held=false}={}){
  if(!/^[A-Z0-9]+USDT$/.test(symbol)||!eligible&&!held)return {ok:false,code:'TP_PROFILE_UNAVAILABLE',reasons:['ON_DEMAND_TECHNICAL_OR_POSITION_ONLY']};
  const key=symbol+':'+tickSize,cached=this.cache.get(key);if(cached&&this.now()-cached.at>=0&&this.now()-cached.at<this.cacheMs)return cached.result;
  if(this.pending.has(key))return this.pending.get(key);
  const task=this.#collect(symbol,tickSize,key);this.pending.set(key,task);
  try{return await task}finally{this.pending.delete(key)}
 }
 async #collect(symbol,tickSize,key){
  const at=this.now();this.issued=this.issued.filter(t=>at-t<60000);
  if(this.issued.length>=this.maxRequestsPerMinute)return {ok:false,code:'TP_PROFILE_UNAVAILABLE',reasons:['PROFILE_REQUEST_BUDGET_EXHAUSTED']};
  this.issued.push(at);
  try{
   const rows=await this.request(`/fapi/v1/klines?symbol=${encodeURIComponent(symbol)}&interval=15m&limit=${this.candles}`);
   if(!Array.isArray(rows))throw Error('KLINES_SCHEMA');
   const result=buildKlineVolumeProfile({symbol,klines:rows,receivedAt:this.now(),tickSize,dataSource:this.dataSource},{...this.profileOptions,now:this.now()});
   this.cache.set(key,{at:this.now(),result});
   if(this.cache.size>80)this.cache.delete(this.cache.keys().next().value);
   return result;
  }catch{return {ok:false,code:'TP_PROFILE_UNAVAILABLE',reasons:['KLINES_FETCH_OR_SCHEMA_FAILED'],evidence:{pages:1,complete:false}}}
 }
}
