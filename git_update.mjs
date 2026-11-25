// One-tap update for the cloud server: the app folder is a git checkout (deploy/linux/install.sh,
// read-only deploy key) and systemd restarts the process when it exits. Fast-forward only, the new
// server.mjs is syntax-checked before the restart, and live trading starts disarmed after it.
import {execFile,execFileSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const run=(cwd,args,timeout=60000)=>new Promise((resolve,reject)=>execFile('git',args,{cwd,timeout,maxBuffer:1<<20},(error,stdout,stderr)=>
 error?reject(Object.assign(Error(String(stderr||error.message).trim().split('\n').slice(-1)[0]||'git failed'),{code:'GIT_FAILED'})):resolve(String(stdout).trim())));

/** Available only in a git checkout run by systemd (INVOCATION_ID), i.e. the cloud install. */
export function gitUpdateAvailable(root,env=process.env){return fs.existsSync(path.join(root,'.git'))&&Boolean(env.INVOCATION_ID||env.SIGNAL_LAB_GIT_UPDATE==='1')}

export function displayVersionOf(info){
 const named=typeof info?.displayVersion==='string'?info.displayVersion.trim():'';
 return named||(typeof info?.version==='string'&&info.version.trim()?'v'+info.version.trim():null);
}
// The version shown in the header is the running commit (user 2026-11-24 "이 부분에 있는 버전이 업데이트할 때마다 변경되어있지
// 않아 수정해줘"): its commit time in KST plus the short hash, so every update changes it without editing package.json.
const KST_MS=9*3600000;
export function commitDisplayVersion(iso,sha){
 const t=Date.parse(String(iso||'').trim()),h=String(sha||'').trim().slice(0,7);
 if(!Number.isFinite(t)||!h)return null;
 const d=new Date(t+KST_MS).toISOString();return `${d.slice(0,10)} ${d.slice(11,16)} KST · ${h}`;
}
/** The running checkout's version, read synchronously at boot; null outside a git checkout. */
export function headDisplayVersionSync(root){
 if(!fs.existsSync(path.join(root,'.git')))return null;
 try{const [iso,sha]=String(execFileSync('git',['-C',root,'show','-s','--format=%cI|%h','HEAD'],{timeout:5000,stdio:['ignore','pipe','ignore']})).trim().split('|');return commitDisplayVersion(iso,sha)}catch{return null}
}
async function versionAt(root,git,commit){
 try{const v=commitDisplayVersion(await git(root,['show','-s','--format=%cI',commit]),commit);if(v)return v}catch{}
 try{return displayVersionOf(JSON.parse(await git(root,['show',commit+':package.json'])))}catch{return null}
}

/** Fetch origin/main and list what an update would bring. */
export async function gitCheck(root,{git=run}={}){
 await git(root,['fetch','--quiet','origin','main']);
 const current=await git(root,['rev-parse','--short','HEAD']),latest=await git(root,['rev-parse','--short','origin/main']);
 const currentDisplayVersion=await versionAt(root,git,current);
 const latestDisplayVersion=current===latest?currentDisplayVersion:await versionAt(root,git,latest);
 const head={current,latest,currentDisplayVersion,latestDisplayVersion};
 if(current===latest)return {state:'current',...head,changes:[]};
 const log=await git(root,['log','--format=%h %s','-n','15','HEAD..origin/main']);
 const changes=log?log.split('\n').filter(Boolean).map(l=>({sha:l.slice(0,l.indexOf(' ')),subject:l.slice(l.indexOf(' ')+1)})):[];
 if(!changes.length)return {state:'diverged',...head,changes,message:'서버 코드가 GitHub와 다릅니다. 업데이트 스크립트로 직접 확인하세요.'};
 return {state:'available',...head,changes};
}

/** Fast-forward to origin/main; roll back if the new server.mjs does not parse. Caller restarts. */
export async function gitApply(root,{git=run,checkSyntax,onStep=()=>{}}={}){
 const before=await gitCheck(root,{git});onStep('fetched',before);
 if(before.state!=='available')return {ok:before.state==='current',...before};
 await git(root,['merge','--ff-only','origin/main']);onStep('merged');
 const after=await git(root,['rev-parse','--short','HEAD']);
 try{await checkSyntax(root)}
 catch(error){await git(root,['reset','--hard',before.current]);return {ok:false,state:'rolled-back',current:before.current,latest:before.latest,message:'새 버전 검사 실패로 되돌렸습니다: '+error.message}}
 return {ok:true,state:'applied',from:before.current,to:after,changes:before.changes,
  fromDisplayVersion:before.currentDisplayVersion,toDisplayVersion:after===before.latest?before.latestDisplayVersion:await versionAt(root,git,after)};
}

/** Every .mjs at the root and every public script parses, and every relative import of the root
 * modules points at a file that exists (node --check does not follow imports). */
export async function checkTree(root,{nodeCheck,onFile=()=>{}}){
 const files=fs.readdirSync(root).filter(f=>f.endsWith('.mjs')).map(f=>path.join(root,f))
  .concat(fs.existsSync(path.join(root,'public'))?fs.readdirSync(path.join(root,'public')).filter(f=>f.endsWith('.js')).map(f=>path.join(root,'public',f)):[]);
 for(const [i,file] of files.entries()){
  await nodeCheck(file);onFile(i+1,files.length);
  if(!file.endsWith('.mjs'))continue;
  for(const m of fs.readFileSync(file,'utf8').matchAll(/(?:^|\n)\s*import\s[^'"]*?from\s*['"](\.[^'"]+)['"]/g)){
   const target=path.resolve(path.dirname(file),m[1]);
   if(!fs.existsSync(target))throw Error(`${path.basename(file)}: ${m[1]} 없음`);
  }
 }
 return files.length;
}

export const LAST_VERSION_FILE='last-notified-version.json';
const NOTICE_RULE='━━━━━━━━━━━━━━━━';
const escHtml=s=>String(s??'').replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));

