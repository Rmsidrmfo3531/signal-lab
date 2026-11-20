import test from 'node:test';
import assert from 'node:assert/strict';
import {summarizeIncome} from '../exchange_pnl.mjs';
import {createDailyPnl} from '../daily_pnl.mjs';
import {buildCopyAnalytics,exportCopyTradesCSV} from '../copy_analytics.mjs';
import {AccountAlerts,formatScalpStatusReply} from '../account_alerts.mjs';
import {CopyControls} from '../copy_controls.mjs';
import {CopyExecutor,copyConfig} from '../copy_executor.mjs';
import {analyticsHTML,copyHTML,scalpDetailsHTML,setAnalyticsOpen,setAnalyticsTab,setScalpSimOpen,resetScalpSimParams} from '../public/live_control.js';

const T0=Date.parse('2026-11-20T06:00:00Z'); // 15:00 KST

test('exchange_pnl bySymbol includes displaySymbol and daily_pnl caches costSummary without altering status()',async()=>{
 const rows=[
  {symbol:'NCSKANTHROPIC2USD-USDT',incomeType:'REALIZED_PNL',income:'14.1155',time:T0,tranId:'1'},
  {symbol:'NCSKANTHROPIC2USD-USDT',incomeType:'TRADING_FEE',income:'-0.6143',time:T0+1000,tranId:'2'},
  {symbol:'BTC-USDT',incomeType:'REALIZED_PNL',income:'12.4118',time:T0+2000,tranId:'3'},
  {symbol:'BTC-USDT',incomeType:'TRADING_FEE',income:'-43.1642',time:T0+3000,tranId:'4'},
  {symbol:'BTC-USDT',incomeType:'FUNDING_FEE',income:'-0.3903',time:T0+4000,tranId:'5'},
 ];
 const s=summarizeIncome(rows,null,{since:T0-1000,now:T0+10000});
 const anth=s.bySymbol.find(x=>x.symbol==='NCSKANTHROPIC2USD-USDT');
 assert.equal(anth.displaySymbol,'ANTHROPICUSDT');
 const btc=s.bySymbol.find(x=>x.symbol==='BTC-USDT');
 assert.equal(btc.displaySymbol,'BTC-USDT');

 const d=createDailyPnl({resetAt:T0-1000,now:()=>T0+10000,client:{income:async()=>rows}});
 await d.refresh();
 // status() keeps its exact original keys
 assert.deepEqual(Object.keys(d.status()).sort(),['at','availableSince','byDay','error','errorAt','resetAt','since']);
 const costs=d.costSummary();
 assert.equal(costs.realizedPnlUSD,26.5273);
 assert.equal(costs.feesUSD,-43.7785);
 assert.equal(costs.fundingUSD,-0.3903);
 assert.equal(costs.bySymbol.length,2);
});

