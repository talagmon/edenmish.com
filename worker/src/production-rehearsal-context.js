// This capability exists only inside the Worker. HTTP headers/body cannot mint it.
export const productionRehearsal = Symbol('production-rehearsal-context');
export const PRODUCTION_REHEARSAL_ORIGIN = 'https://find.edenmish.com';
export const PRODUCTION_REHEARSAL_SETTING_KEYS = [
  'PAYMENT_REHEARSAL_CONFIG', 'PAYMENT_REHEARSAL_ENABLED', 'PAYMENT_REHEARSAL_APP_ENABLED',
  'WHATSAPP_BOOKING_FULL_CONFIG', 'WHATSAPP_BOOKING_ENABLED', 'WHATSAPP_BOOKING_SEND_ENABLED',
  'WHATSAPP_BOOKING_MODEL_ENABLED', 'WHATSAPP_BOOKING_FULL_APPROVED', 'WHATSAPP_BOOKING_FULL_SCHEMA_READY',
  'WHATSAPP_BOOKING_DURABLE_READY', 'WHATSAPP_BOOKING_STORAGE_READY', 'WHATSAPP_BOOKING_PRIVACY_APPROVED',
  'WHATSAPP_BOOKING_MODE', 'WHATSAPP_BOOKING_MULTILINGUAL_ENABLED', 'WHATSAPP_BOOKING_MODEL',
  'WHATSAPP_BOOKING_REASONING_EFFORT', 'WHATSAPP_BOOKING_PROVIDER',
  'WHATSAPP_BOOKING_MODEL_PRIVACY_APPROVED', 'WHATSAPP_BOOKING_MODEL_EVAL_APPROVED', 'WHATSAPP_BOOKING_MODEL_SPEND_APPROVED',
  'TWILIO_ACCOUNT_SID', 'TWILIO_BOOKING_FROM', 'TWILIO_BOOKING_WEBHOOK_URL',
  'TWILIO_RECIPIENT_ALLOWLIST', 'TWILIO_RECIPIENT_POLICY',
];
const keys = new Set(PRODUCTION_REHEARSAL_SETTING_KEYS);

// All overrides are request-local. Never mutate the deployed environment or normal
// dispatch/recipient/session settings. Secret values remain existing opaque bindings.
export function productionRehearsalEnvironment(env) {
  let settings;
  try {
    if (typeof env.PRODUCTION_REHEARSAL_SETTINGS !== 'string' || env.PRODUCTION_REHEARSAL_SETTINGS.length > 20000) return null;
    settings = JSON.parse(env.PRODUCTION_REHEARSAL_SETTINGS);
    if (!settings || Array.isArray(settings) || Object.keys(settings).some(k => !keys.has(k) || typeof settings[k] !== 'string')) return null;
    if (!Object.hasOwn(settings, 'PAYMENT_REHEARSAL_CONFIG') || !Object.hasOwn(settings, 'WHATSAPP_BOOKING_FULL_CONFIG')) return null;
  } catch { return null; }
  return {
    ...env, ...settings, [productionRehearsal]: true,
    BOOKING_URL: PRODUCTION_REHEARSAL_ORIGIN,
    // Production may use its historical alias. The isolated catalog audit must
    // use the merchant-confirmed canonical domain without changing ordinary calls.
    SHOPIFY_SHOP: (() => { try {
      const shop = JSON.parse(settings.PAYMENT_REHEARSAL_CONFIG).shop;
      return ['edenmish.myshopify.com', 'r013gt-fc.myshopify.com'].includes(shop) ? shop : '';
    } catch { return ''; } })(),
    AUTO_DRIVER_DISPATCH: 'off', SHOPIFY_WEBHOOK_REGISTRATION: 'off',
    DRIVER_REVIEW_CODE: env.PRODUCTION_REHEARSAL_REVIEW_CODE,
    OPS_EMAIL: (() => { try { return JSON.parse(settings.PAYMENT_REHEARSAL_CONFIG).ops_email; } catch { return ''; } })(),
    EMAIL_RECIPIENT_POLICY: 'allowlist',
    EMAIL_RECIPIENT_ALLOWLIST: (() => { try { const r=JSON.parse(settings.PAYMENT_REHEARSAL_CONFIG); return [r.email,r.ops_email].join(','); } catch { return ''; } })(),
    TWILIO_AUTH_TOKEN: env.PRODUCTION_REHEARSAL_TWILIO_AUTH_TOKEN,
    WHATSAPP_BOOKING_FULL_OPENAI_API_KEY: env.PRODUCTION_REHEARSAL_OPENAI_API_KEY,
    WHATSAPP_BOOKING_QUEUE: env.PRODUCTION_REHEARSAL_QUEUE,
  };
}

export function productionRehearsalPath(path) {
  return path.startsWith('/api/rehearsal/driver/v1/')
    || ['/rehearsal-ops', '/webhooks/twilio/booking', '/webhooks/twilio/booking/status'].includes(path)
    || path.startsWith('/api/ops/payment-rehearsal/')
    || path.startsWith('/api/ops/whatsapp/full/');
  // Archival uses the permanent order marker and ordinary authenticated Ops
  // boundary, so it remains available after admission settings are removed.
}
