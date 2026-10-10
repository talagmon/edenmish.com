import { conversationalLead } from './whatsapp-booking-conversation.js';
import { localCopy, multilingualConsent } from './whatsapp-booking-i18n.js';
import { selectBookingLanguage, explicitLanguage, localizedCommand, multilingualSize, BOOKING_CITY_ALIASES, normalizeBookingDigits } from './whatsapp-booking-language.js';
// Transport-independent booking authority. Optional bounded interpretation proposes
// fields only; validation, confirmation and state transitions remain deterministic.
import { proposeBookingTurn, hasSensitiveBookingText } from './whatsapp-booking-model.js';
import { bookingLanguage, bookingSay, bookingQuestion, bookingFact, isBookingLanguageRequest, HANDOFF_EN } from './whatsapp-booking-copy.js';
import { extractBookingText } from './whatsapp-booking-text.js';
import { normalizeIlPhone, scheduleError } from './validate.js';
import { validateEmailAddress } from './email-validation.js';
import { zoneOf, GUSH_DAN } from './pricing.js';
import { validateBusinessBatchAddresses } from './business-address.js';
import { bookingPilotReady, pilotNotice, pilotComplete } from './whatsapp-booking-pilot.js';
import { israelDay, pickupPreference, pickupSlotChoices } from './whatsapp-booking-slots.js';

export const QUOTE_TTL = 10 * 60 * 1000;
export const SESSION_WINDOW = 24 * 60 * 60 * 1000;
export const HANDOFF = 'הבקשה הועברה לטיפול אנושי. האוטומציה נעצרה. אין לשלוח פרטי כרטיס או מסמכים רגישים.';
const FIELDS = ['size', 'pickup', 'dropoff', 'schedule', 'name', 'email', 'pickup_detail', 'dropoff_detail', 'notes'];
const LABELS = { size: 'גודל', pickup: 'איסוף', dropoff: 'מסירה', schedule: 'מועד', name: 'שם', email: 'אימייל', pickup_detail: 'פרטי איסוף', dropoff_detail: 'פרטי מסירה', notes: 'הערות' };
const QUESTIONS = {
  size: 'מה גודל הפריט? קטן (מעטפה או פריט קטן) או בינוני (עד קופסת נעליים ועד 5 ק״ג). השירות כאן הוא משלוח רגיל ללקוח פרטי. בקשה אחרת? כתבו נציג.',
  pickup: 'מה כתובת האיסוף? רחוב ומספר בית, עיר. לדוגמה: דיזנגוף 10, תל אביב',
  dropoff: 'מה כתובת המסירה? רחוב ומספר בית, עיר.',
  schedule: 'מתי תרצו איסוף? אפשר לכתוב היום, מחר בבוקר או תאריך אחר (שעון ישראל).',
  name: 'מה השם המלא של המזמין/ה?',
  email: 'מה כתובת האימייל לקבלת קישור המעקב וקוד האימות?',
  pickup_detail: 'פרטי גישה ואיש קשר באיסוף: קומה, דירה, שם וטלפון אם שונים משלכם. אם אין, כתבו אין.',
  dropoff_detail: 'פרטי גישה ואיש קשר במסירה: קומה, דירה, שם וטלפון אם שונים משלכם. אם אין, כתבו אין.',
  notes: 'תיאור קצר של הפריט והערות למשלוח (בלי מידע רגיש). אם אין, כתבו אין.',
};
const missing = (data) => FIELDS.find((field) => data[field] == null);
const activeField = state => state.editing_field || missing(state.data);
const command = (text) => text.trim().toLowerCase();
function schedulingPreference(state, text, now) {
  const pending = state.schedule_preference;
  const preference = pickupPreference(text, now, state.data.when_date || pending?.date);
  if (preference && preference.period === 'any' && pending?.date === null) {
    preference.period = pending.period;
    if (pending.hour != null) preference.hour = pending.hour;
  }
  return preference;
}
export const isBookingHandoff = (text) => localizedCommand(text)==='human' || /^(?:(?:can i |i want to |please )?(?:speak|talk) to (?:a )?(?:human|person|agent)|(?:please )?(?:human|stop|cancel)(?: please)?|(?:אני רוצה|אפשר) לדבר עם נציג)[.!?]?$/i.test(command(text)) || /^(?:(?:אני רוצה|אני צריך|אני צריכה|אפשר|בבקשה)\s+)?(נציג|אדם|עזרה|human|stop|עצור|ביטול)(?:\s+בבקשה)?[.!]?$/.test(command(text));
export function newBooking() { return { phase: 'consent', data: { service: 'standard', customer_type: 'private' }, revision: 0 }; }
export function bookingEnabled(env, now = Date.now()) {
  return bookingPilotReady(env, now) && env.WHATSAPP_BOOKING_STORAGE_READY === 'on'
    && env.WHATSAPP_BOOKING_ENABLED === 'on'
    && env.WHATSAPP_BOOKING_PRIVACY_APPROVED === 'on'
    && !!env.SESSION_SECRET
    && (env.WHATSAPP_BOOKING_PROVIDER === 'twilio' || (env.WHATSAPP_BOOKING_PROVIDER === 'meta' && !!env.WHATSAPP_PHONE_ID));
}

