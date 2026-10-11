import {test} from 'node:test';
import assert from 'node:assert/strict';
import {REASONING_CASES as cases, REASONING_LIMITS as limits, EVAL_CLOCK as now,
  handwrittenProposal,reasoningPlan,reasoningRequest,reasoningUsage,gradeReasoningResponse,runReasoningMock,reasoningMain} from '../scripts/evaluate-booking-reasoning.mjs';
import {validateBookingProposal,createOfflineBookingModel} from '../src/whatsapp-booking-model.js';
import {newBooking,advanceBooking} from '../src/whatsapp-booking.js';
const raw=(field,quote)=>({version:2,intent:'update',topic:null,clarify_field:null,fields:[{field,quote}]});
const envelope=(item,overrides={})=>({model:limits.model,service_tier:'default',status:'completed',
  usage:{input_tokens:1000,output_tokens:300,total_tokens:1300,input_tokens_details:{cached_tokens:512},output_tokens_details:{reasoning_tokens:200}},
  output:[{type:'reasoning',summary:[]},{type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:JSON.stringify(handwrittenProposal(item))}]}],...overrides});
const responses=()=>limits.efforts.flatMap(()=>cases.map(c=>envelope(c)));
const opts={now,phone:'+972541234567'};
const svc=()=>({quote:async()=>({price:50,currency:'ILS',review:false}),resolveAddress:async value=>({address:value,city:value.includes('רמת גן')?'רמת גן':'תל אביב',lat:32.08,lng:34.78}),create:async()=>assert.fail('No external order allowed')});

// Layer 1: handwritten expected values, independent of validator output.
test('contract: raw source quotes remain separate from deterministic normalized values',()=>{
  for(const [text,proposal,expected] of [
    ['מחר בשעה 11',raw('schedule','מחר בשעה 11'),[['schedule','2026-10-09 11:00']]],
    ['🔑 ״מפתחות״',raw('size','מפתחות'),[['size','small'],['notes','מפתחות']]],
    ['בבוקר',raw('schedule','בבוקר'),[['schedule','בבוקר']]],
    ['מחר בבוקר',raw('schedule','מחר בבוקר'),[['schedule','מחר בבוקר']]],
    ...cases.map(c=>[c.text,handwrittenProposal(c),c.expected]),
  ]) {const before=JSON.stringify(proposal);const actual=validateBookingProposal(proposal,text,now);assert.deepEqual(actual?.entries,expected);assert.equal(JSON.stringify(proposal),before);}
});
test('contract: invalid handwritten proposals fail with specific evidence reasons',()=>{
  for(const [text,proposal,reason] of [
    ['מחר בשעה 11',raw('schedule','2026-10-09 11:00'),'quote_missing'],
    ['מפתחות מפתחות',raw('size','מפתחות'),'quote_ambiguous'],
    ['לא מפתחות',raw('size','מפתחות'),'quote_negated'],
    ['מפתחות',raw('size','פתחות'),'quote_boundary'],
    ['מפתחות',{...raw('size','מפתחות'),price:1},'envelope_shape'],
  ]) {let actual;assert.equal(validateBookingProposal(proposal,text,now,r=>actual=r),null);assert.equal(actual,reason);}
});
test('word-hour evidence is retained and normalizes to a date/hour preference independently',async()=>{
  const {pickupPreference}=await import('../src/whatsapp-booking-slots.js');
  const text='מחר בארבע אחר הצהריים';const p=raw('schedule',text);
  assert.deepEqual(validateBookingProposal(p,text,now).entries,[['schedule',text]]);
  assert.deepEqual(pickupPreference(text,now),{date:'2026-10-09',period:'afternoon',hour:16});
  assert.equal(p.fields[0].quote,text);
});
test('swapped source route is rejected with a fixed semantic reason before address resolution',()=>{
  const c=cases[0],proposal=handwrittenProposal(c);
  const p=proposal.fields.find(f=>f.field==='pickup'),d=proposal.fields.find(f=>f.field==='dropoff');
  [p.quote,d.quote]=[d.quote,p.quote];let reason;
  assert.equal(validateBookingProposal(proposal,c.text,now,r=>reason=r),null);assert.equal(reason,'route_role');
  const result=envelope(c);result.output[1].content[0].text=JSON.stringify(proposal);
  const grade=gradeReasoningResponse(c,result,1000);assert.equal(grade.outcome,'proposal_rejected');assert.equal(grade.rejection,'route_role');
});

