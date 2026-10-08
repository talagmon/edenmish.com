// Bounded, transport-independent private booking conversation. No LLM, chat log,
// payment assertion, wallet authorization, or provider side effects live here.
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
function summary(state, phone) {
  const d = state.data;
  const q = state.quote;
  return `סיכום משלוח רגיל ללקוח פרטי\nגודל: ${d.size === 'small' ? 'קטן' : 'בינוני'}\nאיסוף: ${d.pickup}\nפרטי איסוף: ${d.pickup_detail}\nמסירה: ${d.dropoff}\nפרטי מסירה: ${d.dropoff_detail}\nמועד: ${d.when_text}\nשם: ${d.name}\nטלפון: ${normalizeIlPhone(phone)}\nאימייל: ${d.email}\nהערות: ${d.notes}\nמחיר סופי: ₪${q.price} (ILS)${q.discount_amount ? `, כולל הנחה ₪${q.discount_amount}` : ''}\nההצעה תקפה ל-10 דקות ונבדקת שוב באישור.\nבאישור אתם מאשרים את התקנון, הפרטיות והביטול:\nhttps://edenmish.com/terms.html\nhttps://edenmish.com/privacy.html\nhttps://edenmish.com/refund.html\nלאישור כתבו: אישור ${state.revision}\nלשינוי: עריכה\nלטיפול אנושי: נציג`;
}
export async function advanceBooking(current, text, services, { phone, now = Date.now() } = {}) {
  const state = structuredClone(current);
  const c = command(text);
  if (state.phase === 'handoff') return { state, reply: null };
  if (/^(נציג|אדם|עזרה|human|stop|עצור|ביטול)$/.test(c)) {
    state.phase = 'handoff'; return { state, reply: HANDOFF };
  }
  if (state.phase === 'consent') {
    if (!/^(מתחילים|start)$/.test(c)) return { state, reply: 'אפשר להזמין כאן משלוח רגיל ללקוח פרטי. נשמור פרטי הזמנה לצורך השירות. אימייל נדרש למעקב ולאימות. אין לשלוח פרטי כרטיס, תעודות או מידע רגיש. מדיניות פרטיות: https://edenmish.com/privacy.html\nלהתחלה והסכמה לאיסוף פרטי ההזמנה כתבו מתחילים. אפשר לכתוב נציג בכל שלב.' };
    state.phase = 'collect'; state.consent_at = now;
    return { state, reply: QUESTIONS[missing(state.data)] };
  }
  // Do not persist or echo probable payment-card strings, even in free-text fields.
  if (/(?:\d[ -]?){13,19}/.test(text)) return { state, reply: 'אין לשלוח פרטי כרטיס או מספרי מסמכים. התשלום בקישור מאובטח בלבד.' };
  if (state.phase === 'booked') {
    if (/^(עריכה|edit)$/.test(c)) { state.phase = 'handoff'; return { state, reply: HANDOFF }; }
    const order = await services.order();
    if (order?.payment_status === 'paid') return { state, reply: 'התשלום אומת במערכת. פרטי המעקב וקוד האימות נשלחים באימייל. אישור תשלום אינו אישור איסוף או מסירה.' };
    if (order?.payment_status === 'link_sent' && order.payment_url) return { state, reply: `ההזמנה ממתינה לתשלום. הקישור המאובטח הקיים:\n${order.payment_url}\nאישור תשלום יתקבל רק לאחר אימות במערכת. לשינוי ההזמנה כתבו נציג.` };
    state.phase = 'handoff'; return { state, reply: HANDOFF };
  }
  if (state.phase === 'creating') { state.phase = 'handoff'; return { state, reply: HANDOFF }; }
  if (/^(עריכה|edit)$/.test(c)) {
    state.phase = 'collect'; state.quote = null; state.address_confirmed = false;
    return { state, reply: `מה לשנות? כתבו שם שדה ונקודתיים, למשל איסוף: דיזנגוף 10, תל אביב\nשדות: ${Object.values(LABELS).join(', ')}` };
  }
  if (state.phase === 'address_review' && c === `כתובות ${state.revision}`) {
    state.address_confirmed = true;
  } else if (state.phase === 'review' && c === `אישור ${state.revision}`) {
    const input = orderInput(state.data, phone);
    if (!parseSchedule(state.data.schedule, now)) {
      state.phase = 'collect'; delete state.data.schedule; state.quote = null;
      return { state, reply: QUESTIONS.schedule };
    }
    const quote = await services.quote(input);
    if (!quote || quote.review || !Number.isFinite(quote.price)) { state.phase = 'handoff'; return { state, reply: HANDOFF }; }
    if (now - state.quote.at >= QUOTE_TTL || JSON.stringify(quote) !== JSON.stringify(state.quote.value)) {
      state.revision++; state.quote = { ...quote, at: now, value: quote };
      return { state, reply: 'ההצעה עודכנה. נדרש אישור חדש.\n' + summary(state, phone) };
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
    if (!labelled && state.phase !== 'collect') return { state, reply: state.phase === 'review' ? summary(state, phone) : `לאישור הכתובות כתבו כתובות ${state.revision}, לשינוי כתבו עריכה, או נציג.` };
    const field = missing(state.data);
    if (!labelled && !field) return { state, reply: 'כתבו שם שדה ונקודתיים לשינוי, או נציג.' };
    for (const [key, value] of labelled ? entries : [[field, text.trim()]]) {
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
    return { state, reply: `זיהיתי את הכתובות:\nאיסוף: ${state.data.pickup}\nמסירה: ${state.data.dropoff}\nלאישור כתבו כתובות ${state.revision}. לשינוי כתבו עריכה או נציג.` };
  }
  const quote = await services.quote(orderInput(state.data, phone));
  if (!quote || quote.review || !Number.isFinite(quote.price)) { state.phase = 'handoff'; return { state, reply: HANDOFF }; }
  state.phase = 'review'; state.revision++; state.quote = { ...quote, at: now, value: quote };
  return { state, reply: summary(state, phone) };
}