export function parseAddress(text) {
  const aliases = BOOKING_CITY_ALIASES;
  const input = normalizeBookingDigits(text).trim().replace(/\s+/g, ' ');
  const cityNames = [...GUSH_DAN, ...Object.keys(aliases)].sort((a,b)=>b.length-a.length);
  for (const city of cityNames) {
    if (!input.toLowerCase().startsWith(city.toLowerCase() + ' ') && !input.toLowerCase().startsWith(city.toLowerCase() + ',')) continue;
    const rest = input.slice(city.length).replace(/^[,\s]+/, '');
    const parts = /^(.{2,100}?)\s+(\d{1,5}[א-תa-z]?)$/iu.exec(rest);
    if (parts) return { delivery_street: parts[1], delivery_house_number: parts[2], delivery_city: aliases[city] || city, errors: [], corrections: [] };
  }
  const match = /^(.{2,100}?)\s+(\d{1,5}[א-תa-z]?)(?:\s*,\s*|\s+)(.{2,100})$/iu.exec(input);
  return match ? { delivery_street: match[1], delivery_house_number: match[2], delivery_city: aliases[match[3].toLowerCase()] || match[3], errors: [], corrections: [] } : null;
}

export function parseSchedule(text, now = Date.now()) {
  // Accept explicit Israeli day/month/year input as well as the canonical ISO
  // form. Never infer a missing year or discard nonzero minutes/time ranges.
  const input = normalizeBookingDigits(text).trim().replace(/\s+/g, ' ').replace(/^(\d{1,2})([/.])(\d{1,2})\2(\d{4})(?=\s)/,
    (_, day, separator, month, year) => `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`)
    .replace(/ (?:at|בשעה|ב-?|à|в|الساعة)\s*/i, ' ');
  const match = /^(\d{4}-\d{2}-\d{2})\s+(\d{1,2})(?::00)?$/.exec(input);
  if (!match) return null;
  const date = new Date(match[1] + 'T00:00:00Z');
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== match[1]) return null;
  const hour = Number(match[2]);
  const local = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Jerusalem', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23', minute: '2-digit' }).format(now);
  if (`${match[1]} ${String(hour).padStart(2, '0')}:00` <= local || date.getTime() > now + 30 * SESSION_WINDOW) return null;
  if (scheduleError('standard', date.getUTCDay(), hour)) return null;
  return { when_date: match[1], when_hour: hour, when_text: `${match[1]} ${String(hour).padStart(2, '0')}:00 · שעון ישראל` };
}

export async function resolveBookingAddress(text, env, { fetchImpl } = {}) {
  const row = parseAddress(text);
  if (!row) return { error: 'format' };
  if (!zoneOf(row.delivery_city)) return { error: 'out_of_zone' };
  await validateBusinessBatchAddresses([row], { apiKey: env.GOOGLE_PLACES_SERVER_KEY, fetchImpl, offerSuggestions: true });
  if (row.errors.length) return { error: row.errors[0], ...(row.address_candidates?.length ? { candidates: row.address_candidates.filter(candidate=>zoneOf(candidate.city)) } : {}) };
  if (!zoneOf(row.delivery_city)) return { error: 'out_of_zone' };
  return { address: row.delivery_address, city: row.delivery_city, lat: row.delivery_lat, lng: row.delivery_lng };
}

