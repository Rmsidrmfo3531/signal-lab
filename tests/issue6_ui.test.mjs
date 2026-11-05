import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {entryTiming} from '../public/trade_plan.js';
import {paginateScan,SCAN_PAGE_SIZE} from '../public/scan_pagination.js';
const source=fs.readFileSync(new URL('../public/app.js',import.meta.url),'utf8'),
 html=fs.readFileSync(new URL('../public/index.html',import.meta.url),'utf8'),
 paper=fs.readFileSync(new URL('../public/paper_ui.js',import.meta.url),'utf8');
const section=(text,start,end)=>{const first=text.indexOf(start),last=text.indexOf(end,first+start.length);assert.ok(first>=0&&last>first);return text.slice(first,last)};
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const noop=()=>{};
function screen(){
 const nodes=new Map(),$=id=>{if(!nodes.has(id))nodes.set(id,{textContent:'',innerHTML:'',value:'all',className:'',classList:{toggle:noop},querySelectorAll:()=>[]});return nodes.get(id)};
 const app={signals:[],patterns:[],watch:[],marketMap:new Map(),status:{rest:'connected'},signalPage:1};
 const ctx=vm.createContext({app,$,Date,Number,Array,entryTiming,paginateScan,SCAN_PAGE_SIZE,
 escapeHtml:esc,fmt:String,dateClock:String,clock:String,pct:String,document:{querySelectorAll:()=>[]},
 scanPagination:noop,volumeTargetHTML:()=>'',linkButtons:()=>'',focusSignal:noop,fillJournalFromSignal:noop});
 vm.runInContext(section(source,'function currentReadySignals(','function browserAlertState('),ctx);
 ctx.renderDirectionalEntries=noop;return {ctx,app,$};
}
function signal(symbol,score,confirmedAt){return {symbol,score,qualified:true,direction:'LONG',pattern:'상단돌파',patternConfirmed:true,
 patternConfirmedAt:confirmedAt,time:confirmedAt-3600000,scannedAt:Date.now(),entry:100,stop:98,atr:1,
 technicalValidation:{passed:true},quality:{passed:true,validUntil:Date.now()+60000},execution:{eligible:true},targetPlan:{ok:true,targets:[104,106,108]}}}

test('main shows only current final signals and sorts canonical score before confirmation time and symbol',()=>{
 const {ctx,app,$}=screen(),now=Date.now();
 const rows=[signal('ZZZUSDT',95,now-1000),signal('BBBUSDT',98,now-2000),signal('AAAUSDT',98,now-2000),signal('NEWUSDT',98,now-1000),
 {...signal('HELDUSDT',100,now-1000),qualified:false},{...signal('NULLUSDT',null,now-1000)},
 {...signal('NOPROFILEUSDT',100,now-1000),targetPlan:{ok:false,targets:[]}},
 {...signal('BADORDERUSDT',100,now-1000),targetPlan:{ok:true,targets:[108,106,104]}}];
 for(const row of rows)app.marketMap.set(row.symbol,{symbol:row.symbol,price:100,priceAt:now,change:0});
 app.signals=rows;app.patterns=[signal('TELEGRAMONLYUSDT',100,now-1000)];app.watch=app.patterns;
 ctx.renderSignals();const rendered=$('signalsBody').innerHTML;
 assert.ok(rendered.indexOf('NEWUSDT')<rendered.indexOf('AAAUSDT'));
 assert.ok(rendered.indexOf('AAAUSDT')<rendered.indexOf('BBBUSDT'));
 assert.ok(rendered.indexOf('BBBUSDT')<rendered.indexOf('ZZZUSDT'));
 for(const symbol of ['HELDUSDT','NULLUSDT','NOPROFILEUSDT','BADORDERUSDT','TELEGRAMONLYUSDT'])assert.doesNotMatch(rendered,new RegExp(symbol));
 assert.equal($('metricSignals').textContent,4);assert.match($('scanSummary').textContent,/점수 내림차순/);
});

test('volume target display preserves exact fractions, provenance window and net-R without manufacturing missing targets',()=>{
 const ctx=vm.createContext({Number,Array,escapeHtml:esc,fmt:String,dateClock:String});
 vm.runInContext(section(source,'function volumeTargetHTML(','function renderAnalysis('),ctx);
 const plan={ok:true,targets:[104,106,108],parts:[.4,.35,.25].map((fraction,i)=>({price:104+i*2,fraction,quantity:fraction,zone:{priceLow:105+i*2,priceHigh:106+i*2}})),
 estimatedNetRR:1.91,profileEvidence:{dataSource:'SYNTHETIC_TEST',windowStart:100,windowEnd:200,generatedAt:201,coverage:{ratio:.99},uniqueTrades:321,poc:{price:103},hvn:[{price:105}],valueArea:{low:99,high:109}}};
 const rendered=ctx.volumeTargetHTML({targetPlan:plan});
 for(const text of ['TP1 104','40%','35%','25%','합성 테스트','99.0%','321','1.91R','POC 103','HVN 105'])assert.ok(rendered.includes(text),text);
 assert.doesNotMatch(rendered,/실제 aggTrades/);
 assert.match(ctx.volumeTargetHTML({targetPlan:{...plan,ok:false,targets:[]}}),/TP_PROFILE_UNAVAILABLE/);
 assert.doesNotMatch(ctx.volumeTargetHTML({targetPlan:{...plan,ok:false,targets:[]}}),/TP1 104|2R|3R|4R/);
 const unknown=ctx.volumeTargetHTML({targetPlan:{...plan,estimatedNetRR:null}});assert.match(unknown,/순손익비 미검증/);assert.doesNotMatch(unknown,/0.00R/);
});

