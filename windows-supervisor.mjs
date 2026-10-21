import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomBytes} from 'node:crypto';
import {spawn,execFileSync} from 'node:child_process';
import {setTimeout as sleep} from 'node:timers/promises';
import {resolveDataDir,readStore,backupStore,isLocked} from './persistence.mjs';
import {compareVersions} from './updater.mjs';
import {github,readAutoStatus,writeAutoStatus,stageCandidate,swapCandidate,restoreCode} from './windows-update-source.mjs';
const root=path.dirname(fileURLToPath(import.meta.url)),dataDir=resolveDataDir(),secret=randomBytes(32).toString('hex');
let proc,interval,closing=false,updating=false,failures=0;
const active=()=>proc&&proc.exitCode===null&&proc.signalCode===null;
const getPort=()=>{let port=process.env.PORT||'3000';const envPath=path.join(dataDir,'.env');
 if(!process.env.PORT&&fs.existsSync(envPath)){const m=fs.readFileSync(envPath,'utf8').match(/^\\s*PORT\\s*=\\s*(\\d+)\\s*$/m);if(m)port=m[1]}
 const n=Number(port);if(!Number.isSafeInteger(n)||n<1||n>65535)throw Error('PORT 설정 오류');return n};
const url=()=>`http://127.0.0.1:${getPort()}`;
function launch(openBrowser){
 const p=spawn(process.execPath,['server.mjs'],{cwd:root,env:{...process.env,SIGNAL_LAB_SUPERVISOR_TOKEN:secret,SIGNAL_LAB_OPEN_BROWSER:openBrowser?'1':'0',AUTO_UPDATE:'false'},stdio:'inherit'});proc=p;
 p.closed=new Promise(resolve=>p.once('close',(code,signal)=>resolve({code,signal})));
 p.on('error',e=>console.error('[AUTO] Node 서버 시작 실패:',e.message));
 p.closed.then(({code})=>{if(proc!==p||updating||closing)return;
  if(code===0){console.log('[AUTO] 서버 종료');clearInterval(interval);return}
  if(++failures>3){console.error('[AUTO] 3회 재실행 실패. 수동 확인 필요');clearInterval(interval);return}
  setTimeout(()=>{if(!closing&&!updating)launch(false)},5000);
 });
}
async function healthy(){
 const deadline=Date.now()+30000;while(Date.now()<deadline){
  if(!active())throw Error('서버 비정상 종료');
  try{const res=await fetch(url()+'/api/internal/supervisor/ping',{headers:{'X-Signal-Lab-Supervisor':secret},signal:AbortSignal.timeout(1700)});
   if(res.ok&&(await res.json()).ok)return
  }catch{}
  await sleep(650)
 }throw Error('서버 30초 헬스체크 실패');
}
async function stop(){
 if(!active())throw Error('서버가 실행 중이지 않아 안전 종료 불가');
 const old=proc;
 const resp=await fetch(url()+'/api/internal/supervisor/shutdown',{method:'POST',headers:{'X-Signal-Lab-Supervisor':secret},signal:AbortSignal.timeout(5000)});
 if(!resp.ok)throw Error('서버 종료 요청 거부 (기록 저장 또는 인증 문제)');
 if(!await Promise.race([old.closed.then(()=>true),sleep(15000).then(()=>false)]))throw Error('서버 종료 제한시간 초과');
 if(isLocked(dataDir))throw Error('기록 폴더 사용 중 — 안전 교체 중단');
}
function localTests(folder){
 return new Promise((resolve,reject)=>{
  const tests=fs.readdirSync(path.join(folder,'tests')).filter(s=>s.endsWith('.test.mjs')).map(s=>'tests/'+s);
  if(tests.length<10)return reject(Error('다운로드 테스트 집합이 불완전함'));
  const temp=fs.mkdtempSync(path.join(folder,'paper-testing-'));
  let stderr='';
  const job=spawn(process.execPath,['--test',...tests],{cwd:folder,env:{...process.env,SIGNAL_LAB_DATA_DIR:temp,AUTO_UPDATE:'false',UPDATE_MANIFEST_URL:'',SIGNAL_LAB_OPEN_BROWSER:'0',HOST:'127.0.0.1',TELEGRAM_BOT_TOKEN:'',TELEGRAM_CHAT_ID:'',TWELVE_DATA_API_KEY:''},windowsHide:true,stdio:['ignore','ignore','pipe']});
  job.stderr.on('data',b=>stderr=(stderr+b).slice(-2000));
  const timer=setTimeout(()=>job.kill(),180000);
  job.once('error',e=>{clearTimeout(timer);reject(e)});
  job.once('close',code=>{clearTimeout(timer);try{fs.rmSync(temp,{force:true,recursive:true})}catch{}
   if(code===0)resolve();else reject(Error('업데이트 코드 로컬 테스트 실패: '+stderr.slice(-500)))});
 })
}
const version=folder=>JSON.parse(fs.readFileSync(path.join(folder,'package.json'),'utf8')).version;
async function approvedHead(api){
 const candidate=await api.head();if(!candidate)return null;
 const tree=await api.tree(candidate.sha),pkg=tree.tree?.find(f=>f.path==='package.json');
 if(!pkg)throw Error('패키지 파일 없음');
 const remote=JSON.parse((await api.blob(pkg.sha)).toString('utf8'));
 if(compareVersions(remote.version,version(root))<0)throw Error('main 브랜치는 현재 설치본보다 구버전입니다. 자동 다운그레이드 거부');
 return candidate
}
async function update(){
 if(updating||closing||!active())return;updating=true;
 const previous=readAutoStatus(root);
 try{
  if(!previous.enabled)return;
  const api=github(),candidate=await approvedHead(api);
  if(!candidate||candidate.sha===previous.lastInstalledSha||candidate.sha===previous.badSha)return;
  console.log('[AUTO] 승인된 CI 커밋 확인:',candidate.sha);
  const {stage,files}=await stageCandidate(root,api,candidate.sha);let changed=null,closed=false;
  try{
   await localTests(stage);
   await stop();closed=true;
   const store=path.join(dataDir,'store.json');
   if(fs.existsSync(store)){readStore(store);console.log('[AUTO] PNL 백업:',backupStore(store,{maxBackups:50}))}
   changed=swapCandidate(root,stage,files,candidate.sha);
   launch(false);await healthy();
   failures=0;writeAutoStatus(root,{...previous,enabled:true,lastInstalledSha:candidate.sha,badSha:null,lastSuccessfulUpdate:new Date().toISOString()});
   console.log('[AUTO] 업데이트 완료');
  }catch(error){
   console.error('[AUTO] 교체/검증 실패:',error.message);
   if(closed){
    if(active())await stop();
    if(changed)restoreCode(root,changed.backup,changed.changed);
    launch(false);try{await healthy()}catch(e){console.error('[AUTO] 이전 버전 재시작 실패:',e.message)}
   }
   writeAutoStatus(root,{...previous,badSha:candidate.sha,lastError:error.message,enabled:true});
  }finally{fs.rmSync(stage,{force:true,recursive:true})}
 }catch(e){console.warn('[AUTO] 확인 실패. 기존 프로그램 계속 실행:',e.message)}
 finally{updating=false}
}
async function main(){
 if(process.argv.includes('--disable')){writeAutoStatus(root,{...readAutoStatus(root),enabled:false});return}
 if(process.argv.includes('--enable')){
  const candidate=await approvedHead(github());if(!candidate)throw Error('main의 Windows/Linux 4개 CI 통과 전에는 활성화할 수 없습니다');
  writeAutoStatus(root,{...readAutoStatus(root),enabled:true});console.log('[AUTO] 자동 업데이트 활성화됨');return
 }
 for(const sig of ['SIGINT','SIGTERM'])process.on(sig,()=>{closing=true;clearInterval(interval);if(active())void stop().catch(e=>console.error('[AUTO] 안전 종료:',e.message))});
 console.log('[AUTO] Windows PC 감독자 시작');launch(true);
 interval=setInterval(()=>void update(),15*60*1000);
 setTimeout(()=>void update(),120000);
}
main().catch(e=>{console.error('[AUTO]',e.message);process.exitCode=1});
