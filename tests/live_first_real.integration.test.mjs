// Real-account (COPY_MODE=LIVE) half of the live-first integration suite, split from
// live_first.integration.test.mjs so each file stays inside the 60 s per-file CI test timeout.
// The BingX accounts are in-memory fakes inside tests/mock_pipeline.mjs; nothing leaves the process.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {ENTRY} from './fixtures/pipeline_market.mjs';
import {fetchLocal} from './helpers/http_request.mjs';
import {sandbox,until} from './helpers/pipeline_sandbox.mjs';
import {PNL_CALENDAR_RESET_AT} from '../daily_pnl.mjs';

const KEY='synthetic-testnet-key-0123456789abcdef',SECRET='synthetic-testnet-secret-0123456789abcdef';

test('real-account calendar starts at the reset time and excludes cash flows',async()=>{
 const resetAt=PNL_CALENDAR_RESET_AT,day=new Date(resetAt+9*3600000).toISOString().slice(0,10);
 const row={incomeType:'REALIZED_PNL',income:'27.50',time:resetAt+60000,symbol:'BTC-USDT',tranId:'fixture-income'};
 const older={...row,income:'97',time:resetAt-1,tranId:'before-reset'};
 const deposit={...row,incomeType:'DEPOSIT',income:'200',tranId:'deposit'};
 const withdrawal={...row,incomeType:'WITHDRAWAL',income:'-100',tranId:'withdrawal'};
 const clockOffsetMs=resetAt+3600000-Date.now();
 const app=await sandbox({scenarios:{},clockOffsetMs,fakeBingxLiveIncome:[older,row,deposit,withdrawal],env:{
  BINGX_API_KEY:KEY,BINGX_API_SECRET:SECRET,LIVE_TRADING_MODE:'OFF',SCALP_EXEC_MODE:'OFF',
  COPY_MODE:'LIVE',COPY_LIVE_CONFIRM:'REAL_MONEY_COPY',PAPER_TRADING:'off',
 }});
 try{
  await app.start();
  const copy=await until(()=>app.get('/api/copy'),c=>c.daily?.at!=null);
  assert.equal(copy.mode,'LIVE');
  assert.equal(copy.daily.since,resetAt);
  assert.equal(copy.daily.resetAt,resetAt);
  assert.deepEqual(copy.daily.byDay,{[day]:27.5});
  assert.equal(copy.daily.error,null);
  const overview=await app.get('/api/live/overview');
  assert.deepEqual(overview.copy.daily.byDay,{[day]:27.5});
  const audited=await until(()=>app.get('/api/copy'),c=>c.audit?.ready,{timeout:15000,label:'real copy startup position audit'});
  assert.ok(audited.audit.positionAt>0);assert.deepEqual(audited.audit.lanes,[]);
  const requests=(await fs.readFile(app.requests,'utf8')).trim().split('\n').map(JSON.parse);
  const reads=requests.filter(r=>r.host==='open-api.bingx.com'&&r.path==='/openApi/swap/v2/user/income');
  assert.ok(reads.length>0,'the calendar uses the exchange income endpoint');
 }finally{await app.close()}
});

