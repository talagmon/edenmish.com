// Immutable pilot identity/window and serialized model spend. All amounts are
// integer USD microdollars; these rows are intentionally not retention-cleaned.
export const LUNA_PILOT_LIMITS = Object.freeze({ inbound: 24, outbound: 24, address: 8,
  model: 20, modelMicros: 500000, reserveMicros: 300000, inputTokens: 1050000,
  outputTokens: 1024, timeoutMs: 10000 });
export const LUNA_READINESS_LIMITS = Object.freeze({ inputTokens: 4096, outputTokens: 512,
  requestBytes: 8192, reserveMicros: 100000 });
const reservationFor = (env, id) => id.startsWith(`${env.WHATSAPP_BOOKING_PILOT_ID}:readiness:`)
  ? LUNA_READINESS_LIMITS.reserveMicros : LUNA_PILOT_LIMITS.reserveMicros;
export const lunaPilot = env => env.WHATSAPP_BOOKING_MODE === 'conversation_only'
  && env.WHATSAPP_BOOKING_PILOT_PROFILE === 'luna-v1';

export function lunaPilotConfiguration(env) {
  return lunaPilot(env) && env.BOOKING_URL === 'https://staging.edenmish.com'
    && env.WHATSAPP_BOOKING_PROVIDER === 'twilio' && env.AUTO_DRIVER_DISPATCH === 'off'
    && env.WHATSAPP_BOOKING_PILOT_BUDGET_READY === 'on'
    && env.WHATSAPP_BOOKING_MODEL === 'gpt-6-luna'
    && /^sk-[A-Za-z0-9_-]{12,}$/.test(env.WHATSAPP_BOOKING_OPENAI_API_KEY || '')
    && env.WHATSAPP_BOOKING_MODEL_PRIVACY_APPROVED === 'on'
    && env.WHATSAPP_BOOKING_MODEL_SPEND_APPROVED === 'on'
    && env.TWILIO_RECIPIENT_POLICY === 'allowlist'
    && /^\+972\d{8,9}$/.test(env.TWILIO_RECIPIENT_ALLOWLIST || '')
    && /^whatsapp:\+\d{8,15}$/.test(env.TWILIO_BOOKING_FROM || '')
    && /^AC[a-f0-9]{32}$/i.test(env.TWILIO_ACCOUNT_SID || '')
    && /^edenmish-luna-[a-z0-9-]{4,40}$/.test(env.WHATSAPP_BOOKING_PILOT_ID || '');
}
export function lunaPilotWindow(env, now = Date.now()) {
  const start = Date.parse(env.WHATSAPP_BOOKING_PILOT_STARTED_AT || '');
  const end = Date.parse(env.WHATSAPP_BOOKING_PILOT_EXPIRES_AT || '');
  return Number.isFinite(start) && Number.isFinite(end) && end > start
    && end - start <= 3600000 && now >= start && now < end ? { start, end } : null;
}
export function lunaPilotCanRun(env, now = Date.now(), readiness = false) {
  if (!lunaPilotConfiguration(env)) return false;
  if (readiness) {
    const deadline = Date.parse(env.WHATSAPP_BOOKING_READINESS_EXPIRES_AT || '');
    return env.WHATSAPP_BOOKING_READINESS_APPROVED === 'on'
      && env.WHATSAPP_BOOKING_ENABLED === 'off' && env.WHATSAPP_BOOKING_SEND_ENABLED === 'off'
      && env.WHATSAPP_BOOKING_MODEL_ENABLED === 'off'
      && !env.WHATSAPP_BOOKING_PILOT_STARTED_AT && !env.WHATSAPP_BOOKING_PILOT_EXPIRES_AT
      && Number.isFinite(deadline) && deadline > now && deadline <= now + 3600000;
  }
  return env.WHATSAPP_BOOKING_ENABLED === 'on' && env.WHATSAPP_BOOKING_SEND_ENABLED === 'on'
    && env.WHATSAPP_BOOKING_MODEL_ENABLED === 'on'
    && env.WHATSAPP_BOOKING_MODEL_EVAL_APPROVED === 'on' && !!lunaPilotWindow(env, now);
}
async function bindingHash(env) {
  const values = ['luna-v1', env.WHATSAPP_BOOKING_PILOT_ID, env.TWILIO_ACCOUNT_SID,
    env.TWILIO_BOOKING_FROM, env.TWILIO_RECIPIENT_ALLOWLIST, env.BOOKING_URL, LUNA_PILOT_LIMITS, LUNA_READINESS_LIMITS];
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(values)));
  return [...new Uint8Array(bytes)].map(x => x.toString(16).padStart(2, '0')).join('');
}
const changes = result => Number(result?.meta?.changes || 0);

