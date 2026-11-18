// Paper trading off (the default): a final signal still reaches the live (TESTNET) order path, the
// 실매매 screen data shows the position, and a manual stop change works without a paper record.
// The BingX testnet is an in-memory fake inside tests/mock_pipeline.mjs; nothing leaves the process.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {ENTRY} from './fixtures/pipeline_market.mjs';
import {fetchLocal} from './helpers/http_request.mjs';
import {sandbox,until} from './helpers/pipeline_sandbox.mjs';

const KEY='synthetic-testnet-key-0123456789abcdef',SECRET='synthetic-testnet-secret-0123456789abcdef';

test('paper off by default: a final signal opens a TESTNET live position, no paper position, and the live overview shows it',{timeout:60000},async()=>{
 const app=await sandbox({scenarios:{BTCUSDT:'breakout-long'},prices:{BTCUSDT:ENTRY},emit:true,fakeBingxTestnet:true,
  env:{PAPER_TRADING:'',LIVE_TRADING_MODE:'TESTNET',LIVE_VENUES:'BINGX',BINGX_API_KEY:KEY,BINGX_API_SECRET:SECRET}});
 const post=async(target,body)=>{const r=await fetchLocal(app.base+target,{method:'POST',headers:{'content-type':'application/json',origin:app.base,'sec-fetch-site':'same-origin'},body:JSON.stringify(body)});return {status:r.status,body:await r.json()}};
 try{
  await app.start();
  const status=await app.get('/api/status');assert.equal(status.paperTrading,false);assert.equal(status.live.mode,'TESTNET');
  const pkg=JSON.parse(await fs.readFile(new URL('../package.json',import.meta.url),'utf8'));
  const update=await app.get('/api/update'),progress=await app.get('/api/update/git/progress');
  assert.match(pkg.displayVersion,/^\d{4}-\d{2}-\d{2} (?:[01]\d|2[0-3]):[0-5]\d KST$/);
  for(const response of [status,update,progress]){
   assert.equal(response.displayVersion,pkg.displayVersion);
   assert.equal(response.version,pkg.version);
  }
  assert.equal(progress.bootId,update.bootId);
  assert.equal((await app.get('/api/scalp')).enabled,false,'paper-only scalps do not run with paper trading off');
  const before=await app.get('/api/live/overview');assert.equal(before.mode,'TESTNET');assert.equal(before.armed,false);assert.deepEqual(before.positions,[]);
  // Testnet reversal scalps: their own status and switch, disarmed at start, arm needs the confirm phrase.
  const sc=(await app.get('/api/scalp')).testnet;assert.equal(sc.mode,'TESTNET');assert.equal(sc.armed,false);assert.equal(sc.credentials,true);assert.equal(sc.strategy,'SCALP_REVERSAL');
  assert.equal(before.scalp.armed,false);assert.deepEqual(before.scalp.positions,[]);
  assert.equal((await post('/api/scalp/arm',{})).status,400);
  const armed=await post('/api/scalp/arm',{confirm:'SCALP_ARM'});assert.equal(armed.status,200,JSON.stringify(armed.body));assert.equal(armed.body.armed,true);
  assert.equal((await post('/api/scalp/disarm',{})).body.armed,false);
  // One testnet switch (user 2026-11-17): 활성화 turns on the signal strategy and the scalp; the shared 15 % budget is shown.
  assert.equal(before.testnet.armed,false);assert.equal(before.testnet.budget.dailyLossPct,15);assert.equal(before.testnet.stats.all.trades,0);
  const one=await post('/api/live/arm',{confirm:'ARM'});assert.equal(one.status,200,JSON.stringify(one.body));
  assert.equal(one.body.testnet.armed,true);assert.equal(one.body.testnet.scalp.armed,true);assert.equal(one.body.testnet.signal.armed,true);
  const both=await app.get('/api/live/overview');assert.equal(both.testnet.armed,true);assert.equal(both.scalp.armed,true);assert.equal(both.armed,true);
  assert.equal(both.scalp.settings.dailyLossPct,15);assert.equal(both.scalp.settings.sharedBudget,true);
  await app.get('/api/analyze?symbol=BTCUSDT');
  const overview=await until(()=>app.get('/api/live/overview'),o=>o.positions.length===1&&o.positions[0].status==='OPEN'&&Number.isFinite(o.positions[0].currentPrice),
   {timeout:20000,label:'live entry with paper off '+app.logs().slice(-1500)});
  const pos=overview.positions[0];
  assert.equal(pos.symbol,'BTCUSDT');assert.equal(pos.direction,'LONG');assert.equal(pos.venue,'BINGX');assert.equal(pos.statusKo,'보유 중');
  assert.equal(pos.firstEntryPrice,ENTRY,'first entry price from the fill');assert.ok(pos.averageEntryPrice>0);
  assert.ok(pos.leverage>=10&&pos.leverage<=30);assert.ok(pos.quantity.base>0);assert.ok(pos.stop<ENTRY);assert.equal(pos.targets.length,3);
  assert.ok(pos.adds.max>=0&&pos.adds.filled===0);assert.equal(pos.adds.pending.length,pos.adds.max,'resting split-buy orders are listed');
  assert.ok(pos.unrealized&&Number.isFinite(pos.unrealized.usd));assert.ok(['EXCHANGE','ESTIMATE'].includes(pos.unrealized.source));
  assert.equal(overview.balance.usd,100000);assert.equal(overview.paperTrading,false);assert.equal(overview.summary.trades,0);
  // No paper position, no paper notice.
  const paper=await app.get('/api/paper');assert.equal(paper.enabled,false);assert.equal(paper.openCount,0);assert.equal(paper.pendingCount,0);
  assert.deepEqual((await app.get('/api/paper/notifications')).history,[]);
  // Manual stop change through the old endpoint works for a live position alone (no paper record).
  const tighter=Number((pos.stop+(ENTRY-pos.stop)/2).toFixed(2));
  const crossed=await post('/api/paper/levels',{key:pos.signalKey,stop:ENTRY+50});assert.equal(crossed.status,400);assert.ok(crossed.body.reasons.includes('STOP_ALREADY_CROSSED'));
  const moved=await post('/api/live/levels',{key:pos.signalKey,stop:tighter});
  assert.equal(moved.status,200,JSON.stringify(moved.body));assert.equal(moved.body.stopMoved,true);
  const after=await app.get('/api/live/overview');assert.ok(Math.abs(after.positions[0].stop-tighter)<0.011);
  const viaPaper=await post('/api/paper/levels',{key:pos.signalKey,stop:tighter});assert.equal(viaPaper.status,200);assert.equal(viaPaper.body.changed,false);
  // Orders went to the testnet host only.
  const requests=(await fs.readFile(app.requests,'utf8')).trim().split('\n').map(JSON.parse);
  const orders=requests.filter(r=>r.path==='/openApi/swap/v2/trade/order'&&r.method==='POST');
  assert.ok(orders.length>=2&&orders.every(r=>r.host==='open-api-vst.bingx.com'));
  assert.ok(orders.some(r=>r.type==='STOP_MARKET'&&Math.abs(Number(r.stopPrice)-tighter)<0.011),'the new stop was placed on the venue');
  assert.ok(!requests.some(r=>r.host==='open-api.bingx.com'&&r.method&&r.method!=='GET'),'nothing is written to the real BingX host');
  for(const secret of [KEY,SECRET])assert.ok(!app.logs().includes(secret),'keys never reach the server output');
 }finally{await app.close()}
});

