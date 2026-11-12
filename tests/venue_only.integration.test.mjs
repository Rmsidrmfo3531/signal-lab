import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {ENTRY} from './fixtures/pipeline_market.mjs';
import {sandbox,until} from './helpers/pipeline_sandbox.mjs';

test('a coin only on Gate.io/BingX is analyzed on the BingX chart and paper-traded; a Binance coin keeps the Binance chart',{timeout:30000},async()=>{
 const app=await sandbox({scenarios:{BTCUSDT:'range'},venueOnly:{AKEUSDT:'breakout-long',MIDUSDT:'range',DUSTUSDT:'breakout-long'},prices:{BTCUSDT:100,AKEUSDT:ENTRY,MIDUSDT:100,DUSTUSDT:ENTRY},marketCaps:{AKEUSDT:40e6,MIDUSDT:25e6,DUSTUSDT:15e6},venueOnlyReference:'AKEUSDT',signalPatterns:'ALL',
  env:{TELEGRAM_BOT_TOKEN:'synthetic-bot-token',TELEGRAM_CHAT_ID:'1',PAPER_TELEGRAM:'true'}});
 try{
  await app.start();
  const status=await until(()=>app.get('/api/status'),s=>s.venueOnly?.count===2,{label:'venue-only list'});
  // Floor = half the reference market cap (AKE 40M$ -> 20M$): MID (25M$) is in, DUST (15M$) is out.
  assert.deepEqual([...status.venueOnly.symbols].sort(),['AKEUSDT','MIDUSDT']);assert.equal(status.venueOnly.marketCapSource,'REFERENCE');assert.equal(status.venueOnly.minMarketCap,20e6);
  assert.deepEqual(status.venueOnly.droppedByMarketCap,{MCAP_TOO_SMALL:1});
  const paper=await until(()=>app.get('/api/paper'),p=>p.openCount+p.pendingCount>=1,{timeout:20000,label:'venue-only paper entry '+app.logs().slice(-1500)});
  const rec=[...paper.open,...paper.pending].find(x=>x.symbol==='AKEUSDT');assert.ok(rec,'AKEUSDT entry');assert.equal(rec.direction,'LONG');
  const analyzed=(await app.get('/api/results')).signals.find(x=>x.symbol==='AKEUSDT');
  assert.equal(analyzed?.analysisVenue,'BINGX','chart from BingX (the traded venue) first');assert.equal(analyzed?.venueOnly,true);
  assert.equal(analyzed.marketCap,40e6,'market cap attached for the leverage rule');
  const {leverageForScore}=await import('../paper.mjs');assert.equal(rec.leverage,leverageForScore(analyzed.score,40e6));assert.ok(rec.leverage>=10&&rec.leverage<=30);
  const btc=await app.get('/api/analyze?symbol=BTCUSDT');assert.equal(btc.analysisVenue,'BINANCE');
  const requests=(await fs.readFile(app.requests,'utf8')).trim().split('\n').map(JSON.parse);
  assert.ok(requests.some(r=>r.path==='/openApi/swap/v3/quote/klines'&&r.interval==='1h'),'BingX 1h candles read');
  // The paper entry also reaches Telegram, labelled as simulation, with the chart source.
  const read=async()=>(await fs.readFile(app.requests,'utf8')).trim().split('\n').map(JSON.parse).filter(r=>r.host==='api.telegram.org');
  const sent=await until(read,list=>list.some(r=>/\[모의 진입\] AKEUSDT 롱/.test(r.text||'')),{timeout:20000,label:'paper telegram'});
  const msg=sent.find(r=>/\[모의 진입\] AKEUSDT/.test(r.text)).text;assert.match(msg,/차트 BingX/);assert.match(msg,/실제 주문 없음/);
  assert.ok(!sent.some(r=>JSON.stringify(r).includes('synthetic-bot-token')),'token never logged');
 }finally{await app.close()}
});
