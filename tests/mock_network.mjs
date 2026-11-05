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
 tickers:['BTCUSDT','ETHUSDT','SOLUSDT','XAUUSDT','1000PEPEUSDT'].map((symbol,i)=>({symbol,lastPrice:String(81000/(i+1)),priceChangePercent:'2',quoteVolume:String((10-i)*1e7),highPrice:'90000',lowPrice:'200',closeTime:Date.now()})),
 variational:{listings:[
  {ticker:'BTC-PERP',contract_type:'perpetual',mark_price:'81000.12',base_spread_bps:'1.0',volume_24h:'40000000',funding:{last:{interval_rate:'0.00008'},next:{interval_rate:'0.00009'},interval_seconds:28800,next_timestamp:Math.floor(Date.now()/1000)+28800},quotes:{updated_at:new Date().toISOString(),base:{bid:'80995',ask:'81005'},size_1k:{bid:'80995',ask:'81005'}}},
  {ticker:'ETH-PERP',contract_type:'perpetual',mark_price:'2500.01',base_spread_bps:'0.8',volume_24h:'20000000'},
  {ticker:'XAU-SWAP',contract_type:'swap',mark_price:'4000'},
  {ticker:'PEPE-PERP',contract_type:'perpetual',mark_price:'0.0001'}]}
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
 if(url.startsWith('https://omni-client-api.prod.ap-northeast-1.variational.io'))return respond(fixtures.variational);
 if(url.startsWith('https://api.telegram.org'))return respond({ok:true});
 if(['127.0.0.1','localhost','[::1]'].includes(new URL(url).hostname))return realFetch(input,options);
 throw Error('Unmocked external test destination blocked');
};
globalThis.WebSocket=class FakeWebSocket extends EventTarget {
 constructor(url){super();this.url=url;queueMicrotask(()=>this.dispatchEvent(new Event('open')))}
 close(){this.dispatchEvent(new Event('close'))}
};
