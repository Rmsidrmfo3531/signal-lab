import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';
import {PaperEngine} from '../paper.mjs';
import {runOrangeXPaperScenario} from '../scripts/orangex-paper-offline.mjs';
import {paperScenario} from './fixtures/orangex_paper_scenario.mjs';

const project=fileURLToPath(new URL('../',import.meta.url));
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));

async function sandbox(configuration={}){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'signal-orangex-readonly-'));
 const app=path.join(root,'app'),records=path.join(root,'records'),requests=path.join(root,'orangex-requests.jsonl');
 let child,closed,didClose=false;
 try{
  // Explicit source selection excludes the parent checkout's .env, .git,
  // user records, updater staging, and pre-existing backups.
  await fs.mkdir(path.join(app,'tests'),{recursive:true});await fs.mkdir(records);
  for(const name of await fs.readdir(project))if(name==='package.json'||name.endsWith('.mjs'))
   await fs.copyFile(path.join(project,name),path.join(app,name));
  await fs.cp(path.join(project,'public'),path.join(app,'public'),{recursive:true});
  for(const name of ['mock_network.mjs','mock_runtime.mjs','mock_orangex_readonly.mjs'])
   await fs.copyFile(path.join(project,'tests',name),path.join(app,'tests',name));

  let now=Date.now()-10000;
  const paper=new PaperEngine({}, {now:()=>now});
  assert.equal(paper.register({symbol:'LEGACYUSDT',direction:'LONG',pattern:'existing fixture position',entry:100,stop:98,
   patternConfirmedAt:now-1000},{quoteEligible:true}),true);
  now+=1000;paper.onPrice('CRYPTO','LEGACYUSDT',100,now);
  assert.equal(paper.store.open.length,1);
  paper.store.closed.push({key:'existing-pnl-must-survive',market:'CRYPTO',symbol:'OLDUSDT',direction:'LONG',
   realizedPnLUSD:12.5,feesUSD:.5,closedAt:now-86400000,closeParts:[]});
  const fixture={paper:structuredClone(paper.store),watchlist:['BTCUSDT'],journal:[],alerts:[],seen:{},newsSeen:{},
   paperNotify:{enabled:false,history:[{id:'existing-notification',type:'CLOSE',realizedPnLUSD:12.5}]}};
  const original=JSON.stringify(fixture);
  await fs.writeFile(path.join(records,'store.json'),original);
  await fs.mkdir(path.join(records,'backups'));
  const retainedBackup=path.join(records,'backups','store-retained-fixture.json');
  await fs.writeFile(retainedBackup,original);

  const socket=net.createServer();socket.listen(0,'127.0.0.1');await once(socket,'listening');
  const port=socket.address().port;await new Promise(resolve=>socket.close(resolve));
  const env={PATH:process.env.PATH,HOST:'127.0.0.1',PORT:String(port),SIGNAL_LAB_DATA_DIR:records,
   AUTO_UPDATE:'false',UPDATE_MANIFEST_URL:'',SIGNAL_LAB_OPEN_BROWSER:'0',TELEGRAM_NEWS_ALERTS:'false',
   TELEGRAM_BOT_TOKEN:'',TELEGRAM_CHAT_ID:'',TWELVE_DATA_API_KEY:'',SIGNAL_LAB_TEST_ORANGEX_REQUESTS:requests,...configuration};
  if(process.env.SystemRoot)env.SystemRoot=process.env.SystemRoot;
  child=spawn(process.execPath,['--import','./tests/mock_orangex_readonly.mjs','server.mjs'],{cwd:app,env,stdio:'ignore'});
  closed=new Promise(resolve=>child.once('close',()=>{didClose=true;resolve()}));
  child.once('error',()=>{});
  const base='http://127.0.0.1:'+port;
  for(let attempt=0;attempt<100;attempt++){
   try{if((await fetch(base+'/api/status')).ok)break}catch{}
   if(didClose)assert.fail('isolated existing server exited during OrangeX initialization');
   await pause(50);
  }
  const disk=async()=>JSON.parse(await fs.readFile(path.join(records,'store.json'),'utf8'));
  const read=async route=>{const response=await fetch(base+route);assert.equal(response.status,200,route);return {response,text:await response.text()}};
  async function close(){
   if(child&&!didClose){
    child.kill('SIGTERM');let timer;
    try{await Promise.race([closed,new Promise(resolve=>{timer=setTimeout(resolve,2500)})])}finally{clearTimeout(timer)}
    if(!didClose){child.kill('SIGKILL');await closed}
   }
   await fs.rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:100});
  }
  return {base,fixture,disk,read,requests,retainedBackup,original,close};
 }catch(error){
  if(child&&!didClose){child.kill('SIGKILL');await closed}
  await fs.rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:100});
  throw error;
 }
}

