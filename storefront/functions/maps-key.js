// Returns the browser Maps API key to the frontend at runtime.
// The key itself is a Cloudflare Pages SECRET (set via
// `wrangler pages secret put MAPS_KEY`), so it is never committed to the repo.
// It is a referer-restricted browser key (Google Cloud Console).
export async function onRequestGet({ env }) {
  return new Response(JSON.stringify({ key: env.MAPS_KEY || "" }), {
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store"
    }
  });
}
