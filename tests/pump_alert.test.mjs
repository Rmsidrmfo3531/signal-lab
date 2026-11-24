import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {parsePumpAlert,pumpOutcome,summarizePumpAlerts,PumpAlertBook,pumpAlertEndpoint,PUMP_COST_PCT,PUMP_HORIZONS_MIN,PUMP_ALERT_FILE} from '../pump_alert.mjs';
import {SCALP_EXEC_COSTS} from '../scalp_executor.mjs';
import {pumpAlertsHTML} from '../public/live_control.js';

// 24 alerts relayed by @ggangalt2_bot, 2026-11-23 22:24 ~ 11-24 06:09 KST (17 Bybit stock perps at the US open, 7 alts).
const SAMPLE=JSON.parse(fs.readFileSync(new URL('./fixtures/pump_alerts_sample.json',import.meta.url),'utf8'));
const text=(a,ticks)=>`🚨🚨 공습경보 ${a.sym} 🚨🚨\n3분 변동성 ${a.pct.toFixed(1)}% ${a.dir==='UP'?'↑':'↓'}\nlow ${a.low} ↔ high ${a.high}\n현재 ${a.now} (틱 ${ticks})`;
const tmp=()=>fs.mkdtempSync(path.join(os.tmpdir(),'pump-alert-'));
const TOKEN='t'.repeat(32);

test('parser: the 24 sample alerts, the exact FLNC text, and nothing else',()=>{
 assert.equal(SAMPLE.length,24);
 SAMPLE.forEach((a,i)=>assert.deepEqual(parsePumpAlert(text(a,100+i)),{symbol:a.sym,dir:a.dir,pct:a.pct,low:a.low,high:a.high,price:a.now,ticks:100+i},a.sym));
 assert.deepEqual(parsePumpAlert('🚨🚨 공습경보 FLNCUSDT 🚨🚨\n3분 변동성 11.6% ↓\nlow 3.581 ↔ high 4.049\n현재 3.581 (틱 492)'),
  {symbol:'FLNCUSDT',dir:'DOWN',pct:11.6,low:3.581,high:4.049,price:3.581,ticks:492});
 assert.equal(parsePumpAlert('🚨🚨 공습경보 FLOCKUSDT 🚨🚨\n3분 변동성 11.6% ↑\nlow 0.0277 ↔ high 0.03178\n현재 0.0309 (틱 1,204)').ticks,1204);
 assert.equal(SAMPLE.filter(a=>a.dir==='UP').length+SAMPLE.filter(a=>a.dir==='DOWN').length,24);
 for(const other of ['구독 완료! 이제 공습경보를 받습니다.','이거 들어가도 됨?','📌 포지션 진입\n🪙 TNSRUSDT  🔴 Short  ×5',
  '🚨🚨 공습경보 FLNCUSDT 🚨🚨\n3분 변동성 11.6% ↓','🚨 공습경보 FLNCUSDT\n3분 변동성 11.6% ↓\nlow 5 ↔ high 4\n현재 4.5 (틱 1)',
  '🚨 공습경보 FLNC\n3분 변동성 11.6% ↓\nlow 3 ↔ high 4\n현재 3.5 (틱 1)','',null,undefined,42,'x'.repeat(3000)])
  assert.equal(parsePumpAlert(other),null,String(other).slice(0,30));
});

test('endpoint: the copy token only (constant-time, 24+ chars), body checks, one record per message id',async()=>{
 const book=new PumpAlertBook({now:()=>1e12});const calls=[];
 const onAlert=a=>{calls.push(a);return {entered:false,reason:'PUMP_NO_REVERSAL'}};
 const body={id:5,chat:'777',date:1e12-1000,text:text(SAMPLE.at(-1),492)};
 for(const [token,want] of [['',TOKEN],['wrong'+TOKEN.slice(5),TOKEN],[TOKEN.slice(0,20),TOKEN.slice(0,20)],[TOKEN,''],[TOKEN,undefined],[TOKEN+'x',TOKEN]])
  assert.equal(pumpAlertEndpoint({token,want,body,book,onAlert}).status,403);
 assert.equal(book.records.length,0);assert.equal(calls.length,0);
 assert.equal(pumpAlertEndpoint({token:TOKEN,want:TOKEN,body:{id:1},book}).status,400);
 assert.equal(pumpAlertEndpoint({token:TOKEN,want:TOKEN,body:{text:'x'.repeat(4001)},book}).status,400);
 assert.deepEqual(pumpAlertEndpoint({token:TOKEN,want:TOKEN,body:{id:9,text:'구독 완료!'},book,onAlert}),{status:200,body:{ok:true,ignored:true}});
 const ok=pumpAlertEndpoint({token:TOKEN,want:TOKEN,body,book,onAlert});
 assert.deepEqual(ok,{status:200,body:{ok:true,recorded:true,symbol:'FLNCUSDT',dir:'DOWN'}});
 assert.equal(pumpAlertEndpoint({token:TOKEN,want:TOKEN,body,book,onAlert}).body.duplicate,true);
 await new Promise(r=>setTimeout(r,10));
 assert.equal(calls.length,1,'the scalp sees one alert per message');
 assert.deepEqual([calls[0].symbol,calls[0].dir,calls[0].key,calls[0].at],['FLNCUSDT','DOWN','777:5',1e12-1000]);
 assert.equal(book.records.length,1);assert.equal(book.records[0].scalp.reason,'PUMP_NO_REVERSAL');
 // No scalp (OFF / LIVE signal mode): recorded only.
 assert.equal(pumpAlertEndpoint({token:TOKEN,want:TOKEN,body:{...body,id:6},book,onAlert:null}).body.recorded,true);
 assert.equal(book.records[1].scalp,null);
});

