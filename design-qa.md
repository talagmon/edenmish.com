## Account plan deck follow-up · 2026-10-08

- Replaced two plan rows with one fixed-height scene containing all five existing plans. Added RTL swipe, previous/next controls, direct plan chips and keyboard Home/End/arrow navigation; reduced-motion preferences suppress transitions.
- Local synthetic preview verified at 1280×900, 390×844 and 320×740: active Silver on opening, Trial for an empty account, linked Gold preselection, native horizontal swipe, keyboard endpoints and selection retention through an account refresh. No page overflow at phone widths. Payment CTA stays within the card while long details scroll independently.
- Validation: 174 storefront tests and 22 business-account tests passed; storefront inline scripts, Worker sources and the dashboard enhancement passed syntax checks. No browser console errors. Account inline JavaScript is byte-identical to the pre-change version; prices, coupons, eligibility and payment logic were not changed.
- Screenshots: `business-account-fixed-plans-desktop.png` and `business-account-fixed-plans-mobile.png` in the local EdenMish review evidence folder.
- Scope: local presentation changes only. No real payment, production account, physical phone, push or deployment was used for verification.

# Ops redesign and unified style checkpoint, 2026-10-08

Applied the light journey design to the active operations interface, `storefront/public/dash.html`. `worker/src/index.js` redirects the Ops hostname to this page; the unused legacy `opsHtml()` renderer was not changed. Added scoped `assets/ops-dashboard.css` and presentation class hooks for the toolbar, metrics, shift panel, queue, statistics, coupons, order details and timeline. Login, driver invitation and proof-of-delivery forms inherit the same light treatment. All six queue filters remain visible on phone screens. Desktop statistics use the available width, coupon headings have readable light surfaces, and the delivery timeline fits a 320px viewport.

The Ops inline script is byte-identical to its pre-redesign snapshot after removing the eleven added CSS class names. All pricing, sorting, order transitions, dispatch, shift, payment, coupon, GPS, signature, upload and confirmation logic remains intact. Existing UI changes from the customer/business redesign are included in the same user-requested design checkpoint. `docs/design/visual-style.md` documents the approved system, and AGENTS.md now points to that guide instead of the missing legacy design file.

Validation: 174 local storefront tests plus 26 focused Worker tests pass (200 total). The API integration suite was disabled with an empty API_URL; no remote test ran. All storefront inline scripts, added presentation scripts and top-level Worker scripts pass syntax checks. Ops source comparison and `git diff --check` pass. The Worker bundle test remains unavailable because this isolated worktree lacks its Wrangler dependency; no installation or deployment was attempted in this iteration.

Browser verification: desktop 1280×900, phone 390×844 and narrow phone 320×740; queue filtering, active/review order details, advanced control disclosure, statistics, coupon table, driver connection panel, login, empty queue and proof-of-delivery form. No horizontal page overflow in tested phone views and no console errors observed. The local synthetic fixture rejects all mutation requests; no PIN entered, driver invitation generated, shift changed, GPS activated, photo uploaded, signature submitted, payment or order action executed. Physical device and screen-reader validation remain pending. Temporary viewport overrides were restored.

Review URL: `http://127.0.0.1:8796/__preview/ops`. The preview generator and data remain under `/tmp`, outside the repository. Evidence: `ops-light-desktop.png`, `ops-light-mobile.png`, `ops-light-statistics.png` in the existing edenmish-review screenshot directory. Secret-pattern scan of all changed text files found no candidate credentials. Commit is authorized by the user; pushing, opening an auto-deploying preview PR and production publication are not part of this checkpoint. Next recommended PR: the unified visual design branch into `develop`, with the missing bundle check completed first.

---

# Business dashboard visual refresh, 2026-10-08

Applied the shared light-purple/glass design to the Worker-rendered business account. Added a compact branded scooter introduction, six section shortcuts, a clearer active-plan/balance/delivery overview, cleaner recent-delivery and wallet feeds, illustrated empty states, and a matching passwordless login card. Batch import now has a three-step visual guide; existing forms, file fields, approval controls and messages remain. Plan cards use compact artwork and native horizontal scrolling on smaller screens; desktop preserves comparison columns. Profile and cancellation panels use the same light surfaces, with readable pending/success/problem colors.

Files changed for this iteration: `worker/src/business-page.js`, new `storefront/public/assets/business-dashboard.css`, new `storefront/public/assets/business-dashboard.js`, and this report. Presentation JavaScript opens the appropriate native details panel and moves focus when an account shortcut is activated. It does not call APIs or alter business state. All original inline account JavaScript, exported business helpers, input/select/option/form/button markup are byte-identical to the pre-iteration snapshot. Prices, coupons, authentication, payment, import approval, cancellation, order and profile logic are unchanged.

Verification: 22 business-page tests and 140 frontend tests pass. Generated browser script, changed JavaScript and storefront inline scripts pass syntax checks; `git diff --check` passes. The existing Worker bundle test could not run because this isolated worktree has no `worker/node_modules/.bin/wrangler` installed (ENOENT). No dependencies were installed and no deployment command succeeded or was retried. The business script preservation check limits risk, but does not replace the pending bundle verification.

