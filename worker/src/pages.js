// HTML pages: customer tracking (find.) + ops/driver dashboard (ops.)

import { customerFlow, liveGpsStatuses, opsLabelMap, QUEUE_LAYOUT, queueStatusMap } from './status.js';
import { versionString } from './version.js';

const CSS = `
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:system-ui,-apple-system,"Segoe UI",Arial,sans-serif;background:#fff;color:#1F2430;direction:rtl;text-align:right}
.wrap{max-width:680px;margin:0 auto;padding:24px 16px 64px}
.brand{font-weight:800;color:#5B2A86;font-size:1.3rem;margin-bottom:4px}
.sub{color:#5A5566;font-size:.9rem;margin-bottom:20px}
.card{background:#F5F2FB;border:1px solid rgba(91,42,134,.14);border-radius:14px;padding:18px;margin:14px 0}
h2{font-size:1.15rem;color:#3E1D5E;margin-bottom:8px}
.kv{display:flex;justify-content:space-between;gap:12px;padding:6px 0;border-bottom:1px dashed rgba(0,0,0,.08);font-size:.95rem}
.kv:last-child{border:0}
.kv b{font-weight:700}
.muted{color:#5A5566;font-size:.85rem}
.price{color:#C9A96B;font-weight:800;font-size:1.4rem}
.badge{display:inline-block;padding:4px 12px;border-radius:999px;font-size:.8rem;font-weight:700;background:#5B2A86;color:#fff}
.badge.warn{background:#C9A96B;color:#1A1A22}
.badge.ok{background:#2E8B57}
.tl{list-style:none;margin:8px 0}
.tl li{display:flex;gap:10px;padding:7px 0;color:#5A5566;font-size:.95rem}
.tl li.done{color:#2E8B57}
.tl li.active{color:#3E1D5E;font-weight:700}
.tl li .dot{width:14px;height:14px;border-radius:50%;background:#D9D2E6;flex:none;margin-top:3px}
.tl li.done .dot{background:#2E8B57}
.tl li.active .dot{background:#5B2A86}
.btn{display:inline-block;background:#5B2A86;color:#fff;padding:12px 20px;border-radius:10px;text-decoration:none;font-weight:700;border:0;cursor:pointer;font-size:1rem;width:100%;text-align:center}
.btn:hover{background:#4A216F}
.stale{background:#FFF6E5;border:1px solid #E6CF9A;color:#7a5a13;padding:8px 12px;border-radius:8px;font-size:.85rem;margin:8px 0}
#map{height:320px;border-radius:12px;margin:10px 0;display:none}
.otp-cells{display:flex;gap:8px;justify-content:center;margin:0 auto 12px;max-width:280px}
.otp-cell{width:40px;height:50px;text-align:center;font-size:1.5rem;font-weight:700;border:2px solid #B8A8C9;border-radius:10px;outline:none;color:#3E1D5E}
.otp-cell:focus{border-color:#5B2A86;background:#F5F2FB}
.otp-cell.filled{border-color:#5B2A86}
.vfoot{margin-top:28px;padding-top:14px;border-top:1px dashed rgba(0,0,0,.08);text-align:center;color:#9a8fa6;font-size:.72rem;direction:ltr}
.vfoot a{color:#9a8fa6;text-decoration:none}
`;


