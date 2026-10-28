// Explicit public GET comparison. No credentials, .env or application records.
import {pathToFileURL} from 'node:url';
import {DOCUMENTED_LISTING_CURRENCIES} from '../orangex_listing_domains.mjs';
import {diagnoseOrangeXPublic} from './diagnose-orangex-public.mjs';

export function currencyComparisonOptions(args=[]){
 if(!Array.isArray(args)||args.some(value=>!['--include-unverified','--include-legacy'].includes(value))||new Set(args).size!==args.length)
  throw Error('INVALID_CURRENCY_COMPARISON_OPTIONS');
 return {currencies:[...DOCUMENTED_LISTING_CURRENCIES,...(args.includes('--include-unverified')?['PERPETUAL']:[]),
  ...(args.includes('--include-legacy')?['USDT']:[])],comparisonMode:true};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 try{
  const options=currencyComparisonOptions(process.argv.slice(2)),report=await diagnoseOrangeXPublic(options);
  console.log(JSON.stringify(report,null,2));process.exitCode=report.exitCode;
 }catch{
  console.error('사용법: node scripts/diagnose-orangex-currencies.mjs [--include-unverified] [--include-legacy]');
  process.exitCode=1;
 }
}
