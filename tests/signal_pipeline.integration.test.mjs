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
 let cfg=config,child,logs='';
 const write=async patch=>{cfg={...cfg,...patch};await fs.writeFile(control+'.tmp',JSON.stringify(cfg));await fs.rename(control+'.tmp',control)};
 await write({});
 const socket=net.createServer();socket.listen(0,'127.0.0.1');await once(socket,'listening');const port=socket.address().port;await new Promise(r=>socket.close(r));
 const base='http://127.0.0.1:'+port;
 const get=async endpoint=>{const response=await fetch(base+endpoint);assert.equal(response.status,200,endpoint);return response.json()};
 async function start(){
  child=spawn(process.execPath,['--import','./tests/mock_pipeline.mjs','server.mjs'],{cwd:app,env:{PATH:process.env.PATH,
   PORT:String(port),HOST:'127.0.0.1',SIGNAL_LAB_DATA_DIR:data,SIGNAL_LAB_TEST_CONTROL:control,SIGNAL_LAB_TEST_REQUESTS:requests,
   AUTO_UPDATE:'false',TELEGRAM_NEWS_ALERTS:'false',TELEGRAM_BOT_TOKEN:'',TELEGRAM_CHAT_ID:'',TWELVE_DATA_API_KEY:''},stdio:['ignore','pipe','pipe']});
  child.stdout.on('data',chunk=>{logs+=String(chunk)});child.stderr.on('data',chunk=>{logs+=String(chunk)});
  await until(()=>get('/api/status'),s=>s.activeCount===Object.keys(cfg.scenarios).filter(symbol=>!cfg.unlisted?.includes(symbol)).length,{label:'market discovery '+logs});
  if(cfg.emit)await until(()=>get('/api/status'),s=>s.ws==='connected');
 }
 async function stop(){if(!child||child.exitCode!==null)return;const exited=once(child,'exit');child.kill('SIGTERM');await Promise.race([exited,nap(2500)]);if(child.exitCode===null){child.kill('SIGKILL');await exited}}
 return {get,write,start,stop,data,requests,base,logs:()=>logs,async close(){await stop();await fs.rm(root,{recursive:true,force:true})}};
}

