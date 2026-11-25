import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
 parseGlobalDominance,
 appendDominanceHistory,
 computeDominanceDeltas,
 computeMarketBreadth,
 buildMarketDominanceReport,
 fetchGlobalDominance,
} from '../market_dominance.mjs';
import {renderDominanceHTML} from '../public/dominance_ui.js';

const NOW=1_764_000_000_000;

function sampleGlobal(btc=58.4,eth=12.1,usdt=5.2,usdc=2.3){
 return parseGlobalDominance({
  data:{
   market_cap_percentage:{btc,eth,usdt,usdc,sol:3.8,bnb:3.2},
   total_market_cap:{usd:3_250_000_000_000},
   total_volume:{usd:142_000_000_000},
   market_cap_change_percentage_24h_usd:2.45,
  },
 },NOW);
}

function makeTickers(btcPct,ethPct,altPcts){
 const rows=[
  {symbol:'BTCUSDT',priceChangePercent:String(btcPct),quoteVolume:'25000000000',lastPrice:'95000'},
  {symbol:'ETHUSDT',priceChangePercent:String(ethPct),quoteVolume:'12000000000',lastPrice:'3400'},
  // Should be excluded from alt breadth:
  {symbol:'USDCUSDT',priceChangePercent:'0.01',quoteVolume:'900000000',lastPrice:'1'},
  {symbol:'BTCDOMUSDT',priceChangePercent:'3.5',quoteVolume:'50000000',lastPrice:'3000'},
  {symbol:'TINYUSDT',priceChangePercent:'80.0',quoteVolume:'100000',lastPrice:'0.01'},
 ];
 altPcts.forEach((pct,i)=>{
  rows.push({
   symbol:`ALT${i+1}USDT`,
   priceChangePercent:String(pct),
   quoteVolume:String(30_000_000-i*1_000_000),
   lastPrice:'1.5',
  });
 });
 return rows;
}

test('parseGlobalDominance computes BTC.D, ETH.D, Stable.D, and pure Alt OTHERS.D accurately',()=>{
 const g=sampleGlobal(58.4,12.1,5.2,2.3);
 assert.equal(g.btcDomPct,58.4);
 assert.equal(g.ethDomPct,12.1);
 assert.equal(g.stableDomPct,7.5);
 assert.equal(g.altDomPct,22.0);
 assert.equal(g.exBtcDomPct,34.1);
 assert.equal(g.totalMcapUSD,3_250_000_000_000);
 assert.equal(g.mcapChange24hPct,2.45);
 assert.equal(parseGlobalDominance({data:{}}),null);
 assert.equal(parseGlobalDominance(null),null);
});

test('appendDominanceHistory deduplicates <9m updates and prunes snapshots older than 7 days',()=>{
 const oldPoint={at:NOW-8*86400000,btcDomPct:55,ethDomPct:13,stableDomPct:8,altDomPct:24};
 const recentPoint={at:NOW-30*60000,btcDomPct:57,ethDomPct:12.5,stableDomPct:7.5,altDomPct:23};
 const h1=appendDominanceHistory([oldPoint,recentPoint],{at:NOW-25*60000,btcDomPct:57.2,ethDomPct:12.4,stableDomPct:7.5,altDomPct:22.9});
 assert.equal(h1.length,1,'pruned >7d point and replaced <9m point in-place');
 assert.equal(h1[0].btcDomPct,57.2);
 const h2=appendDominanceHistory(h1,{at:NOW,btcDomPct:58.0,ethDomPct:12.1,stableDomPct:7.5,altDomPct:22.4});
 assert.equal(h2.length,2,'appended new point after >=9m gap');
});

test('computeDominanceDeltas prefers 24h reference and falls back to >=1h window',()=>{
 const current={at:NOW,btcDomPct:59.0,ethDomPct:11.8,stableDomPct:7.2,altDomPct:22.0};
 const history24h=[
  {at:NOW-26*3600000,btcDomPct:57.5,ethDomPct:12.2,stableDomPct:7.5,altDomPct:22.8},
  {at:NOW-24*3600000,btcDomPct:58.2,ethDomPct:12.0,stableDomPct:7.4,altDomPct:22.4},
  {at:NOW-2*3600000,btcDomPct:58.8,ethDomPct:11.9,stableDomPct:7.3,altDomPct:22.0},
 ];
 const d24=computeDominanceDeltas(current,history24h);
 assert.equal(d24.is24h,true);
 assert.equal(d24.windowHours,24);
 assert.equal(d24.btcDomDelta,0.8);
 assert.equal(d24.altDomDelta,-0.4);

 const shortHistory=[{at:NOW-3*3600000,btcDomPct:58.5,ethDomPct:12.0,stableDomPct:7.3,altDomPct:22.2}];
 const dShort=computeDominanceDeltas(current,shortHistory);
 assert.equal(dShort.is24h,false);
 assert.equal(dShort.windowHours,3);
 assert.equal(dShort.btcDomDelta,0.5);

 assert.equal(computeDominanceDeltas(current,[{at:NOW-20*60000,btcDomPct:58.9}]),null);
});

