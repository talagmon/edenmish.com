// Automatic pricing + exception detection

const GUSH_DAN = new Set([
  'תל אביב', 'תל אביב-יפו', 'תל אביב יפו', 'רמת גן', 'גבעתיים', 'בני ברק',
  'הרצליה', 'רמת השרון', 'הוד השרון', 'קריית אונו', 'גבעת שמואל', 'אור יהודה',
  'בת ים', 'חולון', 'ראשון לציון', 'כפר סבא', 'רעננה', 'פתח תקווה', 'אזור',
  'קרית אונו', 'גני תקווה', 'סביון', 'רמת השרון', 'רמלה', 'לוד'
]);

const PACKAGE_BASE = {
  'מעטפה/מסמך': 'base_envelope',
  'פריט קטן': 'base_item',
  'קופסה (עד גודל נעל)': 'base_box'
};

// Tolerance for GPS/rounding noise when comparing the client-declared driving
// distance against the straight-line distance between the submitted coordinates.
const DISTANCE_SLACK_KM = 0.3;
const EARTH_RADIUS_KM = 6371;

export function haversineKm(lat1, lng1, lat2, lng2) {
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(lat2 - lat1);
  const dLng = rad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(a));
}

export function priceOrder(o, rules) {
  const R = rules || {};
  const base = R[PACKAGE_BASE[o.package]] || R.base_item || 69;
  const perKm = R.per_km ?? 4;
  const includedKm = R.included_km ?? 3;
  const urgentPct = R.urgent_pct ?? 25;
  const maxKm = R.max_km ?? 25;
  const threshold = R.price_threshold ?? 200;

  const reasons = [];
  const inZone = (c) => !c || GUSH_DAN.has(String(c).trim());
  if (!inZone(o.pickup_city) || !inZone(o.dropoff_city)) reasons.push('out_of_zone');
  const km = Number(o.distance_km) || 0;
  if (!o.pickup_lat || !o.dropoff_lat) reasons.push('unclear_address');
  if (km > maxKm) reasons.push('too_far');
  // distance_km comes from the browser and prices the order — never trust it blindly.
  // A real driving distance is always >= the straight line between the coordinates, so a
  // shorter claim (or a missing distance despite valid coords) means tampering or a failed
  // client-side Distance Matrix call; either way Eden should confirm the price.
  if (o.pickup_lat && o.pickup_lng && o.dropoff_lat && o.dropoff_lng) {
    const straightKm = haversineKm(Number(o.pickup_lat), Number(o.pickup_lng), Number(o.dropoff_lat), Number(o.dropoff_lng));
    if (km < straightKm - DISTANCE_SLACK_KM) reasons.push('distance_mismatch');
  }

  let price = base + Math.max(0, km - includedKm) * perKm;
  if (o.urgent) price = price * (1 + urgentPct / 100);
  price = Math.max(base, Math.round(price));
  if (price > threshold) reasons.push('above_threshold');

  return { price, base, km, review: reasons.length > 0, reasons };
}
