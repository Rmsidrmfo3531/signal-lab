import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import net from 'node:net';
import {once} from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {ENTRY} from './fixtures/pipeline_market.mjs';
import {PaperEngine} from '../paper.mjs';
import {trackChild,stopChild} from './helpers/child_process.mjs';
import {fetchLocal} from './helpers/http_request.mjs';
const project=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const nap=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(action,predicate,{timeout=7000,label='expected server state'}={}){
 const deadline=Date.now()+timeout;let last;
 while(Date.now()<deadline){try{last=await action();if(predicate(last))return last}catch{}await nap(60)}
 assert.fail(label+': '+JSON.stringify(last));
}
async function sandbox(config){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'signal-pipeline-'));
 const app=path.join(root,'app'),data=path.join(root,'isolated-records'),control=path.join(root,'control.json'),requests=path.join(root,'requests.jsonl');
 // Copy application code only: never adopt a user's .env, store.json or update staging.
 await fs.cp(project,app,{recursive:true,filter:source=>{
  const relative=path.relative(project,source);
  if(!relative)return true;
  const first=relative.split(path.sep)[0];
  if(first.startsWith('.'))return false;
  if(['public','tests'].includes(first))return !relative.split(path.sep).some(part=>part.startsWith('.'));
  return relative==='package.json'||(!relative.includes(path.sep)&&relative.endsWith('.mjs'));
 }});
 let cfg={marketNow:Date.now(),...config},child,logs='';
 const write=async patch=>{cfg={...cfg,...patch};await fs.writeFile(control+'.tmp',JSON.stringify(cfg));await fs.rename(control+'.tmp',control)};
 await write({});
 await fs.mkdir(data,{recursive:true});
 // OPEN/CLOSE history is still recorded when delivery is disabled. Never launch
 // a real PowerShell notification on a Windows test runner.
 await fs.writeFile(path.join(data,'store.json'),JSON.stringify({paperNotify:{enabled:false,history:[]}}));
 const socket=net.createServer();socket.listen(0,'127.0.0.1');await once(socket,'listening');const port=socket.address().port;await new Promise(r=>socket.close(r));
 const base='http://127.0.0.1:'+port;
 const get=async endpoint=>{const response=await fetchLocal(base+endpoint);assert.equal(response.status,200,endpoint);return response.json()};
 async function start(){
  child=trackChild(spawn(process.execPath,['--import','./tests/mock_pipeline.mjs','server.mjs'],{cwd:app,env:{PATH:process.env.PATH,
   PORT:String(port),HOST:'127.0.0.1',SIGNAL_LAB_DATA_DIR:data,SIGNAL_LAB_TEST_CONTROL:control,SIGNAL_LAB_TEST_REQUESTS:requests,
   AUTO_UPDATE:'false',TELEGRAM_NEWS_ALERTS:'false',TELEGRAM_BOT_TOKEN:'',TELEGRAM_CHAT_ID:'',TWELVE_DATA_API_KEY:'',
   ...(process.env.SystemRoot?{SystemRoot:process.env.SystemRoot}:{})},stdio:['ignore','pipe','pipe']}));
  child.stdout.on('data',chunk=>{logs+=String(chunk)});child.stderr.on('data',chunk=>{logs+=String(chunk)});
  await until(()=>get('/api/status'),s=>s.activeCount===(cfg.binanceOffline?0:Object.keys(cfg.scenarios).filter(symbol=>!cfg.unlisted?.includes(symbol)).length),{label:'market discovery '+logs});
  if(cfg.emit)await until(()=>get('/api/status'),s=>s.ws==='connected');
 }
 async function stop(){
  if(child)await stopChild(child);
 }
 return {get,write,start,stop,data,requests,base,logs:()=>logs,async close(){await stop();await fs.rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:100})}};
}

