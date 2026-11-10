// Offline integration test fixture. Never imported in production.
const realFetch=globalThis.fetch;
const respond=(obj,status=200)=>new Response(JSON.stringify(obj),{status,headers:{'Content-Type':'application/json'}});
const fixtures={
 binance:{symbols:[
  {symbol:'BTCUSDT',baseAsset:'BTC',quoteAsset:'USDT',contractType:'PERPETUAL',status:'TRADING',marginAsset:'USDT',filters:[{filterType:'PRICE_FILTER',tickSize:'0.01'},{filterType:'LOT_SIZE',stepSize:'0.001',minQty:'0.001'},{filterType:'MIN_NOTIONAL',notional:'5'}]},
  {symbol:'ETHUSDT',baseAsset:'ETH',quoteAsset:'USDT',contractType:'PERPETUAL',status:'TRADING',marginAsset:'USDT',filters:[{filterType:'PRICE_FILTER',tickSize:'0.01'},{filterType:'LOT_SIZE',stepSize:'0.001',minQty:'0.001'},{filterType:'MIN_NOTIONAL',notional:'5'}]},
  {symbol:'SOLUSDT',baseAsset:'SOL',quoteAsset:'USDT',contractType:'PERPETUAL',status:'TRADING',marginAsset:'USDT',filters:[{filterType:'PRICE_FILTER',tickSize:'0.01'},{filterType:'LOT_SIZE',stepSize:'0.001',minQty:'0.001'},{filterType:'MIN_NOTIONAL',notional:'5'}]},
  {symbol:'XAUUSDT',baseAsset:'XAU',quoteAsset:'USDT',contractType:'PERPETUAL',status:'TRADING',marginAsset:'USDT',filters:[{filterType:'PRICE_FILTER',tickSize:'0.01'},{filterType:'LOT_SIZE',stepSize:'0.001',minQty:'0.001'},{filterType:'MIN_NOTIONAL',notional:'5'}]},
  {symbol:'1000PEPEUSDT',baseAsset:'1000PEPE',quoteAsset:'USDT',contractType:'PERPETUAL',status:'TRADING',marginAsset:'USDT',filters:[{filterType:'PRICE_FILTER',tickSize:'0.01'},{filterType:'LOT_SIZE',stepSize:'0.001',minQty:'0.001'},{filterType:'MIN_NOTIONAL',notional:'5'}]}]},
 tickers:['BTCUSDT','ETHUSDT','SOLUSDT','XAUUSDT','1000PEPEUSDT'].map((symbol,i)=>({symbol,lastPrice:String(81000/(i+1)),priceChangePercent:'2',quoteVolume:String((10-i)*1e7),highPrice:'90000',lowPrice:'200',closeTime:Date.now()}))

};
globalThis.fetch=async(input,options)=>{
 const url=String(input);
 if(url.startsWith('https://fapi.binance.com')){
  if(url.includes('exchangeInfo'))return respond(fixtures.binance);
  if(url.includes('ticker/24hr'))return respond(fixtures.tickers);
  if(url.includes('/depth?'))return respond({T:Date.now(),bids:[['80999.99','100']],asks:[['81000.01','100']]});
  if(url.includes('/aggTrades?'))return respond([]);
  if(url.includes('/klines?'))return respond([]);
 }
// Execution-venue public data, shaped as in the official BingX and Gate.io API documentation.
 if(url.startsWith('https://open-api.bingx.com/openApi/swap/v2/quote/')){
  const u=new URL(url);
  if(u.pathname.endsWith('/contracts'))return respond({code:0,msg:'',data:[
   {symbol:'BTC-USDT',currency:'USDT',asset:'BTC',pricePrecision:1,quantityPrecision:4,tradeMinQuantity:0.0001,tradeMinUSDT:2,status:1,apiStateOpen:'true',apiStateClose:'true',takerFeeRate:0.0005,makerFeeRate:0.0002},
   {symbol:'ETH-USDT',currency:'USDT',asset:'ETH',pricePrecision:2,quantityPrecision:2,tradeMinQuantity:0.01,tradeMinUSDT:2,status:1,apiStateOpen:'true',apiStateClose:'true'},
   {symbol:'SOL-USDT',currency:'USDT',asset:'SOL',pricePrecision:3,quantityPrecision:1,tradeMinQuantity:0.1,tradeMinUSDT:2,status:1,apiStateOpen:'false',apiStateClose:'true'}]});
  if(u.pathname.endsWith('/depth'))return respond({code:0,msg:'',data:{T:Date.now(),bids:[['80999.5','1.2'],['80999.4','2']],asks:[['81001.0','3'],['81000.5','0.5']]}});
 }
 if(url.startsWith('https://api.gateio.ws/api/v4/futures/usdt/')){
  const u=new URL(url);
  if(u.pathname.endsWith('/contracts'))return respond([
   {name:'BTC_USDT',type:'direct',quanto_multiplier:'0.0001',order_price_round:'0.1',order_size_min:1,status:'trading',in_delisting:false,mark_price:'81000'},
   {name:'ETH_USDT',type:'direct',quanto_multiplier:'0.01',order_price_round:'0.05',order_size_min:1,status:'trading',in_delisting:false,mark_price:'40500'}]);
  if(u.pathname.endsWith('/order_book'))return respond({current:Date.now()/1000,update:Date.now()/1000,asks:[{p:'81000.6',s:120}],bids:[{p:'81000.2',s:300}]});
 }
 if(url.startsWith('https://api.telegram.org'))return respond({ok:true});
 if(['127.0.0.1','localhost','[::1]'].includes(new URL(url).hostname))return realFetch(input,options);
 throw Error('Unmocked external test destination blocked');
};
globalThis.WebSocket=class FakeWebSocket extends EventTarget {
 constructor(url){super();this.url=url;queueMicrotask(()=>this.dispatchEvent(new Event('open')))}
 close(){this.dispatchEvent(new Event('close'))}
};
