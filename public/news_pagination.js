export const NEWS_PER_PAGE = 5;
const stopWords=new Set('a an the is are to in on of and for with as at from after before says said report reports'.split(' '));
const direction=/\b(approv\w*|reject\w*|deny|denied|ban\w*|halt\w*|drop\w*|fall\w*|rise\w*|rais\w*|cut\w*)\b/g;
function storyKey(item){
 const title=String(item.title||'').normalize('NFKC').toLowerCase().replace(/\bbtc\b/g,'bitcoin').replace(/\beth\b/g,'ethereum');
 return {words:new Set((title.match(/[a-z0-9가-힣]+/g)||[]).filter(w=>!stopWords.has(w))),
  numbers:(title.match(/\d+(?:[.,]\d+)*/g)||[]).join('|'),direction:(title.match(direction)||[]).sort().join('|')};
}
function sameStory(a,b){
 if(a.numbers!==b.numbers||a.direction!==b.direction)return false;
 const common=[...a.words].filter(w=>b.words.has(w)).length;
 return common>=4&&common/(a.words.size+b.words.size-common)>=.8;
}
/** Only the first two places are editorially ranked; the other articles keep their incoming order. */
export function featureNews(items,now=Date.now()){
 const groups=[];
 for(const item of items){
  if(item.impact!=='high'||!(now-item.published>=0&&now-item.published<=6*3600000))continue;
  const key=storyKey(item),group=groups.find(g=>sameStory(g.key,key));
  if(group)group.sources.add(item.source);
  else groups.push({key,item,sources:new Set([item.source])});
 }
 const selected=groups.sort((a,b)=>b.sources.size-a.sources.size||b.item.published-a.item.published).slice(0,2);
 const featured=new Map(selected.map(g=>[g.item.id,[...g.sources].filter(Boolean)]));
 return {items:[...selected.map(g=>g.item),...items.filter(a=>!featured.has(a.id))],featured};
}
export function paginateNews(items,requestedPage=1,pageSize=NEWS_PER_PAGE){
 const all=Array.isArray(items)?items:[];
 const size=Math.max(1,Math.floor(Number(pageSize)||NEWS_PER_PAGE));
 const pages=Math.max(1,Math.ceil(all.length/size));
 const requested=Number.isFinite(Number(requestedPage))?Math.trunc(Number(requestedPage)):1;
 const page=Math.max(1,Math.min(pages,requested));
 const start=(page-1)*size;
 return {page,pages,total:all.length,start,end:Math.min(all.length,start+size),items:all.slice(start,start+size)};
}
export function clipNewsText(text,length=175){
 const clean=String(text??'').replace(/\s+/g,' ').trim();
 if(!clean)return '';
 const cap=Math.max(30,Math.floor(Number(length)||175));
 if(clean.length<=cap)return clean;
 const slice=clean.slice(0,cap);
 const cut=slice.lastIndexOf(' ');
 return (cut>=cap*.65?slice.slice(0,cut):slice).trimEnd()+'…';
}
export function pageWindow(page,pages){
 const count=Math.min(5,Math.max(1,pages));
 const start=Math.max(1,Math.min(pages-count+1,page-2));
 return Array.from({length:count},(_,i)=>start+i);
}