test('synthetic markets: rising/falling breakouts, retests and a 90-point setup reach the final signal; weak/range markets do not',{timeout:30000},async()=>{
 const app=await sandbox({scenarios:{BTCUSDT:'breakout-long'},prices:{BTCUSDT:ENTRY},emit:true});
 try{
  await app.start();
  const matrix=[
   ['breakout-long','LONG',90,'박스권 상단 돌파'],
   ['breakout-short','SHORT',90,'박스권 하단 이탈'],
   ['retest-long','LONG',90,'돌파 후 지지 재확인'],
   ['retest-short','SHORT',90,'이탈 후 저항 재확인'],
   ['bonus-missing-long','LONG',90,'박스권 상단 돌파'],
   ['weak-volume',null,85],['illiquid-hour','LONG',90,'박스권 상단 돌파'],['range',null,null]
  ];
  for(const [scenario,direction,score,pattern] of matrix){
   await app.write({scenarios:{BTCUSDT:scenario},prices:{BTCUSDT:scenario==='range'?100:ENTRY}});
   await nap(90);
   const analyzed=await app.get('/api/analyze?symbol=BTCUSDT');
   assert.equal(analyzed.score,score,scenario+' technical score');
   if(direction){
    assert.equal(analyzed.pattern,pattern,scenario+' pattern');
    assert.equal(analyzed.technicalQualified,true,scenario+' technical gate');
    assert.equal(analyzed.execution.eligible,true,scenario+' venue gate '+JSON.stringify({execution:analyzed.execution,targetPlan:analyzed.targetPlan}));
   }
   const results=await app.get('/api/results');
   const funnel=await app.get('/api/scan/diagnostics');
   assert.equal(results.signals.length,direction?1:0,scenario+' final signal: '+JSON.stringify(analyzed));
   assert.equal(funnel.ready,results.signals.length,scenario+' diagnostics match the final list');
   assert.equal(funnel.patternCount,scenario==='range'?0:1,scenario+' pattern count');
   assert.equal(funnel.technicalPassed,direction?1:0,scenario+' technical pass count');
   assert.equal(funnel.venuePassed,direction?1:0,scenario+' venue pass count');
   if(direction)assert.equal(results.signals[0].direction,direction,scenario);
  }
  const requests=(await fs.readFile(app.requests,'utf8')).trim().split('\n').map(JSON.parse);
  assert.ok(requests.some(r=>r.interval==='1h'));assert.ok(requests.some(r=>r.interval==='4h'));
  assert.ok(requests.filter(r=>r.interval).every(r=>['1h','4h','1d'].includes(r.interval)),'no sub-hour candle requests');
  assert.ok(requests.every(r=>!r.path.includes('order')),'no exchange order endpoint');
 }finally{await app.close()}
});

