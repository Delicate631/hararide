// POST /api/safety-alert   header: x-hg-secret   body: { id: <safety_alerts.id> }
// Called by the database the moment a HIGH or CRITICAL safety alert is created (see haulgo_safety_notify.sql).
// Sends (1) a phone notification to EVERY admin who has switched notifications on, and
//       (2) an email to the safety inbox(es).
// GET  /api/safety-alert?diag=1  (with the same header) shows which settings were found. No secrets are returned.
//
// Vercel environment variables:
//   SAFETY_ALERT_SECRET   a long random text. Must match the 'secret' you put in the database (haulgo_safety_notify.sql)
//   SUPABASE_SERVICE_ROLE_KEY, VAPID_PRIVATE_KEY, VAPID_PUBLIC_KEY   (you already have these)
//   RESEND_API_KEY        for email (resend.com). Optional: without it only phone notifications are sent
//   SAFETY_EMAIL_FROM     optional, e.g.  HaulGo Safety <safety@yourdomain.com>  (a domain verified in Resend)
//   SAFETY_ALERT_EMAILS   optional, comma separated. Default: the two addresses below
const crypto = require("crypto");

const SB_URL = (process.env.SUPABASE_URL || "https://strvlhdnrmdnfvieepzh.supabase.co").replace(/\/$/, "");
const DEFAULT_PUBLIC = "BAEfi5iAKo5sXzHtdi2EAEGXsjfe_Ho5wFMIkVa8xdOuP4p8YO8Ie3gMN91eGKVk614TS8bXtahpzv09eiynMBE";
const DEFAULT_EMAILS = "myambodelight@gmail.com,lalanadreymah@gmail.com";

const envFind = (exact, re) => {
  for (const k of exact) if (process.env[k]) return process.env[k];
  const hit = Object.keys(process.env).find(k => re.test(k) && process.env[k]);
  return hit ? process.env[hit] : "";
};
const cfg = () => ({
  secret: process.env.SAFETY_ALERT_SECRET || "",
  serviceKey: envFind(["SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_SERVICE_KEY", "SERVICE_ROLE_KEY"], /service.?(role|key)/i),
  vapidPrivate: envFind(["VAPID_PRIVATE_KEY", "VAPID_PRIVATE", "PUSH_PRIVATE_KEY"], /(vapid|push|web.?push).*priv|priv.*(vapid|push)/i),
  vapidPublic: envFind(["VAPID_PUBLIC_KEY", "VAPID_PUBLIC", "PUSH_PUBLIC_KEY"], /(vapid|push|web.?push).*pub|pub.*(vapid|push)/i) || DEFAULT_PUBLIC,
  subject: envFind(["VAPID_SUBJECT", "VAPID_EMAIL"], /vapid.*(subj|mail)/i) || "https://haulgo.vercel.app",
  resend: process.env.RESEND_API_KEY || "",
  from: process.env.SAFETY_EMAIL_FROM || "HaulGo Safety <onboarding@resend.dev>",
  emails: (process.env.SAFETY_ALERT_EMAILS || DEFAULT_EMAILS).split(",").map(s => s.trim()).filter(Boolean),
});

const b64u = b => Buffer.from(b).toString("base64url");
const fromB64u = s => Buffer.from(String(s), "base64url");
const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
const same = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };

async function db(c, path, opt = {}) {
  const r = await fetch(SB_URL + "/rest/v1/" + path, { method: opt.method || "GET", headers: { apikey: c.serviceKey, Authorization: "Bearer " + c.serviceKey, "Content-Type": "application/json", Accept: opt.accept || "application/json" } });
  if (!r.ok) throw new Error("db " + r.status + " " + path.slice(0, 40));
  return opt.method === "DELETE" ? null : r.json();
}
let subsInfo = null;
async function findSubs(c) {
  if (subsInfo) return subsInfo;
  const spec = await db(c, "", { accept: "application/openapi+json" });
  for (const [name, d] of Object.entries(spec.definitions || {})) {
    const cols = Object.keys(d.properties || {});
    if (cols.includes("endpoint") && cols.includes("p256dh") && cols.includes("auth")) {
      const userCol = ["user_id", "profile_id", "uid", "owner_id", "owner", "driver_id", "person_id"].find(x => cols.includes(x));
      if (userCol) return (subsInfo = { name, userCol });
    }
  }
  return null;
}

