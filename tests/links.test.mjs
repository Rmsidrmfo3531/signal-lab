import test from 'node:test';
import assert from 'node:assert/strict';
import {officialMarketLinks,telegramMessage} from '../links.mjs';

const valid={
 symbol:'SOLUSDT',direction:'LONG',pattern:'리테스트',score:95,scoreVersion:'ISSUE6-100-V1',
 status:'signal',qualified:true,entry:100,stop:98,
 risk:{leverage:3},targetPlan:{ok:true,targets:[106,110,115],
 quantity:1.25,quantityUnit:'BASE_ASSET'}
};

test('official links only expose validated Binance futures symbols',()=>{
 assert.deepEqual(officialMarketLinks('BTCUSDT'),{binance:'https://www.binance.com/en/futures/BTCUSDT'});
 assert.deepEqual(officialMarketLinks('LINKUSDT'),{binance:'https://www.binance.com/en/futures/LINKUSDT'});
 for(const symbol of ['BTC/USDT','https://evil.test','BTCUSDC','../BTCUSDT','btcUSDT','USDT'])
  assert.equal(officialMarketLinks(symbol),null);
});

test('final Telegram alert contains only four requested concise fields',()=>{
 const message=telegramMessage(valid,officialMarketLinks('SOLUSDT'));
 assert.deepEqual(message.text.split('\n'),[
  '종목: SOLUSDT','방향: 롱 (LONG)','배율: 3배 (모의 기준)','포지션 수량(모의): 1.25 SOL'
 ]);
 assert.equal(message.reply_markup,undefined,'do not include links or order buttons');
 assert.doesNotMatch(message.text,/점수|패턴|RSI|EMA|TP1|거래 승인|http|손절|승률/);
 const short=telegramMessage({...valid,direction:'SHORT',entry:100,targetPlan:{...valid.targetPlan,targets:[95,90,85]}},
   officialMarketLinks('SOLUSDT'));
 assert.match(short.text,/방향: 숏 \(SHORT\)/);
});

test('unconfigured leverage and position quantity are explicitly unknown, never invented',()=>{
 const noLeverage={...valid,risk:{nominal:500},targetPlan:{...valid.targetPlan,quantity:null}};
 const message=telegramMessage(noLeverage,officialMarketLinks('SOLUSDT'));
 assert.match(message.text,/배율: 미설정/);
 assert.match(message.text,/포지션 수량\(모의\): 미확인/);
 assert.doesNotMatch(message.text,/3배|500 SOL/);
});

test('final alert rejects observation, unverified scores, stale validation and invalid target plans',()=>{
 const url=officialMarketLinks('SOLUSDT');
 for(const altered of [
  {...valid,status:'watch'},
  {...valid,qualified:false},
  {...valid,score:85},
  {...valid,score:null},
  {...valid,scoreVersion:'LEGACY'},
  {...valid,targetPlan:undefined},
  {...valid,targetPlan:{ok:false,targets:[]}},
  {...valid,targetPlan:{ok:true,targets:[106,106,110]}},
  {...valid,targetPlan:{ok:true,targets:[99,106,110]}}
 ])assert.throws(()=>telegramMessage(altered,url),/validation/);
 assert.throws(()=>telegramMessage(valid,{binance:'https://invalid.example'}),/Verified Binance/);
});
