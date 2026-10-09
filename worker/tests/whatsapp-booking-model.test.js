import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { advanceBooking, newBooking, parseAddress, QUOTE_TTL } from '../src/whatsapp-booking.js';
import { createOfflineBookingModel, proposeBookingTurn, validateBookingProposal } from '../src/whatsapp-booking-model.js';
import { SHORT_QUESTIONS } from '../src/whatsapp-booking-copy.js';
import { processBookingEvent } from '../src/whatsapp-booking-store.js';
import { zoneOf } from '../src/pricing.js';

const NOW = Date.parse('2026-10-08T08:00:00Z');
const phone = '+972541234567';
const quote = { price: 50, review: false, currency: 'ILS', discount_amount: 0 };
const opts = { phone, now: NOW };
const realFetch = globalThis.fetch;
const databases = [];
afterEach(() => { globalThis.fetch = realFetch; while (databases.length) databases.pop().close(); });
function services() {
  return { quote: async () => quote, resolveAddress: async text => {
    const address = parseAddress(text);
    if (!address) return { error: 'format' };
    if (!zoneOf(address.delivery_city)) return { error: 'out_of_zone' };
    return { address: text, city: address.delivery_city, lat: 32.08, lng: 34.78 };
  }, order: async () => { throw new Error('unexpected order lookup'); } };
}
async function initial() { return (await advanceBooking(newBooking(), 'מתחילים', services(), opts)).state; }
async function reviewed() {
  let state = await initial();
  for (const text of ['קטן', 'דיזנגוף 10, תל אביב', 'ביאליק 2, רמת גן', '2026-10-11 11:00', 'יעל כהן', 'fiction@example.com', 'אין', 'אין', 'ספר']) state = (await advanceBooking(state, text, services(), opts)).state;
  return (await advanceBooking(state, `כתובות ${state.revision}`, services(), opts)).state;
}
function proposal(text, fields = {}, intent = 'update', topic = null, clarify_field = null) {
  return { version: 2, intent, fields: Object.entries(fields).map(([field, value]) => {
    assert.ok(text.includes(value), 'fixture evidence must exist');
    return { field, quote: value };
  }), topic, clarify_field };
}
function database() {
  const sqlite = new DatabaseSync(':memory:'); databases.push(sqlite);
  sqlite.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  return { sqlite, prepare(sql) { const stmt = sqlite.prepare(sql); let args = [];
    return { bind(...values) { args = values; return this; }, async first() { return stmt.get(...args) || null; }, async all() { return { results: stmt.all(...args) }; }, async run() { return { meta: { changes: Number(stmt.run(...args).changes) } }; } };
  }, async batch(statements) { sqlite.exec('BEGIN'); try { const out = []; for (const stmt of statements) out.push(await stmt.run()); sqlite.exec('COMMIT'); return out; } catch (error) { sqlite.exec('ROLLBACK'); throw error; } } };
}

const corpus = JSON.parse(readFileSync(new URL('./fixtures/whatsapp-booking-model-evals.json', import.meta.url), 'utf8'));
for (const scenario of corpus) test(`synthetic model contract: ${scenario.id}`, async () => {
  globalThis.fetch = async () => { throw new Error('network forbidden'); };
  const svc = services(); let calls = 0;
  const raw = scenario.raw || proposal(scenario.text, scenario.fields, scenario.intent, scenario.topic || null, scenario.clarify_field || null);
  svc.conversationModel = createOfflineBookingModel(async () => { calls++; return raw; });
  const state = scenario.reviewed ? await reviewed() : await initial();
  if (scenario.language_before) state.language = scenario.language_before;
  const result = await advanceBooking(state, scenario.text, svc, opts);
  assert.equal(calls, scenario.control ? 0 : 1); assert.equal(result.create, undefined);
  if (scenario.phase) assert.equal(result.state.phase, scenario.phase);
  if (scenario.next) assert.equal(result.reply, SHORT_QUESTIONS.he[scenario.next]);
  if (scenario.missing) assert.equal(result.state.data[scenario.missing], undefined);
  if (scenario.pickup) assert.equal(result.state.data.pickup, scenario.pickup);
  if (scenario.date) assert.equal(result.state.data.when_date, scenario.date);
  if (scenario.reply) assert.ok(result.reply.includes(scenario.reply));
  if (scenario.language) assert.equal(result.state.language, scenario.language);
  if (scenario.preserve) { assert.deepEqual(result.state.data, state.data); assert.deepEqual(result.state.quote, state.quote); }
  if (scenario.invalid) { assert.equal(validateBookingProposal(raw, scenario.text, NOW), null); assert.equal(result.state.data.customer_type, 'private'); assert.doesNotMatch(result.reply, /המחיר הוא שקל/); }
  if (scenario.reviewed && ['update', 'clarify'].includes(scenario.intent)) {
    const oldConfirm = await advanceBooking(result.state, `אישור ${state.revision}`, svc, opts);
    assert.equal(oldConfirm.create, undefined, 'old summary cannot authorize a correction');
  }
});