function orderInput(data, phone) {
  const { schedule, ...rest } = data;
  return { ...rest, phone: normalizeIlPhone(phone), package: data.size === 'small' ? 'רגיל · קטן' : 'רגיל · בינוני', phone_delivery_link_opt_in: false };
}
function displayAddress(data, key) {
  const city = data[key + '_city'];
  return city && !data[key].endsWith(city) ? `${data[key]}, ${city}` : data[key];
}
function summary(state, phone) {
  const d = state.data;
  const q = state.quote;
  if (['ar','ru','fr'].includes(state.language)) {
    const t=key=>localCopy(state.language,key);
    const values=[['Size',t(d.size)],['Pickup',displayAddress(d,'pickup')],['Pickup details',d.pickup_detail],['Delivery',displayAddress(d,'dropoff')],['Delivery details',d.dropoff_detail],['When',`${d.schedule} · ${t('Israel time')}`],['Name',d.name],['Phone',normalizeIlPhone(phone)],['Email',d.email],['Notes',d.notes],['Final price',`₪${q.price} (ILS)`]];
    if(q.discount_amount)values.push(['Discount',`₪${q.discount_amount}`]);
    return (state.conversation_only?pilotNotice(state.language)+'\n':'') + t('Standard private delivery summary')+'\n'+values.map(([key,value])=>`${t(key)}: ${value}`).join('\n')+'\n'+t('Valid for 10 minutes and checked again when you confirm.')+(state.conversation_only?'':'\n'+t('Confirmation accepts the terms, privacy and cancellation policies:')+'\nhttps://edenmish.com/terms.html\nhttps://edenmish.com/privacy.html\nhttps://edenmish.com/refund.html');
  }
  if (state.conversation_only) {
    const normal = summary({ ...state, conversation_only: false }, phone);
    const beforeTerms = normal.split(state.language === 'en' ? 'Confirmation accepts' : 'באישור אתם מאשרים')[0];
    return `${pilotNotice(state.language)}\n${beforeTerms}`;
  }
  if (state.language === 'en') return `Standard private delivery summary\nSize: ${d.size === 'small' ? 'small' : 'medium'}\nPickup: ${displayAddress(d, 'pickup')}\nPickup details: ${d.pickup_detail}\nDelivery: ${displayAddress(d, 'dropoff')}\nDelivery details: ${d.dropoff_detail}\nWhen: ${d.schedule} · Israel time\nName: ${d.name}\nPhone: ${normalizeIlPhone(phone)}\nEmail: ${d.email}\nNotes: ${d.notes}\nFinal price: ₪${q.price} (ILS)${q.discount_amount ? `, including ₪${q.discount_amount} discount` : ''}\nValid for 10 minutes and checked again when you confirm.\nConfirmation accepts the terms, privacy and cancellation policies:\nhttps://edenmish.com/terms.html\nhttps://edenmish.com/privacy.html\nhttps://edenmish.com/refund.html`;
  return `סיכום משלוח רגיל ללקוח פרטי\nגודל: ${d.size === 'small' ? 'קטן' : 'בינוני'}\nאיסוף: ${displayAddress(d, 'pickup')}\nפרטי איסוף: ${d.pickup_detail}\nמסירה: ${displayAddress(d, 'dropoff')}\nפרטי מסירה: ${d.dropoff_detail}\nמועד: ${d.when_text}\nשם: ${d.name}\nטלפון: ${normalizeIlPhone(phone)}\nאימייל: ${d.email}\nהערות: ${d.notes}\nמחיר סופי: ₪${q.price} (ILS)${q.discount_amount ? `, כולל הנחה ₪${q.discount_amount}` : ''}\nההצעה תקפה ל-10 דקות ונבדקת שוב באישור.\nבאישור אתם מאשרים את התקנון, הפרטיות והביטול:\nhttps://edenmish.com/terms.html\nhttps://edenmish.com/privacy.html\nhttps://edenmish.com/refund.html`;
}
async function advanceBookingCore(current, text, services, { phone, now = Date.now() } = {}) {
  const state = structuredClone(current);
  const c = command(text);
  if (state.phase === 'handoff') return { state, reply: null };
  if (isBookingHandoff(text)) {
    state.phase = 'handoff'; return { state, reply: bookingSay(state,HANDOFF,HANDOFF_EN) };
  }
  if (state.phase === 'consent') {
    if(state.multilingual && !/^(מתחילים|start)$/.test(c)){state.audio_disclosure_shown=true;return {state,reply:multilingualConsent(state.language)};}
    if (!/^(מתחילים|start)$/.test(c)) return { state, reply: bookingSay(state, 'היי, אני העוזר הדיגיטלי של EdenMish להזמנת משלוח רגיל ללקוח פרטי; נשמור פרטי הזמנה ונצטרך אימייל למעקב ולאימות.\nלהסכמה ולהתחלה כתבו מתחילים, או נציג לעזרה — בלי פרטי כרטיס, תעודות או מידע רגיש.\nפרטיות: https://edenmish.com/privacy.html', 'Hi, I’m the EdenMish digital assistant for standard private deliveries; email is needed for tracking and verification. To consent to collecting booking details, reply start — please never send card numbers or sensitive documents.\nPrivacy: https://edenmish.com/privacy.html\nAsk for a person: human') };
    state.phase = 'collect'; state.consent_at = now;
    if(state.multilingual && state.audio_disclosure_shown && state.menu?.kind==='consent')state.audio_consent_at=now;
    return { state, reply: QUESTIONS[missing(state.data)] };
  }
  // Do not persist or echo probable payment-card strings, even in free-text fields.
  if (hasSensitiveBookingText(text)) return { state, reply: 'אין לשלוח פרטי כרטיס או מספרי מסמכים. התשלום בקישור מאובטח בלבד.' };
  if (state.phase === 'booked') {
    if (/^(עריכה|edit)$/.test(c)) { state.phase = 'handoff'; return { state, reply: HANDOFF }; }
    const order = await services.order();
    if (order?.payment_status === 'paid') return { state, reply: bookingSay(state, 'התשלום אומת במערכת. פרטי המעקב וקוד האימות נשלחים באימייל. אישור תשלום אינו אישור איסוף או מסירה.', 'Payment is verified in the system; tracking and verification details are sent by email. This does not mean the item has been collected or delivered.') };
    if (order?.payment_status === 'link_sent' && order.payment_url) return { state, reply: state.language && state.language !== 'he' ? `${localCopy(state.language,'The order is awaiting payment through this existing secure link:')}\n${order.payment_url}\n${localCopy(state.language,'Payment will be verified by the system; ask for a person to change the order.')}` : `ההזמנה ממתינה לתשלום. הקישור המאובטח הקיים:\n${order.payment_url}\nאישור תשלום יתקבל רק לאחר אימות במערכת. לשינוי ההזמנה כתבו נציג.` };
    state.phase = 'handoff'; return { state, reply: HANDOFF };
  }
  if (state.phase === 'creating') { state.phase = 'handoff'; return { state, reply: HANDOFF }; }
  if (/^(עריכה|edit)$/.test(c)) {
    state.phase = 'collect'; state.quote = null; state.address_confirmed = false; state.edit_menu = true;
    delete state.editing_field; delete state.pending_address; delete state.terms_accepted_at;
    return { state, reply: bookingSay(state, 'מה תרצו לשנות?', 'What would you like to change?') };
  }
  if (state.phase === 'address_review' && (c === `כתובות ${state.revision}` || c === `addresses ${state.revision}`)) {
    state.address_confirmed = true;
  } else if (state.phase === 'review' && (c === `אישור ${state.revision}` || c === `confirm ${state.revision}`)) {
    const input = orderInput(state.data, phone);
    if (!parseSchedule(state.data.schedule, now)) {
      state.phase = 'collect'; delete state.data.schedule; state.quote = null;
      return { state, reply: QUESTIONS.schedule };
    }
    const quote = await services.quote(input);
    if (!quote || quote.review || !Number.isFinite(quote.price)) { state.phase = 'handoff'; return { state, reply: HANDOFF }; }
    if (now - state.quote.at >= QUOTE_TTL || JSON.stringify(quote) !== JSON.stringify(state.quote.value)) {
      state.revision++; state.quote = { ...quote, at: now, value: quote };
      return { state, reply: bookingSay(state, 'ההצעה עודכנה. נדרש אישור חדש.\n', 'The quote has been refreshed; please confirm the new summary.\n') + summary(state, phone) };
    }
    if (state.conversation_only) {
      state.phase = 'handoff'; delete state.terms_accepted_at;
      return { state, reply: pilotComplete(state.language) };
    }
    state.phase = 'creating'; state.terms_accepted_at = now;
    return { state, create: { input, expectedPrice: quote.price, quoteAt: state.quote.at }, reply: null };
  } else {
    const entries = text.split('\n').map((line) => {
      for (const [key, label] of Object.entries(LABELS)) {
        if (line.startsWith(label + ':')) return [key, line.slice(label.length + 1).trim()];
      }
      return null;
    });
    const labelled = entries.every(Boolean) && entries.length > 0;
    const field = activeField(state);
    const candidate = labelled ? null : extractBookingText(text, now);
    // Names, access details and notes are ordinary free-text answers. A size
    // adjective or a date inside them must not silently become another edit.
    const freeText = ['name', 'pickup_detail', 'dropoff_detail', 'notes'].includes(field);
    const explicitName = field === 'name' && /^(שמי|קוראים לי)\s/u.test(text.trim());
    const fullRoute = candidate?.entries?.some(([key]) => key === 'pickup');
    const natural = !freeText || explicitName || fullRoute ? candidate : null;
    if (natural?.clarification) {
      state.phase = 'collect'; state.quote = null; state.address_confirmed = false;
      delete state.terms_accepted_at;
      return { state, reply: natural.clarification };
    }
    const supplied = labelled ? entries : natural?.entries;
    if (!supplied && state.phase !== 'collect') return { state, reply: state.phase === 'review' ? summary(state, phone) : bookingSay(state, 'בדקו את הכתובות בסיכום ובחרו אפשרות.', 'Check the addresses in the summary and choose an option.') };
    if (!supplied && !field) return { state, reply: 'כתבו שם שדה ונקודתיים לשינוי, או נציג.' };
    const updates = supplied || [[field, text.trim()]];
    for (const [index, [key, value]] of updates.entries()) {
      // Any attempted edit invalidates consent to the old summary, even if the
      // replacement is invalid/ambiguous. Never let an old Confirm book old data.
      state.quote = null; state.phase = 'collect';
      delete state.terms_accepted_at;
      delete state.data[key];
      if (['pickup', 'dropoff'].includes(key)) {
        state.address_confirmed = false;
        for (const suffix of ['_city', '_lat', '_lng']) delete state.data[key + suffix];
      }
      if (!value || value.length > (['notes', 'pickup_detail', 'dropoff_detail'].includes(key) ? 300 : 254)) return { state, reply: (state.multilingual ? bookingSay(state,'הפרט חסר או ארוך מדי. ','That detail is missing or too long. ') + bookingQuestion(state,key) : 'הפרט חסר או ארוך מדי. ' + QUESTIONS[key]) };
      if (key === 'size') {
        if (!/^(קטן|קטנה|small|בינוני|בינונית|medium)$/.test(value)) return { state, reply: QUESTIONS.size };
        state.data.size = /^(קטן|קטנה|small)$/.test(value) ? 'small' : 'medium';
      } else if (key === 'email') {
        const validated = validateEmailAddress(value);
        if (!validated.valid) return { state, reply: (state.multilingual ? bookingSay(state,'כתובת האימייל אינה תקינה. ','That email address is invalid. ') + bookingQuestion(state,'email') : 'כתובת האימייל אינה תקינה. ' + QUESTIONS.email) };
        state.data.email = validated.email;
      } else if (key === 'schedule') {
        const preference = schedulingPreference(state, value, now);
        if (preference) {
          state.schedule_preference = preference; state.editing_field = 'schedule'; delete state.edit_menu;
          for (const key of ['when_date', 'when_hour', 'when_text']) delete state.data[key];
          continue;
        }
        const schedule = parseSchedule(value, now);
        if (!schedule) return { state, reply: (state.multilingual ? bookingSay(state,'המועד אינו זמין. בחרו מועד עתידי בשעות הפעילות, עד 30 יום קדימה. ','That time is unavailable. Choose a future time within service hours, up to 30 days ahead. ') + bookingQuestion(state,'schedule') : 'המועד אינו זמין. בחרו מועד עתידי בשעות הפעילות, עד 30 יום קדימה. ' + QUESTIONS.schedule) };
        Object.assign(state.data, schedule, { schedule: value });
        delete state.schedule_preference;
      } else if (['pickup', 'dropoff'].includes(key)) {
        const resolved = await services.resolveAddress(value);
        if (resolved.error && resolved.candidates?.length) {
          state.phase = 'address_choice'; state.pending_address = { field: key, candidates: resolved.candidates.slice(0,3), remaining: updates.slice(index + 1) };
          return { state, reply: bookingSay(state, 'מצאתי כתובות אפשריות. איזו נכונה?', 'I found possible addresses. Which is correct?') };
        }
        if (resolved.error === 'out_of_zone') { state.phase = 'handoff'; return { state, reply: bookingSay(state,'הכתובת מחוץ לאזור השירות האוטומטי. ','The address is outside the automatic service area. ') + bookingSay(state,HANDOFF,HANDOFF_EN) }; }
        if (resolved.error) return { state, reply: (state.multilingual ? bookingSay(state,'לא הצלחתי לזהות כתובת יחידה בוודאות. בדקו רחוב, מספר בית ועיר, או כתבו נציג.\n','I could not identify one address. Check the street, house number and city, or ask for a person.\n') + bookingQuestion(state,key) : 'לא הצלחתי לזהות כתובת יחידה בוודאות. בדקו רחוב, מספר בית ועיר, או כתבו נציג.\n' + QUESTIONS[key]) };
        Object.assign(state.data, { [key]: resolved.address, [key + '_city']: resolved.city, [key + '_lat']: resolved.lat, [key + '_lng']: resolved.lng });
        state.address_confirmed = false;
      } else {
        if (key === 'name' && value.length > 120) return { state, reply: QUESTIONS.name };
        state.data[key] = value;
      }
      if (state.editing_field === key) delete state.editing_field;
      delete state.edit_menu;
      state.quote = null; state.phase = 'collect';
    }
  }
  return continueBookingCollection(state, services, { phone, now });
}