test('synthetic end to end: LONG three profile targets with breakeven/restart, then SHORT stop and durable PNL/OPEN/CLOSE events',{timeout:30000},async()=>{
 const app=await sandbox({scenarios:{BTCUSDT:'breakout-long'},prices:{BTCUSDT:ENTRY},emit:true});
 try{
  await app.start();await app.get('/api/analyze?symbol=BTCUSDT');
  const results=await app.get('/api/results');assert.equal(results.signals.length,1);assert.equal(results.signals[0].direction,'LONG');
  let paper=await until(()=>app.get('/api/paper'),p=>p.openCount===1,{label:'fresh final LONG must open a profile-managed paper position'});
  const long=paper.open[0];assert.equal(long.direction,'LONG');assert.equal(long.managementVersion,'VOLUME_PROFILE_V1');
  assert.ok(long.entryFill>ENTRY,'long fill includes spread and slippage');assert.ok(long.feesUSD>0);
  assert.ok(long.targetPlan?.profileEvidence,'the entry preserves actual supplied aggTrade profile evidence');
  await app.write({prices:{BTCUSDT:long.targets[0]}});
  paper=await until(()=>app.get('/api/paper'),p=>p.open[0]?.exitedPct===40);
  const partial=paper.open[0];assert.equal(partial.closeParts.length,1);assert.equal(partial.closeParts[0].targetNumber,1);
  assert.ok(Math.abs(partial.qtyRemaining/partial.originalQty-.6)<1e-10);assert.equal(partial.stop,partial.entryFill);
  let notices=await app.get('/api/paper/notifications');assert.equal(notices.history.filter(e=>e.type==='OPEN').length,1);
  assert.equal(notices.history.filter(e=>e.type==='CLOSE').length,0,'partial targets do not send final CLOSE');
  await app.stop();await app.start();paper=await app.get('/api/paper');
  const restored=paper.open.find(p=>p.key===long.key);assert.equal(restored.exitedPct,40);assert.equal(restored.entryFill,long.entryFill);
  assert.equal(restored.qtyRemaining,partial.qtyRemaining);assert.equal(restored.realizedPnLUSD,partial.realizedPnLUSD);
  await app.write({prices:{BTCUSDT:long.targets[1]}});
  paper=await until(()=>app.get('/api/paper'),p=>p.open[0]?.exitedPct===75);
  assert.deepEqual(paper.open[0].closeParts.map(p=>p.targetNumber),[1,2]);
  await app.write({prices:{BTCUSDT:long.targets[2]}});
  paper=await until(()=>app.get('/api/paper'),p=>p.closed.some(x=>x.key===long.key));
  const closedLong=paper.closed.find(x=>x.key===long.key);assert.equal(closedLong.closeReason,'ALL_TARGETS');assert.equal(closedLong.qtyRemaining,0);
  assert.deepEqual(closedLong.closeParts.map(p=>p.targetNumber),[1,2,3]);assert.ok(closedLong.realizedPnLUSD>0);
  assert.ok(Math.abs(closedLong.realizedGrossUSD-closedLong.feesUSD-closedLong.realizedPnLUSD)<1e-7);
  // A separate market regime uses BTC's own down-trending 4H context. An ETH
  // short must not borrow a bullish BTC context merely to satisfy this test.
  await app.write({scenarios:{BTCUSDT:'breakout-short'},prices:{BTCUSDT:ENTRY}});await nap(90);
  const shortAnalysis=await app.get('/api/analyze?symbol=BTCUSDT');assert.equal(shortAnalysis.direction,'SHORT');assert.equal(shortAnalysis.qualified,true);
  paper=await until(()=>app.get('/api/paper'),p=>p.openCount===1);const short=paper.open[0];assert.equal(short.direction,'SHORT');assert.ok(short.entryFill<ENTRY);
  await app.write({prices:{BTCUSDT:short.initialStop+.5}});
  paper=await until(()=>app.get('/api/paper'),p=>p.closedCount===2&&p.openCount===0);
  const closedShort=paper.closed.find(x=>x.key===short.key);assert.equal(closedShort.closeReason,'STOP');assert.ok(closedShort.realizedPnLUSD<0);
  assert.equal(closedShort.closeParts[0].type,'STOP');assert.ok(closedShort.feesUSD>short.feesUSD);
  assert.ok(Math.abs(paper.netRealizedUSD-closedLong.realizedPnLUSD-closedShort.realizedPnLUSD)<1e-7);
  notices=await app.get('/api/paper/notifications');assert.equal(notices.history.filter(e=>e.type==='OPEN').length,2);assert.equal(notices.history.filter(e=>e.type==='CLOSE').length,2);
  for(const row of paper.closed)assert.equal(notices.history.find(e=>e.type==='CLOSE'&&e.key===row.key).realizedPnLUSD,row.realizedPnLUSD);
  const stored=JSON.parse(await fs.readFile(path.join(app.data,'store.json'),'utf8'));assert.equal(stored.paper.closed.length,2);assert.equal(stored.paper.open.length,0);
  const pnl=paper.netRealizedUSD,historyLength=notices.history.length;await app.stop();await app.start();paper=await app.get('/api/paper');notices=await app.get('/api/paper/notifications');
  assert.equal(paper.closedCount,2);assert.equal(paper.netRealizedUSD,pnl);assert.equal(notices.history.length,historyLength,'restart must not replay trade notifications');
 }finally{await app.close()}
});


test('synthetic Binance book rejection keeps a discovered 90-point pattern out of final signals and paper entries',{timeout:12000},async()=>{
 const app=await sandbox({scenarios:{BTCUSDT:'breakout-long'},prices:{BTCUSDT:ENTRY},emit:true,invalidQuote:true});
 try{
  await app.start();const analyzed=await app.get('/api/analyze?symbol=BTCUSDT');
  assert.equal(analyzed.patternConfirmed,true);assert.equal(analyzed.score,90);assert.equal(analyzed.technicalQualified,true);
  assert.equal(analyzed.execution.eligible,false);
  const results=await app.get('/api/results'),funnel=await app.get('/api/scan/diagnostics'),paper=await app.get('/api/paper');
  assert.equal(funnel.patternCount,1);assert.equal(funnel.technicalPassed,1);assert.equal(funnel.venuePassed,0);assert.equal(funnel.ready,0);
  assert.equal(results.signals.length,0);assert.equal(paper.pendingCount,0);assert.equal(paper.openCount,0);
 }finally{await app.close()}
});

