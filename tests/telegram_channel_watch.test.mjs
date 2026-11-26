import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
 TelegramChannelWatcher,
 parseChannelHandles,
 parseTelegramWebPosts,
 stripChannelPromoLines,
 classifyTradingChannelPost,
 translateChineseTradeText,
 collapseBatchAlerts,
 formatChannelAlertNotice,
 formatChannelAlertTelegram,
 channelPostPrefill,
} from '../telegram_channel_watch.mjs';
import {renderChannelWatchHTML} from '../public/external_signal_ui.js';

const SAMPLE_OPEN=`【熬鹰币安实盘】

🟢 开仓 · NVDAUSDT 永续 · 做多
【开仓量】 1,039.72 NVDA
【本次开仓均价】 143.90 USDT
【开仓后持仓均价】 143.90 USDT
2026/11/26 01:08:05（北京时间）

NVDAUSDT · 多
【持仓量】 6,912.02 NVDA · 【持仓均价】 144.02 USDT
【浮动收益】 +1,617.88 USDT（0.32%）
【实际杠杆】 2x · 【强平价格】 73.21 USDT

✅点击欧易币安绑定永久8折
✅点击订阅其它大神开单通知群`;

const SAMPLE_SNAPSHOT=`【熬鹰币安实盘】

熬鹰当前全部持仓
【持仓数量】 1

NVDAUSDT 永续 · 做多 · 全仓
【持仓量】 6,912.02 NVDA · 【持仓均价】 144.02 USDT
【标记价格】 151.78 USDT
【浮动收益】 +53,647.94 USDT（10.22%）
【实际杠杆】 2x · 【强平价格】 73.16 USDT

【账户保证金】 545,083.87 USDT
【持仓快照】 2026/11/26 09:48:35（北京时间）

✅点击欧易币安绑定永久8折`;

const SAMPLE_CLOSE=`【熬鹰币安实盘】

🔴 平仓 · SKHYNIXUSDT 永续 · 平空
【平仓量】 202.05 SKHYNIX · 已全部平仓
【平仓前持仓均价】 873.50 USDT
【本次已实现盈亏】 待成交记录确认
当前无持仓`;

const SAMPLE_AD=`熬鹰会员群发言实时转发我已做好
如需要进群的，请联系我 @btcbajie
只要两大平台的其中一个 欧易 和 币安 邀请码用我的 UU9876
私聊我币安或欧易uid即可，我拉你进群 @btcbajie`;

const SAMPLE_EMPTY_SNAP=`【熬鹰币安实盘】

熬鹰当前全部持仓
【持仓数量】 0
当前无持仓
【账户保证金】 500.00 USDT`;

test('parseChannelHandles defaults to aoying999, parses URLs, and supports off',()=>{
 assert.deepEqual(parseChannelHandles(undefined),['aoying999']);
 assert.deepEqual(parseChannelHandles('https://t.me/aoying999/143, @Sample_Room'),['aoying999','sample_room']);
 assert.deepEqual(parseChannelHandles('off'),[]);
});

test('classifyTradingChannelPost accepts trade events and non-empty snapshots while filtering ads and empty 0-position snapshots',()=>{
 const open=classifyTradingChannelPost(SAMPLE_OPEN);
 assert.equal(open.isTrading,true);
 assert.equal(open.action,'OPEN');
 assert.equal(open.symbol,'NVDAUSDT');
 assert.equal(open.side,'LONG');
 assert.equal(open.entryPrice,143.9);
 assert.equal(open.liqPrice,73.21);
 assert.equal(open.leverage,2);

 const snap=classifyTradingChannelPost(SAMPLE_SNAPSHOT);
 assert.equal(snap.isTrading,true);
 assert.equal(snap.action,'SNAPSHOT');
 assert.equal(snap.symbol,'NVDAUSDT');
 assert.equal(snap.side,'LONG');
 assert.equal(snap.markPrice,151.78);
 assert.equal(snap.marginMode,'CROSSED');

 const close=classifyTradingChannelPost(SAMPLE_CLOSE);
 assert.equal(close.isTrading,true);
 assert.equal(close.action,'CLOSE');
 assert.equal(close.symbol,'SKHYNIXUSDT');
 assert.equal(close.side,'SHORT');

 assert.equal(classifyTradingChannelPost(SAMPLE_AD).isTrading,false);
 assert.equal(classifyTradingChannelPost(SAMPLE_AD).reason,'PROMO_AD');

 assert.equal(classifyTradingChannelPost(SAMPLE_EMPTY_SNAP).isTrading,false);
 assert.equal(classifyTradingChannelPost(SAMPLE_EMPTY_SNAP).reason,'EMPTY_SNAPSHOT');
});

test('translateChineseTradeText strips promo footers, translates structured terms cleanly, and falls back to MT for free-form Chinese',async()=>{
 const ko=await translateChineseTradeText(SAMPLE_OPEN);
 assert.ok(ko.includes('[아오잉(熬鹰) 바이낸스 실계좌]'));
 assert.ok(ko.includes('신규 진입'));
 assert.ok(ko.includes('롱(매수)'));
 assert.ok(ko.includes('[청산가] 73.21 USDT'));
 assert.ok(!ko.includes('点击欧易'));
 assert.ok(!ko.includes('订阅其它大神'));

 let mtCalled=false;
 const freeKo=await translateChineseTradeText('BTCUSDT 做多 目标看十万美元 稳健分批建仓',{
  translate:async()=>{mtCalled=true;return 'BTCUSDT 롱 목표 10만 달러 분할 진입'},
 });
 assert.equal(mtCalled,true);
 assert.match(freeKo,/목표 10만 달러/);
 assert.equal(stripChannelPromoLines('hello\n✅点击欧易币安绑定永久8折'),'hello');
});

