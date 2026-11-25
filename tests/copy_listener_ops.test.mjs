// Ops alerts (user decisions 2026-11-24 17:34): real-account margin usage alert (real_margin_alert.mjs), copy listener
// liveness (copy_listener_health.mjs, /api/copy/heartbeat) and deploy/linux/copy_listener.py heartbeat / catch-up /
// self-restart against a fake Telethon (tests/fixtures/fake_telethon). No network, no orders, temp data folders only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {spawn,spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {RealMarginAlert,parseMarginLevels,envMarginLevels,marginUsageOf,marginFieldsOfBingxRow,REAL_MARGIN_NOTE,REAL_MARGIN_ALERT_FILE} from '../real_margin_alert.mjs';
import {CopyListenerHealth,listenerHeartbeatEndpoint,sanitizeHeartbeat,LISTENER_HEALTH_FILE} from '../copy_listener_health.mjs';
import {CopyExecutor,copyConfig} from '../copy_executor.mjs';
import {formatStatusReply} from '../account_alerts.mjs';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const tmp=()=>fs.mkdtempSync(path.join(os.tmpdir(),'sl-ops-'));
const TOKEN='t'.repeat(32);

// ---- Task 1: margin usage ---------------------------------------------------------------------------------------------
test('margin levels: parse, env, defaults, screen value wins and persists',()=>{
 assert.deepEqual(parseMarginLevels('95, 70,85'),[70,85,95]);
 assert.deepEqual(parseMarginLevels(''),[]);
 assert.deepEqual(parseMarginLevels('off'),[]);
 assert.throws(()=>parseMarginLevels('0,50'),/1~100/);
 assert.throws(()=>parseMarginLevels('10,20,30,40,50,60'),/5단계/);
 assert.deepEqual(envMarginLevels({REAL_MARGIN_ALERT_LEVELS:'60,80'}),[60,80]);
 assert.equal(envMarginLevels({REAL_MARGIN_ALERT_LEVELS:'abc'}),null);
 assert.equal(envMarginLevels({}),null);
 const dir=tmp();
 const a=new RealMarginAlert({directory:dir,env:{}});
 assert.deepEqual(a.levels(),[70,85,95]);assert.equal(a.status().levelsSource,'DEFAULT');
 const b=new RealMarginAlert({directory:dir,env:{REAL_MARGIN_ALERT_LEVELS:'50,90'}});
 assert.deepEqual(b.levels(),[50,90]);assert.equal(b.status().levelsSource,'ENV');
 b.configure({marginAlertLevels:'75, 90'});
 const c=new RealMarginAlert({directory:dir,env:{REAL_MARGIN_ALERT_LEVELS:'50,90'}});
 assert.deepEqual(c.levels(),[75,90]);assert.equal(c.status().levelsSource,'SCREEN');
 c.configure({marginAlertLevels:null});assert.deepEqual(c.levels(),[50,90]);
 assert.throws(()=>c.configure({marginAlertLevels:'200'}),e=>e.httpStatus===400);
});

test('margin usage: used margin ÷ equity from the BingX row, fallback equity − available',()=>{
 const f=marginFieldsOfBingxRow({asset:'USDT',equity:'1000',availableMargin:'250',usedMargin:'700',unrealizedProfit:'-12.5'});
 assert.deepEqual(f,{equity:1000,available:250,used:700,unrealized:-12.5});
 assert.equal(marginUsageOf(f).pct,70);assert.equal(marginUsageOf(f).source,'USED_MARGIN');
 assert.equal(marginUsageOf({equity:1000,available:400}).pct,60);
 assert.equal(marginUsageOf({equity:0,used:5}),null);
 assert.equal(marginUsageOf({equity:100}),null);
});

