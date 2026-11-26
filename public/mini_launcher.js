// Launches the Signal Lab Mini HUD from the main dashboard topbar:
// - Primary: Chrome/Edge Document Picture-in-Picture (native Always-on-Top floating window over all apps).
// - Fallback (or Shift+Click): standalone /mini popup window (works even if main dashboard tab is closed).

import {mountMiniHud} from './mini_hud.js';

let activePipWin=null;
let activeCleanup=null;

function setButtonState(btn,open){
 if(!btn)return;
 btn.textContent=open?'📌 미니 창 닫기':'📌 미니 창';
 btn.classList.toggle('is-active',Boolean(open));
}

function openStandalonePopup(){
 const features='width=360,height=440,menubar=no,toolbar=no,location=no,status=no,resizable=yes,scrollbars=yes';
 const popup=window.open('/mini','signalLabMiniHud',features);
 if(popup){
  try{popup.focus()}catch{}
  return true;
 }
 return false;
}

export async function toggleMiniHud(btn,{forcePopup=false}={}){
 // If an Always-on-Top Document PiP window is already open, close it on second click.
 if(activePipWin&&!activePipWin.closed){
  try{activePipWin.close()}catch{}
  return {mode:'closed'};
 }
 const supportsPip=!forcePopup&&typeof window!=='undefined'&&'documentPictureInPicture' in window&&typeof window.documentPictureInPicture?.requestWindow==='function';
 if(supportsPip){
  try{
   const pipWin=await window.documentPictureInPicture.requestWindow({width:350,height:420});
   const pipDoc=pipWin.document;
   pipDoc.title='Signal Lab — 미니 HUD';
   const link=pipDoc.createElement('link');
   link.rel='stylesheet';
   link.href=new URL('/mini.css',window.location.origin).href;
   pipDoc.head.appendChild(link);
   pipDoc.body.className='mh-body';
   const host=pipDoc.createElement('div');
   pipDoc.body.appendChild(host);

   activePipWin=pipWin;
   activeCleanup=mountMiniHud(host,{doc:pipDoc,win:pipWin,standalone:false});
   setButtonState(btn,true);

   pipWin.addEventListener('pagehide',()=>{
    try{activeCleanup?.()}catch{}
    activeCleanup=null;
    activePipWin=null;
    setButtonState(btn,false);
   },{once:true});
   return {mode:'pip'};
  }catch{
   // Fall through to standalone /mini popup if PiP is unavailable (e.g. non-HTTPS remote IP).
  }
 }
 const opened=openStandalonePopup();
 return {mode:opened?'popup':'blocked'};
}

if(typeof document!=='undefined'&&typeof window!=='undefined'){
 const btn=document.getElementById('miniHudButton');
 if(btn){
  btn.addEventListener('click',e=>{
   e.preventDefault();
   void toggleMiniHud(btn,{forcePopup:Boolean(e.shiftKey)});
  });
 }
}