function vapidHeader(c, endpoint) {
  const pub = fromB64u(c.vapidPublic);
  const key = crypto.createPrivateKey({ key: { kty: "EC", crv: "P-256", d: b64u(fromB64u(c.vapidPrivate)), x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)) }, format: "jwk" });
  const head = b64u(JSON.stringify({ typ: "JWT", alg: "ES256" }));
  const body = b64u(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: c.subject }));
  const sig = crypto.sign("sha256", Buffer.from(head + "." + body), { key, dsaEncoding: "ieee-p1363" });
  return "vapid t=" + head + "." + body + "." + b64u(sig) + ", k=" + c.vapidPublic;
}
function encrypt(sub, payload) {
  const ua = fromB64u(sub.p256dh), authSecret = fromB64u(sub.auth);
  const ecdh = crypto.createECDH("prime256v1"); ecdh.generateKeys();
  const asPub = ecdh.getPublicKey(), secret = ecdh.computeSecret(ua), salt = crypto.randomBytes(16);
  const hk = (ikm, s, info, len) => Buffer.from(crypto.hkdfSync("sha256", ikm, s, info, len));
  const ikm = hk(secret, authSecret, Buffer.concat([Buffer.from("WebPush: info\0"), ua, asPub]), 32);
  const cek = hk(ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16);
  const nonce = hk(ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12);
  const cipher = crypto.createCipheriv("aes-128-gcm", cek, nonce);
  const data = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(payload), Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const rs = Buffer.alloc(4); rs.writeUInt32BE(4096);
  return Buffer.concat([salt, rs, Buffer.from([asPub.length]), asPub, data]);
}
async function sendPush(c, sub, obj) {
  const r = await fetch(sub.endpoint, { method: "POST", headers: { Authorization: vapidHeader(c, sub.endpoint), "Content-Encoding": "aes128gcm", "Content-Type": "application/octet-stream", TTL: "3600", Urgency: "high" }, body: encrypt(sub, JSON.stringify(obj)) });
  return r.status;
}

const KIND = { sos: "SOS", route_deviation: "Route deviation", incident: "Incident report", suspicious: "Suspicious activity" };

