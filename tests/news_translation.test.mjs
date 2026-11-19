import test from 'node:test';
import assert from 'node:assert/strict';
import {createOpenAINewsTranslator,translateNewsArticles} from '../news_translation.mjs';

const NOW=Date.parse('2026-11-04T07:00:00Z');
const article=()=>({id:'public-rss-item',title:'Bitcoin trading volume rises',summary:'Source-provided summary.',detail:'The publisher provided this excerpt.',
 source:'Fixture publisher',link:'https://news.example/one',published:NOW-60000,symbols:['BTC'],interpretation:'제목 기반 자동 분류 · 사실/가격 영향 확인 필요'});

test('translated display fields preserve original source excerpts, metadata, UTC time and KST display',async()=>{
 const input=article(),before=JSON.stringify(input),calls=[];
 const result=await translateNewsArticles([input],{now:NOW,providerId:'fixture-provider',translate:async request=>{
  calls.push(request);assert.equal(request.targetLanguage,'ko');assert.equal(request.sourceLanguage,'auto');assert.ok(request.signal instanceof AbortSignal);
  return {translatedText:{title:'비트코인 거래량 증가',summary:'제공처가 작성한 요약입니다.',detail:'제공처가 제공한 기사 발췌입니다.'}[request.field],arbitrarySecret:'never-export'};
 }});
 assert.equal(JSON.stringify(input),before);const out=result[0];
 for(const field of ['title','summary','detail'])assert.equal(out[field],input[field]);
 assert.equal(out.original.title,input.title);assert.equal(out.displayTitle,'비트코인 거래량 증가');assert.equal(out.summaryKo,'제공처가 작성한 요약입니다.');
 assert.equal(out.source,input.source);assert.equal(out.link,input.link);assert.equal(out.published,input.published);
 assert.equal(out.publishedKst,'2026-11-04 15:59:00 KST');assert.equal(out.translation.status,'COMPLETE');
 assert.equal(out.translation.accuracyVerified,false);assert.equal(calls.length,3);assert.doesNotMatch(JSON.stringify(out),/never-export/);
});

test('unconfigured translation preserves original readable fields with an explicit unavailable state',async()=>{
 const input=article(),out=(await translateNewsArticles([input],{now:NOW}))[0];
 assert.equal(out.translation.status,'UNAVAILABLE');assert.equal(out.translation.errorCode,'TRANSLATION_PROVIDER_NOT_CONFIGURED');
 assert.equal(out.displayTitle,input.title);assert.equal(out.titleKo,null);assert.equal(out.translation.automaticallyTranslated,false);
 assert.equal(out.displaySummary,input.summary);assert.equal(out.link,input.link);
});

test('provider failure and non-Korean or HTML responses remain errors instead of invented translations',async()=>{
 for(const translate of [async()=>{throw Error('provider secret-token-do-not-copy')},async()=>({translatedText:'unchanged English text'}),async()=>'<script>한국어</script>']){
  const input=article(),out=(await translateNewsArticles([input],{translate,now:NOW}))[0];
  assert.equal(out.translation.status,'ERROR');assert.equal(out.displayTitle,input.title);assert.equal(out.titleKo,null);
  assert.doesNotMatch(JSON.stringify(out),/secret-token-do-not-copy|<script>/);
 }
});

test('partial field success is marked partial and failed fields keep their original source excerpts',async()=>{
 const input=article(),out=(await translateNewsArticles([input],{now:NOW,translate:async({field})=>{
  if(field!=='title')throw Error('temporary outage');return '비트코인 거래량 증가';
 }}))[0];
 assert.equal(out.translation.status,'PARTIAL');assert.equal(out.displayTitle,'비트코인 거래량 증가');
 assert.equal(out.displaySummary,input.summary);assert.equal(out.summaryKo,null);assert.equal(out.translation.fields.summary.status,'ERROR');
});

test('successful translations are cached per provider and bounded caches evict rather than grow without limit',async()=>{
 let calls=0;const translate=async()=>{calls++;return '공개 기사 번역입니다.'},input=article();
 await translateNewsArticles([input],{now:NOW,translate});assert.equal(calls,3);
 const cached=await translateNewsArticles([input],{now:NOW+100,translate});assert.equal(calls,3);assert.equal(cached[0].translation.fields.title.cached,true);
 await translateNewsArticles([input],{now:NOW+86400001,translate});assert.equal(calls,6,'expired values must be retranslated');
 const one={...article(),summary:'',detail:''};let boundedCalls=0;const bounded=async()=>{boundedCalls++;return '다른 공개 기사 번역';};
 await translateNewsArticles([one],{now:NOW,translate:bounded,maxCacheEntries:1});
 await translateNewsArticles([{...one,title:'Other public article'}],{now:NOW,translate:bounded,maxCacheEntries:1});
 await translateNewsArticles([one],{now:NOW,translate:bounded,maxCacheEntries:1});assert.equal(boundedCalls,3);
});