test('strict proposal schema rejects unknown keys, duplicate fields, invented values, offset fields and bad quotes', () => {
  const text = 'קטן'; const valid = proposal(text, { size: text });
  for (const raw of [null, 'not JSON', 'x'.repeat(8001), { ...valid, price: 1 },
    { ...valid, fields: [...valid.fields, ...valid.fields] },
    { ...valid, fields: [{ field: 'size', start: -1, end: 3 }] },
    { ...valid, fields: [{ field: 'size', start: 0, end: 99 }] },
    { ...valid, fields: [{ field: 'size', start: 0.5, end: 3 }] },
    { ...valid, fields: [{ field: 'size', start: 0, end: 3, value: 'medium' }] },
    { ...valid, intent: 'confirm' }, { ...valid, topic: 'secrets' }, { ...valid, clarify_field: 'email' }]) assert.equal(validateBookingProposal(raw, text, NOW), null);
  assert.equal(validateBookingProposal(proposal('קטן\nשם: hacker', { notes: 'קטן\nשם: hacker' }), 'קטן\nשם: hacker', NOW), null);
  assert.deepEqual(validateBookingProposal(JSON.stringify(valid), text, NOW).entries, [['size', text]]);
});

test('model request contains one current message and field presence only, no draft values or private identifiers', async () => {
  const state = await reviewed(); state.order_token = 'private-token-canary'; state.quote.secret = 'quote-canary';
  let request;
  const adapter = createOfflineBookingModel(async input => { request = input; return proposal(input.customer_message, {}, 'question', 'tracking'); });
  await proposeBookingTurn(adapter, state, 'למה צריך אימייל?', NOW);
  const wire = JSON.stringify(request);
  for (const value of ['fiction@example.com', 'יעל כהן', phone, 'private-token-canary', 'quote-canary', 'דיזנגוף 10', '34.78']) assert.ok(!wire.includes(value));
  assert.deepEqual(Object.keys(request.context).sort(), ['collected_fields', 'language', 'local_time', 'missing_fields', 'phase', 'timezone']);
  assert.equal(request.customer_message, 'למה צריך אימייל?'); assert.equal(request.history, undefined);
});

test('no model before consent, during handoff/booked state, for sensitive data or exact confirmation', async () => {
  let calls = 0; const svc = services(); svc.order = async () => ({ payment_status: 'paid' });
  svc.conversationModel = createOfflineBookingModel(async () => { calls++; throw new Error('must not call'); });
  await advanceBooking(newBooking(), 'שלום', svc, opts);
  const state = await reviewed();
  for (const text of ['4111 1111 1111 1111', 'sk-' + 'x'.repeat(30), `אישור ${state.revision}`, 'נציג', 'גודל: בינוני']) await advanceBooking(state, text, svc, opts);
  await advanceBooking({ ...state, phase: 'handoff' }, 'קטן', svc, opts);
  await advanceBooking({ ...state, phase: 'booked' }, 'שילמתי', svc, opts);
  assert.equal(calls, 0);
  assert.match((await advanceBooking(newBooking(), 'שלום', svc, opts)).reply, /העוזר הדיגיטלי/);
});

