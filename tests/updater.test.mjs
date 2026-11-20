import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {compareVersions,allowedFile,validateManifest,stageUpdate,applyPending,pendingInfo} from '../updater.mjs';
const hex=x=>createHash('sha256').update(x).digest('hex');
const manifestUrl='https://releases.example.test/manifest.json';
const root=()=>fs.mkdtempSync(path.join(os.tmpdir(),'signal-lab-update-test-'));
function fakeFetcher(docs){return async(url)=>{const value=docs[url];return value==null?new Response('missing',{status:404}):new Response(value,{status:200})}}
test('semantic version comparison and safe file list',()=>{
 assert.equal(compareVersions('4.10.0','4.9.9'),1);assert.equal(compareVersions('4.4.0','4.4.0'),0);
 for(const name of ['.env','store.json','../../store.json','public/../../.env','/tmp/evil','C:\\Windows\\x','public/a.js/../../.env'])assert.equal(allowedFile(name),false,name);
 assert.equal(allowedFile('public/app.js'),true);assert.equal(allowedFile('server.mjs'),true);
});
test('all local runtime imports and Windows notifier are eligible without allowing user data',()=>{
 for(const source of ['server.mjs','engine.mjs']){
  const code=fs.readFileSync(new URL('../'+source,import.meta.url),'utf8');
  for(const [,name] of code.matchAll(/from\s+['"]\.\/([^'"]+)['"]/g))assert.equal(allowedFile(name),true,name);
 }
 for(const name of ['signal_pipeline.mjs','quality.mjs','windows_paper_notify.ps1','paper.mjs','decimal_grid.mjs',
  'venue_market_data.mjs','bingx_market.mjs','gateio_market.mjs','venue_service.mjs','public/venues.js','scripts/check-venue-market-data.mjs'])assert.equal(allowedFile(name),true,name);
 for(const name of ['orangex.mjs','orangex_paper_journal.mjs','scripts/diagnose-orangex-windows.mjs','durable_append_recovery.mjs'])assert.equal(allowedFile(name),false,'removed: '+name);
 for(const name of ['store.json','.env','recovery/store-corrupt.json','backups/store-any.json','arbitrary.ps1',
  'scripts/unreviewed-diagnostic.mjs'])assert.equal(allowedFile(name),false,name);
});
test('runtime-module update is verified, applied, and retains both current and backup trade records',async()=>{
 const dir=root();try{
  const records=JSON.stringify({paper:{open:[{key:'keep-open'}],closed:[{key:'keep-pnl',realizedPnLUSD:13.5}]}});
  fs.writeFileSync(path.join(dir,'store.json'),records);fs.mkdirSync(path.join(dir,'backups'));
  fs.writeFileSync(path.join(dir,'backups','store-existing.json'),records);
  const names=['paper.mjs','quality.mjs','signal_pipeline.mjs','copy_controls.mjs','windows_paper_notify.ps1','scripts/check-market-data.mjs'];
  const files=names.map(name=>({path:name,url:'./'+name,sha256:hex('verified '+name)}));
  const docs={[manifestUrl]:JSON.stringify({version:'6.0.0',files})};
  for(const name of names)docs['https://releases.example.test/'+name]='verified '+name;
  const staged=await stageUpdate({root:dir,manifestURL:manifestUrl,currentVersion:'5.8.0',fetcher:fakeFetcher(docs)});
  assert.equal(staged.fileCount,names.length);assert.equal(applyPending({root:dir,currentVersion:'5.8.0'}).state,'applied');
  for(const name of names)assert.equal(fs.readFileSync(path.join(dir,name),'utf8'),'verified '+name);
  assert.equal(fs.readFileSync(path.join(dir,'store.json'),'utf8'),records);
  assert.equal(fs.readFileSync(path.join(dir,'backups','store-existing.json'),'utf8'),records);
 }finally{fs.rmSync(dir,{recursive:true,force:true})}
});
test('updater rejects cross-origin download and non-HTTPS manifests',()=>{
 const item={path:'public/app.js',url:'https://other.example/app.js',sha256:hex('x')};
 assert.throws(()=>validateManifest({version:'4.5.0',files:[item]},manifestUrl),/HTTPS 출처/);
 assert.throws(()=>validateManifest({version:'4.5.0',files:[{...item,url:'./x'}]},'http://example.com/manifest.json'),/HTTPS/);
});
test('download verified update, preserve .env and journal, apply on next launch',async()=>{
 const dir=root();try{
  fs.mkdirSync(path.join(dir,'public'));fs.writeFileSync(path.join(dir,'public/app.js'),'old');
  fs.writeFileSync(path.join(dir,'store.json'),'{"journal":[{"id":"keep"}]}');fs.writeFileSync(path.join(dir,'.env'),'TELEGRAM_BOT_TOKEN=secret');
  const content='new code';const file={path:'public/app.js',url:'./releases/app.js',sha256:hex(content)};
  const docs={[manifestUrl]:JSON.stringify({version:'4.5.0',files:[file]}),'https://releases.example.test/releases/app.js':content};
  const staged=await stageUpdate({root:dir,manifestURL:manifestUrl,currentVersion:'4.4.0',fetcher:fakeFetcher(docs)});
  assert.equal(staged.state,'staged');assert.equal(pendingInfo(dir).version,'4.5.0');
  assert.equal(fs.readFileSync(path.join(dir,'public/app.js'),'utf8'),'old');
  const result=applyPending({root:dir,currentVersion:'4.4.0'});
  assert.equal(result.state,'applied');assert.equal(fs.readFileSync(path.join(dir,'public/app.js'),'utf8'),content);
  assert.equal(fs.readFileSync(path.join(dir,'store.json'),'utf8'),'{"journal":[{"id":"keep"}]}');
  assert.equal(fs.readFileSync(path.join(dir,'.env'),'utf8'),'TELEGRAM_BOT_TOKEN=secret');
 } finally{fs.rmSync(dir,{recursive:true,force:true})}
});
test('corrupted hash blocks update and does not change program',async()=>{
 const dir=root();try{
  fs.mkdirSync(path.join(dir,'public'));fs.writeFileSync(path.join(dir,'public/app.js'),'original');
  const doc={[manifestUrl]:JSON.stringify({version:'4.5.0',files:[{path:'public/app.js',url:'./bad.js',sha256:hex('expected')}]}),'https://releases.example.test/bad.js':'wrong'};
  await assert.rejects(stageUpdate({root:dir,manifestURL:manifestUrl,currentVersion:'4.4.0',fetcher:fakeFetcher(doc)}),/SHA-256/);
  assert.equal(pendingInfo(dir),null);assert.equal(fs.readFileSync(path.join(dir,'public/app.js'),'utf8'),'original');
 }finally{fs.rmSync(dir,{recursive:true,force:true})}
});
test('tampered pending file is not applied',async()=>{
 const dir=root();try{
  const content='original';const docs={[manifestUrl]:JSON.stringify({version:'4.5.0',files:[{path:'server.mjs',url:'./server.mjs',sha256:hex(content)}]}),'https://releases.example.test/server.mjs':content};
  await stageUpdate({root:dir,manifestURL:manifestUrl,currentVersion:'4.4.0',fetcher:fakeFetcher(docs)});
  fs.writeFileSync(path.join(dir,'.updates/pending/server.mjs'),'tampered');
  assert.throws(()=>applyPending({root:dir,currentVersion:'4.4.0'}),/무결성/);
 }finally{fs.rmSync(dir,{recursive:true,force:true})}
});
