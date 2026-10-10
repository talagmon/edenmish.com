import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {readTwilioBookingEvent} from '../src/whatsapp-booking-twilio.js';
import {validateBookingProposal,createOfflineBookingModel} from '../src/whatsapp-booking-model.js';
import {advanceBooking,newBooking} from '../src/whatsapp-booking.js';

const now=Date.parse('2026-10-10T12:00:00Z');
const env={TWILIO_ACCOUNT_SID:'AC'+'1'.repeat(32),TWILIO_AUTH_TOKEN:'synthetic-test-only',TWILIO_BOOKING_FROM:'whatsapp:+15551234567',TWILIO_RECIPIENT_POLICY:'allowlist',TWILIO_RECIPIENT_ALLOWLIST:'+972541234567',TWILIO_BOOKING_WEBHOOK_URL:'https://local.example/webhooks/twilio/booking',WHATSAPP_BOOKING_VOICE_ENABLED:'on'};
function request(id,extra={},validSignature=true){
 const form=new URLSearchParams({MessageSid:id,AccountSid:env.TWILIO_ACCOUNT_SID,From:'whatsapp:'+env.TWILIO_RECIPIENT_ALLOWLIST,To:env.TWILIO_BOOKING_FROM,NumMedia:'1',MediaContentType0:'audio/ogg',MediaUrl0:`https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/Messages/${id}/Media/ME${'3'.repeat(32)}`,...extra});
 const signature=createHmac('sha1',env.TWILIO_AUTH_TOKEN).update(env.TWILIO_BOOKING_WEBHOOK_URL+[...form.keys()].sort().map(k=>k+form.get(k)).join('')).digest('base64');
 return new Request(env.TWILIO_BOOKING_WEBHOOK_URL,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded','X-Twilio-Signature':validSignature?signature:'invalid'},body:form});
}
const resource=id=>({sid:id,account_sid:env.TWILIO_ACCOUNT_SID,direction:'inbound',from:'whatsapp:'+env.TWILIO_RECIPIENT_ALLOWLIST,to:env.TWILIO_BOOKING_FROM,date_created:new Date(now).toISOString()});
for(const prefix of ['SM','MM'])test(`signed ${prefix} audio reaches the media pipeline with grounded message identity`,async()=>{
 const id=prefix+'2'.repeat(32);let calls=0;
 const r=await readTwilioBookingEvent(request(id),env,async url=>{calls++;assert.ok(url.endsWith(`/Messages/${id}.json`));return Response.json(resource(id));},now);
 assert.equal(r.status,200);assert.equal(r.event.id,id);assert.equal(r.event.text,null);assert.ok(r.event.audio.url.includes(`/Messages/${id}/Media/`));assert.equal(calls,1);
});
test('media IDs do not weaken signature, account, sender, allowlist or identity checks',async()=>{
 const id='MM'+'2'.repeat(32),noFetch=()=>assert.fail('reject before provider metadata');
 assert.equal((await readTwilioBookingEvent(request(id,{},false),env,noFetch,now)).status,401);
 for(const extra of [{AccountSid:'AC'+'4'.repeat(32)},{To:'whatsapp:+15559999999'}])assert.equal((await readTwilioBookingEvent(request(id,extra),env,noFetch,now)).status,400);
 assert.equal((await readTwilioBookingEvent(request(id),{...env,TWILIO_RECIPIENT_ALLOWLIST:''},noFetch,now)).status,403);
 for(const bad of ['ME'+'2'.repeat(32),'MM'+'2'.repeat(31),'MM'+'z'.repeat(32),'prefix'+id,id+'0'])assert.equal((await readTwilioBookingEvent(request(bad),env,noFetch,now)).status,400);
 for(const changed of [{sid:'MM'+'4'.repeat(32)},{direction:'outbound-api'},{account_sid:'AC'+'4'.repeat(32)}])assert.equal((await readTwilioBookingEvent(request(id),env,async()=>Response.json({...resource(id),...changed}),now)).status,400);
 const mismatchedMedia=await readTwilioBookingEvent(request(id,{MediaUrl0:`https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/Messages/MM${'4'.repeat(32)}/Media/ME${'3'.repeat(32)}`}),env,async()=>Response.json(resource(id)),now);
 assert.equal(mismatchedMedia.event.audio,undefined);
});
const proposal=(quote,fields=[])=>({version:4,reply_style:'friendly',reply_language:'he',intent:'update',fields:[{field:'size',quote},...fields],topic:null,clarify_field:null});
for(const [quote,size] of [['מעטפה קטנה','small'],['חבילה קטנה','small'],['קופסה קטנה','small'],['פריט קטן','small'],['מעטפה בינונית','medium'],['חבילה בינונית','medium'],['פריט בינוני','medium']])test(`Hebrew item phrase ${quote} preserves the source description`,()=>{
 const text=`אפשר להמשיך בעברית? בבקשה לשלוח ${quote}.`,r=validateBookingProposal(proposal(quote),text,now);
 assert.ok(r);assert.deepEqual(r.entries,[['size',size],['notes',quote]]);
 assert.equal(validateBookingProposal(proposal(quote),text,now,undefined,{notes:'existing description'}).entries.some(([key])=>key==='notes'),false);
 const explicit=validateBookingProposal(proposal(quote,[{field:'notes',quote:'נא להתקשר'}]),text+' נא להתקשר',now);
 assert.deepEqual(explicit.entries,[['size',size],['notes','נא להתקשר']]);
});
test('synthetic Hebrew request advances in Hebrew with the item retained and no order',async()=>{
 const text='אפשר להמשיך בעברית? בבקשה לשלוח מעטפה קטנה.';
 const options={now,phone:env.TWILIO_RECIPIENT_ALLOWLIST,conversationOnly:true};
 const services={multilingual:true,order:()=>assert.fail('no order'),conversationModel:createOfflineBookingModel(()=>proposal('מעטפה קטנה'))};
 let r=await advanceBooking(newBooking(),'hello',services,options);
 r=await advanceBooking(r.state,'1',services,options);
 assert.equal(r.state.language,'en');
 r=await advanceBooking(r.state,text,services,options);
 assert.equal(r.interpretation,'model_proposal');assert.equal(r.state.language,'he');assert.equal(r.state.phase,'collect');assert.equal(r.state.data.size,'small');assert.equal(r.state.data.notes,'מעטפה קטנה');assert.equal(r.create,undefined);assert.match(r.reply,/מאיפה|איסוף/);assert.doesNotMatch(r.reply,/נעצרה/);
});
test('Hebrew size evidence still rejects negation, alternatives, weight and unsupported large items',()=>{
 for(const quote of ['לא מעטפה קטנה','מעטפה קטנה או חבילה בינונית','מעטפה קטנה 10 ק״ג','מעטפה גדולה','מקרר קטן','מעטפה קטנה וכבדה'])assert.equal(validateBookingProposal(proposal(quote),quote,now),null,quote);
 assert.equal(validateBookingProposal(proposal('מעטפה קטנה'),'לא מעטפה קטנה',now),null);
 assert.equal(validateBookingProposal(proposal('מעטפה קטנה'),'מעטפה בינונית',now),null);
});
