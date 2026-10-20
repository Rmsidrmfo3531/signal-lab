import test from 'node:test';
import assert from 'node:assert/strict';
import {SCAN_PAGE_SIZE,paginateScan,scanPageWindow} from '../public/scan_pagination.js';
test('candidate pages contain five records and preserve order',()=>{
 const list=Array.from({length:27},(_,i)=>'TOKEN'+i);
 const first=paginateScan(list,1),second=paginateScan(list,2),last=paginateScan(list,6);
 assert.equal(SCAN_PAGE_SIZE,5);assert.deepEqual(first.items,list.slice(0,5));assert.deepEqual(second.items,list.slice(5,10));
 assert.deepEqual(last.items,list.slice(25,27));assert.equal(last.total,27);assert.equal(last.pages,6);
 assert.deepEqual([...Array.from({length:6},(_,i)=>paginateScan(list,i+1).items)].flat(),list);
});
test('candidate pagination clamps out of range and empty lists',()=>{
 assert.deepEqual(paginateScan([],20),{page:1,pages:1,total:0,start:0,end:0,items:[]});
 assert.equal(paginateScan([1,2],999).page,1);assert.equal(paginateScan([1,2],-2).page,1);
 assert.deepEqual(scanPageWindow(6,10),[4,5,6,7,8]);
});
