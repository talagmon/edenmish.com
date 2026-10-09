// Suggestions only. Selection and final confirmation still use canonical checks.
import { scheduleError } from './validate.js';
export function israelDay(now) {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Jerusalem', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}
export function pickupPreference(text, now, knownDate = null) {
  const value = text.trim().toLowerCase().replace(/\s+/g, ' ');
  const daypart = /^(?:in the )?(morning|afternoon|evening|בבוקר|בצהריים|אחר הצהריים|בערב)$/.exec(value);
  if (daypart) {
    const period = /morning|בבוקר/.test(daypart[1]) ? 'morning' : /afternoon|צהריים/.test(daypart[1]) ? 'afternoon' : 'evening';
    // Preserve an explicitly supplied date; a missing date remains a question.
    const suppliedDate = knownDate && pickupPreference(knownDate, now);
    return { date: suppliedDate?.date || null, period };
  }
  const m = /^(today|tomorrow|tommorrow|היום|מחר|\d{4}-\d{2}-\d{2}|\d{1,2}[/.]\d{1,2}[/.]\d{4})(?:\s+(?:in the\s+)?(morning|afternoon|evening|בבוקר|בצהריים|אחר הצהריים|בערב))?$/.exec(value);
  if (!m) return null;
  let date = m[1];
  if (/^(today|tomorrow|tommorrow|היום|מחר)$/.test(date)) date = new Date(Date.parse(israelDay(now) + 'T00:00:00Z') + (/^(today|היום)$/.test(date) ? 0 : 86400000)).toISOString().slice(0, 10);
  else date = date.replace(/^(\d{1,2})([/.])(\d{1,2})\2(\d{4})$/, (_, d, s, mo, y) => `${y}-${mo.padStart(2,'0')}-${d.padStart(2,'0')}`);
  const stamp = Date.parse(date + 'T00:00:00Z');
  if (!Number.isFinite(stamp) || new Date(stamp).toISOString().slice(0,10) !== date || date < israelDay(now) || stamp > now + 30*86400000) return null;
  const period = /morning|בבוקר/.test(m[2] || '') ? 'morning' : /afternoon|צהריים/.test(m[2] || '') ? 'afternoon' : /evening|בערב/.test(m[2] || '') ? 'evening' : 'any';
  return { date, period };
}
export function pickupSlotChoices(preference, now) {
  if (!preference?.date) return { slots: [], alternateDay: false };
  const today = israelDay(now);
  const localTime = new Intl.DateTimeFormat('en-GB', { timeZone:'Asia/Jerusalem', hour:'2-digit', minute:'2-digit', hourCycle:'h23' }).format(now);
  const [hour, minute] = localTime.split(':').map(Number);
  // Match the website's three-hour same-day lead and future pickup window.
  const earliest = Math.ceil((hour*60 + minute + 180)/60);
  const slots = [];
  const start = Date.parse(preference.date + 'T00:00:00Z');
  for (let offset=0; offset<8 && !slots.length; offset++) {
    const date = new Date(start + offset*86400000).toISOString().slice(0,10);
    if (date < today || Date.parse(date+'T00:00:00Z') > now + 30*86400000) continue;
    const day = new Date(date+'T00:00:00Z').getUTCDay();
    const close = day === 5 ? 13 : 20;
    for (let h=0; h<24 && slots.length<3; h++) {
      if (scheduleError('standard',day,h) || (date===today && h<earliest) || (date!==today && h+3>close)) continue;
      if (preference.period==='morning' && h>=12 || preference.period==='afternoon' && (h<12 || h>=17) || preference.period==='evening' && h<17) continue;
      slots.push(`${date} ${String(h).padStart(2,'0')}:00`);
    }
  }
  return { slots, alternateDay: slots.length>0 && !slots[0].startsWith(preference.date) };
}
