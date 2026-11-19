// Vercel serverless function: drivers top up their wallet with EcoCash through Paynow.
// Three jobs in one file:
//   1) {action:"start", amount, phone}  -> sends the EcoCash prompt to the driver's phone
//   2) {action:"check", ref}            -> app asks "has it been paid yet?"
//   3) Paynow's own status message (form POST) -> credits the wallet even if the app was closed
// The wallet is only credited after WE ask Paynow and Paynow says the payment is paid.
//
// Vercel environment variables needed:
//   PAYNOW_INTEGRATION_ID   (or PAYNOW_ID)   your Paynow integration id
//   PAYNOW_INTEGRATION_KEY  (or PAYNOW_KEY)  your Paynow integration key
//   SUPABASE_SERVICE_ROLE_KEY                Supabase > Project Settings > API > service_role / secret key
import crypto from "node:crypto";

const SUPABASE_URL = "https://strvlhdnrmdnfvieepzh.supabase.co";
const SUPABASE_KEY = "sb_publishable_mCQrObUp4aejmPm3VtQ_oA_TrFCxoWN";
const PAYNOW_START = "https://www.paynow.co.zw/interface/remotetransaction";
const PAID = ["paid", "awaiting delivery", "delivered"];
const FAILED = ["cancelled", "failed", "refunded", "disputed"];

const env = () => ({
  id: process.env.PAYNOW_INTEGRATION_ID || process.env.PAYNOW_ID,
  key: process.env.PAYNOW_INTEGRATION_KEY || process.env.PAYNOW_KEY,
  svc: process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY,
});

// Paynow signature: all values in order, plus your integration key, SHA512, upper case
export const hashOf = (values, key) =>
  crypto.createHash("sha512").update(values.join("") + key).digest("hex").toUpperCase();

export function parseMsg(text) {
  const o = {}, order = [];
  for (const p of String(text).split("&")) {
    const i = p.indexOf("=");
    if (i < 0) continue;
    const dec = (s) => { try { return decodeURIComponent(s.replace(/\+/g, " ")); } catch { return s; } };
    const k = dec(p.slice(0, i)).toLowerCase(), v = dec(p.slice(i + 1));
    o[k] = v; order.push(k);
  }
  return { o, order };
}
export const verifyMsg = ({ o, order }, key) =>
  !!o.hash && hashOf(order.filter((k) => k !== "hash").map((k) => o[k]), key) === String(o.hash).toUpperCase();

const db = (path, opt, svc) =>
  fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...opt,
    headers: { apikey: svc, ...(svc.startsWith("eyJ") ? { Authorization: `Bearer ${svc}` } : {}), "Content-Type": "application/json", ...(opt && opt.headers) },
  });

