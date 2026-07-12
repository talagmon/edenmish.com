// Payment boundary — single place where the charge mechanism lives.
//
// Today (Path 1): Shopify Draft Order → customer pays in Shopify checkout
//                 via the PayPlus app (gateway). Immediate capture.
// Future (Mesh/J5): pre-auth max amount at checkout, capture actual after delivery.
//
// The rest of the app calls createCharge() / settleOrder() and never knows
// which processor is behind them. Swapping to Mesh = rewrite this file only.

import { createDraftOrder, verifyShopifyWebhook, parseShopifyOrderWebhook, parseShopifyRefundWebhook } from './integrations.js';

// createCharge(env, order, priceNis) → { checkoutUrl, mode, processorRef } | null
// - 'immediate' mode: returns a Shopify checkout URL; payment is captured at checkout.
// - 'preauth' mode (future Mesh): would return a checkout URL + hold a max amount;
//   settleOrder() must be called later to capture the actual amount.
// - Coupons: the discount breakdown (discount_code / discount_amount /
//   subtotal_price, migration 008) is visible on the booking funnel, success page,
//   tracking page, emails, and ops dashboard. `priceNis` is always the FINAL
//   (post-discount) amount the customer pays; the Shopify Draft Order line item
//   is set directly to this price.
export async function createCharge(env, order, priceNis) {
  const mode = env.PAYMENT_MODE === 'preauth' ? 'preauth' : 'immediate';

  if (mode === 'preauth' && env.MESH_API_KEY) {
    // FUTURE: Mesh pre-auth. Return checkout URL + max hold.
    // return createMeshPreauth(env, order, priceNis);
    return null; // not wired yet — fall through to immediate
  }

  // Immediate capture via Shopify Draft Order + PayPlus app.
  const draft = await createDraftOrder(env, order, priceNis);
  if (!draft) return null;
  // Force Hebrew checkout. Shopify respects ?locale=he on the invoice URL (Hebrew
  // must be a published language in Shopify admin → Settings → Languages).
  let checkoutUrl = draft.invoice_url;
  try { const u = new URL(checkoutUrl); u.searchParams.set('locale', 'he'); checkoutUrl = u.toString(); } catch (e) {}
  return {
    checkoutUrl,
    mode: 'immediate',
    processorRef: String(draft.id),
    draftOrderId: draft.id,
  };
}

// settleOrder(env, order) — no-op in 'immediate' mode (already captured at checkout).
// In 'preauth' mode (future Mesh) this triggers capture of the actual amount.
export async function settleOrder(env, order) {
  if (order.payment_mode !== 'preauth') return { settled: true, noop: true };
  // FUTURE: env.MESH_API_KEY → call Mesh capture API with order.price.
  // if (env.MESH_API_KEY) return captureMesh(env, order);
  return { settled: false, error: 'preauth_mode_not_configured' };
}

export { verifyShopifyWebhook, parseShopifyOrderWebhook, parseShopifyRefundWebhook };
