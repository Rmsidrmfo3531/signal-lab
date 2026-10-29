import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
// Optional developer tool. It uses an existing local playwright-core and Chromium;
// npm test has no browser dependency. No package download or real API is used.
// node scripts/check-orangex-ui.mjs --playwright-module <module directory> --chromium <executable>
const args=process.argv.slice(2),options={};
for(let index=0;index<args.length;index+=2){
 const key=args[index],value=args[index+1];
 if(!['--playwright-module','--chromium'].includes(key)||!value||Object.hasOwn(options,key))throw Error('UI_SMOKE_USAGE: --playwright-module <directory> --chromium <executable>');
 options[key]=value;
}
if(!options['--playwright-module']||!options['--chromium'])throw Error('UI_SMOKE_REQUIRES_LOCAL_PLAYWRIGHT_AND_CHROMIUM');
const require=createRequire(import.meta.url),{chromium}=require(path.resolve(options['--playwright-module']));
const source=fileURLToPath(new URL('../',import.meta.url)),temp=await fs.mkdtemp(path.join(os.tmpdir(),'orangex-ui-smoke-'));
const app=path.join(temp,'app'),records=path.join(temp,'records'),artifacts=await fs.mkdtemp(path.join(os.tmpdir(),'orangex-paper26-browser-artifacts-'));
await fs.mkdir(path.join(app,'tests'),{recursive:true});await fs.mkdir(records);
for(const name of await fs.readdir(source))if(name==='package.json'||name.endsWith('.mjs'))await fs.copyFile(path.join(source,name),path.join(app,name));
await fs.cp(path.join(source,'public'),path.join(app,'public'),{recursive:true});
for(const name of ['mock_network.mjs','mock_runtime.mjs','mock_orangex_readonly.mjs'])await fs.copyFile(path.join(source,'tests',name),path.join(app,'tests',name));
await fs.writeFile(path.join(records,'store.json'),JSON.stringify({paperNotify:{enabled:false,history:[]}}));
const {paperScenario}=await import(pathToFileURL(path.join(source,'tests/fixtures/orangex_paper_scenario.mjs')));
const {runOrangeXPaperScenario}=await import(pathToFileURL(path.join(source,'scripts/orangex-paper-offline.mjs')));
runOrangeXPaperScenario(paperScenario(),{directory:path.join(records,'orangex-paper')});
const {syntheticReplayInput}=await import(pathToFileURL(path.join(source,'tests/fixtures/orangex_paper_replay.mjs')));
const {replayReport}=await import(pathToFileURL(path.join(source,'scripts/orangex-paper-replay.mjs')));
replayReport(syntheticReplayInput({complete:true}),{directory:path.join(records,'orangex-paper-replays')});
const sock=net.createServer();sock.listen(0,'127.0.0.1');await once(sock,'listening');const port=sock.address().port;await new Promise(resolve=>sock.close(resolve));
const child=spawn(process.execPath,['--import','./tests/mock_orangex_readonly.mjs','server.mjs'],{cwd:app,env:{PATH:process.env.PATH,HOST:'127.0.0.1',PORT:String(port),SIGNAL_LAB_DATA_DIR:records,AUTO_UPDATE:'false',UPDATE_MANIFEST_URL:'',SIGNAL_LAB_OPEN_BROWSER:'0',TELEGRAM_NEWS_ALERTS:'false',TELEGRAM_BOT_TOKEN:'',TELEGRAM_CHAT_ID:'',TWELVE_DATA_API_KEY:'',ORANGEX_ENABLED:'true',ORANGEX_MODE:'READ_ONLY',ORANGEX_CLIENT_ID:'',ORANGEX_CLIENT_SECRET:'',SIGNAL_LAB_TEST_ORANGEX_BOOK:'fresh'},stdio:['ignore','pipe','pipe']});
let closed=false,output='';const closure=new Promise(resolve=>child.once('close',()=>{closed=true;resolve()}));
child.stdout.on('data',value=>{output+=String(value)});child.stderr.on('data',value=>{output+=String(value)});
let browser;const results=[];
try{
 const base='http://127.0.0.1:'+port;let ready=false;
 for(let attempt=0;attempt<100;attempt++){
  try{if((await fetch(base+'/api/status')).ok){ready=true;break}}catch{}
  if(closed)throw Error('isolated server closed: '+output);await new Promise(resolve=>setTimeout(resolve,50));
 }
 assert.equal(ready,true,'server readiness');
 browser=await chromium.launch({executablePath:path.resolve(options['--chromium']),headless:true,args:['--no-sandbox','--disable-dev-shm-usage','--disable-background-networking']});
 for(const [name,width,mobile] of [['pc',1440,false],['mobile390',390,true],['mobile360',360,true],['mobile720',720,true]]){
  const context=await browser.newContext({viewport:{width,height:mobile?844:1000},isMobile:mobile,hasTouch:mobile,locale:'ko-KR'});
  const blocked=[];await context.route('**/*',route=>{const url=new URL(route.request().url());if(url.hostname==='127.0.0.1')return route.continue();blocked.push(url.hostname);return route.abort()});
  const page=await context.newPage(),errors=[],methods=[];page.on('pageerror',error=>errors.push(error.message));
  page.on('request',request=>{if(new URL(request.url()).pathname.startsWith('/api/orangex'))methods.push(request.method())});
  await page.goto(base,{waitUntil:'domcontentloaded',timeout:15000});
  await page.waitForFunction(()=>document.querySelectorAll('#orangexMarkets tr').length===3&&document.getElementById('orangexMarkets').textContent.includes('BTCUSDT'),null,{timeout:15000});
  await page.waitForFunction(()=>document.querySelectorAll('#orangexPaperClosed .orangex-paper-position').length===2&&document.getElementById('orangexPaperReplayStatus').textContent.includes('합성 호가 체결 모형'),null,{timeout:15000});
  if(mobile)await page.locator('.mobile-bottom-nav a[href="#orangex"]').click();else await page.locator('.navlink[href="#orangex"]').click();
  const current=await page.evaluate(()=>({performanceStatus:document.getElementById('orangexPaperPerformanceStatus').textContent,performanceMetrics:document.getElementById('orangexPaperPerformanceMetrics').textContent,contexts:document.getElementById('orangexPaperContexts').textContent,performanceDirections:document.getElementById('orangexPaperPerformanceDirections').textContent,performanceAssets:document.getElementById('orangexPaperPerformanceAssets').textContent,replayStatus:document.getElementById('orangexPaperReplayStatus').textContent,replayPerformance:document.getElementById('orangexPaperReplayPerformanceStatus').textContent,replaySummary:document.getElementById('orangexPaperReplaySummary').textContent,paperStorage:document.getElementById('orangexPaperStorage').textContent,paperStatus:document.getElementById('orangexPaperStatus').textContent,paperClosedCount:document.querySelectorAll('#orangexPaperClosed .orangex-paper-position').length,paperClosed:document.getElementById('orangexPaperClosed').textContent,paperSummary:document.getElementById('orangexPaperSummary').textContent,width:innerWidth,documentWidth:document.documentElement.scrollWidth,
   rows:document.querySelectorAll('#orangexMarkets tr').length,metrics:document.getElementById('orangexMetrics').textContent,
   operationalStatus:document.getElementById('orangexOperationalStatus').textContent,operationalChecks:document.getElementById('orangexOperationalChecks').textContent,readiness:document.getElementById('orangexReadiness').textContent,domains:document.getElementById('orangexListingDomains').textContent,domainCards:document.querySelectorAll('#orangexListingDomains article').length,readinessReasons:document.getElementById('orangexReadinessReasons').textContent,listing:document.getElementById('orangexMarkets').textContent,pnl:document.getElementById('orangexPnl').textContent,
   controls:document.querySelectorAll('#orangex input,#orangex select,#orangex form').length,
   buttons:document.querySelectorAll('#orangex button').length,
   navColumns:getComputedStyle(document.querySelector('.mobile-bottom-nav')).gridTemplateColumns.split(' ').length,
   legacyPanels:['scanner','paper','tradfi','news','journal','chartPanel','directionEntryBoard','pairDirectionEntries'].every(id=>Boolean(document.getElementById(id))),
   chartLink:document.getElementById('tvExternalLink').href}));
  assert.ok(current.documentWidth<=current.width,JSON.stringify(current));assert.equal(current.rows,3);
  assert.match(current.performanceStatus,/표본 부족/);assert.match(current.performanceStatus,/FORWARD_PAPER/);assert.match(current.contexts,/SYNTHETIC_TEST/);assert.match(current.performanceMetrics,/Profit Factor/);assert.match(current.performanceMetrics,/MDD/);assert.match(current.performanceMetrics,/평균 기대값/);assert.match(current.performanceDirections,/LONG/);assert.match(current.performanceDirections,/SHORT/);for(const asset of ['BTC','ETH','SOL'])assert.match(current.performanceAssets,new RegExp(asset));assert.match(current.replayStatus,/BACKTEST/);assert.match(current.replayStatus,/실제 과거 실측 아님/);assert.match(current.replayPerformance,/BACKTEST/);assert.match(current.paperStorage,/원장 [0-9.]+ \/ 16\.00MiB/);assert.match(current.paperStorage,/기존 Signal Lab PNL·포지션·설정·백업과 분리/);assert.equal(current.paperClosedCount,2);assert.match(current.paperStatus,/合成|합성 테스트 데이터/);assert.match(current.paperStatus,/실제 데이터 자동 진입 OFF/);assert.match(current.paperClosed,/LONG/);assert.match(current.paperClosed,/SHORT/);assert.match(current.paperClosed,/40%/);assert.match(current.paperClosed,/35%/);assert.match(current.paperClosed,/25%/);assert.match(current.paperClosed,/손절/);assert.match(current.paperSummary,/실현 PNL/);assert.equal(current.domainCards,3);assert.match(current.domains,/BTC/);assert.match(current.domains,/ETH/);assert.match(current.domains,/SPOT/);assert.match(current.readiness,/관측 조건 통과/);assert.match(current.readiness,/거래 준비 미완료/);assert.match(current.readinessReasons,/수수료 단위 미검증/);assert.match(current.metrics,/READ_ONLY/);assert.match(current.metrics,/미설정/);assert.match(current.metrics,/OFF/);
  assert.match(current.listing,/미검증 · 주문 차단/);assert.doesNotMatch(current.listing,/거래 불가/);assert.doesNotMatch(current.pnl,/\$0/);
  assert.match(current.operationalStatus,/NOT_READY/);assert.match(current.operationalStatus,/READ_ONLY/);assert.match(current.operationalStatus,/OFF/);for(const asset of ['BTC','ETH','SOL'])assert.match(current.operationalChecks,new RegExp(asset));assert.match(current.operationalChecks,/UNVERIFIED/);assert.equal(current.controls,0);assert.equal(current.buttons,1);assert.equal(current.legacyPanels,true);assert.match(current.chartLink,/tradingview.com/);
  if(mobile)assert.equal(current.navColumns,5);
  let reject=true;
  await page.route('**/api/orangex?refresh=1',route=>reject?route.fulfill({status:503,contentType:'application/json',body:'{}'}):route.continue());
  await page.locator('#orangexRefresh').click();
  await page.waitForFunction(()=>document.getElementById('orangexNotice').textContent.includes('조회 갱신 실패'));
  assert.equal(await page.locator('#orangexMarkets tr').count(),3,'old quotes stay visible with an explicit error state');
  assert.equal(await page.locator('#orangexRefresh').isDisabled(),false);
  reject=false;await page.locator('#orangexRefresh').click();
  await page.waitForFunction(()=>!document.getElementById('orangexNotice').textContent.includes('조회 갱신 실패')&&!document.getElementById('orangexRefresh').disabled);
  let paperFailure=true;await page.route('**/api/orangex/paper',route=>paperFailure?route.fulfill({status:503,contentType:'application/json',body:'{}'}):route.continue());
  await page.locator('#orangexRefresh').click();await page.waitForFunction(()=>document.getElementById('orangexPaperStatus').textContent.includes('조회 갱신 실패'));assert.equal(await page.locator('#orangexPaperClosed .orangex-paper-position').count(),2);
  paperFailure=false;await page.locator('#orangexRefresh').click();await page.waitForFunction(()=>!document.getElementById('orangexPaperStatus').textContent.includes('조회 갱신 실패')&&!document.getElementById('orangexRefresh').disabled);
  let replayFailure=true;await page.route('**/api/orangex/paper/replay',route=>replayFailure?route.fulfill({status:503,contentType:'application/json',body:'{}'}):route.continue());await page.locator('#orangexRefresh').click();await page.waitForFunction(()=>document.getElementById('orangexPaperReplayStatus').textContent.includes('조회 실패'));assert.equal(await page.locator('#orangexPaperClosed .orangex-paper-position').count(),2);replayFailure=false;await page.locator('#orangexRefresh').click();await page.waitForFunction(()=>!document.getElementById('orangexPaperReplayStatus').textContent.includes('조회 실패')&&!document.getElementById('orangexRefresh').disabled);
  let capacityInjection=true;
  await page.route('**/api/orangex/paper',async route=>{
   if(!capacityInjection)return route.fallback();
   const response=await route.fetch(),data=await response.json();
   data.storage={...data.storage,fileSizeBytes:14*1048576,maxStoreBytes:16*1048576,nearCapacity:true};
   return route.fulfill({response,json:data});
  });
  await page.locator('#orangexRefresh').click();
  await page.waitForFunction(()=>document.getElementById('orangexPaperStorage').textContent.includes('저장 용량 주의'));
  const capacityWarning=await page.locator('#orangexPaperStorage').textContent();
  assert.match(capacityWarning,/14\.00 \/ 16\.00MiB/);assert.match(capacityWarning,/기존 기록 자동 삭제 없음/);
  const warningWidth=await page.evaluate(()=>({width:innerWidth,documentWidth:document.documentElement.scrollWidth}));
  assert.ok(warningWidth.documentWidth<=warningWidth.width,'capacity warning must fit viewport');
  assert.deepEqual(errors,[]);assert.ok(methods.every(method=>method==='GET'));
  await page.locator('#orangex').screenshot({path:path.join(artifacts,name+'.png')});
  capacityInjection=false;await page.locator('#orangexRefresh').click();await page.waitForFunction(()=>!document.getElementById('orangexPaperStorage').textContent.includes('저장 용량 주의')&&!document.getElementById('orangexRefresh').disabled);
  results.push({name,passed:true,capacityWarningTest:{passed:true,injectedSource:'SYNTHETIC_UI_RESPONSE_ONLY',text:capacityWarning,normalStateRecovered:true},...current,pageErrors:errors,requestMethods:[...new Set(methods)],externalBlocked:[...new Set(blocked)],refreshFailureRecovered:true});
  await context.close();
 }
 const implementation={};
 for(const relative of ['server.mjs','public/orangex.js','public/orangex_operational.js','public/orangex_paper.js','public/index.html','public/styles.css'])implementation[relative]=createHash('sha256').update(await fs.readFile(path.join(app,relative))).digest('hex');
 const result={kind:'SYNTHETIC_ORANGEX_PAPER26_BROWSER',executionMode:'SYNTHETIC_TEST',dataSource:'MOCK_RESPONSE',actualOrangeXRequestsRun:false,actualWindowsExecution:false,existingUserRecordsTouched:false,realDataAutoEntryEnabled:false,liveOrdersEnabled:false,artifacts,platform:process.platform,nodeVersion:process.version,chromiumVersion:browser.version(),implementation,passed:true,results};await fs.writeFile(path.join(artifacts,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
}finally{
 if(browser)await browser.close();
 if(!closed){child.kill('SIGTERM');let timer;try{await Promise.race([closure,new Promise(resolve=>{timer=setTimeout(resolve,2500)})])}finally{clearTimeout(timer)}if(!closed){child.kill('SIGKILL');await closure}}
 await fs.rm(temp,{recursive:true,force:true,maxRetries:8,retryDelay:100});
}
