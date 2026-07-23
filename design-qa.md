# EdenMish Apple-glass redesign · Design QA

## Scope

- Public EdenMish storefront pages
- Customer booking, tracking, business, legal, payment, and recovery surfaces
- Ops authentication and queue at `ops.edenmish.com` (served by the canonical `/dash.html` client)
- Legacy Worker-rendered Ops page kept visually aligned

## Visual source

- Approved source-of-truth screenshot supplied with the design task and preserved
  in the combined comparison below.
- Approved motorcycle/wet-road asset:
  `storefront/public/assets/edenmish-home-hero-neon.webp`
- Eden Driver native `StopCardView` and `OrderProgressStrip` implementations,
  reviewed locally as the Ops card source.

## Same-state comparison

- Viewport: 1536 × 1024
- Approved reference and final implementation combined:
  `qa-current/home-reference-comparison.jpg`
- Final implementation:
  `qa-current/home-desktop-1536x1024.jpg`

The final homepage preserves the approved composition, wet-road motorcycle artwork, neon route, RTL headline hierarchy, glass navigation, lavender action treatment, and mint operational status accent. The implementation uses the real approved asset, including `edenmish.com` on the delivery box.

## Ops evidence

- Desktop login, 1440 × 1024:
  `qa-current/ops-login-desktop.jpg`
- Mobile login, 390 × 844:
  `qa-current/ops-login-mobile-v2.jpg`
- Desktop queue, two columns:
  `qa-current/ops-dashboard-desktop-viewport-v2.jpg`
- Mobile new-order card:
  `qa-current/ops-dashboard-new-order-mobile.jpg`
- Mobile active-order cards and progress:
  `qa-current/ops-dashboard-mobile-cards-v2.jpg`

## Review history

1. Initial mobile homepage review found the approved motorcycle artwork too subdued and the EdenMish wordmark vulnerable to clipping.
2. The mobile crop, overlay, and non-shrinking header/CTA rules were corrected.
3. Initial Ops order-card review found the destructive swipe background visible through translucent cards and below shorter cards in a desktop grid.
4. Cards were given an opaque glass surface above the swipe layer, and grid items were changed to top alignment.
5. Initial mobile Ops login crop showed only a sliver of the motorcycle.
6. The mobile background focal point was moved to 19%, exposing the rider, motorcycle, wet road, and neon trail without reducing PIN contrast.

## Responsive and interaction checks

- Homepage desktop: 1536 × 1024, no horizontal overflow.
- Homepage mobile: 390 × 844, full brand and CTA visible.
- Ops login desktop: 1440 × 1024, no horizontal overflow.
- Ops login mobile: 390 × 844, no horizontal overflow.
- Ops queue desktop: 1440 × 1024, two equal columns, no horizontal overflow.
- Ops queue mobile: 390 × 844, one 358 px column, no horizontal overflow.
- Mobile navigation opens and exposes all canonical destinations.
- Ops login succeeds against the local Worker using an HttpOnly session cookie.
- Queue filters switch between all, new, active, completed, cancelled, and problem orders.
- Order cards open their detail view; the back action returns to the queue.
- Order cards are keyboard operable with Enter or Space.
- Existing swipe-to-cancel, refresh, logout, driver pairing, status actions, proof capture, and notification controls remain present.
- Browser console diagnostics: no errors.

## Regression checks

- Storefront build: passed.
- Storefront inline-script syntax check: passed.
- Storefront tests: 143 passed, 0 failed, 2 API suites skipped by their existing local-test guard.
- Worker syntax check: passed.
- Worker tests: 248 passed, 0 failed.
- Design-severity review: no open P0, P1, or P2 issues.

final result: passed
