# PayPlus × Shopify — Setup Checklist (EdenMish)

PayPlus is an Israeli-licensed payment acquirer with a native Shopify integration: **embedded** checkout (no redirect), Israeli + international cards, **Bit, Apple Pay, Google Pay**, TIPS installments, and full/partial refunds handled inside Shopify.

> **Architecture (Path 1):** PayPlus app = payment **gateway** inside Shopify checkout. The Worker never calls PayPlus directly — it creates a **Shopify Draft Order** (carrying our dynamic price) via Admin API, and the customer pays on that draft order's invoice URL. Shopify + PayPlus handle card/Bit/Apple Pay + capture. A Shopify webhook (`orders/paid`) notifies the Worker when payment lands.
> **Status:** PayPlus app installed + activated in Shopify. Remaining: Admin API token + webhook registration (below).

---

## 1. PayPlus — DONE ✅
- [x] PayPlus account + Shopify app connected + activated as primary gateway.
- [x] Capture mode: "authorize + capture automatically" (immediate charge at checkout).
- [ ] Wallets (Bit / Apple Pay / Google Pay): enable in PayPlus settings if not yet on.
- [ ] Run one test transaction, then one live small transaction + refund to confirm payouts.

## 2. Shopify custom app — needed for Draft Orders
The Worker creates Draft Orders (carrying the dynamic price) via Shopify's Admin API. This needs a custom app token.

1. Shopify admin → **Settings → Apps and sales channels → Develop apps → Create an app** (name: e.g. `EdenMish Ops`).
2. **Configure Admin API scopes** — enable:
   - `write_draft_orders` (create draft orders with custom prices)
   - `read_orders` (webhook: confirm payment)
3. Install the app → copy the **Admin API access token** (starts with `shpat_`).
4. Set it as a Worker secret:
   ```
   wrangler secret put SHOPIFY_ADMIN_TOKEN     # paste shpat_...
   ```
5. `SHOPIFY_SHOP` and `SHOPIFY_API_VERSION` are already in `wrangler.toml [vars]` — no secret needed.

## 3. Shopify webhook — confirm payment back to the Worker
When the customer pays the draft order at checkout, Shopify fires `orders/paid`. Subscribe it to our Worker.

1. Shopify admin → **Settings → Notifications → Webhooks → Create webhook**.
2. **Event:** `Order payment` (== `orders/paid`).
3. **URL:** `https://ops.edenmish.com/webhooks/shopify`.
4. **Format:** JSON.
5. Copy the **Webhook signature key** shown → set as a Worker secret:
   ```
   wrangler secret put SHOPIFY_WEBHOOK_SECRET
   ```
6. The Worker verifies the HMAC signature on every hit (`integrations.js → verifyShopifyWebhook`) before trusting the payload.

## 4. Test the full loop
1. POST a test order to `find.edenmish.com/api/orders` with pickup/dropoff/package + lat/lng.
2. Response should now include `payment_url` → a Shopify invoice URL.
3. Open it → pay via PayPlus (use a test card if PayPlus test mode is on).
4. Confirm the Shopify webhook hits the Worker → order status on the tracking page flips to **שולם**.

---

## Already done on the Shopify side
- Currency: **ILS ₪** · Timezone: **Asia/Jerusalem** · Primary language: **Hebrew (RTL)**
- PayPlus app installed + activated.
- `SHOPIFY_SHOP` + `SHOPIFY_API_VERSION` in Worker `[vars]`.

## Future: Mesh/J5 pre-auth (optional, not needed today)
The Worker's payment layer is a clean boundary (`payment.js → createCharge / settleOrder`). Today it uses Shopify Draft Orders (immediate capture). To switch to Mesh max-hold later: set `PAYMENT_MODE=preauth`, add `MESH_API_KEY`, and implement the `createMeshPreauth` / `captureMesh` stubs in `payment.js`. The order schema already has `payment_mode` + `authorized_amount` columns for this.

## PayPlus contacts / links
- My account: https://myaccount.payplus.co.il  ·  API docs: https://docs.payplus.co.il
- Support: 03-9444788 (Sun–Thu 09:00–18:00)
