// GET /api/baseline  ->  calibration tables built from every finished regular-season game this season
import { seasonInfo, datesBetween, nhlToday, mapLimit } from "../lib/pipeline.js";
import { makeCal } from "../public/engine.js";
export default async function handler(req, res){
  try {
    const today = nhlToday();
    const season = await seasonInfo(today);
    const dates = datesBetween(season.start, today);
    const proto = req.headers["x-forwarded-proto"] || "https";
    const base = `${proto}://${req.headers.host}`;
    const pools = { F:[], D:[], G:[] }; let games = 0; const failed = [];
    await mapLimit(dates, 8, async d => {
      try {
        const r = await fetch(`${base}/api/day-raws?date=${d}`);
        if(!r.ok) throw new Error(r.status);
        const j = await r.json(); games += j.games;
        for(const k of ["F","D","G"]) pools[k].push(...j.raws[k]);
      } catch(e){ failed.push(d); }
    });
    const round = c => ({ n: c.n, mean: +c.mean.toFixed(4), sd: +c.sd.toFixed(4), q: c.q.map(v => +v.toFixed(3)) });
    const cal = {}; for(const k of ["F","D","G"]) cal[k] = round(makeCal(pools[k].length ? pools[k] : [0]));
    res.setHeader("Cache-Control", failed.length ? "public, s-maxage=300" : "public, s-maxage=3600, stale-while-revalidate=86400");
    res.status(200).json({ season: season.id, through: today, games, failed, cal });
  } catch(e){ res.status(502).json({ error: "Couldn't build the season baseline.", detail: String(e) }); }
}
