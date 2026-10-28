// Test-only transport: existing public scanner fixtures and a hard OrangeX
// network guard. No API credentials, real account, or order endpoint is used.
import './mock_runtime.mjs';
import fs from 'node:fs';

const previous=globalThis.fetch;
globalThis.fetch=async(input,options={})=>{
 const value=typeof input==='string'?input:input?.url??String(input);
 const url=new URL(value);
 if(url.hostname==='orangex.com'||url.hostname.endsWith('.orangex.com')){
  const headers=new Headers(options.headers||{});
  if(process.env.SIGNAL_LAB_TEST_ORANGEX_REQUESTS)
   fs.appendFileSync(process.env.SIGNAL_LAB_TEST_ORANGEX_REQUESTS,JSON.stringify({host:url.hostname,method:options.method||'GET',path:url.pathname,
    instrumentName:url.searchParams.get('instrument_name'),currency:url.searchParams.get('currency'),depth:url.searchParams.get('depth'),hasAuthorization:headers.has('authorization')})+'\n');
  const mode=process.env.SIGNAL_LAB_TEST_ORANGEX_BOOK;
  // Synthetic protocol fixtures only: these values are not Windows observations.
  if(mode&&url.hostname==='api.orangex.com'&&(options.method||'GET')==='GET'){
   const prices={'BTC-USDT-PERPETUAL':81000,'ETH-USDT-PERPETUAL':2500,'SOL-USDT-PERPETUAL':180};
   if(headers.has('authorization'))throw Error('TEST_ONLY: private header on public market request');
   if(url.pathname==='/api/v1/public/get_instruments'){
    const area=url.searchParams.get('currency');
    if(!['BTC','ETH','SPOT','USDT','PERPETUAL'].includes(area))throw Error('TEST_ONLY: required trading area missing');
    // Deliberately cross asset names and area names: discovery must not assume
    // currency is the settlement asset or that SOL can only be in a SOL area.
    const names=area==='BTC'?['BTC-USDT-PERPETUAL','SOL-USDT-PERPETUAL']:area==='ETH'?['ETH-USDT-PERPETUAL']:[];
    const result=names.map(instrument_name=>({instrument_name,is_active:true,min_trade_amount:1,min_qty:.001,
     min_notional:5,tick_size:.01,contract_size:1,qty_step:.001,maker_commission:.0002,taker_commission:.0005,
     base_currency:'USDT',quote_currency:instrument_name.split('-')[0]}));
    return Response.json({jsonrpc:'2.0',result});
   }
   if(url.pathname==='/api/v1/public/tickers'){
    const instrument_name=url.searchParams.get('instrument_name'),price=prices[instrument_name];
    if(!price)throw Error('TEST_ONLY: required ticker instrument missing');
    const result={instrument_name,mark_price:price};
    if(mode!=='missing-time')result.timestamp=Date.now()-(['old-time','old-mark'].includes(mode)?180000:0);
    return Response.json({jsonrpc:'2.0',result});
   }
  }
  if(mode&&url.hostname==='api.orangex.com'&&url.pathname==='/api/v1/public/get_order_book'&&(options.method||'GET')==='GET'){
   if(headers.has('authorization')||url.searchParams.get('depth')!=='20')throw Error('TEST_ONLY: invalid public book parameters');
   const prices={'BTC-USDT-PERPETUAL':81000,'ETH-USDT-PERPETUAL':2500,'SOL-USDT-PERPETUAL':180};
   const price=prices[url.searchParams.get('instrument_name')];
   if(!price)throw Error('TEST_ONLY: unexpected public book instrument');
   const result={instrument_name:url.searchParams.get('instrument_name'),bids:[[price-.01,2]],asks:[[price+.01,3]],version:7};
   if(mode!=='missing-time')result.timestamp=Date.now()-(['old-time','old-book'].includes(mode)?180000:0);
   return new Response(JSON.stringify({jsonrpc:'2.0',result}),{headers:{'content-type':'application/json'}});
  }
  throw Error('TEST_ONLY: OrangeX external requests are blocked');
 }
 return previous(input,options);
};
