export const NEWS_PER_PAGE = 5;
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
