// POST /api/share-push   body: { ride: <id of the new shared ride request> }
// Sends a phone notification (works with the app closed) to drivers who are already on a SHARED trip
// that this new rider fits, using the same notification subscriptions your app already saves.
// GET  /api/share-push?diag=1   shows which settings were found (no secrets) to help with set-up.
const crypto = require("crypto");

const SB_URL = (process.env.SUPABASE_URL || "https://strvlhdnrmdnfvieepzh.supabase.co").replace(/\/$/, "");
const SB_ANON = process.env.SUPABASE_ANON_KEY || "sb_publishable_mCQrObUp4aejmPm3VtQ_oA_TrFCxoWN";
const DEFAULT_PUBLIC = "BAEfi5iAKo5sXzHtdi2EAEGXsjfe_Ho5wFMIkVa8xdOuP4p8YO8Ie3gMN91eGKVk614TS8bXtahpzv09eiynMBE";
const FIT_PICK_KM = 3, FIT_DROP_KM = 4, SHARE_MAX = 3, MAX_DRIVERS = 6;

// ---- find the settings you already added in Vercel (names are matched loosely) ----
const envFind = (exact, re) => {
  for (const k of exact) if (process.env[k]) return process.env[k];
  const hit = Object.keys(process.env).find(k => re.test(k) && process.env[k]);
  return hit ? process.env[hit] : "";
};
const cfg = () => ({
  serviceKey: envFind(["SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_SERVICE_KEY", "SERVICE_ROLE_KEY"], /service.?(role|key)/i),
  vapidPrivate: envFind(["VAPID_PRIVATE_KEY", "VAPID_PRIVATE", "PUSH_PRIVATE_KEY"], /(vapid|push|web.?push).*priv|priv.*(vapid|push)/i),
  vapidPublic: envFind(["VAPID_PUBLIC_KEY", "VAPID_PUBLIC", "PUSH_PUBLIC_KEY"], /(vapid|push|web.?push).*pub|pub.*(vapid|push)/i) || DEFAULT_PUBLIC,
  subject: envFind(["VAPID_SUBJECT", "VAPID_EMAIL"], /vapid.*(subj|mail)/i) || "https://haulgo.vercel.app",
});

const b64u = b => Buffer.from(b).toString("base64url");
const fromB64u = s => Buffer.from(String(s), "base64url");
const hav = (a, b, c, d) => { const t = x => x * Math.PI / 180, dl = t(c - a), dn = t(d - b), q = Math.sin(dl / 2) ** 2 + Math.cos(t(a)) * Math.cos(t(c)) * Math.sin(dn / 2) ** 2; return 12742 * Math.asin(Math.sqrt(q)); };

// ---- database (service key, server side only) ----
async function db(c, path, opt = {}) {
  const r = await fetch(SB_URL + "/rest/v1/" + path, { method: opt.method || "GET", headers: { apikey: c.serviceKey, Authorization: "Bearer " + c.serviceKey, "Content-Type": "application/json", Accept: opt.accept || "application/json" } });
  if (!r.ok) throw new Error("db " + r.status + " " + path.slice(0, 40));
  return opt.method === "DELETE" ? null : r.json();
}
let subsInfo = null;
async function findSubs(c) {   // the table where save_push() stores notification subscriptions
  if (subsInfo) return subsInfo;
  const spec = await db(c, "", { accept: "application/openapi+json" });
  const defs = spec.definitions || {};
  for (const [name, d] of Object.entries(defs)) {
    const cols = Object.keys(d.properties || {});
    if (cols.includes("endpoint") && cols.includes("p256dh") && cols.includes("auth")) {
      const userCol = ["user_id", "profile_id", "uid", "owner_id", "owner", "driver_id", "person_id"].find(x => cols.includes(x));
      if (userCol) return (subsInfo = { name, userCol });
    }
  }
  return null;
}

// ---- Web Push (RFC 8291 encryption + RFC 8292 VAPID), no extra packages needed ----
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
  const r = await fetch(sub.endpoint, { method: "POST", headers: { Authorization: vapidHeader(c, sub.endpoint), "Content-Encoding": "aes128gcm", "Content-Type": "application/octet-stream", TTL: "600", Urgency: "high" }, body: encrypt(sub, JSON.stringify(obj)) });
  return r.status;
}

