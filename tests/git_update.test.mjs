import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {gitUpdateAvailable,gitCheck,gitApply,formatUpdateCompletedNotice,checkPostUpdateNotice,LAST_VERSION_FILE} from '../git_update.mjs';

// A fake git: HEAD / origin/main shas and a log; records every call.
function fakeGit({head='aaa1111',origin='bbb2222',log='bbb2222 Fix stop order\nccc3333 New screen',
 packages={aaa1111:{version:'5.8.0',displayVersion:'2026-11-18_ver3'},bbb2222:{version:'5.8.0',displayVersion:'2026-11-18 11:00 KST'}}}={}){
 const calls=[];let h=head;
 const git=async(root,args)=>{calls.push(args.join(' '));
  if(args[0]==='fetch')return '';
  if(args[0]==='rev-parse')return args.at(-1)==='HEAD'?h:origin;
  if(args[0]==='show'){const p=packages[args[1].split(':')[0]];if(!p)throw Error('manifest missing');return JSON.stringify(p)}
  if(args[0]==='log')return h===origin?'':log;
  if(args[0]==='merge'){h=origin;return ''}
  if(args[0]==='reset'){h=args.at(-1);return ''}
  throw Error('unexpected git '+args.join(' '))};
 return {git,calls,head:()=>h};
}

test('only a git checkout under systemd offers the one-tap update',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'gu-'));
 assert.equal(gitUpdateAvailable(dir,{INVOCATION_ID:'x'}),false,'not a git checkout');
 fs.mkdirSync(path.join(dir,'.git'));
 assert.equal(gitUpdateAvailable(dir,{}),false,'a PC run (no systemd) keeps its own update path');
 assert.equal(gitUpdateAvailable(dir,{INVOCATION_ID:'x'}),true);
});

test('check lists the new commits; current when nothing new',async()=>{
 const f=fakeGit();const c=await gitCheck('/app',{git:f.git});
 assert.equal(c.state,'available');assert.deepEqual(c.changes.map(x=>x.subject),['Fix stop order','New screen']);
 assert.equal(c.currentDisplayVersion,'2026-11-18_ver3');
 assert.equal(c.latestDisplayVersion,'2026-11-18 11:00 KST');
 const current=await gitCheck('/app',{git:fakeGit({origin:'aaa1111'}).git});
 assert.equal(current.state,'current');assert.equal(current.latestDisplayVersion,current.currentDisplayVersion);
 assert.equal((await gitCheck('/app',{git:fakeGit({log:''}).git})).state,'diverged','server ahead or diverged: no automatic merge');
 const legacy=await gitCheck('/app',{git:fakeGit({packages:{aaa1111:{version:'5.8.0'}}}).git});
 assert.equal(legacy.currentDisplayVersion,'v5.8.0');assert.equal(legacy.latestDisplayVersion,null);
});

test('apply fast-forwards only, and rolls back when the new server.mjs does not parse',async()=>{
 const ok=fakeGit();const r=await gitApply('/app',{git:ok.git,checkSyntax:async()=>{}});
 assert.equal(r.state,'applied');assert.equal(r.from,'aaa1111');assert.equal(r.to,'bbb2222');
 assert.equal(r.fromDisplayVersion,'2026-11-18_ver3');assert.equal(r.toDisplayVersion,'2026-11-18 11:00 KST');
 assert.ok(ok.calls.includes('merge --ff-only origin/main'));assert.ok(!ok.calls.some(c=>c.startsWith('pull')||c.includes('--force')));
 const bad=fakeGit();const b=await gitApply('/app',{git:bad.git,checkSyntax:async()=>{throw Error('SyntaxError')}});
 assert.equal(b.ok,false);assert.equal(b.state,'rolled-back');assert.equal(bad.head(),'aaa1111');
 const cur=await gitApply('/app',{git:fakeGit({origin:'aaa1111'}).git,checkSyntax:async()=>{}});
 assert.equal(cur.ok,true);assert.equal(cur.state,'current');
});

test('the whole tree is checked: every module parses and every relative import exists',async()=>{
 const {checkTree}=await import('../git_update.mjs');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'gt-'));
 const imp=f=>'import {x} f'+'rom '+"'./"+f+"';";
 fs.writeFileSync(path.join(dir,'a.mjs'),imp('b.mjs')+'\nexport const y=x;');
 fs.writeFileSync(path.join(dir,'b.mjs'),'export const x=1;');
 const checked=[];const nodeCheck=async f=>{checked.push(path.basename(f))};
 assert.equal(await checkTree(dir,{nodeCheck}),2);assert.deepEqual(checked.sort(),['a.mjs','b.mjs']);
 fs.writeFileSync(path.join(dir,'c.mjs'),imp('missing.mjs'));
 await assert.rejects(checkTree(dir,{nodeCheck}),/missing\.mjs 없음/);
});

test('link check finds a missing named export without running the module',async()=>{
 const {linkCheck}=await import('../link_check.mjs').catch(()=>({}));
 if(!linkCheck)return;
 const {execFileSync}=await import('node:child_process');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'lc-'));
 fs.writeFileSync(path.join(dir,'a.mjs'),'import {nope} f'+"rom './b.mjs';\nthrow Error('must not run');");
 fs.writeFileSync(path.join(dir,'b.mjs'),'export const x=1;');
 const run=f=>{try{return execFileSync(process.execPath,['--no-warnings','--experimental-vm-modules',new URL('../link_check.mjs',import.meta.url).pathname,f],{encoding:'utf8',stdio:'pipe'})}catch(e){return 'FAIL '+e.stderr}};
 assert.match(run(path.join(dir,'a.mjs')),/FAIL LINK_FAIL .*nope/);
 assert.match(run(new URL('../server.mjs',import.meta.url).pathname),/LINK_OK/);
});

