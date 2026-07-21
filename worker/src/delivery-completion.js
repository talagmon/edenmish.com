import { notifyEmail, notifyWhatsApp } from './notify.js';
import { settleOrder } from './payment.js';

const escHtml = (value) => String(value == null ? '' : value).replace(
  /[&<>"']/g,
  (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[character]),
);

const storefrontBase = (env) => (
  env.STOREFRONT_BASE || env.BOOKING_URL || 'https://edenmish.com'
).replace(/\/+$/, '');

const discountLineHtml = (order) => (
  order?.discount_code && Number(order.discount_amount) > 0
    ? `<div style="margin-top:6px"><span style="color:#4b5563;font-size:12px">קופון ${escHtml(order.discount_code)}: </span><b style="color:#246b62;font-size:14px">−₪${Number(order.discount_amount)}</b></div>`
    : ''
);

const SUPPORT_LINE = '<p style="color:#4b5563;font-size:13px;margin-top:14px">לשאלות: eden@edenmish.com · 053-405-8498<br>כתובת העסק למשלוח הודעות: קריניצי 111, רמת גן, ישראל</p>';

export const deliverySummaryHtml = (env, order) => `<div dir="rtl" style="font-family:sans-serif;line-height:1.7;max-width:480px;margin:0 auto;background:#ffffff;color:#1f2937;color-scheme:light;forced-color-adjust:none;padding:32px 24px;border:1px solid #e5e7eb;border-radius:16px"><h1 style="color:#5B2A86;font-size:26px;margin:0 0 8px">המשלוח נמסר בהצלחה! ✓</h1><p style="color:#4b5563;margin:0 0 20px;font-size:15px">תודה שבחרתם ב-EdenMish. המשלוח הגיע ליעד.</p><div style="background:#f7f3fa;border:1px solid #e3d7eb;border-radius:12px;padding:16px;margin-bottom:16px"><div style="margin-bottom:10px"><span style="color:#246b62;font-size:12px;display:block">איסוף</span><b style="font-size:16px;color:#1f2937">${escHtml(order.pickup)}</b></div><div style="margin-bottom:10px"><span style="color:#5B2A86;font-size:12px;display:block">מסירה</span><b style="font-size:16px;color:#1f2937">${escHtml(order.dropoff)}</b></div><div><span style="color:#4b5563;font-size:12px">מחיר </span><b style="color:#246b62;font-size:20px">₪${escHtml(order.price)}</b>${discountLineHtml(order)}</div></div><div style="text-align:center;margin:20px 0"><p style="color:#246b62;font-size:14px;margin:0 0 10px">איך היה השירות? נשמח לדירוג ⭐</p><a href="${storefrontBase(env)}/delivered.html?t=${encodeURIComponent(order.token || '')}" style="display:inline-block;background:#5B2A86;color:#ffffff;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:700">צפו בהוכחת המסירה ודרגו אותנו ←</a></div>${order.shopify_order_id ? '<div style="text-align:center;margin:12px 0;padding:12px;background:#f5f7fa;border-radius:8px"><p style="color:#4b5563;font-size:13px;margin:0">📄 החשבונית נשלחה אליכם במייל נפרד (דרך PayPlus).<br>לצפייה חוזרת: <a href="https://edenmish.myshopify.com/account/orders/' + encodeURIComponent(order.shopify_order_id) + '" style="color:#5B2A86">הזמנת Shopify #' + escHtml(order.shopify_order_id) + '</a></p></div>' : ''}${SUPPORT_LINE}</div>`;

// Shared post-delivery boundary for both the ops dashboard and driver app.
// Call this only when the canonical order status actually changes to delivered;
// that transition is the idempotency guard against duplicate customer messages.
export async function runDeliveryCompletionSideEffects(env, order, { sendWhatsApp = false } = {}) {
  const settlement = await settleOrder(env, order);
  const email = order.email
    ? await notifyEmail(env, env.DB, {
      orderId: order.id,
      template: 'customer_delivery_summary',
      recipient: order.email,
      subject: 'המשלוח מ-EdenMish נמסר ✓',
      html: deliverySummaryHtml(env, order),
    })
    : null;
  const whatsapp = sendWhatsApp
    ? await notifyWhatsApp(env, env.DB, {
      orderId: order.id,
      template: 'customer_delivery_summary',
      recipient: order.phone,
      body: `המשלוח שלך הגיע ✓\n${order.dropoff || ''}\nתודה שבחרת ב-EdenMish!`,
    })
    : null;

  return { settlement, email, whatsapp };
}
