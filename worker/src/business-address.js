import { zoneOf } from './pricing.js';
import { composeDeliveryAddress } from './business-batch.js';

const PLACES_TEXT_SEARCH_URL = 'https://places.googleapis.com/v1/places:searchText';
const ADDRESS_COMPONENT_TYPES = ['locality', 'postal_town', 'administrative_area_level_2'];
const SERVICE_AREA_RECTANGLE = {
  low: { latitude: 31.84, longitude: 34.64 },
  high: { latitude: 32.36, longitude: 35.06 },
};

function normalizeLetters(value) {
  return String(value == null ? '' : value)
    .normalize('NFKD')
    .replace(/[\u0591-\u05c7]/g, '')
    .replace(/[ךםןףץ]/g, (letter) => ({ ך: 'כ', ם: 'מ', ן: 'נ', ף: 'פ', ץ: 'צ' }[letter]))
    .toLowerCase();
}

export function normalizeAddressText(value) {
  return normalizeLetters(value)
    .replace(/[״"'׳`]/g, '')
    .replace(/[.,;:()[\]{}\\/–—_-]+/g, ' ')
    .replace(/(?:^|\s)(?:רחוב|רח)(?=\s|$)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeCity(value) {
  return normalizeAddressText(value)
    .replace(/^תל אביב יפו$/, 'תל אביב')
    .replace(/^קרית אונו$/, 'קריית אונו')
    .replace(/^פתח תקוה$/, 'פתח תקווה');
}

function editDistance(left, right) {
  const a = [...left];
  const b = [...right];
  const previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let row = 1; row <= a.length; row += 1) {
    const current = [row];
    for (let column = 1; column <= b.length; column += 1) {
      current[column] = Math.min(
        current[column - 1] + 1,
        previous[column] + 1,
        previous[column - 1] + (a[row - 1] === b[column - 1] ? 0 : 1),
      );
    }
    previous.splice(0, previous.length, ...current);
  }
  return previous[b.length];
}

function similarity(left, right) {
  const a = normalizeAddressText(left);
  const b = normalizeAddressText(right);
  if (!a || !b) return 0;
  if (a === b) return 1;
  return 1 - editDistance(a, b) / Math.max(a.length, b.length);
}

function component(place, type) {
  const item = (place?.addressComponents || []).find((entry) => (entry.types || []).includes(type));
  return item ? String(item.longText || item.shortText || '').trim() : '';
}

function resolvedCity(place) {
  for (const type of ADDRESS_COMPONENT_TYPES) {
    const value = component(place, type);
    if (value) return value;
  }
  return '';
}

function candidateDetails(place, declaredStreet, declaredNumber, declaredCity) {
  const route = component(place, 'route');
  const number = component(place, 'street_number');
  const city = resolvedCity(place);
  const country = component(place, 'country');
  const latitude = Number(place?.location?.latitude);
  const longitude = Number(place?.location?.longitude);
  if (!route || !number || !city) return null;
  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90
    || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) return null;
  if (country && !['ישראל', 'israel', 'il'].includes(normalizeAddressText(country))) return null;
  if (normalizeAddressText(number) !== normalizeAddressText(declaredNumber)) return null;

  const routeScore = similarity(declaredStreet, route);
  const cityScore = similarity(normalizeCity(declaredCity), normalizeCity(city));
  const routeLength = normalizeAddressText(declaredStreet).length;
  const routeDistance = editDistance(normalizeAddressText(declaredStreet), normalizeAddressText(route));
  const routeConfident = routeScore >= 0.72
    && routeDistance <= (routeLength <= 5 ? 1 : 2);
  if (!routeConfident || cityScore < 0.72 || zoneOf(city) == null) return null;

  return {
    route,
    number,
    city,
    latitude,
    longitude,
    routeScore,
    cityScore,
    score: routeScore * 0.75 + cityScore * 0.25,
  };
}

export function resolveBusinessAddress(street, houseNumber, city, places) {
  const declaredStreet = String(street || '').trim();
  const declaredNumber = String(houseNumber || '').trim();
  if (!declaredNumber) return { error: 'missing_delivery_house_number' };
  if (!normalizeAddressText(declaredStreet)) return { error: 'invalid_delivery_street' };

  const candidates = (places || [])
    .map((place) => candidateDetails(place, declaredStreet, declaredNumber, city))
    .filter(Boolean)
    .sort((left, right) => right.score - left.score);
  if (!candidates.length) return { error: 'invalid_delivery_address' };

  const [best, runnerUp] = candidates;
  if (
    runnerUp
    && best.score - runnerUp.score < 0.08
    && (
      normalizeAddressText(best.route) !== normalizeAddressText(runnerUp.route)
      || normalizeCity(best.city) !== normalizeCity(runnerUp.city)
    )
  ) {
    return { error: 'ambiguous_delivery_address' };
  }

  const corrections = [];
  if (normalizeAddressText(declaredStreet) !== normalizeAddressText(best.route)) {
    corrections.push({
      field: 'delivery_street',
      from: declaredStreet,
      to: best.route,
      reason: 'normalized_delivery_street',
      confidence: 'high',
      source: 'google_maps',
    });
  }

  const declaredCity = String(city || '').trim();
  if (normalizeCity(declaredCity) !== normalizeCity(best.city)) {
    corrections.push({
      field: 'delivery_city',
      from: declaredCity,
      to: best.city,
      reason: 'normalized_delivery_city',
      confidence: 'high',
      source: 'google_maps',
    });
  }

  return {
    street: corrections.some((correction) => correction.field === 'delivery_street')
      ? best.route
      : declaredStreet,
    city: corrections.some((correction) => correction.field === 'delivery_city')
      ? best.city
      : declaredCity,
    latitude: best.latitude,
    longitude: best.longitude,
    corrections,
  };
}

async function searchPlaces(street, houseNumber, city, apiKey, fetchImpl) {
  const signal = typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
    ? AbortSignal.timeout(5000)
    : undefined;
  const response = await fetchImpl(PLACES_TEXT_SEARCH_URL, {
    method: 'POST',
    ...(signal ? { signal } : {}),
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': apiKey,
      'X-Goog-FieldMask': 'places.id,places.formattedAddress,places.addressComponents,places.location,places.types',
    },
    body: JSON.stringify({
      textQuery: `${street} ${houseNumber}, ${city}, ישראל`,
      languageCode: 'he',
      regionCode: 'IL',
      pageSize: 3,
      locationRestriction: { rectangle: SERVICE_AREA_RECTANGLE },
    }),
  });
  if (!response.ok) throw new Error('address_validation_unavailable');
  const payload = await response.json();
  return Array.isArray(payload?.places) ? payload.places : [];
}

async function mapLimit(items, limit, work) {
  const results = new Array(items.length);
  const cursor = { value: 0 };
  async function worker() {
    while (cursor.value < items.length) {
      const index = cursor.value;
      cursor.value += 1;
      results[index] = await work(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export async function validateBusinessBatchAddresses(rows, options = {}) {
  const apiKey = String(options.apiKey || '').trim();
  const fetchImpl = options.fetchImpl || fetch;
  const cache = new Map();
  const candidates = rows.filter((row) => (
    row.delivery_street
    && row.delivery_house_number
    && row.delivery_city
  ));

  await mapLimit(candidates, 5, async (row) => {
    if (row.errors.some((error) => [
      'missing_delivery_street',
      'missing_delivery_house_number',
      'missing_delivery_city',
      'too_long_delivery_street',
      'too_long_delivery_house_number',
      'too_long_delivery_city',
      'invalid_delivery_house_number',
    ].includes(error))) return;

    if (!apiKey) {
      row.errors = [...new Set([...row.errors, 'address_validation_unavailable'])];
      return;
    }

    const key = [
      normalizeAddressText(row.delivery_street),
      normalizeAddressText(row.delivery_house_number),
      normalizeCity(row.delivery_city),
    ].join('|');
    try {
      let placesPromise = cache.get(key);
      if (!placesPromise) {
        placesPromise = searchPlaces(
          row.delivery_street,
          row.delivery_house_number,
          row.delivery_city,
          apiKey,
          fetchImpl,
        );
        cache.set(key, placesPromise);
      }
      const places = await placesPromise;
      const resolution = resolveBusinessAddress(
        row.delivery_street,
        row.delivery_house_number,
        row.delivery_city,
        places,
      );
      if (resolution.error) {
        row.errors = [...new Set([...row.errors, resolution.error])];
        return;
      }
      row.delivery_street = resolution.street;
      row.delivery_city = resolution.city;
      row.delivery_lat = resolution.latitude;
      row.delivery_lng = resolution.longitude;
      row.delivery_address = composeDeliveryAddress(row);
      row.corrections = [...(row.corrections || []), ...resolution.corrections];
    } catch {
      row.errors = [...new Set([...row.errors, 'address_validation_unavailable'])];
    }
  });

  return rows;
}
