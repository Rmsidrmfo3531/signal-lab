import test from 'node:test';
import assert from 'node:assert/strict';
import {parseRSS,tagNews,prepareNews,shouldNotifyArticle} from '../news.mjs';
const NOW=1792310400000;
const data=`<rss><channel><item><title><![CDATA[SEC approves Bitcoin ETF update]]></title><link>https://news.example/a</link><pubDate>${new Date(NOW-100000).toUTCString()}</pubDate><description>ETF policy</description></item><item><title>Malicious</title><link>javascript:alert(1)</link><pubDate>${new Date(NOW).toUTCString()}</pubDate></item></channel></rss>`;
test('RSS parse requires valid dates and http(s) links',()=>{const rows=parseRSS(data,'test',NOW);assert.equal(rows.length,1);assert.equal(rows[0].title,'SEC approves Bitcoin ETF update');assert.equal(rows[0].link,'https://news.example/a')});
test('news labels are heuristic, not verified price direction',()=>{const a=tagNews(parseRSS(data,'test',NOW)[0]);assert.equal(a.impact,'high');assert.equal(a.tone,'opportunity');assert.ok(a.symbols.includes('BTC'));assert.match(a.interpretation,/확인 필요/)});
test('only unseen high impact recent articles notify',()=>{const a=tagNews(parseRSS(data,'test',NOW)[0]);assert.equal(shouldNotifyArticle(a,new Set(),NOW),true);assert.equal(shouldNotifyArticle(a,new Set([a.id]),NOW),false);assert.equal(shouldNotifyArticle(a,new Set(),NOW+86400000),false)});
test('prepare news does not duplicate same links',()=>{const a=prepareNews([{name:'s1',body:data},{name:'s2',body:data}],NOW);assert.equal(a.length,1)});
test('new verified asset name is tagged without a hardcoded token dictionary',()=>{
 const sample={id:'x',title:'Institutional staking update for Kaspa blockchain',summary:'Kaspa network details',link:'https://news.example/b',published:NOW,source:'test'};
 const a=tagNews(sample,[{symbol:'KAS',name:'Kaspa'}]);
 assert.ok(a.symbols.includes('KAS'));
});
