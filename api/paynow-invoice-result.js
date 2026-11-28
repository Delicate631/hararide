// Vercel serverless function: Paynow calls this when an invoice payment changes status.
// The message body is never trusted: we look the payment up by reference and ask Paynow directly for its status.
const { db, settle } = require("./_invoicepay");

module.exports = async (req, res) => {
  try {
    const ref = String((req.body && req.body.reference) || "");
    if (ref) {
      const rows = await db(`invoice_payments?reference=eq.${encodeURIComponent(ref)}&select=*`);
      if (rows[0]) await settle(rows[0]);
    }
  } catch (e) { /* Paynow only needs a 200; the app also re-checks when the company opens Invoices */ }
  res.status(200).send("ok");
};
