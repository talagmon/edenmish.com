// Pricing engine — FINAL_PRICING_SPEC (zone-based matrix + service level + surcharges).
//
// Model:
//   OrderZone = max(zoneOf(pickup_city), zoneOf(dropoff_city))   // 1=Core, 2=Inner, 3=Outer
//   base   = MATRIX[service][zone]                                // Eco / Standard / Flash
//   +₪15  if size === 'medium' (shoe box / ≤5kg)
//   +₪30  if evening pickup (19:00–22:00)
//   ×1.5  if weekend (Friday / Saturday)
//   Flash is unavailable in Zone 3 (SLA guardrail) → review.
//
// "מחיר סופי" — the computed price is the final price the customer pays (no per-km
// estimate). Defaults match FINAL_PRICING_SPEC; every value is overridable from the
// `pricing_rules` D1 table so the business can tune without a code change.

const ZONE_CITIES = {
  1: ['תל אביב', 'תל אביב-יפו', 'תל אביב יפו', 'רמת גן', 'גבעתיים', 'בני ברק'],
  2: ['הרצליה', 'רמת השרון', 'חולון', 'בת ים', 'קריית אונו', 'קרית אונו', 'גבעת שמואל', 'אזור', 'גני תקווה', 'סביון', 'אור יהודה'],
  3: ['ראשון לציון', 'כפר סבא', 'רעננה', 'פתח תקווה', 'הוד השרון', 'רמלה', 'לוד']
};

// Allowed service area = union of all zones (replaces the old GUSH_DAN list).
export const GUSH_DAN = Object.values(ZONE_CITIES).flat();

const DEFAULTS = {
  eco_z1: 35, eco_z2: 55, eco_z3: 75,
  std_z1: 50, std_z2: 70, std_z3: 115,
  flash_z1: 85, flash_z2: 110, // flash_z3 intentionally absent (N/A)
  sur_medium: 15,
  sur_evening: 30,
  weekend_mult: 1.5
};

export function zoneOf(city) {
  const c = String(city == null ? '' : city).trim();
  for (const z of [1, 2, 3]) if (ZONE_CITIES[z].includes(c)) return z;
  return null;
}

function isWeekend(yyyymmdd) {
  if (!yyyymmdd) return false;
  const m = String(yyyymmdd).match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (!m) return false;
  const day = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).getUTCDay(); // 5=Fri, 6=Sat
  return day === 5 || day === 6;
}

export function priceOrder(o, rules) {
  const R = { ...DEFAULTS, ...(rules || {}) };
  const num = (v, d) => { const n = Number(v); return Number.isFinite(n) ? n : d; };

  const reasons = [];
  const pz = zoneOf(o && o.pickup_city);
  const dz = zoneOf(o && o.dropoff_city);
  if (pz == null || dz == null) reasons.push('out_of_zone');
  const zone = (pz && dz) ? Math.max(pz, dz) : null;

  const service = String((o && o.service) || 'standard').toLowerCase();
  const size = String((o && o.size) || 'small').toLowerCase();

  let base = null;
  if (zone) {
    if (service === 'eco') base = num(R['eco_z' + zone], null);
    else if (service === 'flash') base = zone === 3 ? null : num(R['flash_z' + zone], null);
    else base = num(R['std_z' + zone], 50);
  }
  if (service === 'flash' && zone === 3) reasons.push('flash_unavailable_z3');

  // Always quote something (fallback Zone-1 Standard) so a reviewable order still
  // carries a sane price; the review flags above describe why it needs a human.
  let price = base != null ? base : num(R.std_z1, 50);

  if (size === 'medium') price += num(R.sur_medium, 15);
  const hour = num(o && o.when_hour, -1);
  if (hour >= 19 && hour < 22) price += num(R.sur_evening, 30);
  price = isWeekend(o && o.when_date) ? Math.round(price * num(R.weekend_mult, 1.5)) : Math.round(price);

  return { price, zone, service, size, base, review: reasons.length > 0, reasons };
}

// Kept for backward compatibility (unused by the zone model).
export function haversineKm() { return null; }