Browser checks at default desktop 1280×720, tablet 768×900, mobile 390×844 and narrow phone 320×740. Verified section links reveal collapsed panels and focus their summaries, history expands from five to six synthetic rows, cancellation opens and closes without submitting, login form and readonly account email remain intact, no-plan account offers plan selection, pending-payment message stays visible, and no horizontal page overflow occurs. Import/profile forms and plan rails were visually inspected. No browser console errors observed. Viewport override restored. Physical-phone and screen-reader testing remains unperformed.

Local synthetic preview: `http://127.0.0.1:8796/__preview/business-account`. It renders the actual Worker template with canonical plan catalog data and a local-only mock for `/api/business/me`; all other fetch requests return a read-only-preview rejection. Links offer populated, empty, login and pending-payment states. Fixtures and generator live only in `/tmp` and are not production code. No actual login, OTP, payment, profile save, order creation, cancellation or import request was sent.

Evidence in the existing `edenmish-review` directory: `business-dashboard-desktop.png`, `business-dashboard-mobile.png`, `business-dashboard-login-mobile.png`, `business-dashboard-settings-mobile.png`. No files staged, no commit, push or deployment. Recommended next review unit: this dashboard presentation change against `develop`, after the missing local bundle dependency is available.

---

# Picture stories, shared navigation, Business and About — 2026-10-08

Implemented manual illustrated stories for the homepage How it works (four chapters) and Why Eden (three chapters), About process, and Business account steps. Added an illustrated tracking entry and a CSS storybook with Eden's existing portrait for More about us. Generated two matching transparent adult-character pickup/delivery WebPs; exact prompts and integration notes are in `docs/design/process-stories.md`.

Redesigned Business with a native CSS 3D account card, approved scooter/parcel visuals, five distinct plan skins, native expandable price examples, a fixed-height five-plan 3D glass carousel and sticky chapter links. All plan names, prices, savings examples, benefits, terms and account plan destinations are unchanged. Redesigned About with a compact portrait card, illustrated values, chapter navigation, contact/service-area cards, FAQ and the new sunflower-only developer mark. Both background article links remain. Removed the About video and its “צפו בסרטון EdenMish” control at the user's explicit request. All slogans remain.

Shared navigation now uses a slim glass bar, purple active/hover glow, rounded order CTA and mobile panel with 44px-plus controls. Added mobile order link, Escape dismissal, outside-click handler and desktop-breakpoint close. Reduced-motion styles cover the new effects.

Files: `index.html`, `about.html`, `business.html`, `track.html`; new `assets/process-story.css/js`, `business-journey.css`, `business-plan-deck.css/js`, `about-journey.css`, two process WebPs; refinements to `assets/eden-light.css` and `mobile-nav.js`; cache query updates on existing customer HTML consumers. Updated the existing frontend tests' presentation expectations for the new assets, About process hook, removed film and sunflower credit. No test coverage for business rules was removed.

Verification: all 140 frontend tests pass, inline script syntax and new/shared JS syntax pass, and `git diff --check` passes. Original inline scripts on all four pages are byte-identical to the pre-iteration source. Source comparisons confirm unchanged Business offer/price/terms content and plan links. About contains no video element. Desktop 1280×720, 988×853 and 390×650 responsive iframe checks cover stories, native swiping, next/previous controls, direct chapter navigation, price disclosure, FAQ expansion, selected nav and mobile menu/Escape. Physical phone and screen-reader checks remain unperformed; no real order, payment, tracking request or account login was submitted.

Evidence in the existing edenmish-review directory: `why-eden-story-mobile.png`, `navigation-mobile-glow.png`, `business-chapter-desktop.png`, `business-fixed-plan-mobile.png`, `business-fixed-plan-desktop.png`, `about-chapter-desktop.png`, `about-faq-mobile.png`, `more-about-eden-desktop.png`, `tracking-picture-guide.png`. The fixed plan carousel was checked at the first/last bounds, by direct selection and next button, and with native RTL phone-size swiping. Selection actions stay visible; extra plan details can scroll within their card on short displays. Short-height homepage panels retain internal scrolling so all footer/legal links remain reachable.

Frontend presentation behavior changed; booking, pricing, schedule, account, payment and tracking business logic did not. Work remains in `feat/edenmish-visual-review`; no staging, commit, push or deployment. Next recommended PR: review this visual-only customer journey work against develop, then validate on physical phones before release.

---

# Game-style pickup-time hub — 2026-10-08

Reworked the pickup scheduling presentation with tactile raised day tiles, clear time-slot buttons, selected checkmarks and a CSS 3D-style clock/readout. Desktop keeps the clock beside controls; phone layout uses a compact readout above them. Added numbered day/window labels, an initial empty state, and explicit unavailable-day messaging. The original custom date picker stays accessible. Buttons preserve their original accessible names; keyboard focus remains visible and reduced-motion preferences disable transitions.

