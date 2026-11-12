// Offline transport verification of production server functions. No Telegram
// connection, credentials, account API or user file is used by this harness.
import test from 'node:test';
import {nextSizeScale,planWithQuantity,leverageForScore} from '../paper.mjs';
import {planZoneDca} from '../dca_plan.mjs';
import {venueSizingInputs} from '../venue_execution.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {evaluateSignal} from '../signal_pipeline.mjs';
import {getSignalScorePolicy} from '../signal_policy.mjs';
import {officialMarketLinks,telegramMessage} from '../links.mjs';
import {finalTelegramMatch} from '../telegram_final.mjs';
import {signalKey} from '../paper.mjs';
import {syntheticFinalSignalContext} from './fixtures/binance_signal.mjs';

const source=fs.readFileSync(new URL('../server.mjs',import.meta.url),'utf8');
function section(start,end){const a=source.indexOf(start),b=source.indexOf(end,a);assert.ok(a>=0&&b>a);return source.slice(a,b)}
const code=[section('async function tgNotify(s){','let updateCheckPromise='),
 section('function publishCryptoSignal(','// Event-driven scanner.'),
 section('function assessAnalysis(','function watches()')].join('\n');
function harness(){
 const now=Date.now(),{row,context:marketContext}=syntheticFinalSignalContext(now);
 Object.assign(row,{scoreVersion:'ISSUE6-100-V1',risk:{leverage:20},executionVenue:'BINGX'});
 row.targetPlan.quantityUnit='BASE_ASSET';
 const deliveries=[],logs=[],events=[],observations=[],registrations=[];
 let transport='ok',formatFailure=false,saveFailure=false;
 class Clock extends Date{static now(){return now}}
 const sandbox={Date:Clock,AbortSignal,console:{log(){},warn:(...args)=>logs.push(args.join(' ')),error:(...args)=>logs.push(args.join(' '))},
  CONFIG:{tgToken:'offline-test-token',tgChat:'offline-test-chat',maxRiskUSD:6,limits:{},paperVenues:['BINGX']},
  // The execution venue view is derived from the same synthetic book, so a stale book stays stale.
  venueEntry:(_venue,symbol)=>{const book=sandbox.books.get(symbol),f=marketContext.market.filters;return {contract:{symbol,tradable:true,tickSize:f.PRICE_FILTER.tickSize,quantityStep:f.LOT_SIZE.stepSize,
   minQuantityBase:f.LOT_SIZE.minQty,minNotionalUSDT:Number(f.MIN_NOTIONAL?.notional??f.NOTIONAL?.minNotional),quantityUnit:'BASE_ASSET',contractSizeBase:'1'},
   book:{ok:true,sourceTime:Number(book.T),ask:Number(book.asks[0][0]),levels:{bids:book.bids.map(x=>x.map(Number)),asks:book.asks.map(x=>x.map(Number))}}}},venueSizingInputs,
  // Live orders stay OFF here; a live call would be a test failure.
  LIVE:{mode:'OFF'},live:{onSignal:async()=>{throw Error('live order attempted in Telegram test')}},
  state:{activeSet:new Set([row.symbol]),rest:'connected',quotes:new Map([[row.symbol,{...marketContext.market,price:marketContext.price,priceAt:now}]]),analyses:new Map([[row.symbol,row]])},
  books:new Map([[row.symbol,marketContext.book]]),storageHealth:{healthy:true},persisted:{seen:{},alerts:[]},
  paper:{store:{open:[],seen:{}},register(value){registrations.push(value);sandbox.paper.store.seen[key(value)]=now}},
  evaluateSignal,getSignalScorePolicy,finalTelegramMatch,officialMarketLinks,signalKey,nextSizeScale,planWithQuantity,planZoneDca,leverageForScore,
  telegramMessage:(...args)=>{if(formatFailure)throw Error('offline-test-token must never be logged');return telegramMessage(...args)},
  save:candidate=>{if(saveFailure)throw Error('synthetic save failure');sandbox.persisted=structuredClone(candidate)},
  send:(type,value)=>events.push({type,value}),
  fetch:async(_url,options)=>{deliveries.push(JSON.parse(options.body));if(transport==='network')throw Error('offline-test-token must never be logged');return {ok:transport==='ok',status:transport==='ok'?200:503}}
 };
 const key=value=>signalKey({market:'CRYPTO',symbol:value.symbol,direction:value.direction,pattern:value.pattern,barAt:value.patternConfirmedAt});
 vm.createContext(sandbox);vm.runInContext(code,sandbox);
 return {row,now,sandbox,deliveries,logs,events,observations,registrations,
  publish:async()=>{const current=sandbox.currentAnalysis(row,now);sandbox.publishCryptoSignal(current,current.decision,now);await new Promise(resolve=>setImmediate(resolve));return current},
  setTransport:value=>{transport=value},setFormatFailure:value=>{formatFailure=value},setSaveFailure:value=>{saveFailure=value},
  nextSignal:()=>{row.time++;row.patternConfirmedAt++;return row},key};
}

