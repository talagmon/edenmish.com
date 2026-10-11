// Offline replay only. All model proposals, map resolution and prices are fixtures.
import fs from 'node:fs';
import {advanceBooking,newBooking,parseAddress} from '../src/whatsapp-booking.js';
import {createOfflineBookingModel} from '../src/whatsapp-booking-model.js';
const cases=JSON.parse(fs.readFileSync(new URL('../tests/fixtures/whatsapp-multilingual.json',import.meta.url)));
const now=Date.parse('2026-10-10T09:00:00Z'),options={now,phone:'+972541234567',conversationOnly:true};
const svc={multilingual:true,quote:async()=>({price:50,currency:'ILS',review:false}),resolveAddress:async text=>({address:text,city:parseAddress(text).delivery_city,lat:32,lng:34}),order:async()=>{throw Error('unexpected order');}};
const replays=[];
for(const c of cases){
 let state=newBooking();const turns=[];
 const model=createOfflineBookingModel(()=>({version:4,reply_style:'friendly',intent:'update',fields:Object.entries(c.quotes).map(([field,quote])=>({field,quote})),topic:null,clarify_field:null,reply_language:c.language}));
 for(const [text,kind] of [[c.greeting,'text'],['1','text'],[c.text,'voice'],['1','text'],['Test Person','text'],['pilot@example.com','text'],['none','text'],['none','text'],['1','text'],['1','voice'],['1','text']]){
  const result=await advanceBooking(state,text,kind==='voice'&&text===c.text?{...svc,conversationModel:model}:svc,{...options,inputKind:kind});state=result.state;
  if(result.create)throw Error('offline pilot created an order');
  turns.push({customer:text,input_kind:kind,assistant:result.reply,phase:state.phase,language:state.language});
 }
 replays.push({id:c.id,language:c.language,turns,final_phase:state.phase,item_description:state.data.notes});
}
process.stdout.write(JSON.stringify({generated_at:new Date().toISOString(),clock:new Date(now).toISOString(),provider_calls:0,audio:'Prescribed transcripts; media fixtures are synthetic tones, not speech.',replays},null,2));
