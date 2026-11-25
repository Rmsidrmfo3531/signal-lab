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
 const {fileURLToPath}=await import('node:url');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'lc-'));
 fs.writeFileSync(path.join(dir,'a.mjs'),'import {nope} f'+"rom './b.mjs';\nthrow Error('must not run');");
 fs.writeFileSync(path.join(dir,'b.mjs'),'export const x=1;');
 const run=f=>{try{return execFileSync(process.execPath,['--no-warnings','--experimental-vm-modules',fileURLToPath(new URL('../link_check.mjs',import.meta.url)),f],{encoding:'utf8',stdio:'pipe'})}catch(e){return 'FAIL '+e.stderr}};
 assert.match(run(path.join(dir,'a.mjs')),/FAIL LINK_FAIL .*nope/);
 assert.match(run(fileURLToPath(new URL('../server.mjs',import.meta.url))),/LINK_OK/);
});

test('formatUpdateCompletedNotice formats auto, manual, button, and HTML notices with high visibility and no duplicate hash',()=>{
 const autoMsg=formatUpdateCompletedNotice({
  version:'5.8.0',
  displayVersion:'2026-11-22 23:25 KST · abc1234',
  fromDisplayVersion:'2026-11-22 23:16 KST · 9998888',
  to:'abc1234',
  source:'auto',
  changes:['텔레그램 업데이트 완료 알림 추가','feat(scalp): 테스트넷 자금 한도 100% 상향 (#327)'],
  restored:['실계좌 카피 ●','테스트넷 단타 ●'],
  html:true,
 });
 assert.match(autoMsg,/✅ <b>Signal Lab 자동 업데이트 완료<\/b>/);
 assert.match(autoMsg,/📦 <b>버전<\/b>\s+<code>v5\.8\.0<\/code>/);
 assert.match(autoMsg,/🕒 <b>적용<\/b>\s+2026-11-22 23:25 KST \(<code>abc1234<\/code>\)/);
 assert.doesNotMatch(autoMsg,/abc1234.*abc1234/,'commit hash is never duplicated');
 assert.match(autoMsg,/🔁 <b>이전<\/b>\s+2026-11-22 23:16 KST \(<code>9998888<\/code>\)/);
 assert.match(autoMsg,/📝 <b>주요 변경 내역 \(2건\)<\/b>/);
 assert.match(autoMsg,/1\. 텔레그램 업데이트 완료 알림 추가/);
 assert.match(autoMsg,/2\. <b>\[단타·신규\]<\/b> 테스트넷 자금 한도 100% 상향 <code>#327<\/code>/);
 assert.match(autoMsg,/⚡ <b>자동 복원 현황<\/b>\n• 실계좌 카피 ●\n• 테스트넷 단타 ●/);

 const manualMsg=formatUpdateCompletedNotice({
  version:'5.8.0',
  displayVersion:'2026-11-22 23:25 KST',
  source:'button',
 });
 assert.match(manualMsg,/✅ Signal Lab 수동 업데이트 완료/);
 assert.match(manualMsg,/새 버전으로 서버가 정상 시작되었습니다\./);

 const xssMsg=formatUpdateCompletedNotice({
  version:'5.8.0',
  displayVersion:'2026-11-22 23:25 KST',
  source:'auto',
  changes:['fix: handle a < b & c > d'],
  html:true,
 });
 assert.match(xssMsg,/handle a &lt; b &amp; c &gt; d/);
});

test('localizeUpdateChanges translates English commits to Korean, protects crypto terms, skips Korean, and degrades safely',async()=>{
 const {parseCommitSubject,needsKoreanTranslation,localizeUpdateChanges,formatUpdateErrorNotice}=await import('../git_update.mjs');
 assert.deepEqual(parseCommitSubject('feat(scalp): raise testnet maxMarginPct to 20% (#327)'),{
  badge:'[단타·신규]',
  body:'raise testnet maxMarginPct to 20%',
  pr:'#327',
 });
 assert.equal(needsKoreanTranslation('add BTC vs Altcoin dominance indicator'),true);
 assert.equal(needsKoreanTranslation('BTC 도미넌스 지표 추가'),false);

 const seen=[];
 const localized=await localizeUpdateChanges([
  'feat: add BTC vs Altcoin dominance indicator (#328)',
  'feat(scalp): raise testnet maxMarginPct to 20% and fix TRADER_LADDER sizeMult to 1 (#327)',
  'fix(telegram): 텔레그램 알림 한글화 개선 (#329)',
 ],{
  translate:async({text})=>{
   seen.push(text);
   if(text.includes('dominance'))return {translatedText:'비트 코인 대비 알트 코인 도미 넌스 지표 추가'};
   return {translatedText:'테스트 넷 최대 증거금 비중을 20%로 상향하고 카피식 추매 수량 배수를 1로 수정'};
  },
 });
 assert.equal(seen.length,2,'already-Korean commit skipped external translator');
 assert.match(seen[1],/테스트넷/,'protected testnet term before translation');
 assert.match(seen[1],/카피식 추매/,'protected TRADER_LADDER term before translation');
 assert.equal(localized[0].badge,'[신규]');
 assert.equal(localized[0].text,'비트코인 대비 알트코인 도미넌스 지표 추가');
 assert.equal(localized[0].pr,'#328');
 assert.equal(localized[1].badge,'[단타·신규]');
 assert.equal(localized[1].text,'테스트넷 최대 증거금 비중을 20%로 상향하고 카피식 추매 수량 배수를 1로 수정');
 assert.equal(localized[2].badge,'[텔레그램·수정]');
 assert.equal(localized[2].text,'텔레그램 알림 한글화 개선');

 // Translator failure still returns clean badge + original text without throwing
 const fallback=await localizeUpdateChanges(['fix(copy): prevent duplicate <order> (#330)'],{
  translate:async()=>{throw Error('network down')},
 });
 assert.equal(fallback[0].badge,'[카피·수정]');
 assert.equal(fallback[0].text,'prevent duplicate <order>');
 assert.equal(fallback[0].pr,'#330');

 // Error notices format English states/messages into readable Korean HTML
 const aborted=formatUpdateErrorNotice({kind:'aborted',source:'auto',state:'diverged',message:'',html:true});
 assert.match(aborted,/⚠️ <b>Signal Lab 자동 업데이트 중단<\/b>/);
 assert.match(aborted,/서버 코드가 GitHub와 달라 자동 적용을 건너뛰었습니다\./);
 const failed=formatUpdateErrorNotice({kind:'failed',source:'auto',state:'failed',message:'git merge <failed>',html:true});
 assert.match(failed,/🚨 <b>Signal Lab 자동 업데이트 실패<\/b>/);
 assert.match(failed,/<code>git merge &lt;failed&gt;<\/code>/);
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
 assert.match(restartNotice,/✅ Signal Lab 버전 업데이트 완료/);
 assert.match(restartNotice,/🕒 적용\s+2026-11-22 23:25 KST/);
 assert.match(restartNotice,/🔁 이전\s+2026-11-22 23:16 KST/);
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
 assert.match(markerNotice,/✅ Signal Lab 수동 업데이트 완료/);
 assert.match(markerNotice,/🕒 적용\s+2026-11-22 23:40 KST \(bbb2222\)/);
 assert.match(markerNotice,/1\. UI 개선/);
 assert.match(markerNotice,/⚡ 자동 복원 현황\n• 신호 전략 ●\n• 테스트넷 단타 ●/);
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



test('header version follows the running commit: commit time in KST + short hash (user 2026-11-24 "업데이트할 때마다 변경")',async()=>{
 const {commitDisplayVersion,gitCheck}=await import('../git_update.mjs');
 assert.equal(commitDisplayVersion('2026-11-24T14:05:09Z','506c88536fee'),'2026-11-24 23:05 KST · 506c885');
 assert.equal(commitDisplayVersion('bad','abc1234'),null);assert.equal(commitDisplayVersion('2026-11-24T14:05:09Z',''),null);
 const times={aaa1111:'2026-11-23T05:56:00Z',bbb2222:'2026-11-24T14:05:00Z'};
 const git=async(root,args)=>{
  if(args[0]==='fetch')return '';
  if(args[0]==='rev-parse')return args[2]==='HEAD'?'aaa1111':'bbb2222';
  if(args[0]==='show'&&args[1]==='-s')return times[args.at(-1)];
  if(args[0]==='log')return 'bbb2222 feat: x';
  throw Error('unexpected '+args.join(' '));
 };
 const c=await gitCheck('/x',{git});
 assert.equal(c.currentDisplayVersion,'2026-11-23 14:56 KST · aaa1111');
 assert.equal(c.latestDisplayVersion,'2026-11-24 23:05 KST · bbb2222');
});

test('scheduled update banner formats remaining minutes/seconds and wires SSE + /api/update',async()=>{
 const {formatUpdateSchedule}=await import('../public/update_schedule.js');
 const base=Date.UTC(2026,10,25,6,0,0); // 15:00:00 KST
 assert.equal(formatUpdateSchedule(null,base),null);

 const twoMin=formatUpdateSchedule({latest:'abc1234',latestDisplayVersion:'2026-11-25 14:58 KST · abc1234',changesCount:3,scheduledAt:base+120000},base);
 assert.equal(twoMin.title,'업데이트가 확인되어 2분 뒤에 업데이트 진행 예정입니다.');
 assert.match(twoMin.detail,/새 버전 2026-11-25 14:58 KST · abc1234 · 변경 3건 · 예정 시각 15:02:00 KST/);

 const minSec=formatUpdateSchedule({scheduledAt:base+105000},base);
 assert.equal(minSec.title,'업데이트가 확인되어 1분 45초 뒤에 업데이트 진행 예정입니다.');

 const secs=formatUpdateSchedule({scheduledAt:base+30000},base);
 assert.equal(secs.title,'업데이트가 확인되어 30초 뒤에 업데이트 진행 예정입니다.');

 const soon=formatUpdateSchedule({scheduledAt:base-1000},base);
 assert.equal(soon.title,'업데이트가 확인되어 곧 업데이트 진행 예정입니다.');

 const idleWait=formatUpdateSchedule({scheduledAt:base-5000,waitingIdle:true},base);
 assert.equal(idleWait.title,'업데이트가 확인되어 진행 중인 작업이 끝나면 곧 업데이트 진행 예정입니다.');

 const server=fs.readFileSync(new URL('../server.mjs',import.meta.url),'utf8');
 const html=fs.readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
 const appJs=fs.readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
 assert.match(server,/send\('update-schedule'/);
 assert.match(server,/scheduledUpdate:scheduledUpdateSnapshot\(\)/);
 assert.match(server,/Number\(rawAutoDelay\):0\)\)\*60000/);
 assert.match(server,/scheduleAutoUpdate\(c,\{waitingIdle:true\}\)/);
 assert.match(html,/id="updateScheduleBanner"/);
 assert.match(appJs,/es\.addEventListener\('update-schedule'/);
 assert.match(appJs,/formatUpdateSchedule\(scheduledUpdate/);
});