test('book: pump-alerts.json in the data folder, last N kept, reloaded, listing recorded',async()=>{
 const dir=tmp();
 try{
  const book=new PumpAlertBook({directory:dir,max:5,now:()=>1e12,listed:async s=>s==='FLNCUSDT'});
  SAMPLE.forEach((a,i)=>book.record({id:i,date:Date.parse(a.at),text:text(a,i)}));
  await new Promise(r=>setTimeout(r,10));
  const file=path.join(dir,PUMP_ALERT_FILE),saved=JSON.parse(fs.readFileSync(file,'utf8'));
  assert.equal(saved.records.length,5);assert.equal(saved.records.at(-1).symbol,'FLNCUSDT');
  assert.equal(saved.records.at(-1).bingx.listed,true);assert.equal(saved.records.at(-2).bingx.listed,false);
  const again=new PumpAlertBook({directory:dir,max:5});
  assert.equal(again.records.length,5);
  assert.equal(again.record({id:23,date:Date.parse(SAMPLE[23].at),text:text(SAMPLE[23],23)}).duplicate,true);
  book.attachScalp(book.records.at(-1).key,{entered:true,tries:2});
  assert.deepEqual(new PumpAlertBook({directory:dir}).records.at(-1).scalp,{entered:true,reason:null,tries:2,at:1e12});
 }finally{fs.rmSync(dir,{recursive:true,force:true})}
});

// 1m candles from a price path: rows[i] opens at start + i minutes.
const M=60000;
const bars=(start,path)=>path.map(([o,h,l,c],i)=>[start+i*M,String(o),String(h),String(l),String(c),'10',start+(i+1)*M-1,'0']);

test('outcome: reference = next minute open; horizon closes; fade / follow net of costs; best and worst moves',()=>{
 assert.equal(PUMP_COST_PCT,+((2*SCALP_EXEC_COSTS.takerRate+(2*SCALP_EXEC_COSTS.slippageBps+SCALP_EXEC_COSTS.spreadBps)/1e4)*100).toFixed(4));
 assert.equal(PUMP_COST_PCT,0.17);
 const m0=Date.parse('2026-11-24T00:00:00Z'),at=m0+25000; // alert 25 s into the minute
 // minute 0 (alert minute), minute 1 = reference (open 100), then the path down to 90 and back.
 const path=[[105,106,99,100],[100,101,98,99],[99,99,95,96],[96,97,94,95],[95,96,93,94],[94,95,90,92]];
 for(let i=0;i<60;i++)path.push([92,93,91,92]);
 const rows=bars(m0,path);
 const up=pumpOutcome({at,dir:'UP',rows,now:m0+70*M});
 assert.equal(up.refPrice,100);assert.equal(up.refAt,m0+M);
 // +1: close of minute 1 = 99 -> follow (long after UP) -1 % - costs; fade +1 % - costs.
 assert.equal(up.horizons[1].follow.netPct,+(-1-PUMP_COST_PCT).toFixed(4));
 assert.equal(up.horizons[1].fade.netPct,+(1-PUMP_COST_PCT).toFixed(4));
 assert.deepEqual(up.horizons[1].follow,{netPct:-1.17,mfePct:1,maePct:2});
 assert.deepEqual(up.horizons[1].fade,{netPct:0.83,mfePct:2,maePct:1});
 // +5: close of minute 5 = 92; low 90, high 101 over minutes 1..5.
 assert.deepEqual(up.horizons[5],{price:92,retPct:-8,follow:{netPct:-8.17,mfePct:1,maePct:10},fade:{netPct:7.83,mfePct:10,maePct:1}});
 // DOWN: follow = short, the same numbers swapped.
 const down=pumpOutcome({at,dir:'DOWN',rows,now:m0+70*M});
 assert.deepEqual(down.horizons[5].follow,up.horizons[5].fade);assert.deepEqual(down.horizons[5].fade,up.horizons[5].follow);
 assert.ok(down.horizons[60]);
 // Open candles are not used: at m0+6 min only +1 and +5 are known.
 const early=pumpOutcome({at,dir:'UP',rows,now:m0+6*M+5000});
 assert.deepEqual(Object.keys(early.horizons),['1','5']);
 // No reference candle yet: nothing.
 assert.equal(pumpOutcome({at,dir:'UP',rows,now:m0+M+30000}).refPrice,null);
});