async function continueBookingCollection(state, services, { phone, now = Date.now() }) {
  const field = activeField(state);
  if (field) return { state, reply: QUESTIONS[field] };
  if (!state.address_confirmed) {
    state.phase = 'address_review'; state.revision++;
    return { state, reply: state.language && state.language !== 'he' ? `${localCopy(state.language,'Please check the addresses:')}\n${localCopy(state.language,'Pickup')}: ${displayAddress(state.data, 'pickup')}\n${localCopy(state.language,'Delivery')}: ${displayAddress(state.data, 'dropoff')}` : `זיהיתי את הכתובות:\nאיסוף: ${displayAddress(state.data, 'pickup')}\nמסירה: ${displayAddress(state.data, 'dropoff')}` };
  }
  const quote = await services.quote(orderInput(state.data, phone));
  if (!quote || quote.review || !Number.isFinite(quote.price)) { state.phase = 'handoff'; return { state, reply: HANDOFF }; }
  state.phase = 'review'; state.revision++; state.quote = { ...quote, at: now, value: quote };
  return { state, reply: summary(state, phone) };
}

function nextBookingPrompt(state) {
  const field = activeField(state);
  if (field) return bookingQuestion(state, field);
  if (state.phase === 'address_review') return bookingSay(state, 'בדקו את הכתובות שמופיעות למעלה.', 'Please check the addresses shown above.');
  if (state.phase === 'review') return bookingSay(state, 'בדקו את הפרטים והמחיר בסיכום.', 'Please check the details and price in the summary.');
  return bookingSay(state, 'איזה פרט לשנות? אפשר לכתוב שם שדה ונקודתיים, או נציג.', 'Which detail should change? Use a field label, or ask for a person.');
}
const literalAnswer = (state, text) => {
  if (state.phase !== 'collect') return false;
  const field = activeField(state); const value = text.trim();
  return (field === 'size' && /^(קטן|קטנה|בינוני|בינונית|small|medium)$/i.test(value))
    || (field === 'email' && validateEmailAddress(value).valid)
    || (field === 'schedule' && /^\d{4}-\d{2}-\d{2}\s+\d{1,2}(?::00)?$/.test(value))
    || (['pickup_detail', 'dropoff_detail', 'notes'].includes(field) && /^(אין|none)$/i.test(value));
};
const modelBypass = (state, text) => literalAnswer(state, text) || !['collect', 'address_review', 'review'].includes(state.phase)
  || isBookingHandoff(text) || /^(?:עריכה|edit|(?:אישור|כתובות|confirm|addresses)\s+\d+)$/i.test(text.trim())
  || text.split('\n').every(line => Object.values(LABELS).some(label => line.startsWith(label + ':')));

