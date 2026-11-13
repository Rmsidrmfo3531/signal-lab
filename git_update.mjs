// One-tap update for the cloud server: the app folder is a git checkout (deploy/linux/install.sh,
// read-only deploy key) and systemd restarts the process when it exits. Fast-forward only, the new
// server.mjs is syntax-checked before the restart, and live trading starts disarmed after it.
import {execFile} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const run=(cwd,args,timeout=60000)=>new Promise((resolve,reject)=>execFile('git',args,{cwd,timeout,maxBuffer:1<<20},(error,stdout,stderr)=>
 error?reject(Object.assign(Error(String(stderr||error.message).trim().split('\n').slice(-1)[0]||'git failed'),{code:'GIT_FAILED'})):resolve(String(stdout).trim())));

/** Available only in a git checkout run by systemd (INVOCATION_ID), i.e. the cloud install. */
export function gitUpdateAvailable(root,env=process.env){return fs.existsSync(path.join(root,'.git'))&&Boolean(env.INVOCATION_ID||env.SIGNAL_LAB_GIT_UPDATE==='1')}

/** Fetch origin/main and list what an update would bring. */
export async function gitCheck(root,{git=run}={}){
 await git(root,['fetch','--quiet','origin','main']);
 const current=await git(root,['rev-parse','--short','HEAD']),latest=await git(root,['rev-parse','--short','origin/main']);
 if(current===latest)return {state:'current',current,latest,changes:[]};
 const log=await git(root,['log','--format=%h %s','-n','15','HEAD..origin/main']);
 const changes=log?log.split('\n').filter(Boolean).map(l=>({sha:l.slice(0,l.indexOf(' ')),subject:l.slice(l.indexOf(' ')+1)})):[];
 if(!changes.length)return {state:'diverged',current,latest,changes,message:'서버 코드가 GitHub와 다릅니다. 업데이트 스크립트로 직접 확인하세요.'};
 return {state:'available',current,latest,changes};
}

/** Fast-forward to origin/main; roll back if the new server.mjs does not parse. Caller restarts. */
export async function gitApply(root,{git=run,checkSyntax,onStep=()=>{}}={}){
 const before=await gitCheck(root,{git});onStep('fetched');
 if(before.state!=='available')return {ok:before.state==='current',...before};
 await git(root,['merge','--ff-only','origin/main']);onStep('merged');
 const after=await git(root,['rev-parse','--short','HEAD']);
 try{await checkSyntax(root)}
 catch(error){await git(root,['reset','--hard',before.current]);return {ok:false,state:'rolled-back',current:before.current,latest:before.latest,message:'새 버전 검사 실패로 되돌렸습니다: '+error.message}}
 return {ok:true,state:'applied',from:before.current,to:after,changes:before.changes};
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
