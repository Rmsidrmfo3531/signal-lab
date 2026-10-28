import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {orangeXView,renderOrangeX,initOrangeX} from '../public/orangex.js';

const html=fs.readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
const css=fs.readFileSync(new URL('../public/styles.css',import.meta.url),'utf8');
const section=html.slice(html.indexOf('<section id="orangex"'),html.indexOf('<section id="tradfi"'));
const now=Date.parse('2026-10-27T04:00:00Z');
const snapshot=()=>({enabled:true,mode:'READ_ONLY',connected:true,checkedAt:now,marketStatus:'CONNECTED',accountStatus:'READY',
 capabilities:{marketData:true,accountRead:true,oauth:true},verification:{officialSpec:'VERIFIED',liveConnection:'CONNECTED'},
 automation:{enabled:false,canEnable:false,killSwitch:'NOT_IMPLEMENTED'},orderSubmissionEnabled:false,
 markets:[{symbol:'BTCUSDT',instrumentName:'BTC-USDT-PERPETUAL',tradable:true,markPrice:100,bid:99.99,ask:100.01,
  spreadBps:2,priceAt:now,minQty:.001,qtyStep:.001,priceTick:.1}],
 account:{balances:[{currency:'USDT',balance:123,availableBalance:100,equity:124}],
  positions:[{symbol:'BTCUSDT',direction:'LONG',quantity:.02,leverage:3,entryPrice:99,markPrice:100,
   stopPrice:97,targets:[103,105,107],unrealizedPnL:.02,realizedPnL:0}],
  openOrders:[{symbol:'BTCUSDT',orderId:'read-order-1',direction:'LONG',status:'open',price:98,quantity:.01,filledQuantity:0}],
  trades:[{symbol:'BTCUSDT',direction:'SHORT',price:101,quantity:.01,fee:.001,realizedPnL:.02,at:now}],
  unrealizedPnL:.02,dailyRealizedPnL:0,cumulativeRealizedPnL:1.23},errors:[]});
const content=view=>Object.values(view).filter(value=>typeof value==='string').join('\n');
function dom(){
 const nodes=new Map([...html.matchAll(/id="([^"]+)"/g)].map(match=>[match[1],{
  textContent:'',innerHTML:'',className:'',disabled:false,listeners:new Map(),addEventListener(event,listener){this.listeners.set(event,listener)}
 }]));
 return {nodes,getElementById:id=>nodes.get(id)||null};
}

