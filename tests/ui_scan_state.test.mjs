import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {tradePlan,entryTiming,entryAllowance} from '../public/trade_plan.js';

const source=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
const html=readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
const piece=(start,end)=>{
 const first=source.indexOf(start),last=source.indexOf(end,first+start.length);
 assert.ok(first>=0&&last>first,`production function boundary: ${start}`);
 return source.slice(first,last);
};
const noop=()=>{};
function ui(){
 const nodes=new Map();
 const $=id=>{if(!nodes.has(id))nodes.set(id,{textContent:'',innerHTML:'',className:'',classList:{toggle:noop,add:noop,remove:noop}});return nodes.get(id)};
 const app={symbol:'BTCUSDT',market:[],marketMap:new Map(),signals:[],patterns:[],watch:[],alerts:[],watchlist:[],analysis:null};
 const ctx=vm.createContext({app,$,Date,Number,Map,tradePlan,entryTiming,
  updateJournalSymbols:noop,loadChart:noop,loadAnalysis:noop,renderWatch:noop,renderPair:noop,renderSignals:noop,
  renderRecentCoverage:noop,renderAlerts:noop,renderMatched:noop,loadExecution:noop,renderTradingView:noop,drawChart:noop,
  renderAnalysis:noop,levelRows:()=>'',fmt:String,money:String,escapeHtml:String});
 return {app,ctx,$};
}
const market=(price=100,priceAt)=>({symbol:'BTCUSDT',baseAsset:'BTC',price,priceAt,variational:{ticker:'BTC-PERP',markPrice:100}});

test('market snapshots preserve newer live prices and timestamps on PC/mobile',()=>{
 const {app,ctx}=ui();
 vm.runInContext(piece('function mergeMarketQuote(','function renderWatch(')+piece('function onQuote(','let audioContext'),ctx);
 const now=Date.now();
 ctx.applyMarket({markets:[market()]});
 ctx.onQuote([['BTCUSDT',100.1,now]]);
 ctx.applyMarket({markets:[{...market(100,now-10000),variational:{ticker:'BTC-PERP',markPrice:100.2}}]});
 assert.equal(app.marketMap.get('BTCUSDT').price,100.1);
 assert.equal(app.marketMap.get('BTCUSDT').priceAt,now);
 assert.equal(app.marketMap.get('BTCUSDT').variational.markPrice,100.2,'metadata still refreshes');
 assert.equal(app.market[0].price,100.1,'market table uses the same latest quote');
 ctx.onQuote([['BTCUSDT',99,now-20000]]);
 assert.equal(app.marketMap.get('BTCUSDT').price,100.1,'delayed tick must not overwrite newer quote');
 ctx.applyMarket({markets:[market(100.2,now+1)]});
 assert.equal(app.marketMap.get('BTCUSDT').price,100.2,'newer snapshot is accepted');
});

test('a metadata refresh never makes an old quote fresh or keeps a removed analysis',()=>{
 const {app,ctx}=ui();
 vm.runInContext(piece('function mergeMarketQuote(','function renderWatch('),ctx);
 const old=Date.now()-100000;
 ctx.applyMarket({markets:[market(100,old)]});
 ctx.applyMarket({markets:[market(99)]});
 assert.equal(app.marketMap.get('BTCUSDT').priceAt,old);
 app.analysis={status:'signal'};
 ctx.applyMarket({markets:[]});
 assert.equal(app.analysis,null);
 assert.equal(app.symbol,'BTCUSDT','public TradingView chart selection remains available');
});

test('empty authoritative results clear a selected stale signal and optionally reload missing scan detail',()=>{
 const {app,ctx}=ui();let reloads=0;
 ctx.loadAnalysis=()=>reloads++;
 vm.runInContext(piece('function refreshSelectedAnalysis(','async function loadResults('),ctx);
 app.marketMap.set('BTCUSDT',market());
 app.analysis={symbol:'BTCUSDT',status:'signal',qualified:true};
 ctx.refreshSelectedAnalysis({signals:[],recent:[],patterns:[],watch:[]});
 assert.equal(app.analysis,null);
 assert.equal(reloads,0);
 ctx.refreshSelectedAnalysis({signals:[],recent:[]},{reloadMissing:true});
 assert.equal(reloads,1);
 const held={symbol:'BTCUSDT',status:'watch',qualified:false};
 ctx.refreshSelectedAnalysis({recent:[held]});
 assert.equal(app.analysis,held);
});

test('detail badge uses current final eligibility and labels the 10-point slope bonus',()=>{
 const {app,ctx,$}=ui(),now=Date.now();
 vm.runInContext(piece('function renderAnalysis(','function scanPagination('),ctx);
 const signal={symbol:'BTCUSDT',status:'signal',qualified:true,patternConfirmed:true,patternConfirmedAt:now-1000,time:now-3600000,
  direction:'LONG',pattern:'돌파',entry:100,stop:98,target1:104,target2:106,target3:108,atr:2,score:90,
  execution:{eligible:true},quality:{checks:[{label:'기울기',required:false,weight:10,passed:false,value:'방향 불일치'}]}};
 app.analysis=signal;app.signals=[signal];app.marketMap.set('BTCUSDT',market(100,now));
 ctx.renderAnalysis();
 assert.match($('analysisTag').textContent,/현재 진입 검증 통과/);
 assert.match($('currentCandidate').innerHTML,/\[가산점\].*기울기/);
 assert.match($('currentCandidate').innerHTML,/90점 이상/);
 app.signals=[];ctx.renderAnalysis();
 assert.doesNotMatch($('analysisTag').textContent,/검증 통과/,'stored signal status alone must not imply current eligibility');
 app.signals=[signal];app.marketMap.get('BTCUSDT').priceAt=now-100000;ctx.renderAnalysis();
 assert.doesNotMatch($('analysisTag').textContent,/검증 통과/,'fresh price is required');
});

test('diagnostics render four separate pass stages without substituting failure counts',()=>{
 const {ctx,$}=ui();
 vm.runInContext(piece('function renderScanDiagnostics(','function setStatus('),ctx);
 ctx.renderScanDiagnostics({uniqueAnalyzed:8,noPattern:3,patternCount:5,technicalPassed:4,quality:1,venuePassed:3,venue:1,entry:1,ready:2});
 for(const [id,count] of [['diagPattern',5],['diagTechnicalPassed',4],['diagVenuePassed',3],['diagReady',2]]){
  assert.equal($(id).textContent,count+'종');
  assert.match(html,new RegExp(`id="${id}"`));
 }
 assert.match(html,/필수 8개 조건/);assert.match(html,/추가 10점/);
});

test('shared entry allowance retains price, risk and ATR guards for LONG and SHORT',()=>{
 for(const direction of ['LONG','SHORT']){
  const signal={direction,entry:100,stop:direction==='LONG'?98:102,atr:.2};
  assert.ok(Math.abs(entryAllowance(signal)-.0009)<1e-12,'ATR is the tightest guard');
  assert.equal(entryAllowance({...signal,atr:10}),.004,'price cap remains 0.4%');
  assert.ok(Math.abs(entryAllowance({...signal,stop:direction==='LONG'?99.8:100.2,atr:10})-.0005)<1e-12,'risk guard remains one quarter of stop distance');
 }
 assert.equal(entryAllowance({entry:NaN,stop:98}),0);
});