test('computeMarketBreadth filters stables/indices/low-volume pairs and computes relative stats',()=>{
 const tickers=makeTickers(4.0,1.0,[-2,-1,0,1,2,3]);
 const b=computeMarketBreadth(tickers);
 assert.ok(b);
 // ETHUSDT + 6 ALT pairs = 7 alts (TINYUSDT, USDCUSDT, BTCDOMUSDT excluded)
 assert.equal(b.sampleCount,7);
 assert.equal(b.btcPct24h,4);
 assert.equal(b.ethPct24h,1);
 assert.equal(b.altMedianPct24h,1);
 assert.equal(b.altSpreadPct,-3);
 assert.equal(b.altBeatBtcPct,0);
 assert.ok(b.ethBtcPct24h<0);
 assert.equal(b.topAlts[0].symbol,'ALT6USDT');
 assert.equal(b.bottomAlts[0].symbol,'ALT1USDT');
});

test('buildMarketDominanceReport classifies all 5 regimes and distinguishes offensive vs defensive BTC dominance',()=>{
 const g=sampleGlobal(60.2,11.5,7.3,1.0);
 const histUp=[{at:NOW-24*3600000,btcDomPct:59.1,ethDomPct:12.0,stableDomPct:7.3,altDomPct:21.6}];
 const histDown=[{at:NOW-24*3600000,btcDomPct:61.3,ethDomPct:11.0,stableDomPct:7.3,altDomPct:20.4}];

 // 1. BTC_STRONG (offensive rally)
 const btcRally=buildMarketDominanceReport({global:g,history:histUp,tickers:makeTickers(5.5,1.0,[-1,-0.5,0.2,0.5,1.0,1.2]),now:NOW});
 assert.equal(btcRally.regime,'BTC_STRONG');
 assert.equal(btcRally.tone,'btc-strong');
 assert.ok(btcRally.score<=-45);
 assert.match(btcRally.phaseKo,/상승장 BTC 단독 주도/);

 // 2. BTC_STRONG (defensive risk-off drop)
 const btcDef=buildMarketDominanceReport({global:g,history:histUp,tickers:makeTickers(-1.5,-4.5,[-7,-6,-5.5,-5,-4.8,-4]),now:NOW});
 assert.equal(btcDef.regime,'BTC_STRONG');
 assert.match(btcDef.phaseKo,/하락장 BTC 방어/);

 // 3. BTC_LEAD (moderate BTC outperformance)
 const btcLead=buildMarketDominanceReport({global:g,history:[],tickers:makeTickers(2.0,1.4,[0.8,1.0,1.2,1.5,2.2,2.4]),now:NOW});
 assert.equal(btcLead.regime,'BTC_LEAD');
 assert.ok(btcLead.score>-45&&btcLead.score<=-15);

 // 4. NEUTRAL
 const neutral=buildMarketDominanceReport({global:g,history:[],tickers:makeTickers(1.0,1.05,[0.6,0.8,0.9,1.1,1.2,1.3]),now:NOW});
 assert.equal(neutral.regime,'NEUTRAL');
 assert.ok(neutral.score>-15&&neutral.score<15);

 // 5. ALT_LEAD (moderate altcoin outperformance)
 const altLead=buildMarketDominanceReport({global:g,history:[],tickers:makeTickers(1.0,1.6,[0.4,0.7,1.4,1.7,2.0,2.2]),now:NOW});
 assert.equal(altLead.regime,'ALT_LEAD');
 assert.ok(altLead.score>=15&&altLead.score<45);

 // 6. ALT_STRONG
 const altSeason=buildMarketDominanceReport({global:g,history:histDown,tickers:makeTickers(1.2,5.5,[4.5,5.2,6.0,7.5,8.2,9.0]),now:NOW});
 assert.equal(altSeason.regime,'ALT_STRONG');
 assert.equal(altSeason.tone,'alt-strong');
 assert.ok(altSeason.score>=45);
 assert.match(altSeason.phaseKo,/알트 순환매 강세/);
});