test('OrangeX adds shared desktop/mobile navigation and read-only DOM without replacing existing panels',()=>{
 assert.equal((html.match(/href="#orangex"/g)||[]).length,2);
 assert.match(html,/<script type="module" src="\/orangex\.js"><\/script>/);
 for(const id of ['orangexMetrics','orangexMarkets','orangexBalances','orangexPnl','orangexPositions','orangexOrders','orangexTrades','orangexErrors','orangexRejections','orangexRefresh'])
  assert.match(section,new RegExp(`id="${id}"`));
 for(const id of ['directionEntryBoard','pairDirectionEntries','scanner','paper','tradfi','news','journal','chartPanel'])assert.match(html,new RegExp(`id="${id}"`));
 assert.doesNotMatch(section,/<(?:input|form|select)\b/);
 assert.match(section,/PAPER·LIVE/);assert.match(section,/후속 단계/);
 assert.match(css,/\.mobile-bottom-nav\{grid-template-columns:repeat\(5,minmax\(0,1fr\)\)/);
 assert.match(css,/\.orangex-position-grid\{grid-template-columns:1fr\}/);
 const ids=[...html.matchAll(/id="([^"]+)"/g)].map(match=>match[1]);assert.equal(new Set(ids).size,ids.length,'new DOM IDs must not collide');
});

test('unconfigured and unverified data never fabricates zero balances, PNL or a connected market',()=>{
 const view=orangeXView({enabled:false,mode:'READ_ONLY',accountStatus:'NOT_CONFIGURED',marketStatus:'DISABLED',
  verification:{officialSpec:'UNVERIFIED',liveConnection:'UNTESTED'},account:null});
 assert.equal(view.connected,false);assert.equal(view.hasAccount,false);assert.equal(view.state,'orangex-pending');
 assert.match(view.metrics,/READ_ONLY/);assert.match(view.metrics,/미설정/);
 assert.match(view.balanceNote,/0으로 가정하지 않습니다/);assert.match(view.balances,/잔고 미확인/);
 assert.doesNotMatch(view.pnl,/\$0/);assert.match(view.pnl,/—/);
 assert.doesNotMatch(orangeXView({account:{dailyPnL:' ',unrealizedPnL:'',totalRealizedPnL:null}}).pnl,/\$0/);
 const malformed=orangeXView({account:{dailyPnL:[],unrealizedPnL:[5],totalRealizedPnL:{}}});
 assert.doesNotMatch(malformed.pnl,/\$[05]/,'arrays and objects are unknown values, never balances or PNL');
 assert.equal((malformed.pnl.match(/>—</g)||[]).length,3);
 assert.match(view.positions,/미조회 상태를 포지션 0건으로 해석하지/);
 assert.match(view.markets,/상장이나 가격을 추정하지/);
});

test('verified account and market views show observed prices, positions and only explicit PNL values',()=>{
 const data=snapshot(),root=dom(),view=renderOrangeX(data,{root});
 assert.equal(view.connected,true);assert.equal(view.hasAccount,true);assert.equal(view.state,'orangex-ok');
 assert.match(view.markets,/BTC-USDT-PERPETUAL/);assert.match(view.markets,/0\.001/);assert.match(view.markets,/2 bp/);
 assert.match(view.positions,/LONG/);assert.match(view.positions,/3x/);assert.match(view.positions,/1차 103 · 2차 105 · 3차 107/);
 assert.match(view.pnl,/\$0\.00/,'explicit zero is valid observed data');assert.match(view.pnl,/\$1\.23/);
 assert.match(root.nodes.get('orangexOrders').innerHTML,/read-order-1/);assert.match(root.nodes.get('orangexTrades').innerHTML,/SHORT/);
 assert.match(root.nodes.get('orangex').className,/orangex-ok/);
 assert.match(view.rejection,/모든 시그널은 OrangeX 주문 제출 대상에서 제외/);
});

test('provider text is escaped and credential fields or error bodies are never rendered',()=>{
 const data=snapshot(),secret='test-secret-must-not-appear';
 data.apiKey=secret;data.access_token=secret;data.account.refresh_token=secret;
 data.account.positions[0].client_secret=secret;
 data.markets[0].symbol='<img src=x onerror=alert(1)>';
 data.errors=[{code:'AUTH_FAILED',message:`Authorization: Bearer ${secret}`,at:now},{code:secret,message:secret}];
 const view=orangeXView(data),all=content(view);
 assert.doesNotMatch(all,new RegExp(secret));assert.doesNotMatch(all,/<img/);assert.match(all,/&lt;img/);
 assert.match(view.errors,/계좌 조회 인증에 실패/);assert.match(view.errors,/UNKNOWN/);
});

test('a server claiming LIVE or enabled submission cannot expose trading controls or a safe mode label',()=>{
 const data=snapshot();data.mode='LIVE';data.orderSubmissionEnabled=true;data.automation.enabled=true;
 const view=orangeXView(data);
 assert.match(view.mode,/지원하지 않는 모드 · 주문 차단/);assert.match(view.notice,/조회만 제공/);
 assert.match(view.metrics,/OFF · 실제 데이터 진입 비활성/);assert.doesNotMatch(content(view),/<(?:button|input|form|select)\b/);
 data.verification.officialSpec='UNVERIFIED';assert.equal(orangeXView(data).state,'orangex-pending');
});

test('an unverified instrument is distinct from a rejected listing and stale quotes are explicit',()=>{
 const data=snapshot();Object.assign(data.markets[0],{instrumentVerified:false,tradable:false,fresh:false,priceAt:Date.now()-180000,minQty:null,qtyStep:null,priceTick:null});
 const view=orangeXView(data);
 assert.match(view.markets,/미검증 · 주문 차단/);assert.doesNotMatch(view.markets,/>거래 불가</);
 assert.match(view.markets,/시세 만료\/미확인/);assert.equal((view.markets.match(/>미검증</g)||[]).length,3);
 assert.match(view.marketCount,/종목 후보/);
});

test('OrangeX refresh uses GET only and serializes concurrent requests while restoring its button',async()=>{
 const root=dom(),calls=[];let release,tick;
 const first=new Promise(resolve=>{release=resolve});
 const fetcher=async(url,options)=>{
  calls.push({url,options});if(calls.length===1)await first;
  return {ok:true,json:async()=>snapshot()};
 };
 const controller=initOrangeX({root,fetcher,setTimer:handler=>{tick=handler;return 1}});
 assert.equal(root.nodes.get('orangexRefresh').disabled,true);
 assert.equal(await controller.refresh(true),false,'a pending read cannot create a second exchange request');
 release();await new Promise(resolve=>setImmediate(resolve));
 assert.equal(root.nodes.get('orangexRefresh').disabled,false);
 await controller.refresh(true);assert.equal(calls.length,6);
 assert.deepEqual(calls.filter(call=>call.url==='/api/orangex'||call.url==='/api/orangex?refresh=1').map(call=>call.url),['/api/orangex','/api/orangex?refresh=1']);
 assert.equal(calls.filter(call=>call.url==='/api/orangex/paper').length,2);
 assert.equal(calls.filter(call=>call.url==='/api/orangex/paper/replay').length,2);
 assert.ok(calls.every(call=>call.options.method==='GET'&&!('body' in call.options)));
 assert.ok(calls.every(call=>Object.keys(call.options.headers).join(',')==='Accept'));
 assert.equal(typeof tick,'function');assert.equal(typeof root.nodes.get('orangexRefresh').listeners.get('click'),'function');
});

test('offline PAPER records render independently while an exchange public-market read is still pending',async()=>{
 const root=dom();let release;
 const waiting=new Promise(resolve=>{release=resolve});
 const controller=initOrangeX({root,setTimer:()=>1,fetcher:async url=>{
  if(url==='/api/orangex/paper')return {ok:true,json:async()=>({mode:'PAPER_OFFLINE',dataSource:'SYNTHETIC_FIXTURE',
   settings:{capitalUSD:10000},summary:{realizedPnLUSD:3.5},pending:[],open:[],closed:[]})};
  await waiting;return {ok:true,json:async()=>snapshot()};
 }});
 await new Promise(resolve=>setImmediate(resolve));
 assert.match(root.nodes.get('orangexPaperStatus').textContent,/합성 테스트 데이터/);
 assert.match(root.nodes.get('orangexPaperSummary').innerHTML,/\$3\.50/);
 assert.equal(root.nodes.get('orangexRefresh').disabled,true);
 assert.equal(await controller.refresh(true),false);
 release();await new Promise(resolve=>setImmediate(resolve));
 assert.equal(root.nodes.get('orangexRefresh').disabled,false);
});

test('a refresh failure keeps prior observations visible with an error state and never echoes its exception',async()=>{
 const root=dom();let failed=false;
 const controller=initOrangeX({root,setTimer:()=>1,fetcher:async()=>{
  if(failed)throw Error('secret-in-transport-error');return {ok:true,json:async()=>snapshot()};
 }});
 await new Promise(resolve=>setImmediate(resolve));failed=true;
 assert.equal(await controller.refresh(true),false);
 assert.match(root.nodes.get('orangexPositions').innerHTML,/BTCUSDT/);
 assert.match(root.nodes.get('orangexMetrics').innerHTML,/조회 오류/);
 assert.match(root.nodes.get('orangexBalanceNote').textContent,/이전 조회 자료/);
 assert.match(root.nodes.get('orangexNotice').textContent,/조회 갱신 실패/);
 assert.doesNotMatch([...root.nodes.values()].map(node=>node.innerHTML+node.textContent).join(''),/secret-in-transport-error/);
 assert.equal(root.nodes.get('orangexRefresh').disabled,false);
});
