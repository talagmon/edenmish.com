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

## Follow-up · watchOS-inspired translucent Ops authentication

### Source visual truth

- Original Ops authentication state:
  `/var/folders/vf/6q17dsc935g4jfcs0vw8z32m0000gn/T/codex-clipboard-8313ea0b-6411-440a-a3b3-2a3b4126882e.png`
- watchOS shape and hierarchy reference:
  `/var/folders/vf/6q17dsc935g4jfcs0vw8z32m0000gn/T/codex-clipboard-11e0c078-774e-425c-972b-5d2b91e6d0d3.png`
- Approved motorcycle/wet-road background remains the production asset:
  `storefront/public/assets/edenmish-home-hero-neon.webp`

### Rendered implementation evidence

- Browser-rendered login:
  `qa-current/ops-auth-watch-glass-471x552.png`
- Density-normalized implementation:
  `qa-current/ops-auth-watch-glass-942x1104-normalized.png`
- Full-view before/after comparison:
  `qa-current/ops-auth-before-after-normalized.png`
- Focused watchOS style comparison:
  `qa-current/ops-auth-watch-style-comparison.png`

### Viewport and normalization

- State: unauthenticated Ops login, dark theme, RTL Hebrew.
- CSS viewport: 471 × 552.
- Browser capture: 471 × 552 pixels at effective 1× density.
- Original Ops source: 942 × 1104 pixels, treated as a 2× capture of the
  471 × 552 CSS viewport.
- The implementation was upsampled to 942 × 1104 only for the combined
  same-size comparison. Layout judgments use the original 471 × 552 browser
  capture and measured CSS geometry.
- The watchOS reference is 786 × 828 and is a style/proportion reference, not
  the same application state. The focused comparison therefore evaluates the
  continuous-corner squircle, inset rim, compact hierarchy, and action treatment
  rather than delivery-specific copy.

### Required fidelity surfaces

- Fonts and typography: Hanken Grotesk remains unchanged. The title, secondary
  label, PIN placeholder, and action retain a compact native hierarchy without
  clipping or wrapping.
- Spacing and layout rhythm: the widget measures 360 × 360 CSS pixels on the
  mobile reference viewport. It has a 52 px continuous corner, centered content,
  58 px input and action controls, and no horizontal or vertical overflow.
- Colors and visual tokens: the implementation preserves midnight navy,
  lavender/purple actions, white text, and the mint route background. The panel
  uses a translucent 0.48 → 0.25 surface with 26 px backdrop blur, rather than
  the previous opaque navy block.
- Image quality and asset fidelity: the real approved motorcycle/wet-road asset
  is visible through the glass. No placeholder or reconstructed image asset was
  introduced. The motorcycle glyph remains the existing Material Symbols icon.
- Copy and content: all production Hebrew copy is unchanged. Only presentation
  and mobile input metadata changed.

### Comparison history

1. The previous login card was visually opaque, with a 26 px rounded rectangle
   that obscured most of the motorcycle and route beneath it.
2. The first glass pass introduced transparency, blur, an inner highlight, and
   embedded glass controls.
3. The supplied watchOS reference then refined the direction: the card became a
   near-square squircle with a dark inset display rim, 52–68 px continuous
   corners, a compact icon tile, and a softer purple action glow.
4. The final browser capture confirms the motorcycle and neon trail remain
   visible through the widget while the PIN and CTA maintain strong contrast.

### Interaction and browser checks

- PIN field accepts input, receives focus, and exposes the numeric mobile keypad
  hint without changing authentication behavior.
- Login action is present and enabled.
- Connection-error retry uses the same embedded glass action style.
- Desktop and mobile variants share the same style; the mobile reference
  viewport has no horizontal or vertical overflow.
- Browser console warnings/errors: none.
- Updated storefront tests: 144 passed, 0 failed.
- Worker tests: 248 passed, 0 failed.

### Findings

- No actionable P0, P1, or P2 differences remain.
- P3 follow-up: evaluate whether the watch-like rim should be one step subtler
  after seeing it on Eden's physical phone in direct sunlight.

final result: passed
