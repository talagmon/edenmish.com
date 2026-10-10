import { test } from 'node:test';
import assert from 'node:assert/strict';
import { advanceBooking, newBooking, parseAddress, parseSchedule, QUOTE_TTL } from '../src/whatsapp-booking.js';
import { pickupPreference, pickupSlotChoices } from '../src/whatsapp-booking-slots.js';
const now=Date.parse('2026-10-08T08:00:00Z');
const opts={now,phone:'+972541234567'};
const services=()=>({quote:async()=>({price:50,currency:'ILS',review:false}),resolveAddress:async value=>({address:value,city:'תל אביב',lat:32.08,lng:34.78}),order:async()=>null,create:async()=>assert.fail('No order call belongs in interpretation')});
async function review(svc=services(), extra={}) {
 let state=newBooking();
 for(const text of ['hello','1','1','דיזנגוף 10 תל אביב','ביאליק 2 רמת גן','2026-10-11 11:00','Test Person','pilot@example.com','none','none','book']) state=(await advanceBooking(state,text,svc,{...opts,...extra})).state;
 assert.equal(state.phase,'address_review');
 const result=await advanceBooking(state,'1',svc,{...opts,...extra}); assert.equal(result.state.phase,'review'); return result.state;
}
test('numbered consent must first be shown; size, address review and final confirmation use numbers',async()=>{
 const first=await advanceBooking(newBooking(),'1',services(),opts); assert.equal(first.state.phase,'consent'); assert.match(first.reply,/1\./);
 const state=await review(); const result=await advanceBooking(state,'1',services(),opts);
 assert.equal(result.create.expectedPrice,50); assert.equal(result.create.input.use_wallet,undefined); assert.equal(result.create.input.customer_type,'private');
});
test('numeric final confirmation rechecks price and expired quotes; stale menu cannot confirm',async()=>{
 for(const extra of [{now:now+QUOTE_TTL+1},{}]) {
  const state=await review(); const svc=services(); if(!extra.now) svc.quote=async()=>({price:65,currency:'ILS',review:false});
  const result=await advanceBooking(state,'1',svc,{...opts,...extra}); assert.equal(result.create,undefined); assert.equal(result.state.phase,'review'); assert.ok(result.state.revision>state.revision);
 }
 const state=await review(); state.revision++;
 assert.equal((await advanceBooking(state,'1',services(),opts)).create,undefined);
});
test('numbered modification selects a field and requires address and summary confirmation again',async()=>{
 let state=await review(); state=(await advanceBooking(state,'2',services(),opts)).state; assert.equal(state.menu.kind,'edit'); assert.equal(state.quote,null);
 state=(await advanceBooking(state,'5',services(),opts)).state; assert.equal(state.editing_field,'name');
 state=(await advanceBooking(state,'Changed Name',services(),opts)).state; assert.equal(state.data.name,'Changed Name'); assert.equal(state.phase,'address_review'); assert.equal(state.editing_field,undefined);
});
test('numeric human choice pauses; pilot numeric confirm cannot create order or accept terms',async()=>{
 const state=await review(); const paused=await advanceBooking(state,'3',services(),opts); assert.equal(paused.state.phase,'handoff'); assert.equal(paused.create,undefined);
 assert.equal((await advanceBooking(paused.state,'1',services(),opts)).reply,null);
 const pilot=await review(services(),{conversationOnly:true}); const result=await advanceBooking(pilot,'1',services(),{...opts,conversationOnly:true});
 assert.equal(result.state.phase,'handoff'); assert.equal(result.create,undefined); assert.equal(result.state.terms_accepted_at,undefined);
});
test('dayparts offer valid concrete choices without selecting a schedule',async()=>{
 let state=await review(); const proposed=await advanceBooking(state,'tomorrow morning',services(),opts);
 assert.equal(proposed.state.data.schedule,undefined); assert.equal(proposed.state.quote,null); assert.equal(proposed.state.menu.kind,'schedule');
 assert.deepEqual(proposed.state.menu.slots,['2026-10-09 08:00','2026-10-09 09:00','2026-10-09 10:00']);
 const selected=await advanceBooking(proposed.state,'2',services(),opts); assert.equal(selected.state.data.when_date,'2026-10-09'); assert.equal(selected.state.data.when_hour,9);
 assert.equal(selected.create,undefined);
});
test('today respects Israel time and website lead time; closed days suggest another date explicitly',()=>{
 const p=pickupPreference('today',now); const slots=pickupSlotChoices(p,now); assert.equal(slots.slots[0],'2026-10-08 14:00');
 const midnight=Date.parse('2026-10-08T22:30:00Z'); assert.equal(pickupPreference('tommorrow morning',midnight).date,'2026-10-10');
 const closed=pickupSlotChoices(pickupPreference('tomorrow morning',midnight),midnight); assert.equal(closed.alternateDay,true); assert.equal(closed.slots[0],'2026-10-11 09:00');
 assert.equal(pickupPreference('2026-02-31',now),null);
});
test('dates accept local explicit format; no comma is required; ambiguous or partial dates still fail',()=>{
 assert.equal(parseSchedule('11/10/2026 at 11:00',now).when_date,'2026-10-11');
 assert.equal(parseSchedule('11.10.2026 בשעה 11',now).when_hour,11);
 for(const value of ['11/10 11','31/02/2026 11','11/10/2026 11:30','11/10/2026 11 or 12']) assert.equal(parseSchedule(value,now),null);
 const a=parseAddress('דיזנגוף 10 תל אביב'); assert.equal(a.delivery_street,'דיזנגוף'); assert.equal(a.delivery_city,'תל אביב');
});
test('common small-item descriptions become proposed size and notes, subject to final review',async()=>{
 let state=(await advanceBooking(newBooking(),'start',services(),opts)).state;
 const result=await advanceBooking(state,'I need to send my keys or envelop',services(),opts);
 assert.equal(result.state.data.size,'small'); assert.match(result.state.data.notes,/keys/); assert.equal(result.create,undefined);
});
test('unrelated questions are redirected and never stored as customer details',async()=>{
 const state={phase:'collect',revision:0,consent_at:now,language:'en',data:{service:'standard',customer_type:'private',size:'small',pickup:'a',dropoff:'b',schedule:'2026-10-11 11:00'}};
 const result=await advanceBooking(state,'Who won the election?',services(),opts);
 assert.equal(result.state.data.name,undefined); assert.match(result.reply,/EdenMish deliveries/); assert.doesNotMatch(result.reply,/won|president/i);
});

