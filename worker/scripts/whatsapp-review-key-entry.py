#!/usr/bin/env python3
"""Future user-operated hidden entry. No retrieval, storage, env or argv secret."""
import getpass, os, subprocess, sys, warnings
warnings.simplefilter("error", getpass.GetPassWarning)
from pathlib import Path
if len(sys.argv) not in (3,4):
    raise SystemExit('Usage: python3 whatsapp-review-key-entry.py /absolute/node /private/approval.json')
node,approval=sys.argv[1:3]
mode=sys.argv[3] if len(sys.argv)==4 else 'preflight'
if mode not in ('preflight','key-install'): raise SystemExit('Unsupported action')
key=getpass.getpass('Existing EdenMish OpenAI key (hidden; '+mode+'): ')
if getpass.getpass('Type YES for the approved '+mode+' action (hidden): ')!='YES':
    key=None
    raise SystemExit('Cancelled. No call.')
env={k:os.environ[k] for k in ('HOME','PATH','TMPDIR') if k in os.environ}
try:
    result=subprocess.run([node,str(Path(__file__).with_name('whatsapp-review-cli.mjs')),mode,approval],input=key+'\n',text=True,env=env)
finally:
    key=None
print('Finished. Helper retained no local key. Temporary staging binding is used only for an approved key-install action.')
raise SystemExit(result.returncode)
