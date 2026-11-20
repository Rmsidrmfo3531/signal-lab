import test from 'node:test';
import assert from 'node:assert/strict';
import {displaySymbol} from '../public/symbol_display.js';
import {copyHTML,venuePositionsHTML,analyticsHTML,setAnalyticsOpen,setAnalyticsTab,setFailOpen} from '../public/live_control.js';
import {realTradeMessage} from '../live_telegram.mjs';
import {copyEventText} from '../copy_telegram.mjs';
import {formatStatusReply,AccountAlerts} from '../account_alerts.mjs';
import {buildCopyAnalytics} from '../copy_analytics.mjs';
import {normalizeControlSymbol} from '../copy_controls.mjs';

test('displaySymbol strips BingX TradFi prefixes and 2USD suffix while preserving digits and crypto symbols',()=>{
 assert.equal(displaySymbol('NCSKANTHROPIC2USDUSDT'),'ANTHROPICUSDT');
 assert.equal(displaySymbol('NCSKANTHROPIC2USD-USDT'),'ANTHROPICUSDT');
 assert.equal(displaySymbol('NCSKSNDK2USDUSDT'),'SNDKUSDT');
 assert.equal(displaySymbol('NCSKSNDK2USD-USDT'),'SNDKUSDT');
 assert.equal(displaySymbol('NCSKAAPL2USD-USDT'),'AAPLUSDT');
 assert.equal(displaySymbol('NCSKNVDA2USDUSDT'),'NVDAUSDT');
 assert.equal(displaySymbol('NCSKKKR2USDUSDT'),'KKRUSDT');
 assert.equal(displaySymbol('NCSISP5002USDUSDT'),'SP500USDT');
 assert.equal(displaySymbol('NCSIUS1002USD-USDT'),'US100USDT');
 assert.equal(displaySymbol('NCSIUS302USDUSDT'),'US30USDT');
 assert.equal(displaySymbol('NCCOGOLD2USDUSDT'),'GOLDUSDT');
 assert.equal(displaySymbol('NCFXEURUSD-USDT'),'EURUSDT');
 assert.equal(displaySymbol('NCFXEURUSDUSDT'),'EURUSDT');
 assert.equal(displaySymbol(' ncsksndk2usd-usdt '),'SNDKUSDT');

 // Normal crypto & non-matching fixtures remain untouched
 assert.equal(displaySymbol('BTCUSDT'),'BTCUSDT');
 assert.equal(displaySymbol('1000PEPEUSDT'),'1000PEPEUSDT');
 assert.equal(displaySymbol('NCSUSDT'),'NCSUSDT');
 assert.equal(displaySymbol('NCSKSNDK2USDT'),'NCSKSNDK2USDT');
 assert.equal(displaySymbol(''),'');
 assert.equal(displaySymbol(null),'');
});

