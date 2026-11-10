// Fault injection must change the observed identity even when an inode exceeds
// Number's exact integer range. Adding 1 to such a Number can be a no-op.
import assert from 'node:assert/strict';

export function distinctStatIdentity(stat){
 const value=stat.ino;
 let ino;
 if(typeof value==='bigint')ino=value===0n?1n:0n;
 else if(typeof value==='number'&&Number.isFinite(value))ino=value===0?1:0;
 else if(typeof value==='string'&&/^\d+$/.test(value))ino=value==='0'?'1':'0';
 else throw new TypeError('Expected a numeric filesystem inode identity');
 assert.notEqual(String(ino),String(value),'the identity fault must actually change the compared inode');
 return Object.assign(Object.create(Object.getPrototypeOf(stat)),stat,{ino});
}
