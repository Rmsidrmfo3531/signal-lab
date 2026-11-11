// While the server runs on Windows, ask Windows not to sleep (data collection stops when the PC
// sleeps). The display may still turn off. KEEP_AWAKE=false turns this off.
import {spawn} from 'node:child_process';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
export function startKeepAwake({platform=process.platform,env=process.env,launch=spawn,pid=process.pid,
 script=join(dirname(fileURLToPath(import.meta.url)),'windows_keep_awake.ps1')}={}){
 if(platform!=='win32')return {started:false,reason:'Windows가 아닌 서버'};
 if(env.KEEP_AWAKE==='false')return {started:false,reason:'KEEP_AWAKE=false'};
 try{
  const child=launch('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',script,'-ParentId',String(pid)],{windowsHide:true,stdio:'ignore'});
  child.on?.('error',e=>console.warn('[KEEP AWAKE]',e.message));
  child.unref?.();
  const stop=()=>{try{child.kill?.()}catch{}};
  return {started:true,stop};
 }catch(e){return {started:false,reason:e.message}}
}
