import test from 'node:test';
import assert from 'node:assert/strict';
import {authorizedRequest,isLoopback,isPrivateLANPeer,localIPv4Addresses,isProxiedRequest,createAuthRateLimiter} from '../mobile_access.mjs';
const password='test-password';
const auth=Buffer.from(`signal:${password}`).toString('base64');
test('Localhost is permitted without LAN credentials',()=>{
 assert.equal(isLoopback('::1'),true);
 assert.equal(isLoopback('127.0.0.1'),true);
 assert.equal(isLoopback('::ffff:127.0.0.1'),true);
 assert.equal(authorizedRequest('127.0.0.1',undefined,password),true);
 assert.equal(isLoopback('192.168.1.15'),false);
 assert.equal(isPrivateLANPeer('192.168.1.51'),true);
 assert.equal(isPrivateLANPeer('::ffff:192.168.1.51'),true);
 assert.equal(isPrivateLANPeer('8.8.8.8'),false);
 assert.equal(isPrivateLANPeer('172.20.2.1'),true);
});
test('Mobile LAN requires valid credentials',()=>{
 assert.equal(authorizedRequest('192.168.1.51',undefined,password),false);
 assert.equal(authorizedRequest('192.168.1.51',`Basic ${auth}`,password),true);
 assert.equal(authorizedRequest('8.8.8.8',`Basic ${auth}`,password),false);
 assert.equal(authorizedRequest('192.168.1.51',`Basic ${Buffer.from('signal:wrong').toString('base64')}`,password),false);
 assert.equal(authorizedRequest('192.168.1.51',`Basic ${Buffer.from('other:test-password').toString('base64')}`,password),false);
 assert.equal(authorizedRequest('192.168.1.51','Bearer bearer',password),false);
 assert.equal(authorizedRequest('192.168.1.51',`Basic ${auth}`,''),false);
});
test('Private IPv4 LAN addresses only',()=>{
 const fake={WiFi:[{family:'IPv4',address:'192.168.1.12',internal:false},{family:'IPv6',address:'fe80::1',internal:false}],Docker:[{family:'IPv4',address:'172.19.0.2',internal:false}],Lo:[{family:'IPv4',address:'127.0.0.1',internal:true}],Public:[{family:'IPv4',address:'23.14.20.5',internal:false}]};
 assert.deepEqual(localIPv4Addresses(fake),['192.168.1.12','172.19.0.2']);
});
test('Proxied loopback requests enforce Basic Auth or Tailscale identity when configured, and rate limiter locks repeated failures',()=>{
 const headers={'x-forwarded-for':'100.64.0.10','x-forwarded-proto':'https'};
 assert.equal(isProxiedRequest(headers),true);
 assert.equal(isProxiedRequest({}),false);
 assert.equal(authorizedRequest('127.0.0.1',undefined,password,{headers,requireProxyAuth:true}),false);
 assert.equal(authorizedRequest('127.0.0.1',`Basic ${auth}`,password,{headers,requireProxyAuth:true}),true);
 const allow=new Set(['alice@example.com']);
 assert.equal(authorizedRequest('127.0.0.1',undefined,'',{headers:{...headers,'tailscale-user-login':'Alice@Example.com'},allowedTailscaleUsers:allow,requireProxyAuth:true}),true);
 assert.equal(authorizedRequest('127.0.0.1',undefined,'',{headers:{...headers,'tailscale-user-login':'mallory@example.com'},allowedTailscaleUsers:allow,requireProxyAuth:true}),false);
 const limiter=createAuthRateLimiter({maxFailures:3,windowMs:1000,lockMs:5000});
 assert.equal(limiter.isBlocked('100.64.0.10',100).blocked,false);
 limiter.recordFailure('100.64.0.10',100);limiter.recordFailure('100.64.0.10',200);
 assert.equal(limiter.isBlocked('100.64.0.10',250).blocked,false);
 limiter.recordFailure('100.64.0.10',300);
 assert.equal(limiter.isBlocked('100.64.0.10',400).blocked,true);
 assert.equal(limiter.isBlocked('100.64.0.10',5400).blocked,false);
 limiter.recordFailure('100.64.0.10',6000);limiter.recordSuccess('100.64.0.10');
 assert.equal(limiter.isBlocked('100.64.0.10',6100).blocked,false);
});

