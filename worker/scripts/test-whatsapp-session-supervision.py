import importlib.util,unittest
from pathlib import Path
p=Path(__file__).with_name('whatsapp-session-supervision.py');spec=importlib.util.spec_from_file_location('supervision',p);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class Tests(unittest.TestCase):
 def setUp(self):
  self.g=dict(id='grant',expires_at=100000,historical_micros=405100,historical_model_micros=330000,fee_cushion_micros=500000,spent_micros=30000,model_micros=30000,stopped_reason='model_uncertain',lock_id=None,inbound=1,outbound=0,address=0,model=1)
  self.ops=[dict(id='grant:model:event',grant_id='grant',kind='model',status='uncertain',finished_at=1000)]
 def decide(self,t=1001,approved=True):return m.supervision_decision(self.g,self.ops,t,approved)
 def test_only_explicit_policy_allows_bounded_grace(self):
  self.assertEqual(self.decide(),('grace','fixed_notice_only',31000));self.assertEqual(self.decide(approved=False)[0],'stop')
 def test_other_stops_never_wait(self):
  for reason in ['operator_stop','provider_uncertain','cost_unknown','expired','model_failure']:
   self.g['stopped_reason']=reason;self.assertEqual(self.decide()[0],'stop')
 def test_unconditional_expiry_and_grace_end(self):
  self.assertEqual(self.decide(31000)[0],'stop');self.g['expires_at']=1500
  self.assertEqual(self.decide()[2],1500);self.assertEqual(self.decide(1500)[1],'expired')
 def test_no_notice_wait_after_claim_deadline_or_exhausted_quota(self):
  self.assertEqual(self.decide(16001)[0],'stop');self.g['outbound']=10;self.assertEqual(self.decide()[0],'stop')
 def test_unknown_model_failure_never_waits(self):
  self.ops[0]['finished_at']=None;self.assertEqual(self.decide()[0],'stop')
 def test_pending_notice_cannot_extend_grace(self):
  self.g['lock_id']='grant:outbound:failure-notice';self.ops.append(dict(id=self.g['lock_id'],grant_id='grant',kind='outbound',status='pending',reserved_micros=11300,outcome='notice_sending:event:0',created_at=2000))
  self.assertEqual(self.decide(3000)[0],'grace');self.assertEqual(self.decide(31000)[0],'stop')
  for status in ['settled','uncertain']:
   self.ops[-1]['status']=status;self.assertEqual(self.decide(3000)[1],'notice_finished')
 def test_budget_or_history_change_rejected(self):
  for field,value in [('historical_micros',300000),('historical_model_micros',300000),('fee_cushion_micros',0),('spent_micros',1094901),('model_micros',150001)]:
   old=self.g[field];self.g[field]=value
   with self.assertRaises(ValueError):self.decide()
   self.g[field]=old
 def test_unrelated_notice_does_not_gain_grace(self):
  self.g['lock_id']='grant:outbound:failure-notice';self.ops.append(dict(id=self.g['lock_id'],grant_id='grant',kind='outbound',status='pending',reserved_micros=11300,outcome='notice_sending:wrong:0',created_at=1000))
  self.assertEqual(self.decide()[1],'notice_unverified')
if __name__=='__main__':unittest.main()
