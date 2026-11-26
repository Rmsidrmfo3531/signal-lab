// Public Telegram channel monitor -> Chinese-to-Korean trading post translator & alert feed.
// Uses Telegram's public web preview (https://t.me/s/<channel>, no login required).
// Filters strictly for trading-related posts (skips referral ads & empty 0-position snapshots),
// translates Chinese trading terminology + free-form commentary into Korean, and NEVER places automatic orders.

import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_CHANNELS=['aoying999'];
const MAX_STORED_POSTS=40;
const MIN_POLL_MS=15_000;

/** Normalize WATCH_TELEGRAM_CHANNELS env value into public Telegram channel handles. */
export function parseChannelHandles(raw,{defaultChannels=DEFAULT_CHANNELS}={}){
 if(raw===undefined||raw===null||String(raw).trim()==='')return [...defaultChannels];
 const trimmed=String(raw).trim();
 if(/^(?:off|false|0|none)$/i.test(trimmed))return [];
 const out=[];
 for(const part of trimmed.split(/[,\s]+/)){
  const s=part.trim()
   .replace(/^https?:\/\/(?:t\.me|telegram\.me)\/(?:s\/)?/i,'')
   .replace(/^@/,'')
   .replace(/\/.*$/,'')
   .trim();
  if(/^[A-Za-z][A-Za-z0-9_]{3,31}$/.test(s)&&!out.includes(s.toLowerCase()))out.push(s.toLowerCase());
 }
 return out;
}

