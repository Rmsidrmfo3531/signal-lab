import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {latestDirectionPattern} from '../public/directional_entries.js';
const NOW=1792581000000;
const row=(direction='LONG',symbol='ARBUSDT',extras={})=>({
 symbol,direction,pattern:'확정 1H',patternConfirmed:true,patternInvalidated:false,
 entry:100,stop:direction==='LONG'?98:102,target1:direction==='LONG'?104:96,
 patternConfirmedAt:NOW-300000,scannedAt:NOW-10000,...extras
});
test('independent LONG and SHORT reference prices use only observed confirmed setups',()=>{
 const inputs=[row('LONG','BTCUSDT'),row('SHORT','ETHUSDT',{entry:200,stop:204,target1:192})];
 assert.equal(latestDirectionPattern(inputs,'LONG',{now:NOW}).symbol,'BTCUSDT');
 assert.equal(latestDirectionPattern(inputs,'SHORT',{now:NOW}).symbol,'ETHUSDT');
 assert.equal(latestDirectionPattern(inputs,'LONG',{now:NOW,symbol:'ETHUSDT'}),null);
});
test('never invent opposite direction, historic entries, stale patterns or unconfirmed observations',()=>{
 for(const extra of [{patternConfirmed:false},{patternConfirmedAt:NOW-3*3600000},{scannedAt:NOW-22*60000},
  {patternInvalidated:true},{entry:0},{stop:101},{target1:99},{scannedAt:NOW+60000}]){
  assert.equal(latestDirectionPattern([row('LONG','BTCUSDT',extra)],'LONG',{now:NOW}),null,JSON.stringify(extra));
 }
 assert.equal(latestDirectionPattern([row('LONG','BTCUSDT')],'SHORT',{now:NOW}),null);
});
test('the latest confirmed pattern wins and row data is not mutated',()=>{
 const old=row('LONG','BTCUSDT',{patternConfirmedAt:NOW-90*60000,scannedAt:NOW-1000});
 const newest=row('LONG','SOLUSDT',{patternConfirmedAt:NOW-2*60000,scannedAt:NOW-1000});
 const rows=[old,newest],before=structuredClone(rows);
 assert.equal(latestDirectionPattern(rows,'LONG',{now:NOW}),newest);
 assert.deepEqual(rows,before);
});
test('PC/mobile dashboard has separate LONG SHORT cards and an explicit entry price column',()=>{
 const html=fs.readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
 const app=fs.readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
 assert.match(html,/id="directionEntryBoard"/);
 assert.match(html,/id="pairDirectionEntries"/);
 assert.match(html,/롱\/숏 기준 진입가/);
 assert.match(app,/진입 보류/);
 assert.match(app,/차트 기준 진입가 \(실제 주문가 아님\)/);
 assert.doesNotMatch(app,/참고 관찰선/);
 assert.match(app,/function directionalEntryRows\(\)\{return currentReadySignals\(\)\}/);
});
