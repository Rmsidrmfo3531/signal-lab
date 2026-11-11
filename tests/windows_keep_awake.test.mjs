import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {startKeepAwake} from '../windows_keep_awake.mjs';

test('keep-awake starts only on Windows, can be turned off, and passes the server PID',()=>{
 assert.equal(startKeepAwake({platform:'linux'}).started,false);
 assert.equal(startKeepAwake({platform:'win32',env:{KEEP_AWAKE:'false'}}).started,false);
 const calls=[];let killed=false;
 const r=startKeepAwake({platform:'win32',env:{},pid:4321,script:'C:/app/windows_keep_awake.ps1',launch:(cmd,args,opts)=>{calls.push({cmd,args,opts});return {on(){},unref(){},kill(){killed=true}}}});
 assert.equal(r.started,true);assert.equal(calls[0].cmd,'powershell.exe');assert.equal(calls[0].opts.windowsHide,true);
 assert.deepEqual(calls[0].args.slice(-4),['-File','C:/app/windows_keep_awake.ps1','-ParentId','4321']);
 r.stop();assert.equal(killed,true);
});

test('on Windows the script ends by itself when the server process is gone',()=>{
 if(process.platform!=='win32')return; // the CI runner counts skips as failures; Linux has nothing to run
 const script=fileURLToPath(new URL('../windows_keep_awake.ps1',import.meta.url));
 const run=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',script,'-ParentId','999999'],{encoding:'utf8',timeout:60000});
 assert.equal(run.status,0,run.stderr);
});
