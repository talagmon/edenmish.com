// HTML pages: customer tracking (find.) + ops/driver dashboard (ops.)

import { customerFlow, liveGpsStatuses, opsLabelMap } from './status.js';

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
function ago(ms){const m=Math.max(0,Math.round((Date.now()-ms)/60000));return m<=1?'רגע':m+' דקות';}
async function load(){
  try{
    const r=await fetch('/api/orders/'+TOKEN); if(!r.ok) throw 0; const d=await r.json(); render(d);
  }catch(e){document.getElementById('app').innerHTML='<div class="card">לא נמצא משלוח. בדקו את הקישור.</div>';}
}
function render(d){
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
  if(isReview) pay='<div class="badge warn">ממתין לאישור מחיר — עדן תחזור אליכם</div>';
  if(o.payment_status==='paid'||o.status==='paid') pay='<div class="badge ok">שולם ₪'+(o.price||'')+'</div>';
  if(!pay && (o.status==='priced'||o.status==='payment_sent')) pay='<div class="badge warn">ממתין לתשלום</div><a class="btn" href="https://wa.me/972534058498?text='+encodeURIComponent('שלום עדן, בקשר להזמנה #'+o.id+' — אשמח לתאם תשלום')+'" target="_blank" rel="noopener" style="margin-top:8px">תיאום תשלום בוואטסאפ ←</a>';
  let summary='';
  if(isDone){summary='<div class="card"><h2>סיכום משלוח</h2><div class="kv"><span>איסוף</span><b>'+fmt(o.picked_up_at)+'</b></div><div class="kv"><span>מסירה</span><b>'+fmt(o.delivered_at)+'</b></div><div class="kv"><span>מחיר</span><b class="price">₪'+o.price+'</b></div><div class="kv"><span>סטטוס</span><b class="badge ok">נמסר</b></div></div>';}
  const gps=d.gps;
  let mapBlock='<div id="map"></div>'+(gps&&isLive?'<div class="muted" style="text-align:center">מיקום אחרון: לפני '+ago(gps.at)+'</div>':'');
  if(!isLive && !isDone) mapBlock='';
  document.getElementById('app').innerHTML=
    (d.otp_pending
      ? (o.otp_enabled === false
          ? '<div class="card" style="text-align:center"><div class="badge">מס׳ '+o.id+'</div><h2 style="margin-top:10px">מעקב מוגבל</h2><p class="muted" style="margin:8px 0 16px">לצפייה בפרטי השליחות נדרש אימות דוא״ל, אך לא צורפה כתובת דוא״ל להזמנה זו. לקבלת פרטים:</p><a class="btn" href="https://wa.me/972534058498" target="_blank" rel="noopener" style="width:auto;display:inline-block">צרו קשר בוואטסאפ ←</a></div>'
          : '<div class="card" id="verifyCard"><div style="text-align:center;margin-bottom:12px"><div class="badge">מס׳ '+o.id+'</div></div><h2>אימות כתובת הדוא״ל</h2><div class="muted" style="margin-bottom:16px">לצפייה בפרטי השליחות ובמעקב החי, הזינו את הקוד בן 6 הספרות שנשלח ל-<b>'+(o.email_masked||'')+'</b>.</div><div style="display:flex;gap:8px;align-items:center"><input id="otpInput" inputmode="numeric" maxlength="6" placeholder="••••••" style="flex:1;text-align:center;letter-spacing:8px;font-size:1.4rem;padding:12px;border:2px solid #B8A8C9;border-radius:10px"><button class="btn" onclick="verifyOtpNow()" style="width:auto;flex:none">אימות</button></div><div class="muted" style="text-align:center;margin-top:8px"><a href="#" onclick="resendOtp();return false" style="color:#5B2A86;font-weight:700">שלח קוד מחדש</a></div></div>')
      : '<div class="card"><div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px"><h2>סטטוס הזמנה</h2><span class="badge">מס׳ '+o.id+'</span></div><ul class="tl">'+tl+'</ul></div>'+
        '<div class="card"><h2>פרטי השליחות</h2>'+
          '<div class="kv"><span>איסוף</span><b>'+(o.pickup||'—')+(o.pickup_detail?' · '+o.pickup_detail:'')+'</b></div>'+
          '<div class="kv"><span>מסירה</span><b>'+(o.dropoff||'—')+(o.dropoff_detail?' · '+o.dropoff_detail:'')+'</b></div>'+
          '<div class="kv"><span>חבילה</span><b>'+(o.package||'—')+'</b></div>'+
          '<div class="kv"><span>מועד</span><b>'+(o.when_text||'—')+'</b></div>'+
          (o.price?'<div class="kv"><span>מחיר</span><b class="price">₪'+o.price+'</b></div>':'')+
        '</div>'+
        (pay?'<div class="card" style="text-align:center">'+pay+'</div>':'')+
        (isLive?'<div class="card"><h2>מפה חיה</h2>'+mapBlock+'</div>':'')+
        summary
    );
  if(!d.otp_pending && isLive && gps){ showMap(gps); }
}
function showMap(gps){
  const el=document.getElementById('map'); if(!el) return; el.style.display='block';
  const pos={lat:gps.lat,lng:gps.lng};
  if(!map){map=new google.maps.Map(el,{center:pos,zoom:14,disableDefaultUI:true});marker=new google.maps.Marker({position:pos,map:map});}
  else{map.panTo(pos);marker.setPosition(pos);}
}
async function verifyOtpNow(){
  var code=document.getElementById('otpInput').value.trim();
  if(!code){return;}
  var btn=event.target; btn.disabled=true; btn.textContent='…';
  var r=await fetch('/api/orders/'+TOKEN+'/verify-otp',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code:code})});
  var d=await r.json();
  if(d.verified){
    document.getElementById('app').innerHTML='<div class="card" style="text-align:center"><div class="badge ok" style="font-size:1rem;padding:10px">הדוא״ל אומת ✓ טוען פרטים…</div></div>';
    setTimeout(load,500);
  }
  else{btn.disabled=false; btn.textContent='אימות'; alert(d.error==='locked'?'יותר מדי ניסיונות שגויים — נסו שוב מאוחר יותר.':(d.error==='expired'?'פג תוקף הקוד — בקשו קוד חדש.':'קוד שגוי, נסו שוב.'));}
}
async function resendOtp(){var r=await fetch('/api/orders/'+TOKEN+'/resend-otp',{method:'POST'});var d=await r.json().catch(function(){return{};});alert(d&&d.error==='throttled'?'נשלחו יותר מדי קודים — נסו שוב מאוחר יותר.':'נשלח קוד חדש לדוא״ל');}
load();
setInterval(()=>{ if(true) load(); },7000);
</script></body></html>`;
}

export function opsHtml(env) {
  return `<!doctype html><html lang="he" dir="rtl"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>EdenMish · ניהול שליחויות</title>
