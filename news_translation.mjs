// Translation is an optional presentation layer over source-provided excerpts.
// This module has no network/provider credentials, persistence or message delivery.
import {createHash} from 'node:crypto';

const caches=new WeakMap();
const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const validClock=value=>Number.isSafeInteger(value)&&value>=1e12&&value<8640000000000000;
const fields=['title','summary','detail'];
const koreanOnly=value=>/[가-힣]/.test(value)&&!/[A-Za-z]{3}/.test(value);
const kst=value=>validClock(value)?new Date(value+9*3600000).toISOString().slice(0,19).replace('T',' ')+' KST':null;
const providerLabel=value=>typeof value==='string'&&/^[A-Za-z0-9_.:-]{1,60}$/.test(value)?value:'configured';
const keyFor=(text,provider)=>createHash('sha256').update(provider+'\0'+text).digest('hex');

async function requestTranslation(translate,input,timeoutMs){
 const controller=new AbortController();let timer;
 const expired=new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(Object.assign(Error('TRANSLATION_TIMEOUT'),{code:'TRANSLATION_TIMEOUT'}))},timeoutMs)});
 try{
  const value=await Promise.race([Promise.resolve().then(()=>translate({...input,signal:controller.signal})),expired]);
  const text=typeof value==='string'?value:plain(value)&&typeof value.translatedText==='string'?value.translatedText:null;
  if(!text||text.length>12000||!/[가-힣]/.test(text)||/<\/?[a-z][^>]*>/i.test(text))
   throw Object.assign(Error('TRANSLATION_RESPONSE_INVALID'),{code:'TRANSLATION_RESPONSE_INVALID'});
  return text.replace(/\s+/g,' ').trim();
 }finally{clearTimeout(timer)}
}

/** translate({text,sourceLanguage:'auto',targetLanguage:'ko',field,articleId,signal})
 * returns a string or {translatedText}. Original title/summary/detail and all
 * source/link/date metadata stay unchanged. Errors never expose provider text.
 * Successful translations are cached per injected provider, bounded by size/age.
 */
export async function translateNewsArticles(articles,{translate,now=Date.now(),providerId='configured',concurrency=4,
 timeoutMs=4000,budgetMs=15000,maxArticles=120,maxCacheEntries=500,cacheTtlMs=86400000}={}){
 if(!Array.isArray(articles)||articles.length>1000||!validClock(now)||
  !Number.isInteger(concurrency)||concurrency<1||concurrency>8||!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>10000||
  !Number.isInteger(budgetMs)||budgetMs<1||budgetMs>60000||!Number.isInteger(maxArticles)||maxArticles<1||maxArticles>120||
  !Number.isInteger(maxCacheEntries)||maxCacheEntries<1||maxCacheEntries>2000||!Number.isSafeInteger(cacheTtlMs)||cacheTtlMs<1||cacheTtlMs>7*86400000)
  throw Error('INVALID_NEWS_TRANSLATION_OPTIONS');
 const configured=typeof translate==='function',provider=providerLabel(providerId),started=performance.now(),output=Array(articles.length);
 let cursor=0,cache=configured?caches.get(translate):null;
 if(configured&&!cache){cache=new Map();caches.set(translate,cache)}
 if(cache)for(const [key,item]of cache)if(now<item.at||now-item.at>cacheTtlMs)cache.delete(key);
 const unavailable=reason=>({status:'UNAVAILABLE',errorCode:reason,translated:null,cached:false});
 async function articleAt(index){
  const article=plain(articles[index])?articles[index]:{},original=Object.fromEntries(fields.map(field=>[field,typeof article[field]==='string'?article[field]:''])),results={};
  for(const field of fields){
   const text=original[field];
   if(!text||koreanOnly(text)){results[field]={status:'NOT_REQUIRED',errorCode:null,translated:null,cached:false};continue}
   if(!configured){results[field]=unavailable('TRANSLATION_PROVIDER_NOT_CONFIGURED');continue}
   if(index>=maxArticles){results[field]=unavailable('TRANSLATION_ARTICLE_LIMIT');continue}
   const key=keyFor(text,provider),hit=cache.get(key);
   if(hit){cache.delete(key);cache.set(key,hit);results[field]={status:'COMPLETE',errorCode:null,translated:hit.text,cached:true};continue}
   const remaining=budgetMs-(performance.now()-started);
   if(remaining<1){results[field]=unavailable('TRANSLATION_TIME_BUDGET_EXCEEDED');continue}
   try{
    if(text.length>4000)throw Object.assign(Error('TRANSLATION_INPUT_LIMIT'),{code:'TRANSLATION_INPUT_LIMIT'});
    const translated=await requestTranslation(translate,{text,sourceLanguage:'auto',targetLanguage:'ko',field,
     articleId:typeof article.id==='string'&&article.id.length<=128?article.id:null},Math.max(1,Math.min(timeoutMs,Math.floor(remaining))));
    cache.set(key,{text:translated,at:now});while(cache.size>maxCacheEntries)cache.delete(cache.keys().next().value);
    results[field]={status:'COMPLETE',errorCode:null,translated,cached:false};
   }catch(error){
    const allowed=['TRANSLATION_TIMEOUT','TRANSLATION_RESPONSE_INVALID','TRANSLATION_INPUT_LIMIT'];
    results[field]={status:'ERROR',errorCode:allowed.includes(error?.code)?error.code:'TRANSLATION_PROVIDER_FAILED',translated:null,cached:false};
   }
  }
  const values=Object.values(results),success=values.some(row=>row.status==='COMPLETE'),failed=values.some(row=>['ERROR','UNAVAILABLE'].includes(row.status)),
   status=success?(failed?'PARTIAL':'COMPLETE'):values.some(row=>row.status==='ERROR')?'ERROR':
    values.some(row=>row.status==='UNAVAILABLE')?'UNAVAILABLE':'NOT_REQUIRED',
   translated=Object.fromEntries(fields.map(field=>[field+'Ko',results[field].translated]));
  output[index]={...article,...translated,original,publishedKst:kst(article.published),
   displayTitle:translated.titleKo??original.title,displaySummary:translated.summaryKo??original.summary,displayDetail:translated.detailKo??original.detail,
   translation:{status,provider:configured?provider:null,targetLanguage:'ko',translatedAt:success?now:null,
    automaticallyTranslated:success,accuracyVerified:false,errorCode:values.find(row=>row.errorCode)?.errorCode??null,
    fields:Object.fromEntries(fields.map(field=>[field,{status:results[field].status,errorCode:results[field].errorCode,cached:results[field].cached}]))}};
 }
 await Promise.all(Array.from({length:Math.min(concurrency,articles.length)},async()=>{for(;;){const index=cursor++;if(index>=articles.length)return;await articleAt(index)}}));
 return output;
}

/**
 * Default provider when NEWS_TRANSLATION_URL is not set: Google Translate's public web endpoint
 * (no key). English titles/summaries become Korean; failures leave the original text shown.
 */
export async function googleTranslate({text,signal,fetcher=fetch}){
 const body=new URLSearchParams({q:String(text).slice(0,4500)});
 const r=await fetcher('https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=ko&dt=t',
  {method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded;charset=UTF-8'},body,signal});
 if(!r.ok)throw Object.assign(Error('TRANSLATION_HTTP'),{code:'TRANSLATION_HTTP'});
 const data=await r.json();
 const parts=Array.isArray(data?.[0])?data[0].map(x=>Array.isArray(x)&&typeof x[0]==='string'?x[0]:'').join(''):'';
 return {translatedText:parts};
}