test('buildCopyAnalytics fee/funding breakdown, topFeeLeaks, UI rendering, and CSV export',()=>{
 const exchangeCosts={
  realizedPnlUSD:44.58,feesUSD:-53.13,fundingUSD:-0.83,tradingNetUSD:-9.38,closes:25,
  bySymbol:[
   {symbol:'BTC-USDT',displaySymbol:'BTC-USDT',closes:21,pnlUSD:12.41,feeUSD:-43.16,fundingUSD:-0.39,netUSD:-31.14},
   {symbol:'NCSKSNDK2USD-USDT',displaySymbol:'SNDKUSDT',closes:4,pnlUSD:25.27,feeUSD:-3.8,fundingUSD:-0.42,netUSD:21.05},
  ],
 };
 const an=buildCopyAnalytics({
  copyClosed:[{symbol:'SNDKUSDT',direction:'LONG',leverage:20,openedAt:T0-3600000,closedAt:T0-1800000,netUSD:10,pnlUSD:11.5,feeUSD:-1.5,netSource:'EXCHANGE_FILLS'}],
  manualClosed:[{id:'m1',symbol:'BTCUSDT',direction:'SHORT',leverage:50,openedAt:T0-7200000,closedAt:T0-600000,netUSD:-31.14,pnlUSD:12.41,feeUSD:-43.16,fundingUSD:-0.39,netSource:'EXCHANGE',tags:['스캘핑'],note:'=SUM(1,2) 위험'}],
  exchangeCosts,
 });
 assert.equal(an.costs.source,'EXCHANGE');
 assert.equal(an.costs.feeTurnedLoss,true);
 assert.equal(an.costs.topFeeLeaks[0].symbol,'BTCUSDT');
 assert.equal(an.costs.topFeeLeaks[0].feeTurnedLoss,true);
 assert.equal(an.costs.topFeeLeaks[1].symbol,'SNDKUSDT');

 setAnalyticsOpen(true);
 setAnalyticsTab('symbol');
 const html=analyticsHTML(an);
 assert.match(html,/수수료 · 펀딩비 비중/);
 assert.match(html,/수수료로 손실 전환/);
 assert.match(html,/수수료 누수 Top/);
 assert.match(html,/BTCUSDT/);
 assert.match(html,/<th class="num">수수료<\/th>/);
 setAnalyticsOpen(false);

 // CSV export includes BOM, clean symbols, tags, and neutralizes Excel formula injection
 const csv=exportCopyTradesCSV({
  copyClosed:[{symbol:'NCSKSNDK2USDUSDT',direction:'LONG',leverage:10,adds:1,reduces:0,avg:100,pnlUSD:12,feeUSD:-1.5,netUSD:10.5,netSource:'EXCHANGE_FILLS',closeReason:'TRADER_CLOSE',openedAt:T0-3600000,closedAt:T0-1800000}],
  manualClosed:[{symbol:'BTCUSDT',direction:'SHORT',leverage:50,adds:0,reduces:0,avg:61500,pnlUSD:12.41,feeUSD:-43.16,fundingUSD:-0.39,netUSD:-31.14,netSource:'EXCHANGE',closeReason:'MANUAL_OR_VENUE_CLOSE',openedAt:T0-7200000,closedAt:T0-600000,tags:['스캘핑','주의'],note:'=HYPERLINK("http://evil")'}],
 });
 assert.ok(csv.startsWith('\uFEFF'));
 assert.match(csv,/"SNDKUSDT","NCSKSNDK2USDUSDT"/);
 assert.match(csv,/"스캘핑, 주의","'=HYPERLINK\(""http:\/\/evil""\)"/);

 // copyHTML shows CSV export button on LIVE when closed trades exist
 const cHtml=copyHTML({
  mode:'LIVE',enabled:true,armed:true,sizing:'BALANCE_RATIO',traderBalanceUSD:20000,maxTotalMarginPct:90,ledgerLossPct:50,
  funds:{equity:3000,available:2500,at:T0},positions:[],venuePositions:[],venuePositionsAt:T0,
  closed:[{symbol:'BTCUSDT',direction:'LONG',adds:0,openedAt:T0-60000,closedAt:T0,netUSD:5,netSource:'EXCHANGE_FILLS'}],
 });
 assert.match(cHtml,/href="\/api\/copy\/export" download>CSV 내보내기<\/a>/);
});

test('Telegram bot commands: /scalp, /size, /block, /unblock work cleanly and enforce auth',async()=>{
 const controls=new CopyControls();
 const alerts=new AccountAlerts({
  allowedChatId:'777',
  now:()=>T0,
  getScalpStatus:async()=>({
   mode:'TESTNET',armed:true,blocked:null,scanning:false,trendMode:'record',stopLossEnabled:false,repeatedScaleIn:true,
   open:0,universeCount:80,lastScan:{at:T0-120000,checked:80,failed:0,signals:1,zoneSignals:0,entered:0,error:null},
  }),
  onControls:patch=>{
   if(patch)controls.configure(patch);
   return {controls:controls.status(),traderBalanceUSD:controls.effectiveTraderBalanceUSD(20000)};
  },
 });

 // Unauthorized user ignored
 assert.equal(await alerts.handleCommand('/scalp','999',T0),null);

 // /scalp
 const sc=await alerts.handleCommand('/scalp','777',T0);
 assert.match(sc,/테스트넷 단타 현황/);
 assert.match(sc,/검사 80\/80종목/);
 assert.match(sc,/2분 전/);

 // /size
 const szCur=await alerts.handleCommand('/size','777',T0);
 assert.match(szCur,/\$20,000/);
 const szHalf=await alerts.handleCommand('/size 0.5x','777',T0);
 assert.match(szHalf,/\$40,000/);
 assert.equal(controls.effectiveTraderBalanceUSD(20000),40000);
 const sz15k=await alerts.handleCommand('/size 15k','777',T0);
 assert.match(sz15k,/\$15,000/);
 assert.equal(controls.effectiveTraderBalanceUSD(20000),15000);
 const szBad=await alerts.handleCommand('/size 50','777',T0);
 assert.match(szBad,/1,000 ~ 1,000,000/);

 // /block & /unblock with TradFi symbol normalization
 const blk=await alerts.handleCommand('/block NCSKANTHROPIC2USDUSDT','777',T0);
 assert.match(blk,/ANTHROPICUSDT/);
 assert.deepEqual(controls.status().blockedSymbols,['ANTHROPICUSDT']);
 const blkList=await alerts.handleCommand('/block','777',T0);
 assert.match(blkList,/ANTHROPICUSDT/);
 const unblk=await alerts.handleCommand('/unblock anthropic','777',T0);
 assert.match(unblk,/제거했습니다/);
 assert.deepEqual(controls.status().blockedSymbols,[]);
});

