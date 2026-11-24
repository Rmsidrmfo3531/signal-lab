import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {LiveExecutor} from '../live_executor.mjs';
import {liveConfig} from '../live_orders.mjs';
import {livePositionView,liveClosedView,liveSummary,liveOverview,liveReasonKo,checkLiveLevels} from '../live_overview.mjs';
import {priceFmt,priceDecimals} from '../public/price_format.js';
import {positionCardHTML,closedCardHTML,summaryHTML,skippedHTML,modeBadgeHTML,liveRows,levelReason,LIVE_RULE_KEYS} from '../public/live_control.js';

const NOW=Date.parse('2026-11-12T03:00:00Z');
const tmp=()=>fs.mkdtempSync(path.join(os.tmpdir(),'live-overview-'));
const contract={tickSize:'0.001',quantityStep:'0.1',quantityUnit:'BASE_ASSET',contractSizeBase:'1',minQuantityBase:'0.1'};
function openRecord(extra={}){
 return {clientOrderId:'slabc',signalKey:'CRYPTO|DOGEUSDT|LONG|test|1',venue:'BINGX',mode:'TESTNET',symbol:'DOGEUSDT',venueSymbol:'DOGE-USDT',venueContract:contract,
  direction:'LONG',plannedEntry:0.2,firstEntryPrice:0.2,stop:0.19,targets:[0.21,0.22,0.23],quantity:{base:100,riskUSD:1,unit:'BASE_ASSET',total:100,parts:[40,35,25]},targetParts:[40,35,25],
  marginMode:'CROSS',leverage:20,sizing:'BALANCE',plannedRiskUSD:1,status:'OPEN',createdAt:NOW-3600000,entryOrderId:'1',stopOrderId:'2',targetOrderIds:['3','4','5'],breakevenMoved:false,
  adds:[{price:0.195,units:1,qty:100,orderId:'6',filled:false},{price:0.192,units:2,qty:200,orderId:'7',filled:false}],peakSize:100,events:[{type:'PROTECTED',at:NOW-3500000}],...extra};
}

test('Korean labels for skip reasons, statuses and the kill switch',()=>{
 assert.equal(liveReasonKo('NOT_ARMED'),'활성화 안 됨');assert.equal(liveReasonKo('DAILY_RISK_LIMIT'),'하루 손실 한도 도달');
 assert.equal(liveReasonKo('KILL_SWITCH:MANUAL'),'긴급 정지: MANUAL');assert.equal(liveReasonKo('SOMETHING_NEW'),'SOMETHING_NEW','unknown codes stay as they are');
 const view=livePositionView(openRecord({status:'UNKNOWN'}),{now:NOW});assert.match(view.statusKo,/확인 필요/);
});

test('open position view: exchange numbers when fresh, estimates marked, pending adds and the same price decimals',()=>{
 const fresh=openRecord({position:{size:100,entryPrice:0.2,markPrice:0.205,markSource:'EXCHANGE',unrealizedPnLUSD:0.5,at:NOW-5000}});
 const v=livePositionView(fresh,{price:0.204,now:NOW});
 assert.equal(v.currentPrice,0.205);assert.equal(v.currentPriceSource,'EXCHANGE');assert.deepEqual(v.unrealized,{usd:0.5,source:'EXCHANGE',pct:50});
 assert.equal(v.averageEntryPrice,0.2);assert.equal(v.firstEntryPrice,0.2);assert.equal(v.quantity.base,100);assert.equal(v.leverage,20);
 assert.equal(v.adds.filled,0);assert.equal(v.adds.max,2);assert.deepEqual(v.adds.pending.map(a=>a.n),[1,2]);assert.equal(v.lastEvent.label,'손절·목표 주문 완료');
 // Old snapshot: the public venue price and an estimate (never shown as the venue's number).
 const stale=livePositionView({...fresh,position:{...fresh.position,at:NOW-600000}},{price:0.21,now:NOW});
 assert.equal(stale.currentPriceSource,'VENUE_BOOK');assert.equal(stale.unrealized.source,'ESTIMATE');assert.equal(stale.unrealized.usd,1);
 // No price at all: no made-up result.
 assert.equal(livePositionView(openRecord(),{now:NOW}).unrealized,null);
 // Gate.io contracts are shown in base units.
 const gate=livePositionView(openRecord({venue:'GATEIO',venueContract:{...contract,quantityUnit:'CONTRACT',contractSizeBase:'10'},quantity:{total:5,unit:'CONTRACT'},position:{size:5,entryPrice:0.2,at:NOW}}),{price:0.21,now:NOW});
 assert.equal(gate.quantity.base,50);assert.equal(gate.quantity.venue,5);
 // Price decimals: every price uses the venue tick's decimals.
 assert.equal(priceDecimals(v),3);const pf=priceFmt(v);assert.equal(pf(0.2),'0.200');assert.equal(pf(0.205),'0.205');
 const html=positionCardHTML(v);
 assert.match(html,/첫 진입가<b>0\.200<\/b>/);assert.match(html,/평균 진입가<b>0\.200<\/b>/);assert.match(html,/현재가<b>0\.205<\/b>/);
 assert.match(html,/0차 \/ 최대 2차/);assert.match(html,/<i>1차<\/i>0\.195/);assert.match(html,/\+\$0\.50 \(\+50\.00%\)/);assert.match(html,/보유 중/);
 assert.match(html,/손절·TP 직접 수정/);assert.match(positionCardHTML(stale),/추정/);
 assert.doesNotMatch(positionCardHTML({...v,status:'SUBMITTING'}),/손절·TP 직접 수정/,'only an OPEN position can be edited');
});