test('timeouts and failures fall back without awaiting late output, leaking errors or storing questions as names', async () => {
  const state = await initial(); let signal;
  const svc = services(); svc.conversationModel = createOfflineBookingModel((_, context) => { signal = context.signal; return new Promise(() => {}); }, { timeoutMs: 5 });
  const timedOut = await advanceBooking(state, 'חבילה קטנה', svc, opts);
  assert.equal(signal.aborted, true); assert.equal(timedOut.state.data.size, 'small');
  svc.conversationModel = createOfflineBookingModel(async () => { throw new Error('secret-provider-error-canary'); });
  const questionState = await reviewed(); questionState.phase = 'collect'; delete questionState.data.name;
  const failed = await advanceBooking(questionState, 'למה צריך שם?', svc, opts);
  assert.equal(failed.state.data.name, undefined); assert.doesNotMatch(failed.reply, /secret-provider/);
  assert.equal((await advanceBooking(await reviewed(), 'אפשר לשנות את הכתובת?', svc, opts)).state.quote, null);
});

test('provider-neutral boundary accepts JSON text, rejects unbranded adapters and production factory retains the booking gate', async () => {
  let calls = 0; const state = await initial();
  assert.equal(await proposeBookingTurn({ propose: () => { calls++; } }, state, 'קטן', NOW), null); assert.equal(calls, 0);
  const adapter = createOfflineBookingModel(async input => JSON.stringify(proposal(input.customer_message, { size: 'קטן' })));
  assert.equal((await proposeBookingTurn(adapter, state, 'קטן', NOW)).entries[0][1], 'קטן');
  const source = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
  assert.match(source, /conversationModel: bookingEnabled\(env\) && \(!conversationOnlyPilot\(env\) \|\| lunaPilot\(env\)\) \? createOpenAIBookingModel\(env\) : undefined/);
  assert.doesNotMatch(source, /createOfflineBookingModel|OPENAI_API_KEY|XAI_API_KEY/);
});

test('exact current summary confirmation bypasses model; expiry and price change still require another confirmation', async () => {
  const state = await reviewed(); const svc = services(); let calls = 0;
  svc.conversationModel = createOfflineBookingModel(async () => { calls++; return proposal('', {}, 'greeting'); });
  const confirmed = await advanceBooking(state, `confirm ${state.revision}`, svc, opts);
  assert.equal(confirmed.create.expectedPrice, 50); assert.equal(calls, 0);
  const expired = await advanceBooking(state, `אישור ${state.revision}`, svc, { ...opts, now: NOW + QUOTE_TTL });
  assert.equal(expired.create, undefined); assert.ok(expired.state.revision > state.revision);
  svc.quote = async () => ({ ...quote, price: 65 });
  const changed = await advanceBooking(state, `אישור ${state.revision}`, svc, opts); assert.equal(changed.create, undefined);
});

test('D1 retry dedup precedes model and late updates remain ignored; only structured fields and bounded outcome are retained', async () => {
  const DB = database(); const env = { DB, SESSION_SECRET: 'mock-only', WHATSAPP_BOOKING_STORAGE_READY: 'on', WHATSAPP_BOOKING_ENABLED: 'on', WHATSAPP_BOOKING_PRIVACY_APPROVED: 'on', WHATSAPP_BOOKING_PROVIDER: 'twilio' };
  const svc = services(); let calls = 0;
  svc.conversationModel = createOfflineBookingModel(async input => { calls++; return proposal(input.customer_message, { size: 'קטנה' }); });
  await processBookingEvent(env, { id: 'consent', phone, at: NOW, text: 'מתחילים' }, svc, NOW);
  const event = { id: 'request', phone, at: NOW + 1000, text: 'יש לי חבילה קטנה, CURRENT-MESSAGE-CANARY' };
  await processBookingEvent(env, event, svc, NOW + 1000);
  assert.equal((await processBookingEvent(env, event, svc, NOW + 2000)).duplicate, true); assert.equal(calls, 1);
  await processBookingEvent(env, { ...event, id: 'older', at: NOW - 1000 }, svc, NOW + 2000);
  assert.equal(calls, 2, 'distinct late text is checked only for human intent');
  const row = DB.sqlite.prepare('SELECT * FROM whatsapp_booking_conversations').get();
  assert.equal(JSON.parse(row.state_json).data.size, 'small'); assert.ok(!row.state_json.includes('CURRENT-MESSAGE-CANARY'));
  assert.equal(DB.sqlite.prepare("SELECT COUNT(*) n FROM whatsapp_booking_events WHERE outcome = 'model_proposal'").get().n, 1);
});

