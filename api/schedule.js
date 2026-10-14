// GET /api/schedule?date=YYYY-MM-DD  ->  games on that NHL date with live status
import { schedule, nhlToday, isLive } from "../lib/pipeline.js";
export default async function handler(req, res){
  const date = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || "") ? req.query.date : nhlToday();
  try {
    const games = await schedule(date);
    const today = nhlToday();
    const active = games.some(g => isLive(g.st)) || (date >= today && games.some(g => g.st !== "OFF" && g.st !== "FINAL"));
    res.setHeader("Cache-Control", active ? "public, s-maxage=30, stale-while-revalidate=30" : date < today ? "public, s-maxage=86400, stale-while-revalidate=604800" : "public, s-maxage=300, stale-while-revalidate=600");
    res.status(200).json({ date, today, games });
  } catch(e){ res.status(502).json({ error: "Couldn't reach the NHL schedule. Try again in a minute.", detail: String(e) }); }
}
