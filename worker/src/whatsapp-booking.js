// Transport-independent booking authority. Optional bounded interpretation proposes
// fields only; validation, confirmation and state transitions remain deterministic.
import { proposeBookingTurn, hasSensitiveBookingText } from './whatsapp-booking-model.js';
import { bookingLanguage, bookingSay, bookingQuestion, bookingFact, isBookingLanguageRequest, HANDOFF_EN } from './whatsapp-booking-copy.js';
import { extractBookingText } from './whatsapp-booking-text.js';
import { normalizeIlPhone, scheduleError } from './validate.js';
import { validateEmailAddress } from './email-validation.js';
import { zoneOf } from './pricing.js';
import { validateBusinessBatchAddresses } from './business-address.js';

export const QUOTE_TTL = 10 * 60 * 1000;
export const SESSION_WINDOW = 24 * 60 * 60 * 1000;
export const HANDOFF = 'הבקשה הועברה לטיפול אנושי. האוטומציה נעצרה. אין לשלוח פרטי כרטיס או מסמכים רגישים.';
const FIELDS = ['size', 'pickup', 'dropoff', 'schedule', 'name', 'email', 'pickup_detail', 'dropoff_detail', 'notes'];
const LABELS = { size: 'גודל', pickup: 'איסוף', dropoff: 'מסירה', schedule: 'מועד', name: 'שם', email: 'אימייל', pickup_detail: 'פרטי איסוף', dropoff_detail: 'פרטי מסירה', notes: 'הערות' };
const QUESTIONS = {
  size: 'מה גודל הפריט? קטן (מעטפה או פריט קטן) או בינוני (עד קופסת נעליים ועד 5 ק״ג). השירות כאן הוא משלוח רגיל ללקוח פרטי. בקשה אחרת? כתבו נציג.',
  pickup: 'מה כתובת האיסוף? רחוב ומספר בית, עיר. לדוגמה: דיזנגוף 10, תל אביב',
  dropoff: 'מה כתובת המסירה? רחוב ומספר בית, עיר.',
  schedule: 'מתי לאסוף? כתבו תאריך ושעה מדויקים, למשל 2026-10-11 11:00 (שעון ישראל).',
  name: 'מה השם המלא של המזמין/ה?',
  email: 'מה כתובת האימייל לקבלת קישור המעקב וקוד האימות?',
  pickup_detail: 'פרטי גישה ואיש קשר באיסוף: קומה, דירה, שם וטלפון אם שונים משלכם. אם אין, כתבו אין.',
  dropoff_detail: 'פרטי גישה ואיש קשר במסירה: קומה, דירה, שם וטלפון אם שונים משלכם. אם אין, כתבו אין.',
  notes: 'תיאור קצר של הפריט והערות למשלוח (בלי מידע רגיש). אם אין, כתבו אין.',
};
const missing = (data) => FIELDS.find((field) => data[field] == null);
const command = (text) => text.trim().toLowerCase();
export const isBookingHandoff = (text) => /^(?:(?:can i |i want to |please )?(?:speak|talk) to (?:a )?(?:human|person|agent)|(?:please )?(?:human|stop|cancel)(?: please)?|(?:אני רוצה|אפשר) לדבר עם נציג)[.!?]?$/i.test(command(text)) || /^(?:(?:אני רוצה|אני צריך|אני צריכה|אפשר|בבקשה)\s+)?(נציג|אדם|עזרה|human|stop|עצור|ביטול)(?:\s+בבקשה)?[.!]?$/.test(command(text));
export function newBooking() { return { phase: 'consent', data: { service: 'standard', customer_type: 'private' }, revision: 0 }; }
export function bookingEnabled(env) {
  return env.WHATSAPP_BOOKING_STORAGE_READY === 'on'
    && env.WHATSAPP_BOOKING_ENABLED === 'on'
    && env.WHATSAPP_BOOKING_PRIVACY_APPROVED === 'on'
    && !!env.SESSION_SECRET
    && (env.WHATSAPP_BOOKING_PROVIDER === 'twilio' || (env.WHATSAPP_BOOKING_PROVIDER === 'meta' && !!env.WHATSAPP_PHONE_ID));
}

