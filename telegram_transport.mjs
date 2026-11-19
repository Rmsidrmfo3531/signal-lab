import https from 'node:https';

const CONNECT_ERRORS=new Set(['ENETUNREACH','ENETDOWN','EHOSTUNREACH','EADDRNOTAVAIL','ECONNREFUSED','ENOTFOUND','EAI_AGAIN','UND_ERR_CONNECT_TIMEOUT']);
const OTHER_ERRORS=new Set(['ECONNRESET','ETIMEDOUT','UND_ERR_SOCKET','UND_ERR_HEADERS_TIMEOUT','UND_ERR_BODY_TIMEOUT','ABORT_ERR',
 'CERT_HAS_EXPIRED','UNABLE_TO_VERIFY_LEAF_SIGNATURE','DEPTH_ZERO_SELF_SIGNED_CERT','ERR_TLS_CERT_ALTNAME_INVALID','TELEGRAM_RESPONSE_LIMIT']);

export function telegramNetworkCode(error){
 const causes=[error,error?.cause,...(Array.isArray(error?.cause?.errors)?error.cause.errors:[])];
 const code=causes.map(e=>e?.code).find(x=>CONNECT_ERRORS.has(x))??causes.map(e=>e?.code).find(x=>OTHER_ERRORS.has(x));
 if(code)return code;
 if(causes.some(e=>e?.name==='TimeoutError'))return 'TIMEOUT';
 if(causes.some(e=>e?.name==='AbortError'))return 'ABORT_ERR';
 return 'NETWORK_FAILED';
}

// A separate, IPv4-only HTTPS client for a remote host with a broken default route. DNS and TLS hostname
// verification still use the official Bot API hostname. The error is surfaced without request URLs or credentials.
export function postTelegramIPv4(url,payload){
 const body=JSON.stringify(payload);
 return new Promise((resolve,reject)=>{
  const req=https.request(url,{method:'POST',family:4,signal:AbortSignal.timeout(12000),
   headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)}},res=>{
   const chunks=[];let length=0;
   res.on('data',chunk=>{
    length+=chunk.length;
    if(length>65536){res.destroy(Object.assign(Error('Telegram response too large'),{code:'TELEGRAM_RESPONSE_LIMIT'}));return}
    chunks.push(chunk);
   });
   res.on('error',reject);
   res.on('end',()=>{
    const status=res.statusCode,raw=Buffer.concat(chunks).toString('utf8');
    resolve({status,ok:status>=200&&status<300,headers:{get:key=>res.headers[key.toLowerCase()]},json:async()=>JSON.parse(raw)});
   });
  });
  req.on('error',reject);req.end(body);
 });
}

export function createTelegramNetworkRecovery(post){
 let preferIPv4=false;
 return async payload=>{
  const first=preferIPv4;
  try{return {response:await post(payload,{ipv4:first}),transport:first?'IPV4':'FETCH'}}
  catch(error){
   const code=telegramNetworkCode(error);
   if(CONNECT_ERRORS.has(code)){
    const alt=!first;
    try{
     const response=await post(payload,{ipv4:alt});preferIPv4=alt;
     return {response,transport:alt?'IPV4':'FETCH'};
    }catch(fallback){return {error:`${alt?'IPV4':'FETCH'}_${telegramNetworkCode(fallback)}`,transport:alt?'IPV4':'FETCH'}}
   }
   // For an ambiguous timeout, leave the message in the outbox. Change route only on its scheduled retry.
   if(['TIMEOUT','ETIMEDOUT','ABORT_ERR','NETWORK_FAILED','ECONNRESET','UND_ERR_SOCKET','UND_ERR_HEADERS_TIMEOUT'].includes(code))preferIPv4=!first;
   return {error:`${first?'IPV4':'FETCH'}_${code}`,transport:first?'IPV4':'FETCH'};
  }
 };
}
