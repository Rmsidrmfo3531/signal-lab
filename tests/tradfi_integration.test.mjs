import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import net from 'node:net';
import {once} from 'node:events';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import fs from 'node:fs/promises';
import os from 'node:os';
const project=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
async function freePort(){const s=net.createServer();s.listen(0,'127.0.0.1');await once(s,'listening');const port=s.address().port;await new Promise(r=>s.close(r));return port;}
const nap=ms=>new Promise(r=>setTimeout(r,ms));
test('TradFi verified SWAP endpoint and mobile-compatible UI: no fake signals without OHLC feed',{timeout:15000},async()=>{
 const port=await freePort(),sandbox=await fs.mkdtemp(path.join(os.tmpdir(),'tradfi-test-'));
 await fs.cp(project,sandbox,{recursive:true,filter:src=>path.basename(src)!=='.env'});
 const child=spawn(process.execPath,['--import','./tests/mock_runtime.mjs','server.mjs'],{cwd:sandbox,env:{...process.env,SIGNAL_LAB_DATA_DIR:path.join(sandbox,'persistent-data'),PORT:String(port),HOST:'127.0.0.1',TWELVE_DATA_API_KEY:'',AUTO_UPDATE:'false',TELEGRAM_NEWS_ALERTS:'false'},stdio:'pipe'});
 let logs='';child.stdout.on('data',d=>logs+=d);child.stderr.on('data',d=>logs+=d);
 try{
  let doc;
  for(let i=0;i<85;i++){
   await nap(80);
   try{doc=await(await fetch(`http://127.0.0.1:${port}/api/tradfi`)).json()}catch{}
   if(doc?.status==='connected')break;
  }
  assert.equal(doc?.status,'connected',logs);
  assert.equal(doc.swaps.length,1,'only listed SWAP markets, not invented TradFi');
  assert.equal(doc.swaps[0].ticker,'XAU-SWAP');
  assert.equal(doc.swaps[0].quote.eligible,false,'missing bid/ask forbids order eligibility');
  assert.equal(doc.feedStatus,'unconfigured');
  assert.deepEqual(doc.patterns,[],'no fake confirmed patterns');
  const page=await(await fetch(`http://127.0.0.1:${port}/`)).text();
  assert.match(page,/id="scanner"/);assert.match(page,/id="tradfi"/);assert.ok(page.indexOf('id="scanner"')<page.indexOf('id="tradfi"'));
  assert.match(page,/href="#tradfi"/);assert.match(page,/id="tradfiChart"/);
  const js=await(await fetch(`http://127.0.0.1:${port}/tradfi.js`)).text();assert.match(js,/TradingView/);
 }finally{child.kill('SIGTERM');await nap(100);if(child.exitCode===null)child.kill('SIGKILL');await fs.rm(sandbox,{recursive:true,force:true})}
});
