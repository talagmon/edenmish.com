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

test('ops exposes per-driver manual and QR pairing without embedding review credentials', () => {
  const html = opsHtml({});

  assert.match(html, /חיבור אפליקציית נהג/);
  assert.match(html, /\/api\/ops\/driver\/invitations/);
  assert.match(html, /קוד ה־QR/);
  assert.match(html, /לאחר שימוש ראשון הקוד מתבטל אוטומטית/);
  assert.doesNotMatch(html, /DRIVER_REVIEW_CODE|DRIVER_ONE_TIME_CODE/);
});
