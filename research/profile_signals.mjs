// Stage 4, step 1: the live 1H/4H signals over the cached year, saved once for the profile
// comparison (research/profile_compare.mjs). Research only: reads cached candles, no network.
//   node research/profile_signals.mjs <cacheDir> <out.json> [SYMBOL,...]
// Each signal: symbol, at (entry = open of the next 1h candle), direction, pattern, score, entry,
// signal stop, ATR, volume zones (1h 30 days + 4h 90 days, closed candles only) and targets.
// Execution is replayed later on 1h candles (no 5m/15m data in the cache): coarser than live.
import fs from 'node:fs';import path from 'node:path';import zlib from 'node:zlib';
import {analyze} from '../engine.mjs';
import {planVolumeTargets} from '../volume_targets.mjs';
import {scoreGatePassed,DEFAULT_TRADE_PATTERNS} from '../signal_policy.mjs';
import {closedUntil,profileAt,onTick,HOUR,BACKTEST_COSTS} from '../backtest.mjs';
import {leverageForScore} from '../paper.mjs';
import {fourHourTrend} from '../scalp_reversal.mjs';

const [cache='backtest-cache',outFile='profile-signals.json',only]=process.argv.slice(2);
const load=f=>JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(cache,f))));
const info=load('exchangeInfo.json.gz');
const filtersOf=symbol=>{const s=info.symbols.find(x=>x.symbol===symbol);if(!s)return null;const f=Object.fromEntries(s.filters.map(x=>[x.filterType,x]));
 return {tickSize:Number(f.PRICE_FILTER.tickSize),stepSize:Number(f.LOT_SIZE.stepSize),minQty:Number(f.LOT_SIZE.minQty),minNotional:Number(f.MIN_NOTIONAL?.notional??5)}};
const symbols=only?only.split(','):fs.readdirSync(cache).filter(f=>f.endsWith('_1h.json.gz')).map(f=>f.replace('_1h.json.gz',''));
const btcH4=load('BTCUSDT_4h.json.gz');
const fb={minCandles:96,targetBins:240,hvnMinFractionOfPoc:.05};
const out=[],funnel={};
for(const symbol of symbols){
 const h1=load(symbol+'_1h.json.gz'),h4=load(symbol+'_4h.json.gz'),filters=filtersOf(symbol);if(!filters)continue;
 const f=funnel[symbol]={bars:0,patterns:0,validated:0,gate:0,kept:0};const t0=Date.now();
 for(let j=200;j<h1.length-1;j++){
  const closeAt=Number(h1[j][6]),now=closeAt+1000;f.bars++;
  const h1s=h1.slice(j-199,j+1),i4=closedUntil(h4,now),h4s=h4.slice(Math.max(0,i4-301),i4),ib=closedUntil(btcH4,now),btc=btcH4.slice(Math.max(0,ib-301),ib);
  const a=analyze(symbol,h1s,h4s,[],Number(h1[j][4]),{now,btcH4Rows:btc});
  if(!a.patternConfirmed)continue;f.patterns++;
  if(a.quality?.validationPassed!==true)continue;f.validated++;
  if(!DEFAULT_TRADE_PATTERNS.includes(a.pattern)||!scoreGatePassed(a.score,a.pattern))continue;f.gate++;
  const next=h1[j+1],dir=a.direction==='LONG'?1:-1,entry=onTick(Number(next[1]),filters.tickSize,'NEAREST');
  const stop=onTick(a.stop,filters.tickSize,dir===1?'DOWN':'UP');
  if(Math.abs(entry-a.entry)>Math.min(a.entry*.004,a.atr*.45)||dir*(entry-stop)<=0)continue;
  const p1=profileAt(h1,now,symbol,filters.tickSize,{candles:720,intervalMs:HOUR,interval:'1h',...fb});
  const p4=profileAt(h4,now,symbol,filters.tickSize,{candles:540,intervalMs:4*HOUR,interval:'4h',...fb});
  const zones=[...(p1.ok?p1.profile.hvn:[]),...(p4.ok?p4.profile.hvn:[])].map(z=>({priceLow:z.priceLow,priceHigh:z.priceHigh}));
  // Targets from the 1h profile (live uses 15m; not cached). Quantity only matters for the minimum order check.
  const q=Math.max(filters.minQty,Math.ceil(10/entry/filters.stepSize)*filters.stepSize);
  const tp=p1.ok?planVolumeTargets({profileResult:p1,direction:a.direction,entry,stop,quantity:q,tickSize:filters.tickSize,quantityStep:filters.stepSize,minQuantity:filters.minQty,
   minNotional:filters.minNotional,contractSizeBase:1,quantityUnit:'BASE_ASSET',notionalCurrency:'USDT',unitsVerified:true,costs:BACKTEST_COSTS,minNetRR:1.8,targetMode:'HVN_THEN_R',obstacleFraction:1},{now}):null;
  const targets=tp?.ok?tp.targets:[1,2,3].map(r=>onTick(entry+dir*r*Math.abs(entry-stop),filters.tickSize,dir===1?'UP':'DOWN'));
  f.kept++;
  out.push({symbol,at:Number(next[0]),signalAt:closeAt,direction:a.direction,pattern:a.pattern,score:a.score,entry,stop,atr:a.atr,zones,targets,targetSource:tp?.ok?'1H_PROFILE':'R_MULTIPLE',
   leverage:leverageForScore(a.score,1e9)??10,filters,
   // BTC 4H trend at the signal (the server allows LONG only while it is 'up': btcLongBlocked).
   btcTrend:fourHourTrend(btc,now)});
 }
 console.error(symbol,JSON.stringify(f),((Date.now()-t0)/1000).toFixed(0)+'s');
}
fs.writeFileSync(outFile,JSON.stringify({createdAt:new Date().toISOString(),funnel,signals:out}));
console.error('signals',out.length);
