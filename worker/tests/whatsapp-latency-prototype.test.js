import {test} from 'node:test';
import assert from 'node:assert/strict';
import {stageTimings} from '../src/whatsapp-stage-timing.js';
import {continuationHistorySnapshot} from '../src/whatsapp-continuation-snapshot.js';
import {parallelRemoteReads} from '../scripts/whatsapp-review-r3-cli.mjs';

test('diagnostic spans have fixed keys, bounded numbers and include failures without retaining text',async()=>{
 let time=0;const spans=stageTimings(()=>time);
 await assert.rejects(()=>spans.measure('private text',()=>{}),/stage_unknown/);
 await assert.rejects(()=>spans.measure('transport',()=>{time=90000;throw Error('private response');}));
 for(let i=0;i<40;i++)await spans.measure('transport',()=>{time-=1;});
 const a=spans.snapshot();assert.deepEqual(a,{transport:{calls:32,totalMs:60000,maxMs:60000}});a.transport.calls=0;assert.equal(spans.snapshot().transport.calls,32);
});
test('parallel read barrier runs history alongside dependent deployment chain, awaits both on failure',async()=>{
 const events=[];let release;const wait=new Promise(r=>release=r);
 const pending=parallelRemoteReads(async()=>{events.push('deployment');await wait;events.push('version');return 'metadata';},async()=>{events.push('history');return 'hash';});
 await Promise.resolve();assert.deepEqual(events,['deployment','history']);release();assert.deepEqual(await pending,['metadata','hash']);assert.deepEqual(events,['deployment','history','version']);
 for(const failing of [0,1]){
  let finish,settled=false,otherFinished=false;const other=new Promise(r=>finish=()=>{otherFinished=true;r('ok');});
  const branches=[()=>other,()=>other];branches[failing]=()=>{throw Error('private failure');};
  const result=parallelRemoteReads(...branches).finally(()=>{settled=true;});await Promise.resolve();await Promise.resolve();assert.equal(settled,false);
  finish();await assert.rejects(result,/remote_reads_unverified/);assert.equal(otherFinished,true);
 }
});
function snapshotDB(change=()=>{}){let batchCalls=0;return {get batchCalls(){return batchCalls;},prepare(sql){return {sql,bind(...args){this.args=args;return this;}};},async batch(statements){batchCalls++;assert.equal(statements.length,20);const rows=statements.map(()=>({success:true,results:[]}));change(rows);return rows;}};}
test('history facade forbids unknown SQL, wrong binding, repeat consumption and unused lookups',async()=>{
 const DB=snapshotDB(),s=await continuationHistorySnapshot(DB,'pilot',['p1','p2','p3']);
 assert.throws(()=>s.assertConsumed(),/incomplete/);await assert.rejects(()=>s.prepare('SELECT secret').first(),/lookup/);
 await assert.rejects(()=>s.prepare('SELECT * FROM whatsapp_pilot_budgets WHERE pilot_id=?').bind('other').first(),/lookup/);
 assert.equal(await s.prepare('SELECT * FROM whatsapp_pilot_budgets WHERE pilot_id=?').bind('pilot').first(),null);
 await assert.rejects(()=>s.prepare('SELECT * FROM whatsapp_pilot_budgets WHERE pilot_id=?').bind('pilot').first(),/lookup/);assert.equal(DB.batchCalls,1);
});
for(const change of [r=>r.pop(),r=>r.push(r[0]),r=>delete r[2].success,r=>r[0].results.push({},{}),r=>r[1].results.push(null),r=>r[0].results='private'])test('invalid batch shape never falls back to individual reads',async()=>{
 const DB=snapshotDB(change);await assert.rejects(()=>continuationHistorySnapshot(DB,'pilot',['p1','p2','p3']),/invalid/);assert.equal(DB.batchCalls,1);
});
