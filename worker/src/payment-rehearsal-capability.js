import { productionRehearsal, PRODUCTION_REHEARSAL_ORIGIN } from './production-rehearsal-context.js';
// Internal authority only. JSON/body/header customer input cannot mint this grant.
export const REHEARSAL_ORIGIN = 'https://edenmish-ops-staging.edenmish.workers.dev';
export const rehearsalOrigin = env => env[productionRehearsal] ? PRODUCTION_REHEARSAL_ORIGIN : REHEARSAL_ORIGIN;
export const REHEARSAL_PRODUCT = 'gid://shopify/Product/15422576689469';
export const REHEARSAL_SHOP = 'gid://shopify/Shop/100603396413';
export const rehearsalSelected = env => Object.hasOwn(env, 'PAYMENT_REHEARSAL_CONFIG');
const flags = ['WHATSAPP_BOOKING_ENABLED','WHATSAPP_BOOKING_SEND_ENABLED','WHATSAPP_BOOKING_MODEL_ENABLED'];
const fields = ['version','run_id','starts_at','expires_at','shop','variant_id','phone','email','ops_email'];
export function rehearsalSpec(env) {
  try {
    const r=JSON.parse(env.PAYMENT_REHEARSAL_CONFIG);
    if (!r || Object.keys(r).length!==fields.length || !fields.every(k=>Object.hasOwn(r,k)) || r.version!==1
      || !/^[a-z0-9-]{8,64}$/.test(r.run_id) || !Number.isSafeInteger(r.starts_at) || r.starts_at<=0
      || !Number.isSafeInteger(r.expires_at) || r.expires_at<=r.starts_at || r.expires_at-r.starts_at>1800000
      || !['edenmish.myshopify.com','r013gt-fc.myshopify.com'].includes(r.shop)
      || !/^gid:\/\/shopify\/ProductVariant\/\d+$/.test(r.variant_id)
      || ['52017093312829','52017093345597','52017093378365'].includes(r.variant_id.split('/').pop())
      || !/^\+972[1-9]\d{7,8}$/.test(r.phone)
      || [r.email,r.ops_email].some(v=>typeof v!=='string'||v!==v.toLowerCase()||! /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v))) return null;
    if (typeof env.WHATSAPP_BOOKING_FULL_CONFIG!=='string' || env.BOOKING_URL!==rehearsalOrigin(env) || env.SHOPIFY_SHOP!==r.shop || env.AUTO_DRIVER_DISPATCH!=='off'
      || env.SHOPIFY_WEBHOOK_REGISTRATION!=='off' || env.PAYMENT_MODE==='preauth' || env.TEST_MODE==='1'||env.TEST_MODE==='true') return null;
    return Object.fromEntries(fields.map(k=>[k,r[k]]));
  } catch { return null; }
}
async function storedSpec(env,r) {
  if(!env.SESSION_SECRET)throw Error('rehearsal_session_secret_required');
  const enc=new TextEncoder(),key=await crypto.subtle.importKey('raw',enc.encode(env.SESSION_SECRET),{name:'HMAC',hash:'SHA-256'},false,['sign']);
  const stored={...r};
  for(const field of ['phone','email','ops_email']) {
    stored[field+'_digest']=Array.from(new Uint8Array(await crypto.subtle.sign('HMAC',key,enc.encode('rehearsal:'+field+':'+r[field]))),b=>b.toString(16).padStart(2,'0')).join('');
    delete stored[field];
  }
  return JSON.stringify(stored);
}
export async function issueRehearsalRun(env, body, now=Date.now()) {
  const r=rehearsalSpec(env);
  if (!r || env.PAYMENT_REHEARSAL_ENABLED!=='off'||!flags.every(k=>env[k]==='off')
    || !body || Object.keys(body).sort().join(',')!=='approve,run_id,version' || body.approve!==true
    || body.version!==1 || body.run_id!==r.run_id || now>=r.expires_at) return false;
  const stored=await storedSpec(env,r);
  await env.DB.prepare(`INSERT OR IGNORE INTO payment_rehearsal_runs(id,config_json,starts_at,expires_at,created_at) VALUES(?,?,?,?,?)`)
    .bind(r.run_id,stored,r.starts_at,r.expires_at,now).run();
  const row=await env.DB.prepare('SELECT * FROM payment_rehearsal_runs WHERE id=?').bind(r.run_id).first();
  return row?.config_json===stored && row.stopped_at==null;
}
export async function activeRehearsal(env, input=null, now=Date.now()) {
  const r=rehearsalSpec(env);
  if (!r || env.PAYMENT_REHEARSAL_ENABLED!=='on'||!flags.every(k=>env[k]==='on')||now<r.starts_at||now>=r.expires_at) return null;
  if (input && (input.phone!==r.phone || input.email!==r.email || input.service!=='standard'
    || input.use_wallet || input.customer_type==='business'||input.coupon_code||input.promotion_expected)) return null;
  const row=await env.DB.prepare('SELECT * FROM payment_rehearsal_runs WHERE id=?').bind(r.run_id).first();
  return row?.config_json===await storedSpec(env,r) && row.stopped_at==null ? {...r,order_token:row.order_token} : null;
}
export async function claimRehearsalOrder(env,input,token,now=Date.now()) {
  const r=await activeRehearsal(env,input,now);
  if(!r || !/^[a-f0-9]{22,64}$/.test(token||''))return null;
  const row=await env.DB.prepare(`UPDATE payment_rehearsal_runs SET order_token=?
    WHERE id=? AND order_token IS NULL AND stopped_at IS NULL AND starts_at<=? AND expires_at>? RETURNING id`)
    .bind(token,r.run_id,now,now).first();
  return row ? r : null; // even the same token never re-executes an uncertain creation
}
export async function claimRehearsalCharge(env,order,price,now=Date.now()) {
  const r=await activeRehearsal(env,order,now);
  if (!r||price!==1||Number(order.price)!==1||order.rehearsal_run_id!==r.run_id||r.order_token!==order.token||order.rehearsal_closed_at) return null;
  const row=await env.DB.prepare(`UPDATE payment_rehearsal_runs SET charge_attempt_at=?
    WHERE id=? AND charge_attempt_at IS NULL AND stopped_at IS NULL AND starts_at<=? AND expires_at>?
    AND EXISTS(SELECT 1 FROM orders WHERE id=? AND token=order_token AND rehearsal_run_id=payment_rehearsal_runs.id AND rehearsal_closed_at IS NULL)
    RETURNING id`).bind(now,r.run_id,now,now,order.id).first();
  return row ? r : null;
}
export async function stopRehearsal(env,now=Date.now()) {
  const r=rehearsalSpec(env); if(!r)return false;
  await env.DB.prepare('UPDATE payment_rehearsal_runs SET stopped_at=? WHERE id=? AND stopped_at IS NULL').bind(now,r.run_id).run();
  return true;
}
export async function rehearsalStopped(env) {
  const r=rehearsalSpec(env);if(!r)return false;
  const row=await env.DB.prepare('SELECT config_json,stopped_at FROM payment_rehearsal_runs WHERE id=?').bind(r.run_id).first();
  return Number(row?.stopped_at)>0 && row.config_json===await storedSpec(env,r);
}

// Orders webhooks do not promise draft_order_id. Match the signed immutable
// line references we placed on the dedicated draft instead; never infer by email.
export async function rehearsalPaymentReferenceMatches(DB,order,parsed) {
  if(!order.shopify_draft_order_id || parsed.token!==order.token)return false;
  if(parsed.draftOrderId && String(parsed.draftOrderId)!==String(order.shopify_draft_order_id))return false;
  const row=await DB.prepare('SELECT config_json FROM payment_rehearsal_runs WHERE id=? AND order_token=?')
    .bind(order.rehearsal_run_id,order.token).first();
  if(!row)return false;
  const r=JSON.parse(row.config_json),lines=parsed.raw?.line_items;
  if(!Array.isArray(lines)||lines.length!==1)return false;
  const line=lines[0],props=line.properties;
  const exactProperty=(name,value)=>Array.isArray(props)&&props.filter(p=>p.name===name).length===1&&props.some(p=>p.name===name&&p.value===value);
  return line.quantity===1 && String(line.variant_id)===r.variant_id.split('/').pop()
    &&exactProperty('_tracking_token',order.token)&&exactProperty('_edenmish_rehearsal_id',order.rehearsal_run_id);
}
