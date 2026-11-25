import http from 'node:http';
import {exec,execFile} from 'node:child_process';
import {gitUpdateAvailable,gitCheck,gitApply,checkTree,displayVersionOf,headDisplayVersionSync,checkPostUpdateNotice} from './git_update.mjs';
import {liveReadiness,readinessText} from './live_readiness.mjs';
import {articleDetail} from './news_article.mjs';
import {journalEntryFor,patternInsights} from './live_review.mjs';
import {buildReport,pushReport} from './reports_push.mjs';
import {exchangePnl,bingxBalanceRows,balanceOf} from './exchange_pnl.mjs';
import {createDailyPnl,PNL_CALENDAR_RESET_AT} from './daily_pnl.mjs';
import {CopyExecutor,copyConfig,resolveCopyContract} from './copy_executor.mjs';
import {lookupRealTradeSymbol,executeRealManualOrder,listRealOpenOrders,cancelRealOpenOrder,buildBingxMarketList,REAL_CHART_INTERVALS,executeRealPanicFlat,REAL_PANIC_CONFIRM_TOKEN} from './real_manual_trade.mjs';
import {copyEventText} from './copy_telegram.mjs';
import {ScalpExecutor,scalpExecConfig,scalpLiveExecConfig} from './scalp_executor.mjs';
import {scalpEventText} from './scalp_telegram.mjs';
import {scalpReportFiles} from './scalp_journal.mjs';
import {PumpAlertBook,pumpAlertEndpoint,pumpAlertRows} from './pump_alert.mjs';
import {PumpFadeExecutor,pumpFadeConfig,pumpFadeEventText} from './pump_fade.mjs';
import {simulateScalpSignals} from './scalp_simulator.mjs';
import {BingXMarketData} from './bingx_market.mjs';
import {liveEventText,realTradeMessage} from './live_telegram.mjs';
import {randomUUID,randomBytes,timingSafeEqual} from 'node:crypto';
import {authorizedRequest,localIPv4Addresses,createAuthRateLimiter,isProxiedRequest} from './mobile_access.mjs';
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
import {createTelegramNetworkRecovery,postTelegramIPv4} from './telegram_transport.mjs';
import {translateNewsArticles,googleTranslate,googleTranslateStatus,createOpenAINewsTranslator} from './news_translation.mjs';
import {buildMarketCommentary} from './market_commentary.mjs';
import {PublicReadBudget,budgetedPublicRead} from './public_read_budget.mjs';
import {FEEDS,prepareNews,shouldNotifyArticle} from './news.mjs';
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
import {liveOverview,checkLiveLevels,testnetStats} from './live_overview.mjs';
import {TestnetBudget,TESTNET_BALANCE_REFRESH_MS,TESTNET_CAPITAL_CAP_DEFAULT,testnetDailyLossPct,testnetMarginCapPct,armTestnet,disarmTestnet,testnetSwitch} from './testnet_budget.mjs';
import {resetTestnetHistory,resetTestnetPnl,recordManualTestnetPnlReset,latestTestnetReset,withTestnetResetRisk} from './testnet_history_reset.mjs';
import {createVenuePositionsReader,venueRows,normalizeVenuePosition} from './venue_positions.mjs';
import {ManualLedger,MANUAL_LEDGER_FILE} from './manual_ledger.mjs';
import {CopyControls} from './copy_controls.mjs';
import {AccountAlerts} from './account_alerts.mjs';
import {RealMarginAlert,marginFieldsOfBingxRow} from './real_margin_alert.mjs';
import {CopyListenerHealth,listenerHeartbeatEndpoint} from './copy_listener_health.mjs';
import {evaluateReadiness,ReadinessNotifier,readyReplyText} from './ready_check.mjs';
import {RealTrailingManager,REAL_TRAILING_DEFAULTS,feeNetBreakevenPrice} from './real_trailing.mjs';
import {RealAccountGuard,REAL_SAFETY_COPY_PRESET,copyRearmable as copyRearmableNow,copyRearmOnBoot,scalpLiveRearmable as scalpLiveRearmableNow,scalpLiveRearmOnBoot} from './real_safety.mjs';
import {whaleThresholds,WHALE_CVD_DEFAULTS} from './whale_cvd.mjs';
import {WhaleTradeStore,buildWhaleZones,whaleZonesPayload,whaleZoneLookbackMs,WHALE_ZONE_DEFAULTS} from './whale_zones.mjs';
import {atrPct as ladderAtrPct} from './scalp_ladder.mjs';
import {fetchOrderflow,fetchOrderflowWithFirechart,normalizeOrderflowSymbol,scanOrderflowAnomalies,ORDERFLOW_RADAR_DEFAULTS} from './orderflow.mjs';
import {configureFirechartPersistence,FIRECHART_RANGES} from './firechart.mjs';
import {buildCopyAnalytics,exportCopyTradesCSV} from './copy_analytics.mjs';
import {displaySymbol} from './public/symbol_display.js';
import {readPositionMode,sideParams,positionSideFor} from './bingx_position_mode.mjs';
import {selectVenueOnlyCoins,venueVolumes,parseMarketCaps,screenByMarketCap,marketCapFor} from './venue_charts.mjs';
import {prepareData,readStore,atomicWriteStore,backupStore,acquireDataLock,recordHost,findConflictCopies} from './persistence.mjs';

