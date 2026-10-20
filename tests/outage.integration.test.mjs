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
async function eventually(url,predicate,{attempts=100,ms=120}={}){
 let value;
 for(let n=0;n<attempts;n++){
  try{const r=await fetch(url);value=await r.json();if(predicate(value))return value}catch{}
  await nap(ms);
 }
 throw Error('condition not reached; last='+JSON.stringify(value).slice(0,800));
}
test('outage at startup continues technical scanning but blocks trade signals, then reconnects', {timeout:25000},async()=>{
 const sandbox=await fs.mkdtemp(path.join(os.tmpdir(),'signal-lab-recover-'));
 const project=path.join(sandbox,'project'),p=await port(),flag=path.join(sandbox,'VARIATIONAL_OFFLINE');
 await fs.cp(root,project,{recursive:true,filter:src=>path.basename(src)!=='.env'});
 await fs.writeFile(flag,'blocked');
 const child=spawn(process.execPath,['--import','./tests/mock_outage.mjs','server.mjs'],{
  cwd:project,env:{...process.env,SIGNAL_LAB_TEST_OUTAGE_FLAG:flag,SIGNAL_LAB_DATA_DIR:path.join(sandbox,'user-records'),PORT:String(p),HOST:'127.0.0.1',AUTO_UPDATE:'false',TELEGRAM_NEWS_ALERTS:'false'},stdio:'pipe'});
 let logs='';child.stdout.on('data',d=>logs+=String(d));child.stderr.on('data',d=>logs+=String(d));
 const base=`http://127.0.0.1:${p}`;
 try{
  const down=await eventually(base+'/api/status',x=>x.scanMode==='research-only'&&x.scanSuccess>0&&!x.scanning);
  assert.equal(down.activeCount,0);
  assert.ok(down.researchCount>=2);
  assert.ok(down.cycleScanned>0);
  assert.match(down.marketError,/Variational/i);
  const results=await(await fetch(base+'/api/results')).json();
  assert.equal(results.signals.length,0);
  assert.ok(results.patterns.every(x=>!x.qualified),'research patterns may be shown only as explicitly non-actionable observations');
  const researchMarket=await(await fetch(base+'/api/market')).json();
  assert.ok(researchMarket.research.length>=2,'research-only scanner must expose nontrading observation symbols');
  const funnel=await(await fetch(base+'/api/scan/diagnostics')).json();
  assert.ok(funnel.uniqueAnalyzed>=2,'diagnostics must report unique scanned symbols');
  assert.equal(funnel.ready,0,'research-only observations must never count as actionable');
  const trades=await(await fetch(base+'/api/paper')).json();
  assert.equal(trades.open?.length||0,0,'never trade research-only symbols');
  const accepted=await(await fetch(base+'/api/scan',{method:'POST'})).json();
  assert.equal(accepted.accepted,true);
  const scanned=await eventually(base+'/api/status',x=>x.cycle>down.cycle&&x.scanSuccess>0&&!x.scanning);
  assert.equal(scanned.scanMode,'research-only');
  await fs.rm(flag);
  const acceptedAgain=await(await fetch(base+'/api/scan',{method:'POST'})).json();
  assert.equal(acceptedAgain.accepted,true);
  const healthy=await eventually(base+'/api/status',x=>x.scanMode==='verified'&&x.activeCount===2&&x.scanSuccess>0);
  assert.equal(healthy.variational,'connected');
  assert.ok(healthy.verifiedAt>0);
  assert.ok(healthy.scannedSinceBoot>down.scannedSinceBoot);
  const markets=await(await fetch(base+'/api/market')).json();
  assert.deepEqual(markets.markets.map(x=>x.symbol),['BTCUSDT','ETHUSDT']);
 }catch(e){assert.fail(e.message+'\n'+logs.slice(-8000))}
 finally{child.kill('SIGTERM');await nap(150);if(child.exitCode===null)child.kill('SIGKILL');await fs.rm(sandbox,{recursive:true,force:true})}
});
