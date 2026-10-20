import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const html=readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
const js=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
test('scan pagination and paper status DOM slots present for mobile and desktop',()=>{
 for(const id of ['scanRecentPageInfo','scanRecentPager','scanPageControls','scanPageInfo','paperMonitorTitle','paperMonitorQuotes','paperMonitorTrades','paperMonitorEvent','paperLiveIndicator'])assert.match(html,new RegExp(`id="${id}"`));
 assert.match(js,/paginateScan\(data,app.signalPage,SCAN_PAGE_SIZE\)/);
 assert.match(js,/app.signalPage=1;renderSignals/);
});
