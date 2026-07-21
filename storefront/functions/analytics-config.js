function validGa4Id(value) {
  var id = String(value || "").trim().toUpperCase();
  return /^G-[A-Z0-9]+$/.test(id) ? id : "";
}

function validMetaPixelId(value) {
  var id = String(value || "").trim();
  return /^\d{5,20}$/.test(id) ? id : "";
}

// Measurement IDs are public identifiers, but environment-specific values belong
// in Cloudflare Pages variables so staging can remain disabled or use test properties.
export async function onRequestGet({ env }) {
  return new Response(JSON.stringify({
    ga4MeasurementId: validGa4Id(env.GA4_MEASUREMENT_ID),
    metaPixelId: validMetaPixelId(env.META_PIXEL_ID)
  }), {
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store"
    }
  });
}
