import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {translateNewsArticles} from '../news_translation.mjs';

// Exercise the production polling function without a server, user files or any
// network delivery. The failing persistence callback models a real disk error.
test('news bootstrap and new alerts are committed before delivery and remain retryable after a failed save',async()=>{
 const source=fs.readFileSync(new URL('../server.mjs',import.meta.url),'utf8');
 const polling=source.slice(source.indexOf('let newsBootstrapped=false;'),source.indexOf('function bodyJson(req)'));
 assert.ok(polling.includes('async function pollNews()'));
 const sent=[],telegram=[],now=Date.now();let fail=true,articles=[{id:'old',published:now}];
 const context=vm.createContext({Date,AbortController,setTimeout,clearTimeout,CONFIG:{translationURL:''},translateNewsArticles,
  FEEDS:[{name:'synthetic',url:'https://fixture.invalid/rss'}],
  state:{ranked:[]},tradfiState:{swaps:[]},persisted:{newsSeen:{}},
  fetch:async()=>({ok:true,text:async()=>'<rss><channel/></rss>'}),
  prepareNews:()=>articles,
  shouldNotifyArticle:(article,seen)=>!seen.has(article.id),
  send:(event,data)=>sent.push({event,data}),tgNews:async article=>telegram.push(article.id),
  save:candidate=>{if(fail)throw Error('synthetic disk failure');context.persisted=candidate}
 });
 vm.runInContext(polling,context);
 await assert.rejects(context.pollNews(),/disk failure/);
 assert.equal(vm.runInContext('newsBootstrapped',context),false);
 assert.deepEqual(Object.keys(context.persisted.newsSeen),[]);
 assert.equal(telegram.length,0);assert.equal(sent.length,0);

 fail=false;await context.pollNews();
 assert.equal(vm.runInContext('newsBootstrapped',context),true);
 assert.equal(context.persisted.newsSeen.old,now);
 assert.equal(sent.filter(x=>x.event==='news-alert').length,0,'bootstrap must not replay old articles');

 articles=[...articles,{id:'new',published:now}];fail=true;
 await assert.rejects(context.pollNews(),/disk failure/);
 assert.equal(context.persisted.newsSeen.new,undefined);
 assert.equal(sent.filter(x=>x.event==='news-alert').length,0);assert.equal(telegram.length,0);
 fail=false;await context.pollNews();await context.pollNews();
 assert.equal(context.persisted.newsSeen.new,now);
 assert.equal(sent.filter(x=>x.event==='news-alert').length,1);
 assert.deepEqual(telegram,[],'news updates may still reach the browser but never Telegram');
});
