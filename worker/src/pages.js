// HTML pages: customer tracking (find.) + ops/driver dashboard (ops.)

import { customerFlow, liveGpsStatuses, opsLabelMap, QUEUE_LAYOUT, queueStatusMap } from './status.js';

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
function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];})}
function ago(ms){const m=Math.max(0,Math.round((Date.now()-ms)/60000));return m<=1?'רגע':m+' דקות';}
async function load(){
  try{
    const r=await fetch('/api/orders/'+TOKEN); if(!r.ok) throw 0; const d=await r.json(); render(d);
  }catch(e){document.getElementById('app').innerHTML='<div class="card">לא נמצא משלוח. בדקו את הקישור.</div>';}
}
function render(d){
  const prevOtp=document.getElementById('otpInput'); const typedOtp=prevOtp?prevOtp.value:'';
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
          : '<div class="card" id="verifyCard"><div style="text-align:center;margin-bottom:12px"><div class="badge">מס׳ '+o.id+'</div></div><h2>אימות כתובת הדוא״ל</h2><div class="muted" style="margin-bottom:16px">לצפייה בפרטי השליחות ובמעקב החי, הזינו את הקוד בן 6 הספרות שנשלח ל-<b>'+(o.email_masked||'')+'</b>.</div><div style="display:flex;gap:8px;align-items:center"><input id="otpInput" inputmode="numeric" maxlength="6" placeholder="••••••" style="flex:1;text-align:center;letter-spacing:8px;font-size:1.4rem;padding:12px;border:2px solid #B8A8C9;border-radius:10px"><button class="btn" onclick="verifyOtpNow()" style="width:auto;flex:none">אימות</button></div><div class="muted" style="text-align:center;margin-top:8px"><a href="#" onclick="resendOtp();return false" style="color:#5B2A86;font-weight:700">שלח קוד מחדש</a></div></div>')
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
  if(d.otp_pending && typedOtp){ const inp=document.getElementById('otpInput'); if(inp) inp.value=typedOtp; }
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
setInterval(()=>{ if(!(document.activeElement&&document.activeElement.tagName==='INPUT')) load(); },7000);
</script></body></html>`;
}

export function opsHtml(env) {
  return `<!doctype html><html lang="he" dir="rtl"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>EdenMish · ניהול שליחויות</title>
