import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {extractBookingText} from '../src/whatsapp-booking-text.js';
import {validateBookingProposal,createOfflineBookingModel} from '../src/whatsapp-booking-model.js';
import {advanceBooking,newBooking} from '../src/whatsapp-booking.js';
const now=Date.parse('2026-10-12T07:00:00Z');
const proposal=quote=>({version:4,intent:'update',fields:[{field:'size',quote}],topic:null,clarify_field:null,reply_language:'he',reply_style:'brief'});
const accepted=[
 ['מעטפה קטנה עם מסמכים','small','מסמכים'],
 ['אני צריך לשלוח מעטפה קטנה עם מסמכים','small','מסמכים'],
 ['אני צריכה לשלוח מעטפה עם מכתב.','small','מכתב'],
 ['מעטפה אחת עם מסמכים','small','מסמכים'],
 ['1 מעטפה עם מסמכים','small','מסמכים'],
 ['מעטפה קטנה אחת עם מסמכים','small','מסמכים'],
 ['מעטפה עם מפתחות','small','מפתחות'],
 ['חבילה קטנה עם מסמכים','small','מסמכים'],
 ['קופסה בינונית עם מפתחות','medium','מפתחות'],
];
for(const [text,size,notes] of accepted)test(`complete description: ${text}`,()=>{
 assert.deepEqual(extractBookingText(text,now)?.entries,[['size',size],['notes',notes]]);
 assert.deepEqual(validateBookingProposal(proposal(text),text,now)?.entries,[['size',size],['notes',notes]]);
});
const rejected=[
 'חבילה עם מסמכים','קופסה עם מסמכים','שתי מעטפות קטנות עם מסמכים','2 מעטפות עם מסמכים',
 'מעטפה קטנה עם 200 מסמכים','מעטפה קטנה עם מסמכים ומפתחות','מעטפה קטנה עם מסמכים או מפתחות',
 'מעטפה קטנה בלי מסמכים','לא מעטפה קטנה עם מסמכים','מעטפה קטנה עם מסמכים לא שלי',
 'מעטפה קטנה עם מסמכים וחבילה גדולה','מעטפה קטנה עם מסמכים במשקל 10 קג',
 'מעטפה קטנה עם מסמכים 100x100 ס״מ','מעטפה קטנה עם מסמכים במידות 100 על 100',
 'מעטפה גדולה עם מסמכים','מעטפה קטנה או בינונית עם מסמכים','מעטפה קטנה עם מסמכים בעצם בינונית',
 'מקרר קטן עם מסמכים','חבילה קטנה עם סכין','מעטפה קטנה עם סוללות',
];
for(const text of rejected)test(`unsupported complete description: ${text}`,()=>{
 assert.equal(extractBookingText(text,now)?.entries,undefined);
 assert.equal(validateBookingProposal(proposal(text),text,now),null);
});
for(const text of [
 'מעטפה קטנה עם מסמכים 100x100','מעטפה קטנה עם מסמכים במידות 100 על 100',
 'מעטפה קטנה עם מסמכים 30 ס״מ','2 מעטפה קטנה עם מסמכים','שתי מעטפה קטנה עם מסמכים',
 'מעטפה קטנה עם מסמכים. בעצם חבילה גדולה','לא מעטפה קטנה עם מסמכים',
 'מעטפה קטנה עם מסמכים או חבילה בינונית','מעטפה קטנה עם מסמכים במשקל 10קג',
])test(`omitted conflicting context rejects: ${text}`,()=>{
 assert.equal(validateBookingProposal(proposal('מעטפה קטנה עם מסמכים'),text,now),null);
});
test('existing notes survive inferred contents',()=>{
 const text='מעטפה קטנה עם מסמכים';
 assert.deepEqual(validateBookingProposal(proposal(text),text,now,undefined,{notes:'הערה קודמת'}).entries,[['size','small']]);
});
test('overlapping and fabricated evidence remains rejected',()=>{
 const text='מעטפה קטנה עם מסמכים';
 const raw=proposal(text);raw.fields.push({field:'notes',quote:'מסמכים'});
 assert.equal(validateBookingProposal(raw,text,now),null);
 assert.equal(validateBookingProposal(proposal('מעטפה עם מפתחות'),text,now),null);
});
test('full synthetic booking retains nine fields when contents are inferred',()=>{
 const fixture=JSON.parse(readFileSync(new URL('../../docs/reviews/whatsapp-release-readiness-20261010/provider-proposal.json',import.meta.url)));
 const request=fixture.requests[0],text=JSON.parse(request.payload.input[0].content).customer_message;
 const raw=proposal('מעטפה קטנה עם מסמכים');
 raw.fields.push(...[
  ['pickup','מבני מושה 16 תל אביב'],['dropoff','לקרינצקי 111 רמת גן'],['schedule','מחר בבוקר'],
  ['dropoff_detail','לנועה'],['name','יעל כהן'],['email','yael@example.com'],['pickup_detail','אצל השומר'],
 ].map(([field,quote])=>({field,quote})));
 const result=validateBookingProposal(raw,text,fixture.now);
 assert.ok(result);
 const sorted=rows=>[...rows].sort(([a],[b])=>a.localeCompare(b));
 assert.deepEqual(sorted(result.entries),sorted(request.expectedEntries));
});
test('consented synthetic draft collects contents without creating an order',async()=>{
 const text='מעטפה קטנה עם מסמכים';
 const services={multilingual:true,order:()=>assert.fail('no order'),conversationModel:createOfflineBookingModel(()=>proposal(text))};
 const options={now,phone:'+972541234567',conversationOnly:true};
 let result=await advanceBooking(newBooking(),'hello',services,options);
 result=await advanceBooking(result.state,'1',services,options);
 result=await advanceBooking(result.state,text,services,options);
 assert.equal(result.state.data.size,'small');assert.equal(result.state.data.notes,'מסמכים');assert.equal(result.create,undefined);
});

