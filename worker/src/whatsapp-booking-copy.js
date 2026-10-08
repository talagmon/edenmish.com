// Reviewed copy only: a model selects meaning, never ungrounded customer prose.
export const bookingLanguage = (previous, text) => {
  const requested = requestedBookingLanguage(text);
  if (requested) return requested;
  if (/^english(?: please)?[.!?]?$/i.test(text.trim()) || /\b(?:speak|in|switch to) english\b/i.test(text) || /(?:באנגלית|לעבור לאנגלית)/u.test(text)) return 'en';
  if (/^hebrew(?: please)?[.!?]?$/i.test(text.trim()) || /(?:בעברית|לעבור לעברית)/u.test(text) || /\bin hebrew\b/i.test(text)) return 'he';
  const words = text.replace(/\S+@\S+|https?:\/\/\S+/g, '');
  if ((words.match(/[א-ת]/g) || []).length >= 3) return 'he';
  if ((words.match(/\b[a-z]{2,}\b/gi) || []).length >= 3) return 'en';
  return previous === 'en' ? 'en' : 'he';
};
export const bookingSay = (state, he, en) => state.language === 'en' ? en : he;
export const SHORT_QUESTIONS = {
  he: {
    size: 'מה גודל הפריט — קטן או בינוני (עד קופסת נעליים ועד 5 ק״ג)?',
    pickup: 'מאיפה לאסוף — רחוב, מספר בית ועיר?',
    dropoff: 'לאיזו כתובת למסור — רחוב, מספר בית ועיר?',
    schedule: 'מתי תרצו איסוף? אפשר לכתוב היום, מחר בבוקר או תאריך אחר.',
    name: 'על שם מי להזמין?',
    email: 'מה האימייל לקבלת קישור המעקב וקוד האימות?',
    pickup_detail: 'מה פרטי הגישה ואיש הקשר באיסוף — קומה, דירה, שם וטלפון אם שונים משלכם (אפשר לכתוב אין)?',
    dropoff_detail: 'מה פרטי הגישה ואיש הקשר במסירה — קומה, דירה, שם וטלפון אם שונים משלכם (אפשר לכתוב אין)?',
    notes: 'מה שולחים, והאם יש הערה חשובה למשלוח (אפשר לכתוב אין)?',
  },
  en: {
    size: 'Is the item small or medium (up to a shoe box and 5 kg)?',
    pickup: 'Where should we collect it — street, house number and city?',
    dropoff: 'Where should we deliver it — street, house number and city?',
    schedule: 'When would you like pickup? You can say today, tomorrow morning, or another date.',
    name: 'What name should the booking be under?',
    email: 'What email should receive the tracking link and verification code?',
    pickup_detail: 'Any pickup access or contact details — floor, apartment, name and phone if different from yours (or say none)?',
    dropoff_detail: 'Any delivery access or contact details — floor, apartment, name and phone if different from yours (or say none)?',
    notes: 'What is the item, and are there any delivery notes (or say none)?',
  },
};
const FACT_REPLIES = {
  he: {
    scope: 'כאן מזמינים משלוח רגיל ללקוח פרטי; שירות אחר או חשבון עסקי דורשים נציג.',
    pricing: 'המחיר נבדק במערכת ומופיע בסיכום לפני שמאשרים את ההזמנה.',
    hours: 'אפשר לבקש מועד עד 30 יום קדימה, והמערכת תבדוק אם הוא בשעות הפעילות.',
    payment: 'משלמים בקישור מאובטח אחרי האישור, והתשלום נחשב מאומת רק אחרי בדיקת המערכת.',
    tracking: 'האימייל נדרש לקבלת קישור המעקב וקוד האימות.',
    privacy: 'נאסוף פרטי הזמנה בלבד — אין לשלוח פרטי כרטיס, תעודות או סודות.',
    identity: 'אני העוזר הדיגיטלי של EdenMish, ואפשר לבקש נציג בכל שלב.',
  },
  en: {
    scope: 'This channel books standard delivery for private customers; other services or business accounts need a person.',
    pricing: 'The system checks the price and shows it in the summary before you confirm.',
    hours: 'You can request a time within the next 30 days, and the system checks operating hours.',
    payment: 'Pay through the secure link after confirmation; payment is verified only by the system.',
    tracking: 'Email is required for the tracking link and verification code.',
    privacy: 'We collect booking details only — please never send card numbers, identity documents or secrets.',
    identity: 'I’m the EdenMish digital assistant, and you can ask for a person at any time.',
  },
};
export const bookingQuestion = (state, field) => SHORT_QUESTIONS[state.language === 'en' ? 'en' : 'he'][field];
export const bookingFact = (state, topic) => FACT_REPLIES[state.language === 'en' ? 'en' : 'he'][topic];

export const requestedBookingLanguage = text => /^(?:(?:please )?(?:(?:can we|can you|could we|could you) )?(?:continue|speak|reply|respond|switch)(?: to me)?(?: in| to)? (?:english|hebrew)(?: please)?|(?:english|hebrew)(?: please)?|(?:עברית|אנגלית)(?: בבקשה)?|(?:בוא(?:ו)? נמשיך|אפשר|נא לעבור|לעבור|אני רוצה)(?: לדבר)? (?:בעברית|באנגלית|לעברית|לאנגלית)(?: בבקשה)?)[.!?]?$/iu.test(text.trim()) ? /english|אנגלית/iu.test(text) ? 'en' : 'he' : null;
export const isBookingLanguageRequest = text => requestedBookingLanguage(text) !== null;
export const HANDOFF_EN = 'Your request needs a person, so automation is paused. Please do not send card numbers or sensitive documents.';
