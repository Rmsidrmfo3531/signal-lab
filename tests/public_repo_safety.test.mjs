import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const SKIP_DIRS=new Set(['.git','node_modules','.updates','.update-staging','__pycache__','backtest-cache','backtest-results']);

function walk(dir,out=[]){
 for(const entry of fs.readdirSync(dir,{withFileTypes:true})){
  if(SKIP_DIRS.has(entry.name))continue;
  const full=path.join(dir,entry.name);
  if(entry.isDirectory())walk(full,out);
  else if(entry.isFile())out.push(path.relative(root,full).split(path.sep).join('/'));
 }
 return out;
}

const SECRET_PATTERNS=[
 {name:'GitHub PAT',re:/\b(?:ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/},
 {name:'Private key header',re:/-----BEGIN (?:RSA |OPENSSH |EC |DSA )?PRIVATE KEY-----/},
 {name:'Telegram bot token',re:/\b\d{8,10}:[A-Za-z0-9_-]{35}\b/},
 {name:'Google API key',re:/\bAIza[0-9A-Za-z_-]{35}\b/},
 {name:'OpenAI/Anthropic key',re:/\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{24,}\b/},
 {name:'Real BingX/Telegram env secret assignment',re:/^(?:BINGX_API_KEY|BINGX_API_SECRET|BINGX_TESTNET_API_KEY|BINGX_TESTNET_API_SECRET|TELEGRAM_BOT_TOKEN|COPY_LISTENER_TOKEN)=[A-Za-z0-9_\-:]{16,}/m},
];

test('public repo safety: no secret files or hardcoded credentials exist in source tree',()=>{
 const files=walk(root);
 const forbiddenFiles=files.filter(f=>
  (/(?:^|\/)\.env(?:\..+)?$/.test(f)&&f!=='.env.issue6.example')
  ||/\.(?:session|pem|key|p12)$/i.test(f)
  ||/(?:^|\/)(?:store|live_ledger|copy_ledger|scalp_ledger)\.json$/i.test(f)
 );
 assert.deepEqual(forbiddenFiles,[],'Forbidden secret or runtime state file present in repo');

 const findings=[];
 for(const rel of files){
  if(rel.startsWith('tests/')||rel.endsWith('.png')||rel.endsWith('.gz'))continue;
  const text=fs.readFileSync(path.join(root,rel),'utf8');
  for(const p of SECRET_PATTERNS){
   if(p.re.test(text))findings.push(`${rel}: matched ${p.name}`);
  }
 }
 assert.deepEqual(findings,[],'Hardcoded secret detected in repository source');
});

test('public repo safety: .gitignore blocks secrets and workflows enforce minimal read-only permissions',()=>{
 const giPath=path.join(root,'.gitignore');
 if(fs.existsSync(giPath)){
  const gi=fs.readFileSync(giPath,'utf8');
  for(const pattern of ['.env','.env.*','*.session','*.pem','*.key','data/','*ledger*.json']){
   assert.ok(gi.split(/\r?\n/).some(line=>line.trim()===pattern),`.gitignore must block ${pattern}`);
  }
 }

 const wfDir=path.join(root,'.github','workflows');
 if(fs.existsSync(wfDir)){
  for(const name of fs.readdirSync(wfDir).filter(f=>/\.ya?ml$/.test(f))){
   const wf=fs.readFileSync(path.join(wfDir,name),'utf8');
   assert.doesNotMatch(wf,/\bpull_request_target\b/,`${name} must never use pull_request_target on a public repo`);
   assert.match(wf,/permissions:\s*\n\s*contents:\s*read/,`${name} must pin minimal permissions: contents: read`);
   assert.match(wf,/persist-credentials:\s*false/,`${name} must disable checkout credential persistence`);
  }
 }

 const copySh=path.join(root,'deploy','linux','copy.sh');
 if(fs.existsSync(copySh)){
  const src=fs.readFileSync(copySh,'utf8');
  assert.doesNotMatch(src,/-1003995199859/,'copy.sh must not hardcode a real private Telegram channel ID');
 }
});