test('the background scheduler settles copy fills without a manual recheck request',{timeout:25000},async()=>{
 const now=Date.now(),openedAt=now-90000,closedAt=now-30000,venueSymbol='SNDK-USDT';
 const trade={id:'settlement-fixture',status:'CLOSED',symbol:'SNDKUSDT',venueSymbol,direction:'LONG',openedAt,closedAt,
  fillTracked:true,fillOrders:[{id:'901',side:'BUY',confirmed:true},{id:'902',side:'SELL',confirmed:true}],netSource:'UNKNOWN'};
 const fill=(orderId,side,time,realizedPnl)=>({orderId,tradeId:orderId,symbol:venueSymbol,side,time,qty:1,price:50,realizedPnl,fee:-.01});
 const app=await sandbox({scenarios:{},fakeBingxLiveIncome:[],
  fakeBingxLiveFills:[fill('901','BUY',openedAt,0),fill('902','SELL',closedAt,1)],env:{
   BINGX_API_KEY:KEY,BINGX_API_SECRET:SECRET,LIVE_TRADING_MODE:'OFF',SCALP_EXEC_MODE:'OFF',
   COPY_MODE:'LIVE',COPY_LIVE_CONFIRM:'REAL_MONEY_COPY',PAPER_TRADING:'off',
  }});
 try{
  await fs.writeFile(app.data+'/copy-store-live.json',JSON.stringify({closed:[trade]}));
  await app.start();
  const copy=await until(()=>app.get('/api/copy'),s=>s.closed?.[0]?.settlement?.state==='CONFIRMED',
   {timeout:19000,label:'automatic close settlement'});
  assert.equal(copy.closed[0].netSource,'EXCHANGE_FILLS');
  assert.equal(copy.closed[0].netUSD,.98);
 }finally{await app.close()}
});

test('real manual entry and add reach Telegram only after matching exchange fills',{timeout:30000},async()=>{
 const position={symbol:'BTC-USDT',positionSide:'BOTH',positionAmt:'0.01',avgPrice:'50000',markPrice:'50100',leverage:'10'};
 const app=await sandbox({scenarios:{},fakeBingxLiveIncome:[],fakeBingxLiveFills:[],env:{
  BINGX_API_KEY:KEY,BINGX_API_SECRET:SECRET,LIVE_TRADING_MODE:'OFF',SCALP_EXEC_MODE:'OFF',
  COPY_MODE:'LIVE',COPY_LIVE_CONFIRM:'REAL_MONEY_COPY',PAPER_TRADING:'off',
  TELEGRAM_BOT_TOKEN:'mock-bot-token',TELEGRAM_SCANNER_CHAT_ID:'@scanner_fixture',
 }});
 const notices=async()=>(await fs.readFile(app.requests,'utf8')).trim().split('\n').map(JSON.parse).filter(r=>r.host==='api.telegram.org'&&r.path==='/sendMessage');
 try{
  await app.start();
  const before=await until(()=>app.get('/api/copy'),c=>c.venuePositionsAt!=null);
  assert.equal(before.manual.open.length,0);
  const fill=(id,price)=>({symbol:'BTC-USDT',side:'BUY',positionSide:'BOTH',tradeId:id,orderId:id,qty:.01,price,time:Date.now()+1});
  const first=fill('101',50000);
  await app.write({fakeBingxLivePositions:[position],fakeBingxLiveFills:[]});
  await until(()=>app.get('/api/copy'),c=>c.manual?.open?.length===1,{timeout:14000,label:'manual position after two reads'});
  assert.equal((await notices()).length,0,'position snapshot alone sends nothing');
  await app.write({fakeBingxLivePositions:[{...position,positionAmt:'0.02',avgPrice:'50050'}],fakeBingxLiveFills:[first,fill('102',50100)]});
  await until(()=>app.get('/api/copy'),c=>c.manual?.open?.[0]?.size===0.02,{timeout:12000,label:'updated manual position size'});
  await app.write({clockOffsetMs:60000});
  const added=await until(async()=>{await app.get('/api/copy');return notices()},list=>list.length===2,{timeout:16000,label:'confirmed Telegram notices'});
  assert.match(added[0].text,/^🟢 수동 \| 신규 진입\nBTCUSDT · 롱 · 10배/);
  assert.match(added[0].text,/수량 0\.01 · 진입 체결가 50,000 USDT\n증거금 약 50\.00 USDT/);
  assert.match(added[0].text,/\n가용 증거금 조회 불가\n/);
  assert.deepEqual(added[0].entities,[{type:'bold',offset:0,length:'🟢 수동 | 신규 진입'.length}]);
  assert.match(added[1].text,/^🟢 수동 \| 추가 진입\nBTCUSDT · 롱 · 10배\n수량 \+0\.01 · 잔여 0\.02[\s\S]+이번 증거금 약 50\.10 USDT\n포지션 총 증거금 약 100\.10 USDT/);
  assert.deepEqual(added[1].entities,[{type:'bold',offset:0,length:'🟢 수동 | 추가 진입'.length}]);
 }finally{await app.close()}
});

