import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
// The scanner, chart, quote-check and alert pages were removed from the dashboard (user 2026-11-17);
// their display tests went with them. The server-side scanner keeps its own tests.
const html=fs.readFileSync(new URL('../public/index.html',import.meta.url),'utf8');

test('TradFi, BingX·Gate.io quote and 자동 모의매매 pages are removed; live order control has its own 실매매 page',()=>{
 assert.equal(fs.existsSync(new URL('../public/paper_ui.js',import.meta.url)),false,'the paper screen was replaced by the live screen');
 assert.doesNotMatch(html,/id="paper"|paper_ui\.js|자동 모의매매 PNL|href="#paper"/);
 assert.equal(fs.existsSync(new URL('../public/tradfi.js',import.meta.url)),false);assert.equal(fs.existsSync(new URL('../public/venues.js',import.meta.url)),false);
 assert.doesNotMatch(html,/id="tradfi"|id="venues"|tradfi\.js|venues\.js|TradFi/);
 assert.match(html,/id="live" [^>]*data-workspace-route="live"[\s\S]*id="liveControl"[\s\S]*id="liveArm"/);assert.match(html,/src="\/live_control\.js"/);
});