test('margin alert: one message per level, 10-point hysteresis, one recovery, jump sends the highest only',async()=>{
 const dir=tmp(),sent=[];let t=1e12;
 const make=()=>new RealMarginAlert({directory:dir,env:{},now:()=>t,send:async x=>{sent.push(x);return true}});
 let m=make();
 const at=async(pct,openCount=3)=>{t+=15000;return m.check({equity:1000,available:1000-pct*10,used:pct*10,unrealized:-4.2,openCount})};
 await at(50);assert.equal(sent.length,0);
 await at(71);assert.equal(sent.length,1);
 assert.match(sent[0],/증거금 사용률 71\.0% · 70% 넘음/);
 assert.match(sent[0],/순자산 \$1,000\.00 · 사용 가능 \$290\.00 · 사용 증거금 \$710\.00/);
 assert.match(sent[0],/미실현 손익 −\$4\.20 · 열린 포지션 3개/);
 assert.ok(sent[0].includes(REAL_MARGIN_NOTE));
 await at(75);await at(72);assert.equal(sent.length,1,'no repeat above the level');
 // A restart keeps the state: no resend.
 m=make();await at(74);assert.equal(sent.length,1,'restart does not resend');
 await at(65);assert.equal(sent.length,2,'falls below 70 after an alert: one recovery');
 assert.match(sent[1],/70% 아래로 내려옴/);assert.ok(sent[1].includes(REAL_MARGIN_NOTE));
 await at(64);await at(71);assert.equal(sent.length,2,'70 is not re-armed until under 60');
 await at(69);assert.equal(sent.length,2,'no second recovery without a new alert');
 await at(59);await at(70);assert.equal(sent.length,3,'re-armed below 60, alerts again');
 // Jump over 85 and 95 at once: one message for 95, both marked.
 await at(96);assert.equal(sent.length,4);assert.match(sent[3],/95% 넘음/);
 assert.deepEqual(m.status().alerted,[70,85,95]);
 await at(86);assert.equal(sent.length,4,'95 not re-armed at 86 (needs < 85)');
 await at(84);await at(96);assert.equal(sent.length,5,'95 re-armed under 85');
 await at(80);await at(86);assert.equal(sent.length,5,'85 re-armed only under 75');
 await at(74);await at(86);assert.equal(sent.length,6);assert.match(sent[5],/85% 넘음/);
 assert.ok(fs.existsSync(path.join(dir,REAL_MARGIN_ALERT_FILE)));
 assert.equal(m.status().current.openCount,3);
});

test('margin alert: a failed send is tried again, and the levels can be turned off',async()=>{
 let ok=false,n=0;const m=new RealMarginAlert({env:{},send:async()=>{n++;if(!ok)throw Error('offline');return true}});
 await m.check({equity:100,used:80});assert.deepEqual(m.status().alerted,[]);
 ok=true;await m.check({equity:100,used:80});assert.deepEqual(m.status().alerted,[70]);assert.equal(n,2);
 m.configure({marginAlertLevels:''});const r=await m.check({equity:100,used:99});assert.equal(r.reason,'OFF');assert.equal(n,2);
});

// Review 2026-11-24: checkRiskAndRoi runs every 15 s with no overlap guard and awaited this check BEFORE the daily-loss
// breaker and the trailing stop; a slow Telegram send let a second check send the same level again, and delayed both.
test('margin alert: overlapping checks send one message; refresh runs in the background and never throws',async()=>{
 let release,sent=0;const gate=new Promise(r=>{release=r});
 const m=new RealMarginAlert({env:{},send:async()=>{sent++;await gate;return true}});
 const a=m.check({equity:100,used:80}),b=m.check({equity:100,used:81});
 release();await Promise.all([a,b]);
 assert.equal(sent,1,'one message for 70 while the first send was still pending');
 assert.deepEqual(m.status().alerted,[70]);
 // refresh: one balance read at a time, errors stay inside.
 let reads=0,hold;const slow=new Promise(r=>{hold=r});
 const m2=new RealMarginAlert({env:{},send:async()=>true});
 const p1=m2.refresh(async()=>{reads++;await slow;return {equity:100,used:90}},{openCount:2});
 const p2=m2.refresh(async()=>{reads++;return {equity:100,used:90}});
 assert.equal(reads,1,'second refresh while the first runs does not read again');
 hold();const [r1]=await Promise.all([p1,p2]);
 assert.deepEqual(r1.sent,{kind:'ALERT',level:85});assert.equal(m2.status().current.openCount,2);
 assert.deepEqual(await m2.refresh(async()=>{throw Error('balance read failed')}),{sent:null,reason:'ERROR'});
 assert.deepEqual(await m2.refresh(async()=>null),{sent:null,reason:'NO_BALANCE'});
});

