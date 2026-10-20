// Deterministic pagination shared by desktop and mobile scan/coverage panels.
export const SCAN_PAGE_SIZE = 5;
export function paginateScan(items, requestedPage=1, pageSize=SCAN_PAGE_SIZE){
 const rows=Array.isArray(items)?items:[];
 const size=Number.isSafeInteger(Number(pageSize))?Math.min(20,Math.max(1,Math.floor(Number(pageSize)))):SCAN_PAGE_SIZE;
 const pages=Math.max(1,Math.ceil(rows.length/size));
 const desired=Number.isFinite(Number(requestedPage))?Math.trunc(Number(requestedPage)):1;
 const page=Math.max(1,Math.min(pages,desired));
 const start=(page-1)*size;
 return {page,pages,total:rows.length,start,end:Math.min(rows.length,start+size),items:rows.slice(start,start+size)};
}
export function scanPageWindow(page,pages){
 const length=Math.min(5,Math.max(1,pages));
 const start=Math.max(1,Math.min(pages-length+1,page-2));
 return Array.from({length},(_,i)=>i+start);
}