export function trackingHtml(env, token) {
  return `<!doctype html><html lang="he" dir="rtl"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>מעקב משלוח · EdenMish</title>
<script src="https://maps.googleapis.com/maps/api/js?key=${env.MAPS_KEY}"></script>
<style>${CSS}</style></head><body><div class="wrap">
<div class="brand">EdenMish</div><div class="sub">מעקב שליחות בזמן אמת</div>
<div id="app">טוען…</div>
</div>
<script>
const TOKEN=${JSON.stringify(token)};
const LIVE=${JSON.stringify(liveGpsStatuses())};
const FLOW=${JSON.stringify(customerFlow())};
const orderIdx=(s)=>{const i=FLOW.findIndex(f=>f[0]===s);return i<0?0:i;};
let map=null,marker=null;
function fmt(t){return t?new Date(t).toLocaleString('he-IL'):'—';}
function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];})}
function ago(ms){const m=Math.max(0,Math.round((Date.now()-ms)/60000));return m<=1?'רגע':m+' דקות';}
async function load(){
  try{
    const r=await fetch('/api/orders/'+TOKEN); if(r.status===402){document.getElementById('app').innerHTML='<div class="card">המעקב יהיה זמין לאחר אישור התשלום.</div>';return;} if(!r.ok) throw 0; const d=await r.json(); render(d);
  }catch(e){document.getElementById('app').innerHTML='<div class="card">לא נמצא משלוח. בדקו את הקישור.</div>';}
}
function render(d){
  const prevCells=[];for(var ci=0;ci<6;ci++){var pc=document.getElementById('otp-'+ci);prevCells.push(pc?pc.value:'');}
  const o=d.order; const his=d.history||[]; const hisByStatus={}; his.forEach(h=>hisByStatus[h.status]=h.at);
  let idx=orderIdx(o.status);
  if(o.status==='review') idx=1;
  const isLive=LIVE.includes(o.status);
  const isDone=o.status==='delivered';
  const isReview=o.status==='review';
  let tl=FLOW.map((f,i)=>{
    let cls=i<idx?'done':(i===idx?'active':'');
    const at=hisByStatus[f[0]]; return '<li class="'+cls+'"><span class="dot"></span>'+f[1]+(cls&&at?' <span class="muted">('+fmt(at)+')</span>':'')+'</li>';
  }).join('');
  if(isReview) tl='<li class="active"><span class="dot"></span>בדיקה ידנית — עדן יאשר מחיר בקרוב</li>'+tl;
  let pay='';
  if(o.payment_url && o.payment_status!=='paid' && o.status!=='paid'){pay='<a class="btn" href="'+o.payment_url+'">לתשלום ₪'+o.price+'</a><div class="muted" style="margin:8px 0;text-align:center">תשלום מאובטח דרך Shopify + PayPlus</div>';}
  if(isReview) pay='<div class="badge warn">ממתין לאישור מחיר — עדן יחזור אליכם</div>';
  if(o.payment_status==='paid'||o.status==='paid') pay='<div class="badge ok">שולם ₪'+(o.price||'')+'</div>';
  if(!pay && (o.status==='priced'||o.status==='payment_sent')) pay='<div class="badge warn">ממתין לתשלום</div><a class="btn" href="https://wa.me/972534058498?text='+encodeURIComponent('שלום עדן, בקשר להזמנה #'+o.id+' — אשמח לתאם תשלום')+'" target="_blank" rel="noopener" style="margin-top:8px">תיאום תשלום בוואטסאפ ←</a>';
  let summary='';
  if(isDone){var pf=d.proof||{};summary='<div class="card"><h2>סיכום משלוח</h2><div class="kv"><span>איסוף</span><b>'+fmt(o.picked_up_at)+'</b></div><div class="kv"><span>מסירה</span><b>'+fmt(o.delivered_at)+'</b></div>'+(pf.receiver_name?'<div class="kv"><span>התקבל על ידי</span><b>'+esc(pf.receiver_name)+'</b></div>':'')+(pf.delivery_note?'<div class="kv"><span>הערת מסירה</span><b>'+esc(pf.delivery_note)+'</b></div>':'')+'<div class="kv"><span>מחיר</span><b class="price">₪'+o.price+'</b></div><div class="kv"><span>סטטוס</span><b class="badge ok">נמסר</b></div></div>';}
  const gps=d.gps;
  let mapBlock='<div id="map"></div>'+(gps&&isLive?'<div class="muted" style="text-align:center">מיקום אחרון: לפני '+ago(gps.at)+'</div>':'');
  if(!isLive && !isDone) mapBlock='';
  document.getElementById('app').innerHTML=
    (d.otp_pending
      ? (o.otp_enabled === false
          ? '<div class="card" style="text-align:center"><div class="badge">מס׳ '+o.id+'</div><h2 style="margin-top:10px">מעקב מוגבל</h2><p class="muted" style="margin:8px 0 16px">לצפייה בפרטי השליחות נדרש אימות דוא״ל, אך לא צורפה כתובת דוא״ל להזמנה זו. לקבלת פרטים:</p><a class="btn" href="https://wa.me/972534058498" target="_blank" rel="noopener" style="width:auto;display:inline-block">צרו קשר בוואטסאפ ←</a></div>'
          : '<div class="card" id="verifyCard"><div style="text-align:center;margin-bottom:12px"><div class="badge">מס׳ '+o.id+'</div></div><h2>אימות כתובת הדוא״ל</h2><div class="muted" style="margin-bottom:16px">לצפייה בפרטי השליחות ובמעקב החי, הזינו את הקוד בן 6 הספרות שנשלח ל-<b>'+(o.email_masked||'')+'</b>.</div><div class="otp-cells" id="otpCells"><input class="otp-cell" type="text" inputmode="numeric" maxlength="1" id="otp-0" autocomplete="one-time-code" aria-label="ספרה 1"><input class="otp-cell" type="text" inputmode="numeric" maxlength="1" id="otp-1" aria-label="ספרה 2"><input class="otp-cell" type="text" inputmode="numeric" maxlength="1" id="otp-2" aria-label="ספרה 3"><input class="otp-cell" type="text" inputmode="numeric" maxlength="1" id="otp-3" aria-label="ספרה 4"><input class="otp-cell" type="text" inputmode="numeric" maxlength="1" id="otp-4" aria-label="ספרה 5"><input class="otp-cell" type="text" inputmode="numeric" maxlength="1" id="otp-5" aria-label="ספרה 6"></div><button class="btn" onclick="verifyOtpNow()">אימות</button><div class="muted" style="text-align:center;margin-top:8px"><a href="#" onclick="resendOtp();return false" style="color:#5B2A86;font-weight:700">שלח קוד מחדש</a></div></div>')
      : '<div class="card"><div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px"><h2>סטטוס הזמנה</h2><span class="badge">מס׳ '+o.id+'</span></div><ul class="tl">'+tl+'</ul></div>'+
        '<div class="card"><h2>פרטי השליחות</h2>'+
          '<div class="kv"><span>איסוף</span><b>'+esc(o.pickup||'—')+(o.pickup_detail?' · '+esc(o.pickup_detail):'')+'</b></div>'+
          '<div class="kv"><span>מסירה</span><b>'+esc(o.dropoff||'—')+(o.dropoff_detail?' · '+esc(o.dropoff_detail):'')+'</b></div>'+
          '<div class="kv"><span>חבילה</span><b>'+esc(o.package||'—')+'</b></div>'+
          '<div class="kv"><span>מועד</span><b>'+esc(o.when_text||'—')+'</b></div>'+
          (o.price?'<div class="kv"><span>מחיר</span><b class="price">₪'+o.price+'</b></div>':'')+
        '</div>'+
        (pay?'<div class="card" style="text-align:center">'+pay+'</div>':'')+
        (isLive?'<div class="card"><h2>מפה חיה</h2>'+mapBlock+'</div>':'')+
        summary
    );
  if(d.otp_pending && prevCells.join('')){for(var ri=0;ri<6;ri++){var rc=document.getElementById('otp-'+ri);if(rc){rc.value=prevCells[ri]||'';if(rc.value)rc.classList.add('filled');}}}
  if(d.otp_pending){initOtpCells();}
  if(!d.otp_pending && isLive && gps){ showMap(gps); }
}
function initOtpCells(){
  var cells=document.querySelectorAll('.otp-cell');if(!cells.length)return;
  cells.forEach(function(cell,idx){
    cell.addEventListener('input',function(e){
      var val=e.target.value.replace(/\\D/g,'');e.target.value=val;
      if(val)e.target.classList.add('filled');else e.target.classList.remove('filled');
      if(val&&idx<5)cells[idx+1].focus();
      var all=true;for(var i=0;i<6;i++){if(!cells[i].value){all=false;break;}}
      if(all)verifyOtpNow();
    });
    cell.addEventListener('keydown',function(e){
      if(e.key==='Backspace'&&!e.target.value&&idx>0){cells[idx-1].focus();cells[idx-1].value='';cells[idx-1].classList.remove('filled');}
    });
    cell.addEventListener('paste',function(e){
      e.preventDefault();var p=(e.clipboardData||window.clipboardData).getData('text').replace(/\\D/g,'').slice(0,6);
      if(!p)return;for(var i=0;i<6;i++){if(i<p.length){cells[i].value=p[i];cells[i].classList.add('filled');}else{cells[i].value='';cells[i].classList.remove('filled');}}
      if(p.length===6)verifyOtpNow();else if(p.length<6)cells[p.length].focus();
    });
  });
  cells[0].focus();
}
function showMap(gps){
  const el=document.getElementById('map'); if(!el) return; el.style.display='block';
  const pos={lat:gps.lat,lng:gps.lng};
  if(!map){map=new google.maps.Map(el,{center:pos,zoom:14,disableDefaultUI:true});marker=new google.maps.Marker({position:pos,map:map});}
  else{map.panTo(pos);marker.setPosition(pos);}
}
async function verifyOtpNow(){
  var code='';for(var i=0;i<6;i++){var c=document.getElementById('otp-'+i);code+=(c&&c.value)||'';}
  code=code.replace(/\D/g,'');
  if(code.length!==6){return;}
  var btn=document.querySelector('[onclick="verifyOtpNow()"]');if(btn){btn.disabled=true;btn.textContent='…';}
  var r=await fetch('/api/orders/'+TOKEN+'/verify-otp',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code:code})});
  var d=await r.json();
  if(d.verified){
    document.getElementById('app').innerHTML='<div class="card" style="text-align:center"><div class="badge ok" style="font-size:1rem;padding:10px">הדוא״ל אומת ✓ טוען פרטים…</div></div>';
    setTimeout(load,500);
  }
  else{
    if(btn){btn.disabled=false;btn.textContent='אימות';}
    for(var j=0;j<6;j++){var c2=document.getElementById('otp-'+j);if(c2){c2.value='';c2.classList.remove('filled');}}
    var f=document.getElementById('otp-0');if(f)f.focus();
    alert(d.error==='locked'?'יותר מדי ניסיונות שגויים — נסו שוב מאוחר יותר.':(d.error==='expired'?'פג תוקף הקוד — בקשו קוד חדש.':'קוד שגוי, נסו שוב.'));
  }
}
async function resendOtp(){var r=await fetch('/api/orders/'+TOKEN+'/resend-otp',{method:'POST'});var d=await r.json().catch(function(){return{};});alert(d&&d.error==='throttled'?'נשלחו יותר מדי קודים — נסו שוב מאוחר יותר.':'נשלח קוד חדש לדוא״ל');}
load();
setInterval(()=>{ if(!(document.activeElement&&document.activeElement.tagName==='INPUT')) load(); },7000);
</script>
<div class="vfoot">${versionString()}</div>
</body></html>`;
}