const noExternalRequests=async file=>{
 let content='';try{content=await fs.readFile(file,'utf8')}catch(error){if(error.code!=='ENOENT')throw error}
 assert.equal(content,'','disabled or unsupported modes must not contact an OrangeX endpoint');
};

test('separate offline PAPER records reach the dashboard through GET only without altering legacy positions or PNL',{timeout:15000},async()=>{
 const app=await sandbox(),records=path.dirname(path.dirname(app.retainedBackup)),directory=path.join(records,'orangex-paper');
 try{
  const empty=JSON.parse((await app.read('/api/orangex/paper')).text);
  assert.equal(empty.recordStatus,'UNCONFIGURED');assert.equal(empty.realDataAutoEntryEnabled,false);
  await assert.rejects(fs.stat(directory),error=>error.code==='ENOENT','reading the default view creates no PAPER directory');
  const result=runOrangeXPaperScenario(paperScenario(),{directory});
  const snapshot=JSON.parse((await app.read('/api/orangex/paper')).text);
  assert.equal(snapshot.closed.length,2);assert.equal(snapshot.summary.realizedPnLUSD,result.snapshot.summary.realizedPnLUSD);
  assert.equal(snapshot.closed[0].direction,'LONG');assert.equal(snapshot.closed[1].direction,'SHORT');
  assert.equal(snapshot.storage.readOnly,true);assert.equal(snapshot.storage.healthy,true);
  assert.equal(snapshot.realDataAutoEntryEnabled,false);assert.equal(snapshot.liveOrdersEnabled,false);
  for(const method of ['POST','PUT','PATCH','DELETE'])assert.equal((await fetch(app.base+'/api/orangex/paper',{method})).status,405);
  assert.equal((await fetch(app.base+'/api/orangex/paper/orders')).status,404);
  const module=(await app.read('/orangex_paper.js')).text;assert.match(module,/renderOrangeXPaper/);
  assert.deepEqual((await app.disk()).paper,app.fixture.paper);assert.deepEqual((await app.disk()).paperNotify,app.fixture.paperNotify);
  assert.equal(await fs.readFile(app.retainedBackup,'utf8'),app.original);
  const file=path.join(directory,'orangex-paper.json');await fs.writeFile(file,'damaged OrangeX test record');
  const unavailable=JSON.parse((await app.read('/api/orangex/paper')).text);
  assert.equal(unavailable.recordsUnavailable,true);assert.equal(unavailable.summary,null);
  assert.equal((await fetch(app.base+'/api/status')).status,200,'a new PANEL record problem must not stop the legacy server');
  assert.equal(await fs.readFile(file,'utf8'),'damaged OrangeX test record');
  assert.deepEqual((await app.disk()).paper,app.fixture.paper);await noExternalRequests(app.requests);
 }finally{await app.close()}
});

