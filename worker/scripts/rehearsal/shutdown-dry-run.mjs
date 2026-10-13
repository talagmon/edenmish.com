import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {shutdownDecision} from './shutdown-policy.mjs';

const now=1791788400000;
const snapshot={runID:'synthetic-native-rehearsal',observedRunID:'synthetic-native-rehearsal',
  expiresAt:now,billingAt:now,projectedGrossMicros:6000000,requests:24,queueOperations:24,
  invoiceIssued:true,financiallyResolved:false};
if(process.argv[2]==='synthetic-child') {
  // No real adapter is implemented or reachable from this offline harness.
  process.stdout.write(JSON.stringify({pid:process.pid,decision:shutdownDecision(snapshot,now)}));
} else {
  const file=fileURLToPath(import.meta.url);
  const child=()=>JSON.parse(execFileSync(process.execPath,[file,'synthetic-child'],
    {env:{TMPDIR:'/tmp'},timeout:5000,encoding:'utf8',stdio:['ignore','pipe','pipe']}));
  const primary=child(),backstop=child();
  assert.notEqual(primary.pid,backstop.pid);
  for(const witness of [primary,backstop]){
    assert.equal(witness.decision.stop,true);
    assert.equal(witness.decision.actions[0],'stop_run_and_full_grant');
    assert.equal(witness.decision.actions.at(-1),'retain_scoped_financial_reconciliation');
  }
  // Backstop was launched independently, with no output/state from the primary.
  const receipt={status:'offline_shutdown_process_rehearsal_passed',synthetic:true,
    distinct_processes:true,primary,backstop,provider_calls:0,remote_writes:0,
    real_adapters_wired:false,live_supervisors_ready:false};
  writeFileSync(new URL('./shutdown-dry-run.json',import.meta.url),JSON.stringify(receipt,null,2)+'\n');
  process.stdout.write('Two independent synthetic process invocations passed; live supervisors remain unready.\n');
}