module.exports = async function handler(req, res) {
  const c = cfg();
  if (req.method === "GET" && req.query && req.query.diag) {
    let subs = null; try { if (c.serviceKey) subs = await findSubs(c); } catch (e) { subs = { error: String(e.message) }; }
    return res.status(200).json({ serviceKey: !!c.serviceKey, vapidPrivate: !!c.vapidPrivate, vapidPublic: !!c.vapidPublic, subsTable: subs });
  }
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  if (!c.serviceKey || !c.vapidPrivate) return res.status(200).json({ ok: false, reason: "not configured" });

  // 1. who is asking?
  const tok = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!tok) return res.status(401).json({ error: "Login required" });
  let uid;
  try { const u = await fetch(SB_URL + "/auth/v1/user", { headers: { apikey: SB_ANON, Authorization: "Bearer " + tok } }); if (!u.ok) return res.status(401).json({ error: "Invalid session" }); uid = (await u.json()).id; }
  catch (e) { return res.status(502).json({ error: "Auth check failed" }); }

  let body = req.body; if (typeof body === "string") { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  const rideId = Number(body && body.ride);
  if (!Number.isInteger(rideId) || rideId <= 0) return res.status(400).json({ error: "Bad ride" });

  try {
    // 2. the new request must be theirs, brand new, still open and set to share
    const R = "id,passenger_id,status,shared,service,price,created_at,pickup_name,drop_name,pickup_lat,pickup_lng,drop_lat,drop_lng";
    const mine = (await db(c, `rides?id=eq.${rideId}&select=${R}`))[0];
    if (!mine || mine.passenger_id !== uid || mine.status !== "requested" || !mine.shared) return res.status(200).json({ ok: false, reason: "not eligible" });
    if (Date.now() - new Date(mine.created_at) > 5 * 60e3) return res.status(200).json({ ok: false, reason: "too old" });

    // 3. drivers already on a shared trip that this rider fits (same rules as the app's pop-up)
    const hosts = await db(c, `rides?status=in.(accepted,progress)&shared=eq.true&select=id,driver_id,status,service,pickup_lat,pickup_lng,drop_lat,drop_lng&limit=300`);
    const svc = mine.service || "taxi", byDriver = {};
    hosts.filter(h => h.driver_id && (h.service || "taxi") === svc).forEach(h => (byDriver[h.driver_id] = byDriver[h.driver_id] || []).push(h));
    const ids = Object.keys(byDriver).filter(d => byDriver[d].length < SHARE_MAX);
    let locs = {};
    const progIds = ids.filter(d => byDriver[d].some(h => h.status === "progress"));
    if (progIds.length) { try { (await db(c, `driver_locations?driver_id=in.(${progIds.join(",")})&select=driver_id,lat,lng`)).forEach(l => (locs[l.driver_id] = l)); } catch (e) { } }
    const targets = ids.filter(d => {
      const list = byDriver[d], h = list.find(x => x.status === "accepted") || list.find(x => x.status === "progress"), pos = locs[d];
      const fa = h.status === "progress" && pos ? pos.lat : h.pickup_lat, fo = h.status === "progress" && pos ? pos.lng : h.pickup_lng;
      return hav(mine.pickup_lat, mine.pickup_lng, fa, fo) <= FIT_PICK_KM && hav(mine.drop_lat, mine.drop_lng, h.drop_lat, h.drop_lng) <= FIT_DROP_KM;
    }).slice(0, MAX_DRIVERS);
    if (!targets.length) return res.status(200).json({ ok: true, drivers: 0, sent: 0 });

    // 4. their notification subscriptions
    const info = await findSubs(c);
    if (!info) return res.status(200).json({ ok: false, reason: "no subscription table found" });
    const subs = await db(c, `${info.name}?${info.userCol}=in.(${targets.join(",")})&select=endpoint,p256dh,auth`);
    const msg = { title: "👥 A rider wants to share your trip", body: `+$${(+mine.price || 0).toFixed(2)} · ${String(mine.pickup_name).split(",")[0]} → ${String(mine.drop_name).split(",")[0]}. Open HaulGo to review.`, tag: "jw-" + rideId, kind: "ride", ride: rideId, data: { kind: "ride", ride: rideId, url: "/" } };
    let sent = 0;
    await Promise.all(subs.map(async s => {
      try {
        const st = await sendPush(c, s, msg);
        if (st >= 200 && st < 300) sent++;
        else if (st === 404 || st === 410) { try { await db(c, `${info.name}?endpoint=eq.${encodeURIComponent(s.endpoint)}`, { method: "DELETE" }); } catch (e) { } }
      } catch (e) { }
    }));
    return res.status(200).json({ ok: true, drivers: targets.length, devices: subs.length, sent });
  } catch (e) {
    return res.status(200).json({ ok: false, reason: String(e.message || e).slice(0, 120) });
  }
};