const __dirname=path.dirname(fileURLToPath(import.meta.url));
const appPackage=JSON.parse(fs.readFileSync(path.join(__dirname,'package.json'),'utf8'));
const appVersion={version:appPackage.version,displayVersion:headDisplayVersionSync(__dirname)||displayVersionOf(appPackage)};
const storage=prepareData(__dirname);
configureFirechartPersistence(storage.dir);
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
 tgToken:process.env.TELEGRAM_BOT_TOKEN||'',tgChat:process.env.TELEGRAM_CHAT_ID||'',tgScannerChat:(process.env.TELEGRAM_SCANNER_CHAT_ID||'').trim(),
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
 // Korean translation of English news. An OpenAI key selects contextual AI translation.
 newsTranslation:!/^(off|0|false|no)$/i.test(String(process.env.NEWS_TRANSLATION||'on').trim()),
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
const lanPassword=lanMode?(process.env.MOBILE_ACCESS_PASSWORD||randomBytes(16).toString('hex')):'';
const proxyPassword=process.env.MOBILE_ACCESS_PASSWORD||'';
const allowedTailscaleUsers=new Set(String(process.env.ALLOWED_TAILSCALE_USERS||'').split(',').map(s=>s.trim().toLowerCase()).filter(Boolean));
const authLimiter=createAuthRateLimiter();
const safeTokenEqual=(a,b)=>{const ba=Buffer.from(String(a||'')),bb=Buffer.from(String(b||''));return ba.length>0&&ba.length===bb.length&&timingSafeEqual(ba,bb)};
// Loopback peers skip the password, so every request is first checked for a
// foreign Host name (DNS rebinding) and for cross-site browser origins.
const allowedHosts=allowedHostNames();
const dataPath=storage.storePath;
const LIVE=liveConfig(process.env);
LIVE.testnetSignalEntries=/^(on|true|1|yes)$/i.test(String(process.env.TESTNET_SIGNAL_ENTRIES||'').trim());
const TESTNET_SCALP_ONLY=LIVE.mode==='TESTNET'&&!LIVE.testnetSignalEntries;
const SCALP_EXEC=scalpExecConfig(process.env);
const SCALP_LIVE_EXEC=scalpLiveExecConfig(process.env);
const legacyTestnetHistoryReset=resetTestnetHistory(storage.dir,{apply:SCALP_EXEC.mode==='TESTNET'&&(TESTNET_SCALP_ONLY||LIVE.mode==='OFF')});
const testnetPnlReset=resetTestnetPnl(storage.dir,{apply:LIVE.mode!=='LIVE'&&(SCALP_EXEC.mode==='TESTNET'||LIVE.mode==='TESTNET')});
let testnetHistoryReset=latestTestnetReset(storage.dir,legacyTestnetHistoryReset,testnetPnlReset);
let persisted={watchlist:['BTCUSDT','ETHUSDT','SOLUSDT'],seen:{},alerts:[],newsSeen:{},journal:[],tradfiSeen:{}};
const historical=readStore(dataPath);
if(historical)persisted={...persisted,...historical};
// Atomic writes protect the latest persisted simulation from a partial save.
const storageHealth={healthy:true,lastSavedAt:0,error:''};
let committed=structuredClone(persisted),paperRef=null;
function save(candidate=persisted){
 try{
  atomicWriteStore(dataPath,candidate);
  committed=structuredClone(candidate);persisted=candidate;
  if(paperRef&&candidate.paper&&paperRef.store!==candidate.paper)paperRef.store=candidate.paper;
  Object.assign(storageHealth,{healthy:true,lastSavedAt:Date.now(),error:''});
 }catch(e){
  persisted=structuredClone(committed);
  if(paperRef&&persisted.paper)paperRef.store=persisted.paper;
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
function dropSseClient(client){
 if(!state.clients.delete(client))return;
 try{client._sseCleanup?.()}catch{}
 try{if(!client.destroyed)client.destroy()}catch{}
}
function send(event,obj){const msg=`event: ${event}\ndata: ${JSON.stringify(obj)}\n\n`;for(const client of [...state.clients]){if(client.destroyed||client.writableEnded||client.writableLength>512_000){dropSseClient(client);continue}try{client.write(msg)}catch{dropSseClient(client)}}}
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
function liveClients(){
 if(LIVE.mode==='OFF')return {};
 const mode=LIVE.mode==='LIVE'?'LIVE':'TESTNET',clients={};
 // Signed timestamps use the venue clock measured by the public clients (PC clocks drift).
 const venueNow=venue=>()=>Date.now()+(venueQuotes.clients[venue]?.clockOffsetMs||0);
 if(process.env.BINGX_API_KEY&&process.env.BINGX_API_SECRET)clients.BINGX=new BingXTradeClient({apiKey:process.env.BINGX_API_KEY,secret:process.env.BINGX_API_SECRET,mode,now:venueNow('BINGX')});
 if(process.env.GATEIO_API_KEY&&process.env.GATEIO_API_SECRET)clients.GATEIO=new GateTradeClient({apiKey:process.env.GATEIO_API_KEY,secret:process.env.GATEIO_API_SECRET,mode,now:venueNow('GATEIO')});
 return clients;
}
let copyTrader=null,scalpExec=null,scalpLiveExec=null,pumpFade=null;
const signalClients=liveClients();
const hasTestnetBingx=LIVE.mode==='TESTNET'&&Boolean(signalClients.BINGX)||LIVE.mode!=='LIVE'&&SCALP_EXEC.mode==='TESTNET'&&Boolean(process.env.BINGX_API_KEY&&process.env.BINGX_API_SECRET);
const testnetCapitalCaps=[LIVE.mode==='TESTNET'?LIVE.balanceCapUSD:0,SCALP_EXEC.mode==='TESTNET'?(SCALP_EXEC.balanceCapUSD||LIVE.balanceCapUSD):0].filter(x=>x>0);
const envTestnetCapRaw=process.env.TESTNET_CAPITAL_CAP_USD;
const envTestnetCap=envTestnetCapRaw!==undefined&&String(envTestnetCapRaw).trim()!==''?Number(envTestnetCapRaw):NaN;
const defaultTestnetCap=Number.isFinite(envTestnetCap)?(envTestnetCap>0?envTestnetCap:null):(testnetCapitalCaps.length?Math.min(...testnetCapitalCaps):TESTNET_CAPITAL_CAP_DEFAULT);
// One shared TESTNET risk budget for the signal strategy and the reversal scalp (testnet_budget.mjs, user 2026-11-17
// "한도까지 하나로" / "하루 손실을 늘리면 되지"): TESTNET_DAILY_LOSS_PCT (default 15) of the equity for today's loss of both +
// every open stop risk of both + the new trade (each strategy's loss counted alone); margin of both within TESTNET_MARGIN_CAP_PCT
// (30 %). The shared day stop is kept in testnet-budget.json. The signal side only on TESTNET.
const testnetBudget=new TestnetBudget({dailyLossPct:testnetDailyLossPct(process.env),marginCapPct:testnetMarginCapPct(process.env),accountEquity:hasTestnetBingx,
 capitalCapUSD:defaultTestnetCap,directory:storage.dir,log:(...a)=>console.warn(...a)});
const cappedTestnetFunds=async()=>{
 const f=await testnetAccountFunds();
 const budgetCap=Number(testnetBudget?.capitalCapUSD)>0?Number(testnetBudget.capitalCapUSD):Infinity;
 const cap=LIVE.balanceCapUSD>0?Math.min(LIVE.balanceCapUSD,budgetCap):budgetCap;
 if(!(cap<Infinity)||!(f.equity>cap))return f;
 const equity=cap,avail=f.available!=null?equity*(f.available/f.equity):equity;
 return {...f,equity,available:Math.max(0,avail)};
};
const live=new LiveExecutor({config:LIVE,clients:signalClients,directory:storage.dir,log:(...a)=>console.log(...a),onChange:status=>send('live',status),budget:LIVE.mode==='TESTNET'?testnetBudget:null,
 testnetBingxFunds:hasTestnetBingx?cappedTestnetFunds:null,
 // Copy positions on the same testnet account are kept apart; a real-money copy uses another account.
 // Testnet reversal scalps (scalp_executor.mjs) share the testnet account too; opt-in live scalp shares the real account.
 externalHeld:()=>new Set([...(COPY_ON_SAME_ACCOUNT()?copyTrader?.heldSymbols()??[]:[]),...(LIVE.mode==='TESTNET'?scalpExec?.heldSymbols()??[]:[]),...(LIVE.mode==='TESTNET'?pumpFade?.heldSymbols()??[]:[]),...(LIVE.mode==='LIVE'?scalpLiveExec?.heldSymbols()??[]:[])]),
 priceOf:record=>livePublicPrice(record),onEvent:(record,type,detail)=>liveTelegramNotice(record,type,detail)});
// Copy trading of the followed Telegram channel (copy_executor.mjs): TESTNET only, its own ledger.
let copyTickers={at:0,rows:[]};
// Messages arrive from the local listener (deploy/linux/copy_listener.py) with COPY_LISTENER_TOKEN.
const COPY=copyConfig(process.env,LIVE.mode);
// Same account when both run in the same mode (testnet + testnet, or later live + live).
function COPY_ON_SAME_ACCOUNT(){return COPY.mode===(LIVE.mode==='LIVE'?'LIVE':'TESTNET')}
// Update restarts wait for the copy queue too (a market fill is saved before the next step).
function allIdle(){return live.idle()&&(copyTrader?.idle?.()??true)&&(scalpExec?.idle?.()??true)&&(scalpLiveExec?.idle?.()??true)&&(pumpFade?.idle?.()??true)}
// Real-money copy (COPY_MODE=LIVE + COPY_LIVE_CONFIRM): its own BingX live client and ledger file.
const copyClient=COPY.mode!=='LIVE'?live.clients.BINGX:
 process.env.BINGX_API_KEY&&process.env.BINGX_API_SECRET
  ?new BingXTradeClient({apiKey:process.env.BINGX_API_KEY,secret:process.env.BINGX_API_SECRET,mode:'LIVE',now:()=>Date.now()+(venueQuotes.clients.BINGX?.clockOffsetMs||0)}):null;
// Every open position on the real account (user 2026-11-17: manual positions too), read-only: GET positions at
// most every 3 s (venue_positions.mjs), shown under the copy positions as 카피 / 단타 / 수동.
const realBingxClient=copyClient?.mode==='LIVE'?copyClient:LIVE.mode==='LIVE'?live.clients.BINGX
 :(SCALP_LIVE_EXEC.mode==='LIVE'&&process.env.BINGX_API_KEY&&process.env.BINGX_API_SECRET
  ?new BingXTradeClient({apiKey:process.env.BINGX_API_KEY,secret:process.env.BINGX_API_SECRET,mode:'LIVE',now:()=>Date.now()+(venueQuotes.clients.BINGX?.clockOffsetMs||0)}):null);
const venuePositionsReader=realBingxClient?.mode==='LIVE'
 ?createVenuePositionsReader({read:()=>realBingxClient.positions(),markOf:vs=>Number(copyTickers.rows.find(x=>x.symbol===vs)?.lastPrice)||null}):null;
// Manual trades on the real account (manual_ledger.mjs, user 2026-11-17 "수동 매매도 기록은 똑같이"): recorded from the
// same venue snapshots, settled from BingX income, shown with the copy closes and totals marked 수동.
let accountAlerts=null,realTrailing=null,realSafety=null;
// Real-account margin usage alert (real_margin_alert.mjs, user decision 2026-11-24 17:34 "1번은 교차로 진행할건데"): the
// last BingX balance read of the real copy client (equity, availableMargin, usedMargin, unrealizedProfit). Alert only.
// Copy listener liveness (copy_listener_health.mjs, same decision "2번은 그대로 진행"): built below when the copy is on.
let realMarginAlert=null,copyListenerHealth=null;
const realFunds={fields:null,at:0,pending:null};
function noteRealFunds(row){const f=marginFieldsOfBingxRow(row);if(f&&f.equity!=null){realFunds.fields=f;realFunds.at=Date.now()}}
/** The copy's own balance read when it is fresh; otherwise one read-only GET (shared by concurrent callers). */
async function readRealFunds(maxAgeMs=30000){
 if(realFunds.fields&&Date.now()-realFunds.at<maxAgeMs)return realFunds.fields;
 if(COPY.mode!=='LIVE'||copyClient?.mode!=='LIVE')return null;
 realFunds.pending??=copyClient.balance().then(data=>noteRealFunds(bingxBalanceRows(data).find(r=>r?.asset==='USDT'))).catch(()=>{}).finally(()=>{realFunds.pending=null});
 await realFunds.pending;
 return realFunds.fields&&Date.now()-realFunds.at<maxAgeMs*2?realFunds.fields:null;
}
// Built before the post-update re-arm below reads it (audit 2026-11-23: it was still null there).
if(COPY.mode==='LIVE'||SCALP_LIVE_EXEC.mode==='LIVE')realSafety=new RealAccountGuard({
 directory:storage.dir,
 onTrip:()=>{if(copyTrader?.armed)copyTrader.disarm();if(scalpLiveExec?.armed)scalpLiveExec.disarm('DAILY_LOSS_CIRCUIT_BREAKER')},
 sendText:text=>sendTradeTelegram(text),
 log:(...a)=>console.log('[REAL_SAFETY]',...a),
});
const realOpenStops={at:0,pending:null,byKey:new Map(),ready:false};
async function readRealOpenStops(positions){
 if(!realBingxClient||realBingxClient.mode!=='LIVE'||typeof realBingxClient.openOrders!=='function'||!Array.isArray(positions)||!positions.length)return realOpenStops;
 if(!realOpenStops.pending&&Date.now()-realOpenStops.at>=10000){
  realOpenStops.pending=listRealOpenOrders({client:realBingxClient}).then(orders=>{
   const map=new Map();
   for(const o of orders){
    if(!/STOP/i.test(o.type)||!(o.stopPrice>0))continue;
    const dir=o.positionSide==='LONG'||o.positionSide==='SHORT'?o.positionSide:(o.side==='SELL'?'LONG':'SHORT');
    const key=`${o.venueSymbol}|${dir}`;
    if(!map.has(key))map.set(key,o.stopPrice);
   }
   realOpenStops.byKey=map;realOpenStops.at=Date.now();realOpenStops.ready=true;
  }).catch(()=>{}).finally(()=>{realOpenStops.pending=null});
 }
 if(realOpenStops.pending&&!realOpenStops.ready)await Promise.race([realOpenStops.pending,new Promise(r=>setTimeout(r,800))]);
 return realOpenStops;
}
const realScalpPositions=()=>SCALP_LIVE_EXEC.mode==='LIVE'&&scalpLiveExec?scalpLiveExec.store.open:[];
const realScalpClosed=()=>SCALP_LIVE_EXEC.mode==='LIVE'&&scalpLiveExec?scalpLiveExec.store.closed:[];
async function copyLiveStatus(){const s0=await copyTrader.liveStatus(),s=dailyPnl?{...s0,daily:dailyPnl.status(),settlementRefreshing:Boolean(historyRefresh)}:s0;
 const analytics=buildCopyAnalytics({copyClosed:copyTrader.store.closed,manualClosed:manualLedger?.store.closed??[],scalpClosed:realScalpClosed(),dailyByDay:dailyPnl?.status()?.byDay??null,equityUSD:s0.funds?.equity??null,confirmedOnly:COPY.mode==='LIVE',exchangeCosts:dailyPnl?.costSummary?.()??null});
 const liveScalp=scalpLiveExec&&SCALP_LIVE_EXEC.mode==='LIVE'?await scalpLiveExec.liveStatus():null;
 const extra={analytics,...(accountAlerts?{accountAlerts:accountAlerts.status()}:{}),...(realMarginAlert?{marginAlert:realMarginAlert.status()}:{}),...(copyListenerHealth?{listener:copyListenerHealth.status()}:{}),...(realTrailing?{trailing:realTrailing.status()}:{}),...(realSafety?{safety:realSafety.status()}:{}),...(liveScalp?{liveScalp}:{})};
 if(!venuePositionsReader)return {...s,...extra};
 const v0=await venuePositionsReader.snapshot(realCopyPositions(),realScalpPositions());
 const stStops=await readRealOpenStops(v0.venuePositions);
 const v=Array.isArray(v0.venuePositions)?{...v0,venuePositions:v0.venuePositions.map(p=>({...p,stop:stStops.byKey.get(`${p.venueSymbol}|${p.direction}`)??null,stopChecked:stStops.ready}))}:v0;
 if(!manualLedger)return {...s,...v,...extra};
 try{manualLedger.observe(v);void manualLedger.settle()}catch(e){console.warn('[MANUAL]',e.message)}
 return {...s,...v,manual:manualLedger.status(),...extra}}
const bingxFunds=(data,{requireAvailable=false,testnet=false}={})=>{
 const list=bingxBalanceRows(data);
 const usdt=list.find(x=>x?.asset==='USDT');
 const u=testnet?(list.find(x=>x?.asset==='VST')??usdt):(usdt??list[0]);
 const amount=testnet?u?.equity:(u?.equity??u?.balance),number=Number(amount);
 const equity=testnet&&(amount==null||String(amount).trim()===''||!Number.isFinite(number))?null:number||0;
 const raw=u?.availableMargin,free=Number(raw);
 if(testnet)return {asset:u?.asset??null,equity,available:raw!=null&&String(raw).trim()!==''&&Number.isFinite(free)?Math.max(0,free):0};
 if(requireAvailable&&(raw==null||String(raw).trim()===''||!Number.isFinite(free)))return {equity,available:null};
 return {equity,available:Number.isFinite(free)?Math.max(0,free):equity};
};
const realWallet={pending:null,last:null,error:null,lastAlertIssue:null};
const REAL_WALLET_REFRESH_MS=10000,REAL_WALLET_MAX_AGE_MS=30000;
function readRealWallet(){
 if(realWallet.pending)return realWallet.pending;
 realWallet.pending=realBingxClient.balance().then(data=>{
  const usdt=bingxBalanceRows(data).find(row=>row?.asset==='USDT'),raw=usdt?.availableMargin;
  const parsed=['number','string'].includes(typeof raw)?bingxFunds(usdt,{requireAvailable:true}):null;
  const available=parsed?.available??null;
  const snapshot=available===null?null:{available,equity:parsed?.equity??null,at:Date.now()};
  realWallet.error=snapshot?null:'AVAILABLE_MARGIN_MISSING';
  if(snapshot){
   realWallet.last=snapshot;
   if(COPY.mode==='LIVE'&&copyTrader&&parsed?.equity>0){
    const prevEq=Number(copyTrader.funds?.equity)||0,prevAv=Number(copyTrader.funds?.available)||0;
    copyTrader.funds={equity:parsed.equity,available,at:snapshot.at};
    if((prevEq>0&&Math.abs(parsed.equity-prevEq)/prevEq>=0.05)||(prevAv>0&&Math.abs(available-prevAv)/prevAv>=0.05))reportsDirty=true;
   }
  }
  return snapshot;
 }).catch(e=>{
  const code=e?.code??'';
  realWallet.error=/^[A-Z_0-9]{1,40}$/.test(code)?code:'BALANCE_READ_FAILED';
  throw e;
 }).finally(()=>{realWallet.pending=null});
 return realWallet.pending;
}
const copyControls=new CopyControls({directory:storage.dir,fileName:COPY.mode==='LIVE'?'copy-controls-live.json':'copy-controls.json'});
copyTrader=new CopyExecutor({config:COPY,client:copyClient,controls:copyControls,fileName:COPY.mode==='LIVE'?'copy-store-live.json':'copy-store.json',auditOrders:COPY.mode==='LIVE',
 // Manual first (user 2026-11-25): the manual ledger's open records are one of the signals of a manual position on a lane.
 manualPositions:()=>COPY.mode==='LIVE'&&manualLedger?Object.values(manualLedger.store.positions):[], // read only after startup (copy_executor wraps the call)
 // Same name, 1000-coin contract or stock perpetual (SNDKUSDT -> NCSKSNDK2USD-USDT).
 // A coin missing or suspended in the cached list re-reads the list (new listings / delistings, 2026-11-16).
 contractOf:async symbol=>resolveCopyContract(await venueQuotes.clients.BINGX.contractsFor(symbol),symbol),
 // Last price on BingX for the copy price check: return warm cache immediately (<15s) and refresh in background if >3s old
 // so copy entries never stall waiting on a cold full-market ticker dump.
 markOf:async venueSymbol=>{
  const age=copyTickers.at?Date.now()-copyTickers.at:Infinity;
  const refresh=()=>{copyTickers.pending??=venueQuotes.clients.BINGX.tickers().then(rows=>{copyTickers={at:Date.now(),rows}},()=>{}).finally(()=>{copyTickers.pending=null});return copyTickers.pending};
  if(age>15000||!copyTickers.rows.length)await refresh();
  else if(age>3000)void refresh();
  const t=copyTickers.rows.find(x=>x.symbol===venueSymbol);return Number(t?.lastPrice)||null},
 // Candles for the volume-confirmed zone break (Binance, or the venue for coins not on Binance).
 candlesOf:(symbol,interval,limit)=>state.activeSet.has(symbol)||!chartVenueFor(symbol)?klines(symbol,interval,limit):venueKlines(symbol,interval,limit),
 // Volume zones for the copy stop: Binance 1h (30 d) and 4h (90 d) profiles, or the venue's for coins not on Binance.
 zonesOf:async(symbol,{tickSize})=>{const list=state.activeSet.has(symbol)||!chartVenueFor(symbol)?binanceZoneFallbacks:venueZoneFallbacks,out=[];
  for(const f of list){const r=await f.collector.get(symbol,{tickSize:Number(tickSize),eligible:true}).catch(()=>null);if(r?.ok)out.push(...r.profile.hvn.map(z=>({priceLow:z.priceLow,priceHigh:z.priceHigh})))}
  return out},
 // Testnet copy follows the signal strategy's switch; real-money copy has its own (off after every restart).
 entryGateRevision:()=>COPY.mode==='LIVE'?live.killRevision:live.entryRevision,
 // Real-account daily loss circuit breaker (real_safety.mjs, -8 %): new entries and adds refused while tripped,
 // closes and cuts still go through (audit 2026-11-23: a re-armed copy was never stopped again the same day).
 breaker:()=>COPY.mode==='LIVE'&&realSafety?.isTripped()?'DAILY_LOSS_CIRCUIT_BREAKER':null,
 gate:()=>live.store.killSwitch?{ok:false,reason:'KILL_SWITCH'}:live.updating||live.paused?{ok:false,reason:'UPDATING'}:COPY.mode==='LIVE'?(copyTrader.armed?{ok:true}:{ok:false,reason:'COPY_DISARMED'}):LIVE.mode!=='TESTNET'?{ok:false,reason:'NOT_TESTNET'}:!live.armed?{ok:false,reason:'LIVE_DISARMED'}:{ok:true},
 // Also a symbol the live executor or opt-in live scalp is entering/holding right now (busy).
 isBusy:symbol=>COPY_ON_SAME_ACCOUNT()&&(live.busy.has(symbol)||live.store.records.some(r=>['SUBMITTING','OPEN','UNKNOWN'].includes(r.status)&&r.symbol===symbol))||COPY.mode==='TESTNET'&&Boolean(scalpExec?.heldSymbols().has(symbol)||pumpFade?.heldSymbols().has(symbol))||COPY.mode==='LIVE'&&Boolean(scalpLiveExec?.heldSymbols().has(symbol)),
 // The same balance cap as the signal strategy (a 100,000 virtual USDT testnet trades like the real account).
 // The testnet balance cap does not apply to a real-money copy (its own real equity).
 balance:async()=>{
  const data=await copyClient.balance();
  if(COPY.mode==='LIVE'){
   const usdt=bingxBalanceRows(data).find(row=>row?.asset==='USDT'),funds=balanceOf(usdt);
   noteRealFunds(usdt);
   return {equity:funds?.equity??null,available:funds?.available==null?null:Math.max(0,funds.available)};
  }
  const funds=bingxFunds(data,{requireAvailable:true});
  if(funds.available===null||!(LIVE.balanceCapUSD>0))return funds;
  const used=Math.max(0,funds.equity-funds.available),equity=Math.min(funds.equity,LIVE.balanceCapUSD);
  return {equity,available:Math.max(0,Math.min(funds.available,equity-used))};
 },
 directory:storage.dir,log:(...a)=>console.log(...a),onEvent:copyNotice});
// Read-only: never orders, its own file (manual-trades-live.json), never the copy ledger. The copy loss limit, the copy
// margin limits and every copy decision stay computed from the copy ledger only (copy_executor.mjs); manual trades
// join only the page totals and the hourly report. The notification reader shares the account's 3 s position cache.
const realCopyPositions=()=>COPY.mode==='LIVE'?Object.values(copyTrader.store.positions):[];
const manualLedger=venuePositionsReader?new ManualLedger({directory:storage.dir,client:realBingxClient,
 copyRecords:()=>[...(COPY.mode==='LIVE'?[...realCopyPositions(),...copyTrader.store.closed].map(p=>({...p,alertOrigin:'COPY',alertOwnerId:p.id})):[]),
  ...(SCALP_LIVE_EXEC.mode==='LIVE'&&scalpLiveExec?[...scalpLiveExec.store.open,...scalpLiveExec.store.closed].map(p=>({...p,alertOrigin:'SCALP',alertOwnerId:p.id})):[]),
  ...(LIVE.mode==='LIVE'?live.store.records.filter(p=>p.mode==='LIVE'&&p.venue==='BINGX'&&!p.test).map(p=>({...p,alertOrigin:'SIGNAL',alertOwnerId:p.signalKey})):[])],
 log:(...a)=>console.log(...a),onEvent:confirmedRealTradeNotice,copyOrderAlerts:COPY.mode==='LIVE',sendTelegram:sendRealTradeTelegram}):null;
let realTradePoll=null;
function refreshRealTradeNotices(){
 if(!manualLedger||realTradePoll)return;
 realTradePoll=venuePositionsReader.snapshot(realCopyPositions(),realScalpPositions()).then(s=>manualLedger.observe(s))
  .catch(e=>console.warn('[MANUAL]',e.message)).finally(()=>{realTradePoll=null});
 void realTradePoll.then(()=>{void manualLedger.settleNotifications();void manualLedger.recoverFastTrades()});
}
if(manualLedger){
 const refreshWallet=()=>{void readRealWallet().catch(()=>{})};
 refreshWallet();setInterval(refreshWallet,REAL_WALLET_REFRESH_MS).unref?.();
 setInterval(refreshRealTradeNotices,3000).unref?.();
 setInterval(()=>{void manualLedger.settle()},15000).unref?.()}
// Daily results of the real account for the page calendar (daily_pnl.mjs, user 2026-11-18): BingX income per KST day,
// copy and manual together, read in the background at most every 5 min; the page gets the cached value (daily).
const dailyPnl=COPY.mode==='LIVE'
 ?createDailyPnl({client:copyClient?.mode==='LIVE'?copyClient:null,resetAt:PNL_CALENDAR_RESET_AT,log:(...a)=>console.warn(...a)}):null;
dailyPnl?.start();
// 되돌림 단타 (5m dip-rebound LONG) on the BingX TESTNET only (scalp_executor.mjs, user 2026-11-14 22:29):
// its own ledger (scalp-store.json), SCALP_EXEC_MODE=OFF|TESTNET (LIVE refused), disarmed after every start.
if(SCALP_EXEC.refused)console.warn('[SCALP] SCALP_EXEC_MODE refused:',SCALP_EXEC.refused,'— scalps stay OFF (testnet only)');
// Its own public BingX queue for the 5m candles (~80 symbols per 5 min, SCALP_KLINE_GAP_MS apart).
const scalpMarket=new BingXMarketData({minIntervalMs:SCALP_EXEC.klineGapMs});
// The testnet signed client: the signal strategy's when it runs on the testnet (one request queue), else a
// TESTNET-only client of its own. Never a LIVE client (the executor refuses one).
const scalpClient=SCALP_EXEC.mode!=='TESTNET'?null:LIVE.mode==='TESTNET'&&live.clients.BINGX?live.clients.BINGX
 :process.env.BINGX_API_KEY&&process.env.BINGX_API_SECRET?new BingXTradeClient({apiKey:process.env.BINGX_API_KEY,secret:process.env.BINGX_API_SECRET,mode:'TESTNET',now:()=>Date.now()+(venueQuotes.clients.BINGX?.clockOffsetMs||0)}):null;
const testnetAccount={funds:null,pending:null,checkedAt:0,error:null};
async function testnetAccountFunds(){
 const client=LIVE.mode==='TESTNET'&&live.clients.BINGX||scalpClient;
 if(!client||client.mode!=='TESTNET')throw Error('BALANCE_UNAVAILABLE');
 if(testnetAccount.pending)return testnetAccount.pending;
 if(Date.now()-testnetAccount.checkedAt<TESTNET_BALANCE_REFRESH_MS-500){
  if(testnetAccount.error)throw testnetAccount.error;
  if(testnetAccount.funds)return testnetAccount.funds;
 }
 testnetAccount.pending=client.balance().then(data=>{
  const funds=bingxFunds(data,{testnet:true});
  if(funds.equity==null||!Number.isFinite(funds.equity)||funds.equity<0)throw Error('BALANCE_UNAVAILABLE');
  testnetBudget.observeAccount(funds.equity,funds.asset);
  testnetAccount.funds=funds;testnetAccount.error=null;return funds;
 }).catch(e=>{testnetAccount.funds=null;testnetAccount.error=e;testnetBudget.observeAccount(null);throw e})
  .finally(()=>{testnetAccount.checkedAt=Date.now();testnetAccount.pending=null});
 return testnetAccount.pending;
}
// Budget reads can report an unavailable or expired sample while the signed queue is waiting on BingX.
async function refreshTestnetBudgetBalance(){
 let timer;
 try{await Promise.race([testnetAccountFunds(),new Promise(resolve=>{timer=setTimeout(resolve,1500).unref()})])}
 catch{}finally{clearTimeout(timer)}
}
let scalpTickers={at:0,rows:[]};
// One bulk ticker read at a time: callers arriving while it runs share it (review 2026-11-17: the scan-order read
// and the 5m reads use the same paced queue, so a duplicate read delayed the scan).
let scalpTickersInFlight=null;
const scalpTickerRows=async(maxAgeMs=20000)=>{if(scalpTickers.at&&Date.now()-scalpTickers.at<=maxAgeMs)return scalpTickers.rows;
 if(!scalpTickersInFlight)scalpTickersInFlight=scalpMarket.tickers().then(rows=>{scalpTickers={at:Date.now(),rows};return rows}).finally(()=>{scalpTickersInFlight=null});
 return scalpTickersInFlight};
const scalpLast=async(venueSymbol,maxAgeMs)=>Number((await scalpTickerRows(maxAgeMs)).find(x=>x.symbol===venueSymbol)?.lastPrice)||null;
// The testnet balance the scalps size on (capital-capped), shared by the 5m scalp and the 급변 알림 초단타.
const testnetScalpBalance=async()=>{const f=hasTestnetBingx?await testnetAccountFunds():bingxFunds(await scalpClient.balance());
 const budgetCap=Number(testnetBudget?.capitalCapUSD)>0?Number(testnetBudget.capitalCapUSD):Infinity;
 const cap=SCALP_EXEC.balanceCapUSD>0?Math.min(SCALP_EXEC.balanceCapUSD,budgetCap):LIVE.balanceCapUSD>0?Math.min(LIVE.balanceCapUSD,budgetCap):budgetCap;
 if(!(cap<Infinity)||!(f.equity>cap))return f;
 const equity=cap,avail=f.available!=null?equity*(f.available/f.equity):equity;
 return {equity,available:Math.max(0,avail)}};
scalpExec=new ScalpExecutor({config:SCALP_EXEC,client:scalpClient,
 contracts:symbol=>venueQuotes.clients.BINGX.contractsFor(symbol),tickers:()=>scalpTickerRows(60000),tickersFresh:()=>scalpTickerRows(5000),
 candles:(symbol,interval,limit)=>scalpMarket.klines(symbol,interval,limit),
 // 4H trend: Binance for Binance-listed symbols (as the backtest and the paper scalps), else BingX.
 trendCandles:symbol=>state.activeSet.has(symbol)?klines(symbol,'4h',301):scalpMarket.klines(symbol,'4h',301),
 // 매물대 반전 zones (4H 542 / 1D 182 candles): BingX public klines on the same paced queue (SCALP_KLINE_GAP_MS), read only
 // for coins whose 2.5 % detection fired, cached per coin until the next 4H / 1D candle closes.
 zoneCandles:(symbol,interval,limit)=>scalpMarket.klines(symbol,interval,limit),
 // Backtest-validated 5m orderflow (OI flush +5pt / CVD strong flip 1.5x), read only for >=60pt candidates (30s cache).
 orderflow:symbol=>fetchOrderflow(symbol,{interval:'5m',budget:publicReadBudget}),
 // 고래 매물대 (user 2026-11-25 09:51): Binance aggTrades on the shared public read budget, only for candidates a ±5 can move.
 whaleZones:(symbol,o)=>scalpWhaleZones(symbol,o),
 // Entry price check: the BingX book mid, else a fresh BingX last price.
 priceOf:async(symbol,venueSymbol)=>{try{const b=await scalpMarket.book(symbol);if(b?.ok&&b.mid>0)return b.mid}catch{}return scalpLast(venueSymbol,3000)},
 markOf:venueSymbol=>scalpLast(venueSymbol,20000),
 // Apply live testnet capitalCapUSD (default $3,000) with proportional free margin so huge legacy VST positions don't collapse available to 0.
 balance:testnetScalpBalance,
 // The signal strategy (testnet), the testnet copy and the 급변 알림 초단타 share this account: their symbols are skipped.
 isBusy:(symbol,venueSymbol)=>Boolean(pumpFade?.heldSymbols().has(symbol)||pumpFade?.heldSymbols().has(venueSymbol))||LIVE.mode==='TESTNET'&&(live.busy.has(symbol)||live.store.records.some(r=>['SUBMITTING','OPEN','UNKNOWN'].includes(r.status)&&(r.symbol===symbol||r.venueSymbol===venueSymbol)))
  ||COPY.mode==='TESTNET'&&(copyTrader.heldSymbols().has(symbol)||Object.values(copyTrader.store.positions).some(p=>p.status==='OPEN'&&p.venueSymbol===venueSymbol)),
 gate:()=>live.store.killSwitch?{ok:false,reason:'KILL_SWITCH'}:live.updating||live.paused?{ok:false,reason:'UPDATING'}:{ok:true},
 directory:storage.dir,log:(...a)=>console.log(...a),onEvent:scalpNotice,
 // The shared testnet budget (never with a LIVE signal strategy: then the scalp keeps its own 3 % rules).
 budget:LIVE.mode==='LIVE'?null:testnetBudget});
if(LIVE.mode==='TESTNET')testnetBudget.register('signal',withTestnetResetRisk(live.budgetSource(),testnetHistoryReset,'signal'));
if(LIVE.mode!=='LIVE')testnetBudget.register('scalp',withTestnetResetRisk(scalpExec.budgetSource(),testnetHistoryReset,'scalp'));
if(hasTestnetBingx)setInterval(()=>{void testnetAccountFunds().catch(()=>{})},TESTNET_BALANCE_REFRESH_MS).unref?.();
if(SCALP_EXEC.mode==='TESTNET'&&scalpClient)setInterval(()=>{void scalpExec.tick().catch(e=>console.error('[SCALP]',e.message))},5000).unref?.();
// 급변 알림 초단타 (pump_fade.mjs, user 2026-11-25 14:23 / 14:32 "매매 시작해" / 14:34 "단타로 썼던 것 그대로 두고 초단타를 별개로"):
// a separate TESTNET-only strategy on the same alerts as the 5m scalp's pump hand-off (kept). PUMP_FADE (default on) needs
// SCALP_EXEC_MODE=TESTNET and the testnet client; LIVE is refused. It follows the one testnet switch (scalpExec.armed), has its
// own ledger (pump-fade-store.json), writes its trades to the scalp journal tagged PUMP_FADE and shares the testnet budget.
// One position per symbol across both scalps (each skips the other's coins, SYMBOL_HELD_BY_OTHER_STRATEGY).
const PUMP_FADE=pumpFadeConfig(process.env);
if(PUMP_FADE.refused&&PUMP_FADE.refused!=='PUMP_FADE_OFF')console.warn('[PUMP_FADE] refused:',PUMP_FADE.refused,'— 급변 초단타 stays OFF (testnet only)');
pumpFade=new PumpFadeExecutor({config:PUMP_FADE,client:PUMP_FADE.mode==='TESTNET'&&scalpClient?.mode==='TESTNET'?scalpClient:null,
 contracts:symbol=>venueQuotes.clients.BINGX.contractsFor(symbol),candles1m:(symbol,limit)=>scalpMarket.klines(symbol,'1m',limit),
 btcCandles:()=>scalpMarket.klines('BTCUSDT','5m',5),balance:testnetScalpBalance,
 isBusy:(symbol,venueSymbol)=>Boolean(scalpExec?.heldSymbols().has(symbol)||scalpExec?.heldSymbols().has(venueSymbol))
  ||LIVE.mode==='TESTNET'&&(live.busy.has(symbol)||live.store.records.some(r=>['SUBMITTING','OPEN','UNKNOWN'].includes(r.status)&&(r.symbol===symbol||r.venueSymbol===venueSymbol)))
  ||COPY.mode==='TESTNET'&&(copyTrader.heldSymbols().has(symbol)||Object.values(copyTrader.store.positions).some(p=>p.status==='OPEN'&&p.venueSymbol===venueSymbol)),
 active:()=>scalpExec?.armed===true,
 gate:()=>live.store.killSwitch?{ok:false,reason:'KILL_SWITCH'}:live.updating||live.paused?{ok:false,reason:'UPDATING'}:{ok:true},
 budget:LIVE.mode==='LIVE'?null:testnetBudget,directory:storage.dir,journalFile:scalpExec.journalFile,log:(...a)=>console.log(...a),onEvent:e=>pumpFadeNotice(e)});
if(LIVE.mode!=='LIVE'&&PUMP_FADE.mode==='TESTNET')testnetBudget.register('pumpFade',withTestnetResetRisk(pumpFade.budgetSource(),testnetHistoryReset,'pumpFade'));
if(PUMP_FADE.mode==='TESTNET'&&pumpFade.client)setInterval(()=>{void pumpFade.tick().catch(e=>console.error('[PUMP_FADE]',e.message))},2000).unref?.();
// Opt-in real-money reversal scalp (default OFF; requires SCALP_LIVE_MODE=LIVE + SCALP_LIVE_CONFIRM=REAL_MONEY_SCALP).
// Runs in a completely separate executor/ledger from testnet scalpExec; starts OFF until first armed from #real,
// then automatically restores ON across updates & restarts unless manually disarmed or blocked by a safety stop.
if(SCALP_LIVE_EXEC.refused)console.warn('[SCALP:LIVE] SCALP_LIVE_MODE refused:',SCALP_LIVE_EXEC.refused,'— live scalp stays OFF');
if(SCALP_LIVE_EXEC.mode==='LIVE'&&realBingxClient?.mode==='LIVE'){
 scalpLiveExec=new ScalpExecutor({config:SCALP_LIVE_EXEC,client:realBingxClient,
  fileName:'scalp-store-live.json',journalFileName:'scalp-journal-live.jsonl',signalsFileName:'scalp-signals-live.jsonl',
  contracts:symbol=>venueQuotes.clients.BINGX.contractsFor(symbol),tickers:()=>scalpTickerRows(60000),tickersFresh:()=>scalpTickerRows(5000),
  candles:(symbol,interval,limit)=>scalpMarket.klines(symbol,interval,limit),
  trendCandles:symbol=>state.activeSet.has(symbol)?klines(symbol,'4h',301):scalpMarket.klines(symbol,'4h',301),
  zoneCandles:(symbol,interval,limit)=>scalpMarket.klines(symbol,interval,limit),
  orderflow:symbol=>fetchOrderflow(symbol,{interval:'5m',budget:publicReadBudget}),
  whaleZones:(symbol,o)=>scalpWhaleZones(symbol,o),
  bookOf:symbol=>scalpMarket.book(symbol),
  priceOf:async(symbol,venueSymbol)=>{try{const b=await scalpMarket.book(symbol);if(b?.ok&&b.mid>0)return b.mid}catch{}return scalpLast(venueSymbol,3000)},
  markOf:venueSymbol=>scalpLast(venueSymbol,20000),
  balance:async()=>{
   const data=await realBingxClient.balance();
   const usdt=bingxBalanceRows(data).find(row=>row?.asset==='USDT'),funds=balanceOf(usdt);
   return {equity:funds?.equity??null,available:funds?.available==null?null:Math.max(0,funds.available)};
  },
  // Bidirectional real-account isolation: skip coins held by live copy, live signal, or live manual positions.
  isBusy:(symbol,venueSymbol)=>
   COPY.mode==='LIVE'&&(copyTrader.heldSymbols().has(symbol)||Object.values(copyTrader.store.positions).some(p=>p.status==='OPEN'&&p.venueSymbol===venueSymbol))
   ||LIVE.mode==='LIVE'&&(live.busy.has(symbol)||live.store.records.some(r=>['SUBMITTING','OPEN','UNKNOWN'].includes(r.status)&&(r.symbol===symbol||r.venueSymbol===venueSymbol)))
   ||Boolean(venuePositionsReader?.cachedRows?.().some(r=>(r.symbol===symbol||r.venueSymbol===venueSymbol)&&!scalpLiveExec?.heldSymbols().has(symbol))),
  gate:()=>live.store.killSwitch?{ok:false,reason:'KILL_SWITCH'}:live.updating||live.paused?{ok:false,reason:'UPDATING'}:realSafety?.isTripped()?{ok:false,reason:'DAILY_LOSS_CIRCUIT_BREAKER'}:{ok:true},
  directory:storage.dir,log:(...a)=>console.log(...a),onEvent:scalpLiveNotice,budget:null});
 setInterval(()=>{void scalpLiveExec.tick().catch(e=>console.error('[SCALP:LIVE]',e.message))},5000).unref?.();
}
// 급변 알림 (crimepump 공습경보 via @ggangalt2_bot, user 2026-11-24): every alert in pump-alerts.json with its outcome at
// +1/+5/+15/+60 min from public 1m klines (BingX first; Binance only for coins Binance lists, so an unknown symbol never
// marks the Binance feed offline). Read only. The testnet scalp evaluates each alert's coin (scalp_executor.mjs pumpAlert).
const pumpBook=new PumpAlertBook({directory:storage.dir,log:(...a)=>console.warn(...a),
 // The per-alert 초단타 simulation (mode A / B) under the rules in force.
 fadeRules:()=>pumpFade.rules(),
 // lists: from the cached BingX contract list / Binance listing only (no read); null while not loaded yet.
 sources:[{name:'BINGX',lists:symbol=>{const m=venueQuotes.clients.BINGX.contracts;return m?.size?m.has(symbol):null},klines:(symbol,limit)=>venueQuotes.clients.BINGX.klines(symbol,'1m',limit)},
  {name:'BINANCE',lists:symbol=>state.activeSet?.size?state.activeSet.has(symbol):null,klines:(symbol,limit)=>{if(!state.activeSet.has(symbol))throw Object.assign(Error('NOT_ON_BINANCE'),{code:'NOT_ON_BINANCE'});return klines(symbol,'1m',Math.min(1500,limit))}}],
 listed:async symbol=>{const c=(await venueQuotes.clients.BINGX.contractsFor(symbol))?.get?.(symbol);return c?c.tradable===true:false}});
scalpExec.onPumpResult=(key,result)=>{if(key)pumpBook.attachScalp(key,result)};
pumpFade.onResult=(key,result)=>{if(key)pumpBook.attachFade(key,result)};
setInterval(()=>{void pumpBook.track().catch(e=>console.warn('[PUMP]',e.message))},60000).unref?.();
// 실계좌 준비 점검 (ready_check.mjs, user 2026-11-24 13:35 "조건이 완료되면 알림으로 알려줄 수 있나 실계좌에 쓸 상황이
// 되었다고", 13:37 "2주는 너무 멀어 100건으로 잡고 다시 한 번 검증해보자고"): hourly, read only. One message to the allowed
// chat per group when it first meets the criteria (live-readiness.json). Never changes a setting, never arms, no orders.
const readyLossLimits=()=>({dailyLossPct:Number(realSafety?.store?.dailyLossLimitPct)||0,copyLedgerLossPct:COPY.mode==='LIVE'?Number(copyTrader?.config?.ledgerLossPct)||0:0});
// Only TRADER_LADDER scalp trades from its switch time count (user 2026-11-24, 카피식 추매).
const readySummary=()=>evaluateReadiness({scalpRows:scalpExec.readinessRows(),pumpRecords:pumpBook.records,pumpFadeRows:pumpFade.readinessRows(),scalpScope:(s=>s?.active||Number(s?.since)>0?s:null)(scalpExec.managementScope())});
const readyNotifier=new ReadinessNotifier({directory:storage.dir,log:(...a)=>console.warn(...a),
 send:async text=>{
  if(accountAlerts)return accountAlerts.sendToAllowedChat(text);
  if(!CONFIG.tgToken||!CONFIG.tgChat.trim())throw Error('TELEGRAM_NOT_CONFIGURED');
  const res=await telegramPost({chat_id:CONFIG.tgChat.trim(),text});if(!res?.ok)throw Error(`HTTP_${res?.status}`);return true}});
async function readyCheck(){try{await readyNotifier.check(readySummary(),{lossLimits:readyLossLimits()})}catch(e){console.warn('[READY]',e.message)}}
// Copy listener liveness (copy_listener_health.mjs, user decision 2026-11-24 17:34 "2번은 그대로 진행"): heartbeats from
// deploy/linux/copy_listener.py; one "카피 수신 끊김" / "카피 수신 복구" to the allowed chat. Off with the copy mode OFF.
if(COPY.enabled){
 copyListenerHealth=new CopyListenerHealth({directory:storage.dir,log:(...a)=>console.warn(...a),
  // The same allowed-chat path as the readiness notice (account alerts when built, else the configured chat).
  send:text=>readyNotifier.send(text)});
 setInterval(()=>{void copyListenerHealth.check().catch(e=>console.warn('[COPY LISTENER]',e.message))},30000).unref?.();
}
setInterval(()=>{void readyCheck()},3600000).unref?.();setTimeout(()=>{void readyCheck()},180000).unref?.();
// 급변 알림 초단타: the screen notice, and entries / exits / problems to the allowed private chat (the readiness path).
const PUMP_FADE_TG_EVENTS=new Set(['OPENED','CLOSED','STOP_FAILED','EMERGENCY_CLOSE_FAILED','ENTRY_OUTCOME_UNKNOWN']);
function pumpFadeNotice(e){
 if(e?.type==='CLOSED'||e?.type==='OPENED')try{reportsDirty=true}catch{}
 const text=pumpFadeEventText(e);if(!text)return;
 try{send('live-notice',{type:'PUMP_FADE_'+e.type,symbol:e.symbol??null,text,at:Date.now()})}catch{}
 if(PUMP_FADE_TG_EVENTS.has(e?.type))void Promise.resolve().then(()=>readyNotifier.send(text)).catch(err=>console.warn('[PUMP_FADE] 텔레그램',err?.message));
}
function scalpNotice(e){
 if(e?.type==='CLOSED')try{reportsDirty=true}catch{} // the journal line follows within minutes; the report picks it up
 const text=scalpEventText(e);if(!text)return;
 try{send('live-notice',{type:'SCALP_'+e.type,symbol:e.symbol??null,text,at:Date.now()})}catch{}
}
// A copy ledger of the other mode with open positions is no longer managed: say so once at start.
try{const other=path.join(storage.dir,COPY.mode==='LIVE'?'copy-store.json':'copy-store-live.json');
 if(fs.existsSync(other)){const o=JSON.parse(fs.readFileSync(other,'utf8'));const n=Object.values(o.positions||{}).filter(x=>x.status==='OPEN');
  if(n.length){const text=`[카피] ⚠️ 카피 모드가 ${COPY.mode==='LIVE'?'실계좌':'테스트넷'}로 바뀌었습니다. ${COPY.mode==='LIVE'?'테스트넷':'실계좌'} 카피 포지션 ${n.length}개(${n.map(x=>displaySymbol(x.symbol)).join(', ')})는 더 이상 따라가지 않습니다. 거래소에서 직접 정리해 주세요.`;
   console.warn('[COPY]',text);setTimeout(()=>{try{if(CONFIG.tgToken&&CONFIG.tgChat)telegramPost({chat_id:CONFIG.tgChat,text}).catch(()=>{})}catch{}},5000)}}}catch{}
// First balance / positions read soon after start (the panel shows the copy account's balance).
if(COPY.enabled)setTimeout(()=>{void copyTrader.reconcile().catch(()=>{})},8000).unref?.();
if(COPY.enabled)setInterval(()=>{void copyTrader.reconcile().catch(e=>console.error('[COPY RECONCILE]',e.message))},60000).unref?.();
// Keep BingX tickers warm while copy trading is armed so markOf() returns in 0ms on incoming copy cards.
if(COPY.enabled)setInterval(()=>{
 if(!(copyTrader?.armed||(COPY.mode==='TESTNET'&&live?.armed)))return;
 if(copyTickers.pending||(copyTickers.at&&Date.now()-copyTickers.at<3800))return;
 copyTickers.pending=venueQuotes.clients.BINGX.tickers().then(rows=>{copyTickers={at:Date.now(),rows}},()=>{}).finally(()=>{copyTickers.pending=null});
},4000).unref?.();
let historyRefresh=null;
function refreshTradeHistory({recheck=false}={}){
 if(historyRefresh)return historyRefresh;
 const before=manualLedger?.store.closed.filter(p=>p.netSource==='EXCHANGE_FILLS').length;
 historyRefresh=Promise.all([copyTrader.settle({limit:10,recheck}),manualLedger?.settle({historyLimit:10,recheck})]).then(()=>{
  if(before!==manualLedger?.store.closed.filter(p=>p.netSource==='EXCHANGE_FILLS').length)reportsDirty=true;
 }).catch(e=>console.error('[TRADE SETTLE]',e.message)).finally(()=>{historyRefresh=null});
 return historyRefresh;
}
if(copyClient&&COPY.mode==='LIVE'){
 setTimeout(()=>{void refreshTradeHistory()},10000).unref?.();
 setInterval(()=>{void refreshTradeHistory()},20000).unref?.();
}else if(copyClient)setInterval(()=>{void copyTrader.settle().catch(e=>console.error('[COPY SETTLE]',e.message))},60000).unref?.();
function copyNotice(e){
 if(e?.type==='COPY_SETTLED')reportsDirty=true;
 if(e?.mode==='LIVE'&&e.type==='ORDER_RECEIPT'){void manualLedger?.confirmCopyOrder(e.orderId);return}
 if(e?.mode==='LIVE'&&manualLedger&&['OPENED','ADDED','REDUCED','CLOSED'].includes(e.type)){
  reportsDirty=true;if(!/LIQUIDATION|NO_STOP|LOSS_LIMIT|EMERGENCY/.test(e.reason)){void manualLedger.settle();return;}void manualLedger.settle();
 }
 const text=copyEventText(e);if(!text)return;
 try{send('live-notice',{type:'COPY_'+e.type,symbol:e.symbol??null,text,at:Date.now()})}catch{}
 if(e.mode==='LIVE'&&['SKIPPED','ADD_SKIPPED'].includes(e.type)&&accountAlerts&&!accountAlerts.shouldSendSkip(e))return;
 if(e.mode==='LIVE')void sendTradeTelegram(text);
}
const SCALP_LIVE_TG_EVENTS=new Set(['MANUAL_FIRST','MANUAL_PROTECT_HOLD','ARMED','DISARMED','OPENED','SCALE_IN_FILLED','PARTIAL_TAKE_PROFIT','CLOSED','EMERGENCY_ROE_STOP','MAX_HOLD_EXIT','STOP_FAILED','DAILY_LOSS_LIMIT','EMERGENCY_CLOSE_FAILED']);
function scalpLiveNotice(e){
 if(e?.type==='CLOSED'||e?.type==='OPENED')try{reportsDirty=true}catch{}
 const text=scalpEventText(e);if(!text)return;
 try{send('live-notice',{type:'SCALP_LIVE_'+e.type,symbol:e.symbol??null,text,at:Date.now()})}catch{}
 if(e?.mode==='LIVE'&&SCALP_LIVE_TG_EVENTS.has(e?.type))void sendTradeTelegram(text);
}
const realTradeMessages=new WeakMap();
function prepareRealTradeMessage(e){
 if(!e?.fromFills)return Promise.resolve(null);
 const pending=realTradeMessages.get(e);if(pending)return pending;
 const read=readRealWallet().catch(()=>null);
 // Both transports use one post-confirmation snapshot. A slow wallet read cannot hold an alert indefinitely.
 let timer;
 const deadline=new Promise(resolve=>{timer=setTimeout(resolve,1500);timer.unref()});
 const message=Promise.race([read,deadline]).then(snapshot=>{
  if(snapshot)return realTradeMessage(e,{availableMargin:snapshot.available});
  const at=Date.now(),last=realWallet.last,recent=last&&at>=last.at&&at-last.at<=REAL_WALLET_MAX_AGE_MS;
  realWallet.lastAlertIssue={at,reason:snapshot===undefined?'BALANCE_READ_TIMEOUT':realWallet.error??'BALANCE_READ_FAILED',usedRecent:Boolean(recent)};
  if(!recent)realTradeMessages.delete(e);
  return realTradeMessage(e,recent?{availableMargin:last.available,availableMarginAt:last.at}:{});
 }).finally(()=>clearTimeout(timer));
 realTradeMessages.set(e,message);
 return message;
}
function confirmedRealTradeNotice(e){
 reportsDirty=true;
 void prepareRealTradeMessage(e).then(message=>{
  if(message)send('live-notice',{type:e.type,symbol:e.symbol??null,text:message.text,at:Date.now()});
 }).catch(()=>{});
}
let lastRealTradeTelegramAt=0;
const sendRealTradeRequest=createTelegramNetworkRecovery(telegramPost);
const lookupScannerChannel=createTelegramNetworkRecovery((payload,options)=>telegramPost(payload,{...options,method:'getChat'}));
let verifiedScannerChannelId=null,scannerChannelCheck=null;
function telegramDeliveryFailure(response,body,transport){
 const retrySeconds=Number(body?.parameters?.retry_after??response.headers.get('retry-after'));
 const error=response.status===401?'BOT_AUTH_FAILED':response.status===403?'BOT_POST_FORBIDDEN':/chat not found/i.test(body?.description??'')?'TELEGRAM_CHAT_NOT_FOUND':response.ok?'TELEGRAM_UNCONFIRMED':`HTTP_${response.status}`;
 return {error,transport,retryMs:retrySeconds>0?retrySeconds*1000:0};
}
async function resolveTradeTelegramDestination(){
 const existingChat=CONFIG.tgChat.trim();
 if(!CONFIG.tgToken||(!CONFIG.tgScannerChat&&!existingChat))return {paused:true,error:'TELEGRAM_NOT_CONFIGURED'};
 if(!CONFIG.tgScannerChat)return {chatId:existingChat};
 if(verifiedScannerChannelId!==null)return {chatId:verifiedScannerChannelId,chatType:'channel'};
 if(scannerChannelCheck)return scannerChannelCheck;
 scannerChannelCheck=(async()=>{
  const {response,error,transport}=await lookupScannerChannel({chat_id:CONFIG.tgScannerChat});
  if(!response)return {error,transport};
  const body=await response.json().catch(()=>null);
  if(!response.ok||body?.ok!==true)return telegramDeliveryFailure(response,body,transport);
  const {id,type}=body.result??{};
  if(type!=='channel'||!Number.isSafeInteger(id))return {error:'SCANNER_CHAT_NOT_CHANNEL',transport};
  verifiedScannerChannelId=id;
  return {chatId:id,chatType:'channel'};
 })().finally(()=>{scannerChannelCheck=null});
 return scannerChannelCheck;
}
async function sendTradeTelegram(text){
 if(persisted.notifySettings?.telegramLive===false)return;
 const {chatId:chat_id,paused,error:destErr}=await resolveTradeTelegramDestination();
 if(!chat_id||persisted.notifySettings?.telegramLive===false){if(!chat_id&&!paused)console.warn('[TRADE TELEGRAM]',destErr);return}
 let {response,error}=await sendRealTradeRequest({chat_id,text});
 if(!response||response.status===429){
  let retrySeconds=Number(response?.headers?.get?.('retry-after'));
  if(response?.status===429&&!(retrySeconds>0)){
   const body=await response.json().catch(()=>null);
   retrySeconds=Number(body?.parameters?.retry_after);
  }
  const waitMs=Math.min(60000,Math.max(3000,(Number.isFinite(retrySeconds)&&retrySeconds>0?retrySeconds:0)*1000));
  await new Promise(resolve=>setTimeout(resolve,waitMs));
  if(persisted.notifySettings?.telegramLive===false)return;
  ({response,error}=await sendRealTradeRequest({chat_id,text}));
 }
 if(!response?.ok)console.warn('[TRADE TELEGRAM]',error??`HTTP_${response?.status}`);
}
async function sendRealTradeTelegram(e){
 const message=await prepareRealTradeMessage(e);if(!message)return {error:'INVALID_ALERT'};
 const destination=await resolveTradeTelegramDestination();reportsDirty=true;
 if(!destination.chatId)return destination;
 const chat_id=destination.chatId;
 const delay=lastRealTradeTelegramAt+1050-Date.now();if(delay>0)await new Promise(resolve=>setTimeout(resolve,delay));
 lastRealTradeTelegramAt=Date.now();
 const {response:r,error:networkError,transport}=await sendRealTradeRequest({chat_id,...message});
 if(!r)return {error:networkError,transport};
 const body=await r.json().catch(()=>null);
 const chat=body?.result?.chat;
 const matchesDestination=!destination.chatType||(chat?.type===destination.chatType&&chat.id===chat_id);
 if(r.ok&&body?.ok===true&&Number.isInteger(body.result?.message_id)&&chat?.type&&matchesDestination)
  return {ok:true,transport,chatType:chat.type};
 return telegramDeliveryFailure(r,body,transport);
}
// Re-arm after a one-tap update (user request 2026-11-13): only when it was armed when the update
// started, within 15 minutes, on TESTNET, and with no kill switch. Real-money mode (LIVE) is never
// armed by itself; any other restart (reboot, crash) also starts disarmed.
{
 const marker=path.join(storage.dir,'rearm-after-update.json');
 let updateMarker=null;
 const restored=[];
 try{
  const m=JSON.parse(fs.readFileSync(marker,'utf8'));fs.rmSync(marker,{force:true});
  updateMarker=m;
  const fresh=Date.now()-Number(m?.at)<15*60000&&!live.store.killSwitch;
  if(fresh&&m.signalArmed!==false&&m?.mode==='TESTNET'&&LIVE.mode==='TESTNET'&&!TESTNET_SCALP_ONLY){live.arm();restored.push('신호 전략 ●');console.log('[LIVE] 업데이트 후 자동 활성화 (테스트넷)')}
  // Copy, real account included (user 2026-11-16 "실계좌도 알아서 켜주고"): only after the one-tap update,
  // only if it was on when the update started, same mode, copy enabled, its loss limit not hit.
  // Not when the user paused it (screen / Telegram /pause) or the real-account daily loss breaker holds (2026-11-23).
  if(copyRearmOnBoot({marker:m,now:Date.now(),copyMode:COPY.mode,copyEnabled:COPY.enabled,killSwitch:live.store.killSwitch,killed:copyTrader.store.killed,
   userPaused:copyTrader.store.userPaused,breakerTripped:COPY.mode==='LIVE'&&Boolean(realSafety?.isTripped())})){
   copyTrader.arm();restored.push(`${COPY.mode==='LIVE'?'실계좌':'테스트넷'} 카피 ●`);console.log(`[COPY] 업데이트 후 자동 활성화 (${COPY.mode==='LIVE'?'실계좌':'테스트넷'})`);
   if(copyTrader.store.deferredEntries.length)setTimeout(()=>{void copyTrader.reconcile().catch(()=>{}).then(()=>copyTrader.replayDeferred()).catch(e=>console.warn('[COPY REPLAY]',e.message))},2000).unref?.();
  }
  if(fresh&&m.scalpArmed===true){try{scalpExec.arm();restored.push('테스트넷 단타 ●');console.log('[SCALP] 업데이트 후 자동 활성화 (테스트넷)')}catch(e){console.warn('[SCALP] 복원 안 함:',e.message)}}
 }catch{}
 if(scalpLiveExec&&SCALP_LIVE_EXEC.mode==='LIVE'&&scalpLiveRearmOnBoot({marker:updateMarker,now:Date.now(),liveEnabled:true,autoRearm:scalpLiveExec.store.autoRearm,userPaused:scalpLiveExec.store.userPaused,dailyStopped:scalpLiveExec.isDailyStopped(),breakerTripped:Boolean(realSafety?.isTripped()),killSwitch:live.store.killSwitch})){
  try{scalpLiveExec.arm();restored.push('실계좌 단타 ●');console.log(`[SCALP:LIVE] ${updateMarker?'업데이트':'재시작'} 후 자동 활성화 (실계좌)`)}catch(e){console.warn('[SCALP:LIVE] 복원 안 함:',e.message)}
 }
 try{
  const postUpdateMsg=checkPostUpdateNotice({dir:storage.dir,appVersion,marker:updateMarker,restored});
  if(postUpdateMsg)setTimeout(()=>{updateNotice(postUpdateMsg)},3000).unref?.();
 }catch(e){console.warn('[UPDATE NOTICE]',e.message)}
}
// Shared real-account position operator (used by Telegram /close+#confirm and dashboard one-click actions).
// TRAIL_STOP / CANCEL_STOP are internal (real_trailing.mjs): the exchange lock stop and its clean-up; the HTTP route
// below accepts only the four screen actions.
async function executeRealPositionAction({symbol,direction=null,action,stopPrice=null,lossRoePct=null,closePct=null,feePct=null,replaceOrderId=null,replaceOrderIds=null,venueSymbol=null,orderId=null}={}){
 if(COPY.mode!=='LIVE'||!realBingxClient)return {ok:false,status:409,error:'LIVE_ACCOUNT_UNAVAILABLE',message:'실계좌 BingX 클라이언트가 연결되어 있지 않습니다'};
 if(!['CLOSE_ALL','CLOSE_HALF','BREAKEVEN_STOP','SET_STOP_LOSS','TRAIL_STOP','CANCEL_STOP'].includes(action))return {ok:false,status:400,error:'INVALID_ACTION',message:'지원하지 않는 포지션 작업입니다'};
 if(action==='CANCEL_STOP'){
  if(!venueSymbol||orderId==null)return {ok:false,status:400,error:'ORDER_REQUIRED',message:'취소할 스탑 주문이 없습니다'};
  try{await realBingxClient.cancelOrder(venueSymbol,String(orderId))}catch(e){return {ok:false,status:502,error:e?.code||'CANCEL_FAILED',message:e?.message||'스탑 주문 취소 실패'}}
  realOpenStops.at=0;return {ok:true,action,orderId:String(orderId)};
 }
 const mode=await readPositionMode(realBingxClient);
 if(!mode.ok)return {ok:false,status:502,error:mode.reason,message:'포지션 모드(단방향/헤지)를 확인하지 못했습니다'};
 const hedge=mode.hedge;
 const raw=venueRows(await realBingxClient.positions());
 if(!raw)return {ok:false,status:502,error:'POSITIONS_UNREADABLE',message:'거래소 포지션을 조회하지 못했습니다'};
 const markOf=vs=>Number(copyTickers.rows.find(x=>x.symbol===vs)?.lastPrice)||null;
 const open=raw.map(r=>normalizeVenuePosition(r,{markOf})).filter(Boolean);
 const normSym=String(symbol||'').trim().toUpperCase().replace(/[-_]/g,'');
 const normDisp=displaySymbol(normSym);
 const targets=normSym==='ALL'
  ?(action==='CLOSE_ALL'?open:[])
  :open.filter(p=>(p.symbol===normSym||displaySymbol(p.symbol)===normDisp)&&(!direction||p.direction===direction));
 if(!targets.length)return {ok:false,status:404,error:'POSITION_NOT_FOUND',message:'해당 조건의 보유 포지션이 없습니다'};
 if(action==='BREAKEVEN_STOP'||action==='SET_STOP_LOSS'||action==='TRAIL_STOP'){
  if(targets.length!==1)return {ok:false,status:400,error:'SINGLE_POSITION_REQUIRED',message:'손절 설정은 방향을 지정한 단일 포지션에만 적용됩니다'};
  const p=targets[0],dir=p.direction==='LONG'?1:-1;
  const mark=p.mark||markOf(p.venueSymbol);
  if(!(p.avg>0)||!(mark>0))return {ok:false,status:502,error:'PRICE_UNAVAILABLE',message:'현재가 또는 평단가를 확인하지 못했습니다'};
  const contracts=await venueQuotes.clients.BINGX.contractsFor(p.symbol).catch(()=>new Map());
  const c=resolveCopyContract(contracts,p.symbol)||contracts?.get?.(p.symbol)||[...(contracts?.values?.()||[])].find(x=>x?.venueSymbol===p.venueSymbol);
  let targetStop=null;
  if(action==='BREAKEVEN_STOP'){
   // Entry plus round-trip fees (audit 2026-11-23): a fill at the stop does not lose the fees.
   const fee=feePct!=null&&Number.isFinite(Number(feePct))&&Number(feePct)>=0?Number(feePct):(realTrailing?.status().roundTripFeePct??REAL_TRAILING_DEFAULTS.roundTripFeePct);
   const be=feeNetBreakevenPrice({avg:p.avg,direction:p.direction,feePct:fee});
   const beStop=c?.tickSize?roundDecimalToStep(be,c.tickSize,p.direction==='LONG'?'UP':'DOWN'):String(+be.toPrecision(8));
   if(!(dir*(mark-Number(beStop))>0))return {ok:false,status:409,error:'NOT_IN_PROFIT',message:'현재가가 평균 진입가+수수료보다 수익 구간에 있을 때만 본전 스탑을 걸 수 있습니다'};
   targetStop=beStop;
  }else if(action==='TRAIL_STOP'){
   const raw=Number(stopPrice);
   if(!(raw>0))return {ok:false,status:400,error:'INVALID_STOP_PRICE',message:'잠금 스탑 가격이 없습니다'};
   targetStop=c?.tickSize?roundDecimalToStep(raw,c.tickSize,p.direction==='LONG'?'DOWN':'UP'):String(+raw.toPrecision(8));
   if(!(dir*(mark-Number(targetStop))>0))return {ok:false,status:409,error:'STOP_PASSED',message:'현재가가 이미 잠금 스탑 가격을 지났습니다'};
  }else{
   const roe=Number(lossRoePct),explicit=Number(stopPrice);
   let rawStop=Number.isFinite(explicit)&&explicit>0?explicit:null;
   if(!rawStop&&Number.isFinite(roe)&&roe>=2&&roe<=90){
    const lev=Math.max(1,Number(p.leverage)||1);
    const ref=dir*(mark-p.avg)<0?mark:p.avg;
    rawStop=ref*(1-dir*(roe/100)/lev);
   }
   if(!(rawStop>0)||!(dir*(mark-rawStop)>0))return {ok:false,status:400,error:'INVALID_STOP_PRICE',message:'손절가는 현재가보다 손실 방향에 위치해야 합니다'};
   targetStop=c?.tickSize?roundDecimalToStep(rawStop,c.tickSize,p.direction==='LONG'?'DOWN':'UP'):String(+rawStop.toPrecision(6));
  }
  const oldStopIds=[...new Set([...(Array.isArray(replaceOrderIds)?replaceOrderIds:[]),...(replaceOrderId!=null?[replaceOrderId]:[])].filter(Boolean).map(String))];
  const stopPayload=cid=>({
   symbol:p.venueSymbol,side:p.direction==='LONG'?'SELL':'BUY',
   positionSide:positionSideFor({hedge,direction:p.direction}),
   type:'STOP_MARKET',quantity:String(p.size),stopPrice:String(targetStop),
   closePosition:'true',workingType:'MARK_PRICE',clientOrderId:cid,
  });
  const cid=((action==='BREAKEVEN_STOP'?'opbe':action==='TRAIL_STOP'?'optr':'opsl')+Date.now().toString(36)).slice(0,32);
  let placed,canceledBefore=false;
  const staleOrderIds=[],canceledOrderIds=[];
  try{
   placed=await realBingxClient.placeOrder(stopPayload(cid));
  }catch(e){
   // BingX allows only one closePosition stop per position (110406): cancel prior stop(s) first, then place once.
   if(action==='TRAIL_STOP'&&oldStopIds.length&&e?.code==='VENUE_ERROR_110406'){
    canceledBefore=true;
    for(const oid of oldStopIds){try{await realBingxClient.cancelOrder(p.venueSymbol,oid);canceledOrderIds.push(oid)}catch(ce){staleOrderIds.push(oid);console.warn('[REAL_TRAIL] pre-replace stop cancel',ce?.code||ce?.message)}}
    placed=await realBingxClient.placeOrder(stopPayload((cid.slice(0,30)+'r2').slice(0,32)));
   }else throw e;
  }
  realOpenStops.at=0;
  const newOrderId=(placed?.order??placed)?.orderId;
  // The lock stop moves up: the new one is in first, then the old ones are cancelled (never without a stop). Any
  // failed cancel is reported (staleOrderId / staleOrderIds) so real_trailing.mjs cleans it up when the position closes.
  if(action==='TRAIL_STOP'&&!canceledBefore&&oldStopIds.length){
   for(const oid of oldStopIds){
    if(oid===String(newOrderId??''))continue;
    try{await realBingxClient.cancelOrder(p.venueSymbol,oid);canceledOrderIds.push(oid)}catch(e){staleOrderIds.push(oid);console.warn('[REAL_TRAIL] old stop cancel',e?.code||e?.message)}
   }
  }
  const staleOrderId=staleOrderIds[0]??null;
  const label=action==='BREAKEVEN_STOP'?'본전 스탑(수수료 포함)':action==='TRAIL_STOP'?'트레일링 잠금 스탑':`손절 스탑${Number(lossRoePct)>0?` (-${Number(lossRoePct)}% ROE)`:''}`;
  return {ok:true,action,symbol:displaySymbol(p.symbol),direction:p.direction,stopPrice:Number(targetStop),orderId:newOrderId!=null?String(newOrderId):null,venueSymbol:p.venueSymbol,...(canceledOrderIds.length?{canceledOrderIds}:{}),...(staleOrderId?{staleOrderId,staleOrderIds}:{}),summary:`${displaySymbol(p.symbol)} ${p.direction==='LONG'?'롱':'숏'} ${label} 설정 (${targetStop} USDT)`};
 }
 const partPct=Number.isFinite(Number(closePct))&&Number(closePct)>0&&Number(closePct)<100?Math.round(Number(closePct)):50;
 const results=[];
 for(const p of targets){
  let qty=p.size;
  if(action==='CLOSE_HALF'){
   const contracts=await venueQuotes.clients.BINGX.contractsFor(p.symbol).catch(()=>new Map());
   const c=resolveCopyContract(contracts,p.symbol)||contracts?.get?.(p.symbol)||[...(contracts?.values?.()||[])].find(x=>x?.venueSymbol===p.venueSymbol);
   const step=c?.quantityStep,minQ=Number(c?.minQuantityBase)||0,minN=Number(c?.minNotionalUSDT)||0;
   const markPx=Number(p.mark)||Number(p.avg)||0;
   const rawQty=p.size*(partPct/100);
   qty=step?Number(roundDecimalToStep(rawQty,step,'DOWN')):rawQty;
   if(!(qty>0)||qty<minQ||qty>=p.size||(minN>0&&markPx>0&&qty*markPx<minN))return {ok:false,status:409,error:'HALF_QTY_TOO_SMALL',message:`${partPct}% 분할 수량(${qty})이 최소 주문 단위 미만입니다`};
  }
  const cid=('opcl'+Date.now().toString(36)+results.length).slice(0,32);
  await realBingxClient.placeOrder({
   symbol:p.venueSymbol,side:p.direction==='LONG'?'SELL':'BUY',
   ...sideParams({hedge,direction:p.direction,closing:true}),
   type:'MARKET',quantity:String(qty),clientOrderId:cid,
  });
  results.push(`${displaySymbol(p.symbol)} ${p.direction==='LONG'?'롱':'숏'} ${qty}`);
 }
 void refreshRealTradeNotices();
 return {ok:true,action,closePct:action==='CLOSE_HALF'?partPct:100,closed:results,summary:`${action==='CLOSE_HALF'?`${partPct}% 부분 청산`:'전량 청산'}: ${results.join(', ')}`};
}
async function runRealPanicFlat(confirm){
 if(COPY.mode!=='LIVE'||!realBingxClient)throw Object.assign(Error('실계좌 BingX 클라이언트가 연결되어 있지 않습니다'),{code:'LIVE_ACCOUNT_UNAVAILABLE',httpStatus:409});
 const r=await executeRealPanicFlat({
  confirm,
  client:realBingxClient,
  onDisarmAll:()=>{
   try{live.kill('PANIC_FLAT')}catch{}
   try{copyTrader.disarm({user:true})}catch{}
   try{scalpLiveExec?.disarm('KILL_SWITCH')}catch{}
  },
  sendText:sendTradeTelegram,
  log:(...a)=>console.warn('[PANIC_FLAT]',...a),
 });
 reportsDirty=true;
 void refreshRealTradeNotices();
 void readRealWallet().catch(()=>{});
 return r;
}
if(COPY.mode==='LIVE'){
 const sendAccountAlertTelegram=async text=>{
  if(!/<(?:b|pre)>[\s\S]*<\/(?:b|pre)>/.test(String(text||'')))return sendTradeTelegram(text);
  if(persisted.notifySettings?.telegramLive===false)return;
  const {chatId:chat_id,paused,error:destErr}=await resolveTradeTelegramDestination();
  if(!chat_id||persisted.notifySettings?.telegramLive===false){if(!chat_id&&!paused)console.warn('[TRADE TELEGRAM]',destErr);return}
  const {response,error}=await sendRealTradeRequest({chat_id,text,parse_mode:'HTML'});
  if(!response?.ok)console.warn('[TRADE TELEGRAM]',error??`HTTP_${response?.status}`);
 };
 accountAlerts=new AccountAlerts({
  directory:storage.dir,
  allowedChatId:CONFIG.tgChat,
  post:CONFIG.tgToken?telegramPost:null,
  sendText:sendAccountAlertTelegram,
  log:(...a)=>console.log(...a),
  getSnapshot:async()=>{
   const st=await copyLiveStatus();
   return {
    equityUSD:st.funds?.equity??null,availableUSD:st.funds?.available??null,
    positions:st.venuePositions??[],copy:st,marginUsage:realMarginAlert?.status()??null,
    copyClosed:copyTrader.store.closed,manualClosed:manualLedger?.store.closed??[],
    dailyByDay:dailyPnl?.status()?.byDay??null,
   };
  },
  getScalpStatus:async()=>scalpExec?.runtimeSummary?.()??null,
  getReadiness:async()=>readyReplyText(readySummary(),{lossLimits:readyLossLimits()}),
  onControls:patch=>{
   if(patch){copyControls.configure(patch);reportsDirty=true}
   return {controls:copyControls.status(),traderBalanceUSD:copyControls.effectiveTraderBalanceUSD(COPY.traderBalanceUSD)};
  },
  onPause:()=>copyTrader.disarm({user:true}),
  // /resume (after /confirm): never releases the copy loss-limit stop (`killed`, screen COPY_RESUME only) and never
  // arms while the daily loss breaker holds (user decision 2026-11-23 (c)).
  onResume:()=>{
   if(copyTrader.store.killed)return {ok:false,reason:'COPY_LOSS_LIMIT'};
   if(realSafety?.isTripped())return {ok:false,reason:'DAILY_LOSS_CIRCUIT_BREAKER'};
   if(copyControls.status().cooldownActive)copyControls.configure({clearCooldown:true});
   try{copyTrader.arm()}catch(e){return {ok:false,reason:e.code||'ARM_REFUSED'}}
   return {ok:true};
  },
  onClose:({symbol,direction})=>executeRealPositionAction({symbol,direction,action:'CLOSE_ALL'}),
  onPanic:()=>runRealPanicFlat(REAL_PANIC_CONFIRM_TOKEN),
 });
 // Margin usage alert (real_margin_alert.mjs): only with the real copy client; read only, alert only.
 if(copyClient?.mode==='LIVE')realMarginAlert=new RealMarginAlert({directory:storage.dir,env:process.env,
  send:text=>accountAlerts.sendToAllowedChat(text),log:(...a)=>console.warn(...a)});
 realTrailing=new RealTrailingManager({
  directory:storage.dir,
  executeAction:executeRealPositionAction,
  sendText:sendTradeTelegram,
  log:(...a)=>console.log('[REAL_TRAIL]',...a),
 });
 const checkRiskAndRoi=async()=>{
  if(!venuePositionsReader||!accountAlerts)return;
  try{
   const v=await venuePositionsReader.snapshot(realCopyPositions(),realScalpPositions());
   const positions=Array.isArray(v?.venuePositions)?v.venuePositions:[];
   // In the background, never awaited (review 2026-11-24): a slow balance read or Telegram send must not hold up the
   // daily-loss breaker and the trailing below; refresh() never runs twice at once and never rejects.
   if(realMarginAlert)void realMarginAlert.refresh(()=>readRealFunds(),{openCount:Array.isArray(v?.venuePositions)&&!v.venuePositionsError?positions.length:null});
   const eq=copyTrader.funds?.equity??null;
   await accountAlerts.checkRisk({equityUSD:eq,positions});
   await accountAlerts.checkPositions({positions});
   await accountAlerts.checkPositionSummary({positions});
   if(realSafety)await realSafety.evaluateDailyLoss({equityUSD:eq,dailyByDay:dailyPnl?.status()?.byDay??null,positions});
   // Only a fresh, successful venue read; scalp-managed positions run their own trailing + exchange hard stop.
   // Manual first (user 2026-11-25): manual positions are managed only when the lane has no user TP / SL, so the open
   // orders are read for the pass (a failed read leaves every manual position alone).
   if(realTrailing&&Array.isArray(v?.venuePositions)&&!v.venuePositionsError){
    const st=realTrailing.store,needOrders=st.enabled&&st.applyToManual&&v.venuePositions.some(p=>p.origin==='manual');
    const openOrders=needOrders?await listRealOpenOrders({client:realBingxClient}).catch(()=>null):null;
    await realTrailing.evaluate(v.venuePositions.filter(p=>p.origin!=='scalp'),Date.now(),{openOrders});
   }
  }catch(e){console.warn('[ALERTS]',e.message)}
 };
 const checkDaily=async()=>{
  if(!accountAlerts)return;
  try{
   const v=venuePositionsReader?await venuePositionsReader.snapshot(realCopyPositions(),realScalpPositions()):null;
   await accountAlerts.checkDailyReport({
    copyClosed:copyTrader.store.closed,manualClosed:manualLedger?.store.closed??[],
    dailyByDay:dailyPnl?.status()?.byDay??null,equityUSD:copyTrader.funds?.equity??null,
    openCount:Array.isArray(v?.venuePositions)?v.venuePositions.length:0,
   });
  }catch(e){console.warn('[ALERTS DAILY]',e.message)}
 };
 setInterval(()=>{void checkRiskAndRoi()},15000).unref?.();
 setInterval(()=>{void checkDaily()},60000).unref?.();
 setTimeout(()=>{void checkDaily()},25000).unref?.();
 if(CONFIG.tgToken&&CONFIG.tgChat)setInterval(()=>{void accountAlerts.pollCommands()},10000).unref?.();
}
// The venue's public mid price for a live record (screen and exit estimates only; never an order input).
function livePublicPrice(record){const book=venueBooks.get(record.venue+':'+record.symbol);return book?.ok&&Number.isFinite(book.mid)&&Date.now()-book.receivedAt<60000?book.mid:null}
function liveRecordPrice(record){const p=record.position;return p?.markPrice>0&&Date.now()-p.at<90000?p.markPrice:livePublicPrice(record)}
// Account equity for the 실매매 screen: read at most every 30 s, only while the screen asks for it.
const liveBalance={venue:null,usd:null,at:0,error:'',pending:null};
async function liveBalanceSnapshot(){
 const venue=LIVE.venues.find(v=>live.credentials()[v]);
 if(LIVE.mode==='OFF'||!venue)return null;
 if(LIVE.mode==='TESTNET'&&venue==='BINGX'&&hasTestnetBingx){
  await refreshTestnetBudgetBalance();
  const b=testnetBudget.status();
  return {venue,usd:b.balanceError?null:b.accountEquityUSD,at:b.balanceAt,error:b.balanceError,capUSD:LIVE.balanceCapUSD||null};
 }
 if(Date.now()-liveBalance.at>=30000&&!liveBalance.pending){
  liveBalance.pending=live.accountBalance(venue).then(usd=>Object.assign(liveBalance,{venue,usd:Number.isFinite(usd)?usd:null,error:''}),
   e=>Object.assign(liveBalance,{venue,error:e.code||'BALANCE_UNAVAILABLE'})).finally(()=>{liveBalance.at=Date.now();liveBalance.pending=null});
 }
 if(liveBalance.pending&&!liveBalance.at)await liveBalance.pending;
 return {venue:liveBalance.venue,usd:liveBalance.usd,at:liveBalance.at||null,error:liveBalance.error||null,capUSD:LIVE.balanceCapUSD||null};
}
const paper=new PaperEngine(persisted.paper,{settings:{...(persisted.paperSettings||{}),maxRiskUSD:CONFIG.maxRiskUSD,maxPositions:CONFIG.paperMaxPositions,maxPerDirection:CONFIG.paperMaxPositions/2,requireExecutionVenue:true,TP1_MOVE_STOP_TO_BREAKEVEN:persisted.paperSettings?.TP1_MOVE_STOP_TO_BREAKEVEN??process.env.TP1_MOVE_STOP_TO_BREAKEVEN!=='false',TP1_BREAKEVEN_MODE:persisted.paperSettings?.TP1_BREAKEVEN_MODE??process.env.TP1_BREAKEVEN_MODE??'ENTRY_FILL'},onChange:store=>{save({...persisted,paper:store});send('paper',{event:'updated',at:Date.now()});},onEvent:event=>{if(CONFIG.paperTrading)emitPaperNotice(event)}});
paperRef=paper;

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
   const contracts=await (client.contractsFor?client.contractsFor(symbol):client.loadContracts());if(!contracts.has(symbol))return null;
   const book=await client.book(symbol);venueBooks.set(key,book);
   if(venueBooks.size>1000){const oldest=venueBooks.keys().next().value;if(oldest&&oldest!==key)venueBooks.delete(oldest)}
   return book;
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
 try{return await task;}catch(e){
  if(apiCache.get(url)?.pending===task){if(cache?.data)apiCache.set(url,{data:cache.data,until:0});else apiCache.delete(url)}
  const msg=String(e?.message||'');
  const localOrSymbol=/^(?:BINANCE_PUBLIC_WEIGHT_BUDGET|BINANCE_PUBLIC_COOLDOWN)$/.test(msg)||/^Binance HTTP 40[04]\b/.test(msg);
  if(!localOrSymbol){state.rest='offline';state.error=msg}
  throw e;
 }
}
const exchangeInfo=()=>binance('/fapi/v1/exchangeInfo',15*60*1000);
// 고래 매물대 (whale_zones.mjs, user 2026-11-25 09:51 "단타에선 CVD 활용 방법이 매물대를 보는 거라고 생각하면 편할 것 같고"):
// Binance-listed coins only. One WhaleTradeStore for the process keeps each symbol's whale-class trades and reads only newer
// trades (then older ones back to the lookback start) on the shared PublicReadBudget: weight 20 a page, at most
// SCALP_WHALE_ZONE_MAX_PAGES pages a call, stops above 60 % of the budget, same symbol at most every 30 s, dropped after
// 15 min unused. Read with budgetedPublicRead, not binance(): a failed side read must not set state.rest='offline' /
// state.error (that blocks cryptoEntryAllowed and the paper scalp) nor keep pages in apiCache (review 2026-11-25).
// Edges scaled by the coin's 24h quote volume against BTC from the scanner's cached 24h tickers (no extra read).
const whaleTradeStore=new WhaleTradeStore();
function whaleZoneThresholds(symbol,scale){
 const qv=sym=>Number((rawMarketTickers||[]).find(t=>t?.symbol===sym)?.quoteVolume)||null;
 return whaleThresholds({mode:scale,quoteVolume24h:qv(symbol),referenceQuoteVolume24h:qv(WHALE_CVD_DEFAULTS.referenceSymbol)});
}
function scalpWhaleZones(symbol,{lookbackMs,endMs,scale='auto',maxPages=WHALE_ZONE_DEFAULTS.maxPages,reservePct=WHALE_ZONE_DEFAULTS.reservePct}={}){
 if(!state.activeSet.has(symbol))return {ok:false,error:'NOT_ON_BINANCE'};
 return whaleTradeStore.read(symbol,{request:url=>budgetedPublicRead(url,{budget:publicReadBudget,timeoutMs:WHALE_ZONE_DEFAULTS.timeoutMs}),budget:()=>publicReadBudget.snapshot(),
  thresholds:whaleZoneThresholds(symbol,scale),lookbackMs,endMs,maxPages,reservePct});
}
// ATR(1H) for GET /api/whale-zones (bin width / K): Binance 1H klines (weight 1) on the same budget path, 5 min per symbol.
const whaleAtrCache=new Map();
async function whaleZoneAtr(symbol){
 const hit=whaleAtrCache.get(symbol);if(hit&&Date.now()-hit.at<5*60000)return hit.atr;
 let atr=null;
 try{atr=ladderAtrPct(await budgetedPublicRead(`/fapi/v1/klines?symbol=${encodeURIComponent(symbol)}&interval=1h&limit=40`,{budget:publicReadBudget,timeoutMs:3000}),{now:Date.now()})}catch{}
 whaleAtrCache.set(symbol,{at:Date.now(),atr});if(whaleAtrCache.size>60)whaleAtrCache.delete(whaleAtrCache.keys().next().value);
 return atr;
}
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
 const chat_id=CONFIG.tgScannerChat||CONFIG.tgChat.trim();
 if(!CONFIG.tgToken||!chat_id)return;
 if(persisted.notifySettings?.telegramSignals===false)return; // switched off in 알림 설정
 try{
 // Final-results API is the source of truth. Any later quote/venue rejection
 // suppresses delivery even if an earlier scan approved the same candle.
 const matched=finalTelegramMatch(s,relevantSignals(),getSignalScorePolicy().finalMinScore);
 if(!matched)return;
 const urls=state.activeSet.has(matched.symbol)?officialMarketLinks(matched.symbol):null;
 if(!urls){console.warn('Telegram suppressed: market link not verified',s.symbol);return}
 const paperPosition=paper.store.open.find(p=>p.key===signalKey({market:'CRYPTO',symbol:matched.symbol,direction:matched.direction,pattern:matched.pattern,barAt:matched.patternConfirmedAt}));
 const payload={chat_id,...telegramMessage(matched,urls,{paperPosition})};
  const r=await telegramPost(payload);
  if(!r.ok)console.error('Telegram HTTP',r.status);
 }catch{console.error('Telegram delivery unconfirmed')}
}
// Shared Bot API transport for chat verification and posting notices.
function telegramPost(payload,{ipv4=false,method='sendMessage'}={}){
 const body=typeof payload?.text==='string'&&payload.text.length>4096?{...payload,text:payload.text.slice(0,4090)+'…'}:payload;
 const url=`https://api.telegram.org/bot${CONFIG.tgToken}/${method}`;
 if(ipv4)return postTelegramIPv4(url,body);
 return fetch(url,{
  method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(10000)});
}


