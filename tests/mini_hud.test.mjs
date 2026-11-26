import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
 extractMiniBtc,
 extractMiniRealPositions,
 extractMiniDominance,
 renderMiniHudHTML,
} from '../public/mini_hud.js';

test('extractMiniBtc reads BTCUSDT price and 24h change from /api/market with dominance fallback',()=>{
 const btc=extractMiniBtc({
  at:1795670000000,
  markets:[
   {symbol:'ETHUSDT',price:3200,change:1.1},
   {symbol:'BTCUSDT',price:95420.5,change:2.34,priceAt:1795670001234},
  ],
 });
 assert.equal(btc.price,95420.5);
 assert.equal(btc.changePct,2.34);
 assert.equal(btc.at,1795670001234);

 const fallback=extractMiniBtc(
  {markets:[{symbol:'BTCUSDT',price:94100}]},
  {breadth:{btcPct24h:-1.45}}
 );
 assert.equal(fallback.price,94100);
 assert.equal(fallback.changePct,-1.45);
});

test('extractMiniRealPositions reads ONLY real BingX LIVE venuePositions, computes total PnL, and ignores empty rows',()=>{
 const real=extractMiniRealPositions({
  mode:'LIVE',
  funds:{equity:4250.5,available:3100.2},
  venuePositions:[
   {symbol:'SOLUSDT',direction:'SHORT',size:10,avg:180.5,mark:182.0,unrealized:-15.0,roePct:-4.15,leverage:5,origin:'manual'},
   {symbol:'BTCUSDT',direction:'LONG',size:0.1,avg:94000,mark:95420.5,unrealized:142.05,roePct:15.11,leverage:10,origin:'copy'},
   {symbol:'ETHUSDT',direction:'LONG',size:0,avg:3000,mark:3100,unrealized:0,roePct:0,leverage:5,origin:'manual'},
  ],
 });
 assert.equal(real.ready,true);
 assert.equal(real.mode,'LIVE');
 assert.equal(real.equity,4250.5);
 assert.equal(real.available,3100.2);
 assert.equal(real.positions.length,2);
 // Sorted by largest absolute unrealized PnL first
 assert.equal(real.positions[0].symbol,'BTCUSDT');
 assert.equal(real.positions[0].origin,'카피');
 assert.equal(real.positions[1].symbol,'SOLUSDT');
 assert.equal(real.positions[1].direction,'SHORT');
 assert.equal(real.positions[1].origin,'수동');
 assert.ok(Math.abs(real.totalUnrealized-127.05)<1e-6);
});

test('extractMiniDominance surfaces BTC.D, USDT.D, alt/BTC regime, and cash-flight detection',()=>{
 const alt=extractMiniDominance({
  ok:true,
  labelKo:'알트코인 강세장',
  emoji:'🚀',
  tone:'alt-strong',
  phaseKo:'알트 순환매 강세 유입',
  global:{btcDomPct:57.2,usdtDomPct:4.6,altDomPct:25.1},
  deltas:{btcDomDelta:-0.34,usdtDomDelta:-0.12},
  breadth:{btcPct24h:1.2,altBeatBtcPct:74},
 });
 assert.equal(alt.ok,true);
 assert.equal(alt.btcDomPct,57.2);
 assert.equal(alt.usdtDomPct,4.6);
 assert.equal(alt.cashFlight,false);
 assert.equal(alt.regimeLabel,'알트코인 강세장');

 const cash=extractMiniDominance({
  ok:true,
  labelKo:'비트코인 우세',
  emoji:'🟡',
  tone:'btc',
  phaseKo:'하락장 BTC 방어 · 알트 약세',
  global:{btcDomPct:59.1,usdtDomPct:5.3,altDomPct:22.4},
  deltas:{btcDomDelta:0.42,usdtDomDelta:0.24},
  breadth:{btcPct24h:-2.6,altBeatBtcPct:18},
 });
 assert.equal(cash.cashFlight,true);
 assert.equal(cash.regimeTone,'cash');
 assert.match(cash.regimeLabel,/현금 대피/);
});

test('renderMiniHudHTML renders BTC, real positions, and dominance cleanly with strict XSS escaping and zero order buttons',()=>{
 const html=renderMiniHudHTML({
  btc:{price:95420.5,changePct:2.34,at:Date.now()},
  real:extractMiniRealPositions({
   mode:'LIVE',
   funds:{equity:5000,available:4100},
   venuePositions:[
    {symbol:'BTCUSDT',direction:'LONG',size:0.1,avg:94000,mark:95420.5,unrealized:142.05,roePct:15.11,leverage:10,origin:'manual'},
   ],
   venuePositionsError:'<script>alert(1)</script>',
  }),
  dom:extractMiniDominance({
   ok:true,labelKo:'비트코인 강한 독주',emoji:'🟠',tone:'btc-strong',phaseKo:'상승장 BTC 단독 주도',
   global:{btcDomPct:60.2,usdtDomPct:4.5,altDomPct:21.0},deltas:{btcDomDelta:0.51,usdtDomDelta:-0.08},breadth:{btcPct24h:2.34,altBeatBtcPct:24},
  }),
  connected:true,
  now:Date.parse('2026-11-26T06:00:00Z'),
 },{standalone:true});

 assert.ok(html.includes('$95,420.5'));
 assert.ok(html.includes('+2.34%'));
 assert.ok(html.includes('실계좌 포지션 · 1개'));
 assert.ok(html.includes('+$142.05'));
 assert.ok(html.includes('+15.1%'));
 assert.ok(html.includes('BTC.D'));
 assert.ok(html.includes('60.2%'));
 assert.ok(html.includes('USDT.D'));
 assert.ok(html.includes('4.5%'));
 assert.ok(html.includes('비트코인 강한 독주'));
 assert.ok(html.includes('&lt;script&gt;'));
 assert.ok(!html.includes('<script>'));
 // Strictly read-only: no order/close buttons or testnet positions
 assert.doesNotMatch(html,/테스트넷|시장가|청산하기|placeOrder/i);
});

test('wiring: index.html topbar launcher, /mini route, strict-CSP mini.html, and updater allowlist',()=>{
 const indexHtml=fs.readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
 const miniHtml=fs.readFileSync(new URL('../public/mini.html',import.meta.url),'utf8');
 const serverSrc=fs.readFileSync(new URL('../server.mjs',import.meta.url),'utf8');
 const launcherSrc=fs.readFileSync(new URL('../public/mini_launcher.js',import.meta.url),'utf8');

 assert.match(indexHtml,/id="miniHudButton"/);
 assert.match(indexHtml,/<script type="module" src="\/mini_launcher\.js"><\/script>/);
 assert.match(miniHtml,/id="miniHudApp"/);
 assert.match(miniHtml,/<script type="module" src="\/mini_hud\.js"><\/script>/);
 assert.doesNotMatch(miniHtml,/<script\b[^>]*>[\s\S]*\S[\s\S]*<\/script>/,'no inline script in mini.html (CSP)');
 assert.match(serverSrc,/pathname==='\/mini'\?'\/mini\.html'/);
 assert.match(launcherSrc,/documentPictureInPicture/);
 assert.match(launcherSrc,/window\.open\('\/mini'/);
});
