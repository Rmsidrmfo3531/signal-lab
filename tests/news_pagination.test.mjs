import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {paginateNews,clipNewsText,pageWindow,featureNews,NEWS_PER_PAGE} from '../public/news_pagination.js';
import {parseRSS} from '../news.mjs';

test('the top two important articles prefer different, recent stories and preserve other article order',()=>{
 const now=1e12,high=(id,title,published=now-1000,source=id)=>({id,title,published,source,impact:'high'});
 const general={...high('general','A new market note'),impact:'general'};
 const a=high('a','SEC approves spot BTC ETF application',now-2000,'A'),b=high('b','SEC approves spot Bitcoin ETF application reports',now-3000,'B');
 const c=high('c','Fed interest rate decision and press conference',now-500),old=high('old','Crude oil rises in overnight futures',now-7*3600000);
 const result=featureNews([general,c,a,b,old],now);
 assert.deepEqual(result.items.map(x=>x.id),['a','c','general','b','old']);
 assert.deepEqual(result.featured.get('a'),['A','B']);assert.equal(result.featured.has('b'),false);
});

test('a failed article can be retried and a successful receipt is cached',async()=>{
 const source=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
 const first=source.indexOf('const newsBodies=new Map()'),end=source.indexOf("if(typeof document!=='undefined')",first);
 const host={},requests=[];
 const context=vm.createContext({AbortSignal,CSS:{escape:s=>s},escapeHtml:s=>s,document:{querySelector:()=>host},fetch:async url=>{
  requests.push(url);
  if(requests.length===1)throw Error('offline');
  return {json:async()=>({ok:true,paragraphs:['article text']})};
 }});
 vm.runInContext(source.slice(first,end),context);
 await context.loadNewsBody('test-article');assert.match(host.innerHTML,/다시 시도/);
 await context.loadNewsBody('test-article',{retry:true});assert.match(host.innerHTML,/article text/);
 await context.loadNewsBody('test-article',{retry:true});assert.equal(requests.length,2);
});

test('news is paginated to exactly five on each full page',()=>{
 const items=Array.from({length:12},(_,i)=>({id:String(i)}));
 assert.equal(NEWS_PER_PAGE,5);
 const one=paginateNews(items,1);
 assert.deepEqual(one.items.map(x=>x.id),['0','1','2','3','4']);
 assert.equal(one.pages,3);
 assert.equal(one.total,12);
 assert.deepEqual(paginateNews(items,2).items.map(x=>x.id),['5','6','7','8','9']);
 const last=paginateNews(items,3);
 assert.deepEqual(last.items.map(x=>x.id),['10','11']);
 assert.equal(last.start,10);
 assert.equal(last.end,12);
});
test('news page bounds are safe on results refresh or filter change',()=>{
 const items=[{id:'a'},{id:'b'},{id:'c'}];
 assert.equal(paginateNews(items,999).page,1);
 assert.equal(paginateNews(items,-5).page,1);
 assert.equal(paginateNews([],2).page,1);
 assert.equal(paginateNews([],2).items.length,0);
});
test('five page numbers show around selected page',()=>{
 assert.deepEqual(pageWindow(1,12),[1,2,3,4,5]);
 assert.deepEqual(pageWindow(6,12),[4,5,6,7,8]);
 assert.deepEqual(pageWindow(12,12),[8,9,10,11,12]);
});
test('preview is clipped without losing unshortened RSS excerpt',()=>{
 const text='This publication has released important verified details about the launch date and the planned changes for affected traders. '.repeat(5);
 const excerpt=clipNewsText(text,120);
 assert.ok(excerpt.length<160);
 assert.ok(excerpt.endsWith('…'));
 const xml=`<rss><channel><item><title>Breaking</title><link>https://publisher.example/story</link><pubDate>Sun, 18 Oct 2026 09:00:00 GMT</pubDate><description><![CDATA[<p>${text}</p>]]></description></item></channel></rss>`;
 const result=parseRSS(xml,'publisher',Date.parse('2026-10-18T10:00:00Z'));
 assert.equal(result.length,1);
 assert.ok(result[0].detail.length>result[0].summary.length);
 assert.ok(!result[0].detail.includes('<p>'));
});