// Interpretation is optional and separately gated; canonical validation stays here.
async function advanceBookingInternal(current, text, services, options = {}) {
  const state = structuredClone(current);
  if(!state.multilingual)state.language = bookingLanguage(state.language, text);
  const now = options.now ?? Date.now();
  if (hasSensitiveBookingText(text) && state.phase !== 'handoff') return { state, reply: bookingSay(state,
    'אין לשלוח פרטי כרטיס, מספרי מסמכים או סודות. התשלום בקישור מאובטח בלבד.',
    'Please do not send card numbers, documents or secrets. Payment uses the secure link only.') };
  if (state.phase === 'address_choice' && !isBookingHandoff(text) && !/^(edit|עריכה)$/i.test(text.trim())) return { state, reply: bookingSay(state, 'בחרו את מספר הכתובת המתאימה, או בקשו נציג.', 'Choose the matching address number, or ask for a person.') };
  if (['collect', 'address_review', 'review'].includes(state.phase)
    && /\b(?:business account|use (?:my |the )?wallet|pay (?:with|from) (?:my |the )?wallet|another order|multiple orders|flash delivery)\b|חשבון עסקי|ארנק עסקי|הזמנה נוספת|שתי הזמנות/u.test(text.toLowerCase())) {
    state.phase = 'handoff';
    return { state, reply: bookingSay(state, HANDOFF, HANDOFF_EN) };
  }
  if ((isBookingLanguageRequest(text) || state.multilingual && explicitLanguage(text)) && ['collect', 'address_review', 'review'].includes(state.phase)) return { state, reply: bookingSay(state, 'בשמחה. ', 'Happy to help. ') + nextBookingPrompt(state) };
  // Dayparts are requests for suggestions, never permission to choose a slot.
  const preference = schedulingPreference(state, text, now);
  if (preference && ['collect', 'address_review', 'review'].includes(state.phase)) {
    state.phase = 'collect'; state.quote = null; state.editing_field = 'schedule'; state.schedule_preference = preference;
    delete state.terms_accepted_at; delete state.edit_menu; delete state.data.schedule;
    for (const key of ['when_date', 'when_hour', 'when_text']) delete state.data[key];
    return { state, reply: bookingSay(state, 'בשמחה — בחרו מועד שמתאים לכם.', 'Of course — choose a time that suits you.') };
  }
  // Without a model, questions must not be stored as a name or delivery note.
  // Only reviewed business facts are answered; unrelated questions get a redirect.
  if (!services.conversationModel && ['collect', 'address_review', 'review'].includes(state.phase)
    && /[?？]|^(?:who|what|why|how|where|when|can you|could you|tell me|write me|explain|מי|מה|למה|איך|כמה|איפה|האם|מתי|ספר לי|תכתוב לי)\b|^(?:מי|מה|למה|איך|כמה|איפה|האם|מתי|ספר לי|תכתוב לי)\s/iu.test(text.trim())) {
    const topic = /מחיר|עלות|price|cost|pricing/i.test(text) ? 'pricing' : /שעות|hours/i.test(text) ? 'hours'
      : /תשלום|payment|pay\b/i.test(text) ? 'payment' : /מעקב|tracking/i.test(text) ? 'tracking' : /פרטיות|privacy/i.test(text) ? 'privacy' : null;
    const answer = topic ? bookingFact(state, topic) : bookingSay(state, 'אני כאן לעזור במשלוחי EdenMish. נמשיך עם פרטי המשלוח.', 'I’m here to help with EdenMish deliveries. Let’s continue with your booking.');
    return { state, reply: answer + ' ' + nextBookingPrompt(state) };
  }
  let result; let interpretation = null;
  if (!modelBypass(state, text)) {
    const proposal = await proposeBookingTurn(services.conversationModel, state, text, now);
    if (proposal) {
      interpretation = 'model_proposal';
      if(state.multilingual && proposal.replyStyle)state.reply_style=proposal.replyStyle;
      if(state.multilingual && !state.language_explicit && proposal.replyLanguage)state.language=proposal.replyLanguage;
      if (['handoff', 'other_order', 'unsupported'].includes(proposal.intent)) {
        state.phase = 'handoff';
        return { state, interpretation, reply: bookingSay(state, HANDOFF, HANDOFF_EN) };
      }
      if (proposal.intent === 'clarify') {
        state.phase = 'collect'; state.quote = null; state.address_confirmed = false;
        delete state.terms_accepted_at; delete state.data[proposal.clarifyField];
        state.editing_field = proposal.clarifyField;
        if (['pickup', 'dropoff'].includes(proposal.clarifyField)) for (const suffix of ['_city', '_lat', '_lng']) delete state.data[proposal.clarifyField + suffix];
        if (proposal.clarifyField === 'schedule') for (const key of ['when_date', 'when_hour', 'when_text']) delete state.data[key];
        return { state, interpretation, reply: bookingSay(state, 'כדי לדייק, ', 'To make sure, ') + bookingQuestion(state, proposal.clarifyField, {single:true}) };
      }
      if (['question', 'greeting', 'off_topic'].includes(proposal.intent)) {
        const intro = proposal.intent === 'question' ? bookingFact(state, proposal.topic)
          : proposal.intent === 'off_topic' ? bookingSay(state, 'אני כאן לעזור בהזמנת משלוח.', 'I’m here to help with your delivery booking.')
          : state.multilingual ? conversationalLead(state).trim() : bookingSay(state, 'בשמחה.', 'Happy to help.');
        return { state, interpretation, reply: (intro ? intro + ' ' : '') + nextBookingPrompt(state) };
      }
      if (proposal.intent === 'update') {
        // Only verified source quotes become field input. They cannot contain
        // newlines/commands; the core resolves addresses and rechecks every value.
        result = await advanceBookingCore(state, proposal.entries.map(([key, value]) => `${LABELS[key]}: ${value}`).join('\n'), services, options);
        if (proposal.topic && result.state.phase === 'collect') {
          const question = Object.entries(QUESTIONS).find(([, copy]) => result.reply === copy)?.[0];
          result.reply = bookingFact(state, proposal.topic) + ' ' + (question ? bookingQuestion(result.state, question) : result.reply);
        }
      }
    } else if (services.conversationModel) {
      interpretation = 'model_fallback';
      const wasReview = ['review', 'address_review'].includes(state.phase);
      if (['review', 'address_review'].includes(state.phase)) {
        state.phase = 'collect'; state.quote = null; state.address_confirmed = false; delete state.terms_accepted_at;
      }
      // A failed model must not store a service question as the customer's name
      // or notes. Keep the draft and ask for the next missing detail or a person.
      if (wasReview || /[?？]|^(?:למה|כמה|איך|why|how|what|change|actually|instead|בעצם|תשנה|תשני|שינוי|טעיתי)\s/iu.test(text.trim())) return { state, interpretation, reply: bookingSay(state, 'לא בטוח שהבנתי; אפשר לנסח שוב או לבקש נציג.', 'I’m not sure I understood; please rephrase or ask for a person.') + ' ' + nextBookingPrompt(state) };
    }
  }
  result ||= await advanceBookingCore(state, text, services, options);
  const question = Object.entries(QUESTIONS).find(([, copy]) => result.reply === copy)?.[0];
  if (question && (state.multilingual || services.conversationModel || state.language && state.language !== 'he')) result.reply = bookingQuestion(result.state, question);
  if (state.language && state.language !== 'he' && result.reply && result.state.phase === 'collect' && /[א-ת]/u.test(result.reply)) result.reply = localCopy(state.language,'Please check that detail. ') + nextBookingPrompt(result.state);
  if (state.language === 'en' && result.reply && result.state.phase === 'address_review' && /^(לאישור)/u.test(result.reply)) result.reply = nextBookingPrompt(result.state);
  if (result.state.phase === 'handoff' && result.reply && state.language && state.language !== 'he' && result.reply !== pilotComplete(state.language)) result.reply = localCopy(state.language,HANDOFF_EN);
  if (interpretation) result.interpretation = interpretation;
  return result;
}