// Layer 2: mock Responses envelopes, no credentials/network/LLM grading.
test('plan pins low/medium, identical synthetic payloads, all calls and both original pools',()=>{
  const plan=reasoningPlan();assert.equal(plan.requests.length,4);assert.equal(plan.generationCalls,4);assert.equal(plan.countingCalls,0);
  assert.equal(plan.proposedReserveMicros,315392);assert.equal(plan.modelShortfallMicros,175392);
  assert.ok(plan.proposedReserveMicros<plan.originalRemainingMicros);assert.equal(plan.liveReady,false);
  for(const c of cases){const low=reasoningRequest(c,'low'),medium=reasoningRequest(c,'medium');assert.deepEqual({...low,reasoning:null},{...medium,reasoning:null});assert.equal(low.store,false);assert.equal(low.text.format.strict,true);assert.equal(low.max_output_tokens,3072);}
  assert.throws(()=>reasoningRequest(cases[0],'none'));assert.throws(()=>reasoningRequest({...cases[0]},'low'));
  assert.throws(()=>reasoningMain(['--execute']));
});
test('usage keeps input/cache/output/reasoning separately and prices reasoning once conservatively',()=>{
  const u=envelope(cases[0]).usage;assert.deepEqual(reasoningUsage(u),{inputTokens:1000,cachedTokens:512,outputTokens:300,reasoningTokens:200,upperCostMicros:6050});
  for(const malformed of [{...u,total_tokens:1},{...u,output_tokens_details:{}},{...u,output_tokens_details:{reasoning_tokens:301}},{...u,input_tokens:16385},{...u,input_tokens_details:{cached_tokens:1001}}])assert.equal(reasoningUsage(malformed),null);
});
test('mock batch grades supplied fields independently; contains no raw/secret/reasoning content',async()=>{
  const report=await runReasoningMock({responses:responses()});assert.equal(report.results.length,4);assert.equal(report.stopped,false);assert.equal(report.networkCalls,0);assert.equal(report.qualityApproved,false);
  assert.ok(report.metrics.every(m=>m.suppliedFields===7&&m.extractionScenarioSuccess));
  assert.doesNotMatch(JSON.stringify(report),/מפתחות|הרצל|summary|sk-|customer_message/);
});
test('incomplete output, unknown usage, oversized input/output and rejection stop without retry or partial interpretation',async()=>{
  const variants=[
    envelope(cases[0],{status:'incomplete',incomplete_details:{reason:'max_output_tokens'}}),
    envelope(cases[0],{usage:null}),envelope(cases[0],{model:'other'}),envelope(cases[0],{service_tier:'priority'}),
    envelope(cases[0],{output:[{type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:JSON.stringify(raw('size','invented'))}]}]}),
    envelope(cases[0],{oversize:'x'.repeat(32769)}),
  ];
  for(const first of variants){const r=responses();r[0]=first;const report=await runReasoningMock({responses:r});assert.equal(report.stopped,true);assert.equal(report.results.length,1);}
  const report=await runReasoningMock({responses:responses(),counts:[16385]});assert.equal(report.results[0].outcome,'input_limit');
});

