// Test-only exchange transport. All external destinations and write methods fail closed.
// Older synthetic fixtures target the base patterns: the study-material trend patterns are tested separately.
process.env.SIGNAL_TREND_GATE??='off';
process.env.BTC_LONG_FILTER??='off'; // fixtures predate the BTC 4H long filter
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
// Coins only on the execution venues (not on Binance): control().venueOnly = {SYMBOL: scenario}.
const venueOnlySymbols=()=>Object.keys(control().venueOnly||{});
globalThis.fetch=async(input,options={})=>{
 const url=new URL(typeof input==='string'?input:input.url??String(input));
 if(['127.0.0.1','localhost','[::1]'].includes(url.hostname))return realFetch(input,options);
 // Telegram API calls stay in this fixture. The bot path and token are never recorded.
 const scannerChannelId=-1001234567890;
 if(url.hostname==='api.telegram.org'&&/\/getChat$/.test(url.pathname)&&options.method==='POST'){
  const {chat_id:chatId}=JSON.parse(String(options.body));
  if(process.env.SIGNAL_LAB_TEST_REQUESTS)fs.appendFileSync(process.env.SIGNAL_LAB_TEST_REQUESTS,JSON.stringify({host:url.hostname,path:'/getChat',chatId})+'\n');
  return json({ok:true,result:{id:scannerChannelId,type:'channel'}});
 }
 if(url.hostname==='api.telegram.org'&&/\/sendMessage$/.test(url.pathname)&&(options.method||'').toUpperCase()==='POST'){
  let payload={};try{payload=JSON.parse(String(options.body))}catch{}
  if(process.env.SIGNAL_LAB_TEST_REQUESTS)fs.appendFileSync(process.env.SIGNAL_LAB_TEST_REQUESTS,JSON.stringify({host:url.hostname,path:'/sendMessage',text:payload.text,chatId:payload.chat_id,entities:payload.entities})+'\n');
  return json({ok:true,result:{message_id:1,chat:{id:payload.chat_id,type:'channel'}}});
 }
 // BingX TESTNET (VST) host, only when a test asks for it (control().fakeBingxTestnet): an in-memory
 // fake account so the live order path can run end to end. Nothing leaves this process. The real
 // live host (open-api.bingx.com) still refuses every write below.
 if(url.hostname==='open-api-vst.bingx.com'&&control().fakeBingxTestnet)return fakeBingxTestnet(url,options);
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
  if(url.pathname==='/fapi/v1/klines'&&url.searchParams.get('interval')==='15m'){
   // Volume-profile candles: heavy, narrow candles at the same six levels the old trade fixture used.
   if(control().profileUnavailable)return json([]);
   const symbol=url.searchParams.get('symbol'),p=price(symbol),limit=Number(url.searchParams.get('limit'))||288,step=900000;
   const last=Math.floor(Date.now()/step)*step,offsets=[10,16,22,-10,-16,-22];
   return json(Array.from({length:limit},(_,i)=>{const level=p+offsets[i%6],heavy=i%5!==4,lo=heavy?level:p-0.5,hi=heavy?level+0.02:p+0.5;
    return [last-(limit-1-i)*step,lo.toFixed(2),hi.toFixed(2),lo.toFixed(2),hi.toFixed(2),heavy?'100':'1',last-(limit-1-i)*step+step-1,'0',1,'0','0','0']}));
  }
  if(url.pathname==='/fapi/v1/klines'){
   const symbol=url.searchParams.get('symbol'),interval=url.searchParams.get('interval');
   if(!['1h','4h','1d'].includes(interval))throw Error('Test transport forbids sub-hour/unknown candles');
   const cfg=control();
   const series=marketSeries(cfg.scenarios[symbol],cfg.marketNow??Date.now());
   return json(interval==='1h'?series.h1:interval==='4h'?series.h4:[]);
  }
 }