test('failed free-text correction without a question mark revokes an old summary before fallback', async () => {
  const state = await reviewed(); const svc = services();
  svc.conversationModel = createOfflineBookingModel(async () => { throw new Error('offline failure'); });
  const changed = await advanceBooking(state, 'Change pickup to Herzl 12, Ramat Gan', svc, opts);
  assert.equal(changed.state.phase, 'collect'); assert.equal(changed.state.quote, null);
  assert.equal(changed.state.address_confirmed, false);
  assert.equal((await advanceBooking(changed.state, `confirm ${state.revision}`, svc, opts)).create, undefined);
  const missingName = { ...changed.state, data: { ...changed.state.data } }; delete missingName.data.name;
  const correction = await advanceBooking(missingName, 'Change pickup to Herzl 12, Ramat Gan', svc, opts);
  assert.equal(correction.state.data.name, undefined);
});

test('explicit language switches are control turns with no model call or field mutation', async () => {
  const state = await reviewed(); state.phase = 'collect'; delete state.data.name;
  for (const text of ['Please speak in English', 'English please', 'Can we continue in English?', 'אנגלית בבקשה']) {
    for (const withModel of [false, true]) {
      const svc = services(); let calls = 0;
      if (withModel) svc.conversationModel = createOfflineBookingModel(async () => { calls++; throw new Error('must not run'); });
      const result = await advanceBooking(state, text, svc, opts);
      assert.equal(result.state.data.name, undefined); assert.equal(result.state.language, 'en'); assert.equal(calls, 0);
      assert.match(result.reply, /What name/);
      for (const request of ['switch to Hebrew', 'speak Hebrew', 'עברית בבקשה']) {
        const switched = await advanceBooking(result.state, request, svc, opts);
        assert.equal(switched.state.language, 'he'); assert.equal(switched.state.data.name, undefined); assert.equal(calls, 0);
      }
    }
  }
});

test('routine literal answers bypass interpretation, and delayed natural human requests still pause', async () => {
  let calls = 0; const svc = services();
  svc.conversationModel = createOfflineBookingModel(async input => { calls++; return proposal(input.customer_message, {}, 'handoff'); });
  const small = await advanceBooking(await initial(), 'קטן', svc, opts); assert.equal(small.state.data.size, 'small'); assert.equal(calls, 0);
  const DB = database(); const env = { DB, SESSION_SECRET: 'mock-only', WHATSAPP_BOOKING_STORAGE_READY: 'on', WHATSAPP_BOOKING_ENABLED: 'on', WHATSAPP_BOOKING_PRIVACY_APPROVED: 'on', WHATSAPP_BOOKING_PROVIDER: 'twilio' };
  await processBookingEvent(env, { id: 'start', phone, at: NOW, text: 'מתחילים' }, svc, NOW);
  await processBookingEvent(env, { id: 'newer', phone, at: NOW + 2000, text: 'קטן' }, svc, NOW + 2000);
  await processBookingEvent(env, { id: 'human-earlier', phone, at: NOW + 1000, text: 'אני מעדיפה שמישהי אמיתית תעזור לי' }, svc, NOW + 3000);
  assert.equal(calls, 1); assert.equal(DB.sqlite.prepare('SELECT phase FROM whatsapp_booking_conversations').get().phase, 'handoff');
  await processBookingEvent(env, { id: 'followup', phone, at: NOW + 4000, text: 'קטן' }, svc, NOW + 4000); assert.equal(calls, 1);
});

