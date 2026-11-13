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
});