Changed `storefront/public/booking.html`, new `assets/booking-time-hub.css` and `assets/booking-time-hub.js`, plus this report. The new module reads existing selected-button text and attributes, adds presentation/accessibility attributes and updates only its decorative readout. It does not calculate availability or modify scheduling values. All pre-existing inline booking scripts and input attributes are byte-identical to the pre-iteration source. No pricing, payment, backend, service eligibility or schedule rules changed. No new generated image required: the clock is native CSS so it reflects the chosen time.

Verification: 140 frontend tests pass; inline and new module syntax pass; git diff --check passes. Browser checks used synthetic data and original navigation on the real booking page, then a temporary local copy for final layout checks. Verified selection and switching pickup windows, synchronized clock/readout, Saturday unavailable state via custom date, disabled Saturday tile, and immediate-service availability. Desktop 1280×720 and responsive iframe 390×650 checked. Phone calendar and time buttons are readable without horizontal overflow and change on a tap. Physical-device native date picker/keyboard was not tested. No order submitted. Temporary fixtures removed.

Evidence in existing edenmish-review folder: `pickup-time-hub-desktop.png`, `pickup-time-mobile-calendar.png`, `pickup-time-mobile-slots.png`. No staging, commit, push or deployment. Next recommended PR: include the time-selector presentation in the local booking visual review to develop.

---

# Visual service cards and courier instructions — 2026-10-08

Added three transparent built-in image-generated service illustrations: parcel + clock for Economy, scooter for Regular, and scooter + speed ribbons for Fast. Desktop now presents all three service choices side by side, with equal-height cards, aligned prices and a selected checkmark. Phone CSS retains horizontal image/text cards. Added an illustrated optional-note panel showing a customer handing the courier a note. At the user's direction, the initial childlike characters were replaced with stylish clearly adult characters. Assets and exact prompts are in `docs/design/service-visuals.md`.

Changed: `storefront/public/booking.html`, `assets/booking-cinema.css`, four WebP assets, prompt documentation and this report. Markup/CSS presentation only; all scripts, input attributes and the textarea are byte-identical to the pre-iteration source. No service, price, payment, validation or backend logic changes. Also clipped the service scene's enlarged city artwork so it cannot overlap its heading.

Verification: 140 frontend tests pass, inline syntax checks and git diff --check pass. Desktop 1280×720 browser verification covered all three cards, switching Regular/Fast, schedule selection, final review and note preservation across Back/Next. No order was submitted or terms accepted. Responsive styles were added; this iteration did not separately verify a phone viewport or physical device. Screenshots: `service-skins-desktop.png`, `courier-note-desktop.png` in the existing edenmish-review evidence folder.

No staging, commit, push or deployment. Next recommended PR: include the visual service and note cards with the local booking presentation review to develop.

---

# Cinematic five-screen booking — 2026-10-08

Result: local implementation complete. The five screens now share one connected visual story: package platform, personalized shipping label, miniature Tel Aviv route, scooter/service clock, and pending review ticket. Generated a pale lavender Tel Aviv diorama using the built-in image tool; reused the existing branded package assets. CSS provides layered depth, camera-like transforms and finite card transitions. Artwork settles while the customer types. This is a layered 3D-style illustration, not WebGL or a live route map.

Files changed this iteration: `storefront/public/booking.html`, new `assets/booking-cinema.css`, `assets/booking-cinema.js`, `assets/booking-tel-aviv-diorama.webp`, `docs/design/booking-cinema.md`, and this report. The scene module reads existing fields and renders only decorative content. Frontend presentation runtime and mobile step scroll target changed. Original input attributes, canonical `validateFlowStep`, and code from `combineAddr` through order/payment submission are unchanged against the saved pre-iteration source. No pricing, service eligibility, payment or Worker rules changed.

Verification: 140 frontend tests passed; inline syntax checks, scene-module syntax and git diff --check passed. Browser inspection covered desktop 1280×720 and a 390×650 responsive iframe. Synthetic input reached all five scenes and final review without order submission. Selected package, name, addresses, service and schedule reflect in the scene. Desktop sticky scene clears the header and bottom action dock. Short-phone styles compress the scene and progress to expose the first field sooner; normal scrolling remains available. Reduced-motion styles disable scene/card animation. Physical-phone keyboard behavior and live checkout were not tested.

Final evidence: `cinema-route-desktop.png`, `cinema-contact-mobile.png` under `/Users/tal/.codex/visualizations/2026/10/07/01a117d5-4db2-7e62-b2d8-2c3d598e29d3/edenmish-review/`. Earlier route/review mobile captures predate the final short-screen spacing refinement. The temporary responsive fixture was removed. Asset path and exact generation prompt are recorded in `docs/design/booking-cinema.md`.

No staging, commit, push or deployment. Next recommended PR: the local booking presentation changes to develop after visual review.

---

