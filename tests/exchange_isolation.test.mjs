import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));

test('runtime source, scripts and configuration contain no removed exchange module, hostname or configuration path',async()=>{
 const forbidden=new RegExp(['vari','ational'].join(''),'i'),findings=[];
 async function visit(directory){
  for(const item of await fs.readdir(directory,{withFileTypes:true})){
   if(item.name==='.git'||item.name==='node_modules'||item.name==='tests'||item.name==='reports')continue;
   const file=path.join(directory,item.name);
   if(item.isDirectory()){await visit(file);continue;}
   if(!/\.(?:mjs|js|html|css|bat|sh|json)$/.test(item.name)&&!item.name.startsWith('.env'))continue;
   if(forbidden.test(await fs.readFile(file,'utf8')))findings.push(path.relative(root,file));
  }
 }
 await visit(root);assert.deepEqual(findings,[]);
});
