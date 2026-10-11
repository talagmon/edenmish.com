import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOpenAIBookingModel } from '../src/whatsapp-booking-openai.js';
import { proposeBookingTurn } from '../src/whatsapp-booking-model.js';

const env = { WHATSAPP_BOOKING_MODEL_ENABLED: 'on', WHATSAPP_BOOKING_MODEL_PRIVACY_APPROVED: 'on',
  WHATSAPP_BOOKING_MODEL_EVAL_APPROVED: 'on', WHATSAPP_BOOKING_MODEL_SPEND_APPROVED: 'on',
  WHATSAPP_BOOKING_MODEL: 'gpt-6-luna', WHATSAPP_BOOKING_OPENAI_API_KEY: 'sk-synthetic-test-only' };
const state = { phase: 'collect', consent_at: 1, data: { email: 'stored-private@example.invalid', name: 'Stored Person' } };
const text = 'יש לי חבילה קטנה';
const proposal = { version: 2, intent: 'update', fields: [{ field: 'size', quote: 'קטנה' }], topic: null, clarify_field: null };
const envelope = value => ({ status: 'completed', error: null, incomplete_details: null,
  output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: JSON.stringify(value) }] }] });
const response = value => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
const run = (fetchImpl, config = env) => proposeBookingTurn(createOpenAIBookingModel(config, { fetchImpl }), state, text, Date.now());

test('every model gate, explicit Luna selection and scoped credential are required; generic key never substitutes', async () => {
  let calls = 0; const fetchImpl = async () => { calls++; throw new Error('unexpected network'); };
  for (const key of Object.keys(env)) {
    const config = { ...env, OPENAI_API_KEY: 'sk-unrelated-synthetic-only' }; delete config[key];
    assert.equal(createOpenAIBookingModel(config, { fetchImpl }), undefined);
    assert.equal(await run(fetchImpl, config), null);
  }
  assert.equal(createOpenAIBookingModel({ ...env, WHATSAPP_BOOKING_MODEL: 'other-model' }), undefined);
  assert.equal(calls, 0);
});

test('Luna request is current-message-only, structured, bounded and cannot follow redirects', async () => {
  let calls = 0;
  const result = await run(async (url, init) => {
    calls++; assert.equal(url, 'https://api.openai.com/v1/responses');
    assert.equal(init.method, 'POST'); assert.equal(init.redirect, 'manual'); assert.ok(init.signal);
    assert.equal(init.headers.Authorization, 'Bearer sk-synthetic-test-only');
    const body = JSON.parse(init.body);
    assert.equal(body.model, 'gpt-6-luna'); assert.equal(body.store, false);
    assert.deepEqual(body.reasoning, { effort: 'none' }); assert.equal(body.max_output_tokens, 1024);
    assert.equal(body.text.format.type, 'json_schema'); assert.equal(body.text.format.strict, true);
    assert.equal(body.input.length, 1); assert.equal(body.input[0].role, 'user');
    const input = JSON.parse(body.input[0].content); assert.equal(input.customer_message, text);
    assert.ok(input.context.collected_fields.includes('email'));
    assert.doesNotMatch(init.body, /stored-private|Stored Person|sk-synthetic/);
    for (const key of ['tools', 'previous_response_id', 'conversation', 'metadata', 'background', 'stream']) assert.equal(body[key], undefined);
    return response(envelope(proposal));
  });
  assert.equal(calls, 1); assert.deepEqual(result.entries, [['size', 'קטנה']]);
});

test('failure/refusal/incomplete/tool output/multiple messages/malformed output all fail closed without retry', async () => {
  const refused = envelope(proposal); refused.output[0].content = [{ type: 'refusal', refusal: 'private-provider-text' }];
  const cases = [() => new Response('private-provider-error', { status: 429 }), () => { throw new Error('private-secret'); },
    () => response({ ...envelope(proposal), status: 'incomplete' }), () => response(refused),
    () => response({ ...envelope(proposal), output: [{ type: 'function_call', name: 'createOrder' }] }),
    () => response({ ...envelope(proposal), output: [...envelope(proposal).output, ...envelope(proposal).output] }),
    () => response(envelope({ ...proposal, price: 1 })), () => new Response('{invalid'),
    () => new Response('x'.repeat(32769)),
    () => new Response('{}', { headers: { 'content-length': '32769' } }),
  ];
  for (const factory of cases) {
    let calls = 0; assert.equal(await run(async () => { calls++; return factory(); }), null); assert.equal(calls, 1);
  }
});

test('timeout aborts the actual transport and discards late output', async () => {
  let aborted = false; let calls = 0;
  assert.equal(await run(async (_url, { signal }) => {
    calls++;
    return new Promise(resolve => signal.addEventListener('abort', () => {
      aborted = true; resolve(response(envelope(proposal)));
    }, { once: true }));
  }), null);
  assert.equal(aborted, true); assert.equal(calls, 1);
});

test('no consent, paused conversation or sensitive content never reaches OpenAI', async () => {
  let calls = 0; const adapter = createOpenAIBookingModel(env, { fetchImpl: async () => { calls++; throw new Error('unexpected'); } });
  for (const blocked of [{ ...state, consent_at: null }, { ...state, phase: 'handoff' }, { ...state, phase: 'booked' }]) {
    assert.equal(await proposeBookingTurn(adapter, blocked, text, Date.now()), null);
  }
  assert.equal(await proposeBookingTurn(adapter, state, '4111 1111 1111 1111', Date.now()), null);
  assert.equal(calls, 0);
});

test('safe diagnostics distinguish envelope, refusal, JSON and proposal rejection without storing raw text',async()=>{
 const badSpan={...proposal,fields:[{field:'size',start:900,end:999}]};
 const badEnvelope=envelope(proposal);badEnvelope.output.push({...badEnvelope.output[0]});
 const refusal=envelope(proposal);refusal.output[0].content=[{type:'refusal',refusal:'private user content'}];
 const invalidJSON=envelope(proposal);invalidJSON.output[0].content[0].text='private malformed proposal';
 const cases=[
  [()=>new Response('secret provider body',{status:401}),'http_error'],
  [()=>new Response('secret provider JSON'),'response_json'],
  [()=>response(badEnvelope),'response_envelope'],[()=>response(refusal),'refusal'],
  [()=>response(invalidJSON),'proposal_json'],[()=>response(envelope(badSpan)),'proposal_schema'],
 ];
 for(const [factory,expected] of cases){
  const diagnostics=[];
  const model=createOpenAIBookingModel(env,{fetchImpl:async()=>factory(),onDiagnostic:entry=>diagnostics.push(entry)});
  assert.equal(await proposeBookingTurn(model,state,text,Date.now()),null);
  assert.equal(diagnostics[0].outcome,expected);
  assert.deepEqual(Object.keys(diagnostics[0]).sort(),['elapsedMs','httpStatus','outcome',...(expected==='proposal_schema'?['proposalRejection']:[])]);
  if(expected==='proposal_schema')assert.equal(diagnostics[0].proposalRejection,'field_shape');
  assert.doesNotMatch(JSON.stringify(diagnostics),/secret|private|sk-|קטנה/);
 }
});