test('short acknowledgements confirm only a displayed current review menu',async()=>{
 for(const text of ['k','ok','OK.','conf','confirm','כן']) {
  const state=await review(); assert.equal((await advanceBooking(state,text,services(),opts)).create.expectedPrice,50);
  const fresh=await advanceBooking(newBooking(),text,services(),opts); assert.equal(fresh.create,undefined); assert.equal(fresh.state.phase,'consent');
 }
 const state=await review();
 assert.equal((await advanceBooking(state,'ok but change the address',services(),opts)).create,undefined);
 assert.equal((await advanceBooking(state,'ok?',services(),opts)).create,undefined);
});

for (const phase of ['review','address_review']) test(`all spoken confirmation aliases remain blocked in ${phase}`,async()=>{
 const base=await review();
 if(phase==='address_review')Object.assign(base,{phase,quote:null,address_confirmed:false,menu:{kind:phase,phase,revision:base.revision}});
 base.multilingual=true;
 for(const text of ['1','01','١','۱','confirm','k','first','first option','האפשרות הראשונה','אפשרות 1','أؤكد','подтверждаю','je confirme']) {
  const svc={...services(),multilingual:true,quote:()=>assert.fail('voice confirmation must not reprice')};
  const spoken=await advanceBooking(base,text,svc,{...opts,inputKind:'voice'});
  assert.equal(spoken.state.phase,phase,text);assert.equal(spoken.create,undefined,text);
  assert.equal(spoken.state.terms_accepted_at,undefined,text);
  assert.deepEqual(spoken.state.data,base.data,text);assert.equal(spoken.state.address_confirmed,base.address_confirmed,text);
  // The same current-menu alias remains available as an explicit typed action.
  const typed=await advanceBooking(base,text,{...services(),multilingual:true},opts);
  assert.equal(typed.state.phase,phase==='review'?'creating':'review',text);
 }
 const edit=await advanceBooking(base,'second',services(),{...opts,inputKind:'voice'});
 assert.equal(edit.state.edit_menu,true);assert.equal(edit.create,undefined);
 const human=await advanceBooking(base,'third',services(),{...opts,inputKind:'voice'});
 assert.equal(human.state.phase,'handoff');assert.equal(human.create,undefined);
});
test('wallet, additional orders and business accounts require a person',async()=>{
 for(const text of ['use my wallet','business account','another order','חשבון עסקי']) {
  const result=await advanceBooking(await review(),text,services(),opts); assert.equal(result.state.phase,'handoff'); assert.equal(result.create,undefined);
 }
});

