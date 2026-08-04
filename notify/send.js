/* مُرسِل إشعارات الجوال — يعمل عبر GitHub Actions كل بضع دقائق.
   يقرأ الطلبات الجديدة (notified=false)، يرسل إشعار Web Push لأجهزة الفرع المستهدف،
   ثم يعلّم الطلب notified=true. لا يحتاج خادم دائم ولا خطة مدفوعة. */
const webpush = require("web-push");

const API_KEY = "AIzaSyCWyqw92zhtgvaZJdzo84QfdqCGrdDR6Mk"; // مفتاح عام (Firebase)
const PROJECT = "qarawi-parts";
const VAPID_PUBLIC = "BKBvoud5igKzASsCvZiEGWDoaGuolAO8U67975sJIMzAYbR0SexpoHVpsEd79Hl2sZmhV3hci7L6A53I6Nd6tTA";
const VAPID_PRIVATE = process.env.VAPID_PRIVATE;
if (!VAPID_PRIVATE) { console.error("Missing VAPID_PRIVATE secret"); process.exit(1); }
webpush.setVapidDetails("mailto:admin@qrawi.app", VAPID_PUBLIC, VAPID_PRIVATE);

const BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`;
const NAMES = {
  1:"بريدة – المستودع الإقليمي",2:"بريدة – الشارع التجاري",3:"بريدة – طريق الملك عبدالعزيز (الخبيب)",
  4:"بريدة – صناعية السليم 1",5:"الزلفي – مدخل الصناعية",6:"الرس – مقابل شركة الكهرباء",
  7:"عنيزة – الصناعية",8:"بريدة – صناعية السليم 2",9:"حفر الباطن – الصناعية",10:"بريدة – صناعية الرواف",
  11:"بريدة – المركز الرئيسي",12:"حائل – صناعية الجربوع",13:"المدينة – العزيزية طريق الجامعات",
  14:"جدة – كيلو 14 مجمع الورش",15:"جدة – قويزة",16:"المجمعة",17:"المدينة – عروة",
  18:"مكة – صناعية الدواس القديمة",19:"الجوف – سكاكا",20:"الطائف"
};

function val(v){
  if (v==null) return null;
  if ("integerValue" in v) return parseInt(v.integerValue,10);
  if ("doubleValue" in v) return v.doubleValue;
  if ("stringValue" in v) return v.stringValue;
  if ("booleanValue" in v) return v.booleanValue;
  if ("timestampValue" in v) return v.timestampValue;
  if ("nullValue" in v) return null;
  if ("arrayValue" in v) return (v.arrayValue.values||[]).map(val);
  if ("mapValue" in v){ const o={}, f=v.mapValue.fields||{}; for (const k in f) o[k]=val(f[k]); return o; }
  return null;
}
function fmtAmount(n){ return (Number(n)||0).toLocaleString("en-US",{maximumFractionDigits:2}); }
async function anonToken(){
  const r = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${API_KEY}`,{
    method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({returnSecureToken:true})
  });
  const j = await r.json();
  if (!j.idToken) throw new Error("auth failed: "+JSON.stringify(j));
  return j.idToken;
}
async function runQuery(token, structuredQuery){
  const r = await fetch(`${BASE}:runQuery`,{
    method:"POST", headers:{"Authorization":`Bearer ${token}`,"Content-Type":"application/json"},
    body: JSON.stringify({ structuredQuery })
  });
  return r.json();
}

