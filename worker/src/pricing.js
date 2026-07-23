// Pricing engine — FINAL_PRICING_SPEC (zone-based matrix + service level + surcharges).
//
// Model:
//   OrderZone = max(zoneOf(pickup_city), zoneOf(dropoff_city))   // 1=Core, 2=Inner, 3=Outer
//   base   = MATRIX[service][zone]                                // Eco / Standard / Flash
//   +₪15  if size === 'medium' (shoe box / ≤5kg)
//   +₪30  if evening pickup (19:00–22:00)
//   ×1.5  on Saturday (Friday remains a regular work day)
//   Flash is unavailable in Zone 3 (SLA guardrail) → review.
//
// "מחיר סופי" — the computed price is the final price the customer pays (no per-km
// estimate). Defaults match FINAL_PRICING_SPEC; every value is overridable from the
// `pricing_rules` D1 table so the business can tune without a code change.

export const ZONE_CITIES = {
  1: ['תל אביב', 'תל אביב-יפו', 'תל אביב יפו', 'רמת גן', 'גבעתיים', 'בני ברק'],
  2: ['הרצליה', 'רמת השרון', 'חולון', 'בת ים', 'קריית אונו', 'קרית אונו', 'גבעת שמואל', 'אזור', 'גני תקווה', 'סביון', 'אור יהודה'],
  3: ['ראשון לציון', 'כפר סבא', 'רעננה', 'פתח תקווה', 'הוד השרון', 'רמלה', 'לוד']
};

// Allowed service area = union of all zones (replaces the old GUSH_DAN list).
export const GUSH_DAN = Object.values(ZONE_CITIES).flat();

export const DEFAULT_PRICING_RULES = {
  eco_z1: 35, eco_z2: 55, eco_z3: 75,
  std_z1: 50, std_z2: 70, std_z3: 115,
  flash_z1: 85, flash_z2: 110, // flash_z3 intentionally absent (N/A)
  sur_medium: 15,
  sur_evening: 30,
  weekend_mult: 1.5,
  // Extra-stop fee for re-serving a package after a failed delivery (a return to the
  // pickup point, or a redelivery to a corrected address). A re-attempt is ONE leg, not
  // the pickup+dropoff pair the matrix above prices, so these are anchored at half the
  // standard base per zone rather than one flat amount — a Zone 3 retry costs materially
  // more to serve than a Zone 1 one.
  retry_z1: 25, retry_z2: 35, retry_z3: 60
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
  return day === 6; // Saturday only (Friday is a regular work day in Israel)
}

export function priceOrder(o, rules) {
  const R = { ...DEFAULT_PRICING_RULES, ...(rules || {}) };
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

  const mediumSurcharge = size === 'medium' ? num(R.sur_medium, 15) : 0;
  price += mediumSurcharge;
  const hour = num(o && o.when_hour, -1);
  const eveningSurcharge = hour >= 19 && hour < 22 ? num(R.sur_evening, 30) : 0;
  price += eveningSurcharge;
  const weekendMultiplier = isWeekend(o && o.when_date) ? num(R.weekend_mult, 1.5) : 1;
  const beforeWeekend = price;
  price = Math.round(price * weekendMultiplier);
  const weekendSurcharge = price - beforeWeekend;

  return {
    price, zone, service, size, base, review: reasons.length > 0, reasons,
    breakdown: {
      base,
      medium_surcharge: mediumSurcharge,
      evening_surcharge: eveningSurcharge,
      weekend_multiplier: weekendMultiplier,
      weekend_surcharge: weekendSurcharge,
      total: price,
    },
  };
}

// Suggested extra-stop fee for re-serving a package after a failed delivery.
//
// This is a SUGGESTION for the operator, never an automatic charge. Whether to charge at
// all is a fault judgement a formula cannot make: `incorrect_address` does not say whether
// the customer or our own geocoding produced the bad address, and our defects (and any
// unsafe-access call by the driver) should be waived. Ops decides; this only removes the
// arithmetic and the zone guesswork.
//
// Pass the cities of the leg actually being served:
//   - return to origin  → dropoff_city = the original pickup city
//   - redelivery        → dropoff_city = the corrected destination city
// Zone is recomputed with the same max() rule as priceOrder, so pushing a package further
// out costs more than bringing it home.
//
// Deliberately unlike priceOrder: the medium-size surcharge does NOT re-apply (same
// package, already paid for once), and the result is capped at a full standard delivery for
// the zone — a retry must never cost more than simply booking again.
export function retryFee(o, rules) {
  const R = { ...DEFAULT_PRICING_RULES, ...(rules || {}) };
  const num = (v, d) => { const n = Number(v); return Number.isFinite(n) ? n : d; };

  const reasons = [];
  const pz = zoneOf(o && o.pickup_city);
  const dz = zoneOf(o && o.dropoff_city);
  if (pz == null && dz == null) reasons.push('out_of_zone');
  const zone = (pz || dz) ? Math.max(pz || 0, dz || 0) : null;
  if (zone == null) {
    return { fee: null, zone: null, base: null, capped: false, review: true, reasons };
  }

  const base = num(R['retry_z' + zone], null);
  if (base == null) {
    reasons.push('retry_rate_missing');
    return { fee: null, zone, base: null, capped: false, review: true, reasons };
  }

  const hour = num(o && o.when_hour, -1);
  const eveningSurcharge = hour >= 19 && hour < 22 ? num(R.sur_evening, 30) : 0;
  const weekendMultiplier = isWeekend(o && o.when_date) ? num(R.weekend_mult, 1.5) : 1;

  const uncapped = Math.round(base * weekendMultiplier) + eveningSurcharge;
  const ceiling = num(R['std_z' + zone], null);
  const capped = ceiling != null && uncapped > ceiling;
  const fee = capped ? ceiling : uncapped;

  return {
    fee,
    zone,
    base,
    capped,
    review: reasons.length > 0,
    reasons,
    breakdown: {
      base,
      evening_surcharge: eveningSurcharge,
      weekend_multiplier: weekendMultiplier,
      cap: ceiling,
      total: fee,
    },
  };
}

// Kept for backward compatibility (unused by the zone model).
export function haversineKm() { return null; }
