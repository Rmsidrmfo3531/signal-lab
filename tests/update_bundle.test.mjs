// The Windows supervisor self-tests a downloaded update in a folder that holds
// ONLY files accepted by allowedFile(). Every module those files import and every
// repository file a test executes must therefore be shipped, or every update is
// rejected by the local self-test. These checks run against the checkout.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {allowedFile} from '../updater.mjs';
import {codeEntries,MAX_UPDATE_FILES,MAX_UPDATE_TOTAL_BYTES} from '../windows-update-source.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const SKIP=new Set(['.git','node_modules','.updates']);
function walk(dir,out=[]){
 for(const entry of fs.readdirSync(dir,{withFileTypes:true})){
  if(SKIP.has(entry.name))continue;
  const full=path.join(dir,entry.name);
  if(entry.isDirectory())walk(full,out);
  else if(entry.isFile())out.push(path.relative(root,full).split(path.sep).join('/'));
 }
 return out;
}
const shipped=walk(root).filter(allowedFile).sort();
const shippedSet=new Set(shipped);
const isRepoFile=name=>{try{return fs.statSync(path.join(root,name)).isFile()}catch{return false}};

// Static relative import specifiers: import...from, export...from, import() and
// side-effect imports. (Quoted examples are left out so this file does not match itself.)
const IMPORT=/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(['"])(\.{1,2}\/[^'"]+)\1/g;
// Quoted file names in tests, such as a script a test runs with spawn().
const LITERAL=/(['"`])((?:\.{1,2}\/)?(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_-][A-Za-z0-9_.-]*\.(?:mjs|js|bat|cmd|ps1|json|html|css))\1/g;

test('every module imported by a shipped file is shipped too',()=>{
 const missing=[];
 for(const file of shipped.filter(f=>/\.(?:mjs|js)$/.test(f))){
  const source=fs.readFileSync(path.join(root,file),'utf8'),dir=path.posix.dirname(file);
  for(const match of source.matchAll(IMPORT)){
   const target=path.posix.normalize(path.posix.join(dir,match[2]));
   if(!shippedSet.has(target))missing.push(`${target} (imported by ${file})`);
  }
 }
 assert.deepEqual(missing,[],'Add these paths to ALLOWED_ROOTS in updater.mjs');
});

test('every repository file a shipped test refers to is shipped too',()=>{
 const missing=new Set();
 for(const file of shipped.filter(f=>f.startsWith('tests/')&&/\.(?:mjs|js)$/.test(f))){
  const source=fs.readFileSync(path.join(root,file),'utf8'),dir=path.posix.dirname(file);
  for(const match of source.matchAll(LITERAL)){
   for(const candidate of new Set([path.posix.normalize(path.posix.join(dir,match[2])),path.posix.normalize(match[2])])){
    if(!candidate.startsWith('..')&&isRepoFile(candidate)&&!shippedSet.has(candidate))missing.add(`${candidate} (referenced by ${file})`);
   }
  }
 }
 assert.deepEqual([...missing],[],'Add these paths to ALLOWED_ROOTS in updater.mjs');
});

test('the GitHub update tree of this checkout fits the update size ceilings',()=>{
 const sizes=shipped.map(name=>fs.statSync(path.join(root,name)).size);
 const total=sizes.reduce((sum,size)=>sum+size,0);
 assert.ok(shipped.length<=MAX_UPDATE_FILES,`${shipped.length} files exceed ${MAX_UPDATE_FILES}`);
 assert.ok(total<=MAX_UPDATE_TOTAL_BYTES,`${total} bytes exceed ${MAX_UPDATE_TOTAL_BYTES}`);
 // The former fixed ceiling of 180 files rejected every update of this repository.
 const tree={truncated:false,tree:shipped.map((name,i)=>({path:name,type:'blob',mode:'100644',sha:i.toString(16).padStart(40,'0'),size:sizes[i]}))};
 assert.equal(codeEntries(tree).length,shipped.length);
});
