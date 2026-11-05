import {TRADFI_DISABLED_REASON} from './tradfi.mjs';
/** No substitute market feed is configured. Never synthesize a trade candidate. */
export function analyzeTradFi(row,_series,{now=Date.now()}={}){
 return {ticker:row?.ticker||'',checkedAt:now,source:null,status:'disabled',direction:null,
  reasonCode:'TRADFI_PROVIDER_UNAVAILABLE',reason:TRADFI_DISABLED_REASON,qualified:false};
}
