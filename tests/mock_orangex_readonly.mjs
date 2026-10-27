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
    instrumentName:url.searchParams.get('instrument_name'),depth:url.searchParams.get('depth'),hasAuthorization:headers.has('authorization')})+'\n');
  const mode=process.env.SIGNAL_LAB_TEST_ORANGEX_BOOK;
  if(mode&&url.hostname==='api.orangex.com'&&url.pathname==='/api/v1/public/get_order_book'&&(options.method||'GET')==='GET'){
   if(headers.has('authorization')||url.searchParams.get('depth')!=='20')throw Error('TEST_ONLY: invalid public book parameters');
   const prices={'BTC-USDT-PERPETUAL':81000,'ETH-USDT-PERPETUAL':2500,'SOL-USDT-PERPETUAL':180};
   const price=prices[url.searchParams.get('instrument_name')];
   if(!price)throw Error('TEST_ONLY: unexpected public book instrument');
   const result={instrument_name:url.searchParams.get('instrument_name'),bids:[[price-.01,2]],asks:[[price+.01,3]],version:7};
   if(mode!=='missing-time')result.timestamp=Date.now()-(mode==='old-time'?180000:0);
   return new Response(JSON.stringify({jsonrpc:'2.0',result}),{headers:{'content-type':'application/json'}});
  }
  throw Error('TEST_ONLY: OrangeX external requests are blocked');
 }
 return previous(input,options);
};
