// GET /api/search?q=name  ->  matching NHL players (active players first)
import { getJSON } from "../lib/pipeline.js";
export default async function handler(req, res){
  const q = String(req.query.q || "").trim();
  if(q.length < 2) return res.status(200).json({ players: [] });
  try {
    const j = await getJSON(`https://search.d3.nhle.com/api/v1/search/player?culture=en-us&limit=20&q=${encodeURIComponent(q)}`);
    const players = (Array.isArray(j) ? j : []).map(p => ({
      id: +p.playerId, name: p.name, team: p.teamAbbrev || p.lastTeamAbbrev || "", pos: p.positionCode || "",
      num: p.sweaterNumber ?? null, active: !!p.active
    })).sort((a,b) => (b.active - a.active)).slice(0, 12);
    res.setHeader("Cache-Control", "public, s-maxage=86400, stale-while-revalidate=604800");
    res.status(200).json({ players });
  } catch(e){ res.status(502).json({ error: "Player search isn't responding. Try again in a minute.", detail: String(e) }); }
}