test('slow providers time out, bounded article batches remain explicit and already Korean text requires no service',async()=>{
 const input={...article(),summary:'',detail:''};let aborted=false;
 const slow=await translateNewsArticles([input],{now:NOW,timeoutMs:5,translate:({signal})=>new Promise(()=>signal.addEventListener('abort',()=>{aborted=true}))});
 assert.equal(slow[0].translation.status,'ERROR');assert.equal(slow[0].translation.errorCode,'TRANSLATION_TIMEOUT');assert.equal(aborted,true);
 const bounded=await translateNewsArticles([input,{...input,id:'other',title:'Another headline'}],{now:NOW,maxArticles:1,translate:async()=> '제공처 기사 번역'});
 assert.equal(bounded[1].translation.status,'UNAVAILABLE');assert.equal(bounded[1].translation.errorCode,'TRANSLATION_ARTICLE_LIMIT');
 const korean=await translateNewsArticles([{...input,title:'이미 한국어로 제공된 기사'}],{now:NOW});assert.equal(korean[0].translation.status,'NOT_REQUIRED');
 assert.equal(korean[0].displayTitle,'이미 한국어로 제공된 기사');
});

test('Google provider: short text as GET, failures recorded for the news status line',async()=>{
 const {googleTranslate,googleTranslateStatus}=await import('../news_translation.mjs');
 const calls=[];
 const ok=async(url,opt={})=>{calls.push([url,opt.method||'GET']);return new Response(JSON.stringify([[['비트코인 하락',"Bitcoin falls"]]]),{headers:{'Content-Type':'application/json'}})};
 assert.equal((await googleTranslate({text:'Bitcoin falls',fetcher:ok})).translatedText,'비트코인 하락');
 assert.equal(calls[0][1],'GET');assert.match(calls[0][0],/q=Bitcoin%20falls/);
 await googleTranslate({text:'x'.repeat(2000),fetcher:ok});assert.equal(calls[1][1],'POST');
 await assert.rejects(googleTranslate({text:'a',fetcher:async()=>new Response('no',{status:429})}),/TRANSLATION_HTTP/);
 assert.equal(googleTranslateStatus.lastError,'HTTP 429');
});

test('OpenAI provider sees the title and excerpts together, validates the output and caches it per field',async()=>{
 const input=article(),requests=[];
 const translations=['비트코인 거래량 증가','제공처가 작성한 요약입니다.','제공처가 제공한 기사 발췌입니다.'];
 const translateBatch=createOpenAINewsTranslator({apiKey:'synthetic-key',fetcher:async(url,opt)=>{
  const request=JSON.parse(opt.body);requests.push(request);
  assert.equal(url,'https://api.openai.com/v1/responses');
  assert.equal(opt.headers.Authorization,'Bearer synthetic-key');
  assert.ok(opt.signal instanceof AbortSignal);
  assert.equal(request.text.format.type,'json_schema');assert.equal(request.store,false);
  assert.match(request.instructions,/Preserve quantities.*uncertainty/);
  assert.deepEqual(JSON.parse(request.input),['title','summary','detail'].map(field=>({field,text:input[field]})));
  return Response.json({status:'completed',output:[{type:'message',role:'assistant',content:[{type:'output_text',text:JSON.stringify({translations})}]}]});
 }});
 const options={now:NOW,providerId:'OPENAI',translateBatch};
 const [out]=await translateNewsArticles([input],options);
 assert.equal(requests.length,1);
 assert.equal(out.displayTitle,translations[0]);assert.equal(out.original.summary,input.summary);
 assert.equal(out.translation.provider,'OPENAI');assert.equal(out.translation.status,'COMPLETE');
 await translateNewsArticles([input],{...options,now:NOW+200});
 assert.equal(requests.length,1,'refresh uses the cached translations');
 assert.equal(createOpenAINewsTranslator({apiKey:''}),null);
 for(const output of [
  [{type:'message',role:'assistant',content:[{type:'refusal',refusal:'refused'}]}],
  [{type:'message',role:'assistant',content:[{type:'output_text',text:'{"translations":["일부 답변"]}'}]}]
 ]){
  const bad=createOpenAINewsTranslator({apiKey:'synthetic-key',fetcher:async()=>Response.json({status:'completed',output})});
  const [result]=await translateNewsArticles([input],{...options,translateBatch:bad});
  assert.equal(result.translation.status,'ERROR');assert.equal(result.displayTitle,input.title);
 }
 const partialBatch=createOpenAINewsTranslator({apiKey:'synthetic-key',fetcher:async()=>Response.json({status:'completed',output:[{type:'message',role:'assistant',content:[{type:'output_text',text:JSON.stringify({translations:['비트코인 거래량 증가','BTC ETF','제공처 발췌 번역입니다.']})}]}]})});
 const [partialOut]=await translateNewsArticles([input],{now:NOW+500,providerId:'OPENAI_PARTIAL',translateBatch:partialBatch});
 assert.equal(partialOut.translation.status,'PARTIAL');
 assert.equal(partialOut.displayTitle,'비트코인 거래량 증가');
 assert.equal(partialOut.displaySummary,input.summary);
});