test('PAPER_TRADING=on turns automatic paper entries back on',{timeout:30000},async()=>{
 const app=await sandbox({scenarios:{BTCUSDT:'breakout-long'},prices:{BTCUSDT:ENTRY},emit:true,env:{PAPER_TRADING:'on'}});
 try{
  await app.start();assert.equal((await app.get('/api/status')).paperTrading,true);
  await app.get('/api/analyze?symbol=BTCUSDT');
  const paper=await until(()=>app.get('/api/paper'),p=>p.openCount===1,{label:'paper entry with PAPER_TRADING=on'});
  assert.equal(paper.enabled,true);assert.equal((await app.get('/api/notifications/settings')).paperTrading,true);
  assert.equal((await app.get('/api/live/overview')).mode,'OFF','live stays OFF by default');
 }finally{await app.close()}
});

test('testnet budget settings are saved and both caps follow the latest BingX testnet equity',{timeout:25000},async()=>{
 const app=await sandbox({scenarios:{},fakeBingxTestnet:true,fakeBingxTestnetEquity:1000,env:{
  BINGX_API_KEY:KEY,BINGX_API_SECRET:SECRET,LIVE_TRADING_MODE:'TESTNET',LIVE_VENUES:'BINGX',PAPER_TRADING:'off',SCALP_EXEC_MODE:'OFF',
 }});
 const edit=async body=>{const r=await fetchLocal(app.base+'/api/live/testnet-budget',{method:'POST',headers:{'content-type':'application/json',origin:app.base,'sec-fetch-site':'same-origin'},body:JSON.stringify(body)});return [r.status,await r.json()]};
 try{
  await app.start();
  const getBudget=async()=>(await app.get('/api/live/overview')).testnet.budget;
  const before=await getBudget();assert.equal(before.accountEquityUSD,1000);assert.equal(before.limitUSD,150);assert.equal(before.marginCapUSD,300);
  const bad=await edit({dailyLossPct:12.5,marginCapPct:31});assert.equal(bad[0],400);
  const [status,saved]=await edit({dailyLossPct:12.5,marginCapPct:25});assert.equal(status,200);
  assert.deepEqual([saved.budget.limitUSD,saved.budget.marginCapUSD],[125,250]);
  await app.write({fakeBingxTestnetEquity:1600});
  const after=await until(getBudget,b=>b.accountEquityUSD===1600,{timeout:12000,label:'new testnet account equity'});
  assert.deepEqual([after.equityUSD,after.limitUSD,after.marginCapUSD],[1600,200,400]);assert.ok(after.balanceAt>before.balanceAt);
 }finally{await app.close()}
});