test('tracking: BingX first, Binance fallback, horizons filled as they close, one source per alert, summary',async()=>{
 const m0=Date.parse('2026-11-24T00:00:00Z'),clock={t:m0+2*M+20000},reads=[];
 const path=[[100,100,100,100],[100,101,99,100]];for(let i=0;i<70;i++)path.push([100+i*.1,100+i*.1+.2,100+i*.1-.2,100+(i+1)*.1]);
 const rows=bars(m0,path);
 let bingxDown=false;
 const sources=[{name:'BINGX',klines:async(s,limit)=>{reads.push(['BINGX',s,limit]);if(s!=='AAAUSDT'||bingxDown)throw Object.assign(Error('x'),{code:'VENUE_ERROR_109400'});return rows}},
  {name:'BINANCE',klines:async(s,limit)=>{reads.push(['BINANCE',s,limit]);return rows}}];
 const book=new PumpAlertBook({now:()=>clock.t,sources});
 book.record({id:1,date:m0+10000,text:text({sym:'AAAUSDT',pct:11,dir:'UP',low:90,high:100,now:100},1)});
 book.record({id:2,date:m0+10000,text:text({sym:'BBBUSDT',pct:11,dir:'DOWN',low:90,high:100,now:90},2)});
 await book.track();
 assert.deepEqual(reads.map(r=>r.slice(0,2)),[['BINGX','AAAUSDT'],['BINGX','BBBUSDT'],['BINANCE','BBBUSDT']]);
 assert.equal(book.records[0].track.source,'BINGX');assert.equal(book.records[1].track.source,'BINANCE');
 assert.deepEqual(Object.keys(book.records[0].track.horizons),['1']);
 // Not due again within the minute; then +5 after minute 5 closes.
 reads.length=0;await book.track();assert.equal(reads.length,0);
 clock.t=m0+6*M+20000;await book.track();assert.deepEqual(Object.keys(book.records[0].track.horizons),['1','5']);
 // BingX fails later for AAA: Binance answers, but the alert keeps its BingX numbers (sources never mixed).
 bingxDown=true;clock.t=m0+16*M+20000;await book.track();
 assert.deepEqual(Object.keys(book.records[0].track.horizons),['1','5']);assert.equal(book.records[0].track.source,'BINGX');
 bingxDown=false;clock.t=m0+62*M+20000;await book.track();
 assert.deepEqual(Object.keys(book.records[0].track.horizons),PUMP_HORIZONS_MIN.map(String));assert.equal(book.records[0].trackDone,true);
 const s=book.summary();
 assert.equal(s.count,2);assert.equal(s.tracked,2);assert.equal(s.costPct,PUMP_COST_PCT);
 const f=book.records.map(x=>x.track.horizons[60]);
 assert.equal(s.byHorizon[60].n,2);
 assert.equal(s.byHorizon[60].followNetPct,+((f[0].follow.netPct+f[1].follow.netPct)/2).toFixed(4));
 assert.equal(s.byHorizon[60].fadeNetPct,+((f[0].fade.netPct+f[1].fade.netPct)/2).toFixed(4));
 // Expired after ~23 h (BingX keeps 1,440 1m candles).
 const old=new PumpAlertBook({now:()=>m0+24*3600000,sources});old.record({id:3,date:m0,text:text({sym:'CCCUSDT',pct:11,dir:'UP',low:1,high:2,now:2},3)});
 reads.length=0;await old.track();assert.equal(reads.length,0);assert.equal(old.records[0].trackError,'EXPIRED');
 // Screen block: count, the scalp's alert trades and the four horizons; no long text.
 const html=pumpAlertsHTML({...s,scalpTrades:{trades:1,netUSD:2.5}});
 assert.match(html,/알림<b>2건/);assert.match(html,/알림 단타<b>1건/);assert.equal((html.match(/분 <small>/g)||[]).length,4);
 assert.equal(pumpAlertsHTML(null),'');
});

test('summary: empty and partial books',()=>{
 const s=summarizePumpAlerts([]);
 assert.equal(s.count,0);assert.deepEqual(s.byHorizon[1],{n:0,fadeNetPct:null,followNetPct:null});
 const t=summarizePumpAlerts([{at:1,symbol:'A',dir:'UP',pct:11,scalp:{entered:true}},{at:2,symbol:'B',dir:'DOWN',pct:12,bingx:{listed:true},scalp:{entered:false,reason:'PUMP_NOT_ON_BINGX'}}],{now:3});
 assert.deepEqual([t.bingxListed,t.scalp.entered,t.scalp.evaluated,t.recent[0].scalp,t.recent[1].scalp],[1,1,2,'PUMP_NOT_ON_BINGX','ENTERED']);
});
