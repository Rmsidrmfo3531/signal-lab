import test from 'node:test';
import assert from 'node:assert/strict';
import {officialMarketLinks,telegramMessage} from '../links.mjs';

const valid={
 symbol:'SOLUSDT',direction:'LONG',pattern:'리테스트',score:95,scoreVersion:'ISSUE6-100-V1',
 status:'signal',qualified:true,entry:100,stop:98,patternConfirmedAt:1762400000000,
 risk:{leverage:3},targetPlan:{ok:true,targets:[106,110,115],
 quantity:1.25,quantityUnit:'BASE_ASSET'}
};
const paperPosition={market:'CRYPTO',symbol:valid.symbol,direction:valid.direction,pattern:valid.pattern,
 barAt:valid.patternConfirmedAt,openedAt:valid.patternConfirmedAt+1000,entryFill:100,
 leverage:3,originalQty:1.25,qtyRemaining:1.25,targetPlan:{quantityUnit:'BASE_ASSET'}};

test('official links only expose validated Binance futures symbols',()=>{
 assert.deepEqual(officialMarketLinks('BTCUSDT'),{binance:'https://www.binance.com/en/futures/BTCUSDT'});
 assert.deepEqual(officialMarketLinks('LINKUSDT'),{binance:'https://www.binance.com/en/futures/LINKUSDT'});
 for(const symbol of ['BTC/USDT','https://evil.test','BTCUSDC','../BTCUSDT','btcUSDT','USDT'])
  assert.equal(officialMarketLinks(symbol),null);
});

test('final Telegram alert contains only four requested concise fields',()=>{
 const message=telegramMessage(valid,officialMarketLinks('SOLUSDT'),{paperPosition});
 assert.deepEqual(message.text.split('\n'),[
  '종목: SOLUSDT','방향: 롱 (LONG)','배율: 3배 (모의 기준, 95점)','포지션 수량(모의): 1.25 SOL · 명목 $125.00 · 증거금 $41.67'
 ]);
 assert.equal(message.reply_markup,undefined,'do not include links or order buttons');
 assert.doesNotMatch(message.text,/패턴|RSI|EMA|TP1|거래 승인|http|손절|승률/);
 const short=telegramMessage({...valid,direction:'SHORT',entry:100,targetPlan:{...valid.targetPlan,targets:[95,90,85]}},
   officialMarketLinks('SOLUSDT'));
 assert.match(short.text,/방향: 숏 \(SHORT\)/);
});

test('leverage follows the score (90 -> 10x ... 100 -> 20x); quantity is the open position or the planned one, never invented',()=>{
 // No paper position yet: leverage from the score, quantity from the validated plan, marked as planned.
 const planned=telegramMessage(valid,officialMarketLinks('SOLUSDT'));
 assert.match(planned.text,/배율: 15배 \(모의 기준, 95점\)/);
 assert.match(planned.text,/포지션 수량\(모의\): 1\.25 SOL \(진입 예정\) · 명목 \$125\.00 · 증거금 \$8\.33/);
 assert.match(telegramMessage({...valid,score:90},officialMarketLinks('SOLUSDT')).text,/배율: 10배/);
 assert.match(telegramMessage({...valid,score:100},officialMarketLinks('SOLUSDT')).text,/배율: 20배/);
 // Without a plan quantity nothing is guessed (a final signal always has a score).
 const unknown=telegramMessage({...valid,targetPlan:{...valid.targetPlan,quantity:null}},officialMarketLinks('SOLUSDT'));
 assert.match(unknown.text,/포지션 수량\(모의\): 미확인/);assert.doesNotMatch(unknown.text,/명목|증거금/);
 // A paper position that does not match the signal is ignored: the plan is shown instead.
 for(const altered of [{...paperPosition,barAt:paperPosition.barAt-3600000},{...paperPosition,openedAt:null},
  {...paperPosition,qtyRemaining:0},{...paperPosition,direction:'SHORT'},
  {...paperPosition,targetPlan:{quantityUnit:'CONTRACT'}}]){
  const text=telegramMessage(valid,officialMarketLinks('SOLUSDT'),{paperPosition:altered}).text;
  assert.match(text,/배율: 15배/);assert.match(text,/1\.25 SOL \(진입 예정\)/);
 }
 const partial=telegramMessage(valid,officialMarketLinks('SOLUSDT'),{paperPosition:{...paperPosition,qtyRemaining:.75,leverage:undefined}});
 assert.match(partial.text,/배율: 15배/);assert.match(partial.text,/포지션 수량\(모의\): 0\.75 SOL · 명목 \$75\.00 · 증거금 \$5\.00/);
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