test('collapseBatchAlerts merges consecutive ADD slices for the same symbol while keeping OPEN separate',()=>{
 const batch=[
  {channel:'aoying999',postNum:136,action:'OPEN',symbol:'NVDAUSDT',side:'LONG'},
  {channel:'aoying999',postNum:137,action:'ADD',symbol:'NVDAUSDT',side:'LONG'},
  {channel:'aoying999',postNum:138,action:'ADD',symbol:'NVDAUSDT',side:'LONG'},
  {channel:'aoying999',postNum:139,action:'ADD',symbol:'NVDAUSDT',side:'LONG'},
 ];
 const out=collapseBatchAlerts(batch);
 assert.equal(out.length,2);
 assert.equal(out[0].action,'OPEN');
 assert.equal(out[0].mergedCount,1);
 assert.equal(out[1].action,'ADD');
 assert.equal(out[1].postNum,139);
 assert.equal(out[1].mergedCount,3);
});

function buildFakeTelegramHtml(posts){
 const blocks=posts.map(p=>`
  <div class="tgme_widget_message_wrap js-widget_message_wrap">
   <div class="tgme_widget_message" data-post="aoying999/${p.num}">
    <div class="tgme_widget_message_text js-message_text">${p.text.replace(/\n/g,'<br/>')}</div>
    <time datetime="${p.dt||'2026-11-26T01:49:59+00:00'}"></time>
   </div>
  </div>`).join('');
 return `<html><head><meta property="og:title" content="熬鹰-实盘24小时监控"></head><body>${blocks}</body></html>`;
}

test('parseTelegramWebPosts and TelegramChannelWatcher bootstrap cleanly and alert only new trading posts',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'tg-watch-'));
 const filePath=path.join(dir,'watch.json');
 try{
  let pagePosts=[
   {num:134,text:SAMPLE_EMPTY_SNAP},
   {num:135,text:SAMPLE_AD},
   {num:143,text:SAMPLE_SNAPSHOT},
  ];
  const fetcher=async()=>({ok:true,status:200,text:async()=>buildFakeTelegramHtml(pagePosts)});
  const parsed=parseTelegramWebPosts(buildFakeTelegramHtml(pagePosts),'aoying999');
  assert.equal(parsed.length,3);
  assert.equal(parsed[2].postNum,143);

  const watcher=new TelegramChannelWatcher({channels:['aoying999'],filePath,fetcher});
  const boot=await watcher.poll({force:true});
  assert.equal(boot.bootstrapped,true);
  assert.equal(boot.newAlerts.length,0);
  assert.equal(boot.snapshot.posts.length,1); // Only #143 seeded; #134 & #135 filtered!
  assert.equal(boot.snapshot.channels[0].lastPostNum,143);
  assert.equal(boot.snapshot.channels[0].filteredCount,2);

  // New posts arrive: #144 is an ad, #145 is a new OPEN trade
  pagePosts=[...pagePosts,{num:144,text:SAMPLE_AD},{num:145,text:SAMPLE_OPEN}];
  const next=await watcher.poll({force:true});
  assert.equal(next.bootstrapped,false);
  assert.equal(next.newAlerts.length,1);
  assert.equal(next.newAlerts[0].postNum,145);
  assert.equal(next.newAlerts[0].symbol,'NVDAUSDT');
  assert.equal(next.newAlerts[0].side,'LONG');
  assert.ok(next.newAlerts[0].translatedText.includes('신규 진입'));

  // Alert formatters & prefill
  const notice=formatChannelAlertNotice(next.newAlerts[0]);
  assert.match(notice,/aoying999/);
  assert.match(notice,/NVDAUSDT/);
  const tg=formatChannelAlertTelegram(next.newAlerts[0]);
  assert.match(tg,/자동 주문 없음/);
  assert.match(tg,/https:\/\/t\.me\/aoying999\/145/);
  const pf=channelPostPrefill(next.newAlerts[0]);
  assert.equal(pf.symbol,'NVDAUSDT');
  assert.equal(pf.side,'LONG');
  assert.equal(pf.leverage,2);
  assert.equal(channelPostPrefill({symbol:'SKHYNIXUSDT',side:'SHORT',action:'CLOSE'}),null);

  // UI renderer & XSS safety
  const html=renderChannelWatchHTML({
   ...next.snapshot,
   posts:[{...next.newAlerts[0],translatedText:'<script>alert(1)</script> 테스트 번역'}],
  });
  assert.ok(html.includes('@aoying999'));
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(!html.includes('<script>'));
  assert.ok(html.includes('data-ext-ch-prefill="aoying999/145"'));
 }finally{
  fs.rmSync(dir,{recursive:true,force:true});
 }
});

test('static wiring across server.mjs, updater.mjs, external_signal_ui.js, and styles.css',()=>{
 const serverSrc=fs.readFileSync(new URL('../server.mjs',import.meta.url),'utf8');
 const updaterSrc=fs.readFileSync(new URL('../updater.mjs',import.meta.url),'utf8');
 const uiSrc=fs.readFileSync(new URL('../public/external_signal_ui.js',import.meta.url),'utf8');
 const cssSrc=fs.readFileSync(new URL('../public/styles.css',import.meta.url),'utf8');

 assert.match(serverSrc,/from '\.\/telegram_channel_watch\.mjs'/);
 assert.match(serverSrc,/\/api\/external-signals\/channels\/refresh/);
 assert.match(serverSrc,/sendTradeTelegram\(formatChannelAlertTelegram\(post\)\)/);
 assert.match(updaterSrc,/'telegram_channel_watch\.mjs'/);
 assert.match(uiSrc,/renderChannelWatchHTML/);
 assert.match(cssSrc,/\.ext-channel-wrap\{/);
});
