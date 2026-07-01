Setting up a localized Shopify delivery platform for the Tel Aviv area requires specialized apps and custom automation to support Hebrew (RTL) and courier workflows. Shopify is built for standard e-commerce, but you can successfully adapt it into a local delivery engine for Eden using the right stack. [1] 
Here is the architectural design, implementation plan, and feature roadmap for edenmish.com.
------------------------------
## 1. Recommended Technology Stack
To keep the platform user-friendly, multilingual, and highly automated without building an entire backend from scratch, use Shopify as your core engine combined with these specific ecosystem tools:
## Core Platform & Local Translation

* E-Commerce Engine: [Shopify](https://www.shopify.com/) (Basic or Shopify Plan). It natively supports RTL (Right-to-Left) styling required for Hebrew.
* Theme: Choose an officially supported Shopify theme optimized for local pickups, such as Dawn (free) or Impact. Ensure the theme is set to Hebrew in your Shopify admin settings (Settings > Languages). [2, 3] 

## Custom Order Form (Package Type & Addresses)
Because standard Shopify product pages use a basic Add to Cart flow, you need a custom checkout form on a single page: [4] 

* Option A (App-Based): Use [Form Builder by HulkApps](https://apps.shopify.com/form-builder) or Panda Form Products App to design the specific workflow: Package Type Selector $ightarrow$ Pickup/Drop-off Address $ightarrow$ Schedule Date/Time $ightarrow$ Contact Details.
* Option B (Custom Liquid Template): A developer can write a custom line-item property form directly into a dedicated Shopify page template to pass these details seamlessly into the cart.

## Dispatch & Courier App (For Eden)
Shopify does not have a native courier app, so you must link it to a last-mile delivery tool:

* EasyRoutes by Roundtrip: A top-rated Shopify app that turns your orders into local delivery routes. It generates a mobile-friendly web link for Eden to mark packages as On the Way, Attempted, or Delivered.
* Zapiet - Pickup + Delivery: Ideal for setting up localized Tel Aviv radius restrictions, delivery date/time pickers, and slot management.

## Local SMS & WhatsApp Notifications

* Sms77 or Twilio via Shopify Flow: To send instant Hebrew text alerts to Israeli phone numbers (+972) when Eden updates the order status. [5] 

------------------------------
## 2. Step-by-Step Implementation Plan

[Phase 1: Setup] ──> [Phase 2: Product & Rates] ──> [Phase 3: Dispatch Workflow] ──> [Phase 4: Launch]

## Phase 1: Base Configurations

   1. Domain Mapping: Connect your domain edenmish.com to your Shopify store under Settings > Domains.
   2. Localization: Change the primary store language to Hebrew. Set the store currency to Israeli New Shekel (ILS).
   3. Geofencing: Go to Shipping and Delivery settings. Create a localized zone restricted specifically to the Tel Aviv District (Tel Aviv, Ramat Gan, Givatayim, Holon, Bat Yam, Herzliya) to prevent out-of-zone orders. [6] 

## Phase 2: Product Structure & Booking Form

   1. Create Service Products: Create three simple hidden products in Shopify representing your tiers: Envelope, Small Item, and Box (Up to Shoe Box size). Set a base price for each.
   2. Build the Intake Form: Map the user experience directly on the homepage or a dedicated landing page:
   * Step 1: Visual buttons for Package Type (Envelope / Item / Box).
      * Step 2: Input fields for Pickup Address and Destination Address.
      * Step 3: Date & Time picker (e.g., Deliver Now vs. Schedule for Later).
      * Step 4: Sender and Receiver contact information (Names + Phone numbers).
   
## Phase 3: Courier Automation Workflow

   1. Order Placement: The customer completes checkout via local credit cards or digital wallets.
   2. Eden's Mobile Notification:
   * Use Shopify Flow (Shopify's free automation app) to trigger an action whenever a new order is paid.
      * Configure it to send an automatic WhatsApp notification via a webhook or a detailed email directly to Eden's phone. [7] 
   3. Delivery Execution: Eden opens the EasyRoutes driver link on his mobile browser. He views the map, navigates to Tel Aviv addresses, and taps buttons to instantly update the status (On-the-Way, Completed).

## Phase 4: Testing & Launch

   1. Run dummy orders using test payment gateways.
   2. Verify that Hebrew text does not break or misalign across iPhone and Android screens.
   3. Confirm Eden's mobile view functions flawlessly on cellular data in central Tel Aviv.

------------------------------
## 3. Essential Features for an Israeli Delivery Company
To stay competitive and operationally efficient, integrate these high-utility features into your system architecture:

* Dynamic Radius Pricing: Integrate a Google Maps API extension so your checkout calculates real-time driving distances from the center of Tel Aviv and dynamically adjusts delivery pricing by kilometer.
* Proof of Delivery (PoD): Ensure Eden's driver interface allows him to snap a smartphone photo of the dropped-off box or collect a digital signature on glass for high-value commercial packages.
* WhatsApp Tracking Links: Instead of traditional emails, send Israeli private consumers a localized WhatsApp message containing a quick-click tracking link to view Eden's status updates.
* B2B Client Portal: Since you are serving small businesses, look into a bulk order app like Matrixify. This allows business clients to upload a daily Excel sheet of 20+ Tel Aviv deliveries at once rather than entering them manually.

If you would like, I can help you write the exact step-by-step automation logic for Shopify Flow to message Eden's phone, or outline the specific CSS adjustments needed to ensure your theme elements look perfectly aligned in Right-to-Left Hebrew.

[1] [https://amasty.com](https://amasty.com/blog/shopify-b2b/)
[2] [https://www.digitalhiveconsulting.com](https://www.digitalhiveconsulting.com/what-is-shopify)
[3] [https://help.shopify.com](https://help.shopify.com/en/manual/international/localization-and-translation)
[4] [https://docs-shpf.bsscommerce.com](https://docs-shpf.bsscommerce.com/bss-b2b-quick-order-and-quotes)
[5] [https://www.easysendsms.com](https://www.easysendsms.com/bulksmscountries/Israel)
[6] [https://www.velocitysellers.com](https://www.velocitysellers.com/2025/11/04/what-is-shopify-and-how-does-it-work/)
[7] [https://support.getbyrd.com](https://support.getbyrd.com/en/knowledge-base/shopify-integration)