test('English city-first route preserves both addresses and recipient through successive map choices',async()=>{
 const svc=services(); const calls=[];
 svc.resolveAddress=async value=>{ calls.push(value); return {error:'ambiguous',candidates:[{address:calls.length===1?'בני משה 16, תל אביב':'קריניצי 111, רמת גן',city:calls.length===1?'תל אביב':'רמת גן',lat:32.08,lng:34.78}]}; };
 let state=(await advanceBooking(newBooking(),'start',svc,opts)).state;
 state=(await advanceBooking(state,'from tel aviv bni mosh 16 to ramat gan kernitzy 111 to eden',svc,opts)).state;
 assert.equal(state.phase,'address_choice'); assert.equal(state.data.pickup,undefined);
 assert.equal(parseAddress(calls[0]).delivery_city,'תל אביב');
 state=(await advanceBooking(state,'1',svc,opts)).state;
 assert.equal(state.data.pickup,'בני משה 16, תל אביב'); assert.equal(state.phase,'address_choice');
 assert.equal(parseAddress(calls[1]).delivery_city,'רמת גן');
 state=(await advanceBooking(state,'1',svc,opts)).state;
 assert.equal(state.data.dropoff,'קריניצי 111, רמת גן'); assert.equal(state.data.dropoff_detail,'Recipient: eden');
 assert.equal(state.data.name,undefined); assert.equal(state.address_confirmed,false); assert.equal(calls.length,2);
});

test('address suggestions never auto-select and a human request discards automation authority',async()=>{
 const svc=services(); svc.resolveAddress=async()=>({error:'ambiguous',candidates:[{address:'הרצל 10, תל אביב',city:'תל אביב',lat:32.08,lng:34.78}]});
 let state=(await advanceBooking(newBooking(),'start',svc,opts)).state;
 state=(await advanceBooking(state,'איסוף: הרצל 10 תל אביב',svc,opts)).state;
 assert.equal(state.phase,'address_choice');
 const unclear=await advanceBooking(state,'ok',svc,opts); assert.equal(unclear.state.data.pickup,undefined);
 const paused=await advanceBooking(state,'2',svc,opts); assert.equal(paused.state.phase,'handoff');
 assert.equal((await advanceBooking(paused.state,'1',svc,opts)).reply,null);
});