test('real-account calendar publishes recent income when older windows are empty and balance fails',async()=>{
 const at=Date.now()-60000,day=new Date(at+9*3600000).toISOString().slice(0,10);
 const row={incomeType:'REALIZED_PNL',income:'27.50',time:at,symbol:'BTC-USDT',tranId:'fixture-income'};
 const app=await sandbox({scenarios:{},fakeBingxLiveIncome:[row],env:{
  BINGX_API_KEY:KEY,BINGX_API_SECRET:SECRET,LIVE_TRADING_MODE:'OFF',SCALP_EXEC_MODE:'OFF',
  COPY_MODE:'LIVE',COPY_LIVE_CONFIRM:'REAL_MONEY_COPY',PAPER_TRADING:'off',
 }});
 try{
  await app.start();
  const copy=await until(()=>app.get('/api/copy'),c=>c.daily?.at!=null);
  assert.equal(copy.mode,'LIVE');
  assert.deepEqual(copy.daily.byDay,{[day]:27.5});
  assert.equal(copy.daily.error,null);
  const overview=await app.get('/api/live/overview');
  assert.deepEqual(overview.copy.daily.byDay,{[day]:27.5});
  const audited=await until(()=>app.get('/api/copy'),c=>c.audit?.ready,{timeout:15000,label:'real copy startup position audit'});
  assert.ok(audited.audit.positionAt>0);assert.deepEqual(audited.audit.lanes,[]);
  const requests=(await fs.readFile(app.requests,'utf8')).trim().split('\n').map(JSON.parse);
  const reads=requests.filter(r=>r.host==='open-api.bingx.com'&&r.path==='/openApi/swap/v2/user/income');
  assert.ok(reads.length>1,'the mock served older windows before the recent income');
 }finally{await app.close()}
});

test('real manual entry and add reach Telegram only after matching exchange fills',{timeout:30000},async()=>{
 const position={symbol:'BTC-USDT',positionSide:'BOTH',positionAmt:'0.01',avgPrice:'50000',markPrice:'50100',leverage:'10'};
 const app=await sandbox({scenarios:{},fakeBingxLiveIncome:[],fakeBingxLiveFills:[],env:{
  BINGX_API_KEY:KEY,BINGX_API_SECRET:SECRET,LIVE_TRADING_MODE:'OFF',SCALP_EXEC_MODE:'OFF',
  COPY_MODE:'LIVE',COPY_LIVE_CONFIRM:'REAL_MONEY_COPY',PAPER_TRADING:'off',
  TELEGRAM_BOT_TOKEN:'mock-bot-token',TELEGRAM_CHAT_ID:'-123456',
 }});
 const notices=async()=>(await fs.readFile(app.requests,'utf8')).trim().split('\n').map(JSON.parse).filter(r=>r.host==='api.telegram.org');
 try{
  await app.start();
  const before=await until(()=>app.get('/api/copy'),c=>c.venuePositionsAt!=null);
  assert.equal(before.manual.open.length,0);
  const fill=(id,price)=>({symbol:'BTC-USDT',side:'BUY',positionSide:'BOTH',tradeId:id,orderId:id,qty:.01,price,time:Date.now()+1});
  const first=fill('101',50000);
  await app.write({fakeBingxLivePositions:[position],fakeBingxLiveFills:[first]});
  await until(()=>app.get('/api/copy'),c=>c.manual?.open?.length===1,{timeout:14000,label:'manual position after two reads'});
  assert.equal((await notices()).length,0,'position snapshot alone sends nothing');
  await app.write({fakeBingxLivePositions:[{...position,positionAmt:'0.02',avgPrice:'50050'}],fakeBingxLiveFills:[first,fill('102',50100)]});
  await until(()=>app.get('/api/copy'),c=>c.manual?.open?.[0]?.size===0.02,{timeout:12000,label:'updated manual position size'});
  await app.write({clockOffsetMs:60000});
  const added=await until(async()=>{await app.get('/api/copy');return notices()},list=>list.length===2,{timeout:16000,label:'confirmed Telegram notices'});
  assert.match(added[0].text,/^🔴 실계좌 \| 수동 \| 신규 진입\nBTCUSDT · 롱 · 10배/);
  assert.match(added[0].text,/수량 0\.01 · 평균 진입가 50,000 USDT/);
  assert.match(added[1].text,/^🔴 실계좌 \| 수동 \| 추가 진입[\s\S]*수량 \+0\.01 · 잔여 0\.02/);
 }finally{await app.close()}
});