export function opsHtml(env) {
  return `<!doctype html><html lang="he" dir="rtl"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>EdenMish · ניהול שליחויות</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Hanken+Grotesk:wght@400;500;600;700;800&display=swap" rel="stylesheet"><link href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:wght,FILL@100..700,0..1&display=swap" rel="stylesheet">
<!-- ops-v2-dark -->
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Hanken Grotesk',system-ui,sans-serif;background:#0b1326;color:#dae2fd;direction:rtl;text-align:right;background-image:radial-gradient(50rem 50rem at 85% -10%,rgba(91,42,134,.35),transparent 60%),radial-gradient(40rem 40rem at 0% 100%,rgba(0,83,75,.22),transparent 55%);background-attachment:fixed;min-height:100vh}
.material-symbols-outlined{font-variation-settings:'FILL' 0,'wght' 400,'GRAD' 0,'opsz' 24;vertical-align:middle}
.wrap{max-width:980px;margin:0 auto;padding:24px 16px 80px}
.glass-card{background:rgba(255,255,255,.05);backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);border:1px solid rgba(255,255,255,.1);border-radius:16px}
.muted{color:#cec3d2}
.stale{color:#fbbf24}
.price{color:#91d3c8;font-weight:800}
.badge{display:inline-block;padding:4px 12px;border-radius:999px;font-size:.8rem;font-weight:700;background:#5b2a86;color:#fff}
input{background:rgba(13,8,20,.6);border:1px solid rgba(255,255,255,.14);color:#dae2fd;border-radius:10px;padding:12px;font-family:inherit}
input:focus{outline:none;border-color:#dfb7ff;box-shadow:0 0 10px rgba(223,183,255,.25)}
.btn{display:inline-block;background:linear-gradient(135deg,#5b2a86,#7847a4);color:#fff;padding:12px 20px;border-radius:10px;text-decoration:none;font-weight:700;border:0;cursor:pointer;font-size:1rem;width:100%;text-align:center;font-family:inherit}
.btn:hover{filter:brightness(1.08)}
.btn.sm{width:auto;flex:none;padding:12px 16px;font-size:.9rem;min-height:44px}
.btn.go{background:linear-gradient(135deg,#00534b,#003732);color:#eafff9}
.btn.alt{background:rgba(255,255,255,.05);color:#dae2fd;border:1px solid rgba(255,255,255,.18)}
.btn.danger{background:rgba(239,68,68,.12);color:#ff8a8a;border:1px solid rgba(239,68,68,.4)}
.qbucket{margin:14px 0}
.qhead{display:flex;align-items:center;gap:10px;padding:8px 2px;border-bottom:2px solid rgba(223,183,255,.18);margin-bottom:8px;flex-wrap:wrap}
.qhead-label{font-weight:800;color:#dfb7ff;font-size:1.02rem}
.qhead-count{background:#5b2a86;color:#fff;border-radius:999px;padding:2px 10px;font-size:.78rem;font-weight:700}
.qhead-hint{color:#978d9b;font-size:.72rem;font-weight:400}
.qhead-toggle{margin-inline-start:auto;color:#91d3c8;font-size:.82rem;font-weight:700;cursor:pointer;background:none;border:0;padding:4px}
.qcards{display:flex;flex-direction:column;gap:10px}
.ocard,.glass-card.ocard{background:rgba(255,255,255,.05);backdrop-filter:blur(10px);border:1px solid rgba(255,255,255,.1);border-radius:14px;padding:14px;margin:0}
.ocard-active{border-color:#91d3c8;background:rgba(0,83,75,.18)}
.ocard-live{box-shadow:inset 0 0 0 2px rgba(239,68,68,.5)}
.ocard-top{display:flex;align-items:center;gap:8px;margin-bottom:4px;flex-wrap:wrap}
.ocard-top .price{margin-inline-start:auto;font-weight:800;color:#91d3c8}
.ocard-name{font-weight:700;font-size:.95rem;color:#dae2fd}
.ocard-route{color:#cec3d2;font-size:.92rem;margin:2px 0}
.ocard-meta{margin-top:6px;font-size:.72rem;color:#978d9b}
.vstamp{display:inline-block;font-size:.65rem;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:#7d7287;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.08);border-radius:6px;padding:2px 6px;direction:ltr}
.chip{display:inline-block;font-size:.68rem;padding:2px 8px;border-radius:999px;background:rgba(255,255,255,.08);color:#cec3d2;margin-inline-end:4px;margin-top:5px}
.chip-urg{background:rgba(239,68,68,.18);color:#ff8a8a;font-weight:700}
.chip-pay{background:rgba(52,211,153,.18);color:#34d399}
.ocard-actions{margin-top:10px;border-top:1px dashed rgba(255,255,255,.12);padding-top:10px;display:flex;gap:6px;flex-wrap:wrap;align-items:center}
.inline-price{display:flex;gap:6px;align-items:stretch;width:100%}
.inline-price input{flex:1;margin:0;padding:12px;border:1px solid rgba(255,255,255,.18);border-radius:10px;font-size:1.1rem;text-align:center;min-width:80px;background:rgba(13,8,20,.6);color:#dae2fd}
.deliver-form{display:flex;flex-direction:column;gap:6px;width:100%}
.deliver-form input{margin:0;padding:12px;border:1px solid rgba(255,255,255,.18);border-radius:10px;font-size:1rem;text-align:right;background:rgba(13,8,20,.6);color:#dae2fd}
.nlist{margin-top:8px;border-top:1px dashed rgba(255,255,255,.12);padding-top:8px}
.nrow{padding:6px 0;border-bottom:1px solid rgba(255,255,255,.06);font-size:.85rem;color:#cec3d2}
.nrow:last-child{border-bottom:0}
.ns-ok{background:#34d399}.ns-fail{background:#ef4444}.ns-skip{background:#9a93a8}.ns-pend{background:#5b2a86}
.live-dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:#ef4444;animation:pulse 1.4s infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}}
.pod-overlay{position:fixed;inset:0;z-index:100;background:rgba(11,19,38,.95);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);overflow-y:auto;padding:20px}
.pod-card{max-width:480px;margin:0 auto;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.1);border-radius:18px;padding:20px;display:flex;flex-direction:column;gap:14px}
.pod-head{display:flex;justify-content:space-between;align-items:center}
.pod-head b{color:#dfb7ff;font-size:1.1rem}
.pod-x{background:none;border:0;color:#cec3d2;font-size:1.4rem;cursor:pointer}
.pod-photo{display:flex;align-items:center;justify-content:center;min-height:120px;border:2px dashed rgba(223,183,255,.4);border-radius:14px;cursor:pointer;color:#cec3d2;text-align:center;padding:14px;overflow:hidden}
.pod-photo img{max-height:200px;border-radius:12px;margin:0 auto}
.pod-sig{position:relative;height:160px;border:1px solid rgba(255,255,255,.15);border-radius:14px;overflow:hidden;background:rgba(13,8,20,.4)}
.pod-sig canvas{position:absolute;inset:0;width:100%;height:100%;touch-action:none}
.pod-sig-clear{position:absolute;top:6px;left:6px;font-size:.7rem;background:rgba(255,255,255,.1);color:#cec3d2;border:0;padding:3px 8px;border-radius:6px;cursor:pointer}
.driver-proof-item{border:1px solid rgba(255,255,255,.12);border-radius:14px;padding:14px;background:rgba(13,8,20,.35)}
.driver-proof-head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:10px}
.driver-proof-media{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px;margin-top:10px}
.driver-proof-media img{display:block;width:100%;max-height:260px;object-fit:contain;border-radius:10px;background:#090d24;border:1px solid rgba(255,255,255,.1)}
</style></head><body><div class="wrap">
<div id="app"></div>
</div>
<div id="pod" class="pod-overlay" hidden>
<div class="pod-card">
<div class="pod-head"><b>אישור מסירה (הוכחה)</b><button class="pod-x" onclick="hidePod()" aria-label="סגור">✕</button></div>
<input type="text" id="pod-recv" placeholder="שם המקבל (אופציונלי)">
<input type="text" id="pod-note" placeholder="הערת מסירה (אופציונלי)">
<label class="pod-photo" for="pod-photo"><span id="pod-photo-ph">📸 לחצו לצלם את החבילה ביעד</span><input type="file" accept="image/*" capture="environment" id="pod-photo" hidden onchange="podPreview()"></label>
<div class="pod-sig"><canvas id="pod-sig-canvas"></canvas><button class="pod-sig-clear" onclick="clearSig()" type="button">נקה</button></div>
<button class="btn go" id="pod-submit" onclick="submitPod()" type="button">אשר מסירה וסגור משימה</button>
</div>
</div>
<div id="driver-proofs" class="pod-overlay" hidden>
<div class="pod-card">
<div class="pod-head"><b>הוכחות מהשליח</b><button class="pod-x" onclick="hideDriverProofs()" aria-label="סגור">✕</button></div>
<div id="driver-proofs-content" class="muted">טוען…</div>
</div>
</div>
<script>
const HE=${JSON.stringify(opsLabelMap())};
const QL=${JSON.stringify(QUEUE_LAYOUT)};
const QOF=${JSON.stringify(queueStatusMap())};
const NEXT={paid:'to_pickup',to_pickup:'picked_up',picked_up:'to_dropoff',to_dropoff:'delivered'};
const NEXTLBL={paid:'יציאה לאיסוף →',to_pickup:'נאסף ✓',picked_up:'יציאה למסירה →',to_dropoff:'נמסר ✓'};
const LIVE=['to_pickup','to_dropoff'];
const NSTAT={pending:'ממתין',sent:'נשלח',failed:'נכשל',skipped:'דולג'};
const NCHAN={email:'אימייל',whatsapp_future:'וואטסאפ',sms_future:'SMS',system:'מערכת'};
const NTPL={ops_new_order:'הזמנה חדשה לעדן',customer_otp:'קוד אימות',customer_payment_confirmation:'אישור תשלום',ops_payment_received:'תשלום התקבל',customer_delivery_summary:'סיכום מסירה',customer_request_received:'אישור קבלת בקשה',customer_payment_link:'קישור תשלום ללקוח'};
let orders=[], activeId=null, watchId=null, gpsOrderId=null, gpsState='idle', doneOpen=false, notifOrderId=null, notifs=[];
function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];});}
function maskRecip(s){if(!s)return '';s=String(s);var at=s.indexOf('@');return at<1?s:(s[0]+'•••@'+s.slice(at+1));}
function bucketOf(s){return QOF[s]||'inbox';}
function fmt(t){return t?new Date(t).toLocaleString('he-IL'):'—';}
async function api(path,opts){opts=opts||{};opts.headers=opts.headers||{};opts.credentials='include';return await fetch(path,opts);}
function loginHtml(){document.getElementById('app').innerHTML='<div style="display:flex;align-items:center;justify-content:center;min-height:80vh;padding:20px"><div class="glass-card" style="max-width:360px;border-radius:20px;padding:32px;text-align:center"><div style="width:64px;height:64px;border-radius:50%;background:#5b2a86;display:flex;align-items:center;justify-content:center;margin:0 auto 16px"><span class="material-symbols-outlined" style="font-size:32px;color:#dfb7ff">two_wheeler</span></div><h2 style="color:#dfb7ff;font-size:1.3rem;margin-bottom:6px;font-family:Hanken Grotesk,sans-serif;font-weight:700">EdenMish Ops</h2><p class="muted" style="margin-bottom:20px;font-size:.85rem">מרכז הבקרה - גוש דן</p><input id="pin" type="password" placeholder="הזן PIN" style="text-align:center;font-size:1.2rem;letter-spacing:6px;margin-bottom:16px;background:rgba(13,8,20,.6);border:1px solid rgba(255,255,255,.14);color:#dae2fd;border-radius:10px;padding:14px;width:100%"><button class="btn" style="width:100%" onclick="doLogin()">התחבר</button></div></div>';}
async function doLogin(){const pin=document.getElementById('pin').value;const r=await fetch('/api/ops/login',{method:'POST',credentials:'include',headers:{'Content-Type':'application/json'},body:JSON.stringify({pin})});if(r.ok){refresh();}else{alert(r.status===429?'יותר מדי ניסיונות שגויים — נסו שוב בעוד 15 דקות':'PIN שגוי');}}
async function logout(){try{await api('/api/ops/logout',{method:'POST'});}finally{stopWatch();loginHtml();}}
async function refresh(){const r=await api('/api/ops/orders');if(!r.ok){stopWatch();return loginHtml();}orders=(await r.json()).orders||[];var fails=[];try{var fr=await api('/api/ops/notifications/failures');if(fr.ok)fails=(await fr.json()).failures||[];}catch(e){}notifs=[];if(notifOrderId){try{var nr=await api('/api/ops/orders/'+notifOrderId+'/notifications');if(nr.ok)notifs=(await nr.json()).notifications||[];}catch(e){}}render(fails);}
function render(fails){
  var byB={};QL.forEach(function(q){byB[q.bucket]=[];});
  orders.forEach(function(o){var b=bucketOf(o.status);(byB[b]=byB[b]||[]).push(o);});
  var sections='';
  QL.forEach(function(q){
    var all=(byB[q.bucket]||[]);if(all.length===0)return;
    var showing=(q.bucket==='done'&&!doneOpen)?[]:all.slice().sort(function(a,b){return b.id-a.id;}).slice(0,10);
    var toggle=q.bucket==='done'?'<button class="qhead-toggle" data-act="toggledone">'+(doneOpen?'▲ הצג פחות':'▼ הצג '+all.length)+'</button>':'<span class="qhead-hint">'+esc(q.hint||'')+'</span>';
    sections+='<div class="qbucket"><div class="qhead"><span class="qhead-label">'+esc(q.hebrewLabel)+'</span><span class="qhead-count">'+all.length+'</span>'+toggle+'</div><div class="qcards">'+showing.map(card).join('')+'</div></div>';
  });
  if(!sections)sections='<div class="card"><div class="muted">אין הזמנות כרגע.</div></div>';
  var active=orders.filter(function(o){return LIVE.indexOf(o.status)>=0;}).length;
  var pending=orders.filter(function(o){return ['review','priced','received','payment_sent'].indexOf(o.status)>=0;}).length;
  var done=orders.filter(function(o){return o.status==='delivered';}).length;
  var toolbar='<div class="glass-card" style="border-radius:16px;padding:16px;margin:0 0 16px;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px"><div><div style="display:flex;align-items:center;gap:8px"><span class="material-symbols-outlined" style="font-size:22px;color:#91d3c8">two_wheeler</span><strong style="color:#dfb7ff;font-size:1.1rem;font-family:Hanken Grotesk,sans-serif">EdenMish Ops</strong><span class="vstamp" title="גרסה">'+versionString()+'</span></div><div style="color:#cec3d2;font-size:.75rem;margin-top:2px">מרכז הבקרה: תל אביב וגוש דן</div></div><div style="display:flex;gap:8px"><div class="glass-card" style="padding:6px 14px;border-radius:12px;text-align:center"><div style="color:#91d3c8;font-size:.65rem;text-transform:uppercase;letter-spacing:.1em;font-weight:700">פעילות</div><div style="color:#dae2fd;font-size:1.2rem;font-weight:700">'+active+'</div></div><div class="glass-card" style="padding:6px 14px;border-radius:12px;text-align:center"><div style="color:#dfb7ff;font-size:.65rem;text-transform:uppercase;letter-spacing:.1em;font-weight:700">בתור</div><div style="color:#dae2fd;font-size:1.2rem;font-weight:700">'+pending+'</div></div><div class="glass-card" style="padding:6px 14px;border-radius:12px;text-align:center"><div style="color:#34D399;font-size:.65rem;text-transform:uppercase;letter-spacing:.1em;font-weight:700">הושלם</div><div style="color:#dae2fd;font-size:1.2rem;font-weight:700">'+done+'</div></div></div><div style="display:flex;gap:6px"><button class="btn sm alt" data-act="refresh" title="רענן"><span class="material-symbols-outlined" style="font-size:18px">refresh</span></button><button class="btn sm danger" data-act="logout" title="התנתק"><span class="material-symbols-outlined" style="font-size:18px">logout</span></button></div></div>';
  var fp=(fails&&fails.length)?'<div class="qbucket"><div class="qhead"><span class="qhead-label" style="color:#C0392B">בעיות בשליחת הודעות</span><span class="qhead-count">'+fails.length+'</span></div><div class="qcards">'+fails.map(function(f){return '<div class="ocard" style="border-color:rgba(192,57,43,.3)"><div class="ocard-top"><span class="badge" style="background:#C0392B">'+esc(f.channel||'email')+'</span><b>'+(f.order_id?'#'+f.order_id:'—')+'</b><span class="muted" style="margin-inline-start:auto;font-size:.72rem">'+fmt(f.created_at)+'</span></div><div class="muted">'+esc(f.template||'')+(f.recipient?' · '+esc(maskRecip(f.recipient)):'')+'</div><div class="stale" style="margin-top:4px">'+esc(f.error||'שגיאה לא ידועה')+'</div></div>';}).join('')+'</div></div>':'';
  document.getElementById('app').innerHTML=toolbar+sections+fp;
}
function card(o){
  var s=o.status,id=o.id,isLive=LIVE.indexOf(s)>=0,isActive=o.id===activeId;
  var h='<div class="glass-card ocard'+(isActive?' ocard-active':'')+(isLive?' ocard-live':'')+'" style="border-radius:16px;margin:0">';
  h+='<div class="ocard-top">'+(isLive?'<span class="live-dot"></span>':'')+'<span class="badge">'+esc(HE[s]||s)+'</span><b style="opacity:.6">#'+id+'</b><span class="price">₪'+(o.price||'?')+'</span></div>';
  if(o.name)h+='<div class="ocard-name">'+esc(o.name)+'</div>';
  h+='<div class="ocard-route" style="line-height:1.8"><span class="material-symbols-outlined" style="font-size:16px;vertical-align:middle;color:#91d3c8">arrow_upward</span> '+esc(o.pickup||'—')+'<br><span class="material-symbols-outlined" style="font-size:16px;vertical-align:middle;color:#dfb7ff">location_on</span> '+esc(o.dropoff||'—')+'</div><div>';
  if(o.package)h+='<span class="chip">'+esc(o.package)+'</span>';
  if(o.urgent)h+='<span class="chip chip-urg">דחוף</span>';
  if(o.when_text)h+='<span class="chip">'+esc(o.when_text)+'</span>';
  if(o.payment_status&&o.payment_status!=='none')h+='<span class="chip chip-pay">'+esc(o.payment_status)+'</span>';
  h+='</div>';
  if(o.notes)h+='<div style="margin-top:6px;padding:6px 10px;background:rgba(251,191,36,.1);border-radius:8px;font-size:.78rem;color:#FBBF24"><span class="material-symbols-outlined" style="font-size:14px;vertical-align:middle">sticky_note_2</span> '+esc(o.notes)+'</div>';
  h+='<div class="ocard-meta">'+fmt(o.created_at)+'</div>';
  h+=actions(o);if(notifOrderId===id)h+=notifPanel();h+='</div>';
  return h;
}
function actions(o){
  var s=o.status,id=o.id,h='<div class="ocard-actions">';
  if(LIVE.indexOf(s)>=0)h+=gpsControlHtml(id);
  if(s==='review'||s==='priced'||s==='received'){
    h+='<div class="inline-price"><input type="number" inputmode="numeric" min="1" id="price-'+id+'" value="'+(o.price||'')+'" placeholder="מחיר ₪"><button class="btn sm go" data-act="approve" data-id="'+id+'">אישור מחיר ושליחת קישור תשלום</button></div>';
    if(o.review_flag)h+='<div class="stale" style="width:100%">חריג: '+esc(o.review_reason||'')+'</div>';
  }else if(s==='payment_sent'){
    if(o.payment_url)h+='<button class="btn sm" data-act="copy" data-pay="'+esc(o.payment_url)+'">העתק קישור תשלום</button><a class="btn sm alt" href="'+esc(o.payment_url)+'" target="_blank" rel="noopener">פתח קישור</a>';
    h+='<button class="btn sm alt" data-act="markpaid" data-id="'+id+'">סמן כשולם ידנית</button>';
  }else if(s==='paid'){
    h+='<button class="btn sm go" data-act="topickup" data-id="'+id+'">'+NEXTLBL['paid']+'</button>';
  }else if(s==='to_dropoff'){
    h+='<button class="btn sm go" data-act="pod" data-id="'+id+'">📸 הוכחת מסירה (צילום + חתימה)</button><button class="btn sm danger" data-act="fail" data-id="'+id+'">סמן כנכשל</button>';
  }else if(NEXT[s]){
    h+='<button class="btn sm go" data-act="advance" data-id="'+id+'" data-next="'+NEXT[s]+'">'+NEXTLBL[s]+'</button><button class="btn sm danger" data-act="fail" data-id="'+id+'">סמן כנכשל</button>';
  }
  if(['picked_up','to_dropoff','delivered','failed'].indexOf(s)>=0)h+='<button class="btn sm alt" data-act="driverproofs" data-id="'+id+'"><span class="material-symbols-outlined" style="font-size:16px;vertical-align:middle">verified</span> הוכחות מהשליח</button>';
  h+='<button class="btn sm alt" data-act="notifs" data-id="'+id+'">'+(notifOrderId===id?'▲ הסתר הודעות':'▼ הצגת הודעות')+'</button>';
  return h+'</div>';
}
function notifPanel(){
  if(!notifs.length)return '<div class="nlist"><div class="muted" style="padding:8px 0">אין הודעות להזמנה הזו.</div></div>';
  return '<div class="nlist">'+notifs.map(function(n){
    var cls=n.status==='sent'?'ns-ok':n.status==='failed'?'ns-fail':n.status==='skipped'?'ns-skip':'ns-pend';
    return '<div class="nrow"><span class="badge '+cls+'">'+esc(NSTAT[n.status]||n.status)+'</span> <b>'+esc(NCHAN[n.channel]||n.channel)+'</b> · '+esc(NTPL[n.template]||n.template||'—')+'<div class="muted" style="font-size:.72rem;margin-top:2px">'+fmt(n.created_at)+(n.recipient?' · '+esc(maskRecip(n.recipient)):'')+'</div>'+(n.error?'<div class="stale" style="margin-top:2px">'+esc(n.error)+'</div>':'')+'</div>';
  }).join('')+'</div>';
}
async function approveInline(id){
  var inp=document.getElementById('price-'+id),price=Number(inp&&inp.value);
  if(!price||price<1){alert('הזינו מחיר תקין');return;}
  var btn=document.querySelector('[data-act="approve"][data-id="'+id+'"]');if(btn){btn.disabled=true;btn.dataset.label=btn.textContent;btn.textContent='טוען…';}
  try{
    var r=await api('/api/ops/orders/'+id+'/approve',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({price:price})});
    var d=await r.json();
    if(d&&d.ok){if(d.payment_url){copyPay(d.payment_url);alert('המחיר אושר ✓\\n'+(d.emailed?'קישור התשלום נשלח ללקוח במייל והועתק ללוח.':'קישור התשלום הועתק ללוח — שלחו ללקוח ידנית (המייל לא נשלח).'));}else{alert('המחיר אושר ✓');}refresh();}
    else{throw 0;}
  }catch(e){if(btn){btn.disabled=false;btn.textContent=btn.dataset.label||'אישור מחיר';}alert('שגיאה באישור המחיר. נסו שוב.');}
}
function copyPay(url){if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(url).catch(function(){});}else{var t=document.createElement('textarea');t.value=url;document.body.appendChild(t);t.select();try{document.execCommand('copy');}catch(e){}document.body.removeChild(t);}}
async function setStatus(id,st){try{var r=await api('/api/ops/orders/'+id+'/status',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({status:st})});if(!r.ok)throw 0;if(st==='picked_up'||st==='delivered'||st==='failed'||st==='cancelled')stopWatch();refresh();}catch(e){alert('לא הצלחנו לעדכן את ההזמנה. נסו שוב.');}}
async function advance(id,cur){if(NEXT[cur])await setStatus(id,NEXT[cur]);}
async function markPaid(id){if(!confirm('לסמן כשולם ידנית?'))return;await setStatus(id,'paid');}
var podOrderId=null,sigCtx=null,sigDrawing=false,sigHas=false;
function showPod(id){podOrderId=id;var p=document.getElementById('pod');p.hidden=false;document.getElementById('pod-recv').value='';document.getElementById('pod-note').value='';document.getElementById('pod-photo').value='';document.getElementById('pod-photo-ph').innerHTML='📸 לחצו לצלם את החבילה ביעד';clearSig();initSig();}
function hidePod(){document.getElementById('pod').hidden=true;}
function initSig(){
  var c=document.getElementById('pod-sig-canvas');if(!c||c.dataset.ready)return;
  var dpr=window.devicePixelRatio||1;c.width=c.clientWidth*dpr;c.height=c.clientHeight*dpr;
  sigCtx=c.getContext('2d');sigCtx.scale(dpr,dpr);sigCtx.lineWidth=2.5;sigCtx.lineCap='round';sigCtx.lineJoin='round';sigCtx.strokeStyle='#dfb7ff';
  function pt(e){var r=c.getBoundingClientRect();var cx=(e.clientX!=null?e.clientX:(e.touches&&e.touches[0]?e.touches[0].clientX:0));var cy=(e.clientY!=null?e.clientY:(e.touches&&e.touches[0]?e.touches[0].clientY:0));return {x:cx-r.left,y:cy-r.top};}
  function down(e){sigDrawing=true;var p=pt(e);sigCtx.beginPath();sigCtx.moveTo(p.x,p.y);}
  function move(e){if(!sigDrawing)return;var p=pt(e);sigCtx.lineTo(p.x,p.y);sigCtx.stroke();sigCtx.beginPath();sigCtx.moveTo(p.x,p.y);sigHas=true;}
  function up(){sigDrawing=false;sigCtx.beginPath();}
  c.addEventListener('mousedown',down);c.addEventListener('mousemove',move);window.addEventListener('mouseup',up);
  c.addEventListener('touchstart',function(e){e.preventDefault();down(e);},{passive:false});
  c.addEventListener('touchmove',function(e){e.preventDefault();move(e);},{passive:false});
  c.addEventListener('touchend',up);
  c.dataset.ready='1';
}
function clearSig(){var c=document.getElementById('pod-sig-canvas');if(sigCtx&&c){sigCtx.clearRect(0,0,c.width,c.height);sigHas=false;}}
function podPreview(){
  var f=document.getElementById('pod-photo').files[0];var ph=document.getElementById('pod-photo-ph');
  if(!f){ph.innerHTML='📸 לחצו לצלם את החבילה ביעד';return;}
  var fr=new FileReader();fr.onload=function(){ph.innerHTML='<img src="'+fr.result+'" alt="תצלום המסירה">';};fr.readAsDataURL(f);
}
function photoResize(file,cb){if(!file){cb(null);return;}var fr=new FileReader();fr.onload=function(){var img=new Image();img.onload=function(){var max=1024,scale=Math.min(1,max/Math.max(img.width,img.height)),c=document.createElement('canvas');c.width=Math.round(img.width*scale);c.height=Math.round(img.height*scale);c.getContext('2d').drawImage(img,0,0,c.width,c.height);cb(c.toDataURL('image/jpeg',0.7));};img.src=fr.result;};fr.readAsDataURL(file);}
async function submitPod(){
  var btn=document.getElementById('pod-submit');btn.disabled=true;var orig=btn.textContent;btn.textContent='שולח…';
  var photo=null;await new Promise(function(res){photoResize(document.getElementById('pod-photo').files[0],function(b){photo=b;res();});});
  var sig=sigHas?document.getElementById('pod-sig-canvas').toDataURL('image/png'):null;
  try{
    var r=await api('/api/ops/orders/'+podOrderId+'/deliver',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({receiver_name:document.getElementById('pod-recv').value||'',delivery_note:document.getElementById('pod-note').value||'',photo_url:photo,signature:sig})});
    var d=await r.json();
    if(d&&d.ok){hidePod();refresh();}else{throw 0;}
  }catch(e){btn.disabled=false;btn.textContent=orig;alert('שגיאה בשמירת הוכחת המסירה. נסו שוב.');}
}
function hideDriverProofs(){document.getElementById('driver-proofs').hidden=true;}
async function showDriverProofs(id){
  var modal=document.getElementById('driver-proofs'),content=document.getElementById('driver-proofs-content');modal.hidden=false;content.innerHTML='טוען…';
  try{
    var r=await api('/api/ops/orders/'+id+'/driver-proofs'),d=await r.json();if(!r.ok)throw 0;
    var list=d.proofs||[];if(!list.length){content.innerHTML='<div class="muted">עדיין לא נשמרה הוכחה מהשליח להזמנה הזו.</div>';return;}
    content.innerHTML=list.map(function(p){
      var task=p.task_type==='pickup'?'איסוף':'מסירה',media='';
      if(p.photo_url)media+='<div><div class="muted" style="margin-bottom:4px">צילום</div><img src="'+esc(p.photo_url)+'" alt="צילום הוכחת '+task+'"></div>';
      if(p.signature)media+='<div><div class="muted" style="margin-bottom:4px">חתימה</div><img src="'+esc(p.signature)+'" alt="חתימת הוכחת '+task+'"></div>';
      return '<div class="driver-proof-item"><div class="driver-proof-head"><b style="color:'+(p.task_type==='pickup'?'#91d3c8':'#dfb7ff')+'">'+task+'</b><span class="muted">'+fmt(p.updated_at||p.created_at)+'</span></div>'+(p.signer_name?'<div>חותם/ת: <b>'+esc(p.signer_name)+'</b></div>':'')+(p.note?'<div class="muted" style="margin-top:4px">'+esc(p.note)+'</div>':'')+(media?'<div class="driver-proof-media">'+media+'</div>':'')+'</div>';
    }).join('');
  }catch(e){content.innerHTML='<div class="stale">לא הצלחנו לטעון את ההוכחות. נסו שוב.</div>';}
}
function toggleDone(){doneOpen=!doneOpen;render();}
function gpsControlHtml(id){var state=gpsOrderId===id?gpsState:'idle',sharing=watchId!==null&&state==='active',requesting=state==='requesting',status=sharing?'מיקום פעיל':requesting?'ממתין לאישור':state==='denied'?'ההרשאה נדחתה':state==='error'?'המיקום אינו זמין':'מיקום כבוי',label=sharing||requesting?'הפסקת שיתוף מיקום':'התחלת שיתוף מיקום';return '<div id="gps-control-'+id+'" style="width:100%"><span id="gps-status-'+id+'" aria-live="polite" class="muted" style="display:block;margin-bottom:5px">'+status+'</span><button class="btn sm '+(sharing||requesting?'danger':'alt')+'" data-act="gps" data-id="'+id+'">'+label+'</button></div>';}
function updateGpsControl(id){var el=document.getElementById('gps-control-'+id);if(el)el.outerHTML=gpsControlHtml(id);}
function toggleGps(id){if((watchId!==null||gpsState==='requesting')&&gpsOrderId===id)stopWatch();else startWatch(id);}
function startWatch(id){if(!navigator.geolocation){gpsOrderId=id;gpsState='error';updateGpsControl(id);alert('שירותי מיקום אינם זמינים במכשיר הזה.');return;}if(watchId!==null)stopWatch();gpsOrderId=id;gpsState='requesting';updateGpsControl(id);try{watchId=navigator.geolocation.watchPosition(function(p){gpsState='active';updateGpsControl(id);var c=p.coords;api('/api/ops/orders/'+id+'/gps',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({lat:c.latitude,lng:c.longitude})}).catch(function(){});},function(err){if(watchId!==null)navigator.geolocation.clearWatch(watchId);watchId=null;gpsState=err&&err.code===1?'denied':'error';updateGpsControl(id);alert(gpsState==='denied'?'הרשאת המיקום נדחתה. ניתן לנסות שוב מהכפתור.':'לא הצלחנו לקבל מיקום. בדקו את שירותי המיקום ונסו שוב.');},{enableHighAccuracy:true,maximumAge:5000,timeout:15000});}catch(e){watchId=null;gpsState='error';updateGpsControl(id);alert('לא הצלחנו להפעיל שיתוף מיקום.');}}
function stopWatch(){var id=gpsOrderId;if(watchId!==null)navigator.geolocation.clearWatch(watchId);watchId=null;gpsOrderId=null;gpsState='idle';if(id!=null)updateGpsControl(id);}
document.getElementById('app').addEventListener('click',function(e){
  var b=e.target.closest('[data-act]');if(!b)return;
  var act=b.getAttribute('data-act'),id=Number(b.getAttribute('data-id'));e.preventDefault();
  if(act==='approve')approveInline(id);
  else if(act==='topickup')setStatus(id,'to_pickup');
  else if(act==='advance')advance(id,b.getAttribute('data-next'));
  else if(act==='fail'){if(confirm('לסמן את ההזמנה כנכשלת?'))setStatus(id,'failed');}
  else if(act==='markpaid')markPaid(id);
  else if(act==='pod')showPod(id);
  else if(act==='driverproofs')showDriverProofs(id);
  else if(act==='copy'){copyPay(b.getAttribute('data-pay'));alert('הקישור הועתק ללוח ✓');}
  else if(act==='refresh')refresh();
  else if(act==='logout')logout();
  else if(act==='toggledone')toggleDone();
  else if(act==='notifs'){notifOrderId=(notifOrderId===id)?null:id;refresh();}
  else if(act==='gps')toggleGps(id);
});
refresh();
setInterval(function(){if(!(document.activeElement&&document.activeElement.tagName==='INPUT'))refresh();},15000);
</script></body></html>`;
}
