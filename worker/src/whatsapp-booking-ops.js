import { continuationIssuable } from './whatsapp-continuation.js';
import { lunaPilotCanRun, readinessAttemptId } from './whatsapp-pilot-budget.js';
// Staging pilot controls reuse the existing Ops session and booking APIs.
export function bookingPilotOpsPage(req, env) {
  const url = new URL(req.url);
  if (url.pathname !== '/pilot-ops') return null;
  if (req.method !== 'GET' || url.hostname !== 'ops-staging.edenmish.com'
    || env.BOOKING_URL !== 'https://staging.edenmish.com'
    || env.WHATSAPP_BOOKING_MODE !== 'conversation_only') return new Response('Not found', { status: 404 });
  const attemptId = readinessAttemptId(env, 'small_item');
  const readiness = attemptId && env.WHATSAPP_BOOKING_READINESS_CASE === 'small_item' && lunaPilotCanRun(env, Date.now(), true)
    ? { caseId: 'small_item', id: attemptId,
      expiresAt: Date.parse(env.WHATSAPP_BOOKING_READINESS_EXPIRES_AT) } : null;
  const grant = continuationIssuable(env) ? {id:env.WHATSAPP_BOOKING_CONTINUATION_ID,version:Number(env.WHATSAPP_BOOKING_CONTINUATION_VERSION),startsAt:Date.parse(env.WHATSAPP_BOOKING_CONTINUATION_START)} : null;
  return new Response(`<!doctype html><html lang="he" dir="rtl"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>EdenMish — בקרת בדיקת WhatsApp</title>
<style>body{font-family:system-ui;background:#faf8fc;color:#302938;max-width:700px;margin:32px auto;padding:20px}section,article{background:white;border:1px solid #ded4e9;border-radius:18px;padding:20px;margin:16px 0}button,input{font:inherit;padding:12px;border-radius:12px;border:1px solid #5b2a86}button{background:#5b2a86;color:white;cursor:pointer}button:disabled{opacity:.5}p{line-height:1.6}#status{white-space:pre-wrap}</style></head><body>
<h1>בקרת בדיקת WhatsApp</h1><p>סביבת בדיקה בלבד. לא ייווצרו הזמנות, תשלומים, אימיילים או משימות נהג.</p>
<section id="login"><form id="auth"><label for="pin">PIN תפעול בסביבת הבדיקה</label><br><input id="pin" type="password" inputmode="numeric" autocomplete="current-password" required><button>כניסה</button></form></section>
<section id="controls" hidden><button id="refresh">רענון</button> <button id="logout">יציאה</button>
<section id="readiness" hidden><p>בדיקת Luna אחת עם משפט דמיוני בלבד. נשמרת הקצבה של $0.10 מתוך התקציב המאושר. בדיקת הלקוחות לא מתחילה.</p>
<button id="run-readiness" disabled>הפעלת בדיקת Luna אחת</button><p id="readiness-status" role="status" aria-live="polite"></p><pre id="readiness-result" dir="ltr" style="white-space:pre-wrap;overflow-wrap:anywhere"></pre></section>
<section id="grant" hidden><p>הכנת המשך הבדיקה שאושר. ההודעות נשארות כבויות עד להפעלה הנפרדת.</p><button id="issue-grant" disabled>הכנת בדיקת ההמשך פעם אחת</button><p id="grant-status" role="status"></p></section>
<div id="rows"></div></section>
<p id="status" role="status" aria-live="polite"></p><script>
const $ = id => document.getElementById(id);
const readinessConfig = ${JSON.stringify(readiness)};
const grantConfig = ${JSON.stringify(grant)};
let authenticated = false, readinessSent = false;
const readinessKey = readinessConfig ? 'edenmish-readiness:' + readinessConfig.id : null;
function updateReadiness() {
  updateGrant();
  $('readiness').hidden = !readinessConfig;
  if (!readinessConfig) return;
  try { if (localStorage.getItem(readinessKey)) readinessSent = true; }
  catch { readinessSent = true; $('readiness-status').textContent = 'לא ניתן לשמור נעילה לבדיקה. לא נשלחה בקשה.'; }
  $('run-readiness').disabled = !authenticated || readinessSent || Date.now() >= readinessConfig.expiresAt;
  if (readinessSent && !$('readiness-status').textContent) $('readiness-status').textContent = 'הבדיקה כבר סומנה כנשלחה. אין לשלוח שוב; יש לבדוק את התוצאה עם המפעיל.';
  if (!readinessSent && Date.now() >= readinessConfig.expiresAt) $('readiness-status').textContent = 'פג תוקף האישור לבדיקה. לא תישלח בקשה.';
}
$('run-readiness').onclick = async () => {
  updateReadiness();
  if (!readinessConfig || $('run-readiness').disabled) return;
  readinessSent = true; $('run-readiness').disabled = true;
  // Persist only the attempt marker, never credentials or model/customer text.
  // A reload/interruption cannot offer an automatic retry. D1 deduplicates tabs.
  try { localStorage.setItem(readinessKey, 'submitted'); }
  catch { $('readiness-status').textContent = 'לא ניתן לשמור נעילה לבדיקה. לא נשלחה בקשה.'; return; }
  $('readiness-status').textContent = 'הבדיקה נשלחת פעם אחת. אין ללחוץ שוב או לטעון מחדש.';
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 15000);
  try {
    const r = await fetch('/api/ops/whatsapp/pilot/readiness', { method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({case_id: readinessConfig.caseId, attempt_id:readinessConfig.id}), signal: controller.signal });
    const data = await r.json(), d = data.diagnostic, s = d?.synthetic;
    const outcomes = ['valid_proposal','http_error','transport_failure','timeout','expired','readiness_mismatch','input_token_count','input_limit','response_size','response_json','response_envelope','refusal','proposal_json','proposal_schema','usage_unverified','pending'];
    const safe = { http_status:r.status, case_id:readinessConfig.caseId, attempt_id:readinessConfig.id, passed:data.passed===true,
      replay:data.replay===true, outcome:outcomes.includes(data.outcome)?data.outcome:'unconfirmed',
      schema_valid:s?.schema_valid===true, elapsed_ms:Number.isSafeInteger(d?.elapsedMs)?d.elapsedMs:null,
      provider_http_status:Number.isInteger(d?.httpStatus)?d.httpStatus:null,
      response_status:['completed','incomplete','failed','cancelled'].includes(s?.response_status)?s.response_status:null,
      provider_error_code:['invalid_api_key','insufficient_quota','model_not_found','rate_limit_exceeded','invalid_json_schema','unsupported_value','context_length_exceeded'].includes(s?.provider_error_code)?s.provider_error_code:null,
      incomplete_reason:['max_output_tokens','content_filter'].includes(s?.incomplete_reason)?s.incomplete_reason:null,
      input_tokens:Number.isSafeInteger(s?.counted_input_tokens)?s.counted_input_tokens:null,
      output_tokens:Number.isSafeInteger(s?.output_tokens)?s.output_tokens:null };
    // The endpoint returns only its fixed fictional answer here. Render as text.
    if (typeof s?.synthetic_output === 'string' && s.synthetic_output.length <= 8000) safe.synthetic_output = s.synthetic_output;
    $('readiness-result').textContent = JSON.stringify(safe, null, 2);
    const passed = r.ok && safe.passed && !safe.replay && safe.outcome==='valid_proposal' && safe.schema_valid;
    $('readiness-status').textContent = passed ? 'בדיקת הפענוח הצליחה. האוטומציה עדיין כבויה.' : 'הבדיקה לא אומתה כהצלחה חדשה. עוצרים כאן; אין לשלוח שוב.';
  } catch { $('readiness-status').textContent = 'התוצאה אינה ודאית. עוצרים כאן; אין לשלוח שוב. יש לבדוק את הרישום עם המפעיל.'; }
  finally { clearTimeout(timer); }
};
function updateGrant() {
  $('grant').hidden=!grantConfig;
  if(!grantConfig)return;
  let sent=true;
  try { sent=!!localStorage.getItem('edenmish-grant:'+grantConfig.id); } catch {}
  $('issue-grant').disabled=!authenticated || sent || Date.now()>grantConfig.startsAt;
}
$('issue-grant').onclick=async()=>{
  updateGrant();if(!grantConfig || $('issue-grant').disabled)return;
  try { localStorage.setItem('edenmish-grant:'+grantConfig.id,'sent'); } catch { $('issue-grant').disabled=true;return; }
  $('issue-grant').disabled=true;
  try {
    const r=await api('whatsapp/pilot/continuation/grant',{grant_id:grantConfig.id,version:grantConfig.version});
    $('grant-status').textContent=r.status===201?'ההרשאה נרשמה. ההודעות עדיין כבויות.':'הפעולה לא אומתה. אין לנסות שוב; נדרשת בדיקת הרישום.';
  } catch { $('grant-status').textContent='התוצאה אינה ודאית. אין לנסות שוב; נדרשת בדיקת הרישום.'; }
};
if(grantConfig)setTimeout(updateGrant,Math.max(0,grantConfig.startsAt-Date.now()+1));
addEventListener('storage', event => { if(event.key === readinessKey) updateReadiness(); });
updateReadiness();
if (readinessConfig) setTimeout(updateReadiness, Math.max(0, readinessConfig.expiresAt-Date.now()));
async function api(path, body) { return fetch('/api/ops/' + path, { method: body ? 'POST' : 'GET', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, ...(body ? {body: JSON.stringify(body)} : {}) }); }
async function refresh() {
  authenticated = false; updateReadiness();
  try {
    const response = await api('whatsapp/bookings');
    if(response.status === 401) { $('login').hidden=false; $('controls').hidden=true; $('rows').replaceChildren(); $('status').textContent='נדרשת כניסה לתפעול.'; return; }
    if(!response.ok) throw new Error();
    const data = await response.json(); authenticated = true; updateReadiness(); $('login').hidden=true; $('controls').hidden=false; $('rows').replaceChildren();
    $('status').textContent=data.disabled ? 'התחברות אומתה. הבדיקה כבויה או שפג תוקפה.' : 'הבדיקה פעילה. עצירה מבטלת תשובות ממתינות; בקשה שכבר נשלחה אינה ניתנת לביטול.';
    for(const row of data.bookings || []) {
      const card=document.createElement('article'), label=document.createElement('p'), button=document.createElement('button');
      label.textContent=row.id+' — '+row.phase; button.textContent='עצירת אוטומציה'; button.disabled=['handoff','closed'].includes(row.phase);
      button.onclick=async()=>{ button.disabled=true; try { const r=await api('whatsapp/bookings/'+encodeURIComponent(row.id)+'/pause',{}); if(r.status===409) { $('status').textContent='בקשה עדיין בתהליך. נסו לעצור שוב בעוד רגע.'; button.disabled=false; return; } if(!r.ok) throw new Error(); await refresh(); } catch { $('status').textContent='העצירה לא אומתה. נסו שוב.'; button.disabled=false; } };
      card.append(label,button); $('rows').append(card);
    }
  } catch { $('status').textContent='לא ניתן לאמת את מצב השרת. אין להניח שהפעולה הצליחה.'; }
}
$('auth').onsubmit=async event=>{ event.preventDefault(); const pin=$('pin').value; $('pin').value=''; try { const r=await api('login',{pin}); if(!r.ok) { $('status').textContent=r.status===429?'ניסיונות הכניסה נחסמו זמנית.':'הכניסה לא הצליחה.'; return; } await refresh(); } catch { $('status').textContent='הכניסה לא אומתה.'; } };
$('refresh').onclick=refresh; $('logout').onclick=async()=>{ try { const r=await api('logout',{}); if(!r.ok) throw new Error(); await refresh(); } catch { $('status').textContent='היציאה לא אומתה.'; } };
refresh();
</script></body></html>`, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'" } });
}