export function parseAddress(text) {
  const match = /^(.{2,100}?)\s+(\d{1,5}[א-תa-z]?)\s*,\s*(.{2,100})$/iu.exec(text.trim());
  return match ? { delivery_street: match[1], delivery_house_number: match[2], delivery_city: match[3], errors: [], corrections: [] } : null;
}

export function parseSchedule(text, now = Date.now()) {
  const match = /^(\d{4}-\d{2}-\d{2})\s+(\d{1,2})(?::00)?$/.exec(text.trim());
  if (!match) return null;
  const date = new Date(match[1] + 'T00:00:00Z');
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== match[1]) return null;
  const hour = Number(match[2]);
  const local = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Jerusalem', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23', minute: '2-digit' }).format(now);
  if (`${match[1]} ${String(hour).padStart(2, '0')}:00` <= local || date.getTime() > now + 30 * SESSION_WINDOW) return null;
  if (scheduleError('standard', date.getUTCDay(), hour)) return null;
  return { when_date: match[1], when_hour: hour, when_text: `${match[1]} ${String(hour).padStart(2, '0')}:00 · שעון ישראל` };
}

export async function resolveBookingAddress(text, env) {
  const row = parseAddress(text);
  if (!row) return { error: 'format' };
  if (!zoneOf(row.delivery_city)) return { error: 'out_of_zone' };
  await validateBusinessBatchAddresses([row], { apiKey: env.GOOGLE_PLACES_SERVER_KEY });
  if (row.errors.length) return { error: row.errors[0] };
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
  if (state.language === 'en') return `Standard private delivery summary\nSize: ${d.size === 'small' ? 'small' : 'medium'}\nPickup: ${displayAddress(d, 'pickup')}\nPickup details: ${d.pickup_detail}\nDelivery: ${displayAddress(d, 'dropoff')}\nDelivery details: ${d.dropoff_detail}\nWhen: ${d.schedule} · Israel time\nName: ${d.name}\nPhone: ${normalizeIlPhone(phone)}\nEmail: ${d.email}\nNotes: ${d.notes}\nFinal price: ₪${q.price} (ILS)${q.discount_amount ? `, including ₪${q.discount_amount} discount` : ''}\nValid for 10 minutes and checked again when you confirm.\nConfirmation accepts the terms, privacy and cancellation policies:\nhttps://edenmish.com/terms.html\nhttps://edenmish.com/privacy.html\nhttps://edenmish.com/refund.html\nConfirm: confirm ${state.revision}\nChange: edit\nAsk for a person: human`;
  return `סיכום משלוח רגיל ללקוח פרטי\nגודל: ${d.size === 'small' ? 'קטן' : 'בינוני'}\nאיסוף: ${displayAddress(d, 'pickup')}\nפרטי איסוף: ${d.pickup_detail}\nמסירה: ${displayAddress(d, 'dropoff')}\nפרטי מסירה: ${d.dropoff_detail}\nמועד: ${d.when_text}\nשם: ${d.name}\nטלפון: ${normalizeIlPhone(phone)}\nאימייל: ${d.email}\nהערות: ${d.notes}\nמחיר סופי: ₪${q.price} (ILS)${q.discount_amount ? `, כולל הנחה ₪${q.discount_amount}` : ''}\nההצעה תקפה ל-10 דקות ונבדקת שוב באישור.\nבאישור אתם מאשרים את התקנון, הפרטיות והביטול:\nhttps://edenmish.com/terms.html\nhttps://edenmish.com/privacy.html\nhttps://edenmish.com/refund.html\nלאישור כתבו: אישור ${state.revision}\nלשינוי: עריכה\nלטיפול אנושי: נציג`;
}
async function advanceBookingCore(current, text, services, { phone, now = Date.now() } = {}) {
  const state = structuredClone(current);
  const c = command(text);
  if (state.phase === 'handoff') return { state, reply: null };
  if (isBookingHandoff(text)) {
    state.phase = 'handoff'; return { state, reply: HANDOFF };
  }
  if (state.phase === 'consent') {
    if (!/^(מתחילים|start)$/.test(c)) return { state, reply: bookingSay(state, 'היי, אני העוזר הדיגיטלי של EdenMish להזמנת משלוח רגיל ללקוח פרטי; נשמור פרטי הזמנה ונצטרך אימייל למעקב ולאימות.\nלהסכמה ולהתחלה כתבו מתחילים, או נציג לעזרה — בלי פרטי כרטיס, תעודות או מידע רגיש.\nפרטיות: https://edenmish.com/privacy.html', 'Hi, I’m the EdenMish digital assistant for standard private deliveries; email is needed for tracking and verification. To consent to collecting booking details, reply start — please never send card numbers or sensitive documents.\nPrivacy: https://edenmish.com/privacy.html\nAsk for a person: human') };
    state.phase = 'collect'; state.consent_at = now;
    return { state, reply: QUESTIONS[missing(state.data)] };
  }
  // Do not persist or echo probable payment-card strings, even in free-text fields.
  if (hasSensitiveBookingText(text)) return { state, reply: 'אין לשלוח פרטי כרטיס או מספרי מסמכים. התשלום בקישור מאובטח בלבד.' };
  if (state.phase === 'booked') {
    if (/^(עריכה|edit)$/.test(c)) { state.phase = 'handoff'; return { state, reply: HANDOFF }; }
    const order = await services.order();
    if (order?.payment_status === 'paid') return { state, reply: bookingSay(state, 'התשלום אומת במערכת. פרטי המעקב וקוד האימות נשלחים באימייל. אישור תשלום אינו אישור איסוף או מסירה.', 'Payment is verified in the system; tracking and verification details are sent by email. This does not mean the item has been collected or delivered.') };
    if (order?.payment_status === 'link_sent' && order.payment_url) return { state, reply: state.language === 'en' ? `The order is awaiting payment through this existing secure link:\n${order.payment_url}\nPayment will be verified by the system; ask for a person to change the order.` : `ההזמנה ממתינה לתשלום. הקישור המאובטח הקיים:\n${order.payment_url}\nאישור תשלום יתקבל רק לאחר אימות במערכת. לשינוי ההזמנה כתבו נציג.` };
    state.phase = 'handoff'; return { state, reply: HANDOFF };
  }
  if (state.phase === 'creating') { state.phase = 'handoff'; return { state, reply: HANDOFF }; }
  if (/^(עריכה|edit)$/.test(c)) {
    state.phase = 'collect'; state.quote = null; state.address_confirmed = false;
    return { state, reply: `מה לשנות? כתבו שם שדה ונקודתיים, למשל איסוף: דיזנגוף 10, תל אביב\nשדות: ${Object.values(LABELS).join(', ')}` };
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
    const field = missing(state.data);
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
    if (!supplied && state.phase !== 'collect') return { state, reply: state.phase === 'review' ? summary(state, phone) : `לאישור הכתובות כתבו כתובות ${state.revision}, לשינוי כתבו עריכה, או נציג.` };
    if (!supplied && !field) return { state, reply: 'כתבו שם שדה ונקודתיים לשינוי, או נציג.' };
    for (const [key, value] of supplied || [[field, text.trim()]]) {
      // Any attempted edit invalidates consent to the old summary, even if the
      // replacement is invalid/ambiguous. Never let an old Confirm book old data.
      state.quote = null; state.phase = 'collect';
      delete state.terms_accepted_at;
      delete state.data[key];
      if (['pickup', 'dropoff'].includes(key)) {
        state.address_confirmed = false;
        for (const suffix of ['_city', '_lat', '_lng']) delete state.data[key + suffix];
      }
      if (!value || value.length > (['notes', 'pickup_detail', 'dropoff_detail'].includes(key) ? 300 : 254)) return { state, reply: 'הפרט חסר או ארוך מדי. ' + QUESTIONS[key] };
      if (key === 'size') {
        if (!/^(קטן|קטנה|small|בינוני|בינונית|medium)$/.test(value)) return { state, reply: QUESTIONS.size };
        state.data.size = /^(קטן|קטנה|small)$/.test(value) ? 'small' : 'medium';
      } else if (key === 'email') {
        const validated = validateEmailAddress(value);
        if (!validated.valid) return { state, reply: 'כתובת האימייל אינה תקינה. ' + QUESTIONS.email };
        state.data.email = validated.email;
      } else if (key === 'schedule') {
        const schedule = parseSchedule(value, now);
        if (!schedule) return { state, reply: 'המועד אינו זמין. בחרו מועד עתידי בשעות הפעילות, עד 30 יום קדימה. ' + QUESTIONS.schedule };
        Object.assign(state.data, schedule, { schedule: value });
      } else if (['pickup', 'dropoff'].includes(key)) {
        const resolved = await services.resolveAddress(value);
        if (resolved.error === 'out_of_zone') { state.phase = 'handoff'; return { state, reply: 'הכתובת מחוץ לאזור השירות האוטומטי. ' + HANDOFF }; }
        if (resolved.error) return { state, reply: 'לא הצלחתי לזהות כתובת יחידה בוודאות. בדקו רחוב, מספר בית ועיר, או כתבו נציג.\n' + QUESTIONS[key] };
        Object.assign(state.data, { [key]: resolved.address, [key + '_city']: resolved.city, [key + '_lat']: resolved.lat, [key + '_lng']: resolved.lng });
        state.address_confirmed = false;
      } else {
        if (key === 'name' && value.length > 120) return { state, reply: QUESTIONS.name };
        state.data[key] = value;
      }
      state.quote = null; state.phase = 'collect';
    }
  }
  const field = missing(state.data);
  if (field) return { state, reply: QUESTIONS[field] };
  if (!state.address_confirmed) {
    state.phase = 'address_review'; state.revision++;
    return { state, reply: state.language === 'en' ? `Please check the addresses:\nPickup: ${displayAddress(state.data, 'pickup')}\nDelivery: ${displayAddress(state.data, 'dropoff')}\nReply addresses ${state.revision} to confirm, edit to change, or human.` : `זיהיתי את הכתובות:\nאיסוף: ${displayAddress(state.data, 'pickup')}\nמסירה: ${displayAddress(state.data, 'dropoff')}\nלאישור כתבו כתובות ${state.revision}. לשינוי כתבו עריכה או נציג.` };
  }
  const quote = await services.quote(orderInput(state.data, phone));
  if (!quote || quote.review || !Number.isFinite(quote.price)) { state.phase = 'handoff'; return { state, reply: HANDOFF }; }
  state.phase = 'review'; state.revision++; state.quote = { ...quote, at: now, value: quote };
  return { state, reply: summary(state, phone) };
}