(async ()=>{
  const token = await anonToken();
  const pending = await runQuery(token,{
    from:[{collectionId:"requests"}],
    where:{fieldFilter:{field:{fieldPath:"notified"},op:"EQUAL",value:{booleanValue:false}}},
    limit:50
  });
  let sent=0, reqs=0;
  for (const row of (pending||[])){
    if (!row.document) continue;
    reqs++;
    const docName = row.document.name;
    const f = row.document.fields||{};
    const to = val(f.to), from = val(f.from);
    const items = val(f.items)||[];
    const subs = await runQuery(token,{
      from:[{collectionId:"subs"}],
      where:{fieldFilter:{field:{fieldPath:"branchId"},op:"EQUAL",value:{integerValue:String(to)}}},
      limit:25
    });
    const payload = JSON.stringify({
      title:"طلب قطع جديد لفرعك",
      body:`من ${NAMES[from]||("فرع "+from)} · ${items.length} قطع`,
      url:"https://www.qrawi.com/",
      tag:"req-"+docName.split("/").pop()
    });
    for (const s of (subs||[])){
      if (!s.document) continue;
      const sub = val(s.document.fields.subscription);
      if (!sub || !sub.endpoint) continue;
      try { await webpush.sendNotification(sub, payload); sent++; }
      catch(e){
        if (e.statusCode===404 || e.statusCode===410){
          await fetch(`https://firestore.googleapis.com/v1/${s.document.name}`,{method:"DELETE",headers:{"Authorization":`Bearer ${token}`}});
        } else { console.warn("send error:", e.statusCode||e.message); }
      }
    }
    await fetch(`https://firestore.googleapis.com/v1/${docName}?updateMask.fieldPaths=notified`,{
      method:"PATCH", headers:{"Authorization":`Bearer ${token}`,"Content-Type":"application/json"},
      body: JSON.stringify({ fields:{ notified:{ booleanValue:true } } })
    });
  }
  // ===== الحوالات: 1) حوالة جديدة → إشعار المحاسب (subs branchId==0) =====
  const newTx = await runQuery(token,{
    from:[{collectionId:"transfers"}],
    where:{fieldFilter:{field:{fieldPath:"notified"},op:"EQUAL",value:{booleanValue:false}}},
    limit:50
  });
  for (const row of (newTx||[])){
    if (!row.document) continue;
    const docName=row.document.name, f=row.document.fields||{};
    const from=val(f.branchId), amount=val(f.amount);
    const subs=await runQuery(token,{
      from:[{collectionId:"subs"}],
      where:{fieldFilter:{field:{fieldPath:"branchId"},op:"EQUAL",value:{integerValue:"0"}}},
      limit:25
    });
    const payload=JSON.stringify({
      title:"حوالة بنكية جديدة",
      body:`من ${NAMES[from]||("فرع "+from)} · ${fmtAmount(amount)} ريال — بانتظار التأكيد`,
      url:"https://www.qrawi.com/", tag:"tx-"+docName.split("/").pop()
    });
    for (const s of (subs||[])){
      if (!s.document) continue;
      const sub=val(s.document.fields.subscription); if (!sub||!sub.endpoint) continue;
      try { await webpush.sendNotification(sub,payload); sent++; }
      catch(e){ if (e.statusCode===404||e.statusCode===410) await fetch(`https://firestore.googleapis.com/v1/${s.document.name}`,{method:"DELETE",headers:{"Authorization":`Bearer ${token}`}}); }
    }
    await fetch(`https://firestore.googleapis.com/v1/${docName}?updateMask.fieldPaths=notified`,{
      method:"PATCH", headers:{"Authorization":`Bearer ${token}`,"Content-Type":"application/json"},
      body: JSON.stringify({fields:{notified:{booleanValue:true}}})
    });
  }
  // ===== 2) حوالة تم البتّ فيها → إشعار الفرع (subs branchId==transfer.branchId) =====
  const decidedTx = await runQuery(token,{
    from:[{collectionId:"transfers"}],
    where:{fieldFilter:{field:{fieldPath:"notifiedBranch"},op:"EQUAL",value:{booleanValue:false}}},
    limit:50
  });
  for (const row of (decidedTx||[])){
    if (!row.document) continue;
    const docName=row.document.name, f=row.document.fields||{};
    const branchId=val(f.branchId), amount=val(f.amount), status=val(f.status);
    const subs=await runQuery(token,{
      from:[{collectionId:"subs"}],
      where:{fieldFilter:{field:{fieldPath:"branchId"},op:"EQUAL",value:{integerValue:String(branchId)}}},
      limit:25
    });
    const word = status==="confirmed" ? "تم تأكيد" : "تم رفض";
    const payload=JSON.stringify({
      title:`${word} حوالتك`,
      body:`${fmtAmount(amount)} ريال — ${status==="confirmed"?"مؤكدة ✓":"مرفوضة"}`,
      url:"https://www.qrawi.com/", tag:"txd-"+docName.split("/").pop()
    });
    for (const s of (subs||[])){
      if (!s.document) continue;
      const sub=val(s.document.fields.subscription); if (!sub||!sub.endpoint) continue;
      try { await webpush.sendNotification(sub,payload); sent++; }
      catch(e){ if (e.statusCode===404||e.statusCode===410) await fetch(`https://firestore.googleapis.com/v1/${s.document.name}`,{method:"DELETE",headers:{"Authorization":`Bearer ${token}`}}); }
    }
    await fetch(`https://firestore.googleapis.com/v1/${docName}?updateMask.fieldPaths=notifiedBranch`,{
      method:"PATCH", headers:{"Authorization":`Bearer ${token}`,"Content-Type":"application/json"},
      body: JSON.stringify({fields:{notifiedBranch:{booleanValue:true}}})
    });
  }
  console.log(`done. requests: ${reqs}, transfers new: ${(newTx||[]).filter(r=>r.document).length}, decided: ${(decidedTx||[]).filter(r=>r.document).length}, notifications sent: ${sent}`);
})().catch(e=>{ console.error(e); process.exit(1); });
