// Sol selects a conversational approach, never business facts or order authority.
// These are interaction preferences, not personality or demographic profiles.
export const REPLY_STYLES = Object.freeze(['friendly', 'brief', 'guided']);
export const CONVERSATION_INSTRUCTIONS = `Use everyday spoken language through reply_style: friendly by default; brief for an explicit request for speed or brevity; guided for confusion or a request for help, one detail at a time. Urgency never establishes delivery availability. Reassess from the current message; keep the previous style for short factual answers. Never infer age, gender, ethnicity, personality or ability from language, accent or grammar. Capture all clear details supplied together; ask only for missing or genuinely ambiguous details. Use greeting for a request to continue faster or explain the next step when no field is supplied; clarify only for ambiguous field evidence, not general confusion. No filler, repeated praise, forced slang, emojis or promises. Backend supplies short conversational copy and chooses the next safe step.`;

const FIELDS = ['size','pickup','dropoff','schedule','name','email','pickup_detail','dropoff_detail','notes'];
const COPY = {
 he: ['הפריט קטן או בינוני (עד קופסת נעליים ו־5 ק״ג)?','מאיפה לאסוף? רחוב, מספר ועיר.','לאן למסור? רחוב, מספר ועיר.','מתי לאסוף?','על שם מי?','מה האימייל למעקב ולקוד האימות?','יש קומה, דירה או איש קשר אחר באיסוף? אם כן, מה הפרטים? אם לא, אפשר לכתוב ״אין״.','יש קומה, דירה או איש קשר אחר במסירה? אם כן, מה הפרטים? אם לא, אפשר לכתוב ״אין״.','מה שולחים? יש משהו שחשוב לדעת?'],
 en: ['Small or medium (up to a shoe box and 5 kg)?','Where from? Street, number and city.','Where to? Street, number and city.','When should we pick it up?','What name should I use?','What’s your email for tracking and the verification code?','Any floor, apartment or different contact at pickup? Send the details, or say “none”.','Any floor, apartment or different contact at delivery? Send the details, or say “none”.','What are you sending? Anything we should know?'],
 ar: ['الغرض صغير أم متوسط (بحجم علبة أحذية وحتى 5 كغ)؟','من أين نستلم؟ الشارع، رقم المبنى والمدينة.','إلى أين نوصل؟ الشارع، رقم المبنى والمدينة.','متى تريد الاستلام؟','بأي اسم نسجل الطلب؟','ما بريدك الإلكتروني للتتبع ورمز التحقق؟','هل هناك طابق، شقة أو شخص آخر للتواصل عند الاستلام؟ اكتب التفاصيل أو «لا يوجد».','هل هناك طابق، شقة أو شخص آخر للتواصل عند التسليم؟ اكتب التفاصيل أو «لا يوجد».','ماذا ترسل؟ هل هناك شيء مهم نعرفه؟'],
 ru: ['Предмет маленький или средний (до обувной коробки и 5 кг)?','Откуда забрать? Улица, дом и город.','Куда доставить? Улица, дом и город.','Когда забрать?','На какое имя?','Какая у вас почта для отслеживания и кода подтверждения?','При заборе есть этаж, квартира или другой контакт? Напишите данные или «нет».','При доставке есть этаж, квартира или другой контакт? Напишите данные или «нет».','Что отправляете? Что ещё нужно знать?'],
 fr: ['Petit ou moyen (jusqu’à une boîte à chaussures et 5 kg) ?','Où récupérer le colis ? Rue, numéro et ville.','Où le livrer ? Rue, numéro et ville.','Quand faut-il le récupérer ?','À quel nom ?','Quel e-mail pour le suivi et le code de vérification ?','Un étage, un appartement ou un autre contact au retrait ? Précisez, ou dites « aucun ».','Un étage, un appartement ou un autre contact à la livraison ? Précisez, ou dites « aucun ».','Qu’envoyez-vous ? Autre chose à savoir ?'],
};
const FRIENDLY = {
 he:{pickup:'מאיפה לאסוף? אפשר לשלוח רחוב, מספר ועיר.',dropoff:'לאן למסור? אפשר לשלוח רחוב, מספר ועיר.',name:'על שם מי להזמין?'},
 en:{pickup:'Where should we pick it up? Please send the street, number and city.',dropoff:'Where’s it going? Please send the street, number and city.',name:'What name should I put on the booking?'},
 ar:{pickup:'من أين نستلم؟ أرسل اسم الشارع، رقم المبنى والمدينة.',dropoff:'إلى أين نوصل؟ أرسل اسم الشارع، رقم المبنى والمدينة.',name:'بأي اسم نسجل الطلب؟'},
 ru:{pickup:'Откуда забрать? Напишите улицу, номер дома и город.',dropoff:'Куда доставить? Напишите улицу, номер дома и город.',name:'На какое имя оформить заказ?'},
 fr:{pickup:'Où peut-on récupérer le colis ? Indiquez la rue, le numéro et la ville.',dropoff:'Où va le colis ? Indiquez la rue, le numéro et la ville.',name:'À quel nom fait-on la réservation ?'},
};
const ROUTE = {
 he:'מאיפה לאסוף ולאן למסור? רחוב, מספר ועיר בכל כתובת.',
 en:'Where from and where to? Street, number and city for each address.',
 ar:'من أين نستلم وإلى أين نوصل؟ الشارع، رقم المبنى والمدينة لكل عنوان.',
 ru:'Откуда забрать и куда доставить? Улица, дом и город для каждого адреса.',
 fr:'Où récupérer le colis et où le livrer ? Rue, numéro et ville pour chaque adresse.',
};
const GUIDED = {
 he:'ניקח את זה פרט אחד בכל פעם. ', en:'Let’s take it one detail at a time. ',
 ar:'نأخذها خطوة خطوة. ', ru:'Давайте по одному шагу. ', fr:'On avance étape par étape. ',
};
export function conversationalQuestion(state, field, {single = false} = {}) {
 if (!state.multilingual) return null;
 const language = Object.hasOwn(COPY,state.language) ? state.language : 'he';
 if (!single && state.bundle_route && state.reply_style !== 'guided' && !state.editing_field
   && field === 'pickup' && state.data?.pickup == null && state.data?.dropoff == null) return ROUTE[language];
 return (state.reply_style !== 'brief' && FRIENDLY[language][field]) || COPY[language][FIELDS.indexOf(field)] || null;
}
export const conversationalLead = state => state.reply_style === 'guided' ? GUIDED[state.language] || GUIDED.he : '';