test('bare morning asks for a day before proposing slots, and numbered day choice preserves morning',async()=>{
 for(const text of ['בבוקר','in the morning']){
  let state=(await advanceBooking(newBooking(),'start',services(),opts)).state;
  const asked=await advanceBooking(state,text,services(),opts);
  assert.equal(asked.state.menu.kind,'schedule_day');assert.equal(asked.state.schedule_preference.date,null);
  assert.equal(asked.state.data.when_date,undefined);assert.equal(asked.state.data.when_hour,undefined);assert.equal(asked.create,undefined);
  assert.deepEqual(pickupSlotChoices(asked.state.schedule_preference,now).slots,[]);
  const day=await advanceBooking(asked.state,'2',services(),opts);
  assert.equal(day.state.schedule_preference.period,'morning');assert.equal(day.state.menu.kind,'schedule');
  assert.deepEqual(day.state.menu.slots,['2026-10-09 08:00','2026-10-09 09:00','2026-10-09 10:00']);
  assert.equal(day.state.data.when_hour,undefined);
  const chosen=await advanceBooking(day.state,'2',services(),opts);
  assert.equal(chosen.state.data.when_date,'2026-10-09');assert.equal(chosen.state.data.when_hour,9);assert.equal(chosen.create,undefined);
 }
});
test('bare morning refines the known date, invalidates the quote and requires a new numbered slot choice',async()=>{
 const state=await review();assert.equal(state.data.when_date,'2026-10-11');
 const result=await advanceBooking(state,'בבוקר',services(),opts);
 assert.equal(result.state.schedule_preference.date,'2026-10-11');assert.equal(result.state.quote,null);
 assert.equal(result.state.terms_accepted_at,undefined);assert.equal(result.state.data.when_hour,undefined);
 assert.deepEqual(result.state.menu.slots,['2026-10-11 09:00','2026-10-11 10:00','2026-10-11 11:00']);
 const chosen=await advanceBooking(result.state,'1',services(),opts);
 assert.equal(chosen.state.data.when_date,'2026-10-11');assert.equal(chosen.state.data.when_hour,9);assert.equal(chosen.create,undefined);
});
test('day clarification supports another date and handoff; closed day suggestions never select automatically',async()=>{
 const state=(await advanceBooking(newBooking(),'start',services(),opts)).state;
 const asked=await advanceBooking(state,'בבוקר',services(),opts);
 const dated=await advanceBooking(asked.state,'2026-10-10',services(),opts);
 assert.equal(dated.state.schedule_preference.date,'2026-10-10');assert.equal(dated.state.schedule_preference.period,'morning');
 assert.equal(dated.state.menu.slots[0],'2026-10-11 09:00');assert.match(dated.reply,/היום המתאים הבא/);assert.equal(dated.state.data.when_date,undefined);
 assert.equal((await advanceBooking(asked.state,'3',services(),opts)).state.phase,'handoff');
});

