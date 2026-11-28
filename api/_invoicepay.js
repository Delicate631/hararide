// Shared helpers for paying company invoices through Paynow (not a route: the underscore keeps Vercel from exposing it).
const crypto = require("crypto");

const SB = (process.env.SUPABASE_URL || "https://strvlhdnrmdnfvieepzh.supabase.co").replace(/\/$/, "");
const SVC = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY; // server only, never in the browser
const PUB = process.env.SUPABASE_ANON_KEY || "sb_publishable_mCQrObUp4aejmPm3VtQ_oA_TrFCxoWN";
const KEY = process.env.PAYNOW_KEY;
const ID = process.env.PAYNOW_ID;
const SITE = (process.env.SITE_URL || "https://haulgo.vercel.app").replace(/\/$/, "");

// Supabase REST call with the service key
async function db(path, opt = {}) {
  const r = await fetch(`${SB}/rest/v1/${path}`, {
    ...opt,
    headers: { apikey: SVC, Authorization: "Bearer " + SVC, "Content-Type": "application/json", Prefer: "return=representation", ...(opt.headers || {}) },
  });
  const t = await r.text();
  let j; try { j = JSON.parse(t); } catch (e) { j = t; }
  if (!r.ok) throw new Error(typeof j === "string" ? j : j.message || JSON.stringify(j));
  return j;
}

// who is calling? (the signed-in user's token from the app)
async function getUser(req) {
  const tok = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!tok) return null;
  const r = await fetch(`${SB}/auth/v1/user`, { headers: { apikey: PUB, Authorization: "Bearer " + tok } });
  if (!r.ok) return null;
  const u = await r.json();
  return u && u.id ? u : null;
}

// Paynow hash: SHA512 of all values joined in order + integration key, uppercase
const sign = (vals) => crypto.createHash("sha512").update(vals.join("") + KEY).digest("hex").toUpperCase();
const parse = (txt) => Object.fromEntries(new URLSearchParams(txt));

// Ask Paynow itself (not the browser, not the callback body) whether a payment went through, then mark the invoice paid.
// Returns true only when the invoice was marked paid by this call.
async function settle(p) {
  if (!p || p.status === "paid" || !String(p.poll_url || "").startsWith("https://www.paynow.co.zw/")) return false;
  const r = await fetch(p.poll_url, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" } });
  const o = parse(await r.text());
  const st = String(o.status || "").toLowerCase();
  const paid = st === "paid" || st === "awaiting delivery" || st === "delivered";
  if (!paid) return false;
  if (String(o.reference || "") !== p.reference) return false;
  if (Math.abs(Number(o.amount) - Number(p.amount)) > 0.009) return false;
  const ok = await db("rpc/hg_invoice_paid_online", {
    method: "POST",
    body: JSON.stringify({ p_payment: p.id, p_paynow_ref: o.paynowreference || null }),
  });
  return ok === true;
}

module.exports = { db, getUser, sign, parse, settle, ID, KEY, SITE };
