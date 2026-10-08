/* مُرسِل إشعارات الجوال — يعمل عبر GitHub Actions كل بضع دقائق.
   يقرأ المستندات الجديدة (notified=false / notifiedBranch=false)، يرسل إشعار Web Push
   لأجهزة الجهة المعنية، ثم يعلّم المستند. لا يحتاج خادم دائم ولا خطة مدفوعة.
   الدخول: حساب خدمة (FIREBASE_SERVICE_ACCOUNT) إن وُجد — وإلا دخول مجهول (قديم، أقل أماناً). */
const webpush = require("web-push");
const crypto = require("crypto");

const API_KEY = "AIzaSyCWyqw92zhtgvaZJdzo84QfdqCGrdDR6Mk"; // مفتاح عام (Firebase)
const PROJECT = "qarawi-parts";
const VAPID_PUBLIC = "BKBvoud5igKzASsCvZiEGWDoaGuolAO8U67975sJIMzAYbR0SexpoHVpsEd79Hl2sZmhV3hci7L6A53I6Nd6tTA";
const VAPID_PRIVATE = process.env.VAPID_PRIVATE;
if (!VAPID_PRIVATE) { console.error("Missing VAPID_PRIVATE secret"); process.exit(1); }
webpush.setVapidDetails("mailto:admin@qrawi.app", VAPID_PUBLIC, VAPID_PRIVATE);

const BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`;
const ADMIN_SUB = 0;   // اشتراكات الإدارة (كانت للمحاسب سابقاً)
const NAMES = {
  1:"بريدة – المستودع الإقليمي",2:"بريدة – الشارع التجاري",3:"بريدة – طريق الملك عبدالعزيز (الخبيب)",
  4:"بريدة – صناعية السليم 1",5:"الزلفي – مدخل الصناعية",6:"الرس – مقابل شركة الكهرباء",
  7:"عنيزة – الصناعية",8:"بريدة – صناعية السليم 2",9:"حفر الباطن – الصناعية",10:"بريدة – صناعية الرواف",
  11:"بريدة – المركز الرئيسي",12:"حائل – صناعية الجربوع",13:"المدينة – العزيزية طريق الجامعات",
  14:"جدة – كيلو 14 مجمع الورش",15:"جدة – قويزة",16:"المجمعة",17:"المدينة – عروة",
  18:"مكة – صناعية الدواس القديمة",19:"الجوف – سكاكا",20:"الطائف"
};
const bname = id => NAMES[id] || ("فرع " + id);

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

/* ---------- الدخول ---------- */
// حساب خدمة: يتجاوز قواعد Firestore، فيسمح بقفل القواعد على موظفي qrawi.app فقط
async function serviceAccountToken(sa){
  const now=Math.floor(Date.now()/1000);
  const b64=o=>Buffer.from(JSON.stringify(o)).toString("base64url");
  const unsigned=b64({alg:"RS256",typ:"JWT"})+"."+b64({iss:sa.client_email,scope:"https://www.googleapis.com/auth/datastore",
    aud:"https://oauth2.googleapis.com/token",iat:now,exp:now+3600});
  const sig=crypto.createSign("RSA-SHA256").update(unsigned).sign(sa.private_key).toString("base64url");
  const r=await fetch("https://oauth2.googleapis.com/token",{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},
    body:new URLSearchParams({grant_type:"urn:ietf:params:oauth:grant-type:jwt-bearer",assertion:unsigned+"."+sig})});
  const j=await r.json();
  if(!j.access_token) throw new Error("service account auth failed: "+JSON.stringify(j));
  return j.access_token;
}
async function anonToken(){
  const r = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${API_KEY}`,{
    method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({returnSecureToken:true})
  });
  const j = await r.json();
  if (!j.idToken) throw new Error("auth failed: "+JSON.stringify(j));
  return j.idToken;
}
async function getToken(){
  const raw=process.env.FIREBASE_SERVICE_ACCOUNT;
  if(raw && raw.trim()){ console.log("auth: service account"); return serviceAccountToken(JSON.parse(raw)); }
  console.warn("auth: anonymous (أضف FIREBASE_SERVICE_ACCOUNT لقفل قاعدة البيانات)");
  return anonToken();
}

/* ---------- أدوات Firestore REST ---------- */
let TOKEN;
const H = () => ({"Authorization":`Bearer ${TOKEN}`,"Content-Type":"application/json"});
async function runQuery(structuredQuery){
  const r = await fetch(`${BASE}:runQuery`,{ method:"POST", headers:H(), body: JSON.stringify({ structuredQuery }) });
  const j = await r.json();
  if (!Array.isArray(j)) { console.warn("query error:", JSON.stringify(j).slice(0,300)); return []; }
  return j.filter(row=>row.document);
}
const whereFalse = (collection, field) => runQuery({
  from:[{collectionId:collection}],
  where:{fieldFilter:{field:{fieldPath:field},op:"EQUAL",value:{booleanValue:false}}},
  limit:50
});
async function setFlag(docName, field){
  await fetch(`https://firestore.googleapis.com/v1/${docName}?updateMask.fieldPaths=${field}`,{
    method:"PATCH", headers:H(), body: JSON.stringify({ fields:{ [field]:{ booleanValue:true } } })
  });
}