// Ask Paynow if a top-up has been paid; credit the wallet once if it has.
export async function settle(ref, cfg) {
  const rows = await (await db(`paynow_topups?ref=eq.${encodeURIComponent(ref)}&select=*`, {}, cfg.svc)).json();
  const t = Array.isArray(rows) ? rows[0] : null;
  if (!t) return { status: "unknown" };
  if (t.status === "paid") return { status: "paid", amount: +t.amount };
  if (t.status === "failed") return { status: "failed" };
  if (!t.poll_url || !/^https:\/\/www\.paynow\.co\.zw\//.test(t.poll_url)) return { status: "pending" };

  const p = await fetch(t.poll_url, { method: "POST" });
  const m = parseMsg(await p.text());
  if (!verifyMsg(m, cfg.key)) return { status: "pending" }; // could not prove it came from Paynow: never credit
  const st = String(m.o.status || "").toLowerCase();

  if (PAID.includes(st)) {
    if (m.o.amount && Math.abs(parseFloat(m.o.amount) - +t.amount) > 0.01) return { status: "pending" };
    const c = await db("rpc/paynow_credit", { method: "POST", body: JSON.stringify({ p_ref: ref }) }, cfg.svc);
    if (!c.ok) return { status: "pending" };
    return { status: "paid", amount: +t.amount };
  }
  if (FAILED.includes(st)) {
    await db(`paynow_topups?ref=eq.${encodeURIComponent(ref)}&status=eq.pending`, { method: "PATCH", body: JSON.stringify({ status: "failed" }), headers: { Prefer: "return=minimal" } }, cfg.svc);
    return { status: "failed" };
  }
  return { status: "pending" };
}

export default async function handler(req, res) {
  const cfg = env();
  if (!cfg.id || !cfg.key || !cfg.svc) return res.status(500).json({ error: "Paynow top-up is not set up yet" });
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  const ct = String(req.headers["content-type"] || "");

  try {
    // 3) Paynow telling us something changed. We never trust its content: we only use the reference to ask Paynow ourselves.
    if (ct.includes("application/x-www-form-urlencoded")) {
      const b = req.body && typeof req.body === "object" ? req.body : Object.fromEntries(new URLSearchParams(String(req.body || "")));
      const ref = String(b.reference || b.Reference || "").slice(0, 40);
      if (/^HGW-[A-Za-z0-9]+$/.test(ref)) await settle(ref, cfg).catch(() => {});
      return res.status(200).send("ok");
    }

    // signed-in drivers only
    const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    if (!token) return res.status(401).json({ error: "Please sign in" });
    const who = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${token}` } });
    if (!who.ok) return res.status(401).json({ error: "Session expired, please sign in again" });
    const user = await who.json();
    const prof = (await (await db(`profiles?id=eq.${user.id}&select=role`, {}, cfg.svc)).json())[0];
    if (!prof || !["driver", "admin"].includes(prof.role)) return res.status(403).json({ error: "Only drivers can top up" });

    const b = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};

    // 2) is it paid yet?
    if (b.action === "check") {
      const ref = String(b.ref || "");
      const mine = await (await db(`paynow_topups?ref=eq.${encodeURIComponent(ref)}&driver_id=eq.${user.id}&select=ref`, {}, cfg.svc)).json();
      if (!Array.isArray(mine) || !mine.length) return res.status(404).json({ error: "Payment not found" });
      return res.status(200).json(await settle(ref, cfg));
    }

    // 1) start a payment
    if (b.action !== "start") return res.status(400).json({ error: "Bad request" });
    const amount = Math.round(parseFloat(b.amount) * 100) / 100;
    if (!(amount >= 1 && amount <= 200)) return res.status(400).json({ error: "Enter an amount between $1 and $200" });
    let phone = String(b.phone || "").replace(/\D/g, "");
    if (phone.startsWith("263")) phone = "0" + phone.slice(3);
    if (phone.length === 9) phone = "0" + phone;
    if (!/^07[78]\d{7}$/.test(phone)) return res.status(400).json({ error: "Enter an EcoCash number like 0771234567" });

    const recent = await (await db(`paynow_topups?driver_id=eq.${user.id}&status=eq.pending&created_at=gte.${encodeURIComponent(new Date(Date.now() - 10 * 60e3).toISOString())}&select=ref`, {}, cfg.svc)).json();
    if (Array.isArray(recent) && recent.length >= 3) return res.status(429).json({ error: "Too many unfinished payments. Please wait a few minutes." });

    const ref = "HGW-" + crypto.randomBytes(6).toString("hex");
    const ins = await db("paynow_topups", { method: "POST", body: JSON.stringify({ ref, driver_id: user.id, amount, phone }), headers: { Prefer: "return=minimal" } }, cfg.svc);
    if (!ins.ok) return res.status(502).json({ error: "Could not start the payment" });

    const origin = `https://${req.headers["x-forwarded-host"] || req.headers.host}`;
    const fields = [
      ["id", cfg.id], ["reference", ref], ["amount", amount.toFixed(2)], ["additionalinfo", "HaulGo wallet top-up"],
      ["returnurl", origin], ["resulturl", origin + "/api/paynow-topup"], ["authemail", user.email || ""],
      ["phone", phone], ["method", "ecocash"], ["status", "Message"],
    ];
    const body = fields.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&") + "&hash=" + hashOf(fields.map(([, v]) => v), cfg.key);
    const pr = await fetch(PAYNOW_START, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body });
    const m = parseMsg(await pr.text());
    const fail = async (msg) => {
      await db(`paynow_topups?ref=eq.${ref}`, { method: "PATCH", body: JSON.stringify({ status: "failed" }), headers: { Prefer: "return=minimal" } }, cfg.svc);
      return res.status(502).json({ error: msg });
    };
    if (String(m.o.status || "").toLowerCase() !== "ok") return fail(String(m.o.error || "Paynow could not start the payment").slice(0, 160));
    if (!verifyMsg(m, cfg.key) || !m.o.pollurl) return fail("Paynow reply could not be checked");

    await db(`paynow_topups?ref=eq.${ref}`, { method: "PATCH", body: JSON.stringify({ poll_url: m.o.pollurl, paynow_ref: m.o.paynowreference || null }), headers: { Prefer: "return=minimal" } }, cfg.svc);
    return res.status(200).json({ ref, amount, instructions: String(m.o.instructions || "Check your phone and enter your EcoCash PIN.").slice(0, 300) });
  } catch (e) {
    return res.status(502).json({ error: "Payment service unavailable. Please try again." });
  }
}