function nextBookingPrompt(state) {
  const field = missing(state.data);
  if (field) return bookingQuestion(state, field);
  if (state.phase === 'address_review') return bookingSay(state, `לאישור הכתובות כתבו כתובות ${state.revision}, או עריכה לשינוי.`, `Reply addresses ${state.revision} to confirm the addresses, or edit to change them.`);
  if (state.phase === 'review') return bookingSay(state, `לאישור הסיכום כתבו אישור ${state.revision}, או עריכה לשינוי.`, `Reply confirm ${state.revision} to accept the summary, or edit to change it.`);
  return bookingSay(state, 'איזה פרט לשנות? אפשר לכתוב שם שדה ונקודתיים, או נציג.', 'Which detail should change? Use a field label, or ask for a person.');
}
const literalAnswer = (state, text) => {
  if (state.phase !== 'collect') return false;
  const field = missing(state.data); const value = text.trim();
  return (field === 'size' && /^(קטן|קטנה|בינוני|בינונית|small|medium)$/i.test(value))
    || (field === 'email' && validateEmailAddress(value).valid)
    || (field === 'schedule' && /^\d{4}-\d{2}-\d{2}\s+\d{1,2}(?::00)?$/.test(value))
    || (['pickup_detail', 'dropoff_detail', 'notes'].includes(field) && /^(אין|none)$/i.test(value));
};
const modelBypass = (state, text) => literalAnswer(state, text) || !['collect', 'address_review', 'review'].includes(state.phase)
  || isBookingHandoff(text) || /^(?:עריכה|edit|(?:אישור|כתובות|confirm|addresses)\s+\d+)$/i.test(text.trim())
  || text.split('\n').every(line => Object.values(LABELS).some(label => line.startsWith(label + ':')));

