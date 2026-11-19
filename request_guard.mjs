// Local HTTP request guard. Pure decision functions: no network, storage or orders.
//
// The dashboard trusts the loopback peer address, so any web page opened in the
// same browser could otherwise reach it in two ways:
//  1. DNS rebinding - an attacker-controlled name is re-pointed at 127.0.0.1 and
//     the browser then treats our responses as readable by that page.
//  2. Cross-site requests - a "simple" POST needs no CORS preflight, so settings
//     and journal records could be changed without the user noticing.
// A rebinding request always carries the attacker's DNS name in its Host header,
// and a cross-site browser request always identifies itself through Origin or
// Sec-Fetch-Site. Non-browser clients (supervisor, CLI, tests) send neither.
import net from 'node:net';
import os from 'node:os';

const UNSAFE_METHODS=new Set(['POST','PUT','PATCH','DELETE']);
const SAME_SITE_VALUES=new Set(['same-origin','none']);
const DNS_NAME=/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;
const text=value=>typeof value==='string'?value.trim().toLowerCase():'';

/** Split a Host header (or a bare name) into hostname and port. Returns null when malformed. */
export function parseAuthority(value){
 const raw=text(value);
 if(!raw||raw.length>255||/[\s/\\@?#]/.test(raw))return null;
 if(raw.startsWith('[')){
  const end=raw.indexOf(']');
  if(end<0)return null;
  const hostname=raw.slice(1,end),rest=raw.slice(end+1);
  if(!net.isIPv6(hostname)||rest&&!/^:\d{1,5}$/.test(rest))return null;
  const port=rest.slice(1);
  if(port&&Number(port)>65535)return null;
  return {hostname,port,ipLiteral:true};
 }
 const match=/^([^:]+)(?::(\d{1,5}))?$/.exec(raw);
 if(!match)return null;
 const hostname=match[1].replace(/\.$/,''),port=match[2]??'';
 if(!hostname||port&&Number(port)>65535)return null;
 if(net.isIPv4(hostname))return {hostname,port,ipLiteral:true};
 // A dotted all-numeric name that is not a valid IPv4 address is never a real host.
 if(!DNS_NAME.test(hostname)||/^[0-9.]+$/.test(hostname))return null;
 return {hostname,port,ipLiteral:false};
}

/** DNS names that may address this server. IP literals are always accepted by
 * evaluateRequest because a rebinding attack cannot produce one in Host. */
export function allowedHostNames({env=process.env,hostname=os.hostname()}={}){
 const names=new Set(['localhost']);
 const own=parseAuthority(hostname);
 if(own&&!own.ipLiteral){
  names.add(own.hostname);
  if(!own.hostname.includes('.'))names.add(own.hostname+'.local');
 }
 // Optional opt-in for a private DNS name, e.g. ALLOWED_HOSTS=signal.lan
 for(const item of String(env?.ALLOWED_HOSTS??'').split(',')){
  const parsed=parseAuthority(item);
  if(parsed&&!parsed.ipLiteral)names.add(parsed.hostname);
 }
 return names;
}

function expectedProtocol(host,headers){
 const fwd=text(headers?.['x-forwarded-proto']).split(',')[0].trim();
 if(fwd==='https'||fwd==='http')return fwd+':';
 return host.port==='443'?'https:':'http:';
}

function sameOrigin(origin,host,headers){
 let url;
 try{url=new URL(origin)}catch{return false}
 if(!['http:','https:'].includes(url.protocol))return false;
 const wantProto=expectedProtocol(host,headers);
 if(url.protocol!==wantProto)return false;
 const fallback=wantProto==='https:'?'443':'80';
 const originHost=url.hostname.replace(/^\[|\]$/g,'').replace(/\.$/,'').toLowerCase();
 return originHost===host.hostname&&(url.port||fallback)===(host.port||fallback);
}

const refuse=(code,message)=>({ok:false,status:403,code,message});

/** Decide whether a request may reach the application routes.
 * `headers` uses Node's lower-cased header names. */
export function evaluateRequest({method='GET',path='/',headers={}}={},{hostNames=allowedHostNames()}={}){
 const host=parseAuthority(headers?.host);
 if(!host||!(host.ipLiteral||hostNames.has(host.hostname)))
  return refuse('HOST_NOT_ALLOWED','허용되지 않은 접속 주소입니다. PC는 http://127.0.0.1 주소로, 휴대폰은 실행 창에 표시된 IP 주소로 접속하세요. 별도 도메인 이름을 쓰려면 .env의 ALLOWED_HOSTS에 추가해야 합니다.');
 const verb=String(method||'GET').toUpperCase(),origin=headers.origin,site=text(headers['sec-fetch-site']);
 const crossSite=(origin!==undefined&&!sameOrigin(String(origin),host,headers))||(site!==''&&!SAME_SITE_VALUES.has(site));
 const protectedPath=typeof path==='string'&&(path==='/events'||path==='/api'||path.startsWith('/api/'));
 if(crossSite&&(UNSAFE_METHODS.has(verb)||protectedPath))
  return refuse('CROSS_SITE_REQUEST_BLOCKED','다른 웹사이트에서 보낸 요청은 차단됩니다. Signal Lab 화면에서 직접 실행하세요.');
 return {ok:true,host};
}

/** Response headers that keep other sites from framing or sniffing local pages. */
export const SECURITY_HEADERS=Object.freeze({
 'X-Content-Type-Options':'nosniff',
 'X-Frame-Options':'DENY',
 'Referrer-Policy':'no-referrer',
 'Cross-Origin-Resource-Policy':'same-origin'
});
