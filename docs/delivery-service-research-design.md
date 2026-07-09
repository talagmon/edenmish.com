# EdenMish Delivery Service: Research & System Design

## 1. System Philosophy
- **Hebrew First:** All labels, error messages, and UI flows are RTL-native.
- **Agile Stack:** Cloudflare Workers (Compute) + D1 (Storage) + PayPlus (Israeli Payments).
- **Priority-Driven:** Orders are not just a queue; they are a weighted list based on service level and deadlines.

## 2. Architecture Diagram
```
[Shopify Funnel] --(Order API)--> [Cloudflare Worker] <--(API/Webhook)--> [PayPlus]
                                        |
                                [D1 SQLite DB]
                                        |
                ┌───────────────────────┴───────────────────────┐
       [find.edenmish.com]                             [ops.edenmish.com]
      (Customer Tracking)                               (Driver Dashboard)
```

## 3. Israeli Compliance (2026)
### Tax & Invoicing
- **Requirement:** Digital signature and real-time reporting to the ITA for high-value B2B.
- **Implementation:** The Worker should trigger an invoice via `Green Invoice` or `iCount` API the moment `orders/paid` webhook is received from Shopify/PayPlus.

### Data Privacy
- **Requirement:** Secure handling of Israeli phone numbers and home addresses.
- **Implementation:** Use Cloudflare Access or a PIN/OTP gate for all operations data.

## 4. Feature Requirements
### Tracking & Management
- **Tracking Link:** Token-based URL (no login needed for customers).
- **Status Stepper (Hebrew):**
  1. נתקבל (Received)
  2. בתהליך (Processing)
  3. בדרך אליך (En route - Live GPS)
  4. נמסר (Delivered)
- **Priority Logic:**
  - `Normal`: Same day.
  - `Express`: Within 2-3 hours.
  - `VIP`: Direct A to B.

## 5. Mobile App Strategy (Future)
- **Framework:** React Native (Expo).
- **Reasoning:** Fast development, native GPS access for more accurate "Last Mile" tracking, and Push Notifications for Eden (new order alerts).
- **Open Source Base:** Borrow the "Driver-App" logic from **Fleetbase** or **Uber Clone** repos on GitHub.

## 6. Action Plan
1. **Migration:** Update D1 schema to include `priority` and `deadline_at`.
2. **UI Update:** Add Hebrew RTL styling to the ops dashboard stepper.
3. **API Integration:** Connect the invoicing provider to the payment success flow.
