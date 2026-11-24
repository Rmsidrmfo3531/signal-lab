// One-tap update for the cloud server: the app folder is a git checkout (deploy/linux/install.sh,
// read-only deploy key) and systemd restarts the process when it exits. Fast-forward only, the new
// server.mjs is syntax-checked before the restart, and live trading starts disarmed after it.
import {execFile,execFileSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const run=(cwd,args,timeout=60000)=>new Promise((resolve,reject)=>execFile('git',args,{cwd,timeout,maxBuffer:1<<20},(error,stdout,stderr)=>
 error?reject(Object.assign(Error(String(stderr||error.message).trim().split('\n').slice(-1)[0]||'git failed'),{code:'GIT_FAILED'})):resolve(String(stdout).trim())));

/** Available only in a git checkout run by systemd (INVOCATION_ID), i.e. the cloud install. */
export function gitUpdateAvailable(root,env=process.env){return fs.existsSync(path.join(root,'.git'))&&Boolean(env.INVOCATION_ID||env.SIGNAL_LAB_GIT_UPDATE==='1')}

export function displayVersionOf(info){
 const named=typeof info?.displayVersion==='string'?info.displayVersion.trim():'';
 return named||(typeof info?.version==='string'&&info.version.trim()?'v'+info.version.trim():null);
}
// The version shown in the header is the running commit (user 2026-11-24 "이 부분에 있는 버전이 업데이트할 때마다 변경되어있지
// 않아 수정해줘"): its commit time in KST plus the short hash, so every update changes it without editing package.json.
const KST_MS=9*3600000;
export function commitDisplayVersion(iso,sha){
 const t=Date.parse(String(iso||'').trim()),h=String(sha||'').trim().slice(0,7);
 if(!Number.isFinite(t)||!h)return null;
 const d=new Date(t+KST_MS).toISOString();return `${d.slice(0,10)} ${d.slice(11,16)} KST · ${h}`;
}
/** The running checkout's version, read synchronously at boot; null outside a git checkout. */
export function headDisplayVersionSync(root){
 if(!fs.existsSync(path.join(root,'.git')))return null;
 try{const [iso,sha]=String(execFileSync('git',['-C',root,'show','-s','--format=%cI|%h','HEAD'],{timeout:5000,stdio:['ignore','pipe','ignore']})).trim().split('|');return commitDisplayVersion(iso,sha)}catch{return null}
}
async function versionAt(root,git,commit){
 try{const v=commitDisplayVersion(await git(root,['show','-s','--format=%cI',commit]),commit);if(v)return v}catch{}
 try{return displayVersionOf(JSON.parse(await git(root,['show',commit+':package.json'])))}catch{return null}
}

/** Fetch origin/main and list what an update would bring. */
export async function gitCheck(root,{git=run}={}){
 await git(root,['fetch','--quiet','origin','main']);
 const current=await git(root,['rev-parse','--short','HEAD']),latest=await git(root,['rev-parse','--short','origin/main']);
 const currentDisplayVersion=await versionAt(root,git,current);
 const latestDisplayVersion=current===latest?currentDisplayVersion:await versionAt(root,git,latest);
 const head={current,latest,currentDisplayVersion,latestDisplayVersion};
 if(current===latest)return {state:'current',...head,changes:[]};
 const log=await git(root,['log','--format=%h %s','-n','15','HEAD..origin/main']);
 const changes=log?log.split('\n').filter(Boolean).map(l=>({sha:l.slice(0,l.indexOf(' ')),subject:l.slice(l.indexOf(' ')+1)})):[];
 if(!changes.length)return {state:'diverged',...head,changes,message:'서버 코드가 GitHub와 다릅니다. 업데이트 스크립트로 직접 확인하세요.'};
 return {state:'available',...head,changes};
}

/** Fast-forward to origin/main; roll back if the new server.mjs does not parse. Caller restarts. */
export async function gitApply(root,{git=run,checkSyntax,onStep=()=>{}}={}){
 const before=await gitCheck(root,{git});onStep('fetched',before);
 if(before.state!=='available')return {ok:before.state==='current',...before};
 await git(root,['merge','--ff-only','origin/main']);onStep('merged');
 const after=await git(root,['rev-parse','--short','HEAD']);
 try{await checkSyntax(root)}
 catch(error){await git(root,['reset','--hard',before.current]);return {ok:false,state:'rolled-back',current:before.current,latest:before.latest,message:'새 버전 검사 실패로 되돌렸습니다: '+error.message}}
 return {ok:true,state:'applied',from:before.current,to:after,changes:before.changes,
  fromDisplayVersion:before.currentDisplayVersion,toDisplayVersion:after===before.latest?before.latestDisplayVersion:await versionAt(root,git,after)};
}

/** Every .mjs at the root and every public script parses, and every relative import of the root
 * modules points at a file that exists (node --check does not follow imports). */
export async function checkTree(root,{nodeCheck,onFile=()=>{}}){
 const files=fs.readdirSync(root).filter(f=>f.endsWith('.mjs')).map(f=>path.join(root,f))
  .concat(fs.existsSync(path.join(root,'public'))?fs.readdirSync(path.join(root,'public')).filter(f=>f.endsWith('.js')).map(f=>path.join(root,'public',f)):[]);
 for(const [i,file] of files.entries()){
  await nodeCheck(file);onFile(i+1,files.length);
  if(!file.endsWith('.mjs'))continue;
  for(const m of fs.readFileSync(file,'utf8').matchAll(/(?:^|\n)\s*import\s[^'"]*?from\s*['"](\.[^'"]+)['"]/g)){
   const target=path.resolve(path.dirname(file),m[1]);
   if(!fs.existsSync(target))throw Error(`${path.basename(file)}: ${m[1]} 없음`);
  }
 }
 return files.length;
}

export const LAST_VERSION_FILE='last-notified-version.json';

/** Format a concise Korean Telegram confirmation after the new version boots cleanly. */
export function formatUpdateCompletedNotice({version=null,displayVersion=null,fromDisplayVersion=null,to=null,source=null,changes=[],restored=[]}={}){
 const cur=displayVersion||(version?`v${version}`:'새 버전');
 const verTag=version&&displayVersion&&!String(displayVersion).includes(version)?`v${version} (${displayVersion})`:cur;
 const kind=source==='manual'?'수동 업데이트 완료':source==='auto'?'자동 업데이트 완료':'버전 업데이트 완료';
 const lines=[`✅ [Signal Lab ${kind}] ${verTag}`];
 if(fromDisplayVersion&&fromDisplayVersion!==cur){
  lines.push(`버전: ${fromDisplayVersion} → ${cur}${to?` (${to})`:''}`);
 }else if(to){
  lines.push(`커밋: ${to}`);
 }
 const list=(Array.isArray(changes)?changes:[]).map(c=>typeof c==='string'?c:c?.subject).filter(Boolean).slice(0,8);
 if(list.length){
  lines.push('변경 내역:');
  for(const item of list)lines.push(`· ${item}`);
 }
 if(Array.isArray(restored)&&restored.length){
  lines.push(`자동 복원: ${restored.join(' · ')}`);
 }else{
  lines.push('새 버전으로 서버가 정상 시작되었습니다.');
 }
 return lines.join('\n');
}

/** Detect whether this boot is a newly updated version (via rearm marker or persisted version change) and update the marker file. */
export function checkPostUpdateNotice({dir,appVersion,marker=null,restored=[],now=Date.now()}={}){
 if(!dir||!appVersion)return null;
 const file=path.join(dir,LAST_VERSION_FILE);
 let prev=null;
 try{if(fs.existsSync(file))prev=JSON.parse(fs.readFileSync(file,'utf8'))}catch{}
 const curVer=appVersion.version??null;
 const curDisp=appVersion.displayVersion??null;
 try{
  fs.mkdirSync(dir,{recursive:true});
  fs.writeFileSync(file,JSON.stringify({version:curVer,displayVersion:curDisp,at:now}));
 }catch{}
 if(marker&&Number.isFinite(Number(marker.at))&&now-Number(marker.at)<30*60000){
  return formatUpdateCompletedNotice({
   version:curVer,
   displayVersion:curDisp||marker.toDisplayVersion||null,
   fromDisplayVersion:marker.fromDisplayVersion||prev?.displayVersion||null,
   to:marker.to||null,
   source:marker.source||null,
   changes:marker.changes||[],
   restored,
  });
 }
 const prevId=prev?displayVersionOf(prev):null;
 const curId=displayVersionOf(appVersion);
 if(prev&&((curId&&prevId&&prevId!==curId)||(curVer&&prev.version&&prev.version!==curVer))){
  return formatUpdateCompletedNotice({
   version:curVer,
   displayVersion:curDisp,
   fromDisplayVersion:prevId||prev.version||null,
   source:'restart',
   restored,
  });
 }
 return null;
}

