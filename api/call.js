// Vercel serverless function: creates a short-lived Daily call room for signed-in HaulGo users.
// Why: free Jitsi asks the first person to sign in with Google. Daily rooms made here need no sign-in for anyone.
// Setup: in Vercel > Project > Settings > Environment Variables add  DAILY_API_KEY  (from dashboard.daily.co > Developers), then redeploy.
import { randomBytes } from "node:crypto";

const SUPABASE_URL = "https://strvlhdnrmdnfvieepzh.supabase.co";
const SUPABASE_KEY = "sb_publishable_mCQrObUp4aejmPm3VtQ_oA_TrFCxoWN";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  const key = process.env.DAILY_API_KEY;
  if (!key) return res.status(500).json({ error: "Call service is not set up yet" });

  // only signed-in HaulGo users may create rooms
  const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!token) return res.status(401).json({ error: "Please sign in" });
  try {
    const who = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${token}` },
    });
    if (!who.ok) return res.status(401).json({ error: "Session expired, please sign in again" });

    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
    const minutes = Math.min(120, Math.max(1, Math.round(Number(body.minutes) || 5)));
    const video = !!body.video;

    const r = await fetch("https://api.daily.co/v1/rooms", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        name: "haulgo-" + randomBytes(8).toString("hex"),
        privacy: "public", // the long random name is the secret
        properties: {
          exp: Math.floor(Date.now() / 1000) + minutes * 60, // nobody can join after this
          eject_at_room_exp: true, // and everyone is removed at this time (the call time limit)
          max_participants: 6,
          start_video_off: !video,
          enable_prejoin_ui: false,
        },
      }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.url || !/^https:\/\/[a-z0-9-]+\.daily\.co\/haulgo-/i.test(j.url)) {
      return res.status(502).json({ error: j.info || j.error || "Could not create the call" });
    }
    return res.status(200).json({ url: j.url, minutes });
  } catch (e) {
    return res.status(502).json({ error: "Call service unavailable" });
  }
}