test('buildMarketDominanceReport degrades gracefully when CoinGecko is unavailable or tickers are pending',()=>{
 const noGlobal=buildMarketDominanceReport({
  global:null,
  history:[],
  tickers:makeTickers(0.2,4.0,[3.5,4.2,5.1,6.0,7.2]),
  now:NOW,
  globalError:'CoinGecko HTTP 429 (요청 한도 초과)',
 });
 assert.equal(noGlobal.ok,true);
 assert.equal(noGlobal.regime,'ALT_STRONG');
 assert.equal(noGlobal.global,null);
 assert.match(noGlobal.globalError,/429/);

 const onlyGlobal=buildMarketDominanceReport({global:sampleGlobal(),history:[],tickers:[],now:NOW});
 assert.equal(onlyGlobal.ok,true);
 assert.equal(onlyGlobal.regime,'UNAVAILABLE');
 assert.match(onlyGlobal.summaryKo,/BTC\.D 58\.4%/);
});

test('fetchGlobalDominance parses CoinGecko response, sends optional demo key, and surfaces HTTP 429',async()=>{
 let seenHeaders=null;
 const ok=await fetchGlobalDominance({
  apiKey:'demo-key-123',
  fetcher:async(_url,opts)=>{
   seenHeaders=opts.headers;
   return {
    ok:true,
    status:200,
    json:async()=>({data:{market_cap_percentage:{btc:57.5,eth:12.5,usdt:6.0}}}),
   };
  },
 });
 assert.equal(seenHeaders['x-cg-demo-api-key'],'demo-key-123');
 assert.equal(ok.btcDomPct,57.5);
 assert.equal(ok.altDomPct,24.0);

 await assert.rejects(
  ()=>fetchGlobalDominance({fetcher:async()=>({ok:false,status:429})}),
  /HTTP 429/
 );
});

test('renderDominanceHTML renders regime summary, stack bar, gauge, movers, and escapes error strings',()=>{
 const loadingHtml=renderDominanceHTML(null);
 assert.match(loadingHtml,/시장 주도권 조회 중/);

 const report=buildMarketDominanceReport({
  global:sampleGlobal(58.4,12.1,5.2,2.3),
  history:[{at:NOW-24*3600000,btcDomPct:57.8,ethDomPct:12.3,stableDomPct:7.5,altDomPct:22.4}],
  tickers:makeTickers(3.2,0.8,[-1.5,-0.5,0.2,0.9,1.2,2.0]),
  now:NOW,
  globalError:'<script>alert(1)</script>',
 });
 const html=renderDominanceHTML(report);
 assert.match(html,/dom-badge btc-strong/);
 assert.match(html,/BTC\.D <b>58\.4%<\/b>/);
 assert.match(html,/알트\.D <b>22\.0%<\/b>/);
 assert.match(html,/dom-stack/);
 assert.match(html,/dom-gauge-dot/);
 assert.match(html,/data-dom-refresh="1"/);
 assert.doesNotMatch(html,/<script>/);
 assert.match(html,/&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
});

test('server.mjs, public/index.html, and public/styles.css wire the market dominance indicator cleanly',()=>{
 const root=path.resolve(import.meta.dirname,'..');
 const serverSrc=fs.readFileSync(path.join(root,'server.mjs'),'utf8');
 const htmlSrc=fs.readFileSync(path.join(root,'public/index.html'),'utf8');
 const cssSrc=fs.readFileSync(path.join(root,'public/styles.css'),'utf8');

 assert.match(serverSrc,/from '\.\/market_dominance\.mjs'/);
 assert.match(serverSrc,/pathname==='\/api\/market-dominance'&&req\.method==='GET'/);
 assert.match(serverSrc,/refreshGlobalDominance/);
 assert.match(htmlSrc,/id="dominanceBar"/);
 assert.match(htmlSrc,/src="\/dominance_ui\.js"/);
 assert.match(cssSrc,/\.dom-bar\{/);
 assert.match(cssSrc,/\.dom-stack\{/);
 assert.match(cssSrc,/\.dom-gauge-track\{/);
});
