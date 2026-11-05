import test from 'node:test';
import assert from 'node:assert/strict';
import {officialMarketLinks,telegramMessage} from '../links.mjs';
test('market destinations expose only validated Binance futures links',()=>{
 assert.deepEqual(officialMarketLinks('BTCUSDT'),{binance:'https://www.binance.com/en/futures/BTCUSDT'});
 assert.deepEqual(officialMarketLinks('LINKUSDT'),{binance:'https://www.binance.com/en/futures/LINKUSDT'});
});
test('refuse non-USDT markets, malicious paths and malformed symbols',()=>{
 for(const symbol of ['BTC/USDT','https://evil.test','BTCUSDC','../BTCUSDT','btcUSDT','USDT'])assert.equal(officialMarketLinks(symbol),null);
});
test('Telegram final message has exactly one official destination and retains risk disclosure',()=>{
 const links=officialMarketLinks('ETHUSDT'),payload=telegramMessage({symbol:'ETHUSDT',direction:'SHORT',pattern:'돌파 후 리테스트',score:83,
  scannedAt:1792150000000,entry:2800,stop:2820,target1:2760,target2:2740,supports:[{price:2780}],resistances:[{price:2830}],volumeRatio:2.1},links,x=>String(x));
 assert.match(payload.text,/청산가/);assert.equal(payload.reply_markup.inline_keyboard.length,1);
 assert.equal(payload.reply_markup.inline_keyboard[0][0].url,links.binance);
});
test('modern final notifications reject unavailable profile targets instead of labelling them final',()=>{
 const signal={symbol:'SOLUSDT',direction:'LONG',pattern:'리테스트',score:95,scoreVersion:'ISSUE6-100-V1',status:'signal',qualified:true,
  patternConfirmedAt:1793750400000,entry:100,stop:98,targetPlan:{ok:true,targets:[106,110,115],estimatedNetRR:2.1}};
 const links=officialMarketLinks('SOLUSDT'),payload=telegramMessage(signal,links);
 assert.equal(payload.reply_markup.inline_keyboard.length,1);assert.match(payload.text,/최종 신호/);
 for(const targetPlan of [undefined,{ok:false,targets:[]},{ok:true,targets:[106,106,110]},{ok:true,targets:[99,106,110]}])
  assert.throws(()=>telegramMessage({...signal,targetPlan},links),/target validation/);
});

test('extra untrusted link destinations cannot appear in Telegram buttons',()=>{
 const links={...officialMarketLinks('ETHUSDT'),external:'https://forbidden.example/route'},
  payload=telegramMessage({symbol:'ETHUSDT',score:90,direction:'LONG',entry:100,stop:98,scannedAt:1792150000000},links);
 assert.equal(payload.reply_markup.inline_keyboard.length,1);
 assert.doesNotMatch(JSON.stringify(payload),/forbidden\.example/);
});
