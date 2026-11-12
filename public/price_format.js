// One price format per position: the venue tick's decimals (or the most decimals among the
// exchange-quoted prices), so first entry, average entry, current price, stop and targets line up
// digit for digit. (Moved from the former paper screen; the same rule.)
export const decimalsOf=v=>{const x=Number(v);if(!Number.isFinite(x)||x<=0)return null;const t=x.toFixed(10).replace(/0+$/,'');return t.includes('.')?t.split('.')[1].length:0};
export function priceDecimals(t){
 const tick=t?.targetPlan?.tickSize??t?.venueContract?.tickSize??t?.tickSize,fromTick=decimalsOf(tick);
 if(fromTick!==null)return Math.min(10,fromTick);
 const quoted=[t?.markPrice,t?.stop,...(t?.targets||[])].map(decimalsOf).filter(x=>x!==null);
 return quoted.length?Math.min(10,Math.max(...quoted)):null;
}
const plain=value=>value!==null&&value!==undefined&&value!==''&&Number.isFinite(Number(value))?Number(value).toLocaleString('en-US',{maximumFractionDigits:8}):'—';
export function priceFmt(t){
 const d=priceDecimals(t);
 return v=>v===null||v===undefined||v===''||!Number.isFinite(Number(v))?'—':d===null?plain(v):Number(v).toLocaleString('en-US',{minimumFractionDigits:d,maximumFractionDigits:d});
}
