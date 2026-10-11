import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {advanceBooking,newBooking,parseAddress} from '../src/whatsapp-booking.js';
import {createOfflineBookingModel,validateBookingProposal,proposeBookingTurn} from '../src/whatsapp-booking-model.js';
import {detectBookingLanguage,explicitLanguage,selectBookingLanguage,localizedCommand} from '../src/whatsapp-booking-language.js';
import {localCopy,BOOKING_TRANSLATIONS} from '../src/whatsapp-booking-i18n.js';
const cases=JSON.parse(readFileSync(new URL('./fixtures/whatsapp-multilingual.json',import.meta.url)));
const now=Date.parse('2026-10-10T09:00:00Z'),options={now,phone:'+972541234567',conversationOnly:true};
const proposal=c=>({version:4,reply_style:'friendly',intent:'update',fields:Object.entries(c.quotes).map(([field,quote])=>({field,quote})),topic:null,clarify_field:null,reply_language:c.language});
const svc={multilingual:true,order:()=>assert.fail('no order reads'),quote:async()=>({price:50,currency:'ILS',review:false}),resolveAddress:async text=>{const a=parseAddress(text);assert.ok(a,`parse ${text}`);return {address:text,city:a.delivery_city,lat:32.08,lng:34.78};}};
for(const c of cases) {
 test(`multilingual ${c.id}: source quotes, item, route, schedule and localized complete pilot`,async()=>{
  assert.equal(detectBookingLanguage(c.greeting),c.language);
  const valid=validateBookingProposal(proposal(c),c.text,now);assert.ok(valid);assert.equal(valid.entries.find(([k])=>k==='notes')[1],c.quotes.size);
  let r=await advanceBooking(newBooking(),c.greeting,svc,options);assert.equal(r.state.language,c.language);assert.match(r.reply,/OpenAI/);assert.equal(r.state.audio_consent_at,undefined);
  r=await advanceBooking(r.state,'1',svc,options);assert.equal(r.state.audio_consent_at,now);
  const model=createOfflineBookingModel(req=>{assert.equal(req.schema.properties.version.enum[0],4);assert.equal(req.customer_message,c.text);assert.equal(req.context.language,c.language);return proposal(c);});
  r=await advanceBooking(r.state,c.text,{...svc,conversationModel:model},options);
  assert.equal(r.interpretation,'model_proposal');assert.equal(r.state.data.notes,c.quotes.size);assert.equal(r.state.language,c.language);assert.equal(r.state.menu.kind,'schedule');assert.equal(r.state.data.schedule,undefined);
  for(const text of ['1','Test Person','pilot@example.com','none','none'])r=await advanceBooking(r.state,text,svc,options);
  assert.equal(r.state.phase,'address_review');
  r=await advanceBooking(r.state,'1',svc,options);assert.equal(r.state.phase,'review');assert.match(r.reply,/50/);assert.ok(r.reply.includes(c.quotes.size));
  if(['ar','ru','fr'].includes(c.language)){assert.ok(r.reply.includes(localCopy(c.language,'Final price')));assert.ok(r.reply.includes(localCopy(c.language,'1. Confirm and finish test\n2. Modify details\n3. Human help')));}
  const voice=await advanceBooking(r.state,'1',svc,{...options,inputKind:'voice'});assert.equal(voice.state.phase,'review');assert.equal(voice.create,undefined);assert.ok(voice.reply.includes(c.language==='he'?'הודעת טקסט':localCopy(c.language,'I heard a confirmation. Please confirm using the displayed number in a text message.')));
  r=await advanceBooking(r.state,'1',svc,options);assert.equal(r.state.phase,'handoff');assert.equal(r.create,undefined);assert.equal(r.state.terms_accepted_at,undefined);
 });
}
test('language selection ignores address scripts and borrowed words; explicit choice persists',()=>{
 for(const [text,previous,want] of [['Можно доставить на הרצל 15?','he','ru'],['אפשר pickup tomorrow?','he','he'],['Bonjour, livraison demain à Tel Aviv','he','fr'],['أريد توصيل إلى Google تل أبيب','he','ar'],['OK','ru','ru'],['2','fr','fr'],['הרצל 15 תל אביב','ru','ru'],['pilot@example.com','ar','ar']])assert.equal(detectBookingLanguage(text,previous),want,text);
 for(const [text,want] of [['תענה באנגלית','en'],['répondez en français','fr'],['ответь на русском','ru'],['رد بالعربية','ar'],['Hebrew please','he']])assert.equal(explicitLanguage(text),want,text);
 const state={language:'he'};selectBookingLanguage(state,'English please');selectBookingLanguage(state,'אפשר משלוח מחר');assert.equal(state.language,'en');
});
test('model cannot override explicit language preference, confirm, translate source evidence, or invent notes',async()=>{
 let state=(await advanceBooking(newBooking(),'French please',svc,options)).state;state=(await advanceBooking(state,'1',svc,options)).state;
 const model=createOfflineBookingModel(()=>({version:4,reply_style:'friendly',reply_language:'ru',intent:'greeting',fields:[],topic:null,clarify_field:null}));
 const r=await advanceBooking(state,'bonjour encore',{...svc,conversationModel:model},options);assert.equal(r.state.language,'fr');
 assert.equal(validateBookingProposal({...proposal(cases[1]),fields:[{field:'notes',quote:'keys'}]},cases[1].text,now),null);
 assert.equal(validateBookingProposal({...proposal(cases[1]),reply_language:'xx'},cases[1].text,now),null);
 assert.equal(validateBookingProposal({...proposal(cases[1]),intent:'confirm'},cases[1].text,now),null);
 assert.equal(await proposeBookingTurn(createOfflineBookingModel(()=>({...proposal(cases[1]),version:2,reply_language:undefined})),state,'مرحبا',now),null);
});
test('multilingual negations and swapped paired routes are rejected',()=>{
 for(const [text,quote] of [['не маленький','маленький'],['ليس صغير','صغير'],['pas petit','petit']])assert.equal(validateBookingProposal({version:4,reply_style:'friendly',reply_language:'en',intent:'update',fields:[{field:'size',quote}],topic:null,clarify_field:null},text,now),null);
 for(const c of cases.slice(1)){const p=proposal(c);p.fields=p.fields.map(f=>({...f,field:f.field==='pickup'?'dropoff':f.field==='dropoff'?'pickup':f.field}));assert.equal(validateBookingProposal(p,c.text,now),null);}
});
test('Arabic digit menus, localized human and ambiguous confirmation are deterministic',async()=>{
 assert.equal(localizedCommand('٢'),'2');for(const text of ['موظف','оператор','aide humaine'])assert.equal(localizedCommand(text),'human');
 for(const text of ['подтверждаю 2','2 confirmer','تأكيد ٢'])assert.match(localizedCommand(text),/^confirm 2$/);
 const state={phase:'review',language:'ru',multilingual:true,revision:2,consent_at:now,data:{},menu:{kind:'review',phase:'review',revision:2}};
 const r=await advanceBooking(state,'подтверждаю 2',svc,options);assert.equal(r.create,undefined);assert.equal(r.state.phase,'review');assert.match(r.reply,/Неясно/);
});
test('first-message start does not authorize undisclosed audio processing',async()=>{const r=await advanceBooking(newBooking(),'start',svc,options);assert.equal(r.state.audio_consent_at,undefined);});
test('all translated catalog entries provide Arabic, Russian and French',()=>{for(const [key,value] of Object.entries(BOOKING_TRANSLATIONS))for(const language of ['ar','ru','fr'])assert.ok(value[language]?.length,`${key}/${language}`);});
test('older text-only consent menu cannot silently authorize audio',async()=>{
 const old=(await advanceBooking(newBooking(),'hello',{...svc,multilingual:false},options)).state;
 const r=await advanceBooking(old,'1',svc,options);assert.equal(r.state.audio_consent_at,undefined);
});
test('translated item words do not switch language or corrupt a name answer',async()=>{
 const s={phase:'collect',revision:0,language:'ru',multilingual:true,consent_at:now,data:{size:'small',pickup:'a',dropoff:'b',schedule:'2026-10-11 11:00'}};
 const r=await advanceBooking(s,'Petit',svc,options);assert.equal(r.state.data.name,'Petit');
});
test('Arabic digits normalize only after grounding; card-like Arabic/Persian digits stay out of drafts',async()=>{
 const {hasSensitiveBookingText}=await import('../src/whatsapp-booking-model.js');
 assert.equal(parseAddress('ديزنغوف ١٥ تل أبيب').delivery_house_number,'15');
 assert.equal(hasSensitiveBookingText('٤١١١ ١١١١ ١١١١ ١١١١'),true);assert.equal(hasSensitiveBookingText('۴۱۱۱ ۱۱۱۱ ۱۱۱۱ ۱۱۱۱'),true);
 const s={phase:'collect',revision:0,language:'ar',multilingual:true,consent_at:now,data:{size:'small',pickup:'a',dropoff:'b',schedule:'2026-10-11 11:00'}};
 const r=await advanceBooking(s,'٤١١١ ١١١١ ١١١١ ١١١١',svc,options);assert.equal(r.state.data.name,undefined);assert.match(r.reply,/البطاقات/);
 const valid=validateBookingProposal({version:4,reply_style:'friendly',intent:'update',reply_language:'ar',fields:[{field:'schedule',quote:'٢٠٢٦-١٠-١١ ١١:٠٠'}],topic:null,clarify_field:null},'٢٠٢٦-١٠-١١ ١١:٠٠',now);assert.deepEqual(valid.entries,[['schedule','2026-10-11 11:00']]);
});