test('manual entry displays the last verified USDT margin with its timestamp when the wallet read fails',{timeout:25000},async()=>{
 const symbol='EVAA-USDT',wallet={asset:'USDT',balance:'200',equity:'200',availableMargin:'137.25'};
 const app=await sandbox({scenarios:{},fakeBingxLiveIncome:[],fakeBingxLiveFills:[],fakeBingxLiveBalances:wallet,env:{
  BINGX_API_KEY:KEY,BINGX_API_SECRET:SECRET,LIVE_TRADING_MODE:'OFF',SCALP_EXEC_MODE:'OFF',
  COPY_MODE:'LIVE',COPY_LIVE_CONFIRM:'REAL_MONEY_COPY',PAPER_TRADING:'off',
  TELEGRAM_BOT_TOKEN:'mock-bot-token',TELEGRAM_SCANNER_CHAT_ID:'@scanner_fixture',
 }});
 try{
  await app.start();
  await until(()=>app.get('/api/copy'),c=>c.funds?.available===137.25&&c.venuePositionsAt!=null,{timeout:7000,label:'flat balance and position snapshot'});
  const position={symbol,positionSide:'BOTH',positionAmt:'-1',avgPrice:'5.2604',markPrice:'5.20',leverage:'5'};
  const fill={symbol,side:'SELL',positionSide:'BOTH',tradeId:'919',orderId:'919',qty:1,price:5.2606,time:Date.now()+1};
  await app.write({fakeBingxLiveBalances:null,fakeBingxLivePositions:[position],fakeBingxLiveFills:[fill]});
  const sent=await until(async()=>{await app.get('/api/copy');return (await fs.readFile(app.requests,'utf8')).trim().split('\n').map(JSON.parse)
   .find(x=>x.path==='/sendMessage'&&x.text?.startsWith('🔴 수동 | 신규 진입'))},Boolean,{timeout:16000,label:'manual entry with last available margin'});
  assert.match(sent.text,/EVAAUSDT · 숏 · 5배\n수량 1 · 진입 체결가 5\.2606 USDT/);
  assert.match(sent.text,/\n포지션 평균 진입가 5\.2604 USDT\n/);
  assert.match(sent.text,/\n가용 증거금 137\.25 USDT · 최근 조회 [\d-]+ [\d:]+ KST\n/);
 }finally{await app.close()}
});