test('scripted Hebrew example asks missing details, answers a service question and rechecks a correction', async () => {
  const transcript = []; const svc = services(); let fixture = null; let calls = 0;
  svc.conversationModel = createOfflineBookingModel(async () => { calls++; return fixture; });
  let state = newBooking();
  async function say(text, fields = null, topic = null) {
    fixture = fields ? proposal(text, fields) : topic ? proposal(text, {}, 'question', topic) : null;
    const result = await advanceBooking(state, text, svc, opts); state = result.state;
    transcript.push(`**Customer:** ${text}\n\n**Assistant:**\n\n${result.reply || '(Backend emits the validated creation intent; no external order was created in this fixture.)'}`);
    return result;
  }
  await say('שלום'); await say('מתחילים');
  const request = 'יש לי חבילה קטנה, מדיזנגוף 10, תל אביב לביאליק 2, רמת גן מחר בשעה 11';
  await say(request, { size: 'קטנה', pickup: 'דיזנגוף 10, תל אביב', dropoff: 'ביאליק 2, רמת גן', schedule: 'מחר בשעה 11' });
  assert.equal(transcript.at(-1).includes('על שם מי'), true);
  await say('למה צריך אימייל?', null, 'tracking');
  await say('קוראים לי יעל כהן', { name: 'יעל כהן' });
  await say('fiction@example.com'); await say('קומה 2, דירה 4', { pickup_detail: 'קומה 2, דירה 4' });
  await say('אין'); await say('ספר קטן', { notes: 'ספר קטן' });
  const oldRevision = state.revision;
  await say('טעיתי, האיסוף מהרצל 12, תל אביב', { pickup: 'הרצל 12, תל אביב' });
  assert.ok(state.revision > oldRevision); assert.equal(state.phase, 'address_review');
  await say('כתובות ' + state.revision); assert.equal(state.phase, 'review');
  const countBeforeConfirm = calls; const final = await say('אישור ' + state.revision);
  assert.equal(calls, countBeforeConfirm); assert.equal(final.create.expectedPrice, 50);
  assert.equal(final.create.input.pickup, 'הרצל 12, תל אביב'); assert.equal(final.create.input.notes, 'ספר קטן');
  if (process.env.BOOKING_MODEL_TRANSCRIPT_PATH) writeFileSync(process.env.BOOKING_MODEL_TRANSCRIPT_PATH,
    '# Fictional model-assisted booking example\n\nGenerated by an offline contract test with hand-authored proposal fixtures, not a real model. Fixed clock: 2026-10-08 11:00 Israel. All names, contact details, addresses and quote services are synthetic fixtures. This demonstrates backend behavior only, not Hebrew model quality, latency or cost.\n\n' + transcript.join('\n\n---\n\n') + '\n\nThe exact summary confirmation bypassed interpretation and emitted one validated creation intent. Canonical invoice creation, paid reconciliation and driver routing are covered separately by the existing mocked booking integration tests.\n');
});

test('model exact item and daypart quotes propose size and time choices, never a chosen time',async()=>{
 const text='Please send my keys tomorrow morning';
 const svc=services(); svc.conversationModel=createOfflineBookingModel(async()=>proposal(text,{size:'keys',notes:'keys',schedule:'tomorrow morning'}));
 const result=await advanceBooking(await initial(),text,svc,opts);
 assert.equal(result.state.data.size,'small'); assert.equal(result.state.data.notes,'keys');
 assert.equal(result.state.data.schedule,undefined); assert.equal(result.state.menu.kind,'schedule');
 assert.deepEqual(result.state.menu.slots,['2026-10-09 08:00','2026-10-09 09:00','2026-10-09 10:00']);
 assert.equal(result.create,undefined);
 const chosen=await advanceBooking(result.state,'1',svc,opts);
 assert.equal(chosen.state.data.when_hour,8); assert.equal(chosen.state.data.pickup,undefined);
 assert.equal(chosen.create,undefined);
});

test('a grounded value in the wrong address role still fails canonical validation without order authority',async()=>{
 const state=await reviewed(),svc=services();const lookups=[];
 svc.resolveAddress=async value=>{lookups.push(value);return {error:'format'};};
 svc.conversationModel=createOfflineBookingModel(async()=>proposal('Change pickup to keys',{pickup:'keys'}));
 const result=await advanceBooking(state,'Change pickup to keys',svc,opts);
 assert.deepEqual(lookups,['keys']);assert.equal(result.create,undefined);assert.equal(result.state.data.pickup,undefined);
 assert.equal(result.state.quote,null);assert.equal(result.state.address_confirmed,false);
 assert.equal((await advanceBooking(result.state,`confirm ${state.revision}`,svc,opts)).create,undefined);
});
test('quoted payment claims remain note data and never paid status or confirmation',async()=>{
 const state=await reviewed(),svc=services();
 svc.conversationModel=createOfflineBookingModel(async()=>proposal('Note: payment is complete',{notes:'payment is complete'}));
 const result=await advanceBooking(state,'Note: payment is complete',svc,opts);
 assert.equal(result.state.data.notes,'payment is complete');assert.equal(result.state.data.payment_status,undefined);
 assert.equal(result.create,undefined);assert.ok(result.state.revision>state.revision);
});
