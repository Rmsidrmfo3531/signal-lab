// Test-only exchange transport. All external destinations and write methods fail closed.
import fs from 'node:fs';
import path from 'node:path';
import {marketSeries,ENTRY} from './fixtures/pipeline_market.mjs';
const realFetch=globalThis.fetch;
const realNow=Date.now.bind(Date);
let lastControl={scenarios:{BTCUSDT:'breakout-long',ETHUSDT:'breakout-short'},prices:{},emit:false};
function control(){try{lastControl=JSON.parse(fs.readFileSync(process.env.SIGNAL_LAB_TEST_CONTROL,'utf8'))}catch{}return lastControl}
// Only this isolated child sees the synthetic clock. Timers retain real time.
Date.now=()=>realNow()+Number(lastControl.clockOffsetMs||0);
function waitingForEntry(){
 if(!control().pauseWhenPending)return false;
 try{return JSON.parse(fs.readFileSync(path.join(process.env.SIGNAL_LAB_DATA_DIR,'store.json'),'utf8')).paper?.pending?.length>0}catch{return false}
}
const json=obj=>new Response(JSON.stringify(obj),{headers:{'content-type':'application/json'}});
const symbols=()=>Object.keys(control().scenarios);
const listedSymbols=()=>symbols().filter(symbol=>!control().unlisted?.includes(symbol));
const price=symbol=>Number(control().prices?.[symbol]??(control().scenarios[symbol]==='range'?100:ENTRY));
globalThis.fetch=async(input,options={})=>{
 const url=new URL(typeof input==='string'?input:input.url??String(input));
 if(['127.0.0.1','localhost','[::1]'].includes(url.hostname))return realFetch(input,options);
 if(!['GET','HEAD'].includes((options.method||'GET').toUpperCase()))throw Error('Test transport forbids external write methods');
 if(process.env.SIGNAL_LAB_TEST_REQUESTS)fs.appendFileSync(process.env.SIGNAL_LAB_TEST_REQUESTS,JSON.stringify({host:url.hostname,path:url.pathname,interval:url.searchParams.get('interval')})+'\n');
 if(url.hostname==='fapi.binance.com'){
  if(control().binanceOffline)return new Response('synthetic Binance outage',{status:503});
  if(url.pathname==='/fapi/v1/exchangeInfo')return json({symbols:listedSymbols().map(symbol=>({symbol,baseAsset:symbol.slice(0,-4),quoteAsset:'USDT',contractType:'PERPETUAL',status:'TRADING',marginAsset:'USDT',filters:[{filterType:'PRICE_FILTER',tickSize:'0.01'},{filterType:'LOT_SIZE',stepSize:'0.01',minQty:'0.01'},{filterType:'MIN_NOTIONAL',notional:'5'}]}))});
  if(url.pathname==='/fapi/v1/ticker/24hr')return json(symbols().map(symbol=>({symbol,lastPrice:String(price(symbol)),quoteVolume:'100000000',priceChangePercent:'2',highPrice:'120',lowPrice:'80',closeTime:control().restPriceFresh===false?Date.now()-100000:Date.now()})));
  if(url.pathname==='/fapi/v1/depth'){if(control().invalidQuote)return json({T:Date.now(),bids:[],asks:[]});const p=price(url.searchParams.get('symbol'));return json({T:Date.now(),bids:[[(p-.01).toFixed(2),'1000']],asks:[[(p+.01).toFixed(2),'1000']]});}
  if(url.pathname==='/fapi/v1/aggTrades'){
   if(control().profileUnavailable)return json([]);
   const symbol=url.searchParams.get('symbol'),p=price(symbol),start=Number(url.searchParams.get('startTime'))||Date.now()-300000;
   return json(Array.from({length:120},(_,i)=>({a:i+1,p:(p+([10,16,22,-10,-16,-22][Math.floor(i/20)]+(i%3)*.01)).toFixed(2),q:String(i%20<17?100:1),T:start+Math.floor(i*300000/119)})));
  }
  if(url.pathname==='/fapi/v1/klines'){
   const symbol=url.searchParams.get('symbol'),interval=url.searchParams.get('interval');
   if(!['1h','4h','1d'].includes(interval))throw Error('Test transport forbids sub-hour/unknown candles');
   const cfg=control();
   const series=marketSeries(cfg.scenarios[symbol],cfg.marketNow??Date.now());
   return json(interval==='1h'?series.h1:interval==='4h'?series.h4:[]);
  }
 }
 if(url.hostname==='omni-client-api.prod.ap-northeast-1.variational.io'&&url.pathname==='/metadata/v2/stats'){
  if(control().venueOffline)return new Response('fixture outage',{status:503});
  return json({listings:symbols().filter(s=>!control().unlisted?.includes(s)).map(symbol=>{
   const p=price(symbol),q={bid:String(p*(1-.00005)),ask:String(p*(1+.00005))};
   return {ticker:symbol.slice(0,-4)+'-PERP',contract_type:'perpetual',mark_price:String(p),volume_24h:'100000000',
    quotes:control().invalidQuote?undefined:{updated_at:new Date().toISOString(),base:q,size_1k:q},funding:{next:{interval_rate:'0'},interval_seconds:28800}};
  })});
 }
 if(['decrypt.co','www.coindesk.com','cointelegraph.com'].includes(url.hostname))return new Response('<rss><channel></channel></rss>',{headers:{'content-type':'application/xml'}});
 throw Error('Test transport blocked external destination: '+url.hostname);
};
globalThis.WebSocket=class SyntheticWebSocket extends EventTarget{
 static OPEN=1;
 constructor(url){super();this.url=String(url);this.readyState=0;this.lastTrigger=null;
  queueMicrotask(()=>{this.readyState=1;this.dispatchEvent(new Event('open'))});
  this.timer=setInterval(()=>{
   if(this.readyState!==1)return;
   const cfg=control();
   if(this.url.includes('miniTicker')){
    if(cfg.emit&&!waitingForEntry())this.emit(symbols().map(symbol=>({s:symbol,c:String(price(symbol)),st:1})));
   }else if(cfg.trigger!==this.lastTrigger){
    this.lastTrigger=cfg.trigger;
    for(const symbol of symbols())this.emit({data:{e:'kline',s:symbol,st:1,k:{x:Boolean(cfg.trigger),i:'1h'}}});
   }
  },60);
 }
 emit(payload){const event=new Event('message');Object.defineProperty(event,'data',{value:JSON.stringify(payload)});this.dispatchEvent(event)}
 send(text){const command=JSON.parse(text);if(command.method==='SUBSCRIBE')this.emit({result:null,id:command.id})}
 close(){if(this.readyState===3)return;this.readyState=3;clearInterval(this.timer);this.dispatchEvent(new Event('close'))}
};