<style>${CSS}
.row{display:flex;gap:8px;flex-wrap:wrap;margin-top:8px}
.row .btn{width:auto;flex:1;min-width:120px;font-size:.9rem;padding:10px}
.row .btn.alt{background:transparent;color:#5B2A86;border:1px solid rgba(91,42,134,.3)}
.sel{background:#fff;border:1px solid rgba(91,42,134,.2);border-radius:10px;padding:10px;margin:6px 0;cursor:pointer}
.sel.active{border-color:#5B2A86;background:#F5F2FB}
input,select{width:100%;padding:10px;border:1px solid rgba(91,42,134,.25);border-radius:8px;font-size:1rem;margin:4px 0}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.pill{font-size:.72rem;padding:2px 8px;border-radius:999px;background:#eee;margin-inline-start:6px}
.pill.rev{background:#FCE7CA;color:#7a4a00}.pill.std{background:#D8F0E0;color:#1c5e36}
.steps{display:flex;flex-direction:column;gap:4px;margin:10px 0}
.step{display:flex;align-items:center;gap:10px;padding:10px 8px;border-radius:10px}
.step-done{background:#E8F5E9}
.step-active{background:#E8F5E9;border:2px solid #2E8B57}
.step-todo{opacity:.45}
.step-err{background:#FDECEA;border:2px solid #C0392B}
.step-num{flex:none;width:32px;height:32px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:14px}
.step-done .step-num{background:#2E8B57;color:#fff}
.step-active .step-num{background:#2E8B57;color:#fff}
.step-todo .step-num{background:#ddd;color:#999}
.step-err .step-num{background:#C0392B;color:#fff}
.step-label{flex:1;font-size:.95rem;font-weight:600}
.step-active .step-label{color:#1c5e36}
.step-done .step-label{color:#1c5e36}
.step-todo .step-label{color:#aaa}
.step-btn{background:#2E8B57;color:#fff;border:0;padding:8px 14px;border-radius:8px;font-weight:700;cursor:pointer;font-size:.85rem;white-space:nowrap}
</style></head><body><div class="wrap">
<div class="brand">EdenMish · Ops</div><div class="sub">ניהול ומעקב שליחויות</div>
<div id="app"></div>
</div>
<script>
const HE=${JSON.stringify(opsLabelMap())};
let sess=null, orders=[], activeId=null, watchId=null;
const STEPS=[{s:'priced',l:'התקבלה ותומחרה'},{s:'paid',l:'שולם'},{s:'to_pickup',l:'בדרך לאיסוף'},{s:'picked_up',l:'נאסף'},{s:'to_dropoff',l:'בדרך למסירה'},{s:'delivered',l:'נמסר'}];
function stepIdx(s){var m={received:0,priced:0,payment_sent:0,review:0,paid:1,to_pickup:2,picked_up:3,to_dropoff:4,delivered:5};return m[s]!==undefined?m[s]:0;}
async function advance(id,cur){var nx=STEPS[cur+1];if(nx){await setStatus(id,nx.s);}}
const LS=()=>sess;
async function api(path,opts){opts=opts||{};opts.headers=opts.headers||{};if(sess)opts.headers['X-Ops']=sess;const r=await fetch(path,opts);return r;}
function loginHtml(){document.getElementById('app').innerHTML='<div class="card"><h2>כניסת אופס</h2><input id="pin" type="password" placeholder="PIN"><button class="btn" onclick="doLogin()">התחבר</button></div>';}
async function doLogin(){const pin=document.getElementById('pin').value;const r=await fetch('/api/ops/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({pin})});if(r.ok){sess=(await r.json()).session;main();}else{alert('PIN שגוי');}}
function fmt(t){return t?new Date(t).toLocaleString('he-IL'):'—';}
async function refresh(){const r=await api('/api/ops/orders');if(!r.ok){sess=null;return loginHtml();}orders=(await r.json()).orders||[];render();}
function render(){
  const list=orders.map(o=>'<div class="sel'+(o.id===activeId?' active':'')+'" onclick="selectOrder('+o.id+')"><b>#'+o.id+'</b> · '+(o.name||'')+' <span class="pill '+(o.review_flag?'rev':'std')+'">'+HE[o.status]+'</span>'+(o.review_flag?'<span class="pill rev">'+o.review_reason+'</span>':'')+'<div class="muted">'+(o.pickup||'')+' → '+(o.dropoff||'')+' · ₪'+(o.price||'?')+'</div></div>').join('')||'<div class="muted">אין הזמנות עדיין</div>';
  const o=orders.find(x=>x.id===activeId);
  let detail='';
  if(o){
    detail='<div class="card"><h2>#'+o.id+' · '+(o.name||'')+'</h2>'+
      '<div class="kv"><span>סטטוס</span><b>'+HE[o.status]+'</b></div>'+
      '<div class="kv"><span>טלפון</span><b>'+(o.phone||'')+'</b></div>'+
      '<div class="kv"><span>איסוף</span><b>'+(o.pickup||'')+(o.pickup_detail?' · '+o.pickup_detail:'')+'</b></div>'+
      '<div class="kv"><span>מסירה</span><b>'+(o.dropoff||'')+(o.dropoff_detail?' · '+o.dropoff_detail:'')+'</b></div>'+
      '<div class="kv"><span>חבילה</span><b>'+(o.package||'')+'</b></div>'+
      '<div class="kv"><span>מרחק</span><b>'+(o.distance_km?Number(o.distance_km).toFixed(1)+' ק"מ':'—')+'</b></div>'+
      '<div class="kv"><span>מחיר</span><b class="price">₪'+(o.price||'?')+'</b></div>'+
      '<div class="kv"><span>תשלום</span><b>'+o.payment_status+'</b></div>'+
      (o.review_flag?'<div class="stale">חריג: '+o.review_reason+' — נא לאשר מחיר</div>':'')+
      buildStepper(o)+
      '<div class="muted" style="margin-top:8px">נוצר: '+fmt(o.created_at)+'</div>'+
    '</div>';
  }
  document.getElementById('app').innerHTML='<div class="card"><div class="row"><button class="btn alt" onclick="refresh()">רענן</button> <button class="btn alt" onclick="sess=null;loginHtml()">התנתק</button></div></div><div class="card">'+list+'</div>'+detail;
  startGpsForActive();
}
function selectOrder(id){activeId=id;render();}
async function setStatus(id,st){await api('/api/ops/orders/'+id+'/status',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({status:st})});if(st==='to_pickup'||st==='to_dropoff')startWatch(id);if(st==='picked_up'||st==='delivered'||st==='failed')stopWatch();refresh();}
async function approve(id){const p=prompt('מחיר מאושר (₪):');if(!p)return;await api('/api/ops/orders/'+id+'/approve',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({price:Number(p)})});refresh();}
async function markPaid(id){await api('/api/ops/orders/'+id+'/status',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({status:'paid'})});await api('/api/ops/orders/'+id+'/status',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({status:'paid',payment_status:'paid_manual'})});refresh();}
function buildStepper(o){var cur=stepIdx(o.status);var isFail=(o.status==='failed'||o.status==='cancelled');var h='<div class="steps">';STEPS.forEach(function(st,i){var cls,icon,btn='';if(isFail&&i===cur){cls='step-err';icon='!';}else if(i<cur){cls='step-done';icon='\\u2713';}else if(i===cur){cls='step-active';icon=(i+1);if(o.review_flag&&i===0){btn='<button class="step-btn" onclick="approve('+o.id+')">אשר מחיר →</button>';}else if(i===0){btn='<span class="step-label" style="font-size:.78rem;color:#999">ממתין לתשלום…</span>';}else if(i<5){btn='<button class="step-btn" onclick="advance('+o.id+','+cur+')">הבא →</button>';}}else{cls='step-todo';icon=(i+1);}h+='<div class="step '+cls+'"><span class="step-num">'+icon+'</span><span class="step-label">'+st.l+'</span>'+btn+'</div>';});h+='</div><div style="margin-top:6px"><button class="btn alt" style="font-size:.8rem;padding:6px 12px;width:auto" onclick="setStatus('+o.id+',\\'failed\\')">סמן כנכשל</button>'+(o.status==='priced'&&!o.review_flag?' <button class="btn alt" style="font-size:.8rem;padding:6px 12px;width:auto" onclick="markPaid('+o.id+')">סמן כשולם ידנית</button>':'')+'</div>';return h;}
function startGpsForActive(){const o=orders.find(x=>x.id===activeId);if(o&&(o.status==='to_pickup'||o.status==='to_dropoff'))startWatch(o.id);}
function startWatch(id){if(watchId!==null)return;if(!navigator.geolocation)return;watchId=navigator.geolocation.watchPosition(p=>{const{latitude,longitude}=p.coords;fetch('/api/ops/orders/'+id+'/gps',{method:'POST',headers:{'Content-Type':'application/json','X-Ops':sess},body:JSON.stringify({lat:latitude,lng:longitude})});},()=>{},{enableHighAccuracy:true,maximumAge:5000});}
function stopWatch(){if(watchId!==null){navigator.geolocation.clearWatch(watchId);watchId=null;}}
loginHtml();
setInterval(()=>{if(sess)refresh();},15000);
</script></body></html>`;
}