export async function advanceBooking(current, text, services, options = {}) {
  const state = structuredClone(current);
  const now = options.now ?? Date.now();
  if(services.multilingual || state.multilingual) {
    state.multilingual=true;
    state.bundle_route=!!services.conversationModel;
    selectBookingLanguage(state,text);
    // Preserve source evidence for the model. Only closed menu commands normalize.
    const normalized=localizedCommand(text);
    if(normalized==='human' || ['consent','review','address_review'].includes(state.phase)
      || normalized==='edit' || /^\d{1,2}$/.test(normalized)
      || activeField(state)==='size' && ['small','medium'].includes(normalized)
      || ['pickup_detail','dropoff_detail','notes'].includes(activeField(state)) && normalized==='none')text=normalized;
  }
  if(state.audio_consent_pending && options.inputKind!=='voice' && text.trim()==='1') {
    state.audio_consent_at=now;delete state.audio_consent_pending;
    return withBookingMenu({state,reply:bookingQuestion(state,activeField(state)||'notes')},now);
  }
  if(state.audio_consent_pending && options.inputKind!=='voice')delete state.audio_consent_pending;
  if (options.conversationOnly) state.conversation_only = true;
  if (state.conversation_only && ['creating', 'booked'].includes(state.phase)) {
    state.phase = 'handoff';
    return { state, reply: pilotComplete(state.language) };
  }
  // A number is an action only when that exact menu was presented for this
  // phase/revision. Confirmation still passes through quote revalidation and
  // the durable event/order idempotency path; the interpreter cannot confirm.
  const menu = state.menu;
  const currentMenu = menu && menu.phase===state.phase && menu.revision===state.revision;
  const answer=text.trim().replace(/[.!]$/, '').trim().toLowerCase();
  const reviewMenu=currentMenu && ['review','address_review'].includes(menu.kind);
  // Public menu numbers are not quote revision tokens. Mixed commands can
  // contradict the displayed choice, so never forward them to legacy parsing.
  if (['review','address_review'].includes(state.phase)
    && /^(?:(?:אישור|כתובות|confirm|addresses|מאשר|מאשרת|כן|ok|okay)\s+\d+|\d+\s+(?:אישור|כתובות|confirm|addresses|מאשר|מאשרת|כן|ok|okay))$/u.test(answer)) {
    return withBookingMenu({state,reply:bookingSay(state,
      'לא ברור אם התכוונתם לאשר או לבחור פעולה אחרת. בחרו אפשרות אחת לפי התפריט, בלי לשלב מילה ומספר.',
      'It is unclear whether you want to confirm or choose another action. Please choose one option from the menu without combining a word and number.')},now);
  }

  const confirmation=reviewMenu && /^(?:k|ok|okay|conf|confirm|כן|אוקיי|מאשר|מאשרת|אני מאשר|אני מאשרת|אישור|הכל נכון)$/.test(answer);
  if(options.inputKind==='voice' && reviewMenu && (confirmation || text.trim()==='1'))return withBookingMenu({state,reply:bookingSay(state,
    'שמעתי אישור. כדי לאשר, שלחו את מספר האפשרות המוצגת בהודעת טקסט.',
    'I heard a confirmation. Please confirm using the displayed number in a text message.')},now);
  const modification=reviewMenu && /^(?:edit|modify|change|עריכה|שינוי|שינוי פרטים|לשנות|אני רוצה לשנות|אני רוצה לערוך)$/.test(answer);
  let choice=confirmation?1:modification?2:/^\d{1,2}$/.test(text.trim())?Number(text.trim()):null;
  // Written options are shortcuts only for the displayed, current post-consent
  // menu. Never infer consent or select an address/time from an unscoped 'ok'.
  if(currentMenu && state.consent_at && choice===null && menu.kind!=='consent') {
    const ordinals=[/^(?:(?:האפשרות|אפשרות) )?(?:הראשון|הראשונה|ראשון|ראשונה|first)(?: option)?$/,
      /^(?:(?:האפשרות|אפשרות) )?(?:השני|השנייה|השניה|שני|שנייה|שניה|second)(?: option)?$/,
      /^(?:(?:האפשרות|אפשרות) )?(?:השלישי|השלישית|שלישי|שלישית|third)(?: option)?$/];
    const ordinal=ordinals.findIndex(pattern=>pattern.test(answer));
    if(ordinal>=0)choice=ordinal+1;
    else if(/^אפשרות \d{1,2}$/.test(answer))choice=Number(answer.split(' ')[1]);
    else if(menu.kind==='edit') {
      const field=FIELDS.find(key=>[LABELS[key],key].includes(answer));
      if(field)choice=FIELDS.indexOf(field)+1;
    }
  }
  if (menu && menu.phase === state.phase && menu.revision === state.revision && choice != null) {
    if (menu.kind === 'review' || menu.kind === 'address_review') {
      text = ({ 1: `${menu.kind === 'review' ? 'confirm' : 'addresses'} ${menu.revision}`, 2: 'edit', 3: 'human' })[choice] || text;
    } else if (menu.kind === 'consent') text = ({ 1: 'start', 2: 'human' })[choice] || text;
    else if (menu.kind === 'size' && activeField(state) === 'size') text = ({ 1: 'small', 2: 'medium', 3: 'human' })[choice] || text;
    else if (menu.kind === 'schedule_day' && activeField(state) === 'schedule') text = ({1:'today',2:'tomorrow',3:'human'})[choice] || text;
    else if (menu.kind === 'schedule' && activeField(state) === 'schedule') text = menu.slots?.[choice - 1] || (choice === 4 ? 'human' : text);
    else if (menu.kind === 'address_choice' && state.pending_address) {
      const {field,candidates,remaining=[]} = state.pending_address;
      const selected = candidates[choice-1];
      if (selected) {
        Object.assign(state.data, { [field]:selected.address, [field+'_city']:selected.city, [field+'_lat']:selected.lat, [field+'_lng']:selected.lng });
        state.phase='collect'; state.quote=null; state.address_confirmed=false;
        delete state.pending_address;
        if (state.editing_field === field) delete state.editing_field;
        const result = remaining.length
          ? await advanceBookingCore(state, remaining.map(([key,value]) => `${LABELS[key]}: ${value}`).join('\n'), services, {...options,now})
          : await continueBookingCollection(state,services,{...options,now});
        return withBookingMenu(result,now);
      }
      if (choice===candidates.length+1) text='human';
    }
    else if (menu.kind === 'edit' && state.edit_menu) {
      if (choice === 10) text = 'human';
      else if (FIELDS[choice - 1]) {
        state.editing_field = FIELDS[choice - 1]; delete state.edit_menu;
        return withBookingMenu({ state, reply: bookingQuestion(state, state.editing_field) }, now);
      }
    }
  }
  const result = await advanceBookingInternal(state, text, services, options);
  if (state.conversation_only && result.state.phase === 'consent' && result.reply) result.reply = pilotNotice(result.state.language) + '\n' + result.reply;
  return withBookingMenu(result, now);
}

