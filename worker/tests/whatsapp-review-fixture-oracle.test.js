import {test} from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';
import {validateBookingProposal} from '../src/whatsapp-booking-model.js';
import {fixedFixtureSemantics} from '../scripts/whatsapp-review-fixture-oracle.mjs';
const fixture=JSON.parse(readFileSync(new URL('../../docs/reviews/whatsapp-release-readiness-20261010/provider-proposal.json',import.meta.url)));
const request=fixture.requests[0],text=JSON.parse(request.payload.input[0].content).customer_message;
const fields=[['size','מעטפה קטנה'],['notes','מסמכים'],['pickup','מבני מושה 16 תל אביב'],['dropoff','לקרינצקי 111 רמת גן'],['schedule','מחר בבוקר'],['dropoff_detail','לנועה'],['name','יעל כהן'],['email','yael@example.com'],['pickup_detail','אצל השומר']];
function raw(changes={}){return {version:4,intent:'update',fields:fields.map(([field,quote])=>({field,quote:changes[field]??quote})),topic:null,clarify_field:null,reply_language:'he',reply_style:'friendly'};}
function evaluate(value,req=request,now=fixture.now){let rejection;const accepted=validateBookingProposal(value,text,now,r=>{rejection=r;});return accepted?fixedFixtureSemantics(value,accepted,req,now):{matched:false,strictRejection:rejection};}
for(const notes of ['מסמכים','מעטפה קטנה עם מסמכים'])for(const pickup_detail of ['אצל השומר','אצל השומר.','באיסוף אצל השומר','באיסוף אצל השומר.'])for(const dropoff_detail of ['לנועה','לנועה.'])test(`enumerated source variants: ${notes} / ${pickup_detail} / ${dropoff_detail}`,()=>{
 const value=raw({notes,pickup_detail,dropoff_detail,...(notes.startsWith('מעטפה')?{size:notes}:{})}),before=JSON.stringify(value),d=evaluate(value);
 assert.equal(d.matched,true);assert.equal(d.fixtureBound,true);assert.equal(d.equivalentEntries,true);assert.equal(JSON.stringify(value),before,'no quote or proposal mutation');
 const changed=Object.entries({notes,pickup_detail,dropoff_detail}).filter(([field,value])=>value!==new Map(request.expectedEntries).get(field)).map(([field])=>field).sort();assert.deepEqual(d.equivalentFields,changed);assert.equal(d.checks.exactEntries,changed.length===0);
 for(const [,privateValue] of request.expectedEntries)assert.ok(!JSON.stringify(d).includes(JSON.stringify(privateValue)));
});
test('grounded inferred contents and existing route normalization remain valid',()=>{
 const value=raw({size:'מעטפה קטנה עם מסמכים',pickup:'בני מושה 16 תל אביב',dropoff:'קרינצקי 111 רמת גן'});value.fields=value.fields.filter(x=>x.field!=='notes');assert.equal(evaluate(value).matched,true);
});
for(const [field,quote] of [
 ['name','יעל'],['name','כהן'],['dropoff_detail','לנועה. שמי'],
 ['pickup_detail','השומר'],['pickup_detail','אצל'],['pickup_detail','באיסוף'],
 ['schedule','מחר'],['schedule','בבוקר'],
])test(`grounded but incomplete/changed meaning cannot use equivalence: ${field}/${quote}`,()=>{
 const d=evaluate(raw({[field]:quote}));assert.equal(d.strictRejection,undefined,'exercise oracle after strict validation');assert.equal(d.matched,false);assert.deepEqual(d.valueMismatchFields,[field]);
});
for(const [field,quote] of [
 ['name','יעל לוי'],['name','השומר'],['name','יעל כהן.'],['pickup','מבני משה 16 תל אביב'],
 ['pickup','לקרינצקי 111 רמת גן'],['dropoff','מבני מושה 16 תל אביב'],
 ['notes','מסמכים!'],['notes','מעטפה קטנה עם מפתחות'],['pickup_detail','לא אצל השומר'],
 ['pickup_detail','אצל השומר!'],['pickup_detail','אצל השומר..'],['dropoff_detail','לנעה.'],
 ['dropoff_detail','לנועה!'],['dropoff_detail','נועה'],['schedule','מחר בשעה 10'],['email','yael@example.com.'],
])test(`invented or role-invalid evidence is rejected before equivalence: ${field}/${quote}`,()=>{
 const d=evaluate(raw({[field]:quote}));assert.equal(d.matched,false);assert.ok(d.strictRejection);
});
test('complete coverage required for all512 subsets even with allowed variants',()=>{
 const value=raw({size:'מעטפה קטנה עם מסמכים',notes:'מעטפה קטנה עם מסמכים',pickup_detail:'באיסוף אצל השומר.',dropoff_detail:'לנועה.'});
 const all=validateBookingProposal(value,text,fixture.now);assert.ok(all);
 for(let mask=0;mask<512;mask++){
  const accepted={...all,entries:all.entries.filter((_,i)=>mask&(1<<i))};const d=fixedFixtureSemantics(value,accepted,request,fixture.now);assert.equal(d.matched,mask===511);
 }
 const duplicate={...all,entries:[...all.entries,all.entries[0]]};assert.equal(fixedFixtureSemantics(value,duplicate,request,fixture.now).matched,false);
});
test('request/body/expected-values/state/clock pins cannot be swapped to permit another fixture',()=>{
 const value=raw({pickup_detail:'באיסוף אצל השומר'}),accepted=validateBookingProposal(value,text,fixture.now);
 for(const mutate of [r=>r.sha256='a'.repeat(64),r=>r.payload.input[0].content+=' ',r=>r.expectedEntries.pop(),r=>r.expectedEntries.find(([k])=>k==='name')[1]='PRIVATE_OTHER_NAME',r=>r.syntheticState.data={name:'PRIVATE_OTHER_NAME'},r=>r.syntheticState.language='en']){
  const req=structuredClone(request);mutate(req);const d=fixedFixtureSemantics(value,accepted,req,fixture.now);assert.equal(d.matched,false);assert.equal(d.fixtureBound,false);assert.ok(!JSON.stringify(d).includes('PRIVATE_'));
 }
 assert.equal(fixedFixtureSemantics(value,accepted,request,fixture.now+1).matched,false);
});
test('equivalence requires the actual validated field quote, not a fabricated accepted-value substitution',()=>{
 const value=raw(),a=validateBookingProposal(value,text,fixture.now);a.entries.find(([k])=>k==='notes')[1]='מעטפה קטנה עם מסמכים';assert.equal(fixedFixtureSemantics(value,a,request,fixture.now).matched,false);
});
test('version, language and intent requirements still win over field equivalence',()=>{
 for(const patch of [{version:3,reply_style:undefined},{reply_language:'en'},{intent:'clarify',fields:[],clarify_field:'pickup'}]){
  const value={...raw({pickup_detail:'באיסוף אצל השומר'}),...patch};if(value.version===3)delete value.reply_style;assert.equal(evaluate(value).matched,false);
 }
});