test('OrangeX default HTTP view is read-only, has unknown account data, and preserves existing PNL, positions and settings',{timeout:15000},async()=>{
 const app=await sandbox();
 try{
  for(const route of ['/api/orangex','/api/orangex?refresh=1','/api/orangex?mode=LIVE']){
   const {text}=await app.read(route),snapshot=JSON.parse(text);
   assert.equal(snapshot.mode,'READ_ONLY');assert.equal(snapshot.enabled,false);
   assert.equal(snapshot.orderSubmissionEnabled,false);assert.equal(snapshot.capabilities.accountRead,false);
   assert.equal(snapshot.account,null,'an unread account must not be fabricated as a zero balance or empty position list');
  }
  for(const method of ['POST','PUT','PATCH','DELETE'])for(const route of ['/api/orangex','/api/orangex/orders','/api/orangex/mode']){
   const result=await fetch(app.base+route,{method,headers:{'Content-Type':'application/json'},body:JSON.stringify({mode:'LIVE',side:'BUY',amount:1})});
   assert.equal(result.status,405,method+' '+route+' must not accept a trading or mode-change command');
  }
  const html=(await app.read('/')).text;
  for(const id of ['scanner','paper','tradfi','news','orangex'])assert.match(html,new RegExp('id="'+id+'"'));
  for(const asset of ['/app.js','/paper_ui.js','/directional_entries.js','/orangex.js'])await app.read(asset);
  const after=await app.disk();
  assert.deepEqual(after.paper,app.fixture.paper,'OrangeX reads must preserve legacy open positions and recorded PNL');
  assert.deepEqual(after.paperNotify,app.fixture.paperNotify);
  assert.deepEqual(after.watchlist,app.fixture.watchlist);
  assert.equal(await fs.readFile(app.retainedBackup,'utf8'),app.original,'the existing backup remains intact');
  await noExternalRequests(app.requests);
 }finally{await app.close()}
});

test('OrangeX PAPER/LIVE/invalid configuration cannot enable automation or expose server credentials',{timeout:20000},async()=>{
 for(const mode of ['PAPER','LIVE','UNRECOGNIZED']){
  const clientId='test-only-client-id',secret='test-only-client-secret',token='test-only-access-token';
  const app=await sandbox({ORANGEX_ENABLED:'true',ORANGEX_MODE:mode,ORANGEX_CLIENT_ID:clientId,ORANGEX_CLIENT_SECRET:secret,ORANGEX_ACCESS_TOKEN:token});
  try{
   const {text}=await app.read('/api/orangex?refresh=1'),snapshot=JSON.parse(text);
   assert.equal(snapshot.mode,'READ_ONLY');assert.equal(snapshot.orderSubmissionEnabled,false);
   assert.equal(snapshot.capabilities.accountRead,false);assert.equal(snapshot.account,null);
   const html=(await app.read('/')).text;
   for(const value of [clientId,secret,token]){
    assert.equal(text.includes(value),false,'an OrangeX response must not contain credentials');
    assert.equal(html.includes(value),false,'the browser document must not contain credentials');
   }
   assert.deepEqual((await app.disk()).paper,app.fixture.paper);
   await noExternalRequests(app.requests);
  }finally{await app.close()}
 }
});

test('obsolete PAPER opt-in variables cannot activate a simulation or create a new account store',{timeout:15000},async()=>{
 const app=await sandbox({ORANGEX_MODE:'READ_ONLY',ORANGEX_PAPER_ENABLED:'true',ORANGEX_PAPER_FEE_BPS:'5',ORANGEX_PAPER_FUNDING_BPS_PER_8H:'0'});
 try{
  const snapshot=JSON.parse((await app.read('/api/orangex')).text);
  assert.equal(snapshot.mode,'READ_ONLY');assert.equal(snapshot.automation.enabled,false);assert.equal(snapshot.orderSubmissionEnabled,false);
  assert.equal(Object.hasOwn(snapshot,'paper'),false);
  const records=path.dirname(path.dirname(app.retainedBackup));
  await assert.rejects(fs.stat(path.join(records,'orangex-paper')),error=>error.code==='ENOENT');
  assert.deepEqual((await app.disk()).paper,app.fixture.paper);await noExternalRequests(app.requests);
 }finally{await app.close()}
});

