import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { bookingScheduleError, israelDay } from '../src/whatsapp-booking-schedule.js';
import { pickupPreference, pickupSlotChoices } from '../src/whatsapp-booking-slots.js';
import { advanceBooking, newBooking, parseSchedule } from '../src/whatsapp-booking.js';
import { createOfflineBookingModel } from '../src/whatsapp-booking-model.js';

const website = vm.createContext({});
vm.runInContext(readFileSync(new URL('../../storefront/public/assets/scheduling.js', import.meta.url), 'utf8'), website);
const phone = '+972541234567';
const now = Date.parse('2026-10-11T07:00:00Z'); // Sunday, 10:00 Israel.
const quote = { price: 50, currency: 'ILS', review: false };
const services = () => ({
  quote: async () => quote,
  resolveAddress: async value => ({ address: value, city: 'תל אביב', lat: 32.08, lng: 34.78 }),
  create: () => assert.fail('interpretation cannot create checkout'),
});
async function review(at = now, schedule = '2026-10-11 13:00') {
  let state = newBooking();
  for (const text of ['start', 'small', 'דיזנגוף 10 תל אביב', 'הרצל 2 תל אביב', schedule, 'Test Person', 'fiction@example.com', 'none', 'none', 'book']) {
    state = (await advanceBooking(state, text, services(), { phone, now: at })).state;
  }
  assert.equal(state.phase, 'address_review');
  const result = await advanceBooking(state, '1', services(), { phone, now: at });
  assert.equal(result.state.phase, 'review');
  return result.state;
}

test('exact and suggested scheduling match the unchanged website for every hour across operating days', () => {
  // Includes summer/winter UTC offsets and an Israel day ahead of UTC.
  for (const iso of ['2026-10-11T07:00:00Z', '2026-10-11T07:01:00Z', '2026-10-11T07:00:59Z', '2026-10-08T21:30:00Z', '2026-11-01T08:00:00Z']) {
    const at = Date.parse(iso), today = israelDay(at);
    const local = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Jerusalem', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(at).split(':').map(Number);
    for (let offset = 0; offset < 8; offset++) {
      const date = new Date(Date.parse(today + 'T00:00:00Z') + offset * 86400000).toISOString().slice(0, 10);
      const day = new Date(date + 'T00:00:00Z').getUTCDay();
      const windows = website.EdenScheduling.generatePickupWindows({ service: 'standard', day, dateType: offset ? 'future' : 'today', now: { getHours: () => local[0], getMinutes: () => local[1] } });
      const starts = new Set(Array.from(windows, window => Number(window.slice(0, 2))));
      for (let hour = 0; hour < 24; hour++) {
        const text = `${date} ${String(hour).padStart(2, '0')}:00`;
        assert.equal(bookingScheduleError(date, hour, at) === null, starts.has(hour), `${iso} → ${text}`);
        assert.equal(Boolean(parseSchedule(text, at)), starts.has(hour), `typed ${text}`);
      }
      for (const slot of pickupSlotChoices({ date, period: 'any' }, at).slots) assert.ok(parseSchedule(slot, at), `suggested ${slot}`);
    }
  }
});

test('current-time lead, future latest starts, and same-day truncated windows retain website policy', () => {
  assert.equal(parseSchedule('2026-10-11 11:00', now), null);
  assert.equal(parseSchedule('2026-10-11 12:00', now), null);
  assert.equal(parseSchedule('2026-10-11 13:00', now).when_hour, 13);
  assert.equal(parseSchedule('2026-10-11 13:00', now + 60_000), null);
  assert.equal(parseSchedule('2026-10-12 17:00', now).when_hour, 17);
  for (const hour of [18, 19, 20]) assert.equal(parseSchedule(`2026-10-12 ${hour}:00`, now), null);
  assert.equal(parseSchedule('2026-10-16 10:00', now).when_hour, 10);
  assert.equal(parseSchedule('2026-10-16 11:00', now), null);
  assert.equal(parseSchedule('2026-10-16 12:00', now), null);
  assert.equal(parseSchedule('2026-10-11 19:00', now).when_hour, 19);
  assert.equal(parseSchedule('2026-10-16 12:00', Date.parse('2026-10-16T05:00:00Z')).when_hour, 12);
});

