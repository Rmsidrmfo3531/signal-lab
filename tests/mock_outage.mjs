// Test-only fixture: simulate a real one-venue outage without a network connection.
import './mock_realtime.mjs';
import fs from 'node:fs';
const normal=globalThis.fetch;
globalThis.fetch=async (input,options)=>{
 const url=String(input);
 if(fs.existsSync(process.env.SIGNAL_LAB_TEST_OUTAGE_FLAG||'') && url.includes('omni-client-api.prod.ap-northeast-1.variational.io'))
  return new Response(JSON.stringify({error:'simulated Variational outage'}),{status:503,headers:{'Content-Type':'application/json'}});
 return normal(input,options);
};
