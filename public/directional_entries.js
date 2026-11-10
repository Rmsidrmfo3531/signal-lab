// Shared display selector: directional reference entry must originate in a fresh,
// confirmed 1H pattern, never a historic record, observation, or fabricated price.
const positive=x=>Number.isFinite(Number(x))&&Number(x)>0;
export function latestDirectionPattern(items,direction,{now=Date.now(),symbol=null}={}){
 if(!['LONG','SHORT'].includes(direction))return null;
 const rows=(Array.isArray(items)?items:[]).filter(x=>{
  if(!x||x.direction!==direction||symbol&&x.symbol!==symbol||x.patternConfirmed!==true||x.patternInvalidated)return false;
  if(typeof x.symbol!=='string'||!x.symbol.endsWith('USDT')||!positive(x.entry)||!positive(x.stop)||!positive(x.target1))return false;
  const signed=direction==='LONG'?1:-1;
  if(signed*(Number(x.entry)-Number(x.stop))<=0||signed*(Number(x.target1)-Number(x.entry))<=0)return false;
  const candleAt=Number(x.patternConfirmedAt),scannedAt=Number(x.scannedAt);
  // Do not show old price levels as if they are currently active entries.
  return Number.isFinite(candleAt)&&candleAt<=now&&now-candleAt<=2*3600000&&
   Number.isFinite(scannedAt)&&scannedAt<=now&&now-scannedAt<=20*60000;
 });
 rows.sort((a,b)=>Number(b.patternConfirmedAt)-Number(a.patternConfirmedAt)||Number(b.scannedAt)-Number(a.scannedAt));
 return rows[0]||null;
}