for (const suffix of ['וסוללות','עם סוללות','בכמות 200','100 על 100','באורך מטר',', ארבע מעטפות',', ארבע חבילות',', ٤ חבילות']) {
 for (const quote of ['מעטפה קטנה','מעטפה קטנה עם מסמכים']) test(`partial evidence preserves qualifier: ${suffix} / ${quote}`,()=>{
  const text='מעטפה קטנה עם מסמכים '+suffix;
  assert.equal(validateBookingProposal(proposal(quote),text,now),null);
 });
}
for (const text of ['מעטפה קטנה עם סוללות','מעטפה קטנה עם 200 מסמכים','מעטפה קטנה עם מסמכים ומפתחות']) {
 test(`partial evidence cannot drop contents: ${text}`,()=>{
  for(const quote of ['מעטפה','קטנה','מעטפה קטנה']) assert.equal(validateBookingProposal(proposal(quote),text,now),null);
 });
}
test('an incomplete quote cannot silently lose valid stated contents either',()=>{
 assert.equal(validateBookingProposal(proposal('מעטפה קטנה'),'מעטפה קטנה עם מסמכים',now),null);
});

for (const suffix of [', וסוללות',', עם סוללות','. הכוללת סוללות',' הכוללת סוללות',' וגם סוללות',' המכילה סוללות',' 100 מטר']) {
 test(`punctuation cannot hide contents or dimensions: ${suffix}`,()=>{
  const quote='מעטפה קטנה עם מסמכים';
  assert.equal(validateBookingProposal(proposal(quote),quote+suffix,now),null);
 });
}
for (const suffix of [' ומחר בבוקר',' ושמי דנה',' והאיסוף מדיזנגוף 10 תל אביב','. באיסוף יש הליכה של 100 מטר','. אין מעלית']) {
 test(`unrelated booking continuation preserves item: ${suffix}`,()=>{
  const quote='מעטפה קטנה עם מסמכים';
  assert.deepEqual(validateBookingProposal(proposal(quote),quote+suffix,now)?.entries,[['size','small'],['notes','מסמכים']]);
 });
}

for (const notesFirst of [false,true]) test(`separate complete grounded notes remain accepted: notesFirst=${notesFirst}`,()=>{
 const text='מעטפה קטנה עם מסמכים';const raw=proposal('מעטפה קטנה');
 raw.fields.push({field:'notes',quote:'מסמכים'});if(notesFirst)raw.fields.reverse();
 const result=validateBookingProposal(raw,text,now);
 assert.ok(result);assert.ok(result.entries.some(([k,v])=>k==='size'&&v==='small'));
 assert.ok(result.entries.some(([k,v])=>k==='notes'&&v==='מסמכים'));
});
for (const [text,notes] of [
 ['מעטפה קטנה עם סוללות','סוללות'],['מעטפה קטנה עם מסמכים וסוללות','מסמכים'],
 ['מעטפה קטנה עם מסמכים, וסוללות','מסמכים'],['מעטפה קטנה עם מסמכים בכמות 200','מסמכים'],
 ['מעטפה קטנה עם מסמכים מסמכים','מסמכים'],['מעטפה קטנה עם מסמכים','מפתחות'],
]) test(`separate notes cannot bypass content validation: ${text} / ${notes}`,()=>{
 const raw=proposal('מעטפה קטנה');raw.fields.push({field:'notes',quote:notes});
 assert.equal(validateBookingProposal(raw,text,now),null);
});

for (const qualifier of ['גדולה','בינונית','קטנה']) {
 for(const notesFirst of [false,true]) test(`joint contents cannot hide a following size: ${qualifier} / ${notesFirst}`,()=>{
  const raw=proposal('מעטפה');raw.fields.push({field:'notes',quote:'מסמכים'});if(notesFirst)raw.fields.reverse();
  assert.equal(validateBookingProposal(raw,'מעטפה עם מסמכים '+qualifier,now),null);
 });
}

for (const qualifier of ['גדולה','בינונית','קטנה']) test(`complete contents cannot hide following size: ${qualifier}`,()=>{
 const quote='מעטפה עם מסמכים';
 assert.equal(validateBookingProposal(proposal(quote),quote+' '+qualifier,now),null);
});
