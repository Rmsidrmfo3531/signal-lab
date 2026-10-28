import http from 'node:http';
import {exec} from 'node:child_process';
import {randomUUID,randomBytes} from 'node:crypto';
import {authorizedRequest,localIPv4Addresses} from './mobile_access.mjs';
import {stageUpdate,pendingInfo} from './updater.mjs';
import {normalizeTrade,closeTrade,journalSummary,exportTradesCSV} from './journal.mjs';
import {signalLifecycle} from './signal_lifecycle.mjs';
import {evaluateSignal} from './signal_pipeline.mjs';
import {OrangeXReadOnlyAdapter} from './orangex.mjs';
import {compareOrangeXBinance} from './orangex_comparison.mjs';
import {OrangeXPaperService} from './orangex_paper_service.mjs';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {analyze} from './engine.mjs';
import {structureObservations,historicalPatternObservations} from './observation.mjs';
import {describeScanFunnel} from './scan_diagnostics.mjs';
import {intersectPerpetualMarkets} from './markets.mjs';
import {officialMarketLinks,telegramMessage} from './links.mjs';
import {executionEstimate,EXEC_DEFAULTS,parsePerpExecution} from './execution.mjs';
import {FEEDS,prepareNews,shouldNotifyArticle} from './news.mjs';
import {extractTradFiMarkets,swapFundingUSD,tradfiQuoteVerdict} from './tradfi.mjs';
import {analyzeTradFi} from './tradfi_signal.mjs';
import {pullSeries} from './tradfi_feed.mjs';
import {PaperEngine,paperCSV,signalKey} from './paper.mjs';
import {paperEngineHealth} from './paper_health.mjs';
import {windowsPaperNotify} from './windows_paper_notify.mjs';
import {prepareData,readStore,atomicWriteStore,backupStore,acquireDataLock} from './persistence.mjs';