# Five-screen booking and compact CTA — 2026-10-08

Result: passed local presentation and navigation checks. Package artwork preserved. The seven canonical field/validation sections are presented as five customer screens: package, contact details, pickup + destination, service + time, and review. Optional address details start collapsed. Progress has labels, completion states and edit/review states. Previously selected answers remain available in an expandable summary, opened automatically on final review. A compact purple pill CTA with arrow, text Back action and subdued price display replaces the oversized primary bar. Per-field errors now appear adjacent to the affected control, with focus and accessible error descriptions.

Files changed in this iteration: `storefront/public/booking.html`, `storefront/public/assets/booking-light.css`, `storefront/tests/frontend.test.js`, this report. Frontend navigation/presentation runtime changed. All original input attributes, `validateFlowStep` business checks, and code from `combineAddr` through order submission/payment remain identical to the saved pre-iteration source. Grouped navigation runs both original validators in merged screens; final review rechecks earlier answers after editing. No Worker/payment/pricing/eligibility rules changed.

Verification: all 140 frontend tests pass (four added tests cover merged route validation, required schedule, review revalidation and grouped Back navigation). Inline syntax checks and git diff --check pass. Browser tests with synthetic contact/address data reached final review without submitting; empty contact, pickup/destination and schedule checks blocked advancement. Desktop 1280×720 and mobile 390×650 iframe viewport were inspected. Phone viewport is a responsive rendering simulation, not physical-device/keyboard verification. No live order/payment was tested.

Evidence: `five-step-cta-desktop.png`, `five-step-mobile-error.png`, `five-step-mobile-route.png` under `/Users/tal/.codex/visualizations/2026/10/07/01a117d5-4db2-7e62-b2d8-2c3d598e29d3/edenmish-review/`. The temporary responsive test fixture was removed.

No stage, commit, push or deployment. Next recommended PR: review the grouped presentation and navigation tests as part of the local visual-journey change to develop.

---

# Branded package visuals — 2026-10-08

Result: passed local desktop presentation and interaction checks. Added built-in image-generated 3D envelope and shoebox-size parcel assets, with EdenMish branding and preserved alpha, converted to 512px WebP (about 54KB combined). Full prompts and asset paths: `docs/design/package-visuals.md`.

Changed `storefront/public/booking.html`, `storefront/public/assets/booking-light.css`, two package assets, prompt documentation and this report. Existing radios, all input attributes, and all booking scripts are byte-identical to their pre-iteration versions. Only package-card markup and CSS changed. Added explicit selected checkmark, pale-purple selected surface, subtle lift, and reduced-motion support. The stylesheet URL is versioned to avoid stale local cached styles.

Verified: images loaded, only the selected checkmark visible, medium selection preserved after Next/Back, 136 frontend tests passed, git diff --check passed. Desktop screenshot: `/Users/tal/.codex/visualizations/2026/10/07/01a117d5-4db2-7e62-b2d8-2c3d598e29d3/edenmish-review/package-cards-desktop.png`. Responsive rules added; physical-phone and mobile rendering were not separately verified in this iteration. No order submission, backend changes, stage, commit, push or deployment.

Next recommended PR: keep this with the presentation-only visual journey review.

---

# Complete fixed homepage flow — 2026-10-08

Result: passed local presentation checks. Nothing staged, committed, pushed, or deployed.

## Scope

The approved scooter scene now contains all homepage content through the footer. Six native scroll-snap stops: Send, How it works, Service areas, Tracking, Why Eden, and More about us. The original four process descriptions, three benefits, slogans, editorial story, customer destinations, business identity, policy links, and sunflower remain available. The duplicate information section and standalone footer below the scene were removed. Behind the scenes opens in an accessible native dialog over the same scene, pauses the film, supports Escape, and restores focus on close. Existing information hash links route into the corresponding stop.

Files changed in this iteration: `storefront/public/index.html`, `storefront/public/assets/journey-navigation.css`, `storefront/public/assets/journey-navigation.js`, `storefront/tests/frontend.test.js`, and this report. The existing slogan assertion now normalizes markup so line breaks and styled spans do not produce false missing-copy failures.

Runtime impact: presentation, scroll, dialog and audience-specific destination selection only. No booking, pricing, authentication, payment, order-state, tracking or backend logic changed in this iteration. Destination wiring uses stable section IDs rather than positional indexes after adding stops.

## Evidence

- Browser checks at 1440×1000, 390×844 and 320×568. Document dimensions exactly matched each viewport; no external page scrolling or horizontal overflow. Smaller screens contain optional long content within scrollable panels.
- Direct step buttons, native wheel scrolling, PageDown, personal/business route switching, dialog open/close and `/#behind-the-scenes` deep link checked. Video paused while dialog was open. Personal/business CTA destinations verified.
- 136 frontend tests passed; storefront inline syntax checks passed; journey-navigation.js syntax passed; git diff --check passed; no duplicate homepage IDs.
- Initial moving-film contrast issue under the benefits/footer was corrected with light opaque information panels. Mobile navigation uses a horizontally scrollable strip with the current stop kept visible.
- Physical phone gestures, live orders, login and payments were not exercised.

