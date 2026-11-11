import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import net from 'node:net';
import {once} from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {trackChild,stopChild} from './child_process.mjs';
import {fetchLocal} from './http_request.mjs';
// Isolated server sandbox shared by the pipeline integration test files.
const project=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..','..');
export const nap=ms=>new Promise(resolve=>setTimeout(resolve,ms));
export async function until(action,predicate,{timeout=7000,label='expected server state'}={}){
 const deadline=Date.now()+timeout;let last;
 while(Date.now()<deadline){try{last=await action();if(predicate(last))return last}catch{}await nap(60)}
 assert.fail(label+': '+JSON.stringify(last));
}
export async function sandbox(config){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'signal-pipeline-'));
 const app=path.join(root,'app'),data=path.join(root,'isolated-records'),control=path.join(root,'control.json'),requests=path.join(root,'requests.jsonl');
 // Copy application code only: never adopt a user's .env, store.json or update staging.
 await fs.cp(project,app,{recursive:true,filter:source=>{
  const relative=path.relative(project,source);
  if(!relative)return true;
  const first=relative.split(path.sep)[0];
  if(first.startsWith('.'))return false;
  if(['public','tests'].includes(first))return !relative.split(path.sep).some(part=>part.startsWith('.'));
  return relative==='package.json'||(!relative.includes(path.sep)&&relative.endsWith('.mjs'));
 }});
 let cfg={marketNow:Date.now(),...config},child,logs='';
 const write=async patch=>{cfg={...cfg,...patch};await fs.writeFile(control+'.tmp',JSON.stringify(cfg));await fs.rename(control+'.tmp',control)};
 await write({});
 await fs.mkdir(data,{recursive:true});
 // OPEN/CLOSE history is still recorded when delivery is disabled. Never launch
 // a real PowerShell notification on a Windows test runner.
 await fs.writeFile(path.join(data,'store.json'),JSON.stringify({paperNotify:{enabled:false,history:[]}}));
 const socket=net.createServer();socket.listen(0,'127.0.0.1');await once(socket,'listening');const port=socket.address().port;await new Promise(r=>socket.close(r));
 const base='http://127.0.0.1:'+port;
 const get=async endpoint=>{const response=await fetchLocal(base+endpoint);assert.equal(response.status,200,endpoint);return response.json()};
 async function start(){
  child=trackChild(spawn(process.execPath,['--import','./tests/mock_pipeline.mjs','server.mjs'],{cwd:app,env:{PATH:process.env.PATH,
   PORT:String(port),HOST:'127.0.0.1',SIGNAL_LAB_DATA_DIR:data,SIGNAL_LAB_TEST_CONTROL:control,SIGNAL_LAB_TEST_REQUESTS:requests,
   AUTO_UPDATE:'false',PAPER_VENUE_REFRESH_MS:'1000',VENUE_ONLY_START_MS:'300',VENUE_ONLY_INTERVAL_MS:'1000',VENUE_ONLY_REFERENCE:cfg.venueOnlyReference??'AKEUSDT',SIGNAL_PATTERNS:cfg.signalPatterns??'ALL',TELEGRAM_NEWS_ALERTS:'false',TELEGRAM_BOT_TOKEN:'',TELEGRAM_CHAT_ID:'',TWELVE_DATA_API_KEY:'',...(cfg.env||{}),
   ...(process.env.SystemRoot?{SystemRoot:process.env.SystemRoot}:{})},stdio:['ignore','pipe','pipe']}));
  child.stdout.on('data',chunk=>{logs+=String(chunk)});child.stderr.on('data',chunk=>{logs+=String(chunk)});
  await until(()=>get('/api/status'),s=>s.activeCount===(cfg.binanceOffline?0:Object.keys(cfg.scenarios).filter(symbol=>!cfg.unlisted?.includes(symbol)).length),{label:'market discovery '+logs});
  if(cfg.emit)await until(()=>get('/api/status'),s=>s.ws==='connected');
 }
 async function stop(){
  if(child)await stopChild(child);
 }
 return {get,write,start,stop,data,requests,base,logs:()=>logs,async close(){await stop();await fs.rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:100})}};
}