test('closed trades and summary: venue settlement, estimates marked, pending and test trades left out of the totals',()=>{
 const closed=r=>({...openRecord(),status:'CLOSED',closedAt:NOW,closeReason:'POSITION_FLAT',...r});
 const records=[closed({realized:{source:'EXCHANGE',pnlUSD:3,feeUSD:-0.2,fundingUSD:-0.05,netUSD:2.75}}),closed({realized:{source:'ESTIMATE',pnlUSD:-1,feeUSD:-0.1,netUSD:-1.1,takerRate:.0006}}),
  closed({}),closed({realized:{source:'UNKNOWN'}}),closed({test:true,closeReason:'TEST_CLOSE',realized:{source:'EXCHANGE',netUSD:100}}),openRecord()];
 const s=liveSummary(records,null,NOW);
 assert.deepEqual({trades:s.trades,settled:s.settled,wins:s.wins,losses:s.losses,winRatePct:s.winRatePct,netUSD:s.netUSD,estimated:s.estimated,pending:s.pending,unknown:s.unknown,tests:s.tests},
  {trades:4,settled:2,wins:1,losses:1,winRatePct:50,netUSD:1.65,estimated:1,pending:1,unknown:1,tests:1});
 const views=records.slice(0,5).map(r=>liveClosedView(r,NOW));
 assert.match(closedCardHTML(views[0]),/\+\$2\.75[\s\S]*거래소 정산[\s\S]*수수료 −\$0\.20/);
 assert.match(closedCardHTML(views[1]),/−\$1\.10[\s\S]*0\.06% 가정/);assert.doesNotMatch(closedCardHTML(views[1]),/추정/);
 assert.match(closedCardHTML(views[2]),/정산 확인 중/);assert.match(closedCardHTML(views[3]),/확인 불가/);assert.match(closedCardHTML(views[4]),/시험 주문/);
 assert.match(summaryHTML(s),/4건/);assert.match(summaryHTML(s),/50\.0%/);assert.match(summaryHTML(s),/\+\$1\.65/);assert.match(summaryHTML(s),/추정 1건 포함/);
 const o=liveOverview({status:{mode:'TESTNET',armed:true,killSwitch:false,venues:['BINGX'],credentialsConfigured:{BINGX:true,GATEIO:false},limits:{},records:[],
  skipped:[{at:NOW,symbol:'ETHUSDT',venue:'BINGX',reasons:['NOT_ARMED','MAX_OPEN_POSITIONS']}]},records,priceOf:()=>0.21,now:NOW});
 assert.equal(o.positions.length,1);assert.equal(o.closed.length,5);assert.deepEqual(o.skipped[0].reasonsKo,['활성화 안 됨','동시 포지션 최대']);
 assert.match(skippedHTML(o.skipped),/ETHUSDT<\/b> 활성화 안 됨 · 동시 포지션 최대/);
 // One place per fact (user 2026-11-18): the header shows the mode (and 긴급 정지); on / off is the 활성화 button's.
 assert.match(modeBadgeHTML({mode:'TESTNET',armed:true}),/TESTNET[\s\S]*모의 자금/);assert.doesNotMatch(modeBadgeHTML({mode:'TESTNET',armed:true}),/활성화/);
 assert.match(modeBadgeHTML({mode:'LIVE',armed:false}),/LIVE[\s\S]*실제 돈/);assert.doesNotMatch(modeBadgeHTML({mode:'LIVE',armed:false}),/비활성/);assert.match(modeBadgeHTML({mode:'OFF'}),/OFF/);
 assert.match(modeBadgeHTML({mode:'TESTNET',killSwitch:true}),/긴급 정지 중/);
 const rows=Object.fromEntries(liveRows({...o,balance:{venue:'BINGX',usd:1234.5,at:NOW,capUSD:400}}));
 assert.match(rows['잔고'],/\$1,234\.50 BingX 순자산 · 계산은 최대 \$400까지$/,'no second time stamp (the header has it)');
 assert.equal(rows['상태'],undefined,'no 상태 row: the state is on the button');
 const L=Object.fromEntries(liveRows({...o,limits:{riskProfile:'GROWTH',sizing:'BALANCE',maxLossPct:3,dailyMaxLossPct:9,maxOpen:8,maxPerDirection:4}}));
 assert.equal(L['손실 한도'],undefined,'the risk profile row already has the loss limits');assert.doesNotMatch(L['위험 프로필'],/동시/,'동시 포지션 has its own row');
 assert.ok(['전략','위험 프로필','수량','동시 포지션'].every(k=>LIVE_RULE_KEYS.includes(k)),'rules go behind 규칙 보기');
});

