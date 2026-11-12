// 알림 설정: every notification can be switched on/off in one panel.
// Server switches (Telegram final signals; Telegram/Windows paper notices only while PAPER_TRADING=on)
// live on the server and apply to every screen; screen switches (pop-ups, sound) stay in this browser.
// Paper notice switches are hidden while automatic paper trading is off (the default).
const KEY='signalLab.notify.v1';
export const SCREEN_DEFAULTS=Object.freeze({signalScreen:true,paperScreen:true,sound:true});
export function screenNotify(){
 try{const saved=JSON.parse(localStorage.getItem(KEY)||'{}');return {...SCREEN_DEFAULTS,...Object.fromEntries(Object.entries(saved).filter(([k,v])=>k in SCREEN_DEFAULTS&&typeof v==='boolean'))}}
 catch{return {...SCREEN_DEFAULTS}}
}
export const notifyOn=key=>screenNotify()[key]!==false;
function saveScreen(next){try{localStorage.setItem(KEY,JSON.stringify(next))}catch{}}

const SERVER_ROWS=[
 {key:'telegramSignals',label:'텔레그램 · 최종 신호',hint:'90점 이상·검증 통과 신호 (종목·방향·배율·수량)'},
 {key:'telegramPaper',label:'텔레그램 · 모의 진입/청산',hint:'모의 포지션 진입·청산 결과 (실제 주문 없음)',paper:true},
 {key:'windowsPaper',label:'Windows · 모의 진입/청산',hint:'서버가 실행 중인 PC의 알림 센터',paper:true}];
const SCREEN_ROWS=[
 {key:'signalScreen',label:'화면 · 신호 팝업',hint:'이 브라우저의 신호 토스트·시스템 알림'},
 {key:'paperScreen',label:'화면 · 모의 진입/청산 팝업',hint:'모의 화면을 열어 둔 동안의 알림',paper:true},
 {key:'sound',label:'화면 · 알림 소리',hint:'신호 알림 때 짧은 소리'}];
// Paper rows only when the server reports automatic paper trading on.
export const visibleRows=(rows,server)=>rows.filter(r=>!r.paper||server?.paperTrading===true);
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let server=null;
async function loadServer(){try{const r=await fetch('/api/notifications/settings');server=r.ok?await r.json():null}catch{server=null}render()}
function row({key,label,hint},checked,disabled,note){
 return `<label class="notify-row${disabled?' disabled':''}"><input type="checkbox" data-notify="${key}" ${checked?'checked':''} ${disabled?'disabled':''}><span><b>${esc(label)}</b><small>${esc(note||hint)}</small></span></label>`;
}
function render(){
 const box=document.getElementById('notifySettings');if(!box)return;
 const screen=screenNotify();
 const serverRows=visibleRows(SERVER_ROWS,server).map(r=>{
  if(!server)return row(r,false,true,'서버 설정을 불러오지 못했습니다');
  const tg=r.key.startsWith('telegram'),off=tg&&!server.telegramConfigured?'텔레그램 미설정 (.env에 TELEGRAM_BOT_TOKEN·TELEGRAM_CHAT_ID 필요)'
   :r.key==='telegramPaper'&&server.telegramPaperForced?'PAPER_TELEGRAM 설정으로 고정됨':r.key==='windowsPaper'&&!server.windowsSupported?'Windows가 아닌 서버':'';
  return row(r,server[r.key]===true,Boolean(off),off);
 }).join('');
 box.innerHTML=`<div class="notify-group"><p>서버 알림 · 모든 화면에 적용</p>${serverRows}</div><div class="notify-group"><p>화면 알림 · 이 브라우저만</p>${visibleRows(SCREEN_ROWS,server).map(r=>row(r,screen[r.key],false)).join('')}</div><p class="notify-status" id="notifySettingsStatus" aria-live="polite"></p>`;
}
document.addEventListener('change',async e=>{
 const input=e.target.closest?.('input[data-notify]');if(!input)return;
 const key=input.dataset.notify,value=input.checked,status=()=>document.getElementById('notifySettingsStatus');
 if(key in SCREEN_DEFAULTS){saveScreen({...screenNotify(),[key]:value});if(status())status().textContent='저장됨 (이 브라우저)';return}
 input.disabled=true;
 try{const r=await fetch('/api/notifications/settings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({[key]:value})});
  const data=await r.json();if(!r.ok)throw Error(data.error||'저장 실패');server=data;render();if(status())status().textContent='저장됨 (서버)';}
 catch(err){input.checked=!value;input.disabled=false;if(status())status().textContent='저장 실패: '+err.message}
});
try{const es=new EventSource('/events');es.addEventListener('notify-settings',e=>{try{server=JSON.parse(e.data);render()}catch{}});}catch{}
render();void loadServer();
