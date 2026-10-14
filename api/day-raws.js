// GET /api/day-raws?date=YYYY-MM-DD  ->  game scores of every rated player in that day's finished games, by position
import { schedule, buildGame, isDone, mapLimit, nhlToday } from "../lib/pipeline.js";
import { gameRaws } from "../public/engine.js";
export default async function handler(req, res){
  const date = req.query.date;
  if(!/^\d{4}-\d{2}-\d{2}$/.test(date || "")) return res.status(400).json({ error: "Pass date=YYYY-MM-DD." });
  try {
    const games = (await schedule(date)).filter(g => isDone(g.st) && String(g.id).slice(4,6) === "02");
    const raws = { F:[], D:[], G:[] };
    await mapLimit(games, 4, async g => { const r = gameRaws(await buildGame(g.id)); for(const k of ["F","D","G"]) raws[k].push(...r[k]); });
    const settled = date < nhlToday();
    res.setHeader("Cache-Control", settled ? "public, s-maxage=2592000, stale-while-revalidate=2592000" : "public, s-maxage=600");
    res.status(200).json({ date, games: games.length, raws });
  } catch(e){ res.status(502).json({ error: "Couldn't build that day's game scores.", detail: String(e) }); }
}
