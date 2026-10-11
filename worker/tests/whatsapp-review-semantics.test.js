import {test} from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';
import {semanticDiagnostics} from '../scripts/whatsapp-review-semantics.mjs';
import {advanceBooking,newBooking,parseAddress} from '../src/whatsapp-booking.js';
import {createOfflineBookingModel} from '../src/whatsapp-booking-model.js';
import {validateBookingProposal} from '../src/whatsapp-booking-model.js';
const fixture=JSON.parse(readFileSync(new URL('../../docs/reviews/whatsapp-release-readiness-20261010/provider-proposal.json',import.meta.url)));
const request=fixture.requests[0],expected=request.expectedEntries;
const positive=()=>({intent:'update',replyStyle:'friendly',replyLanguage:'he',entries:structuredClone(expected)});
const old=(raw,a)=>raw.version===4&&!!a.replyStyle&&a.intent==='update'&&a.replyLanguage==='he'&&JSON.stringify([...a.entries].sort(([x],[y])=>x.localeCompare(y)))===JSON.stringify([...expected].sort(([x],[y])=>x.localeCompare(y)));
for(const kind of ['pass','missing','value','extra','duplicate','version','style','intent','language'])test('same acceptance with bounded diagnostics: '+kind,()=>{
 const raw={version:4},a=positive();
 if(kind==='missing')a.entries.pop();if(kind==='value')a.entries[0][1]='PRIVATE_SENTINEL';if(kind==='extra')a.entries.push(['PRIVATE_FIELD','PRIVATE_SENTINEL']);if(kind==='duplicate')a.entries.push([...a.entries[0]]);
 if(kind==='version')raw.version=3;if(kind==='style')a.replyStyle=null;if(kind==='intent')a.intent='clarify';if(kind==='language')a.replyLanguage='en';
 const d=semanticDiagnostics(raw,a,expected);assert.equal(d.matched,old(raw,a));assert.ok(!JSON.stringify(d).includes('PRIVATE_'));
 for(const value of expected.map(([,v])=>v))assert.ok(!JSON.stringify(d).includes(JSON.stringify(value)), 'no customer value retained');
});
test('valid partial evidence passes validator but fails nine-field comparison with named missing field',()=>{
 const fields=[['size','מעטפה קטנה'],['notes','מסמכים'],['pickup','מבני מושה 16 תל אביב'],['dropoff','לקרינצקי 111 רמת גן'],['schedule','מחר בבוקר'],['dropoff_detail','לנועה'],['name','יעל כהן'],['email','yael@example.com']];
 const raw={version:4,intent:'update',reply_language:'he',reply_style:'friendly',topic:null,clarify_field:null,fields:fields.map(([field,quote])=>({field,quote}))};
 const text=JSON.parse(request.payload.input[0].content).customer_message;
 const accepted=validateBookingProposal(raw,text,fixture.now,undefined,request.syntheticState.data);assert.ok(accepted);
 const d=semanticDiagnostics(raw,accepted,expected);assert.equal(d.matched,false);assert.deepEqual(d.missingFields,['pickup_detail']);assert.equal(d.checks.exactEntries,false);
});

const baselineFields=[['size','מעטפה קטנה'],['notes','מסמכים'],['pickup','מבני מושה 16 תל אביב'],['dropoff','לקרינצקי 111 רמת גן'],['schedule','מחר בבוקר'],['dropoff_detail','לנועה'],['name','יעל כהן'],['email','yael@example.com'],['pickup_detail','אצל השומר']];
const proposal=fields=>({version:4,intent:'update',fields:fields.map(([field,quote])=>({field,quote})),topic:null,clarify_field:null,reply_language:'he',reply_style:'friendly'});
const message=JSON.parse(request.payload.input[0].content).customer_message;
for(const [name,field,quote] of [
 ['complete shared item description','notes','מעטפה קטנה עם מסמכים'],
 ['explicit pickup context','pickup_detail','באיסוף אצל השומר'],
 ['recipient punctuation','dropoff_detail','לנועה.'],
])test(`oracle wording sensitivity reproduced through actual draft: ${name}`,async()=>{
 const fields=structuredClone(baselineFields);fields.find(([k])=>k===field)[1]=quote;
 if(field==='notes')fields.find(([k])=>k==='size')[1]=quote;
 const raw=proposal(fields),accepted=validateBookingProposal(raw,message,fixture.now);
 assert.ok(accepted);const d=semanticDiagnostics(raw,accepted,expected);
 assert.equal(d.matched,false);assert.deepEqual(d.valueMismatchFields,[field]);assert.deepEqual(d.missingFields,[]);
 const services={multilingual:true,conversationModel:createOfflineBookingModel(()=>raw),resolveAddress:async text=>({address:text,city:parseAddress(text).delivery_city,lat:32.08,lng:34.78}),quote:()=>assert.fail('No quote before confirmation'),order:()=>assert.fail('No order')};
 const opts={now:fixture.now,phone:'+972500000001',conversationOnly:true};
 let r=await advanceBooking(newBooking(),'היי',services,opts);r=await advanceBooking(r.state,'1',services,opts);r=await advanceBooking(r.state,message,services,opts);
 assert.equal(r.state.data[field],quote);assert.equal(r.state.data.size,'small');
 assert.equal(r.state.menu.kind,'schedule');r=await advanceBooking(r.state,'1',services,opts);assert.equal(r.state.phase,'address_review');assert.equal(r.create,undefined);
});
test('all field subsets preserve the original strict comparison and diagnose omissions',()=>{
 for(let mask=0;mask<512;mask++){
  const a=positive();a.entries=a.entries.filter((_,i)=>mask&(1<<i));const raw={version:4},d=semanticDiagnostics(raw,a,expected);
  assert.equal(d.matched,old(raw,a));assert.equal(d.missingFields.length,9-a.entries.length);
 }
 const a=positive();a.entries.reverse();assert.equal(semanticDiagnostics({version:4},a,expected).matched,true);
});
test('Hebrew attached route markers and surrounding quote spaces normalize before oracle comparison',()=>{
 for(const [pickup,dropoff] of [['מבני מושה 16 תל אביב','לקרינצקי 111 רמת גן'],['בני מושה 16 תל אביב','קרינצקי 111 רמת גן'],[' מבני מושה 16 תל אביב ','לקרינצקי 111 רמת גן ']]){
  const fields=structuredClone(baselineFields);fields.find(([k])=>k==='pickup')[1]=pickup;fields.find(([k])=>k==='dropoff')[1]=dropoff;
  const raw=proposal(fields),a=validateBookingProposal(raw,message,fixture.now);assert.ok(a);
  assert.equal(semanticDiagnostics(raw,a,expected).matched,true);
 }
});
test('invalid route, changed spelling and unsupported adjective cannot reach semantic diagnostics',()=>{
 for(const mutate of [
  fields=>{[fields[2][1],fields[3][1]]=[fields[3][1],fields[2][1]];},
  fields=>{fields[2][1]='מבני משה 16 תל אביב';},
  fields=>{fields[0][1]='קטנה';},
 ]){
  const fields=structuredClone(baselineFields);mutate(fields);assert.equal(validateBookingProposal(proposal(fields),message,fixture.now),null);
 }
});
