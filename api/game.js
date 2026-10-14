// GET /api/game?id=2026020090  ->  compact game data with expected goals and on-ice stats
import { buildGame, isDone } from "../lib/pipeline.js";
export default async function handler(req, res){
  const id = +req.query.id;
  if(!/^\d{10}$/.test(String(id))) return res.status(400).json({ error: "Pass a 10-digit NHL game id, like 2026020090." });
  try {
    const proto = req.headers["x-forwarded-proto"] || "https", base = `${proto}://${req.headers.host}`;
    const g = await buildGame(id, { base });
    // Finished games with MoneyPuck xG are final; finished games still on our own model re-check every 30 minutes until MoneyPuck's nightly file has them
    const cache = !isDone(g.st) ? "public, s-maxage=30, stale-while-revalidate=30"
      : g.xs === "moneypuck" ? "public, s-maxage=86400, stale-while-revalidate=604800" : "public, s-maxage=1800, stale-while-revalidate=600";
    res.setHeader("Cache-Control", cache);
    res.status(200).json(g);
  } catch(e){ res.status(502).json({ error: "Couldn't load this game from the NHL. Try again in a minute.", detail: String(e) }); }
}
