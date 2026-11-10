import test from 'node:test';
import assert from 'node:assert/strict';
import {PaperEngine} from '../paper.mjs';
import {paperNotificationText,windowsPaperNotify} from '../windows_paper_notify.mjs';

const initial=Date.parse('2026-10-20T08:00:00Z');
const signal=(direction='LONG',symbol='BTCUSDT')=>({managementVersion:'LEGACY_R_MULTIPLES',symbol,direction,entry:100,stop:direction==='LONG'?98:102,pattern:'1h confirmed',patternConfirmedAt:initial-60000});
function tester(seed={}){
 let t=initial;const events=[];const engine=new PaperEngine(seed,{now:()=>t,onEvent:ev=>events.push(ev)});
 return {engine,events,quote:(p,symbol='BTCUSDT',market='CRYPTO')=>{t+=1000;engine.onPrice(market,symbol,p,t)},time:()=>t};
}

test('paper entry emits exactly one OPEN event at fresh simulated fill; not at signal registration',()=>{
 const t=tester();
 assert.equal(t.engine.register(signal(),{quoteEligible:true}),true);
 assert.equal(t.events.length,0);
 t.quote(100);assert.equal(t.events.length,1);
 assert.deepEqual(t.events.map(x=>x.type),['OPEN']);
 assert.equal(t.events[0].symbol,'BTCUSDT');
 assert.equal(t.events[0].direction,'LONG');
 assert.ok(t.events[0].entryFill>100);
 assert.ok(t.events[0].notionalUSD>0);
 t.quote(101);assert.equal(t.events.length,1,'non-closing ticks must not repeat OPEN');
});

test('partial targets do not emit full CLOSE; final close emits net PNL including costs once',()=>{
 const t=tester();t.engine.register(signal(),{quoteEligible:true});t.quote(100);t.quote(104);
 assert.deepEqual(t.events.map(x=>x.type),['OPEN']);
 t.quote(106);
 assert.deepEqual(t.events.map(x=>x.type),['OPEN']);
 t.quote(108);
 assert.deepEqual(t.events.map(x=>x.type),['OPEN','CLOSE']);
 assert.equal(t.events[1].closeReason,'ALL_TARGETS');
 assert.equal(t.events[1].realizedPnLUSD,t.engine.store.closed[0].realizedPnLUSD);
 assert.ok(t.events[1].realizedPnLUSD>0);
 t.quote(109);assert.equal(t.events.length,2,'closed position cannot alert twice');
});

test('stop triggers SHORT close with loss and precise reason',()=>{
 const t=tester();t.engine.register(signal('SHORT','ETHUSDT'),{quoteEligible:true,symbol:'ETHUSDT'});
 t.quote(100,'ETHUSDT');t.quote(110,'ETHUSDT');
 assert.deepEqual(t.events.map(x=>x.type),['OPEN','CLOSE']);
 assert.equal(t.events[1].direction,'SHORT');assert.equal(t.events[1].closeReason,'STOP');
 assert.ok(t.events[1].realizedPnLUSD<0);
});

test('persisted closed trades do not generate replay notifications on restart',()=>{
 const before=tester();before.engine.register(signal(),{quoteEligible:true});before.quote(100);before.quote(95);
 const restarted=tester(structuredClone(before.engine.store));
 assert.equal(restarted.events.length,0);
 assert.equal(restarted.engine.snapshot().closedCount,1);
 restarted.quote(93);assert.equal(restarted.events.length,0);
});

test('toast text clearly labels simulation not real trading, profit and loss format',()=>{
 const open=paperNotificationText({type:'OPEN',symbol:'BTCUSDT',direction:'LONG',entryFill:100.04,notionalUSD:500});
 assert.match(open.title,/SIM.*가상 진입/);assert.match(open.body,/실제 주문 없음/);
 const close=paperNotificationText({type:'CLOSE',symbol:'SOLUSDT',direction:'SHORT',closeReason:'STOP',realizedPnLUSD:-5.25});
 assert.match(close.title,/CLOSE/);assert.match(close.body,/-\$5\.25/);
 assert.throws(()=>paperNotificationText({type:'NOT_REAL'}),/Invalid/);
});

test('Windows notification launcher passes safe base64 text and does not execute on other OS',()=>{
 const event={type:'OPEN',symbol:'BTCUSDT',direction:'LONG',entryFill:123,notionalUSD:100};
 assert.equal(windowsPaperNotify(event,{platform:'linux'}).queued,false);
 let call;
 const proc={on:()=>{},unref:()=>{}};
 const launch=(command,args,opts)=>{call={command,args,opts};return proc};
 const result=windowsPaperNotify(event,{platform:'win32',launch,script:'C:/Signal Lab/notify.ps1'});
 assert.equal(result.queued,true);
 assert.equal(call.command,'powershell.exe');
 assert.equal(call.opts.windowsHide,true);
 const title=Buffer.from(call.args[call.args.indexOf('-Title64')+1],'base64').toString();
 assert.match(title,/BTCUSDT/);
 assert.equal(call.args[call.args.indexOf('-File')+1],'C:/Signal Lab/notify.ps1');
});

test('bad notification callback cannot interrupt simulated PNL, prevent subsequent trades',()=>{
 let now=initial;
 const engine=new PaperEngine({}, {now:()=>now,onEvent:()=>{throw Error('desktop unavailable')}});
 engine.register(signal(),{quoteEligible:true});now+=1000;engine.onPrice('CRYPTO','BTCUSDT',100,now);
 now+=1000;engine.onPrice('CRYPTO','BTCUSDT',95,now);
 assert.equal(engine.store.closed.length,1);
});
