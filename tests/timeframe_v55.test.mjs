import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {entryTiming} from '../public/trade_plan.js';
import {describeScanFunnel} from '../scan_diagnostics.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');

test('entry timing can be evaluated with only a 1H completed pattern, 4H trend and approved venue',()=>{
 const now=Date.now();
 const s={direction:'LONG',entry:100,stop:98,pattern:'박스권 상단 돌파',patternConfirmed:true,patternConfirmedAt:now-25000,
   time:now-3600000,atr:1.6,qualified:true,execution:{eligible:true},patternTimeframe:'1h',confirmedTimeframes:['1h','4h']};
 const t=entryTiming(s,{price:100,priceAt:now,now,venueReady:true});
 assert.equal(t.code,'zone');
 assert.equal(t.actionable,true);
 assert.match(t.confirmation,/4시간봉/);
 assert.doesNotMatch(t.confirmation,/15분봉/);
});

test('strict funnel does not require removed subhour confirmation field',()=>{
 const now=Date.now(),symbol='BTCUSDT';
 const row={symbol,scannedAt:now,pattern:'돌파',patternConfirmed:true,quality:{passed:true,failed:[]},execution:{eligible:true},status:'signal',qualified:true};
 const f=describeScanFunnel(new Map([[symbol,row]]),{activeSymbols:[symbol],now});
 assert.equal(f.patternCount,1);assert.equal(f.ready,1);
 assert.equal(Object.hasOwn(f,'confirmation15m'),false);
});

test('server contains no 15 minute scanner dependency',()=>{
 // The web chart (1h/4h/1d buttons, TradingView) was removed with the 대시보드 page (user 2026-11-17).
 const server=fs.readFileSync(path.join(root,'server.mjs'),'utf8'),ui=fs.readFileSync(path.join(root,'public/index.html'),'utf8');
 assert.doesNotMatch(server,/klines\(symbol,'15m'/);
 assert.doesNotMatch(server,/@kline_15m/);
 assert.doesNotMatch(server,/confirmed15m/);
 assert.doesNotMatch(ui,/data-time="15m"|value="15m"|15분봉 확인 보류/);
});
