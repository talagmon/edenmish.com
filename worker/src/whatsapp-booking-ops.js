// Staging pilot controls reuse the existing Ops session and booking APIs.
export function bookingPilotOpsPage(req, env) {
  const url = new URL(req.url);
  if (url.pathname !== '/pilot-ops') return null;
  if (req.method !== 'GET' || url.hostname !== 'ops-staging.edenmish.com'
    || env.BOOKING_URL !== 'https://staging.edenmish.com'
    || env.WHATSAPP_BOOKING_MODE !== 'conversation_only') return new Response('Not found', { status: 404 });
  return new Response(`<!doctype html><html lang="he" dir="rtl"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>EdenMish — בקרת בדיקת WhatsApp</title>
<style>body{font-family:system-ui;background:#faf8fc;color:#302938;max-width:700px;margin:32px auto;padding:20px}section,article{background:white;border:1px solid #ded4e9;border-radius:18px;padding:20px;margin:16px 0}button,input{font:inherit;padding:12px;border-radius:12px;border:1px solid #5b2a86}button{background:#5b2a86;color:white;cursor:pointer}button:disabled{opacity:.5}p{line-height:1.6}#status{white-space:pre-wrap}</style></head><body>
<h1>בקרת בדיקת WhatsApp</h1><p>סביבת בדיקה בלבד. לא ייווצרו הזמנות, תשלומים, אימיילים או משימות נהג.</p>
<section id="login"><form id="auth"><label for="pin">PIN תפעול בסביבת הבדיקה</label><br><input id="pin" type="password" inputmode="numeric" autocomplete="current-password" required><button>כניסה</button></form></section>
<section id="controls" hidden><button id="refresh">רענון</button> <button id="logout">יציאה</button><div id="rows"></div></section>
<p id="status" role="status" aria-live="polite"></p><script>
const $ = id => document.getElementById(id);
async function api(path, body) { return fetch('/api/ops/' + path, { method: body ? 'POST' : 'GET', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, ...(body ? {body: JSON.stringify(body)} : {}) }); }
async function refresh() {
  try {
    const response = await api('whatsapp/bookings');
    if(response.status === 401) { $('login').hidden=false; $('controls').hidden=true; $('rows').replaceChildren(); $('status').textContent='נדרשת כניסה לתפעול.'; return; }
    if(!response.ok) throw new Error();
    const data = await response.json(); $('login').hidden=true; $('controls').hidden=false; $('rows').replaceChildren();
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