test('a valid 90-point setup without three supplied volume-profile targets stays out of final signals and paper entries',{timeout:12000},async()=>{
 const app=await sandbox({scenarios:{BTCUSDT:'breakout-long'},prices:{BTCUSDT:ENTRY},emit:true,profileUnavailable:true});
 try{
  await app.start();const analyzed=await app.get('/api/analyze?symbol=BTCUSDT');
  assert.equal(analyzed.score,90);assert.equal(analyzed.technicalQualified,true);
  assert.equal(analyzed.targetPlan.ok,false);assert.equal(analyzed.targetPlan.code,'TP_PROFILE_UNAVAILABLE');
  assert.deepEqual(analyzed.targetPlan.targets,[],'no automatic R-multiple target replacement');
  assert.equal(analyzed.qualified,false);
  const results=await app.get('/api/results'),paper=await app.get('/api/paper');
  assert.deepEqual(results.signals,[]);assert.deepEqual(results.patterns,[]);assert.deepEqual(results.watch,[]);
  assert.equal(paper.pendingCount,0);assert.equal(paper.openCount,0);
 }finally{await app.close()}
});

test('an existing data-directory score setting raises the final gate while disclosing unverified performance',{timeout:15000},async()=>{
 const app=await sandbox({scenarios:{BTCUSDT:'breakout-long'},prices:{BTCUSDT:ENTRY},emit:true});
 const envContent='SIGNAL_FINAL_MIN_SCORE=95\n';
 await fs.writeFile(path.join(app.data,'.env'),envContent);
 try{
  await app.start();
  const status=await app.get('/api/status');
  assert.equal(status.scorePolicy.finalMinScore,95);assert.equal(status.scorePolicy.source,'CONFIGURED');
  assert.equal(status.scorePolicy.performanceValidation,'UNVERIFIED');assert.equal(status.scorePolicy.liveApproval,false);
  const row=await app.get('/api/analyze?symbol=BTCUSDT');
  assert.equal(row.score,90);assert.equal(row.scorePolicy.finalMinScore,95);assert.equal(row.qualified,false);
  assert.equal(row.quality.thresholdPassed,false);assert.equal(row.quality.validationPassed,true);
  const results=await app.get('/api/results');assert.deepEqual(results.signals,[]);assert.equal(results.scorePolicy.finalMinScore,95);
  const paper=await app.get('/api/paper');assert.equal(paper.pendingCount,0);assert.equal(paper.openCount,0);
  await app.stop();assert.equal(await fs.readFile(path.join(app.data,'.env'),'utf8'),envContent);
 }finally{await app.close()}
});

test('Binance public discovery outage blocks new entries and recovers without another provider intersection',{timeout:15000},async()=>{
 const app=await sandbox({scenarios:{BTCUSDT:'breakout-long'},prices:{BTCUSDT:ENTRY},emit:false,binanceOffline:true});
 try{
  await app.start();await until(()=>app.get('/api/status'),s=>s.rest==='offline'&&!s.scanning);
  assert.equal((await app.get('/api/status')).activeCount,0);
  assert.deepEqual((await app.get('/api/results')).signals,[]);assert.equal((await app.get('/api/paper')).pendingCount,0);
  await app.write({binanceOffline:false,emit:true});
  const scan=await fetchLocal(app.base+'/api/scan',{method:'POST'});assert.equal(scan.status,202);await scan.arrayBuffer();
  await until(()=>app.get('/api/status'),s=>s.activeCount===1&&s.rest==='connected'&&!s.scanning);
  const analyzed=await app.get('/api/analyze?symbol=BTCUSDT');assert.equal(analyzed.qualified,true);
  assert.equal(analyzed.decision.analysisVenue,'BINANCE');assert.equal(analyzed.decision.tradeApproval,false);
  assert.equal((await app.get('/api/results')).signals.length,1,'no secondary exchange exists to gate Binance evidence');
 }finally{await app.close()}
});

