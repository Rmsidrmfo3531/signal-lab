// Link check for an update: loads server.mjs and everything it imports as modules WITHOUT running
// them (vm.SourceTextModule.link), so a syntax error, a missing file or a missing named export is
// found before the restart. Run: node --experimental-vm-modules link_check.mjs <entry.mjs>
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';

export async function linkCheck(entry){
 const cache=new Map(),context=vm.createContext({});
 const load=async(file)=>{
  if(cache.has(file))return cache.get(file);
  const m=new vm.SourceTextModule(fs.readFileSync(file,'utf8'),{identifier:pathToFileURL(file).href,context});
  cache.set(file,m);return m;
 };
 const linker=async(spec,ref)=>{
  if(spec.startsWith('node:')||!spec.startsWith('.')&&!spec.startsWith('/')){
   const real=await import(spec.startsWith('node:')?spec:'node:'+spec),names=Object.keys(real);
   return new vm.SyntheticModule(names,function(){for(const n of names)this.setExport(n,real[n])},{context});
  }
  const refPath=fileURLToPath(ref.identifier);
  const file=path.resolve(path.dirname(refPath),spec);
  if(!fs.existsSync(file))throw Error(`${path.basename(refPath)}: ${spec} 없음`);
  return load(file);
 };
 const root=await load(path.resolve(entry));
 await root.link(linker);
 return cache.size;
}

if(import.meta.url===pathToFileURL(process.argv[1]||'').href){
 linkCheck(process.argv[2]||'server.mjs').then(n=>{console.log('LINK_OK',n)},e=>{console.error('LINK_FAIL',e.message.split('\n')[0]);process.exit(1)});
}
