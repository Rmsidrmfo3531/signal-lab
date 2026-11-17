// Browser (screen) notification switches kept in this browser only.
// The 알림 · 시스템 settings panel was removed from the dashboard (user request 2026-11-17);
// the server keeps its saved Telegram switches (/api/notifications/settings) unchanged,
// and switches saved earlier in this browser still apply to the testnet/copy notices.
const KEY='signalLab.notify.v1';
export const SCREEN_DEFAULTS=Object.freeze({signalScreen:true,liveScreen:true,paperScreen:true,sound:true});
export function screenNotify(){
 try{const saved=JSON.parse(localStorage.getItem(KEY)||'{}');return {...SCREEN_DEFAULTS,...Object.fromEntries(Object.entries(saved).filter(([k,v])=>k in SCREEN_DEFAULTS&&typeof v==='boolean'))}}
 catch{return {...SCREEN_DEFAULTS}}
}
export const notifyOn=key=>screenNotify()[key]!==false;
