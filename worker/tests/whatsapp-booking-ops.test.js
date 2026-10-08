import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { bookingPilotOpsPage } from '../src/whatsapp-booking-ops.js';
const env = { BOOKING_URL: 'https://staging.edenmish.com', WHATSAPP_BOOKING_MODE: 'conversation_only' };
test('pilot operator page is unavailable in production, full mode, other hosts and mutations', async () => {
  for(const [url, overrides, method] of [
    ['https://ops.edenmish.com/pilot-ops', {}, 'GET'],
    ['https://ops-staging.edenmish.com/pilot-ops', {WHATSAPP_BOOKING_MODE:'full'}, 'GET'],
    ['https://ops-staging.edenmish.com/pilot-ops', {BOOKING_URL:'https://edenmish.com'}, 'GET'],
    ['https://ops-staging.edenmish.com/pilot-ops', {}, 'POST'],
  ]) assert.equal(bookingPilotOpsPage(new Request(url,{method}),{...env,...overrides}).status,404);
});
test('pilot operator shell reuses same-origin HttpOnly login and protected booking APIs with no credential embedding', async () => {
  const r = await worker.fetch(new Request('https://ops-staging.edenmish.com/pilot-ops'), {...env, OPS_PIN:'never-embed-this', SESSION_SECRET:'never-embed-secret'}, {});
  const page=await r.text();
  assert.equal(r.status,200); assert.equal(r.headers.get('Cache-Control'),'no-store');
  assert.match(r.headers.get('Content-Security-Policy'),/connect-src 'self'/);
  assert.match(page,/credentials: 'same-origin'/); assert.match(page,/whatsapp\/bookings/); assert.match(page,/\/pause/);
  assert.doesNotMatch(page,/never-embed|localStorage|sessionStorage|\.innerHTML|api-origin\.js|\/api\/orders/);
  const unauth=await worker.fetch(new Request('https://ops-staging.edenmish.com/api/ops/whatsapp/bookings'),env,{});
  assert.equal(unauth.status,401);
});
