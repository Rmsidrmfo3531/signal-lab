import http from 'node:http';
import {exec,execFile} from 'node:child_process';
import {gitUpdateAvailable,gitCheck,gitApply,checkTree} from './git_update.mjs';
import {liveReadiness,readinessText} from './live_readiness.mjs';
import {articleDetail} from './news_article.mjs';
import {journalEntryFor,patternInsights} from './live_review.mjs';
import {buildReport,pushReport} from './reports_push.mjs';
import {CopyExecutor,copyConfig,resolveCopyContract} from './copy_executor.mjs';
import {copyEventText} from './copy_telegram.mjs';
import {liveEventText} from './live_telegram.mjs';
import {randomUUID,randomBytes,timingSafeEqual} from 'node:crypto';
import {authorizedRequest,localIPv4Addresses} from './mobile_access.mjs';
import {evaluateRequest,allowedHostNames,SECURITY_HEADERS} from './request_guard.mjs';
import {stageUpdate,pendingInfo} from './updater.mjs';
import {normalizeTrade,closeTrade,journalSummary,exportTradesCSV} from './journal.mjs';
import {signalLifecycle} from './signal_lifecycle.mjs';
import {evaluateSignal} from './signal_pipeline.mjs';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {analyze} from './engine.mjs';
import {configureSignalScorePolicy,getSignalScorePolicy,TREND_GATE_PATTERNS,DEFAULT_TRADE_PATTERNS,DISABLED_PATTERNS} from './signal_policy.mjs';
import {structureObservations,historicalPatternObservations} from './observation.mjs';
import {describeScanFunnel} from './scan_diagnostics.mjs';
import {binancePerpetualMarkets} from './markets.mjs';
import {officialMarketLinks,telegramMessage} from './links.mjs';
import {estimateBinanceExecution} from './binance_execution.mjs';
import {VolumeProfileCollector} from './profile_collector.mjs';
import {planVolumeTargets} from './volume_targets.mjs';
import {finalTelegramMatch} from './telegram_final.mjs';
import {translateNewsArticles,googleTranslate,googleTranslateStatus} from './news_translation.mjs';
import {buildMarketCommentary} from './market_commentary.mjs';
import {PublicReadBudget} from './public_read_budget.mjs';
import {FEEDS,prepareNews,shouldNotifyArticle} from './news.mjs';
import {tradfiAvailability} from './tradfi.mjs';
import {VenueQuoteService,parseVenueSymbols} from './venue_service.mjs';
import {liveConfig} from './live_orders.mjs';
import {LiveExecutor} from './live_executor.mjs';
import {BingXTradeClient,GateTradeClient} from './live_clients.mjs';
import {selectExecutionVenue,venueSizingInputs,venueCosts,venueOrderQuantity,parsePaperVenues,routeLiveSignal,venueStop} from './venue_execution.mjs';
import {roundDecimalToStep} from './decimal_grid.mjs';
import {PaperEngine,paperCSV,signalKey,nextSizeScale,planWithQuantity,leverageForScore,evenPositions,PAPER_DEFAULTS} from './paper.mjs';
import {paperEngineHealth} from './paper_health.mjs';
import {detectScalpReversal,buildScalpPlan,MoveTracker,SCALP_DEFAULTS,SCALP_TIMEFRAMES,isScalpStrategy,fourHourTrend,trendAllows} from './scalp_reversal.mjs';
import {planZoneDca,DCA_DEFAULTS,DCA_DEEP_PROFILE,clampMaxAdds,clampZoneDays,dcaZoneDaysFor,HOURLY_MAX_ADDS_DEFAULT} from './dca_plan.mjs';
import {windowsPaperNotify} from './windows_paper_notify.mjs';
import {startKeepAwake} from './windows_keep_awake.mjs';
import {paperTelegramText} from './paper_telegram.mjs';
import {liveOverview,checkLiveLevels} from './live_overview.mjs';
import {selectVenueOnlyCoins,venueVolumes,parseMarketCaps,screenByMarketCap,marketCapFor} from './venue_charts.mjs';
import {prepareData,readStore,atomicWriteStore,backupStore,acquireDataLock,recordHost,findConflictCopies} from './persistence.mjs';