test('manual levels for a live position: checked against the current price, only changes returned, TP1 locked after it filled',()=>{
 const r=openRecord({position:{size:100,entryPrice:0.2,at:NOW}});
 assert.deepEqual(checkLiveLevels(r,{stop:0.195},{price:null}).reasons,['PRICE_UNAVAILABLE']);
 const ok=checkLiveLevels(r,{stop:0.195,targets:[0.21,0.225,null]},{price:0.202});
 assert.equal(ok.ok,true);assert.equal(ok.changed,true);assert.equal(ok.stop,0.195);assert.ok(Number.isNaN(ok.targets[0]));assert.equal(ok.targets[1],0.225);assert.ok(Number.isNaN(ok.targets[2]));
 assert.ok(checkLiveLevels(r,{stop:0.205},{price:0.202}).reasons.includes('STOP_ALREADY_CROSSED'));
 assert.ok(checkLiveLevels(r,{targets:[0.201,0.22,0.23]},{price:0.202}).reasons.includes('TP1_NOT_BEYOND_PRICE'));
 assert.ok(checkLiveLevels(r,{targets:[0.21,0.205,0.23]},{price:0.202}).reasons.includes('TP2_ORDER'));
 assert.deepEqual(checkLiveLevels({...r,breakevenMoved:true},{targets:[0.215,0.22,0.23]},{price:0.212}).reasons,['TP1_ALREADY_FILLED']);
 assert.equal(checkLiveLevels(r,{stop:0.19},{price:0.2}).changed,false);
 const short=checkLiveLevels({...r,direction:'SHORT',stop:0.21,targets:[0.19,0.18,0.17]},{stop:0.205},{price:0.2});assert.equal(short.ok,true);
 assert.match(levelReason('TP2_ORDER'),/TP2 순서/);assert.match(levelReason('PRICE_UNAVAILABLE'),/현재가/);
});

// Fake BingX account for the executor's read-only observation and settlement.
function fakeBingX({income=()=>[]}={}){
 const state={amt:100,avg:0.2,mark:0.205,orders:[],incomeCalls:0};
 return {state,client:{
  positions:async()=>state.amt?[{symbol:'DOGE-USDT',positionAmt:String(state.amt),avgPrice:String(state.avg),markPrice:String(state.mark),unrealizedProfit:((state.mark-state.avg)*state.amt).toFixed(6)}]:[],
  placeOrder:async o=>{const id=String(9000+state.orders.length);state.orders.push({...o,id});return {order:{orderId:id}}},
  cancelOrder:async()=>({}),openOrders:async()=>({orders:[]}),balance:async()=>[{asset:'USDT',equity:'321.5'}],
  income:async q=>{state.incomeCalls++;return income(q,state)}}};
}