module.exports = async function handler(req, res) {
  const c = cfg();
  const given = req.headers["x-hg-secret"] || "";
  if (!c.secret || !given || !same(given, c.secret)) return res.status(401).json({ error: "Not allowed" });

  if (req.method === "GET" && req.query && req.query.diag) {
    let subs = null; try { if (c.serviceKey) subs = await findSubs(c); } catch (e) { subs = { error: String(e.message) }; }
    return res.status(200).json({ serviceKey: !!c.serviceKey, vapidPrivate: !!c.vapidPrivate, vapidPublic: !!c.vapidPublic, resendKey: !!c.resend, emailTo: c.emails.length, from: c.from, subsTable: subs });
  }
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  if (!c.serviceKey) return res.status(200).json({ ok: false, reason: "SUPABASE_SERVICE_ROLE_KEY missing" });

  let body = req.body; if (typeof body === "string") { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  const id = Number(body && body.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "Bad alert id" });

  try {
    const a = (await db(c, `safety_alerts?id=eq.${id}&select=*`))[0];
    if (!a) return res.status(200).json({ ok: false, reason: "alert not found" });
    if (a.severity !== "high" && a.severity !== "critical") return res.status(200).json({ ok: true, skipped: "not high or critical" });

    // who and where, for the message
    let ride = null, pax = null, drv = null;
    try { if (a.ride_id) ride = (await db(c, `rides?id=eq.${a.ride_id}&select=pickup_name,drop_name`))[0]; } catch (e) { }
    try { if (a.passenger_id) pax = (await db(c, `profiles?id=eq.${a.passenger_id}&select=name,phone`))[0]; } catch (e) { }
    try { if (a.driver_id) drv = (await db(c, `profiles?id=eq.${a.driver_id}&select=name,phone,plate`))[0]; } catch (e) { }
    const crit = a.severity === "critical";
    const title = (crit ? "🚨 CRITICAL: " : "⚠️ HIGH: ") + (KIND[a.kind] || "Safety alert");
    const trip = ride ? `${String(ride.pickup_name).split(",")[0]} → ${String(ride.drop_name).split(",")[0]}` : "";
    const pushBody = [a.title, trip].filter(Boolean).join(" · ").slice(0, 140);
    const map = a.lat && a.lng ? `https://maps.google.com/?q=${a.lat},${a.lng}` : "";

    // 1. phone notifications to every admin
    let devices = 0, sent = 0, admins = 0, pushNote = "";
    if (c.vapidPrivate) {
      try {
        const ids = (await db(c, "profiles?role=eq.admin&select=id")).map(x => x.id);
        admins = ids.length;
        const info = ids.length ? await findSubs(c) : null;
        if (info) {
          const subs = await db(c, `${info.name}?${info.userCol}=in.(${ids.join(",")})&select=endpoint,p256dh,auth`);
          devices = subs.length;
          const msg = { title, body: pushBody, tag: "safety-" + id, kind: "safety", url: "/", data: { kind: "safety", alert: id, url: "/" } };
          await Promise.all(subs.map(async s => {
            try {
              const st = await sendPush(c, s, msg);
              if (st >= 200 && st < 300) sent++;
              else if (st === 404 || st === 410) { try { await db(c, `${info.name}?endpoint=eq.${encodeURIComponent(s.endpoint)}`, { method: "DELETE" }); } catch (e) { } }
            } catch (e) { }
          }));
        } else pushNote = admins ? "no subscription table found" : "no admins found";
      } catch (e) { pushNote = String(e.message || e).slice(0, 100); }
    } else pushNote = "VAPID keys missing";

    // 2. email
    let emailed = 0, emailNote = "";
    if (c.resend && c.emails.length) {
      const line = (k, v) => v ? `<tr><td style="padding:4px 12px 4px 0;color:#64748b">${k}</td><td style="padding:4px 0"><b>${esc(v)}</b></td></tr>` : "";
      const who = p => p ? [p.name, p.phone, p.plate].filter(Boolean).join(" · ") : "";
      const d = a.detail || {};
      const html = `<div style="font-family:Arial,sans-serif;max-width:560px"><div style="background:${crit ? "#e11d48" : "#f97316"};color:#fff;padding:14px 18px;border-radius:12px 12px 0 0;font-size:18px;font-weight:bold">${esc(title)}</div>
<div style="border:1px solid #e2e8f0;border-top:0;padding:16px 18px;border-radius:0 0 12px 12px"><p style="font-size:16px;margin:0 0 12px"><b>${esc(a.title)}</b></p>
<table style="font-size:14px;border-collapse:collapse">${line("Trip", trip)}${line("Passenger", who(pax))}${line("Driver", who(drv))}${line("Details", d.message || "")}${line("Ride", a.ride_id ? "#" + a.ride_id : "")}${line("Time", new Date(a.created_at).toUTCString())}</table>
${map ? `<p style="margin:14px 0 0"><a href="${esc(map)}" style="background:#0f172a;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none">Open location on map</a></p>` : ""}
<p style="color:#64748b;font-size:12px;margin-top:16px">Open the HaulGo admin Safety tab to investigate and resolve. For anything urgent, call the passenger and driver now.</p></div></div>`;
      try {
        const r = await fetch("https://api.resend.com/emails", { method: "POST", headers: { Authorization: "Bearer " + c.resend, "Content-Type": "application/json" }, body: JSON.stringify({ from: c.from, to: c.emails, subject: title + (trip ? " (" + trip + ")" : ""), html }) });
        if (r.ok) emailed = c.emails.length; else emailNote = "email service said " + r.status;
      } catch (e) { emailNote = "email failed"; }
    } else emailNote = c.resend ? "no recipients" : "RESEND_API_KEY not set";

    return res.status(200).json({ ok: true, admins, devices, sent, emailed, pushNote, emailNote });
  } catch (e) {
    return res.status(200).json({ ok: false, reason: String(e.message || e).slice(0, 120) });
  }
};