// Interpretation is optional and separately gated; canonical validation stays here.
export async function advanceBooking(current, text, services, options = {}) {
  const state = structuredClone(current);
  state.language = bookingLanguage(state.language, text);
  const now = options.now ?? Date.now();
  if (hasSensitiveBookingText(text) && state.phase !== 'handoff') return { state, reply: bookingSay(state,
    'אין לשלוח פרטי כרטיס, מספרי מסמכים או סודות. התשלום בקישור מאובטח בלבד.',
    'Please do not send card numbers, documents or secrets. Payment uses the secure link only.') };
  if (isBookingLanguageRequest(text) && ['collect', 'address_review', 'review'].includes(state.phase)) return { state, reply: bookingSay(state, 'בשמחה. ', 'Happy to help. ') + nextBookingPrompt(state) };
  let result; let interpretation = null;
  if (!modelBypass(state, text)) {
    const proposal = await proposeBookingTurn(services.conversationModel, state, text, now);
    if (proposal) {
      interpretation = 'model_proposal';
      if (['handoff', 'other_order', 'unsupported'].includes(proposal.intent)) {
        state.phase = 'handoff';
        return { state, interpretation, reply: bookingSay(state, HANDOFF, HANDOFF_EN) };
      }
      if (proposal.intent === 'clarify') {
        state.phase = 'collect'; state.quote = null; state.address_confirmed = false;
        delete state.terms_accepted_at; delete state.data[proposal.clarifyField];
        if (['pickup', 'dropoff'].includes(proposal.clarifyField)) for (const suffix of ['_city', '_lat', '_lng']) delete state.data[proposal.clarifyField + suffix];
        if (proposal.clarifyField === 'schedule') for (const key of ['when_date', 'when_hour', 'when_text']) delete state.data[key];
        return { state, interpretation, reply: bookingSay(state, 'כדי לדייק, ', 'To make sure, ') + bookingQuestion(state, proposal.clarifyField) };
      }
      if (['question', 'greeting', 'off_topic'].includes(proposal.intent)) {
        const intro = proposal.intent === 'question' ? bookingFact(state, proposal.topic)
          : proposal.intent === 'off_topic' ? bookingSay(state, 'אני כאן לעזור בהזמנת משלוח.', 'I’m here to help with your delivery booking.')
          : bookingSay(state, 'בשמחה.', 'Happy to help.');
        return { state, interpretation, reply: intro + ' ' + nextBookingPrompt(state) };
      }
      if (proposal.intent === 'update') {
        // Only verified evidence spans become field input. They cannot contain
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
  if (question && (services.conversationModel || state.language === 'en')) result.reply = bookingQuestion(result.state, question);
  if (state.language === 'en' && result.reply && result.state.phase === 'collect' && /[א-ת]/u.test(result.reply)) result.reply = 'Please check that detail. ' + nextBookingPrompt(result.state);
  if (state.language === 'en' && result.reply && result.state.phase === 'address_review' && /^(לאישור)/u.test(result.reply)) result.reply = nextBookingPrompt(result.state);
  if (result.state.phase === 'handoff' && result.reply && state.language === 'en') result.reply = HANDOFF_EN;
  if (interpretation) result.interpretation = interpretation;
  return result;
}
