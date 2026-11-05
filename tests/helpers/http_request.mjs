// Local integration-test transport. A polling loop's deadline cannot cancel an
// in-flight fetch or an unfinished response body; the request needs its own signal.
export async function fetchLocal(input,{timeoutMs=4000,...options}={}){
 const url=new URL(typeof input==='string'?input:input.url??String(input));
 if(!['127.0.0.1','localhost','[::1]'].includes(url.hostname))throw Error('LOCAL_TEST_TRANSPORT_ONLY');
 if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>120000)throw Error('INVALID_LOCAL_REQUEST_TIMEOUT');
 const deadline=AbortSignal.timeout(timeoutMs),signal=options.signal?AbortSignal.any([options.signal,deadline]):deadline;
 return fetch(input,{...options,signal});
}

export async function statusOnly(input,options){
 const response=await fetchLocal(input,options);
 // Even an assertion about status must release the HTTP response body.
 await response.arrayBuffer();return response.status;
}
