"""USER-RUN ONLY: one existing Eden credential; three bounded GETs; no retries/writes.

Agent must never launch this file with a real credential reference or inspect op output.
The existing app must already possess read_products. No OAuth or grant expansion.
"""
import argparse
import json
import os
from pathlib import Path
import subprocess
import urllib.request
import uuid

HOST = 'r013gt-fc.myshopify.com'
SHOP = 100603396413
PRODUCT = 15422576689469
VERSION = '2026-04'

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        raise RuntimeError('redirect_rejected')

def audit_variant(product):
    if product.get('id') != PRODUCT or product.get('status') != 'draft':
        raise RuntimeError('product_identity_or_status_mismatch')
    variants = product.get('variants')
    if not isinstance(variants, list) or len(variants) != 1:
        raise RuntimeError('single_variant_not_verified')
    v = variants[0]
    if not isinstance(v.get('id'), int) or v['id'] <= 0 or v.get('sku') != 'EDENMISH-PAYMENT-REHEARSAL-1ILS':
        raise RuntimeError('variant_identity_mismatch')
    if v.get('price') != '1.00' or v.get('taxable') is not False or v.get('requires_shipping') is not False or v.get('inventory_management') is not None:
        raise RuntimeError('variant_settings_mismatch')
    return {'variant_id': 'gid://shopify/ProductVariant/' + str(v['id']),
            'sku': v['sku'], 'price': v['price'], 'taxable': False,
            'requires_shipping': False, 'inventory_management': None,
            'all_channel_publications_verified': False}

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--field-ref', required=True, help='User-selected EXISTING Eden Shopify Admin token 1Password reference, never a token value')
    args = parser.parse_args()
    if not args.field_ref.startswith('op://') or args.field_ref.count('/') < 4:
        raise SystemExit('Invalid nonsecret field reference')
    receipt = {'shop_host': HOST, 'expected_shop_id': SHOP, 'product_id': PRODUCT,
               'calls': 0, 'remote_writes': 0, 'retries': 0, 'credential_persisted': False}
    token = None
    try:
        token = subprocess.run(['op', 'read', args.field_ref], check=True,
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=30).stdout.decode().strip()
        if not token or any(c.isspace() for c in token):
            raise RuntimeError('credential_unavailable')
        opener = urllib.request.build_opener(NoRedirect())
        def read(path):
            if receipt['calls'] >= 3:
                raise RuntimeError('read_cap')
            receipt['calls'] += 1
            req = urllib.request.Request('https://' + HOST + path, method='GET',
                headers={'X-Shopify-Access-Token': token, 'Accept': 'application/json'})
            with opener.open(req, timeout=10) as response:
                if response.headers.get('X-Shopify-API-Version', VERSION) != VERSION:
                    raise RuntimeError('api_version_mismatch')
                body = response.read(65537)
                if len(body) > 65536:
                    raise RuntimeError('response_limit')
                return json.loads(body)
        scopes = read('/admin/oauth/access_scopes.json')
        names = sorted(s['handle'] for s in scopes['access_scopes'] if isinstance(s.get('handle'), str))
        receipt['installed_scope_names'] = names
        if 'read_products' not in names and 'write_products' not in names:
            raise RuntimeError('missing_existing_read_products_no_grant_expansion')
        shop = read('/admin/api/' + VERSION + '/shop.json?fields=id,myshopify_domain,currency')['shop']
        if shop.get('id') != SHOP or shop.get('myshopify_domain') != HOST or shop.get('currency') != 'ILS':
            raise RuntimeError('shop_identity_mismatch')
        receipt['shop_identity_verified'] = True
        product = read('/admin/api/' + VERSION + '/products/' + str(PRODUCT) + '.json?fields=id,status,variants')['product']
        receipt.update(audit_variant(product))
        receipt['status'] = 'variant_resolved_full_checkout_audit_pending'
    except Exception as error:
        # Never print exception repr, response bodies, credential output or headers.
        receipt['status'] = 'blocked_no_retry'
        receipt['reason'] = str(error) if isinstance(error, RuntimeError) else type(error).__name__
    finally:
        token = None
    folder = Path(__file__).resolve().parent / 'user-run-receipts'
    folder.mkdir(mode=0o700, exist_ok=True)
    path = folder / ('product-read-' + uuid.uuid4().hex + '.json')
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w') as out:
        json.dump(receipt, out, indent=2)
        out.write('\n')
    print(receipt['status'] + ': ' + str(path))

if __name__ == '__main__':
    main()
