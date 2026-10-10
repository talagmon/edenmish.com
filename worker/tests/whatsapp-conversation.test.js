import {test} from 'node:test';
import assert from 'node:assert/strict';
import {advanceBooking,parseAddress} from '../src/whatsapp-booking.js';
import {proposeBookingTurn,validateBookingProposal,createOfflineBookingModel} from '../src/whatsapp-booking-model.js';
import {bookingQuestion} from '../src/whatsapp-booking-copy.js';
const now=Date.parse('2026-10-10T09:00:00Z');
const options={now,phone:'+972541234567',conversationOnly:true};
const draft=language=>({phase:'collect',revision:0,consent_at:now,multilingual:true,language,language_explicit:true,data:{size:'small',notes:'keys'}});
const proposal=(style='friendly',language='en',rest={})=>({version:4,reply_style:style,reply_language:language,intent:'greeting',fields:[],topic:null,clarify_field:null,...rest});
const services=p=>({multilingual:true,conversationModel:createOfflineBookingModel(()=>p),quote:()=>assert.fail('no premature quote'),order:()=>assert.fail('no order'),resolveAddress:async text=>({address:text,city:parseAddress(text).delivery_city,lat:32,lng:34})});
for(const language of ['he','ar','ru','fr','en'])test(`conversational ${language}: speed groups route; uncertainty asks one detail`,async()=>{
 const brief=await advanceBooking(draft(language),'Please keep it quick',services(proposal('brief',language)),options);
 const guided=await advanceBooking(draft(language),'I’m confused. What do I do?',services(proposal('guided',language)),options);
 assert.equal(brief.state.reply_style,'brief');assert.equal(guided.state.reply_style,'guided');
 assert.notEqual(brief.reply,guided.reply);assert.equal(guided.state.data.size,'small');assert.equal(guided.state.data.notes,'keys');
 assert.equal(brief.create,undefined);assert.equal(guided.create,undefined);
 const single=bookingQuestion({...brief.state,bundle_route:false},'pickup');
 assert.notEqual(brief.reply,single);assert.ok(guided.reply.endsWith(bookingQuestion({...guided.state,bundle_route:false},'pickup')));
 assert.equal(brief.state.data.pickup,undefined);assert.equal(guided.state.editing_field,undefined);
});
test('one source-grounded message fills both requested addresses and asks only the next missing field',async()=>{
 const text='from הרצל 15 תל אביב to ביאליק 2 רמת גן';
 const r=await advanceBooking(draft('en'),text,services(proposal('brief','en',{intent:'update',fields:[{field:'pickup',quote:'הרצל 15 תל אביב'},{field:'dropoff',quote:'ביאליק 2 רמת גן'}]})),options);
 assert.equal(r.state.data.pickup,'הרצל 15 תל אביב');assert.equal(r.state.data.dropoff,'ביאליק 2 רמת גן');assert.equal(r.state.menu.kind,'schedule');assert.match(r.reply,/When should/);assert.doesNotMatch(r.reply,/Where from|Where to|You can reply/);assert.equal(r.state.phase,'collect');
});
test('a supplied pickup is not requested again; a single address remains valid when two were requested',async()=>{
 const s=draft('en');s.bundle_route=true;
 const r=await advanceBooking(s,'from הרצל 15 תל אביב',services(proposal('friendly','en',{intent:'update',fields:[{field:'pickup',quote:'הרצל 15 תל אביב'}]})),options);
 assert.match(r.reply,/Where’s it going/);assert.doesNotMatch(r.reply,/Where from/);assert.equal(r.state.data.pickup,'הרצל 15 תל אביב');
});
test('no model available never asks a combined question; an edit never asks for another field',async()=>{
 const s=draft('en');s.bundle_route=true;s.reply_style='brief';
 const noModel=await advanceBooking(s,'English please',{multilingual:true},options);
 assert.equal(noModel.state.bundle_route,false);assert.doesNotMatch(noModel.reply,/and where to/);
 assert.doesNotMatch(bookingQuestion({...s,editing_field:'pickup'},'pickup'),/and where to/);
});
test('uncertain field uses a single question and remains the active correction',async()=>{
 const r=await advanceBooking(draft('en'),'I meant a different destination',services(proposal('guided','en',{intent:'clarify',clarify_field:'dropoff'})),options);
 assert.equal(r.state.editing_field,'dropoff');assert.match(r.reply,/Where’s it going/);assert.doesNotMatch(r.reply,/Where from/);assert.equal(r.state.quote,null);
});
test('only bounded interaction styles accepted; legacy v3 validates but cannot satisfy a v4 request',async()=>{
 for(const style of ['rude','elderly',null,{},'confirm'])assert.equal(validateBookingProposal(proposal(style),'hello',now),null);
 assert.equal(validateBookingProposal({...proposal(),reply:'It will arrive in ten minutes'},'hello',now),null);
 const old={version:3,reply_language:'en',intent:'greeting',fields:[],topic:null,clarify_field:null};
 assert.ok(validateBookingProposal(old,'hello',now));assert.equal(await proposeBookingTurn(createOfflineBookingModel(()=>old),draft('en'),'hello',now),null);
});
test('same call receives interaction context without stored values, history or customer profile',async()=>{
 let calls=0;const s=draft('en');s.reply_style='guided';s.data.name='PRIVATE STORED NAME';s.data.email='private@example.invalid';s.history=['private history'];
 const model=createOfflineBookingModel(req=>{calls++;assert.equal(req.context.reply_style,'guided');assert.equal(req.context.active_field,'pickup');assert.equal(req.context.language_explicit,true);assert.equal(req.schema.properties.version.enum[0],4);assert.match(req.instructions,/Never infer age, gender/);assert.match(req.instructions,/Urgency never establishes delivery availability/);assert.doesNotMatch(JSON.stringify(req),/PRIVATE STORED|private@example|private history/);return proposal('guided');});
 assert.equal((await proposeBookingTurn(model,s,'OK, next?',now)).replyStyle,'guided');assert.equal(calls,1);
});
test('urgency cannot bypass price facts, confirmation ambiguity, voice confirmation or human handoff',async()=>{
 const price=await advanceBooking(draft('en'),'I’m rushing, how much?',services(proposal('brief','en',{intent:'question',topic:'pricing'})),options);
 assert.match(price.reply,/checks the price/);assert.equal(price.create,undefined);
 const s={...draft('en'),phase:'review',reply_style:'brief',menu:{kind:'review',phase:'review',revision:0}};
 const never={multilingual:true,conversationModel:createOfflineBookingModel(()=>assert.fail('no reasoning for closed menu'))};
 for(const [text,inputKind] of [['confirm 2','text'],['1','voice']]){const r=await advanceBooking(s,text,never,{...options,inputKind});assert.equal(r.create,undefined);assert.equal(r.state.phase,'review');assert.match(r.reply,/1\. Confirm/);}
 const h=await advanceBooking(s,'human',never,options);assert.equal(h.state.phase,'handoff');
});
