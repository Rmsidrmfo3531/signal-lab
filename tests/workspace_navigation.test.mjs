import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const html=fs.readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
const css=fs.readFileSync(new URL('../public/styles.css',import.meta.url),'utf8');
const script=fs.readFileSync(new URL('../public/workspace_nav.js',import.meta.url),'utf8');
const appJs=fs.readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
// The dashboard shows only these four pages (user request 2026-11-17).
const routes=['real','live','news','journal'];

test('dashboard shows only 실계좌·카피 / 테스트넷 / 뉴스 / 매매일지',()=>{
 const markers=[...html.matchAll(/<section\b[^>]*data-workspace-route="([^"]+)"/g)].map(x=>x[1]);
 assert.deepEqual(markers,routes);
 for(const id of ['real','realCopy','live','liveControl','liveCopySection','liveScalpSection','news','journal','closeTradeDialog'])
  assert.match(html,new RegExp('id="'+id+'"'),'missing view '+id);
 // Removed pages: 대시보드 · 차트 (hero, metrics, chart, quote check, scanner) and 알림 · 시스템.
 for(const id of ['overview','scanner','workGrid','chartPanel','execution','matched','alerts','notifySettings','scanButton','refreshButton','testNotificationButton'])
  assert.doesNotMatch(html,new RegExp('id="'+id+'"'),'removed view still present: '+id);
 assert.doesNotMatch(html,/class="page-head"|class="metrics"|tradingview|href="#(?:overview|alerts|chartPanel|venues|scanner)"/i);
 // Mobile bottom navigation: the four pages only.
 const bottom=html.match(/<nav class="mobile-bottom-nav"[\s\S]*?<\/nav>/)[0];
 assert.deepEqual([...bottom.matchAll(/href="#([a-z]+)"/g)].map(x=>x[1]),routes);
 // Topbar keeps connection status, clock, browser-notification and update buttons.
 for(const id of ['socketStatus','clock','notificationButton','updateButton'])assert.match(html,new RegExp('id="'+id+'"'));
 assert.match(html,/<script type="module" src="\/workspace_nav\.js"><\/script>/);
 assert.match(css,/\[data-workspace-route\]\[hidden\]\{display:none!important\}/);
});

test('every element app.js looks up by id exists on the page (no console errors from removed screens)',()=>{
 const ids=new Set([...appJs.matchAll(/\$\('([A-Za-z0-9_]+)'\)/g)].map(x=>x[1]));
 assert.ok(ids.size>10);
 for(const id of ids)assert.match(html,new RegExp('id="'+id+'"'),'app.js uses a missing element: '+id);
 // The update button's bootId auto-reload and ORDER_IN_PROGRESS retry are kept.
 assert.match(appJs,/u\.bootId!==boot/);assert.match(appJs,/ORDER_IN_PROGRESS/);
 for(const gone of ['renderSignals','renderTradingView','drawChart','loadExecution','renderAlerts','renderMatched'])assert.doesNotMatch(appJs,new RegExp(gone));
});

function harness(hash){
 const sections=routes.map((route,i)=>({dataset:{workspaceRoute:route},id:'p'+i,hidden:false,attributes:{},
   setAttribute(k,v){this.attributes[k]=v}}));
 const mkLink=href=>({attributes:{},classList:{flags:new Set(),toggle(k,v){if(v)this.flags.add(k);else this.flags.delete(k)}},
  getAttribute(k){return k==='href'?href:null},setAttribute(k,v){this.attributes[k]=v},removeAttribute(k){delete this.attributes[k]}});
 const links=routes.map(r=>mkLink('#'+r));
 const crumb={textContent:''},sidebar={classList:{remove(){}}};
 const window={location:{hash,pathname:'/',search:''},handlers:{},scrollTo(){},requestAnimationFrame(fn){fn()},
  history:{replaceState(_s,_t,url){window.location.hash=url.slice(url.indexOf('#'))}},
  addEventListener(k,fn){this.handlers[k]=fn}};
 const document={title:'',querySelectorAll(s){if(s==='.content > [data-workspace-route]')return sections;
   if(s==='.navlink, .mobile-bottom-nav a')return links;throw Error(s)},
  getElementById(id){if(id==='sidebar')return sidebar;if(id==='crumbPage')return crumb;return null}};
 vm.runInNewContext(script,{document,window,Event:class{}});
 const shown=()=>sections.filter(s=>!s.hidden).map(s=>s.dataset.workspaceRoute);
 const go=h=>{window.location.hash=h;window.handlers.hashchange()};
 return {sections,links,crumb,window,document,shown,go};
}

test('default landing is #real; old and unknown hashes redirect to #real',()=>{
 const h=harness('');
 assert.deepEqual(h.shown(),['real']);assert.equal(h.window.location.hash,'#real');
 assert.equal(h.crumb.textContent,'실계좌 · 카피 매매');assert.equal(h.links[0].attributes['aria-current'],'page');
 for(const old of ['#overview','#alerts','#chartPanel','#venues','#scanner','#not-a-route']){
  h.go(old);assert.deepEqual(h.shown(),['real'],old);assert.equal(h.window.location.hash,'#real',old);
 }
 // An old #paper bookmark opens the 테스트넷 page that replaced it.
 h.go('#paper');assert.deepEqual(h.shown(),['live']);assert.equal(h.window.location.hash,'#live');
 h.go('#live');assert.deepEqual(h.shown(),['live']);assert.equal(h.crumb.textContent,'테스트넷 · 신호 전략');
 assert.equal(h.links[1].attributes['aria-current'],'page');assert.equal(h.links[0].attributes['aria-current'],undefined);
 h.go('#news');assert.deepEqual(h.shown(),['news']);
 h.go('#journal');assert.deepEqual(h.shown(),['journal']);assert.equal(h.document.title,'Signal Lab · 매매일지 · 위험관리');
});