const __dirname=path.dirname(fileURLToPath(import.meta.url));
const storage=prepareData(__dirname);
const releaseDataLock=acquireDataLock(storage.dir);
process.on('exit',releaseDataLock);
const envfile=storage.envPath;
if(fs.existsSync(envfile))for(const line of fs.readFileSync(envfile,'utf8').split(/\r?\n/)){
 const match=line.match(/^\s*([A-Z][A-Z_0-9]*)\s*=\s*(.*)\s*$/);
 if(match&&!process.env[match[1]])process.env[match[1]]=match[2].replace(/^['"]|['"]$/g,'');
}
const CONFIG={
 port:Number(process.env.PORT||3000),host:process.env.HOST||'127.0.0.1',
 scanMs:Math.max(30000,Number(process.env.SCAN_INTERVAL_MS||60000)),
 rotatingBatch:Math.max(5,Math.min(100,Number(process.env.SCAN_ROTATING_BATCH||18))),
 hotBatch:Math.max(5,Math.min(80,Number(process.env.SCAN_HOT_BATCH||12))),
 quoteVolume:Math.max(0,Number(process.env.MIN_DAILY_VOLUME_USDT||5000000)),
 tgToken:process.env.TELEGRAM_BOT_TOKEN||'',tgChat:process.env.TELEGRAM_CHAT_ID||'',
 newsMs:Math.max(60000,Number(process.env.NEWS_POLL_MS||90000)),
 newsTelegram:process.env.TELEGRAM_NEWS_ALERTS!=='false',
 tradfiMs:Math.max(60000,Number(process.env.TRADFI_REFRESH_MS||60000)),
 tradfiScanMs:Math.max(300000,Number(process.env.TRADFI_SCAN_INTERVAL_MS||900000)),
 twelveKey:process.env.TWELVE_DATA_API_KEY||'',
 tradfiSymbols:(process.env.TRADFI_FEED_SYMBOLS||'XAU,XAG').split(',').map(x=>x.trim().toUpperCase()).filter(Boolean).slice(0,4),
 updateManifestURL:process.env.UPDATE_MANIFEST_URL||'',autoUpdate:process.env.AUTO_UPDATE!=='false',
 limits:{...EXEC_DEFAULTS,maxQuoteAgeSeconds:Number(process.env.MAX_VARIATIONAL_QUOTE_AGE_SEC||180),maxSpreadBps:Number(process.env.MAX_VARIATIONAL_SPREAD_BPS||20),maxAdverseVenueBps:Number(process.env.MAX_ADVERSE_VENUE_BPS||35),maxRoundTripBps:Number(process.env.MAX_ROUNDTRIP_BPS||30)}
};
// OrangeX transport stays READ_ONLY. Stage 2 offline PAPER uses a separate store;
// no setting, API key or browser request can enable actual-data auto entry.
let orangeX,orangeXConfigError=false;
try{
 orangeX=new OrangeXReadOnlyAdapter({enabled:process.env.ORANGEX_ENABLED==='true',mode:process.env.ORANGEX_MODE||'READ_ONLY',
  includePublicDetails:true,...(process.env.ORANGEX_LISTING_CURRENCIES?.trim()?
   {listingCurrencies:process.env.ORANGEX_LISTING_CURRENCIES.split(',').map(x=>x.trim()).filter(Boolean)}:
   process.env.ORANGEX_LISTING_CURRENCY?.trim()?{listingCurrency:process.env.ORANGEX_LISTING_CURRENCY.trim()}:{}),
  clientId:process.env.ORANGEX_CLIENT_ID||'',clientSecret:process.env.ORANGEX_CLIENT_SECRET||'',
  instruments:(process.env.ORANGEX_INSTRUMENTS||'BTC-USDT-PERPETUAL,ETH-USDT-PERPETUAL,SOL-USDT-PERPETUAL').split(',').map(x=>x.trim()).filter(Boolean),
  timeoutMs:Number(process.env.ORANGEX_REQUEST_TIMEOUT_MS||8000)});
}catch{
 orangeX=new OrangeXReadOnlyAdapter();orangeXConfigError=true;
}
const orangeXPaper=new OrangeXPaperService({directory:path.join(storage.dir,'orangex-paper')});
// LAN mode is opt-in. A fresh access password is generated on each start unless
// MOBILE_ACCESS_PASSWORD is explicitly set. Local localhost requests need no login.
const lanMode=!['127.0.0.1','::1','localhost'].includes(CONFIG.host);
const lanPassword=lanMode?(process.env.MOBILE_ACCESS_PASSWORD||randomBytes(6).toString('hex')):'';
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
// Create the first shared store file even if no trading event occurs yet.
save();
const state={ws:'offline',rest:'connecting',variational:'connecting',lastVariational:0,lastMarketListings:0,executionRefreshAt:0,blockedSignals:0,lastBlockReason:'',binancePerps:0,variationalPerps:0,lastMarket:0,lastScan:0,scannedSinceBoot:0,cycleScanned:0,cycle:0,
 activeSymbols:[],activeSet:new Set(),researchSymbols:[],researchSet:new Set(),researchRanked:[],scanMode:'waiting',lastValidatedAt:0,ranked:[],quotes:new Map(),analyses:new Map(),scanCursor:0,scanActive:false,error:'',clients:new Set(),recentSignals:[],
 liveWS:'offline',liveWatched:0,lastLiveTrigger:0,livePending:0,liveAnalyzed:0,
 lastTickerAt:0,lastTickerCount:0,lastLiveDataAt:0,lastLiveCandleClose:0,liveSubscribeAcks:0,liveSubscribeErrors:0,liveLastError:'',lastScanAttempt:0,scanStartedAt:0,scanFailedAt:0,marketRetryCount:0,marketError:'',marketLastRetry:0,news:[],newsStatus:'connecting',newsChecked:0,newsSources:[],newsError:'',update:{state:'unconfigured',lastCheck:0,message:'업데이트 서버 미설정'},scanSuccess:0,scanFailed:0,lastScanFailures:[],lastScanSuccessAt:0};
const apiCache=new Map();
const structureBySymbol=new Map();
const historyBySymbol=new Map();
function recentStructures(){return [...structureBySymbol.values()].flat().filter(x=>Date.now()-x.observedAt<2*3600000).sort((a,b)=>b.observedAt-a.observedAt).slice(0,100)}
function recentHistory(){return [...historyBySymbol.values()].flat().filter(x=>Date.now()-x.confirmedAt<24*3600000).sort((a,b)=>b.confirmedAt-a.confirmedAt).slice(0,100)}
const tradfiState={status:'connecting',updatedAt:0,error:'',swaps:[],patterns:[],feedStatus:CONFIG.twelveKey?'checking':'unconfigured',feedUpdatedAt:0,feedError:'',scanInProgress:false,feedScanned:0};
const VARIATIONAL_URL='https://omni-client-api.prod.ap-northeast-1.variational.io/metadata/v2/stats';
const MIME={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.svg':'image/svg+xml','.ico':'image/x-icon','.json':'application/json; charset=utf-8'};
function response(res,status,body){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(body))}
function send(event,obj){const msg=`event: ${event}\ndata: ${JSON.stringify(obj)}\n\n`;for(const client of state.clients){try{client.write(msg)}catch{state.clients.delete(client)}}}
function emitPaperNotice(event,{test=false}={}){
  const item={...event,id:randomUUID(),recordedAt:Date.now(),test};
  const pref=persisted.paperNotify;
  if(!test){pref.history.unshift(item);pref.history=pref.history.slice(0,100);save();send('paper-event',item)}
  const delivery=pref.enabled?windowsPaperNotify(event):{queued:false,reason:'알림 설정 OFF'};
  console.log(`[PAPER ${test?'TEST':event.type}]`,event.symbol,event.direction,delivery.reason);
  return {event:item,delivery};
}
const paper=new PaperEngine(persisted.paper,{onChange:store=>{save({...persisted,paper:store});send('paper',{event:'updated',at:Date.now()});},onEvent:event=>emitPaperNotice(event)});

async function binance(url,ttl=30000){
 const cache=apiCache.get(url);
 if(cache && cache.until>Date.now())return cache.data;
 if(cache?.pending)return cache.pending;
 const task=(async()=>{
  const ctrl=new AbortController();const timeout=setTimeout(()=>ctrl.abort(),12000);
  try {
   const r=await fetch('https://fapi.binance.com'+url,{signal:ctrl.signal,headers:{'User-Agent':'SignalLab/1.0','Accept':'application/json'}});
   if(!r.ok)throw Error(`Binance HTTP ${r.status}: ${(await r.text()).slice(0,140)}`);
   const data=await r.json();apiCache.set(url,{data,until:Date.now()+ttl});state.rest='connected';return data;
  } finally{clearTimeout(timeout)}
 })();
 apiCache.set(url,{data:cache?.data,until:0,pending:task});
 try{return await task;}catch(e){apiCache.delete(url);state.rest='offline';state.error=e.message;throw e}
}
async function variationalStats(){
 const cached=apiCache.get(VARIATIONAL_URL);
 if(cached && cached.until>Date.now())return cached.data;
 if(cached?.pending)return cached.pending;
 const task=(async()=>{
  const ctrl=new AbortController();const timeout=setTimeout(()=>ctrl.abort(),12000);
  try{
   const r=await fetch(VARIATIONAL_URL,{signal:ctrl.signal,headers:{Accept:'application/json','User-Agent':'SignalLab/2.0'}});
   if(!r.ok)throw Error(`Variational API HTTP ${r.status}`);
   const data=await r.json();if(!Array.isArray(data?.listings))throw Error('Variational v2 listings 응답이 올바르지 않음');
   apiCache.set(VARIATIONAL_URL,{data,until:Date.now()+45000});return data;
  }finally{clearTimeout(timeout)}
 })();
 apiCache.set(VARIATIONAL_URL,{data:null,until:0,pending:task});
 try{return await task}catch(e){apiCache.delete(VARIATIONAL_URL);throw e}
}
async function tgTradFi(pattern,row){
 if(!CONFIG.tgToken||!CONFIG.tgChat)return;
 const formatted=x=>Number(x).toLocaleString('en-US',{maximumFractionDigits:5});
 const message=[`📊 [TradFi 확정봉 패턴 · 참고 시그널] ${pattern.ticker} ${pattern.direction}`,
  `패턴: ${pattern.pattern}`,`참조 진입 ${formatted(pattern.entry)} / 손절 ${formatted(pattern.stop)}`,
  ...pattern.targets.map((p,i)=>`${i+1}차: ${formatted(p)} · 익절 ${pattern.takeProfitPercent[i]}%`),
  `외부 데이터: Twelve Data (Variational 가격과 차이 가능)`,
  `⚠️ 체결 확정 또는 수익 보장 아님 · 주문 전 실제 시장 운영·RFQ 호가·펀딩 확인`].join('\n');
 const keyboard=[[{text:'Variational 종목 확인 ↗',url:row.tradeUrl||row.marketsUrl}]];
 if(row.chartSymbol)keyboard.push([{text:'TradingView 참조 차트 ↗',url:`https://www.tradingview.com/chart/?symbol=${encodeURIComponent(row.chartSymbol)}`}]);
 try{const res=await fetch(`https://api.telegram.org/bot${CONFIG.tgToken}/sendMessage`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({chat_id:CONFIG.tgChat,text:message,disable_web_page_preview:true,reply_markup:{inline_keyboard:keyboard}}),signal:AbortSignal.timeout(10000)});if(!res.ok)console.warn('[TRADFI TG]',res.status)}
 catch(e){console.warn('[TRADFI TG]',e.message)}
}
async function refreshTradFi(){
 try{
  const payload=await variationalStats();
  tradfiState.swaps=extractTradFiMarkets(payload,{now:Date.now()});
  tradfiState.updatedAt=Date.now();tradfiState.status='connected';tradfiState.error='';
  for(const row of tradfiState.swaps){if(tradfiQuoteVerdict(row,{now:Date.now()}).eligible){
   paper.onPrice('TRADFI',row.ticker,row.markPrice,row.quoteUpdatedAt,{halfSpreadBps:(row.spreadBps||0)/2,quoteFresh:true});
  }}
  // Removed/renamed SWAPs must not survive the next API refresh.
  const usable=new Set(tradfiState.swaps.filter(x=>tradfiQuoteVerdict(x,{now:Date.now()}).eligible).map(x=>x.ticker));
  tradfiState.patterns=tradfiState.patterns.filter(x=>usable.has(x.ticker)&&x.lastBarAt>Date.now()-90*60000);
  send('tradfi',{...tradfiPublic()});
 }catch(e){
  tradfiState.status='offline';tradfiState.error=e.message;
  tradfiState.swaps=[];tradfiState.patterns=[];send('tradfi',tradfiPublic());
 }
}
function tradfiPublic(){return {status:tradfiState.status,updatedAt:tradfiState.updatedAt,error:tradfiState.error,
  swaps:tradfiState.swaps.map(row=>({...row,quote:tradfiQuoteVerdict(row,{now:Date.now()}),
   fundingExampleLongUSD:swapFundingUSD(row,'LONG'),fundingExampleShortUSD:swapFundingUSD(row,'SHORT')})),
  patterns:tradfiState.patterns.filter(x=>tradfiState.swaps.some(row=>row.ticker===x.ticker&&tradfiQuoteVerdict(row,{now:Date.now()}).eligible)&&x.lastBarAt>Date.now()-90*60000),feedStatus:tradfiState.feedStatus,feedUpdatedAt:tradfiState.feedUpdatedAt,
  feedError:tradfiState.feedError,scanInProgress:tradfiState.scanInProgress,feedScanned:tradfiState.feedScanned,
  scanIntervalMinutes:CONFIG.tradfiScanMs/60000};}
async function runTradFiScan(){
 if(tradfiState.scanInProgress)return;
 if(!CONFIG.twelveKey){tradfiState.feedStatus='unconfigured';send('tradfi',tradfiPublic());return}
 if(!tradfiState.swaps.length){tradfiState.feedStatus='waiting-listings';return}
 tradfiState.scanInProgress=true;tradfiState.feedStatus='checking';tradfiState.feedError='';
 try{
  const targets=tradfiState.swaps.filter(x=>x.feedSymbol&&CONFIG.tradfiSymbols.includes(x.base)).slice(0,4);
  const patterns=[];const failed=[];let scanned=0;const seriesCache=new Map();
  if(!targets.length){tradfiState.feedStatus='unavailable';tradfiState.feedError='캔들 데이터 매핑이 확인된 대상 상품이 현재 상장 목록에 없습니다.';tradfiState.patterns=[];return}
  for(const row of targets){
   try{
    // Never pass the API key to the UI, error response or logs.
    const series=seriesCache.has(row.feedSymbol)?seriesCache.get(row.feedSymbol):await pullSeries(row.feedSymbol,CONFIG.twelveKey);
    seriesCache.set(row.feedSymbol,series);
    const result=analyzeTradFi(row,series,{now:Date.now()});scanned++;
    if(result.status==='confirmed')patterns.push(result);
    else if(result.reason)failed.push(`${row.base}: ${result.reason}`);
   }catch(e){failed.push(`${row.base}: ${String(e.message||'feed error').slice(0,110)}`)}
  }
  // New alerts require a just-closed candle and fresh verified quote.
  for(const pattern of patterns){
   const row=tradfiState.swaps.find(x=>x.ticker===pattern.ticker);
   const key=`${pattern.ticker}|${pattern.direction}|${pattern.lastBarAt}`;
   if(!row||persisted.tradfiSeen[key]||Date.now()-pattern.lastBarAt>30*60000)continue;
   if(!tradfiQuoteVerdict(row,{now:Date.now()}).eligible)continue;
   // Persist the simulated pending entry first. A failed write must remain
   // retryable rather than marking an unregistered pattern as already handled.
   if(!paper.register(pattern,{market:'TRADFI',symbol:pattern.ticker,quoteEligible:true}))continue;
   save({...persisted,tradfiSeen:{...persisted.tradfiSeen,[key]:Date.now()}});
   send('tradfi-alert',{...pattern,tradeUrl:row.tradeUrl||row.marketsUrl,chartSymbol:row.chartSymbol});
   void tgTradFi(pattern,row);
  }
  for(const [k,t] of Object.entries(persisted.tradfiSeen))if(t<Date.now()-7*86400000)delete persisted.tradfiSeen[k];
  tradfiState.patterns=patterns;tradfiState.feedStatus=failed.length?'partial':'connected';
  tradfiState.feedScanned=scanned;tradfiState.feedUpdatedAt=Date.now();
  tradfiState.feedError=failed.slice(0,5).join(' | ');
 }catch(e){tradfiState.feedStatus='offline';tradfiState.feedError=e.message;tradfiState.patterns=[]}
 finally{tradfiState.scanInProgress=false;send('tradfi',tradfiPublic())}
}
const exchangeInfo=()=>binance('/fapi/v1/exchangeInfo',15*60*1000);
const market24=()=>binance('/fapi/v1/ticker/24hr',75000);
const klines=(symbol,interval,limit=150)=>binance(`/fapi/v1/klines?symbol=${encodeURIComponent(symbol)}&interval=${interval}&limit=${limit}`,interval==='4h'?170000:interval==='1h'?54000:20000);
// Two independent discovery stages: Binance price/candle scanning must not stop simply
// because Variational's listing endpoint is slow or temporarily unavailable.  Exploratory
// results are NEVER actionable and cannot open paper positions or emit order signals.
function binanceResearchMarkets(info,tickers){
 const excludeTradFi=new Set(['XAU','XAG','US100','US500','US30','US400','DXI','UKOIL','USOIL','VXI','SPCX','CL','COPP']);
 const bySymbol=new Map((info?.symbols||[]).filter(x=>x.contractType==='PERPETUAL'&&x.status==='TRADING'&&x.quoteAsset==='USDT'&&
  x.symbol===x.baseAsset+'USDT'&&!excludeTradFi.has(x.baseAsset)&&/^[A-Z0-9]+$/.test(x.baseAsset)).map(x=>[x.symbol,x]));
 return (Array.isArray(tickers)?tickers:[]).filter(x=>bySymbol.has(x.symbol)).map(x=>({
  symbol:x.symbol,baseAsset:bySymbol.get(x.symbol).baseAsset,price:Number(x.lastPrice),
  quoteVolume:Number(x.quoteVolume)||0,change:Number(x.priceChangePercent)||0
 })).filter(x=>Number.isFinite(x.price)&&x.price>0).sort((a,b)=>b.quoteVolume-a.quoteVolume).slice(0,45);
}
function useResearchMarkets(info,tickers){
 const fresh=binanceResearchMarkets(info,tickers);
 state.researchRanked=fresh;
 state.researchSymbols=fresh.map(x=>x.symbol);
 state.researchSet=new Set(state.researchSymbols);
 for(const row of fresh){
  if(state.activeSet.has(row.symbol))continue;
  const old=state.quotes.get(row.symbol);
  state.quotes.set(row.symbol,{...row,price:old?.price||row.price,priceAt:old?.priceAt||0});
 }
 state.scanMode=state.activeSymbols.length?'verified-stale':'research-only';
}
function marketFailure(error){
 state.variational='offline';state.marketError=String(error.message||error);
 state.error='공통 상장 검증 지연: '+state.marketError;
 state.marketRetryCount++;state.marketLastRetry=Date.now();
 // Preserve previously verified matches, watchlists and paper trading state; no
 // fresh alerts are permitted while the venue verification is offline.
 state.scanMode=state.activeSymbols.length?'verified-stale':state.researchSymbols.length?'research-only':'waiting';
 refreshLiveSubscriptions();
 send('status',getStatus());
}
async function loadMarket(){
 const settled=await Promise.allSettled([exchangeInfo(),market24(),variationalStats()]);
 const [infoResult,tickersResult,variationalResult]=settled;
 if(infoResult.status==='fulfilled'&&tickersResult.status==='fulfilled'){
  useResearchMarkets(infoResult.value,tickersResult.value);
  state.rest='connected';
 }else{
  const failures=settled.slice(0,2).filter(x=>x.status==='rejected').map(x=>x.reason?.message||String(x.reason));
  state.rest='offline';marketFailure('Binance 상장/24시간 시세 API: '+failures.join(' / '));
  if(!state.activeSymbols.length&&!state.researchSymbols.length)throw Error(state.marketError);
  return state.ranked;
 }
 if(variationalResult.status==='rejected'){
  marketFailure('Variational API: '+(variationalResult.reason?.message||String(variationalResult.reason)));
  return state.ranked;
 }
 let joined;
 try{joined=intersectPerpetualMarkets(infoResult.value,tickersResult.value,variationalResult.value)}
 catch(e){marketFailure('상장 교집합 검증: '+e.message);return state.ranked}
 if(!joined.markets.length){marketFailure('응답은 정상이나 공통 PERP 0종목: 종목 형식 및 상장정보 확인 필요');return state.ranked}
 state.variational='connected';state.lastVariational=Date.now();state.lastMarketListings=Date.now();state.lastValidatedAt=Date.now();
 state.binancePerps=joined.binancePerps;state.variationalPerps=joined.variationalPerps;
 state.ranked=joined.markets;
 state.activeSymbols=state.ranked.map(x=>x.symbol);
 state.activeSet=new Set(state.activeSymbols);
 state.analyses.forEach((_,symbol)=>{if(!state.activeSet.has(symbol)&&!state.researchSet.has(symbol))state.analyses.delete(symbol)});
 for(const row of state.ranked){
  const old=state.quotes.get(row.symbol);state.quotes.set(row.symbol,{...row,price:old?.price||row.price,priceAt:old?.priceAt||0});
 }
 // Do not delete a user's saved watchlist when a venue is temporarily down.
 // It can contain symbols from past releases; only active contracts are selected for scanning.
 state.lastMarket=Date.now();state.executionRefreshAt=Date.now();state.rest='connected';
 state.scanMode='verified';state.error='';state.marketError='';state.marketRetryCount=0;
 refreshLiveSubscriptions();
 send('market',{at:state.lastMarket,markets:state.ranked,watchlist:persisted.watchlist,variationalStatus:state.variational});
 send('status',getStatus());
 return state.ranked;
}
// Keep indicative quotes fresh without calling the rate-limited public endpoint for every symbol.
// If an API read fails, alert screening must fail closed rather than trusting stale quotes.
let refreshPromise=null;
async function refreshExecution(){
 if(refreshPromise)return refreshPromise;
 refreshPromise=(async()=>{
  try{
   if(!state.activeSymbols.length)return;
   const payload=await variationalStats();
   const byTicker=new Map((payload.listings||[]).filter(x=>x.contract_type==='perpetual').map(x=>[x.ticker,x]));
   const updated=[];
   for(const [symbol,record] of state.quotes){
    if(!state.activeSet.has(symbol))continue;
    const x=byTicker.get(record.variational?.ticker);
    if(!x){throw Error('공통 상장 종목 삭제/변경 감지: 목록 재검증 필요')}
    const info=parsePerpExecution(x);if(!info){throw Error('Variational 공개 데이터 파싱 실패')}
    record.variational={...record.variational,...info};
    updated.push({symbol,variational:record.variational});
   }
   state.lastVariational=Date.now();state.executionRefreshAt=Date.now();
   // A quote refresh alone does not revalidate the complete instrument universe.
   if(Date.now()-state.lastMarketListings<12*60000){state.variational='connected';state.scanMode='verified'}
   else{state.variational='offline';state.scanMode='verified-stale'};
   send('execution',{at:state.executionRefreshAt,items:updated});send('status',getStatus());
  }catch(e){marketFailure('Variational 호가 갱신 실패: '+e.message);console.warn('[EXECUTION]',e.message)}
 })();
 try{return await refreshPromise}finally{refreshPromise=null}
}
async function tgNotify(s){
 if(!CONFIG.tgToken||!CONFIG.tgChat)return;
 const verified=state.quotes.get(s.symbol);
 const urls=verified?.variational?.ticker&&state.activeSet.has(s.symbol)
  ?officialMarketLinks(s.symbol,verified.variational.ticker):null;
 if(!urls){console.warn('Telegram suppressed: market link not verified',s.symbol);return}
 const F=p=>p>0?p.toLocaleString('en-US',{maximumFractionDigits:p>=1000?2:7}):String(p);
 const payload={chat_id:CONFIG.tgChat,...telegramMessage(s,urls,F)};
 try{
  const r=await fetch(`https://api.telegram.org/bot${CONFIG.tgToken}/sendMessage`,{
   method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload),signal:AbortSignal.timeout(10000)
  });
  if(!r.ok)console.error('Telegram HTTP',r.status);
 }catch(e){console.error('Telegram error:',e.message)}
}