test('venuePositionsHTML and copyHTML display cleaned TradFi symbols with raw tooltip and keep raw action payloads',()=>{
 const now=Date.UTC(2026,10,20,6,0,0);
 const vp=[
  {symbol:'NCSKANTHROPIC2USDUSDT',venueSymbol:'NCSKANTHROPIC2USD-USDT',origin:'manual',direction:'LONG',leverage:5,marginMode:'CROSSED',size:1,avg:100,mark:105,margin:20,unrealized:5,roePct:25},
  {symbol:'NCSKSNDK2USDUSDT',venueSymbol:'NCSKSNDK2USD-USDT',origin:'copy',direction:'SHORT',leverage:10,marginMode:'CROSSED',size:2,avg:50,mark:48,margin:10,unrealized:4,roePct:40},
  {symbol:'BTCUSDT',venueSymbol:'BTC-USDT',origin:'copy',direction:'LONG',leverage:20,marginMode:'CROSSED',size:0.1,avg:90000,mark:90500,margin:450,unrealized:50,roePct:11.1},
 ];
 const copyOpen=[{symbol:'SNDKUSDT',direction:'SHORT',adds:1,reduces:0,openedAt:now-3600000}];
 const vpHtml=venuePositionsHTML({mode:'LIVE',venuePositions:vp,venuePositionsAt:now},copyOpen);
 // Clean display text + raw title tooltip for TradFi
 assert.match(vpHtml,/<b[^>]*title="NCSKANTHROPIC2USDUSDT">ANTHROPICUSDT<\/b>/);
 assert.match(vpHtml,/<b[^>]*title="NCSKSNDK2USDUSDT">SNDKUSDT<\/b>/);
 // Raw symbol kept in data-pos-symbol for order execution
 assert.match(vpHtml,/data-pos-symbol="NCSKANTHROPIC2USDUSDT"/);
 // Normal BTCUSDT gets no redundant title attribute
 assert.match(vpHtml,/<b class="vp-symbol">BTCUSDT<\/b>/);
 // Copy ledger SNDKUSDT matched venue NCSKSNDK2USDUSDT so it is not listed as pending
 assert.doesNotMatch(vpHtml,/거래소 확인 중인 카피 기록/);

 // XSS escaping stays intact
 const xss=venuePositionsHTML({mode:'LIVE',venuePositions:[{...vp[0],symbol:'<img src=x>'}]},[]);
 assert.doesNotMatch(xss,/<img/);

 // Closed manual trades, skip events, and analytics table render clean names
 setFailOpen(true);
 setAnalyticsOpen(true);
 setAnalyticsTab('symbol');
 const analytics=buildCopyAnalytics({
  copyClosed:[{symbol:'SNDKUSDT',direction:'SHORT',leverage:10,openedAt:now-7200000,closedAt:now-3600000,netUSD:12,netSource:'EXCHANGE'}],
  manualClosed:[
   {id:'m1',symbol:'NCSKSNDK2USDUSDT',direction:'LONG',leverage:5,openedAt:now-5400000,closedAt:now-1800000,netUSD:8,netSource:'EXCHANGE'},
   {id:'m2',symbol:'NCSKANTHROPIC2USDUSDT',direction:'LONG',leverage:5,openedAt:now-5000000,closedAt:now-900000,netUSD:-3,netSource:'EXCHANGE'},
  ],
  now,
 });
 const html=copyHTML({
  mode:'LIVE',enabled:true,armed:true,sizing:'BALANCE_RATIO',traderBalanceUSD:20000,maxTotalMarginPct:90,ledgerLossPct:50,
  funds:{equity:3000,available:2500,at:now},
  positions:[],
  venuePositions:vp,venuePositionsAt:now,
  closed:[{symbol:'SNDKUSDT',direction:'SHORT',adds:0,openedAt:now-7200000,closedAt:now-3600000,netUSD:12,netSource:'EXCHANGE'}],
  manual:{closed:[{id:'m2',symbol:'NCSKANTHROPIC2USDUSDT',direction:'LONG',adds:0,openedAt:now-5000000,closedAt:now-900000,netUSD:-3,netSource:'EXCHANGE'}]},
  events:[{type:'SKIPPED',at:now-60000,symbol:'NCSKSNDK2USDUSDT',direction:'LONG',reason:'SYMBOL_BLOCKED'}],
  controls:{filterMode:'BLOCKLIST',blockedSymbols:['NCSKANTHROPIC2USDUSDT'],allowedSymbols:[]},
  analytics,
 });
 assert.match(html,/<b title="NCSKANTHROPIC2USDUSDT">ANTHROPICUSDT<\/b>/);
 assert.match(html,/<b title="NCSKSNDK2USDUSDT">SNDKUSDT<\/b>/);
 assert.match(html,/class="ctrl-chip">ANTHROPICUSDT<button/);
 assert.match(analyticsHTML(analytics),/<b>SNDKUSDT<\/b>/);
 assert.match(analyticsHTML(analytics),/<b>ANTHROPICUSDT<\/b>/);
 setFailOpen(false);
 setAnalyticsOpen(false);
});

