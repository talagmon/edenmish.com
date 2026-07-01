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

  let price = base + Math.max(0, km - includedKm) * perKm;
  if (o.urgent) price = price * (1 + urgentPct / 100);
  price = Math.max(base, Math.round(price));
  if (price > threshold) reasons.push('above_threshold');

  return { price, base, km, review: reasons.length > 0, reasons };
}
