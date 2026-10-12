import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BOOKING_DEADLINES, withBookingDeadline, runBookingPreflight } from '../src/whatsapp-booking-deadlines.js';
const timedOut = error => error?.code === 'booking_deadline_exceeded';
const aborted = error => error?.code === 'booking_aborted';

test('fixed separate policies and successful soft-threshold crossing do not abort customer work', async () => {
  assert.deepEqual(BOOKING_DEADLINES,{softMs:10000,transportMs:20000,customerMs:30000,operatorMs:60000});
  assert.equal(Object.isFrozen(BOOKING_DEADLINES),true);
  let now=1000, signal;
  const value=await withBookingDeadline(context=>{signal=context.signal;assert.equal(context.deadlineAt,31000);now=12000;assert.equal(context.remainingMs(),19000);return 'valid';},{timeoutMs:BOOKING_DEADLINES.customerMs,clock:()=>now});
  assert.equal(value,'valid');assert.equal(signal.aborted,false);
});
test('late successful response is rejected by the post-return clock check before timer dispatch', async () => {
  let now=0,signal;
  await assert.rejects(withBookingDeadline(context=>{signal=context.signal;now=30000;return 'late';},{timeoutMs:30000,clock:()=>now}),timedOut);
  assert.equal(signal.aborted,true);assert.equal(signal.reason.code,'booking_deadline_exceeded');
});
test('real timer boundary aborts a hung operation and late completion never restarts it', async t => {
  t.mock.timers.enable({apis:['setTimeout']});
  let release,calls=0,signal;
  const work=withBookingDeadline(context=>{calls++;signal=context.signal;return new Promise(resolve=>release=resolve);},{timeoutMs:20000,clock:()=>0});
  await Promise.resolve();const rejected=assert.rejects(work,timedOut);
  t.mock.timers.tick(20000);await rejected;
  assert.equal(signal.aborted,true);release('late result');await Promise.resolve();assert.equal(calls,1);
});
test('external cancellation is linked, bounded and does not disclose arbitrary abort reasons', async () => {
  const parent=new AbortController();let signal;
  const work=withBookingDeadline(context=>{signal=context.signal;return new Promise(()=>{});},{timeoutMs:30000,signal:parent.signal});
  await Promise.resolve();parent.abort('PRIVATE CUSTOMER TEXT');
  await assert.rejects(work,error=>aborted(error)&&!error.message.includes('PRIVATE'));
  assert.equal(signal.aborted,true);
  let called=false;
  await assert.rejects(withBookingDeadline(()=>{called=true;},{timeoutMs:30000,signal:parent.signal}),aborted);
  assert.equal(called,false);
});
test('zero remaining time and invalid policy never invoke work', async () => {
  let called=0;
  await assert.rejects(withBookingDeadline(()=>called++,{timeoutMs:0}),timedOut);
  for(const timeoutMs of [-1,60001,NaN,1.5])await assert.rejects(withBookingDeadline(()=>called++,{timeoutMs}),TypeError);
  assert.equal(called,0);
});
test('nested transport is clipped to customer deadline instead of restarting its own timeout', async () => {
  let now=0,innerDeadline;
  await assert.rejects(withBookingDeadline(async customer=>{
    now=15000;
    return withBookingDeadline(transport=>{innerDeadline=transport.deadlineAt;assert.equal(transport.remainingMs(),15000);now=30000;return 'late';},{timeoutMs:BOOKING_DEADLINES.transportMs,clock:()=>now,signal:customer.signal});
  },{timeoutMs:BOOKING_DEADLINES.customerMs,clock:()=>now}),timedOut);
  assert.equal(innerDeadline,30000);
});
test('operator preflight includes prepare, one customer-shaped run, and settlement in its 60-second envelope', async () => {
  let now=0;const calls=[];
  const result=await runBookingPreflight({
    prepare:context=>{calls.push('prepare');assert.equal(context.deadlineAt,60000);now=10000;return 'prepared';},
    run:context=>{calls.push('run');assert.equal(context.prepared,'prepared');assert.equal(context.deadlineAt,40000);now=25000;return 'verified';},
    settle:context=>{calls.push('settle');assert.equal(context.deadlineAt,60000);assert.equal(context.outcome,'success');assert.equal(context.result,'verified');assert.equal(context.remainingMs(),35000);now=59000;},
  },{clock:()=>now});
  assert.equal(result,'verified');assert.deepEqual(calls,['prepare','run','settle']);
});
test('operator preparation consumes outer time and cannot extend the nested customer deadline', async () => {
  let now=0,runs=0,settlements=0;
  await assert.rejects(runBookingPreflight({prepare:()=>{now=40000;},run:context=>{runs++;assert.equal(context.deadlineAt,60000);now=60000;return 'late';},settle:()=>{settlements++;}},{clock:()=>now}),timedOut);
  assert.equal(runs,1);assert.equal(settlements,0,'no settlement starts after total expiry');
});
test('customer timeout can settle as uncertain within remaining operator time without retrying', async () => {
  let now=0,runs=0,settlements=0;
  await assert.rejects(runBookingPreflight({prepare:()=>{now=5000;},run:()=>{runs++;now=35000;return 'late';},settle:context=>{settlements++;assert.equal(context.outcome,'timeout');assert.equal(context.result,undefined);assert.equal(context.signal.aborted,false);now=40000;}},{clock:()=>now}),timedOut);
  assert.equal(runs,1);assert.equal(settlements,1);
});
test('preparation and settlement are both bounded by the outer deadline', async () => {
  let now=0,runs=0;
  await assert.rejects(runBookingPreflight({prepare:()=>{now=61000;},run:()=>{runs++;},settle:()=>assert.fail('no late settlement')},{clock:()=>now}),timedOut);
  assert.equal(runs,0);
  now=0;
  await assert.rejects(runBookingPreflight({prepare:()=>null,run:()=>true,settle:()=>{now=61000;}},{clock:()=>now}),timedOut);
});
test('operator abort does not run or settle after a late preparation result', async () => {
  const parent=new AbortController();let release,runs=0,settlements=0;
  const work=runBookingPreflight({prepare:()=>new Promise(resolve=>release=resolve),run:()=>{runs++;},settle:()=>{settlements++;}},{signal:parent.signal});
  await Promise.resolve();parent.abort();await assert.rejects(work,aborted);release('late');
  await Promise.resolve();await Promise.resolve();assert.equal(runs,0);assert.equal(settlements,0);
});