// Layer 3: actual conversation core, handwritten proposals and authoritative mocks.
test('natural Hebrew route, morning, correction and withdrawal preserve state and ask for missing details',async()=>{
  let calls=0;const services=svc();services.conversationModel=createOfflineBookingModel(async input=>{
    calls++;const c=cases.find(c=>c.text===input.customer_message);assert.ok(c,'No unexpected model call');return handwrittenProposal(c);
  });
  services.resolveAddress=async value=>({error:'ambiguous',candidates:[{address:value.startsWith('בני')?'בני משה 16 תל אביב':value.startsWith('קרי')?'קריניצי 111 רמת גן':'הרצל 12 תל אביב',city:value.startsWith('קרי')?'רמת גן':'תל אביב',lat:32.08,lng:34.78}]});
  let state=(await advanceBooking(newBooking(),cases[0].text,services,opts)).state;
  assert.equal(calls,0);assert.equal(state.data.pickup,undefined);assert.equal(state.data.size,undefined);
  state=(await advanceBooking(state,'1',services,opts)).state;assert.equal(state.data.pickup,undefined);
  state=(await advanceBooking(state,cases[0].text,services,opts)).state;assert.equal(calls,1);assert.equal(state.data.size,'small');assert.equal(state.data.pickup,undefined);
  state=(await advanceBooking(state,'הראשונה',services,opts)).state;
  state=(await advanceBooking(state,'הראשונה',services,opts)).state;
  assert.equal(state.menu.kind,'schedule');assert.deepEqual(state.menu.slots,['2026-10-09 08:00','2026-10-09 09:00','2026-10-09 10:00']);
  let result=await advanceBooking(state,'השנייה',services,opts);state=result.state;assert.match(result.reply,/שם/);assert.equal(state.data.when_hour,9);
  const destination=state.data.dropoff;
  result=await advanceBooking(state,cases[1].text,services,opts);state=result.state;assert.equal(calls,2);assert.equal(state.quote,null);assert.equal(result.create,undefined);
  state=(await advanceBooking(state,'1',services,opts)).state;assert.equal(state.data.pickup,'הרצל 12 תל אביב');assert.equal(state.data.dropoff,destination);assert.equal(state.data.when_hour,9);assert.equal(state.data.notes,'מפתחות');
  state=(await advanceBooking(state,'עצור',services,opts)).state;assert.equal(state.phase,'handoff');
  assert.equal((await advanceBooking(state,'1',services,opts)).reply,null);assert.equal(calls,2);
});

test('conflicting date/day and ambiguous routes have valid handwritten clarification contracts',()=>{
  for(const [text,field] of [['מחר ביום ראשון','schedule'],['מחר ב-9 או 11','schedule'],['מאבן גבירול או מביאליק','pickup']]){
    const p={version:2,intent:'clarify',fields:[],topic:null,clarify_field:field};
    assert.deepEqual(validateBookingProposal(p,text,now),{intent:'clarify',entries:[],topic:null,clarifyField:field});
  }
});
test('whole flow refreshes summary after correction; only current confirmation gives one create instruction',async()=>{
  const services=svc();let state=newBooking();
  for(const text of ['היי','1','1','דיזנגוף 10 תל אביב','ביאליק 2 רמת גן','2026-10-11 11:00','Test Person','pilot@example.com','none','none','book','1'])state=(await advanceBooking(state,text,services,opts)).state;
  assert.equal(state.phase,'review');const oldRevision=state.revision;
  let result=await advanceBooking(state,'modify',services,opts);state=result.state;assert.equal(state.quote,null);
  state=(await advanceBooking(state,'5',services,opts)).state;
  result=await advanceBooking(state,'Changed Name',services,opts);state=result.state;assert.equal(result.create,undefined);
  result=await advanceBooking(state,'1',services,opts);state=result.state;assert.equal(state.phase,'review');assert.match(result.reply,/Changed Name/);assert.match(result.reply,/50/);assert.ok(state.revision>oldRevision);
  const stale=structuredClone(state);stale.revision++;assert.equal((await advanceBooking(stale,'1',services,opts)).create,undefined);
  result=await advanceBooking(state,'אני מאשר',services,opts);assert.equal(result.create.expectedPrice,50);assert.equal(result.state.phase,'creating');
  assert.equal((await advanceBooking(result.state,'אני מאשר',services,opts)).create,undefined);
});
test('unavailable day suggestions and stale numbered lists never claim/select requested unavailable time',async()=>{
  const services=svc();let state=(await advanceBooking(newBooking(),'start',services,opts)).state;
  let result=await advanceBooking(state,'2026-10-10 בבוקר',services,opts);state=result.state;
  assert.equal(state.data.when_date,undefined);assert.ok(state.menu.slots.every(slot=>slot.startsWith('2026-10-11')));
  assert.equal(result.create,undefined);state.revision++;
  assert.equal((await advanceBooking(state,'2',services,opts)).state.data.when_hour,undefined);
});

