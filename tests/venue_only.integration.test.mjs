import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {ENTRY} from './fixtures/pipeline_market.mjs';
import {sandbox,until} from './helpers/pipeline_sandbox.mjs';

test('a coin only on Gate.io/BingX is analyzed on the Gate.io chart and paper-traded; a Binance coin keeps the Binance chart',{timeout:30000},async()=>{
 const app=await sandbox({scenarios:{BTCUSDT:'range'},venueOnly:{AKEUSDT:'breakout-long',DUSTUSDT:'breakout-long'},prices:{BTCUSDT:100,AKEUSDT:ENTRY,DUSTUSDT:ENTRY},marketCaps:{AKEUSDT:40e6,DUSTUSDT:3e6},venueOnlyReference:'AKEUSDT',signalPatterns:'ALL'});
 try{
  await app.start();
  const status=await until(()=>app.get('/api/status'),s=>s.venueOnly?.count===1,{label:'venue-only list'});
  assert.deepEqual(status.venueOnly.symbols,['AKEUSDT'],'DUSTUSDT (3M$ market cap) is screened out');assert.equal(status.venueOnly.thresholdSource,'REFERENCE');
  assert.deepEqual(status.venueOnly.droppedByMarketCap,{MCAP_TOO_SMALL:1});
  const paper=await until(()=>app.get('/api/paper'),p=>p.openCount+p.pendingCount>=1,{timeout:20000,label:'venue-only paper entry '+app.logs().slice(-1500)});
  const rec=[...paper.open,...paper.pending][0];assert.equal(rec.symbol,'AKEUSDT');assert.equal(rec.direction,'LONG');
  const analyzed=(await app.get('/api/results')).signals.find(x=>x.symbol==='AKEUSDT');
  assert.equal(analyzed?.analysisVenue,'GATEIO','chart from Gate.io');assert.equal(analyzed?.venueOnly,true);
  const btc=await app.get('/api/analyze?symbol=BTCUSDT');assert.equal(btc.analysisVenue,'BINANCE');
  const requests=(await fs.readFile(app.requests,'utf8')).trim().split('\n').map(JSON.parse);
  assert.ok(requests.some(r=>r.path==='/api/v4/futures/usdt/candlesticks'&&r.interval==='1h'),'Gate.io 1h candles read');
 }finally{await app.close()}
});
