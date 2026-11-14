// Vercel serverless function: starts an EcoCash payment through Paynow Zimbabwe.
// Keys stay on the server (Vercel Environment Variables), never in the browser.
const crypto = require("crypto");

module.exports = async (req, res) => {
  try {
    const { rideId, amount, phone, email } = req.body || {};
    const key = process.env.PAYNOW_KEY;
    const f = {
      id: process.env.PAYNOW_ID,
      reference: "ride-" + rideId,
      amount: Number(amount).toFixed(2),
      additionalinfo: "Hararide trip",
      returnurl: process.env.SITE_URL,
      resulturl: process.env.SITE_URL + "/api/paynow-result",
      authemail: email,
      phone: phone,
      method: "ecocash",
      status: "Message",
    };
    // Paynow hash: SHA512 of all values joined in order + integration key, uppercase
    const hash = crypto.createHash("sha512").update(Object.values(f).join("") + key).digest("hex").toUpperCase();
    const r = await fetch("https://www.paynow.co.zw/interface/remotetransaction", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ ...f, hash }),
    });
    res.status(200).json(Object.fromEntries(new URLSearchParams(await r.text())));
  } catch (e) {
    res.status(500).json({ error: "Paynow request failed" });
  }
};
