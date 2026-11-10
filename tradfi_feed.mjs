import {TRADFI_DISABLED_REASON} from './tradfi.mjs';
/** Explicitly disabled even when a legacy environment contains feed credentials. */
export async function fetchTwelveSeries(){
 const error=new Error(TRADFI_DISABLED_REASON);error.code='TRADFI_PROVIDER_UNAVAILABLE';throw error;
}
export async function pullSeries(){return fetchTwelveSeries()}
