import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {applyPending} from './updater.mjs';
const root=path.dirname(fileURLToPath(import.meta.url));
const pkg=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8'));
try{
 if(process.argv.includes('--apply')){
  const result=applyPending({root,currentVersion:pkg.version});
  if(result.state==='applied')console.log('[UPDATE] Installed v'+result.version+'. Previous code backed up.');
  else if(result.state==='obsolete')console.log('[UPDATE] Stale pending update skipped.');
 }else console.log('Updates are staged automatically only when UPDATE_MANIFEST_URL points to a trusted HTTPS release manifest.');
 }catch(e){
 console.error('[UPDATE] '+e.message);
 // If a pending download failed preflight checksum verification, none of the live files
 // were touched. Quarantine it so the existing server remains startable.
 if(e.message.includes('무결성 오류')||e.message.includes('업데이트 항목 검증 실패')){
  const pending=path.join(root,'.updates','pending');
  const quarantine=path.join(root,'.updates','rejected-'+Date.now());
  try{if(fs.existsSync(pending))fs.renameSync(pending,quarantine);console.warn('[UPDATE] Invalid staged files quarantined. Starting previous version.')}catch(err){console.error('[UPDATE] Quarantine failed:',err.message);process.exitCode=1}
 } else process.exitCode=1;
}