test('Hebrew word-hour grammar rejects ambiguous/conflicting times and preserves missing date',async()=>{
  const {pickupPreference,pickupSlotChoices}=await import('../src/whatsapp-booking-slots.js');
  for(const text of ['ארבע','מחר בארבע','מחר ביום ראשון בארבע אחר הצהריים','מחר בארבע או חמש אחר הצהריים','מחר בשתיים בערב','מחר בשתיים בצהריים','מחר בשתיים עשרה בבוקר','ארבע בלילה'])assert.equal(pickupPreference(text,now),null,text);
  assert.deepEqual(pickupPreference('ארבע אחר הצהריים',now),{date:null,period:'afternoon',hour:16});
  assert.deepEqual(pickupPreference('ארבע אחר הצהריים',now,'2026-10-11'),{date:'2026-10-11',period:'afternoon',hour:16});
  let state=(await advanceBooking(newBooking(),'start',svc(),opts)).state;
  state=(await advanceBooking(state,'ארבע אחר הצהריים',svc(),opts)).state;assert.equal(state.menu.kind,'schedule_day');assert.equal(state.data.when_date,undefined);
  state=(await advanceBooking(state,'2',svc(),opts)).state;assert.equal(state.schedule_preference.hour,16);assert.equal(state.menu.kind,'schedule');
  assert.deepEqual(state.menu.slots,['2026-10-11 16:00']);assert.equal(state.data.when_hour,undefined);
  state=(await advanceBooking(state,'1',svc(),opts)).state;assert.equal(state.data.when_hour,16);assert.equal(state.data.when_date,'2026-10-11');
  assert.deepEqual(pickupSlotChoices({date:null,period:'afternoon',hour:16},now).slots,[]);
});
test('route gates distinguish explicit correction, negation, alternatives and unlabelled pairs',()=>{
  for(const [text,proposal,reason] of [
    ['לא מדיזנגוף 10 תל אביב אלא מהרצל 12 תל אביב',raw('pickup','דיזנגוף 10 תל אביב'),'quote_negated'],
    ['מדיזנגוף 10 תל אביב או מהרצל 12 תל אביב',raw('pickup','דיזנגוף 10 תל אביב'),'route_ambiguous'],
    ['from Dizengoff 10 Tel Aviv to Bialik 2 Ramat Gan',raw('dropoff','Dizengoff 10 Tel Aviv'),'route_role'],
    ['pickup: Dizengoff 10 Tel Aviv',raw('dropoff','Dizengoff 10 Tel Aviv'),'route_role'],
    ['דיזנגוף 10 תל אביב וביאליק 2 רמת גן',{...raw('pickup','דיזנגוף 10 תל אביב'),fields:[{field:'pickup',quote:'דיזנגוף 10 תל אביב'},{field:'dropoff',quote:'וביאליק 2 רמת גן'}]},'route_unmarked'],
  ]){let actual;assert.equal(validateBookingProposal(proposal,text,now,r=>actual=r),null);assert.equal(actual,reason,text);}
  for(const [text,field,quote] of [
    ['לא מדיזנגוף 10 תל אביב אלא מהרצל 12 תל אביב','pickup','הרצל 12 תל אביב'],
    ['Change pickup to Herzl 12 Tel Aviv','pickup','Herzl 12 Tel Aviv'],
    ['מסירה: הרצל 12 תל אביב','dropoff','הרצל 12 תל אביב'],
  ])assert.deepEqual(validateBookingProposal(raw(field,quote),text,now)?.entries,[[field,quote]],text);
});
