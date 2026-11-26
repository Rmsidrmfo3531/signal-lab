// External signal alert inbox & manual-order helper (NEVER executes orders automatically).
// Accepts user-pasted signal text or opt-in secret-authenticated official webhooks,
// parses Korean/English trade parameters (symbol, side, entry, TP, SL, leverage, margin mode),
// emits browser/sound/Telegram alerts, and prefills the #real BingX manual order ticket for user confirmation.

import fs from 'node:fs';
import path from 'node:path';
import {randomUUID,timingSafeEqual} from 'node:crypto';

const DEFAULT_MAX_ITEMS=50;
const DEDUP_WINDOW_MS=60_000;

const KO_SYMBOL_ALIASES=[
 [/(?:비트코인|비트|비코)/i,'BTCUSDT'],
 [/(?:이더리움|이더)/i,'ETHUSDT'],
 [/(?:솔라나|솔)/i,'SOLUSDT'],
 [/(?:리플|엑스알피)/i,'XRPUSDT'],
 [/(?:도지코인|도지)/i,'DOGEUSDT'],
 [/(?:에이다|카르다노)/i,'ADAUSDT'],
 [/(?:수이)/i,'SUIUSDT'],
 [/(?:페페)/i,'PEPEUSDT'],
 [/(?:아발란체)/i,'AVAXUSDT'],
 [/(?:체인링크|링크)/i,'LINKUSDT'],
 [/(?:비앤비|바이낸스코인)/i,'BNBUSDT'],
 [/(?:트론)/i,'TRXUSDT'],
 [/(?:라이트코인)/i,'LTCUSDT'],
 [/(?:골드|금선물)/i,'XAUTUSDT'],
];

const TICKER_STOPWORDS=new Set([
 'LONG','SHORT','BUY','SELL','ENTRY','ENTER','LIMIT','MARKET','POST','ONLY',
 'SL','TP','TP1','TP2','TP3','STOP','LOSS','TAKE','PROFIT','TARGET','TARGETS',
 'LEV','LEVERAGE','CROSS','CROSSED','ISOLATED','ISO','MARGIN','USDT','USD','KRW',
 'ROE','PNL','ROI','RR','RISK','REWARD','ALERT','SIGNAL','BOT','SIX','AUTO','TRADE',
 'PRICE','NOW','AT','IN','TO','FROM','THE','AND','FOR','WITH','MAX','MIN','OPEN','CLOSE',
 'HTTP','HTTPS','COM','DEV','FLY','NET','ORG','API','JSON','WEBHOOK',
]);

function parsePriceNum(raw){
 if(raw==null)return null;
 const cleaned=String(raw).replace(/[,$\s]/g,'').trim();
 if(!cleaned||!/^\d+(?:\.\d+)?$/.test(cleaned))return null;
 const n=Number(cleaned);
 return Number.isFinite(n)&&n>0?n:null;
}

function normalizeSymbolToken(raw){
 const s=String(raw||'').trim().toUpperCase().replace(/[^A-Z0-9]/g,'');
 if(!s||s.length<2||s.length>20)return '';
 const base=s.endsWith('USDT')?s.slice(0,-4):s.endsWith('PERP')?s.slice(0,-4):s;
 if(!base||base.length<2||/^\d+$/.test(base)||TICKER_STOPWORDS.has(base))return '';
 return `${base}USDT`;
}

