import {test} from 'node:test';
import assert from 'node:assert/strict';
import {shutdownDecision} from './shutdown-policy.mjs';
const now=1791788400000;
const base={runID:'synthetic-run',observedRunID:'synthetic-run',expiresAt:now+1800000,
  billingAt:now,projectedGrossMicros:6000000,requests:0,queueOperations:0};
test('7 warning and 8 stop are operational limits',()=>{
 assert.equal(shutdownDecision({...base,projectedGrossMicros:7000000},now).stop,false);
 assert.equal(shutdownDecision({...base,projectedGrossMicros:7000000},now).warning,true);
 assert.equal(shutdownDecision({...base,projectedGrossMicros:8000000},now).stop,true);
});
test('expiry and operator stop end the run',()=>{
 for(const s of [{...base,expiresAt:now},{...base,operatorStop:true}]) assert.equal(shutdownDecision(s,now).stop,true);
});
test('stale, missing and wrong-run evidence fail closed',()=>{
 for(const s of [{...base,billingAt:now-300001},{...base,observedRunID:'old-run'},
  {...base,billingAt:undefined},{...base,projectedGrossMicros:NaN}])assert.equal(shutdownDecision(s,now).stop,true);
});
test('request, queue, provider and uncertain-effect limits stop',()=>{
 for(const delta of [{requests:201},{queueOperations:101},{providerAllowanceExceeded:true},
  {uncertainPayment:true},{recipientMismatch:true}])assert.equal(shutdownDecision({...base,...delta},now).stop,true);
});
test('issued unresolved invoice retains financial callback and signing binding',()=>{
 const result=shutdownDecision({...base,operatorStop:true,invoiceIssued:true,financiallyResolved:false},now);
 assert.equal(result.retainReconciliation,true);assert.equal(result.actions.at(-1),'retain_scoped_financial_reconciliation');
 assert.equal(result.actions.some(a=>/refund|delete|mark_paid/.test(a)),false);
});
test('resolved invoice permits removal after admission and booking traffic stop',()=>{
 const result=shutdownDecision({...base,operatorStop:true,invoiceIssued:true,financiallyResolved:true},now);
 assert.equal(result.actions[0],'stop_run_and_full_grant');assert.equal(result.actions.at(-1),'remove_new_subscription_and_exposure');
});
