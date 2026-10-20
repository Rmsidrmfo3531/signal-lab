// RSS headlines are pointers to third-party reports, not verified trade recommendations.
import {createHash} from 'node:crypto';
export const FEEDS = [
 {name:'Decrypt',url:'https://decrypt.co/feed'},
 {name:'Cointelegraph',url:'https://cointelegraph.com/rss'},
 {name:'CoinDesk',url:'https://www.coindesk.com/arc/outboundfeeds/rss/'},
 {name:'CNBC Markets',url:'https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=20409666'},
 {name:'CNBC Economy',url:'https://www.cnbc.com/id/20910258/device/rss/rss.html'}
];
const ASSETS={BTC:['bitcoin','btc','비트코인'],ETH:['ethereum','ether','eth','이더리움'],SOL:['solana','sol','솔라나'],XRP:['ripple','xrp'],BNB:['bnb','binance coin'],DOGE:['dogecoin','doge'],ADA:['cardano','ada'],LINK:['chainlink','link'],AVAX:['avalanche','avax'],SUI:['sui'],DOT:['polkadot','dot'],UNI:['uniswap','uni'],LTC:['litecoin','ltc'],AAVE:['aave'],ONDO:['ondo'],ARB:['arbitrum','arb'],OP:['optimism'],ZEC:['zcash','zec'],XAU:['gold','bullion','xau'],XAG:['silver','xag'],US100:['nasdaq 100','nasdaq','us100'],US500:['s&p 500','s&p500','us500','spx'],US30:['dow jones','dow industrial','us30'],DXI:['dollar index','dxy'],UKOIL:['brent crude','brent oil','brent'],USOIL:['wti crude','crude oil','wti']};
function decodeEntities(v){return String(v||'').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g,'$1').replace(/&#(x[0-9a-f]+|\d+);/gi,(_,x)=>{const n=x[0].toLowerCase()==='x'?parseInt(x.slice(1),16):Number(x);return n>31&&n<=0x10ffff?String.fromCodePoint(n):''}).replace(/&(amp|lt|gt|quot|apos|nbsp);/g,(_,x)=>({amp:'&',lt:'<',gt:'>',quot:'"',apos:"'",nbsp:' '}[x])).replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim()}
function field(fragment,tag){const m=fragment.match(new RegExp('<(?:[a-z0-9_-]+:)?'+tag+'(?:\\s[^>]*)?>([\\s\\S]*?)<\\/(?:[a-z0-9_-]+:)?'+tag+'>','i'));return m?decodeEntities(m[1]):''}
export function parseRSS(xml,source,now=Date.now()){
 const items=[];
 for(const match of String(xml).matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)){
  const raw=match[1],title=field(raw,'title'),link=field(raw,'link')||field(raw,'guid'),date=field(raw,'pubDate')||field(raw,'published');
  const published=Date.parse(date);
  try{const u=new URL(link);if(!['https:','http:'].includes(u.protocol)||!title||!Number.isFinite(published)||published>now+10*60000||now-published>48*3600000)continue;
   const description=field(raw,'description')||field(raw,'summary')||field(raw,'encoded');
   // Only the source-provided excerpt is shown here. Full article stays on the publisher website.
   items.push({id:createHash('sha256').update(u.href).digest('hex').slice(0,24),title,link:u.href,source,published,summary:description.slice(0,230),detail:description.slice(0,950)});
  }catch{}
 }
 return items;
}
const negative=/\b(hack|hacked|exploit|breach|theft|stolen|liquidation|bankrupt|insolvency|delist|lawsuit|charge[ds]?|crackdown|ban|outage|attack|fraud|rug pull|security incident|seized|sanction|tariff hike)\b/i;
const positive=/\b(approval|approve(?:s|d)?|adoption|integrat(?:e|ion)|partnership|upgrade|launch|etf inflow|investment|inflows|rate cut|easing|tokenization|listing|mainnet)\b/i;
const critical=/\b(SEC|Federal Reserve|FOMC|interest rates?|CPI|inflation|ETF|hack|exploit|liquidation|outage|tariff|regulation|bankrupt|US Treasury|nonfarm payroll|jobless|employment report|gold|crude oil|nasdaq|s&p 500|earnings|PCE|stablecoin bill|government|sanction|exchange)\b/i;
export function tagNews(news,availableMarkets=[]){
 const input=news.title+' '+news.summary;
 const symbols=[];
 for(const [symbol,aliases] of Object.entries(ASSETS)){
  const pattern=aliases.some(a=>{
   if(a.length<=3)return new RegExp('(?:\\$'+a+'\\b|\\b'+a.toUpperCase()+'\\b)').test(news.title);
   return new RegExp('\\b'+a.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'\\b','i').test(input)
  });
  if(pattern)symbols.push(symbol);
 }
 // Enhance symbol discovery from the *currently verified* Variational markets.
 // For ambiguous tickers use $SYMBOL or a meaningful asset name, not generic English words.
 for(const market of availableMarkets){
  const sym=String(market.symbol||'').toUpperCase(),name=String(market.name||'').trim();
  if(!/^[A-Z0-9]{2,20}$/.test(sym)||symbols.includes(sym))continue;
  const tickerInHeadline=(new RegExp('\\$'+sym+'\\b')).test(news.title)||
    (sym.length>=4&&(new RegExp('\\b'+sym+'\\b')).test(news.title));
  const safeName=name.length>=4&&name.toLowerCase()!==sym.toLowerCase()&&
    (new RegExp('\\b'+name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'\\b','i')).test(input);
  if(tickerInHeadline||safeName)symbols.push(sym);
 }
 const neg=negative.test(news.title),pos=positive.test(news.title);
 const impact=critical.test(news.title)?'high':neg||pos?'medium':'general';
 const tone=neg&&!pos?'risk':pos&&!neg?'opportunity':'neutral';
 return {...news,symbols,impact,tone,interpretation:'제목 기반 자동 분류 · 사실/가격 영향 확인 필요'};
}
export function prepareNews(feeds,now=Date.now(),availableMarkets=[]){
 const unique=new Map();for(const feed of feeds)for(const article of parseRSS(feed.body,feed.name,now))unique.set(article.id,tagNews(article,availableMarkets));
 return [...unique.values()].sort((a,b)=>b.published-a.published).slice(0,120);
}
export function shouldNotifyArticle(a,seen,now=Date.now()){
 return a.impact==='high'&&a.published>=now-30*60000&&!seen.has(a.id);
}