let updateCheckPromise=null;
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
 if(force)invalidateCandles(symbol);
 const task=checkSymbolInternal(symbol,force);
 pendingAnalyses.set(symbol,task);analyzing.add(symbol);
 try{return await task}finally{
  if(pendingAnalyses.get(symbol)===task){pendingAnalyses.delete(symbol);analyzing.delete(symbol)}
 }
}
async function checkSymbolInternal(symbol, force=false){
 if(!state.activeSet.has(symbol)&&!state.researchSet.has(symbol))return null;
 const meta=state.quotes.get(symbol)||{};
 const [h1,h4]=await Promise.all([klines(symbol,'1h',150),klines(symbol,'4h',110)]);
 const out=analyze(symbol,h1,h4,[],meta.price,{quoteVolume:meta.quoteVolume,priceChangePercent:meta.change});
 // 1H closed-candle pattern and 4H trend are already validated in analyze().
 // No shorter than 1H timeframe is queried or required for a confirmed setup.
 out.confirmedTimeframes=['1h','4h'];
 // Historical/approaching observations never affect actual signals, alerts or simulated PNL.
 structureBySymbol.set(symbol,structureObservations(symbol,h1,h4));
 historyBySymbol.set(symbol,historicalPatternObservations(symbol,h1,h4));
 if(!state.activeSet.has(symbol)&&!state.researchSet.has(symbol))return null;
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
function publishCryptoSignal(row,decision,now=Date.now()){
 if(!decision.ready||!storageHealth.healthy)return;
 // Observe the validated scanner output, but never route actual market data to
 // the offline simulation engine or alter the existing paper registration.
 orangeXPaper.observeSignal({...row,decision,qualified:true},{instrumentName:orangeX.instruments.find(name=>name.split('-').slice(0,2).join('')===row.symbol)});
 const {symbol,direction,pattern}=row;
 const paperKey=signalKey({market:'CRYPTO',symbol,direction,pattern,barAt:row.patternConfirmedAt});
 // The same fresh approval may be observed by a scan and many ticker events.
 // Persist each paper registration and alert once, including after a restart.
 if(!paper.store.seen[paperKey])paper.register(row,{market:'CRYPTO',symbol,quoteEligible:true});
 const key=`${symbol}:${direction}:${pattern}:${row.time}`;
 if(persisted.seen[key])return;
 const item={...row,decision,execution:decision.execution,qualified:true,status:'signal',id:key};
 save({...persisted,seen:{...persisted.seen,[key]:now},alerts:[item,...persisted.alerts]});
 send('alert',item);void tgNotify(item);
 console.log('[SIGNAL]',symbol,direction,pattern,row.score);
}
// Event-driven scanner. The global mini-ticker stream supplies fast price updates;
// per-symbol 1H + 4H kline close streams trigger re-analysis at candle completion.
// Historical candles and Variational indicative prices remain REST snapshots, not tick-perfect.
const liveQueue=[];const queued=new Set();const lastTrigger=new Map();let liveWorkers=0;
const liveSockets=[];let liveSubscriptionKey='';let streamRequestId=1;
function invalidateCandles(symbol){for(const interval of ['1h','4h'])for(const suffix of [150,110,100])apiCache.delete(`/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${suffix}`)}
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
      send('live',{symbol:item.symbol,reason:item.reason,at:state.lastLiveTrigger,signals:relevantSignals(),patterns:confirmedPatterns(),watch:watches()});
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
 const monitored=state.variational==='connected'?state.activeSymbols:(state.researchSymbols.length?state.researchSymbols:state.activeSymbols);
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
 if(!storageHealth.healthy||!state.activeSet.has(symbol)||state.variational!=='connected')return false;
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
     // OrangeX comparison requires Binance's source event clock; the existing
     // scanner's receipt-time behavior remains unchanged.
     p.exchangePriceAt=typeof q.E==='number'&&Number.isFinite(q.E)&&q.E>0?q.E:null;
     if(q.q)p.quoteVolume=Number(q.q);state.quotes.set(q.s,p);changed.set(q.s,[q.s,p.price,p.priceAt]);
     paper.onPrice('CRYPTO',q.s,p.price,p.priceAt,{entryAllowed:cryptoEntryAllowed(q.s,p.priceAt)});priceLevelTrigger(q.s,previous,p.price);valid++;
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
function getScanFunnel(){return describeScanFunnel(state.analyses,{activeSymbols:state.activeSymbols,researchSymbols:state.variational==='connected'?[]:state.researchSymbols,variational:state.variational,assess:row=>assessAnalysis(row)});}
function getStatus(){return {storage:{...storageHealth},version:'5.8.0',scanMode:state.scanMode,scanFunnel:getScanFunnel(),structureCount:recentStructures().length,historicalCount:recentHistory().length,researchCount:state.researchSymbols.length,verifiedAt:state.lastValidatedAt,rest:state.rest,ws:state.ws,variational:state.variational,lastVariational:state.lastVariational,binancePerps:state.binancePerps,variationalPerps:state.variationalPerps,error:state.error,activeCount:state.activeSymbols.length,scannedTotal:state.analyses.size,
 cycleScanned:state.cycleScanned,cycle:state.cycle,scannedSinceBoot:state.scannedSinceBoot,lastScan:state.lastScan,lastScanAttempt:state.lastScanAttempt,scanStartedAt:state.scanStartedAt,scanFailedAt:state.scanFailedAt,marketError:state.marketError,marketRetryCount:state.marketRetryCount,lastMarket:state.lastMarket,lastTickerAt:state.lastTickerAt,lastTickerCount:state.lastTickerCount,scanSuccess:state.scanSuccess,scanFailed:state.scanFailed,lastScanFailures:state.lastScanFailures,lastScanSuccessAt:state.lastScanSuccessAt,
 intervalMs:CONFIG.scanMs,minimumVolume:CONFIG.quoteVolume,telegramConfigured:Boolean(CONFIG.tgToken&&CONFIG.tgChat),watchlist:persisted.watchlist,scanning:state.scanActive,executionRefreshAt:state.executionRefreshAt,lastMarketListings:state.lastMarketListings,blockedSignals:state.blockedSignals,lastBlockReason:state.lastBlockReason,executionLimits:CONFIG.limits,
 strictRejected:[...state.analyses.values()].filter(x=>x.pattern&&!x.technicalQualified).length,strictTechPassed:[...state.analyses.values()].filter(x=>x.pattern&&x.technicalQualified===true).length,
 liveWS:state.liveWS,liveWatched:state.liveWatched,lastLiveDataAt:state.lastLiveDataAt,lastLiveCandleClose:state.lastLiveCandleClose,liveSubscribeAcks:state.liveSubscribeAcks,liveSubscribeErrors:state.liveSubscribeErrors,liveLastError:state.liveLastError,lastLiveTrigger:state.lastLiveTrigger,livePending:state.livePending,liveAnalyzed:state.liveAnalyzed,confirmedPatternCount:confirmedPatterns().length,newsStatus:state.newsStatus,newsChecked:state.newsChecked,newsCount:state.news.length,newsError:state.newsError,newsSources:state.newsSources,update:state.update};}
function recentAnalyses(){return [...state.analyses.values()].filter(x=>state.activeSet.has(x.symbol)||(state.variational!=='connected'&&state.researchSet.has(x.symbol))).sort((a,b)=>b.scannedAt-a.scannedAt).slice(0,140).map(x=>currentAnalysis(x));}
function confirmedPatterns(){
 // The user needs to see *all actually identified, closed-1H chart patterns*.
 // Strict quality and Variational order verification are deliberately displayed as
 // separate statuses. This function NEVER triggers an alert or paper trade.
 const now=Date.now();
 return [...state.analyses.values()].filter(x=>
   (state.activeSet.has(x.symbol)||(state.variational!=='connected'&&state.researchSet.has(x.symbol)))&&x.patternConfirmed===true&&Boolean(x.pattern)&&
   Number.isFinite(x.patternConfirmedAt)&&x.patternConfirmedAt<=now&&
   now-x.patternConfirmedAt<2*3600000&&now-x.scannedAt<120*60000
 ).sort((a,b)=>(b.patternConfirmedAt-a.patternConfirmedAt)||(b.score-a.score)).slice(0,65).map(x=>currentAnalysis(x));
}
function assessAnalysis(row,now=Date.now()){
 const m=state.quotes.get(row.symbol);
 return evaluateSignal(row,{verified:state.activeSet.has(row.symbol),venueConnected:state.variational==='connected',
  listing:m?.variational,price:m?.price,priceAt:m?.priceAt,statsReceivedAt:state.lastVariational,now,limits:CONFIG.limits});
}
function currentAnalysis(row,now=Date.now()){
 const decision=assessAnalysis(row,now);
 const quality=row.quality?{...row.quality,passed:decision.technical,failed:decision.technicalReasons,
  checks:row.quality.checks?.map(c=>c.key==='fresh'&&now>row.quality.validUntil?{...c,passed:false,value:'필수 봉 신선도 만료'}:c)}:row.quality;
 return {...row,quality,technicalQualified:decision.technical,decision,execution:decision.execution,qualified:decision.ready,
  status:row.pattern?(decision.ready?'signal':'watch'):row.status,
  executionStatus:decision.execution.eligible?'호가·비용 기준 통과':'실매매 검증 보류'};
}
function relevantSignals(){
 const now=Date.now();
 return [...state.analyses.values()].filter(x=>state.activeSet.has(x.symbol)).map(x=>currentAnalysis(x,now))
  .filter(x=>x.decision.ready).sort((a,b)=>b.score-a.score);
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
  if((!state.ranked.length&&!state.researchRanked.length)||state.variational!=='connected'||Date.now()-state.lastMarketListings>10*60000){
   try{await loadMarket()}catch(e){state.marketError=e.message}
  }
  const rows=state.variational==='connected'?state.ranked:(state.researchRanked.length?state.researchRanked:state.ranked);
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
  if(state.variational==='connected')state.error='';
  send('scan',{status:getStatus(),signals:relevantSignals(),patterns:confirmedPatterns(),watch:watches(),structures:recentStructures(),history:recentHistory(),coverage:targets,recent:recentAnalyses().slice(0,24)});
  console.log(`[SCAN] ${new Date().toISOString()} mode=${state.scanMode} checked=${targets.length}/${rows.length} success=${state.scanSuccess} failed=${state.scanFailed} candidates=${getScanFunnel().patternCount} qualityBlocks=${getScanFunnel().quality} quoteBlocks=${getScanFunnel().venue} actionable=${relevantSignals().length}`);
 }catch(e){state.error=e.message;state.marketError=e.message;state.marketRetryCount++;state.scanFailedAt=Date.now();console.error('[SCAN ERROR]',e.message);send('status',getStatus())}
 finally{state.scanActive=false;state.scanStartedAt=0;send('status',getStatus())}
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
 const incoming=prepareNews(feeds,state.newsChecked,[...state.ranked.map(x=>({symbol:x.baseAsset,name:x.variational?.name||''})),...tradfiState.swaps.map(x=>({symbol:x.base,name:x.name||''}))]);
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
 for(const article of notifications){send('news-alert',article);void tgNews(article)}
 send('news',{status:state.newsStatus,checked:state.newsChecked,articles:state.news,sourceCount:feeds.length,error:state.newsError});
}
async function tgNews(article){
 if(!CONFIG.newsTelegram||!CONFIG.tgToken||!CONFIG.tgChat)return;
 const lines=['📰 [속보 후보 · 자동 분류] '+article.title,`출처: ${article.source} / 발행 ${new Date(article.published).toLocaleString('ko-KR',{timeZone:'Asia/Seoul'})}`,`분류: ${article.tone==='risk'?'부정 이슈 가능성':article.tone==='opportunity'?'긍정 이슈 가능성':'영향 방향 불명'} · 기사 원문 확인 필수`,article.link];
 try{const res=await fetch(`https://api.telegram.org/bot${CONFIG.tgToken}/sendMessage`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({chat_id:CONFIG.tgChat,text:lines.join('\n'),disable_web_page_preview:true,reply_markup:{inline_keyboard:[[{text:'기사 원문 열기 ↗',url:article.link}]]}}),signal:AbortSignal.timeout(10000)});
 if(!res.ok)console.warn('[NEWS TG]',res.status);
 }catch(e){console.warn('[NEWS TG]',e.message)}
}
function bodyJson(req){return new Promise((resolve,reject)=>{let buf='';req.on('data',c=>{buf+=c;if(buf.length>30000){reject(Error('Body too large'));req.destroy()}});req.on('end',()=>{try{resolve(JSON.parse(buf))}catch{reject(Error('Invalid JSON'))}})})}
const server=http.createServer(async(req,res)=>{
 try{
  if(lanMode && !authorizedRequest(req.socket.remoteAddress,req.headers.authorization,lanPassword)){
   res.writeHead(401,{'WWW-Authenticate':'Basic realm="Signal Lab mobile - username signal", charset="UTF-8"','Content-Type':'text/plain; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
   res.end('Signal Lab: 모바일 접속 인증이 필요합니다. PC 실행 창에 표시된 사용자명(signal)과 접속 암호를 입력하세요.');return;
  }
  const url=new URL(req.url,'http://localhost');const pathname=url.pathname;
  if(pathname==='/api/orangex'||pathname.startsWith('/api/orangex/')){
   if(req.method!=='GET')return response(res,405,{error:'ORANGEX_READ_ONLY',message:'OrangeX 1단계는 조회만 허용합니다.',orderSubmissionEnabled:false});
   if(pathname==='/api/orangex/paper')return response(res,200,orangeXPaper.snapshot());
   if(pathname!=='/api/orangex')return response(res,404,{error:'ORANGEX_READ_ONLY_ROUTE_NOT_FOUND',orderSubmissionEnabled:false});
   try{
    const snapshot=await orangeX.snapshot({refresh:url.searchParams.get('refresh')==='1'});
    snapshot.markets=snapshot.markets.map(market=>({...market,binanceComparison:
     compareOrangeXBinance(market,state.quotes.get(market.symbol),{now:Date.now()})}));
    if(orangeXConfigError)snapshot.errors=[...(snapshot.errors||[]),{code:'CONFIG_INVALID',message:'OrangeX 설정이 유효하지 않아 연결을 비활성화했습니다.',at:Date.now()}];
    return response(res,200,snapshot);
   }catch{return response(res,503,{mode:'READ_ONLY',connected:false,orderSubmissionEnabled:false,error:'ORANGEX_READ_FAILED'})}
  }
  if(pathname==='/events'){
   res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache, no-transform','Connection':'keep-alive','X-Accel-Buffering':'no'});
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
  if(pathname==='/api/scan/diagnostics')return response(res,200,{structureCount:recentStructures().length,historicalPatternCount:recentHistory().length,at:Date.now(),...getScanFunnel(),scannedSinceBoot:state.scannedSinceBoot,scanSuccess:state.scanSuccess,scanFailed:state.scanFailed,scanMode:state.scanMode,variational:state.variational,marketError:state.marketError});
  if(pathname==='/api/storage')return response(res,200,{mode:'shared-persistent',persistent:storageHealth.healthy,updatedByServer:true,...storageHealth,paperOpen:persisted.paper?.open?.length||0,paperClosed:persisted.paper?.closed?.length||0,journal:persisted.journal.length,alerts:persisted.alerts.length});
  if(pathname==='/api/paper'&&req.method==='GET')return response(res,200,{
   ...paper.snapshot(),storage:{...storageHealth},monitor:paperEngineHealth({paper:paper.store,telemetry:paper.telemetry,
    scanner:{ws:state.ws,lastTickerAt:state.lastTickerAt,variational:state.variational,scanMode:state.scanMode,activeCount:state.activeSymbols.length},
    tradfi:{status:tradfiState.status,updatedAt:tradfiState.updatedAt,feedStatus:tradfiState.feedStatus,feedUpdatedAt:tradfiState.feedUpdatedAt}})
  });
  if(pathname==='/api/paper/notifications'&&req.method==='GET')return response(res,200,{enabled:persisted.paperNotify.enabled,
   serverPlatform:process.platform,windowsSupported:process.platform==='win32',history:persisted.paperNotify.history.slice(0,50),
   note:'Windows 로그인 세션에 표시 요청. 방해 금지/알림 설정 또는 작업 스케줄러의 비대화형 실행 시 표시되지 않을 수 있음'});
  if(pathname==='/api/paper/notifications/settings'&&req.method==='POST'){
   const body=await bodyJson(req);
   if(typeof body?.enabled!=='boolean')return response(res,400,{error:'enabled must be a boolean'});
   persisted.paperNotify.enabled=body.enabled;save();send('paper-notify-settings',{enabled:body.enabled});
   return response(res,200,{enabled:body.enabled});
  }
  if(pathname==='/api/paper/notifications/test'&&req.method==='POST'){
   if(!persisted.paperNotify.enabled)return response(res,409,{error:'알림이 꺼져 있습니다. 먼저 켜주세요.'});
   const body=await bodyJson(req);
   const type=body?.type==='CLOSE'?'CLOSE':'OPEN';
   const example={type,key:'demo-only',market:'CRYPTO',symbol:'BTCUSDT',direction:'LONG',at:Date.now(),entryFill:100,
    notionalUSD:100,stop:98,lastExitFill:104,closeReason:'ALL_TARGETS',realizedPnLUSD:3.52,feesUSD:0.48};
   const result=emitPaperNotice(example,{test:true});
   return response(res,200,{...result,warning:'모의 테스트 알림. 실제 포지션이 생성되지 않고 PNL 기록에 저장되지 않음'});
  }
  if(pathname==='/api/paper/export'&&req.method==='GET'){
   res.writeHead(200,{'Content-Type':'text/csv; charset=utf-8','Content-Disposition':'attachment; filename=signal-lab-auto-paper-trades.csv','Cache-Control':'no-store'});
   return res.end(paperCSV(paper.store.closed));
  }
  if(pathname==='/api/tradfi')return response(res,200,tradfiPublic());
  if(pathname==='/api/tradfi/refresh'&&req.method==='POST'){void refreshTradFi();return response(res,202,{accepted:true});}
  if(pathname==='/api/scan'&&req.method==='POST'){if(state.scanActive)return response(res,202,{accepted:false,reason:'스캔 진행 중',status:getStatus()});void runScan();return response(res,202,{accepted:true,message:'백그라운드 스캔 시작',status:getStatus()})}
  if(pathname==='/api/update')return response(res,200,{...state.update,configured:Boolean(CONFIG.updateManifestURL),version:JSON.parse(fs.readFileSync(path.join(__dirname,'package.json'),'utf8')).version,pending:pendingInfo(__dirname)?.version||null});
  if(pathname==='/api/update/check'&&req.method==='POST')return response(res,200,await checkSoftwareUpdate());
  if(pathname==='/api/news')return response(res,200,{status:state.newsStatus,checked:state.newsChecked,sourceCount:state.newsSources.length,error:state.newsError,articles:state.news});
  if(pathname==='/api/journal'&&req.method==='GET')return response(res,200,{entries:persisted.journal.slice(0,200),summary:journalSummary(persisted.journal)});
  if(pathname==='/api/journal/export'&&req.method==='GET'){
   res.writeHead(200,{'Content-Type':'text/csv; charset=utf-8','Content-Disposition':'attachment; filename="signal-lab-trade-journal.csv"','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
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
   save();send('journal',{summary:journalSummary(persisted.journal)});return response(res,200,{summary:journalSummary(persisted.journal)});
  }
  if(pathname==='/api/execution'){
   const symbol=(url.searchParams.get('symbol')||'').toUpperCase();
   const side=(url.searchParams.get('side')||'LONG').toUpperCase();
   const amount=Number(url.searchParams.get('size')||1000);
   if(!state.activeSet.has(symbol))return response(res,404,{error:'공통 PERP 미확인 종목'});
   if(!['LONG','SHORT'].includes(side)||!Number.isFinite(amount)||amount<1||amount>10000)return response(res,400,{error:'방향이나 포지션 금액이 유효하지 않음'});
   const x=state.quotes.get(symbol);
   const result=executionEstimate({listing:x?.variational,side,notional:amount,binancePrice:x?.price,binancePriceAt:x?.priceAt,statsReceivedAt:state.lastVariational,now:Date.now(),limits:CONFIG.limits});
   if(state.variational!=='connected'){result.eligible=false;result.reasons.unshift('Variational 공식 데이터 연결 실패')}
   return response(res,200,{symbol,...result});
  }
  if(pathname==='/api/market')return response(res,200,{at:state.lastMarket,markets:state.ranked.map(x=>({...x,...state.quotes.get(x.symbol)})),research:state.variational==='connected'?[]:state.researchRanked.filter(x=>!state.activeSet.has(x.symbol)),watchlist:persisted.watchlist,variationalStatus:state.variational});
  if(pathname==='/api/results')return response(res,200,{structures:recentStructures(),history:recentHistory(),signals:relevantSignals(),patterns:confirmedPatterns(),watch:watches(),alerts:persisted.alerts.filter(x=>state.activeSet.has(x.symbol)).slice(0,35).map(x=>({...x,lifecycle:signalLifecycle(x,{price:state.quotes.get(x.symbol)?.price,priceAt:state.quotes.get(x.symbol)?.priceAt})})),recent:recentAnalyses()});
  if(pathname==='/api/klines'){
   const symbol=(url.searchParams.get('symbol')||'').toUpperCase();const interval=url.searchParams.get('interval')||'1h';
   if(!/^[A-Z0-9]{3,25}$/.test(symbol)||!['1h','4h','1d'].includes(interval))return response(res,400,{error:'Invalid symbol or interval'});
   if(!state.activeSet.has(symbol))return response(res,404,{error:'바이낸스·Variational 공통 PERP 종목이 아니거나 상장 확인 대기 중입니다.'});
   return response(res,200,{symbol,interval,rows:await klines(symbol,interval,180)});
  }
  if(pathname==='/api/analyze'){
   const symbol=(url.searchParams.get('symbol')||'BTCUSDT').toUpperCase();
   if(!/^[A-Z0-9]{3,25}$/.test(symbol))return response(res,400,{error:'Invalid symbol'});
   if(!state.activeSet.has(symbol))return response(res,404,{error:'바이낸스·Variational 공통 PERP 종목이 아니거나 상장 확인 대기 중입니다.'});
   const result=await checkSymbol(symbol,true);return response(res,200,result);
  }
  if(pathname==='/api/watchlist'&&req.method==='POST'){
   const {symbols}=await bodyJson(req);
   if(!Array.isArray(symbols))return response(res,400,{error:'Invalid symbols'});
   const next=[...new Set(symbols.map(x=>String(x).toUpperCase()))];
   if(next.some(x=>!state.activeSet.has(x)))return response(res,400,{error:'현재 공통 상장 PERP가 아닌 종목이 포함되어 있습니다.'});
   persisted.watchlist=next.slice(0,35);
   save();refreshLiveSubscriptions();return response(res,200,{watchlist:persisted.watchlist});
  }
  if(pathname==='/api/ping')return response(res,200,{ok:true,ts:Date.now()});
  if(pathname.startsWith('/api/'))return response(res,404,{error:'Not found'});
  let file=pathname==='/'?'/index.html':pathname;
  const safe=path.resolve(path.join(__dirname,'public'),'.'+file), root=path.resolve(__dirname,'public');
  if(!safe.startsWith(root+path.sep)&&safe!==root)return response(res,403,{error:'Forbidden'});
  fs.readFile(safe,(err,buf)=>{
   if(err){res.writeHead(404);res.end('Not Found');return}
   res.writeHead(200,{'Content-Type':MIME[path.extname(safe)]||'application/octet-stream','Cache-Control':'no-cache'});res.end(buf);
  });
 }catch(e){response(res,e.code==='STORE_WRITE_FAILED'?503:502,{error:e.message})}
});
server.listen(CONFIG.port,CONFIG.host,()=>{
 console.log(`\nSignal Lab (PC) → http://127.0.0.1:${CONFIG.port}`);
 console.log(`[DATA] Records & settings: ${storage.dir}`);
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
 console.log(`Binance live ticks + candle-close event scans for verified Variational matches; background ${Math.round(CONFIG.scanMs/60000)} min / news ${Math.round(CONFIG.newsMs/1000)} sec. Telegram ${CONFIG.tgChat?'enabled':'disabled'}.`);
 if(CONFIG.autoUpdate){setTimeout(()=>checkSoftwareUpdate().catch(()=>{}),8000);setInterval(()=>checkSoftwareUpdate().catch(()=>{}),6*3600000)}
 connectWS();setTimeout(runScan,1200);setInterval(()=>void runScan(),CONFIG.scanMs);
 setTimeout(()=>void refreshTradFi().then(()=>runTradFiScan()),2500);
 setInterval(()=>void refreshTradFi(),CONFIG.tradfiMs);
 setInterval(()=>void runTradFiScan(),CONFIG.tradfiScanMs);
 // Retry market discovery quickly after an API failure rather than staying empty for 4 minutes.
 setInterval(()=>{if(!state.activeSymbols.length&&!state.researchSymbols.length&&!state.scanActive){state.marketLastRetry=Date.now();void runScan()}},20000);
 setInterval(refreshExecution,60000);
 setInterval(()=>{try{if(!storageHealth.healthy)save();paper.expirePending()}catch(e){console.warn('[PAPER STORAGE]',e.message)}},15000);
 setTimeout(()=>pollNews().catch(e=>console.warn('[NEWS]',e.message)),2000);setInterval(()=>pollNews().catch(e=>{state.newsStatus='offline';state.newsError=e.message;console.warn('[NEWS]',e.message)}),CONFIG.newsMs);
});
server.on('error',err=>{
 console.error('\n[START ERROR]',err.message);
 if(err.code==='EADDRINUSE') console.error(`Port ${CONFIG.port} is already in use. Close the other server window or change PORT in .env.`);
 else if(err.code==='EACCES') console.error('Access denied to local port. Try another PORT in .env.');
 process.exit(1);
});
const gracefulShutdown=()=>{try{save()}catch(e){console.error('[SHUTDOWN STORE]',e.message)}server.close(()=>process.exit(0));setTimeout(()=>process.exit(0),2000)};
process.on('SIGINT',gracefulShutdown);process.on('SIGTERM',gracefulShutdown);
