import test from 'node:test';
import assert from 'node:assert/strict';
import {articleAllowed,extractParagraphs,articleDetail} from '../news_article.mjs';

test('only the RSS sources are fetched, over https',()=>{
 assert.equal(articleAllowed('https://decrypt.co/1/a'),true);assert.equal(articleAllowed('https://www.cnbc.com/2026/a.html'),true);
 for(const bad of ['http://decrypt.co/a','https://evil.com/a','https://decrypt.co.evil.com/a','https://user:p@decrypt.co/a','file:///etc/passwd','notaurl'])assert.equal(articleAllowed(bad),false,bad);
});

test('main paragraphs from the article element, boilerplate and short lines dropped',()=>{
 const p=extractParagraphs('<nav><p>Subscribe to our newsletter to receive the latest crypto news every day</p></nav><script>var x="<p>no</p>"</script><article><p>Bitcoin rose 5% on Thursday as ETF inflows reached the highest level in three weeks.</p><p>Too short.</p><p>Analysts said the move reflected renewed demand from institutional investors &amp; funds.</p></article>');
 assert.deepEqual(p,['Bitcoin rose 5% on Thursday as ETF inflows reached the highest level in three weeks.','Analysts said the move reflected renewed demand from institutional investors & funds.']);
});

test('detail is translated paragraph by paragraph; a redirect off the source is refused',async()=>{
 const html='<article><p>Bitcoin rose 5% on Thursday as ETF inflows reached the highest level in three weeks.</p><p>Analysts said the move reflected renewed demand from institutional investors.</p></article>';
 const fetcher=async url=>({ok:true,url,text:async()=>html});
 const translate=async({text})=>({translatedText:text.split('\n|||\n').map((_,i)=>'한국어 문단 '+(i+1)).join(' ||| ')});
 const d=await articleDetail({link:'https://decrypt.co/t1'},{fetcher,translate,now:1});
 assert.equal(d.ok,true);assert.deepEqual(d.paragraphsKo,['한국어 문단 1','한국어 문단 2']);assert.equal(d.paragraphs.length,2);
 const r=await articleDetail({link:'https://decrypt.co/t2'},{fetcher:async()=>({ok:true,url:'https://evil.com/x',text:async()=>html}),now:1});
 assert.equal(r.ok,false);assert.equal(r.error,'REDIRECTED_OUTSIDE_SOURCE');
 assert.equal((await articleDetail({link:'https://evil.com/a'},{fetcher})).error,'SOURCE_NOT_ALLOWED');
 // A 30x hop to an internal address is refused before it is requested.
 const asked=[];const hop=async(url,opt)=>{asked.push(url);assert.equal(opt.redirect,'manual');return url.endsWith('/t3')?{ok:false,status:302,headers:{get:()=>'http://169.254.169.254/latest/meta-data'}}:{ok:true,url,text:async()=>html}};
 assert.equal((await articleDetail({link:'https://decrypt.co/t3'},{fetcher:hop,now:1})).error,'REDIRECTED_OUTSIDE_SOURCE');assert.deepEqual(asked,['https://decrypt.co/t3']);
 const ok=async url=>url.endsWith('/t4')?{ok:false,status:301,headers:{get:()=>'/t4-final'}}:{ok:true,status:200,url,text:async()=>html};
 assert.equal((await articleDetail({link:'https://decrypt.co/t4'},{fetcher:ok,now:1})).ok,true,'a redirect within the source is followed');
 const ai=await articleDetail({link:'https://decrypt.co/t1'},{fetcher,providerId:'OPENAI',now:1,translateBatch:async({parts,signal})=>{
  assert.deepEqual(parts,d.paragraphs.map(text=>({field:'body',text})));
  assert.ok(signal instanceof AbortSignal);
  return ['비트코인은 목요일 5% 올랐습니다.','분석가들은 기관투자자의 수요 회복을 언급했습니다.'];
 }});
 assert.equal(ai.translationProvider,'OPENAI');
 assert.match(ai.paragraphsKo[0],/ 5% 올랐습니다/);
 const bigChunk=new Uint8Array(2_000_000).fill(65);
 let cancelled=false;
 const oversized=async url=>({ok:true,url,body:{getReader(){let n=0;return {async read(){return n++<2?{done:false,value:bigChunk}:{done:true,value:undefined}},async cancel(){cancelled=true},releaseLock(){}}}}});
 assert.equal((await articleDetail({link:'https://decrypt.co/big'},{fetcher:oversized,now:1})).error,'NO_TEXT');
 assert.equal(cancelled,true);
 const longHtml='<article>'+Array.from({length:12},(_,i)=>`<p>${'A'.repeat(1200)} paragraph ${i}</p>`).join('')+'</article>';
 const capped=extractParagraphs(longHtml);
 assert.ok(capped.reduce((s,x)=>s+x.length,0)<=2200);
});


