// Every open position on the BingX real account, read-only (user 2026-11-17 "내가 수동으로 잡은 포지션도
// 실시간 현황으로 볼 수 없나?"): the real-account page lists the copy ledger's positions and, below them, all
// venue positions marked 카피 (an OPEN copy-ledger position of the same symbol and direction) or 수동.
// GET /openApi/swap/v2/user/positions only (no orders); read at most every 3 s through a small cache; a failed
// read keeps the last good list with its time. Only the whitelisted fields below leave this module.
//
// BingX rows: one-way rows have positionSide BOTH and a signed positionAmt (negative = short); hedge rows have
// positionSide LONG / SHORT and a positive amount (bingx_position_mode.mjs).

const num=v=>v===null||v===undefined||v===''?null:Number.isFinite(Number(v))?Number(v):null;
const pos=v=>{const n=num(v);return n!==null&&n>0?n:null};
const truthy=v=>v===true||String(v).trim().toLowerCase()==='true';

/** The direction of one row: LONG / SHORT from a hedge row's positionSide, else the sign of positionAmt.
 * A one-way row with a positive amount whose unrealized PnL plainly disagrees with the price move is read as
 * short (some BingX answers give the amount unsigned). null when it cannot be told. */
export function directionOf(row){
 const side=String(row?.positionSide||'').trim().toUpperCase(),amt=num(row?.positionAmt);
 if(side==='LONG'||side==='SHORT')return side;
 if(amt===null||amt===0)return null;
 if(amt<0)return 'SHORT';
 const avg=pos(row?.avgPrice),mark=pos(row?.markPrice),u=num(row?.unrealizedProfit);
 if(avg&&mark&&u!==null&&Math.abs(mark-avg)/avg>1e-4&&Math.abs(u)>1e-9&&Math.sign(u)!==Math.sign(mark-avg))return 'SHORT';
 return 'LONG';
}

/** One BingX position row as the page shows it, or null for an empty row. markOf(venueSymbol) is the cached
 * last price, used when the row has no markPrice. */
export function normalizeVenuePosition(row,{markOf=()=>null}={}){
 if(!row||typeof row!=='object')return null;
 const size=Math.abs(num(row.positionAmt)??0);if(!(size>0))return null;
 const venueSymbol=String(row.symbol||'').slice(0,40);if(!venueSymbol)return null;
 const direction=directionOf(row);
 const avg=pos(row.avgPrice),leverage=pos(row.leverage);
 let mark=pos(row.markPrice);if(!mark){try{mark=pos(markOf(venueSymbol))}catch{mark=null}}
 let unrealized=num(row.unrealizedProfit);
 if(unrealized===null&&avg&&mark&&direction)unrealized=(direction==='LONG'?1:-1)*(mark-avg)*size;
 const mm=String(row.marginMode??row.marginType??'').trim().toUpperCase();
 const isolated=truthy(row.isolated)||mm==='ISOLATED';
 const initialMargin=pos(row.initialMargin)??(avg&&leverage?size*avg/leverage:null);
 const margin=isolated&&pos(row.margin)?pos(row.margin):initialMargin;
 const roePct=unrealized!==null&&initialMargin?unrealized/initialMargin*100:null;
 const side=String(row.positionSide||'').trim().toUpperCase();
 return {symbol:venueSymbol.replace(/-/g,''),venueSymbol,positionSide:['LONG','SHORT','BOTH'].includes(side)?side:null,direction,size,avg,mark,
  unrealized,roePct,leverage,margin,initialMargin,liquidation:pos(row.liquidationPrice),marginMode:isolated?'ISOLATED':'CROSSED',
  updatedAt:pos(row.updateTime)};
}

/** Marks each venue row copy (an OPEN copy-ledger position on the same venue symbol and direction; in hedge
 * mode the direction is the row's positionSide) or manual (anything else). A one-way row holding a copy and a
 * manual entry in the same direction is one venue position and counts as copy. */
export function tagOrigins(rows,copyPositions=[]){
 const open=(Array.isArray(copyPositions)?copyPositions:[]).filter(p=>p?.status==='OPEN');
 return (rows||[]).map(r=>{const p=r.direction?open.find(x=>x.venueSymbol===r.venueSymbol&&x.direction===r.direction):null;
  return {...r,origin:p?'copy':'manual',...(p?.symbol?{symbol:p.symbol}:{})}});
}

/** The rows of a positions answer (an array; null when the answer is not a list). */
export function venueRows(data){return Array.isArray(data)?data:Array.isArray(data?.positions)?data.positions:null}

/** Cached reader: snapshot(copyPositions) re-reads the venue when the list is older than ttlMs (one request at a
 * time, waiting at most waitMs for it) and never throws. Errors keep the last good list. */
export function createVenuePositionsReader({read,markOf=()=>null,now=()=>Date.now(),ttlMs=3000,waitMs=2500}){
 let rows=null,at=0,error=null,errorAt=0,pending=null,tried=null;
 const refresh=()=>{tried=now();pending=Promise.resolve().then(read).then(data=>{const list=venueRows(data);if(!list)throw Object.assign(Error('BAD_RESPONSE'),{code:'BAD_RESPONSE'});
   rows=list.map(r=>normalizeVenuePosition(r,{markOf})).filter(Boolean);at=now();error=null;errorAt=0})
  .catch(e=>{error=String(e?.code||e?.message||'READ_FAILED').replace(/[^\w.:\- ]/g,'').slice(0,60)||'READ_FAILED';errorAt=now()})
  .finally(()=>{pending=null});return pending};
 return {
  async snapshot(copyPositions=[]){
   try{if(!pending&&(tried===null||!(now()-tried<ttlMs)))refresh();
    if(pending){let t;await Promise.race([pending,new Promise(r=>{t=setTimeout(r,waitMs)})]);clearTimeout(t)}}catch{}
   // The cached last price may have moved since the read: fill a missing mark (and its PnL) again.
   const list=rows?tagOrigins(rows,copyPositions).map(r=>{if(r.mark)return r;const m=pos((()=>{try{return markOf(r.venueSymbol)}catch{return null}})());
    if(!m||!r.avg||!r.direction)return r;const u=r.unrealized??(r.direction==='LONG'?1:-1)*(m-r.avg)*r.size;return {...r,mark:m,unrealized:u,roePct:r.initialMargin?u/r.initialMargin*100:r.roePct}}):null;
   return {venuePositions:list,venuePositionsAt:at||null,venuePositionsError:error,venuePositionsErrorAt:error?errorAt:null};
  },
 };
}
