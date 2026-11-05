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
