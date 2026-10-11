#!/usr/bin/env python3
"""User-operated existing-key handoff. Never run unattended; no key files/logs."""
import getpass, json, os, re, subprocess, sys, warnings
from pathlib import Path
warnings.simplefilter('error', getpass.GetPassWarning)

def select_service_key(item, choose):
    label = lambda value: re.sub(r'[-_\s]', '', str(value)).lower()
    sections = {s.get('id') for s in item.get('sections', []) if label(s.get('label')) == 'servicekey'}
    candidates = []
    for field in item.get('fields', []):
        section = field.get('section') or {}
        if label(field.get('label')) == 'apikey':
            continue
        if label(field.get('label')) != 'servicekey' and section.get('id') not in sections:
            continue
        value = field.get('value')
        if field.get('type') in ('CONCEALED', 'STRING') and isinstance(value, str) and re.fullmatch(r'sk-[A-Za-z0-9_-]{12,509}', value.strip()):
            candidates.append((field.get('label') or 'service-key section field', value.strip()))
    if not candidates:
        return None
    index = 0 if len(candidates) == 1 else choose([c[0] for c in candidates])
    return candidates[index][1] if isinstance(index, int) and 0 <= index < len(candidates) else None

def handoff(node, approval_path, metadata_path, mode='preflight', *, command=subprocess.run, prompt=getpass.getpass, interactive=None):
    if interactive is None:
        interactive = sys.stdin.isatty() and sys.stdout.isatty()
    if not interactive or mode not in ('preflight', 'key-install'):
        return 1
    approval_path, metadata_path = Path(approval_path), Path(metadata_path)
    for path in (approval_path, metadata_path):
        if path.stat().st_mode & 0o077:
            return 1
    approval = json.loads(approval_path.read_text())
    state_dir = Path(approval['stateDirectory'])
    if state_dir.stat().st_mode & 0o077:
        return 1
    metadata = json.loads(metadata_path.read_text())['item']
    if metadata.get('title') != 'OpenAI API Key - For Edenmish' or metadata.get('category') != 'API_CREDENTIAL':
        return 1
    vault, item = metadata['vault']['id'], metadata['id']
    if not all(re.fullmatch(r'[a-z0-9]{26}', x) for x in (vault, item)):
        return 1
    # Exclusive local attempt marker complements the durable provider reservation.
    state = state_dir / ('onepassword-' + mode + '-status.json')
    fd = os.open(state, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w') as out:
        json.dump({'status':'awaiting_user', 'localSecretPersisted':False, 'temporaryBindingMayExist':False}, out)
    temporary_binding_may_exist = False
    def record(status):
        state.write_text(json.dumps({'status':status, 'localSecretPersisted':False, 'temporaryBindingMayExist':temporary_binding_may_exist}) + '\n')
    cli = str(Path(__file__).with_name('whatsapp-review-r3-cli.mjs'))
    env = {k:os.environ[k] for k in ('HOME', 'PATH', 'TMPDIR') if k in os.environ}
    key = result = item_data = None
    try:
        print('Existing EdenMish service-key only. WhatsApp stays OFF during this handoff.')
        if prompt('Type YES for the approved ' + mode + ' action (hidden): ') != 'YES':
            record('cancelled'); return 1
        checked = command([node, cli, 'verify', str(approval_path)], env=env, capture_output=True, text=True, timeout=120)
        if checked.returncode != 0:
            record('off_check_unconfirmed'); return 1
        result = command(['/opt/homebrew/bin/op', 'item', 'get', item, '--vault', vault, '--format=json'], env=env, capture_output=True, text=True, timeout=120)
        if result.returncode != 0:
            record('onepassword_unconfirmed'); return 1
        item_data = json.loads(result.stdout); result.stdout = ''; result.stderr = ''; result = None
        if item_data.get('id') != item or item_data.get('vault', {}).get('id') != vault or item_data.get('title') != metadata['title'] or item_data.get('category') != 'API_CREDENTIAL':
            record('item_identity_unconfirmed'); return 1
        def choose(labels):
            print('Choose the service-key field; values are hidden. Enter cancels.')
            for i, name in enumerate(labels, 1):
                print(str(i) + '. ' + re.sub(r'[\x00-\x1f\x7f]', '', name)[:100])
            answer = prompt('Field number (hidden): ')
            return int(answer) - 1 if re.fullmatch(r'[1-9][0-9]*', answer) else None
        key = select_service_key(item_data, choose); item_data = None
        if key is None:
            record('service_key_unconfirmed'); return 1
        temporary_binding_may_exist = mode == 'key-install'
        record('running_once')
        completed = command([node, cli, mode, str(approval_path)], input=key+'\n', env=env, capture_output=True, text=True, timeout=180)
        key = None
        record('finished_inspect_sanitized_report' if completed.returncode == 0 else 'unconfirmed_no_retry')
        print('Finished. No local key retained. Coordinator checks sanitized status; do not retry.')
        return completed.returncode
    except BaseException:
        record('interrupted_or_unconfirmed_no_retry')
        print('Stopped. No retry; coordinator checks sanitized status.')
        return 1
    finally:
        key = item_data = None
        if result is not None:
            result.stdout = ''; result.stderr = ''

if __name__ == '__main__':
    if len(sys.argv) not in (4, 5):
        raise SystemExit('Usage: helper /absolute/node /private/approval.json /private/item-metadata.json [preflight|key-install]')
    try:
        raise SystemExit(handoff(*sys.argv[1:]))
    except (OSError, ValueError, KeyError):
        raise SystemExit('Handoff refused; inspect non-secret preparation only. No retry.')
