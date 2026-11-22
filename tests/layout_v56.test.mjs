import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const html=readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
test('live (실매매) status DOM slots are present and the news summary and sidebar caption are removed',()=>{
 for(const id of ['liveModeBadge','liveStatus','livePositions','liveSummary','liveClosed','liveSkipped'])assert.match(html,new RegExp(`id="${id}"`));
 for(const removed of ['structureList','structurePager','historyList','historyPager','scanRecentList','scanRecentPager','showWatchButton','scanPageControls','scanPageInfo'])assert.doesNotMatch(html,new RegExp(`id="${removed}"`));
 assert.doesNotMatch(html,/id="marketCommentary"|class="sidebar-footnote"/);
});

test('testnet PnL is the first section, above the controls and open positions',()=>{
 const summary=html.indexOf('id="testnetSummarySection"');
 assert.ok(summary>html.indexOf('id="liveControl"'));
 assert.ok(summary<html.indexOf('id="liveModeDetails"'));
 assert.ok(summary<html.indexOf('id="liveArm"'));
 assert.ok(summary<html.indexOf('id="livePositions"'));
});