test('executor observation: position snapshot, first entry, exits and the venue settlement after the close (read only)',async()=>{
 let now=NOW;const fake=fakeBingX({income:(q,s)=>s.incomeCalls<2?[]:[{symbol:'DOGE-USDT',incomeType:'REALIZED_PNL',income:'0.9',time:NOW+40000},{symbol:'DOGE-USDT',incomeType:'TRADING_FEE',income:'-0.05',time:NOW+40000},
  {symbol:'DOGE-USDT',incomeType:'FUNDING_FEE',income:'-0.01',time:NOW+41000},{symbol:'BTC-USDT',incomeType:'REALIZED_PNL',income:'50',time:NOW+41000},{symbol:'DOGE-USDT',incomeType:'REALIZED_PNL',income:'7',time:NOW-7200000}]});
 const ex=new LiveExecutor({config:liveConfig({LIVE_TRADING_MODE:'TESTNET'}),clients:{BINGX:fake.client},directory:tmp(),now:()=>now,priceOf:()=>0.204});
 const record=openRecord({firstEntryPrice:undefined});ex.store.records.push(record);
 await ex.reconcile();
 assert.deepEqual({...record.position},{size:100,entryPrice:0.2,markPrice:0.205,markSource:'EXCHANGE',unrealizedPnLUSD:0.5,marginUSD:null,realizedPnLUSD:null,at:now});
 assert.equal(record.firstEntryPrice,0.2,'first entry read from the first position check');
 assert.equal(await ex.accountBalance('BINGX'),321.5);
 // TP1 (40) fills: an exit is noted, and the existing breakeven logic still runs.
 now+=15000;fake.state.amt=60;fake.state.mark=0.21;await ex.reconcile();
 assert.deepEqual(record.exits,[{qty:40,price:0.21,at:now}]);assert.equal(record.breakevenMoved,true);
 // Flat: the record closes, the venue fund flow is read until it lists the trade.
 now+=15000;fake.state.amt=0;await ex.reconcile();
 assert.equal(record.status,'CLOSED');assert.equal(record.exits.length,2);assert.equal(record.exits[1].price,0.204,'flat: the public price at detection');
 now+=15000;await ex.reconcile();assert.equal(fake.state.incomeCalls,0,'no read until SETTLE_DELAY_MS after the close (a late final fill)');
 now+=135000;await ex.reconcile();
 assert.equal(record.realized,undefined,'no settlement listed yet: no number');
 now+=15000;await ex.reconcile();
 assert.deepEqual({...record.realized,at:undefined},{source:'EXCHANGE',pnlUSD:0.9,feeUSD:-0.05,fundingUSD:-0.01,netUSD:0.84,at:undefined},'only this symbol and this trade\'s lifetime');
 const calls=fake.state.incomeCalls;now+=15000;await ex.reconcile();assert.equal(fake.state.incomeCalls,calls,'settled once');
 const saved=JSON.parse(fs.readFileSync(ex.file,'utf8'));assert.equal(saved.records[0].realized.netUSD,0.84);
});

test('executor settlement falls back to a marked estimate when the venue never lists it',async()=>{
 let now=NOW;const fake=fakeBingX({income:()=>{throw Object.assign(Error('down'),{code:'HTTP_500'})}});
 const ex=new LiveExecutor({config:liveConfig({LIVE_TRADING_MODE:'TESTNET'}),clients:{BINGX:fake.client},directory:tmp(),now:()=>now,priceOf:()=>null});
 const record=openRecord({adds:[]});ex.store.records.push(record);
 await ex.reconcile();now+=15000;fake.state.amt=0;fake.state.mark=0.21;await ex.reconcile();
 assert.equal(record.status,'CLOSED');assert.deepEqual(record.exits.map(e=>[e.qty,e.price]),[[100,0.205]],'no public price: the last venue mark');
 now+=150000;for(let i=0;i<5;i++){now+=15000;await ex.reconcile()}
 assert.equal(record.realized.source,'ESTIMATE');assert.equal(record.settleAttempts,4);
 const fee=(0.2+0.205)*100*record.realized.takerRate;
 assert.ok(Math.abs(record.realized.netUSD-(0.5-fee))<1e-3);assert.ok(record.realized.feeUSD<0);
 // Test trades are never settled into the totals.
 const t=openRecord({signalKey:'TEST:1',test:true,status:'CLOSED',closedAt:now});ex.store.records.push(t);await ex.reconcile();assert.equal(t.realized,undefined);
});

