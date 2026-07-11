import { test } from 'node:test';
import assert from 'node:assert/strict';

import { opsHtml } from '../src/pages.js';

test('server-rendered ops page uses explicit GPS controls without automatic prompts', () => {
  const html = opsHtml({});
  assert.match(html, /התחלת שיתוף מיקום/);
  assert.match(html, /הפסקת שיתוף מיקום/);
  assert.match(html, /aria-live="polite"/);
  assert.match(html, /function toggleGps\(id\)/);
  assert.doesNotMatch(html, /startGpsForActive/);
  assert.doesNotMatch(html, /if\(st==='to_pickup'\|\|st==='to_dropoff'\).*startWatch/);
});