function decodeHtmlEntities(s){
 return String(s||'')
  .replace(/&#(\d+);/g,(_,n)=>{const c=Number(n);return Number.isFinite(c)?String.fromCodePoint(c):''})
  .replace(/&#x([0-9a-f]+);/gi,(_,h)=>{const c=parseInt(h,16);return Number.isFinite(c)?String.fromCodePoint(c):''})
  .replace(/&nbsp;/gi,' ')
  .replace(/&amp;/g,'&')
  .replace(/&lt;/g,'<')
  .replace(/&gt;/g,'>')
  .replace(/&quot;/g,'"')
  .replace(/&apos;|&#39;/g,"'");
}

/** Parse public Telegram web preview HTML (https://t.me/s/<channel>) into chronological post objects. */
export function parseTelegramWebPosts(html,channel){
 const ch=String(channel||'').replace(/^@/,'').trim();
 if(!html||typeof html!=='string'||!ch)return [];
 const titleMatch=html.match(/<meta\s+property="og:title"\s+content="([^"]*)"/i);
 const channelTitle=titleMatch?decodeHtmlEntities(titleMatch[1]).trim():ch;
 const blocks=html.split(/<div\s+class="tgme_widget_message_wrap\b/).slice(1);
 const posts=[];
 for(const block of blocks){
  const postAttr=block.match(/data-post="([^"]+)"/i)?.[1]||'';
  const numMatch=postAttr.match(/\/(\d+)$/);
  if(!numMatch)continue;
  const postNum=Number(numMatch[1]);
  if(!Number.isFinite(postNum)||postNum<=0)continue;
  const dtStr=block.match(/<time\b[^>]*datetime="([^"]+)"/i)?.[1]||'';
  const parsedDt=dtStr?Date.parse(dtStr):NaN;
  const publishedAt=Number.isFinite(parsedDt)?parsedDt:Date.now();
  const textMatch=block.match(/<div\s+class="tgme_widget_message_text\b[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
  const rawHtml=textMatch?textMatch[1]:'';
  const text=decodeHtmlEntities(
   rawHtml
    .replace(/<br\s*\/?>/gi,'\n')
    .replace(/<\/p>/gi,'\n')
    .replace(/<[^>]+>/g,'')
  ).replace(/\r\n/g,'\n').replace(/\n{3,}/g,'\n\n').trim();
  if(!text)continue;
  posts.push({
   id:`${ch}/${postNum}`,
   channel:ch,
   channelTitle,
   postNum,
   url:`https://t.me/${ch}/${postNum}`,
   publishedAt,
   text,
  });
 }
 posts.sort((a,b)=>a.postNum-b.postNum);
 return posts;
}

const PROMO_LINE_RE=/^(?:✅|👉|👇|🔥|💎|📣)?\s*(?:点击(?:欧易|币安|订阅|注册|绑定)|永久\d+折|邀请码|拉你进群|私聊我|联系我|订阅其它大神|手续费返佣|返佣|注册新号|老号可以绑定)/i;

/** Remove affiliate/referral promotional footer lines from channel messages. */
export function stripChannelPromoLines(text){
 return String(text||'')
  .split('\n')
  .map(l=>l.trim())
  .filter(l=>!PROMO_LINE_RE.test(l)&&!/(?:点击欧易|点击币安|永久8折|点击订阅其它大神|邀请码.*UU\d+|拉你进群)/i.test(l))
  .join('\n')
  .replace(/\n{3,}/g,'\n\n')
  .trim();
}

function parseNum(raw){
 if(raw==null)return null;
 const s=String(raw).replace(/[,$\s]/g,'').trim();
 if(!s||!/^-?\d+(?:\.\d+)?$/.test(s))return null;
 const n=Number(s);
 return Number.isFinite(n)?n:null;
}

function extractSymbolFromPost(text){
 const s=String(text||'');
 const m=s.match(/\b([A-Z0-9]{2,14})(?:[/-]?)USDT\b/i)
  ||s.match(/(?:^|[\s·:：(\[#])([A-Z0-9]{2,14})(?:\s*永续)/i)
  ||s.match(/[$#]([A-Z][A-Z0-9]{1,12})\b/i);
 if(!m)return '';
 const base=m[1].toUpperCase().replace(/[^A-Z0-9]/g,'');
 if(!base||base.length<2||/^\d+$/.test(base)||['USDT','USD','UID','VIP','APP'].includes(base))return '';
 return `${base}USDT`;
}

function extractDirectionFromPost(text){
 const s=String(text||'');
 // Check headline/action line first so close-short (平空) resolves to SHORT, open-long (做多) to LONG.
 const firstLines=s.split('\n').slice(0,8).join('\n');
 if(/(?:做多|开多|平多|多单|·\s*多(?:\s|$)|\bLONG\b)/i.test(firstLines))return 'LONG';
 if(/(?:做空|开空|平空|空单|·\s*空(?:\s|$)|\bSHORT\b)/i.test(firstLines))return 'SHORT';
 if(/(?:做多|开多|多单|\bLONG\b)/i.test(s))return 'LONG';
 if(/(?:做空|开空|空单|\bSHORT\b)/i.test(s))return 'SHORT';
 return '';
}

const ACTION_META={
 OPEN:{labelKo:'신규 진입',emoji:'🟢'},
 ADD:{labelKo:'추매(포지션 확대)',emoji:'📈'},
 REDUCE:{labelKo:'부분 청산(비중 축소)',emoji:'📉'},
 CLOSE:{labelKo:'전량 청산',emoji:'🔴'},
 LIQUIDATION:{labelKo:'강제 청산',emoji:'💥'},
 SNAPSHOT:{labelKo:'보유 포지션 현황',emoji:'📊'},
 SIGNAL:{labelKo:'매매 코멘트',emoji:'📌'},
};

/** Classify whether a channel post is trading-related (skipping ads, promos, and 0-position heartbeats). */
export function classifyTradingChannelPost(rawText){
 const text=stripChannelPromoLines(rawText);
 if(!text)return {isTrading:false,reason:'EMPTY'};

 // Filter out promotional/membership/referral recruitment posts without concrete trade actions
 const hasTradeAction=/(?:开仓|加仓|补仓|减仓|平仓|爆仓|平多|平空|止盈|止损|持仓快照|当前全部持仓)/i.test(text);
 const isPromoOnly=/(?:邀请码|拉你进群|私聊我|联系我|会员群|返佣|注册新号|老号可以绑定|进群)/i.test(rawText)&&!hasTradeAction;
 if(isPromoOnly)return {isTrading:false,reason:'PROMO_AD'};

 const symbol=extractSymbolFromPost(text);
 const side=extractDirectionFromPost(text);

 // Filter out empty 0-position status snapshots (not a close event)
 const isCloseEvent=/(?:平仓|爆仓|平多|平空|已全部平仓)/.test(text);
 const isEmptySnapshot=(/【持仓数量】\s*0\b/.test(text)||/当前无持仓/.test(text))&&!isCloseEvent;
 if(isEmptySnapshot)return {isTrading:false,reason:'EMPTY_SNAPSHOT'};

 let action='';
 if(/爆仓/.test(text)&&/🔴|💥|爆仓\s*·/.test(text))action='LIQUIDATION';
 else if(/(?:🔴\s*平仓|平仓\s*·|平多|平空|已全部平仓)/.test(text))action='CLOSE';
 else if(/(?:🟢\s*开仓|开仓\s*·|新开仓|开多|开空)/.test(text))action='OPEN';
 else if(/(?:📈\s*加仓|加仓\s*·|补仓)/.test(text))action='ADD';
 else if(/(?:📉\s*减仓|减仓\s*·|部分平仓|部分止盈)/.test(text))action='REDUCE';
 else if(/(?:当前全部持仓|持仓快照)/.test(text)&&symbol)action='SNAPSHOT';
 else if(symbol&&/(?:做多|做空|多单|空单|止盈|止损|目标|入场|进场|建仓|抄底|逃顶|突破|支撑|阻力|仓位|\b(?:long|short|tp|sl|entry)\b)/i.test(text))action='SIGNAL';

 if(!action)return {isTrading:false,reason:'NON_TRADING'};

 const entryPrice=parseNum(
  text.match(/【(?:本次开仓均价|本次加仓均价|开仓后持仓均价|加仓后持仓均价|持仓均价|平仓前持仓均价|入场价|进场价)】\s*([\d,]+(?:\.\d+)?)/)?.[1]
 );
 const avgPrice=parseNum(text.match(/【(?:开仓后持仓均价|加仓后持仓均价|持仓均价|平仓前持仓均价)】\s*([\d,]+(?:\.\d+)?)/)?.[1]);
 const markPrice=parseNum(text.match(/【标记价格】\s*([\d,]+(?:\.\d+)?)/)?.[1]);
 const liqPrice=parseNum(text.match(/【强平价格】\s*([\d,]+(?:\.\d+)?)/)?.[1]);
 const leverage=parseNum(text.match(/【实际杠杆】\s*([\d.]+)\s*x/i)?.[1]||text.match(/\b(\d{1,3})\s*x\b/i)?.[1]);
 const marginMode=/逐仓|isolated/i.test(text)?'ISOLATED':/全仓|cross/i.test(text)?'CROSSED':null;
 const pnlText=(text.match(/【(?:浮动收益|总浮动收益|本次已实现盈亏)】\s*([^\n]+)/)?.[1]||'').trim()||null;
 const qtyChange=(text.match(/【原仓位】\s*([^\n]+)/)?.[1]||text.match(/【(?:开仓量|加仓量|平仓量|持仓量)】\s*([^\n·]+)/)?.[1]||'').trim()||null;
 const meta=ACTION_META[action]||ACTION_META.SIGNAL;

 return {
  isTrading:true,
  action,
  actionKo:meta.labelKo,
  emoji:meta.emoji,
  symbol,
  side,
  entryPrice:entryPrice??avgPrice??null,
  avgPrice:avgPrice??entryPrice??null,
  markPrice,
  liqPrice,
  leverage:leverage&&leverage>0?Number(leverage):null,
  marginMode,
  pnlText,
  qtyChange,
 };
}

// Deterministic Chinese -> Korean trading glossary replacements so core trade metrics stay accurate even offline.
const ZH_KO_REPLACEMENTS=[
 [/【熬鹰币安实盘】/g,'[아오잉(熬鹰) 바이낸스 실계좌]'],
 [/熬鹰当前全部持仓/g,'아오잉 현재 전체 보유 포지션'],
 [/【持仓数量】/g,'[보유 종목 수]'],
 [/【本次开仓均价】/g,'[신규 진입 평단]'],
 [/【开仓后持仓均价】/g,'[진입 후 보유 평단]'],
 [/【本次加仓均价】/g,'[추매 체결 평단]'],
 [/【加仓后持仓均价】/g,'[추매 후 보유 평단]'],
 [/【本次平仓均价】/g,'[청산 체결 평단]'],
 [/【平仓前持仓均价】/g,'[청산 전 보유 평단]'],
 [/【本次已实现盈亏】/g,'[실현 손익]'],
 [/【开仓量】/g,'[진입 수량]'],
 [/【加仓量】/g,'[추매 수량]'],
 [/【平仓量】/g,'[청산 수량]'],
 [/【原仓位】/g,'[기존 포지션]'],
 [/【现仓位】/g,'[현재 포지션]'],
 [/【仓位模式】/g,'[마진 모드]'],
 [/【标记价格】/g,'[마크가]'],
 [/【持仓量】/g,'[보유 수량]'],
 [/【持仓均价】/g,'[보유 평단]'],
 [/【浮动收益】/g,'[미실현 손익]'],
 [/【总浮动收益】/g,'[총 미실현 손익]'],
 [/【实际杠杆】/g,'[실제 레버리지]'],
 [/【强平价格】/g,'[청산가]'],
 [/【账户保证金】/g,'[계좌 증거금]'],
 [/【持仓快照】/g,'[포지션 스냅샷 시각]'],
 [/（按成交推算）/g,' (체결 기준 추정)'],
 [/（北京时间）/g,' (중국시간)'],
 [/待成交记录确认/g,'체결 기록 확인 대기'],
 [/已全部平仓/g,'전량 청산 완료'],
 [/当前持仓\s*·\s*(\d+)\s*个/g,'현재 보유 포지션 · $1개'],
 [/当前无持仓/g,'현재 보유 포지션 없음'],
 [/永续/g,'무기한 선물'],
 [/做多/g,'롱(매수)'],
 [/做空/g,'숏(매도)'],
 [/平多/g,'롱 청산'],
 [/平空/g,'숏 청산'],
 [/开仓/g,'신규 진입'],
 [/加仓/g,'추매(포지션 확대)'],
 [/减仓/g,'부분 청산'],
 [/平仓/g,'전량 청산'],
 [/爆仓/g,'강제 청산'],
 [/全仓/g,'교차'],
 [/逐仓/g,'격리'],
 [/·\s*多(?=\s|$)/g,'· 롱'],
 [/·\s*空(?=\s|$)/g,'· 숏'],
];

/** Translate Chinese trading post into clean Korean using deterministic glossary + optional MT fallback for free-form lines. */
export async function translateChineseTradeText(rawText,{translate=null}={}){
 const cleaned=stripChannelPromoLines(rawText);
 if(!cleaned)return '';
 let text=cleaned;
 for(const [re,ko] of ZH_KO_REPLACEMENTS)text=text.replace(re,ko);

 // If free-form Chinese commentary remains (2+ consecutive Hanzi outside brand name), translate those lines via MT.
 const lines=text.split('\n');
 const needIdx=[];
 for(let i=0;i<lines.length;i++){
  const stripped=lines[i].replace(/熬鹰/g,'');
  if(/[\u4e00-\u9fff]{2,}/.test(stripped))needIdx.push(i);
 }
 if(needIdx.length&&typeof translate==='function'){
  const joined=needIdx.map(i=>lines[i]).join('\n');
  try{
   const ctrl=new AbortController();
   const timer=setTimeout(()=>ctrl.abort(),6000);
   timer.unref?.();
   let res;
   try{res=await translate({text:joined,sourceLanguage:'zh-CN',targetLanguage:'ko',signal:ctrl.signal})}
   finally{clearTimeout(timer)}
   const translated=typeof res==='string'?res:(typeof res?.translatedText==='string'?res.translatedText:'');
   if(translated&&/[가-힣]/.test(translated)){
    const outLines=translated.split('\n');
    if(outLines.length===needIdx.length){
     needIdx.forEach((idx,j)=>{if(outLines[j]?.trim())lines[idx]=outLines[j].trim()});
     text=lines.join('\n');
    }else if(needIdx.length===lines.length){
     text=translated.trim();
    }else{
     // Replace the remaining Chinese lines block cleanly
     lines[needIdx[0]]=translated.trim();
     for(let k=1;k<needIdx.length;k++)lines[needIdx[k]]='';
     text=lines.filter((l,idx)=>l!==''||!needIdx.includes(idx)).join('\n');
    }
   }
  }catch{}
 }
 return text.replace(/\n{3,}/g,'\n\n').trim();
}

/** Collapse rapid consecutive ADD/REDUCE slices for the same symbol/side within one poll batch to prevent alert spam. */
export function collapseBatchAlerts(posts){
 const list=Array.isArray(posts)?posts:[];
 const out=[];
 for(const p of list){
  const prev=out.at(-1);
  const collapsible=(p.action==='ADD'||p.action==='REDUCE')
   &&prev&&prev.channel===p.channel&&prev.symbol===p.symbol&&prev.side===p.side&&prev.action===p.action;
  if(collapsible){
   out[out.length-1]={...p,mergedCount:(prev.mergedCount||1)+1,firstPostNum:prev.firstPostNum||prev.postNum};
  }else{
   out.push({...p,mergedCount:1});
  }
 }
 return out;
}

/** Compact Korean alert line for dashboard SSE browser/sound notifications. */
export function formatChannelAlertNotice(post){
 const dirKo=post.side==='LONG'?'🟢 롱':post.side==='SHORT'?'🔴 숏':'';
 const merged=post.mergedCount>1?` (연속 ${post.mergedCount}건 요약)`:'';
 const symPart=[post.symbol,dirKo].filter(Boolean).join(' ');
 const head=`📡 [@${post.channel}] ${post.emoji||'📌'} ${post.actionKo||'매매 알림'}${symPart?` · ${symPart}`:''}${merged}`;
 const metrics=[];
 if(post.entryPrice)metrics.push(`평단 ${post.entryPrice}`);
 if(post.markPrice)metrics.push(`마크 ${post.markPrice}`);
 if(post.leverage)metrics.push(`${post.leverage}x`);
 if(post.pnlText)metrics.push(`손익 ${post.pnlText}`);
 const line2=metrics.length?metrics.join(' · '):(post.translatedText||'').split('\n').find(Boolean)||'';
 return line2?`${head}\n${line2}`:head;
}

/** Clean Korean Telegram notification card for translated channel trading posts (zero auto-orders). */
export function formatChannelAlertTelegram(post){
 const dirKo=post.side==='LONG'?'🟢 롱 (LONG)':post.side==='SHORT'?'🔴 숏 (SHORT)':'방향 참고';
 const merged=post.mergedCount>1?` (연속 ${post.mergedCount}건 최신 기준)`:'';
 const lines=[
  `📡 [텔레그램 채널 매매 번역 · @${post.channel}]`,
  `${post.emoji||'📌'} ${post.actionKo||'매매 알림'}${merged}`,
 ];
 if(post.symbol||post.side)lines.push(`• 종목/방향: ${[post.symbol||'종목 확인',dirKo].filter(Boolean).join(' · ')}`);
 if(post.entryPrice)lines.push(`• 평단가: ${post.entryPrice} USDT`);
 if(post.markPrice)lines.push(`• 마크가: ${post.markPrice} USDT`);
 if(post.liqPrice)lines.push(`• 청산가: ${post.liqPrice} USDT`);
 if(post.leverage||post.marginMode){
  const mm=post.marginMode==='ISOLATED'?'격리':post.marginMode==='CROSSED'?'교차':'';
  lines.push(`• 레버리지/마진: ${[post.leverage?`${post.leverage}x`:'',mm].filter(Boolean).join(' · ')}`);
 }
 if(post.pnlText)lines.push(`• 손익: ${post.pnlText}`);
 if(post.translatedText){
  const body=post.translatedText.length>700?post.translatedText.slice(0,697)+'…':post.translatedText;
  lines.push('',`🇰🇷 한국어 번역:`,body);
 }
 if(post.url)lines.push('',`🔗 원문: ${post.url}`);
 lines.push(`👉 자동 주문 없음 — 참고 후 필요 시 수동 주문창에서 직접 진행하세요.`);
 return lines.join('\n');
}

/** Build a manual-order prefill payload for actionable LONG/SHORT channel posts (OPEN/ADD/SNAPSHOT/SIGNAL). */
export function channelPostPrefill(post){
 if(!post||!post.symbol||!['LONG','SHORT'].includes(post.side))return null;
 if(['CLOSE','LIQUIDATION','REDUCE'].includes(post.action))return null;
 return {
  symbol:post.symbol,
  side:post.side,
  orderType:'MARKET',
  limitPrice:null,
  tpPrice:null,
  slPrice:null,
  leverage:post.leverage&&post.leverage>=1&&post.leverage<=125?Math.round(post.leverage):null,
  marginMode:post.marginMode||null,
  note:`📡 [@${post.channel}] ${post.actionKo} · ${post.symbol} ${post.side==='LONG'?'롱':'숏'} (원문 #${post.postNum})`,
 };
}

export class TelegramChannelWatcher{
 constructor({channels=DEFAULT_CHANNELS,filePath=null,fetcher=fetch,translate=null,now=()=>Date.now(),maxPosts=MAX_STORED_POSTS}={}){
  this.channels=Array.isArray(channels)?channels.map(c=>String(c).toLowerCase()):[];
  this.filePath=filePath;
  this.fetcher=fetcher;
  this.translate=translate;
  this.now=now;
  this.maxPosts=Math.max(10,Number(maxPosts)||MAX_STORED_POSTS);
  this.state={channels:{},posts:[]};
  this.inflight=null;
  this._load();
 }

 _load(){
  if(!this.filePath)return;
  try{
   if(!fs.existsSync(this.filePath))return;
   const d=JSON.parse(fs.readFileSync(this.filePath,'utf8'));
   if(d&&typeof d==='object'){
    if(d.channels&&typeof d.channels==='object')this.state.channels=d.channels;
    if(Array.isArray(d.posts))this.state.posts=d.posts.slice(0,this.maxPosts);
   }
  }catch{}
 }

 _save(){
  if(!this.filePath)return;
  try{
   fs.mkdirSync(path.dirname(this.filePath),{recursive:true});
   const tmp=`${this.filePath}.${process.pid}.${Date.now()}.tmp`;
   fs.writeFileSync(tmp,JSON.stringify({updatedAt:this.now(),...this.state},null,2),'utf8');
   fs.renameSync(tmp,this.filePath);
  }catch{}
 }

 async _fetchChannel(channel){
  const url=`https://t.me/s/${encodeURIComponent(channel)}`;
  const ctrl=new AbortController();
  const timer=setTimeout(()=>ctrl.abort(),12000);
  timer.unref?.();
  try{
   const res=await this.fetcher(url,{
    signal:ctrl.signal,
    headers:{
     'User-Agent':'Mozilla/5.0 (compatible; SignalLab/1.0)',
     'Accept':'text/html,application/xhtml+xml',
     'Accept-Language':'zh-CN,zh;q=0.9,ko;q=0.8,en;q=0.7',
    },
   });
   if(!res.ok)throw Error(`HTTP_${res.status}`);
   const html=await res.text();
   return parseTelegramWebPosts(html,channel);
  }finally{clearTimeout(timer)}
 }

 async poll({force=false}={}){
  if(!this.channels.length)return {ok:true,bootstrapped:false,newAlerts:[],snapshot:this.snapshot()};
  if(this.inflight)return this.inflight;
  this.inflight=(async()=>{
   const now=this.now();
   const newTradingPosts=[];
   let bootstrapped=false;
   for(const ch of this.channels){
    const meta=this.state.channels[ch]||(this.state.channels[ch]={lastPostNum:0,lastCheckedAt:0,lastError:'',filteredCount:0,title:ch});
    if(!force&&meta.lastCheckedAt&&now-meta.lastCheckedAt<MIN_POLL_MS)continue;
    try{
     const rawPosts=await this._fetchChannel(ch);
     meta.lastCheckedAt=now;
     meta.lastError='';
     if(!rawPosts.length)continue;
     meta.title=rawPosts.at(-1)?.channelTitle||meta.title||ch;
     const maxNum=rawPosts.at(-1).postNum;
     const isFirstBoot=!(Number(meta.lastPostNum)>0);
     if(isFirstBoot){
      bootstrapped=true;
      // Seed the latest trading posts into the dashboard feed without firing old Telegram alerts.
      const seedCandidates=rawPosts.slice(-15);
      for(const p of seedCandidates){
       const cls=classifyTradingChannelPost(p.text);
       if(!cls.isTrading){meta.filteredCount=(meta.filteredCount||0)+1;continue}
       const translatedText=await translateChineseTradeText(p.text,{translate:this.translate});
       this._upsertPost({...p,...cls,translatedText,receivedAt:p.publishedAt||now,bootstrapped:true});
      }
      meta.lastPostNum=maxNum;
      continue;
     }
     const fresh=rawPosts.filter(p=>p.postNum>meta.lastPostNum);
     for(const p of fresh){
      const cls=classifyTradingChannelPost(p.text);
      if(!cls.isTrading){meta.filteredCount=(meta.filteredCount||0)+1;continue}
      const translatedText=await translateChineseTradeText(p.text,{translate:this.translate});
      const enriched={...p,...cls,translatedText,receivedAt:now,bootstrapped:false};
      this._upsertPost(enriched);
      newTradingPosts.push(enriched);
     }
     if(maxNum>meta.lastPostNum)meta.lastPostNum=maxNum;
    }catch(e){
     meta.lastCheckedAt=now;
     meta.lastError=String(e?.message||e).slice(0,80);
    }
   }
   this._save();
   const newAlerts=collapseBatchAlerts(newTradingPosts);
   return {ok:true,bootstrapped,newAlerts,snapshot:this.snapshot()};
  })().finally(()=>{this.inflight=null});
  return this.inflight;
 }

 _upsertPost(post){
  if(this.state.posts.some(x=>x.id===post.id))return;
  this.state.posts.unshift(post);
  this.state.posts.sort((a,b)=>(b.publishedAt||b.receivedAt||0)-(a.publishedAt||a.receivedAt||0)||(b.postNum-a.postNum));
  if(this.state.posts.length>this.maxPosts)this.state.posts.length=this.maxPosts;
 }

 snapshot(){
  return {
   ok:true,
   enabled:this.channels.length>0,
   channels:this.channels.map(ch=>{
    const m=this.state.channels[ch]||{};
    return {
     handle:ch,
     url:`https://t.me/${ch}`,
     title:m.title||ch,
     lastPostNum:m.lastPostNum||0,
     lastCheckedAt:m.lastCheckedAt||0,
     lastError:m.lastError||'',
     filteredCount:m.filteredCount||0,
    };
   }),
   posts:this.state.posts,
  };
 }
}
