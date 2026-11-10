// Exact decimal arithmetic for exchange price/quantity grids (tick and lot steps).
// Values are parsed from their decimal text, so binary floating point never
// moves a rounded price or quantity off the grid. Pure functions only.
const finite=value=>typeof value==='number'&&Number.isFinite(value);
const fail=code=>{throw Error(code)};
const power=scale=>10n**BigInt(scale);
function decimal(value){
 if(!(typeof value==='string'||finite(value)))return fail('INVALID_DECIMAL');
 const text=String(value);if(text.length>80||! /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(text))return fail('INVALID_DECIMAL');
 const [mantissa,exponentText='0']=text.toLowerCase().split('e'),exponent=Number(exponentText);
 if(!Number.isSafeInteger(exponent)||Math.abs(exponent)>30)return fail('DECIMAL_RANGE_UNSUPPORTED');
 const [whole,fraction='']=mantissa.split('.');if((whole+fraction).length>40)return fail('DECIMAL_RANGE_UNSUPPORTED');
 let units=BigInt((whole||'0')+fraction),scale=fraction.length-exponent;
 if(scale<0){units*=power(-scale);scale=0}
 while(scale>0&&units%10n===0n){units/=10n;scale--}
 return {units,scale};
}
function positiveDecimal(value){const result=decimal(value);if(result.units<=0n)return fail('POSITIVE_DECIMAL_REQUIRED');return result}
function format({units,scale}){
 if(units===0n)return '0';let digits=String(units);
 if(!scale)return digits;digits=digits.padStart(scale+1,'0');
 return (digits.slice(0,-scale)+'.'+digits.slice(-scale)).replace(/0+$/,'').replace(/\.$/,'');
}
function common(a,b){const scale=Math.max(a.scale,b.scale);return [a.units*power(scale-a.scale),b.units*power(scale-b.scale)]}

/** Round a positive value to a multiple of `step`; returns decimal text.
 * DOWN never increases a quantity/price budget. */
export function roundDecimalToStep(value,step,rounding='DOWN'){
 if(!['DOWN','UP'].includes(rounding))return fail('INVALID_GRID_ROUNDING');
 const amount=positiveDecimal(value),grid=positiveDecimal(step),[a,b]=common(amount,grid);
 const count=a/b+(rounding==='UP'&&a%b!==0n?1n:0n);
 return format({units:grid.units*count,scale:grid.scale});
}
/** Exact product of two decimals as text, e.g. a step times a contract multiplier. */
export function multiplyDecimal(a,b){const x=decimal(a),y=decimal(b);return format({units:x.units*y.units,scale:x.scale+y.scale})}
/** Number of decimal places of a step such as "0.001" (3) or "1" (0). */
export function decimalPlaces(value){return positiveDecimal(value).scale}
