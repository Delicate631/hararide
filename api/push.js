// Vercel serverless function: sends a phone notification to the other person on a ride, or to a friend.
// Needs these Vercel environment variables:  VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT (e.g. mailto:you@gmail.com)
// No extra packages needed.
import crypto from "node:crypto";

const SUPABASE_URL = "https://strvlhdnrmdnfvieepzh.supabase.co";
const SUPABASE_KEY = "sb_publishable_mCQrObUp4aejmPm3VtQ_oA_TrFCxoWN";

const b64u = (b) => Buffer.from(b).toString("base64url");

// ---- VAPID: proves to the phone's push service that the message comes from your site ----
export function vapidAuth(endpoint, pubB64, privB64, subject) {
  const pub = Buffer.from(pubB64, "base64url");
  const key = crypto.createPrivateKey({
    key: { kty: "EC", crv: "P-256", x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)), d: privB64 },
    format: "jwk",
  });
  const head = b64u(JSON.stringify({ typ: "JWT", alg: "ES256" }));
  const body = b64u(JSON.stringify({
    aud: new URL(endpoint).origin,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600,
    sub: subject,
  }));
  const sig = crypto.sign("sha256", Buffer.from(head + "." + body), { key, dsaEncoding: "ieee-p1363" });
  return `vapid t=${head}.${body}.${b64u(sig)}, k=${pubB64}`;
}

// ---- Message encryption (RFC 8291, aes128gcm) ----
export function encryptPayload(text, p256dhB64, authB64) {
  const ua = Buffer.from(p256dhB64, "base64url"); // phone's public key (65 bytes)
  const authSecret = Buffer.from(authB64, "base64url"); // 16 bytes
  const ecdh = crypto.createECDH("prime256v1");
  ecdh.generateKeys();
  const asPub = ecdh.getPublicKey();
  const shared = ecdh.computeSecret(ua);
  const salt = crypto.randomBytes(16);
  const ikm = Buffer.from(crypto.hkdfSync("sha256", shared, authSecret,
    Buffer.concat([Buffer.from("WebPush: info\0"), ua, asPub]), 32));
  const cek = Buffer.from(crypto.hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16));
  const nonce = Buffer.from(crypto.hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12));
  const cipher = crypto.createCipheriv("aes-128-gcm", cek, nonce);
  const data = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(text), Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const rs = Buffer.alloc(4);
  rs.writeUInt32BE(4096);
  return Buffer.concat([salt, rs, Buffer.from([asPub.length]), asPub, data]);
}

async function rpc(name, args, token) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(args),
  });
  return r.ok ? r.json().catch(() => null) : null;
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  const pub = process.env.VAPID_PUBLIC_KEY, priv = process.env.VAPID_PRIVATE_KEY;
  const subject = process.env.VAPID_SUBJECT || "mailto:admin@haulgo.app";
  if (!pub || !priv) return res.status(500).json({ error: "Notifications are not set up yet" });

  const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!token) return res.status(401).json({ error: "Please sign in" });
  try {
    const who = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${token}` } });
    if (!who.ok) return res.status(401).json({ error: "Session expired" });

    const b = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
    const kind = b.kind === "dm" ? "dm" : b.kind === "ride" ? "ride" : null;
    if (!kind) return res.status(400).json({ error: "Bad request" });
    const payload = JSON.stringify({
      title: String(b.title || "HaulGo").slice(0, 60),
      body: String(b.body || "").slice(0, 140),
      tag: b.tag ? String(b.tag).slice(0, 40) : undefined,
      url: "/",
    });

    // the database decides who is allowed to be notified (the other person on the ride, or a friend who has not blocked you)
    const targets = (await rpc("push_targets", { p_kind: kind, p_to: b.to || null, p_ride: b.ride || null }, token)) || [];
    let sent = 0;
    await Promise.all(targets.slice(0, 10).map(async (t) => {
      try {
        const r = await fetch(t.ep, {
          method: "POST",
          headers: {
            Authorization: vapidAuth(t.ep, pub, priv, subject),
            "Content-Encoding": "aes128gcm",
            "Content-Type": "application/octet-stream",
            TTL: "120",
            Urgency: "high",
          },
          body: encryptPayload(payload, t.pk, t.ak),
        });
        if (r.status === 404 || r.status === 410) await rpc("push_drop", { p_endpoint: t.ep }, token);
        else if (r.ok) sent++;
      } catch (e) { /* one phone failing must not stop the others */ }
    }));
    return res.status(200).json({ sent });
  } catch (e) {
    return res.status(502).json({ error: "Notification service unavailable" });
  }
}
