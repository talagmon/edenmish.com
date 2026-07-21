const escapeScript = (value) => JSON.stringify(String(value || '')).replace(/</g, '\\u003c');

export function businessAccountHtml(storefrontBase = 'https://edenmish.com') {
  const storefront = String(storefrontBase).replace(/\/+$/, '');
  return `<!doctype html>
<html lang="he" dir="rtl">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
  <meta name="theme-color" content="#0F172A">
  <title>EdenMish | החשבון העסקי שלי</title>
  <style>
    :root{--navy:#0F172A;--purple:#5B2A86;--lilac:#DFB7FF;--mint:#91D3C8;--ink:#F8FAFC;--muted:#A9B4C5;--line:rgba(223,183,255,.2);--glass:rgba(22,29,48,.78)}
    *{box-sizing:border-box}html{background:var(--navy);color:var(--ink);font-family:Arial,sans-serif}body{margin:0;min-height:100vh;background:radial-gradient(circle at 15% 10%,rgba(91,42,134,.34),transparent 36rem),radial-gradient(circle at 90% 90%,rgba(145,211,200,.13),transparent 32rem)}
    a{color:inherit}.shell{width:min(1120px,100%);margin:auto;padding:18px 16px 64px}.top{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:24px}.brand{font-size:1.45rem;font-weight:900;color:var(--lilac);text-decoration:none}.top-actions{display:flex;gap:8px;align-items:center}
    .card{background:var(--glass);border:1px solid var(--line);border-radius:20px;padding:22px;box-shadow:0 20px 60px rgba(0,0,0,.18);backdrop-filter:blur(18px)}.hidden{display:none!important}.muted{color:var(--muted)}h1,h2,h3,p{margin-top:0}h1{font-size:clamp(1.7rem,6vw,2.5rem);margin-bottom:8px}h2{font-size:1.25rem}.grid{display:grid;gap:16px}.overview{grid-template-columns:repeat(12,1fr)}.balance{grid-column:span 7}.quick{grid-column:span 5}.wide{grid-column:1/-1}
    button,.btn{border:0;border-radius:12px;padding:12px 18px;font:inherit;font-weight:800;cursor:pointer;text-decoration:none;display:inline-flex;align-items:center;justify-content:center;gap:8px}.primary{background:var(--purple);color:white}.secondary{background:var(--mint);color:#102822}.ghost{background:transparent;color:var(--lilac);border:1px solid var(--line)}button:disabled{opacity:.55;cursor:not-allowed}
    label{display:block;color:var(--muted);font-size:.9rem;margin:0 0 7px}.field{margin-bottom:15px}input{width:100%;border:1px solid rgba(223,183,255,.27);background:rgba(15,23,42,.75);color:white;border-radius:12px;padding:14px;font:inherit;outline:0}input:focus{border-color:var(--lilac);box-shadow:0 0 0 3px rgba(223,183,255,.12)}
    .auth{max-width:500px;margin:8vh auto}.otp{display:flex;direction:ltr;gap:7px;justify-content:center;margin:18px 0}.otp input{width:46px;height:56px;text-align:center;font-size:1.45rem;font-weight:900;padding:0}.message{min-height:1.4em;color:var(--mint);margin-top:12px}.error{color:#FCA5A5}
    .amount{font-size:clamp(2.6rem,10vw,4.6rem);font-weight:950;color:var(--mint);line-height:1}.balance-row{display:flex;align-items:flex-end;justify-content:space-between;gap:16px}.pending{margin-top:12px;color:var(--muted)}
    .plans{grid-template-columns:repeat(3,1fr)}.plan{position:relative}.plan.current{border-color:var(--mint)}.plan-name{font-size:1.35rem;font-weight:900}.plan-price{font-size:1.9rem;font-weight:900;color:var(--lilac);margin:10px 0}.tag{display:inline-block;border:1px solid var(--line);border-radius:999px;padding:5px 9px;color:var(--muted);font-size:.78rem}.list{display:grid;gap:10px}.row{display:flex;align-items:center;justify-content:space-between;gap:14px;padding:13px 0;border-bottom:1px solid rgba(255,255,255,.08)}.row:last-child{border-bottom:0}.row-main{min-width:0}.route{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:640px}.positive{color:var(--mint)}.negative{color:#F9A8D4}.ltr{direction:ltr;unicode-bidi:embed}.empty{text-align:center;padding:24px;color:var(--muted)}
    .profile-grid{display:grid;grid-template-columns:1fr 1fr 1fr auto;gap:10px;align-items:end}.notice{background:rgba(145,211,200,.08);border:1px solid rgba(145,211,200,.25);padding:12px;border-radius:12px;color:#C7F3EC;margin-bottom:16px}
    @media(max-width:760px){.balance,.quick{grid-column:1/-1}.plans{grid-template-columns:1fr}.profile-grid{grid-template-columns:1fr}.top{align-items:flex-start}.top-actions{flex-wrap:wrap;justify-content:flex-end}.row{align-items:flex-start}.route{max-width:210px}.otp input{width:42px}}
  </style>
</head>
<body>
<main class="shell">
  <header class="top"><a class="brand" href="${storefront}">EdenMish</a><div class="top-actions"><a class="btn ghost" href="${storefront}/booking.html?business=1">משלוח חדש</a><button id="logout" class="ghost hidden">יציאה</button></div></header>

  <section id="auth" class="auth card">
    <div id="email-step">
      <h1>החשבון העסקי שלך</h1><p class="muted">נשלח אליך קישור כניסה מהיר וגם קוד בן 6 ספרות. אין צורך בסיסמה.</p>
      <form id="email-form"><div class="field"><label for="email">אימייל עסקי</label><input id="email" type="email" dir="ltr" autocomplete="email" required placeholder="name@business.co.il"></div><button class="primary" type="submit">שלחו לי קישור וקוד</button></form>
    </div>
    <div id="code-step" class="hidden">
      <h1>בדקו את האימייל</h1><p class="muted">אפשר ללחוץ על הקישור שקיבלתם או להזין כאן את הקוד.</p>
      <form id="code-form"><div class="otp" aria-label="קוד אימות בן שש ספרות">${Array.from({length:6},(_,i)=>`<input inputmode="numeric" pattern="[0-9]*" maxlength="1" autocomplete="${i===0?'one-time-code':'off'}" aria-label="ספרה ${i+1}">`).join('')}</div><button class="primary" type="submit">כניסה לחשבון</button></form>
      <button id="back-email" class="ghost" type="button">שינוי אימייל</button>
    </div>
    <div id="auth-message" class="message" aria-live="polite"></div>
  </section>

  <section id="dashboard" class="hidden">
    <div class="grid overview">
      <article class="card balance"><p class="muted">יתרה זמינה</p><div class="balance-row"><div class="amount"><span id="balance">0</span> ₪</div><a class="btn primary" href="#plans">טעינת יתרה</a></div><div class="pending">בהמתנה: <b id="reserved">0 ₪</b> · <span id="expiry">אין יתרה שעומדת לפוג</span></div></article>
      <article class="card quick"><h2 id="welcome">שלום</h2><p class="muted" id="plan-label">עדיין לא נבחר מסלול</p><a class="btn secondary" style="width:100%" href="${storefront}/booking.html?business=1">יצירת משלוח חדש</a></article>

      <article id="plans" class="wide"><h2>מסלולים וטעינת יתרה</h2><div class="grid plans" id="plan-cards"></div></article>

      <article class="card wide"><h2>פרטי העסק</h2><form id="profile-form" class="profile-grid"><div><label for="company">שם העסק</label><input id="company" autocomplete="organization"></div><div><label for="contact-name">שם איש קשר</label><input id="contact-name" autocomplete="name"></div><div><label for="phone">טלפון</label><input id="phone" dir="ltr" autocomplete="tel"></div><button class="ghost" type="submit">שמירה</button></form><div id="profile-message" class="message"></div></article>

      <article class="card wide"><h2>משלוחים אחרונים</h2><div id="orders" class="list"></div></article>
      <article class="card wide"><h2>פעילות ביתרה</h2><div id="entries" class="list"></div></article>
    </div>
  </section>
</main>
<script>
const STOREFRONT=${escapeScript(storefront)};
const $=id=>document.getElementById(id);let challenge=null;let snapshot=null;
const money=n=>new Intl.NumberFormat('he-IL',{maximumFractionDigits:2}).format(Number(n||0));
const date=n=>n?new Intl.DateTimeFormat('he-IL',{dateStyle:'medium',timeStyle:'short'}).format(new Date(Number(n))):'—';
async function api(path,options={}){const r=await fetch(path,{...options,credentials:'same-origin',headers:{'Content-Type':'application/json',...(options.headers||{})}});const d=await r.json().catch(()=>({}));if(!r.ok){const e=new Error(d.error||'request_failed');e.status=r.status;e.data=d;throw e}return d}
function authMessage(text,error=false){const el=$('auth-message');el.textContent=text||'';el.classList.toggle('error',error)}
function showAuth(){ $('auth').classList.remove('hidden');$('dashboard').classList.add('hidden');$('logout').classList.add('hidden') }
function showDashboard(){ $('auth').classList.add('hidden');$('dashboard').classList.remove('hidden');$('logout').classList.remove('hidden') }
async function load(){try{snapshot=await api('/api/business/me');render();showDashboard()}catch(e){showAuth()}}
function render(){const s=snapshot;$('balance').textContent=money(s.wallet.available);$('reserved').textContent=money(s.wallet.reserved)+' ₪';$('expiry').textContent=s.wallet.next_expiry?'₪'+money(s.wallet.next_expiry.amount)+' בתוקף עד '+date(s.wallet.next_expiry.at):'אין יתרה שעומדת לפוג';$('welcome').textContent='שלום'+(s.user.name?' '+s.user.name:'');$('plan-label').textContent=s.account.plan_id?'מסלול '+({silver:'כסף',gold:'זהב',platinum:'פלטינום'}[s.account.plan_id]||s.account.plan_id):'עדיין לא נבחר מסלול';$('company').value=s.account.company_name||'';$('contact-name').value=s.user.name||'';$('phone').value=s.user.phone||'';
  $('plan-cards').innerHTML=s.plans.map(p=>'<article class="card plan '+(s.account.plan_id===p.id?'current':'')+'"><span class="tag">אזורים '+p.zones.join('–')+'</span><div class="plan-name">'+p.name_he+'</div><div class="plan-price">₪'+money(p.amount)+'</div><p class="muted">כל התשלום הופך ליתרת משלוחים</p><button class="primary topup" data-plan="'+p.id+'">בחירת מסלול וטעינה</button></article>').join('');document.querySelectorAll('.topup').forEach(b=>b.onclick=()=>topup(b));
  $('orders').innerHTML=s.orders.length?s.orders.map(o=>'<div class="row"><div class="row-main"><b>משלוח #'+o.id+'</b><div class="route muted">'+(o.pickup||'—')+' ← '+(o.dropoff||'—')+'</div></div><div><b>₪'+money(o.price)+'</b><div class="muted">'+(o.payment_status||o.status)+'</div></div></div>').join(''):'<div class="empty">עדיין אין משלוחים בחשבון.</div>';
  const labels={topup:'טעינת יתרה',reserve:'שמירת יתרה למשלוח',capture:'חיוב משלוח',release:'שחרור יתרה',refund:'זיכוי',expiry:'פקיעת יתרה',adjustment:'התאמה'};
  $('entries').innerHTML=s.entries.length?s.entries.map(e=>{const delta=Number(e.available_delta||0);return '<div class="row"><div><b>'+(labels[e.entry_type]||e.entry_type)+'</b><div class="muted">'+date(e.created_at)+(e.order_id?' · משלוח #'+e.order_id:'')+'</div></div><b class="ltr '+(delta>0?'positive':delta<0?'negative':'')+'">'+(delta>0?'+':'')+money(delta)+' ₪</b></div>'}).join(''):'<div class="empty">פעילות היתרה תופיע כאן.</div>'
}
async function topup(btn){const plan=btn.dataset.plan;const original=btn.textContent;btn.disabled=true;btn.textContent='מכין תשלום…';try{const d=await api('/api/business/topups',{method:'POST',body:JSON.stringify({plan_id:plan})});if(d.checkout_url)location.assign(d.checkout_url);else throw new Error('checkout_unavailable')}catch(e){alert('לא הצלחנו לפתוח את התשלום. נסו שוב או פנו אלינו.');btn.disabled=false;btn.textContent=original}}
$('email-form').onsubmit=async e=>{e.preventDefault();authMessage('שולחים…');const button=e.submitter;button.disabled=true;try{const d=await api('/api/business/auth/request',{method:'POST',body:JSON.stringify({email:$('email').value})});challenge=d.challenge;$('email-step').classList.add('hidden');$('code-step').classList.remove('hidden');authMessage('שלחנו קישור וקוד לאימייל.');document.querySelector('.otp input').focus()}catch(err){authMessage(err.status===429?'נשלחו יותר מדי בקשות. נסו שוב מאוחר יותר.':'לא הצלחנו לשלוח. בדקו את האימייל ונסו שוב.',true)}finally{button.disabled=false}};
$('code-form').onsubmit=async e=>{e.preventDefault();const code=[...document.querySelectorAll('.otp input')].map(i=>i.value).join('');if(code.length!==6)return authMessage('נא להזין את כל שש הספרות.',true);try{await api('/api/business/auth/verify',{method:'POST',body:JSON.stringify({challenge,code})});history.replaceState({},'',location.pathname);await load()}catch(err){authMessage(err.message==='expired'?'פג תוקף הקוד. בקשו קוד חדש.':'הקוד אינו נכון.',true)}};
document.querySelectorAll('.otp input').forEach((input,i,all)=>{input.oninput=()=>{input.value=input.value.replace(/\D/g,'').slice(-1);if(input.value&&all[i+1])all[i+1].focus()};input.onkeydown=e=>{if(e.key==='Backspace'&&!input.value&&all[i-1])all[i-1].focus()};input.onpaste=e=>{const digits=(e.clipboardData.getData('text')||'').replace(/\D/g,'').slice(0,6);if(digits){e.preventDefault();digits.split('').forEach((d,j)=>{if(all[j])all[j].value=d});if(all[Math.min(digits.length,5)])all[Math.min(digits.length,5)].focus()}}});
$('back-email').onclick=()=>{$('code-step').classList.add('hidden');$('email-step').classList.remove('hidden');authMessage('')};
$('logout').onclick=async()=>{await api('/api/business/logout',{method:'POST',body:'{}'}).catch(()=>{});location.reload()};
$('profile-form').onsubmit=async e=>{e.preventDefault();try{await api('/api/business/profile',{method:'PUT',body:JSON.stringify({company_name:$('company').value,name:$('contact-name').value,phone:$('phone').value})});$('profile-message').textContent='הפרטים נשמרו.';await load()}catch{$('profile-message').textContent='לא הצלחנו לשמור כרגע.'}};
(async()=>{const q=new URLSearchParams(location.search);if(q.get('challenge')&&q.get('token')){try{await api('/api/business/auth/verify',{method:'POST',body:JSON.stringify({challenge:q.get('challenge'),token:q.get('token')})});history.replaceState({},'',location.pathname)}catch(e){authMessage(e.message==='expired'?'הקישור פג. בקשו קישור חדש.':'הקישור אינו תקין.',true)}}await load()})();
</script>
</body></html>`;
}