function extractSymbol(text){
 const s=String(text||'');
 // 1) Explicit pair with USDT / PERP / slash / dash (e.g. BTCUSDT, BTC/USDT, ETH-USDT, 1000PEPEUSDT)
 const pairMatch=s.match(/(?:^|[\s#$([{/·,|:-])([A-Z0-9]{2,14})(?:[/-]|\s*)?(USDT|USDTPERP|PERP)(?=$|[\s)\]}/·,|:-])/i);
 if(pairMatch){
  const sym=normalizeSymbolToken(pairMatch[1]);
  if(sym)return sym;
 }
 // 2) Cashtag / hashtag ticker ($BTC, #ETH, #SOL)
 const tagMatch=s.match(/[$#]([A-Z][A-Z0-9]{1,12})\b/i);
 if(tagMatch){
  const sym=normalizeSymbolToken(tagMatch[1]);
  if(sym)return sym;
 }
 // 3) Korean coin alias (비트코인, 이더, 솔라나, 리플, 도지...)
 for(const [re,sym] of KO_SYMBOL_ALIASES){
  if(re.test(s))return sym;
 }
 // 4) Standalone uppercase English ticker token (2~10 chars) excluding stopwords
 for(const m of s.matchAll(/\b([A-Z][A-Z0-9]{1,9})\b/g)){
  const sym=normalizeSymbolToken(m[1]);
  if(sym)return sym;
 }
 return '';
}

function extractSide(text){
 const s=String(text||'');
 const longRe=/(?:\b(?:long|buy)\b|롱|매수|상승\s*진입)/i;
 const shortRe=/(?:\b(?:short|sell)\b|숏|매도|하락\s*진입)/i;
 const lm=s.match(longRe);
 const sm=s.match(shortRe);
 if(lm&&!sm)return 'LONG';
 if(sm&&!lm)return 'SHORT';
 if(lm&&sm)return lm.index<=sm.index?'LONG':'SHORT';
 return '';
}

function extractLeverage(text){
 const s=String(text||'');
 const m=s.match(/(?:레버리지|배율|\blev(?:erage)?\b)\s*[:=]?\s*(\d{1,3})\s*(?:배|x)?/i)
  ||s.match(/(?:^|[\s(\[/·,|:-])(\d{1,3})\s*(?:배|x)(?=$|[\s)\]}/·,|:-])/i);
 if(!m)return null;
 const n=Math.round(Number(m[1]));
 return Number.isFinite(n)&&n>=1&&n<=125?n:null;
}

function extractMarginMode(text){
 const s=String(text||'');
 if(/(?:격리|\bisolated\b|\biso\b)/i.test(s))return 'ISOLATED';
 if(/(?:교차|\bcross(?:ed)?\b)/i.test(s))return 'CROSSED';
 return null;
}

function extractLabeledPrice(text,labelRe){
 const m=String(text||'').match(labelRe);
 if(!m)return null;
 const p1=parsePriceNum(m[1]);
 const p2=m[2]?parsePriceNum(m[2]):null;
 if(p1&&p2)return {price:Number(((p1+p2)/2).toPrecision(7)),range:[Math.min(p1,p2),Math.max(p1,p2)]};
 return p1?{price:p1,range:null}:null;
}

function extractTpTargets(text){
 const s=String(text||'');
 const out=[];
 const push=v=>{const n=parsePriceNum(v);if(n&&!out.includes(n))out.push(n)};
 // Match TP1/TP2/TP3 or 익절1/목표1
 for(const m of s.matchAll(/(?:\btp\s*\d?\b|take\s*profit\s*\d?|target\s*\d?|익절가?|목표가?)\s*[:=@]?\s*\$?([\d,]+(?:\.\d+)?)(?:\s*(?:,|\/|\s+(?:~|-)\s*)\s*\$?([\d,]+(?:\.\d+)?))?(?:\s*(?:,|\/)\s*\$?([\d,]+(?:\.\d+)?))?/gi)){
  push(m[1]);
  if(m[2])push(m[2]);
  if(m[3])push(m[3]);
 }
 return out.slice(0,5);
}

/** Parse pasted Korean/English signal text or structured JSON webhook payload into a manual-order draft. */
export function parseExternalSignalText(input,{defaultSource='직접 붙여넣기'}={}){
 if(input&&typeof input==='object'&&!Array.isArray(input)){
  // Structured webhook JSON (may also contain a `text`/`message`/`content` field to parse)
  const embeddedText=String(input.text||input.message||input.content||input.rawText||'').trim();
  const parsedFromText=embeddedText?parseExternalSignalText(embeddedText,{defaultSource:input.source||defaultSource}):null;
  const symbol=normalizeSymbolToken(input.symbol||input.pair||input.ticker||'')||parsedFromText?.symbol||'';
  const rawSide=String(input.side||input.direction||input.action||'').trim().toUpperCase();
  const side=['LONG','BUY'].includes(rawSide)?'LONG':['SHORT','SELL'].includes(rawSide)?'SHORT':(parsedFromText?.side||'');
  const entryPrice=parsePriceNum(input.entryPrice??input.entry??input.limitPrice??input.price)??parsedFromText?.entryPrice??null;
  const slPrice=parsePriceNum(input.slPrice??input.sl??input.stopLoss)??parsedFromText?.slPrice??null;
  const rawTps=Array.isArray(input.tpTargets)?input.tpTargets.map(parsePriceNum).filter(Boolean):[];
  const tpSingle=parsePriceNum(input.tpPrice??input.tp??input.takeProfit??input.target);
  const tpTargets=rawTps.length?rawTps:(tpSingle?[tpSingle]:(parsedFromText?.tpTargets||[]));
  const tpPrice=tpTargets[0]??null;
  const levNum=Number(input.leverage??input.lev);
  const leverage=Number.isFinite(levNum)&&levNum>=1&&levNum<=125?Math.round(levNum):(parsedFromText?.leverage??null);
  const rawMm=String(input.marginMode||input.margin||'').trim().toUpperCase();
  const marginMode=['CROSSED','CROSS'].includes(rawMm)?'CROSSED':['ISOLATED','ISO'].includes(rawMm)?'ISOLATED':(parsedFromText?.marginMode??null);
  const rawOrderType=String(input.orderType||'').trim().toUpperCase();
  const orderType=['LIMIT','MARKET'].includes(rawOrderType)?rawOrderType:(entryPrice?'LIMIT':'MARKET');
  const source=String(input.source||parsedFromText?.source||defaultSource||'외부 신호').trim().slice(0,40)||'외부 신호';
  const rawText=(embeddedText||String(input.note||`${symbol} ${side} ${entryPrice||''}`)).trim().slice(0,500);
  return finalizeParsedSignal({
   symbol,side,orderType,entryPrice,entryRange:parsedFromText?.entryRange||null,
   tpPrice,tpTargets,slPrice,leverage,marginMode,source,rawText,
  });
 }

 const rawText=String(input||'').trim().slice(0,500);
 if(!rawText)return finalizeParsedSignal({symbol:'',side:'',orderType:'MARKET',entryPrice:null,entryRange:null,tpPrice:null,tpTargets:[],slPrice:null,leverage:null,marginMode:null,source:defaultSource,rawText:''});

 // Optional source tag in brackets like [깡이스터디] or [식스봇]
 const srcMatch=rawText.match(/^\[([^\]]{1,24})\]/);
 const source=(srcMatch?srcMatch[1].trim():String(defaultSource||'직접 붙여넣기').trim()).slice(0,40);

 const symbol=extractSymbol(rawText);
 const side=extractSide(rawText);
 const leverage=extractLeverage(rawText);
 const marginMode=extractMarginMode(rawText);

 const explicitMarket=/(?:시장가|현재가|\bmarket\b)/i.test(rawText);
 const entryInfo=extractLabeledPrice(
  rawText,
  /(?:진입가?|매수가?|매도가?|지정가|\bentry\b|\blimit\b|\bprice\b)\s*[:=@]?\s*\$?([\d,]+(?:\.\d+)?)(?:\s*(?:~|-)\s*\$?([\d,]+(?:\.\d+)?))?/i
 )||extractLabeledPrice(
  rawText,
  /(?:롱|숏|매수|매도|\blong\b|\bshort\b|\bbuy\b|\bsell\b)\s*[:=@]?\s*\$?([\d,]+(?:\.\d+)?)(?:\s*(?:~|-)\s*\$?([\d,]+(?:\.\d+)?))?(?!\s*(?:배|x|%))/i
 );

 const slInfo=extractLabeledPrice(
  rawText,
  /(?:손절가?|스탑(?:로스)?|\bsl\b|\bstop\s*loss\b|\bstop\b)\s*[:=@]?\s*\$?([\d,]+(?:\.\d+)?)/i
 );
 const tpTargets=extractTpTargets(rawText);
 const tpPrice=tpTargets[0]??null;
 const entryPrice=explicitMarket&&!/(?:지정가|\blimit\b)/i.test(rawText)?null:(entryInfo?.price??null);
 const orderType=entryPrice?'LIMIT':'MARKET';

 return finalizeParsedSignal({
  symbol,
  side,
  orderType,
  entryPrice,
  entryRange:entryInfo?.range||null,
  tpPrice,
  tpTargets,
  slPrice:slInfo?.price??null,
  leverage,
  marginMode,
  source,
  rawText,
 });
}

function finalizeParsedSignal({symbol,side,orderType,entryPrice,entryRange,tpPrice,tpTargets,slPrice,leverage,marginMode,source,rawText}){
 const warnings=[];
 let slDistPct=null,tpDistPct=null,riskReward=null;
 if(entryPrice&&slPrice){
  slDistPct=+(((slPrice-entryPrice)/entryPrice)*100).toFixed(2);
  if(side==='LONG'&&slPrice>=entryPrice)warnings.push('손절가(SL)가 진입가보다 높거나 같습니다 (롱 방향 확인 필요)');
  if(side==='SHORT'&&slPrice<=entryPrice)warnings.push('손절가(SL)가 진입가보다 낮거나 같습니다 (숏 방향 확인 필요)');
 }
 if(entryPrice&&tpPrice){
  tpDistPct=+(((tpPrice-entryPrice)/entryPrice)*100).toFixed(2);
  if(side==='LONG'&&tpPrice<=entryPrice)warnings.push('익절가(TP)가 진입가보다 낮거나 같습니다 (롱 방향 확인 필요)');
  if(side==='SHORT'&&tpPrice>=entryPrice)warnings.push('익절가(TP)가 진입가보다 높거나 같습니다 (숏 방향 확인 필요)');
 }
 if(entryPrice&&slPrice&&tpPrice){
  const risk=Math.abs(entryPrice-slPrice);
  const reward=Math.abs(tpPrice-entryPrice);
  if(risk>0&&reward>0)riskReward=+(reward/risk).toFixed(2);
 }
 if(leverage&&leverage>20)warnings.push(`고배율(${leverage}x) 주의 — 20배 이하 권장`);
 if(!slPrice)warnings.push('손절가(SL) 미포함 — 주문창에서 -15% ROE 등 손절을 설정하세요');

 const valid=Boolean(symbol&&side);
 return {
  valid,
  error:valid?'':(!symbol?'종목(예: BTC, ETH, SOLUSDT)을 인식하지 못했습니다':'방향(롱/숏 또는 LONG/SHORT)을 인식하지 못했습니다'),
  symbol,
  side,
  orderType,
  entryPrice,
  entryRange,
  tpPrice,
  tpTargets,
  slPrice,
  leverage,
  marginMode,
  slDistPct,
  tpDistPct,
  riskReward,
  warnings,
  source:source||'외부 신호',
  rawText,
 };
}

/** Constant-time verification for opt-in webhook secret (Authorization Bearer, X-Webhook-Secret, or ?secret=). */
export function verifyWebhookSecret(req,url,expectedSecret){
 const expected=String(expectedSecret||'').trim();
 if(!expected)return false;
 const auth=String(req?.headers?.authorization||'').trim();
 const bearer=/^bearer\s+(.+)$/i.exec(auth)?.[1]?.trim()||'';
 const headerSecret=String(req?.headers?.['x-webhook-secret']||'').trim();
 const querySecret=String(url?.searchParams?.get('secret')||'').trim();
 const candidate=bearer||headerSecret||querySecret;
 if(!candidate)return false;
 const a=Buffer.from(candidate,'utf8');
 const b=Buffer.from(expected,'utf8');
 if(a.length!==b.length)return false;
 return timingSafeEqual(a,b);
}

/** Format a compact Korean alert line for SSE browser/sound notifications (`live-notice`). */
export function formatExternalSignalNotice(item){
 const dirKo=item.side==='LONG'?'🟢 롱':'🔴 숏';
 const pxKo=item.entryPrice?`지정가 ${item.entryPrice}`:'시장가';
 const extras=[];
 if(item.slPrice)extras.push(`SL ${item.slPrice}`);
 if(item.tpPrice)extras.push(`TP ${item.tpPrice}`);
 if(item.leverage)extras.push(`${item.leverage}x`);
 const title=`🔔 [외부 신호] ${item.symbol} ${dirKo} (${pxKo})`;
 const line2=[item.source,extras.join(' · '),item.riskReward?`손익비 1:${item.riskReward}`:''].filter(Boolean).join(' · ');
 return line2?`${title}\n${line2}`:title;
}

/** Format a scannable Korean Telegram alert for manual review (reminds user that no auto-order was placed). */
export function formatExternalSignalTelegram(item){
 const dirKo=item.side==='LONG'?'🟢 롱 (LONG)':'🔴 숏 (SHORT)';
 const lines=[
  `🔔 [외부 신호 알림 · 수동 확인]`,
  `• 출처: ${item.source||'외부 신호'}`,
  `• 종목/방향: ${item.symbol} · ${dirKo}`,
  `• 진입가: ${item.entryPrice?`${item.entryPrice} (지정가)`:'시장가 (현재가 확인)'}`,
 ];
 if(item.tpTargets?.length)lines.push(`• 익절(TP): ${item.tpTargets.join(' / ')}${item.tpDistPct!=null?` (${item.tpDistPct>0?'+':''}${item.tpDistPct}%)`:''}`);
 if(item.slPrice)lines.push(`• 손절(SL): ${item.slPrice}${item.slDistPct!=null?` (${item.slDistPct>0?'+':''}${item.slDistPct}%)`:''}`);
 if(item.riskReward)lines.push(`• 손익비(R:R): 1 : ${item.riskReward}`);
 if(item.leverage||item.marginMode){
  const mmKo=item.marginMode==='ISOLATED'?'격리':item.marginMode==='CROSSED'?'교차':'';
  lines.push(`• 레버리지/마진: ${[item.leverage?`${item.leverage}배`:'',mmKo].filter(Boolean).join(' · ')}`);
 }
 if(item.warnings?.length)lines.push(`⚠️ 주의: ${item.warnings.join(' / ')}`);
 lines.push(`👉 자동 주문 없음 — Signal Lab 실계좌 수동 주문창에서 확인 후 직접 진입하세요.`);
 return lines.join('\n');
}

export class ExternalSignalInbox{
 constructor({filePath=null,maxItems=DEFAULT_MAX_ITEMS}={}){
  this.filePath=filePath;
  this.maxItems=Math.max(10,Number(maxItems)||DEFAULT_MAX_ITEMS);
  this.items=[];
  this._load();
 }

 _load(){
  if(!this.filePath)return;
  try{
   if(!fs.existsSync(this.filePath))return;
   const parsed=JSON.parse(fs.readFileSync(this.filePath,'utf8'));
   if(Array.isArray(parsed?.items))this.items=parsed.items.slice(0,this.maxItems);
  }catch{}
 }

 _save(){
  if(!this.filePath)return;
  try{
   fs.mkdirSync(path.dirname(this.filePath),{recursive:true});
   const tmp=`${this.filePath}.${process.pid}.${Date.now()}.tmp`;
   fs.writeFileSync(tmp,JSON.stringify({updatedAt:Date.now(),items:this.items},null,2),'utf8');
   fs.renameSync(tmp,this.filePath);
  }catch{}
 }

 ingest(input,{source,channel='manual',now=Date.now()}={}){
  const parsed=parseExternalSignalText(input,{defaultSource:source||(channel==='webhook'?'외부 웹훅':'직접 붙여넣기')});
  if(!parsed.valid)return {ok:false,error:parsed.error,parsed};
  const dedupKey=`${parsed.symbol}|${parsed.side}|${parsed.entryPrice||''}|${parsed.slPrice||''}|${parsed.tpPrice||''}`;
  const existing=this.items.find(x=>x.dedupKey===dedupKey&&Math.abs(now-x.receivedAt)<DEDUP_WINDOW_MS);
  if(existing)return {ok:true,duplicate:true,item:existing};
  const item={
   id:randomUUID(),
   dedupKey,
   receivedAt:Number(now)||Date.now(),
   channel,
   status:'NEW',
   ...parsed,
  };
  this.items.unshift(item);
  if(this.items.length>this.maxItems)this.items.length=this.maxItems;
  this._save();
  return {ok:true,duplicate:false,item};
 }

 setStatus(id,status){
  const norm=String(status||'').trim().toUpperCase();
  if(!['NEW','LOADED','DISMISSED'].includes(norm))return null;
  const item=this.items.find(x=>x.id===id);
  if(!item)return null;
  item.status=norm;
  item.updatedAt=Date.now();
  this._save();
  return item;
 }

 clear(){
  this.items=[];
  this._save();
 }

 snapshot({webhookConfigured=false}={}){
  const unreadCount=this.items.filter(x=>x.status==='NEW').length;
  return {
   ok:true,
   webhookConfigured:Boolean(webhookConfigured),
   webhookPath:'/api/external-signals/webhook',
   unreadCount,
   totalCount:this.items.length,
   items:this.items,
  };
 }
}
