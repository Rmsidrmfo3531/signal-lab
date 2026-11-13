// Article detail for one news item, fetched only when the user opens it: the main paragraphs of
// the publisher's page (a short excerpt for private reading, with the link to the original),
// translated to Korean. Only the RSS sources' own sites are fetched (no arbitrary URLs).
import {FEEDS} from './news.mjs';

const ALLOWED=new Set(FEEDS.map(f=>new URL(f.url).hostname.replace(/^(www\.|search\.)/,'')).concat(['cnbc.com']));
export const MAX_PARAGRAPHS=8,MAX_CHARS=2200;
const BOILER=/subscribe|newsletter|cookie|sign up|all rights reserved|follow us|read more|disclaimer|advertis|©|getty images|related:|this article|editor's note|terms of (use|service)/i;
const decode=v=>String(v).replace(/&#(x[0-9a-f]+|\d+);/gi,(_,x)=>{const n=x[0].toLowerCase()==='x'?parseInt(x.slice(1),16):Number(x);return Number.isFinite(n)&&n>0&&n<0x110000?String.fromCodePoint(n):''})
 .replace(/&nbsp;/g,' ').replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/&#39;|&apos;/g,"'").replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&rsquo;|&lsquo;/g,"'").replace(/&rdquo;|&ldquo;/g,'"').replace(/&mdash;/g,'—').replace(/&ndash;/g,'–').replace(/&hellip;/g,'…');

/** Is this link on one of the configured news sites? */
export function articleAllowed(link){
 try{const u=new URL(link);if(u.protocol!=='https:'||u.username||u.password||u.port)return false;const h=u.hostname.replace(/^www\./,'');return [...ALLOWED].some(a=>h===a||h.endsWith('.'+a))}catch{return false}
}

/** Main text paragraphs from article HTML (article/main element first, then the whole page). */
export function extractParagraphs(html){
 let body=String(html).replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<noscript[\s\S]*?<\/noscript>|<!--[\s\S]*?-->/gi,' ');
 const scope=body.match(/<article[\s>][\s\S]*?<\/article>/i)?.[0]||body.match(/<main[\s>][\s\S]*?<\/main>/i)?.[0]||body;
 const out=[];let total=0;
 for(const m of scope.matchAll(/<p[\s>][\s\S]*?<\/p>/gi)){
  const text=decode(m[0].replace(/<[^>]+>/g,' ')).replace(/\s+/g,' ').trim();
  if(text.length<60||BOILER.test(text)||out.includes(text))continue;
  out.push(text);total+=text.length;
  if(out.length>=MAX_PARAGRAPHS||total>=MAX_CHARS)break;
 }
 return out;
}

const cache=new Map();
/** {paragraphs, paragraphsKo, translated} for one article; cached per link for 6 hours. */
export async function articleDetail(article,{fetcher=fetch,translate,now=Date.now(),timeoutMs=10000}={}){
 if(!article?.link||!articleAllowed(article.link))return {ok:false,error:'SOURCE_NOT_ALLOWED'};
 const hit=cache.get(article.link);if(hit&&now-hit.at<6*3600000)return hit.value;
 let html;
 try{
  // Redirects are followed by hand so every hop stays on a source site (never an internal address).
  let link=article.link,r;
  for(let hop=0;;hop++){
   r=await fetcher(link,{headers:{'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36','Accept':'text/html'},redirect:'manual',signal:AbortSignal.timeout(timeoutMs)});
   const st=r.status??(r.ok?200:0);if(!(st>=300&&st<400))break;
   const next=r.headers?.get?.('location');if(!next||hop>=3)return {ok:false,error:'TOO_MANY_REDIRECTS'};
   link=new URL(next,link).href;if(!articleAllowed(link))return {ok:false,error:'REDIRECTED_OUTSIDE_SOURCE'};
  }
  if(!r.ok)return {ok:false,error:'HTTP_'+r.status};
  if(r.url&&!articleAllowed(r.url))return {ok:false,error:'REDIRECTED_OUTSIDE_SOURCE'};
  html=(await r.text()).slice(0,3_000_000);
 }catch(e){return {ok:false,error:e?.name==='TimeoutError'?'TIMEOUT':'FETCH_FAILED'}}
 const paragraphs=extractParagraphs(html);
 if(!paragraphs.length)return {ok:false,error:'NO_TEXT'};
 let paragraphsKo=null;
 if(typeof translate==='function'){
  try{
   // One request: paragraphs joined with a marker line, split back after translation.
   const SEP='\n|||\n',res=await translate({text:paragraphs.join(SEP),signal:AbortSignal.timeout(timeoutMs)});
   const text=typeof res==='string'?res:res?.translatedText||'';
   const parts=text.split(/\s*\|\|\|\s*/).map(s=>s.trim()).filter(Boolean);
   paragraphsKo=/[가-힣]/.test(text)?(parts.length===paragraphs.length?parts:[text.replace(/\s*\|\|\|\s*/g,'\n\n').trim()]):null;
  }catch{paragraphsKo=null}
 }
 const value={ok:true,paragraphs,paragraphsKo,translated:Boolean(paragraphsKo),excerpt:true};
 cache.set(article.link,{at:now,value});while(cache.size>200)cache.delete(cache.keys().next().value);
 return value;
}