const __dirname=path.dirname(fileURLToPath(import.meta.url));
const storage=prepareData(__dirname);
const releaseDataLock=acquireDataLock(storage.dir);
// Heartbeat so a second PC sharing this data folder (OneDrive etc.) sees the server is running.
setInterval(()=>releaseDataLock.heartbeat?.(),30000).unref?.();
process.on('exit',releaseDataLock);
// Which PCs have used this record folder (proves OneDrive is syncing between them) and any
// conflict copies OneDrive made when both wrote while out of sync.
const sharedCheck={hosts:recordHost(storage.dir),conflicts:findConflictCopies(storage.dir),checkedAt:Date.now()};
setInterval(()=>{sharedCheck.conflicts=findConflictCopies(storage.dir);sharedCheck.checkedAt=Date.now()},10*60000).unref?.();
const envfile=storage.envPath;
if(fs.existsSync(envfile))for(const line of fs.readFileSync(envfile,'utf8').split(/\r?\n/)){
 const match=line.match(/^\s*([A-Z][A-Z_0-9]*)\s*=\s*(.*)\s*$/);
 // The greedy value group keeps trailing blanks (e.g. "HOST=127.0.0.1 " from a
 // text editor). Trim first so the value is not silently different from what was typed.
 if(match&&!process.env[match[1]])process.env[match[1]]=match[2].trim().replace(/^['"]|['"]$/g,'');
}
configureSignalScorePolicy(process.env);
const CONFIG={
 port:Number(process.env.PORT||3000),host:process.env.HOST||'127.0.0.1',
 scanMs:Math.max(30000,Number(process.env.SCAN_INTERVAL_MS||60000)),
 rotatingBatch:Math.max(5,Math.min(100,Number(process.env.SCAN_ROTATING_BATCH||18))),
 hotBatch:Math.max(5,Math.min(80,Number(process.env.SCAN_HOT_BATCH||12))),
 quoteVolume:Math.max(0,Number(process.env.MIN_DAILY_VOLUME_USDT||5000000)),
 tgToken:process.env.TELEGRAM_BOT_TOKEN||'',tgChat:process.env.TELEGRAM_CHAT_ID||'',
 // Paper entries / closes to Telegram (opt-in on the paper page; needs the bot token and chat ID above).
 paperTelegram:process.env.PAPER_TELEGRAM==='true'?true:process.env.PAPER_TELEGRAM==='false'?false:null,
 // Automatic paper trading (new paper positions, 1/5/15m scalps, paper notices) is OFF by default since
 // live/testnet orders are the main path (user, 2026-11-12). PAPER_TRADING=on brings it back.
 // Off, stored paper records stay untouched in store.json.
 paperTrading:/^(on|true|1|yes)$/i.test(String(process.env.PAPER_TRADING||'').trim()),
 newsMs:Math.max(60000,Number(process.env.NEWS_POLL_MS||90000)),
 maxRiskUSD:Number(process.env.PAPER_MAX_RISK_USD||6),
 // Paper positions open at once (1-10). Each new one is half the size of the newest open one.
 // Even maximum, split half long / half short (PAPER_MAX_POSITIONS 2-10, default 6: 3 long + 3 short).
 paperMaxPositions:evenPositions(process.env.PAPER_MAX_POSITIONS,6),
 // Paper fills use these venues' quotes and contract rules (best entry wins). Binance = chart only.
 // Gate.io on hold (user, 2026-11-12): BingX only unless PAPER_VENUES names Gate.io again.
 paperVenues:parsePaperVenues(process.env.PAPER_VENUES??'BINGX'),
 // Venue book refresh for paper records; BingX's 1.1 s request spacing applies regardless.
 venueRefreshMs:Math.max(1000,Math.min(60000,Number(process.env.PAPER_VENUE_REFRESH_MS)||4000)),
 // HVN_THEN_R (default): volume-profile targets, open air beyond them filled in whole R steps. HVN_ONLY: strict.
 targetMode:process.env.TARGET_MODE==='HVN_ONLY'?'HVN_ONLY':'HVN_THEN_R',
 // Skip a trade when the zone before TP1 holds at least this share of the POC volume.
 // 1 = only the POC itself blocks. Backtest (60 days, 6 symbols): 0.5 blocked profitable trades
 // in both halves of the period (+$41 -> +$100 at 1.0), so the default is 1.
 targetObstacleFraction:Math.max(.1,Math.min(1,Number(process.env.TARGET_OBSTACLE_FRACTION)||1)),
 // 5m reversal scalp mode: paper trading only, never routed to live orders.
 scalpMode:String(process.env.SCALP_MODE||'ON').toUpperCase()!=='OFF',
 scalpMinMovePct:Math.max(1,Math.min(20,Number(process.env.SCALP_MIN_MOVE_PCT)||SCALP_DEFAULTS.minMovePct)),
 scalpIntervalMs:60000,scalpMaxChecks:6,
 // Scalp timeframes checked (SCALP_INTERVALS, any of 1m,5m,15m; default all three).
 scalpIntervals:(()=>{const v=String(process.env.SCALP_INTERVALS||'1m,5m,15m').split(',').map(x=>x.trim().toLowerCase()).filter(x=>x in SCALP_TIMEFRAMES);return v.length?[...new Set(v)]:['1m','5m','15m']})(),
 // 180-day backtest: counter-4H-trend reversals lost most (-$275 -> -$41 with this filter).
 scalpTrendFilter:String(process.env.SCALP_TREND_FILTER||'ON').toUpperCase()!=='OFF',
 // Zone scale-in for scalp paper trades: 1,1,2,4,... units on volume zones, cross margin.
 dcaMode:String(process.env.DCA_MODE||'ON').toUpperCase()!=='OFF',
 paperBalanceUSD:Math.max(10,Math.min(10000000,Number(process.env.PAPER_BALANCE_USD)||400)),
 // 1H paper positions are split buys: adds at volume zones, stop beyond the last add (STOP_ZONE_ADDS=false: pattern stop, no adds).
 stopZoneAdds:process.env.STOP_ZONE_ADDS!=='false',
 dcaLeverage:Math.max(10,Math.min(30,Math.round(Number(process.env.DCA_LEVERAGE)||DCA_DEFAULTS.leverage))),
 dcaUnitPct:Math.max(.01,Math.min(10,Number(process.env.DCA_UNIT_PCT)||DCA_DEFAULTS.unitPct)),
 dcaMaxLossPct:Math.max(1,Math.min(95,Number(process.env.DCA_MAX_LOSS_PCT)||DCA_DEFAULTS.maxLossPct)),
 // Adds per scale-in plan: 5-10 (default 10). Zones come from the 3-day profile plus a
 // deeper 15m profile over DCA_ZONE_DAYS (3-15, default 14) so 5+ adds have zones to sit on.
 dcaMaxAdds:clampMaxAdds(process.env.DCA_MAX_ADDS),hourlyMaxAdds:clampMaxAdds(process.env.HOURLY_MAX_ADDS,HOURLY_MAX_ADDS_DEFAULT),dcaZoneDays:clampZoneDays(process.env.DCA_ZONE_DAYS),
 translationURL:process.env.NEWS_TRANSLATION_URL||'',
 // Korean translation of English news (Google public endpoint when no URL is set). NEWS_TRANSLATION=off keeps English.
 newsTranslation:process.env.NEWS_TRANSLATION!=='off',
 updateManifestURL:process.env.UPDATE_MANIFEST_URL||'',autoUpdate:process.env.AUTO_UPDATE!=='false',
 // Coins on Gate.io / BingX that Binance does not list: charts come from the venue itself.
 // Paper only (never live). Every coin of similar size or larger is included: market cap at least
 // VENUE_ONLY_REFERENCE_RATIO (0.5) x the smaller market cap of VENUE_ONLY_REFERENCE (AKEUSDT,JCTUSDT:
 // examples of the size wanted), and 24h volume at least VENUE_ONLY_MIN_VOLUME_USDT (1M$). VENUE_ONLY_COINS=false turns it off.
 venueOnly:{enabled:process.env.VENUE_ONLY_COINS!=='false',
  minVolume:Number.isFinite(Number(process.env.VENUE_ONLY_MIN_VOLUME_USDT))&&process.env.VENUE_ONLY_MIN_VOLUME_USDT!==''&&process.env.VENUE_ONLY_MIN_VOLUME_USDT!=null?Number(process.env.VENUE_ONLY_MIN_VOLUME_USDT):null,
  // Market cap screen (CoinGecko top VENUE_ONLY_MCAP_PAGES x 250 coins, refreshed every 6 h):
  // drop coins under VENUE_ONLY_MIN_MARKET_CAP_USD (10M$) or not found, or whose 24h perp volume
  // is more than VENUE_ONLY_MAX_VOLUME_TO_MCAP (5) times their market cap.
  minMarketCap:Math.max(0,Number(process.env.VENUE_ONLY_MIN_MARKET_CAP_USD??1e7)||0),maxVolumeToCap:Math.max(.1,Number(process.env.VENUE_ONLY_MAX_VOLUME_TO_MCAP)||5),
  mcapPages:Math.max(1,Math.min(20,Math.round(Number(process.env.VENUE_ONLY_MCAP_PAGES)||8))),
  referenceRatio:Math.max(.05,Math.min(1,Number(process.env.VENUE_ONLY_REFERENCE_RATIO)||.5)),
  references:String(process.env.VENUE_ONLY_REFERENCE||'AKEUSDT,JCTUSDT').split(',').map(x=>x.trim().toUpperCase()).filter(x=>/^[A-Z0-9]{1,20}USDT$/.test(x)),
  batch:Math.max(1,Math.min(20,Math.round(Number(process.env.VENUE_ONLY_BATCH)||6))),startDelayMs:Math.max(200,Number(process.env.VENUE_ONLY_START_MS)||20000),intervalMs:Math.max(1000,Number(process.env.VENUE_ONLY_INTERVAL_MS)||60000),max:Math.max(1,Math.min(1000,Math.round(Number(process.env.VENUE_ONLY_MAX)||1000)))},
 limits:{maxSpreadBps:20,
  // 180-day / 12-symbol backtest: the range breakout (LONG) plus two short set-ups from the
  // user's video lessons (trendline break, 5/20 dead cross) were the profitable ones.
  // SIGNAL_PATTERNS=ALL trades every pattern; or a comma list of pattern names.
  allowedPatterns:(()=>{const v=String(process.env.SIGNAL_PATTERNS??'').trim();if(v.toUpperCase()==='ALL')return null;
   return v?v.split(',').map(x=>x.trim()).filter(x=>x&&!DISABLED_PATTERNS.includes(x)):[...DEFAULT_TRADE_PATTERNS]})(),
  // LONG only while BTC's 4H trend is up (signal_policy btcLongBlocked). BTC_LONG_FILTER=off disables.
  btcLongFilter:String(process.env.BTC_LONG_FILTER??'').trim().toLowerCase()==='off'?'off':'up'}
};
// LAN mode is opt-in. A fresh access password is generated on each start unless
// MOBILE_ACCESS_PASSWORD is explicitly set. Local localhost requests need no login.
const lanMode=!['127.0.0.1','::1','localhost'].includes(CONFIG.host);
const lanPassword=lanMode?(process.env.MOBILE_ACCESS_PASSWORD||randomBytes(6).toString('hex')):'';
// Loopback peers skip the password, so every request is first checked for a
// foreign Host name (DNS rebinding) and for cross-site browser origins.
const allowedHosts=allowedHostNames();
const dataPath=storage.storePath;
let persisted={watchlist:['BTCUSDT','ETHUSDT','SOLUSDT'],seen:{},alerts:[],newsSeen:{},journal:[],tradfiSeen:{}};
const historical=readStore(dataPath);
if(historical)persisted={...persisted,...historical};
// Atomic writes protect the latest persisted simulation from a partial save.
const storageHealth={healthy:true,lastSavedAt:0,error:''};
let committed=structuredClone(persisted);
function save(candidate=persisted){
 try{
  atomicWriteStore(dataPath,candidate);
  committed=structuredClone(candidate);persisted=candidate;
  Object.assign(storageHealth,{healthy:true,lastSavedAt:Date.now(),error:''});
 }catch(e){
  persisted=structuredClone(committed);
  Object.assign(storageHealth,{healthy:false,error:'기록 저장 실패. 디스크 공간·권한을 확인하세요.'});
  console.error('[CRITICAL STORE ERROR]',e.message);
  const error=Error(storageHealth.error);error.code='STORE_WRITE_FAILED';throw error;
 }
}
// Each launch creates a restorable snapshot before the running server modifies records.
try{backupStore(dataPath)}catch(e){console.error('[BACKUP ERROR]',e.message);throw e}
persisted.newsSeen ||= {};persisted.tradfiSeen ||= {};persisted.seen ||= {};persisted.journal=Array.isArray(persisted.journal)?persisted.journal:[];
persisted.paper ||= {pending:[],open:[],closed:[],skipped:[],seen:{}};
persisted.paperNotify ||= {enabled:true,history:[]};
persisted.paperNotify.enabled = persisted.paperNotify.enabled!==false;
if(!Array.isArray(persisted.paperNotify.history))persisted.paperNotify.history=[];
// Paper entries/closes on Telegram are opt-in (button on the paper page); PAPER_TELEGRAM=true/false forces it.
persisted.paperNotify.telegram=persisted.paperNotify.telegram===true;
// Server-side notification switches (알림 설정 page). Missing keys keep today's behaviour.
if(!persisted.notifySettings||typeof persisted.notifySettings!=='object'||Array.isArray(persisted.notifySettings))persisted.notifySettings={};
// Scanner (final-signal) Telegram alerts are off by default since the scanner page was removed;
// the one-time switch below turns them off once on existing installs, and the toggle still works.
if(persisted.notifySettings.scannerAlertsOffV1!==true){persisted.notifySettings.telegramSignals=false;persisted.notifySettings.scannerAlertsOffV1=true}
persisted.notifySettings.telegramSignals=persisted.notifySettings.telegramSignals===true;
function notificationSettings(){return {paperTrading:CONFIG.paperTrading,telegramSignals:persisted.notifySettings.telegramSignals,telegramLive:persisted.notifySettings.telegramLive!==false,telegramPaper:paperTelegramOn(),windowsPaper:persisted.paperNotify.enabled===true,
 telegramConfigured:Boolean(CONFIG.tgToken&&CONFIG.tgChat),telegramPaperForced:CONFIG.paperTelegram!==null,windowsSupported:process.platform==='win32'}}
const paperTelegramOn=()=>CONFIG.paperTelegram===true||CONFIG.paperTelegram===null&&persisted.paperNotify.telegram===true;
// Create the first shared store file even if no trading event occurs yet.
save();
const state={ws:'offline',rest:'connecting',lastMarketListings:0,executionRefreshAt:0,blockedSignals:0,lastBlockReason:'',binancePerps:0,lastMarket:0,lastScan:0,scannedSinceBoot:0,cycleScanned:0,cycle:0,
 activeSymbols:[],activeSet:new Set(),venueOnly:new Map(),venueOnlySet:new Set(),venueOnlyInfo:{at:0,threshold:null,thresholdSource:null,count:0,error:''},marketCaps:{caps:null,at:0,error:''},venueOnlyCursor:0,researchSymbols:[],researchSet:new Set(),researchRanked:[],scanMode:'waiting',lastValidatedAt:0,ranked:[],quotes:new Map(),analyses:new Map(),scanCursor:0,scanActive:false,error:'',clients:new Set(),recentSignals:[],
 liveWS:'offline',liveWatched:0,lastLiveTrigger:0,livePending:0,liveAnalyzed:0,
 lastTickerAt:0,lastTickerCount:0,lastLiveDataAt:0,lastLiveCandleClose:0,liveSubscribeAcks:0,liveSubscribeErrors:0,liveLastError:'',lastScanAttempt:0,scanStartedAt:0,scanFailedAt:0,marketRetryCount:0,marketError:'',marketLastRetry:0,news:[],newsStatus:'connecting',newsChecked:0,newsSources:[],newsError:'',update:{state:'unconfigured',lastCheck:0,message:'업데이트 서버 미설정'},scanSuccess:0,scanFailed:0,lastScanFailures:[],lastScanSuccessAt:0};
const apiCache=new Map();
const publicReadBudget=new PublicReadBudget();
let rawMarketTickers=[];
let marketStatsReceivedAt=0,marketStatsPending=null;
const profiles=new VolumeProfileCollector({request:url=>binance(url,0)});
const deepZoneProfile=DCA_DEEP_PROFILE(CONFIG.dcaZoneDays);
const deepProfiles=new VolumeProfileCollector({request:url=>binance(url,0),candles:deepZoneProfile.candles,profileOptions:{minCandles:deepZoneProfile.minCandles,targetBins:deepZoneProfile.targetBins,hvnMinFractionOfPoc:deepZoneProfile.hvnMinFractionOfPoc}});
// Fallback zone windows for 1H split buys: when the 15m zones give no add that fits, the next
// timeframe is tried (1h over 30 days, then 4h over 90 days). Fetched only when needed.
const ZONE_FALLBACKS=[{interval:'1h',candles:720,label:'1시간봉 30일'},{interval:'4h',candles:540,label:'4시간봉 90일'}];
const zoneFallbackOptions={minCandles:96,targetBins:240,hvnMinFractionOfPoc:.05};
const binanceZoneFallbacks=ZONE_FALLBACKS.map(f=>({...f,collector:new VolumeProfileCollector({request:url=>binance(url,0),interval:f.interval,candles:f.candles,profileOptions:zoneFallbackOptions})}));
const structureBySymbol=new Map();
const historyBySymbol=new Map();
function recentStructures(){return [...structureBySymbol.values()].flat().filter(x=>Date.now()-x.observedAt<2*3600000).sort((a,b)=>b.observedAt-a.observedAt).slice(0,100)}
function recentHistory(){return [...historyBySymbol.values()].flat().filter(x=>Date.now()-x.confirmedAt<24*3600000).sort((a,b)=>b.confirmedAt-a.confirmedAt).slice(0,100)}
const MIME={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.svg':'image/svg+xml','.ico':'image/x-icon','.json':'application/json; charset=utf-8'};
function response(res,status,body,extraHeaders={}){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store',...SECURITY_HEADERS,...extraHeaders});res.end(JSON.stringify(body))}
function send(event,obj){const msg=`event: ${event}\ndata: ${JSON.stringify(obj)}\n\n`;for(const client of state.clients){try{client.write(msg)}catch{state.clients.delete(client)}}}
function emitPaperNotice(event,{test=false}={}){
  const item={...event,id:randomUUID(),recordedAt:Date.now(),test};
  const pref=persisted.paperNotify;
  if(!test){pref.history.unshift(item);pref.history=pref.history.slice(0,100);save();send('paper-event',item)}
  const delivery=pref.enabled?windowsPaperNotify(event,{onResult:result=>{
    pref.lastDelivery={...result,at:Date.now(),test,type:event.type,symbol:event.symbol};
    if(!result.ok)console.warn('[PAPER NOTIFY FAILED]',result.error);
    send('paper-notify-result',pref.lastDelivery)}}):{queued:false,reason:'알림 설정 OFF'};
  console.log(`[PAPER ${test?'TEST':event.type}]`,event.symbol,event.direction,delivery.reason);
  const telegram=paperTelegram(event,{test});
  return {event:item,delivery,telegram};
}
// Phone notice for paper events. Independent of the Windows notice switch; failures never touch the PNL.
function paperTelegram(event,{test=false}={}){
 if(!paperTelegramOn()||!CONFIG.tgToken||!CONFIG.tgChat)return {queued:false,reason:!paperTelegramOn()?'텔레그램 모의 알림 꺼짐':'텔레그램 미설정'};
 if(event.type!=='OPEN'&&event.type!=='CLOSE')return {queued:false,reason:'대상 아님'};
 try{
  const store=typeof paper==='undefined'?null:paper.store,record=store?[...store.open,...store.closed].findLast?.(x=>x.key===event.key)??null:null;
  const done=store?.closed??[],totals=test?null:{pnl:done.reduce((s,x)=>s+Number(x.realizedPnLUSD||0),0),closed:done.length,wins:done.filter(x=>x.realizedPnLUSD>0).length};
  const text=paperTelegramText(event,test?{strategy:'HOURLY_1H',pattern:'테스트',targets:[104,106,108],chartVenue:'BINANCE',executionVenue:'BINGX',openedAt:Date.now()-3600000,initialRiskUSD:2}:record,{totals,test});
  void telegramPost({chat_id:CONFIG.tgChat,text,disable_web_page_preview:true})
   .then(r=>{if(!r.ok)console.warn('[PAPER TELEGRAM] HTTP',r.status)}).catch(()=>console.warn('[PAPER TELEGRAM] 전송 확인 실패'));
  return {queued:true};
 }catch(e){console.warn('[PAPER TELEGRAM]',e.message);return {queued:false,reason:e.message}}
}
// BingX/Gate.io are the execution venues: public quotes only, fetched on demand.
// Binance remains the chart/analysis source and is shown only as a reference price.
const venueQuotes=new VenueQuoteService();
// ---- Live / testnet orders (OFF unless LIVE_TRADING_MODE is set; armed per start) -----
const LIVE=liveConfig(process.env);
function liveClients(){
 if(LIVE.mode==='OFF')return {};
 const mode=LIVE.mode==='LIVE'?'LIVE':'TESTNET',clients={};
 // Signed timestamps use the venue clock measured by the public clients (PC clocks drift).
 const venueNow=venue=>()=>Date.now()+(venueQuotes.clients[venue]?.clockOffsetMs||0);
 if(process.env.BINGX_API_KEY&&process.env.BINGX_API_SECRET)clients.BINGX=new BingXTradeClient({apiKey:process.env.BINGX_API_KEY,secret:process.env.BINGX_API_SECRET,mode,now:venueNow('BINGX')});
 if(process.env.GATEIO_API_KEY&&process.env.GATEIO_API_SECRET)clients.GATEIO=new GateTradeClient({apiKey:process.env.GATEIO_API_KEY,secret:process.env.GATEIO_API_SECRET,mode,now:venueNow('GATEIO')});
 return clients;
}
let copyTrader=null;
const live=new LiveExecutor({config:LIVE,clients:liveClients(),directory:storage.dir,log:(...a)=>console.log(...a),onChange:status=>send('live',status),
 // Copy positions on the same testnet account are kept apart; a real-money copy uses another account.
 externalHeld:()=>COPY_ON_SAME_ACCOUNT()?copyTrader?.heldSymbols()??new Set():new Set(),
 priceOf:record=>livePublicPrice(record),onEvent:(record,type,detail)=>liveTelegramNotice(record,type,detail)});
// Copy trading of the followed Telegram channel (copy_executor.mjs): TESTNET only, its own ledger.
let copyTickers={at:0,rows:[]};
// Messages arrive from the local listener (deploy/linux/copy_listener.py) with COPY_LISTENER_TOKEN.
const COPY=copyConfig(process.env,LIVE.mode);
// Same account when both run in the same mode (testnet + testnet, or later live + live).
function COPY_ON_SAME_ACCOUNT(){return COPY.mode===(LIVE.mode==='LIVE'?'LIVE':'TESTNET')}
// Update restarts wait for the copy queue too (a market fill is saved before the next step).
function allIdle(){return live.idle()&&(copyTrader?.idle?.()??true)}
// Real-money copy (COPY_MODE=LIVE + COPY_LIVE_CONFIRM): its own BingX live client and ledger file.
const copyClient=COPY.mode==='LIVE'&&process.env.BINGX_API_KEY&&process.env.BINGX_API_SECRET
 ?new BingXTradeClient({apiKey:process.env.BINGX_API_KEY,secret:process.env.BINGX_API_SECRET,mode:'LIVE',now:()=>Date.now()+(venueQuotes.clients.BINGX?.clockOffsetMs||0)})
 :live.clients.BINGX;
const bingxFunds=data=>{const list=Array.isArray(data)?data:[data?.balance??data],u=list.find(x=>x?.asset==='USDT')??list[0],equity=Number(u?.equity??u?.balance)||0,free=Number(u?.availableMargin);
 return {equity,available:Number.isFinite(free)?Math.max(0,free):equity}};
copyTrader=new CopyExecutor({config:COPY,client:copyClient,fileName:COPY.mode==='LIVE'?'copy-store-live.json':'copy-store.json',
 // Same name, 1000-coin contract or stock perpetual (SNDKUSDT -> NCSKSNDK2USD-USDT).
 contractOf:async symbol=>resolveCopyContract(await venueQuotes.clients.BINGX.loadContracts(),symbol),
 // Last price on BingX (tickers cached 20 s) for the copy price check.
 markOf:async venueSymbol=>{if(!copyTickers.at||Date.now()-copyTickers.at>20000)copyTickers={at:Date.now(),rows:await venueQuotes.clients.BINGX.tickers()};
  const t=copyTickers.rows.find(x=>x.symbol===venueSymbol);return Number(t?.lastPrice)||null},
 // Candles for the volume-confirmed zone break (Binance, or the venue for coins not on Binance).
 candlesOf:(symbol,interval,limit)=>state.activeSet.has(symbol)||!chartVenueFor(symbol)?klines(symbol,interval,limit):venueKlines(symbol,interval,limit),
 // Volume zones for the copy stop: Binance 1h (30 d) and 4h (90 d) profiles, or the venue's for coins not on Binance.
 zonesOf:async(symbol,{tickSize})=>{const list=state.activeSet.has(symbol)||!chartVenueFor(symbol)?binanceZoneFallbacks:venueZoneFallbacks,out=[];
  for(const f of list){const r=await f.collector.get(symbol,{tickSize:Number(tickSize),eligible:true}).catch(()=>null);if(r?.ok)out.push(...r.profile.hvn.map(z=>({priceLow:z.priceLow,priceHigh:z.priceHigh})))}
  return out},
 // Testnet copy follows the signal strategy's switch; real-money copy has its own (off after every restart).
 gate:()=>live.store.killSwitch?{ok:false,reason:'KILL_SWITCH'}:COPY.mode==='LIVE'?(copyTrader.armed?{ok:true}:{ok:false,reason:'COPY_DISARMED'}):LIVE.mode!=='TESTNET'?{ok:false,reason:'NOT_TESTNET'}:!live.armed?{ok:false,reason:'LIVE_DISARMED'}:{ok:true},
 // Also a symbol the live executor is entering right now (busy), not only recorded positions.
 isBusy:symbol=>COPY_ON_SAME_ACCOUNT()&&(live.busy.has(symbol)||live.store.records.some(r=>['SUBMITTING','OPEN','UNKNOWN'].includes(r.status)&&r.symbol===symbol)),
 // The same balance cap as the signal strategy (a 100,000 virtual USDT testnet trades like the real account).
 // The testnet balance cap does not apply to a real-money copy (its own real equity).
 balance:async()=>{if(COPY.mode==='LIVE')return bingxFunds(await copyClient.balance());const f=await live.accountFunds('BINGX');const cap=LIVE.balanceCapUSD>0?LIVE.balanceCapUSD:Infinity;if(!(cap<Infinity))return f;
  const used=Math.max(0,f.equity-f.available),equity=Math.min(f.equity,cap);return {equity,available:Math.max(0,Math.min(f.available,equity-used))}},
 directory:storage.dir,log:(...a)=>console.log(...a),onEvent:copyNotice});
// A copy ledger of the other mode with open positions is no longer managed: say so once at start.
try{const other=path.join(storage.dir,COPY.mode==='LIVE'?'copy-store.json':'copy-store-live.json');
 if(fs.existsSync(other)){const o=JSON.parse(fs.readFileSync(other,'utf8'));const n=Object.values(o.positions||{}).filter(x=>x.status==='OPEN');
  if(n.length){const text=`⚠️ 카피 모드가 ${COPY.mode==='LIVE'?'실계좌':'테스트넷'}로 바뀌었습니다. ${COPY.mode==='LIVE'?'테스트넷':'실계좌'} 카피 포지션 ${n.length}개(${n.map(x=>x.symbol).join(', ')})는 더 이상 따라가지 않습니다. 거래소에서 직접 정리해 주세요.`;
   console.warn('[COPY]',text);setTimeout(()=>{try{if(CONFIG.tgToken&&CONFIG.tgChat)telegramPost({chat_id:CONFIG.tgChat,text}).catch(()=>{})}catch{}},5000)}}}catch{}
// First balance / positions read soon after start (the panel shows the copy account's balance).
if(COPY.enabled)setTimeout(()=>{void copyTrader.reconcile().catch(()=>{})},8000).unref?.();
if(COPY.enabled)setInterval(()=>{void copyTrader.reconcile().catch(e=>console.error('[COPY RECONCILE]',e.message))},60000).unref?.();
function copyNotice(e){
 const text=copyEventText(e);if(!text)return;
 try{send('live-notice',{type:'COPY_'+e.type,symbol:e.symbol??null,text,at:Date.now()})}catch{}
 if(persisted.notifySettings?.telegramLive===false||!CONFIG.tgToken||!CONFIG.tgChat)return;
 telegramPost({chat_id:CONFIG.tgChat,text}).then(r=>{if(!r.ok)console.error('[COPY TELEGRAM] HTTP',r.status)}).catch(e2=>console.error('[COPY TELEGRAM]',e2.message));
}
// Re-arm after a one-tap update (user request 2026-11-13): only when it was armed when the update
// started, within 15 minutes, on TESTNET, and with no kill switch. Real-money mode (LIVE) is never
// armed by itself; any other restart (reboot, crash) also starts disarmed.
{
 const marker=path.join(storage.dir,'rearm-after-update.json');
 try{
  const m=JSON.parse(fs.readFileSync(marker,'utf8'));fs.rmSync(marker,{force:true});
  if(m?.mode==='TESTNET'&&LIVE.mode==='TESTNET'&&Date.now()-Number(m.at)<15*60000&&!live.store.killSwitch){live.arm();console.log('[LIVE] 업데이트 전 활성화 상태 복원 (테스트넷)')}
 }catch{}
}
// The venue's public mid price for a live record (screen and exit estimates only; never an order input).
function livePublicPrice(record){const book=venueBooks.get(record.venue+':'+record.symbol);return book?.ok&&Number.isFinite(book.mid)&&Date.now()-book.receivedAt<60000?book.mid:null}
function liveRecordPrice(record){const p=record.position;return p?.markPrice>0&&Date.now()-p.at<90000?p.markPrice:livePublicPrice(record)}
// Account equity for the 실매매 screen: read at most every 30 s, only while the screen asks for it.
const liveBalance={venue:null,usd:null,at:0,error:'',pending:null};
async function liveBalanceSnapshot(){
 const venue=LIVE.venues.find(v=>live.credentials()[v]);
 if(LIVE.mode==='OFF'||!venue)return null;
 if(Date.now()-liveBalance.at>=30000&&!liveBalance.pending){
  liveBalance.pending=live.accountBalance(venue).then(usd=>Object.assign(liveBalance,{venue,usd:Number.isFinite(usd)?usd:null,error:''}),
   e=>Object.assign(liveBalance,{venue,error:e.code||'BALANCE_UNAVAILABLE'})).finally(()=>{liveBalance.at=Date.now();liveBalance.pending=null});
 }
 if(liveBalance.pending&&!liveBalance.at)await liveBalance.pending;
 return {venue:liveBalance.venue,usd:liveBalance.usd,at:liveBalance.at||null,error:liveBalance.error||null,capUSD:LIVE.balanceCapUSD||null};
}
const paper=new PaperEngine(persisted.paper,{settings:{...(persisted.paperSettings||{}),maxRiskUSD:CONFIG.maxRiskUSD,maxPositions:CONFIG.paperMaxPositions,maxPerDirection:CONFIG.paperMaxPositions/2,requireExecutionVenue:true,TP1_MOVE_STOP_TO_BREAKEVEN:persisted.paperSettings?.TP1_MOVE_STOP_TO_BREAKEVEN??process.env.TP1_MOVE_STOP_TO_BREAKEVEN!=='false',TP1_BREAKEVEN_MODE:persisted.paperSettings?.TP1_BREAKEVEN_MODE??process.env.TP1_BREAKEVEN_MODE??'ENTRY_FILL'},onChange:store=>{save({...persisted,paper:store});send('paper',{event:'updated',at:Date.now()});},onEvent:event=>{if(CONFIG.paperTrading)emitPaperNotice(event)}});

// ---- Execution venue books (BingX / Gate.io) -------------------------------------
// Latest validated book per venue+symbol. Refreshed for technically qualified setups
// and for every paper record executed on a venue; each refresh also moves those records.
const venueBooks=new Map();
function venueEntry(venue,symbol){
 return {contract:venueQuotes.clients[venue]?.contracts?.get(symbol)??null,book:venueBooks.get(venue+':'+symbol)??null};
}
// Concurrent callers share one request per venue+symbol, and a book younger than
// maxAgeMs is reused, so analysis and the paper loop do not queue duplicate calls.
const venueBookPending=new Map();
async function refreshVenueBook(venue,symbol,{maxAgeMs=0}={}){
 const key=venue+':'+symbol,cached=venueBooks.get(key);
 if(maxAgeMs>0&&cached&&Date.now()-cached.receivedAt<maxAgeMs)return cached;
 if(venueBookPending.has(key))return venueBookPending.get(key);
 const task=(async()=>{
  const client=venueQuotes.clients[venue];
  try{
   const contracts=await client.loadContracts();if(!contracts.has(symbol))return null;
   const book=await client.book(symbol);venueBooks.set(key,book);return book;
  }catch(error){state.venueError=`${venue} ${symbol}: ${error.code||error.message}`;return null}
 })();
 venueBookPending.set(key,task);
 try{return await task}finally{venueBookPending.delete(key)}
}
function feedPaperFromVenue(venue,symbol,book){
 if(!book?.ok||!Number.isFinite(book.mid))return;
 // Re-checks the symbol's approval on every venue quote: this publishes final signals (and so live
 // entries) also for coins without a Binance price feed, with or without paper trading.
 const entryAllowed=cryptoEntryAllowed(symbol,Date.now());
 if(CONFIG.paperTrading)paper.onPrice('CRYPTO',symbol,book.mid,book.sourceTime,{venue,halfSpreadBps:book.spreadBps/2,quoteFresh:true,entryAllowed});
}
/** Manual stop / TP change of an open live position: checked against its current price, then only
 * the changed levels go to LiveExecutor.setLevels (new stop before the old one is cancelled). */
async function liveLevels(body){
 if(typeof body?.key!=='string'||body.key.length>300)return [400,{ok:false,reasons:['KEY_REQUIRED']}];
 if(LIVE.mode==='OFF')return [409,{ok:false,reasons:['LIVE_MODE_OFF']}];
 const record=live.store.records.find(r=>r.signalKey===body.key&&r.status==='OPEN');
 if(!record)return [404,{ok:false,reasons:['POSITION_NOT_FOUND']}];
 const check=checkLiveLevels(record,{stop:body.stop??null,targets:Array.isArray(body.targets)?body.targets:null},{price:liveRecordPrice(record)});
 if(!check.ok)return [400,check];
 if(!check.changed)return [200,{ok:true,changed:false}];
 const result=await live.setLevels(body.key,{stop:check.stop,targets:check.targets});
 return [result.ok?200:409,{...result,changed:true,live:result}];
}
let venueRefreshActive=false,venueRefreshCycle=0;
async function refreshVenueExecution(){
 if(venueRefreshActive)return;venueRefreshActive=true;
 try{
  const now=Date.now(),held=new Map(),cand=new Map(CONFIG.paperVenues.map(v=>[v,new Set()]));
  const add=(map,v,s)=>{if(!map.has(v))map.set(v,new Set());map.get(v).add(s)};
  // Open/pending positions always get a quote every cycle (stops and TPs depend on it), including
  // positions on a venue that is now on hold, until they close.
  if(CONFIG.paperTrading)for(const record of [...paper.store.pending,...paper.store.open]){const v=record.executionVenue;if(v&&venueQuotes.clients[v])add(held,v,record.symbol)}
  // Live positions: a fresh public price for the screen (the executor reads the position itself).
  for(const record of live.store.records)if(['SUBMITTING','OPEN','UNKNOWN'].includes(record.status)&&venueQuotes.clients[record.venue])add(held,record.venue,record.symbol);
  for(const row of state.analyses.values())if(row.technicalQualified===true&&row.executionVenue&&cand.has(row.executionVenue)&&now-row.scannedAt<2*3600000)
   add(cand,row.executionVenue,row.symbol);
  // BingX allows about one public request per second: held symbols first, then new candidates up to
  // about 4 requests per venue per cycle (at least 1), rotating so every candidate is quoted in turn.
  venueRefreshCycle++;
  const venues=new Set([...held.keys(),...cand.keys()]);
  await Promise.all([...venues].map(async venue=>{
   const mine=held.get(venue)??new Set(),rest=[...(cand.get(venue)??[])].filter(s=>!mine.has(s));
   const start=rest.length?(venueRefreshCycle*2)%rest.length:0,pick=[...rest.slice(start),...rest.slice(0,start)].slice(0,Math.max(1,4-mine.size));
   for(const symbol of [...mine,...pick]){const book=await refreshVenueBook(venue,symbol);if(book)feedPaperFromVenue(venue,symbol,book)}
  }));
  state.venueRefreshAt=Date.now();state.executionRefreshAt=state.venueRefreshAt;
 }finally{venueRefreshActive=false}
}
setInterval(()=>{void refreshVenueExecution()},CONFIG.venueRefreshMs).unref?.();

async function binance(url,ttl=30000){
 const cache=apiCache.get(url);
 if(cache && cache.until>Date.now())return cache.data;
 if(cache?.pending)return cache.pending;
 const task=(async()=>{
  const budget=publicReadBudget.reserve(url);if(!budget.ok)throw Error(budget.code);
  const ctrl=new AbortController();const timeout=setTimeout(()=>ctrl.abort(),12000);
  try {
   const r=await fetch('https://fapi.binance.com'+url,{signal:ctrl.signal,headers:{'User-Agent':'SignalLab/1.0','Accept':'application/json'}});
   if(!r.ok){publicReadBudget.rateLimited(r.status,r.headers?.get?.('retry-after'));throw Error(`Binance HTTP ${r.status}: 공개 조회 일시 보류`);}
   const data=await r.json();apiCache.set(url,{data,until:Date.now()+ttl});state.rest='connected';return data;
  } finally{clearTimeout(timeout)}
 })();
 apiCache.set(url,{data:cache?.data,until:0,pending:task});
 if(apiCache.size>1200){for(const [key,value]of apiCache){if(!value.pending&&value.until<Date.now())apiCache.delete(key);if(apiCache.size<=1000)break}}
 try{return await task;}catch(e){apiCache.delete(url);state.rest='offline';state.error=e.message;throw e}
}
// No validated replacement market/contract feed is configured for TradFi.
// Keep historical records intact; never mark stale positions as freshly tracked.
function tradfiPublic(){
 const retained=paper.store;
 return {...tradfiAvailability(),retainedRecords:{
  open:retained.open.filter(x=>x.market==='TRADFI').length,
  pending:retained.pending.filter(x=>x.market==='TRADFI').length,
  closed:retained.closed.filter(x=>x.market==='TRADFI').length
 }};
}
const exchangeInfo=()=>binance('/fapi/v1/exchangeInfo',15*60*1000);
const market24=()=>binance('/fapi/v1/ticker/24hr',75000);
const klines=(symbol,interval,limit=150)=>binance(`/fapi/v1/klines?symbol=${encodeURIComponent(symbol)}&interval=${interval}&limit=${limit}`,interval==='4h'?170000:interval==='1h'?54000:20000);
// Binance alone defines crypto listings, prices and analysis. TradFi collection is disabled.
function marketFailure(error){
 state.rest='offline';state.marketError=String(error?.message||error);state.error='Binance 데이터 검증 지연: '+state.marketError;
 state.marketRetryCount++;state.marketLastRetry=Date.now();state.scanMode=state.activeSymbols.length?'binance-stale':'waiting';
 refreshLiveSubscriptions();send('status',getStatus());
}
async function loadMarket(){
 try{
  const [info,tickers]=await Promise.all([exchangeInfo(),market24()]),joined=binancePerpetualMarkets(info,tickers);
  if(!joined.markets.length)throw Error('TRADING USDT 무기한 선물 목록 없음');
  rawMarketTickers=tickers;marketStatsReceivedAt=Date.now();state.ranked=joined.markets;state.binancePerps=joined.binancePerps;
  state.researchRanked=[];state.researchSymbols=[];state.researchSet=new Set();
  state.activeSymbols=joined.markets.map(x=>x.symbol);state.activeSet=new Set(state.activeSymbols);
  for(const row of joined.markets){const old=state.quotes.get(row.symbol);state.quotes.set(row.symbol,{...row,
   price:old?.priceAt>row.priceAt?old.price:row.price,priceAt:old?.priceAt>row.priceAt?old.priceAt:row.priceAt});}
  state.lastMarket=Date.now();state.lastMarketListings=Date.now();state.lastValidatedAt=Date.now();
  state.rest='connected';state.scanMode='binance-usdt-perpetual';state.error='';state.marketError='';state.marketRetryCount=0;
  refreshLiveSubscriptions();send('market',{at:state.lastMarket,markets:state.ranked,watchlist:persisted.watchlist,analysisVenue:'BINANCE'});send('status',getStatus());return state.ranked;
 }catch(error){marketFailure(error);if(!state.ranked.length)throw error;return state.ranked}
}
async function refreshMarketStats(){
 if(marketStatsReceivedAt&&Date.now()-marketStatsReceivedAt<60000)return;
 if(marketStatsPending)return marketStatsPending;
 marketStatsPending=(async()=>{rawMarketTickers=await market24();marketStatsReceivedAt=Date.now()})();
 try{await marketStatsPending}finally{marketStatsPending=null}
}
async function tgNotify(s){
 if(!CONFIG.tgToken||!CONFIG.tgChat)return;
 if(persisted.notifySettings?.telegramSignals===false)return; // switched off in 알림 설정
 try{
 // Final-results API is the source of truth. Any later quote/venue rejection
 // suppresses delivery even if an earlier scan approved the same candle.
 const matched=finalTelegramMatch(s,relevantSignals(),getSignalScorePolicy().finalMinScore);
 if(!matched)return;
 const urls=state.activeSet.has(matched.symbol)?officialMarketLinks(matched.symbol):null;
 if(!urls){console.warn('Telegram suppressed: market link not verified',s.symbol);return}
 const paperPosition=paper.store.open.find(p=>p.key===signalKey({market:'CRYPTO',symbol:matched.symbol,direction:matched.direction,pattern:matched.pattern,barAt:matched.patternConfirmedAt}));
 const payload={chat_id:CONFIG.tgChat,...telegramMessage(matched,urls,{paperPosition})};
  const r=await telegramPost(payload);
  if(!r.ok)console.error('Telegram HTTP',r.status);
 }catch{console.error('Telegram delivery unconfirmed')}
}
// The one Telegram transport. Callers: final signals (tgNotify, guarded by the final results) and
// opt-in paper entry/close notices (paperTelegram, simulation text only).
function telegramPost(payload){
 return fetch(`https://api.telegram.org/bot${CONFIG.tgToken}/sendMessage`,{
  method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload),signal:AbortSignal.timeout(10000)});
}

let updateCheckPromise=null;
const GIT_UPDATE=gitUpdateAvailable(__dirname);
let updateJob={active:false,pct:0,label:''};
// Real-money readiness, measured on testnet trades under the current rules (live_readiness.mjs).
// A short Telegram report every morning (09:00 KST) and once when every criterion is met.
const readinessFile=path.join(storage.dir,'readiness.json');
const readiness=()=>liveReadiness([...live.store.records,...(live.store.archived||[])],{mode:LIVE.mode==='LIVE'?'LIVE':'TESTNET',
 since:Number.isFinite(Date.parse(process.env.LIVE_READINESS_SINCE||''))?Date.parse(process.env.LIVE_READINESS_SINCE):undefined,balanceUSD:LIVE.balanceCapUSD>0?LIVE.balanceCapUSD:undefined,strategyProfile:LIVE.strategyProfile||null});
async function readinessReport(){
 if(LIVE.mode==='OFF'||!CONFIG.tgToken||!CONFIG.tgChat)return;
 let saved={};try{saved=JSON.parse(fs.readFileSync(readinessFile,'utf8'))}catch{}
 const r=readiness(),kst=new Date(Date.now()+9*3600000),day=kst.toISOString().slice(0,10),hour=kst.getUTCHours();
 const daily=hour>=9&&saved.lastDay!==day,first=r.ready&&!saved.readyNotified;
 if(!daily&&!first)return;
 try{const res=await telegramPost({chat_id:CONFIG.tgChat,text:readinessText(r)});if(!res.ok)return console.error('[READINESS] Telegram HTTP',res.status)}
 catch(e){return console.error('[READINESS] Telegram',e.message)}
 try{fs.writeFileSync(readinessFile,JSON.stringify({lastDay:daily?day:saved.lastDay,readyNotified:saved.readyNotified||r.ready,at:Date.now()}))}catch{}
}
setInterval(()=>{void readinessReport()},10*60000).unref?.();setTimeout(()=>{void readinessReport()},60000).unref?.();
// Finished live trades go into the trade journal by themselves, with a review (live_review.mjs).
function syncLiveJournal(){
 const have=new Set([...persisted.journal.map(x=>x.id),...(persisted.journalHidden||[])]);let added=0;
 for(const r of live.store.records){
  if(r.test===true||r.status!=='CLOSED'||!r.realized||!['EXCHANGE','ESTIMATE'].includes(r.realized.source))continue;
  const entry=journalEntryFor(r);if(have.has(entry.id))continue;
  persisted.journal.unshift(entry);have.add(entry.id);added++;
 }
 if(!added)return;
 // Over 500 entries: drop the oldest automatic ones, never manual entries.
 while(persisted.journal.length>500){const i=persisted.journal.findLastIndex(x=>x.source==='LIVE_AUTO');if(i<0)break;persisted.journal.splice(i,1)}
 save();send('journal',{summary:journalSummary(persisted.journal)});console.log('[JOURNAL] 실매매 거래',added,'건 자동 기록');reportsDirty=true;
}
setInterval(syncLiveJournal,5*60000).unref?.();setTimeout(syncLiveJournal,30000).unref?.();
// Results upload (reports_push.mjs): once a day after 09:00 KST and after new journal entries.
const REPORTS_DIR=process.env.SIGNAL_LAB_REPORTS_DIR||path.join(path.dirname(storage.dir),'reports');
const REPORTS_KEY=path.join(path.dirname(storage.dir),'.ssh','reports_ed25519');
let reportsDay=null,reportsDirty=false,reportsBusy=false;
async function uploadReport(force=false){
 if(reportsBusy||!fs.existsSync(path.join(REPORTS_DIR,'.git')))return;
 const day=new Date(Date.now()+9*3600000).toISOString().slice(0,10),hour=new Date(Date.now()+9*3600000).getUTCHours();
 if(!force&&!reportsDirty&&!(hour>=9&&reportsDay!==day))return;
 reportsBusy=true;
 try{
  const report=buildReport({readiness:readiness(),insights:patternInsights(persisted.journal.filter(x=>x.source==='LIVE_AUTO'&&x.review).map(x=>x.review)),
   journal:persisted.journal,records:[...live.store.records,...(live.store.archived||[])]});
  const r=await pushReport(REPORTS_DIR,report,{keyFile:fs.existsSync(REPORTS_KEY)?REPORTS_KEY:null});
  reportsDay=day;reportsDirty=false;if(r.pushed)console.log('[REPORTS] 결과 업로드',r.day);
 }catch(e){console.error('[REPORTS]',e.message)}finally{reportsBusy=false}
}
setInterval(()=>{void uploadReport()},15*60000).unref?.();setTimeout(()=>{void uploadReport(true)},90000).unref?.();
// Live trade notices to Telegram (live_telegram.mjs), on unless switched off in 알림 설정.
function liveTelegramNotice(record,type,detail){
 const text=liveEventText(record,type,detail);if(!text)return;
 // Open dashboards show it as a Chrome/system notification (public/app.js 'live-notice').
 try{send('live-notice',{type,symbol:record?.symbol??null,text,at:Date.now()})}catch{}
 if(persisted.notifySettings?.telegramLive===false||!CONFIG.tgToken||!CONFIG.tgChat)return;
 telegramPost({chat_id:CONFIG.tgChat,text}).then(r=>{if(!r.ok)console.error('[LIVE TELEGRAM] HTTP',r.status)}).catch(e=>console.error('[LIVE TELEGRAM]',e.message));
}
async function checkSoftwareUpdate(){
 if(updateCheckPromise)return updateCheckPromise;
 updateCheckPromise=(async()=>{
  if(!CONFIG.updateManifestURL){state.update={state:'unconfigured',lastCheck:Date.now(),message:'배포 서버 URL 미설정 — 자동 업데이트 비활성'};return state.update}
  const currentVersion=JSON.parse(fs.readFileSync(path.join(__dirname,'package.json'),'utf8')).version;
  state.update={...state.update,state:'checking',lastCheck:Date.now()};send('update',state.update);
  try{
   const result=await stageUpdate({root:__dirname,manifestURL:CONFIG.updateManifestURL,currentVersion});
   state.update={...result,lastCheck:Date.now(),message:result.state==='staged'?'업데이트 준비 완료 — 다음 실행 시 설치됩니다':result.state==='current'?'최신 버전입니다':result.state};
  }catch(e){state.update={state:'error',lastCheck:Date.now(),message:e.message};console.warn('[UPDATE]',e.message)}
  send('update',state.update);return state.update;
 })();
 try{return await updateCheckPromise}finally{updateCheckPromise=null}
}
const scannedSymbol=symbol=>state.activeSet.has(symbol)||state.researchSet.has(symbol)||state.venueOnlySet.has(symbol);
const venueOnlySymbol=symbol=>state.venueOnlySet.has(symbol)&&!state.activeSet.has(symbol);
// ---- Venue-only coins: chart, profile and volume from Gate.io (or BingX when Gate.io lacks it) ----
const venueKlineCache=new Map();
// Coins not on Binance: the BingX chart first (the venue that is traded), Gate.io only when enabled.
function chartVenueFor(symbol){const v=state.venueOnly.get(symbol)?.venues??[];return v.includes('BINGX')?'BINGX':v.includes('GATEIO')&&CONFIG.paperVenues.includes('GATEIO')?'GATEIO':null}
async function venueKlines(symbol,interval,limit){
 const venue=chartVenueFor(symbol);if(!venue)throw Error('VENUE_CHART_UNAVAILABLE');
 const key=`${venue}:${symbol}:${interval}:${limit}`,hit=venueKlineCache.get(key);
 if(hit&&hit.until>Date.now())return hit.pending??hit.rows;
 const ttl=interval==='4h'?170000:interval==='1h'?54000:20000;
 const pending=venueQuotes.clients[venue].klines(symbol,interval,limit);venueKlineCache.set(key,{pending,until:Date.now()+ttl});
 try{const rows=await pending;venueKlineCache.set(key,{rows,until:Date.now()+ttl});return rows}catch(e){venueKlineCache.delete(key);throw e}
}
function invalidateVenueCandles(symbol){for(const key of venueKlineCache.keys())if(key.split(':')[1]===symbol)venueKlineCache.delete(key)}
// Same profile rules as Binance; the collector's Binance-style URL is answered from the venue.
const venueKlineRequest=url=>{const q=new URL(url,'http://x').searchParams;return venueKlines(q.get('symbol'),q.get('interval'),Number(q.get('limit')))};
const venueProfiles=new VolumeProfileCollector({request:venueKlineRequest});
const venueZoneFallbacks=ZONE_FALLBACKS.map(f=>({...f,collector:new VolumeProfileCollector({request:venueKlineRequest,interval:f.interval,candles:f.candles,profileOptions:zoneFallbackOptions})}));
// CoinGecko public pages, spaced to stay under the free rate limit; reused for 6 hours and kept
// on disk (marketcaps.json in the data folder) so a restart or a later outage uses the last good
// list for up to 3 days. 429 (rate limit) waits and retries. COINGECKO_API_KEY (free demo key) is optional.
const marketCapFile=path.join(storage.dir,'marketcaps.json');
function loadMarketCapCache(){try{const d=JSON.parse(fs.readFileSync(marketCapFile,'utf8'));if(Array.isArray(d.pages)&&Number.isFinite(d.at))return {caps:parseMarketCaps(d.pages),at:d.at}}catch{}return null}
async function fetchCoinGeckoPage(page){
 const headers={Accept:'application/json','User-Agent':'SignalLab/1.0'};if(process.env.COINGECKO_API_KEY)headers['x-cg-demo-api-key']=process.env.COINGECKO_API_KEY;
 for(let attempt=0;attempt<3;attempt++){
  const r=await fetch(`https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=250&page=${page}`,{signal:AbortSignal.timeout(20000),headers});
  if(r.status===429&&attempt<2){await new Promise(res=>setTimeout(res,65000));continue}
  if(!r.ok)throw Error('CoinGecko HTTP '+r.status+(r.status===429?' (요청 한도 초과)':''));
  return r.json();
 }
}
async function refreshMarketCaps(){
 const mc=state.marketCaps;
 if(!mc.caps){const disk=loadMarketCapCache();if(disk)Object.assign(mc,disk)}
 if(mc.caps&&Date.now()-mc.at<6*3600000)return mc.caps;
 if(mc.error&&Date.now()-(mc.failedAt||0)<10*60000)return mc.caps&&Date.now()-mc.at<3*86400000?mc.caps:null;
 const pages=[];
 try{
  for(let page=1;page<=CONFIG.venueOnly.mcapPages;page++){
   if(page>1)await new Promise(r=>setTimeout(r,6000));
   const data=await fetchCoinGeckoPage(page);pages.push(data);if(!Array.isArray(data)||data.length<250)break;
  }
 }catch(e){mc.error=String(e.message||e);mc.failedAt=Date.now();console.warn('[MARKET CAP]',mc.error)}
 // Top 1000 (4 pages) is enough to judge "not absurdly small"; fewer pages is not used.
 if(pages.length>=Math.min(4,CONFIG.venueOnly.mcapPages)||pages.length&&!mc.error){
  state.marketCaps={caps:parseMarketCaps(pages),at:Date.now(),error:'',failedAt:0,pages:pages.length};
  try{fs.writeFileSync(marketCapFile+'.tmp',JSON.stringify({at:Date.now(),pages}));fs.renameSync(marketCapFile+'.tmp',marketCapFile)}catch{}
  return state.marketCaps.caps;
 }
 return mc.caps&&Date.now()-mc.at<3*86400000?mc.caps:null;
}
async function refreshVenueOnlyList(){
 if(!CONFIG.venueOnly.enabled||!state.activeSymbols.length)return;
 if(Date.now()-state.venueOnlyInfo.at<(state.venueOnlyInfo.error?60000:10*60000))return;
 try{
  const gateOn=CONFIG.paperVenues.includes('GATEIO');
  const [gc,bc,gt,bt]=await Promise.all([gateOn?venueQuotes.clients.GATEIO.loadContracts():new Map(),venueQuotes.clients.BINGX.loadContracts(),
   gateOn?venueQuotes.clients.GATEIO.tickers():[],venueQuotes.clients.BINGX.tickers()]);
  // Without market caps nothing is added: a coin whose size cannot be checked is not traded.
  const caps=await refreshMarketCaps();if(!caps)throw Error('시총 자료(CoinGecko) 조회 실패 — 바이낸스 미상장 코인 보류: '+(state.marketCaps.error||'원인 미상'));
  const volumes=venueVolumes({gateTickers:gt,bingxTickers:bt});
  // Size is judged by MARKET CAP: the reference coins (AKEUSDT, JCTUSDT) are examples of the size
  // wanted, so the floor is VENUE_ONLY_REFERENCE_RATIO x the smaller reference market cap (never
  // below VENUE_ONLY_MIN_MARKET_CAP_USD). Volume only has to clear a tradable minimum (1M$).
  const refCaps=CONFIG.venueOnly.references.map(sym=>{const v=volumes.get(sym);return v?marketCapFor(sym,v.price,caps)?.marketCap:null}).filter(x=>x>0);
  const mcapFloor=Math.max(CONFIG.venueOnly.minMarketCap,refCaps.length?Math.min(...refCaps)*CONFIG.venueOnly.referenceRatio:0);
  const picked=selectVenueOnlyCoins({binanceSymbols:state.activeSymbols,contracts:{GATEIO:gc,BINGX:bc},volumes,minVolume:CONFIG.venueOnly.minVolume??1e6});
  const screened=screenByMarketCap(picked.coins,caps,{minMarketCap:mcapFloor,maxVolumeToCap:CONFIG.venueOnly.maxVolumeToCap});
  const coins=screened.kept.slice(0,CONFIG.venueOnly.max);
  const dropped=screened.dropped.reduce((m,c)=>(m[c.reason]=(m[c.reason]||0)+1,m),{});
  state.venueOnly=new Map(coins.map(c=>[c.symbol,{...c,priceAt:Date.now()}]));state.venueOnlySet=new Set(state.venueOnly.keys());
  state.venueOnlyInfo={at:Date.now(),threshold:picked.threshold,thresholdSource:'VOLUME_MIN',count:coins.length,error:'',
   beforeMarketCap:picked.coins.length,droppedByMarketCap:dropped,minMarketCap:mcapFloor,
   kept:coins.slice(0,60).map(c=>({symbol:c.symbol,marketCap:c.marketCap,quoteVolume:c.quoteVolume})),droppedSample:screened.dropped.slice(0,40).map(c=>({symbol:c.symbol,reason:c.reason,marketCap:c.marketCap,quoteVolume:c.quoteVolume})),marketCapSource:refCaps.length?'REFERENCE':'MINIMUM',referenceCaps:refCaps};
  console.log(`[VENUE-ONLY] ${coins.length}개 코인 (시총 ≥ ${(mcapFloor/1e6).toFixed(1)}M$ ${refCaps.length?'= 기준 코인 시총 '+(Math.min(...refCaps)/1e6).toFixed(1)+'M$ × '+CONFIG.venueOnly.referenceRatio:'(기준 코인 시총 미확인 → 최소값)'}, 24h 거래대금 ≥ ${(picked.threshold/1e6).toFixed(1)}M$; 제외: 시총 미확인 ${dropped.MCAP_UNKNOWN||0}·시총 부족 ${dropped.MCAP_TOO_SMALL||0}·거래대금 과다 ${dropped.VOLUME_TO_MCAP_TOO_HIGH||0})`);
 }catch(e){state.venueOnlyInfo={...state.venueOnlyInfo,at:Date.now(),error:String(e.code||e.message)};console.warn('[VENUE-ONLY]',e.code||e.message)}
}
let venueOnlyScanActive=false;
async function runVenueOnlyScan(){
 if(!CONFIG.venueOnly.enabled||venueOnlyScanActive)return;venueOnlyScanActive=true;
 try{
  await refreshVenueOnlyList();
  const list=[...state.venueOnlySet];if(!list.length)return;
  // Every coin is re-checked within about 40 minutes (a confirmed 1H pattern stays valid 75 minutes).
  const batch=Math.min(list.length,Math.max(CONFIG.venueOnly.batch,Math.ceil(list.length/40)));
  for(let j=0;j<batch;j++){
   const symbol=list[(state.venueOnlyCursor+j)%list.length];
   try{await checkSymbol(symbol)}catch(e){state.venueOnlyInfo.error=`${symbol}: ${e.code||e.message}`}
  }
  state.venueOnlyCursor=(state.venueOnlyCursor+batch)%list.length;
 }finally{venueOnlyScanActive=false}
}
const analyzing=new Set();
const pendingAnalyses=new Map();
async function checkSymbol(symbol, force=false){
 const existing=pendingAnalyses.get(symbol);
 if(existing){
  if(!force)return existing;
  // Closing candle events must not be silently discarded during a periodic scan.
  try{await existing}catch{}
 }
 // Invalidate after the older request finishes; it must not repopulate stale cached candles.
 if(force){invalidateCandles(symbol);invalidateBtc4hIfStale()}
 const task=checkSymbolInternal(symbol,force);
 pendingAnalyses.set(symbol,task);analyzing.add(symbol);
 try{return await task}finally{
  if(pendingAnalyses.get(symbol)===task){pendingAnalyses.delete(symbol);analyzing.delete(symbol)}
 }
}
async function checkSymbolInternal(symbol, force=false){
 if(!scannedSymbol(symbol))return null;
 const venueOnly=venueOnlySymbol(symbol),chartVenue=venueOnly?chartVenueFor(symbol):'BINANCE';
 if(venueOnly&&force)invalidateVenueCandles(symbol);
 const meta=venueOnly?{...state.venueOnly.get(symbol),filters:{PRICE_FILTER:{tickSize:venueEntry(chartVenue,symbol).contract?.tickSize}}}:state.quotes.get(symbol)||{};
 const bars=venueOnly?(interval,limit)=>venueKlines(symbol,interval,limit):(interval,limit)=>klines(symbol,interval,limit);
 const [h1,h4,btcH4]=await Promise.all([bars('1h',200),bars('4h',301),symbol==='BTCUSDT'?Promise.resolve(null):klines('BTCUSDT','4h',301)]);
 if(venueOnly){const last=h1?.at(-1);if(last)meta.price=Number(last[4])}
 const out=analyze(symbol,h1,h4,[],meta.price,{quoteVolume:meta.quoteVolume,priceChangePercent:meta.change,btcH4Rows:btcH4??h4});
 out.analysisVenue=chartVenue;out.venueOnly=venueOnly;out.tradeApproval=false;out.scorePolicy=getSignalScorePolicy();
 // Market cap (CoinGecko) feeds the leverage rule: bigger coins get more leverage.
 {const caps=state.marketCaps.caps,cap=Number(meta.marketCap)>0?Number(meta.marketCap):caps?marketCapFor(symbol,meta.price,caps)?.marketCap:null;if(cap>0)out.marketCap=cap}
 if(out.pattern&&out.technicalQualified===true){
  try{
   // Binance = chart analysis. Size and entry come from the execution venue (BingX / Gate.io).
   const chartTick=Number(meta.filters?.PRICE_FILTER?.tickSize);
   await Promise.all(CONFIG.paperVenues.map(venue=>refreshVenueBook(venue,symbol,{maxAgeMs:3000})));
   const selection=selectExecutionVenue({signal:out,venues:Object.fromEntries(CONFIG.paperVenues.map(v=>[v,venueEntry(v,symbol)])),
    allowed:CONFIG.paperVenues,maxRiskUSD:CONFIG.maxRiskUSD});
   out.venueCandidates=selection.candidates;
   const chosen=selection.chosen,estimate=chosen?.estimate??{eligible:false,reasons:['EXECUTION_VENUE_UNAVAILABLE']};
   out.venueExecution=estimate;
   if(chosen){
    const contract=venueEntry(chosen.venue,symbol).contract;
    out.executionVenue=chosen.venue;out.venueSymbol=contract.venueSymbol;
    out.venueContract={tickSize:contract.tickSize,quantityStep:contract.quantityStep,quantityUnit:contract.quantityUnit,contractSizeBase:contract.contractSizeBase,minQuantityBase:contract.minQuantityBase,minNotionalUSDT:contract.minNotionalUSDT??null,
     decimalSizes:contract.decimalSizes===true,decimalStepFallback:contract.decimalStepFallback===true,contractStep:contract.contractStep??null};
    out.rawStop=out.stop;out.stop=chosen.stop;
    // Other venues that list the coin and could take the same entry: the live order goes there when
    // the paper venue has no live keys (routeLiveSignal).
    out.liveAlternatives=selection.candidates.filter(c=>c.eligible&&c.venue!==chosen.venue).map(c=>{const k=venueEntry(c.venue,symbol).contract;
     return {venue:c.venue,venueSymbol:k.venueSymbol,entryBasis:c.entryBasis,quantity:c.quantity,estimatedStopLossUSD:c.estimatedStopLossUSD,spreadBps:c.spreadBps,quotedAt:Date.now(),venueContract:{tickSize:k.tickSize,quantityStep:k.quantityStep,quantityUnit:k.quantityUnit,contractSizeBase:k.contractSizeBase,minQuantityBase:k.minQuantityBase,minNotionalUSDT:k.minNotionalUSDT??null,
      decimalSizes:k.decimalSizes===true,decimalStepFallback:k.decimalStepFallback===true,contractStep:k.contractStep??null}}});
   }
   if(estimate.eligible&&Number.isFinite(chartTick)&&chartTick>0){
    const contract=venueEntry(chosen.venue,symbol).contract;
    out.venueOrder=venueOrderQuantity(contract,estimate.quantity);
    // The profile is built from Binance trades on Binance's tick grid; targets use the venue tick.
    const profileResult=await (venueOnly?venueProfiles:profiles).get(symbol,{tickSize:chartTick,eligible:true}),costs=venueCosts(contract,estimate.spreadBps);
    const targetPlan=planVolumeTargets({profileResult,direction:out.direction,entry:estimate.entryBasis,stop:out.stop,quantity:estimate.quantity,
     tickSize:estimate.tickSize,quantityStep:estimate.quantityStep,minQuantity:estimate.minQuantity,minNotional:estimate.minNotional,
     contractSizeBase:1,quantityUnit:'BASE_ASSET',notionalCurrency:'USDT',unitsVerified:true,costs,minNetRR:1.8,targetMode:CONFIG.targetMode,obstacleFraction:CONFIG.targetObstacleFraction},{now:Date.now()});
    out.targetPlan={...targetPlan,quantity:estimate.quantity,quantityUnit:'BASE_ASSET',notionalCurrency:'USDT',
     minNotional:estimate.minNotional,minQuantity:estimate.minQuantity,quantityStep:estimate.quantityStep,tickSize:estimate.tickSize,costAssumptions:costs,
     // Diagnostics only: keep the collector's own reason, which planVolumeTargets wraps as VOLUME_PROFILE_NOT_AVAILABLE.
     ...(targetPlan.ok?{}:{profileReasons:Array.isArray(profileResult?.reasons)?profileResult.reasons.slice(0,6):[]})};
    if(targetPlan.ok){out.referenceEntry=out.entry;out.entry=estimate.entryBasis;[out.target1,out.target2,out.target3]=targetPlan.targets;out.targets=targetPlan.targets;
     // Paper only: adds at volume zones before the stop (one trade per setup, same worst-case loss).
     if(CONFIG.stopZoneAdds){
      // Zones: the 3-day profile plus the deeper 15m window (Binance coins; venue-only coins use the 3-day one).
      const deep=!venueOnly&&CONFIG.dcaZoneDays>3?await deepProfiles.get(symbol,{tickSize:chartTick,eligible:true}).catch(()=>null):null;
      const toZones=list=>list.slice(0,60).map(z=>({priceLow:z.priceLow,priceHigh:z.priceHigh}));
      const zoneSets=[{label:'15분봉 '+(deep?.ok?`3일+${CONFIG.dcaZoneDays}일`:'3일'),zones:toZones([...(profileResult?.profile?.hvn||[]),...(deep?.ok?deep.profile.hvn:[])])}];
      out.paperAddInputs={zoneSets,atr:Number(out.atr)||0,tickSize:estimate.tickSize,quantityStep:estimate.quantityStep,minQuantity:estimate.minQuantity,minNotional:estimate.minNotional,takerRate:costs.takerRate};
      // No zone fits: change the timeframe (1h, then 4h) until one does.
      let preview=TREND_GATE_PATTERNS.includes(out.pattern)?null:zoneScaleInPlan(out,1);
      for(const f of venueOnly?venueZoneFallbacks:binanceZoneFallbacks){
       if(preview||TREND_GATE_PATTERNS.includes(out.pattern))break;
       const r=await f.collector.get(symbol,{tickSize:chartTick,eligible:true}).catch(()=>null);
       if(!r?.ok||!r.profile?.hvn?.length)continue;
       zoneSets.push({label:f.label,zones:toZones(r.profile.hvn)});preview=zoneScaleInPlan(out,1);
      }
      if(preview)out.paperAddsPreview={unitQty:preview.dca.unitQty,adds:preview.dca.adds.length,fullQty:preview.dca.full.quantity,stop:preview.dca.stop,zoneSource:preview.zoneSource};
     }}
   }
   else if(!chosen)out.targetPlan={ok:false,code:'TP_PROFILE_UNAVAILABLE',reasons:['EXECUTION_VENUE_UNAVAILABLE']};
  }catch{out.targetPlan={ok:false,code:'TP_PROFILE_UNAVAILABLE',reasons:['PUBLIC_EXECUTION_OR_PROFILE_UNAVAILABLE']};}
 }

 // 1H closed-candle pattern and 4H trend are already validated in analyze().
 // No shorter than 1H timeframe is queried or required for a confirmed setup.
 out.confirmedTimeframes=['1h','4h'];
 // Historical/approaching observations never affect actual signals, alerts or simulated PNL.
 // Browser and Telegram both receive final signals only.
 if(!scannedSymbol(symbol))return null;
 const decision=assessAnalysis(out);
 out.execution=decision.execution;out.decision=decision;
 out.qualified=decision.ready;
 if(out.pattern)out.status=decision.ready?'signal':'watch';
 out.executionStatus=decision.execution.eligible?'호가·비용 기준 통과':'실매매 검증 보류';
 if(decision.execution.eligible){
  const e=decision.execution;
  out.risk={...(out.risk||{}),nominal:e.notional,margin:e.notional/(out.risk?.leverage||3),riskUSD:e.estimatedStopLossUSD,costUSD:e.spreadCostUSD};
 }
 if(decision.technical&&!decision.venue){state.blockedSignals++;state.lastBlockReason=decision.reasons.join(' / ')}
 state.analyses.set(symbol,out);
 publishCryptoSignal(out,decision);
 return out;
}
// Re-quote the live alternatives of a signal (other venues than the paper one) with their
// current books: same selection rule as the analysis, only for the venues already listed.
async function freshLiveAlternatives(row){
 const alts=row.liveAlternatives||[];if(!alts.length||!row.rawStop)return alts;
 const keys=live.credentials(),wanted=alts.filter(a=>LIVE.venues.includes(a.venue)&&keys[a.venue]);if(!wanted.length)return alts;
 await Promise.all(wanted.map(a=>refreshVenueBook(a.venue,row.symbol,{maxAgeMs:3000})));
 const selection=selectExecutionVenue({signal:{...row,stop:row.rawStop},venues:Object.fromEntries(wanted.map(a=>[a.venue,venueEntry(a.venue,row.symbol)])),
  allowed:wanted.map(a=>a.venue),maxRiskUSD:CONFIG.maxRiskUSD});
 return alts.map(a=>{const c=selection.candidates.find(x=>x.venue===a.venue);
  return c?.eligible?{...a,entryBasis:c.entryBasis,quantity:c.quantity,estimatedStopLossUSD:c.estimatedStopLossUSD,spreadBps:c.spreadBps,quotedAt:Date.now()}:{...a,quotedAt:null}});
}
function publishCryptoSignal(row,decision,now=Date.now()){
 if(!decision.ready||!storageHealth.healthy)return;
 // Observe the validated scanner output, but never route actual market data to
 // the offline simulation engine or alter the existing paper registration.
 const {symbol,direction,pattern}=row;
 const paperKey=signalKey({market:'CRYPTO',symbol,direction,pattern,barAt:row.patternConfirmedAt});
 // Study-material patterns keep their pattern stop: no zone adds (paper and live).
 const noAdds=TREND_GATE_PATTERNS.includes(row.pattern);
 // Live / testnet: every still-valid approval (fresh 1H bar, price inside the entry range) is
 // offered while the executor is armed, not only the first publication. So arming (or a restart)
 // trades the signals of the current hour right away; each signal is still ordered at most once.
 // Bounded like the paper entry: at most PAPER_DEFAULTS.entryTimeoutMs (20 min) after the 1H close
 // (the backtest enters on the first 5m candle; later entries are not validated).
 const liveWindow=Number.isFinite(row.patternConfirmedAt)&&now-row.patternConfirmedAt<=PAPER_DEFAULTS.entryTimeoutMs;
 // Coins not on Binance (BingX chart) were never part of the validated backtest: testnet only.
 if(LIVE.mode!=='OFF'&&(!row.venueOnly||LIVE.mode==='TESTNET')&&live.armed&&liveWindow&&!live.hasSignal(paperKey)&&live.canTry(paperKey))
  void (async()=>{
   // Only when the paper venue has no live keys, the other venues' quotes are refreshed so the
   // signal can be routed (routeLiveSignal needs a quote at most 15 s old).
   const keys=live.credentials(),needRoute=!(LIVE.venues.includes(row.executionVenue)&&keys[row.executionVenue]);
   const fresh=needRoute?await freshLiveAlternatives(row).catch(()=>row.liveAlternatives):row.liveAlternatives;
   // The approval is re-assessed after the wait: an approval that went stale meanwhile is not ordered.
   const now2=Date.now(),current=assessAnalysis(row,now2);
   if(!current.ready||now2-row.patternConfirmedAt>PAPER_DEFAULTS.entryTimeoutMs)return;
   return live.onSignal(routeLiveSignal({...row,liveAlternatives:fresh,...(noAdds?{paperAddInputs:null}:{}),decision:current,execution:current.execution},{enabled:LIVE.venues,credentials:keys,now:now2}),{signalKey:paperKey});
  })().catch(e=>console.error('[LIVE]',e.message));
 // The same fresh approval may be observed by a scan and many ticker events.
 // Persist each paper registration and alert once, including after a restart.
 if(CONFIG.paperTrading&&!paper.store.seen[paperKey]){
  const sizeScale=nextSizeScale(paper.store),adds=noAdds?null:zoneScaleInPlan(row,sizeScale);
  paper.register(adds?{...row,stop:adds.dca.stop,targetPlan:adds.targetPlan,dca:adds.dca,sizeScale,leverage:adds.leverage}:row,{market:'CRYPTO',symbol,quoteEligible:true});
 }
 const key=`${symbol}:${direction}:${pattern}:${row.time}`;
 if(persisted.seen[key])return;
 const item={...row,decision,execution:decision.execution,qualified:true,status:'signal',id:key};
 save({...persisted,seen:{...persisted.seen,[key]:now},alerts:[item,...persisted.alerts]});
 send('alert',item);void tgNotify(item);
 console.log('[SIGNAL]',symbol,direction,pattern,row.score);
}
// Paper 1H position as one split-buy trade: entry 1 unit, then adds of 1, 2, 4 ... units at the
// volume zones against the position (HOURLY_MAX_ADDS, 5-10, default 7), and the stop BEYOND the last add
// (planZoneDca, the same rule as the scalps). Unit = balance x DCA_UNIT_PCT x leverage, where the
// leverage comes from the score and market cap; the margin / liquidation / max-loss checks of
// planZoneDca apply. Null when no zone fits: the position then uses the pattern stop as before.
// Paper account (cross margin): PAPER_BALANCE_USD plus every realized paper result.
function paperAccountBalance(){return CONFIG.paperBalanceUSD+(paper.store.closed||[]).reduce((s,x)=>s+(Number(x.realizedPnLUSD)||0),0)}
function zoneScaleInPlan(row,sizeScale){
 const inp=row.paperAddInputs;if(!inp||!row.targetPlan?.ok)return null;
 const leverage=leverageForScore(row.score,row.marketCap)??10;
 const balanceUSD=paperAccountBalance();
 // Zone sets in timeframe order (15m, then the 1h / 4h fallbacks); the first that gives an add wins.
 for(const set of inp.zoneSets||[{label:'15분봉',zones:inp.zones||[]}]){
  const dca=planZoneDca({direction:row.direction,entry:row.entry,atr:inp.atr,zones:set.zones,balanceUSD,leverage,unitPct:CONFIG.dcaUnitPct*sizeScale,
   tickSize:inp.tickSize,quantityStep:inp.quantityStep,minQuantity:inp.minQuantity,minNotional:inp.minNotional,takerRate:inp.takerRate,
   settings:{maxLossPct:CONFIG.dcaMaxLossPct,maxAdds:CONFIG.hourlyMaxAdds}});
  if(!dca.ok||!dca.adds.length)continue;
  const targetPlan=planWithQuantity(row.targetPlan,dca.unitQty);if(!targetPlan)continue;
  return {targetPlan,dca:{...dca,zoneSource:set.label},leverage,zoneSource:set.label};
 }
 return null;
}
// Event-driven scanner. The global mini-ticker stream supplies fast price updates;
// per-symbol 1H + 4H kline close streams trigger re-analysis at candle completion.
// Historical candles remain REST snapshots, not tick-perfect.
const liveQueue=[];const queued=new Set();const lastTrigger=new Map();let liveWorkers=0;
const liveSockets=[];let liveSubscriptionKey='';let streamRequestId=1;
// BTC 4H (the long filter and score context) must not come from a cache taken before the last 4H
// close: drop it once the newest cached bar has closed, so the closed bar is read again.
function invalidateBtc4hIfStale(now=Date.now()){const key='/fapi/v1/klines?symbol=BTCUSDT&interval=4h&limit=301',rows=apiCache.get(key)?.data;
 if(Array.isArray(rows)&&Number(rows.at(-1)?.[6])<now)apiCache.delete(key)}
function invalidateCandles(symbol){for(const interval of ['1h','4h'])for(const suffix of [150,110,100,200,301])apiCache.delete(`/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${suffix}`)}
function queueLive(symbol,reason='stream'){
 if(!state.activeSet.has(symbol)&&!state.researchSet.has(symbol))return false;
 const candleClose=reason.endsWith('-close');
 if(queued.has(symbol)){
   if(candleClose){const existing=liveQueue.find(q=>q.symbol===symbol);if(existing)existing.reason=reason}
   return false;
 }
 if(liveQueue.length>=500){
   if(!candleClose)return false;
   const drop=liveQueue.findIndex(x=>!x.reason.endsWith('-close'));
   if(drop<0)return false;
   queued.delete(liveQueue[drop].symbol);liveQueue.splice(drop,1);
 }
 const now=Date.now(),limit=candleClose?0:30000;
 if(now-(lastTrigger.get(symbol)||0)<limit)return false;
 lastTrigger.set(symbol,now);queued.add(symbol);liveQueue.push({symbol,reason});state.livePending=liveQueue.length;
 void drainLive();return true;
}
async function drainLive(){
 while(liveWorkers<3 && liveQueue.length){
  liveWorkers++;(async()=>{
   try{while(liveQueue.length){const item=liveQueue.shift();queued.delete(item.symbol);
    if(!state.activeSet.has(item.symbol)&&!state.researchSet.has(item.symbol))continue;
    try{const output=await checkSymbol(item.symbol,item.reason.includes('close'));if(output){state.liveAnalyzed++;state.lastLiveTrigger=Date.now()}else{state.liveLastError=item.symbol+': 분석 결과 없음'};
      send('live',{symbol:item.symbol,reason:item.reason,at:state.lastLiveTrigger,signals:relevantSignals(),patterns:[],watch:[]});
    }catch(e){console.warn('[LIVE]',item.symbol,item.reason,e.message)}
    await new Promise(r=>setTimeout(r,180));state.livePending=liveQueue.length;
   }}finally{liveWorkers--;if(liveQueue.length)void drainLive()}
  })();
 }
}
function priceLevelTrigger(symbol,prev,price){
 const analysis=state.analyses.get(symbol);
 if(!analysis||!Number.isFinite(prev)||!Number.isFinite(price)||price<=0||Date.now()-analysis.scannedAt>60*60000)return;
 const spots=[...(analysis.supports||[]),...(analysis.resistances||[])].map(x=>x.price).filter(x=>x>0);
 // Near/through a previously inferred level, *not* a standalone trading signal.
 const relevant=spots.some(level=>(prev-level)*(price-level)<=0 || Math.abs(price-level)/level<0.0012 && Math.abs(prev-price)/level>=0.00035);
 if(relevant)queueLive(symbol,'price-level');
}
function refreshLiveSubscriptions(){
 const monitored=state.activeSymbols;
 if(!monitored.length){for(const ws of liveSockets){try{ws.close()}catch{}}liveSockets.length=0;liveSubscriptionKey='';state.liveWS='offline';state.liveWatched=0;return}
 const streams=[...monitored.map(s=>s.toLowerCase()+'@kline_1h'),...monitored.map(s=>s.toLowerCase()+'@kline_4h')];
 const key=streams.join('|');if(key===liveSubscriptionKey&&liveSockets.some(ws=>ws.readyState===WebSocket.OPEN))return;
 liveSubscriptionKey=key;for(const ws of liveSockets){try{ws.close()}catch{}}liveSockets.length=0;
 state.liveWS='connecting';state.liveWatched=streams.length;state.liveSubscribeAcks=0;state.liveSubscribeErrors=0;state.lastLiveDataAt=0;
 const groups=[];for(let i=0;i<streams.length;i+=450)groups.push(streams.slice(i,i+450));
 for(const group of groups){
  const ws=new WebSocket('wss://fstream.binance.com/market/stream');liveSockets.push(ws);
  ws.addEventListener('open',()=>{if(!liveSockets.includes(ws))return;state.liveWS='connecting';send('status',getStatus());
   // 50 stream subscriptions per control message, spaced to avoid inbound rate limits.
   group.forEach((_,idx)=>{if(idx%50)return;const chunk=group.slice(idx,idx+50);
    setTimeout(()=>{if(ws.readyState===WebSocket.OPEN)ws.send(JSON.stringify({method:'SUBSCRIBE',params:chunk,id:String(streamRequestId++)}))},Math.floor(idx/50)*230);
   });
  });
  ws.addEventListener('message',e=>{try{
   const raw=JSON.parse(e.data);
   if(Object.prototype.hasOwnProperty.call(raw,'result') && raw.id){
    if(raw.result===null)state.liveSubscribeAcks++;
    else{state.liveSubscribeErrors++;state.liveLastError='구독 거절: '+JSON.stringify(raw).slice(0,160)}
    send('status',getStatus());return;
   }
   if(raw.code || raw.error){state.liveSubscribeErrors++;state.liveLastError=JSON.stringify(raw).slice(0,170);send('status',getStatus());return}
   const msg=raw.data||raw,k=msg.k;
   if(msg.e!=='kline'||!k||!monitored.includes(msg.s)||Number(msg.st||1)!==1)return;
   state.lastLiveDataAt=Date.now();state.liveWS='connected';
   if(!k.x)return;
   state.lastLiveCandleClose=Date.now();
   const interval=k.i;if(interval==='1h'||interval==='4h')queueLive(msg.s,interval+'-close');
   send('status',getStatus());
  }catch(err){state.liveLastError='실시간 봉 수신 오류: '+err.message}});
  ws.addEventListener('close',()=>{if(!liveSockets.includes(ws))return;state.liveWS='offline';send('status',getStatus());
   setTimeout(()=>{if(liveSubscriptionKey===key)recoverLive()},4000);
  });
  ws.addEventListener('error',()=>{state.liveWS='offline';send('status',getStatus())});
 }
}
// A connected socket alone is not proof of live candle events; recover a silent feed.
setInterval(()=>{
 if(!state.activeSet.size&&!state.researchSet.size||!liveSockets.some(ws=>ws.readyState===WebSocket.OPEN))return;
 const last=state.lastLiveDataAt||state.lastMarketListings;
 if(last&&Date.now()-last>90000){state.liveWS='offline';state.liveLastError='봉 데이터 90초 이상 미수신 · 재구독';console.warn('[LIVE] No candle data received, resubscribing');recoverLive();send('status',getStatus())}
},30000);
// Force rebuilding of sockets after an unexpected close. Does not affect symbol validation.
const _refreshSubscriptions=refreshLiveSubscriptions;
function recoverLive(){if(state.activeSet.size||state.researchSet.size){liveSubscriptionKey='';_refreshSubscriptions()}}

let marketWs, retryMs=1500; const changed=new Map();
function cryptoEntryAllowed(symbol,now=Date.now()){
 if(!storageHealth.healthy||!scannedSymbol(symbol)||state.rest!=='connected')return false;
 // A scalp entry is approved by its own 5m detection; it lives until its short expiry.
 // (Paper off: a stored scalp entry no longer holds the symbol.)
 const scalpPending=CONFIG.paperTrading&&paper.store.pending.find(x=>x.market==='CRYPTO'&&x.symbol===symbol&&isScalpStrategy(x.strategy));
 if(scalpPending)return now<=scalpPending.expiresAt;
 const analysis=state.analyses.get(symbol);
 if(!analysis?.patternConfirmed||!analysis.technicalQualified)return false;
 const decision=assessAnalysis(analysis,now);
 // An analysis can precede its first live price. Publish when the complete
 // approval becomes ready; registering on this tick still requires a later tick
 // for the fill, as enforced by PaperEngine's signalAt guard.
 publishCryptoSignal(analysis,decision,now);
 const pending=paper.store.pending.filter(x=>x.market==='CRYPTO'&&x.symbol===symbol);
 // An entry approval belongs to this exact completed candle/pattern. Do not
 // reuse approval for another analysis, or after its public quote has expired.
 if(pending.length!==1||analysis.pattern!==pending[0].pattern||analysis.direction!==pending[0].direction||
  analysis.patternConfirmedAt!==pending[0].barAt)return false;
 return decision.ready;
}
// ---- 5m reversal scalp mode (paper only) ----
const moveTracker=new MoveTracker();
const scalpState={enabled:CONFIG.scalpMode&&CONFIG.paperTrading,mode:'PAPER_ONLY',minMovePct:CONFIG.scalpMinMovePct,dca:{enabled:CONFIG.dcaMode,leverage:CONFIG.dcaLeverage,unitPct:CONFIG.dcaUnitPct,maxLossPct:CONFIG.dcaMaxLossPct,maxAdds:CONFIG.dcaMaxAdds,zoneDays:CONFIG.dcaZoneDays,paperBalanceUSD:CONFIG.paperBalanceUSD,marginMode:'CROSS'},lastRunAt:0,lastCandidates:[],checks:0,signals:[],recentRejects:[],error:''};
const scalpChecked=new Map(); // symbol -> last evaluated candle close time
let scalpActive=false;
async function runScalpCheck(now=Date.now()){
 if(!scalpState.enabled||scalpActive||state.rest!=='connected'||!storageHealth.healthy)return;
 scalpActive=true;
 try{
  // One job per (symbol, timeframe): the symbol moved at least that timeframe's move size within its window.
  const busySymbol=symbol=>paper.store.open.some(x=>x.symbol===symbol)||paper.store.pending.some(x=>x.symbol===symbol);
  const jobs=[];
  for(const interval of CONFIG.scalpIntervals){
   const tf=SCALP_TIMEFRAMES[interval],minMovePct=interval==='5m'?CONFIG.scalpMinMovePct:tf.minMovePct,bucket=Math.floor(now/tf.intervalMs);
   for(const c of moveTracker.candidates({now,windowMs:(SCALP_DEFAULTS.moveWindow+1)*tf.intervalMs,minMovePct,limit:CONFIG.scalpMaxChecks}))
    if(state.activeSet.has(c.symbol)&&!busySymbol(c.symbol)&&scalpChecked.get(c.symbol+':'+interval)!==bucket)jobs.push({...c,interval,minMovePct,bucket});
  }
  const candidates=jobs.sort((a,b)=>b.movePct-a.movePct).slice(0,CONFIG.scalpMaxChecks);
  scalpState.lastRunAt=now;scalpState.lastCandidates=candidates.map(c=>({symbol:c.symbol,interval:c.interval,movePct:Number(c.movePct.toFixed(2))}));
  for(const {symbol,interval,minMovePct,bucket} of candidates){
   if(busySymbol(symbol))continue;
   scalpChecked.set(symbol+':'+interval,bucket);scalpState.checks++;
   let rows;try{rows=await binance(`/fapi/v1/klines?symbol=${encodeURIComponent(symbol)}&interval=${interval}&limit=60`,20000)}catch(e){scalpState.error=e.message;continue}
   const det=detectScalpReversal(rows,{symbol,now:Date.now(),interval,settings:{minMovePct}});
   const reject=(reasons,extra={})=>{scalpState.recentRejects=[{at:Date.now(),symbol,interval,direction:det.direction??null,reasons,...extra},...scalpState.recentRejects].slice(0,20)};
   if(!det.ok){reject(det.reasons,{evidence:det.evidence});continue}
   if(CONFIG.scalpTrendFilter){
    let trend=null;try{trend=fourHourTrend(await klines(symbol,'4h',301),Date.now())}catch{}
    if(!trendAllows(det.direction,trend)){reject([trend===null?'TREND_4H_UNAVAILABLE':'AGAINST_4H_TREND_'+trend.toUpperCase()]);continue}
   }
   await Promise.all(CONFIG.paperVenues.map(venue=>refreshVenueBook(venue,symbol,{maxAgeMs:3000})));
   const signal={symbol,direction:det.direction,entry:det.entry,stop:det.stop,atr:det.atr},sizeScale=nextSizeScale(paper.store);
   const selection=selectExecutionVenue({signal,venues:Object.fromEntries(CONFIG.paperVenues.map(v=>[v,venueEntry(v,symbol)])),allowed:CONFIG.paperVenues,maxRiskUSD:CONFIG.maxRiskUSD*sizeScale});
   const chosen=selection.chosen;
   if(!chosen){reject(['EXECUTION_VENUE_UNAVAILABLE',...selection.candidates.flatMap(c=>c.reasons).slice(0,4)]);continue}
   const contract=venueEntry(chosen.venue,symbol).contract,costs=venueCosts(contract,chosen.estimate.spreadBps);
   // Signal quality is judged with the reversal stop; with scale-in the stop moves to the zones.
   const quality=buildScalpPlan({signal:{...det,stop:chosen.stop},estimate:chosen.estimate,costs});
   if(!quality.ok){reject(quality.reasons);continue}
   let plan=quality,dca=null,stop=chosen.stop;
   if(CONFIG.dcaMode){
    const chartTick=Number(state.quotes.get(symbol)?.filters?.PRICE_FILTER?.tickSize);
    const profile=Number.isFinite(chartTick)&&chartTick>0?await profiles.get(symbol,{tickSize:chartTick,eligible:true}):null;
    if(!profile?.ok){reject(['DCA_VOLUME_PROFILE_UNAVAILABLE',...(profile?.reasons??[]).slice(0,3)]);continue}
    // Deeper zones are optional: if that fetch fails the plan uses the 3-day zones only.
    const deep=dcaZoneDaysFor(interval,CONFIG.dcaZoneDays)>3?await deepProfiles.get(symbol,{tickSize:chartTick,eligible:true}):null;
    const zones=[...profile.profile.hvn,...(deep?.ok?deep.profile.hvn:[])];
    const balanceUSD=paperAccountBalance();
    dca=planZoneDca({direction:det.direction,entry:chosen.estimate.entryBasis,atr:det.atr,zones,balanceUSD,leverage:CONFIG.dcaLeverage,unitPct:CONFIG.dcaUnitPct*sizeScale,
     tickSize:chosen.estimate.tickSize,quantityStep:chosen.estimate.quantityStep,minQuantity:chosen.estimate.minQuantity,minNotional:chosen.estimate.minNotional,takerRate:costs.takerRate,
     settings:{maxLossPct:CONFIG.dcaMaxLossPct,maxAdds:CONFIG.dcaMaxAdds}});
    if(!dca.ok){reject(dca.reasons);continue}
    stop=dca.stop;
    plan=buildScalpPlan({signal:{...det,stop},estimate:{...chosen.estimate,quantity:dca.unitQty},costs,minNetRR:0});
    if(!plan.ok){reject(plan.reasons);continue}
   }
   const row={symbol,direction:det.direction,pattern:det.pattern,entry:chosen.estimate.entryBasis,stop,atr:det.atr,patternConfirmedAt:det.barAt,...(dca?{dca}:{}),
    managementVersion:'VOLUME_PROFILE_V1',targetPlan:plan,targets:plan.targets,strategy:det.strategy,sizeScale,leverage:CONFIG.dcaLeverage,evidence:det.evidence,
    entryTimeoutMs:det.entryTimeoutMs,maxHoldMs:det.maxHoldMs,executionVenue:chosen.venue,venueSymbol:contract.venueSymbol,
    venueContract:{tickSize:contract.tickSize,quantityStep:contract.quantityStep,quantityUnit:contract.quantityUnit,contractSizeBase:contract.contractSizeBase,minQuantityBase:contract.minQuantityBase,minNotionalUSDT:contract.minNotionalUSDT??null,
     decimalSizes:contract.decimalSizes===true,decimalStepFallback:contract.decimalStepFallback===true,contractStep:contract.contractStep??null}};
   const accepted=paper.register(row,{market:'CRYPTO',symbol,quoteEligible:true});
   const item={at:Date.now(),symbol,interval,direction:det.direction,pattern:det.pattern,venue:chosen.venue,entry:row.entry,stop:row.stop,targets:plan.targets,
    netRR:Number(quality.estimatedNetRR.toFixed(2)),evidence:det.evidence,paperAccepted:accepted,...(dca?{dca:{adds:dca.adds.map(a=>({price:a.price,units:a.units})),stop:dca.stop,maxLossUSD:dca.full.maxLossUSD,maxLossPct:dca.full.maxLossPct,liquidationPrice:dca.full.liquidationPrice,leverage:dca.leverage}}:{})};
   scalpState.signals=[item,...scalpState.signals].slice(0,30);
   if(accepted){send('scalp',item);console.log('[SCALP]',interval,symbol,det.direction,det.evidence.movePct+'%')}
   else reject(['PAPER_REJECTED:'+(paper.store.skipped.at(-1)?.reason||'unknown')]);
  }
 }catch(e){scalpState.error=e.message}
 finally{scalpActive=false}
}
// Scalps are paper-only: they run only with paper trading on.
if(scalpState.enabled)setInterval(()=>void runScalpCheck(),CONFIG.scalpIntervalMs).unref?.();
function connectWS(){
 let endpoint=0;let retryTimer=null;
 const urls=['wss://fstream.binance.com/market/ws/!miniTicker@arr','wss://fstream.binance.com/market/stream?streams=!miniTicker@arr'];
 function reconnect(ws,received){
  if(marketWs!==ws)return;
  state.ws='offline';send('status',getStatus());
  if(!received)endpoint=(endpoint+1)%urls.length;
  if(retryTimer)clearTimeout(retryTimer);
  retryTimer=setTimeout(start,Math.min(retryMs*=1.5,30000));
 }
 function start(){
  if(retryTimer){clearTimeout(retryTimer);retryTimer=null}
  if(marketWs){const previous=marketWs;marketWs=null;try{previous.close()}catch{}}
  state.ws='connecting';send('status',getStatus());
  let ws;
  try{ws=new WebSocket(urls[endpoint]);marketWs=ws}
  catch(e){state.ws='offline';state.error=e.message;retryTimer=setTimeout(start,Math.min(retryMs*=1.5,30000));return}
  let received=false,completed=false;
  ws.addEventListener('open',()=>{if(ws!==marketWs)return;state.ws='connecting';retryMs=1500;send('status',getStatus())});
  ws.addEventListener('message',e=>{
   if(ws!==marketWs)return;
   try{const payload=JSON.parse(e.data);const arr=Array.isArray(payload)?payload:(Array.isArray(payload.data)?payload.data:[]);
    let valid=0;
    for(const q of arr){
     const tracked=paper.store.open.some(x=>x.market==='CRYPTO'&&x.symbol===q.s)||paper.store.pending.some(x=>x.market==='CRYPTO'&&x.symbol===q.s);
     if(!q.s||!q.c||Number(q.st||1)!==1||!state.activeSet.has(q.s)&&!state.researchSet.has(q.s)&&!tracked)continue;
     const price=Number(q.c);if(!Number.isFinite(price)||price<=0)continue;
     const p=state.quotes.get(q.s)||{symbol:q.s},previous=p.price;p.price=price;p.priceAt=Date.now();
     // Keep Binance's source event clock next to the receipt time.
     p.exchangePriceAt=typeof q.E==='number'&&Number.isFinite(q.E)&&q.E>0?q.E:null;
     if(q.q)p.quoteVolume=Number(q.q);state.quotes.set(q.s,p);changed.set(q.s,[q.s,p.price,p.priceAt]);
     if(scalpState.enabled)moveTracker.record(q.s,price,p.priceAt);
     // The approval check also publishes final signals (and live entries) without paper trading.
     const entryAllowed=cryptoEntryAllowed(q.s,p.priceAt);
     if(CONFIG.paperTrading)paper.onPrice('CRYPTO',q.s,p.price,p.priceAt,{venue:'BINANCE',entryAllowed});priceLevelTrigger(q.s,previous,p.price);valid++;
    }
    if(valid){received=true;state.ws='connected';state.lastTickerAt=Date.now();state.lastTickerCount+=valid;send('status',getStatus())}
    else if(payload.code || payload.error)state.error='바이낸스 시세 스트림 오류: '+JSON.stringify(payload).slice(0,140);
   }catch(e){state.error='WebSocket 시세 응답 파싱 실패: '+e.message}
  });
  ws.addEventListener('close',()=>{if(completed)return;completed=true;reconnect(ws,received)});
  ws.addEventListener('error',()=>{if(ws!==marketWs)return;state.ws='offline';send('status',getStatus());try{ws.close()}catch{}});
 }
 start();
}
setInterval(()=>{if(changed.size){send('quotes',{t:Date.now(),data:[...changed.values()]});changed.clear()}},1300);
// A live TCP/WebSocket connection can remain open while its market feed has stalled.
// Reconnect rather than continuing to mark an idle feed as real-time.
setInterval(()=>{
 const tracking=paper.store.open.some(x=>x.market==='CRYPTO')||paper.store.pending.some(x=>x.market==='CRYPTO');
 if(!state.activeSet.size&&!state.researchSet.size&&!tracking||!marketWs||marketWs.readyState!==WebSocket.OPEN)return;
 if((state.lastTickerAt && Date.now()-state.lastTickerAt>90000)||(!state.lastTickerAt && marketWs.readyState===WebSocket.OPEN && (state.activeSymbols.length||state.researchSymbols.length||tracking) && Date.now()-state.lastMarket>90000)){
  state.ws='offline';state.error='실시간 유효 시세가 90초 이상 수신되지 않아 WebSocket을 재연결합니다';
  console.warn('[WEBSOCKET] Stale market feed; forcing reconnect');
  try{marketWs.close()}catch{};send('status',getStatus());
 }
},30000);
function getScanFunnel(){return describeScanFunnel(state.analyses,{activeSymbols:state.activeSymbols,researchSymbols:state.researchSymbols,assess:row=>assessAnalysis(row)});}
function getStatus(){return {scorePolicy:getSignalScorePolicy(),storage:{...storageHealth},version:'5.8.0',publicReadBudget:publicReadBudget.snapshot(),integrationVersion:'ISSUE6',sharedData:{dir:storage.dir,separateEnv:path.dirname(storage.envPath)!==storage.dir,pcs:sharedCheck.hosts.map(h=>({host:h.host,lastAt:h.lastAt,current:h.current})),conflicts:sharedCheck.conflicts,sharedEnvLeft:Boolean(storage.sharedEnvLeft)},venueOnly:{enabled:CONFIG.venueOnly.enabled,...state.venueOnlyInfo,referenceRatio:CONFIG.venueOnly.referenceRatio,references:CONFIG.venueOnly.references,symbols:[...state.venueOnlySet].slice(0,40)},live:{mode:LIVE.mode,armed:live.armed,killSwitch:live.store.killSwitch},paperTrading:CONFIG.paperTrading,paperVenues:CONFIG.paperVenues,venueRefreshAt:state.venueRefreshAt||0,venueError:state.venueError||'',chartReference:'BINANCE',analysisVenue:'BINANCE',actualOrdersEnabled:false,scanCoverage:{mode:'WATCHLIST_HOT_AND_ROTATING_BATCH',totalContracts:state.activeSymbols.length,hotBatch:CONFIG.hotBatch,rotatingBatch:CONFIG.rotatingBatch,intervalMs:CONFIG.scanMs,fourHourHistory:301,liveEventTimeframes:['1h','4h']},scanMode:state.scanMode,scanFunnel:getScanFunnel(),structureCount:recentStructures().length,historicalCount:recentHistory().length,researchCount:state.researchSymbols.length,verifiedAt:state.lastValidatedAt,rest:state.rest,ws:state.ws,binancePerps:state.binancePerps,error:state.error,activeCount:state.activeSymbols.length,scannedTotal:state.analyses.size,
 cycleScanned:state.cycleScanned,cycle:state.cycle,scannedSinceBoot:state.scannedSinceBoot,lastScan:state.lastScan,lastScanAttempt:state.lastScanAttempt,scanStartedAt:state.scanStartedAt,scanFailedAt:state.scanFailedAt,marketError:state.marketError,marketRetryCount:state.marketRetryCount,lastMarket:state.lastMarket,lastTickerAt:state.lastTickerAt,lastTickerCount:state.lastTickerCount,scanSuccess:state.scanSuccess,scanFailed:state.scanFailed,lastScanFailures:state.lastScanFailures,lastScanSuccessAt:state.lastScanSuccessAt,
 intervalMs:CONFIG.scanMs,minimumVolume:CONFIG.quoteVolume,telegramConfigured:Boolean(CONFIG.tgToken&&CONFIG.tgChat),watchlist:persisted.watchlist,scanning:state.scanActive,executionRefreshAt:state.executionRefreshAt,lastMarketListings:state.lastMarketListings,blockedSignals:state.blockedSignals,lastBlockReason:state.lastBlockReason,executionLimits:{maxQuoteAgeSeconds:15,maxFeedAgeSeconds:90,maxSpreadBps:20,maxRiskUSD:CONFIG.maxRiskUSD,minNetRR:1.8,analysisOnly:true},
 strictRejected:[...state.analyses.values()].filter(x=>x.pattern&&!x.technicalQualified).length,strictTechPassed:[...state.analyses.values()].filter(x=>x.pattern&&x.technicalQualified===true).length,
 liveWS:state.liveWS,liveWatched:state.liveWatched,lastLiveDataAt:state.lastLiveDataAt,lastLiveCandleClose:state.lastLiveCandleClose,liveSubscribeAcks:state.liveSubscribeAcks,liveSubscribeErrors:state.liveSubscribeErrors,liveLastError:state.liveLastError,lastLiveTrigger:state.lastLiveTrigger,livePending:state.livePending,liveAnalyzed:state.liveAnalyzed,confirmedPatternCount:confirmedPatterns().length,newsStatus:state.newsStatus,newsChecked:state.newsChecked,newsCount:state.news.length,newsError:state.newsError,newsSources:state.newsSources,update:state.update};}
function recentAnalyses(){return [...state.analyses.values()].filter(x=>scannedSymbol(x.symbol)).sort((a,b)=>b.scannedAt-a.scannedAt).slice(0,140).map(x=>currentAnalysis(x));}
function confirmedPatterns(){
 // The user needs to see *all actually identified, closed-1H chart patterns*.
 // Technical quality and Binance market/execution verification are displayed as
 // separate statuses. This function NEVER triggers an alert or paper trade.
 const now=Date.now();
 return [...state.analyses.values()].filter(x=>
   scannedSymbol(x.symbol)&&x.patternConfirmed===true&&Boolean(x.pattern)&&
   Number.isFinite(x.patternConfirmedAt)&&x.patternConfirmedAt<=now&&
   now-x.patternConfirmedAt<2*3600000&&now-x.scannedAt<120*60000
 ).sort((a,b)=>(b.patternConfirmedAt-a.patternConfirmedAt)||(b.score-a.score)).slice(0,65).map(x=>currentAnalysis(x));
}
function assessAnalysis(row,now=Date.now()){
 const m=state.quotes.get(row.symbol);
 // Chart analysis is Binance; the executable check uses the selected venue's rules and book.
 const venue=CONFIG.paperVenues.includes(row.executionVenue)?row.executionVenue:null,entry=venue?venueEntry(venue,row.symbol):null,
  inputs=entry?.contract&&entry.book?venueSizingInputs(entry.contract,entry.book):null;
 // A venue-only coin has no Binance price: its independent price is the venue book itself.
 const vo=Boolean(state.venueOnlySet?.has(row.symbol)&&!state.activeSet.has(row.symbol)),price=vo?entry?.book?.mid:m?.price,priceAt=vo?entry?.book?.receivedAt:m?.priceAt;
 return evaluateSignal(row,{analysisVenue:vo?row.analysisVenue:'BINANCE',verified:state.activeSet.has(row.symbol)||vo,venueConnected:state.rest==='connected'&&entry?.book?.ok===true,
  market:inputs?.market,book:inputs?.book,price,priceAt,now,limits:{...CONFIG.limits,maxRiskUSD:CONFIG.maxRiskUSD}});
}
function currentAnalysis(row,now=Date.now()){
 const decision=assessAnalysis(row,now);
 const quality=row.quality?{...row.quality,passed:decision.technical,failed:decision.technicalReasons,
  checks:row.quality.checks?.map(c=>c.key==='fresh'&&now>row.quality.validUntil?{...c,passed:false,value:'필수 봉 신선도 만료'}:c)}:row.quality;
 return {...row,scorePolicy:getSignalScorePolicy(),quality,technicalQualified:decision.technical,decision,execution:decision.execution,qualified:decision.ready,
  status:row.pattern?(decision.ready?'signal':'watch'):row.status,
  executionStatus:decision.execution.eligible?'호가·비용 기준 통과':'실매매 검증 보류'};
}
function relevantSignals(){
 const now=Date.now();
 return [...state.analyses.values()].filter(x=>state.activeSet.has(x.symbol)||state.venueOnlySet?.has(x.symbol)).map(x=>currentAnalysis(x,now))
  .filter(x=>x.decision.ready).sort((a,b)=>b.score-a.score||(b.patternConfirmedAt-a.patternConfirmedAt)||a.symbol.localeCompare(b.symbol));
}
function watches(){
 // Watch candidates are observations, NOT ready-to-trade signals.
 const approved=new Set(relevantSignals().map(x=>x.symbol+':'+x.pattern+':'+x.time));
 return confirmedPatterns().filter(x=>!approved.has(x.symbol+':'+x.pattern+':'+x.time)).slice(0,40);
}
async function runScan(){
 if(state.scanActive)return;
 state.scanActive=true;state.lastScanAttempt=Date.now();state.scanStartedAt=Date.now();
 state.cycleScanned=0;state.cycle++;state.scanSuccess=0;state.scanFailed=0;state.lastScanFailures=[];
 send('status',getStatus());
 try{
  // Always try rebuilding the verified universe, but never block candle checks for
  // previously discovered Binance markets if one venue's metadata API fails.
  if(!state.ranked.length||state.rest!=='connected'||Date.now()-state.lastMarketListings>10*60000){
   try{await loadMarket()}catch(e){state.marketError=e.message}
  }
  const rows=state.ranked;
  if(!rows.length){
   state.lastScan=Date.now();state.scanMode='waiting';state.scanFailed++;
   if(state.lastScanFailures.length<12)state.lastScanFailures.push('시장 데이터 조회 실패: '+(state.marketError||'재시도 대기'));
   send('scan',{status:getStatus(),signals:[],patterns:[],watch:[],coverage:[]});return;
  }
  const liquid=rows.filter(x=>x.quoteVolume>=CONFIG.quoteVolume);
  const hot=liquid.slice(0,CONFIG.hotBatch).map(x=>x.symbol);
  const rest=rows.filter(x=>!hot.includes(x.symbol));const batch=[];
  for(let j=0;j<CONFIG.rotatingBatch&&rest.length;j++)batch.push(rest[(state.scanCursor+j)%rest.length].symbol);
  state.scanCursor=rest.length?(state.scanCursor+CONFIG.rotatingBatch)%rest.length:0;
  const available=new Set(rows.map(x=>x.symbol));
  const targets=[...new Set([...persisted.watchlist.filter(x=>available.has(x)),...hot,...batch])];
  let n=0;
  async function worker(){
   while(n<targets.length){const idx=n++,symbol=targets[idx];
    try{const output=await checkSymbol(symbol);
     if(output&&output.status!=='insufficient'){state.scanSuccess++;state.lastScanSuccessAt=Date.now()}
     else{state.scanFailed++;if(state.lastScanFailures.length<12)state.lastScanFailures.push(symbol+': 1H/4H 캔들 데이터 부족')}
    }catch(e){state.scanFailed++;if(state.lastScanFailures.length<12)state.lastScanFailures.push(symbol+': '+e.message.slice(0,95));console.warn('[SCAN]',symbol,e.message)}
    state.cycleScanned++;state.scannedSinceBoot++;
    if(state.cycleScanned%4===0)send('status',getStatus());
    await new Promise(r=>setTimeout(r,175));
   }
  }
  await Promise.all(Array.from({length:3},()=>worker()));
  state.lastScan=Date.now();state.scanFailedAt=0;
  if(state.rest==='connected')state.error='';
  send('scan',{status:getStatus(),signals:relevantSignals(),patterns:[],watch:[],structures:[],history:[],coverage:targets,recent:recentAnalyses().slice(0,24)});
  console.log(`[SCAN] ${new Date().toISOString()} mode=${state.scanMode} checked=${targets.length}/${rows.length} success=${state.scanSuccess} failed=${state.scanFailed} candidates=${getScanFunnel().patternCount} qualityBlocks=${getScanFunnel().quality} quoteBlocks=${getScanFunnel().venue} actionable=${relevantSignals().length}`);
 }catch(e){state.error=e.message;state.marketError=e.message;state.marketRetryCount++;state.scanFailedAt=Date.now();console.error('[SCAN ERROR]',e.message);send('status',getStatus())}
 finally{state.scanActive=false;state.scanStartedAt=0;send('status',getStatus())}
}
async function translateArticle({text,signal}){
 const endpoint=new URL(CONFIG.translationURL);if(!['https:','http:'].includes(endpoint.protocol)||endpoint.username||endpoint.password)throw Error('TRANSLATION_ENDPOINT_INVALID');
 const r=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({q:text,source:'auto',target:'ko',format:'text'}),signal});
 if(!r.ok)throw Error('TRANSLATION_HTTP');const result=await r.json();return {translatedText:result.translatedText};
}
let newsBootstrapped=false;
async function pollNews(){
 const settled=await Promise.allSettled(FEEDS.map(async feed=>{
  const controller=new AbortController();const t=setTimeout(()=>controller.abort(),11000);
  try{const res=await fetch(feed.url,{headers:{'Accept':'application/rss+xml, application/xml, text/xml','User-Agent':'Mozilla/5.0 SignalLabRSS/4.0'},signal:controller.signal});
   if(!res.ok)throw Error('HTTP '+res.status);const body=await res.text();if(body.length>1800000||!/<(?:rss|feed|item)\b/i.test(body))throw Error('Invalid or oversized XML');
   return {name:feed.name,body};
  }finally{clearTimeout(t)}
 }));
 const feeds=settled.filter(x=>x.status==='fulfilled').map(x=>x.value);
 state.newsSources=feeds.map(x=>x.name);state.newsChecked=Date.now();
 const failures=settled.filter(x=>x.status==='rejected').map((x,i)=>x.reason?.message||'feed rejected');
 state.newsError=failures.length?`${failures.length}/${FEEDS.length}개 소스 오류`:'';
 if(!feeds.length){state.newsStatus='offline';send('news',{status:state.newsStatus,checked:state.newsChecked,articles:state.news,sourceCount:0,error:'RSS 제공처 모두 연결 실패'});return}
 const originalNews=prepareNews(feeds,state.newsChecked,state.ranked.map(x=>({symbol:x.baseAsset,name:x.baseAsset})));
 // English news is shown in Korean: the configured LibreTranslate URL, else Google's public endpoint
 // (NEWS_TRANSLATION=off keeps the original English).
 const provider=CONFIG.translationURL?{translate:translateArticle,id:'CONFIGURED_LIBRETRANSLATE'}:CONFIG.newsTranslation===true?{translate:googleTranslate,id:'GOOGLE_PUBLIC'}:{translate:undefined,id:'UNCONFIGURED'};
 // Titles and summaries of ~100 articles need a few hundred calls the first time: a longer budget,
 // then the per-text cache makes later polls fast.
 const incoming=await translateNewsArticles(originalNews,{translate:provider.translate,providerId:provider.id,timeoutMs:8000,budgetMs:45000});
 {const need=incoming.filter(a=>a.translation?.status!=='NOT_REQUIRED'),done=need.filter(a=>['COMPLETE','PARTIAL'].includes(a.translation?.status)).length;
  state.newsTranslation={provider:provider.id,done,total:need.length,error:googleTranslateStatus.lastError,checkedAt:Date.now()};
  if(need.length)console.log(`[NEWS] 한국어 번역 ${done}/${need.length}건${done<need.length&&googleTranslateStatus.lastError?` · 최근 실패: ${googleTranslateStatus.lastError}`:''}`)}
 state.newsStatus=feeds.length===FEEDS.length?'connected':'partial';state.news=incoming;
 const newsSeen=new Set(Object.keys(persisted.newsSeen)),nextSeen={...persisted.newsSeen},notifications=[];let changed=false;
 for(const article of incoming){
  if(!newsBootstrapped){nextSeen[article.id]=article.published;changed=true;continue}
  if(shouldNotifyArticle(article,newsSeen,state.newsChecked)){
   nextSeen[article.id]=article.published;changed=true;notifications.push(article);
  }
 }
 for(const [id,date] of Object.entries(nextSeen))if(date<state.newsChecked-7*86400000){delete nextSeen[id];changed=true}
 if(changed)save({...persisted,newsSeen:nextSeen});
 // Failed writes must neither complete bootstrap nor deliver unrecorded news.
 newsBootstrapped=true;
 for(const article of notifications)send('news-alert',article);
 send('news',{status:state.newsStatus,checked:state.newsChecked,articles:state.news,sourceCount:feeds.length,error:state.newsError,translation:state.newsTranslation??null});
}
// A malformed, oversized or interrupted request body is the caller's error
// (400/413). 502 stays reserved for failures of an upstream data source.
const clientError=(message,httpStatus)=>Object.assign(Error(message),{httpStatus});
function bodyJson(req){return new Promise((resolve,reject)=>{
 let buf='',settled=false;
 const settle=(fn,value)=>{if(settled)return;settled=true;fn(value)};
 req.on('data',chunk=>{if(settled)return;buf+=chunk;if(buf.length>30000){req.pause();settle(reject,clientError('Body too large',413))}});
 req.on('end',()=>{
  let value;try{value=JSON.parse(buf)}catch{return settle(reject,clientError('Invalid JSON',400))}
  if(value===null||typeof value!=='object'||Array.isArray(value))return settle(reject,clientError('JSON object required',400));
  settle(resolve,value);
 });
 // Without these a client that disconnects mid-body leaves the handler waiting forever.
 req.on('error',()=>settle(reject,clientError('Request aborted',400)));
 req.on('close',()=>settle(reject,clientError('Request aborted',400)));
})}
const server=http.createServer(async(req,res)=>{
 try{
  let url;
  try{url=new URL(req.url,'http://localhost')}catch{return response(res,400,{error:'Invalid request URL'})}
  const pathname=url.pathname;
  const guard=evaluateRequest({method:req.method,path:pathname,headers:req.headers},{hostNames:allowedHosts});
  if(!guard.ok)return response(res,guard.status,{error:guard.code,message:guard.message});
  if(lanMode && !authorizedRequest(req.socket.remoteAddress,req.headers.authorization,lanPassword)){
   res.writeHead(401,{'WWW-Authenticate':'Basic realm="Signal Lab mobile - username signal", charset="UTF-8"','Content-Type':'text/plain; charset=utf-8','Cache-Control':'no-store',...SECURITY_HEADERS});
   res.end('Signal Lab: 모바일 접속 인증이 필요합니다. PC 실행 창에 표시된 사용자명(signal)과 접속 암호를 입력하세요.');return;
  }
  if(pathname==='/events'){
   res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache, no-transform','Connection':'keep-alive','X-Accel-Buffering':'no',...SECURITY_HEADERS});
   state.clients.add(res);res.write(`event: status\ndata: ${JSON.stringify(getStatus())}\n\n`);
   const pulse=setInterval(()=>{try{res.write(': heartbeat\n\n')}catch{}},20000);
   req.on('close',()=>{clearInterval(pulse);state.clients.delete(res)});return;
  }
  if(pathname.startsWith('/api/internal/supervisor/')){
   const loopback=['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
   if(!loopback||!process.env.SIGNAL_LAB_SUPERVISOR_TOKEN||req.headers['x-signal-lab-supervisor']!==process.env.SIGNAL_LAB_SUPERVISOR_TOKEN)return response(res,403,{error:'supervisor authentication required'});
   if(pathname==='/api/internal/supervisor/ping'&&req.method==='GET')return response(res,200,{ok:true,storageHealthy:storageHealth.healthy});
   if(pathname==='/api/internal/supervisor/shutdown'&&req.method==='POST'){
    try{save()}catch(e){return response(res,503,{error:'저장 실패로 안전 종료 거부'})}
    response(res,200,{ok:true});setImmediate(()=>gracefulShutdown());return;
   }
   return response(res,404,{error:'Not found'});
  }
  if(pathname==='/api/status')return response(res,200,getStatus());
  // Every symbol the scanner checks: Binance perps (Binance chart) + venue-only coins (Gate.io/BingX chart).
  if(pathname==='/api/scan/universe'){
   const caps=state.marketCaps.caps,cap=(symbol,price)=>caps?marketCapFor(symbol,price,caps)?.marketCap??null:null;
   const rows=[...state.ranked.map(x=>({symbol:x.symbol,chart:'BINANCE',quoteVolume:x.quoteVolume,marketCap:cap(x.symbol,state.quotes.get(x.symbol)?.price??x.price),
     analyzed:state.analyses.has(x.symbol),pattern:state.analyses.get(x.symbol)?.pattern||null,score:state.analyses.get(x.symbol)?.score??null})),
    ...[...state.venueOnly.values()].map(x=>({symbol:x.symbol,chart:chartVenueFor(x.symbol),quoteVolume:x.quoteVolume,marketCap:x.marketCap??null,
     analyzed:state.analyses.has(x.symbol),pattern:state.analyses.get(x.symbol)?.pattern||null,score:state.analyses.get(x.symbol)?.score??null}))];
   return response(res,200,{at:Date.now(),count:rows.length,binance:state.ranked.length,venueOnly:state.venueOnly.size,marketCapsAt:state.marketCaps.at||null,rows});
  }
  if(pathname==='/api/scan/diagnostics')return response(res,200,{structureCount:recentStructures().length,historicalPatternCount:recentHistory().length,at:Date.now(),...getScanFunnel(),scannedSinceBoot:state.scannedSinceBoot,scanSuccess:state.scanSuccess,scanFailed:state.scanFailed,scanMode:state.scanMode,marketError:state.marketError});
  if(pathname==='/api/storage')return response(res,200,{mode:'shared-persistent',persistent:storageHealth.healthy,updatedByServer:true,...storageHealth,paperOpen:persisted.paper?.open?.length||0,paperClosed:persisted.paper?.closed?.length||0,journal:persisted.journal.length,alerts:persisted.alerts.length});
  if(pathname==='/api/paper'&&req.method==='GET')return response(res,200,{
   enabled:CONFIG.paperTrading,...paper.snapshot(),marginMode:'CROSS',accountBalanceUSD:Math.round(paperAccountBalance()*100)/100,storage:{...storageHealth},monitor:paperEngineHealth({paper:paper.store,telemetry:paper.telemetry,
   scanner:{analysisVenue:'BINANCE',ws:state.ws,lastTickerAt:state.lastTickerAt,scanMode:state.scanMode,activeCount:state.activeSymbols.length}})
  });
  // One place for every server-side notification switch.
  if(pathname==='/api/notifications/settings'&&req.method==='GET')return response(res,200,notificationSettings());
  if(pathname==='/api/notifications/settings'&&req.method==='POST'){
   const body=await bodyJson(req),keys=['telegramSignals','telegramLive','telegramPaper','windowsPaper'].filter(k=>typeof body?.[k]==='boolean');
   if(!keys.length)return response(res,400,{error:'telegramSignals, telegramPaper or windowsPaper must be a boolean'});
   const before=structuredClone({notifySettings:persisted.notifySettings,paperNotify:{enabled:persisted.paperNotify.enabled,telegram:persisted.paperNotify.telegram}});
   if(typeof body.telegramSignals==='boolean')persisted.notifySettings.telegramSignals=body.telegramSignals;
   if(typeof body.telegramLive==='boolean')persisted.notifySettings.telegramLive=body.telegramLive;
   if(typeof body.telegramPaper==='boolean')persisted.paperNotify.telegram=body.telegramPaper;
   if(typeof body.windowsPaper==='boolean')persisted.paperNotify.enabled=body.windowsPaper;
   try{save()}catch(e){persisted.notifySettings=before.notifySettings;Object.assign(persisted.paperNotify,before.paperNotify);throw e}
   send('notify-settings',notificationSettings());send('paper-notify-settings',{enabled:persisted.paperNotify.enabled,telegram:paperTelegramOn()});
   return response(res,200,notificationSettings());
  }
  if(pathname==='/api/paper/notifications'&&req.method==='GET')return response(res,200,{enabled:persisted.paperNotify.enabled,
   telegram:{enabled:paperTelegramOn(),configured:Boolean(CONFIG.tgToken&&CONFIG.tgChat),forced:CONFIG.paperTelegram!==null},
   serverPlatform:process.platform,windowsSupported:process.platform==='win32',history:persisted.paperNotify.history.slice(0,50),lastDelivery:persisted.paperNotify.lastDelivery??null,
   note:'Windows 로그인 세션에 표시 요청. 방해 금지/알림 설정 또는 작업 스케줄러의 비대화형 실행 시 표시되지 않을 수 있음'});
  if(pathname==='/api/paper/notifications/settings'&&req.method==='POST'){
   const body=await bodyJson(req);
   const hasWin=typeof body?.enabled==='boolean',hasTg=typeof body?.telegram==='boolean';
   if(!hasWin&&!hasTg)return response(res,400,{error:'enabled or telegram must be a boolean'});
   if(hasWin)persisted.paperNotify.enabled=body.enabled;
   if(hasTg)persisted.paperNotify.telegram=body.telegram;
   save();send('paper-notify-settings',{enabled:persisted.paperNotify.enabled,telegram:paperTelegramOn()});
   return response(res,200,{enabled:persisted.paperNotify.enabled,telegram:paperTelegramOn()});
  }
  if(pathname==='/api/paper/notifications/test'&&req.method==='POST'){
   if(!persisted.paperNotify.enabled&&!paperTelegramOn())return response(res,409,{error:'알림이 꺼져 있습니다. 먼저 켜주세요.'});
   const body=await bodyJson(req);
   const type=body?.type==='CLOSE'?'CLOSE':'OPEN';
   const example={type,key:'demo-only',market:'CRYPTO',symbol:'BTCUSDT',direction:'LONG',at:Date.now(),entryFill:100,
    notionalUSD:100,stop:98,lastExitFill:104,closeReason:'ALL_TARGETS',realizedPnLUSD:3.52,feesUSD:0.48};
   const result=emitPaperNotice(example,{test:true});
   return response(res,200,{...result,warning:'모의 테스트 알림. 실제 포지션이 생성되지 않고 PNL 기록에 저장되지 않음'});
  }
  if(pathname==='/api/paper/export'&&req.method==='GET'){
   res.writeHead(200,{'Content-Type':'text/csv; charset=utf-8','Content-Disposition':'attachment; filename=signal-lab-auto-paper-trades.csv','Cache-Control':'no-store',...SECURITY_HEADERS});
   return res.end(paperCSV(paper.store.closed));
  }
  if(pathname==='/api/scalp'&&req.method==='GET')return response(res,200,scalpState);
  if(pathname==='/api/copy'&&req.method==='GET')return response(res,200,copyTrader.status());
  if(pathname==='/api/copy/resume'&&req.method==='POST'){if(COPY.mode==='LIVE'){const body=await bodyJson(req);if(body.confirm!=='COPY_RESUME')return response(res,400,{error:'CONFIRM_REQUIRED'})}return response(res,200,copyTrader.resume())}
  if(pathname==='/api/copy/arm'&&req.method==='POST'){const body=await bodyJson(req);if(body.confirm!=='COPY_ARM')return response(res,400,{error:'CONFIRM_REQUIRED'});return response(res,200,copyTrader.arm())}
  if(pathname==='/api/copy/disarm'&&req.method==='POST')return response(res,200,copyTrader.disarm());
  // From the local channel listener only: a shared token (COPY_LISTENER_TOKEN in .env), compared in constant time.
  if(pathname==='/api/copy/message'&&req.method==='POST'){
   const token=String(req.headers['x-copy-token']||''),want=String(process.env.COPY_LISTENER_TOKEN||'');
   const ok=want.length>=24&&token.length===want.length&&timingSafeEqual(Buffer.from(token),Buffer.from(want));
   if(!ok)return response(res,403,{error:'FORBIDDEN'});
   const body=await bodyJson(req);
   if(typeof body?.text!=='string'||body.text.length>4000)return response(res,400,{error:'TEXT_REQUIRED'});
   return response(res,200,await copyTrader.handle({id:body.id,date:Number(body.date)||Date.now(),text:body.text}));
  }
  if(pathname==='/api/live'&&req.method==='GET')return response(res,200,live.status());
  // 실매매 screen (read only): positions with prices, closed trades with realized results, summary.
  if(pathname==='/api/live/overview'&&req.method==='GET')return response(res,200,{readiness:readiness(),copy:COPY.enabled||copyTrader.store.closed.length?copyTrader.status():null,...liveOverview({status:live.status(),records:live.store.records.map(r=>({...r,deletable:live.deleteBlock(r)===null})),
   priceOf:liveRecordPrice,balance:await liveBalanceSnapshot(),paperTrading:CONFIG.paperTrading})});
  if(pathname.startsWith('/api/live/')&&req.method==='POST'){
   const body=await bodyJson(req);
   if(pathname==='/api/live/arm'){if(body.confirm!=='ARM')return response(res,400,{error:'CONFIRM_REQUIRED'});
    const status=live.arm();
    // Look at the current hour's approvals right away instead of waiting for the next tick or bar.
    setTimeout(()=>{for(const symbol of state.analyses.keys()){try{cryptoEntryAllowed(symbol)}catch{}}},50);
    return response(res,200,status)}
   if(pathname==='/api/live/disarm')return response(res,200,live.disarm());
   // Finished records only (positions, unchecked states and today's closed trades stay).
   if(pathname==='/api/live/delete'){const r=live.deleteRecord(String(body.key||''));return response(res,r.ok?200:409,r)}
   if(pathname==='/api/live/kill')return response(res,200,live.kill('MANUAL'));
   if(pathname==='/api/live/test-order'){
    // TESTNET only: a small DOGE long through the real order path, closed after a few seconds
    // (DOGE: fine lot steps, so a small unit still splits into three targets and adds).
    if(body.confirm!=='TEST')return response(res,400,{error:'CONFIRM_REQUIRED'});
    if(LIVE.mode!=='TESTNET')return response(res,409,{error:'TEST_TESTNET_ONLY'});
    // BingX only: its demo (VST) trades on the live price feed; Gate.io's testnet prices can drift from the public book.
    const venue='BINGX';
    if(!LIVE.venues.includes(venue)||!live.credentials()[venue])return response(res,409,{error:'BINGX_CREDENTIALS_MISSING'});
    try{await venueQuotes.clients[venue].loadContracts()}catch{}
    const contract=venueEntry(venue,'DOGEUSDT').contract,book=await refreshVenueBook(venue,'DOGEUSDT',{maxAgeMs:0});
    if(!contract||!book?.ok||!Number.isFinite(book.mid))return response(res,502,{error:'VENUE_QUOTE_UNAVAILABLE',venue});
    const tick=String(contract.tickSize),entry=book.mid,down=x=>Number(roundDecimalToStep(x,tick,'DOWN'));
    const row={symbol:'DOGEUSDT',direction:'LONG',pattern:'TESTNET 시험 주문',score:90,leverage:10,executionVenue:venue,venueSymbol:contract.venueSymbol,
     venueContract:{tickSize:contract.tickSize,quantityStep:contract.quantityStep,quantityUnit:contract.quantityUnit,contractSizeBase:contract.contractSizeBase,minQuantityBase:contract.minQuantityBase,
      minNotionalUSDT:contract.minNotionalUSDT??null,decimalSizes:contract.decimalSizes===true,decimalStepFallback:contract.decimalStepFallback===true,contractStep:contract.contractStep??null},
     entry,stop:venueStop(entry*.99,'LONG',contract.tickSize),targets:[1.015,1.02,1.03].map(f=>down(entry*f)),decision:{ready:true},
     // Three far zones below: resting adds are placed (and cancelled at the close) like a real split buy.
     paperAddInputs:{zoneSets:[{label:'시험',zones:[.97,.95,.93].map(f=>({priceLow:entry*f*.999,priceHigh:entry*f*1.001}))}],atr:entry*.004,takerRate:.0005},
     targetPlan:{quantity:0}};
    try{return response(res,200,{...(await live.testRoundTrip(row,{holdMs:5000})),liveStatus:live.status()})}
    catch(error){return response(res,error.httpStatus||500,{error:error.message})}
   }
   if(pathname==='/api/live/levels'){const [status,payload]=await liveLevels(body);return response(res,status,payload)}
   if(pathname==='/api/live/reset-kill'){if(body.confirm!=='RESET')return response(res,400,{error:'CONFIRM_REQUIRED'});return response(res,200,live.resetKill())}
   return response(res,404,{error:'LIVE_ROUTE_NOT_FOUND'});
  }
  if(pathname==='/api/venues'){
   if(req.method!=='GET')return response(res,405,{error:'VENUES_READ_ONLY',ordersEnabled:false});
   const symbols=parseVenueSymbols(url.searchParams.get('symbols'),persisted.watchlist);
   if(!symbols.length)return response(res,400,{error:'INVALID_SYMBOLS',ordersEnabled:false});
   return response(res,200,await venueQuotes.snapshot(symbols,{binancePrice:symbol=>state.quotes.get(symbol)?.price??null}));
  }
  if(pathname==='/api/tradfi')return response(res,200,tradfiPublic());
  if(pathname==='/api/tradfi/refresh'&&req.method==='POST')return response(res,409,{accepted:false,...tradfiPublic()});
  if(pathname==='/api/scan'&&req.method==='POST'){if(state.scanActive)return response(res,202,{accepted:false,reason:'스캔 진행 중',status:getStatus()});void runScan();return response(res,202,{accepted:true,message:'백그라운드 스캔 시작',status:getStatus()})}
  // Cloud server (git checkout under systemd): check / apply from GitHub with one tap.
  if(pathname==='/api/update/git'&&req.method==='GET'){if(!GIT_UPDATE)return response(res,404,{error:'GIT_UPDATE_UNAVAILABLE'});try{return response(res,200,await gitCheck(__dirname))}catch(e){return response(res,502,{error:e.message})}}
  // Progress of a one-tap update (for the progress bar): phase and percent, polled by the screen.
  if(pathname==='/api/update/git/progress'&&req.method==='GET')return response(res,200,updateJob);
  if(pathname==='/api/update/git'&&req.method==='POST'){
   if(!GIT_UPDATE)return response(res,404,{error:'GIT_UPDATE_UNAVAILABLE'});
   const body=await bodyJson(req).catch(()=>({}));if(body?.confirm!=='UPDATE')return response(res,400,{error:'CONFIRM_REQUIRED'});
   // Never restart in the middle of an order: stop new orders first, then wait until the executor
   // is idle (no order, cancel or position check running) before the restart.
   if(!allIdle())return response(res,409,{error:'ORDER_IN_PROGRESS',message:'주문 처리 중입니다. 잠시 뒤 다시 누르세요.'});
   const wasArmed=live.armed;live.updating=true;live.disarm();
   const step=(pct,label)=>{updateJob={...updateJob,active:true,pct:Math.max(updateJob.pct||0,Math.round(pct*10)/10),label,at:Date.now()}};
   updateJob={active:true,pct:0,label:'업데이트 시작',startedAt:Date.now()};step(2,'GitHub에서 새 버전 확인');
   try{
    const nodeCheck=file=>new Promise((ok,fail)=>execFile(process.execPath,['--check',file],{timeout:30000},e=>e?fail(Error(path.basename(file)+': '+(String(e.message).split('\n')[1]||'문법 오류'))):ok()));
    // Every file parses, every import resolves, and server.mjs links with all its named imports
    // (link_check.mjs loads the modules without running them).
    const linkCheck=root=>new Promise((ok,fail)=>execFile(process.execPath,['--no-warnings','--experimental-vm-modules',path.join(root,'link_check.mjs'),path.join(root,'server.mjs')],{timeout:60000},(e,out,err)=>e?fail(Error(String(err||e.message).trim().split('\n').pop())):ok()));
    const result=await gitApply(__dirname,{onStep:s=>s==='fetched'?step(12,'새 버전 받는 중'):step(25,'새 버전 적용 · 파일 검사 시작'),
     checkSyntax:async root=>{await checkTree(root,{nodeCheck,onFile:(i,n)=>step(25+55*i/n,`파일 검사 ${i}/${n}`)});step(82,'모듈 연결 검사');await linkCheck(root);step(86,'검사 통과')}});
    if(result.state!=='applied'){updateJob={active:false,pct:100,label:result.state==='current'?'이미 최신 버전':'업데이트 중단',state:result.state,at:Date.now()};live.updating=false;if(wasArmed&&result.state==='current')live.arm();response(res,result.ok?200:409,result);return}
    // Remember that trading was on, so it is switched back on after the restart (TESTNET only).
    if(wasArmed&&LIVE.mode==='TESTNET')try{fs.writeFileSync(path.join(storage.dir,'rearm-after-update.json'),JSON.stringify({mode:LIVE.mode,at:Date.now(),from:result.from,to:result.to}))}catch{}
    response(res,200,{...result,rearm:wasArmed&&LIVE.mode==='TESTNET'});
    console.log('[UPDATE]',result.from,'→',result.to,'waiting for idle, then restarting');step(88,'진행 중인 주문 작업이 끝나기를 기다리는 중');
    (async()=>{for(let i=0;i<1200&&!allIdle();i++)await new Promise(r=>setTimeout(r,500));live.paused=true;
     // Paused only once idle; if never idle in 10 minutes the restart waits for the next tap.
     if(allIdle()){step(92,'서버 재시작');process.kill(process.pid,'SIGTERM')}else{live.paused=false;live.updating=false;try{fs.rmSync(path.join(storage.dir,'rearm-after-update.json'),{force:true})}catch{}console.warn('[UPDATE] not idle for 10 min, restart postponed (code is on disk, applied at the next restart)')}})();
    return;
   }catch(e){updateJob={active:false,pct:100,label:'업데이트 실패',error:e.message,at:Date.now()};live.updating=false;return response(res,502,{error:e.message})}
  }
  if(pathname==='/api/update')return response(res,200,{...state.update,git:GIT_UPDATE,configured:Boolean(CONFIG.updateManifestURL),version:JSON.parse(fs.readFileSync(path.join(__dirname,'package.json'),'utf8')).version,pending:pendingInfo(__dirname)?.version||null});
  if(pathname==='/api/update/check'&&req.method==='POST')return response(res,200,await checkSoftwareUpdate());
  if(pathname==='/api/market-commentary'){
   try{await refreshMarketStats()}catch{}
   return response(res,200,buildMarketCommentary(rawMarketTickers,{now:Date.now(),receivedAt:marketStatsReceivedAt,eligibleSymbols:state.activeSymbols,dataSource:'BINANCE_FUTURES_PUBLIC_24H'}));
  }
  // One article's main text (fetched when opened, from the RSS sources' own sites) in Korean.
  if(pathname==='/api/news/detail'&&req.method==='GET'){
   const id=url.searchParams.get('id')||'',article=(state.news||[]).find(n=>n.id===id);
   if(!article)return response(res,404,{ok:false,error:'NOT_FOUND'});
   const translate=CONFIG.translationURL?translateArticle:CONFIG.newsTranslation===true?googleTranslate:undefined;
   return response(res,200,await articleDetail(article,{translate}));
  }
  if(pathname==='/api/news')return response(res,200,{status:state.newsStatus,checked:state.newsChecked,sourceCount:state.newsSources.length,error:state.newsError,translation:state.newsTranslation??null,articles:state.news});
  if(pathname==='/api/journal'&&req.method==='GET')return response(res,200,{entries:persisted.journal.slice(0,200),summary:journalSummary(persisted.journal),
   insights:patternInsights(persisted.journal.filter(x=>x.source==='LIVE_AUTO'&&x.review).map(x=>x.review))});
  if(pathname==='/api/journal/export'&&req.method==='GET'){
   res.writeHead(200,{'Content-Type':'text/csv; charset=utf-8','Content-Disposition':'attachment; filename="signal-lab-trade-journal.csv"','Cache-Control':'no-store',...SECURITY_HEADERS});
   return res.end(exportTradesCSV(persisted.journal));
  }
  if(pathname==='/api/journal'&&req.method==='POST'){
   const body=await bodyJson(req);
   try{if(persisted.journal.length>=500)throw Error('기록이 500개를 초과했습니다. CSV 백업 후 오래된 기록을 삭제하세요.');
    const item={...normalizeTrade(body,{allowedSymbols:state.activeSet}),id:randomUUID()};persisted.journal.unshift(item);save();send('journal',{summary:journalSummary(persisted.journal)});return response(res,201,{item,summary:journalSummary(persisted.journal)});
   }catch(e){return response(res,e.code==='STORE_WRITE_FAILED'?503:400,{error:e.message})}
  }
  if(pathname==='/api/journal/close'&&req.method==='POST'){
   const body=await bodyJson(req);const row=persisted.journal.find(x=>x.id===body?.id);
   if(!row)return response(res,404,{error:'거래 기록을 찾지 못함'});
   try{const updated=closeTrade(row,{exit:body.exit,fees:body.fees,funding:body.funding});Object.assign(row,updated);save();send('journal',{summary:journalSummary(persisted.journal)});return response(res,200,{item:row,summary:journalSummary(persisted.journal)});
   }catch(e){return response(res,e.code==='STORE_WRITE_FAILED'?503:400,{error:e.message})}
  }
  if(pathname==='/api/journal/delete'&&req.method==='POST'){
   const body=await bodyJson(req);const count=persisted.journal.length;
   persisted.journal=persisted.journal.filter(x=>x.id!==body?.id);
   if(persisted.journal.length===count)return response(res,404,{error:'삭제할 기록이 없음'});
   // An automatic entry that was deleted is not added back.
   if(String(body?.id).startsWith('live-'))persisted.journalHidden=[...(persisted.journalHidden||[]),String(body.id)].slice(-1000);
   save();send('journal',{summary:journalSummary(persisted.journal)});return response(res,200,{summary:journalSummary(persisted.journal)});
  }
  if(pathname==='/api/execution'){
   const symbol=(url.searchParams.get('symbol')||'').toUpperCase();
   const side=(url.searchParams.get('side')||'LONG').toUpperCase();
   const amount=Number(url.searchParams.get('size')||1000);
   if(!state.activeSet.has(symbol))return response(res,404,{error:'공통 PERP 미확인 종목'});
   if(!['LONG','SHORT'].includes(side)||!Number.isFinite(amount)||amount<1||amount>10000)return response(res,400,{error:'방향이나 포지션 금액이 유효하지 않음'});
   // Executable check on the trading venues; the Binance chart only supplies the setup.
   await Promise.all(CONFIG.paperVenues.map(venue=>refreshVenueBook(venue,symbol,{maxAgeMs:3000})));
   const selection=selectExecutionVenue({signal:{...state.analyses.get(symbol),direction:side,symbol},allowed:CONFIG.paperVenues,
    venues:Object.fromEntries(CONFIG.paperVenues.map(v=>[v,venueEntry(v,symbol)])),maxNotionalUSD:amount,maxRiskUSD:CONFIG.maxRiskUSD});
   if(!selection.chosen)return response(res,200,{symbol,eligible:false,executionVenue:null,venueCandidates:selection.candidates,
    reasons:[...new Set(selection.candidates.flatMap(c=>c.reasons.map(r=>`${c.venue}: ${r}`)))].slice(0,6)});
   return response(res,200,{symbol,...selection.chosen.estimate,executionVenue:selection.chosen.venue,venueCandidates:selection.candidates});
  }
  if(pathname==='/api/market')return response(res,200,{at:state.lastMarket,markets:state.ranked.map(x=>({...x,...state.quotes.get(x.symbol)})),research:state.researchRanked.filter(x=>!state.activeSet.has(x.symbol)),watchlist:persisted.watchlist,analysisVenue:'BINANCE'});
  if(pathname==='/api/results')return response(res,200,{scorePolicy:getSignalScorePolicy(),structures:[],history:[],signals:relevantSignals(),patterns:[],watch:[],alerts:persisted.alerts.filter(x=>state.activeSet.has(x.symbol)).slice(0,35).map(x=>({...x,lifecycle:signalLifecycle(x,{price:state.quotes.get(x.symbol)?.price,priceAt:state.quotes.get(x.symbol)?.priceAt})})),recent:recentAnalyses()});
  if(pathname==='/api/klines'){
   const symbol=(url.searchParams.get('symbol')||'').toUpperCase();const interval=url.searchParams.get('interval')||'1h';
   if(!/^[A-Z0-9]{3,25}$/.test(symbol)||!['1h','4h','1d'].includes(interval))return response(res,400,{error:'Invalid symbol or interval'});
   if(!state.activeSet.has(symbol))return response(res,404,{error:'Binance TRADING USDT 무기한 선물 상장 확인 대기 중입니다.'});
   return response(res,200,{symbol,interval,rows:await klines(symbol,interval,interval==='4h'?301:180)});
  }
  if(pathname==='/api/analyze'){
   const symbol=(url.searchParams.get('symbol')||'BTCUSDT').toUpperCase();
   if(!/^[A-Z0-9]{3,25}$/.test(symbol))return response(res,400,{error:'Invalid symbol'});
   if(!state.activeSet.has(symbol))return response(res,404,{error:'Binance TRADING USDT 무기한 선물 상장 확인 대기 중입니다.'});
   const result=await checkSymbol(symbol,true);return response(res,200,result);
  }
  if(pathname==='/api/watchlist'&&req.method==='POST'){
   const {symbols}=await bodyJson(req);
   if(!Array.isArray(symbols))return response(res,400,{error:'Invalid symbols'});
   const next=[...new Set(symbols.map(x=>String(x).toUpperCase()))];
   if(next.some(x=>!state.activeSet.has(x)))return response(res,400,{error:'현재 Binance USDT 무기한 선물이 아닌 종목이 포함되어 있습니다.'});
   persisted.watchlist=next.slice(0,35);
   save();refreshLiveSubscriptions();return response(res,200,{watchlist:persisted.watchlist});
  }
  if(pathname==='/api/paper/levels'&&req.method==='POST'){
   // Manual stop/TP change: validated on the paper position first, then applied to a
   // linked live order (new stop before old cancel), then recorded on the paper position.
   const body=await bodyJson(req);
   if(typeof body?.key!=='string'||body.key.length>300)return response(res,400,{ok:false,reasons:['KEY_REQUIRED']});
   const wanted={stop:body.stop??null,targets:Array.isArray(body.targets)?body.targets:null};
   // A live position without a paper record (paper trading off): checked and applied on its own.
   if(![...paper.store.open,...paper.store.pending].some(x=>x.key===body.key)&&live.store.records.some(r=>r.signalKey===body.key&&r.status==='OPEN')){
    const [status,payload]=await liveLevels(body);return response(res,status,payload);
   }
   const check=paper.setLevels(body.key,wanted,{dryRun:true});
   if(!check.ok)return response(res,400,check);
   if(!check.levels.changed)return response(res,200,{ok:true,changed:false,levels:check.levels});
   let liveResult={live:false};
   if(LIVE.mode!=='OFF'){
    // Only what the user changed goes to the exchange (the live stop / targets may sit on another
    // venue's grid or, with zone adds, at another stop than the paper record).
    const current=[...paper.store.open,...paper.store.pending].find(x=>x.key===body.key);
    const changedStop=wanted.stop!==null&&Number(check.levels.stop)!==Number(current?.stop)?check.levels.stop:NaN;
    const changedTargets=(check.levels.targets||[]).map((t,i)=>Array.isArray(wanted.targets)&&Number(t)!==Number(current?.targets?.[i])?t:NaN);
    liveResult=await live.setLevels(body.key,{stop:changedStop,targets:changedTargets});
    if(!liveResult.ok)return response(res,409,{ok:false,reasons:liveResult.reasons,live:liveResult});
   }
   const applied=paper.setLevels(body.key,wanted,{source:liveResult.live?'MANUAL_PAPER_AND_LIVE':'MANUAL'});
   return response(res,applied.ok?200:409,{...applied,changed:true,live:liveResult});
  }
  if(pathname==='/api/paper/settings'&&req.method==='POST'){
   const body=await bodyJson(req),hasToggle=Object.hasOwn(body||{},'TP1_MOVE_STOP_TO_BREAKEVEN'),hasMode=Object.hasOwn(body||{},'TP1_BREAKEVEN_MODE');
   if(!hasToggle&&!hasMode||hasToggle&&typeof body.TP1_MOVE_STOP_TO_BREAKEVEN!=='boolean'||hasMode&&!['ENTRY_FILL','COST_COVERED'].includes(body.TP1_BREAKEVEN_MODE))
    return response(res,400,{error:'본절 이동 ON/OFF 또는 ENTRY_FILL/COST_COVERED 모드 필요'});
   const settings={...(persisted.paperSettings||{}),TP1_MOVE_STOP_TO_BREAKEVEN:hasToggle?body.TP1_MOVE_STOP_TO_BREAKEVEN:paper.settings.TP1_MOVE_STOP_TO_BREAKEVEN,
    TP1_BREAKEVEN_MODE:hasMode?body.TP1_BREAKEVEN_MODE:paper.settings.TP1_BREAKEVEN_MODE};
   save({...persisted,paperSettings:settings});Object.assign(paper.settings,settings);return response(res,200,{settings});
  }
  if(pathname==='/api/ping')return response(res,200,{ok:true,ts:Date.now()});
  if(pathname.startsWith('/api/'))return response(res,404,{error:'Not found'});
  let file=pathname==='/'?'/index.html':pathname;
  const safe=path.resolve(path.join(__dirname,'public'),'.'+file), root=path.resolve(__dirname,'public');
  if(!safe.startsWith(root+path.sep)&&safe!==root)return response(res,403,{error:'Forbidden'});
  fs.readFile(safe,(err,buf)=>{
   if(err){res.writeHead(404,SECURITY_HEADERS);res.end('Not Found');return}
   res.writeHead(200,{'Content-Type':MIME[path.extname(safe)]||'application/octet-stream','Cache-Control':'no-cache',...SECURITY_HEADERS});res.end(buf);
  });
 }catch(e){
  // A second writeHead would throw inside this async handler and take the process down.
  if(res.headersSent||res.writableEnded){if(!res.writableEnded)try{res.end()}catch{}return}
  const status=Number.isInteger(e?.httpStatus)?e.httpStatus:e?.code==='STORE_WRITE_FAILED'?503:502;
  // Stop reading an oversized upload once the refusal has been delivered.
  if(status===413){res.once('finish',()=>req.destroy());return response(res,413,{error:e.message},{Connection:'close'})}
  response(res,status,{error:e.message});
 }
});
if(LIVE.mode!=='OFF')setInterval(()=>{void live.reconcile().catch(e=>console.error('[LIVE RECONCILE]',e.message))},15000).unref?.();
server.listen(CONFIG.port,CONFIG.host,()=>{
 const awake=startKeepAwake();
 if(awake.started){process.on('exit',awake.stop);console.log('[POWER] 서버가 켜져 있는 동안 PC 절전 진입을 막습니다 (화면은 꺼질 수 있음, KEEP_AWAKE=false로 끔).')}
 console.log(`\nSignal Lab (PC) → http://127.0.0.1:${CONFIG.port}`);
 console.log(`[DATA] Records: ${storage.dir}`);
 console.log(CONFIG.paperTrading?'[PAPER] 자동 모의매매 켜짐 (PAPER_TRADING=on)':'[PAPER] 자동 모의매매 꺼짐 · 실매매 화면 사용 (다시 켜려면 PAPER_TRADING=on)');
 console.log(`[DATA] Settings (.env): ${storage.envPath}`);
 if(storage.movedSharedEnv)console.log('[DATA] 공유 폴더의 설정(.env)을 이 PC 전용 위치로 복사했습니다. 이제 이 PC 설정이 사용됩니다.');
 if(storage.sharedEnvLeft)console.warn(`[DATA] 주의: 공유(OneDrive) 폴더에 .env가 남아 있습니다 → ${storage.sharedEnvLeft}\n       텔레그램 토큰 등 비밀값이 클라우드에 올라가 있으니, 두 PC 모두 새 버전으로 한 번 실행한 뒤 이 파일을 지우세요.`);
 const others=sharedCheck.hosts.filter(h=>!h.current);
 console.log(`[DATA] 이 기록 폴더를 사용한 PC: ${sharedCheck.hosts.map(h=>`${h.host}${h.current?'(지금)':` (마지막 ${new Date(h.lastAt).toLocaleString('ko-KR',{timeZone:'Asia/Seoul'})})`}`).join(', ')}`);
 if(process.env.SIGNAL_LAB_DATA_DIR&&!others.length)console.log('[DATA] 다른 PC 기록이 아직 없습니다. 다른 PC에서 실행한 적이 있다면 OneDrive 계정·동기화를 확인하세요.');
 if(sharedCheck.conflicts.length)console.warn(`[DATA] 경고: OneDrive 충돌 사본 발견 → ${sharedCheck.conflicts.join(', ')}\n       두 PC 기록이 갈라졌을 수 있습니다. 지우지 말고 알려 주세요.`);
 if(lanMode){
  console.log('\n[MOBILE] 같은 Wi-Fi의 휴대폰 브라우저에서 아래 주소 중 PC와 같은 네트워크의 주소로 접속하세요.');
  for(const ip of localIPv4Addresses())console.log(`[MOBILE] http://${ip}:${CONFIG.port}`);
  console.log('[MOBILE] 사용자명: signal');
  console.log('[MOBILE] 접속 암호: '+lanPassword);
  console.log('[MOBILE] 주의: 신뢰하는 사설 Wi-Fi 전용. Windows 방화벽은 개인 네트워크에서만 허용, 공유기 포트 포워딩 금지.');
  console.log('[MOBILE] 암호화되지 않은 HTTP이므로 공용 Wi-Fi, 인터넷 직접 노출에는 사용하지 마세요.\n');
 }
 if(process.platform==='win32' && process.env.SIGNAL_LAB_OPEN_BROWSER==='1') {
  exec(`start "" "http://127.0.0.1:${CONFIG.port}"`,{windowsHide:true},err=>{
   if(err) console.warn('Could not open browser automatically:',err.message);
  });
 }
 console.log(`Binance USDT perpetual live ticks + confirmed 1H/4H event scans; background ${Math.round(CONFIG.scanMs/60000)} min / news ${Math.round(CONFIG.newsMs/1000)} sec. Telegram ${CONFIG.tgChat?'enabled':'disabled'}.`);
 if(CONFIG.autoUpdate){setTimeout(()=>checkSoftwareUpdate().catch(()=>{}),8000);setInterval(()=>checkSoftwareUpdate().catch(()=>{}),6*3600000)}
 connectWS();setTimeout(runScan,1200);setInterval(()=>void runScan(),CONFIG.scanMs);
 // Market caps for every coin (leverage rule), not only for the venue-only list.
 setTimeout(()=>void refreshMarketCaps().catch(()=>{}),15000);setInterval(()=>void refreshMarketCaps().catch(()=>{}),30*60000);
 setTimeout(()=>void runVenueOnlyScan(),CONFIG.venueOnly.startDelayMs);setInterval(()=>void runVenueOnlyScan(),CONFIG.venueOnly.intervalMs);
 // Retry market discovery quickly after an API failure rather than staying empty for 4 minutes.
 setInterval(()=>{if(!state.activeSymbols.length&&!state.researchSymbols.length&&!state.scanActive){state.marketLastRetry=Date.now();void runScan()}},20000);
 setInterval(()=>{try{if(!storageHealth.healthy)save();if(CONFIG.paperTrading)paper.expirePending()}catch(e){console.warn('[PAPER STORAGE]',e.message)}},15000);
 setTimeout(()=>pollNews().catch(e=>console.warn('[NEWS]',e.message)),2000);setInterval(()=>pollNews().catch(e=>{state.newsStatus='offline';state.newsError=e.message;console.warn('[NEWS]',e.message)}),CONFIG.newsMs);
});
server.on('error',err=>{
 console.error('\n[START ERROR]',err.message);
 if(err.code==='EADDRINUSE') console.error(`Port ${CONFIG.port} is already in use. Close the other server window or change PORT in .env.`);
 else if(err.code==='EACCES') console.error('Access denied to local port. Try another PORT in .env.');
 process.exit(1);
});
let shuttingDown=false;
const gracefulShutdown=async()=>{
 if(shuttingDown)return;shuttingDown=true;
 // No new venue work, then wait (max 15 s) for an order, cancel or position check in progress.
 try{live.updating=true;live.paused=true;live.disarm();for(let i=0;i<30&&!allIdle();i++)await new Promise(r=>setTimeout(r,500))}catch{}
 try{save()}catch(e){console.error('[SHUTDOWN STORE]',e.message)}server.close(()=>process.exit(0));setTimeout(()=>process.exit(0),2000)};
process.on('SIGINT',gracefulShutdown);process.on('SIGTERM',gracefulShutdown);