test('synthetic markets: rising/falling breakouts, retests and a 90-point setup reach the final signal; weak/range markets do not',{timeout:30000},async()=>{
 const app=await sandbox({scenarios:{BTCUSDT:'breakout-long'},prices:{BTCUSDT:ENTRY},emit:true});
 try{
  await app.start();
  const matrix=[
   ['breakout-long','LONG',100,'박스권 상단 돌파'],
   ['breakout-short','SHORT',100,'박스권 하단 이탈'],
   ['retest-long','LONG',100,'돌파 후 지지 재확인'],
   ['retest-short','SHORT',100,'이탈 후 저항 재확인'],
   ['bonus-missing-long','LONG',90,'박스권 상단 돌파'],
   ['weak-volume',null,85],['illiquid-hour',null,95],['range',null,undefined]
  ];
  for(const [scenario,direction,score,pattern] of matrix){
   await app.write({scenarios:{BTCUSDT:scenario},prices:{BTCUSDT:scenario==='range'?100:ENTRY}});
   await nap(90);
   const analyzed=await app.get('/api/analyze?symbol=BTCUSDT');
   assert.equal(analyzed.score,score,scenario+' technical score');
   if(direction){
    assert.equal(analyzed.pattern,pattern,scenario+' pattern');
    assert.equal(analyzed.technicalQualified,true,scenario+' technical gate');
    assert.equal(analyzed.execution.eligible,true,scenario+' venue gate');
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

test('synthetic end to end: LONG three targets, restart continuation, SHORT stop and durable PNL/OPEN/CLOSE events',{timeout:30000},async()=>{
 const app=await sandbox({scenarios:{BTCUSDT:'breakout-long',ETHUSDT:'breakout-short'},prices:{BTCUSDT:ENTRY,ETHUSDT:ENTRY},emit:true});
 try{
  await app.start();
  await app.get('/api/analyze?symbol=BTCUSDT');await app.get('/api/analyze?symbol=ETHUSDT');
  const results=await app.get('/api/results');assert.equal(results.signals.length,2);
  assert.deepEqual(new Set(results.signals.map(s=>s.direction)),new Set(['LONG','SHORT']));
  let paper=await until(()=>app.get('/api/paper'),p=>p.openCount===2,{label:'fresh final signals must open both paper positions'});
  const long=paper.open.find(p=>p.symbol==='BTCUSDT'),short=paper.open.find(p=>p.symbol==='ETHUSDT');
  assert.equal(long.direction,'LONG');assert.equal(short.direction,'SHORT');
  assert.ok(long.entryFill>ENTRY,'long fill includes spread and slippage');assert.ok(short.entryFill<ENTRY,'short fill includes spread and slippage');
  assert.ok(long.feesUSD>0);assert.ok(short.feesUSD>0);
  await app.write({prices:{BTCUSDT:long.targets[0],ETHUSDT:ENTRY}});
  paper=await until(()=>app.get('/api/paper'),p=>p.open.find(x=>x.symbol==='BTCUSDT')?.exitedPct===40);
  const partial=paper.open.find(p=>p.symbol==='BTCUSDT');
  assert.equal(partial.closeParts.length,1);assert.equal(partial.closeParts[0].targetNumber,1);
  assert.ok(Math.abs(partial.qtyRemaining/partial.originalQty-.6)<1e-10);
  assert.equal(partial.stop,partial.entryFill);assert.ok(partial.feesUSD>long.feesUSD);
  let notices=await app.get('/api/paper/notifications');
  assert.equal(notices.history.filter(e=>e.type==='OPEN').length,2);
  assert.equal(notices.history.filter(e=>e.type==='CLOSE').length,0,'partial targets do not send final CLOSE');
  await app.stop();await app.start();
  paper=await app.get('/api/paper');
  const restored=paper.open.find(p=>p.key===long.key);
  assert.equal(restored.exitedPct,40);assert.equal(restored.entryFill,long.entryFill);assert.equal(restored.qtyRemaining,partial.qtyRemaining);
  assert.equal(restored.realizedPnLUSD,partial.realizedPnLUSD,'partial PNL survives restart');
  await app.write({prices:{BTCUSDT:long.targets[1],ETHUSDT:ENTRY}});
  paper=await until(()=>app.get('/api/paper'),p=>p.open.find(x=>x.symbol==='BTCUSDT')?.exitedPct===75);
  assert.deepEqual(paper.open.find(x=>x.symbol==='BTCUSDT').closeParts.map(p=>p.targetNumber),[1,2]);
  notices=await app.get('/api/paper/notifications');assert.equal(notices.history.filter(e=>e.type==='CLOSE').length,0);
  await app.write({prices:{BTCUSDT:long.targets[2],ETHUSDT:ENTRY}});
  paper=await until(()=>app.get('/api/paper'),p=>p.closed.some(x=>x.key===long.key));
  const closedLong=paper.closed.find(x=>x.key===long.key);
  assert.equal(closedLong.closeReason,'ALL_TARGETS');assert.equal(closedLong.qtyRemaining,0);
  assert.deepEqual(closedLong.closeParts.map(p=>p.targetNumber),[1,2,3]);
  assert.ok(closedLong.realizedPnLUSD>0);assert.ok(Math.abs(closedLong.realizedGrossUSD-closedLong.feesUSD-closedLong.realizedPnLUSD)<1e-7);
  await app.write({prices:{BTCUSDT:long.targets[2],ETHUSDT:short.initialStop+.5}});
  paper=await until(()=>app.get('/api/paper'),p=>p.closedCount===2&&p.openCount===0);
  const closedShort=paper.closed.find(x=>x.key===short.key);
  assert.equal(closedShort.closeReason,'STOP');assert.ok(closedShort.realizedPnLUSD<0);
  assert.equal(closedShort.closeParts[0].type,'STOP');assert.ok(closedShort.feesUSD>short.feesUSD);
  assert.ok(Math.abs(paper.netRealizedUSD-closedLong.realizedPnLUSD-closedShort.realizedPnLUSD)<1e-7);
  notices=await app.get('/api/paper/notifications');
  assert.equal(notices.history.filter(e=>e.type==='OPEN').length,2);assert.equal(notices.history.filter(e=>e.type==='CLOSE').length,2);
  for(const row of paper.closed){assert.equal(notices.history.find(e=>e.type==='CLOSE'&&e.key===row.key).realizedPnLUSD,row.realizedPnLUSD)}
  const stored=JSON.parse(await fs.readFile(path.join(app.data,'store.json'),'utf8'));
  assert.equal(stored.paper.closed.length,2);assert.equal(stored.paper.open.length,0);
  const pnl=paper.netRealizedUSD,historyLength=notices.history.length;
  await app.stop();await app.start();
  paper=await app.get('/api/paper');notices=await app.get('/api/paper/notifications');
  assert.equal(paper.closedCount,2);assert.equal(paper.netRealizedUSD,pnl);assert.equal(notices.history.length,historyLength,'restart must not replay trade notifications');
 }finally{await app.close()}
});


test('synthetic venue rejection keeps a discovered 100-point pattern out of final signals and paper entries',{timeout:12000},async()=>{
 const app=await sandbox({scenarios:{BTCUSDT:'breakout-long'},prices:{BTCUSDT:ENTRY},emit:true,invalidQuote:true});
 try{
  await app.start();const analyzed=await app.get('/api/analyze?symbol=BTCUSDT');
  assert.equal(analyzed.patternConfirmed,true);assert.equal(analyzed.score,100);assert.equal(analyzed.technicalQualified,true);
  assert.equal(analyzed.execution.eligible,false);
  const results=await app.get('/api/results'),funnel=await app.get('/api/scan/diagnostics'),paper=await app.get('/api/paper');
  assert.equal(funnel.patternCount,1);assert.equal(funnel.technicalPassed,1);assert.equal(funnel.venuePassed,0);assert.equal(funnel.ready,0);
  assert.equal(results.signals.length,0);assert.equal(paper.pendingCount,0);assert.equal(paper.openCount,0);
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
   assert.equal(seed.register({symbol,direction:'LONG',pattern:'restored-open-fixture',entry:100,stop:98,patternConfirmedAt:at-60000},{quoteEligible:true}),true);
   at+=1000;seed.onPrice('CRYPTO',symbol,100,at);
  }
  assert.equal(seed.store.open.length,2);
  await fs.mkdir(app.data,{recursive:true});
  await fs.writeFile(path.join(app.data,'store.json'),JSON.stringify({paper:seed.store,watchlist:[],journal:[],alerts:[],seen:{},newsSeen:{}}));
  await app.start();
  const market=await app.get('/api/market');assert.deepEqual(market.markets.map(row=>row.symbol),['BTCUSDT']);
  const paper=await until(()=>app.get('/api/paper'),p=>p.closedCount===2&&p.openCount===0,{label:'both restored positions must stop despite LOW being excluded from discovery'});
  assert.deepEqual(new Set(paper.closed.map(row=>row.symbol)),new Set(['BTCUSDT','LOWUSDT']));
  assert.ok(paper.closed.every(row=>row.closeReason==='STOP'&&row.realizedPnLUSD<0));
  assert.ok(paper.closed.every(row=>row.closeParts.at(-1).reference===95));
 }finally{await app.close()}
});
