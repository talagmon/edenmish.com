# EdenMish Optimized Pricing Specification (v2 - Final)

> **Status:** FINAL SPEC. This document incorporates the strategic review for VAT transition, SLA protection, and the 18% VAT rate (Jan 2025).

---

## 1. The Strategy: Pricing for Growth
To avoid a "bait-and-switch" when the business crosses the **עוסק פטור** ceiling (~₪120K/year), we anchor prices today at a level that remains sustainable once the transition to **עוסק מורשה** happens.

- **B2C Labeling:** Use **"מחיר סופי"** (Final Price) only.
- **B2B Framing:** A ₪45 final price from a *עוסק פטור* is net-neutral to a business (equivalent to ₪45 + VAT from a *מורשה*). The pitch is **"Better service for the same net cost."**
- **Tax Note:** VAT in Israel is **18%** (as of Jan 2025).

---

## 2. Optimized Price List (Hebrew/RTL)

| Service Level | Description | Zone 1 (Core) | Zone 2 (Inner) | Zone 3 (Outer) |
| :--- | :--- | :--- | :--- | :--- |
| **Eco** | מסירה עד סוף היום (ריכוז משלוחים) | ₪35 | ₪55 | ₪75 |
| **Standard** | מסירה תוך 4 שעות (SLA מובטח) | **₪50** | **₪70** | **₪115** |
| **Flash** | מעכשיו לעכשיו (90 דק' - נקודה לנקודה) | ₪85 | ₪110 | **N/A** |

### Surcharges & Modifiers:
- **Medium Size (Shoe Box / עד 5 ק"ג):** +₪15
- **Large Size (חבילה חריגה / רכב):** **בתיאום מראש בלבד** (לא יוצג באתר כברירת מחדל).
- **Waiting Fee:** 2 ₪ לכל דקת המתנה (אחרי 10 דקות ראשונות חינם).
- **Evening Surcharge (19:00 - 22:00):** +₪30
- **Friday / Shabbat / Night:** +50% למחיר הבסיס.

---

## 3. The Pricing Formula (Worker Logic)

The pricing engine in `worker/src/pricing.js` must implement the following rule:
`OrderZone = max(PickupZone, DropoffZone)`

### Algorithm Stub:
```javascript
function calculatePrice({ pickupZone, dropoffZone, size, urgency, timestamp }) {
  const zone = Math.max(pickupZone, dropoffZone);
  
  // 1. Base Price from Matrix
  let price = getBasePrice(zone, urgency);
  
  // 2. Add Surcharges
  if (size === 'MEDIUM') price += 15;
  if (isEvening(timestamp)) price += 30;
  if (isWeekend(timestamp)) price *= 1.5;
  
  return price;
}
```

---

## 4. Operational Guardrails (SLA Protection)

As a solo courier operation, the system must protect your time:
1. **Zone 3 Flash Removal:** To prevent impossible 90-minute promises across Gush Dan traffic.
2. **Zone 3 Standard Pricing:** Increased to ₪115 to reflect the high opportunity cost of the round trip.
3. **Capacity Caps (Future):** The Worker should reject/delay `Standard` orders if the "Active Order Count" exceeds your capacity (e.g., > 5 open jobs).

---

## 5. Retention & Cash Flow
- **10-Pack Pre-paid:** ₪450 (10 Standard Zone 1 deliveries).
- **Note:** Prepaid revenue counts toward the ₪120K ceiling upon receipt.
- **Expiry:** Prepaid packs are valid for 6 months.
