// Paynow calls this address when an EcoCash payment is confirmed. It verifies Paynow's signature,
// then marks the ride as paid. Needs env vars: PAYNOW_KEY, SUPABASE_URL, SUPABASE_SERVICE_KEY
const crypto = require("crypto");
module.exports = async (req, res) => {
  try {
    const { hash, ...rest } = req.body || {};
    const calc = crypto.createHash("sha512").update(Object.values(rest).join("") + process.env.PAYNOW_KEY).digest("hex").toUpperCase();
    if (calc !== String(hash || "").toUpperCase()) return res.status(400).end("bad hash");
    if (["paid", "delivered"].includes(String(rest.status).toLowerCase())) {
      const id = String(rest.reference).replace("ride-", "");
      const k = process.env.SUPABASE_SERVICE_KEY;
      await fetch(`${process.env.SUPABASE_URL}/rest/v1/rides?id=eq.${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { apikey: k, Authorization: "Bearer " + k, "Content-Type": "application/json" },
        body: JSON.stringify({ paid: true }),
      });
    }
    res.status(200).end("ok");
  } catch (e) { res.status(500).end("error"); }
};
