// Shared status model — single source of truth for status labels, lifecycle
// order, live-GPS flags, terminal/problem classification, ops queue buckets,
// and allowed forward transitions.
//
// The DB stores status as free text (no rename happens in this PR). This module
// only centralizes the metadata that was previously hardcoded in pages.js
// (ops HE label map, customer tracking FLOW, LIVE-GPS list). Both UIs now read
// from here so the two stop drifting apart.

export const STATUS = Object.freeze({
  RECEIVED: 'received',
  PRICED: 'priced',
  REVIEW: 'review',
  PAYMENT_SENT: 'payment_sent',
  PAID: 'paid',
  TO_PICKUP: 'to_pickup',
  PICKED_UP: 'picked_up',
  TO_DROPOFF: 'to_dropoff',
  DELIVERED: 'delivered',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
  REFUND_PENDING: 'refund_pending',
});

// Future ops-dashboard queue buckets. Mapped 1:1 to current statuses; not yet
// wired into any UI (a later ops-queues PR will consume them).
export const QUEUE_BUCKETS = Object.freeze({
  INBOX: 'inbox',
  AWAITING_PAYMENT: 'awaiting_payment',
  READY_FOR_PICKUP: 'ready_for_pickup',
  IN_PROGRESS: 'in_progress',
  DONE: 'done',
  PROBLEM: 'problem',
});

// lifecycleOrder = position in the customer-visible tracking timeline.
//   - Only the 8 happy-path statuses carry a number; they render in the FLOW.
//   - review / failed / cancelled / refund_pending have null → excluded from the
//     customer FLOW (preserves existing tracking-page behaviour exactly).
//
// customerLabel = the wording shown on the customer tracking timeline
//   (deliberately differs from hebrewLabel, which is the short ops pill label).
//
// hebrewLabel = the short label used in the ops dashboard status pill.
//
// isLiveGps = the tracking map + ops GPS broadcast run while the order has this
//   status (today: to_pickup, to_dropoff).
//
// nextStatuses = descriptive allowed forward transitions (not enforced yet).

export const STATUS_META = {
  [STATUS.RECEIVED]: {
    value: STATUS.RECEIVED,
    hebrewLabel: 'נתקבלה',
    customerLabel: 'נתקבלה הבקשה',
    description: 'Request received; not yet priced.',
    lifecycleOrder: 0,
    isTerminal: false,
    isLiveGps: false,
    queueBucket: QUEUE_BUCKETS.INBOX,
    nextStatuses: [STATUS.PRICED, STATUS.REVIEW],
  },
  [STATUS.PRICED]: {
    value: STATUS.PRICED,
    hebrewLabel: 'מחושב אוטומטית',
    customerLabel: 'מחיר מחושב אוטומטית',
    description: 'Auto-priced; awaiting payment.',
    lifecycleOrder: 1,
    isTerminal: false,
    isLiveGps: false,
    queueBucket: QUEUE_BUCKETS.INBOX,
    nextStatuses: [STATUS.PAID],
  },
  [STATUS.REVIEW]: {
    value: STATUS.REVIEW,
    hebrewLabel: 'בדיקה ידנית',
    customerLabel: null,
    description: 'Flagged for manual price review by Eden.',
    lifecycleOrder: null,
    isTerminal: false,
    isLiveGps: false,
    queueBucket: QUEUE_BUCKETS.INBOX,
    nextStatuses: [STATUS.PAYMENT_SENT],
  },
  [STATUS.PAYMENT_SENT]: {
    value: STATUS.PAYMENT_SENT,
    hebrewLabel: 'קישור תשלום נשלח',
    customerLabel: 'קישור תשלום נשלח',
    description: 'Payment link sent; awaiting payment.',
    lifecycleOrder: 2,
    isTerminal: false,
    isLiveGps: false,
    queueBucket: QUEUE_BUCKETS.AWAITING_PAYMENT,
    nextStatuses: [STATUS.PAID],
  },
  [STATUS.PAID]: {
    value: STATUS.PAID,
    hebrewLabel: 'שולם',
    customerLabel: 'שולם',
    description: 'Paid; ready for dispatch.',
    lifecycleOrder: 3,
    isTerminal: false,
    isLiveGps: false,
    queueBucket: QUEUE_BUCKETS.READY_FOR_PICKUP,
    nextStatuses: [STATUS.TO_PICKUP],
  },
  [STATUS.TO_PICKUP]: {
    value: STATUS.TO_PICKUP,
    hebrewLabel: 'בדרך לאיסוף',
    customerLabel: 'שליח בדרך לאיסוף',
    description: 'Courier en route to pickup (live GPS).',
    lifecycleOrder: 4,
    isTerminal: false,
    isLiveGps: true,
    queueBucket: QUEUE_BUCKETS.IN_PROGRESS,
    nextStatuses: [STATUS.PICKED_UP],
  },
  [STATUS.PICKED_UP]: {
    value: STATUS.PICKED_UP,
    hebrewLabel: 'נאסף',
    customerLabel: 'נאסף',
    description: 'Package picked up.',
    lifecycleOrder: 5,
    isTerminal: false,
    isLiveGps: false,
    queueBucket: QUEUE_BUCKETS.IN_PROGRESS,
    nextStatuses: [STATUS.TO_DROPOFF],
  },
  [STATUS.TO_DROPOFF]: {
    value: STATUS.TO_DROPOFF,
    hebrewLabel: 'בדרך למסירה',
    customerLabel: 'שליח בדרך למסירה',
    description: 'Courier en route to drop-off (live GPS).',
    lifecycleOrder: 6,
    isTerminal: false,
    isLiveGps: true,
    queueBucket: QUEUE_BUCKETS.IN_PROGRESS,
    nextStatuses: [STATUS.DELIVERED, STATUS.FAILED],
  },
  [STATUS.DELIVERED]: {
    value: STATUS.DELIVERED,
    hebrewLabel: 'נמסר',
    customerLabel: 'נמסר',
    description: 'Delivered successfully.',
    lifecycleOrder: 7,
    isTerminal: true,
    isLiveGps: false,
    queueBucket: QUEUE_BUCKETS.DONE,
    nextStatuses: [],
  },
  [STATUS.FAILED]: {
    value: STATUS.FAILED,
    hebrewLabel: 'נכשל',
    customerLabel: null,
    description: 'Delivery attempt failed.',
    lifecycleOrder: null,
    isTerminal: true,
    isLiveGps: false,
    queueBucket: QUEUE_BUCKETS.PROBLEM,
    nextStatuses: [],
  },
  [STATUS.CANCELLED]: {
    value: STATUS.CANCELLED,
    hebrewLabel: 'בוטל',
    customerLabel: null,
    description: 'Order cancelled.',
    lifecycleOrder: null,
    isTerminal: true,
    isLiveGps: false,
    queueBucket: QUEUE_BUCKETS.PROBLEM,
    nextStatuses: [],
  },
  [STATUS.REFUND_PENDING]: {
    value: STATUS.REFUND_PENDING,
    hebrewLabel: 'ממתין לזיכוי',
    customerLabel: null,
    description: 'Refund in progress.',
    lifecycleOrder: null,
    isTerminal: false,
    isLiveGps: false,
    queueBucket: QUEUE_BUCKETS.PROBLEM,
    nextStatuses: [],
  },
};