Rendered evidence under `/Users/tal/.codex/visualizations/2026/10/07/01a117d5-4db2-7e62-b2d8-2c3d598e29d3/edenmish-review/`: `flow-how-desktop.png`, `flow-footer-mobile.png`, `flow-footer-desktop.png`, `flow-story-mobile.png`.

Next recommended PR: review the local visual journey as one presentation-only PR to develop after owner review; no publication was requested.

---

# Pinned scooter journey and shared customer theme — 2026-10-07

**final result: passed**

This report supersedes the earlier map-only homepage. The user clarified that the scooter scene should remain the pinned navigation experience, then requested Individual/Business entry and the same visual language across customer pages.

## Implemented experience

- A top-level Individual/Business choice opens the existing branded Higgsfield film and a four-stop journey: send, service area, track, and meet Eden. Business selection changes presentation links to business plans/account; it does not set eligibility, authentication or order state.
- Native vertical scrolling and CSS scroll snapping move between full-height stops inside a pinned visual scene. Direct stop buttons and keyboard Page/Arrow navigation are available. There is no wheel or touch interception and no compulsory cinematic delay before using a destination.
- Existing generated footage supplies scooter and camera motion. The interaction adds scene scale/pan and copy transitions; this is video-backed presentation, not a new real-time 3D model. Existing city selection and filtering remain functional.
- Supporting information is preserved in a disclosure; existing deep links open its containing disclosure/tab. Slogans are preserved except the previously authorized expired promotion removal.
- Shared lavender/white, purple and restrained mint styling covers all 18 customer-facing HTML pages, including business plans, booking, tracking, About, status, policies and blog. The operator dashboard is outside this customer presentation change.
- Business account HTML now loads the shared styles/font and body theme class. No account/payment JS changes. Native same-origin page transitions progressively enhance ordinary links; unsupported browsers retain ordinary navigation. Existing booking-step presentation also animates, with reduced-motion support.

## Source and comparison

Source visual: `/Users/tal/.codex/generated_images/01a117d5-4db2-7e62-b2d8-2c3d598e29d3/exec-144b678b-0e42-4a35-93ec-316beeda4caf.png` (1487 × 1058). Latest implementation: `journey-gateway-desktop.png` (1440 × 1000 screenshot/CSS viewport) in the evidence directory below. Source and final capture were opened in the same comparison input twice, including after the legibility-overlay correction. This is an intentional user-directed adaptation of the approved palette/typography/scooter direction, not a pixel recreation: a live film and audience gateway replace the original still parcel composition. Talagmon's pinned scene navigation informed interaction only.

Evidence directory: `/Users/tal/.codex/visualizations/2026/10/07/01a117d5-4db2-7e62-b2d8-2c3d598e29d3/edenmish-review/`.

Full-view evidence: `journey-gateway-desktop.png`, `journey-personal-desktop.png`, `journey-gateway-mobile.png`, `journey-map-mobile.png`, `journey-small-phone.png`. Mobile sizes: 390 × 844 and 320 × 568; desktop 1440 × 1000. Captures use CSS-pixel dimensions; no density scaling claim. Focused page evidence: `journey-booking-mobile.png`, `journey-about-mobile.png`, `journey-business-mobile.png`, `journey-business-login-mobile.png`, `journey-business-dashboard-static.png`, `journey-terms-mobile.png`, `journey-thank-you-mobile.png`. Controls and text are readable in these captures, so additional crops were unnecessary.

## Findings and corrections

1. [P2, fixed] Gateway showed underlying first-stop copy through its translucent layer. Hide the scroller while the gateway is active. Verified opening capture.
2. [P2, fixed] About inherited white headings/body copy and excessive heading width. Added scoped light-theme colors, constrained heading size and improved wrapping. Verified mobile About and source inspection.
3. [P2, fixed] Existing dark tracking input, payment recovery note and business primary button lost contrast. Replaced background shorthand and corresponding text colors. Synthetic dashboard button verified as white on #5B2A86; policy/status inputs and copy visually checked.
4. [P2, fixed] Mobile floating tools covered the stop navigation. Reserved right-side space and compacted labels. Verified map and 320px screenshots.
5. [P2, fixed] Small-phone focus scrolling could tuck the stage under the header. Align the stage with scroll margin on entry and deliberate step navigation. Verified `journey-small-phone.png` after correction.
6. [P2, fixed] Two legibility overlays washed out the scooter; gateway caption overlapped pause control. Keep one overlay and hide the redundant gateway caption. Recompared final source and implementation captures.

## Fidelity surfaces