test('OrangeX public-market HTTP reads stay separate from scanner, account credentials and stored trading history',{timeout:15000},async()=>{
 const clientId='fixture-account-client',secret='fixture-account-secret';
 const app=await sandbox({ORANGEX_ENABLED:'true',ORANGEX_MODE:'READ_ONLY',ORANGEX_CLIENT_ID:clientId,
  ORANGEX_CLIENT_SECRET:secret,SIGNAL_LAB_TEST_ORANGEX_BOOK:'fresh'});
 try{
  const before=JSON.parse((await app.read('/api/status')).text);
  const {text}=await app.read('/api/orangex?refresh=1'),snapshot=JSON.parse(text);
  assert.equal(snapshot.mode,'READ_ONLY');assert.equal(snapshot.enabled,true);assert.equal(snapshot.connected,true);
  assert.equal(snapshot.orderSubmissionEnabled,false);assert.equal(snapshot.automation.enabled,false);
  assert.equal(snapshot.capabilities.accountRead,false);assert.equal(snapshot.account,null);
  assert.deepEqual(snapshot.listingCurrencies,['BTC','ETH','SPOT']);
  assert.equal(snapshot.marketReadiness.publicDataReady,true);assert.equal(snapshot.marketReadiness.ready,false);
  assert.equal(snapshot.marketReadiness.paperReady,false);assert.equal(snapshot.marketReadiness.tradingReady,false);
  assert.equal(snapshot.verification.officialSpec,'UNVERIFIED','a mocked SDK-shaped response is not official specification verification');
  assert.equal(snapshot.markets.length,3);
  const expected=new Map([['BTCUSDT',81000],['ETHUSDT',2500],['SOLUSDT',180]]);
  for(const market of snapshot.markets){
   const mid=expected.get(market.symbol);assert.ok(mid);
   assert.equal(market.bid,mid-.01);assert.equal(market.ask,mid+.01);
   assert.equal(market.fresh,true);assert.equal(market.tradable,false);assert.equal(market.instrumentVerified,false);
   assert.equal(market.minQty,null);assert.equal(market.qtyStep,null);assert.equal(market.priceTick,null);
   assert.equal(market.listingObserved,true);assert.equal(market.active,true);assert.equal(market.markPrice,mid);assert.equal(market.markPriceFresh,true);
   assert.equal(market.contractFields.min_trade_amount.value,1);assert.equal(market.contractFields.min_qty.value,.001);
   assert.equal(market.contractFields.qty_step.value,.001);assert.equal(market.fees.units,'UNVERIFIED');
   assert.equal(market.binanceComparison.mappingVerified,false);
  }
  assert.equal(text.includes(clientId),false);assert.equal(text.includes(secret),false);
  const outgoing=(await fs.readFile(app.requests,'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(outgoing.length,9,'three documented-area queries, three individual tickers and three books');
  assert.equal(outgoing.filter(x=>x.path==='/api/v1/public/get_instruments').length,3);
  assert.deepEqual(outgoing.filter(x=>x.path==='/api/v1/public/get_instruments').map(x=>x.currency),['BTC','ETH','SPOT']);
  assert.equal(outgoing.filter(x=>x.path==='/api/v1/public/tickers').length,3);
  assert.equal(outgoing.filter(x=>x.path==='/api/v1/public/get_order_book').length,3);
  for(const request of outgoing){
   assert.equal(request.host,'api.orangex.com');assert.equal(request.method,'GET');
   if(request.path==='/api/v1/public/get_order_book')assert.equal(request.depth,'20');
   else if(request.path==='/api/v1/public/get_instruments')assert.ok(['BTC','ETH','SPOT'].includes(request.currency));
   else {assert.equal(request.path,'/api/v1/public/tickers');assert.ok(request.instrumentName)}
   assert.equal(request.hasAuthorization,false,'public market reads must not send account credentials');
  }
  const after=JSON.parse((await app.read('/api/status')).text);
  for(const field of ['activeCount','binancePerps','variationalPerps','scanMode'])assert.equal(after[field],before[field]);
  assert.deepEqual((await app.disk()).paper,app.fixture.paper);
  assert.deepEqual((await app.disk()).paperNotify,app.fixture.paperNotify);
  assert.equal(await fs.readFile(app.retainedBackup,'utf8'),app.original);
 }finally{await app.close()}
});

test('OrangeX missing or old public timestamps never become fresh, verified tradable quotes',{timeout:15000},async()=>{
 for(const mode of ['missing-time','old-time']){
  const app=await sandbox({ORANGEX_ENABLED:'true',ORANGEX_MODE:'READ_ONLY',SIGNAL_LAB_TEST_ORANGEX_BOOK:mode});
  try{
   const snapshot=JSON.parse((await app.read('/api/orangex?refresh=1')).text);
   assert.equal(snapshot.orderSubmissionEnabled,false);assert.equal(snapshot.account,null);
   assert.equal(snapshot.markets.length,3);
   for(const market of snapshot.markets){
    assert.equal(market.fresh,false);assert.equal(market.tradable,false);assert.equal(market.instrumentVerified,false);
    assert.equal(market.markPriceFresh,false);
    if(mode==='missing-time')assert.equal(market.priceAt,null);
    else assert.ok(Date.now()-market.priceAt>=180000);
   }
   assert.deepEqual((await app.disk()).paper,app.fixture.paper);
  }finally{await app.close()}
 }
});

test('all public reads can succeed while a legacy USDT area finds no listings and blocks market readiness',{timeout:15000},async()=>{
 const app=await sandbox({ORANGEX_ENABLED:'true',ORANGEX_MODE:'READ_ONLY',ORANGEX_LISTING_CURRENCY:'USDT',SIGNAL_LAB_TEST_ORANGEX_BOOK:'fresh'});
 try{
  const snapshot=JSON.parse((await app.read('/api/orangex?refresh=1')).text);
  assert.equal(snapshot.connected,true);assert.equal(snapshot.errors.length,0);
  assert.deepEqual(snapshot.listingCurrencies,['USDT']);assert.equal(snapshot.marketReadiness.publicDataReady,false);
  assert.equal(snapshot.marketReadiness.ready,false);assert.equal(snapshot.marketReadiness.paperReady,false);
  assert.ok(snapshot.marketReadiness.publicDataReasons.includes('LISTING_UNOBSERVED'));
  for(const row of snapshot.markets){assert.equal(row.fresh,true);assert.equal(row.markPriceFresh,true);
   assert.equal(row.listingObserved,false);assert.equal(row.active,null);assert.deepEqual(row.contractFields,{})}
  assert.deepEqual((await app.disk()).paper,app.fixture.paper);
 }finally{await app.close()}
});

test('plural documented areas override legacy settings and independent stale book or Mark blocks readiness',{timeout:15000},async()=>{
 for(const mode of ['old-book','old-mark']){
  const app=await sandbox({ORANGEX_ENABLED:'true',ORANGEX_MODE:'READ_ONLY',ORANGEX_LISTING_CURRENCY:'USDT',
   ORANGEX_LISTING_CURRENCIES:'BTC,ETH,SPOT',SIGNAL_LAB_TEST_ORANGEX_BOOK:mode});
  try{
   const snapshot=JSON.parse((await app.read('/api/orangex?refresh=1')).text);
   assert.deepEqual(snapshot.listingCurrencies,['BTC','ETH','SPOT']);assert.equal(snapshot.marketReadiness.publicDataReady,false);
   assert.equal(snapshot.marketReadiness.paperReady,false);
   assert.ok(snapshot.marketReadiness.publicDataReasons.includes(mode==='old-book'?'BOOK_STALE':'MARK_STALE'));
   for(const row of snapshot.markets){assert.equal(row.listingObserved,true);assert.equal(row.fresh,mode!=='old-book');assert.equal(row.markPriceFresh,mode!=='old-mark')}
   const requests=(await fs.readFile(app.requests,'utf8')).trim().split('\n').map(JSON.parse);
   assert.ok(requests.filter(row=>row.path.endsWith('/get_instruments')).every(row=>['BTC','ETH','SPOT'].includes(row.currency)));
   assert.deepEqual((await app.disk()).paper,app.fixture.paper);
  }finally{await app.close()}
 }
});
