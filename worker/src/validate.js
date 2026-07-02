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
