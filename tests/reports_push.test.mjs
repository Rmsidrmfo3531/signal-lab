import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {buildReport,pushReport,tradeSummary,ledgerSummary} from '../reports_push.mjs';

test('ledger: missing and pending results stay out of the win rate and settled count',()=>{
 const s=ledgerSummary({closed:[{netUSD:1.5,netSource:'EXCHANGE_FILLS'},{netUSD:null,netSource:'UNKNOWN'},
  {netUSD:-.5,netSource:'ESTIMATE_BEFORE_FEES'},{netUSD:null,netSource:'PENDING'}]});
 assert.equal(s.closedCount,4);
 assert.deepEqual([s.settled,s.estimated,s.unknown,s.pending,s.winRateSample],[1,1,1,1,2]);
 assert.equal(s.winRatePct,50);assert.equal(s.netUSD,1);
 assert.equal(s.confirmedWinRatePct,100);assert.equal(s.confirmedNetUSD,1.5);
 assert.equal(ledgerSummary({closed:[{netUSD:null,netSource:'UNKNOWN'}]}).winRatePct,null);
 const withStatus=ledgerSummary({closed:[{netSource:'UNKNOWN',settlement:{state:'ORDER_LINK_MISSING',checkedAt:123}}]});
 assert.deepEqual(withStatus.trades[0].settlement,{state:'ORDER_LINK_MISSING',checkedAt:123});
 assert.equal(withStatus.confirmedWinRatePct,null);assert.equal(withStatus.confirmedNetUSD,null);
});

const rec={signalKey:'CRYPTO:AUSDT:SHORT:P1:1',clientOrderId:'slabc',entryOrderId:'1736012449498123737',stopOrderId:'9',targetOrderIds:['8'],
 venueSymbol:'A-USDT',symbol:'AUSDT',mode:'TESTNET',direction:'SHORT',status:'CLOSED',createdAt:1,closedAt:2,stop:1.1,targets:[0.9],
 realized:{source:'EXCHANGE',netUSD:1.5,pnlUSD:1.6,feeUSD:-0.1},signal:{pattern:'P1',score:90},events:[{type:'CLOSED',at:2}]};

test('reports carry results only: no order ids, client ids or secret-looking fields',()=>{
 const t=tradeSummary(rec);assert.equal(t.pattern,'P1');assert.equal(t.realized.netUSD,1.5);
 const text=JSON.stringify(buildReport({readiness:{ready:false},insights:[],journal:[{id:'live-x',source:'LIVE_AUTO',symbol:'AUSDT'},{id:'m',source:'MANUAL'}],records:[rec,{...rec,test:true}]}));
 for(const bad of ['1736012449498123737','slabc','stopOrderId','targetOrderIds','venueSymbol','"id"'])assert.equal(text.includes(bad),false,bad);
 assert.throws(()=>buildReport({readiness:{apiKey:'x'},records:[]}),/REPORT_SECRET_FIELD/);
});

test('push writes latest and the day file, commits and pushes to the reports repository',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'rp-')),bare=path.join(root,'remote.git'),work=path.join(root,'reports');
 execFileSync('git',['init','-q','--bare',bare]);execFileSync('git',['clone','-q',bare,work],{stdio:'ignore'});
 assert.deepEqual(await pushReport(path.join(root,'none'),{}),{pushed:false,reason:'REPORTS_REPO_NOT_SET_UP'});
 const now=Date.parse('2026-11-13T01:00:00Z');
 const r=await pushReport(work,buildReport({readiness:{ready:false},records:[rec],now}),{now});
 assert.equal(r.pushed,true);assert.equal(r.day,'2026-11-13');
 const files=execFileSync('git',['--git-dir',bare,'ls-tree','-r','--name-only','HEAD'],{encoding:'utf8'});
 assert.match(files,/latest\.json/);assert.match(files,/days\/2026-11-13\.json/);
 assert.equal((await pushReport(work,buildReport({readiness:{ready:false},records:[rec],now}),{now})).reason,'NO_CHANGE');
});

test('copy and scalp ledgers: totals, drawdown, serious events, and no order or position ids',()=>{
 const now=Date.parse('2026-11-16T19:00:00Z');
 const copy={positions:{'A|LONG':{id:'A|LONG|1',symbol:'AUSDT',venueSymbol:'A-USDT',direction:'LONG',status:'OPEN',qty:1,avg:2,adds:3,leverage:10,stopOrderId:'1999000111222333444'}},
  closed:[{id:'B|SHORT|1',symbol:'BUSDT',direction:'SHORT',closedAt:now-3000,netUSD:-2,netSource:'ESTIMATE_BEFORE_FEES',adds:1,stopOrderId:'1888000111222333444'},
   {id:'C|LONG|1',symbol:'CUSDT',direction:'LONG',closedAt:now-4000,netUSD:3,adds:0},{symbol:'DUSDT',direction:'LONG',closedAt:now-1000,netUSD:-1.5}],
  events:[{type:'ERROR',at:now-1000,symbol:'AUSDT',reason:'order 1736012449498123737 failed'},{type:'SKIPPED',at:now-1000},{type:'ERROR',at:now-9*86400000}],killed:false};
 const s=ledgerSummary(copy,{now,equityUSD:123.456});
 assert.equal(s.closedCount,3);assert.equal(s.wins,1);assert.equal(s.netUSD,-0.5);assert.equal(s.maxDrawdownUSD,3.5);assert.equal(s.equityUSD,123.456);
 assert.equal(s.open.length,1);assert.equal(s.serious.length,1);assert.equal(s.eventCounts7d.SKIPPED,1);
 assert.equal(ledgerSummary(null),null);
 const text=JSON.stringify(buildReport({readiness:{ready:false},records:[],ledgers:{copyLive:{store:copy,equityUSD:5},scalp:null},now}));
 for(const bad of ['1736012449498123737','1999000111222333444','1888000111222333444','stopOrderId','venueSymbol','"id"','A|LONG|1'])assert.equal(text.includes(bad),false,bad);
 const scalp=ledgerSummary({open:[{symbol:'EUSDT',direction:'SHORT',status:'OPEN',avg:1,stop:1.1}],closed:[{symbol:'FUSDT',direction:'LONG',closedAt:now,netUSD:0.4,tpHits:2,adds:[]}],events:[]},{now});
 assert.equal(scalp.winRatePct,100);assert.equal(scalp.open[0].stop,1.1);assert.equal(scalp.trades[0].tpHits,2);
 const repeating=ledgerSummary({open:[{symbol:'GUSDT',stop:1.1,initialStop:1.2,stopLossEnabled:false,unrealized:-.15,scaleIn:{count:2}}],
  closed:[{symbol:'HUSDT',closedAt:now,scaleIn:{count:3}}]},{now});
 assert.equal(repeating.open[0].stop,null);assert.equal(repeating.open[0].riskReference,1.2);
 assert.equal(repeating.open[0].adds,2);assert.equal(repeating.open[0].unrealizedUSD,-.15);assert.equal(repeating.trades[0].adds,3);
});
