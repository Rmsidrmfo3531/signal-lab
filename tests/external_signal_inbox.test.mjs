import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
 ExternalSignalInbox,
 parseExternalSignalText,
 verifyWebhookSecret,
 formatExternalSignalNotice,
 formatExternalSignalTelegram,
} from '../external_signal_inbox.mjs';
import {
 buildPrefillDetail,
 renderExternalSignalBarHTML,
 renderExternalSignalPreviewHTML,
 renderExternalSignalListHTML,
} from '../public/external_signal_ui.js';

test('parses Korean futures signal with bracket source, limit entry, SL, TP, leverage, margin mode, and R:R',()=>{
 const p=parseExternalSignalText('[깡이스터디] BTCUSDT 롱 진입 95,200 손절 94,300 익절 97,500 10배 교차');
 assert.equal(p.valid,true);
 assert.equal(p.source,'깡이스터디');
 assert.equal(p.symbol,'BTCUSDT');
 assert.equal(p.side,'LONG');
 assert.equal(p.orderType,'LIMIT');
 assert.equal(p.entryPrice,95200);
 assert.equal(p.slPrice,94300);
 assert.equal(p.tpPrice,97500);
 assert.deepEqual(p.tpTargets,[97500]);
 assert.equal(p.leverage,10);
 assert.equal(p.marginMode,'CROSSED');
 assert.equal(p.riskReward,2.56);
 assert.equal(p.warnings.length,0);
});

test('parses Korean coin alias, entry range, multiple TPs, and isolated leverage',()=>{
 const p=parseExternalSignalText('솔라나 매수 205~208 SL 198 TP1 218 TP2 225 5x 격리');
 assert.equal(p.valid,true);
 assert.equal(p.symbol,'SOLUSDT');
 assert.equal(p.side,'LONG');
 assert.equal(p.orderType,'LIMIT');
 assert.equal(p.entryPrice,206.5);
 assert.deepEqual(p.entryRange,[205,208]);
 assert.equal(p.slPrice,198);
 assert.deepEqual(p.tpTargets,[218,225]);
 assert.equal(p.tpPrice,218);
 assert.equal(p.leverage,5);
 assert.equal(p.marginMode,'ISOLATED');
});

test('parses hashtag ticker and explicit market order',()=>{
 const p=parseExternalSignalText('[식스봇] #ETH 롱 시장가 손절 3100');
 assert.equal(p.valid,true);
 assert.equal(p.source,'식스봇');
 assert.equal(p.symbol,'ETHUSDT');
 assert.equal(p.side,'LONG');
 assert.equal(p.orderType,'MARKET');
 assert.equal(p.entryPrice,null);
 assert.equal(p.slPrice,3100);
});

test('flags sanity warnings for wrong-side SL/TP, high leverage, and missing SL',()=>{
 const bad=parseExternalSignalText('BTCUSDT 숏 진입 95000 손절 94000 익절 96000 50배');
 assert.equal(bad.valid,true);
 assert.equal(bad.side,'SHORT');
 assert.ok(bad.warnings.some(w=>w.includes('손절가(SL)')));
 assert.ok(bad.warnings.some(w=>w.includes('익절가(TP)')));
 assert.ok(bad.warnings.some(w=>w.includes('고배율(50x)')));

 const noSl=parseExternalSignalText('비트코인 롱 시장가');
 assert.equal(noSl.valid,true);
 assert.equal(noSl.symbol,'BTCUSDT');
 assert.ok(noSl.warnings.some(w=>w.includes('손절가(SL) 미포함')));
});

test('parses structured JSON webhook payload with optional embedded text',()=>{
 const p=parseExternalSignalText({
  source:'공식 웹훅',
  symbol:'XRP',
  side:'sell',
  entryPrice:2.45,
  slPrice:2.55,
  tpTargets:[2.25,2.1],
  leverage:12,
  marginMode:'isolated',
 });
 assert.equal(p.valid,true);
 assert.equal(p.symbol,'XRPUSDT');
 assert.equal(p.side,'SHORT');
 assert.equal(p.orderType,'LIMIT');
 assert.equal(p.entryPrice,2.45);
 assert.equal(p.slPrice,2.55);
 assert.deepEqual(p.tpTargets,[2.25,2.1]);
 assert.equal(p.leverage,12);
 assert.equal(p.marginMode,'ISOLATED');
});

test('rejects text missing symbol or direction with clear Korean error',()=>{
 const noSym=parseExternalSignalText('롱 진입 100');
 assert.equal(noSym.valid,false);
 assert.match(noSym.error,/종목/);

 const noSide=parseExternalSignalText('BTCUSDT 진입 95000');
 assert.equal(noSide.valid,false);
 assert.match(noSide.error,/방향/);
});

test('verifyWebhookSecret validates Bearer, X-Webhook-Secret, and query secret in constant time',()=>{
 const secret='super-secret-token-2026';
 assert.equal(verifyWebhookSecret({headers:{authorization:`Bearer ${secret}`}},new URL('http://localhost/api/external-signals/webhook'),secret),true);
 assert.equal(verifyWebhookSecret({headers:{'x-webhook-secret':secret}},new URL('http://localhost/api/external-signals/webhook'),secret),true);
 assert.equal(verifyWebhookSecret({headers:{}},new URL(`http://localhost/api/external-signals/webhook?secret=${secret}`),secret),true);
 assert.equal(verifyWebhookSecret({headers:{'x-webhook-secret':'wrong-token'}},new URL('http://localhost/api/external-signals/webhook'),secret),false);
 assert.equal(verifyWebhookSecret({headers:{'x-webhook-secret':secret}},new URL('http://localhost/api/external-signals/webhook'),''),false);
});