test('Israel local day boundary, closed days, invalid dates and booking horizon stay bounded', () => {
  const midnight = Date.parse('2026-10-08T21:30:00Z'); // Friday 00:30 Israel, still Thursday UTC.
  assert.equal(israelDay(midnight), '2026-10-09');
  assert.equal(parseSchedule('2026-10-08 19:00', midnight), null);
  assert.equal(parseSchedule('2026-10-09 12:00', midnight).when_hour, 12, 'Friday is today; truncated same-day window allowed');
  assert.equal(parseSchedule('2026-10-09 12:00', midnight - 3600000), null, 'Friday was future; full window required');
  for (const text of ['2026-10-10 10:00', '2026-02-31 10:00', '2026-12-01 10:00', '2026-10-11 13:30', '2026-10-11 13:00-16:00']) assert.equal(parseSchedule(text, now), null);
});

test('ambiguous daypart has no date or chosen time; clarification and explicit selection remain required', async () => {
  const state = (await advanceBooking(newBooking(), 'start', services(), { phone, now })).state;
  const result = await advanceBooking(state, 'בבוקר', services(), { phone, now });
  assert.deepEqual(pickupPreference('בבוקר', now), { date: null, period: 'morning' });
  assert.equal(result.state.menu.kind, 'schedule_day');
  assert.equal(result.state.data.when_date, undefined);
  const day = await advanceBooking(result.state, '2', services(), { phone, now });
  assert.equal(day.state.menu.kind, 'schedule');
  assert.equal(day.state.data.schedule, undefined);
  const selected = await advanceBooking(day.state, '1', services(), { phone, now });
  assert.equal(selected.state.data.when_date, '2026-10-12');
  assert.equal(selected.state.data.when_hour, 9);
  assert.equal(selected.create, undefined);
});

test('a still-priced summary that ages beyond lead time cannot confirm and must choose a fresh time', async () => {
  const state = await review();
  const svc = services(); svc.quote = () => assert.fail('reject stale schedule before quote');
  const result = await advanceBooking(state, '1', svc, { phone, now: now + 60_000 });
  assert.equal(result.create, undefined); assert.equal(result.state.phase, 'collect');
  assert.equal(result.state.quote, null); assert.equal(result.state.terms_accepted_at, undefined);
  for (const field of ['schedule', 'when_date', 'when_hour', 'when_text']) assert.equal(result.state.data[field], undefined);
  assert.ok(result.state.revision > state.revision);
  assert.equal(result.state.menu.slots[0], '2026-10-11 14:00');
  const selected = await advanceBooking(result.state, '1', services(), { phone, now: now + 60_000 });
  assert.equal(selected.create, undefined); assert.equal(selected.state.phase, 'review');
  const confirmed = await advanceBooking(selected.state, '1', services(), { phone, now: now + 60_000 });
  assert.equal(confirmed.create.input.when_hour, 14);
});

test('selecting a menu time after its lead expires cannot retain stale schedule fields', async () => {
  const state = await review();
  const offered = await advanceBooking(state, 'today', services(), { phone, now });
  assert.equal(offered.state.menu.slots[0], '2026-10-11 13:00');
  const result = await advanceBooking(offered.state, '1', services(), { phone, now: now + 60_000 });
  assert.equal(result.create, undefined); assert.equal(result.state.data.when_hour, undefined);
  assert.equal(result.state.data.schedule, undefined); assert.equal(result.state.quote, null);
  assert.equal(result.state.menu.slots[0], '2026-10-11 14:00');
});

test('model-grounded exact date corrections use the same lead and future-window validator', async () => {
  for (const schedule of ['2026-10-11 11:00', '2026-10-12 19:00']) {
    const state = await review(); let calls = 0;
    const svc = services();
    svc.conversationModel = createOfflineBookingModel(() => {
      calls++;
      return { version: 2, intent: 'update', fields: [{ field: 'schedule', quote: schedule }], topic: null, clarify_field: null };
    });
    const result = await advanceBooking(state, `actually pickup at ${schedule}`, svc, { phone, now });
    assert.equal(calls, 1); assert.equal(result.interpretation, 'model_proposal');
    assert.equal(result.state.phase, 'collect'); assert.equal(result.state.quote, null);
    assert.equal(result.state.data.schedule, undefined); assert.equal(result.state.data.when_hour, undefined);
    assert.equal(result.create, undefined);
  }
});
