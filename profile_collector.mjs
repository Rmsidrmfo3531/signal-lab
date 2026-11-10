import {buildVolumeProfile} from './volume_profile.mjs';
// A bounded on-demand collector. Called only after technical qualification or
// for existing positions; never enumerates every symbol's trade history.
export class VolumeProfileCollector{
 constructor({request,now=Date.now,maxPages=3,windowMs=300000,maxRequestsPerMinute=12,dataSource='REAL_BINANCE_AGG_TRADES'}={}){
  if(typeof request!=='function'||!Number.isInteger(maxPages)||maxPages<1||maxPages>10||!Number.isFinite(windowMs)||windowMs<60000||windowMs>3600000||
   !Number.isInteger(maxRequestsPerMinute)||maxRequestsPerMinute<1||maxRequestsPerMinute>120||!['REAL_BINANCE_AGG_TRADES','SYNTHETIC_TEST'].includes(dataSource))throw Error('PROFILE_COLLECTOR_CONFIG');
  Object.assign(this,{request,now,maxPages,windowMs,maxRequestsPerMinute,dataSource});this.cache=new Map();this.pending=new Map();this.issued=[];
 }
 async get(symbol,{tickSize,eligible=false,held=false}={}){
  if(!/^[A-Z0-9]+USDT$/.test(symbol)||!eligible&&!held)return {ok:false,code:'TP_PROFILE_UNAVAILABLE',reasons:['ON_DEMAND_TECHNICAL_OR_POSITION_ONLY']};
  const key=symbol+':'+tickSize,cached=this.cache.get(key);if(cached&&this.now()-cached.at>=0&&this.now()-cached.at<60000)return cached.result;
  if(this.pending.has(key))return this.pending.get(key);
  const task=this.#collect(symbol,tickSize,key);this.pending.set(key,task);
  try{return await task}finally{this.pending.delete(key)}
 }
 async #collect(symbol,tickSize,key){
  const end=this.now(),start=end-this.windowMs,trades=[];let complete=false,pages=0,lastId=null;
  try{
   for(let page=0;page<this.maxPages;page++){
    this.issued=this.issued.filter(at=>end-at<60000);
    if(this.issued.length>=this.maxRequestsPerMinute)break;
    this.issued.push(this.now());pages++;
    const query=page===0?`startTime=${start}&endTime=${end}`:`fromId=${lastId+1}`;
    const rows=await this.request(`/fapi/v1/aggTrades?symbol=${encodeURIComponent(symbol)}&${query}&limit=1000`);
    if(!Array.isArray(rows)||rows.length>1000)throw Error('AGG_TRADES_SCHEMA');
    if(rows.length&&(!Number.isSafeInteger(Number(rows.at(-1).a))||lastId!==null&&Number(rows.at(-1).a)<=lastId))throw Error('AGG_TRADES_NOT_PROGRESSING');
    trades.push(...rows.filter(row=>Number(row.T)<=end));
    if(rows.length<1000||rows.some(row=>Number(row.T)>end)){complete=true;break}
    lastId=Number(rows.at(-1).a);
   }
   const result=buildVolumeProfile({symbol,trades,windowStart:start,windowEnd:end,receivedAt:this.now(),tickSize,
    dataSource:this.dataSource,coverage:{complete,fromTime:start,toTime:end,truncated:!complete,pages}},{now:this.now()});
   this.cache.set(key,{at:this.now(),result});
   if(this.cache.size>80)this.cache.delete(this.cache.keys().next().value);
   return result;
  }catch{return {ok:false,code:'TP_PROFILE_UNAVAILABLE',reasons:['AGG_TRADES_FETCH_OR_SCHEMA_FAILED'],evidence:{windowStart:start,windowEnd:end,pages,complete:false}}}
 }
}