test('Telegram messages, status replies, and /close command format and normalize TradFi symbols',async()=>{
 const openMsg=realTradeMessage({
  type:'MANUAL_OPEN',fromFills:true,alertOrigin:'MANUAL',symbol:'NCSKANTHROPIC2USDUSDT',direction:'LONG',leverage:5,size:1,fillPrice:100,at:Date.UTC(2026,10,20,6,0,0),
 });
 assert.ok(openMsg?.text.includes('ANTHROPICUSDT'));
 assert.ok(!openMsg?.text.includes('NCSKANTHROPIC2USDUSDT'));

 const closeMsg=realTradeMessage({
  type:'MANUAL_SETTLED',fromFills:true,alertOrigin:'MANUAL',symbol:'NCSKSNDK2USDUSDT',direction:'SHORT',leverage:10,size:2,netUSD:15.5,netSource:'EXCHANGE_FILLS',at:Date.UTC(2026,10,20,6,5,0),
 });
 assert.ok(closeMsg?.text.includes('SNDKUSDT'));
 assert.ok(!closeMsg?.text.includes('NCSKSNDK2USDUSDT'));

 const copyOpenMsg=realTradeMessage({
  type:'MANUAL_OPEN',fromFills:true,alertOrigin:'COPY',symbol:'NCSKSNDK2USDUSDT',direction:'SHORT',leverage:10,size:2,fillPrice:50,at:Date.UTC(2026,10,20,6,5,0),
 });
 assert.ok(copyOpenMsg?.text.includes('SNDKUSDT'));
 assert.ok(!copyOpenMsg?.text.includes('NCSKSNDK2USDUSDT'));

 const copyTxt=copyEventText({mode:'LIVE',type:'OPENED',symbol:'NCSKSNDK2USDUSDT',direction:'LONG',leverage:5,qty:1,avg:100});
 assert.ok(copyTxt.includes('SNDKUSDT'));
 assert.ok(!copyTxt.includes('NCSKSNDK2USDUSDT'));

 const status=formatStatusReply({
  equityUSD:3000,availableUSD:2800,
  positions:[{origin:'manual',symbol:'NCSKANTHROPIC2USDUSDT',direction:'LONG',leverage:5,unrealized:12.5,roePct:25}],
  copy:{enabled:true,armed:true,traderBalanceUSD:20000},
 });
 assert.ok(status.includes('ANTHROPICUSDT'));
 assert.ok(!status.includes('NCSKANTHROPIC2USDUSDT'));

 const closed=[];
 const alerts=new AccountAlerts({
  allowedChatId:'123456',
  post:async()=>({ok:true,status:200,headers:{get:()=>null},json:async()=>({ok:true,result:{}})}),
  onClose:async req=>{closed.push(req);return {ok:true,summary:`${req.symbol} 청산`}},
 });
 for(const input of ['/close NCSKANTHROPIC2USDUSDT LONG','/close NCSKANTHROPIC2USD LONG','/close ANTHROPIC LONG']){
  const prompt=await alerts.handleCommand(input,'123456',1000);
  assert.match(prompt,/대상: ANTHROPICUSDT 🟢 롱/);
  const code=prompt.match(/\/confirm (\d{4})/)[1];
  await alerts.handleCommand(`/confirm ${code}`,'123456',2000);
 }
 assert.deepEqual(closed.map(x=>x.symbol),['ANTHROPICUSDT','ANTHROPICUSDT','ANTHROPICUSDT']);
});

test('buildCopyAnalytics merges raw TradFi manual trades with clean copy trades, and normalizeControlSymbol normalizes TradFi inputs',()=>{
 const now=Date.UTC(2026,10,20,6,0,0);
 const an=buildCopyAnalytics({
  copyClosed:[{symbol:'SNDKUSDT',direction:'SHORT',leverage:10,openedAt:now-7200000,closedAt:now-3600000,netUSD:12,netSource:'EXCHANGE'}],
  manualClosed:[{symbol:'NCSKSNDK2USDUSDT',direction:'LONG',leverage:5,openedAt:now-5400000,closedAt:now-1800000,netUSD:8,netSource:'EXCHANGE'}],
  now,
 });
 assert.equal(an.bySymbol.length,1);
 assert.equal(an.bySymbol[0].symbol,'SNDKUSDT');
 assert.equal(an.bySymbol[0].trades,2);
 assert.equal(an.bySymbol[0].netUSD,20);

 for(const input of ['NCSKSNDK2USDUSDT','NCSKSNDK2USD-USDT','NCSKSNDK2USD','SNDK','sndkusdt']){
  assert.equal(normalizeControlSymbol(input),'SNDKUSDT');
 }
 assert.equal(normalizeControlSymbol('NCSKANTHROPIC2USD-USDT'),'ANTHROPICUSDT');
 assert.equal(normalizeControlSymbol('NCCOGOLD2USDUSDT'),'GOLDUSDT');
});