test('scalp simulator defaults sync with live server settings (trendMode=record -> off, stopLossEnabled=false -> minNetRR=0)',()=>{
 resetScalpSimParams();
 setScalpSimOpen(true);
 const htmlRecord=scalpDetailsHTML({
  mode:'TESTNET',credentials:true,armed:true,
  settings:{minMovePct:5,trendMode:'record',zoneSignals:true,stopLossEnabled:false,minNetRR:1,sides:['LONG','SHORT']},
  stats:{},
 });
 assert.match(htmlRecord,/<option value="off" selected>OFF \(모두 허용\)<\/option>/);
 assert.match(htmlRecord,/name="minNetRR"[^>]*value="0"/);

 const htmlStrict=scalpDetailsHTML({
  mode:'TESTNET',credentials:true,armed:true,
  settings:{minMovePct:6,trendMode:'on',zoneSignals:false,stopLossEnabled:true,minNetRR:1.2,sides:['LONG']},
  stats:{},
 });
 assert.match(htmlStrict,/<option value="on" selected>ON \(역추세 제외\)<\/option>/);
 assert.match(htmlStrict,/name="minNetRR"[^>]*value="1\.2"/);
 assert.match(htmlStrict,/<option value="LONG" selected>롱만<\/option>/);
 setScalpSimOpen(false);
});

test('CopyExecutor retries transient openOrders read once and avoids duplicate LATE_ENTRY on repeated VENUE_POSITION_EXISTS',async()=>{
 let openCalls=0,placed=0;
 const client={
  positionMode:async()=>({dualSidePosition:false}),
  positions:async()=>[],
  openOrders:async sym=>{
   openCalls++;
   if(openCalls<=2)throw Object.assign(Error('network blip'),{code:'NETWORK_UNREACHABLE'});
   return [];
  },
  setMarginType:async()=>({}),
  setLeverage:async()=>({leverage:10}),
  placeOrder:async()=>{placed++;return {orderId:'1',avgPrice:'100',executedQty:'1'}},
  balance:async()=>({balance:{equity:'3000',availableMargin:'2500'}}),
 };
 const ex=new CopyExecutor({
  config:copyConfig({COPY_SIZING:'MIN_ORDER',COPY_STOPS:'off'},'TESTNET'),
  client,auditOrders:true,goneRecheckMs:10,sleep:async()=>{},
  contractOf:async()=>({symbol:'BTCUSDT',venueSymbol:'BTC-USDT',tradable:true,tickSize:'0.1',quantityStep:'0.001',minQuantityBase:'0.001',minNotionalUSDT:2}),
  markOf:async()=>100,balance:async()=>({equity:3000,available:2500}),now:()=>T0,
 });
 await ex.reconcile();
 const r=await ex.handle({id:1,date:T0,text:'📌 포지션 진입\n🪙 BTCUSDT  🟢 Long  ×10\n수량 1\n진입가 100 USDT'});
 assert.equal(r.ok,true);
 assert.equal(openCalls,3,'scoped fail -> account fail -> 1 transient retry succeeds');
 assert.equal(placed,1);

 // Repeated VENUE_POSITION_EXISTS on trader adds should not double-log LATE_ENTRY
 const client2={
  ...client,
  positions:async()=>[{symbol:'BTC-USDT',positionAmt:'5',avgPrice:'100',positionSide:'BOTH'}],
  openOrders:async()=>[],
 };
 const ex2=new CopyExecutor({
  config:copyConfig({COPY_SIZING:'MIN_ORDER',COPY_STOPS:'off'},'TESTNET'),
  client:client2,goneRecheckMs:10,sleep:async()=>{},
  contractOf:async()=>({symbol:'BTCUSDT',venueSymbol:'BTC-USDT',tradable:true,tickSize:'0.1',quantityStep:'0.001',minQuantityBase:'0.001',minNotionalUSDT:2}),
  markOf:async()=>100,balance:async()=>({equity:3000,available:2500}),now:()=>T0,
 });
 await ex2.handle({id:10,date:T0,text:'📌 포지션 진입\n🪙 BTCUSDT  🟢 Long  ×10\n수량 1\n진입가 100 USDT'});
 await ex2.handle({id:11,date:T0+60000,text:'📊 포지션 변경\n🪙 BTCUSDT  🟢 Long\n수량 1 → 2\n현재가 100 USDT'});
 assert.equal(ex2.status().events.filter(e=>e.type==='LATE_ENTRY').length,0,'no redundant LATE_ENTRY after VENUE_POSITION_EXISTS');
 assert.equal(ex2.status().events.filter(e=>e.reason==='VENUE_POSITION_EXISTS').length,2);
});
