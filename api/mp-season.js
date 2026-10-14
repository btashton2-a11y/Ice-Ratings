// GET /api/mp-season  ->  MoneyPuck.com's expected goals for every shot this season, grouped by game.
// Data: MoneyPuck.com (free for non-commercial use, with credit). Re-checked every 30 minutes; MoneyPuck updates nightly.
import { seasonInfo, nhlToday } from "../lib/pipeline.js";
import { fetchMoneyPuckSeason } from "../lib/moneypuck.js";
export default async function handler(req, res){
  try {
    const season = await seasonInfo(nhlToday());
    const start = Math.floor(season.id / 10000);
    const d = await fetchMoneyPuckSeason(start);
    res.setHeader("Cache-Control", "public, s-maxage=1800, stale-while-revalidate=86400");
    res.status(200).json({ source: "MoneyPuck.com", season: season.id, ...d });
  } catch(e){
    res.setHeader("Cache-Control", "public, s-maxage=300");
    res.status(502).json({ error: "Couldn't load MoneyPuck's shot data.", detail: String(e) });
  }
}
