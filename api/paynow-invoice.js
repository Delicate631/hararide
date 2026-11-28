// Vercel serverless function: pay an unpaid company invoice online with Paynow.
//   POST {action:"start", invoiceId}   -> {url}   send the customer to Paynow (card, Zimswitch, InnBucks, mobile banking...)
//   POST {action:"check", businessId}  -> {paid}  confirm any payments that were started for this company's open invoices
// Needs Vercel Environment Variables: PAYNOW_ID, PAYNOW_KEY, SITE_URL (already set for /api/paynow) and SUPABASE_SERVICE_KEY.
const { db, getUser, sign, parse, settle, ID, SITE } = require("./_invoicepay");

module.exports = async (req, res) => {
  try {
    if (!process.env.SUPABASE_SERVICE_KEY && !process.env.SUPABASE_SERVICE_ROLE_KEY)
      return res.status(500).json({ error: "Online payment is not set up yet (missing SUPABASE_SERVICE_KEY)." });
    const user = await getUser(req);
    if (!user) return res.status(401).json({ error: "Please sign in again." });
    const { action, invoiceId, businessId } = req.body || {};

    const isCompanyAdmin = async (bid) =>
      (await db(`business_members?business_id=eq.${Number(bid)}&user_id=eq.${user.id}&role=eq.admin&select=user_id`)).length > 0;

    if (action === "start") {
      const inv = (await db(`invoices?id=eq.${Number(invoiceId)}&select=id,number,total,status,business_id`))[0];
      if (!inv) return res.status(404).json({ error: "Invoice not found." });
      if (!(await isCompanyAdmin(inv.business_id))) return res.status(403).json({ error: "Only a company administrator can pay invoices." });
      if (inv.status !== "open") return res.status(400).json({ error: "This invoice is not unpaid." });
      const amount = Number(inv.total).toFixed(2);
      if (!(Number(amount) > 0)) return res.status(400).json({ error: "Nothing to pay on this invoice." });

      const reference = inv.number + "-" + Date.now().toString(36).toUpperCase();
      const f = {
        id: ID,
        reference,
        amount,
        additionalinfo: "HaulGo invoice " + inv.number,
        returnurl: SITE + "/?invoice=" + inv.id,
        resulturl: SITE + "/api/paynow-invoice-result",
        authemail: user.email || "",
        status: "Message",
      };
      const r = await fetch("https://www.paynow.co.zw/interface/initiatetransaction", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ ...f, hash: sign(Object.values(f)) }),
      });
      const o = parse(await r.text());
      if (String(o.status || "").toLowerCase() !== "ok" || !o.browserurl || !o.pollurl)
        return res.status(502).json({ error: "Paynow could not start the payment: " + (o.error || o.status || "no answer") });

      await db("invoice_payments", {
        method: "POST",
        body: JSON.stringify({ invoice_id: inv.id, reference, amount, poll_url: o.pollurl, user_id: user.id }),
      });
      return res.status(200).json({ url: o.browserurl });
    }

    if (action === "check") {
      if (!(await isCompanyAdmin(businessId))) return res.status(403).json({ error: "Not allowed." });
      const open = await db(`invoices?business_id=eq.${Number(businessId)}&status=eq.open&select=id`);
      if (!open.length) return res.status(200).json({ paid: 0 });
      const ids = open.map((i) => i.id).join(",");
      const pend = await db(`invoice_payments?invoice_id=in.(${ids})&status=eq.pending&select=*&order=id.desc&limit=10`);
      let paid = 0;
      for (const p of pend) if (await settle(p)) paid++;
      return res.status(200).json({ paid });
    }

    res.status(400).json({ error: "Unknown request." });
  } catch (e) {
    res.status(500).json({ error: "Payment service error. Please try again, or pay by bank transfer." });
  }
};