<style>${CSS}
.qbucket{margin:14px 0}
.qhead{display:flex;align-items:center;gap:10px;padding:8px 2px;border-bottom:2px solid rgba(91,42,134,.18);margin-bottom:8px;flex-wrap:wrap}
.qhead-label{font-weight:800;color:#3E1D5E;font-size:1.02rem}
.qhead-count{background:#5B2A86;color:#fff;border-radius:999px;padding:2px 10px;font-size:.78rem;font-weight:700}
.qhead-hint{color:#9a93a8;font-size:.72rem;font-weight:400}
.qhead-toggle{margin-inline-start:auto;color:#5B2A86;font-size:.82rem;font-weight:700;cursor:pointer;background:none;border:0;padding:4px}
.qcards{display:flex;flex-direction:column;gap:8px}
.ocard{background:#fff;border:1px solid rgba(0,0,0,.08);border-radius:12px;padding:12px}
.ocard-active{border-color:#2E8B57;background:#F4FBF6}
.ocard-live{box-shadow:inset 0 0 0 2px rgba(192,57,43,.35)}
.ocard-top{display:flex;align-items:center;gap:8px;margin-bottom:4px;flex-wrap:wrap}
.ocard-top .price{margin-inline-start:auto;font-weight:800;color:#C9A96B}
.ocard-name{font-weight:700;font-size:.95rem}
.ocard-route{color:#5A5566;font-size:.92rem;margin:2px 0}
.ocard-meta{margin-top:6px;font-size:.72rem;color:#9a93a8}
.chip{display:inline-block;font-size:.68rem;padding:2px 8px;border-radius:999px;background:#eee;margin-inline-end:4px;margin-top:5px}
.chip-urg{background:#FDECEA;color:#C0392B;font-weight:700}
.chip-pay{background:#D8F0E0;color:#1c5e36}
.ocard-actions{margin-top:10px;border-top:1px dashed rgba(0,0,0,.08);padding-top:10px;display:flex;gap:6px;flex-wrap:wrap;align-items:center}
.inline-price{display:flex;gap:6px;align-items:stretch;width:100%}
.inline-price input{flex:1;margin:0;padding:12px;border:2px solid rgba(91,42,134,.3);border-radius:10px;font-size:1.1rem;text-align:center;min-width:80px}
.deliver-form{display:flex;flex-direction:column;gap:6px;width:100%}
.deliver-form input{margin:0;padding:12px;border:1px solid rgba(91,42,134,.25);border-radius:10px;font-size:1rem;text-align:right}
.btn.sm{width:auto;flex:none;padding:12px 16px;font-size:.9rem;min-height:44px}
.btn.go{background:#2E8B57}
.btn.go:hover{background:#267a49}
.btn.alt{background:transparent;color:#5B2A86;border:1px solid rgba(91,42,134,.3)}
.btn.danger{background:transparent;color:#C0392B;border:1px solid rgba(192,57,43,.3)}
.nlist{margin-top:8px;border-top:1px dashed rgba(0,0,0,.08);padding-top:8px}
.nrow{padding:6px 0;border-bottom:1px solid rgba(0,0,0,.04);font-size:.85rem}
.nrow:last-child{border-bottom:0}
.ns-ok{background:#2E8B57}.ns-fail{background:#C0392B}.ns-skip{background:#999}.ns-pend{background:#5B2A86}
.otoolbar{display:flex;align-items:center;gap:8px;justify-content:space-between;position:sticky;top:0;z-index:5}
.otoolbar .otitle{font-weight:800;color:#5B2A86;font-size:1rem}
.live-dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:#C0392B;animation:pulse 1.4s infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}}
</style></head><body><div class="wrap">
<div id="app"></div>
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
const NTPL={ops_new_order:'הזמנה חדשה לעדן',customer_otp:'קוד אימות',customer_payment_confirmation:'אישור תשלום',ops_payment_received:'תשלום התקבל',customer_delivery_summary:'סיכום מסירה'};
let sess=null, orders=[], activeId=null, watchId=null, doneOpen=false, notifOrderId=null, notifs=[];
function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];});}
function maskRecip(s){if(!s)return '';s=String(s);var at=s.indexOf('@');return at<1?s:(s[0]+'•••@'+s.slice(at+1));}
function bucketOf(s){return QOF[s]||'inbox';}
function fmt(t){return t?new Date(t).toLocaleString('he-IL'):'—';}
async function api(path,opts){opts=opts||{};opts.headers=opts.headers||{};if(sess)opts.headers['X-Ops']=sess;return await fetch(path,opts);}
function loginHtml(){document.getElementById('app').innerHTML='<div class="card"><h2>כניסת אופס</h2><input id="pin" type="password" placeholder="PIN"><button class="btn" onclick="doLogin()">התחבר</button></div>';}
async function doLogin(){const pin=document.getElementById('pin').value;const r=await fetch('/api/ops/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({pin})});if(r.ok){sess=(await r.json()).session;refresh();}else{alert(r.status===429?'יותר מדי ניסיונות שגויים — נסו שוב בעוד 15 דקות':'PIN שגוי');}}
function logout(){sess=null;stopWatch();loginHtml();}
async function refresh(){const r=await api('/api/ops/orders');if(!r.ok){sess=null;stopWatch();return loginHtml();}orders=(await r.json()).orders||[];var fails=[];try{var fr=await api('/api/ops/notifications/failures');if(fr.ok)fails=(await fr.json()).failures||[];}catch(e){}notifs=[];if(notifOrderId){try{var nr=await api('/api/ops/orders/'+notifOrderId+'/notifications');if(nr.ok)notifs=(await nr.json()).notifications||[];}catch(e){}}render(fails);}
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
  var toolbar='<div class="card otoolbar"><button class="btn sm alt" data-act="refresh">רענן</button><b class="otitle">EdenMish · Ops</b><button class="btn sm alt" data-act="logout">התנתק</button></div>';
  var fp=(fails&&fails.length)?'<div class="qbucket"><div class="qhead"><span class="qhead-label" style="color:#C0392B">בעיות בשליחת הודעות</span><span class="qhead-count">'+fails.length+'</span></div><div class="qcards">'+fails.map(function(f){return '<div class="ocard" style="border-color:rgba(192,57,43,.3)"><div class="ocard-top"><span class="badge" style="background:#C0392B">'+esc(f.channel||'email')+'</span><b>'+(f.order_id?'#'+f.order_id:'—')+'</b><span class="muted" style="margin-inline-start:auto;font-size:.72rem">'+fmt(f.created_at)+'</span></div><div class="muted">'+esc(f.template||'')+(f.recipient?' · '+esc(maskRecip(f.recipient)):'')+'</div><div class="stale" style="margin-top:4px">'+esc(f.error||'שגיאה לא ידועה')+'</div></div>';}).join('')+'</div></div>':'';
  document.getElementById('app').innerHTML=toolbar+sections+fp;
  startGpsForActive();
}
function card(o){
  var s=o.status,id=o.id,isLive=LIVE.indexOf(s)>=0,isActive=o.id===activeId;
  var h='<div class="ocard'+(isActive?' ocard-active':'')+(isLive?' ocard-live':'')+'">';
  h+='<div class="ocard-top">'+(isLive?'<span class="live-dot"></span>':'')+'<span class="badge">'+esc(HE[s]||s)+'</span><b>#'+id+'</b><span class="price">₪'+(o.price||'?')+'</span></div>';
  if(o.name)h+='<div class="ocard-name">'+esc(o.name)+'</div>';
  h+='<div class="ocard-route">'+esc(o.pickup||'—')+' ← '+esc(o.dropoff||'—')+'</div><div>';
  if(o.package)h+='<span class="chip">'+esc(o.package)+'</span>';
  if(o.urgent)h+='<span class="chip chip-urg">דחוף</span>';
  if(o.when_text)h+='<span class="chip">⏰ '+esc(o.when_text)+'</span>';
  if(o.payment_status&&o.payment_status!=='none')h+='<span class="chip chip-pay">'+esc(o.payment_status)+'</span>';
  h+='</div><div class="ocard-meta">נוצר: '+fmt(o.created_at)+(o.distance_km?' · '+Number(o.distance_km).toFixed(1)+' ק"מ':'')+'</div>';
  h+=actions(o);if(notifOrderId===id)h+=notifPanel();h+='</div>';
  return h;
}
function actions(o){
  var s=o.status,id=o.id,h='<div class="ocard-actions">';
  if(s==='review'||s==='priced'||s==='received'){
    h+='<div class="inline-price"><input type="number" inputmode="numeric" min="1" id="price-'+id+'" value="'+(o.price||'')+'" placeholder="מחיר ₪"><button class="btn sm go" data-act="approve" data-id="'+id+'">אישור מחיר ושליחת קישור תשלום</button></div>';
    if(o.review_flag)h+='<div class="stale" style="width:100%">חריג: '+esc(o.review_reason||'')+'</div>';
  }else if(s==='payment_sent'){
    if(o.payment_url)h+='<button class="btn sm" data-act="copy" data-pay="'+esc(o.payment_url)+'">העתק קישור תשלום</button><a class="btn sm alt" href="'+esc(o.payment_url)+'" target="_blank" rel="noopener">פתח קישור</a>';
    h+='<button class="btn sm alt" data-act="markpaid" data-id="'+id+'">סמן כשולם ידנית</button>';
  }else if(s==='paid'){
    h+='<button class="btn sm go" data-act="topickup" data-id="'+id+'">'+NEXTLBL['paid']+'</button>';
  }else if(s==='to_dropoff'){
    h+='<div class="deliver-form"><input type="text" id="recv-'+id+'" placeholder="שם המקבל (אופציונלי)"><input type="text" id="dnote-'+id+'" placeholder="הערת מסירה (אופציונלי)"><button class="btn sm go" data-act="deliver" data-id="'+id+'">סימון כנמסר ✓</button></div><button class="btn sm danger" data-act="fail" data-id="'+id+'">סמן כנכשל</button>';
  }else if(NEXT[s]){
    h+='<button class="btn sm go" data-act="advance" data-id="'+id+'" data-next="'+NEXT[s]+'">'+NEXTLBL[s]+'</button><button class="btn sm danger" data-act="fail" data-id="'+id+'">סמן כנכשל</button>';
  }
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
    if(d&&d.ok){if(d.payment_url){copyPay(d.payment_url);alert('המחיר אושר ✓\\nקישור התשלום הועתק ללוח.');}else{alert('המחיר אושר ✓');}refresh();}
    else{throw 0;}
  }catch(e){if(btn){btn.disabled=false;btn.textContent=btn.dataset.label||'אישור מחיר';}alert('שגיאה באישור המחיר. נסו שוב.');}
}
function copyPay(url){if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(url).catch(function(){});}else{var t=document.createElement('textarea');t.value=url;document.body.appendChild(t);t.select();try{document.execCommand('copy');}catch(e){}document.body.removeChild(t);}}
async function setStatus(id,st){await api('/api/ops/orders/'+id+'/status',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({status:st})});if(st==='to_pickup'||st==='to_dropoff'){activeId=id;startWatch(id);}if(st==='picked_up'||st==='delivered'||st==='failed'||st==='cancelled')stopWatch();refresh();}
async function advance(id,cur){if(NEXT[cur])await setStatus(id,NEXT[cur]);}
async function markPaid(id){if(!confirm('לסמן כשולם ידנית?'))return;await api('/api/ops/orders/'+id+'/status',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({status:'paid'})});refresh();}
async function deliverInline(id){
  var recv=(document.getElementById('recv-'+id)||{}).value||'';
  var note=(document.getElementById('dnote-'+id)||{}).value||'';
  var btn=document.querySelector('[data-act="deliver"][data-id="'+id+'"]');if(btn){btn.disabled=true;btn.dataset.label=btn.textContent;btn.textContent='טוען…';}
  try{
    var r=await api('/api/ops/orders/'+id+'/deliver',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({receiver_name:recv,delivery_note:note})});
    var d=await r.json();
    if(d&&d.ok){alert('המשלוח סומן כנמסר ✓');refresh();}else{throw 0;}
  }catch(e){if(btn){btn.disabled=false;btn.textContent=btn.dataset.label||'סימון כנמסר';}alert('שגיאה בסיום המשלוח. נסו שוב.');}
}
function toggleDone(){doneOpen=!doneOpen;render();}
function startGpsForActive(){var o=orders.find(function(x){return x.id===activeId;});if(o&&(o.status==='to_pickup'||o.status==='to_dropoff'))startWatch(o.id);}
function startWatch(id){if(watchId!==null)return;if(!navigator.geolocation)return;watchId=navigator.geolocation.watchPosition(function(p){var c=p.coords;fetch('/api/ops/orders/'+id+'/gps',{method:'POST',headers:{'Content-Type':'application/json','X-Ops':sess},body:JSON.stringify({lat:c.latitude,lng:c.longitude})});},function(){},{enableHighAccuracy:true,maximumAge:5000});}
function stopWatch(){if(watchId!==null){navigator.geolocation.clearWatch(watchId);watchId=null;}}
document.getElementById('app').addEventListener('click',function(e){
  var b=e.target.closest('[data-act]');if(!b)return;
  var act=b.getAttribute('data-act'),id=Number(b.getAttribute('data-id'));e.preventDefault();
  if(act==='approve')approveInline(id);
  else if(act==='topickup')setStatus(id,'to_pickup');
  else if(act==='advance')advance(id,b.getAttribute('data-next'));
  else if(act==='fail'){if(confirm('לסמן את ההזמנה כנכשלת?'))setStatus(id,'failed');}
  else if(act==='markpaid')markPaid(id);
  else if(act==='deliver')deliverInline(id);
  else if(act==='copy'){copyPay(b.getAttribute('data-pay'));alert('הקישור הועתק ללוח ✓');}
  else if(act==='refresh')refresh();
  else if(act==='logout')logout();
  else if(act==='toggledone')toggleDone();
  else if(act==='notifs'){notifOrderId=(notifOrderId===id)?null:id;refresh();}
});
loginHtml();
setInterval(function(){if(sess&&!(document.activeElement&&document.activeElement.tagName==='INPUT'))refresh();},15000);
</script></body></html>`;
}
