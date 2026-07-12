// Input validation helpers for the public order API.
// Single source of truth for phone handling — the funnel only carries a soft
// HTML pattern; anything stored or forwarded to Shopify goes through here.

// Israeli phone → E.164 ('+972XXXXXXXXX') or null if it can't be a valid IL number.
// Accepts local ('05X-XXXXXXX', '0X-XXXXXXX') and international ('+972…', '972…',
// '00972…') forms with any spacing/dashes/parentheses.
export function normalizeIlPhone(raw) {
  if (raw == null) return null;
  let digits = String(raw).replace(/\D/g, '');
  if (!digits) return null;
  if (digits.startsWith('00972')) digits = digits.slice(5);
  else if (digits.startsWith('972')) digits = digits.slice(3);
  else if (digits.startsWith('0')) digits = digits.slice(1);
  else return null;
  if (digits.startsWith('0')) digits = digits.slice(1); // '9720XX…' form
  // Landlines are 8 digits after the leading 0, mobiles 9 — and never start with 0.
  if (!/^[1-9]\d{7,8}$/.test(digits)) return null;
  return '+972' + digits;
}

// Israeli identity-number checksum. Input is normalized to nine digits.
export function validIsraeliId(raw) {
  const value = String(raw == null ? '' : raw).trim();
  if (!value || /[^\d\s.-]/.test(value)) return false;
  const normalized = value.replace(/\D/g, '');
  if (!normalized || normalized.length > 9) return false;
  const digits = normalized.padStart(9, '0');
  if (/^0{9}$/.test(digits)) return false;
  const sum = digits.split('').reduce((total, digit, index) => {
    let value = Number(digit) * (index % 2 === 0 ? 1 : 2);
    if (value > 9) value -= 9;
    return total + value;
  }, 0);
  return sum % 10 === 0;
}

// Authoritative pickup-hours gate for public orders. The storefront uses the
// same hours to present choices, but callers must not be able to bypass them.
export function scheduleError(service, day, hour) {
  if (day === 6) return 'closed_saturday';
  const hours = day === 5 ? { start: 8, end: 13 } : { start: 9, end: 20 };
  const end = service === 'eco' ? Math.min(hours.end, 13) : hours.end;
  if (hour < hours.start || hour >= end) return 'outside_hours';
  return null;
}