test('server: the margin alert is never awaited in the real-account safety loop',()=>{
 const src=fs.readFileSync(path.join(ROOT,'server.mjs'),'utf8');
 const loop=src.slice(src.indexOf('const checkRiskAndRoi=async()=>{'),src.indexOf('const checkDaily=async()=>{'));
 assert.ok(loop.length>100);
 assert.doesNotMatch(loop,/await\s+(?:realMarginAlert\.|readRealFunds\()/);
 assert.match(loop,/void realMarginAlert\.refresh\(/);
 assert.ok(loop.indexOf('realMarginAlert')<loop.indexOf('evaluateDailyLoss'));
});

test('/status shows the exchange margin usage line (alert only)',()=>{
 const text=formatStatusReply({equityUSD:1000,availableUSD:300,positions:[],copy:{enabled:true,armed:true},
  marginUsage:{levels:[70,85,95],current:{pct:71.25}}});
 assert.match(text,/증거금 사용률\(거래소\) 71\.3% · 경보 70·85·95% \(알림만\)/);
 assert.doesNotMatch(formatStatusReply({equityUSD:1,positions:[]}),/거래소\)/);
});

// ---- Task 2a: listener liveness ---------------------------------------------------------------------------------------
test('heartbeat endpoint: token, copy OFF ignored, body sanitized',async()=>{
 const h=new CopyListenerHealth({now:()=>1e12});
 assert.equal((await listenerHeartbeatEndpoint({token:'x',want:TOKEN,body:{},health:h,copyEnabled:true})).status,403);
 assert.equal((await listenerHeartbeatEndpoint({token:'short',want:'short',body:{},health:h,copyEnabled:true})).status,403);
 assert.deepEqual((await listenerHeartbeatEndpoint({token:TOKEN,want:TOKEN,body:{},health:h,copyEnabled:false})).body,{ok:true,ignored:'COPY_OFF'});
 assert.equal((await listenerHeartbeatEndpoint({token:TOKEN,want:TOKEN,body:[],health:h,copyEnabled:true})).status,400);
 const r=await listenerHeartbeatEndpoint({token:TOKEN,want:TOKEN,body:{version:'abc123<script>',connected:true,queues:{copy:2,pump:'x'}},health:h,copyEnabled:true});
 assert.deepEqual(r,{status:200,body:{ok:true,state:'OK'}});
 assert.equal(h.status().version,'abc123script');assert.deepEqual(h.status().queues,{copy:2,pump:null});
 assert.equal(sanitizeHeartbeat({lastCopyId:'7',connected:'yes'}).connected,null);
});

test('listener health: 5 min without heartbeat → one 끊김, recovery once, restart keeps the state',async()=>{
 const dir=tmp(),sent=[];let t=1e12;
 const make=()=>new CopyListenerHealth({directory:dir,now:()=>t,send:async x=>{sent.push(x);return true}});
 let h=make();
 await h.record({version:'v1',connected:true});
 t+=4*60000;await h.check();assert.equal(sent.length,0);assert.equal(h.status().state,'OK');
 t+=61000;await h.check();assert.equal(sent.length,1);assert.match(sent[0],/카피 수신 끊김 · 수신기 신호 없음 5분/);
 assert.equal(h.status().state,'DOWN');
 t+=60000;await h.check();assert.equal(sent.length,1,'once');
 // Server restart while down: no resend; the 5-minute clock restarts from boot.
 h=make();t+=10*60000;await h.check();assert.equal(sent.length,1,'restart does not resend');
 await h.record({version:'v2',connected:true});assert.equal(sent.length,2);assert.match(sent[1],/카피 수신 복구/);
 assert.equal(h.status().state,'OK');
 await h.record({version:'v2',connected:true});assert.equal(sent.length,2);
 assert.ok(fs.existsSync(path.join(dir,LISTENER_HEALTH_FILE)));
});

test('listener health: Telegram disconnected for 3 min → 끊김; reconnect → 복구; short blips are quiet',async()=>{
 const sent=[];let t=1e12;const h=new CopyListenerHealth({now:()=>t,send:async x=>{sent.push(x);return true}});
 await h.record({connected:true});
 t+=60000;await h.record({connected:false});t+=60000;await h.record({connected:false});
 t+=60000;await h.record({connected:true});assert.equal(sent.length,0,'2 minutes: quiet');
 t+=60000;await h.record({connected:false});
 for(let i=0;i<3;i++){t+=60000;await h.record({connected:false})}
 assert.equal(sent.length,1);assert.match(sent[0],/텔레그램 연결 끊김 3분/);
 t+=60000;await h.record({connected:false});assert.equal(sent.length,1);
 t+=60000;await h.record({connected:true});assert.equal(sent.length,2);assert.match(sent[1],/카피 수신 복구/);
});

test('listener health: an old heartbeat from before a server restart does not alert at boot; failed send retried',async()=>{
 const dir=tmp(),sent=[];let t=1e12,fail=true;
 const send=async x=>{if(fail)throw Error('offline');sent.push(x);return true};
 let h=new CopyListenerHealth({directory:dir,now:()=>t,send});
 await h.record({connected:true});
 t+=20*60000;h=new CopyListenerHealth({directory:dir,now:()=>t,send});
 await h.check();assert.equal(h.status().state,'WAITING','boot restarts the clock: waiting, not down');
 t+=5*60000;await h.check();assert.equal(h.status().state,'DOWN');assert.equal(sent.length,0);
 fail=false;t+=30000;await h.check();assert.equal(sent.length,1,'sent on the next check');
 // A recovery after a down notice that never went out is not announced.
 const quiet=new CopyListenerHealth({now:()=>t,send:async()=>{throw Error('x')}});
 await quiet.record({connected:true});
 t+=6*60000;await quiet.check();assert.equal(quiet.status().state,'DOWN');const s2=[];quiet.send=async x=>{s2.push(x);return true};
 await quiet.record({connected:true});assert.equal(s2.length,0);assert.equal(quiet.status().state,'OK');
});

// Review 2026-11-24: COPY is on with the testnet signal mode, also where no listener runs (Windows, no copy.sh) and right
// after this update while the old listener (no heartbeat) still runs. No heartbeat ever seen = waiting, not "끊김".
test('listener health: no "끊김" before the first heartbeat ever (no listener, or the old one without heartbeats)',async()=>{
 const dir=tmp(),sent=[];let t=1e12;
 let h=new CopyListenerHealth({directory:dir,now:()=>t,send:async x=>{sent.push(x);return true}});
 t+=30*60000;await h.check();assert.equal(sent.length,0);assert.equal(h.status().state,'WAITING');
 h=new CopyListenerHealth({directory:dir,now:()=>t,send:async x=>{sent.push(x);return true}});
 t+=30*60000;await h.check();assert.equal(sent.length,0,'not after a server restart either');
 await h.record({connected:true});t+=6*60000;await h.check();
 assert.equal(sent.length,1,'once a heartbeat was seen, silence alerts');assert.match(sent[0],/카피 수신 끊김/);
});

// ---- Dedupe on /api/copy/message (copyTrader.handle) ------------------------------------------------------------------
test('copy dedupe: the same message id sent twice at once (catch-up + live/retry) is handled once',async()=>{
 const OPEN='📌 포지션 진입\n━━━━━━━━━━━━━━━━\n🪙 TNSRUSDT  🔴 Short  ×5\n━━━━━━━━━━━━━━━━\n진입가　0.05296 USDT\n현재가　0.05100 USDT\n수량　　880　마진 9.01 USDT\n손익　　🟢 +1.72 USDT';
 let size=0,orders=0;
 const client={leverage:async()=>({maxLongLeverage:20}),setMarginType:async()=>({}),setLeverage:async()=>({}),
  positions:async()=>size>0?[{symbol:'TNSR-USDT',positionAmt:String(-size),avgPrice:'0.051',markPrice:'0.051',unrealizedProfit:'0'}]:[],
  placeOrder:async p=>{if(p.type==='MARKET'){orders++;size+=Number(p.quantity)}return {order:{orderId:String(orders),avgPrice:'0.051'}}},cancelOrder:async()=>({})};
 const contract={symbol:'TNSRUSDT',venueSymbol:'TNSR-USDT',tickSize:'0.00001',quantityStep:'1',minQuantityBase:'1',minNotionalUSDT:2,tradable:true};
 const dir=tmp();
 const ex=new CopyExecutor({config:copyConfig({COPY_SIZING:'FIRST_1USD'},'TESTNET'),client,contractOf:async()=>contract,balance:async()=>({equity:400,available:300}),directory:dir,now:()=>1e12});
 const [a,b]=await Promise.all([ex.handle({id:41,date:1e12,text:OPEN}),ex.handle({id:41,date:1e12,text:OPEN})]);
 assert.equal(a.ok,true);assert.equal(b.duplicate,true);assert.equal(orders,1);
 // After a server restart (the seen list is on disk) a late resend of the same id is still a duplicate.
 const ex2=new CopyExecutor({config:copyConfig({COPY_SIZING:'FIRST_1USD'},'TESTNET'),client,contractOf:async()=>contract,balance:async()=>({equity:400,available:300}),directory:dir,now:()=>1e12});
 assert.equal((await ex2.handle({id:'41',date:1e12,text:OPEN})).duplicate,true,'string and number ids are the same key');
 assert.equal(orders,1);
});

// ---- Task 2a/2b: the Python listener against a fake Telethon ----------------------------------------------------------
const PY=process.platform==='win32'?null:(()=>{const r=spawnSync('python3',['--version'],{encoding:'utf8'});return r.status===0?'python3':null})();
const LISTENER=path.join(ROOT,'deploy/linux/copy_listener.py');

if(PY){
test('copy_listener.py compiles',()=>{
 const r=spawnSync(PY,['-c','import sys,py_compile;py_compile.compile(sys.argv[1],cfile=sys.argv[2],doraise=True)',LISTENER,path.join(tmp(),'x.pyc')],{encoding:'utf8'});
 assert.equal(r.status,0,r.stderr);
});

function fakeServer({heartbeatHang=false}={}){
 const got={copy:[],beats:[],pump:[]};
 const server=http.createServer((req,res)=>{
  let raw='';req.on('data',d=>{raw+=d});req.on('end',()=>{
   if(req.headers['x-copy-token']!==TOKEN){res.writeHead(403);return res.end('{}')}
   const body=raw?JSON.parse(raw):{};
   if(req.url==='/api/copy/heartbeat'){got.beats.push(body);if(heartbeatHang)return;res.writeHead(200,{'Content-Type':'application/json'});return res.end('{"ok":true}')}
   if(req.url==='/api/copy/message'){got.copy.push(body);res.writeHead(200,{'Content-Type':'application/json'});return res.end('{"ok":true}')}
   if(req.url==='/api/pump-alert'){got.pump.push(body);res.writeHead(200);return res.end('{"ok":true}')}
   res.writeHead(404);res.end('{}');
  });
 });
 return new Promise(r=>server.listen(0,'127.0.0.1',()=>r({server,got,port:server.address().port})));
}
function runListener({script,port,dataDir,scriptPath=LISTENER,env={}}){
 const sp=path.join(dataDir,'fake-script.json');fs.writeFileSync(sp,JSON.stringify(script));
 const child=spawn(PY,[scriptPath],{stdio:['pipe','pipe','pipe'],env:{PATH:process.env.PATH,PYTHONDONTWRITEBYTECODE:'1',
  PYTHONPATH:path.join(ROOT,'tests/fixtures/fake_telethon'),SIGNAL_LAB_DATA_DIR:dataDir,TELEGRAM_API_ID:'1',TELEGRAM_API_HASH:'h',
  COPY_CHANNEL_ID:'-100123',COPY_LISTENER_TOKEN:TOKEN,SIGNAL_LAB_PORT:String(port),PUMP_ALERT_CHATS:'',FAKE_TG_SCRIPT:sp,
  COPY_HEARTBEAT_SEC:'1',COPY_SELF_CHECK_SEC:'1',...env}});
 let out='';child.stdout.on('data',d=>{out+=d});child.stderr.on('data',d=>{out+=d});
 const exited=new Promise(r=>child.on('exit',code=>r(code)));
 return {child,exited,log:()=>out};
}
const until=async(fn,ms=8000)=>{const end=Date.now()+ms;while(Date.now()<end){if(fn())return true;await new Promise(r=>setTimeout(r,50))}return false};

test('listener: start catch-up forwards only recent missed messages in id order, live ones after, each id once; heartbeat fields',{timeout:30000},async()=>{
 const {server,got,port}=await fakeServer(),dataDir=tmp();
 fs.writeFileSync(path.join(dataDir,'copy-listener-state.json'),JSON.stringify({lastId:10}));
 const L=runListener({port,dataDir,script:{
  history:[{id:9,age:5,text:'already forwarded'},{id:11,age:30,text:'missed 11'},{id:12,age:10,text:'missed 12'},{id:13,age:3,text:'missed 13'}],
  duringCatchup:[{id:13,text:'missed 13'},{id:14,text:'live 14'}],
  live:[{delay:0.3,id:15,text:'live 15'}]}});
 try{
  assert.ok(await until(()=>got.copy.length>=5&&got.beats.length>=2),L.log());
  assert.deepEqual(got.copy.map(x=>x.id),[11,12,13,14,15]);
  assert.match(L.log(),/"min_id": 10/);
  assert.match(L.log(),/놓친 메시지 2건 전달/);
  const beat=got.beats.at(-1);
  assert.equal(beat.connected,true);assert.match(beat.version,/^[0-9a-f]{12}$/);
  assert.equal(beat.lastCopyId,15);assert.ok(beat.lastCopyAt>0&&beat.lastCopyDeliveredAt>0);
  assert.deepEqual(beat.queues,{copy:0,pump:0});assert.equal(beat.catchup.forwarded,2,"13 also came live");
  assert.ok(await until(()=>JSON.parse(fs.readFileSync(path.join(dataDir,'copy-listener-state.json'),'utf8')).lastId===15));
 }finally{L.child.kill('SIGTERM');await L.exited;server.close()}
});

test('listener: catch-up skips cards older than the age limit; no state file = age limit only',{timeout:30000},async()=>{
 const {server,got,port}=await fakeServer(),dataDir=tmp();
 const L=runListener({port,dataDir,script:{history:[{id:5,age:400,text:'stale'},{id:6,age:20,text:'recent'}],live:[]}});
 try{
  assert.ok(await until(()=>got.copy.length>=1&&got.beats.length>=1),L.log());
  await new Promise(r=>setTimeout(r,500));
  assert.deepEqual(got.copy.map(x=>x.id),[6]);
  assert.match(L.log(),/"min_id": 0/);
 }finally{L.child.kill('SIGTERM');await L.exited;server.close()}
});

// Review 2026-11-24: a catch-up that drops the OLDEST missed messages (age limit or the 20 cap) and sends the rest makes
// the copy executor see them without what came before: a MONITOR_START cut off turns its re-announced positions into
// new entries / adds (an open copy was tripled in a repro), a close cut off before a re-entry turns it into an add.
// Then none of the missed messages go out (as before the catch-up existed); live ones still do.
const STATE=(lastId,channel=-100123)=>JSON.stringify({channel,lastId});
test('listener: a missed message older than the age limit means none of the missed ones are sent (no gap before them)',{timeout:30000},async()=>{
 const {server,got,port}=await fakeServer(),dataDir=tmp();
 fs.writeFileSync(path.join(dataDir,'copy-listener-state.json'),STATE(10));
 const L=runListener({port,dataDir,script:{
  history:[{id:11,age:300,text:'old close'},{id:12,age:30,text:'re-entry'},{id:13,age:5,text:'add'}],
  duringCatchup:[{id:14,text:'live 14'}],live:[{delay:0.3,id:15,text:'live 15'}]}});
 try{
  assert.ok(await until(()=>got.copy.length>=2&&got.beats.some(b=>b.catchup)),L.log());
  await new Promise(r=>setTimeout(r,500));
  assert.deepEqual(got.copy.map(x=>x.id),[14,15]);
  assert.match(L.log(),/다시 보내지 않습니다/);
  const beat=got.beats.filter(b=>b.catchup).at(-1);
  assert.equal(beat.catchup.forwarded,0);assert.equal(beat.catchup.error,'GAP_OLD');assert.equal(beat.catchup.skipped,2);
 }finally{L.child.kill('SIGTERM');await L.exited;server.close()}
});

test('listener: more missed messages than the cap (a monitor restart re-announcing positions) are not sent in part',{timeout:30000},async()=>{
 const {server,got,port}=await fakeServer(),dataDir=tmp();
 fs.writeFileSync(path.join(dataDir,'copy-listener-state.json'),STATE(10));
 const history=[{id:11,age:20,text:'Gate.io 모니터 시작'},...Array.from({length:21},(_,i)=>({id:12+i,age:15-i*0.5,text:`snapshot ${12+i}`}))];
 const L=runListener({port,dataDir,script:{history,live:[{delay:0.3,id:40,text:'live 40'}]}});
 try{
  assert.ok(await until(()=>got.copy.length>=1&&got.beats.some(b=>b.catchup)),L.log());
  await new Promise(r=>setTimeout(r,500));
  assert.deepEqual(got.copy.map(x=>x.id),[40],'never the snapshot cards without their MONITOR_START');
  assert.equal(got.beats.filter(b=>b.catchup).at(-1).catchup.error,'GAP_LIMIT');
 }finally{L.child.kill('SIGTERM');await L.exited;server.close()}
});

test('listener: an old post without text is not a gap; a fetch that fails midway sends nothing it read',{timeout:40000},async()=>{
 {const {server,got,port}=await fakeServer(),dataDir=tmp();
  fs.writeFileSync(path.join(dataDir,'copy-listener-state.json'),STATE(10));
  const L=runListener({port,dataDir,script:{history:[{id:11,age:300,text:''},{id:12,age:10,text:'recent'}],live:[]}});
  try{
   assert.ok(await until(()=>got.copy.length>=1),L.log());
   assert.deepEqual(got.copy.map(x=>x.id),[12]);
  }finally{L.child.kill('SIGTERM');await L.exited;server.close()}}
 {const {server,got,port}=await fakeServer(),dataDir=tmp();
  fs.writeFileSync(path.join(dataDir,'copy-listener-state.json'),STATE(10));
  const L=runListener({port,dataDir,script:{historyFailAfter:1,history:[{id:11,age:30,text:'a'},{id:12,age:10,text:'b'}],live:[{delay:0.3,id:13,text:'live 13'}]}});
  try{
   assert.ok(await until(()=>got.copy.length>=1&&got.beats.some(b=>b.catchup)),L.log());
   await new Promise(r=>setTimeout(r,500));
   assert.deepEqual(got.copy.map(x=>x.id),[13],'12 was read before the failure but 11 was not: not sent');
   assert.equal(got.beats.filter(b=>b.catchup).at(-1).catchup.error,'ConnectionError');
  }finally{L.child.kill('SIGTERM');await L.exited;server.close()}}
});

test('listener: the saved last id belongs to one channel; another channel\'s id or a non-id value is ignored',{timeout:30000},async()=>{
 const {server,got,port}=await fakeServer(),dataDir=tmp(),file=path.join(dataDir,'copy-listener-state.json');
 fs.writeFileSync(file,STATE(5000,-100999));
 const L=runListener({port,dataDir,script:{history:[{id:7,age:10,text:'new channel'}],live:[]}});
 try{
  assert.ok(await until(()=>got.copy.length>=1),L.log());
  assert.match(L.log(),/"min_id": 0/);
  assert.ok(await until(()=>{try{const s=JSON.parse(fs.readFileSync(file,'utf8'));return s.lastId===7&&s.channel===-100123}catch{return false}}),'saved for this channel, not stuck behind the other one');
 }finally{L.child.kill('SIGTERM');await L.exited;server.close()}
 // Not a Telegram message id (corrupt file): ignored the same way.
 const s2=await fakeServer(),d2=tmp();
 fs.writeFileSync(path.join(d2,'copy-listener-state.json'),JSON.stringify({lastId:2**40}));
 const L2=runListener({port:s2.port,dataDir:d2,script:{history:[{id:8,age:10,text:'x'}],live:[]}});
 try{assert.ok(await until(()=>s2.got.copy.length>=1),L2.log());assert.match(L2.log(),/"min_id": 0/)}
 finally{L2.child.kill('SIGTERM');await L2.exited;s2.server.close()}
});

test('listener: a hanging heartbeat never holds up copy delivery; disconnected state is reported',{timeout:30000},async()=>{
 const {server,got,port}=await fakeServer({heartbeatHang:true}),dataDir=tmp();
 const L=runListener({port,dataDir,env:{COPY_CATCHUP_MAX_AGE_SEC:'0'},script:{disconnectedAfter:0,live:[{delay:1.5,id:21,text:'a'},{delay:0.2,id:22,text:'b'}]}});
 try{
  assert.ok(await until(()=>got.copy.length>=2),L.log());
  assert.deepEqual(got.copy.map(x=>x.id),[21,22]);
  assert.equal(got.beats[0].connected,false);
 }finally{L.child.kill('SIGTERM');await L.exited;server.close()}
});

test('listener: exits with code 0 after its file changed (systemd Restart=always restarts it); a broken file is not restarted into',{timeout:40000},async()=>{
 const {server,got,port}=await fakeServer(),dataDir=tmp();
 const copyPath=path.join(dataDir,'copy_listener.py');fs.copyFileSync(LISTENER,copyPath);
 const L=runListener({port,dataDir,scriptPath:copyPath,env:{COPY_CATCHUP_MAX_AGE_SEC:'0'},script:{live:[{delay:0.2,id:31,text:'x'}]}});
 try{
  assert.ok(await until(()=>got.copy.length>=1&&got.beats.length>=1),L.log());
  fs.appendFileSync(copyPath,'\nthis is not python(\n');
  assert.ok(await until(()=>/문법 검사를 통과하지 못해/.test(L.log())),L.log());
  assert.equal(L.child.exitCode,null,'still running on the old code');
  fs.writeFileSync(copyPath,fs.readFileSync(LISTENER,'utf8')+'\n# updated\n');
  const code=await Promise.race([L.exited,new Promise(r=>setTimeout(()=>r('timeout'),10000))]);
  assert.equal(code,0,L.log());
  assert.match(L.log(),/새 버전 감지 \([0-9a-f]{12} → [0-9a-f]{12}\)/);
 }finally{if(L.child.exitCode===null)L.child.kill('SIGTERM');await L.exited;server.close()}
});

test('copy_listener.py: live close cards dequeue ahead of entries while preserve_order keeps sequence',()=>{
 const pyCode=`
import asyncio, importlib.util, sys
sys.path.insert(0, ${JSON.stringify(path.join(ROOT,'tests/fixtures/fake_telethon'))})
spec = importlib.util.spec_from_file_location('copy_listener', ${JSON.stringify(LISTENER)})
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
mod.delivery_queue = asyncio.PriorityQueue()
mod.enqueue_copy({'id': 1, 'text': '📌 포지션 진입 BTCUSDT'}, preserve_order=False)
mod.enqueue_copy({'id': 2, 'text': '📌 포지션 진입 ETHUSDT'}, preserve_order=False)
mod.enqueue_copy({'id': 3, 'text': '📌 포지션 청산 BTCUSDT'}, preserve_order=False)
out = [mod.delivery_queue.get_nowait()[2]['id'] for _ in range(3)]
assert out == [3, 1, 2], f'unexpected live priority order: {out}'
mod.enqueue_copy({'id': 10, 'text': '📌 포지션 진입 SOLUSDT'}, preserve_order=True)
mod.enqueue_copy({'id': 11, 'text': '📌 포지션 청산 SOLUSDT'}, preserve_order=True)
out2 = [mod.delivery_queue.get_nowait()[2]['id'] for _ in range(2)]
assert out2 == [10, 11], f'unexpected catchup order: {out2}'
`;
 const r=spawnSync(PY,['-c',pyCode],{encoding:'utf8',env:{PATH:process.env.PATH,PYTHONDONTWRITEBYTECODE:'1',TELEGRAM_API_ID:'1',TELEGRAM_API_HASH:'h',COPY_CHANNEL_ID:'-100123',COPY_LISTENER_TOKEN:TOKEN}});
 assert.equal(r.status,0,r.stderr||r.stdout);
});
}

test('copy.sh unit restarts on a clean exit (Restart=always)',()=>{
 const sh=fs.readFileSync(path.join(ROOT,'deploy/linux/copy.sh'),'utf8');
 assert.match(sh,/\r?\nRestart=always\r?\n/);
});