test('restored open positions remain price-monitored outside both the verified list and the top-45 research list',{timeout:12000},async()=>{
 const symbols=['BTCUSDT',...Array.from({length:45},(_,i)=>'HIGH'+i+'USDT'),'LOWUSDT'];
 const scenarios=Object.fromEntries(symbols.map(symbol=>[symbol,'breakout-long']));
 const prices=Object.fromEntries(symbols.map(symbol=>[symbol,95]));
 const app=await sandbox({scenarios,prices,emit:true,unlisted:symbols.filter(symbol=>symbol!=='BTCUSDT')});
 try{
  let at=Date.now()-10000;
  const seed=new PaperEngine({}, {now:()=>at});
  for(const symbol of ['BTCUSDT','LOWUSDT']){
   assert.equal(seed.register({managementVersion:'LEGACY_R_MULTIPLES',symbol,direction:'LONG',pattern:'restored-open-fixture',entry:100,stop:98,patternConfirmedAt:at-60000},{quoteEligible:true}),true);
   at+=1000;seed.onPrice('CRYPTO',symbol,100,at);
  }
  assert.equal(seed.store.open.length,2);
  await fs.mkdir(app.data,{recursive:true});
  await fs.writeFile(path.join(app.data,'store.json'),JSON.stringify({paper:seed.store,watchlist:[],journal:[],alerts:[],seen:{},newsSeen:{},paperNotify:{enabled:false,history:[]}}));
  await app.start();
  const market=await app.get('/api/market');assert.deepEqual(market.markets.map(row=>row.symbol),['BTCUSDT']);
  const paper=await until(()=>app.get('/api/paper'),p=>p.closedCount===2&&p.openCount===0,{label:'both restored positions must stop despite LOW being excluded from discovery'});
  assert.deepEqual(new Set(paper.closed.map(row=>row.symbol)),new Set(['BTCUSDT','LOWUSDT']));
  assert.ok(paper.closed.every(row=>row.closeReason==='STOP'&&row.realizedPnLUSD<0));
  assert.ok(paper.closed.every(row=>row.closeParts.at(-1).reference===95));
 }finally{await app.close()}
});

test('pending entries recheck the current venue quote before the first simulated fill',{timeout:12000},async()=>{
 const app=await sandbox({scenarios:{BTCUSDT:'breakout-long'},prices:{BTCUSDT:ENTRY},emit:true,pauseWhenPending:true,restPriceFresh:false});
 try{
  await app.start();
  await app.get('/api/analyze?symbol=BTCUSDT');
  const before=await until(()=>app.get('/api/paper'),p=>p.pendingCount===1&&p.openCount===0);
  const registeredAt=before.pending[0].signalAt;
  await app.write({clockOffsetMs:181000,pauseWhenPending:false});
  await until(()=>app.get('/api/status'),s=>s.lastTickerAt>=registeredAt+181000,{label:'a fresh post-expiry tick must be processed'});
  const paper=await app.get('/api/paper'),results=await app.get('/api/results'),funnel=await app.get('/api/scan/diagnostics');
  assert.equal(paper.pendingCount,1,'the still-valid pending signal waits for renewed venue approval');
  assert.equal(paper.openCount,0,'a new tick alone cannot turn a stale venue quote into a fill');
  assert.equal(results.signals.length,0);assert.equal(funnel.technicalPassed,1);assert.equal(funnel.venuePassed,0);
  assert.ok(results.recent[0].execution.reasons.some(reason=>/STALE|만료/.test(reason)));
  assert.equal((await app.get('/api/paper/notifications')).history.length,0,'no OPEN event for a rejected fill');
 }finally{await app.close()}
});

test('the first fresh ticker promotes an already analyzed setup and opens it without another scan',{timeout:12000},async()=>{
 const app=await sandbox({scenarios:{BTCUSDT:'breakout-long'},prices:{BTCUSDT:ENTRY},emit:false,restPriceFresh:false});
 try{
  await app.start();
  const analyzed=await app.get('/api/analyze?symbol=BTCUSDT');
  assert.equal(analyzed.patternConfirmed,true);assert.equal(analyzed.technicalQualified,true);
  assert.equal(analyzed.qualified,false,'before a Binance tick the setup is not actionable');
  const before=await app.get('/api/paper');assert.equal(before.pendingCount,0);assert.equal(before.openCount,0);
  await app.write({emit:true});
  // No manual analyze, candle-close trigger, or periodic scan is requested here.
  const paper=await until(()=>app.get('/api/paper'),p=>p.openCount===1,{label:'a newly fresh analyzed setup must reach its first forward-only fill'});
  const signals=await app.get('/api/results'),funnel=await app.get('/api/scan/diagnostics');
  assert.equal(signals.signals.length,1);assert.equal(funnel.ready,1);
  assert.equal(signals.alerts.length,1,'the promoted setup publishes exactly one signal alert');
  assert.equal(paper.open[0].direction,'LONG');assert.ok(paper.open[0].openedAt>paper.open[0].signalAt,'registration and fill require separate observations');
  const notices=await app.get('/api/paper/notifications');
  assert.equal(notices.history.filter(row=>row.type==='OPEN').length,1);
  await nap(180);
  assert.equal((await app.get('/api/paper')).openCount,1);
  assert.equal((await app.get('/api/paper/notifications')).history.filter(row=>row.type==='OPEN').length,1,'later ticks must not replay OPEN');
  assert.equal((await app.get('/api/results')).alerts.length,1,'later ticks must not replay the signal alert');
 }finally{await app.close()}
});