test('production final-results decision alone gates Telegram; 85-point observations and later quote rejection never send',async()=>{
 const h=harness();h.row.score=85;
 assert.equal((await h.publish()).decision.ready,false);assert.equal(h.deliveries.length,0);
 h.row.score=90;h.row.technicalValidation.passed=false;
 assert.equal((await h.publish()).decision.ready,false);assert.equal(h.deliveries.length,0);
 h.row.technicalValidation.passed=true;const approved=h.sandbox.currentAnalysis(h.row,h.now);
 assert.equal(approved.decision.ready,true);
 h.sandbox.books.get(h.row.symbol).T=h.now-100000;
 await h.sandbox.tgNotify(approved);assert.equal(h.deliveries.length,0,'an earlier approval cannot bypass current quote validation');
 assert.equal(h.sandbox.relevantSignals().length,0);
});

test('final publication sends one four-field Mock message and persisted deduplication survives repeated scans and restart',async()=>{
 const h=harness();await h.publish();await h.publish();
 assert.equal(h.sandbox.relevantSignals().length,1);assert.equal(h.deliveries.length,1);assert.equal(h.events.length,1);
 const lines=h.deliveries[0].text.split('\n');assert.equal(lines.length,4);assert.deepEqual(lines.slice(0,2),['종목: BTCUSDT','방향: 롱 (LONG)']);
 assert.match(lines[2],/^배율: \d+배 \(모의 기준, \d+점\)$/);assert.match(lines[3],/^포지션 수량\(모의\): (미확인|[\d.,]+ BTC \(진입 예정\).*)$/);
 assert.equal(h.deliveries[0].reply_markup,undefined);assert.doesNotMatch(h.deliveries[0].text,/https|TP|EMA|RSI|뉴스/);
 assert.equal(h.registrations.length,1);
 const saved=structuredClone(h.sandbox.persisted),restarted=harness();
 Object.assign(restarted.row,{time:h.row.time,patternConfirmedAt:h.row.patternConfirmedAt});
 restarted.sandbox.persisted=saved;await restarted.publish();assert.equal(restarted.deliveries.length,0);
});

test('only an opened PAPER position for the exact signal supplies leverage and remaining quantity',async()=>{
 const h=harness();h.sandbox.paper.store.open.push({key:h.key(h.row),market:'CRYPTO',symbol:h.row.symbol,direction:h.row.direction,
  pattern:h.row.pattern,barAt:h.row.patternConfirmedAt,openedAt:h.now-10,entryFill:100,leverage:4,
  originalQty:1,qtyRemaining:.6,targetPlan:{quantityUnit:'BASE_ASSET'}});
 await h.publish();assert.match(h.deliveries[0].text,/배율: 4배 \(모의 기준/);
 assert.match(h.deliveries[0].text,/포지션 수량\(모의\): 0.6 BTC/);assert.doesNotMatch(h.deliveries[0].text,/20배/);
});

test('network, HTTP and message-format failures do not stop publication or subsequent final signals',async()=>{
 for(const failure of ['network','http','format']){
  const h=harness();h.setTransport(failure);h.setFormatFailure(failure==='format');
  await h.publish();assert.equal(h.sandbox.persisted.alerts.length,1);assert.equal(h.events.length,1);
  const attempted=h.deliveries.length;await h.publish();assert.equal(h.deliveries.length,attempted,'do not resend an uncertain delivery');
  assert.ok(h.logs.length>0);assert.ok(h.logs.every(line=>!line.includes('offline-test-token')));
  h.setTransport('ok');h.setFormatFailure(false);h.nextSignal();await h.publish();
  assert.equal(h.deliveries.length,attempted+1);assert.equal(h.sandbox.persisted.alerts.length,2);
 }
});

test('failed alert persistence prevents Telegram delivery and remains retryable after storage recovery',async()=>{
 const h=harness();h.setSaveFailure(true);
 await assert.rejects(h.publish(),/synthetic save failure/);assert.equal(h.deliveries.length,0);
 assert.equal(Object.keys(h.sandbox.persisted.seen).length,0);
 h.setSaveFailure(false);await h.publish();assert.equal(h.deliveries.length,1);
});

test('the 알림 설정 switch for final-signal Telegram stops delivery',async()=>{
 const h=harness();h.sandbox.persisted.notifySettings={telegramSignals:false};await h.publish();
 assert.equal(h.deliveries.length,0);assert.equal(h.sandbox.relevantSignals().length,1,'the signal itself is unaffected');
});