const COMMIT_TYPE_KO={
 feat:'신규',
 fix:'수정',
 perf:'성능',
 refactor:'개선',
 style:'화면',
 docs:'문서',
 chore:'관리',
 test:'테스트',
 ci:'검증',
 build:'빌드',
 revert:'되돌림',
};
const COMMIT_SCOPE_KO={
 scalp:'단타',
 copy:'카피',
 live:'실계좌',
 real:'실계좌',
 testnet:'테스트넷',
 ui:'화면',
 web:'화면',
 dashboard:'화면',
 telegram:'텔레그램',
 tg:'텔레그램',
 update:'업데이트',
 updater:'업데이트',
 news:'뉴스',
 orderflow:'수급',
 whale:'고래',
 ops:'운영',
 deploy:'배포',
 risk:'리스크',
 safety:'안전장치',
};
const UPDATE_STATE_KO={
 diverged:'서버 코드가 GitHub와 달라 자동 적용을 건너뛰었습니다.',
 'rolled-back':'새 버전 파일 검사에 실패해 이전 버전으로 안전하게 되돌렸습니다.',
 failed:'업데이트 처리 중 오류가 발생해 이전 버전을 유지했습니다.',
};

/** Parse a git commit subject into Korean category badge, clean body text, and optional PR tag. */
export function parseCommitSubject(raw){
 let text=String(typeof raw==='string'?raw:raw?.subject||'').replace(/\s+/g,' ').trim();
 if(!text)return null;
 let pr='';
 const prMatch=text.match(/\s*\((#\d+)\)\s*$/);
 if(prMatch){pr=prMatch[1];text=text.slice(0,prMatch.index).trim()}
 let badge='';
 const cc=text.match(/^([a-zA-Z]+)(?:\(([^)]+)\))?!?:\s*(.+)$/);
 if(cc){
  const typeKo=COMMIT_TYPE_KO[cc[1].toLowerCase()]||'';
  const rawScope=String(cc[2]||'').trim();
  const scopeKo=rawScope?(COMMIT_SCOPE_KO[rawScope.toLowerCase()]||(/[가-힣]/.test(rawScope)?rawScope:'')):'';
  const parts=[scopeKo,typeKo].filter(Boolean);
  if(parts.length)badge=`[${parts.join('·')}]`;
  text=cc[3].trim();
 }
 return {badge,body:text,pr};
}

/** True when a commit description is primarily English and should be translated to Korean. */
export function needsKoreanTranslation(text){
 const s=String(text||'').trim();
 if(!s)return false;
 if(/[가-힣]{2,}/.test(s))return false;
 return /[A-Za-z]{3,}/.test(s);
}

function protectCryptoTermsForTranslate(text){
 return String(text||'')
  .replace(/\bTRADER_LADDER\b/g,'카피식 추매')
  .replace(/\bscalp(?:ing)?\b/gi,'단타 매매')
  .replace(/\btestnet\b/gi,'테스트넷')
  .replace(/\bmaxMarginPct\b/g,'최대 증거금 비중')
  .replace(/\bmaxTotalMarginPct\b/g,'총 증거금 한도')
  .replace(/\bsizeMult\b/g,'수량 배수')
  .replace(/\bcopy trading\b/gi,'카피 매매')
  .replace(/\borderflow\b/gi,'호가·수급')
  .replace(/\bstop[- ]?loss\b/gi,'손절')
  .replace(/\btake[- ]?profit\b/gi,'익절');
}

function polishCryptoKorean(text){
 return String(text||'')
  .replace(/두피/g,'단타')
  .replace(/스캘핑|스캘프/g,'단타')
  .replace(/테스트\s*넷/g,'테스트넷')
  .replace(/알트\s*코인/g,'알트코인')
  .replace(/비트\s*코인/g,'비트코인')
  .replace(/도미\s*넌스/g,'도미넌스')
  .replace(/복사\s*거래|카피\s*트레이딩/g,'카피 매매')
  .replace(/상대\s*강도/g,'상대강도')
  .replace(/\s+/g,' ')
  .trim();
}

/** Translate English commit subjects into concise Korean with category badges (safe timeout & fallback). */
export async function localizeUpdateChanges(changes,{translate=null,timeoutMs=4500}={}){
 const rawList=(Array.isArray(changes)?changes:[]).slice(0,8);
 const parsed=rawList.map(c=>{
  if(c&&typeof c==='object'&&typeof c.localized==='string')return {already:true,item:c};
  return {already:false,parsed:parseCommitSubject(c)};
 }).filter(x=>x.already||x.parsed);
 if(!parsed.length)return [];
 return Promise.all(parsed.map(async entry=>{
  if(entry.already)return entry.item;
  const {badge,body,pr}=entry.parsed;
  let text=body;
  if(needsKoreanTranslation(body)&&typeof translate==='function'){
   try{
    const prepared=protectCryptoTermsForTranslate(body);
    const out=await translate({text:prepared,signal:AbortSignal.timeout(timeoutMs)});
    const translated=typeof out==='string'?out:out?.translatedText;
    if(translated&&/[가-힣]/.test(translated)){
     text=polishCryptoKorean(translated);
    }
   }catch{}
  }
  return {badge:badge||'[변경]',text,pr,localized:`${badge?badge+' ':''}${text}${pr?` ${pr}`:''}`.trim()};
 }));
}

function splitDisplayVersion(disp,fallbackSha=''){
 const s=String(disp||'').trim();
 if(!s)return {label:'',sha:String(fallbackSha||'').trim()};
 const m=s.match(/^(.+?)\s*·\s*([0-9a-f]{6,12})$/i);
 if(m)return {label:m[1].trim(),sha:m[2].trim()};
 const sha=String(fallbackSha||'').trim();
 return {label:s,sha:sha&&!s.includes(sha)?sha:''};
}

function formatVersionPiece(disp,fallbackSha,html){
 const {label,sha}=splitDisplayVersion(disp,fallbackSha);
 if(!label&&!sha)return '';
 const safeLabel=html?escHtml(label):label;
 const safeSha=sha?(html?`<code>${escHtml(sha)}</code>`:sha):'';
 if(safeLabel&&safeSha)return `${safeLabel} (${safeSha})`;
 return safeLabel||safeSha;
}

/** Format a clean, high-visibility Korean Telegram confirmation after the new version boots cleanly. */
export function formatUpdateCompletedNotice({version=null,displayVersion=null,fromDisplayVersion=null,to=null,source=null,changes=[],restored=[],html=false}={}){
 const cur=displayVersion||(version?`v${version}`:'새 버전');
 const kind=(source==='manual'||source==='button')?'수동 업데이트 완료':source==='auto'?'자동 업데이트 완료':'버전 업데이트 완료';
 const B=t=>html?`<b>${escHtml(t)}</b>`:t;
 const C=t=>html?`<code>${escHtml(t)}</code>`:t;
 const E=t=>html?escHtml(t):String(t??'');

 const lines=[`✅ ${B(`Signal Lab ${kind}`)}`,NOTICE_RULE];
 if(version)lines.push(`📦 ${B('버전')}  ${C(`v${version}`)}`);
 const appliedStr=formatVersionPiece(displayVersion||cur,to,html);
 if(appliedStr)lines.push(`🕒 ${B('적용')}  ${appliedStr}`);
 if(fromDisplayVersion&&fromDisplayVersion!==cur){
  const prevStr=formatVersionPiece(fromDisplayVersion,'',html);
  if(prevStr)lines.push(`🔁 ${B('이전')}  ${prevStr}`);
 }

 const normalized=(Array.isArray(changes)?changes:[]).slice(0,8).map(item=>{
  if(item&&typeof item==='object'&&typeof item.text==='string'){
   return {badge:item.badge||'',text:item.text,pr:item.pr||''};
  }
  const p=parseCommitSubject(item);
  return p?{badge:p.badge,text:p.body,pr:p.pr}:null;
 }).filter(Boolean);

 if(normalized.length){
  lines.push('');
  lines.push(`📝 ${B(`주요 변경 내역 (${normalized.length}건)`)}`);
  normalized.forEach((item,idx)=>{
   const badgePart=item.badge?`${B(item.badge)} `:'';
   const prPart=item.pr?` ${C(item.pr)}`:'';
   lines.push(`${idx+1}. ${badgePart}${E(item.text)}${prPart}`);
  });
 }

 lines.push('');
 if(Array.isArray(restored)&&restored.length){
  lines.push(`⚡ ${B('자동 복원 현황')}`);
  for(const item of restored)lines.push(`• ${E(item)}`);
 }else{
  lines.push(`🟢 ${B('상태')}  새 버전으로 서버가 정상 시작되었습니다.`);
 }
 return lines.join('\n');
}

/** Format an update abort or failure notice in readable Korean for Telegram. */
export function formatUpdateErrorNotice({kind='aborted',source='auto',state='',message='',html=false}={}){
 const isFail=kind==='failed';
 const icon=isFail?'🚨':'⚠️';
 const prefix=source==='auto'?'자동 업데이트':'업데이트';
 const title=`Signal Lab ${prefix} ${isFail?'실패':'중단'}`;
 const B=t=>html?`<b>${escHtml(t)}</b>`:t;
 const C=t=>html?`<code>${escHtml(t)}</code>`:t;
 const E=t=>html?escHtml(t):String(t??'');

 const rawMsg=String(message||'').trim();
 const stateKo=UPDATE_STATE_KO[state]||'';
 const reason=rawMsg&&/[가-힣]/.test(rawMsg)?rawMsg:(stateKo||'업데이트 처리 중 문제가 발생해 기존 버전을 유지했습니다.');
 const lines=[`${icon} ${B(title)}`,NOTICE_RULE,`📌 ${B('사유')}  ${E(reason)}`];
 if(rawMsg&&!/[가-힣]/.test(rawMsg)){
  lines.push(`🧾 ${B('상세')}  ${C(rawMsg.slice(0,220))}`);
 }
 lines.push(`💡 ${B('안내')}  기존 버전으로 정상 동작 중입니다.`);
 return lines.join('\n');
}

/** Detect whether this boot is a newly updated version and persist the latest notified version marker. */
export function detectPostUpdateNotice({dir,appVersion,marker=null,restored=[],now=Date.now()}={}){
 if(!dir||!appVersion)return null;
 const file=path.join(dir,LAST_VERSION_FILE);
 let prev=null;
 try{if(fs.existsSync(file))prev=JSON.parse(fs.readFileSync(file,'utf8'))}catch{}
 const curVer=appVersion.version??null;
 const curDisp=appVersion.displayVersion??null;
 try{
  fs.mkdirSync(dir,{recursive:true});
  fs.writeFileSync(file,JSON.stringify({version:curVer,displayVersion:curDisp,at:now}));
 }catch{}
 if(marker&&Number.isFinite(Number(marker.at))&&now-Number(marker.at)<30*60000){
  return {
   version:curVer,
   displayVersion:curDisp||marker.toDisplayVersion||null,
   fromDisplayVersion:marker.fromDisplayVersion||prev?.displayVersion||null,
   to:marker.to||null,
   source:marker.source||null,
   changes:marker.changes||[],
   restored,
  };
 }
 const prevId=prev?displayVersionOf(prev):null;
 const curId=displayVersionOf(appVersion);
 if(prev&&((curId&&prevId&&prevId!==curId)||(curVer&&prev.version&&prev.version!==curVer))){
  return {
   version:curVer,
   displayVersion:curDisp,
   fromDisplayVersion:prevId||prev.version||null,
   source:'restart',
   changes:[],
   restored,
  };
 }
 return null;
}

/** Detect whether this boot is a newly updated version (via rearm marker or persisted version change) and format the notice. */
export function checkPostUpdateNotice({dir,appVersion,marker=null,restored=[],now=Date.now(),html=false}={}){
 const event=detectPostUpdateNotice({dir,appVersion,marker,restored,now});
 return event?formatUpdateCompletedNotice({...event,html}):null;
}


