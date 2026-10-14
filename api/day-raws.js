// GET /api/day-raws?date=YYYY-MM-DD  ->  game scores of every rated player in that day's finished games, by position
import { schedule, buildGame, isDone, mapLimit, nhlToday } from "../lib/pipeline.js";
import { gameRaws } from "../public/engine.js";
const shiftDay = (d, n) => { const x = new Date(d + "T12:00:00Z"); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0,10); };
export default async function handler(req, res){
  const date = req.query.date;
  if(!/^\d{4}-\d{2}-\d{2}$/.test(date || "")) return res.status(400).json({ error: "Pass date=YYYY-MM-DD." });
  try {
    const games = (await schedule(date)).filter(g => isDone(g.st) && String(g.id).slice(4,6) === "02");
    const proto = req.headers["x-forwarded-proto"] || "https", base = `${proto}://${req.headers.host}`;
    const raws = { F:[], D:[], G:[] }; let mp = 0;
    await mapLimit(games, 4, async s => { const g = await buildGame(s.id, { base }); if(g.xs === "moneypuck") mp++; const r = gameRaws(g); for(const k of ["F","D","G"]) raws[k].push(...r[k]); });
    // A past day is final once every game has MoneyPuck's xG (or after 3 days, if MoneyPuck never posts one)
    const settled = date < nhlToday() && (mp === games.length || date < shiftDay(nhlToday(), -3));
    res.setHeader("Cache-Control", settled ? "public, s-maxage=2592000, stale-while-revalidate=2592000" : "public, s-maxage=1800");
    res.status(200).json({ date, games: games.length, raws });
  } catch(e){ res.status(502).json({ error: "Couldn't build that day's game scores.", detail: String(e) }); }
}
