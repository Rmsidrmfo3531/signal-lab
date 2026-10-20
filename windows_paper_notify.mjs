/** Best-effort Windows tray notification for *simulated* positions.
 * Does not require a browser or third-party modules. No live broker orders.
 * Whether Windows actually displays it depends on the interactive desktop,
 * Focus Assist/Do Not Disturb, app notification settings, and user session.
 */
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {join,dirname} from 'node:path';

export function paperNotificationText(event){
  if(!event||!['OPEN','CLOSE'].includes(event.type))throw Error('Invalid paper event');
  const symbol=String(event.symbol||'').replace(/[^A-Za-z0-9.-]/g,'').slice(0,24);
  const dir=event.direction==='SHORT'?'SHORT':'LONG';
  const price=n=>Number.isFinite(Number(n))&&Number(n)>0?Number(n).toLocaleString('en-US',{maximumFractionDigits:8}):'—';
  const pnl=Number(event.realizedPnLUSD||0);
  if(event.type==='OPEN')return {title:`[SIM / 가상 진입] ${symbol} ${dir}`,body:`모의 진입 ${price(event.entryFill)} | 명목 $${price(event.notionalUSD)} | 실제 주문 없음`};
  return {title:`[SIM / 가상 CLOSE] ${symbol} ${dir}`,body:`모의 종료 ${event.closeReason==='STOP'?'손절':'목표가'} ${price(event.lastExitFill)} | 실현 PNL ${pnl>=0?'+$':'-$'}${Math.abs(pnl).toFixed(2)} | 실제 주문 없음`};
}

export function windowsPaperNotify(event,{platform=process.platform,launch=spawn,script=join(dirname(fileURLToPath(import.meta.url)),'windows_paper_notify.ps1')}={}){
  if(platform!=='win32')return {queued:false,reason:'Windows가 아닌 서버'};
  const {title,body}=paperNotificationText(event);
  const arg=s=>Buffer.from(s,'utf8').toString('base64');
  try{
    const process=launch('powershell.exe',['-NoProfile','-NonInteractive','-STA','-ExecutionPolicy','Bypass','-File',script,'-Title64',arg(title),'-Body64',arg(body)],{
      windowsHide:true,detached:true,stdio:'ignore'
    });
    process.on?.('error',err=>console.warn('[PAPER WINDOWS NOTIFY]',err.message));
    process.unref?.();
    return {queued:true,reason:'Windows에 표시 요청 (실제 노출 여부는 알림 설정에 따름)'};
  }catch(e){return {queued:false,reason:e.message}}
}
