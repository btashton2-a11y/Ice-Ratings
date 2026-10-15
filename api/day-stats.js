// GET /api/day-stats?date=YYYY-MM-DD  ->  per-player stat lines (with this site's xG and game scores) for that day's finished regular-season games
import { schedule, buildGame, isDone, mapLimit, nhlToday } from "../lib/pipeline.js";
import { scoreGame, derive, DEFAULTS, MIN_TOI_SK, MIN_TOI_G_BASE } from "../public/engine.js";
const r3 = v => Math.round(v * 1000) / 1000;
const shiftDay = (d, n) => { const x = new Date(d + "T12:00:00Z"); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0,10); };
// Skater: [id, name, team, pos, raw|null, toi, G, A, nonEmptyNetG, ixG, attempts, highDanger, CF5, CA5, xGF5, xGA5, SOG]
// Goalie: [id, name, team, "G", raw|null, toi, xGA, GA, hdFaced, hdSaves, SA, SV, decision]
// Both end with [gameId, opponent] (used for "Best of the week")
export function statLines(g){
  const dv = derive(g), sc = scoreGame(g, DEFAULTS), sk = [], go = [];
  g.p.forEach((r, i) => {
    const p = sc[i], team = g.t[r[0]].ab;
    if(i >= g.g0){
      const toi = r[7]; if(!toi) return; const q = dv[i];
      go.push([r[1], r[3], team, "G", toi >= MIN_TOI_G_BASE && p.raw != null ? r3(p.raw) : null, toi, r3(q.xga), q.ga, q.hdFaced, q.hdSaves, r[5], r[6], r[8] || "", g.id, g.t[1 - r[0]].ab]);
    } else {
      const s = dv[i], toi = r[12];
      sk.push([r[1], r[3], team, r[4], toi >= MIN_TOI_SK && p.raw != null ? r3(p.raw) : null, toi, r[5], r[6], r[5] - s.en, r3(s.ixg), s.icf, s.hd, r[20], r[21], r[22], r[23], r[11], g.id, g.t[1 - r[0]].ab]);
    }
  });
  return { sk, go };
}
export default async function handler(req, res){
  const date = req.query.date;
  if(!/^\d{4}-\d{2}-\d{2}$/.test(date || "")) return res.status(400).json({ error: "Pass date=YYYY-MM-DD." });
  try {
    const proto = req.headers["x-forwarded-proto"] || "https", base = `${proto}://${req.headers.host}`;
    const games = (await schedule(date)).filter(g => isDone(g.st) && String(g.id).slice(4,6) === "02");
    const sk = [], go = []; let mp = 0;
    await mapLimit(games, 4, async s => {
      let g; try { const r = await fetch(`${base}/api/game?id=${s.id}`); if(!r.ok) throw 0; g = await r.json(); } catch(e){ g = await buildGame(s.id, { base }); }
      if(g.xs === "moneypuck") mp++;
      const L = statLines(g); sk.push(...L.sk); go.push(...L.go);
    });
    const settled = date < nhlToday() && (mp === games.length || date < shiftDay(nhlToday(), -3));
    res.setHeader("Cache-Control", settled ? "public, s-maxage=2592000, stale-while-revalidate=2592000" : "public, s-maxage=1800");
    res.status(200).json({ date, games: games.length, sk, go });
  } catch(e){ res.status(502).json({ error: "Couldn't build that day's stat lines.", detail: String(e) }); }
}
