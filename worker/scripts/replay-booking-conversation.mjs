// Offline behavior examples: prescribed Sol decisions, actual booking responses.
import {advanceBooking} from '../src/whatsapp-booking.js';
import {createOfflineBookingModel} from '../src/whatsapp-booking-model.js';
const inputs={
 he:['אני ממהר, בוא נקצר','לא הבנתי מה צריך לעשות','היי, נמשיך?'],
 ar:['أنا مستعجل، خلينا نختصر','لم أفهم، ماذا أفعل الآن؟','أهلًا، نكمل؟'],
 ru:['Я тороплюсь, давайте коротко','Я не понял, что делать дальше?','Привет, продолжим?'],
 fr:['Je suis pressé, faisons court','Je n’ai pas compris, que dois-je faire ?','Bonjour, on continue ?'],
 en:['I’m in a hurry, let’s keep it short','I’m confused. What do I do next?','Hi, shall we carry on?'],
};
const now=Date.parse('2026-10-10T09:00:00Z'),examples=[];
for(const [language,messages] of Object.entries(inputs))for(const [i,style] of ['brief','guided','friendly'].entries()){
 const data={size:'small',notes:'keys',...(style==='friendly'?{pickup:'הרצל 15 תל אביב'}:{})};
 const state={phase:'collect',revision:0,consent_at:now,multilingual:true,language,language_explicit:true,data};
 const model=createOfflineBookingModel(()=>({version:4,reply_language:language,reply_style:style,intent:'greeting',fields:[],topic:null,clarify_field:null}));
 const result=await advanceBooking(state,messages[i],{multilingual:true,conversationModel:model},{now,phone:'+972541234567',conversationOnly:true});
 if(result.create)throw Error('unexpected order');
 examples.push({language,style,customer:messages[i],assistant:result.reply,already_collected:Object.keys(data),phase:result.state.phase});
}
process.stdout.write(JSON.stringify({generated_at:new Date().toISOString(),provider_calls:0,limitation:'Sol decisions are prescribed mocks. Responses come from the local booking engine; real model style selection is not yet evaluated.',examples},null,2));
