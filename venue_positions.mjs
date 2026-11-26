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

/** The copy ledger's OWN quantity of one copy position (manual first, user 2026-11-25 01:37 / 01:39): p.ownQty, kept
 * by copy_executor.mjs from its own fills only, or for a position recorded before it the sum of its steps (OPEN / ADD /
 * ADOPTED minus REDUCE). null when it cannot be told (a step without a quantity, or no steps). Never the venue size. */
export function ledgerOwnQty(p){
 if(!p||typeof p!=='object')return null;
 if(Number.isFinite(p.ownQty)&&p.ownQty>=0)return p.ownQty;
 const steps=Array.isArray(p.steps)?p.steps:[];if(!steps.length)return null;
 let q=0;
 for(const s of steps){const n=Number(s?.qty);
  if(['OPEN','ADD','ADOPTED'].includes(s?.kind)){if(!(n>0))return null;q+=n}
  else if(s?.kind==='REDUCE'){if(!(n>=0))return null;q-=n}
  else return null;
 }
 q=Number(q.toFixed(12));return q>=0?q:null;
}

/** Marks each venue row copy (an OPEN copy-ledger position), scalp (an OPEN live scalp position),
 * or manual (anything else). A one-way row holding a copy and a manual entry in the same direction counts as copy;
 * such a row carries manualQty (venue size minus the copy ledger's own quantity, at least half a lot step) so the
 * automated tools leave it alone (manual first, user 2026-11-25). manualQty null: the copy's own quantity is unknown. */
export function tagOrigins(rows,copyPositions=[],scalpPositions=[]){
 const openCopy=(Array.isArray(copyPositions)?copyPositions:[]).filter(p=>p?.status==='OPEN');
 const openScalp=(Array.isArray(scalpPositions)?scalpPositions:[]).filter(p=>p?.status==='OPEN');
 return (rows||[]).map(r=>{
  const c=r.direction?openCopy.find(x=>x.venueSymbol===r.venueSymbol&&x.direction===r.direction):null;
  if(c){const own=ledgerOwnQty(c),step=Number(c.qtyStep)>0?Number(c.qtyStep):0;
   const extra=own==null?null:Math.max(0,r.size-own),manualQty=extra==null?null:extra>=(step?step/2:Math.max(1e-10,r.size*1e-8))?Number(extra.toFixed(12)):0;
   return {...r,origin:'copy',...(c.symbol?{symbol:c.symbol}:{}),manualQty}}
  const s=r.direction?openScalp.find(x=>x.venueSymbol===r.venueSymbol&&x.direction===r.direction):null;
  if(s)return {...r,origin:'scalp',...(s.symbol?{symbol:s.symbol}:{})};
  return {...r,origin:'manual'};
 });
}

/** The rows of a positions answer (an array; null when the answer is not a list). */
export function venueRows(data){return Array.isArray(data)?data:Array.isArray(data?.positions)?data.positions:null}

/** Validate the entire snapshot before consumers interpret absent rows as closed positions. */
export function checkedPositions(data,symbol=null){
 const rows=venueRows(data);
 if(!rows||rows.some(r=>typeof r?.symbol!=='string'||!r.symbol.trim()||(!symbol||r.symbol===symbol)&&
  !((typeof r.positionAmt==='number'||typeof r.positionAmt==='string')&&String(r.positionAmt).trim()&&Number.isFinite(Number(r.positionAmt)))))
  throw Object.assign(Error('UNEXPECTED_POSITION_RESPONSE'),{code:'UNEXPECTED_POSITION_RESPONSE'});
 return rows;
}

/** Cached reader: snapshot(copyPositions, scalpPositions) re-reads the venue when the list is older than ttlMs
 * (one request at a time, waiting at most waitMs for it) and never throws. Errors keep the last good list. */
export function createVenuePositionsReader({read,markOf=()=>null,now=()=>Date.now(),ttlMs=3000,waitMs=2500}){
 let rows=null,at=0,error=null,errorAt=0,pending=null,tried=null;
 const refresh=()=>{tried=now();pending=Promise.resolve().then(read).then(data=>{if(!venueRows(data))throw Object.assign(Error('BAD_RESPONSE'),{code:'BAD_RESPONSE'});
   const list=checkedPositions(data);
   rows=list.map(r=>normalizeVenuePosition(r,{markOf})).filter(Boolean);at=now();error=null;errorAt=0})
  .catch(e=>{error=String(e?.code||e?.message||'READ_FAILED').replace(/[^\w.:\- ]/g,'').slice(0,60)||'READ_FAILED';errorAt=now()})
  .finally(()=>{pending=null});return pending};
 return {
  cachedRows(){return Array.isArray(rows)?rows:[]},
  async snapshot(copyPositions=[],scalpPositions=[]){
   try{if(!pending&&(tried===null||!(now()-tried<ttlMs)))refresh();
    if(pending){let t;await Promise.race([pending,new Promise(r=>{t=setTimeout(r,waitMs)})]);clearTimeout(t)}}catch{}
   // The cached last price may have moved since the read: fill a missing mark (and its PnL) again.
   const list=rows?tagOrigins(rows,copyPositions,scalpPositions).map(r=>{if(r.mark)return r;const m=pos((()=>{try{return markOf(r.venueSymbol)}catch{return null}})());
    if(!m||!r.avg||!r.direction)return r;const u=r.unrealized??(r.direction==='LONG'?1:-1)*(m-r.avg)*r.size;return {...r,mark:m,unrealized:u,roePct:r.initialMargin?u/r.initialMargin*100:r.roePct}}):null;
   return {venuePositions:list,venuePositionsAt:at||null,venuePositionsError:error,venuePositionsErrorAt:error?errorAt:null};
  },
 };
}
