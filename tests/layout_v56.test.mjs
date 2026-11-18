import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const html=readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
test('live (실매매) status DOM slots are present and the news summary and sidebar caption are removed',()=>{
 for(const id of ['liveModeBadge','liveStatus','livePositions','liveSummary','liveClosed','liveSkipped'])assert.match(html,new RegExp(`id="${id}"`));
 for(const removed of ['structureList','structurePager','historyList','historyPager','scanRecentList','scanRecentPager','showWatchButton','scanPageControls','scanPageInfo'])assert.doesNotMatch(html,new RegExp(`id="${removed}"`));
 assert.doesNotMatch(html,/id="marketCommentary"|class="sidebar-footnote"/);
});