const SERVER_BOOT_ID=String(Date.now());
let updateCheckPromise=null;
const GIT_UPDATE=gitUpdateAvailable(__dirname);
let updateJob={active:false,pct:0,label:''};
function emitUpdateProgress(){
 try{send('update-progress',{...updateJob,...appVersion,bootId:SERVER_BOOT_ID})}catch{}
}
// One update run, from the dashboard button or the automatic check (user 2026-11-16: "업데이트가 감지되면
// 자동 업데이트"). Never restarts in the middle of an order: new orders stop first, the restart waits until
// every executor is idle (no order, cancel or position check running), at most 10 minutes.
async function runGitUpdate(source='button'){
 if(updateJob.active)return {status:409,body:{error:'UPDATE_IN_PROGRESS',message:'업데이트가 이미 진행 중입니다.'}};
 if(!allIdle())return {status:409,body:{error:'ORDER_IN_PROGRESS',message:'주문 처리 중입니다. 잠시 뒤 다시 누르세요.'}};
 const wasArmed=live.armed;live.updating=true;live.disarm();
 const step=(pct,label)=>{updateJob={...updateJob,active:true,pct:Math.max(updateJob.pct||0,Math.round(pct*10)/10),label,at:Date.now()};emitUpdateProgress()};
 updateJob={active:true,pct:0,label:source==='auto'?'자동 업데이트 시작':'업데이트 시작',source,fromDisplayVersion:appVersion.displayVersion,startedAt:Date.now()};step(2,'GitHub에서 새 버전 확인');
 try{
  const nodeCheck=file=>new Promise((ok,fail)=>execFile(process.execPath,['--check',file],{timeout:30000},e=>e?fail(Error(path.basename(file)+': '+(String(e.message).split('\n')[1]||'문법 오류'))):ok()));
  // Every file parses, every import resolves, and server.mjs links with all its named imports
  // (link_check.mjs loads the modules without running them).
  const linkCheck=root=>new Promise((ok,fail)=>execFile(process.execPath,['--no-warnings','--experimental-vm-modules',path.join(root,'link_check.mjs'),path.join(root,'server.mjs')],{timeout:60000},(e,out,err)=>e?fail(Error(String(err||e.message).trim().split('\n').pop())):ok()));
  const result=await gitApply(__dirname,{onStep:(s,check)=>{
   if(s==='fetched'){updateJob={...updateJob,toDisplayVersion:check.latestDisplayVersion};step(12,'새 버전 받는 중')}
   else step(25,'새 버전 적용 · 파일 검사 시작');
  },
   checkSyntax:async root=>{await checkTree(root,{nodeCheck,onFile:(i,n)=>step(25+55*i/n,`파일 검사 ${i}/${n}`)});step(82,'모듈 연결 검사');await linkCheck(root);step(86,'검사 통과')}});
  if(result.state!=='applied'){updateJob={active:false,pct:100,label:result.state==='current'?'이미 최신 버전':'업데이트 중단',state:result.state,source,at:Date.now()};emitUpdateProgress();live.updating=false;if(wasArmed)live.arm();if(source==='auto'&&result.state!=='current')updateNotice(`⚠️ 자동 업데이트 중단: ${result.message||result.state}`);return {status:result.ok?200:409,body:result}}
  // User 2026-11-16 "업데이트 후 항상 전부 켜기": after an update everything is switched on, whatever it
  // was before (the guards at start-up still apply: kill switch, loss limit, mode, 15 min). Written just
  // before the restart, so a crash or manual restart before that finds no marker (review 2026-11-16).
  // Copy: not after a user pause (screen / Telegram /pause) and not while the real-account daily loss breaker holds
  // (audit 2026-11-23: COPY.enabled alone re-armed a breaker-stopped copy at the next 2-minute auto update).
  const copyRearmable=()=>copyRearmableNow({copyEnabled:COPY.enabled,userPaused:copyTrader.store.userPaused,killed:copyTrader.store.killed,
   breakerTripped:COPY.mode==='LIVE'&&Boolean(realSafety?.isTripped())});
  const scalpLiveRearmable=()=>Boolean(scalpLiveExec&&scalpLiveRearmableNow({liveEnabled:SCALP_LIVE_EXEC.mode==='LIVE',autoRearm:scalpLiveExec.store.autoRearm,userPaused:scalpLiveExec.store.userPaused,dailyStopped:scalpLiveExec.isDailyStopped(),breakerTripped:Boolean(realSafety?.isTripped()),killSwitch:live.store.killSwitch}));
  const writeMarker=()=>{const st={signalArmed:LIVE.mode==='TESTNET'&&!TESTNET_SCALP_ONLY,copyArmed:copyRearmable(),scalpArmed:!!scalpExec,scalpLiveArmed:scalpLiveRearmable()};
   try{fs.writeFileSync(path.join(storage.dir,'rearm-after-update.json'),JSON.stringify({mode:LIVE.mode,...st,copyMode:COPY.mode,at:Date.now(),from:result.from,to:result.to,fromDisplayVersion:result.fromDisplayVersion||appVersion.displayVersion,toDisplayVersion:result.toDisplayVersion||null,changes:(result.changes||[]).slice(0,8).map(c=>c.subject),source}))}catch{}};
  console.log('[UPDATE]',source,result.from,'→',result.to,'waiting for idle, then restarting');step(88,'진행 중인 주문 작업이 끝나기를 기다리는 중');
  (async()=>{for(let i=0;i<1200&&!allIdle();i++)await new Promise(r=>setTimeout(r,500));live.paused=true;
   // Paused only once idle; if never idle in 10 minutes the restart waits for the next try.
   if(allIdle()){writeMarker();step(92,'서버 재시작');process.kill(process.pid,'SIGTERM')}else{live.paused=false;live.updating=false;updateJob={...updateJob,active:false,state:'postponed',label:'주문 완료 후 자동 재시작 예정',at:Date.now()};emitUpdateProgress();pendingRestart={writeMarker,from:result.from,to:result.to,toDisplayVersion:result.toDisplayVersion||null,source};if(wasArmed)live.arm();try{fs.rmSync(path.join(storage.dir,'rearm-after-update.json'),{force:true})}catch{}console.warn('[UPDATE] not idle for 10 min, restart postponed (code is on disk, applied at the next restart)')}})();
  return {status:200,body:{...result,rearm:LIVE.mode==='TESTNET',rearmCopy:copyRearmable(),rearmScalp:!!scalpExec,rearmScalpLive:scalpLiveRearmable()}};
 }catch(e){updateJob={active:false,pct:100,label:'업데이트 실패',error:e.message,source,at:Date.now()};emitUpdateProgress();live.updating=false;if(wasArmed)live.arm();if(source==='auto')updateNotice(`⚠️ 자동 업데이트 실패: ${e.message}`);return {status:502,body:{error:e.message}}}
}
function updateNotice(text){try{if(CONFIG.tgToken&&CONFIG.tgChat)telegramPost({chat_id:CONFIG.tgChat,text,disable_web_page_preview:true}).catch(()=>{})}catch{}}
// Automatic update (AUTO_UPDATE=off disables): GitHub is checked every AUTO_UPDATE_EVERY_MS; a new version is
// applied with the same checks as the button. A failed version is not retried until a newer one appears.
const AUTO_UPDATE=!/^(off|0|false|no)$/i.test(String(process.env.AUTO_UPDATE||'on'));
// Checked every 2 minutes (user 2026-11-16: 10 felt slow); AUTO_UPDATE_EVERY_MIN 1~60.
const AUTO_UPDATE_EVERY_MS=Math.max(1,Math.min(60,Number(process.env.AUTO_UPDATE_EVERY_MIN)||2))*60000;
let autoUpdateFailedAt=null,pendingRestart=null;
if(GIT_UPDATE&&AUTO_UPDATE)setInterval(async()=>{
 try{if(updateJob.active||!allIdle()||scalpExec?.scanning||scalpLiveExec?.scanning)return;
  // A restart postponed earlier (never idle for 10 minutes): the new code is on disk; restart now when idle.
  if(pendingRestart){const was=live.armed;live.updating=true;live.disarm();live.paused=true;if(allIdle()){console.log('[UPDATE] postponed restart',pendingRestart.from,'→',pendingRestart.to);updateJob={active:true,pct:92,label:'서버 재시작',source:pendingRestart.source||'auto',fromDisplayVersion:appVersion.displayVersion,toDisplayVersion:pendingRestart.toDisplayVersion||null,at:Date.now()};emitUpdateProgress();pendingRestart.writeMarker();process.kill(process.pid,'SIGTERM');return}live.paused=false;live.updating=false;if(was)live.arm();return}
  const c=await gitCheck(__dirname);if(c?.state!=='available'||c.latest===autoUpdateFailedAt)return;
  const r=await runGitUpdate('auto');if(r.status>=400&&(r.body?.state==='rolled-back'||r.body?.state==='diverged'))autoUpdateFailedAt=c.latest}catch(e){console.warn('[UPDATE] auto check:',e.message)}
},AUTO_UPDATE_EVERY_MS).unref?.();

