import {fetchLocal} from './helpers/http_request.mjs';
import {trackChild,stopChild} from './helpers/child_process.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import net from 'node:net';
import {once} from 'node:events';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import fs from 'node:fs/promises';
import os from 'node:os';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const nap=ms=>new Promise(r=>setTimeout(r,ms));
async function port(){const sock=net.createServer();sock.listen(0,'127.0.0.1');await once(sock,'listening');const p=sock.address().port;await new Promise(r=>sock.close(r));return p}
async function eventually(url,predicate,{attempts=100,ms=120,signal,request}={}){
 let value;
 for(let n=0;n<attempts;n++){
  signal.throwIfAborted();
  try{const r=await request(url);value=await r.json();if(predicate(value))return value}catch{}
  await nap(ms);
 }
 throw Error('condition not reached; last='+JSON.stringify(value).slice(0,800));
}
test('Binance outage blocks unavailable market discovery and recovers without another provider', {timeout:25000},async(t)=>{
 const request=(input,options={})=>fetchLocal(input,{...options,signal:t.signal});
 const sandbox=await fs.mkdtemp(path.join(os.tmpdir(),'signal-lab-recover-'));
 const project=path.join(sandbox,'project'),p=await port(),flag=path.join(sandbox,'BINANCE_OFFLINE');
 await fs.cp(root,project,{recursive:true,filter:src=>!['.env','.git','node_modules','.updates','store.json','scanner_diagnostics.txt'].includes(path.basename(src))});
 await fs.writeFile(flag,'blocked');
 const child=trackChild(spawn(process.execPath,['--import','./tests/mock_outage.mjs','server.mjs'],{
  cwd:project,env:{...process.env,SIGNAL_LAB_TEST_OUTAGE_FLAG:flag,SIGNAL_LAB_DATA_DIR:path.join(sandbox,'user-records'),PORT:String(p),HOST:'127.0.0.1',AUTO_UPDATE:'false',TELEGRAM_NEWS_ALERTS:'false'},stdio:'pipe'}));
 let logs='';child.stdout.on('data',d=>logs+=String(d));child.stderr.on('data',d=>logs+=String(d));
 const base=`http://127.0.0.1:${p}`;
 const poll=(url,predicate)=>eventually(url,predicate,{signal:t.signal,request});
 try{
  const blocked=await poll(base+'/api/status',x=>x.activeCount===0&&x.marketError!=='');
  assert.equal(blocked.actualOrdersEnabled,false);
  await fs.rm(flag);
  const recovery=await request(base+'/api/scan',{method:'POST'});assert.equal(recovery.status,202);await recovery.arrayBuffer();
  const down=await poll(base+'/api/status',x=>x.scanMode==='binance-usdt-perpetual'&&x.scanSuccess>0&&!x.scanning);
  assert.equal(down.activeCount,4);
  assert.equal(down.researchCount,0);
  assert.ok(down.cycleScanned>0);
  assert.equal(down.marketError,'');assert.equal(down.analysisVenue,'BINANCE');assert.equal(down.actualOrdersEnabled,false);
  const results=await(await request(base+'/api/results')).json();
  assert.equal(results.signals.length,0);
  assert.deepEqual(results.patterns,[],'main API must not publish observer candidates');
  const researchMarket=await(await request(base+'/api/market')).json();
  assert.equal(researchMarket.research.length,0);assert.equal(researchMarket.markets.length,4);
  const funnel=await(await request(base+'/api/scan/diagnostics')).json();
  assert.ok(funnel.uniqueAnalyzed>=2,'diagnostics must report unique scanned symbols');
  assert.equal(funnel.ready,0,'research-only observations must never count as actionable');
  const trades=await(await request(base+'/api/paper')).json();
  assert.equal(trades.open?.length||0,0,'never trade research-only symbols');
  const accepted=await(await request(base+'/api/scan',{method:'POST'})).json();
  assert.equal(accepted.accepted,true);
  const scanned=await poll(base+'/api/status',x=>x.cycle>down.cycle&&x.scanSuccess>0&&!x.scanning);
  assert.equal(scanned.scanMode,'binance-usdt-perpetual');
  const acceptedAgain=await(await request(base+'/api/scan',{method:'POST'})).json();
  assert.equal(acceptedAgain.accepted,true);
  const healthy=await poll(base+'/api/status',x=>x.scanMode==='binance-usdt-perpetual'&&x.activeCount===4&&x.scanSuccess>0);
  assert.equal(healthy.analysisVenue,'BINANCE');
  assert.ok(healthy.verifiedAt>0);
  assert.ok(healthy.scannedSinceBoot>down.scannedSinceBoot);
  const markets=await(await request(base+'/api/market')).json();
  assert.deepEqual(markets.markets.map(x=>x.symbol),['BTCUSDT','ETHUSDT','SOLUSDT','1000PEPEUSDT']);
 }catch(e){assert.fail(e.message+'\n'+logs.slice(-8000))}
 finally{await stopChild(child);await fs.rm(sandbox,{recursive:true,force:true,maxRetries:8,retryDelay:100})}
});