export function withBookingMenu(result, now) {
  const state = result.state;
  delete state.menu;
  if (!result.reply || ['handoff', 'creating', 'booked', 'closed'].includes(state.phase)) return result;
  let kind = state.phase, copy, slots;
  const say = (he, en) => bookingSay(state, he, en);
  if (['review', 'address_review'].includes(kind)) {
    copy = say('1. אישור\n2. שינוי פרטים\n3. נציג', '1. Confirm\n2. Modify details\n3. Human help');
    if (kind === 'review' && state.conversation_only) copy = say('1. אישור לסיום הבדיקה\n2. שינוי פרטים\n3. נציג', '1. Confirm and finish test\n2. Modify details\n3. Human help');
  } else if (kind === 'address_choice' && state.pending_address) {
    copy = state.pending_address.candidates.map((candidate,i)=>`${i+1}. ${candidate.address}`).join('\n')
      + `\n${state.pending_address.candidates.length+1}. ` + say('נציג','Human help');
  } else if (kind === 'consent') copy = say('1. מסכימ/ה, מתחילים\n2. נציג', '1. I agree, start\n2. Human help');
  else if (kind === 'collect' && state.edit_menu) {
    kind = 'edit';
    const en = ['Item size', 'Pickup address', 'Delivery address', 'Pickup time', 'Name', 'Email', 'Pickup details', 'Delivery details', 'Notes'];
    copy = FIELDS.map((field, i) => `${i + 1}. ${say(LABELS[field], en[i])}`).join('\n') + '\n10. ' + say('נציג', 'Human help');
  } else if (kind === 'collect' && activeField(state) === 'size') {
    kind = 'size'; copy = say('1. קטן\n2. בינוני\n3. נציג', '1. Small\n2. Medium\n3. Human help');
  } else if (kind === 'collect' && activeField(state) === 'schedule' && state.schedule_preference?.date === null) {
    kind = 'schedule_day';
    result.reply = say('באיזה יום תרצו איסוף? אפשר לבחור או לכתוב תאריך אחר.', 'Which day would you like pickup? Choose below or type another date.');
    copy = say('1. היום\n2. מחר\n3. נציג', '1. Today\n2. Tomorrow\n3. Human help');
  } else if (kind === 'collect' && activeField(state) === 'schedule') {
    kind = 'schedule';
    const suggestions = pickupSlotChoices(state.schedule_preference || { date: israelDay(now), period: 'any' }, now);
    slots = suggestions.slots;
    copy = say('אפשר לבחור שעה מוצעת (שעון ישראל), או לכתוב מועד אחר:', 'Choose a suggested time (Israel time), or type another date and time:') + '\n'
      + slots.map((slot, i) => `${i + 1}. ${slot}`).join('\n') + '\n4. ' + say('נציג', 'Human help');
    if (suggestions.alternateDay) copy = say('לא נשאר חלון מתאים ביום שביקשתם. הנה היום המתאים הבא:\n', 'No suitable window remains on the requested day. Here is the next suitable day:\n') + copy;
  }
  if (copy) {
    state.menu = { kind, phase: state.phase, revision: state.revision, ...(slots ? { slots } : {}) };
    result.reply += '\n\n' + copy + (state.multilingual && state.reply_style === 'brief' && !['review','address_review','consent'].includes(kind) ? '' : '\n' + say('אפשר להשיב במספר.', 'You can reply with the number.'));
  }
  return result;
}
