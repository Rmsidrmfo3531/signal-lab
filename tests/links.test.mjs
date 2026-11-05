import test from 'node:test';
import assert from 'node:assert/strict';
import {officialMarketLinks,telegramMessage} from '../links.mjs';

test('validated Binance and Variational deep links for same PERP',()=>{
 assert.deepEqual(officialMarketLinks('BTCUSDT','BTC-PERP'),{
  binance:'https://www.binance.com/en/futures/BTCUSDT',variational:'https://omni.variational.io/perpetual/BTC'
 });
 assert.deepEqual(officialMarketLinks('LINKUSDT','LINK-PERP'),{
  binance:'https://www.binance.com/en/futures/LINKUSDT',variational:'https://omni.variational.io/perpetual/LINK'
 });
});
test('refuse unmatched markets, aliases, SWAP, and malicious paths',()=>{
 for(const [b,v] of [['1000PEPEUSDT','PEPE-PERP'],['BTCUSDT','BTC-SWAP'],['BTCUSDT','ETH-PERP'],['BTC/USDT','BTC-PERP'],['https://evil.test','BTC-PERP'],['BTCUSDC','BTC-PERP']]) {
  assert.equal(officialMarketLinks(b,v),null);
 }
});
test('Telegram message contains inline deep-link buttons and risk disclosure',()=>{
 const links=officialMarketLinks('ETHUSDT','ETH-PERP');
 const payload=telegramMessage({symbol:'ETHUSDT',direction:'SHORT',pattern:'돌파 후 리테스트',score:83,scannedAt:1792150000000,entry:2800,stop:2820,target1:2760,target2:2740,supports:[{price:2780}],resistances:[{price:2830}],volumeRatio:2.1},links,x=>String(x));
 assert.match(payload.text,/청산가/);
 assert.equal(payload.reply_markup.inline_keyboard[0][0].url,links.variational);
 assert.equal(payload.reply_markup.inline_keyboard[1][0].url,links.binance);
});
test('modern final notifications reject unavailable profile targets instead of labelling them final',()=>{
 const signal={symbol:'SOLUSDT',direction:'LONG',pattern:'리테스트',score:95,scoreVersion:'ISSUE6-100-V1',status:'signal',qualified:true,
  patternConfirmedAt:1793750400000,entry:100,stop:98,targetPlan:{ok:true,targets:[106,110,115],estimatedNetRR:2.1}};
 const links=officialMarketLinks('SOLUSDT');
 const payload=telegramMessage(signal,links);assert.equal(payload.reply_markup.inline_keyboard.length,1);assert.match(payload.text,/최종 신호/);
 for(const targetPlan of [undefined,{ok:false,targets:[]},{ok:true,targets:[106,106,110]},{ok:true,targets:[99,106,110]}])
  assert.throws(()=>telegramMessage({...signal,targetPlan},links),/target validation/);
});
