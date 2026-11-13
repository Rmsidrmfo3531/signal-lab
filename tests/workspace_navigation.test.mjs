import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const html=fs.readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
const css=fs.readFileSync(new URL('../public/styles.css',import.meta.url),'utf8');
const script=fs.readFileSync(new URL('../public/workspace_nav.js',import.meta.url),'utf8');
const routes=['overview','live','news','alerts','journal'];

test('navigation separates every functional panel without removing any stateful UI elements',()=>{
 const markers=[...html.matchAll(/<section\b[^>]*data-workspace-route="([^"]+)"/g)].map(x=>x[1]);
 assert.equal(markers.length,9,'TradFi and BingX·Gate.io quote pages were removed at the user\'s request');
 for(const route of routes)assert.ok(markers.includes(route),'missing route: '+route);
 assert.ok(!/href="#scanner"/.test(html),'시그널 스캐너 menu removed at the user\'s request');
 for(const id of ['scanner','live','workGrid','execution','news','alerts','journal','chartPanel'])
  assert.match(html,new RegExp('id="'+id+'"'),'missing existing view '+id);
 assert.match(html,/<script type="module" src="\/workspace_nav\.js"><\/script>/);
 assert.match(css,/\[data-workspace-route\]\[hidden\]\{display:none!important\}/);
 assert.ok(!html.includes('80점 이상 알트코인 관찰 알림은 Telegram 전용'));
});

test('hash routing keeps panels mounted and routes chart aliases to overview',()=>{
 const sections=['scanner','live','overview','overview','overview','overview','news','alerts','journal']
  .map((route,i)=>({dataset:{workspaceRoute:route},id:'p'+i,hidden:false,attributes:{},
   setAttribute(k,v){this.attributes[k]=v}}));
 const mkLink=hash=>({hash,attributes:{},classList:{flags:new Set(),toggle(k,v){if(v)this.flags.add(k);else this.flags.delete(k)}},
  getAttribute(k){return k==='href'?hash:null},setAttribute(k,v){this.attributes[k]=v},removeAttribute(k){delete this.attributes[k]}});
 const links=routes.map(r=>mkLink('#'+r)).concat(mkLink('#chartPanel'));
 const heading={innerHTML:'<span>기본 대시보드</span>',textContent:''},eyebrow={textContent:'BINANCE SIGNAL MONITOR'},intro={textContent:'기본 설명'},crumb={textContent:''};
 const sidebar={classList:{remove(){}}},chart={scrollIntoView(){}};
 const window={location:{hash:'#scanner'},handlers:{},scrollTo(){},dispatchEvent(){},requestAnimationFrame(fn){fn()},
  addEventListener(k,fn){this.handlers[k]=fn}};
 const document={title:'',querySelectorAll(s){if(s==='.content > [data-workspace-route]')return sections;
   if(s==='.navlink, .mobile-bottom-nav a')return links;throw Error(s)},
  querySelector(s){if(s==='.page-head h1')return heading;if(s==='.page-head .eyebrow')return eyebrow;if(s==='.page-head .intro')return intro;throw Error(s)},
  getElementById(id){if(id==='sidebar')return sidebar;if(id==='chartPanel')return chart;if(id==='crumbPage')return crumb;return null}};
 vm.runInNewContext(script,{document,window,Event:class{}});
 assert.equal(sections.filter(s=>!s.hidden).length,1);
 // Each page names itself once: breadcrumb and intro follow the page, no repeated eyebrow.
 assert.equal(crumb.textContent,'실매매');assert.match(intro.textContent,/BingX 주문 상태/);assert.equal(eyebrow.hidden,true);
 // An old #scanner bookmark opens 실매매 (the scanner page was removed).
 assert.equal(sections.find(s=>!s.hidden).dataset.workspaceRoute,'live');
 assert.equal(links[1].attributes['aria-current'],'page');
 window.location.hash='#live';window.handlers.hashchange();
 assert.equal(sections.filter(s=>!s.hidden).length,1);
 assert.equal(sections.find(s=>!s.hidden).dataset.workspaceRoute,'live');
 // An old #paper bookmark opens the 실매매 page that replaced it.
 window.location.hash='#paper';window.handlers.hashchange();
 assert.equal(sections.find(s=>!s.hidden).dataset.workspaceRoute,'live');
 window.location.hash='#chartPanel';window.handlers.hashchange();
 assert.equal(sections.filter(s=>!s.hidden).length,4);
 assert.ok(sections.filter(s=>!s.hidden).every(s=>s.dataset.workspaceRoute==='overview'));
 assert.equal(links[0].attributes['aria-current'],'page');
 window.location.hash='#not-a-route';window.handlers.hashchange();
 assert.equal(sections.filter(s=>!s.hidden).length,4,'unknown page falls back to overview');
});