test('ExternalSignalInbox deduplicates within 60s, tracks status, persists to disk, and clears cleanly',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sig-ext-'));
 const filePath=path.join(dir,'external-signals.json');
 try{
  const inbox=new ExternalSignalInbox({filePath});
  const t0=1764000000000;
  const r1=inbox.ingest('BTCUSDT 롱 진입 95200 손절 94300 익절 97500 10배',{source:'공부방',now:t0});
  assert.equal(r1.ok,true);
  assert.equal(r1.duplicate,false);
  assert.equal(r1.item.status,'NEW');

  // Same signal within 60s -> duplicate
  const r2=inbox.ingest('BTCUSDT 롱 진입 95200 손절 94300 익절 97500 10배',{source:'공부방',now:t0+10_000});
  assert.equal(r2.ok,true);
  assert.equal(r2.duplicate,true);
  assert.equal(r2.item.id,r1.item.id);

  // Status update -> LOADED
  const loaded=inbox.setStatus(r1.item.id,'LOADED');
  assert.equal(loaded.status,'LOADED');
  assert.equal(inbox.snapshot({webhookConfigured:true}).unreadCount,0);
  assert.equal(inbox.snapshot({webhookConfigured:true}).webhookConfigured,true);

  // Reload from disk
  const reloaded=new ExternalSignalInbox({filePath});
  assert.equal(reloaded.items.length,1);
  assert.equal(reloaded.items[0].id,r1.item.id);
  assert.equal(reloaded.items[0].status,'LOADED');

  // Clear
  reloaded.clear();
  assert.equal(reloaded.items.length,0);
 }finally{
  fs.rmSync(dir,{recursive:true,force:true});
 }
});

test('alert formatters emphasize manual review and zero auto-orders',()=>{
 const parsed=parseExternalSignalText('[깡이스터디] BTCUSDT 롱 진입 95200 손절 94300 익절 97500 10배 교차');
 const item={...parsed,id:'sig-1',receivedAt:1764000000000,status:'NEW',channel:'webhook'};
 const notice=formatExternalSignalNotice(item);
 assert.match(notice,/BTCUSDT/);
 assert.match(notice,/롱/);
 assert.match(notice,/SL 94300/);

 const tg=formatExternalSignalTelegram(item);
 assert.match(tg,/자동 주문 없음/);
 assert.match(tg,/깡이스터디/);
 assert.match(tg,/1 : 2\.56/);
});

test('frontend renderer builds manual prefill payload and escapes XSS safely',()=>{
 const parsed=parseExternalSignalText('[<script>alert(1)</script>] ETHUSDT 숏 진입 3200 손절 3300 익절 3000 5배');
 const item={...parsed,id:'id-1',receivedAt:1764000000000,status:'NEW',channel:'manual'};
 const detail=buildPrefillDetail(item);
 assert.equal(detail.symbol,'ETHUSDT');
 assert.equal(detail.side,'SHORT');
 assert.equal(detail.orderType,'LIMIT');
 assert.equal(detail.limitPrice,3200);
 assert.equal(detail.slPrice,3300);
 assert.equal(detail.tpPrice,3000);
 assert.equal(detail.leverage,5);

 const previewHtml=renderExternalSignalPreviewHTML(parsed);
 assert.ok(previewHtml.includes('ETHUSDT'));
 assert.ok(!previewHtml.includes('<script>'));

 const listHtml=renderExternalSignalListHTML([item]);
 assert.ok(listHtml.includes('&lt;script&gt;'));
 assert.ok(!listHtml.includes('<script>'));
 assert.ok(listHtml.includes('data-ext-prefill="id-1"'));

 const barHtml=renderExternalSignalBarHTML({
  ok:true,
  webhookConfigured:true,
  webhookPath:'/api/external-signals/webhook',
  unreadCount:1,
  totalCount:1,
  items:[item],
 },{parsed,webhookOrigin:'https://example.local'});
 assert.ok(barHtml.includes('외부 신호 대기 1건'));
 assert.ok(barHtml.includes('웹훅 활성'));
 assert.ok(barHtml.includes('EXTERNAL_SIGNAL_WEBHOOK_SECRET'));
 assert.ok(!barHtml.includes('<script>'));
});

test('static wiring across server, frontend, styles, and updater allowlist',()=>{
 const serverSrc=fs.readFileSync(new URL('../server.mjs',import.meta.url),'utf8');
 const appSrc=fs.readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
 const htmlSrc=fs.readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
 const cssSrc=fs.readFileSync(new URL('../public/styles.css',import.meta.url),'utf8');
 const updaterSrc=fs.readFileSync(new URL('../updater.mjs',import.meta.url),'utf8');

 assert.match(serverSrc,/from '\.\/external_signal_inbox\.mjs'/);
 assert.match(serverSrc,/\/api\/external-signals\/webhook/);
 assert.match(serverSrc,/\/api\/external-signals\/ingest/);
 assert.match(serverSrc,/\/api\/external-signals\/parse/);
 assert.match(serverSrc,/\/api\/external-signals\/status/);
 assert.match(serverSrc,/sendTradeTelegram\(formatExternalSignalTelegram\(item\)\)/);
 assert.match(appSrc,/addEventListener\('external-signal'/);
 assert.match(appSrc,/signal-lab:prefill-real-trade/);
 assert.match(htmlSrc,/id="externalSignalBar"/);
 assert.match(htmlSrc,/src="\/external_signal_ui\.js"/);
 assert.match(cssSrc,/\.ext-bar\{/);
 assert.match(updaterSrc,/'external_signal_inbox\.mjs'/);
});
