# EdenMish checkout branding

`pay.edenmish.com` is the trusted Shopify checkout and payment shell. Customers
will see this host while they pay; theme code does not control Shopify's checkout
form.

## Responsive artwork

- Desktop / wide surfaces: `storefront/public/assets/edenmish-payment-background-desktop.webp`
- Mobile / narrow surfaces and Shopify order summary: `storefront/public/assets/edenmish-payment-background-mobile.webp`

Both assets use the v2 EdenMish palette and deliberately contain no payment
provider logos, card details, currency symbols, or text.

## Current Shopify limitation

As of February 5, 2026, Shopify's standard checkout editor no longer accepts a
new background image for the checkout header or main form. A background image
can still be selected for the order-summary area. Advanced main-area image
branding through Checkout Blocks or the Checkout Branding API requires Shopify
Plus (or a development store).

References:

- [Customize checkout style](https://help.shopify.com/en/manual/checkout-settings/customize-checkout-configurations/checkout-style)
- [Checkout Blocks branding editor](https://help.shopify.com/en/manual/checkout-settings/checkout-blocks/branding-editor)

## Recommended live configuration

In Shopify Admin, open **Settings > Checkout > Configurations > Customize**, then
open **Settings** in the checkout editor.

1. Set the header and main background colors to `#0B1020`.
2. Use `#91D3C8` for checkout accents and `#5B2A86` for the primary brand color.
3. Keep form fields light and high-contrast for payment readability.
4. Under **Order summary**, select
   `edenmish-payment-background-mobile.webp`. Its portrait composition works in
   the narrow desktop sidebar and the expandable mobile summary.
5. Preview both desktop and mobile modes before saving the live checkout
   configuration.

The desktop asset is reserved for EdenMish-controlled payment surfaces and for
a future Shopify Plus checkout-branding profile. Do not add checkout branding to
`config/settings_data.json`; the Shopify checkout editor remains the production
source of truth.
