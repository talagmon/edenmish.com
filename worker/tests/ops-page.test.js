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

test('ops board surfaces a held package with a fee suggestion and the 24h auto-return notice', () => {
  const html = opsHtml({});
  // The retained-package banner is wired into the card renderer.
  assert.match(html, /function retainedBanner\(o\)/);
  assert.match(html, /if\(o\.retained_by_driver\)h\+=retainedBanner\(o\)/);
  // A hold prompts Ops for the address+payment link and states the auto-return SLA; a return
  // tells Ops no action is needed.
  assert.match(html, /תוך 24 שעות/);
  assert.match(html, /אין צורך בפעולה/);
});
