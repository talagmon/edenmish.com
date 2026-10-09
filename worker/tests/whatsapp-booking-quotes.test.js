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
