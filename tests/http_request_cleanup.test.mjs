import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {setTimeout as pause} from 'node:timers/promises';
import {fetchLocal,statusOnly} from './helpers/http_request.mjs';

async function hangingServer(handler){
 const sockets=new Set(),server=http.createServer(handler);
 server.on('connection',socket=>{sockets.add(socket);socket.once('close',()=>sockets.delete(socket))});
 server.listen(0,'127.0.0.1');await once(server,'listening');
 return {url:`http://127.0.0.1:${server.address().port}`,sockets,
  async close(){const closed=new Promise(resolve=>server.close(resolve));for(const socket of sockets)socket.destroy();await closed}};
}

test('a polling deadline by itself cannot cancel an HTTP request with no response',{timeout:5000},async()=>{
 const app=await hangingServer(()=>{}),controller=new AbortController();let completed=false;
 const request=fetch(app.url,{signal:controller.signal}).then(()=>{completed=true},()=>{completed=true});
 try{
  // This is the old polling-loop failure: time advances beyond the deadline,
  // but execution cannot return to the while condition while awaiting fetch.
  await pause(120);assert.equal(completed,false);
 }finally{controller.abort();await request;await app.close()}
});

test('a local request aborts a server that never sends response headers',{timeout:5000},async()=>{
 const app=await hangingServer(()=>{});
 try{await assert.rejects(fetchLocal(app.url,{timeoutMs:80}),error=>error.name==='TimeoutError')}
 finally{await app.close()}
});

test('a local status-only request also aborts an unfinished response body',{timeout:5000},async()=>{
 const app=await hangingServer((req,res)=>{res.writeHead(200,{'content-type':'text/plain'});res.write('unfinished')});
 try{await assert.rejects(statusOnly(app.url,{timeoutMs:80}),error=>['AbortError','TimeoutError'].includes(error.name))}
 finally{await app.close()}
});

test('caller cancellation is preserved and local test helpers reject remote hosts',{timeout:5000},async()=>{
 const app=await hangingServer(()=>{}),controller=new AbortController();
 try{
  const pending=fetchLocal(app.url,{timeoutMs:4000,signal:controller.signal});controller.abort();
  await assert.rejects(pending,error=>error.name==='AbortError');
  await assert.rejects(fetchLocal('https://example.invalid/'),/LOCAL_TEST_TRANSPORT_ONLY/);
  await assert.rejects(fetchLocal(app.url,{timeoutMs:0}),/INVALID_LOCAL_REQUEST_TIMEOUT/);
 }finally{await app.close()}
});