test('formatUpdateCompletedNotice formats auto, manual, and restart version notices cleanly',()=>{
 const autoMsg=formatUpdateCompletedNotice({
  version:'5.8.0',
  displayVersion:'2026-11-22 23:25 KST',
  fromDisplayVersion:'2026-11-22 23:16 KST',
  to:'abc1234',
  source:'auto',
  changes:['텔레그램 업데이트 완료 알림 추가','테스트넷 자금 한도 100% 상향'],
  restored:['실계좌 카피 ●','테스트넷 단타 ●'],
 });
 assert.match(autoMsg,/✅ \[Signal Lab 자동 업데이트 완료\] v5\.8\.0 \(2026-11-22 23:25 KST\)/);
 assert.match(autoMsg,/버전: 2026-11-22 23:16 KST → 2026-11-22 23:25 KST \(abc1234\)/);
 assert.match(autoMsg,/· 텔레그램 업데이트 완료 알림 추가/);
 assert.match(autoMsg,/자동 복원: 실계좌 카피 ● · 테스트넷 단타 ●/);

 const manualMsg=formatUpdateCompletedNotice({
  version:'5.8.0',
  displayVersion:'2026-11-22 23:25 KST',
  source:'manual',
 });
 assert.match(manualMsg,/✅ \[Signal Lab 수동 업데이트 완료\]/);
 assert.match(manualMsg,/새 버전으로 서버가 정상 시작되었습니다\./);
});

test('checkPostUpdateNotice stays silent on fresh boot and same-version restart, notifies on update marker or version change',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'up-notice-'));
 const v1={version:'5.8.0',displayVersion:'2026-11-22 23:16 KST'};
 const v2={version:'5.8.0',displayVersion:'2026-11-22 23:25 KST'};
 const v3={version:'5.8.0',displayVersion:'2026-11-22 23:40 KST'};
 const t0=1795350000000;

 // 1) Fresh install / clean sandbox -> silent, records current version
 assert.equal(checkPostUpdateNotice({dir,appVersion:v1,now:t0}),null);
 assert.ok(fs.existsSync(path.join(dir,LAST_VERSION_FILE)));

 // 2) Same-version restart -> silent
 assert.equal(checkPostUpdateNotice({dir,appVersion:v1,now:t0+60000}),null);

 // 3) External restart with new version (e.g. Windows supervisor or manual git pull) -> notifies once
 const restartNotice=checkPostUpdateNotice({dir,appVersion:v2,now:t0+120000});
 assert.ok(restartNotice);
 assert.match(restartNotice,/✅ \[Signal Lab 버전 업데이트 완료\] v5\.8\.0 \(2026-11-22 23:25 KST\)/);
 assert.match(restartNotice,/버전: 2026-11-22 23:16 KST → 2026-11-22 23:25 KST/);
 assert.equal(checkPostUpdateNotice({dir,appVersion:v2,now:t0+180000}),null,'does not repeat on next restart');

 // 4) One-tap / auto update with fresh rearm marker -> includes source, commit list, and restored services
 const markerNotice=checkPostUpdateNotice({
  dir,
  appVersion:v3,
  marker:{at:t0+230000,from:'aaa1111',to:'bbb2222',fromDisplayVersion:v2.displayVersion,toDisplayVersion:v3.displayVersion,source:'manual',changes:['UI 개선']},
  restored:['신호 전략 ●','테스트넷 단타 ●'],
  now:t0+240000,
 });
 assert.ok(markerNotice);
 assert.match(markerNotice,/✅ \[Signal Lab 수동 업데이트 완료\] v5\.8\.0 \(2026-11-22 23:40 KST\)/);
 assert.match(markerNotice,/버전: 2026-11-22 23:25 KST → 2026-11-22 23:40 KST \(bbb2222\)/);
 assert.match(markerNotice,/· UI 개선/);
 assert.match(markerNotice,/자동 복원: 신호 전략 ● · 테스트넷 단타 ●/);
});

test('auto-update streams live progress via SSE and locks manual update button against overlapping clicks',()=>{
 const server=fs.readFileSync(new URL('../server.mjs',import.meta.url),'utf8');
 const appJs=fs.readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
 assert.match(server,/function emitUpdateProgress\(\)\{\s*try\{send\('update-progress',\{\.\.\.updateJob,\.\.\.appVersion,bootId:SERVER_BOOT_ID\}\)\}catch\{\}\s*\}/);
 assert.match(server,/if\(pathname==='\/api\/update\/git'&&req\.method==='GET'\)\{if\(!GIT_UPDATE\)return response\(res,404,\{error:'GIT_UPDATE_UNAVAILABLE'\}\);if\(updateJob\.active\)return response\(res,200,\{state:'updating',\.\.\.updateJob,\.\.\.appVersion,bootId:SERVER_BOOT_ID\}\)/);
 assert.match(server,/updating:updateJob\.active===true,updateJob:updateJob\.active\?\{\.\.\.updateJob\}:null/);
 assert.match(appJs,/es\.addEventListener\('update-progress'/);
 assert.match(appJs,/async function trackRunningUpdate\(/);
 assert.match(appJs,/setUpdateButtonBusy\(true/);
 assert.match(appJs,/if\(check\.state==='updating'\)\{await trackRunningUpdate\(check\);return\}/);
 assert.match(appJs,/if\(x\.error==='UPDATE_IN_PROGRESS'\)\{joinedExisting=true;/);
});


