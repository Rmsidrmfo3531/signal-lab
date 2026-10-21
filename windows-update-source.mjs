import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {allowedFile} from './updater.mjs';
const REPO='Rmsidrmfo3531/signal-lab',CI='node-tests.yml',BRANCH='main';
const names=['Node 22.x / ubuntu-latest','Node 24.x / ubuntu-latest','Node 22.x / windows-latest','Node 24.x / windows-latest'];
const sha40=/^[a-f0-9]{40}$/i,hex=(algo,b)=>createHash(algo).update(b).digest('hex');
const base=root=>path.join(root,'.updates');
export const readAutoStatus=root=>{try{return JSON.parse(fs.readFileSync(path.join(base(root),'auto-status.json'),'utf8'))}catch{return {enabled:false}}};
export function writeAutoStatus(root,state){fs.mkdirSync(base(root),{recursive:true});const to=path.join(base(root),'auto-status.json'),temp=to+'.tmp';fs.writeFileSync(temp,JSON.stringify(state,null,2));fs.renameSync(temp,to)}
export const gitBlobHash=data=>hex('sha1',Buffer.concat([Buffer.from('blob '+data.length+'\\0'),data]));
export function approvedCI(run,sha,jobs){return sha40.test(sha)&&run?.head_sha===sha&&run?.head_branch==='main'&&run?.event==='push'&&run?.name==='Node.js tests'&&run?.conclusion==='success'&&run?.status==='completed'&&run?.path?.endsWith('/.github/workflows/'+CI)&&run?.head_repository?.full_name===REPO&&names.every(name=>jobs.some(j=>j.name===name&&j.status==='completed'&&j.conclusion==='success'))}
function credential(){try{return execFileSync('gh',['auth','token'],{encoding:'utf8',windowsHide:true,timeout:10000,stdio:['ignore','pipe','ignore']}).trim()}catch{throw Error('GitHub CLI 설치 및 gh auth login 최초 1회 인증 필요')}}
export function github({token=credential(),fetcher=fetch}={}){
 const root='/repos/'+REPO;
 async function get(endpoint){
  if(!endpoint.startsWith(root+'/'))throw Error('GitHub URL 제한');
  const res=await fetcher('https://api.github.com'+endpoint,{headers:{Authorization:'Bearer '+token,Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28'},redirect:'error',signal:AbortSignal.timeout(20000)});
  if(!res.ok)throw Error('GitHub HTTP '+res.status);
  if(Number(res.headers.get('content-length')||0)>6000000)throw Error('GitHub 응답 너무 큼');
  const text=await res.text();if(text.length>6000000)throw Error('GitHub 응답 너무 큼');return JSON.parse(text);
 }
 return {
 async head(){
  const b=await get(root+'/branches/'+BRANCH),sha=b.commit?.sha;if(!sha40.test(sha))throw Error('커밋 SHA 오류');
  const runs=await get(root+'/actions/workflows/'+CI+'/runs?branch=main&event=push&head_sha='+sha+'&per_page=20');
  for(const run of runs.workflow_runs||[]){if(run.head_sha!==sha||run.conclusion!=='success')continue;
   const data=await get(root+'/actions/runs/'+run.id+'/jobs?per_page=100');
   if(data.total_count<=100&&approvedCI(run,sha,data.jobs||[]))return {sha,runId:run.id}
  }return null;
 },
 tree:sha=>{if(!sha40.test(sha))throw Error('SHA 오류');return get(root+'/git/trees/'+sha+'?recursive=1')},
 async blob(sha){
  if(!sha40.test(sha))throw Error('Blob SHA 오류');const r=await get(root+'/git/blobs/'+sha);
  if(r.encoding!=='base64'||typeof r.content!=='string')throw Error('Blob 인코딩 오류');
  const data=Buffer.from(r.content.replace(/\\s/g,''),'base64');
  if(data.length>2000000||gitBlobHash(data)!==sha.toLowerCase())throw Error('Blob 무결성 오류');return data
 }
 };
}
export function codeEntries(tree){
 if(!tree||tree.truncated||!Array.isArray(tree.tree))throw Error('불완전한 GitHub 트리');
 const files=tree.tree.filter(e=>allowedFile(e.path));
 if(files.length>180||files.reduce((sum,e)=>sum+e.size,0)>20000000)throw Error('전체 업데이트 크기 제한');
 for(const f of files)if(f.type!=='blob'||!['100644','100755'].includes(f.mode)||!sha40.test(f.sha)||!Number.isSafeInteger(f.size)||f.size>2000000)throw Error('잘못된 코드 파일: '+f.path);
 for(const required of ['server.mjs','package.json','windows-supervisor.mjs','windows-update-source.mjs','updater.mjs'])if(!files.some(f=>f.path===required))throw Error('필수 파일 없음: '+required);
 return files
}
function target(root,relative){if(!allowedFile(relative))throw Error('잘못된 파일 경로');const dst=path.resolve(root,relative),b=path.resolve(root);
 if(!dst.startsWith(b+path.sep))throw Error('범위를 벗어난 경로');
 for(let p=dst;p!==b;p=path.dirname(p))if(fs.existsSync(p)&&fs.lstatSync(p).isSymbolicLink())throw Error('링크 경로 거부');
 return dst
}
export async function stageCandidate(root,api,sha){
 const entries=codeEntries(await api.tree(sha)),stage=path.join(base(root),'candidate-'+sha),files=[];
 if(fs.existsSync(stage))fs.rmSync(stage,{force:true,recursive:true});fs.mkdirSync(stage,{recursive:true});
 try{
  for(const f of entries){target(root,f.path);const bytes=await api.blob(f.sha);if(bytes.length!==f.size)throw Error('GitHub 파일 길이 오류: '+f.path);
   const dest=target(stage,f.path);fs.mkdirSync(path.dirname(dest),{recursive:true});fs.writeFileSync(dest,bytes,{flag:'wx'});files.push({path:f.path,sha256:hex('sha256',bytes)})}
  return {stage,files}
 }catch(e){fs.rmSync(stage,{force:true,recursive:true});throw e}
}
export function swapCandidate(root,stage,files,sha){
 const backup=path.join(base(root),'rollback-'+sha+'-'+Date.now()),changed=[];
 if(path.dirname(path.resolve(stage))!==path.resolve(base(root)))throw Error('스테이징 경로 오류');
 for(const f of files)if(hex('sha256',fs.readFileSync(target(stage,f.path)))!==f.sha256)throw Error('코드 위변조: '+f.path);
 fs.mkdirSync(backup,{recursive:true});
 try{
  for(const f of files){const src=target(root,f.path),dst=target(backup,f.path),existed=fs.existsSync(src);if(existed){fs.mkdirSync(path.dirname(dst),{recursive:true});fs.copyFileSync(src,dst)}changed.push({path:f.path,existed})}
  fs.writeFileSync(path.join(backup,'changes.json'),JSON.stringify(changed));
  for(const f of files){const src=target(stage,f.path),dst=target(root,f.path),temp=dst+'.update-'+process.pid;fs.mkdirSync(path.dirname(dst),{recursive:true});try{fs.copyFileSync(src,temp);fs.renameSync(temp,dst)}finally{fs.rmSync(temp,{force:true})}}
  return {backup,changed}
 }catch(e){restoreCode(root,backup,changed);throw e}
}
export function restoreCode(root,backup,changed){
 for(const f of [...changed].reverse()){const dest=target(root,f.path),source=target(backup,f.path);if(f.existed){if(!fs.existsSync(source))throw Error('복구 코드 누락');fs.mkdirSync(path.dirname(dest),{recursive:true});fs.copyFileSync(source,dest)}else fs.rmSync(dest,{force:true})}
}
