import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const html=readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
test('live (실매매) status DOM slots and market commentary present for mobile and desktop',()=>{
 for(const id of ['liveModeBadge','liveStatus','livePositions','liveSummary','liveClosed','liveSkipped'])assert.match(html,new RegExp(`id="${id}"`));
 for(const removed of ['structureList','structurePager','historyList','historyPager','scanRecentList','scanRecentPager','showWatchButton','scanPageControls','scanPageInfo'])assert.doesNotMatch(html,new RegExp(`id="${removed}"`));
 assert.match(html,/id="marketCommentary"/);
});
