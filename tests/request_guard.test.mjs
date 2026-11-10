import test from 'node:test';
import assert from 'node:assert/strict';
import {parseAuthority,allowedHostNames,evaluateRequest,SECURITY_HEADERS} from '../request_guard.mjs';

const hostNames=new Set(['localhost','my-pc','my-pc.local']);
const check=(headers,method='GET',path='/api/journal')=>evaluateRequest({method,path,headers},{hostNames});

test('Host header parsing accepts IP literals and plain DNS names only',()=>{
 assert.deepEqual(parseAuthority('127.0.0.1:3000'),{hostname:'127.0.0.1',port:'3000',ipLiteral:true});
 assert.deepEqual(parseAuthority('[::1]:3000'),{hostname:'::1',port:'3000',ipLiteral:true});
 assert.deepEqual(parseAuthority('LOCALHOST.'),{hostname:'localhost',port:'',ipLiteral:false});
 assert.equal(parseAuthority('192.168.0.5').ipLiteral,true);
 for(const bad of ['','  ','evil.example/x','user@127.0.0.1','127.0.0.1:99999','[zz]:1','[::1]x','1.2.3.4.5','a b'])
  assert.equal(parseAuthority(bad),null,bad);
});

test('DNS rebinding: a foreign Host name is refused on every route, IP and localhost are not',()=>{
 for(const host of ['evil.example:3000','127.0.0.1.nip.io:3000','attacker.local:3000',undefined,'']){
  for(const path of ['/','/api/paper','/api/journal/export','/events']){
   const result=check({host},'GET',path);
   assert.equal(result.ok,false,`${host} ${path}`);assert.equal(result.status,403);assert.equal(result.code,'HOST_NOT_ALLOWED');
  }
 }
 for(const host of ['127.0.0.1:3000','localhost:3000','[::1]:3000','192.168.0.12:3000','10.0.0.7','my-pc:3000','my-pc.local:3000'])
  assert.equal(check({host}).ok,true,host);
});

test('cross-site browser writes are refused, same-origin writes are allowed',()=>{
 const host='127.0.0.1:3000';
 assert.equal(check({host,origin:'https://evil.example','content-type':'text/plain'},'POST','/api/paper/settings').code,'CROSS_SITE_REQUEST_BLOCKED');
 assert.equal(check({host,origin:'null'},'POST','/api/journal/delete').ok,false,'sandboxed iframe / file:// origin');
 assert.equal(check({host,origin:'http://127.0.0.1:3001'},'POST','/api/watchlist').ok,false,'different port is a different origin');
 assert.equal(check({host,origin:'http://localhost:3000'},'POST','/api/watchlist').ok,false,'localhost and 127.0.0.1 are different origins');
 assert.equal(check({host,'sec-fetch-site':'cross-site'},'POST','/api/scan').ok,false,'browser marker without Origin');
 assert.equal(check({host,'sec-fetch-site':'same-site'},'POST','/api/scan').ok,false,'sibling site');
 assert.equal(check({host,origin:'http://127.0.0.1:3000','sec-fetch-site':'same-origin'},'POST','/api/journal').ok,true);
 assert.equal(check({host:'192.168.0.12:3000',origin:'http://192.168.0.12:3000'},'POST','/api/journal').ok,true,'mobile LAN page');
 assert.equal(check({host:'localhost',origin:'http://localhost'},'POST','/api/journal').ok,true,'default port');
 assert.equal(check({host},'POST','/api/scan').ok,true,'non-browser client (supervisor, CLI) sends no Origin');
});

test('cross-site reads of API data are refused, page assets and navigation are not',()=>{
 const host='127.0.0.1:3000';
 for(const path of ['/api/journal','/api/paper/export','/events'])
  assert.equal(check({host,origin:'https://evil.example'},'GET',path).ok,false,path);
 assert.equal(check({host,'sec-fetch-site':'cross-site'},'GET','/').ok,true,'link from another site may open the dashboard');
 assert.equal(check({host,'sec-fetch-site':'none'},'GET','/api/paper').ok,true,'typed into the address bar');
 assert.equal(check({host,'sec-fetch-site':'same-origin'},'GET','/api/paper').ok,true);
});

test('allowed host names include the machine name and explicit ALLOWED_HOSTS only',()=>{
 const names=allowedHostNames({env:{ALLOWED_HOSTS:' Signal.LAN , bad host ,127.0.0.1, '},hostname:'Office-PC'});
 assert.deepEqual([...names].sort(),['localhost','office-pc','office-pc.local','signal.lan']);
 assert.deepEqual([...allowedHostNames({env:{},hostname:'build.example.com'})].sort(),['build.example.com','localhost']);
});

test('security headers forbid framing and MIME sniffing',()=>{
 assert.equal(SECURITY_HEADERS['X-Frame-Options'],'DENY');
 assert.equal(SECURITY_HEADERS['X-Content-Type-Options'],'nosniff');
 assert.ok(Object.isFrozen(SECURITY_HEADERS));
});
