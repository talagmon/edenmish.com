// Authenticated-only caller supplies non-secret grant metadata; no PIN/key is embedded.
export function rehearsalOpsHtml(run,full,{runIssued=false,grantIssued=false,off=true}={}) {
 const encoded=JSON.stringify({run:{version:1,run_id:run.run_id,approve:true},full:{version:1,grant_id:full.grant_id,budget_id:full.budget_id,source_sha256:full.source_sha256,approve:true}}).replaceAll('<','\\u003c');
 return `<!doctype html><html lang="he" dir="rtl"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>בדיקת תשלום EdenMish</title>
 <style>body{font-family:system-ui;max-width:640px;margin:40px auto;padding:20px;background:#faf8fc;color:#302938}button,a{padding:12px;margin:6px}button{background:#5b2a86;color:white;border:0;border-radius:10px}button:disabled{opacity:.45}p{line-height:1.6}</style>
 <h1>בדיקת תשלום — ללא משלוח</h1><p>תשלום אמיתי בסך ₪1 בלבד. לא יבוצעו איסוף או מסירה.</p>
 <p>חלון הבדיקה: ${new Date(run.starts_at).toISOString()} עד ${new Date(run.expires_at).toISOString()} (UTC).</p>
 <p>הכנת הרשאות אינה מפעילה הודעות. המפעיל מאמת את הרישום לפני הפעלה נפרדת.</p>
 <button id="run" ${runIssued||!off?'disabled':''}>1. הכנת הרשאת תשלום פעם אחת</button>
 <button id="full" ${grantIssued||!off?'disabled':''}>2. הכנת הרשאת שיחה פעם אחת</button>
 <button id="stop">עצירת הבדיקה</button><p id="status" role="status"></p><a href="/ops">לרשימת ההזמנות</a>
 <script>const grants=${encoded};
 const paths={run:'/api/ops/payment-rehearsal/grant',full:'/api/ops/whatsapp/full/grant',stop:'/api/ops/payment-rehearsal/stop'};
 for(const kind of ['run','full','stop']){const button=document.getElementById(kind),key='rehearsal:'+grants.run.run_id+':'+kind;
 try{if(sessionStorage.getItem(key))button.disabled=true;}catch{button.disabled=true;}
 button.onclick=async()=>{button.disabled=true;const status=document.getElementById('status');
 try{sessionStorage.setItem(key,'attempted');}catch{status.textContent='הפעולה לא נשלחה. יש לפנות למפעיל.';return;}
 status.textContent='הפעולה נשלחת פעם אחת. אין לנסות שוב.';
 try{const response=await fetch(paths[kind],{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify(grants[kind]||{})});const result=await response.json();
 status.textContent=response.ok&&(result.ok===true||result.issued===true)?(kind==='stop'?'העצירה נרשמה. המפעיל ממשיך בניתוק ובניקוי.':'ההרשאה נרשמה. ההודעות נשארות כבויות.'): 'התוצאה לא אומתה. אין לנסות שוב; המפעיל יבדוק את הרישום.';
 }catch{status.textContent='התוצאה אינה ודאית. אין לנסות שוב; המפעיל יבדוק את הרישום.';}};}
 </script></html>`;
}