export async function ensureLunaPilotBudget(env, now = Date.now(), readiness = false, allowStopped = false) {
  if (!lunaPilotCanRun(env, now, readiness)) return null;
  const hash = await bindingHash(env), id = env.WHATSAPP_BOOKING_PILOT_ID;
  const window = readiness ? null : lunaPilotWindow(env, now);
  await env.DB.prepare(`INSERT OR IGNORE INTO whatsapp_pilot_budgets
    (pilot_id,binding_hash,started_at,expires_at,created_at,updated_at) VALUES (?,?,?,?,?,?)`)
    .bind(id,hash,window?.start ?? null,window?.end ?? null,now,now).run();
  // Readiness spends in the same pool before the WhatsApp hour starts. Pin the
  // live window once only; a redeploy cannot move or extend it under the same ID.
  if (window) await env.DB.prepare(`UPDATE whatsapp_pilot_budgets SET started_at=?,expires_at=?,updated_at=?
    WHERE pilot_id=? AND binding_hash=? AND started_at IS NULL AND expires_at IS NULL
    AND lock_id IS NULL AND stopped_reason IS NULL`).bind(window.start,window.end,now,id,hash).run();
  const row = await env.DB.prepare('SELECT * FROM whatsapp_pilot_budgets WHERE pilot_id=?').bind(id).first();
  if (!row || row.binding_hash !== hash || (!allowStopped && row.stopped_reason)
    || (readiness ? row.started_at !== null : row.started_at !== window.start || row.expires_at !== window.end)) return null;
  return row;
}
export async function reserveLunaPilotModel(env, now = Date.now(), readiness = false, readinessCase = null) {
  const row = await ensureLunaPilotBudget(env, now, readiness);
  if (!row) return null;
  if (readinessCase !== null && (!readiness || !/^[a-z_]{3,40}$/.test(readinessCase))) return null;
  const id = readiness ? `${row.pilot_id}:readiness:${readinessCase || crypto.randomUUID()}` : crypto.randomUUID();
  const reserve = reservationFor(env, id);
  const result = await env.DB.batch([
    env.DB.prepare(`UPDATE whatsapp_pilot_budgets SET attempts=attempts+1,charged_micros=charged_micros+?,lock_id=?,updated_at=?
      WHERE pilot_id=? AND binding_hash=? AND lock_id IS NULL AND stopped_reason IS NULL
      AND attempts < ? AND charged_micros <= ?
      AND NOT EXISTS (SELECT 1 FROM whatsapp_pilot_model_attempts WHERE id=?)`)
      .bind(reserve,id,now,row.pilot_id,row.binding_hash,LUNA_PILOT_LIMITS.model,LUNA_PILOT_LIMITS.modelMicros-reserve,id),
    env.DB.prepare(`INSERT OR IGNORE INTO whatsapp_pilot_model_attempts (id,pilot_id,status,charged_micros,created_at,readiness_case)
      SELECT ?,pilot_id,'pending',?,?,? FROM whatsapp_pilot_budgets WHERE pilot_id=? AND lock_id=?`)
      .bind(id,reserve,now,readinessCase,row.pilot_id,id),
  ]);
  return changes(result[0]) && changes(result[1]) ? id : null;
}
export function lunaUsageUpperMicros(usage) {
  const input = usage?.input_tokens, output = usage?.output_tokens;
  if (!Number.isSafeInteger(input) || input < 0 || input > LUNA_PILOT_LIMITS.inputTokens
    || !Number.isSafeInteger(output) || output < 0 || output > LUNA_PILOT_LIMITS.outputTokens
    || usage.total_tokens !== input + output) return null;
  // Long-context cache-write input and output tariff, plus 10% regional margin.
  return Math.ceil((input + 3 * output) * 11 / 40);
}
const OUTCOMES = new Set(['valid_proposal','http_error','transport_failure','timeout','expired',
  'readiness_mismatch','input_token_count','input_limit','response_size','response_json','response_envelope','refusal','proposal_json','proposal_schema','usage_unverified']);
export async function finishLunaPilotModel(env, id, { outcome, usage, elapsedMs, httpStatus }, now = Date.now()) {
  if (!OUTCOMES.has(outcome)) outcome = 'response_envelope';
  const reserve = reservationFor(env, id);
  const upper = lunaUsageUpperMicros(usage);
  const valid = outcome === 'valid_proposal' && upper !== null && upper <= reserve;
  if (outcome === 'valid_proposal' && !valid) outcome = 'usage_unverified';
  // Keep the readiness allocation even on success, including counting/fee margin.
  const charge = valid && reserve === LUNA_PILOT_LIMITS.reserveMicros ? upper : reserve;
  const elapsed = Number.isSafeInteger(elapsedMs) && elapsedMs >= 0 ? Math.min(elapsedMs, 3600000) : null;
  // Both records settle atomically and once. A duplicate/late callback cannot
  // refund an uncertain reservation or unlock another request's lease.
  await env.DB.batch([
    env.DB.prepare(`UPDATE whatsapp_pilot_model_attempts SET status=?,charged_micros=?,input_tokens=?,output_tokens=?,outcome=?,elapsed_ms=?,http_status=?
      WHERE id=? AND pilot_id=? AND status='pending'`)
      .bind(valid?'settled':'uncertain',charge,valid?usage.input_tokens:null,valid?usage.output_tokens:null,outcome,elapsed,Number.isInteger(httpStatus) && httpStatus>=100 && httpStatus<=599 ? httpStatus : null,id,env.WHATSAPP_BOOKING_PILOT_ID),
    env.DB.prepare(`UPDATE whatsapp_pilot_budgets SET charged_micros=charged_micros-?+?,lock_id=NULL,stopped_reason=?,updated_at=?
      WHERE pilot_id=? AND lock_id=?`)
      .bind(reserve,charge,valid?null:outcome,now,env.WHATSAPP_BOOKING_PILOT_ID,id),
  ]);
}
