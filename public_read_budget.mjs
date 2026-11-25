// Process-local protection for Binance public reads. No account/order API.
export function binanceReadWeight(route){
 const url=new URL(route,'https://fapi.binance.com');
 if(url.pathname.endsWith('/aggTrades'))return 20;
 if(url.pathname.endsWith('/ticker/24hr'))return url.searchParams.has('symbol')?1:40;
 if(url.pathname.endsWith('/depth')){const n=Number(url.searchParams.get('limit')||20);return n<=50?2:n<=100?5:n<=500?10:20}
 if(url.pathname.endsWith('/klines')){const n=Number(url.searchParams.get('limit')||150);return n<100?1:n<500?2:n<=1000?5:10}
 return 1;
}
export class PublicReadBudget{
 constructor({now=Date.now,maxWeight=1800,windowMs=60000}={}){
  if(typeof now!=='function'||!Number.isSafeInteger(maxWeight)||maxWeight<1||maxWeight>2400||windowMs!==60000)throw Error('INVALID_PUBLIC_READ_BUDGET');
  Object.assign(this,{now,maxWeight,windowMs});this.rows=[];this.cooldownUntil=0;
 }
 snapshot(){const now=this.now();this.rows=this.rows.filter(row=>row.at>now-this.windowMs);
  return {maxWeightPerMinute:this.maxWeight,usedWeight:this.rows.reduce((n,row)=>n+row.weight,0),cooldownUntil:this.cooldownUntil,source:'LOCAL_REQUEST_BUDGET_NOT_EXCHANGE_ACCOUNT_LIMIT'};}
 reserve(route){const now=this.now(),state=this.snapshot(),weight=binanceReadWeight(route);
  if(now<this.cooldownUntil)return {ok:false,code:'BINANCE_PUBLIC_COOLDOWN',...state};
  if(state.usedWeight+weight>this.maxWeight)return {ok:false,code:'BINANCE_PUBLIC_WEIGHT_BUDGET',...state};
  this.rows.push({at:now,weight});return {ok:true,weight,...this.snapshot()};
 }
 rateLimited(status,retryAfterSeconds){if(![418,429].includes(status))return;
  const seconds=Number(retryAfterSeconds),delay=Number.isFinite(seconds)&&seconds>0?Math.max(60,Math.min(300,seconds)):60;
  this.cooldownUntil=Math.max(this.cooldownUntil,this.now()+delay*1000);}
}
/** One Binance public GET under the shared budget for an optional side read (고래 CVD aggTrades, review 2026-11-25):
 * the weight is reserved synchronously at the call (so a caller's room check and the reservation cannot interleave),
 * 418/429 start the shared cooldown, and its own timeout aborts the fetch. Unlike server.mjs binance() it never
 * touches the scanner's REST state (state.rest / state.error) or its response cache: a failed best-effort read must
 * not mark Binance offline for the signal strategy, and a page read once is not kept in memory. Throws on any failure. */
export async function budgetedPublicRead(route,{budget,fetcher=globalThis.fetch,timeoutMs=4000,base='https://fapi.binance.com'}={}){
 const r=budget.reserve(route);if(!r.ok)throw Error(r.code);
 const ctrl=new AbortController(),timer=setTimeout(()=>ctrl.abort(),Math.max(100,Math.min(12000,Number(timeoutMs)||4000)));
 try{
  const res=await fetcher(base+route,{signal:ctrl.signal,headers:{'User-Agent':'SignalLab/1.0','Accept':'application/json'}});
  if(!res.ok){budget.rateLimited(res.status,res.headers?.get?.('retry-after'));throw Error(`Binance HTTP ${res.status}: 공개 조회 일시 보류`)}
  return await res.json();
 }finally{clearTimeout(timer)}
}
