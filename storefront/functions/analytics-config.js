function validGtmId(value) {
  var id = String(value || "").trim().toUpperCase();
  return /^GTM-[A-Z0-9]+$/.test(id) ? id : "";
}

// The container ID is public, but the environment-specific value belongs in a
// Cloudflare Pages variable so staging can remain disabled or use a test container.
export async function onRequestGet({ env }) {
  return new Response(JSON.stringify({
    gtmContainerId: validGtmId(env.GTM_CONTAINER_ID)
  }), {
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store"
    }
  });
}
