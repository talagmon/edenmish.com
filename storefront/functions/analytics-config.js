function validGtmId(value) {
  var id = String(value || "").trim().toUpperCase();
  return /^GTM-[A-Z0-9]+$/.test(id) ? id : "";
}

function enabled(value) {
  return value === "1" || value === "true";
}

function validConversionOrigin(value) {
  try {
    var url = new URL(String(value || "").trim());
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    ) return "";
    return url.origin;
  } catch (_) {
    return "";
  }
}

// The container ID is public, but the environment-specific value belongs in a
// Cloudflare Pages variable so staging can remain disabled or use a test container.
export async function onRequestGet({ env, request }) {
  var gtmContainerId = validGtmId(env.GTM_CONTAINER_ID);
  var providers = {
    googleAnalytics: Boolean(gtmContainerId && enabled(env.ANALYTICS_GOOGLE_ENABLED)),
    metaPixel: Boolean(gtmContainerId && enabled(env.ANALYTICS_META_ENABLED))
  };
  var conversionOrigin = validConversionOrigin(env.ANALYTICS_CONVERSION_ORIGIN);
  var requestOrigin = "";
  try { requestOrigin = new URL(request.url).origin; } catch (_) {}
  return new Response(JSON.stringify({
    gtmContainerId: gtmContainerId,
    providers: providers,
    paidConversionEnabled: Boolean(
      conversionOrigin &&
      requestOrigin === conversionOrigin &&
      (providers.googleAnalytics || providers.metaPixel)
    )
  }), {
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff"
    }
  });
}