test('Chrome and the scanner channel receive the same confirmed copy trade even with legacy Telegram notices off',{timeout:25000},async()=>{
 const at=Date.now()-1000,orderId='5071',position={id:'fixture-copy',status:'CLOSED',symbol:'BTCUSDT',venueSymbol:'BTC-USDT',direction:'LONG',leverage:10,
  openedAt:at,closedAt:at+300,steps:[{kind:'OPEN',at,qty:.02}],fillOrders:[{id:orderId,side:'BUY',confirmed:true}],netSource:'EXCHANGE_FILLS'};
 const exchangeOrder={symbol:'BTC-USDT',side:'BUY',positionSide:'BOTH',status:'FILLED',orderId,executedQty:'0.02',avgPrice:'50000',updateTime:at};
 const lateAt=at-60000,lateOrder={...exchangeOrder,symbol:'ETH-USDT',orderId:'5070',updateTime:lateAt};
 const late={...position,id:'late-copy',symbol:'ETHUSDT',venueSymbol:'ETH-USDT',openedAt:lateAt,closedAt:lateAt+300,
  steps:[{kind:'OPEN',at:lateAt,qty:.02}],fillOrders:[{id:lateOrder.orderId,side:'BUY',confirmed:true}]};
 const app=await sandbox({scenarios:{},fakeBingxLiveIncome:[],fakeBingxLivePositions:[],fakeBingxLiveOrders:[exchangeOrder,lateOrder],
  fakeBingxLiveBalances:[{asset:'USDC',availableMargin:'5000'},{asset:'USDT',equity:'200',availableMargin:'137.25'}],env:{
  BINGX_API_KEY:KEY,BINGX_API_SECRET:SECRET,LIVE_TRADING_MODE:'OFF',SCALP_EXEC_MODE:'OFF',COPY_MODE:'LIVE',COPY_LIVE_CONFIRM:'REAL_MONEY_COPY',
  TELEGRAM_BOT_TOKEN:'mock-bot-token',TELEGRAM_CHAT_ID:'-123456',TELEGRAM_SCANNER_CHAT_ID:'@scanner_fixture',PAPER_TRADING:'off',
 }});
 const read=async()=>{const records=(await fs.readFile(app.requests,'utf8')).trim().split('\n').map(JSON.parse);
  return records.filter(r=>r.host==='api.telegram.org'&&r.text?.startsWith('📌 포지션 진입'))};
 try{
  await fs.writeFile(`${app.data}/store.json`,JSON.stringify({notifySettings:{telegramLive:false,telegramSignals:false,scannerAlertsOffV1:true}}));
  await fs.writeFile(`${app.data}/copy-store-live.json`,JSON.stringify({positions:{},closed:[late,position]}));
  await app.start();
  const events=await fetchLocal(app.base+'/events',{timeoutMs:12000});assert.equal(events.status,200);
  const reader=events.body.getReader();
  const chrome=async()=>{const decoder=new TextDecoder();let contents='';
   for(;;){const {done,value}=await reader.read();if(done)throw Error('Chrome notice was missing');contents+=decoder.decode(value,{stream:true});
    const matches=[...contents.matchAll(/event: live-notice\ndata: ([^\n]+)\n\n/g)];
    if(matches.length>=2){await reader.cancel();return matches.map(m=>JSON.parse(m[1]).text)}
   }};
  const [notices,chromeTexts]=await Promise.all([until(async()=>{await app.get('/api/copy');return read()},x=>x.length===2,{timeout:12000,label:'Telegram copy order receipts'}),chrome()]);
  const notice=notices.find(n=>n.text.includes('BTCUSDT'));
  assert.deepEqual(notices.map(n=>n.text).sort(),chromeTexts.sort(),'both channels also receive a delayed confirmation');
  assert.ok(notices.every(n=>n.chatId===-1001234567890));
  const lookups=(await fs.readFile(app.requests,'utf8')).trim().split('\n').map(JSON.parse).filter(r=>r.path==='/getChat');
  assert.deepEqual(lookups.map(r=>r.chatId),['@scanner_fixture']);
  assert.match(notice.text,/^📌 포지션 진입\n━+\nBTCUSDT  🟢 롱  ×10\n━+\n진입가 50,000 USDT\n현재가 50,000 USDT\n수량 0\.02\n증거금 약 100\.00 USDT\n가용 증거금 137\.25 USDT/);
  assert.deepEqual(notice.entities.map(e=>notice.text.slice(e.offset,e.offset+e.length)),['📌 포지션 진입','BTCUSDT','50,000 USDT']);
  assert.equal((await app.get('/api/copy')).manual.open.length,0);
  const file=async()=>JSON.parse(await fs.readFile(`${app.data}/manual-trades-live.json`,'utf8'));
  const ledger=await until(file,x=>x.telegramSent===2);assert.equal(ledger.telegramByOrigin.COPY,2);assert.equal(ledger.telegramChatType,'channel');assert.deepEqual(ledger.telegramQueue,[]);
  assert.equal((await read()).length,2);
 }finally{await app.close()}
});