- Typography: Heebo Hebrew and existing Hanken brand wordmark; strong purple hierarchy, readable mobile fields, no detected horizontal overflow in checked routes at 390px, or journey at 320/1440px.
- Spacing: one viewport-sized journey, reachable stop controls, compact mobile gateway, clear form cards; supporting content stays accessible.
- Colors: warm white/lavender, #5B2A86 primary, dark mint semantic accents. Corrected old hardcoded dark-theme text and field values.
- Imagery: approved/generated real assets retained, including physically branded EdenMish box in the Higgsfield footage and new signed sunflower. No placeholder scooter art introduced.
- Copy: Hebrew/RTL; original slogans, pricing, legal statements and workflow copy retained except the explicitly expired promotion; new gateway and journey labels are presentation copy.

## Verification and limits

- 136 frontend tests pass, 22 business-page unit tests pass. Storefront inline scripts and new journey JS/business template pass syntax checks. `git diff --check` passes; nothing staged.
- Business bundle test could not run because this worktree lacks `worker/node_modules/.bin/wrangler`. No deployment command completed. Unit/syntax checks do not establish a production bundle or live integration.
- Existing customer inline scripts compared unchanged except the previously requested delivered-footer markup. Business-template inline scripts compare byte-for-byte equal to HEAD. Worker delta is font/styles/body class only.
- Browser: both audience choices, resulting destination links, native scrolling at mobile size, PageDown navigation, direct stop selection, service-area filter, motion pause and accessibility stop-animation, supporting-information deep link, and representative/all remaining customer routes checked for theme/overflow. Latest homepage console had no captured warnings/errors.
- Business login and dashboard were rendered locally from `businessAccountHtml`. Dashboard evidence is a static empty-state fixture with behavior script removed, not an authenticated account. No login email, OTP, order, charge, real delivery or live GPS exercised. Physical touch-device testing remains unperformed.
- Preview server now maps `/business` to its existing HTML page; `/__preview/business-account` is a temporary local visual fixture. Production route behavior is unchanged.
- No commit, push, staging release or production deployment. Next recommended PR: the complete customer-journey presentation change to develop when requested.

---

# Footer logo update — 2026-10-07

Replaced the old footer mark on all nine pages that used `se-footer.png` with the current Hebrew signed sunflower from talagmon.com (`public/images/brand/sunflower-signed-he.png`), copied unchanged as `storefront/public/assets/tal-sunflower.png`. The image is displayed at 56 × 56 with contain sizing and no circular crop. No separate developer-credit text was added. Existing destination links retained. Browser verified image loaded and rendered at 56 × 56; evidence: `edenmish-review/new-sunflower-footer.png` in the screenshot directory below. Inline script syntax and whitespace checks pass. Asset/markup only; business logic unchanged. No staging, commit, push or deployment. Include in the existing storefront presentation PR when requested.

---

# Latest refinement: map-led homepage and tracking film — 2026-10-07

Status: local review passed. Supersedes the earlier homepage film/scroll-stage reports below.

## User-directed changes

- Interactive city map moved into the opening homepage composition, with direct links to booking, tracking, business, Eden’s story and the compact information section.
- Talagmon.com was inspected for the compact opening/navigation idea only; no sunflower/earth composition was copied. EdenMish retains light lavender, purple, mint and its own branded parcel map.
- Scooter film now lives on the tracking entry screen with play/pause, reduced-motion support, a still fallback, offscreen/background pause and an explicit illustration caption. It is not delivery-location data.
- Removed the long scroll-controlled film stage. Process and benefits remain available in keyboard-accessible tabs. The behind-the-scenes anchor opens its containing tab and disclosure.
- Footer legal text contrast corrected for the light background. Existing slogans remain except the explicitly retired promotion.

## Evidence

Screenshots under `/Users/tal/.codex/visualizations/2026/10/07/01a117d5-4db2-7e62-b2d8-2c3d598e29d3/edenmish-review/`:
- `map-home-desktop.png`: 1440 × 1024, final opening with map and navigation.
- `map-home-mobile.png`: 390 × 844, compact opening and interactive map.
- `tracking-film-desktop.png` and `tracking-film-mobile.png`: film on tracking entry.

Mobile default homepage height reduced from the earlier measured 7,266px to 2,145px at 390 × 844 (about 70%). Desktop final height 1,725px at 1440 × 1024. No horizontal overflow at either size. Prior hero/scroll screenshots below are historical, not current.

## Verification and limits

- 136 frontend tests pass; storefront inline syntax checks and both new JavaScript files pass Node syntax checks. `git diff --check` passes; nothing staged.
- Browser checked map/list switching, city filtering and selection, keyboard information-tab selection, behind-the-scenes deep link, video playback/pause and desktop/mobile layouts. No browser errors/warnings captured during final tracking check.
- Booking and tracking nonempty inline scripts compare byte-for-byte equal to HEAD. Worker unchanged. Runtime presentation changed; order, pricing, payment, validation and tracking business logic did not.
- Earlier synthetic booking checks reached review only. No order submitted, OTP sent, payment taken or production tracking tested.
- Local worktree only. No commit, push, staging release or production deployment.
- Next recommended PR: this storefront presentation change to develop, when requested. Existing backend work in the original checkout remains untouched.

