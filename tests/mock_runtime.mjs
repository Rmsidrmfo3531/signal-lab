import './mock_network.mjs';
const previous=globalThis.fetch;
const t=Date.now()-3601000;
function row(time,open,high,low,close,volume,interval){return[time,String(open),String(high),String(low),String(close),String(volume),time+interval-1,String(close*volume)];}
const factor=81000/102;
const h1=Array.from({length:149},(_,i)=>{const v=i<118?90+i*.07:100;return row(t+(i-149)*3600000,v*factor,(v+.35)*factor,(v-.35)*factor,v*factor,100,3600000)});
h1.push(row(t,100*factor,103*factor,99.9*factor,102*factor,230,3600000));
const h4=Array.from({length:110},(_,i)=>{const v=70+i*.28;return row(t+(i-110)*4*3600000,(v-.1)*factor,(v+.35)*factor,(v-.35)*factor,v*factor,300,4*3600000)});
const m15=Array.from({length:100},(_,i)=>{const v=99+i*.03;return row(t+(i-99)*900000,(v-.1)*factor,(v+.3)*factor,(v-.3)*factor,v*factor,300,900000)});
globalThis.fetch=async(input,options)=>{const url=String(input);
 if(url.includes('/klines?')){const interval=new URL(url).searchParams.get('interval');return new Response(JSON.stringify(interval==='1h'?h1:interval==='4h'?h4:m15),{headers:{'Content-Type':'application/json'}})}
 if(url==='https://decrypt.co/feed'||url.includes('coindesk.com/arc/outboundfeeds/rss')||url==='https://cointelegraph.com/rss'){
  const pub=new Date().toUTCString();return new Response(`<rss><channel><item><title>SEC announces new Bitcoin ETF rules</title><link>https://news.example/etf</link><pubDate>${pub}</pubDate></item></channel></rss>`,{headers:{'Content-Type':'application/xml'}})}
 return previous(input,options);
};
const ws=globalThis.WebSocket;
ws.prototype.send=function(){};
Object.defineProperty(ws.prototype,'readyState',{get(){return 1}});
Object.defineProperty(ws,'OPEN',{value:1});
