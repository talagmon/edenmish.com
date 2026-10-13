import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {prepareBookingAudio,AUDIO_LIMITS} from '../src/whatsapp-booking-audio-format.js';
import {boundedAudioBytes,twilioVoiceMedia} from '../src/whatsapp-booking-audio.js';
const fixture=name=>new Uint8Array(readFileSync(new URL(`./fixtures/audio/tone.${name}`,import.meta.url)));
for(const [format,mime] of [['ogg','audio/ogg; codecs=opus'],['wav','audio/wav'],['mp3','audio/mpeg']])test(`bounded ${format} fixture produces supported file with measured duration`,()=>{
 const result=prepareBookingAudio(fixture(format),mime);assert.ok(result.seconds>=1 && result.seconds<1.2);assert.equal(result.extension,format==='ogg'?'webm':format);
 if(format==='ogg'){assert.deepEqual([...result.bytes.slice(0,4)],[0x1a,0x45,0xdf,0xa3]);assert.ok(result.bytes.length<30000);}
});
test('bad format, corrupt OGG CRC, truncated packets, fake MIME and oversized files reject before provider',()=>{
 for(const format of ['ogg','wav','mp3'])assert.throws(()=>prepareBookingAudio(fixture(format).slice(0,-4),format==='mp3'?'audio/mpeg':`audio/${format}`));
 const corrupt=fixture('ogg');corrupt[40]^=1;assert.throws(()=>prepareBookingAudio(corrupt,'audio/ogg'));
 assert.throws(()=>prepareBookingAudio(fixture('wav'),'audio/ogg'));
 assert.throws(()=>prepareBookingAudio(new Uint8Array(AUDIO_LIMITS.bytes+1),'audio/wav'));
 assert.throws(()=>prepareBookingAudio(fixture('wav'),'video/mp4'));
});
test('WAV duration uses data and verified sample geometry, not header duration claims',()=>{
 const tone=fixture('wav'),view=new DataView(tone.buffer);let p=12;while(new TextDecoder().decode(tone.slice(p,p+4))!=='data')p+=8+view.getUint32(p+4,true)+(view.getUint32(p+4,true)%2);
 const long=new Uint8Array(p+8+16000*2*61);long.set(tone.slice(0,p+8));const v=new DataView(long.buffer);v.setUint32(4,long.length-8,true);v.setUint32(p+4,long.length-p-8,true);
 assert.throws(()=>prepareBookingAudio(long,'audio/wav'));
 view.setUint32(28,1,true);assert.throws(()=>prepareBookingAudio(tone,'audio/wav'));
});
test('stream size bounds apply without Content-Length and on incorrect declared lengths',async()=>{
 await assert.rejects(()=>boundedAudioBytes(new Response(new Uint8Array(100)),50));
 await assert.rejects(()=>boundedAudioBytes(new Response(new Uint8Array(2),{headers:{'content-length':'100'}}),50));
 assert.equal((await boundedAudioBytes(new Response(new Uint8Array(20)),50)).length,20);
});
test('media descriptor is pinned to signed account/message, one audio file and exact HTTPS API origin',()=>{
 const env={TWILIO_ACCOUNT_SID:'AC'+'1'.repeat(32)},id='SM'+'2'.repeat(32),url=`https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/Messages/${id}/Media/ME${'3'.repeat(32)}`;
 const form=new URLSearchParams({NumMedia:'1',MediaUrl0:url,MediaContentType0:'audio/ogg'});assert.ok(twilioVoiceMedia(form,env,id));
 for(const value of [url+'?redirect=x',url.replace('api.twilio.com','api.twilio.com.evil.test'),url.replace(id,'SM'+'4'.repeat(32)),'https://127.0.0.1/a']){form.set('MediaUrl0',value);assert.equal(twilioVoiceMedia(form,env,id),null);}
 form.set('MediaUrl0',url);form.set('NumMedia','2');assert.equal(twilioVoiceMedia(form,env,id),null);
});
test('signed Twilio webhook exposes audio only after account, recipient and signature checks',async()=>{
 const {readTwilioBookingEvent}=await import('../src/whatsapp-booking-twilio.js');
 const env={TWILIO_ACCOUNT_SID:'AC'+'1'.repeat(32),TWILIO_AUTH_TOKEN:'synthetic-only',TWILIO_BOOKING_FROM:'whatsapp:+15551234567',TWILIO_RECIPIENT_POLICY:'allowlist',TWILIO_RECIPIENT_ALLOWLIST:'+972541234567',TWILIO_BOOKING_WEBHOOK_URL:'https://ops-staging.edenmish.com/webhooks/twilio/booking',WHATSAPP_BOOKING_VOICE_ENABLED:'on'};
 const id='SM'+'2'.repeat(32),now=Date.parse('2026-10-10T09:00:00Z'),form=new URLSearchParams({MessageSid:id,AccountSid:env.TWILIO_ACCOUNT_SID,From:'whatsapp:'+env.TWILIO_RECIPIENT_ALLOWLIST,To:env.TWILIO_BOOKING_FROM,NumMedia:'1',MediaContentType0:'audio/ogg',MediaUrl0:`https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/Messages/${id}/Media/ME${'3'.repeat(32)}`});
 const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(env.TWILIO_AUTH_TOKEN),{name:'HMAC',hash:'SHA-1'},false,['sign']);
 const signed=env.TWILIO_BOOKING_WEBHOOK_URL+[...form.keys()].sort().map(k=>k+form.get(k)).join('');
 const signature=btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(signed)))));
 let calls=0;const fetchImpl=async()=>{calls++;return Response.json({sid:id,account_sid:env.TWILIO_ACCOUNT_SID,direction:'inbound',from:form.get('From'),to:form.get('To'),date_created:new Date(now).toISOString()});};
 const request=sig=>new Request(env.TWILIO_BOOKING_WEBHOOK_URL,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded','X-Twilio-Signature':sig},body:form});
 assert.equal((await readTwilioBookingEvent(request('invalid'),env,fetchImpl,now)).status,401);assert.equal(calls,0);
 const result=await readTwilioBookingEvent(request(signature),env,fetchImpl,now);assert.equal(result.event.audio.url,form.get('MediaUrl0'));assert.equal(result.event.text,null);assert.equal(calls,1);
 const off=await readTwilioBookingEvent(request(signature),{...env,WHATSAPP_BOOKING_VOICE_ENABLED:'off'},fetchImpl,now);assert.equal(off.event.audio,undefined);
});