// ---- helpers ----

export function getStatusMeta(status) {
  return STATUS_META[status] || null;
}

export function getStatusLabel(status) {
  return (STATUS_META[status] && STATUS_META[status].hebrewLabel) || status || '—';
}

export function getCustomerStatusLabel(status) {
  return (STATUS_META[status] && STATUS_META[status].customerLabel) || null;
}

export function isTerminalStatus(status) {
  return !!(STATUS_META[status] && STATUS_META[status].isTerminal);
}

export function isLiveGpsStatus(status) {
  return !!(STATUS_META[status] && STATUS_META[status].isLiveGps);
}

export function getQueueBucket(status) {
  return (STATUS_META[status] && STATUS_META[status].queueBucket) || null;
}

export function getNextStatuses(status) {
  return (STATUS_META[status] && STATUS_META[status].nextStatuses.slice()) || [];
}

// Comparator for sorting statuses by customer lifecycle order (nulls/unknown last).
export function compareStatusOrder(a, b) {
  const oa = STATUS_META[a] && STATUS_META[a].lifecycleOrder != null ? STATUS_META[a].lifecycleOrder : Infinity;
  const ob = STATUS_META[b] && STATUS_META[b].lifecycleOrder != null ? STATUS_META[b].lifecycleOrder : Infinity;
  return oa - ob;
}

// ---- shape builders consumed by pages.js (server-serialised into the browser) ----

// Customer-visible tracking timeline: [[value, label], ...] in lifecycle order.
// Replaces the hardcoded FLOW literal in pages.js.
export function customerFlow() {
  return Object.values(STATUS_META)
    .filter((m) => m.customerLabel != null)
    .sort((a, b) => (a.lifecycleOrder ?? Infinity) - (b.lifecycleOrder ?? Infinity))
    .map((m) => [m.value, m.customerLabel]);
}

// Statuses during which the live-GPS map renders. Replaces the LIVE literal.
export function liveGpsStatuses() {
  return Object.values(STATUS_META).filter((m) => m.isLiveGps).map((m) => m.value);
}

// {value: hebrewLabel} for the ops status pill. Replaces the HE literal.
export function opsLabelMap() {
  const out = {};
  for (const meta of Object.values(STATUS_META)) out[meta.value] = meta.hebrewLabel;
  return out;
}

// Ops dashboard queue layout (PR6): ordered buckets with Hebrew labels. Problem is
// placed before Done so exceptions stay visible above the collapsed "done" section.
// The status->bucket mapping comes from STATUS_META.queueBucket (see queueStatusMap).
export const QUEUE_LAYOUT = [
  { bucket: 'inbox',            hebrewLabel: 'חדשות',         hint: 'התקבלו / ממתינות לאישור מחיר' },
  { bucket: 'awaiting_payment', hebrewLabel: 'ממתינות לתשלום', hint: 'קישור תשלום נשלח — ממתין ללקוח' },
  { bucket: 'ready_for_pickup', hebrewLabel: 'מוכנות לאיסוף',  hint: 'שולם — מוכן ליציאה' },
  { bucket: 'in_progress',      hebrewLabel: 'בדרך',          hint: 'שליח בפעולה (GPS חי)' },
  { bucket: 'problem',          hebrewLabel: 'בעיות / חריגים', hint: 'נכשל / בוטל / החזר' },
  { bucket: 'done',             hebrewLabel: 'הושלם',         hint: 'נמסר בהצלחה' },
];

// {statusValue: bucket} for client-side grouping in the ops dashboard.
export function queueStatusMap() {
  const m = {};
  for (const meta of Object.values(STATUS_META)) m[meta.value] = meta.queueBucket;
  return m;
}