test('BingX fund-flow read is a signed GET with only the given parameters',async()=>{
 const {BingXTradeClient,LIVE_HOSTS}=await import('../live_clients.mjs');const seen=[];
 const client=new BingXTradeClient({apiKey:'k-test',secret:'s-test-secret',mode:'TESTNET',now:()=>NOW,fetcher:async(url,options)=>{seen.push({url:new URL(url),method:options.method});
  return new Response(JSON.stringify({code:0,data:[{symbol:'DOGE-USDT',incomeType:'REALIZED_PNL',income:'1',time:NOW}]}),{headers:{'Content-Type':'application/json'}})}});
 const rows=await client.income({symbol:'DOGE-USDT',startTime:NOW-1000,endTime:NOW});
 assert.equal(rows[0].income,'1');assert.equal(seen[0].method,'GET');assert.equal(seen[0].url.origin,LIVE_HOSTS.BINGX.TESTNET);assert.equal(seen[0].url.pathname,'/openApi/swap/v2/user/income');
 assert.deepEqual([...seen[0].url.searchParams.keys()].sort(),['endTime','limit','recvWindow','signature','startTime','symbol','timestamp']);
});

test('summary counts only the current mode; a close with no settlement after 2 h shows as unknown',()=>{
 const closed=r=>({...openRecord(),status:'CLOSED',closedAt:NOW,closeReason:'POSITION_FLAT',...r});
 const recs=[closed({mode:'TESTNET',realized:{source:'EXCHANGE',netUSD:5}}),closed({mode:'LIVE',liveConfirmed:true,realized:{source:'EXCHANGE',netUSD:-3}})];
 assert.equal(liveSummary(recs,'TESTNET',NOW).netUSD,5);assert.equal(liveSummary(recs,'LIVE',NOW).netUSD,-3);
 assert.equal(liveClosedView(closed({}),NOW+60000).realized.source,'PENDING');
 assert.equal(liveClosedView(closed({}),NOW+2*3600000+1).realized.source,'UNKNOWN');
 assert.equal(liveSummary([closed({})],null,NOW+3*3600000).unknown,1);
});

test('live screen code never uses its $ helper before declaring it (a blank 실매매 screen otherwise)',async()=>{
 const fs=await import('node:fs');const src=fs.readFileSync(new URL('../public/live_control.js',import.meta.url),'utf8');
 for(const m of src.matchAll(/function (\w+)\([^)]*\)\{([\s\S]*?)\n\}/g)){
  const body=m[2],decl=body.search(/const \$=/);if(decl<0)continue;
  assert.equal(/\$\(/.test(body.slice(0,decl)),false,m[1]+' uses $( before const $=');
 }
});

test('open position shows margin in use and realized result so far (venue figures, estimate marked)',async()=>{
 const {livePositionView}=await import('../live_overview.mjs');
 const NOWX=Date.parse('2026-11-13T02:00:00Z');
 const base={signalKey:'m1',symbol:'DOGEUSDT',venue:'BINGX',direction:'LONG',leverage:10,status:'OPEN',quantity:{total:1000,unit:'BASE_ASSET'},firstEntryPrice:0.2,venueContract:{tickSize:'0.0001'}};
 const fresh=livePositionView({...base,position:{size:1000,entryPrice:0.2,markPrice:0.21,marginUSD:20.5,realizedPnLUSD:1.25,unrealizedPnLUSD:10,at:NOWX-5000}},{now:NOWX});
 assert.deepEqual(fresh.margin,{usd:20.5,source:'EXCHANGE'});assert.deepEqual(fresh.realizedOpen,{usd:1.25,source:'EXCHANGE'});
 const est=livePositionView({...base,position:{size:1000,entryPrice:0.2,at:NOWX-5000}},{now:NOWX});
 assert.deepEqual(est.margin,{usd:20,source:'ESTIMATE'});assert.equal(est.realizedOpen,null);
});

test('the rules identify 9% as signal-only when the shared testnet budget is 15%',()=>{
 const limits=liveConfig({LIVE_TRADING_MODE:'TESTNET',LIVE_DAILY_MAX_LOSS_PCT:'9'});
 const rows=Object.fromEntries(liveRows({mode:'TESTNET',limits,testnet:{budget:{dailyLossPct:15,marginCapPct:30}}}));
 assert.match(rows['위험 프로필'],/신호 자체 열린 위험·하루 9%/);
 assert.doesNotMatch(rows['위험 프로필'],/공동/);
 assert.match(rows['테스트넷 공동 한도'],/신호\+단타 하루 손실·열린 위험 15%/);
});
