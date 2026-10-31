// Bounded PUBLIC GET diagnostic only. Never loads .env or application records.
import {pathToFileURL} from 'node:url';
import {diagnoseOrangeXContinuous} from '../orangex_market_monitor.mjs';
export function continuousOptions(args=[]){
 const options={},seen=new Set();
 for(let index=0;index<args.length;index++){
  const key=args[index];if(seen.has(key))throw Error('INVALID_CONTINUOUS_OPTIONS');seen.add(key);
  if(key==='--without-binance'){options.includeBinance=false;continue}
  if(key==='--funding'){options.includeFunding=true;continue}
  const value=args[++index];if(typeof value!=='string'||!/^\d+$/.test(value))throw Error('INVALID_CONTINUOUS_OPTIONS');
  const numeric=Number(value);
  if(key==='--rounds'&&numeric>=2&&numeric<=12)options.rounds=numeric;
  else if(key==='--interval-ms'&&numeric>=0&&numeric<=30000)options.intervalMs=numeric;
  else if(key==='--max-age-ms'&&numeric>=1&&numeric<=90000)options.maxQuoteAgeMs=numeric;
  else if(key==='--stall-ms'&&numeric>=1&&numeric<=90000)options.stallAfterMs=numeric;
  else throw Error('INVALID_CONTINUOUS_OPTIONS');
 }
 return options;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 try{const report=await diagnoseOrangeXContinuous(continuousOptions(process.argv.slice(2)));console.log(JSON.stringify(report,null,2));process.exitCode=report.exitCode}
 catch{console.error('공개 연속 진단 실패. 기존 기록·모드는 변경하지 않습니다.');console.error('사용법: node scripts/diagnose-orangex-continuous.mjs [--rounds 2..12] [--interval-ms 0..30000] [--max-age-ms 1..90000] [--stall-ms 1..90000] [--without-binance] [--funding]');process.exitCode=3}
}
