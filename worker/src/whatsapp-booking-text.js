// Deliberately bounded Hebrew extraction. No model call, address invention,
// implicit date/time choice, consent, confirmation or payment authority.
import { GUSH_DAN } from './pricing.js';
const cities = [...GUSH_DAN].sort((a, b) => b.length - a.length).join('|');
const address = `([א-תA-Za-z'׳״" .-]{2,70}?\\s+\\d{1,5}[א-תa-z]?)\\s*,?\\s*(${cities})(?![א-ת])`;
const clarification = 'לא הצלחתי להבין את כל הפרטים בוודאות. כתבו פרטים מדויקים בלי חלופות, למשל: חבילה קטנה מדיזנגוף 10, תל אביב לביאליק 2, רמת גן מחר בשעה 11. אפשר גם שם שדה ונקודתיים, או נציג.';

export function extractBookingText(text, now) {
  // Accept the complete source item phrase, not just its size adjective. Anchor
  // the whole phrase so negation, alternatives and weight limits are not lost.
  const sizedItem = /^(?:(?:אני (?:צריך|צריכה|רוצה) לשלוח|לשלוח)\s+)?((?:מעטפה|חבילה|קופסה)\s+(קטנה|בינונית)|פריט\s+(קטן|בינוני))[.!]?$/u.exec(text.trim());
  if (sizedItem) return { entries: [['size', /^(?:קטן|קטנה)$/u.test(sizedItem[2] || sizedItem[3]) ? 'small' : 'medium'], ['notes', sizedItem[1]]] };
  // Keep each route span intact for the shared map resolver. Recipient is a
  // delivery contact, never silently substituted for the booking customer's name.
  const englishRoute = /^from\s+(.+?\d[א-תa-z]?)\s+to\s+(.+?\d[א-תa-z]?)(?:\s+(?:to|for)\s+([a-z][a-z '-]{0,79}))?[.!]?$/i.exec(text.trim());
  if (englishRoute) return { entries: [['pickup', englishRoute[1]], ['dropoff', englishRoute[2]], ...(englishRoute[3] ? [['dropoff_detail', `Recipient: ${englishRoute[3]}`]] : [])] };
  // Narrow item inference; mixed/large/heavy descriptions require clarification.
  // These proposed fields are still shown in the final confirmation summary.
  if (/^(?:(?:i (?:need|want) to send|send)\s+)?(?:(?:my|an?|the)\s+)?(?:keys?|envelop(?:e)?s?)(?:\s+(?:and|or)\s+(?:(?:my|an?|the)\s+)?(?:keys?|envelop(?:e)?s?))*[.!]?$/i.test(text.trim())
    || /^(?:(?:אני (?:צריך|צריכה|רוצה) לשלוח|לשלוח)\s+)?(?:מפתחות|מפתח|מעטפה|מעטפות)(?:\s+שלי)?[.!]?$/u.test(text.trim())) return { entries: [['size', 'small'], ['notes', text.trim()]] };
  let remaining = text.trim().replace(/^משלוח\s+(?=מ[א-ת])/u, '');
  const entries = [];
  let ambiguous = false;
  const take = (pattern, callback) => {
    remaining = remaining.replace(pattern, (...args) => { callback(args); return ' '; });
  };
  const put = (key, value) => {
    if (entries.some(([existing]) => existing === key)) ambiguous = true;
    else entries.push([key, value]);
  };
  take(/(?:^|[\s,])(?:חבילה\s+|פריט\s+|משלוח\s+)?(קטן|קטנה|בינוני(?:ת)?|small|medium)(?=$|[\s,.])/giu, (m) => put('size', m[1].toLowerCase()));
  // Capture explicit route roles together; both addresses still go through the
  // authoritative resolver and a separate customer address confirmation.
  take(new RegExp(`(?:^|\\s)מ${address}\\s+(?:אל\\s+|ל)${address}`, 'gu'), (m) => {
    put('pickup', `${m[1].trim()}, ${m[2]}`);
    put('dropoff', `${m[3].trim()}, ${m[4]}`);
  });

  take(/(?:היום|מחר|\d{4}-\d{2}-\d{2})\s+(?:בשעה\s+|ב-?)?(\d{1,2})(?::(\d{2}))?(?=$|[\s,.])/gu, (m) => {
    const day = /^(היום|מחר|\d{4}-\d{2}-\d{2})/.exec(m[0])[0];
    let date = day;
    if (day === 'היום' || day === 'מחר') {
      const localDay = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Jerusalem', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
      date = new Date(Date.parse(localDay + 'T00:00:00Z') + (day === 'מחר' ? 86400000 : 0)).toISOString().slice(0, 10);
    }
    put('schedule', `${date} ${m[1].padStart(2, '0')}:${m[2] || '00'}`);
  });
  take(/(?:האימייל\s+שלי\s+|אימייל\s+)?[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu, (m) => put('email', m[0].replace(/^(האימייל\s+שלי\s+|אימייל\s+)/u, '')));
  take(/(?:שמי|קוראים לי)\s+([א-תA-Za-z][א-תA-Za-z'׳-]+(?:\s+[א-תA-Za-z][א-תA-Za-z'׳-]+){0,2})(?=$|[,.;\n])/gu, (m) => {
    if (/(?:^|\s)(?:משלוח|חבילה|דחוף|עסקי|ארנק|איסוף|מסירה|מחר|היום|לא|או)(?:\s|$)/u.test(m[1])) ambiguous = true;
    put('name', m[1].trim());
  });
  if (!entries.length) return /^(?:שמי|קוראים לי|חבילה|משלוח|אני רוצה לשלוח|אני צריך לשלוח|אני צריכה לשלוח|מחר|היום)(?:\s|$)/u.test(text.trim()) ? { clarification } : null;
  // Consume only harmless connective wording. Unrecognized instructions,
  // negation, alternatives, weights or vague times require clarification rather
  // than silently discarding a condition that could change the service/price.
  remaining = remaining.replace(/(?:^|\s)(?:שלום|היי|תודה|בבקשה|אני רוצה לשלוח|אני צריך לשלוח|אני צריכה לשלוח|רוצה לשלוח|צריך לשלוח|צריכה לשלוח)(?=$|[\s,.!])/gu, ' ')
    .replace(/[\s,.;!]+/g, '');
  if (remaining || ambiguous) return { clarification };
  return { entries };
}
