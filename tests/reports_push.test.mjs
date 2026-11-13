import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {buildReport,pushReport,tradeSummary} from '../reports_push.mjs';

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
