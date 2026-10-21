import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {approvedCI,codeEntries,gitBlobHash,swapCandidate,restoreCode,readAutoStatus,writeAutoStatus} from '../windows-update-source.mjs';
const sha='a'.repeat(40);
const run={head_sha:sha,head_branch:'main',event:'push',name:'Node.js tests',status:'completed',conclusion:'success',path:'Rmsidrmfo3531/signal-lab/.github/workflows/node-tests.yml@refs/heads/main',head_repository:{full_name:'Rmsidrmfo3531/signal-lab'}};
const jobs=['Node 22.x / ubuntu-latest','Node 24.x / ubuntu-latest','Node 22.x / windows-latest','Node 24.x / windows-latest'].map(name=>({name,status:'completed',conclusion:'success'}));
test('only exact trusted main commit with all four successful CI jobs is approved',()=>{
 assert.equal(approvedCI(run,sha,jobs),true);
 for(const bad of [{...run,event:'pull_request'},{...run,head_branch:'fix/unmerged'},{...run,head_sha:'b'.repeat(40)},{...run,conclusion:'skipped'},{...run,head_repository:{full_name:'someone/fork'}}])assert.equal(approvedCI(bad,sha,jobs),false);
 assert.equal(approvedCI(run,sha,jobs.slice(1)),false);
 assert.equal(approvedCI(run,sha,jobs.map((j,i)=>i===1?{...j,conclusion:'failure'}:j)),false);
});
test('Git native blob hash includes size header and NUL byte',()=>{
 const data=Buffer.from('hello');const expected=createHash('sha1').update(Buffer.concat([Buffer.from('blob 5\\0'),data])).digest('hex');
 assert.equal(gitBlobHash(data),expected);
});
test('Git tree rejects missing required binaries and incomplete responses',()=>{
 assert.throws(()=>codeEntries({truncated:true,tree:[]}),/불완전/);
 assert.throws(()=>codeEntries({truncated:false,tree:[{path:'.env',type:'blob',size:12,sha,mode:'100644'}]}),/필수 파일/);
});
test('transactional code swap, user files protection, and exact rollback',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'signal-updater-'));try{
  const updates=path.join(root,'.updates'),stage=path.join(updates,'candidate-'+sha),data='real records';
  fs.mkdirSync(stage,{recursive:true});fs.writeFileSync(path.join(root,'server.mjs'),'old');fs.writeFileSync(path.join(root,'store.json'),data);fs.writeFileSync(path.join(root,'.env'),'SECRET=x');
  const newSource=Buffer.from('new');fs.writeFileSync(path.join(stage,'server.mjs'),newSource);
  const manifest=[{path:'server.mjs',sha256:createHash('sha256').update(newSource).digest('hex')}];
  const x=swapCandidate(root,stage,manifest,sha);
  assert.equal(fs.readFileSync(path.join(root,'server.mjs'),'utf8'),'new');
  assert.equal(fs.readFileSync(path.join(root,'store.json'),'utf8'),data);
  restoreCode(root,x.backup,x.changed);
  assert.equal(fs.readFileSync(path.join(root,'server.mjs'),'utf8'),'old');
  assert.equal(fs.readFileSync(path.join(root,'.env'),'utf8'),'SECRET=x');
  writeAutoStatus(root,{enabled:true,lastInstalledSha:sha});
  assert.equal(readAutoStatus(root).lastInstalledSha,sha);
 }finally{fs.rmSync(root,{recursive:true,force:true})}
});