// Execution venues (BingX / Gate.io) quote the same scenario price as the Binance chart.
 // While a test pauses for a pending entry, the venue books are stale so no fill can occur.
 const venueBook=symbol=>{const p=price(symbol),cfg=control(),T=waitingForEntry()?Date.now()-60000:Date.now();
  return cfg.invalidQuote?{T,bids:[],asks:[]}:{T,bids:[[(p-.01).toFixed(2),'1000']],asks:[[(p+.01).toFixed(2),'1000']]}};
 const venueListed=()=>[...listedSymbols().filter(symbol=>!control().venueUnlisted?.includes(symbol)),...venueOnlySymbols()];
 const profileRows=(symbol,limit,step=900000)=>{const p=price(symbol),last=Math.floor(Date.now()/step)*step,offsets=[10,16,22,-10,-16,-22];
  return Array.from({length:limit},(_,i)=>{const level=p+offsets[i%6],heavy=i%5!==4,lo=heavy?level:p-0.5,hi=heavy?level+0.02:p+0.5;
   return {t:(last-(limit-1-i)*step)/1000,o:lo.toFixed(2),h:hi.toFixed(2),l:lo.toFixed(2),c:hi.toFixed(2),v:heavy?'10000':'100',sum:String((heavy?100:1)*hi)}})};
 const venueCandles=(symbol,interval,limit)=>{
  if(interval==='15m')return profileRows(symbol,limit);
  const cfg=control(),series=marketSeries(cfg.venueOnly?.[symbol]??cfg.scenarios[symbol],cfg.marketNow??Date.now()),rows=interval==='1h'?series.h1:series.h4;
  return rows.slice(-limit).map(r=>({t:Number(r[0])/1000,o:String(r[1]),h:String(r[2]),l:String(r[3]),c:String(r[4]),v:String(Number(r[5])*100),sum:String(Number(r[5])*Number(r[4]))}))};
 if(url.hostname==='open-api.bingx.com'){
  const live=control(),liveIncome=live.fakeBingxLiveIncome;
  if(url.pathname==='/openApi/swap/v2/trade/order'&&Array.isArray(live.fakeBingxLiveOrders)){
   const order=live.fakeBingxLiveOrders.find(o=>o.orderId===url.searchParams.get('orderId')&&o.symbol===url.searchParams.get('symbol'));
   return json({code:0,data:{order:order??null}});
  }
  if(url.pathname==='/openApi/swap/v2/trade/allFillOrders'&&Array.isArray(live.fakeBingxLiveFills)){
   const from=Number(url.searchParams.get('startTs')),to=Number(url.searchParams.get('endTs'));
   return json({code:0,data:live.fakeBingxLiveFills.filter(f=>from<=f.time&&f.time<=to)});
  }
  if(liveIncome&&url.pathname.startsWith('/openApi/swap/')&&url.pathname.includes('/user/')){
   if(options?.method!=='GET')throw Error('Live account fixture only permits GET');
   if(url.pathname.endsWith('/balance'))return json({code:100001,msg:'Test balance unavailable'});
   if(url.pathname.endsWith('/positions'))return json({code:0,data:live.fakeBingxLivePositions??[]});
   if(url.pathname.endsWith('/income')){
    const start=Number(url.searchParams.get('startTime')),end=Number(url.searchParams.get('endTime'));
    const rows=liveIncome.filter(row=>row.time>=start&&row.time<end);
    return json({code:0,data:rows.length?rows:null});
   }
  }
  if(url.pathname==='/openApi/swap/v2/quote/contracts')return json({code:0,msg:'',data:venueListed().map(symbol=>({symbol:symbol.slice(0,-4)+'-USDT',currency:'USDT',asset:symbol.slice(0,-4),
   pricePrecision:2,quantityPrecision:2,tradeMinQuantity:0.01,tradeMinUSDT:5,status:1,apiStateOpen:'true',apiStateClose:'true'}))});
  if(url.pathname==='/openApi/swap/v2/quote/ticker')return json({code:0,msg:'',data:venueListed().map(symbol=>({symbol:symbol.slice(0,-4)+'-USDT',lastPrice:String(price(symbol)),quoteVolume:'50000000'}))});
  if(url.pathname==='/openApi/swap/v3/quote/klines'){const symbol=url.searchParams.get('symbol').replace('-',''),interval=url.searchParams.get('interval');
   if(!['15m','1h','4h'].includes(interval))throw Error('Test transport forbids other venue candles');
   return json({code:0,msg:'',data:venueCandles(symbol,interval,Number(url.searchParams.get('limit'))||100).map(k=>({time:k.t*1000,open:k.o,high:k.h,low:k.l,close:k.c,volume:String(Number(k.v)/100)}))})}
  if(url.pathname==='/openApi/swap/v2/quote/depth')return json({code:0,msg:'',data:venueBook(url.searchParams.get('symbol').replace('-',''))});
 }
 if(url.hostname==='api.gateio.ws'){
  if(url.pathname==='/api/v4/futures/usdt/contracts')return json(venueListed().map(symbol=>({name:symbol.slice(0,-4)+'_USDT',type:'direct',quanto_multiplier:'0.01',
   order_price_round:'0.01',order_size_min:1,status:'trading',in_delisting:false})));
  if(url.pathname==='/api/v4/futures/usdt/tickers')return json(venueListed().map(symbol=>({contract:symbol.slice(0,-4)+'_USDT',last:String(price(symbol)),volume_24h_quote:'50000000'})));
  if(url.pathname==='/api/v4/futures/usdt/candlesticks'){const symbol=url.searchParams.get('contract').replace('_',''),interval=url.searchParams.get('interval');
   if(!['15m','1h','4h'].includes(interval))throw Error('Test transport forbids other venue candles');
   return json(venueCandles(symbol,interval,Number(url.searchParams.get('limit'))||100))}
  if(url.pathname==='/api/v4/futures/usdt/order_book'){const b=venueBook(url.searchParams.get('contract').replace('_',''));
   return json({current:b.T/1000,asks:b.asks.map(([p,s])=>({p,s:Number(s)*100})),bids:b.bids.map(([p,s])=>({p,s:Number(s)*100}))})}
 }
 // Market caps: control().marketCaps = {SYMBOL: USD}; prices follow the scenario price.
 if(url.hostname==='api.coingecko.com'&&url.pathname==='/api/v3/coins/markets'){
  if(control().marketCapsOffline)return new Response('synthetic outage',{status:503});
  return json(Object.entries(control().marketCaps||{}).map(([symbol,cap])=>({id:symbol.toLowerCase(),symbol:symbol.replace(/USDT$/,'').toLowerCase(),market_cap:cap,current_price:price(symbol)})))}
 if(['decrypt.co','www.coindesk.com','cointelegraph.com'].includes(url.hostname))return new Response('<rss><channel></channel></rss>',{headers:{'content-type':'application/xml'}});
 throw Error('Test transport blocked external destination: '+url.hostname);
};
const vst={orders:[],positions:new Map(),id:5000};
function fakeBingxTestnet(url,options){
 const method=(options.method||'GET').toUpperCase(),q=Object.fromEntries(url.searchParams),p=url.pathname,ok=data=>json({code:0,msg:'',data});
 // Logged without the query (it carries the signature): method and path only.
 if(process.env.SIGNAL_LAB_TEST_REQUESTS)fs.appendFileSync(process.env.SIGNAL_LAB_TEST_REQUESTS,JSON.stringify({host:url.hostname,method,path:p,type:q.type??null,stopPrice:q.stopPrice??null})+'\n');
 const mark=symbol=>price(String(symbol).replace('-',''));
 if(p==='/openApi/swap/v1/positionSide/dual')return ok({dualSidePosition:'false'});
 if(p==='/openApi/swap/v3/user/balance'){
  const sample=control(),equity=String(sample.fakeBingxTestnetEquity??100000);
  return ok(sample.fakeBingxTestnetBalances??[{asset:'USDT',balance:equity,equity,availableMargin:equity}]);
 }
 if(p==='/openApi/swap/v2/trade/marginType')return method==='GET'?ok({marginType:'CROSSED'}):ok({});
 if(p==='/openApi/swap/v2/trade/leverage')return method==='GET'?ok({maxLongLeverage:50,maxShortLeverage:50}):ok({symbol:q.symbol,leverage:Number(q.leverage)});
 if(p==='/openApi/swap/v2/trade/order'&&method==='POST'){
  const o={orderId:String(++vst.id),symbol:q.symbol,type:q.type,side:q.side,clientOrderId:q.clientOrderId??null,quantity:q.quantity,price:q.price??null,stopPrice:q.stopPrice??null};
  if(q.type==='MARKET'&&!q.reduceOnly){
   const avg=mark(q.symbol),sign=q.side==='BUY'?1:-1;vst.positions.set(q.symbol,{amt:sign*Number(q.quantity),avg});o.avgPrice=String(avg);
   if(q.stopLoss){const sl=JSON.parse(q.stopLoss);vst.orders.push({orderId:String(++vst.id),symbol:q.symbol,type:'STOP_MARKET',stopPrice:String(sl.stopPrice)})}
  }else vst.orders.push(o);
  return ok({order:o});
 }
 if(p==='/openApi/swap/v2/trade/order'&&method==='GET'){const o=vst.orders.find(x=>x.clientOrderId===q.clientOrderId);return o?ok({order:o}):json({code:80016,msg:'order not exist'})}
 if(p==='/openApi/swap/v2/trade/order'&&method==='DELETE'){vst.orders=vst.orders.filter(o=>o.orderId!==q.orderId);return ok({order:{orderId:q.orderId}})}
 if(p==='/openApi/swap/v2/trade/openOrders')return ok({orders:vst.orders.filter(o=>o.symbol===q.symbol)});
 if(p==='/openApi/swap/v2/user/positions'){const x=vst.positions.get(q.symbol);
  return ok(x&&x.amt?[{symbol:q.symbol,positionAmt:String(x.amt),avgPrice:String(x.avg),markPrice:String(mark(q.symbol)),unrealizedProfit:String((mark(q.symbol)-x.avg)*x.amt)}]:[])}
 if(p==='/openApi/swap/v2/user/income')return ok([]);
 throw Error('fake BingX testnet: unexpected '+method+' '+p);
}
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