let sent=0;
async function pushTo(subId, payload){
  const subs = await runQuery({
    from:[{collectionId:"subs"}],
    where:{fieldFilter:{field:{fieldPath:"branchId"},op:"EQUAL",value:{integerValue:String(subId)}}},
    limit:25
  });
  const body = JSON.stringify({ url:"https://www.qrawi.com/", ...payload });
  for (const s of subs){
    const sub = val(s.document.fields.subscription);
    if (!sub || !sub.endpoint) continue;
    try { await webpush.sendNotification(sub, body); sent++; }
    catch(e){
      if (e.statusCode===404 || e.statusCode===410)
        await fetch(`https://firestore.googleapis.com/v1/${s.document.name}`,{method:"DELETE",headers:H()});
      else console.warn("send error:", e.statusCode||e.message);
    }
  }
}

// قاعدة عامة: لكل مستند علمه false → أرسل للجهة → علّمه true
async function handle(collection, field, build){
  const rows = await whereFalse(collection, field);
  for (const row of rows){
    const docName=row.document.name, f=row.document.fields||{}, d={};
    for (const k in f) d[k]=val(f[k]);
    const msg = build(d, docName.split("/").pop());
    if (msg) await pushTo(msg.to, msg.payload);
    await setFlag(docName, field);
  }
  return rows.length;
}

(async ()=>{
  TOKEN = await getToken();
  const counts = {};

  // طلب قطع جديد → الفرع المطلوب منه
  counts.requests = await handle("requests","notified",(d,id)=>({ to:d.to, payload:{
    title:"طلب قطع جديد لفرعك", body:`من ${bname(d.from)} · ${(d.items||[]).length} قطع`, tag:"req-"+id }}));

  // حوالة جديدة → الإدارة
  counts.txNew = await handle("transfers","notified",(d,id)=>({ to:ADMIN_SUB, payload:{
    title:"حوالة بنكية جديدة", body:`من ${bname(d.branchId)} · ${fmtAmount(d.amount)} ريال — بانتظار التأكيد`, tag:"tx-"+id }}));

  // حوالة تم البتّ فيها → الفرع
  counts.txDecided = await handle("transfers","notifiedBranch",(d,id)=>{
    const ok=d.status==="confirmed";
    return { to:d.branchId, payload:{ title:`${ok?"تم تأكيد":"تم رفض"} حوالتك`,
      body:`${fmtAmount(d.amount)} ريال — ${ok?"مؤكدة ✓":"مرفوضة"}`, tag:"txd-"+id }};
  });

  // طلب مستلزمات جديد → الإدارة
  counts.supNew = await handle("supplies","notified",(d,id)=>({ to:ADMIN_SUB, payload:{
    title:"طلب مستلزمات جديد", body:`من ${bname(d.branchId)} · ${(d.items||[]).map(i=>i.name).slice(0,3).join("، ")}${(d.items||[]).length>3?"…":""}`, tag:"sup-"+id }}));

  // تم توفير المستلزمات → الفرع
  counts.supDone = await handle("supplies","notifiedBranch",(d,id)=>({ to:d.branchId, payload:{
    title:"تم توفير طلب المستلزمات ✓", body:`${(d.items||[]).length} صنف جاهز لفرعك`, tag:"supd-"+id }}));

  // إضافة كتالوج جديدة من فرع → الإدارة
  counts.catNew = await handle("catalog_adds","notified",(d,id)=> d.status!=="pending" ? null : ({ to:ADMIN_SUB, payload:{
    title:"إضافة كتالوج بانتظار الاعتماد", body:`${bname(d.branchId)} · ${d.kind==="car"?(d.car+" "+d.code):(d.name+" "+d.code)}`, tag:"cat-"+id }}));

  // قرار الإدارة على الإضافة → الفرع
  counts.catDecided = await handle("catalog_adds","notifiedBranch",(d,id)=>{
    const ok=d.status==="approved";
    return { to:d.branchId, payload:{ title:ok?"تم اعتماد إضافتك للكتالوج ✓":"رُفضت إضافتك للكتالوج",
      body:`${d.code||""}${!ok&&d.rejectReason?" — "+d.rejectReason:""}`, tag:"catd-"+id }};
  });

  console.log("done.", JSON.stringify(counts), "notifications sent:", sent);
})().catch(e=>{ console.error(e); process.exit(1); });