test('removed observation controls cannot reappear and Telegram-only alerts never trigger browser notifications',()=>{
 for(const id of ['structureList','structurePager','historyList','historyPager','scanRecentList','showWatchButton'])assert.doesNotMatch(html,new RegExp(`id="${id}"`));
 assert.doesNotMatch(html,/<option value="watch">/);assert.doesNotMatch(source,/function renderObservations/);
 const {ctx,app}=screen();app.marketMap.set('BTCUSDT',{});let displayed=0;
 Object.assign(ctx,{signalToast:()=>displayed++,ping:()=>displayed++,window:{},Notification:{}});
 vm.runInContext(section(source,'function notify(','function renderNews('),ctx);
 ctx.notify({symbol:'BTCUSDT',kind:'WATCH'});ctx.notify({symbol:'BTCUSDT',observationOnly:true});
 assert.equal(displayed,0);
});

test('breakeven switch reflects a server setting only and missing settings never guess activation',()=>{
 const nodes=new Map(),find=id=>{if(!nodes.has(id))nodes.set(id,{disabled:false,checked:false,textContent:''});return nodes.get(id)},ctx=vm.createContext({find});
 vm.runInContext(section(paper,'let lastBreakevenSetting=',"const breakevenControl="),ctx);
 ctx.renderPaperManagementSetting(undefined);assert.equal(find('paperBreakevenToggle').disabled,true);
 ctx.renderPaperManagementSetting({TP1_MOVE_STOP_TO_BREAKEVEN:true});assert.equal(find('paperBreakevenToggle').checked,true);
 ctx.renderPaperManagementSetting({TP1_MOVE_STOP_TO_BREAKEVEN:false});assert.equal(find('paperBreakevenToggle').checked,false);
 assert.match(find('paperBreakevenStatus').textContent,/OFF/);
 assert.match(paper,/fetch\('\/api\/paper\/settings'/);assert.match(paper,/TP1_MOVE_STOP_TO_BREAKEVEN:enabled/);
 assert.doesNotMatch(paper,/fetch\([^\n]*(?:private\/|\/live|\/activate)/);
});

test('existing paper positions display their preserved management state instead of adopting a new profile',()=>{
 const ctx=vm.createContext({});vm.runInContext(section(paper,'function paperManagementCaption(','let lastBreakevenSetting='),ctx);
 assert.match(ctx.paperManagementCaption({targets:[102,103,104],stop:99}),/기존 기록.*TP\/SL 보존/);
 assert.match(ctx.paperManagementCaption({managementVersion:'VOLUME_PROFILE_V1',moveStopToBreakeven:false}),/OFF/);
 assert.match(ctx.paperManagementCaption({managementVersion:'VOLUME_PROFILE_V1',breakevenMovedAt:123}),/체결 완료 후 본절 이동 확인/);
 assert.match(ctx.paperManagementCaption({managementVersion:'VOLUME_PROFILE_V1'}),/손절 유지/);
 assert.match(ctx.paperManagementCaption({managementVersion:'VOLUME_PROFILE_V1',breakevenMode:'COST_COVERED'}),/비용 보전 가정.*무손실 보장 아님/);
 assert.doesNotMatch(ctx.paperManagementCaption({targets:[102,103,104],stop:99,breakevenMode:'COST_COVERED'}),/비용 보전/);
});

test('breakeven basis settings save only a future-position mode, restore rejected changes and prevent overlapping updates',async()=>{
 const nodes=new Map(),handlers=new Map(),find=id=>{if(!nodes.has(id))nodes.set(id,{disabled:false,checked:false,textContent:'',value:'ENTRY_FILL',
  addEventListener:(_type,handler)=>handlers.set(id,handler)});return nodes.get(id)},updates=[],settings={TP1_MOVE_STOP_TO_BREAKEVEN:true,TP1_BREAKEVEN_MODE:'ENTRY_FILL'};
 const ctx=vm.createContext({find,loadPaper:async()=>{},fetch:async(_url,options)=>{
  const update=JSON.parse(options.body);updates.push(update);Object.assign(settings,update);return {ok:true,json:async()=>({settings:{...settings}})};
 }});
 vm.runInContext(section(paper,'let lastBreakevenSetting=','function renderMonitor('),ctx);
 ctx.renderPaperManagementSetting(undefined);assert.equal(find('paperBreakevenMode').disabled,true);
 ctx.renderPaperManagementSetting(settings);assert.equal(find('paperBreakevenMode').value,'ENTRY_FILL');
 find('paperBreakevenMode').value='COST_COVERED';await handlers.get('paperBreakevenMode')();
 assert.deepEqual(updates,[{TP1_BREAKEVEN_MODE:'COST_COVERED'}]);assert.equal(find('paperBreakevenToggle').checked,true);
 assert.match(find('paperBreakevenStatus').textContent,/비용 보전 가정.*무손실 보장 아님.*기존 TP\/SL 보존/);
 ctx.renderPaperManagementSetting({...settings,TP1_BREAKEVEN_MODE:'UNVERIFIED'});assert.equal(find('paperBreakevenMode').disabled,true);
 assert.match(find('paperBreakevenStatus').textContent,/기준 조회 미완료/);
 ctx.renderPaperManagementSetting({...settings,TP1_BREAKEVEN_MODE:'ENTRY_FILL'});ctx.fetch=async()=>({ok:false,json:async()=>({error:'synthetic save rejection'})});
 find('paperBreakevenMode').value='COST_COVERED';await handlers.get('paperBreakevenMode')();
 assert.equal(find('paperBreakevenMode').value,'ENTRY_FILL');assert.match(find('paperBreakevenStatus').textContent,/설정 변경 실패/);
 let release;ctx.fetch=async(_url,options)=>{updates.push(JSON.parse(options.body));await new Promise(resolve=>{release=resolve});return {ok:true,json:async()=>({settings:{...settings}})}};
 find('paperBreakevenMode').value='COST_COVERED';const pending=handlers.get('paperBreakevenMode')();
 assert.equal(find('paperBreakevenToggle').disabled,true);assert.equal(find('paperBreakevenMode').disabled,true);
 find('paperBreakevenToggle').checked=false;await handlers.get('paperBreakevenToggle')();
 release();await pending;assert.equal(updates.length,2,'an overlapping checkbox update cannot race the mode update');
 assert.equal(find('paperBreakevenToggle').checked,true);assert.equal(find('paperBreakevenMode').value,'COST_COVERED');
 assert.match(html,/id="paperBreakevenMode"/);assert.match(html,/value="ENTRY_FILL" selected/);
});

test('risk and quote details distinguish Binance PAPER assumptions from OrangeX permission without unsupported leverage advice',()=>{
 assert.doesNotMatch(html,/BTC 20~40x|ETH 10~25x|SOL 10~15x|Variational 주문창|모의 손익은 고정 명목금액/);
 assert.match(html,/OrangeX 실주문 OFF/);assert.match(html,/계산 명목 상한/);
 assert.match(source,/Binance TRADING USDT 무기한 상장 확인 · 실제 주문 OFF/);
 const nodes=new Map(),$=id=>{if(!nodes.has(id))nodes.set(id,{textContent:'',className:''});return nodes.get(id)},ctx=vm.createContext({$,Number,fmt:String,dateClock:String,money:value=>'$'+value});
 vm.runInContext(section(source,'function setExecutionView(','async function loadExecution('),ctx);
 ctx.setExecutionView({eligible:true,bid:100,ask:100.01,spreadBps:1,quantity:2,notional:200,estimatedStopLossUSD:5,maxRiskUSD:6,
  slippageBps:0.2,quoteUpdatedAt:Date.now(),quoteAgeSeconds:1,costAssumptions:{takerRate:.0006}});
 assert.match($('executionVerdict').textContent,/OrangeX 주문 승인 아님/);
 assert.match($('execCost').textContent,/가정 손절손실 \$5 \/ 한도 \$6/);
 assert.equal($('execVenue').textContent,'0.20 bp');assert.match($('execMark').textContent,/모의 수량 2/);
 assert.match($('execFunding').textContent,/6.00 bp 가정/);assert.match($('execFundingTime').textContent,/실제 계정 요율·펀딩 정산 미검증/);
 ctx.setExecutionView({eligible:false,bid:100,ask:100.01});
 assert.match($('execCost').textContent,/미확인/);assert.match($('execFunding').textContent,/미확인/);
 assert.doesNotMatch($('execFunding').textContent,/0.00|8시간/);
});

test('basic chart EMA200 uses the full closed history and never fabricates warmup or forming-bar values',()=>{
 const ctx=vm.createContext({Array,Map});vm.runInContext(section(source,'function ema(','function drawChart('),ctx);
 const bars=Array.from({length:300},(_,i)=>({time:i+1,close:i+1,closed:true}));
 const values=ctx.chartEMA(bars,200);
 assert.equal(values.slice(0,199).every(value=>value===null),true);assert.equal(values[199],100.5);
 assert.ok(values.at(-1)>100.5);assert.equal(ctx.chartEMA(bars.slice(-95),200).every(value=>value===null),true);
 const withForming=ctx.chartEMA([...bars,{time:301,close:1000000,closed:false}],200);
 assert.equal(withForming.at(-1),null);assert.deepEqual(Array.from(withForming.slice(0,-1)),Array.from(values));
 assert.match(source,/chartEMA\(app\.candles,n\)\.slice\(-95\)/);
});
