# EdenMish light journey design

Approved direction implemented locally in October 2026. This is the visual reference for the redesigned storefront, business account and operations dashboard. Production publication is a separate step.

## Identity

Keep EdenMish purple (`#5B2A86`) as the primary brand color. Use warm white (`#FAF8FC`) backgrounds, pale lavender surfaces, deep plum text (`#241334`) and soft mint accents. Mint text on light backgrounds uses the darker `#276E65`. Errors and warnings retain readable red and amber labels. Do not reintroduce legacy gold.

Hebrew, RTL and mobile first. Heebo is the interface font; Hanken Grotesk supports Latin branding and numeric metrics. Preserve the existing slogans, service names, plan conditions and business rules. The sunflower alone represents the developer credit.

## Surfaces and movement

Use rounded, lightly translucent cards with thin lavender borders and restrained shadows. Purple is reserved for primary actions and selection. Hover glow and small depth transitions should clarify interaction. Provide a visible keyboard focus state and respect reduced motion. Avoid making text, inputs or operational controls depend on animation.

The homepage uses a fixed city scene and explicit journey chapters. Picture stories advance manually, by controls or swipe. Public business plans use the fixed-height 3D card deck. Booking presents the existing required inputs in five visual screens, without changing the canonical validation or submission workflow.

## Illustration

Use the approved purple motor scooter with a delivery box marked exactly `EdenMish`, Tel Aviv promenade/Bauhaus context, and consistent 3D parcel, service and adult-character illustrations. Illustrations explain what happens; visible text labels remain authoritative. Eden's existing portrait represents the real founder. Do not treat decorative city scenes as live maps or driver locations. The scooter film belongs on tracking, not the About page.

## Business and operations

The business account prioritizes balance, active plan and new delivery, followed by recent shipments and wallet activity. Imports, plan selection and profile details remain native expandable panels with direct shortcuts. Account plan comparison uses one fixed-height, swipeable 3D glass-card deck, matching the public business page. Keep the active or linked plan centered on opening, preserve the viewed plan across account refreshes, and retain the existing top-up button and disabled state. Long plan details scroll within the card while its action stays visible.

Ops prioritizes queue filters, daily figures, driver shift state and readable order cards. Statistics can use the desktop width; on mobile, forms and cards stack naturally. Retain every warning, confirmation, explicit GPS consent control and payment boundary. Never introduce an illustrative control that appears to change real operational state.

## Implementation ownership

- Shared light tokens and navigation: `storefront/public/assets/eden-light.css`, `journey-theme.css`, `mobile-nav.js`.
- Homepage: `home-journey.css/js`, with shared `process-story.css/js` picture stories.
- Booking: `booking-light.css`, `booking-cinema.css/js`, `booking-time-hub.css/js`.
- Public business: `business-journey.css`, `business-plan-deck.css/js`.
- Account: `worker/src/business-page.js`, `business-dashboard.css/js`.
- Operations: `storefront/public/dash.html`, `ops-dashboard.css`. The Ops hostname redirects to this page; the older `opsHtml()` renderer is not the active entrypoint.
- About and tracking: `about-journey.css`, `tracking-film.css/js`.

Keep new styling scoped to its page. CSS class hooks in rendered markup may change for presentation; authentication, order, pricing, payment, dispatch, status and import logic must retain their existing owners. The light styles are layered after existing base styles to keep the migration reviewable.

Generation prompts and asset notes are in the other documents in this directory. Local checks, remaining verification limits and screenshots are recorded in `design-qa.md` at the repository root. Synthetic account/Ops preview fixtures are local `/tmp` files and must not be shipped as authenticated applications.
