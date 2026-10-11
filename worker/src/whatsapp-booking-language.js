import { BOOKING_LANGUAGES } from './whatsapp-booking-i18n.js';
export const normalizeBookingDigits = text => text.replace(/[٠-٩۰-۹]/g,c=>String(c.charCodeAt(0)-(c<='٩'?0x660:0x6f0)));
export const supportedLanguage = value => BOOKING_LANGUAGES.includes(value);
const norm = text => text.normalize('NFKC').trim().toLowerCase().replace(/[.!؟?]+$/u, '').trim();
const languageNames = {he:'hebrew|עברית|العبرية|иврит(?:е)?|hébreu',ar:'arabic|ערבית|العربية|عربي|арабск(?:ий|ом)|arabe',ru:'russian|רוסית|الروسية|русский|русском|russe',fr:'french|צרפתית|الفرنسية|французск(?:ий|ом)|français',en:'english|אנגלית|الإنجليزية|الانجليزية|английск(?:ий|ом)|anglais'};
export function explicitLanguage(text) {
  const value=norm(text);
  for(const [language,names] of Object.entries(languageNames)) {
    // Full-message requests only; quoted prose/address fragments cannot switch preference.
    const pattern=new RegExp(`^(?:(?:(?:please )?(?:(?:can we|can you|could we|could you) )?(?:continue|speak|reply|respond|switch)(?: to me)?(?: in| to)?|(?:תענה|תעני|אפשר|בבקשה|לעבור|נא לעבור|בואו נמשיך)(?: לדבר)?|(?:أجب|رد|تحدث)(?: معي)?|(?:ответь|отвечай|говорите|пожалуйста)(?: на)?|(?:réponds|répondez|parlez)(?: en)?)\\s+)?(?:ב|ל|ب|بال)?(?:${names})(?:\\s+(?:please|בבקשה|من فضلك|пожалуйста|s’il vous plaît|s'il vous plaît))?$`,'iu');
    if(pattern.test(value))return language;
  }
  return null;
}
const lexicon={
 he:/^(?:שלום|היי|אני|צריך|צריכה|רוצה|אפשר|בבקשה|משלוח|לשלוח|לאסוף|מחר|היום|בבוקר|מפתחות|קטן|קטנה|תודה)$/u,
 ar:/^(?:السلام|عليكم|مرحبا|مرحبًا|اهلا|أهلا|انا|أنا|اريد|أريد|احتاج|أحتاج|ممكن|لو|سمحت|يرجى|توصيل|إرسال|ارسال|غدا|غدًا|اليوم|صباحا|صباحًا|مفاتيح|شكرا|شكرًا)$/u,
 ru:/^(?:добрый|день|привет|здравствуйте|мне|нужно|нужна|нужен|хочу|можно|пожалуйста|доставка|доставить|отправить|забрать|завтра|сегодня|утром|ключи|спасибо)$/u,
 fr:/^(?:bonjour|salut|je|veux|voudrais|besoin|pouvez|envoyer|livraison|livrer|demain|aujourd’hui|aujourd'hui|matin|merci|clés|petit|petite|français)$/u,
 en:/^(?:hello|hi|i|need|want|would|please|can|send|delivery|deliver|collect|pickup|tomorrow|today|morning|thanks|keys|small|english)$/u,
};
export function detectBookingLanguage(text, previous=null) {
  const requested=explicitLanguage(text);if(requested)return requested;
  const words=norm(text).replace(/\S+@\S+|https?:\/\/\S+/gu,'').match(/[\p{L}\p{M}]+(?:['’][\p{L}]+)?/gu)||[];
  const scores=Object.fromEntries(BOOKING_LANGUAGES.map(l=>[l,words.filter(w=>lexicon[l].test(w)).length]));
  const ranked=Object.entries(scores).sort((a,b)=>b[1]-a[1]);
  // Conversation vocabulary beats street names, company names and alphabet counts.
  if(scores[previous]>0 && ranked[0][1]-scores[previous]<=1)return previous;
  if(ranked[0][1]>=1 && ranked[0][1]>ranked[1][1])return ranked[0][0];
  if(ranked[0][1] && scores[previous]===ranked[0][1])return previous;
  if(!ranked[0][1] && !supportedLanguage(previous)) {
    if(words.some(w=>/^[\p{Script=Arabic}\p{M}]+$/u.test(w)))return 'ar';
    if(words.some(w=>/^[\p{Script=Cyrillic}]+$/u.test(w)))return 'ru';
    return 'he';
  }
  return supportedLanguage(previous)?previous:'he';
}
export function selectBookingLanguage(state,text) {
  const requested=explicitLanguage(text);
  if(requested){state.language=requested;state.language_explicit=true;}
  else if(!state.language_explicit)state.language=detectBookingLanguage(text,state.language);
  return state.language || 'he';
}
export function localizedCommand(text) {
  const value=normalizeBookingDigits(norm(text));
  const commands={
   human:/^(?:موظف|مندوب|مساعدة بشرية|توقف|إلغاء|الغاء|оператор|сотрудник|человек|стоп|отмена|arrêter|annuler|aide humaine|un conseiller)$/u,
   start:/^(?:أوافق|اوافق|ابدأ|نبدأ|начать|согласен|согласна|commencer|j’accepte|j'accepte)$/u,
   confirm:/^(?:تأكيد|أؤكد|اؤكد|نعم|подтвердить|подтверждаю|да|confirmer|je confirme|oui)$/u,
   edit:/^(?:تعديل|تغيير التفاصيل|изменить|редактировать|modifier|changer les détails)$/u,
   none:/^(?:لا يوجد|بدون|нет|ничего|aucun|aucune|rien)$/u,
  };
  for(const [key,pattern] of Object.entries(commands))if(pattern.test(value))return key;
  const size=multilingualSize(value);if(size && !size.notes)return size.size;
  if(/^\d{1,2}$/.test(value))return value;
  // A word + number must reach the existing ambiguity guard, never a legacy revision command.
  const mixed=/^(.+?)\s+(\d{1,2})$|^(\d{1,2})\s+(.+)$/u.exec(value);
  if(mixed && commands.confirm.test(mixed[1]||mixed[4]))return `confirm ${mixed[2]||mixed[3]}`;
  return text;
}
export function multilingualSize(text) {
 const value=norm(text);
 if(/^(?:صغير|صغيرة|маленький|маленькая|небольшой|petit|petite|small|קטן|קטנה)$/u.test(value))return {size:'small'};
 if(/^(?:متوسط|متوسطة|средний|средняя|moyen|moyenne|medium|בינוני|בינונית)$/u.test(value))return {size:'medium'};
 if(/^(?:مفتاح|مفاتيح|ظرف|ключ|ключи|конверт|clés?|une enveloppe|enveloppe)$/u.test(value))return {size:'small',notes:text.trim()};
 return null;
}
// Normalize ONLY a complete schedule field, never a whole message or address.
export function multilingualSchedule(text) {
 let value=norm(text);
 const days={"aujourd'hui":'today','aujourd’hui':'today',demain:'tomorrow',сегодня:'today',завтра:'tomorrow',اليوم:'today','غدا':'tomorrow','غدًا':'tomorrow'};
 const periods={'le matin':'morning',matin:'morning',"l'après-midi":'afternoon','l’après-midi':'afternoon',"après-midi":'afternoon','après midi':'afternoon',soir:'evening','le soir':'evening',утром:'morning',днем:'afternoon','днём':'afternoon',вечером:'evening','صباحا':'morning','صباحًا':'morning','في الصباح':'morning','بعد الظهر':'afternoon','مساء':'evening','مساءً':'evening'};
 if(Object.hasOwn(periods,value))return periods[value];
 for(const [word,day] of Object.entries(days))if(value===word||value.startsWith(word+' ')) {
   const rest=value.slice(word.length).trim();if(!rest)return day;
   if(Object.hasOwn(periods,rest))return day+' '+periods[rest];
 }
 return text;
}

export const BOOKING_CITY_ALIASES = Object.fromEntries([
 ['תל אביב','tel aviv','tel-aviv','тель авив','тель-авив','تل أبيب','تل ابيب'],
 ['תל אביב-יפו','tel aviv yafo','tel aviv-yafo','tel aviv jaffa','tel-aviv-jaffa','тель-авив-яффо','تل أبيب يافا'],
 ['רמת גן','ramat gan','ramat-gan','рамат ган','рамат-ган','رمات غان','رامات غان'],
 ['גבעתיים','givatayim','givataim','гиватаим','جفعتايم','غفعتايم'],
 ['בני ברק','bnei brak','bnei-brak','бней брак','бней-брак','بني براك'],
 ['הרצליה','herzliya','herzliya','герцлия','هرتسليا'],
 ['רמת השרון','ramat hasharon','ramat hasharon','рамат ха-шарон','رمات هشارون'],
 ['חולון','holon','холон','حولون'],['בת ים','bat yam','bat-yam','бат ям','бат-ям','بات يام'],
 ['קריית אונו','kiryat ono','kiryat-ono','кирьят оно','кирьят-оно','كريات أونو'],
 ['גבעת שמואל','givat shmuel','гиват шмуэль','جفعات شموئيل'],
 ['אזור','azor','азор','أزور'],['גני תקווה','ganei tikva','ганей тиква','غاني تكفا'],
 ['סביון','savyon','савьон','سافيون'],['אור יהודה','or yehuda','ор йехуда','أور يهودا'],
 ['ראשון לציון','rishon lezion','rishon le zion','ришон ле-цион','ришон лецион','ريشون لتسيون'],
 ['כפר סבא','kfar saba','kfar-saba','кфар саба','кфар-саба','كفار سابا'],
 ['רעננה','raanana','ra’anana',"ra'anana",'раанана','رعنانا'],
 ['פתח תקווה','petah tikva','petach tikva','петах тиква','петах-тиква','بيتاح تكفا'],
 ['הוד השרון','hod hasharon','ход ха-шарон','هود هشارون'],
 ['רמלה','ramla','рамла','الرملة','رملة'],['לוד','lod','лод','اللد','لد'],
].flatMap(([canonical,...aliases])=>aliases.map(alias=>[alias,canonical])));
