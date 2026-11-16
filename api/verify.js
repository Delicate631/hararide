// AI document pre-check for driver applications. Runs on the server so keys stay secret.
// Needs Vercel env vars: SUPABASE_URL, SUPABASE_SERVICE_KEY, ANTHROPIC_API_KEY
const SB = process.env.SUPABASE_URL, SK = process.env.SUPABASE_SERVICE_KEY, AK = process.env.ANTHROPIC_API_KEY;
const H = { apikey: SK, Authorization: "Bearer " + SK };
const SYSTEM = `You pre-screen documents for a taxi platform in Zimbabwe. You are given photos from a driver applicant and what they typed.
Do NOT identify anyone and do NOT compare or match faces. Only examine the documents and text.
Reply with ONLY JSON: {"status":"pass|review|reject","summary":"one short sentence","checks":[{"name":"","ok":true|false|null,"note":""}]}
Include these checks, using ok=null when you cannot tell:
1 ID number: the number printed on the national ID photo matches the typed number.
2 Names: the name on the ID, the name on the driving licence and the typed applicant name are consistent.
3 ID authenticity: the ID looks like a real physical document, not a photo of a screen, a photocopy, or edited or cropped.
4 Licence: a driving licence is present, readable and not obviously expired.
5 Selfie: one person is holding an ID document and the document text is readable, and it looks like the same document as in the ID photo (layout, number). Do not compare faces.
6 Number plate: the plate in the car photo is readable and matches the typed plate.
7 Photo quality: all four photos are clear enough to review.
Use "reject" only for clear mismatches or obvious fakes. Use "review" if anything is unreadable or uncertain. Use "pass" only if every check is clearly fine.`;
module.exports = async (req, res) => {
  try {
    const tok = (req.headers.authorization || "").replace("Bearer ", "");
    const u = await (await fetch(SB + "/auth/v1/user", { headers: { apikey: SK, Authorization: "Bearer " + tok } })).json();
    if (!u.id) return res.status(401).json({ error: "Not logged in" });
    const q = (path) => fetch(`${SB}/rest/v1/${path}`, { headers: H }).then((r) => r.json());
    const me = (await q(`profiles?id=eq.${u.id}&select=role`))[0];
    const target = (req.body && req.body.driver_id) || u.id;
    if (target !== u.id && (!me || me.role !== "admin")) return res.status(403).json({ error: "Not allowed" });
    const d = (await q(`driver_docs?driver_id=eq.${encodeURIComponent(target)}&select=*`))[0];
    const prof = (await q(`profiles?id=eq.${encodeURIComponent(target)}&select=name`))[0];
    if (!d) return res.status(404).json({ error: "No documents" });
    const content = [];
    for (const [label, p] of [["National ID photo", d.id_path], ["Driving licence photo", d.licence_path], ["Selfie holding the ID", d.selfie_path], ["Car photo", d.car_path]]) {
      const r = await fetch(`${SB}/storage/v1/object/driver-docs/${p.split("/").map(encodeURIComponent).join("/")}`, { headers: H });
      content.push({ type: "text", text: label + ":" }, { type: "image", source: { type: "base64", media_type: "image/jpeg", data: Buffer.from(await r.arrayBuffer()).toString("base64") } });
    }
    content.push({ type: "text", text: `Applicant typed: name "${prof?.name}", ID number "${d.id_number}", number plate "${d.plate}", car "${d.car_model}".` });
    const ai = await (await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST", headers: { "x-api-key": AK, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-sonnet-5-5", max_tokens: 1200, system: SYSTEM, messages: [{ role: "user", content }] }),
    })).json();
    let rep;
    try { rep = JSON.parse((ai.content[0].text || "").replace(/```json|```/g, "").trim()); }
    catch (e) { rep = { status: "review", summary: "AI could not read the documents. Check them yourself.", checks: [] }; }
    if (!["pass", "review", "reject"].includes(rep.status)) rep.status = "review";
    await fetch(`${SB}/rest/v1/driver_docs?driver_id=eq.${encodeURIComponent(target)}`, {
      method: "PATCH", headers: { ...H, "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify({ ai_status: rep.status, ai_report: rep, ai_checked_at: new Date().toISOString() }),
    });
    res.status(200).json({ status: rep.status });
  } catch (e) { res.status(500).json({ error: "Check failed" }); }
};