---

# EdenMish scooter redesign QA · 2026-10-07

Latest result supersedes the historical review below.

**Final result: passed** for this local presentation preview. No production release or payment verification is implied.

## Scope and design source

Motion references inspected: https://motionsites.ai/?prompt=3d-story, https://motionsites.ai/?prompt=luxury-focus and https://motionsites.ai/?prompt=scroll-landing. The scroll-video technique is described at https://motionsites.ai/lesson/build-scroll-animated-website-with-ai. These informed the camera-led storytelling; no premium source code was copied.

- Approved visual source: `/Users/tal/.codex/generated_images/01a117d5-4db2-7e62-b2d8-2c3d598e29d3/exec-144b678b-0e42-4a35-93ec-316beeda4caf.png` (1487 × 1058 pixels).
- Local implementation: http://127.0.0.1:8796/ and /booking.html.
- Desktop comparison: `/Users/tal/.codex/visualizations/2026/10/07/01a117d5-4db2-7e62-b2d8-2c3d598e29d3/edenmish-review/home-desktop-final.png` (1440 × 1024 CSS viewport / screenshot pixels).
- Source and implementation were opened together in the same comparison input. Their aspect ratios are nearly equal; source is slightly larger. Comparison judged composition and type hierarchy, not pixel identity.
- Intentional user-directed changes: scooter prominence instead of the giant parcel; game-cinematic Tel Aviv promenade film instead of the still diorama; EdenMish wordmark physically on the delivery box; existing slogans and booking behavior preserved; expired sale removed by the final user instruction.
- The three story chapters describe the service. The film is an illustrative coastal ride, not a real-time delivery or an exact geographic reconstruction. No literal pickup/handoff footage is claimed.

## Comparison history and fixes

1. First desktop booking capture showed a right-aligned narrow layout after reducing its maximum width. Fixed with margin-inline:auto; verified in `/Users/tal/.codex/visualizations/2026/10/07/01a117d5-4db2-7e62-b2d8-2c3d598e29d3/edenmish-review/booking-desktop.png` at 1440 × 1024.
2. First city directory retained its old dark surface. Fixed panel, field, list, and focus colors; replaced only the homepage map art with a light branded asset. Rechecked filtering and selecting Ramat Gan, with all 21 cities retained.
3. First hero illustration had hard rectangular edges. Rounded the media window; kept copy separate from the film and the booking CTA visible.
4. Motion pause originally collapsed the scroll stage. Manual pause now freezes the film while retaining stage height; accessibility reduction uses the compact static stage. Chapter buttons and time changes were checked in the browser.
5. User requested branding on the box. Replaced the initial unbranded film with Higgsfield job `4e4ea5fd-aa1e-42a7-afae-61d14bc62c99`. A 16-frame contact sheet was visually inspected, including close and medium shots showing EdenMish. Wide aerial shots naturally make the wordmark small. Updated still fallback and service-area parcel too.
6. User requested removal of the ended sale. Removed the homepage discount/date/terms promotion block, retaining an evergreen booking CTA. Historical legal terms and eligibility/payment code remain unchanged.

## Required fidelity surfaces

- Typography: Heebo for Hebrew and existing Hanken for the Latin wordmark, clear two-line hero hierarchy, dark purple headings, readable 16px form inputs. Desktop, tablet, and mobile wrapping inspected.
- Spacing: RTL split hero at desktop, stacked mobile layout, white booking cards with one active step, persistent action dock. No horizontal overflow at 390, 768, or 1440 CSS pixels. Booking dock remains clear of fields and has page-bottom clearance.
- Colors: warm white/lavender background, #5B2A86 primary, restrained dark mint secondary; body copy and field labels darkened for the light surfaces. Selected cards and dates have a clear purple state.
- Imagery: actual generated assets rather than CSS drawings. Purple motor scooter, helmeted rider, seafront, palm shadows and flying camera. Wordmark is printed in the generated scene. Original diorama retained as a branded still fallback. The film is a rendered video, not live WebGL geometry.
- Copy: every non-promotion slogan retained. The sole removed slogan fragment is the expired 10% offer, explicitly requested. Developer footer wording removed from nine customer pages; sunflower link retained. Article authorship copy is outside the footer request and remains.

## Evidence and interaction checks

