"""Offline mocks only: never invokes op, a provider, or a real credential."""
import importlib.util, json, tempfile, unittest
from pathlib import Path
from types import SimpleNamespace
spec=importlib.util.spec_from_file_location('helper',Path(__file__).parent.parent/'scripts/whatsapp-review-r3-onepassword.py')
h=importlib.util.module_from_spec(spec);spec.loader.exec_module(h)
KEY='sk-synthetic-service-key-only'
class Handoff(unittest.TestCase):
 def item(self):
  return {'id':'i'*26,'vault':{'id':'v'*26},'title':'OpenAI API Key - For Edenmish','category':'API_CREDENTIAL','sections':[{'id':'s','label':'service key'}],'fields':[{'label':'api key','type':'CONCEALED','value':'sk-synthetic-wrong-key'},{'label':'service key','type':'CONCEALED','value':KEY}]}
 def test_selection(self):
  self.assertEqual(h.select_service_key(self.item(),lambda labels:None),KEY)
  item=self.item();item['fields'][1]['label']='password';item['fields'][1]['section']={'id':'s'}
  self.assertEqual(h.select_service_key(item,lambda labels:None),KEY)
  item['fields']=item['fields'][:1];self.assertIsNone(h.select_service_key(item,lambda labels:0))
 def test_ambiguous_cancel(self):
  item=self.item();item['fields'].append(dict(item['fields'][1]));self.assertIsNone(h.select_service_key(item,lambda labels:None))
 def run_mock(self,answer='YES',off=0,mode='preflight',wrong_identity=False,execution_timeout=False):
  with tempfile.TemporaryDirectory() as tmp:
   root=Path(tmp);root.chmod(0o700)
   a=root/'approval.json';m=root/'metadata.json';a.write_text(json.dumps({'stateDirectory':tmp}));m.write_text(json.dumps({'item':self.item()}));a.chmod(0o600);m.chmod(0o600)
   calls=[]
   def command(args,**kwargs):
    calls.append((args,kwargs))
    if 'verify' in args:return SimpleNamespace(returncode=off,stdout='',stderr='')
    if 'get' in args:
     item=self.item()
     if wrong_identity:item['id']='x'*26
     return SimpleNamespace(returncode=0,stdout=json.dumps(item),stderr='')
    self.assertEqual(kwargs['input'],KEY+'\n');self.assertNotIn(KEY,str(args));self.assertNotIn(KEY,str(kwargs['env']))
    if execution_timeout:raise TimeoutError('synthetic')
    return SimpleNamespace(returncode=0,stdout='sanitized',stderr='')
   result=h.handoff('/synthetic/node',a,m,mode,command=command,prompt=lambda _:answer,interactive=True)
   state=(root/('onepassword-'+mode+'-status.json')).read_text();self.assertNotIn(KEY,state)
   status=json.loads(state);self.assertFalse(status['localSecretPersisted']);self.assertEqual(status['temporaryBindingMayExist'],mode=='key-install' and len(calls)==3)
   with self.assertRaises(FileExistsError):h.handoff('/synthetic/node',a,m,mode,command=command,prompt=lambda _:'YES',interactive=True)
   return result,calls
 def test_preflight_and_install(self):
  for mode in ['preflight','key-install']:
   result,calls=self.run_mock(mode=mode);self.assertEqual(result,0);self.assertEqual(len(calls),3)
 def test_uncertain_install_does_not_claim_remote_key_absent(self):
  result,calls=self.run_mock(mode='key-install',execution_timeout=True);self.assertEqual(result,1);self.assertEqual(len(calls),3)
 def test_cancel_before_access(self):
  result,calls=self.run_mock(answer='');self.assertEqual(result,1);self.assertEqual(calls,[])
 def test_off_failure_before_access(self):
  result,calls=self.run_mock(off=1);self.assertEqual(result,1);self.assertEqual(len(calls),1)
 def test_wrong_item_blocks_execution(self):
  result,calls=self.run_mock(wrong_identity=True);self.assertEqual(result,1);self.assertEqual(len(calls),2)
 def test_noninteractive_refused(self):self.assertEqual(h.handoff('node','missing','missing',interactive=False),1)
if __name__=='__main__':unittest.main()
