import test from 'node:test';
import assert from 'node:assert/strict';
import {createTelegramNetworkRecovery,telegramNetworkCode} from '../telegram_transport.mjs';

const payload={chat_id:'@scanner_fixture',text:'confirmed test'};
const offline=code=>Object.assign(Error('synthetic request for a private path'),{code});

test('Telegram switches to IPv4 after a connect failure, preserving the same destination and text',async()=>{
 const observed=[];
 const post=createTelegramNetworkRecovery(async(message,{ipv4})=>{
  observed.push({message,ipv4});if(!ipv4)throw new TypeError('fetch failed',{cause:new AggregateError([offline('ENETUNREACH')])});
  return {status:200};
 });
 assert.deepEqual(await post(payload),{response:{status:200},transport:'IPV4'});
 assert.deepEqual(await post(payload),{response:{status:200},transport:'IPV4'});
 assert.deepEqual(observed.map(x=>x.ipv4),[false,true,true]);
 assert.ok(observed.every(x=>x.message===payload));
});

test('an ambiguous timeout changes route on the next retry, and HTTP responses are never retried as connections',async()=>{
 const observed=[];
 const post=createTelegramNetworkRecovery(async(_,{ipv4})=>{
  observed.push(ipv4);if(!ipv4)throw new DOMException('synthetic timeout','TimeoutError');return {status:403};
 });
 assert.deepEqual(await post(payload),{error:'FETCH_TIMEOUT',transport:'FETCH'});
 assert.deepEqual(observed,[false]);
 assert.deepEqual(await post(payload),{response:{status:403},transport:'IPV4'});
 assert.deepEqual(observed,[false,true]);
 assert.equal(telegramNetworkCode(offline('CERT_HAS_EXPIRED')),'CERT_HAS_EXPIRED');
 assert.equal(telegramNetworkCode(Error('unrecognized path with secret')),'NETWORK_FAILED');
});