// Telegram readiness reports are limited to the real-account mode.
const readinessFile=path.join(storage.dir,'readiness.json');
const readiness=()=>liveReadiness([...live.store.records,...(live.store.archived||[])],{mode:LIVE.mode==='LIVE'?'LIVE':'TESTNET',
 since:Number.isFinite(Date.parse(process.env.LIVE_READINESS_SINCE||''))?Date.parse(process.env.LIVE_READINESS_SINCE):undefined,balanceUSD:LIVE.balanceCapUSD>0?LIVE.balanceCapUSD:undefined,strategyProfile:LIVE.strategyProfile||null});
async function readinessReport(){
 if(LIVE.mode!=='LIVE'||!CONFIG.tgToken||!CONFIG.tgChat)return;
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
// Results upload (reports_push.mjs): once a day after 03:00 KST (the daily check runs at about 04:00 KST)
// and after new journal entries. Copy (real account and testnet) and scalp ledgers are read from their files.
const REPORTS_DIR=process.env.SIGNAL_LAB_REPORTS_DIR||path.join(path.dirname(storage.dir),'reports');
const REPORTS_KEY=path.join(path.dirname(storage.dir),'.ssh','reports_ed25519');
let reportsDay=null,reportsDirty=false,reportsBusy=false;
function reportLedgers(){
 const read=f=>{try{const file=path.join(storage.dir,f);return fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):null}catch{return null}};
 const equity=mode=>COPY.mode===mode?copyTrader?.funds?.equity??null:null;
 const pack=(f,mode)=>{const store=read(f);return store?{store,equityUSD:mode?equity(mode):null,
  ...(mode&&mode===COPY.mode&&f!==MANUAL_LEDGER_FILE?{settlementOf:p=>copyTrader.settlementStatus(p)}:{})}:null};
 return {copyLive:pack('copy-store-live.json','LIVE'),manualLive:pack(MANUAL_LEDGER_FILE,'LIVE'),copyTestnet:pack('copy-store.json','TESTNET'),scalp:pack('scalp-store.json',null)};
}
// Exact results from BingX itself (user 2026-11-17 "수익률이 얼마인지 정확하게"): income + balance of the real
// account (copy) and the testnet account, since the dates below (KST); read-only.
const EXCHANGE_PNL_SINCE={live:Date.parse(process.env.EXCHANGE_PNL_LIVE_SINCE||'2026-11-14T00:00:00+09:00'),testnet:Date.parse(process.env.EXCHANGE_PNL_TESTNET_SINCE||'2026-11-12T00:00:00+09:00')};
let reportsHour=null;
async function exchangeReport(){
 const testnetClient=scalpClient||(LIVE.mode==='TESTNET'?live.clients.BINGX:null);
 const out={};
 if(COPY.mode==='LIVE'&&copyClient)out.live=await exchangePnl(copyClient,{since:EXCHANGE_PNL_SINCE.live});
 if(testnetClient)out.testnet=await exchangePnl(testnetClient,{since:testnetHistoryReset?.at??EXCHANGE_PNL_SINCE.testnet});
 return Object.keys(out).length?out:null;
}
async function uploadReport(force=false){
 if(reportsBusy||!fs.existsSync(path.join(REPORTS_DIR,'.git')))return;
 const day=new Date(Date.now()+9*3600000).toISOString().slice(0,10),hour=new Date(Date.now()+9*3600000).getUTCHours();
 const hourKey=day+' '+hour; // hourly as well, so the exchange result stays fresh
 if(!force&&!reportsDirty&&!(hour>=3&&reportsDay!==day)&&reportsHour===hourKey)return;
 reportsBusy=true;
 try{
  let scalpExport=null;try{scalpExport=scalpExec?scalpReportFiles({journalFile:scalpExec.journalFile,signalsFile:scalpExec.signalsFile}):null}catch(e){console.warn('[REPORTS] scalp',e.message)}
  const exchange=await exchangeReport().catch(e=>({error:e.message}));
  if(hasTestnetBingx)await refreshTestnetBudgetBalance();
  const report=buildReport({readiness:readiness(),insights:patternInsights(persisted.journal.filter(x=>x.source==='LIVE_AUTO'&&x.review).map(x=>x.review)),
   journal:persisted.journal,records:[...live.store.records,...(live.store.archived||[])],
   // 되돌림 단타 journal (user 2026-11-16 22:18): summary in latest.json, full trades and daily signals as files.
   scalp:scalpExport?.summary??null,ledgers:reportLedgers(),exchange});
  report.release=appVersion.displayVersion;
  if(testnetHistoryReset)report.testnetHistoryReset={at:testnetHistoryReset.at,removed:testnetHistoryReset.removed};
  if(manualLedger)report.manualAlerts={...manualLedger.alertStatus(),
   availableMargin:{lastReadAt:realWallet.last?.at??null,lastAlertIssue:realWallet.lastAlertIssue},
   telegram:{...manualLedger.telegramStatus(),
    enabled:true,configured:Boolean(CONFIG.tgToken&&(CONFIG.tgScannerChat||CONFIG.tgChat.trim())),
    destination:CONFIG.tgScannerChat?'SCANNER_CHANNEL':'CONFIGURED_CHAT'}};
  if(hasTestnetBingx){const b=testnetBudget.status();report.testnetBudget={equityUSD:b.equityUSD,accountEquityUSD:b.accountEquityUSD,balanceAt:b.balanceAt,
   balanceAsset:b.balanceAsset,balanceRefreshMs:TESTNET_BALANCE_REFRESH_MS,balanceError:b.balanceError,dailyLossPct:b.dailyLossPct,limitUSD:b.limitUSD,marginCapPct:b.marginCapPct,marginCapUSD:b.marginCapUSD}}
  if(COPY.mode==='LIVE'){
   report.copyAudit=copyTrader.auditStatus();
   const cs=copyTrader.status();
   report.copySizing={mode:cs.sizing,balanceBasis:'AVAILABLE_MARGIN',traderBalanceUSD:cs.traderBalanceUSD,
    equityUSD:cs.funds?.equity??null,availableUSD:cs.funds?.available??null,
    ratioPct:cs.effectiveRatio!=null?+(cs.effectiveRatio*100).toFixed(2):null};
  }
  report.newsTranslation={provider:NEWS_PROVIDER.providerId,translated:state.newsTranslation?.done??null,total:state.newsTranslation?.total??null};
  if(report.scalp)report.scalp.runtime=scalpExec.runtimeSummary();
  // 급변 알림: count, fade / follow averages after costs by horizon, and the testnet scalp trades it triggered.
  // 급변 알림 초단타: its own stats and the per-alert calibration list (last 200: fade best / worst by horizon, 1m ATR %, R,
  // confirmation, opposite candle, mode A / B hypothetical results, both strategies' decisions).
  try{report.pumpAlerts={...pumpBook.summary(),scalpTrades:scalpExec.stats().byTrigger?.PUMP_ALERT??null,pumpFadeTrades:pumpFade.stats(),
   pumpFade:{mode:pumpFade.config.mode,refused:pumpFade.config.refused,on:pumpFade.status().on,rules:pumpFade.rules(),open:pumpFade.store.open.length},alerts:pumpAlertRows(pumpBook.records)}}catch(e){console.warn('[REPORTS] pump',e.message)}
  // 실계좌 준비 점검: every group's criteria, values and the trade window measured (for a re-check on the same trades).
  try{report.liveReadiness=readyNotifier.status(readySummary())}catch(e){console.warn('[REPORTS] readiness',e.message)}
  const r=await pushReport(REPORTS_DIR,report,{keyFile:fs.existsSync(REPORTS_KEY)?REPORTS_KEY:null,files:scalpExport?.files??{}});
  reportsDay=day;reportsHour=hourKey;reportsDirty=false;if(r.pushed)console.log('[REPORTS] 결과 업로드',r.day);
 }catch(e){console.error('[REPORTS]',e.message)}finally{reportsBusy=false}
}
setInterval(()=>{void uploadReport()},15*60000).unref?.();setTimeout(()=>{void uploadReport(true)},90000).unref?.();
// Live trade notices to Telegram (live_telegram.mjs), on unless switched off in 알림 설정.
function liveTelegramNotice(record,type,detail){
 if(record?.mode==='LIVE'&&record.venue==='BINGX'&&['PROTECTED','ADD_FILLED','SETTLED'].includes(type)){refreshRealTradeNotices();return}
 const text=liveEventText(record,type,detail);if(!text)return;
 // Open dashboards show it as a Chrome/system notification (public/app.js 'live-notice').
 try{send('live-notice',{type,symbol:record?.symbol??null,text,at:Date.now()})}catch{}
 if(record?.mode==='LIVE'&&record.test!==true)void sendTradeTelegram(text);
}
async function checkSoftwareUpdate(){
 if(updateCheckPromise)return updateCheckPromise;
 updateCheckPromise=(async()=>{
  if(!CONFIG.updateManifestURL){state.update={state:'unconfigured',lastCheck:Date.now(),message:'배포 서버 URL 미설정 — 자동 업데이트 비활성'};return state.update}
  const currentVersion=appVersion.version;
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
 if(venueKlineCache.size>600){const now=Date.now();for(const [k,v]of venueKlineCache){if(!v.pending&&v.until<now)venueKlineCache.delete(k);if(venueKlineCache.size<=500)break}while(venueKlineCache.size>600){const oldest=venueKlineCache.keys().next().value;if(!oldest||oldest===key)break;venueKlineCache.delete(oldest)}}
 try{const rows=await pending;venueKlineCache.set(key,{rows,until:Date.now()+ttl});return rows}catch(e){if(venueKlineCache.get(key)?.pending===pending)venueKlineCache.delete(key);throw e}
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
 const nextSeen={...persisted.seen,[key]:now};
 const seenKeys=Object.keys(nextSeen);
 if(seenKeys.length>5000){
  const cutoff=now-14*86400000;
  for(const k of seenKeys)if(k!==key&&!(Number(nextSeen[k])>cutoff))delete nextSeen[k];
  const remaining=Object.keys(nextSeen);
  if(remaining.length>5000){remaining.sort((a,b)=>(Number(nextSeen[a])||0)-(Number(nextSeen[b])||0));for(const k of remaining.slice(0,remaining.length-5000))if(k!==key)delete nextSeen[k]}
 }
 save({...persisted,seen:nextSeen,alerts:[item,...persisted.alerts].slice(0,200)});
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
const liveSockets=[];let liveSubscriptionKey='';let streamRequestId=1;let liveSocketsStartedAt=0;
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
 if(!monitored.length){for(const ws of liveSockets){try{ws.close()}catch{}}liveSockets.length=0;liveSubscriptionKey='';liveSocketsStartedAt=0;state.liveWS='offline';state.liveWatched=0;return}
 const streams=[...monitored.map(s=>s.toLowerCase()+'@kline_1h'),...monitored.map(s=>s.toLowerCase()+'@kline_4h')];
 const key=streams.join('|');if(key===liveSubscriptionKey&&liveSockets.some(ws=>ws.readyState===WebSocket.OPEN))return;
 liveSubscriptionKey=key;for(const ws of liveSockets){try{ws.close()}catch{}}liveSockets.length=0;liveSocketsStartedAt=Date.now();
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
// A connected socket alone is not proof of live candle events; recover a silent or stuck-connecting feed.
setInterval(()=>{
 if(!state.activeSet.size&&!state.researchSet.size)return;
 if(liveSockets.length&&liveSockets.every(ws=>ws.readyState===WebSocket.CONNECTING)&&liveSocketsStartedAt&&Date.now()-liveSocketsStartedAt>30000){
  state.liveWS='offline';state.liveLastError='봉 스트림 연결 지연(30초 초과) · 재구독';console.warn('[LIVE] Stuck CONNECTING socket, resubscribing');recoverLive();send('status',getStatus());return;
 }
 if(!liveSockets.some(ws=>ws.readyState===WebSocket.OPEN))return;
 const last=state.lastLiveDataAt||state.lastMarketListings;
 if(last&&Date.now()-last>90000){state.liveWS='offline';state.liveLastError='봉 데이터 90초 이상 미수신 · 재구독';console.warn('[LIVE] No candle data received, resubscribing');recoverLive();send('status',getStatus())}
},30000);
// Force rebuilding of sockets after an unexpected close. Does not affect symbol validation.
const _refreshSubscriptions=refreshLiveSubscriptions;
function recoverLive(){if(state.activeSet.size||state.researchSet.size){liveSubscriptionKey='';_refreshSubscriptions()}}

let marketWs, marketWsStartedAt=0, retryMs=1500; const changed=new Map();
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
  state.ws='connecting';marketWsStartedAt=Date.now();send('status',getStatus());
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
 if(marketWs&&marketWs.readyState===WebSocket.CONNECTING&&marketWsStartedAt&&Date.now()-marketWsStartedAt>30000){
  state.ws='offline';state.error='WebSocket 연결 지연(30초 초과) · 재연결';
  console.warn('[WEBSOCKET] Stuck CONNECTING socket; forcing reconnect');
  try{marketWs.close()}catch{};send('status',getStatus());return;
 }
 const tracking=paper.store.open.some(x=>x.market==='CRYPTO')||paper.store.pending.some(x=>x.market==='CRYPTO');
 if(!state.activeSet.size&&!state.researchSet.size&&!tracking||!marketWs||marketWs.readyState!==WebSocket.OPEN)return;
 if((state.lastTickerAt && Date.now()-state.lastTickerAt>90000)||(!state.lastTickerAt && marketWs.readyState===WebSocket.OPEN && (state.activeSymbols.length||state.researchSymbols.length||tracking) && Date.now()-state.lastMarket>90000)){
  state.ws='offline';state.error='실시간 유효 시세가 90초 이상 수신되지 않아 WebSocket을 재연결합니다';
  console.warn('[WEBSOCKET] Stale market feed; forcing reconnect');
  try{marketWs.close()}catch{};send('status',getStatus());
 }
},30000);
function getScanFunnel(){return describeScanFunnel(state.analyses,{activeSymbols:state.activeSymbols,researchSymbols:state.researchSymbols,assess:row=>assessAnalysis(row)});}
function getStatus(){return {scorePolicy:getSignalScorePolicy(),storage:{...storageHealth},...appVersion,publicReadBudget:publicReadBudget.snapshot(),integrationVersion:'ISSUE6',sharedData:{dir:storage.dir,separateEnv:path.dirname(storage.envPath)!==storage.dir,pcs:sharedCheck.hosts.map(h=>({host:h.host,lastAt:h.lastAt,current:h.current})),conflicts:sharedCheck.conflicts,sharedEnvLeft:Boolean(storage.sharedEnvLeft)},venueOnly:{enabled:CONFIG.venueOnly.enabled,...state.venueOnlyInfo,referenceRatio:CONFIG.venueOnly.referenceRatio,references:CONFIG.venueOnly.references,symbols:[...state.venueOnlySet].slice(0,40)},live:{mode:LIVE.mode,armed:live.armed,killSwitch:live.store.killSwitch},paperTrading:CONFIG.paperTrading,paperVenues:CONFIG.paperVenues,venueRefreshAt:state.venueRefreshAt||0,venueError:state.venueError||'',chartReference:'BINANCE',analysisVenue:'BINANCE',actualOrdersEnabled:false,scanCoverage:{mode:'WATCHLIST_HOT_AND_ROTATING_BATCH',totalContracts:state.activeSymbols.length,hotBatch:CONFIG.hotBatch,rotatingBatch:CONFIG.rotatingBatch,intervalMs:CONFIG.scanMs,fourHourHistory:301,liveEventTimeframes:['1h','4h']},scanMode:state.scanMode,scanFunnel:getScanFunnel(),structureCount:recentStructures().length,historicalCount:recentHistory().length,researchCount:state.researchSymbols.length,verifiedAt:state.lastValidatedAt,rest:state.rest,ws:state.ws,binancePerps:state.binancePerps,error:state.error,activeCount:state.activeSymbols.length,scannedTotal:state.analyses.size,
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
 const r=await fetch(endpoint,{method:'POST',redirect:'error',headers:{'Content-Type':'application/json'},body:JSON.stringify({q:text,source:'auto',target:'ko',format:'text'}),signal});
 if(!r.ok)throw Error('TRANSLATION_HTTP');const result=await r.json();return {translatedText:result.translatedText};
}
const aiTranslateNews=CONFIG.newsTranslation?createOpenAINewsTranslator({
 apiKey:process.env.NEWS_OPENAI_API_KEY?.trim()||process.env.OPENAI_API_KEY?.trim(),
 model:process.env.NEWS_OPENAI_MODEL?.trim()||undefined,
}):null;
const NEWS_PROVIDER=!CONFIG.newsTranslation?{providerId:'UNCONFIGURED'}:aiTranslateNews?{translateBatch:aiTranslateNews,providerId:'OPENAI'}
 :CONFIG.translationURL?{translate:translateArticle,providerId:'CONFIGURED_LIBRETRANSLATE'}:{translate:googleTranslate,providerId:'GOOGLE_PUBLIC'};
let newsBootstrapped=false;
async function readLimitedBody(res,maxBytes){
 if(!res?.body?.getReader){const text=await res.text();if(text.length>maxBytes)throw Error('Invalid or oversized XML');return text}
 const reader=res.body.getReader(),chunks=[];let total=0;
 try{
  while(true){
   const {done,value}=await reader.read();if(done)break;
   const buf=Buffer.from(value);total+=buf.length;
   if(total>maxBytes){try{await reader.cancel()}catch{}throw Error('Invalid or oversized XML')}
   chunks.push(buf);
  }
 }finally{try{reader.releaseLock?.()}catch{}}
 return Buffer.concat(chunks,total).toString('utf8');
}
async function pollNews(){
 const settled=await Promise.allSettled(FEEDS.map(async feed=>{
  const controller=new AbortController();const t=setTimeout(()=>controller.abort(),11000);
  try{const res=await fetch(feed.url,{headers:{'Accept':'application/rss+xml, application/xml, text/xml','User-Agent':'Mozilla/5.0 SignalLabRSS/4.0'},signal:controller.signal});
   if(!res.ok)throw Error('HTTP '+res.status);const body=await readLimitedBody(res,1800000);if(body.length>1800000||!/<(?:rss|feed|item)\b/i.test(body))throw Error('Invalid or oversized XML');
   return {name:feed.name,body};
  }finally{clearTimeout(t)}
 }));
 const feeds=settled.filter(x=>x.status==='fulfilled').map(x=>x.value);
 state.newsSources=feeds.map(x=>x.name);state.newsChecked=Date.now();
 const failures=settled.filter(x=>x.status==='rejected').map((x,i)=>x.reason?.message||'feed rejected');
 state.newsError=failures.length?`${failures.length}/${FEEDS.length}개 소스 오류`:'';
 if(!feeds.length){state.newsStatus='offline';send('news',{status:state.newsStatus,checked:state.newsChecked,articles:state.news,sourceCount:0,error:'RSS 제공처 모두 연결 실패'});return}
 const originalNews=prepareNews(feeds,state.newsChecked,state.ranked.map(x=>({symbol:x.baseAsset,name:x.baseAsset})));
 // One AI request per article groups its title and source excerpts. The per-text cache serves later polls.
 const incoming=await translateNewsArticles(originalNews,{...NEWS_PROVIDER,timeoutMs:10000,budgetMs:45000});
 {const need=incoming.filter(a=>a.translation?.status!=='NOT_REQUIRED'),done=need.filter(a=>['COMPLETE','PARTIAL'].includes(a.translation?.status)).length;
  const error=NEWS_PROVIDER.providerId==='GOOGLE_PUBLIC'?googleTranslateStatus.lastError:incoming.find(a=>a.translation?.status==='ERROR')?.translation.errorCode??null;
  state.newsTranslation={provider:NEWS_PROVIDER.providerId,done,total:need.length,error,checkedAt:Date.now()};
  if(need.length)console.log(`[NEWS] ${NEWS_PROVIDER.providerId} 한국어 번역 ${done}/${need.length}건${done<need.length&&error?` · 최근 실패: ${error}`:''}`)}
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
 const chunks=[];let totalBytes=0,settled=false;
 const timer=setTimeout(()=>{req.pause();settle(reject,clientError('Request body timeout',408))},15000);
 timer.unref?.();
 const settle=(fn,value)=>{if(settled)return;settled=true;clearTimeout(timer);fn(value)};
 req.on('data',chunk=>{if(settled)return;const buf=Buffer.isBuffer(chunk)?chunk:Buffer.from(String(chunk));totalBytes+=buf.length;if(totalBytes>32768){req.pause();settle(reject,clientError('Body too large',413));return}chunks.push(buf)});
 req.on('end',()=>{
  let value;try{value=JSON.parse(Buffer.concat(chunks,totalBytes).toString('utf8'))}catch{return settle(reject,clientError('Invalid JSON',400))}
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
  const proxied=isProxiedRequest(req.headers);
  const requireProxyAuth=proxied&&(allowedTailscaleUsers.size>0||Boolean(proxyPassword));
  if(lanMode||requireProxyAuth){
   const authKey=String(req.headers['x-forwarded-for']||'').split(',')[0].trim()||req.socket.remoteAddress||'unknown';
   const lock=authLimiter.isBlocked(authKey);
   if(lock.blocked){
    res.writeHead(429,{'Retry-After':String(Math.max(1,Math.ceil(lock.retryAfterMs/1000))),'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store',...SECURITY_HEADERS});
    res.end(JSON.stringify({error:'AUTH_RATE_LIMITED',retryAfterMs:lock.retryAfterMs}));return;
   }
   const activePassword=lanMode?lanPassword:proxyPassword;
   const ok=authorizedRequest(req.socket.remoteAddress,req.headers.authorization,activePassword,{headers:req.headers,allowedTailscaleUsers,requireProxyAuth});
   if(!ok){
    authLimiter.recordFailure(authKey);
    res.writeHead(401,{'WWW-Authenticate':'Basic realm="Signal Lab mobile - username signal", charset="UTF-8"','Content-Type':'text/plain; charset=utf-8','Cache-Control':'no-store',...SECURITY_HEADERS});
    res.end('Signal Lab: 모바일 접속 인증이 필요합니다. PC 실행 창에 표시된 사용자명(signal)과 접속 암호를 입력하세요.');return;
   }
   authLimiter.recordSuccess(authKey);
  }
  if(pathname==='/events'){
   if(state.clients.size>=64)return response(res,503,{error:'TOO_MANY_SSE_CLIENTS'});
   res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache, no-transform','Connection':'keep-alive','X-Accel-Buffering':'no',...SECURITY_HEADERS});
   const pulse=setInterval(()=>{if(res.destroyed||res.writableEnded||res.writableLength>512_000){dropSseClient(res);return}try{res.write(': heartbeat\n\n')}catch{dropSseClient(res)}},20000);
   pulse.unref?.();
   res._sseCleanup=()=>clearInterval(pulse);
   state.clients.add(res);
   try{res.write(`event: status\ndata: ${JSON.stringify(getStatus())}\n\n`)}catch{dropSseClient(res);return}
   const onClose=()=>dropSseClient(res);
   req.on('close',onClose);res.on('close',onClose);res.on('error',onClose);return;
  }
  if(pathname.startsWith('/api/internal/supervisor/')){
   const loopback=['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
   if(!loopback||!process.env.SIGNAL_LAB_SUPERVISOR_TOKEN||!safeTokenEqual(req.headers['x-signal-lab-supervisor'],process.env.SIGNAL_LAB_SUPERVISOR_TOKEN))return response(res,403,{error:'supervisor authentication required'});
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
  // Paper scalp scanner state, plus the testnet reversal-scalp executor (scalp_executor.mjs) under `testnet`.
  if(pathname==='/api/scalp'&&req.method==='GET')return response(res,200,{...scalpState,testnet:await scalpExec.liveStatus()});
  // Trade journal (newest lines, oldest first): ?limit=N (default 200, max 2000); ?kind=signals for detected signals.
  if(pathname==='/api/scalp/journal'&&req.method==='GET'){const n=Math.max(1,Math.min(2000,Math.floor(Number(url.searchParams.get('limit')))||200));
   const kind=url.searchParams.get('kind')==='signals'?'signals':'trades',lines=kind==='signals'?scalpExec.signals(n):scalpExec.journal(n);return response(res,200,{kind,limit:n,count:lines.length,lines})}
  if(pathname==='/api/scalp/simulate'&&req.method==='GET'){
   const q=url.searchParams;
   const params={
    days:q.get('days')??7,
    minMovePct:q.get('minMovePct')??5,
    trendMode:q.get('trendMode')??'on',
    zoneSignals:q.get('zoneSignals')??'true',
    minNetRR:q.get('minNetRR')??0,
    minScore:q.get('minScore')??0,
    sides:q.get('sides')??'LONG,SHORT',
   };
   const days=Math.max(1,Math.min(30,Math.floor(Number(params.days))||7));
   return response(res,200,simulateScalpSignals({
    signals:scalpExec.recentSignals(days),
    trades:scalpExec.recentTrades(days),
    params,
    now:Date.now(),
   }));
  }
  if(pathname==='/api/scalp/arm'&&req.method==='POST'){const body=await bodyJson(req);if(body.confirm!=='SCALP_ARM')return response(res,400,{error:'CONFIRM_REQUIRED'});
   if(updateJob.active||live.updating||shuttingDown)return response(res,409,{error:'UPDATE_IN_PROGRESS'});
   try{return response(res,200,scalpExec.arm())}catch(e){return response(res,e.httpStatus||409,{error:e.code||e.message})}}
  if(pathname==='/api/scalp/disarm'&&req.method==='POST')return response(res,200,scalpExec.disarm());
  if(pathname==='/api/scalp/live'&&req.method==='GET'){
   if(!scalpLiveExec)return response(res,200,{mode:SCALP_LIVE_EXEC.mode,refused:SCALP_LIVE_EXEC.refused,armed:false,configured:false});
   return response(res,200,{...(await scalpLiveExec.liveStatus()),configured:true});
  }
  if(pathname==='/api/scalp/live/arm'&&req.method==='POST'){
   const body=await bodyJson(req);
   if(body.confirm!=='SCALP_LIVE_ARM')return response(res,400,{error:'CONFIRM_REQUIRED'});
   if(updateJob.active||live.updating||shuttingDown)return response(res,409,{error:'UPDATE_IN_PROGRESS'});
   if(!scalpLiveExec||SCALP_LIVE_EXEC.mode!=='LIVE')return response(res,409,{error:SCALP_LIVE_EXEC.refused||'SCALP_MODE_OFF'});
   if(realSafety?.isTripped())return response(res,409,{error:'DAILY_LOSS_CIRCUIT_BREAKER',message:'오늘 일일 손실 차단이 발동 중입니다. 계좌 안전 가드에서 차단 해제 후 다시 시도하세요'});
   try{return response(res,200,scalpLiveExec.arm())}catch(e){return response(res,e.httpStatus||409,{error:e.code||e.message})}
  }
  if(pathname==='/api/scalp/live/disarm'&&req.method==='POST'){
   return response(res,200,scalpLiveExec?scalpLiveExec.disarm():{mode:SCALP_LIVE_EXEC.mode,armed:false});
  }
  if(pathname==='/api/scalp/live/close'&&req.method==='POST'){
   const body=await bodyJson(req);
   if(body.confirm!=='SCALP_LIVE_CLOSE')return response(res,400,{error:'CONFIRM_REQUIRED'});
   if(!scalpLiveExec||SCALP_LIVE_EXEC.mode!=='LIVE')return response(res,409,{error:SCALP_LIVE_EXEC.refused||'SCALP_MODE_OFF'});
   const r=await scalpLiveExec.closePosition(String(body.id||''));
   return response(res,r.ok?200:(r.status||409),r);
  }
  if(pathname==='/api/copy'&&req.method==='GET')return response(res,200,await copyLiveStatus());
  if(pathname==='/api/copy/recheck-settlement'&&req.method==='POST'){
   if(COPY.mode!=='LIVE'||!copyClient)return response(res,409,{error:'LIVE_SETTLEMENT_UNAVAILABLE'});
   const running=Boolean(historyRefresh);void refreshTradeHistory({recheck:true});return response(res,202,{running:true,started:!running});
  }
  if(pathname==='/api/copy/resume'&&req.method==='POST'){if(COPY.mode==='LIVE'){const body=await bodyJson(req);if(body.confirm!=='COPY_RESUME')return response(res,400,{error:'CONFIRM_REQUIRED'})}return response(res,200,copyTrader.resume())}
  if(pathname==='/api/copy/arm'&&req.method==='POST'){const body=await bodyJson(req);if(body.confirm!=='COPY_ARM')return response(res,400,{error:'CONFIRM_REQUIRED'});if(updateJob.active||live.updating||shuttingDown)return response(res,409,{error:'UPDATE_IN_PROGRESS'});if(COPY.mode==='LIVE'&&realSafety?.isTripped())return response(res,409,{error:'DAILY_LOSS_CIRCUIT_BREAKER',message:'오늘 일일 손실 차단이 발동 중입니다. 계좌 안전 가드에서 차단 해제 후 다시 시도하세요'});try{return response(res,200,copyTrader.arm())}catch(e){return response(res,e.httpStatus||409,{error:e.code||'ARM_REFUSED',message:e.message})}}
  if(pathname==='/api/copy/disarm'&&req.method==='POST')return response(res,200,copyTrader.disarm({user:true}));
  if(pathname==='/api/copy/controls'&&req.method==='GET')return response(res,200,{controls:copyControls.status(),traderBalanceUSD:copyControls.effectiveTraderBalanceUSD(COPY.traderBalanceUSD),maxLeverage:copyControls.effectiveMaxLeverage(COPY.maxLeverage)});
  if(pathname==='/api/copy/controls'&&req.method==='POST'){
   const body=await bodyJson(req);
   try{const controls=copyControls.configure(body);reportsDirty=true;return response(res,200,{controls,traderBalanceUSD:copyControls.effectiveTraderBalanceUSD(COPY.traderBalanceUSD),maxLeverage:copyControls.effectiveMaxLeverage(COPY.maxLeverage)})}
   catch(e){return response(res,e.httpStatus||500,{error:e.code||'COPY_CONTROLS_SAVE_FAILED',message:e.message})}
  }
  if(pathname==='/api/account/alerts'&&req.method==='GET'){
   if(!accountAlerts)return response(res,404,{error:'ACCOUNT_ALERTS_UNAVAILABLE'});
   return response(res,200,{alerts:accountAlerts.status()});
  }
  if(pathname==='/api/account/alerts'&&req.method==='POST'){
   if(!accountAlerts)return response(res,404,{error:'ACCOUNT_ALERTS_UNAVAILABLE'});
   const body=await bodyJson(req);
   try{return response(res,200,{alerts:accountAlerts.configure(body)})}
   catch(e){return response(res,e.httpStatus||500,{error:e.code||'ACCOUNT_ALERTS_SAVE_FAILED',message:e.message})}
  }
  if(pathname==='/api/account/alerts/daily-report'&&req.method==='POST'){
   if(!accountAlerts)return response(res,404,{error:'ACCOUNT_ALERTS_UNAVAILABLE'});
   try{
    const st=await copyLiveStatus();
    const resReport=await accountAlerts.checkDailyReport({
     copyClosed:copyTrader.store.closed,manualClosed:manualLedger?.store.closed??[],
     dailyByDay:dailyPnl?.status()?.byDay??null,equityUSD:st.funds?.equity??null,
     openCount:Array.isArray(st.venuePositions)?st.venuePositions.length:0,force:true,
    });
    return response(res,200,{ok:true,...resReport});
   }catch(e){return response(res,500,{error:e.code||'DAILY_REPORT_FAILED',message:e.message})}
  }
  if(pathname==='/api/account/alerts/position-summary'&&req.method==='POST'){
   if(!accountAlerts)return response(res,404,{error:'ACCOUNT_ALERTS_UNAVAILABLE'});
   try{
    const st=await copyLiveStatus();
    const resSum=await accountAlerts.checkPositionSummary({
     positions:Array.isArray(st.venuePositions)?st.venuePositions:[],force:true,
    });
    return response(res,200,{ok:true,...resSum,message:resSum.sent?`포지션 ${resSum.count}건 알림 발송 완료`:'보유 중인 포지션이 없습니다'});
   }catch(e){return response(res,500,{error:e.code||'POSITION_SUMMARY_FAILED',message:e.message})}
  }
  if(pathname==='/api/copy/analytics'&&req.method==='GET'){
   return response(res,200,buildCopyAnalytics({
    copyClosed:copyTrader.store.closed,
    manualClosed:manualLedger?.store.closed??[],
    scalpClosed:realScalpClosed(),
    dailyByDay:dailyPnl?.status()?.byDay??null,
    equityUSD:copyTrader.funds?.equity??null,
    confirmedOnly:COPY.mode==='LIVE',
    exchangeCosts:dailyPnl?.costSummary?.()??null,
   }));
  }
  if(pathname==='/api/copy/export'&&req.method==='GET'){
   res.writeHead(200,{'Content-Type':'text/csv; charset=utf-8','Content-Disposition':'attachment; filename="signal-lab-real-trades.csv"','Cache-Control':'no-store',...SECURITY_HEADERS});
   return res.end(exportCopyTradesCSV({copyClosed:copyTrader.store.closed,manualClosed:manualLedger?.store.closed??[],scalpClosed:realScalpClosed()}));
  }
  if(pathname==='/api/real/panic'&&req.method==='POST'){
   const body=await bodyJson(req);
   if(body?.confirm!==REAL_PANIC_CONFIRM_TOKEN)return response(res,400,{ok:false,error:'CONFIRM_REQUIRED',message:`확인 문구(${REAL_PANIC_CONFIRM_TOKEN})가 필요합니다`});
   try{
    const r=await runRealPanicFlat(body.confirm);
    return response(res,r.ok?200:207,r);
   }catch(e){return response(res,e.httpStatus||502,{ok:false,error:e.code||'PANIC_FLAT_FAILED',message:e.message})}
  }
  if(pathname==='/api/real/position-action'&&req.method==='POST'){
   const body=await bodyJson(req);
   if(body?.confirm!=='REAL_POSITION_ACTION')return response(res,400,{error:'CONFIRM_REQUIRED',message:'확인 코드가 필요합니다'});
   const action=String(body?.action||'').toUpperCase();
   if(!['CLOSE_HALF','CLOSE_ALL','BREAKEVEN_STOP','SET_STOP_LOSS'].includes(action))return response(res,400,{error:'INVALID_ACTION',message:'지원하지 않는 포지션 작업입니다'});
   const symbol=String(body?.symbol||'').trim().toUpperCase();
   const direction=['LONG','SHORT'].includes(String(body?.direction||'').toUpperCase())?String(body.direction).toUpperCase():null;
   if(!symbol||symbol==='ALL'||!direction)return response(res,400,{error:'POSITION_SPEC_REQUIRED',message:'종목과 방향(LONG/SHORT)을 지정해 주세요'});
   try{
    const r=await executeRealPositionAction({symbol,direction,action,stopPrice:body?.stopPrice,lossRoePct:body?.lossRoePct,closePct:body?.closePct});
    if(r.ok)reportsDirty=true;
    return response(res,r.ok?200:(r.status||409),r);
   }catch(e){return response(res,502,{ok:false,error:e.code||'POSITION_ACTION_FAILED',message:e.message})}
  }
  if(pathname==='/api/real/trade/markets'&&req.method==='GET'){
   if(COPY.mode!=='LIVE'||!realBingxClient)return response(res,409,{error:'LIVE_ACCOUNT_UNAVAILABLE',message:'실계좌 BingX 클라이언트가 연결되어 있지 않습니다'});
   try{
    if(!copyTickers.at||Date.now()-copyTickers.at>5000){
     copyTickers.pending??=venueQuotes.clients.BINGX.tickers().then(rows=>{copyTickers={at:Date.now(),rows}},()=>{copyTickers.pending=null});
     await copyTickers.pending;
    }
    const contracts=await venueQuotes.clients.BINGX.loadContracts();
    const openPositions=Array.isArray(venuePositionsReader?.last?.venuePositions)
     ?venuePositionsReader.last.venuePositions
     :Object.values(copyTrader.store.positions||{}).filter(p=>p.status==='OPEN');
    const markets=buildBingxMarketList({contracts,tickers:copyTickers.rows,openPositions});
    return response(res,200,{at:copyTickers.at||Date.now(),count:markets.length,markets});
   }catch(e){return response(res,e.httpStatus||502,{error:e.code||'MARKETS_FAILED',message:e.message})}
  }
  if(pathname==='/api/real/trade/klines'&&req.method==='GET'){
   if(COPY.mode!=='LIVE'||!realBingxClient)return response(res,409,{error:'LIVE_ACCOUNT_UNAVAILABLE',message:'실계좌 BingX 클라이언트가 연결되어 있지 않습니다'});
   const rawSymbol=url.searchParams.get('symbol')||'BTCUSDT';
   const interval=String(url.searchParams.get('interval')||'15m').trim();
   if(!REAL_CHART_INTERVALS.includes(interval))return response(res,400,{error:'INVALID_INTERVAL',message:'지원하지 않는 시간봉입니다'});
   const limit=Math.max(40,Math.min(300,Math.round(Number(url.searchParams.get('limit'))||160)));
   try{
    const norm=rawSymbol.trim().toUpperCase().replace(/[^A-Z0-9]/g,'');
    const sym=norm.endsWith('USDT')?norm:`${norm}USDT`;
    const contracts=await venueQuotes.clients.BINGX.contractsFor(sym);
    const c=resolveCopyContract(contracts,sym);
    if(!c)return response(res,404,{error:'NO_BINGX_CONTRACT',message:`${displaySymbol(sym)} 종목을 찾지 못했습니다`});
    const cacheKey=`real:${c.symbol}:${interval}:${limit}`;
    const cached=venueKlineCache.get(cacheKey);
    let rows;
    if(cached&&Date.now()<cached.until){rows=await cached.pending}
    else{
     const pending=venueQuotes.clients.BINGX.klines(c.symbol,interval,limit);
     venueKlineCache.set(cacheKey,{pending,until:Date.now()+4000});
     try{rows=await pending}catch(e){venueKlineCache.delete(cacheKey);throw e}
    }
    const candles=(rows||[]).map(r=>[r[0],r[1],r[2],r[3],r[4],r[5]]);
    return response(res,200,{symbol:c.symbol,displaySymbol:displaySymbol(c.symbol),venueSymbol:c.venueSymbol,interval,tickSize:c.tickSize??null,candles});
   }catch(e){return response(res,e.httpStatus||502,{error:e.code||'KLINES_FAILED',message:e.message})}
  }
  if(pathname==='/api/real/trade/info'&&req.method==='GET'){
   if(COPY.mode!=='LIVE'||!realBingxClient)return response(res,409,{error:'LIVE_ACCOUNT_UNAVAILABLE',message:'실계좌 BingX 클라이언트가 연결되어 있지 않습니다'});
   const rawSymbol=url.searchParams.get('symbol')||'';
   try{
    const markOf=async vs=>{
     if(!copyTickers.at||Date.now()-copyTickers.at>3000){
      copyTickers.pending??=venueQuotes.clients.BINGX.tickers().then(rows=>{copyTickers={at:Date.now(),rows}},()=>{copyTickers.pending=null});
      await copyTickers.pending;
     }
     return Number(copyTickers.rows.find(x=>x.symbol===vs)?.lastPrice)||null;
    };
    const info=await lookupRealTradeSymbol({
     rawSymbol,client:realBingxClient,
     contractsFor:sym=>venueQuotes.clients.BINGX.contractsFor(sym),
     markOf,availableUSD:copyTrader.funds?.available??realWallet.last?.available??null,
     copyPositions:Object.values(copyTrader.store.positions||{}),
    });
    return response(res,200,info);
   }catch(e){return response(res,e.httpStatus||502,{error:e.code||'TRADE_INFO_FAILED',message:e.message})}
  }
  if(pathname==='/api/real/trade/open-orders'&&req.method==='GET'){
   if(COPY.mode!=='LIVE'||!realBingxClient)return response(res,409,{error:'LIVE_ACCOUNT_UNAVAILABLE',message:'실계좌 BingX 클라이언트가 연결되어 있지 않습니다'});
   try{
    const orders=await listRealOpenOrders({client:realBingxClient,symbol:url.searchParams.get('symbol')||null});
    return response(res,200,{orders});
   }catch(e){return response(res,e.httpStatus||502,{error:e.code||'OPEN_ORDERS_FAILED',message:e.message})}
  }
  if(pathname==='/api/real/trade/order'&&req.method==='POST'){
   if(COPY.mode!=='LIVE'||!realBingxClient)return response(res,409,{error:'LIVE_ACCOUNT_UNAVAILABLE',message:'실계좌 BingX 클라이언트가 연결되어 있지 않습니다'});
   const body=await bodyJson(req);
   try{
    const markOf=async vs=>{
     if(!copyTickers.at||Date.now()-copyTickers.at>3000){
      copyTickers.pending??=venueQuotes.clients.BINGX.tickers().then(rows=>{copyTickers={at:Date.now(),rows}},()=>{copyTickers.pending=null});
      await copyTickers.pending;
     }
     return Number(copyTickers.rows.find(x=>x.symbol===vs)?.lastPrice)||null;
    };
    const r=await executeRealManualOrder({
     confirm:body?.confirm,symbol:body?.symbol,side:body?.side,
     orderType:body?.orderType,amountMode:body?.amountMode,amount:body?.amount,
     price:body?.price,leverage:body?.leverage,marginMode:body?.marginMode,
     tpPrice:body?.tpPrice,slPrice:body?.slPrice,makerFirst:body?.makerFirst===true,postOnly:body?.postOnly===true,
     client:realBingxClient,
     contractsFor:sym=>venueQuotes.clients.BINGX.contractsFor(sym),
     markOf,
     safety:realSafety?.orderGuard({equityUSD:copyTrader.funds?.equity??realWallet.last?.equity??null})??null,
     // Copy & live-scalp lanes (audit C-5): the manual panel may not change leverage / margin mode under an open managed position.
     copyPositions:[...(COPY.mode==='LIVE'?Object.values(copyTrader.store.positions):[]),...(scalpLiveExec?.store?.open||[])],
    });
    // The copy executor caches margin-mode / leverage settings for 30 min: drop them for this contract (C-5).
    try{copyTrader.clearVenueCache(r?.plan?.venueSymbol||null)}catch{}
    reportsDirty=true;
    void refreshRealTradeNotices();
    void readRealWallet().catch(()=>{});
    return response(res,200,r);
   }catch(e){
    // A failed order may still have changed the leverage / margin mode: drop the whole copy settings cache.
    try{copyTrader.clearVenueCache()}catch{}
    return response(res,e.httpStatus||502,{ok:false,error:e.code||'MANUAL_ORDER_FAILED',message:e.message})}
  }
  if(pathname==='/api/real/trade/cancel-order'&&req.method==='POST'){
   if(COPY.mode!=='LIVE'||!realBingxClient)return response(res,409,{error:'LIVE_ACCOUNT_UNAVAILABLE',message:'실계좌 BingX 클라이언트가 연결되어 있지 않습니다'});
   const body=await bodyJson(req);
   try{
    const r=await cancelRealOpenOrder({
     confirm:body?.confirm,symbol:body?.symbol,orderId:body?.orderId,
     client:realBingxClient,
     contractsFor:sym=>venueQuotes.clients.BINGX.contractsFor(sym),
    });
    return response(res,200,r);
   }catch(e){return response(res,e.httpStatus||502,{ok:false,error:e.code||'CANCEL_ORDER_FAILED',message:e.message})}
  }
  if(pathname==='/api/real/trailing'&&req.method==='GET'){
   if(COPY.mode!=='LIVE'||!realTrailing)return response(res,404,{error:'REAL_TRAILING_UNAVAILABLE',message:'실계좌 자동 트레일링이 활성화되어 있지 않습니다'});
   return response(res,200,{ok:true,trailing:realTrailing.status()});
  }
  if(pathname==='/api/real/trailing'&&req.method==='POST'){
   if(COPY.mode!=='LIVE'||!realTrailing)return response(res,404,{error:'REAL_TRAILING_UNAVAILABLE',message:'실계좌 자동 트레일링이 활성화되어 있지 않습니다'});
   const body=await bodyJson(req);
   try{
    const trailing=realTrailing.configure(body);
    reportsDirty=true;
    return response(res,200,{ok:true,trailing,summary:trailing.enabled?'실계좌 자동 트레일링 ON 저장됨':'실계좌 자동 트레일링 OFF 저장됨'});
   }catch(e){return response(res,e.httpStatus||400,{ok:false,error:e.code||'INVALID_REAL_TRAILING',message:e.message})}
  }
  if(pathname==='/api/real/safety'&&req.method==='GET'){
   if(COPY.mode!=='LIVE'||!realSafety)return response(res,404,{error:'REAL_SAFETY_UNAVAILABLE',message:'실계좌 안전 가드가 활성화되어 있지 않습니다'});
   return response(res,200,{ok:true,safety:realSafety.status()});
  }
  if(pathname==='/api/real/safety'&&req.method==='POST'){
   if(COPY.mode!=='LIVE'||!realSafety)return response(res,404,{error:'REAL_SAFETY_UNAVAILABLE',message:'실계좌 안전 가드가 활성화되어 있지 않습니다'});
   const body=await bodyJson(req);
   try{
    const marginAlert=realMarginAlert&&body&&Object.hasOwn(body,'marginAlertLevels')?realMarginAlert.configure({marginAlertLevels:body.marginAlertLevels}):null;
    const safety=realSafety.configure(body);
    let controls=null;
    if(body?.applyPreset===true){
     controls=copyControls.configure(REAL_SAFETY_COPY_PRESET);
    }
    reportsDirty=true;
    const summary=body?.applyPreset===true?'실계좌 권장 안전 프리셋 일괄 적용 완료 (최대 20배 · 증거금 15% · 일일한도 -8%)'
     :body?.unlockToday===true?'오늘 일일 손실 차단이 해제되었습니다'
     :'계좌 안전 가드 설정 저장됨';
    return response(res,200,{ok:true,safety,...(controls?{controls}:{}),...(marginAlert?{marginAlert}:{}),summary});
   }catch(e){return response(res,e.httpStatus||400,{ok:false,error:e.code||'INVALID_REAL_SAFETY',message:e.message})}
  }
  if(pathname==='/api/manual/note'&&req.method==='POST'){
   if(!manualLedger)return response(res,404,{error:'MANUAL_LEDGER_UNAVAILABLE',message:'수동 거래 원장이 활성화되어 있지 않습니다'});
   const body=await bodyJson(req);
   try{
    const r=manualLedger.setTradeNote(body?.id,{note:body?.note,tags:body?.tags});
    reportsDirty=true;
    return response(res,200,r);
   }catch(e){return response(res,e.httpStatus||400,{error:e.code||'MANUAL_NOTE_FAILED',message:e.message})}
  }
  // From the local channel listener only: a shared token (COPY_LISTENER_TOKEN in .env), compared in constant time.
  if(pathname==='/api/copy/message'&&req.method==='POST'){
   const token=String(req.headers['x-copy-token']||''),want=String(process.env.COPY_LISTENER_TOKEN||'');
   const ok=want.length>=24&&safeTokenEqual(token,want);
   if(!ok)return response(res,403,{error:'FORBIDDEN'});
   const body=await bodyJson(req);
   if(typeof body?.text!=='string'||body.text.length>4000)return response(res,400,{error:'TEXT_REQUIRED'});
   return response(res,200,await copyTrader.handle({id:body.id,date:Number(body.date)||Date.now(),text:body.text}));
  }
  // Listener liveness (copy_listener_health.mjs): the same token; the token is checked before the body is read.
  if(pathname==='/api/copy/heartbeat'&&req.method==='POST'){
   const token=String(req.headers['x-copy-token']||''),want=String(process.env.COPY_LISTENER_TOKEN||'');
   if(!(want.length>=24&&safeTokenEqual(token,want)))return response(res,403,{error:'FORBIDDEN'});
   const r=await listenerHeartbeatEndpoint({token,want,body:await bodyJson(req),health:copyListenerHealth,copyEnabled:COPY.enabled});
   return response(res,r.status,r.body);
  }
  // 급변 알림 from the same listener (PUMP_ALERT_CHATS), same token. Only SCALP_EXEC_MODE=TESTNET hands it to the scalp.
  if(pathname==='/api/pump-alert'&&req.method==='POST'){
   const token=String(req.headers['x-copy-token']||''),want=String(process.env.COPY_LISTENER_TOKEN||'');
   if(!(want.length>=24&&safeTokenEqual(token,want)))return response(res,403,{error:'FORBIDDEN'});
   // Both testnet strategies see each alert (user 2026-11-25 14:34): the 5m scalp's hand-off as before, and the 급변 알림 초단타.
   const r=pumpAlertEndpoint({token,want,body:await bodyJson(req),book:pumpBook,
    onAlert:SCALP_EXEC.mode==='TESTNET'&&scalpClient?.mode==='TESTNET'?alert=>scalpExec.pumpAlert(alert):null,
    onFade:PUMP_FADE.mode==='TESTNET'&&pumpFade.client?.mode==='TESTNET'?alert=>pumpFade.onAlert(alert):null});
   if(r.body?.recorded)reportsDirty=true;
   return response(res,r.status,r.body);
  }
  if(pathname==='/api/live'&&req.method==='GET')return response(res,200,live.status());
  if(pathname==='/api/live/testnet-budget'&&req.method==='GET'){
   if(!hasTestnetBingx)return response(res,404,{error:'BINGX_TESTNET_UNAVAILABLE'});
   await refreshTestnetBudgetBalance();
   return response(res,200,{...testnetSwitch({live,scalp:scalpExec}),budget:testnetBudget.status()});
  }
  // 실매매 screen (read only): positions with prices, closed trades with realized results, summary.
  if(pathname==='/api/live/overview'&&req.method==='GET'){
   if(hasTestnetBingx)await refreshTestnetBudgetBalance();
   const [scalp,rawBalance]=await Promise.all([SCALP_EXEC.mode==='TESTNET'||scalpExec.store.closed.length||scalpExec.store.open.length?scalpExec.liveStatus():null,liveBalanceSnapshot()]);
   // One testnet screen (user 2026-11-17): one switch, the shared budget, totals over both strategies. Not for LIVE.
   const testnet=LIVE.mode==='LIVE'?null:(()=>{const eq=Number(scalp?.funds?.equity)>0?Number(scalp.funds.equity):Number(rawBalance?.usd)>0?Math.min(Number(rawBalance.usd),LIVE.balanceCapUSD>0?LIVE.balanceCapUSD:Infinity):null;
    return {...testnetSwitch({live,scalp:scalpExec}),budget:testnetBudget.status(eq??undefined),stats:testnetStats({records:live.store.records,mode:LIVE.mode==='TESTNET'&&!TESTNET_SCALP_ONLY?'TESTNET':null,scalpStats:scalp?.stats??null,pumpFadeStats:pumpFade.config.mode==='TESTNET'||pumpFade.store.closed.length?pumpFade.stats():null})}})();
   const b=testnet?.budget,balance=hasTestnetBingx&&rawBalance?.venue==='BINGX'&&b?{...rawBalance,usd:b.balanceError?null:b.accountEquityUSD,at:b.balanceAt,error:b.balanceError}:rawBalance;
   const pumpAlerts=testnet?{...pumpBook.summary(),scalpTrades:scalp?.stats?.byTrigger?.PUMP_ALERT??null,pumpFadeTrades:pumpFade.stats()}:null;
   const pumpFadeView=testnet&&(pumpFade.config.mode==='TESTNET'||pumpFade.store.closed.length||pumpFade.store.open.length)?pumpFade.status():null;
   let liveReadiness=null;if(testnet)try{liveReadiness=readyNotifier.status(readySummary())}catch{}
   return response(res,200,{readiness:readiness(),copy:COPY.enabled||copyTrader.store.closed.length?await copyLiveStatus():null,scalp,testnet,pumpAlerts,pumpFade:pumpFadeView,liveReadiness,...liveOverview({status:live.status(),records:live.store.records.map(r=>({...r,deletable:live.deleteBlock(r)===null})),
   priceOf:liveRecordPrice,balance,paperTrading:CONFIG.paperTrading})})}
  if(pathname.startsWith('/api/live/')&&req.method==='POST'){
   const body=await bodyJson(req);
   if(pathname==='/api/live/testnet-close'){
    if(body?.confirm!=='CLOSE_TESTNET')return response(res,400,{error:'CONFIRM_REQUIRED'});
    if(updateJob.active||live.updating||shuttingDown)return response(res,409,{error:'UPDATING'});
    if(LIVE.mode==='LIVE'||LIVE.mode!=='TESTNET'&&SCALP_EXEC.mode!=='TESTNET')return response(res,409,{error:'TESTNET_CLOSE_ONLY'});
    const executor=body.strategy==='scalp'?scalpExec:body.strategy==='signal'?live:null;
    if(!executor||typeof body.key!=='string'||!body.key.trim()||body.key.length>256)return response(res,400,{error:'INVALID_POSITION'});
    const {status,...result}=await executor.closeTestnetPosition(body.key);
    if(result.ok)reportsDirty=true;
    return response(res,status??200,result);
   }
   if(pathname==='/api/live/testnet-budget'){
    if(LIVE.mode==='LIVE'||LIVE.mode!=='TESTNET'&&SCALP_EXEC.mode!=='TESTNET')return response(res,409,{error:'NOT_TESTNET'});
    try{if(hasTestnetBingx)await refreshTestnetBudgetBalance();if(body?.clearStop===true)scalpExec?.clearDailyStop?.();const budget=testnetBudget.configure(body);reportsDirty=true;return response(res,200,{budget})}
    catch(e){return response(res,e.httpStatus||500,{error:e.code==='INVALID_TESTNET_BUDGET'?e.code:'TESTNET_BUDGET_SAVE_FAILED'})}
   }
   if(pathname==='/api/live/testnet-reset-pnl'){
    if(body?.confirm!=='RESET_TESTNET_PNL')return response(res,400,{error:'CONFIRM_REQUIRED'});
    if(updateJob.active||live.updating||shuttingDown)return response(res,409,{error:'UPDATING'});
    if(LIVE.mode==='LIVE'||LIVE.mode!=='TESTNET'&&SCALP_EXEC.mode!=='TESTNET')return response(res,409,{error:'NOT_TESTNET'});
    try{
     const sigRes=live.resetTestnetHistory?.()||{removed:0};
     const scalpRes=scalpExec?.resetHistory?.()||{removed:0};
     // The scalp's reset removes the shared journal file: the 초단타's history goes with it.
     const pumpFadeRes=pumpFade?.resetHistory?.()||{removed:0};
     const copyRes=COPY.mode==='TESTNET'&&copyTrader?.resetTestnetHistory?copyTrader.resetTestnetHistory():{removed:0};
     const autoTestnet=x=>x?.source==='LIVE_AUTO'&&x.mode==='TESTNET';
     const journalRemoved=persisted.journal.filter(autoTestnet).length;
     if(journalRemoved>0){persisted.journal=persisted.journal.filter(x=>!autoTestnet(x));save()}
     testnetBudget.clearStop();
     const removed={signal:sigRes.removed||0,scalp:scalpRes.removed||0,pumpFade:pumpFadeRes.removed||0,copy:copyRes.removed||0,journal:journalRemoved};
     testnetHistoryReset=recordManualTestnetPnlReset(storage.dir,{now:Date.now(),removed});
     if(hasTestnetBingx)await refreshTestnetBudgetBalance().catch(()=>{});
     reportsDirty=true;
     return response(res,200,{ok:true,at:testnetHistoryReset.at,removed,budget:testnetBudget.status()});
    }catch(e){return response(res,e.httpStatus||500,{error:e.code||'TESTNET_RESET_PNL_FAILED',message:e.message})}
   }
   if(pathname==='/api/live/arm'){if(body.confirm!=='ARM')return response(res,400,{error:'CONFIRM_REQUIRED'});
    if(body.mode&&body.mode!==LIVE.mode)return response(res,409,{error:'MODE_MISMATCH'});
    if(updateJob.active||live.updating||shuttingDown)return response(res,409,{error:'UPDATE_IN_PROGRESS'});
    // TESTNET / OFF: one switch for the signal strategy and the reversal scalp (user 2026-11-17). LIVE: unchanged.
    let status;
    if(LIVE.mode==='LIVE')status=live.arm();
    else{try{const testnet=armTestnet({live,scalp:scalpExec});status={...live.status(),testnet}}catch(e){return response(res,e.httpStatus||409,{error:e.code||e.message,...(e.detail?{detail:e.detail}:{})})}}
    // Look at the current hour's approvals right away instead of waiting for the next tick or bar.
    setTimeout(()=>{for(const symbol of state.analyses.keys()){try{cryptoEntryAllowed(symbol)}catch{}}},50);
    return response(res,200,status)}
   if(pathname==='/api/live/disarm')return response(res,200,LIVE.mode==='LIVE'?live.disarm():(t=>({...live.status(),testnet:t}))(disarmTestnet({live,scalp:scalpExec})));
   // Finished records only (positions, unchecked states and today's closed trades stay).
   if(pathname==='/api/live/delete'){const r=live.deleteRecord(String(body.key||''));return response(res,r.ok?200:409,r)}
   if(pathname==='/api/live/kill'){const st=live.kill('MANUAL');if(LIVE.mode!=='LIVE')scalpExec.disarm('KILL_SWITCH');scalpLiveExec?.disarm('KILL_SWITCH');return response(res,200,st)}
   if(pathname==='/api/live/test-order'){
    // TESTNET only: a small DOGE long through the real order path, closed after a few seconds
    // (DOGE: fine lot steps, so a small unit still splits into three targets and adds).
    if(body.confirm!=='TEST')return response(res,400,{error:'CONFIRM_REQUIRED'});
    if(updateJob.active||live.updating||shuttingDown)return response(res,409,{error:'UPDATE_IN_PROGRESS'});
    if(LIVE.mode!=='TESTNET')return response(res,409,{error:'TEST_TESTNET_ONLY'});
    if(TESTNET_SCALP_ONLY)return response(res,409,{error:'TESTNET_SIGNAL_DISABLED'});
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
  if(pathname==='/api/scan'&&req.method==='POST'){if(state.scanActive)return response(res,202,{accepted:false,reason:'스캔 진행 중',status:getStatus()});void runScan();return response(res,202,{accepted:true,message:'백그라운드 스캔 시작',status:getStatus()})}
  // Cloud server (git checkout under systemd): check / apply from GitHub with one tap.
  if(pathname==='/api/update/git'&&req.method==='GET'){if(!GIT_UPDATE)return response(res,404,{error:'GIT_UPDATE_UNAVAILABLE'});if(updateJob.active)return response(res,200,{state:'updating',...updateJob,...appVersion,bootId:SERVER_BOOT_ID});try{return response(res,200,{...await gitCheck(__dirname),bootId:SERVER_BOOT_ID})}catch(e){return response(res,502,{error:e.message})}}
  // Progress of a one-tap update (for the progress bar): phase and percent, polled by the screen.
  if(pathname==='/api/update/git/progress'&&req.method==='GET')return response(res,200,{...updateJob,...appVersion,bootId:SERVER_BOOT_ID});
  if(pathname==='/api/update/git'&&req.method==='POST'){
   if(!GIT_UPDATE)return response(res,404,{error:'GIT_UPDATE_UNAVAILABLE'});
   const body=await bodyJson(req);if(body?.confirm!=='UPDATE')return response(res,400,{error:'CONFIRM_REQUIRED'});
   const r=await runGitUpdate('button');return response(res,r.status,r.body);
  }
  if(pathname==='/api/update'){
   const signal=LIVE.mode==='TESTNET'&&live.armed===true&&!live.store.killSwitch;
   const runtime={signal,scalp:SCALP_EXEC.mode==='TESTNET'&&scalpExec?.armed===true&&!live.store.killSwitch,
    copy:COPY.enabled&&!copyTrader.store.killed&&!live.store.killSwitch&&(COPY.mode==='LIVE'?copyTrader.armed===true:signal)};
   return response(res,200,{...state.update,git:GIT_UPDATE,autoUpdate:GIT_UPDATE&&AUTO_UPDATE,updating:updateJob.active===true,updateJob:updateJob.active?{...updateJob}:null,bootId:SERVER_BOOT_ID,configured:Boolean(CONFIG.updateManifestURL),...appVersion,runtime,pending:pendingInfo(__dirname)?.version||null});
  }
  if(pathname==='/api/update/check'&&req.method==='POST')return response(res,200,await checkSoftwareUpdate());
  if(pathname==='/api/orderflow/radar'&&req.method==='GET'){
   const force=url.searchParams.get('force')==='1';
   try{
    const openHeld=[
     ...(copyTrader?.store?.open||[]).map(p=>p.symbol),
     ...(scalpExec?.store?.open||[]).map(p=>p.symbol),
     ...(live?.store?.records||[]).filter(r=>r.status==='OPEN').map(r=>r.symbol),
    ].filter(s=>/^[A-Z0-9]{4,25}$/.test(String(s||'')));
    const topMarket=(state.ranked||[]).slice(0,16).map(m=>m.symbol);
    const list=[...new Set([...openHeld,...ORDERFLOW_RADAR_DEFAULTS,...topMarket])].slice(0,20);
    return response(res,200,await scanOrderflowAnomalies(list,{force,budget:publicReadBudget}));
   }catch(e){
    return response(res,502,{ok:false,error:e?.message||'RADAR_FETCH_FAILED'});
   }
  }
  if(pathname==='/api/orderflow'&&req.method==='GET'){
   const rawSym=url.searchParams.get('symbol')||'BTCUSDT';
   const rangeParam=String(url.searchParams.get('range')||'').toUpperCase();
   const interval=url.searchParams.get('interval')||'5m';
   const force=url.searchParams.get('force')==='1';
   const symbol=normalizeOrderflowSymbol(rawSym);
   if(!/^[A-Z0-9]{4,25}$/.test(symbol))return response(res,400,{ok:false,error:'INVALID_SYMBOL'});
   // Every FireCharts range tab (실시간·1D·1W·1M·6M·1Y·3Y); 6M/1Y were rejected here before 2026-11-25.
   if(rangeParam&&!Object.hasOwn(FIRECHART_RANGES,rangeParam))return response(res,400,{ok:false,error:'INVALID_RANGE'});
   if(!['5m','15m','1h','4h'].includes(interval))return response(res,400,{ok:false,error:'INVALID_INTERVAL'});
   try{
    const data=await fetchOrderflowWithFirechart(symbol,{range:rangeParam||undefined,interval,force,budget:publicReadBudget});
    const openHeld=[
     ...(copyTrader?.store?.open||[]).map(p=>p.symbol),
     ...(scalpExec?.store?.open||[]).map(p=>p.symbol),
     ...(live?.store?.records||[]).filter(r=>r.status==='OPEN').map(r=>r.symbol),
    ].filter(s=>/^[A-Z0-9]{4,25}$/.test(String(s||'')));
    const topMarket=(state.ranked||[]).slice(0,25).map(m=>m.symbol);
    const defaults=['BTCUSDT','ETHUSDT','SOLUSDT','XRPUSDT','DOGEUSDT','SUIUSDT','AVAXUSDT','LINKUSDT','ADAUSDT','1000PEPEUSDT'];
    const quickSymbols=[...new Set([...openHeld,...defaults,...topMarket])].slice(0,30);
    return response(res,200,{...data,quickSymbols,openSymbols:[...new Set(openHeld)]});
   }catch(e){
    return response(res,502,{ok:false,symbol,interval,error:e?.message||'ORDERFLOW_FETCH_FAILED'});
   }
  }
  // 고래 매물대 of one symbol (read-only, for the heatmap; whale_zones.mjs whaleZonesPayload): the scalp's settings, the shared
  // trade store (a symbol is read again at most every 30 s), Binance-listed symbols only. No order, no account data.
  // The screen asks every 30 s: its pages run only under 40 % of the budget (apiReservePct) so the score's reads go first,
  // and a coin not on Binance is 422, not 404 (the screen takes a 404 as "no such endpoint" and stops asking for 10 min).
  if(pathname==='/api/whale-zones'&&req.method==='GET'){
   const symbol=String(url.searchParams.get('symbol')||'').toUpperCase();
   if(!/^[A-Z0-9]{2,30}USDT$/.test(symbol))return response(res,400,{ok:false,error:'INVALID_SYMBOL'});
   if(!state.activeSet.has(symbol))return response(res,422,{ok:false,symbol,error:'NOT_ON_BINANCE'});
   const cfg=scalpExec?.config||SCALP_EXEC;
   const [snap,atr]=await Promise.all([scalpWhaleZones(symbol,{lookbackMs:whaleZoneLookbackMs(cfg.whaleZoneHours),scale:cfg.whaleCvdScale??'auto',maxPages:cfg.whaleZoneMaxPages,reservePct:WHALE_ZONE_DEFAULTS.apiReservePct}),whaleZoneAtr(symbol)]);
   const last=Number((rawMarketTickers||[]).find(t=>t?.symbol===symbol)?.lastPrice)||null;
   const zr=buildWhaleZones(snap,{price:last,atrPct:atr});
   const body=whaleZonesPayload(snap,zr,{atrPct:atr});
   return response(res,body.ok?200:502,body.ok?body:{...body,symbol});
  }
  if(pathname==='/api/market-commentary'){
   try{await refreshMarketStats()}catch{}
   return response(res,200,buildMarketCommentary(rawMarketTickers,{now:Date.now(),receivedAt:marketStatsReceivedAt,eligibleSymbols:state.activeSymbols,dataSource:'BINANCE_FUTURES_PUBLIC_24H'}));
  }
  // One article's main text (fetched when opened, from the RSS sources' own sites) in Korean.
  if(pathname==='/api/news/detail'&&req.method==='GET'){
   const id=url.searchParams.get('id')||'',article=(state.news||[]).find(n=>n.id===id);
   if(!article)return response(res,404,{ok:false,error:'NOT_FOUND'});
   return response(res,200,await articleDetail(article,NEWS_PROVIDER));
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
