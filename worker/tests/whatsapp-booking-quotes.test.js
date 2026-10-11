import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { BOOKING_PROPOSAL_SCHEMA, validateBookingProposal } from '../src/whatsapp-booking-model.js';
const corpus=JSON.parse(readFileSync(new URL('./fixtures/whatsapp-booking-quotes.json',import.meta.url),'utf8'));
const now=Date.parse('2026-10-09T06:00:00Z');
for(const item of corpus)test(`quoted evidence / ${item.category} / ${item.id}`,()=>{
 const result=validateBookingProposal(item.proposal,item.text,now);
 assert.deepEqual(result?.entries??null,item.expected_entries);
});
test('v2 schema exposes quotes only, and the offline corpus has bounded distinct cases',()=>{
 assert.deepEqual(BOOKING_PROPOSAL_SCHEMA.properties.version.enum,[2]);
 assert.deepEqual(BOOKING_PROPOSAL_SCHEMA.properties.fields.items.required,['field','quote']);
 assert.equal(BOOKING_PROPOSAL_SCHEMA.properties.fields.items.additionalProperties,false);
 assert.ok(corpus.length>=60&&corpus.length<=100);assert.equal(new Set(corpus.map(x=>x.id)).size,corpus.length);
 for(const field of ['start','end','value'])assert.equal(BOOKING_PROPOSAL_SCHEMA.properties.fields.items.properties[field],undefined);
});
test('unpaired surrogates and empty/malformed quote properties fail closed',()=>{
 for(const quote of ['\ud83d','\udc00',null,{},true]){
  assert.equal(validateBookingProposal({version:2,intent:'update',fields:[{field:'notes',quote}],topic:null,clarify_field:null},typeof quote==='string'?quote:'text',now),null);
 }
});

test('rejection diagnostics leave every corpus acceptance result unchanged and expose fixed codes only',async()=>{
 const {BOOKING_REJECTION_REASONS}=await import('../src/whatsapp-booking-diagnostics.js');
 for(const item of corpus){
  const reasons=[];const result=validateBookingProposal(item.proposal,item.text,now,reason=>reasons.push(reason));
  assert.deepEqual(result?.entries??null,item.expected_entries,item.id);
  assert.equal(reasons.length,result?0:1,item.id);
  for(const reason of reasons)assert.ok(BOOKING_REJECTION_REASONS.includes(reason));
 }
});
test('synthetic rejected proposals distinguish shape, intent, evidence and typed-value failures',()=>{
 const make=(field,quote)=>({version:2,intent:'update',fields:[{field,quote}],topic:null,clarify_field:null});
 const cases=[
  [null,'keys','envelope_shape'],[{...make('size','keys'),version:1},'keys','envelope_values'],
  [{...make('size','keys'),intent:'greeting'},'keys','intent_fields'],
  [{...make('size','keys'),clarify_field:'size'},'keys','intent_context'],
  [make('invented','keys'),'keys','field_shape'],
  [{...make('size','keys'),fields:[{field:'size',quote:'keys'},{field:'size',quote:'keys'}]},'keys','field_duplicate'],
  [make('size','KEYS'),'keys','quote_missing'],[make('size','keys'),'keys keys','quote_ambiguous'],
  [make('notes','key'),'keys','quote_boundary'],[make('size','keys'),'not keys','quote_negated'],
  [make('notes','front\ndoor'),'front\ndoor','quote_format'],
  [{...make('name','Eden'),fields:[{field:'name',quote:'Eden'},{field:'notes',quote:'Eden'}]},'Eden','quote_overlap'],
  [make('size','my'),'send my keys','size_unsupported'],
  [make('schedule','eventually'),'eventually','schedule_unsupported'],
  [make('email','invalid'),'invalid','email_invalid'],['{','keys','input_json'],
  [make('notes','x'),'x'.repeat(2001),'input_size'],
  [make('notes','sk-synthetic-fixture-only'),'sk-synthetic-fixture-only','input_sensitive'],
 ];
 for(const [raw,text,expected] of cases){const reasons=[];assert.equal(validateBookingProposal(raw,text,now,reason=>reasons.push(reason)),null);assert.deepEqual(reasons,[expected]);}
 const hostile={get version(){throw new Error('private fixture');},intent:'update',fields:[],topic:null,clarify_field:null};let reason;
 assert.equal(validateBookingProposal(hostile,'keys',now,r=>reason=r),null);assert.equal(reason,'validation_exception');
 assert.equal(validateBookingProposal(make('size','my'),'my keys',now,()=>{throw new Error('observer failure');}),null);
});
