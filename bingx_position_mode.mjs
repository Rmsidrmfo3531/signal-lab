// BingX position mode (user 2026-11-17: "hedge mode로 해보고 싶은데"): every BingX order path follows the
// account's mode, read before each new entry and kept on the position record (hedge: true | false), so the
// stop, targets, closes and checks of that position use the mode it was opened under. Pure, no network.
//
//  - One-way (dualSidePosition false): positionSide BOTH; closing orders carry reduceOnly 'true'
//    (or closePosition 'true' on STOP_MARKET / TAKE_PROFIT_MARKET).
//  - Hedge (dualSidePosition true): positionSide LONG for a long position, SHORT for a short one, for opening
//    and closing alike (open long = BUY + LONG, close long = SELL + LONG, open short = SELL + SHORT, close
//    short = BUY + SHORT). reduceOnly is never sent (BingX refuses it in hedge mode); closePosition with the
//    matching positionSide is fine. Leverage is set per side (LONG / SHORT) instead of BOTH.
//  - Positions: one-way lists one row per symbol (positionSide BOTH, signed amount); hedge lists one row per
//    side with a positive amount, and a position is always read from the row of its own side.

/** true (hedge), false (one-way) or null (not stated: the caller does not guess). BingX answers
 * {dualSidePosition: true|false}, sometimes as the strings 'true' / 'false'. */
export function hedgeOf(resp){
 const v=resp?.dualSidePosition;
 if(v===true||String(v).trim().toLowerCase()==='true')return true;
 if(v===false||String(v).trim().toLowerCase()==='false')return false;
 return null;
}
export const isHedge=resp=>hedgeOf(resp)===true;
/** Reads the account's mode once. A client without positionMode (test fakes, old clients) is one-way, as
 * before; a failed read or an answer that does not state the mode gives {ok:false, reason}. */
export async function readPositionMode(client){
 if(typeof client?.positionMode!=='function')return {ok:true,hedge:false};
 let resp;try{resp=await client.positionMode()}catch(e){return {ok:false,reason:'BINGX_POSITION_MODE_UNKNOWN',detail:e?.code||e?.message||'READ_FAILED'}}
 const hedge=hedgeOf(resp);
 return hedge===null?{ok:false,reason:'BINGX_POSITION_MODE_UNKNOWN',detail:'dualSidePosition missing'}:{ok:true,hedge};
}
/** positionSide of the orders for one position: BOTH in one-way mode, the position's own side in hedge mode. */
export const positionSideFor=({hedge,direction})=>hedge?(direction==='SHORT'?'SHORT':'LONG'):'BOTH';
/** The side argument of the leverage setting (BOTH in one-way, LONG / SHORT in hedge mode). */
export const leverageSideFor=positionSideFor;
/** {positionSide} plus reduceOnly 'true' only for a closing order in one-way mode. */
export function sideParams({hedge,direction,closing=false}){
 const out={positionSide:positionSideFor({hedge,direction})};
 if(closing&&!hedge)out.reduceOnly='true';
 return out;
}
/** The order params for the mode: in hedge mode reduceOnly is removed (BingX rejects it); one-way params
 * are returned unchanged (the same object). */
export function forMode(params,hedge){
 if(!hedge||!params||!('reduceOnly' in params))return params;
 const {reduceOnly,...rest}=params;return rest;
}
/** The venue row of one position. One-way: the symbol's row (as before). Hedge: the row of the position's own
 * side (positionSide LONG / SHORT); an opposite-side row is another position and never read as this one. */
export function positionRow(list,venueSymbol,{hedge=false,direction}={}){
 const rows=(Array.isArray(list)?list:[]).filter(x=>x?.symbol===venueSymbol);
 if(!hedge)return rows[0]??null;
 const side=direction==='SHORT'?'SHORT':'LONG';
 return rows.find(x=>String(x?.positionSide||'').toUpperCase()===side)??null;
}
/** An open order belongs to this position: one-way, any order of the symbol; hedge, an order stating the
 * same positionSide (or stating none). */
export const orderOnSide=(o,{hedge,direction})=>!hedge||!o?.positionSide||String(o.positionSide).toUpperCase()===positionSideFor({hedge:true,direction});