test('written review and edit choices are optional shortcuts scoped to the current menu',async()=>{
 for(const text of ['אני מאשר','אני מאשרת','הכל נכון','האפשרות הראשונה']) {
  const state=await review();const accepted=await advanceBooking(state,text,services(),opts);assert.equal(accepted.create.expectedPrice,50);
  const beforeConsent=await advanceBooking(newBooking(),text,services(),opts);assert.equal(beforeConsent.state.phase,'consent');assert.equal(beforeConsent.state.consent_at,undefined);assert.equal(beforeConsent.create,undefined);
  state.revision++;assert.equal((await advanceBooking(state,text,services(),opts)).create,undefined);
 }
 for(const text of ['modify','שינוי פרטים','אני רוצה לשנות','השנייה']) {
  const result=await advanceBooking(await review(),text,services(),opts);assert.equal(result.state.menu.kind,'edit');assert.equal(result.state.quote,null);assert.equal(result.create,undefined);
  const name=await advanceBooking(result.state,'שם',services(),opts);assert.equal(name.state.editing_field,'name');assert.equal(name.state.data.name,'Test Person');assert.equal(name.create,undefined);
 }
 for(const text of ['אני מאשר אבל צריך לשנות','אני לא מאשר','אישור?'])assert.equal((await advanceBooking(await review(),text,services(),opts)).create,undefined);
});
test('Hebrew natural multi-field message after consent keeps details through typo choices and daypart selection',async()=>{
 const {createOfflineBookingModel}=await import('../src/whatsapp-booking-model.js');
 const text='אני צריך לשלוח מפתחות מבני מושה 16 תל אביב לקרינצקי 111 רמת גן מחר בבוקר לנועה';
 const fields=[['size','מפתחות'],['notes','מפתחות'],['pickup','בני מושה 16 תל אביב'],['dropoff','קרינצקי 111 רמת גן'],['schedule','מחר בבוקר'],['dropoff_detail','לנועה']];
 const svc=services();let modelCalls=0,lookups=0;
 svc.conversationModel=createOfflineBookingModel(async request=>{
  modelCalls++;assert.equal(request.customer_message,text);
  return {version:2,intent:'update',fields:fields.map(([field,quote])=>({field,quote})),topic:null,clarify_field:null};
 });
 svc.resolveAddress=async value=>{lookups++;return {error:'ambiguous',candidates:[{address:value.startsWith('בני')?'בני משה 16, תל אביב':'קריניצי 111, רמת גן',city:value.startsWith('בני')?'תל אביב':'רמת גן',lat:32.08,lng:34.78}]};};
 let state=(await advanceBooking(newBooking(),'היי',svc,opts)).state;
 state=(await advanceBooking(state,'1',svc,opts)).state;assert.equal(modelCalls,0);assert.equal(state.menu.kind,'size');
 let result=await advanceBooking(state,text,svc,opts);state=result.state;
 assert.equal(modelCalls,1);assert.equal(state.data.size,'small');assert.equal(state.data.notes,'מפתחות');assert.equal(state.data.pickup,undefined);assert.equal(state.phase,'address_choice');assert.equal(result.create,undefined);
 state=(await advanceBooking(state,'האפשרות הראשונה',svc,opts)).state;
 assert.equal(state.data.pickup,'בני משה 16, תל אביב');assert.equal(state.data.dropoff,undefined);assert.equal(state.phase,'address_choice');
 state=(await advanceBooking(state,'אפשרות ראשונה',svc,opts)).state;
 assert.equal(state.data.dropoff,'קריניצי 111, רמת גן');assert.equal(state.data.dropoff_detail,'לנועה');assert.equal(state.schedule_preference.period,'morning');assert.equal(state.menu.kind,'schedule');assert.equal(state.data.when_hour,undefined);
 result=await advanceBooking(state,'השנייה',svc,opts);state=result.state;
 assert.equal(state.data.when_hour,9);assert.equal(state.data.when_date,'2026-10-09');assert.equal(state.data.name,undefined);
 assert.equal(state.data.size,'small');assert.equal(state.data.notes,'מפתחות');assert.equal(state.address_confirmed,false);assert.equal(result.create,undefined);
 assert.match(result.reply,/שם/);assert.equal(modelCalls,1);assert.equal(lookups,2);
});
test('unscoped or stale written options cannot select an address or time',async()=>{
 let state=(await advanceBooking(newBooking(),'start',services(),opts)).state;
 const scheduled=await advanceBooking(state,'מחר בבוקר',services(),opts);scheduled.state.revision++;
 const stale=await advanceBooking(scheduled.state,'השנייה',services(),opts);assert.equal(stale.state.data.when_hour,undefined);assert.equal(stale.create,undefined);
 const svc=services();svc.resolveAddress=async()=>({error:'ambiguous',candidates:[{address:'הרצל 10, תל אביב',city:'תל אביב',lat:32.08,lng:34.78}]});
 state=(await advanceBooking(state,'איסוף: הרצל 10 תל אביב',svc,opts)).state;assert.equal(state.phase,'address_choice');
 assert.equal((await advanceBooking(state,'ok',svc,opts)).state.data.pickup,undefined);
 state.revision++;assert.equal((await advanceBooking(state,'הראשונה',svc,opts)).state.data.pickup,undefined);
});


test('mixed confirmation words and menu numbers clarify without creating an order',async()=>{
 for (const phase of ['review','address_review']) for (const text of ['אישור 2','confirm 2','אישור 1','confirm 1','כתובות 2','addresses 2','2 אישור','2 confirm','אישור 2.']) {
  const state=await review(); state.phase=phase; state.revision=2; state.menu={kind:phase,phase,revision:2};
  let modelCalls=0,quoteCalls=0; const svc=services();
  svc.conversationModel=async()=>{modelCalls++;return null;};
  svc.quote=async()=>{quoteCalls++;return {price:50,currency:'ILS',review:false};};
  const before=structuredClone(state);
  const result=await advanceBooking(state,text,svc,opts);
  assert.equal(result.create,undefined,`${phase}: ${text} must not create`);
  assert.deepEqual(result.state,before); assert.equal(modelCalls,0);assert.equal(quoteCalls,0);
  assert.match(result.reply,/בחרו אפשרות אחת|choose one option/i);
 }
});