- `/Users/tal/.codex/visualizations/2026/10/07/01a117d5-4db2-7e62-b2d8-2c3d598e29d3/edenmish-review/home-desktop-final.png`: full hero, primary and tracking links, live film window.
- `/Users/tal/.codex/visualizations/2026/10/07/01a117d5-4db2-7e62-b2d8-2c3d598e29d3/edenmish-review/home-mobile-final.png`: 390 × 844 hero.
- `/Users/tal/.codex/visualizations/2026/10/07/01a117d5-4db2-7e62-b2d8-2c3d598e29d3/edenmish-review/home-tablet-final.png`: 768 × 1024 tablet, still shown while video initializes.
- `/Users/tal/.codex/visualizations/2026/10/07/01a117d5-4db2-7e62-b2d8-2c3d598e29d3/edenmish-review/story-mobile-final.png`: story chapter and camera frame, 390 × 844.
- `/Users/tal/.codex/visualizations/2026/10/07/01a117d5-4db2-7e62-b2d8-2c3d598e29d3/edenmish-review/booking-desktop.png`: initial choices, 1440 × 1024.
- `/Users/tal/.codex/visualizations/2026/10/07/01a117d5-4db2-7e62-b2d8-2c3d598e29d3/edenmish-review/booking-mobile-services.png`: three service choices and action dock, 390 × 844.
- `/Users/tal/.codex/visualizations/2026/10/07/01a117d5-4db2-7e62-b2d8-2c3d598e29d3/edenmish-review/booking-mobile-review.png`: final review presentation, synthetic details only.
- Focused review used the mobile field/service screenshots and the 16-frame branded-film contact sheet at `/tmp/eden-branded-contact.jpg`; the large full-view captures make the hero text readable without a separate crop.
- Browser-tested: booking CTA, seven existing steps through final review, empty-field focus/error, date selection and disabled Saturday, back/edit controls present, hero pause, offscreen hero pause, scroll chapter seeking (chapter 2 ≈3.29s; chapter 3 ≈5.95s), accessibility stop-animation control, city filter/selection, mobile menu.
- Captured browser warnings/errors: none in the final checked local tab.
- Existing frontend suite: 136/136 passed. All storefront inline scripts, new motion script and Worker source syntax checks passed. git diff --check passed.
- Verified booking scripts remain byte-for-byte identical to HEAD. Worker, pricing, scheduling, payment and API-origin modules are untouched. All non-promotion slogan-class text compared against HEAD and retained.

## Boundaries and follow-up

- Local static preview only. The backend was not started; quote values shown are existing local fallback estimates. No order was submitted; no OTP, payment, checkout or real GPS test occurred.
- OS-level reduced-motion switching and physical iPhone/Safari testing remain unverified; the website's own stop-animation control was exercised, and the system preference branch is implemented.
- Local preview is not a production performance benchmark. Film is shared by the hero and story, muted, pauses offscreen and falls back to stills; a physical-phone network/performance check is recommended before release.
- No actionable P0/P1/P2 presentation issue remains in the tested states. Existing business behavior is intentionally outside this change.
- Next recommended PR: the scoped presentation change to develop, after user review. Do not bundle payment or backend work.

---

## Historical review (unchanged)

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

## Follow-up · guided order flow

### Comparison

- Source of truth: current EdenMish homepage at `http://localhost:8788/`
- Implementation: guided order flow at `http://localhost:8788/booking.html`
- Shared viewport: 801 × 862
- Same-state homepage/order comparison: `/tmp/edenmish-home-order-comparison.png`
- Submit-button regression comparison:
  `/tmp/edenmish-order-button-comparison.png`
- Date and coupon verification captures:
  `/tmp/edenmish-order-final-fixes.png`
- Product hierarchy references: the approved seven-step order mockups and the
  provided equal-width mobile glass-layer example

### Visual review

- Navigation, background atmosphere, typography, purple/mint palette, glass
  opacity, hairline borders, radii, and CTA material match the current homepage.
- The order UI uses quieter, iPhone-like layered translucency instead of the
  stronger neon glow from the early concept.
- Every primary layer uses one centered 960px content width with identical
  mobile gutters.
- The seven-stage rail is RTL: step 1 begins on the right and progresses left.
- The primary continuation arrow points left; the back control points right.
- The action is on the right and the price is on the left in one compact bottom
  material.
- Mobile and desktop preserve aligned outer edges; only internal grids and
  padding change.
- Reduced-motion behavior is provided.

### Functionality review

- The original package, contact, pickup, drop-off, service, schedule, business
  plan, coupon, legal, privacy, WhatsApp consent, and final-price controls remain.
- Step 1 advances to step 2.
- Empty required fields block advancement and expose a visible alert.
- Completed steps remain editable through the progress rail and summary chips.
- The complete seven-step path reaches review without changing the existing
  order payload or backend submission.
- Authoritative Worker pricing, business-wallet restrictions, map fallback,
  scheduling, email typo handling, coupons, Shopify payment handoff, and
  tracking redirects remain intact.
- Storefront inline-script syntax check: passed.
- A future date chip now synchronizes the editable date field; selecting
  27/07 displays 27/07/2026 and marks the chip pressed.
- The date field and its explicit calendar button both invoke the native date
  picker when supported.
- The coupon prompt is right-aligned and the expanded apply action is on the
  right.
- Submit loading states update only the label wrapper, preserving the Material
  arrow icon instead of exposing its internal `arrow_back` name.
- Storefront tests: 152 passed, 0 failed; the two live API suites remain skipped
  by their existing local-test guard.

### Findings

- P0: none.
- P1: none.
- P2: none.

final result: passed
